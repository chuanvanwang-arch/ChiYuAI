# ATTIO 与 Lightfield 深度学习 + product-catalog 租户字段核查

> 整理时间：2026-09-03（二轮补强：新增 14 篇 Lightfield 官方博客一手原文研读 + ATTIO 属性类型分布实证 + record-id 三元组租户实证）
> 目的：① 深度学习两个 AI 原生 CRM 标杆（ATTIO 柔性数据底座 / Lightfield 客户记忆世界模型）；② 回应 `product-catalog.html` 是否缺租户字段的疑问；③ 将二者方法论映射回 CRM-ai-native，标识已对齐项与待补项。
> 资料来源：本地 `D:\浪潮-交付文件\02 26年乙方经历\other\典型客户\reference\attio_extract\`（架构规范 TXT / 三种路径 MD / 真实抽取 JSON+CSV）；Lightfield 官方博客 `https://lightfield.app/blog`（14 篇逐篇研读，详见 `docs/2026-09-03-lightfield-blog-digest.md`）。

---

## 一、product-catalog.html 租户字段核查（结论先行）

**结论：前端确实没有租户字段；但后端多租户隔离已端到端实现。真正的缺口是"共享主数据 vs 每租户自有目录"的取舍未定，导致非 admin 租户用户看到空目录。**

### 证据链

| 层 | 现象 | 证据 |
|---|---|---|
| 前端列表列 | 无租户列 | `src/portal/productCatalogRender.js:35-50`：列＝名称/单位/品类/目录价/状态/操作 |
| 前端表单字段 | 无租户输入 | `PRODUCT_FIELDS=['name','unit','category','list_price','status']`（`productCatalogRender.js:5`）；表单 `renderProductForm()` 仅这 5 个输入 |
| 前端拉取 | URL 不带租户参数 | `product-catalog.html:39` → `fetch('/api/particles?type=CRM_PRODUCT')` |
| 表结构 | 有租户列 | `db/schema.sql:13`：`tenant_id TEXT NOT NULL DEFAULT 'system'` |
| 读接口 | 按 token 派生租户 | `routes.js:424`：`queryParticles({ type, tenantId: scopeTenant(me) })` |
| 写接口 | 强制写自身租户 | `routes.js:487`：`ctx={ tenantId: scopeOf(me), ... }`（`scopeOf` 永不返回 `'*'`） |
| 仓库过滤 | SQL 带 tenant_id 条件 | `particleRepo.js:169`：`WHERE tenant_id=$1 AND ($2::text IS NULL OR type=$2)` |
| 种子数据 | 全落 `system` 共享租户 | `seed-master-data.sql:17-53`：12 条 CRM_PRODUCT 均 `tenant_id='system'` |

### 真实缺口与决策点

- 多租户隔离在**架构层已成立**：租户 X 登录后建产品 → 写 `tenant_id=X`，且只读得到 X 的产品。
- 但种子产品目录在 `system`（平台级）。`scopeTenant` 规则：admin/sysadmin → `'*'`（跨租户通配）；普通用户 → 自身 `tenantId`（回退 `system`）。
  - 后果：当真实租户用户（如 `acme-chem`）登录，`GET /api/particles` 过滤 `tenant_id='acme-chem'` → **目录为空**；仅 admin 能看到 `system` 产品。
- 这是"产品目录是共享主数据（所有租户可见同一份）还是每租户自有（各自维护）"的**产品决策**，不是代码缺陷。
- 补充判断：admin/sysadmin 角色（`scopeTenant` 返回 `'*'`）仍能看到 `system` 种子产品，因此**平台自身使用不受影响**；受影响的是普通租户用户（如 `acme-insmedi` 的 `insmedi_sales01` 等销售角色）——他们按自身租户过滤后目录为空。这与"行业差异化 100% 后台配置化"主线一致，是**待定的产品决策**。
- 两种修法：
  - **方案 A（共享主数据）**：主数据类型（CRM_PRODUCT 等）查询时 `tenant_id IN (自身租户, 'system')`，`system` 作为平台模板对所有租户可见、可继承覆盖。
  - **方案 B（每租户自有）**：按租户分别 seed 产品；租户用户只能看到本租户创建的产品（当前架构的天然行为，无需改查询，但需补种子）。
