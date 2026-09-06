// src/calibration/rules.js — 归因规则：指标 → 处方/拒方（纯函数，无 PG 依赖）
// 设计依据：docs/2026-08-28-decision-quality-calibration-design.md §5
// 优先级契约：R5/R6 是"拒绝出方"规则，优先级高于一切出方规则（R1-R4）。
//   小样本上出方 = 过拟合噪声（R6）；先例不足时调参无效（R5）。二者命中则不出任何处方。
// 规则表本身可配置（config_store['calibration-rules']），一期只读，改规则走代码（设计 §5）。
import { MIN_SAMPLE } from './constants.js';

// 出方规则（R1-R4）+ 守卫规则（R5-R6），按 id 引用于 evidence
export const RULES = {
  R1: {
    id: 'R1',
    condition: (m) =>
      m.sample_size >= MIN_SAMPLE &&
      m.autonomy_override_rate > 0.25 &&
      (m.avg_confidence_gap_to_threshold ?? 0) < 0.05,
    knob: 'threshold',
    delta: { threshold: +0.05 },
    risk: 'LOW',
    label: '自主覆写率高且置信度贴阈值 → 阈值上调 0.05，收紧自主放行',
    evidence_keys: ['autonomy_override_rate', 'avg_confidence_gap_to_threshold'],
  },
  R2: {
    id: 'R2',
    condition: (m) =>
      m.sample_size >= MIN_SAMPLE &&
      m.escalate_rate > 0.6 &&
      (m.escalated_override_rate ?? 0) < 0.05,
    knob: 'threshold',
    delta: { threshold: -0.05 },
    risk: 'MEDIUM',
    label: '升级率>60%且升级件几乎无覆写 → 阈值下调 0.05，放权给自主',
    evidence_keys: ['escalate_rate', 'escalated_override_rate'],
  },
  R3: {
    id: 'R3',
    condition: (m) =>
      m.sample_size >= MIN_SAMPLE &&
      (m.escalation_fatigue_rate ?? 0) > 0.3,
    knob: 'threshold',
    delta: { threshold: -0.05 },
    risk: 'MEDIUM',
    label: '升级疲劳率>30% → 阈值下调 0.05 或精简升级条件（降疲劳）',
    evidence_keys: ['escalation_fatigue_rate'],
  },
  R4: {
    id: 'R4',
    condition: (m) =>
      m.sample_size >= MIN_SAMPLE &&
      (m.weight_sensitivity_method ?? 0) > 0.3 &&
      (m.weight_sensitivity_method ?? 0) > (m.weight_sensitivity_coverage ?? 0) &&
      (m.weight_sensitivity_method ?? 0) > (m.weight_sensitivity_similarity ?? 0),
    knob: 'weight',
    delta: { weights: { method: +0.05 } },
    risk: 'MEDIUM',
    label: 'methodScore 与覆写相关性显著高于其他分项 → method 权重 +0.05',
    evidence_keys: ['weight_sensitivity_method', 'weight_sensitivity_coverage', 'weight_sensitivity_similarity'],
  },
  // 守卫规则（优先级高于 R1-R4；无 knob，命中即拒方）
  R5: {
    id: 'R5',
    condition: (m) => (m.precedent_coverage_avg ?? 0) < 0.3,
    knob: null,
    label: '先例覆盖不足（<0.3）→ 调参无效，拒方',
    evidence_keys: ['precedent_coverage_avg'],
  },
  R6: {
    id: 'R6',
    condition: (m) => (m.sample_size ?? 0) < MIN_SAMPLE,
    knob: null,
    label: '样本不足（<20）→ 拒方（防过拟合噪声）',
    evidence_keys: ['sample_size'],
  },
  // ── J3 深化规则（R7-R10，新 knob）──
  R7: {
    id: 'R7',
    condition: (m) => m.sample_size >= MIN_SAMPLE && (m.outcome_mismatch_rate ?? 0) > 0.2,
    knob: 'outcome_threshold',
    delta: { outcome_threshold: +0.05 },
    risk: 'LOW',
    label: '人工采纳但业务失败占比>20% → 收紧 outcome 阈值 + 补必填维度',
    evidence_keys: ['outcome_mismatch_rate'],
  },
  R8: {
    id: 'R8',
    condition: (m) => m.sample_size >= MIN_SAMPLE && (m.avg_confidence ?? 0) > 0.8 && (m.outcome_mismatch_rate ?? 0) > 0.2,
    knob: 'confidence',
    delta: { confidence: -0.1 },
    risk: 'MEDIUM',
    label: '置信度系统性偏高但业务失败率高 → 下调 confidence 校准系数',
    evidence_keys: ['avg_confidence', 'outcome_mismatch_rate'],
  },
  R9: {
    id: 'R9',
    condition: (m) => m.sample_size >= MIN_SAMPLE && (m.edge_missing_rate ?? 0) > 0.3,
    knob: 'edge_binding',
    delta: { edge_binding: 'strengthen' },
    risk: 'MEDIUM',
    label: '某边应存缺率高（如 CAUSED 缺失）→ 强化该边写入校验',
    evidence_keys: ['edge_missing_rate'],
  },
  R10: {
    id: 'R10',
    condition: (m) => m.sample_size >= MIN_SAMPLE && (m.context_insufficient_rate ?? 0) > 0.3,
    knob: 'required_dims',
    delta: { required_dims: 'expand' },
    risk: 'MEDIUM',
    label: 'context_insufficient 类占比高 → 扩该场景维度集合',
    evidence_keys: ['context_insufficient_rate'],
  },
  // ── 七类根因处方规则（R11-R17，溯源文档 §3.2）──
  R11: {
    id: 'R11', condition: (m) => (m.field_mismatch_rate ?? 0) > 0.2, knob: 'meta_attr_map',
    delta: { action: 'fix_mapping' }, risk: 'MEDIUM',
    label: '字段不一致率高 → 修正 meta_attr 字段映射', evidence_keys: ['field_mismatch_rate'],
  },
  R12: {
    id: 'R12', condition: (m) => (m.info_incomplete_rate ?? 0) > 0.2, knob: 'particle_attr_add',
    delta: { action: 'add_required' }, risk: 'MEDIUM',
    label: '信息不完整率高 → 补录粒子缺失必填属性', evidence_keys: ['info_incomplete_rate'],
  },
  R13: {
    id: 'R13', condition: (m) => (m.input_stale_rate ?? 0) > 0.2, knob: 'source_refresh',
    delta: { action: 'refresh' }, risk: 'LOW',
    label: '输入不及时率高 → 触发源刷新或订阅状态变更事件', evidence_keys: ['input_stale_rate'],
  },
  R14: {
    id: 'R14', condition: (m) => (m.dim_missing_rate ?? 0) > 0.2, knob: 'required_dims',
    delta: { required_dims: 'expand' }, risk: 'MEDIUM',
    label: '维度缺失率高 → 调整 required_dims 纳入漏判维度', evidence_keys: ['dim_missing_rate'],
  },
  R15: {
    id: 'R15', condition: (m) => (m.edge_missing_rate ?? 0) > 0.2, knob: 'edge_binding',
    delta: { edge_binding: 'strengthen' }, risk: 'MEDIUM',
    label: '边选择不对（应存缺）→ 调整 edgeDimensionSpec 强制写出', evidence_keys: ['edge_missing_rate'],
  },
  R16: {
    id: 'R16', condition: (m) => (m.need_dim_order_rate ?? 0) > 0.2, knob: 'dim_order',
    delta: { action: 'reorder' }, risk: 'LOW',
    label: '优化次序/补齐维度 → 重排维度评估次序', evidence_keys: ['need_dim_order_rate'],
  },
  R17: {
    id: 'R17', condition: (m) => (m.precedent_pollution_rate ?? 0) > 0.2, knob: 'precedent_distill',
    delta: { action: 'downweight' }, risk: 'HIGH',
    label: '参考先例污染率高 → 对造成误导的先例降权（禁删，走蒸馏）', evidence_keys: ['precedent_pollution_rate'],
  },
};

