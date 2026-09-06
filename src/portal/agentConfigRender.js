// src/portal/agentConfigRender.js — /agent-config 智能体配置页纯渲染函数（node + 浏览器共用 ESM）
// 铁律（本会话 QA 根因 A 教训）：本文件零服务端 import，仅纯函数，浏览器可原生 ESM 加载。
// 服务端 Router 在 agentConfig.js（独立文件），渲染与路由严格分文件。

const SIX_SEGMENTS = [
  ['identity', '身份'],
  ['capabilities', '能力'],
  ['context', '上下文'],
  ['memory', '记忆'],
  ['evaluation', '评估'],
  ['governance', '治理'],
];

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function isDegraded(detail) {
  return typeof detail === 'string' && detail.startsWith('degraded:');
}

export function agentOk(results) {
  if (!Array.isArray(results) || results.length === 0) return false;
  return results.every(r => r.ok);
}

function kv(rows) {
  if (!rows || !Object.keys(rows).length) return '<div class="pg-empty">—</div>';
  return '<table class="pg-subtable">' + Object.entries(rows).map(([k, v]) =>
    `<tr><td class="pg-k">${esc(k)}</td><td>${esc(Array.isArray(v) ? v.join(', ') : v)}</td></tr>`).join('') + '</table>';
}

export function renderAgentCard(spec, fallbackId) {
  if (!spec) return '';
  // 卡片标题优先取 agents 数组权威 id（/api/agents 响应 agents: Object.keys(agentSpecs)），
  // spec.identity.name 仅兜底——避免同源 spec 复用导致卡片重名。
  const id = fallbackId || spec.identity?.name || 'agent';
  const bars = SIX_SEGMENTS.map(([key, label]) => {
    let body;
    if (key === 'capabilities') {
      const cap = spec.capabilities || {};
      body = `<div class="pg-k">Actions（${(cap.actions || []).length}）</div>
        <div class="pg-chips">${(cap.actions || []).map(a => `<span class="chip">${esc(a)}</span>`).join('') || '<span class="pg-empty">无</span>'}</div>
        <div class="pg-k">SkillCalls（${(cap.skillCalls || []).length}）</div>
        <div class="pg-chips">${(cap.skillCalls || []).map(s => `<span class="chip">${esc(s)}</span>`).join('') || '<span class="pg-empty">无</span>'}</div>
        <div class="pg-k">知识范围</div>${kv(cap.knowledgeScope)}`;
    } else if (key === 'identity') {
      const idn = spec.identity || {};
      body = `<table class="pg-subtable">
        <tr><td class="pg-k">名称</td><td>${esc(idn.name || '')}</td></tr>
        <tr><td class="pg-k">溯源</td><td>${esc(idn.derivedFrom || '')}</td></tr>
        <tr><td class="pg-k">自主度</td><td>${esc(idn.autonomy || '')}</td></tr>
      </table>`;
    } else {
      body = kv(spec[key]);
    }
    return `<div class="pg-seg"><div class="pg-seg-title">${label}</div>${body}</div>`;
  }).join('');
  return `<div class="pg-card" id="agent-${esc(id)}">
    <h3>${esc(id)}</h3>
    <div class="pg-meta">自主度 ${esc(spec.identity?.autonomy || '—')}</div>
    ${bars}
  </div>`;
}

export function renderAssembly(assembly) {
  if (!Array.isArray(assembly) || assembly.length === 0) return '';
  const rows = assembly.map(r => {
    const cls = r.ok ? 'chip ok' : 'chip fail';
    const deg = isDegraded(r.detail) ? ' ⚠' : '';
    return `<span class="${cls}" title="${esc(r.detail || '')}">${esc(r.assertion)}${deg}</span>`;
  }).join('');
  return `<div class="pg-assembly">六条装配断言：${rows}</div>`;
}

export function renderAgentConfig(data) {
  const agents = Array.isArray(data?.agents) ? data.agents : [];
  const specs = data?.specs || {};
  const assembly = Array.isArray(data?.assembly) ? data.assembly : [];
  if (agents.length === 0) {
    return `<div class="pg-empty">暂无智能体配置</div>`;
  }
  const cards = agents.map(a => renderAgentCard(specs[a] || { identity: { name: a }, capabilities: {} }, a)).join('');
  return `<div class="pg-page">${renderAssembly(assembly)}<div class="pg-grid">${cards}</div></div>`;
}