# 客户记忆写回租户贯通 · 设计文档

| 项 | 内容 |
|---|---|
| 日期 | 2026-09-10 |
| 输入 | ①`CRM客户记忆未写入-根因排查报告_2026-09-10.md` ②`CRM客户记忆内容分析报告_2026-09-10.md` |
| 版本 | **v1.1**（吸收内容分析报告：新增 R6 投影 / R7 先例自锁 / R1-bis payload 租户提升） |
| 范围决议 | 全量三阶段（C1+C2+C5+C7 → C3 → C4+回填） |
| 存量决议 | 只回填可归属部分，其余保持 system |
| 状态 | 待用户评审（评审通过后方可进入 writing-plans） |

> **v1.1 关键变更**：内容分析报告证明"只修租户只能召回空壳"（投影损失 97%），故 **C7 投影层从可选提升为 P1 必做**；同时发现 **C5 与 `searchPrecedents` 存在冲突**（修归属会断先例），新增 **C8 作为 C5 的强制伴随项**。

---

## §0 结论先行

> **不是"没写"，是"写进了错误的租户、没有客户锚点、且只有决策级触发"。**
> 本报告在排查报告 R1–R4 之外，**新增定位到 R5（决策 mint 路径恒丢租户）**，这是"决策也沉到 system"的真正根因。

| 编号 | 根因 | 代码锚点 | 阶段 |
|---|---|---|---|
| **R1** | `appendMemory` 签名无 `tenantId`，写侧恒落 system；读侧已按租户过滤 | `src/memory/memoryLog.js:26,30` vs `:75` | P1 |
| **R2** | `entity_id` 无解析规则，调用方不传则恒 NULL | `src/memory/memoryLog.js:22-25,32` | P1 |
| **R3** | 记忆沉淀只挂决策落库与决策 SKILL step2，不挂粒子写入 | `src/skills/seed.js:130`、`src/decision/decisionRepo.js:456` | P2 |
| **R4** | agent 未显式调用 `crm-memory-upsert` | 会话记录 | P2（由 C3 消除） |
| **R5（本设计新定位）** | **MCP/executor mint 决策时从不传 `tenantId`** → `autonomyEngine` 恒取 `'system'` | `src/mcp/gateway.js:167`、`src/action/executor.js:67` → `src/decision/autonomyEngine.js:118` → `:234` | P1 |
| **R6（内容分析报告 R5）** | **决策记忆只投影 5 个控制字段**，`trigger_context`（最大 7,049 B）不投影 → 损失 97% | `src/decision/decisionRepo.js:456-457` 硬编码 | **P1** |
| **R7（内容分析报告 R6，本设计修正归因）** | **先例自锁**：升级路径落 `state='HUMAN'`，而先例池只收 `('CONFIRMED','AUTONOMOUS')` → 永不产生先例 → 恒升级 | `src/decision/autonomyEngine.js:311` vs `src/decision/decisionRepo.js:523` | 独立议题（见 §11） |
| **R8** | `capture.js` 订阅 `on('*')`，把 trace 域事件写进业务记忆表（62 万条噪声） | `src/memory/capture.js:24-29`、`src/memory/distillScheduler.js:34` | P3 |

**核心矛盾一句话**：多租户改造只改了读侧、没改写侧 —— 读按租户隔离、写恒落 system，业务租户永远读不到。

> **R6 的决定性意义（来自内容分析报告）**：只修 R1/R2 只能让业务租户"查到自己那条空壳记忆"，召回出来仍是一句 `升级人工：置信度 0.300<阈值 0.7，参考先例 0 条`。**不修 R6，本设计价值大打折扣** —— 故 R6 从"可选"提升为 **P1 必做**。

---

## §1 根因链（逐条代码级证据）

### R1 · 写侧租户缺失
```js
// src/memory/memoryLog.js:26  —— 签名无 tenantId
export async function appendMemory({ topic, kind='event', payload, layer='L-Workspace',
  actor, eventType, ttlDays=30, explicit=false, valueHorizonDays=30, entityId=null }) {
  // :30  INSERT 列不含 tenant_id → 依赖表默认值
  `INSERT INTO crm.memory_log (topic,kind,payload,layer,actor,event_type,ttl_days,entity_id) ...`
}
```
表默认值 `tenant_id TEXT NOT NULL DEFAULT 'system'`（`db/schema.sql:287`）。
读侧已隔离：`rrfSearch` `:75` 加 `tenant_id` 过滤；`crm-memory-read` `src/action/seed-actions.js:1933` 对非 system 租户强制过滤。

