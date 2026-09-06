// src/billing/metering.js — LLM/Embedding 出口的统一计量与预检（P0-1，2026-09-06）
// 背景：原实现把「预检 + 计量」都挂在 `if (metering && metering.tenantId)` 上（llm/client.js:143、
//       embeddingClient.js:31），而全 src 只有 agentLoop.js:72 一处传了带 tenantId 的 metering，
//       导致绝大多数 LLM 调用既不限流也不计费（生产 token_accounting 实测 0 行）。
// 铁律：
//   - 每次 LLM/Embedding 调用都必须计量、都必须过预检（不再因缺 metering 静默跳过）
//   - 缺 tenantId → 记 system + emit trace 告警，**不阻断**（用户 2026-09-06 拍板方案 B）
//   - 配额错误（TokenQuotaError.isQuota）必须向上传播；其余异常 fail-open 不阻断主流程
import { emit } from '../events/bus.js';
import { recordTokens } from '../alerts/tokenAccounting.js';
import { enforceTokenQuota } from './quotaGate.js';

export function currentPeriod(d = new Date()) { return d.toISOString().slice(0, 7); }

/** 解析计量租户：缺失 → 记 system 并告警（不阻断），返回 'system'。 */
export function meteringTenantId(metering, source) {
  const tid = metering && metering.tenantId;
  if (tid) return tid;
  try {
    emit('trace', 'llm-metering-missing-tenant', {
      source,
      action: metering?.action || null,
      actor: metering?.actor || null,
      note: '未传 tenantId，本次用量记入 system 且不受租户配额约束',
    });
  } catch { /* 告警失败不阻断 */ }
  return 'system';
}

/**
 * LLM 出口统一预检：无论是否传 metering 都执行。
 * @returns {Promise<{tenantId:string, ok:boolean, error?:string}>}
 * @throws TokenQuotaError 超配额（需调用方感知，属预期拦截）
 */
export async function enforceQuotaFor(metering, source) {
  const tenantId = meteringTenantId(metering, source);
  try {
    const r = await enforceTokenQuota(tenantId, currentPeriod());
    return { tenantId, ok: r.ok !== false, mode: r.mode };
  } catch (e) {
    if (e && e.isQuota) throw e;          // 配额拦截：向上传播
    return { tenantId, ok: false, error: e.message }; // 其余异常 fail-open
  }
}

/**
 * LLM 出口统一计量：无论是否传 metering 都执行；usage 缺失记 0（不伪造）。
 * @param {object} o
 * @param {object} [o.metering]  调用方传入的 { tenantId, actor, action, decision_id, module }
 * @param {string} o.source      'llm' | 'embedding' | 'evaluator' …
 * @param {string} [o.action]    metering.action 缺失时的兜底动作名
 * @param {object} [o.usage]     OpenAI 形态 usage { prompt_tokens, completion_tokens }
 * @param {string} [o.tenantId]  已解析的租户（由 enforceQuotaFor 返回），缺省则重新解析
 * @param {(u:{tokensIn:number,tokensOut:number})=>void} [o.onUsage] 回传真实用量（P0-2 供 Action 回填）
 */
export async function recordUsage({ metering = null, source = 'llm', action = null, usage = null, tenantId = null, decisionId = null, onUsage = null } = {}) {
  const tid = tenantId || meteringTenantId(metering, source);
  const tokensIn = Number(usage?.prompt_tokens ?? usage?.tokens_in) || 0;
  const tokensOut = Number(usage?.completion_tokens ?? usage?.tokens_out) || 0;
  if (typeof onUsage === 'function') {
    try { onUsage({ tokensIn, tokensOut }); } catch { /* 回传失败不影响主计量 */ }
  }
  await recordTokens({
    actor: metering?.actor || 'system',
    action: metering?.action || action || source,
    tokensIn,
    tokensOut,
    source,
    decision_id: decisionId ?? metering?.decision_id ?? null,
    tenantId: tid,
    module: metering?.module || 'core',
  });
  return { tenantId: tid, tokensIn, tokensOut };
}