- ⚠️ 若你原话"按**租房**分开"指的是**业务线/产品线分类**（如租赁产品线）而非多租户，那是 `payload.category` 之外的另一个语义字段，属数据建模问题，可另案处理。

---

## 二、ATTIO 深度学习（柔性数据底座范式）

### 2.1 定位与六大 AI 原生强制准则（内核固化不可改）
ATTIO Core 是"面向 AI 代理时代的柔性可编程数据底座"，与传统 Salesforce/HubSpot 固化对象 CRM 根本不同。**六大准则**（来自《Attio Core V1.5 内部涉密规范》，作方向性参考，文档自述"全网无原版公开、部分 AI 生成"）：
1. **全域实时原生摄入**：邮箱/日历/SaaS/IoT 无代码实时同步，自动去重归一，杜绝手动 Excel。
2. **粒子化柔性数据底座**：所有业务数据基于 Particle 单元，无固定表结构，实体/属性/关系运行时动态变更。
3. **Universal Context 原生语义层**：内置全局上下文向量索引，为 AI Agent 提供统一可检索、可推理的业务语义视图。
4. **图-关系混合计算原生支持**：事务走关系引擎，复杂关系推理走图引擎，底层自动路由。
5. **AI 代理原生沙箱隔离**：每类 Agent 独立读写权限、上下文可见范围、算力配额。
6. **端到端智能工作流**：基于数据上下文驱动跨系统全链路自动化，支持人机协同复核。

### 2.2 四层全域物理架构
- **L1 摄入平面**：三源（原生协同 / 第三方 SaaS CDC / 自定义事件流）+ 流式归一化（清洗→轻量 NLP→粒子封装）+ 写入硬约束（仅摄入引擎/Universal Context/AI Agent 运行时可写，前端人工界面禁直改粒子元数据）。
- **L2 混合存储平面**（四介质物理隔离、自动路由）：①原始事件日志层（不可篡改，7 年冷归档）；②Particle 粒子主仓（关系型，ACID，唯一业务数据源）；③关系知识图层（图引擎，<50ms 复杂链路）；④AI 向量样本集市（语义检索，算力隔离）。
- **L3 认知计算平面**：Universal Context 引擎（全文+向量+规则推理）+ 混合算力自动路由（事务→关系仓 / 链路→图仓 / 语义→向量）+ 多租户与 Agent 鉴权子系统。
- **L4 执行应用平面**：Ask Attio Agent 编排器 + 双轨工作流引擎 + 全域 API 网关（强制报文带粒子元数据）+ 无代码层（表格/看板/Cmd+K，仅读粒子主仓）。

> 分水岭：人工前端**只读**，所有变更生成不可篡改审计日志——这是"AI 原生"与"外挂 AI 插件"的本质区别（插件模式人工可直接改表）。

### 2.3 Particle 柔性数据模型（三类单元 + 硬性约束）
- **Particle（实体载体）**：等效传统行/记录；预置 3 标准粒子 `People / Companies / Deals`，其余全自定义（基金、项目、候选人、资产）。
- **Attribute（字段）**：四类——基础（文本/数字/日期/枚举/布尔）、关联（绑定其他粒子）、计算（实时聚合如总交易额）、**语义**（Universal Context 自动生成的向量标签/意向评分/关系强度）。
- **Relationship（关系边）**：有向/无向，1-1 / 1-多 / 多-多。
- **硬性约束**：禁底层直接建固化表；语义属性仅 Universal Context 写入、前端禁手动编辑；跨粒子关联全局唯一（禁重复同源边）；粒子软删除、原始日志永久留存。

### 2.4 Universal Context 三层语义内核
- 底层 粒子语义映射层（自动抓属性/关联/历史事件→结构化语义元数据，无人工干预）
- 中层 向量索引检索层（业务文本/沟通记录/项目描述→向量嵌入，语义模糊检索 <20ms）
- 上层 代理推理上下文层（为 Agent 裁剪专属可见上下文，过滤无权限数据，防泄露与上下文过载）
- 四项能力：自动关系洞察（关系强度/意向/风险）、全域全文检索、上下文权限裁剪、增量实时更新（变更后向量实时刷新，免全量重训）。

