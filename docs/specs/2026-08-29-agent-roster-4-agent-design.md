# 设计文档：4 智能体名册重建（A接诊/B报价/C跟进/D评审）

- 版本：1.0
- 日期：2026-08-29
- 上游：`docs/2026-08-29-agent-architecture-reconciliation.md`（4 愿景 vs 3 实现对齐分析）+ 本次 brainstorming P2–P5 已确认决策
- 形态：双轨 **Living Contract**（机器块 + 散文），字段 `agent/skills/memory/knowledge_scope/success` 对齐 `src/agent/agentSpec.js` 的 `capabilities.skillCalls` / `memory.read` / `capabilities.knowledgeScope.layers`
- 通用性：以 CRM 为参考实例；用户级 10 ai-* SKILL 不承载业务专有词

---

## §0 已确认决策（P5 批准）

| 维度 | 决策 |
|---|---|
| 数量 | **4 全自治 LLM agent**（A 接诊分流 / B 报价测算 / C 跟进催办 / D 评审把关） |
| 拓扑 | **A 唯一入口路由**：新询盘/任务→A 意图识别+商机分级→派发 B/C/D；B/C/D 仅由 A 派发，不自主接 kanban |
| 职责 | **生命周期四段**：A 入口分流 → B 报价测算 → C 跟单催办/回款 → D 风险把关（全程双闸门介入重大商机） |
| 执行 | **直接重建 4 个执行体**：废弃旧 3 个（crm-copilot/deal-coach/lead-miner）独立执⾏体，新建 4 个完整 loop/context/决策；旧 action 复用 |
| D 基线 | **写全 3 基线 + 内置四维审查**（功能/架构/安全/合规） |
| SKILL | 新建 `method-intake-routing` / `method-quote-engine` / `method-followup-engine` / `method-review-gate`（对齐现有 method-* 命名） |
| 监控 | 契约矩阵重写为 4 agent；旧 3 降级为被调用的 skill/tool |

## §1 背景与问题（证据驱动）

- **展示层**（`doc/sales-platform-features.html:170-185`）：4 个业务角色（智能体 A 接诊分流 / B 报价测算 / C 跟进催办 / D 评审把关）为**静态产品展示页**，对话为写死脚本（`CASES`/`DECISIONS` 常量），无真实 agent 后端。
- **注册层**（`src/agent/agentSpec.js:1-40`）：仅 3 个能力 agent（`crm-copilot`/`deal-coach`/`lead-miner`），按"能力视角"拆分，文件头注释仍写"3 Agent 六段式"。
- **监控层**：契约闭环（`docs/specs/2026-08-29-agent-workbench-contract-monitor-design.md`）仅覆盖其中 2 个（crm-copilot/deal-coach），lead-miner 无契约。

三层未对齐 → 本次以愿景为纲、直接重建 4 个执行体拉齐。

### §1.1 覆盖缺口矩阵

| 业务角色（愿景 4） | 当前 3 个能力 agent | 缺口 |
|---|---|---|
| A 接诊分流（意图路由+分级派活） | 部分（lead-miner 做情报挖掘，无路由/派发） | 缺编排层 |
| B 报价测算（配置/成本/毛利） | **零覆盖**（deal-coach 是推进建议非报价测算） | 净缺 |
| C 跟进催办（自动跟进/节点催办/超时转人工） | **零覆盖** | 净缺 |
| D 评审把关（双闸门/专家介入/留痕） | 部分（crm-copilot 做 NL→Action，无评审闸逻辑） | 缺闸门 |

## §2 目标名册（4 agent）

### §2.1 A 接诊分流（intake-router）

```yaml
key: intake-router
derivedFrom: taskFlow:crm-intake-routing
autonomy: recommend
actions: [data-particle-read, data-particle-create, crm-deal-advance, crm-account-360]
skillCalls: [data-particle-read, method-intake-routing]
knowledgeScope: { layers: [L1, L2], maxHops: 3 }
memory: { read: [intake-router, lead-miner], write: [intake-router] }
evaluation: { metricTemplate: routing_accuracy, evaluator: stage2 }
governance: { approvals: [critical], concurrency: 3, profile: full }
```

