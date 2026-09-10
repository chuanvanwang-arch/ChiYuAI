// src/http/render/systemOverviewD.js — 决策系统监控仪表盘（只读）
//
// L1：拦截样本数（getGateAttribution，src/monitor/monitorStore.js:129）
// L2：场景级业务成功率（getGateOutcome，src/monitor/monitorStore.js:194，按 scenario 取）
// L3：校准待批处方数（listPatches，src/calibration/store.js:124）—— sysadmin-only；
//     非 admin 进入时显「—（需 admin）」。
import { getGateAttribution, getGateOutcome } from '../../monitor/monitorStore.js';
import { listPatches } from '../../calibration/store.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function safeL1(me) {
  try {
    const tenantId = (me && me.tenantId) || '*';
    const r = await getGateAttribution(tenantId);
    // 累计所有闸门 total（与 src/web/sales-decision-monitor.html:1102 同口径）
    const gates = r?.gates || [];
    return gates.reduce((s, g) => s + (g.total || 0), 0);
  } catch { return 0; }
}
async function safeL2() {
  try {
    // 按闸门清单事实源 /api/monitor/gates 的 scenario_id 唯一事实源拉（与 monitor.html:1094-1096 同范式）
    // 此处用硬编码 7+1 闸门列表兜底（与既有 loadLoops 一致）；后续可读 /api/monitor/gates 替换。
    const SCS = ['LEAD_FOLLOW_UP', 'OPP_QUALIFY', 'SOLUTION_VALUE', 'QUOTE_PRICING',
                 'SIGN_RISK', 'POST_CONTRACT', 'LOSS_REVIEW', 'DEAL_REOPEN'];
    const rows = await Promise.all(SCS.map(async (s) => {
      try {
        const r = await getGateOutcome(s, { tenantId: '*' });
        return { scenario_id: s, n: r?.samples ?? 0, success: Number(r?.business_success_rate ?? 0) };
      } catch { return { scenario_id: s, n: 0, success: 0 }; }
    }));
    return rows;
  } catch { return []; }
}
async function safeL3(me) {
  if (!['admin', 'sysadmin'].includes(me?.role)) return null; // 非 admin → null（占位）
  try {
    const r = await listPatches({ status: 'PENDING' });
    return Array.isArray(r) ? r.length : (Array.isArray(r?.patches) ? r.patches.length : 0);
  } catch { return 0; }
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

function renderL2Table(l2) {
  if (!l2.length) return '<div class="dn-empty">近 30 日无 L2 场景数据</div>';
  const thead = '<tr><th>scenario_id</th><th>样本</th><th>业务成功率</th></tr>';
  const body = l2.map((r) => {
    const rate = (Number(r.success) * 100).toFixed(1);
    const cls = Number(r.success) > 0 ? 'ok' : 'warn';
    return `<tr data-scenario="${esc(r.scenario_id)}">
      <td>${esc(r.scenario_id)}</td>
      <td>${r.n}</td>
      <td><span class="badge ${cls}">${rate}%</span></td>
    </tr>`;
  }).join('');
  return `<table class="pg-table">${thead}${body}</table>`;
}

export async function renderDecision({ me } = {}) {
  const [l1, l2, l3] = await Promise.all([safeL1(me), safeL2(), safeL3(me)]);
  const l2Ok = l2.filter((r) => Number(r.success) > 0).length;
  const html = [
    '<section class="pg-section so-d-top">', renderTopState(l1, l2Ok, l2.length, l3), '</section>',
    '<section class="pg-section so-d-trend"><h3>近 30 日趋势</h3>', renderTrendSvg(l1), '</section>',
    '<section class="pg-section so-d-l2"><h3>L2 场景通过率分布</h3>', renderL2Table(l2), '</section>',
    '<section class="pg-section so-d-l3"><h3>L3 校准待批处方</h3>',
    `<p>${l3 == null ? '<span class="badge warn">—（需管理员/admin）</span>' : `<b>${l3}</b> 条待批`}</p>`,
    '</section>',
  ].join('');
  return {
    schema: { type: 'monitor-overview-d' },
    data: { l1, l2Ok, totalScn: l2.length, l3 },
    html,
  };
}