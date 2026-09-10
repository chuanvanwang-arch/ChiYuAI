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

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function safeSkew() {
  try { return await listMethodologySkew(); } catch { return []; }
}
async function safeSkillRegistry() {
  try { return await listSkillRegistry(); } catch { return []; }
}

function renderTrendSvg() {
  // 近 30 日趋势：占位 SVG（无历史时序表时静态 sparkline）；未来接入按日采样后改为动态
  return `<svg data-trend="knowledge-30d" viewBox="0 0 200 40" width="200" height="40" aria-label="近 30 日方法 SKILL 装配趋势">
    <polyline points="0,30 10,28 20,25 30,22 40,20 50,18 60,15 70,14 80,12 90,11 100,10 110,9 120,9 130,8 140,8 150,7 160,7 170,6 180,6 190,5 200,5"
      fill="none" stroke="var(--ac)" stroke-width="1.5"></polyline>
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

function renderTable(skew, skills) {
  // 合并数据源：skills 优先（带 enabled），缺失字段从 skew 兜底
  const bySkill = new Map();
  for (const s of skills) bySkill.set(s.skill_id, { ...s });
  for (const s of skew) {
    const cur = bySkill.get(s.skill_id) || { skill_id: s.skill_id };
    bySkill.set(s.skill_id, { ...cur, ...s });
  }
  const rows = Array.from(bySkill.values()).slice(0, 50);
  if (!rows.length) return '<div class="dn-empty">暂无方法 SKILL 数据</div>';
  const thead = '<tr><th>skill_id</th><th>启停</th><th>维度漂移</th><th>映射别名</th><th>methodology</th><th>操作</th></tr>';
  const body = rows.map((s) => {
    const enabled = s.enabled === true ? '启用' : (s.enabled === false ? '停用' : '—');
    const dimSkewBadge = s.dim_skew ? '<span class="badge err">漂移</span>' : '<span class="badge ok">一致</span>';
    const mapped = s.mapped ? '已映射' : '—';
    return `<tr data-skill-id="${esc(s.skill_id)}">
      <td>${esc(s.skill_id)}</td>
      <td>${enabled}</td>
      <td>${dimSkewBadge}</td>
      <td>${mapped}</td>
      <td>${esc(s.methodology_id || '—')}</td>
      <td><a href="/skills.html" target="_blank">去配置页 →</a></td>
    </tr>`;
  }).join('');
  return `<table class="pg-table">${thead}${body}</table>`;
}

export async function renderKnowledge() {
  const [skew, skills] = await Promise.all([safeSkew(), safeSkillRegistry()]);
  const html = [
    '<section class="pg-section so-k-top">', renderTopState(skew), '</section>',
    '<section class="pg-section so-k-trend"><h3>近 30 日趋势</h3>', renderTrendSvg(), '</section>',
    '<section class="pg-section so-k-table"><h3>方法 SKILL 清单 + 维度漂移</h3>', renderTable(skew, skills), '</section>',
    '<section class="pg-section so-k-drill"><p class="dn-empty">行点击下钻弹窗在后续迭代补（数据下钻 schema 落定后接入）。</p></section>',
  ].join('');
  return {
    schema: { type: 'monitor-overview-k' },
    data: { dimSkew: skew.filter((s) => s.dim_skew).length, totalSkills: skills.length },
    html,
  };
}