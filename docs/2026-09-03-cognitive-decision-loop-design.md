# CRM-ai-native 认知决策闭环 · 借鉴设计方案（合并版）

> **本文定位**：合并两份分析文档的可借鉴成果，形成**一份可落地的设计方案**。
> - 来源一：`docs/2026-09-03-lightfield-semantica-trigger-analysis.md`（触发 / 记忆 / 知识，借鉴项 A–G）
> - 来源二：`docs/2026-09-03-lightfield-semantica-decision-analysis.md`（决策实现 / 准确性 / 跟踪，借鉴项 H1–H7）
> - 参考实现：`D:\system\reference\semantica-main`（图原生决策基础设施）+ Lightfield 官方博客（AI-Native CRM）
>
> **状态**：设计方案（HARD-GATE 设计先行，**未写实现代码**）。本轮已做代码级取证，其中**三项前序判断被推翻**（见 §2），方案据此重写。
> **铁律**：写经第 0 闸（`decision_id`）· 绝对禁 DELETE · 阈值配置化禁硬编码 · 禁裸 `.catch(()=>{})` · 不污染 10 大 `ai-*` SKILL（外部案例仅作中性跨域方法论示例，落本项目 docs）。

---

## §0 结论先行

两家产品形态迥异，但**恰好互补**：

| | Lightfield | Semantica | 对 CRM 的价值 |
|---|---|---|---|
| 强项 | **"活"**（事件驱动触发、Skill 链、HITL 产品表面、故事化记忆） | **"可信"**（决策一等公民、哈希链防篡改、先例加权、策略版本固化） | 我们**缺"活"**（只有被调用路径），**也缺"可信"**（审计链未通电） |
| 弱项 | 无决策实体、无审计链、无置信度 | 无自主触发器、无 HITL、无结果回填 | 我们**已有** calibration 闭环（两家都无），是唯一领先项 |

**一句话设计目标**：
> 把 CRM-ai-native 从「**被调用的决策系统**」升级为「**事件驱动的、可验证的、会复利的认知决策闭环**」——
> **借 Lightfield 补"活"（C1/C6/C7/C8），借 Semantica 补"可信"（C2/C3/C4/C5），把已有的校准闭环做实形成差异化（C9）。**

**9 个设计组件（去重合并 A–G × H1–H7 后的收敛结果）**：

| 层 | 组件 | 借鉴源 | 优先级 | 解决什么 |
|---|---|---|---|---|
| **L1 触发** | **C1** 领域事件触发层 | Lightfield | P0 | 编排层只会被调用，不会自己醒 |
| **L2 决策** | **C2** 决策不可变审计链 | Semantica | **P0** | 决策可查但**不可证未篡改** |
| | **C3** 决策时刻冻结（策略版本 + 上下文快照） | Semantica | **P0** | 改一次阈值洗掉所有历史判定依据 |
| | **C4** 先例加权检索 + 决策网络真写 | Semantica | **P0** | S2 先例 0 hit；`decision_relation` 无写入 |
| **L3 记忆知识** | **C5** 层级记忆 + 保留期 | Semantica | P1 | 记忆无热层、无保留期治理 |
| | **C6** 故事化记忆 | Lightfield | P1 | 客户 360 缺叙事主视图 |
| | **C7** 知识 / 记忆分离 | Lightfield | P1 | 知识散落 skill 描述，无治理 |
| **L4 治理闭环** | **C8** HITL 审核队列 + 输出契约 | Lightfield | P1 | 有第 0 闸但**无"草稿→人审"表面**；j_judge 无证据锚点 |
| | **C9** 校准闭环 + 复利效应 | 两家共有 + 我们领先项 | P2 | 差异化：预测置信度 vs 实际兑现率 |

---

## §1 设计原则（不可协商）

1. **决策是一等公民，不是 Skill 的副产品**（取 Semantica，弃 Lightfield）。决策必须可独立审计、可复现、可解释。
2. **触发要"活"，执行要"准"**（取两家之长）。触发层要事件驱动（Lightfield），但推理/图/溯源必须确定性（Semantica README：*"no LLM required for graph construction, reasoning, or provenance"*）。
3. **治理不变量**：agent **不回灌 disposition**。写操作必经第 0 闸；`auto_approve` 只能省"人审"，**不能省 decision_id**。
4. **无假绿**：任何降级/失败必须留痕（emit trace + recordFailure），多出口断言带出口标识。
5. **阈值全部配置化**：走 `config_store` + `readThreshold()` 出厂兜底，禁硬编码。
6. **复利是设计目标而非副作用**：每次交互必须 write-through 喂养下一轮 enrich（Lightfield：*"Skills run better on month-three data than day-one data"*）。

