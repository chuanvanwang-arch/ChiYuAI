# 多行业配置化元模型设计（L2 彻底零代码）

> 状态：brainstorming P6 设计文档 · 待评审批准
> 日期：2026-09-03
> 范围：CRM-ai-native 平台从「硬编码 CRM」蜕变为「配置驱动多行业平台，CRM 为默认 seed 画像」

---

## §0 背景与目标

用户要求：**不同行业的差异化必须通过后台配置启用，而非新增粒子类型字面量或加域**——否则会污染其它行业租户。
本次设计目标：让任意行业（培训中介、家电、新能源、传统能源…）通过**一份租户级配置画像**即可零代码上线，拥有自有实体、流程、审批、关系与领域计算。

平台现状已证据化核实：

| 层 | 实际形态 | 证据 |
|---|---|---|
| 粒子 `type` 列 | 自由 TEXT，非枚举 | `db/schema.sql:14` |
| 属性 | 动态注册 `meta_attr`，19 种类型有穷集 | `particleModel.js:299-303` `ATTRIBUTE_TYPE_SET` |
| payload | JSONB 自由结构 | 全平台 |
| 关系 | 通用 `edges` 表，`source_type/target_type` 自由 TEXT + `tenant_id` 隔离 | `db/schema.sql:34-47` |
| 类型注册 | ❌ 代码字面量 `PARTICLE_TYPES`（33 个 CRM_* 写死） | `particleModel.js:6-278` |
| 类型校验 | ❌ 只查字面量 | `isParticleType()` `:318-320` |
| 阶段流水线 | ❌ 全局硬编码 S1-S8 | `stageTaxonomy.js:5,28-36,39-45` |
| 审批域 | ❌ 硬编码 5 域 | `seed-actions.js:49-52` `BIZ_DOMAIN` |
| 领域计算 | ❌ CRM 专属代码（价格四级链路） | `src/sales/priceCalc.js:1-41` |
| 配置存储 | ✅ per-tenant + system 回退 | `configStore.js:10,26` `readConfig/writeConfig` |

**关键洞察**：`edges` 表已是行业无关的（无硬编码外键列），关系拓扑**无需改造**即可配置化。真正需改造的是 T1（类型注册）、T2（阶段）、T3（审批域）+ **新增公式引擎（L2）**。

---

## §1 核心原则

1. **配置画像是行业差异的唯一来源**：原型集、属性 schema、阶段流水线、审批域、关系拓扑、领域公式——全部声明于 `config_store` 的 `industry-profile` 键，按 `tenant_id` 隔离。
2. **零新类型字面量、零污染**：不再向 `PARTICLE_TYPES` 加 `CRM_TRAINER`/`TRAINING_PROJECT` 之类的行业 specifics。`isParticleType()` 走「代码字面量 ∪ 配置声明」双源。
3. **CRM 即第一个 seed 画像**：现有 21 处 `CRM_*` 硬编码分支 = "CRM 这身皮肤"；非 CRM 租户用自己的画像，根本不碰它们，行为不变。
4. **改动是加法非重写**：所有机制改造对 CRM 类型短路回原代码路径，仅配置类型走新路径。

---

## §1.5 行业维度：必须彻底去除（借鉴 LightField 的最终定论）

### 调研结论：LightField 没有"行业"这个一等实体
LightField（agent-native CRM）的模型（2026-09-03 调研 lightfield.app/blog + Contrary Research 报告 + LightField API docs）**根本没有"行业"维度，也没有"租户=行业"的硬绑定**：
- **预配置 baseline + 每 workspace 自行演进**：*"schema preconfigured to optimize for a typical sales process… Customers can define custom opportunity stages, account attributes, and relationship types"*（Contrary Research）。
- **per-workspace 数据模型可变**：面对"different customers will likely have different pipelines"，官方答复 *"You can change any field in the data model and pipeline stages in Settings"*（Product Hunt）。
- **对象类型预定义、字段/关系 per-workspace 配置**：API 中 `$` 前缀为 system 字段（`system:true`）、无前缀为 custom 字段（`system:false`）。
- **回溯补填 + AI Fill**：*"As the schema changes, new data is backfilled accordingly"*；字段从原始上下文自动派生。

即：**workspace（租户）是数据模型的边界与所有者；平台只给一个"典型销售流程"baseline；行业差异是租户在其内自行演进 schema 的自然结果，而非平台预置的"行业"实体。**

### 本设计此前的错误：又偷偷把"行业"做成了一等实体
§1.5 早期版本引入 `industry-template:<id>` 作为 system 级"行业模板库"，并在租户画像里加 `industries:[...]` 引用。**这恰恰是把用户最初反对的"行业维度"换了个壳塞了回来**——用户的核心要求是"通过后台配置实现差异化，而不是加域/加行业 specifics"，"行业模板"仍是把行业假设烤进平台。且经 grep 全 src，**平台代码里根本不存在 industry-template / tenant-profile 概念（0 命中）**，纯属设计文档的发明，零成本可纠正。

### 修正后的定义（彻底去行业维度）
1. **架构只有三层，无行业实体**：
   - **universal core**（元核心，稳定、非行业）= {ACCOUNT, CONTACT, OPPORTUNITY, CONTRACT} —— 给 agent 的推理锚点，所有租户共享语义。
   - **per-tenant profile**（配置画像，落 `config_store[tenant-profile]`，按 `tenant_id` 隔离）——声明本租户可见的原型集 / 属性 / 阶段 / 审批 / 关系 / 公式。租户间互不可见。
   - **evolution engine**（演进引擎）—— agent 读原始上下文（对话/邮件）→ 建议 schema 变更草稿 → 决策第0闸 + HITL → 应用 → AI Fill 回填。
2. **行业差异 = per-tenant profile 的自然结果**，不是预置实体。培训中介和家电企业的差别，就是它们各自 profile 演化出来的结果。
3. **行业模板降级为「可选产品加速器」（非架构基元）**：它是 system 命名空间里一份"被标记为 reusable 的 tenant-profile"，新租户可克隆为起点以降 onboarding 门槛；但架构完全不依赖它，创建它 = 写一份 profile + 标 reusable，不是特殊机制。有无它，架构都成立。

### 与 LightField 的关键差异（治理红线，不抄）
| 维度 | LightField | 本平台 |
|---|---|---|
| schema 变更权 | 客户 Settings 自由改、agent 自由建 objects | 必经决策第0闸 + HITL + 审计；agent 仅建议草稿 |
| 删除 | 允许 delete field options | 绝对禁 DELETE（去重走 `merged_into`） |
| 行业维度 | 无（行业是演进结果） | 一并去除（此前误加的行业模板降级为可选加速器） |
| 治理硬粒子 | schema-less 可任意重生 | 报价/合同/审批/决策结构化 + 审计链，不可重生 |

### 解析算法（T1 增量，彻底去行业）
`getParticleDef(type, tenantId)` 可见原型集 = `universal core 代码字面量（4 个）` ∪ `该租户 tenant-profile.prototypes（配置源）` ∪ `租户 override`。`industry-template` 不构成独立来源层；若启用加速器，它只是"预先写好的 tenant-profile 副本"。

