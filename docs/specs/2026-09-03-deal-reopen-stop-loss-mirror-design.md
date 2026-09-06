# 商机重开（reopen）与止损镜像（stop_loss → 粒子 payload）设计

> 状态：设计已批准（2026-09-03），待 writing-plans 拆解实施
> 关联工程债：S7 重启无系统通道 / 旧商机 stop_loss 未镜像到粒子 payload
> 设计输入：src/particles/lifecycle.js:14（只进不退）、src/sales/stageTaxonomy.js:28-36（S_TRANSITIONS 无反向边）、src/decision/decisionRepo.js:90,221（stop_loss 事实源）、plugin/skills/crm-risk/core/scan.md（只读粒子扫描）

## 1. 背景与问题

两项独立工程债，根因均来自"状态/数据只在单一层面可见，跨链路不可探测"：

1. **S7 重启无系统通道**：`advanceStage`（`src/particles/lifecycle.js:14`）硬闸门 `if (toIdx < curIdx) throw new Error('阶段只进不退')`；`S_TRANSITIONS`（`stageTaxonomy.js:28-36`）只定义前进边 + 退出边（→S7/S8），**无反向边**。商机进入 S7（输单）/S8（丢单）后，要重启只能人工新建粒子 → 丢失身份连续性与全部决策/事件历史。
2. **stop_loss 未镜像到粒子 payload**：止损事实源为 `crm.decision.stop_loss` JSONB（`decisionRepo.js:90,221`），但 `CRM_DEAL` 粒子 `payload` 无 `stop_loss` 字段（`particleModel.js:7-14`）；`crm-risk` 扫描只读粒子 `payload.stage` + 链边（`core/scan.md:7-12`），三模式均不含 stop_loss → 系统级风险链路无法感知"止损已触发"。

## 2. 设计目标

- 重开走**系统通道**：S7/S8 → S2 反向重开，保留原粒子身份，不新建粒子。
- 重开**决策锚定**：每次重开生成 `DEAL_REOPEN` 决策，可回溯重开原因与重立止损线。
- stop_loss **单向物化**到 `CRM_DEAL.payload.stop_loss`，决策为唯一事实源，fail-open。
- `crm-risk` 新增 `stop_loss_triggered` 探测，`status==='triggered'` 即告警，闭环打通。

## 3. 方案决策（已批准）

| 项 | 决策 | 否决项 |
|---|---|---|
| reopen 机制 | 独立 `crm-deal-reopen` action + `reopenDeal`，不动 `advanceStage` 只进不退契约 | 放宽 advanceStage 加反向边（破坏正向不变式，回归风险高） |
| reopen 范围 | S7（输单）+ S8（丢单）均可重开 | 仅 S7（S8 也属退出态，重开语义一致） |
| stop_loss 镜像 | 单向物化（决策→粒子）+ crm-risk 探测 | 扫描回源决策表（N+1 查询、违反只读粒子纪律） |
| 协同 | reopen 的 `DEAL_REOPEN` 决策自带 re-armed stop_loss → 自动刷新粒子镜像 | — |

## 4. Task 设计（含 living contract）

### Task 1 · reopenDeal 反向重开流程

- **新增 action `crm-deal-reopen`**（`src/action/seed-actions.js`）：`kind:'write', confirm:'critical', autoDecision:true`，复用 `crm-deal-advance` 的"自身 mint 决策满足第 0 闸"范式（参照 `whitelist.js:5`）。
- **新增 `reopenDeal(dealId, {reason, owner})`**（`src/sales/reopenDeal.js`，或并入 `lifecycle.js`）：
  - 校验 `payload.stage ∈ {S7,S8}`，否则抛错；
  - 写 `payload.stage='S2'`、`reopen_count = (payload.reopen_count||0)+1`、`reopened_at=now`、`last_reopen_reason=reason`；
  - 经决策链路 mint **`DEAL_REOPEN` 决策**（`decisionRepo.loadScenarioConfig` 注册 scenario，`required_dims` 含 `stop_loss` 且模板自带 re-armed stop_loss），`involved_entities=[{type:'CRM_DEAL', id:dealId}]`；
  - 决策落库得 `decision_id` → 写回 `payload.last_reopen_decision_id` → `updateParticle`；
  - **`advanceStage` 只进不退契约保持不变**（`lifecycle.js:14` 不动），正向推进零回归。
