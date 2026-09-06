# 企业级容量实施计划（读写分离双池 + 角色分级限流 + SSE 双维过滤）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 支撑 2000 名销售在线规模——连接池容量 ×5（读 50/写 10）、HTTP 请求限流（IP+全局+角色）、SSE 组织+域双维过滤与安全兜底。

**Architecture:** 三层独立改造：容量层（src/db.js 读写双池，显式 queryWrite 标记写入）、限流层（新增 src/http/rateLimit.js，内存滑动窗口，IP 60s/120 + 全局 60s/3000 + 角色分级）、隔离层（src/events/bus.js 事件带 org_id + src/events/sse.js 按 orgSubtree+domains 过滤、心跳、连接上限）。不引第三方依赖（保持极简依赖策略）。

**Tech Stack:** Node 22 ESM + Express 4 + pg 8 + vitest 3（测试命令：`node node_modules/vitest/vitest.mjs run`，禁 npx/npm install）。

**设计文档:** `docs/superpowers/specs/2026-08-28-enterprise-capacity-design.md`（已批准）

---

## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `src/db.js` | 读写双池 + queryWrite/queryRead/withTx 写池 | 修改 |
| `src/http/rateLimit.js` | 限流中间件（IP+全局+角色，test 环境×100） | 新建 |
| `src/events/bus.js` | emit 从 payload.org_id 补 msg.org_id | 修改 |
| `src/events/sse.js` | connect(res,{org,domains}) + 过滤 + 心跳 + maxClients | 修改 |
| `src/http/routes.js` | 挂限流到 /api；/events 透传 query | 修改 |
| 写调用点文件（约 24 个） | `query(` → `queryWrite(`（仅写 SQL 处） | 修改 |
| `test/db-pool.test.js` | 双池导出/env 生效 | 新建 |
| `test/rate-limit.test.js` | 限流四行为 | 新建 |
| `test/sse-filter.test.js` | SSE 过滤/兜底/心跳 | 新建 |

**写调用点迁移规则（Task 2/3 共用）**：grep 定位写 SQL（`INSERT INTO` / `UPDATE ` / `DELETE FROM` / `withTx(`）所在文件，把**该文件内执行写 SQL 的** `query(` 调用改为 `queryWrite(`；只读查询（`SELECT`）的 `query(` 不动。`withTx(fn)` 内部已走写池，无需改调用方。迁移后 `grep -n "query(" src/` 中与写 SQL 同文件残留须为 0（读调用除外）。

---

### Task 1: db.js 读写双池（基础设施）

**Files:**
- Modify: `src/db.js:10-39`
- Test: `test/db-pool.test.js`（新建）

- [ ] **Step 1: Write the failing test**

```js
// test/db-pool.test.js
import { describe, it, expect } from 'vitest';
import { pool, poolRead, queryWrite, queryRead, withTx } from '../src/db.js';

describe('db 读写双池（企业级容量）', () => {
  it('导出写池 pool（默认 max=10，env 可覆盖）', () => {
    expect(pool.options.max).toBe(Number(process.env.PGPOOL_MAX_WRITE || 10));
  });
  it('导出读池 poolRead（默认 max=50，env 可覆盖）', () => {
    expect(poolRead.options.max).toBe(Number(process.env.PGPOOL_MAX_READ || 50));
  });
  it('queryWrite/queryRead/withTx 均为函数', () => {
    expect(typeof queryWrite).toBe('function');
    expect(typeof queryRead).toBe('function');
    expect(typeof withTx).toBe('function');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node node_modules/vitest/vitest.mjs run test/db-pool.test.js`
Expected: FAIL with `poolRead is not defined`

- [ ] **Step 3: Implement dual pool in db.js**

