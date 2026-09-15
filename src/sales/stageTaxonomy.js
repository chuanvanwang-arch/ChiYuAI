// src/sales/stageTaxonomy.js — S 码单一事实源（设计文档 §1）
// 四层（方法论 / 数据库 / 审批流 / 人机协同）一律引用本文件，杜绝第二套命名。
// 旧存储值 → S 码（DB 纯重命名迁移 + 兼容读历史）；P1-P6 仅作方法论显示别名，不进代码逻辑。

export const S_STAGES = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8'];

// ── 公海阶段（2026-09-11）：公海 = S0；认领后 = S0P（私海待校验）；BANT 校验通过 = S1（正式线索）──
// ⚠ 两套集合并存是有意为之：funnelKpi.js:36 用 S_STAGES.indexOf() 做前缀展开，
//    把 S0 插进 S_STAGES 会让漏斗上游吞进公海线索 → 全部转化率失真。故 S_STAGES 冻结为 S1-S8。
export const S_POOL_STAGE = 'S0';    // 公海
export const S_PICKED_STAGE = 'S0P'; // 私海线索（待校验）
export const S_ALL_STAGES = [S_POOL_STAGE, S_PICKED_STAGE, ...S_STAGES];
export const S_PRE_DEAL_STAGES = [S_POOL_STAGE, S_PICKED_STAGE];

export const S_LABEL = {
  S0: '公海', S0P: '私海线索',
  S1: '正式线索', S2: '需求确认', S3: '方案匹配', S4: '报价谈判',
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

// 终态 / 在跟（2026-09-09：「待跟进」视角判定，设计 docs/2026-09-09-follow-stage-filter-fix-design.md §3.1）
//   语义：S7 输单 / S8 丢单 为退出态，其余 S1–S6 均属「在跟」，需出现在待办。
//   单一事实源：判定逻辑不得在调用方另写 value 列表（杜绝第三套命名）。
export const S_TERMINAL_STAGES = ['S7', 'S8'];
export const S_OPEN_STAGES = S_STAGES.filter((s) => !S_TERMINAL_STAGES.includes(s)); // S1–S6

// 是否「在跟」：先归一（旧英文 lead/quoted/contracted…→S 码），再判非终态。
// 未知值（含脏值 'leads'）与缺失 → true（fail-open：宁可多报，不可漏报漏跟进）
export function isOpenStage(v) {
  const code = toStageCode(v);
  if (!code) return true;
  return !S_TERMINAL_STAGES.includes(code);
}

// 是否公海阶段（S0）。S0P 属私海（有归属、需跟进），不在此列。
// 用途：待办/跟进视图据此排除公海——公海无人跟进，不该出现在任何人的待办里。
export function isPoolStage(v) {
  return toStageCode(v) === S_POOL_STAGE;
}

// 阶段归一（DB 视角）：公海判定以 owner_id 为准，而非仅看 stage。
// 迁移遗漏或脏数据时，「无主却标 S1」会制造「已认领」的假象 → 统一纠偏为 S0。
// 入参可为粒子（取 .payload）或裸 payload。
export function normalizeDealStage(deal = {}) {
  const p = deal.payload || deal;
  const code = toStageCode(p?.stage);
  if (!p?.owner_id && (code === S_POOL_STAGE || code === 'S1')) return S_POOL_STAGE;
  return code;
}

// 合法推进边（含退出边 S7/S8，任意阶段可进；赢单 S6 后不再向前）
export const S_TRANSITIONS = [
  { from: 'S1', to: 'S2' }, { from: 'S2', to: 'S3' }, { from: 'S3', to: 'S4' },
  { from: 'S4', to: 'S5' }, { from: 'S5', to: 'S6' },
  // 退出边（任意阶段 → 输单/丢单）
  { from: 'S1', to: 'S7' }, { from: 'S2', to: 'S7' }, { from: 'S3', to: 'S7' },
  { from: 'S4', to: 'S7' }, { from: 'S5', to: 'S7' }, { from: 'S6', to: 'S7' },
  { from: 'S1', to: 'S8' }, { from: 'S2', to: 'S8' }, { from: 'S3', to: 'S8' },
  { from: 'S4', to: 'S8' }, { from: 'S5', to: 'S8' }, { from: 'S6', to: 'S8' },
  // 公海三档（2026-09-11）：认领不经 advance（走 crm-lead-pick 的 updateParticle，受 PickRule 约束）
  { from: 'S0P', to: 'S1' },                                  // BANT 校验通过 → 正式线索
  { from: 'S0', to: 'S7' }, { from: 'S0', to: 'S8' },         // 公海直接判无效
  { from: 'S0P', to: 'S7' }, { from: 'S0P', to: 'S8' },       // 待校验直接判无效
];

// 第 3.5 闸内容定义（设计 §2.1），纯数据；执行逻辑在 executor.salesStageGate
export const S_GATE_DEFS = [
  { from: 'S1', to: 'S2', hard: true, key: 'need_facts', attach: null },
  { from: 'S2', to: 'S3', hard: true, key: 'visit_value', attach: 'tech_review_proof' },       // G-S3 阶段门禁
  { from: 'S3', to: 'S4', hard: true, key: 'bantcc_quote', attach: null },
  { from: 'S4', to: 'S5', hard: true, key: 'review_contract', attach: 'customer_approval_screenshot' }, // G-S5 阶段门禁
  { from: 'S5', to: 'S6', hard: true, key: 'contract_paid', attach: null },
  { from: 'S0P', to: 'S1', hard: true, key: 'bantcc_lead', attach: null },   // B/A/T 三要素（或 bantcc_completeness≥pass）→ 正式线索
];

// 阶段门禁（强制附件，设计 §2.4）。AI 判存在性，缺则 hard 阻断。
export const S_ATTACHMENT_GATES = {
  'S2->S3': { tag: 'tech_review_proof', label: '客户技术评审通过证明' },
  'S4->S5': { tag: 'customer_approval_screenshot', label: '客户内部审批完成截图' },
};

export function toStageCode(v) {
  if (!v) return v;
  if (v.startsWith('S') && S_ALL_STAGES.includes(v)) return v; // 已是 S 码（含 S0/S0P）
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
  S0: 'LEAD_FOLLOW_UP', S0P: 'LEAD_FOLLOW_UP',
  S1: 'LEAD_FOLLOW_UP', S2: 'OPP_QUALIFY', S3: 'SOLUTION_VALUE',
  S4: 'QUOTE_PRICING', S5: 'SIGN_RISK', S6: 'POST_CONTRACT',
  S7: 'LOSS_REVIEW', S8: 'LOSS_REVIEW',
};