---

## §2 ⚠️ 写方案前的代码级取证：三项前序判断被推翻

**这是本方案与上两份分析文档最关键的差异**——三项缺口都不是"从零新建"，而是「**建了但从未真正生效**」。工作量比预估小，但性质更严重（都是已存在的假绿）。

### 反转一：C2 哈希链 —— 代码比 Semantica 还好，但**没通电**

| 事实 | 证据 |
|---|---|
| 哈希链代码**已完整实现** | `src/decision/provenance.js`：`shaChain:37` / `trackEntry:44` / `verifyChain:61` / `exportTurtle:95` |
| `sortKeys/canonical:27-34` 深度键排序 —— **已规避 jsonb 键序漂移导致误报 TAMPERED，此点优于 Semantica** | `provenance.js:27-34` |
| **但 DDL 未入 `db/schema.sql`**，`ensureProvenanceSchema()` **生产 0 处调用** | 全仓 grep `ensureProvenanceSchema` 仅测试调用 |
| → 9 处 `trackEntry` 在生产**恒抛 `relation does not exist`** | `assembleContextV2.js:291-292` 注释自陈："DDL 未入 schema.sql，仅测试调用，100% 抛 relation does not exist" |
| **`verifyChain` 0 处调用** —— 装了烟雾报警器没插电 | 全仓 grep `verifyChain(` 除定义外 0 命中 |

> **判定**：C2 不是新建，是**通电**（DDL 归位 + 启动调用 + verify 接口暴露）。

### 反转二：C3 阈值版本固化 —— 表/列/索引全在，代码**零写入**

| 事实 | 证据 |
|---|---|
| `crm.policy_version` 表已存在 | `db/schema.sql:139` |
| `crm.decision.effective_policy_version` 列 + FK 已存在 | `db/schema.sql:156` |
| 索引已建 | `db/schema.sql:232` `idx_crm_decision_policy` |
| **但 `policy_version` 表写入点全仓 0**（仅 2 个 e2e 脚本伪造 `pv-e2e-test`） | grep `policy_version` + INSERT/UPSERT → 0 |
| `requireDecision` 取 `opts.policy_version \|\| null`，**18 处生产调用方无一传值** → 恒 null | `autonomyEngine.js` |

> **后果**：改一次阈值，所有历史决策无法回答"当年按哪版规则批的"。
> **判定**：C3 是**接线**（决策落库时自动快照当次生效阈值 → 写 policy_version → 回填 effective_policy_version）。

### 反转三：C4 先例检索 —— **算法结构性恒空**，不是"数据真空"

`buildQueryVector` 与 `buildDecisionEmbedding` 均使用 `hashVector`——**SHA-256 字节映射 384 桶的哈希签名（hashing trick），不是语义向量**。纯函数，无需 DB 即可验证。决定性实验：

| 对比 | 余弦相似度 | 过 0.6 闸 |
|---|---|---|
| 逐字相同 | 1.0000 | ✅ |
| **仅 deal_id / 金额不同（语义近乎同案）** | **0.1146** | ❌ |
| 200 次微变采样 | 均值 0.1157 | **1/200（且是与自身比）** |

> **结论**：`hashVector` **只认逐字相同，语义相近 ≈ 随机噪声**。
> **即使灌满 L0 原料，S2 仍恒空**；`autonomyEngine.js:201` 返回的 k 条 `avgSimilarity` 恒 ≈ 0.11，是**注入置信度的常数噪声**。
> **推翻**：前序"S2 0 hit = 数据真空，需 P0 灌原料"的归因（已修正长期记忆）。
> **判定**：C4 必须**换向量算法**，且权重**不能照抄 Semantica 的向量 0.7**（我们无可用语义向量）→ 建议 Jaccard .4 / 类目 .2 / 图中心性 .2 / 向量 .2，配置化 + 归一强校验。

### 本轮新增的利好基线（设计可直接站在上面）

