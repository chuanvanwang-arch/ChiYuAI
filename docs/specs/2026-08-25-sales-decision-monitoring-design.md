# 销售 7 大决策闭环监控 — 设计文档

> 版本：v1.0 · 日期：2026-08-25 · 归属：CRM-ai-native（AI 原生 CRM，基于 Gitea）
> 前置：`2B-sales-field-7dim-master.html`（18 决策点七维字段归类）、`2B-sales-vs-attio-compare.html`（ATTIO 比对）、`4.1/4.2`（元模型映射与三向放置）
> 代码锚点：`src/particles/particleModel.js`、`src/decision/decisionRepo.js`、`src/decision/autonomyEngine.js`、`src/events/bus.js`、`src/context/assembler.js`、`src/http/routes.js`

---

## §0 背景与目标

销售 7 大决策（阶段闸门 D1–D7）的闭环监控：**输入（7 维数据）→ 决策层（autonomyEngine）→ 输出（disposition/decision_id）→ 埋点回写（event bus）→ 监控台（聚合展示）→ 反哺（先例/状态/策略）**。

本设计的核心主张：**不新建一套决策系统，而是在现有决策层上做"配置预定义 + 埋点采集 + 监控视图"三层增量**。现有决策层（`requireDecision`）已消费 `decision_scenario` 配置表和 `methodology_dimension` 条件表——7 大决策的正确做法是**预注册 7 行 scenario**，而非写代码分支。

---

## §1 现状审计（Q1 答案：库里有哪些粒子、哪些该拿出来、元模型是否实现）

### 1.1 现有粒子清单（`particleModel.js` PARTICLE_TYPES，硬编码 const，9 个真粒子）

| # | 粒子 | 说明 | 承载的 ATTIO/七维能力 |
|---|---|---|---|
| 1 | `CRM_DEAL` 交易 | 状态流 `lead→opportunity→quoted→contracted→ordered→paid→lost→disqualified` | ⑦ 单链状态机（见 1.3 争议点） |
| 2 | `CRM_ACCOUNT` 客户 | ATTIO A 桶 firmographics + D 桶 key_contact/champion_strength | ①/②/③ 局部 |
| 3 | `CRM_CONTACT` 联系人 | ATTIO B 桶 enrichment + relationship_strength | ②/⑥ 局部 |
| 4 | `CRM_PRODUCT` 产品 | price_change_reason | ③ |
| 5 | `CRM_PRICE_LIST` 价格表 | — | ③ |
| 6 | `CRM_PERSON` 员工/操作人 | — | ⑦ 执行人 |
| 7 | `CRM_ORGANIZATION` 组织 | pool_rule_reason | ② |
| 8 | `CRM_KNOWLEDGE` 知识/词表 | — | ③ 语义层 |
| 9 | `CRM_UNSTRUCTURED_ASSET` 非结构化证据 | — | ⑥ 证据 |

### 1.2 决策层实体（不在 PARTICLE_TYPES，但在 `decision` 表）

`decision` / `decision_event` / `decision_precedent_rel` —— 即 §4.2 的 **C 层 + DECISION 对象**，已用 `createDecision` / `searchPrecedents` / `confirmDecision` / `reverseDecision` / `distillPrecedents` 实现。

### 1.3 哪些应"拿出来变成第 2 类"（元模型驱动新粒子类型）— 3 处待拍板

- **(1) `CRM_DEAL` 把 7 阶段压成一个粒子的状态流**，而非 §4.2 建议的"各自独立粒子类型"。按 §4.2 判别三问（独立生命周期/被多决策引用/需检索关联），Lead/Opportunity/Quote/Contract/Delivery/Payment/Renewal 更像独立实体。但"状态机建模"也是合理替代——**这是已确认的设计岔路**（本设计按"7 闸门为决策单元 + CRM_DEAL 状态流保留"落地，二者兼容）。
- **(2) `why:` 字段把决策历史（⑤）建模成粒子属性**，正是 §4.2 警示的反模式。决策层已有 `rationale` 承载 ⑤，二者冗余。建议：把"为何变"从粒子属性移交给 DECISION 对象（已是 C 层），粒子只保留 `transitionedBecause` 受控谓词边。
- **(3) DECISION 当前不是 `PARTICLE_TYPES` 成员**，是 decision 表独立实体。按 §4.2 它属 B（首类对象）。是否纳入粒子注册表（享受七维/向量/事件统一通道）是选择。
- **缺失的 B 类粒子**：`RTM` 需求追溯矩阵快照、`Gate/Review` 闸门评审。若销售决策要闭环到"需求-评审"，这两个该补为 B。

### 1.4 元模型是否实现 — 部分实现

