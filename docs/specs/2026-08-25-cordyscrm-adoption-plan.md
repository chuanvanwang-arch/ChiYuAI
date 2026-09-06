# CordysCRM 实现深度解析与全面借鉴方案

> 配套文档：`docs/2026-08-25-ai-native-crm-overall-design.md` §6.13 对话式 CRM 智能体包。
> 本方案对用户指令「详细分析这个实现方式和具体内容，补充到总体设计文档里面，也可以单独新增一个方案，必须全部借鉴」的落地。
> 目标：把 `D:\system\CRM-ai-native\CordysCRM-main\CordysCRM-skills-main`（30 文件）**逐组件拆解**，明确哪些机制**全部借鉴**、哪些 transport 层**替换**为我们的原生实现。

---

## 0. 总纲：借什么、砍什么、换什么

CordysCRM 是一套「**已有 CRM 的 REST API 薄包装层**」——它自己不持有数据，靠 `cordys.sh`/`cordys.py` 调外部 API。我们**本身就是 CRM**，因此本质差异在 transport 层，不在设计层。

| 维度 | CordysCRM（借鉴源） | 我们（AI 原生 CRM） | 处置 |
|---|---|---|---|
| 设计范式 | 对话式智能层 + 引擎晶格 + 角色透镜 + 两阶段写入 + 风险先于提问 | 同构 | **全部借** |
| 条件/算子 Schema | 14 算子 + 字段类型→算子映射 + 分页默认结构 | Action Registry query 参数 + 决策网络查询 | **全部借**（形态） |
| 角色画像 | 5 profiles + `ROLE_MAP` 环境变量 | 5 profiles + context-layering 角色自推断 | **全部借**（机制），身份识别改为自推断 |
| 风险规则 | 8 类预警 + L2C 链断裂检测 | crm-risk + §3.10 告警 + SSE 推送 | **全部借** |
| 输出纪律 | 第一性原则 + ≤5 列 + Emoji 状态 + 大结果集分级 | output-engine | **全部借** |
| 写入纪律 | 先取表单 → 校验 → 写入 → 验证，绝对禁删 | crm-write + 决策第0闸 | **全部借** |
| 传输层 | `cordys.sh` curl + `X-Access-Key/X-Secret-Key` + 域名白名单 | 原生引擎 API / MCP Server / HTTP API（无头） | **砍外部调用，换 transport** |
| 配置文件 | `.env`（CORDYS_ACCESS_KEY/SECRET_KEY/CRM_DOMAIN + ROLE_MAP） | MCP token 隔离 + 零信任（无外部密钥） | **换形态** |

**一句话结论**：设计内容**全部借鉴**；只有「调外部 REST API 的那条线」被替换成「调我们自己的粒子 API / Action Registry / 决策网络」，并以 MCP Server + HTTP API 暴露为无头接口。

---

## 1. 逐组件实现机制详解（30 文件）

### 1.1 插件骨架层（元信息）

| 文件 | 真实机制 |
|---|---|
| `.workbuddy-plugin/plugin.json` | 插件元数据：name/version/expertType/categoryId/agents/skills 清单。声明哪些是 agent、哪些是可装载 SKILL。 |
| `agents/cordys-crm.md` | 智能助手「面孔」——对外呈现的统一对话人格与能力边界说明（不是逻辑，是 frontmatter 级的角色卡）。 |
| `skills/cordys-crm/SKILL.md` | YAML frontmatter：`name`/`description`/`environment`/`security`。`security` 字段声明 `requiresSecrets:true`/`externalNetworkAccess:true`（因为它调外部 API）。 |
| `skills/cordys-crm/registry.json` | 清单 manifest：SKILL 内部文件拓扑（core/profiles/rules/references/scripts 的索引）。 |

**借鉴落点**：我们的 `.workbuddy-plugin/plugin.json` 结构对齐；但 `SKILL.md` 的 `security` 改为 `requiresSecrets:false`/`externalNetworkAccess:false`——因为我们调内部 API，天然零信任、无密钥泄露面（详见 §3.7）。

### 1.2 核心引擎层 `core/`（9 引擎的真实实现）