**调用点全清单（4 处，均需透传）**：
| 调用点 | 位置 |
|---|---|
| `crm-memory-upsert` handler | `src/action/seed-actions.js:207` |
| `decisionRepo.appendMemoryLog` | `src/decision/decisionRepo.js:472` |
| `captureMemory` | `src/memory/capture.js:11` |
| `edgeWrite` 边写留痕 | `src/decision/edgeWrite.js:33` |

### R2 · 客户锚点缺失
`entity_id` 已于 `db/schema.sql:293/327` 建列并建索引，但**无任何解析规则**。库里非空 `entity_id` 仅 12/631,585。
锚点同源口径已存在：`src/action/seed-actions.js:534` 用 `payload->>'account_id'` 关联商机/联系人到客户 —— 锚点解析必须复用它，不得另立一套。

### R5（新增）· 决策 mint 恒丢租户
```js
// src/mcp/gateway.js:167
const d = await requireDecision(def.decisionScenario, { action, ...params, actor: ctx.actor },
  inferMcpEntities(params), { actor_id: ctx.actor });   // ← opts 无 tenantId
// src/action/executor.js:67  同型
const d = await requireDecision(def.decisionScenario, {...}, inferEntities(...), { actor_id: ctx.actor });

// src/decision/autonomyEngine.js:118
const tenant = opts.tenantId || 'system';   // ← 恒为 system
// :234  createDecision({ ..., tenant_id: tenant })   // 落库
```
`ctx.tenantId` 在两处**均现成可用**（`gateway.js:55` 已有 `const tid = ctx?.tenantId ?? null`；executor `ctx.tenantId`）。
**影响面可控**：`autonomyEngine.js:119-123` 已实现"租户专属场景缺失 → 回退 system 种子场景"，故传租户后无专属场景的租户自动兜底，零破坏。

### R6 · 决策记忆内容投影损失（97%）
```js
// src/decision/decisionRepo.js:455-457
await appendMemoryLog(decision.decision_id, {
  scenario_id, disposition, rationale, business_tier, decider_type,   // ← 硬编码 5 个控制字段
});
```
| 表 | 内容 | 规模 |
|---|---|---|
| `crm.decision.trigger_context` | 客户名 / 商机号 / source_log / docs / bant / scope_risk / 决策链 | 平均 343 B，**最大 7,049 B** |
| `crm.memory_log.payload` | 上述 5 键 | 平均 210 B |

`rationale` 本身也只是引擎模板句（`autonomyEngine.js:312`）：`升级人工：置信度 0.300<阈值 0.7 或 tier=NORMAL 高风险/例外，建议 ESCALATE，参考先例 0 条` —— **零业务语义**。

**现成样板**：全库唯一一条高质量客户记忆（2026-09-04，`kind='customer_memory'`）已是四段式 —— `summary / entities / evidence（带来源与可验证性）/ gaps（未核实项显式标注）`。C7 直接照此形态，不另发明。

### R7 · 先例自锁（本设计修正归因）
内容分析报告把"置信度恒 0.300、先例恒 0 条"归为"决策引擎恒降级"。代码复核显示**真正机制是自锁，而非降级**：

```
冷启动无先例 → coverage=0 → 置信度低 → 升级 HITL
   → autonomyEngine.js:311 落库 state:'HUMAN'
   → decisionRepo.js:523 先例池只收 ('CONFIRMED','AUTONOMOUS')，HUMAN 被排除
   → 该决策永不成为他人先例 → 下一次仍无先例 → 恒升级（自锁）
```
唯一解锁路径是人工回填 disposition（`disposition.js:33` → `state='CONFIRMED'`）。

### R7-bis · ⚠️ 与 C5 修复的冲突（必须同步修）
```js
// src/decision/autonomyEngine.js:209
const precedents = await searchPrecedents(scenario_id, {...}, { k: opts.k || 5 });
//                                                              ↑ 未传 tenantId
// src/decision/decisionRepo.js:511  const { ..., tenantId = 'system' } = opts || {};
// src/decision/decisionRepo.js:524  AND (tenant_id=$3 OR tenant_id='system')
```
当前所有决策都在 `system`，故 `tenantId` 默认 `'system'` 恰好"能用"。**一旦 C5 把决策归到真实租户，而 `searchPrecedents` 仍默认 `'system'`，租户自己的历史决策将全部被先例池排除 —— 修了归属反而断了先例。**
→ **C5 与 C8（`searchPrecedents` 透传 `tenantId`）必须同批发布，不可拆分。**

### R8 · 噪声淹没
`capture.js:24` 的 `on('*')` 订阅 + `distillScheduler.js:34` 的 `emit('trace','memory-distill-run')` 形成自激：蒸馏运行 → 写记忆 → 再被捕获。
`SKIP_DOMAINS` 仅排除 `decision`，未排除 `trace`/`metering`。
内容分析报告实测：**628,631 / 631,616 = 99.53% 是系统 trace**；`layer` 分布中真正的客户层 `customer` 仅 **1 条**。

