# gate 阻断式（review-gate 不通过 → 主任务挂起）设计文档

- 日期：2026-09-01
- 线程：契约闭环收口后续项 ②（① method-* 真执行已落地；③ 事件触发式复盘已落地；④ skillCalls 拆分未做）
- 阶段：brainstorming（设计先行，未批准不写实现代码）—— **已批准（方案 C：真两阶段 pre-gate）**
- 铁律依据：设计先行（brainstorming→writing-plans→实现）；阈值配置化（config_store，禁止硬编码）；零 schema 迁移优先；绝对禁止 DELETE。

## §0 结论速览

| 项 | 结论 |
|---|---|
| 缺口 | `dispatchOneCore`（`scheduler.js:81-105`）先跑主 agent、再跑 `runGateAgents`、**无条件 `completeTask`**；且 `runGateAgents`（`scheduler.js:126-142`）只靠「SKILL 抛异常」判 `ok:false`，而 `method-review-gate` 是方法论 SKILL、返回 outcome 不抛 → **gate 永远 `ok:true`，阻断从未真正触发** |
| 方案 | **C：真两阶段 pre-gate**。gated（major/L3）任务先跑主 agent 出**草稿**（episode 落库，合法审计痕迹），再跑 `method-review-gate` 审草稿；引入 **verdict 契约**（`outcome.verdict: pass\|reject`）；verdict=pass→`completeTask`（定稿），reject→主任务转 `blocked`(`block_kind='gate_reject'`) 挂起、等人工裁决 |
| 改动面 | `method-review-gate` SKILL 补 verdict 输出约定；`runGateAgents` 读 verdict（异常→保守 reject）；新增 `gateBlockTask`+`approveGateBlock`（kanban）；`dispatchOneCore` 编排分支 |
| 影响范围 | 仅 `gateAgents.length>0`（即 `level==='major'`/`L3`）任务；**L2 复盘任务（③）不受影响**（其 `gateAgents=[]`） |
| 零 schema 迁移 | `tasks` 表已有 `status`(`blocked`)、`block_kind`、`error` 列（`blocked` 当前仅 `circuit_break` 用），复用即可；不新增列、不改枚举 |
| 验收 | 单测：major 任务 review-gate 返 reject→任务 `blocked`(gate_reject) 且未 `done`；返 pass→`done`；L2 复盘任务不被 gate 影响 |

## §1 现象

用户（王川）在契约闭环收口后指出：`review-gate` 设计为「双闸门 + 专家介入 + 四维审查」的重大商机把关智能体（`ct-review-gate`），但其「不通过」分支当前**形同虚设**——主任务（如报价测算 quote-engine）无论 review-gate 结论如何都会 `done`，把关没有强制力。这违背「重大商机必须经评审 sign-off 才定稿」的业务语义。

## §2 根因（file:line 证据）

1. **finalization 不依赖 gate**（`scheduler.js:99-101`）：
   - 注释明写「gate 失败不阻断主任务」。
   - 代码：`const gate = await runGateAgents(...); await completeTask(task.id, { result: { ..., gate } })`——gate 结果仅并入 `result`，**任务恒 `done`**。
2. **gate verdict 检测缺失**（`scheduler.js:126-142`）：
   - `runGateAgents` 仅 `try { out = await runWithSkill(...) } catch { ok: false }`——靠异常判失败。
   - 但 `method-review-gate`（`skills/method-review-gate/SKILL.md`）是纯方法论 markdown，`executeSkill` 返回 LLM `think` outcome（不抛异常），故 `ok` 恒 `true`，**「不通过」永不可达**。
3. **draft 与 official 无边界**：当前「官方态」= `tasks.status='done'`。草稿（episode/decision 事件）在 running 阶段已落，属审计痕迹，合法。故「真两阶段」= **gate 守 `completeTask`**——无需改写每个 SKILL 的 draft/apply 拆分（推理 agent 无独立 official 业务态可保护，YAGNI）。

