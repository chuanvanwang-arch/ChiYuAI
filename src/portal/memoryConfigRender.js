// src/portal/memoryConfigRender.js — 记忆/先例管理（第 26 项）渲染纯函数子模块
// 浏览器 ESM 可加载（零服务端 import）。服务端 Router 在 memoryConfig.js。
// 数据事实：memory_log（流水）/ memory_note（常驻）/ memory_snapshot（不可变）
//          / decision_precedent_rel（先例相似度网络）
// 红线：禁删（只读 + 蒸馏置 archived）；无写入表单（residue 铁律）
export const LOG_LAYERS = ['L-Workspace', 'L-User', 'L-Cloud'];
export const LOG_KINDS = ['decision', 'event', 'evidence', 'followup', 'note'];

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const fmt = (d) => (d ? new Date(d).toLocaleString?.() || '' : '—');

export function memorySummary(logs = [], notes = [], snaps = []) {
  return {
    logs: logs.length,
    distilled: logs.filter((l) => l.distilled).length,
    archivedLogs: logs.filter((l) => l.archived).length,
    notes: notes.length,
    snapshots: snaps.length,
  };
}

export function renderMemoryLogs(logs = [], { q } = {}) {
  if (!logs.length) return '<div class="mem-empty">无记忆日志（业务事件自动捕获，禁手写）</div>';
  const rows = logs
    .map((l) => `<tr class="log-row" data-id="${esc(l.id)}">
      <td class="mem-mem-mono">${esc(l.topic)}</td>
      <td>${esc(l.kind || '')}</td>
      <td>${esc(l.layer || '')}</td>
      <td>${esc(l.actor || '—')}</td>
      <td>${esc(l.event_type || '')}</td>
      <td>${l.distilled ? '<span class="badge ok">已蒸馏</span>' : ''} ${l.archived ? '<span class="badge off">已归档</span>' : ''}</td>
      <td class="mem-mono">${fmt(l.created_at)}</td>
    </tr>`).join('');
  return `<table class="mem-tbl"><thead><tr><th>topic</th><th>kind</th><th>layer</th><th>actor</th><th>事件</th><th>状态</th><th>时间</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

export function renderMemoryNotes(notes = []) {
  if (!notes.length) return '<div class="mem-empty">无常驻笔记</div>';
  const rows = notes.map((n) => `<tr class="note-row">
    <td>${esc(n.layer || '')}</td>
    <td>${esc(n.topic)}</td>
    <td class="mem-mono">${esc(JSON.stringify(n.content))}</td>
    <td>${n.archived ? '<span class="badge off">已归档</span>' : '<span class="badge ok">活跃</span>'}</td>
    <td class="mem-mono">${fmt(n.updated_at)}</td>
  </tr>`).join('');
  return `<table class="mem-tbl"><thead><tr><th>layer</th><th>topic</th><th>内容</th><th>状态</th><th>更新时间</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

export function renderMemorySnapshots(snaps = []) {
  if (!snaps.length) return '<div class="mem-empty">无不可变快照</div>';
  const rows = snaps.map((s) => `<tr class="snap-row" data-id="${esc(s.id)}">
    <td>${esc(s.topic)}</td>
    <td class="mem-mono">${esc(s.ref_id || '—')}</td>
    <td class="mem-mono">${esc(String(s.id).slice(0, 8))}</td>
    <td class="mem-mono">${fmt(s.created_at)}</td>
  </tr>`).join('');
  return `<table class="mem-tbl"><thead><tr><th>topic</th><th>ref_id</th><th>快照</th><th>时间</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

export function renderPrecedentPanel(precs = []) {
  if (!precs.length) return '<div class="mem-empty">无先例引用（决策自动镜像）</div>';
  const rows = precs.map((p) => `<tr class="prec-row">
    <td class="mem-mono">${esc(p.precedent_id)}</td>
    <td><div class="sim-bar"><span style="width:${Math.min(100, Math.round((p.similarity || 0) * 100))}%"></span></div></td>
    <td class="mem-mono">${Math.round((p.similarity || 0) * 100)}%</td>
    <td>${p.referenced_times ?? 0} 次</td>
  </tr>`).join('');
  return `<table class="mem-tbl"><thead><tr><th>先例决策</th><th>相似度</th><th>%</th><th>被引用</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

export function renderDistillPanel(res = {}) {
  const n = res.wouldDistill ?? res.distilled ?? 0;
  const dry = res.dryRun;
  return `<div class="mem-distill-panel">
    <p class="mem-muted">${dry ? `预检：待蒸馏 ${n} 条流水` : `蒸馏完成：${n} 条流水标记 distilled（原始行保留）`}</p>
    <p class="mem-muted">蒸馏=标 distilled 非删除 · 30 天周期 · 写经决策第 0 闸</p>
  </div>`;
}