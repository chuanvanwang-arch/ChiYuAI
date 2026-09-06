# 事件触发式复盘（决策→复盘闭环自动派发）设计文档

- 日期：2026-09-01
- 线程：契约闭环收口后续项 ③（① method-* 真执行已落地；② gate 阻断式 / ④ skillCalls 拆分未做）
- 阶段：brainstorming（设计先行，未批准不写实现代码）
- 铁律依据：设计先行（brainstorming→writing-plans→实现）；阈值配置化（config_store，禁止硬编码）；零 schema 迁移优先；绝对禁止 DELETE。

## §0 结论速览

| 项 | 结论 |
|---|---|
| 缺口 | `confirmDecision` 落地时已 emit `decision:confirmed`，但无订阅者据此自动派发 `decision-retro` agent；复盘仅人工/意图词触发 |
| 方案 | A：订阅 `decision:confirmed` 事件总线 → `business_tier`+冷却窗过滤 → `createTask(intent='retro')` 经 scheduler 派发 decision-retro（仿 financeAlertHook，解耦、零迁移） |
| 改动面 | 新增 `src/decision/retroTrigger.js`；`src/http/server.js` 挂载点（仿 :39）；可选 `config_store['event-retro']` 键（免迁移，缺省 fail-open） |
| 与夜间复盘的边界 | `timers.js:77 runDecisionRetro` 是 J3 校准层 24h 批量（落 decision_retro_report，不经 agent）；本事件是 agent 契约矩阵路径自动跑，二者互补不互斥 |
| 验收 | 单测：HIGH 决策 confirmed→建 retro 任务；NORMAL/已存在近期 retro/disabled→跳过。真实验证：confirmDecision(HIGH)→自动派发→ct-retro-decision episode 落库→矩阵绿 |

## §1 现象

用户（王川）在契约闭环收口后指出：复盘智能体（decision-retro）当前只在某些人工动作下才"跑"——即只有用户显式说"复盘本月重大决策质量…"时，`classify` 才会产出 `intent:'retro'` 并经 `routeThroughIntake` 派发给 `decision-retro`。

这导致一个结构性缺口：**重大决策落地（confirmDecision）后，系统从不自动回看该决策的质量**。① 已让 `decision-retrospective` SKILL 真执行（读近期决策→汇总→j_judge 出整改处方），但该能力只能被动等待人工触发，无法形成"决策→复盘"自动闭环。

## §2 根因（file:line 证据）

1. **决策落地有事件、无订阅者复用**（核心）：
   - `src/decision/decisionRepo.js:268` `confirmDecision(decision_id, {by_id,by_role})` 在 `UPDATE ... SET state='CONFIRMED'` 后于 `:281` `emit('decision','confirmed',{decision_id, by_role})`。
   - 全局 grep `on('decision'` 仅 `src/calibration/autoSuggest.js`（`registerAutoSuggest`，监听 decision-created/outcome-set/feedback-set 出校准建议浮卡）——**无任何订阅者将 confirmed 映射到 retro 派发**。
   - 即：语义最干净的"决策已落地"信号已存在，但闭环的最后一段（自动拉起复盘）从未接线。

2. **决策表无 `level` 列，只有 `business_tier`**：
   - `db/schema.sql:156+` `decision` 表含 `business_tier`（createDecision 缺省 `'NORMAL'`，`decisionRepo.js:48`），**无 intake 层的 L1/L2/L3 `level`**。
   - 因此事件触发筛选须基于 `business_tier`（NORMAL/HIGH/CRITICAL），而非 intake `level`。`confirmDecision` 的 emit payload 也未带 tier，需在 handler 内 `SELECT business_tier, tenant_id FROM crm.decision WHERE decision_id=$1` 取。

3. **已有夜间批量复盘，但路径不同（避免重复造轮）**：
   - `src/scheduler/timers.js:77-83` 每 24h `runDecisionRetro({windowHours:24})`（import `src/decision/retro.js`），落 `decision_retro_report`（追加式，J3 校准层批量深度归因）。
   - 该路径**不经过 agent/scheduler/契约矩阵**，与本次要接线的 agent 契约矩阵路径（`ct-retro-decision` episode）是两种产物：校准报告 vs 合规证据。二者互补，本设计**不替换**夜间定时器。

