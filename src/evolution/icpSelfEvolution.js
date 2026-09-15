// src/evolution/icpSelfEvolution.js
// ICP 自进化：草稿 → 回测 → HITL 生效（P0#3）
// 铁律：
//   1. **无 HITL 批准绝不生效** —— propose 只落草稿（icp_draft）；生效写（icp）仅由 approve 触发。
//      依据：CALIBRATION_CHANGE.autonomous_allowed=false（测试库实证），天然强制人工闸。
//   2. 决策第 0 闸（requireDecision）由 store 层承担（配置类写必经）；本层纯编排、零 IO。
//   3. 阈值/权重 100% 配置驱动（config_store['discovery-rules'].icp）；本文件零行业字面量。
//   4. 禁 DELETE：草稿归档用 status 标记（'draft'|'approved'|'rejected'），绝不物理删除。
//   5. 样本闸复用 MIN_SAMPLE（src/calibration/constants.js:5），禁自造数值（R5/R6 防过拟合噪声）。
import { MIN_SAMPLE } from '../calibration/constants.js';

export const ICP_DRAFT_KEY = 'icp_draft';
export const DRAFT_STATUS = Object.freeze(['draft', 'approved', 'rejected']);
export const BACKTEST_VERDICTS = Object.freeze(['threshold', 'count', 'noop']);

// 回测（纯函数、零 IO）：现行 ICP vs 草稿 ICP + 历史样本
//   三态判据（顺序即优先级）：
//     noop      —— 草稿与现行零差异 → 空操作闸（防 churn，绝不无意义改写线上配置）
//     count     —— 样本不足（< minSample，默认 MIN_SAMPLE=20）→ 拒绝推进（防过拟合噪声，对齐 R5/R6）
//     threshold —— 样本充足且命中率 ≥ passLine → passed=true（仅表示「回测支持本次变更」，
//                  不等于生效；生效仍须 HITL —— 见 propose/approve 分层）
export function backtestIcpDraft({ draft, current = {}, samples = [], minSample = MIN_SAMPLE, passLine = 0.6 } = {}) {
  const proposed = (draft && typeof draft === 'object' && draft.icp) ? draft.icp : (draft || {});
  const cur = current && typeof current === 'object' ? current : {};
  const deltas = {};
  for (const k of new Set([...Object.keys(cur), ...Object.keys(proposed)])) {
    const a = cur[k]; const b = proposed[k];
    if (JSON.stringify(a) !== JSON.stringify(b)) deltas[k] = { from: a, to: b };
  }
  const sampleSize = Array.isArray(samples) ? samples.length : 0;
  const hitRate = sampleSize ? samples.filter((s) => s && s.hit === true).length / sampleSize : 0;
  let verdict;
  if (Object.keys(deltas).length === 0) verdict = 'noop';
  else if (sampleSize < minSample) verdict = 'count';
  else verdict = 'threshold';
  const passed = verdict === 'threshold' && hitRate >= passLine;
  return {
    verdict, passed, hit_rate: Number(hitRate.toFixed(4)), sample_size: sampleSize,
    deltas, min_sample: minSample, pass_line: passLine,
  };
}

// 出草稿：先回测 → 再落草稿（绝不自动生效）→ needsApproval 恒真
//   返回 decisionId 供审计串联（第 0 闸凭证由 store 层 mint）
export async function proposeIcpRecalibration(store, draft, { tenantId = 'system', samples = [], actor = 'system' } = {}) {
  const current = await store.readActiveIcp({ tenantId });
  const report = backtestIcpDraft({ draft, current, samples });
  const { draftId, decisionId } = await store.insertDraft({ ...draft, status: 'draft', report }, { tenantId, actor });
  // needsApproval 恒真：与回测是否通过无关（硬约束——无 HITL 绝不生效）
  return { draftId, decisionId, report, needsApproval: true, validated: false };
}

// HITL 生效：唯一把草稿写进线上 icp 的入口（approver 必填，缺失即 fail-closed）
export async function approveIcpRecalibration(store, draftId, approver, { tenantId = 'system' } = {}) {
  if (!approver) throw new Error('approveIcpRecalibration: approver 必填（HITL 硬约束）');
  if (!draftId) throw new Error('approveIcpRecalibration: draftId 必填');
  const { decisionId } = await store.setValidated(draftId, true, approver, { tenantId });
  return { draftId, decisionId, validated: true, approver };
}

// 夜批 pass（对齐 runParamInspectionPass 范式：dryRun / 只出草稿 / 独立 catch 由调用方承担）
//   无候选即不产草稿（绝不自动编造配置）—— 候选由后台配置页（T17）/ CLI 显式注入 draft
export async function runIcpEvolutionPass({ tenantId = 'system', dryRun = false, store = null, samples = [], draft = null } = {}) {
  if (!store) return { tenantId, drafts: 0, skipped: 'no_store' };
  if (!draft) return { tenantId, drafts: 0, skipped: 'no_draft_proposed' };
  const current = await store.readActiveIcp({ tenantId });
  const report = backtestIcpDraft({ draft, current, samples });
  if (dryRun) return { tenantId, drafts: 0, dryRun: true, skipped: 'dry_run', verdict: report.verdict, passed: report.passed };
  const r = await proposeIcpRecalibration(store, draft, { tenantId, samples });
  return { tenantId, drafts: 1, dryRun: false, draftId: r.draftId, verdict: r.report.verdict, needsApproval: true };
}
