# 最终设计：共生式 CRM 接入 + 主动运行时

> **版本** v1.0（FINAL，唯一有效设计）｜ **日期** 2026-09-15 ｜ **状态**：✅ **已批准**（2026-09-16 用户批准，批准对象=共生同步线+主动运行时线两份设计之合并）  
> **性质**：实施级设计。批准后唯一入口为 `writing-plans`；**批准前不写任何实现代码（HARD-GATE）**。批准后唯一入口为 `writing-plans`（§18.1）。
>
> **本文取代以下四份文档（均已打废弃标记，仅保留过程证据，不得作为实施依据）：**
>
> - `2026-09-15-rox-benchmark-differentiation-analysis.md`（Rox 单点对标）
> - `2026-09-15-attio-lightfield-rox-three-way-comparison.md`（三家对照）
> - `2026-09-15-crm-coexistence-sync-design.md`（共生同步线设计）
> - `2026-09-15-proactive-runtime-design.md`（主动运行时线设计）
>
> **任务编号统一为 T01–T20**（原两份文档中的 T1–T10 请按 §11 的对照表映射）。

---

## §0 结论先行：最重要的修改是什么

### 0.1 一条最重要的修改

> **定位反转：把我方从「一个要求客户搬家的新 CRM」，改成「挂在客户既有 CRM 之上的判断层」。**

一句话形态：

```
数据从客户系统进来  →  判断在我方发生  →  结论回客户系统去
```

**为什么它是"最重要"而非"之一"**——因为这一个改动**一次性锁死了另外五个决策**，且这五个决策此前全部是开放状态：

| # | 被锁死的决策   | 反转前（错）                    | 反转后（对）                             |
| - | -------- | ------------------------- | ---------------------------------- |
| 1 | **数据源**  | 我方自建记录系统，要客户把历史搬过来        | **客户 CRM 是主数据源**（纷享销客/销售易/自研）      |
| 2 | **写入方向** | 我方独立闭环，客户还得再登一个系统         | **结论回写客户 CRM 指定字段**（带 `Source` 标记） |
| 3 | **初始信任** | 一步到位要求接管                  | **只读观察期起步**，零风险进入                  |
| 4 | **交付顺序** | 先做能力最全的（双向同步/自动执行）        | **先读入 + 对齐，再回写，最后才谈自治**            |
| 5 | **商业叙事** | "AI 原生 CRM 平台"（与客户既有系统对撞） | "**你不在 CRM 里做的判断，我替你做，然后把结论送回去**"  |

**判定依据**：用户 2026-09-15 明确修正——**我方客户群体都有自研或套装 CRM（纷享销客、销售易等）**。此前文档的核心前提「我方客户多数没有成熟 CRM」被推翻，Rox「CRM 只是数据源、不淘汰现有系统」的策略因此从"对象不匹配"**翻转为直接适用**。

### 0.2 如果只能改一处代码，改哪里

> **修投递面断链。**

理由：这是全项目**唯一一处"指标全绿、链路全死"**&#x7684;地方，也是与 L1–L4 假绿同源的同一个错误。

| 事实                                                                                                  | 源码锚点                                  |
| --------------------------------------------------------------------------------------------------- | ------------------------------------- |
| 11 个定时器每 30 分钟在跑巡检（`crm-risk-scan` / `sales-daily-scan` / `named-visit-scan` / `lead-pool-recycle`） | `src/scheduler/timers.js`             |
| 13 类告警规则在判定                                                                                         | `src/alerts/alertRegistry.js`         |
| `trace 'sales-daily-scan' {hits:N}` 每天在刷，指标是绿的                                                      | `src/scheduler/timers.js`             |
| 🔴 但产出写进**进程内存 `new Map()`**                                                                        | `src/alerts/alertStore.js:6`          |
| 🔴 实例表 `crm.alert` **不存在**（**双重实证**：本地库 `information_schema` 仅见 `alert_rule` 规则表；全 `db/**/*.sql` 对 `crm.alert` 的建表语句零命中）         | 运行态 `information_schema` + `db/` 全域（2026-09-15 核验，见 §18.2） |
| 🔴 8 个查询端点**从未挂载**（`buildAlertHandlers` 全仓零调用，文件头自述"等挂载方统一 add"——**挂载方一直没来**）                       | `src/alerts/alertEndpoints.js:12-24`  |
| 🔴 `registerAlertHook` 未注册（`server.js:74` 只注册了 finance 版）                                           | `src/http/server.js:74`               |
| 🔴 工作台六视角**无信号视角**                                                                                  | `src/http/workbenchRouter.js:101-175` |
| 🔴 84 个页面中**无一调用** `api/alerts`                                                                     | `src/web/` grep 零命中                   |
| 🔴 IM / 短信通道 `钉钉·企业微信·wecom·dingtalk·lark·sms` 在 `src/` 下**全 0 命中**                                 | grep 零命中                              |

**结论**：感知面与判断面都已具备，**没有任何人能看到任何一条产出**。改这里不是加能力，是**把已经做好的东西接上电**——这是全案 ROI 最高、且当天可见效的一步。

### 0.3 一句话总纲

> **先让人看得见（S1 出口）→ 再让数据进得来（S2 入口）→ 判断才有据（S3）→ 结论才送得回去（S4）→ 然后才允许它自己动手（S6）。**  
> **顺序不可颠倒**：在链路断裂且无投递观测的前提下放开自动写，等于**把假绿放大成真错**。

### 0.4 ⚠ 关于"让 AI 主动干活"的起点修正（2026-09-15 追加）

> **不是"加授权"，而是"先修授权的依据"。**

平台**已经有一个在运行的常驻授权骨架**——按 `客户维(STRATEGIC/KEY/NORMAL) × 项目维(A/B/C)` 决定对象风险档 `LEAD/NORMAL/HIGH`，非 HIGH 且置信度达标即自主放行（源码实证见 §2.4）。**它不是零，不该按"从零引入"设计。**

但**它的审计链是断的**：分级配置不在 `POLICY_KEYS` 内（`policyVersion.js:29-34`），改一次分级不会产生新版本 → 回看历史决策时**无法回答"当时凭什么判 LEAD"**。在此状态下叠加新的授权凭证（T19），新凭证的溯源会挂在一条本就不通的依据上。

**因此最重要的三行改动（成本极低，价值极高，且先于 T19）**：

| # | 改动 | 位置 | 收益 | 状态 |
| - | --- | --- | --- | --- |
| **1** | 分级配置纳入 `POLICY_KEYS` | `policyVersion.js:29-34` | 分级变更 → 新版本；历史决策依据**永久可复现**（修 D3，最严重的一条） | ✅ **已实施**（2026-09-16，方案 i，含镜像机制） |
| **2** | 把 `decision_id` 写进分级行 | `businessTier.js:143`（新增列 + 入参） | "这条分级是谁批的"**可反查**（修 D2 溯源断链） | ⏳ 待批（属 A1/A2，需先加 5 列元数据） |
| **3** | `autonomous_allowed` 接入判定，或从配置面移除 | `autonomyEngine.js:274`（或 `decisionScenario.js:126`） | 消除"配了⛔人工却仍自动放行"的**假绿**（修 E1） | ✅ **已实施**（2026-09-16，方案 a） |

> **进度**：3 项中 **2 项已落地并验证**（§11.1.2 证据表）。**剩余第 2 项**（A1 元数据列 + A2 `decision_id` 落库）尚未实施——它需要先 `ALTER TABLE` 加 5 列，属独立改动，**待你确认**。
> 注意：**第 2 项不做，第 1 项的收益只兑现一半**——现在能回答"当时分级是什么"（版本冻结），但仍答不出"谁批准了这个分级"（无授权人字段）。

> **判据（批准前请核对）**：改完这三处后，对任一历史决策应能回答两个问题——**"当时的分级是什么"**（可复现）与**"谁批准了这个分级"**（可反查）。
> 这两问答不出来时，任何"事后审计 + 可撤回"的承诺都是**空头**。**先补这两问，再谈扩大自治范围。**



---

## §1 定位：反转、象限与借鉴边界

### 1.1 修正前后的判定

| 维度                       | 修正前的判定（错）     | 修正后的判定                                   |
| ------------------------ | ------------- | ---------------------------------------- |
| 客户现状                     | "多数没有成熟 CRM"  | **都有自研或套装 CRM**（纷享销客、销售易等）               |
| Rox "接现有 CRM、不淘汰"        | ❌ 对象不匹配，照搬无落点 | ✅ **直接适用**                               |
| IM / 邮件 / Excel（"事实发生地"） | P0            | **降为补充轨**——CRM 升为主数据源                    |
| 数据进来                     | 需新建 CSV 导入    | **优先 API 直连**；CSV 降为无 API 的自研 CRM / 台账兜底 |

### 1.2 定位象限（三方对照后的落位）

|                | 数据从哪来                                             | 对现有 CRM 的姿态                                                                    | 终局意图                                                                 |
| -------------- | ------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| **Attio**      | 自建记录系统（Universal Context™）                        | **要求搬迁**（官方路径 = Import2 一次性迁移；**无原生双向同步**，双向由第三方 Stacksync 提供）                 | 取代                                                                   |
| **Lightfield** | 自建记录系统（schema-less 先抓后建 + temporal context graph） | **要求搬迁，但把摩擦打到最低**（One-Hour Migration Agent：CSV → 90k 记录/时）                     | 取代（承诺数据可 API 带走）                                                     |
| **Rox**        | **借用客户系统**（warehouse-native）                      | **不要求换系统**——CRM 是 "just another data source feeding the SOR"，双向 writeback，三层同步 | **取代（已明牌）**：*"…and let's be honest: in that future, Rox is the CRM"* |
| **我方（本设计）**    | **接客户 CRM（API 直连）**                               | **不要求换系统，且不设取代终局**                                                             | **长期共生**（我方是判断层，客户 CRM 是记录层）                                         |


### 1.3 从 Rox 借什么 / 不借什么

| #  | Rox 的做法                                                                                                          | 借？         | 我方落点                                                                                          |
| -- | ---------------------------------------------------------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------- |
| 1  | **CRM 只是数据源**，不淘汰现有系统                                                                                            | ✅ 借        | 线 A 全程                                                                                        |
| 2  | **三层同步**（Mappings / Real-Time / Batch）                                                                           | ✅ 借前两层     | 线 A §5、§8                                                                                     |
| 3  | **乐观并发**（写前回拉 + 基线比对 + 不匹配中止 + 显式 force；**明确不依赖时钟**）                                                             | ✅ 借思想      | 我方已有同构（`casExpectStage`/`casExpectOwnerEmpty`，`particleRepo.js:203/232-242`）→ **扩到字段值，非新建机制** |
| 4  | **回写静态标记**（`Source='Rox'`）                                                                                       | ✅ 借        | `Source='crm-ai-native'`                                                                      |
| 5  | **"complementary, not competitive"** 的进入叙事                                                                       | ✅ 借        | §12 叙事：只读观察期 → 回写 → 再谈接管                                                                      |
| 6  | **商业终局"最终取代 CRM"**                                                                                               | ❌ **不借**   | 一旦对外写"最终取代"，"共生"叙事即刻自毁                                                                        |
| 7  | **主动性 90% 在投递层**（Daily Digest / Pre-Meeting Briefing / Slack / Home / To-Dos Dashboard / Notifications controls） | ✅ 借主次判断    | 线 B S1：投递优先于自动执行                                                                              |
| 8  | **常驻监控**（Stage-Aware Opportunity Risks / Agentic Deal Risk / Champion Tracking）                                  | ✅ 借        | 线 B T12 / T15 / T16                                                                           |
| 9  | **autopilot 全自动**                                                                                                | 🟡 **限档借** | 线 B T19 只开 T1 内部字段；T3 对外动作**永久不可常驻授权**                                                        |
| 10 | 治理在**读侧**（query-time access rules / field-level permissions / Access Provenance）                                 | ⚪ 不冲突      | 我方治理在**写侧**（第 0 闸 + 双阶段 token + 8 断言族）。**两者互补，非同一轴强弱**                                        |

> **Rox 官方免责声明（对手方自证）**：*"All AI-generated outputs… should be reviewed by authorized personnel before any action is taken"*、*"autopilot/autonomous… require initial configuration and ongoing oversight"* —— **最激进的厂商也承认必须人在环**。这为我方 HITL 铁律提供了外部背书。

---

## §2 现状：源码级盘点（统一口径）

> 口径：407 个 `src/*.js`（50,624 行）+ 15,297 行 HTML（84 个页面）+ `test/` 621 个文件（4,111 例）。  
> **凡"有 / 没有 X"的断言，本文一律给出 `file:line` 或"grep 零命中"两者之一。**


### 2.1 已有骨架（比预期深 —— 本设计不是从零建）

| #   | 能力                                                                                                                                                                                                                                                                  | 证据锚点                                                                          | 对本设计的意义                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------- |
| E1  | **租户级外部系统描述符** `config_store['integration-providers']`：`{ id, kind, enabled, endpoint, field_map, signal_map, credentials }`                                                                                                                                        | `src/connectors/discovery/tenantInstances.js:19-29`                           | **"接哪个外部系统"已是配置项，不是代码**                      |
| E2  | **kind → 工厂注册表**：`generic-rest` / `generic-mcp` / `generic-cli`                                                                                                                                                                                                     | `tenantInstances.js:9-13`                                                     | 加 `fxiaoke` / `neocrm` 走同一机制                 |
| E3  | **加密凭据保险库**（pgcrypto at-rest + 按租户解密 + 缺失回退同名 env + `persistSecret` fail-closed）                                                                                                                                                                                    | `credentialVault.js:34-49`、`:52+`                                             | 纷享 `appId/appSecret/permanentCode` 与销售易凭据有落点 |
| E4  | **定时拉取框架**：逐租户 → `loadAdapters` → `runWaterfall` → `monitorAccount`；间隔 `config_store['integration-poll']`（默认 6h）                                                                                                                                                    | `src/scheduler/timers.js:117-143`                                             | **对象级增量拉取可挂同一循环**（不新增定时器）                    |
| E5  | **入站 webhook 挂载点**：`POST /api/integration/webhook/:provider`（admin/sysadmin 闸）                                                                                                                                                                                      | `src/http/connectorRouter.js:11-25`、`:71`、`:80`                               | 对象变化事件订阅可复用此入口                               |
| E6  | **CAS 原子写**：`casExpectStage` + `casExpectOwnerEmpty`，命中时 WHERE 追加校验，`rowCount===0` 即拒                                                                                                                                                                               | `particleRepo.js:203`、`:232-242`                                              | **Rox"乐观并发"的我方同构** → 扩到字段值即可                 |
| E7  | **配置存储自带决策锚点**：`writeConfig(key, value, { tenantId, decisionId, updatedBy })`                                                                                                                                                                                       | `src/config/configStore.js:51`、`:64`                                          | 映射层配置**天然可审计、可挂决策**                          |
| E8  | **同步后重评闭环**：`monitorAccount` 做 rescore + appendMemory                                                                                                                                                                                                               | `monitorAccount.js:10-30`                                                     | 新数据进来后自动重评，**无需新建**                          |
| E9  | **巡检框架（11 个定时器）**：`nightly-distill` / `crm-risk-scan` / `lead-pool-recycle` / `decision-retro` / `sales-daily-scan` / `named-visit-scan` / `auditability-sla-snapshot` / **`ready-queue-pump`** / `provenance-patrol` / `integration-poll` / `calibration-sla-scan` | `src/scheduler/timers.js:163-466`、`riskScanner.js`、`salesDailyScan.js:52-109` | **感知面已在跑**；调度心跳直接复用 `ready-queue-pump`（60s）  |
| E10 | **告警判定（13 类规则）**：`approval_bottleneck` / `commit_red` / `coverage_gap` / `deal_stuck` / `forecast_breach` / `funnel_jitter` / `funnel_unhealthy` / `lead_overdue` / `lost_contact` / `named_visit_overdue` / `payment_due` / `payment_due_plan` / `payment_gap`     | `src/alerts/alertRegistry.js`、`ruleEvaluator.js`                              | **判断面 L1 已具备**，直接消费不重造                       |
| E11 | **事件触发层**：3 条规则（仅 `ontology` 域、`READ_ONLY_SKILLS` 全只读、冷却 300s + DB 去重 + 租户化），**已注册**                                                                                                                                                                                | `src/agent/eventTrigger.js`、`server.js:97`                                    | 骨架有、覆盖面窄 → **扩矩阵为三源（配置化）**                   |
| E12 | **`deferDecisionMint` 旁路**（handler 内自 mint，5 个 Action 已在用）                                                                                                                                                                                                          | `seed-actions.js:741/801/994/1055/1108`                                       | **常驻授权的现成范式**                                |
| E13 | **决策结果回写通道**（3 个 Action 已存在）                                                                                                                                                                                                                                        | `seed-actions.js:1791/1815/1870`                                              | **J2 反馈回路是"接电"不是造轮子**                        |
| E14 | **`agentTool: false` 免装配闭包范式**                                                                                                                                                                                                                                      | `connectorActions.js:132` 注释明文                                                | 同步/回写 Action 走此路，**免 agentSpec 三处同改**        |