| 资产 | 状态 | 证据 |
|---|---|---|
| `memory_log` **已扩展分层列**（layer / actor / event_type / ttl_days / entity_id） | ✅ 就绪 | `db/schema.sql:252-270`，`db/migrate.js:72-77` |
| `appendMemory` **已有 worthiness 闸门** | ✅ 已防"什么都记" | `memoryLog.js:27` `judgeWorthiness()` |
| `decision_relation` **已含 CAUSED / INFLUENCED / REFERENCED_PRECEDENT / OVERRIDES** 等 7 型，to_id 已放宽 TEXT | ✅ 表就绪，缺写入 | `db/schema.sql:506-521` |
| `decision_outcome` 表已存在，**带 confidence 列** | ✅ 校准闭环数据模型就绪 | `db/schema.sql:558-571` |
| `monitor_event` 有 `domain` 列；写入点 `agentEpisodes.js:14` / `monitorSubscriber.js:36`；`emit(domain,type,payload)` | ✅ 触发层可复用 | `src/events/bus.js:17` |
| `src/calibration/` 已有 10 个模块（autoSuggest / replay / knobs / metrics / sampleLoader …） | ✅ 差异化基础扎实 | 目录实列 |

---

## §3 目标架构

```
                        ┌─────────────────────────────────────┐
   L1 触发层             │  领域事件（对象 create/update、关系变更）│  ← C1 借 Lightfield
   "活起来"              │  monitor_event.domain → intake-router │
                        └──────────────┬──────────────────────┘
                                       ▼
                        ┌─────────────────────────────────────┐
   L2 决策层             │  decision-enrich（前）  ── 先例检索 C4 │  ← 借 Semantica
   "可信"               │  requireDecision（第 0 闸）          │
                        │  decision-execute（后）── 写回 + 连边 │
                        │  ├ C2 哈希链（不可篡改审计）          │
                        │  └ C3 冻结（策略版本 + 上下文快照）   │
                        └──────────────┬──────────────────────┘
                                       ▼
                        ┌─────────────────────────────────────┐
   L3 记忆知识层         │  C5 层级记忆（热/温/冷 + 保留期）     │
   "会积累"             │  C6 故事化叙事（客户 360 主视图）      │
                        │  C7 知识（静态口径）／记忆（动态交互） │
                        └──────────────┬──────────────────────┘
                                       ▼
                        ┌─────────────────────────────────────┐
   L4 治理闭环层         │  C8 HITL 审核队列 + 输出契约（证据锚点）│  ← 借 Lightfield
   "能收敛"             │  C9 结果回填 → 校准 → 复利（差异化）   │
                        └─────────────────────────────────────┘
```

**数据流向（复利回路）**：领域事件 → agent 跑 Skill → 决策落库（冻结 + 入链）→ 结果回填 `decision_outcome` → 校准权重/阈值 → 喂养下一轮 enrich。**每一环都 write-through，越用越准。**

---

## §4 设计组件详解

### 【L1】C1 · 领域事件触发层（借 Lightfield，P0）

**借鉴源**：Lightfield 2026-01-30 *"Workflows can now be triggered by creation or updates to objects in the CRM like meetings, tasks, and notes."*；2026-08-07 扩展到**关系变更**触发。

**现状**：当前只有「被调用」路径（决策时 fire-forget 派发 enrich/execute）+ 定时泵（`ensureTimers` → `pumpReadyTasks`，已接线）。领域对象变化**不会唤醒 agent**。

**设计做法**：
1. `routeThroughIntake`（`scheduler.js:38`）增加 `event-*` intents 分支，与现有 `decision-enrich/execute` 并列。
2. 首批接入 3 类高价值事件（对齐 Lightfield）：`deal.stage_changed` / `meeting.scheduled` / `task.created`；后续扩 `relation.changed`。
3. 复用现有骨架：`emit(domain, type, payload)`（`bus.js:17`）→ `monitor_event.domain` 新增 `domain='business'` 域 → 订阅器 → `routeThroughIntake` → `runWithSkill`。
4. 后台任务走已接线的 `pumpReadyTasks`（60s，配置 `config_store['agent-pump']`），不新建调度器。

**治理**：事件触发的 agent 同样过**第 0 闸**——只读富集免 decision_id，写操作必须先 `createDecision` 拿 id。

