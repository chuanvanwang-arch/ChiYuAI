// src/decision/writableEdges.js — BG-05a：权威表可写边单一事实源 + required_dims 装弹自检
//
// 缺陷背景：S20 七维页保存 required_dims（场景要求的必填维度）时，若某维度依赖的边
//   当前系统无法真正写入权威表 crm.decision_relation（仅镜像到 AGE 图或压根漏接），
//   则该「必填」永远无法满足 → 巡检卡恒报 EDGE_MISSING 误报（与 BG-04 seed 假绿叠加）。
//
// 契约：
//   1. WRITABLE_EDGES 是唯一事实源：哪些边类型可被 linkDecisions 双写 PG 权威表（+AGE 镜像）。
//   2. BG-03 方案 B（2026-09-01 用户裁决）已落地：decision_relation.to_id 外键放宽，
//      故全部 7 类边均可写（含 decision→entity 的 DECIDED_ON、decision→exception 的 DERIVED_FROM_EXCEPTION）。
//      PENDING_WRITABLE_EDGES 已清空。若未来新增边类型，在此登记即可。
//   3. checkRequiredDimsWritable：保存 required_dims 前调用，若依赖边不可写 → 拒绝并给可读提示，
//      杜绝「配置要求系统交付不了的边」导致的误报。
import { DEFAULT_EDGE_DIMENSION_SPEC, edgesServingDimension } from './edgeDimensionSpec.js';

// 可写边单一事实源（落 PG 权威表 decision_relation，经 relation.linkDecisions）
export const WRITABLE_EDGES = [
  'DECIDED_ON',            // decision→entity（identity/structure）
  'REFERENCED_PRECEDENT',  // decision→decision（决策历史）
  'DERIVED_FROM_EXCEPTION', // decision→exception（operational_state）
  'ESTABLISHES_FRAME',     // decision→decision（语义/治理）
  'OVERRIDES',             // decision→decision（治理/决策历史）
  'CAUSED',                // decision→decision（时间配置）
  'INFLUENCED',            // decision→decision（时间配置）
];

// 当前不可写（BG-03 方案 B 已扩容至全 7 类，留空）
export const PENDING_WRITABLE_EDGES = [];

const WRITABLE_SET = new Set(WRITABLE_EDGES);

export function isEdgeWritable(relType) {
  return WRITABLE_SET.has(relType);
}

// 维度 → 服务它的边类型集合（默认规范；可被 config_store.edge_bindings 覆盖）
export function requiredEdgesForDims(dims = [], spec = DEFAULT_EDGE_DIMENSION_SPEC) {
  const out = new Set();
  for (const d of dims) {
    for (const et of edgesServingDimension(d, spec)) out.add(et);
  }
  return [...out];
}

// 自检：required_dims 依赖的边是否全部可写
// @param {Array<{dim:string,on_missing?:string}>} requiredDims
// @returns {{ ok:boolean, unwritable:Array<{dim:string, edges:string[]}>, writable:string[] }}
export function checkRequiredDimsWritable(requiredDims = [], spec = DEFAULT_EDGE_DIMENSION_SPEC) {
  const dims = (Array.isArray(requiredDims) ? requiredDims : [])
    .map((d) => (typeof d === 'string' ? d : d?.dim))
    .filter(Boolean);
  const unwritable = [];
  for (const dim of dims) {
    const edges = edgesServingDimension(dim, spec);
    const bad = edges.filter((e) => !isEdgeWritable(e));
    if (bad.length) unwritable.push({ dim, edges: bad });
  }
  return { ok: unwritable.length === 0, unwritable, writable: WRITABLE_EDGES };
}
