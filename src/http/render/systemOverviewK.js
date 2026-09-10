// src/http/render/systemOverviewK.js — 知识系统监控仪表盘（只读）
//
// 看板范式（与销售监控台一致）：①顶部状态 ②近30日趋势 ③知识系统三支柱构成 ④点行下钻明细
// 三支柱：方法 SKILL 装配 / 维度镜像一致 / 本体词表治理
// 数据源（既有函数，零新增）：
//   - listMethodologySkew() → [{skill_id, dim_skew, mapped, ...}]              // src/skills/methodologySync.js
//   - listSkillRegistry()    → [{skill_id, category, enabled, rbac_roles, ...}] // src/skills/skillRegistry.js
//   - enumHintFields()       → 本体业务词表字段清单（知识治理面）                // src/ontology/vocabulary.js
import { SCENARIO_KNOWLEDGE_MAP } from '../../context/assembler.js';
import { listMethodologySkew } from '../../skills/methodologySync.js';
import { listSkillRegistry } from '../../skills/skillRegistry.js';
import { enumHintFields } from '../../ontology/vocabulary.js';
import { queryParticles } from '../../particles/particleRepo.js';
import { readConfig } from '../../config/configStore.js';
import { query } from '../../db.js';
import { getTrendSamples, buildTrendPolyline } from './systemOverviewShared.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const kv = (label, val, cls = '') => `<div class="so-dl-row"><dt>${esc(label)}</dt><dd class="${cls}">${val}</dd></div>`;

async function safeSkew() {
  try { return await listMethodologySkew(); } catch { return []; }
}
async function safeSkillRegistry() {
  try { return await listSkillRegistry(); } catch { return []; }
}

// —— 四源查询（知识原料库，T1 数据层）——
// ① 知识粒子：CRM_KNOWLEDGE 粒子按 payload->>'kind' 分桶（scope：tenantId 或 '*')
async function queryKnowledgeBuckets(tenantId = 'system') {
  try {
    const parts = await queryParticles({
      type: 'CRM_KNOWLEDGE',
      tenantId,
      limit: 2000,
      excludeStates: ['deprecated'],
    });
    const buckets = {};
    let total = 0;
    for (const p of parts || []) {
      const kind = p.payload?.kind || '未分类';
      buckets[kind] = (buckets[kind] || 0) + 1;
      total++;
    }
    return { total, buckets };
  } catch { return { total: 0, buckets: {} }; }
}

// ② 来源边：edges → target_type='CRM_KNOWLEDGE' 计数（实体→知识 溯源链接）
async function countEdgesToKnowledge(tenantId = 'system') {
  try {
    const r = await query(
      `SELECT COUNT(*)::int AS n FROM crm.edges
       WHERE target_type='CRM_KNOWLEDGE'
         AND ($1::text IS NULL OR tenant_id=$1)`,
      [tenantId === '*' ? null : tenantId]
    );
    return Number(r.rows?.[0]?.n ?? 0);
  } catch { return 0; }
}

// ③ L-Knowledge 注入覆盖：knowledge-injection-map 配置 + 各 scenario 命中知识条目数
async function injectionCoverage(tenantId = 'system') {
  try {
    // 注入映射 = 出厂默认（SCENARIO_KNOWLEDGE_MAP）∪ config_store 租户覆盖
    const cfg = await readConfig('knowledge-injection-map', { tenantId: tenantId === '*' ? 'system' : tenantId })
      .catch(() => null);
    const map = { ...SCENARIO_KNOWLEDGE_MAP, ...(cfg?.value || {}) };
    const kinds = new Set(Object.values(map).flat());
    const parts = await queryParticles({
      type: 'CRM_KNOWLEDGE',
      tenantId,
      limit: 5000,
      excludeStates: ['deprecated'],
    });
    let injected = 0;
    for (const p of parts || []) {
      const kind = p.payload?.kind;
      if (kind && kinds.has(kind)) injected++;
    }
    return { scenarios: Object.keys(map).length, injected };
  } catch { return { scenarios: 0, injected: 0 }; }
}

