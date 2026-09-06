# 实施计划：故事线 × 图谱 场景路由（融合设计批准后落地）

> 状态：**执行中（用户已批准 docs/2026-09-01-story-graph-fusion-design.md）**
> 前置确认（file:line）：
> - 叙事时间线（A1/A3 叙事 WHEN 轴）已由 09-02 统一设计提前落地：`src/context/assembler.js:97-134`、`src/context/injector.js:59-68`（四源 events/tasks/decision/memory_log，只读派生视图）。
> - 图谱模型已存在：AGE 图 `src/decision/ageGraph.js`（`isAvailable/ensureGraph/addDecision/addEdge/traceUpstream/traceDownstream/ctePrecedents`）+ `/api/graph/trace|impact|edges|analytics`（`src/http/routes.js:2333-2395`）+ `/decision-graph.html`（`routes.js:2506`）。
> - **缺口确认**：`src/context/routing.js` 不存在、`scripts/seed-context-routing.mjs` 不存在、`config_store` 无 `context-routing` 键（生产/测试库实测）、configCenter 无此配置项 → **A5/A6（场景路由配置化 + 装配器选轨）未落地**。
> - **id 冲突**：融合设计文档写「id 35」，实际 **id 33（思维要素）已建、id 35（事件复盘）已建** → 本计划用 **id 36**。
> - `assembleContext` 消费场景键：`task.payload.intent.scenario`（`agentLoop.js:25-27`）；`intent.scenario` 值为 `decision_scenario.scenario_id`（如 `QUOTE_PRICING`）或 disposition。

---

## 任务拆分（每 Task 一 commit）

### Task A：`src/context/routing.js` 新建（场景路由加载 + 分类 + 选轨）

- 契约（对齐融合设计 §1.4/§2.5）：
  - `loadRouting()`：读 `config_store['context-routing']`（`readConfig('context-routing',{tenantId:'system'})`），缺失/坏值回退 `DEFAULT_ROUTING`（全轨安全默认），**不抛错**。
  - `classifyScene(sceneId, cfg)`：加权聚合 `dims` + `scene_matrix[sceneId].dims` + `thresholds`，返回 `GRAPH_PRIMARY / STORY_PRIMARY / BOTH`。
  - `resolveTracks(sceneId, cfg)`：返回 `{ tracks, L }`；场景缺失 → 全轨默认 `['narrative','graph_decision','graph_entity','structured']` + `['L1','L2','L3','L4']`。
  - 判定维度：按设计 §1.4 用 `goal / event_mix / time_sensitivity` 三维（各带 weight），`thresholds={graph:0.6, story:0.4}`。
- 场景矩阵（对齐设计 §1.3 逐项归位，key 用 `scenario_id`）：
  - `account_insight`（insightService）：tracks `['narrative','graph_decision','graph_entity','structured']`（故事线为主）
  - `sales_decision_monitor`：tracks `['graph_decision']`（纯审计、图谱主）
  - `decision_retro`：tracks `['graph_decision']`（图谱主）
  - `calibration`：tracks `['graph_decision']`（图谱主）
  - `named_accounts`：tracks `['narrative','structured']`（故事线主）
  - `deal_diagnose`：tracks `['narrative','graph_decision']`（故事线主 + 图谱）
  - `funnel_progress`：tracks `['structured']`（结构化主）
  - `behavior_standard`：tracks `['structured']`（结构化主）
  - `agent_dispatch`：tracks `['graph_entity']`（图谱主）
  - 缺省：`DEFAULT.tracks`（全轨）
- 纯函数（不触 DB），单测覆盖。

### Task B：`assembler.js` 接入选轨（`assembleContext` 按场景裁剪叙事）

- 在 `assembleContext({actor,intent})` 开头解析 `intent.scenario`，调 `resolveTracks(scenarioId)` 得 `tracks`。
- `retrieveNarrative` 仅在 `tracks.includes('narrative')` 时执行；否则 `narrative = { rows:[], available:false, unavailable_reason:'routing-excluded', source:... }`（**不降级、不报错**，可审计）。
- L1/L2/L3/L4 检索仍全部执行（层级检索不含"轨道"，保持兼容）。
- 返回 `bundle.routing = { scene: scenarioId, tracks, mode }`（可观测，供 agentEpisodes/前端展示）。
- `missing` 不含 narrative（叙事被排除 ≠ 缺失）。
- 新增单测：scenario 为 `sales_decision_monitor`/未知场景时 `narrative.available=false` + `unavailable_reason='routing-excluded'`；`account_insight` 时正常四源。

