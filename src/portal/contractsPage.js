// src/portal/contractsPage.js — /agents 契约监测区纯渲染（浏览器 ESM；零服务端 import）
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderTask(t) {
  const st = t.static || {};
  const skillsChips = (t.skills || [])
    .map((s) => `<span class="chip ${st.skills_aligned ? 'ok' : 'fail'}" title="${esc((st.skills_issues || []).join('; '))}">${esc(s)}</span>`)
    .join('');
  const memChips = (t.memory || [])
    .map((m) => `<span class="chip ${st.memory_aligned ? 'ok' : 'fail'}" title="${esc((st.memory_issues || []).join('; '))}">${esc(m)}</span>`)
    .join('');
  const fb = t.feedback || [];
  const fbRows = fb.length
    ? fb.map((f) => `<li class="fb fb-${esc(f.status)}">[${esc(f.gap_type)}] ${esc(f.severity)} · ${esc(f.status)} — ${esc(f.observed || '')}</li>`).join('')
    : '<li class="fb-empty">无记录</li>';
  const probeBtn = t.probe ? `<button class="btn probe" data-doc="${esc(t.doc_path)}" data-task="${esc(t.task)}">运行探针</button>` : '';
  return `<div class="contract-task" data-doc="${esc(t.doc_path)}" data-task="${esc(t.task)}">
    <div class="ct-head"><b>${esc(t.task)}</b> <span class="agent-tag">${esc(t.agent)}</span></div>
    <div class="ct-line">skills: <span class="chips">${skillsChips}</span></div>
    <div class="ct-line">memory: <span class="chips">${memChips}</span></div>
    ${t.success ? `<div class="ct-line success">✓ ${esc(t.success)}</div>` : ''}
    <ul class="fb-list">${fbRows}</ul>
    <div class="ct-actions">${probeBtn}<button class="btn gap" data-doc="${esc(t.doc_path)}" data-task="${esc(t.task)}">记录缺口</button></div>
  </div>`;
}

export function renderContracts(data = {}) {
  const docs = data.docs || [];
  if (!docs.length) return '<div class="empty">未解析到含 contract-yaml 的设计文档</div>';
  return docs.map((d) => {
    const tasks = (d.tasks || []).map(renderTask).join('');
    return `<section class="contract-doc"><h3 class="doc-title">${esc(d.doc_path)}</h3><div class="contract-tasks">${tasks}</div></section>`;
  }).join('');
}