### 2.5 图-关系混合存储（性能分工）
| 引擎 | 承载负载 | 核心能力 | 指标 |
|---|---|---|---|
| 关系型粒子主仓 | 新增/修改/提交/订单 | 强 ACID、一致性、回滚 | 单条事务 <10ms |
| 原生图计算引擎 | 多层关系溯源/链路分析 | 复杂路径遍历、权重计算 | 复杂链路 <50ms |

同步机制：粒子主仓变更经内置 CDC 近实时异步同步图引擎（延迟 <1s）；**事务写入仅落关系仓，图仓只读不写**。

### 2.6 多租户 + Agent 沙箱 + 双轨工作流 + API 语义报文
- 三级隔离：工作空间→团队→成员，行级隔离。
- 敏感脱敏：个人隐私字段（手机/邮箱/证件）对外 API 与低权限界面自动脱敏；商业敏感（估值/底价/提成）仅高管可见；AI 上下文敏感片段自动屏蔽。
- 不可篡改审计：写入/Agent 推理/权限变更/工作流全量加密日志（操作主体、时间、粒子 ID、变更前后值、访问 IP），留存 7 年，适配 GDPR。
- 双轨工作流：全自动轨道（低风险，无人工）→ 人工复核轨道（大额变更/敏感修改/批量删/权限调整，强制拦截→管理员确认→留复核日志）。
- **API-First + 强制报文**：所有内外 API 必须携带粒子元数据标识、租户上下文 ID、Agent 权限令牌；服务端校验完整性，拦截缺失/越权。

### 2.7 抽取数据实证（真实字段，attio_extract）
> 二轮补强（2026-09-03）：再次解析 `schema/all_schema.json` + `csv/companies.csv` 等一手数据，补充属性类型分布与多租户实证。

- 工作区启用对象 5 个：people(24 条/29 属性)、companies(19 条/32 属性)、deals、users、workspaces；候选 slug 18 个（notes/tasks/interactions/lists/emails/meetings… 当前 NOT_IN_API）。
- **属性类型分布（types 实测）**：
  - `people`：text=9、personal-name=1、email-address=1、**record-reference=1（company）**、phone-number=1、location=1、number=2、**interaction=8**、select=1、**actor-reference=2**、timestamp=1。
  - `companies`：text=9、**domain=1**、record-reference=1（team）、select=4、location=1、number=2、currency=1、date=1、**interaction=8**、actor-reference=2、timestamp=1。
  - **关键洞察**：① interaction 类型 8 个字段（first/last/next_*_interaction）——**原生建模「互动时间线」**；② actor-reference（strongest_connection_user 等）——**原生建模「关系强度与责任人」**；③ domain/currency 为专有类型；④ record-reference 即 ATTIO 的「关系边」。
- **关联关系实证（csv 数据）**：`people.company` 与 `companies.team` 互为逆向边，共 14 条有效关系（24 名联系人中 14 名有公司，19 家公司中 6 家有团队）——关系是**双向镜像**而非单向外键。
- **多租户实证（ATTIO 记录 ID 结构）**：每条记录的 `id` 是三元组 `{ workspace_id, object_id, record_id }`（见 `objects/companies.json` 首条：`workspace_id=95c0c8c7-6314-4538-bc7a-13d3f8d7b108`）——**租户即 workspace_id，行级隔离在 ID 层固化**。这与本平台 `tenant_id` 列 + `tenantScope.js` 的隔离设计同构（一个在 ID 结构内、一个在行级列上）。

---

## 三、Lightfield 深度学习（客户记忆世界模型）

> 本次补强（2026-09-03 二轮）：新增 14 篇官方博客一手原文研读（why-we-built-lightfield / llms-also-prefer-stories / founder-guide / introducing-skills / how-to-skills-knowledge / agentic-data-import / designing-for-outbound-that-compounds / building-the-crm-that-works / dissolution-of-integrations-and-data-moats / contact-account-data-model / improved-chat-data-model / sequences-record-merge-custom-objects / field-value-history / mcp-connectors-member-pages），提炼如下。

