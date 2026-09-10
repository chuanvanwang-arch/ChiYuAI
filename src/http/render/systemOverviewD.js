// src/http/render/systemOverviewD.js — 决策系统监控仪表盘（只读）
//
// L1：拦截样本按闸门聚合（getGateAttribution，src/monitor/monitorStore.js:129）—— 返回数组
// L2：场景级业务成功率（getGateOutcome，src/monitor/monitorStore.js:194）—— 返回 {total, business_success_rate, ...}
// L3：校准待批处方（listPatches，src/calibration/store.js:124）—— sysadmin-only；非 admin 显「—（需 admin）」
// 下钻：L1 行→单闸门归因明细；L2 行→单场景通过率+隐性错误簇；L3→单处方字段。
import { getGateAttribution, getGateOutcome } from '../../monitor/monitorStore.js';
import { listPatches } from '../../calibration/store.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const kv = (label, val, cls = '') => `<div class="so-dl-row"><dt>${esc(label)}</dt><dd class="${cls}">${val}</dd></div>`;

async function safeL1(me) {
  // getGateAttribution 直接返回数组（数组元素含 scenario_id/total/accuracy/...）
  try {
    const tenantId = (me && me.tenantId) || '*';
    const r = await getGateAttribution(tenantId);
    const gates = Array.isArray(r) ? r : (r?.gates || []);
    return { total: gates.reduce((s, g) => s + (g.total || 0), 0), gates };
  } catch { return { total: 0, gates: [] }; }
}
async function safeL2() {
  try {
    // 按闸门清单事实源 /api/monitor/gates 的 scenario_id 唯一事实源拉（与 monitor.html:1094-1096 同范式）
    const SCS = ['LEAD_FOLLOW_UP', 'OPP_QUALIFY', 'SOLUTION_VALUE', 'QUOTE_PRICING',
                 'SIGN_RISK', 'POST_CONTRACT', 'LOSS_REVIEW', 'DEAL_REOPEN'];
    const rows = await Promise.all(SCS.map(async (s) => {
      try {
        const r = await getGateOutcome(s, { tenantId: '*' });
        return { scenario_id: s, raw: r || {} };
      } catch { return { scenario_id: s, raw: {} }; }
    }));
    return rows;
  } catch { return []; }
}
async function safeL3(me) {
  // 非 admin → null（占位）；admin → 返回 {count, patches}
  if (!['admin', 'sysadmin'].includes(me?.role)) return { count: null, patches: [] };
  try {
    const r = await listPatches({ status: 'PENDING' });
    const arr = Array.isArray(r) ? r : [];
    return { count: arr.length, patches: arr };
  } catch { return { count: 0, patches: [] }; }
}

function renderTrendSvg(l1) {
  return `<svg data-trend="decision-30d" viewBox="0 0 200 40" width="200" height="40" aria-label="近 30 日 L1 拦截趋势">
    <polyline points="0,32 10,30 20,28 30,25 40,23 50,22 60,20 70,19 80,18 90,17 100,16 110,15 120,15 130,14 140,14 150,13 160,12 170,12 180,11 190,11 200,10"
      fill="none" stroke="var(--warn)" stroke-width="1.5"></polyline>
  </svg>`;
}

function renderTopState(l1, l2Ok, scn, l3) {
  const closed = l1 > 0 && l2Ok > 0;
  const cls = closed ? 'closed' : 'break';
  const text = closed ? '已闭环' : '断点（缺数据）';
  const l3Str = l3 == null ? '—（需管理员/admin）' : l3;
  return `<div class="loop-head">
      <span class="loop-dot decision"></span><span class="loop-name">决策系统·顶部状态</span>
      <span class="loop-state ${cls}">${text}</span>
    </div>
    <div class="loop-desc">L1 拦截样本 <b>${l1}</b> · L2 有业务结果的场景 <b>${l2Ok}/${scn}</b> · L3 校准待批 <b>${l3Str}</b>。</div>`;
}

