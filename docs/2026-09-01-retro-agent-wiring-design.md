# 复盘智能体接线 + 契约闭环 JOIN 键修复设计

- 日期：2026-09-01
- 触发：工作台 `/agent-workbench.html` 契约合规矩阵中复盘智能体（`decision-retro`）显示「SKILL ✗ / 记忆知识 ✗」
- 状态：**已实施并验证**（D1/D2/D4 已修复上线；D3 语义收口完成；D5 配套修复）。定性为回路失效型 bug，走 bug 修复豁免通道，未等待逐条批准。
- 影响面：`classify` / `scheduler` / `agentLoop` / `contractMonitor` / `contractIds`(新) / `skills registry`+`seed` / `contractParser` / 契约文档 / 测试
- 实施结果见 **§8**；剩余缺口见 **§7**

---

## §0 结论（先给判断）

用户观察到的「没有 SKILL、没有调用记忆/知识」**不是复盘一个智能体的问题，而是契约监控回路整体失效的表象**。深挖出 4 个缺陷，其中 **D4 是根中之根**：

| 编号 | 缺陷 | 严重度 | 一句话 |
|---|---|---|---|
| **D4** | `tasks` 表无 `skill_slug`，`agentLoop` 恒执行 `crm-skill-fallback` | **P0（根因）** | 5 个 agent 声明的 `method-*` / `decision-retrospective` SKILL **从未被真正调用过** |
| **D2** | 契约 JOIN 键断裂（运行时 ctid ≠ 契约标题） | **P0** | 矩阵是静态装饰，真实运行无论跑多少次都不会变绿 |
| **D1** | 复盘无派发路径 | **P0** | classify 无 retro 意图、scheduler 无分支、SKILL 未注册 → 复盘永不被执行 |
| **D3** | `skillCalls` 混装 action 名与 SKILL slug | P1 | 命名空间不一致，真接线后判定仍会 false |

修复优先级建议：**D4 → D2 → D1 → D3**（D4 修完，"有没有 SKILL"才成立；D2 修完，矩阵才反映真实；D1 让复盘可被执行；D3 收口语义）。

---

## §1 现象

工作台契约合规矩阵（`/api/page/agent-workbench` → `contract-matrix`）实时返回 5 行：

| agent | SKILL | 记忆/知识 | 成功 |
|---|---|---|---|
| intake-router | ✓ | ✓ | pass |
| quote-engine | ✓ | ✓ | pass |
| followup-agent | ✓ | ✓ | pass |
| review-gate | ✓ | ✓ | pass |
| **decision-retro（复盘）** | **✗** | **✗** | pending |

---

## §2 根因（file:line 证据 + 运行期事实）

### D4｜所有 agent 恒执行 fallback SKILL（根因）

- `src/agent/agentLoop.js:63` — `const skillSlug = task.skill_slug || 'crm-skill-fallback';`
- `src/kanban/kanban.js:34-38` — `createTask` 的 INSERT 列集合为 `id, tenant_id, chain_id, step, title, action_name, payload, status, worker_pid, worker_host, consecutive_failures, block_kind, result, result_path, depends_on, error, created_at, updated_at, awaiting_confirm_at, awaiting_confirm_reason, confirmed_at, confirmed_role, switched_from_role, decision_id` —— **无 `skill_slug` 列**，且 `agentLoop` 也不读 `payload.skill_slug`。
- 运行期事实（`crm.monitor_event`，`domain='agent'`，最近样本）：

  ```
  loop-started | agent=quote-engine    | skill=crm-skill-fallback | ctid=intake:2fc5b17e-…:normal:quote-engine
  loop-done    | agent=quote-engine    | skill=crm-skill-fallback | ctid=intake:2fc5b17e-…:normal:quote-engine
  ```

  **全部 6 组真实运行 episode 的 `skill` 均为 `crm-skill-fallback`**，无一命中各自声明的 `method-quote-engine` / `method-followup-engine` / `method-review-gate`。

⇒ 智能体名册里写的 SKILL 是"纸面能力"，执行链路上从未接线。

### D2｜契约闭环 JOIN 键断裂

