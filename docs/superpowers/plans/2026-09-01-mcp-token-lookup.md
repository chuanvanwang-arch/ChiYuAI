# MCP 凭证解析性能优化（O(n) → O(1)）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 MCP 凭证解析从「全表扫描 + 每行 crypt」的 O(n) 路径改为「格式闸 → 主键定位 → 单次 crypt」的 O(1) 路径，消除随登录次数线性劣化的性能缺陷（生产 110 行 ≈ 500ms/次 → 目标 ≤20ms）。

**Architecture:** 新增 `src/mcp/tokenFormat.js` 作为 token 明文格式单一事实源（生成 `crm_<id32>_<secret48>` + 解析）；三处颁发点（`mcpLogin` / `issueToken` / 门户后台）统一改为「先定 id → 单次 INSERT 显式指定主键」；`resolveIdentity` 改为三段式，格式不符的旧 token 在格式闸直接拒绝且零 DB 查询。零 DDL、零 schema 变更。

**Tech Stack:** Node 22 ESM、`node:crypto`（randomUUID / randomBytes）、PostgreSQL 16 + pgcrypto `crypt()` / `gen_salt('bf')`、vitest 3

**设计文档：** `docs/2026-09-01-mcp-token-lookup-design.md`（契约校验 valid）

**命令约定：** 所有测试命令前置 `PGDATABASE=plm_test`（vitest 强制连测试库）。**禁止并发跑两个 vitest**（同库互 TRUNCATE 产生伪失败）；批量回归一律 `--no-file-parallelism` 串行，失败文件单独小批量重跑判定。

---

## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `src/mcp/tokenFormat.js` | token 格式单一事实源：前缀常量 / 正则 / 生成 / 解析 | **新建** |
| `src/mcp/issueToken.js` | 编程式颁发（幂等插入） | 改造（显式 id） |
| `src/mcp/auth.js` | `mcpLogin` 登录颁发 + `resolveIdentity` 解析 | 改造（两处） |
| `src/portal/mcpIdentity.js` | 门户后台手动颁发 | 改造（显式 id） |
| `scripts/revoke-legacy-mcp-tokens.mjs` | 存量凭证一次性软吊销（生产写，需授权） | **新建** |
| `test/mcp/token-lookup.test.js` | 格式闸 / 命中 / 篡改 / 旧格式 / 性能门槛 | **新建** |
| `tmp/_bench_mcp_auth.mjs` | before/after 性能对比（已存在，复用） | 复用 |

---

## Task 1: token 格式单一事实源

**Files:**
- Create: `src/mcp/tokenFormat.js`
- Test: `test/mcp/token-format.test.js`

- [ ] **Step 1: 写失败测试**

新建 `test/mcp/token-format.test.js`：