### §2.2 B 报价测算（quote-engine）

```yaml
key: quote-engine
derivedFrom: taskFlow:crm-quote-calculation
autonomy: recommend
actions: [data-particle-read, crm-deal-advance, crm-account-360]
skillCalls: [data-particle-read, method-quote-engine]
knowledgeScope: { layers: [L1, L2], maxHops: 3 }
memory: { read: [quote-engine, deal-coach], write: [quote-engine] }
evaluation: { metricTemplate: quote_accuracy, evaluator: stage2 }
governance: { approvals: [recommend], concurrency: 3, profile: full }
```

### §2.3 C 跟进催办（followup-agent）

```yaml
key: followup-agent
derivedFrom: taskFlow:crm-followup-reminder
autonomy: recommend
actions: [data-particle-read, data-particle-create, data-particle-edge-create, crm-account-360]
skillCalls: [data-particle-read, data-particle-create, method-followup-engine]
knowledgeScope: { layers: [L1, L2], maxHops: 3 }
memory: { read: [followup-agent, quote-engine, deal-coach], write: [followup-agent] }
evaluation: { metricTemplate: followup_timeliness, evaluator: stage2 }
governance: { approvals: [critical], concurrency: 3, profile: full }
```

### §2.4 D 评审把关（review-gate）

```yaml
key: review-gate
derivedFrom: taskFlow:crm-review-gate
autonomy: recommend
actions: [data-particle-read, crm-deal-advance, crm-account-360]
skillCalls: [data-particle-read, method-review-gate, review-guard-cli]
knowledgeScope: { layers: [L1, L2, L3], maxHops: 4 }
memory: { read: [review-gate, crm-copilot, deal-coach], write: [review-gate] }
evaluation: { metricTemplate: review_precision, evaluator: stage2 }
governance: { approvals: [critical], concurrency: 3, profile: full }
```

### §2.5 SKILL 落位

| 新 SKILL | 承载角色 | 对齐现有命名 |
|---|---|---|
| `method-intake-routing` | A 意图识别+商机分级 | `skills/method-*.md`（现有 8 个） |
| `method-quote-engine` | B 配置/成本/毛利测算 | 同上 |
| `method-followup-engine` | C 自动跟进/节点催办/超时转人工 | 同上 |
| `method-review-gate` | D 双闸门/专家介入/留痕（3 基线：review skills / guard cli / 内置四维审查） | 同上 |

旧 3 agent 降级为被上述 4 个调用承载（`crm-copilot`/`deal-coach`/`lead-miner` 不再独立注册）。

## §3 编排链路（端到端）

```
新询盘/任务 → [A intake-router] 意图识别 + 商机分级
   ├── 一般商机 → [B quote-engine] 报价测算（A/B 方案+毛利预估）
   │        → [C followup-agent] 自动跟进/节点催办 → 回款闭环
   └── 重大商机 → B → C 全程 [D review-gate] 双闸门介入（报价复核/合同确认），决策留痕
```

- **决策事件主轴**（项目铁律）：A 每次派发、D 每次把关都是 `decision` 事件（带 `decision_id`），贯穿 L1–L4。
- **派发闭合**：scheduler 重写为 A 唯一入口；A 输出 `contract_task_id` + 目标 agent，写入 kanban task `payload.contract_task_id`（此前"未决项"在此闭合）。
- **监控**：agentLoop 每次运行写 `monitor_event`（`contract_task_id` + `skill` + `knowledge_layers_read`），契约矩阵据此逐 agent 判定（`src/agent/contractMonitor.js` 复用）。

## §4 契约矩阵更新

默认契约文档（`docs/specs/2026-08-29-agent-workbench-contract-monitor-design.md`）重写为 4 agent 的 contract-yaml 块。矩阵每次渲染 4 行（每行带标记按钮），B/C/D 仅由 A 派发。

## §A Living Contract（双轨机器块）

