// src/context/scope.js — 数据范围谓词（纯判定 + DB 解析 + executor 第1闸）
// 纯判定部分（T3）：scopeModel / inScopeByModel —— 不触 DB，可单测
import { query } from '../db.js';
import { loadProfile } from './roleProfiles.js';

export function scopeModel(profile) {
  return profile?.data_scope?.model || 'all';
}

export function inScopeByModel(model, { actor, ownerId, ownerOrg, subtree, allowedDomains, type } = {}) {
  if (model === 'all') return true;
  if (model === 'self') return ownerId === actor;
  if (model === 'org_subtree') return Array.isArray(subtree) && subtree.includes(ownerOrg);
  if (model === 'domain') return Array.isArray(allowedDomains) && allowedDomains.includes(type);
  return false;
}

// ===== DB 解析（T4）=====

// 解析 actor 的 role_tag + org_id（来自 CRM_PERSON 粒子 payload）
export async function actorRole(ctx) {
  const r = await query(
    `SELECT payload->'role_tags'->>0 AS role_tag, payload->>'org_id' AS org_id
     FROM crm.particles WHERE type='CRM_PERSON' AND (slug=$1 OR id::text=$1) LIMIT 1`,
    [ctx?.actor]
  );
  return r.rows[0] || null;
}

export async function actorOrg(personSlug) {
  const r = await query(
    `SELECT payload->>'org_id' AS org_id FROM crm.particles WHERE type='CRM_PERSON' AND (slug=$1 OR id::text=$1) LIMIT 1`,
    [personSlug]
  );
  return r.rows[0]?.org_id || null;
}

export const personOrg = actorOrg;

// 组织子树（WITH RECURSIVE 遍历 CRM_ORGANIZATION.payload->>'parent_id'）
export async function orgSubtree(orgId) {
  const r = await query(
    `WITH RECURSIVE sub AS (
       SELECT slug, payload->>'parent_id' AS parent FROM crm.particles WHERE type='CRM_ORGANIZATION' AND slug=$1
       UNION ALL
       SELECT o.slug, o.payload->>'parent_id' FROM crm.particles o INNER JOIN sub ON o.payload->>'parent_id' = sub.slug
     ) SELECT slug FROM sub`,
    [orgId]
  );
  return r.rows.map((x) => x.slug);
}

// 受上下文分层约束的 Action（写/读粒子相关）
export function isParticleScoped(def) {
  return !!def && [
    'data-particle-create', 'data-particle-read', 'data-particle-update',
    'data-particle-edge-create', 'crm-deal-advance', 'crm-account-360',
    'crm-proposal-write',
  ].includes(def.name);
}

// 解析目标粒子 owner（DEAL/ACCOUNT/CONTACT 等 scoped 类型的 owner 在 payload.owner_id）
export async function resolveTargetOwner(params) {
  const id = params?.id || params?.account_id || params?.deal_id
    || params?.source_id || params?.target_id;
  if (!id) return null;
  const r = await query(
    `SELECT type, tenant_id, payload->>'owner_id' AS owner_id, payload->>'org_id' AS org_id
     FROM crm.particles WHERE (id::text=$1 OR slug=$1) LIMIT 1`,
    [id]
  );
  if (!r.rows.length) return null;
  const row = r.rows[0];
  const ownerOrg = row.owner_id ? await personOrg(row.owner_id) : (row.org_id || null);
  return { ownerId: row.owner_id, ownerOrg, type: row.type, tenant_id: row.tenant_id };
}

const SCOPED_TYPES = ['CRM_DEAL', 'CRM_ACCOUNT', 'CRM_CONTACT'];

// 业务粒子类型（治理写范围 exclude 清单；单一事实源，与 SCOPED_TYPES 同文件）
// 设计：docs/2026-09-06-rbac-f4-design.md §C1（方案 C）——sysadmin 写范围收敛为治理类
export const BUSINESS_PARTICLE_TYPES = [
  'CRM_DEAL', 'CRM_ACCOUNT', 'CRM_CONTACT',
  'CRM_TECHNICAL_PROPOSAL', 'CRM_INVOICE', 'CRM_PAYMENT_RECORD',
  'CRM_CONTRACT', 'CRM_QUOTATION', 'CRM_ORDER',
];