### 3.0 补充：面向创始人的五测试评估框架（The founder's guide to evaluating an AI CRM）
AI CRM 三分法：
- **Type 1：legacy 架构上外挂 AI**（Salesforce Agentforce / HubSpot Breeze）——数据模型未变，仍依赖人工正确录入；"AI 在现实的影子上推理"。
- **Type 2：无世界模型的 AI 自动补全**（转录/摘要/自动填充）——解决了录入问题，但"capture isn't understanding"，AI 只是速记员（stenographer）。
- **Type 3：AI 作为地基的世界模型**（Lightfield 自居）——不只捕获，还理解/综合/跨历史推理；能回答"为什么"。

五测试：
1. **Capture test**：系统对客户实际发生的事知道多少？应自动捕获邮件/通话/会议的实际内容（不只是元数据）。失败态："知道打了 47 分钟电话，却不知道说了什么"。
2. **Synthesis test**：能否跨整个客户群做模式综合？失败态："能漂亮摘要单通电话，却答不出过去半年客户对定价说了什么"。
3. **"Why" test**：事情发生时能否说出为什么？失败态："Close Reason 是销售一周后凭记忆填的 dropdown"。
4. **Query test**：能否用自然语言问任何问题并引用具体对话？失败态："AI search 其实只是更好的 Ctrl+F"。
5. **Action test**：理解后能否行动？失败态："给出洞察后要你在另外三个工具里手动执行"。

> 判断基准（原文）："The questions you should be asking aren't about features. They're about architecture."——问的不是功能，是架构。

### 3.1 World Model 四维度（Why we built Lightfield）
传统 CRM 是"systems of record"——决策后存结果，丢失时序/因果/上下文，无法解释成败。Lightfield 构建"公司世界模型，从客户开始"，底层维护四属性：
- **Chronology**：发生了什么、按什么顺序（完整时间线，非快照）。
- **Attribution**：谁在何时、因什么说了什么（真实话语，非人工摘要）。
- **Causality**：什么动作导致什么结果（连接半年前对话与今日决策的线索）。
- **State**：信任/风险/动能/意向及其随时间的变化（不仅是关系在哪，更是怎么来的、去哪）。

> 原则：**Reality comes first. Everything else is computed from it.** 摘要、字段、仪表板都是派生视图，非真相源。

### 3.2 Stories > Graphs（LLMs also prefer stories）
- 核心论证：给 LLM 表格/知识图谱，模型把关系"抓得太死"，缺"为什么相连/全局主题"的理解（见树不见林）；给叙事（chronology + narrative），最强模型（如 Opus）能**动态重赋细节权重**，在人类关系这种"可塑"对象上远优于刚性图。
- 工程决策：2025 年起放弃经典图，改为"围绕人物与关系的、实时更新的编年叙事（live-updating chronological stories）"，与结构化/非结构化数据一起喂给模型。
- 对 CRM-ai-native 的直接印证：本项目的 LIGHT（Lightfield）认知架构 + ai-memory-lifecycle「叙事化客户记忆」方向正确。

### 3.3 Save → Understand → Act（原始痕迹 → 机构记忆 → 模式浮现）
- 捕获原始痕迹：每封邮件、每通电话、每次会议（raw traces），而非人工摘要。
- 活系统与机构记忆：随团队扩张保留全部互动；人员离职/换岗上下文不丢（"Context preserved even when people leave"）。
- 模式自动浮现：跨数百上千对话自动浮现模式，削弱人类近因偏差（recency bias）。
- 零手动录入目标：不以优化 data entry 为 KPI，而以"彻底消除"为产品边界。

### 3.4 数据模型灵活化（Contact and account data model improvements, 2026-02-27）
- 联系人支持多个邮箱地址与多账户关联；账户可关联多个域名——更灵活地表达客户关系是核心迭代方向。

### 3.5 Skills & Knowledge（执行层 + 上下文层）
- **Skill**：一次定义、按需调用的可重复工作流（描述任务/步骤/约束，Agent 稳定执行）。三作用域：Workspace（Admin 管、团队共享）/ User（个人）/ System（平台维护、不可改）。
- **Knowledge**：Skill 运行时的结构化上下文层（ICP 定义、竞品定位、异议处理、买家语言、资格标准）。经验法则：同一指令给新员工 3 次 = Skill；同一公司背景反复解释 = Knowledge。
- 内置预建 Skill（发现准备、会后跟进等）作起点，定制即机构知识沉淀处。

