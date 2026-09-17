# CRM-ai-native 平台发明专利准备包
## 技术交底书模板 + 候选方案证据清单（含代码级锚点）

- 编制日期：2026-09-09
- 申请人（拟定）：北京青羽智行科技有限公司
- 技术领域：企业AI销售决策平台 SaaS（多智能体 + 决策引擎 + 多租户 + LLM 应用）
- 用途：本文件供**专利代理机构**直接采编为《技术交底书》初稿，也供内部评估申请角度、范围与优先级。
- 证据口径：所有 `file:line` 锚点均于 2026-09-09 对工作区代码实读核实；提交前请以"拟申请日"代码再复核行号。

---

## 0. 快速结论（执行摘要）

平台存在 **5 簇可专利技术方案**，均属《人工智能相关发明专利申请指引（试行）》（国知局 2024-12-31 发布）下的"**类型 2：基于 AI 算法/模型的功能与领域应用**"，客体风险可控，前提是权利要求**绑定技术特征**（数据流/数据结构/进程闸门/数据库操作），**不得写成纯商业规则**。

| 簇 | 主题 | 代码落地度 | 客体风险 | 建议优先级 |
|---|---|---|---|---|
| D | NL→受控 Schema→运行时渲染器的门户生成（禁 NL 直出 HTML） | 高（src/page 五件套 + 36 schema 全接线） | 低 | ★★★ 首选 |
| B | 多租户配置懒克隆与隔离（system 模板→租户实例化 + 复合主键） | 高（多表落地 + 多轮伪隔离修复） | 低（最"硬"的基础设施方案） | ★★★ 首选 |
| C | 多智能体写操作八闸管控（第 0 闸决策 + confirm_token 两阶段 + HITL 审批） | 高（executor 八闸 + gateway 两阶段全接线） | 低 | ★★ |
| A | 决策引擎：九尺子 8 确定性+1 LLM 混合裁决 + 红线优先 + decision 落库可审计 | 高（rubricScorer/autonomyEngine/decisionRepo 全落地） | 中（需强调技术效果） | ★★ |
| E | 运行时上下文分层注入 + 场景路由 + fail-open 降级链 | 高（context 全模块落地） | 中高（算法特征需与技术系统强关联） | ★ |

**三大前置风险（先解决再交代理）**：
1. **自我公开新颖性风险**：公众号 30 篇 AI 原生系列等已公开材料可能披露部分方案 → 见附录 B 自查清单。
2. **发明人必须为自然人**（AI 指引第二章），AI/系统不得署名。
3. **客体红线**：所有"发明名称/技术问题/技术方案"表述必须落在计算系统层面（见各簇已改写示范）。

---

## 1. 官方口径与申请基础

### 1.1 官方依据（已核读）

| 文件 | 来源 | 要点 |
|---|---|---|
| 软件专利申请咨询答复 | cnipa.gov.cn/jact/front/mailpubdetail.do?transactId=456754（国知局客服 2024-03-21 答复） | 发明申请文件 5 件套；专利法 2/22/25 条；五种提交方式；费用与减缴 |
| 专利申请相关事项介绍 | cnipa.gov.cn/art/2020/6/5/art_1517_92472.html | 文件排列顺序、格式、受理/申请日、费用、保密审查、PCT |
| 《人工智能相关发明专利申请指引(试行)》 | 国知局 2024-12-31 发布，现行有效 | 四类 AI 申请；发明人须自然人；客体两步判断（25 条智力规则 → 2 条技术方案）；创造性中算法特征的技术贡献；说明书充分公开；AI 伦理 |
| 知识产权报 2026-04-10 专版 | cnipa.gov.cn/art/2026/4/10/art_55_205670.html | 确认"计算机程序产品"为第四客体（不再限于存储介质）；AI 提升用户体验可在创造性审查中考虑 |

### 1.2 官方文件清单（发明专利）

| # | 文件 | 本平台对应内容 |
|---|---|---|
| 1 | 发明专利请求书 | 申请人/发明人（自然人）/名称/优先权 |
| 2 | 说明书 | 技术领域/背景/发明内容/具体实施方式（需充分公开：数据结构+流程+模块） |
| 3 | 权利要求书 | 独立权利要求（方法/系统/程序产品）+ 从属权利要求 |
| 4 | 说明书摘要（≤300 字） | 一句发明点 + 主要技术效果 |
| 5 | 说明书附图（必要时，本平台应提交） | 系统架构图/流程图/时序图/状态图（见各簇"附图建议"） |

标准表格下载：cnipa.gov.cn/col/col192 → 电子申请：cponline.cnipa.gov.cn（先注册）。

### 1.3 费用与流程速览

- 申请费 900 元 + 实质审查费 2500 元（发明专利）；符合条件的单位可**费减 85%**（实缴约 510 元全流程）。
- 受理（当月缴费）→ 初审 → 公布（自申请日 18 个月，可请求提前公布）→ **实审请求须 3 年内主动提出** → 审查意见 1–3 轮答复 → 授权。全周期通常 1.5–3 年。
- 若未来向外国申请：须先办**保密审查**（可随中国申请一并提出，免费）。

---

## 2. 技术交底书通用模板（每件专利一份）

> 建议每簇出 1 件交底书（共 3–5 件），从第 3 章裁剪证据 + 配图。以下字段为代理撰写专利申请文件的标准输入。

