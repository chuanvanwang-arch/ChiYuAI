> ⛔ **已废弃（SUPERSEDED）— 2026-09-15**
> 本文结论**已被完整吸收并取代**。唯一有效设计 → `docs/2026-09-15-final-design-coexistence-and-proactive.md`（最终设计 v1.0）。
> **本文件仅保留过程证据与一手资料锚点，用于追溯；不得作为实施、评审或对外表述的依据。**
> 若本文与最终设计冲突，一律以最终设计为准。

---

# Rox（Rox Data Corp）官网对标分析：平台差异与核心能力

> 分析日期：2026-09-15
> 证据来源（均为一手）：`www.rox.com`（首页/平台/定价/理念页/安全页）、`docs.rox.com`（Revenue Operating System 章节、Release Notes 全量）、`launch.rox.com/docs`（Founder Note）；平台侧为源码级盘点（407 个 `src/*.js` / 50,624 行 JS、15,297 行 HTML / 84 页、`test/` 621 文件 4,111 例）。
> 标注约定：**【事实】**=官网原文或代码可查；**【推断】**=基于证据的分析判断。

---

## §0 结论先行

1. **Rox 不是我们的竞争对手，是能力面对标物。** 它的客户是 Global 2000 的 top 15% AE，官方定位是"raise the ceiling for the top sales teams **instead of** raising the floor for the rest"——明确放弃中小账户与初级销售。我们的客户是中国 B2B 制造/医疗器械/化工/涂料的中型销售组织。
2. **我们的差异不在"AI 能力"，在"约束能力"。** Rox 把 AI 做得更放手（自动发邮件、拨号、跑序列），我们把 AI 关进流程（决策第 0 闸、双阶段 token、8 断言族装配校验、BANT 硬闸门）。**两者是同一根轴上的两端，不是同一功能的强弱。**
3. **我们有一项结构性优势被自己低估**：Rox 在 manifesto 里**公开承认**"There is no hill-climbing possible against a golden benchmark"（没有金标准基准可爬坡）；而我们有 4,111 例测试 + `calibration/replay.js` 快照回放 + 装配断言体系。**在"AI 判断可验证性"上，我们的工程底座比它厚。**
4. **Rox 值得抄的只有一条是 P0**：`Agent Action` 计价单元——它把"效果付费"落成了"按动作计量 + 自动充值 + 月度上限"，是**可立刻复用**的务实设计。其余可借鉴项优先级见 §5。

---

## §1 Rox 事实盘点（官网一手）

### 1.1 公司与商业基本面

| 项目 | 事实 |
|---|---|
| 主体 | Rox Data Corp，251 Rhode Island St, Suite 205, San Francisco |
| 官网 / 文档 / 应用 | `www.rox.com` / `docs.rox.com` / `run.rox.com` |
| 定位标语 | **Revenue Agents for the Global 2000**；商标 "Revenue on Autopilot" |
| 创立 | 2024-02-14；创始人 Ishan Mukherjee（CEO）、Avanika Narayan、Diogo Ribeiro、Shriram S（CTO）、Chris R |
| 融资 | 累计 **$50M**（Sequoia 领投种子、GV 参投、General Catalyst 领投 A）；估值 **$1.2B**（2026-03-12 A 轮后）；40+ 天使 |
| 规模 | 152 员工（2026-07）；自称 **450B tokens 消耗、25M agents 生产编排、150TB 数据受治理、多区域部署** |
| GA 时间 | **2025-09-16** Generally Available（此前 public beta） |
| 资质 | SOC 2 Type I/II、GDPR、CASA；AES-256；**不用客户数据训练通用模型**；企业可 **in-VPC 部署** |
| 背书面 | IDC MarketScape 2026 "Major Player"（Worldwide Unified Revenue Orchestration Platforms）；Gartner Cool Vendor 2025（AI for B2B Sales Productivity） |

### 1.2 架构主张（Revenue Operating System 章节原文要点）

**【事实】范式三段论**：
- Cloud 1.0：从本地到云；
- Cloud 2.0：数据仓库（Snowflake/Redshift/BigQuery）把数据从 CRM 抽出，**system of record 与 system of engagement 解耦**，CRM 退化为"事后记录系统"，同时催生一堆点工具；
- **AI-native 时代**：原文——"**Models are the new compute, context windows the new memory, and reasoning replaces static workflows.**" AI 正在驱动 **rebundling**：记录系统与交互系统重新收敛为单层 = **Revenue Operating System**。