// 归因求值：输入 metrics 对象，输出 { patches: [], guards: [], reason }
export function attribute(metrics = {}) {
  const m = { ...metrics };
  const guards = [];
  const patches = [];

  // 守卫先行：命中任一守卫 → 不出任何出方规则（R5 优先于 R6 记录）
  for (const id of ['R5', 'R6']) {
    if (RULES[id].condition(m)) guards.push({ id, reason: RULES[id].label, evidence: pick(m, RULES[id].evidence_keys) });
  }
  if (guards.length) {
    return {
      patches: [],
      guards,
      reason: `守卫命中（${guards.map((g) => g.id).join('+')}）：不出处方。${guards.map((g) => g.reason).join('；')}`,
    };
  }

  for (const id of ['R1', 'R2', 'R3', 'R4', 'R7', 'R8', 'R9', 'R10', 'R11', 'R12', 'R13', 'R14', 'R15', 'R16', 'R17']) {
    const rule = RULES[id];
    if (rule.condition(m)) {
      patches.push({
        id: rule.id,
        knob: rule.knob,
        delta: rule.delta,
        risk: rule.risk,
        label: rule.label,
        evidence: pick(m, rule.evidence_keys),
      });
    }
  }

  return {
    patches,
    guards,
    reason: patches.length
      ? `命中规则 ${patches.map((p) => p.id).join('+')}：${patches.map((p) => p.label).join('；')}`
      : '未命中出方规则，无需调整',
  };
}

function pick(m, keys) {
  const out = {};
  for (const k of keys) if (k in m) out[k] = m[k];
  return out;
}