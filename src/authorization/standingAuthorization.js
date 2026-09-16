// src/authorization/standingAuthorization.js — 常驻授权策略 + 动作鉴权 + 执行收敛
// 设计：docs/2026-09-15-final-design-coexistence-and-proactive.md §11.1/§11.3/§11.4
// 铁律：T3 对外动作永久不可常驻授权；config 100% 后台化（policy 走 config_store）；执行仍 mint 决策（第0闸）。
import { query } from '../db.js';
import { readConfig } from '../config/configStore.js';
import { createDecision } from '../decision/decisionRepo.js';
import { resolveActiveGrant, grantCovers, recordExecution } from './grantStore.js';

// 策略默认值（与 migration-standing-grant.sql 系统模板一致；configStore 缺键时兜底）
export const DEFAULT_GRANTS_POLICY = {
  default_tier: 'T1',
  allow_tier_upgrade_by_ai: false,           // 写死：档位提升必须新批一次授权
  auto_pause_on_consecutive_rejects: 3,
  max_daily_executions: null,
  notify_on_execution: true,
};

export async function loadGrantsPolicy(tenantId = 'system') {
  const r = await readConfig('standing-grants-policy', { tenantId });
  return { ...DEFAULT_GRANTS_POLICY, ...(r?.value || {}) };
}

// T3 对外动作：发信 / 阶段推进至 S7/S8 —— 永久不可常驻授权（§11.3，必须前置审批）
export const T3_ACTIONS = [
  'crm-send-email', 'crm-send-im', 'crm-send-webhook',
  'crm-deal-advance-to-s7', 'crm-deal-advance-to-s8', 'crm-stage-advance',
];

export const STANDING_AUTH_SCENARIO = 'standing-auth-execution';

// 动作鉴权：B/C 轴放行判定。
// 返回 { authorized, grant?, reason? }；reason 用于留痕（no-active-grant / field-out-of-whitelist / T3-*）
export async function isActionAuthorized({ tenantId, action, fields = [], q = query }) {
  if (T3_ACTIONS.includes(action)) {
    return { authorized: false, reason: 'T3 actions are never standing-authorizable' };
  }
  const grant = await resolveActiveGrant({ tenantId, action, fields, q });
  if (!grant) {
    // 区分「无动作级凭证」与「字段越界」：存在动作级活跃凭证但字段不在白名单内 → field-out-of-whitelist
    const actionOnly = await q(
      `SELECT * FROM crm.standing_grant
       WHERE tenant_id=$1 AND status='active'
         AND (expires_at IS NULL OR expires_at > now())
         AND scope_actions @> $2::text[] LIMIT 1`,
      [tenantId, [action]]
    );
    if (actionOnly.rows[0] && !grantCovers(actionOnly.rows[0], { action, fields })) {
      return { authorized: false, reason: 'field-out-of-whitelist' };
    }
    return { authorized: false, reason: 'no-active-grant' };
  }
  return { authorized: true, grant };
}

// 在常驻授权凭证下执行一个动作（收敛点）：
//   ① 执行仍 mint 决策（actor='standing-auth' + grant_ref，过第0闸、可溯源）
//   ② 执行前/后快照落 grant_execution
//   createDecisionFn 可注入（测试用）；默认走真实 createDecision。
export async function executeUnderGrant({
  tenantId = 'system', grant, scenarioId = STANDING_AUTH_SCENARIO,
  actionName, targetId = null, fields = [], beforeState = {}, execFn,
  createDecisionFn = createDecision,
}) {
  if (typeof execFn !== 'function') throw new Error('executeUnderGrant 需要 execFn');
  const decision = await createDecisionFn({
    scenario_id: scenarioId,
    decider_type: 'STANDING_AUTH',
    grant_ref: grant.grant_id,
    autonomy_level: grant.risk_tier,
    business_tier: 'NORMAL',
    disposition: 'APPROVE',
    state: 'AUTONOMOUS',
    trigger_context: { action: actionName, fields },
    involved_entities: targetId ? [{ type: 'PARTICLE', id: targetId }] : [],
    rationale: `常驻授权自动执行（grant=${grant.grant_id}）`,
    tenantId,
  });
  const afterState = await execFn();
  const execution = await recordExecution({
    tenantId, grantId: grant.grant_id, actionName, targetId,
    beforeState, afterState, decisionId: decision.decision_id,
  });
  return { decision, execution };
}
