// src/sales/stageTaxonomy.js — S 码单一事实源（设计文档 §1）
// 四层（方法论 / 数据库 / 审批流 / 人机协同）一律引用本文件，杜绝第二套命名。
// 旧存储值 → S 码（DB 纯重命名迁移 + 兼容读历史）；P1-P6 仅作方法论显示别名，不进代码逻辑。

export const S_STAGES = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8'];

export const S_LABEL = {
  S1: '线索发掘', S2: '需求确认', S3: '方案匹配', S4: '报价谈判',
  S5: '合同确认', S6: '赢单移交', S7: '输单', S8: '丢单',
};

// 旧 DB 英文值 → S 码（迁移 + 兼容读历史）
export const S_ALIAS_FWD = {
  lead: 'S1', opportunity: 'S2', quoted: 'S3', contracted: 'S4',
  ordered: 'S5', paid: 'S6', lost: 'S7', disqualified: 'S8',
};
// S 码 → 旧英文（反查 / 降级显示）
export const S_ALIAS_REV = Object.fromEntries(
  Object.entries(S_ALIAS_FWD).map(([k, v]) => [v, k])
);

// P1-P6 仅作方法论显示别名（不进逻辑）
export const S_P_ALIAS = {
  S1: 'P1', S2: 'P2', S3: 'P3', S4: 'P4', S5: 'P5', S6: 'P6',
};

// 合法推进边（含退出边 S7/S8，任意阶段可进；赢单 S6 后不再向前）
export const S_TRANSITIONS = [
  { from: 'S1', to: 'S2' }, { from: 'S2', to: 'S3' }, { from: 'S3', to: 'S4' },
  { from: 'S4', to: 'S5' }, { from: 'S5', to: 'S6' },
  // 退出边（任意阶段 → 输单/丢单）
  { from: 'S1', to: 'S7' }, { from: 'S2', to: 'S7' }, { from: 'S3', to: 'S7' },
  { from: 'S4', to: 'S7' }, { from: 'S5', to: 'S7' }, { from: 'S6', to: 'S7' },
  { from: 'S1', to: 'S8' }, { from: 'S2', to: 'S8' }, { from: 'S3', to: 'S8' },
  { from: 'S4', to: 'S8' }, { from: 'S5', to: 'S8' }, { from: 'S6', to: 'S8' },
];

// 第 3.5 闸内容定义（设计 §2.1），纯数据；执行逻辑在 executor.salesStageGate
export const S_GATE_DEFS = [
  { from: 'S1', to: 'S2', hard: true, key: 'need_facts', attach: null },
  { from: 'S2', to: 'S3', hard: true, key: 'visit_value', attach: 'tech_review_proof' },       // G-S3 阶段门禁
  { from: 'S3', to: 'S4', hard: true, key: 'bantcc_quote', attach: null },
  { from: 'S4', to: 'S5', hard: true, key: 'review_contract', attach: 'customer_approval_screenshot' }, // G-S5 阶段门禁
  { from: 'S5', to: 'S6', hard: true, key: 'contract_paid', attach: null },
];

// 阶段门禁（强制附件，设计 §2.4）。AI 判存在性，缺则 hard 阻断。
export const S_ATTACHMENT_GATES = {
  'S2->S3': { tag: 'tech_review_proof', label: '客户技术评审通过证明' },
  'S4->S5': { tag: 'customer_approval_screenshot', label: '客户内部审批完成截图' },
};

export function toStageCode(v) {
  if (!v) return v;
  if (v.startsWith('S') && S_STAGES.includes(v)) return v; // 已是 S 码
  return S_ALIAS_FWD[v] || v;
}
export function fromStageCode(code) {
  return S_ALIAS_REV[code] || code;
}

// 阶段 → 默认决策场景（2026-09-08：从 src/action/seed-actions.js 上移为单一事实源，
//   供第 0 闸场景推断与对话坐标判定共用；值对齐 design doc §4.2 出厂默认表）
// 2026-09-02 修正说明（随常量一并上移）：原表自 S3 起整体错位一格（S3→QUOTE_PRICING / S4→SIGN_RISK /
//   S5→POST_CONTRACT），导致「方案匹配」阶段的决策全部被记成「报价定价」、S8 丢单缺键退回 OPP_QUALIFY。
//   生产实测佐证：decision 表 SOLUTION_VALUE / CLIENT_STRATEGY / POST_CONTRACT 三类场景均 0 行。
//   对齐依据：本文件 S_LABEL（S3 方案匹配 / S4 报价谈判 / S5 合同确认 / S6 赢单移交）。
export const STAGE_DEFAULT_SCENARIO = {
  S1: 'LEAD_FOLLOW_UP', S2: 'OPP_QUALIFY', S3: 'SOLUTION_VALUE',
  S4: 'QUOTE_PRICING', S5: 'SIGN_RISK', S6: 'POST_CONTRACT',
  S7: 'LOSS_REVIEW', S8: 'LOSS_REVIEW',
};
