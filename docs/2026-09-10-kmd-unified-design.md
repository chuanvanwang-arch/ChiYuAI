# KMD 三系统统一方案（关系澄清 · 构建时机 · 写用治闭环 · 修补路线）

| 项 | 内容 |
|---|---|
| 日期 | 2026-09-10 |
| 定位 | KMD（知识 K / 记忆 M / 决策 D）**三系统关系澄清与整体解决方案**：回答「什么关系 / 如何调用闭环 / 如何何时构建 / 怎么写怎么用 / 如何查闭环 / 如何修补」 |
| 方法 | 代码级审计（grep + `file:line` 锚点）+ **探针实测**（`scripts/kmd-closure-probe.mjs`，13 条，含 D13 噪声回归闸，可复跑） |
| 数据可信度 | 本文所有量化结论均来自探针 2026-09-10 真实输出，可 `node scripts/kmd-closure-probe.mjs` 复现；**凡引用他人文档的数字均已实地复核**（初版未复核导致 3 处误判，见 §9） |
| 与既有文档关系 | `2026-09-09-patent-F-KMD-assessment.md` 定义 KMD 术语与专利视角；`2026-09-10-memory-system-governance-design.md` 是 M 单系统治理；`2026-09-10-customer-memory-writeback-design.md` 是 M 缺陷修复子集。**本文是三系统横向统一层**，只裁决跨系统边界与接线，不重复单系统细节 |
| 状态 | 待评审 |

---

## §0 结论先行

> **KMD 现在不是闭环，是「D 单腿独跑」。** 连接三套系统的 8 条边里 **2 条完全断裂、4 条半通或失真、2 条真通**。
>
> **本轮已落地可复跑探针 `scripts/kmd-closure-probe.mjs`（13 条，含端到端哨兵 E2E + 探针自检 self-test + D13 噪声回归闸）。下文所有数字均为该探针 2026-09-10 的真实输出，可用 `node scripts/kmd-closure-probe.mjs` 一键复现**——文档不再承载一次性快照。只读实测汇总：🟢5 🔴3 🟡4（D13 噪声闸 PASS；E2E/D12 在 `--e2e --db=test` 下均 PASS，行为级已验证）。

三句话定性（均已实测，非静态推断）：

1. **K 知识层是「一半死、一半假」** —— 两个独立缺陷叠加：**场景知识层 LK 是死层**，`layers.LK` 在 `src/context/assembler.js:258` 装配后全仓零消费者，端到端哨兵 E2E 实测「LK 命中 1 行、但 prompt 中检索不到」（🔴）；**L1 知识路径虽通电却喂假货**，`assembler.js:73` 硬编码 `hashVector`，探针 D1 实测 65/65 全为 hash 伪向量，**真向量占比 0%**（`max_nonzero=32` 恰等于 SHA-256 字节数，从数学上确证指纹判据成立）。净效果：知识以「相关知识」的名义进了 prompt，但内容与查询无关。
2. **M 记忆层写入很勤、可用极少** —— 排除蒸馏噪声后业务记忆 9,030 行，但 `entity_id` 锚点率为 **0%**（此前按全表口径算出的 0.002% 是被 62 万行噪声稀释出的错觉），可注入率 55.87%。**没有锚点 = 无法按实体召回**，记忆只能当流水账旁白用。
3. **闭环最后一环从未通电，且比预想多断一处** —— 业务结果自动回写 `registerOutcomeIngester` 全仓无调用，探针 D4 实测真自动回写 **0 条**（库内 4 条全为 `seed-script` 种子）；**更关键的是 `outcome_event_map` 规则表实测 0 行**，即使注册订阅器也无规则可匹配。实时校准订阅的 3 个事件名与全仓实际 emit 的 17 个事件名**交集为空**（🔴）。

**关于知识库内容的一个"虚高"问题（本轮新发现，但**不阻塞接线**）**：探针 D11 显示仅 **18.46%**（12/65）的知识条目符合知识契约。深挖后的真相是：**65 条 `CRM_KNOWLEDGE` 里 43 条是系统词表术语**（`{term, type:'业务术语', layer:'L1'}`，如 "S1"、"auto"），只有 12 条是真正的业务知识（如"企业管理咨询-理想客户画像"）。

**关键澄清（修正初版判断）**：这**不构成 P0-3 的前置阻塞**——`retrieveL_Knowledge`(`assembler.js:201-207`) 的 `payload->>'kind' = ANY($2)` 条件中，NULL 不匹配任何类，**53 条无 kind 的词表已被自动排除**。实测 LK 可返回 12 条，**全部有 `content` 且无空值**，质量良好（分属 acme-consult / acme-consult2 / acme-meddev 三个租户各 4 条）。

因此：**P0-3 接线可以立即施工，修好即能拿到 12 条高质量知识**，无需先做内容治理。真正的遗留问题是「词表冒充知识导致指标虚高」，已降级为 P1-6。

**这决定了修补顺序**：先统一契约（P0-0）→ 再接线（P0）→ 再优化算法（P1）→ 最后治理（P2）。在 K 未通电、outcome 未自动回流之前，任何向量算法优化、分块策略、RRF 融合都是零收益投入——因为下游没人消费。

---

## §1 关系澄清：KMD 到底是什么关系

### 1.1 一句话定义（以代码载体为准）

| 层 | 回答的问题 | 真实代码载体 | 是否有独立表 |
|---|---|---|---|
| **K 知识** | 「用什么标准判」 | `crm.particles` 中 `type='CRM_KNOWLEDGE'` 的行（`db/schema.sql:14`、`src/particles/particleModel.js:78-91`）；方法论维度 `crm.methodology_dimension`（`schema.sql:143`）；阈值 `crm.config_store`；规则 `crm.decision_rule`（`schema.sql:717`）；先例 `crm.tenant_precedent` | ❌ 无独立知识表，寄生于粒子表 |
| **M 记忆** | 「记得发生过什么」 | `crm.memory_log` / `crm.memory_snapshot` / `crm.memory_note`（`db/schema.sql:267-274`、`:348-356`） | ✅ 三张独立表 |
| **D 决策** | 「这一笔怎么判、判得对不对」 | `crm.decision`（33 列，`schema.sql:164-186`）+ 13 张卫星表（trace / snapshot / outcome / root_cause / patch / provenance / rule_hit / relation / retro_report） | ✅ 主表 + 卫星表族 |

**关键认知纠偏**：K 不是「文档库」，M 不是「日志」，D 不是「审批记录」。三者的正确关系是**一条有反馈的供应链**：

```
K 提供判定标准（静态、可复用、跨租户可沉淀）
M 提供情境事实（动态、单实体、时间序列）
D 消费 K+M 产出裁决，并把裁决结果反哺回 K 和 M
```

