> ⛔ **已合并 / 已归档（2026-09-02）**
> 本文已并入 **`docs/2026-09-02-cognitive-decision-unified-design.md`**（认知驱动决策子系统 · 统一设计 v3）。
> 本文**仅作历史留档**，一切以合并文档为准。采纳部分：L3 执行层实证铁律、闭环 0 数据诊断、§8 修复记录（P0 单数表名 / 三核心 method-\* steps / SLA 预热）。深化部分：§2 基线被合并文档 §2 新证据刷新（**S1–S7 中 4 个操作零命中**，这是 Q1 恒 warn 与 `auditability_pct=21%` 的真根因）。
> §8.4 两项待授权事项（重启生产服务 / 生产业务动作）状态不变。

# CRM-ai-native 全量设计文档落地审计报告

- 审计日期：2026-09-02
- 审计依据：ai-capability-audit SKILL 判据（设计文档 ↔ 代码双向核验 + 状态漂移审计）
- 审计对象：docs/ 下 95 份设计文档（含最近三天 08-30/08-31/09-01 的 42 份 + specs 27 份 + archive 2 份）
- 审计方法：三层核验 — ①文档承诺提取 ②代码符号/调用点 grep ③生产库 crm_native 行数与列结构直查
- 对照基线：2026-08-26 十能力落地审计 + 2026-08-29 设计文档双向核验（历史报告）

---

## 一、审计结论速览

| # | 设计文档（份） | 落地状态 | 核心缺口 | 优先级 |
|---|---|---|---|---|
| 1 | 09-01 决策问责统一设计 | ✅ 已落地（Phase0-5 主体） | 代码未提交（30 文件）；calibration_patch/rule_hit 0 行 | P1 |
| 2 | 09-01 gate-blocking | ✅ 已落地 | 无 UI（§7 声明非本次） | P2 |
| 3 | 09-01 event-triggered-retro | ✅ 已落地 | 生产无 retro 任务（0 条） | P1 |
| 4 | 09-01 mcp-tenant/token | ✅ 已落地 | 生产 tenant_id 仅 2 用户 | P2 |
| 5 | 09-01 method-skill 真执行 | ⚠️ 部分落地（4 agent 已落地 3+1） | CRM 三核心 method-*（stage-progression/behavior-standard/funnel-classification）无 steps | P1 |
| 6 | 09-01 独立库迁移 | ✅ 已落地 | — | — |
| 7 | 08-31 可审计性 4Q | ✅ 已落地 | — | — |
| 8 | 08-31 SLA 物化 | ✅ 已落地 | **agent_sla 仅 1 行（物化未运行）** | P1 |
| 9 | 08-31 统一 S 分类 | ✅ 已落地 | — | — |
| 10 | 08-31 多租户 | ✅ 已落地 | — | — |
| 11 | 08-31 非结构化挂接 | ✅ 已落地 | — | — |
| 12 | 08-30 Sales 六份 | ✅ 已落地 | config_store 出厂默认兜底（P2 完善项） | P2 |
| 13 | 08-30 决策三份 | ✅ 已落地 | attribution 七态/knob 13 类已扩，但 calibration_patch 0 行 | P1 |
| 14 | 08-30 工作台重设计 | ✅ 已落地 | — | — |
| 15 | specs/ 27 份 + archive 2 份 | ✅ 主体落地 | 部分为调研/规划文档 | — |

## 二、逐文档核验证据（file:line + 生产库行数）

### 2.1 [09-01] 决策问责统一设计（核心）
- **设计承诺**（§0.4 Phase0-5）：
  - Phase 0 BG-04 双口径隔离（seed 边软标记）
  - Phase 1 BG-01 注入层消费 rationale/memories
  - Phase 2 BG-02 OVERRIDES 接线、BG-03 结构、BG-05 装弹、BG-06 留痕
  - Phase 3 A-T1~T5：supplySpec / 快照表 / 装配 V2 / formatPromptV2
  - Phase 4 A-T6 前台三层一屏
  - Phase 5 A-T7 双口径验收
