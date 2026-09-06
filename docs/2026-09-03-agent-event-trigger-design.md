# 设计：C1 首批事件 → 智能体派发接线（事件驱动补挂）

> 日期：2026-09-03 ｜ 状态：已批准（brainstorming P5 通过）｜ 下一步：writing-plans
> 关联：`docs/2026-09-03-cognitive-decision-loop-design.md`（C1–C9）｜ `docs/2026-09-02-cognitive-decision-unified-design.md`

---

## §0 问题陈述

2026-09-03 上午对 **B新能源科技公司**（账户 `144d1931-73d0-49ec-b387-89c735522631`、商机 `7fdebf95-126b-4294-8e85-47a7a1d653f1`）跑完整端到端流程，**全程零智能体参与**。经生产库实测定位为**设计缺口，非运行故障**。

### §0.1 实测证据（生产库 `crm_native`，2026-09-03 10:23）

| 观测点 | 实测值 | 判定 |
|---|---|---|
| `crm.decision`（今日 02-16:00Z 起） | **0 行** | 决策第 0 闸 `requireDecision` 一次未调用 |
| `crm.tasks`（全表） | **0 行** | 编排队列从未建单，`dispatchOneCore` 从未执行 |
| `crm.events`（今日） | **12 条，全部 `ontology-sync`** | 只有粒子写后的本体钩子在跑 |
| `crm.monitor_event` 的 agent 轨迹 | **13 条全部 `created_at = 2026-09-01T12:26:42.979Z`（同一秒）** | `seed-closed-loop-demo` 种子演示数据，非真实运行 |
| B新能源 deal `7fdebf95` | `updated_at = 2026-09-03T02:14:54Z` | 业务操作确实落库，只是未带出智能体 |

今日 12 条事件构成：02:09–02:11 审批实例/任务变更 → 02:12:57 deal 的 `ai.*` 属性重算 → 02:14:54 `CRM_KNOWLEDGE`×2 + `CRM_DEAL`×2。**全是粒子写，无一条决策事件。**

### §0.2 根因链

```
端到端业务写 → 粒子直写通道（PATCH /api/particles/:id）
             → data-particle-update + recordDecisionEvent('config_change')
             → 不经过 requireDecision
             ⇒ 方案 C 的双 Agent（decision-enrich / decision-execute）从未派发
             ⇒ crm.tasks 恒 0 行 ⇒ ready-queue-pump 无水可泵 ⇒ 智能体零参与
```

**绕过第 0 闸的两条代码路径（file:line）：**

1. `PATCH /api/particles/:id` — `src/http/routes.js:2871-2896`：直接 `actionExecutor.dispatch('data-particle-update')`，只 `recordDecisionEvent('config_change')` 落审计链，**不调 `requireDecision`**。商机推进 / 预算 / AI 属性回写均走此路。
2. `POST /api/particles` — `src/http/routes.js:475-529`：仅 `type === 'CRM_DEAL' && !bootstrap` 过第 0 闸；非 DEAL（账户 / 知识 / 审批）一律 `ctx.bootstrap = true` 豁免（`routes.js:518`）。

**结构性根因：** C1（事件触发式能力进化）首批事件清单 `deal.stage / meeting / task` 尚未落地 ⇒ 粒子写产生的 `ontology-sync` 事件目前**没有任何 agent 订阅**。

> 注：C1 清单中的 `meeting` / `task` 在当前系统中**无对应实体**——`crm.tasks` 是 kanban 智能体调度队列表（`src/kanban/kanban.js:34`）而非客户跟进任务，系统亦无 `CRM_TASK` 粒子。故首批以真实存在的实体类型为准。

---

## §1 目标 / 非目标

**目标**：让端到端业务流程中的粒子写**自动**带出智能体运行，且在 `crm.tasks` 与 `crm.monitor_event` 中留下可审计的真实痕迹。

**非目标**：
- 不改决策第 0 闸语义（方案 A 不在本次范围，避免引入 403 阻断与先例冷启动问题）。
- 不在无 `decision_id` 的情况下执行任何写操作。
- 不修 LLM 未生效问题（见 §6）。

---

## §2 订阅点（已验证可用）