// ④ 历史先例：decision_precedent_rel 按 precedent_id 引用数 Top-N（REFERENCED_PRECEDENT 语义）
async function precedentTop(tenantId = 'system', limit = 8) {
  try {
    const r = await query(
      `SELECT r.precedent_id, COUNT(*)::int AS refs
       FROM crm.decision_precedent_rel r
       LEFT JOIN crm.decision d ON d.decision_id = r.precedent_id
       WHERE ($1::text IS NULL OR COALESCE(d.tenant_id, 'system') = $1)
       GROUP BY 1 ORDER BY refs DESC LIMIT $2`,
      [tenantId === '*' ? null : tenantId, limit]
    );
    return r.rows || [];
  } catch { return []; }
}

function renderTrendSvg(values) {
  const points = buildTrendPolyline(values);
  const label = '近 30 日知识粒子趋势';
  if (!points) {
    return `<svg data-trend="knowledge-30d" viewBox="0 0 200 40" width="200" height="40" aria-label="${label}"><text x="4" y="24" class="so-trend-empty">暂无采样数据</text></svg>`;
  }
  return `<svg data-trend="knowledge-30d" viewBox="0 0 200 40" width="200" height="40" aria-label="${label}">
    <polyline points="${points}" fill="none" stroke="var(--ac)" stroke-width="1.5"></polyline>
  </svg>`;
}

function renderTopState({ buckets, edges, inject, precedents }) {
  const closed = (buckets.total > 0 || edges > 0 || inject.injected > 0 || precedents.length > 0);
  const cls = closed ? 'closed' : 'break';
  const text = closed ? '已闭环' : '断点（缺数据）';
  return `<div class="loop-head">
      <span class="loop-dot knowledge"></span><span class="loop-name">知识系统·原料库存</span>
      <span class="loop-state ${cls}">${text}</span>
    </div>
    <div class="loop-desc">知识粒子 <b>${buckets.total}</b> · 来源边 <b>${edges}</b> · L-Knowledge 注入命中 <b>${inject.injected}</b>（${inject.scenarios} 场景）· 被引用先例 <b>${precedents.length}</b> 条</div>`;
}

// 四源面板（知识原料库主视图）：每面板 data-dk 下钻
function renderFourPanels(buckets, edges, inject, precedents) {
  const bucketChips = Object.entries(buckets.buckets)
    .map(([k, n]) => `<span class="so-chip">${esc(k)} ${n}</span>`).join('') || '<span class="dn-note">暂无</span>';
  const preList = precedents.slice(0, 8).map((p) => `<div class="so-prec-row"><span class="so-prec-id">${esc(p.precedent_id)}</span><span class="so-prec-refs">被引用 ${p.refs} 次</span></div>`).join('') || '<p class="dn-note">暂无被引用先例</p>';
  const panels = [
    { dk: 'knowledge-particles', title: '① 知识粒子库', value: buckets.total, sub: `按 kind 分桶 ${Object.keys(buckets.buckets).length} 类` },
    { dk: 'source-edges', title: '② 来源边溯源', value: edges, sub: '实体 → 知识 sourcedFrom 边' },
    { dk: 'injection-coverage', title: '③ L-Knowledge 注入覆盖', value: inject.injected, sub: `${inject.scenarios} 个注入场景命中` },
    { dk: 'precedent-graph', title: '④ 历史先例图', value: precedents.length, sub: '被引用 Top-N 先例' },
  ].map((c) => `<div class="so-panel" data-dk="${esc(c.dk)}" data-drill-title="${esc(c.title)}" style="cursor:pointer">
    <div class="so-panel-h">${esc(c.title)}</div>
    <div class="so-panel-v">${c.value}</div>
    <div class="so-panel-s">${esc(c.sub)}</div>
  </div>`).join('');
  const details = [
    `<div class="so-detail-hidden" data-dk="knowledge-particles"><h4 class="so-d-sub">知识粒子 kind 分桶</h4><div class="so-k-buckets">${bucketChips}</div></div>`,
    `<div class="so-detail-hidden" data-dk="source-edges"><h4 class="so-d-sub">来源边</h4><p class="dn-note">edges → CRM_KNOWLEDGE（sourcedFrom 溯源）计数 ${edges}。明细见决策溯源链。</p></div>`,
    `<div class="so-detail-hidden" data-dk="injection-coverage"><h4 class="so-d-sub">L-Knowledge 注入命中</h4><p class="dn-note">knowledge-injection-map ${inject.scenarios} 场景，命中 ${inject.injected} 条知识（按 kind 匹配）。</p></div>`,
    `<div class="so-detail-hidden" data-dk="precedent-graph"><h4 class="so-d-sub">被引用先例 Top-N</h4>${preList}</div>`,
  ].join('');
  return { html: `<div class="so-k-panels">${panels}</div>`, details };
}