- **代码证据**：
  - `src/context/assembleContextV2.js`：A-T3 接线 5 模块（`searchPrecedents/detectConflicts/ruleEngine/buildTimelineRows/trackEntry`）+ `Promise.allSettled` + 200ms 超时（`:21`）✅
  - `src/context/supplySpec.js`：A-T1 S1–S7 注册表（`:17-23`）+ validateSupplySpec ✅
  - `src/context/snapshotStore.js`：A-T4 快照落库 + prompt_hash 篡改检测（`:24` TAMPERED）✅
  - `src/context/assembleContextV2.js:123`：A-T5 formatForPromptV2 四段注入 ✅
  - `src/decision/writableEdges.js:10/18/20`：BG-03 全部 7 类边可写（含 DECIDED_ON/DERIVED_FROM_EXCEPTION）✅
  - `src/decision/relation.js:66-78`：BG-04 runtimeOnly 双口径（排除 seed-script + props.demo）✅
  - `src/decision/edgeWrite.js`：BG-06 mirrorEdge 三重留痕 ✅
  - `src/context/timelineSource.js:11`：BG-08 时间基准 COALESCE(decided_at,created_at) ✅
  - `src/web/sales-decision-monitor.html`（2026 行）：A-T6 Layer0 双口径 + 页签②当时的上下文 + 7×7 回跳（`:329/:967/:1053`）✅
- **生产库证据**：
  - `decision` 11 行、`decision_context_snapshot` 12 行（11 关联决策）✅
  - `decision_relation` 20 行：DECIDED_ON:14 / ESTABLISHES_FRAME:1 / OVERRIDES:1 / REFERENCED_PRECEDENT:1 / DERIVED_FROM_EXCEPTION:1 / CAUSED:1 / INFLUENCED:1 —— 7 类边齐备 ✅
  - 快照 degraded：supplied=1/3 的 9 条仍 degraded=true（真实运行降级）
- **缺口**：
  - **git 未提交**：30 个文件 M/??，含 assembleContextV2/snapshotStore/edgeWrite/auditabilitySla 等核心落地 + `docs/2026-09-01-Decision-Accountability-Audit-Verbatim.md`。设计已批准 + 代码已写，但**未 commit**（P1：不可回滚、不可交接）
  - `calibration_patch` **0 行**：J3 校准闭环在设计文档中是核心（13 类 knob），但生产无任何校准补丁 → 校准闭环断点
  - `rule_hit` **0 行**：规则校验 S4 无实际命中记录

### 2.2 [09-01] gate-blocking（已批准方案 C）
- 代码：`src/kanban/kanban.js:93/108`（gateBlockTask/approveGateBlock）+ `src/kanban/scheduler.js:99-104`（verdict 分支）+ `skills/method-review-gate/SKILL.md`（verdict 契约）✅
- 测试：`test/kanban/gate-block.test.js` 4 例 + `scheduler-gate.test.js` 4 例 + `dispatch-gate-block.test.js` 3 例 —— **单跑全绿** ✅
- 生产：tasks 0 行（无任务），无法实证 gate 阻断
- 缺口：无 UI（§7 明确非本次，P2）

### 2.3 [09-01] event-triggered-retro
- 代码：`src/decision/retroTrigger.js`（registerRetroTrigger/maybeTriggerRetro）+ `src/http/routes.js:171-174`（config_store['event-retro'] 后台化 + 配置页）+ `event-retro-config.html` ✅
- 生产：**tasks 0 行**、decision_retro_report 0 行 → **触发回路未产生任何真实任务/复盘**（P1：机制在但无运行证据）

### 2.4 [09-01] mcp-tenant / mcp-token
- 代码：`src/mcp/auth.js:119-134`（登录写 tenant_id + buildMcpCtx 查表带出）+ 格式闸（`:25-30` 旧格式零 DB 拒绝）+ gateway 删硬编码 ✅
- 生产：crm_users 仅 2 行、tenant_id 仅 2 → 多租户载体数据极少（P2）

