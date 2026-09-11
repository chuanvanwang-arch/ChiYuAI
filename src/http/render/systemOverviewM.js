// src/http/render/systemOverviewM.js — 记忆系统监控仪表盘（只读，含权限隔离）
//
// 权限：非 admin → 仅显「权限不足」+ 登录提示（设计 §1.4，不降级为可读）。
// 看板范式：①顶部状态 ②近30日趋势 ③图模型（先例节点 ↔ 决策节点，REFERENCED_PRECEDENT 边）
//          ④三构件计数 + 蒸馏状态 ⑤点节点下钻明细
// 图渲染：原生 SVG（无第三方库），取色用 CSS 变量（禁硬编码 hex），复用 decision-graph.html 范式。
import { query } from '../../db.js';
import { getTrendSamples, renderTrendChart } from './systemOverviewShared.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const kv = (label, val, cls = '') => `<div class="so-dl-row"><dt>${esc(label)}</dt><dd class="${cls}">${val}</dd></div>`;
const trunc = (s, n = 22) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + '…' : s; };

function renderForbidden(me) {
  return `<section class="pg-section so-m-forbidden">
    <h3>记忆系统·权限说明</h3>
    <p>本页为记忆治理只读视图，<b>仅管理员（sysadmin / admin）可访问</b>（当前账号 ${esc(me?.role || 'guest')} 无该权限）。</p>
    <p>记忆仍由业务事件自动捕获并在系统中流转；其闭环进度可在
      <a href="/sales-decision-monitor.html">销售决策监控台 · 三闭环条 · 记忆系统</a> 查看。
    </p>
    <p class="dn-note">请以 admin 身份登录后查看「图模型」视图（先例 ↔ 决策引用关系）。</p>
  </section>`;
}

async function safeCounts() {
  try {
    const r = await query(`
      SELECT
        (SELECT COUNT(*) FROM crm.memory_log WHERE archived=false) AS logs,
        (SELECT COUNT(*) FROM crm.memory_note WHERE archived=false) AS notes,
        (SELECT COUNT(*) FROM crm.memory_snapshot) AS snapshots
    `);
    return r.rows?.[0] || { logs: 0, notes: 0, snapshots: 0 };
  } catch { return { logs: 0, notes: 0, snapshots: 0 }; }
}

async function safePrecedentEdges() {
  try {
    const r = await query(`
      SELECT COUNT(*)::int AS n
      FROM crm.decision d,
           jsonb_array_elements(COALESCE(d.referenced_precedents, '[]'::jsonb)) pe
      WHERE d.created_at > NOW() - INTERVAL '30 days'
    `);
    return Number(r.rows?.[0]?.n ?? 0);
  } catch { return 0; }
}

async function safePrecedentTop(limit = 10) {
  try {
    const r = await query(`
      SELECT pe ->> 'precedent_id' AS precedent_id, COUNT(*)::int AS n
      FROM crm.decision d,
           jsonb_array_elements(COALESCE(d.referenced_precedents, '[]'::jsonb)) pe
      GROUP BY 1 ORDER BY n DESC LIMIT $1
    `, [limit]);
    return r.rows || [];
  } catch { return []; }
}

async function safePrecedentRefMap() {
  try {
    const r = await query(`
      SELECT d.decision_id,
             jsonb_array_elements(COALESCE(d.referenced_precedents, '[]'::jsonb)) ->> 'precedent_id' AS pid
      FROM crm.decision d
      WHERE d.referenced_precedents IS NOT NULL
    `);
    const map = {}; const inv = {};
    for (const row of r.rows || []) {
      const pid = row.pid; if (!pid) continue;
      (map[pid] = map[pid] || []).push(row.decision_id);
      (inv[row.decision_id] = inv[row.decision_id] || []).push(pid);
    }
    return { map, inv };
  } catch { return { map: {}, inv: {} }; }
}

async function safeDistill() {
  try {
    const r = await query(
      `SELECT count(*)::int AS n FROM crm.memory_log
       WHERE archived=false AND distilled=false AND created_at < now() - '30 days'::interval`
    );
    return Number(r.rows?.[0]?.n ?? 0);
  } catch { return 0; }
}

function renderTrendSvg(values) {
  return renderTrendChart(values, { label: '近 30 日先例引用趋势', trendId: 'memory-30d', stroke: 'var(--ok)' });
}

