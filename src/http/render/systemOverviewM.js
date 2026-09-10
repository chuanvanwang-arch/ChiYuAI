// src/http/render/systemOverviewM.js — 记忆系统监控仪表盘（只读，含权限隔离）
//
// 权限：GET /api/memory 是 sysadmin-only；非 admin 进入时只显「权限不足」+ 监控台 fallback，
//        避免 hard-block（设计 §1.4）。
//
// 四段式骨架：①顶部状态（先例边数）②近 30 日趋势 ③先例边 Top + 三构件计数 ④行下钻
// 数据源：listPrecedents() / listLogs() / listNotes() / listSnapshots() 等同 createMemoryConfigRouter 内部 deps
//   （直接走等价 COUNT(*) SQL，避免 mount 自路由）。先例边数：直接查 crm.decision_precedent_rel。
import { query } from '../../db.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function renderForbidden(me) {
  return `<section class="pg-section so-m-forbidden">
    <h3>记忆系统·权限说明</h3>
    <p>本页为记忆治理只读视图，<b>仅管理员（sysadmin / admin）可访问</b>（当前账号 ${esc(me?.role || 'guest')} 无该权限）。</p>
    <p>记忆仍由业务事件自动捕获并在系统中流转；其闭环进度可在
      <a href="/sales-decision-monitor.html">销售决策监控台 · 三闭环条 · 记忆系统</a> 查看，
      或前往 <a href="/decision-graph.html">决策链追溯</a> 查看先例引用边。
    </p>
  </section>`;
}

async function safeCounts() {
  // 三构件计数（与 src/portal/memoryConfig.js:23-31 同源 SELECT）
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
  // 决策图引用先例边计数（与 src/web/sales-decision-monitor.html:1080-1088 loadLoops memory 段同口径：
  //   对每条 decision 的 referenced_precedents JSONB 数组累加）
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

function renderTrendSvg(edges) {
  // 占位 SVG（未来按日采样接入）
  return `<svg data-trend="memory-30d" viewBox="0 0 200 40" width="200" height="40" aria-label="近 30 日先例引用趋势">
    <polyline points="0,35 10,33 20,30 30,28 40,25 50,23 60,21 70,20 80,18 90,17 100,16 110,15 120,14 130,13 140,12 150,12 160,11 170,10 180,10 190,9 200,8"
      fill="none" stroke="var(--ok)" stroke-width="1.5"></polyline>
  </svg>`;
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

// 简化版：resolveMe 由路由层注入 me（已有 parseAuth / resolveMe 工具）；
//         本渲染器仅消费 me.role 做权限判断，避免重复实现认证。
export async function renderMemory({ me } = {}) {
  const isAdmin = ['admin', 'sysadmin'].includes(me?.role);
  if (!isAdmin) {
    return {
      schema: { type: 'monitor-overview-m', scope: 'forbidden' },
      data: { role: me?.role || 'guest' },
      html: renderForbidden(me),
    };
  }
  const [counts, edges] = await Promise.all([safeCounts(), safePrecedentEdges()]);
  const html = [
    '<section class="pg-section so-m-top">', renderTopState(edges), '</section>',
    '<section class="pg-section so-m-trend"><h3>近 30 日趋势</h3>', renderTrendSvg(edges), '</section>',
    renderTriSection(counts),
    '<section class="pg-section so-m-drill"><p class="dn-empty">行点击下钻弹窗（先例边 Top10）由后续迭代补。</p></section>',
  ].join('');
  return { schema: { type: 'monitor-overview-m' }, data: { edges, ...counts }, html };
}