# 线索自主发现引擎设计（CRM-ai-native · 平台原生重构版）

> 状态：设计已批准 **v8.1**（v8 + **行业包扩展 handbook 同步 §12**；**自主循环主轴** + **Clay 三项最佳能力吸收 C1/C2/C3**；范式反转 + KMD/智能体证据补强 + 10 大 ai_* 能力系统自检 + 4 个 P0 已补入主文档 §5/§9；D1/D2 已拍板、D3/D4 沿用；配套 `docs/2026-09-10-lead-discovery-capability-audit.md`；**✅ 达「可进 writing-plans」门槛**）
> 日期：2026-09-10
> 目标：在**不新增粒子类型、不改业务域模型**前提下，把 Clay 真正稀缺的能力嫁接到本平台的 KMD/本体/记忆织物上。基于「Clay 核心竞争力排序」研判，Clay 最该吸收的**不是 150 家数据源（最弱护城河、已商品化）**，而是：**① 可组合 GTM 编排层（最深护城河）、② Claygent 智能体研究 + glass-box 可解释、③ 持续账户监控 / 账户记忆**。本设计以「自主发现智能体循环」为主轴，将 C1/C2/C3 吸收为循环内的一等能力；Clay 的表格/供应商/评分列由平台认知原语**天然覆盖**，不再逐项抄写。

---

## 0. 设计范式反转（先讲清楚：为什么不是照抄 Clay）

### 0.0 核心论点
Clay 的本质是「**会调供应商的智能表格**」——用 150 家付费供应商补全单元格，用规则列做评分，加一个 review 页做人工复核。其 2026 定位已升级为「GTM Infrastructure + Agentic 平台」，但**核心护城河排序**已明确：最该敬畏的是「可组合 GTM 编排层」（客户在 Clay 上把"数据→条件→AI→动作"编排成定制获客机器后迁移成本极高），最该翻篇的是「200+ 数据源」（数据源高度重叠、正被商品化，且我们"本体优先"反而更省）。

本平台的本质不同：它是一个 **认知智能体平台（native-CRM）**——KMD 三层认知决策（LIGHT）、本体/向量写时自动构建、记忆生命周期（双轨+事件驱动）、多智能体编排、事件驱动进化、零信任写第 0 闸。我们是 CRM **本身**，发现→评分→外联→回复闭环**无跨系统同步税**（Clay 作为 sidecar 必须为双向同步 SF/HubSpot 付费）。

因此本设计**拒绝逐项移植 Clay 五大功能**，而是先问一个相反的问题：

> **「若把线索发现建在本平台的认知架构之上，它应该长什么样？」**

答案使三项 Clay 功能在本平台变成「免费/自动/更强」，只剩**三项真正值得借鉴（C1/C2/C3）**：

| Clay 功能 | 在本平台的真实形态 | 是否照抄 |
|---|---|---|
| F2 瀑布富集 | `ontologySync` 写时自动入图+向量，**内部本体完成 80% 富集**，外部适配器只补「智能体推断不出」的字段 | ❌ 不抄，反转为「本体优先」 |
| F4 双维评分 | 复用**同一套九标尺 + concept_refs 认知决策引擎**输出评分（每个决策都走它） | ❌ 不抄，复用原生评分 |
| F5 人工复核 | 即平台**零信任写第 0 闸**，每个写都过，无需另造 review tab | ❌ 不抄，复用原生闸 |
| F1 多源聚合 | 仅作为「本体补缺口」的适配层存在，不追求 150 家规模 | ⚠️ 减配，不做核心 |
| F3 AI 研究 | **借鉴内核**（C2：Claygent + glass-box 可解释） | ✅ 借鉴内核 |
| —— 编排层 | **借鉴护城河**（C1：可组合 GTM 编排层，按租户自由编排无固定流程） | ✅ 借鉴护城河 |
| —— 持续监控 | **借鉴一等能力**（C3：持续账户监控 + 账户持久记忆，升 P0） | ✅ 借鉴一等能力 |

**结论**：本引擎 ≠ Clay 精简版。它是「**生长在 KMD/本体/记忆织物里的自主发现智能体循环**」，Clay 的表格/供应商/评分列在这里被平台的认知原语天然覆盖；Clay 最深的护城河（可组合编排层 C1）与最该借的智能体能力（C2/C3）被吸收为循环一等公民。

### 0.1 平台原生定义 · 线索自主发现循环（Discovery Agent Loop）
不叫「智能销售表」，叫「**发现智能体循环**」。它不是一个表格工具，而是一个会自己决定「去哪发现、研究什么、何时触达、持续监控什么」的智能体，借本平台四大原生能力 + 吸收的三项 Clay 能力运转：

1. **谁值得发现 = 一个 KMD 决策，不是一次过滤**
   ICP 不是一个静态列表，而是一个 `decision_scenario`：用九标尺 + `concept_refs` 推理「这家公司是不是目标客户」。发现源本身由该决策驱动（而非 SQL 筛选表格）。
2. **发现源 = 内部信号 + 外部补缺口**
   内部：标讯匹配、记忆中的客户图谱邻近、已有 `CRM_KNOWLEDGE` 关联；外部：仅当本体推断不出时才调 provider（已验证邮箱、DUNS、工商）。
3. **富集 = 本体优先（写入即富集）**
   写粒子 → `ontologySync` 自动生成知识边 + 向量 → 80% 字段免费补全；外部 adapter 只填 `payload.enrichment` 的缺口。
4. **研究 = 既有 Agent 调用的 SKILL + Action（C2：Claygent + glass-box）**
   Claygent 不是独立爬虫、也**不是运行时子 Agent**（平台无子 Agent 派发机制——仅 6 个注册顶级 Agent 经 kanban 调度路由，详见 §9.10）。它以 `lead-discovery` SKILL + `discovery-research` Action 形式，由既有 Agent（如 `decision-agent` / `intake-router`）经事件矩阵或 intake 路由调用，复用 `runWithSkill` 单身份单 SKILL 执行模型，用 LIGHT 认知决策规划「先判信息所在区块 → 二分收敛定向抓取」。研究输出 `why_narrative` 即 **glass-box 推理链**（每步带 `rule_ref` + `j_score`，见 P0#1），销售可见"为何此刻判定为目标客户"。
5. **评分 = 原生认知决策**
   `icp_fit_score` / `intent_score` 是 discovery `decision_scenario` 的输出，复用九标尺，写入 `CRM_ACCOUNT.payload.discovery`。
6. **ICP 自进化 = 反馈回路（本平台独有，Clay 无）**
   closed-won / closed-lost → 业务结果回路 → **草稿**重校准 discovery `decision_scenario`（事件驱动进化 / self-evolution SKILL）。越用越准。
   > ⚠️ **P0 #3（ICP 自进化绝不自动生效）**：重校准先落**草稿** → **回测**（threshold/count/noop 三形态，对照历史 closed-won/lost）→ **HITL 审批** → 才 `validated` 生效。任何自动重写 scenario 权重/规则的行为均违反此闸；不可逆的规则变更须人确认。
7. **信号触发智能体循环**
   融资/招聘/技术变更 → 事件总线 → `decision-enrich` + 记忆沉淀 + 触达建议，形成「信号→研究→评分→触达」闭环。
8. **写出 = 零信任写第 0 闸**
   所有落库过 HITL review，是平台原生而非附加组件。
9. **【C3 升 P0】持续监控闭环常驻（吸收 Clay #3 Account Agent）**
   循环不是跑一次就结束，而是**常驻监控**：信号到达（funding_round / tech_adopt / leadership_change 命中）或定时增量刷新 → 对既有 `CRM_ACCOUNT` 重新 `lead-fit` 评分 → 增量结论 **append 到账户 append-only 持久记忆**（非覆盖）→ 30 天蒸馏出 curated note。每次重评分带 glass-box（`why_narrative` + `rule_ref`），销售可见"为何此刻优先级变了"。跨到外联/方案 → 走 **HITL + 零信任写闸**，绝不自动发信。账户持久记忆吸收 Clay Account Agent 的"持久记忆 + 人工批准写"范式，但**不删不改既有记录**（守「禁 DELETE」铁律）。

> **【C1 设计原则 · 贯穿全程】可组合 GTM 编排层（吸收 Clay #1）**：上述 1–9 不是刚性管线，而是**可组合原语集**——`数据适配器（Provider Adapter）→ 判定条件（discovery-rules / rulers）→ AI 研究（Claygent / getLlmJson）→ 触达动作（method-* SKILL）`。熟练租户按 `discovery-rules` 配置**自由编排**这四段、为不同客群设计不同获客法（如"融资+招聘销售岗"高优先级客群走高德+标讯+Claygent 重研究；"官网改版"客群走 web-research+轻评分），**无固定流程、零核心代码改动**。这是 Clay 最深护城河，我们以"配置驱动差异化"铁律对齐。

