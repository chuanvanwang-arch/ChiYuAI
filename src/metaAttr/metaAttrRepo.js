// src/metaAttr/metaAttrRepo.js — 元模型 DB 读写 + seed 物化 + 自适应登记（写时钩子消费）
// 设计输入：docs/2026-08-26-particle-attribute-model-ui-design.md §4/§5（coreAttributes 物化 + 写时自适应）
// 2026-09-03 多行业配置化：所有读写按 tenant_id 过滤（meta_attr.tenant_id，设计 §15 P1）
import { query, queryWrite } from '../db.js';
import { PARTICLE_TYPES } from '../particles/particleModel.js';
import { recordFor, adaptiveRecordFor, identityRecordFor } from './metaAttrModel.js';
import { emit } from '../events/bus.js';

// 幂等登记单条种子属性（coreAttributes 与 identity 兜底共用）
// 三态：① 无行 → 插入种子记录；② 已存在且被自适应登记抢占（source='ai'）→ 纠正回人工源并启用类型约束；
//       ③ 已存在且人工源（source='manual'）→ 原样保留（尊重后台配置变更，不覆盖人为禁用/改型）
// 约束纪律：纠正只补 source/enabled/attr_type，required 保持原值——修缺陷不放大约束，
//           避免 identity 字段被置 required=true 后对既有写入抛 ValidationError。
// 种子属 system 基线（tenant_id='system'），供所有租户继承。
async function upsertSeedAttr(particleType, attrSlug, rec) {
  const cur = await getMetaAttr(particleType, attrSlug, 'system');
  if (cur) {
    if (cur.source === 'manual') return false;    // ③ 人工配置优先，种子不覆盖
    await setMetaAttr(particleType, attrSlug,    // ② 纠正抢占行
      { source: 'manual', enabled: rec.enabled, attr_type: rec.attr_type },
      { actor: 'seed', versionBump: false, tenantId: 'system' });
    return true;
  }
  await queryWrite(                              // ① 首次登记
    `INSERT INTO crm.meta_attr
       (particle_type, attr_slug, title, attr_type, semantic_tag, required, "unique", description, options,
        source, display, validation, permission, enabled, version, created_by, tenant_id)
     SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17
     WHERE NOT EXISTS (SELECT 1 FROM crm.meta_attr WHERE particle_type=$1 AND attr_slug=$2 AND tenant_id=$17)`,
    [rec.particle_type, rec.attr_slug, rec.title, rec.attr_type, rec.semantic_tag,
     rec.required, rec.unique, rec.description, rec.options,
     rec.source, JSON.stringify(rec.display), JSON.stringify(rec.validation),
     JSON.stringify(rec.permission), rec.enabled, rec.version, rec.created_by, 'system']
  );
  return true;
}

// 幂等物化：PARTICLE_TYPES → coreAttributes 全部行（coreAttributes 仍为唯一事实源）
export async function seedMetaAttr(actor = 'system') {
  for (const [ptype, def] of Object.entries(PARTICLE_TYPES)) {
    const coreKeys = new Set(Object.keys(def.coreAttributes || {}));
    // 既有：coreAttributes 物化
    for (const slug of coreKeys) {
      await upsertSeedAttr(ptype, slug, recordFor(ptype, slug, def));
    }
    // 身份兜底：所有定义 identity 的粒子注册主键属性（与 coreAttributes 去重，幂等）
    for (const slug of (def.identity || [])) {
      if (coreKeys.has(slug)) continue;
      await upsertSeedAttr(ptype, slug, identityRecordFor(ptype, slug));
    }
  }
  return true;
}

export async function listMetaAttr({ particleType, enabled, semanticTag, tenantId = 'system', applyPermission = false } = {}) {
  // universal core：非 system 租户查询时，合并「自身属性 ∪ system 平台基线」（基线继承 + 逐租户覆盖）
  const ids = tenantId && tenantId !== 'system' ? [tenantId, 'system'] : ['system'];
  const r = await query(
    `SELECT * FROM crm.meta_attr
     WHERE ($1::text IS NULL OR particle_type=$1)
       AND ($2::boolean IS NULL OR enabled=$2)
       AND ($3::text IS NULL OR semantic_tag=$3)
       AND tenant_id = ANY($4::text[])
     ORDER BY tenant_id, particle_type, semantic_tag, attr_slug`,
    [particleType || null, enabled === undefined ? null : enabled, semanticTag || null, ids]
  );
  let rows = r.rows;
  // 同 (particle_type, attr_slug) 去重：租户自有版本优先于 system 基线
  if (ids.length > 1) {
    const byKey = new Map();
    for (const row of rows) {
      const key = `${row.particle_type}.${row.attr_slug}`;
      const existing = byKey.get(key);
      if (!existing || (existing.tenant_id === 'system' && row.tenant_id !== 'system')) {
        byKey.set(key, row);
      }
    }
    rows = [...byKey.values()];
  }
  // P5(T15) 逐字段可见性：按 permission.deny_tenants 隐藏对当前租户不可见的属性
  if (applyPermission && tenantId) {
    rows = rows.filter((row) => {
      const deny = row.permission?.deny_tenants || [];
      return !deny.includes(tenantId);
    });
  }
  return rows;
}

