# 决策事件主轴总体设计（spec · 顶层逻辑）

- 日期：2026-08-25
- 状态：设计稿（经 brainstorming 流程逐节确认方向，待用户评审后进入 writing-plans）
- 方法论依据：本 spec 不新增 ai-* 能力，仅把既有 10 大能力重新赋予「服务决策流」的职责，并新增 DECISION 粒子族 + decision 事件域作为决策主轴。10 大能力基线固定不变（用户硬规则）。
- 业务基线：§5ter（19 小节业务全景）+ §5ter-quater（Q.19 理念差异 / Q.20 能力×业务输入）+ §5quater（印刷行业痛点 / B2B 决策逻辑）+ 总体架构设计（四平面）。
- 前置：本 spec 修订/补充 `2026-08-25-ai-native-crm-overall-design.md`（总体架构）的 §1/§3/§4/§5，以及 01/04/05/07/08/09/10 共 7 份能力设计文档的对应小节。

---

## 0. 核心立场

**决策事件是本系统的首要主轴（top-level spine）。** 一切业务写操作都前置/关联一个决策事件；四平面架构被重新定义为「服务决策流」；"确保 agent 可以自主运行" 是系统的终极目的，由「业务分级 + 先例置信门控 + 决策全审计 + 监控兜底」四件机制共同保障。

CRM 关键判别：现有四平面架构以「数据/粒子」为事实源主轴，决策是隐式的（散落在 approval-flow + action-confirm + 审计日志）。本设计把决策提升为与粒子并列的「判断源」主轴——粒子回答"事实是什么"，决策回答"为什么这样判、依据哪版政策、参考了哪些先例"。两者正交、互相引用，决策主轴垂直贯穿 L1–L4。

---

## 1. 决策事件 Schema（用户 7 点 → 形式化）

一个决策事件 = 一次「需要拍板」的完整记录。它不是 "批准/拒绝" 两个字，而是包含 7 类信息的可审计、可复现、可沉淀为先例的对象。物化为 L1 的 `decision` 粒子，并在 L2 发出 `decision_*` 事件。

| 字段 | 对应 7 点 | 类型 / 取值 | 说明 |
|---|---|---|---|
| `decision_id` | — | UUID | 唯一 ID |
| `scenario_id` | ①业务情境触发 | FK→`decision_scenario` | 决策场景类型（如 `CONTRACT_AMOUNT_CHANGE` / `OPP_STAGE_ROLLBACK` / `DISCOUNT_OVER` / `PAYMENT_OVERDUE` / `QUOTE_MARGIN_BELOW`）。场景 = 一类"走到需要拍板"的情境 |
| `trigger_context` | ①为什么走到拍板 | JSON + text | 触发前的业务状态快照（哪个商机、金额改了多少、谁发起），保证可复现当时的情境 |
| `involved_entities` | ②涉及了谁 | `[{type, id}]` | 类型化引用：`customer_id` / `opportunity_id` / `contract_id` / `policy_id` / `role_id`（岗位）。支持本体边 `decision --decided_on--> entity` |
| `conditions_evaluated` | ③条件满足/不满足 | `[{cond, met:bool, value, expected}]` | 哪些条件符合、哪些不符合（结构化，便于先例匹配与审计） |
| `effective_policy_version` | ④当时生效政策版本 | FK→`policy_version` | **记决策当时生效的版本，非当前版本**。政策会变，决策必须锚定当时版本以保证可复现 |
| `disposition` | ⑤最终怎么处理 | ENUM | `APPROVE` / `REJECT` / `ESCALATE` / `OVERRIDE` / `EXCEPTION`（例外放行）五态 |
| `decider` | ⑥谁做的决定 | `{decider_type: AUTONOMOUS_AGENT\|HUMAN, decider_id, role}` | 拍板主体——agent 还是人。自主运行的关键落点 |
| `rationale` | ⑥真实理由 | text | 拍板真实理由（非话术）。与 `conditions_evaluated` 互为印证 |
| `referenced_precedents` | ⑦参考过往先例 | `[decision_id]` | 本决策站在哪些历史判断上。本体边 `decision --referenced_precedent--> decision` |
| `business_tier` | 派生 | ENUM | DEAL 高中低，由 `customer维 × project维` 配置计算（详见 §3.3）。驱动自主/升级判定 |
| `created_at` / `outcome` / `feedback_link` | 闭环 | ts / ENUM / FK | 决策后续（是否被推翻、客户反馈、对应 feedback 指标），喂反馈回路 |