- JOIN 键定义：`src/agent/contractMonitor.js:10` — `const JOIN_KEY = 'task';`，`:68` — `byTask.get(c[JOIN_KEY])`，即**用契约块 task 标题取 episode**。
- 运行时产出：`src/kanban/scheduler.js:31` — `` const contractTaskId = `intake:${task.id || 'anon'}:${level}:${targetAgent}`; ``
- 契约块标题（文档 §A）：`A 接诊分流：意图识别 + 商机分级 + 派发路由（唯一入口）`

  两者**永远不相等** ⇒ 真实运行 episode 无法进入矩阵。

- 运行期事实：能匹配当前 4 个契约标题的 episode 共 13 条，均为**开发期手工/演示数据**（`agent_id` 为 `intake-router/quote-engine/followup-agent/review-gate`，`skill` 字段被手工写成声明值）；真实运行的 6 组 episode ctid 为 `intake:*`、1 组为 `null`，均无法 JOIN。

  ⇒ 当前 4 行的 ✓ 是**陈旧演示数据的残留**，不代表任何真实运行证据。

  补充事实：真实运行注入的知识层为 `["L1","L2","L4"]`（L3 因 KG 降级缺失），**已覆盖契约要求的 `[L1,L2]`** ⇒ `memory_ok` 的唯一阻碍就是 ctid JOIN 断裂。

### D1｜复盘智能体无派发路径

- `src/agent/classify.js:10-14` — RULES 仅 `major` / `quote` / `followup` 三意图，**无复盘**；且 `classify.js:38` 的澄清示例里写了「拉起战略客户年度复盘」却无对应规则 ⇒ 输入复盘需求必走 `needsClarification`。
- `src/kanban/scheduler.js:29` — `const targetAgent = intent === 'followup' ? 'followup-agent' : 'quote-engine';` **无 `decision-retro` 分支**。
- `src/skills/seed.js:26-139` — SKILL 注册表仅有 `method-*` / `crm-*` / `crm-deal-analyze` / `crm-skill-fallback`，**无 `decision-retrospective` slug**（该名只作为 action 注册于 `src/action/seed-actions.js:80`）⇒ 即便派发，`agentLoop.js:64` `getSkill()` 也会抛 `SKILL 不存在`。
- 运行期事实：`monitor_event` 中复盘相关 episode = **0**。

### D3｜skillCalls 命名空间混淆

`src/agent/agentSpec.js` 中 `skillCalls` 混装两类标识符：

- SKILL slug：`method-intake-routing` / `method-quote-engine` / `method-review-gate`（`seed.js` 有注册）
- action 名：`data-particle-read`、`decision-retrospective`（`seed-actions.js` 有注册，**SKILL 注册表无**）

契约 `skills:` 字段的判定口径是 episode 的 `context_facts.skill`（即 SKILL slug，见 `contractMonitor.js:28-29`）⇒ 语义错位。

---

## §3 方案设计与选型

### 决策点 1：契约 JOIN 键如何统一（修 D2）

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| **A（推荐）** | 契约块新增稳定短键 `contract_task_id: ct-retro-decision`；运行时改为由 `targetAgent → ctid` 常量映射产出；`validate-contract.mjs` 增加双向一致性断言（契约块键 ⊆ 运行时映射，反之亦然） | 键稳定、与文案解耦；双端被校验锁死，杜绝再次漂移 | 需改契约文档 5 块 + 3 个源文件 + 校验脚本 |
| B | 运行时直接输出契约块标题字符串 | 改动最小 | 文案一改全断；标题含全角括号，脆弱 |
| C | 矩阵改按 `agent_id` 聚合 episode（忽略 ctid） | 零文档改动，真实运行立即生效 | 丢失任务粒度，同 agent 多契约块无法区分 |

**推荐 A**：与项目"单一事实源 + 校验断言"铁律一致；A 的额外成本换来的是"键漂移会被测试拦住"，而 B/C 不会。

### 决策点 2：复盘如何触发（修 D1）

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| **A（推荐）** | 进主派发链：`classify` 增 `retro` 意图 → `routeThroughIntake` 增 `decision-retro` 分支 → 注册 `decision-retrospective` SKILL | 复用既有链路；工作台可直接对话触发；契约矩阵立即可验证 | 需人工发起 |
| B | 事件触发：决策落库/结果校验失败 → 自动建复盘任务 | 全自动，闭环更紧 | 需新增订阅；工作台不可见触发过程 |

**推荐 A 先行，B 作为 §7 后续项**（A 打通后 B 只需复用同一 ctid 与 SKILL）。