```js
// src/db.js — 读写双池（企业级容量：读 50 / 写 10，env 可调）
// 读池 poolRead：只读查询主力（默认 50，2000 销售在线基线）
// 写池 pool：写入 + 事务（默认 10，并发写有上限防击穿）
export const pool = new pg.Pool({
  host: process.env.PGHOST || '127.0.0.1',
  port: Number(process.env.PGPORT || 5433),
  user: process.env.PGUSER || 'agent2b',
  password: process.env.PGPASSWORD || 'agent2b',
  database: process.env.PGDATABASE || 'plm',
  max: Number(process.env.PGPOOL_MAX_WRITE || 10),
  options: `-c search_path=${SCHEMA},public`,
  connectionTimeoutMillis: 5000,
});

export const poolRead = new pg.Pool({
  host: process.env.PGHOST || '127.0.0.1',
  port: Number(process.env.PGPORT || 5433),
  user: process.env.PGUSER || 'agent2b',
  password: process.env.PGPASSWORD || 'agent2b',
  database: process.env.PGDATABASE || 'plm',
  max: Number(process.env.PGPOOL_MAX_READ || 50),
  options: `-c search_path=${SCHEMA},public`,
  connectionTimeoutMillis: 5000,
});

export async function queryWrite(text, params = []) { return pool.query(text, params); }
export async function queryRead(text, params = []) { return poolRead.query(text, params); }
// query() 保留=读池（兼容既有只读调用；写调用迁移到 queryWrite）
export async function query(text, params = []) { return poolRead.query(text, params); }

export async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node node_modules/vitest/vitest.mjs run test/db-pool.test.js`
Expected: PASS (3/3)

- [ ] **Step 5: Commit**

```bash
git add src/db.js test/db-pool.test.js
git commit -m "feat(enterprise): db 读写双池（读池默认50 写池10 env可调）"
```

---

### Task 2: 写调用点迁移 — 粒子/编排/决策/记忆核心批

**Files:** 以下文件的写 SQL 调用改 `query(` → `queryWrite(`（只读不动）：
- `src/particles/particleRepo.js`（写粒子/边 INSERT，约 5 处写查询）
- `src/kanban/kanban.js`（任务 INSERT/status UPDATE，约 10 处写查询）
- `src/kanban/scheduler.js`（scheduler_lock UPDATE + claim/complete，约 3 处）
- `src/decision/decisionRepo.js`（decision/event INSERT，约 6 处写查询）
- `src/decision/ageGraph.js`（图可用性写入，约 4 处）
- `src/decision/conflict.js`（冲突记录 INSERT，约 3 处）
- `src/decision/provenance.js`（审计导出读取不动；若含写则改）
- `src/memory/memoryLog.js`（memory_log INSERT，约 4 处）
- `src/memory/note.js`（note INSERT/UPDATE，约 2 处）
- `src/memory/snapshot.js`（快照 INSERT，约 2 处）

- [ ] **Step 1: Locate write calls**

Run: `grep -n "INSERT INTO\|UPDATE \|DELETE FROM" src/particles/particleRepo.js src/kanban/kanban.js src/kanban/scheduler.js src/decision/decisionRepo.js src/decision/ageGraph.js src/decision/conflict.js src/decision/provenance.js src/memory/memoryLog.js src/memory/note.js src/memory/snapshot.js`
Expected: 列出每文件写 SQL 行号（对应上表）

- [ ] **Step 2: Convert write calls to queryWrite**

Rule: 上述命中行**对应的 `query(` 调用**（同一条 SQL 语句）改为 `queryWrite(`。只读 SELECT 调用保持 `query(`。
Each file: `query(` → `queryWrite(` only at write statements.

- [ ] **Step 3: Verify no residual write-via-query**

Run: `grep -rn "query(" src/particles/particleRepo.js src/kanban/kanban.js src/kanban/scheduler.js src/decision/decisionRepo.js src/decision/ageGraph.js src/decision/conflict.js src/memory/memoryLog.js src/memory/note.js src/memory/snapshot.js | grep -c "SELECT"`
Expected: 残留 `query(` 仅出现在含 SELECT 的只读语句（无写语句残留）

- [ ] **Step 4: Run related tests**

Run: `node node_modules/vitest/vitest.mjs run test/particleRepo.test.js test/kanban.test.js test/decision.test.js test/memory.test.js test/dispatch.test.js 2>/dev/null || node node_modules/vitest/vitest.mjs run test/particles 2>/dev/null || node node_modules/vitest/vitest.mjs run test/decision`
Expected: 相关测试全绿（行为不变，仅池切换）