4. **派发链已就绪（① 收口验证过）**：
   - `src/kanban/kanban.js:34` `createTask({tenantId,chainId,step,title,actionName,payload,dependsOn,decisionId})` → 落 `status='ready'`。
   - `src/kanban/scheduler.js:38` `routeThroughIntake` 读 `task.payload.intent==='retro'` → `targetAgent='decision-retro'`；`:79` `dispatchOneCore` 泵起执行。
   - `seed-actions.js:1321-1352` 已有先例：某 action 内 `classifyRequirement→createTask→pumpReadyTasks` 闭环，证明"程序化建单 + 立即泵"范式可用。

## §3 方案选型（2-3 方案权衡）

### 触发接入点

- **A（推荐）：事件总线订阅 `decision:confirmed`**
  - 实现：新增 `src/decision/retroTrigger.js` `registerRetroTrigger()`，`on('decision', msg => { if(msg.type!=='confirmed')return; ... })`，仿 `financeAlertHook.js:14` 范式（订阅→动态读 config→建单/告警，异常隔离）。
  - 挂载：`src/http/server.js:39` 紧随 `registerFinanceAlertHook()` 之后 `try{registerRetroTrigger()}catch`。
  - 优点：决策层与 kanban 解耦；复用既有 emit；多订阅者并存（autoSuggest 已订阅 decision 域）无冲突；失败绝不阻断 confirmDecision 主写（bus.js:29 订阅者异常隔离 + handler 内 try/catch）。
  - 缺点：事件异步，复盘任务有秒级延迟（业务可接受）。

- **B：在 `confirmDecision` 内同步调用触发**
  - 实现：直接在 `decisionRepo.js:281` 后 `await maybeTriggerRetro(...)`。
  - 优点：触发点最精确、同步可见。
  - 缺点：决策层直接 `import` kanban/scheduler，耦合违反分层；confirmDecision 是写关键路径，异常需小心隔离（虽 bus 已隔离，但同步 await 仍拖慢主写）；不推荐。

- **C：用事件触发替换夜间 `runDecisionRetro` 定时器**
  - 实现：删除 `timers.js:77` 定时器，改由事件触发。
  - 优点：单一复盘入口。
  - 缺点：丢失"每日全量批量"节奏（夜间批量产 `decision_retro_report` 校准报告，与 agent 路径产物不同）；且事件只在大决策落地时触发，普通决策永不进校准报告。不推荐。

**结论：选 A。**

### 触发阈值（配置键）

- `config_store['event-retro']` 形状：`{ enabled:true, min_tier:'HIGH', cooldown_hours:24 }`。
- `readConfig('event-retro',{tenantId:'system'})` 返回 `{value}` 或 null → 缺省 `DEFAULT_CFG`（fail-open，铁律：阈值配置化、不硬编码）。
- `min_tier` 默认 **'HIGH'**（对齐用户"重大决策"语义；配 'NORMAL' 即全流程复盘）。`TIER_RANK={NORMAL:0,HIGH:1,CRITICAL:2}` 比较。
- `cooldown_hours` 默认 24：同租户窗口内至多 1 个 retro 任务（防 floods；手动"复盘"任务 `intent='retro'` 也计入冷却，避免与事件触发重复）。

### 幂等/去重

- 冷却查询：`SELECT id FROM crm.tasks WHERE payload->>'intent'='retro' AND tenant_id=$1 AND created_at >= now() - ($2||' hours')::interval LIMIT 1`；命中即跳过。
- 不依赖 decision_id 唯一（一次复盘覆盖近期一批决策，非单决策），故按"近期是否有 retro 任务"节流，而非"该 decision 是否已复盘"。

## §4 改动清单