## §3 方案选型（已批准 C）

### §3.1 为什么选 C（真两阶段 pre-gate）

- **A. blocked 态挂起**：主 agent 照常跑完，review-gate 判 reject→`blocked`，人工放行→`done`。复用 `blocked`+`resetTask`，改动最小。
  - 否决点：主 agent 产物（episode/outcome）在 `blocked` 前已 `completeTask` 之外的 running 阶段落库，A 与 C 在「产物已落」上等价；但 A 不要求 gate 在 finalization 前裁决，语义上「任务已跑完只是没定稿」可接受。**C 在 A 基础上强制 gate 守 finalization**，更彻底。用户明确选 C。
- **B. awaiting_confirm 范式**：复用 §6.13 confirm/cancel/timeout 全生命周期。语义最贴近「等审批」，但需扩展 `requestConfirm` 接受 running 源态，改动面与 C 相当却无「真两阶段」收益。**不采用**。
- **C. 真两阶段 pre-gate（采用）**：gate 在 finalization 前裁决；verdict=pass 才 `completeTask`（定稿=官方/被采纳），reject 则主任务转入挂起态、永不定稿。编排层即可成立（推理 agent 产物即 episode，非独立业务态），无需 SKILL draft/apply 拆分。

### §3.2 verdict 契约（核心前置）

`method-review-gate` outcome 须结构化返回：
```json
{ "verdict": "pass" | "reject", "defects": ["四维之一不通过：<说明>", "..."], "summary": "评审结论" }
```
- 缺省/异常→按**保守 reject**（fail-safe），避免「抛异常被当成通过」或「无 verdict 字段静默通过」。
- `runGateAgents` 消费 `outcome.verdict`：`'reject'`→`ok:false`+`defects`；`'pass'`/`ok:true`→通过；异常→`verdict:'reject'`。

### §3.3 两阶段编排（`dispatchOneCore` 改造，仅对 gated 任务）

```
claim → running
  → [阶段1 草稿] runWithSkill(主 agent) → outcome（episode 落库，未定稿）
  → [阶段2 评审] runGateAgents → 逐 gate 读 outcome.verdict
       ├─ 全 pass   → completeTask(id, { result: { outcome, gate } })   // 定稿=官方
       └─ 任一 reject → gateBlockTask(id, { gate })                     // 挂起，未定稿
```

### §3.4 挂起态复用

- `blocked`（`tasks.status`，已有）+ `block_kind='gate_reject'`（与既有 `circuit_break` 并列，不改枚举）。
- `error` 列存 gate 摘要（verdict+defects）。
- 人工裁决：新增 `approveGateBlock(id,{byActor})`：`blocked→done`（人工放行定稿）；复用 `resetTask`（任意→ready）即「人工退回重跑」。

## §4 改动清单

| 文件 | 改动 |
|---|---|
| `skills/method-review-gate/SKILL.md` + `core/evaluate.md` | 补 verdict 输出约定：评审结论须结构化返回 `verdict: pass\|reject` + `defects:[]`（四维任一不通过→reject+缺陷清单）；`runGateAgents` 消费此字段 |
| `src/kanban/kanban.js` | 新增 `gateBlockTask(id,{gate})`：`running→blocked`，`block_kind='gate_reject'`，`error`=gate 摘要；含 `auditTransition`+`emit`。新增 `approveGateBlock(id,{byActor})`：`blocked→done`（人工放行）。均幂等、含 `auditTransition` |
| `src/kanban/scheduler.js` | `runGateAgents` 改返回结构化 `{agent, ok, verdict, defects?, error?}`（读 `outcome.verdict`，异常→`verdict:'reject'`，fail-safe）。`dispatchOneCore` 末尾分支：gated 任务若有 `verdict==='reject'`→`gateBlockTask` 而非 `completeTask` |
| `src/web/*`（后续，可并入独立页） | 工作台/任务详情暴露 `blocked(gate_reject)` 状态 + 「人工放行/退回重跑」按钮（复用 §6.13 confirm 范式思路），非本次必需 |