| 环节 | 位置 | 说明 |
|---|---|---|
| 事件产生 | `src/ontology/hooks.js:129` | `recordEvent({ domain:'ontology', type:'ontology-sync', entityId, entityType, tenantId, actor })` |
| 落库并广播 | `src/events/recordEvent.js:54-60` | 先 `INSERT INTO crm.events`，**成功后**才 `emit(domain, type, p)` |
| 订阅方式 | `src/events/bus.js:6` | `on('ontology', fn)` |
| 现成范式 | `src/alerts/alertHook.js:11-36` | `registerAlertHook()` 订阅 `'particle'` 域 → 规则判定 → 落库 → `emit('alert', ...)` |

**事件载荷**：`{ entity_id, entity_type, tenant_id }`（`recordEvent.js:52` 由 `buildEventPayload` 构造）。**不含变更明细**。

### §2.1 载荷无变更明细的解法：去重键内嵌变更值

`ontology-sync` 不携带 "stage 从 S3 变到 S4" 这样的差分信息，触发器无法直接判断字段是否真变了。

**解法**：把变更后的值编进去重键 —— `dedup_key = ${entity_id}:${intent}:${变更字段当前值}`。
- 同值重复写 → 命中去重 → 跳过（天然幂等）
- 值一变 → 键不同 → 视为新任务 → 派发

以最少的机制同时解决"差分判定"与"防风暴"两件事，无需引入额外的状态快照表。

---

## §3 触发矩阵（配置中心 `agent-event-trigger`）

| 事件域 | 实体类型 | 派发意图 | 路由 agent | SKILL | 去重键含值 | 写入性质 |
|---|---|---|---|---|---|---|
| `ontology` | `CRM_DEAL` | `stage-progression` | quote-engine | `method-stage-progression` | `payload.stage` | 只读判定 |
| `ontology` | `CRM_ACCOUNT` | `funnel-classification` | followup-agent | `method-funnel-classification` | `payload.tier` | 只读判定 |
| `ontology` | `CRM_KNOWLEDGE` | `decision-enrich` | decision-agent | `method-decision-enrich` | 新增即一次 | 只读富集 |

**配置形态**（`config_store['agent-event-trigger']`，tenant `system`）：

```json
{
  "enabled": true,
  "cooldown_ms": 300000,
  "matrix": [
    { "domain": "ontology", "type": "ontology-sync", "entity_type": "CRM_DEAL",
      "intent": "stage-progression", "agent": "quote-engine",
      "skill_slug": "method-stage-progression", "dedup_field": "payload.stage" },
    { "domain": "ontology", "type": "ontology-sync", "entity_type": "CRM_ACCOUNT",
      "intent": "funnel-classification", "agent": "followup-agent",
      "skill_slug": "method-funnel-classification", "dedup_field": "payload.tier" },
    { "domain": "ontology", "type": "ontology-sync", "entity_type": "CRM_KNOWLEDGE",
      "intent": "decision-enrich", "agent": "decision-agent",
      "skill_slug": "method-decision-enrich", "dedup_field": null }
  ]
}
```

### §3.1 首批不派发（第二批候选）

| SKILL | 排除理由 |
|---|---|
| `method-decision-execute` | step2 `crm-memory-upsert` 为 `kind:'write'`（`seed-actions.js:157`），需 `decision_id` 过第 0 闸；事件触发场景无 decision_id |
| `method-quote-engine` | step2 `crm-quote-estimate` 虽为 `kind:'read'`（`seed-actions.js:195`），但"报价触发点"在事件层无明确语义（金额变更？阶段到 S4？），需业务定义后再接 |

---

## §4 三级防风暴

1. **DB 去重（主）** —— 重启后仍有效：
   ```sql
   SELECT 1 FROM crm.tasks
    WHERE payload->>'dedup_key' = $1
      AND status IN ('ready','running') LIMIT 1
   ```
2. **内存冷却（辅）** —— 同 `dedup_key` 在 `cooldown_ms` 内跳过，减少无谓查询；进程重启即失效，故仅作辅助。
3. **只读白名单闸（fail-closed）** —— `READ_ONLY_SKILLS` 集合外的 intent 一律**拒派并留痕**，绝不静默放行。

### §4.1 写入闸门约束（硬约束）

事件触发的任务**不携带 `decision_id`**。首批三条 SKILL 的落点 action 全部为 `kind:'read'`，已逐个核验：