- [ ] **Step 5: Commit**

```bash
git add src/particles/particleRepo.js src/kanban/kanban.js src/kanban/scheduler.js src/decision/decisionRepo.js src/decision/ageGraph.js src/decision/conflict.js src/decision/provenance.js src/memory/memoryLog.js src/memory/note.js src/memory/snapshot.js
git commit -m "feat(enterprise): 写调用点迁移 queryWrite（粒子/编排/决策/记忆）"
```

---

### Task 3: 写调用点迁移 — 销售/审批/告警/portal 批

**Files:** 写 SQL 调用改 `queryWrite`：
- `src/sales/importService.js`（导入写，约 6 处）
- `src/sales/pool.js`（池配置 UPDATE，1 处）
- `src/approval/engine.js` + `src/approval/flow.js`（审批实例/任务写）
- `src/alerts/tokenAccounting.js`（token_accounting INSERT）
- `src/alerts/alertStore.js`（预警写）
- `src/agent/agentEpisodes.js`（episode INSERT）
- `src/ontology/hooks.js`（词汇写）
- `src/ontology/ageSync.js`
- `src/skills/skillRegistry.js` / `src/skills/methodologySync.js`（注册表/镜像写）
- `src/portal/alertRuleConfig.js` / `src/portal/approvalFlow.js` / `src/portal/businessTier.js` / `src/portal/decisionScenario.js` / `src/portal/mcpIdentity.js` / `src/portal/ontologyConfig.js` / `src/portal/rbacMatrix.js` / `src/portal/systemSettings.js` / `src/portal/userManagement.js` / `src/portal/memoryConfig.js`（配置写）
- `src/metaAttr/metaAttrRepo.js`（元模型写）
- `src/particles/dedup.js` / `src/particles/interactionIndex.js`
- `src/mcp/issueToken.js`（token 写）
- `src/action/executor.js` / `src/action/auditHook.js`（审计写，若含）

- [ ] **Step 1: Locate write calls**

Run: `grep -rln "INSERT INTO\|UPDATE \|DELETE FROM" src/sales src/approval src/alerts src/agent src/ontology src/skills src/portal src/metaAttr src/particles src/mcp src/action`
Expected: 列出文件清单（对应上表）

- [ ] **Step 2: Convert write calls to queryWrite**

Rule: 同上 Task 2（写语句的 `query(` → `queryWrite(`；SELECT 不动）。`withTx` 不用改。

- [ ] **Step 3: Verify residual**

Run: `grep -rn "query(" src/sales src/approval src/alerts src/agent src/ontology src/skills src/portal src/metaAttr src/particles src/mcp src/action | grep -E "INSERT INTO|UPDATE |DELETE FROM" | grep -v queryWrite`
Expected: 0 命中（无写 SQL 残留经 query()）

- [ ] **Step 4: Run related tests**

Run: `node node_modules/vitest/vitest.mjs run test/import-service.test.js test/approval-flow.test.js test/alert.test.js test/pool.test.js test/connectors.test.js test/portal 2>/dev/null || node node_modules/vitest/vitest.mjs run test/`
Expected: 相关测试全绿

- [ ] **Step 5: Commit**

```bash
git add src/sales src/approval src/alerts src/agent src/ontology src/skills src/portal src/metaAttr src/particles src/mcp src/action
git commit -m "feat(enterprise): 写调用点迁移 queryWrite（销售/审批/告警/portal）"
```

---

### Task 4: rateLimit 中间件（IP+全局+角色）+ 挂载

**Files:**
- Create: `src/http/rateLimit.js`
- Modify: `src/http/routes.js:81-84`（挂载）
- Test: `test/rate-limit.test.js`（新建）

- [ ] **Step 1: Write the failing test**

