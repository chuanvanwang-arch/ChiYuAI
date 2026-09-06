# 设计文档：两插件更新——平台管理助手增运营能力 + 业务助手增待办/单据/记忆

> 日期：2026-09-05
> 状态：**设计已获用户整体批准**（P5）；本文档为 P6 产物，待用户评审（P8）后移交 writing-plans（P9）。
> 设计输入：用户需求（1）平台管理助手增「租户套餐/用量/到期/缴费 + 智能体运作汇总 + 决策成败 + 参数诊断报告 + 管理员待办审批」；（2）业务销售助手增「待办审批 + 业务单据查询 + 客户记忆查询」。
> 范式对齐：`docs/2026-09-03-crm-platform-admin-plugin-design.md`（platform-admin 包结构/双闸）、`docs/2026-09-04-plugin-production-mcp-channel-design.md`（MCP 端点参数化/重打包）、`docs/2026-09-05-param-closedloop-adaptive-design.md`（夜间体检→处方→调优待办闭环）。

---

## §0 结论先行

**后台数据面已齐备，核心工作是「插件侧编排扩展 + 少量后台只读聚合端点 + MCP 管理工具面」。**

| 需求 | 后台数据面（已核实） | 本次动作 |
|---|---|---|
| 租户套餐/用量/到期/缴费 | `tenant_subscription`（plan/status/expires_at/grace_until）、`module_usage`（calls/tokens/period）、`billing_statement`/`billing_payment`、`/api/billing/*` 6+ 端点 | 新增只读聚合（MCP 工具 `admin-tenant-usage` 消费现有端点） |
| 智能体运作汇总（成功/失败+原因） | `monitor_event`（agent 域 **loop-failed 已带 `context_facts.error`**，agentLoop.js:119）、`agent_contract_feedback`（契约 pass/miss） | **新增只读聚合端点** `/api/monitor/agent-summary`（无需新埋点） |
| 决策成败 | `decision_event`（made/required/escalated）、`decision_outcome`（won/lost/stalled/paid + reason）、`agent_sla` 4 问审计 | 新增只读聚合端点 `/api/monitor/decision-health` |
| 后台参数调整建议报告 | `calibration_patch`（PENDING 处方）+ tuning 待办 + tune-approve 闭环（2026-09-05 已落地） | 新增综合诊断端点 `/api/admin/param-diagnosis`（智能体+决策+处方综合，**不碰 context-routing**） |
| 管理员待办审批 | `GET /api/my-todo?view=approval\|tuning` + `POST /api/my-todo/approve\|reject\|tune-*`（workbenchRouter.js，已存在） | **MCP 层暴露** `my-todo-query/approve/reject` + `tune-approve/reject` |
| 业务单据查询 | `data-particle-read`（by type）已存在 | 插件编排补「单据清单」意图路由 |
| 客户记忆查询 | `crm.memory_log`（写通道 crm-memory-upsert 已有，**无读通道**） | **新增只读 Action** `crm-memory-read`（memory_log by entity） |

**修正过程记录**：P1 探索初判「失败原因无埋点」，探库核实后确认为**有埋点（loop-failed 带 error）但无聚合端点**——因此方案从「补埋点」修正为「只读聚合」。用户 P2 选择「补埋点+聚合」后，又经证据修正为「无需补埋点，只要聚合端点」（见 §5 决策记录）。

---

## §1 范围与边界

### 1.1 目标
1. platform-admin 插件新增运营洞察能力：租户经营、智能体运作、决策健康、参数诊断报告、管理员待办审批。
2. crm-native 插件新增：待办审批、业务单据清单、客户记忆查询。
3. 后台新增 3 个只读聚合端点 + 1 个只读 Action；MCP 工具面增暴露约 10 个工具。
4. 全过程零数据破坏：不执行 DELETE、不重建表、不加新表；全部为只读聚合 + 复用既有写通道。

### 1.2 非目标（本次不做）
- 不新增任何表结构（全部消费既有表）。
- 不改 `context-routing` 配置与消费链（禁改红线，诊断报告对 context-routing 只展示实验数据）。
- 不新增智能体运行埋点（loop-failed 已存在）。
- 不做管理前端页（插件对话式服务为交付形态，管理页已存在 my-todo.html / billing.html 等）。
- 不改 `crm-native` 五角色自适应逻辑；待办/单据/记忆为既有工具面的编排扩展。

