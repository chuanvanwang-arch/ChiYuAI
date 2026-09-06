// src/decision/edgeSource.js — T0(BG-04) 边来源口径隔离：单一事实源
// 问题：crm.decision_relation 混存「运行时真实边」(source=engine/mcp/manual/human…)
//   与「演示/种子边」(source='seed-script')。看板/闭环把演示边当真实边 → 假绿。
// 解法：本模块统一判定边来源口径，调用方据此做双口径（运行时 N / 演示 M，演示边虚线不计入分母）。
// 铁律：零 DELETE —— 演示边保留 source='seed-script' 仅做分类，绝不物理删除。
//   软标记口径见 sales-decision-monitor 重新设计 §6 Phase 5（props.demo=true 软标记，待后续清理任务）。

// 演示/种子边来源标记（单一事实源）。新增演示来源时在此追加，全仓统一。
export const DEMO_EDGE_SOURCES = ['seed-script'];

// 运行时边来源：非演示、非空的显式来源（engine/mcp/manual/human/ai…）。
export function isDemoEdgeSource(source) {
  return DEMO_EDGE_SOURCES.includes(source);
}

export function isRuntimeEdgeSource(source) {
  // 来源必须可追溯：NULL/undefined 不计入真实供给（与 relation.js 的 `source IS NOT NULL` 口径一致）。
  if (source == null) return false;
  return !isDemoEdgeSource(source);
}

// 将边数组按来源口径拆分为运行时/演示两组（不修改原数组）。
export function splitEdgesByCaliber(edges = []) {
  const runtime = [];
  const demo = [];
  for (const e of edges) {
    if (isRuntimeEdgeSource(e?.source)) runtime.push(e);
    else demo.push(e);
  }
  return { runtime, demo };
}

// 双口径计数：{ runtime: N, demo: M }。
export function edgeCaliberCount(edges = []) {
  const { runtime, demo } = splitEdgesByCaliber(edges);
  return { runtime: runtime.length, demo: demo.length };
}

// 仅取运行时边（供 exist / 合规分母判定）。
export function runtimeEdgesOnly(edges = []) {
  return splitEdgesByCaliber(edges).runtime;
}