**验收**：`deal.stage_changed` → 5s 内产生 agent episode（`monitor_event` 可查），且写操作 100% 带 decision_id。

---

### 【L2】C2 · 决策不可变审计链（借 Semantica，P0，**通电而非新建**）

**借鉴源**：`decision_methods.py:435-438` 哈希输入串联前驱；`:467-475` `NEXT_TRACE_EVENT` 成链；`provenance/integrity.py:27-116` checksum 链。

**Semantica 最关键的设计教训（源码注释写明）**：`integrity.py:45-51` **故意排除 `entity_id`** 入哈希——因为版本化会重命名存档（`X` → `X:v:...`），若入哈希会把合法重命名误判为断链（假阳性）。
> **防篡改链的难点不在"怎么算哈希"，在"哪些字段该进、哪些不该进"。**

**现状（反转一）**：代码已完备但生产 100% 失败 + `verifyChain` 0 调用。

**设计做法**：
1. **T1 止血**：`provenance` 表 DDL 归入 `db/schema.sql`（DDL 单一事实源铁律），`ensureProvenanceSchema()` 在生产启动路径调用（`server.js`）。
2. **哈希字段白名单（必须先定死）**：
   - ✅ **进哈希**：`decision_id` / `event_index` / `event_type` / `event_timestamp` / `payload_json(canonical 排序)` / `prev_hash` / `actor`
   - ❌ **不进**：自增主键、软删除标记、可重算派生字段、会被合法重命名的 id 引用
   - ⚠️ **待裁决**：`entry_type` / `source` / `activity_id` / `invalidated` / `archived` 是否入哈希？**当前只哈希 payload，墓碑（invalidated/archived）可任意翻转而不触发 TAMPERED** —— 这是真实风险敞口。
3. **事件类型映射**（对齐 Semantica 6 类）：`DECISION_RECORDED` / `CONTEXT_CAPTURED` / `POLICIES_APPLIED` / `EXCEPTIONS_RECORDED` / `APPROVAL_RECORDED` / `PRECEDENTS_LINKED`。
4. **暴露校验接口**：`GET /api/decision/:id/verify-chain` 包装已实现的 `verifyChain()`，纳入自检卡（当前 7 问 → 8 问）。
5. **不静默**：链续写失败（查最新事件失败）须 emit trace + recordFailure，**不得**只打 warning 就返回（吸取 Semantica `capture_decision_trace:253-271` 无图后端时"日志有、数据无"的教训）。

**验收**：删中间一行 → 校验返回断链位置；改 payload → 校验失败；正常追加 → 链完整；墓碑翻转（若裁决入哈希）→ 校验失败。

---

### 【L2】C3 · 决策时刻冻结（策略版本 + 上下文快照）（借 Semantica，P0，**接线而非新建**）

**借鉴源**：`decision_recorder.py:226-238` `MERGE (d)-[r:APPLIED_POLICY]->(p) SET r.policy_version = p.version` —— **决策时锁定版本，事后策略改版不影响历史判定**；`decision_models.py:140-171` `DecisionContext` 冻结 `entity_snapshots` + `risk_factors`。

**为什么重要**：三个月后复盘"当时为什么批这个折扣"，若实体状态已变（客户降级、金额回款），无快照则无法重建决策依据。**先例可被信任的前提是先例可被复现。**

**现状（反转二）**：表/列/索引全在，代码零写入 → `effective_policy_version` 恒 null；`dim_coverage` 中 `semantics` / `governance` / `decision_history` **三维为 0**。

**设计做法**：
1. **阈值快照（H2 主体）**：决策落库时，把当次**实际读取**的阈值集合（key + 值 + 来源）序列化 → 写 `policy_version`（含 snapshot JSONB）→ 回填 `decision.effective_policy_version`。
   - **待裁决口径**：A 实际使用路径子集（需埋点，最准）/ B 全量 dump（最简，推荐先落 B 再演进 A）/ C 全量 + 路径。
2. **上下文冻结（H6）**：扩展 `decision_context_snapshot`，补齐 `semantics`（口径/语义）/`governance`（策略与例外）/`decision_history`（先例与因果）三维，并冻结涉及实体的当时状态。
3. **反查能力**（借 `policy_engine.py:711 analyze_policy_impact`）：阈值改版时能列出受影响的历史决策。

