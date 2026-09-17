# 智能体架构对齐分析 · 4 愿景 vs 3 实现

> 日期：2026-08-29
> 触发：用户截图所示「4 智能体（A 接诊分流 / B 报价测算 / C 跟进催办 / D 评审把关）」与代码 `agentSpec.js` 实际注册的 3 个 agent 数量/命名不一致。
> 范围：现状取证 + 当初设计考量 + 对齐方案（**纯分析，不含实现代码**；实现需走 brainstorming→writing-plans→executing-plans）。

---

## §0 结论（先讲重点）

- 截图来源 `doc/sales-platform-features.html` 是**静态产品展示页**，4 个智能体卡片与对话脚本均为**手工写死的演示文案**，不运行任何真实 agent。
- 真实运行底座 `src/agent/agentSpec.js` 注册 **3 个 agent**（crm-copilot / deal-coach / lead-miner），命名体系与展示页完全不同。
- 数量 4→3 是**有意的范围收敛**（设计文档已声明「第 4 个智能体身份待确认」），不是 bug；但**两套命名从未对齐**，导致「监控 4 个智能体」的需求与「3 个旧名 agent」的实现在语义上错位。
- 契约闭环（本次 brainstorming redesign 的核心产出）只覆盖 3 个中已写契约的 **2 个**（crm-copilot / deal-coach），lead-miner 与全部 4 个愿景 agent 均未纳入。

---

## §1 平台目前怎么落地的（三层证据）

### 1.1 展示层：4 个愿景智能体（静态，非运行）
- 文件：`doc/sales-platform-features.html`（及 `doc/印刷/` 副本）。
- 结构：4 Tab（① 谁来干 / ② 干什么·7 决策 / ③ 干的放心 / ④ 越干越好）+ 4 个 agent 卡片（A/B/C/D）+ 3 个商机级别（L1/L2/L3）。
- 对话内容：`AGENTS`、`CASES`、`DECISIONS`、`ROLES` 等 JS 常量里是**硬编码字符串**（如 `['ai','智能体 A（接诊分流）：已识别一般商机…']`），点击按钮直接 `playChat` 渲染，**无任何 fetch / 无 agent 后端调用**。
- 定位：WorkBuddy 技能市场「企业AI销售决策专家」专家包宣传册，属**愿景/卖点素材**，非系统组成部分。

### 1.2 注册层：3 个真实 agent（代码）
- 文件：`src/agent/agentSpec.js:1` 注释「3 Agent 六段式」，第 3–40 行定义 3 个 key：
  | key | derivedFrom | 职责（capabilities 概括） |
  |---|---|---|
  | `crm-copilot` | crm-nl-to-action | NL→Action，data-particle 读写 |
  | `deal-coach` | crm-deal-advance-advice | 商机推进建议，读 L1/L2 |
  | `lead-miner` | crm-intelligence-mining | 情报挖掘，读 L1/L2 |
- 派发：`src/kanban/scheduler.js:29-39` `dispatchOne` → `runWithSkill(task, ctx)`，ctx 注入 `contractTask`（接线已通但无派发侧填充）。
- 执行：`src/agent/agentLoop.js` 真实调 `getSkill/executeSkill` + `assembleContext` + `getLlmThink` + `recordEpisode`，写入 `monitor_event`。

### 1.3 监控层：契约闭环（部分覆盖）
- 解析：`src/agent/contractMonitor.js` `parseContractsFromDoc` + `judgeContract`（三维度 skill/memory/success）。
- 回写：`src/agent/feedbackStore.js` `upsertFeedback` / `markSuccess`。
- 端点：`src/http/routes.js:525` `GET /api/page/agent-workbench` 注入 `matrixRows`；`POST /api/agent-monitor/success` 人工标记。
- 页面：`src/web/agent-workbench.html` 渲染 S03 schema（goal-form + reasoning-trace + result-card + table + **contract-matrix** + attr-field）。
- 覆盖度：契约文档 `docs/specs/2026-08-29-agent-workbench-contract-monitor-design.md` 仅含 **crm-copilot / deal-coach** 的 contract-yaml 块 → 矩阵只出现这 2 个 agent 的行。

### 1.4 三层对照表
```
展示层(静态)：  A 接诊分流 / B 报价测算 / C 跟进催办 / D 评审把关        ← 4 个（手写脚本）
注册层(代码)：  crm-copilot / deal-coach / lead-miner                     ← 3 个（旧名）
监控层(契约)：  crm-copilot / deal-coach                                 ← 2 个（有契约）
```

---

## §2 当初怎么考虑的（设计溯源）

1. **展示页先于工程**。4 agent 愿景是产品/市场视角（按业务角色分：谁接诊/谁报价/谁跟进/谁评审），写在专家包宣传册，用于售卖「企业AI销售决策专家」概念。
2. **工程走能力视角**。底座 `agentSpec.js` 按**能力**而非业务角色拆 3 个 agent（NL 转动作 / 商机建议 / 情报挖掘），服务于「闭环监控」这一具体目标（brainstorming redesign 的初衷是「监控 4 个智能体运行效果」）。
3. **第 4 个被显式推迟**。设计文档 `docs/specs/2026-08-29-brainstorming-redesign-design.md:194` 明写：「第 4 个智能体身份待确认（当前 agentSpec.js 为 3 个；契约 agent 字段参数化，新增即生效，无需改 skill）」。另一文档 `agent-workbench-contract-consumer-design.md:156` 曾提议第 4 个为 `crm-workbench`（承载契约消费），但 `:17` 列「不在本计划范围」。
4. **命名体系从未统一**。展示页用 A/B/C/D + 业务角色名；代码用 crm-/deal-/lead- + 能力名。两者无映射表，导致「4 vs 3」的观感错位。
5. **展示页对话是假的**。所有对话脚本为 `['user'/'ai'/'sys', '...']` 字符串，从未连接 LLM/SKILL——即「4 个智能体真正调用 SKILL/记忆」在展示页里只是**编剧文案**，不是运行证据。