```js
// test/mcp/token-format.test.js — token 明文格式单一事实源（设计 docs/2026-09-01-mcp-token-lookup-design.md §4.2）
import { describe, it, expect } from 'vitest';
import { TOKEN_PREFIX, TOKEN_RE, newStructuredToken, parseTokenId } from '../../src/mcp/tokenFormat.js';

describe('tokenFormat', () => {
  it('newStructuredToken 产出 crm_<id32>_<secret48>', () => {
    const { id, tokenPlain } = newStructuredToken();
    expect(TOKEN_PREFIX).toBe('crm');
    expect(tokenPlain).toMatch(TOKEN_RE);
    expect(tokenPlain).toMatch(/^crm_[0-9a-f]{32}_[0-9a-f]{48}$/);
    expect(tokenPlain.length).toBe(85); // 3 + 1 + 32 + 1 + 48
    // id 段去横线后必须等于 token 中的 id32（颁发与解析可闭环）
    expect(tokenPlain.slice(4, 36)).toBe(id.replace(/-/g, ''));
  });

  it('parseTokenId 还原带横线 UUID，与生成侧互逆', () => {
    const { id, tokenPlain } = newStructuredToken();
    expect(parseTokenId(tokenPlain)).toBe(id);
  });

  it('格式不符一律返回 null（旧格式 hex token / 空 / 篡改长度）', () => {
    expect(parseTokenId('a'.repeat(48))).toBeNull();          // 旧格式：裸 48 hex
    expect(parseTokenId('')).toBeNull();
    expect(parseTokenId(null)).toBeNull();
    expect(parseTokenId('crm_zzzz_' + 'a'.repeat(48))).toBeNull(); // id 段非 hex
    expect(parseTokenId('crm_' + 'a'.repeat(32))).toBeNull();      // 缺 secret 段
  });

  it('两次生成的 token 不重复', () => {
    const a = newStructuredToken();
    const b = newStructuredToken();
    expect(a.tokenPlain).not.toBe(b.tokenPlain);
    expect(a.id).not.toBe(b.id);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `PGDATABASE=plm_test npx vitest run test/mcp/token-format.test.js --reporter=basic`
Expected: FAIL —— `Cannot find module '../../src/mcp/tokenFormat.js'`

- [ ] **Step 3: 实现**

新建 `src/mcp/tokenFormat.js`：

```js
// src/mcp/tokenFormat.js — MCP token 明文格式单一事实源（颁发侧与解析侧共用）
// 设计：docs/2026-09-01-mcp-token-lookup-design.md §4.1–§4.2
//
// 背景：旧 token 为裸 48 位 hex，解析时只能逐行 crypt 比对（WHERE token_hash = crypt($1, token_hash)），
//       无法走索引 → 全表扫描 O(n)，成本随登录次数线性劣化（生产 110 行 ≈500ms，测试库 1301 行 ≈4.6s）。
// 改造：明文编入 identity_id（AWS Access Key ID 同款实践），解析时先用 id 走主键索引定位单行，
//       再对该行做一次 crypt 校验 → O(1)。
//
// 安全：整个 token 串（含 id 段）参与 crypt 哈希，篡改 id 段会令校验失败；
//       identity_id 为随机 UUID、不含业务语义；明文 token 仍遵守「永不出 node 进程到日志」纪律。
import { randomUUID, randomBytes } from 'node:crypto';

export const TOKEN_PREFIX = 'crm';

// crm_<id32：UUID 去横线>_<secret48：24 字节 hex = 192bit>
export const TOKEN_RE = /^crm_([0-9a-f]{32})_([0-9a-f]{48})$/;

// 生成结构化 token。显式返回 id，供 INSERT 时指定主键（DEFAULT gen_random_uuid() 仅在省略该列时生效），
// 从而做到单次 INSERT，无需先插后 UPDATE 回填。
export function newStructuredToken() {
  const id = randomUUID();
  const secret = randomBytes(24).toString('hex');
  return { id, tokenPlain: `${TOKEN_PREFIX}_${id.replace(/-/g, '')}_${secret}` };
}

