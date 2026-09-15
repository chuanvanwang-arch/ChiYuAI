> ⛔ **已废弃（SUPERSEDED）— 2026-09-15**
> 本文结论**已被完整吸收并取代**。唯一有效设计 → `docs/2026-09-15-final-design-coexistence-and-proactive.md`（最终设计 v1.0）。
> **本文件仅保留过程证据与一手资料锚点，用于追溯；不得作为实施、评审或对外表述的依据。**
> 下方原有勘误仍有效（定位前提已修正为"客户**都有**自研或套装 CRM"），但**整篇结论以最终设计为准**。

---

# Attio × Lightfield × Rox 三平台对照，及"借道现有系统"策略评估

> ⚠ **勘误（2026-09-15 补，必读）**：本文 §0 第 4 条与 §6 层一的**核心前提已被推翻**——原文写"我方目标客户多数没有成熟 CRM"，用户已明确修正为"**我方客户群体都有自研或套装 CRM（纷享销客、销售易等）**"。
> 因此本文关于"Rox 的'不淘汰现有系统'对我方**对象不匹配、照搬无落点**"的判定**作废**；修正后的判定是**直接适用**。
> **以新文档为准**：`docs/2026-09-15-crm-coexistence-sync-design.md`（含定位修正、补齐/新增清单、客户价值排序、生命契约）。本文其余章节（三家一手事实、架构与功能对照、我方源码级现状）**仍然有效**，仅"对象不匹配"这一层结论被推翻。

> 整理：2026-09-15 ｜ 性质：一手证据对标 + 借鉴清单（**非实施设计**；任何落地均须 brainstorming → 设计文档 → 批准）
> **取证口径（硬约束）**：对第三方的一切断言附 URL 锚点；对我方的一切断言附 `file:line` 或"grep 零命中"。凡未能落地到这两类证据之一的判断，一律标注为推算而非事实。
> 关联文档：`docs/2026-09-15-rox-benchmark-differentiation-analysis.md`（Rox 单家深入版）、`docs/2026-09-03-attio-lightfield-study.md`（Attio/Lightfield 底稿）、`docs/2026-09-03-lightfield-attio-gap-study.md`（10 项差距清单）。

---

## §0 结论先行

1. **三家的差别不在功能多少，而在两个选择的组合**：①数据从哪来（自建记录系统 vs 借用客户系统）；②对现有 CRM 的姿态（要求搬迁 vs 与既有系统共生）。**Attio 与 Lightfield 都是"自建 + 搬迁"，Rox 是"借用 + 共生"**——这是它们真正分道扬镳的地方。
2. **"要求搬迁"与"自建记录系统"是同一枚硬币**：你要成为客户的真相源，就必须把他的历史搬过来；所以"搬迁成本 = 切换成本 = 最大的护城河"。这解释了两家为什么把迁移做成产品：Attio 外包给 Import2（40+ 源），Lightfield 自研"1 小时迁移 agent"并当成营销武器。
3. **Rox 的"不淘汰现有系统"是手段，不是承诺**。其官方文档原文写明终局："*customers will graduate to a warehouse-native future where Rox writes directly to their warehouse (and let's be honest: **in that future, Rox is the CRM**)*"。所以要借鉴的是**进入策略与工程机制**，不是它的商业终局。
4. **对我方，直接照搬"寄生现有 CRM"没有对象**：我方目标客户是中国 B2B 制造／化工／医疗器械，多数没有 Salesforce/HubSpot。我方客户的"现有系统"是 **Excel + 钉钉/企业微信/飞书 + 邮件 + 会议录音**。
5. **但我方当前两头都不占**：既没有 Rox 的"共生"能力（外部系统读写通道），也没有 Lightfield 的"零摩擦搬迁"能力——`parseCsv|csv-parse` 在 `src/` 下**零命中**，我方连 CSV 导入都没有。
6. **好消息：管道已经铺好，只是全部朝外**。定时拉取、入站 webhook、MCP 写入通道、凭证保险箱、令牌计费、trace 留痕全在运行（`src/scheduler/timers.js` 共 11 个定时器）；真正缺的是**"同步对象"**——25 个连接器文件全部是获客／工商富化方向，无一指向"客户自有系统的数据往里来"。

---

## §1 三家一手事实盘点

### 1.1 Attio —— 可编程柔性数据底座，路径是"搬过来"

