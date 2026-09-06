# MCP 角色判定改进（身份基线 + 意图校正）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 MCP 接入层的角色判定从"内存静态查表、owner 一律降级 sales"升级为"token↔person↔role 持久绑定 + 按本次操作数据域运行时聚焦（不升权）"，使 owner 经 MCP 调高权限工具不再被第 1.5 闸误挡。

**Architecture:** 两层判定互不越权——身份基线（持久查 `crm.mcp_identity` 表，pgcrypto 哈希比对，确定性）解析 `role`；意图校正引擎（`src/mcp/intent.js`）按 `action.data_scope_domains ∩ profile.data_scope` 交集计算 `focus_domain`（只聚焦、不升权）。既有四道安全闸（决策第 0 闸 / 第 1.5 闸 / 绝对禁删 / 写两阶段）全部保留不变。

**Tech Stack:** Node 22 ESM、PostgreSQL 16（pgcrypto `crypt`/`gen_salt`）、`@modelcontextprotocol/sdk`、vitest 3。测试库 = `plm` 库内 `crm` schema（PG@5433）。

**前置（每个 Task 前确认）**：PG@5433 的 `crm` schema 已 migrate+seed（全量 398 绿基线）。运行测试用 `node node_modules/vitest/vitest.mjs run <file>`（禁 npx/npm install，与项目沙箱惯例一致）。

---

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `db/schema.sql` | Modify | 追加 `crm.mcp_identity` 表（幂等 DDL） |
| `src/mcp/issueToken.js` | Create | 颁发 token：生成明文 + pgcrypto 哈希入库（幂等），返回明文给 owner |
| `scripts/issue-mcp-token.js` | Create | CLI 包装 `issueToken`，打印明文 token（仅本地终端） |
| `src/mcp/auth.js` | Modify | `resolveIdentity`（持久查表替代 `config.apiToken`）+ `buildMcpCtx` 改 async 注入身份字段 |
| `src/mcp/intent.js` | Create | `resolveEffectiveRole` + 域标签归一 `DOMAIN_ALIAS` |
| `src/mcp/gateway.js` | Modify | 注入 `focus_domain` / `over_scope`；confirm 表单透明化；所有 `buildMcpCtx` 调用补 `await` |
| `test/mcp-identity.test.js` | Create | T1/T2 表与 seed 验证 |
| `test/mcp-auth.test.js` | Create | T3/T4 `resolveIdentity` 单测 |
| `test/mcp-intent.test.js` | Create | T5/T7 意图校正 + 域对齐 |
| `test/mcp-gateway-focus.test.js` | Create | T6 focus_domain 注入与 confirm 表单 |
| `docs/superpowers/specs/2026-08-26-mcp-role-binding-design.md` | Modify | 状态 → 已落地 |

---

## Task 1: `crm.mcp_identity` 表 DDL

**Files:**
- Modify: `db/schema.sql`（末尾追加）
- Test: `test/mcp-identity.test.js`

- [ ] **Step 1: 写失败测试（断言表存在）**

```js
// test/mcp-identity.test.js
import { query } from '../src/db.js';
import { afterAll } from 'vitest';

describe('crm.mcp_identity schema', () => {
  it('表 crm.mcp_identity 已存在且列齐全', async () => {
    const r = await query(
      `SELECT column_name FROM information_schema.columns
         WHERE table_schema='crm' AND table_name='mcp_identity'
         ORDER BY column_name`,
      []
    );
    const cols = r.rows.map(x => x.column_name).sort();
    expect(cols).toEqual(
      ['actor','created_at','enabled','expires_at','id','person_id','revoked_at','role_tag','scopes','token_hash'].sort()
    );
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/mcp-identity.test.js -t "表 crm.mcp_identity"`
Expected: FAIL（`relation "crm.mcp_identity" does not exist`）

- [ ] **Step 3: 写 DDL（追加到 `db/schema.sql` 末尾）**

