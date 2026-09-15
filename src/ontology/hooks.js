// src/ontology/hooks.js — 写库即构建：三钩子（embedding / tsvector / 本体同步）
// 写时（write-time）物化：粒子落库后回填 embedding/fts/content_hash，自动建受控边 + 词汇登记。
import { query, queryWrite } from '../db.js';
import { hashVector, contentHash, embedText, EMBED_PROVIDER } from './embedding.js';
import { registerVocabulary } from './vocabulary.js';
import { emit } from '../events/bus.js';
import { recordEvent } from '../events/recordEvent.js';
import { ensureAgeSync } from './ageSync.js';

// 钩子1：embedding（哈希判变幂等）——D1（2026-09-14）接真模型路径
export async function ensureEmbedding({ id, payload }) {
  const text = JSON.stringify(payload || {});
  const hash = contentHash(payload || {});
  const r = await query(`SELECT content_hash FROM particles WHERE id=$1::uuid`, [id]);
  const curHash = r.rows[0]?.content_hash || null;
  if (curHash === hash) return; // 幂等：内容没变不重算
  // 仅当 EMBEDDING_PROVIDER=model 时算真向量（1024 维，与列对齐）；
  // 否则写 NULL（hash 384 维无法存入 vector(1024) 列，fail-open 不阻断写）。
  if (process.env.EMBEDDING_PROVIDER !== 'model') {
    await queryWrite(
      `UPDATE particles SET embedding=NULL, content_hash=$1, updated_at=now() WHERE id=$2`,
      [hash, id]
    );
    return;
  }
  try {
    const ev = await embedText(text, {
      metering: { tenantId: 'system', actor: 'ontology', action: 'particle-embed' },
    });
    if (ev.provider === EMBED_PROVIDER.MODEL && Array.isArray(ev.vector) && ev.vector.length === 1024) {
      const vec = JSON.stringify(ev.vector.map(Number));
      await queryWrite(
        `UPDATE particles SET embedding=$1, content_hash=$2, updated_at=now() WHERE id=$3`,
        [vec, hash, id]
      );
      return;
    }
    await queryWrite(
      `UPDATE particles SET embedding=NULL, content_hash=$1, updated_at=now() WHERE id=$2`,
      [hash, id]
    );
  } catch (e) {
    // 维度错 / 模型不可用 → fail-open 写 NULL（粒子不丢，仅向量缺失，留痕待回填）
    await queryWrite(
      `UPDATE particles SET embedding=NULL, content_hash=$1, updated_at=now() WHERE id=$2`,
      [hash, id]
    ).catch(() => {});
    const { recordFailure } = await import('../monitor/monitorStore.js');
    recordFailure('particle-embedding-failed', e);
  }
}

// 钩子2：tsvector 双写（FTS 索引与向量同时维护）
export async function ensureTsVector({ id, payload }) {
  const text =
    (payload?.name || payload?.title || payload?.term || '') +
    ' ' +
    JSON.stringify(payload || {}).slice(0, 800);
  await queryWrite(
    `UPDATE particles SET fts = to_tsvector('simple', $1), updated_at=now() WHERE id=$2`,
    [text, id]
  );
}