| 项 | 事实 | 来源 |
|---|---|---|
| 一句话定位 | "The CRM that builds pipeline, advances deals, and grows accounts around the clock"；"The intelligent system that never sleeps" | attio.com 首页 |
| 核心概念 | **Universal Context™**：四句自述——"It logs itself"（邮件／通话／产品／计费自动捕获）、"Your tools finally talk"（Granola/Slack/全栈同步）、"It gets to know you"、"Ask, and it's there" | attio.com 首页 |
| 冷启动 | "**Self-building** — Live from day one. Connect your inbox and calendar. Attio learns your business and **builds itself around it**" | attio.com 首页 |
| 数据模型 | Particle（实体）／Attribute（字段）／Relationship（关系边）。实测属性类型含 `interaction`（8 个 first/last/next 互动时间线字段）、`actor-reference`（strongest_connection_user，关系强度）、`record-reference`（双向镜像关系边） | 本地抽取实证，见 `docs/2026-09-03-attio-lightfield-study.md` §2.7 |
| 记录 ID 结构 | `{ workspace_id, object_id, record_id }` 三元组——**租户隔离固化在 ID 层** | 同上 |
| 规模数字（自述） | 30,000+ 客户；10.9M MCP 调用/月；400M API 调用/周；**76k 活跃客户 agent**；15M 邮件同步/天 | attio.com 首页 |
| **与现有 CRM 的关系** | **官方路径是"一次性迁移"，不是共生**。Help Center 明确：用 Import2 迁移 Companies/People/Deals/自定义对象/笔记/任务；支持 40+ 源；**Salesforce 只支持 Contacts／Accounts／Leads／Opportunities，Cases 不可迁** | attio.com/help/reference/imports-and-exports/migrate-data-from-another-crm |
| 双向同步 | **官方未见原生双向同步文档**；两向同步目前由第三方提供（Stacksync 提供 HubSpot↔Attio 双向、OutboundSync 明示"one-way sync"） | stacksync.cloud / outboundsync.com |
| 迁移耗时（第三方统计） | HubSpot→Attio 平均 14 个工作日；Salesforce→Attio 4–8 周（约 500 用户案例 <4 周） | craftt.io 迁移时间线分析 |

**判定**：Attio 的定位是"**新记录系统**"，它的进入动作是**让客户搬家**。迁移是它的**门槛**（不是能力），所以它外包给 Import2，并在 Help 里反复警告"迁移前要先删掉已有记录、先停掉邮箱同步"——这恰恰说明**搬迁的摩擦成本是它自己也没解决的痛点**。

### 1.2 Lightfield —— 客户记忆世界模型，路径是"让搬家不痛"

| 项 | 事实 | 来源 |
|---|---|---|
| 一句话定位 | "AI-native CRM — CRM that remembers everything and does the work for you" | lightfield.app 首页 |
| 架构自述 | 三个原语：**System of record**（"A data model designed for agents"：自定义对象与关系 + **temporal context graph** 保留数据随时间变化）、**Agent infrastructure**（"An agent **harness** for reliable work"：标准化 SDK + 确定性代码沙箱 + 持续 evals）、**Open platform**（API／MCP／CLI 读写每个记录） | lightfield.app 首页 |
| 数据底座 | **Schema-less foundation**——"No upfront configuration required. Lightfield captures everything from day 1 and lets you evolve your data model over time" | docs.lightfield.app ／ 首页旧版 |
| 自我定位 | "**system of record AND system of action**"（客户证言引述） | lightfield.app 客户案例（Underflow CEO） |
| 融资与规模 | $47M Series A，a16z 领投，Maverick／Coatue／Greylock／Lightspeed 等跟投，**2026-09-09**；2025-11 上线；官网称"Powering thousands of leading companies"，第三方转述"5,000+ 家" | thesaasnews（转述）／lightfield.app 首页 |
| **与现有 CRM 的关系** | **仍是要取代，但把"取代"的摩擦打到最低**：Migration Agent 读任意 CSV → 自动识别结构 → 建自定义字段/管道阶段 → 导入并**自动串关系**；**90,000 记录/小时**；迁移后接邮箱回灌**最多两年**邮件与日历历史，可选批量导入通话转录 | lightfield.app/blog/agentic-data-import-in-lightfield |
| 数据主权立场 | CEO 表态："Your data is yours… Every object, every attribute… accessible through our API. **No egress fees. If you don't want our CRM, use the API to move your data somewhere else**" | 媒体转述（techintelpro／stratcom），**非官网一手** |
| 规模边界 | Pro 计划记录上限 **50,000**；主要面向高增长初创，大企业复杂地域/多组织管理受限 | 第三方评测（toolworthy.ai，转述） |

**判定**：Lightfield 的产品哲学是"**先抓后建**"（schema-less），商业哲学是"**把切换成本归零**"。它很清楚：**迁移痛是它唯一的增长天花板**，所以把迁移做成了一等产品并公开营销。它和 Attio 的区别不是战略，而是**执行**——Lightfield 用 AI 自研迁移，Attio 用外包 Import2。

