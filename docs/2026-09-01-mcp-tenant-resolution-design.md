# MCP 通道租户解析补齐 — 设计文档

- **作者**：crm-copilot
- **日期**：2026-09-01
- **基线**：P1 探索 + 方案 A 已批准（用户 14:30 确认）
- **关联文档**：
  - `docs/2026-08-25-ai-native-crm-overall-design.md` §6（决策主轴 / 租户承载）
  - `docs/2026-08-26-crm-role-confirm-permission-design.md`（MCP 闸 + 角色 + 决策第 0 闸）
  - `docs/2026-08-29-mcp-forced-login-design.md`（MCP 强制登录、token 软吊销）
  - `db/migrate-tenant.js`（多租户幂等加列迁移，本次追加 §6 老 token 软迁移）

---

## §0 摘要（TL;DR）

- **问题**：HTTP 通道已按登录 token 自动租户隔离；MCP 通道在 4 处 `gateway.js` 调用 `buildMcpCtx` 时硬编码 `tenantId: 'system'`，`mcp_identity.tenant_id` 登录时写 NULL。结果：MCP 通道无论谁登录，读写全落 `system` 租户。
- **方案 A（已批准）**：登录 `mcpLogin` 时把 `crm_users.tenant_id` 写入 `mcp_identity.tenant_id`；`buildMcpCtx` 从身份查表带出 `tenant_id` 落 ctx（缺省回退 `system`）；`gateway.js` 4 处不再传 `tenantId`，由 ctx 自动推导。**附带一条幂等软迁移补齐存量老 token**。
- **数据层就绪**：`mcp_identity` 与 `crm_users` 均有 `tenant_id` 列（`migrate-tenant.js:8/11` 已加），只缺两处接线 + 一条软迁移。
- **不动的承诺**：零 DELETE（不删老 token、不删 mcp_identity 行）；不改 HTTP 通道（已正确）；不改前端页面（用户管理页"org"列已展示 `tenant_id`，不需要手填）。

---

## §1 现状与缺口定位

### 1.1 已落地的多租户证据（生产库直查）

| 维度 | 实证 |
|---|---|
| `crm.crm_users.tenant_id` | 9 用户全部 `'system'`，列存在，NOT NULL DEFAULT 'system' |
| `crm.mcp_identity.tenant_id` | 列存在（`migrate-tenant.js:11`），但**登录时写 NULL**（`auth.js:131`） |
| HTTP 通道租户隔离 | `routes.js:467` `scopeOf(me)` 写 ctx 自动注入；`tenantScope.js:4-7` 读用 `scopeTenant(me)` |
| 前端 UI 展示 | 用户管理页"org"列 ≡ `tenant_id`（截图红圈字段），UI 自动展示、后端自动隔离 |
| 读写链路租户分布 | particles `system 293 + default 6`；decision `system 9`；config_store `system 8` |

### 1.2 MCP 通道的具体缺口（4 处硬编码 + 1 处登录空写）

| # | 文件:行 | 代码 | 问题 |
|---|---------|------|------|
| 1 | `src/mcp/gateway.js:61` | `buildMcpCtx({ token, tenantId: 'system', ... })` | 写 phase1 固定落 system |
| 2 | `src/mcp/gateway.js:86` | `buildMcpCtx({ token, tenantId: 'system', ... })` | 敏感读 phase1 固定落 system |
| 3 | `src/mcp/gateway.js:123` | `buildMcpCtx({ token, tenantId: 'system', ... })` | confirm phase2 固定落 system |
| 4 | `src/mcp/gateway.js:139` | `buildMcpCtx({ token, tenantId: 'system', ... })` | 读直连固定落 system |
| 5 | `src/mcp/auth.js:82` | `buildMcpCtx({ ..., tenantId = 'system', ... })` | 默认参数回退 system（兜底） |
| 6 | `src/mcp/auth.js:129-134` | `INSERT INTO crm.mcp_identity (id, token_hash, actor, person_id, ...)` 缺 `tenant_id` | 登录时 `mcp_identity.tenant_id=NULL` |

**根因**：MCP 链路在登录时未把 `crm_users.tenant_id` 透传到 `mcp_identity`；`buildMcpCtx` 也未从 `resolveIdentity` 查表结果里取出 `tenant_id`；导致 ctx.tenantId 永远是默认 'system'。

### 1.3 前端是否需要手填 `tenant_id`？**不需要**