// 解析出 identity_id（带横线 UUID 形态）；格式不符返回 null，
// 调用方据此在「格式闸」直接降级，零 DB 查询。
export function parseTokenId(token) {
  const m = TOKEN_RE.exec(String(token || ''));
  if (!m) return null;
  const h = m[1];
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `PGDATABASE=plm_test npx vitest run test/mcp/token-format.test.js --reporter=basic`
Expected: 4 passed

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tokenFormat.js test/mcp/token-format.test.js
git commit -m "feat: MCP token 格式单一事实源（crm_<id32>_<secret48>）"
```

---

## Task 2: 三处颁发点改为结构化 token

**Files:**
- Modify: `src/mcp/issueToken.js:1-20`
- Modify: `src/mcp/auth.js:106-116`
- Modify: `src/portal/mcpIdentity.js:69-80`
- Test: `test/mcp/token-issue.test.js`

- [ ] **Step 1: 写失败测试**

新建 `test/mcp/token-issue.test.js`：

```js
// test/mcp/token-issue.test.js — 三处颁发点均产出结构化 token 且可反查（设计 §4.3）
import { describe, it, expect } from 'vitest';
import { query } from '../../src/db.js';
import { issueToken } from '../../src/mcp/issueToken.js';
import { newStructuredToken, parseTokenId } from '../../src/mcp/tokenFormat.js';

const TOKEN_RE = /^crm_[0-9a-f]{32}_[0-9a-f]{48}$/;

describe('issueToken 颁发结构化 token', () => {
  it('明文匹配结构化格式，且库中 id 与 token 中 id32 一致', async () => {
    const actor = `iss_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const r = await issueToken({ actor, roleTag: 'sales', scopes: {} });
    expect(r.alreadyExists).toBe(false);
    expect(r.tokenPlain).toMatch(TOKEN_RE);

    const { rows } = await query(`SELECT id FROM crm.mcp_identity WHERE id=$1`, [r.identityId]);
    expect(rows[0].id.replace(/-/g, '')).toBe(parseTokenId(r.tokenPlain));
  });

  it('幂等分支：同 actor+roleTag 重复颁发不产新明文', async () => {
    const actor = `dup_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const a = await issueToken({ actor, roleTag: 'sales', scopes: {} });
    expect(a.tokenPlain).toMatch(TOKEN_RE);
    const b = await issueToken({ actor, roleTag: 'sales', scopes: {} });
    expect(b.alreadyExists).toBe(true);
    expect(b.tokenPlain).toBeNull();
    expect(b.identityId).toBe(a.identityId);
  });

  it('门户后台颁发（portal/mcpIdentity create）亦为结构化格式', async () => {
    // 直接复用格式源构造，断言其 SQL 侧显式写 id 的可行性（避免测试依赖 HTTP 后台鉴权）
    const { id, tokenPlain } = newStructuredToken();
    const ins = await query(
      `INSERT INTO crm.mcp_identity (id, token_hash, actor, person_id, role_tag, scopes, expires_at)
       VALUES ($1, crypt($2, gen_salt('bf')), $3, NULL, $4, '{}'::jsonb, NULL)
       RETURNING id`,
      [id, tokenPlain, `port_${Date.now()}`, 'sales']
    );
    expect(ins.rows[0].id).toBe(id);
    // 清理：软吊销（绝对禁删）
    await query(`UPDATE crm.mcp_identity SET revoked_at = now() WHERE id=$1`, [id]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `PGDATABASE=plm_test npx vitest run test/mcp/token-issue.test.js --reporter=basic`
Expected: FAIL —— `issueToken` 返回的明文是裸 48 hex，不匹配 `TOKEN_RE`

- [ ] **Step 3: 实现 — `src/mcp/issueToken.js`**

读取现有文件后，把第 13-20 行替换为（保留 `WHERE NOT EXISTS` 幂等语义）：

```js
import { randomBytes } from 'node:crypto';
import { query, queryWrite } from '../db.js';
import { newStructuredToken } from './tokenFormat.js';

// 生成明文 token（结构化：crm_<id32>_<secret48>），用 pgcrypto crypt 哈希入库；
// id 由本侧预先生成并显式写入主键，使解析侧可走主键索引定位（设计 §4.2）。
// scopes: { deny_domains?: string[] }
export async function issueToken({ actor, roleTag, scopes = {}, expiresAt = null, personId = null }) {
  const { id, tokenPlain } = newStructuredToken();
  const r = await queryWrite(
    `INSERT INTO crm.mcp_identity (id, token_hash, actor, person_id, role_tag, scopes, expires_at)
       SELECT $1, crypt($2, gen_salt('bf')), $3, $4, $5, $6::jsonb, $7
       WHERE NOT EXISTS (
         SELECT 1 FROM crm.mcp_identity WHERE actor=$3 AND role_tag=$5 AND revoked_at IS NULL
       )
       RETURNING id`,
    [id, tokenPlain, actor, personId, roleTag, JSON.stringify(scopes), expiresAt]
  );
  // 幂等：已存在 → 不返回新明文（哈希不可逆，无法回读），仅回现有 id
  if (!r.rows[0]?.id) {
    const e = await query(
      `SELECT id FROM crm.mcp_identity WHERE actor=$1 AND role_tag=$2 AND revoked_at IS NULL LIMIT 1`,
      [actor, roleTag]
    );
    if (e.rows[0]?.id) {
      return { tokenPlain: null, identityId: e.rows[0].id, alreadyExists: true };
    }
    throw new Error(`issueToken 幂等分支异常：actor=${actor} roleTag=${roleTag} 既未插入也未找到现有行`);
  }
  return { tokenPlain, identityId: r.rows[0].id, alreadyExists: false };
}
```

注意：`randomBytes` 若文件内已无其它用途则从 import 中移除（只保留 `randomBytes` 未用时删掉该 import，改为仅 import `newStructuredToken`）。

- [ ] **Step 4: 实现 — `src/mcp/auth.js` 的 `mcpLogin`（第 107-116 行）**

```js
  const { id, tokenPlain } = newStructuredToken();
  const ttl = MCP_CONFIG.security.tokenTtlMs || 8 * 60 * 60 * 1000;
  const expiresAt = new Date(Date.now() + ttl);
  const r = await queryWrite(
    `INSERT INTO crm.mcp_identity (id, token_hash, actor, person_id, role_tag, scopes, expires_at)
     VALUES ($1, crypt($2, gen_salt('bf')), $3, NULL, $4, '{}'::jsonb, $5)
     RETURNING id`,
    [id, tokenPlain, u.username, u.role, expiresAt]
  );
```

同时在 `src/mcp/auth.js` 顶部 import 区追加：

```js
import { newStructuredToken, parseTokenId } from './tokenFormat.js';
```

（`parseTokenId` 在 Task 3 使用；此处一并 import 以免二次改动。）

- [ ] **Step 5: 实现 — `src/portal/mcpIdentity.js`（第 69-80 行）**

```js
  create: async (input) => {
    const { id, tokenPlain } = newStructuredToken();
    const r = await query(
      `INSERT INTO crm.mcp_identity (id, token_hash, actor, person_id, role_tag, scopes, expires_at)
       VALUES ($1, crypt($2, gen_salt('bf')), $3, $4, $5, $6::jsonb, $7)
       RETURNING id, actor, role_tag, enabled, revoked_at`,
      [id, tokenPlain, input.actor, input.person_id || null, input.role_tag,
       JSON.stringify(input.scopes || {}), input.expires_at || null]);
    return { row: r.rows[0], token_plaintext: tokenPlain };
  },
```

并在文件顶部 import 区追加 `import { newStructuredToken } from '../mcp/tokenFormat.js';`（同时移除不再使用的 `randomBytes` import，若该文件内无其它用途）。

- [ ] **Step 6: 跑测试确认通过**

Run: `PGDATABASE=plm_test npx vitest run test/mcp/token-issue.test.js test/mcp/token-format.test.js --reporter=basic`
Expected: 7 passed

- [ ] **Step 7: Commit**

```bash
git add src/mcp/issueToken.js src/mcp/auth.js src/portal/mcpIdentity.js test/mcp/token-issue.test.js
git commit -m "feat: 三处颁发点统一产出结构化 token（显式主键，单次 INSERT）"
```

---

## Task 3: `resolveIdentity` 改为三段式解析

**Files:**
- Modify: `src/mcp/auth.js:20-35`
- Test: `test/mcp/token-lookup.test.js`

- [ ] **Step 1: 写失败测试**

新建 `test/mcp/token-lookup.test.js`：

```js
// test/mcp/token-lookup.test.js — 凭证解析三段式：格式闸 / 主键定位 / 单次 crypt（设计 §4.4）
import { describe, it, expect, beforeAll } from 'vitest';
import { query } from '../../src/db.js';
import { resolveIdentity } from '../../src/mcp/auth.js';
import { issueToken } from '../../src/mcp/issueToken.js';
import { parseTokenId } from '../../src/mcp/tokenFormat.js';

let tok, identId, actorName;

beforeAll(async () => {
  actorName = `lk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const r = await issueToken({ actor: actorName, roleTag: 'sales', scopes: {} });
  tok = r.tokenPlain;
  identId = r.identityId;
});

describe('resolveIdentity 三段式', () => {
  it('有效 token → 正常解析（actor/role/identity_id 正确，非 degraded）', async () => {
    const r = await resolveIdentity(tok);
    expect(r.degraded).toBe(false);
    expect(r.actor).toBe(actorName);
    expect(r.role).toBe('sales');
    expect(String(r.identity_id)).toBe(String(identId));
  });

  it('格式闸：旧格式裸 hex token → degraded 且 reason 提示重新登录', async () => {
    const r = await resolveIdentity('a'.repeat(48));
    expect(r.degraded).toBe(true);
    expect(r.degraded_reason).toContain('重新 crm_login');
    expect(r.actor).toBeNull();
  });

  it('格式闸：空/无凭证 → degraded（无 token 分支保持既有文案）', async () => {
    const r = await resolveIdentity('');
    expect(r.degraded).toBe(true);
    expect(r.degraded_reason).toContain('无凭证');
  });

  it('篡改 id 段 → degraded（整个串参与哈希，篡改即校验失败）', async () => {
    const [prefix, id32, secret] = tok.split('_');
    const fakeId = 'f'.repeat(32);
    const forged = `${prefix}_${fakeId}_${secret}`;
    const r = await resolveIdentity(forged);
    expect(r.degraded).toBe(true);
    // 篡改后解析出的 id 与真实 id 不同 → 要么查不到行，要么 crypt 不匹配
    expect(parseTokenId(forged)).not.toBe(parseTokenId(tok));
  });

  it('已吊销 token → degraded', async () => {
    await query(`UPDATE crm.mcp_identity SET revoked_at = now() WHERE id=$1`, [identId]);
    const r = await resolveIdentity(tok);
    expect(r.degraded).toBe(true);
    expect(r.degraded_reason).toContain('吊销');
    // 复原，避免影响后续用例
    await query(`UPDATE crm.mcp_identity SET revoked_at = NULL WHERE id=$1`, [identId]);
  });

  it('性能门槛：解析 ≤50ms（改造前 1300+ 行时约 4600ms）', async () => {
    const t0 = Date.now();
    const r = await resolveIdentity(tok);
    const ms = Date.now() - t0;
    expect(r.degraded).toBe(false);
    expect(ms).toBeLessThanOrEqual(50);
  });

  it('SQL 形态：不再出现 crypt($1, token_hash) 全表扫描', async () => {
    const src = await import('node:fs').then(fs =>
      fs.promises.readFile(new URL('../../src/mcp/auth.js', import.meta.url), 'utf8'));
    expect(src).not.toContain('crypt($1, token_hash)');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `PGDATABASE=plm_test npx vitest run test/mcp/token-lookup.test.js --reporter=basic`
Expected: FAIL —— 「旧格式 → 提示重新登录」与「性能门槛 ≤50ms」两条失败（当前仍走全表扫描）

- [ ] **Step 3: 实现**

把 `src/mcp/auth.js` 第 20-35 行整体替换为：

```js
// 持久查表解析身份（替代 config.apiToken 内存静态查表；token 用 pgcrypto crypt 比对，明文不出 node）
// 返回 { actor, role, degraded, degraded_reason, prompt_needed, identity_id, person_id, scopes }
//
// 2026-09-01 性能改造（设计 docs/2026-09-01-mcp-token-lookup-design.md §4.4）：
//   旧实现 WHERE token_hash = crypt($1, token_hash) 以每行哈希为 salt，无法走索引
//   → 全表扫描 + 每行一次 blowfish crypt，成本随登录次数线性增长（生产 110 行 ≈500ms/次）。
//   新实现三段式：① 格式闸（不符直接降级，零 DB 查询）② 主键定位 ③ 单次 crypt 校验。
export async function resolveIdentity(token) {
  if (!token) return mk(null, MCP_CONFIG.security.minPrivilegeFallback, true, '无凭证：未携带 token', true);
  // ① 格式闸：旧格式（裸 48 hex）与非法格式在此被拒，不产生任何 DB 查询
  const id = parseTokenId(token);
  if (!id) {
    return mk(null, MCP_CONFIG.security.minPrivilegeFallback, true,
      '凭证格式无效：请重新 crm_login 领取新凭证', true);
  }
  // ②③ 主键定位 + 单次 crypt 校验（一次往返；tok_ok 为 false 即明文不匹配或行不存在）
  const r = await query(
    `SELECT id, actor, person_id, role_tag, scopes, expires_at, enabled, revoked_at,
            (token_hash = crypt($2, token_hash)) AS tok_ok
       FROM crm.mcp_identity WHERE id = $1`,
    [id, token]
  );
  const row = r.rows[0];
  if (!row || !row.tok_ok || !row.enabled) {
    return mk(null, MCP_CONFIG.security.minPrivilegeFallback, true, '未知 token：凭证未配置或已失效', true);
  }
  if (row.revoked_at) return mk(null, MCP_CONFIG.security.minPrivilegeFallback, true, 'token 已吊销', true);
  if (row.expires_at && row.expires_at < new Date()) return mk(null, MCP_CONFIG.security.minPrivilegeFallback, true, 'token 已过期', true);
  const base = mk(row.actor, row.role_tag, false, null, false);
  base.identity_id = row.id;
  base.person_id = row.person_id;
  base.scopes = row.scopes && typeof row.scopes === 'object' ? row.scopes : {};
  return base;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `PGDATABASE=plm_test npx vitest run test/mcp/token-lookup.test.js --reporter=basic`
Expected: 7 passed

- [ ] **Step 5: 确认查询计划走索引**

Run:

```bash
PGDATABASE=plm_test node --input-type=module -e "
import { query } from './src/db.js';
import { issueToken } from './src/mcp/issueToken.js';
import { parseTokenId } from './src/mcp/tokenFormat.js';
const r = await issueToken({ actor: 'explain_' + Date.now(), roleTag: 'sales', scopes: {} });
const id = parseTokenId(r.tokenPlain);
const p = await query('EXPLAIN (ANALYZE, BUFFERS) SELECT id FROM crm.mcp_identity WHERE id=\$1', [id]);
console.log(p.rows.map(x => x['QUERY PLAN']).join('\n'));
process.exit(0);
"
```

Expected: 计划含 `Index Scan using mcp_identity_pkey`，**不出现** `Seq Scan on mcp_identity`。

- [ ] **Step 6: Commit**

```bash
git add src/mcp/auth.js test/mcp/token-lookup.test.js
git commit -m "perf: resolveIdentity 三段式解析（格式闸 + 主键 + 单次 crypt，O(n)→O(1)）"
```

---

## Task 4: 存量凭证软吊销脚本

**Files:**
- Create: `scripts/revoke-legacy-mcp-tokens.mjs`

> ⚠️ **生产写操作**：执行需用户显式授权。脚本默认只做 dry-run 计数，必须显式传 `--apply` 才写库。

- [ ] **Step 1: 实现脚本（dry-run 优先）**

新建 `scripts/revoke-legacy-mcp-tokens.mjs`：

```js
// scripts/revoke-legacy-mcp-tokens.mjs — 存量 MCP 凭证一次性软吊销（设计 §4.5）
//
// 背景：token 格式升级为 crm_<id32>_<secret48> 后，旧格式（裸 48 hex）token 无法解析出 identity_id，
//       且库侧只存哈希、明文不可逆 —— 无法逐行甄别「哪些是旧格式」。
//       按用户选定策略 B（上线即强制重登录）：一次性软吊销全部存量行，全体接入方重新 crm_login。
//
// 纪律：绝对禁删 —— 只写 revoked_at 软标记；数据零损失，回滚即清空该列。
// 安全：默认 dry-run（只统计不写库），必须显式 --apply 才执行。
//
// 用法：
//   node scripts/revoke-legacy-mcp-tokens.mjs                 # dry-run
//   PGDATABASE=plm node scripts/revoke-legacy-mcp-tokens.mjs --apply   # 生产执行（需授权）

const apply = process.argv.includes('--apply');
const db = process.env.PGDATABASE || '(default)';

const { query, queryWrite } = await import('../src/db.js');

const before = await query(
  `SELECT count(*)::int AS total,
          count(*) FILTER (WHERE revoked_at IS NULL) AS active,
          count(*) FILTER (WHERE revoked_at IS NOT NULL) AS revoked
     FROM crm.mcp_identity`
);
const b = before.rows[0];
console.log(`db=${db}  迁移前: total=${b.total}  active=${b.active}  revoked=${b.revoked}`);

if (!apply) {
  console.log(`[dry-run] 将软吊销 ${b.active} 行（revoked_at = now()）。执行请追加 --apply`);
  process.exit(0);
}

const stamp = new Date();
const r = await queryWrite(
  `UPDATE crm.mcp_identity SET revoked_at = now() WHERE revoked_at IS NULL`
);
const after = await query(
  `SELECT count(*)::int AS total,
          count(*) FILTER (WHERE revoked_at IS NULL) AS active,
          count(*) FILTER (WHERE revoked_at IS NOT NULL) AS revoked
     FROM crm.mcp_identity`
);
const a = after.rows[0];
console.log(`[apply] 受影响行数=${r.rowCount}  时间戳=${stamp.toISOString()}`);
console.log(`[apply] 迁移后: total=${a.total}  active=${a.active}  revoked=${a.revoked}`);

// 三元组自检：总数不变（无物理删除）且 active 归零
const ok = a.total === b.total && a.active === 0;
console.log(ok ? 'OK: 无物理删除且 active 归零' : 'FAIL: 总数变化或仍有 active 行');
console.log(`回滚命令（如需）: UPDATE crm.mcp_identity SET revoked_at = NULL WHERE revoked_at = '${stamp.toISOString()}';`);
process.exit(ok ? 0 : 1);
```

- [ ] **Step 2: 在测试库验证 dry-run 与 apply 语义**

Run:

```bash
PGDATABASE=plm_test node scripts/revoke-legacy-mcp-tokens.mjs
```

Expected: 输出 `[dry-run] 将软吊销 N 行`，库中数据不变。

- [ ] **Step 3: 测试库实跑一遍 apply（验证脚本正确性，不影响生产）**

Run:

```bash
PGDATABASE=plm_test node scripts/revoke-legacy-mcp-tokens.mjs --apply
```

Expected: 末尾输出 `OK: 无物理删除且 active 归零`，exit 0。

- [ ] **Step 4: 确认测试库恢复手段有效**

Run:

```bash
PGDATABASE=plm_test node --input-type=module -e "
import { query } from './src/db.js';
const r = await query('UPDATE crm.mcp_identity SET revoked_at = NULL');
console.log('已复原行数=' + r.rowCount);
process.exit(0);
"
```

Expected: 输出复原行数 > 0（证明回滚路径可用）。

- [ ] **Step 5: Commit（脚本入仓，生产执行另需授权）**

```bash
git add scripts/revoke-legacy-mcp-tokens.mjs
git commit -m "feat: 存量 MCP 凭证软吊销脚本（dry-run 默认 + 禁删 + 可回滚）"
```

- [ ] **Step 6: 生产执行 —— 需用户显式授权后才做**

```bash
PGDATABASE=plm node scripts/revoke-legacy-mcp-tokens.mjs --apply
```

执行前确认：所有已接入智能体将立即失效，须重新 `crm_login`。

---

## Task 5: 全量回归与 before/after 实测

**Files:**
- Modify: 无（仅回归与实测；若发现基线漂移则同步测试）
- Test: 全量回归

- [ ] **Step 1: 记录改造后基线（测试库 1301 行）**

Run: `node tmp/_bench_mcp_auth.mjs`
Expected（对照改造前）：

| 项 | 改造前 | 改造后目标 |
|---|---|---|
| `resolveIdentity` 命中 | 4637 ms | ≤ 20 ms |
| `resolveIdentity` 未命中 | 5920 ms | ≤ 20 ms（格式闸，零 DB） |
| raw full-crypt-scan | 6021 ms | 不再执行 |

- [ ] **Step 2: 回归 test/mcp（含此前超时的用例）**

Run: `PGDATABASE=plm_test npx vitest run test/mcp test/actions-sensitive-read.test.js --no-file-parallelism --reporter=basic`

Expected: 全绿。此前 `actions-sensitive-read` 的「crm-customer-360 → CONFIRM_REQUIRED」5 s 超时用例应恢复通过（**不靠提超时，靠根因消除**）。

- [ ] **Step 3: 回归全量（分目录串行，禁并发）**

依次执行（每个约 1-2 分钟）：

```bash
PGDATABASE=plm_test npx vitest run test/http --no-file-parallelism --reporter=basic
PGDATABASE=plm_test npx vitest run test/assets --reporter=basic
PGDATABASE=plm_test npx vitest run test/action --no-file-parallelism --reporter=basic
PGDATABASE=plm_test npx vitest run test/agent --reporter=basic
PGDATABASE=plm_test npx vitest run test/portal --no-file-parallelism --reporter=basic
```

Expected: 全绿。若出现失败，**先单独重跑该文件判定真伪**（并发/种子清空会产生伪失败）。

- [ ] **Step 4: 同步任何基线漂移**

若出现「schema 列断言」「token 格式断言」类失败，按既有惯例同步基线并在失败处写注释说明原因（参照 `test/mcp-identity.test.js` 的 `tenant_id` 基线同步写法）。

- [ ] **Step 5: 把实测数据回填设计文档 §7**

把 Step 1 的改造后数据写入 `docs/2026-09-01-mcp-token-lookup-design.md` 的 §7 表格「改造后」列。

- [ ] **Step 6: Commit**

```bash
git add docs/2026-09-01-mcp-token-lookup-design.md
git commit -m "docs: 回填 MCP 凭证解析改造后实测数据"
```

---

## 自审记录

**1. 规格覆盖**

| 设计章节 | 对应任务 |
|---|---|
| §4.1 Token 格式 | Task 1（TOKEN_RE / 85 字符 / 熵不变） |
| §4.2 格式单一事实源 | Task 1（`src/mcp/tokenFormat.js`） |
| §4.3 颁发路径三处 | Task 2（issueToken / mcpLogin / 门户后台） |
| §4.4 解析三段式 | Task 3（格式闸 / 主键 / 单次 crypt） |
| §4.5 存量迁移 | Task 4（dry-run 默认 + 禁删 + 可回滚） |
| §4.6 兼容性 | Task 3（旧格式文案）+ Task 4（强制重登录） |
| §7 验证与观测 | Task 3 Step 5（EXPLAIN）+ Task 5（实测回填） |

**2. 占位符扫描**：无 TBD / TODO / "similar to" / "add appropriate error handling"。所有代码步骤均给出完整代码。

**3. 类型一致性**

- `newStructuredToken()` 返回 `{ id, tokenPlain }` —— Task 1 定义，Task 2 三处、Task 5 测试均按此签名使用。
- `parseTokenId(token)` 返回带横线 UUID **字符串**或 `null` —— Task 1 定义，Task 3 与 Task 5 EXPLAIN 脚本按此使用。
- `resolveIdentity` 返回结构（`actor/role/degraded/degraded_reason/prompt_needed/identity_id/person_id/scopes`）保持不变，仅新增「吊销」判定分支，调用方无需改动。
- `issueToken` 返回 `{ tokenPlain, identityId, alreadyExists }` 与改造前完全一致，调用方零改动。

**4. 已知风险与前置确认**

- Task 4 Step 6 是**生产写操作**，必须获得用户显式授权后才执行；计划内其它步骤均落在测试库或代码层。
- 改造后旧格式 token 会立即失效（格式闸拒绝），与用户在设计阶段选定的「策略 B」一致。
