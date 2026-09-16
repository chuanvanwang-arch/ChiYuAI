// src/decision/adviceStore.js — 建议结构化摘要（对话原文零落库）
// 设计：docs/2026-09-08-dialog-driven-decision-advice-design.md §5
//
// ⚠ 2026-09-16 E3 设计变更：**本模块不再产出 crm.decision 锚点**。
//   原导出 `ADVISED_STATE` / `buildAdviceAnchor`（写入 crm.decision + state='ADVISED'）已**退役**。
//   三条否决证据（完整版见 src/decision/adviceRecord.js 头部）：
//     ① crm.decision 的 8 个聚合/统计读取点（日报/复盘/校准样本/可审计性抽检/决策史注入…）
//        会被非决策行永久污染，且**验收会通过**（典型部分假绿）；
//     ② createDecision 的 decided_at 硬写 now() → 时间窗聚合无 NULL 免疫；
//     ③ createDecision 内 sevenDimensionsCheck 拦截在证据不足时**直接抛错**，
//        而建议恰恰产生于证据不足时 → 最该记录的场景反而写不进去。
//   现由独立运行态表 crm.advice_record 承载（`adviceRecord.js`）。
//   本文件仅保留**摘要口径这一单一事实源**（不落对话原文）。
//
// 2026-09-08 设计纠偏（执行期发现）：原计划「摘要 = utterance 前 120 字」与已批准前提 D2
//   （对话原文不落库）直接冲突——截断原文仍是原文片段。此处改为结构化摘要：
//   只落「场景@阶段 + 命中关键词」，函数签名不接受 utterance，杜绝误落库。
const SUMMARY_MAX = 120;

// 结构化诉求摘要：不含任何对话原文。调用方传 { scenario_id, stage, hits }。
export function buildStructuredSummary(advice = {}) {
  const hits = Array.isArray(advice.hits) && advice.hits.length ? advice.hits.join('/') : '无关键词命中';
  return `${advice.scenario_id || '未定位'}@${advice.stage || 'S?'}｜诉求关键词:${hits}`.slice(0, SUMMARY_MAX);
}