**【事实】两层架构**：
1. **System of Context**（底座）：统一私有数据（CRM、support、product usage、email、Slack）与公开数据（news、filings、job postings）的数据织物；**warehouse-native、event-driven**。
2. **Agent Swarms**（其上）：常驻 agent 集群，自动做低价值任务（研究、排程、数据录入），在恰当时机浮现高价值洞察与下一步。

**【事实】交互主张**："meet sellers where they are"——iOS / Mac / Slack / API / Webapp，而非"再逼销售多登一个系统"。

**【事实】定位声明**："This is **not a thin layer on top of legacy CRMs** — it is a reimagining of enterprise business systems from the ground up."

### 1.3 Manifesto：他们自己列出的 5 条行业特异性（原文）

1. 数据分散在 warehouse、CRM、email、calendar、call recorder（私有）与 enrichment 供应商、public web（公开）；
2. **没有两家公司的 GTM 流程相同**；
3. **没有金标准基准可爬坡**，因为工作流不受 IDE / 工单系统约束，"好"高度主观；
4. 回报周期长（线索到成交需数周到数月）；
5. UI 长期碎片化，**销售的注意力需要被赢得**。

结论句："Innovation in this vertical requires us to re-invent the way humans AND agents work from the ground-up across **the data platform, the agent harness and the UI**."

> **对平台的直接价值**：第 3 条是他们**主动声明 eval 难做**。这为我们在"可验证性"上的差异提供了对手方证词。

### 1.4 产品表面（Platform 导航）

`Agent Workflows` / `Sales Intelligence` / `Conversation Intelligence` / `Sales Engagement`，加产品内模块：Research、Meet、Outreach、Revenue、Auto-fill proposals、Rox apps、iOS app、Mac app、CEO Mode、Dialer、Plays、Clever Columns、Artifacts（PPTX/DOCX）、Voice Mode、**Skills**、**Org Memory**、Live Coaching、Agentic org charts、Agentflows。

### 1.5 定价与计量（关键）

| 套餐 | 价格 | 计量 | 关键差异 |
|---|---|---|---|
| Individual | **$100/月** | 10,000 agent actions/月 | 账户研究、联系人富化、多通道外联 |
| Teams | **$255/月** | 15,000 agent actions/月 | **无限席位**、CRM 同步与写回、团队与用户管控 |
| Enterprise | 联系销售 | 议定 | **数据仓库同步**、SAML/SCIM/SSO、专属部署与支持团队 |

**【事实】FAQ 原文**："Rox's pricing model combines **outcome-based and usage-based pricing**... you only pay for the specific outcomes achieved by Rox's AI agents, which are measured in units called '**Agent Actions**'." 每个任务（研究潜客、生成会议简报、提供客户洞察）折算为确定的 Agent Actions 成本。

**【事实】实现细节**（Release Notes 2026-07-22 / 2026-08-18）：Agent Actions 余额低自动充值 + **月度支出上限**；Teams 套餐"**按 Agent Actions 计量，无按席位授权**"。

> **辨析【推断】**：Rox 自称"outcome-based"，但计量单位是 **agent action（动作）**，**不是收入分成或结果保底**。也就是说——它落地的是"按 AI 动作计量"，而非真正的"效果付费"。这个辨析很重要：我们不必把"效果付费"当成一道高不可攀的鸿沟，它是"把 token 计量换成动作计量 + 加一层额度治理"。

### 1.6 权限 / 治理 / 安全（读侧为主）

- **Governance**（2026-07-15）：**查询时点**应用访问规则；Role-based access（按角色范围返回答案）；**Access Provenance**（溯源访问原因）；**Agent-aware by default（agent 继承用户权限）**；
- **Field-level permissions**（2026-07-22）：权限图解析对象与字段级访问，可**模拟移除预览效果**；
- Artifact governance（2025-12-30）：上传文档的细粒度访问与用途控制；
- User impersonation（管理员模拟用户视图）、User-level consent for O365、Restricted email domains、**Negative content guardrails**（防检索负面/诽谤信息）；
- Security Trust Portal（自助查 SOC 2 / CASA / 政策）。

> **关键判定【推断】**：Rox 的治理重心在**读侧**（谁能看到什么），几乎未见"写侧强制闸门"（如每步写入需前置决策锚点或双阶段确认）。我们的重心在**写侧**。两者**互补而非重叠**。

### 1.7 发布节奏与能力演进（Release Notes 全量观察）