### 0.2 与 Clay 逐项对照（看清「借鉴什么、不抄什么」）

| 维度 | Clay 做法 | 本平台原生做法 | 决策 |
|---|---|---|---|
| 数据补全 | 150 家供应商付费瀑布 | 本体写时自动补全 + 仅缺口调 adapter | **反转为本体优先** |
| 评分 | fit/intent 两列规则 | 九标尺认知决策（每决策同引擎） | **复用原生** |
| 人工复核 | 独立 review 页 | 零信任写第 0 闸（全局） | **复用原生** |
| 研究 | Claygent 独立代理 | 编排派发的 SKILL+Action + glass-box（C2） | **借鉴内核** |
| ICP | 静态列表/受众 | decision_scenario + 反馈自进化 | **升维** |
| 编排层 | 可组合 GTM 控制平面 | 可组合原语集（C1，配置驱动差异化） | **借鉴护城河** |
| 持续监控 | Account Agent 持久记忆 | monitorAccount 常驻闭环（C3，append-only 记忆） | **借鉴一等能力** |
| 同步 | upsert 回 CRM（sidecar 税） | 复用 `data-*` MCP + 去重 upsert（native 零税） | 复用原生 |

### 0.3 五大核心功能 → 重写为「平台原生表达」
> 下面的 F1–F5 不再照搬 Clay，而是**本平台如何用既有原语表达同等的用户价值**，并将 C1/C2/C3 织入。

- **F1 本体优先的富集（替代 Clay 多源聚合+瀑布）**：用户价值=「公司/联系人信息自动补全」。本平台用 `ontologySync` 写时自动补全 + provider adapter 仅补缺口。不追求 150 家规模，追求「内部本体覆盖 + 缺口外部补」。**可组合编排（C1）**使"哪些缺口调哪个 adapter、按什么顺序"完全按租户配置，无固定流程。
- **F2 AI 研究子智能体（=Claygent 内核，C2）**：用户价值=「让 AI 销售代表全网自主研究竞品/信号」。本平台用编排派发 + `getLlmJson` + 区块级二分抓取，产出 `why_narrative`（glass-box 推理链，每步 `rule_ref`+`j_score`）落 `payload.research` + `CRM_KNOWLEDGE`。可解释性是**一等公民**（非点缀），直接对齐 Clay 的 glass-box 卖点。
- **F3 认知评分与实时信号 + 持续监控（复用九标尺，C3 升 P0）**：用户价值=「按潜力/信号排优先级 + 数据不陈旧」。本平台用 discovery `decision_scenario` + 九标尺输出评分；信号经事件总线触发刷新；**C3 把"持续监控账户 + 账户持久记忆"升为闭环一等能力**，直击 CRM 数据陈旧的头号痛点。
- **F4 ICP 自进化（本平台独有，Clay 无）**：用户价值=「越用越准」。closed-won/lost 经反馈回路重校准发现决策，事件驱动进化，**绝不自动生效（P0#3）**。
- **F5 闭环触达与同步（复用零信任闸+MCP，C1 编排末端动作）**：用户价值=「发现→外联→回写一气呵成」。信号→研究→评分→HITL 闸→`data-*` upsert 回 CRM→MCP 暴露；**外联/方案由 method-followup-engine / method-quote-engine 经 C1 编排消费 discovery payload**（见 §8 契约 + 配套 competitive-analysis §G5/G6）。

### 0.4 产品原则（保留 Clay 复盘，加本平台红线）
1. 服务更懂技术的商业用户（乐高式灵活）—— 即 **C1 可组合编排原则**。
2. 不垄断数据，连接供应商（adapter 框架）。
3. 采用率优先：嵌入现有 CRM UI，降低切换成本（native-CRM 零同步税的结构性优势）。
4. **【本平台红线】不新增粒子类型、不改业务域模型、写操作必经第 0 闸**（§10 硬约束）。

### 0.5 阶段顺序（围绕「原生能力 + C 吸收」而非「Clay 演进」）
- **P1 本体优先富集 + 认知评分 + 可组合编排骨架（C1）**：写时自动补全 + 缺口 adapter + discovery `decision_scenario` 评分（复用九标尺）+ **discovery-rules 可编排四段原语（data→condition→AI→action）按租户隔离**。跑通「发现→评分→HITL→落库」。
- **P2 研究子智能体 + 信号闭环 + glass-box（C2）**：编排派发 Claygent + 事件总线信号触发 + 记忆沉淀 + **why_narrative glass-box 推理链输出**。
- **P3 持续监控闭环（C3，P0 级）+ ICP 自进化 + 双向同步规模化**：`monitorAccount` 常驻重评分 + 账户 append-only 持久记忆 + 30 天蒸馏 + 反馈回路重校准 + `data-*` MCP 暴露 + 去重 upsert（`duplicateCriteria` 配置驱动）。

---

## 1. 平台原生能力 → 线索发现映射（反转方向）

> 下表从「本平台原生能力」出发，看线索发现如何成为其表达（与 §0 范式一致，不再以 Clay 功能为起点）。

| 平台原生能力 | 线索发现中的角色 | 复用/新增 |
|---|---|---|
| KMD 认知决策（九标尺+concept_refs） | 谁值得发现 + 评分 = discovery decision_scenario | 复用引擎 + 新 scenario 行 |
| 本体/向量写时构建（ontologySync） | 写入即富集，自动补全 80% 字段 | 复用，零新增 |
| 记忆生命周期（双轨+事件沉淀） | 研究笔记/信号入记忆；**C3 账户持久记忆（append-only + 30 天蒸馏）** | 复用 + 加 discovery 捕获域 + 账户记忆流 |
| 多智能体调度（6 顶级 Agent + kanban） | Claygent = 既有 Agent 调用的 SKILL+Action（无子 Agent 机制） | 复用 scheduler routeThroughIntake |
| 事件驱动进化（self-evolution） | ICP/provider 权重随结果重校准；**C3 monitorAccount 事件触发重评分** | 复用 SKILL |
| 零信任写第 0 闸 | 所有落库 HITL 复核；**C3 跨外联绝不自动发信** | 复用，零新增 |
| Provider Adapter（缺口补） | 仅补本体推断不出的字段；**C1 作为可组合原语之一** | 新增 framework + 起步 adapter |
| `data-*` MCP + 去重 upsert | 回写 CRM / 外部可读 | 复用（`duplicateCriteria` 配置驱动去重） |

## 1b. 与 Clay 文章 / 官网的关系（定位说明）
两篇 Clay 拆解（Saasverse D 轮报道、张艾拉创业复盘）+ 官网（/、/demo、/claygent、/integrations）用于**提取「可编排自主发现循环 + 信号→触达闭环 + 持续账户监控」这一内核**，以及 Claygent「先判区块再二分」的技术细节、Glass-box 可解释范式、Account Agent 持久记忆范式。它们**不是功能清单蓝本**——本设计已将其反转到本平台认知架构之上，并据「Clay 核心竞争力排序」明确**该借什么（C1/C2/C3）、该翻篇什么（200+ 数据源）**。FETE 框架（Finding→Enriching→Transforming→Exporting）仍可用作对外话术，但其每一步在本平台都有原生实现（Finding=KMD 决策驱动，Enriching=本体写时构建，Transforming=九标尺评分，Exporting=第0闸+upsert）。

---

## 2. 架构（原生认知循环 · 5 环节 · 含 C3 常驻）

