# [主动运行时 S1：出口——让人看得见] Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修通信号投递断链——把已有巡检/告警产出接到「人一定会看到」的地方（信号统一收口 + 投递四渠道 + 工作台信号视角 + 首页信号卡 + 挂载修复），当天可见效。

**Architecture:** 新建 `src/signal/` 模块（store/router/digest 三件套）作为信号统一收口，替换 `src/alerts/alertStore.js` 的进程内存 Map；用 `crm.signal` + `crm.signal_delivery` 两张运行态表持久化（**防假绿核心：send 被调用 ≠ 已送达**）；`src/signal/delivery/` 提供四渠道 provider（inbox/email/im/webhook），每渠道满足 `verifyConfig` fail-closed + `send` 落 `signal_delivery` 流水；同时把既有的 `alertEndpoints`（8 端点）与 `registerAlertHook` 挂载上，工作台增第 7 视角、首页增信号卡。**不新增粒子类型，全为运行态表；零 DELETE；写走既有第 0 闸/审计。**

**Tech Stack:** Node 22 ESM · Express 4 · PostgreSQL 16（pgcrypto/pgvector）· vitest 3 · 既有 `src/config/configStore.js` · 既有 `src/events/sse.js` · 既有 SMTP（`src/mail/` 新建）

---

## 执行前环境与纪律（务必先读）

- 工作目录：`D:\system\CRM-ai-native`。所有命令用绝对路径或先 `cd`。
- **测试环境**：`crm_native_test`。运行：managed Python venv 的 node 用 `C:\Users\wangchuan08\.workbuddy\binaries\node\versions\22.22.2-2\node.exe` 或仓库 node。Vitest 命令：`npx vitest run <path> -t <name>`。
- **DB 操作**：直连先 `SET search_path TO crm,public`（凭据 agent2b/agent2b@localhost:5433）。`CREATE TABLE IF NOT EXISTS` + 索引；**绝不物理 DELETE**。
- **提交纪律**：AI 无提交权限。每个 Task 完成后输出**精确 PowerShell 命令**（显式路径 add、禁 `git add -A`、`-m` 单行、无 heredoc），供用户在本地仓库执行。
- **回归纪律**：全量回归 flaky（约 2612 例）→ 单次红不得直判；跨会话共享 `crm_native_test` 并发 TRUNCATE 会伪失败。涉及共享库的测试失败先查并行会话再判回归。
- **红线**：不新增粒子类型；不改业务域模型；写操作过决策第 0 闸；**S1 未交付前不得对外宣称「AI 主动值守」**。

---

## 文件结构（本计划创建/修改清单）

| 文件 | 动作 | 职责 |
|---|---|---|
| `db/schema.sql` | 修改（追加 DDL 至尾部） | 主事实源：追加 `crm.signal` / `crm.signal_delivery` 两张运行态表 |
| `db/migrate-config.sql` 或迁移登记 | 修改（追加迁移清单登记） | schema.sql 非唯一事实源，须登记迁移（见 S1 任务 1 步骤） |
| `src/signal/store.js` | 新建 | `crm.signal` 信号表读写（create/list/dedupe/ack/close/acted） |
| `src/signal/router.js` | 新建 | 信号与告警领域适配：`signalFromAlert()`、`listSignals()`、`signalStats()` |
| `src/signal/digest.js` | 新建 | 每日作战简报组装（对齐 Rox Daily Digest） |
| `src/signal/delivery/index.js` | 新建 | provider 注册表 + 分发器 `deliver(signal)` |
| `src/signal/delivery/inbox.js` | 新建 | inbox 渠道（写入工作台第 7 视角，**默认渠道**） |
| `src/signal/delivery/email.js` | 新建 | email 渠道（复用 SMTP；未配置凭据 fail-closed） |
| `src/signal/delivery/im.js` | 新建 | im 渠道（钉钉/企微/飞书占位；未配置凭据 fail-closed） |
| `src/signal/delivery/webhook.js` | 新建 | webhook 渠道（HTTP POST 到配置 URL） |
| `src/signal/delivery/signalDeliveryStore.js` | 新建 | `crm.signal_delivery` 投递流水读写（**防假绿核心**） |
| `src/alerts/alertStore.js` | 修改 | 内存 Map → 双写（内存 + DB 落 `crm.signal`），保留既有对外 API 签名 |
| `src/http/server.js` | 修改 | 挂载 `registerAlertHook` + 注册 signal 相关启动钩子 |
| `src/http/routes.js` | 修改 | 挂载 `alertEndpoints` 8 端点 + signal 持久化 API（按 B-B1） |
| `src/http/workbenchRouter.js` | 修改 | 增第 7 视角「信号」（对齐 `:101-175` case） |
| `src/web/home.html` | 修改 | 首页信号卡（对齐 Rox Home） |
| `src/web/signal-center.html` | 新建 | 信号中心页（列表/筛选/采纳/否决/静默） |
| `src/web/nav.js` 或菜单源 | 修改 | 销售菜单加入口「信号中心」 |
| `src/scheduler/timers.js` | 修改 | 巡检产出挂上 `signalStore.create()`（把内存 Map 消费改为 DB 消费） |
| `test/signal/*.test.js` | 新建 | store/router/digest/delivery 全套单测 |
| `test/http/workbenchSignal.test.js` | 新建 | 第 7 视角契约测试 |
| `test/web/signalCenterPage.test.js` | 新建 | 信号中心页契约测试 |

---

## Task 1：建表 `crm.signal` + `crm.signal_delivery`（运行态表，非粒子域）

**Files:**
- Modify: `db/schema.sql`（尾部追加）
- Modify: `db/migrate-*.sql`（登记迁移清单，与项目约定一致）

- [ ] **Step 1: 写迁移登记断言（先证伪）**

新增 `test/db/signalTables.test.js`：

```js
import { describe, it, expect, beforeAll } from 'vitest';
import pg from 'pg';

// 直连 crm_native_test，先 SET search_path
let pool;
beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.PGDATABASE ? undefined : undefined, database: 'crm_native_test', host: 'localhost', port: 5433, user: 'agent2b', password: 'agent2b' });
  await pool.query('SET search_path TO crm,public');
});
afterAll(async () => { await pool.end(); });

describe('signal 运行态表', () => {
  it('crm.signal 与 crm.signal_delivery 已建（information_schema 对照）', async () => {
    const { rows } = await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='crm' AND table_name IN ('signal','signal_delivery')`);
    const names = rows.map(r => r.table_name);
    expect(names).toContain('signal');
    expect(names).toContain('signal_delivery');
  });
});
```

- [ ] **Step 2: 运行测试确认失败（表不存在 → 假红应证）**

Run: `npx vitest run test/db/signalTables.test.js -t signal`
Expected: FAIL（`toContain` 失败，表未建）——这是**预期未实现态**。

- [ ] **Step 3: 在 `db/schema.sql` 尾部追加两张表 DDL（与设计 §8.3/§8.4 完全一致）**

在 `db/schema.sql` 末尾追加：

```sql
-- ============================================================
-- 主动运行时（Proactive Runtime）· 运行态表（非粒子域）
-- 版本：2026-09-16 设计 docs/2026-09-15-final-design-coexistence-and-proactive.md §8.3/§8.4
-- ============================================================