| 字段 | 填写要求 | 本清单对应章节 |
|---|---|---|
| 发明名称 | "一种……方法/系统"双主题；避免商业方法字样（如避免"销售管理方法"直称，改为"基于多智能体决策闸门的业务数据写操作方法"） | 各簇"建议发明名称" |
| 技术领域 | 一句话，落到计算机技术：如"本发明涉及多租户 SaaS 系统的数据隔离技术领域" | 各簇概述 |
| 背景技术 | 客观描述现有技术缺陷（不贬低）；突出"要解决的计算系统问题" | 各簇"技术问题" |
| 发明内容 | 三对应：要解决的技术问题 / 采用的技术手段（含技术特征）/ 达到的技术效果；**原始说明书必须写明三对应**（AI 指引 3.2.3：答复审查意见时只能依据原始记载修改） | 各簇问题/方案/效果 |
| 具体实施方式 | 数据结构定义（字段/表/复合主键）、流程步骤、模块交互、关键判定逻辑（可用伪代码或节选源码）、**失败/降级路径也要公开**（fail-open 是本平台特色，务必写） | 各簇"技术方案要点" |
| 附图说明与附图 | 架构图（模块+数据流）、流程图（步骤）、时序图（跨模块调用）、状态图（生命周期） | 各簇"附图建议" |
| 区别技术特征表 | 与最接近现有技术逐项对比，支撑创造性（算法特征与系统结构的"技术关联"是关键论点） | 各簇"区别与创造性素材" |
| 新颖性自查记录 | 检索日期/关键词/命中文献 + **自我公开材料清单**（公众号/演讲/演示/开源） | 附录 B |
| 发明人信息 | 仅自然人；对实质性特点做创造性贡献者 | — |

### 2.1 独立权利要求骨架示例（句式模板，代理定稿为准）

> 方法权利要求：一种基于 XX 的业务数据处理方法，其特征在于，包括：接收（动作触发方）发出的（动作）请求；响应于所述请求，执行（判定 A）……；在（条件 B）的情况下，执行（步骤 C）并生成（数据 D）；将（数据 D）以（结构 E）写入（数据库 F）；……从而（技术效果 G）。

> 系统/程序产品权利要求：一种……系统/计算机可读存储介质/计算机程序产品，包括处理器与存储器，所述存储器存储可执行指令，所述指令被处理器执行时实现上述方法（或：包括……模块）。

**客体写法铁律**（每件必检）：
- 权利要求中必须写入**与算法/规则关联的技术特征**（不止出现在主题名称）——如"数据库复合主键""决策记录表含决策标识列""定时器与超时阈值""向量相似度查询与权重重分配"。
- 技术效果用系统语言量化：数据一致性、并发幂等、防注入、可审计、降级可用、重跑确定性，而非"提升销售额/管理效率"。
- 可同时布局**方法 + 系统 + 计算机程序产品**（2026 年已确认程序产品为独立客体，不再限于存储介质）。

---

## 3. 候选方案证据清单

### 3.D 候选一：NL→受控 Schema→运行时渲染器的门户页面生成（建议首选）

**概述**：用户自然语言/智能体意图**不直接生成 HTML**，而是经三层护栏与确定性解析映射为受控 JSON Schema（16 种受控组件 + 粒子类型枚举 + Action 白名单 + 权威导航枚举），再由**唯一运行时渲染出口**渲染（动态值强制转义、交互仅 data-action 声明式、输出后 script 剔除）。AI 生成页与人工配置页（36 个受控 schema S01–S36）共用同一渲染器。代码落地度最高，客体风险最低，是本项目最强可专利点。

- 建议发明名称：
  - 方法：*一种基于受控模式声明的自然语言页面生成方法及装置*
  - 备选：*一种禁止直接生成可执行标记的智能页面渲染方法*
- 技术问题（技术性表述）：现有 NL→页面方案直接产出 HTML/前端代码，存在（1）不可信 NL 注入可执行内容的安全风险；（2）页面结构与数据源不受控，生成结果越界访问未授权粒子/动作；（3）AI 生成页与人工配置页两套渲染路径，行为不一致、维护成本高。
- 技术方案要点（锚点）：

| 机制 | 说明 | 代码锚点 |
|---|---|---|
| 输入护栏（三层护栏①） | 正则拦截 `<script>`/`javascript:`/`on*=`/`eval(` 等注入模式，safe=false 必须拒绝 | `src/page/guardrails.js:5-22`；`src/page/pageStore.js:14-16` |
| NL→Schema 确定性解析（非 LLM、绝不产 HTML） | 意图关键词→页面类型、实体词→粒子类型、指标词→聚合、阈值→highlight、动作词→按钮；缺实体早退 needsClarification；输出 `{schema, confidence, needsClarification}` | `src/page/nlParser.js:10-107`（83-105 组装 schema；1-2 文件头声明"绝不产出 HTML"） |
| 受控值域协议 | PAGE_TYPES 6 种 / COMPONENT_KINDS 16 种 / PARTICLE_TYPES_ENUM（对齐 particleModel）/ ACTION_WHITELIST / CANONICAL_NAV 权威导航 | `src/page/schema.js:6-102` |
| 4 粒子护栏校验 | ①粒子值域越界直接拒（非静默映射）②状态字段仅 eq 禁聚合 ③存量快照仅 latest ④Action 白名单 + navigation 强制 | `src/page/validator.js:12-152`（护栏 101-134） |
| 唯一渲染出口 | renderPage 渲染前复校验；按 comp.kind 分派 16 组件；动态值 escapeHtml；交互仅 data-action；输出后 script 命中即剔除；loading/empty/error/partial 四态 | `src/page/renderer.js:474-514`（507-512 script 剔除）、`93-100` escapeHtml、`287-294` data-action、`270-285` 来源徽标 |
| 生命周期与注册表 | NL 页 draft→publish→revert（内存）；36 个受控 schema registerPage 注册即强校验；同一渲染器服务 AI 页与人配页 | `src/page/pageStore.js:13-78`；`src/pages/registry.js:9-22`；`src/http/pageMarketRouter.js:1-63`；消费例 `src/http/routes.js:1032`（/api/page/home） |
| HTTP 接线 | POST /api/page/from-nl → 五步链 → publish/preview | `src/http/routes.js:2143/2162/2168` |

