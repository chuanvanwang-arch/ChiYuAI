# 上下文分层 L1-L4 设计文档（阶段 2 · 首个子系统）

> 所属：青羽企业AI销售决策平台（CRM-ai-native）· 阶段 2 认知+智能体层
> 上游：决策事件主轴已落地（D1–D5，`src/decision/*`、`db/schema.sql` 8 表）
> 下游：记忆三构件 / Action 写白名单 / 门户 NL→Page / 预警反馈回路（均复用本设计的统一注入面）
> 方法论挂载：`ai-context-layering`（L4 治理决策层实例）
> 状态：**已批准（2026-08-25）+ 实施完成**（T1–T8 提交 c9f83fc→a7afe9c；纯逻辑 9 例本地绿，11 例 DB 集成需 PG 就绪环境运行；本沙箱无 PG，待用户环境 `node db/migrate.js --seed` 后全量验收）
> 状态：**已批准（2026-08-25）**，待 writing-plans

---

## 0. 目标与范围

把"角色该看什么、该做什么、该带什么上下文"提升为一等公民：

- **角色 = 上下文注入配置**（七要素：核心关注 / 默认查询偏好 / L2C 工作流 / KPI 基准线 / 跨角色协作 / 权限边界 / 角色内子类型）。
- **L1–L4 注入分层**：知识底座(L1) / 历史决策(L2) / 执行协同(L3) / 治理决策(L4)，垂直贯穿智能体调用与写通道。
- **双注入点**：① executor 第 1 闸（permission boundary，数据范围强制）；② agentLoop（LLM prompt 上下文注入）。
- **检索通道 + 降级链**：L1 向量失效自动降级 L2→L3→L4，agent 永不因上下文缺失而崩。

**三段验收锚点（全要）**：
1. 数据范围闸：销售只读自己商机、经理读团队子树、exec 全量，越界写读被拒。
2. LLM 上下文注入：同句"业绩"经理带团队范围、销售带个人范围，prompt 差异可观测。
3. 检索降级链：L1 向量/FTS 失效时自动降级，返回 `degraded:true` 且不崩。

**不做（YAGNI）**：不引图/语义引擎；不新增第 11 个 ai-* 能力（本设计是 `ai-context-layering` 的阶段 2 实例化，不突破 10 能力基线）；组织树仅支持 `parent_id` 单父层级（不含多父/矩阵）；per-person profile 覆盖留接口（本版仅角色级 profile）。

---

## 1. 数据模型（§D1）

### 1.1 新增表 `role_context_profile`（`db/schema.sql`）

```sql
CREATE TABLE IF NOT EXISTS crm.role_context_profile (
  role_tag         TEXT PRIMARY KEY,
  seven_elements   JSONB NOT NULL,   -- 七要素完整承载
  data_scope       JSONB NOT NULL,   -- {model, domain?}
  retrieval_cfg    JSONB NOT NULL,   -- {l1,l2,l3,l4:{enabled,topk}}
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_role_profile_scope
  ON crm.role_context_profile USING gin (data_scope);
```

`seven_elements` 结构（每个角色必填七键）：
```json
{
  "core_focus":        "核心关注（如 个人商机推进/团队达标/回款健康）",
  "default_query_pref": "默认查询偏好（如 按 owner 过滤/按 org 子树/全量）",
  "l2c_workflow":      "L2C 工作流阶段重点",
  "kpi_baseline":      "KPI 基准线（如 胜率/客单价/回款周期）",
  "cross_role_collab": "跨角色协作边界（如 销售→售前 技术方案请求）",
  "permission_boundary":"权限边界描述（读/写数据范围）",
  "role_subtype":      "角色内子类型（如 大客户销售/渠道销售）"
}
```

`data_scope`：
- `sales`    → `{"model":"self"}`
- `manager`  → `{"model":"org_subtree"}`
- `exec`     → `{"model":"all"}`
- `finance`  → `{"model":"domain","domain":["payment","contract","invoice"]}`
- `presales` → `{"model":"domain","domain":["opportunity","quote","technical"]}`

`retrieval_cfg` 默认：`{l1:{enabled:true,topk:5}, l2:{enabled:true,topk:5}, l3:{enabled:true}, l4:{enabled:true}}`。

### 1.2 关联现有底座（不新增表，复用）
- 组织树：`CRM_ORGANIZATION` 粒子 `payload.parent_id`（`db/seed.sql` 已有 `org-hq` 单节点，manager 子树遍历用 `WITH RECURSIVE`）。
- 人员→角色：`CRM_PERSON` 粒子 `payload.role_tags` + `payload.org_id`（阶段 1 已落，5 角色）。
- L1 向量：`particles.embedding` / `decision.embedding`（`vector(384)`，见 `db/schema.sql`，无 AGE）。
- L2：`decision` + `memory_log`（决策主轴已落）。
- L3：`kanban` 任务态 + `agent_health`（阶段 1 已落）。
- L4：`business_tier_config`（决策主轴已落）。