| 文件 | 改动 |
|---|---|
| `src/decision/retroTrigger.js`（新） | `registerRetroTrigger()`：订阅 `decision:confirmed`→取 tier/tenant→配置过滤→冷却去重→`createTask(intent='retro',actionName='decision-retrospective',payload:{intent:'retro',level:'L2',decision_id,triggered_by:'event'},decisionId)`→`pumpReadyTasks({})`。`unregisterRetroTrigger()` 对称。 |
| `src/http/server.js` | `:39` 后追加 `try { registerRetroTrigger(); } catch (e) { console.log('[retro-trigger] register fail: ...'); }`（仿 finance hook 挂载形态）。 |
| `docs/specs/2026-08-29-agent-workbench-contract-monitor-design.md`（可选） | 在 decision-retro 契约块注释补充"事件触发：重大决策 confirmed 自动派发"。 |
| Config Center（可选后续） | `config_store['event-retro']` 键可在 `/config` 前端暴露编辑（非必需，缺省 fail-open 已可用）。 |

**零 schema 迁移**：`tasks` 表已有 `payload`(jsonb) 与 `decision_id` 列（`schema.sql:76-77`）；`config_store` 读缺省即用。

## §5 验收标准

1. **单元（mock 隔离）**：`test/event-triggered-retro.test.js`
   - `decision:confirmed` + business_tier='HIGH' → `createTask` 被调用且 payload.intent==='retro'、actionName==='decision-retrospective'。
   - business_tier='NORMAL'（< min_tier HIGH）→ `createTask` 不被调用。
   - 同租户已有近期 `intent='retro'` 任务 → 跳过（不重复建）。
   - `config_store['event-retro'].enabled=false` → 跳过。
   - 异常（query 抛错）→ 不抛、不阻断（handler 内 catch）。
2. **集成（真库）**：构造 HIGH 决策 → `confirmDecision` → 断言 `crm.tasks` 出现 intent='retro' 任务 → `pumpReadyTasks` 派发 → `monitor_event` 出现 `ct-retro-decision` episode（skill=`decision-retrospective`）→ 契约矩阵 decision-retro 行 `skill_ok=true`。
3. **回归**：改动面单测 + `retro-wiring`/`g4`/`classify`/`method-skill-real-execution` 全绿。

## §6 风险与回滚

- **LLM 未配置**：`decision-retrospective` 的 j_judge 步降级（① 已验证不崩），rule 步仍产出批量汇总→episode 照常落库→矩阵绿。不影响闭环。
- **冷却窗过短导致 floods**：默认 24h/租户上限；调大 `cooldown_hours` 即可。
- **与夜间 `runDecisionRetro` 双写**：二者产物不同（报告 vs episode），不冲突；若运营认为噪声大，调 `min_tier` 或禁用事件触发（config）。
- **回滚**：单文件新增 + server.js 一行挂载；删挂载行 + 文件即完全回滚，零数据影响。

## §7 后续（非本次，需另行 brainstorming）

- ② gate 阻断式：review-gate 不通过时主任务挂起（当前非阻断）。
- ④ skillCalls/actionCalls 拆分：agent 授权语义归一。
- 其余 12 个 method-*（bant/meddicc/…）补 steps[]（当前降级护栏）。
- config_center 暴露 `event-retro` 编辑 UI。

## §8 实施记录（批准后回填，2026-09-01）

方案 A 已按 `docs/superpowers/plans/2026-09-01-event-triggered-retro-plan.md` 全量落地并验证。

### §8.1 改动清单（实际落地）