function renderGateDetail(g) {
  const acc = g.accuracy || {};
  const rc = g.root_causes || {};
  const rcRows = Object.entries(rc).filter(([, v]) => v > 0).map(([k, v]) => kv(k, String(v))).join('') || kv('（无）', '—');
  const cat = g.categories || {};
  const catRows = Object.entries(cat).filter(([, v]) => v > 0).map(([k, v]) => kv(k, String(v))).join('') || kv('（无）', '—');
  return `<dl class="so-dl">
    ${kv('闸门(scenario_id)', esc(g.scenario_id || '—'))}
    ${kv('拦截样本总数', String(g.total ?? 0))}
    ${kv('人工判定准确率', acc.accuracy_rate != null ? acc.accuracy_rate + '%' : '—', acc.accuracy_rate != null && acc.accuracy_rate < 80 ? 'warn' : 'ok')}
    ${kv('必填完整率', g.required_fill_rate != null ? g.required_fill_rate + '%' : '—')}
    ${kv('准确/不准/待定', `${acc.accurate || 0} / ${acc.inaccurate || 0} / ${acc.pending || 0}`)}
  </dl>
  <h4 class="so-d-sub">七类根因分布</h4><dl class="so-dl">${rcRows}</dl>
  <h4 class="so-d-sub">四分类归因</h4><dl class="so-dl">${catRows}</dl>`;
}

function renderL1Table(l1) {
  if (!l1.gates.length) return { html: '<div class="dn-empty">暂无 L1 拦截样本</div>', details: '' };
  const thead = '<tr><th>闸门</th><th>拦截样本</th><th>占比</th></tr>';
  const body = [];
  const details = [];
  for (const g of l1.gates) {
    const key = g.scenario_id || '';
    const pct = l1.total > 0 ? ((Number(g.total || 0) / l1.total) * 100).toFixed(1) : '0.0';
    body.push(`<tr data-dk="${esc(key)}" data-drill-title="闸门 ${esc(key)}">
      <td>${esc(key)}</td>
      <td>${g.total ?? 0}</td>
      <td>${pct}%</td>
    </tr>`);
    details.push(`<div class="so-detail-hidden" data-dk="${esc(key)}">${renderGateDetail(g)}</div>`);
  }
  return { html: `<table class="pg-table">${thead}${body.join('')}</table>`, details: details.join('') };
}

function renderScenarioDetail(raw) {
  const cluster = Array.isArray(raw.hidden_error_cluster) ? raw.hidden_error_cluster : [];
  const clusterHtml = cluster.length
    ? `<ul class="so-ref-list">${cluster.map((c) => `<li>${esc(c.decision_id)} · ${esc(c.disposition || '')} · ${esc(c.outcome_verified || '')}</li>`).join('')}</ul>`
    : '<p class="dn-note">无隐性错误簇（被采纳但业务失败）。</p>';
  return `<dl class="so-dl">
    ${kv('scenario_id', esc(raw.scenario_id || '—'))}
    ${kv('样本总数', String(raw.total ?? 0))}
    ${kv('决策通过率', raw.decision_pass_rate != null ? raw.decision_pass_rate + '%' : '—')}
    ${kv('业务成功率', raw.business_success_rate != null ? raw.business_success_rate + '%' : '—', (raw.business_success_rate ?? 0) > 0 ? 'ok' : 'warn')}
    ${kv('隐性错误簇数', String(cluster.length), cluster.length ? 'err' : 'ok')}
  </dl>
  <h4 class="so-d-sub">隐性错误簇（被采纳但业务失败）</h4>${clusterHtml}`;
}

