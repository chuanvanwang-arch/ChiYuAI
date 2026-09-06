# 粒子属性元模型自适应 + 动态表单配置抽屉 —— 结合本项目解决方案

> 输入材料：
> ① attio 属性自适应参考：`D:\浪潮-交付文件\02 26年乙方经历\other\典型客户\reference\attio_extract`（schema/all_schema.json · companies_schema.csv · extract_all.py）
> ② CordysCRM 动态表单配置抽屉：`D:\system\CRM-ai-native\CordysCRM-main`（frontend packages/web crm-form-design-drawer + crm-form-design/formAttrConfig）
> ③ 本项目现状：`src/particles/particleModel.js` · `src/aiAttributes/evaluator.js` · `src/page/*` · `src/context/roleProfiles.js` · `db/schema.sql`
>
> 上游基线（已批准，方案不越界）：`docs/2026-08-24-ai-native-sales-crm-design.md` §5bis A1（动态表单配置抽屉→粒子属性元模型 UI）；`docs/specs/2026-08-25-borrowings-comprehensive-implementation-design.md` §2 A1；`docs/2026-08-25-ai-native-crm-overall-design.md` §6 决策事件主轴（写第 0 闸）。
>
> 性质：**设计稿（方案）**。按铁律，未经批准不写实现代码。

---

## §0 结论（三句话）

1. **对齐度结论**：attio 的属性类型集与本项目「19 类型有穷集」（`particleModel.js:209-213`）**几乎逐一对应**（text/personal-name/email-address/phone-number/domain/currency/date/select/record-reference/actor-reference/interaction…）；CordysCRM 的抽屉（`crm-form-design-drawer/index.vue`）提供「配置→实时渲染→权限分栏」的**交互范式**；本项目缺的**不是能力，是「元模型可配置化 + 抽屉 UI」这一个呈现层**。
2. **方案一句话**：把 `coreAttributes`（代码态、`particleModel.js`）提升为**可配置粒子属性元模型**（`crm.meta_attr` 表），类型集**保持 19 有穷不变**，配置变更走**决策事件主轴写第 0 闸**；抽屉 UI 不写死页面，而是产出**受控 Schema** 交给既有运行时渲染器（`src/page/renderer.js`）——人配置与 AI 生成共用同一协议。
3. **落地一句话**：阶段 2 先落「元模型表 + 读/写 Action + 字段级 RBAC（写闸逐字段校验）」，阶段 3 落「配置抽屉 UI + AI 属性自适应回填」；验收判据=新增属性**零代码自动入表**、权限按角色生效、配置变更落 `decision_event`。

---

## §1 材料取证（file:line 证据）

### 1.1 attio 属性自适应（reference/attio_extract）

| 证据 | 位置 | 内容 |
|---|---|---|
| 属性元数据结构 | `schema/all_schema.json`（people/companies 数组） | 每个 attribute = `{slug, title, type, required, unique, description, options}` 七元组 |
| 属性类型覆盖 | 同上 | text / personal-name / email-address / phone-number / location / **domain / currency / date** / select / number / timestamp / **record-reference / actor-reference / interaction** |
| 计算属性（写时自维护） | companies 数组 first/last/next_*_interaction | attio 的交互类属性**不是录入的，是系统写时自动计算的**（日历/邮件/一般交互时间窗）——「属性自适应」的实证核心 |
| 分层语义 | 本项目已消化 | `particleModel.js:190-198` SEMANTIC_TAGS（firmographic/social/relation/interaction/ui/legacy 六桶）即 attio A/B/D 桶的收敛落地 |

小结：attio 的「自适应」= ①类型集有穷但覆盖面广（一个对象 28-31 个属性直接可用）；②计算属性由系统写时维护，无需人工定义字段；③属性元数据（type/required/unique）驱动 UI 与校验，不写死表单。

### 1.2 CordysCRM 动态表单配置抽屉（frontend/packages）

