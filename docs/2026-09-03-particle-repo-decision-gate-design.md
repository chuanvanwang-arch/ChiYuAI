# 待办② 详细设计：底层 particleRepo 强制 decision_id（方案 A 软强制 + 系统豁免）

> 日期：2026-09-03 ｜ 关联：影响面评估 `docs/2026-09-03-particle-repo-decision-gate-impact.md`（已选方案 A）
> 状态：**已批准并实施（T10–T14 收口，2026-09-03）** — 77 文件 / 534 测试全绿，零破坏

---

## §0 目标边界

- **目标**：粒子表持久化 `decision_id`，使"深度防御"生效——即使未来新增绕过 action 层的直写，也被粒子库拦截（无决策不写）。
- **非目标**：不改动业务写链路的既有锚定（T1–T5.1 已 100% 覆盖）；不强制系统直写带决策（走豁免）。
- **硬约束**：遵循 `db/migrate.js` §4.5 铁律——新列**双轨落点**（schema.sql CREATE 段供新库 + migrate.js ALTER 供旧库/生产），禁只改一处。

---

## §1 表迁移（T10）

### 1.1 schema.sql（新库）
`db/schema.sql:11-25` 的 `CREATE TABLE IF NOT EXISTS crm.particles` 段第 24 行（`updated_at` 后）加：
```sql
  decision_id UUID REFERENCES crm.decision(decision_id),  -- 深度防御：写第0闸强制携带（无决策不写，系统写豁免为 NULL）
```

### 1.2 migrate.js（旧库/生产，幂等）
仿 line 67-69 stable_key 模式，在 memory_log/decision_relation 段之后（或 decision 9列段附近）追加：
```js
// 待办②（2026-09-03）：particles.decision_id 深度防御列（新库走 schema.sql，旧库/生产走此 ALTER）
await pool.query(
  `ALTER TABLE crm.particles ADD COLUMN IF NOT EXISTS decision_id UUID REFERENCES crm.decision(decision_id)`
).catch((e) => { console.error('[migrate] particles.decision_id 补列失败:', e.message); throw e; });
```
> 历史行 `decision_id=NULL` 永久兼容（历史写本无决策锚点，不行回填）。

---

## §2 repo 四路径补列 + 软强制（T11）

### 2.1 createParticle（particleRepo.js:57-121）
- 形参：`requireDecisionId` 已存在（line 57），新增 `systemBypass=false`。
- INSERT（line 91-97）加列与值：
```js
`INSERT INTO particles (tenant_id, type, slug, title, state, payload, decision_id)
 VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
[tenantId, type, def.slug, displayName || def.title, payload.state || def.states.current, JSON.stringify(payload), decisionId || null]
```
其中 `const decisionId = requireDecisionId || payload.decision_id || null;`
- **软强制**（INSERT 前，line 90 后）：
```js
const isSystem = !actor || actor === 'system' || systemBypass === true;
if (requireDecisionId && !decisionId && !isSystem) {
  throw new Error(`createParticle(${type}) 缺 decision_id（业务写须经第0闸 mint）`);
}
```
> 仅当调用方**显式要求**（requireDecisionId 非 null）且**非系统豁免**且**无值**才抛。历史 `requireDecisionId=null` 的调用方（当前全部）不受影响 → 零破坏默认。

### 2.2 updateParticle（particleRepo.js:146-185）
- UPDATE（line 161-164）加 `decision_id=$4`：
```js
`UPDATE particles SET payload=$1, state=$2, decision_id=$3, updated_at=now() WHERE id=$4 RETURNING *`,
[JSON.stringify(newPayload), state || cur.state, patch.decision_id || cur.decision_id || null, id]
```
> 策略：patch 带 decision_id 则更新（首次锚定），否则保留既有（不覆盖为空）。`recordAudit`（line 169-172）已读 `patch.decision_id`，无需改。

### 2.3 mintId.upsertParticleByStableKey（mintId.js:53-67）
- 参数扩展 `{ ..., decision_id = null }`，INSERT（line 58-64）加列：
```js
`INSERT INTO crm.particles (tenant_id, type, slug, title, payload, state, stable_key, decision_id)
 VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8) ...`
