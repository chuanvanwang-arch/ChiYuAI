---
name: decision-retrospective
description: 决策复盘技能——汇总窗口内决策质量（根因分布 / 应连边缺失率 / 结果校验态），LLM 深度归因产出可复核的整改处方建议（draft_patches）。只读 + 处方，不触写通道。
environment:
  required: []
  optional: []
security:
  requiresSecrets: false
  sensitiveEnvironment: false
  externalNetworkAccess: false
---

# decision-retrospective · 决策复盘技能

> 定位：J3 校准层的「批量复盘」——对统计窗口内（默认 24h/30 天）决策集群做根因分类与整改处方产出，作为实时 autoSuggest（偏差触发浮卡）的批量补充。
> 设计输入：`docs/2026-09-01-event-triggered-retro-design.md`（事件触发式复盘）+ `docs/2026-09-01-retro-agent-wiring-design.md`（D4 接线）+ 决策问责统一设计（J1 上下文图谱 / J2 反馈回路 / J3 校准层）。
> 运行时本体：`src/decision/retro.js`（`runDecisionRetro`）+ `src/decision/retroTrigger.js`（`registerRetroTrigger` 事件订阅）。

## 触发方式（双通道）

| 触发 | 通道 | 说明 |
|---|---|---|
| 事件自动 | `decision:confirmed` + business_tier ≥ `min_tier`（默认 HIGH）+ 冷却窗内无同租户复盘任务 | `retroTrigger.maybeTriggerRetro` → 建 `intent='retro'` 任务 → pumpReadyTasks 派发 |
| 人工/对话 | 工作台「复盘本月重大决策质量」 | `classify` 命中 retro 意图 → 派发 `decision-retro` agent → 同上执行体 |

> 配置（阈值配置化铁律）：`config_store['event-retro']` 的 `enabled / min_tier / cooldown_hours / auto_pump`，代码只存出厂默认（`retroTrigger.js:20-25`）。

## 执行体（2 步，seed.js EXEC_SKILLS 注册）

| step | 动作 | 决策 | 说明 |
|---|---|---|---|
| 1 | `decision-retrospective` | rule | `runDecisionRetro({windowDays:30, limit:20})` 汇总窗口决策：按 scenario 聚类 → 七类根因分类 + 维度/边缺失采样 + 反馈旗标 |
| 2 | —（agentLoop j_judge） | j_judge | 基于 step1 汇总：① 主要根因分布 ② 应连边缺失情况 ③ 可执行整改处方建议（按优先级排序） |

> LLM 不可用（未配置/超时）→ step1 确定性启发式降级（`heuristicAnalyze`，标 `degraded`、不出处方），不崩、episode 照常落库（验证见事件触发复盘设计 §5）。

## 七类根因（单一事实源 `retro.js:16-24`）

| 根因类 | 含义 |
|---|---|
| `FIELD_MISMATCH` | 字段不一致（payload key 与 meta_attr 命名错配） |
| `INFO_INCOMPLETE` | 信息不完整（required 字段缺失） |
| `INPUT_LATE` | 输入不及时（updated_at 距 decided_at 超 SLA） |
| `DIM_MISSING` | 维度不对（required_dims 要求缺失） |
| `EDGE_MISSING` | 边选择不对（决策图 E1-E7 应存缺） |
| `NEED_DIM_ORDER` | 优化次序 / 补齐维度 |
| `DATA_QUALITY_PRECEDENT` | 数据质量·参考先例/标杆污染 |

## 处方协议（draft_patches）

> 产出是**草稿**，不是自动写：绝不自批自方（`retro.js:5-6` 铁律②），不写 `calibration_patch`、不自动 apply；管理员审批经决策第 0 闸在既有校准流完成。

- 每条处方：`{ knob, target, from_value, to_value, risk: LOW|MEDIUM|HIGH, label, evidence }`
- `knob` 白名单：`required_dims / threshold / weight / edge_binding / meta_attr_map / particle_attr_add / source_refresh / dim_order / precedent_distill`
- 样本不足（`< MIN_SAMPLE`）→ 不出处方（R6 守卫，仅提示）。

## 落库（追加式，唯一写）

- `INSERT crm.decision_retro_report`（run_at/window/decisions_scanned/clusters/draft_patches/summary/llm_enabled）——**只追加，绝不 DELETE**。
- SSE：`emit('calibration','retro-suggestions')`（前端自动建议浮卡可订阅）+ `emit('trace','decision-retro-done')`（可观测）。

## 结果校验（J2 回路）

- 复盘报告与决策反馈（usable / major_deviation）与业务结果（won/lost/paid) 关联，作为「决策 → 复盘 → 校准」闭环的输入。
- 契约矩阵 `decision-retro` 断言：`monitor_event` 五契约键真实 episode（`ct-retro-decision`：intent-parsed / context-injected / loop-started / loop-done）。

## Action 读/写清单

| Action | 用途 |
|---|---|
| `decision-retrospective` | 本技能执行体（read kind，只读 + 处方） |
| `data-particle-read` | 写前/校验辅助读（处方落地前置检查） |

> 写处置（校准补丁 apply / 阈值调整）经决策第 0 闸 + 既有校准流，本技能绝不触碰写通道（绝对禁删）。

## 安全红线

- 只读 + 处方：绝不直接写 `calibration_patch` / 阈值 / 粒子（写走 crm-write 两阶段 + 第 0 闸）。
- 绝对禁删：无 delete/remove 工具。
- LLM 降级不阻塞：LLM 不可用 → 确定性启发式仍产出洞察，不凭空编造处方。