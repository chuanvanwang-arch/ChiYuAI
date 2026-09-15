# Anysite 三案例功能借鉴深度分析（P0+P1 全量）

> 状态：**brainstorming P3/P4 探索与方案阶段**（未批准不进入实现）
> 材料：app.anysite.io 三篇 case study——b2b-outbound-icp-discovery / b2b-sales-intelligence / sales-engagement-linkedin-monitoring
> 口径：材料为**数据基础设施供应商（API 层）的客户故事**，本文借鉴其**客户侧功能范式**（发现→富集→评分→意向→个性化→触达链路），不搬运其 API 端点
> 红线：全部借鉴项不新增粒子类型、不破坏既有业务域模型（已批设计 §10 硬约束）；写走第 0 闸；禁 DELETE；阈值/权重 100% 配置驱动

---

## §0 结论先行

平台已具备「批量候选搜索 → 服务端评分 → 圈选 → 批量入公海池(S0)」主干，起点高于案例中团队；**六项可借鉴功能**均落在**评分语义、质量闸、成本治理、触达素材**四个层面，无一需要新增粒子类型：

| 优先级 | 借鉴功能 | 案例来源 | 平台差距本质 | 落地形态 |
|---|---|---|---|---|
| **P0-1** | 信号时间衰减 + 买意向新鲜度视图 | 案例3（24h 窗口）| signals.weight 静态，fit_score 不随时间变化 | 配置化衰减 + 公海池新鲜度排序 |
| **P0-2** | 触点角色→决策链角色漂移校验 | 案例1（no role drift）| 决策链存储有、无质量校验 | 纯函数校验器 + 完整性分挂接 |
| **P0-3** | 两段式富集成本治理 | 案例2（0.3% 富集率）| 富集无成本账/命中率指标 | 粗筛/精富集分段 + 命中率看板 |
| **P1-1** | 个性化触达钩子（hook）生成 | 案例1（24-30 词 hook）| 有引擎无「触达素材」资产 | 新 SKILL method-outreach-hook |
| **P1-2** | hiring 信号下钻（岗位层级+发布时间） | 案例2（open jobs=预算信号）| 仅布尔 hiring_icp_role | 岗位层级分层 + 时间戳参与衰减 |
| **P1-3** | 触达前预热工作流（先互动后触达） | 案例3（60% vs 20% 接受率）| 无预热序列 | 预热子状态 + 排期（依赖社媒源） |

---

## §1 三案例功能范式提炼

### 1.1 案例一：B2B Outbound — ICP Discovery & Scoring
**链路**：批量发现(迷你 DSL 检索) → 富集(融资/增长) → ICP 分类评分(HOT/WARM/MAYBE/EXCLUDE，LLM+缓存) → 决策人识别(5-15 位/公司) → 90 天帖文买意向评分 → 邮箱解析 → 24-30 词个性化 hook → 就绪触达清单。
**关键范式**：
- F1：**自持 ICP 定义**（不被供应商粗粒度 ICP 绑架）——自有评分准则跑在底层数据上
- F2：**质量收口闸**="hook+已验证邮箱+无角色漂移"（180 条 ready-to-send，0 漂移）
- F3：**成本分段**——粗发现免费/按 surviving rows 付费，7 步流水线只对 HOT 做精活

### 1.2 案例二：B2B Sales Intelligence — 统一数据管线
**链路**：公司研究(画像) → 员工发现/决策人识别(63% 用量) → 触达富集(仅 0.2% 用量)。
**关键范式**：
- F4：**开放岗位 = 预算分配信号**（在招 VP 销售 = 有钱买销售工具）
- F5：**智能过滤 > 批量富集**（452 邮箱/143,785 画像 = 0.3% 富集率，是精度不是浪费）