### R1-bis · payload 内已有租户，只是没提升到列
```
topic:   event:alert:visit_shortfall
payload: {"kind":"visit_shortfall","alert_id":"67f66695-…","tenant_id":"acme-training"}
                                                          ^^^^^^^^^^^^^^^^^^^^^^^^
```
告警类记忆（2,308 条）**payload 里带着真实租户**，但 `memory_log.tenant_id` 列恒 `system`。→ C1 增加"payload 租户提升"兜底链，可零成本救回这批数据归属。

---

## §2 目标 / 非目标

**目标**
1. 任何一次记忆写入都携带正确 `tenant_id`，业务租户可读到自己写的记忆。
2. 客户/商机级记忆带 `entity_id` 锚点，`crm-memory-read` 按客户聚合非空。
3. 粒子写入（事实变更）自动沉淀为记忆，无需依赖调用方记得手动 upsert。
4. 系统 trace 不再污染业务记忆表。
5. 决策归属真实租户，而非恒 system。
6. **决策记忆承载业务语义**（投影率从 3% 提升），召回出来是"T重工 / OP-2026-14126 / 决策链 / 风险项"，而非"升级人工，参考先例 0 条"。

**非目标**
- 不做记忆语义理解 / 摘要生成（保留 payload 原样落库）。
- 不重构 `rrfSearch` 召回算法。
- 不迁移 memory 到独立存储。
- **不删除任何存量数据**（禁 DELETE 铁律）。

---

## §3 硬约束（红线）

| 红线 | 说明 |
|---|---|
| 禁 DELETE | 存量噪声一律 `archived=true` 软删；回填只 UPDATE |
| 不改 `context-routing` | `config_store['context-routing']` / `src/context/routing.js` 禁止任何修改 |
| 不新增粒子类型 | 锚点复用既有 `CRM_ACCOUNT` / `CRM_DEAL` |
| 不破坏多租户隔离 | **明确否决"读侧回退 system"方案**（排查报告方案 C）—— 会把平台记忆混进业务租户 |
| 行业差异化 100% 配置化 | 沉淀规则走 `config_store`，禁在代码里写死字段名/行业字面量 |
| 可选数值参数陷阱 | `tenantId` 缺省判定必须用 `??`，不得用 `\|\|`（`'*'` 等空语义值需显式处理） |

---

## §4 阶段一：正确性（P1 · C1 + C2 + C5）

### C1 · `appendMemory` 租户与锚点类型参数化