| 引擎文件 | 核心机制（真实做法） |
|---|---|
| `core/cli-spec.md` | **命令族 + 调用契约**：`crm page/get/search/follow/contact/product/org/members/whoami/verify/raw`；`form/add/update/batch-update/transition/transform`；`approval todo/action/resource/flow`。分页默认结构 `{current:1,pageSize:30,sort:{},combineSearch:{searchMode:"AND",conditions:[]},keyword:"",viewId:"ALL",filters:[]}`。模块推断表、意图→命令映射、部门递归强制规则（§2.2）、全局模糊搜索（6 模块并行）、内置视图（ALL/SELF/CUSTOMER_COLLABORATION）、L2C 链路追踪/漏斗/意图路由入口。 |
| `core/cli-reference.md` | **条件算子 Schema（全）**：条件结构 `{value,operator,name,multipleValue,type}`；14 算子 `EQUALS/NOT_EQUALS/CONTAINS/GT/LT/GE/LE/IN/NOT_IN/COUNT_GT/COUNT_LT/EMPTY/NOT_EMPTY/DYNAMICS/BETWEEN`；动态时间 `TODAY/WEEK/MONTH/QUARTER/LAST_THIRTY/CUSTOM`；**字段类型→算子映射**：TEXT类(INPUT/TEXTAREA/PHONE/LINK/SERIAL_NUMBER)、数字类(INPUT_NUMBER)、日期类(DATE_TIME)、附件类(ATTACHMENT)、多值(INPUT_MULTIPLE)、单选枚举(RADIO/SELECT/CHECKBOX/MEMBER/DEPARTMENT/DATA_SOURCE…)、**不可查询**(DIVIDER/PICTURE/INDUSTRY/FORMULA/SUB_PRODUCT/SUB_PRICE)。写入 API 端点（`/lead/add`、`/opportunity/add` 必填 `name+contactId+owner+products`）、线索转化（`/lead/transition/account`、`/lead/transform`）、统计 API、审批 API 完整端点。 |
| `core/intent-engine.md` | **优先级路由**：显式意图 → 模糊工作流 → 模糊搜索 → L2C → 未识别。意图→工作流映射表（销售/经理/高管/财务/商务）。参数默认值表。L2C 追踪工作流。 |
| `core/linkage-engine.md` | **L2C 链路模型** + 已验证关联字段表（Lead 无 `accountId` 靠 API 转化；Contract 无 `opportunityId` 靠 `customerId`）；Customer 360 工作流（聚合客户下全部商机/合同/回款）。 |
| `core/funnel-engine.md` | **首页统计 API**：`searchType:SELF/DEPARTMENT/ALL` + `deptIds` + `timeField` + `userField` + `priorPeriodEnable`（环比）。模块统计、客户级/合同级统计、漏斗查询与输出。 |
| `core/output-engine.md` | **第一性原则**：输出是「判断」不是「汇报」。表格 ≤5 列。Emoji 状态 `🟢⚠️🚨✅📋📊`。角色感知适配（销售/经理/财务差异）。大结果集分级（1-10 / 11-30 / 30+）。全局搜索输出格式。L2C 链路输出（含链断裂标注 `⚠️`）。漏斗/AR 视图。写入输出（创建/变更对比/批量/转化/确认）。 |
| `core/risk-engine.md` | **先于提问的预警**：核心原则「不重复/最多 3 条/判断比复述重要」。8 类规则：销售/经理/财务/审批/L2C 跨模块（链断裂检测）/高管/商务/全角色。**链断裂检测**：线索→客户 >30 天、商机赢单无合同、合同无回款计划、合同未开票、客户无跟进、链路健康汇总。 |
| `core/write-engine.md` | **高度抽象统一写入流程** + 两阶段写入（先 `GET /{module}/module/form` 取表单定义）。抽象函数层 `get_form/validate/build_save_body/save/update/batch_update/transition_lead`。内置+自定义校验。字段智能推断。批量（无 `batch-add`，仅 6 模块 `batch-update`）。**安全约束**：必做=取表单/校验/预览/对比/验证；禁做=删除/跳过校验/无预览批量/改系统字段/覆盖式全量更新。写入确认流程。 |

