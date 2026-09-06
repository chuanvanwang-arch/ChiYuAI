// src/context/supplySpec.js — A-T1：供给侧 S1–S7 操作注册表（单一事实源）+ 校验
//
// 设计（unified 文档 §4.1–§4.2）：三轴正交的「供给侧」轴——回答「这次装配跑了哪些操作、返回什么、状态如何」。
// 与校验侧七维（sevenDimensions/constants.js）、结构侧七边（edgeDimensionSpec.js）正交。
// 每操作带 kind（fact/narrative/deterministic）标记，对应「事实/解释二分」与确定性不烧 token 铁律。
//
// 铁律：
//   1. 操作↔维度绑定可配置（config_store['seven-dim'].supply_bindings，与 edge_bindings 并列），
//      校验失败 fail-safe 回退本默认注册表，不阻断业务。
//   2. validateSupplySpec 强制 7 操作齐备 + 7 维全覆盖，杜绝悬空操作/悬空维/维未覆盖。
import { SEVEN_DIMS, DIM_KEYS as SEVEN_DIM_KEYS } from '../sevenDimensions/constants.js';

export const SUPPLY_KINDS = ['fact', 'narrative', 'deterministic'];

// 默认供给操作注册表（unified 文档 §4.1 表，逐字对齐真实运行模块/数据源）
export const DEFAULT_SUPPLY_OPS = [
  { op: 'S1', name: '实体与结构取', module: 'retrieveEntityProfile+particles', serves_dims: ['identity', 'structure'], kind: 'fact', produces_edge: 'DECIDED_ON' },
  { op: 'S2', name: '决策史检索', module: 'searchPrecedents', serves_dims: ['decision_history'], kind: 'fact', produces_edge: 'REFERENCED_PRECEDENT' },
  { op: 'S3', name: '冲突探测', module: 'detectConflicts', serves_dims: ['semantics', 'governance'], kind: 'fact', produces_edge: null },
  { op: 'S4', name: '规则校验', module: 'ruleEngine.check', serves_dims: ['governance'], kind: 'deterministic', produces_edge: 'rule_hit' },
  { op: 'S5', name: '时间线构建', module: 'buildTimelineRows+loadTimelineSources', serves_dims: ['time_config', 'operational_state'], kind: 'narrative', produces_edge: 'CAUSED' },
  { op: 'S6', name: '运行态取', module: 'tasks+agent_health+回款/竞品', serves_dims: ['operational_state'], kind: 'fact', produces_edge: null },
  // S7 溯源捕获：装配期恒空壳（trackEntry 在 decision 落库阶段统一调，装配返回空）；
  // 原声明 serves_dims=全 7 维属空头支票——dimCoverageFromOps 据此谎报 7 维全覆盖，掩盖真空洞。
  // 修正（P-1 T3）：溯源是落库后产生的 PROV-O 边（侧效应），非装配期事实供给，故不声明任何事实维。
  // 7 维已由 S1–S6 完整覆盖（validateSupplySpec 仍 valid）；运行时 computeDimCoverage 仅认真实 hit。
  { op: 'S7', name: '溯源捕获', module: 'trackEntry', serves_dims: [], kind: 'deterministic', produces_edge: 'PROV-O' },
];

export const DIM_KEYS = new Set(SEVEN_DIM_KEYS);
const OP_KEYS = new Set(DEFAULT_SUPPLY_OPS.map((o) => o.op));

// 校验供给操作集：7 操作齐备 + 7 维全覆盖 + 无悬空项
// @returns {{ valid:boolean, errors:string[], coveredDims:string[] }}
export function validateSupplySpec(ops = DEFAULT_SUPPLY_OPS) {
  const errors = [];
  const seenOps = new Set();
  const covered = new Set();
  for (const o of ops) {
    if (!o || typeof o.op !== 'string') { errors.push('供给操作缺 op 标识'); continue; }
    if (seenOps.has(o.op)) errors.push(`重复操作: ${o.op}`);
    seenOps.add(o.op);
    if (!o.name) errors.push(`操作 ${o.op} 缺 name`);
    if (!o.module) errors.push(`操作 ${o.op} 缺 module`);
    if (!SUPPLY_KINDS.includes(o.kind)) errors.push(`操作 ${o.op} kind 须为 ${SUPPLY_KINDS.join('/')}`);
    const dims = Array.isArray(o.serves_dims) ? o.serves_dims : [];
    for (const d of dims) {
      if (!DIM_KEYS.has(d)) errors.push(`操作 ${o.op} 指向未知维度 ${d}`);
      else covered.add(d);
    }
  }
  for (const op of OP_KEYS) if (!seenOps.has(op)) errors.push(`操作缺失: ${op}`);
  for (const d of DIM_KEYS) if (!covered.has(d)) errors.push(`维度未被任何操作供给: ${d}`);
  return { valid: errors.length === 0, errors, coveredDims: [...covered] };
}

// 从 config_store['seven-dim'].supply_bindings 加载（覆盖默认）；校验失败 fail-safe 回退默认
export function resolveSupplySpec(value) {
  const bindings = value && Array.isArray(value?.supply_bindings) && value.supply_bindings.length
    ? value.supply_bindings : null;
  if (!bindings) return { loaded: false, ops: DEFAULT_SUPPLY_OPS, errors: ['未配置 supply_bindings'] };
  const v = validateSupplySpec(bindings);
  if (!v.valid) return { loaded: false, ops: DEFAULT_SUPPLY_OPS, errors: v.errors };
  return { loaded: true, ops: bindings, errors: [] };
}

export function dimCoverageFromOps(ops = DEFAULT_SUPPLY_OPS) {
  const map = {};
  for (const d of DIM_KEYS) map[d] = { supplied: false, ops: [] };
  for (const o of ops) {
    for (const d of (o.serves_dims || [])) {
      if (map[d]) { map[d].supplied = true; map[d].ops.push(o.op); }
    }
  }
  return map;
}