```sql
-- ============ MCP 身份持久绑定（2026-08-26 设计：身份基线 + 意图校正）============
-- token 仅存哈希（pgcrypto crypt），明文永不出 node 进程到日志；吊销用 revoked_at 软标记，绝对禁删
CREATE TABLE IF NOT EXISTS crm.mcp_identity (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash   text UNIQUE NOT NULL,
  actor        text NOT NULL,
  person_id    uuid,                         -- 真实身份（CRM_PERSON 粒子 id / crm_users.user_id），可空=外部接入方；不强制 FK 避免引用不存在表
  role_tag     text NOT NULL,
  scopes       jsonb NOT NULL DEFAULT '{}'::jsonb,   -- 可选域级收窄 {deny_domains:[...]}
  expires_at   timestamptz,
  enabled      boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz,
  CONSTRAINT fk_mcp_identity_role FOREIGN KEY (role_tag) REFERENCES crm.role_context_profile(role_tag)
);
CREATE INDEX IF NOT EXISTS idx_mcp_identity_token ON crm.mcp_identity(token_hash);
CREATE INDEX IF NOT EXISTS idx_mcp_identity_actor ON crm.mcp_identity(actor);
```

- [ ] **Step 4: 运行 migrate 并测试通过**

```bash
node db/migrate.js --seed || npm run migrate   # 项目 migrate 入口（幂等）
node node_modules/vitest/vitest.mjs run test/mcp-identity.test.js -t "表 crm.mcp_identity"
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add db/schema.sql test/mcp-identity.test.js
git commit -m "feat(mcp): add crm.mcp_identity table (persistent role binding)"
```

---

## Task 2: 颁发 token（owner 直绑 exec）

**Files:**
- Create: `src/mcp/issueToken.js`
- Create: `scripts/issue-mcp-token.js`
- Test: `test/mcp-identity.test.js`（追加 describe）

- [ ] **Step 1: 写失败测试（断言颁发后查到 owner/exec）**

```js
// 追加到 test/mcp-identity.test.js
import { issueToken } from '../src/mcp/issueToken.js';

describe('issueToken', () => {
  it('颁发 owner=wangchuan role=exec 并入库', async () => {
    const { tokenPlain, identityId } = await issueToken({ actor: 'wangchuan', roleTag: 'exec', scopes: {} });
    expect(typeof tokenPlain).toBe('string');
    expect(tokenPlain.length).toBeGreaterThan(16);
    const r = await query(
      `SELECT actor, role_tag, enabled FROM crm.mcp_identity WHERE id=$1`,
      [identityId]
    );
    expect(r.rows[0]).toMatchObject({ actor: 'wangchuan', role_tag: 'exec', enabled: true });
  });

  it('重复颁发同 actor+role 幂等（不新增行）', async () => {
    const before = (await query(`SELECT count(*)::int n FROM crm.mcp_identity WHERE actor='wangchuan'`)).rows[0].n;
    await issueToken({ actor: 'wangchuan', roleTag: 'exec', scopes: {} });
    const after = (await query(`SELECT count(*)::int n FROM crm.mcp_identity WHERE actor='wangchuan'`)).rows[0].n;
    expect(after).toBe(before);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/mcp-identity.test.js -t "issueToken"`
Expected: FAIL（`Cannot find module '../src/mcp/issueToken.js'`）

- [ ] **Step 3: 实现 `src/mcp/issueToken.js`**

```js
// src/mcp/issueToken.js — 颁发 MCP 接入 token（零信任：明文仅返回给调用方，库只存 pgcrypto 哈希）
import { randomBytes } from 'node:crypto';
import { query } from '../db.js';

// 生成明文 token（24 字节 hex），用 pgcrypto crypt 哈希入库；幂等：同 actor+role_tag 不重复插
// scopes: { deny_domains?: string[] }
export async function issueToken({ actor, roleTag, scopes = {}, expiresAt = null, personId = null }) {
  const tokenPlain = randomBytes(24).toString('hex');
  const r = await query(
    `INSERT INTO crm.mcp_identity (token_hash, actor, person_id, role_tag, scopes, expires_at)
       SELECT crypt($1, gen_salt('bf')), $2, $3, $4, $5::jsonb, $6
       WHERE NOT EXISTS (
         SELECT 1 FROM crm.mcp_identity WHERE actor=$2 AND role_tag=$4 AND revoked_at IS NULL
       )
       RETURNING id`,
    [tokenPlain, actor, personId, roleTag, JSON.stringify(scopes), expiresAt]
  );
  // 若已存在（幂等未插），取现有 id
  let id = r.rows[0]?.id;
  if (!id) {
    const e = await query(`SELECT id FROM crm.mcp_identity WHERE actor=$1 AND role_tag=$2 AND revoked_at IS NULL LIMIT 1`, [actor, roleTag]);
    id = e.rows[0].id;
  }
  return { tokenPlain, identityId: id };
}
```