- **频率**：2024-08 至 2026-09，**每周一个版本**，条目粒度细，绝大多数是增量改进；
- **演进主轴**：【推断】2024–2025H1 做数据与富化 + 会议转录；2025H2 做外联执行（Sequences/Dialer/Plays）；2026 做 agent 化（Auto-prospecting/Agentflows/Skills/Agent Actions/Voice Mode/Apps）；
- **值得注意的里程碑**：2025-05-27 **Org Memory**（组织级长期记忆）；2025-09-02 Opportunity Stage Gating（**阶段变更自定义校验 + 多阶段审批流**）；2026-06-17 **Skills**；2026-08-25 **Agentflows**（自然语言 + 限定工具，自主规划与纠错）；2026-09-09 **Artifacts**（PPTX/DOCX 生成 + 模板重样式化）。
- **技术研究输出（Rox Research）**：`Agentic Retrieval: Knowledge Graphs vs. Relational Schemas`（2026-08-17）、`Rox Tether: Agentic UI alternative to MCP Apps, A2UI or ChatGPT Apps`（2026-07-29）、`ask-web`（自研网页搜索基础设施，2026-07-17）。

> **【推断】两个战略信号**：① 他们在 **MCP 之外自建 Agentic UI 协议（Tether）**，说明 MCP 在其判断中不够用；② 他们**自建搜索基础设施（ask-web）**，把数据获取当核心资产而非采购项。这两条都印证 §3 的"数据获取是护城河"判断。

### 1.8 官方免责声明里的一句关键话（原文）

> "All AI-generated outputs... are provided for informational purposes and **should be reviewed by authorized personnel before any action is taken**. ... Features described as 'autopilot,' 'autonomous,' or 'automated' operate within user-defined parameters and **require initial configuration and ongoing oversight**."

**【推断】意义**：最激进的全自动厂商也在合同文本里承认"必须人在环监督"。我们的 HITL 不是落后，是**行业共识的法律表达**。

---

## §2 平台侧核心能力（源码级实证）

| # | 核心能力 | 证据锚点 | 成熟度 |
|---|---|---|---|
| 1 | **方法论内嵌为可执行闸门**：DSM/BANT/BANTCC/21 条拜访行为标准 → Action + 阶段门控 + CAS 原子推进 | `src/sales/stageTaxonomy.js`（S0/S0P/S1–S8 + `S_TRANSITIONS`/`S_GATE_DEFS`/`S_ATTACHMENT_GATES`）、`src/sales/leadQualify.js`、`src/sales/behaviorStandard.js` | 已交付 |
| 2 | **写侧零信任治理**：决策第 0 闸 + 双阶段 `confirm_token` + Action Registry 白名单 + 装配 8 断言族 | `src/mcp/gateway.js:141/199/231/243/271`、`src/mcp/tools.js:70-84`、`src/agent/agents.js:66`（8 断言族见 `:76-121`） | 已交付，**强于对标** |
| 3 | **决策管道（确定性优先）**：9 尺子 = 8 确定性 + 1 LLM（默认关）；7 个场景顾问；溯源与根因 | `src/decision/rubricScorer.js:17-27`、`src/decision/scenarioAdvisors.js:132-138`、`src/decision/provenance.js`（358 行）、`decisionTrace.js`、`rootCauseClassifier.js` | 已交付 |
| 4 | **多租户 + 100% 配置化差异化** | `src/http/tenantScope.js:4` `scopeTenant()`、`config_store`（阈值/告警/套餐/触发矩阵/公海池配置） | 已交付 |
| 5 | **Agent 编排**：7 个 Agent + 19 个 `method-*` SKILL + 事件触发 | `src/agent/agentSpec.js:3-104`、`src/agent/eventTrigger.js`（3 条规则、全只读）、注册于 `src/http/server.js:97` | 编排已交付；**事件触发覆盖面窄** |
| 6 | **MCP 协议面**：74 个 Action（写 52 / 读 33 / 敏感读 4，含跨文件重叠） | `src/action/seed-actions.js`（84 处 `registerAction`）+ `prospectingActions.js` + `preheatActions.js` + `discoveryActions.js` | 已交付 |
| 7 | **写库即构建**：三钩子（embedding / tsvector / 本体同步） | `src/ontology/hooks.js` | ⚠ **条件生效**：仅 `EMBEDDING_PROVIDER=model` 才写 `vector(1024)`，否则 `embedding=NULL` |
| 8 | **数据获取（对外）**：10 个 adapter + 瀑布式富化骨架 | `src/connectors/discovery/adapters/`（gaode/qixin/tender/xinbang/emailVerify/webResearch/anysite/genericRest/Mcp/Cli）、`waterfall.js`、`orchestrationCompiler.js` | 骨架已有，**供应商数量少** |
| 9 | **回归与可验证性**：4,111 例测试 + 校准快照回放 | `test/` 621 文件；`src/calibration/replay.js`、`replayDims.js` | 已交付，**结构性优势** |
| 10 | **门户表面**：84 个 HTML 页面（多租户 UI） | `src/web/*.html` | 已交付 |