| 证据 | 位置 | 内容 |
|---|---|---|
| 抽屉壳 | `web/src/components/business/crm-form-design-drawer/index.vue:36-42` | 全宽 `CrmDrawer` 内嵌 `CrmFormDesign`，header「保存」按钮（`index.vue:33`） |
| 配置状态 | `crm-form-design-drawer/useFormDesignConfig.ts:56-72` | `fieldList` + `formConfig` 双态；`unsaved` 脏标记；watch 深监听 |
| 字段名去重 | `useFormDesignConfig.ts:75-121` | `checkRepeat()`：重名字段/子表格字段/选项 label 三查 |
| 保存载荷 | `useFormDesignConfig.ts:123-172` | `buildSavePayload()`：select 类 defaultValue 多维→单值归一；subFields/refFields 递归处理 |
| 字段控件枚举 | `lib-shared/enums/formDesignEnum.ts:47-80` | `FieldTypeEnum` 30+ 控件：INPUT/TEXTAREA/INPUT_NUMBER/DATE_TIME/RADIO/CHECKBOX/SELECT/SELECT_MULTIPLE/MEMBER/DEPARTMENT/DATA_SOURCE/SERIAL_NUMBER/LINK/ATTACHMENT/INDUSTRY/FORMULA/SUB_PRODUCT/SUB_PRICE… |
| 字段规则 | `formDesignEnum.ts:82-86` | `FieldRuleEnum`：REQUIRED / UNIQUE / NUMBER_RANGE |
| 数据源（=粒子引用） | `formDesignEnum.ts:88-104` | `FieldDataSourceTypeEnum`：CUSTOMER/CONTACT/OPPORTUNITY/PRODUCT/CLUE/PRICE/CONTRACT/QUOTATION/PAYMENT_PLAN/INVOICE/ORDER… |
| 字段属性面板 | `crm-form-design/components/formAttrConfig/fieldAttr.vue:1-151` | 字段标题/描述/占位/数字格式/日期类型/数据源 type/选项配置（optionConfig.vue） |
| 表单属性面板 | `formAttrConfig/formAttr.vue:1-129` | 视图大小/布局（1-4 列）/标签位置（top/left 图例）/输入宽度/底部操作按钮 |
| 表单联动 | `formDesignEnum.ts:106-117` | `FormLinkScenarioEnum`：CLUE_TO_OPPORTUNITY / CUSTOMER_TO_RECORD / CONTRACT_TO_INVOICE…（对象间字段联动） |

小结：CordysCRM 抽屉 = 控件枚举（30+）×字段规则（3）×数据源枚举（14）×表单属性（布局/按钮），持久化为 `formProp+fields`（`lib-shared/models/customForm.ts:6-12`）。**这是「人配置表单字段」的成熟范式，与 attio 的「属性元数据驱动 UI」是同一模型的两种极（CordysCRM 重控件、attio 重类型语义）。**

### 1.3 本项目现状（与上述两材料的对齐点）

| 能力 | 位置 | 现状 |
|---|---|---|
| 属性类型有穷集（19） | `src/particles/particleModel.js:209-213` | `ATTRIBUTE_TYPE_SET`：text/personal-name/email-address/phone-number/domain/location/number/currency/percent/date/timestamp/select/multi-select/boolean/rating/url/record-reference/actor-reference/interaction —— **attio 全类型已在内** |
| 属性定义（代码态） | `particleModel.js:5-188` | 每粒子 `coreAttributes` 手写（如 CRM_ACCOUNT 已含 attio firmographics 桶，注释见 `particleModel.js:20-24`） |
| 语义分层 | `particleModel.js:190-198` | SEMANTIC_TAGS 六桶 + `semanticTagOf()` 路由 |
| 属性 schema 校验闸 | `particleModel.js:237-246` | `validateCoreAttributesSchema()`：类型不在 19 集即抛错 |
| 数据承载 | `db/schema.sql:11-24` | `particles.payload JSONB`（无固定列）——**天然支持属性自适应，新增属性不影响表结构** |
| AI 属性（写时求值） | `src/aiAttributes/evaluator.js:5-24` | `AI_ATTR_DEFS`：能力轴×来源轴（F_Forecast/J_Judge/A_Alert/C_Classify…）；确定性兜底 `deterministicEval` |
| 门户渲染器（受控 Schema→HTML） | `src/page/renderer.js:98-128` | 唯一渲染出口；`src/page/schema.js:9` 受控组件集 |
| 角色上下文 | `src/context/roleProfiles.js:13-20` | 六角色（sales/manager/exec/finance/presales/contract_admin）data_scope 模型 |
| 写通道 Action 闸 | `src/action/seed-actions.js:18-45` | data-particle-create/update；领域 Action `confirm:'critical'` + `autoDecision` 第 0 闸 |
| 已批准 A1 规划 | `docs/specs/2026-08-25-borrowings-comprehensive-implementation-design.md:68-83` | 「表单字段配置 → 粒子 coreAttributes 类型集即唯一事实源 / 实时渲染 → 门户渲染器 / 成员权限分栏 → 字段级 RBAC」 |