**验收**：改阈值后重算历史决策 → 结论可不同，但**原决策记录仍指向旧版本**；三个月后复盘可 100% 重建当时依据。

---

### 【L2】C4 · 先例加权检索 + 决策网络真写（借 Semantica，P0）

**借鉴源**：`decision_query.py:1043-1069` 四分量加权；`:1001-1002` 权重归一强校验（`abs(sum-1.0)>1e-6 → raise`）；`:1101-1124` 图中心性增益（**被反复验证过的先例更可信**）；`decision_recorder.py:143` link_entities。

**现状（反转三）**：`hashVector` 哈希签名 → **结构性恒空**（cos 0.1146，200 采样 1/200）；`decision_relation` 表已就绪（7 种 rel_type，含 `CAUSED`/`INFLUENCED`）但**无写入**（上轮已做描述诚实化修正，标注为待补）。

**设计做法**：
1. **先换算法**：`buildDecisionEmbedding` / `buildQueryVector` 从 `hashVector` 切到**真语义向量**（复用已配好的 LLM embedding；不可用时**降级为 Jaccard 主导**而非返回噪声）。
2. **四分量加权**（权重**不得照抄** Semantica 0.7 向量——我们无可用语义向量）：
   ```
   score = w_jaccard   × 词重叠相似度     # 建议 0.4（无语义向量时的主力）
         + w_category  × 同类目(0/1)      # 建议 0.2（硬门槛，异类目直接压低）
         + w_centrality× 图中心性增益     # 建议 0.2（被引用多的先例更可信）
         + w_vector    × 语义向量相似度   # 建议 0.2（有 embedding 时启用）
   ```
   - 权重**归一强校验**（和不为 1 直接抛错，抄 Semantica）→ 走 `config_store['decision-precedent']`，禁硬编码。
   - 中心性取决策子图（max_depth=2）degree centrality，**带缓存**（抄 `:1101-1124`）。
3. **决策网络真写**（闭合上轮缺口）：封装 `relation.js:48 linkDecisions(fromId, toId, relType)` 为 action `crm-decision-relation-upsert`（**经第 0 闸**），在 `method-decision-execute` 接入。
   - **先例 to_id 回填通道**：enrich 阶段检索到的先例 id 需经 ctx/事件回传给 execute（**当前 fire-forget 无此通道，是本项的前置依赖**）。
4. **因果链**：`CAUSED` / `INFLUENCED` 边写入后，用 BFS（max_depth=5，带环路防护，抄 `decision_query.py:738-840`）提供 `traceDecisionPath`。

**验收**：先例命中率 > 0（且非噪声）；同类目先例稳定排在异类目之前；`decision_relation` 有真实行且可通过 BFS 追踪路径。

---

### 【L3】C5 · 层级记忆 + 保留期（借 Semantica，P1）

**借鉴源**：`agent_memory.py` 三层 write-through（短缓冲 → 长时向量 → KG），`retention_policy` 默认 30 天，`_prune_short_term_memory` 按 count + token 裁剪。

**现状（利好）**：`memory_log` **已扩展** `layer` / `actor` / `event_type` / `ttl_days` / `entity_id`（`schema.sql:252-270`）；`appendMemory` **已有 worthiness 闸门**（`memoryLog.js:27`）；`crm-memory-upsert` action 已打通 write-through（上轮方案C 落地）。

**设计做法**：
1. 在已有 `layer` 列上**明确热/温/冷语义**：`L-Short`（近期交互缓冲，count + token 裁剪）/ `L-User` / `L-Org` / `L-Workspace`（长期）。
2. **保留期治理**：`ttl_days` 落地为实际蒸馏/归档作业（当前列存在但无执行器）——超期条目蒸馏进长期层或归档，**禁 DELETE**（软合并 `meta.merged_into`）。
3. **检索三段兜底**（抄 `AgentMemory.retrieve:457`）：short_term → vector → keyword。

**验收**：热层条目数受控（不无限膨胀）；超期条目被蒸馏而非删除；检索可按层路由。

---

### 【L3】C6 · 故事化记忆（借 Lightfield，P1）

