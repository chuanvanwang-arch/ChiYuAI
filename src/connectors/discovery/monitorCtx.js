// src/connectors/discovery/monitorCtx.js — monitorAccount 的 ctx 四件套装配
//
// 立论：`monitorAccount(ctx, accountId, signals)` 的 DI 契约要求
//   ctx = { getAccount, rescore, appendMemory, updateParticle }（monitorAccount.js:6,10-32），
//   但截至 2026-09-16 生产**零处装配**：timers.js:181 只传 `{tenantId}` → 首行 ctx.getAccount 必抛
//   TypeError（设计 §E.2.1）。本文件是该缺口的装配实现。
//
// 范式参照：src/sync/mount.js:108 `runTenantSyncOnce` —— 同域、同第 0 闸、同「失败留痕不静默」纪律。
//
// 铁律：
//   ① **写必过第 0 闸**：updateParticle 无 decisionId → 直接 reject（fail-closed，绝不"先写后补"）
//   ② 租户隔离：每次读写透传 tenantId
//   ③ 禁 DELETE：本模块只 expose get/rescore/append/update 四个方向，**不暴露任何 delete 面**
//   ④ rescore 与 runDiscovery 共用 scoreLeadFit ⇒ 两条路径同源（不会「发现时 0.3、重评时 0.8」）
//   ⑤ 真实实现签名严格对齐：getParticle(id) 单参、appendMemory({...}) 对象式单参
import { mergedDiscoveryRules } from '../../config/discoveryRules.js';
import { scoreLeadFit } from './leadFitScorer.js';

/**
 * @param {{tenantId?:string, decisionId?:string|null, deps?:object}} opts
 *   deps 全部可选（缺省走真实现）；单测可注入替身 → 零 IO
 *   可注入：getParticle / updateParticle / appendMemory / loadRules / now
 */
export function createMonitorCtx({ tenantId = 'system', decisionId = null, deps = {} } = {}) {
  const loadRules = deps.loadRules || ((t) => mergedDiscoveryRules({ tenantId: t }));
  const now = deps.now || (() => Date.now());

  // 真实 getParticle(id) 为单参（particleRepo.js:171），此处调用严格对齐、不臆造 opts
  const getAccount = deps.getParticle
    ? (id) => deps.getParticle(id)
    : async (id) => (await import('../../particles/particleRepo.js')).getParticle(id);

  // lead-fit 重评：读账户 → 取规则 → 确定性评分（零 LLM；见 leadFitScorer 边界①/②）
  const rescore = deps.rescore || (async (accountId, { signals = [] } = {}) => {
    const acct = await getAccount(accountId);
    const rules = await loadRules(tenantId);
    const scored = scoreLeadFit({ account: acct || {}, signals, rules, now: now() });
    return {
      score: scored.intent,                 // monitorAccount 读 rescored.score
      ruleRef: scored.ruleRefs.intent,
      icp_fit: scored.icp_fit,
      breakdown: scored.breakdown,
      degraded: scored.degraded,
    };
  });

  // 记忆追加（append-only；memoryLog 无删除面）
  //   真实 appendMemory({topic,kind,payload,tenantId,entityId,...}) 为对象式单参（memoryLog.js:69）
  const appendMemory = deps.appendMemory
    ? (type, id, payload) => deps.appendMemory({ topic: type, kind: payload?.kind || 'event', payload, entityId: id, tenantId })
    : async (type, id, payload) => {
      const { appendMemory: real } = await import('../../memory/memoryLog.js');
      return real({ topic: type, kind: payload?.kind || 'event', payload, entityId: id, tenantId });
    };

  // 写粒子：**先闸后写** —— 无决策即拒，绝不进入 repo
  const updateParticle = deps.updateParticle
    ? async (id, payload) => {
      if (!decisionId) throw new Error(`decision_required: monitorAccount 写路径无决策不落库`);
      return deps.updateParticle(id, { ...payload, tenantId, requireDecisionId: decisionId });
    }
    : async (id, payload) => {
      if (!decisionId) throw new Error(`decision_required: monitorAccount 写路径无决策不落库`);
      const { updateParticle: real } = await import('../../particles/particleRepo.js');
      return real(id, { ...payload, tenantId, requireDecisionId: decisionId });
    };

  return { getAccount, rescore, appendMemory, updateParticle };
}