---

## §2 缺口判定（判定块）

| # | 判定问题 | 证据 | 结论 |
|---|---|---|---|
| J1 | attio 属性类型集与我们 19 类型集是否对齐？ | `all_schema.json` 全部 type ∈ `particleModel.js:209-213`；连 `interaction`（attio 计算属性）也已在内 | **对齐**。attio 的 12+ 类型全部 ∈ 19 集，无缺失 |
| J2 | 「自适应」缺什么？ | attio 的 interaction 属性是**写时自动计算**；我们仅在 `evaluator.js` 对 AI_ATTR_DEFS 显式列表求值 | **缺「写时自动识别 + 元模型登记」**：新增 payload 字段无自动归类/登记通道，`coreAttributes` 是代码态，加字段要改代码 |
| J3 | CordysCRM 抽屉范式我们能直接搬吗？ | 其 `FormConfig`/`FormCreateField` 为独立前端模型、持久化走自有 API | **不能搬结构，搬交互范式**。我们「配置=Schema + 运行时渲染」（A1 铁律：NL→Schema→渲染器，禁直出 HTML）。抽屉产出物=Schema，落 `src/page/*` 既有链路 |
| J4 | 配置变更是否是「写」？ | §6 决策事件主轴：一切写强制带 decision_id | **是写**。元模型配置变更 = 决策事件（新场景 `ATTR_SCHEMA_CHANGE`），防随意改字段结构（影响面=该粒子全量数据+校验+权限） |
| J5 | 字段级 RBAC 挂哪？ | `roleProfiles.js:13-20` 六角色 data_scope 模型；A1 规划（specs:78） | 扩展 data_scope：`field_permission: {particle_type, attr_slug, role, mode: hidden|readonly|editable}`，写闸逐字段核 |
| J6 | AI 属性与人工属性如何共存？ | `evaluator.js:5` 铁律：AI 属性永远落 `payload.ai.*`，不冒充人工事实字段 | 元模型增 `source: manual|ai|enrich` 轴，AI/attio 补全属性自动登记为 ai/enrich 源，人工改后升 manual |

**核心缺口一句话**：三者能力差集 = ①属性**元模型登记/管理**（配置化而非代码化）；②**写时自适应回填**（新字段自动归类入 19 类型 + 计算属性自动维护）；③**配置抽屉 UI**（人配置与 AI 生成共用受控 Schema）。

---

## §3 目标设计：三层架构

```
┌─────────────────────────────────────────────────────────┐
│ L2 UI 呈现层：动态表单配置抽屉（web/）                     │
│   左=字段列表(元模型) │ 右=属性配置面板                     │
│   → 产出受控 Schema → src/page/renderer.js 实时渲染         │
│   → 成员权限分栏（字段级 RBAC 读 roleProfiles 扩展）         │
├─────────────────────────────────────────────────────────┤
│ L1 配置协议层：配置=Schema（唯一协议）                      │
│   page/schema.js 扩展 form 页型 + attr 组件                │
│   Action 表面：attr-read / attr-update / field-permission  │
│   写通道第 0 闸：ATTR_SCHEMA_CHANGE 决策事件                │
├─────────────────────────────────────────────────────────┤
│ L0 元模型层：crm.meta_attr（配置化属性定义）                │
│   19 类型有穷集不变 │ coreAttributes 降级为 seed 事实源      │
│   写时自适应：payload 新字段 → 检测归类 → 登记入表          │
│   AI 属性轴 payload.ai.* + source 轴（manual/ai/enrich）    │
└─────────────────────────────────────────────────────────┘
```

