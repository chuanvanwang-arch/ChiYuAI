# CRM 智能体工作台 · 两 TAB 任务监控与执行追踪设计

**日期**：2026-08-29
**作者**：WorkBuddy（王川的开发搭档）
**状态**：§0 待 P5 批准（设计先行，未批不写实现）

---

## §0 批准闸门

| 项 | 内容 |
|----|------|
| 目标 | 把 S03 智能体工作台拆成**两 TAB**：TAB1 全局任务监控（哪些任务在跑），TAB2 单任务执行追踪（三段思考链 + 实时状态） |
| 关联已开发 | 契约合规矩阵（contract-matrix）已动态，不在此范围；本设计只解决 reasoning-trace 三段静态问题 |
| 批准要求 | 用户明确批准本设计后，方进 writing-plans → 实现 |

---

## §1 目标与现状（Gap 分析）

### 1.1 用户原话（拆分诉求）
> "这个页面需要分成两个 TAB，一个是整体页面监控目前有哪些任务在运行（B-β），点击某个任务后显示（B-γ），监控该任务的详细执行过程及实时状态！"

即：**TAB1 = 全局任务清单（B-β 全局订阅）** + **TAB2 = 单任务实时追踪（B-γ 详情）** 的组合结构。

### 1.2 现状缺陷（证据）
| 组件 | 现状 | 证据 |
|------|------|------|
| `reasoning-trace` 三段 | schema 写死 `steps`，渲染器静态拼 `<li>`，永远绿 | `src/pages/S03.schema.js:24-26`、`src/page/renderer.js:320-321`、`src/http/routes.js:655` |
| 全局任务清单 | S03 仅展示 kanban **历史任务** + 装配状态，**无"运行中"实时清单** | `src/http/routes.js:638-660` |
| 单任务追踪 | 无端点、无组件 | — |

### 1.3 数据基础（已存在，可复用）
| 数据源 | 内容 | 证据 |
|--------|------|------|
| `crm.tasks` | 任务表，`status IN ('ready','running','done','failed','blocked')`，另含 `awaiting_confirm`（kanban.js:112） | `db/schema.sql:47-67` |
| `listTasks()` | 按 status/tenantId 查任务 | `src/kanban/kanban.js:22` |
| `/api/kanban/tasks` | 已暴露任务列表端点 | `src/http/routes.js:348` |
| agentLoop `trace` 事件 | `agent-context-injected` / `agent-loop-started` / `agent-loop-done` / `agent-loop-failed`，**均带 `taskId`** | `src/agent/agentLoop.js:43,54,64,73` |
| SSE `/events` | 全量转发 `trace` 域（`on('*')`） | `src/events/sse.js:24`、`src/http/routes.js:383` |
| `monitor_event` 回放 | `payload->>'taskId'` 存任务 ID，可回放历史事件 | `db/schema.sql:300,308`、`src/agent/agentEpisodes.js:14-19` |

---

## §2 两 TAB 架构

```
┌─────────────────────────────────────────────────────────────┐
│ S03 智能体工作台（agent-workbench.html）                       │
├──────────────┬──────────────────────────────────────────────┤
│ TAB1 任务监控 │ TAB2 任务执行详情（点 TAB1 某行进入）           │
│              │                                                │
│ 任务清单表    │ 头部：task title / id / status 徽章            │
│ （活跃优先）  │   reasoning-trace 三段（实时）：               │
│ - task_id    │     ① 意图解析  ② 上下文装配  ③ 动作编排       │
│ - title      │   └ 由 trace SSE(taskId) + 回放驱动            │
│ - action     │   实时事件流（原始 trace 事件，透明可查）        │
│ - status      │                                                │
│ - owner/worker│                                                │
│ - updated_at  │                                                │
│ [实时刷新]    │                                                │
└──────────────┴──────────────────────────────────────────────┘
```

**交互**：TAB1 点击某行 → 携带 `taskId` 切到 TAB2；TAB2 初始从回放端点取历史阶段，再叠加 SSE 实时更新。

---

## §3 三段思考链 ↔ trace 事件映射

| 三段 | 触发事件（agentLoop emit） | 状态转移 |
|------|---------------------------|----------|
| ① 意图解析 | **新增** `agent-intent-parsed` `{taskId, intent: skillSlug, action}` | idle→done(绿) |
| ② 上下文装配 | 已有 `agent-context-injected` `{taskId, len}` | idle→done(绿) |
| ③ 动作编排 | `agent-loop-started`→`agent-loop-done` / `agent-loop-failed` | idle→running(蓝)→done(绿)/failed(红) |

任务整体状态徽章由 SSE `task` 域驱动（`ready`/`running`/`done`/`failed`/`blocked`/`awaiting_confirm`）。

### 3.1 缺失件：意图解析事件
`runWithSkill` 入口已解析 `skillSlug`（agentLoop.js:31）但未 emit。补一处 emit + recordEpisode：
- 位置：`src/agent/agentLoop.js:38`（`startedAt` 之后、`buildContextBlock` 之前）
- 事件：`emit('trace','agent-intent-parsed',{taskId: task.id, intent: skillSlug, action: task.action_name})`
- 落库：`recordEpisode({agent_id, phase:'intent-parsed', context_facts:{intent: skillSlug, contract_task_id: ctId}, payload:{taskId: task.id, intent: skillSlug}})`

