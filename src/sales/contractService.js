// src/sales/contractService.js — 合同粒子 + 写时金额校验 + 二级资源挂边协议（T3-6）
// 设计输入：01 文档 line13 铁律「线索、商机、合同不是三个粒子——同一交易实体（deal）生命周期阶段」
//          → 合同 = CRM_CONTRACT 独立粒子（挂 DEAL 的 has_contract 受控边），非 deal 改名
//          §5 E15（四级定价：产品→价格表→报价→合同；合同金额来自报价快照或明细可重算）
//          §5ter-quater Q.5（写后验证 sum=明细）
// 二级资源挂边（T3-6 验收③）：PAYMENT_PLAN/PAYMENT_RECORD/INVOICE（后置 T3-7/T3-8 粒子）
//          均带 contract_id 引用 → 写时 hooks refs 自动建 has_contract 受控边 → 本文件提供引用协议
// 纯逻辑（金额校验/边协议无 PG）；粒子持久化走 particleRepo（写时 hooks 自动建边/向量）

// —— 合同写时校验（闸：编号必填 / 周期合法 / 金额非负 / 写后验证 sum=明细）——
export function validateContract({ contract_no, start_date, end_date, amount, line_items }) {
  const errors = [];
  if (!contract_no || !String(contract_no).trim()) errors.push('合同编号必填（contract_no）');
  if (start_date && end_date && new Date(start_date) >= new Date(end_date)) errors.push('合同周期非法：start_date 必须早于 end_date');
  if (amount != null && Number(amount) < 0) errors.push('合同金额不可为负');
  if (line_items?.length && amount != null) {
    const sum = line_items.reduce((s, l) => s + Number(l.line_total || 0), 0);
    if (Math.abs(sum - Number(amount)) > 0.01) errors.push(`合同金额与明细不一致（写后验证 sum=${sum.toFixed(2)} ≠ amount=${amount}）`);
  }
  return { ok: errors.length === 0, errors };
}

// —— 二级资源挂边协议（contract_id 引用 → has_contract 受控边）——
// 挂在二级粒子（PAYMENT_PLAN/PAYMENT_RECORD/INVOICE）coreAttributes.contract_id
// 写时由 hooks refs 自动建边（has_contract）；此处校验引用合法性 + 返回边协议
const SECONDARY_RESOURCE_EDGE = { edge: 'has_contract', target: 'CRM_CONTRACT' };
export function resolveSecondaryEdge(contract_type, payload) {
  if (!payload.contract_id) return { ok: false, reason: `${contract_type} 缺少 contract_id 引用` };
  return { ok: true, edge: SECONDARY_RESOURCE_EDGE, source_type: contract_type, target_id: payload.contract_id };
}

// —— 创建合同（写时管线）——
// - validateContract 校验：编号必填 / 周期合法 / 金额非负 / 写后验证 sum=明细（不通过抛错）
// - payload 不包含 line_items 字段（明细供校验后即弃；合同粒子只存金额快照 + items 摘要）
// - 持久化走 createParticle（写时 hooks：belongs_to DEAL + 本体/嵌入自动同步）
export async function createContract({ contract_no, deal_id, quotation_id, start_date, end_date, amount, line_items, tenantId = 'system', decisionId = null }) {
  const check = validateContract({ contract_no, start_date, end_date, amount, line_items });
  if (!check.ok) throw new Error(`合同校验失败: ${check.errors.join('; ')}`);
  const { createParticle } = await import('../particles/particleRepo.js');
  const payload = { contract_no, deal_id, quotation_id, start_date, end_date, amount, approval_status: 'draft', invalid: false };
  const contract = await createParticle('CRM_CONTRACT', payload, { tenantId, requireDecisionId: decisionId });
  return { ...contract };
}