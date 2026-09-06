# 第 14 项 销售决策场景配置（端点 + 可编辑）

> 设计输入：配置中心统一入口审计（2026-08-27）→ 用户选「配置中心下一个待建设项」→ 第14项 决策场景配置 → 形态选「端点+可编辑（高风险）」。
> 复用范式：`src/portal/rbacMatrix.js`（createRbacRouter 可测试 handler + 决策第0闸）、`src/portal/configCenter.js`（第14卡翻转）。
> 后端事实：`crm.decision_scenario` 表（db/schema.sql 决策事件主轴段）8 列 + db/seed.sql 幂等注入 8 行；当前**无端点**，configCenter 第14卡 status=`pending`。

## 0. 范围与风险边界（HARD-GATE 前置）

决策场景配置直接驱动三大引擎消费方，编辑即改变系统治理行为：
- `autonomyEngine.js` `requireDecision(scenario_id)` 读 `default_tier`/`autonomous_allowed`/`dispositions` 决定自主边界与处置集；
- `sevenDimensions/engine.js` 读 `required_dims`（migrate-config.sql 加列）；
- `monitorStore.js` 读 `eval_dimensions` 做七维覆盖判定。

**风险关笼策略（用户拍板"可编辑"但必须受控）**：
1. **写必经决策第0闸**：PUT 调 `requireDecision('config-change', {scenario_id, fields})`，失败降级 `recordDecisionEvent('config_change')`（与 RBAC 同款，见 rbacMatrix.js:136-144）。每次改配置都沉淀为决策事件（记忆生命周期治理）。
2. **字段白名单**：仅以下 6 字段可编辑，主键与引擎路由字段锁定：
   - 可编辑：`description`(text) / `methodology_ids`(TEXT[]) / `eval_dimensions`(JSONB) / `default_tier`(LEAD|NORMAL|HIGH) / `autonomous_allowed`(bool) / `dispositions`(TEXT[])
   - **锁定（不在 UI/PUT 范围）**：`scenario_id`(PK) / `stage`(L1–L4 管道映射，核心) / `trigger`(引擎触发条件，改之破坏路由)
3. **服务端校验**：非法值 400 拒绝，绝不落库半截数据。
4. seed 用 `ON CONFLICT (scenario_id) DO NOTHING`——手动编辑后重跑 `npm run seed` **不会**覆盖人工配置（符合"配置以库内为准"）。

## 1. 后端模块 `src/portal/decisionScenario.js`（ESM，浏览器+vitest 共用）

### 1.1 常量与校验
```js
export const EDITABLE_FIELDS = ['description','methodology_ids','eval_dimensions','default_tier','autonomous_allowed','dispositions'];
export const TIERS = ['LEAD','NORMAL','HIGH'];
export const DISPOSITIONS = ['APPROVE','REJECT','ESCALATE','OVERRIDE','EXCEPTION'];

// 校验 PUT body 的 patch；返回 { ok, errors, normalized }
export function validateScenarioPatch(patch = {}) {
  const keys = Object.keys(patch);
  const unknown = keys.filter(k => !EDITABLE_FIELDS.includes(k));
  if (unknown.length) return { ok:false, errors:[`不可编辑字段: ${unknown.join(', ')}（仅 ${EDITABLE_FIELDS.join('/')} 可改）`] };
  if (!keys.length) return { ok:false, errors:['无有效编辑字段'] };
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
    const arr = Array.isArray(patch.methodology_ids) ? patch.methodology_ids : String(patch.methodology_ids||'').split(',').map(s=>s.trim()).filter(Boolean);
    if (!arr.every(x => typeof x === 'string' && x)) errors.push('methodology_ids 须为字符串数组');
    else n.methodology_ids = arr; // 跨 skill_registry 校验交由 deps.validateSkills（见 1.3）
  }
  if ('eval_dimensions' in patch) {
    const arr = Array.isArray(patch.eval_dimensions) ? patch.eval_dimensions : (()=>{ try { return JSON.parse(patch.eval_dimensions); } catch { return null; } })();
    if (!Array.isArray(arr)) errors.push('eval_dimensions 须为数组/JSON 数组');
    else if (!arr.every(d => d && typeof d.cond==='string' && typeof d.label==='string' && typeof d.weight==='number' && isFinite(d.weight) && d.weight>=0))
      errors.push('eval_dimensions 每项须 {cond:string,label:string,weight:number≥0}');
    else n.eval_dimensions = arr;
  }
  if ('dispositions' in patch) {
    const arr = Array.isArray(patch.dispositions) ? patch.dispositions : String(patch.dispositions||'').split(',').map(s=>s.trim()).filter(Boolean);
    if (!arr.every(x => DISPOSITIONS.includes(x))) errors.push(`dispositions 须为 ${DISPOSITIONS.join('/')} 子集`);
    else n.dispositions = arr;
  }
  return { ok: errors.length===0, errors, normalized: n };
}
```