### 1.3 Rox —— 上下文层叠加，路径是"借你的家"

| 项 | 事实 | 来源 |
|---|---|---|
| 一句话定位 | "Revenue Agents for the Global 2000"；商标 "Revenue on Autopilot" | rox.com |
| 架构自述 | **warehouse-native**，跑在"你公司已经信任的真相源"上；每个 agent 之下是 revenue-specific knowledge graph；"Governance is enforced by construction" | rox.com/articles/rox-for-sales-leaders |
| **与现有 CRM 的关系（核心）** | **"Rox treats any CRM as just another data source feeding the SOR"**（把任何 CRM 当作喂给自家 SOR 的普通数据源之一）；"we meet customers in their existing stack—CRMs synced to a warehouse of choice—and **we write back anything enriched or edited in Rox to their CRM**"；今天支持 Salesforce 与 HubSpot，"平台设计上可通过**配置**扩展到其他 CRM" | docs.rox.com/development/engineering/rox-enterprise-integrations/crm-integration |
| **终局明牌（必须读到的原文）** | "As that value becomes obvious, customers will graduate to a warehouse-native future where Rox writes directly to their warehouse (**and let's be honest: in that future, Rox is the CRM**)" | 同上 |
| 同步三层架构 | ①**Mappings Layer**：管理员配字段映射 + **同步方向**（Rox→CRM 单向只读 / 双向）+ 类型感知校验（NUMBER min/max、TEXT max length、nullable）②**Real-Time Layer**：UI 每次写入前**先实时回拉 CRM 当前值**，与用户编辑基线做快照/哈希比对——一致则写，不一致则**中止并展示最新值 + 隐式提供强制覆盖**；明确**不依赖时钟**（"CRM and Rox clocks are not guaranteed to be synchronized… We avoid NTP-style clock alignment and instead implement an **optimistic concurrency** strategy"）③**Batch Layer**：高批量单向回写（如 Clever Columns 物化进 CRM 字段）+ 待处理写回的安全对账 | 同上 |
| 变更来源消歧 | 需**确定性判定**某次变更源自 CRM 还是源自 Rox 回写，以解决双系统重复 | 同上 |
| 静态值映射 | 回写时给字段打固定值（如 `Subject='Demo'`、`Source='Rox'`），**让 Rox 写的数据在客户 CRM 里可过滤、可识别** | launch.rox.com/docs/product/organization-level-configurations/configuring-crm-writeback |
| 实施细节 | 通过 **Fivetran** 做数据搬运；建议建专用 Salesforce 集成用户（System Administrator profile）；按对象（Accounts／Opportunities／Contacts／Activities／Leads）分别配同步频率（5–1440 分钟）；Activities 支持 LinkedIn 消息/连接请求回写 + Lead Resolution | 同上 |
| 对 Salesforce 的公开姿态 | **"complementary, not competitive"**、**"The two platforms are most powerful when deployed together. Rox monitors the external universe and writes qualified pipeline to Salesforce. Agentforce manages that pipeline forward"**；并强调 "Rox integrates with Salesforce, HubSpot, and other CRM platforms and **does not require Salesforce as the foundational layer**" | rox.com/articles/rox-vs-salesforce-agentforce |

**判定**：Rox 是唯一一个**从第一天就不要求客户换系统**的玩家。这不是善意，是**入场券**——Global 2000 的 CRM 是十年沉淀 + 合规审计 + 千人使用的系统，任何"搬家"提案在采购会上都会被一票否决。**它先用"读"进入，用"回写"证明价值，再用"仓库原生"完成替换。**

---

## §2 架构对照

| 维度 | Attio | Lightfield | Rox |
|---|---|---|---|
| 架构立场 | 新 System of Record | 新 System of Record + System of Action | **System of Context**（叠加层，不抢记录系统） |
| 数据底座 | 柔性对象模型（object/attribute/relationship，运行时可变） | schema-less 先抓后建 + **temporal context graph** | **warehouse-native**，靠客户既有仓库 |
| 主数据归属 | 我方（客户搬入） | 我方（客户搬入） | **客户**（Rox 只建上下文与图） |
| 摄取来源 | 邮箱/日历/产品/计费 + Import2 迁移 | 邮箱/会议/通话 + CSV 迁移 agent | 外部市场信号 + 客户 CRM/仓库 |
| 中间层 | Universal Context（语义层） | World Model（编年叙事 > 图） | unified knowledge graph（实体解析跨公私源） |
| Agent 层 | agents + automations + workflows | **agent harness**（SDK + 确定性沙箱 + 持续 evals） | **agent harness** + Agent Swarms |
| 互操作 | SDK/API/MCP | API/MCP/CLI（5 种 quickstart） | MCP + **自研 Tether 协议** + ask-web |
| 治理重心 | 记录级权限、审计 | 数据主权、API 开放 | **读侧**：query-time access rules、Agent 继承用户权限、Access Provenance |
| 租户/隔离 | workspace_id 固化在记录 ID 三元组 | Workspace 作用域（Skill/Knowledge） | 角色 + 地域（territory）双约束，构造性强制 |