---

## §4 改动清单（file:line 锚点）

| # | 文件 | 改动 | 类型 |
|---|------|------|------|
| 1 | `src/agent/agentLoop.js:38` | 补 `agent-intent-parsed` emit + recordEpisode | 新增（低风险） |
| 2 | `src/pages/S03.schema.js:24-26` | `reasoning-trace` 由写死 steps 改为**动态组件占位**（steps 不再作为真相源，移交 SSE 驱动） | 修改 |
| 3 | `src/page/renderer.js:320` | `reasoning-trace` 渲染改为渲染骨架（三段固定标题，`data-step` 属性留给前端按 taskId 填充状态） | 修改 |
| 4 | `src/http/routes.js` | 新增 `GET /api/agent-monitor/trace/:taskId`：回放 `monitor_event WHERE payload->>'taskId'=$1 ORDER BY created_at`，返回阶段序列 | 新增端点 |
| 5 | `src/http/routes.js:638-660` | S03 data 增加 `taskList`（活跃任务）供 TAB1 初始渲染 | 修改 |
| 6 | `src/web/agent-workbench.html` | 两 TAB 结构 + SSE 订阅 `task`+`trace` 域 + tab 切换 + 三段按 taskId 实时上色 + 事件流 | 重写前端 |

> 不改 S03 的 `from-nl` 提交行为（仍生成 draft 页面）。监控台只读 `crm.tasks` + 其 trace，与提交解耦——范围可控、零语义冲突。

---

## §5 新增端点规格

### `GET /api/agent-monitor/trace/:taskId`
- 作用：回放该任务历史阶段（补漏 SSE 内存总线丢掉的已发生事件）。
- SQL：`SELECT event_type, payload, created_at FROM crm.monitor_event WHERE payload->>'taskId'=$1 ORDER BY created_at`
- 返回：`{ taskId, phases: [{phase, taskId, ts}], status }`
- 鉴权：复用 `/api/agent-monitor/*` 现有 sysadmin 闸（routes.js:681/695 同源）

---

## §6 前端行为（agent-workbench.html）

1. **TAB 切换**：原生 tab 按钮，点击切换 `data-tab` 显隐。
2. **TAB1 初始**：`GET /api/kanban/tasks`（活跃 status 优先排序）+ SSE `task` 域实时刷新状态列。
3. **TAB1→TAB2**：点行 → `taskId` 存入状态 → 切 TAB2 → `GET /api/agent-monitor/trace/:taskId` 回放填三段 → 订阅 SSE `trace` 域按 `taskId` 过滤实时上色。
4. **三段上色**：
   - `intent-parsed` → ①绿；`context-injected` → ②绿；`loop-started` → ③蓝；`loop-done` → ③绿；`loop-failed` → ③红。
   - 任务整体状态徽章由 `task` 域事件更新。
5. **事件流**：TAB2 底部列出该 taskId 的原始 trace 事件（时间+类型+详情），透明可查。
6. **主题**：IDE light 主题，背景浅色、文字深色；状态色：灰=idle、绿=ok、红=failed、蓝=running。

---

## §7 验证口径

| 项 | 验证方式 | 通过标准 |
|----|----------|----------|
| 意图事件 | 跑一个 kanban task 经 `runWithSkill` | `monitor_event` 出现 `intent-parsed` 行 + SSE 收到 `agent-intent-parsed` |
| TAB1 | 打开页面 | 列出 running/ready/awaiting_confirm/blocked 任务，status 随 pump 实时变 |
| TAB2 回放 | 点一个已跑完任务 | 三段按历史阶段出绿（不依赖实时 SSE） |
| TAB2 实时 | pump 一个 ready 任务 | 三段随 trace 事件逐段亮/灰/红 |
| 不回归 | contract-matrix 仍正常 | 矩阵 4 行全绿（目标 1 已验证） |

---

## §8 风险与注意

1. **SSE 跨任务干扰**：TAB2 必须按 `taskId` 过滤 trace，否则会收到其它任务的事件 → 前端 filter 硬约束。
2. **回放一致性**：`intent-parsed` 老任务无此事件 → 三段①在回放时保持灰（正常，仅新跑任务有）。
3. **不改 from-nl**：S03 提交仍只生成 draft 页面，不派发 agent；监控台数据全部来自 kanban 任务流，语义清晰。
4. **routes.js 重启生效**：端点改动需重启 server（routes.js 启动时加载）。
5. **决策第 0 闸**：本设计全为读操作 + 已存在的 trace 落库（monitor_event 设计上不强制 decision_id），不引入新写通道，无需新决策引用。

---

## §9 实施顺序（批准后）

1. agentLoop.js 补 intent-parsed（#1）→ 单测/手动跑一个 task 验证落库+emit。
2. 新增回放端点（#4）+ S03 data 加 taskList（#5）。
3. S03.schema.js + renderer.js 改动态骨架（#2,#3）。
4. agent-workbench.html 两 TAB + SSE（#6）。
5. 端到端验证 §7。

每 Task 一 commit（你的铁律）。
