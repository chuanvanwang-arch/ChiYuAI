# 待办②：底层 particleRepo 强制 decision_id — 影响面评估与方案选型

> 日期：2026-09-03 ｜ 关联：第 0 闸加固闭环（T1–T5.1 已 100% 覆盖业务写链路）
> 性质：**架构级破坏性改造**，未走 brainstorming 批准前不写实现（项目铁律 HARD-GATE）

---

## §0 结论

业务写链路（经 executor 统一 mint 或 handler 内 mint）在 T1–T5.1 已 100% 锚定 `decision_id`。
待办②要求在**底层粒子库**也强制 `decision_id`，属"深度防御"——其价值在于：即使未来新增绕过 action 层的直写，也会被粒子库拦截。

但落地有**结构性破坏性**，不能简单做成 `NOT NULL + 写前 throw`。本报告量化影响面并给出两种可行方案，供 brainstorming 选型。

---

## §1 现状证据（实证，非推断）

### 1.1 粒子表无 decision_id 列
`db/schema.sql:11-25` 定义 `crm.particles` 列：
`id / tenant_id / type / slug / title / state / payload / embedding / content_hash / stable_key / fts / created_at / updated_at`
**无 `decision_id`**。即决策锚点当前**无法持久化到粒子本身**，只能经审计表 `audit_event.decision_id` 间接关联。

### 1.2 repo 形参虚设
`src/particles/particleRepo.js:57` 已预留：
```js
export async function createParticle(type, payload, { tenantId='system', actor=null, enforceNamedOwner=false, requireDecisionId=null, accountGuard=false } = {})
```
但 INSERT（line 91-97）**未使用 `requireDecisionId`**，也未写任何 decision 列。
`recordAudit`（line 102-105）读 `payload.decision_id || null`——证明审计层期望该值存在，但粒子表无列承载，故 `decision_id` 在粒子层丢失。

### 1.3 两条暗路径绕过 repo 形参（改 createParticle 拦不住）
- `src/particles/mintId.js:59` `upsertParticleByStableKey`：直接 `INSERT INTO crm.particles (...)`，不经 `createParticle`。
- `src/portal/ontologyConfig.js:76`：直接 `INSERT INTO crm.particles (type, slug, title, state, payload)`。

---

## §2 调用方分类矩阵（全量 42 写 action + 系统直写）

### 2.1 业务写（应有 decision_id，须透传）— 约 30 处
| 来源 | 调用点 | 当前是否带 decision_id |
|---|---|---|
| `action/seed-actions.js` | data-particle-create:84、proposal:828、order:1070、invoice:38、contract:41、payment:64/73、quote:61、deal-*:624/688/742/782/925/949/1149 | **否**（handler 内 ctx.decision_id 已存在，但未透传 repo） |
| `sales/invoiceService.js` | :38/:52 | 否 |
| `sales/orderService.js` | :44 | 否 |
| `sales/contractService.js` | :41 | 否 |
| `sales/paymentService.js` | :64/:73 | 否 |
| `sales/quoteService.js` | :61/:80 | 否 |
| `sales/importService.js` | :60/:81 | 否 |
| `sales/accountGuard.js` | :74 | 否 |
| `http/namedAccountAssignRouter.js` | :28（注释"决策第0闸"） | 否 |
| `decision/decisionRepo.js` | :272（stop_loss 写回） | 否 |

→ 即便强制 `createParticle` 需要 decision_id，上述业务写**会因未透传而失败**（假绿转硬崩）。