设计原则（照抄 A1 宪法、不新增 ai-* 能力）：
- **类型集是审计基线**：19 类型**绝不新增**（J1 已证 attio 全覆盖，无理由扩）。
- **Schema 唯一协议**：抽屉产出与 NL 生成产出**同一份受控 Schema**，同一渲染器（`renderer.js`），同一校验（`validator.js`）——「配置界面=AI 生成界面的镜像」（specs:66）。
- **一切配置变更即决策**：写第 0 闸 + `decision_event` 审计（J4）。

---

## §4 L0 元模型层设计

### 4.1 属性元记录（`crm.meta_attr`，新增表）

```sql
CREATE TABLE crm.meta_attr (
  particle_type TEXT NOT NULL,            -- CRM_DEAL/CRM_ACCOUNT/…（∈ PARTICLE_TYPES）
  attr_slug     TEXT NOT NULL,            -- 属性名（payload 中的键）
  title         TEXT NOT NULL,            -- 展示名（attio title 对齐）
  attr_type     TEXT NOT NULL,            -- ∈ ATTRIBUTE_TYPE_SET（19 类型，db CHECK 引用）
  semantic_tag  TEXT NOT NULL DEFAULT 'legacy',  -- SEMANTIC_TAGS 六桶（particleModel.js:191）
  required      BOOLEAN NOT NULL DEFAULT false,  -- attio required 对齐
  unique        BOOLEAN NOT NULL DEFAULT false,  -- attio unique 对齐
  description   TEXT,                     -- attio description 对齐
  options       JSONB,                    -- select/multi-select 选项值域（attio options 对齐）
  source        TEXT NOT NULL DEFAULT 'manual',   -- manual | ai | enrich（attio 计算属性=automatic）
  display       JSONB NOT NULL DEFAULT '{}',      -- {kind, width, label_pos, placeholder, number_format, date_type}（CordysCRM fieldAttr 对齐）
  validation    JSONB NOT NULL DEFAULT '{}',      -- {required, unique, number_range, maxlen}（FieldRuleEnum 对齐）
  permission    JSONB NOT NULL DEFAULT '{}',      -- 字段级 RBAC：{roles: {sales: 'editable', finance: 'readonly'}}（J5）
  enabled       BOOLEAN NOT NULL DEFAULT true,    -- 后台开关（skill_registry.enabled 同范式）
  version       INTEGER NOT NULL DEFAULT 1,       -- 配置版本（决策锚定，policy_version 同范式）
  created_by    TEXT, created_at TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (particle_type, attr_slug)
);
```

设计要点：
1. **`coreAttributes` 降级为 seed**：`particleModel.js:5-188` 仍是**唯一事实源（seed 输入）**，`seedMetaAttr()` 将 coreAttributes 物化进 `meta_attr`（对齐「methodology_template 降级为物化镜像」的既成范式）；运行时读 `meta_attr`（可配置），不再读代码态。
2. **类型闸保持**：`attr_type` CHECK 引用 19 集（复用 `validateCoreAttributesSchema` 判据 `particleModel.js:237`），DB 层禁止越集——配置可改**title/required/options/display/permission**，不可改类型本质之外的东西。
3. **compute 属性（attio 自适应核心）**：`source='automatic'` 的属性（如 `last_interaction`）由既有交互索引（`src/particles/interactionIndex.js`）写时维护，元模型只登记**存在与显示规则**，不登记取值逻辑——与 attio 同构。

### 4.2 写时自适应（属性自动登记）

写粒子通道（`particleRepo.createParticle/updateParticle`）加**自适应钩子**（对齐 ontology/hooks 既有三钩子范式）：
1. 写入 payload 中含**未在 meta_attr 登记**的键 → 检测：
2. 类型推断：值形态 → 19 类型映射（string→text、数组→multi-select、JSON 对象→record-reference 候选、布尔→boolean、纯数字→number…）+ **未命中则拒绝**（防止脏键污染，对齐「未命中→legacy」纪律 `particleModel.js:201-206` 的保守路线）；
3. 自动登记 `meta_attr`（`source='ai'`、`enabled=false`，**不自动启用**——需人工/管理员在抽屉确认后启用，防字段爆炸）→ 触发 `decision` 事件域（自动登记本身=决策，`decision_event` 落库，见 §8-②）。

