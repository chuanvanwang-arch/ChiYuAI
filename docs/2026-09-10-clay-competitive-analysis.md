# Clay 能力 → CRM-ai-native 映射与反定位分析

> 文档目的：将用户连续提供的 5 轮 Clay 能力描述，逐层映射到 CRM-ai-native 的**原生原语**（设计文档 v7 + 实施计划 + 已 live 的 method-* SKILL / agent-mail），厘清「已覆盖 / 待补强 / 反定位」三态，并汇总待补入计划与设计文档的 **G1–G8** 项，供确认后落盘。
>
> 锚点约定：`plans:` = `docs/superpowers/plans/2026-09-10-lead-discovery-engine.md`；`design:` = `docs/2026-09-10-lead-discovery-design.md`。

---

## 0. 结论（结论先行）

Clay 的四条能力线（数据层 / 外联方案 / 生态集成 / 战略定位）**大部分已被我们 v7 设计覆盖**，且我们的**架构形态更优**（本体优先替代 150 家付费瀑布、native-CRM 替代 sidecar 同步、自主流水线 + HITL 闸替代几十人 SDR）。

真正需要在计划/设计文档中**补强**的，是把「已具备的能力」**显式连接成闭环**并**补全少数缺口**（评分维度不全、缺刷新机制、缺下游消费契约与回复闭环、缺可组合/no-fixed-flow 原则陈述、缺 campaign 形态）。共 **G1–G8** 项，均**仅改文档、不写实现代码**，符合 §10 硬约束（不新增粒子、不改业务域模型）。

---

## 1. 四层能力映射总表

| Clay 能力层 | 关键能力点 | 我们原生原语 | 状态 |
|---|---|---|---|
| **数据层** | 150–200+ 数据源、一份合同一个平台 | D1 三档分级 + Provider Adapter 框架（`plans:103-114`） | ✅ 覆盖（G2 强化原则） |
| | Waterfall 顺序扫描、命中即停 | `runWaterfall` 逐字段首命中即停（`plans:245-260`） | ✅ 实现正确（G1 纠错注释） |
| | 多维优先级排序（收入/规模/动态/招聘/融资/技术栈） | `signals` 7 维 + `lead-fit` rulers（`plans:115-122`, `546-551`） | ⚠️ 部分缺口（G3） |
| | 新信息出现自动刷新数据集 | 事件矩阵仅 `discovery-sync`（`plans:554-557`） | ⚠️ 缺刷新机制（G4） |
| **外联方案** | AI 个性化外联（业务背景/动态/痛点） | `method-followup-engine` + `why_narrative`（`plans:419-422`） | ✅ 覆盖（G5 声明契约） |
| | 兴趣后生成方案/演示/跟进/广告 | `method-quote-engine` / `method-presales` / `method-opportunity-matrix` | ✅ 覆盖（G5） |
| **生态集成** | 双向同步 Salesforce/HubSpot | 我们即 CRM，原生落库（`dedupResolver` `plans:574`） | ✅ 反定位优势 |
| | 邮件发送器 Outreach/Instantly | `agent-mail`（已连接）+ `method-followup-engine` | ✅ 覆盖（G6 闭环） |
| **战略定位** | Excel + Zapier + 销售军团 | account-360 + 事件矩阵 + discovery 自主引擎 | ✅ 覆盖（G7 叙事） |
| | 单人驱动、智能体静默运行 | 操作员 = HITL 闸（P0#3 `design:299`） | ✅ 覆盖（G7） |
| **工作流形态** | 导入名单→逐列加任务→逐列富集 | `runWaterfall(fields[])`（`plans:197-202`） | ✅ 覆盖（G8b campaign） |
| | 自由组合数据+条件+AI+动作（无固定流程） | 配置驱动差异化铁律 | ⚠️ 缺原则陈述（G8a） |

---

## 2. 逐层详述

### 2.1 数据层

**Clay 描述**：整合 150–200+ 外部数据源，一份合同一个平台；Waterfall 按预设顺序扫描多个库直到找到所需信息；按收入潜力/公司规模/业务动态/招聘信号/融资事件/技术栈变化多维排序；新信息出现自动刷新。