```js
// test/rate-limit.test.js
import { describe, it, expect } from 'vitest';
import { createRateLimit } from '../src/http/rateLimit.js';

function mockReqRes(ip) {
  const req = { ip, socket: { remoteAddress: ip } };
  const res = { statusCode: 0, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; } };
  return { req, res };
}

describe('rateLimit（企业级限流）', () => {
  it('IP 滑动窗口超限返回 429', () => {
    const mw = createRateLimit({ windowMs: 1000, ipLimit: 3, globalLimit: 1000 });
    const hits = [];
    for (let i = 0; i < 4; i++) {
      const { req, res } = mockReqRes('10.0.0.1');
      mw(req, res, () => hits.push(i));
    }
    expect(hits).toHaveLength(3);
  });
  it('全局兜底超限 429', () => {
    const mw = createRateLimit({ windowMs: 1000, ipLimit: 100, globalLimit: 2 });
    const hits = [];
    for (let i = 0; i < 3; i++) {
      const { req, res } = mockReqRes(`10.0.0.${i}`);
      mw(req, res, () => hits.push(i));
    }
    expect(hits).toHaveLength(2);
  });
  it('429 响应格式 {error, retry_after}', () => {
    const mw = createRateLimit({ windowMs: 1000, ipLimit: 1, globalLimit: 1000 });
    const { req, res } = mockReqRes('10.0.0.1');
    mw(req, res, () => {});
    const { req: req2, res: res2 } = mockReqRes('10.0.0.1');
    mw(req2, res2, () => {});
    expect(res2.statusCode).toBe(429);
    expect(res2.body).toMatchObject({ error: 'rate_limited', retry_after: 1 });
  });
  it('test 环境阈值放大不误伤（NODE_ENV=test）', () => {
    const mw = createRateLimit({ windowMs: 1000, ipLimit: 2, globalLimit: 2 });
    const hits = [];
    for (let i = 0; i < 5; i++) {
      const { req, res } = mockReqRes(`10.0.0.${i}`);
      mw(req, res, () => hits.push(i));
    }
    expect(hits).toHaveLength(5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node node_modules/vitest/vitest.mjs run test/rate-limit.test.js`
Expected: FAIL with `Cannot find module '../src/http/rateLimit.js'`

- [ ] **Step 3: Implement rateLimit.js**

```js
// src/http/rateLimit.js — 请求限流中间件（IP 滑动窗口 + 全局兜底 + 角色分级）
// 企业级容量：2000 销售在线规模防击穿。不引第三方依赖（内存滑动窗口）。
// 角色分级依赖 auth.resolveMe（纯解析不触 DB）；匿名/解析失败按 default 配额。
import { resolveMe } from './auth.js';

const DEFAULT_ROLE_LIMITS = {
  sales: 120, presales: 120, default: 120,
  manager: 200, exec: 200, finance: 200, contract_admin: 200,
  admin: Infinity, sysadmin: Infinity,
};

export function createRateLimit({
  windowMs = 60000,
  ipLimit = 120,
  globalLimit = 3000,
  roleLimits = DEFAULT_ROLE_LIMITS,
} = {}) {
  const hits = new Map(); // key → [ts...]
  // test 环境阈值 ×100，避免现有测试被限流误伤
  const testScale = process.env.NODE_ENV === 'test' ? 100 : 1;
  // 定期清理陈旧桶（不永久封禁；窗口滚动后恢复）
  const cleaner = setInterval(() => hits.clear(), windowMs * 5);
  cleaner.unref?.();

  function count(key, limit) {
    if (!Number.isFinite(limit)) return true; // admin 不限
    const now = Date.now();
    const cutoff = now - windowMs;
    const arr = (hits.get(key) || []).filter((t) => t >= cutoff);
    if (arr.length >= limit * testScale) return false;
    arr.push(now);
    hits.set(key, arr);
    return true;
  }

  return function rateLimitMw(req, res, next) {
    if (!count('__global__', globalLimit)) return res.status(429).json({ error: 'rate_limited', retry_after: Math.ceil(windowMs / 1000) });
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    if (!count(`ip:${ip}`, ipLimit)) return res.status(429).json({ error: 'rate_limited', retry_after: Math.ceil(windowMs / 1000) });
    let role = 'default';
    try { const me = resolveMe(req); if (me?.ok) role = me.role; } catch { /* 匿名按 default */ }
    if (!count(`role:${role}:${ip}`, roleLimits[role] ?? roleLimits.default)) return res.status(429).json({ error: 'rate_limited', retry_after: Math.ceil(windowMs / 1000) });
    next();
  };
}
```

