# CRM-ai-native 前台 + 配置中心 33 面 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将已批准的主蓝图（`docs/2026-08-26-frontend-config-pages-master-blueprint.md`）落地为 33 个受控面（S01–S33），全部经统一 Schema 渲染器渲染，配置面与业务页共用 `src/page/renderer.js`，写操作经第 0 闸（带 `decision_id`），决策相关面共用 `sevenDimensionsCheck` 引擎。

**Architecture:** 引入「受控面注册表 + 配置端点通用路由 + 七维校验引擎 + 权限组合器」四件共享基础设施；每个面 = 一份受控 Schema 契约（注册进 `src/pages/`）+ 一个数据端点（配置面走 `configRouter` 通用助手，业务详情面走 `particleDetailRouter` 复用既有 `/api/particles/:id`）。渲染、四态、SSE 单连接、RBAC 全部复用既有实现，不手写 HTML 旁路。

**Tech Stack:** Node 22 ESM + Express 4 + PostgreSQL 16（`crm` schema，`127.0.0.1:5433` 复用 plm 实例）+ 既有 `src/page/*` 渲染器 + vitest 3（single worker，`fileParallelism:false`）+ `pg` 连接池。

**决策基线（HARD-GATE 已锁定）：** D1 覆盖全 33 面；D2 全量 Schema 渲染；D3 七维=决策场景级完整性校验（S20）；D4 方案 A 统一模板逐面深做。

---

## §0 文件结构（全部新建/修改清单）

**新建共享基础设施：**
- `src/sevenDimensions/constants.js` — `SEVEN_DIMS` 七维常量（唯一源，D3）
- `src/sevenDimensions/engine.js` — `sevenDimensionsCheck(scenarioId, ctx)`
- `src/page/permissionComposer.js` — `composeAttrFields(particleType, role, fields)` 用 `fieldPermission#modeFor` + `roleProfiles`
- `src/pages/registry.js` — `registerPage(id, schema)` / `getPage(id)` / `allPages()`
- `src/pages/index.js` — 33 面 schema 注册入口（按 Phase 分段 import）
- `src/http/configRouter.js` — `defineConfigEndpoint({key, role, decisionScene})` 通用 GET/PUT `/api/config/:key`
- `src/http/particleDetailRouter.js` — 复用既有 `/api/particles/:id` 的 detail 面装配
- `db/migrate-config.sql` — 配置相关表（幂等）

**修改既有文件：**
- `src/page/schema.js:43` — 扩展 `CANONICAL_NAV`（§1.2 全量）
- `src/page/renderer.js` — 补全四态 `loading/empty/error/partial` 注入与 `navigation.to` 校验
- `src/http/routes.js` — 挂载 `configRouter` 与 `particleDetailRouter`，新增 `/api/config/*`
- `src/context/roleProfiles.js` — 确认六角色导出（含 `presales`）
- `package.json` / `vitest.config.js` — 维持现有 test 配置（不改动）

**测试：**
- `test/sevenDimensions/engine.test.js`
- `test/page/permissionComposer.test.js`
- `test/page/registry.test.js`
- `test/http/configRouter.test.js`
- `test/pages/S01..S33.test.js`（每面 1 个契约测试，断言 schema 合法 + 端点返回 schema 形态数据）

---

## §1 共享基础设施任务

### Task 1: 扩展 CANONICAL_NAV 枚举

**Files:**
- Modify: `src/page/schema.js:43`（`CANONICAL_NAV` 数组）
- Test: `test/page/canonicalNav.test.js`

- [ ] **Step 1: 写失败测试**

```js
import { CANONICAL_NAV } from '../../src/page/schema.js';
test('config + detail paths present', () => {
  for (const p of ['/config/seven-dim','/config/rbac','/accounts/:id','/deals/:id','/business-board']) {
    expect(CANONICAL_NAV).toContain(p);
  }
});
```

- [ ] **Step 2: 运行测试确认失败** — `node node_modules/vitest/vitest.mjs run test/page/canonicalNav.test.js` → FAIL（路径缺失）

- [ ] **Step 3: 修改 schema.js**