**借鉴源**：*"we dumped the classical graph and started building our data model of people and companies around stories"*；*"write live-updating chronological stories about people and your relationship with them"*。
> **关键洞察**：刚性图「把边抱太死」，无法表达人优先级/心态的**可塑性**（如 CISO 原说预算固定，被说服后改变）；故事让模型**动态重加权**细节重要性。

**设计做法**：`account-insight.html`（客户 360，已在进行）以**编年史关系故事为主视图**——从 `memory_log` + `particles` 合成 live-updating narrative，结构化粒子作支撑证据；**非刚性图遍历**。

**验收**：客户 360 首屏是叙事而非表格；叙事随时间自动更新；每条叙事可下钻到源证据。

---

### 【L3】C7 · 知识 / 记忆分离（借 Lightfield，P1）

**借鉴源**：*"Skill = 执行（repeatable workflow）；Knowledge = 结构化上下文层（ICP/竞品/异议/买家语言/资格标准），Skill 运行时引用"*；三作用域 **Workspace（Admin 共享）/ User（个人）/ System（平台维护）**。
> **判别测试**：「给新人讲过 3 次的指令 = Skill；每次重复解释的公司背景 = Knowledge」。

**为什么影响准确性**：不先定义口径 → 模型把同一模式拆成多行 → **信号被稀释**（Lightfield 原话：把 'VP Finance'/'CFO'/'Head of Finance' 当三个角色 → "the skill will split one pattern into three rows and dilute the signal"）。

**设计做法**：
1. 定义 **Knowledge 层**（静态口径：ICP、资格标准、异议库、阶段/角色定义），3-scope（workspace/user/system）落 `config_store` 或独立知识表；method-* skill 运行时**引用**。
2. **Memory 层**（动态交互）由 `appendMemory` 写回，二者**不混存**。
3. 归并当前散落于 skill 描述/seed 的知识内容。

**验收**：同一口径在多个 Skill 中一致；新增 Skill 无需重复粘贴公司背景。

---

### 【L4】C8 · HITL 审核队列 + 输出契约（借 Lightfield，P1）

**借鉴源（三层 HITL）**：

| 机制 | 原文 |
|---|---|
| Suggested Record Updates（2025-11-14） | *"You can see the source of the new value **in-line** as you accept or reject each suggestion."* |
| For review 队列（2026-06-12） | *"it lands in their For review queue to **edit, send, or dismiss**."* |
| 权限开关（2026-07-10） | *"Auto-approving or **Asking every time** for HTTP request permissions"* |

**现状**：我们有第 0 闸（写必须带 `decision_id`）与升级人工，但**缺"草稿 → 人审 → 编辑/放行/驳回"的产品表面**；`j_judge` 是自由文本 prompt，结论无证据锚点。

**设计做法**：
1. **For review 队列**：agent 输出（客户回复草稿、商机推进建议、折扣建议）以 **draft** 态落库并指派审阅人；审阅面支持 **编辑 / 放行 / 驳回**，且**内联显示每个建议值的来源**。
2. **治理开关**：按动作类型配置 `auto_approve | ask_every_time`（对齐 Lightfield 权限开关）。
   > ⚠️ **红线**：`auto_approve` **不得**跳过第 0 闸——decision_id 仍强制。我们卡的是**写权限凭据**，Lightfield 卡的是**写动作是否需人审**，**两者叠加而非二选一**。
3. **输出契约（H5）**：method-* 的 `j_judge` 步骤统一三段式输出：① 结论 ② **逐字证据**（引用原文/记录 id）③ **量化依据**（出现次数 ≥ N、样本窗口 ≤ 90 天、样本量下限）。
   - **无证据 → 判 `degraded` 而非 `done`**（对齐"无假绿"铁律；当前 `executeSkill` 仅在 LLM 不可用时降级，应扩展为"证据不足也降级"）。

**验收**：AI 生成的对外文案 100% 经队列，未过审不可发出；无证据结论不再计为 `done`。

---

### 【L4】C9 · 校准闭环 + 复利效应（两家共有 + 我们领先项，P2）

**关键判据**：两家**都没有**结果回填/校准闭环。
- Semantica：`semantica/context/` 全目录 grep `calibrat|actual_outcome|outcome_feedback|effectiveness` → **0 命中**；`confidence` 由调用方自报，事后永不修正。**Semantica 的"准确性"= 过程可复现 + 可追溯，不是"预测更准"。**
- Lightfield：Skill 输出不带 confidence，MEDDPICC 是框架分而非概率。