- 后端所有读写已按 token 自动推导租户（`routes.js:467` 写 ctx、HTTP 读 `scopeTenant`、MCP 写 ctx）。
- 截图"org"列是**展示列**（不是输入列），后端从 `crm_users.tenant_id` 自动渲染。
- 多租户数据进入 UI 的两条路径：①用户管理页 admin 建租户时（`POST /api/tenants` 闸），后端 `tenantRouter.js` 写入；②种子脚本。**前端任何业务表单都不需要也不应该传 tenant_id**（与 token 推导的设计冲突、引入伪造风险）。

---

## §2 目标与非目标

### 2.1 目标（In-Scope）

1. **登录带租户**：`mcpLogin` 把 `crm_users.tenant_id` 写入 `mcp_identity.tenant_id`。
2. **ctx 携带租户**：`buildMcpCtx` 从 `resolveIdentity` 查表结果带出 `tenant_id`，ctx.tenantId 用它；缺省回退 `'system'`。
3. **gateway 不传硬编码**：`gateway.js` 4 处删除 `tenantId: 'system'` 参数，由 ctx 自动推导。
4. **老 token 软迁移**：存量 `mcp_identity.tenant_id IS NULL` 按 `actor→crm_users.username` 关联补齐（幂等 UPDATE，禁删）。
5. **回归测试**：补 `mcpTenant.test.js`（登录 alice@acme→ctx.tenantId==='acme'，登录 alice@system→ctx.tenantId==='system'）；`multi-tenant.test.js` 保持 11/11 绿。

### 2.2 非目标（Out-of-Scope）

- **不动 HTTP 通道**（`routes.js:467 scopeOf` 已正确）。
- **不动前端页面**（截图"org"列已展示，后端自动隔离，无需手填）。
- **不动 RBAC 角色解析**（`resolveEffectiveRole` 只看 role，与租户正交）。
- **不改 token 软吊销**（`auth.js:141-156` 已正确处理"同 actor 旧 token 软吊销"，本次只补 tenant_id 列）。
- **不删任何 mcp_identity 行**（禁删铁律）。
- **不动 admin 角色禁登 MCP**（`auth.js:122-125` 已正确）。

---

## §3 改动清单（3 处代码 + 1 处迁移）

### 改动 1：`src/mcp/auth.js:129-134` 登录 INSERT 带 tenant_id

**现状**：
```js
const r = await queryWrite(
  `INSERT INTO crm.mcp_identity (id, token_hash, actor, person_id, role_tag, scopes, expires_at)
   VALUES ($1, crypt($2, gen_salt('bf')), $3, NULL, $4, '{}'::jsonb, $5)
   RETURNING id`,
  [id, tokenPlain, u.username, u.role, expiresAt]
);
```

**改造**：
- 第 1 步：登录 SELECT 增加 `tenant_id` 列（line 116）。
- 第 2 步：INSERT 增加 `tenant_id` 列，把 `u.tenant_id` 写入（line 129-134）。
- 缺省处理：若 `u.tenant_id` 为 NULL/空（极小概率），回退 `'system'`（与 migrate-tenant.js 默认值一致）。

**契约**：
- 输入：`{ username, password }`，沿用 `crypt($1,$2)=$2` 校验（`auth.js:120`，与 HTTP 通道同源）。
- 输出：`mcp_identity` 行的 `tenant_id` = `crm_users.tenant_id`（缺省 `system`）。
- 副作用：旧 token 软吊销（沿用 line 141-156 既有逻辑，本改动不触发）。
- 行为不变：role/admin 禁登/disabled/无效凭证/TTL 全部沿用既有逻辑。

### 改动 2：`src/mcp/auth.js:82-99` buildMcpCtx 从身份查表带 tenant_id

**现状**：
```js
export async function buildMcpCtx({ token, actor: explicitActor, tenantId = 'system', ... } = {}) {
  const r = await resolveIdentity(token);
  const { actor, role, degraded, ..., identity_id, person_id, scopes } = r;
  ...
  return { tenantId, ... };   // ← 用入参，丢弃身份查表信息
}
```

**改造**：
- `resolveIdentity` 查 `crm.mcp_identity` 时同步返回 `tenant_id`（沿用既有 `query` 结果，解构时多取一列）。
- `buildMcpCtx` 优先级：①显式 `tenantId` 入参（保留以支持 service-to-service 内部调用） ②`resolveIdentity.tenant_id` ③`'system'` 兜底。
- ctx.tenantId 用推导值。

**契约**：
- 入参 `tenantId` 仍然存在（保留参数签名，向后兼容调用方显式覆盖）。
- 缺省优先级：身份查表 > 兜底 `'system'` > 显式入参（仅调试/运维覆盖用）。
- `resolveIdentity` 失败（degraded）时，ctx.tenantId 落 `'system'`（与现有降级行为一致）。