将 `export const CANONICAL_NAV = [...]` 替换为蓝图 §1.2 全量（含 `/config/llm`…`/config/system` 与 `/home /agents /todo /business-board /decision-graph /accounts/:id /deals/:id /quotations/:id /contracts/:id /orders/:id /payments/:id /invoices/:id /particles/:id /workspace`）。

- [ ] **Step 4: 运行测试通过** → PASS

- [ ] **Step 5: 提交**
```bash
git add src/page/schema.js test/page/canonicalNav.test.js
git commit -m "feat(page): extend CANONICAL_NAV with config center + detail paths (S01-S33)"
```

### Task 2: renderer 四态注入 + navigation.to 校验

**Files:**
- Modify: `src/page/renderer.js`
- Test: `test/page/renderer.test.js`

- [ ] **Step 1: 写失败测试**

```js
import { renderPage, validatePageSchema } from '../../src/page/renderer.js';
test('rejects navigation.to not in CANONICAL_NAV', () => {
  const bad = { pageType:'detail', components:[], navigation:{ to:'/nope' } };
  expect(() => validatePageSchema(bad)).toThrow(/CANONICAL_NAV/);
});
test('renders loading state when data.state=loading', () => {
  const s = { pageType:'dashboard', components:[{kind:'metric-card',title:'x'}], navigation:{to:'/dashboard'} };
  const { html } = renderPage(s, { state:'loading' });
  expect(html).toContain('loading');
});
test('attr-field renders source badge from sourceClassify', () => {
  const attr = { slug:'industry', data_origin:'external', sourcedFrom:{relation_confidence:0.8} };
  const s = { pageType:'detail', components:[{kind:'attr-field', attr}], navigation:{to:'/accounts/1'} };
  const { html } = renderPage(s, { state:'partial' });
  expect(html).toContain('data-origin-external');      // 四查徽标
});
test('attr-field orphan (no data_origin) renders unverified + disabled', () => {
  const attr = { slug:'note', data_origin:null };
  const s = { pageType:'detail', components:[{kind:'attr-field', attr}], navigation:{to:'/accounts/1'} };
  const { html } = renderPage(s, { state:'partial' });
  expect(html).toContain('unverified');
  expect(html).toContain('disabled');
});
```

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现**（在 `renderer.js` 的 `validatePageSchema` 增加 navigation.to 校验；`renderPage` 读取 `data.state` 注入 `loading/empty/error/partial` 包裹层，并保留现有 `escapeHtml` 与末层 `<script>` 剔除；**`attr-field` 组件内建四查徽标**：`import { sourceClassify } from '../../src/web/sourceClassify.js'`，渲染时对每个 `attr` 调用 `sourceClassify(attr)` 取 `data_origin`，输出 `data-origin-<origin>` 徽标，孤儿/未声明 `data_origin` 输出 `unverified` 且控件加 `disabled`）

- [ ] **Step 4: 运行通过**

- [ ] **Step 5: 提交**
```bash
git add src/page/renderer.js test/page/renderer.test.js
git commit -m "feat(page): add four-state injection + navigation.to validation + attr-field four-check badge"
```

### Task 3: SEVEN_DIMS 常量（D3 唯一源）

**Files:**
- Create: `src/sevenDimensions/constants.js`
- Test: `test/sevenDimensions/constants.test.js`

- [ ] **Step 1: 写失败测试**

```js
import { SEVEN_DIMS, DIM_KEYS } from '../../src/sevenDimensions/constants.js';
test('seven dims exact keys', () => {
  expect(DIM_KEYS).toEqual(['identity','structure','semantics','time_config','decision_history','operational_state','governance']);
});
```

- [ ] **Step 2: 运行失败**

- [ ] **Step 3: 实现**（常量内容来自蓝图 S20 表格）

```js
export const SEVEN_DIMS = [
  { key:'identity',          label:'身份',     desc:'客户/商机跨系统唯一身份是否一致' },
  { key:'structure',         label:'结构',     desc:'客户-商机-报价-合同-订单图谱关系可达' },
  { key:'semantics',         label:'语义',     desc:'赢单/丢单/有效商机等术语跨域定义一致' },
  { key:'time_config',       label:'时间与配置', desc:'决策生效时间窗/产品线/配置版本' },
  { key:'decision_history',  label:'决策历史',  desc:'历史否决方案/先例是否被检索' },
  { key:'operational_state', label:'运行状态',  desc:'当前销售运行态(库存/交付/竞品动态)' },
  { key:'governance',        label:'治理',     desc:'谁可批/谁负责/自主边界' },
];
export const DIM_KEYS = SEVEN_DIMS.map(d => d.key);
```