**借鉴落点**：这 8 个引擎文件是 CordysCRM 的「智慧核心」，设计层**全部照搬**到我们的 `crm-*` SKILL 的 `core/` 目录（详见 §2 映射表）。其中 `cli-spec`/`cli-reference` 此前被视为「外部 API 包装」被砍，本次纠正——它们的**命令契约形态 + 条件算子 Schema 是通用设计资产**，应借其形态、换其 transport（见 §3.1–§3.2）。

### 1.3 角色画像层 `profiles/`（5 视角）

| 文件 | 真实机制 |
|---|---|
| `profiles/sales.md` | 待办优先级视角：我的今日线索/跟进/临期商机；只关心「我该做什么」。 |
| `profiles/sales-manager.md` | 团队健康仪表盘：成员执行力/目标达成/风险巡检/审批。`ROLE_MAP` 子类型（一线经理/区域总监/事业部负责人）；部门递归（看整个子树）。 |
| `profiles/executive.md` | 全公司 L2C 全景/目标/趋势/现金流/人效；**无部门过滤 `viewId=ALL`**；日/周/月/季/年工作流；只读。 |
| `profiles/finance.md` | 合同回款/发票/AR/L2C 现金链路；催收排序；日/周/月工作流。 |
| `profiles/contract-admin.md` | 合同全生命周期/条款/审批/到期续约/开票；子类型（商务经理/合同专员/法务）。 |

**借鉴落点**：5 个 profile 文件 **1:1 借**到我们的 `profiles/` 目录，作为 §6.13.9「角色透镜」的内容契约。身份识别机制从 `ROLE_MAP` 环境变量改为 **context-layering 角色自推断**（见 §3.4），但 profile 文件本身不变。

### 1.4 规则层 `rules/`（机制可借，内容为空）

| 文件 | 真实机制（注意：实际是空占位） |
|---|---|
| `rules/README.md` | 自定义规则目录约定：`form-rules/`(表单级) + `field-mapping/`(字段映射) + `business-rules/`(业务规则)。**加载优先级**：API 表单 > form-rules > field-mapping > business-rules。文件格式规范 + 示例。 |
| `rules/form-rules/form.md` | **仅含 `# 技术站位，不加载`**（空占位，未实现） |
| `rules/field-mapping/mapping.md` | 同上，空占位 |
| `rules/business-rules/business.md` | 同上，空占位 |

**借鉴落点**：`README.md` 的**分层加载机制**借（它定义了「规则如何被引擎在运行时叠加」的秩序）。三个具体规则文件是空 stub——我们**不借空内容**，但沿用「API 表单 > 项目规则 > 字段映射 > 业务规则」的叠加顺序，映射到我们的 `skill_registry.enabled` + 决策网络 `DERIVED_FROM_EXCEPTION`/`OVERRIDES` 治理（见 §6.3）。

### 1.5 参考层 `references/crm-api.md`

| 文件 | 真实机制 |
|---|---|
| `references/crm-api.md` | 模块概览、通用请求结构、HTTP 端点、跟进计划/记录 API、请求示例、响应解析（`code=100200` 为成功）、错误处理、最佳实践、审批 API、L2C 链路 API（统计/客户子资源/全局搜索/订单/仪表板）。 |

**借鉴落点**：这是「外部 API 的说明书」。我们**不调外部 API**，但把它改写为「**我们自己的引擎 API / MCP 工具清单**」形式的 reference——即我们的 `crm-query`/`crm-write`/`crm-risk` 对外的无头接口文档（见 §3.1）。

### 1.6 传输 / 执行层 `scripts/` + `.env`

| 文件 | 真实机制 |
|---|---|
| `scripts/cordys.sh` | Bash CLI：`X-Access-Key/X-Secret-Key` 取自 `.env`；`validate_url` 域名白名单校验（**防密钥泄露**——只允许请求白名单域名）；`page_payload`/`merge_payload` 用内联 python3 拼装；`api_request` 用 `curl` + `X-Request-Source:SKILL` 头。命令分发：`crm_view/get/contact/page/search/follow_page/form/add/update/batch_update/lead_transition/lead_transform/approval_*/stat/stat_home/glocount/acct_sub/contract_sub/raw_api`。 |
| `scripts/cordys.py` | Python 等价实现：`WRITE_MODULES`/`BATCH_UPDATE_MODULES` 元组、dotenv、urllib、`validate_url`、相同 `crm_*` 函数、argparse `main`。 |
| `skills/cordys-crm/.env.example` | `CORDYS_ACCESS_KEY`/`CORDYS_SECRET_KEY`/`CORDYS_CRM_DOMAIN` + 可选 `ROLE_MAP`（`总经理|副总裁|VP=executive,总监|经理=sales-manager,…`）。 |