**零 schema 迁移**：`blocked`/`block_kind`/`error` 列已存在；`gateBlockTask`/`approveGateBlock` 为纯新增函数 + `dispatchOneCore` 分支，删改即回滚。

## §5 验收标准

1. **单元（mock）**：major 任务 `method-review-gate` outcome `verdict:'reject'`→`dispatchOneCore` 后 `tasks.status='blocked'`、`block_kind='gate_reject'`、无 `done` 定稿；`verdict:'pass'`→`done`。
2. **单元**：`runGateAgents` 异常（SKILL 抛错）→ 保守判 `reject`（fail-safe）。
3. **集成**：构造 major 商机任务→注入 reject verdict→断言挂起；注入 pass→断言定稿。
4. **回归**：L2 复盘任务（③）`gateAgents=[]`→不被 gate 影响，仍正常 `done`；`test/event-triggered-retro.test.js` 21 例不回退。
5. **契约校验**：`validate-contract.mjs` 对回填设计文档 `valid:true`。

## §6 风险与死锁

- **死锁**：gated 任务为商机终态（报价/合同确认），通常无 `depends_on` 下游等待它→挂起不引发连锁死锁；且 `blocked` 不自动重试，仅人工裁决，无无限循环。
- **fail-safe 过度阻断**：异常→reject 偏保守，可能把 LLM 抖动误判为 reject；缓解：`defects`/error 留痕，`approveGateBlock` 一键放行；预留 `gate-failsafe` config 开关（默认保守）。
- **verdict 契约落地**：若 LLM 路径未带 `verdict` 字段，`runGateAgents` 按「无 verdict 视为 reject」保守处理，避免静默通过（与 fail-safe 一致）。
- **回滚**：scheduler 编排分支 + 两个 kanban 函数为纯新增/分支，删改即回滚，零 schema 迁移。

## §7 后续（非本次，需另行 brainstorming）

- ④ skillCalls/actionCalls 拆分：agent 授权语义归一。
- 其余 12 个 method-*（bant/meddicc/…）补 steps[]（当前降级护栏）。
- 恢复 UI：`blocked(gate_reject)` 状态展示与人工裁决按钮（可并入 §6.13 confirm 范式独立页或工作台卡片）。

## §8 实施记录（落地后回填，2026-09-01）

方案 C（真两阶段 pre-gate）已按 `docs/superpowers/plans/2026-09-01-gate-blocking-plan.md` 全量落地并验证。

### §8.1 改动清单（实际落地）