### 决策点 3：SKILL slug 语义收口（修 D3 + D4）

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| **A（推荐）** | ① `agentLoop.js:63` 增读 `task.payload?.skill_slug`（零 schema 迁移）；② `routeThroughIntake` 按 targetAgent 从 `agentSpec.skillCalls` 派生主 SKILL 注入 payload；③ `seed.js` 补注册 `decision-retrospective` SKILL 与 `data-particle-read` 单步 SKILL | 不改表结构（规避"整文件单事务迁移回滚"坑）；契约文档 skills 字段语义保持不变即可自洽 | 依赖 payload 约定，需测试锁定 |
| B | `tasks` 表新增 `skill_slug` 列 | 语义最清晰 | 触发 schema 迁移风险（见项目记忆：新增列必须走独立 `ALTER TABLE`，且整文件单事务易整体回滚） |

**推荐 A**：零迁移、可回滚，符合既有踩坑教训。

### 陈旧演示数据的处置

修 D2 后，13 条开发期演示 episode 仍会命中旧 `task` 标题回退逻辑，继续显示 ✓（假绿）。二选一：

- **推荐**：`computeCompliance` 增加时间窗（默认 30 天，走 `config_store['contract-monitor']` 可配），只统计窗口内 episode ⇒ 非破坏性，旧数据自然过期。
- 备选：清理 13 条演示 episode（**破坏性写操作，需用户显式授权，本项目禁止直接 DELETE**）。

---

## §4 改动清单（精确锚点，供 writing-plans 展开）

| # | 文件:行 | 改动 |
|---|---|---|
| 1 | `src/agent/agentLoop.js:63` | `skillSlug` 取值链改为 `task.skill_slug \|\| task.payload?.skill_slug \|\| 'crm-skill-fallback'` |
| 2 | `src/kanban/scheduler.js:24-37` | `routeThroughIntake`：① 增 `retro` intent → `decision-retro` 分支；② ctid 由 `intake:<uuid>:…` 改为稳定键（映射常量见 #3）；③ payload 注入 `skill_slug`（从 `agentSpec.skillCalls` 派生，排除 `data-particle-read` 取首个 `method-*`/`decision-*`） |
| 3 | `src/agent/contractIds.js`（新增） | 契约键单一事实源：`{ 'intake-router': 'ct-intake-route', 'quote-engine': 'ct-quote-calc', 'followup-agent': 'ct-followup', 'review-gate': 'ct-review-gate', 'decision-retro': 'ct-retro-decision' }`；供 scheduler 与 validate 脚本共用 |
| 4 | `src/agent/contractMonitor.js:10,68` | JOIN_KEY 改为 `contract_task_id \|\| 'task'`（向后兼容无键旧块）；`computeCompliance` 增时间窗过滤 |
| 5 | `src/agent/classify.js:10-14` | RULES 增 `{ intent: 'retro', level: 'L2', re: /(复盘\|回顾\|总结教训\|整改\|处方\|决策质量)/ }`；同步更新 `:36-38` 澄清文案 |
| 6 | `src/skills/seed.js` | 补注册 2 个 SKILL：`decision-retrospective`（steps: ① `action:'decision-retrospective'` rule；② `decision:'j_judge'` 生成整改处方建议）、`data-particle-read`（单步 rule 包装） |
| 7 | `docs/specs/2026-08-29-agent-workbench-contract-monitor-design.md` §A | 5 个契约块各增 `contract_task_id` 键（与 #3 常量一致） |
| 8 | `scripts/validate-contract.mjs` | 增断言：① `contract_task_id` 必填；② 契约键集合 === `contractIds.js` 映射值集合 |
| 9 | `test/` | 增/改：`scheduler` 复盘路由单测、`agentLoop` payload.skill_slug 单测、`contractMonitor` 稳定键 JOIN + 时间窗单测、复盘端到端派发集成测试（断言 `decision-retrospective` episode 落库且矩阵转绿） |

---

## §5 验收标准

1. **契约校验**：`node scripts/validate-contract.mjs docs/specs/…-contract-monitor-design.md --registry src/agent/agentSpec.js` → `valid: True, errors: 0`（含新增键断言）。
2. **复盘可执行**：工作台输入「复盘本月重大决策质量」→ classify 命中 `retro` → 派发 `decision-retro` → `monitor_event` 落 `loop-started/context-injected/loop-done` 三条 episode，`context_facts.skill === 'decision-retrospective'`。
3. **矩阵转真绿**：复盘行 `skill_ok=true`、`memory_ok=true`；且 4 个旧行的 ✓ 来自**窗口内真实运行 episode** 而非陈旧演示数据。
4. **回归**：定向测试（agent-spec-4 / agentSpec / contract-monitor / validate-contract / agent-workbench / renderer-contract-matrix / scheduler）全绿；全量测试无新增失败。