- ✅ **Schema 层已元模型化**：`ATTRIBUTE_TYPE_SET`（19 类型有穷集）、`CONTROLLED_PREDICATES`（受控谓词、拒绝裸外键）、`validateCoreAttributesSchema()` 启动校验、`coreAttributes` 类型约束 —— 对应 §4.1 的"字段元模型"。
- ❌ **类型注册表未运行时化**：`PARTICLE_TYPES` 是硬编码 JS const，新增粒子类型需改代码+重启，**不满足 §4.1「新对象按配置长出来」**。
- **反例榜样**：`decision_scenario` 已是配置表（见 §3，本设计直接复用）。
- **结论**：元数据"schema 已元模型化，类型注册表未运行时化"。要达 §4.1，须把 `PARTICLE_TYPES` 迁到 DB-backed 注册表（`particle_type` 表 + 属性迁移），让新粒子类型按配置生长。

---

## §2 整体平台规划（Q2 答案：如何实现销售 7 大决策闭环监控）

### 2.1 决策单元：7 阶段闸门（已确认范围）

把闭环监控单元锁定为**每阶段 1 个闸门决策**，与原始文档的 7 阶段一一对应：

| # | 阶段 | 闸门决策 | 最易缺的维度（来自上轮分析） |
|---|---|---|---|
| D1 | 线索 | 跟进 / 升级 / 放弃 | ①Identity、⑦Governance |
| D2 | 商机 | 需求确认 / 方案匹配 | ③Semantics、②Structure |
| D3 | 商务 | 报价 / 折扣授权 | ⑦Governance、④Time |
| D4 | 签约 | 合同条款 / 签约 | ⑦Governance |
| D5 | 交付 | 交付 / 验收 | ⑥State、⑤History |
| D6 | 回款 | 回款 / 账期 | ④Time、⑦Governance |
| D7 | 续约 | 续约 / 增购 / 流失 | ④Time、⑤History |

### 2.2 闭环架构（复用现有模块，三段式增量）

```
输入（7维数据）         决策层 C                输出（结果）            监控台
┌──────────────┐   ┌──────────────────┐   ┌──────────────┐   ┌──────────────────┐
│ ATTIO 粒子    │   │ decision_scenario │   │ disposition   │   │ 7维完整度 / 自主率 │
│ 事件总线       │ → │ + methodology_dim │ → │ + decision_id │ → │ 置信度/结果实现率 │
│ 决策层(先例)   │   │ autonomyEngine    │   │               │   │ 先例复用/推翻率   │
└──────────────┘   └──────────────────┘   └──────────────┘   └──────────────────┘
        ↑ 反馈回灌（先例/状态/策略） ←──────────────────────────────────────┘
```

### 2.3 三段式增量（不改核心，只加配置 + 埋点 + 视图）

| 增量 | 内容 | 落点 |
|---|---|---|
| ① 配置预定义 | 预注册 7 行 `decision_scenario` + 每组 `methodology_dimension` 条件 | §3 详见 |
| ② 埋点采集 | 三个既有出口 emit + 监控持久化订阅落库 | §4 详见 |
| ③ 监控视图 | 销售决策监控台（7 闸门看板 + 钻取） | §5 详见 |

---

## §3 平台架构中的配置预定义（Q3 答案：需要，且已有现成落点）

### 3.1 核心主张

7 大决策的闭环监控**不需要写代码分支**——现有决策层已消费 `decision_scenario` 配置表 + `methodology_dimension` 条件表（`autonomyEngine.js:45-47`、`autonomyEngine.js:19-20`）。正确做法是**配置预定义**。

### 3.2 预注册内容（7 行 scenario + 条件维度）

| scenario_id | 阶段闸门 | methodology_dimension 条件（即"该决策要求的 7 维"） |
|---|---|---|
| D1 | 线索跟进 | CRM 主体查重(①)、线索分级审批权限(⑦)、真实痛点(③)、明确时间计划(④) |
| D2 | 商机确认 | 决策链结构(②)、需求语义对齐(③)、标杆先例(⑤) |
| D3 | 商务报价 | 报价红线(⑦)、折扣授权(⑦)、预算时间窗(④) |
| D4 | 签约 | 合同条款红线(⑦)、法务校验(⑦) |
| D5 | 交付 | 交付负荷(⑥)、同型先例(⑤)、验收口径(③) |
| D6 | 回款 | 账期红线(⑦)、回款时间窗(④) |
| D7 | 续约 | 续约价红线(⑦)、流失先例(⑤)、未来预算窗(④) |

### 3.3 与上轮"最致命缺口"的封堵对应

- D1 的 `CRM 主体查重`（①）`线索分级审批权限`（⑦）→ `methodology_dimension` 条件行
- 各决策的时间窗（④）→ 条件行（`met=null` 时引擎自动 escalated，不脑补）
- **关键机制**：条件 `met=null`（未提供）→ 引擎自动 `escalated`（`autonomyEngine.js:74`）→ 闭环闸门由此成立