```
配置层 config_store['discovery-rules']   ← ICP / provider 顺序 / 阈值 / 信号定义 / 编排编排（按租户隔离）
        ↓
① 决策驱动的发现源（KMD · 不是过滤）
   discovery decision_scenario（九标尺+concept_refs）推理「谁值得发现」
   ├─ 内部信号：tenderConnector 标讯 / 记忆图谱邻近 / CRM_KNOWLEDGE 关联
   └─ 外部补缺口：仅当本体推断不出时调 provider（已验证邮箱/DUNS/工商）
        ↓
② 本体优先富集（写入即富集 · 不是瀑布）
   写粒子 → ontologySync 自动入图+向量（80% 字段免费补全）
   └─ Provider Adapter 仅填 payload.enrichment 缺口（cheapest-first 回退，首命中即停）
        ↓
③ 研究 + 评分（原生认知 + C2 glass-box）
   Claygent 子智能体（编排派发 + LIGHT 决策 + 区块二分抓取）→ payload.research + why_narrative(glass-box: rule_ref+j_score)
   discovery decision_scenario 输出 icp_fit_score / intent_score（复用九标尺）
        ↓
④ 闭环落库（零信任 · 不是 review tab）
   信号→decision-enrich 事件链 + 记忆沉淀 → 零信任写第0闸 HITL →
   CRM_ACCOUNT(potential)+CRM_CONTACT+CRM_DEAL(lead) + sourcedFrom 溯源 →
   data-* MCP upsert 回 CRM（duplicateCriteria 配置驱动去重）→ 反馈回路重校准 discovery scenario（ICP 自进化）
        ↓
⑤ 【C3 常驻】持续监控闭环（monitorAccount）
   信号到达(funding_round/tech_adopt/leadership_change) 或 定时增量刷新 →
   对既有 CRM_ACCOUNT 重跑 lead-fit 评分（复用九标尺+2D judge）→
   增量结论 append 到账户 append-only 持久记忆（memory_log）→ 30 天蒸馏出 curated note →
   glass-box 输出（why_narrative + rule_ref）可见优先级变化 → 跨外联走 HITL（绝不自动发信）
   ↺ ⑤ 常驻循环，与 ①–④ 共享同一 KMD/本体/记忆织物
```

> **C1 贯穿**：①–⑤ 中每一环都是「数据适配器 / 判定条件 / AI 研究 / 触达动作」四段原语的组合，由 `discovery-rules` 按租户配置驱动；不同客群可编排不同组合，无固定流程。

---

## 3. Provider Adapter Framework + 可组合编排原则（能力①核心 + C1）

**统一接口**（所有适配器实现同一契约，不动域模型）：
```js
enrich(entity, fields, ctx) ->
  { [field]: { value, confidence, cost, provider, ts } }
```

**注册表条目**（`config_store['discovery-rules'].providers`，按租户播种；系统级从 `system` 模板懒克隆到各租户，遵循 §9.7 隔离范式）：
```json
{
  "id": "gaode",
  "name": "高德地理/工商定位",
  "kind": "geo_firmographics",
  "scope": "system",
  "costTier": 1,
  "coverageFields": ["registered_address","geo_coord","industry_zone"],
  "enabled": true,
  "credentialsRef": "env:GAODE_KEY",
  "endpoint": "https://restapi.amap.com/v3"
}
```
> 注：`enabled` 反映**该租户**当前状态；付费源出厂 `false`，须管理员在目标租户显式置 `true` 并填 `credentialsRef`（见 D1）。

### 3.1 数据源架构（分级 + 按租户，对应 D1）
- **系统级默认数据源（出厂启用，按租户懒克隆）**：`email-verify` / `web-research` / `标讯(tenderConnector)` / `高德(Gaode)` —— **P1 实现真实 fetch（对应 D2 起步适配器集）**。
- **系统默认候选适配器**：`attio` / `zhizao` —— 现有骨架，注册进 Provider Registry 但真实 fetch 可后置；经「行业 handbook 配置」按租户启用（D1 多租户数据源架构）。
- **付费源（Clearbit / LinkedIn 等）**：出厂 `enabled:false`；管理员**显式授权 + 填 key** 后在**指定租户**独立启用（绝不系统全局默认开启）。

| 适配器 | kind | 分级 | P1 状态 |
|---|---|---|---|
| email-verify | email/phone | 系统默认 | ✅ 实现真实 fetch |
| web-research | web/serp | 系统默认 | ✅ Claygent 驱动（免费） |
| 标讯 tenderConnector | 内部信号 | 系统默认 | ✅ 复用既有管道 |
| 高德 Gaode | 地理/工商定位 | 系统默认 | ✅ 实现真实 fetch |
| attio | firmographics | 系统候选 | 骨架登记，按租户启用 |
| zhizao | 工商校验 | 系统候选 | 骨架登记，按租户启用 |
| Clearbit / LinkedIn* | firmographics/social | 付费 | **默认 disabled，需授权+key** |

**扩至 150+ 的路径**：接口稳定后，新增源 = 落一个 adapter 模块 + 注册表加一行；支持插件式社区适配器，无需改内核。

### 3.2 【C1】可组合编排原则（吸收 Clay #1 护城河）
发现引擎 = **可组合原语集**，而非刚性管线。四段原语：
1. **数据适配器**（Provider Adapter，见 §3）：`email-verify` / `web-research` / `标讯` / `高德` / attio / zhizao / 付费源。
2. **判定条件**（`discovery-rules` / `lead-fit` 的 `focus_rulers`/`enabled_rulers`）：行业/规模/地域/技术栈匹配 + 信号阈值。
3. **AI 研究**（`discovery-research` / `claygentResearch`，Task 8）：`getLlmJson` 产出研究报告 + `why_narrative`。
4. **触达动作**（method-* SKILL）：`method-followup-engine`（外联）/ `method-quote-engine`（方案）/ `method-stage-progression`（推进）。

**编排契约**：`discovery-rules` 以配置声明「客群 → 四段组合」，例如：
```json
{
  "playbooks": [
    { "name":"高优先级-融资扩张", "match":"funding_round && hiring_icp_role",
      "data":["tenderConnector","gaode"], "ai":["claygentResearch(deep)"],
      "action":["method-followup-engine"] },
    { "name":"轻量-官网改版", "match":"website_redesign",
      "data":["web-research"], "ai":["claygentResearch(lite)"],
      "action":["method-followup-engine"] }
  ]
}
```
**铁律对齐**：编排是**配置驱动差异化**（按租户隔离），**零核心代码改动**；熟练租户自由组合四段，为不同客群设计不同获客法（无固定流程）。这是 Clay 最深护城河「控制平面」的等价物，我们以其原生「配置驱动」铁律实现。

**成本/合规护栏**：每 provider 日调用成本上限；凭据加密存储（env/`config_store` 加密列）；DNC/opt-out 尊重；所有外部调用经 `sourcedFrom` 边留痕（天然审计）。

**去重（duplicateCriteria 配置驱动，吸收 Twenty 核心层范式）**：落库前查重不硬编码匹配键，而由 `discovery-rules.duplicate_criteria`（按对象类型定义查重列组，如 Company `[['domain'],['linkedInUrl'],['name']]`，minLength=2 短串防误判）驱动 `resolveExistingOrCreate`；先查后建、外部 id 确定性 upsert、唯一约束冲突 catch 后重查赢家转 update（并发兜底）。**全程零 DELETE，预防式去重**（守「禁 DELETE」铁律），契合 Twenty `build-duplicate-conditions` 元数据驱动范式但规避其删除式合并。

---

## 4. Claygent 研究代理（能力② + C2 glass-box）

参考 Clay 实现（GPT-4 + 二分搜索法）：不直接抓取整站，而是**先让模型判定目标信息最可能所在的页面区块**（如 SOC-2 常在页脚），再针对性抓取该区块；未命中则二分切分、逐步缩小范围精准定位。多模型可选：Neon 类擅长格式化抽取，GPT-4/Claude 类擅长复杂推理。

- **输入**：`CRM_ACCOUNT`（名称/域名）+ 研究简报（来自配置或用户）。
- **自主循环**：将简报拆为子问题 → 每个子问题：web 搜索 + **模型引导的区块级定向抓取（二分收敛）** + `getLlmJson` 抽取 → 结构化笔记；设最大迭代护栏与置信度阈值。
- **输出**：`{ summary, signals:[...], competitors:[...], risks:[...] }` 写入 `payload.research` + `sourcedFrom:claygent` 边。
- **【C2】glass-box 推理链**：研究产出 `why_narrative` 须带可解释推理链——每一条判定附 `rule_ref`（引用哪条 ruler/信号）与 `j_score`（能力轴置信），与 P0#1 的 2D judge 同源。销售/运营可见"AI 为何判定这家值得此刻触达"，而非黑箱打分。这是 Clay 的 glass-box 卖点，**我们将其升为一等公民**（非点缀）。
- **角色**：类「AI 销售代表」，聚焦竞品情报、业务信号（融资/招聘/技术采纳）、决策链线索；其 `why_narrative` 即下游 `method-followup-engine` 的"差异化联系理由"钩子（见 §8 契约 + 配套 competitive-analysis §G5）。

---

## 5. 数据模型（不新增粒子 + P0#1 2D）