### 1.3 案例三：Sales Engagement — LinkedIn 实时监控
**链路**：内容发现(84% 用量) → 持续监控 → 公司富集(ICP 过滤) → 用户富集(个性化) → AI 建议评论/私信 → 销售审阅确认发。
**关键范式**：
- F6：**信号短保质期**——24h 内互动 2-5x 回复率；一周后即"事后诸葛"
- F7：**先互动后触达**——预热转化 60% 接受率 vs 冷开发 20%，25%+ 停滞商机靠信号式跟进复活
- F8：**人机分工**——AI 生产建议，销售审阅/编辑/决定，15-30 分钟日例行

---

## §2 平台现有能力盘点（源码锚点已核）

| 能力域 | 现有实现 | 锚点 |
|---|---|---|
| ICP/信号权重配置 | 出厂默认 ⊕ 租户覆盖，100% 配置驱动 | `src/config/discoveryRules.js:10-46` |
| 拓客规则（fit 阈值/信号权重/源上限） | 服务端 computeFitScore（Σ命中×权重/Σ权重） | `src/config/prospectingRules.js:9-64` |
| 批量候选搜索 | 三 Action：search/select/confirm（confirm 写，走第 0 闸） | `src/action/prospectingActions.js:64-211` |
| 发现编排瀑布 | 适配器→富集→评分→落库 S0，cost/calls 已返回 | `src/agent/discoveryOrchestrator.js:38-131` |
| 适配器三档数据源 | system/system-candidate/paid，costTier 升序，per-tenant 注册 | `src/connectors/discovery/providerRegistry.js:36-56` |
| 内置适配器 | email-verify/web-research/tender/gaode/qixin/xinbang/anysite | `src/connectors/discovery/builtinAdapters.js:20-28` |
| 查重去重 | 命中复用赢家，禁删 | `src/connectors/discovery/dedupResolver.js:18` |
| 公海池 | S0 入池 + 认领 + BANT 校验 | `src/web/lead-pool.html`、`seed-actions.js:931-1086` |
| 决策链存储 | DEAL.involved_entities（数组 {type,id}）+ decision_chain 字段 | `insightService.js:267,324`、`precipitate.js:26` |
| 联系人角色字段 | CRM_CONTACT：title/department/decision_power/job_title | `src/particles/particleModel.js:39-44` |
| 已注册 method-* 技能 | method-quote-engine / followup-engine / dialog-router 等 | `src/skills/seed.js` |
| 信号对象时间戳 | discovery 侧 signals 已带 ts（{type,provider,ts}） | `discoveryOrchestrator.js:90` |

**差距矩阵**：评分语义无时间维度（F6）；无决策链质量校验（F2）；富集无成本/命中率账（F3/F5）；无触达素材资产与来源可验证（F1/F8）；hiring 无岗位层级下钻（F4）；无预热序列（F7）。

---

## §3 P0 三项深度设计

### P0-1 信号时间衰减 + 买意向新鲜度视图

**案例依据**：F6 信号短保质期；案例3 全天候监控的价值=在窗口内行动。

**平台现状**：`discoveryRules.js:31-39` 的 signals.weight 静态（funding 0.9/hiring 0.7/tender 0.8/...），fit_score 不随时间变化；`prospectingRules.js:16` 同理。发现侧 signals 已带 ts（`discoveryOrchestrator.js:90`），但评分函数未消费。

**功能设计（只读+纯函数，零新粒子）**：
1. **配置化衰减档**：config_store['discovery-rules'].signal_age_tiers（与 prospecting-rules 同构）：
   ```
   signal_age_tiers: [ {max_days: 7,  multiplier: 1.0},   # 新鲜
                        {max_days: 30, multiplier: 0.6},
                        {max_days: 90, multiplier: 0.3},
                        {max_days: null, multiplier: 0.1} ]  # 陈旧
   ```