- **横切改动（铁律，5 处断言同步）**：`agentSpec.js` 给 `followup-agent.actions` 增加 `crm-deal-reopen`；`GATE_SCENARIOS`（`monitor/monitorStore.js:19`）增加 `DEAL_REOPEN`；`S_TRANSITIONS` **不**增反向边（reopen 走独立 action，不污染正向状态机）。

```contract-yaml
- task: "实现 crm-deal-reopen + reopenDeal 反向重开（S7/S8→S2，DEAL_REOPEN 决策锚定）"
  contract_task_id: ct-followup
  agent: followup-agent
  skills: [data-particle-read]
  memory: [followup-agent]
  knowledge_scope: { layers: [L1, L2], max_hops: 3 }
  success: "reopenDeal 仅对 stage∈{S7,S8} 成功；执行后 payload.stage==='S2'、reopen_count 递增、payload.last_reopen_decision_id 指向非空 DEAL_REOPEN 决策；advanceStage 正向路径仍只进不退"
```

### Task 2 · stop_loss 单向物化（决策 → 粒子）

- **落点 `src/decision/decisionRepo.js` 写路径**（createDecision / updateEightElements）：当 `eightElements.stop_loss` 非空且 `involved_entities` 含 `CRM_DEAL` → 动态 `import('../particles/particleRepo.js')` 调 `updateParticle(dealId, {patch:{stop_loss}})` 补丁 `payload.stop_loss={status,condition,deadline,trigger,owner}`。
- **fail-open**：镜像异常 `emit('trace','stop-loss-mirror-fail',{dealId,decisionId,error})` 不阻断决策落库；镜像失败不影响决策，仅留痕（可观测性，G3）。
- 协同：Task 1 的 `DEAL_REOPEN` 决策自带 re-armed stop_loss → 本任务自动刷新 `payload.stop_loss`。

```contract-yaml
- task: "决策 stop_loss 落库时回写 CRM_DEAL.payload.stop_loss（fail-open）"
  contract_task_id: ct-decision
  agent: decision-agent
  skills: [method-decision-execute, data-particle-read]
  memory: [decision-agent]
  knowledge_scope: { layers: [L1, L2], max_hops: 5 }
  success: "crm.decision.stop_loss 非空且 involved_entities 含 CRM_DEAL 时，CRM_DEAL.payload.stop_loss 同步非空且字段齐备；镜像异常仅 emit trace 不阻断决策"
```

### Task 3 · crm-risk 探测模式 `stop_loss_triggered`

- `plugin/skills/crm-risk/rules/detect.md` 增模式：`DEAL.payload.stop_loss.status==='triggered'` → severity `medium-high`。
- `core/scan.md` 步骤 3 增判定：对每个 DEAL 检查 `payload.stop_loss?.status`，命中 → `alert{type:'stop_loss_triggered', deal_id, severity:'medium-high'}`；输出契约 `alerts[]` 含该 type。
- 维持"只读 + emit"纪律（`detect.md:21` 绝对禁删 / 不写业务数据）。

```contract-yaml
- task: "crm-risk 新增 stop_loss_triggered 探测模式（扫描读粒子 payload.stop_loss）"
  contract_task_id: ct-followup
  agent: followup-agent
  skills: [data-particle-read]
  memory: [followup-agent]
  knowledge_scope: { layers: [L1, L2], max_hops: 3 }
  success: "runRiskScan 对 payload.stop_loss.status==='triggered' 的 DEAL 产出 stop_loss_triggered 告警且输出契约含该 type；全程只读+emit，无业务写/删除"
```