- **K 与 M 的区别不是「内容」而是「可复用性」**：同一句话「客户对价格敏感」，落在某个客户身上是 M（情境事实），抽象成「制造业客户普遍价格敏感」是 K（可复用标准）。项目里已有这条升格通道：`src/memory/promote.js:17-21` 把记忆升格为 `tenant_precedent`。
- **D 是唯一的写入权威**：K 和 M 的高质量内容都应该由 D 的复盘产出（`src/decision/closureLoop.js:188-193` 已实现复盘→`CRM_KNOWLEDGE`），而不是靠人手工填。这是「自我进化」的技术定义。

### 1.2 八条边的真实状态（代码核实 + 探针实测）

**读法**：状态列为探针 `scripts/kmd-closure-probe.mjs` 2026-09-10 输出；「证据」列为代码锚点。

| # | 边 | 语义 | 状态 | 证据与实测 |
|---|---|---|---|---|
| ① | **K → D** | 决策时读知识 | 🔴 **死层 + 假绿** | **LK 死层**：`assembler.js:258` 装配 `layers.LK`，`injector.js` 全文不读 LK（探针 D2：`lk_consumers=0`）；E2E 哨兵实测 `lk_rows=1` 但 `in_prompt=false`。**L1 假绿**：L1 确实被 `injector.js:35` 消费（D3 显示知识占 L1 池 14.71%，🟢），但 `assembler.js:73` 硬编码 `hashVector`，D1 实测真向量占比 **0%** |
| ② | **M → D** | 决策时读记忆 | 🟡 半通 | 唯一入口 `assembleContextV2.js:117-125` 的 S5 时间线读 `memory_log`；判定内核（`rubricScorer`/`autonomyEngine`）不读记忆。**D8 实测业务记忆锚点率 0%、可注入率 55.87%** |
| ③ | **D → M** | 决策回写记忆 | 🟡 半通·失真 | `decisionRepo.js:458-465` 无条件 `appendMemoryLog`，但硬编码投影 5 字段、不传 `entity_id`；消费端 `injector.js:22` 只认 `text/summary/note/content` 键，投影不产这些键 → **双向落空** |
| ④ | **D → K** | 决策回写知识 | 🟡 半通·需人工 | `closureLoop.js:188-193` 走 `createParticle('CRM_KNOWLEDGE',...)` 真实回写，但入口是 `POST /api/decision/:id/retro`（`decisionReadRoutes.js:295-301`），**必须人工提交复盘**才触发 |
| ⑤ | **业务结果 → D** | outcome 自动回流 | 🔴 **完全断（双重）** | ① `registerOutcomeIngester` 全仓仅定义处命中（`outcomeIngester.js:49,59`），`src/http/server.js` 未调用；② **探针 D4 实测 `outcome_event_map` 启用规则数 = 0** —— 即使注册订阅器也无规则可匹配，这是比"没注册"更深的一层断裂。D4 实测真自动回写 0 条（库内 4 条全为 `seed-script`） |
| ⑥ | **outcome → 校准补丁** | 偏差生成补丁 | 🟡 半通·仅夜间 | 实时链死：`autoSuggest.js:104` 判 `decision-created`/`outcome-set`/`feedback-set`，全仓 `emit('decision',...)` 实际只有 `made`/`confirmed`/`overridden`/`reversed`/`human-disposition`/`deal-advance` 等，**无一匹配**；且 autoSuggest 只推 SSE 浮卡不落 patch（`:128`）。唯一活路径是夜间 `retro.js:440,528 savePatches` |
| ⑦ | **补丁 → 参数生效** | 参数版本化落地 | 🟢 通·但积压 | `calibration/store.js:151-172` 第 0 闸 `approvePatch` → `strat.apply` → `knobs/threshold.js:15-20` 写 `config_store` → 下次 `loadEngineConf` 生效；17 类 knob 全部改数据库、不碰 SKILL 文件。**消费链代码正确且已接线**（calibrationRouter.js:219 `ensureAdmin` + workbenchRouter.js:319 `tune-approve`）。**但 D6 实测 PENDING 60 条、最老积压 5 天**——这是 HITL 设计使然（补丁须经管理员审批流才落地），非代码断点；本质是「产出无人审阅」的治理缺口。只读 triage 辅助 `scripts/calibration-triage.mjs` 已落地，供人分级消项 |
| ⑧ | **M → K** | 记忆升格为先例/知识 | 🟢 通·但未成规模 | `src/memory/promote.js:17-21` 把记忆升格为 `tenant_precedent`。**D7 实测共 1 条先例、1 条来自记忆（100%）** —— 路径活着，但近乎未触发。**注意：本条边此前被本文档遗漏，是七边模型的缺口** |

**闭环判定**：一个闭环成立需要「供给 → 裁决 → 结果 → 改进 → 回到供给」五段全通。当前 ① 断使供给缺一半（LK 死层）且另一半失真（L1 假绿），⑤ 断使结果段缺失，⑥ 半通使改进段只有夜间批量，⑦ 虽通但因 60 条补丁积压而实际未生效。**结论：闭环在两处物理断开、一处逻辑积压，不是「效果不好」，是「回路未接通」。**

**关于边数**：本文初版只列 7 条边，漏了 ⑧ M→K。这说明边的枚举本身需要以代码扫描为准（枚举方法见 §5.4），而非凭架构直觉。

### 1.3 三个「假绿」陷阱（比断点更危险）

断点会暴露，假绿不会。以下四处会让审计和监控**误报为正常**。**其中第 3、4 条是本轮探针实测后新增/修正的**：

| # | 陷阱 | 位置 | 危害 |
|---|---|---|---|
| 1 | **伪装成真向量的假标志位** | `src/knowledge/embed.js:47-49` —— siliconflow 分支注释自认「实际 API 调用超出本 Task 范围」，返回的是 `hashVector`，却标 `provider:'siliconflow', degraded:false` | 监控看到 `degraded:false` 判定健康，实际检索质量等于随机。**注意：`provider` 不落库，库内无法追溯，只能靠向量数学指纹判别（探针 D1）** |
| 2 | **标签写「相关知识」实为随机 TOP5** | `assembler.js:73` `const qvec = hashVector(q)` 硬编码，即便 `EMBEDDING_PROVIDER=model` 也用伪向量；`injector.js:36` 却把结果标注为「相关知识(N)」注入 prompt | LLM 收到被标为「相关知识」的随机粒子，产生有据可依的错觉。**D1 实测 65/65 全为 hash 伪向量** |
| 3 | **知识库内容混装导致指标虚高**（本轮新增，**已澄清不阻塞接线**） | 65 条 `CRM_KNOWLEDGE` 中 43 条是系统词表术语（`{term, type:'业务术语'}`），仅 12 条为真实业务知识 | **误导性**：「知识条数 65」看起来知识库很充实，实为 82% 是词表。但**LK 检索已自动排除词表**（`kind=ANY` 对 NULL 不匹配），故接线后不会拿到垃圾。**危害限于指标失真与 L1 池污染，归 P1-6** |
| 4 | **比率类指标被噪声稀释**（本轮修正） | 记忆表 631,637 行中 98.6% 是 `memory-distill-run` 心跳 | **修正此前判断**：这不是持续污染，而是 2026-09-01 单日风暴（621,650 行，占 99.85%），根因 int32 钳位致 `setInterval` 压成 1ms，**`distillScheduler.js:24-28` 已修复并留注释**；`capture.js:10-22` 白名单也已收紧。**当前真正的最大噪声源是 `llm-metering-missing-tenant`（D9 实测 24h 内 1,179 行 / 73.23%）**。教训：按全表算比率会得出"锚点率 0.002%"这类被稀释的失真结论，正确口径是排除噪声后按业务行算（实测 0%） |