// executor 第 1 闸（permission boundary）：返回 { ok, gate?, reason? }
// 豁免：调用方已判 bootstrap 跳过；demo/未命中角色回退无限制（调用方负责）
export async function enforceScope(def, ctx, params, profile) {
  const ws = profile?.data_scope?.write_scope;        // 写专属范围（F4：sysadmin 治理写收敛）
  const model = ws ? ws.model : scopeModel(profile);  // 写路径用 write_scope.model 覆盖；读仍用 data_scope.model
  if (model === 'all') return { ok: true };
  if (model === 'governance') {
    // sysadmin 写范围：治理类放行（CRM_PERSON/租户/配置等），业务粒子拒（F4 方案 C）
    const target = await resolveTargetOwner(params);
    if (!target) return { ok: true };                // 列表类查询交 scopePredicate
    const excludeTypes = ws?.exclude_types && Array.isArray(ws.exclude_types)
      ? ws.exclude_types : BUSINESS_PARTICLE_TYPES;
    if (excludeTypes.includes(target.type)) {
      return { ok: false, gate: 'scope_violation',
        reason: `sysadmin 写范围限治理类，业务粒子 ${target.type} 不可写（需 ADMIN 升级或 HITL 决策）` };
    }
    return { ok: true };                              // 治理类粒子跨租户写放行
  }
  if (model === 'tenant') {
    // ten_admin 仅可操作本租户粒子；跨租户写 = 越权拒绝（F1 主闸，覆盖 API + MCP/AI 写通道）
    const target = await resolveTargetOwner(params);
    if (!target) return { ok: true }; // 列表类查询交 scopePredicate（读路径已由 queryParticles tenantId 过滤）
    if (target.tenant_id && target.tenant_id !== ctx.tenantId) {
      return { ok: false, gate: 'scope_violation',
        reason: `tenant ${target.tenant_id} != ${ctx.tenantId}（ten_admin 跨租户写被拒）` };
    }
    return { ok: true };
  }
  if (def?.name === 'data-particle-create') {
    // 写创建：自动归属 owner=actor（scoped 类型），不触发越界
    if (SCOPED_TYPES.includes(params?.type) && params?.payload && !params.payload.owner_id) {
      params.payload = { ...params.payload, owner_id: ctx.actor };
    }
    return { ok: true };
  }
  const target = await resolveTargetOwner(params);
  if (!target) return { ok: true }; // 列表类查询交给 scopePredicate
  if (model === 'self') {
    return inScopeByModel('self', { actor: ctx.actor, ownerId: target.ownerId })
      ? { ok: true }
      : { ok: false, gate: 'scope_violation', reason: `owner ${target.ownerId} != ${ctx.actor}` };
  }
  if (model === 'org_subtree') {
    const subtree = await orgSubtree(await actorOrg(ctx.actor));
    return inScopeByModel('org_subtree', { subtree, ownerOrg: target.ownerOrg })
      ? { ok: true }
      : { ok: false, gate: 'scope_violation', reason: `org ${target.ownerOrg} 不在子树` };
  }
  if (model === 'domain') {
    return inScopeByModel('domain', { allowedDomains: profile.data_scope.domain, type: target.type })
      ? { ok: true }
      : { ok: false, gate: 'scope_violation', reason: `type ${target.type} 不在 domain` };
  }
  return { ok: true };
}

// 列表查询谓词（data-particle-read 无 id 时，由调用方预填 orgSubtree 结果）
// 扩展 opts（P1④ 对象级 ACL）：{ visibleRoles?, confidential?, role? }  —— 2026-09-05 落地
//   visibleRoles：meta.visible_roles 空/缺省 = 开放；非空 → 必须命中 ?| 任一角色
//   confidential：meta.confidential=true 时仅 exec/sysadmin 可见（隐式收紧，model=all 同样生效）
export function scopePredicate(profile, actor, orgSubtreeIds = [], opts = {}) {
  const m = scopeModel(profile);
  const parts = [];
  const params = [];
  if (m === 'self') {
    parts.push(`p.payload->>'owner_id' = $${params.length + 1}`);
    params.push(actor);
  }
  if (m === 'domain') {
    parts.push(`p.type = ANY($${params.length + 1})`);
    params.push(profile.data_scope.domain);
  }
  if (m === 'org_subtree') {
    // org_subtree 列表：经人员归属组织间接定位
    parts.push(`p.payload->>'owner_id' IN (SELECT slug FROM crm.particles WHERE type='CRM_PERSON' AND payload->>'org_id' = ANY($${params.length + 1}))`);
    params.push(orgSubtreeIds);
  }
  // P1④ 对象级 ACL
  const vr = opts.visibleRoles;
  if (Array.isArray(vr) && vr.length) {
    parts.push(`(p.meta->'visible_roles' IS NULL OR p.meta->'visible_roles' = '[]'::jsonb OR p.meta->'visible_roles' ?| ARRAY[$${params.length + 1}])`);
    params.push(vr);
  }
  if (opts.confidential) {
    parts.push(`(p.meta->>'confidential' IS NULL OR p.meta->>'confidential' = 'false' OR (p.meta->>'confidential' = 'true' AND $${params.length + 1} = ANY(ARRAY['exec','sysadmin'])))`);
    params.push(opts.role || actor);
  }
  return parts.length
    ? { clause: ` AND ${parts.join(' AND ')}`, params }
    : { clause: '', params: [] };
}

// 上下文注入复用入口（P0①）：profile 缺省/未定义 data_scope → 零过滤（现状保持）
// org_subtree 需预取子树；与列表谓词**同一事实源**（scopePredicate）
export async function scopePredicateFor(profile, actor) {
  if (!profile || !profile.data_scope || profile.data_scope.model === 'all') return { clause: '', params: [] };
  let orgSubtreeIds = [];
  if (profile.data_scope.model === 'org_subtree') {
    const orgId = actor ? await actorOrg(actor) : null;
    orgSubtreeIds = orgId ? await orgSubtree(orgId) : [];
  }
  return scopePredicate(profile, actor, orgSubtreeIds);
}
