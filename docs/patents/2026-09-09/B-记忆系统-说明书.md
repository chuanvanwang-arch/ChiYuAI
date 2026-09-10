# 说明书

**发明名称**：一种面向智能体运行时的双轨记忆系统构建方法及装置

**申请人**：[需核实：北京青羽智行科技有限公司]

---

## 技术领域

本发明涉及人工智能与多智能体系统领域，尤其涉及一种面向智能体（Agent）运行时所需的记忆系统的构建方法、装置及存储介质，用于解决 AI 原生平台中智能体的长期记忆的污染防护、生命周期治理、隔离安全与上下文注入问题。

## 背景技术

大语言模型（LLM）本身具有无状态性，无法跨会话保留业务上下文。在 AI 原生销售平台等多智能体系统中，智能体需要长期记忆客户偏好、历史决策、产品信息等以支撑连续决策。现有技术存在以下缺陷：

1. **记忆污染**：业务系统中的瞬态噪声（心跳、重试、临时状态）及敏感凭证（token、password）被无差别写入记忆，导致后续检索召回噪声、存在信息泄露风险。
2. **遗忘即丢失**：传统方案对过期记忆执行物理删除，导致可追溯性丧失，且无法在法律 / 审计层面保留原始轨迹。
3. **租户串扰**：多租户 SaaS 场景下，记忆未按租户隔离，存在跨租户数据污染与个人身份信息（PII）泄漏风险。
4. **注入失控**：记忆未经结构化梳理即直接注入上下文，造成上下文膨胀与决策噪声。

业界已知的“七维 × 七边”决策质量校验矩阵（作用于决策事件的边关系），其校验对象为决策层而非记忆层，无法直接解决上述记忆系统问题。

## 发明内容

本发明提供一种面向智能体运行时的双轨记忆系统构建方法，通过“日志—笔记双轨存储 + 写入四闸门 + 周期蒸馏归档 + 分层分类隔离检索 + 七维完整性校验 + 租户级提升 + 上下文注入”的技术手段，实现记忆的防污染、可追溯、隔离安全与可控注入。

**本发明与现有“七维 × 七边决策校验矩阵”的区别**：现有矩阵以“七维 × 七边”校验一次决策是否站得住，作用对象是决策事件及其边关系；本发明将七维框架（身份 / 结构 / 语义 / 时间与配置 / 决策历史 / 运行状态 / 治理）作为**记忆内容自身的完整性 / 可问责性校验维度**，作用于记忆的产生、蒸馏与召回环节，二者作用对象与技术效果均不同，不构成相同技术方案。

### 有益效果

- 写入四闸门杜绝凭证泄露与噪声污染；
- 蒸馏采用“标记归档而非删除”，兼顾遗忘与可追溯；
- 租户维度强制隔离，杜绝 PII 跨租户串扰；
- 七维校验使记忆具备可问责性，支撑高质量上下文注入；
- 混合召回（dense+sparse+RRF）在无需昂贵向量库的前提下取得稳定检索效果。

## 附图说明

- 图 1：记忆系统总体架构图（双轨存储 / 判定 / 蒸馏 / 检索 / 提升 / 注入）。
- 图 2：记忆生命周期流程图（写入 → 四闸门 → append → 蒸馏双阈值 → 归档 → 注入）。
- 图 3：七维记忆完整性校验矩阵图（七维 × 双轨 / 分类锚点映射）。

## 具体实施方式

**实施例 1（系统构成与数据结构）**

第一存储区为记忆日志表 `crm.memory_log`，关键字段：
- `topic`（业务主题）、`kind`（事件类型）、`payload`（JSONB 载荷）；
- `layer`（分层，默认 L-Workspace）、`entity_id`（客户 / 产品实体锚点）；
- `tenant_id`（租户标识，强制隔离）、`actor`（写入者）、`event_type`；
- `distilled`（是否已蒸馏）、`archived`（是否已归档）、`ttl_days`（生存周期，默认 30）。

第二存储区为常驻笔记表 `crm.memory_note`，以唯一键（layer, topic）做 upsert 重写（ON CONFLICT DO UPDATE），记录经蒸馏提纯后的常驻知识。

**实施例 2（写入四闸门，对应权利要求 3）**

