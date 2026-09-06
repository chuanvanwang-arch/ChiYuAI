// src/portal/calibrationRender.js — 校准页签渲染（纯函数 · 浏览器安全）
// 设计依据：docs/2026-08-28-decision-quality-calibration-design.md §7（已批准）
// 硬约束：禁止 import 任何服务端模块（src/db.js / src/calibration/*.js 等）——
//   /portal/*.js 不在静态托管目录，服务端模块路径会 404 → 整个 module script 静默失败。
// 数据形状：与后端 JSON 直接对齐——
//   metrics: /api/calibration/attribution.metrics（computeMetrics 输出）
//   attribution: { patches:[{id,knob,delta,risk,label,evidence}], guards:[{id,reason,evidence}], reason }
//   patch(DB 行): { patch_id, knob, target, from_value, to_value, evidence, expected_impact, risk, status }
const _esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const _pct = (x) => (x == null ? '—' : `${(Number(x) * 100).toFixed(1)}%`);
const _num = (x) => (x == null ? '—' : String(x));
const _dur = (ms) => (ms == null ? '—' : `${(ms / 3600000).toFixed(1)} h`);

const KNOB_LABEL = { threshold: '自主阈值', weight: '置信权重', required_dims: '七维严格度' };

export function renderMetricCards(m = {}) {
  const warn = m.sufficient_sample
    ? ''
    : `<div class="cal-warn">样本不足（${_num(m.sample_size)} &lt; 20）：指标仅供观察，不产生处方</div>`;
  const card = (label, value, hint = '') =>
    `<div class="cal-card"><div class="cal-card-v">${value}</div><div class="cal-card-l">${label}</div>${
      hint ? `<div class="cal-card-h">${hint}</div>` : ''}</div>`;
  return `<div class="cal-cards">${warn}
    ${card('自主决策覆写率', _pct(m.autonomy_override_rate), '核心质量指标')}
    ${card('升级率', _pct(m.escalate_rate))}
    ${card('升级件改判率', _pct(m.escalated_override_rate))}
    ${card('升级疲劳率', _pct(m.escalation_fatigue_rate), '超时未处置')}
    ${card('人工延迟 p50', _dur(m.human_latency_p50_ms))}
    ${card('先例覆盖率', _pct(m.precedent_coverage_avg))}
    ${card('样本量', _num(m.sample_size))}
  </div>`;
}

export function renderAttribution(att = {}) {
  const { patches = [], guards = [] } = att;
  if (guards.length) {
    const items = guards.map((g) =>
      `<li><code>${_esc(g.id)}</code> ${_esc(g.reason || '')}</li>`).join('');
    return `<div class="cal-block"><h3>归因</h3><div class="cal-blocked">不出方：</div><ul>${items}</ul></div>`;
  }
  if (!patches.length) {
    return `<div class="cal-block"><h3>归因</h3><div class="cal-muted">${_esc(att.reason || '无规则命中（当前指标处于可接受区间）')}</div></div>`;
  }
  const items = patches.map((p) =>
    `<li><code>${_esc(p.id)}</code> ${_esc(p.label || p.reason || '')}</li>`).join('');
  return `<div class="cal-block"><h3>归因（命中规则）</h3><ul>${items}</ul></div>`;
}

export function renderPatchCard(p = {}) {
  const from = p.from_value !== undefined ? p.from_value : p.from;
  const to = p.to_value !== undefined ? p.to_value : p.to;
  const target = p.target || (p.delta && p.delta.weights ? Object.keys(p.delta.weights)[0] : null);
  const knob = `${KNOB_LABEL[p.knob] || p.knob}${target ? ` · ${_esc(target)}` : ''}`;
  const fmtVal = (o) => {
    if (!o || typeof o !== 'object') return _esc(JSON.stringify(o ?? null));
    if (o.threshold !== undefined) return _esc(String(o.threshold));
    if (o.weights) return _esc(String(Object.values(o.weights)[0]));
    return _esc(JSON.stringify(o));
  };
  const imp = p.expected_impact || {};
  const impact = imp.sample_size == null ? '' :
    (imp.estimated_block_rate != null
      ? `<div class="cal-impact">预期影响：七维预估拦截率 <b>${_pct(imp.estimated_block_rate)}</b>（Δ ${_pct(imp.estimated_block_rate_delta || 0)}），样本 ${imp.sample_size}</div>`
      : `<div class="cal-impact">预期影响：自主 ${_num(imp.autonomy_before)} → <b>${_num(imp.autonomy_after)}</b>，${
        imp.escalated_before != null ? `升级 ${_num(imp.escalated_before)} → <b>${_num(imp.escalated_after)}</b>，` : ''}${
        imp.estimated_override_rate == null ? '' : `预估覆写率 ${_pct(imp.estimated_override_rate)}（估算，非承诺）`}</div>`);
  const acts = p.status === 'PENDING'
    ? `<button data-cal-approve="${_esc(p.patch_id || p.id || '')}">批准</button>
       <button data-cal-reject="${_esc(p.patch_id || p.id || '')}">驳回</button>`
    : p.status === 'APPLIED'
    ? `<button data-cal-rollback="${_esc(p.patch_id || p.id || '')}">回滚</button>`
    : '';
  const ev = p.evidence || {};
  return `<div class="cal-patch cal-risk-${_esc(String(p.risk || 'LOW').toLowerCase())}" data-patch="${_esc(p.patch_id || p.id || '')}" data-risk="${_esc(String(p.risk || 'LOW').toUpperCase())}">
    <div class="cal-patch-head"><b>${knob}</b>
      <span class="cal-mono">${fmtVal(from)} → ${fmtVal(to)}</span>
      <span class="cal-tag">${_esc(p.risk || 'LOW')}</span>
      <span class="cal-tag">${_esc(p.status || '')}</span>
    </div>
    <div class="cal-muted">规则 <code>${_esc(ev.rule_id || p.id || '')}</code>：${_esc(ev.reason || p.label || p.reason || '')}</div>
    ${impact}
    <div class="cal-actions">${acts}</div>
  </div>`;
}

export function renderHistory(rows = []) {
  if (!rows.length) return `<div class="cal-block"><h3>历史</h3><div class="cal-muted">尚无已应用/已回滚处方</div></div>`;
  return `<div class="cal-block"><h3>历史（已应用 / 已回滚）</h3>${
    rows.map(renderPatchCard).join('')}</div>`;
}

export function renderCalibration(data = {}, patchList = []) {
  const { metrics = {}, attribution = { patches: [], guards: [] } } = data;
  const list = Array.isArray(patchList) ? patchList : [];
  const pending = list.filter((p) => p.status === 'PENDING');
  const done = list.filter((p) => ['APPLIED', 'ROLLED_BACK'].includes(p.status));
  return `<h3>决策质量校准</h3>
    ${renderMetricCards(metrics)}
    ${renderAttribution(attribution)}
    <div class="cal-block"><h3>待审处方（${pending.length}）</h3>
      ${pending.length ? pending.map(renderPatchCard).join('') : '<div class="cal-muted">无待审处方</div>'}
    </div>
    ${renderHistory(done)}`;
}

export default { renderMetricCards, renderAttribution, renderPatchCard, renderHistory, renderCalibration };