**Schema 铁律**：
- `effective_policy_version` 必须指向不可变快照，禁止存 "当前版本号"。
- `referenced_precedents` 与 `rationale` 是自主决策的强制字段（agent 自主拍板时必须填先例引用与理由，否则降级 HITL）。
- `disposition=EXCEPTION`（例外放行）必须带 `rationale` + 上级 `role` 背书，且强制进审计高亮。

---

## 2. DECISION 粒子族与知识落点（用户第 2 问）

### 2.1 L1 粒子平面新增 DECISION 粒子族

| 粒子 | 状态机 / 关键属性 | 关联 |
|---|---|---|
| `decision` | 字段见 §1；状态：`REQUIRED`→`AUTONOMOUS`/`HUMAN`→`CONFIRMED`/`REVERSED` | 本体边 decided_on / referenced_precedent / governed_by |
| `decision_scenario` | 场景类型 + 检测器配置（什么业务状态→触发 `decision_required`）；绑 `business_tier` 默认策略 | 触发源 |
| `policy_version` | 不可变政策快照；每次政策变更→新版本（`version`, `effective_from`, `snapshot`） | 被 decision 引用 |
| `precedent`（逻辑视图） | 非独立粒子，是 `decision` 经写时向量化后形成的可检索先例集合 | 见 §2.3 |

### 2.2 本体边（Apache AGE 图）

```
(decision)-[:DECIDED_ON]->(entity)          // 决策作用于哪个业务对象
(decision)-[:REFERENCED_PRECEDENT]->(decision)  // 决策参考的过往先例
(decision)-[:GOVERNED_BY]->(policy_version)  // 决策锚定的当时政策版本
(decision_scenario)-[:TRIGGERS]->(decision)  // 场景→决策
```

### 2.3 知识落点（记忆 / 先例）

- `ai-memory-lifecycle`：每个 `decision` 写入即成为「先例」——存入先例库，写时向量化（context 摘要 + disposition + conditions 嵌入）。后续自主决策通过语义检索拉取高置信先例。
- 这是 "agent 自主运行" 的知识底座：agent 不是凭空决策，而是 "站在历史判断上"（对应 7 点之⑦）。
- 先例衰减：低频/被推翻的先例降权（30 天蒸馏，见 05 记忆设计）。

### 2.4 审计落点

- `ai-capability-audit`：每个 `decision` 事件全量进审计——无「无声决策」。
- 外部智能体免登录调用 SKILL 产生的决策同样进审计（§6.4 Skills-as-a-Service）。

### 2.5 反馈落点

- `ai-feedback-loop`：`decision.outcome`（被推翻/客户反馈/成单率）喂决策质量指标，per-tier 统计自主率/升级率/推翻率。

---

## 3. 决策主轴 × 四平面重排（用户第 3 问 · 架构调整）

四平面骨架保留（复用 PDM/P2P 底座），但每平面职责被重新定义为「服务决策流」，并新增一条垂直决策主轴。

### 3.1 L1 粒子平面（事实源 + 判断源）

- 业务粒子（lead/account/opportunity/...）保持 §3.1 不变。
- 新增 DECISION 粒子族（§2.1）。
- 不变量升级：一切业务粒子的**关键状态变更**都有 `decision` 粒子指向（`decided_on` 边）。

### 3.2 L2 事件平面（横切接线 + decision 域）