写入第一存储区前调用写入价值判定单元：
1. 凭证硬拒：载荷匹配敏感凭证正则（`api_key|token|password|secret|私钥|凭证`）则无论显式与否均拒绝（`judgeWorthiness` 第一返回）；
2. 显式优先：携带 explicit 标记则跳过噪声与视界判定直接放行；
3. 瞬态噪声：命中 `isTransientNoise` 则拒绝；
4. 价值视界：价值视界 < 30 天且非显式则拒绝。

**实施例 3（周期蒸馏与逻辑遗忘，对应权利要求 4）**

纯函数 `classifyForDistill` 依据创建时间距当前时间，对每条记录判定是否达到第一时长阈值（默认 30 天）与第二时长阈值（默认 60 天）。蒸馏任务按第一阈值标 `distilled=true`、按第二阈值标 `archived=true`；定时器对第一阈值做整数钳位（int32）防止毫秒级风暴。原始行不删除，实现“遗忘 = 归档”。

**实施例 4（分类隔离与混合召回，对应权利要求 5）**

检索单元提供：
- `retrieveMemory`：按 layer + topic（或 topicLike 前缀）选择通道，分别查询笔记表与日志表；
- `rrfSearch`：dense 通道用哈希签名向量余弦、sparse 通道用 LIKE 关键词、二者按倒数排名融合（RRF）取前 k 条；查询强制 `archived=false AND tenant_id=?` 过滤，保证租户隔离与召回质量。

**实施例 5（记忆提升与 PII 护栏，对应权利要求 6）**

`promoteMemoryToTenant` 先按 memory_id 回源，校验源 `tenant_id` 与目标一致（不一致抛“跨租户推广 PII”错误）；以仅追加方式插入租户经验模板表 `crm.tenant_precedent`（含 tenant_id、memory_id、title、payload、source_kind、decision_id），按租户隔离检索，禁止跨租户读他人记忆。

**实施例 6（七维完整性校验，对应权利要求 2）**

对每条记忆按七维框架 `SEVEN_DIMS` 校验完整性：身份（跨系统唯一身份一致）、结构（客户—商机—报价—合同—订单图谱可达）、语义（术语跨域一致）、时间与配置（生效时间窗 / 配置版本）、决策历史（历史先例是否被检索）、运行状态（当前销售运行态）、治理（谁可批 / 谁负责 / 自主边界）。该维度用于记忆落库与召回的可问责性判定。

**实施例 7（运行时上下文注入，对应权利要求 1 的 S7）**

智能体运行时调用上下文装配单元，经 L1 知识底座 / L2 历史决策 / L3 执行协同 / L4 治理决策四层装配；其中 L2 经 `retrieveMemory({topicLike:'decision:%'})` 注入历史决策记忆，使记忆在决策主路径被消费。

## 代码级锚点（供代理机构核实）

| 机制 | 文件:行 | 关键符号 |
|---|---|---|
| 双轨存储-日志 | src/memory/memoryLog.js:26 | `appendMemory`（INSERT crm.memory_log） |
| 双轨存储-笔记 | src/memory/note.js:4 | `upsertNote`（ON CONFLICT layer,topic） |
| 写入四闸门 | src/memory/judge.js:50 | `judgeWorthiness` |
| 瞬态噪声判定 | src/memory/judge.js:42 | `isTransientNoise` |
| 凭证硬拒正则 | src/memory/judge.js:2 | `CREDENTIAL_RE` |
| 蒸馏双阈值 | src/memory/memoryLog.js:120 | `distillMemory` |
| 蒸馏纯函数 | src/memory/memoryLog.js:6 | `classifyForDistill` |
| 混合召回 | src/memory/memoryLog.js:70 | `rrfSearch` |
| 分类检索 | src/memory/memoryLog.js:37 | `retrieveMemory` |
| 租户提升 PII 护栏 | src/memory/promote.js:6 | `promoteMemoryToTenant` |
| 表结构 | db/schema.sql:267 | `crm.memory_log` |
| 租户隔离列 | db/schema.sql:287, :293 | `tenant_id` / `entity_id` |
| 分层 / 蒸馏标记 | db/schema.sql:311-316 | `layer`/`distilled`/`archived`/`ttl_days` |
| 七维框架 | src/sevenDimensions/constants.js:5-16 | `SEVEN_DIMS` |
| 上下文注入 | src/context/assembler.js:109, :234 | `retrieveL2` / `assembleContext` |