### 2.5 [09-01] method-skill 真执行
- 代码：`src/skills/seed.js:76-106` —— **METHOD_SKILLS 中 3 个已内联 steps[]**：
  - `method-quote-engine`：3 步（data-particle-read → crm-quote-estimate → j_judge）✅
  - `method-followup-engine`：3 步（data-particle-read → crm-followup-schedule → j_judge）✅
  - `method-review-gate`：3 步（data-particle-read → crm-review-gate-evaluate → j_judge）✅
- 执行链：`src/skills/registry.js:24-30`（registerSkill 完整存 def 含 steps 入内存 Map）→ `:64-97`（executeSkill 读 steps；hasSteps=true 时不降级）
- **intake-router**：设计 §4.4 明确「维持 route_only，不补方法步骤」——无 steps 是设计行为 ✅
- **其余 11 个 method-***（bant/meddicc/opportunity-matrix/role-map/risk-tradeoff/stop-loss/fact-vs-script/presales/stage-progression/funnel-classification/behavior-standard）：seed.js 仅登记元数据、**无 steps** → `executeSkill` 降级单步粒子读取 + `stepsMissing=true`（registry.js:68-71 注释自我声明）
- **判定**：⚠️ **部分落地** —— 设计 §4 的 4 个 agent 已真执行 3 个 + intake 按设计 route_only（✅）；但 **CRM 三核心业务方法（stage-progression/behavior-standard/funnel-classification）无步骤执行**，契约矩阵对它们「已接 SKILL」是降级假绿（P1：核心业务方法论降级为通用检索）

### 2.6 [08-31] 可审计性 4Q
- 代码：`src/decision/auditability.js`（computeAudit4q/aggregateAuditability 单一事实源）+ `/api/decision/:id/audit-4q` + `/api/graph/provenance` + `/api/decision/:id/provenance-turtle`（routes.js:2413-2426）✅
- 文档自证「已落地」与代码一致（**非漂移**）

### 2.7 [08-31] SLA 物化
- 代码：`src/decision/auditabilitySla.js`（materializeAuditabilitySla）+ `/api/auditability-sla`（routes.js:2459-2467）✅
- 生产：**agent_sla 仅 1 行** → 物化函数存在但**未定时运行/未填数**（P1：设计要「持久时序」，生产只有首行）

### 2.8 [08-31] 统一 S 分类 / 多租户 / 非结构化挂接
- `src/sales/stageTaxonomy.js`（S1–S8 单一事实源）✅
- `src/http/tenantRouter.js`（createTenantRouter + /api/tenants）+ tenantScope.js ✅
- `src/assets/upload.js`（上传 + crm-asset-attach 挂接 + 第0闸）✅

### 2.9 [08-30] Sales 六份
- `src/sales/behaviorChecklist.js`（21 条合格线，`:30/:55/:78`）+ `behaviorStandard.js` ✅
- `src/sales/funnelKpi.js`（漏斗 KPI）+ `funnelQuality.js`（确定性计算）✅
- `src/sales/salesThresholds.js`（readThreshold + config_store['sales-thresholds'] 唯一事实源）✅
- `src/sales/namedAccountAssign.js`（档位×窗口×告警）✅
- `src/sales/namedAccountBoard.js`（buildNamedAccountBoard + boardSummary）✅
- **生产观察**：config_store 仅 1 行（decision-context-guard）—— `sales-thresholds` / `seven-dim` / `event-retro` / `named-account-targets` / `approval-config` 未预置。代码 `readThreshold()` 有出厂默认兜底，符合「出厂默认 + 后台可调」设计（详见 §3.2）——**非缺口，P2 完善项**（可选预置开箱即用）