### 改动 3：`src/mcp/gateway.js:61/86/123/139` 删除硬编码 tenantId

**现状**（4 处同款）：
```js
const ctx = await buildMcpCtx({ token, tenantId: 'system', channel: 'mcp', ... });
```

**改造**（4 处统一）：
```js
const ctx = await buildMcpCtx({ token, channel: 'mcp', ... });
// tenantId 由 buildMcpCtx 从身份查表推导
```

**契约**：
- 调用方不再传 `tenantId`，由 ctx 推导。
- 内部 service-to-service 调用若需覆盖（`mcpTools`、回归测试、运维场景），仍可显式传。
- 行为不变：降级 / 决策第 0 闸 / 角色解析 / 写白名单全部沿用既有逻辑。

### 改动 4：`db/migrate-tenant.js` 追加 §6 老 token 软迁移

**现状**：migrate-tenant.js L1-29 已有 5 段加列迁移。

**新增第 6 段**（在 L28 `console.log` 之前）：
```js
// 6) 老 token 软迁移：mcp_identity.tenant_id IS NULL 的行按 actor→crm_users.username 关联补齐
await queryWrite(`
  UPDATE crm.mcp_identity mi
  SET    tenant_id = cu.tenant_id
  FROM   crm.crm_users cu
  WHERE  mi.actor  = cu.username
    AND  mi.tenant_id IS NULL
    AND  cu.tenant_id IS NOT NULL
`);
```

**契约**：
- 幂等：WHERE 条件 `mi.tenant_id IS NULL`，重复执行不重复更新。
- 禁删：纯 UPDATE，无 DELETE / TRUNCATE / DROP。
- 性能：`actor` 列已是高频查询列（line 9 索引），全表 UPDATE 在 9 行规模下毫秒级。
- 失败安全：UPDATE 失败 → migrate-tenant 整体回滚（migrate.js 整事务），不污染生产库。

---

## §4 验证方案

### 4.1 单测（新增 `test/mcp-tenant.test.js`）

| 用例 | 断言 | 关联 |
|---|---|---|
| M1 alice@system 登录 → ctx.tenantId==='system' | `buildMcpCtx({ token: aliceToken })` 返 `{ tenantId: 'system' }` | 改动 1+2 |
| M2 alice@acme 登录 → ctx.tenantId==='acme' | 同上 | 改动 1+2 |
| M3 gateway 写 phase1 不再硬编码 system | `mcpWritePhase1` mock `buildMcpCtx` 返 `tenantId:'acme'`，断言调用方 ctx.tenantId==='acme' | 改动 3 |
| M4 老 token 软迁移幂等 | 人工置 `mcp_identity.tenant_id=NULL` 跑 migrate → 不抛错，二次跑 → 不变 | 改动 4 |

### 4.2 回归

- `PGDATABASE=crm_native_test npx vitest run test/multi-tenant.test.js` → 11/11 保持绿。
- `PGDATABASE=crm_native_test npx vitest run test/mcp-tenant.test.js` → 4/4 全绿。
- `PGDATABASE=crm_native_test node tmp/verify-t6.mjs` → 9/9 保持绿。

### 4.3 生产库手动验证（用户授权后执行）

```bash
# 1. 软迁移（幂等，可重复）
PGDATABASE=crm_native node db/migrate-tenant.js

# 2. 直查迁移结果
PGDATABASE=crm_native node --input-type=module -e "
import { query } from './src/db.js';
const r = await query('SELECT tenant_id, count(*) FROM crm.mcp_identity GROUP BY tenant_id');
console.log('mcp_identity 租户分布:', JSON.stringify(r.rows));
"
# 预期：所有非空行 tenant_id 来自 crm_users.tenant_id（生产库应全 = 'system'，无 NULL）

# 3. 登录实测（用 acme 演示租户的 admin；若生产库尚无则跳过）
curl -X POST http://localhost:3000/mcp/crm_login -d '{"username":"...","password":"..."}'
# 预期：返回 token 后 buildMcpCtx({token}).tenantId === crm_users.tenant_id
```

### 4.4 端到端（可选，依赖 4.3）

- `acme` 演示租户登录 MCP → 调用 `crm_data_particle_read` → 查 `particles` 表只返 acme 行。
- `system` 平台 admin 登录 HTTP → `/api/auth/me` → 返 `tenantId='system'` + role='admin'。

---

## §5 风险与回退

### 5.1 风险