- 技术效果（量化素材）：渲染输出恒为转义后字符串（无内联可执行代码）；16 组件/6 类型/粒子枚举三重值域收敛，越界输入在解析/校验层即拒；AI 生成页与人配页共用单渲染器，行为单一事实源。
- 区别与创造性素材：与"NL 直出代码/HTML"方案的区别 = 三层护栏 + 受控值域 + 单一渲染出口 + 与底层粒子数据模型（含数据来源四查徽标、决策闭环数据）的类型化绑定。可引用设计文档铁律"§0 严禁 NL 直出 HTML"。
- 附图建议：图 1 三段式管道架构图（NL→护栏→解析→Schema→校验→渲染→页面市场）；图 2 NL→Schema 字段映射流程图；图 3 单页渲染时序（请求→数据聚合→renderPage 四态）。
- 撰写警示：
  - 现状：NL 页面存内存 Map，**未落 PostgreSQL**；如把"页面持久化 + 租户级"加入方案，需先实现，或只写已落地内容。
  - 现状：web 端 `src/web/*.html` 静态页通过 `/api/page/*` JSON 消费；"web=Vue3" 是文档规划非现状——**勿写入实施方式**。
  - "死区"审计方法论在设计/skill 文档层，代码层只有空态诚实返回——不要写成已实现的独立检测模块。
- 设计文档：`docs/2026-08-25-08-ai-portal-page-generation.md`（核心，三层护栏/三段式/Schema 协议）、`docs/2026-08-26-frontend-config-pages-master-blueprint.md`（36 面 S01–S36）、`docs/2026-08-25-portal-page-generation-design.md`（生命周期）。

---

### 3.B 候选二：多租户配置懒克隆与隔离（system 模板→租户实例化 + 复合主键）

**概述**：以 system 平台租户为模板源，新租户注册即播种差异化键起点；运行期**读时/首写时懒实例化**——租户缺配置/缺业务规则行时，从 system 模板幂等复制出**自有副本**（`_seeded` 审计标记 / `ON CONFLICT … DO NOTHING`），此后完全自持、可二次分化；承载表用**含 tenant_id 的复合主键**在 DB 层物理吸收两租户同自然键冲突；Repo 层再叠加 F1 运行时校验（`cross_tenant_write_denied`）。多轮"伪隔离"缺陷（业务分级/审批流/告警规则/决策场景从无租户维度到通电）为此方案提供了完整修复史，是创造性论证的实证素材。

- 建议发明名称：
  - 方法：*一种多租户系统的配置懒实例化方法、装置及存储介质*
  - 备选：*一种基于复合主键与模板回填的多租户数据隔离方法*
- 技术问题（技术性表述）：多租户系统配置类数据存在（1）租户行缺失时运行时回退共享模板造成"伪隔离/串扰"（改 system 影响所有租户）；（2）同自然键跨租户写冲突缺少 DB 层物理防线；（3）新建租户全量预置成本高、且模板演化难以传导。核心技术挑战 = 隔离性、幂等性、演化传导三者权衡。
- 技术方案要点（锚点）：

| 机制 | 说明 | 代码锚点 |
|---|---|---|
| 租户作用域透传 | 登录把 tenant_id 封入 JWT；resolveMe→scopeTenant/scopeOf 换算读写作用域（admin 读通配 '*'、写恒自身租户）；显式传给所有 DAO | `src/http/auth.js:53,57-66`；`src/http/tenantScope.js:4-24`；`src/http/configRouter.js:67-68,97,147` |
| config 读时 autoSeed 懒克隆 | readConfig 先查 (tenantId,key)，缺→深拷贝 (system,key) + `_seeded:'system-template'` 标记 → `INSERT … ON CONFLICT (tenant_id,key) DO NOTHING`；WILDCARD '*' 禁 autoSeed 防污染 | `src/config/configStore.js:15-48`（15-41 主逻辑；9/13-14 防 '*' 注释）；写侧 upsert 禁删 51-59 |
| 开通播种 | createTenant → seedTenantDefaults（8 差异化键起点，from system） | `src/http/tenantRouter.js:24-41,74-91`；`db/seed/tenantDefaults.js:16-20,37-73` |
| 复合主键物理隔离 | business_tier_config PK (tenant_id,dimension,dimension_value)；meta_attr PK (particle_type,attr_slug,tenant_id)；config_store PK (tenant_id,key)；alert_rule PK (kind,tenant_id)；decision_scenario PK (scenario_id,tenant_id) | `db/schema.sql:253,406,429`；`db/schema.sql:13`（particles tenant_id）；迁移：`db/migrate-tenant.js:18-23`、`db/migration-meta-attr-tenant-pk.sql`、`db/migration-alert-tenant.sql`、`db/migration-business-tier-tenant.sql`、`db/migration-decision-scenario-tenant-pk.sql`、`db/migrations/2026-09-03-tenant-isolation.sql` |
| Repo 层 F1 运行时防御 | updateParticle 目标租户≠调用租户抛 cross_tenant_write_denied；createEdge 源粒子租户须一致 | `src/particles/particleRepo.js:190-197,263-274` |
| 元模型读合并 + 写时注册 | meta_attr 读 `tenant_id=ANY([租户,'system'])` 覆盖合并（自有优先）；写钩子 ensureAdaptiveRegistration 按租户登记；ON CONFLICT DB 消竞态 | `src/metaAttr/metaAttrRepo.js:55-93,118-147,127-142` |
| 业务规则表首访懒克隆（四类同构模式） | 业务分级 list 空则 ensureTenantBusinessTiers；审批流 getFlowByDomainWithFallback→cloneSystemFlowToTenant；告警规则首写 INSERT…SELECT system 模板；决策场景 list 读租户∪system 自有优先 + 首写复制 | `src/portal/businessTier.js:47-60,79-99`；`src/approval/flow.js:75-101`；`src/portal/alertRuleConfig.js:90-112`；`src/alerts/alertRegistry.js:145-163,200-223`；`src/portal/decisionScenario.js:165-174,192-202` |
| 全链路后台巡检 | timers 按 listActiveTenants 逐租户读自身配置/扫自身粒子，确保告警归属正确 | `src/scheduler/timers.js:185-221` |

