# G3/G4 修复方案设计（4-Agent 名册补强）

> 上游设计：`docs/specs/2026-08-29-agent-roster-4-agent-design.md`
> 关联修复：G1（decision 测试计数 9→10）、G2（agentSpec.memory.read 悬空引用）已完成并验证 19/19 全绿。
> 本方案仅覆盖 **G3（KG 降级下 review-gate 的 L3 不生效）** 与 **G4（4-agent 全自治 LLM 闭环集成测试）** 两个剩余缺口。
> **状态：待用户评审批准。未经批准不写实现代码。**

---

## §0 背景与现状（证据先行）

| 维度 | 落点 | 现状 |
|---|---|---|
| review-gate 知识声明 | `src/agent/agentSpec.js:45` | `knowledgeScope.layers: ['L1','L2','L3'], maxHops: 4` |
| KG 就绪断言 | `src/agent/agents.js:36` | `kg_ready: ok:true, detail:'degraded: kg_coverage_stage2'` |
| 契约记忆校验（消费 layers） | `src/contract/contractService.js:36-45` | 按 `spec.capabilities.knowledgeScope.layers` 强校验"layer 是否在声明集合" |
| 契约解析校验（消费 layers） | `src/contract/contractParser.js:117-128` | 同上，解析期 push `knowledge_scope` 错误 |
| L3 检索降级保护 | `src/context/assembler.js:80,105` | `retrieveL3` 失败 → `missing.L3 = true`（契约层**不看**该降级标志） |
| A 唯一入口派发 | `src/kanban/scheduler.js:24,49,56` | `routeThroughIntake` 纯函数 + `dispatchOne` 注入 `contract_task_id` |
| 上下文层级装配 | `src/context/assembler.js:1` | L1 知识底座 / L2 历史决策 / L3 执行协同 / L4 治理决策 + 降级链 |

**已确认矛盾（G3 根因）**：`review-gate` 声明了 `L3`，但 KG 实际降级（`kg_coverage_stage2`）。契约校验层（`contractService.js:36` / `contractParser.js:117`）**仅比对声明集合，不感知降级状态**，因此当运行时 L3 检索因降级缺失（`assembler.js:105`）时，契约记忆校验仍按"声明含 L3"要求，产生**静默误判**——要么校验失败阻塞评审，要么放行后 L3 上下文实际为空却无从告警。

**已确认缺口（G4 根因）**：`scheduler.js` 的 `routeThroughIntake` / `dispatchOne` 是真实运行的派发链路，但全仓无集成测试验证「A 路由 → 注入 `contract_task_id` → B/C/D 执行 → decision 事件贯通 → 记忆回写」这条端到端闭环。现有 `test/e2e.test.js` 只覆盖粒子/事件/看板链路，`test/agent-spec-4.test.js` 只覆盖注册表静态断言。

---

## §1 G3：KG 降级下 review-gate 的 L3 不生效

### §1.1 候选路线

**路线 A（推荐 · 收敛保稳 + 守护）**
1. 将 `review-gate` 的 `knowledgeScope.layers` 由 `['L1','L2','L3']` 收敛为 `['L1','L2']`（`agentSpec.js:45`），与 B/C 口径一致，消除"声明 L3 但 KG 降级"的契约误判源。
2. 在 `agents.js` 的 `assertAgentAssembly` 中新增**降级一致性守护**：当某 agent 声明含 `L3` 且 `kg_ready.detail` 为 `degraded` 时，断言 `l3_stated_but_kg_degraded` 显式 `ok:false` + 告警，而非静默 `ok:true`；并在 spec 增加 `kg_target: 'L3'` 字段标记"L3 待建设"。
3. `assembler.js` 的 L3 检索降级保护保留（不影响运行时），仅契约层不再误要求 L3。

- 优点：低风险、可立即落地、不触动 KG 基础设施；消除误判且对未来"补 L3"留明确升级路径。
- 缺点：review-gate 暂时放弃 L3 上下文增益（KG 就绪前）。

**路线 B（仅收敛）**
- 只改 `agentSpec.js:45` 为 `['L1','L2']`，不动断言层。
- 优点：最简。缺点：缺守护，未来若再有人声明 L3 会重蹈覆辙。

**路线 C（补 KG 就绪，让 L3 真正生效）**
- 真建 L3 知识图谱层：实体/关系抽取 + 图存储 + 向量索引，seed 关联数据，解除 `kg_coverage_stage2` 降级。
- 优点：L3 增益落地。缺点：工作量大、需定义 KG schema 与 embedding 管线、与现有"KG 降级"基础设施解耦成本高，超出本缺口修复范围。

### §1.2 推荐决策
**采用路线 A**。理由：G3 本质是"声明与降级态不一致导致的契约误判"，收敛声明 + 加守护是最小且正确的修复；补 KG（路线 C）是独立的中期能力项，不应混入缺口修复。

### §1.3 实施步骤（路线 A）
1. `Edit src/agent/agentSpec.js:45`：`layers: ['L1','L2']`，并新增 `kg_target: 'L3'`（标注待升级）。
2. `Edit src/agent/agents.js`：在断言循环内新增 `l3_stated_but_kg_degraded` 守护（声明含 L3 且 kg 降级 → `ok:false`）；`portal/agentsPage.js:2` 的 `ASSERTIONS` 数组同步加入该守护键（含中文标签）。
3. 新增 `test/g3-knowledge-scope.test.js`：断言 (a) 现 4 体无"声明 L3 但 KG 降级"组合；(b) review-gate 收敛后 `knowledgeScope.layers` 不含 L3；(c) `assertAgentAssembly` 对"声明 L3 + degraded"返回 `ok:false`。

