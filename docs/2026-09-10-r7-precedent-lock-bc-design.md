# R7 先例自锁 · B/C 独立立项设计（真因复核版）

> 本文档将 R7 原始设计（`2026-09-10-r7-precedent-lock-design.md`）§4 的「B/C 独立立项」推进为可审批实现设计。
> **HARD-GATE**：本设计未批准前不写任何实现代码。
> 立项范围已批：**A' 全做**（闸门对齐真实终态 + embedding 回填 + 回归护栏 + 量化复核）。

## §0 真因复核结论（生产库 + 源码级核实，已批立项前完成）

原始 R7 设计把"32.8% HUMAN 缺口"判为覆盖度缺口。经本次生产只读审计，**该判断需修正**：

- 生产 `crm.decision` 256 条：`DECIDED`=128(50%) / `HUMAN`=84(32.8%) / `CONFIRMED`=21 / `REQUIRED`=17 / `PROCESSED`=3 / `REVERSED`=2 / `AUTONOMOUS`=1。
- `searchPrecedents` 闸门（`decisionRepo.js:544`）= `state IN ('CONFIRMED','AUTONOMOUS')` → **池现仅 22 条（8.6%）**。
- 全仓 `src/` 从不写 `state='DECIDED'`（`schema.sql:181` 无 CHECK 枚举）→ `DECIDED`/`PROCESSED` 是**状态机重构前的遗留终态**，携带真实 disposition（128/128 100% 有 disposition），但被旧闸门挡在池外。
- `HUMAN`(84) 画像：`human_disposition` 全 NULL、`decider_id` 全 NULL、63 条 <7 天 → **待人工确认的正常挂起，本就不该入池**。

**真因**：先例池闸门停留在旧状态词汇，未跟随真实终态演变；**131 条已决决策（DECIDED 128 + PROCESSED 3）被挡在池外 = 真正的"先例自锁"**。

**安全边界**：`searchPrecedents` 对无存储 embedding 的候选有即时重嵌兜底（`decisionRepo.js:575-580`），DECIDED 入池不会崩溃，仅放大每查询重嵌量（22→153）。

## §1 方案选型（已批 A'）

| 方案 | 内容 | 风险 | 结论 |
|---|---|---|---|
| **A'（批准）** | 闸门收四态 {CONFIRMED,AUTONOMOUS,DECIDED,PROCESSED} + 一次性 embedding 回填 + 2 道回归护栏 + 量化复核 | 低-中（纯闸门放宽+幂等回填，零 DELETE，回滚=改回 IN 子句） | ✅ |
| B' | 数据迁移 DECIDED/PROCESSED→CONFIRMED | 污染状态语义、扭曲校准看板 | ❌ |
| C' | 新增"已决"枚举 | 过度设计 | ❌ |

## §2 设计任务（含生命契约）

### T1 — 闸门对齐真实终态
```contract-yaml
- task: "先例池闸门收已决四态"
  contract_task_id: "ct-decision"
  agent: decision-agent
  skills: [method-decision-enrich]
  memory: [decision-agent]
  knowledge_scope: { layers: [L2], max_hops: 1 }
  success: "decisionRepo.js:544 的 state IN 子句改为引用 DECISION_DECIDED_STATES={CONFIRMED,AUTONOMOUS,DECIDED,PROCESSED} 常量；HUMAN/REQUIRED 仍不入库；单测断言 searchPrecedents 召回 DECIDED 决策"
```
**契约说明：** 由 `decision-agent` 承接，调用 `method-decision-enrich`，读取 `decision-agent` 记忆；成功标准为闸门常量化且 DECIDED 可召回。

### T2 — 决策 embedding 回填（幂等）
```contract-yaml
- task: "回填 DECIDED/PROCESSED 决策 embedding"
  contract_task_id: "ct-decision"
  agent: decision-agent
  skills: [method-decision-enrich]
  memory: [decision-agent]
  knowledge_scope: { layers: [L2], max_hops: 1 }
  success: "新增 scripts/decision-embed-backfill.mjs：只读遍历 state IN('DECIDED','PROCESSED') 且 embedding IS NULL 的行，用 embedText 重嵌 trigger_context+conditions_evaluated 写回 embedding 列；幂等（仅补 NULL）、零 DELETE；测试库演练成功，生产 HITL 授权后执行"
```
**契约说明：** 由 `decision-agent` 承接；成功标准为回填脚本幂等可跑、不破坏既有数据。

