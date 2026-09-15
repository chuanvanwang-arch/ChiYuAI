// src/sales/leadQualify.js — S0P→S1「升级正式线索」的 B/A/T 判据（单一事实源）
// 消费者：executor.STAGE_GATES（写闸）+ seed-actions.GATE_EVIDENCE（建议闸）+ executor.salesDealPrereq（建单三要素闸）
// 纯函数零依赖：阈值由调用方解析后传入，避免此处 import config/DB。
// 语义（设计 §3.5.2）：B(预算)/A(责任人)/T(时间表) 三要素齐，或 AI 评估 bantcc_completeness >= pass。
// P0-2b（2026-09-15）：B/A/T 齐但决策链不完整同样拦截（引 validateDecisionChain，决策链完整性并入升级硬闸）。
import { validateDecisionChain, DEFAULT_ROLE_MAP } from './decisionChainValidator.js';

/**
 * B/A/T 三要素缺失项（共享判定核，零依赖、零阈值）。
 * 单一事实源：leadQualifyGap（升级闸）与 salesDealPrereq（建单闸）共用，杜绝第二套 B/A/T 副本。
 * @param {object} bantcc - payload.bantcc
 * @returns {string[]} 缺失项中文名数组（空数组=齐备）
 */
export function bantMissing(bantcc = {}) {
  const b = bantcc || {};
  const bOk = b.budget_ok === true || (b.budget != null && String(b.budget) !== '');
  const aOk = b.authority_ok === true || (b.authority != null && String(b.authority) !== '');
  const tOk = b.timetable_ok === true || b.schedule != null || b.timeline != null;
  const miss = [];
  if (!bOk) miss.push('预算');
  if (!aOk) miss.push('责任人');
  if (!tOk) miss.push('时间表');
  return miss;
}

/**
 * S0P→S1「升级正式线索」判据。
 * @param {object} payload - DEAL payload
 * @param {{pass?:number, unknown?:number}} [opts] - 达标线 / 未评估兜底（由调用方 readThreshold 解析）
 * @returns {string|null} null=放行；string=未满足原因
 */
export function leadQualifyGap(payload = {}, { pass = 0.6, unknown = 0, decisionChainMin = 0.75 } = {}) {
  const raw = (payload.ai || {}).bantcc_completeness;
  const aiComp = typeof raw === 'object' ? Number(raw?.value ?? unknown) : Number(raw ?? unknown);
  if (Number.isFinite(aiComp) && aiComp >= pass) return null;
  const miss = bantMissing(payload.bantcc);
  if (miss.length === 0) {
    // P0-2b：B/A/T 齐但决策链不完整 → 仍拦截（防假绿：仅看 B/A/T 会误放，§3.5.2 硬闸语义扩展）
    // 决策链完整性阈值由调用方配置（decisionChainMin 缺省 0.75；不满足即列为挂起，不落 S1）
    const chain = payload.decision_chain || null;
    if (chain && chain.contacts && Array.isArray(chain.contacts)) {
      const { completeness, missingRoles } = validateDecisionChain(chain.contacts, {}, { roleMap: chain.role_map || DEFAULT_ROLE_MAP });
      if (completeness < decisionChainMin) {
        return `决策链不完整（完整性 ${completeness.toFixed(2)} < ${decisionChainMin}），缺角色：${missingRoles.join('/')}`;
      }
    }
    return null;
  }
  return `未满足正式线索条件，缺 ${miss.join('/')}（或 bantcc_completeness ≥ ${pass}）`;
}