`embedding.js:31-34` 已自我标注 hash 向量的真实质量：**语义近似案例 cos≈0.1146，200 次微变采样过 0.6 闸仅 1 次**。这意味着任何依赖 hashVector 的检索在语义层面等于失效。

---

## §2 三套系统目前如何构建、何时构建

四类构建时机语义完全不同，混淆它们是「以为构建了其实没有」的根源。

| 层 | 构建时机 | 触发点 | 构建动作 | 阻塞语义 | 失败后果 |
|---|---|---|---|---|---|
| **K 知识** | **写时构建**（write-time） | `createParticle` / `updateParticle` | `particleRepo.js:141` `ensureAll` → embedding + FTS + 词汇登记 + 图镜像（`ontology/hooks.js:139-145`） | **同步阻塞写路径** | 写入失败，可感知 |
| **M 记忆** | **事件时构建**（event-time） | 决策落库（`decisionRepo.js:458`）/ 事件总线（`capture.js:57-61`）/ SKILL 步骤（`skills/seed.js:130`）/ 边写留痕（`edgeWrite.js:33`） | `appendMemoryLog` | **异步、异常吞掉** | 静默丢失，不可感知 |
| **D 决策** | **请求时构建**（request-time） | 业务动作第 0 闸（`executor.js:67` / `mcp/gateway.js:167`） | `requireDecision` → 装配 S1–S7 → 落 33 列 → 冻结 pre 快照 → 溯源链 | **同步阻塞业务动作** | 动作被拒，强可感知 |
| **治理** | **定时构建**（scheduled） | `distillScheduler.js:19`（注册于 `decisionReadRoutes.js:434`）；`retroTrigger` + 夜间 `retro.js` | 30 天打 `distilled`、60 天打 `archived`；夜间批量生成 patch | 后台定时 | 无质量指标，不可感知 |

### 2.1 构建时机的三个结构性问题

**问题 A：K 的写时构建质量取决于一个环境变量，且降级不可见。**
`src/http/server.js:36-45` 在启动时检查 `llm_config` 有 apiKey 才把 `EMBEDDING_PROVIDER` 置为 `'model'`。若未配置，全部知识以 hash 伪向量入库，且 `particles` **无 embedding 回填脚本**（`scripts/backfill-decision-embeddings.mjs:28-30` 只回填 `crm.decision`）。这意味着：**一旦在未配 key 的时期写入过知识，这批知识永久是伪向量，无补救通道。**

**问题 B：M 的事件时构建是「fail-silent」，所有写入缺陷都不报警。**
`decisionRepo.js:458` 用 `.catch((err) => recordFailure(...))` 兜住，租户丢失、entity_id 为 NULL、投影缺字段全部静默通过。存量数据 `entity_id` 非空仅 12 / 631,616 条 —— 这个比例说明**锚点解析从未真正工作过**，但系统从未因此报错。

**问题 C：D 的请求时构建最健壮，恰恰因为它同步阻塞。**
这是全系统唯一「构建失败必被发现」的层，也解释了为什么 D 的 33 列数据质量远高于 K 和 M。**结论可推广：想让 K/M 的质量追上 D，必须给它们加上同等强度的可感知失败机制**（见 §5 探针）。

---

## §3 写：写什么 / 何时写 / 谁写 / 写到哪

三套系统必须有各自明确的写入契约，否则就会出现当前「写了但读不出」的双向落空。

### 3.1 K 知识层写入契约

| 项 | 规定 |
|---|---|
| **写什么** | 可跨实体复用的判定标准：ICP 画像、竞对情报、异议应对、买方语言、方法论条目、反面先例。**判据：这条内容换一个客户还成立吗？成立→K，不成立→M** |
| **何时写** | ① 复盘产出结论时（自动，`closureLoop.js:188`）；② 人工沉淀行业知识时（`crm-knowledge-upsert`）；③ 词汇首次出现时（自动，`vocabulary.js:21-32`） |
| **谁写** | 主力应是**复盘自动写**（D→K），人工只做补充与纠偏。当前是反的：人工为主、自动需手动触发 |
| **写到哪** | `crm.particles` type=`CRM_KNOWLEDGE`；**必须区分 `kind`**：词汇类（`{term,type,layer}`）与业务知识类（`{term,kind,content,confidence,source}`）当前同表混存无区分列 → 建议新增 `payload.knowledge_class ∈ {vocabulary, domain}` |
| **必填字段** | `term` / `kind` / `content` / `source`（必须可追溯到 decision_id 或人）/ `confidence` / `tags` |
| **红线** | 写入必带 `requireDecisionId`（已实现）；embedding 必须为 model provider，hash 兜底时**必须标 `degraded:true`**（当前 `knowledge/embed.js:47-49` 违反此条） |

### 3.2 M 记忆层写入契约

| 项 | 规定 |
|---|---|
| **写什么** | 单实体的情境事实与决策叙事。**四段式投影为强制格式**：`summary`（自然语言摘要，供注入层消费）/ `entities`（涉及实体）/ `evidence`（依据）/ `gaps`（缺口） |
| **何时写** | 决策落库时（自动）；关键业务事件时（拜访、报价、合同、回款）；SKILL 步骤显式写 |
| **谁写** | 系统自动为主。人工 `crm-memory-upsert` 作为补录通道 |
| **写到哪** | `crm.memory_log`（append-only 日志）；curated 常驻结论写 `crm.memory_note`（`ON CONFLICT (layer,topic) DO UPDATE` 覆盖式） |
| **必填字段** | `tenant_id`（当前 4 个写入点全部不传）/ `entity_id` + `entity_type`（当前恒 NULL）/ `layer` / `topic` / `payload.summary` |
| **红线** | **trace / 心跳 / 系统日志禁止写入 `memory_log`**（历史峰值 98.6%，2026-09-01 单日风暴所致，`distillScheduler.js:24-28` 已修复；**当前最大噪声源为 `llm-metering-missing-tenant`，D9 实测 1,179 行/24h 占 73.23%**）；必须另立 `memory_trace` 表或直接写 trace 通道；`summary` 键缺失即视为写入失败 |