| 文件 | 改动 | 对应 Task |
|---|---|---|
| `src/decision/retroTrigger.js`（新） | 事件订阅器：`registerRetroTrigger()` 幂等挂载 `on('decision', …)`；`maybeTriggerRetro()` 走 分级闸(`tierPasses`)→冷却闸(`hasRecentRetroTask`)→`createTask(intent='retro',actionName='decision-retrospective',payload:{intent,level:'L2',decision_id,business_tier,triggered_by:'event',source:'decision:confirmed'},decisionId)`→`auto_pump` 调 `pumpReadyTasks({tenantId})`。`readEventRetroConfig()` fail-open（读异常→出厂默认）。`loadDecisionMeta()` 双段回退容 `tenant_id` 缺列。 | A (#10) |
| `src/kanban/scheduler.js` | `pumpReadyTasks({chainId=null,tenantId='system'})` 转发 `tenantId` 至 `listTasks`（修复非 system 租户 ready 任务永不被泵起的缺口）。 | B (#13) |
| `src/http/server.js` | `:39` 后 `try { registerRetroTrigger(); } catch (e) { … }`（仿 finance hook 挂载，失败仅日志）。 | B (#13) |
| `test/event-triggered-retro.test.js`（新） | 21 例单测（6 类语义 + 冷却闸 + 旧库容错 + 路由 + 多租户透传 + 订阅幂等/异常隔离）。 | C (#14) |
| `tmp/probe-retro-event.mjs`（已删） | 真库端到端冒烟（HIGH→+1 / cooldown→+0 / NORMAL→+0）。 | D (#12) |
| `src/portal/configCenter.js` / `config.html` / `event-retro-config.html`（新）/ `routes.js` | 阈值配置化铁律补强：Config Center id35「事件触发复盘配置」三处同步（CONFIG_ITEMS / GROUPS / 单测）；`createConfigRouter({key:'event-retro',role:'sysadmin',decisionScene:'config-change'})` 端点 + 专属受控页（仅 tokens.css 变量，含 `injectLayout` 壳）。 | #13 附加 |

### §8.2 验证结果

- **单元测试** `test/event-triggered-retro.test.js`：**21/21 通过**（mock 隔离 db/kanban/configStore/scheduler，不触真库）。
- **真实库冒烟** `tmp/probe-retro-event.mjs`（PGDATABASE=plm_test）：写 `config_store['event-retro']` → `registerRetroTrigger()` → `createDecision(LOSS_REVIEW, HIGH/CRITICAL/NORMAL)` → `confirmDecision` → 断言 `crm.tasks` retro 计数 **PASS**（HIGH→+1，冷却命中→+0，NORMAL→+0）。
- **回归**：
  - 改动面单测 `test/event-triggered-retro.test.js` 21 绿；
  - `test/web` 312 例全绿（含新增 `event-retro-config.html` 经 `nav-path.test.js` 校验 `injectLayout` 壳、修复 `approval-config.html` 缺壳的既有 red）；
  - `test/config` 全绿（`configCenter.test.js` 23 项、修复 `edgeBindings.test.js` 2 处引用已删 id33 的既有 red）；
  - 改动面 6 文件回归 52/52 绿。
- **质量门禁**：`node scripts/ui-lint.mjs` → 通过（63 文件，0 错误）；`python tmp/audit_css_vars.py` → OK 无 CSS 变量一致性问题。

### §8.3 阈值配置化落地（铁律遵守）

`config_store['event-retro']` 形状与出厂默认一致：`{enabled:true, min_tier:'HIGH', cooldown_hours:24, auto_pump:true}`。代码内 `DEFAULT_EVENT_RETRO_CFG` 仅 fail-open 兜底；运营可经 Config Center（id35 → `/event-retro-config.html` → `PUT /api/config/event-retro`，写经决策第 0 闸 + sysadmin）覆盖 `min_tier`/`cooldown_hours`/`enabled`/`auto_pump`，**不硬编码**。

### §8.4 与夜间复盘的边界（重申，未替换）

`timers.js:77 runDecisionRetro` 24h 批量落 `decision_retro_report`（J3 校准层）；本事件路径落 `ct-retro-decision` episode（agent 契约合规证据）。产物不同、互补不互斥。

### §8.5 提交状态

未 commit（无凭证铁律，请用户本地按功能线提交；涉及：`src/decision/retroTrigger.js` / `src/kanban/scheduler.js` / `src/http/server.js` / `src/portal/configCenter.js` / `src/web/config.html` / `src/web/event-retro-config.html` / `src/http/routes.js` / `test/event-triggered-retro.test.js` / `test/web/configCenter.test.js` / `test/config/edgeBindings.test.js`）。