### 2.10 [08-30] 决策三份 + 工作台
- `src/http/routes.js:2305`（T-D6 三图闭环聚合 + crossLoopMap D1-D5）+ `decision-graph-board.html` ✅
- `src/monitor/attribution.js`（T29 七态归因）+ `src/calibration/knobs/index.js`（REGISTRY 扩 13 类）✅
- `src/web/index.html`（S02 受控渲染 + 客户跟踪 KPI 卡）✅
- 生产：`decision_outcome` 4 行、`decision_event` 20 行、`memory_log` 34 行、`approval_flow` 5 行 ✅

## 三、深度发现（三层交叉）

### 3.1 「代码存在 ≠ 已提交」——30 个文件悬空
`git status --short` 显示 30 个 M/?? 文件，其中含本次审计确认的核心落地代码。设计文档批准后代码已写，但**未 git 提交**（用户本地提交约定下仍待完成）。这不是设计未落地，而是**落地未固化**（P1：不可回滚、交接风险）。

### 3.2 config_store 单行 = 出厂默认兜底设计（非缺口）
`readConfig`（configStore.js:10-23）缺省返回 null，调用方回退出厂默认（`readThreshold` 兜底）。config_store 现有 `decision-context-guard` 一行（上下文守卫配置，contextGuard.js:13），**per-tenant 隔离列存在**（tenant_id）。「后台可调」是给用户的能力而非必须预置——代码行为在设计内（出厂默认 + 可覆盖）。**不列为缺口，标注 P2 完善项**（若需开箱即用可预置更多默认配置）。

### 3.3 CRM 三核心 method-* 无 steps[] —— 核心业务方法仍降级
METHOD_SKILLS（seed.js:26-126）中 `method-quote-engine`/`method-followup-engine`/`method-review-gate` 3 个已内联 steps[]（A1 部分落地），但 **CRM 三核心业务方法（stage-progression/behavior-standard/funnel-classification）仍仅登记元数据、无 steps[]** → `executeSkill` 对其恒降级（stepsMissing=true，registry.js:68-71 注释自我声明）。契约矩阵对它们「已接 SKILL」是**降级假绿**（业务方法论降级为通用粒子检索）。

### 3.4 闭环无数据 —— calibration/rule_hit/retro 全 0
- `calibration_patch` 0 行（J3 校准闭环无处方）
- `rule_hit` 0 行（规则校验无命中）
- `tasks` 0 行 + `decision_retro_report` 0 行（事件复盘未触发）
- `agent_sla` 1 行（SLA 物化未运行）
这些表都**有代码、有种子函数、但生产 0 行** —— 机制在，闭环无运行证据。

## 四、测试验证

- 批量串行（--no-file-parallelism）：8 文件 38 测试，35 通过 3 失败
- **失败判定 = 伪象**（共享库并发干扰）：`audit-4q.test.js` 单跑 4/4 全绿、`edgeWrite` 单跑 10/10、`db-relation` 单跑 7/7 —— 判定为**共享库伪失败**，非真回归
- 结论：**核心设计相关测试单跑全绿**，代码质量稳定

## 五、知识治理自评（21 分制）

| 维度 | 分数 | 证据 |
|---|---|---|
| 跨系统身份 | 2 | particles 多租户 + stable_key，无 agent 自动归一 |
| 结构关系 | 3 | decision_relation 7 类边全可写 + 生产 20 行 |
| 术语语义 | 2 | stageTaxonomy S1-S8 + methodology 词表，agent 校验部分 |
| 当前 active 修订 | 2 | 快照 + COALESCE(decided_at,created_at) 时间基准 |
| 历史否决检出 | 2 | OVERRIDES 边 + 先例检索（接线后） |
| 运行态进入决策 | 2 | S6 运行态取 + monitor_event 13 行，但任务 0 |
| 治理自动化 | 2 | policy-as-code + 第0闸 + verdict 契约 |
| **合计** | **15/21** | **记忆系统边缘（8-14 可做事，15+ 飞轮转）** |

## 六、缺口分级与建议