| SKILL | 落点 action | kind | 位置 |
|---|---|---|---|
| `method-stage-progression` | `crm-stage-progression-evaluate` | read | `src/action/seed-actions.js:287` |
| `method-funnel-classification` | `crm-funnel-classify` | read | `src/action/seed-actions.js:356` |
| `method-decision-enrich` | 无写步骤（注释明示"无 decision_id 不可写"） | — | `src/skills/seed.js:112-113` |

---

## §5 可观测性（禁静默）

| 场景 | 动作 |
|---|---|
| 成功派发 | `emit('trace', 'agent-event-trigger-dispatch', { dedup_key, agent, skill_slug, task_id })` |
| 被节流 / 去重跳过 | `emit('trace', 'agent-event-trigger-skipped', { dedup_key, reason })` |
| 越权 SKILL / 白名单拒绝 | `emit('trace', 'agent-event-trigger-rejected', { intent, skill_slug, reason })` |
| 异常 | `recordFailure('agent-event-trigger-*', err)` —— **禁裸 `.catch(() => {})`** |

> 教训来源：本次排查的最大障碍正是"没派发也没痕迹"（`crm.tasks` 0 行 + `monitor_event` 无当日记录），无法区分"未触发"与"触发后静默失败"。

---

## §6 任务分解（T1–T5）

```contract-yaml
- task: "T1 新增 src/agent/eventTrigger.js（订阅 ontology 域 + 矩阵判定 + 三级防风暴 + 只读白名单闸）"
  agent: intake-router
  contract_task_id: ct-intake-route
  skills: [data-particle-read, method-intake-routing]
  memory: [intake-router]
  knowledge_scope: { layers: [L1, L2], max_hops: 3 }
  success: "CRM_DEAL 粒子写后 60s 内 crm.tasks 出现 dedup_key 形如 {id}:stage-progression:{stage} 的 ready 任务，同 key 二次写不重复建单"
```
**契约说明：** T1 由 `intake-router` 承接，调用 `data-particle-read`/`method-intake-routing`，读取 `intake-router` 记忆（L1/L2，≤3 跳）；成功标准为商机写后队列出现带去重键的 ready 任务且同键不重复建单。

```contract-yaml
- task: "T2 routeThroughIntake 支持显式 skill_slug 授权覆盖（skillCalls 闭包校验）"
  agent: intake-router
  contract_task_id: ct-intake-route
  skills: [method-intake-routing]
  memory: [intake-router]
  knowledge_scope: { layers: [L1, L2], max_hops: 3 }
  success: "payload.skill_slug='method-stage-progression' 且目标 agent=quote-engine 时，派发执行该 SKILL 而非回落 method-quote-engine；越权 skill_slug 被拒并留痕"
```
**契约说明：** T2 由 `intake-router` 承接，调用 `method-intake-routing`，读取 `intake-router` 记忆（L1/L2，≤3 跳）；成功标准为显式 SKILL 被正确派发、越权值被拒。

> **T2 必要性**：`src/kanban/scheduler.js:79` 的 `skill_slug: primarySkillFor(targetAgent)` 会**覆盖**入参。`primarySkillFor` 取 `agentSpecs[agent].skillCalls` 中首个匹配 `/^(method-|decision-)/` 的项（`:28-31`），quote-engine 恒返回 `method-quote-engine` → 不改造则首批 stage-progression 永远派不出。

```contract-yaml
- task: "T3 配置中心新增 agent-event-trigger 键（矩阵/cooldown/白名单）+ 三处同步与测试数组同步"
  agent: intake-router
  contract_task_id: ct-intake-route
  skills: [data-particle-read]
  memory: [intake-router]
  knowledge_scope: { layers: [L1, L2], max_hops: 2 }
  success: "GET /api/config/agent-event-trigger 返回矩阵与 cooldown_ms；删键后触发器回退出厂默认且不抛错"
```
**契约说明：** T3 由 `intake-router` 承接，调用 `data-particle-read`，读取 `intake-router` 记忆（L1/L2，≤2 跳）；成功标准为配置项可读且缺失时安全回退。