2. **信号时间字段映射**（配置化，适配器返回则用，缺省 fallback=无衰减）：`signal_time_fields: { funding: 'funding_at', hiring: 'hired_posted_at', tender: 'tender_at', social: 'social_at' }`。
3. **评分管道改造**：`computeFitScore` 增加时间维度——每个命中信号读数 × 对应档位 multiplier；结果仍归一 [0,1]。纯函数，单测友好。
4. **新鲜度视图**：`lead-pool.html` 公海池增加「信号新鲜度」列/排序（今日/本周/本月/陈旧徽标），默认按新鲜度置顶——决策人优先认领刚有融资/招聘/中标信号的线索。

**红线兼容**：无新增粒子；只读视图+配置+纯函数；不触既有写入链路。
**验收判据**：① 同一候选，signal ts=今天 vs 100 天前，fit_score 比值 ≈1:0.1；② 配置档位缺省时行为与现网一致（向后兼容）；③ 公海池视图可按新鲜度排序且徽标正确。

---

### P0-2 触点角色 → 决策链角色漂移校验

**案例依据**：F2「无角色漂移」是 ready-to-send 质量闸（案例1：180 条 0 漂移）；案例2 的决策人识别是产品核心。

**平台现状**：决策链已存储（DEAL.involved_entities 数组 + decision_chain 字段），CRM_CONTACT 已有 title/department/decision_power 字段（`particleModel.js:39-44`），但**无「链条所需角色」与「实际触点角色」的一致性校验**——链条可能缺 vetoer、或把无决策权联系人挂为角色。

**功能设计（纯函数校验器，零新粒子）**：
1. **决策链角色模板（配置化）**：config_store['decision-chain-template']——必需角色集与允许缺失：
   ```
   decision_roles: { recommend: {required:false}, veto: {required:false},
                     budget: {required:false}, approve: {required:false},
                     champion: {required:false}, missing_allowed: 2 }  # 低于阈值判不完整
   ```
2. **角色映射规则（配置化）**：由 title/department/job_title 关键词映射角色能力域（采购部→veto、研发/技术→champion/recommend、IT→recommend、CXO/财务→budget/approve），映射词表全部可配，禁硬编码行业字面量。
3. **漂移判定（纯函数）**：输入 DEAL 关联 CONTACT 集合 → 输出：
   - 缺失角色列表（模板需要但链条无触点覆盖）
   - 漂移触点列表（挂了决策链角色但 title 不匹配映射域，如"工程师"挂 veto）
   - 决策链完整性分 [0,1]（覆盖角色数/模板必需数）
4. **挂接**：完整性分并入 S0→S1 升级校验（BANT 通过 + 决策链完整才可升），或仅标记「待补决策链」预警；account-360 决策链 Tab 展示漂移标红。

**红线兼容**：纯函数只读；映射词表配置化（不新增域字面量）；不写不改现有角色字段。
**验收判据**：① 输入含采购角色但触点 title=工程师 → 判漂移并给缺失/漂移清单；② 模板配置缺省时旧数据不误报（fail-open）；③ 完整性分与 BANT 状态同页可见。

---

### P0-3 两段式富集成本治理 + 命中率看板

**案例依据**：F5 智能过滤>批量富集（0.3% 富集率=精度）；F3 成本分段（只对 survived rows 付费）。

**平台现状**：`prospecting-search` 已先 fit_threshold 过滤（`prospectingActions.js:98-101`），**方向对**；`runDiscovery` 已返回 cost/calls（`discoveryOrchestrator.js:128`），但**无富集成本账与命中率指标**——付费源精富集是否只在入围候选上执行、命中产出多少，无观测。

**功能设计（指标+分段，零新粒子）**：
1. **两段式流水线语义**（配置驱动，不改现有 Action）：
   - 粗筛段：firmographics + 信号位（现有 search 已具备）
   - 精富集段：仅对 fit ≥ 精富集阈值（新配置 `deep_enrich_threshold`，默认取 fit_threshold）的候选做决策人识别/邮箱/联系方式富集
