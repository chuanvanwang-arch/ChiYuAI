// src/portal/agentsPage.js — /agents 监控台纯渲染函数（node + 浏览器共用 ESM）
const ASSERTIONS = ['permission_closure', 'action_in_registry', 'derived_from', 'kg_ready', 'l3_stated_but_kg_degraded', 'kg_target_convergence', 'skill_validated', 'evaluator_ready'];
const ASSERTION_LABEL = {
  permission_closure: '权限闭包', action_in_registry: 'Action在册', derived_from: '溯源存在',
  kg_ready: 'KG就绪', l3_stated_but_kg_degraded: 'L3降级守护', kg_target_convergence: 'L3收敛闸门', skill_validated: 'SKILL校验', evaluator_ready: '评估器就绪',
};

export function agentAssemblyOk(results) {
  if (!Array.isArray(results) || results.length === 0) return false;
  return results.every(r => r.ok);
}

function isDegraded(detail) {
  return typeof detail === 'string' && detail.startsWith('degraded:');
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function renderAgentCard(agentId, data) {
  const spec = data.specs?.[agentId] || {};
  const results = (data.assembly?.results || []).filter(r => r.agent === agentId);
  const ok = agentAssemblyOk(results);
  const autonomy = esc(spec.autonomy || '');
  const chips = ASSERTIONS.map(a => {
    const r = results.find(x => x.assertion === a) || {};
    const pass = r.ok;
    const degraded = isDegraded(r.detail);
    const cls = pass ? (degraded ? 'warn' : 'ok') : 'fail';
    const label = ASSERTION_LABEL[a] || a;
    const tip = esc(r.detail || '');
    return `<span class="chip ${cls}" data-assertion="${a}" title="${tip}">${label}${degraded ? ' ⚠' : ''}</span>`;
  }).join('');
  const actions = (spec.actions || []).map(esc).join('、') || '—';
  const derived = esc(spec.derivedFrom || '—');
  return `<div class="gate" data-section="agent">
    <h3>${esc(spec.name || agentId)} <span class="badge ${ok ? 'ok' : 'fail'}">${ok ? '装配通过' : '装配失败'}</span></h3>
    <div class="stage">autonomy: ${autonomy} · derivedFrom: ${derived}</div>
    <div class="chips">${chips}</div>
    <div class="metrics">
      <span class="metric">actions <b>${spec.actionCount ?? 0}</b></span>
      <span class="metric">skillCalls <b>${spec.skillCallCount ?? 0}</b></span>
    </div>
    <div class="actions">能力: ${actions}</div>
  </div>`;
}

export function renderAgents(data = {}) {
  const agents = data.agents || [];
  const overallOk = data.assembly?.ok !== false;
  const failedCount = (data.assembly?.failed || []).length;
  const health = (data.health?.domains || []).map(d => `<span class="chip ok">${esc(d)}</span>`).join('') || '<span class="chip">无</span>';
  const cards = agents.length
    ? agents.map(id => renderAgentCard(id, data)).join('')
    : '<div class="empty">无智能体</div>';
  return `<div class="statusbar">
    <span class="badge ${overallOk ? 'ok' : 'fail'}">总装配 ${overallOk ? '通过' : '失败'}</span>
    <span>智能体 <b>${agents.length}</b> · 失败断言 <b>${failedCount}</b></span>
    <span class="health">事件域: ${health}</span>
  </div>
  <div class="gates">${cards}</div>`;
}

// 决策可审计性 SLA 卡片（消费 /api/monitor/auditability 聚合；G 系列问责闭环平台级指标）
export function renderAuditabilitySla(data = {}) {
  if (!data || data.auditability_pct == null) {
    return `<div class="gate" data-section="auditability-sla">
      <h3>决策可审计性 SLA <span class="badge warn">无数据</span></h3>
      <div class="stage">窗口内无已评分决策</div>
    </div>`;
  }
  const pct = data.auditability_pct;
  const pctCls = pct >= 90 ? 'ok' : pct >= 70 ? 'warn' : 'fail';
  const ps = data.per_status || {};
  const qRows = ['Q1', 'Q2', 'Q3', 'Q4'].map((q) => {
    const s = ps[q] || { pass: 0, warn: 0, fail: 0 };
    return `<div class="sla-q"><span class="sla-qk">${esc(q)}</span>
      <span class="chip ${s.pass ? 'ok' : ''}">通过 ${s.pass}</span>
      <span class="chip ${s.warn ? 'warn' : ''}">降级 ${s.warn}</span>
      <span class="chip ${s.fail ? 'fail' : ''}">失败 ${s.fail}</span></div>`;
  }).join('');
  return `<div class="gate" data-section="auditability-sla">
    <h3>决策可审计性 SLA <span class="badge ${pctCls}">${pct}%</span></h3>
    <div class="stage">近 ${data.window} 条决策 · 已评分 ${data.scored}</div>
    <div class="metrics">
      <span class="metric">满分(4/4) <b>${data.full}</b></span>
      <span class="metric">待裁决冲突 <b>${data.with_conflict}</b></span>
      <span class="metric">溯源链篡改 <b>${data.tampered}</b></span>
    </div>
    <div class="sla-qs">${qRows}</div>
  </div>`;
}