- 技术效果（量化素材）：同自然键两租户各占一行（复合 PK 不冲突）；autoSeed 幂等（并发首读不重复落行）；`_seeded` 标记使"模板继承态 vs 自定制态"可审计；伪隔离修复有 50 用例/E2E 落库审计实证（phase1 隔离文档）；system 仅作模板源、不再运行时回退（消除"改一处影响所有租户"）。
- 区别与创造性素材：与"每租户全量预置"的区别 = **懒实例化 + 幂等 + 审计标记**；与"运行时回退共享模板"的区别 = **落自有副本、此后不共享**；DB 层复合主键 + Repo 层 F1 的**双防线纵深**；"模板继承态可审计可回退、自持后可分化"的租户数据生命周期。
- 附图建议：图 1 三态读取决策流程图（命中自有→autoSeed→回退模板）；图 2 复合主键 vs 自然键冲突对比示意；图 3 租户开通→首读懒克隆→自持分化生命周期图。
- 撰写警示：**七维评分**无独立表——其隔离在 decision_scenario 复合 PK 与 config_store['seven-dim'] 租户级读（`src/calibration/knobs/sevenDimConfigStrategy.js` 写侧部分仍落 system，标注 id15）；表述用"消费读按租户 + 承载表复合 PK 化"，勿声称七维全链路已租户化。审批流是粒子形态（天然带 tenant_id），无 DDL 迁移，修复点是写/单查 scopeOf 透传 + 提交侧懒克隆（`docs/2026-09-06-phase1-tenant-isolation.md` 1.1）。
- 设计文档：`docs/2026-08-31-multi-tenant-design.md`（伪单租户审计）、`docs/2026-09-05-tenant-config-full-isolation-design.md`（G1 完全独立不共享）、`docs/2026-09-06-phase1-tenant-isolation.md`（审批流/业务分级修复闭环）、`docs/2026-09-03-config-center-tenant-isolation-design.md`、`docs/2026-09-03-tenant-master-data-seeding-design.md`。

---

### 3.C 候选三：多智能体写操作八闸管控（第 0 闸决策 + confirm_token 两阶段 + HITL 审批）

**概述**：所有可执行动作集中注册（Action Registry，声明 kind/风险/mcpExpose/decisionScenario），写通道执行前过**八道闸**：第 0 闸"无决策不写"（write 必须携带 decision_id，fail-closed，autoDecision 通道先经自主引擎 mint）；第 1/1.5/1.7 闸数据范围/角色 RBAC/套餐权益；第 2.5 闸**字段级 RBAC**（逐 patch 键核 meta_attr.permission）；第 2 闸 force + 对话白名单；第 3 闸 HITL（needsApproval 须 ctx.approvalPassed）；第 3.5/3.6 闸阶段/要素校验。外部 MCP 写通道另走 **phase1 冻结入参→签发一次性 confirm_token→phase2 只增补禁覆盖**的两阶段确认，防"确认 A 执行 B"。审批引擎有完整状态机（ANY/ALL/SEQUENTIAL + 条件路由），并曾根治"AUTO_PASS 架空审批规则"缺陷（判定顺序重排 + approvers 透传 + requireFullChain fail-closed）。

- 建议发明名称：
  - 方法：*一种多智能体系统写操作的分级闸控方法、装置及存储介质*
  - 备选：*一种基于决策标识与两阶段确认令牌的智能体写操作安全执行方法*
- 技术问题（技术性表述）：多智能体/外部 MCP 通道直接调用写能力时存在（1）无决策依据的任意写（数据污染与越权）；（2）确认环节"确认 A、执行 B"的重放/篡改风险；（3）授权粒度粗（动作级而非字段级）；（4）审批规则可被运行态数据架空（AUTO_PASS 泛滥）导致 HITL 失效。核心 = 智能体写操作的可控性、一致性与可审计性。
- 技术方案要点（锚点）：

| 机制 | 说明 | 代码锚点 |
|---|---|---|
| Action Registry 集中注册 | 统一声明 kind/needsApproval/force/mcpExpose/decisionScenario/lifecycle；反 CRUD 爆炸护栏 | `src/action/registry.js:6-21,58-91`；实例 `src/action/seed-actions.js:71-81`(create)、`558-577`(update)、`958`(quote-submit)、`976`(quote-activate needsApproval) |
| 第 0 闸无决策不写 | dispatch 判 `kind==='write' && !decision_id && !bootstrap && !autoDecision` → gate decision_required（阻断时附建议卡）；autoDecision 统一 mint 回填 | `src/action/executor.js:46-73`（49-60 阻断、64-73 mint） |
| 闸链分层 | 第1数据范围 76-88；第1.5 角色 RBAC 92-98；第1.7 套餐 99-126；**第2.5 字段级 RBAC 127-138**（`checkPatchPermissions`，纯函数 `src/metaAttr/fieldPermission.js:6-31`）；第2 force+白名单 139-151；第3 HITL 152-158；第3.5/3.6 159-194；audit 195-231 | `src/action/executor.js`（同行号） |
| MCP 两阶段 confirm | phase1 冻结入参→issueSession 签发一次性 confirm_token（TTL 10min）→phase2 校验一次性消费 + mergePhase2Params **只增补禁覆盖**（hash 冲突 gate confirm_params_conflict）；choice 角色切换过 rbac_roles | `src/mcp/gateway.js:16`(confirmSessions Map)、`:111-135`(issueSession/buildConfirmForm)、`:31-41`(mergePhase2Params)、`:254-290`(mcpConfirmPhase2)；入口 `src/mcp/server.js:39-54` |
| MCP 通道代 mint 决策 | def.decisionScenario 且未带 decision_id → gateway 先 requireDecision 回填；失败留痕退回 DECISION_NEEDED | `src/mcp/gateway.js:161-211` |
| 自主决策引擎 | requireDecision：策略版本冻结→业务分级→证据加载→方法论评分/先例/置信度（阈值 0.7 可校准）→ AUTONOMOUS 放行 / ESCALATED 升级人工 | `src/decision/autonomyEngine.js:115-337`（115 入口、127-139 冻结、203-261 评分、270-336 分级落库） |
| HITL 审批状态机 | startInstance 路由/物化/生成 TODO；advanceTask ANY/ALL/SEQUENTIAL；条件边路由；状态机 OPERATIONS_BY_STATE | `src/approval/engine.js:157-212,216-251,378-418`；`src/approval/stateMachine.js:15-29`；`src/approval/ruleResolver.js:18-66` |
| AUTO_PASS 架空根治 | resolveApprovers 判定顺序：显式 approvers→ROLE/SPECIFIC_PERSON→才 empty_approver_action 兜底；requireFullChain fail-closed；approvers 数组透传 | `src/approval/engine.js:70-103`（70-97 重排、101-103 兜底、178-182 full chain）、`:115-133`；`src/action/seed-actions.js:1270-1290`；`src/approval/approvalConfig.js:41,72-80` |
| 协议级参数防剥离 | protocolShape 显式声明 confirm_token/choice/decision_id/api_token/utterance/force 防 SDK 按业务 schema strip | `src/mcp/tools.js:62-76`（55-59 历史假阴性注）、`:94` isExposedWrite、`:45` lifecycle 隐藏 |
| 审批后放行活样例 | 外部写通道以 admin/sysadmin 端点显式触发 + approvalPassed:true 放行 needsApproval 写；报价激活器 draft→approved + requireDecisionId | `src/http/connectorRouter.js:22-33`；`src/sales/quoteService.js:71-85` |