### 2.2 缺口（逐条锚点）

| #   | 缺口                        | 证据                                                                                                                                                                          |
| --- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | **无 CRM 类适配器**            | `纷享/fxiaoke/销售易/xiaoshouyi/neocrm` **全仓零命中**；`salesforce/hubspot/zoho` 在 `src/` 仅 1 处且是 `anysite.js:105` 注释举例                                                               |
| G2  | **无对象级增量拉取**              | `timers.js:120-143` 现循环是"逐条富化"，**无游标、无对象遍历、无增量**                                                                                                                            |
| G3  | **无字段映射层**                | `genericRest.js:11` 的 `field_map` 是**单层扁平**（只服务 `enrich()`），**无方向、无类型校验、无静态值**                                                                                              |
| G4  | **无外部引用映射表**              | 无任何表/字段记录"客户 CRM 记录 ID ↔ 我方 particle_id"——**去重、幂等、回写定位的共同前提缺失**                                                                                                             |
| G5  | **无回写通道**                 | `connectorActions.js` 共 4 个 action（`:18` attio-enrich / `:53` zhizao-verify / `:99` tender-push / `:132` signal-lead-gen），**全部 write-into-us**                              |
| G6  | **无同步信任分级**               | 现范式 `autoDecision: true` → 每条写自 mint；批量同步若逐条 mint 会产生**决策洪水**                                                                                                               |
| G7  | **无同步可观测**                | 无同步成功率 / 游标滞后 / 冲突数 / 回写成功率落点                                                                                                                                               |
| G8  | **`updateParticle` 是浅合并** | `particleRepo.js:211` `{ ...cur.payload, ...patch }`——嵌套对象会被整体替换                                                                                                            |
| G9  | 🔴 **投递面断链**              | 见 §0.2 十行表格（`alertStore.js:6` 内存 Map / `crm.alert` 表不存在 / 端点零挂载 / hook 未注册 / 无视角 / 无页面 / 无 IM 通道）                                                                           |
| G10 | 🔴 **授权面结构性压制**           | `src/mcp/gateway.js:201` `if (!params?.decision_id && !def?.deferDecisionMint)` → **无决策依据即拒写**；`eventTrigger` 注释明文"事件触发任务无 decision_id，写操作必被第 0 闸拒" → 主动派发只能派 `kind:'read'` |
| G11 | **无中国协同系统通道**             | `钉钉/飞书/企业微信/wecom/dingtalk/lark` → `src/` 下 **0 命中**                                                                                                                        |
| G12 | **无 CSV 导入**              | `parseCsv/parseCSV/csv-parse` → `src/` 下 **0 命中**（仅 `billingRoutes.js:137` 有 CSV 导出）                                                                                        |

### 2.3 一条必须点破的结构性矛盾

|                                                                               |
| ----------------------------------------------------------------------------- |
| **我方安全模型的隐含假设是「每个写动作都由人发起并 mint 决策」——这与「主动」天然冲突。**                            |
| 要真正让 AI 主动干活，需要一个**常驻授权（standing authorization）**：先授权一个范围，范围内自动执行，事后审计 + 可撤回。 |
| **这不是取消第 0 闸，而是给它增加一类合法凭证**（§11.3）。                                           |

### 2.4 ⚠ 前提修正：常驻授权**已有一半**，不是从零引入

> **本节为 2026-09-15 源码级核验结论，修正 §2.3 与上一版的表述偏差。**
> 上一版写"必须引入常驻授权"，措辞暗示该能力为零。**核验后判定该措辞错误**——平台**已存在一个可运行、可配置、已驱动自主放行的分级授权机制**。
> 正确的表述是：**骨架已在，缺的是"授权对象化"的那一半**。

**已有的一半（源码实证，非推断）**：

| 常驻授权要素 | 现状 | 源码锚点 |
| --- | --- | --- |
| ① **授权范围界定** | ✅ **已落地** | `crm.business_tier_config`：`(dimension, dimension_value) → tier`，二维 `customer × project`（`db/schema.sql:248-254`） |
| ② **范围内差异化放行** | ✅ **已落地** | `autonomyEngine.js:274` `escalated = forceException \|\| tier==='HIGH' \|\| (tier!=='HIGH' && conf < threshold)` |
| ③ **事后审计（执行留痕）** | ✅ **已落地** | 决策落库 `state='AUTONOMOUS'` / `decider_type='AUTONOMOUS_AGENT'`（`autonomyEngine.js:292-295`）+ `recordDecisionEvent('autonomous')` |
| ④ **范围可配置、可后台改** | ✅ **已落地** | `PUT /api/business-tier-config`（`businessTier.js:151`），写走第 0 闸 `requireDecision('config-change')`（`:102-110`） |
| ⑤ **租户级隔离** | ✅ **已落地** | 复合 PK `(tenant_id, dimension, dimension_value)` + `ensureTenantBusinessTiers` 懒克隆（`businessTier.js:47-60`） |

**用户实际配置的二维（`db/migrate.js:386-399` 出厂种子 + `src/web/pipeline.html:67-68` 前端入口）**：

| 维度 | 取值 | tier 映射 |
| --- | --- | --- |
| `customer` | `STRATEGIC` / `KEY` / `NORMAL` | HIGH / HIGH / NORMAL |
| `project` | **`A` / `B` / `C`** | HIGH / NORMAL / **LEAD** |

> **两维取高风险优先**（`decisionRepo.js:68` `rank = Math.max(rank, ...)`）。因此**「C 类项目」不等于「低风险」**：若客户维为 `STRATEGIC`/`KEY`，整体 tier 仍为 `HIGH` → 一律升级，C 类也不例外。

**缺的另一半（三个断点，全部为源码级实证）**：

| # | 断点 | 现状 | 证据 |
| --- | --- | --- | --- |
| **D1** | **无授权元数据** | 表仅 4 列，无 `approved_by` / `approved_at` / `expires_at` / `revoked_at` / `decision_id` | `db/schema.sql:248-254` |
| **D2** | **溯源断链** | 写分级**确实**生成了第 0 闸决策（`produceDecision`），但**决策 id 不落库**，只回显给前端 → 事后无法回答"这条分级是谁批的" | `businessTier.js:102-110` 产出 → `:143` 仅 `res.json` 回显 |
| **D3** | **分级配置不在决策冻结范围内** | `POLICY_KEYS` 9 个键**不含**分级项；改一次分级，历史决策的 `effective_policy_version` **完全不变** | `policyVersion.js:29-34` |
| **D4** | **无撤回/暂停语义** | `upsertTier` 只有 `ON CONFLICT DO UPDATE SET tier=$4`，改值即"撤回"；无"暂停该授权范围"的操作面与语义 | `businessTier.js:92-98` |

> **D3 是最严重的一条**：`policyVersion.js:4-6` 明确声明"事后改配置**不得洗掉**历史决策的判定依据"——**该承诺对分级配置不成立**。回看一条 `tier=LEAD → AUTONOMOUS` 的历史决策，无法回答"当时为什么判 LEAD"，因为判定依据（分级表）既无版本冻结、也无变更留痕。**审计链在此处断开。**

**另两个附带实证缺陷（与本设计直接相关，须一并修）**：

| # | 缺陷 | 说明 | 证据 |
| --- | --- | --- | --- |
| **E1** | `autonomous_allowed` **配置面 ≠ 执行面（假绿）** | 前端显示 `✅自主/⛔人工`、配置页映射 `auto_decision`，但 `requireDecision` 主路径**完全不读该字段** → 配了不生效 | 配置面 `decisionScenario.js:126` / `controlledConfigPages.js:84`；执行面 `autonomyEngine.js:274` 未引用。`:251` 的 `highNoAuto` 为 dead variable |
| **E2** | **`A/B/C` 术语碰撞** | `advice.tier` 的 A/B/C（对话建议档位，默认 C）与 `project_tier` 的 A/B/C（项目分级）**同名不同义**，且默认值语义相反 | `adviceStore.js:32-33`（`'C'` → `NORMAL`）vs `migrate.js:398`（`'C'` → `LEAD`） |

**结论（本设计 §11 的修正立场）**：

> **不是"引入常驻授权"，而是"把已运行的分级机制升级为可审计、可撤回的授权对象"。**
> 具体为 4 条：**(1)** 补授权元数据列；**(2)** 补 `decision_id` 落库（接上 D2 溯源）；**(3)** 把分级配置纳入 `POLICY_KEYS`（修 D3 审计断链）；**(4)** 补 `paused` / `revoked` 状态语义与操作面（修 D4）。
> 其中 **(3) 是成本最低、价值最高的一条**——单点改动即可让全部历史与后续决策的自主判定依据变得可追溯。

---

## §3 目标 / 非目标 / 硬约束

### 3.1 目标

1. 客户**不必停用/搬迁**任何既有 CRM，我方在其旁建立**上下文与判断层**；
2. 客户 CRM 的真实数据成为我方决策输入（消除"AI 无上下文 → 九尺子 8 项评分恒 0"的死结）；
3. 我方产出的富化 / 洞察 / 决策结论**写回客户 CRM 指定字段**，进入客户日常工作流；
4. 我方的主动产出**出现在人一定会看到的地方**（不止是"能查到"）；
5. 低风险动作在**受控授权**下自动执行，且**可审计、可回滚、可停**。

### 3.2 非目标（明确不做）

- 不做完整双向同步（变更来源消歧 + pending 对账 + Fivetran 级管道）；
- 不做"取代客户 CRM"的任何产品叙事或技术路线；
- 不做 schema-less 自由生长（Lightfield 路线）；
- 不做任意脚本 / 表达式映射；
- 不做"发送即送达"式的无证据投递；
- 不做 always-on 全自动。


### 3.3 硬约束（继承既有，不可偏离）

| 约束                    | 出处                                          | 遵守方式                                                                                                                             |
| --------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **不新增粒子类型 / 不改业务域模型** | 2026-09-08 已批设计 §10                         | 读入落既有 `CRM_ACCOUNT`/`CRM_CONTACT`/`CRM_DEAL`/`CRM_LEAD`/`CRM_PRODUCT`（`db/schema.sql:14`）；6 张新表**全为运行态表**（与 `crm.tasks` 同类，非粒子域） |
| **绝对禁 DELETE**        | 项目铁律                                        | 同步只增改；外部记录消失 → `external_deleted_at` 软标记；关闭信号 / 撤销授权 / 否决执行**全部为状态字段变更**                                                         |
| **写操作过决策第 0 闸**       | 铁律                                          | 批量入库一次 run mint 一个决策（`sync_cursor.decision_id`）；回写逐批审批；常驻授权走 `deferDecisionMint` 并带 `grant_ref`                                  |
| **租户隔离**              | `src/http/tenantScope.js:4` `scopeTenant()` | 全部新表带 `tenant_id`；配置 per-tenant；凭据按租户解密                                                                                          |
| **配置 100% 后台化**       | 项目铁律                                        | 映射 / 频率 / 方向 / 信任级别 / 节律 / 渠道路由全在 `config_store`，**零硬编码字面量**                                                                     |
| **HITL 零信任**          | 项目铁律                                        | 首次接入、映射变更、信任级别提升、启用回写 → 人工确认；**信任级别不可自动提升**                                                                                      |
| **建表单一事实源**           | 项目约定                                        | 6 张表 DDL 追加 `db/schema.sql`；`CREATE TABLE IF NOT EXISTS` + `ALTER ADD COLUMN IF NOT EXISTS` 补列                                   |
| **凭据不出口**             | 项目约定                                        | 沿用 `credentialVault` pgcrypto at-rest；token 缓存值亦加密落库，不进日志 / 前端 / memory                                                          |
| **不静默失败**             | 项目约定                                        | 投递失败写 `last_error` + `monitor_event`；巡检失败 `recordFailure`；降级/暂停发通知                                                               |

---


## §4 总体架构：三条线

```
┌──────────────────────────────────────────────────────────────────────┐
│  客户既有 CRM（纷享销客 / 销售易 / 自研）—— 记录层，我方不取代        │
└───────────────┬──────────────────────────────────┬───────────────────┘
                │ ① 读入（增量 + 游标）             │ ④ 回写（白名单字段）
                ▼                                  ▲
┌──────────────────────────────────────────────────────────────────────┐
│  线 A｜共生同步线  src/sync/                                         │
│  engine · cursor · upsert · entityResolver · CrmProvider 契约        │
│  ── crm.external_ref（外部记录 ↔ 粒子 稳定对应，去重/幂等的共同前提）│
│  ── crm.sync_cursor（游标 · 运行态留痕）                             │
└───────────────┬──────────────────────────────────────────────────────┘
                │ ② 落既有粒子（不新增粒子类型）
                ▼
┌──────────────────────────────────────────────────────────────────────┐
│  我方判断层（既有）                                                  │
│  粒子 + 七维记忆矩阵 + 决策脊柱 + K-M-D 管道 + 九尺子（8 确定性+1 LLM）│
│  + 决策第 0 闸 + 8 断言族 + 19 个 method-* SKILL + Action Registry    │
└───────────────┬──────────────────────────────────────────────────────┘
                │ ③ 判断产出（告警 / 建议 / 执行）
                ▼
┌──────────────────────────────────────────────────────────────────────┐
│  线 B｜主动运行时  src/signal/                                       │
│  感知（三源触发器）→ 判断（L1阈值/L2上下文/L3主动研究）              │
│  → 投递（inbox/email/im/webhook 四 provider）→ 授权（常驻授权 T1）   │
│  ── crm.signal（统一收口，替换内存 Map）                             │
│  ── crm.signal_delivery（投递流水，**防假绿核心**）                  │
│  ── crm.standing_grant + crm.grant_execution（自治 + 执行流水）      │
└───────────────┬──────────────────────────────────────────────────────┘
                │ ⑤ J2 反馈回写（hitl_verdict → decision.outcome）
                └──────────────► 回到判断层（闭环三条腿补齐）
```

**线间关系（关键）**：线 B 的排名 7–8 客户价值（一键采纳、自动执行）**依赖线 A**——"采纳"的落点之一就是"回写客户 CRM"。反之线 A 的 S3 之后也依赖线 B 的投递面（同步失败要让人知道）。**两线共用同一套运行态表与配置层，不重复建设。**

---

## §5 方案选型

### 5.1 线 A（共生同步）

| 维度       | 方案 A 适配器扩展式                                    | **方案 B 同步内核 + 统一契约（选定）**                             | 方案 C 借道第三方 iPaaS        |
| -------- | ---------------------------------------------- | ---------------------------------------------------- | ----------------------- |
| 做法       | 仅加 `fxiaoke`/`neocrm` 两个 kind，复用扁平 `field_map` | 新建 `src/sync/` 内核 + 厂商适配器实现统一 `CrmProvider`          | 不自建，由轻易云类平台推到我方 webhook |
| 接第二家成本   | 复制粘贴（映射能力不足）                                   | 写一个适配器，内核不动                                          | 零开发                     |
| 回写落点     | 无                                              | 契约方法 `writeBack()`                                   | 需外部平台反向开发               |
| 映射可审计性   | 低                                              | **高**（落 `config_store`，可 diff / 可回滚 / 可挂 decisionId） | 低（黑盒）                   |
| 与"可验证"定位 | 中                                              | **高**                                                | **低**                   |
| 长期成本     | **高**（每接一家重构一次）                                | 低                                                    | 中（供应商锁定）                |

**选 B 的判据**：①"接第二家"必然发生（客户名单中同时有纷享销客、销售易、自研）；②方案 A 的单层扁平 `field_map` 撑不住对象级同步与回写，届时仍要重构成 B，已完成的工作返工；③方案 C 的数据链路在黑盒中，与"可验证可审计"定位直接冲突，并引入供应商与合规风险。

### 5.2 线 B（主动运行时）

|                   | 做法                                               | 风险           | 判定                                 |
| ----------------- | ------------------------------------------------ | ------------ | ---------------------------------- |
| A · 投递补链式         | 只挂载接口 + 建表 + 进待办 + 首页卡                           | 最低           | 不够（用户已定"全四层"）                      |
| **B · 四层渐进式（选定）** | S1 出口 → S2 入口/感知 → S3 判断 → S4 回写 → S5 研究 → S6 授权 | 逐层可独立交付 / 回滚 | ✅                                  |
| C · 授权优先式         | 先做常驻授权与自主执行，投递当附属                                | **最高**       | ❌ **在"没人看得见"的状态下放开写权限，等于把假绿放大成真错** |

---

## §6 补齐清单（扩展已有骨架，零新概念）

> **补齐** = 复用既有机制，仅扩展 schema / 分支 / 语义。


### 6.1 线 A 补齐

