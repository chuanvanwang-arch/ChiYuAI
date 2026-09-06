# 设计文档：智能体工作台契约消费侧（agent-workbench 契约解析 + 三维度全核验 + feedback 回写）

- 版本：1.0
- 日期：2026-08-29
- 上游：`<brainstorming>` 重建已批准设计（`docs/specs/2026-08-29-brainstorming-redesign-design.md`）§1–§5 + 上游"消费侧"独立计划（设计文档 §6 预留）
- 形态：本设计文档内嵌 **双轨 Living Contract**（机器块 + 散文），字段 `agent/skills/memory/knowledge_scope/success` 对齐 `src/agent/agentSpec.js` 的 `capabilities.skillCalls` / `memory.read` / `capabilities.knowledgeScope.layers`。
- 通用性：本 redesign 是用户级通用 skill 的**消费侧落地**；以 CRM 智能体工作台作参考实例，不把 CRM 专有词硬编码进 skill。

---

## §0 已确认决策（P5 批准）

- **B 全维度真监控**：补 `memory`/`knowledge-layer` 埋点 + 三维度全核验（SKILL 调用 / 记忆·知识读取 / success）。
- **A 显式 id + 人工 success**：派发时把设计 `task.contract_task_id` 注入 `ctx.contractTask`；运行期 episode 携带该 id 供 workbench 精确匹配；success 由操作员在 workbench 上标记（prose 标准人读）。
- 通用 skill + CRM 作参考实例（不硬编码专有词）。

## §1 背景与问题（证据驱动）

智能体工作台 `/api/page/agent-workbench`（`src/http/routes.js:520-551`）当前只展示 kanban 历史任务 + 装配状态（`assertAgentAssembly()`），**不核验"是否调用了契约声明的 SKILL / 读取了声明的记忆 / success 是否通过"**。

本轮目标是让工作台成为 5 个智能体（A 接诊 / B 报价 / C 跟进 / D 评审 / 复盘）的运行效果监控中心，闭环建议由 `aggregate-feedback.mjs` 产出。

### §1.1 关键缺陷（必须先行修复）

- `db/schema.sql:300-308` 的 `crm.monitor_event` 仅有 `domain/event_type/decision_id/scenario_id/payload/created_at`，**缺 `agent_id` 与 `context_facts` 两列**。
- `src/agent/agentEpisodes.js:14-15` 的 INSERT 依赖这两列 → 当前 **每个 `recordEpisode` 写入失败、被静默 catch**（仅 `trace`，见 `agentEpisodes.js:23-25`）。
- 推论：`agentLoop.js:42-62` 的埋点代码虽在，但**从未真正落库**。此前 P4 称"SKILL 调用轨迹已存在"系误判——本设计以补列 + 迁移为 Task 1 根基，修正该误判。

### §1.2 埋点缺口

- `assembleContext`（`src/context/assembler.js:96-115`）返回 `layers.L1–L4` 与 `missing.L1–L4`，可推导"实际读取了哪些 knowledge layer"。
- `agentLoop.js:42-46` 的 `context-injected` episode 仅记 `context_len` + `preview`，**未记 `knowledge_layers_read` 与 `contract_task_id`** → 记忆/知识读取合规不可直接核验。
- `scheduler.js:33-34` `runWithSkill(task, {})` 是注入 `contractTask` 与 `actor`（智能体 key）的唯一派发点。

## §2 整体数据流

```
设计契约(contract-yaml)
   └─[派发] scheduler 注入 ctx.contractTask + ctx.actor=agent_key
        └─[运行期] agentLoop 写 episode(skill + knowledge_layers_read + contract_task_id) → monitor_event（补列后落库）
             └─[后端] contractMonitor 解析契约 + 关联 monitor_event → 三维度合规判定
                  └─[feedback] 非合规 → agent_contract_feedback 表 + 镜像 <doc>.feedback.json
                       └─[前端] agent-workbench 渲染合规矩阵 + success 人工标记（SSE 刷新）
                            └─[P0] aggregate-feedback 产出改进提案（需批准）
```

## §3 运行期埋点（含修复缺列）— Task 1

### §3.1 补列 + 迁移（修复 §1.1 缺陷）
- `ALTER TABLE crm.monitor_event ADD COLUMN agent_id text, ADD COLUMN context_facts jsonb;`
- `CREATE INDEX IF NOT EXISTS idx_crm_monitor_event_agent ON crm.monitor_event(agent_id, created_at);`
- 迁移脚本 `db/migrate-monitor-event-agent.sql`（幂等，IF NOT EXISTS 形式），并同步补进 `schema.sql:300-308` 的建表语句，使新环境一致。