### 3.6 官方预建 Skill 银行（Introducing Skills，2026-04-08）——按 GTM 生命周期分层
官方博客给出的 Skills Bank 分层（对本平台 Skill 组织有直接借鉴）：
| 层 | Skill 示例 | 能力 |
|---|---|---|
| **Build pipeline（建管道）** | 找相似公司 / 建目标客户清单 / 复活丢失商机 / 研究与撰写外呼 | 从历史赢单反推 ICP，生成证据驱动的目标清单与首触文案 |
| **Know your deals（懂商机）** | 绘制采购委员会 / 找下一步最佳动作 / 提取买家语言 / 会议前准备 / 会后跟进 / 从会议创建/更新商机 | 用全上下文合成会前简报、会后邮件，商机免手动录入 |
| **Win the deal（赢单）** | 起草提案 / 生成销售 Deck / 按 MEDDPICC 评分 | 把商机上下文直接转成可发送产物 |
| **Run your GTM（跑增长）** | 账户健康度红黄绿 / 生成管道报告 / 起草案例研究 | 从洞察到管理动作 |

### 3.7 原始痕迹→导出视图（LLMs prefer stories；post-processing）
- 原文强调 \"**avoid premature abstraction**\"：摘要/字段/看板都是 **derived views**，真相源是原始记录；任何新维度可按需从原始记录重新计算——这与后验演化本体一致。
- 关键工程启示：**不做 premature abstraction** = 不提前把事实固化成 schema；需要时再算。对应本平台 meta_attr 动态 19 有穷集「用后扩展」原则。

### 3.8 字段值历史（Field value history，2026-07-10）
- 新增：字段显示历史值，可从引用该字段变更的活动日志进入查看。**这是对\"只记新状态、不记变化原因\"的直接响应**——与本平台 decision provenance（哈希链 + audit_event 前后值）同构。

### 3.9 复利式外呼（Designing for outbound that compounds on itself）
- 论点：多数 agent 驱动外呼之所以不落地，是因为**完全来自二手上下文**（secondhand context，第三方 enrichment 工具）。
- 解法：**一手上下文**——你的已赢商机、买家语言、推进特征；agent 先帮你从 closed-won 构建假设，再基于证据起草消息，每轮回写 funnel 数据进知识库 → \"系统复利\"。
- 对本平台的映射：本平台已有 decision provenance / 复盘回路，但缺\"赢单语言→下次外呼\"的闭环；可将\"赢单案例特征 + 买家原话\"沉淀为租户级 Knowledge，对齐 3.5。

### 3.10 MCP 连接器（MCP connectors, member pages, 2026-02-06）
- MCP connectors 按用户配置，可在 agent chat 与 workflow 中使用；例：Granola 会议转录在 workflow 中自动拉取。
- 与本平台 MCP 双传输（3001）+ Agent 工作台 MCP 暴露（41 个 action）同构；差异：Lightfield 用 MCP 把外部工具接进 Agent 执行，本平台用 MCP 把平台 action 暴露给外部 Agent。

---

## 四、ATTIO × Lightfield × CRM-ai-native 三方映射

| 能力维度 | ATTIO | Lightfield | CRM-ai-native 现状 |
|---|---|---|---|
| 数据模型 | Particle（实体/属性/关系，运行时动态） | 灵活对象 + 多邮箱/多账户/多域名 | ✅ 粒子系统（`crm.particles` type 自由 TEXT + payload JSONB + meta_attr 动态 19 有穷集 + edges） |
| 语义/记忆层 | Universal Context 三层内核（映射/向量/推理上下文） | World Model 四维度 + 编年叙事 | ✅ K-M-D 三层 + LIGHT 认知架构；客户记忆四构件 |
| 摄入 | 全域实时原生摄入（无代码 CDC） | 原始痕迹零手动录入 | 🟡 部分：事件总线捕获，但无代码实时 CDC 摄入未全量 |
| 存储 | 图-关系混合（关系主仓 ACID + 图仓 <50ms） | 叙事 + 向量 | 🟡 关系主仓具备；图引擎/向量集市未独立部署 |
| 多租户 | 工作空间→团队→成员 行级隔离 | Workspace 作用域（Skill/Knowledge） | ✅ `tenant_id` 全表 + `tenantScope.js` + 按租户 profile 隔离（见第一节缺口） |
| Agent 沙箱 | 每 Agent 独立读写白名单 + 上下文裁剪 + 审计 | Skills 三作用域 + Knowledge 隔离 | ✅ 决策第 0 闸 + autonomyEngine 分级 + 零信任 HITL |
| 双轨工作流 | 全自动 / 人工复核轨道 | Skills 可人工触发 | ✅ CRM_APPROVAL_FLOW + decision gate（HIGH/EXCEPTION 强制升级） |
| API 语义报文 | 强制带粒子元数据 + 租户上下文 ID + Agent 令牌 | REST API + MCP | 🟡 MCP 暴露 + crm_login；强制语义报文未全量落地 |
| 审计 | 7 年不可篡改加密日志 | — | ✅ decision provenance 哈希链 + audit_event |
| 阈值/规则配置 | 派生视图计算类型 | Knowledge 注入 | ✅ config_store + readThreshold() 配置化（禁硬编码） |
| 产品定位 | 可编程柔性数据底座（数据优先） | 客户记忆世界模型（理解优先） | 二者兼收：粒子底座 × 决策问责护城河 |