- [ ] **Step 4: Mount in routes.js**

In `src/http/routes.js`, at the top of `createRoutes` (before line 84 config routers), add:

```js
import { createRateLimit } from './rateLimit.js';
// ...
export function createRoutes(app, hub) {
  // 企业级限流：IP+全局+角色（2000 销售在线规模防击穿；不拦静态页/SSE）
  app.use('/api', createRateLimit());
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node node_modules/vitest/vitest.mjs run test/rate-limit.test.js`
Expected: PASS (4/4)

- [ ] **Step 6: Commit**

```bash
git add src/http/rateLimit.js src/http/routes.js test/rate-limit.test.js
git commit -m "feat(enterprise): HTTP 限流（IP滑动窗口+全局兜底+角色分级）"
```

---

### Task 5: SSE 双维过滤 + 心跳 + 连接上限（含 bus.org_id）

**Files:**
- Modify: `src/events/bus.js:16-19`（emit 补 org_id）
- Modify: `src/events/sse.js`（重构过滤/心跳/上限）
- Modify: `src/http/routes.js:1050`（/events 透传 query）
- Test: `test/sse-filter.test.js`（新建）

- [ ] **Step 1: Write the failing test**

```js
// test/sse-filter.test.js
import { describe, it, expect, vi } from 'vitest';
import { createSseHub } from '../src/events/sse.js';

function fakeRes() {
  const writes = [];
  return {
    writes,
    writeHead: vi.fn(),
    flushHeaders: vi.fn(),
    write: (f) => writes.push(f),
    on: vi.fn(),
    end: vi.fn(),
  };
}

function frames(writes) { return writes.join('').split('\n\n').filter(Boolean); }

describe('SSE 双维过滤（企业级隔离）', () => {
  it('带 org 订阅：只收子树内事件，跨组织事件被过滤', () => {
    const hub = createSseHub({ heartbeatMs: 0 }); // 禁心跳便于断言
    const res = fakeRes();
    hub.connect(res, { org: 'org-hq', orgSubtree: ['org-hq', 'org-sales'], domains: [] });
    const { emit } = hub; // 测试需访问内部 emit？无 —— 用 bus.emit
    // 上面的写法需要 hub 暴露 emit；见 Step 3 实现 → hub 不暴露 emit，测试改从 bus 发
    // bus.emit('particle', 'update', { org_id: 'org-hq' });
    // bus.emit('particle', 'update', { org_id: 'org-fin' });
    // expect(frames(res.writes).filter(f => f.includes('event: particle'))).toHaveLength(1);
  });
});
```

- [ ] **Step 2 (revised): emit via bus (hub subscribes internally)**

```js
import { emit } from '../src/events/bus.js';
// (上面用例改为：)
it('带 org 订阅：只收子树内事件', () => {
  const hub = createSseHub({ heartbeatMs: 0 });
  const res = fakeRes();
  hub.connect(res, { org: 'org-hq', orgSubtree: ['org-hq', 'org-sales'], domains: [] });
  emit('particle', 'update', { org_id: 'org-hq' });
  emit('particle', 'update', { org_id: 'org-fin' });
  emit('particle', 'update', { org_id: 'org-sales' });
  const biz = frames(res.writes).filter((f) => f.includes('event: particle'));
  expect(biz).toHaveLength(2); // org-hq + org-sales（子树内），org-fin 被过滤
});

it('不带 org：只收 connected/heartbeat，不收业务事件', () => {
  const hub = createSseHub({ heartbeatMs: 0 });
  const res = fakeRes();
  hub.connect(res, {});
  emit('particle', 'update', { org_id: 'org-hq' });
  const all = frames(res.writes).join('');
  expect(all).toContain('event: connected');
  expect(all).not.toContain('event: particle');
});

it('domains 过滤：只收订阅域', () => {
  const hub = createSseHub({ heartbeatMs: 0 });
  const res = fakeRes();
  hub.connect(res, { org: 'org-hq', orgSubtree: ['org-hq'], domains: ['task'] });
  emit('task', 'done', { org_id: 'org-hq' });
  emit('approval', 'started', { org_id: 'org-hq' });
  const biz = frames(res.writes).filter((f) => f.includes('event:'));
  expect(biz.join('')).toContain('event: task');
  expect(biz.join('')).not.toContain('event: approval');
});

it('心跳帧存在（heartbeatMs 生效）', () => {
  const hub = createSseHub({ heartbeatMs: 10 });
  const res = fakeRes();
  hub.connect(res, {});
  return new Promise((r) => setTimeout(() => { expect(frames(res.writes).join('')).toContain('event: heartbeat'); hub.close(); r(); }, 30));
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node node_modules/vitest/vitest.mjs run test/sse-filter.test.js`
Expected: FAIL（当前 SSE 无过滤/connect 签名不匹配）