### 1.2 渲染（只读卡片，按 stage 分组）
```js
export function renderDecisionScenarios(scenarios = []) {
  if (!scenarios.length) return `<div class="empty">无决策场景配置</div>`;
  const byStage = {};
  for (const s of scenarios) (byStage[s.stage] ||= []).push(s);
  return Object.entries(byStage).map(([stage, list]) => `
    <section class="ds-stage" data-stage="${esc(stage)}"><h3>${esc(stage)} <span class="cnt">${list.length}</span></h3>
      <div class="ds-grid">${list.map(cardHtml).join('')}</div>
    </section>`).join('');
}
function cardHtml(s) {
  const tier = s.default_tier, auto = s.autonomous_allowed ? '✅自主' : '⛔人工';
  const methods = (s.methodology_ids||[]).map(m=>`<span class="tag">${esc(m)}</span>`).join('') || '—';
  const dims = (s.eval_dimensions||[]).map(d=>`<span class="chip" title="${esc(d.label)}">${esc(d.cond)} ${d.weight}</span>`).join('') || '—';
  return `<article class="ds-card" data-id="${esc(s.scenario_id)}">
    <div class="ds-head"><b>${esc(s.scenario_id)}</b><span class="badge ${tier==='HIGH'?'high':tier==='LEAD'?'lead':'norm'}">${esc(tier)}</span><span class="badge">${auto}</span></div>
    <p class="ds-desc">${esc(s.description||'')}</p>
    <div class="ds-row"><span class="k">方法论</span>${methods}</div>
    <div class="ds-row"><span class="k">评估维</span>${dims}</div>
    <div class="ds-row"><span class="k">处置集</span>${(s.dispositions||[]).join(', ')}</div>
    <button class="btn edit" data-id="${esc(s.scenario_id)}">编辑</button>
  </article>`;
}
```

### 1.3 路由（GET 读 + PUT 编辑，决策第0闸）
```js
const defaultDeps = {
  listScenarios: async () => (await query(`SELECT * FROM crm.decision_scenario ORDER BY stage, scenario_id`)).rows,
  listSkillIds: async () => (await query(`SELECT skill_id FROM crm.skill_registry WHERE enabled=true`)).rows.map(r=>r.skill_id),
  updateScenario: async (scenario_id, patch) => {
    // 按列类型分派 CAST（G1：methodology_ids/dispositions 是 TEXT[] 非 JSONB）
    const COL_CAST = {
      description: 'text', default_tier: 'text', autonomous_allowed: 'bool',
      methodology_ids: 'text[]', dispositions: 'text[]', eval_dimensions: 'jsonb',
    };
    const entries = Object.entries(patch);
    const sets = entries.map(([k,i])=>`${k}=$${i+2}::${COL_CAST[k]}`).join(', ');
    const r = await query(`UPDATE crm.decision_scenario SET ${sets}, updated_at=now() WHERE scenario_id=$1 RETURNING *`,
      [scenario_id, ...entries.map(([k,v]) => k==='autonomous_allowed' ? v : JSON.stringify(v))]);
    return r.rows[0];
  },
  produceDecision: async (ctx) => { try { const r = await requireDecision('config-change', ctx); return { decisionId: r.decision_id||null, ok:true }; } catch { await recordDecisionEvent('config_change', { trigger_context: ctx }); return { decisionId:null, ok:true }; } },
};
export function createDecisionScenarioRouter(deps = {}) {
  const D = { ...defaultDeps, ...deps };
  const router = Router();
  const handlers = {
    get: async (req,res) => { try { res.json({ scenarios: await D.listScenarios() }); } catch(e){ res.status(500).json({error:e.message}); } },
    put: async (req,res) => {
      try {
        const { scenario_id, patch } = req.body || {};
        if (!scenario_id) return res.status(400).json({ error:'scenario_id 必填' });
        const v = validateScenarioPatch(patch);
        if (!v.ok) return res.status(400).json({ error: v.errors.join('; ') });
        // 跨 skill_registry 校验 methodology_ids 防悬空引用（若 deps 提供）
        if (D.listSkillIds && v.normalized.methodology_ids) {
          const valid = new Set(await D.listSkillIds());
          const bad = v.normalized.methodology_ids.filter(m=>!valid.has(m));
          if (bad.length) return res.status(400).json({ error:`未知方法论 SKILL: ${bad.join(', ')}（须已在 skill_registry 启用）` });
        }
        const decision = await D.produceDecision({ scenario_id, fields: Object.keys(v.normalized) });
        const row = await D.updateScenario(scenario_id, v.normalized);
        if (!row) return res.status(404).json({ error:`未知 scenario_id: ${scenario_id}` });
        res.json({ ok:true, row, decision: decision?.decisionId || null });
      } catch(e){ res.status(400).json({ error:e.message }); }
    },
  };
  router.get('/api/decision-scenarios', handlers.get);
  router.put('/api/decision-scenarios', handlers.put);
  router.handlers = handlers;
  return router;
}
```