**一个值得注意的巧合**：Lightfield 与 Rox 都用 "**agent harness**" 这个词描述自己的 Agent 基础设施（Lightfield："An agent harness for reliable work"；Rox manifesto：须重造 data platform / **agent harness** / UI 三层）。两家的实现不同（Lightfield 偏 SDK+沙箱+evals，Rox 偏权限+技能体系），但**行业已经收敛到同一个词**。而这个东西在我方就是 `assertAgentAssembly` 的 8 个断言族 + 19 个 `method-*` SKILL + Action Registry —— **我方不是"打算做"，是"已经做完"**。

---

## §3 功能对照

| 能力 | Attio | Lightfield | Rox |
|---|---|---|---|
| 自动捕获互动 | ✅ 邮箱/日历/通话/产品/计费（15M 邮件同步/天） | ✅ 邮件/会议/通话 + 内置录音器 | ✅ 但**不做捕获**，读客户的 CRM/仓库 |
| 迁移/导入 | Import2（40+ 源，外包） | **Migration Agent（CSV，90k 记录/时，自研）** | 不需要（不搬） |
| 拓客/外呼 | ✅ Agents prospect and reach out；线索富化+评分+路由 | ✅ 目标账户按 fit/timing/connection 打分；生成式外呼 | ✅ **最强**：Auto-prospecting、Outbound Agent 四阶段、1B+ 联系人、瀑布富化 |
| 商机推进 | ✅ brief the meetings、catch changes to the deal | ✅ 会前准备、会后跟进、从会议建商机 | ✅ deal scoring、Stage-Aware Risks、Agentic Deal Risk |
| 预测/收入运营 | ✅ Forecast revenue、quota coverage、deal velocity | ✅ Pipeline analytics from real interactions | ✅ CEO Mode 实时管线、forecasting |
| 续约/扩销 | ✅ **Retain and expand**：账户升/降温预警 + 续约草案 | 🟡 有但非主打 | ✅ pipeline health |
| 反馈回路 | Signals 体系 | 客户→销售→工程的反馈坍缩 | ✅ 👍👎 / dismissal / Reply classification / Email quality evals ~80% |
| 决策可解释 | — | 答案带原始对话引用（citations） | ✅ **四个入口**：Show reasoning / Validate Insights / Research Insights 回溯 / Access Provenance |
| 治理立场 | 记录级权限 | 无 egress 费、数据可带走 | 读侧权限构造性强制 + 官方免责"须授权人员复核" |
| 定价形态 | 免费起 + 付费档 | Pro 计划（50k 记录上限） | **Agent Action 计量**：$100/月=10,000 actions；$255/月=15,000（**无限席位**）；Enterprise 议定 |

**定价那一条值得单独记一笔**：Rox 自称 "combines **outcome-based and usage-based** pricing"，但它的计量单位是 **Agent Action（动作次数）**，不是收入分成。**即"效果付费"的落地形态就是"按动作计量 + 自动充值 + 月度上限"**——门槛远低于"效果指标单元行业共识"这种想象。我方 `src/billing/metering.js` 已计量 `llm`/`embedding`/`evaluator`，加一层业务动作计价表即可，不必动现有三闸。

---

## §4 定位与商业路线对照（本次的核心）

```
                    数据来源：自建记录系统
                            ▲
        Attio ●             │             ○ 我方目标位
        Lightfield ●        │            （共存而非取代）
        我方（现状）●        │
   ─────────────────────────┼─────────────────────────▶
   要求搬迁                  │                与既有系统共生
                            │
                            │             ● Rox
                            ▼
                    数据来源：借用客户数据
```

| | Attio | Lightfield | Rox | **我方** |
|---|---|---|---|---|
| 主数据在哪 | 我这儿（搬过来） | 我这儿（搬过来） | **客户那儿**（我只建上下文） | 我这儿（粒子底座） |
| 进入动作 | 迁移（外包） | 迁移（自研，做到 1 小时） | **接上就完了** | **无进入通道** |
| 迁移态度 | 门槛，外包掉 | **头等产品，当营销武器** | 不需要 | 未建设 |
| 客户决策阻力 | 高（要搬家 + 重建流程，Salesforce 案例 4–8 周） | 中（搬家很快，但仍是搬家） | **低**（先读，零风险） | 高（要客户整体迁到新平台） |
| 终局意图 | 取代 | 取代（但承诺数据可带走） | 取代（**已在文档中明牌**） | 已是记录系统 |
| 护城河 | 柔性数据模型 + 生态连接 | 零录入 + 世界模型 + 迁移速度 | **外部信号 + 仓库原生 + 客户既有栈** | 决策问责 + 零信任 + 行业配置化 |

