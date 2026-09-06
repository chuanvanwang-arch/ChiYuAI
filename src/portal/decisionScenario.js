// src/portal/decisionScenario.js — 销售决策场景配置（第 14 项，端点 + 可编辑）
// 渲染纯函数（浏览器 + vitest 共用） + 表驱动 GET/PUT 端点（决策第0闸 + 字段白名单校验）
// 设计输入：docs/superpowers/plans/2026-08-27-decision-scenario-config.md
// 后端事实：crm.decision_scenario（db/schema.sql 决策事件主轴段）；eval_dimensions=JSONB，methodology_ids/dispositions=TEXT[]
import { Router } from 'express';
import { query, queryWrite } from '../db.js';
import { recordDecisionEvent } from '../decision/decisionRepo.js';
import { DIM_KEYS } from '../sevenDimensions/constants.js';
import { scopeTenant, scopeOf } from '../http/tenantScope.js';

// 可编辑字段白名单（scenario_id/stage/trigger 锁定，不动引擎路由）
export const EDITABLE_FIELDS = [
  'description', 'methodology_ids', 'eval_dimensions', 'default_tier', 'autonomous_allowed', 'dispositions',
  'required_dims', 'focus_rulers', 'rubric_pass_line', 'enabled_rulers',
];
export const TIERS = ['LEAD', 'NORMAL', 'HIGH'];
export const DISPOSITIONS = ['APPROVE', 'REJECT', 'ESCALATE', 'OVERRIDE', 'EXCEPTION'];
export const ON_MISSING = ['warn', 'block'];

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
  if ('required_dims' in patch) {
    const arr = patch.required_dims;
    if (!Array.isArray(arr)) {
      errors.push('required_dims 须为数组');
    } else {
      const seen = new Set();
      let firstBad = null;
      const normalized = [];
      for (const d of arr) {
        if (!d || typeof d.dim !== 'string' || !DIM_KEYS.includes(d.dim)) {
          firstBad = `未知维度: ${d?.dim}（仅 ${DIM_KEYS.join('/')}）`;
          break;
        }
        if (seen.has(d.dim)) { firstBad = `维度重复: ${d.dim}`; break; }
        seen.add(d.dim);
        const om = d.on_missing || 'warn';
        if (!ON_MISSING.includes(om)) { firstBad = `${d.dim} 的 on_missing 须为 ${ON_MISSING.join('/')}`; break; }
        normalized.push({ dim: d.dim, on_missing: om });
      }
      if (firstBad) errors.push(firstBad);
      else n.required_dims = normalized;
    }
  }
  if ('focus_rulers' in patch) {
    const arr = Array.isArray(patch.focus_rulers) ? patch.focus_rulers : (() => { try { return JSON.parse(patch.focus_rulers); } catch { return null; } })();
    if (!Array.isArray(arr)) errors.push('focus_rulers 须为数组/JSON 数组');
    else if (!arr.every((x) => x && (typeof x === 'string' || (typeof x === 'object' && typeof x.key === 'string')))) errors.push('focus_rulers 每项须为尺子 key 字符串或 {key}');
    else n.focus_rulers = arr;
  }
  if ('enabled_rulers' in patch) {
    const arr = Array.isArray(patch.enabled_rulers) ? patch.enabled_rulers : (() => { try { return JSON.parse(patch.enabled_rulers); } catch { return null; } })();
    if (!Array.isArray(arr)) errors.push('enabled_rulers 须为数组/JSON 数组');
    else if (!arr.every((x) => x && (typeof x === 'string' || (typeof x === 'object' && typeof x.key === 'string')))) errors.push('enabled_rulers 每项须为尺子 key 字符串或 {key}');
    else n.enabled_rulers = arr;
  }
  if ('rubric_pass_line' in patch) {
    const v = Number(patch.rubric_pass_line);
    if (!isFinite(v) || v < 0 || v > 1) errors.push('rubric_pass_line 须为 0–1 数值（及格线比例）');
    else n.rubric_pass_line = v;
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

// 按 stage 分组的只读卡片渲染
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

// ---- 端点 ----
// 2026-09-05 G5：读取按 scopeTenant(me)（admin '*' → 全量），写按 scopeOf(me)（永不通配，admin 写自身租户）。
//   场景行 PK=(scenario_id, tenant_id)：租户缺键时由 updateScenario 先复制 system 模板（INSERT...SELECT ON CONFLICT DO NOTHING）。
const defaultDeps = {
  listScenarios: async ({ tenantId = '*' } = {}) => {
    if (tenantId === '*') {
      return (await query(`SELECT * FROM crm.decision_scenario ORDER BY stage, scenario_id, tenant_id`)).rows;
    }
    return (await query(
      `SELECT * FROM crm.decision_scenario WHERE tenant_id=$1 OR tenant_id='system'
       ORDER BY (tenant_id=$1) DESC, stage, scenario_id`,
      [tenantId]
    )).rows;
  },
  listSkillIds: async () =>
    (await query(`SELECT skill_id FROM crm.skill_registry WHERE enabled=true`)).rows.map((r) => r.skill_id),
  updateScenario: async (scenario_id, patch, { tenantId = 'system' } = {}) => {
    // 按列类型分派 CAST（G1：methodology_ids/dispositions 是 TEXT[] 非 JSONB）。
    // 传原始 JS 值（不 JSON.stringify）：node-postgres 按列类型自动序列化字符串→text、数组→text[]、布尔→bool、对象→jsonb。
    const COL_CAST = {
      description: 'text',
      default_tier: 'text',
      autonomous_allowed: 'bool',
      methodology_ids: 'text[]',
      dispositions: 'text[]',
      eval_dimensions: 'jsonb',
      required_dims: 'jsonb',
      focus_rulers: 'jsonb',
      rubric_pass_line: 'real',
      enabled_rulers: 'jsonb',
    };
    // 1) 租户缺键时先复制 system 模板（幂等；禁 DELETE，只插不删）
    await queryWrite(
      `INSERT INTO crm.decision_scenario
         (scenario_id, stage, description, trigger, methodology_ids, eval_dimensions,
          default_tier, autonomous_allowed, dispositions, tenant_id)
       SELECT scenario_id, stage, description, trigger, methodology_ids, eval_dimensions,
              default_tier, autonomous_allowed, dispositions, $2
       FROM crm.decision_scenario WHERE scenario_id=$1 AND tenant_id='system'
       ON CONFLICT (scenario_id, tenant_id) DO NOTHING`,
      [scenario_id, tenantId]
    );
    // 2) 租户限定 UPDATE（写池 queryWrite；原 query 读池写是隐患，一并修复）
    // 参数布局：$1=scenario_id、$2=tenantId、$3+=patch 值（set 从 $3 起）
    const entries = Object.entries(patch);
    const sets = entries.map(([k], i) => `${k}=$${i + 3}::${COL_CAST[k]}`).join(', ');
    const r = await queryWrite(
      `UPDATE crm.decision_scenario SET ${sets} WHERE scenario_id=$1 AND tenant_id=$2 RETURNING *`,
      [scenario_id, tenantId, ...entries.map(([k, v]) => (COL_CAST[k] === 'jsonb' ? JSON.stringify(v) : v))]
    );
    return r.rows[0];
  },
  produceDecision: async (ctx) => {
    // 配置变更不进业务决策引擎（决策引擎无 config-change 场景，仅 8 个业务决策场景）。
    // 直接沉淀 config_change 治理事件 —— 满足「决策第0闸」：每条写操作携带 decision_id
    // （此处即 config_change 事件的 event_id，作为该次配置变更的可审计决策凭证）。
    const row = await recordDecisionEvent('config_change', {
      scenario_id: ctx?.scenario_id || null,
      trigger_context: { fields: ctx?.fields || [] },
    });
    return { decisionId: row?.event_id || null, ok: true };
  },
};

export function createDecisionScenarioRouter(deps = {}) {
  const D = { ...defaultDeps, ...deps, resolveMe: deps.resolveMe || ((req) => null) };
  const router = Router();

  const handlers = {
    get: async (req, res) => {
      try {
        const me = D.resolveMe(req);
        const tenantId = scopeTenant(me && me.ok ? me : null);
        res.json({ scenarios: await D.listScenarios({ tenantId }) });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    },
    put: async (req, res) => {
      try {
        const { scenario_id, patch } = req.body || {};
        if (!scenario_id) return res.status(400).json({ error: 'scenario_id 必填' });
        const v = validateScenarioPatch(patch);
        if (!v.ok) return res.status(400).json({ error: v.errors.join('; ') });
        // 跨 skill_registry 校验 methodology_ids 防悬空引用
        if (D.listSkillIds && v.normalized.methodology_ids) {
          const valid = new Set(await D.listSkillIds());
          const bad = v.normalized.methodology_ids.filter((m) => !valid.has(m));
          if (bad.length) return res.status(400).json({ error: `未知方法论 SKILL: ${bad.join(', ')}（须已在 skill_registry 启用）` });
        }
        const me = D.resolveMe(req);
        const tenantId = scopeOf(me && me.ok ? me : null);
        const decision = await D.produceDecision({ scenario_id, fields: Object.keys(v.normalized), tenantId });
        const row = await D.updateScenario(scenario_id, v.normalized, { tenantId });
        if (!row) return res.status(404).json({ error: `未知 scenario_id: ${scenario_id}` });
        res.json({ ok: true, row, decision: decision?.decisionId || null });
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    },
  };

  router.get('/api/decision-scenarios', handlers.get);
  router.put('/api/decision-scenarios', handlers.put);
  router.handlers = handlers; // 注入式测试
  return router;
}

// 供 sevenDimRouter / 未来矩阵端点复用「校验 + 第0闸 + 写库」单一内核，避免口径漂移
export { defaultDeps as scenarioDeps };