- **载体**：`CRM_ACCOUNT(state='potential')` + `CRM_CONTACT` + `CRM_DEAL(stage='lead')`。
- **富集字段 + 溯源 + AI 属性 2D**（写入 `CRM_ACCOUNT.payload`；⚠️ P0 #1 已补：评分/富集字段须含「能力轴 judge」而非仅「来源轴」）：
```json
{
  "discovery": {
    "icp_fit_score": { "value":0.82, "judge":{ "axis":"capability", "rule_ref":"scenario:lead-fit#ruler:industry", "j_score":0.9 } },
    "intent_score":  { "value":0.64, "judge":{ "axis":"capability", "rule_ref":"scenario:lead-fit#ruler:hiring", "j_score":0.85 } },
    "signals": [{ "type":"funding_round", "ts":"...", "provider":"web-research" }],
    "why_narrative": "因 funding_round 信号 + 行业匹配(industrial_coatings)被 discovery scenario 判定为目标客户；decision_id=dec_xxx"
  },
  "enrichment": {
    "industry": { "value":"Industrial Coatings", "provider":"attio", "confidence":0.9, "ts":"...", "layer":"L2", "source":"ontologySync" },
    "email":    { "value":"...", "provider":"email-verify", "confidence":0.95, "ts":"...", "layer":"L2", "source":"provider_adapter" }
  },
  "research": { "summary":"...", "competitors":[...], "layer":"L3", "source":"claygent" }
}
```
> **P0 #1（AI 属性 2D + J_Judge）**：`icp_fit_score`/`intent_score` 及 `enrichment.*` 原仅含「来源轴」（provider/confidence），现补「能力轴 judge」（`axis`/`rule_ref`/`j_score`）与 `why_narrative`（记忆系统可答 Why），知识资产标 `layer`(L1–L4)+`source`。**C2 glass-box 复用同一 judge 结构输出 why_narrative。**
- **溯源边**：`edges(kind='sourcedFrom', from=account, payload={provider,confidence,ts,raw})` 供图谱遍历与审计。C3 监控闭环的增量结论写入账户 **append-only 记忆**（`memory_log`），不覆盖上述 payload 历史。

---

## 6. 实时信号 + 持续监控闭环（能力③ + C3 升 P0）

### 6.1 实时信号与评分
`discovery-rules.signals` 配置每种信号权重 → `intent_score`：
| 信号 | 触发 |
|---|---|
| funding_round | 融资事件 |
| hiring_icp_role | 招聘匹配 ICP 的岗位 |
| tender_match | 命中标讯（tenderConnector） |
| leadership_change | 高管变动 |
| tech_adopt | 技术栈变更 |
| website_redesign | 官网改版 |

`icp_fit_score` 由 `discovery-rules.icp`（行业/规模/地域/技术栈）匹配得出。两者加权 → 线索优先级。

### 6.2 【C3 升 P0】持续监控闭环（monitorAccount · 吸收 Clay #3 Account Agent）
发现不是一次性动作，而是**常驻监控循环**。这是 Clay 当前主推的"持续监控账户 + 数据实时刷新"能力，直击 CRM 数据陈旧的头号痛点，且本平台 native-CRM 写库**零 sidecar 同步税**，在此维度优于 Clay。

**触发**：
- 事件触发：funding_round / tech_adopt / leadership_change / tender_match 命中 → 事件总线 → 对既有 `CRM_ACCOUNT` 触发重评分。
- 可选定时：增量刷新（按 `discovery-rules.refresh` 租户级频率配置）。

**循环步骤（复用既有原语，不新增 agent / 粒子）**：
1. `claygentResearch` 重抓 web 自定义点 → 更新 `enrichment.signals` + 新 `why_narrative`（即"模仿顶级销售挖的点"）。
2. `lead-fit` `decision_scenario` **重评分**（异步，复用九标尺 + 2D judge）。
3. 增量结论 **append 到账户 append-only 持久记忆**（`memory_log`）→ 30 天蒸馏进 curated note（`memory_note`）= Account Agent 的"持久记忆"。
4. **Glass-box**：每次重评分带 `rule_ref` + `why_narrative`，销售可见"为何此刻优先级变了"（与 C2 同源）。
5. 任何跨到外联/方案 → 走 **HITL + 零信任写闸**，绝不自动发信（与 §0.1 step8/9 一致）。

**铁律对齐**：
- **禁 DELETE**：只 append 记忆、只更新 payload，绝不删改既有记录（规避 Twenty `mergeMany` 的删除式合并）。
- **配置驱动差异化**：监控信号/频率/阈值全在 `discovery-rules` 按租户配。
- **HARD-GATE**：复用 `decision-agent` via 事件矩阵（不新增 agent）；落既有 `CRM_ACCOUNT` payload + `KNOWLEDGE` 记忆（不新增粒子）。
- **可解释**：每次刷新输出 glass-box，非黑箱。

**与反馈闭环（P0#4）衔接**：monitorAccount 的重评分结果本身就是 feedback-loop 的实时数据流，喂给 §9.11 的指标模板（如 `discovered_to_won_rate` 随监控刷新持续更新）。

---

## 7. 分阶段交付

| 阶段 | 范围 | 退出标准 |
|---|---|---|
| **P1 数据丰富与清洗 + 可组合编排骨架（C1）** | Provider Framework + 4 起步适配器(email-verify/web-research/标讯/高德) + 本体优先富集 + 信号评分 + 溯源(2D) + **discovery-rules 可编排四段原语** + 上下文红线 | 富集覆盖率≥80% 可观测；编排按租户隔离可配；产出 `pending_review` 线索；付费源保持 disabled |
| **P2 AI 研究代理 Claygent + glass-box（C2）** | 自主全网研究（竞品/信号），结构化笔记 + **why_narrative glass-box 推理链**落库 | 给定公司产出研究报告 + 信号标签 + 可解释 why_narrative |
| **P3 持续监控闭环（C3）+ 规模化 + 双向同步** | Registry 扩至 150+ 适配器、monitorAccount 常驻重评分 + 账户持久记忆、实时信号触发、CRM upsert（duplicateCriteria 配置驱动去重）+ MCP 暴露 | 外部系统可读 enriched 线索；信号→自动富集/重评闭环；监控刷新可见优先级变化 |

---

## 8. 生命力契约（§A · 含 C1/C2/C3）

```contract-yaml
# 注：按 §9.10，发现引擎不新增顶级 Agent（lead-miner 已并入本体）。
# discovery-* 由既有 Agent（intake-router / decision-agent）经事件矩阵 / intake 路由调用；
# 本契约以 decision-agent 为承载身份代表，实际派发由 scheduler.routeThroughIntake 决定。
- task: "Provider Adapter Framework + 可组合编排原语（C1）"
  agent: decision-agent
  skills: [lead-discovery]
  memory: [crm-native]
  success: "给定 account，waterfall 按 costTier 首命中即停；discovery-rules 可编排 data→condition→AI→action 四段且按租户隔离"
- task: "Claygent 研究 + glass-box 输出（C2）"
  agent: decision-agent
  skills: [lead-discovery]
  memory: [crm-native]
  success: "给定 URL，getLlmJson 产出研究报告 + why_narrative（含 rule_ref/j_score）落 payload.research"
- task: "monitorAccount 持续监控闭环（C3，P0）"
  agent: decision-agent
  skills: [lead-discovery, ai-memory-lifecycle]
  memory: [crm-native]
  success: "信号/定时触发 lead-fit 重评分；账户 append-only 记忆更新且 30 天蒸馏出 curated note；无 DELETE"
- task: "discovery-rules 配置键 + 按租户播种 + 隔离校验"
  agent: decision-agent
  skills: [lead-discovery]
  memory: [crm-native]
  success: "config_store 读取 discovery-rules 含 ICP/provider 顺序/阈值/编排；多租户各自独立"
- task: "实现 discovery-* 动作（三处硬闭包注册）"
  agent: decision-agent
  skills: [lead-discovery]
  memory: [crm-native]
  success: "assertAgentAssembly().ok 通过且 discovery-run 动作可被 MCP/事件触发"
```

---

## 9. 平台衔接架构（数据 / 知识 / 记忆 / 决策 / MCP / 界面 / ACTION / S1）

> 本节把发现引擎落进平台真实架构，所有结论带 file:line 锚点（基于 2026-09-10 代码探查）。
> **衔接的底层逻辑（回应「照抄」批判）**：发现引擎不是「在平台外另造一套 Clay 表格」，而是把本平台的认知原语**当作自身器官**——KMD 决策即它的「判断力」、ontologySync 即它的「记忆力」、记忆层即它的「经验库」、编排即它的「手脚」、第 0 闸即它的「conscience」。因此 §9.1–§9.8 每一条都是「复用平台既有机制」，而非「新增平行系统」。