---

## §3 关键缺口（闭环比对）

| 缺口 | 影响 | 严重度 |
|---|---|---|
| 展示页 4 agent 与代码 3 agent 命名/数量错位 | 用户以为有 4 个在跑，实际 3 个且无对应业务角色 | 高（认知偏差） |
| 展示页对话为静态脚本，无真实 agent 后端 | 截图里的"智能体对话"是编剧，不是系统能力 | 高（误导性） |
| 契约监控仅覆盖 2/3 个已注册 agent（lead-miner 缺失） | 矩阵不完整 | 中 |
| kanban task `payload.contract_task_id` 无派发侧填充 | 真实 episode 的 contract_task_id 恒 null，不进矩阵 | 中（冷启动无数据） |
| 4 个愿景 agent（A/B/C/D）在代码中零实体 | 无法被监控/调度 | 高（需求未落地） |

---

## §4 对齐方案（三选一 + 推荐）

### 方案 A：以愿景为纲，把 4 个 agent 落成真架构（重）
- 将 `agentSpec.js` 从 3 个能力 agent 重构为 4 个业务角色 agent（A 接诊分流 / B 报价测算 / C 跟进催办 / D 评审把关），每個绑定 skillCalls / knowledgeScope / 审批闸门。
- 在契约文档为 4 个各写 contract-yaml，矩阵自动出 4 行。
- 优点：与展示页、与「监控 4 个智能体」需求完全对齐。
- 代价：需重写 agentSpec + 调整 scheduler 路由（A 接诊分流本质是意图路由器，B/C/D 需真实 SKILL 支撑），工作量大、需先定义每个 agent 的 SKILL 与数据面。

### 方案 B：以工程为实，让展示页对齐全（轻）
- 不改 `agentSpec.js`，仅把 `doc/sales-platform-features.html` 的 4 agent 改为映射/说明：明确标注「以下为愿景示意，当前已落地 crm-copilot/deal-coach/lead-miner」；或把展示页对话改为读取真实 `/api/agent-monitor` 数据。
- 优点：零架构改动，诚实呈现现状。
- 代价：展示页仍不是"真在跑"，只是不再误导；未满足「4 个监控」诉求。

### 方案 C（推荐）：双轨对齐，先诚实后落地
**短期（诚实化 + 补齐监控）**
1. 展示页顶部加一行声明：「本页为产品愿景示意，对话为演示脚本；真实运行见 `/agent-workbench.html`」。
2. 在契约文档为 `lead-miner` 补 contract-yaml，使矩阵覆盖 3/3 已注册 agent。
3. 实现 kanban task `payload.contract_task_id` 的派发侧填充（映射表或 task 创建时写入），让真实 episode 进矩阵。

**中期（把 4 愿景 agent 落为编排角色，而非新底座）**
4. 不新增 agent 底座，而是引入 **意图路由层**：A 接诊分流 = scheduler 的意图识别→派活；B/C/D = 在现有 3 能力 agent 之上加一层「业务角色门面」，每个角色映射到一组 action/skill（B→报价相关 action，C→跟进催办 action，D→评审/审批流程）。
5. 为 4 个业务角色各写契约，监控层按业务角色而非底层 agent key 统计——这样「监控 4 个智能体」在监控语义上成立，而底座仍是能力 agent。

**长期（可选）**
6. 若某业务角色（如 D 评审把关）需要独立 LLM 人格与记忆，再将其从门面升级为独立 `agentSpec` key（届时 3→4 自然发生，且不破坏现有闭环）。

---

## §5 推荐落地路径（分阶段，每步可独立验收）

| 阶段 | 动作 | 验收口径 | 是否改 skill |
|---|---|---|---|
| P1 诚实化 | 展示页加声明 + 对话标注"演示" | 打开页面可见免责说明 | 否 |
| P2 监控补全 | lead-miner 补契约 + 派发填充 contract_task_id | `GET /api/agent-monitor` 出现 3 行且真实 episode 命中 | 否（参数化生效） |
| P3 角色门面 | 意图路由 + B/C/D 业务角色映射（门面层） | 4 角色各有契约行、监控语义成立 | 否（契约 agent 字段参数化） |
| P4 独立化(可选) | D 评审把关升级为独立 agentSpec key | 4 agent 真实可调度、可监控 | 是（需 brainstorming） |

---

## §6 给用户的决策点

- 选 A / B / C？
- 若选 C：P1–P3 是否现在启动？P4 是否纳入本期？
- 4 个愿景 agent 中，**A 接诊分流**本质是调度器职责（非独立 agent），**D 评审把关**最接近可独立成体的治理 agent——这两点会影响 P3/P4 的边界划分。

> 注：本文件为分析+方案，未含实现代码。任何实现动作须先走 brainstorming 批准，再 writing-plans。
