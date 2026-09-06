# AI 原生 CRM · 11 ATTIO 属性/交互模型借鉴设计（A+B+C+D）

- 日期：2026-08-25
- 来源：`D:\浪潮-交付文件\02 26年乙方经历\other\典型客户\reference\attio_extract`（schema/all_schema.json, companies_schema.csv, people_schema.csv, attio_full_inventory.json, summary.json）
- 方法论依据：01 粒子系统设计 §2.2（19 类型有穷集）/ §2.4（交互属性）/ §4（受控谓词）；总体设计 §6
- 范围：**A+B+C+D**（用户 2026-08-25 确认）—— 公司 firmographics + 联系人 enrichment + 关系强度 + 交互渠道维度
- 前置：本文档为设计增量，未批准不写实现代码（设计先行 HARD-GATE）

## 0. 结论

ATTIO 是独立商业 CRM，其对象/属性模型与本项目 9 粒子**高度同构**，且属性类型全集为本公司 19 类型集的**严格子集**。引入 ATTIO 不新增任何粒子、不新增任何属性类型，仅做**属性级增补 + 交互事件平面增强**。这是一次方法论正向验证，而非模型重构。

## 1. 类型交叉验证（零改动，纯佐证）

ATTIO 属性类型：`text / personal-name / email-address / phone-number / domain / location / number / currency / date / timestamp / select / record-reference / actor-reference / interaction`（14 种）。

本项目 19 类型集（01 §2.2）：上述 14 种 **全部覆盖** + 额外 `percent / multi-select / boolean / rating / url`（5 种）。

→ ATTIO 属性可**逐条原样引入**，无需扩展类型集。本结论同时交叉验证了 19 类型有限集的可复现性。

## 2. 对象映射（1:1 + 候选折叠）

| ATTIO 启用对象 | 本项目粒子 | 处置 |
|---|---|---|
| companies | CRM_ACCOUNT | 1:1，属性增补见 §3.1 |
| people | CRM_CONTACT | 1:1，属性增补见 §3.2 |
| deals | CRM_DEAL | 1:1（ATTIO 未抽 schema） |
| users | CRM_PERSON | 1:1 |
| workspaces | CRM_ORGANIZATION | 1:1 |

候选 slug（18 个）折叠，不新增粒子：
- `attachments` → CRM_UNSTRUCTURED_ASSET（已有）
- `notes / comments / activity` → 事件流（interaction 类型）
- `tasks` → crm.tasks（已有）
- `calendar_events / calls / meetings / emails / conversations / threads` → 交互事件 `channel` 取值（见 §3.4）
- `lists` → 保存视图 / 分群（查询非粒子）
- `locations` → `location` 类型属性
- `web_sessions` → 营销 enrichment（阶段 3 可选，本期不纳入）
- `stages` → CRM_DEAL 状态机（已有）

## 3. 具体属性增补

### 3.1 CRM_ACCOUNT 增补（桶 A + 关系强度 D 部分）

| 新增属性 | 类型 | 来源 ATTIO | 说明 |
|---|---|---|---|
| domains | domain | companies.domains | 身份解析锚（联系人邮箱域名→公司自动关联，对齐 auto_weak 边 + relation_confidence） |
| funding_raised_usd | currency | funding_raised_usd | firmographic |
| foundation_date | date | foundation_date | firmographic |
| estimated_arr_usd | select | estimated_arr_usd | 规模估算（枚举：<1M / 1-10M / 10-50M / 50M+） |
| employee_range | select | employee_range | 与现有 `size`(员工数) 对齐，二选一保留 `employee_range` 作标准 |
| categories | select | categories | 行业细分，细化 `industry` |
| logo_url | url | logo_url | UI 展示 |
| linkedin | url | linkedin | 社媒 enrichment |
| twitter | url | twitter | 社媒 |
| facebook | url | facebook | 社媒 |
| instagram | url | instagram | 社媒 |
| angellist | url | angellist | 社媒/投融资 |
| champion_strength | select | strongest_connection_strength | 关系强度（枚举：weak / medium / strong） |
| key_contact | actor-reference | strongest_connection_user | 关键决策人引用（指向 CRM_CONTACT） |

> 注：`team`(record-reference) ATTIO 用于内部团队归属，本项目由 `part_of`(ORGANIZATION) + `owned_by`(PERSON) 承载，不重复引入。

### 3.2 CRM_CONTACT 增补（桶 B）

| 新增属性 | 类型 | 来源 ATTIO | 说明 |
|---|---|---|---|
| job_title | text | job_title | 对齐现有 `title`，统一命名 `job_title` |
| avatar_url | url | avatar_url | UI |
| primary_location | location | primary_location | 地理维度 |
| linkedin | url | linkedin | 社媒 |
| twitter | url | twitter | 社媒 |
| relationship_strength | select | strongest_connection_strength | 关系强度（对齐 ATTIO；与 §2.3 `relationship_heatmap` AI 属性互补：select 为人工/规则标，AI 属性为派生） |
| company | record-reference | company | 对齐 `works_at`(ACCOUNT) 边，冗余引用便于检索 |