**一句话总结三家**：
- **Attio** 卖"**你的 CRM 应该长成你自己那样**"——为此你需要搬过来，代价是几周。
- **Lightfield** 卖"**你不需要再录入了**"——为此你需要搬过来，代价是一小时。
- **Rox** 卖"**你的管道不够满**"——**你什么都不用换**，我先接上去填管道。

**这三家的共同点反而是最值得我方警惕的**：它们全都认真对待了"**数据怎么进来**"这个第一性问题上，并且都把它做成了产品（迁移 / 捕获 / 同步）。我方到目前为止，**这个环节是空的**。

---

## §5 我方现状（源码级，逐条带锚点）

### 5.1 已经有了什么（比记忆里以为的多）

| 能力 | 证据 |
|---|---|
| **定时拉取框架（混合模式）** | `src/scheduler/timers.js` ⑩ `integration-poll`：逐租户 → `loadAdapters` → `runWaterfall` → `monitorAccount`（C3 闭环），间隔读 `config_store['integration-poll'].interval_ms`（默认 6h），`INTEGRATION_POLL_MS` 可覆盖，启动预热，失败 `emit trace + recordFailure` |
| **入站 webhook 挂载点** | `POST /api/integration/webhook/:provider` → `handleSignalWebhook` → 派发 `conn-signal-lead-gen`；admin/sysadmin 闸（`src/http/connectorRouter.js:71`、`:11-21`） |
| **手动同步端点** | `/api/connector/zhizao-verify`、`/qixin-enrich`、`/xinbang-sync`、**`/tenant-source-sync`**（`src/http/connectorRouter.js:40-88`） |
| **凭证与配额** | `src/connectors/discovery/credentialVault.js`；令牌计费 `recordTokens`（`src/alerts/tokenAccounting.js`） |
| **外部写入通道** | MCP `data-particle-create` / `data-particle-update` / `crm-knowledge-upsert`；`api_token` 三源解析（参数 / Bearer / 环境变量，`src/mcp/auth.js:70-79`）；高危写走第 0 闸 `force`（`src/mcp/tools.js:79`） |
| **调度器总量** | `timers.js` 共 **11 个定时器**（蒸馏、风险扫描、线索回收、决策复盘、三分类巡检、指名客户巡检、SLA 快照、ready-queue 泵、审计链巡检、integration-poll、校准 SLA） |

**判定**：**"同步机制"我方不缺**——定时、鉴权、凭证、配额、审计、失败留痕、多租户循环，全部已成体系。

### 5.2 缺的是什么（逐条锚点）

| 缺口 | 证据（`file:line` 或 grep 零命中） |
|---|---|
| **适配器全部朝外** | `src/connectors/` 共 25 个文件：`discovery/adapters/` 下 10 个（gaode 地理、qixin 企查查、tender 招投标、xinbang、emailVerify、webResearch、anysite、genericRest/Mcp/Cli）+ claygent／waterfall／orchestrationCompiler／monitorAccount／lookupRouter／dedupResolver 等编排件。**全部是获客/工商富化/信号监控方向** |
| **无 CRM 类同步对象** | `grep -r "salesforce\|hubspot\|zoho"` 在 `src/` 下仅 1 处命中，且是注释里的技术栈举例（`src/connectors/discovery/adapters/anysite.js:105`）→ 无任何 CRM 同步实现 |
| **无中国协同系统接入** | `钉钉`/`飞书`/`企业微信`/`wecom`/`dingtalk`/`lark` 在 `src/` 下**全部 0 命中** |
| **无 CSV/表格导入** | `parseCsv`/`parseCSV`/`csv-parse` 在 `src/` 下**零命中**（仅 `billingRoutes.js:137` 有 CSV **导出**） |
| **无字段级映射层** | `providerRegistry.loadAdapters` 是**适配器级**注册，无字段↔字段映射、无 sync direction、无类型校验 |
| **无回写通道** | 全部 4 个 connector action（`conn-attio-enrich-account`／`conn-zhizao-verify-account`／`conn-tender-push`／`conn-signal-lead-gen`，见 `src/connectors/connectorActions.js:18/53/99/132`）**全是 write-into-us，无一是 write-back-out** |

### 5.3 一个有意思的既成事实