- [ ] **Step 4: 实现 CLI `scripts/issue-mcp-token.js`**

```js
#!/usr/bin/env node
// scripts/issue-mcp-token.js — 本地颁发 MCP token（明文仅打印到本终端，不入库明文）
import { issueToken } from '../src/mcp/issueToken.js';

const [actor, roleTag, scopesArg] = process.argv.slice(2);
if (!actor || !roleTag) {
  console.error('用法: node scripts/issue-mcp-token.js <actor> <roleTag> [scopesJson]');
  process.exit(1);
}
const scopes = scopesArg ? JSON.parse(scopesArg) : {};
const { tokenPlain } = await issueToken({ actor, roleTag, scopes });
console.log(`\n已为 ${actor} 颁发角色 ${roleTag} 的 MCP token（请妥善保存，仅显示一次）：\n`);
console.log(`  ${tokenPlain}\n`);
console.log(`将其作为 Bearer token 或 api_token 参数传入 MCP 调用即可。\n`);
```

- [ ] **Step 5: 运行测试通过**

Run: `node node_modules/vitest/vitest.mjs run test/mcp-identity.test.js -t "issueToken"`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/mcp/issueToken.js scripts/issue-mcp-token.js test/mcp-identity.test.js
git commit -m "feat(mcp): issueToken + CLI for persistent role binding"
```

---

## Task 3: `resolveIdentity` 持久查表 + `buildMcpCtx` 改 async

**Files:**
- Modify: `src/mcp/auth.js`
- Modify: `src/mcp/gateway.js`（4 处 `buildMcpCtx` 调补 `await`）
- Test: `test/mcp-auth.test.js`

- [ ] **Step 1: 写失败测试**

```js
// test/mcp-auth.test.js
import { resolveIdentity } from '../src/mcp/auth.js';
import { issueToken } from '../src/mcp/issueToken.js';