| 优先     | #    | 补齐项                                     | 现状锚点                                                                          | 动作                                                                                                                     | 客户价值                         |
| ------ | ---- | --------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| **P0** | A-B1 | `integration-providers` 描述符扩为"同步对象契约"   | `tenantInstances.js:19-29` 现读 `id/kind/enabled/endpoint/field_map/signal_map` | 增 `objects[]`（`{name, direction, cadence_min, mapping_ref, cursor, id_field, since_field}`）、`token_mode`、`trust_level` | "接哪个系统、哪些对象、怎么同步"变成**管理员配置** |
| **P0** | A-B2 | `credentialVault` 支持结构化凭据               | `credentialVault.js:34-49` 现把整段密文当单个字符串密钥                                     | 允许 JSON 结构（纷享 `appId/appSecret/permanentCode`、销售易账号密钥）；token 缓存值与过期时间**加密落库**，不落内存全局                                   | 客户凭据不出口、不进日志、不进前端            |
| **P0** | A-B3 | `tenantInstances.KIND_FACTORY` 加两个 kind | `tenantInstances.js:9-13` 现 3 个 kind                                          | 加 `fxiaoke`、`neocrm`（自研 CRM 用 `generic-rest` 覆盖）                                                                       | 客户无论用哪家套装都能接                 |
| **P0** | A-B4 | CAS 语义从"阶段/归属"扩到"字段值"                   | `particleRepo.js:203`（签名）、`:232-242`（实现）                                      | 增 `casExpectField: {path, value}` / `casExpectExternalUpdatedAt`；不匹配即在 WHERE 层拒绝并**回传最新值**                             | **回写安全的地基**（Rox 乐观并发的我方实现）   |
| **P1** | A-B5 | `connectorRouter` 增"对象变化事件"路由分支         | `connectorRouter.js:11-25` 现 webhook 只派发 `conn-signal-lead-gen`               | 按 `event.object` 路由到同步内核 upsert；沿用 admin/sysadmin 闸                                                                    | 从"每 6h 轮询"升级为"客户 CRM 一变我就知道" |
| **P1** | A-B6 | `integration-poll` 增"对象增量拉取"分支          | `timers.js:120-143` 现仅逐条富化                                                    | 在既有租户循环内增分支：按 `objects[].cursor` 拉增量 → 内核 upsert；沿用 `recordTokens` 与 `emit('trace')`                                   | **不新增定时器、不改调度框架**，零调度层回归风险   |
| **P1** | A-B7 | `monitorAccount` 复用为"同步后重评"             | `monitorAccount.js:10-30`                                                     | upsert 落地后调用，触发 rescore + appendMemory                                                                                 | 新数据立刻影响决策，无需新建重评链路           |
| **P2** | A-B8 | `updateParticle` 增嵌套感知合并选项              | `particleRepo.js:211` 浅合并                                                     | 增 `patchMode: 'deep'`（仅同步路径启用；**默认保持浅合并不改既有语义**）                                                                       | 增量同步不误伤同层其它字段                |

### 6.2 线 B 补齐

| #        | 补齐项                                   | 现状                               | 落点                                                                   |
| -------- | ------------------------------------- | -------------------------------- | -------------------------------------------------------------------- |
| **B-B1** | 挂载 `alertEndpoints` 的 8 个端点           | 清单存在、处理器存在、**零调用**               | `src/http/routes.js`                                                 |
| **B-B2** | 注册 `registerAlertHook`                | 未注册（`server.js:74` 只有 finance 版） | `src/http/server.js`                                                 |
| **B-B3** | `alertStore` 由内存 Map 迁 DB             | 内存 Map、表不存在                      | `src/alerts/alertStore.js`、`db/schema.sql`                           |
| **B-B4** | 工作台增加信号视角（第 7 视角）                     | 六视角无信号                           | `src/http/workbenchRouter.js`（对齐 `:101-175` case 结构）                 |
| **B-B5** | 首页信号卡（对齐 Rox Home）                    | 无                                | `src/web/home.html`                                                  |
| **B-B6** | 事件触发从单域扩为三源                           | 仅 `ontology`                     | `src/agent/eventTrigger.js`（键名 `agent-event-trigger` 不变，**向后兼容扩矩阵**） |
| **B-B7** | 复用 SMTP（抽公共 mailer）                   | SMTP 仅计费域在用                      | 抽 `src/mail/`，计费域与信号域共用                                              |
| **B-B8** | 复用 13 类规则 + `salesDailyScan` 作为 L1 判断 | 已实现                              | 直接消费，**不重造**                                                         |
| **B-B9** | 复用 `ready-queue-pump` 作为调度心跳          | 已实现（60s）                         | 直接复用，**不新增定时器**                                                      |

---

## §7 新增清单（真正新建）


### 7.1 线 A 新增

| 优先     | #    | 新增项                                       | 为什么必须新建                                                               | 落地位置                                                                                                                                                                   |
| ------ | ---- | ----------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P0** | A-N1 | **厂商无关同步内核**                              | 无任何"增量拉取 / 游标推进 / upsert / 实体对齐"引擎（`integration-poll` 是逐条富化循环，不是同步引擎） | `src/sync/`（`engine.js` / `cursor.js` / `upsert.js` / `entityResolver.js`）；契约方法 `discoverObjects()` / `readIncremental(cursor)` / `writeBack(fields)` / `verifyAuth()` |
| **P0** | A-N2 | **字段映射层** `config_store['sync-mappings']` | 现 `field_map` 是适配器内扁平字典，**无方向、无类型校验、无静态值、不可独立审计**                     | 声明式结构（见 §9.1）；映射变更走 HITL + `decisionId`                                                                                                                                |
| **P0** | A-N3 | **外部引用映射表** `crm.external_ref`            | 无机制记录"客户 CRM 记录 ↔ 我方粒子"对应（G4）。**去重、幂等、回写定位的共同前提**                     | 新表（§8.1）。**不新增粒子类型**，仅映射表                                                                                                                                              |
| **P0** | A-N4 | **单向回写通道**（新 Action）                      | 4 个 connector action 全为 write-into-us（G5）                             | `sync-writeback-fields`（`kind:'write'`, `namespace:'sync'`, `agentTool:false`, `needsApproval:true`, `autoDecision:true`）；**必带静态标记** `Source='crm-ai-native'`          |
| **P0** | A-N5 | **同步信任分级** `config_store['sync-trust']`   | 现每条写自 mint → 批量同步会决策洪水；完全免检则违背写侧零信任                                   | 三档：**L1 只读** / **L2 批量入库**（一次 run mint 一个决策）/ **L3 回写**（逐批审批 + 首 N 批人工确认）。**默认 L1 起步**                                                                                 |
| **P1** | A-N6 | **同步可观测指标**                               | 无成功率/滞后/冲突/回写成功率（G7）                                                  | 复用 `src/monitor/` + `emit('trace')`；指标 `sync_lag_minutes` / `sync_success_rate` / `conflict_count` / `writeback_count`，**上墙门户页**                                       |


### 7.2 线 B 新增

| #        | 新增项                                                                                     | 说明                                                               | 为何必须新建                     |
| -------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | -------------------------- |
| **B-N1** | `crm.signal` 表                                                                          | 信号统一收口（rule-scan / event-trigger / agent-research / external 四源） | 内存 Map 无法支撑投递、去重、审计        |
| **B-N2** | `crm.signal_delivery` 表                                                                 | 投递流水（渠道 / 收件人 / 状态 / 错误 / 重试）                                    | **防假绿**：`send 被调用` ≠ `已送达` |
| **B-N3** | `src/signal/` 模块                                                                        | `store` / `router` / `digest` 三件套                                | 统一收口，避免重蹈"清单在但挂载方没来"       |
| **B-N4** | `src/signal/delivery/` provider 契约 + 四实现                                                | `inbox` / `email` / `im` / `webhook`                             | 用户已定"全渠道可配置"               |
| **B-N5** | `config_store['signal-delivery']`                                                       | 渠道路由（severity→channel、role→recipient）、频次上限、静默时段                  | 阈值配置化铁律 + 防骚扰              |
| **B-N6** | `config_store['signal-schedule']`                                                       | 时间型节律表（T+n 未跟进、报价 T+n 未审批、阶段静默等）                                 | 让时间型触发**配置化而非硬编码**         |
| **B-N7** | L3 主动研究调度 `config_store['agent-research-schedule']`                                     | 按节律选对象 → 跑**只读 SKILL** → 产出建议卡                                   | 判断面从阈值升到"想好了"              |
| **B-N8** | `crm.standing_grant` + `crm.grant_execution` + `config_store['standing-grants-policy']` | 常驻授权凭证 + 执行流水 + 全局策略                                             | 授权面（§11.3）                 |
| **B-N9** | `src/web/signal-center.html`                                                            | 信号中心页（列表 / 筛选 / 采纳 / 否决 / 静默）                                    | 人一定会看到的地方                  |

---

## §8 数据模型（6 张新表）

> 遵循项目约定：`CREATE TABLE IF NOT EXISTS`；`tenant_id` 默认 `'system'`；**不物理 DELETE**（软态翻转）；DDL 追加 `db/schema.sql`（单一事实源）。  
> **6 张表全部为运行态表，非粒子域**，与 `crm.tasks` 同类——**不触碰 §10「不新增粒子类型、不改业务域模型」**。


### 8.1 `crm.external_ref` —— 外部引用映射（线 A｜A-N3）

```sql
-- 用途：客户 CRM 记录 ↔ 我方粒子 的稳定对应关系。去重、幂等 upsert、回写定位的共同前提。
-- 铁律：不物理 DELETE（外部记录消失 → external_deleted_at 软标记）；tenant_id 全表隔离。
CREATE TABLE IF NOT EXISTS crm.external_ref (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             TEXT NOT NULL DEFAULT 'system',
  provider              TEXT NOT NULL,              -- fxiaoke | neocrm | generic-rest | ...
  external_object       TEXT NOT NULL,              -- 客户 CRM 侧对象 API 名（如 AccountObj / account）
  external_id           TEXT NOT NULL,              -- 客户 CRM 侧记录主键
  particle_type         TEXT NOT NULL,              -- 我方粒子类型（既有类型，禁新增）
  particle_id           UUID NOT NULL,
  external_updated_at   TIMESTAMPTZ,                -- 客户侧最后修改时间（增量游标依据）
  last_synced_at        TIMESTAMPTZ,
  last_direction        TEXT,                       -- in | out（最近一次同步方向，供冲突定位）
  last_hash             TEXT,                       -- 上次同步内容哈希（变更检测 / 冲突比对）
  external_deleted_at   TIMESTAMPTZ,                -- 软态：客户侧已删除（绝不物理删我方粒子）
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider, external_object, external_id)
);
CREATE INDEX IF NOT EXISTS idx_external_ref_particle
  ON crm.external_ref(tenant_id, particle_type, particle_id);
CREATE INDEX IF NOT EXISTS idx_external_ref_cursor
  ON crm.external_ref(tenant_id, provider, external_object, external_updated_at);
```

**`particle_type` 仅取既有值**：`CRM_ACCOUNT` / `CRM_CONTACT` / `CRM_DEAL` / `CRM_LEAD` / `CRM_PRODUCT`（来源 `db/schema.sql:14` 注释）。


### 8.2 `crm.sync_cursor` —— 同步运行留痕（线 A｜A-N3）

```sql
-- 每租户 × provider × object 一行"运行态"（禁删：upsert 更新，不新建行历史堆积）
CREATE TABLE IF NOT EXISTS crm.sync_cursor (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          TEXT NOT NULL DEFAULT 'system',
  provider           TEXT NOT NULL,
  external_object    TEXT NOT NULL,
  cursor_value       TEXT,                          -- 增量游标（last_modified 时间戳 / 自增水位）
  last_run_at        TIMESTAMPTZ,
  last_status        TEXT NOT NULL DEFAULT 'idle'   -- idle | running | ok | degraded | failed
                     CHECK (last_status IN ('idle','running','ok','degraded','failed')),
  last_error         TEXT,
  last_counts        JSONB NOT NULL DEFAULT '{}'::jsonb,  -- { read, created, updated, skipped, conflicted }
  token_cost         NUMERIC NOT NULL DEFAULT 0,
  decision_id        UUID,                          -- 本批同步所挂决策锚点（写侧第 0 闸）
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider, external_object)
);
CREATE INDEX IF NOT EXISTS idx_sync_cursor_health
  ON crm.sync_cursor(tenant_id, last_status, last_run_at);
```


### 8.3 `crm.signal` —— 信号统一收口（线 B｜B-N1，替换内存 Map）

```sql
CREATE TABLE IF NOT EXISTS crm.signal (
  signal_id     TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL DEFAULT 'system',
  source        TEXT NOT NULL,                      -- rule-scan | event-trigger | agent-research | external
  kind          TEXT NOT NULL,                      -- 13 类告警 kind + 新增 kind
  severity      TEXT NOT NULL,                      -- low | medium | high
  target_role   TEXT NOT NULL,                      -- sales | finance | exec | ops
  owner_id      TEXT NULL,                          -- 责任人（投递路由第一依据）
  l2c_stage     TEXT NULL,
  particle_id   TEXT NULL,
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
  evidence      JSONB NOT NULL DEFAULT '{}'::jsonb, -- 证据链（来源、快照、阈值、规则版本）
  suggestion    JSONB NOT NULL DEFAULT '{}'::jsonb, -- 建议卡（L3）：{headline, reasoning, evidence_refs, action_name, action_params}
  status        TEXT NOT NULL DEFAULT 'open',       -- open | acked | closed | acted
  dedup_key     TEXT NULL,                          -- 幂等去重键：kind:particle_id:bucket
  decision_id   TEXT NULL,
  action_ref    TEXT NULL,                          -- 采纳后触发的 Action 名
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  acked_at      TIMESTAMPTZ NULL,
  closed_at     TIMESTAMPTZ NULL,
  closed_reason TEXT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_signal_dedup
  ON crm.signal(tenant_id, dedup_key) WHERE dedup_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_signal_inbox
  ON crm.signal(tenant_id, owner_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_signal_open_kind
  ON crm.signal(tenant_id, kind, status);
```

**幂等写入语义**：`ON CONFLICT (tenant_id, dedup_key) DO UPDATE SET payload/severity/created_at`（**更新而非新建**），避免同一事实每 30 分钟刷一条。`bucket` 由 `config_store['signal-schedule'].bucket` 决定（默认按日）。

### 8.4 `crm.signal_delivery` —— 投递流水（线 B｜B-N2，**防假绿核心表**）

```sql
CREATE TABLE IF NOT EXISTS crm.signal_delivery (
  delivery_id  TEXT PRIMARY KEY,
  signal_id    TEXT NOT NULL,
  tenant_id    TEXT NOT NULL DEFAULT 'system',
  channel      TEXT NOT NULL,                       -- inbox | email | im | webhook
  provider     TEXT NULL,                           -- smtp | dingtalk | wecom | feishu | custom
  recipient    TEXT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',     -- pending | sent | failed | skipped
  attempts     INT NOT NULL DEFAULT 0,
  last_error   TEXT NULL,
  provider_msg_id TEXT NULL,
  delivered_at TIMESTAMPTZ NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_delivery_signal ON crm.signal_delivery(signal_id);
CREATE INDEX IF NOT EXISTS idx_delivery_fail
  ON crm.signal_delivery(tenant_id, status, created_at DESC);
```

> **负向判据**：任何一次 `send` 调用都必须留下 `sent` 或 `failed` 行。**若渠道配置为启用状态而表中无对应投递行，视为假绿，验收不通过。**


### 8.5 `crm.standing_grant` —— 常驻授权凭证（线 B｜B-N8）

```sql
CREATE TABLE IF NOT EXISTS crm.standing_grant (
  grant_id        TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL DEFAULT 'system',
  title           TEXT NOT NULL,
  scope_actions   TEXT[] NOT NULL,                  -- 可自动执行的 Action 白名单
  scope_objects   TEXT[] NULL,                      -- 限定对象类型
  field_whitelist TEXT[] NULL,                      -- 允许自动写入的字段（T1 内部字段）
  risk_tier       TEXT NOT NULL DEFAULT 'T1',       -- T1 | T2 | T3
  max_uses        INT NULL,
  used_count      INT NOT NULL DEFAULT 0,
  period          TEXT NULL,                        -- day | week
  limit_payload   JSONB NOT NULL DEFAULT '{}'::jsonb, -- 业务约束（金额上限等）
  status          TEXT NOT NULL DEFAULT 'active',   -- active | paused | revoked | expired
  approved_by     TEXT NOT NULL,
  approved_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  decision_id     TEXT NULL,                        -- 授权动作自身的决策凭证（溯源铁律）
  expires_at      TIMESTAMPTZ NULL,
  revoked_at      TIMESTAMPTZ NULL,
  revoked_reason  TEXT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_grant_active
  ON crm.standing_grant(tenant_id, status, risk_tier);
```

> **与既有分级表的分工（§11.0 三轴模型）**：本表是 **B/C 轴**（动作边界 + 授权凭证），承载"**这类动作能否自动做**"；
> `crm.business_tier_config` 是 **A 轴**（对象风险），承载"**这个对象值不值得人管**"。两者**不合并、不互替**——一次自动执行的放行需要两轴同时满足。
> `risk_tier`（T0–T3）**不是** `business_tier`（LEAD/NORMAL/HIGH）的重命名，两者粒度与语义均不同，**严禁相互赋值**。