`conn-attio-enrich-account`（`src/connectors/connectorActions.js:18`）——**我方已经把 Attio 当作外部富化数据源接进来了**。这与 Rox 把 CRM 当作 "just another data source" 是**同一个模式**，只是对象与方向不同。这说明我方架构**天然支持"外部系统作为数据源"**，缺的只是"把哪些外部系统接进来"的选择。

### 5.4 两处易误读，先排除

- `src/web/landing.html:146` 出现"销售易"三字，**不是竞品销售易**，是"**销售易手**不丢上下文"（销售离职/易手，动词短语）。勿当作竞品对比文案。
- 我方与 Attio/Lightfield 在"多租户隔离"上同构（`tenant_id` 全表 + `src/http/tenantScope.js` `scopeTenant`），但 Attio 把租户固化进位记录 ID 三元组——**一条在 ID 结构内，一条在行级列上**，取舍不同，无优劣。

---

## §6 "Rox 从现有 CRM 读取、不淘汰现有系统"是否值得借鉴

**结论：值得借鉴，但要拆成三层分别判断——商业路线照搬不了，工程机制值得抄，战略叙事最该学。**

### 层一：商业路线（先寄生、后取代）——**对象不匹配，照搬无落点**

Rox 敢这么走，前提是它的客户**已经有 Salesforce + 数据仓库**。它的算力来自"我就地取材"，成本为零。

我方的目标客户画像不同：中国 B2B 制造／化工／医疗器械的中端客户，**多数没有成熟 CRM**。他们的"事实发生地"是：
- 微信／企业微信／钉钉里的聊天与文件
- 邮箱里的往来（很多客户仍在用个人邮箱谈业务）
- Excel 台账（产品目录、报价记录、客户名单）
- 会议与电话（录音散落、无人整理）
- 财务/进销存系统（用友、金蝶，甚至只是打单软件）

**所以"接现有 CRM"这条路对我方是空转。但它的逻辑可以整体反转为本土版本：**

> **Rox：你在 Salesforce 里，我就接 Salesforce。**
> **我方：你不在任何 CRM 里，我就接你的"事实发生地"——钉钉/企微/飞书 + 邮件 + Excel + 会议。**

这与我方前一轮判定的 P0「内部互动数据捕获」是**同一件事**，只是这次找到了挂载点（§5.1 的 `integration-poll` 与 webhook 早在跑）。

### 层二：工程机制——**值得抄，且我方已有约 60% 骨架**

Rox 三层同步里有四个决策特别值钱，逐条对我方：

| Rox 机制 | 为什么值钱 | 我方现状 | 建议动作 |
|---|---|---|---|
| **字段级映射 + 同步方向 + 类型校验** | 让"接系统"变成**管理员可配置**而非每次开发 | 🔴 缺（仅适配器级） | config_store 命名空间 `sync.mappings`（字段↔字段 + 单向/双向 + 校验规则）。**纯配置，零新表** |
| **乐观并发、不依赖时钟**（写前回拉 + 快照/哈希比对 + 不匹配中止 + 显式 force） | 双系统写入的**唯一正确解**；绕开时钟不同步这个死结 | 🟡 **思想已有**：`casExpectStage` / `casExpectOwnerEmpty`（公海认领 CAS 原子性） | **把 CAS 语义从"阶段/归属"扩展到"字段值"**——复用同一套语义，非新建机制 |
| **回写静态值标记**（`Source='Rox'`） | 让回写的数据在客户系统里**可识别、可过滤、可审计**；顺带解决"变更来源消歧"的一半 | 🔴 缺 | 随映射层一起做，**成本极低、收益立竿见影** |
| **Batch / Real-Time 分层** | 高批量单向与实时事务写回**风险特征完全不同**，必须分开治理 | 🔴 缺 | 先只做"只读 + 单次单向回写"，批量层留接口 |

**层二的关键判断：Rox 那套最难的部分（冲突消解）我方已经有同构实现，只是用在了不同对象上。** 这不是"从零造轮子"，是"把已有的轮子换个轴装"。

### 层三：战略叙事——**最该学的一层**

Rox 对 Agentforce 的公开立场原文是 **"These are complementary directions, not competitive ones"**，并给出清晰分工："**Rox fills the pipeline**"、"Agentforce manages that pipeline forward"。这是**给客户一个零风险进入的台阶**。

我方现在的对外叙事是"AI 原生 CRM 平台"——**直接对撞客户已有的任何东西**，决策阻力最大。可改造为：

> **"我们不要求你废弃任何系统。先把客户事实接进来，跑出决策，你验证有效再谈别的。"**

配合"只读观察期"（先单向只读 → 再单向回写 → 最后才谈接管），这是一个**从"要求决策"变成"允许试用"**的叙事降级——对中国中端 B2B 客户尤其有效。