---

## 五、对 CRM-ai-native 的落地启示

### 已对齐（无需返工）
- 粒子柔性底座、多租户隔离、决策第 0 闸零信任、阈值配置化、不可篡改审计——与 ATTIO 六准则、Lightfield Save→Understand→Act 高度同构。

### 待补/可借鉴
1. **叙事化客户记忆强化**：Lightfield"编年故事 > 图"直接印证 LIGHT 架构方向；建议在客户洞察页用"动态权重叙事"替代静态关系图（当前 account-insight 已用 L2C 时间线，可进一步叙事化）。
2. **Skills & Knowledge 机制**：当前 SKILL 体系偏平台/工程侧；可借鉴 Lightfield 把"行业 Know-How（ICP/异议/竞品）"显式沉淀为租户级 Knowledge，供 Agent 推理消费（与 config_store 租户画像同源）。
3. **API 强制语义报文**：参照 ATTIO，内外 API 统一携带 `粒子元数据 + 租户上下文 ID + Agent 令牌`，服务端校验完整性（提升零信任强度）。
4. **图-关系混合存储**：当前仅关系主仓；复杂链路（投资人-基金-被投等）若需 <50ms 查询，应引入图仓只读副本 + CDC 同步。

### product-catalog 租户决策（见第一节）
- **【已拍板 2026-09-03 20:43】全部数据走方案 B（每租户自有）**：所有数据（含产品目录等基础主数据）均按 `tenant_id` 各自隔离；**不再共享 system 模板**；租户用户只读本租户数据，admin 通配 `'*'` 仍可见全部。
- 方案 B 现状（架构天然支持，无需改查询/写规则/隔离）：
  - 读：`routes.js:424` `scopeTenant(me)` 自动按登录 token 收敛本租户；
  - 写：`routes.js:487` `scopeOf(me)` 强制写自身租户（永不 `'*'`）；
  - 仓库：`particleRepo.js:169` SQL 带 `tenant_id` 条件；
  - 种子：`seed-master-data.sql` 12 条按需**按租户复制**（同结构幂等 INSERT，改 tenant_id 字段）。
- 落地缺口：**「按租户播种」尚未成产品化**。需把 `tenants` 主数据播种脚本化（每租户一套：主数据 + 用户 + 配置画像），并纳入 `industry-onboarding` 上线 Runbook（Step 2 配置画像 + Step 4 建粒子 + Step 5 建销售员），使新租户上线即自带本租户主数据。

---

## 六、下一步建议
1. 若采纳 product-catalog 方案 A：修改 `queryParticles` 对主数据类型 `tenant_id IN (scope, 'system')`，并补充 `system` 主数据的"租户可覆盖"语义；属小改动，需走 brainstorming→writing-plans（架构级数据隔离变更）。
2. 若要把 ATTIO/Lightfield 方法论沉淀为项目 SKILL：可更新 `ai-particle-system-design` / `ai-memory-lifecycle`（中性示例，不污染领域专有内容）。
3. 需要我针对 product-catalog 租户方案 A/B 出详细设计文档（含代码级改动）时，请确认，我按 brainstorming 流程推进。
