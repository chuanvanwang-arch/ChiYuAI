# MCP 通道租户解析补齐（方案 A）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 MCP 通道的 ctx.tenantId 随登录身份推导（不再硬编码 `system`），与 HTTP 通道行为一致；并补齐存量老 token 的租户归属。

**Architecture:** 在登录 `mcpLogin` 时把 `crm_users.tenant_id` 写入 `mcp_identity.tenant_id`；`resolveIdentity` 查表时带出 `tenant_id`，`buildMcpCtx` 消费它落 ctx（缺省回退 `'system'`）；`gateway.js` 4 处删除硬编码 `tenantId:'system'`，由 ctx 自动推导；最后用一条幂等 UPDATE 软迁移补齐存量 `mcp_identity.tenant_id IS NULL` 的行。零 DELETE，不碰 HTTP 通道与前端。

**Tech Stack:** Node 22 ESM + PostgreSQL 16（pgcrypto）+ vitest 3。测试库 `plm_test`（vitest 强制连），生产库 `plm`。

**基线设计：** `docs/2026-09-01-mcp-tenant-resolution-design.md`（§0-§8，已批准）。

---

## 文件结构

| 文件 | 责任 | 改动性质 |
|---|---|---|
| `src/mcp/auth.js` | MCP 凭证解析：`resolveIdentity` / `buildMcpCtx` / `mcpLogin` | Modify（3 处：L38 SELECT、L49 base 返回、L113-160 mcpLogin、L82-99 buildMcpCtx）|
| `src/mcp/gateway.js` | MCP 闸（写/敏感读/confirm/读直连）| Modify（4 处：L61/86/123/139 删 `tenantId:'system'`）|
| `db/migrate-tenant.js` | 多租户幂等加列迁移 | Modify（L28 前追加 §6 软迁移段）|
| `test/mcp-tenant.test.js` | 新增 MCP 租户解析单测（4 用例 M1-M4）| Create |

**依赖事实（已直查确认）：**
- `mcp_identity` 与 `crm_users` 均有 `tenant_id` 列（`migrate-tenant.js:8/11` 已加，`NOT NULL DEFAULT 'system'`）。
- 测试库 `plm_test` 已有 `alice`/`secret123`（sales / tenant `system`），可直接登录。
- `resolveIdentity` 当前 SELECT（auth.js:38）**不含** `tenant_id`，base 返回（auth.js:49-53）也不带 → 本次必须补。
- `buildMcpCtx` 默认参数 `tenantId='system'`（auth.js:82）保留作兜底。

---

## Task 1: mcpLogin 登录时写入 tenant_id

**Files:**
- Modify: `src/mcp/auth.js:115-134`（`mcpLogin` 的 SELECT 与 INSERT）

- [ ] **Step 1: 写失败测试（M1 前半：登录后 mcp_identity.tenant_id 应落库）**

在 `test/mcp-tenant.test.js`（新建文件，见 Task 5 头部模板）中加入：
```js
import { describe, it, expect, beforeAll } from 'vitest';
import { mcpLogin, buildMcpCtx } from '../src/mcp/auth.js';
import { query } from '../src/db.js';

describe('MCP 租户解析', () => {
  it('M1 登录 alice(system) 后 mcp_identity.tenant_id 落库 = system', async () => {
    const r = await mcpLogin({ username: 'alice', password: 'secret123' });
    expect(r.ok).toBe(true);
    const id = await query(
      `SELECT tenant_id FROM crm.mcp_identity WHERE token_hash = crypt($1, token_hash)`,
      [r.token]
    );
    expect(id.rows[0].tenant_id).toBe('system');
  });
});
```

- [ ] **Step 2: 跑测试确认失败（tenant_id 当前为 NULL/默认 system 但 SELECT 未取，断言读不到）**

Run: `PGDATABASE=plm_test npx vitest run test/mcp-tenant.test.js`

Expected: FAIL — `id.rows[0]` 为 `undefined`（INSERT 没写 tenant_id → 查询无匹配）或 `tenant_id` 为 NULL。