- [ ] **Step 4: 运行通过**

- [ ] **Step 5: 提交**

### Task 4: sevenDimensionsCheck 引擎

**Files:**
- Create: `src/sevenDimensions/engine.js`
- Test: `test/sevenDimensions/engine.test.js`

- [ ] **Step 1: 写失败测试**

```js
import { sevenDimensionsCheck } from '../../src/sevenDimensions/engine.js';
test('block when required dim missing with on_missing=block', async () => {
  const ctx = { structure:null, semantics:'ok' };
  const r = await sevenDimensionsCheck('scene-quote', ctx); // required_dims 设 identity/structure block
  expect(r.allowed).toBe(false);
  expect(r.level).toBe('block');
});
```

- [ ] **Step 2: 运行失败**

- [ ] **Step 3: 实现**

```js
import { pool } from '../../src/db/index.js';
export async function sevenDimensionsCheck(scenarioId, ctx) {
  const { rows } = await pool.query(
    `SELECT required_dims FROM crm.decision_scenario WHERE id=$1`, [scenarioId]);
  const required = rows[0]?.required_dims || [];
  const missing = [];
  for (const r of required) {
    const v = ctx?.[r.dim];
    if (v == null || v === '') missing.push({ dim: r.dim, on_missing: r.on_missing || 'warn' });
  }
  const blocked = missing.filter(m => m.on_missing === 'block');
  return {
    missing,
    level: blocked.length ? 'block' : (missing.length ? 'warn' : 'ok'),
    allowed: blocked.length === 0,
  };
}
```

- [ ] **Step 4: 运行通过**（测试用内存/ mock pool，见 `test/http/configRouter.test.js` 的 pool mock 模式）

- [ ] **Step 5: 提交**

### Task 5: permissionComposer（角色权限预解析）

**Files:**
- Create: `src/page/permissionComposer.js`
- Test: `test/page/permissionComposer.test.js`

- [ ] **Step 1: 写失败测试**

```js
import { composeAttrFields } from '../../src/page/permissionComposer.js';
test('maps hidden/readonly/edit from role', () => {
  const out = composeAttrFields('CRM_DEAL', 'sales', [{slug:'amount'},{slug:'secret_field'}]);
  expect(out[0].mode).toBeDefined(); // 'edit'|'readonly'|'hidden'
});
```

- [ ] **Step 2: 运行失败**

- [ ] **Step 3: 实现**（委托 `src/metaAttr/fieldPermission.js#modeFor` + `src/context/roleProfiles.js`）

```js
import { modeFor } from '../metaAttr/fieldPermission.js';
export function composeAttrFields(particleType, role, fields) {
  return fields.map(f => ({ ...f, mode: f.mode || modeFor(role, particleType, f.slug) }));
}
```

- [ ] **Step 4: 运行通过**

- [ ] **Step 5: 提交**

### Task 6: 受控面注册表

**Files:**
- Create: `src/pages/registry.js`, `src/pages/index.js`
- Test: `test/page/registry.test.js`

- [ ] **Step 1: 写失败测试**