### 3.3 关系强度（桶 D）落地形式

- ACCOUNT 级：`champion_strength`(select) + `key_contact`(actor-reference) —— 表达"谁是我方在该客户的最强关系人"。
- CONTACT 级：`relationship_strength`(select) —— 表达"该联系人整体关系强度"。
- 二者为**人工/规则标定**字段（select），与 §2.3 的 AI 派生属性（`relationship_heatmap` / `stakeholder_influence`）职责分离：select = 人标事实，AI 属性 = 系统推断，下游不混用。
- 不新增受控谓词：`key_contact` 复用 `has_employee`(ACCOUNT→CONTACT) 边语义，或新增 `key_contact` 边（见 §4 落地清单，建议新增以区分普通员工与关键人）。

### 3.4 交互渠道维度（桶 C，事件平面增强）

ATTIO 建模 `first/last/next_calendar_interaction` / `first/last/next_email_interaction` / `first/last/next_interaction`（三类渠道 × 三指针）。本项目 §2.4 仅单指针 `lastActivityAt/nextActionAt`。增补：

**事件平面**：交互类事件（`events.domain='particle'` 且 `type='interaction'`）的 `payload` 增加受控字段：
- `channel`：枚举 `{email, calendar, call, meeting, general}`（ATTIO calendar/email + 通用 call/meeting 对齐）
- `interaction_at`：timestamp
- `related_particle`：{type,id}

**计算指针**（写时维护，落相关粒子 payload，避免每次聚合）：
```
interaction_index: {
  email:    { first_at, last_at, next_at },
  calendar: { first_at, last_at, next_at },
  call:     { first_at, last_at, next_at },
  meeting:  { first_at, last_at, next_at },
  general:  { first_at, last_at, next_at }
}
```
- 维护点：新增交互事件时由钩子（建议 `src/ontology/hooks.js` 或新增 `src/particles/interactionIndex.js`）按 `channel` 重算 first/last/next。
- `next_at` 来自计划类交互（calendar/call/meeting 的预定时间）；`first/last_at` 来自已发生交互。
- 全部类型为 `timestamp`，落在 19 类型集内。

## 4. 代码落地清单（待批准后执行）

| 文件 | 改动 |
|---|---|
| `src/particles/particleModel.js` | ① 为 `CRM_ACCOUNT` / `CRM_CONTACT` 新增 `coreAttributes` 声明（slug→type 映射，含 §3.1/§3.2 全部新增项），供 19 类型集校验；② `CONTROLLED_PREDICATES` 新增 `key_contact`（ACCOUNT→CONTACT，区分普通员工） |
| `src/particles/particleRepo.js` 或 `src/ontology/hooks.js` | 交互事件写时维护 `interaction_index`（§3.4） |
| `db/schema.sql` | `events.payload` 增加 `channel` 注释约定（JSONB 内，无需 DDL 变更）；可选加 `idx_crm_events_payload_channel` GIN 索引 |
| `docs/2026-08-25-01-ai-particle-system-design.md` | §2.1 P2/P3 属性表同步新增项；§2.4 交互属性补 `interaction_index`；§2.3 D 桶关系强度说明 |
| 种子（可选） | `attio_extract/objects/companies.json`(19) / `people.json`(24) 可作阶段 2 种子数据，需脱敏 |

## 5. 不改动项（铁律守住）

- [x] 粒子数保持 **9**（候选对象全部折叠，不新增）
- [x] 属性类型保持 **19 种有穷集**（ATTIO 为子集，零扩展）
- [x] 10 大 ai-* SKILL **不动**（本文档为 CRM 实例化，ATTIO 内容仅入 `reference/` 与本设计文档）
- [x] 受控谓词仅新增 1 个 `key_contact`（为区分关键人语义，非裸外键）
- [x] 现有 `works_at` / `has_employee` / `part_of` / `owned_by` 边语义不变

## 6. 自检

- [x] 每新增属性类型 ∈ 19 集（domain/currency/date/select/url/actor-reference/location/timestamp/text 全在集内）
- [x] 关系强度 select 与 AI 派生属性职责分离（人标 vs 推断）
- [x] 交互渠道维度复用现有 events 平面，仅扩 payload + 写时索引，不新增粒子
- [x] ATTIO 对象 1:1 映射无遗漏；18 候选 slug 均有折叠去向
- [x] 单元测试（2026-08-25 已补）：`test/attio-attributes.test.js` 纯逻辑 8 例（19 类型闸门 / A·B·D 桶属性 / 渠道枚举 / applyInteraction 三指针 / 未知渠道抛错）+ `test/interaction-index.test.js` DB 集成 2 例（key_contact 自动边 / interaction_index 写时维护，需 PG@5433）