**映射与证据**：
- **多源接入**：`plans:103-114` 已定义 `providers` 三档（system / system-candidate / paid-disabled-by-default，对应 D1）。新增第 N 个源 = drop-in adapter + `config_store` 租户级注册，**零核心改动**。
- **Waterfall**：`plans:245-260` `runWaterfall` 对 `fields` 逐个字段按 costTier 升序扫描、首个命中 `break`——**与 Clay「第一家没有就查第二、第三家直到找到」语义完全一致**。⚠️ 但 `plans:26` 注释误写「首命中即停、**取并集覆盖**」，与实现矛盾，须删（G1）。
- **多维评分**：`plans:115-122` 已定义 `funding_round / hiring_icp_role / tender_match / leadership_change / tech_adopt（技术栈）/ website_redesign`；`lead-fit` scenario（`plans:546-551`）rulers 仅消费 `industry/headcount/geo/hiring_icp_role/funding_round` + `importance`，**未消费** `tech_adopt/tender_match/leadership_change/website_redesign`，且**缺 `revenue_range`（收入潜力）**（G3）。
- **自动刷新**：计划仅 `plans:554-557` 一条 `CRM_KNOWLEDGE/discovery-sync → lead-fit` 事件，**无「信号到达→既有线索重评分」「增量定时刷新」**（G4）。

**反定位**：我们**不追求 150 家付费商**，以「本体写时自动补全覆盖 80% + 缺口才调 adapter」降工具复杂度（`design:24,57,68`）。这是结构性优势，需在文档显式陈述（G2/G7）。

### 2.2 外联与方案生成

**Clay 描述**：AI 据业务背景/近期动态/痛点生成个性化外联邮件；兴趣产生后生成定制方案（演示文稿/跟进邮件/广告）。

**映射**：发现引擎产出的 payload 已携带外联所需全部 grounding——`enrichment`（背景）、`signals`（动态）、`why_narrative`+`icp_fit_score`（痛点/适配度，`plans:419-422`）。下游由**已 live** 的 `method-followup-engine`（外联/跟进）、`method-quote-engine` / `method-presales` / `method-opportunity-matrix`（方案/演示）消费。**引擎内无需新增任何能力**，只需声明「payload → method-SKILL 输入契约」（G5）。广告推广超出核心 CRM 范畴，标记 future。

### 2.3 生态集成

**Clay 描述**：深度交织 Salesforce/HubSpot + Outreach/Instantly。

**映射**：
- **CRM 同步**：我们即 CRM，discovery payload 经 `dedupResolver`（`plans:574`）**原生落 `CRM_ACCOUNT`/`CONTACT`，零 sidecar 同步税**——这是相对 Clay 的结构性优势。若客户坚持以 SF/HS 为源，可经 D1 框架加 inbound provider（P1 可选）。
- **邮件发送**：`agent-mail`（已连接）+ `method-followup-engine`。需声明**外发+回复闭环**：生成→`agent-mail` 发送→回复事件→G4 重评分/商机推进（`method-stage-progression`）（G6）。

### 2.4 战略定位

**Clay 描述**：AI 时代 Excel + Zapier + 自动化销售军团；单人驱动、智能体静默运行的流水线；极小团队掀起高增长。

**映射**：
- Excel → account-360 insight（进行中 7-Task）+ CRM 视图 + portal NL→Page
- Zapier → 事件矩阵 `src/decision/eventTrigger.js` + orchestrator + kanban 路由
- 销售军团 → discovery engine（`lead-fit` `autonomous_allowed=TRUE` `plans:547`）+ 多智能体编排
- 单人驱动 → 操作员角色 = **HITL 人工闸**（P0#3 ICP 自进化绝不自动生效 `design:299`）；其余静默

设计文档已有「反转为本体优先」框架（`design:12,24,57,68-72`），G7 将其凝练为独立的「与 Clay 能力映射及反定位」小节，作为对外叙述收口。

### 2.5 具体工作流示例（逐列印证）

> 用户示例：导入公司名单→逐列加任务→查规模+融资→查招聘页判销售岗是否增加→找负责人 姓名/邮箱/电话→AI 读官网生成差异化联系理由→邮箱瀑布（首家无果查第二、第三家）→连 200+ 供应商→自由组合数据+条件+AI+动作。

| 步骤 | 我们原语 | 锚点 | 状态 |
|---|---|---|---|
| 导入名单 | `discovery-rules` ICP + seed | Task 1 | ✅ |
| 逐列加任务 | `runWaterfall(fields[])` | `plans:197-202` | ✅ |
| 规模+融资 | `headcount` + `funding_round` | `plans:116,548` | ✅ |
| 招聘页/销售岗增加 | `hiring_icp_role`（含 role 过滤） | `plans:117` | ✅ |
| 找负责人 姓名/邮箱/电话 | waterfall `[name,email,phone]` | `plans:245-260` | ✅ |
| AI 读官网生成理由 | `claygentResearch`（Task 8）+ `why_narrative` | `plans:707-740,422` | ✅ |
| 邮箱瀑布（逐家直到找到） | `runWaterfall` 首命中即停 `break` | `plans:248-257` | ✅ 印证 G1 |
| 连 200+ 供应商 | D1 + adapter 框架 | `plans:103-114` | ✅ |
| 自由组合（无固定流程） | 配置驱动差异化 | — | ⚠️ G8a |