**改动点 1** — `src/memory/memoryLog.js:26-34`
```js
export async function appendMemory({ topic, kind='event', payload, layer='L-Workspace',
  actor, eventType, ttlDays=30, explicit=false, valueHorizonDays=30,
  entityId=null, entityType=null, tenantId=null }) {
  const verdict = judgeWorthiness(payload, { explicit, valueHorizonDays });
  if (!verdict.ok) return { ok:false, gate:'worthiness', code:verdict.code, reason:verdict.reason };
  // 租户兜底链（R1-bis）：显式参数 > ctx > payload 内 tenant_id > system（末级 emit trace，绝不静默）
  //   payload 提升可零成本救回 2,308 条告警记忆的归属（其 payload 自带 acme-training 等真实租户）
  let tid = tenantId ?? null;
  if (!tid || tid === '*') tid = payload?.tenant_id ?? null;
  if (!tid || tid === '*') { emit('trace','memory-tenant-missing',{ topic }); tid = 'system'; }
  const r = await queryWrite(
    `INSERT INTO crm.memory_log (topic,kind,payload,layer,actor,event_type,ttl_days,entity_id,entity_type,tenant_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [topic,kind,payload,layer,actor,eventType,ttlDays,entityId,entityType,tid]);
  return { ok:true, row:r.rows[0] };
}
```
**设计取舍**：默认回退 `'system'` 而非 fail-closed —— 存量 60+ 调用点零改动即可兼容；同时 emit trace 让"缺租户"可观测、可巡检补齐。Fail-closed 版本留作后续 `MEMORY_STRICT_TENANT=1` 开关。

**改动点 2** — `db/schema.sql` 尾追加（DDL 单一事实源）
```sql
ALTER TABLE crm.memory_log ADD COLUMN IF NOT EXISTS entity_type TEXT;
CREATE INDEX IF NOT EXISTS idx_crm_memory_log_anchor ON crm.memory_log(tenant_id, entity_type, entity_id, created_at);
```
`entity_type` 用于区分锚点是客户还是商机，**避免 id 语义混杂**（`entity_id` 单列无法判断指向哪张业务对象）。

**改动点 3** — 4 个调用点全部透传（见 §1 表）

### C2 · 客户锚点解析（单一事实源）

新增 `src/memory/anchor.js`（纯函数，可单测，无 DB）：
```js
export function resolveEntityAnchor({ explicit = null, ctx = {}, payload = {}, type = null, id = null } = {}) {
  // ① 显式 entityId 最高优先
  if (explicit) return { entityId: explicit, entityType: ctx.entityType || inferType(explicit) };
  // ② ctx 推导（决策上下文已带 deal_id / account_id）
  if (ctx.account_id) return { entityId: ctx.account_id, entityType: 'ACCOUNT' };
  if (ctx.deal_id)    return { entityId: ctx.deal_id,    entityType: 'DEAL' };
  // ③ 粒子语义（同源口径：seed-actions.js:534 payload->>'account_id'）
  if (type === 'CRM_ACCOUNT') return { entityId: id, entityType: 'ACCOUNT' };
  if ((type === 'CRM_DEAL' || type === 'CRM_CONTACT') && payload?.account_id)
    return { entityId: payload.account_id, entityType: 'ACCOUNT' };   // 客户记忆优先锚客户
  if (type === 'CRM_DEAL' && id) return { entityId: id, entityType: 'DEAL' };  // 无客户归属时退商机
  return { entityId: null, entityType: null };   // 调用方 emit trace memory-anchor-missing
}
```
**锚点语义决策**：客户记忆的长期价值在于跨商机累积，故 `CRM_DEAL`/`CRM_CONTACT` 一律**优先锚客户**，仅在无 `account_id` 时才退锚商机。与 `crm-account-360`（`seed-actions.js:534`）同源。

### C5 · 决策 mint 租户贯通

| 位置 | 改动 |
|---|---|
| `src/mcp/gateway.js:171` | `{ actor_id: ctx.actor }` → `{ actor_id: ctx.actor, tenantId: ctx.tenantId }` |
| `src/action/executor.js:67` | 同上 |

**安全性论证**：`autonomyEngine.js:119-123` 已实现租户场景查询 + system 兜底，故传租户后：
- 租户有专属场景 → 用租户场景（更准）
- 租户无专属场景 → 回退 system（与现状一致，零回归）

**不做的事**：不调整 `decision_scenario` 的播种归属（`PARTICLE_UPDATE` 等仍为 system 模板），交由既有懒克隆/兜底机制处理。

### C8 · `searchPrecedents` 租户透传（**C5 的强制伴随项**）

| 位置 | 改动 |
|---|---|
| `src/decision/autonomyEngine.js:209` | `searchPrecedents(scenario_id, {...}, { k: opts.k \|\| 5 })` → 追加 `tenantId: tenant` |

**不可拆分理由**：见 R7-bis。C5 单独上线会让业务租户的先例检索瞬间归零（其决策已不在 system），比不修更糟。二者必须同批发布、同批验证。

---

### C7 · 决策记忆投影层（R6 · P1 必做）

**目标**：把 `trigger_context` 的业务要素投影进记忆 payload，从 210 B / 5 键升级为结构化四段式。

**改动点 1** — 新增 `src/memory/projection.js`（纯函数，可单测，无 DB）
```js
export function projectDecisionMemory({ decision_id, scenario_id, disposition, business_tier,
  decider_type, rationale, trigger_context = {}, involved_entities = [], conditions_evaluated = [] }) {
  const keys = readProjectionConfig();               // 配置化白名单，禁硬编码业务键
  return {
    summary:  buildSummary(rationale, trigger_context, keys),        // ≤200 字一句话
    entities: extractEntities(involved_entities, trigger_context, keys),  // 客户/商机/产品/决策链
    evidence: extractEvidence(trigger_context, conditions_evaluated, keys), // 带来源与可验证性
    gaps:     extractGaps(conditions_evaluated, trigger_context),    // 未核实项显式标注
    // 控制字段保留（向后兼容既有消费方，不删字段只加字段）
    scenario_id, disposition, business_tier, decider_type, rationale,
  };
}
```
四段式形态**照抄全库唯一那条高质量记忆**（`kind='customer_memory'`，2026-09-04）：
```json
{ "summary": "…两跳链路…",
  "entities": { "我方": {…}, "G培训机构": {…} },
  "evidence": [ {"id":"F1","来源":"用户陈述","类型":"事实","可验证性":"高"} ],
  "gaps": ["吴老师档期确认(单点风险)"] }