> **§3.2 的核心洞察**：四段式投影不是格式美化，是**让消费端能读到的必要条件**。`injector.js:22` 只认 `text/summary/note/content` 四个键，当前投影不产这些键 → 即使租户和锚点全修好，召回结果在注入层仍会被判空过滤。

### 3.3 D 决策层写入契约

D 的写入契约已基本完备（33 列 + pre/post 快照 + 溯源链 + 不可变 policy_version），需补的是**结果段**：

| 项 | 规定 | 当前缺口 |
|---|---|---|
| **outcome 何时写** | 业务事件发生即自动写（合同签署→WIN、回款→VERIFIED、流单→LOSS、审批驳回→BLOCKED） | 🔴 `registerOutcomeIngester` 未注册、`outcome_event_map` 无种子 |
| **outcome 谁写** | 事件总线订阅器自动写（`source='event'`），人工仅补录（`source='manual'`） | 🔴 当前 100% manual |
| **root_cause 何时写** | 决策被推翻 / outcome 为负时自动归因 | 🟡 `persistRootCause` 仅测试调用，实际靠 `attribution.js:156` 间接写 |
| **红线** | outcome 写入必须 `emit('decision','outcome-set')`，否则下游校准永不触发 | 🔴 该 emit 全仓不存在 |

---

## §4 用：何时用 / 怎么用 / 谁用

### 4.1 分工原则：K 进内核，M 进上下文

这是本方案最重要的裁决。当前 K 和 M 都被当成「给 LLM 看的文本」，导致两个后果：K 干脆没接上，M 接上了也只是旁白。正确分工：

| 层 | 消费方式 | 消费者 | 理由 |
|---|---|---|---|
| **K 知识** | **结构化进判定内核** —— 作为阈值、规则、检查项参与确定性打分 | `autonomyEngine` / `rubricScorer` / `decision_rule` 匹配 | 知识是标准，标准必须可计算、可版本化、可审计。塞进 prompt 让 LLM 自由解读等于放弃可审计性 |
| **M 记忆** | **叙事化进上下文** —— 作为时间线与情境注入 prompt | `assembleContextV2` S5 / `injector.formatForPrompt` | 记忆是故事，故事的价值在于让 LLM 理解情境，不适合硬编码成规则 |
| **K 的一小部分** | 叙事化补充 —— 异议话术、买方语言等「话术型知识」进 prompt | `injector` 新增 LK 消费块 | 话术类知识本质是给人/LLM 用的语言素材 |

**落地映射**：
- K→内核：`methodology_dimension`（已通）+ `config_store` 阈值（已通）+ `decision_rule`（已通）+ **`CRM_KNOWLEDGE` 中 kind∈{icp,competitors} 转为 S-op 供给**（待建）
- K→prompt：`CRM_KNOWLEDGE` 中 kind∈{objections,buyer_language} → `layers.LK` → `injector` 消费（待建，即修 ① 断点）
- M→prompt：保持现状 + 修投影 + 接 `rrfSearch`

### 4.2 何时用（触发条件矩阵）

| 场景 | 用 K | 用 M | 用 D 历史 |
|---|---|---|---|
| 阶段推进 / 报价 / 折扣等受闸动作 | ✅ 必须（阈值+规则+检查项） | ✅ 必须（该客户历史） | ✅ 必须（先例检索） |
| 智能体对话答疑 | ✅ 话术类 | ✅ 该客户时间线 | 🟡 可选 |
| 客户 360 视图 | 🟡 ICP 对标 | ✅ 四源时间线 | ✅ 决策轨迹 |
| 夜间复盘 / 校准 | ✅ 作为对照基线 | ✅ 后见之明比对 | ✅ 样本主体 |
| 新租户冷启动 | ✅ 唯一可用（先例池为空） | ❌ 无数据 | ❌ 无数据 |

> **冷启动含义**：新租户开通时 M 和 D 都是空的，**只有 K 能提供判定能力**。这是 K 通电优先级高于一切算法优化的业务理由——K 断线时新租户的决策质量等于裸跑默认阈值。

### 4.3 谁用（消费者清单与现状）

| 消费者 | 位置 | K | M | D |
|---|---|---|---|---|
| 决策引擎 | `autonomyEngine.requireDecision` | 🔴 不读 CRM_KNOWLEDGE | 🟡 仅 S5 | ✅ searchPrecedents |
| LLM 智能体循环 | `agentLoop.js:23-29` | 🔴 装配未注入 | ✅ L2.memories | ✅ L2.decisions |
| 客户 360 / 时间线 | `timelineSource.js:142` | ❌ | 🟡 按 entity_id 过滤但存量恒空 | ✅ |
| 复盘 / 校准 | `closure.js:53` | 🟡 只写不读 | ✅ 读 memory_log | ✅ |
| 门户页面 | `memory.html` / `portal/*` | ✅ 词汇管理页 | ⚠️ sysadmin-only，业务租户看不到 | ✅ 监控台 |

---

## §5 查：如何检查闭环（可执行探针）

原则：**每条边一个二值判据，判据必须能自动跑、不依赖人看图。** 以下探针建议固化为 `scripts/kmd-closure-probe.mjs` 并接入夜间巡检。

### 5.0 探针已落地（本轮交付物）

**`scripts/kmd-closure-probe.mjs`** —— 13 条探针，可复跑、可入 CI、退出码语义化（有 FAIL/ERROR 返回 1）。

```bash
node scripts/kmd-closure-probe.mjs                        # 只读全量，控制台表格
node scripts/kmd-closure-probe.mjs --json out.json         # 输出 JSON 供文档/巡检消费
node scripts/kmd-closure-probe.mjs --self-test             # 探针自检（自证不会恒绿）
node scripts/kmd-closure-probe.mjs --e2e --db=test         # 端到端哨兵（写库，强制要求测试库）
node scripts/kmd-closure-probe.mjs --probe D1,D4           # 只跑指定探针
```

**设计原则（源于本轮一次真实翻车）**：