**我们的领先资产**：`src/calibration/`（autoSuggest / replay / knobs / metrics / sampleLoader / patchAssembler / rules / replayDims，共 10 个模块）+ `decision_outcome` 表（**已带 confidence 列**，`schema.sql:558-571`）。

**设计做法**：
1. 把「决策 → 结果回填 `decision_outcome` → 反哺阈值/权重/先例权重」做成**确定性闭环**。
2. 对齐 Semantica 的 `average_confidence` 指标，增加**校准后置信度**：**预测置信度 vs 实际兑现率**对照曲线。
3. 复利指标：`auditability_pct`（21% 真空已由 `crm-memory-upsert` 闭合）+ 新增**先例命中率 / 因果链密度 / 校准偏差**。

**验收**：可给出「预测 0.85 的商机实际赢率」这类对照曲线——**这是两家都给不出的东西，是我们的差异化**。

---

## §5 实施路线（每 Task 一 commit，AI 不代 commit）

| 阶段 | 组件 | 关键动作 | 依赖 |
|---|---|---|---|
| **P0-1 止血** | C2 | provenance DDL 归位 `schema.sql` + 启动调用 + `verify-chain` 接口 | 需 PG 可达 |
| **P0-2** | C3 | 决策落库自动快照阈值 → `policy_version` → 回填 `effective_policy_version` | 待裁决口径 |
| **P0-3** | C4 | 换真语义向量（无则 Jaccard 主导）+ 四分量加权（归一强校验，配置化） | **先修算法再灌数据** |
| **P0-4** | C1 | `event-*` intents + `monitor_event.domain` 订阅 → 路由 agent | 复用已接线泵 |
| **P1-1** | C4 续 | `crm-decision-relation-upsert` action + enrich→execute 先例 to_id 回填通道 | P0-3 |
| **P1-2** | C5 / C7 | 热层裁剪 + 保留期蒸馏执行器；Knowledge 层三作用域 | — |
| **P1-3** | C8 | For review 队列（draft/edit/send/dismiss）+ j_judge 输出契约 | — |
| **P2** | C6 / C9 | 故事化客户 360；校准闭环 + 复利指标 | P1 |

**顺序理由**：C2→C3→C4 是"可信"三件套，先做因为**它们治理的是已经产生的数据**（历史决策越积越多，越晚做损失越大）；C1 放 P0-4 是因为骨架已就绪（泵已接线），改动面小。

---

## §6 铁律与验收口径

- **写操作必经第 0 闸**（`ctx.decision_id || params.decision_id`，`executor.js:24-30`）；`auto_approve` 不豁免。
- **绝对禁 DELETE**；去重/归档走软合并 `meta.merged_into`。
- **阈值配置化**：权重、跳数、top_k、保留期、泵间隔全走 `config_store` + `readThreshold()` 兜底，禁硬编码。
- **禁裸 `.catch(()=>{})`**：fail-safe 须 `emit('trace')` + `recordFailure()`；多出口断言带出口标识。
- **VITEST 隔离护栏**保留（后台 fire-forget 派发须 `if(!process.env.VITEST)`）。
- **后台派发不得回灌 disposition**（治理不变量）。
- **不污染 SKILL**：Lightfield / Semantica 仅作中性跨域方法论示例，内容落本项目 `docs/`，**不写入 10 大 `ai-*` SKILL**。
- **DDL 单一事实源**：新增表/列一律入 `db/schema.sql`，`ensure*()` 仅兼容补列。

---

## §7 待裁决项（裁决后即开工）

| # | 裁决点 | 选项 | 建议 |
|---|---|---|---|
| 1 | **哈希白名单**：墓碑字段（`invalidated` / `archived` / `entry_type` / `source` / `activity_id`）是否入哈希？ | 入（可检测墓碑翻转）/ 不入（避免合法变更误判） | **入**，否则墓碑可任意翻转不触发 TAMPERED |
| 2 | **阈值快照口径** | A 实际使用路径子集（需埋点）/ B 全量 dump / C 全量+路径 | **先落 B**（最简），演进到 A |
| 3 | **C4 向量方案** | 接 LLM embedding / 纯 Jaccard+中心性 / 混合降级 | **混合降级**：有 embedding 用之，无则 Jaccard 主导（权重自动调整，不返回噪声） |
| 4 | **C1 首批事件** | deal.stage / meeting / task / relation.changed | **先 3 类**（deal/meeting/task），relation 留二期 |