### §3.2 埋点增强
- `agentLoop.js:42-46` 的 `context-injected` episode：在 `context_facts` 增加 `knowledge_layers_read`（= `Object.keys(bundle.layers).filter(l => !bundle.missing[l])`）与 `contract_task_id`（= `ctx.contractTask || null`）。
- `scheduler.js:33-34`：`runWithSkill(task, { ctx: { tenantId:'system', actor: task.agent_key || 'agent', contractTask: task.contract_task_id || null } })`。
- 注：`loop-started`/`loop-done` episode 的 `context_facts.skill` 已存（agentLoop.js:50,60），无需改。


## §4 契约解析与合规判定后端 — Task 2

- 新模块 `src/agent/contractMonitor.js`：
  - `parseContractsFromDoc(path)`：复用 `scripts/validate-contract.mjs` 的 `extractContractBlocks` / `parseContractYaml`（同款零依赖解析，避免双份实现漂移）。
  - `computeCompliance(docPath, opts)`：按 `context_facts.contract_task_id` 关联 `monitor_event`，逐 task 判定三维度：
    - **skill 合规**：存在 `phase='loop-started'|'loop-done'` 且 `context_facts.skill ∈ contract.skills` 的 episode。
    - **memory/knowledge 合规**：存在 `phase='context-injected'` 且 `knowledge_layers_read ⊇ contract.knowledge_scope.layers` 的 episode（缺失 layer 即不合规）。
    - **success**：默认 `pending`（人工标记，见 §6），不参与自动判定。
  - 返回 `{ task, agent, skill_ok, memory_ok, success, episodes }`。
- 端点 `GET /api/agent-monitor?doc=<path>`：`assertAgentAssembly` 同源，返回各 task 三维度布尔（供 workbench 与 `validate-contract.mjs` 双轨消费）。


## §5 Feedback 落库与回写 — Task 3

- 新表 `crm.agent_contract_feedback`：
  ```
  id BIGSERIAL PK, contract_task_id text, agent text, gap_type text,
  observed text, expected text, severity text, ts timestamptz default now(), resolved bool default false
  ```
  唯一约束 `(contract_task_id, gap_type)` 保证 upsert 幂等（复现计数由 `aggregate-feedback.mjs` 负责，不在此表计数）。
- `POST /api/agent-monitor/feedback`：合规缺失 → upsert（按 `contract_task_id+gap_type`）→ 同时镜像 `<doc>.feedback.json`（数组 append，供 `aggregate-feedback.mjs` 消费，严守上游 §B）。
- 镜像写入失败仅 trace，不阻断主链路。


## §6 工作台前端合规矩阵 + success 标记 — Task 4

- `routes.js:520-551` 的 `GET /api/page/agent-workbench` handler 增强：调用 `contractMonitor.computeCompliance`，把合规矩阵作为 `contract-matrix` 组件注入 `data.components`；渲染 success 标记按钮（POST `/api/agent-monitor/success` 标记态，SSE 刷新）。
- `agent-workbench.html` 走 `renderPage` 驱动（S03_SCHEMA），基本不改；新增 `contract-matrix` 组件 schema 与 success 标记交互。
- success 标记写入 `agent_contract_feedback`（gap_type='success'，observed/expected 留人工结论）或独立列 `success_marked`。


## §7 验收 — Task 5

- 用新 `<brainstorming>` 对一真实 feature 产出契约 → 注入 `contract_task_id` 跑一次 agentLoop → `GET /api/agent-monitor` 三维度合规 → 标记 success → 制造一次 skill 缺失 → feedback 写入 → `aggregate-feedback.mjs` 产出提案（闭环演示）。


## §8 范围与留白

- **本设计范围**：消费侧（契约解析 + 三维度核验 + feedback 回写 + workbench 看板）。不含：5 个 agent 的实际 SKILL 编写（属各自 agent 实现）、LLM 自动判定 success（方案 A 选人工）、跨项目适用（通用 skill 已抽离）。
- **留白**：`agent_contract_feedback` 的 `resolved` 收敛流程（谁标记 resolved、何时清 mirror）留作后续迭代；`contract_task_id` 与 kanban task 的绑定键（task.agent_key / task.contract_task_id）具体注入时机由 Task 1 实现时固化。

## §9 验收口径

1. `validate-contract.mjs` 对本文档双重校验：`valid:true`（结构 + `--registry src/agent/agentSpec.js` 交叉）。
2. 补列迁移可重放（幂等），episode 真实落库（不再静默失败）。
3. `/api/agent-monitor` 对注入轨迹返回正确三维度布尔。
4. 一次 skill 缺失 → feedback 落库 + 镜像 → `aggregate-feedback.mjs` 产出**需批准**提案。
5. workbench 三列合规态 + success 标记可见、SSE 刷新。

## §A Living Contract（全任务汇总，机器块）