- 原 5 域（task/trace/approval/particle/payment）保持。
- 新增 **`decision` 事件域**：
  - `decision_required`（scenario 检测器产出）
  - `decision_autonomous`（agent 自主拍板）
  - `decision_made`（人拍板）
  - `decision_escalated`（升级 HITL）
  - `decision_reversed`（被推翻，喂反馈）
- 写操作钩子：一切业务写 → 先 produce `decision_*` → 再走既有事件广播。

### 3.3 L3 智能体平面（执行 + 自主决策引擎）

- agentLoop + kanban 保持。
- 新增 **自主决策引擎（autonomy engine）**，职责：
  1. 接收 `decision_required`，读取 `business_tier`（来自配置）。
  2. `business_tier` 计算：**DEAL = f(customer维, project维)**，分级高中低，分级规则在配置中定义（非硬编码）。
  3. 门控：低风险 + 存在高置信先例 → `decision_autonomous`（agent 拍板，填 `referenced_precedents`+`rationale`）；高风险 / 无先例 → `decision_escalated`（HITL）。
- 引擎 consult 先例库（§2.3）做语义检索 + 置信度判定。

### 3.4 L4 门户平面（呈现 + 决策治理）

- 新增**决策视图**：决策流时间线、先例查阅、场景→决策追溯。
- §3.10 监控台升级为 **「决策质量监控」**：per-tier 自主率 / 升级率 / 推翻率 / 平均决策时延；可 drill 到单决策（含 7 点全字段 + 引用先例 + 当时政策版本）。
- 业务分级配置界面（DEAL=customer×project）作为 L4 治理配置的一部分（呼应 `ai-context-layering` 治理决策层）。

### 3.5 写通道第 0 闸（架构关键不变量）

```
【写通道 · Write Path】显式过闸（加第 0 闸）
请求（人/智能体/外部连接器）
  → [第 0 闸] decision_id 校验：本次写必须关联一个已存在的 decision（无决策不写）
  → 上下文分层注入（角色权限边界）
  → 规则层（business-rules）
  → action-confirm
  → HITL 审批流（本身也是 decision）
  → 粒子写通道（事务写入 + 触发 decision_* 事件 + 业务粒子写事件）
  → 写后验证 → 返回
```

**第 0 闸含义**：审批流（HITL）本身就是一次 `decision`（disposition=APPROVE/REJECT，decider=HUMAN）。自动低风险写则由自主决策引擎产出 `decision_autonomous`。任何写操作都不能脱离决策主轴。

---

## 4. 闭环与自主运行（顶层逻辑）

```
决策场景(业务分级触发: DEAL = customer维 × project维, 配置定义)
  → scenario 检测器 → decision_required 事件
  → 自主决策引擎
       ├─ 低风险 + 高置信先例 → decision_autonomous（agent 拍板, 记 decision_id + precedents + rationale）
       └─ 高风险 / 无先例     → decision_escalated（HITL 人拍板）
  → 决策事件(§1 七点丰富捕获, 含 effective_policy_version + referenced_precedents)
  → 物化 DECISION 粒子 + 写时向量(先例) + audit + feedback
  → 系统蓝图(本文档 + 总体架构设计: 总体架构围绕决策主轴设计)   ← 用户明确：此节点=系统实施的蓝图分析，非业务决策点
  → 运行监控(§3.10 / §3.4 决策质量监控, per-tier)
  → 自主运行(低分级 agent 借先例自主拍板; 高分级升级 HITL)
  → (新场景持续产生…)
```

**自主运行保障（四件机制共同成立）**：
1. **业务分级配置**（DEAL=客户维×项目维，配置定义）——决定哪些可自主。
2. **先例置信门控**（§2.3 / §3.3）——无高置信先例则升级，杜绝 "瞎自主"。
3. **决策全审计**（§2.4）——任何决策可追溯、可复现当时政策版本。
4. **监控兜底**（§3.4）——per-tier 推翻率异常自动收紧自主范围。

---

## 5. 对既有 11 份设计文档的改动影响