- [ ] **Step 3: 改 mcpLogin（auth.js:115-134）**

`src/mcp/auth.js` 第 115-116 行 SELECT 增加 `tenant_id`：
```js
  const { rows } = await query(
    `SELECT username, password_hash, role, display_name, enabled, tenant_id FROM crm.crm_users WHERE username=$1`, [username]);
```

第 129-134 行 INSERT 增加 `tenant_id` 列（注意参数位移：`$5` 原是 expiresAt，现改为 tenant_id，`$6` 为 expiresAt）：
```js
  const tenantId = u.tenant_id || 'system';
  const r = await queryWrite(
    `INSERT INTO crm.mcp_identity (id, token_hash, actor, person_id, role_tag, scopes, tenant_id, expires_at)
     VALUES ($1, crypt($2, gen_salt('bf')), $3, NULL, $4, '{}'::jsonb, $5, $6)
     RETURNING id`,
    [id, tokenPlain, u.username, u.role, tenantId, expiresAt]
  );
```

- [ ] **Step 4: 重跑测试确认通过**

Run: `PGDATABASE=plm_test npx vitest run test/mcp-tenant.test.js`

Expected: PASS（M1 绿）。

- [ ] **Step 5: Commit**

```bash
git add src/mcp/auth.js test/mcp-tenant.test.js
git commit -m "feat(mcp): mcpLogin 登录时把 crm_users.tenant_id 写入 mcp_identity"
```

---

## Task 2: resolveIdentity + buildMcpCtx 透传 tenant_id

**Files:**
- Modify: `src/mcp/auth.js:37-53`（`resolveIdentity` SELECT 与 base 返回）
- Modify: `src/mcp/auth.js:82-99`（`buildMcpCtx` 消费 tenant_id）

- [ ] **Step 1: 写失败测试（M2：非 system 租户用户登录 → ctx.tenantId 推导为该租户）**

在 `test/mcp-tenant.test.js` 的 `describe` 内追加：
```js
  it('M2 acme 租户用户登录 → buildMcpCtx().tenantId === acme（证明非硬编码）', async () => {
    const acmeUser = `mt_acme_${Date.now()}`;
    await query(
      `INSERT INTO crm.crm_users (username, password_hash, role, display_name, enabled, tenant_id)
       VALUES ($1, crypt($2, gen_salt('bf')), 'sales', 'MT Acme', true, 'acme')`,
      [acmeUser, 'secret123']
    );
    const r = await mcpLogin({ username: acmeUser, password: 'secret123' });
    expect(r.ok).toBe(true);
    const ctx = await buildMcpCtx({ token: r.token });
    expect(ctx.tenantId).toBe('acme');
  });

  it('M3 显式传 tenantId=system 时身份租户优先（验证 gateway 删硬编码无副作用）', async () => {
    const acmeUser = `mt_acme2_${Date.now()}`;
    await query(
      `INSERT INTO crm.crm_users (username, password_hash, role, display_name, enabled, tenant_id)
       VALUES ($1, crypt($2, gen_salt('bf')), 'sales', 'MT Acme2', true, 'acme')`,
      [acmeUser, 'secret123']
    );
    const r = await mcpLogin({ username: acmeUser, password: 'secret123' });
    const ctx = await buildMcpCtx({ token: r.token, tenantId: 'system' });
    expect(ctx.tenantId).toBe('acme'); // 身份 tenant_id 优先于显式 'system' 兜底
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `PGDATABASE=plm_test npx vitest run test/mcp-tenant.test.js`

Expected: M2 / M3 FAIL — `ctx.tenantId` 为 `'system'`（resolveIdentity 未透传 tenant_id）。

- [ ] **Step 3: 改 resolveIdentity（auth.js:37-53）SELECT 带 tenant_id + base 返回带 tenant_id**

第 38-39 行 SELECT 增加 `tenant_id`：
```js
  const r = await query(
    `SELECT id, actor, person_id, role_tag, scopes, expires_at, enabled, revoked_at, tenant_id,
            (token_hash = crypt($2, token_hash)) AS tok_ok
       FROM crm.mcp_identity WHERE id = $1`,
    [id, token]
  );