| 文件 | 改动 | 对应 Task |
|---|---|---|
| `src/kanban/kanban.js` | 新增 `gateBlockTask(id,{gate})`：`running→blocked`，`block_kind='gate_reject'`，`error`=gate 摘要，含 `auditTransition`+`emit`；新增 `approveGateBlock(id,{byActor})`：`blocked(gate_reject)→done`（人工放行定稿）。均含前置态校验 | Task1 (#18) |
| `src/kanban/scheduler.js` | `:5` import 加 `gateBlockTask`；`runGateAgents`（`:126-`）改读 `outcome.verdict`（缺省/异常→`verdict:'reject'`，fail-safe）；`dispatchOneCore`（`:100-`）末尾分支：gated 任务任一 `verdict==='reject'`→`gateBlockTask` 而非 `completeTask`；更新 D6 注释 | Task2 (#17)+Task3 (#20) |
| `skills/method-review-gate/SKILL.md` | 新增「结构化 verdict 输出契约」节：`verdict:pass\|reject` + `defects` + `summary`，fail-safe 说明 | Task4 (#19) |
| `test/kanban/gate-block.test.js`（新） | `gateBlockTask`/`approveGateBlock` 4 例 | Task1 |
| `test/kanban/scheduler-gate.test.js`（新） | `runGateAgents` verdict 解析 4 例（pass/reject/异常/缺 verdict） | Task2 |
| `test/kanban/dispatch-gate-block.test.js`（新） | `dispatchOneCore` 分支 3 例（major reject→block / major pass→done / L2 复盘不受影响） | Task3 |

### §8.2 验证结果

- **单测（mock 隔离）**：`test/kanban/gate-block.test.js` 4/4、`scheduler-gate.test.js` 4/4、`dispatch-gate-block.test.js` 3/3 → **11/11 绿**。
- **事件触发复盘回归（③ 不受影响）**：`test/event-triggered-retro.test.js` **21/21 绿**（L2 复盘任务 `gateAgents=[]` 不被 gate 分支影响）。
- **kanban 目录全集回归**：6 文件 / 19 通过 + 2 跳过（跳过为预存，非本次），无回退。
- **质量门禁**：`node scripts/ui-lint.mjs` → 通过（0 错误，仅 users.html 预存 JS 模板裸 input 警告）；`python tmp/audit_css_vars.py` → OK 无 CSS 变量一致性问题。
- **契约校验**：`validate-contract.mjs` 对设计文档与 spec 文档均 `valid:true`（§A 仅含 `ct-review-gate`，覆盖 1 个名册 agent，`seen.size===1` 不触发反向全量断言）。

### §8.3 阈值配置化落地（铁律遵守）

- 阻断语义为**硬语义**（verdict 契约），无业务阈值硬编码；fail-safe 默认**保守 reject**（异常/缺 verdict 即阻断），避免静默通过。
- 预留 `gate-failsafe` config 开关（默认保守）作为后续运营开关位（本任务未接 config_store，因阻断本身非阈值类参数，仅"保守/宽松"策略可配置）。

### §8.4 边界与零迁移

- **仅影响 gated 任务**：`gateAgents.length>0`（即 `level==='major'`/`L3`）；L2 复盘（③）`gateAgents=[]` 不受影响（单测断言）。
- **零 schema 迁移**：`blocked`/`block_kind`/`error` 列复用（`failTask` 已用）；`gateBlockTask`/`approveGateBlock`/`dispatchOneCore` 分支为纯新增，删改即回滚。
- **死锁**：gated 任务为商机终态，`blocked` 不自动重试，仅人工裁决（`approveGateBlock`/`resetTask`），无连锁死锁。
- **fail-safe 过度阻断缓解**：`defects`/error 留痕，`approveGateBlock` 一键放行定稿。

### §8.5 提交状态

未 commit（无凭证铁律，请用户本地按功能线提交；涉及：`src/kanban/kanban.js` / `src/kanban/scheduler.js` / `skills/method-review-gate/SKILL.md` / `test/kanban/gate-block.test.js` / `test/kanban/scheduler-gate.test.js` / `test/kanban/dispatch-gate-block.test.js` / `docs/2026-09-01-gate-blocking-design.md` / `docs/superpowers/plans/2026-09-01-gate-blocking-plan.md` / `docs/specs/2026-08-29-agent-workbench-contract-monitor-design.md`）。

## §A Living Contract（机器块，自检用）

```contract-yaml
- task: "D 评审把关：双闸门 + 四维审查，结构化返回 verdict(pass/reject+defects)"
  contract_task_id: ct-review-gate
  agent: review-gate
  skills: [method-review-gate]
  memory: [review-gate, quote-engine, intake-router]
  knowledge_scope: { layers: [L1, L2], max_hops: 4 }
  success: "review-gate 返回 outcome.verdict∈{pass,reject} 且 reject 时带 defects；runGateAgents 据此判定（非仅靠异常）；major 主任务 gate reject 后 tasks.status='blocked' 且 block_kind='gate_reject'、未 completeTask；approveGateBlock 后转 done"
```

> 调度器消费 verdict → `gateBlockTask`/`approveGateBlock` 属编排行为（scheduler 非 agent），不入契约块；其语义在 §3.3/§3.4 描述，由单测 §5.1/§5.3 覆盖。