function renderTopState(edges) {
  const closed = edges > 0;
  const cls = closed ? 'closed' : 'break';
  const text = closed ? '已闭环' : '断点';
  return `<div class="loop-head">
      <span class="loop-dot memory"></span><span class="loop-name">记忆系统·顶部状态</span>
      <span class="loop-state ${cls}">${text}</span>
    </div>
    <div class="loop-desc">决策图引用先例边 <b>${edges}</b> 条（REFERENCED_PRECEDENT → 记忆→决策闭环）。</div>`;
}

function renderTriSection(c) {
  return `<section class="pg-section so-m-tri">
    <h3>三构件计数</h3>
    <table class="pg-table">
      <tr><th>构件</th><th>计数</th><th>说明</th></tr>
      <tr><td>memory_log</td><td>${c.logs}</td><td>append-only 流水</td></tr>
      <tr><td>memory_note</td><td>${c.notes}</td><td>常驻笔记</td></tr>
      <tr><td>memory_snapshot</td><td>${c.snapshots}</td><td>不可变快照</td></tr>
    </table>
  </section>`;
}

function renderPrecedentDetail(pid, n, refs) {
  const refList = refs.length
    ? `<ul class="so-ref-list">${refs.map((d) => `<li><a href="/decision-graph.html?decision=${encodeURIComponent(d)}" target="_blank">${esc(d)}</a></li>`).join('')}</ul>`
    : '<p class="dn-note">无关联决策记录。</p>';
  return `<dl class="so-dl">
    ${kv('precedent_id', esc(pid || '—'))}
    ${kv('被引用次数', String(n))}
    ${kv('关联决策数', String(refs.length))}
  </dl>
  <h4 class="so-d-sub">引用该先例的决策</h4>
  ${refList}`;
}

function renderDecisionDetail(did, pids) {
  const list = pids.length
    ? `<ul class="so-ref-list">${pids.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>`
    : '<p class="dn-note">未引用任何先例。</p>';
  return `<dl class="so-dl">
    ${kv('decision_id', esc(did || '—'))}
    ${kv('引用先例数', String(pids.length))}
  </dl>
  <h4 class="so-d-sub">该决策引用的先例</h4>
  ${list}`;
}

function renderGraph(top, refMap, invMap) {
  const precedents = (top || []).slice(0, 10);
  if (!precedents.length) return '<div class="dn-empty">暂无先例引用边，图模型为空。</div>';
  const pids = precedents.map((p) => p.precedent_id);
  const decSet = new Set();
  for (const pid of pids) for (const d of (refMap[pid] || [])) decSet.add(d);
  const decisions = [...decSet].slice(0, 28);
  const decIdx = new Map(decisions.map((d, i) => [d, i]));

  const W = 660, rowH = 44, pad = 26;
  const rows = Math.max(precedents.length, decisions.length);
  const H = pad * 2 + rows * rowH;
  const px = 140, dx = 520;
  const yOf = (i) => pad + i * rowH + rowH / 2;

  let edgesSvg = '';
  precedents.forEach((p, i) => {
    const py = yOf(i);
    for (const d of (refMap[p.precedent_id] || [])) {
      const j = decIdx.get(d); if (j == null) continue;
      const dy = yOf(j);
      edgesSvg += `<line x1="${px}" y1="${py}" x2="${dx}" y2="${dy}" stroke="var(--ok)" stroke-width="1.4" opacity="0.5"/>`;
    }
  });

  let pNodes = '';
  precedents.forEach((p, i) => {
    const y = yOf(i);
    pNodes += `<g class="so-m-graph-node" data-dk="${esc(p.precedent_id)}" data-drill-title="先例 ${esc(p.precedent_id)}" style="cursor:pointer">
      <circle cx="${px}" cy="${y}" r="9" fill="var(--ok)"></circle>
      <text x="${px - 16}" y="${y + 3}" text-anchor="end" font-size="10" font-weight="600" fill="var(--ink)" stroke="var(--panel)" stroke-width="3" paint-order="stroke">${esc(trunc(p.precedent_id))}</text>
    </g>`;
  });
  let dNodes = '';
  decisions.forEach((d, j) => {
    const y = yOf(j);
    dNodes += `<g class="so-m-graph-node" data-dk="${esc(d)}" data-drill-title="决策 ${esc(d)}" style="cursor:pointer">
      <circle cx="${dx}" cy="${y}" r="9" fill="var(--ac)"></circle>
      <text x="${dx + 16}" y="${y + 3}" text-anchor="start" font-size="10" font-weight="600" fill="var(--ink)" stroke="var(--panel)" stroke-width="3" paint-order="stroke">${esc(trunc(d))}</text>
    </g>`;
  });

  return `<div class="so-m-graph-wrap">
    <div class="so-graph-legend"><span class="dot ok"></span>先例节点 <span class="dot ac"></span>决策节点 <span class="line"></span>REFERENCED_PRECEDENT</div>
    <svg class="so-m-graph" viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet" role="img" aria-label="记忆系统图模型：先例与决策引用关系">
      ${edgesSvg}${pNodes}${dNodes}
    </svg>
  </div>`;
}