// 钩子3：本体同步（受控边自动建 + 词汇登记 + 身份解析 + 审计事件）
// F18 工商写时校验闸：ACCOUNT 携带 business_title → 先过 validateBusinessTitle。
// 语义：字符串抬头（人工/种子 text 类型，无信用代码可污染）→ 放行；连接器结构化对象 → 校验四要素+信用代码，非法拒绝。
export async function ontologySync(entity) {
  const payload = entity.payload || {};
  // F18：工商抬头写时校验（ACCOUNT 粒子写 business_title 时强制校验；连接器/人工/AI 任一来源都过闸）
  if (entity.type === 'CRM_ACCOUNT' && payload.business_title != null) {
    const { validateBusinessTitle } = await import('../sales/businessTitle.js');
    const v = validateBusinessTitle(payload.business_title);
    if (!v.ok) throw new Error(`工商抬头校验拒绝: ${v.errors.join('; ')}`);
  }
  // ① 引用型字段自动建受控边（record-reference / actor-reference）
  const refs = [
    ['owner_id', 'owned_by', 'CRM_PERSON'],
    ['org_id', 'part_of', 'CRM_ORGANIZATION'],
    ['account_id', 'belongs_to', 'CRM_ACCOUNT'],
    ['key_contact', 'key_contact', 'CRM_CONTACT'], // ATTIO D 桶：关键联系人自动受控边
    ['deal_id', 'belongs_to', 'CRM_DEAL'], // T3-6：报价/合同/回款/发票/订单挂交易实体
    ['quotation_id', 'has_quotation', 'CRM_QUOTATION'], // T3-6：合同挂报价（四级定价链路）
    ['contract_id', 'has_contract', 'CRM_CONTRACT'], // T3-6：二级资源（回款/发票）挂合同
  ];
  for (const [field, edgeType, targetType] of refs) {
    const targetId = payload[field];
    if (!targetId) continue;
    const { createEdge } = await import('../particles/particleRepo.js');
    await createEdge(entity.type, entity.id, edgeType, targetType, targetId, {
      edge_source: 'auto',
    }).catch(() => {});
  }
  // ② 身份解析（ATTIO Identity 承接，12 设计 §7.1）：CONTACT.email 域名 命中 ACCOUNT.domains → auto_weak 边
  // 防子串误判（遗留修复）：payload->>'domains' 文本 ILIKE 会把 acme.com 误配 notacme.com；改用 JSONB 元素级匹配——
  // 数组元素（jsonb_array_elements_text）或字符串：元素等值（防跨账户误归一）或「email 域名以元素为子域后缀」（员工邮箱 mail.x.com → x.com）。
  // 多域名（domains:['x.com','x.cn']）任一满足即建边。
  if (entity.type === 'CRM_CONTACT' && payload.email && typeof payload.email === 'string') {
    const domain = payload.email.split('@')[1]?.toLowerCase();
    if (domain) {
      const hit = await query(
        `SELECT id FROM crm.particles
           WHERE type='CRM_ACCOUNT'
             AND ( (jsonb_typeof(payload->'domains')='array' AND EXISTS (
                     SELECT 1 FROM jsonb_array_elements_text(payload->'domains') d
                     WHERE lower(d)=lower($1) OR lower($1) LIKE '%.' || lower(d)
                   ))
                   OR (jsonb_typeof(payload->'domains')='string' AND
                       (lower(payload->>'domains')=lower($1) OR lower($1) LIKE '%.' || lower(payload->>'domains')))
                 )
           LIMIT 1`,
        [domain]
      ).catch(() => ({ rows: [] }));
      const acct = hit.rows[0];
      if (acct) {
        const { createEdge } = await import('../particles/particleRepo.js');
        await createEdge('CRM_CONTACT', entity.id, 'auto_weak', 'CRM_ACCOUNT', acct.id, {
          relation_confidence: 0.6, confirmed: false, edge_source: 'identity-resolve',
        }).catch(() => {});
      }
    }
  }
  // ③ 关系强度边（ATTIO Structure 承接，12 设计 §7.3）：CONTACT.relationship_strength / ACCOUNT.champion_strength → 决策单元子图
  const strength = payload.relationship_strength || payload.champion_strength;
  if (strength && (entity.type === 'CRM_CONTACT' || entity.type === 'CRM_ACCOUNT')) {
    const targetType = entity.type === 'CRM_CONTACT' ? 'CRM_ACCOUNT' : 'CRM_DEAL';
    const targetId = entity.type === 'CRM_CONTACT' ? payload.account_id : payload.deal_id;
    if (targetId) {
      const { createEdge } = await import('../particles/particleRepo.js');
      await createEdge(entity.type, entity.id, 'relationship_strength', targetType, targetId, {
        strength, edge_source: 'attio-relation',
      }).catch(() => {});
    }
  }
  // ④ ATTIO 属性变更事件（12 §7.2 记忆承接）：firmographic/ui 组字段变更 → emit memory 域（capture 整包承接）
  const { SEMANTIC_TAGS } = await import('../particles/particleModel.js');
  const firmographicChanged = SEMANTIC_TAGS.firmographic.filter((f) => payload[f] !== undefined);
  if (firmographicChanged.length) {
    emit('memory', 'attribute-change-firmographic', {
      entity_type: entity.type, entity_id: entity.id, changed: firmographicChanged,
    });
  }
  // ⑤ 词汇登记（枚举型/业务专有名词 → CRM_KNOWLEDGE）
  await registerVocabulary(entity, entity.tenant_id || 'system');
  // ④ 审计事件（兼容 Task2 行为）—— A1 收敛到统一落库通道
  //    原裸 INSERT 有兩处缺陷：①走读池 query 写库（应走 queryWrite）②.catch(()=>{}) 静默吞错，
  //    生产上 ontology-sync 事件是否落库成功无人知晓（crm.events 长期 0 行即后果之一）。
  //    entity.id 作为客户锚点写入 payload.entity_id，使故事线能按实体聚合。
  await recordEvent({
    domain: 'ontology',
    type: 'ontology-sync',
    entityId: entity.id,
    entityType: entity.type,
    tenantId: entity.tenant_id || null,
    actor: entity.updated_by || 'system',
  });
}

// 人工确认弱边→强边（12 设计 §7.1 验收③）：仅 auto_weak 可确认，确认后 meta.confirmed=true
export async function confirmWeakEdge(edgeId) {
  const r = await query(`SELECT * FROM crm.edges WHERE id=$1 AND edge_type='auto_weak'`, [edgeId]);
  if (!r.rows[0]) throw new Error(`非 auto_weak 边或不存在: ${edgeId}`);
  await query(`UPDATE crm.edges SET meta = meta || '{"confirmed":true}'::jsonb WHERE id=$1`, [edgeId]);
  return { ok: true, edgeId };
}

// 四钩子串联入口：写库即构建（embedding / FTS / 本体同步 / AGE 镜像）
export async function ensureAll(entity) {
  await ensureEmbedding(entity);
  await ensureTsVector(entity);
  await ontologySync(entity);
  await ensureAgeSync(entity).catch(() => {}); // 【P1】写时镜像 AGE 决策网络图
  return entity;
}