### 1.3 红线（继承平台总则）
| 红线 | 说明 |
|---|---|
| 准入双闸（platform-admin） | 任何平台治理操作前 `crm_login` 验证通过 + 角色 `sysadmin`（普通 admin → 403）。 |
| approver 匹配（业务侧） | 待办查询/签批按当前人/角色过滤（复用 matchApprover 语义，越权 → 无权）。 |
| 写必经两阶段确认 | MCP 写工具（my-todo-approve / tune-approve 等）经既有 gateway 发 confirm_token；签批本质是审批决策，**不重复套第 0 闸**（与既有 crm-approval-approve 一致）。 |
| 绝对禁 DELETE | 一切操作不暴露删除工具。 |
| per-tenant 隔离 | 聚合端点按 scopeTenant 收敛；sales 只见本租户，sysadmin 通配（admin '*' 通配读不 autoSeed，对齐 configStore WILDCARD 语义）。 |
| 诊断报告不产 context-routing 处方 | 参数诊断仅对 context-routing 展示实验数据（无处方），其余 knob 正常产处方。 |

---

## §2 后台新增端点契约（只读聚合，3 个 + 1 Action）

### 2.1 `GET /api/monitor/agent-summary?days=7`（admin/sysadmin 只读）

成功/失败/降级/原因，按 agent 聚合。

```json
{
  "window": { "days": 7, "from": "2026-08-29T00:00:00Z", "to": "2026-09-05T00:00:00Z" },
  "totals": { "runs": 89, "done": 89, "failed": 0, "degraded": 12, "fail_rate": 0, "degrade_rate": 0.135 },
  "by_agent": [{
    "agent_id": "intake-router", "runs": 20, "done": 20, "failed": 0,
    "degraded": 3, "reasons": [],
    "contract": { "pass": 5, "miss": 1 }
  }],
  "fail_reasons": [{ "reason": "SKILL 不存在: xxx", "count": 2 }, { "reason": "LLM 调用超时", "count": 1 }]
}
```

- **数据源**：
  - `monitor_event`（domain='agent'）：`loop-started` / `loop-done`（context_facts.degraded）/ `loop-failed`（context_facts.error）。**loop-failed 已由 agentLoop.js:119 埋点**，无需新增。
  - `agent_contract_feedback`：按 agent 聚合 pass/miss（契约层成败，与运行成败并列展示）。
- **失败原因归一**：取 `loop-failed` 的 `context_facts.error` 原文（去差异后缀后按前缀/模式归并，如 `SKILL 不存在:`、`parse_empty`、`LLM 超时`）；无 error 字段 → `unknown`。
- 粒度：按 agent_id 分组；时间窗默认 7 天。

### 2.2 `GET /api/monitor/decision-health?days=30`（admin/sysadmin 只读）

决策成败按场景/结果聚合。

```json
{
  "window": { "days": 30 },
  "made": 42, "required": 25, "escalated": 19,
  "by_scenario": [{ "scenario_id": "QUOTE_PRICING", "total": 8, "made": 6, "escalated": 2, "fail_rate": 0.25 }],
  "outcomes": { "won": 5, "lost": 3, "stalled": 2, "paid": 4 },
  "lost_reasons": [{ "reason": "竞品低价中标 + 内部预算冻结", "count": 2 }],
  "audit_4q": { "pass": 9, "warn": 15, "fail": 0 }
}
```

- **数据源**：
  - `decision_event`：event_type made/required/escalated 按 scenario_id 聚合。
  - `decision_outcome`：outcome_type won/lost/stalled/paid + payload.reason（失单原因聚合）。
  - `agent_sla`（近天快照）：4 问审计 pass/warn/fail 分布。
- 语义：`fail_rate = escalated/total`（升级到人 = 决策未自主收敛）。**展示面不做治愈性判断**（归因留 param-diagnosis）。

### 2.3 `GET /api/admin/param-diagnosis?days=7`（仅 sysadmin 只读）

综合诊断报告 = 智能体失败归因 + 决策场景失败率 + 参数处方建议。

```json
{
  "report_date": "2026-09-05",
  "agent": {
    "summary": { "...agent-summary 摘要..." },
    "suggestions": [{ "agent": "decision-retro", "issue": "反复 parse_empty", "suggest": "检查对应 SKILL 步骤或配置" }]
  },
  "decision": {
    "summary": { "...decision-health 摘要..." },
    "suggestions": [{ "scenario": "QUOTE_PRICING", "fail_rate": 0.25, "suggest": "查看该场景审批链配置与决策规则" }]
  },
  "patches": [
    { "patch_id": "p-xxx", "knob": "retroTimeoutMs", "target": "system", "risk": "MEDIUM",
      "from": 180000, "to": 240000, "recommend": "approve", "rationale": "决策复盘反复超时（106-124s > 旧 20s 问题已修，但仍有 3 次超时）" }
  ],
  "red_lines": ["context-routing 仅展示实验数据（routing_experiment），不产处方"]
}
```