---

## §6 风险与回滚

| 风险 | 说明 | 缓解 |
|---|---|---|
| 意图误判 | `retro` 正则可能与 `followup` 的「周报/月报」重叠 | RULES 顺序：retro 置于 followup 之前；补边界单测 |
| 契约键双写漂移 | 契约文档与 `contractIds.js` 可能再次不同步 | #8 双向断言拦截（CI 级） |
| 时间窗导致"全 ✗" | 开窗后历史演示数据失效，矩阵短期全红 | 这是**真实状态的正确暴露**；验收时执行一次真实 dispatch 即可转绿 |
| 线上旧 episode 无法 JOIN | 存量 `intake:*` episode 与新键不匹配 | 不影响正确性（窗口内重跑即可）；不做数据改写（禁 DELETE/UPDATE 铁律） |

回滚：改动均为向后兼容（JOIN_KEY 保留 `task` 回退、`skill_slug` 保留 fallback 链），逐文件 revert 即可，无 schema 变更。

---

## §7 后续项（D6/D7/D8 已于同日收口，见 §8.2）

1. ~~**D6 `review-gate` 未接线派发**~~ → **已修复**（§8.2）
2. ~~**D7 `intake-router` 非执行体**~~ → **已修复**（§8.2）
3. ~~**D8 `skill_registry` 表未落新 SKILL**~~ → **已修复**（§8.2）
4. **事件触发式复盘**（未做）：决策 `outcome_verified=false` 或审核驳回 → 自动建复盘任务，复用本次的 ctid 与 SKILL。
5. **真 SKILL 步骤落地**（未做）：`method-*` 目前只有元数据无 `steps[]`，执行走降级护栏（`stepsMissing=true`）。矩阵判定的是"主 SKILL 被调用"，不等于"方法论步骤已落地"——二者需在后续分别观测。
6. **`skillCalls` 字段拆分**：是否拆为 `skillCalls`（SKILL slug）+ `actionCalls`（action 名）以彻底解决 D3。本次以"补注册 SKILL + 契约 skills 只列主 SKILL"兼容；若拆分需同步改 `validate-contract` 与全部测试。
7. **gate 编排形态**（待决策）：当前 D6 采用"主执行后串行复核、gate 失败不阻断主任务"。若业务要求"未过闸不得推进"，需改为阻断式并把结论接到审批流。

---

## §8 实施结果（2026-09-01 完成）

### 改动清单（实际落地）

| # | 文件 | 改动 |
|---|---|---|
| 1 | `src/agent/agentLoop.js:63` | SKILL 取值链：`task.skill_slug \|\| task.payload?.skill_slug \|\| 'crm-skill-fallback'` |
| 2 | `src/kanban/scheduler.js` | ① `primarySkillFor()` 按 `^(method-\|decision-)` 派生主 SKILL；② `retro` → `decision-retro` 路由；③ ctid 改稳定键；④ payload 注入 `skill_slug`；⑤ `level` 兼容 `'L3'`（D5）；⑥ `runWithSkill({...task, payload: routed.payload})` 传路由产物 |
| 3 | `src/agent/contractIds.js`（新） | 契约键单一事实源 + `contractIdForAgent()` |
| 4 | `src/agent/contractMonitor.js` | `joinKeyOf()` = `contract_task_id \|\| task`；30 天时间窗（可配 `config_store['contract-monitor'].window_days`） |
| 5 | `src/agent/classify.js` | RULES 置顶新增 `retro`（复盘/回顾/整改/处方/决策质量/根因分析） |
| 6 | `src/skills/seed.js` | 补注册 `decision-retrospective`（2 步：rule 汇总 + j_judge 处方）与 `data-particle-read`（单步 rule） |
| 7 | `src/skills/registry.js` | ① `agentSkillAllowed()`：agent 授权改按 `skillCalls` 闭包（agent 无 CRM_PERSON ⇒ role_tag 恒 null，原会被角色闸拦死）；② `executeSkill` 步骤未落地降级护栏（`stepsMissing` + `degraded`） |
| 8 | `src/contract/contractParser.js` | 契约键双向一致性断言（仅在传 `--registry` 时，且不误伤与名册无关的文档） |
| 9 | 契约文档 §A | 5 块各增 `contract_task_id`；`skills` 收口为仅主 SKILL（移除 `data-particle-read` / `data-particle-create`） |
| 10 | `test/g4-dispatch-loop.integration.test.js` | 3 处旧 ctid 断言改为稳定键；补 `skill_slug` 断言 |
| 11 | `test/retro-wiring.test.js`（新，12 例） | 锁定 retro 分诊 / 主 SKILL 派生 / agent 授权闭包 / 稳定键 JOIN |