- 技术效果（量化素材）：一切写必有 decision_id（无决策不写，fail-closed）；confirm_token 一次性 + TTL 10min + 参数 hash 冲突拒（防重放/防篡改）；修复后生产 63 条审批规则全部解析出真实审批人、AUTO_PASS 归 0（`docs/2026-09-09-approval-failure-and-write-side-fix-design.md:310-317`）；八闸固定次序使授权粒度可到"角色×字段×动作×阶段"。
- 区别与创造性素材：与"统一 API 网关鉴权"的区别 = **决策语义层**（decision_id 关联决策记录，写操作成为可审计决策链的一环）+ **动作级声明式风险元数据** + **两阶段冻结确认（参数 hash 比对）** + **审批引擎判定顺序的确定性保证（防运行态架空）**。
- 附图建议：图 1 八闸流水线图（executor dispatch 次序）；图 2 MCP 两阶段时序图（phase1 冻结→token→phase2 校验→dispatch）；图 3 审批状态机图（PENDING→APPROVING→APPROVED/REJECTED + ANY/ALL/SEQUENTIAL）。
- 撰写警示：术语"Draft Collection"与"第 N 闸"是设计层用语，**代码中无对应字面**——最接近实现是 gateway.js confirmSessions 内存 Map；专利文本建议用"待确认会话集/两阶段确认协议"。AUTO_PASS 修复前行为（engine.js:77-80 旧序）勿写入"现有技术"（未公开的自身实现不构成现有技术，但**公众号若已披露则构成**，见附录 B）。
- 设计文档：`docs/2026-09-09-approval-failure-and-write-side-fix-design.md`、`docs/2026-09-09-mcp-particle-update-expose-design.md`、`docs/2026-09-03-decision-gate-unified-mint.md`。

---

### 3.A 候选四：决策引擎——九尺子混合裁决 + 红线优先 + 决策落库可审计

**概述**：每条决策按 9 把固定顺序的尺子（清晰/准确/精确/相关/深度/广度/逻辑/重要/公平）评分，其中 **8 项为纯确定性代码判定**（保证"同一决策重跑得分一致"），仅"清晰性"在模糊词命中且 LLM 开关开启时调 LLM 精评，否则确定性代理 + degraded 留痕。自主裁决由 `requireDecision` 完成：读决策场景（租户回退 system）→ 装配先例/方法论条件 → `composeConfidence` 加权（阈值 0.7 可校准）≥ 阈 AUTONOMOUS 放行，否则 ESCALATED 升级人工。**硬红线优先**（毛利红线 margin_floor_pct 出厂 20%、配置化）：建议卡 A/B/C 三档判定中"触碰红线→B 档必须走审批"排在一切软判定之前。决策以 decision_id 落 33 列决策表（八要素 + concept_refs + 政策版本冻结 + rubric 九尺子明细），同步图库与先例关系，审计侧 4 问评分可下钻。

- 建议发明名称：
  - 方法：*一种确定性评分与生成式模型混合的决策质量评估方法及系统*
  - 备选：*一种可审计的智能体自主决策分级方法（含硬规则优先于模型软建议的裁决顺序）*
- 技术问题（技术性表述）：LLM 驱动的决策存在（1）输出不可复现（同输入重跑结果漂移），无法做质量回归；（2）输出不可审计（无结构化决策留痕与溯源）；（3）生成式模型的软建议可能越过业务硬约束（如毛利红线）；（4）决策是否需人工介入缺乏确定性判据。核心 = 决策质量的**确定性、可审计性与硬约束优先**。
- 技术方案要点（锚点）：