**借鉴落点**：
- `validate_url` 域名白名单思想 → 我们的 **MCP token 隔离 + RBAC + action-confirm**（零信任，且因为我们不调外部，密钥面直接归零，见 §3.7）。
- `cordys.sh`/`cordys.py` 的「**无头 CLI 调 API**」形态 → 替换为「**无头 MCP Server / HTTP API 调我们自己的引擎**」（见 §3.1）。
- `ROLE_MAP` 一行配置思想 → 保留为「一行配置激活角色视角」的产品体验，但实现改为 context-layering 自推断（见 §3.4）。

---

## 2. 全部组件 → 我们项目 crm-* SKILL / 粒子 / Action / 决策主轴 逐项映射

| CordysCRM 组件 | 真实机制 | 我们落点 | 取舍 |
|---|---|---|---|
| `plugin.json` + `registry.json` | 插件/SKILL 清单 | `.workbuddy-plugin/plugin.json` + `skills/crm-*/SKILL.md` 对齐结构 | **借**（结构），`security` 改为 `requiresSecrets:false` |
| `agents/cordys-crm.md` | 助手面孔 | `agents/crm-native.md`（编排人格） | **借** |
| `core/cli-spec.md` | 命令族 + 分页默认 + 视图 | `crm-native` 无头接口契约 + MCP 工具清单 | **借形态，换 transport**（§3.1） |
| `core/cli-reference.md` | 条件/算子 Schema + 字段类型映射 + 写入 API | Action Registry query params + 决策网络查询条件 + 粒子字段类型→算子映射 | **借形态**（§3.2） |
| `core/intent-engine.md` | 优先级路由 + 意图→工作流 + 默认值 | `crm-native` GATE 意图路由（§6.13.10） | **借** |
| `core/linkage-engine.md` | L2C 链路 + 关联字段 + Customer360 | `crm-query` 粒子图 + AGE 多跳 + 决策网络 §6.3 | **借**（源 = 粒子 API，非外部） |
| `core/funnel-engine.md` | 统计 API + 环比 + 漏斗 | `crm-query` 漏斗视图（锚定 `l2c_stage`） | **借** |
| `core/output-engine.md` | 第一性原则 + ≤5列 + Emoji + 分级 | `crm-native` output-engine（§6.13.10 FMT） | **借** |
| `core/risk-engine.md` | 8类预警 + 链断裂检测 | `crm-risk` 常驻主动（§6.13.8 原则⑤）+ §3.10 SSE 推送 | **借** |
| `core/write-engine.md` | 两阶段写入 + 安全约束 | `crm-write` 两阶段 + 决策第0闸 + action-confirm | **借**（§3.3） |
| `profiles/sales.md` | 待办优先级 | `profiles/sales.md` | **1:1 借** |
| `profiles/sales-manager.md` | 团队仪表盘 + 部门递归 | `profiles/sales-manager.md` | **1:1 借** |
| `profiles/executive.md` | 全公司全景 + ALL 视图 | `profiles/executive.md` | **1:1 借** |
| `profiles/finance.md` | 应收全景催收 | `profiles/finance.md` | **1:1 借** |
| `profiles/contract-admin.md` | 合同生命周期 | `profiles/contract-admin.md` | **1:1 借** |
| `rules/README.md` | 分层加载机制 | 决策网络 `DERIVED_FROM_EXCEPTION`/`OVERRIDES` 治理顺序 | **借机制** |
| `rules/*`（3 个空占位） | 空 stub | 不借空内容；留 `rules/` 目录待填 | **不借内容** |
| `references/crm-api.md` | 外部 API 说明书 | 改写为「我们引擎 API / MCP 工具清单」reference | **借形态，改目标** |
| `scripts/cordys.sh` / `cordys.py` | curl 调外部 API | 删外部调用；换成 MCP Server / HTTP API 调原生引擎 | **砍外部，换 transport**（§3.1） |
| `.env.example` | AccessKey/Secret/Domain + ROLE_MAP | MCP token 隔离 `requiresSecrets:false` + 角色自推断 | **换形态**（§3.4/§3.7） |
| 方法论（BANT/MEDDICC…） | **CordysCRM 无此组件** | `method-*` SKILL（§6.6，已独立设计） | **我们独有，CordysCRM 无对应** |
| 决策事件主轴 | **CordysCRM 无此组件** | 决策第0闸 + DECISION 粒子族 + 决策网络 §6.3 | **我们独有** |