- **数据源**：agent-summary + decision-health 的聚合结果 + `calibration_patch`（PENDING，按 risk 排序，附 `recommend`）。
- **recommend 判定（确定性规则，仅对非 context-routing knob）**：
  - 处方 risk=HIGH 且对应链路失败率 > 阈值 → `approve`（高优先）。
  - 处方 risk=MEDIUM 且有失败证据支撑 → `approve`。
  - 无失败证据支撑 / 与 context-routing 相关 → `reject`（或 `skip`，不产处方于红线项）。
- **红线硬编码**：report 含 `red_lines` 数组声明「context-routing 不产处方」；实现中过滤 knob 属于 routing 族。
- 周期报告形态：`?days=7` 可被 sysadmin 对话触发（"出个运营诊断报告"），非定时任务（如需定时后续可由用户配 automation）。

### 2.4 `crm-memory-read`（只读 Action，入 Action Registry + MCP）

| 项 | 值 |
|---|---|
| name | `crm-memory-read` |
| kind | `read` |
| permission | `auth` |
| namespace | `crm` |
| agentTool | true |
| schema | `{ entityId: 'string', topic: 'string', layer: 'string', limit: 'number', windowDays: 'number' }` |
| handler | 查 `crm.memory_log`（by entity_id / topic LIKE / layer / created_at >= now()-windowDays），desc 排序；**按 scopeTenant 收敛**（memory_log 有 tenant_id 列） |

返回：
```json
{ "rows": [{ "id": 1, "topic": "decision:xxx", "layer": "L-Workspace", "entity_id": "acme-chem", "payload": {...}, "created_at": "..." }], "count": 3 }
```

### 2.5 小重构：`workbenchRouter` 导出 `buildViewRows`

将 `buildViewRows(view, actor, deps)` 导出，供 MCP `my-todo-query` 工具复用（避免复制过滤/匹配逻辑）。

---

## §3 MCP 工具面（新增约 10 个）

| 工具名 | kind | 用途 | 闸 |
|---|---|---|---|
| `my-todo-query` | read | 六视角待办列表（approval/processing/initiated/cc/follow/tuning） | auth + 当前人过滤 |
| `my-todo-approve` | write | 审批任务签批（复用 advanceTask） | 两阶段 + approver 匹配 |
| `my-todo-reject` | write | 审批任务拒绝 | 两阶段 + approver 匹配 |
| `tune-approve` | write | 参数调优处方批准（复用 approvePatch） | 两阶段 + admin/sysadmin |
| `tune-reject` | write | 参数调优处方驳回 | 两阶段 + admin/sysadmin |
| `admin-tenant-usage` | read | 租户套餐/用量/到期/缴费汇总 | sysadmin |
| `admin-agent-summary` | read | B1 智能体成败聚合 | sysadmin |
| `admin-decision-health` | read | B2 决策健康聚合 | sysadmin |
| `admin-param-diagnosis` | read | B3 参数诊断报告 | sysadmin |
| `crm-memory-read` | read | 客户记忆查询 | auth + 租户收敛 |

- **实现方式**：既有 `buildMcpTools()`（src/mcp/tools.js）从 Action Registry 读 read/write；新增 3 个 admin-* 与 4 个 my-todo-* 为**注册式 Action**（入 seed-actions.js，kind=read / kind=write），与既有机制一致。
- 写工具两阶段：phase1 返回 confirm_token → phase2 执行（gateway 既有能力）；**不新增写通道**。
- `crm_memory_read` 为独立 Action 注册（不入 data-* 基底读族，避免与粒子读混淆）。
- MCP 暴露面收敛规则不变（lifecycle 非 reserved 才暴露；data-* 写族默认不暴露，本次仅加只读）。

---

## §4 插件扩展

### 4.1 plugin-platform-admin（新 SKILL `platform-ops-insight`）

**SKILL 文件**：`plugin-platform-admin/skills/platform-ops-insight/`（SKILL.md + registry.json）