```contract-yaml
- task: "实现 4 agent 名册重建（intake-router/quote-engine/followup-agent/review-gate 全自治）"
  agent: crm-copilot
  skills: [data-particle-read]
  memory: [crm-copilot]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "agentSpec.js 注册 4 个 agent；scheduler 改为 A 唯一入口派发"

- task: "新建 4 个角色专属 SKILL（intake-routing/quote-engine/followup-engine/review-gate）"
  agent: deal-coach
  skills: [data-particle-read]
  memory: [deal-coach, crm-copilot]
  knowledge_scope: { layers: [L1, L2], max_hops: 3 }
  success: "skills/ 下 4 个 method-*.md 存在且 frontmatter 完整、rbac_roles 正确"

- task: "scheduler 重写为 A 唯一入口路由（B/C/D 仅由 A 派发）"
  agent: lead-miner
  skills: [data-particle-read]
  memory: [lead-miner]
  knowledge_scope: { layers: [L1, L2], max_hops: 3 }
  success: "派发链路：任务先进 A，分级后写 payload.contract_task_id + 目标 agent"

- task: "D 评审把关写全 3 基线 + 内置四维审查"
  agent: crm-copilot
  skills: [data-particle-read]
  memory: [crm-copilot]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "review-gate 可对重大商机执行报价复核/合同确认，四维审查输出留痕"

- task: "旧 3 agent（crm-copilot/deal-coach/lead-miner）降级为被调用 skill/tool"
  agent: deal-coach
  skills: [data-particle-read]
  memory: [deal-coach, crm-copilot]
  knowledge_scope: { layers: [L1, L2], max_hops: 3 }
  success: "agentSpec.js 无旧 3 独立注册；旧 action 由新 4 角色 skillCalls 引用"

- task: "契约矩阵重写为 4 agent（默认契约文档 4 行）"
  agent: lead-miner
  skills: [data-particle-read]
  memory: [lead-miner]
  knowledge_scope: { layers: [L1, L2], max_hops: 3 }
  success: "GET /api/agent-monitor 返回 4 行矩阵，每行带标记按钮"
```

**契约说明：** 6 条任务契约覆盖名册重建 / SKILL 落位 / 派发闭合 / D 基线 / 旧 3 降级 / 矩阵更新；每条 `agent` 解析到注册表 key、`skill ⊆ agent.skillCalls`、`knowledge_scope.layers ⊆ agent.knowledgeScope.layers`；执行 agent 由对应 skillCalls 承载（crm-copilot/deal-coach/lead-miner 作为本次实现期的执行体，落位后由新 4 角色承接）。

**注：** 本次 6 条契约的执行 agent 复用旧 3 个 keys 作为**实现期执行体**（架构变更期间的过渡），新 4 个注册表 keys 落位后矩阵改为 4 行、契约以 4 个新 keys 为准——这是"执行体过渡"与"目标名册"的分离，避免先有鸡还是先有蛋。

## §B 闭环机制（workbench ↔ brainstorming）

- 4 agent 名册落位后，`/api/page/agent-workbench` 契约矩阵展示 4 行；
- 每次 agent 运行写 `monitor_event`（含 `contract_task_id`/`skill`/`knowledge_layers_read`）；
- 任一维度不达标 → `feedbackStore` 落库 + 镜像 `<doc>.feedback.json`；
- 复现≥2 次 → `aggregate-feedback.mjs` 产出需批准提案（P0 吸收）。

## §C 验证计划

### C.1 契约自检（P7）

```bash
node scripts/validate-contract.mjs docs/specs/2026-08-29-agent-roster-4-agent-design.md --registry src/agent/agentSpec.js
```
退出码 0 = 有效（结构 + 注册表交叉校验）。

### C.2 端到端验证

1. `npm run migrate` + `PGDATABASE=plm_test node db/migrate.js`（幂等建表/加列）
2. `npm test` 全量回归
3. `node scripts/demo-contract-loop.mjs`（无 DB 闭环演示）
4. `npm run dev` + `curl /api/agent-monitor`（矩阵 4 行）
5. 浏览器 `/agent-workbench.html`（三层验证法：渲染纯函数 → 端点契约 → 真浏览器）

## 闭环回写

（本设计执行后由 workbench 监控回写，P0 下一轮吸收）