> 注：`updateScenario` 用 `SET ${k}=$${i+2}::jsonb` 全字段 JSONB 化（TEXT[]/bool 亦存 JSONB，与表列类型兼容：PG 会把 `'["BANT"]'::jsonb` 写入 TEXT[]？——**风险点**：`methodology_ids` 是 `TEXT[]` 不是 JSONB。见 §4 GAP G1，必须按列类型分派 CAST。

## 2. 前端页 `src/web/decision-scenarios.html`（新）

- `#ds-root` + `<script type="module">` import `* as ds` 挂 `renderDecisionScenarios`；`load()` fetch `/api/decision-scenarios` 注入；`setInterval(load, 15000)` 刷新；失败降级。
- 每卡「编辑」按钮 → 切换行内表单（description input / tier select / autonomous checkbox / methodology_ids 逗号输入 / eval_dimensions textarea(JSON) / dispositions 多选）→「保存」PUT `/api/decision-scenarios` → 成功提示 decision_id（决策事件沉淀）、失败显 error。
- nav.js 侧栏增 `⚖ 决策场景 → /decision-scenarios.html`。

## 3. 路由挂载 `src/http/routes.js`

对齐 RBAC（routes.js: `import { createRbacRouter }` + `app.use(createRbacRouter({}))` + `/rbac.html`+`/rbac`+`/portal/rbacMatrix.js`）：
- 顶部 import 加 `import { createDecisionScenarioRouter } from '../portal/decisionScenario.js';`
- 配置中心挂载区加 `app.use(createDecisionScenarioRouter({}));`
- 静态：`app.get('/decision-scenarios.html', sendFile)` + `app.get('/decision-scenarios', redirect)` + `app.get('/portal/decisionScenario.js', sendFile, Content-Type text/javascript)`

## 4. 配置中心卡翻转 `src/portal/configCenter.js`

第14卡 `pending` → `ready`：
```js
{ id: 14, name: '销售决策场景配置', group: '集成', status: 'ready', page: '/decision-scenarios.html', endpoint: '/api/decision-scenarios', note: '8 场景可编辑（描述/方法论/评估维/默认分级/自主开关/处置集），写经决策第0闸' }
```

## 5. 测试 `test/web/decisionScenario.test.js`（TDD RED→GREEN）

- GET `/api/decision-scenarios` → 200 + `scenarios` 数组长度 8 + 含 `LEAD_FOLLOW_UP`。
- PUT 改 `description` → 200 + `row.description` 已更新 + `decision` 字段存在。
- PUT `default_tier:'XXX'` → 400 + error 含「default_tier」。
- PUT 带 `scenario_id`(锁定字段) → 400 + error 含「不可编辑字段」。
- PUT 未知 `methodology_ids:['NO_SUCH']`（若 listSkillIds 启用） → 400 + error 含「未知方法论」。
- 静态页 `/decision-scenarios.html` → 200 含 `id="ds-root"`。
- 纯函数单测：`validateScenarioPatch` 正常/非法 tier/锁定字段/坏 eval_dimensions JSON 四类。

## 6. GAP（实现期必处理）

- **G1（关键）**：`methodology_ids` 表列是 `TEXT[]` 非 JSONB；`updateScenario` 的 `SET ${k}=$${i+2}::jsonb` 对 TEXT[] 会类型错。须按列分派 CAST：`methodology_ids`/`dispositions` 用 `::text[]`、`default_tier` 用 `::text`、`autonomous_allowed` 用 `::bool`、`eval_dimensions`/`trigger` 用 `::jsonb`、`description` 用 `::text`。实现时 `updateScenario` 按 `COL_CAST` 映射生成占位符。
- **G2**：`eval_dimensions` 列类型是 `JSONB NOT NULL`（schema.sql），编辑后写入须合法 JSONB 数组，校验已覆盖。
- **G3**：`required_dims` 列（migrate-config.sql 加，默认 `[]`）当前 seed 未填；本次编辑不触碰（不在白名单），留待阶段2 记忆层。不引入回归。

## 7. 验收口径

- 单测 `test/web/decisionScenario.test.js` ≥ 7 例全绿；`node --check` 三文件通过。
- 起服务冒烟：`/decision-scenarios`→302、`/decision-scenarios.html`→200、`/portal/decisionScenario.js`→200、`GET /api/decision-scenarios`→8 行、`PUT` 改 `description` 落库 + 决策事件入 `decision_event` 表。
- 配置中心 `/config` 第14卡显示「✅ 已就绪」+「打开」链接。
- 回归 `test/web/` 全量无破坏。

## 8. 提交建议（沙箱无凭证，AI 不 commit）

`src/portal/decisionScenario.js`(新) + `test/web/decisionScenario.test.js`(新) + `src/web/decision-scenarios.html`(新) + `src/http/routes.js`(改) + `src/portal/configCenter.js`(改) + `src/web/nav.js`(改) + 本计划文档。
建议：`git commit -m "feat(config): 第14项 决策场景配置页（GET/PUT + 决策第0闸 + 字段白名单校验）"`。