### 9.1 数据层衔接
- **载体即现表**：`CRM_ACCOUNT` / `CRM_CONTACT` / `CRM_DEAL` 不是独立表，而是 `crm.particles` 的 `type` 取值（`db/schema.sql:11-30`）。账户 `state='potential'`、商机 `stage='lead'` 均在 `payload` JSONB（`:18`；`tenderConnector.js:54` 实证 `createParticle('CRM_DEAL',{stage:'lead'})`）。
- **溯源边现成**：`crm.edges`（`schema.sql:38-55`）含 `edge_type` 受控谓词 + `meta JSONB`；`sourcedFrom` 已是受控谓词（`connectorActions.js:41`），用于记录 provider/置信度/时间。
- **多租户隔离 = 透传 tenantId**：三载体本就带 `tenant_id`（默认 `system`）；写助手 `createParticle/createEdge` 收 `ctx.tenantId`（`connectorActions.js:45`、`tenderConnector.js:57,121`）。发现数据**无需新粒子**，只需每次写时透传 `ctx.tenantId`（复用 `conn-tender-push` 模式即正确隔离；对照 id18/17/21/15 四类伪隔离坑的复合 PK/懒克隆修法，发现数据走"载体自带 tenant_id + 透传"，不触发该坑）。
- **去重（duplicateCriteria 配置驱动）**：落库前 `resolveExistingOrCreate` 按 `discovery-rules.duplicate_criteria` 先查后建（见 §3.2）；外部 id 当记录 id 走确定性 upsert，唯一约束冲突 catch 后重查赢家转 update。**零 DELETE，预防式去重**。

### 9.2 知识层衔接
- **富集结果 → 知识粒子**：`CRM_KNOWLEDGE` 是既有粒子类型（`schema.sql:14`）。富集出的 firmographics/业务信号经 `src/ontology/hooks.js` `ontologySync`（`:48-113`）自动生成受控边（`auto_weak`/`relationship_strength`）并登记词表 → `CRM_KNOWLEDGE`。发现引擎只需把富集字段写入 `CRM_ACCOUNT.payload.enrichment`，`ontologySync` 会把概念级知识自动入图。
- **溯源落边**：provenance 由 `meta.edge_source` 承载（`hooks.js:61,88,101`），发现引擎沿用 `sourcedFrom` 边即可。
- **Claygent 笔记 → 知识**：研究报告（竞品/信号）可写成 `CRM_KNOWLEDGE` 粒子 + `concept_refs`，供下游决策层消费（`methodologyInjection.js` `enrichConceptRefs` 绑定权重）。

### 9.3 记忆层衔接
- **双轨记忆现成**：`crm.memory_log`（append-only）+ `crm.memory_note`（curated）；`crm-memory-upsert`（`seed-actions.js:181`）、`crm-memory-read`（`:1934`），均需 `requiresEntitlement:['memory']`。
- **事件驱动沉淀**：`src/memory/capture.js` 是事件总线订阅者，按 `DEFAULT_CAPTURE_DOMAINS`（`:16-19`）把领域事件沉淀为记忆；`precipitate.js:100` 把粒子字段变更自动沉淀。
- **衔接点**：发现引擎 emit 一个 `discovery` 领域事件（`src/events/bus.js:17` `emit`）→ 加入 `capture.js` 捕获域 → 自动入记忆；或经 `crm-memory-upsert` 直接写 Claygent 笔记。SSE（`sse.js:24`）已广播全领域，前端实时可见。
- **【C3】账户持久记忆**：monitorAccount（§6.2）的增量结论经 `crm-memory-upsert` 写入账户维度 `memory_log`（append-only），由 `ai-memory-lifecycle` 双轨机制在 30 天后蒸馏为 `memory_note` curated 摘要，**不覆盖、不删除**历史。这是对 Clay Account Agent "持久记忆" 的等价实现，且守「禁 DELETE」铁律。
- **⚠️ P0 #2（上下文红线 · 受保护 context-routing id36）**：发现结论（研究笔记/评分）要注入下游 Agent 上下文，**只能消费现有 L2（memory）通道**（经 `capture.js`→`memory_note`→L2 装配），**绝不允许修改 `src/context/routing.js` 的 context-routing(id36) 配置**（2026-09-04 起平台红线，禁改）。发现引擎不新增 routing 条目、不改动 `assembleContext` 装配链；整份研究报告注入须设 **64KB 体积闸** + `truncated`/`degradedLayers` 降级，避免撑爆上下文。

### 9.4 决策层衔接（K-M-D + 自主决策）

> 本问核心：discovery 如何与 KMD 结合？答案 = **复用 `decision-agent` + `method-decision-enrich` + 九标尺，仅新增 1 个 `decision_scenario` 行 + 1 个事件矩阵行，零引擎/标尺代码改动**。

- **KMD 脊柱**：K 知识 / M 记忆 / D 决策（`edgeDimensionSpec.js:2`）；决策表 `crm.decision`（`schema.sql:164-186`）；9 标尺在 `rubricScorer.js:17-27` 静态 `RUBRICS` 恒被遍历（`:204-213`），第 8 标尺 `importance` 依赖 `concept_refs`（`rubricScorer.js:25`，`scoreImportance` 读 `ctx.concept_refs` `:124-136`）；自主引擎 = `autonomyEngine.js`。
- **评分 = 新 `decision_scenario` 行（lead-fit），免费复用九标尺**：`icp_fit_score`/`intent_score` 当前**无列**（grep 无）；应作为新 `decision_scenario` 行（`schema.sql:118`，含 `focus_rulers`/`enabled_rulers`/`rubric_pass_line` `:130-132`），设为 `tier='LEAD'` + `autonomous_allowed=TRUE`（仿 `LEAD_FOLLOW_UP` `seed.sql:229-233`），输出评分进 `CRM_ACCOUNT.payload.discovery`。**无需改 `rubricScorer` 代码**——9 标尺与 `concept_refs` 路径自动复用。
  > **吸收 Clay #1/#3**：`focus_rulers`/`enabled_rulers` 即 C1 编排的"判定条件"段载体；monitorAccount（C3）重评分复用同一 scenario 行（只换输入数据），**零新增标尺**。
- **触发 = 事件矩阵自动派发**：`src/agent/eventTrigger.js:15-26` 矩阵把 `CRM_KNOWLEDGE` 的 `ontology-sync` → 意图 `decision-enrich` → `decision-agent`（`src/agent/eventTrigger.js:22-24`）。即：发现富集经 `ontologySync` 产出知识粒子 → **自动触发 `decision-enrich`** → `requireDecision`（`autonomyEngine.js:115`，读 scenario `:119`）→ fire-and-forget 派发 `decision-enrich` `:280` → `routeThroughIntake`（`scheduler.js:48-62`，命中 intent 路由 `decision-agent` + `method-decision-enrich`）→ `runWithSkill` 执行 `method-decision-enrich`（`skills/seed.js:112`）。**自然衔接点，无需新写触发逻辑**（可选：在矩阵加 1 行把"发现知识"→ `lead-fit` intent 以独立评分）。
  > ⚠ 2026-09-11 复查：该行**归 Task 16 落地**——`matchTrigger` 的只读白名单闸（`src/agent/eventTrigger.js:30-32` + `:65-76`）会**静默丢弃**写 SKILL，且全仓当前无 `discovery-sync` emitter ⇒ 现在硬编码该行即死配置（运行时永不命中且无报错）。**C3 monitorAccount 复用同一矩阵**：信号事件 → 重评分 intent → `lead-fit` 重跑。
- **HITL 仅卡写闸，评分可自主**：`autonomyEngine.js:274` `escalated = forceException || tier==='HIGH' || conf<effectiveThreshold`；非升级即自主拍板（`:282`）。写操作经"决策第 0 闸"（如 `PARTICLE_UPDATE` `seed.sql:325-329`，`autonomous_allowed=TRUE` 但 gateway `confirm_token` 承担硬人工闸）→ **评分自主、写出受 HITL 约束**，与 §0 反转一致。
- **无既有 discovery 场景可复用**：`seed.sql:227-338` 共 19 行 scenario（含 `LEAD_FOLLOW_UP`/`OPP_QUALIFY`/`PARTICLE_UPDATE`/`REQUIREMENT_COLLECT` 等），**无发现/lead-fit 类**；`decision-enrich` 是 **intent 而非 scenario** → 必须新增 1 个 scenario 行（不复用、不重造引擎）。
- **⚠️ P0 #3（ICP 自进化 = 草稿→回测→HITL→validated）**：`decision_scenario` 权重/rubric 重校准**绝不自动生效**——先落草稿行（`validated=FALSE`），经回测（threshold/count/noop）与人工审批后才置 `validated=TRUE`。详见 §0.1 step6。