---

## §3 差异判定（逐维度）

| 维度 | 平台 | Rox | 判定 |
|---|---|---|---|
| **AI 位置** | 关进流程：写前必过决策第 0 闸与双阶段 token | 放出流程：agent 自主发邮件/回复/预约会议 | **轴的两端，非强弱** |
| **治理重心** | **写侧**（谁能写、凭哪条决策写） | **读侧**（谁能看到哪些字段） | 互补；我们的写闸更严 |
| **方法论** | 硬约束（BANT 不满足则阶段门拒；CAS 原子防并发） | 软约定（Skills = 写一次团队照做） | 我们硬、他们灵活 |
| **部署形态** | 多租户 SaaS，一部署服务多租户 | warehouse-native + **in-VPC 单企业深部署** | **架构哲学差异** |
| **数据获取** | 对外获客源 10 个 adapter；**无内部互动捕获** | 邮件/日历/会议转录（Zoom/Gong/Avoma/Attention）/Slack/自研 Mac+iOS 录音 | **Rox 的护城河** |
| **富化供应链** | 5 类公开源，瀑布骨架已有 | 1B+ 联系人、多家供应商、自研 ask-web | Rox 领先，可补齐 |
| **主动触达执行** | **无对外触达通道** | 邮件/LinkedIn/拨号/序列全自动 | Rox 独有 |
| **计价模型** | 席位 + Token + 功能三闸，5 档套餐；metering 计 `llm`/`embedding`/`evaluator` | **Agent Action**（动作计量）+ 自动充值 + 月度上限 + 无限席位 | Rox 更成熟，**可低成本复用** |
| **可验证性** | 4,111 例测试 + 快照回放 + 装配断言 | 自述"**无金标准基准可爬坡**" | **我们结构性领先** |
| **市场与合规** | 中国 B2B 制造/医疗/化工/涂料；多租户 SaaS | 美国 Global 2000 top 15% AE | 不可比 |

---

## §4 我们真正的差异（可防守的三条）

1. **方法论编译成闸门，而非写进文档。** Rox 的 Skills 是"提示词级约定"，我们的 BANT/BANTCC/S0–S8/21 条行为标准是**可校验的流程契约**（阶段门控 + CAS 原子 + 审批流 + 决策锚点）。这一条在**中国 B2B 长周期、多决策人**场景里是刚需，而不是可选功能。
2. **写侧零信任治理。** 任何 AI 写入必须携带决策锚点、走双阶段确认、受 Action Registry 白名单约束、留下可回放溯源链。Rox 治理在读侧，**这条轴它目前是空的**。
3. **多租户 + 配置化。** 一套代码服务多租户，行业差异（阈值/规则/套餐/告警/触发矩阵）100% 走 `config_store`。Rox 的 in-VPC 深部署模式在**中国 SaaS 交付成本结构**下不成立。

**外加一条我们低估自己的**：**可验证性**。有对手方公开声明"没有金标准基准可爬坡"，而我们有 4,111 例测试 + 校准回放 + 装配断言。这在**企业采购的安全审查与审计场景**里是实质优势。

---

## §5 借鉴清单（按 ROI 排序）

### P0 — Agent Action 计价单元（低成本、可立刻做）
Rox 把"效果"落成"**按动作计量**"：每类任务折算 N 个 Agent Action，配自动充值与月度支出上限，Teams 套餐**无限席位、只按动作收**。
我们的现状：`src/billing/metering.js` 已计 `llm`/`embedding`/`evaluator`；`planSchema.js` + `entitlements.js` + `quotaGate.js` 三闸已就位。
**做法**：在 metering 之上加一层"**业务动作计价表**"（如：一次决策建议 / 一次报价生成 / 一次会议简报 = 若干动作），配置化于 `config_store`。**不改动现有三闸结构**，只增加计价维度与额度治理（自动充值 + 月上限）。
**边界**：这是定价模型演进，须先 brainstorming。

### P1 — "为什么"一键产品化（我们底子最厚的一条）
Rox 有 `Show reasoning`、`Validate Insights`、`Research Insights 回溯信号`、`Access Provenance` 四个面向用户的可解释入口。
我们已有 `provenance.js`（358 行）、`decisionTrace.js`、`rootCauseClassifier.js`、`auditability.js`——**底子比它厚，缺的只是前端一键入口**。
**做法**：在 `deal-detail.html` / `account-360.html` 挂"为什么这么判断"面板，直接消费现有 trace/provenance。