### §1.4 验收锚点
- `agentSpec.js:45` → `layers: ['L1','L2']` 且 `kg_target: 'L3'`。
- `agents.js` 新增守护键 `l3_stated_but_kg_degraded`，对异常组合返回 `ok:false`。
- `test/g3-knowledge-scope.test.js` 全绿；`test/agent-spec-4.test.js` 仍绿（无回归）。

---

## §2 G4：4-agent 全自治 LLM 闭环集成测试

### §2.1 候选策略

**策略 A（推荐 · rule 回退集成测试）**
- 用确定性 rule 回退路径（非 LLM）驱动 `routeThroughIntake → B/C/D`，验证 `contract_task_id` 注入 + decision 事件贯通 + 记忆回写。
- 具体分层：
  - **单元测试层**：直接调用 `routeThroughIntake(task)`（纯函数，`scheduler.js:24`），断言 `targetAgent` / `gateAgents` / `payload.contract_task_id` / `dispatchedFrom` 正确。
  - **派发注入层**：mock `agentLoop.runWithSkill`，调用 `dispatchOne`（需绕开 `queue` 与 DB claim，或将其重构为可注入），断言传入 `ctx.contractTask` 等于 `contract_task_id`。
  - **闭环贯通层**：用 rule 回退 SKILL（不依赖 LLM）真实跑一条 kanban task，断言 `decision` 表生成带 `decision_id` 的行（第 0 闸）、`memory_log` 有对应回写、`contractMonitor.js:32` 能消费 `knowledge_layers_read`。
- 优点：稳定、CI 友好、无外部 LLM 成本与 flaky；精准覆盖 G4 关心的"派发闭环"。
- 缺点：不验证 LLM 推理路径本身（由各自 SKILL 单测覆盖）。

**策略 B（LLM mock 测试）**
- mock LLM 返回结构化决策，验证 LLM 路径下的派发与闸门。
- 优点：覆盖 LLM 编排。缺点：需 stub LLM 客户端，mock 维护成本。

**策略 C（真 LLM 端到端）**
- 接 SiliconFlow 真实跑闭环。最真实，但慢、有成本、flaky，不宜入常驻 CI。

### §2.2 推荐决策
**采用策略 A**，并可叠加一层轻量 B（对 `routeThroughIntake → runWithSkill` 的 LLM 调用做 mock 断言）。核心理念：G4 验证的是"**派发与契约接线闭环**"，不是 LLM 智能本身，rule 回退已足够且最稳。

### §2.3 实施步骤（策略 A）
1. `Edit src/kanban/scheduler.js`：将 `dispatchOne` 内部 `runWithSkill` 调用与 `claimTask` 抽取为可注入（或导出 `routeThroughIntake` 已可单测，再加 `dispatchOneCore(task, { runWithSkill })` 便于测试注入），保持运行时行为不变。
2. 新增 `test/g4-dispatch-loop.integration.test.js`：
   - 用例 1：`routeThroughIntake` 纯函数断言（normal/major × quote/followup 四象限）。
   - 用例 2：`dispatchOneCore` 注入 mock `runWithSkill`，断言 `ctx.contractTask` 注入正确。
   - 用例 3：在测试库 `plm_test` 起一条真实 kanban task（rule 回退 SKILL），跑 `dispatchOne`，断言 `decision` 表新增带 `decision_id` 行 + `memory_log` 回写 + `contractMonitor` 消费成功。
3. 测试库隔离：遵循 `vitest.config.js:9` 强制 `PGDATABASE=plm_test`，且**单进程运行**（避免并发 TRUNCATE 冲突，参见项目铁律）。

### §2.4 验收锚点
- `scheduler.js` 导出可注入的 `dispatchOneCore`（或等价 test seam），运行时 `dispatchOne` 行为不变。
- `test/g4-dispatch-loop.integration.test.js` 全绿，覆盖：路由四象限、contract_task_id 注入、decision 事件贯通、memory_log 回写。
- 全量回归无新增失败。

---

## §3 实施计划（writing-plans 风格 · 每 Task 一 commit）

> 沙箱无私有库凭证，实现后由用户在本地分批 commit（勿 `git add -A`）。

| Task | 范围 | 改动文件 | 验证 |
|---|---|---|---|
| T1 · G3 收敛 | review-gate 知识声明收敛 + kg_target 标记 | `src/agent/agentSpec.js` | grep 确认无 L3 声明 |
| T2 · G3 守护 | 降级一致性断言 + 门户标签 | `src/agent/agents.js`, `src/portal/agentsPage.js` | `assertAgentAssembly` 单测 |
| T3 · G3 测试 | 知识范围守护测试 | `test/g3-knowledge-scope.test.js` | 全绿 + 无回归 |
| T4 · G4 接缝 | scheduler 派发可注入 | `src/kanban/scheduler.js` | 运行时行为不变 |
| T5 · G4 集成测试 | 路由/注入/闭环三层 | `test/g4-dispatch-loop.integration.test.js` | 全绿 |
| T6 · 全量回归 | 单进程跑全量 | `vitest run` | 0 新增失败 |

---

## §4 待用户确认事项

1. **G3 路线**：默认采用 **路线 A（收敛 + 守护）**。若你倾向路线 C（补 KG 让 L3 生效），请明确——那将升级为独立能力项，不在本缺口修复内。
2. **G4 策略**：默认采用 **策略 A（rule 回退集成测试）** + 轻量 LLM mock 叠加。若需策略 C（真 LLM 端到端），请明确（需接入 SiliconFlow 且不宜常驻 CI）。
3. 文档路径：`docs/specs/2026-08-29-g3-g4-remediation-design.md`（与 4-agent 名册设计同目录）。

批准后将进入 writing-plans → 实现（按 §3 六个 Task 推进，每 Task 一 commit）。