### 8.6 `crm.grant_execution` —— 自主执行流水（线 B｜B-N8）

```sql
CREATE TABLE IF NOT EXISTS crm.grant_execution (
  execution_id TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL DEFAULT 'system',
  grant_id     TEXT NOT NULL,
  signal_id    TEXT NULL,                           -- 由哪条信号触发
  action_name  TEXT NOT NULL,
  target_id    TEXT NULL,
  before_state JSONB NOT NULL DEFAULT '{}'::jsonb,  -- 执行前快照（对照/回滚参照）
  after_state  JSONB NOT NULL DEFAULT '{}'::jsonb,
  decision_id  TEXT NULL,                           -- 执行决策（actor='standing-auth'）
  actor        TEXT NOT NULL DEFAULT 'standing-auth',
  hitl_verdict TEXT NULL,                           -- adopted | rejected | pending
  rejected_at  TIMESTAMPTZ NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_exec_grant ON crm.grant_execution(grant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_exec_verdict
  ON crm.grant_execution(tenant_id, hitl_verdict, created_at DESC);
```

---

## §9 配置层（100% 后台化，零硬编码）

**全部 per-tenant，全部经既有 `readConfig(key,{tenantId})` / `writeConfig(key, value, {tenantId, decisionId, updatedBy})`**（`src/config/configStore.js:51/64`，自带 `decisionId` —— **写配置本身即带决策依据**）。


### 9.1 `config_store['sync-mappings']`（线 A｜A-N2，**声明式白名单**）

```jsonc
{
  "version": 1,
  "mappings": [
    {
      "object": "AccountObj",
      "particle_type": "CRM_ACCOUNT",
      "direction": "in",
      "identity": { "external_id_field": "_id", "since_field": "last_modified_time" },
      "fields": [
        { "external": "name",           "particle": "name",           "type": "string", "required": true },
        { "external": "industry",       "particle": "industry",       "type": "string" },
        { "external": "annual_revenue", "particle": "annual_revenue", "type": "number" },
        { "external": "owner_name",     "particle": "owner_name",     "type": "string" }
      ],
      "filters": { "exclude_deleted": true }
    },
    {
      "object": "AccountObj",
      "particle_type": "CRM_ACCOUNT",
      "direction": "out",
      "identity": { "external_id_field": "_id" },
      "fields": [
        { "external": "ai_fit_score",   "particle": "fit_score",   "type": "number" },
        { "external": "ai_next_action", "particle": "next_action", "type": "string" }
      ],
      "static_on_write": { "Source": "crm-ai-native" }
    }
  ]
}
```

**约束**：① 字段必须是**已声明的映射项**，未知字段一律拒绝（防越权字段写）；② `particle` 目标必须是既有粒子字段，**不支持表达式 / 脚本**（防注入）；③ 映射变更走 HITL + `decisionId` 落 `config_store`。

### 9.2 `config_store['sync-trust']`（线 A｜A-N5，信任分级）

```jsonc
{
  "version": 1,
  "default_level": "L1",
  "levels": {
    "L1": { "label": "只读观察期", "allow_read": true,  "allow_upsert": false, "allow_writeback": false },
    "L2": { "label": "批量入库",   "allow_read": true,  "allow_upsert": true,  "allow_writeback": false,
            "decision_granularity": "per_run" },
    "L3": { "label": "启用回写",   "allow_read": true,  "allow_upsert": true,  "allow_writeback": true,
            "decision_granularity": "per_run",
            "first_n_batches_require_human": 3 }
  },
  "writeback_fields_whitelist": ["ai_fit_score", "ai_next_action", "ai_risk_flags"]
}
```

### 9.3 `config_store['integration-providers']`（**扩展**，非新建）

```jsonc
{
  "id": "fxiaoke-prod",
  "kind": "fxiaoke",
  "enabled": true,
  "trust_level": "L2",
  "token_mode": "corp-access-token",   // 纷享：appId+appSecret+permanentCode → CorpAccessToken（7200s，须缓存）
  "objects": [
    { "name": "AccountObj",     "direction": "in", "cadence_min": 30, "mapping_ref": "AccountObj" },
    { "name": "ContactObj",     "direction": "in", "cadence_min": 60, "mapping_ref": "ContactObj" },
    { "name": "OpportunityObj", "direction": "in", "cadence_min": 30, "mapping_ref": "OpportunityObj" }
  ],
  "event_subscription": { "enabled": false, "objects": [] }
}
```

### 9.4 线 B 配置键

| 键                               | 语义        | 关键字段                                                                                                                                                                            |
| ------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `signal-schedule`（B-N6）         | 时间型节律表    | `rules[]: {id, kind, entity_type, condition, threshold, period, severity, target_role, enabled}`、`bucket`（去重窗口，默认 `day`）、`enabled`                                              |
| `signal-delivery`（B-N5）         | 渠道与路由     | `channels: {inbox:on, email:on, im:off, webhook:off}`、`route: {high:[im,email], medium:[email], low:[inbox]}`、`role_recipients`、`quiet_hours`、`rate_limit: {per_day, per_hour}` |
| `signal-digest`                 | 作战简报      | `enabled`、`period`（`daily`）、`at`（如 `08:30`）、`max_items`、`order`、`include_low`                                                                                                   |
| `agent-event-trigger`（B-B6 扩矩阵） | 变更型触发矩阵   | 沿用现键，行内新增 `source:'event'`，域从 `ontology` 扩到 `particle`/`approval`/`decision`；**旧行语义不变（向后兼容）**                                                                                   |
| `agent-research-schedule`（B-N7） | L3 主动研究节律 | `enabled`、`period`、`max_objects_per_run`、`daily_llm_budget`、`concurrency`、`select_rule`                                                                                         |
| `standing-grants-policy`（B-N8）  | 常驻授权全局策略  | `default_tier:'T1'`、`allow_tier_upgrade_by_ai:false`、`auto_pause_on_consecutive_rejects:3`、`max_daily_executions`、`notify_on_execution:true`                                    |

---

## §10 投递抽象（线 B｜provider 契约）

### 10.1 契约

```
provider = {
  id,                       // 'inbox' | 'email' | 'im' | 'webhook'
  verifyConfig(config),     // 配置自检（缺凭据/域名非法 → 拒绝启用，fail-closed）
  send({ signal, recipient, channelConfig }) → { ok, provider_msg_id, error }
}
```

新增实现（B-N4）：`inbox`（平台内，默认启用）、`email`（复用 §6.2 B-B7 抽出的公共 mailer）、`im`（dingtalk / wecom / feishu，**仅外发**）、`webhook`（通用）。

### 10.2 投递流程

```
signal 落库(crm.signal)
  → router 读 config_store['signal-delivery']
  → 按 severity / target_role / owner_id 计算收件人与渠道集合
  → 频次与静默时段闸（超限 → status='skipped' 并留痕，不静默丢弃）
  → 逐渠道 send
  → 每次 send 落 crm.signal_delivery（sent / failed + last_error）
  → 失败重试（attempts ≤ config），最终失败进 monitor_event（不静默）
```

> **判据**：`skipped` 必须留痕（防"静默丢弃"）；`failed` 必须带 `last_error`。

---

## §11 授权面：常驻授权（线 B）

### 11.0 三轴模型：既有分级与新增授权的关系（**本节为 §2.4 核验后的架构定调**）

常驻授权在本设计中**不是单表新建**，而是**三条正交轴的合成**。其中 A 轴已在生产运行，B/C 轴为本次新增：

| 轴 | 载体 | 取值 | 回答的问题 | 现状 |
| --- | --- | --- | --- | --- |
| **A · 对象风险轴** | `crm.business_tier_config` | `LEAD` / `NORMAL` / `HIGH`（由 `customer × project` 推出） | **这个对象值不值得人管？** | ✅ **已落地运行**（§2.4） |
| **B · 动作边界轴** | `crm.standing_grant.risk_tier` | `T0` / `T1` / `T2` / `T3` | **这类动作能不能自动做？** | ❌ 本次新增（§8.5） |
| **C · 授权凭证轴** | `crm.standing_grant.status` | `active` / `paused` / `revoked` / `expired` | **这一次自动执行凭什么被允许？** | ❌ 本次新增（§8.5） |

**放行判定 = A 轴 × B 轴 的交集**（此前只用了 A 轴）：

```
自动执行  ⟺  对象 tier ∈ {LEAD, NORMAL}   ← A 轴（已有，autonomyEngine.js:274）
          ∧  置信度 conf ≥ effectiveThreshold   ← 已有
          ∧  动作 ∈ standing_grant.scope_actions   ← B 轴（新增：此前无动作白名单）
          ∧  写入字段 ⊆ standing_grant.field_whitelist ← B 轴（新增：此前无字段白名单）
          ∧  凭证 status = 'active' 且未超限 ← C 轴（新增）
```

> **关键缺口（此前被忽略）**：现状在 A 轴放行后，**写什么字段没有任何边界**——`tier ≠ HIGH` + 置信度达标即自主，未限定 Action 与字段。**这是本设计必须补上的真实风险敞口**，也是 §11.3 首批只开 `T1` 内部字段的原因。

### 11.1 核心立场

**不取消第 0 闸，而是给它增加一类合法凭证，并同时补全既有分级轴的授权语义。** `src/mcp/gateway.js:201` 的判据语义不变；常驻授权走 `deferDecisionMint` 这条**已有旁路**（`:741/801/994/1055/1108` 五处已在用），只把 actor 从 `mcp` 换成 `standing-auth`，并强制带 `grant_ref`。

**对 A 轴的 4 项补全（§2.4 的 D1–D4，与 B/C 轴同批实施）**：

| 补全项 | 修什么 | 落地方式 | 优先级 |
| --- | --- | --- | --- |
| **A1** 授权元数据列 | D1：表仅 4 列 | `ALTER TABLE crm.business_tier_config ADD COLUMN IF NOT EXISTS` × 5（`approved_by` / `approved_at` / `decision_id` / `expires_at` / `revoked_at`） | P0 |
| **A2** `decision_id` 落库 | D2：决策产生了但不存 | `businessTier.js:143` 把 `produceDecision` 的返回写入行内（新增 `upsertTier` 参数） | P0 |
| **A3** 分级配置纳入版本冻结 | **D3：审计断链（最严重）** | `policyVersion.js:29-34` 的 `POLICY_KEYS` 增加分级项；**按该文件 :27 既定语义，增键后所有后续决策解析出新版本——此为期望行为** | **P0** |
| **A4** 撤回 / 暂停语义 | D4：改值即撤回，无操作面 | 复用 `status` 语义（`active`/`paused`/`revoked`）；撤回 = 状态变更，**零 DELETE** | P1 |

> **A3 已裁决（2026-09-16，用户批准）→ 采用方案 i（键镜像）**。

**A3 实施方案 i 的具体设计（已批准，可实施）**：

| 项 | 内容 |
| --- | --- |
| 镜像键 | `config_store['business-tier-config']`，`value = { rules: [{dimension, dimension_value, tier}, ...], mirror_count }` |
| 同步点 | `businessTier.js` 的 `upsertTier` 成功后**紧随写镜像**（复用 `writeConfig(key, value, {tenantId, decisionId})`，`decisionId` 复用同一第 0 闸凭据 → **镜像变更本身也可溯源**）。⚠ 非严格 DB 事务（项目用连接池、无事务封装），改用 **fail-closed** 补偿：镜像失败即抛错让 PUT 失败，不留"配置改了但冻结没跟上"的半态 |
| 存量回填 | 迁移脚本把 `business_tier_config` 全量镜像一次（幂等）；**回填后读回校验**条数（不是"写完即绿"），不等则抛错 |
| 纳入冻结 | `policyVersion.js:29-34` 的 `POLICY_KEYS` 追加 `'business-tier-config'` |
| 一致性守护 | **必须配一条反向探针**：`verifyMirrorConsistency` 比对镜像 `rules.length` vs 表行数，不等 → `emit trace` + `recordFailure` + 返回 `ok:false`（镜像漂移 = 冻结的是**过期依据**，比不冻结更危险） |
| **❌ 禁止项** | **镜像 value 禁放任何易变字段**（时间戳/随机值）——见下方实证发现 ① |

> **为什么方案 i 是正确的取舍**：镜像让"分级配置"进入 `config_store` 这一**既有版本冻结通道**，不改 `loadSnapshot` 内核，且天生继承 per-tenant + autoSeed + 第 0 闸三套既有语义。

#### 11.1.2 实施结果与实证发现（2026-09-16，已实施并验证）

**实施状态：A3（方案 i）+ E1（方案 a）已落地**，改动 5 个文件、验证 3 类证据。

| 证据 | 结果 |
| --- | --- |
| `test/decision.test.js` | 16/16 ✅（含**新增 E1 负向哨兵**） |
| `test/calibration/`（autonomyEngine 下游） | 316/316 ✅ |
| `test/business-tier-tenant.integration.test.js` + `test/web/businessTier.test.js` | 12/12 ✅ |
| A3 端到端闭环（临时脚本，已删） | 4/4 ✅：幂等复用 / 改分级→新版本 / 改回→复用原版本 / 镜像一致性 16==16 |
| `db/migrate.js` 存量回填（测试库实跑） | 8 个租户全部回填，读回校验一致 ✅ |
| **自证鉴别力（负向对照）** | ① 移除 `!sceneAllowsAuto` → E1 哨兵变红（`expected 'autonomous' to be 'escalated'`）② 移除 `business-tier-config` 键 → A3 闭环 ② 变红（改分级不产生新版本）✅ |

**实证发现 ①（真 bug，实施期捕获）：内容寻址快照禁放易变字段**

初版镜像写了 `mirrored_at: new Date().toISOString()`。后果：`policyVersion` 用**内容哈希**寻址（`:55-58`），时间戳每次不同 → **每次镜像都解析成"新版本"** → 版本表爆炸，并直接破坏该文件 `:9` 声明的不变量 **I6「内容相同 → 复用既有版本 id」**。
**根因**：把"元数据"混进了"内容"。**修法**：镜像 value 只留语义内容（`rules` / `mirror_count`），写入时间由 `config_store.updated_at` 列承载。
> **可迁移判据**：凡进入**内容寻址/哈希去重**机制的数据，写入前逐字段审一遍「这个字段值相同吗」——时间戳、随机 id、写入者、自增序号一律不得入内。

**实证发现 ②（需知悉，非缺陷）：新增 `POLICY_KEYS` 键会产生一次性版本跃迁**

`policyVersion.js:27` 已明示「增键即改版本语义：加一个键会让所有后续决策解析出新版本——这是**期望行为**」。因此本次上线后，**分级相关的首次解析必然产生一个新版本**，此后进入稳态。
**对历史决策无影响**：旧决策已冻结在旧版本上，新版本只影响此后产生的决策。**取基线时必须先让镜像进入稳态**，否则会误判成"幂等失效"（本次验证脚本初版即踩此坑）。

### 11.1.1 附带缺陷修法（E1 / E2）

**E1 已裁决（2026-09-16，用户批准）→ 采用方案 a（接入执行面）。**

**方案 a 的精确语义（必须与 2026-08-28 裁定共存，不可写成"TRUE 即自主"）**：

```js
// src/decision/autonomyEngine.js:274 — 改后
escalated = forceExecution               // EXCEPTION 强制 HITL（不变）
  || tier === 'HIGH'                     // 高风险一律升级（不变）
  || sc.autonomous_allowed !== true      // ★新增：场景未声明允许自主 → 一律升级
  || (tier !== 'HIGH' && conf < effectiveThreshold);  // 置信度门控（不变）
```

| 语义要点 | 说明 |
| --- | --- |
| `autonomous_allowed` 是**必要条件，不是充分条件** | `TRUE` 仍需过置信度门控（**尊重 2026-08-28 裁定**，见下） |
| `FALSE` / 未设 → **一律升级** | fail-closed，符合"HITL 零信任"铁律 |
| 用 `!== true` 而非 `!x` | `undefined` 也归入升级（保守方向正确；用 `!x` 语义相同但可读性差） |

> **与 2026-08-28 裁定的兼容性论证（必读，否则会被误判为推翻裁定）**：
> `docs/specs/2026-08-25-ai-native-crm-overall-design.md:617` 的裁定原文禁的是——「`autonomous_allowed=TRUE` **无条件自主放行**（绕过置信度门控）」。
> 本方案**只增加 FALSE 侧的收紧，完全不放松 TRUE 侧**：`TRUE` 依然要过 `conf ≥ effectiveThreshold`。**裁定禁止的那条路径在新公式下仍被禁止。**
> 佐证：`autonomyEngine.js:251` 的 `highNoAuto = tier === 'HIGH' && !sc.autonomous_allowed` 是 dead variable——**原作者的意图本就包含该字段**，只是写了一半。方案 a 是**补完原作者意图**，而非推翻 2026-08-28 裁定。