```

**改动点 2** — `src/decision/decisionRepo.js:456` 改为调用投影：
```js
await appendMemoryLog(decision.decision_id, projectDecisionMemory({ ...decision, trigger_context, involved_entities, conditions_evaluated }), { tenantId });
```

**四条硬约束**
| 约束 | 规则 |
|---|---|
| 配置化 | 投影键白名单走 `config_store['memory-decision-projection']`（system 模板 + 租户覆盖）；默认覆盖 `deal_id/opportunity_no/account_name/stage/amount/scope/decision_chain/docs/source_log` |
| 体积上限 | payload ≤ 4 KB，超限截断并记 `truncated:true`（防 7 KB 全文入库拖垮检索） |
| 敏感过滤 | 投影前过 `judgeWorthiness` 的 `CREDENTIAL_RE`（`src/memory/judge.js:2`），凭证类键一律剔除 |
| 锚点同源 | `entityId` 由 `involved_entities` + `trigger_context.account_id/deal_id` 经 C2 的 `resolveEntityAnchor` 解析，不另立规则 |

**不改的东西**：`topic`（保持 `decision:<id>`，既有检索依赖）、`layer`（保持 `L-Workspace`）、`kind`（保持 `decision`）—— 只加字段不删字段，避免破坏既有消费方。

---

## §5 阶段二：自动化（P2 · C3 粒子写入自动沉淀）

### 触发点
`src/action/seed-actions.js` 的 `data-particle-create`（:73）与 `data-particle-update`（:610）handler **成功返回前**异步调用：
```js
void captureParticleMemory({ type, id, payload: after, before, tenantId: ctx.tenantId, actor: ctx.actor })
  .catch((e) => { emit('trace','particle-memory-capture-failed',{...}); recordFailure(...); });
```
**异步 + fail-open**：不阻塞业务写、不因记忆失败回滚主写（`capture.js:27` 同范式）。

### 规则配置化（`config_store['memory-capture-rules']`）
```json
{
  "enabled": true,
  "dedupeWindowHours": 24,
  "rules": [
    { "type": "CRM_DEAL",    "fields": ["stage","amount","decision_chain","expected_close_date"], "topic": "deal:field-change" },
    { "type": "CRM_ACCOUNT", "fields": ["industry","business_tier","named_owner"],                "topic": "account:profile-change" },
    { "type": "CRM_CONTACT", "fields": ["role_in_decision","decision_power"],                     "topic": "contact:role-change" }
  ]
}
```
- 读取走 `readConfig('memory-capture-rules', { tenantId })`（`src/config/configStore.js:51`），system 为模板、租户可覆盖 —— 符合"行业差异化 100% 后台配置化"铁律。
- 未配置 / `enabled:false` → 不沉淀（保守默认）。

### 三重防雪崩（必须，重演 distill 62 万条即是教训）
1. **闸门**：`judgeWorthiness`（`src/memory/judge.js:50`）—— credential 硬拒 + 瞬态噪声拒 + 价值视界 <30 天拒。
2. **字段级 diff**：仅当规则声明字段的**值发生变化**才记录（`before` vs `after`）。
3. **去重窗口**：同 `(tenant_id, entity_id, topic, field, new_value)` 在 `dedupeWindowHours` 内已有记录 → 跳过。

### 落库形态
```js
appendMemory({
  topic: 'deal:field-change', kind: 'fact', layer: 'L-Workspace',
  payload: { type, id, field, from: before[field], to: after[field], actor },
  tenantId, ...resolveEntityAnchor({ type, id, payload: after }),
  explicit: true,           // 事实变更属高价值，豁免价值视界闸
  ttlDays: 180,
});
```

### 规则按 Agent 职责域分工
沉淀规则不是一张大表，而是**按 6 个 Agent 的领域事实拆分**——各 Agent 只对自己产出的事实负责（与 `agentSpec.js` 名册一致，规则键 `memory-capture-rules.<domain>`）：

| Agent | 契约键 | 沉淀事实域 | 示例字段 |
|---|---|---|---|
| `intake-router` | `ct-intake-route` | 客户建档 / 画像 / 商机创建 | `CRM_ACCOUNT.industry`、`CRM_DEAL.stage` |
| `followup-agent` | `ct-followup` | 拜访与跟进事实 | `CRM_ACTIVITY.outcome`、`next_action` |
| `quote-engine` | `ct-quote-calc` | 报价与折扣变更 | `CRM_QUOTE.amount`、`discount_rate` |
| `review-gate` | `ct-review-gate` | 评审闸门结论 | `review_gate.verdict`、`conditions` |
| `decision-retro` | `ct-retro-decision` | 决策复盘结论 | `root_cause`、`lesson` |
| `decision-agent` | `ct-decision` | 决策记忆主链（C1/C2/C5） | `decision:*` |

**理由**：单一大表规则会让"谁对这条记忆的质量负责"无法追溯；按域拆分后，每个 Agent 的 `success` 可独立判定，闭环回写（`feedback.json`）能定位到具体域。

---

## §6 阶段三：治理（P3 · C4 + 回填）

### C4 · 噪声隔离
1. **源头切断** — `src/memory/capture.js`：把 `SKIP_DOMAINS`（黑名单，:5）**改为白名单** `ALLOWED_DOMAINS = new Set(['particle','deal','approval','quote','account'])`，默认拒绝更安全；透传 `event.tenantId`。
2. **自激解除** — `distillScheduler.js:34` 的 trace 事件不再进入记忆表（白名单外自动丢弃）。
3. **存量归档**（禁 DELETE）：
```sql
UPDATE crm.memory_log SET archived=true WHERE archived=false AND topic LIKE 'event:trace:%';
```
4. **可观测** — 新增 trace `memory-capture-skipped-domain`，统计被白名单拦截量。

### C6 · 存量可归属回填（只 UPDATE）
```sql
-- dry-run 前置：先跑 SELECT count(*)，确认影响面后再执行
UPDATE crm.memory_log m SET tenant_id = d.tenant_id
  FROM crm.decision d
 WHERE m.topic = 'decision:' || d.decision_id AND m.tenant_id='system' AND d.tenant_id <> 'system';

