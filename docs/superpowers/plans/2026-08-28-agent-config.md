# 配置中心第 23 项：智能体配置（agent-config）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 CRM-ai-native 新增「智能体配置」管理页 `/agent-config.html`，展示 3 个 Agent 的六段式定义（identity/capabilities/context/memory/evaluation/governance）+ 装配断言实时状态，完成配置中心第 23 项（当前 pending → ready）。

**架构（严格复用本会话 QA 修复确立的可浏览器加载范式）：**
- **渲染纯函数子模块**：`src/portal/agentConfigRender.js`（零服务端 import，仅导出纯函数）——这是 QA 根因 A 的教训：混合模块（渲染+router 同文件）浏览器 ESM 加载必崩。render 与 router **必须分文件**。
- **Router 单文件**：`src/portal/agentConfig.js` 只含 `createAgentConfigRouter`（服务端用），不含任何渲染函数。
- **数据源**：只读聚合 `GET /api/agent-config`：读取 `agentSpecs`（src/agent/agentSpec.js 六段式）+ `assertAgentAssembly()` 装配断言（src/agent/agents.js），返回 `{ agents, specs, assembly }`。**不含写操作**（agentSpec 是代码层定义，本次只读；写=改代码+重启，超出配置页范围）。
- **HTML 页面**：`src/web/agent-config.html` import `/portal/agentConfigRender.js`，挂全局 `renderAgentConfig`，fetch `/api/agent-config` 渲染。只读不轮询（配置定义静态，装配状态一次快照即可，无需 5s 刷新——那是监控台 /agents 的职责）。
- **路由**：routes.js 补 `/agent-config.html` 静态页 + `/portal/agentConfigRender.js` + `/api/agent-config`。
- **configCenter.js**：第 23 项翻 `status: 'ready', page: '/agent-config.html', endpoint: '/api/agent-config'`。

**差异化定位（与 /agents 运行监控台互补）：**
- `/agents`（已建）= 运行态监控：装配断言健康+实时事件域，5s 轮询。
- `/agent-config`（本次）= 配置态定义：六段式结构化管理（identity/能力/上下文/记忆/评估/治理逐段展示），装配断言作为只读状态条附在页顶。不重复监控。

**Tech Stack:** Node 22 + Express 4 + 原生 ESM 浏览器模块 + vitest 3（node 环境）。

---

## File Structure

- `src/portal/agentConfigRender.js` — 纯函数 `renderAgentConfig(data)`：输入 `{ agents, specs, assembly }`，返回 HTML 字符串；含 `renderAgentCard(spec)`（六段式分节）+ `renderAssembly(assembly)`（断言状态条）导出。
- `src/portal/agentConfig.js` — 服务端 Router：`createAgentConfigRouter({ agents, specs, assembly })` 只暴露 `GET /api/agent-config`（实际由 routes.js 直连数据源，Router 承载路由挂载）。
- `src/web/agent-config.html` — 管理页：挂 `renderAgentConfig`，fetch `/api/agent-config` 渲染。
- `src/http/routes.js` — 新增 `GET /api/agent-config`（聚合 agentSpecs+assembly）+ 静态路由 `/agent-config.html` + `/agent-config` 别名 + `/portal/agentConfigRender.js`。
- `src/portal/configCenter.js` — 第 23 项翻 ready。
- `src/web/nav.js` — 侧栏「🤖 智能体配置」入口（若 nav.js 是聚合式）。
- `test/web/agentConfig.test.js` — TDD：覆盖六段式渲染、装配断言状态条、降级。

---

### Task 1: 写 agentConfig 失败测试（RED）

**Files:**
- Create: `test/web/agentConfig.test.js`

- [ ] **Step 1: 写失败测试**：断言
  1. `renderAgentConfig` 存在且可被浏览器加载（模块顶层无 express/db 等服务端 import——沿用 browserLoadable 范式）。
  2. 给定 3 agent specs → 渲染 3 张 Agent 卡，每卡含六段标题（身份/能力/上下文/记忆/评估/治理）。
  3. 装配断言 ok/fail 徽标：`agentOk(results)` 判定 + `.chip.ok/.chip.fail` 类。
  4. 空数据降级：无 agents → 渲染空态提示。
  5. `createAgentConfigRouter` 在 `agentConfig.js`（服务端文件）中导出且 `agentConfigRender.js` **不含** `createAgentConfigRouter`（浏览器可加载守卫）。

- [ ] **Step 2: 跑测试** → 断言 RED（模块不存在）。

### Task 2: 实现 agentConfigRender.js 纯函数（GREEN）

**Files:**
- Create: `src/portal/agentConfigRender.js`

- [ ] **Step 1:** 实现 `renderAgentConfig(data)` / `renderAgentCard(spec)` / `renderAssembly(assembly)` / `agentOk(results)`，全部无 import 或仅 import 同目录纯函数（零服务端依赖）。
- [ ] **Step 2:** 跑测试 → GREEN。

### Task 3: 实现 agentConfig.js Router + /api/agent-config

**Files:**
- Create: `src/portal/agentConfig.js`
- Edit: `src/http/routes.js`

- [ ] **Step 1:** `agentConfig.js` 导出 `createAgentConfigRouter()`，内部 `GET /` 返回 `{ agents, specs, assembly }`（由注入依赖提供）。
- [ ] **Step 2:** routes.js 挂 `createAgentConfigRouter`，注入 `agentSpecs` + `assertAgentAssembly`，聚合响应。
- [ ] **Step 3:** 补静态路由 `/agent-config.html`、`/agent-config` 别名、`/portal/agentConfigRender.js`。
- [ ] **Step 4:** 测试补 Router handler 断言（mockRes 范式）。
- [ ] **Step 5:** 跑全量 web 测试 → GREEN + 无回归。

### Task 4: 建 agent-config.html + configCenter 翻 ready

**Files:**
- Create: `src/web/agent-config.html`
- Edit: `src/portal/configCenter.js`

- [ ] **Step 1:** `agent-config.html` import `/portal/agentConfigRender.js` 挂 `window.renderAgentConfig`，fetch `/api/agent-config` 渲染，只读快照无轮询。
- [ ] **Step 2:** configCenter 第 23 项 → `status:'ready', page:'/agent-config.html', endpoint:'/api/agent-config'`。
- [ ] **Step 3:** browserLoadable 守卫测试补第 8 个 CASE（agentConfigRender 无服务端 import）。
- [ ] **Step 4:** 跑全量 web 测试 + 路由冒烟（curl `/agent-config.html` / `/api/agent-config` / `/portal/agentConfigRender.js` 全 200）。

### Task 5: 导航入口 + 收尾

**Files:**
- Edit: `src/web/nav.js`（若存在聚合导航）

- [ ] **Step 1:** nav.js 侧栏/下拉补「🤖 智能体配置」入口（指向 /agent-config.html）。
- [ ] **Step 2:** 全量 web 测试 GREEN + 冒烟。
- [ ] **Step 3:** 更新 configCenter 统计注释 + 工作日志 + 交付总结（含本地 commit 命令）。