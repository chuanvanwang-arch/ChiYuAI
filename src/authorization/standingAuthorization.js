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
  // Q3-4（全链集成 §3.4）：自治放行的**运行时顺序闸门**开关。
  //   ⚠ 缺省 false（计划期裁决 D3）：置 true 会让"出口未健康"直接冻结全部自治，
  //   若默认开启，Q3 上线当日因出口判据①未成立 → 自主执行归零（违反本任务 success 的向后兼容要求）。
  //   启用方式：运营在配置中心把 require_export_healthy 置 true（继承「播种 ≠ 接通」纪律）。
  require_export_healthy: false,
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

// 在既有 A 轴放行结果上叠加 B/C 轴（常驻授权）。opt-in：仅当 standingAction 提供时介入（既有调用方不传 → 行为不变）。
// fail-closed：未提供动作 / 鉴权抛错 / 无凭证 / 字段越界 / T3 → 一律升级 HITL。
// Q3-4（2026-09-16）：若策略 `require_export_healthy===true`，**先过运行时顺序闸门**（出口判据①）——
//   闸门关或闸门自身抛错 → 直接升级（自主执行量为 0），**不再进入动作鉴权**（先闸门、后鉴权）。
//   deps 新增两项均为**可选**：`exportGate`（替身注入）、`policyOverride`（测试用策略覆盖，零 DB）。
export async function consultStandingGate(
  escalated,
  { tenantId, standingAction, standingFields = [], exportGate = null, policyOverride = null, q = query } = {}
) {
  if (escalated || !standingAction) return escalated; // A 轴已升级 或 未声明动作 → 保持不变
  try {
    const policy = policyOverride || (await loadGrantsPolicy(tenantId));
    if (policy.require_export_healthy === true) {
      const gate = exportGate || (await import('../sync/exportGate.js')).createExportGate();
      const g = await gate.guard({ tenantId, action: `standing:${standingAction}` });
      if (!g.allowed) return true; // 出口不健康 → 升级 HITL（闸门自身的抛错在此也会被 catch 兜住 → true）
    }
    const az = await isActionAuthorized({ tenantId, action: standingAction, fields: standingFields, q });
    return !az.authorized; // 无凭证/越界/T3 → 升级
  } catch {
    return true; // fail-closed：鉴权不可用则升级
  }
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