2. **富集事件域**：events/bus 增 'enrichment' 域，每次精富集调用发 {provider, cost, calls, hits, candidate_id, tenant_id}（只读观测，入 memory/看板）。
3. **命中率看板**（sales-decision-monitor 或 discovery 页新增块）：`enrichment_rate = 拿到有效邮箱/决策人联系方式的候选数 / 精富集候选数`；附 cost/calls 累计。**抗假绿**：看的是产出率不是调用量，比率低于配置阈值触发告警（复用 alert-rules 配置化告警）。
4. **成本闸**（可选，P0-3b）：付费源精富集消耗设租户级上限（cost cap），超限自动停精富集、退回粗筛。

**红线兼容**：只读观测+新事件域（不新增粒子）；阈值全部配置化；不改变现有写入链路。
**验收判据**：① 100 条候选仅对 fit≥阈值的 ≥N 条执行精富集（可观测）；② enrichment_rate 低于阈值触发告警；③ 成本/calls 累计可查。

---

## §4 P1 三项深度设计

### P1-1 个性化触达钩子生成（method-outreach-hook）

**案例依据**：F1 24-30 词 hook 锚定真实帖文/主页（案例1：245 条 0 错误）；F8 AI 建议+人审（案例3：2-5x 回复率）。

**平台现状**：已有 method-quote-engine/method-followup-engine 等 MCP 技能与输出可验证纪律，但**无「触达素材」资产**——开口钩子、锚定来源、置信度未生成/未存储。

**功能设计（新 SKILL + DEAL payload 子对象，零新粒子）**：
1. **新 SKILL `method-outreach-hook`**（steps）：
   - 输入：DEAL（画像/行业/规模）+ 最新信号（新鲜度联动 P0-1）+ 决策人触点
   - 生成：24-30 词开口钩子，锚定一个真实锚点（帖文/新闻/中标/融资）
   - 强校验：钩子内每个事实必须可溯源（引用 URL），不可溯源 → 拒出（对齐 CitationGuard 范式）
   - 输出：hook + anchor 引用 + 置信度 + 可验证性评分
2. **存储**：DEAL payload 增 `outreach_hooks[]` 子对象（JSONB 字段，非新粒子类型，不动业务域模型）。
3. **前端**：deal-detail 决策素材区展示钩子+锚点来源；followup 视图可直接取用。
4. **装配三处同改**（method-* 惯例）：src/skills/seed.js registerSkill + agentSpec.capabilities.actions + seed-actions.js method-* 登记（P7 契约自检需 registry 存在）。

**红线兼容**：不新增粒子；写走第 0 闸；来源可验证=平台既有输出纪律复用。
**验收判据**：① 钩子 ≤30 词且每条事实带引用 URL；② 无锚点可引用 → 拒生成（fail-closed）；③ MCP 阶段2 可调用（decisionScenario 声明齐全）。

---

### P1-2 hiring 信号下钻（岗位层级 + 发布时间）

**案例依据**：F4 开放岗位=预算分配信号（VP 销售在招=有钱买销售工具）。

**平台现状**：已有 `hiring_icp_role` 权重 0.7（发现侧）与 hiring:0.7（拓客侧），但**仅布尔**——不区分岗位层级，无发布时间参与衰减。

**功能设计（配置+适配器契约扩展，零新粒子）**：
1. **岗位层级分层（配置化）**：`hiring_role_tiers: { icp_key: ['VP','CXO','总监','director'], mid: [...], jun: [...] }` + 各档权重系数（如 icp_key×1.0 / mid×0.6 / jun×0.3）。
2. **时间戳接入**：hiring 信号带 `hired_posted_at`，参与 P0-1 衰减（30 天前岗位权重自动降档）。
3. **适配器契约扩展**：qixin/anysite 招聘字段尽量返回 job_title/posted_at（源不支持则降级为布尔，fail-open）。
4. **评分融合**：computeFitScore 对 hiring 信号按 层级系数 × 新鲜度 计分。