### 9.5 MCP 专家暴露衔接
- **工具由 Action Registry 派生，非硬编码**（`tools.js:41-130`）；namespace 由 name 前缀自动推导（`registry.js:19`）。`discovery-run/enrich/research` 非 `data-*` 前缀 → 注册即自动暴露为写工具（`:94` 排除仅限 `data-*` 写）。
- **protocolShape 陷阱**：新协议级参数须在 `tools.js:62-76` 声明，否则被 zod 静默 strip（历史踩坑：`decision_id`/`api_token`）。发现引擎的**业务参数走 `a.schema`**；仅跨切参数（`confirm_token/choice/decision_id` 等）才进 `protocolShape`。
- **衔接点**：在 `seed-actions.js` 经 `registerAction` 注册三个 `discovery-*` 动作（参照 `data-particle-create` `seed-actions.js:72-119`），即自动进入 MCP 工具清单，无需改 `tools.js`。

### 9.6 线索 S1 衔接（关键接缝）
- **两套 stage 概念**：(a) `payload.stage='lead'` = 入站原始线索态（`tenderConnector.js:54`）；(b) S1–S8 = 资质管道阶段（`stageConfig.js:8-17`）。
- **既有推进链**：`createLeadFromTender`（`tenderConnector.js:51`，+sourcedFrom 边）生成 `DEAL(stage='lead')` → 经 `intake-router`（`agentSpec.js:4-15`，含 `method-intake-routing`）→ BANT 闸（`scoreBantcc6` `seed-actions.js:439`，达标 `bantcc.pass=0.6` `salesThresholds.js:13`）→ 进 S1 → `crm-stage-progression-evaluate`（`:418-484`）+ `crm-deal-advance`（`:733-772`）单向前推。
- **衔接点（复用，不重造）**：发现引擎产出的 `CRM_DEAL(stage='lead')` **直接复用现有 intake-router + BANT 闸 + 阶段推进机**，无需新写推进逻辑。发现引擎只负责"生成 lead + 挂 sourcedFrom + 灌溉评分 decision_scenario"，S1 及之后全走既有管道。
- **【C3 外联消费】**：S1 阶段外联由 `method-followup-engine` 经 C1 编排消费 discovery payload（enrichment=背景、signals=动态、why_narrative=痛点钩子）；回复事件 → 触发 `method-quote-engine` 方案生成（配套 competitive-analysis §G5/G6）。

### 9.7 界面衔接（MCP 调入 / 胶囊 / 后台模块 / 配置系统）
- **MCP 调入（UI→MCP）**：`buddy-crm-portal.html:54-94` `CAPS` 把 tab 映射到胶囊按钮，`skill`=MCP 工具名；点击 `postMessage({type:'inject-prompt',skillSlug,targetAgent})`（`:110-127`）进聊天 iframe；`agent-workbench.html:332-336` 监听 → `POST /api/agent/dispatch` → `routeThroughIntake`。**"线索发现"胶囊 = 一个 `CAPS` 项，其 `skill` 等于 discovery MCP 工具名。**
- **胶囊定义**：`buddy-crm-manifest.json` `workModes`（3 模式 sales/manager/admin，共 14 胶囊）每胶囊含 `name/en/icon/skills/systemPrompt/prompts`。新增：在 `workModes[].capsules[]` 加一个胶囊对象（或仅加 `CAPS` 项先跑通）。
- **后台模块 + 配置系统**：`configCenter.js:11-72` `CONFIG_ITEMS`（id 11–45）加 `discovery-rules` 条目（`{id,name:'线索发现规则',level:'tenant',scope:'tenant',resolve:'tenant-first',page:'/discovery-rules.html',endpoint:'/api/config/discovery-rules'}`）；路由 `configRouter.js:51-161` `createConfigRouter({key:'discovery-rules',...})` 挂 `GET/PUT /api/config/discovery-rules`（范式 `routes.js:215-224`）。
- **配置播种 + 真隔离**：系统默认 `db/seed.sql`；按租户 `db/seed/tenantDefaults.js:18-22` `DEFAULT_TENANT_SEED_KEYS` 从 `system` 模板懒克隆。`config.html` 的"租户级"仅为 UI 分组，**真隔离在数据层** `configStore.js:16-49`（per `(tenant_id,key)`，scopeTenant/scopeOf）。`discovery-rules` 加进 `DEFAULT_TENANT_SEED_KEYS` 即自动按租户隔离。
- **Provider Registry 同遵循按租户隔离（D1）**：`discovery-rules.providers` 中每个 provider 的 `enabled` 是**租户级状态**——系统默认源从 `system` 模板懒克隆到各租户默认启用；付费源克隆后默认 `false`；「行业 handbook 配置」可在租户 onboarding 时批量置特定 provider 启用（attio/zhizao 类候选即此路径）。
- **【C1 编排配置页】**：`discovery-rules.html` 后台页须支持编辑 `playbooks`（客群→四段原语编排），按 §3.2 契约；读取模式仿 `readThreshold`（`salesThresholds.js:85-101`）+ `mergedThresholds`（`:104-115`）：定义 `DEFAULT_DISCOVERY_RULES` + `mergedDiscoveryRules(cfg)`（克隆默认 + 浅合并 playbooks/groups），消费点 = `discovery-*` 动作处理器与后台页。

### 9.8 ACTION 注册衔接（三处硬闭包）
注册 `discovery-run`（及 enrich/research）须改 **3 处**（对应 `assertAgentAssembly` `agents.js:64-118` 两个断言）：
1. **登记 Action**：`registerAction({...})` 入 `src/action/registry.js`（`:6-21`），满足**断言4**（actions ⊆ Action Registry）。业务动作入 `seed-actions.js`，连接器类入 `connectorActions.js`（如 `conn-attio-enrich-account:17`）。可继承 `autoDecision:true`（第0闸自 mint 决策）+ `autoWeakEdge:true, weakPredicate:'sourcedFrom'`（自动落溯源边）。
2. **声明到 Agent**：`src/agent/agentSpec.js` 把 `discovery-run` 加进 `capabilities.actions`（`:7`）及 `skillCalls`（`:8`），满足**断言3**（skillCalls ⊆ capabilities.actions）。
3. **登记 SKILL**：`src/skills/seed.js` 中 `lead-discovery` SKILL 须含 `steps[].action='discovery-run'`（范式 `method-stage-progression:146`），这是 skill→action 的第三闭包。
- 三处齐改后 `assertAgentAssembly().ok` 通过，`discovery-*` 即被 MCP/事件触发。

### 9.9 衔接总览（发现引擎 × 平台层）

| 平台层 | 复用点（不新增） | 新增点 | 锚点 |
|---|---|---|---|
| 数据层 | CRM_ACCOUNT(potential)/CONTACT/DEAL(lead) + edges(sourcedFrom) + duplicateCriteria 去重 | 无 | schema.sql:11-55 |
| 知识层 | CRM_KNOWLEDGE + ontologySync 自动边 | 无 | hooks.js:48-113 |
| 记忆层 | memory_log/note + capture 事件订阅 | 加 `discovery` 捕获域 + **C3 账户持久记忆流** | capture.js:16-19 |
| 决策层 | decision-enrich 事件链 + 九标尺 + method-decision-enrich + decision-agent | 新 decision_scenario(lead-fit) + 事件矩阵新行（含 C3 重评分） | src/agent/eventTrigger.js:15-26; autonomyEngine.js:115; schema.sql:118 |
| MCP | 工具由 Registry 派生 | 3 个 discovery-* 动作 | tools.js:41-130 |
| S1 | intake-router + BANT 闸 + advanceStage | 无（C3 外联消费 method-*） | tenderConnector.js:51; agentSpec.js:4-15 |
| 界面 | CAPS 胶囊 + configCenter | discovery-rules 配置项 + **C1 编排后台页** | buddy-crm-manifest.json; configCenter.js:11-72 |
| ACTION | 三处硬闭包注册范式 | 3 处补 discovery-* | agents.js:64-118 |

> 结论：发现引擎 **100% 复用既有原语**，仅新增"3 个 ACTION + 1 个 decision_scenario + 1 个 config 项 + 1 个胶囊 + C1 编排页 + C3 记忆流"，完全守 §10 硬约束（不新增粒子类型、不改业务域模型）。

### 9.10 是否需要新增智能体？（回应本问）