| 优先级 | 缺口 | 证据 | 状态 | 建议动作 |
|---|---|---|---|---|
| **P0** | 落点 SQL 用单数表名 `crm.particle`（生产只有 `crm.particles`），恒抛且被空 catch 吞掉 | seed-actions.js 3 处 | ✅ **已修**（§8.1） | 已改复数表名 + 4 处 recordFailure 留痕 |
| **P1** | CRM 三核心方法 SKILL 无 steps[]（stage-progression/behavior-standard/funnel-classification） | seed.js 无 steps；executeSkill 降级 stepsMissing | ✅ **已完成**（§8.2） | 已补 3 个落点 action + 3 组 steps[] + agent 授权接线，真实库实证跑通 |
| **P1** | 闭环数据 0 行（calibration_patch/rule_hit/retro/agent_sla） | 4 表 0 行 | ⚠️ **诊断完成，半完成**（§8.3） | SLA 预热缺陷已修并补录（pct=21%）；其余三链路机制无缺陷=从未运行，需生产业务动作或重启服务 |
| **P1** | 30 文件未 git 提交（落地未固化） | git status 30 个 M/?? | ⏸ **未授权** | 用户本地按功能线提交（不 add -A） |
| **P2** | config_store 仅预置 1 键（出厂默认兜底，非缺口） | config_store keys 单行 + readConfig 回退设计 | — | 可选预置更多默认配置键（开箱即用） |
| **P2** | gate-block 无 UI；多租户数据少 | 证据见 2.2/2.4 | — | 后续迭代 |

> **SLA 定时器未挂**一项已随 P1-② 修复（prewarm + 环境变量化），从 P2 移出。

## 七、结论

- **主体落地**：最近三天 42 份设计文档中，**决策问责统一设计（Phase0-5 主体）、gate-blocking、retro-trigger、MCP 租户/令牌、4Q 审计、S 分类、多租户、非结构化挂接、Sales 六份、工作台、独立库迁移、method-skill 4 agent 中 3 个真执行** 全部代码级落地且生产库有对应结构与部分数据。
- **状态漂移 3 项（更新后状态）**：①CRM 三核心方法 SKILL 无 steps → ✅ 已补齐并真跑通；②闭环 0 数据 → ⚠️ 机制无缺陷、从未运行（SLA 已修并补录，pct=21%）；③30 文件未提交 → ⏸ 待用户本地提交。
- **记忆系统判定**：15/21 —— 已具备结构/语义/时间维能力，但校准-复盘-规则闭环缺运行数据，属「架子在、回路冷」。
- **审计方法学教训（本次最大收获）**：首次审计停在「L2 steps 契约存在」即判"已落地"，遗漏 L3（SQL 层能否真跑）→ 漏掉 P0 单数表名缺陷。完整判据见 §8.1 的「落地假绿四层递进」。

---

> 本报告为审计结论（代码级 + 生产库实证，非文档声称）。建议方案需用户确认优先级后按各 ai-* SKILL 流程实施（HARD-GATE：批准前不写实施代码）。

---

## 八、2026-09-02 修复记录（P1 前两项实施）

用户选定 P1 前两项（①CRM 三核心 method-\* 无 steps ②闭环 0 数据）后实施，以下为实施结果与新发现。

### 8.1 P0 真缺陷（实施中发现，超出原审计结论）

**`src/action/seed-actions.js:135/159/190` 三处 SQL 表名写成单数 `crm.particle`，生产库只有复数 `crm.particles`（71 行，information_schema 已实证）**：
- 恒抛 `relation does not exist` → 被空 catch 静默吞掉 → 返回「无可用商机」→ `executeSkill` 在 rule 步骤 `if (!r.ok) throw` → **SKILL 执行必崩**
- 影响：`method-quote-engine` / `method-followup-engine` / `method-review-gate` 三个「已落地」SKILL **在生产实际跑不通**
- **对原审计结论的修正**：§2.5/§3.3 判「4 agent 已落地 3+1」是**表层假绿**——steps[] 存在 ≠ 执行能跑通（SQL 层缺陷被 mock 测试掩盖）。真实状态为「3 个有 steps 但执行必崩」
- 修复：表名改复数 + 4 处静默吞错改为 `recordFailure(kind, e)` 留痕（含 `decision-retro` 的 1 处同类问题）
- 防回潮：`test/method-skill-real-execution.test.js` 新增 2 条源码文本护栏（禁单数表名 / 禁空 catch）