| 文档 | 改动 |
|---|---|
| 总体架构设计 `2026-08-25-ai-native-crm-overall-design.md` | §1 四平面图加「决策主轴垂直贯穿」；§3 粒子域加 DECISION 族（§2.1）；§4 写通道加第 0 闸（§3.5）；§5 跨平面事件流加 decision 域（§3.2） |
| 01 `ai-particle-system-design` | 加 DECISION 粒子族 Schema + 本体边（§2.1/§2.2） |
| 04 `ai-context-layering` | 业务分级配置（DEAL=customer×project）作为 L4 治理配置（§3.3/§3.4） |
| 05 `ai-memory-lifecycle` | 决策=先例的写时向量化与语义检索（§2.3） |
| 07 `ai-event-driven-evolution` | 加 decision 事件域 + scenario 检测器（§3.2）；决策积累→政策演化 |
| 08 `ai-portal-page-generation` | 加决策视图 + §3.10 监控台升级为决策质量监控（§3.4） |
| 09 `ai-feedback-loop` | 加决策质量 per-tier 指标（自主率/升级率/推翻率）（§2.5） |
| 10 `ai-capability-audit` | 决策全量审计（§2.4） |

> 02/03/06 三份在决策主轴下仅做引用级挂点说明，无需结构性改动。

---

## 6. 验收判据

- [ ] `decision` 粒子 Schema 含 §1 全部 13 字段；`effective_policy_version` 指向不可变快照（非当前版本）。
- [ ] 一切业务写操作（含 HITL 审批通过）都关联 `decision_id`，无 decision_id 的写被第 0 闸拒绝（无「无声写入/无声决策」）。
- [ ] L2 事件总线含 `decision` 域，5 类事件（`required`/`autonomous`/`made`/`escalated`/`reversed`）可观测。
- [ ] 自主决策引擎按 `business_tier=DEAL(customer×project 配置)` 判自主/升级；低风险+高置信先例→自主，否则升级。
- [ ] agent 自主拍板的决策强制带 `referenced_precedents` + `rationale`，否则降级 HITL。
- [ ] 每个决策进审计；决策质量监控（§3.10）可 drill 到单决策七点全字段 + 当时政策版本 + 引用先例。
- [ ] 10 大 ai-* 能力基线未新增/未删除/未重编号（仅各自增加决策挂点）。

---

## 7. 不做的事（YAGNI / 边界）

- **不新增第 11 个 ai-* 能力**：决策主轴是既有 10 能力的重新职责分配 + DECISION 粒子族/事件域，不突破能力基线（用户硬规则）。
- **不引入图/语义推理引擎（Semantica 类）**：先例检索走既有 pgvector + AGE，零额外依赖（呼应 §3.10 监控台禁令）。
- **不把 "系统规划设计" 节点误解为业务决策点**：该节点 = 系统实施蓝图本身（本 spec + 总体架构），不是又一个需拍板的业务决策。
- **不硬编码业务分级**：DEAL 高中低的分级维度与阈值在配置中定义，引擎只读配置。

---

## 8. 与 10 大 ai-* 能力基线关系

本设计在所有能力上**仅增挂点、不改基线**：

| 能力 | 决策主轴下的新增挂点 |
|---|---|
| ai-particle-system-design | DECISION 粒子族 + 本体边 |
| ai-ontology-vector-build | 决策写时向量（先例嵌入）+ 政策版本边 |
| ai-context-layering | 业务分级配置（DEAL=c×p）为 L4 治理配置 |
| ai-memory-lifecycle | 决策=先例的向量化与检索 |
| ai-native-action-design | 写 Action 强制携带 decision_id（第 0 闸） |
| ai-multi-agent-orchestration | 自主决策引擎（autonomy engine） |
| ai-event-driven-evolution | decision 事件域 + scenario 检测器 + 决策积累→政策演化 |
| ai-portal-page-generation | 决策视图 + 决策质量监控 |
| ai-feedback-loop | 决策质量 per-tier 指标 |
| ai-capability-audit | 决策全量审计 |

10 大能力清单、编号、排序**不变**。