### Task C：`configRouter` 挂载 `GET/PUT /api/config/context-routing`

- 参照现有挂载（`routes.js:168-176`，`createConfigRouter` 泛型）：
  - `app.use(createConfigRouter({ key: 'context-routing', role: 'sysadmin', decisionScene: 'config-change' }))`
  - 写经第 0 闸（produceDecision）+ 角色闸（sysadmin）。
- `decisionScene: 'config-change'`（与 approval-config/event-retro 同语义，七维拦截仅决策场景面，路由配置不涉七维）。

### Task D：configCenter 新增 id 36 + `decision-route-config.html` 配置页

- `src/portal/configCenter.js` 新增：
  - `{ id: 36, name: '场景路由（故事线/图谱）', group: '销售方法论与决策治理', status: 'ready', page: '/decision-route-config.html', endpoint: '/api/config/context-routing', note: '12+ 场景×轨道画像（narrative/graph_decision/graph_entity/structured × L1-L4）经 config_store 承载，写经决策第0闸+sysadmin' }`
- 新页 `src/web/decision-route-config.html`：
  - 受控布局复用 `common.css` + `tokens.css`（零硬编码色值）。
  - 消费 `GET /api/config/context-routing`：展示 维度定义 / 场景矩阵 / 阈值。
  - 编辑：改场景 `tracks`（四个轨道勾选）+ 维度权重 + 阈值，PUT 写回（经第 0 闸）。
  - 只读展示 + 表格「场景 | 主载体 | 次载体 | 判定依据 | 当前 tracks」。
- `src/http/routes.js` 登记 `app.get('/decision-route-config.html', sendFile(...))` + `/decision-route-config` redirect（L-α 铁律）。

### Task E：`scripts/seed-context-routing.mjs` 出厂默认 + 双库 seed

- 出厂默认 = 设计 §1.3 场景矩阵 + §1.4 dims/thresholds（与 Task A DEFAULT 同源，常量集中 `src/context/routing.js` 导出，seed 脚本 import）。
- 双库：`crm_native_test`（pretest 用）+ `crm_native`（生产，最小变更，不跑全量 seed）。
- 幂等：`ON CONFLICT (key) DO UPDATE`（仅当键缺失时写入，保留管理员已改内容）。
- `guardNoConcurrentRun` 同款护栏（防并发污染）。

### Task F：监控台/config 页可见（可选，依赖前端可视化批次）

- `sales-decision-monitor.html` 决策下钻弹窗新增「路由画像」行（消费 `bundle.routing`，展示该场景 tracks 与主载体）。
- 若与 P2/P3 前端可视化批次冲突，则并入该批次统一实现。

---

## 验收标准（L1–L4，对齐落地纪律）

| 层 | 标准 |
|---|---|
| L1 元数据 | `routing.js` 导出 `loadRouting/classifyScene/resolveTracks`；`configCenter` 有 id 36 |
| L2 契约 | `/api/config/context-routing` GET/PUT 响应含 `{key,value,decision}`；单测断言 |
| L3 执行 | `assembleContext({intent:{scenario:'sales_decision_monitor'}})` → `narrative.unavailable_reason='routing-excluded'`；`account_insight` → 正常装配；测试库真跑 |
| L4 生产 | `crm_native.config_store` 出现 `context-routing` 键（seed 后）+ seed 脚本幂等可重跑 |

## 纪律（强制）

- 零硬编码：场景矩阵/维度/阈值 **只在 `routing.js` 出厂默认 + seed**，代码消费侧不写死场景名与权重（对齐 `configCenter.js:33` 铁律）。
- 阈值配置化：`thresholds` 走 config_store，缺省回退出厂默认。
- 写经第 0 闸：`createConfigRouter` 自带产证（config-change）。
- 绝对禁 DELETE；测试隔离净效果为 0；`guardNoConcurrentRun` 防并发。
- 每 Task 一 commit，署名 `Co-Authored-By: 王川 <watchm@163.com>`，禁 `git add -A`。

## 验证命令

```bash
# 单测
./node_modules/.bin/vitest run test/context test/decision
# CSS 零硬编码审计（新页）
python tmp/audit_css_vars.py src/web/decision-route-config.html
# 测试库 seed 幂等重跑
PGDATABASE=crm_native_test node scripts/seed-context-routing.mjs
# L3 实证（真库事务 + 回滚）
node tmp/_verify_routing_l3.mjs
```