### 2.2 系统直写（无决策语义，强拦即崩）— 约 18 处
| 来源 | 语义 | 为何无 decision_id |
|---|---|---|
| `approval/engine.js` (:158/169/177/186/267/293/345/395) | 审批实例/任务状态机 | 审批流内部状态，无上级业务决策 |
| `approval/flow.js` (:12/16/26/35/43/47/18/84/128) | 审批流定义/版本 | 配置元数据 |
| `assets/upload.js` :106 | 文件资产粒子 | 上传动作非业务决策 |
| `connectors/tenderConnector.js` :53 | 外部采集写商机 | 连接器拉取，EXTERNAL_ENRICHMENT 场景已 HIGH 强制人工复核其*写入*，但 connector 内部 createParticle 不持 decision_id |
| `connectors/connectorActions.js` :38/:78 | 连接器 enrich 账户 | 同上 |
| `decision/methodologyEvidence.js` :100/:110 | 方法论证据知识沉淀 | 决策知识产物，非"由某决策触发" |
| `ontology/vocabulary.js` :29 | 本体词汇粒子 | 知识构建 |
| `particles/lifecycle.js` :31/:34 | 生命周期转换 | 系统转换（可能源于决策，但入口为 system） |

### 2.3 暗路径（§1.3）
`mintId.upsertParticleByStableKey`（批量 upsert 定址）、`ontologyConfig.js` 直插。

---

## §3 破坏性分级

| 方案 | 做法 | 影响 | 风险 |
|---|---|---|---|
| **B 硬强制** | `particles.decision_id NOT NULL` + 写前 `throw if !decision_id` | 2.2 全部系统直写 + 2.3 暗路径**写时 500**，审批流/连接器/本体/知识沉淀全崩 | 灾难性，不可接受 |
| **A 软强制 + 系统豁免（推荐）** | 表加可空 `decision_id` 列；业务写（actor 非 system/connector/ontology/approval）强要求；系统写豁免；暗路径补列 | 仅业务写需透传；系统写零改动 | 中，可控 |

---

## §4 方案 A 落地步骤（若批准）

1. **表迁移**：`ALTER TABLE crm.particles ADD COLUMN decision_id UUID REFERENCES crm.decision(decision_id)` — 写 `db/schema.sql`（第 25 行后）+ 新建迁移脚本（幂等 `ADD COLUMN IF NOT EXISTS`）。历史行 `decision_id=NULL` 永久兼容（历史写本无决策锚点）。
2. **repo 四路径补列**：
   - `createParticle` INSERT 带 `decision_id`（取 `requireDecisionId || payload.decision_id || null`）。
   - `updateParticle` UPDATE 带 `decision_id`（取 `patch.decision_id`）。
   - `mintId.upsertParticleByStableKey` INSERT 带 `decision_id`（参数扩展）。
   - `ontologyConfig.js:76` INSERT 带 `decision_id`。
3. **软强制逻辑**：`createParticle` 内 `if (requireDecisionId && actor 非豁免类) throw`；豁免类 = `actor==null || actor==='system'` 或调用方显式 `systemBypass=true`（approval/connector/ontology/lifecycle 走豁免）。
4. **业务写透传**：约 30 处 handler/service 把 `ctx.decision_id`（action 层）或既有 `payload.decision_id` 透传给 `createParticle/updateParticle` 的 `requireDecisionId`。
5. **回归**：单测 + 审批流/连接器/本体集成测试须仍绿（验证豁免生效）。

---

## §5 建议

- **ROI 视角**：业务写链路在 T1–T5.1 已 100% 经 executor/handler 锚定 `decision_id`，假绿已根除。particleRepo 层强制属"深度防御"，防止**未来**新增绕过 action 的直写漏锚。
- **优先级**：低于已收口的业务写闭环。建议作为**独立后续任务**，不在本轮串行。
- **若做**：选方案 A（软强制 + 系统豁免），切勿硬强制。

---

## §6 待用户决策（brainstorming 一次一问）

请从以下方案选型，批准后进入设计文档（writing-plans）→ 实施：

- **A（推荐）**：软强制 + 系统豁免（表加可空列 + 业务写透传 + 系统写豁免）。可控中风险。
- **B**：硬强制（NOT NULL + 全拦截）。需先改造 40+ 系统直写，成本高、灾难性风险，**不推荐**。
- **C**：暂不做。业务写已 100% 闭环，particleRepo 深度防御 ROI 低，留待后续独立任务。
