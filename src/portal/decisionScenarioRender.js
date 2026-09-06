// src/portal/decisionScenarioRender.js — decisionScenarioRender.js 渲染纯函数子模块（浏览器 ESM 可加载）
// 根因修复（2026-08-27）：源 decisionScenario.js 顶层含 Node-only import
// （express / ../db.js / ../decision/* / ../alerts/*）→ 浏览器原生 ESM 加载报
// "Failed to resolve module specifier 'express'" → 页面脚本崩溃（列表不渲染/按钮不绑定）。
// 本文件仅含渲染纯函数（零服务端 import），浏览器与 vitest 均可直接 import。
// 服务端 router 仍保留在 decisionScenario.js（routes.js 继续 import 它）；页面 import 改指向本文件。

// src/portal/decisionScenario.js — 销售决策场景配置（第 14 项，端点 + 可编辑）
// 渲染纯函数（浏览器 + vitest 共用） + 表驱动 GET/PUT 端点（决策第0闸 + 字段白名单校验）
// 设计输入：docs/superpowers/plans/2026-08-27-decision-scenario-config.md
// 后端事实：crm.decision_scenario（db/schema.sql 决策事件主轴段）；eval_dimensions=JSONB，methodology_ids/dispositions=TEXT[]

// 可编辑字段白名单（scenario_id/stage/trigger 锁定，不动引擎路由）
export const EDITABLE_FIELDS = [
  'description', 'methodology_ids', 'eval_dimensions', 'default_tier', 'autonomous_allowed', 'dispositions',
];
export const TIERS = ['LEAD', 'NORMAL', 'HIGH'];
export const DISPOSITIONS = ['APPROVE', 'REJECT', 'ESCALATE', 'OVERRIDE', 'EXCEPTION'];

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// JSONB/TEXT[] 数据防御：历史/演示数据可能把 eval_dimensions 写成对象或字符串
function asArray(v) {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'string') {
    try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; }
  }
  return [];
}

// 校验 PUT body 的 patch；返回 { ok, errors, normalized }
export function validateScenarioPatch(patch = {}) {
  const keys = Object.keys(patch || {});
  const unknown = keys.filter((k) => !EDITABLE_FIELDS.includes(k));
  if (unknown.length) {
    return { ok: false, errors: [`不可编辑字段: ${unknown.join(', ')}（仅 ${EDITABLE_FIELDS.join('/')} 可改）`] };
  }
  if (!keys.length) return { ok: false, errors: ['无有效编辑字段'] };
  const errors = [];
  const n = {};
  if ('description' in patch) {
    if (typeof patch.description !== 'string' || patch.description.length > 500) errors.push('description 须为 ≤500 字字符串');
    else n.description = patch.description;
  }
  if ('default_tier' in patch) {
    if (!TIERS.includes(patch.default_tier)) errors.push(`default_tier 须为 ${TIERS.join('/')}`);
    else n.default_tier = patch.default_tier;
  }
  if ('autonomous_allowed' in patch) {
    n.autonomous_allowed = !!patch.autonomous_allowed;
  }
  if ('methodology_ids' in patch) {
    const arr = Array.isArray(patch.methodology_ids)
      ? patch.methodology_ids
      : String(patch.methodology_ids || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!arr.every((x) => typeof x === 'string' && x)) errors.push('methodology_ids 须为字符串数组');
    else n.methodology_ids = arr;
  }
  if ('eval_dimensions' in patch) {
    const arr = Array.isArray(patch.eval_dimensions)
      ? patch.eval_dimensions
      : (() => { try { return JSON.parse(patch.eval_dimensions); } catch { return null; } })();
    if (!Array.isArray(arr)) errors.push('eval_dimensions 须为数组/JSON 数组');
    else if (
      !arr.every(
        (d) => d && typeof d.cond === 'string' && typeof d.label === 'string' && typeof d.weight === 'number' && isFinite(d.weight) && d.weight >= 0
      )
    ) errors.push('eval_dimensions 每项须 {cond:string,label:string,weight:number≥0}');
    else n.eval_dimensions = arr;
  }
  if ('dispositions' in patch) {
    const arr = Array.isArray(patch.dispositions)
      ? patch.dispositions
      : String(patch.dispositions || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!arr.every((x) => DISPOSITIONS.includes(x))) errors.push(`dispositions 须为 ${DISPOSITIONS.join('/')} 子集`);
    else n.dispositions = arr;
  }
  return { ok: errors.length === 0, errors, normalized: n };
}

function cardHtml(s) {
  const tier = s.default_tier;
  const tierCls = tier === 'HIGH' ? 'high' : tier === 'LEAD' ? 'lead' : 'norm';
  const auto = s.autonomous_allowed ? '✅自主' : '⛔人工';
  const methods = asArray(s.methodology_ids).map((m) => `<span class="tag">${esc(m)}</span>`).join('') || '—';
  const dims =
    asArray(s.eval_dimensions).map((d) => `<span class="chip" title="${esc(d?.label)}">${esc(d?.cond)} ${d?.weight ?? ''}</span>`).join('') || '—';
  // 9 尺子差异化（focus_rulers×1.5 加权 / enabled_rulers 真子集 / rubric_pass_line 及格线）
  // 字段在 db/schema.sql crm.decision_scenario 已存在；缺省降级（无值→占位）保证旧数据零迁移可用
  const focus = asArray(s.focus_rulers).map((x) => esc(typeof x === 'string' ? x : x?.key || '')).join('、') || '—';
  const enabled = asArray(s.enabled_rulers).map((x) => esc(typeof x === 'string' ? x : x?.key || '')).join('、') || '全 9 尺子';
  const pass = s.rubric_pass_line != null ? Number(s.rubric_pass_line).toFixed(2) : '出厂 0.5';
  return `<article class="ds-card" data-id="${esc(s.scenario_id)}">
    <div class="ds-head"><b>${esc(s.scenario_id)}</b><span class="badge ${tierCls}">${esc(tier)}</span><span class="badge">${auto}</span></div>
    <p class="ds-desc">${esc(s.description || '')}</p>
    <div class="ds-row"><span class="k">方法论</span>${methods}</div>
    <div class="ds-row"><span class="k">评估维</span>${dims}</div>
    <div class="ds-row"><span class="k">处置集</span>${asArray(s.dispositions).join(', ')}</div>
    <div class="ds-row"><span class="k">聚焦尺子</span>${focus} <span class="hint">（×1.5 加权）</span></div>
    <div class="ds-row"><span class="k">启用尺子</span>${enabled}</div>
    <div class="ds-row"><span class="k">及格线</span>${pass}</div>
    <button class="btn edit" data-id="${esc(s.scenario_id)}">编辑</button>
  </article>`;
}