1. **探针必须自证鉴别力。** 初版 D1 用 `embedding IS NOT NULL` 判「向量已构建」，实测 65/65 全绿——但全是 hash 伪向量，探针零鉴别力。故每条探针配负向对照，`--self-test` 注入已知反例验证判据会给出相反结论（当前 2/2 通过）。
2. **禁「非空即通过」。** 任何 `count > 0` 即绿的判据必须有对照指标。教训：旧 D5 用 `source <> 'manual'` 判自动回写，会把 `seed-script` 种子数据判为自动，报 `auto_pct = 100%` 假绿。
3. **只用库内可判别的事实。** `provider` 字段不落库，无法追溯，故 D1 改用向量数学指纹（hash 向量：分量全非负且非零维 ≤32）。
4. **只读优先。** 默认纯读；写操作仅 `--e2e` 且强制 `--db=test`，清理用 `archived` 软删、禁 DELETE（项目红线）。

### 5.1 静态探针（代码扫描级，检查接线是否存在）

已固化为 D2 / D5 两条，无需手工 grep：

| 探针 | 判据 | 2026-09-10 实测 |
|---|---|---|
| **D2** LK 知识层消费者 | `layers.LK` 在 assembler 之外的消费点数 ≥ 1 | 🟢 **4**（injector.js:50 等已消费 LK，P0-3 已修） |
| **D5** 校准事件契约 | 订阅事件名 ∩ 全仓 `emit('decision',…)` 事件名 非空 | 🟢 **交集 1**（`outcome-set`，P0-3 补 emit 后接通） |

> 补充：静态探针只能证明「接线存在」，不能证明「数据真流动」。二者都绿才算通。

### 5.2 数据探针（SQL 级，检查数据是否真流动）

### 5.2 数据探针（SQL 级，检查数据是否真流动）

已固化为 D1 / D4 / D6 / D7 / D8 / D9 / D10 / D11。**下表为 2026-09-10 真实输出**（非预期值，可直接复跑核对）：

| 探针 | 边 | 状态 | 实测关键值 |
|---|---|---|---|
| **D1** 知识向量真伪 | K 构建 | 🔴 | `knowledge_rows=65`、`hash_signature=65`、`has_negative=0`、`max_nonzero=32`、`avg_nonzero=30`、**真向量占比 0%**（P1-1 真 embedding 未接入） |
| **D3** L1 知识构成 | ① | 🟢 | `l1_pool=442`、`type_kinds=18`、`knowledge_registered=65`、**知识占比 14.71%** |
| **D4** outcome 真实性 | ⑤ | 🔴 | `outcome_total=4`、`real_auto=0`、`seed_script=4`、**`event_rules=1`、`event_rules_enabled=1`**（规则已种，prod 尚未触发真实 contract_sign 事件；机制由 D12 行为级证明） |
| **D6** 校准补丁积压 | ⑦ | 🔴 | `PENDING=60`、`APPLIED=1`、`REJECTED=1`、`ROLLED_BACK=1`、**最老积压 5.1 天**。⚠ **非代码缺陷**：校准补丁按 HITL 铁律**必须经管理员审批流落地**（`store.approvePatch`→`POST /api/calibration/patches/:id/approve` 或 `/api/my-todo/tune-approve`，均经第0闸真实决策行），消费链代码已验证正确。60 条全来自 3 次自动生成批次（09-05 15:38 / 09-06 02:03 / 09-09 02:03），本质是「产出无人审阅」的治理缺口。风险分布 MEDIUM 29 / HIGH 10 / LOW 21。已加只读 triage 辅助 `scripts/calibration-triage.mjs`（`npm run triage:calibration`）输出分级待办清单，供人消项 |
| **D7** M→K 升格 | ⑧ | 🟢 | `total=1`、`from_memory=1` |
| **D8** 记忆可用性 | ② | 🟡 | `memory_total=631,649`、`business_rows=9,042`、**锚点率 0%**（62 万历史行无锚点；新写入走 P0-4 四段式锚点）、可注入率 55.8%（5,045 行） |
| **D9** 噪声源排行(24h) | M 构建 | 🟡 | `rows_24h=1,543`、top=`llm-metering-missing-tenant` **1,124 行 / 72.85%**（均为 04:42 前的旧进程残留，近 60 分钟已为 0，见 D13） |
| **D10** D→K 回写 | ④ | 🟡 | `knowledge_total=65`、`retro_knowledge=0` |
| **D11** 知识投影契约 | K 构建 | 🟡 | `has_content=22`、`kind_in_four=12`、`both_ok=12`、**匹配率 18.46%** |

### 5.3 行为级 / 回归探针（写类受 `--e2e --db=test` 闸门；D13 只读）

| 探针 | 边 | 状态 | 实测关键值 |
|---|---|---|---|
| **D12** 结果自动回流 | ⑤ | 🟢（e2e） | `written_rows=1`、`outcome_found=1`：`handleBusinessEvent('decision','contract_sign',{deal_id})` 按 deal 反查并写出 `source='event:decision.contract_sign'` 的 outcome（P0-2 已修，确定性通过） |
| **D13** 噪声闸门回归 | M 构建 | 🟢 | `code_has_wildcard_sub=false`、`blocked_capturable=(无)`、`whitelist_leak=(无)`、`recent_trace_rows_60m=0`（P0-5 根因锁死，三关全过） |
| **E2E** 端到端哨兵(K→prompt) | ① | 🟢（e2e） | `in_prompt=true`、`lk_rows=1`：哨兵知识经装配链路进入最终 prompt（P0-3 已修） |

**三条判据的设计要点（都是踩过坑才定的）**：

```sql
-- D1：hash 向量的数学指纹（源自 src/ontology/embedding.js:8-15）
--   SHA-256 只有 32 字节映射到 384 桶 → 非零分量数 ≤ 32；
--   分量值 = (h[i] % 251)/251 恒非负 → 真模型 embedding 必有负分量。
--   两者同时满足判为 hash。实测 max_nonzero=32，恰等于字节数，判据自洽。
SELECT count(*) FILTER (WHERE s.minv < 0)                      AS has_negative,
       count(*) FILTER (WHERE s.minv >= 0 AND s.nonzero <= 32) AS hash_signature
FROM (
  SELECT p.id, min(t.x::float8) AS minv,
         count(*) FILTER (WHERE t.x::float8 <> 0) AS nonzero
  FROM crm.particles p,
       LATERAL regexp_split_to_table(
         substring(p.embedding::text, 2, length(p.embedding::text) - 2), ',') AS t(x)
  WHERE p.type = 'CRM_KNOWLEDGE' AND p.embedding IS NOT NULL
  GROUP BY p.id
) s;

-- D4：outcome 三分类（旧判据 source<>'manual' 会把种子判成自动 → 假绿）
--   真自动 = source LIKE 'event:%'（outcomeIngester.js:38 的写入格式）
--   seed-script 独立计数，绝不计入自动率。
SELECT count(*) FILTER (WHERE source LIKE 'event:%')  AS real_auto,
       count(*) FILTER (WHERE source = 'seed-script') AS seed
FROM crm.decision_outcome;

-- D8：比率必须按「业务记忆」口径算，不能按全表（会被 62 万行噪声稀释）
--   错误口径：全表 12/631,616 ≈ 0.002%（错觉）
--   正确口径：排除 memory-distill-run 后 0/9,030 = 0%（真相）
SELECT count(*) FILTER (WHERE event_type <> 'memory-distill-run') AS business_rows,
       count(*) FILTER (WHERE event_type <> 'memory-distill-run' AND entity_id IS NOT NULL) AS anchored
FROM crm.memory_log;
```