---

## 3. 反定位（我们的三条结构性优势）

1. **本体优先，而非 150 家付费瀑布**：内部本体写时自动补全覆盖 80%，外部 adapter 仅补缺口——降工具复杂度、降数据清洗比对成本（`design:24,57,68`）。
2. **native-CRM，而非 sidecar 双向同步**：发现→评分→外联→回复闭环无跨系统同步税（G6）。
3. **自主流水线 + HITL 闸，而非几十人 SDR**：单人驱动、智能体静默；关键决策（ICP/折扣/审批）走零信任写闸 + 人工确认（P0#3 `design:299`）。

---

## 4. 待补项汇总（G1–G8）

| 项 | 类型 | 落点 | 说明 |
|---|---|---|---|
| **G1** | 文档纠错 | `plans:26` | 去「取并集覆盖」，改「逐字段 costTier 升序、首命中即停」 |
| **G2** | 原则陈述 | Task 2 | 增补「按需接入、零核心改动」+ 本体优先反定位 |
| **G3** | 补评分维度 | Task 1 + Task 6 | `signals` 加 `revenue_range`；`lead-fit` rulers 扩展含 tech_adopt/tender_match/leadership_change/website_redesign/revenue_range |
| **G4** | 刷新机制 | P1 治理/新 Task | 信号到达重评分 + 可选增量定时刷新 |
| **G5** | 下游消费契约 | 新增段 | payload→`method-followup-engine`/`method-quote-engine` 输入契约（复用） |
| **G6** | 外发+回复闭环 | 新增段 | 生成→`agent-mail` 发送→回复事件→重评分/推进（复用） |
| **G7** | 定位叙事 | 设计文档 v7 新增 § | 「与 Clay 能力映射及反定位」小节 |
| **G8** | 可组合 + campaign | 设计原则 + Task 7 | G8a 可组合/no-fixed-flow 原则；G8b 批量 campaign 形态（与事件触发并存） |

**约束**：G1–G8 均**仅改文档、不写实现代码**；不新增粒子类型、不改业务域模型；提交由用户在本地按功能线 PowerShell 执行（禁 `git add -A`）。

---

## 5. 建议下一步

待你确认后，按 G1–G8 一次性补入：
- **G1–G6、G8** → `docs/superpowers/plans/2026-09-10-lead-discovery-engine.md`
- **G7** → `docs/2026-09-10-lead-discovery-design.md`（v7 新增反定位小节）

确认方式：回复「**补入**」即按 G1–G8 落盘；或指定保留/剔除某项（如「只补 G1/G3/G7」）。

---

## 6. Clay 官网实地核验与架构拆解（2026-09-10，一手抓取）

> 来源：https://www.clay.com、/demo、/claygent、/integrations 实测抓取。以下为 Clay 当前（2026）对外呈现的产品架构与功能，用于校准 v7 设计与 G1–G8。

### 6.1 定位演变：从「工具」到「GTM Infrastructure + Agentic」

- 官网主标语：**"Build systems to grow revenue. Infrastructure to get any data, run agentic workflows, and launch GTM plays."**
- 客户定性引述：**"Clay has become the orchestration layer for everything GTM. Salesforce for record-keeping, Snowflake for product data, and Clay for turning it all into automated action."**
- 关键信号：**Clay 已从「数据+自动化」进化为「agentic GTM 平台」**。这**强印证**我们 v7 把发现做成「自主智能体循环（KMD + 事件矩阵 + 多智能体编排）」的方向正确——我们领先的不在"多数据源"，而在"原生 agentic 发现"。

### 6.2 四支柱架构（官网主导航）

| 支柱 | 含义 | 我们 v7 对应 |
|---|---|---|
| **Data** | 200+ 供应商市场，一份合同买全；可建任意互联网意图信号；自有+第三方数据融合 | D1 三档 + Provider Adapter + waterfall 成本计量（G2） |
| **Agents（Claygent）** | 模仿顶级销售的智能体，挖 web 自定义数据点、持续监控账户、为每次触达备料 | 我们 lead-discovery 引擎即此循环的**原生实现** |
| **Orchestration** | 把所有 GTM/AI 工具连到 common data layer；跨 CRM+DWH 百万级记录更新；逻辑一次定义处处复用 | 我们事件矩阵 + 配置驱动差异化 + dedupResolver 原生写库（G6） |
| **Execution** | 触发邮件/广告等，与既有工具集成；程序化 1:1 文案；新测试数日上线 | G5 payload→method-* SKILL；G6 agent-mail 外发 |

