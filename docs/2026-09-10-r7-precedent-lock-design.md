# R7 先例自锁 — 实现设计（立项已批 · 设计待批）

> 本文档将 `2026-09-10-r7-precedent-lock-project.md`（立项草稿）推进为可审批的实现设计。
> **HARD-GATE**：本设计未批准前不写任何实现代码。

## §0 根因（源码核实）

- `src/decision/autonomyEngine.js` 升级路径将决策落 `state:'HUMAN'`（人工升级分支）。
- `src/decision/decisionRepo.js` 先例池（`decision_precedent_rel` 写入侧）**仅收 `('CONFIRMED','AUTONOMOUS')`**。
- HUMAN 决策经 HITL 确认后（`decisionRepo.js` 确认升 `CONFIRMED` 路径）会升 `CONFIRMED` → 正常进池。
- **结论**：仅「升人工后**从未确认**」的决策不进先例池。属**覆盖度缺口**，非正确性缺陷；不会影响任何已确认/自治决策的链路。

## §1 候选方案

**方案 A（推荐）：保持先例池语义不变 + 可观测性 + 流转加固 + 回归护栏**
- 先例池继续只收 `CONFIRMED`/`AUTONOMOUS`（语义正确：先例必须对应已决结论）。
- 新增量化任务：统计 HUMAN 态决策占比与确认率，判断缺口是否值得进一步处理。
- 加固 HUMAN→CONFIRMED 流转，确保「确认必进池」无遗漏。
- 加单测护栏，防止未来误把 HUMAN 直接入池。
- 风险：最低（零语义变更）；收益：消除「自锁」的不确定性、固化正确行为。

**方案 B：扩收 HUMAN 态入池（带护栏）**
- 将「升人工且带 disposition」的决策也纳入先例。
- 风险：未确认的人工升级本质是无结论事件，入池会污染先例、误导后续推理置信度；护栏复杂、收益不确定。

**方案 C：新增中间态 `HUMAN_RESOLVED`**
- 在决策状态机新增显式「人工已决」态，与 `HUMAN`（待确认）区分。
- 风险：改动决策状态枚举与全链路（监控、回写、injector），影响面大；当前缺口不足以支撑此改动。

**推荐方案 A**：fail-safe，零语义风险，且把「是否真需要改语义」变成一个由数据驱动的可复审决策。

## §2 设计任务（含生命契约）

### T1 — 量化 HUMAN 态缺口（可观测性）
```contract-yaml
- task: "量化 HUMAN 态决策占比与确认率"
  contract_task_id: "ct-retro-decision"
  agent: decision-retro
  skills: [decision-retrospective]
  memory: [decision-retro]
  knowledge_scope: { layers: [L2], max_hops: 1 }
  success: "对 crm.decision 执行统计，输出 HUMAN 态总数/占比、其中已升 CONFIRMED 数/确认率；口径写入 §闭环回写"
```
**契约说明：** 由 `decision-retro` 承接，调用 `decision-retrospective`，读取 `decision-retro` 记忆（L2，≤1 跳）；成功标准为给出 HUMAN 缺口量化报告。

### T2 — 加固 HUMAN→CONFIRMED 流转
```contract-yaml
- task: "确保 HUMAN 决策经确认后必进先例池"
  agent: decision-agent
  skills: [method-decision-enrich]
  memory: [decision-agent]
  knowledge_scope: { layers: [L2], max_hops: 1 }
  success: "单测：构造 HUMAN 决策 → 走确认升 CONFIRMED → decision_precedent_rel 出现该决策为 precedent_id 的边"
```
**契约说明：** 由 `decision-agent` 承接，调用 `method-decision-enrich`，读取 `decision-agent` 记忆；成功标准为确认路径单测通过。

### T3 — 先例池闸门回归护栏
```contract-yaml
- task: "先例池闸门回归护栏（仅 CONFIRMED/AUTONOMOUS 入池）"
  contract_task_id: "ct-decision"
  agent: decision-agent
  skills: [method-decision-enrich]
  memory: [decision-agent]
  knowledge_scope: { layers: [L2], max_hops: 1 }
  success: "单测：直接以 state='HUMAN' 触发先例写入被拒绝/跳过；仅 CONFIRMED/AUTONOMOUS 产生 decision_precedent_rel 边"
```
**契约说明：** 由 `decision-agent` 承接；成功标准为闸门单测断言先例池不被 HUMAN 污染。

## §3 验收标准

1. `crm.decision` 中 HUMAN 态决策占比/确认率已量化并归档（T1）。
2. HUMAN→CONFIRMED 确认路径有单测覆盖，确认必进池（T2）。
3. 先例池闸门单测断言：HUMAN 直接写入被拒/跳过，仅 CONFIRMED/AUTONOMOUS 入池（T3）。
4. 全量回归无新增红（沿用既有 692 测试基线 + 上述 3 项新增单测）。

## §4 风险与回滚

- 本设计**不改变任何既有行为语义**，仅加固既有正确路径 + 加护栏 → 回滚成本为零（删新增单测与统计脚本即可）。
- 若 T1 量化显示 HUMAN 未确认占比显著（>阈值，待定），再单独立项评估方案 B/C，不在本设计范围内。

## §5 闭环回写

| 任务 | 智能体 | 缺口类型 | 观测 | 期望 | 严重度 |
|------|--------|----------|------|------|--------|
| T1 量化 HUMAN 缺口 | decision-retro | 覆盖度 | 生产库 crm.decision 256 条：HUMAN 84(32.81%，超 10% 显著阈值)；终态占比 9.38%。测试库为空 | 量化归档 + 触发 §4 B/C 评估后续项 | P1（缺口显著，但属观测非缺陷） |
| T2 HUMAN→CONFIRMED 流转 | decision-agent | 流转 | 单测：HUMAN 确认前不在先例池、confirmDecision 后入池；similarity>0.45 | 通过 | 🟢 |
| T3 先例池闸门 | decision-agent | 闸门 | 单测：HUMAN 永不被 searchPrecedents 召回、永不成 decision_precedent_rel.precedent_id | 通过 | 🟢 |

> 运行期由 agent-workbench 监控契约达成度；同一 `(task, gap_type)` 复发 ≥2 次 → 生成 SKILL 改进提案，经用户显式批准后方可执行。
