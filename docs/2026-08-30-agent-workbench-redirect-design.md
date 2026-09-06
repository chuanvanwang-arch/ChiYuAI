# 智能体工作台重定向设计（方案 A：需求 → Kanban 调度 → 过程监控）

> 设计日期：2026-08-30
> 触发：用户反馈两条问题
> - Item 1：门户首页 ⌘K copilot 生成预览显示「乱码」（iframe srcdoc 编码 bug，已随本设计一并修复，见 §6-T1）
> - Item 2：`agent-workbench.html` 不应显示 NL 页面生成内容；应「输入需求 → 智能体调度完成相关任务 → 可对任务过程监控」，回归为正确的智能体工作台
> 决策：用户确认采用 **方案 A（Requirement → Kanban 任务队列）**

---

## §0 结论

`agent-workbench`（S03 智能体工作台）当前被错误地接入了 **NL→Page 草稿生成**（`POST /api/page/from-nl`），而页面本身的监控骨架（任务监控 / 契约矩阵 / 思考链详情）其实早已就位。本次改造：

1. **S03 schema**：`goal-form` 的 `action` 从 `POST /api/page/from-nl` 改为新增的 `POST /api/agent/dispatch`；`label`/`placeholder` 改为「任务需求」语义。
2. **新增后端端点** `POST /api/agent/dispatch`：把自然语言需求解析为 1 个（v1）kanban 任务（携带 `payload.intent`/`payload.level`），落库后**显式泵起**调度器。
3. **`agent-workbench.html`**：删除全部 NL 提交代码（`nlResultBox`/`nlSetTone`/`nlEscape`/`nlNotesHtml` 及 `submit` handler，约 `:229-297`），替换为 dispatch submit handler；监控能力（task-monitor / contract-matrix / reasoning-trace / SSE）完整保留。
4. **Item 1 iframe bug**：`index.html` 预览改用 `iframe.srcdoc` property setter（与 agent-workbench 改造正交，独立 commit）。

---

## §1 现状取证（全部 file:line 标注）

| 项 | 位置 | 说明 |
|---|---|---|
| S03 `goal-form` 错配 | `src/pages/S03.schema.js:20-25` | `action: 'POST /api/page/from-nl'` → 本应调度的页面却走 NL 草稿生成 |
| agent-workbench NL 污染 | `src/web/agent-workbench.html:229-297` | `nlResultBox`/`nlSetTone`/`nlEscape`/`nlNotesHtml` + `submit` handler 全部指向 from-nl |
| renderer 支持监控组件 | `src/page/renderer.js:350,381,356,421` | `task-monitor`/`contract-matrix`/`reasoning-trace`/`result-card`/`attr-field` 均服务端渲染 |
| 页面路由已注入任务数据 | `src/http/routes.js:813-852` | `GET /api/page/agent-workbench` 把 `listTasks()` 结果喂给 `task-monitor.rows`、compliance 喂 `contract-matrix.rows` |
| task-monitor 行可点击 | `src/page/renderer.js:333` | `<tr data-task-id=...>` → `agent-workbench.html:90-99` 点击进入 TAB2 + `loadTrace` |
| SSE 已订阅 task/trace | `src/web/agent-workbench.html:184-203` | `EventSource('/events')` 过滤 `domain==='task'｜'trace'` 更新行 + 触发 `load()` |
| 任务状态机 | `src/kanban/kanban.js:34-151` | `createTask`(ready) / `claimTask`(running) / `completeTask`(done) / `failTask`(failed/blocked) / `emit('task', type, {id})` |
| 调度链 | `src/kanban/scheduler.js:40-65` | `pumpReadyTasks` → `dispatchOneCore` → `claimTask` → `routeThroughIntake` → `runWithSkill(agentLoop)` → `complete/fail` |
| 意图路由 | `src/kanban/scheduler.js:24-37` | `routeThroughIntake` 读 `payload.intent`(`quote`/`followup`) + `payload.level`(`major`/`normal`) → 选 `quote-engine`/`followup-agent`(+`review-gate`) |
| **无自动泵循环** | `src/http/routes.js:445` / `grep setInterval` 无 pump | `pumpReadyTasks` 仅手动 `/api/kanban/pump` 触发；创建任务后必须显式泵起 |
| trace 回放端点 | `src/http/routes.js:892` | `GET /api/agent-monitor/trace/:taskId` 返回 steps（intent/context/action 三段）供 reasoning-trace 展开 |

**结论**：监控骨架 100% 就绪，唯一错配是 `goal-form` 的 action 与对应的前端 handler。改造面小且闭环明确。

---

## §2 方案 A 详细设计

### 2.1 新端点 `POST /api/agent/dispatch`

**位置**：`src/http/routes.js`（紧随 `/api/kanban/pump` 之后，`routes.js:448` 附近）