| 机制 | 说明 | 代码锚点 |
|---|---|---|
| 九尺子混合评分 | 8 项确定性 + 1 项 LLM（clarity 默认关）；尺度 0–4；降级纪律"无证据计 0 不假填充、LLM 不可用 degraded 不静默"；顺序固定命名铁律 | `src/decision/rubricScorer.js:2-27`（RUBRICS 17-27）、`:178-238`(scoreDecision)、`:245-261`(persistRubric 逐尺落库) |
| 场景化配置 | D 层 9 列迁移 + rubric_score 建表；rubric-thresholds/weights/llm config 键；场景行 focus_rulers×1.5 / rubric_pass_line / enabled_rulers 真子集 | `db/migrate.js:272-308`；`db/schema.sql:129` |
| 置信度自主裁决 | requireDecision：策略版本冻结→业务分级→证据加载→评分→判定 AUTONOMOUS / ESCALATED；composeConfidence weights 恒和 1.0（similarity .4/coverage .3/method .1/evidence .1/allMet .1） | `src/decision/autonomyEngine.js:115-337`；`src/decision/methodologyScoring.js`（scoreMethodology/composeConfidence 单一事实源） |
| 硬红线优先 | 建议卡档位判定顺序铁律：红线→B 档 ESCALATE 排最先（注释"勿调换顺序"）；margin_floor_pct 出厂 20% 配置化；推 margin_redline 红线项 + approval_flow 指向 | `src/decision/adviceCard.js:31-75`（31-52 顺序、64-75 红线文案）；`src/decision/scenarioAdvisors.js:4-33`；`src/decision/adviseService.js:38-63`（fail-open 降 C 档） |
| decision 落库可审计 | createDecision 落 crm.decision（UUID PK）：八要素（intent/assumptions/inference/viewpoints/implications/risk_register/stop_loss/concept_refs）+ effective_policy_version 冻结 + concept_refs 回查 methodology_dimension；33 列 INSERT RETURNING | `src/decision/decisionRepo.js:120-140`（入参）、`:212-248`（materialize 33 列）、`:304-310`(persistRubric 回写)、`:398-418`(先例关系)；`db/schema.sql:153-168` |
| 审计闭环 | 图库 :Decision 节点 MERGE + decision_precedent_rel + PROV-O；4 问共享评分 computeAudit4q/aggregateAuditability；读取端点 getDecision 下钻 | `src/decision/ageGraph.js:95-112,232-256`；`src/decision/auditability.js:43,168-192`；`src/http/routes.js:2300,2325,2661-2669` |

- 技术效果（量化素材）：8/9 尺确定性 → 同决策重跑得分一致（趋势/复合效应可比）；阈值 0.7 可经 config_store 校准；红线判定确定性优先于一切软建议；33 列决策快照 + policy_version 不可变表 → 事后可完整重建"当时为何这样判"；审计 4 问评分接口可聚合可下钻。
- 区别与创造性素材：与"单一 LLM 评估/纯规则打分"的区别 = **8 确定性 + 1 可选 LLM 的混合结构**（确定性保底 + LLM 仅精评一尺、默认关）+ **评分尺度与降级纪律**（不假填充）+ **硬红线优先于软建议的裁决顺序** + **决策快照与政策版本冻结的可审计链**。AI 指引创造性角度：算法特征与决策表/图库/策略版本表的系统结构产生技术关联。
- 附图建议：图 1 决策引擎总架构（K 上下文/M 方法论/裁决/D 落库/审计，标注代码模块名）；图 2 scoreDecision 评分流程图（逐尺→加权→level）；图 3 建议卡三档判定顺序图（红线第一优先高亮）。
- 撰写警示：
  - **术语映射（重要）**：设计/宣传层术语 "K-M-D 三层管道""LIGHT 认知决策"在代码中**无对应字面**（"LIGHT"仅 CSS 类与 Lightfield 研究文档；K-M-D 见 `docs/2026-09-02-cognitive-decision-unified-design.md` 与 `doc/# 2B销售全流程决策自检框架.txt:23`）。专利文本一律用代码实名：九尺子（rubric）/requireDecision/confidence/composeConfidence/adviceCard 三档/decision_id。
  - 报价政策断链现状：`CRM_OFFER_POLICY` 粒子已建模（margin_redline 字段），但**决策侧仍读出厂默认 20%，未接租户政策**（T1/T2 实施 `offerPolicyFacts.js`/price-authority 尚未落地）——技术方案只写已落地链路；若要把"租户政策驱动红线"写入权利要求，需先实现。
- 设计文档：`docs/2026-09-02-cognitive-decision-unified-design.md`、`docs/2026-09-04-decision-rubric-subset-design.md`、`docs/2026-09-08-dialog-driven-decision-advice-design.md`、`docs/2026-08-31-decision-auditability-4q-design.md`、`docs/2026-09-09-quote-policy-and-requirement-grading-design.md`、`docs/2026-09-02-lightfield-memory-decision-study.md`（思想来源）。

---

### 3.E 候选五：运行时上下文分层注入 + 场景路由 + fail-open 降级链

**概述**：智能体任务按场景从**可配置的场景矩阵**（config_store['context-routing']，出厂默认在代码单一事实源）解析"该注入哪些上下文轨（tracks）与维度"，`classifyScene` 按三维加权得出主轨道（图谱/叙事/双轨），**场景缺失显式 UNKNOWN、score=0 并回退全轨**；L1–L4 知识/记忆层 + 知识轨 + 叙事轨**并行检索**（每路 200ms 独立超时），任一路失败仅标 missing/degraded 聚合、不中断装配；embedding 向量组件走**三段降级链**（真模型→确定性哈希→丢弃向量分量 + 权重归一重分配），全程 emit trace 留痕；最终按 agent 平面/决策平面两种格式化器拼装为带来源标注的 prompt（决策侧还冻结 prompt_block/prompt_hash 快照落库）。注意代码口径：**层 ≠ 轨**——L1–L4 层级检索恒执行，场景矩阵管的是"轨"（是否注入叙事/图轨）。

- 建议发明名称：
  - 方法：*一种场景驱动的智能体上下文分层装配方法及降级处理方法*
  - 备选：*一种多轨上下文注入与向量检索降级的智能体问答方法*