### 5.3 端到端哨兵（行为级，唯一能证明闭环的方法）—— 已落地为探针 E2E

静态探针只能证明接线存在，数据探针只能证明数据存在，**二者都可能被假绿骗过**。唯一可靠的是注入可追踪哨兵，绕过所有中间层的自我报告，只看最终 prompt。

**已实现**（`--e2e --db=test`）：写一条含随机串的哨兵知识 → 走真实 `assembleContext` + `formatForPrompt` → 检查 prompt 原文是否含该串 → 软删清理。

**2026-09-10 实测（决定性证据）**：

```
E2E  sentinel=SENTINEL-Q9CATWOS   lk_rows=1   in_prompt=false   🔴
```

**这条输出把 ① 边的断点精确钉死在 `LK → injector` 这一段**：LK 检索端是好的（命中 1 行），但 prompt 里没有——断点不在检索，而在消费。这比 grep「零消费者」的证据强得多，因为它证明的是运行期行为。

**哨兵构造必须遵守 LK 的两道契约，否则探针自身会假阳性**（这是调试哨兵时真实踩到的）：

1. `kind` 必须在四大类内（`icp/competitors/objections/buyer_language`，见 `assembler.js:17-31`）；
2. 正文必须写在 `payload.content` —— `buildKnowledgeRows`(`assembler.js:35`) 只透传 `{kind, term, content}`，用 `text`/`summary` 会被投影成空壳。

> **这正是 D11 探针的由来**：初版哨兵用 `kind:'methodology'` + `text:` 构造，结果 `lk_rows=0`——看起来像链路断裂，实为契约不匹配。若不是逐层定位，险些写成错误结论。

**待补的哨兵**（当前未实现，需业务侧配合触发）：

| 哨兵 | 验证的边 | 判据 |
|---|---|---|
| 记忆哨兵 | ② M→D | 写入哨兵记忆（`entity_id` + `content`），检查是否进入 prompt |
| outcome 哨兵 | ⑤⑥ | 手工写一条 outcome，检查 5 分钟内 `calibration_patch` 是否新增 PENDING 行 |
| 补丁哨兵 | ⑦ | 批准一条补丁，检查 `config_store` 是否变更、下次决策是否读到新阈值 |

### 5.4 边的枚举方法（防止再漏边）

本文初版漏了第 ⑧ 条边 M→K，说明**凭架构直觉枚举边不可靠**。改为代码扫描驱动：

```
边 = 写侧出口 × 读侧入口
  K 写侧：crm-knowledge-upsert / closureLoop / promote
  M 写侧：capture / decisionRepo.appendMemoryLog / distill
  D 写侧：decision / outcome / patch
  读侧：assembleContext 各层 / formatForPrompt / assembleContextV2 / rubricScorer / autonomyEngine
```

新增任何写入或读取通道时，必须同步更新探针清单——否则就会出现「有边无探针」的盲区。

---

## §6 补：修补路线（按「最小改动 / 最大联通」排序）

修补策略的核心判断：**当前系统的瓶颈是接线，不是算法；而接线之前还隔着一道契约**（D11 实测仅 18.46% 知识符合投影契约）。因此顺序是 **P0-0 契约 → P0 接线 → P1 算法 → P2 治理**。P0 单项改动量都很小（多数在 50 行以内），但每一项都能让一条死边通电。**在 P0 未完成前不投入 P1/P2**，否则是给不通电的管道抛光。

### P0 · 接线（目标：7 条边全部通电，无死边）

| # | 动作 | 位置 | 改动量 | 通电效果 | 风险与说明 |
|---|---|---|---|---|---|
| ~~P0-0~~ 🔽 | ~~统一知识写入契约~~ —— **经实测已降级为 P1-6**：LK 的 `kind=ANY` 已自动排除无 kind 的词表，实测可返回 12 条且全部有 content，**接线不受其阻塞** | — | — | 降级原因见 §1.2 与 §0；真正的问题是「词表冒充知识」导致指标虚高，属内容治理而非接线 | — |
| **P0-1** | `writeOutcome` 成功后补 `emit('decision','outcome-set', {scenario_id,...})` | `src/decision/outcome.js:19` 附近 | ~3 行 | 打通 ⑥ 实时校准链（`autoSuggest.js:104` 的订阅条件立即生效） | 极低；autoSuggest 已做异常隔离。**与 P0-2b 是同一件事的两面，须同批做** |
| **P0-2** | **a) `server.js` 启动时调用 `registerOutcomeIngester()`**；**b) 种入 `outcome_event_map` 规则** | `src/http/server.js:71` + seed SQL | ~10 行 + seed | 打通 ⑤。⚠️ **D4 实测规则表 0 行**——只做 a) 不做 b) 等于白做，无规则可匹配 | 中；建议先只映射 `contract_sign`→WIN 一条，观察 3 天再扩 |
| **P0-3** | `injector.formatForPrompt` 增加 LK 消费块（TOP3 + 单条截断） | `src/context/injector.js` | ~12 行 | 打通 ① K→D 的 prompt 侧（E2E 哨兵由红转绿），可立即拿到 12 条真实业务知识 | 低；需控 token 预算。**不依赖 P0-0**（已澄清，见上） |
| **P0-4** | 决策记忆投影改四段式（`summary`/`entities`/`evidence`/`gaps`），并传 `tenant_id` + `entity_id` | `src/decision/decisionRepo.js:458-465` | ~25 行 | 打通 ③：D8 锚点率 **0% → 可用区间** | 低；细节以 `2026-09-10-customer-memory-writeback-design.md` C7 为准 |
| **P0-5** ✅ | **噪声治理（已实证解决）**：根因 = 运行中的旧进程跑旧版 `on('*')` 全量捕获订阅，把 170 处 `emit('trace',…)` 全写成 `memory_log`（topic 形如 `event:trace:llm-metering-missing-tenant`）。**C4 修复（`capture.js:7-22` 的 `BLOCKED_DOMAINS` 硬闸 + 逐域白名单订阅，绝无 `on('*')`）已正确，且生产进程于 2026-09-10 ~04:42 退役旧进程、新进程接管后不再捕获 `trace`/`metering` 域。**实证：D13 `recent_trace_rows_60m=0`、最后写入 `04:42:43`、24h 内 1,124 行全部来自 04:42 之前。全仓唯一产出 `event:trace:*` topic 的通道即 `capture.js`，无绕过白名单的直写路径。**无需额外代码改动**。加 D13 永久回归闸（代码扫描 on(*) + 运行时 isCapturable 契约 + 生产库 60min 实时三关）防复活 | 已落地：`capture.js` 白名单 + D13 探针 | 0（仅加探针） | 噪声已停；记忆召回可用性不再被持续污染 | 无；**存量 62 万历史行按禁删红线只打 `archived=true`，禁 DELETE**（见 §8-Q4） |
| **P0-6** | 修假标志位：`knowledge/embed.js` siliconflow 分支返回 hash 时必须标 `degraded:true` | `src/knowledge/embed.js:47-49` | ~2 行 | 消除监控盲区，让降级可见 | 极低 |