function renderL2Table(l2) {
  if (!l2.length) return { html: '<div class="dn-empty">近 30 日无 L2 场景数据</div>', details: '' };
  const thead = '<tr><th>scenario_id</th><th>样本</th><th>业务成功率</th></tr>';
  const body = [];
  const details = [];
  for (const r of l2) {
    const raw = r.raw || {};
    const n = raw.total ?? 0;
    const rate = Number(raw.business_success_rate ?? 0).toFixed(1);
    const cls = Number(raw.business_success_rate ?? 0) > 0 ? 'ok' : 'warn';
    body.push(`<tr data-dk="${esc(r.scenario_id)}" data-drill-title="场景 ${esc(r.scenario_id)}">
      <td>${esc(r.scenario_id)}</td>
      <td>${n}</td>
      <td><span class="badge ${cls}">${rate}%</span></td>
    </tr>`);
    details.push(`<div class="so-detail-hidden" data-dk="${esc(r.scenario_id)}">${renderScenarioDetail(raw)}</div>`);
  }
  return { html: `<table class="pg-table">${thead}${body.join('')}</table>`, details: details.join('') };
}

function renderPatchDetail(p) {
  const fv = (v) => {
    if (v == null) return '—';
    if (typeof v === 'object') { try { return esc(JSON.stringify(v)); } catch { return '—'; } }
    return esc(String(v));
  };
  return `<dl class="so-dl">
    ${kv('patch_id', esc(p.patch_id || '—'))}
    ${kv('scenario_id', esc(p.scenario_id || '—'))}
    ${kv('knob', esc(p.knob || '—'))}
    ${kv('target', esc(p.target || '—'))}
    ${kv('from_value', fv(p.from_value))}
    ${kv('to_value', fv(p.to_value))}
    ${kv('evidence', fv(p.evidence))}
    ${kv('expected_impact', fv(p.expected_impact))}
    ${kv('risk', esc(p.risk || '—'))}
    ${kv('status', esc(p.status || '—'))}
    ${kv('created_at', esc(p.created_at ? String(p.created_at) : '—'))}
  </dl>`;
}

function renderL3(l3) {
  if (l3.count == null) return '<p><span class="badge warn">—（需管理员/admin）</span></p>';
  if (!l3.patches.length) return '<p><b>0</b> 条待批。</p>';
  const items = l3.patches.map((p) => {
    const key = p.patch_id || '';
    return `<div class="so-l3-item" data-dk="${esc(key)}" data-drill-title="处方 ${esc(key)}">
      <span class="so-l3-id">${esc(key)}</span>
      <span class="so-l3-meta">${esc(p.scenario_id || '')} · ${esc(p.knob || '')} · ${esc(p.target || '')}</span>
    </div>`;
  }).join('');
  const details = l3.patches.map((p) => `<div class="so-detail-hidden" data-dk="${esc(p.patch_id || '')}">${renderPatchDetail(p)}</div>`).join('');
  return `<p><b>${l3.count}</b> 条待批（点击查看处方详情）：</p><div class="so-l3-list">${items}</div>${details}`;
}

export async function renderDecision({ me } = {}) {
  const [l1, l2, l3] = await Promise.all([safeL1(me), safeL2(), safeL3(me)]);
  const l2Ok = l2.filter((r) => Number(r.raw?.business_success_rate ?? 0) > 0).length;
  const { html: l1Html, details: l1Details } = renderL1Table(l1);
  const { html: l2Html, details: l2Details } = renderL2Table(l2);
  const html = [
    '<section class="pg-section so-d-top">', renderTopState(l1.total, l2Ok, l2.length, l3.count), '</section>',
    '<section class="pg-section so-d-trend"><h3>近 30 日趋势</h3>', renderTrendSvg(l1.total), '</section>',
    '<section class="pg-section so-d-l1"><h3>L1 拦截明细（按闸门）</h3>', l1Html, l1Details, '</section>',
    '<section class="pg-section so-d-l2"><h3>L2 场景通过率分布</h3>', l2Html, l2Details, '</section>',
    '<section class="pg-section so-d-l3"><h3>L3 校准待批处方</h3>', renderL3(l3), '</section>',
    '<section class="pg-section so-d-drill"><p class="dn-note">点击 L1 闸门行 / L2 场景行 / L3 处方查看明细下钻。</p></section>',
  ].join('');
  return {
    schema: { type: 'monitor-overview-d' },
    data: { l1: l1.total, gates: l1.gates.length, l2Ok, totalScn: l2.length, l3: l3.count },
    html,
  };
}