### P1 — 反馈采集前端化
Rox 有 👍/👎 insight 反馈、contact dismissal feedback、email quality evals（约 80%）、enrichment 纠错反馈。
我们有 `src/feedback/` 与 `calibration/replay.js`，但缺**前端采集入口**（反馈进不来，回路就断）。
**做法**：决策建议卡 / 洞察卡上加三态反馈（采纳 / 不采纳 + 原因），写回 feedback 表并接入每日复盘（与既有"每日 review 报告"机制对齐）。

### P1 — Skills 自助化的"受控版"
Rox Skills = 客户在 Chat 里描述一次，全团队按此工作。
我们 19 个 `method-*` 是 `src/skills/seed.js` 硬编码，**客户改不了**。
**做法（受控版）**：允许租户提交"行为约定"，但**不直接生效**——走审批流 + `assertAgentAssembly` 校验（组装闭包必须过）后落 `config_store`。这样既获得 Rox 的灵活性，又不破坏写侧零信任。**严禁**做成任意 prompt 注入。

### P2 — 富化供应链补齐
Rox 用多供应商 + 瀑布算法；我们 `src/connectors/discovery/waterfall.js` **骨架已有**，只是 provider 少。
**做法**：接国内供应商（企查查/天眼查/探迹/招标网等），复用现有 `ProviderAdapter` 契约与 `credentialVault`。

### P2 — 事件触发矩阵扩展（承接上轮结论）
由 3 条扩到"商机停滞 N 天 / 关键节点静默 / 决策超期未执行 / 报价待审批超时"，高价值动作走"建议 → HITL 确认"。属 `config_store['agent-event-trigger']` 配置化能力。

---

## §6 明确不学（红线）

1. **全自动对外触达**（自动发邮件/LinkedIn/拨号）：中国合规风险 + 我们无触达通道 + 客户场景（长周期、多决策人）不匹配；
2. **warehouse-native 单租户 in-VPC 深部署**：与多租户 SaaS 战略直接冲突，会摧毁交付成本结构；
3. **用 Tether 类自研协议替代 MCP**：我们已押注开放标准 MCP，且 MCP 是我们的对外连接器战略入口（插件分发包 4 份 byte-equal 同步），不应推翻；
4. **"取消手动录入 / 替代 CRM"**：我们的管理可见性、审计留痕、HITL 是铁律；且 Rox 自己的免责声明也承认需持续人工监督。

---

## §7 对叙事的三条可直接引用结论

1. **"记录系统 → 执行系统"我们已完成**：决策建议 → 审批流 → Action 写库落粒子 → 阶段门控，链路完整；
2. **对手方证词**：Rox 公开承认"**没有金标准基准可爬坡**"，我们以 4,111 例测试 + 快照回放 + 8 断言族装配校验作为可验证性底座——这是**可引用的差异证据**；
3. **同一根轴的两端**：Rox 把 AI 放出流程（raise the ceiling），我们把 AI 关进流程（写侧零信任）。在**中国 B2B 管理场景**，后者不是保守，是前置条件。

---

---

## §8 四大能力逐项对照：拓客 / 记忆矩阵 / 决策脊柱 / KMD 闭环

### 8.0 我方命名体系（单一事实源）

| 代号 | 系统 | 内涵 | 代码锚点 |
|---|---|---|---|
| **K** | 知识/供给系统 | 粒子库 + 事件（原 Universal Context K1–K4） | `src/particles/`、`src/ontology/`、`src/events/` |
| **M** | **记忆矩阵** | **七维度 × 七边**（L1–L7 维度 + E1–E7 边） | `src/sevenDimensions/constants.js:5-13`、`src/decision/edgeDimensionSpec.js:1-3` |
| **J** | **决策脊柱** | J1 上下文图谱 / J2 反馈回路 / J3 校准层 + **J7 决策七轴** | `src/decision/retro.js:69`、`docs/2026-09-01-j7-three-system-consolidation.md` §1 |
| **D** | 决策层 | 9 列（含 `concept_refs`）+ 八要素九尺子 | `src/decision/rubricScorer.js`、`decisionRepo.js` |

依赖链原文：**K（粒子:有什么）→ M（七维分类+七边关系:记得什么/怎么连）→ J（七问决策脊柱:决策时回答什么）**（`docs/2026-09-01-j7-three-system-consolidation.md:26`）。

**KMD 闭环三条腿** = J1 上下文图谱(groundedness) / J2 反馈回路(outcome) / J3 校准层(calibration)。

---

### 8.1 ① 拓客 → Rox **有，且更成熟**