> 注：`crm-risk` 为 scheduler 驱动的 SKILL（30min 周期 `runRiskScan`），其探测增强归属 `followup-agent` 契约（`ct-followup`，商机健康监控同域）；Task 1/2 的 agent（followup-agent / decision-agent）均在 `agentSpec.js` 真实存在，且 `decision-agent` 已补 `ct-decision` 契约键（`src/agent/contractIds.js`）。

## 5. 验收锚点（可观测性）

- 重开后 `CRM_DEAL` **不新建粒子** → 身份 / 决策历史连续；`last_reopen_decision_id` 可回溯重开原因与重立止损线。
- `crm-risk` 监控台（SSE / `/agents`）可实时见到 `stop_loss_triggered` 预警，闭环打通"止损触发 → 系统级链路探测"。
- 正向推进（S1→S2→…→S6、→S7/S8）行为完全不变；`advanceStage` 单元测试维持绿。

## 6. 风险与边界

- **零 DELETE 铁律**：reopen 不删除任何历史，仅写 `payload.stage` + 计数 + 决策锚；原 S7/S8 状态由 `reopen_count` 与 `last_reopen_reason` 保留可读。
- **HITL / 第 0 闸**：`crm-deal-reopen` 为 `confirm:'critical'` 写操作，经决策第 0 闸 + HITL 确认；粒子写是已批准决策的副作用，不二次授权。
- **镜像幂等**：stop_loss 镜像为 JSON 差异写（内容未变不重写），与 crm-risk 差量写入纪律一致。
- **场景注册**：`DEAL_REOPEN` 须进 `loadScenarioConfig` 场景表 + `GATE_SCENARIOS`；缺失将导致 autoDecision 无 scenario 兜底。

## 7. 闭环回写（P10 监控 → 反馈 → 改进）

| 任务 | agent | 监控点 | 反馈文件 | 改进建议触发条件 |
|---|---|---|---|---|
| Task 1 reopenDeal | followup-agent | 是否调用 crm-deal-reopen + 读 followup-agent 记忆 + success 判定 | `2026-09-03-deal-reopen-stop-loss-mirror-design.feedback.json` | 同 (task,gap_type) 复发 ≥2 → 建议补 `agentSpec` actions / SKILL 调用指令 |
| Task 2 stop_loss 镜像 | decision-agent | 是否 method-decision-execute + payload.stop_loss 同步 | 同上 | 同上 |
| Task 3 stop_loss_triggered | followup-agent（crm-risk scheduler 归属） | 是否产出该 type 告警 + 只读 | 同上 | 同上 |

> 反馈机制：workbench 解析 `contract-yaml` 块，逐任务追踪 skill/memory/success 命中；miss 时 upsert 至 `<doc>.feedback.json` 并镜像本表。吸收与建议仅提案、需用户批准方可改 SKILL/删数据。

## 8. 测试契约（落地验收）

- `test/sales/reopenDeal.test.js`：S7→S2 成功且 `reopen_count` 递增、`last_reopen_decision_id` 非空；S1/S2/S6 调用 `reopenDeal` 抛错；`advanceStage` 正向用例维持绿。
- `test/decision/stopLossMirror.test.js`：决策 stop_loss 非空 + 挂 CRM_DEAL → 粒子 `payload.stop_loss` 同步；镜像异常 fail-open（emit trace、决策成功）。
- `test/crm-risk/stopLossTriggered.test.js`：`payload.stop_loss.status==='triggered'` → 产出 `stop_loss_triggered` 告警；`status==='armed'` / 无字段 → 不误报；全程无业务写。
- `test/agent/agentSpec.test.js`：横切断言 — `followup-agent.actions` 含 `crm-deal-reopen`；`GATE_SCENARIOS` 含 `DEAL_REOPEN`。