```contract-yaml
- task: "T4 server.js 启动注册 registerAgentEventTrigger()（与 registerAlertHook 并列）+ 单元与集成测试"
  agent: intake-router
  contract_task_id: ct-intake-route
  skills: [method-intake-routing]
  memory: [intake-router]
  knowledge_scope: { layers: [L1, L2], max_hops: 3 }
  success: "服务启动后 monitor_event 出现 intake-router 派发痕迹；新增测试文件全绿，且提供 unregisterAgentEventTrigger() 供测试隔离"
```
**契约说明：** T4 由 `intake-router` 承接，调用 `method-intake-routing`，读取 `intake-router` 记忆（L1/L2，≤3 跳）；成功标准为启动即接线、测试可隔离。

```contract-yaml
- task: "T5 B能源端到端生产验收：重跑推进/知识入库，断言智能体真实参与"
  agent: intake-router
  contract_task_id: ct-intake-route
  skills: [data-particle-read]
  memory: [intake-router]
  knowledge_scope: { layers: [L1, L2], max_hops: 3 }
  success: "生产库 crm.tasks 从 0 行变为 >0 且 status 终态为 done/blocked；crm.monitor_event 出现当日新增的 quote-engine episode（非 09-01 种子时间戳）"
```
**契约说明：** T5 由 `intake-router` 承接，调用 `data-particle-read` 核验生产队列与智能体轨迹（L1/L2，≤3 跳）；成功标准为生产队列与智能体轨迹双双出现当日真实数据。

---

## §7 横切改动检查表（新增能力必查）

| # | 检查项 | 是否命中 | 处置 |
|---|---|---|---|
| 1 | agent 名册数组 `agentSpecs` | 否 | 复用既有 6 agent，不新增 |
| 2 | G3 KG 闸门数量 | 否 | 不改 agentSpec |
| 3 | `action_in_registry` | 是（间接） | 复用既有 read action，不新增 |
| 4 | `skillCalls ⊆ actions` 闭包 | 否 | 不改 skillCalls |
| 5 | 定时器计数 | 否 | 不新增定时器，复用 `ready-queue-pump`（`src/scheduler/timers.js:258-274`） |

> 记忆铁律：新增 agent / SKILL 是横切改动，同时命中 5 处断言。本设计**不新增 agent、不新增 SKILL、不新增定时器**，仅新增订阅器 + 路由分支 + 配置项。

---

## §8 风险与回滚

| 风险 | 影响 | 缓解 |
|---|---|---|
| 事件风暴（批量导入触发大量任务） | 队列积压 | 三级防风暴；`config_store` 可一键 `enabled:false` |
| 只读 SKILL 判定结果无人消费 | 派发了但业务无感 | T5 验收以 `crm.tasks` 终态 + `monitor_event` 轨迹为准；结果消费属后续 Task |
| 订阅器异常影响业务写 | 阻断主流程 | `bus.js:31-38` 已对订阅者异常做 try/catch 隔离，写路径不降级 |
| 与 `seed-closed-loop-demo` 种子数据混淆 | 真假痕迹难辨 | T5 断言 `monitor_event.created_at` 为**当日**，规避 09-01 种子时间戳 |

**回滚**：置 `config_store['agent-event-trigger'].enabled = false` 即刻停止派发，无需改代码。

---

## §9 不在本次范围（建议单独排期）

1. **LLM 未生效**：B能源 deal 的 `ai.*` 属性（02:12:57 生成）全部 `degraded: true`、`source: '确定性兜底'`。`crm.llm_config` 有 siliconflow 默认行（`is_default: true`, `is_deleted: false`），属 `llm_enabled` 为真但 `llm_effective` 存疑，是独立于智能体派发的第二条链路。
2. **方案 A（业务写接第 0 闸）**：根治路径，但会引入 403 阻断与先例冷启动问题，需独立设计。
3. **C1 清单中的 `meeting` / `task` 事件**：当前系统无对应实体（无 `CRM_TASK` 粒子；`crm.tasks` 为调度队列表），需先补实体设计。

---

## 闭环回写

| 时间 | 任务 | gap_type | observed | expected | severity |
|---|---|---|---|---|---|
| — | — | — | — | — | — |

> 本表由 agent-workbench 在执行期按 `contract-yaml` 校验结果自动追加；同一 `(task, gap_type)` 复发 ≥2 次 → 产出 SKILL 改进提案，需用户显式批准后方可修改 SKILL。