---

## 2. 模块设计（§D2）`src/context/`

与既有 `src/decision/`、`src/ontology/` 同构（纯函数 + 薄 DB 访问，便于单测）。

### 2.1 `roleProfiles.js`
- `loadProfile(roleTag)`：内存 `Map` 缓存，首次查 `role_context_profile`；提供 `invalidate(roleTag)` 刷新（L4 治理改配置后生效）。
- `getAllProfiles()`：5 行全量（门户阶段 2 配置界面用）。
- `seedProfiles()`：幂等 `INSERT ... WHERE NOT EXISTS`，由 `db/seed.sql` 同语义、migrate `--seed` 调用。

### 2.2 `scope.js`（数据范围谓词，executor 第 1 闸核心）
- `resolveDataScope(profile, actor)` → 返回 scope 描述对象。
- `actorRole(ctx)`：executor 的 `ctx.actor` = `CRM_PERSON.slug`；经 `SELECT payload->'role_tags'->>0, payload->>'org_id' FROM crm.particles WHERE type='CRM_PERSON' AND slug=:actor` 解析出 `role_tag` 与 `org_id`（供 org_subtree 起点）。未命中（demo/bootstrap）→ 返 `null`（无 scope 限制）。
- `orgSubtree(orgId)`：`WITH RECURSIVE` 遍历 `CRM_ORGANIZATION` 的 `payload->>'parent_id'` 收集子树 `slug[]`，返 `id[]`。
- `applyScope(sql, profile, actor)`（**谓词作用于 `payload` JSONB，因 `particles` 表无 `created_by`/`org_id` 顶层列；商机 owner 字段为 `owner_id`**）：
  - `self`       → `AND p.payload->>'owner_id' = :actor`
  - `org_subtree` → `AND p.payload->>'owner_id' IN (SELECT slug FROM crm.particles WHERE type='CRM_PERSON' AND payload->>'org_id' = ANY(:subtree))`（经人员归属组织间接定位）
  - `all`        → 无附加
  - `domain`     → `AND p.type = ANY(:domain)`（`type` 为顶层列，仅对指定粒子类型生效，跨域 Action 按域分别过滤）
- 越界判定：写/读 Action 的 target 粒子 `owner_id`/`type` 不在 scope 内 → `scope_violation`。
- 注：`owner_id` 阶段 1 `CRM_DEAL` 已具备（`db/seed.sql:34`）；`CRM_ACCOUNT`/`CRM_CONTACT` 的 `owner_id` 对齐属阶段 3 业务闭环范围，本设计仅保证谓词正确、不强行回填。

### 2.3 `assembler.js`（L1–L4 装配 + 降级）
`assembleContext({actor, intent, query})`：
```
layers = {}
try { layers.L1 = retrieveL1(actor, query) } catch { missing.L1 = true }   // pgvector <=> topk, timeout 200ms
try { layers.L2 = retrieveL2(actor, intent) } catch { missing.L2 = true } // decision+memory_log 过滤
try { layers.L3 = retrieveL3(actor) } catch { missing.L3 = true }         // kanban+agent_health
try { layers.L4 = retrieveL4(actor) } catch { missing.L4 = true }         // profile+tier 静态
return { layers, degraded: Object.keys(missing).length>0, missing }
```
- 任一层异常/超时**不抛出**，仅标记 `missing`；最终 `degraded` 反映是否发生降级。
- `retrieveL1`：对 `particles`/`decision` embedding 走 `1-(embedding <=> $qvec)`，取 `retrieval_cfg.l1.topk`。
- `retrieveL2`：按 `actor.role_tag` + `intent.scenario` 取近 5 决策 + 相关 `memory_log`。
- `retrieveL3`：当前 `kanban` 在办任务 + `agent_health` 健康度（静态读）。
- `retrieveL4`：`seven_elements` + `business_tier_config`（组织树当前 tier）。

### 2.4 `injector.js`（agentLoop prompt 格式化）
- `formatForPrompt(bundle)` → markdown 块：角色 + 数据范围声明 + L1–L4 检索片段（截断防超长）+ `degraded` 提示（若降级，明示"上下文已降级，建议谨慎"）。
- 输出作为 agentLoop 构建 LLM prompt 时的 system/context 段。

---

## 3. 注入点（§D3）

### 3.1 executor 第 1 闸（permission boundary）
位置：在现有决策第 0 闸之后（`src/action/executor.js` 写通道 gate 段，决策闸紧邻）。
```js
// 第 0 闸：无 decision_id 不写（已有）
if (def.kind === 'write' && !ctx.decision_id && !ctx.bootstrap && !def.autoDecision)
  return { ok:false, gate:'decision_required', ... };
// 第 1 闸：数据范围越界不写/读
if (isParticleScoped(def)) {
  const profile = await loadProfile(actorRole(ctx));
  const verdict = enforceScope(def, ctx, params, profile);
  if (!verdict.ok) return { ok:false, gate:'scope_violation', error: verdict.reason };
}
```
- `data-particle-create`：自动补 `payload.owner_id = :actor`（即便前端未传），不触发越界。
- 读 Action（如 `crm-account-360`、`crm-funnel`）：`applyScope` 注入 `payload->>'owner_id'` / `type` 谓词，越界直接拒。
- `actorRole(ctx)` 解析见 §D2.2（ctx.actor 为 CRM_PERSON.slug）。