## §2 配置画像 Schema（落 `config_store[tenant-profile]`，按 tenant_id 隔离）

```jsonc
{
  "tenantId": "acme-training",            // 业务数据隔离边界（particles/edges.tenant_id）；也是本画像的归属租户
  "prototypes": {                         // 本租户可见原型（per-tenant，零行业维度；下示为继承 universal core 后叠加本地定义的结果）
    "TRAINING_CLIENT": {
      "label": "企业客户",
      "flow": ["lead","diagnosed","proposal","negotiation","signed","delivered","closed"],
      "transitions": { "lead→diagnosed": {}, "diagnosed→proposal": {"gate":"need_diagnosed"} },
      "gates": { "need_diagnosed": {"require": ["training_budget","training_goal"]} },
      "attributes": ["training_budget","training_goal","headcount"],  // 存 payload
      "edgeTypes": ["owns→TRAINING_PROJECT"]
    },
    "TRAINER": { "label":"讲师", "flow":["prospect","onboarded","active","retired"],
                 "attributes":["expertise_domain","daily_rate","available_from","rating"] },
    "TRAINING_PROVIDER": { "label":"培训机构", "flow":["candidate","partnered","active","suspended"],
                 "attributes":["qualification","cooperation_mode"] },
    "TRAINING_PROJECT": { "label":"培训项目",
                 "flow":["lead","need_diagnosed","matched","quoted","confirmed","delivering","closed"],
                 "approvalDomains":["quote","deal"],
                 "attributes":["subject","duration","budget","target"] },
    "TRAINING_CONTRACT": { "label":"合同", "flow":["draft","signed","active","fulfilled","terminated"],
                 "approvalDomains":["contract"], "attributes":["mode","party_a","party_b","amount"] },
    "TRAINING_SETTLEMENT": { "label":"结算", "flow":["pending","calculated","approved","paid"],
                 "approvalDomains":["settlement"], "attributes":["revenue","cost","commission","mode"] }
  },
  "approvalDomains": ["quote","contract","settlement"],   // 扩展 T3 硬编码 5 域
  "calculations": [                                       // ★ L2 公式引擎
    { "id":"settlement_commission",
      "target":"TRAINING_SETTLEMENT.payload.commission",
      "expr":"(revenue - cost) * commission_rate",
      "inputs":["revenue","cost","commission_rate"],
      "trigger":"on_write" }
  ]
}
```

---

## §3 四机制改造（file:line 证据 + 做法）

### T1 类型注册配置化
- 现状：`PARTICLE_TYPES` 字面量 `particleModel.js:6-278`；`isParticleType()` `:318-320` 只查字面量。
- 做法：新增 `getParticleDef(type, tenantId)` 解析器——先查代码字面量（CRM 短路），未命中查 `industry-profile.prototypes[type]`。
- `isParticleType(type, tenantId)` 改走双源；`createParticle` 校验改走 `getParticleDef`。

### T2 阶段流水线配置化
- 现状：`lifecycle.advanceStage` 读 `PARTICLE_TYPES[p.type].states.flow`/`.why`（`lifecycle.js:9,:17`）；全局 `S_STAGES`（`stageTaxonomy.js:5`）。
- 做法：`advanceStage` 改读 `getParticleDef(p.type, tenantId).flow`；per-原型 flow/transitions/gates 来自画像。CRM 仍走 `S_STAGES`，不变。

### T3 审批域配置化
- 现状：`BIZ_DOMAIN` 硬编码 `seed-actions.js:49-52`；`getFlowByDomain(domain, tenantId)`（`flow.js:66`）**已按租户过滤**。
- 做法：`startGradedApproval` 从 `industry-profile.approvalDomains` 读映射（替硬编码 map）；seed 新增 `settlement` 等域流粒子。审批流本身已可配置 + 租户隔离，改造极小。

### T4 关系拓扑（已通用，零改造）
- 现状：`crm.edges`（`schema.sql:34-47`）`tenant_id + source_type/target_type(自由TEXT) + edge_type + meta(JSONB)`，全库无硬编码外键列。
- 做法：画像 `prototypes[*].edgeTypes` 声明允许的关系谓词；通用图查询/展示按原型过滤，零代码。

### L2 公式引擎（★ 本设计新增）
- 现状：领域计算是 CRM 专属代码（`priceCalc.js:1-41` 产品→价格表→报价→合同），无通用公式能力。
- 做法：见 §4。

---

## §4 L2 公式引擎设计（推荐方案 FE-1）

**表示法**：画像 `calculations[]` 存**安全表达式字符串**（`expr`），由**沙箱表达式求值器**解析（禁止 `eval`/`Function`，用受控 tokenizer 或 `expr-eval` 类库，仅暴露白名单算符与画像声明的 `inputs` 变量）。
- 推荐理由：AI/运维可直接"写公式进配置"，表达力强，契合 AI-native 平台；与结构化 calc-graph（FE-2）相比更灵活、与字段映射（FE-3）相比更强。
- **安全**：求值器只允许 `+ - * / ( )`、比较、白名单函数（如 `min/max/round`），变量严格限定为 `inputs` 列表，禁止属性访问/原型调用/IO。

**触发与落库**：
- `trigger: "on_write"`：写粒子后触发 post-write hook，求值后把结果写回 `target`（payload 路径），并 emit 计算事件（审计留痕）。
- `trigger: "on_demand"`：经 `data-particle-calc` action 显式触发。
- 求值失败（变量缺失/表达式非法）→ 走 fail-safe：`emit('trace')` + `recordFailure()`，绝不明面吞错。

**与决策闸协同**：含金额/差价的公式结果若跨阈值，自动挂 `decision_id`（决策第 0 闸），杜绝 off-system 私下定价——延续平台红线。

**借鉴 Lightfield Formula Fields（2026-08-28 上线，直接验证本方向）的两点细化**：
- **(a) 公式即字段类型，非独立块**：Lightfield 把公式作为「自定义字段的一种类型」（`"Custom fields can now be set to use formulas"`），即画像属性声明 `formula` 即表示其值由计算产生、不由人填。本设计 `calculations[]` 独立块可简化为——**原型属性直接带 `formula` 字段**，引擎遍历带 `formula` 的属性求值。更内聚。
- **(b) 跨对象输入**：Lightfield 公式「inputs from fields on **any object** in the CRM」。本设计 `inputs` 应允许跨对象引用（如 `SETTLEMENT.commission` 引用 `PROJECT.budget` + `TRAINER.daily_rate`），而非仅同粒子 payload。`inputs` 元素语法升级为 `<proto>.<field>` 或同粒子 `<field>`。

> 开放决策点（评审时可改）：① 公式表示法选 FE-1 表达式（推荐）/ FE-2 结构化 / FE-3 字段映射；② 公式落点选「属性带 formula」（推荐，对齐 Lightfield）/「独立 calculations[] 块」。本文档默认 FE-1 + 属性带 formula。

---

## §5 三个行业画像实例（验证通用性）