- 技术问题（技术性表述）：LLM 应用的上下文工程存在（1）上下文注入缺乏场景化取舍，全量注入造成 token 开销与信噪比问题；（2）向量检索/embedding 等易失组件故障会**断链中断**整个任务；（3）上下文装配不可审计（无法确认"该注入的为何没注入/降级了哪层"）。核心 = 上下文装配的**选择性、韧性与可解释性**。
- 技术方案要点（锚点）：

| 机制 | 说明 | 代码锚点 |
|---|---|---|
| 场景→轨矩阵（可配置） | DEFAULT_SCENE_MATRIX 约 25 场景键，每项 {dims,tracks}；tracks 值域 narrative/graph_decision/graph_entity/structured；出厂默认 config_store 可覆盖，异常回退 structuredClone 默认 | `src/context/routing.js:42-98`（矩阵）、`:103-123`（loadRouting、112 读 config、114-121 异常兜底）、`:19`(TRACKS) |
| 场景评分分类 | 三维（goal .4/event_mix .3/time_sensitivity .3）加权 score；≥.6 图谱 / ≤.4 叙事 / 其间双轨；**场景缺失=UNKNOWN score=0 不抛错** | `src/context/routing.js:141-156`（145 显式 UNKNOWN）、`:127-139`(mapValue)、`:101`(阈值) |
| resolveTracks fail-open 全轨 | 装配器只消费 {tracks,L,mode,score}；场景行缺失/配置损坏→tracks 回退全集、L 回退 L1-L4，绝不阻断 | `src/context/routing.js:160-171`（166-167 兜底）；调用点 `src/context/assembler.js:259-262`（261 resolveTracks、262 catch 注）、`src/context/assembleContextV2.js:272-279`（决策主路径，276-278 失败 emit trace + routing=null）、`:294` wantNarrative 兜底 |
| 逐层并行检索 + 超时降级 | L1-L4 + L-Knowledge + 叙事五路（各 200ms 独立超时 withTimeout）；任一层抛错仅记 missing.X 并置 bundle.degraded，下层照常 | `src/context/assembler.js:13`(200ms)、`:42-47`(withTimeout)、`:234-250`(逐层 try/catch)、`:318-325`(bundle.degraded/missing 聚合)；V2 `assembleContextV2.js:23,32-49`(runOp timeout/degraded)、`:300,310`(并行聚合) |
| L1 检索双保险 | pgvector `<=>` 语义检索 + 查询含实体名时 title/name 精确归位兜底 | `src/context/assembler.js:71-99`（82-94 精确兜底、76 scope 容错） |
| embedding 三段降级 | embedText：EMBEDDING_PROVIDER==='model' 才试真模型；异常→hashVector(384 维确定性)；searchPrecedents 中 qvec.provider≠MODEL 则 dropVector + normalizeWeights 权重重分配 | `src/ontology/embedding.js:39-53`（46-49 trace、52 回退）、`:8-17`(hashVector)；`src/decision/decisionRepo.js:504-573`（530-537 主逻辑）；`src/knowledge/embed.js:23-52`；`src/llm/client.js:190-194`(makeThink degraded)、agentLoop `src/agent/agentLoop.js:12-29` |
| prompt 组装可解释 | agent 平面 formatForPrompt 拼【上下文】块（角色/知识/历史决策/记忆/WHEN 时间线/路由摘要/降级警示）；决策平面 formatForPromptV2 四段（事实/故事线/治理边界/相似先例）带 [source:]；决策侧 freezePreContext 冻结 prompt_block/prompt_hash 快照 | `src/context/injector.js:26-85`（83 降级警示）；`src/context/assembleContextV2.js:150-177`、`:188-240`(freezePreContext 落 crm.decision_context_snapshot) |

- 技术效果（量化素材）：单路 200ms 超时隔离，最坏情况下单层降级不中断任务；场景缺失/配置损坏回退全轨（安全默认）；embedding 故障从真模型→哈希→丢向量分量三级退避 + 权重归一，向量相似度只在真 provider 时计入（避免伪相似污染）；degraded/missing/unavailable_reason 三态留痕可审计（区分"路由排除"与"检索失败"，不静默吞错）。
- 区别与创造性素材：与"固定 prompt 模板拼接"的区别 = **场景矩阵驱动的轨选择（可配置、出厂默认单一事实源）+ 显式 UNKNOWN 兜底 + 分层超时降级 + embedding 三段退避 + prompt 快照冻结**。AI 指引创造性角度：上下文检索/向量降级算法特征与决策快照表、config_store 系统结构产生技术关联。
- 附图建议：图 1 场景→轨选择流程图（classifyScene 分档 + UNKNOWN 兜底）；图 2 五路并行检索与超时降级图；图 3 embedding 三段降级链状态图。
- 撰写警示：
  - **层 ≠ 轨**：代码中 L1–L4 层级检索恒执行，场景矩阵管 tracks——专利表述沿用代码口径（"层级检索恒执行 + 轨选择性注入"），勿写"场景剪枝层级"。
  - 行号修正：装配器内 resolveTracks 调用在 `assembler.js:259-262`（非 177；`routing.js:39` 注释中的 177 是过期引用）。
- 设计文档：`docs/2026-08-25-04-ai-context-layering.md`（L1–L4 本体 + §1.5 降级链）、`docs/2026-09-01-story-graph-fusion-design.md`（routing 源）、`docs/2026-09-01-decision-accountability-unified-design.md`（7×7 S1-S7 + 快照）、`docs/2026-09-03-tenant-knowledge-design.md`、`docs/2026-09-05-context-routing-adaptive-loop-design.md`。

---

## 4. 申请策略与行动清单

### 4.1 批量策略建议

| 批次 | 方案 | 理由 |
|---|---|---|
| 第 1 批（2 件，立即） | D（NL→Schema 受控渲染）+ B（租户懒克隆隔离） | 客体最稳、代码落地最完整、附图好画；B 为基础设施方案不受 AI 审查波动影响 |
| 第 2 批（2 件，1–2 月内） | C（写操作八闸）+ A（九尺子决策引擎） | 需代理打磨"技术特征绑定"；A 注意术语实名化 |
| 第 3 批（可选） | E（上下文分层降级） | 创造性论证依赖与系统结构的技术关联，审查不确定性最高，可等前批授权经验再定 |