describe('resolveIdentity', () => {
  it('命中 owner token → role=exec, degraded=false', async () => {
    const { tokenPlain } = await issueToken({ actor: 'wangchuan', roleTag: 'exec', scopes: {} });
    const r = await resolveIdentity(tokenPlain);
    expect(r.role).toBe('exec');
    expect(r.degraded).toBe(false);
    expect(r.actor).toBe('wangchuan');
  });

  it('无 token → 降级 sales', async () => {
    const r = await resolveIdentity(null);
    expect(r.role).toBe('sales');
    expect(r.degraded).toBe(true);
  });

  it('未知 token → 降级 sales', async () => {
    const r = await resolveIdentity('deadbeef'.repeat(12));
    expect(r.role).toBe('sales');
    expect(r.degraded).toBe(true);
  });

  it('过期 token → 降级 sales', async () => {
    const { tokenPlain } = await issueToken({ actor: 'expuser', roleTag: 'sales', scopes: {}, expiresAt: new Date(Date.now() - 1000) });
    const r = await resolveIdentity(tokenPlain);
    expect(r.role).toBe('sales');
    expect(r.degraded).toBe(true);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/mcp-auth.test.js -t "resolveIdentity"`
Expected: FAIL（`resolveIdentity is not a function`）

- [ ] **Step 3: 改造 `src/mcp/auth.js`**

在 `auth.js` 顶部 `import { MCP_CONFIG } from './config.js';` 之后新增：
```js
import { query } from '../db.js';
```
将 `resolveApiToken` 保留为兼容薄壳（标记 deprecated），新增：
```js
// 持久查表解析身份（替代 config.apiToken 内存映射）；token 用 pgcrypto crypt 比对，明文不出 node
export async function resolveIdentity(token) {
  if (!token) return mk(null, MCP_CONFIG.security.minPrivilegeFallback, true, '无凭证：未携带 token', true);
  const r = await query(
    `SELECT id, actor, person_id, role_tag, scopes, expires_at, enabled
       FROM crm.mcp_identity WHERE token_hash = crypt($1, token_hash)`,
    [token]
  );
  const row = r.rows[0];
  if (!row || !row.enabled) return mk(null, MCP_CONFIG.security.minPrivilegeFallback, true, '未知 token：凭证未配置或已失效', true);
  if (row.expires_at && row.expires_at < new Date()) return mk(null, MCP_CONFIG.security.minPrivilegeFallback, true, 'token 已过期', true);
  const base = mk(row.actor, row.role_tag, false, null, false);
  base.identity_id = row.id;
  base.person_id = row.person_id;
  base.scopes = row.scopes && typeof row.scopes === 'object' ? row.scopes : {};
  return base;
}
```
将 `buildMcpCtx` 改为 async 并改用 `resolveIdentity`：
```js
export async function buildMcpCtx({ token, actor: explicitActor, tenantId = 'system', decisionId = null, channel = 'mcp' } = {}) {
  const r = await resolveIdentity(token);
  const { actor, role, degraded, degraded_reason, prompt_needed, identity_id, person_id, scopes } = r;
  const finalActor = explicitActor || actor;
  return {
    tenantId,
    actor: finalActor,
    role,
    identity_id,
    person_id,
    scopes,
    channel,
    degraded,
    degraded_reason,
    prompt_needed,
    decision_id: decisionId,
  };
}
```
`resolveApiToken` 保留（旧调用方兼容），内部可转发 `resolveIdentity` 同步结果——但因 async，建议直接保留旧内存查表逻辑不动（不影响新路径），并在注释标 `@deprecated 用 resolveIdentity`。

- [ ] **Step 4: `gateway.js` 4 处 `buildMcpCtx` 调用补 `await`**

`src/mcp/gateway.js` 中：`mcpWritePhase1`（:58）、`mcpReadSensitivePhase1`（:75）、`mcpConfirmPhase2`（:104）、`mcpReadDirect`（:120）四处 `const ctx = buildMcpCtx({...})` 改为 `const ctx = await buildMcpCtx({...})`。（grep 全仓确认无其它调用点。）

- [ ] **Step 5: 运行测试通过**

Run: `node node_modules/vitest/vitest.mjs run test/mcp-auth.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/mcp/auth.js src/mcp/gateway.js test/mcp-auth.test.js
git commit -m "feat(mcp): resolveIdentity persistent lookup + async buildMcpCtx"
```

---

## Task 4: ctx 身份字段透传验证

**Files:**
- Test: `test/mcp-auth.test.js`（追加）

- [ ] **Step 1: 写测试（断言 ctx 含 identity/person/scopes）**

```js
import { buildMcpCtx } from '../src/mcp/auth.js';
import { issueToken } from '../src/mcp/issueToken.js';

describe('buildMcpCtx identity injection', () => {
  it('owner token → ctx 含 identity_id/person_id/scopes', async () => {
    const { tokenPlain, identityId } = await issueToken({ actor: 'wangchuan', roleTag: 'exec', scopes: { deny_domains: ['CRM_CUSTOMER'] } });
    const ctx = await buildMcpCtx({ token: tokenPlain });
    expect(ctx.identity_id).toBe(identityId);
    expect(ctx.role).toBe('exec');
    expect(ctx.scopes).toEqual({ deny_domains: ['CRM_CUSTOMER'] });
  });

  it('无 token → ctx 缺 identity_id 且 degraded', async () => {
    const ctx = await buildMcpCtx({ token: null });
    expect(ctx.identity_id).toBeUndefined();
    expect(ctx.degraded).toBe(true);
    expect(ctx.role).toBe('sales');
  });
});
```

- [ ] **Step 2: 运行测试通过**

Run: `node node_modules/vitest/vitest.mjs run test/mcp-auth.test.js -t "buildMcpCtx identity injection"`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add test/mcp-auth.test.js
git commit -m "test(mcp): assert identity fields in ctx"
```

---

## Task 5: 意图校正引擎 `resolveEffectiveRole`

**Files:**
- Create: `src/mcp/intent.js`
- Test: `test/mcp-intent.test.js`

**背景（关键不一致）**：Action 的 `data_scope_domains` 用 `CRM_INVOICE`/`CRM_PAYMENT_RECORD`/`CRM_DEAL` 等大写前缀；`role_context_profile.data_scope.domain` 用 `payment`/`contract`/`invoice`/`CRM_DEAL`/`CRM_TECHNICAL_PROPOSAL`。须 `DOMAIN_ALIAS` 归一后比对。

- [ ] **Step 1: 写失败测试**

```js
// test/mcp-intent.test.js
import { resolveEffectiveRole } from '../src/mcp/intent.js';
import { getAction } from '../src/action/registry.js';

describe('resolveEffectiveRole', () => {
  it('exec(all) + crm-finance-receivables → focus=[invoice,payment], over_scope=false', async () => {
    const r = await resolveEffectiveRole('exec', 'crm-finance-receivables', {});
    expect(r.effective_role).toBe('exec');
    expect(r.focus_domain.sort()).toEqual(['invoice', 'payment']);
    expect(r.over_scope).toBe(false);
  });

  it('finance(domain[payment,contract,invoice]) + crm-customer-360[CRM_CUSTOMER,CRM_DEAL,CRM_CONTRACT] → 交集=contract, over_scope=true', async () => {
    const r = await resolveEffectiveRole('finance', 'crm-customer-360', {});
    expect(r.focus_domain).toEqual(['contract']);
    expect(r.over_scope).toBe(true);
  });

  it('Action 无 data_scope_domains → 不收窄（focus=全量，over_scope=false）', async () => {
    const r = await resolveEffectiveRole('exec', 'crm-deal-advance', {});
    expect(r.over_scope).toBe(false);
    expect(Array.isArray(r.focus_domain)).toBe(true);
  });

  it('scopes.deny_domains 收窄生效', async () => {
    const r = await resolveEffectiveRole('exec', 'crm-finance-receivables', { deny_domains: ['payment'] });
    expect(r.focus_domain).toEqual(['invoice']);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/mcp-intent.test.js -t "resolveEffectiveRole"`
Expected: FAIL（`Cannot find module '../src/mcp/intent.js'`）

- [ ] **Step 3: 实现 `src/mcp/intent.js`**

```js
// src/mcp/intent.js — 意图校正：在角色基线合法域内按本次操作数据域聚焦（只聚焦、不升权）
import { getAction } from '../action/registry.js';
import { loadProfile } from '../context/roleProfiles.js';

// 域标签归一（Action 侧 CRM_* 大写前缀 ↔ profile 侧小写；仅桥接，不新增业务域）
const DOMAIN_ALIAS = {
  CRM_CUSTOMER: 'customer',
  CRM_DEAL: 'CRM_DEAL',
  CRM_CONTRACT: 'contract',
  CRM_INVOICE: 'invoice',
  CRM_PAYMENT_RECORD: 'payment',
  CRM_TECHNICAL_PROPOSAL: 'CRM_TECHNICAL_PROPOSAL',
};
const norm = (d) => DOMAIN_ALIAS[d] || d;

// 基线角色的合法数据域（来自 role_context_profile.data_scope）
async function baseDomains(baseRole) {
  const p = await loadProfile(baseRole);
  if (!p) return [];
  const m = p.data_scope?.model;
  if (m === 'all') return 'ALL';
  if (m === 'domain') return (p.data_scope.domain || []).map(norm);
  // self / org_subtree：域级聚焦无意义（由 Action 自身 owner 过滤），返回 ALL
  return 'ALL';
}

// 返回 { effective_role, focus_domain, over_scope, denied_domains }
// 不修改 role；越域不放大权限，仅标记 over_scope 供展示（既有第1.5闸按 rbac_roles 决定拒绝）
export async function resolveEffectiveRole(baseRole, actionName, scopes = {}) {
  const def = getAction(actionName);
  const actionDomains = (def?.data_scope_domains || []).map(norm);
  const denied = (scopes?.deny_domains || []).map(norm);
  const base = await baseDomains(baseRole);

  if (base === 'ALL') {
    const focus = actionDomains.filter(d => !denied.includes(d));
    return { effective_role: baseRole, focus_domain: focus, over_scope: false, denied_domains: denied };
  }
  const focus = actionDomains.filter(d => base.includes(d) && !denied.includes(d));
  const over_scope = actionDomains.some(d => !base.includes(d));
  return { effective_role: baseRole, focus_domain: focus, over_scope, denied_domains: denied };
}
```

- [ ] **Step 4: 运行测试通过**

Run: `node node_modules/vitest/vitest.mjs run test/mcp-intent.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/mcp/intent.js test/mcp-intent.test.js
git commit -m "feat(mcp): intent correction engine resolveEffectiveRole"
```

---

## Task 6: gateway 注入 focus_domain + confirm 表单透明化

**Files:**
- Modify: `src/mcp/gateway.js`
- Test: `test/mcp-gateway-focus.test.js`

- [ ] **Step 1: 写失败测试**

```js
// test/mcp-gateway-focus.test.js
import { mcpWritePhase1 } from '../src/mcp/gateway.js';
import { issueToken } from '../src/mcp/issueToken.js';

describe('gateway focus_domain injection', () => {
  it('owner exec 调 crm-finance-receivables → form 含 focus_domain 且不为 over_scope', async () => {
    await issueToken({ actor: 'wangchuan', roleTag: 'exec', scopes: {} });
    const { tokenPlain } = await issueToken({ actor: 'fintest', roleTag: 'finance', scopes: {} });
    // 用 owner 的 exec token：需先为 wangchuan 发 token 并传参
    const owner = await issueToken({ actor: 'wangchuan', roleTag: 'exec', scopes: {} });
    const r = await mcpWritePhase1('crm-finance-receivables', { decision_id: '00000000-0000-0000-0000-000000000000', api_token: owner.tokenPlain }, {});
    expect(r.ok).toBe(true);
    expect(r.form.focus_domain).toEqual(['invoice', 'payment']);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/mcp-gateway-focus.test.js -t "owner exec"`
Expected: FAIL（`r.form.focus_domain` undefined，因未注入）

- [ ] **Step 3: 改造 `src/mcp/gateway.js`**

在 `gateway.js` 顶部 import 增加：
```js
import { resolveEffectiveRole } from './intent.js';
```
`buildConfirmForm`（:41-53）增加 `focus_domain` 参数与字段：
```js
function buildConfirmForm(actionName, def, ctx, params, focusDomain = null) {
  return {
    code: 'CONFIRM_REQUIRED',
    action: actionName,
    kind: def.kind,
    actor: ctx.actor,
    role: ctx.role,
    focus_domain: focusDomain,
    switch_options: SWITCH_OPTIONS,
    decision_id: ctx.decision_id || params?.decision_id || null,
    impact_scope: def.data_scope_domains || null,
  };
}
```
`mcpWritePhase1`（:56-70）在 `const def = getAction(actionName);` 后注入意图校正：
```js
  const intent = await resolveEffectiveRole(ctx.role, actionName, ctx.scopes || {});
  ctx.focus_domain = intent.focus_domain;
  ctx.over_scope = intent.over_scope;
  const confirm_token = issueSession(actionName, 'write', params, ctx);
  emit('trace', 'mcp-write-phase1-confirm-issued', { action: actionName, actor: ctx.actor, focus_domain: intent.focus_domain });
  const extra = (ctx.degraded && ctx.prompt_needed) ? { degraded: true, prompt: buildDegradedPrompt() } : {};
  return { ok: true, confirm_token, ...extra, form: { ...buildConfirmForm(actionName, def, ctx, params, intent.focus_domain), degraded: ctx.degraded } };
```
`mcpReadSensitivePhase1`（:73-81）同法注入 `intent` 与 `buildConfirmForm(..., intent.focus_domain)`。
`mcpReadDirect`（:118-124）在 `buildMcpCtx` 后加 `const intent = await resolveEffectiveRole(ctx.role, actionName, ctx.scopes||{}); ctx.focus_domain = intent.focus_domain;`（读直连无需 confirm，仅透传 ctx）。

> 注：`issueSession`（:30-38）将 `ctx` 存入 session；`focus_domain`/`over_scope` 随 ctx 持久化，phase2 执行时可见（不改第 1.5 闸拒绝逻辑）。

- [ ] **Step 4: 运行测试通过**

Run: `node node_modules/vitest/vitest.mjs run test/mcp-gateway-focus.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/mcp/gateway.js test/mcp-gateway-focus.test.js
git commit -m "feat(mcp): inject focus_domain into gateway + confirm form"
```

---

## Task 7: 域标签对齐核对（DOMAIN_ALIAS 覆盖全部已知域）

**Files:**
- Modify: `src/mcp/intent.js`（如有遗漏域补 `DOMAIN_ALIAS`）
- Test: `test/mcp-intent.test.js`（追加全 Action 域覆盖断言）

- [ ] **Step 1: 写测试（扫描 seed-actions 所有 data_scope_domains 均被归一覆盖）**

```js
import { SEED_ACTIONS } from '../src/action/seed-actions.js';
import { norm } from '../src/mcp/intent.js'; // 若 norm 未导出，临时在测试内复制映射断言

describe('domain alias coverage', () => {
  it('seed-actions 中所有 data_scope_domains 均能被 DOMAIN_ALIAS 归一（无 undefined 映射）', () => {
    const ALIAS = {
      CRM_CUSTOMER: 'customer', CRM_DEAL: 'CRM_DEAL', CRM_CONTRACT: 'contract',
      CRM_INVOICE: 'invoice', CRM_PAYMENT_RECORD: 'payment', CRM_TECHNICAL_PROPOSAL: 'CRM_TECHNICAL_PROPOSAL',
    };
    const seen = new Set();
    for (const a of SEED_ACTIONS) {
      for (const d of (a.data_scope_domains || [])) {
        expect(ALIAS[d]).toBeDefined();
        seen.add(d);
      }
    }
    // 已知敏感读域应全部覆盖
    expect([...seen].sort()).toEqual(['CRM_CONTRACT','CRM_CUSTOMER','CRM_DEAL','CRM_INVOICE','CRM_PAYMENT_RECORD'].sort());
  });
});
```
> 若 `SEED_ACTIONS` 非具名导出，改为在测试内 `import { seedActions }` 或读取 `registry` 全量（按实际导出名调整，不臆造）。

- [ ] **Step 2: 运行测试；若失败（出现未覆盖域）则回填 `DOMAIN_ALIAS`**

Run: `node node_modules/vitest/vitest.mjs run test/mcp-intent.test.js -t "domain alias coverage"`
Expected: PASS（如 FAIL，在 `intent.js` 的 `DOMAIN_ALIAS` 补缺失键后重跑）

- [ ] **Step 3: Commit**

```bash
git add src/mcp/intent.js test/mcp-intent.test.js
git commit -m "test(mcp): domain alias covers all seeded action scopes"
```

---

## Task 8: 全量测试 + 设计文档状态更新

**Files:**
- Modify: `docs/superpowers/specs/2026-08-26-mcp-role-binding-design.md`

- [ ] **Step 1: 跑全量测试**

Run: `node node_modules/vitest/vitest.mjs run`
Expected: 全绿（基线 398 + 本计划新增约 18 用例）

- [ ] **Step 2: 更新设计文档状态**

将 `docs/superpowers/specs/2026-08-26-mcp-role-binding-design.md` 顶部 `状态：已批准（brainstorming 阶段，待 writing-plans 落地）` 改为 `状态：已落地（T1–T8 全绿）`；在末尾追加：
```
## §11 落地记录（2026-08-26）
- T1–T8 全绿；新增 crm.mcp_identity 表 + issueToken + resolveIdentity + intent.js + gateway focus_domain 注入。
- 已知域标签不一致由 intent.js DOMAIN_ALIAS 归一桥接（CRM_* ↔ 小写），未改 Action 种子语义。
```

- [ ] **Step 3: 运行频控检查（确认无回归）**

Run: `node node_modules/vitest/vitest.mjs run test/mcp-gateway.test.js`
Expected: PASS（既有 MCP 网关测试不被破坏；owner 高权限工具不再被 sales 基线误挡）

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-08-26-mcp-role-binding-design.md
git commit -m "docs(mcp): mark role-binding plan as landed"
```

---

## Self-Review（写后自查）

1. **Spec 覆盖**：§3 mcp_identity 表 → T1；§3 seed owner → T2；§4 resolveIdentity → T3/T4；§5 intent.js + DOMAIN_ALIAS → T5/T7；§6 gateway 注入 → T6；§7 测试 → 各 Task 单测 + T8 全量；§8 YAGNI → 未引入 OAuth/LLM 推断（符合）；§9 T1–T8 → 全部有对应 Task。
2. **Placeholder 扫描**：无 TBD/TODO；每步含完整代码；T7 测试内 `SEED_ACTIONS` 导出名以实际为准并注明调整方式（非占位，是防臆造指引）。
3. **类型一致性**：`resolveIdentity` 返回 `{actor,role,degraded,degraded_reason,prompt_needed,identity_id,person_id,scopes}` 在 T3/T4 测试一致；`resolveEffectiveRole` 返回 `{effective_role,focus_domain,over_scope,denied_domains}` 在 T5/T6 一致；`buildConfirmForm` 第五参 `focusDomain` 与调用处一致。
4. **DB 依赖**：所有测试依赖 PG@5433 crm schema 已 migrate（T1 Step 4 跑 migrate）；`crypt`/`gen_salt` 来自 `pgcrypto`（schema.sql:7 已 `CREATE EXTENSION`）。
5. **风险点**：`buildMcpCtx` 改 async 影响所有调用方 —— T3 Step 4 已列出 gateway.js 4 处补 `await`，并提示 grep 全仓；server.js/tools.js 若另有调用需同步补 `await`（实施时 grep 核对）。