| 行业 | 自有原型 | 关系拓扑（edges） | 审批域 | 公式（L2） |
|---|---|---|---|---|
| **培训中介** | CLIENT/TRAINER/PROVIDER/PROJECT/CONTRACT/SETTLEMENT | CLIENT—owns→PROJECT—uses→TRAINER | quote/contract/settlement | commission=(revenue-cost)*rate |
| **家电企业** | CLIENT/CHANNEL/DEALER/PRODUCT/WARRANTY_CLAIM/REBATE | CLIENT—owns→DEALER—sells→PRODUCT—has→WARRANTY_CLAIM | quote/contract/**rebate** | rebate=base*rate*tier_factor |
| **新能源企业** | CLIENT/PROJECT/EQUIPMENT/OMCONTRACT/SUBSIDY | CLIENT—owns→PROJECT—uses→EQUIPMENT—governed_by→OMCONTRACT | quote/contract/**subsidy** | subsidy=capacity*unit_subsidy |

三者全部复用 T1+T2+T3+edges+L2，**零新类型字面量、零污染、互不可见**。

---

## §6 任务拆分 + 生命契约（每任务可监控）

```contract-yaml
- task: "T0 画像 Schema + 存储层"
  agent: followup-agent
  skills: [data-particle-create, data-particle-read]
  success: "writeConfig('industry-profile', <training 画像>, {tenantId:'training'}) 成功；readConfig 回读一致；校验器报 6 原型+阶段/审批域/公式齐全"
```
```contract-yaml
- task: "T1 getParticleDef 双源解析器"
  agent: followup-agent
  skills: [data-particle-create, data-particle-read]
  success: "isParticleType('TRAINER','training')===true 且 isParticleType('TRAINER','crm')===false（隔离）；CRM 类型行为不变"
```
```contract-yaml
- task: "T2 advanceStage 走 getParticleDef（per-原型流水线）"
  agent: followup-agent
  skills: [data-particle-create, data-particle-read]
  success: "training 项目按配置阶段推进（只进不退+gate）；CRM_DEAL 仍走 S_STAGES 不变"
```
```contract-yaml
- task: "T3 审批域配置化 + settlement/rebate/subsidy 流 seed"
  agent: review-gate
  skills: [data-particle-read]
  success: "training 结算触发 domain='settlement' 审批流（tenant 隔离）；CRM 五域不变"
```
```contract-yaml
- task: "L2 公式引擎（沙箱求值器 + on_write 触发 + 跨对象输入 + 落库/审计）"
  agent: decision-agent
  skills: [data-particle-create, data-particle-read]
  success: "training 结算写 revenue/cost/commission_rate 后自动算出 commission 并落 payload（跨对象引用 PROJECT/TRAINER 也成立）；非法表达式 fail-safe 告警而非假绿"
```
```contract-yaml
- task: "T5 回溯补填（retroactive backfill，借鉴 Lightfield）"
  agent: decision-agent
  skills: [data-particle-create, data-particle-read]
  success: "tenant 在画像新增属性/公式后，对历史粒子按现有 payload/对话上下文回填该属性；回填过程 emit 审计事件、可重跑、fail-safe"
```
```contract-yaml
- task: "T4 端到端验证（training 租户跑通 6 原型 + 公式 + 审批）"
  agent: decision-agent
  skills: [data-particle-create, data-particle-read]
  success: "training 租户建 讲师/项目/结算、按配置阶段推进、结算触发审批+自动算差价；crm 租户不可见 training 原型；零代码新增"
```

---

## §7 隔离 / 零污染保证 + 风险

- **隔离**：`getParticleDef` 带 `tenantId`；training 原型在 `crm` 租户 `isParticleType` 返回 false。审批流 `getFlowByDomain` 已 tenant 过滤。edges 带 `tenant_id`。
- **零破坏**：CRM 的 21 处 `CRM_*` 硬编码分支对 CRM 类型走代码字面量短路，行为不变；仅新增配置路径给非 CRM 租户。
- **风险①**：`PARTICLE_TYPES[p.type]` 直接访问点（particleRepo/metaAttr/validator 等）需统一改走 `getParticleDef`——仅配置类型走配置分支，CRM 短路，改动是加法。
- **风险②**：bespoke 富 UI（account-360 等）硬编码 `CRM_*`；非 CRM 行业首版用**通用粒子视图 + 配置化表单/列表**，bespoke 页后续按需建设。
- **风险③（L2 新增）**：公式引擎安全边界——须严格沙箱，变量白名单 + 禁 IO/原型访问；非法表达式 fail-safe，杜绝"假绿"。

---

## §8 验收标准（可判定）

1. `training` 租户：`isParticleType('TRAINER','training')===true`，`isParticleType('TRAINER','crm')===false`。
2. `training` 项目按画像阶段推进（只进不退 + gate 校验）；`CRM_DEAL` 在 `crm` 租户仍走 `S_STAGES` 不变。
3. `training` 结算粒子写 `revenue/cost/commission_rate` 后，自动算出 `commission` 落 payload，并触发 `domain='settlement'` 审批流。
4. `crm` 租户对 `training` 原型不可见、不可建、不可查；反之亦然。
5. 全程零新增 `PARTICLE_TYPES` 字面量、零触碰 21 处 `CRM_*` 硬编码分支。

---

## §10 借鉴 Lightfield（同构问题 + 6 项可借鉴点）

### 10.1 Lightfield 遇到的正是同一个问题
Lightfield 创始团队（Tome 原班）在 `code-execution` 文（2026-02-16）中明确点出 schema-first CRM 的结构性缺陷：
> "Schema-first CRMs track what you tell them to track, in the format you specified, at the moment you specified it. They don't capture why a deal moved… That context is critical for an agent to reason about your business."

其解法与本项目「配置画像差异化」**高度同构**：
- **底层 = schema-less 记忆**：`"ground truth = raw, unstructured customer conversations… accessed via the relationship graph. The CRM data model with objects and fields is layered on top"`，对象/字段是**可再生成的视图层**。
- **Custom Objects（用户/agent 自定义对象类型）**：`"Custom Objects now supports one-to-many relationships… the agent can also create objects, manage schemas, and set up those relationships for you"`（2026-05-15）——直接验证本设计 T1（配置化原型注册）。
- **Formula Fields（2026-08-28 刚上线）**：`"Custom fields can now be set to use formulas to calculate values using inputs from fields on any object"`——直接验证本设计 L2，并给出「公式即字段类型 + 跨对象输入」两个细化（见 §4）。
- **回溯补填**：`"If you've spoken about it in your conversations, it's easy enough to backfill"`——新加字段自动从历史上下文回填（见 T5）。
- **Agent 数据模型工具**：`"The CRM agent is now able to read your data model configuration and suggest draft data model changes"`（2026-03-27）——agent 建议 schema 变更草稿。
- **代码执行**：agent 写 Python 沙箱运行做重计算/产物（2026-02-16）。

### 10.2 机制映射（验证 / 扩展）

| 机制 | Lightfield | 本设计 | 判定 |
|---|---|---|---|
| 自定义对象类型 | Custom Objects | T1 `getParticleDef` 双源 | ✅ 同构，验证 |
| 可配置属性 | NL 定义属性 | meta_attr + payload 属性 | ✅ 同构 |
| 关系拓扑 | relationship graph | `edges` 表（已通用） | ✅ 同构 |
| 公式字段 | Formula Fields（跨对象+字段即类型） | L2（细化见 §4） | ✅ 同构+借鉴细化 |
| 回溯补填 | backfill from conversations | **T5（新增）** | ➕ 借鉴补齐 |
| Agent 改 schema | 建议草稿式变更 | 扩展决策第0闸到画像变更 | ➕ 借鉴补齐 |
| 重型计算 | 沙箱 Python | L2 简单表达式+预留代码执行路径 | 🔶 借鉴为扩展路径 |

### 10.3 值得借鉴补进设计的 6 点
- **A. 回溯补填（最关键）**：tenant 在画像新增属性/公式后，对历史粒子按现有 payload/上下文回填。支持「先上线后补字段、数据不丢」，是 schema-less 灵活性的核心红利。→ 新增 **T5**。
- **B. 跨对象公式输入**：公式 `inputs` 允许 `<proto>.<field>` 跨对象引用（结算引用项目+讲师费率）。→ 已写入 §4(b)。
- **C. 公式即字段类型**：属性声明 `formula` 即计算产生，比独立 `calculations[]` 块更内聚。→ 已写入 §4(a)。
- **D. schema-less 记忆层（治理下适配）**：保留结构化 substrate 做治理关键粒子（报价/合同/审批/决策），但每个粒子可承载「原始上下文」payload，行业专属 messy 上下文不必先定义字段。对齐 Lightfield「原始对话为 ground truth、结构化字段可再生成」理念，但不走向全 schema-less（见 10.4）。
- **E. Agent 建议 schema 变更草稿 + HITL**：agent 读画像后建议变更草稿，经决策第0闸/人类审批生效——把现有写闸延伸到「schema 变更」。
- **F. 沙箱代码执行为重型公式路径**：对复杂行业计算（返利分档、补贴矩阵），L2 简单表达式之外预留「沙箱代码执行」步骤。记为扩展路径，非 MVP。

### 10.4 我们刻意不抄的点（治理更严，正确）
Lightfield 是 schema-less + AI 高度自主；本项目是 **B2B 销售治理平台**（决策第0闸、零信任写闸、绝对禁 DELETE、审计留痕）。全 schema-less 会瓦解治理关键粒子的结构化与审计链。因此**「结构化 substrate + 配置化 schema 视图」是正确适配**，而非照抄全 schema-less。Lightfield 的「公式/自定义对象/回溯补填」可借鉴，其「放弃结构化、全凭对话 ground truth」不可抄。

---

## §11 LightField 隔离与多行业适配的机制（追问对齐）

用户追问：LightField 无「行业」维度、无「租户=行业」绑定，它如何做到隔离与多行业适配？元模型如何承接？在哪里启用与配置？以下为机制层对齐（证据来自 lightfield.app/blog、docs.lightfield.app、Contrary Research 报告）。

### 11.1 隔离：靠「工作区边界 + 逐对象隐私」，不靠「行业」
- **工作区 = 租户边界**：每个 workspace 持有自己的 objects / fields / stages 定义；API `GET /v1/{objectType}/definitions` 返回的是**该工作区**的对象 schema（含 `$` 系统字段 + 无前缀自定义字段），不同客户 schema 天然隔离。
- **逐对象隐私模型**：`"Lightfield was built with a per-object privacy model from the beginning. Any email, account, or object can take on a unique privacy/visibility setting. The LLM can only see what each user can see"`（Contrary Research）。
- **字段级区分**：`$` 前缀 = 系统字段（`system:true`），无前缀 = 自定义字段（`system:false`）；二者在 definitions 端点共存于同一对象类型下。
- 对齐本项目：`tenant_id`（schema.sql:13,36 落 particles/edges/tasks）即工作区边界；逐对象隐私可映射为「per-粒子角色可见性」，属治理增强项。

### 11.2 多行业适配：靠「baseline + 每工作区演化」，不靠「行业维度」
- **baseline 预置**：`"schemas are preconfigured to optimize for a typical sales process (account, contact, opportunity, custom object)… Customers can define custom opportunity stages, account attributes, and relationship types"`（Contrary Research）。
- **每工作区演化**：`"different customers will likely have different pipelines! You can change any field in the data model and pipeline stages in Settings"`（Product Hunt 官方答复）。即行业差异 = 数据模型演进的**自然结果**，非一等实体。
- **agent 驱动演化**：`"the agent can also create objects, manage schemas, and set up those relationships for you"`；`"as the schema changes, new data is backfilled accordingly"`。
- 关键结论：LightField 证明**元模型不需要「行业」一等实体**；适配 = per-tenant 演化。本项目 §1.5 的「system 级行业模板 + 租户启用/override」是**叠加在 baseline+演化之上的 onboarding 加速器**（降 B2B 垂直行业启动门槛），与 LF 机制不矛盾、可共存。

### 11.3 元模型如何承接：三层 + 「结构化层是派生视图」
- **Layer 0（ground truth）**：`"ground truth = raw, unstructured customer conversations… accessed via the relationship graph"`（code-execution, 2026-02-16）——原始对话/邮件/会议为真相源。
- **Layer 1（半结构化业务图）**：`"Lightfield organizes customer data as a semi-structured business graph… a network of people, who work at companies, that have said things to each other"`。
- **Layer 2（对象/字段，派生层）**：`"The CRM data model with objects and fields is layered on top of that, making it possible to arbitrarily generate values for it any time"`——结构化层可**任意重生 + 回溯补填**，这是其元模型「零成本承接任意行业」的根本原因。
- **元模型具体形态**：3 个固定核心对象（account/contact/opportunity）+ 任意 custom object（用户定义）；字段 15+ valueType（TEXT/NUMBER/CURRENCY/SINGLE_SELECT/MULTI_SELECT/DATETIME/ADDRESS/FULL_NAME/EMAIL/URL/SOCIAL_HANDLE/MARKDOWN/HTML/CHECKBOX/TELEPHONE）；关系 HAS_ONE/HAS_MANY + 自由 target `objectType`；每个字段带 NL 定义 + 可设 `AI Fill` 自动填充。
- 对齐本项目：自由 `type`(TEXT) + `meta_attr`(19 类型有穷集) + payload(JSONB) + `edges`(自由 source/target type) 比 LF 的「3-core + custom」**更开放**；但须 T1 把类型校验从代码字面量改配置，才真正达到「任意原型零代码」。

### 11.4 在哪里启用与配置：三个入口
1. **Settings UI（人）**：`"change any field in the data model and pipeline stages in Settings"`（Product Hunt）。
2. **API / SDK / MCP（开发者）**：definitions 端点发现 schema、创建 custom object / fields；public beta REST + Python/TS/Go SDK + CLI + MCP（docs.lightfield.app）。
3. **Chat agent（自然语言/自主）**：agent 读画像、建议 schema 变更草稿、按 NL 定义字段、设 AI Fill 自动填充（code-execution / enhancements 文）。
- 对齐本项目：Settings = `config_store` 写入 + 管理 UI；API = 决策第0闸下的 MCP 写工具（两阶段 + HITL）；chat = agent 建议 schema 草稿 → 决策第0闸 → 审计生效。

### 11.5 对本设计的最终启示
- LF 验证：元模型无需「行业」一等实体；隔离靠 workspace + per-object 隐私；适配靠 baseline+演化；元模型靠「schema-less ground truth + 派生结构化层」。
- 本项目 §1.5 已**彻底去除行业维度**：行业模板从"架构基元"降级为"可选产品加速器"（system 命名空间里一份可克隆的 tenant-profile）。核心始终是 universal core + per-tenant 画像 + 演进引擎，与 LF 同构。
- **治理红线不抄 LF**：LF 的「结构化层可任意重生」依赖 schema-less ground truth；本项目的治理硬粒子（报价/合同/审批/决策）结构化**不可随意重生**，故「行业模板 + 配置画像」是正确 B2B 适配，而非照抄全 schema-less（见 §10.4）。

---

## §12 LightField 元模型价值的深度理解 + 本平台借鉴路线（追问收敛）

用户追问：须真正理解 LF 元模型「3 核心 + 任意 custom + 15+ valueType + HAS_ONE/HAS_MANY + NL 定义 + AI Fill」的**价值**，并落到本平台如何借鉴。深挖本平台代码后发现一个关键事实：**这些原子能力 80% 已存在于 `crm.meta_attr` 表**，只是被锁死在 33 个 `CRM_*` 硬编码类型里、从未收敛成行业无关形态。

### 12.1 元模型五项价值的本质（不是功能清单，是「为什么这样设计」）

| # | 能力 | 真正的价值（为何如此设计） | 无它则怎样 |
|---|------|--------------------------|-----------|
| V1 | **3 固定核心对象** | 给 agent 一个**稳定的推理锚点**——account/contact/opportunity 永远存在且语义已知，agent 不 drowning 在任意对象里 | agent 面对纯任意对象，无法导航/推理/跨业务泛化 |
| V2 | **15+ valueType** | 类型携带**语义**→ 驱动校验、UI 渲染、格式化、公式计算、agent 理解（"这是货币""这是日期"） | 全是 TEXT，无法计算/渲染/校验，meta 模型只是"灵活"而非"智能" |
| V3 | **HAS_ONE/HAS_MANY 基数** | 让关系图成为**有约束的系统**而非扁平袋子：可强制约束、图遍历、级联语义 | 关系无约束，图退化成无意义的边集合 |
| V4 | **NL 字段定义** | 字段**自描述**→ agent 无需预读文档即可理解字段意图；治理评审可读 | 字段名即天书，agent/人无法理解任意字段 |
| V5 | **AI Fill 自动填充** | **最关键**：关闭「schema-less truth ↔ 结构化层」的环。任意新字段若靠人手工填就毫无价值；AI Fill 从原始上下文（对话/文档）自动派生→字段真正可用 | 任意字段是"死字段"，新行业建模因手工填鸭而不可行 |

**元价值（V0）**：结构**可涌现、非预设**。行业从未成为一等实体，因为模型**构造上即行业无关**——从一个最小核心长出，业务+agent 用 NL 定义生长 schema，AI Fill 持续从原始上下文回填结构化层。

### 12.2 本平台已具备的原子能力（证据，颠覆"需从零建元模型"的假设）

`crm.meta_attr`（`schema.sql:345-368`）已原生承载 V1-V5 的大部分：

| LF 能力 | 本项目现状 | 证据 |
|---------|-----------|------|
| 15+ valueType | ✅ **已有 19 种**（`text/currency/percent/select/multi-select/date/timestamp/rating/url/record-reference/...`） | `meta_attr.attr_type`(`schema.sql:350-352`) + `ATTRIBUTE_TYPE_SET`(`particleModel.js:299-303`) |
| NL 字段定义 | ✅ **已有** `description TEXT` | `meta_attr.description`(`schema.sql:356`) |
| AI Fill | ✅ **已有** `source IN ('manual','ai','enrich','automatic')` | `meta_attr.source`(`schema.sql:358`) |
| 逐属性隐私 | ✅ **已有** `permission JSONB` | `meta_attr.permission`(`schema.sql:361`) |
| 版本化 | ✅ **已有** `version` + `enabled` 开关 | `meta_attr.version/enabled`(`schema.sql:362-363`) |
| 校验/展示 | ✅ **已有** `validation JSONB` / `display JSONB` / `options JSONB` | `meta_attr:357,359,360` |
| 关系自由 target | ✅ **已有** `source_type/target_type` 自由 TEXT | `edges`(`schema.sql:37,40`) |

**结论**：我们不是"要建 LF 的元模型"，而是"**已拥有其 80% 原子，只需收敛（convergence）**"——这把路线图从"大重构"降级为"解锁 + 激活"。

### 12.3 真正缺失的 3 处（决定借鉴路线）

| 缺口 | 现状 | 代价 | 借鉴动作 |
|------|------|------|---------|
| **G1 无通用核心** | `PARTICLE_TYPES` 是 33 个 `CRM_*` 扁平字面量（`particleModel.js:6-278`），universal 原语（account/contact/opportunity/contract）与 CRM 专属阶段逻辑**混在一起** | T1 双源仍把"CRM"当唯一核心，行业对象只能"套 CRM 皮" | **抽出 universal core** = {ACCOUNT, CONTACT, OPPORTUNITY, CONTRACT} 作为元核心（稳定、非行业）；其余（TRAINER/PROJECT/SETTLEMENT）归 custom。T1 代码字面量 = 4 个核心，配置 = custom——大幅收敛硬编码面（33→4） |
| **G2 无配置驱动 custom object** | `meta_attr` 按 `particle_type` **全局建**，无 `tenant_id` 列（`schema.sql:345-346`）→ 加"讲师报价"属性会全局可见 | 行业差异化属性无法 per-tenant 隔离，污染其它租户 | **tenant 级 meta_attr 或 payload 承载**：行业专属属性走 `payload` JSONB（每粒子隔离、天然零污染，见前 §7）；跨行业通用属性才进 `meta_attr`；或给 `meta_attr` 加 `tenant_id` 列做 tenant 级属性 schema |
| **G3 无关系基数** | `edges` 无 `cardinality` 列（`schema.sql:34-44`），只有 `edge_type` 受控谓词 | 关系无约束，图退化成无边集合，无法强制 HAS_ONE/HAS_MANY | **加 `cardinality` 列 + 枚举**（`'one'|'many'`），在 `edge_type` 定义层声明基数，创建边时校验；这是最小 DDL 改动 |
| **G4 关系谓词硬编码** | `CONTROLLED_PREDICATES`（`particleModel.js:306-315`）是写死的谓词清单（belongs_to/owned_by/.../has_technical_proposal/key_contact/...），新增"培训-讲师""机构-供应"等关系须改代码 | 关系词汇被锁死，比 LF 的 `HAS_ONE/HAS_MANY` + 自由 target **更不灵活**——这是又一处"领域 specifics 写进代码"，应一并配置化而非按行业预定义 | **谓词可配置扩展**：把 `CONTROLLED_PREDICATES` 改为「代码基线谓词 ∪ 租户 profile 声明的 edgeTypes」；创建边时校验走这个并集。与 G1 同构——基线保留通用谓词，行业关系走配置 |

### 12.4 借鉴路线（治理适配版，按价值排序）

1. **B1 收敛 universal core（对应 G1）**：把 ACCOUNT/CONTACT/OPPORTUNITY/CONTRACT 从 33 个 `CRM_*` 中提升为**元核心**（可保留 `CRM_` 命名、但语义上归为"通用业务原语"而非"CRM 行业"）。精炼 T1：`isParticleType` 的"代码字面量"只留这 4 个核心，`getParticleDef` 的"配置源"承接所有 custom 对象。治理收益：硬编码面 33→4。
2. **B2 激活已有的 AI Fill（对应 G2 + V5）**：`meta_attr.source='ai'|'automatic'` 已存在但未被引擎化。建 **AI Fill 引擎**：agent 读原始上下文（对话/文档）→ 派生 `source='ai'` 字段 → 经**零信任写闸 + HITL（高 tier）+ 审计**落库。此即把前 §6 的 T5 回溯补填**泛化为持续自动填充**，并吸收 LF 的 V5 价值。
3. **B3 加关系基数（对应 G3 + V3）**：`edges.cardinality` DDL + `edge_type` 定义层基数声明 + 创建校验。把图从"无边集合"升级为"有约束系统"。
4. **B4 tenant 级属性隔离（对应 G2）**：行业专属属性走 `payload` 或给 `meta_attr` 加 `tenant_id`；确保"配置即差异化"零污染。
5. **B5 治理包裹（不抄 LF）**：所有 schema 变更（新 custom 对象 / 新属性 / 新 AI Fill 规则 / 基数变更）必经**决策第0闸 + HITL + 审计**；AI Fill 写经零信任写闸；绝对禁 DELETE（去重走 `merged_into`）。

### 12.5 路线变化结论（重要）

本设计原本把重点放在 L2 公式引擎 + T2/T3 上；§12 揭示**元模型原子（valueType/NL/AI Fill/隐私/版本）已就位**，故真正工作量收敛为：
- **必须新建**：G1 核心收敛 + G3 关系基数（小 DDL）+ G4 谓词配置化（小）+ G2 tenant 隔离（小）
- **必须激活（非新建）**：G2 的 AI Fill 引擎（已有 `source` 列，需引擎化）
- **仍按原 §4 做**：L2 公式引擎（V2 的延伸，值计算）
- **T2/T3（阶段/审批配置化）不变**

→ 总工作量较原估计**显著下降**，且根基更稳：我们是在"已具备的元模型原子"上做收敛，而非从零造一个。这与 LF "元模型构造上行业无关"的元价值同构。

---

## §13 LightField 如何实现 WORKSPACE 隔离（追问）

用户追问：LF 的 workspace 隔离在存储/架构层到底怎么落地？深挖 Contrary Research 报告、现场 demo 复盘（nowletus）、SourceForge 播客后，结论：**LF 的隔离不是存储分区（独立库/tenant 列），而是「应用层单一 API 权限模型 + 逐对象可见性 + LLM 上下文按权限裁剪」**。

### 13.1 LF 隔离的五层机制（证据）

| 层 | 机制 | 证据 |
|---|------|------|
| **L0 共享存储底座（非分区）** | 单一 schema-less 基础层，CRM schema 叠在其上；**无 per-tenant 独立库** | `"everything is stored at a foundational level, with a CRM schema sitting on top"`（nowletus 现场 demo 数据治理段）；数据可携/易导出（"you should own your data"、"make it as easy as possible to get your data out"）暗示逻辑可分离、非物理分区 |
| **L1 workspace = 租户/所有权单元** | 每客户 = 1 workspace；per-workspace `definitions` 端点返回该 workspace 的 schema；行业差异是 schema 演进结果 | API docs：每 objectType 独立 definitions 端点；Contrary："different customers will likely have different pipelines" |
| **L2 单一 API 强制所有访问（核心）** | agent、外部系统、UI **全经同一 LightField API**；rate limit 与数据访问权限在 API 层统一强制；agent 继承其人类调用者的**完全相同**权限 | `"the agent, external systems, and the UI all run through the same Lightfield API. Rate limits and data access are enforced there. An AE executing code is bound to the exact same permissions an AE already has. The agent can't do what the human couldn't"`（nowletus）；`"Permissions are the unlock for letting agents run"` |
| **L3 RBAC + 逐对象可见性（细粒度）** | **RBAC 落在每一条数据上**；每对象（邮件/账户/记录）有独立隐私/可见性设置；admin/member 角色；"LLM 只能看每个用户被授权看的对象" | `"Role-based access control sits on every piece of data"`（nowletus）；`"Lightfield supports per-object privacy with admin and member roles, ensuring that both LLMs and users can only access objects they have explicit permission to view"`（Contrary） |
| **L4 LLM 上下文按权限裁剪（AI-native 关键）** | agent 的工作上下文**只组装当前用户被允许看的对象**；跨权限数据对 agent 不可见 | CEO 例：`"when a regular user is on Lightfield, the agent is unaware of the emails the CEO has privately shared with the CRM"`（Contrary）——隔离对 agent 真正生效，而非仅 UI |

**合规基座**：SOC 2 Type 1（Type II + HIPAA 进行中）；集成走 OAuth 标准 scope（不共享凭证）；`"we never share customer data with model providers for training"`（SourceForge 播客 Matt Serna）。

### 13.2 与本平台隔离机制对标

| 维度 | LightField | 本平台（CRM-ai-native） | 判定 |
|------|-----------|------------------------|------|
| 隔离层级 | **应用层**（单一 API 强制 + 逐对象可见性） | **存储层 + 应用层双保险** | 我方在存储边界更强 |
| 存储分区 | 共享 schema-less 底座（非分区） | 业务表带 `tenant_id` 列（`schema.sql:13,36` 落 particles/edges/tasks） | 我方有行级租户 |
| 租户上下文传递 | API 层统一注入 caller 权限 | `ctx={tenantId,actor,role}` 贯穿 executor/agentLoop（`executor.js:42`、`agentLoop.js:62`） | 同构 |
| 配置隔离 | per-workspace definitions | `config_store(tenant_id,key)` + system 回退（`configStore.js:10-31`） | 同构 |
| 细粒度可见性 | **逐对象/逐字段**可见性 | 仅 **tenant 级**；逐字段隐私雏形在 `meta_attr.permission JSONB`（未全面启用） | **我方缺细粒度** |
| agent 权限继承 | agent=caller 权限（不可越权） | token→actor+role，不直达 Action ctx（crm-native 专家规约） | 同构且我方更严（加决策第0闸+HITL） |

**诚实差距**：我方 tenant 隔离虽为行级，但**并非所有查询都一致强制**——`insightService.js:236` 硬编码 `tenant_id='system'`，说明 tenant 过滤依赖 ctx 线程 + 纪律，与 LF 的"单一 API 强制"思路相近、非 DB 层硬隔离。这是治理隐患，应在配置化改造时一并补强（统一在 data 访问层注入 tenant，而非散落各 query）。

### 13.3 从 LF 借鉴的隔离增强（治理适配）

1. **B-LF1 LLM 上下文权限裁剪（最关键）**：agent 做检索/RAG/粒子图组装时，**按当前 actor 的 role + 可见性过滤**，只喂入被授权看的对象/字段。这是 AI-native 版的"LLM 只能看用户能看的对象"，当前本平台检索可能未做逐对象/逐字段裁剪 → 须补。
2. **B-LF2 逐对象/逐字段可见性（细粒度）**：扩展 `meta_attr.permission` 为全面启用的字段级可见性，并给 particle 加 `visibility` 字段，支持 workspace 内"某商机毛利仅经理可见"等场景（补 §13.2 缺口）。
3. **B-LF3 agent=caller 权限（已同构，写进设计）**：把"agent 继承调用者权限、不可越权"显式写入配置画像治理规约。
4. **B-LF4 数据访问层统一注入 tenant（补强我方隐患）**：配置化改造时，将 tenant 注入从散落 query 收敛到 data 访问层统一强制，消除 `insightService.js:236` 式硬编码漏洞。

**不抄 LF**：共享 schema-less 底座（治理硬粒子需结构化+审计存储，保留行级 `tenant_id`）；agent 自由建 schema（我方经决策第0闸+HITL）。

---

## §14 直接回答三个追问（是否需要行业模板 / 是否需按行业预定义 / 为何不学 LF）

> 本节直接回应 2026-09-03 15:39 的追问，结论已落地到 §1.5 / §2 / §12.3 的修订。

### Q1：还需要行业模板吗？
**架构上：不需要。** 架构只需要三层——① universal core（4 个稳定原语，语义上"通用业务"而非"CRM 行业"）；② per-tenant profile（配置画像，per-tenant 隔离）；③ evolution engine（agent + AI Fill + 决策第0闸）。
**产品上：行业模板只是"可选加速器"**——它是 system 命名空间里一份"被标记为 reusable 的 tenant-profile"，新租户可克隆以降 onboarding 门槛。创建它 = 写一份 profile + 标 reusable，不是特殊机制；有无它，架构都成立。把行业模板从"架构基元"降级，是本次修订的核心纠偏。

### Q2：还需要按行业提前定义与配置吗？
**不需要，且这正是用户最初反对的污染。** 按行业提前定义 = 把"培训有 TRAINER/PROJECT/SETTLEMENT""家电有 CHANNEL/REBATE"这类行业假设烤进平台，与"加域/加粒子类型"同属一类污染。
**正确做法（与 LF 同构）**：从 universal core + 极简 baseline 起步，per-tenant 由 agent + AI Fill 演进。agent 读原始上下文（对话/邮件）→ 提议 schema（新原型/属性/公式/阶段/谓词）→ 草稿 → 决策第0闸 + HITL → 应用 → AI Fill 从原始上下文回填。行业差异是演进的自然结果，不是预置实体。

### Q3：为什么不能借鉴 LF？
**能，而且此前学得不彻底——这正是本次纠偏的原因。** 具体遗漏：
- 我此前留了"行业维度"（industry-template）没去除 → 本次去除；
- 我此前漏看 `CONTROLLED_PREDICATES`（`particleModel.js:306-315`）——关系谓词也是硬编码清单，比 LF 的 `HAS_ONE/HAS_MANY` 自由 target **更不灵活**，属又一处"领域 specifics 写死"，须一并配置化（G4）；
- 我此前把"行业模板"当架构层 → 降级为可选加速器。

**但有 3 个真实约束，导致不能 100% 抄 LF（这是架构约束，非借口）：**
1. **治理硬粒子不可"任意重生"**：报价/合同/审批/决策带审计链（`decision_provenance` / `provenance_seal` / `calibration_patch.decision_id`），LF 的"结构化层可任意重生"依赖 schema-less ground truth，我们不抄——保留结构化 substrate + 配置化 schema 视图。
2. **已有 33 个 CRM_* 沉淀资产**：不抛弃，收敛为"默认 baseline profile"（= LF 的 typical sales baseline）；可 OPTIONALLY 抽成 system seed profile，但那是重构非必需。
3. **隔离保真度**：我们存储层 `tenant_id` 比 LF 应用层更强，但缺逐对象/字段细粒度可见性 → 学 LF 的 LLM 上下文权限裁剪（§13.3 B-LF1/B-LF2），不抄其 schema-less 底座。

**结论**：LF 的可学之处（universal core + 配置化元模型 + AI Fill 闭环 + per-tenant 演进 + 无行业维度）已全部吸收并落地到本设计；不可学之处（schema-less 自由重生、agent 自由改 schema、共享无分区底座）因治理与已有资产约束而明确不抄。行业模板的去除，使本设计真正与 LF 同构。

---

## §15 精确审计：「20% 到底差在哪」——隔离维度的结构性缺口（2026-09-03 16:00 关键纠偏）

> 本节直接回应「我们平台 20% 到底差在哪 / 能否真正零代码按租户全隔离」之问。**结论：此前"80% 已具备"的乐观表述偷换了概念——我把"属性能力"（valueType/NL/AI Fill 列/permission）算作已具备，却忽略了让这些能力"按租户隔离"所必需的"租户维度"，这才是缺失的 20%，且是结构性的、非配置能补。**

### 15.1 层状审计：哪些层有 tenant_id，哪些没有（file:line 证据）

| 存储层 | 表 | 有 `tenant_id`？ | 隔离现状 |
|---|---|---|---|
| 业务粒子 | `particles` | ✅ 有（`schema.sql:13`，`particleRepo.js:102,150` `WHERE tenant_id=$1`） | **已隔离**（依赖 ctx 正确传 tenant） |
| 关系 | `edges` | ✅ 有（`schema.sql:36`，`particleRepo.js:226,251`） | **已隔离** |
| 任务 | `tasks` | ✅ 有（`schema.sql` tasks 段，mem） | **已隔离** |
| 配置 | `config_store` | ✅ 有（per-tenant + system 回退，`configStore.js:10`） | **已隔离** |
| **元模型属性** | `meta_attr` | ❌ **无**（`schema.sql:345-368`，列仅 `particle_type/attr_slug/...` 无 tenant） | **全局共享**——培训租户加"讲师报价"属性，所有用 KNOWLEDGE 类型的租户都可见 |
| **客户记忆·日志** | `memory_log` | ❌ **无**（`schema.sql:229-236` 创建即无；`:260-279` ALTER 也只加 layer/actor/entity_id，**无 tenant**） | **完全无租户隔离**——`memoryLog.js:44,47,77` 查询仅按 `topic`/`entity_id` 过滤，**零 tenant 条件** |
| **客户记忆·快照** | `memory_snapshot` | ❌ **无**（`schema.sql:282-289`） | **全局** |
| **客户记忆·笔记** | `memory_note` | ❌ **无**（`schema.sql:292-300`） | **全局** |

**核心发现（颠覆前序乐观）**：业务数据层（particles/edges）已具备行级 `tenant_id`，但**元模型层（meta_attr）与记忆层（memory_log/snapshot/note）完全没有 tenant 维度**。而 AI Fill、自适应登记、客户记忆召回全部构建在这两层之上——它们继承的是**全局作用域**。所以"按租户完全隔离数据权限 + 客户记忆全隔离"今天**并未实现**，与"通用 CRM 单租户"假设一致，但**不满足多租户差异化隔离**。

### 15.2 自适应机制其实已存在——只是全局的

平台**已有 LF 式"写优先、schema 后至"的自适应登记**（`particleRepo.js:111` 写钩子调用 `ensureAdaptiveRegistration` → `metaAttrRepo.js:94-115`）：写入粒子时若 payload 出现 meta_attr 未登记的键，自动推断类型并登记一行（`source='ai'`、`enabled=false`）。这正是 LF 的 self-adaptation。

**但它是全局的**：`particleRepo.js:111` / `:188` 调用写死 `actor='system'`、且**未传 tenantId**；`ensureAdaptiveRegistration` 函数签名也无 tenant 参数。故 tenantA 与 tenantB 对同类型粒子写入新键时，meta_attr 行**共享**，tenantB 可见 tenantA 的自适应属性——**无隔离**。

### 15.3 「零代码按租户全隔离」的真伪

- **"零新代码（每行业）"**：✅ **可达成**。一旦通用 substrate 就位，新增行业/租户 = 仅配置画像 + 业务数据驱动自适应，无行业专属代码。
- **"零新代码（ altogether）"**：❌ **不可达成**。因为 meta_attr + memory_log 缺 tenant_id，必须做 DDL 加列 + 访问层按 tenant 过滤——这是**真实平台代码**，只是**通用、写一次、服务所有租户**，非 per-industry。

**诚实结论**：20% = 给元模型层与记忆层补齐"租户维度"（≈4 文件 + 3 张表加列），属小而真实的平台代码，非"翻配置即生效"。此前"80% 已具备"应修正为：**属性能力 80% 已具备，但其"按租户隔离"的 20% 是结构性缺口**。

### 15.4 必须补的 20%（精确清单）

| # | 改造 | 文件:行 | 性质 |
|---|------|--------|------|
| 20.1 | `meta_attr` 加 `tenant_id` 列 + 索引 | `schema.sql:345` ALTER 段 | DDL |
| 20.2 | `memory_log`/`memory_snapshot`/`memory_note` 加 `tenant_id` 列 | `schema.sql:229/282/292` ALTER 段 | DDL |
| 20.3 | `ensureAdaptiveRegistration` 接收并带 tenantId，按租户登记 | `metaAttrRepo.js:94` + `particleRepo.js:111,:188` | 代码 |
| 20.4 | `getMetaAttr`/`listMetaAttr`/`setMetaAttr` 过滤 tenant | `metaAttrRepo.js:55,67,73` | 代码 |
| 20.5 | `memoryLog.js` / `timelineSource.js` 查询加 tenant 过滤 | `memoryLog.js:44,47,77` / `timelineSource.js:145` | 代码 |
| 20.6 | 访问层统一注入 tenant（修 `insightService.js:236` 硬编码 `system`） | `insightService.js:236` | 代码（治理隐患补强） |
| 20.7 | `meta_attr.permission` 逐字段可见性按 tenant 生效 | `metaAttrRepo.js` + 查询层 | 代码 |

> 注：G1（核心收敛）/G3（关系基数）/G4（谓词配置化）属"灵活性"缺口（让自适应能发生），与本节"隔离"缺口正交——两者共同构成真正的 20%。

---

## §16 收口：实施任务总表（合并 G1-G4 + §15 隔离 + L2 公式 + AI Fill）

> brainstorming 已收敛。本设计从「加域」经多轮纠偏，最终落在 **universal core + per-tenant profile + evolution engine，无行业维度、无行业模板依赖**。下面把全部改造点合并为 6 个可独立交付、可独立测试的实施 Phase，作为 writing-plans 的输入。

### 16.1 阶段总览

| Phase | 名称 | 对应章节 | 核心改造 | 验收（可判定） | 依赖 |
|---|---|---|---|---|---|
| **P0** | 元模型层 tenant 隔离（DDL） | §15.4 (20.1-20.2) | `meta_attr`+`memory_log`/`snapshot`/`note` 加 `tenant_id` 列 | 三表 DDL 成功；旧数据回填 `tenant_id`（默认 `system`） | 无 |
| **P1** | 访问层按租户过滤 | §15.4 (20.3-20.7) | `ensureAdaptiveRegistration` 带 tenantId；`metaAttrRepo`/`memoryLog`/`timelineSource`/`insightService` 过滤 tenant | tenantA 自适应属性/记忆对 tenantB 不可见；`insightService` 不再硬编码 `system` | P0 |
| **P2** | 类型注册双源 + universal core 收敛 | §3 T1 + §12.3 G1 | `getParticleDef(type,tenantId)` 解析器；`isParticleType` 字面量收敛到 4 core；其余走配置 | `isParticleType('TRAINER','training')===true`、`('TRAINER','crm')===false`；CRM 类型行为不变 | P0 |
| **P3** | 关系基数 + 谓词配置化 | §12.3 G3/G4 | `edges.cardinality` DDL；`CONTROLLED_PREDICATES` → 「基线 ∪ profile.edgeTypes」 | 创建边按基数+谓词并集校验；training 关系走配置、不碰代码 | P0 |
| **P4** | L2 公式引擎 | §2 calculations + §4 | 沙箱表达式求值器 + `on_write` 触发 + 落 payload + 审计 | settlement 写 revenue/cost/rate 自动算 commission；非法表达式 fail-safe 告警 | P2 |
| **P5** | AI Fill 引擎激活 | §12.4 B2 + §6 T5 | 引擎化 `meta_attr.source='ai'`：读原始上下文→派生→零信任写闸+HITL→落库 | 新加属性经 AI Fill 从对话自动派生并回填；逐对象可见性按 tenant 生效 | P1 |

### 16.2 关键不变量（贯穿所有 Phase）

1. **零污染**：任意行业/custom 对象属性走 `payload` JSONB 或 `meta_attr.tenant_id`，其它租户天然不可见。
2. **CRM 行为不变**：P2 收敛 core 时，21 处 `CRM_*` 硬编码分支对 CRM 类型走代码字面量短路路径，行为零破坏。
3. **治理护栏**：schema 变更（新 custom 对象/属性/公式/AI Fill 规则）必经 **决策第0闸 + HITL + 审计**；AI Fill 写经零信任写闸；**绝对禁 DELETE**（去重走 `merged_into`）。
4. **TDD + 每 Task 一 commit**：每 Phase 内先写失败测试→实现→通过→commit；AI 不代 commit。

### 16.3 实施顺序建议

**P0 → P1 优先**（这是用户最关心的「按租户全隔离数据权限 + 客户记忆全隔离」的 20%，且是其它 Phase 的前置）。P2-P5 可并行推进，但建议 P2 先于 P4（公式引擎依赖 `getParticleDef` 读 prototypes）。

---

> 后续：**writing-plans** 已据此产出详细分任务实施计划（含完整代码、命令、验收），存于 `docs/superpowers/plans/2026-09-03-multi-industry-meta-model.md`。