### 3.4 `decision_scenario` 是配置表（§4.1 运行时化的榜样）

`decision_scenario` 已是 DB 配置表，不是硬编码代码。这正是 §4.1「新对象按配置长出来」应该效仿的榜样——`PARTICLE_TYPES` 迁移目标也可参照此模式。

---

## §4 数据埋点采集方案（Q4 答案：埋点采集 + 零侵入）

### 4.1 采集出口（三个既有 emit 点，零业务代码改动）

| 出口 | 事件域 | 事件类型 | 代码锚点 |
|---|---|---|---|
| 决策层 | `decision` | `required` / `autonomous` / `escalated` / `made` | `decisionRepo.js:84`、`autonomyEngine.js:49/92/112` |
| 决策事件 | `decision` | `confirmed` / `reversed` | `decisionRepo.js:159/173` |
| 粒子层 | `particle` | 写时三钩子 | `particleRepo.js` |
| 动作层 | `action` | `action-confirm` | `executor.js` |
| SSE | `events` | 单连接 5 域 | `routes.js:125` |

### 4.2 监控持久化订阅（新增，唯一新增组件）

在 `bus.on('*')` 增加"监控持久化订阅"，把以上事件落库到监控存储（决策/事件/粒子快照），供监控台读。**订阅者异常隔离**（`bus.js:6-40`）保证不阻断业务写路径。

### 4.3 采集链路（闭环成立的关键）

```
决策层 emit → 事件总线 → 监控持久化订阅 → 监控存储（决策/事件/粒子快照）
                                     ↑ 供销售决策监控台读取
```

---

## §5 销售决策监控台（Q5 答案：监控台如何实现 + 与智能体监控差异）

### 5.1 监控台视图（7 闸门看板）

- **7 闸门概览**：每闸门一张卡（D1–D7），显示 7 维完整度、自主率 vs 升级率、置信度分布、处置分布、结果实现率
- **钻取视图**：点击闸门 → 该 scenario 的 `decision` 列表（`listDecisions`，`decisionRepo.js:107`）→ 单条决策的 `conditions_evaluated` 与 `rationale`
- **反哺视图**：先例复用率、人工推翻率（`reverseDecision` 事件）、闭环时延（required→confirmed）

### 5.2 监控指标（与智能体监控的差异核心）

| 维度 | 智能体监控台（现有） | 销售决策监控台（新增） |
|---|---|---|
| 关注点 | 引擎转不转 · 运行时健康 | 决策对不对 · 闭环没闭环 |
| 指标 | 在线/僵尸、SLA、错误率、任务堆积、告警 | 7维完整度、自主率、置信度、处置分布、结果实现率、先例复用、人工推翻、闭环时延 |
| 盲区 | 维度缺失的决策（agent 健康但决策缺少 Identity 查重→全绿） | 维度缺失即标红（闭环监控要补的盲区） |

### 5.3 结论：两者正交两层，不是替代

- 共用事件总线与监控存储（同源）
- 视图与指标正交：一个 agent 健康但决策维度缺失（如 Identity 未查重），agent 监控全绿、决策监控立刻标红——这正是闭环监控要补的盲区

---

## §6 落地清单（实施顺序）

| # | 任务 | 落点 | 状态 |
|---|---|---|---|
| 1 | 预注册 7 行 decision_scenario（D1–D7） | 配置表 seed | 待做 |
| 2 | 每组 methodology_dimension 条件维度（§3.2 表） | 配置表 seed | 待做 |
| 3 | 监控持久化订阅（bus.on('*') 落库） | `bus.js` 扩展 / 新模块 | 待做 |
| 4 | 监控存储（决策/事件/粒子快照表） | DB schema | 待做 |
| 5 | 销售决策监控台页面（7 闸门看板 + 钻取） | `web/` + `routes.js` | 待做 |
| 6 | 决策监控 API（聚合查询） | `routes.js` | 待做 |

---

## §7 验收锚点（file:line 级证据）

| 验收项 | 证据 |
|---|---|
| 7 行 scenario 已注册 | `decision_scenario` 表存在 D1–D7 行 |
| 条件维度驱动评估 | `autonomyEngine.js:16-27`（buildConditions 从 methodology_dimension 加载） |
| 缺失维度自动升级 | `autonomyEngine.js:71-74`（missing→escalated，不脑补） |
| 决策事件落库 | `decisionRepo.js:140-148`（recordDecisionEvent → decision_event） |
| SSE 事件域含 decision | `routes.js:70`（domains 列表含 'decision'） |
| 监控持久化订阅 | `bus.on('decision', ...)` 事件域订阅（routes.js:22 同类注册模式） |