> 这一步即回答「attio 有属性自适应」：**attio 是对象 schema 开放 + 类型内建；我们 = payload 天然开放（JSONB）+ 写时归类 + 元模型登记 + 人工确认启用**。比 attio 更稳（有确认闸与 19 类型闸）。

---

## §5 L1 配置协议层设计

### 5.1 配置=Schema（page/schema.js 扩展）

- `PAGE_TYPES` 增 `form` 页型（属性元模型驱动的动态表单页，specs:77 已规划）。
- `COMPONENT_KINDS` 增 `attr-field`（读 meta_attr → renderer 渲染对应输入控件，映射表见 §5.3）。
- **不改**：`PARTICLE_TYPES_ENUM`（`schema.js:20-25`）、`ACTION_WHITELIST`（`schema.js:29-32`）——抽屉产出的**写按钮仍只能映射白名单内 Action**（铁律：禁 NL 生成未注册动作）。

### 5.2 Action 表面（新增 3 个，全部过第 0 闸）

| Action | kind | 说明 | 闸 |
|---|---|---|---|
| `data-particle-attr-read` | read | 读粒子元模型（按型/语义桶/enabled 过滤），供抽屉与查询层 | 读直连，无需决策 |
| `data-particle-attr-update` | write | 改元模型（title/required/options/display/permission/enabled） | **`ATTR_SCHEMA_CHANGE` 决策事件 + 写第 0 闸**；批量变更走「两阶段写入」（取表单→校验→执行→验证，§6.6 协议） |
| `crm-field-permission` | read | 按角色返回字段级权限（给渲染层做隐藏/只读） | 读直连 |

注册形态对齐 `seed-actions.js:18-45`（substrate 风格 + `parameters` + handler），白名单入 `schema.js:29-32` write 侧。

### 5.3 类型→控件映射表（19 类型 × CordysCRM 控件枚举）

| 我们 19 类型 | CordysCRM FieldTypeEnum | 渲染控件 |
|---|---|---|
| text | INPUT / TEXTAREA | 输入框（display.width 决定单/多行） |
| personal-name / email-address / phone-number / domain / url | INPUT（格式校验） | 输入框 + regex 校验（personal-name/email/phone 有专控：`fieldAttr.vue` phone.vue 实证） |
| number / currency / percent | INPUT_NUMBER | 数字输入（`fieldAttr.vue:79-120` numberFormat/decimalPlaces/千分位 对齐） |
| date / timestamp | DATE_TIME | 日期选择器（`fieldAttr.vue:123-132` dateType 对齐） |
| select / multi-select | SELECT / SELECT_MULTIPLE / RADIO / CHECKBOX | 下拉/单选/复选（options 集来自 meta_attr.options；`optionConfig.vue` 配置对齐） |
| boolean | CHECKBOX（单） | 开关/勾选 |
| rating | INPUT_NUMBER(0-5) | 评分控件 |
| location | LOCATION | 位置控件（`fieldAttr.vue` 高级字段实证） |
| record-reference | DATA_SOURCE + LINK | **粒子引用选择器**（`FieldDataSourceTypeEnum` 对齐：选项源=查询对应粒子类型）+ 详情跳转 LINK |
| actor-reference | MEMBER / USER_SELECT | 成员选择器（CRM_PERSON/CRM_ORGANIZATION 粒子） |
| interaction | （attio 计算属性，CordysCRM 无） | 只读展示 + 徽标（来源=interactionIndex 写时计算） |

> 映射原则：**19 类型是值域、控件是呈现**——同类型可多控件（select 可下拉可单复选），由 `display.kind` 决定；类型不变、呈现可配。这正是 attio（类型语义）+ CordysCRM（控件丰富）的合流点。

---

## §6 L2 UI 呈现层设计（动态表单配置抽屉）

### 6.1 抽屉结构（对齐 `crm-form-design-drawer/index.vue`）