**红线兼容**：纯配置+适配器可选字段（fail-open）；不新增粒子。
**验收判据**：① 同厂「销售 VP 在招」与「市场专员在招」评分不同（层级系数生效）；② 30 天前岗位自动衰减；③ 源不返回字段时行为与现网一致。

---

### P1-3 触达前预热工作流（先互动后触达）

**案例依据**：F7 预热转化 60%+ 接受率 vs 冷开发 20%，25%+ 停滞商机靠信号式跟进复活。

**平台现状**：无预热序列；xinbang/社媒适配器已注册为辅助信号（`builtinAdapters.js:26-27`），但 linkedin 付费源出厂禁用。

**功能设计（预热子状态+排期，零新粒子/零新 stage）**：
1. **预热子状态**：DEAL payload 增 `preheat: { status: 'waiting|scheduled|engaged|ready', plan: [...], log: [...] }`（不增加 S 阶段，不改 stage 状态机——遵守 `S_STAGES` 冻结）。
2. **预热排期逻辑（纯函数）**：按信号新鲜度（联动 P0-1）排序互动序列；互动动作点（点赞/评论）由**人执行或未来社媒源执行**（HITL，不自动发帖/私信——红线：AI 不直接对外互动）。
3. **升级闸**：互动完成后标记 ready，进入正式触达清单（联动 P1-1 hook）。
4. **前端**：lead-pool/deal-detail 预热标记+下一个互动提醒。

**红线兼容**：不自动对外互动（人审/HITL）；子状态在 payload 内，不改 stage 状态机与粒子类型。
**验收判据**：① 预热状态流转合法（waiting→scheduled→engaged→ready）；② 无人工确认不触发任何对外动作；③ 排期随信号新鲜度自动重排。

---

## §5 实施路线图（批次分级）

| 批次 | 内容 | 依赖 | 风险 | 建议顺序 |
|---|---|---|---|---|
| **A** | P0-1 + P0-3（衰减+成本治理） | 无新 SKILL | 低 | **第一批**（纯配置+纯函数+看板） |
| **B** | P0-2（角色漂移校验器） | review-gate 挂接 | 低 | 第二批（复用 BANT/决策链闸） |
| **C** | P1-1（method-outreach-hook） | 新 SKILL 批准+三处同改 | 中 | 第三批（依赖 C 批 A/B 的新鲜度与角色数据） |
| **D** | P1-2（hiring 下钻） | 适配器契约扩展 | 低 | 可与 A 合并（同属评分管道） |
| **E** | P1-3（预热工作流） | 社媒源启用 | 中 | 最后（依赖外部源与 HITL 机制） |

聚合关系：**P0-1 是 P1-1/P1-2/P1-3 的公共底座**（新鲜度排序/衰减被三者复用），因此 A 批先行。

---

## §6 红线兼容性总表

| 借鉴项 | 新增粒子 | 改 stage 状态机 | 新 SKILL | 自动对外动作 | 写闸 | 配置驱动 |
|---|---|---|---|---|---|---|
| P0-1 | 否 | 否 | 否 | 否 | 只读 | ✅ |
| P0-2 | 否 | 否 | 否 | 否 | 只读 | ✅ |
| P0-3 | 否 | 否 | 否 | 否 | 事件域只读 | ✅ |
| P1-1 | 否（DEAL payload 子对象） | 否 | ✅ method-outreach-hook | 否（人审） | 第 0 闸 | ✅ |
| P1-2 | 否 | 否 | 否 | 否 | 只读 | ✅ |
| P1-3 | 否（payload.preheat） | 否 | 否（或复用） | 否（HITL） | 写前 HITL | ✅ |

---

## §7 下一步

建议按 **A 批（P0-1+P0-3）+ B 批（P0-2）** 进入 writing-plans 细化（全部只读/纯函数/配置驱动，直接映射当前 S 集团、C 医疗器械、M 涂料线索的「信号新鲜度与决策链完整」痛点）；**C/E 批**（新 SKILL、社媒依赖）列为独立后续批次，需额外批准。