UPDATE crm.memory_log m SET tenant_id = p.tenant_id
  FROM crm.particles p
 WHERE m.entity_id = p.id AND m.tenant_id='system' AND p.tenant_id <> 'system';
```
- **边界**：无可归属信息的（纯 trace、无 entity 的 event）保持 `system`，作为平台级记忆层，**不做猜测式归属**。
- 分批执行 + 每批输出行数；脚本 `--dry-run` 默认开启。

---

## §7 兼容性与风险

| 风险 | 评估 | 缓解 |
|---|---|---|
| `appendMemory` 默认租户改动波及 60+ 存量调用点 | 低 | 默认回退 system，行为与现状完全一致；新增 trace 仅观测 |
| 新增 `entity_type` 列 | 低 | `ADD COLUMN IF NOT EXISTS`，可为 NULL，存量行不受影响 |
| C5 改变决策归属 | 中 | `autonomyEngine:121` 已有 system 兜底；但需在测试库验证 `PARTICLE_CREATE/UPDATE` 场景解析 |
| C3 自动沉淀写爆表 | 中 | 三重防雪崩（worthless 闸 + 字段 diff + 24h 去重窗）；`enabled:false` 可一键关闭 |
| 回填 SQL 大批量 UPDATE | 中 | `--dry-run` 默认开启、分批、只 UPDATE 不 DELETE |
| 存量 63 万条中大部分不可归属 | 已知 | 明确接受：只回填可归属部分，其余留 system |
| **C5 单独上线会断先例** | **高** | C5 与 C8 强制同批发布（见 R7-bis），验收断言必须含"本租户先例可召回" |
| C7 投影把 payload 从 210 B 撑到数 KB | 中 | 4 KB 上限 + `truncated:true`；`memory_log` 已有 `(tenant_id, entity_id)` 索引，新增锚点索引覆盖查询路径 |
| C7 四段式与既有消费方不兼容 | 低 | **只加字段不删字段**，`topic`/`layer`/`kind`/5 个控制键全部保留 |

---

## §8 测试计划

| 层 | 用例 | 断言 |
|---|---|---|
| 单测 | `appendMemory` 租户参数化 | 传 `tenantId:'acme-auto'` → 落库 `tenant_id='acme-auto'`；不传 → `system` 且 emit `memory-tenant-missing` |
| 单测 | `resolveEntityAnchor` 优先级 | 显式 > ctx > payload.account_id > 商机 id > null（5 例） |
| 单测 | `projectDecisionMemory` 四段式 | 输出含 summary/entities/evidence/gaps；凭证键被剔除；>4 KB 输入被截断且 `truncated=true` |
| 单测 | 投影配置化 | 改 `memory-decision-projection` 白名单后投影字段随之变化（禁硬编码验证） |
| 单测 | C8 先例租户 | `searchPrecedents(..., {tenantId:'acme-auto'})` 候选池含本租户行（C5 后不归零） |
| 单测 | capture 白名单 | `domain='trace'` → 不落库；`domain='particle'` → 落库 |
| 单测 | 去重窗口 | 同值 24h 内二次写入 → 新增 0 条 |
| 集成 | `crm-memory-upsert` 租户可见性 | 业务租户写入后，同租户 `crm-memory-read` 可见、system 不可见 |
| 集成 | C5 决策归属 | MCP 以 acme-auto 身份写粒子 → mint 的 `decision.tenant_id='acme-auto'` |
| E2E | 全链路 | 独立实例 `PORT=3100` + 真实 MCP stdio 客户端；**断言 `ok===true`**（项目铁律，避免 `gate=auth_required` 假绿）；`crm-decision-advise` 已知 flaky 需重试 3 次 |
| 回归 | 全量 | 修复后跑全量回归；注意跨会话共享 `crm_native_test` 的并发互 TRUNCATE 伪失败 |

---

## §9 任务分解（含生命契约）

> 契约键取自 `src/agent/contractIds.js`（单一事实源）；`scripts/validate-contract.mjs` 双向断言要求名册类文档覆盖全部 6 个登记 Agent，故 C3 规则按域拆分（见 §5）。

### T1 · C1 + C2 记忆写回内核（租户 + 客户锚点）
```contract-yaml
- task: "C1+C2 记忆写回内核：租户参数化与客户锚点解析"
  agent: decision-agent
  contract_task_id: ct-decision
  skills: [method-decision-execute]
  memory: [decision-agent]
  knowledge_scope: { layers: [L1, L2], maxHops: 3 }
  success: "appendMemory({tenantId:'acme-auto'}) 落库 memory_log.tenant_id='acme-auto'；未传 tenantId 落 system 并 emit memory-tenant-missing；crm-memory-upsert 写 CRM_DEAL 变更时 entity_id=payload.account_id 且 entity_type='ACCOUNT'"