> 关键修正：此前把 `cli-spec`/`cli-reference`/`cordys.sh` 当成「外部 API 包装」整体砍掉，是错误的。它们的**设计资产（命令契约、条件算子 Schema、无头 CLI 形态）是通用的**，应借；只砍「curl → 外部 REST」这一行。

---

## 3. 「必须全部借鉴」落点（被忽略组件的转化方式）

### 3.1 命令族 / `cordys.sh` → 我们的无头接口 / MCP 工具

CordysCRM 的 `crm page/get/search/follow/.../approval_*` 命令族，全部转化为我们的 **MCP Server 工具 + HTTP API**，由 `crm-native` 惰性编排调用：

| CordysCRM 命令 | 我们的无头接口 | 底层调用 |
|---|---|---|
| `crm get/search` | `crm_query.search_particles(module, conditions)` | 粒子 API + pgvector + AGE 多跳 |
| `crm page` | `crm_query.paginate(...)` | 决策网络 §6.3 + 分页（沿用 CordysCRM 分页默认结构） |
| `crm follow` | `crm_write.upsert_followup(...)` | Action Registry（带 `decision_id` 第0闸） |
| `crm form/add/update` | `crm_write.create/update(...)` | 两阶段写入（先取表单） |
| `crm lead_transition/transform` | `crm_write.transition_lead(...)` | DEAL 状态机（阶段1 已实现） |
| `crm approval_*` | `crm_write.approve(...)` | Action Registry + HITL 闸 |
| `crm stat/stat_home` | `crm_query.funnel(...)` | 漏斗引擎（锚定 `l2c_stage`） |
| `crm raw_api` | （删除） | 不再需要——我们即后端 |

**无头设计保留**：保留 CordysCRM「无 UI 依赖、可嵌入任意环境」的特质，通过 MCP Server（stdio + StreamableHTTP）暴露，任意办公智能体（WorkBuddy 等）免登录引用（§6.6 Skills-as-a-Service）。

### 3.2 条件算子 Schema → Action Registry query 参数 + 决策网络查询

`core/cli-reference.md` 的 14 算子 + 字段类型→算子映射，**原样借**为我们的查询契约：
- Action Registry 的只读查询参数采用同一套 `conditions:[{value,operator,name,multipleValue,type}]` 结构。
- 不可查询字段类型（DIVIDER/PICTURE/INDUSTRY/FORMULA/SUB_PRODUCT/SUB_PRICE）在生成查询表单时**自动禁用**。
- 动态时间算子（`TODAY/WEEK/QUARTER/LAST_THIRTY`）映射为我们的「预警锚点相对时间」计算（§3.10）。

### 3.3 两阶段写入 → `crm-write` + 决策第0闸

CordysCRM `write-engine` 的「先 `GET /{module}/module/form` 取表单 → 校验 → 预览对比 → 写入 → 验证」流程，**1:1 借**为 `crm-write` 的两阶段写入。叠加我们独有约束：
- **决策第0闸**：每次写入必须携带 `decision_id`（无决策不写，§6.1/§6.2）。
- **action-confirm**：写操作生成 `confirmation_token`，用户确认后才执行（对齐 Agent2B 范式）。
- **绝对禁删**：继承 CordysCRM 禁删铁律 + 我们决策网络的 `OVERRIDES` 治理（只追加不物理删除）。

### 3.4 `ROLE_MAP` + profiles → 5 profiles + context-layering 角色自推断