```
CrmAttrDesignDrawer（全宽抽屉，index.vue:2-43 同构）
├─ header：返回 + 标题 + 「保存」（写 data-particle-attr-update，过第 0 闸）
├─ 左区（字段列表）：meta_attr 记录（按 semantic_tag 分组 + enabled 开关 + 新增按钮）
├─ 右区（属性配置面板，fieldAttr.vue 对齐）：
│   title / description / placeholder（display）
│   attr_type 只读展示（19 类型徽标，getFieldTypeName 同范式——类型不可改，只可换控件）
│   required / unique 规则（FieldRuleEnum 对齐）→ 写 validation
│   options 配置（select 类；optionConfig.vue 对齐）
│   数据源配置（record-reference 类：目标粒子类型 + 显示字段）
├─ 底部（formAttr.vue 对齐）：布局列数 / 标签位置 / 输入宽度 / 按钮文案 → form 级 display
└─ 成员权限分栏（memberPermissionTab 对齐，A1 核心）：
    六角色×字段矩阵（hidden/readonly/editable）→ 写 permission（meta_attr.permission）
```

交互纪律：
- 新增字段 = **一次决策**（`ATTR_SCHEMA_CHANGE`），字段名去重（`useFormDesignConfig.ts:75-121` checkRepeat 对齐）；
- 删除字段 = **禁用不删除**（`enabled=false`，历史 payload 数据仍可读；对齐 skill_registry 启停、禁删铁律）；
- 保存前实时预览：抽屉内嵌 `renderPage(schema)` 输出预览（pageStore `getPageHtml` 同链路）。

### 6.2 实时渲染（与 AI 生成共用出口）

「字段配置页」= 读 meta_attr → 组装 form Schema → `renderPage`（`renderer.js:98`）动态渲染；**同一个 Schema 也可由 NL 生成**（`createPageFromNl`，`pageStore.js:13`）——验证 A1「一个受控配置协议 = 人配置界面 + AI 生成界面共用」（specs:66）。

### 6.3 字段级 RBAC（写闸逐字段校验）

- 读侧：`crm-field-permission` 按角色返回字段矩阵 → 渲染层隐藏/只读（对齐 CordysCRM 成员权限分栏的展示语义）。
- 写侧：`data-particle-update`（`seed-actions.js:39-45`）handler 内**逐字段核对** `meta_attr.permission[role]`：
  - `hidden`：拒绝写入（即使 payload 携带也剔除，返回 `field_denied: <attr>`）；
  - `readonly`：值变更拒绝（structure 允许，值不允许——配置字段归配置，数据归数据）；
  - `editable`：放行。
- 角色解析：ctx.actor → `roleProfiles.loadProfile`（`roleProfiles.js:22-32`）data_scope 扩展读 permission。

---

## §7 AI 属性自适应闭环（衔接 evaluator 与 attio enrichment）

| 环节 | 设计 | 证据/对齐 |
|---|---|---|
| AI 属性求值 | `AI_ATTR_DEFS`（`evaluator.js:5-24`）**由 meta_attr.source='ai' 记录驱动**，不再硬编码列表 | 能力轴×来源轴不变（铁律：落 `payload.ai.*` 不冒充事实字段，`evaluator.js:4`） |
| attio enrichment 补全 | 现有连接器（`src/connectors/tenderConnector.js`）扩展：工商/firmographics 桶写回 → 登记 `meta_attr` source='enrich' + `auto_weak` 来源边（实证已有：`particleModel.js:222`） | A 桶 firmographics 已在 `coreAttributes`（`particleModel.js:20-24`） |
| 计算属性（attio 自适应核心） | `source='automatic'` 登记 + `interactionIndex.js` 写时维护（last_interaction 等） | attio first/last/next_*_interaction 同构（1.1） |
| 人工接管 | 用户在抽屉把 ai/enrich 属性改值 → `source` 升 manual（对齐「人工确认升强」既有决策：`auto_weak` 升强范式） | `particleModel.js:222` 注释 |

闭环：**写粒子钩子测新键 → 归类 19 类型 → 登记 meta_attr（enabled=false）→ 抽屉确认启用/配控件/配权限 → 写时校验与计算属性生效 → AI/连接器补全登记 enrich → 人工可接管**。属性从「出现」到「治理」全程有记录（decision_event），无静默字段。