function renderSkillDetail(s) {
  const enabled = s.enabled === true ? '启用' : (s.enabled === false ? '停用' : '—');
  const rows = [
    kv('skill_id', esc(s.skill_id || '—')),
    kv('category', esc(s.category || '—')),
    kv('启停状态', esc(enabled), s.enabled === true ? 'ok' : 'warn'),
    kv('RBAC 角色', esc(Array.isArray(s.rbac_roles) ? s.rbac_roles.join(', ') : (s.rbac_roles || '—'))),
    kv('methodology_id', esc(s.methodology_id || '—')),
    kv('mirror_id', esc(s.mirror_id || '—')),
    kv('数据来源', esc(s.source || '—')),
    kv('维度级漂移', s.dim_skew ? '<span class="badge err">是</span>' : '<span class="badge ok">否</span>'),
    kv('模板 id 漂移', s.id_skew ? '<span class="badge warn">是</span>' : '<span class="badge ok">否</span>'),
    kv('MIRROR_ID 已映射', s.mapped ? '<span class="badge ok">是（已治理）</span>' : '<span class="badge warn">否</span>'),
  ];
  if (s.dim_skew) {
    rows.push(kv('DB 维度', esc(Array.isArray(s.db_dims) ? s.db_dims.join(', ') : '—')));
    rows.push(kv('SKILL 维度', esc(Array.isArray(s.skill_dims) ? s.skill_dims.join(', ') : '—')));
    if (Array.isArray(s.missing_in_db) && s.missing_in_db.length)
      rows.push(kv('缺失于 DB', esc(s.missing_in_db.join(', ')), 'err'));
    if (Array.isArray(s.missing_in_skill) && s.missing_in_skill.length)
      rows.push(kv('缺失于 SKILL', esc(s.missing_in_skill.join(', ')), 'err'));
  }
  return `<dl class="so-dl">${rows.join('')}</dl>`;
}

function renderTable(skew, skills) {
  const bySkill = new Map();
  for (const s of skills) bySkill.set(s.skill_id, { ...s });
  for (const s of skew) {
    const cur = bySkill.get(s.skill_id) || { skill_id: s.skill_id };
    bySkill.set(s.skill_id, { ...cur, ...s });
  }
  const rows = Array.from(bySkill.values()).slice(0, 50);
  if (!rows.length) return { html: '<div class="dn-empty">暂无方法 SKILL 数据</div>', details: '' };
  const thead = '<tr><th>skill_id</th><th>类别</th><th>启停</th><th>维度漂移</th><th>操作</th></tr>';
  const body = [];
  const details = [];
  for (const s of rows) {
    const key = s.skill_id || '';
    const enabled = s.enabled === true ? '启用' : (s.enabled === false ? '停用' : '—');
    const dimSkewBadge = s.dim_skew ? '<span class="badge err">漂移</span>' : '<span class="badge ok">一致</span>';
    body.push(`<tr data-dk="${esc(key)}" data-drill-title="SKILL ${esc(key)}">
      <td>${esc(key)}</td>
      <td>${esc(s.category || '—')}</td>
      <td>${enabled}</td>
      <td>${dimSkewBadge}</td>
      <td><a href="/skills.html" target="_blank">去配置页 →</a></td>
    </tr>`);
    details.push(`<div class="so-detail-hidden" data-dk="${esc(key)}">${renderSkillDetail(s)}</div>`);
  }
  const html = `<table class="pg-table">${thead}${body.join('')}</table>`;
  return { html, details: details.join('') };
}