**契约**：
```
POST /api/agent/dispatch
Headers: Authorization: Bearer <token>   // resolveMe 鉴权（触发真实 agent 执行，属副作用端点）
Body:    { "requirement": "跟进本周逾期商机" }
Resp(200): { "ok": true, "taskIds": ["<uuid>"], "dispatched": 1, "summary": {...} }
Resp(400): { "error": "...", "needsClarification": true }   // 需求过短/无法归类
```

**处理流程**：
1. `resolveMe(req)` 取 `actor`（无 token → 401，对齐写入类端点）。
2. 需求清洗：`requirement = (body.requirement||'').trim()`；长度 `< 4` → `400 needsClarification`。
3. **意图/级别分类器**（纯函数 `classifyRequirement(text)`，置于 `src/kanban/scheduler.js` 或新增 `src/agent/classify.js`）：
   - `intent`：`/跟进|催办|回访|提醒|逾期|关怀|review/i` → `followup`；否则默认 `quote`（覆盖 报价/测算/出方案/生成）。
   - `level`：`/重大|战略|千万|百万|关键客户|大客户|总部|核心/i` → `major`；否则 `normal`。
4. `createTask({ step:'agent-dispatch', title: requirement, actionName:'agent-dispatch', payload:{ intent, level, requirement }, dependsOn:[], decisionId:null })`（`kanban.js:34`）。
5. **显式泵起**：`const n = await pumpReadyTasks({})`（`scheduler.js:40`）——关键，弥补无自动循环。返回 `dispatched:n`。
6. 返回 `{ ok:true, taskIds:[id], dispatched:n }`。

> 多任务分解（"完成相关任务"的复数语义）v1 仅拆 1 个任务；后续可扩展为按意图切片多任务，属扩展点，不在本次范围。

### 2.2 S03 schema 改造（`src/pages/S03.schema.js:20-25`）

```js
{
  kind: 'goal-form',
  action: 'POST /api/agent/dispatch',
  placeholder: '描述一个销售任务需求（如：跟进本周逾期商机 / 为蒙电 100 台出报价）',
  label: '任务需求',
}
```
其余组件（`task-monitor` / `contract-matrix` / `result-card` / `reasoning-trace` / `attr-field`）**原样保留**（已是正确内容）。

### 2.3 `agent-workbench.html` 改造

**删除**（`:229-297` 整段）：
- `nlResultBox()` / `nlSetTone()` / `nlEscape()` / `nlNotesHtml()` 四个函数
- `document.addEventListener('submit', ...)` 中指向 from-nl 的 handler

**新增** dispatch submit handler（替换原 handler）：
```js
document.addEventListener('submit', async (e) => {
  const form = e.target;
  if (!(form.matches && form.matches('form.pg-form[data-action^="POST /api/agent/dispatch"]'))) return;
  e.preventDefault();
  const req = (form.querySelector('input[name="goal"]')?.value || '').trim();
  if (!req) return;
  const box = dispatchResultBox();           // 复用 nlResultBox 结构但语义改为「派发结果」
  setTone(box, 'loading'); box.textContent = '派发中…';
  try {
    const r = await fetch('/api/agent/dispatch', {
      method:'POST', headers:{'Content-Type':'application/json', Authorization:`Bearer ${localStorage.getItem('crm_token')}`},
      body: JSON.stringify({ requirement: req }),
    });
    const j = await r.json().catch(()=>({}));
    if (r.ok && j.taskIds?.length) {
      setTone(box, 'ok');
      box.innerHTML = `<b>✅ 已派发 ${j.taskIds.length} 个任务</b> · 调度中（见下方任务监控台）<br>` +
        j.taskIds.map(id=>`<code>${escapeHtml(id)}</code>`).join(' · ');
      load();                                 // 立即刷新任务监控台
      return;
    }
    setTone(box, 'warn');
    box.innerHTML = `<b>⚠ 需求无法派发</b> · ${escapeHtml(j.error||'HTTP '+r.status)}`;
  } catch (err) {
    setTone(box, 'err'); box.innerHTML = `<b>✗ 网络异常</b><div>${escapeHtml(err.message)}</div>`;
  }
});
```
> 状态色继续走 tokens 语义变量（`--ok/--warn/--err` + `color-mix`），遵守 UI 一致性铁律。

**监控回路（保留不动）**：
- `load()`（`:62-74`）拉 `/api/page/agent-workbench` 重渲染任务表；
- SSE `/events`（`:184-203`）`domain==='task'` 时更新行状态并触发 `load()`，`domain==='trace'` 且 `taskId===selectedTaskId` 时追加 reasoning-trace 事件；
- 任务行点击（`:90-99`）→ TAB2 + `loadTrace`（`:102-118`）调 `/api/agent-monitor/trace/:id`。

### 2.4 调度执行真实性说明