### 3.2 agentLoop 注入
`src/agent/agentLoop.js` 在 SKILL 驱动构建 LLM prompt 前：
```js
const bundle = await assembleContext({ actor: ctx.actor, intent, query });
const ctxBlock = formatForPrompt(bundle);
// ctxBlock 拼入 prompt 的 context 段（六段式之一）
```
- 降级时 `bundle.degraded` 让 LLM 知会"上下文降级"，避免幻觉式越权推断。

---

## 4. 检索源与降级链（§D4）

| 层 | 源 | 失败降级目标 | 超时 |
|---|---|---|---|
| L1 知识底座 | ontology vocabulary + `particles`/`decision` pgvector `<=>` | L2 | 200ms |
| L2 历史决策 | `decision` + `memory_log`（scenario/actor） | L3 | 无（同步查） |
| L3 执行协同 | `kanban` tasks + `agent_health` | L4 | 无 |
| L4 治理决策 | `role_profile` + `business_tier_config` | 终点（不崩） | 无 |

设计铁律：**任何层缺失/超时 → 标记 `missing` + `degraded:true`，agent 仍拿到下层上下文，永不抛错**。

---

## 5. 测试与验收（§D5）

新增 `test/context.test.js`（不破坏阶段 1 的 47 绿）：

1. **seed 完整性**：`role_context_profile` 5 行，每行 `seven_elements` 七键齐备；`data_scope` 五模式正确。
2. **数据范围闸（锚点1）**：`resolveDataScope` → sales:self / manager:org_subtree / exec:all / finance·presales:domain；`enforceScope` 模拟销售读他人商机 → `scope_violation`，经理读子树 → ok，exec → ok。
3. **降级链（锚点3）**：`assembleContext` L1 正常出层；注入 L1 查询抛错 → `degraded:true` 且 L2/L3/L4 仍填充、函数不抛。
4. **LLM 注入（锚点2）**：`formatForPrompt` 对 manager"团队业绩"含 `org_subtree` 标记、对 sales"我的业绩"含 `self` 标记；agentLoop 集成测试断言 prompt 含对应 scope 段。
5. **executor 第 1 闸集成**：`data-particle-create` 自带 `owner=actor`；越权读 Action 返 `gate:'scope_violation'`（与决策第 0 闸 `decision_required` 区分）。

预期全量：`47 → ~56` 用例绿；退出码 1 仍良性（空闲 PG 连接池，已知）。

---

## 6. 迁移 / 种子（§D6）

- `db/schema.sql`：增 `role_context_profile` 表 + GIN 索引。
- `db/seed.sql`：增 5 行（对齐 `CRM_PERSON.role_tags`）。
- `db/test-setup.sql`：TRUNCATE 列表增 `role_context_profile`。
- `db/migrate.js`：已幂等（跑 schema + seed）；`--seed` 路径调 `seedProfiles()`（或复用 seed.sql 同语义）。
- 向后兼容：新表不影响阶段 1 任何模块；`roleProfiles.loadProfile` 未命中返回 `null`（调用方回退"无 scope 限制"，仅 demo/bootstrap 用）。

---

## 7. 风险与缓解

- **R1 组织树单节点**：seed 仅 `org-hq` 单节点，`org_subtree` 退化为自身；多团队层级后续 seed 扩展即可，代码 `WITH RECURSIVE` 已支持。
- **R2 profile 未命中**：`loadProfile` 返 `null` → 调用方回退"无 scope 限制"（仅 demo/bootstrap 旁路），不阻断。
- **R3 L1 超时放大延迟**：200ms 上限 + 异步不阻塞主链路；降级到 L2 同步查。
- **R4 与决策第 0 闸耦合**：第 1 闸在决策闸之后，两者 gate 值区分（`decision_required` vs `scope_violation`），便于观测。

---

## 8. 与 10 能力基线 / 决策主轴关系

- 本设计是 `ai-context-layering` 的**阶段 2 实例化**，不新增/不重编号 10 能力。
- 复用决策主轴：`L2` 检索直接读 `decision`/`memory_log`（已落）；`L4` 读 `business_tier_config`（已落）。
- 为后续 4 子系统统一注入面：记忆三构件（L2/L3 context）、Action 写白名单（scope 细化）、门户（角色 profile 配置界面）、预警反馈（L3 执行态触发）均消费 `assembleContext` / `enforceScope`。