```

第 49-53 行 base 返回增加 `tenant_id`（缺省回退 system，与 migrate-tenant 默认值一致）：
```js
  const base = mk(row.actor, row.role_tag, false, null, false);
  base.identity_id = row.id;
  base.person_id = row.person_id;
  base.scopes = row.scopes && typeof row.scopes === 'object' ? row.scopes : {};
  base.tenant_id = row.tenant_id || 'system';
  return base;
```

- [ ] **Step 4: 改 buildMcpCtx（auth.js:82-99）消费 tenant_id**

替换 `buildMcpCtx` 函数体（注意保留 `tenantId` 入参签名作 service-to-service 覆盖用，但优先级低于身份查表）：
```js
export async function buildMcpCtx({ token, actor: explicitActor, tenantId: explicitTenantId = 'system', decisionId = null, channel = 'mcp' } = {}) {
  const r = await resolveIdentity(token);
  const { actor, role, degraded, degraded_reason, prompt_needed, identity_id, person_id, scopes, tenant_id } = r;
  const finalActor = explicitActor || actor;
  // 优先级：身份查表 tenant_id > 显式入参兜底(默认 system) > 硬编码 system
  const finalTenantId = tenant_id || explicitTenantId || 'system';
  return {
    tenantId: finalTenantId,
    actor: finalActor,
    role,                      // 身份基线解析（mcp_identity 持久绑定，不再内存静态降级）
    channel,                   // 'mcp' —— 触发写白名单闸
    degraded,
    degraded_reason,
    prompt_needed,
    decision_id: decisionId,
    identity_id,
    person_id,
    scopes,
  };
}
```

- [ ] **Step 5: 重跑测试确认通过**

Run: `PGDATABASE=plm_test npx vitest run test/mcp-tenant.test.js`

Expected: M1 / M2 / M3 PASS。

- [ ] **Step 6: Commit**

```bash
git add src/mcp/auth.js test/mcp-tenant.test.js
git commit -m "feat(mcp): resolveIdentity + buildMcpCtx 透传 tenant_id（身份租户优先）"
```

---

## Task 3: gateway.js 删除 4 处硬编码 tenantId

**Files:**
- Modify: `src/mcp/gateway.js:61` / `:86` / `:123` / `:139`

- [ ] **Step 1: 写失败测试（M3 已由 Task 2 覆盖：gateway 旧 `tenantId:'system'` 参数被身份租户覆盖）**

无需新增用例 —— Task 2 的 M3 已验证「即使调用方传 `tenantId:'system'`，ctx 仍取身份租户」。本 Task 是删除冗余硬编码参数（消除误导），行为不变。

- [ ] **Step 2: 改 gateway.js 4 处**

`src/mcp/gateway.js:61`（mcpWritePhase1）：
```js
  const ctx = await buildMcpCtx({ token, channel: 'mcp', decisionId: params?.decision_id || null });
```

`src/mcp/gateway.js:86`（mcpReadSensitivePhase1）：
```js
  const ctx = await buildMcpCtx({ token, channel: 'mcp', decisionId: null });
```

`src/mcp/gateway.js:123`（mcpConfirmPhase2）：
```js
  const ctx = await buildMcpCtx({ token: extractToken(params, headers), channel: 'mcp', decisionId: session.params?.decision_id });
```

`src/mcp/gateway.js:139`（mcpReadDirect）：
```js
  const ctx = await buildMcpCtx({ token, channel: 'mcp', decisionId: null });