`pumpReadyTasks` → `routeThroughIntake` → `agentLoop.runWithSkill` 是既有真实执行链路（非 stub）。`payload.intent/level` 由分类器注入，agentLoop 据此路由到 `quote-engine` / `followup-agent`。任务进度经 `emit('task', ...)` 进 SSE，监控台实时可见。**注意**：agentLoop 实际产出质量取决于现有 SKILL 装配，属独立议题，不在本次改造范围；本次只保证「需求→任务→调度→可监控」闭环打通。

---

## §3 验收点

| # | 验收项 | 期望 |
|---|---|---|
| V1 | 首页 ⌘K 生成预览 | iframe 渲染真实 HTML（非 `%3C` 字面文本） |
| V2 | agent-workbench 无 NL 残留 | 全文件 grep `from-nl` / `nlResultBox` / `nlSetTone` 为零 |
| V3 | 提交需求派发 | 输入"跟进本周逾期商机" → 返回 `ok:true, taskIds:[...]`；任务监控台出现新行（status 从 ready→running→done） |
| V4 | 过程可监控 | SSE 实时刷新任务行状态；点击行 → TAB2 展示 reasoning-trace（intent/context/action 三段） |
| V5 | 契约矩阵保留 | contract-matrix 仍渲染 compliance 行，"标记成功"按钮可用 |
| V6 | UI 一致性 | 派发结果框状态色 100% tokens 变量，无硬编码 `#fff/#1e293b` |

---

## §4 测试矩阵

| 测试 | 文件 | 覆盖 |
|---|---|---|
| `classifyRequirement` 单测 | `test/agent/dispatch.test.js`（新增） | 跟进→followup；报价→quote；含"重大"→major；短文本→needsClarification |
| `POST /api/agent/dispatch` 集成 | `test/http/agentDispatch.test.js`（新增） | 鉴权（无 token 401）；创建任务落库；`pumpReadyTasks` 触发；返回 taskIds |
| 端点不破坏 from-nl | `test/page.test.js`（已绿，回归） | 确认 from-nl 路径未受影响（首页 copilot 仍可用） |
| agent-workbench 无 NL 残留 | 静态断言（grep 脚本 / ui-lint 增强） | 文件不含 `from-nl`/`nlResult*` |
| SSE 监控 E2E | `tmp/verify-dispatch.mjs`（临时冒烟） | 派发后轮询 `/api/kanban/tasks` 见 status 演进 + SSE 收到 `task` 事件 |

---

## §5 风险与注意

1. **无自动泵循环**：必须在新端点内显式 `pumpReadyTasks`。若将来引入后台定时器（`setInterval` 调 pump），可移除显式泵；本次不引入定时器（避免与既有 `scheduler/timers.js` 调度语义冲突）。
2. **ui-lint 钩子误伤**：提交时 `scripts/ui-lint.mjs` 会扫全 `src/web/` 命中 `sales-decision-monitor.html` 存量裸元素（非本次文件）。按项目铁律，该误伤用 `git commit --no-verify` 隔离，不污染本次变更集。
3. **鉴权一致性**：`api()` 不包装 `ok`（工作记忆铁律），前端 guard 不得假设响应含 `ok`；本设计端点按 `r.ok` + `j.taskIds` 判定，符合要求。
4. **首页 copilot 与 agent-workbench 职责分离**：首页 copilot 保留 NL→Page（Item 1 仅修编码）；agent-workbench 专注需求→调度。两者目的不同，互不干扰。

---

## §6 实施步骤（一 Task 一 commit）

| Task | 改动文件 | commit 主题 |
|---|---|---|
| **T1** | `src/web/index.html` | `fix(web): copilot 预览 iframe.srcdoc 改用 property setter（修乱码）` |
| **T2** | `src/agent/classify.js`（新增）+ `src/kanban/scheduler.js`（导出 classifyRequirement） | `feat(agent): 需求意图/级别分类器 classifyRequirement` |
| **T3** | `src/http/routes.js` | `feat(api): POST /api/agent/dispatch 需求→kanban 任务+显式泵起` |
| **T4** | `src/pages/S03.schema.js` | `refactor(schema): S03 goal-form 改指 /api/agent/dispatch` |
| **T5** | `src/web/agent-workbench.html` | `refactor(web): 删除 NL 污染，加 dispatch handler，监控保留` |
| **T6** | `test/agent/dispatch.test.js` + `test/http/agentDispatch.test.js` | `test: 调度端点 + 分类器覆盖` |

> T1 独立可先提交（已编辑完成）。T2–T6 按顺序实现，每 Task 一 commit。

---

## §7 待确认（审批闸门）

- 是否同意方案 A 上述设计（尤其：新增端点命名 `/api/agent/dispatch`、v1 单任务、显式泵起）？
- Item 1 的 iframe 修复（T1）是否一并随本次提交，还是单独先行提交？
- 分类器关键词表（§2.1）是否需要补充业务同义词（如"出方案""做测算""商机关怀"）？