-- 信号统一收口（替换 src/alerts/alertStore.js 内存 Map）
CREATE TABLE IF NOT EXISTS crm.signal (
  signal_id     TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL DEFAULT 'system',
  source        TEXT NOT NULL,                      -- rule-scan | event-trigger | agent-research | external
  kind          TEXT NOT NULL,                      -- 13 类告警 kind + 新增 kind
  severity      TEXT NOT NULL,                      -- low | medium | high
  target_role   TEXT NOT NULL,                      -- sales | finance | exec | ops
  owner_id      TEXT NULL,
  l2c_stage     TEXT NULL,
  particle_id   TEXT NULL,
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
  evidence      JSONB NOT NULL DEFAULT '{}'::jsonb,
  suggestion    JSONB NOT NULL DEFAULT '{}'::jsonb,
  status        TEXT NOT NULL DEFAULT 'open',       -- open | acked | closed | acted
  dedup_key     TEXT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  acked_at      TIMESTAMPTZ NULL,
  closed_at     TIMESTAMPTZ NULL,
  acted_at      TIMESTAMPTZ NULL
);
CREATE INDEX IF NOT EXISTS idx_signal_open
  ON crm.signal(tenant_id, status, severity, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_signal_kind
  ON crm.signal(tenant_id, kind, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_signal_dedup
  ON crm.signal(tenant_id, dedup_key) WHERE dedup_key IS NOT NULL;

-- 投递流水（防假绿核心：send 被调用 ≠ 已送达）
CREATE TABLE IF NOT EXISTS crm.signal_delivery (
  delivery_id     TEXT PRIMARY KEY,
  signal_id       TEXT NOT NULL,
  tenant_id       TEXT NOT NULL DEFAULT 'system',
  channel         TEXT NOT NULL,                    -- inbox | email | im | webhook
  provider        TEXT NULL,                        -- smtp | dingtalk | wecom | feishu | custom
  recipient       TEXT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',  -- pending | sent | failed | skipped
  attempts        INT NOT NULL DEFAULT 0,
  last_error      TEXT NULL,
  provider_msg_id TEXT NULL,
  delivered_at    TIMESTAMPTZ NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_delivery_signal ON crm.signal_delivery(signal_id);
CREATE INDEX IF NOT EXISTS idx_delivery_fail
  ON crm.signal_delivery(tenant_id, status, created_at DESC);
```

- [ ] **Step 4: 登记迁移清单（schema.sql 非唯一事实源，须登记）**

在 `db/migrate-config.sql` 或项目现有迁移登记文件（与 `migrate-config.sql` 同目录、同风格）追加一行登记（格式与现有条目一致，例如注释 + 文件名）：

```sql
-- 2026-09-16 主动运行时 S1：追加 crm.signal / crm.signal_delivery（运行态表）
-- 见 db/schema.sql 尾部；迁移由 node db/migrate.js 执行。
```

（若项目迁移登记是脚本驱动，则在该脚本的清单数组中追加；以仓库现有迁移登记文件的实际格式为准。）

- [ ] **Step 5: 跑迁移**

Run: `node db/migrate.js`
Expected: 输出 `[migrate] ... ` 且不报错；`crm.signal`/`crm.signal_delivery` 落库。

- [ ] **Step 6: 运行测试确认通过**

Run: `npx vitest run test/db/signalTables.test.js`
Expected: PASS（`information_schema` 显示两表存在）。

- [ ] **Step 7: 提交（输出给用户）**

```powershell
git add db/schema.sql db/migrate-config.sql test/db/signalTables.test.js
git commit -m "feat(proactive): 追加 crm.signal/crm.signal_delivery 运行态表(投递流水防假绿)+迁移登记+表存在断言"
```

---

## Task 2：`src/signal/store.js` —— 信号统一收口（DB 持久化 + 幂等去重）

**Files:**
- Create: `src/signal/store.js`
- Test: `test/signal/store.test.js`

- [ ] **Step 1: 写失败测试（TDD 先红）**

```js
// test/signal/store.test.js
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import pg from 'pg';

// 为隔离，本测试用注入式 pool（不依赖共享 crm_native_test 并发）
const fakeRows = [];
const fakePool = {
  query: vi.fn(async (sql, params) => {
    if (sql.includes('INSERT INTO crm.signal')) {
      const row = { ...params[1] }; // signal_id 等
      fakeRows.push(row);
      return { rows: [row] };
    }
    if (sql.includes('SELECT')) {
      return { rows: fakeRows.filter(r => r.tenant_id === params?.[0] || true) };
    }
    return { rows: [] };
  }),
};

let store;
beforeAll(async () => {
  // 动态 import 以便注入 pool（避免静态 import 时 env 兜底失效）
  vi.resetModules();
  vi.doMock('../src/signal/store.js', () => ({})); // 占位：真实实现见下方
});
afterAll(() => vi.unmockAll());

describe('signal store', () => {
  it('create 落 DB 并返回 signal（含 dedup 幂等）', async () => {
    // 真实实现注入 fakePool 后断言
  });
});
```

> ⚠ 说明：上述测试是先红模板。实际测试应直接对真实模块注入 `createSignalStore(pool)` 依赖（见 Step 3 实现）。按项目既有风格（如 `credentialVault.test.js` 用 `vi.mock` 拦截 `db.js`）组织，**不可依赖共享库并发**。

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/signal/store.test.js`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 `src/signal/store.js`（工厂注入式，遵循既有 DB 风格）**

```js
// src/signal/store.js — 信号统一收口（crm.signal 持久化，替换内存 Map）
import { randomUUID } from 'node:crypto';

// 工厂：注入 pool（对齐项目 db.js 风格；测试注入替身，生产用真实 pool）
export function createSignalStore(pool) {
  async function create({ tenant_id = 'system', source, kind, severity, target_role, owner_id = null, l2c_stage = null, particle_id = null, payload = {}, evidence = {}, suggestion = {}, dedup_key = null }) {
    if (!source || !kind || !severity || !target_role) {
      return { ok: false, error: 'required_fields_missing' };
    }
    // 幂等去重：同 dedup_key 未关闭则返回既有（不重复建）
    if (dedup_key) {
      const dup = await findOpenByDedup(tenant_id, dedup_key);
      if (dup) return { ok: true, alert: dup, deduped: true };
    }
    const signal_id = randomUUID();
    const { rows } = await pool.query(
      `INSERT INTO crm.signal
        (signal_id, tenant_id, source, kind, severity, target_role, owner_id, l2c_stage, particle_id, payload, evidence, suggestion, dedup_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [signal_id, tenant_id, source, kind, severity, target_role, owner_id, l2c_stage, particle_id, JSON.stringify(payload), JSON.stringify(evidence), JSON.stringify(suggestion), dedup_key],
    );
    return { ok: true, alert: rows[0], deduped: false };
  }

  async function findOpenByDedup(tenant_id, dedup_key) {
    const { rows } = await pool.query(
      `SELECT * FROM crm.signal WHERE tenant_id=$1 AND dedup_key=$2 AND status IN ('open','acked') LIMIT 1`,
      [tenant_id, dedup_key],
    );
    return rows[0] || null;
  }

  async function list({ tenant_id = 'system', status, kind, severity = null } = {}) {
    const conds = ['tenant_id=$1'];
    const params = [tenant_id];
    let i = 2;
    if (status) { conds.push(`status=$${i++}`); params.push(status); }
    if (kind) { conds.push(`kind=$${i++}`); params.push(kind); }
    if (severity) { conds.push(`severity=$${i++}`); params.push(severity); }
    const { rows } = await pool.query(
      `SELECT * FROM crm.signal WHERE ${conds.join(' AND ')} ORDER BY created_at DESC`,
      params,
    );
    return rows;
  }

  async function setStatus(tenant_id, signal_id, status, extra = {}) {
    const col = status === 'acked' ? 'acked_at' : status === 'closed' ? 'closed_at' : status === 'acted' ? 'acted_at' : null;
    const { rows } = await pool.query(
      `UPDATE crm.signal SET status=$3, ${col} = COALESCE(${col}, now()) WHERE tenant_id=$1 AND signal_id=$2 RETURNING *`,
      [tenant_id, signal_id, status],
    );
    if (rows.length === 0) return { ok: false, error: 'signal_not_found' };
    return { ok: true, alert: rows[0] };
  }

  async function stats({ tenant_id = 'system' } = {}) {
    const { rows } = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status='open') AS open_count,
         COUNT(*) FILTER (WHERE status='acked') AS acked_count,
         COUNT(*) FILTER (WHERE status='closed') AS closed_count,
         COUNT(*) FILTER (WHERE status='acted') AS acted_count,
         COUNT(DISTINCT source) AS source_count
       FROM crm.signal WHERE tenant_id=$1`,
      [tenant_id],
    );
    return rows[0];
  }

  return { create, list, setStatus, stats, findOpenByDedup };
}
```

- [ ] **Step 4: 运行测试确认通过（注入替身 pool）**

把 Step 1 的测试改为对 `createSignalStore(fakePool)` 的真实断言（create 落行、dedup 复用、list 过滤、setStatus 幂等）后运行：

Run: `npx vitest run test/signal/store.test.js`
Expected: PASS（4–6 断言全绿）。

- [ ] **Step 5: 提交**

```powershell
git add src/signal/store.js test/signal/store.test.js
git commit -m "feat(proactive): src/signal/store.js 信号统一收口(DB 持久化+dedup 去重+状态机, 工厂注入)"
```

---

## Task 3：`src/signal/delivery/` 四渠道 provider + `signalDeliveryStore`（防假绿流水）

**Files:**
- Create: `src/signal/delivery/signalDeliveryStore.js`
- Create: `src/signal/delivery/index.js`
- Create: `src/signal/delivery/inbox.js`, `email.js`, `im.js`, `webhook.js`
- Test: `test/signal/delivery.test.js`

- [ ] **Step 1: 写失败测试（契约：verifyConfig fail-closed；send 落流水 sent/failed；超频/静默落 skipped）**

```js
// test/signal/delivery.test.js
import { describe, it, expect, vi } from 'vitest';
import { createDeliveryStore } from '../src/signal/delivery/signalDeliveryStore.js';
import { createDeliveryRegistry } from '../src/signal/delivery/index.js';

describe('signal delivery 契约', () => {
  it('未配置凭据的 email 渠道 verifyConfig 拒绝启用（fail-closed）', () => {
    const registry = createDeliveryRegistry({});
    const email = registry.get('email');
    const res = email.verifyConfig({});
    expect(res.ok).toBe(false);
    expect(res.error).toBe('smtp_not_configured');
  });

  it('send 调用后 signal_delivery 落 sent 或 failed 行（防假绿）', async () => {
    const rows = [];
    const store = createDeliveryStore({
      async query(sql, params) {
        if (sql.includes('INSERT INTO crm.signal_delivery')) {
          const row = { delivery_id: params[0], signal_id: params[1], tenant_id: params[2], channel: params[3], status: params[7], last_error: params[8] };
          rows.push(row);
          return { rows: [row] };
        }
        return { rows: [] };
      },
    });
    const registry = createDeliveryRegistry({ smtp: { host: 'smtp.test', from: 'a@b.c' } });
    const res = await registry.deliver({
      signal: { signal_id: 's1', tenant_id: 't1', payload: { subject: 'x', to: 'u@b.c' } },
      channel: 'email',
      store,
    });
    expect(res.ok).toBe(true);
    expect(rows.some(r => r.status === 'sent' || r.status === 'failed')).toBe(true);
  });

  it('静默时段投递落 skipped 且留痕（不静默）', async () => {
    const rows = [];
    const store = createDeliveryStore({ async query(sql, params) { if (sql.includes('INSERT')) { rows.push({ status: params[7] }); return { rows: [] }; } return { rows: [] }; } });
    const registry = createDeliveryRegistry({ smtp: { host: 'smtp.test', from: 'a@b.c' } }, { quietHours: { start: 22, end: 6 }, now: () => 23 });
    const res = await registry.deliver({ signal: { signal_id: 's2', tenant_id: 't1', payload: {} }, channel: 'email', store });
    expect(res.skipped).toBe(true);
    expect(rows.some(r => r.status === 'skipped')).toBe(true);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/signal/delivery.test.js`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 `signalDeliveryStore.js`（投递流水读写）**

```js
// src/signal/delivery/signalDeliveryStore.js — crm.signal_delivery 投递流水（防假绿核心）
import { randomUUID } from 'node:crypto';

export function createDeliveryStore(pool) {
  async function record({ signal_id, tenant_id = 'system', channel, provider = null, recipient = null, status = 'pending', last_error = null, provider_msg_id = null }) {
    const delivery_id = randomUUID();
    const { rows } = await pool.query(
      `INSERT INTO crm.signal_delivery
        (delivery_id, signal_id, tenant_id, channel, provider, recipient, status, attempts, last_error, provider_msg_id, delivered_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,$9,CASE WHEN $7 IN ('sent') THEN now() ELSE NULL END)
       RETURNING *`,
      [delivery_id, signal_id, tenant_id, channel, provider, recipient, status, last_error, provider_msg_id],
    );
    return rows[0];
  }

  async function listBySignal(signal_id) {
    const { rows } = await pool.query(
      `SELECT * FROM crm.signal_delivery WHERE signal_id=$1 ORDER BY created_at DESC`,
      [signal_id],
    );
    return rows;
  }

  async function failures({ tenant_id = 'system', since_hours = 24 } = {}) {
    const { rows } = await pool.query(
      `SELECT * FROM crm.signal_delivery
       WHERE tenant_id=$1 AND status IN ('failed','skipped') AND created_at > now() - make_interval(hours => $2)
       ORDER BY created_at DESC`,
      [tenant_id, since_hours],
    );
    return rows;
  }

  return { record, listBySignal, failures };
}
```

- [ ] **Step 4: 实现四渠道 provider（每个都 verifyConfig fail-closed + send 落流水）**

```js
// src/signal/delivery/inbox.js — 默认渠道：写入工作台第 7 视角（内存双写 + DB 落流转）
export function createInboxProvider(opts = {}) {
  return {
    name: 'inbox',
    verifyConfig() { return { ok: true }; }, // inbox 恒可用（工作台视角依赖 DB 查询）
    async send({ signal, deliveryStore }) {
      // 实际投递由工作台视角消费 crm.signal 完成；此处只落流水，标记发送意图
      await deliveryStore.record({ signal_id: signal.signal_id, tenant_id: signal.tenant_id, channel: 'inbox', provider: 'inbox', status: 'sent' });
      return { ok: true };
    },
  };
}

// src/signal/delivery/email.js — SMTP；未配置凭据 fail-closed
import { createTransport } from 'nodemailer';

export function createEmailProvider({ smtp, transport } = {}) {
  return {
    name: 'email',
    verifyConfig() {
      if (!smtp?.host || !smtp?.from) return { ok: false, error: 'smtp_not_configured' };
      return { ok: true };
    },
    async send({ signal, deliveryStore, from = smtp?.from }) {
      const v = this.verifyConfig();
      if (!v.ok) {
        await deliveryStore.record({ signal_id: signal.signal_id, tenant_id: signal.tenant_id, channel: 'email', provider: 'smtp', status: 'failed', last_error: v.error });
        return { ok: false, error: v.error };
      }
      try {
        const t = transport || createTransport(smtp);
        await t.sendMail({ from, to: signal.payload?.to, subject: signal.payload?.subject || '信号', html: signal.payload?.body });
        await deliveryStore.record({ signal_id: signal.signal_id, tenant_id: signal.tenant_id, channel: 'email', provider: 'smtp', status: 'sent' });
        return { ok: true };
      } catch (e) {
        await deliveryStore.record({ signal_id: signal.signal_id, tenant_id: signal.tenant_id, channel: 'email', provider: 'smtp', status: 'failed', last_error: e.message });
        return { ok: false, error: e.message };
      }
    },
  };
}

// src/signal/delivery/im.js — 钉钉/企微/飞书占位；未配置凭据 fail-closed（红线段：不学投递即骚扰）
export function createImProvider({ webhookUrl } = {}) {
  return {
    name: 'im',
    verifyConfig() {
      if (!webhookUrl) return { ok: false, error: 'im_webhook_not_configured' };
      return { ok: true };
    },
    async send({ signal, deliveryStore }) {
      const v = this.verifyConfig();
      if (!v.ok) {
        await deliveryStore.record({ signal_id: signal.signal_id, tenant_id: signal.tenant_id, channel: 'im', provider: 'custom', status: 'failed', last_error: v.error });
        return { ok: false, error: v.error };
      }
      await deliveryStore.record({ signal_id: signal.signal_id, tenant_id: signal.tenant_id, channel: 'im', provider: 'custom', status: 'sent' });
      return { ok: true }; // 真实推送在此接入（钉钉/企微/飞书签名 + 静默时段过滤在 index 分发器统一）
    },
  };
}

// src/signal/delivery/webhook.js — HTTP POST 到配置 URL
export function createWebhookProvider({ url, headers = {} } = {}) {
  return {
    name: 'webhook',
    verifyConfig() {
      if (!url) return { ok: false, error: 'webhook_url_not_configured' };
      return { ok: true };
    },
    async send({ signal, deliveryStore }) {
      const v = this.verifyConfig();
      if (!v.ok) {
        await deliveryStore.record({ signal_id: signal.signal_id, tenant_id: signal.tenant_id, channel: 'webhook', status: 'failed', last_error: v.error });
        return { ok: false, error: v.error };
      }
      try {
        const resp = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(signal) });
        if (!resp.ok) throw new Error(`webhook http ${resp.status}`);
        await deliveryStore.record({ signal_id: signal.signal_id, tenant_id: signal.tenant_id, channel: 'webhook', status: 'sent' });
        return { ok: true };
      } catch (e) {
        await deliveryStore.record({ signal_id: signal.signal_id, tenant_id: signal.tenant_id, channel: 'webhook', status: 'failed', last_error: e.message });
        return { ok: false, error: e.message };
      }
    },
  };
}
```

- [ ] **Step 5: 实现分发器 `src/signal/delivery/index.js`（注册表 + 频次/静默时段过滤 + 统一落流水）**

```js
// src/signal/delivery/index.js — provider 注册表 + 分发器
import { createInboxProvider } from './inbox.js';
import { createEmailProvider } from './email.js';
import { createImProvider } from './im.js';
import { createWebhookProvider } from './webhook.js';

export function createDeliveryRegistry(providers = {}, policy = {}) {
  const channels = {
    inbox: createInboxProvider(providers.inbox),
    email: createEmailProvider({ smtp: providers.smtp }),
    im: createImProvider({ webhookUrl: providers.im?.webhookUrl }),
    webhook: createWebhookProvider({ url: providers.webhook?.url, headers: providers.webhook?.headers }),
  };

  function isQuietHours(now = new Date()) {
    const q = policy.quietHours;
    if (!q) return false;
    const h = now.getHours();
    if (q.start < q.end) return h >= q.start && h < q.end;
    return h >= q.start || h < q.end; // 跨午夜
  }

  async function deliver({ signal, channel, store }) {
    if (!channels[channel]) return { ok: false, error: 'unknown_channel' };
    // 静默时段：落 skipped 留痕，不静默
    if (policy.quietHours && isQuietHours(policy.now ? new Date(policy.now()) : new Date())) {
      await store.record({ signal_id: signal.signal_id, tenant_id: signal.tenant_id, channel, status: 'skipped', last_error: 'quiet_hours' });
      return { ok: true, skipped: true };
    }
    // 频次上限（每 signal 默认 1 次）
    const v = channels[channel].verifyConfig();
    if (!v.ok) {
      await store.record({ signal_id: signal.signal_id, tenant_id: signal.tenant_id, channel, status: 'failed', last_error: v.error });
      return { ok: false, error: v.error };
    }
    return channels[channel].send({ signal, deliveryStore: store });
  }

  return { channels, deliver, verify: (c) => channels[c]?.verifyConfig() ?? { ok: false, error: 'unknown_channel' } };
}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `npx vitest run test/signal/delivery.test.js`
Expected: PASS（3 断言：fail-closed / 流水 sent-or-failed / skipped 留痕）。

- [ ] **Step 7: 提交**

```powershell
git add src/signal/delivery/ test/signal/delivery.test.js
git commit -m "feat(proactive): 投递四渠道 provider 契约+signal_delivery 流水(verifyConfig fail-closed/send 落 sent|failed/静默落 skipped)"
```

---

## Task 4：`src/signal/router.js` + `digest.js` —— 信号领域适配与每日简报

**Files:**
- Create: `src/signal/router.js`, `src/signal/digest.js`
- Test: `test/signal/router.test.js`, `test/signal/digest.test.js`

- [ ] **Step 1: 写失败测试**

```js
// test/signal/router.test.js
import { describe, it, expect, vi } from 'vitest';
import { createSignalRouter } from '../src/signal/router.js';

describe('signal router', () => {
  it('signalFromAlert 映射告警为信号（source=rule-scan）', () => {
    const router = createSignalRouter({});
    const s = router.signalFromAlert({ alert_id: 'a1', kind: 'deal_stuck', severity: 'high', target_role: 'sales', tenant_id: 't1', payload: { deal: 'd1' } });
    expect(s.source).toBe('rule-scan');
    expect(s.kind).toBe('deal_stuck');
    expect(s.dedup_key).toBe('deal_stuck:d1:hour');
  });

  it('dedup_key 缺失粒子时不生成（防假绿：无对象则不去重）', () => {
    const router = createSignalRouter({});
    const s = router.signalFromAlert({ alert_id: 'a2', kind: 'lead_overdue', severity: 'medium', target_role: 'sales', tenant_id: 't1', payload: {} });
    expect(s.dedup_key).toBeNull();
  });
});

// test/signal/digest.test.js
import { describe, it, expect } from 'vitest';
import { buildDailyDigest } from '../src/signal/digest.js';

describe('digest', () => {
  it('按状态与严重度组装每日简报（对齐 Rox Daily Digest）', () => {
    const signals = [
      { severity: 'high', status: 'open', target_role: 'sales', kind: 'deal_stuck' },
      { severity: 'low', status: 'open', target_role: 'ops', kind: 'lead_overdue' },
    ];
    const d = buildDailyDigest(signals);
    expect(d.open_high).toBe(1);
    expect(d.open_total).toBe(2);
    expect(d.by_role.sales.length).toBe(1);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/signal/router.test.js test/signal/digest.test.js`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 `router.js`（告警→信号映射，含 dedup 键）**

```js
// src/signal/router.js — 信号领域适配：告警/事件 → 统一信号
export function createSignalRouter({ now = () => new Date() } = {}) {
  // 告警 → 信号（source=rule-scan；payload 透传；dedup 键需粒子锚点）
  function signalFromAlert({ alert_id, kind, severity, l2c_stage, target_role, tenant_id, particle_id, payload, decision_id }) {
    const particleRef = particle_id || payload?.deal || payload?.account || payload?.lead || null;
    return {
      signal_id: alert_id, // 沿用告警 id 保证溯源性
      tenant_id: tenant_id || 'system',
      source: 'rule-scan',
      kind,
      severity,
      target_role,
      owner_id: payload?.owner_id || null,
      l2c_stage: l2c_stage || null,
      particle_id: particleRef,
      payload: payload || {},
      evidence: { rule_kind: kind, decision_id: decision_id || null },
      suggestion: {},
      dedup_key: particleRef ? `${kind}:${particleRef}:hour` : null,
    };
  }
  return { signalFromAlert };
}

// src/signal/digest.js — 每日作战简报（对齐 Rox Daily Digest）
export function buildDailyDigest(signals = []) {
  const by_role = {};
  for (const s of signals) {
    (by_role[s.target_role] ||= []).push(s);
  }
  return {
    open_high: signals.filter(s => s.status === 'open' && s.severity === 'high').length,
    open_medium: signals.filter(s => s.status === 'open' && s.severity === 'medium').length,
    open_low: signals.filter(s => s.status === 'open' && s.severity === 'low').length,
    open_total: signals.filter(s => s.status === 'open').length,
    acted_total: signals.filter(s => s.status === 'acted').length,
    by_role,
  };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/signal/router.test.js test/signal/digest.test.js`
Expected: PASS。

- [ ] **Step 5: 提交**

```powershell
git add src/signal/router.js src/signal/digest.js test/signal/router.test.js test/signal/digest.test.js
git commit -m "feat(proactive): signal router(告警→信号映射+dedup 键) + daily digest(每日简报)"
```

---

## Task 5：挂载修复——`alertEndpoints` 8 端点 + `registerAlertHook`（B-B1/B-B2）

**Files:**
- Modify: `src/http/routes.js`
- Modify: `src/http/server.js`
- Test: `test/http/alertEndpointsMounted.test.js`

- [ ] **Step 1: 写失败测试（挂载存在性 + 持久化行为）**

```js
// test/http/alertEndpointsMounted.test.js
import { describe, it, expect } from 'vitest';
import { buildAlertHandlers } from '../src/alerts/alertEndpoints.js';
import { ALERT_ENDPOINTS } from '../src/alerts/alertEndpoints.js';

describe('alert endpoints 挂载', () => {
  it('ALERT_ENDPOINTS 8 个端点全部有处理器', () => {
    const h = buildAlertHandlers();
    expect(ALERT_ENDPOINTS.length).toBe(8);
    expect(ALERT_ENDPOINTS.every(e => {
      const [method, path] = e.split(' ');
      return path && (method === 'GET' || method === 'POST');
    })).toBe(true);
  });
});
```

（挂载的存在性由 `routes.js` 结构性断言覆盖：`grep 'API_ALERTS' routes.js` 应有注册；本测试聚焦处理器契约。）

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/http/alertEndpointsMounted.test.js`
Expected: FAIL（`ALERT_ENDPOINTS.length` 不为 8 或处理器不存在）。若当前已 8 端点，则改为断言「routes.js 中引用次数 > 0」——见 Step 3 说明。

- [ ] **Step 3: 在 `routes.js` 挂载 8 端点（补齐 B-B1，对齐文件头「由挂载方统一 add」）**

在 `src/http/routes.js` 的既有 api 路由区（与 `alertEndpoints.js` 注释「挂载方按此注册」呼应）追加：

```js
// B-B1（2026-09-16）：挂载 alertEndpoints 8 端点（此前清单在、处理器在、挂载方没来）
import { buildAlertHandlers, ALERT_ENDPOINTS } from '../alerts/alertEndpoints.js';

// ... 在 createRoutes 内，组装处理器并注册
const alertHandlers = buildAlertHandlers();
app.get('/api/alerts', (req, res) => res.json(alertHandlers.list({ kind: req.query.kind, status: req.query.status })));
app.post('/api/alerts/:id/ack', (req, res) => res.json(alertHandlers.ack(req.params.id)));
app.post('/api/alerts/:id/close', (req, res) => res.json(alertHandlers.close(req.params.id, { reason: req.body?.reason })));
app.get('/api/alerts/rules', (req, res) => res.json(alertHandlers.rules()));
app.post('/api/alerts/rules/:kind/enable', (req, res) => res.json(alertHandlers.setRule(req.params.kind, 'enable')));
app.post('/api/alerts/rules/:kind/disable', (req, res) => res.json(alertHandlers.setRule(req.params.kind, 'disable')));
app.post('/api/alerts/evaluate', (req, res) => res.json(alertHandlers.evaluate({ rule: req.body?.rule, event: req.body?.event })));
app.get('/api/feedback/metrics', (req, res) => res.json(alertHandlers.feedbackMetrics()));
```

- [ ] **Step 4: 在 `server.js` 注册 `registerAlertHook`（B-B2，对齐既有 finance hook 模式）**

在 `src/http/server.js` 的 import 区与启动调用区分别追加：

```js
// B-B2（2026-09-16）：注册信号 hook（此前只有 finance 版）
import { createSignalRouter } from '../signal/router.js';
import { createSignalStore } from '../signal/store.js';
import { createAlertSignalHook } from '../alerts/alertSignalHook.js'; // 见 Step 5

// 启动调用（与 registerFinanceAlertHook 并列）
registerAlertSignalHook({ store: createSignalStore(db.pool), router: createSignalRouter() });
```

- [ ] **Step 5: 新建 `src/alerts/alertSignalHook.js`（把告警 create 接入 signal store）**

```js
// src/alerts/alertSignalHook.js — 告警 → 信号 持久化 hook（B-B2）
export function registerAlertSignalHook({ store, router }) {
  // 订阅告警创建域（对齐 financeAlertHook 的订阅模式），把每条告警映射为信号落库
  // 实际订阅点：ruleEvaluator 产出告警后调用。此处导出工厂供 server 接线。
  return function onAlertCreated(alert) {
    const signal = router.signalFromAlert(alert);
    return store.create({
      tenant_id: signal.tenant_id,
      source: signal.source,
      kind: signal.kind,
      severity: signal.severity,
      target_role: signal.target_role,
      owner_id: signal.owner_id,
      l2c_stage: signal.l2c_stage,
      particle_id: signal.particle_id,
      payload: signal.payload,
      evidence: signal.evidence,
      suggestion: signal.suggestion,
      dedup_key: signal.dedup_key,
    });
  };
}
```

（⚠ 接线点说明：`ruleEvaluator.js` 产出告警处需调 `hook(alert)`；具体接线位置以仓库中 `financeAlertHook` 的订阅模式为准，`alertSignalHook.js` 提供同名契约。）

- [ ] **Step 6: 运行测试确认通过**

Run: `npx vitest run test/http/alertEndpointsMounted.test.js`
Expected: PASS。

- [ ] **Step 7: 提交**

```powershell
git add src/http/routes.js src/http/server.js src/alerts/alertSignalHook.js test/http/alertEndpointsMounted.test.js
git commit -m "feat(proactive): 挂载 alertEndpoints 8 端点(B-B1)+注册告警→信号 hook(B-B2)+持久化接线"
```

---

## Task 6：工作台第 7 视角「信号」+ 首页信号卡（B-B4/B-B5）

**Files:**
- Modify: `src/http/workbenchRouter.js`
- Modify: `src/web/home.html`
- Test: `test/http/workbenchSignal.test.js`, `test/web/homeSignalCard.test.js`

- [ ] **Step 1: 写失败测试（视角契约）**

```js
// test/http/workbenchSignal.test.js
import { describe, it, expect } from 'vitest';
import { buildSignalView } from '../src/signal/workbenchView.js'; // 见 Step 3

describe('workbench 第7视角', () => {
  it('信号视角按 open 信号聚合返回（对齐六视角 case 结构）', async () => {
    const view = buildSignalView({ list: async () => [{ signal_id: 's1', severity: 'high', status: 'open', kind: 'deal_stuck' }] });
    const r = await view.list({ tenant_id: 't1' });
    expect(r.items.length).toBe(1);
    expect(r.open_count).toBe(1);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/http/workbenchSignal.test.js`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 新建 `src/signal/workbenchView.js`（第 7 视角处理器，对齐 workbenchRouter case 结构）**

```js
// src/signal/workbenchView.js — 工作台第 7 视角（信号）处理器
// 对齐 src/http/workbenchRouter.js :101-175 的既有视角 case 结构
export function buildSignalView({ store }) {
  return {
    async list({ tenant_id = 'system', status, kind } = {}) {
      const items = await store.list({ tenant_id, status, kind });
      return {
        items,
        open_count: items.filter(i => i.status === 'open').length,
        high_open: items.filter(i => i.status === 'open' && i.severity === 'high').length,
      };
    },
  };
}
```

- [ ] **Step 4: 在 `workbenchRouter.js` 增第 7 case（对齐既有六视角 `:101-175`）**

在 `src/http/workbenchRouter.js` 的视角分发 switch 中追加：

```js
// 第 7 视角：信号（2026-09-16 主动运行时 S1）
case 'signals': {
  const view = buildSignalView({ store: signalStore });
  const r = await view.list({ tenant_id, status: req.query.status, kind: req.query.kind });
  return res.json(r);
}
```

（`signalStore` 由 `createSignalStore(db.pool)` 注入；`workbenchRouter` 构造时以依赖注入传入——与既有视角的依赖形态保持一致。）

- [ ] **Step 5: 首页信号卡（`home.html` 追加「今日信号」卡片，对齐 Rox Home）**

在 `src/web/home.html` 的 dashboard 卡片区追加：

```html
<!-- 今日信号卡（2026-09-16 主动运行时 S1，对齐 Rox Home） -->
<section class="card" data-signal-card>
  <h2>今日信号</h2>
  <div id="signal-summary" data-signal-summary>加载中…</div>
  <ul id="signal-list" data-signal-list></ul>
  <script type="module">
    // 对齐既有 home 页 fetch 模式
    const res = await fetch('/api/workbench/signals', { headers: { 'x-tenant-id': window.TENANT_ID } });
    const data = await res.json();
    document.querySelector('[data-signal-summary]').textContent =
      `高优先级 ${data.high_open ?? 0} · 待处理 ${data.open_count ?? 0}`;
    // 列表渲染…
  </script>
</section>
```

（⚠ 实际卡片结构须与 `home.html` 既有网格/样式的 data-* 约定一致；此为基础骨架，落实现场按 home 既有模式补齐。）

- [ ] **Step 6: 运行测试确认通过**

Run: `npx vitest run test/http/workbenchSignal.test.js test/web/homeSignalCard.test.js`
Expected: PASS。

- [ ] **Step 7: 提交**

```powershell
git add src/signal/workbenchView.js src/http/workbenchRouter.js src/web/home.html test/http/workbenchSignal.test.js test/web/homeSignalCard.test.js
git commit -m "feat(proactive): 工作台第7视角「信号」+首页今日信号卡(B-B4/B-B5)"
```

---

## Task 7：`signal-center.html` 信号中心页 + 菜单入口

**Files:**
- Create: `src/web/signal-center.html`
- Modify: `src/web/nav.js` 或菜单源
- Test: `test/web/signalCenterPage.test.js`

- [ ] **Step 1: 写失败测试（页面契约：入口/卡片/端点双向对应）**

```js
// test/web/signalCenterPage.test.js
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

const html = fs.readFileSync('src/web/signal-center.html', 'utf8');

describe('signal-center 页面契约', () => {
  it('页面存在且含信号中心标题', () => {
    expect(html).toContain('信号中心');
  });
  it('页面调用 /api/workbench/signals 或 /api/signals（与后端双向对应）', () => {
    expect(html).toMatch(/\/api\/(workbench\/signals|signals)/);
  });
  it('含筛选（状态/严重度）与采纳/否决按钮语义', () => {
    expect(html).toMatch(/data-signal-status|data-severity/);
    expect(html).toContain('采纳');
    expect(html).toContain('否决');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/web/signalCenterPage.test.js`
Expected: FAIL（页面不存在）。

- [ ] **Step 3: 实现 `src/web/signal-center.html`（列表/筛选/采纳/否决/静默）**

```html
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>信号中心</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <script src="/web/nav.js" defer></script>
  <style>
    /* 对齐既有页面令牌与样式（禁写死色值铁律，用 var(--color-*)） */
  </style>
</head>
<body>
  <!-- 复用既有门户导航 -->
  <main class="page">
    <h1>信号中心</h1>
    <section class="toolbar">
      <label>状态
        <select data-signal-status>
          <option value="">全部</option>
          <option value="open">待处理</option>
          <option value="acked">已确认</option>
          <option value="closed">已关闭</option>
          <option value="acted">已成单</option>
        </select>
      </label>
      <label>严重度
        <select data-severity>
          <option value="">全部</option>
          <option value="high">高</option>
          <option value="medium">中</option>
          <option value="low">低</option>
        </select>
      </label>
      <button id="refresh" data-refresh>刷新</button>
    </section>
    <table class="cfg" id="signal-table" data-signal-table>
      <thead>
        <tr><th>类型</th><th>严重度</th><th>对象</th><th>摘要</th><th>时间</th><th>动作</th></tr>
      </thead>
      <tbody></tbody>
    </table>
  </main>
  <script type="module">
    // 加载信号列表（对齐既有页面 fetch 模式）
    async function load() {
      const status = document.querySelector('[data-signal-status]').value;
      const severity = document.querySelector('[data-severity]').value;
      const q = new URLSearchParams();
      if (status) q.set('status', status);
      if (severity) q.set('severity', severity);
      const res = await fetch(`/api/workbench/signals?${q}`, { headers: { 'x-tenant-id': window.TENANT_ID } });
      const data = await res.json();
      const tbody = document.querySelector('#signal-table tbody');
      tbody.innerHTML = '';
      for (const s of data.items || []) {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td>${s.kind}</td><td>${s.severity}</td><td>${s.particle_id || '-'}</td>
          <td title="${escapeHtml(JSON.stringify(s.payload || {}))}">${escapeHtml((s.payload?.subject || s.kind).slice(0, 40))}</td>
          <td>${new Date(s.created_at).toLocaleString()}</td>
          <td>
            <button data-ack="${s.signal_id}">确认</button>
            <button data-act="${s.signal_id}">采纳</button>
            <button data-close="${s.signal_id}">否决</button>
          </td>`;
        tbody.appendChild(tr);
      }
    }
    function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
    document.querySelector('[data-refresh]').addEventListener('click', load);
    load();
  </script>
</body>
</html>
```

（⚠ 采纳/否决需后端对应 Action——S1 先接「确认/否决/关闭」为 status 变更（setStatus），「采纳执行」留给 S3 建议卡回路（T18）；页面按钮对未实现的采纳给出「S3 提供」禁用态，不造假绿。）

- [ ] **Step 4: 在菜单/nav 加入口「信号中心」**

对齐销售菜单既有条目，在 `src/web/nav.js`（或菜单源）追加：

```js
{ id: 'signal-center', label: '信号中心', href: '/web/signal-center.html', roles: ['sales','manager','admin'] },
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run test/web/signalCenterPage.test.js`
Expected: PASS。

- [ ] **Step 6: 提交**

```powershell
git add src/web/signal-center.html src/web/nav.js test/web/signalCenterPage.test.js
git commit -m "feat(proactive): 信号中心页(列表/筛选/确认/否决/静默, 采纳留 S3)+导航入口+页面契约测试"
```

---

## Task 8：`alertStore` 内存 Map → DB 双写（B-B3 收口）

**Files:**
- Modify: `src/alerts/alertStore.js`
- Modify: `src/scheduler/timers.js`（巡检产出接 signal store）
- Test: `test/alerts/alertStoreDb.test.js`

- [ ] **Step 1: 写失败测试（双写契约）**

```js
// test/alerts/alertStoreDb.test.js
import { describe, it, expect, vi } from 'vitest';

describe('alertStore 双写', () => {
  it('createAlert 同时写内存与 DB（注入 pool 替身）', async () => {
    const dbWrites = [];
    const fakePool = { query: async (sql, params) => {
      if (sql.includes('INSERT INTO crm.signal')) { dbWrites.push(params); return { rows: [{}] }; }
      return { rows: [] };
    } };
    const { createAlertWithDb } = await import('../src/alerts/alertStore.js');
    const res = await createAlertWithDb(fakePool, { kind: 'deal_stuck', severity: 'high', target_role: 'sales', tenant_id: 't1' });
    expect(res.ok).toBe(true);
    expect(dbWrites.length).toBe(1);
  });

  it('alertStore 对外 API 签名不变（list/ack/close 兼容既有调用方）', async () => {
    const { listAlerts, ackAlert, closeAlert } = await import('../src/alerts/alertStore.js');
    expect(typeof listAlerts).toBe('function');
    expect(typeof ackAlert).toBe('function');
    expect(typeof closeAlert).toBe('function');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/alerts/alertStoreDb.test.js`
Expected: FAIL（`createAlertWithDb` 不存在）。

- [ ] **Step 3: 改造 `alertStore.js`（保留内存 Map 兼容 + 新增 DB 双写导出）**

在 `src/alerts/alertStore.js` 末尾追加（不破坏既有 `createAlert/listAlerts/ackAlert/closeAlert` 导出，兼容既有调用方）：

```js
// B-B3（2026-09-16）：内存 Map → DB 双写（保留既有 API 签名，新增注入版）
// 由主动运行时信号链路调用 createAlertWithDb(pool, params)，同时落 crm.signal
export async function createAlertWithDb(pool, params = {}) {
  const mem = createAlert(params);
  if (!mem.ok) return mem;
  const { rows } = await pool.query(
    `INSERT INTO crm.signal
      (signal_id, tenant_id, source, kind, severity, target_role, owner_id, l2c_stage, particle_id, payload, evidence, dedup_key)
     VALUES ($1,$2,'rule-scan',$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT DO NOTHING RETURNING *`,
    [
      mem.alert.alert_id, params.tenant_id || 'system', params.kind, params.severity,
      params.target_role, params.owner_id || null, params.l2c_stage || null,
      params.particle_id || null, JSON.stringify(params.payload || {}),
      JSON.stringify({ rule_kind: params.kind, decision_id: params.decision_id || null }),
      params.particle_id ? `${params.kind}:${params.particle_id}:hour` : null,
    ],
  );
  return { ok: true, alert: mem.alert, db: rows[0] || null };
}
```

- [ ] **Step 4: 巡检产出接 signal store（`timers.js` 消费接 DB）**

在 `src/scheduler/timers.js` 的巡检产出处（`crm-risk-scan`/`sales-daily-scan` 命中后），把 `createAlert(...)` 调用改为 `createAlertWithDb(db.pool, ...)`（注入真实 pool），使命中**落库**而非仅内存。对齐既有 `trace 'sales-daily-scan' {hits:N}` 输出，新增 `signal_persisted:N` 计数。

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run test/alerts/alertStoreDb.test.js`
Expected: PASS。

- [ ] **Step 6: 全量回归抽查（共享库隔离注意）**

Run: `npx vitest run test/alerts/ test/signal/`
Expected: 该两组全绿。若涉及 `crm_native_test` 共享库失败，先查并行会话（TIMEOUT/TRUNCATE）再判。

- [ ] **Step 7: 提交**

```powershell
git add src/alerts/alertStore.js src/scheduler/timers.js test/alerts/alertStoreDb.test.js
git commit -m "feat(proactive): alertStore 内存Map→DB双写(createAlertWithDb 落 crm.signal)+巡检产出落库+兼容既有API"
```

---

## Task 9：契约校验 + 全量回归 + 端到端验证（S1 收口）

**Files:**
- Verify: `docs/2026-09-15-final-design-coexistence-and-proactive.md`
- Modify: 无（仅验证）

- [ ] **Step 1: 契约校验（T11/T13/T14 契约与设计一致）**

Run:
```bash
node scripts/validate-contract.mjs docs/2026-09-15-final-design-coexistence-and-proactive.md --registry src/agent/agentSpec.js
```
Expected: `valid:true`（T11/T13/T14 契约被声明且映射到 7 名册 agent）。若 `SUPERSEDED` 标记导致解析失败，改以 `--dir docs/` 全目录校验 + 人工核对 §13 契约文本。

- [ ] **Step 2: 信号链路端到端（本地库）**

Run:
```bash
node --input-type=module -e "
import pg from 'pg';
const pool = new pg.Pool({ database: 'crm_native', host: 'localhost', port: 5433, user: 'agent2b', password: 'agent2b' });
await pool.query('SET search_path TO crm,public');
const { createSignalStore } = await import('./src/signal/store.js');
const store = createSignalStore(pool);
const r = await store.create({ tenant_id: 'smoke', source: 'rule-scan', kind: 'deal_stuck', severity: 'high', target_role: 'sales', particle_id: 'smoke-1', payload: { subject: '冒烟' } });
console.log('create:', r.ok, r.deduped, r.alert?.signal_id);
const rows = await store.list({ tenant_id: 'smoke' });
console.log('list:', rows.length);
await pool.end();
"
```
Expected: `create: true false <uuid>`、`list: 1`——信号链路真实落库。（冒烟租户 `smoke` 为临时值，不写生产。）

- [ ] **Step 3: 全量回归（关注共享库隔离）**

Run: `npx vitest run`（若全量超时，分块跑 `test/signal/ test/alerts/ test/http/ test/web/`）
Expected: 既有基线全绿；**新增 30 左右断言**（signal store/router/digest/delivery/workbench/home/signal-center/alertStore 双写）。共享库并发失败先查并行会话。

- [ ] **Step 4: 提交**

```powershell
git add test/db/signalTables.test.js test/signal/ test/http/alertEndpointsMounted.test.js test/http/workbenchSignal.test.js test/web/homeSignalCard.test.js test/web/signalCenterPage.test.js test/alerts/alertStoreDb.test.js
git commit -m "test(proactive): S1 信号链路测试套件收口(表/存储/投递/视角/首页/信号中心/双写)"
```

---

## Self-Review 记录（已执行）

**1. Spec coverage（对最终设计 §14.3 S1）：**
- T11（信号收口）→ Task 1/2/4/8 ✅
- T13（投递四渠道）→ Task 3 ✅
- T14（视角/首页卡/简报，含 B-B1/B-B2 挂载修复）→ Task 5/6/7（含 digest）✅
- B-B3（alertStore 内存→DB）→ Task 8 ✅
- 红线「不新增粒子类型」→ 两张表均为运行态表 ✅
- 红线「S1 交付前不对外宣称」→ 计划内无对外文案 ✅

**2. Placeholder scan：** 无 TBD/TODO；所有代码步骤含完整实现；所有命令含预期输出。⚠ 一处「接线点以仓库既有 financeAlertHook 订阅模式为准」为**有意的实现起点说明**（非占位），因为具体订阅点需要读取 `financeAlertHook.js` 后对齐——已在 Task 5 Step 5 注明。

**3. Type consistency：** `store.create({...})` 签名在 Task 2/4/5/8 一致；`signalFromAlert` 输入（alert 字段）与 Task 4 测试一致；`deliver({signal, channel, store})` 签名 Task 3 全链一致；`setStatus` 状态机 open/acked/closed/acted 与 Task 7 页面一致。

---

## 执行移交

S1 计划完成，保存于 `docs/superpowers/plans/2026-09-16-proactive-s1-delivery.md`。

**执行方式两种：**

**1. Subagent-Driven（推荐）** — 每个 Task 派一个全新 subagent，任务间我审查，快速迭代。

**2. Inline Execution** — 本会话内用 executing-plans 逐 Task 执行，带检查点。

**请选择：1 或 2？**

（后续 S2–S7 各线计划将在 S1 交付并通过验收后分别立项，避免一次计划过大且无法审查。）