```

（四处的共同改动：删除 `tenantId: 'system',` 这一键值对，其余不变。）

- [ ] **Step 3: 跑全量相关测试确认无回归**

Run: `PGDATABASE=plm_test npx vitest run test/mcp-tenant.test.js test/multi-tenant.test.js`

Expected: mcp-tenant 全绿；multi-tenant 保持 11/11 绿。

- [ ] **Step 4: Commit**

```bash
git add src/mcp/gateway.js
git commit -m "refactor(mcp): gateway 4 处删除硬编码 tenantId，改由 ctx 自动推导"
```

---

## Task 4: 老 token 软迁移（幂等 UPDATE）

**Files:**
- Modify: `db/migrate-tenant.js:6-28`（`migrateTenant()` 末尾、L28 `console.log` 之前追加 §6）

- [ ] **Step 1: 写失败测试（M4：mcp_identity.tenant_id IS NULL 的行被补齐，且幂等）**

在 `test/mcp-tenant.test.js` 的 `describe` 内追加（注意：直接调迁移函数）：
```js
import { migrateTenant } from '../db/migrate-tenant.js';

  it('M4 老 token 软迁移：NULL tenant_id 补齐且幂等（禁删）', async () => {
    // 造一条 NULL tenant_id 的老 token 行
    const { rows } = await query(
      `INSERT INTO crm.mcp_identity (id, token_hash, actor, person_id, role_tag, scopes, tenant_id, expires_at)
       VALUES ('mt_null_' || gen_random_uuid()::text, crypt('x', gen_salt('bf')), 'alice', NULL, 'sales', '{}'::jsonb, NULL, now() + interval '1 hour')
       RETURNING id, tenant_id`
    );
    expect(rows[0].tenant_id).toBeNull();
    await migrateTenant(); // 应把 alice 的 tenant_id('system') 补上
    const after = await query(`SELECT tenant_id FROM crm.mcp_identity WHERE id=$1`, [rows[0].id]);
    expect(after.rows[0].tenant_id).toBe('system');
    // 幂等：再跑一次不应报错、值不变
    await migrateTenant();
    const after2 = await query(`SELECT tenant_id FROM crm.mcp_identity WHERE id=$1`, [rows[0].id]);
    expect(after2.rows[0].tenant_id).toBe('system');
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `PGDATABASE=plm_test npx vitest run test/mcp-tenant.test.js`

Expected: M4 FAIL — `migrateTenant()` 当前没有 §6 段，`tenant_id` 仍是 NULL。

- [ ] **Step 3: 改 migrate-tenant.js 追加 §6**

在 `db/migrate-tenant.js` 第 27 行（`CREATE INDEX IF NOT EXISTS idx_decision_event_tenant ...`）之后、第 28 行 `console.log('[migrate-tenant] OK');` 之前，插入：
```js
  // 6) 老 token 软迁移：mcp_identity.tenant_id IS NULL 的行按 actor→crm_users.username 关联补齐（幂等 UPDATE，禁删）
  await queryWrite(`
    UPDATE crm.mcp_identity mi
    SET    tenant_id = cu.tenant_id
    FROM   crm.crm_users cu
    WHERE  mi.actor  = cu.username
      AND  mi.tenant_id IS NULL
      AND  cu.tenant_id IS NOT NULL
  `);
```

- [ ] **Step 4: 重跑测试确认通过**

Run: `PGDATABASE=plm_test npx vitest run test/mcp-tenant.test.js`

Expected: M1/M2/M3/M4 全绿（4/4）。

- [ ] **Step 5: Commit**

```bash
git add db/migrate-tenant.js test/mcp-tenant.test.js
git commit -m "feat(db): migrate-tenant 追加 §6 老 token 软迁移（幂等补齐 tenant_id）"
```

---

## Task 5: 测试文件头部模板 + 全量回归

**Files:**
- Create: `test/mcp-tenant.test.js`（整合 Task 1-4 的 4 个用例）

- [ ] **Step 1: 写完整测试文件头部**

`test/mcp-tenant.test.js` 顶部（Task 1-4 的用例已分处给出，此处给出整合后的完整文件骨架）：
```js
import { describe, it, expect } from 'vitest';
import { mcpLogin, buildMcpCtx } from '../src/mcp/auth.js';
import { migrateTenant } from '../db/migrate-tenant.js';
import { query } from '../src/db.js';

describe('MCP 租户解析', () => {
  // M1: 见 Task 1 Step 1
  // M2: 见 Task 2 Step 1
  // M3: 见 Task 2 Step 1
  // M4: 见 Task 4 Step 1
});
```

（M1-M4 完整代码见各 Task 的 Step 1 代码块，直接拼合即可，无省略。）

- [ ] **Step 2: 跑全量相关回归**

Run: `PGDATABASE=plm_test npx vitest run test/mcp-tenant.test.js test/multi-tenant.test.js`

Expected:
- `test/mcp-tenant.test.js` → 4/4 绿（M1 登录落 system / M2 acme 推导 / M3 身份优先 / M4 软迁移幂等）
- `test/multi-tenant.test.js` → 11/11 绿（HTTP 通道不受影响）

- [ ] **Step 3: 生产库手动验证（需用户本地授权后执行，不自动跑）**

```bash
# 1. 软迁移补齐老 token
PGDATABASE=plm node db/migrate-tenant.js

# 2. 直查确认无 NULL
PGDATABASE=plm node --input-type=module -e "
import { query } from './src/db.js';
const r = await query('SELECT tenant_id, count(*) FROM crm.mcp_identity GROUP BY tenant_id');
console.log('mcp_identity 租户分布:', JSON.stringify(r.rows));
"
# 预期：生产库全部 = 'system'（无 NULL，无 acme/globex，因生产库仅 system 租户）
```

- [ ] **Step 4: Commit（若 Task 1-4 已分别 commit，此步可跳过；否则统一收口）**

```bash
git add test/mcp-tenant.test.js
git commit -m "test(mcp): 新增 MCP 租户解析回归（4 用例覆盖登录/推导/优先级/软迁移）"
```

---

## Self-Review（写后自查）

**1. Spec 覆盖对照（设计文档 §3 改动清单）：**
- 改动 1（auth.js:113-160 mcpLogin 写 tenant_id）→ Task 1 ✅
- 改动 2（auth.js:82-99 buildMcpCtx 透传）→ Task 2 ✅（含 resolveIdentity L38/L49 二连改，已显式列出）
- 改动 3（gateway.js:61/86/123/139 删硬编码）→ Task 3 ✅
- 改动 4（migrate-tenant.js §6 软迁移）→ Task 4 ✅
- 验证方案 §4.1（M1-M4 单测）→ Task 5 ✅
- 验证方案 §4.2（multi-tenant 11/11 保持）→ Task 3 Step 3 / Task 5 Step 2 ✅
- 验证方案 §4.3（生产库手动）→ Task 5 Step 3（标注需用户授权，不自动跑）✅
- 契约 §A → 计划头部 Goal/Architecture/Tech Stack 对齐 ✅

**2. Placeholder 扫描：** 无 TBD / TODO / "类似 Task N" / "适当处理错误"。每个代码 Step 均含完整代码块。

**3. 类型 / 签名一致性：**
- `mcpLogin` 返回 `{ ok, token, role, display_name }`（auth.js:144）→ 测试用 `r.token` / `r.ok` ✅
- `buildMcpCtx` 入参 `{ token, actor, tenantId, decisionId, channel }` 全计划一致 ✅
- `resolveIdentity` 返回增 `tenant_id`（base.tenant_id）→ buildMcpCtx 解构 `tenant_id` ✅
- `migrateTenant` 函数签名未变（仍 `export async function migrateTenant()`），仅内增 §6 段 → 测试 `import { migrateTenant }` ✅
- INSERT 参数位移（`$5`=tenant_id, `$6`=expiresAt）在 Task 1 Step 3 与测试查询一致 ✅

**4. 铁律合规：** 零 DELETE（§6 纯 UPDATE + WHERE IS NULL）；不碰 HTTP 通道；不碰前端；不删 mcp_identity 行；不改 token 软吊销 / RBAC / admin 禁登。✅