CordysCRM「填 API 密钥 → `ROLE_MAP` 按岗位关键词匹配角色文件」的一行配置体验**保留**，但实现替换：
- 不再用 `ROLE_MAP` 环境变量 + API Key 推断身份。
- 改为 **context-layering L1-L4 注入的上下文**（提问内容、所属粒子、历史决策）由 `role-engine` **自推断**角色（§6.13.8 原则②「不问你是谁，自己判断」）。
- `profiles/` 五个文件 1:1 借为角色透镜的内容契约，透镜后三维切换（展示什么/先展示什么/紧迫度，§6.13.9）。

### 3.5 风险规则 → `crm-risk` + §3.10 告警 + SSE 推送

`risk-engine` 的 8 类预警 + L2C 链断裂检测**全部借**：
- 6 类链断裂锚点（线索>30天无客户 / 商机赢单无合同 / 合同无回款计划 / 合同未开票 / 客户无跟进 / 链路健康汇总）映射为 §3.10 告警类型（`lead_overdue`/`deal_stuck`/`payment_due` 等）。
- `crm-risk` 引擎**常驻主动探测**（§6.13.8 原则⑤），发现断裂即经 §3.10 SSE 事件总线**先于提问推送**对应角色。
- 「不重复/最多 3 条/判断比复述重要」三原则直接写入 `crm-risk` 引擎纪律。

### 3.6 输出格式 → output-engine 第一性原则

`output-engine` 的纪律**全部借**进我们的 `crm-native` FMT 引擎：
- 输出是判断非汇报；表格 ≤5 列；Emoji 状态 `🟢⚠️🚨✅📋📊`；角色感知适配；大结果集 1-10/11-30/30+ 三级；L2C 链路输出带 `⚠️` 链断裂标注。

### 3.7 `.env` + 域名白名单 → MCP token 隔离 + 零信任禁删

CordysCRM 用 `.env`(AccessKey/Secret/Domain) + `validate_url` 域名白名单防密钥泄露。我们**无外部调用**，故：
- `security.requiresSecrets=false` / `externalNetworkAccess=false`——天然零信任、无密钥泄露面。
- 对外暴露仍走 MCP Server，但鉴权改为 **MCP token + RBAC + action-confirm**（写前过闸），不需要 `validate_url`（因为没有外部域名）。
- `ROLE_MAP` 一行配置的「开箱即适配角色」体验，由 context-layering 自推断等价实现。

### 3.8 引擎晶格懒加载 → `crm-native` 惰性编排

CordysCRM「`role-engine` 唯一常驻 ~150 行，其余按意图懒加载」的晶格纪律**借**为 `crm-native` 编排：
- 入口常驻：`role-engine`（透镜）+ `intent`（GATE 路由）+ `output`（FMT 出口）。
- 懒加载：QUERY/LINK/FUNNEL/APPR/WRITE/RISK 按意图触发。
- RISK 虽常驻主动，但其推送走 SSE 总线，不占对话上下文窗口（§6.13.10）。

---

## 4. 落地路径建议（阶段 2 重排）

基于本方案「全部借设计、换 transport」，建议把 §6.13 拆为三个实施包（对应此前 2a/2b/2c）：

| 包 | 内容（来自本方案） | 对应 CordysCRM 源 |
|---|---|---|
| **2a 插件骨架 + 角色透镜** | `.workbuddy-plugin/plugin.json` + `agents/crm-native.md` + 5 `profiles/` + `role-engine` 常驻 + context-layering 自推断 | 1.1 / 1.3 / 1.6(ROLE_MAP) |
| **2b 查询 + 写入智能体** | `crm-query`（cli-spec 形态 + cli-reference 算子 + linkage + funnel）+ `crm-write`（两阶段 + 决策第0闸 + action-confirm）+ 改写为我们自己的 `references/engine-api.md` | 1.2(cli-spec/cli-reference/intent/linkage/funnel/write) / 1.5 |
| **2c 风险 + 方法论 + MCP** | `crm-risk`（risk-engine 全规则 + SSE 推送）+ `method-*`(§6.6) + MCP Server（无头接口，替换 cordys.sh） + `rules/` 分层加载治理 | 1.2(risk) / 1.4 / 1.6(scripts→MCP) |

> 待用户确认：本方案是**单独保留**为 `docs/2026-08-25-cordyscrm-adoption-plan.md`，还是把 §1–§3 的内容**合并进总体设计 §6.13**（用户此前偏好单文档）。当前先以独立方案存在，总体设计 §6.13.12 已交叉引用本文件。