**行为影响面（已核验，须在实施后回归）**：

| 场景 | `default_tier` | `autonomous_allowed` | 接入后行为变化 |
| --- | --- | --- | --- |
| `LEAD_FOLLOW_UP` / `POST_CONTRACT` / `LOSS_REVIEW` / `LEAD_FIT` / `PARTICLE_UPDATE` | LEAD / NORMAL | `TRUE` | **无变化** |
| `OPP_QUALIFY` / `SOLUTION_VALUE` | NORMAL | `FALSE` | ⚠️ **收紧**：由"可能自主"→"一律升级" |
| `QUOTE_PRICING` / `SIGN_RISK` / `ATTR_SCHEMA_CHANGE` / `CALIBRATION_CHANGE` | HIGH | `FALSE` | 无变化（本就一律升级） |

> 测试影响核验结论：`test/decision.test.js:147-159` 的自主用例走 `LEAD_FOLLOW_UP`（`TRUE`）→ 不破；`:168-174` 的 `OPP_QUALIFY` 用例走 `disposition:'EXCEPTION'`（`forceException` 先命中）→ 不破。**仍须实跑确认。**

| 缺陷 | 修法 | 不做会怎样 |
| --- | --- | --- |
| **E1** `autonomous_allowed` 假绿 | ✅ **已裁决 = 方案 a**（见上） | 管理员配了"⛔人工"却仍被自动放行，是**安全承诺失效** |
| **E2** `A/B/C` 术语碰撞 | 配置面与文档统一区分命名：项目分级写 **`项目分级(A/B/C)`**，对话建议档写 **`建议档位`**；`adviceStore.js:33` 增加注释锚定语义 | 读代码/看配置时把两个 C 当成一回事，造成误判 |


### 11.2 闭环三要素

| 要素              | 机制                                                                                                         |
| --------------- | ---------------------------------------------------------------------------------------------------------- |
| **授权凭证自己带决策依据** | 凭证经既有审批流（`CRM_APPROVAL_FLOW`）批准 → `standing_grant.decision_id` 非空。**溯源铁律不破**：任何自动执行的源头都可追到一次人工批准           |
| **执行仍 mint 决策** | 执行时 handler 内 mint，`decision` 记 `actor='standing-auth'` + `grant_ref` + `autonomy_level` → 可回答"这个动作为什么被允许" |
| **执行留前后快照**     | `grant_execution.before_state/after_state` → 可对照、可判断是否需要回填                                                 |

### 11.3 分级与首批边界（用户已定 T1）

| 档      | 内容                           | 首批                     |
| ------ | ---------------------------- | ---------------------- |
| **T0** | 只读 / 研究 / 建议产出               | ✅ 无需授权（现状）             |
| **T1** | **内部字段写**：AI 属性、评分、标签、研究结论回填 | ✅ **首批开放**             |
| T2     | 客户可见内部动作：跟进记录、任务、提醒          | ❌ 本轮不开                 |
| T3     | 对外动作：发信、阶段推进至 S7/S8          | ❌ **永久不可常驻授权**（必须前置审批） |

> **T1 判定标准**：「**客户不可见、不对外、可对照回填**」。凡写入内容会被客户看到的，一律不低于 T2。

### 11.4 熔断 / 降级 / 撤回（全部为状态变更，零 DELETE）

| 机制         | 规则                                                                                                                   |
| ---------- | -------------------------------------------------------------------------------------------------------------------- |
| 用量熔断       | `used_count` 达 `max_uses`（或 `period` 内上限）→ `status='paused'` + 通知                                                    |
| **信任降级**   | `grant_execution.hitl_verdict='rejected'` **连续 N 次**（默认 3，读 `standing-grants-policy`）→ 自动 `paused` + 通知 + `trace` 留痕 |
| **不可自动提升** | `allow_tier_upgrade_by_ai:false` 写死；档位提升必须新批一次授权（新 `grant_id`）                                                       |
| 到期         | `expires_at` 到期 → 调度扫为 `expired`（状态变更）                                                                               |
| 撤回         | `revoked_at` + `revoked_reason`；已执行动作进审计链，**不删除**                                                                    |

### 11.5 与人机反馈闭环的衔接（**同时接上 J2 缺口**）

`grant_execution.hitl_verdict` 的三态（`adopted` / `rejected` / `pending`）→ 经既有 `crm_decision_outcome_write`（`seed-actions.js:1791`）回写决策结果。

**这一步同时补上了此前判定的 P0 缺口**：`decision.outcome` 长期无输入、闭环三条腿缺一条。**常驻授权的执行流水天然就是 J2 的数据源**——无需另造入口。

---


## §12 铁律映射（统一）

| 铁律                         | 本设计的遵守点                                                                                         | 违反即失败判据                       |
| -------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------- |
| **不新增粒子类型 / 不改业务域模型（§10）** | 6 张新表全为运行态表（非粒子域）；`external_ref.particle_type` 仅取既有值；信号 `kind` 复用既有 13 类                        | 出现新粒子类型常量                     |
| **绝对禁 DELETE**             | 外部记录消失 → `external_deleted_at` 软标记；关闭信号 / 撤销授权 / 否决执行**全为状态字段变更**                               | 同步或信号路径出现任何 `DELETE FROM`     |
| **写操作过决策第 0 闸**            | 批量入库：一次 run mint 一个决策（`sync_cursor.decision_id`）；回写：逐批审批；常驻授权：`deferDecisionMint` + `grant_ref` | 产生无 `decision_id` 的粒子写入       |
| **租户隔离**                   | 6 张表均带 `tenant_id`；配置 per-tenant；凭据按租户解密；投递路由按 `tenant_id + owner_id`                           | 跨租户读到他人映射 / 凭据 / 游标 / 信号      |
| **配置 100% 后台化**            | 映射 / 频率 / 方向 / 信任级别 / 回写白名单 / 节律 / 渠道路由全部走 `config_store`                                       | 代码内出现对象名 / 字段名 / 频率字面量        |
| **HITL 零信任**               | 首次接入、映射变更、信任级别提升、启用回写 → 人工确认；L3 前 3 批逐次人工确认                                                     | 自动提升信任级别 / 自动启用回写 / 自动放宽 tier |
| **建表单一事实源**                | 6 张表 DDL 追加 `db/schema.sql`                                                                     | DDL 散落在别处                     |
| **凭据不出口**                  | 沿用 `credentialVault` pgcrypto at-rest；token 缓存值亦加密落库                                            | 凭据进日志 / 前端 / memory           |
| **不静默失败**                  | 投递失败写 `last_error` + `monitor_event`；巡检失败 `recordFailure`；降级 / 暂停发通知；`skipped` 亦留痕              | 任何一路失败无留痕                     |
| **装配闭包三处同改**               | 新 Action 走 `agentTool:false`（范式 `connectorActions.js:132`），**免 agentSpec 三处同改**                 | `assertAgentAssembly` 断言失败    |
| **决策依据须可追溯（C3 冻结）** | **分级配置（A 轴）纳入 `POLICY_KEYS`**（`policyVersion.js:29-34`）；授权元数据落 `decision_id`（§11.1 A1/A2/A3） | 改配置后历史决策判定依据不可复现；分级变更无决策凭证 |
| **配置面与执行面一致（反假绿）** | `autonomous_allowed` 要么接入放行判定、要么从配置面移除；**不得"配了不生效"**（§11.1.1 E1） | 配置显示"⛔人工"仍被自动放行 |

---

## §13 生命契约（20 任务，覆盖全部 7 个名册 agent）

> **字段语义**：见 `brainstorming` SKILL §A。`contract_task_id` **必填**，值须等于 `src/agent/contractIds.js` 的 `CONTRACT_IDS[agent]`。  
> **校验命令（P7 强制）**：
>
> ```bash
> node scripts/validate-contract.mjs docs/2026-09-15-final-design-coexistence-and-proactive.md --registry src/agent/agentSpec.js
> ```
>
> **任务编号对照**：`A-Tn` → `T0n`（线 A，n=1..9）；`A-T10` → `T10`；`B-Tn` → `T1n`（线 B，n=1..9）；`B-T10` → `T20`。


### 线 A｜共生同步线

#### T01 同步内核 + 字段映射层

```contract-yaml
- task: "T01 新建 src/sync 同步内核 + config_store['sync-mappings'] 声明式映射层"
  contract_task_id: ct-intake-route
  agent: intake-router
  skills: [method-intake-routing]
  memory: [intake-router]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "给定 mock CrmProvider 与映射配置，engine.runOnce 返回 {read,created,updated,skipped}；同批重复执行 created=0 且无重复行；未知字段被拒绝并计入 skipped"
```

**契约说明：** 本任务由 `intake-router`（接诊 = 数据进入与路由的同源职责）承接，调用 `method-intake-routing`、读 `intake-router` 记忆（L1，≤2 跳）；成功标准为内核在 mock provider 下完成增量同步且幂等、未知字段被拒。

#### T02 纷享销客适配器

```contract-yaml
- task: "T02 实现 fxiaoke CrmProvider 适配器（discoverObjects/readIncremental/verifyAuth）并注册 kind"
  contract_task_id: ct-intake-route
  agent: intake-router
  skills: [data-particle-read]
  memory: [intake-router]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "verifyAuth 用 mock 凭据换取 CorpAccessToken 并缓存（二次调用不打网络）；discoverObjects 解析 /cgi/crm/object/list 返回预置+自定义对象清单"
```

**契约说明：** 本任务由 `intake-router` 承接，调用 `data-particle-read`、读 `intake-router` 记忆（L1）；成功标准为鉴权换取+缓存与对象元数据发现均通过 mock 验证。

#### T03 外部引用映射与实体对齐

```contract-yaml
- task: "T03 建 crm.external_ref 与 crm.sync_cursor 表并实现 entityResolver 幂等 upsert"
  contract_task_id: ct-intake-route
  agent: intake-router
  skills: [data-particle-read]
  memory: [intake-router]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "同一 external_id 二次同步命中既有 particle_id 且不新建粒子；external_deleted_at 软标记后原粒子仍存在（零 DELETE 核验）"
```

**契约说明：** 本任务由 `intake-router` 承接，调用 `data-particle-read`、读 `intake-router` 记忆（L1）；成功标准为幂等对齐与软删除语义，且全程零 DELETE。

#### T04 单向回写通道

```contract-yaml
- task: "T04 新增 sync-writeback-fields Action（write-back-out，带 Source 静态标记 + 字段级 CAS）"
  contract_task_id: ct-decision
  agent: decision-agent
  skills: [method-decision-execute]
  memory: [decision-agent]
  knowledge_scope: { layers: [L1, L2], max_hops: 3 }
  success: "回写仅作用于白名单字段；外部记录已被他人修改时 CAS 拒绝并回传最新值（不静默覆盖）；写入携带 Source='crm-ai-native'"
```

**契约说明：** 本任务由 `decision-agent`（决策执行同源职责）承接，调用 `method-decision-execute`、读 `decision-agent` 记忆（L1–L2）；成功标准为白名单约束 + CAS 拒绝 + 静态标记三项同时成立。

#### T05 同步信任分级

```contract-yaml
- task: "T05 落地 config_store['sync-trust'] 三档信任分级与决策 mint 粒度"
  contract_task_id: ct-intake-route
  agent: intake-router
  skills: [method-intake-routing]
  memory: [intake-router]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "L1 下 upsert 被拒且无任何写入；L2 下整批仅产生 1 个 decision_id；L3 提升需人工确认（无自动提升路径）"
```

**契约说明：** 本任务由 `intake-router` 承接，调用 `method-intake-routing`、读 `intake-router` 记忆（L1）；成功标准为三档行为可验证且信任级别不可自动提升。

#### T06 事件订阅接入

```contract-yaml
- task: "T06 connectorRouter 增对象变化事件路由 + 定时增量分支接入 followup 重评"
  contract_task_id: ct-followup
  agent: followup-agent
  skills: [method-followup-engine]
  memory: [followup-agent]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "对象变化事件 5 分钟内触发该账户重评，重评结果 appendMemory 且 payload.discovery 其它子键不被覆盖"
```

**契约说明：** 本任务由 `followup-agent`（跟进节奏同源职责）承接，调用 `method-followup-engine`、读 `followup-agent` 记忆（L1）；成功标准为事件触发重评的及时性与 payload 子键完整性。

#### T07 同步可观测

```contract-yaml
- task: "T07 同步指标落 monitor 并可上墙（lag/success_rate/conflict/writeback）"
  contract_task_id: ct-retro-decision
  agent: decision-retro
  skills: [decision-retrospective]
  memory: [decision-retro]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "sync_cursor 每轮更新 last_counts 与 last_status；失败轮次 emit trace 且 recordFailure 非静默；指标接口按 tenant_id 隔离返回"
```

**契约说明：** 本任务由 `decision-retro`（校准与复盘同源职责）承接，调用 `decision-retrospective`、读 `decision-retro` 记忆（L1）；成功标准为运行态留痕完整、失败不静默、租户隔离。

#### T08 产品与价格表同步（报价基线来源）

```contract-yaml
- task: "T08 扩展同步对象至产品与价格表（落既有 CRM_PRODUCT / CRM_PRICE_LIST）作为报价基线"
  contract_task_id: ct-quote-calc
  agent: quote-engine
  skills: [method-quote-engine]
  memory: [quote-engine]
  knowledge_scope: { layers: [L1], max_hops: 3 }
  success: "同步后报价引擎能命中客户侧真实产品与价格；基线缺失时明确报缺而非按默认价计算（降级纪律）"
```

**契约说明：** 本任务由 `quote-engine`（报价基线的同源职责）承接，调用 `method-quote-engine`、读 `quote-engine` 记忆（L1–L2）；成功标准为命中真实基线且缺基线时明确报缺。

#### T09 同步记录与拓客候选去重

```contract-yaml
- task: "T09 同步记录入库前与拓客候选/公海线索去重核对"
  contract_task_id: ct-prospecting
  agent: prospecting
  skills: [prospecting-select]
  memory: [intake-router]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "已存在于客户 CRM 的企业不再作为新拓客候选产出；命中既有账户时候选被标注 skip 并给出已有 account_id"
```

**契约说明：** 本任务由 `prospecting`（拓客候选的同源职责）承接，调用 `prospecting-select`、读 `intake-router` 记忆（L1）；成功标准为不与外部 CRM 已有账户重复产出候选。

#### T10 接入与映射变更评审闸门（HITL 落点）

```contract-yaml
- task: "T10 首次接入 / 映射变更 / 信任级别提升 / 启用回写 四类动作接入 review-gate 人工审批闸门"
  contract_task_id: ct-review-gate
  agent: review-gate
  skills: [method-review-gate]
  memory: [review-gate]
  knowledge_scope: { layers: [L1], max_hops: 3 }
  success: "四类动作未获人工放行时一律被拒（fail-closed）；放行记录留 decision_id 与审批人；无自动放行路径"
```

**契约说明：** 本任务由 `review-gate`（闸门与放行的同源职责）承接，调用 `method-review-gate`、读 `review-gate` 记忆（L1）；成功标准为四类动作 fail-closed 且无自动放行路径。


### 线 B｜主动运行时线

#### T11 信号统一收口

```contract-yaml
- task: "T11 新建 crm.signal 表与 signalStore，alertStore 由内存 Map 迁移为 DB 幂等 upsert"
  agent: intake-router
  contract_task_id: ct-intake-route
  skills: [method-intake-routing]
  memory: [intake-router]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "createAlert 落 crm.signal 且进程重启后仍可查；同 (tenant_id,dedup_key) 二次写入走 ON CONFLICT 更新而非新建（行数不增）；DDL 存在于 db/schema.sql 单一事实源；表内无任何 DELETE 路径"
```

**契约说明：** 本任务由 `intake-router`（数据进入与承载的同源职责）承接，调用 `method-intake-routing`、读 `intake-router` 记忆（L1，≤2 跳）；成功标准为持久化 + 幂等 + 单一事实源 + 零 DELETE 四项同时成立。

#### T12 感知三源触发器

```contract-yaml
- task: "T12 感知层扩为三源触发器（timer/event/external），eventTrigger 向后兼容扩矩阵"
  agent: intake-router
  contract_task_id: ct-intake-route
  skills: [method-intake-routing, method-dialog-router]
  memory: [intake-router, followup-agent]
  knowledge_scope: { layers: [L1, L2], max_hops: 3 }
  success: "三类 source 各有一条规则可被触发；旧矩阵 3 行语义不变且不报错；变更型新增域（particle/approval/decision）触发后落 crm.signal 且 dedup 生效；非只读 SKILL 派发仍被拒并留 trace"
```

**契约说明：** 本任务由 `intake-router` 承接，调用 `method-intake-routing` 与 `method-dialog-router`、读 `intake-router`/`followup-agent` 记忆（L1–L2，≤3 跳）；成功标准为三源可用、旧行为不回归、只读闸不放松。

#### T13 投递抽象层与四渠道 provider