// 按 stage 分组的只读卡片渲染（向后兼容：test/web/decisionScenario.test.js 仍断言其全量内容）
export function renderDecisionScenarios(scenarios = []) {
  if (!scenarios.length) return '<div class="empty">无决策场景配置</div>';
  const byStage = {};
  for (const s of scenarios) (byStage[s.stage] ||= []).push(s);
  return Object.entries(byStage)
    .map(
      ([stage, list]) => `<section class="ds-stage" data-stage="${esc(stage)}">
        <h3>${esc(stage)} <span class="cnt">${list.length}</span></h3>
        <div class="ds-grid">${list.map(cardHtml).join('')}</div>
      </section>`
    )
    .join('');
}

// ════════════════════════════════════════════════════════════════════════
// §2026-09-04 TAB 视图（销售漏斗 stage 分组，按 brainstorming 批准方案实施）
// 仅暴露 8 销售 stage；平台治理 meta / TRACE 不进销售视角。
// ════════════════════════════════════════════════════════════════════════

// 9 尺子全集（供 TAB 视图 chip 多选 + 卡片展示）
export const ALL_RULERS = ['clarity', 'relevance', 'logic', 'depth', 'breadth', 'precision', 'importance', 'originality', 'fairness'];

// 8 销售 stage 自然序（左→右 一→八；与 seed 顺序一致）
export const SALES_STAGE_ORDER = [
  '一、线索', '二、机会评估', '三、客户策略', '四、方案价值',
  '五、商务报价', '六、签单前风险', '七、终局决策', '八、丢单复盘',
];

// 精简卡片（TAB 视图）：聚焦尺子 / 启用尺子 / 及格线 / 简短描述四要素
// 方法论 / 评估维 / 处置集进「编辑」弹窗（默认折叠，不删）
export function cardHtmlSimple(s) {
  const tier = s.default_tier;
  const tierCls = tier === 'HIGH' ? 'high' : tier === 'LEAD' ? 'lead' : 'norm';
  const auto = s.autonomous_allowed ? '✅自主' : '⛔人工';
  const desc = String(s.description || '').slice(0, 40);
  const focus = asArray(s.focus_rulers).map((x) => esc(typeof x === 'string' ? x : x?.key || '')).join('、') || '—';
  const enArr = asArray(s.enabled_rulers);
  const isSubset = enArr.length > 0; // 非空=跑了子集（<9 尺子）
  const enLabel = isSubset ? `${enArr.length} 尺子（子集）` : '全 9 尺子';
  const enCls = isSubset ? 'subset' : 'full';
  const pass = s.rubric_pass_line != null ? Number(s.rubric_pass_line).toFixed(2) : '0.50';
  const diffDot = isSubset ? '<span class="diff-dot" title="启用尺子&lt;9，跑了子集评分">●</span>' : '';
  return `<article class="ds-card simple" data-id="${esc(s.scenario_id)}">
    <div class="ds-head"><b>${esc(s.scenario_id)}</b><span class="badge ${tierCls}">${esc(tier)}</span><span class="badge">${auto}</span>${diffDot}</div>
    <p class="ds-desc">${esc(desc)}</p>
    <div class="ds-row"><span class="k">聚焦</span>${focus} <span class="hint">×1.5</span></div>
    <div class="ds-row"><span class="k">启用</span><span class="${enCls}">${enLabel}</span></div>
    <div class="ds-row"><span class="k">及格</span>${pass}</div>
    <button class="btn edit" data-id="${esc(s.scenario_id)}">编辑</button>
  </article>`;
}

// 顶部 TAB 栏：只列 8 销售 stage（白名单），当前 stage 加 active
export function renderScenarioTabs(scenarios, activeStage) {
  const present = new Set(scenarios.map((s) => s.stage));
  const tabs = SALES_STAGE_ORDER.filter((st) => present.has(st));
  if (!tabs.length) return '';
  return `<div class="ds-tabs" role="tablist">${tabs
    .map((st) => `<button class="ds-tab${st === activeStage ? ' active' : ''}" data-stage="${esc(st)}" role="tab">${esc(st)}</button>`)
    .join('')}</div>`;
}

// 当前 stage 卡片网格（已是单 stage）；diffOnly=true 仅显示差异化（enabled 子集）场景
export function renderStageCards(scenarios, stage, opts = {}) {
  const { diffOnly = false } = opts;
  let list = scenarios.filter((s) => s.stage === stage);
  if (!list.length) return '<div class="empty">该阶段暂无场景</div>';
  if (diffOnly) {
    list = list.filter((s) => asArray(s.enabled_rulers).length > 0);
    if (!list.length) return '<div class="empty">暂无差异化场景（全部跑全 9 尺子）</div>';
  }
  return `<div class="ds-grid">${list.map(cardHtmlSimple).join('')}</div>`;
}