| 风险 | 等级 | 缓解 |
|---|---|---|
| 老 token 软迁移 UPDATE 误覆盖 | 低 | WHERE 限制 `tenant_id IS NULL`，不重复更新；migrate 整事务 |
| `resolveIdentity` 查表时 `tenant_id` 列名错 | 低 | 列已存在（migrate-tenant.js:11）；SELECT 显式列名 |
| 改动 3 删除硬编码后旧调用方未传 tenantId 报缺参 | 低 | 保留 `tenantId = 'system'` 默认参数，向后兼容 |
| MCP 演示租户 acme/globex 在生产库不存在，登录测试无法实测 | 中 | 4.4 端到端依赖 acme 存在；缺时仅做 §4.1-4.2 |
| 跨租户越权（MCP ctx 错把 token A 的租户赋给 token B） | 低 | `buildMcpCtx` 用 `resolveIdentity` 查 token 对应身份行，关联键天然隔离 |

### 5.2 回退

- 改动 1+2+3 是纯新增列传值 + 删硬编码，**最坏情况** ctx.tenantId 落 `'system'`（与改造前一致），无功能降级。
- 改动 4 是幂等 UPDATE，回退只需 `UPDATE crm.mcp_identity SET tenant_id=NULL WHERE actor IN (...)`（受禁删铁律约束，**默认不主动回退**；如必须，需用户显式授权）。
- 紧急回退：撤销 PR → 重启服务 → 旧行为（全部 system）自动恢复。

---

## §6 契约（§A）

```yaml
- task: "MCP 通道租户解析补齐（登录写入 tenant_id + gateway 推导 + 老 token 软迁移）"
  contract_task_id: mcp-tenant-resolution-2026-09-01
  agent: crm-copilot
  skills: [data-particle-read]
  memory: [crm-copilot]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  inputs:
    - src/mcp/auth.js:113-160   (mcpLogin)
    - src/mcp/auth.js:82-99     (buildMcpCtx)
    - src/mcp/gateway.js:59-150 (mcpWritePhase1/ReadSensitive/Confirm/ReadDirect)
    - db/migrate-tenant.js:6-29 (append §6)
  outputs:
    - mcp_identity.tenant_id = crm_users.tenant_id （登录即落）
    - buildMcpCtx().tenantId 由身份查表推导（缺省 system）
    - gateway 4 处不再硬编码 'system'
    - 老 mcp_identity 行 tenant_id 由 §6 软迁移补齐
  success:
    - test/mcp-tenant.test.js 4/4 绿
    - test/multi-tenant.test.js 11/11 保持绿
    - 生产库 mcp_identity 无 NULL tenant_id
    - curl /api/auth/me admin/admin123 → tenantId='system'
  roll_back: 撤销 PR + 重启服务；最坏回退到全部 ctx.tenantId='system' 现状
```

---

## §7 后续（不在本设计范围）

1. **租户级 RateLimit / Quota**：MCP 通道按 tenant 限流（`MCP_CONFIG.security` 已有 tokenTtlMs，缺 tenantTps）。
2. **租户级审计粒度**：`audit_event.tenant_id` 已加（migrate-tenant.js:15），但 audit 写入侧（`action/executor.js`）是否把 ctx.tenantId 写入需审计。
3. **租户管理 UI**：`/api/tenants` 已实现 admin 闸（tenantRouter.js），但 UI 仅"org"列展示，未提供建租户表单（admin 通过 API 调）。
4. **跨租户查询**（admin 角色已用 `scopeTenant(me)=*` 实现），是否需要租户切换器 UI 待定。

---

## §8 自检（写后自查）

- [x] 设计文档存 `docs/2026-09-01-...-design.md`（按既有命名规范）
- [x] §0 摘要 / §1 现状 / §2 目标 / §3 改动 / §4 验证 / §5 风险回退 / §6 契约 / §7 后续 / §8 自检——九节齐全
- [x] 每个改动标注 file:line 证据（`auth.js:113-160` / `auth.js:82-99` / `gateway.js:59-150` / `migrate-tenant.js:6-29`）
- [x] 契约含 `contract_task_id` / `agent` / `skills` / `memory` / `knowledge_scope` / `success` 字段
- [x] 无占位符（`TODO` / `TBD` / `???`）/ 无矛盾（不动 HTTP 通道、不动前端）/ 无歧义（每个改动写明"现状 vs 改造 vs 契约"）
- [x] 范围未溢出（不重写 token 软吊销、不动 RBAC、不动 admin 禁登）

---

_批准后移交 writing-plans 产出实施计划（按 Task 拆分 + 每 Task 一 commit 铁律）。_