```contract-yaml
- task: "A 接诊分流：意图识别 + 商机分级 + 派发路由（唯一入口）"
  contract_task_id: ct-intake-route
  agent: intake-router
  skills: [method-intake-routing]
  memory: [intake-router, followup-agent]
  # layers 为空 = 如实描述现状：intake-router 是内嵌路由逻辑（意图识别+分级+派发），
  # 路由决策只依赖 payload.intent/level，不消费知识层。其运行痕迹由 scheduler
  # 落 episode（route_only=true 标记），与"执行完整 SKILL 循环"区分。
  knowledge_scope: { layers: [], max_hops: 3 }
  success: "新询盘经意图识别分级后派发 B/C/D，写 payload.contract_task_id"

- task: "B 报价测算：配置/成本/毛利实时测算，输出 A/B 方案"
  contract_task_id: ct-quote-calc
  agent: quote-engine
  skills: [method-quote-engine]
  memory: [quote-engine, followup-agent]
  knowledge_scope: { layers: [L1, L2], max_hops: 3 }
  success: "报价含毛利预估且有数据支撑，A/B 方案可复核"

- task: "C 跟进催办：自动跟进/节点催办/超时转人工"
  contract_task_id: ct-followup
  agent: followup-agent
  skills: [method-followup-engine]
  memory: [followup-agent, quote-engine]
  knowledge_scope: { layers: [L1, L2], max_hops: 3 }
  success: "超期未跟进预警并转人工"

- task: "D 评审把关：双闸门 + 专家介入 + 内置四维审查"
  contract_task_id: ct-review-gate
  agent: review-gate
  skills: [method-review-gate]
  memory: [review-gate, quote-engine, intake-router]
  knowledge_scope: { layers: [L1, L2], max_hops: 4 }
  success: "review-gate 返回 outcome.verdict∈{pass,reject} 且 reject 带 defects；major 主任务 gate reject→blocked(gate_reject) 挂起，approveGateBlock→done"
# gate 阻断（2026-09-01 设计 docs/2026-09-01-gate-blocking-design.md）：method-review-gate 须结构化
#   返回 verdict(pass/reject)+defects；runGateAgents 读 outcome.verdict（异常→保守 reject，fail-safe）。
#   gated(major/L3) 任务先跑主 agent 出草稿(episode 落库)，再评审；verdict=pass→completeTask(定稿)，
#   reject→gateBlockTask→blocked(block_kind='gate_reject') 挂起等人工裁决；approveGateBlock→done。
#   仅影响 gateAgents>0 任务；L2 复盘任务(gateAgents=[]) 不受影响。

# 事件触发（2026-09-01 接线）：重大决策 confirmDecision 落 emit('decision','confirmed')
#   → src/decision/retroTrigger.js 订阅器（分级闸 min_tier + 冷却闸 cooldown_hours，均走 config_store['event-retro']）
#   → createTask(intent='retro') → routeThroughIntake 路由到本 agent（ct-retro-decision episode 落库）。
#   与夜间 runDecisionRetro（timers.js:77，落 decision_retro_report 校准报告）互补不互斥。
- task: "复盘智能体：决策复盘 + 整改处方生成（决策质量闭环）"
  contract_task_id: ct-retro-decision
  agent: decision-retro
  skills: [decision-retrospective]
  memory: [decision-retro, review-gate]
  knowledge_scope: { layers: [L1, L2], max_hops: 5 }
  success: "重大/失败决策被复盘，生成可复核整改处方并落决策网络"

- task: "决策前富集：L1-L4 记忆/知识并行装配，补充决策上下文线索（不阻塞判定）"
  contract_task_id: ct-decision-enrich
  agent: decision-agent
  skills: [method-decision-enrich]
  memory: [decision-agent, review-gate]
  knowledge_scope: { layers: [L1, L2, L3, L4], max_hops: 5 }
  success: "决策前 agent 落 loop-started/context-injected/loop-done 轨迹，knowledge_layers_read ⊇ L1-L4"

- task: "决策后治理：先例写回+记忆沉淀+故事线+决策网络挂接（write-through 学习闭环）"
  contract_task_id: ct-decision-execute
  agent: decision-agent
  skills: [method-decision-execute]
  memory: [decision-agent, review-gate]
  knowledge_scope: { layers: [L1, L2, L3, L4], max_hops: 5 }
  success: "决策后 agent 写回 memory_log/decision_relation，消除记忆真空"
```


## §B 校验器约定

- 本设计文档经 `scripts/validate-contract.mjs` 校验（结构 + 注册表交叉）。
- 各 Task 的 contract-yaml 须满足四字段 `agent+skills+memory+success` 齐备；`agent/skills/memory` 键须能在 `agentSpecs` / SKILL 注册表解析；`knowledge_scope.layers` 须在注册表 `knowledgeScope.layers` 内。
- `knowledge_scope.max_hops`(snake) ↔ 注册表 `maxHops`(camel) 仅校验 `layers`，不强制 max_hops。
