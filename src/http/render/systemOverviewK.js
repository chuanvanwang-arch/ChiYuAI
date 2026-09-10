// src/http/render/systemOverviewK.js — 知识系统监控仪表盘（只读）
//
// 四段式骨架：①顶部状态 ②近 30 日趋势 SVG ③SKILL 清单+维度漂移表 ④行点击下钻
// 数据源（既有函数，零新增）：
//   - listMethodologySkew() → [{skill_id, dim_skew, mapped, methodology_id, ...}]      // src/skills/methodologySync.js:178
//   - listSkillRegistry()    → [{skill_id, category, enabled, rbac_roles, ...}]       // src/skills/skillRegistry.js:64
//
// 错误降级：任一调用失败 → 该段「暂无数据」+ 不阻断其它段（与销售监控台 loadLoops 同范式）。
import { listMethodologySkew } from '../../skills/methodologySync.js';
import { listSkillRegistry } from '../../skills/skillRegistry.js';
import { getTrendSamples, buildTrendPolyline } from './systemOverviewShared.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const kv = (label, val, cls = '') => `<div class="so-dl-row"><dt>${esc(label)}</dt><dd class="${cls}">${val}</dd></div>`;

async function safeSkew() {
  try { return await listMethodologySkew(); } catch { return []; }
}
async function safeSkillRegistry() {
  try { return await listSkillRegistry(); } catch { return []; }
}

function renderTrendSvg(values) {
  const points = buildTrendPolyline(values);
  const label = '近 30 日方法 SKILL 装配趋势';
  if (!points) {
    return `<svg data-trend="knowledge-30d" viewBox="0 0 200 40" width="200" height="40" aria-label="${label}"><text x="4" y="24" class="so-trend-empty">暂无采样数据</text></svg>`;
  }
  return `<svg data-trend="knowledge-30d" viewBox="0 0 200 40" width="200" height="40" aria-label="${label}">
    <polyline points="${points}" fill="none" stroke="var(--ac)" stroke-width="1.5"></polyline>
  </svg>`;
}

function renderTopState(skew) {
  const dimSkew = skew.filter((s) => s.dim_skew).length;
  const mapped = skew.filter((s) => s.mapped).length;
  const closed = dimSkew === 0;
  const cls = closed ? 'closed' : 'break';
  const text = closed ? '已闭环' : '有漂移';
  const detail = closed
    ? `方法 SKILL ↔ DB 镜像维度 <b>完全一致</b>${mapped ? `（另有 ${mapped} 个模板 id 命名差异，由 MIRROR_ID 显式映射）` : ''}`
    : `${dimSkew} 个方法 SKILL 存在<b>维度级漂移</b>（missing_in_db / missing_in_skill）`;
  return `<div class="loop-head">
      <span class="loop-dot knowledge"></span><span class="loop-name">知识系统·顶部状态</span>
      <span class="loop-state ${cls}">${text}</span>
    </div>
    <div class="loop-desc">${detail}</div>`;
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
  // 合并数据源：skills 优先（带 enabled），缺失字段从 skew 兜底
  const bySkill = new Map();
  for (const s of skills) bySkill.set(s.skill_id, { ...s });
  for (const s of skew) {
    const cur = bySkill.get(s.skill_id) || { skill_id: s.skill_id };
    bySkill.set(s.skill_id, { ...cur, ...s });
  }
  const rows = Array.from(bySkill.values()).slice(0, 50);
  if (!rows.length) return { html: '<div class="dn-empty">暂无方法 SKILL 数据</div>', details: '' };
  const thead = '<tr><th>skill_id</th><th>启停</th><th>维度漂移</th><th>映射别名</th><th>methodology</th><th>操作</th></tr>';
  const body = [];
  const details = [];
  for (const s of rows) {
    const key = s.skill_id || '';
    const enabled = s.enabled === true ? '启用' : (s.enabled === false ? '停用' : '—');
    const dimSkewBadge = s.dim_skew ? '<span class="badge err">漂移</span>' : '<span class="badge ok">一致</span>';
    const mapped = s.mapped ? '已映射' : '—';
    body.push(`<tr data-dk="${esc(key)}" data-drill-title="SKILL ${esc(key)}">
      <td>${esc(key)}</td>
      <td>${enabled}</td>
      <td>${dimSkewBadge}</td>
      <td>${mapped}</td>
      <td>${esc(s.methodology_id || '—')}</td>
      <td><a href="/skills.html" target="_blank">去配置页 →</a></td>
    </tr>`);
    details.push(`<div class="so-detail-hidden" data-dk="${esc(key)}">${renderSkillDetail(s)}</div>`);
  }
  const html = `<table class="pg-table">${thead}${body.join('')}</table>`;
  return { html, details: details.join('') };
}

export async function renderKnowledge({ deps } = {}) {
  const [skew, skills, kVals] = await Promise.all([
    safeSkew(),
    safeSkillRegistry(),
    getTrendSamples('k_method_skill', { tenantId: 'system', deps }),
  ]);
  const { html: tableHtml, details } = renderTable(skew, skills);
  const html = [
    '<section class="pg-section so-k-top">', renderTopState(skew), '</section>',
    '<section class="pg-section so-k-trend"><h3>近 30 日趋势</h3>', renderTrendSvg(kVals), '</section>',
    '<section class="pg-section so-k-table"><h3>方法 SKILL 清单 + 维度漂移</h3>', tableHtml, details, '</section>',
    '<section class="pg-section so-k-drill"><p class="dn-note">点击任意一行查看该 SKILL 的完整字段与维度漂移明细。</p></section>',
  ].join('');
  return {
    schema: { type: 'monitor-overview-k' },
    data: { dimSkew: skew.filter((s) => s.dim_skew).length, totalSkills: skills.length },
    html,
  };
}