### 6.3 核心架构范式（table/column + waterfall + marketplace）

1. **Table/Column 范式（=Excel+Zapier）**：行=公司/人，列=一次数据动作（数据源查找 / AI 提示 / 公式）。熟练用户自由组合"数据→条件→AI→动作"，**无固定流程**——印证 G8a。
2. **Waterfall 富化**：一列可链式调用多个 provider，**顺序直到命中**——印证 G1 纠错（逐字段首命中即停）。
3. **Data Marketplace**：200+ vendor，一份合同 + credits 计费（"未匹配免费"）；与 D1「付费默认禁用」同源思路，但 Clay 用市场聚合，我们用 adapter 按需 drop-in。

### 6.4 Claygent 智能体架构（最值得借的范式）

两种 agent 类型（官网 FAQ 明确）：

| 类型 | 运行域 | 记忆 | 写入 CRM/DWH | 更新节奏 |
|---|---|---|---|---|
| **General-purpose Claygent** | Table/Workflow 单行/单元格 | 无状态（每次重跑） | 手动配置 | 按需/定时，固定条目 |
| **Account Agent** | Audiences（整段账户） | **持久记忆，跟踪"变了什么"** | **自动（人工批准）** | 按段动态 |

关键工程特性（直接对应我们设计）：
- **Glass-box（非黑盒）**：**每个 agent 决策带完整推理链**；Audiences 下可看每个 agent/段的 spend 与 error → 直接对齐 **P0#1 2D judge（axis/rule_ref/j_score + why_narrative）**。可解释性不是锦上添花，是 Clay 的产品卖点。
- **Prompt 版本化 + 回滚**：改 prompt 在 agent 运行处全局更新、可即时回滚 → 对应我们「配置驱动差异化 + ICP HITL 绝不自动生效（P0#3）」。
- **Account Agent 持久记忆** → 对应 **ai-memory-lifecycle**（append-only log + 30 天蒸馏 + curated notes）。我们已在方法论层覆盖，无需新增。

### 6.5 Common Data Layer 与集成矩阵

Clay 用 common data layer 把外部系统连成"双向同步税"：
- **CRM**：Salesforce / HubSpot / Dynamics 365（create/update/upsert/lookup）
- **DWH**：Snowflake / BigQuery
- **邮件发送**：Outreach / Salesloft / Instantly / Smartlead
- **广告**：LinkedIn / Meta / Google（turn top accounts into ad audiences）
- **通话/意图**：Gong、TrustRadius、Semrush、SimilarWeb

→ 这正是我们 G6 所指的"sidecar 双向同步税"：Clay 必须付此成本，而**我们 native-CRM 原生写库无此税**。

### 6.6 七大 GTM 用例（功能面）

TAM Sourcing / Automated Inbound（全量入站打分路由）/ Lead Scoring（实时意图+互动信号）/ Automated Outbound（活意图个性化）/ **CRM Enrichment（持续用 live data 刷新，保持记录准确）** / **Launch Ads（账户→LinkedIn/Meta/Google 受众）** / Rep Productivity（自动化研究/备料/跟进）。

→ "continuously refreshed / monitor accounts for reasons to engage" 是 Clay 的产品卖点，**强印证 G4（信号到达重评分 + 增量定时刷新）**，且应将 G4 优先级上调（非仅 P1 治理）。

### 6.7 对我们 v7 的增量启示（在 G1–G8 之上）

| 增量 | 结论 |
|---|---|
| **G9 Glass-box 可解释性** | 非新需求——Claygent reasoning trace = 我们 P0#1 的 why_narrative + rule_ref。**强化 P0#1 必要性**，不新增。 |
| **G10 Ads 投放面（future）** | Clay 把账户转 LinkedIn/Meta/Google 广告受众；我们 G5/G6 仅覆盖 email+方案，**ads 超出引擎范畴，标 future**，不纳入本轮。 |
| **G4 优先级上调** | "持续刷新/监控"是 Clay 卖点 → G4 从 P1 治理升为**应纳入 P0 级闭环**（信号触发重评分）。 |
| **Agentic 定位印证** | Clay 进 agentic 印证我们 KMD+多智能体方向；v7 引擎即其 agentic discovery loop 的原生实现——G7 反定位叙述应补此点。 |