### 层四（附加）：一个不该学的
**不学它的商业终局。** Rox 文档那句 "in that future, Rox is the CRM" 是明牌。我方如果也把这句写在对外材料里，就等于自己拆掉"共生"叙事。**在客户面前，"共存"必须是真话，不能是话术**——否则一旦被识破，比一开始就讲"替代"更伤信任。

---

## §7 借鉴清单（按 ROI）

| 优先级 | 借鉴项 | 为什么是它 | 我方挂载点 / 成本 |
|---|---|---|---|
| **P0** | **把"数据进来"做成一等产品能力** | Lightfield 已证明：**迁移成本 = 切换成本 = 唯一增长天花板**，所以它把迁移做成了营销武器。我方连 CSV 导入都没有（`parseCsv*` 零命中）——**这是最短的一块板** | 新增导入 Action 或复用 MCP `data-particle-create`；走既有第 0 闸 + 审计。**红线：不新增粒子类型，映射走 config_store 配置化**。须 brainstorming |
| **P0** | **本土化"共生"对象：接客户的事实发生地** | 我方 25 个连接器全朝外；`钉钉/飞书/企业微信` 全 src 零命中。而挂载点**早已现成** | `POST /api/integration/webhook/:provider`（`connectorRouter.js:71`，已有 admin/sysadmin 闸）+ `integration-poll` 定时器（`timers.js` ⑩，配置化间隔）。最小闭环：IM/邮件/会议 → 实体抽取 → 关联粒子 → 入 `crm.events` → 供 `timelineSource` 四源融合消费。**与上一轮 P0「内部互动数据捕获」合并** |
| **P1** | **字段级映射 + 同步方向配置层** | 让"接系统"从开发任务变成**管理员配置**；对齐 Rox Mappings Layer | config_store `sync.mappings` 命名空间（沿用 `readConfig` 双租户回退）。**零新表** |
| **P1** | **字段级 CAS 冲突消解** | 双系统写入的正确解，且**我方已有同构实现** | 把 `casExpectStage`/`casExpectOwnerEmpty` 的语义扩展到字段值。**复用而非新建** |
| **P1** | **回写静态值标记** | 最便宜的一条：让回写数据在客户侧可识别、可过滤、可审计 | 回写路径加 `source` 固定标记。**成本极低** |
| **P2** | **只读观察期叙事 + 单向映射先行** | Rox 的 `Read-only insights, written back` 模式：先只读 → 客户零风险验证 → 再谈回写 | 产品与销售话术层，无需新代码 |
| **P2** | **批量单向回写通道（Batch 层）** | 报表/派生列物化回写；当前无用例 | 留接口，暂不实施 |
| **P2** | **动作计量计价表** | Rox 的"效果付费"落地形态就是 **Agent Action 计量**（$100=10k actions），门槛远低于想象 | `src/billing/metering.js` 已计量 `llm`/`embedding`/`evaluator`，加一层业务动作计价表即可，**不动现有三闸** |

**明确不做**：完整双向同步（含变更来源消歧、pending write 对账、Fivetran 级管道）。理由：投入大，且"只读 + 单向回写"已覆盖约 80% 的实际价值；双向同步的复杂度主要在**冲突治理**，而我方客户多数**根本不会双写**（他们没有另一个系统）。

---

## §8 明确不学的四条红线

1. **不学 Attio/Lightfield 的"取代式进攻"叙事。** 我方卖点是"可验证、可审计、不编"，这需要**降低**而非抬高客户的决策阻力。硬攻等于自伤定位。
2. **不学 Lightfield 的 schema-less 无政府主义。** 我方已有明确约束：不新增粒子类型、不改业务域模型（§10 硬约束），且多租户 + 审计 + 禁 DELETE 铁律不允许"字段随 agent 自动生长"。我方的路是"**柔性但有约束**"（`type` 自由 TEXT + `meta_attr` 动态 19 有穷集），这条路是对的，别改。
3. **不学 Rox 的"取消人工录入 / 替代 CRM"激进终局。** 管理可见性、审计留痕、HITL 是铁律；且我方客户**没有既有 CRM 可供"替代"**，该叙事在中国中端市场无落点。
4. **不学"数据可随意搬走、零 egress 费"的对外承诺表述。** 那是 Lightfield 的获客杠杆（对象是能一键导出 CSV 的初创公司）。我方对应能力是**租户隔离**（`tenant_id` 全表 + `scopeTenant`），表述应是"**数据不出租户边界**"，而不是"你可以带走"——后者在主数据权属要求严格的场景会反噬。

---

## §9 可引用叙事（三句，供对外材料）