| Rox 对应功能 | 发布时点 | 做了什么 |
|---|---|---|
| **Auto-prospecting** | 2026-09-02 | agent 自建潜客清单、按条件匹配并**打分**；每个候选标记 **Good Fit / Bad Fit 及理由**；good-fit 可直接进 sequence |
| **Outbound Agent 四阶段** | 2026-08-05 | Prospect → Configure → Execute → **Monitor** |
| **Agentic Prospecting** | 2026-05-26 | 同时运行多个 prospecting agent |
| **Intelligent Qualification** | 2026-06-10 | 逐个读 LinkedIn 档案，说明**入选/排除原因** |
| **Native Prospecting + People 页** | 2026-03-31 | 原生拓客与富化；CRM 内 net new / existing / 两者可选 |
| 数据供给 | 2024-09 起 | **1B+ 联系人**、瀑布式富化算法、多供应商（FullEnrich / PredictLeads / CrustData） |

**我方现状**（`docs/2026-09-14-prospecting-module-design.md` §0.1 原文）：
- 4 个 Action：`prospecting-search` / `prospecting-select` / `prospecting-confirm` / `prospecting-lookup`（`src/action/prospectingActions.js`）；
- 5 条线索通路**全是存量数据写入**（手动新建 / agent 发现 / 外部信号 / 标讯 / 回流）；
- **核心差距原文**："缺『主动拓客』——按 ICP/画像/强信号条件批量搜索候选企业 → 销售圈选 → 批量入公海池。现有 qixin/xinbang 适配器只支持**单点 enrich**，无**批量搜索**能力。"
- **我方更严的一点**：`fit_score` **强制服务端计算**（`computeFitScore` + `mergedProspectingRules`），适配器注入的分数被忽略（`prospectingActions.js:5/103-105`）。**Rox 的打分由 agent 生成，理由由 LLM 写；我们的分数不可被数据源伪造。**

**借鉴**：
- **P1 · `fit_reason` 结构化落库**：我们有服务端 `fit_score`，但缺"为什么入选/排除"的结构化字段与展示。Rox 的 Good Fit/Bad Fit + reason 是**可审计的打分**。做法：`prospecting-*` payload 增 `fit_reason`（**不新增粒子类型**）。
- **P1 · 补 Monitor 阶段**：Rox 把拓客做成循环（Monitor），我们做完即止。可复用 `src/connectors/discovery/monitorAccount.js` + 事件触发矩阵扩一条，**不需新建 agent**。
- **P2 · 批量搜索**：设计文档已批准，属实现推进；国内条件检索可用企查查/探迹。

---

### 8.2 ② 记忆矩阵（M） → Rox **有对应物，但形态完全不同**

| Rox 对应功能 | 发布时点 | 性质 |
|---|---|---|
| **Org Memory**（组织级长期记忆） | 2025-05-27 | agent 质量提升；**无公开的供给覆盖率校验** |
| **System of Context** | 架构层 | 统一私有（CRM/support/product usage/email/Slack）+ 公开（news/filings/job postings） |
| **Clever Columns**（可自定义研究列，组织级共享） | 2024-10 起 | 把"研究维度"做成**用户可定义列** |
| **Champion Tracking**（追踪 Champions/关键人角色变动） | 2025-04-15 | **直击我方 M 盲区** |
| **Agentic org charts**（多线程追踪采购委员会） | 2026-04-07 | 采购委员会拓扑 |
| **Role changes insights** | 2024-10-02 | 关键人角色变动监控 |
| **Stage-Aware Opportunity Risks** / **Agentic Deal Risk** | 2025-09-30 / 2025-07-22 | 按阶段识别风险；扫描转录/邮件/笔记生成风险 |

**判定**：

| 维度 | 我方（七维七边记忆矩阵） | Rox（Org Memory + 结构化字段） |
|---|---|---|
| 形态 | **显式分类学**（7 维 × 7 边），可做供给校验 | 扁平组织级记忆 + 可自定义列 |
| 可量化性 | ✅ `supplied_dims` 落 `decision_context_snapshot`（`assembleContextV2.js:201/315`）**"7 维供给了几维"可查** | ❌ 无公开的覆盖率度量 |
| 自动化 | ⚠ 需供给层打通才有内容（**`supplied_dims` 峰值 4/7**，长期缺 3 维） | ✅ agent 自动沉淀 |
| 角色/人事维度 | ⚠ 有 `decisionChainValidator.js` + `involved_entities`，但**无角色变动监控** | ✅ Champion Tracking + Role changes |