```contract-yaml
- task: "T13 新建 src/signal/delivery provider 契约与 inbox/email/im/webhook 四实现，落 signal_delivery 流水"
  agent: followup-agent
  contract_task_id: ct-followup
  skills: [method-followup-engine]
  memory: [followup-agent]
  knowledge_scope: { layers: [L1, L2], max_hops: 2 }
  success: "四 provider 各实现 verifyConfig/send；send 失败落 signal_delivery 行 status=failed 且 last_error 非空；未配置凭据的渠道 verifyConfig 拒绝启用（fail-closed）；超频次或静默时段落 status=skipped 且留痕"
```

**契约说明：** 本任务由 `followup-agent`（触达与节奏的同源职责）承接，调用 `method-followup-engine`、读 `followup-agent` 记忆（L1–L2）；成功标准为四渠道可插拔 + 失败不静默 + 配置自检 fail-closed。

#### T14 信号进入工作台与首页信号卡

```contract-yaml
- task: "T14 工作台增加信号视角 + 首页信号卡 + 每日作战简报（消费 signal-digest 配置）"
  agent: followup-agent
  contract_task_id: ct-followup
  skills: [method-followup-engine, method-funnel-classification]
  memory: [followup-agent, quote-engine]
  knowledge_scope: { layers: [L1, L2], max_hops: 2 }
  success: "buildViewRows('signals') 返回本租户本角色可见信号；首页信号卡数量与同视角条数一致（不出现两套口径）；简报条目数受 max_items 与 rate_limit 约束；空态返回空数组而非抛错"
```

**契约说明：** 本任务由 `followup-agent` 承接，调用 `method-followup-engine` 与 `method-funnel-classification`、读 `followup-agent`/`quote-engine` 记忆；成功标准为视角可用、口径唯一、限额生效、空态安全。

#### T15 报价与阶段推进的时间型信号

```contract-yaml
- task: "T15 报价待审批超时/阶段静默/价格基线漂移三类时间型信号接入节律表"
  agent: quote-engine
  contract_task_id: ct-quote-calc
  skills: [method-quote-engine, method-stage-progression]
  memory: [quote-engine, followup-agent]
  knowledge_scope: { layers: [L1, L2], max_hops: 3 }
  success: "三类信号的阈值全部读 config_store（无字面量）；阈值调整后同批数据命中集合随之改变（可证配置生效）；命中落 crm.signal 且 severity/target_role 按配置分档"
```

**契约说明：** 本任务由 `quote-engine` 承接，调用 `method-quote-engine` 与 `method-stage-progression`、读 `quote-engine`/`followup-agent` 记忆（L1–L2，≤3 跳）；成功标准为阈值配置化可证、命中分档正确。

#### T16 主动拓客信号

```contract-yaml
- task: "T16 公海 S0 停滞/候选池触达窗口/线索回收前预警三类拓客信号"
  agent: prospecting
  contract_task_id: ct-prospecting
  skills: [prospecting-search, method-outreach-hook]
  memory: [intake-router]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "S0 超期未认领、S0P 回收前 T-3 天、候选池触达窗口三类各产出一条信号；与既有 lead-pool-recycle 扫描不重复产同 dedup_key；拓客信号只提醒不改动归属（写入为零）"
```

**契约说明：** 本任务由 `prospecting` 承接，调用 `prospecting-search` 与 `method-outreach-hook`、读 `intake-router` 记忆（L1）；成功标准为三类信号各产一条、去重不重复、**写入为零**。

#### T17 L3 智能体主动研究：产出建议卡

```contract-yaml
- task: "T17 主动研究调度：按节律选对象→跑只读 SKILL→产出带推理链与证据的建议卡"
  agent: decision-agent
  contract_task_id: ct-decision
  skills: [method-decision-enrich, discovery-research]
  memory: [decision-agent]
  knowledge_scope: { layers: [L1, L2], max_hops: 5 }
  success: "每轮研究对象数不超过 max_objects_per_run；LLM 调用不超过 daily_llm_budget（超预算降级不抛错）；建议卡的 reasoning 与 evidence_refs 均非空（缺证据时输出降级说明而非编造）；本任务不产生任何粒子写入"
```

**契约说明：** 本任务由 `decision-agent`（决策研究的同源职责）承接，调用 `method-decision-enrich` 与 `discovery-research`、读 `decision-agent` 记忆（L1–L2，≤5 跳）；成功标准为限额生效、证据非空（缺则降级说明）、**零粒子写入**。

#### T18 建议卡采纳回路与 J2 回写

```contract-yaml
- task: "T18 建议卡一键采纳（人 mint 决策调既有 Action）与否决回写决策结果"
  agent: decision-agent
  contract_task_id: ct-decision
  skills: [method-decision-execute, data-particle-create, data-particle-read]
  memory: [decision-agent, review-gate]
  knowledge_scope: { layers: [L1, L2], max_hops: 5 }
  success: "采纳路径必携带 decision_id（无则被第 0 闸拒）；采纳后 signal.status='acted' 且 action_ref 落库；否决后 hits crm_decision_outcome_write 且 decision.outcome 行数增加（可观测）"
```

**契约说明：** 本任务由 `decision-agent` 承接，调用 `method-decision-execute`/`data-particle-create`/`data-particle-read`、读 `decision-agent`/`review-gate` 记忆；成功标准为采纳必带决策、否决必回写可观测。

#### T19 常驻授权凭证与 T1 自动执行

```contract-yaml
- task: "T19 crm.standing_grant/crm.grant_execution 落地：审批流批准→T1 字段白名单内自动执行→前后快照留痕"
  agent: review-gate
  contract_task_id: ct-review-gate
  skills: [method-review-gate, data-particle-read]
  memory: [review-gate, quote-engine]
  knowledge_scope: { layers: [L1, L2], max_hops: 4 }
  success: "凭证必须经审批流批准（decision_id 非空）方可 active；白名单外字段写入被拒且留痕；超出 max_uses/period 自动 paused；tier 无任何自动提升路径（T2/T3 动作在无凭证时被拒）"
```

**契约说明：** 本任务由 `review-gate` 承接，调用 `method-review-gate`/`data-particle-read`、读 `review-gate`/`quote-engine` 记忆（L1–L2，≤4 跳）；成功标准为凭证必批、白名单拦截、熔断生效、tier 不可自动提升。

#### T20 链路观测与信任校准

```contract-yaml
- task: "T20 信号链路观测上墙（投递成功率/延迟/冲突/执行量）与连续否决自动降级"
  agent: decision-retro
  contract_task_id: ct-retro-decision
  skills: [decision-retrospective, data-particle-read]
  memory: [decision-retro, review-gate]
  knowledge_scope: { layers: [L1, L2], max_hops: 5 }
  success: "指标按 tenant_id 隔离返回；存在负向判据（无投递行但渠道为 on → 报警；hits>0 而新增 signal=0 → 报警）；连续 rejected 达阈值自动 paused 并 emit 告警；降级事件可在追溯链中查到"
```

**契约说明：** 本任务由 `decision-retro` 承接，调用 `decision-retrospective`/`data-particle-read`、读 `decision-retro`/`review-gate` 记忆；成功标准为租户隔离 + **含负向判据** + 自动降级可追溯。

#### T21 分级授权对象化（A 轴补全：D1–D4 + E1/E2）

> **实施优先级：本任务应先于 T19 执行。** T19 是新增 B/C 轴（动作边界 + 授权凭证）；本任务是**把已在运行的 A 轴（对象风险分级）先变成可审计、可撤回的授权对象**。先修既有轴的审计断链，再叠加新轴——否则新凭证的溯源会挂在一条本就断链的依据上。

```contract-yaml
- task: "T21 分级授权对象化：business_tier_config 补授权元数据列（approved_by/approved_at/decision_id/expires_at/revoked_at）、写入时落 decision_id、分级配置纳入 POLICY_KEYS 内容冻结、补 paused/revoked 语义、修 autonomous_allowed 配置面与执行面不一致"
  agent: review-gate
  contract_task_id: ct-review-gate
  skills: [method-review-gate, data-particle-read]
  memory: [review-gate, decision-retro]
  knowledge_scope: { layers: [L1, L2], max_hops: 4 }
  success: "① 表结构与 schema.sql 一致（5 个新列幂等可重跑）；② 任一次 PUT /api/business-tier-config 后，该行 decision_id 非空且可在 crm.decision 反查到（溯源不断链）；③ 改一次分级配置后 resolvePolicyVersion 解析出新的 policy_version_id，且改回旧值时能复用原版本（幂等不破）；④ 一条 pause 后该分级不再产生 AUTONOMOUS 决策，且历史决策的 effective_policy_version 不变（历史依据不被洗掉）；⑤ autonomous_allowed=false 的场景在 tier!=HIGH 且 conf 达标时不再自主放行（配置面承诺与执行面一致，假绿消除）"
```

**契约说明：** 本任务由 `review-gate` 承接（授权面的配置闸门职责），调用 `method-review-gate`/`data-particle-read`、读 `review-gate`/`decision-retro` 记忆（L1–L2，≤4 跳）；成功标准为**元数据落库 + 溯源可反查 + 版本冻结生效（含幂等回滚）+ 撤回语义生效 + 配置面与执行面一致**。
**五项验收判据中 ③⑤ 为负向/边界判据**（改回旧值 / 关闭开关），**缺一即视为假绿**——正向写通不代表冻结与闸门生效。

---

## §14 客户价值排序（合并去重）与实施顺序

### 14.1 客户价值排序（客户能感知到什么）

| 排名     | 客户获得的价值                          | 支撑项                               | 线   | 感知    | 交付段    |
| ------ | -------------------------------- | --------------------------------- | --- | ----- | ------ |
| **1**  | **每天打开就知道今天该干什么**——不用自己找         | T14 待办信号视角 + 首页信号卡 + 每日作战简报       | B   | ★★★★★ | **S1** |
| **2**  | **AI 的结论出现在客户自己的 CRM 里**         | T04 回写 + A-B4 字段级 CAS             | A   | ★★★★★ | S4     |
| **3**  | **不用去查，它主动告诉我**——时间/变更/外部三类触发    | T12 三源 + T15 T16                  | B   | ★★★★★ | S5     |
| **4**  | **不再重复录入 / 两套数据不打架**             | A-N2 映射 + A-N3 对齐 + A-B1          | A   | ★★★★★ | S2     |
| **5**  | **AI 的判断基于真实客户数据，而不是猜**          | A-N1 内核 + A-B6 增量 + A-B7 重评       | A   | ★★★★  | S3     |
| **6**  | **提醒里已经带好理由和证据**，不是一句"该跟进了"      | T15/T16 上下文 + T17 建议卡（推理链 + 证据）   | B   | ★★★★  | S5     |
| **7**  | **一键采纳，改动自动落库**并回写客户 CRM         | T18 采纳回路 + T04 回写                 | B→A | ★★★★  | S5     |
| **8**  | **低风险的事 AI 自己做完**，我不用点           | T19 常驻授权 T1                       | B   | ★★★   | S6     |
| **9**  | **可以随时断开的零风险试用**                 | A-N5 信任分级（L1 只读起步）                | A   | ★★★   | S2     |
| **10** | **我知道 AI 干了什么、能撤、能让它停；同步可审计可复现** | T20 观测 + T07 同步指标 + A-N2 映射可 diff | A+B | ★★★   | S7     |

### 14.2 ⚠ 客户价值排序 ≠ 实施顺序（必须点破）

> **价值排序回答"先让客户感觉到什么"；实施顺序回答"技术上必须先做什么"。两者不重合。**
>
> **排名 2、7、8、10 的强感知价值全部在依赖链末端。** 倒序实施会造出：
>
> - **无对象的采纳按钮**（先做 T18 而不做 T17 建议卡）；
> - **写到错误记录上的回写**（先做 T04 回写而不做 T03 实体对齐）；
> - **无观测的自动写**（先做 T19 而不做 T13 投递 + T20 观测）；
> - **没人看得见的"主动"**（先做 T12 感知而不做 T11/T13/T14 出口）；
> - **挂在断链依据上的授权**（先做 T19 而不做 T21：新授权凭证的溯源会落在**本就无版本冻结、无授权元数据**的分级表上——`policyVersion.js:29-34` 的 `POLICY_KEYS` 不含分级项，届时"这条自动执行为什么被允许"仍答不出来）。**这是 §2.4 核验后新增的一条倒序风险。**

### 14.3 统一实施分段

| 段      | 主题                   | 任务                                                                                    | 依赖 | 交付后可验证的客户价值                             |
| ------ | -------------------- | ------------------------------------------------------------------------------------- | -- | --------------------------------------- |
| **S1** | **出口：让人看得见**         | **T11** 信号收口 · **T13** 投递四渠道 · **T14** 视角/首页卡/简报（含 B-B1/B-B2 挂载修复）                    | 无  | 排名 **1** 立即成立——**当天可见**（这是全案 ROI 最高的一步） |
| **S2** | **入口：数据进来**（L1 只读起步） | **T01** 内核+映射 · **T02** 纷享适配器 · **T03** external_ref/对齐 · **T05** 信任分级 · **T10** 接入闸门 | S1 | 排名 **9**（零风险试用）+ 为排名 4 铺路               |
| **S3** | **判断有据**（L2 批量入库）    | **T06** 事件订阅+重评 · **T07** 同步可观测 · **T08** 报价基线 · **T09** 拓客去重                         | S2 | 排名 **4、5**（不再重复录入；判断有据、评分不再恒 0）         |
| **S4** | **结论回去**（L3 回写）      | **T04** 回写 Action + A-B4 字段级 CAS                                                      | S3 | 排名 **2**（客户感知最强的一项）                     |
| **S5** | **不用去查**             | **T12** 三源触发器 · **T15** 报价/阶段节律 · **T16** 拓客信号 · **T17** 主动研究 · **T18** 采纳回路          | S4 | 排名 **3、6、7**                            |
| **S6** | **让它自己动手**（自治）       | **T21** 分级授权对象化（A 轴补全，**先做**；**A3+E1 已落地已验证**，A1/A2/A4 待批）· **T19** 常驻授权 T1（B/C 轴） | S5 | 排名 **8** |
| **S7** | **可校准**              | **T20** 链路观测 + 信任校准                                                                   | S6 | 排名 **10**                               |

> **建议合并交付**：S2+S3 可合并为一个批次（此时客户已能感知排名 4、5、9），**S4 紧随其后**交付排名 2 的强感知价值。

---

## §15 红线（明确不做，合并去重 9 条）

### 15.1 共性红线

| # | 不做项                                 | 理由                                                                                             |
| - | ----------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1 | **任何"取代客户 CRM"的技术路线或对外叙事**          | 客户既有 CRM 是十年沉淀 + 内部流程依赖；一旦对外写"最终取代"即自拆"共生"叙事（Rox 明牌 *"in that future, Rox is the CRM"* = 反面教材） |
| 2 | **schema-less 自由生长**（Lightfield 路线） | §10 硬约束 + 多租户 + 审计 + 禁 DELETE 不允许字段随同步自动生长；映射必须是**声明式白名单**                                     |
| 3 | **任意脚本 / 表达式映射**（映射中执行代码 / SQL）     | 注入风险 + 不可审计                                                                                    |
| 4 | **在客户 CRM 中创建我方自有对象 / 表**           | 越界修改客户系统的数据模型，属不可逆侵入；只读写**客户已声明的对象与字段**                                                        |
| 5 | **借道第三方 iPaaS**                     | 数据链路进黑盒，与"可验证可审计"定位冲突；引入供应商与数据出境合规风险                                                           |

### 15.2 线 A 专属红线

| # | 不做项                                                  | 理由                                                                  |
| - | ---------------------------------------------------- | ------------------------------------------------------------------- |
| 6 | **完整双向同步**（变更来源消歧 + pending write 对账 + Fivetran 级管道） | 投入大且"只读 + 单向回写"已覆盖约 80% 价值；复杂度集中在冲突治理，而我方客户多数**根本不会双写**（他们只有一套 CRM） |

### 15.3 线 B 专属红线

| # | 不做项                   | 理由                                                                                                                   |
| - | --------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 7 | **不学「投递即骚扰」**         | Rox 自己做了 `Notifications controls`（按数据源调频率），说明过量投递是真问题。我方必须有 `rate_limit` + `quiet_hours` + `include_low`，默认**低频高信噪** |
| 8 | **不学「always-on 全自动」** | 常驻授权首批只开 **T1 内部字段**，`allow_tier_upgrade_by_ai:false` 写死；**T3 对外动作永久不可常驻授权**                                         |
| 9 | **不学「发送即送达」**         | 必须有 `signal_delivery` 流水与 `last_error`；`skipped` 也要留痕。**没有投递证据的投递，等于没投递**                                            |

### 15.4 两条"元红线"（最忌讳）

> **① 不学「外部公开信号当主料」**：我方 K 层真实弱点是**内部数据不足**——实测 `crm.events` 虽有 529 行但**语义域单一**（`ontology-sync` 528 / `channel-probe` 1，**无业务事件**），`supplied_dims` 均值仅 **2.68/7** 且 Q1 达标率 **8.3%**（见 §18.2）。先把内部 + 客户 CRM 信号做透。
>
> **② 不学「把主动能力当营销词」**：**对外只能讲已通电的链路。S1 未交付前，不得对外宣称"AI 主动值守"。** 这正是本项目最忌讳的假绿（与 L1–L4 同源）。