> 结论：**不需要新增顶级 Agent，也不需要子 Agent。** 发现引擎是「既有 Agent 借事件/KMD 织物驱动的 SKILL 循环」，而非一个新 Agent。

- **顶级 Agent 名册**：`agentSpec.js:3-89` 定义 **6 个**顶级 Agent（`intake-router`/`quote-engine`/`followup-agent`/`review-gate`/`decision-retro`/`decision-agent`）；`agents.js:64-118` 的 `assertAgentAssembly` 遍历 `agentSpecs` 校验两道硬闭包：① `skillCalls ⊆ capabilities.actions`（`agents.js:69-76`，`:73` `spec.capabilities.actions.includes(c)`）；② `actions ⊆ Action Registry`（`agents.js:78-84`，`:81` `getAction(a)!==null`）。
- **平台无子 Agent 机制**：`agents.js`/`agentSpec.js` 中**无 SubAgent 类、无 spawnSubagent、无 worker 派生**（agent 目录 grep `subagent|SubAgent|spawn` 零命中）。派发是 **kanban 工人制**：`routeThroughIntake`（`scheduler.js:38-91`）把任务路由到已注册 Agent；`runWithSkill`（`agentLoop.js:61`）只在单 Agent 身份下跑单 SKILL。**故"运行时派发子 Agent"不可行。**
- **先例否定新顶级 Agent**：`agentSpec.js:12` 注释「**lead-miner 已并入本体**」——历史上曾规划独立 `lead-miner` 顶级 Agent，后并入既有 Agent。新增顶级 Agent 路径已被实践否定。
- **推荐落地（选项 B，最轻且代码支持）**：新增 `lead-discovery` SKILL + `discovery-*` Action（`discovery-run`/`enrich`/`research`），由**既有 Agent**（`intake-router` 或 `decision-agent`）经事件矩阵 / intake 路由调用。机制：
  1. 在某既有 Agent 的 `capabilities.actions` + `skillCalls` 加新 action（满足闭包①、②）；
  2. `src/skills/seed.js` 登记 SKILL 步骤（第三闭包）；
  3. 可选：`src/agent/eventTrigger.js:15-26` 矩阵加 1 行把"发现知识"→ `lead-fit` intent（C3 重评分同此路径）。**⚠ 2026-09-11 复查：本项归 Task 16 落地**（只读白名单闸 + 无 emitter，理由同 §368 注）。
- **衔接点**：`scheduler.js:66-70` 允许事件矩阵预置 `payload.targetAgent` 直接指定派发目标；`src/agent/eventTrigger.js:22-24` 矩阵已把 `CRM_KNOWLEDGE ontology-sync → decision-enrich → decision-agent`。即「发现」由既有 Agent 在既有调度/KMD 织物上跑，无需新 Agent 身份。
- **再次印证 §0 反转**：把平台认知原语当自身器官——决策判断力 = KMD、记忆 = 本体/记忆层、手脚 = 既有 Agent 调度、conscience = 第 0 闸——而非另造一个 Agent。**C1/C2/C3 均为既有原语的组合与常驻化，不引入新 Agent 身份。**

### 9.11 反馈闭环（feedback-loop · P0 #4 已补）

> 本能力在 v5 设计中原缺失（❌），现补指标模板 + evaluator + Token-业务对账三项。

- **指标模板（7 要素）**：每条 discovery 反馈回路 ≥ 1 个指标，含 `direction/formula/target/alert/owner_agent/evaluator_skill/adjust_actions`：
  - 例 `discovered_to_won_rate`：`direction=up`；`formula=COUNT(DEAL lead→closed-won)/COUNT(DEAL lead)`；`target≥0.15`；`alert<0.08`；`owner_agent=decision-retro`；`evaluator_skill=method-decision-enrich`；`adjust_actions=重校准 lead-fit scenario`。
  - 例 `enrichment_coverage`：`formula=已补字段/应补字段`；`target≥0.8`（呼应 ontology-vector-build 覆盖率≥80%）。
  - **【C3 接入】** `monitorAccount_refresh_rate`：`formula=已监控账户重评分次数/应监控账户数`；`target≥0.9`；反映持续监控闭环活跃度。
- **evaluator 加权 + 三档阈值**：`method-decision-enrich` 复用九标尺评分作 evaluator；`pass_rule` + 三档（绿/黄/红）阈值驱动质量闸门——红档**回滚** scenario 草稿而非仅熔断。
- **Token-业务因果对账**：provider API 调用成本（Token + credit）须对账到赢单业务结果——`discovery_cost_ledger` 记录每笔 `account_id` 的 provider 花费，关联最终 `closed-won` 的 ROI；超阈值无产出则告警（呼应 §3 成本护栏）。
- **人机分工四判据**：评分/研究 Agent 自主；写出 HITL（第 0 闸）；**不可逆**（ICP 规则变更、scenario 权重重写）须人确认；**C3 跨外联绝不自动发信**。

---

## 10. 已拍板的 4 项假设（D1–D4 · ✅ 用户已确认 v7/v8）

- **D1 付费源默认禁用（按多租户数据源架构）** ✅：Clearbit/LinkedIn 类付费 provider 出厂 `enabled:false`，管理员**显式授权 + 填 key** 后**在指定租户独立启用**。数据源分级：① **系统级默认**（email-verify/web-research/标讯/高德，出厂启用，按租户懒克隆）；② **系统候选**（attio/zhizao，骨架登记，经「行业 handbook 配置」按租户启用）；③ **付费源**（默认 disabled，需授权+key）。
- **D2 起步适配器集** ✅：P1 实现 **email-verify / web-research / 标讯(tenderConnector) / 高德(Gaode)** 四个真实 fetch（见 §3 表）。attio/zhizao 降级为系统候选（按租户启用），不占 P1 实现配额。
- **D3 溯源方式** ✅（沿用）：`payload.enrichment`（按 provider 存原始值）+ `sourcedFrom` 边双写（另补 P0 #1 的 2D judge/why_narrative/layer）。
- **D4 阶段顺序** ✅（沿用，吸收 C1/C2/C3）：P1 富集清洗 + **可组合编排骨架(C1)** → P2 Claygent + **glass-box(C2)** → P3 **持续监控闭环(C3)** + ICP 自进化 + 双向同步（见 §7）。

> 4 项假设已全部拍板，4 个 P0 已补入 §5/§9，Clay 三项最佳能力（C1 可组合编排层 / C2 Claygent+glass-box / C3 持续监控闭环）已吸收为循环一等能力。**设计达「可进实施」门槛，下一步移交 writing-plans（据 v8 重出实施计划）。**

---

## 11. 10 大 AI 原生能力系统自检（配套文档）

> 以 10 个 `ai_*` SKILL 方法论基线对已批准前的 v5 设计做逐能力过堂，详见 **`docs/2026-09-10-lead-discovery-capability-audit.md`**。核心结论：

- **覆盖度（v5 自检结论）**：架构衔接（§9）成立；但按 10 能力逐条核对，1 处 ❌（feedback-loop 无指标模板）、9 处 ⚠️、4 处 **P0**。
- **4 个 P0（进 writing-plans 前须消解）**：
  1. ✅ AI 属性补 2D（能力轴×来源轴）+ J_Judge + why_narrative + L1–L4（§5 已补，**C2 glass-box 复用同源 judge 结构**）；
  2. 发现结论注入上下文不得改受保护 `context-routing(id36)`，仅消费现有 L2 通道（§3/§9.3）；
  3. ICP 自进化须草稿→回测→HITL 审批，绝不自动生效（§8）；
  4. ✅ feedback-loop 指标模板(7要素)+evaluator+Token-业务对账（§9.11 已补，**C3 增 monitorAccount_refresh_rate 指标**）。
- **本轮新增吸收（v8）**：据「Clay 核心竞争力排序」研判，将 Clay 最该借的三项吸收为循环一等能力——**C1 可组合编排层（§3.2，吸收 #1 护城河）、C2 Claygent+glass-box（§4，吸收 #2）、C3 持续监控闭环（§6.2，吸收 #3 升 P0）**；明确**不借** 200+ 数据源（最弱护城河、已商品化）。
- **本轮已修正**：§8 生命力契约 `agent: lead-miner` 矛盾已改为 `decision-agent`（§8 + §9.10）；dedupResolver 已据 Twenty 核心层改为 `duplicateCriteria` 配置驱动（§3.2/§9.1）。
- **结论**：4 个 P0 已补入主文档；C1/C2/C3 已吸收为循环一等能力；P1（9 处 ⚠️ 治理细节）列入 writing-plans 任务清单；**设计达「✅ 可进实施」门槛**。