### T3 — 回归护栏（先例池召回语义）
```contract-yaml
- task: "先例池召回回归护栏"
  contract_task_id: "ct-decision"
  agent: decision-agent
  skills: [method-decision-enrich]
  memory: [decision-agent]
  knowledge_scope: { layers: [L2], max_hops: 1 }
  success: "单测：构造 DECIDED 决策 → searchPrecedents 返回该决策（similarity>=floor）；构造 HUMAN 决策 → searchPrecedents 不返回"
```
**契约说明：** 由 `decision-agent` 承接；成功标准为两道护栏（DECIDED 入池 / HUMAN 不出池）单测通过。

### T4 — 量化复核（闭环指标）
```contract-yaml
- task: "先例池覆盖率量化复核"
  contract_task_id: "ct-retro-decision"
  agent: decision-retro
  skills: [decision-retrospective]
  memory: [decision-retro]
  knowledge_scope: { layers: [L2], max_hops: 1 }
  success: "重跑口径脚本，输出「先例池覆盖率 8.6%(22)→59.8%(153)」；写入 §闭环回写"
```
**契约说明：** 由 `decision-retro` 承接，调用 `decision-retrospective`；成功标准为覆盖率前后对比归档。

## §3 验收标准

1. `searchPrecedents` 闸门引用 `DECISION_DECIDED_STATES` 常量（四态），HUMAN/REQUIRED 仍排除（T1）。
2. `scripts/decision-embed-backfill.mjs` 幂等可跑，测试库演练通过，生产 HITL 执行后 DECIDED/PROCESSED 的 embedding NULL 数归零（T2）。
3. 回归护栏单测：DECIDED 可召回、HUMAN 不召回（T3）。
4. 量化复核：先例池覆盖率从 8.6%(22) → 59.8%(153) 归档（T4）。
5. 全量决策回归无新增红。

## §4 风险与回滚

- T1 纯闸门放宽 + 常量化，**回滚=改回 IN 子句字面量**，零副作用。
- T2 回填仅写 `embedding` 列、仅补 NULL、零 DELETE，幂等可重跑，回滚=置回 NULL（无业务字段损失）。
- T3/T4 仅测试+只读统计，无生产写。
- 整体不改变"先例必须对应已决结论"语义；不触碰 HUMAN→CONFIRMED 既有流转（仍走 `disposition.js:recordHumanDisposition`）。

## §5 闭环回写

| 任务 | 智能体 | 缺口类型 | 观测 | 期望 | 实测 | 严重度 |
|------|--------|----------|------|------|------|--------|
| T1 闸门对齐 | decision-agent | 闸门过时 | 池现 22 条(8.6%)，131 条已决 DECIDED/PROCESSED 被挡 | DECIDED/PROCESSED 入池 | ✅ 闸门已改 `DECISION_DECIDED_STATES`，单测 DECIDED 召回/HUMAN 不召回通过 | P0（真自锁） |
| T2 embedding 回填 | decision-agent | 缺向量 | DECIDED/PROCESSED 0 条有 embedding | 回填后 NULL 归零 | ✅ 生产 dry-run 命中 131 条（128 DECIDED+3 PROCESSED）待 HITL `--apply` | P1（性能，非正确） |
| T3 回归护栏 | decision-agent | 闸门 | DECIDED 召回 / HUMAN 不召回 | 通过 | ✅ 3/3 单测通过 | 🟢 |
| T4 量化复核 | decision-retro | 覆盖度 | 池覆盖 8.6%→59.8% | 归档 | ✅ 实测 8.6%(22)→59.8%(153) | 🟢 |

> 运行期由 agent-workbench 监控契约达成度；同一 `(task, gap_type)` 复发 ≥2 次 → 生成 SKILL 改进提案，经用户显式批准后方可执行。