- registry：`rbac_roles: ["sysadmin"]`、`immutable_baseline: true`、`type: domain`。
- SKILL 内容（结构化 Runbook）：
  - §0 红线：双闸（login + sysadmin）/ 只读聚合不触写 / 诊断不碰 context-routing / 禁删 / per-tenant。
  - 五段能力映射（用户意图 → 工具调用）：
    1. 租户经营：`admin-tenant-usage`（套餐/用量/到期/缴费一览）。
    2. 智能体运作：`admin-agent-summary`（成败/原因/契约）。
    3. 决策健康：`admin-decision-health`（场景/结果/失单原因）。
    4. 参数诊断：`admin-param-diagnosis`（综合报告 + 处方）→ 可接 `tune-approve/reject`（两阶段）。
    5. 管理员待办：`my-todo-query`（approval/tuning 视角）→ `my-todo-approve/reject`、`tune-approve/reject`。
  - 示例：用户「出个运营诊断报告」→ 依次调 agent-summary / decision-health / param-diagnosis → 呈现三段报告 + 处方清单。
- **agent 面孔 `platform-admin.md`**：能力映射表补 5 行意图（租户经营/智能体汇总/决策健康/参数诊断/待办审批）；双闸段重申；依赖声明更新（工具清单）。
- **版本**：`.codebuddy-plugin/plugin.json`、`openclaw.plugin.json`、`package.json` 统一升 **1.1.0**；`openclaw.plugin.json` skills 数组加 `skills/platform-ops-insight`。
- **重打包**：复用 `scripts/pack-platform-admin-plugin.py`（已存在，2026-09-04 新建）。

### 4.2 plugin/crm-native

| 能力 | 意图 | SKILL 段落 | 工具 |
|---|---|---|---|
| 待办审批 | "我的待办 / 待我审批 / 批准" | `crm-native` 意图路由表补行 + 新段「待办工作台」 | `my-todo-query` / `my-todo-approve` / `my-todo-reject` |
| 业务单据 | "查目前所有合同/报价/订单" | `crm-query` 查询矩阵补「单据清单」行 | `data-particle-read`（by type） |
| 客户记忆 | "查 XX 客户的记忆" | `crm-query` 查询矩阵补「记忆条」行 | `crm-memory-read` |

- `crm-native` SKILL：意图路由表加 3 行；**安全红线段**补：待办签批为两阶段写（phase1 表单 → phase2 confirm_token），approver 匹配才可签。
- `crm-query` SKILL：查询能力矩阵加 2 行（单据清单 / 客户记忆）。
- agent 面孔 `crm-native.md`：能力映射补 3 行。
- **版本**：三清单统一升 **1.5.0**；重打包 `scripts/pack-crm-plugin.py`。

---

## §5 决策记录（brainstorming P1-P5）

| # | 议题 | 结论 |
|---|---|---|
| D1 | 失败原因是否需补埋点 | **初判需补** → 探库修正：`agent-loop-failed` 已埋点（agentLoop.js:119 带 error）。**无需补埋点**，只需聚合端点。 |
| D2 | 参数报告形态 | 「**完整诊断报告**」（智能体+决策+处方综合，周期 7 天窗口） |
| D3 | 插件范围 | 「**两插件都扩**」（平台治理与业务销售职责分离，各自补能力） |
| D4 | 待办签批触发 | 「**MCP 新增签批工具**」（两阶段，复用既有端点） |
| D5 | 方案 | 「**方案 A**」：3 只读聚合端点 + MCP 管理工具面 + 两插件扩 SKILL |
| D6 | 跨租户权限 | 「**entity 归属租户 + scopeTenant 收敛**」（sales 见本租户，sysadmin 通配） |

---

## §6 涉及文件清单

| 类别 | 文件 |
|---|---|
| 后台（新增/修改） | `src/action/seed-actions.js`（+3 admin-* / +4 my-todo-* / +crm-memory-read 注册）、`src/http/routes.js`（+3 聚合端点）、`src/http/workbenchRouter.js`（导出 buildViewRows）、`src/mcp/tools.js`（工具面自然覆盖，验证） |
| 后台（复用不改） | `src/approval/engine.js`（advanceTask）、`src/calibration/store.js`（approvePatch/rejectPatch）、`src/monitor/monitorSubscriber.js`、`src/agent/agentLoop.js`（埋点既有） |
| platform-admin 插件 | `plugin-platform-admin/skills/platform-ops-insight/SKILL.md`（新）、`.../registry.json`（新）、`agents/platform-admin.md`（扩）、`.codebuddy-plugin/plugin.json`/`openclaw.plugin.json`/`package.json`（版本 1.1.0） |
| crm-native 插件 | `plugin/skills/crm-native/SKILL.md`（意图路由+安全红线）、`plugin/skills/crm-query/SKILL.md`（查询矩阵）、`plugin/agents/crm-native.md`（能力映射）、三清单版本 1.5.0 |
| 包 | `scripts/pack-platform-admin-plugin.py`（复用）、`scripts/pack-crm-plugin.py`（复用）、重打两个 zip |
| 测试 | `test/` 新增聚合端点测试（agent-summary / decision-health / param-diagnosis / crm-memory-read / my-todo MCP 工具） |