---

## §16 验收标准（合并 20 条，含负向判据）

### 16.1 线 A｜共生同步（10 条）

| #   | 判据                                                          | 类型     |
| --- | ----------------------------------------------------------- | ------ |
| A1  | 能从纷享销客拉取客户/联系人/商机三类对象并落为既有粒子（断言 `external_ref` 行数与客户侧记录数一致） | 正向     |
| A2  | 同批同步重复执行幂等（第二次 `created=0`）                                 | 正向     |
| A3  | 外部记录删除不导致我方粒子删除（`external_deleted_at` 非空且粒子 `id` 仍在）        | 正向     |
| A4  | 所有同步写带 `decision_id`（L1 阶段应无任何写入）                           | **负向** |
| A5  | 回写仅作用于白名单字段且带 `Source='crm-ai-native'`（越权字段被拒）              | **负向** |
| A6  | 并发修改被 CAS 拦住（回写被拒并回传最新值，不静默覆盖）                              | **负向** |
| A7  | 同步后决策评分不再恒 0（对比九尺子评分与 `supplied_dims` 覆盖率）                  | 正向     |
| A8  | 全程零新增粒子类型、零新增 `DELETE FROM`                                 | **负向** |
| A9  | 配置零硬编码（grep 不到客户侧对象名/字段名/同步频率字面量）                           | **负向** |
| A10 | 契约有效性（`validate-contract.mjs` 退出码 0）                        | 正向     |

> **A7 的负向基线（2026-09-15 实测，见 §18.2 ②）**：`supplied_dims` 当前均值 **2.68/7**、众数 **2/7（60%）**、Q1 门槛（≥5/7）达标率仅 **8.3%**（12/145 行）。**S2 交付后该达标率必须显著抬升**——若仍停留在 10% 量级，即说明"数据进得来"这一环未真正生效（防假绿判据）。

### 16.2 线 B｜主动运行时（10 条）

| #   | 判据                                                         | 类型     |
| --- | ---------------------------------------------------------- | ------ |
| B1  | 巡检命中后 `crm.signal` 有对应行，**且进程重启后仍可查**                      | 正向     |
| B2  | 同 `(tenant, dedup_key)` 重复命中**不产生新行**（幂等）                  | 正向     |
| B3  | `GET /api/alerts`（挂载后）返回本租户信号，**跨租户不可见**                   | 正向     |
| B4  | 渠道配置为 `on` 时，每次投递在 `signal_delivery` 有 `sent` 或 `failed` 行 | **负向** |
| B5  | 渠道 `on` 但 `signal_delivery` 无对应行 → 判定假绿，**验收不通过**          | **负向** |
| B6  | `trace 'sales-daily-scan' hits>0` 而当日新增 `signal` = 0 → 报警  | **负向** |
| B7  | 阈值改配置后同批数据命中集合随之改变（证明非硬编码）                                 | 正向     |
| B8  | 建议卡 `reasoning` 与 `evidence_refs` 均非空；缺证据时输出降级说明           | 正向     |
| B9  | 白名单外字段的自动写入被拒并留痕；超限额自动 `paused`                            | **负向** |
| B10 | 全链路 grep `DELETE FROM` 新增数 = **0**                         | **负向** |

---


## §17 闭环回写

> 本文档为**生命契约载体**。运行期由 agent workbench（`/agents`、`agent-workbench.html`）解析 §13 的 `contract-yaml`，逐任务核对：① 承接 agent 是否调用了声明的 `skills`？② 是否读取了声明的 `memory`/knowledge？③ `success` 是否通过？

**机读回写文件**：`docs/2026-09-15-final-design-coexistence-and-proactive.feedback.json`，按 `task+gap_type` 幂等 upsert。

```json
{ "task": "T13 投递抽象层与四渠道 provider", "agent": "followup-agent", "gap_type": "skill", "observed": "...", "expected": "...", "ts": "...", "severity": "warn" }
```

**人读回写表**

| task | 承接 agent       | 观测点                                            | 缺口类型            |
| ---- | -------------- | ---------------------------------------------- | --------------- |
| T01  | intake-router  | `engine.runOnce` 四计数 / 幂等                      | success         |
| T02  | intake-router  | 鉴权换取命中率 / 对象发现条数                               | skill           |
| T03  | intake-router  | `external_ref` 对齐率 / 软标记正确性                    | success         |
| T04  | decision-agent | 白名单拦截数 / CAS 拒绝数 / Source 标记存在率                | **success（负向）** |
| T05  | intake-router  | 三档行为差异 / mint 粒度                               | memory          |
| T06  | followup-agent | 事件→重评延迟 / payload 子键完整性                        | success         |
| T07  | decision-retro | 指标上报完整性 / 失败留痕率                                | success         |
| T08  | quote-engine   | 报价命中客户真实价格 / 缺基线报缺率                            | success         |
| T09  | prospecting    | 与外部 CRM 重复候选数（应为 0）                            | success         |
| T10  | review-gate    | 四类动作 fail-closed 命中数                           | **skill**       |
| T11  | intake-router  | `crm.signal` 行数 / 幂等命中率                        | success         |
| T12  | intake-router  | 三源触发计数 / 只读闸拒绝留痕                               | skill           |
| T13  | followup-agent | 投递成功率 / failed 明细                              | success         |
| T14  | followup-agent | 视角条数 vs 首页卡数一致性                                | success         |
| T15  | quote-engine   | 阈值变更后的命中集合差异                                   | memory          |
| T16  | prospecting    | 拓客信号产出数 / 与 lead-pool-recycle 去重率 / **写入应为 0** | success         |
| T17  | decision-agent | 研究轮次 / LLM 预算消耗 / 证据非空率 / **粒子写入应为 0**         | success         |
| T18  | decision-agent | 采纳率 / `decision.outcome` 增量                    | success         |
| T19  | review-gate    | 白名单拦截数 / 熔断触发数                                 | skill           |
| T20  | decision-retro | 负向判据报警数 / 降级次数                                 | success         |

**吸收与建议（P0）**：下次会话读 `*.feedback.json`；同一 `(task, gap_type)` 复发 ≥2 次 → 产出 SKILL 改进提案（如：为相应 agent 的 `capabilities.actions`/`skillCalls` 补 `sync-*` / `signal-*` 条目、强化 SKILL 调用指令、补记忆读取约定）。**提案需显式批准后方可修改 SKILL 或 agentSpec，绝不自动应用。**

> ⚠ **装配闭包提醒**：若后续决定让 `sync-*` / `signal-*` Action 对 agent 可见，须**三处同改**（`agentSpec.capabilities.actions` + `agentSpec.capabilities.skillCalls` + `src/action/seed-actions.js` 登记），否则 `assertAgentAssembly` 的 `permission_closure` / `action_in_registry` 断言会整册校验失败。本设计**刻意选择 `agentTool: false`**（范式 `connectorActions.js:132`）以规避此项跨模块耦合。

---

## §18 移交与前置动作

### 18.1 移交

**本设计经用户批准（P8）后，唯一入口为 `writing-plans`。** §14.3 的 S1–S7 转可执行任务清单；**每任务继承 §13 同名契约**（不新增、不弱化 `agent`/`skills`/`memory`/`knowledge_scope`/`success`/`contract_task_id`）。

### 18.2 前置动作核验结果（2026-09-15 已执行，**本节数据已实测，不再是待办**）

三项前置动作已全部执行。**取证边界（必须声明）**：生产主机 `81.70.184.198` 在本沙箱不可达（`https://www.chiyuai.com` 连接失败；`5432` 被拦，且 `docker-compose.yml:14-17` 明确"仅绑定回环地址，禁止公网直接访问"）。因此：

- **配置层证据 = 生产口径**（`.env` + compose + 代码，三者是生产实际生效路径）
- **运行态证据 = 本地库 `crm_native`**（PG 16.14，同一套 `db/schema.sql` 与迁移）
- **生产库运行态未取得**——如需，用 compose 注释给出的通道：`ssh -L 5432:127.0.0.1:5432`，再跑 §18.3 的探针

#### ① `EMBEDDING_PROVIDER` —— **原表述有误，须修正**

| 层 | 证据 | 结论 |
| - | ---- | ---- |
| 生产 env | `scripts/tencent-lighthouse-deploy/.env:14` = `EMBEDDING_PROVIDER=model`；`deploy.sh:146/149` 以 `--env-file "$SCRIPT_DIR/.env"` 启动 → 该文件即生产生效值 | ✅ 生产 = model |
| 生产 compose | `docker-compose.yml:44/97` = `${EMBEDDING_PROVIDER:-model}`（默认即 model） | ✅ 双重兜底 |
| 代码兜底 | `src/http/server.js:41-47`：`NODE_ENV!=='test'` 且未显式设置时，读 `llm_config` → 有 `apiKey` 则**自动置 `model`** | ✅ 三重兜底 |
| **运行态（本地库）** | `particles` 1008 行中 **447 行 embedding 非空（44.3%）**；近 7 天有向量写入 62 行；末次向量写入 `2026-09-11T03:08`；`llm_config` 1 行且 `api_key` 非空 | ✅ **向量列不是空的** |

> **⚠ 修正上一版表述**：此前"默认部署态下向量列为空、'语义检索'的说法要改"——**该判断错误**。真实情况是：**真向量路径已启用且确实在写**，但**覆盖率只有 44%，存在结构性空洞**。

**真实缺口是覆盖率而非可用性**（本地实测，按类型）：

| 粒子类型 | 总数 | 有向量 | 说明 |
| --- | ---: | ---: | --- |
| `CRM_DICT_ENTRY` | 252 | **0** | 字典项全无向量（最大空洞） |
| `CRM_OFFER_POLICY` | 81 | **0** | 报价政策全无向量 |
| `CRM_PRODUCT` | 119 | 16 | 13% |
| `CRM_PRICE_LIST` | 46 | 6 | 13% |
| `CRM_KNOWLEDGE` | 69 | 69 | 100% |
| `CRM_APPROVAL_FLOW` | 32 | 32 | 100% |
| `CRM_ACCOUNT` / `CRM_CONTACT` / `CRM_DEAL` | 18/15/21 | 13/12/10 | 72%/80%/48% |

**对外表述修正建议**：把"写库即构建的真向量语义检索"改为"**已启用真向量并在持续写入（实测 44% 覆盖率），字典项与报价政策类待回填**"——或先执行 `scripts/backfill-knowledge-embeddings.mjs` / `backfill-decision-embeddings.mjs` 补齐后再对外。

**附带发现（代码注释漂移）**：`src/ontology/embedding.js:10` 注释仍写"向量维度须与 schema 对齐（`vector(384)`）"，但 `db/migration-2026-09-14-particles-embedding-1024.sql` 已把列改为 `vector(1024)`，`hooks.js:19-37` 也按 1024 校验。注释未同步，**建议随 S1 一并更正**（不改行为）。

#### ② `supplied_dims` 覆盖率 —— **实测：峰值 5/7，均值 2.68，众数 2/7**

**来源**：本地库 `crm.decision_context_snapshot`，145 行 / 131 个决策，时间跨 `2026-08-31` → `2026-09-14`（近 7 天 52 行，仍在产生）。

| 指标 | 实测值 | 对照原文档口径 |
| --- | --- | --- |
| 峰值 | **5/7** | 原引"峰值 4/7" → **已过期，实际更高** |
| 均值 | **2.68 / 7** | 原文档无此数 |
| 最小值 | 1/7 | — |
| **众数** | **2/7（87/145 行 = 60%）** | 原文档无此数 —— **这才是真实基线** |

分布（`supplied_dims` → 行数）：`1/7`×4 ｜ `2/7`×87 ｜ `3/7`×17 ｜ `4/7`×25 ｜ `5/7`×12

**🔴 关键新增结论（原文档未捕捉）**：`src/decision/auditability.js:14` 定义 Q1 门槛 `Q1_MIN_SUPPLIED_DIMS = 5`（设计口径 5/7）。按实测分布，**达标仅 12/145 行 = 8.3%**。即：**"决策可审计性 Q1"这一项在当前数据上 91.7% 不达标**。

→ 影响：§14.1 客户价值排序中"判断基于真实数据（★★★☆）"这一项的**现状基线比预期更低**；S2（数据进得来）的收益因此**比原估更高**。建议把"`supplied_dims` 达标率（≥5/7）"直接纳入 §16 验收判据作为**负向基线**（当前 8.3%，S3 完成后应显著抬升）。

#### ③ `crm.alert` 表 —— **确认不存在，且是双重实证**（不需改为"未纳入单一事实源"）

| 证据 | 结果 |
| --- | --- |
| 本地库 `information_schema.tables` where `table_name LIKE '%alert%'` | **仅 `crm.alert_rule`**（规则表），**无 `crm.alert` 实例表** |
| 全 `db/**/*.sql`（含子目录，58 个 SQL 文件）匹配 `CREATE TABLE ... (alert\|alerts)(` | **零命中** |
| 对照：`alert_rule` 建表语句 | 1 处，出处 `db/migrate-config.sql:95` ✅ 说明扫描方法有效（非漏扫） |

> **结论**：`crm.alert` **在运行库与全部 DDL 中双双不存在**。原 §0.2 / G9 的表述**不需要弱化为"表未纳入单一事实源"**，反而应**加强为"双重零命中"**（上一版担心的"生产手工建表未同步"情形，不改变结论）。

**附带修正（原文档数字有误）**：原文档多处称 `db/schema.sql` 为"56 表"。
- `grep -c "CREATE TABLE IF NOT EXISTS" db/schema.sql` = **56 条建表语句**（此数正确）
- 但**运行库 `crm` schema 实为 65 张表** → **差额约 17 张表由 `db/migrate-*.sql` / `db/migration-*.sql` 等 50+ 个迁移文件创建**（如 `config_store` / `alert_rule` / `connectors` / `approval_flow` 出自 `db/migrate-config.sql`；`tenants` 出自 `db/2026-09-03-crm-tenants.sql`；`agent_sla` / `propagation_action` / `decision_rubric_score` 等在 `db/**/*.sql` 中**零命中**，属运行时动态建表）
- **反向差集**：`schema.sql` 声明的 `crm.oauth_client` / `oauth_code` / `oauth_refresh` 三表在运行库**不存在**

> **⚠ 由此得出一条与本设计直接相关的结论**：**`db/schema.sql` 不是唯一事实源**——声明 56 条、实存 65 张，且 3 条声明未落地。这**直接支持 §8 的 DDL 决策**（本次 6 张新表**追加进 `db/schema.sql`** 是对的，但同时应登记进迁移清单，否则会重演"表存在但不在单一事实源"的老问题）。建议 S1 一并补一张 `db/` 表清单与 schema.sql 的对账脚本。

#### ④ 额外核验（顺带修正两处长期口径）

| 项 | 原口径 | 实测（本地库） | 影响 |
| --- | --- | --- | --- |
| `crm.events` 行数 | 设计文档记"**0 行**"（K 层致命弱点） | **529 行**，但 `type` 分布为 `ontology-sync`×528 + `channel-probe`×1；跨度 `2026-09-02` → `2026-09-11`，近 7 天 76 行 | 表述应改为"**事件表有数据但语义域单一**（仅本体同步事件，无业务事件）"——**这反而强化 §6/§7"感知面从 1 域扩到 3 域"的必要性**，且说明扩展有现成写入路径 |
| J2 闭环回填率 | "`decision.outcome` 实测 0/12" | `crm.decision` **261** 行，`crm.decision_outcome` **4** 行（**1.5%**），且 **4 行 `source` 全为 `seed-script`**——**无一行来自真实用户反馈或自动回填** | 坐实 J2 断链，且比"0/12"更精确：不是"样本少"，而是"**种子数据之外零回填**"。§5.2 / T19 的立论成立 |
| 九尺子是否真跑 | — | `crm.decision_rubric_score` **1044 行 / 覆盖 116 决策**（≈9 分/决策） | ✅ 确定性评分确实在执行（非死代码），支撑"8 确定性可重跑"的对外表述 |
| 决策场景实际分布 | — | `PARTICLE_CREATE`42 ｜ `LEAD_FOLLOW_UP`40 ｜ `QUOTE_PRICING`33 ｜ `OPP_QUALIFY`29 ｜ `SOLUTION_VALUE`26 ｜ `LOSS_REVIEW`23 ｜ `CLIENT_STRATEGY`22 ｜ `PARTICLE_UPDATE`20 ｜ `CALIBRATION_CHANGE`13 ｜ `PROSPECTING_CONFIRM`5 ｜ `SIGN_RISK`4 ｜ `POST_CONTRACT`3 | 实际场景面**多于** `scenarioAdvisors.js` 的 7 个（含 `PARTICLE_CREATE`/`PARTICLE_UPDATE`/`CALIBRATION_CHANGE` 等通用写场景）——供 §6/§7 判断面设计参考 |