**P0 验收标准（以探针为准，不以代码合并为准）**：

```
node scripts/kmd-closure-probe.mjs --e2e --db=test
  D1  🟢 真向量占比 ≥ 50%（依赖 P1-1）
  D2  🟢 LK 消费者 ≥ 1（P0-3）
  D4  🟢 real_auto > 0 且 event_rules_enabled > 0（P0-2）
  D5  🟢 事件名交集非空（P0-1/P0-2b）
  D8  🟢 锚点率 ≥ 20%（P0-4）
  D11 🟢 契约匹配率 ≥ 50%（P0-0）
  E2E 🟢 in_prompt = true（P0-3 + P0-0）
```

> **注意 D1 与 P0 的关系**：D1 转绿需要真 embedding（P1-1），不在 P0 范围内。P0 阶段接受 D1 红，但**必须在文档中明确标注「语义检索此刻仍不可用」**，不得因「知识已写入」而宣称能力落地。

### P1 · 供给正确性（目标：供给内容从「随机」变为「相关」）

| # | 动作 | 位置 | 说明 |
|---|---|---|---|
| **P1-1** | `retrieveL1` 改用 `embedText` 替换硬编码 `hashVector` | `src/context/assembler.js:73` | 当前即便 provider=model 也用伪向量，导致标注为「相关知识」的实际是随机 TOP5。这是 P1 中收益最高的一项 |
| **P1-2** | 新增 `scripts/backfill-particle-embeddings.mjs`，回填 `CRM_KNOWLEDGE` 及全粒子 embedding | 参照 `backfill-decision-embeddings.mjs` | 解决「未配 key 时期写入的知识永久是伪向量」的历史债；必须支持 `--dry` 与限速 |
| **P1-3** | `rrfSearch` 接线到 `retrieveMemory`，替换「时间倒序取 20 条」 | `src/memory/memoryLog.js:126-174` → `seed-actions.js:1937` | 已实现的死代码，接线即可获得相关性召回 |
| **P1-4** | K 进内核：把 kind∈{icp,competitors} 转为 `assembleContextV2` 的一个 S-op 供给项 | `src/context/supplySpec.js` + `assembleContextV2.js` | 让知识参与确定性打分而非仅作 prompt 文本，兑现 §4.1 的分工原则 |
| **P1-5** | `persistRootCause` 接入 `crm_decision_root_cause` handler 主链 | `src/decision/traceRootCause.js` | 当前 root_cause 靠 `attribution.js:156` 间接写，归因数据不完整 |

### P2 · 治理与质量（目标：可持续，不再退化）

| # | 动作 | 说明 |
|---|---|---|
| **P2-1** | 知识分块（chunking） | 当前全仓零实现，知识整包单向量。长文档知识的检索精度受限。**注意：这一项在 P0-3 未完成前收益为零** |
| **P2-2** | 词汇 / 业务知识分列 | 新增 `payload.knowledge_class`，消除同表混存 |
| **P2-3** | 记忆去重、冲突消解、版本管理 | 当前全部未落地；`weight` 列零引用可作为置信度载体复用 |
| **P2-4** | 蒸馏产出真摘要 | 当前只打 `distilled=true` 标志位、不生成摘要、`distilled` 在读侧也不生效（`memoryLog.js:100,103` 仅过滤 `archived`） |
| **P2-5** | embedding 覆盖率与降级率进监控台 | 把 §5.2 的 D1–D7 做成看板指标 + 阈值告警 |
| **P2-6** | 记忆页面向业务租户开放 | `GET /api/memory` 当前 sysadmin-only，业务租户看不到自己的记忆 |
| **P2-7** | `L-Cloud` 层落地或删除 | 当前仅存在于 UI 常量 `memoryConfigRender.js:6`，无任何写入代码 —— 要么实现，要么从 UI 移除以免误导 |

### 6.1 修补顺序的依赖关系

```
P0-1 ──┐
P0-2 ──┼──> ⑤⑥ 通电 ──> D4/D5/D6 探针转绿 ──> 校准闭环可自我运转
P0-6 ──┘      （P0-2 必须 a)注册 + b)播种规则，缺 b) 则 D4 仍红）

P0-3 ──> ① 通电（E2E in_prompt=true）──┐
P1-1 ──> 真向量（D1 0%→≥50%）───────────┼──> 知识供给真实可用 ──> P2-1 分块才有意义
P1-2 ──> 存量回填 ─────────────────────┘
P1-6 ──> 词表/知识分列（指标去虚高，不阻塞上面三条）

P0-4 ──> ③ 不失真（D8 锚点率 0%→≥20%）──┐
P0-5 ──> 噪声已停（D13 近60m trace=0；旧进程04:42退役，C4生效）┼──> 记忆召回可用 ──> P1-3 RRF 才有意义
                                         ┘
```

**读法**：
- **P0-0 是新增的前置项，且优先级最高**：契约不匹配时（D11 仅 18.46%），P0-3 接线修好也只拿到空壳。这是本轮探针实测推翻原修补顺序的关键一条。
- P2-1（分块）依赖 P0-0 + P0-3 + P1-1；P1-3（RRF）依赖 P0-4 + P0-5。倒过来做会得到「算法很先进但没人消费」的结果——这正是 `rrfSearch` 和 `outcomeIngester` 成为死代码的成因。
- **原 P0-5（噪声隔离）经核查已完成**（`capture.js:10-22`），已从清单改向为治理 `llm-metering-missing-tenant`。**教训：列修补项前先验证它是否已被做过，否则是重复劳动。**

---

## §7 长期机制：如何防止再次退化

当前局面的成因不是能力不足，而是**「实现完成」与「接线完成」被当成同一件事**。三个机制建议：