function renderDistill(n) {
  const cls = n > 0 ? 'warn' : 'ok';
  const text = n > 0 ? `<b>${n}</b> 条待蒸馏（>30 天未蒸馏）` : '无需蒸馏';
  return `<section class="pg-section so-m-distill">
    <h3>蒸馏状态（30 天窗口）</h3>
    <p><span class="badge ${cls}">${text}</span></p>
    <p class="dn-note">口径：memory_log 未归档、未蒸馏、创建于 30 天前（只读 dry-run，不写库）。</p>
  </section>`;
}

export async function renderMemory({ me, deps } = {}) {
  const isAdmin = ['admin', 'sysadmin'].includes(me?.role);
  if (!isAdmin) {
    return {
      schema: { type: 'monitor-overview-m', scope: 'forbidden' },
      data: { role: me?.role || 'guest' },
      html: renderForbidden(me),
    };
  }
  const [counts, edges, top, distill, refData, mVals] = await Promise.all([
    safeCounts(), safePrecedentEdges(), safePrecedentTop(10), safeDistill(), safePrecedentRefMap(),
    getTrendSamples('m_precedent_edge', { tenantId: me.tenantId || 'system', deps }),
  ]);
  const refMap = refData.map || {}; const invMap = refData.inv || {};
  const graphHtml = renderGraph(top, refMap, invMap);

  const detailBlocks = [];
  const refSet = new Set();
  for (const p of top) {
    const pid = p.precedent_id; const refs = refMap[pid] || [];
    detailBlocks.push(`<div class="so-detail-hidden" data-dk="${esc(pid)}">${renderPrecedentDetail(pid, p.n, refs)}</div>`);
    for (const d of refs) refSet.add(d);
  }
  for (const d of refSet) {
    detailBlocks.push(`<div class="so-detail-hidden" data-dk="${esc(d)}">${renderDecisionDetail(d, invMap[d] || [])}</div>`);
  }

  const style = `<style>
.so-m-graph-wrap{border:1px solid var(--line,#e6e8ec);border-radius:10px;padding:10px;background:var(--bg,#fff);}
.so-graph-legend{font-size:12px;color:var(--mut,#666);margin-bottom:6px;display:flex;align-items:center;gap:6px;}
.so-graph-legend .dot{display:inline-block;width:10px;height:10px;border-radius:50%;}
.so-graph-legend .dot.ok{background:var(--ok,#2a9d4a);}
.so-graph-legend .dot.ac{background:var(--ac,#3b6fd4);}
.so-graph-legend .line{display:inline-block;width:22px;height:2px;background:var(--ok,#2a9d4a);}
.so-m-graph{width:100%;height:auto;display:block;}
.so-m-graph-node text{font-family:monospace;}
</style>`;

  const html = [
    style,
    '<section class="pg-section so-m-top">', renderTopState(edges), '</section>',
    '<section class="pg-section so-m-trend"><h3>近 30 日趋势</h3>', renderTrendSvg(mVals), '</section>',
    '<section class="pg-section so-m-graph-sec"><h3>记忆系统图模型（先例 ↔ 决策引用关系）</h3>', graphHtml,
      '<p class="dn-note">点击任一节点查看明细：先例节点→引用它的决策；决策节点→它引用的先例。</p></section>',
    renderTriSection(counts),
    renderDistill(distill),
    '<section class="pg-section so-m-drill"><p class="dn-note">图节点与三构件计数均为只读监控。</p></section>',
    detailBlocks.join(''),
  ].join('');
  return { schema: { type: 'monitor-overview-m' }, data: { edges, ...counts, distill, top: top.length }, html };
}