**借鉴（我认为这条 ROI 最高）**：
- **P0 · 给 M 补"角色/人变动"信号源**：Rox 的 Champion Tracking 命中的正是我方 `structure`（图谱关系可达）与 `governance`（谁可批/谁负责）这两维——而这两维恰是 `supplied_dims` 长期拿不到料的维度。客户方 champion 离职/调岗 = 商机风险信号。
  做法：事件触发矩阵加一条（`CRM_ACCOUNT` 人事变动 → `method-decision-enrich`，只读安全）；公开源可用企查查高管变更。**不新增粒子类型、不新建 agent、不改 D 层结构。**
- **P1 · `supplied_dims` 覆盖率上墙**：把"7 维供给了几维"做成监控告警（`src/monitor/` 骨架已有）。**这是 Rox 没有的自诊断能力**，属我方差异化。

---

### 8.3 ③ 决策脊柱（J） → Rox **有薄版（读侧溯源 + 产品埋点反馈），我方是厚版**

| 我方 | Rox 对应物 | 判定 |
|---|---|---|
| **J1 上下文图谱（groundedness）** | Show reasoning（2026-01-06，展开看关键信号与思考过程）、Research Insights 回溯信号（2026-02-03）、**Access Provenance**（2026-07-15，溯源访问原因）、Validate Insights（2026-07-15，按需对照底层来源重校验）、Rox verified（2024-08-11）、来源 chips（2026-09-09） | **同构**；但 Rox 是**读侧溯源**（这条信息从哪来），我方是**决策侧溯源**（这个判断凭什么 + 后果是什么）。我方 `provenance.js` 358 行 + `decisionTrace.js` + `rootCauseClassifier.js` |
| **J2 反馈回路（outcome）** | 👍/👎 Insight Feedback（2025-02-11）、Contact dismissal feedback（2025-02-25）、Enrichment 纠错（2025-04-01）、Clever Column 输出反馈（2026-02-10）、**Reply classification**（2026-04-14，自动标记 out-of-office/unsubscribe/interested）、**Email quality evals ~80%**（2025-05-06）、Plays Metrics、Adoption Metrics | 🔴 **Rox 明显更强**。它的反馈是**产品埋点级、每用一次产一条**；我方是 **schema 级齐全但输入为零**——设计文档实测 **`decision.outcome` 0/12，闭环三条腿无输入** |
| **J3 校准层（calibration）** | Clever Columns Model 配置（智能/成本平衡）、Cell level refresh、Agent tuning（序列级 brief）、**Iteration Sandbox**（2026-05-26，上线前对真实人/公司预览调优）、Weekly Refresh 控制、Agent Actions 自动充值 + 月度上限 | 🟡 **取向不同**：Rox 是"面向使用者的人工调参 + 预览安全阀"；我方是"自动校准补丁 `calibration_patch` + 回放 `replay.js`"。**我方更自动，但缺"改配置前预演"这一环** |
| **J7 决策七轴**（WHAT/HOW/WHO/BECAUSE/THEN/WHEN/WHERE） | **无对应物**——全量 Release Notes 未见"决策完整性检查表"概念 | ✅ **我方独有**。Rox 靠 agent 自由推理 + 免责声明要求人工 review 兜底 |

---

### 8.4 ④ KMD 闭环 → Rox 强在 K 与反馈，我方强在 D 与校验

| 层 | 我方 | Rox | 判定 |
|---|---|---|---|
| **K**（供给/知识） | 粒子库 + 写库即构建（条件写入，见 §2 第 7 条） | **System of Context**（warehouse-native，接入 CRM/support/product usage/email/Slack/news/filings/job postings）+ Deep Research + **自研 ask-web 搜索基础设施** + Delta Lake/Snowflake/BigQuery | 🔴 **Rox 数据量级与自动化远超我方**。我方 K 层致命弱点见设计文档 §R4 原文："**无 L0 原料（events 0 行）则假设无可验证对象**……无供给层复通则九尺子 8 项确定性评分**全部恒 0 分**" |
| **M**（记忆矩阵） | 七维 × 七边，可校验 | Org Memory + 结构化字段 + Champion Tracking | 见 §8.2 |
| **D**（决策层） | **9 列 + 八要素九尺子 + 8 项确定性评分（可重跑一致）** | **无显式 D 层**——agent 自主推理 + 人审批（Stage Gating/审批流） | ✅ **我方独有** |
| **闭环三条腿** | J1/J2/J3（**J2 无输入**） | 产品埋点闭环（已闭环到指标） | 🔴 见 §8.3 J2 |

**Rox 在"销售如何做出准确决策"上的答案：让 AI 知道得足够多。**
`System of Context`（6 类私有 + 3 类公开数据统一）→ Agent Swarms 有充分上下文 → 推理自然更准 → 用 4 个可解释入口（Show reasoning / Validate Insights / Research Insights / Access Provenance）让人**事后验证** → 合同条款要求"reviewed by authorized personnel before any action"。

