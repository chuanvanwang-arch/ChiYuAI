// src/authorization/grantStore.js — 常驻授权凭证存储（线 B｜B-N8）
// 设计：docs/2026-09-15-final-design-coexistence-and-proactive.md §8.5/§8.6/§11.4
// 铁律：撤回/暂停/到期全为状态字段变更，零 DELETE；所有查询带 tenant_id（租户隔离）。
import { query, queryWrite } from '../db.js';
import { randomUUID } from 'node:crypto';

// ---- 纯函数（零 DB，供单测 + resolveActiveGrant 复用）----

// 凭证是否覆盖某动作 + 字段集。
// 判定：status=active 且未过期 且 动作在 scope_actions 白名单 且 字段集 ⊆ field_whitelist
// 注意：field_whitelist 为超集语义——请求字段每元素都须被白名单包含；
//       field_whitelist 为 NULL 表示不限制字段（仅限 T1 内部字段场景，由 isActionAuthorized 兜底 T3）。
export function grantCovers(grant, { action, fields = [] }) {
  if (!grant) return false;
  if (grant.status !== 'active') return false;
  if (grant.expires_at && new Date(grant.expires_at).getTime() < Date.now()) return false;
  if (!Array.isArray(grant.scope_actions) || !grant.scope_actions.includes(action)) return false;
  const wl = grant.field_whitelist;
  if (Array.isArray(wl) && wl.length) {
    for (const f of fields) if (!wl.includes(f)) return false;
  }
  return true;
}

// ---- 凭证 CRUD ----

export async function createGrant({
  tenantId = 'system', title, scopeActions, scopeObjects = null,
  fieldWhitelist = null, riskTier = 'T1', maxUses = null, usedCount = 0,
  period = null, limitPayload = {}, approvedBy, decisionId = null, expiresAt = null,
}) {
  const grantId = `grant-${randomUUID()}`;
  await queryWrite(
    `INSERT INTO crm.standing_grant
       (grant_id, tenant_id, title, scope_actions, scope_objects, field_whitelist,
        risk_tier, max_uses, used_count, period, limit_payload, status, approved_by, approved_at, decision_id, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,'active',$12,now(),$13,$14)`,
    [grantId, tenantId, title, scopeActions, scopeObjects, fieldWhitelist, riskTier,
      maxUses, usedCount, period, limitPayload, approvedBy, decisionId, expiresAt]
  );
  return getGrant(tenantId, grantId);
}

export async function getGrant(tenantId, grantId) {
  const r = await query(
    `SELECT * FROM crm.standing_grant WHERE tenant_id=$1 AND grant_id=$2`,
    [tenantId, grantId]
  );
  return r.rows[0] || null;
}

export async function listGrants(tenantId) {
  const r = await query(
    `SELECT * FROM crm.standing_grant WHERE tenant_id=$1 ORDER BY created_at DESC`,
    [tenantId]
  );
  return r.rows;
}

// 撤回：状态变更（零 DELETE），留 revoked_at + revoked_reason（审计可溯源）
export async function revokeGrant(tenantId, grantId, reason = 'revoked') {
  await queryWrite(
    `UPDATE crm.standing_grant SET status='revoked', revoked_at=now(), revoked_reason=$3
     WHERE tenant_id=$1 AND grant_id=$2`,
    [tenantId, grantId, reason]
  );
  return getGrant(tenantId, grantId);
}

// ---- 解析（B/C 轴放行判定核心）----

// 返回覆盖该动作+字段的首个活跃未过期凭证；无则 null。
export async function resolveActiveGrant({ tenantId, action, fields = [], q = query }) {
  const r = await q(
    `SELECT * FROM crm.standing_grant
     WHERE tenant_id=$1 AND status='active'
       AND (expires_at IS NULL OR expires_at > now())
       AND scope_actions @> $2::text[]
       AND (field_whitelist IS NULL OR field_whitelist @> $3::text[])
     ORDER BY created_at LIMIT 1`,
    [tenantId, [action], fields]
  );
  return r.rows[0] || null;
}

// ---- 执行流水 ----

export async function recordExecution({
  tenantId = 'system', grantId, signalId = null, actionName, targetId = null,
  beforeState = {}, afterState = {}, decisionId = null, hitlVerdict = 'pending',
}) {
  const execId = `exec-${randomUUID()}`;
  await queryWrite(
    `INSERT INTO crm.grant_execution
       (execution_id, tenant_id, grant_id, signal_id, action_name, target_id,
        before_state, after_state, decision_id, actor, hitl_verdict)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,'standing-auth',$10)`,
    [execId, tenantId, grantId, signalId, actionName, targetId,
      beforeState, afterState, decisionId, hitlVerdict]
  );
  // 用量自增
  await queryWrite(
    `UPDATE crm.standing_grant SET used_count = used_count + 1
     WHERE tenant_id=$1 AND grant_id=$2`,
    [tenantId, grantId]
  );
  // 用量熔断：达 max_uses（非 null）且仍 active → paused（T20：落 paused_at/reason 供降级追溯）
  await queryWrite(
    `UPDATE crm.standing_grant SET status='paused', paused_at=now(), paused_reason='usage-limit'
     WHERE tenant_id=$1 AND grant_id=$2 AND status='active'
       AND max_uses IS NOT NULL AND used_count >= max_uses`,
    [tenantId, grantId]
  );
  return getExecution(tenantId, execId);
}

export async function getExecution(tenantId, executionId) {
  const r = await query(
    `SELECT * FROM crm.grant_execution WHERE tenant_id=$1 AND execution_id=$2`,
    [tenantId, executionId]
  );
  return r.rows[0] || null;
}

export async function listExecutions(tenantId, { verdict = null } = {}) {
  const params = [tenantId];
  let sql = `SELECT * FROM crm.grant_execution WHERE tenant_id=$1`;
  if (verdict) { params.push(verdict); sql += ` AND hitl_verdict=$${params.length}`; }
  sql += ` ORDER BY created_at DESC`;
  const r = await query(sql, params);
  return r.rows;
}

// 暂停：状态变更（零 DELETE）。返回最新凭证。
export async function pauseGrant(tenantId, grantId, reason = 'auto-pause') {
  await queryWrite(
    `UPDATE crm.standing_grant SET status='paused', paused_at=now(), paused_reason=$3
     WHERE tenant_id=$1 AND grant_id=$2 AND status='active'`,
    [tenantId, grantId, reason]
  );
  return getGrant(tenantId, grantId);
}

// 连续否决计数：某凭证最近 N 条执行是否全为 rejected（用于信任降级）
export async function recentVerdicts(tenantId, grantId, limit) {
  const r = await query(
    `SELECT hitl_verdict FROM crm.grant_execution
     WHERE tenant_id=$1 AND grant_id=$2 ORDER BY created_at DESC LIMIT $3`,
    [tenantId, grantId, limit]
  );
  return r.rows.map((x) => x.hitl_verdict);
}