```js
import { registerPage, getPage, allPages } from '../../src/pages/registry.js';
test('register and get', () => {
  registerPage('S01', { pageType:'dashboard', components:[], navigation:{to:'/home'} });
  expect(getPage('S01').pageType).toBe('dashboard');
  expect(allPages().length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: 运行失败**

- [ ] **Step 3: 实现 registry.js + index.js（index 在各 Phase 累积 import 各面 schema 文件）**

- [ ] **Step 4: 运行通过**

- [ ] **Step 5: 提交**

### Task 7: configRouter 通用配置端点

**Files:**
- Create: `src/http/configRouter.js`
- Test: `test/http/configRouter.test.js`

- [ ] **Step 1: 写失败测试**（用 mock pool 验证 GET 返回 JSONB、PUT 经第 0 闸 produce decision + sevenDimensionsCheck 拦截）

```js
import { createConfigRouter } from '../../src/http/configRouter.js';
test('PUT blocked on missing_context', async () => {
  const router = createConfigRouter({ key:'seven-dim', role:'sysadmin', decisionScene:'scene-quote' });
  // 注入 mock req/res，断言 422 + {error:'missing_context'}
});
```

- [ ] **Step 2: 运行失败**

- [ ] **Step 3: 实现**（GET/PUT `/api/config/:key` 读写 `crm.config_store(key PK, value JSONB, decision_id, updated_by, updated_at)`；PUT 两阶段：校验 → produce decision_id → 执行；若 `decisionScene` 则先 `sevenDimensionsCheck`，block 返回 422）

- [ ] **Step 4: 运行通过**

- [ ] **Step 5: 提交**

### Task 8: particleDetailRouter（复用既有 particles 端点）

**Files:**
- Create: `src/http/particleDetailRouter.js`
- Test: `test/http/particleDetailRouter.test.js`

- [ ] **Step 1: 写失败测试**（断言对 `CRM_DEAL` 返回 attr-field 集 + subtable 关联）

- [ ] **Step 2: 运行失败**

- [ ] **Step 3: 实现**（包装既有 `GET /api/particles/:id` + `GET /api/graph/neighbors`，按 particleType 组装 detail schema；复用 `src/http/particleDetail.js` 既有逻辑）

- [ ] **Step 4: 运行通过**

- [ ] **Step 5: 提交**

### Task 9: 配置相关表迁移（幂等）

**Files:**
- Create: `db/migrate-config.sql`
- Test: `test/db/migrateConfig.test.js`（`SELECT` 验证表存在）

- [ ] **Step 1: 写失败测试**

- [ ] **Step 2: 运行失败**

- [ ] **Step 3: 实现**（含 `config_store`、在 `decision_scenario` 增 `required_dims JSONB DEFAULT '[]'`、`skill_registry`、`approval_flow`、`business_tier`、`connectors`、`system_config`、`crm_users`（若 stage3 未建）；全部 `CREATE TABLE IF NOT EXISTS crm.xxx` + 幂等索引）

- [ ] **Step 4: 运行通过**

- [ ] **Step 5: 提交**

---

## §2 Phase 1 — 骨架 + 现有页 Schema 化（S01/S02/S13/S14/S15/S25）

> 每个面任务：① 写该面契约测试（schema 合法 + 端点形态）② 注册 schema 到 `src/pages/<id>.schema.js` 并在 `index.js` import ③ 复用既有端点（不新写 handler，除非蓝图标 [新增]）④ 运行通过 ⑤ 提交。

### Task 10: S01 登录 + 系统状态墙 `/home.html`
- schema: `dashboard`，`goal-form`(login→`POST /api/auth/login` routes.js:121) + 4×`metric-card` + `table`(最新粒子)；端点已存在，仅注册 schema。
- 测试：`test/pages/S01.test.js` 断言 schema 通过 `validatePageSchema` 且 `navigation.to='/home'`。

### Task 11: S02 AI 作战室首页 `/` (index.html)
- schema: `dashboard`，copilot `goal-form`→`POST /api/page/from-nl`(routes.js:171) + `metric-card`×3 + 2×`table` + `reasoning-trace` + `subtable`(SSE)。
- 端点：复用 `business/board`(154)/`monitor/decisions`(234)/`monitor/gates`(220)/`events`(217)。

### Task 12: S13 粒子详情（通用）
- 复用 `src/web/particle-detail.html` 组装 + `particleDetailRouter`；schema 注册 + 测试。

### Task 13: S14 决策图谱 `/decision-graph`
- 端点：`graph/neighbors`(302)/`trace`(323)/`impact`(331)/`provenance`(339)；schema `dashboard`(图组件)。

### Task 14: S15 业务看板 `/business-board`
- 端点：`GET /api/business/board`(154)；schema `dashboard`。

### Task 15: S25 池配置 `/config/pool`
- 端点：已落地 `GET/PUT /api/pool-config`(133/141)；走 `configRouter` 键 `pool`，role=manager/sysadmin。

---

## §3 Phase 2 — 前台业务详情补全（S03–S12）

> **渲染期四查（开发本阶段所有业务页必做，对齐蓝图 §2.5.1）**：S03–S12 凡展示粒子属性的面板，渲染前逐属性 `sourceClassify(attr)` 取 `data_origin`——①/②/④ 正常展示并带来源徽标，② 置信度<0.6 标 `needsReview` 禁改，③ 只读，孤儿/未声明 `data_origin` 标 `unverified` 且禁用控件。渲染器 `src/page/renderer.js` 的 `attr-field` 组件内置四查徽标（Task2 落地），页面 schema 无需逐字段声明。每个业务页测试须覆盖"来源已知→正常+徽标""孤儿→unverified+禁用"两分支。

### Task 16: S03 智能体工作台 `/workspace` — `workspace` 型，SSE task/trace 域。
### Task 17: S04 治理视图·智能体监控台 `/agents` — `dashboard`，`/api/monitor/sla` [新增] + 复用 `/api/monitor/*`，role manager/sysadmin。
### Task 18: S05 待办工作台(四角色) `/todo` — `table` 四 tab，`select`(角色视角) + `/api/business/board` 筛 + `/api/monitor/decisions`。
### Task 19: S06 客户 360（含七维画像）`/accounts/:id` — `detail`，`metric-card`×7 消费 `sevenDimensionsCheck(accountId, ctx)`；**7维校验：本页直接渲染七维完备度**；**四查：客户/联系人属性逐条 `sourceClassify` 渲染 ①/②/③/④ 徽标**。
### Task 20: S07 商机/线索详情 `/deals/:id` — `detail`，推进到 quoted/contracted 前触发 S20 场景 `sevenDimensionsCheck` 拦截；**四查：商机字段逐条 sourceClassify，孤儿标 unverified**。
### Task 21: S08 报价详情 `/quotations/:id` — **四查：报价行/金额字段逐条 sourceClassify**。
### Task 22: S09 合同详情 `/contracts/:id` — **四查：合同条款/金额字段逐条 sourceClassify**。
### Task 23: S10 订单详情 `/orders/:id` — **四查：订单行字段逐条 sourceClassify**。
### Task 24: S11 回款计划/记录 `/payments/:id` — **四查：回款字段逐条 sourceClassify（多为③规则派生，只读展示）**。
### Task 25: S12 发票详情 `/invoices/:id` — **四查：发票字段逐条 sourceClassify**。

> 每个 Task 16–25：注册 `src/pages/Sxx.schema.js`（含 `attr-field`×n + `subtable` + `goal-form` 写动作，写动作 ∈ `ACTION_WHITELIST`），测试断言 schema 合法 + 写动作在白名单内 + 四查渲染分支覆盖（来源已知/孤儿）。

---

## §4 Phase 3 — 配置中心（S16–S33，优先 S19/S20/S21/S24）

### Task 26: S16 LLM 配置 `/config/llm` — `configRouter` 键 `llm`，role sysadmin；api_key 经 `pgcrypto` 加密存储。
### Task 27: S17 用户管理 `/config/users` — 端点 `GET/POST/PUT /api/config/users` 落 `crm.crm_users`；`select`(role∈六角色)。
### Task 28: S18 权限/RBAC 矩阵 `/config/rbac` — 端点 `GET/PUT /api/config/rbac`，复用 `fieldPermission#modeFor`；矩阵 `table`。
### Task 29: S19 销售决策场景配置 `/config/decision-scenarios` — 端点落 `decision_scenario`；`subtable`(eval_dimensions)；role manager 编辑/presales 只读。
### Task 30: S20 七维设计（完整性校验）`/config/seven-dim` ★D3 — 场景×七维矩阵 `table` + `form`；端点 `GET/PUT /api/config/seven-dim` 写 `decision_scenario.required_dims`；**七维唯一源 = 本面**。
### Task 31: S21 方法论 SKILL 注册表 `/config/skills` — 端点落 `skill_registry`；`select`(enabled)。
### Task 32: S22 审批流配置 `/config/approvals` — 端点落 `approval_flow`（复用 seed 4 流）。
### Task 33: S23 业务分级配置 `/config/business-tier` — DEAL=客户维×项目维；驱动自主边界。
### Task 34: S24 粒子属性元模型配置 `/config/meta-attr` — 端点 `GET /api/meta-attr`(52) + `POST/PUT` 写经第0闸；纳入统一 Schema 渲染（取代独立 drawer）。
### Task 35: S26 预警规则配置 `/config/alerts` — 端点落 `alert_registry`（复用 `alertRegistry.js`+`timers.js`）。
### Task 36: S27 粒子模型/本体/词汇 `/config/ontology` — 端点落 ontology 表（复用 `src/ontology/`）。
### Task 37: S28 智能体配置 `/config/agents` — 端点落 `agents`/`role_profiles`。
### Task 38: S29 门户/页面生成配置 `/config/portal-pages` — 端点 `/api/pages`(179)/publish(184)/revert(191)/preview(198)/from-nl(171)；**本蓝图 33 面均可经 NL 生成临时页**。
### Task 39: S30 决策质量监控 `/config/decision-quality` — `dashboard`，`/api/monitor/coverage`(244)/decisions/gates。
### Task 40: S31 记忆/先例管理 `/config/memory` — `POST /api/memory/distill`(205)。
### Task 41: S32 连接器/MCP `/config/connectors` — `configRouter` 键 `connectors`，credential_ref 加密。
### Task 42: S33 系统设置 `/config/system` — `configRouter` 键 `system`，含主题/会话超时/审计日志 `table`。

---

## §5 Phase 4 — 七维闭环（sevenDimensionsCheck 接入写引擎）

### Task 43: 写引擎接入
- 在 `src/action/executor.js`（或 write-engine）落库前调用 `sevenDimensionsCheck(scenarioId, ctx)`；`block` 返回 `missing_context` 拒写并记 `decision_*`。
- 测试：`test/sevenDimensions/writeEngine.test.js` 断言缺失 block 维时写被拒。

### Task 44: S06/S07 消费校验
- S06 七维画像卡渲染 `sevenDimensionsCheck` 完备度；S07 推进动作在 quoted/contracted 前拦截。
- 测试：`test/pages/S06.test.js` / `test/pages/S07.test.js` 断言 `missing` 维标红 + 拦截写。

### Task 45: S30 监控看板接入
- S30 `metric-card`(覆盖度/先例命中) 消费 `sevenDimensionsCheck` 汇总。

### Task 46: 全量契约回归
- `node node_modules/vitest/vitest.mjs run` 全绿（目标 33 面契约测试 + 共享设施测试全 PASS）。
- 提交 Phase 4。

---

## §6 跨面一致性验收（对齐蓝图 §4）

1. 33 面全部经 `renderPage` 渲染，无 HTML 旁路。
2. 所有写经第 0 闸（produce `decision_*` + RBAC + 决策面 `sevenDimensionsCheck`）。
3. `attr-field.hidden/readonly` 由 `permissionComposer` 预解析，渲染器纯消费。
4. SSE 单连接 `EventSource('/events')`。
5. 七维定义唯一源 = S20（`SEVEN_DIMS` 常量）。
6. `navigation.to` ∈ 扩展 `CANONICAL_NAV`。

---

## §7 自检（plan vs spec）

- **Spec 覆盖**：§1 导航扩展→Task1；§2 模板→共享设施 Task2-8；§3 S01-S33 逐面→Task10-42；§4 一致性→§6 验收；§5 四 Phase→§2-§5。无遗漏面。
- **Placeholder 扫描**：无 TBD/TODO；每 Task 含真实 schema/端点/测试；handler 逻辑在共享助手 Task 中给出完整代码（非占位）。
- **类型一致性**：`sevenDimensionsCheck(scenarioId, ctx)` 签名在 Task4 定义、Task30/43 消费一致；`composeAttrFields(particleType, role, fields)` 在 Task5 定义、S06-S12 消费一致；`configRouter` 的 `createConfigRouter({key,role,decisionScene})` 在 Task7 定义、S16/S25/S32/S33 消费一致。
- **执行顺序依赖**：Task1-9 为前置（共享设施）；Task10-15（Phase1）→16-25（Phase2）→26-42（Phase3）→43-46（Phase4）。每 Task 一 commit。