**我方给的答案：让 AI 不能乱来。**
K 供给必须复通，否则九尺子**报缺而非瞎猜**（降级纪律：无证据计 0 不假填充）；M 七维七边做**完整性校验**；J7 七轴做**决策完整性检查**；D 层 9 列固化推理；写侧第 0 闸拦死无锚点决策。

> **一句话差异**：**Rox 的"准确"是概率性的**（上下文更多 → 更可能对）；**我方的"准确"是可验证的**（缺上下文就报缺，不编）。前者靠规模，后者靠纪律。
>
> **对手方证词**：Rox 在 manifesto 中自述"**There is no hill-climbing possible against a golden benchmark**"——即它**无法客观度量"好"**。而我方九尺子 8 项确定性评分（同决策重跑得分一致）+ 4,111 例测试 + `calibration/replay.js`，**恰恰是在解"如何爬坡"这个问题**。

---

### 8.5 §8 借鉴清单（合并去重，按 ROI）

| 优先级 | 事项 | 为什么 ROI 高 | 边界 |
|---|---|---|---|
| **P0** | **打通 J2 反馈回路**：决策建议卡/洞察卡加三态反馈；商机推进至 S7/S8 时**自动回写**上一决策 outcome | 我方 `decision.outcome` 实测 **0/12**，闭环三条腿**无输入**；而 `crm_decision_outcome_write/_set/_query` Action **已存在**（`seed-actions.js:1791/1815/1870`）——是"接电"不是"造轮子" | 不新增粒子类型；写走第 0 闸 |
| **P0** | **给 M 补角色/人变动信号**（对齐 Rox Champion Tracking / Role changes） | 命中 `supplied_dims` 长期缺料的 `structure`/`governance` 两维；**纯配置 + 一条只读触发规则** | 触发矩阵扩条目走 `config_store['agent-event-trigger']`；不新增 agent/SKILL |
| **P1** | **校准预演安全阀**（对齐 Rox Iteration Sandbox） | 我方 `calibration` 是"补丁 + 回放"，**改配置前无预演**；`replay.js` 已有，只缺"补丁生成时自动出对比报告" | 不改 D 层结构 |
| **P1** | **`supplied_dims` 覆盖率上墙** | Rox 无此能力；能把"7 维供给了几维"变成可告警指标，**顺带暴露自身短板** | 用既有 `src/monitor/` |
| **P1** | **`fit_reason` 结构化**（对齐 Good Fit/Bad Fit + reason） | 我方 `fit_score` 已服务端强制计算，缺"为什么" | payload 加字段，不新增粒子类型 |
| **P1** | **Skills 受控自助化**（对齐 Rox Skills 2026-06-17） | 我方 19 个 `method-*` 硬编码于 `src/skills/seed.js`，客户改不了 | 必经审批流 + `assertAgentAssembly` 校验后落 `config_store`；**严禁**做成任意 prompt 注入 |
| **P2** | 拓客 Monitor 阶段、批量搜索、富化供应链补齐 | 设计文档已批准 / 骨架已有 | 见 §5 |

---

### 8.6 新增证据索引（§8）

- 我方命名体系：`src/decision/edgeDimensionSpec.js:1-3`、`docs/2026-08-30-decision-quality-implementation-plan.md:8`、`docs/2026-09-01-j7-three-system-consolidation.md:26/30`
- 记忆矩阵七维：`src/sevenDimensions/constants.js:5-13`（源自 Oleg Shilovitsky 产品情境七维度）
- 决策脊柱 J1/J2/J3：`src/decision/retro.js:69`
- 供给校验与 KMD 诊断：`src/context/assembleContextV2.js:201/315`；`docs/2026-09-02-cognitive-decision-unified-design.md:32/194`（`events` 0 行、`supplied_dims` 峰值 4/7、`decision.outcome` 0/12）
- 拓客：`docs/2026-09-14-prospecting-module-design.md` §0.1/§0.2、`src/action/prospectingActions.js:5/103-105`
- 决策 outcome Action：`src/action/seed-actions.js:1791/1815/1870`
- Rox 功能时间线：`docs.rox.com/development/about-rox/release-notes`（全量）

---

## 附录：证据索引

- Rox 官网首页 / Platform / Pricing / Manifesto：`www.rox.com`
- Rox 架构定义：`docs.rox.com/development/about-rox/readme/revenue-operating-system`
- Rox 全量发布说明：`docs.rox.com/development/about-rox/release-notes`
- Rox 创始说明：`docs.rox.com/development/about-rox/readme/make-the-best-better`
- 平台侧：见 §2 表内 `file:line` 锚点