---

## §7 验收清单

| # | 验收项 | 期望 |
|---|---|---|
| V1 | `GET /api/monitor/agent-summary?days=7`（sysadmin token） | 返回 by_agent 数组含 runs/done/failed/degraded/reasons；totals 正确 |
| V2 | `GET /api/monitor/decision-health?days=30` | made/required/escalated + by_scenario + outcomes + lost_reasons |
| V3 | `GET /api/admin/param-diagnosis?days=7` | 三段结构 + patches 附 recommend + red_lines 声明 context-routing 不产处方 |
| V4 | `crm-memory-read`（业务账号 + entityId） | 返回该 entity 记忆条目，scopeTenant 收敛生效 |
| V5 | MCP `tools/list` | 新增约 10 工具齐备，双闸（sysadmin 工具 → 403 对非 sysadmin） |
| V6 | `my-todo-approve` 两阶段 | phase1 → confirm_token；phase2 后任务状态变更 |
| V7 | `tune-approve` | calibration_patch PENDING → APPROVED，resolved_by 留痕 |
| V8 | 两包重打包 + 合规校验 | 元数据/tags/quickPrompts 合规、版本号一致 |
| V9 | 端到端 | sysadmin 对话「出个运营诊断报告」→ 三段完整返回；sales 调 admin-* → 403 |

---

## §8 契约（living contract，P6 §A 双轨）

每任务含 `contract-yaml` 块 + 单行重申，任务粒度对齐 writing-plans。

```contract-yaml
- task: "后台聚合端点：/api/monitor/agent-summary + /api/monitor/decision-health + /api/admin/param-diagnosis"
  agent: sysadmin-orchestrator
  skills: [data-particle-read]
  memory: [crm-platform-admin]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "GET 三端点返回结构化聚合 JSON，param-diagnosis 含 red_lines 且无 context-routing 处方"
```

```contract-yaml
- task: "MCP 工具面：my-todo-query/approve/reject + tune-approve/reject + admin-tenant-usage/agent-summary/decision-health/param-diagnosis + crm-memory-read"
  agent: sysadmin-orchestrator
  skills: [crm-query, crm-write]
  memory: [crm-platform-admin]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "tools/list 含全部新工具；写工具两阶段；非 sysadmin 调 admin-* 403"
```

```contract-yaml
- task: "plugin-platform-admin 新增 platform-ops-insight SKILL + 面孔扩 + 版本 1.1.0"
  agent: platform-admin
  skills: [platform-ops-insight, user-rbac-admin]
  memory: [crm-platform-admin]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "SKILL/registry 落盘、openclaw.plugin.json skills 含新项、版本三处一致 1.1.0"
```

```contract-yaml
- task: "plugin/crm-native 扩意图路由（待办/单据/记忆）+ crm-query 矩阵 + 面孔 + 版本 1.5.0"
  agent: crm-native
  skills: [crm-query, crm-write]
  memory: [crm-native]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "意图路由 3 行补全、crm-query 矩阵 2 行补全、版本三处一致 1.5.0"
```

**契约说明**：后台聚合与 MCP 工具面任务由平台侧编排承接（对齐既有 agent 注册表 `intake-router`/`decision-agent` 等实际键名，实施时以 registry 校验通过为准）；插件扩展任务分别由 platform-admin / crm-native agent 面孔承接。

---

## §9 自查（P7，占位符/矛盾/歧义/范围）

- **占位符**：无遗留 `<TBD>`/`TODO`。示例中的 patch_id / agent_id 为运行期值，非未完成项。
- **矛盾**：与既有 `crm-memory-upsert`（写）不冲突——本设计新增 `crm-memory-read` 为**读**通道，写读分离；与 `crm-approval-approve` 不冲突——my-todo-approve 是「我的待办」入口，两者共享同一审批引擎（advanceTask），不重复。
- **歧义**：`recommend` 判定为确定性规则并在实现中配置化（threshold 走 config_store）；`fail_rate` 语义已定义（escalated/total）。
- **范围**：严格限于「只读聚合 + MCP 工具面 + 插件编排」；不改既有表结构、不加表、不改 context-routing、不做管理前端页。

---

## §10 后续（P8 → P9）

1. 用户评审本文档（P8）。
2. 评审通过 → 移交 writing-plans（P9），任务按 §8 契约继承。
3. 每 Task 一 commit（禁 git add -A）；提交前双检（git log -1 + git status）。
4. 真实施后按 §7 验收；两包重打包后合规校验（V8）。