#### ⑤ 分级授权机制核验（2026-09-15 追加，**本项推翻上一版「必须引入常驻授权」的措辞**）

用户指出"平台已有按客户 × 项目两因素决定 A/B/C 项目分级、C 类自动执行"。**源码级核验后判定：用户说法成立**，具体结论见 §2.4。核验要点：

| 待核验主张 | 核验结果 | 源码锚点 |
| --- | --- | --- |
| 存在"客户 × 项目"二维分级 | ✅ **成立** | `db/schema.sql:248-254`（表）+ `decisionRepo.js:61-70`（两维 `Math.max` 取高风险优先） |
| 维度取值为 `STRATEGIC/KEY/NORMAL` × `A/B/C` | ✅ **成立** | `db/migrate.js:388` 注释 + `:393-398` 出厂种子；`src/web/pipeline.html:67-68` 前端下拉 |
| "C 类项目直接自动执行" | ⚠️ **需加三条件限定** | `migrate.js:398` `'C' → 'LEAD'`；但 `autonomyEngine.js:274` 仍需 `conf ≥ effectiveThreshold`，且**两维取高风险优先**——战略客户 + C 类 → 整体仍 `HIGH` → 一律升级。**准确表述：`C 类项目 ∧ 客户维非 STRATEGIC/KEY ∧ 置信度达标 → 自主`** |
| 分级驱动自主边界 | ✅ **成立**（且已运行） | `autonomyEngine.js:145` 取 tier → `:274` 参与 `escalated` 判定 |
| 写分级有第 0 闸凭据 | ✅ 有产出，❌ **未落库** | `businessTier.js:102-110` 产出 `decision_id` → `:143` 仅回显前端 |
| 分级变更有版本冻结 | ❌ **不成立（审计断链）** | `policyVersion.js:29-34` `POLICY_KEYS` 9 键**不含分级项** |
| 分级可撤回 | ❌ **不成立** | `businessTier.js:92-98` 仅 `ON CONFLICT DO UPDATE SET tier=$4`，无 `paused/revoked` 语义 |
| `autonomous_allowed` 生效 | ❌ **不成立（假绿）** | 配置面 `decisionScenario.js:126`／执行面 `autonomyEngine.js:274` 未引用；`:251` `highNoAuto` 为 dead variable |

**本项产出的修正**：§2.4 新增；§11.0 三轴模型新增；§11.1 增加 A1–A4 补全项；§13 新增 **T21**；§12 增加 2 条铁律映射。



#### 18.3 生产复核探针（供你在生产机执行）

生产不可达，以下命令在生产机（或用 `ssh -L 5432:127.0.0.1:5432` 隧道后）执行即可闭环验证，**全部只读**：

```bash
# ① 向量真实覆盖率（生产口径）
docker compose --env-file scripts/tencent-lighthouse-deploy/.env exec -T db \
  psql -U agent2b -d crm_native -c "
    SET search_path TO crm,public;
    SELECT count(*) total, count(embedding) with_vec,
           round(100.0*count(embedding)/nullif(count(*),0),1) pct
    FROM particles;"

# ② supplied_dims 分布
docker compose --env-file scripts/tencent-lighthouse-deploy/.env exec -T db \
  psql -U agent2b -d crm_native -c "
    SET search_path TO crm,public;
    SELECT supplied_dims, count(*) FROM decision_context_snapshot GROUP BY 1 ORDER BY 1;"

# ③ crm.alert 是否存在
docker compose --env-file scripts/tencent-lighthouse-deploy/.env exec -T db \
  psql -U agent2b -d crm_native -c "
    SELECT table_name FROM information_schema.tables
    WHERE table_schema='crm' AND table_name LIKE '%alert%';"

# ④ 生效环境变量
docker compose --env-file scripts/tencent-lighthouse-deploy/.env exec -T app printenv EMBEDDING_PROVIDER

# ⑤ 分级授权现状（A 轴｜§2.4）：配置内容 + 授权元数据是否已存在
docker compose --env-file scripts/tencent-lighthouse-deploy/.env exec -T db \
  psql -U agent2b -d crm_native -c "
    SET search_path TO crm,public;
    SELECT tenant_id, dimension, dimension_value, tier FROM business_tier_config
    ORDER BY tenant_id, dimension, dimension_value;
    SELECT column_name FROM information_schema.columns
    WHERE table_schema='crm' AND table_name='business_tier_config'
    ORDER BY ordinal_position;"

# ⑥ 自主放行真实产出（A 轴是否真在驱动）：按 tier 统计自主 vs 升级
docker compose --env-file scripts/tencent-lighthouse-deploy/.env exec -T db \
  psql -U agent2b -d crm_native -c "
    SET search_path TO crm,public;
    SELECT business_tier, state, count(*) FROM decision
    WHERE scenario_id NOT IN ('PARTICLE_CREATE','PARTICLE_UPDATE')
    GROUP BY 1,2 ORDER BY 1,2;

    -- 负向判据：若 business_tier 全为 NULL 或 state 全为 HUMAN，
    --   则'分级驱动自主'在生产未实际发生（勿据本地库推断生产已生效）
    SELECT count(*) FILTER (WHERE business_tier IS NULL) AS tier_null,
           count(*) FILTER (WHERE state='AUTONOMOUS') AS autonomous_total,
           count(*) AS total FROM decision;"
```

---

## 附录 A：证据索引


### A.1 我方（`file:line`）

| 项                                   | 锚点                                                                                                                                                                                                             |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 租户级外部系统描述符与 kind 工厂                 | `src/connectors/discovery/tenantInstances.js:9-13`（`KIND_FACTORY`）、`:19-29`（描述符）、`:15-30`（`loadTenantAdapters`）                                                                                                |
| 通用 REST 适配器（单层扁平映射）                 | `src/connectors/discovery/adapters/genericRest.js:11`（`field_map`）、`:23-32`（字段命中循环）                                                                                                                            |
| 凭据保险库（pgcrypto + fail-closed）       | `src/connectors/discovery/credentialVault.js:34-49`（`resolveCredentials`）、`:52+`（`persistSecret`）                                                                                                              |
| 定时拉取（现状 = 逐条富化）                     | `src/scheduler/timers.js:117-143`（`runIntegrationPollOnce`）、`:163-466`（11 个定时器）                                                                                                                                |
| 巡检器                                 | `src/scheduler/riskScanner.js`、`src/scheduler/salesDailyScan.js:52-109`                                                                                                                                        |
| 入站 webhook 与手动同步端点                  | `src/http/connectorRouter.js:11-25`（`handleSignalWebhook`）、`:71`（`/integration/webhook/:provider`）、`:80`（`/tenant-source-sync`）                                                                                |
| CAS 原子写（现状 = 阶段/归属）                 | `src/particles/particleRepo.js:203`（签名）、`:232-242`（CAS 条件与拒绝）                                                                                                                                                  |
| `updateParticle` 浅合并语义              | `src/particles/particleRepo.js:211`                                                                                                                                                                            |
| 配置读写（含 decisionId）                  | `src/config/configStore.js:51`（`readConfig`）、`:64`（`writeConfig`）                                                                                                                                              |
| 同步后重评闭环                             | `src/connectors/discovery/monitorAccount.js:10-30`                                                                                                                                                             |
| 写通道第 0 闸范式                          | `src/connectors/connectorActions.js:20-33`（`requireDecision`）、`:132`（`agentTool:false` 注释明文）                                                                                                                   |
| 连接器 Action 全清单（4 个，全 write-into-us） | `src/connectors/connectorActions.js:18` / `:53` / `:99` / `:132`                                                                                                                                               |
| **投递面断链证据**                         | `src/alerts/alertStore.js:6`（内存 Map）、`src/alerts/alertEndpoints.js:12-24`（清单/处理器零挂载）、`src/http/server.js:74`（只注册 finance hook）、`src/http/workbenchRouter.js:101-175`（六视角无信号）、`crm.alert` **双重零命中**（运行库 `information_schema` 仅 `alert_rule`；全 `db/**/*.sql` 无 `crm.alert` 建表语句，见 §18.2 ③） |
| 告警判定                                | `src/alerts/alertRegistry.js`（13 类）、`src/alerts/ruleEvaluator.js`、`src/alerts/alertHook.js`                                                                                                                    |
| 事件触发                                | `src/agent/eventTrigger.js`、注册点 `src/http/server.js:97`                                                                                                                                                        |
| 授权约束                                | `src/mcp/gateway.js:201/224`、`src/action/registry.js:14`、`src/action/seed-actions.js:741/801/994/1055/1108`（`deferDecisionMint` 五处）                                                                            |
| 决策结果回写通道                            | `src/action/seed-actions.js:1791/1815/1870`                                                                                                                                                                    |
| Agent 注册表（7 个）                      | `src/agent/agentSpec.js:3-105`                                                                                                                                                                                 |
| 契约键登记表（7 键）                         | `src/agent/contractIds.js`                                                                                                                                                                                     |
| 契约解析内核                              | `src/contract/contractParser.js`（D2 双向断言在 `:129-170`）                                                                                                                                                          |
| 粒子类型既有清单                            | `db/schema.sql:14`（注释）                                                                                                                                                                                         |
| events 表与 channel 索引                | `db/schema.sql:102-114`                                                                                                                                                                                        |
| 新表 DDL 风格与软清理范式                     | `db/schema.sql:945-960`（`discovery_draft` 软清理）、`:962+`（OAuth 三表"不改既有表"声明）                                                                                                                                      |
| 向量写入条件                              | `src/ontology/hooks.js:22`（`EMBEDDING_PROVIDER=model` 才写 `vector(1024)`）                                                                                                                                       |
| 九尺子                                 | `src/decision/rubricScorer.js:17-27`（9 项，仅 `clarity` 允许 LLM 且默认 `llm:'off'`）                                                                                                                                   |
| 决策场景                                | `src/decision/scenarioAdvisors.js:132-138`（7 个）                                                                                                                                                                |
| 装配断言族（8 个）                          | `src/agent/agents.js:66`、断言体 `:76-121`                                                                                                                                                                         |
| 禁 DELETE 唯一例外                       | `src/decision/auditabilitySla.js:29`（`agent_sla` 保留期清理）                                                                                                                                                        |
| 契约校验脚本                              | `scripts/validate-contract.mjs`、`scripts/aggregate-feedback.mjs`                                                                                                                                               |


### A.2 第三方（一手 URL）

| 项                                                                                            | 锚点                                                                                                |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Rox "CRM 只是数据源" + 三层同步 + 乐观并发 + 终局明牌                                                         | `https://docs.rox.com/development/engineering/rox-enterprise-integrations/crm-integration`        |
| Rox 回写配置（字段映射、静态值、Fivetran）                                                                  | `https://launch.rox.com/docs/product/organization-level-configurations/configuring-crm-writeback` |
| Rox Manifesto（须重造 data platform / **agent harness** / UI 三层）                                 | `https://www.rox.com/manifesto`                                                                   |
| Rox 对 Agentforce 立场（"complementary, not competitive"）                                        | `https://www.rox.com/articles/rox-vs-salesforce-agentforce`                                       |
| Rox 定价（**Agent Action 计量**：$100/月=10k actions；$255/月=15k 且无限席位）                              | `https://www.rox.com/pricing`                                                                     |
| Rox Revenue Operating System 架构章                                                             | `https://docs.rox.com/development/about-rox/readme/revenue-operating-system`                      |
| Rox Release Notes 全量（2024-08 → 2026-09 每周一版）                                                 | `https://docs.rox.com/development/about-rox/release-notes`                                        |
| Attio 首页 / Universal Context™                                                                | `https://attio.com/`                                                                              |
| Lightfield（"An agent **harness** for reliable work"）                                         | 官网 + A 轮（a16z 领投）转述源                                                                              |
| 纷享销客开放平台（服务端 API、对象同步、事件订阅）                                                                  | `https://open.fxiaoke.com/`、`https://help.fxiaoke.com/9bfb/c68f/a138/468e`                        |
| 纷享销客对象清单接口 `/cgi/crm/object/list` + `appId/appSecret/permanentCode → CorpAccessToken`（7200s） | 纷享开放平台接口文档                                                                                        |
| 销售易 REST `/rest/data/v2.0/xobjects/{apiKey}` + describe 接口（返回字段类型/可编辑性）                      | `https://www.xiaoshouyi.com/?p=40906`（官方）                                                         |

### A.3 grep 零命中证据（本设计的关键负向判据）

- `纷享` / `fxiaoke` / `销售易` / `xiaoshouyi` / `neocrm` → `src/` 下 **0 命中**
- `salesforce` / `hubspot` / `zoho` → `src/` 下仅 1 处，为 `anysite.js:105` 注释中的技术栈举例
- `parseCsv` / `parseCSV` / `csv-parse` → `src/` 下 **0 命中**（仅 `billingRoutes.js:137` 有 CSV 导出）
- `钉钉` / `飞书` / `企业微信` / `wecom` / `dingtalk` / `lark` → `src/` 下 **0 命中**
- `api/alerts` → `src/web/` 下 **0 命中**（84 个页面无一消费）
- `renewal` / `续约` / `增购` / `upsell` → 仅命中 roleProfiles / routing / dialogAdvisor / thinkingTemplates（均为文案或路由），**无独立管线**

---


## 附录 B：修正记录（本设计推翻的旧判断）

| 旧判断                                  | 修正                                                                                                              | 来源                         |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------- | -------------------------- |
| "我方客户多数没有成熟 CRM"                     | 🔴 **推翻**：客户**都有**自研或套装 CRM（纷享销客、销售易等）。Rox"接现有 CRM"策略从此**直接适用**                                                 | 用户 2026-09-15 明确修正         |
| "'事实发生地'（IM/邮件/Excel）是 P0"           | 🟡 **降级为补充轨**：CRM 是主数据源                                                                                         | 同上                         |
| "'数据进来'要新建导入能力（CSV）"                 | 🟡 **修正**：CRM 已有 API 可直连，**优先做 API 同步**；CSV 降为无 API 的自研 CRM / 台账兜底                                              | 同上                         |
| "由 ROX = 体验回报（Return on Experience）" | 🔴 **推翻**：ROX 是**一家公司**（Rox AI，红杉/General Catalyst/GV 投 5000 万美元）。根因：URL 转写错字导致抓到风控页，又用搜索"补"了一篇同名主题文章——**典型假绿** | 本会话早期                      |
| "A1–A9 编排"                           | 🔴 **推翻**：CRM 是 **7 个 Agent**（A1–A9 属 PDM 项目，跨项目串味）                                                             | `src/agent/agentSpec.js`   |
| "`assertAgentAssembly` 两硬闭包"         | 🟡 **修正**：实为 **8 个断言族**；"两硬闭包"仅指 `permission_closure` + `action_in_registry`                                    | `agents.js:66/76-121`      |
| "缺外部接入器"                             | 🟡 **修正**：已有 25 个 connector 文件 / 10 个 adapter；**精确差距 = 缺 CRM 类适配器 + 缺内部互动捕获**                                   | `src/connectors/`          |
| "我方 eval 机制弱"                        | 🟡 **修正**：已有 `calibration/replay.js` + `replayDims.js`；精确表述 = 缺决策/Agent 全链路级确定性夹具重放                             | grep 命中 12 文件              |
| "我方缺少同步机制"                           | 🔴 **推翻**：同步机制（定时/鉴权/凭证/配额/审计/多租户循环）**已成体系**，缺的是**接的对象与进来的入口**——"机制是否有"与"对象是否有"必须区分                             | 本会话读码                      |
| "`landing.html:146` 的'销售易'是竞品"       | 🟡 **误读排除**：实为"**销售易手**不丢上下文"（动词短语）                                                                             | `src/web/landing.html:146` |
| "本设计需从零建同步与投递"                       | 🔴 **推翻**：已有骨架 E1–E14（约 60%），设计是**补齐 + 接线 + 少量新建**                                                              | §2.1                       |

---

## 附录 C：本设计刻意规避的跨模块耦合

| 项                              | 规避方式                                                      | 理由                                                            |
| ------------------------------ | --------------------------------------------------------- | ------------------------------------------------------------- |
| `agentSpec` 三处同改（装配闭包）         | 新 Action 全部 `agentTool: false`                            | 范式见 `connectorActions.js:132`；避免 `assertAgentAssembly` 整册校验失败 |
| 新增定时器                          | 复用 `ready-queue-pump`（60s 心跳）+ `integration-poll`（既有租户循环） | 零调度层回归风险                                                      |
| 事件触发键名                         | `agent-event-trigger` **不改名**，仅扩矩阵                        | 向后兼容，旧行语义不变                                                   |
| `updateParticle` 合并语义          | 增 `patchMode:'deep'` **仅同步路径启用**，默认仍浅合并                   | 不改既有语义，零回归                                                    |
| `context-routing`（id36）等平台核心配置 | 全程不触碰                                                     | 2026-09-04 起禁止修改                                              |

---

**— 文档结束 —**