---

---

## 12. 行业包扩展 handbook 同步（v8.1 新增）

> **背景（用户 2026-09-10 指出）**：D1 已把数据源定为「系统级默认 / 系统候选 / 付费」三档，其中**系统候选（`attio`/`zhizao`）经「行业 handbook 配置」按租户启用**（§3.1 注、§10 D1）。但「行业 handbook」= `industry-onboarding` Runbook，**当前两份 SKILL 均无 discovery 步骤且彼此已分叉**，行业模板 `db/seed/tenant-profile-*.js` 亦**无 discovery 段**——即 D1 的「按租户启用数据源」**缺 onboarding 落地通道**。本节补齐该接缝，**不新增粒子类型、不新增 Agent、不改业务域模型**。

### 12.1 现状事实（代码级锚点，已核实）

| 事实 | 位置 | 影响 |
|---|---|---|
| 行业包（多行业画像）**已实装** | `src/config/profileMerger.js`（6 纯函数）；`src/config/configStore.js:54-58` 桥接；`src/http/billingRoutes.js:282` profile-templates / `:421` assign-profile / `:451` remove-profile | 行业 = `tenant-profile.industries[]`；`mergeProfile` 合并为扁平对象供下游三消费点零改动 |
| 行业模板 **7 份，无 discovery 段** | `db/seed/tenant-profile-{chemical,consult,consult2,demo,insmedi,meddev,training}.js` | 模板结构 = `{prototypes, approvalDomains, calculations}` |
| 行业 handbook **两份且已分叉** | `plugin-platform-admin/skills/industry-onboarding/SKILL.md`（打包进 `plugin-platform-admin.zip`，`verify-plugin-zips.py:162` `expect_version=1.1.1`，含 Step 4B/4.5）vs `.workbuddy/skills/new-industry-onboarding/SKILL.md`（旧版，引 `2026-09-03-multi-industry-config-profile-design.md`，只到 Step 1–9） | 两份须**逐节对齐**并**同步新增 discovery 步骤** |
| 行业配置（buddy 应用） | `dist/buddy-import/industry-config.json`（v1.0.0，appId `cb_FOxvB7l9dSOVv4ziL408`），由 `scripts/gen-industry-config-variants.mjs` 自 `buddy-crm-manifest.json` 生成 | 需加「线索发现」胶囊 + 版本 bump |
| 行业包测试已落 | `test/config/profileMerger.test.js`、`test/billing/tenantAdminMultiProfile.test.js` | 新增 discovery 步骤须不回归此二套 |

### 12.2 接缝设计：onboarding 新增 **Step 4C**（启用本租户数据源 + 播种行业 ICP/信号/编排）

在 Step 4B（主数据播种）之后、Step 4.5（KNOWLEDGE 种子）之前插入 **Step 4C**：

1. **启用数据源（D1 落地）**：把 `discovery-rules.providers` 从 `system` 模板懒克隆到本租户（首次读由 `mergedDiscoveryRules()` 完成），再按行业手册清单置 `enabled:true`：
   - **系统级默认**（`email-verify` / `web-research` / `标讯` / `高德`）：克隆后默认 `true`，手册无需干预。
   - **系统候选**（`attio` / `zhizao`）：克隆后默认 `false`，**由本 Step 按行业启用**。
   - **付费源**（Clearbit/LinkedIn 类）：克隆后**恒 `false`**，**本 Step 严禁启用**（须管理员显式授权 + 填 key，§10 D1）。
2. **播种行业 ICP / 信号权重 / 编排**：把模板 `discovery` 段（见 §12.3）写入本租户 `discovery-rules`，落 `gateDecision({scenario_id:'config_change', ...})` 决策行。
3. **通道**：系统引导/种子态走 bootstrap 旁路（`ctx.bootstrap:true` + `actor:'system'`，依 `executor.js:50/92/105` 豁免三闸）；上线后日常调整走配置中心 PUT（自带第 0 闸）。
4. **验收**：`mergedDiscoveryRules(tenantId)` 的 `providers` 命中手册清单；本租户发现候选池可产出 ≥1 条；其它租户不可见（隔离）。

### 12.3 行业模板新增 `discovery` 段（结构）

```jsonc
// db/seed/tenant-profile-<industry>.js 内新增（与 prototypes/approvalDomains/calculations 同级）
"discovery": {
  "providers": { "attio": true, "zhizao": false },   // 仅「系统候选」需声明；默认源/付费源不由模板控制
  "icp": { "industries": ["化工"], "headcount": { "min": 200 }, "regions": ["华东"] },
  "signals": { "funding_round": 1.0, "hiring_icp_role": 0.8, "tender_match": 0.9, "tech_adopt": 0.6 },
  "playbooks": ["chem-default"]                       // C1 编排：引用 discovery-rules.playbooks 模板
}
```

> **关键隔离决定**：`discovery` 段是**纯数据**，由 onboarding **单独写入 `discovery-rules` 键**，**绝不写入 `tenant-profile`**——这样 `mergeProfile` 的合并结果形状（`prototypes/calculations/approvalDomains`）三消费点（`resolvePrototype` / `isControlledPredicateConfig` / `runProfileCalculations`）**零回归**。行业 discovery 配置与行业对象画像**解耦**。

### 12.4 双 SKILL 对齐 + 打包

- `plugin-platform-admin/skills/industry-onboarding/SKILL.md`：新增 Step 4C；`registry.json` `version` 1.0.0 → 1.1.0；`plugin-platform-admin.zip` 版本 1.1.1 → **1.2.0**，`scripts/verify-plugin-zips.py:162` `expect_version` 同步，并新增内容规则：`Step 4C`（存在）、`discovery-rules`（存在）、`付费源`（存在）。
- `.workbuddy/skills/new-industry-onboarding/SKILL.md`：与 plugin 版**逐节对齐**（消除分叉：补 Step 4B / 4.5 / 4C，统一 design 引用为 `2026-09-10-multi-industry-tenant-profile-design.md`），版本号与 plugin 版一致。

### 12.5 红线

- **不新增粒子类型、不改业务域模型、不新增 Agent**（§10）。
- `discovery` 段**独立落 `discovery-rules` 键**，不写 `tenant-profile`（不污染 `mergeProfile` 三消费点）。
- 行业 onboarding **不得启用付费源**（D1 铁律；模板 `providers` 中付费键缺省即 `false`）。
- 写操作过**决策第 0 闸**（bootstrap 旁路仅限种子态）。
- **禁 DELETE**：移除行业走 `remove-profile`（数组 drop + 整体 UPDATE），不删 `config_store` 行。

---

## 13. 写后自查（brainstorming P7 · v8.1）

| 检查项 | 结论 | 证据/处置 |
|---|---|---|
| **占位符** | ✅ 无 | 全文扫描 `TODO/TBD/XXX/待填/？？/<待` 零命中；JSON 示例中的 `...` 为示意值非占位符 |
| **矛盾** | ✅ 无 | ① §2 架构图 5 环节与 §0.1 九步、§6.2 C3 循环一致；② §8 契约已无 `lead-miner`（改 `decision-agent`），与 §9.10 名册一致；③ 阶段顺序 §0.5/§7/§10 D4 三处一致（P1→P2→P3 含 C1/C2/C3 归属）；④ 数据源分级 §3.1 与 §10 D1 一致 |
| **歧义** | ✅ 已消除 | ① 明确 `enabled` 是**租户级状态**（§3 注）；② 明确 C3"跨外联绝不自动发信"（§0.1/§6.2/§9.11 三处呼应）；③ 明确 `context-routing(id36)` L2 通道唯一、禁改（§9.3）；④ 明确编排=配置驱动差异化、零核心代码改动（§3.2） |
| **范围** | ✅ 守界 | 不新增粒子类型、不改业务域模型（§10 红线）；不新增顶级 Agent/子 Agent（§9.10）；C1/C2/C3 均为既有原语组合与常驻化，未越界到营销/ads（标 future） |
| **写后修正** | ✅ | ① 修正 §5 JSON 示例 `"ts":"."` 笔误为 `"ts":"..."`；② v8.1 新增 §12 行业包 handbook 同步（独立 `discovery-rules` 键、不污染 `mergeProfile`） |
| **行业包同步（v8.1）** | ✅ | §12 与 §10 D1「系统候选经行业 handbook 按租户启用」一致；`discovery` 段独立落键，`mergeProfile` 三消费点零回归；两步 SKILL 对齐 + 打包版本链（1.1.1→1.2.0）齐备 |