```
**契约说明：** 由 `decision-agent` 承接，调用 `method-decision-execute`、读 `decision-agent` 记忆（L1–L2，≤3 跳）；成功判定为租户列落库正确、缺租户有 trace、锚点按同源口径解析。

### T2 · C5 + C8 决策 mint 租户贯通与先例检索租户透传
```contract-yaml
- task: "C5+C8 决策 mint 租户贯通与 searchPrecedents 租户透传"
  agent: decision-agent
  contract_task_id: ct-decision
  skills: [method-decision-execute, data-particle-read]
  memory: [decision-agent]
  knowledge_scope: { layers: [L1, L2], maxHops: 3 }
  success: "MCP 通道以 acme-auto 身份触发 data-particle-create，mint 出的 decision.tenant_id='acme-auto'；同一租户第二次同类决策时 searchPrecedents 能召回本租户先例（cands 含 tenant_id=acme-auto 的行），且 decision_scenario 解析走租户优先+system 兜底不回归"
```
**契约说明：** 由 `decision-agent` 承接；成功判定为决策归属真实租户、**先例检索未因归属变更归零**、场景解析有兜底。C5 与 C8 不可拆分发布。

### T3 · C7 决策记忆投影层（四段式）
```contract-yaml
- task: "C7 决策记忆投影层：trigger_context 四段式投影"
  agent: decision-agent
  contract_task_id: ct-decision
  skills: [method-decision-execute, data-particle-read]
  memory: [decision-agent]
  knowledge_scope: { layers: [L1, L2], maxHops: 3 }
  success: "决策落库后 memory_log.payload 含 summary/entities/evidence/gaps 四键且含客户名或商机号；payload 体积≤4KB 且超限记 truncated:true；凭证类键被剔除；topic/layer/kind 保持原值不回归"
```
**契约说明：** 由 `decision-agent` 承接；成功判定为投影四段式生效、体积与敏感过滤有效、既有消费方不回归。

### T4 · C3-a 沉淀钩子内核 + 客户/商机域规则
```contract-yaml
- task: "C3-a 粒子写入自动沉淀钩子内核与客户商机域规则"
  agent: intake-router
  contract_task_id: ct-intake-route
  skills: [data-particle-read, method-intake-routing]
  memory: [intake-router, followup-agent]
  knowledge_scope: { layers: [L1, L2], maxHops: 3 }
  success: "data-particle-update 变更 CRM_DEAL.stage 后 memory_log 新增 1 条 tenant_id=本租户且 entity_id=客户 id 的记录；同值重复提交新增 0 条；规则关闭时新增 0 条"
```
**契约说明：** 由 `intake-router` 承接，读 `intake-router` 与 `followup-agent` 记忆；成功判定为自动沉淀生效、去重窗口拦截重复、配置开关有效。

### T5 · C3-b 拜访跟进事实沉淀规则
```contract-yaml
- task: "C3-b 拜访与跟进事实沉淀规则"
  agent: followup-agent
  contract_task_id: ct-followup
  skills: [method-followup-engine, data-particle-read]
  memory: [followup-agent, quote-engine]
  knowledge_scope: { layers: [L1, L2], maxHops: 3 }
  success: "跟进事实写入后按 followup 域规则沉淀，entity_id 锚定客户，24h 内同值重复不新增"