---

## 附：与两份分析文档的映射（去重合并痕迹）

| 本方案 | 来自触发篇 | 来自决策篇 | 合并说明 |
|---|---|---|---|
| C1 | **A** 事件触发层 | — | 直接继承，补代码锚点 |
| C2 | — | **H1** 哈希链 | 继承 + **重写为"通电"**（反转一） |
| C3 | — | **H2** 版本固化 + **H6** 上下文冻结 | **合并为"决策时刻冻结"**（同语义：防事后漂移），重写为"接线"（反转二） |
| C4 | **B** 先例+因果链 / **D** 混合检索+图扩展 | **H3** 先例四分量 | **三合一**，重写为"先换算法再加权"（反转三） |
| C5 | **C** 层级记忆+保留期 | — | 继承 + 标注基线已具备（layer/ttl 列已在） |
| C6 | **E** 故事化记忆 | — | 直接继承 |
| C7 | **F** 知识/记忆分离 | — | 直接继承 |
| C8 | — | **H4** For review 队列 + **H5** 输出契约 | **合并为治理表面**（都在管"AI 输出怎么到人手里"） |
| C9 | **G** 复利效应 | **H7** 校准闭环 | **合并为闭环**（复利是校准的结果） |

---

## 附：证据索引

| 结论 | 证据 |
|---|---|
| **反转一** 哈希链代码完备但生产恒失败 | `src/decision/provenance.js:37/44/61/95`；`ensureProvenanceSchema` 生产 0 调用；`assembleContextV2.js:291-292` 注释自陈 100% 抛错；`verifyChain(` 0 调用 |
| **反转二** policy_version 零写入 | `db/schema.sql:139`（表）/:156（列）/:232（索引）；`requireDecision` 取 `opts.policy_version \|\| null`，18 处调用无一传 |
| **反转三** hashVector 结构性恒空 | `buildQueryVector`/`buildDecisionEmbedding` 均用 `hashVector`（SHA-256→384 桶）；实验 cos 逐字 1.0 / 微变 0.1146 / 200 采样过闸 1/200 |
| memory_log 已扩展分层列 | `db/schema.sql:252-270`；`db/migrate.js:72-77` |
| appendMemory worthiness 闸门 | `src/memory/memoryLog.js:27` |
| decision_relation 表就绪缺写入 | `db/schema.sql:506-521`（7 种 rel_type，to_id 已放宽 TEXT）；`src/decision/relation.js:48` `linkDecisions` 未封装为 action |
| decision_outcome 带 confidence | `db/schema.sql:558-571` |
| 事件总线可复用 | `src/events/bus.js:17` `emit(domain,type,payload)`；`agentEpisodes.js:14` / `monitorSubscriber.js:36` |
| calibration 10 模块 | `src/calibration/` 目录实列 |
| Semantica 哈希链 | `decision_methods.py:435-438`（哈希输入）/:440-465（写节点）/:467-475（成链） |
| Semantica 排除 entity_id 的权衡 | `provenance/integrity.py:45-51`（源码注释写明理由） |
| Semantica 先例四分量 + 归一强校验 + 中心性 | `decision_query.py:1043-1069` / :1001-1002 / :1101-1124 |
| Semantica 策略版本固化 | `decision_recorder.py:226-238` |
| Semantica 无校准回路 | `semantica/context/` grep `calibrat\|actual_outcome\|outcome_feedback\|effectiveness` → 0 命中 |
| Semantica 无图后端只打 warning（须避免） | `decision_methods.py:253-271` |
| Lightfield 触发 | blog 2026-01-30 对象事件；2026-08-07 关系变更触发 |
| Lightfield HITL 三层 | 2025-11-14 Suggested Updates；2026-06-12 For review / running code when exact；2026-07-10 权限开关 |
| Lightfield 故事化记忆 | blog 2026-02-20 *LLMs also prefer stories to graphs and databases* |
| Lightfield 复利 | *"Skills run better on month-three data than day-one data."* |
| Lightfield 口径稀释教训 | Four Skills Pro-tip：*"the skill will split one pattern into three rows and dilute the signal"* |