---

## §8 落地阶段与验收判据

### 阶段 2（认知+智能体层，先行）
1. `crm.meta_attr` 表（DDL §4.1）+ `seedMetaAttr()` 物化 coreAttributes（零迁移，幂等）；
2. 写时自适应钩子：新键检测+19 类型归类+登记（enabled=false）+ 拒绝脏键；
3. Action 三个（§5.2）+ 白名单扩展 + `ATTR_SCHEMA_CHANGE` 决策场景（decision_scenario 表 seed）；
4. 字段级 RBAC：meta_attr.permission + data-particle-update 逐字段闸。

### 阶段 3（业务闭环增量）
5. 配置抽屉 UI（§6，受控 Schema 渲染，不引 CordysCRM 前端栈）；
6. AI 属性自适应闭环（§7：evaluator 改由元模型驱动 + enrichment 登记自动化）。

### 验收判据（每 Task 一 commit，可自动化 E2E）
| # | 判据 | 检验 |
|---|---|---|
| V1 | 新增属性零代码自动入表 | 写一个未登记字段 → meta_attr 出现记录（enabled=false）+ decision_event 落库 |
| V2 | 19 类型闸不可越 | 构造脏类型写 attr-update → DB CHECK / 应用层拒绝 |
| V3 | 字段级权限生效 | finance 角色写 sales 私有字段 → `field_denied`；渲染层隐藏 |
| V4 | 配置变更=决策 | attr-update 无 decision_id → 第 0 闸拒绝（对齐 §6 主轴） |
| V5 | 抽屉产出=Schema=预览一致 | 抽屉保存 → renderPage 输出与 NL 同 Schema 输出结构一致 |
| V6 | 计算属性写时维护 | interaction 事件写入后 last_interaction 自动更新（attio 自适应实证） |

---

## §9 边界与风险

1. **不扩 19 类型集**（铁律）：attio 全类型已覆盖（J1），扩集=破坏审计基线；新增形态优先「同类型换控件」（display.kind）而非新类型。
2. **不自建独立表单存储**：不用 CordysCRM 的 `customForm` 表模式；配置=Schema 唯一协议（J3），`form` 页型即表单定义，不产生第二套 schema。
3. **字段爆炸治理**：自动登记默认 `enabled=false`、`source='ai'`，启用必经抽屉确认（决策）；禁用不删除（数据可读性铁律）。
4. **与决策主轴衔接**：`ATTR_SCHEMA_CHANGE` 属「治理类」决策，参考 `policy_version` 快照范式（`schema.sql:137-145`）——字段结构变化锚定元模型版本，历史数据按版本解释。
5. **此方案不改任何既有模块行为**：`renderer.js`/`validator.js`/`evaluator.js`/`roleProfiles.js` 全部向后兼容，仅新增挂点（对齐「不新增 ai-* 能力，仅给各能力增挂点」顶层纪律）。

---

## §10 决策点（2026-08-26 用户批准）

> ✅ **已批准（2026-08-26 08:30）**：三项全部按推荐项确认，进入 writing-plans。
> ✅ **实施计划（2026-08-26 08:45）**：`docs/superpowers/plans/2026-08-26-particle-attribute-model.md`（7 Task，TDD，每 Task 一 commit，覆盖 §3-§8 全验收 V1-V6）。

1. **抽屉 UI 技术 = 受控 Schema 渲染**（对齐 A1 铁律「NL→Schema→渲染器禁直出 HTML」）：配置抽屉产出受控 Schema，交既有 `renderer.js`，不引 CordysCRM Naive-UI 前端栈。
2. **元模型版本策略 = `version` 递增 + decision 锚定**：`meta_attr.version` 随配置变更递增，锚定 `ATTR_SCHEMA_CHANGE` 决策事件（对齐 `policy_version` 快照范式），历史数据按版本解释。
3. **自适应登记默认值 = `enabled=false`**：新键归类登记后默认关闭（`source='ai'`），经抽屉确认启用，防字段爆炸（管理成本换数据质量）。