```
> 该路径为批量 upsert 定址（系统/导入用），默认 decision_id=null（导入经 crm-import-batch 已带 decision_id 可传）。

### 2.4 ontologyConfig.js:76 直 INSERT
- INSERT 加 `decision_id` 列，值 `NULL`（本体配置写属系统级，豁免）。

---

## §3 系统直写豁免判定（T13）

豁免三条件（任一即免）：`actor==null || actor==='system' || systemBypass===true`。
分类标注：

| 调用方 | 豁免方式 |
|---|---|
| `approval/engine.js` `approval/flow.js` | 默认 actor 不传 → null → 自动豁免；无需改 |
| `assets/upload.js:106` | 默认 actor=a.actor（可能非 system）→ 传 `systemBypass:true`（上传非业务决策） |
| `connectors/tenderConnector.js:53` | 传 `systemBypass:true`（外部采集） |
| `connectors/connectorActions.js:38/78` | 传 `systemBypass:true` |
| `decision/methodologyEvidence.js:100/110` | 传 `systemBypass:true`（知识沉淀） |
| `ontology/vocabulary.js:29` | 传 `systemBypass:true` |
| `particles/lifecycle.js:31/34` | 传 `systemBypass:true`（系统转换） |
| `portal/ontologyConfig.js:76` | INSERT 直写 decision_id=NULL（已豁免） |
| `mintId.upsertParticleByStableKey` | 默认 decision_id=null（已豁免） |

> 关键：上述系统写**不传 `requireDecisionId`**（保持 null）→ `isSystem` 决定不抛。仅业务写传 `requireDecisionId=ctx.decision_id` 触发强制。

---

## §4 业务写透传（T12，约 30 处）

原则：业务写调用方**已持有 `decision_id`**（action handler 经 T1–T5.1 mint 得 `ctx.decision_id`），只需透传到 `createParticle/updateParticle` 的 `requireDecisionId`。

| 层 | 透传点 | 做法 |
|---|---|---|
| action handler | `seed-actions.js:84/828/1070/38/41/64/73/61/624/688/742/782/925/949/1149` | handler 内 `createParticle/updateParticle` 加 `requireDecisionId: ctx.decision_id` |
| sales service | `invoiceService.js:38/52`、`orderService.js:44`、`contractService.js:41`、`paymentService.js:64/73`、`quoteService.js:61/80`、`importService.js:60/81`、`accountGuard.js:74` | service 函数签名加 `decisionId`，调用处传 `requireDecisionId: decisionId`；handler 调 service 时传 `ctx.decision_id` |
| 指名指派 | `namedAccountAssignRouter.js:28` | 路由入口已注释"决策第0闸"，透传 `requireDecisionId` |
| 决策写回 | `decisionRepo.js:272`（stop_loss） | 此处持有 decision_id（决策内），透传 |

> 实施时逐处确认上游是否真持 `ctx.decision_id`；若不持（纯内部调用），传 `systemBypass:true` 而非伪造。

---

## §5 测试（T14）

- **单测** `test/particles/particleRepo-decision-gate.test.js`：
  - 业务写（actor='alice', requireDecisionId=null）→ 不抛（默认豁免，向后兼容）
  - 业务写（actor='alice', requireDecisionId 但无值，非 system）→ 抛 `'缺 decision_id'`
  - 系统写（actor='system' 或 systemBypass=true, requireDecisionId 设但无值）→ 不抛，decision_id=NULL
  - createParticle 带 decision_id → 落库 decision_id 命中
- **回归**：`test/approval/ test/connector/ test/ontology/ test/decision/`（验证豁免生效，系统写零破坏）
- **广回归**：`test/action/ test/sales/` 全绿（业务透传不丢 decision_id）

---

## §6 提交拆分（禁 git add -A，署名 `Co-Authored-By: 王川 <watchm@163.com>`）

| commit | 文件 |
|---|---|
| T10 迁移 | `db/schema.sql` + `db/migrate.js` |
| T11 repo 四路径 | `src/particles/particleRepo.js` + `src/particles/mintId.js` + `src/portal/ontologyConfig.js` |
| T12 业务透传 | `src/action/seed-actions.js` + `src/sales/*.js` + `src/http/namedAccountAssignRouter.js` + `src/decision/decisionRepo.js` |
| T13 系统豁免 | 同上系统调用方（与 T12 可合并一处 commit） |
| T14 测试+文档 | `test/particles/particleRepo-decision-gate.test.js` + 审计报告 + 本设计文档 |

---

## §7 Living Contract（验收标准）

- [ ] `crm.particles` 含 `decision_id` 列（新库 schema + 旧库 migrate ALTER 双轨生效）
- [ ] 业务写（actor 非 system + requireDecisionId 设）缺 decision_id → 抛错（深度防御）
- [ ] 系统直写（approval/connector/ontology/lifecycle/asset）零破坏（豁免生效）
- [ ] 约 30 处业务写透传 `ctx.decision_id` 后落库 decision_id 非空
- [ ] 单测 + 审批/连接器/本体/决策集成回归全绿
- [ ] 历史数据 `decision_id=NULL` 兼容，不回填

---

**请审批此设计。批准后进入 T10–T14 实施（每 Task 一 commit）。**