### 4.2 内部行动清单（按序）

1. **自我公开自查（本周）**：对照附录 B 关键词检索全部公众号文章/PPT/演示/开源材料，凡已公开披露的机制从权利要求剥离或限定到未公开的实现细节。
2. **发明人确定**：列出各方案做出创造性贡献的自然人（含对实质性特点的贡献），AI/系统不得署名。
3. **交底书拆件**：每批各方案从第 3 章裁证据 + 按第 2 章模板补"具体实施方式"与附图草稿。
4. **初步检索**：建议委托代理做新颖性/创造性检索；可先用关键词自查（CNIPA/Google Patents）："自然语言 页面生成 schema 渲染 注入"、"多租户 懒加载 配置 模板 隔离"、"智能体 写操作 审批 决策"、"LLM 决策 确定性 评分 审计"、"上下文 注入 分层 降级 LLM"。
5. **费用备案**：申请费减备案（若符合小微企业），实缴约 510 元/件全流程。
6. **时间窗**：发明 18 个月公布倒计时 + 公众号已公开内容剥离，越早提交越有利。

---

## 附录 A：术语对照（设计/宣传层 → 代码实名）

| 设计/宣传术语 | 代码实名 | 说明 |
|---|---|---|
| K-M-D 三层决策管道 | context/（K）+ methodology*/decision 评分（M）+ decisionRepo/decision 表（D） | 代码无 K-M-D 字面；专利用模块级描述 |
| LIGHT 认知决策 | rubricScorer（九尺子）+ autonomyEngine（requireDecision） | LIGHT 仅 CSS 类/Lightfield 研究文档；勿在专利中使用 |
| 九尺子 | RUBRICS（clarity…fairness 9 项，8 确定性+1 LLM） | 代码实名可用 |
| Draft Collection | confirmSessions（Map）+ issueSession | 内存级待确认会话集，非 DB 草稿 |
| 第 0 闸 / 八闸 | executor.dispatch 内判定序列 | 专利建议用"写操作分级闸控" |
| 决策闸门/第 0 闸深度防御 | particles.decision_id 列（FK） | `db/migrate.js:96-101` |
| 场景→L1–L4 层剪枝 | 场景矩阵只选 tracks（层恒执行） | 见 3.E 警示 |
| 死区治理/审计 | 渲染四态 + degraded/missing/unavailable_reason | 代码无独立"死区检测"模块 |

## 附录 B：自我公开新颖性自查清单

> 依据专利法 24 条：**自行发表不属宽限情形**，凡在申请日前为公众所知的披露即构成现有技术。已公开渠道（自查对象）：公众号系列文章（AI 原生系列等）、对外 PPT/PDF（doc/ 内 sales-platform 各版本）、演示录屏、开源仓库、行业分享。

| 关键词（对全部公开材料全文检索） | 命中后处理 |
|---|---|
| 决策管道 / K-M-D / LIGHT / 九尺子 / rubric / 决策闸门 / decision_id / 红线 / 毛利率 | 若已披露"评分结构/裁决顺序"→ 从权利要求剥离或仅主张未公开的实现细节（33 列结构、策略版本冻结表、审计 4 问聚合） |
| 懒克隆 / autoSeed / 模板 / 复合主键 / 租户隔离 / _seeded | 若已披露"读时复制"概念→ 主张具体技术手段（ON CONFLICT 幂等落行、复合 PK 物理防串扰、F1 校验、作用域透传链） |
| 审批 / AUTO_PASS / confirm / 令牌 / 两阶段 / 八闸 / 写操作 | 若已披露闸概念→ 主张参数 hash 冲突拒绝、一次性 TTL、判定顺序确定性保证、字段级 RBAC |
| NL 生成页面 / 渲染器 / schema / 注入 | 若已披露"不用 NL 直出 HTML"口号→ 主张 16 受控组件枚举、4 粒子护栏判定、唯一渲染出口 + 转义 + script 剔除纵深 |
| 上下文分层 / L1-L4 / 降级 / fail-open / embedding | 若已披露分层概念→ 主张场景矩阵可配置 + UNKNOWN 全轨兜底 + 200ms 超时隔离 + 三段 embedding 退避 + prompt 快照冻结 |

**豁免注意**：他人在申请日前**未经申请人同意**泄露的（专利法 24 条(3)）有 6 个月宽限——需证据支撑，不默认适用。

## 附录 C：官方依据链接

1. 软件专利申请咨询答复（国知局客服 2024-03-21）：`https://www.cnipa.gov.cn/jact/front/mailpubdetail.do?transactId=456754&sysid=6`
2. 专利申请相关事项介绍（2020-06-05）：`https://www.cnipa.gov.cn/art/2020/6/5/art_1517_92472.html`
3. 专利业务办理系统（电子申请）：`https://cponline.cnipa.gov.cn/`
4. 申请表格下载：`https://www.cnipa.gov.cn/col/col192/index.html`
5. 标准表格与办事指南 PDF：`https://www.cnipa.gov.cn/attach/0/0caf8492459846d98f3859ab05225df7.pdf`
6. 代理机构名录：`http://dlgl.cnipa.gov.cn/txnqueryAgencyOrg.do`
7. 《人工智能相关发明专利申请指引(试行)》（国知局 2024-12-31）：官网检索"人工智能相关发明专利申请指引"
8. 知识产权报 2026-04-10《为加快发展新质生产力夯实制度根基》：`https://www.cnipa.gov.cn/art/2026/4/10/art_55_205670.html`

---

*本文件为内部专利准备材料，证据锚点截至 2026-09-09 代码版本；权利要求最终文本须由专利代理机构撰写定稿。*