export async function getMetaAttr(particleType, attrSlug, tenantId = 'system') {
  const r = await query(`SELECT * FROM crm.meta_attr WHERE particle_type=$1 AND attr_slug=$2 AND tenant_id=$3`, [particleType, attrSlug, tenantId]);
  return r.rows[0] || null;
}

// 配置变更（attr-update Action 消费；version 递增 + 决策锚定由 Action 层/第 0 闸负责）
export async function setMetaAttr(particleType, attrSlug, patch, { actor = 'system', versionBump = true, tenantId = 'system' } = {}) {
  const cur = await getMetaAttr(particleType, attrSlug, tenantId);
  if (!cur) throw new Error(`元模型属性不存在: ${tenantId}.${particleType}.${attrSlug}`);
  const next = { ...cur, ...patch, updated_at: new Date().toISOString() };
  if (versionBump && patch) next.version = (cur.version || 1) + 1;
  await queryWrite(
    `UPDATE crm.meta_attr SET
       title=$3, attr_type=$4, semantic_tag=$5, required=$6, "unique"=$7, description=$8, options=$9,
       source=$10, display=$11, validation=$12, permission=$13, enabled=$14, version=$15, updated_at=now()
     WHERE particle_type=$1 AND attr_slug=$2 AND tenant_id=$16`,
    [particleType, attrSlug, next.title, next.attr_type, next.semantic_tag, next.required, next.unique,
     next.description, next.options, next.source,
     JSON.stringify(next.display || {}), JSON.stringify(next.validation || {}),
     JSON.stringify(next.permission || {}), next.enabled, next.version, tenantId]
  );
  emit('trace', 'meta-attr-updated', { tenant_id: tenantId, particle_type: particleType, attr_slug: attrSlug, version: next.version, actor });
  return getMetaAttr(particleType, attrSlug, tenantId);
}

// 自适应登记（particleRepo 写钩子消费）：新键 → 推断 → 登记（enabled=false / source=ai）
// 保留键（ai/events/阶段原因等系统域）永不进元模型；未命中 19 类型 → 拒绝登记（不抛错，保持写成功）
// 2026-09-03：带 tenantId——登记即按租户落库，tenantA 与 tenantB 对同类型写新键互不污染（设计 §15.2）
export async function ensureAdaptiveRegistration(particleType, payload, tenantId = 'system', actor = 'system') {
  const registered = [];
  for (const slug of Object.keys(payload || {})) {
    if (slug === 'ai' || slug === 'events' || slug === 'stage_change_reason' || slug === 'closed_reason') continue;
    if (slug.startsWith('ai.')) continue;   // AI 属性轴（payload.ai.*）永不进元模型
    const exists = await getMetaAttr(particleType, slug, tenantId);
    if (exists) continue;
    const rec = adaptiveRecordFor(particleType, slug, payload[slug], actor);
    if (!rec) continue;
    // 并发安全（2026-09-09 孤儿粒子根治）：
    //   旧写法是 check-then-act —— 先 SELECT 判存在、再 INSERT ... WHERE NOT EXISTS，两条语句分属不同连接、
    //   无事务包裹。并发下同一 (type, slug, tenant) 的两个请求可双双通过检查 → 双双 INSERT →
    //   撞 meta_attr_pkey（PK = particle_type, attr_slug, tenant_id）抛错；
    //   而粒子已在 particleRepo.js 的 INSERT 处落库 → **抛错也留下一颗孤儿粒子**（本次产物 6b3f6f8f…）。
    //   现改为 DB 层幂等：主键直接 ON CONFLICT DO NOTHING，竞态在数据库层消解，冲突不再抛错上抛。
    //   （不采用 withTx 全包：createParticle 后续还有 embedding/审计/AGE 图/AI 属性等**故意 fail-open**
    //    的非事务副作用，整体包进事务会把它们变成阻塞点。）
    await queryWrite(
      `INSERT INTO crm.meta_attr
         (particle_type, attr_slug, title, attr_type, semantic_tag, source, enabled, version, created_by, tenant_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (particle_type, attr_slug, tenant_id) DO NOTHING`,
      [rec.particle_type, rec.attr_slug, rec.title, rec.attr_type, rec.semantic_tag,
       rec.source, rec.enabled, rec.version, rec.created_by, tenantId]
    );
    emit('particle', 'meta-attr-auto-registered', { particle_type: particleType, attr_slug: slug, attr_type: rec.attr_type, tenant_id: tenantId });
    registered.push(slug);
  }
  return registered;
}