export async function renderKnowledge({ me, deps } = {}) {
  // admin 且 scope=all → '*'（全租户通配）；否则默认租户（me.tenantId || 'system'）
  const effective = (['admin', 'sysadmin'].includes(me?.role) && me?.scope === 'all')
    ? '*' : (me?.tenantId || 'system');
  const [buckets, edges, inject, precedents, kVals, skew, skills] = await Promise.all([
    queryKnowledgeBuckets(effective),
    countEdgesToKnowledge(effective),
    injectionCoverage(effective),
    precedentTop(effective),
    getTrendSamples('k_knowledge_count', { tenantId: effective, deps }),
    safeSkew(),
    safeSkillRegistry(),
  ]);
  const { html: panelsHtml, details: panelsDetails } = renderFourPanels(buckets, edges, inject, precedents);
  // 治理角落：方法 SKILL 装配健康度（降级，非主体）
  const totalSkills = skills.length;
  const dimSkew = skew.filter((s) => s.dim_skew).length;
  const govHtml = `<section class="pg-section so-k-governance">
    <h4>治理角落：方法 SKILL 装配健康度</h4>
    <p>注册 <b>${totalSkills}</b> · 维度一致 <b>${totalSkills - dimSkew}/${totalSkills}</b>${dimSkew ? ` · <span class="badge err">${dimSkew} 个漂移</span>` : ' · <span class="badge ok">全量闭环</span>'}
    → <a href="/skills.html" target="_blank">去配置页</a></p>
  </section>`;
  const style = `<style>
.so-k-panels{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-top:8px;}
.so-panel{border:1px solid var(--line,#e6e8ec);border-radius:10px;padding:14px;background:var(--bg,#fff);cursor:pointer;transition:background .15s;}
.so-panel:hover{background:var(--hover,#f5f7fa);}
.so-panel-h{font-size:13px;color:var(--mut,#666);}
.so-panel-v{font-size:26px;font-weight:700;margin:6px 0 2px;}
.so-panel-s{font-size:12px;color:var(--mut,#888);}
.so-k-buckets{display:flex;flex-wrap:wrap;gap:5px;}
.so-chip{font-size:11px;border:1px solid var(--line,#e6e8ec);border-radius:999px;padding:1px 8px;color:var(--mut,#666);background:var(--bg2,#f7f8fa);}
.so-prec-row{display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px dashed var(--line,#e6e8ec);}
.so-prec-id{font-family:monospace;font-size:11px;word-break:break-all;padding-right:8px;}
.so-prec-refs{font-size:11px;color:var(--mut,#888);white-space:nowrap;}
</style>`;
  const html = [
    style,
    '<section class="pg-section so-k-top">', renderTopState({ buckets, edges, inject, precedents }), '</section>',
    '<section class="pg-section so-k-trend"><h3>近 30 日知识粒子趋势</h3>', renderTrendSvg(kVals), '</section>',
    '<section class="pg-section so-k-panels-sec"><h3>知识原料四源（点击面板下钻明细）</h3>', panelsHtml, panelsDetails, '</section>',
    govHtml,
    '<section class="pg-section so-k-drill"><p class="dn-note">点击知识粒子库 / 来源边 / 注入覆盖 / 先例图面板查看对应明细下钻。</p></section>',
  ].join('');
  return {
    schema: { type: 'monitor-overview-k', scope: effective },
    data: { totalParticles: buckets.total, sourceEdges: edges, injected: inject.injected, precedents: precedents.length, totalSkills, dimSkew },
    html,
  };
}