1. **对客户**："你不需要先有 CRM，也不需要废弃现有的 Excel、钉钉或用友。我们先把你的客户事实接进来，跑出决策；你验证有效，再谈别的。"（= Rox 的进入策略，对象本土化）
2. **对行业/评审**："Attio 与 Lightfield 都要求你搬家，Rox 借你的家。我们是第三种位置：**自建记录系统 + 上下文共生层**——**用纪律换可验证，而不是用规模换概率**。"
3. **对投资人/合作方**："我们的迁移策略不是'把数据搬过来'，而是'**不需要搬**'。"

---

## 附录 A：证据索引

### 第三方（URL 锚点）
- Attio 首页（Universal Context™、Self-building、规模数字）：`https://attio.com/`
- Attio 迁移文档（Import2、40+ 源、Salesforce 限制）：`https://attio.com/help/reference/imports-and-exports/migrate-data-from-another-crm`
- Lightfield 首页（三大原语、agent harness、temporal context graph）：`https://lightfield.app/`
- Lightfield 官方文档（agent-native 定义、world model、automations/workflows、API）：`https://docs.lightfield.app/`
- Lightfield 迁移 agent 官方博客（90k 记录/时、两年邮件回灌）：`https://lightfield.app/blog/agentic-data-import-in-lightfield`
- Lightfield 融资（$47M A 轮，a16z 领投，2026-09-09；**转述来源**）：`https://www.thesaasnews.com/news/lightfield-raises-47m-series-a`
- Rox 产品线立场（"complementary, not competitive"、"Rox fills the pipeline"、客户成效）：`https://www.rox.com/articles/rox-vs-salesforce-agentforce`
- Rox 架构自述（warehouse-native、governance by construction、不拆 CRM 而是回写）：`https://www.rox.com/articles/rox-for-sales-leaders`
- **Rox CRM 集成核心文档（"just another data source"、三层同步、乐观并发、终局明牌）**：`https://docs.rox.com/development/engineering/rox-enterprise-integrations/crm-integration`
- Rox 回写配置（字段映射、静态值、Activities 回写、Fivetran）：`https://launch.rox.com/docs/product/organization-level-configurations/configuring-crm-writeback`
- Rox Salesforce 集成（读/写范围、专用集成用户）：`https://docs.rox.com/development/engineering/docs/rox-enterprise-integrations/salesforce-integration`

### 本地（`file:line` 锚点）
- 定时器总表与 `integration-poll`：`src/scheduler/timers.js` ⑩（`INTEGRATION_POLL_MS` / `config_store['integration-poll']`）
- 入站 webhook + 手动同步端点：`src/http/connectorRouter.js:11-21`、`:40-88`（`/integration/webhook/:provider` 在 `:71`、`/tenant-source-sync` 在 `:80`）
- 连接器动作清单：`src/connectors/connectorActions.js:18`（`conn-attio-enrich-account`）、`:53`、`:99`、`:132`
- 连接器全清单：`src/connectors/`（25 文件）+ `discovery/adapters/`（10 个）
- 凭证保险箱：`src/connectors/discovery/credentialVault.js`
- MCP 鉴权与 `api_token` 三源：`src/mcp/auth.js:70-79`；高危写第 0 闸：`src/mcp/tools.js:79`
- 计费计量维度：`src/billing/metering.js`（`llm`/`embedding`/`evaluator`）
- 前置对照文档：`docs/2026-09-15-rox-benchmark-differentiation-analysis.md`、`docs/2026-09-03-attio-lightfield-study.md`、`docs/2026-09-03-lightfield-attio-gap-study.md`

### 零命中证据
- `钉钉` / `飞书` / `企业微信` / `wecom` / `dingtalk` / `lark` → `src/` 下 0 命中
- `parseCsv` / `parseCSV` / `csv-parse` → `src/` 下 0 命中
- `salesforce` / `hubspot` / `zoho` → `src/` 下仅 1 处，为 `anysite.js:105` 注释中的技术栈举例

## 附录 B：本次修正的旧判断

| 旧判断 | 本次核实 |
|---|---|
| "我方缺外部接入器" | 🔴 不准确。**25 个连接器 + 10 个采集适配器 + 定时拉取框架 + 入站 webhook 全在运行**。精确表述：**缺的是"同步对象"（方向全朝外）与"数据入口"（无 CSV 导入）** |
| "Rox 用 Agent Action 计价 = 效果付费" | 🟡 原本凭推测，本次有一手依据：其定价页与 FAQ 明示 outcome-based + usage-based，计量单位是 Agent Action |
| "Attio/Lightfield 都是'取代'" | ✅ 成立，但**两家的差别在执行**：Attio 迁移外包、Lightfield 迁移自研并营销化。这个差别对"迁移是护城河"这个判断很关键 |
| `landing.html` 出现"销售易" | 🔴 不是竞品，是"销售易手"（动词短语），已排除 |