1. **交付定义改为「探针绿」而非「代码合并」**：任何 K/M/D 相关 PR 的验收标准必须包含对应探针由红转绿的证据，禁止以「已实现」作为完成标志。**本轮已具备执行条件**——`scripts/kmd-closure-probe.mjs` 退出码语义化（有 FAIL/ERROR 返回 1），可直接作为 CI 门禁。
2. **死代码巡检入 CI**：凡 `export function register*` / `export function *Search` 若全仓无调用点，CI 告警。`registerOutcomeIngester` 与 `rrfSearch` 都能被这一条抓到。
3. **事件名契约化**：`emit` 的 domain/type 集合与订阅方的判定集合应来自同一常量文件，从类型层面消除 `autoSuggest.js:104` 那类「订阅了不存在的事件」的错误。**D5 实测显示实际 emit 有 17 种且命名风格不一（`review_gate_passed` 用下划线、其余用连字符），正是缺乏契约的证据。**
4. 🆕 **探针自检入 CI（防"恒绿探针"）**：本轮最深的教训是**探针自身会假绿**（旧 D1/D5 均无鉴别力）。机制：探针必须带负向对照，`node scripts/kmd-closure-probe.mjs --self-test` 不通过则禁止合入探针改动。
5. 🆕 **文档数据必须来自探针，不得转述**：本轮文档初版的数字全部转述自 governance 文档，未自验，导致 3 处判断错误。机制：凡文档中出现量化结论，必须附探针 ID 与复跑命令。

---

## §8 待王川裁决的四个开放问题

1. **知识库内容治理的处置口径（原 P0-0 降级项）**：65 条 `CRM_KNOWLEDGE` 中 43 条是系统词表术语。**已澄清不阻塞接线**（LK 已自动排除）。处置选项：① 新增 `payload.knowledge_class` 区分 `vocabulary`/`knowledge`（推荐，可保留词表价值）；② 词表迁出 `CRM_KNOWLEDGE` 独立类型（更彻底，但违反"不新增粒子类型"红线）；③ 暂不处理，仅修正指标口径。**建议①，排 P1-6。**
   - **🟢 2026-09-10 裁决并执行：王川选定「先补齐存量 65 条」（而非先建正式枚举+迁移映射表）**。已落地 `db/migrate-knowledge-kind-backfill.sql`（幂等、非破坏性 jsonb_set、可逆），回填规则**纯按 payload 形态二分类、零猜测**：
     · 形态A 词表术语（`type+layer` 且无 `content`）→ `kind='vocabulary'`（43 条）；
     · 形态B 商机阶段跃迁叙事（含 `content`）→ `kind='transition'`（10 条）；
     · 已有 12 条种子保持四类销售知识 `icp/competitors/objections/buyer_language`（各 3）。
   - **回填后 `kind` 枚举 = 6 值**：`icp` `competitors` `objections` `buyer_language`（LK 销售知识投影用）＋ `vocabulary`（系统词表，LK 自动排除）＋ `transition`（阶段跃迁叙事）。65 条全部非空（实测 null 53→0）。
   - **D11 指标重读**：回填后 `kind_in_four=12` / `both_ok=12` / `match_pct=18.46%` 不变，但语义已修正——**这 18.46% 是诚实值，非缺陷**：仅 12 条属 LK 四类销售知识，53 条 vocabulary/transition 本就不在 LK 投影契约内（vocabulary LK 已排除、transition 是叙事非销售知识）。故 D11 维持 WARN 属预期，不等同"知识断裂"。P0-0 降级项的本质（契约不匹配导致接线修好也拿空壳）**已随 P0-3 接线 + 本回填消除**：LK 现在拿到的 12 条都是带 content 的真实销售知识。
   - **后续（P1-6）**：正式枚举 + 迁移映射表可在数据稳定后补；当前枚举由数据涌现，足以支撑 LK 投影与探针判读。
   - **🟢 2026-09-10 晚：回填迁移已固化进部署链**。`db/migrate-knowledge-kind-backfill.sql` 已注册进 `db/migrate.js` 的 `INCREMENTAL_SQL`（紧跟 `2026-09-10-memory-entity-type.sql` 之后）。双库验证：测试库 `crm_native_test` 9 条 CRM_KNOWLEDGE 同构（6 词表 + 3 跃迁）被完整分类、残留 0；生产库 `crm_native` 重跑幂等（affected=0）、65 条分布不变。自此任何新建/重跑环境均自动补齐 `kind`，消除"本地手动改生产、迁移文件未记录、部署漂移"风险。
2. **P0-2 的规则播种粒度**：**本轮已澄清一个前提**——`outcome_event_map` 实测 **0 行**，不是"映射粒度"问题而是"有没有"的问题。首批只映射 `contract_sign`→WIN（保守，可观察），还是一次性映射合同/回款/流单/审批驳回四类（激进，闭环更快成立）？建议保守起步。
3. **旧 §4.1 的分工原则是否接受**：K 进判定内核（结构化、可审计）、M 进 prompt（叙事化）。若接受，P1-4 需要新增一个 S-op，会动 `supplySpec` 的供给契约——这是本方案中唯一涉及架构接口变更的一项。
4. **存量噪声处置口径（已收敛）**：62 万条是 2026-09-01 单日历史事故（`distillScheduler.js:24-28` 已修），非持续污染。当前 `llm-metering-missing-tenant`（D9 24h 1,124 行）**经实证为旧进程在 2026-09-10 04:42 前产生的残留**，新进程接管后近 60 分钟零 trace 噪声（D13）。故**无需任何清理动作**：历史行按禁删红线保留、仅以 `archived` 隔离召回（不主动迁移，避免额外成本与 DELETE 红线冲突）；持续噪声已自然停止。该开放问题已关闭。

---

## §9 本轮核查留下的诚实记录

**这份文档初版曾有三处判断错误，均由本轮探针实测推翻，保留记录以免重犯**：

| 原判断（错） | 实测修正（对） | 根因 |
|---|---|---|
| 「62 万噪声是持续污染」 | 是 2026-09-01 单日风暴（621,650 行 / 99.85%），`distillScheduler.js:24-28` 已修 | 把一次性历史事故当成当前缺陷 |
| 「P0-5 噪声隔离待做」 | `capture.js:10-22` 白名单已收紧，是重复劳动 | 列修补项前未验证是否已做过 |
| 「outcome 100% 人工」 | 真实业务 outcome = **0**（库内 4 条全为种子）；且规则表 0 行 | 探针用 `source<>'manual'` 判自动，把种子判成自动 → 假绿 |
| 「知识从不进决策」 | L1 路径知识占 14.71% 且进了 prompt；**死的只是 LK 层**，且进的是 hash 噪声 | 把「LK 死层」扩大成「知识层全死」 |

**方法论沉淀**：这四类错误的共同根因是**「文档结论跑在数据前面」**——引用他人文档的数字、凭架构直觉枚举边、用无鉴别力的判据。修法是 A 方案（先落探针再写文档），本轮已执行，文档从此可复跑核验。