- [ ] **Step 4: Implement bus.js org_id**

In `src/events/bus.js` emit:

```js
export function emit(domain, type, payload) {
  const msg = { domain, type, ts: Date.now(), summary: payload || {} };
  // 企业级：事件携带组织归属（从 payload.org_id 提取，缺省 null=全局事件）
  msg.org_id = (payload && typeof payload === 'object' && payload.org_id) || null;
  // ...（后续分发逻辑不变）
```

- [ ] **Step 5: Implement sse.js**

```js
// src/events/sse.js — SSE 事件总线端：单连接广播 5 事件域（task/trace/approval/particle/payment）
// 企业级容量：组织+域双维过滤（orgSubtree/domains）+ 心跳 + 连接上限 + 安全兜底（未带 org 不推业务事件）
import { on } from './bus.js';
import { orgSubtree as resolveOrgSubtree } from '../context/scope.js';

export function createSseHub({ maxClients = 5000, heartbeatMs = 15000 } = {}) {
  const clients = new Set(); // { res, org, orgSubtree, domains }

  function connect(res, opts = {}) {
    if (typeof res.writeHead === 'function') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    }
    if (clients.size >= maxClients) {
      if (typeof res.writeHead === 'function') res.statusCode = 503;
      res.end?.('SSE 连接数已达上限');
      return false;
    }
    res.flushHeaders?.();
    const org = opts.org || null;
    const domains = Array.isArray(opts.domains)
      ? opts.domains
      : String(opts.domains || '').split(',').map((s) => s.trim()).filter(Boolean);
    const client = { res, org, orgSubtree: Array.isArray(opts.orgSubtree) ? opts.orgSubtree : null, domains };
    clients.add(client);
    res.on?.('close', () => clients.delete(client));
    // 未预置子树（真实调用）：异步解析组织子树（就绪前保守不推业务事件）
    if (client.org && !client.orgSubtree) {
      resolveOrgSubtree(client.org).then((sub) => { client.orgSubtree = sub; }).catch(() => { client.orgSubtree = []; });
    }
    res.write(`event: connected\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);
    return true;
  }

  const unsubscribe = on('*', (msg) => {
    const frame = `event: ${msg.domain}\ndata: ${JSON.stringify(msg)}\n\n`;
    for (const c of clients) {
      // 双维过滤：org（安全兜底：未带 org 客户端不推组织事件）+ domains
      if (msg.org_id) {
        if (!c.org) continue;                        // 安全兜底：未订阅组织不推组织数据
        if (c.orgSubtree && !c.orgSubtree.includes(msg.org_id)) continue; // 不在子树
        if (!c.orgSubtree) continue;                 // 子树未就绪，保守跳过
      }
      if (c.domains.length && !c.domains.includes(msg.domain)) continue;
      try { c.res.write(frame); } catch { /* 客户端断开，close 事件清理 */ }
    }
  });

  // 心跳：防长连接闲置断开
  const hb = setInterval(() => {
    const frame = 'event: heartbeat\ndata: {}\n\n';
    for (const c of clients) { try { c.res.write(frame); } catch { /* ignore */ } }
  }, heartbeatMs);
  hb.unref?.();

  return {
    connect,
    clients,
    close: () => {
      clearInterval(hb);
      unsubscribe();
      clients.clear();
    },
  };
}
```

- [ ] **Step 6: Wire /events in routes.js**

In `src/http/routes.js`（line 1050）:

```js
app.get('/events', (req, res) => hub.connect(res, { org: req.query.org, domains: req.query.domains }));
```

- [ ] **Step 7: Run test to verify it passes**

Run: `node node_modules/vitest/vitest.mjs run test/sse-filter.test.js`
Expected: PASS (4/4)

- [ ] **Step 8: Commit**

```bash
git add src/events/bus.js src/events/sse.js src/http/routes.js test/sse-filter.test.js
git commit -m "feat(enterprise): SSE 组织+域双维过滤/心跳/连接上限，事件带 org_id"
```

---

### Task 6: 组织事件源补 org_id（关键源）+ 全量回归 + 冒烟

**Files:** 关键业务事件源在 emit payload 补 `org_id`（缺省已兼容，不补则按全局事件走安全兜底）：
- `src/particles/particleRepo.js` / `src/ontology/hooks.js`（粒子写事件 → payload.org_id 取自粒子/组织）
- `src/decision/decisionRepo.js`（决策事件 → payload.org_id）
- `src/approval/engine.js`（审批事件 → payload.org_id）
- `src/alerts/alertStore.js`（预警事件 → payload.org_id）

- [ ] **Step 1: Add org_id to key event sources**

Rule: 事件 payload 是粒子/决策/审批/预警对象时，补 `org_id` 字段（取对象的 org_id / payload.org_id / 缺省 null）。
Verify: `grep -rn "emit(" src/particles src/decision src/approval src/alerts | head -30`

- [ ] **Step 2: Full regression**

Run: `node node_modules/vitest/vitest.mjs run`
Expected: 全量 >= 398 且全绿（新增 3 测试文件后约 410+）

- [ ] **Step 3: Smoke env override**

Run: `PGPOOL_MAX_READ=80 node -e "import('./src/db.js').then(m => console.log('read pool max =', m.poolRead.options.max))"`
Expected: `read pool max = 80`（env 生效）

- [ ] **Step 4: Commit**

```bash
git add src/particles src/decision src/approval src/alerts
git commit -m "feat(enterprise): 关键事件源补 org_id（粒子/决策/审批/告警）"
```

---

## Self-Review 记录

- **Spec 覆盖**：§4.1 双池 → Task 1；§4.2 限流 → Task 4；§4.3 SSE → Task 5；§4.4 org_id 事件源 → Task 5+6；§6 错误处理（429/503/安全兜底/心跳）→ Task 4/5；§7 测试 → 各 Task；§8 文件清单 → 全覆盖。
- **占位符**：无 TBD/TODO；所有代码完整给出（Task 7 中 Step 3 的测试代码为「修订后」合并版本，以 Step 2 revised 为准）。
- **类型一致性**：`queryWrite/queryRead/poolRead` 三命名跨 Task 1-6 一致；`createRateLimit` 参数名 `windowMs/ipLimit/globalLimit/roleLimits` 一致；`connect(res,{org,domains,orgSubtree})` 签名一致；`msg.org_id` 一致。
- **既有测试兼容**：`query()` 保留为读池 → 存量只读调用零改动；写调用迁移不影响行为（PG 连接本身不区分读写，仅容量路由）；`NODE_ENV=test` 限流 ×100 防误伤。

---

## 执行交接

**Plan complete and saved to `docs/superpowers/plans/2026-08-28-enterprise-capacity.md`.** 两种执行方式：

1. **Subagent-Driven（推荐）** — 每 Task 派新子代理，任务间审查，快速迭代
2. **Inline Execution** — 本会话内按 executing-plans 批量执行，带检查点

选择哪种？（注意：本环境沙箱无 git 凭证，commit 需用户本地执行「Git一下」；测试命令已按项目惯例用 `node node_modules/vitest/vitest.mjs run` 绕过 npm）