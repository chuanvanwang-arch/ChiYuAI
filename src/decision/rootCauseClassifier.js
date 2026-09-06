// src/decision/rootCauseClassifier.js — 七类根因归因分类器（T27，纯函数）+ 6.1 DB 写回
// 输入 input = { feedback, attribution, particleChecks }
//   feedback:        { usable:bool, major_deviation:bool }
//   attribution:     { required_fill?: { missing?: string[] }, edge_compliance?: { [edgeType]: 'present'|'missing' } }
//   particleChecks:  { field_mismatch?:bool, info_incomplete?:bool, input_stale?:bool }
// 输出: { code, layer, severity, knob, name, evidence: string[] }
// 分类树（命中即止）：R0(usable=false & major) → R1(usable=false) → R2(usable) → R3(unknown)
// 6.1 附加：persistRootCause 把分类结果写回 decision.root_cause JSONB（幂等 UPDATE，不物理删）
import { queryWrite } from '../db.js';

export const ROOT_CAUSES = {
  FIELD_MISMATCH:          { code: 'FIELD_MISMATCH',          layer: '粒子库',     knob: 'META_ATTR_MAP',        name: '字段不一致' },
  INFO_INCOMPLETE:         { code: 'INFO_INCOMPLETE',         layer: '粒子库/K',   knob: 'PARTICLE_ATTR_ADD',     name: '信息不完整' },
  INPUT_STALE:             { code: 'INPUT_STALE',             layer: '粒子库',     knob: 'SOURCE_REFRESH',        name: '输入不及时' },
  DIM_MISSING:             { code: 'DIM_MISSING',             layer: 'M/seven-dim',knob: 'REQUIRED_DIMS',         name: '维度不对/缺维度' },
  EDGE_MISSING:            { code: 'EDGE_MISSING',            layer: 'M/edge_bindings', knob: 'EDGE_BINDING',     name: '边选择不对' },
  NEED_DIM_ORDER:          { code: 'NEED_DIM_ORDER',          layer: 'M/K',        knob: 'DIM_ORDER',             name: '优化次序/补齐维度' },
  DATA_QUALITY_PRECEDENT:  { code: 'DATA_QUALITY_PRECEDENT',  layer: 'K',          knob: 'PRECEDENT_DISTILL',     name: '数据质量·参考先例/标杆' },
  UNKNOWN:                 { code: 'UNKNOWN',                 layer: '?',          knob: null,                     name: '未知/正向' },
};

function lMissing(attribution) {
  return ((attribution && attribution.required_fill && attribution.required_fill.missing) || []).length > 0;
}
function eMissing(attribution) {
  // T29 语义对齐（设计 §5）：edge_compliance = 「E1-E7 应存/实存/缺」三元组。
  //   E 缺 = 应连未连（required_missing 显式非空）；无该字段 = 未提供 E 缺证据 → 不判 E 缺。
  //   旧投影（Object.values.some(s==='missing')）已废弃：它把「未连可选边」误当根因证据，
  //   导致全齐决策被误判 EDGE_MISSING（见 attribution.js hasRealEdgeMissing 同序修正）。
  const ec = (attribution && attribution.edge_compliance) || {};
  return Array.isArray(ec?.required_missing) && ec.required_missing.length > 0;
}

export function classifyRootCause(input = {}) {
  const fb = input.feedback || {};
  const attr = input.attribution || {};
  const pc = input.particleChecks || {};

  const hasFeedback = (fb.usable !== undefined) || (fb.major_deviation !== undefined);
  const usable = fb.usable === true;
  const major = fb.major_deviation === true;

  // R3 未知：完全无反馈信号 → 无法判定，进人工归因队列
  if (!hasFeedback) {
    return { ...ROOT_CAUSES.UNKNOWN, severity: 'unknown', evidence: ['无明确反馈信号'] };
  }

  // R2 正向强化：业务可用且非重大偏差 → 无需干预
  if (usable && !major) {
    return { ...ROOT_CAUSES.UNKNOWN, severity: 'none', evidence: ['业务可用且非重大偏差：正向强化，无根因干预'] };
  }

  // R0 / R1：usable=false（含显式 false 或非 true）
  if (!usable) {
    const severity = major ? 'major' : 'minor';
    if (pc.field_mismatch) return { ...ROOT_CAUSES.FIELD_MISMATCH, severity, evidence: ['usable=false', 'field_mismatch=true'] };
    if (pc.info_incomplete) return { ...ROOT_CAUSES.INFO_INCOMPLETE, severity, evidence: ['usable=false', 'info_incomplete=true'] };
    if (pc.input_stale) return { ...ROOT_CAUSES.INPUT_STALE, severity, evidence: ['usable=false', 'input_stale=true'] };
    if (lMissing(attr)) return { ...ROOT_CAUSES.DIM_MISSING, severity, evidence: ['usable=false', 'L 维度缺失'] };
    if (eMissing(attr)) return { ...ROOT_CAUSES.EDGE_MISSING, severity, evidence: ['usable=false', 'E 边缺失'] };
    if (major) return { ...ROOT_CAUSES.DATA_QUALITY_PRECEDENT, severity, evidence: ['usable=false', 'major_deviation=true', 'L+E 全齐但参考先例/标杆污染'] };
    return { ...ROOT_CAUSES.NEED_DIM_ORDER, severity, evidence: ['usable=false', '非重大', '疑似优化次序/补齐维度'] };
  }

  // 其余（反馈信号异常）→ UNKNOWN
  return { ...ROOT_CAUSES.UNKNOWN, severity: 'unknown', evidence: ['反馈信号不足'] };
}

// 6.1 DB 写回：把分类结果（纯函数输出）落 decision.root_cause JSONB（幂等 UPDATE，不物理删）
// 纪律：写操作经决策第0闸的写通道（此处为已存在决策行的根因补写，不新建决策）
export async function persistRootCause(decisionId, classification) {
  if (!decisionId) throw new Error('persistRootCause 需要 decision_id');
  if (!classification || !classification.code) throw new Error('classification 缺少 code');
  const r = await queryWrite(
    `UPDATE crm.decision SET root_cause=$2::jsonb, updated_at=now() WHERE decision_id=$1`,
    [decisionId, JSON.stringify(classification)]
  );
  return { ok: r.rowCount > 0, decision_id: decisionId, code: classification.code };
}