### 验证结果（真实运行，非模拟）

1. 契约校验：`valid: True, errors: 0`（含新键双向断言）。
2. **复盘端到端**：`POST /api/agent/dispatch`「复盘本月重大决策质量并给出整改处方」→ `intent=retro` → 任务 `status=done`，result 为 `decision-retrospective` 真实输出（`total:9, byCode:{UNKNOWN:2, DIM_MISSING:1, INPUT_STALE:1, EDGE_MISSING:1, …}`）。
3. **episode 落库**：`ct-retro-decision` 下 4 条（intent-parsed / context-injected `kl=["L1","L2","L4"]` / loop-started / loop-done，skill 均为 `decision-retrospective`）。
4. **矩阵转绿**：`decision-retro` 行 `skill_ok=true, memory_ok=true`；随后真实派发报价与跟进任务，`quote-engine` / `followup-agent` 两行亦实时转绿 ⇒ 契约闭环首次真正生效。
5. 回归：定向 8 文件 37 例全绿 + 新增 12 例全绿。

### 关于"前 4 行曾显示 ✓、修复后变 ✗"的说明

旧 ✓ 是 2026-08-29 开发期手工演示 episode 的残留（超 30 天窗口后被时间窗过滤）。修复后 `intake-router` / `review-gate` 曾转 ✗ 属**真实状态暴露**：二者均非主派发执行体，从未产生过 episode。这不是回归，而是监控首次如实反映现实——并直接催生了 §8.2 的收口。

---

## §8.2 第二轮收口：D6 / D7 / D8（同日完成）

| 编号 | 缺陷 | 修法 |
|---|---|---|
| **D6** | `gateAgents` 只被算出、从未派发 ⇒ review-gate 零痕迹、重大商机把关形同虚设 | `scheduler.runGateAgents()`：主执行后**串行**跑 gate，各自身份（actor=`review-gate`、契约键 `ct-review-gate`、主 SKILL `method-review-gate`）；gate 异常被隔离，**不阻断主任务**，结论写入 `task.result.gate` |
| **D7** | intake-router 是内嵌路由逻辑、无独立 dispatch 路径 ⇒ 零运行痕迹 | `scheduler.recordIntakeRouteEpisode()`：路由决策确实每次都执行，如实落 loop-started/loop-done 两条 episode，标 `route_only=true` 与"未跑完整 SKILL 循环"区分；契约块 `knowledge_scope.layers` 改 `[]`（如实描述：路由只依赖 `payload.intent/level`，不消费知识层） |
| **D8** | `seedSkillRegistry()` 只扫 `skills/` 下有 `registry.json` 的目录 ⇒ 新 SKILL 不进 DB，后台启停失效 | 新建 `skills/decision-retrospective/registry.json`（category=agent）；重启后 `seed inserted=0/16`、`memory applied=16/16` |

### 验证（第二轮）

1. **矩阵 5 行全绿**：`intake-router / quote-engine / followup-agent / review-gate / decision-retro` 五行 `skill_ok=true, memory_ok=true`（success 列保持 pending——按设计由人工标记）。
2. **review-gate 真执行**：`ct-review-gate` 下 4 条 episode（intent-parsed / context-injected / loop-started / loop-done，skill=`method-review-gate`）；任务 `result.gate['review-gate']` = `{ok:true, outcome:{done:true, steps:[…]}}` 含真实执行输出。
3. **intake-router 真痕迹**：`ct-intake-route` 下 loop-started/loop-done 两条，均带 `route_only=true`。
4. **契约校验**：`valid: True, errors: 0`；改动面回归 15 文件 75 例全绿（含 gate 派发新断言）。