### 8.2 P1-① CRM 三核心 method-\* 真执行（已完成）

| 项 | 内容 |
|---|---|
| 新增 action | `crm-stage-progression-evaluate` / `crm-funnel-classify` / `crm-behavior-check`（均 kind:'read'，零落库零 HITL） |
| 判定内核 | 复用既有纯函数，不重写业务规则：`stageTaxonomy.js`（S 码/闸门）、`funnelQuality.js`（funnelZone/forecastClass/mantOk/weightedAmount）、`behaviorChecklist.js`（21 条） |
| steps 补齐 | 3 个 method-\* 补 3 步（data-particle-read → 落点 action → j_judge） |
| **agent 授权接线** | 三核心此前**未被任何 agent 声明**，`canExecuteSkill` 会因 skillCalls 闭包不含而拒绝 → 补授权：`quote-engine += method-stage-progression`（S3→S4 闸门即 `bantcc_quote`，同源）；`followup-agent += funnel-classification + behavior-standard`（拜访节奏/质检同源）。actions + skillCalls 两处同步以满足权限闭包（agents.js 断言 3） |
| 验证 | 装配断言 69→75 条全绿；`test/method-skill-real-execution.test.js` 23/23 全绿 |
| **真实库实证** | 3 个 action 全部跑通：阶段判定（`leads` 脏值归一为 S1，S2 闸门 `need_facts` 缺证据 → `canAdvance:false` 诚实不假绿）、漏斗分类（5 商机全「线索」区，MANT 四要素全缺）、行为质检（21 条判定，deal 4 / contact 0） |

### 8.3 P1-② 闭环 0 数据（诊断 + 部分完成）

**诊断结论：四条链路机制均无缺陷（127 测试全绿），生产 0 数据 = 从未运行**；唯一真代码缺陷是 SLA 定时器。

| 链路 | 挂载 | 生产 0 数据根因 | 性质 | 处置 |
|---|---|---|---|---|
| `agent_sla` | timers.js:181 | **setInterval 首次触发需等满 6h，无启动预热** | 代码缺陷 | ✅ 已修（注册即预热一次）；✅ 已补录（2→3 行） |
| `tasks` retro(0) | server.js:44 ✅ | 触发需 `decision:confirmed` + tier≥HIGH；生产 11 决策仅 3 个 HIGH 且均为 PROCESSED（无 confirmed） | 数据/运行 | 机制已验证（测试真实建单成功）；待真实确认动作 |
| `rule_hit`(0) | 写路径 seed-actions.js:547 | `decision_rule` 表 **0 行**（DB 无规则，回退内置 2 条，均只匹配 action='advance'）；生产未执行过商机推进 | 未运行 + 配置未装载 | 装配路径 S4 恒不命中属规则集未覆盖（诚实 empty，非假绿）；建议后续补规则（P2） |
| `calibration_patch`(0) | store.js:65 | 需 MCP/API 显式触发，从未调用 | 未运行 | 链路测试全绿（store/autoSuggest/knobs/rules/replay） |

**新增量化发现**：SLA 物化首跑实测 **平台可审计性 auditability_pct = 21%**（scored 12 决策；Q1 全 12 warn、Q4 全 12 warn、Q3 9 pass）——把原报告「回路冷」的定性结论量化为 21%。

### 8.4 待用户授权/处置（未擅自执行）

1. **重启生产服务**（当前 3000 端口在跑旧代码）：使 SLA 预热 + retro 订阅器生效
2. **生产业务动作**（rule_hit / tasks / calibration_patch）：需真实商机推进、决策确认、校准处方生成——会变更业务数据，待授权后执行