```
**契约说明：** 由 `followup-agent` 承接；成功判定为跟进事实按域规则沉淀且去重生效。

### T6 · C3-c 报价与折扣变更沉淀规则
```contract-yaml
- task: "C3-c 报价与折扣变更沉淀规则"
  agent: quote-engine
  contract_task_id: ct-quote-calc
  skills: [method-quote-engine, data-particle-read]
  memory: [quote-engine, followup-agent]
  knowledge_scope: { layers: [L1, L2], maxHops: 3 }
  success: "报价金额/折扣率变更落 memory_log 且 tenant_id 与 entity_id 非空，报价基线外变更额外标 anomaly=true"
```
**契约说明：** 由 `quote-engine` 承接；成功判定为报价变更沉淀且偏离基线可被标记。

### T7 · C3-d 评审闸门结论 + C4 噪声隔离 + C6 回填
```contract-yaml
- task: "C3-d 评审结论沉淀、C4 噪声隔离与 C6 存量回填"
  agent: review-gate
  contract_task_id: ct-review-gate
  skills: [data-particle-read, method-review-gate]
  memory: [review-gate, intake-router]
  knowledge_scope: { layers: [L1, L2], maxHops: 4 }
  success: "distillScheduler 运行后新增 event:trace:* 为 0 条；存量 event:trace:* 已 archived=true；回填 dry-run 行数>0 且执行后 decision:* 记忆 tenant_id 与 decision 表一致；全程 0 条 DELETE"
```
**契约说明：** 由 `review-gate`（治理类）承接；成功判定为噪声源头切断、存量软删、回填可校验且严守禁删红线。

### T8 · C3-e 决策复盘结论沉淀规则
```contract-yaml
- task: "C3-e 决策复盘结论沉淀规则"
  agent: decision-retro
  contract_task_id: ct-retro-decision
  skills: [decision-retrospective, data-particle-read]
  memory: [decision-retro, review-gate]
  knowledge_scope: { layers: [L1, L2], maxHops: 5 }
  success: "复盘产出的 root_cause/lesson 按 retro 域规则沉淀，锚定原决策 id 且其租户与原 decision 一致"
```
**契约说明：** 由 `decision-retro` 承接；成功判定为复盘结论沉淀且租户与原决策一致。

---

## §10 闭环回写

| task | agent | gap_type | observed | expected | severity |
|---|---|---|---|---|---|
| — | — | — | — | — | — |

（实施后由 `agent-workbench` 运行时写入 `<doc>.feedback.json`，下一轮 P0 吸收）

---

## §11 待办与未决问题

1. **决策租户的历史归属**：本次只修**新写入**；历史 decision 表 acme-consult2=0 的部分是否回填，需单独决策（涉及 `decision_scenario` 归属，超出本次范围）。
2. **`crm-memory-read` 的 admin 语义**：当前 admin（`scopeTenant` → `'*'`）走"不加租户过滤"分支（`seed-actions.js:1933`）；是否应显式收窄，待确认。
3. **`entity_type` 枚举**：`ACCOUNT` / `DEAL` 是否够用，后续是否加 `CONTACT` / `OPPORTUNITY`，视 C3 落地数据再定。
4. **R7 先例自锁（建议独立立项，不在本次范围）**：`state='HUMAN'` 不进先例池导致"永不产生先例 → 恒升级"自锁。修法有二选一 —— ① 先例池纳入 `HUMAN`（放宽召回，风险是低质先例污染）；② 升级决策在人工处置后强制回填 disposition 转 `CONFIRMED`（保质量，依赖流程落地）。**本次不动**，因属决策引擎行为变更，需单独评估；但 C8 已保证租户维度不因本次改动归零。
5. **既存 12 条高质量记忆的锚点是"客户名"而非 id**：09-04 那条 `customer_memory` 的 `entity_id='G培训机构'`，11 条 `deal:*` 锚商机 UUID —— **锚点语义不统一**。C2 新写入统一走 id；存量这 12 条是否做名称→id 归一化，待定（涉及按名匹配，有误并风险）。
6. **C7 投影的 LLM 依赖**：四段式中 `summary` 若需自然语言摘要，当前设计走**规则裁剪**（取 `trigger_context.summary/query` 截断），不引入 LLM 调用（无额外成本与延迟）。若后续要求更高质量摘要，需另立议题（涉及 metering 与配额）。

---

*设计文档 · 证据驱动，所有结论附源码 file:line；遵循 brainstorming → writing-plans → 实施流程，未批准不写实现代码。*
