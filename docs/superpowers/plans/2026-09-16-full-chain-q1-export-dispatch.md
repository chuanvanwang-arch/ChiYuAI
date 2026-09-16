# [全链集成 Q1：出口接电 —— 信号投递编排层] Implementation Plan

> **执行状态（2026-09-16）：✅ 已执行完成** —— 5 个 Task 全部落地并实跑通过（route 16 / dispatcher 13 / timers 5 / signalMetrics 8 / e2e 6）。
> 执行期发现 **6 处计划缺陷（P-1…P-6）**，均已修正并登记于文末「执行完成记录」。
> ⚠ **验收口径警告**：本批交付的「泵」在真实库（`crm_native`）上**将以零投递空转** —— 因为**零租户配置过 `signal-delivery`**（419 条 open signal / `signal_delivery` 恒 0 行）。
> 即：**面板四条红框消失 ≠ 链路已通**。详见 `docs/2026-09-16-q1-export-acceptance.md` §0 与 R-A（阻塞级）。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补上「生产侧驱动投递的进程」——让每一条 `crm.signal` 都能被推送到渠道并落 `crm.signal_delivery` 流水，从而消灭面板上四条 `delivery_silent` 红色告警，并修正判据自身携带的假前提。

**Architecture:** 新增 `src/signal/route.js`（消费端契约：读 `config_store['signal-delivery']` → 渠道/收件人/静默/限速决策）与 `src/signal/dispatcher.js`（编排器：泵 `status='open'` 的 signal → 逐渠道调既有 `deliveryRegistry.deliver()` → 落流水），由 `src/scheduler/timers.js` 注册定时器⑰ 驱动，并修正 `src/monitor/signalMetrics.js` 的 `enabledChannels` 从配置读取。**零新表、零新粒子类型、零 DELETE。**

**Tech Stack:** Node 22 ESM · Express 4 · PostgreSQL 16 · vitest 3 · 既有 `src/config/configStore.js`（`readConfig`） · 既有 `src/signal/delivery/`（provider + `createDeliveryRegistry`） · 既有 `src/signal/delivery/signalDeliveryStore.js`（`crm.signal_delivery`）· 既有 `src/db.js`（`query` / `pool`）

**设计来源（FINAL，已批准）：** `docs/2026-09-16-full-chain-integration-design.md` **v1.1** §1.1 / §3.1 / §3.1.1 / §3.2 / §3.3 / §4（Q1-1…Q1-5）
**本计划覆盖契约：** `ct-followup` × 4（Q1-1 / Q1-2 / Q1-3 / Q1-5）、`ct-retro-decision` × 1（Q1-4）——契约块**逐条平移自设计 §4，不重写**。

### ⚠ 本计划内嵌的 2 处设计修正（D1 / D2，2026-09-16 计划期发现 → 已登记设计 v1.1 §8.3）

| 编号 | 修正 | 用户裁决 | 本计划落点 |
| --- | --- | --- | --- |
| **D1** | 泵范围**含 `system` 平台租户**（原写法 `tenant_id <> 'system'` 会让平台级信号永久静默）；收件人对 `system` 回退 `role_recipients.platform` | ✅ **用户选定方案 A** | Q1-1（`pumpAllTenants` 去掉排除）+ Q1-2（`recipientsFor` 回退）+ Q1-5（N8） |
| **D2** | 候选集加**时间窗**（`config_store['signal-dispatch'].max_age_days`，缺省 7 天）；**否决**在 `crm.signal` 加 `delivered_at` / 状态迁移 | ✅ **模型保守裁决**（理由见设计 §3.1.1） | Q1-1（`resolveWindowDays` + 窗口谓词）+ Q1-3（装配 `readConfig`）+ Q1-5（N9） |

> **本计划的两条新增红线（不得违反）**：
> **R4** —— **严禁**在泵候选集 **SQL** 中出现 `tenant_id <> 'system'`（D1 回归即平台告警永久静默）。
> ⚠ **守卫实现方式有陷阱**：`dispatcher.js` 的**注释**里就含 `tenant_id <> 'system'` 这个字面量（用于说明为何禁用）。因此**绝不可**用「grep 该文件禁止该串」做守卫——那会命中注释产生**假红**（本仓已知变体：禁词断言未剥离注释 = 代码越好越红）。**唯一正确的守卫是对「传给 `query` 的 SQL 字符串」断言**，即本计划 Q1-1 的 `candidateSql` 负向断言（零 DB、可复跑）。
> **R5** —— 时间窗**只收窄候选集**，**绝不允许**因此对 `crm.signal` 执行 DELETE 或状态迁移（本仓绝对禁 DELETE）。
> 两者均有**可复跑的负向断言**（Q1-1 单测 + Q1-5 N8/N9），不依赖人工记忆。

---

## 执行前环境与纪律（务必先读）

- 工作目录：`D:\system\CRM-ai-native`。
- **测试库**：`crm_native_test`；直连先 `SET search_path TO crm,public`；凭据 `agent2b/agent2b@localhost:5433`。
- **Node 运行时**：优先托管版本 `C:\Users\wangchuan08\.workbuddy\binaries\node\versions\22.22.2-2\node.exe`。
- **Vitest**：`npx vitest run <path> -t "<name>"`。
- **提交纪律**：AI 无提交凭证 → 每个 Task 末尾输出**精确 PowerShell 命令**（显式路径 add、**禁 `git add -A`**、`-m` 单行、无 heredoc），由用户在本地仓库执行。
- **回归纪律**：全量回归 flaky（约 2612 例）→ **单次红不得直判回归**；跨会话共享 `crm_native_test` 并发 TRUNCATE 会伪失败 → 先查并行会话再判。
- **红线**：不新增粒子类型；不改业务域模型；写操作过决策第 0 闸；**本段交付前不得对外宣称「AI 主动值守」**。

### ⚠ 五处必须在动手前知道的既有事实（已实测，避免踩坑）

1. **`readConfig` 的返回形状**：`readConfig(key, {tenantId})` 返回 `{ value, decision_id }`（或 `null`），**不是** `{ key, value }`。取值写法固定为 `(await readConfig(k,{tenantId}))?.value`（参照 `src/signal/scheduleScanner.js:24`）。
2. **provider 自己落流水**：`src/signal/delivery/inbox.js:11`、`email.js:26/41` 等 provider 的 `send()` **内部已调用 `deliveryStore.record()`**。→ **编排器绝对不能再补记一次**，否则同一次投递产生双行（假绿）。
3. **`detectNegativePredicates` 有 2 个既有调用点不传 `enabledChannels`**（`test/monitor/signalMetrics.test.js:76`、`:84`）→ 这决定了 Q1-4 的实现形状：**只能把 `enabledChannels` 的解析限定在「判据 A（delivery_silent）」内部，绝不能让配置缺失导致函数提前 return**，否则判据 B（`gen_silent`）会被连带跳过、既有测试 `:84` 转红。
4. **本计划新消费的 2 个配置键**（均在 `crm.config_store`，`PK = (tenant_id, key)`，按仓库铁律**零硬编码**）：
   - `signal-delivery`（业务租户 + `system` 各自持有一份）：`channels{}` / `route{severity→渠道}` / `role_recipients{角色→[收件人]}`（**含 `platform` 键，供 `system` 回退**，D1）/ `quiet_hours` / `rate_limit` / `retry`。**读不到即 fail-closed**（Q1-2 `configured:false`），不得默认全开。
   - `signal-dispatch`.max_age_days（**平台口径**，读 `tenantId='system'`）：泵的时间窗天数，缺省 7（D2）。缺失只影响窗口，**不阻断泵**。
5. **`readConfig` 已在 `src/scheduler/timers.js:15` 导入**（`import { readConfig } from '../config/configStore.js'`）→ Q1-3 装配时**直接透传，无需重复导入**。

---

## 文件结构（本计划创建/修改清单）

| 文件 | 动作 | 职责 |
| --- | --- | --- |
| `src/signal/route.js` | **新建** | 消费端契约：读 `signal-delivery` 配置 → 渠道集合 / 收件人 / 静默时段 / 限速 → 逐渠道决策 |
| `src/signal/dispatcher.js` | **新建** | 投递编排器（水泵）：泵 open signal → 按决策逐渠道投递 → 幂等 + 重试上限 + 非静默留痕 |
| `src/scheduler/timers.js` | 修改 | 注册定时器⑰ `signal-dispatch`（`SIGNAL_DISPATCH_MS`，默认 5 分钟） |
| `test/timers.test.js` | 修改 | `EXPECTED_TIMERS` 16 → 17，并登记新定时器注释 |
| `src/monitor/signalMetrics.js` | 修改 | 修正 `enabledChannels` 假前提：改为从 `config_store['signal-delivery']` 读取 |
| `test/signal/route.test.js` | **新建** | 路由/收件人/静默/限速单测（纯函数级，不依赖 PG） |
| `test/signal/dispatcher.test.js` | **新建** | 编排器幂等/重试/非静默单测（注入替身 query + store + registry） |
| `test/monitor/signalMetrics.test.js` | **新建/追加** | 追加「配置缺失 → 判据 A 不触发且留 trace」；**不改动既有用例**（见上方事实 3） |
| `test/signal/dispatch-e2e.test.js` | **新建** | 真库端到端：signal → 投递 → `crm.signal_delivery` 出现 `sent` 行；**含 N8（platform 路径）/ N9（窗口）** |

> **本计划不新建任何表、不新增任何粒子类型、不新增任何迁移**（D2 亦选择零 DDL 方案）。全部改动落在上表 9 个文件内。

**实施顺序按依赖调整**（任务编号与设计 §4 保持一致，**契约按 Q 编号平移，不重编号**）：

```
Q1-2 route.js  →  Q1-1 dispatcher.js  →  Q1-3 定时器⑰  →  Q1-4 判据修正  →  Q1-5 真库 e2e
```

---

## Task Q1-2: `src/signal/route.js` —— 路由与收件人解析（消费端契约）

> 对应契约：`ct-followup`（设计 §4 Q1-2）
> 依赖：无（本任务先做，Q1-1 依赖它）

**Files:**
- Create: `src/signal/route.js`
- Test: `test/signal/route.test.js`

- [ ] **Step 1: 写失败测试**

创建 `test/signal/route.test.js`：

```js
// test/signal/route.test.js — 投递路由与收件人解析（纯函数级，注入替身 readConfig/query）
import { describe, it, expect } from 'vitest';
import { createSignalRouter } from '../../src/signal/route.js';

// 替身 readConfig：返回 { value } 形状（与 src/config/configStore.js 真实返回一致）
function fakeRead(value) {
  return async () => (value === null ? null : { value });
}

const ON_ALL = {
  channels: { inbox: 'on', email: 'on', im: 'on', webhook: 'on' },
  route: { high: ['im', 'email'], medium: ['email'], low: ['inbox'] },
  role_recipients: { sales: ['alice'] },
};
const NO_QUERY = { query: async () => ({ rows: [{ c: 0 }] }) };

describe('route.loadPolicy（渠道集合必须来自配置）', () => {
  it('配置存在 → channels 只含值为 on/true 的渠道', async () => {
    const r = createSignalRouter({
      readConfig: fakeRead({ channels: { inbox: 'on', email: 'off', im: 'on', webhook: 'off' } }),
      query: NO_QUERY.query,
    });
    const p = await r.loadPolicy({ tenantId: 't1' });
    expect(p.configured).toBe(true);
    expect(p.channels).toEqual(['inbox', 'im']);
  });

  it('配置缺失 → configured=false 且 channels 为空（fail-closed，绝不默认全开）', async () => {
    const r = createSignalRouter({ readConfig: fakeRead(null), query: NO_QUERY.query });
    const p = await r.loadPolicy({ tenantId: 't1' });
    expect(p.configured).toBe(false);
    expect(p.channels).toEqual([]);
  });

  it('retry 缺省为 0（无配置即不重试，零字面量阈值）', async () => {
    const r = createSignalRouter({ readConfig: fakeRead({ channels: { inbox: 'on' } }), query: NO_QUERY.query });
    const p = await r.loadPolicy({ tenantId: 't1' });
    expect(p.retryLimit).toBe(0);
  });

  it('retry 显式配置为 2 → retryLimit=2', async () => {
    const r = createSignalRouter({ readConfig: fakeRead({ channels: { inbox: 'on' }, retry: 2 }), query: NO_QUERY.query });
    const p = await r.loadPolicy({ tenantId: 't1' });
    expect(p.retryLimit).toBe(2);
  });
});

describe('route.resolve（逐渠道决策）', () => {
  it('severity=high → 路由到 im+email（且均在 channels 内）', async () => {
    const r = createSignalRouter({ readConfig: fakeRead(ON_ALL), query: NO_QUERY.query });
    const out = await r.resolve({ signal: { signal_id: 's1', tenant_id: 't1', severity: 'high', target_role: 'sales' }, tenantId: 't1' });
    expect(out.decisions.map((d) => d.channel)).toEqual(['im', 'email']);
  });

  it('severity=low → 路由到 inbox', async () => {
    const r = createSignalRouter({ readConfig: fakeRead(ON_ALL), query: NO_QUERY.query });
    const out = await r.resolve({ signal: { signal_id: 's2', tenant_id: 't1', severity: 'low', target_role: 'sales' }, tenantId: 't1' });
    expect(out.decisions.map((d) => d.channel)).toEqual(['inbox']);
  });

  it('路由要求的渠道未被启用 → 被过滤掉（绝不越出配置开关）', async () => {
    const r = createSignalRouter({
      readConfig: fakeRead({ channels: { inbox: 'on', email: 'off' }, route: { high: ['im', 'email'] }, role_recipients: { sales: ['alice'] } }),
      query: NO_QUERY.query,
    });
    const out = await r.resolve({ signal: { signal_id: 's3', tenant_id: 't1', severity: 'high', target_role: 'sales' }, tenantId: 't1' });
    // route.high 要求 im+email，但 channels 只开了 inbox（email='off'）→ 交集为空 → 零决策
    expect(out.decisions).toEqual([]);
    expect(out.reason).toBe('no_channel_for_severity');
  });

  it('role_recipients 解析不到 → 出站渠道 skip 且 reason=no_recipient（不静默）', async () => {
    const r = createSignalRouter({
      readConfig: fakeRead({ channels: { email: 'on' }, route: { high: ['email'] }, role_recipients: {} }),
      query: NO_QUERY.query,
    });
    const out = await r.resolve({ signal: { signal_id: 's4', tenant_id: 't1', severity: 'high', target_role: 'sales' }, tenantId: 't1' });
    expect(out.decisions).toEqual([{ channel: 'email', recipient: null, skip: true, reason: 'no_recipient' }]);
  });

  it('inbox 渠道无需收件人（不依赖 role_recipients）', async () => {
    const r = createSignalRouter({
      readConfig: fakeRead({ channels: { inbox: 'on' }, route: { low: ['inbox'] }, role_recipients: {} }),
      query: NO_QUERY.query,
    });
    const out = await r.resolve({ signal: { signal_id: 's5', tenant_id: 't1', severity: 'low', target_role: 'sales' }, tenantId: 't1' });
    expect(out.decisions).toEqual([{ channel: 'inbox', recipient: null, skip: false, reason: null }]);
  });

  it('静默时段（含跨午夜）→ 全渠道 skip 且 reason=quiet_hours', async () => {
    const r = createSignalRouter({
      readConfig: fakeRead({ channels: { inbox: 'on' }, quiet_hours: { start: 22, end: 6 } }),
      query: NO_QUERY.query,
    });
    const out = await r.resolve({
      signal: { signal_id: 's6', tenant_id: 't1', severity: 'low', target_role: 'sales' },
      tenantId: 't1',
      now: new Date('2026-09-16T23:30:00'),
    });
    expect(out.decisions).toEqual([{ channel: 'inbox', recipient: null, skip: true, reason: 'quiet_hours' }]);
  });

  it('超出 per_hour 限速 → 全渠道 skip 且 reason=rate_limited', async () => {
    const r = createSignalRouter({
      readConfig: fakeRead({ channels: { inbox: 'on' }, rate_limit: { per_hour: 5 } }),
      query: async () => ({ rows: [{ c: 5 }] }), // 已用满
    });
    const out = await r.resolve({ signal: { signal_id: 's7', tenant_id: 't1', severity: 'low', target_role: 'sales' }, tenantId: 't1' });
    expect(out.decisions).toEqual([{ channel: 'inbox', recipient: null, skip: true, reason: 'rate_limited' }]);
  });

  it('配置缺失 → reason=delivery_config_missing 且 decisions 为空', async () => {
    const r = createSignalRouter({ readConfig: fakeRead(null), query: NO_QUERY.query });
    const out = await r.resolve({ signal: { signal_id: 's8', tenant_id: 't1', severity: 'low', target_role: 'sales' }, tenantId: 't1' });
    expect(out.reason).toBe('delivery_config_missing');
    expect(out.decisions).toEqual([]);
  });
});

// D1（设计 §3.2 修正，2026-09-16）：泵范围含 system，故 system 的收件人路径必须被显式验证
describe('route 平台租户收件人回退（D1：system 不享有投递豁免）', () => {
  const CFG_WITH_PLATFORM = {
    channels: { email: 'on' },
    route: { high: ['email'] },
    role_recipients: { platform: ['ops@example.com'], sales: ['alice'] },
  };

  it('system 租户 + 业务角色解析不到 → 回退 role_recipients.platform', async () => {
    const r = createSignalRouter({ readConfig: fakeRead(CFG_WITH_PLATFORM), query: NO_QUERY.query });
    const out = await r.resolve({
      signal: { signal_id: 'p1', tenant_id: 'system', severity: 'high', target_role: 'unknown-role' },
      tenantId: 'system',
    });
    expect(out.decisions).toEqual([{ channel: 'email', recipient: 'ops@example.com', skip: false, reason: null }]);
  });

  it('system 租户 + platform 键也缺失 → 仍返回 no_recipient（不因平台租户而豁免）', async () => {
    const r = createSignalRouter({
      readConfig: fakeRead({ channels: { email: 'on' }, route: { high: ['email'] }, role_recipients: { sales: ['alice'] } }),
      query: NO_QUERY.query,
    });
    const out = await r.resolve({
      signal: { signal_id: 'p2', tenant_id: 'system', severity: 'high', target_role: 'unknown-role' },
      tenantId: 'system',
    });
    expect(out.decisions).toEqual([{ channel: 'email', recipient: null, skip: true, reason: 'no_recipient' }]);
  });

  it('非 system 租户绝不回退 platform（跨租户隔离：不得借用他人收件人）', async () => {
    const r = createSignalRouter({ readConfig: fakeRead(CFG_WITH_PLATFORM), query: NO_QUERY.query });
    const out = await r.resolve({
      signal: { signal_id: 'p3', tenant_id: 't1', severity: 'high', target_role: 'unknown-role' },
      tenantId: 't1',
    });
    expect(out.decisions).toEqual([{ channel: 'email', recipient: null, skip: true, reason: 'no_recipient' }]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/signal/route.test.js`
Expected: FAIL —`Failed to resolve import "../../src/signal/route.js"`

- [ ] **Step 3: 写最小实现**

创建 `src/signal/route.js`：

```js
// src/signal/route.js — 投递路由与收件人解析（消费端契约）
// 设计输入：docs/2026-09-16-full-chain-integration-design.md §3.2（含 D1 修正：system 平台租户收件人回退）
// 铁律：
//   ① 渠道集合**必须**来自 config_store['signal-delivery'].channels，零硬编码默认值
//      （此前 signalMetrics.js 的 DEFAULT_CHANNELS 就是本条被违反的产物——判据自带假前提）；
//   ② 收件人解析不到**必须**显式返回 skip 原因（不静默、不假绿）；
//   ③ 静默时段/限速丢弃一律 skip 留痕（含跨午夜区间）；
//   ④ system 租户回退 role_recipients.platform，**非 system 租户绝不回退**（跨租户隔离）；收件人禁硬编码。
import { readConfig as defaultRead, query as defaultQuery } from '../config/configStore.js';

export const ALL_CHANNELS = ['inbox', 'email', 'im', 'webhook'];
// 无需外部收件人的渠道（平台内视角消费 crm.signal 完成「投递」）
const IN_PLATFORM_CHANNELS = ['inbox'];

export function createSignalRouter({ readConfig = defaultRead, query } = {}) {
  // loadPolicy：读配置 → 归一化为可用策略。读不到 → configured:false + 空渠道（fail-closed）
  async function loadPolicy({ tenantId = 'system' } = {}) {
    const row = await readConfig('signal-delivery', { tenantId }).catch(() => null);
    const cfg = row?.value || null;
    if (!cfg || typeof cfg !== 'object') {
      return { configured: false, channels: [], route: {}, roleRecipients: {}, quietHours: null, rateLimit: null, retryLimit: 0 };
    }
    const raw = cfg.channels || {};
    const channels = ALL_CHANNELS.filter((c) => raw[c] === 'on' || raw[c] === true);
    return {
      configured: true,
      channels,
      route: cfg.route || {},
      roleRecipients: cfg.role_recipients || {},
      quietHours: cfg.quiet_hours || null,
      rateLimit: cfg.rate_limit || null,
      // 重试上限：无配置即 0（不重试）。**不设默认阈值字面量**——阈值一律配置化。
      retryLimit: Number.isInteger(cfg.retry) ? cfg.retry : 0,
    };
  }

  // 静默时段（跨午夜安全：start > end 表示跨越 0 点，如 22:00–06:00）
  function inQuietHours(quietHours, now = new Date()) {
    if (!quietHours || quietHours.start == null || quietHours.end == null) return false;
    const h = now.getHours();
    const { start, end } = quietHours;
    if (start === end) return false;
    if (start < end) return h >= start && h < end;
    return h >= start || h < end;
  }

  // 限速：统计窗口内已 sent 行数；达到上限即拒（跳过并留痕，绝不静默丢弃）
  async function overRateLimit(rateLimit, { tenantId, now = new Date() } = {}) {
    if (!rateLimit || typeof rateLimit !== 'object') return false;
    const windows = [
      { limit: rateLimit.per_hour, hours: 1 },
      { limit: rateLimit.per_day, hours: 24 },
    ].filter((w) => Number.isFinite(w.limit) && w.limit > 0);
    if (!windows.length) return false;
    if (typeof query !== 'function') return false; // 未注入 query（纯函数级单测）→ 不限速
    for (const w of windows) {
      const { rows: [r] } = await query(
        `SELECT COUNT(*)::int AS c FROM crm.signal_delivery
         WHERE tenant_id=$1 AND status='sent' AND created_at > now() - make_interval(hours => $2)`,
        [tenantId, w.hours],
      );
      if (Number(r?.c || 0) >= w.limit) return true;
    }
    return false;
  }

  // 渠道选择：severity 路由优先；缺失则回落到「全部已启用渠道」。结果必须 ∩ policy.channels
  function channelsFor(signal, policy) {
    const byRoute = policy.route?.[signal?.severity];
    const wanted = Array.isArray(byRoute) && byRoute.length ? byRoute : policy.channels;
    return wanted.filter((c) => policy.channels.includes(c));
  }

  // 收件人解析：role_recipients[target_role]（首个为默认收件人）
  //   D1（设计 §3.2 修正）：**仅当租户为平台租户 `system`** 且业务角色解析不到时，回退 `role_recipients.platform`；
  //     platform 键同样缺失 → 仍返回 no_recipient（**system 不享有投递豁免**）；
  //     非 system 租户**绝不**回退 platform（防止跨租户借用收件人）；
  //     收件人一律来自 config_store —— 禁止硬编码平台收件人（继承「差异化 100% 后台配置化」铁律）。
  function recipientsFor(signal, policy, tenantId = signal?.tenant_id) {
    const pick = (role) => {
      const list = role ? policy.roleRecipients?.[role] : null;
      return Array.isArray(list) && list.length ? list : null;
    };
    const direct = pick(signal?.target_role);
    if (direct) return { recipients: direct, reason: null };
    if (tenantId === 'system') {
      const fallback = pick('platform');
      if (fallback) return { recipients: fallback, reason: null };
    }
    return { recipients: [], reason: 'no_recipient' };
  }

  // resolve：一次解析出「逐渠道决策」。全局性跳过（配置缺失/限速/静默）作用于全部渠道；
  //   渠道级跳过（no_recipient）只影响出站渠道，不影响 inbox。
  async function resolve({ signal, tenantId = signal?.tenant_id || 'system', now = new Date() } = {}) {
    const policy = await loadPolicy({ tenantId });
    if (!policy.configured) return { configured: false, reason: 'delivery_config_missing', policy, decisions: [] };
    if (policy.channels.length === 0) return { configured: true, reason: 'no_channel_enabled', policy, decisions: [] };

    const channels = channelsFor(signal, policy);
    if (channels.length === 0) return { configured: true, reason: 'no_channel_for_severity', policy, decisions: [] };

    const globalSkip = inQuietHours(policy.quietHours, now)
      ? 'quiet_hours'
      : (await overRateLimit(policy.rateLimit, { tenantId, now })) ? 'rate_limited' : null;

    const { recipients, reason: recipientMiss } = recipientsFor(signal, policy, tenantId);
    const decisions = channels.map((channel) => {
      if (globalSkip) return { channel, recipient: null, skip: true, reason: globalSkip };
      if (IN_PLATFORM_CHANNELS.includes(channel)) return { channel, recipient: null, skip: false, reason: null };
      if (recipientMiss) return { channel, recipient: null, skip: true, reason: recipientMiss };
      return { channel, recipient: recipients[0], skip: false, reason: null };
    });
    return { configured: true, reason: null, policy, decisions };
  }

  return { loadPolicy, inQuietHours, overRateLimit, channelsFor, recipientsFor, resolve, ALL_CHANNELS };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/signal/route.test.js`
Expected: PASS（15 passed = loadPolicy 4 + resolve 8 + 平台租户回退 3）

- [ ] **Step 5: 提交**

```powershell
git add src/signal/route.js test/signal/route.test.js
git commit -m "feat(q1-2): 新增 signal/route.js 投递路由与收件人解析（渠道集合来自 config_store，零硬编码默认值）"
```

---

## Task Q1-1: `src/signal/dispatcher.js` —— 投递编排器（水泵）

> 对应契约：`ct-followup`（设计 §4 Q1-1）
> 依赖：Task Q1-2（`route.js`）

**Files:**
- Create: `src/signal/dispatcher.js`
- Test: `test/signal/dispatcher.test.js`

- [ ] **Step 1: 写失败测试**

创建 `test/signal/dispatcher.test.js`：

```js
// test/signal/dispatcher.test.js — 投递编排器（注入替身 query / store / registry，不依赖 PG）
import { describe, it, expect, vi } from 'vitest';
import { createDispatcher } from '../../src/signal/dispatcher.js';

// 极简替身 query：按 SQL 特征分发
// 注意：`/FROM crm\.signal\b/` 的 `\b` 是必需的——否则会把 `crm.signal_delivery` 一并匹配，
//   导致「sent 渠道集合」查询误走 signal 分支（替身形状错误 = 假绿来源之一）。
function fakeQuery({ signals = [], sent = [], counts = {} } = {}) {
  return async (sql, params) => {
    if (/SELECT DISTINCT channel/.test(sql)) {
      return { rows: sent.map((c) => ({ channel: c })) };
    }
    if (/COUNT\(\*\)::int AS c/.test(sql)) {
      return { rows: [{ c: counts[`${params[0]}|${params[1]}`] ?? 0 }] };
    }
    if (/FROM crm\.signal\b/.test(sql)) return { rows: signals };
    return { rows: [] };
  };
}

function fakeStore() {
  const rows = [];
  return { rows, record: vi.fn(async (r) => { rows.push(r); return r; }) };
}

function fakeRouter(decisions, extra = {}) {
  return {
    ALL_CHANNELS: ['inbox', 'email', 'im', 'webhook'],
    resolve: vi.fn(async () => ({ configured: true, reason: null, policy: { channels: ['inbox'] }, decisions, ...extra })),
  };
}

describe('dispatcher 幂等（同一 signal+channel 已 sent 不重投）', () => {
  it('已 sent 的渠道被跳过，registry 不被调用', async () => {
    const registry = { deliver: vi.fn(async () => ({ ok: true })) };
    const store = fakeStore();
    const d = createDispatcher({
      query: fakeQuery({ signals: [{ signal_id: 's1', tenant_id: 't1' }], sent: ['inbox'] }),
      deliveryRegistry: registry,
      deliveryStore: store,
      router: fakeRouter([{ channel: 'inbox', recipient: null, skip: false, reason: null }]),
    });
    const r = await d.pumpOnce({ tenantId: 't1' });
    expect(registry.deliver).not.toHaveBeenCalled();
    expect(store.rows).toHaveLength(0);
    expect(r).toMatchObject({ signals: 1, sent: 0, failed: 0, skipped: 0 });
  });

  it('未 sent 的渠道被投递一次', async () => {
    const registry = { deliver: vi.fn(async () => ({ ok: true })) };
    const store = fakeStore();
    const d = createDispatcher({
      query: fakeQuery({ signals: [{ signal_id: 's2', tenant_id: 't1' }] }),
      deliveryRegistry: registry,
      deliveryStore: store,
      router: fakeRouter([{ channel: 'inbox', recipient: null, skip: false, reason: null }]),
    });
    const r = await d.pumpOnce({ tenantId: 't1' });
    expect(registry.deliver).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ sent: 1 });
  });
});

describe('dispatcher 非静默留痕', () => {
  it('渠道级 skip（no_recipient）→ 落 skipped 行且带 last_error', async () => {
    const registry = { deliver: vi.fn() };
    const store = fakeStore();
    const d = createDispatcher({
      query: fakeQuery({ signals: [{ signal_id: 's3', tenant_id: 't1' }] }),
      deliveryRegistry: registry,
      deliveryStore: store,
      router: fakeRouter([{ channel: 'email', recipient: null, skip: true, reason: 'no_recipient' }]),
    });
    await d.pumpOnce({ tenantId: 't1' });
    expect(registry.deliver).not.toHaveBeenCalled();
    expect(store.rows).toEqual([
      expect.objectContaining({ signal_id: 's3', channel: 'email', status: 'skipped', last_error: 'no_recipient' }),
    ]);
  });

  it('provider 返回 ok:false → 计入 failed（流水由 provider 自行落地，编排器不补记）', async () => {
    const registry = { deliver: vi.fn(async () => ({ ok: false, error: 'smtp_not_configured' })) };
    const store = fakeStore();
    const d = createDispatcher({
      query: fakeQuery({ signals: [{ signal_id: 's4', tenant_id: 't1' }] }),
      deliveryRegistry: registry,
      deliveryStore: store,
      router: fakeRouter([{ channel: 'email', recipient: 'a@b.c', skip: false, reason: null }]),
    });
    const r = await d.pumpOnce({ tenantId: 't1' });
    expect(r.failed).toBe(1);
    expect(store.rows).toHaveLength(0); // 防双记：provider 内部已 record
  });
});

describe('dispatcher 重试上限（retryLimit 来自配置，无配置即 0）', () => {
  it('retryLimit=0 且已有 1 次尝试 → 跳过（不再投递）', async () => {
    const registry = { deliver: vi.fn() };
    const store = fakeStore();
    const d = createDispatcher({
      query: fakeQuery({ signals: [{ signal_id: 's5', tenant_id: 't1' }], counts: { 's5|email': 1 } }),
      deliveryRegistry: registry,
      deliveryStore: store,
      router: fakeRouter([{ channel: 'email', recipient: 'a@b.c', skip: false, reason: null }]),
    });
    const r = await d.pumpOnce({ tenantId: 't1' });
    expect(registry.deliver).not.toHaveBeenCalled();
    expect(r.skipped).toBe(1);
  });

  it('retryLimit=2 且已有 1 次尝试 → 继续投递', async () => {
    const registry = { deliver: vi.fn(async () => ({ ok: true })) };
    const store = fakeStore();
    const d = createDispatcher({
      query: fakeQuery({ signals: [{ signal_id: 's6', tenant_id: 't1' }], counts: { 's6|email': 1 } }),
      deliveryRegistry: registry,
      deliveryStore: store,
      router: fakeRouter([{ channel: 'email', recipient: 'a@b.c', skip: false, reason: null }],
        { policy: { channels: ['email'], retryLimit: 2 } }),
    });
    const r = await d.pumpOnce({ tenantId: 't1' });
    expect(registry.deliver).toHaveBeenCalledTimes(1);
    expect(r.sent).toBe(1);
  });
});

describe('dispatcher 全租户泵（单租户失败不中断其余）', () => {
  it('pumpAllTenants 收集失败项而非抛出', async () => {
    let call = 0;
    const q = async (sql) => {
      if (/SELECT DISTINCT tenant_id/.test(sql)) return { rows: [{ tenant_id: 't1' }, { tenant_id: 't2' }] };
      call += 1;
      if (call === 1) throw new Error('db down');
      return { rows: [] };
    };
    const d = createDispatcher({
      query: q,
      deliveryRegistry: { deliver: vi.fn() },
      deliveryStore: fakeStore(),
      router: fakeRouter([]),
    });
    const r = await d.pumpAllTenants({});
    expect(r.tenants).toBe(2);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0].tenant_id).toBe('t1');
  });

  // ---- D1（设计 §3.1.1 修正，2026-09-16）：泵范围必须含 system ----
  it('D1：候选租户集 SQL 不得排除 system（负向断言，防 D1 回归）', async () => {
    const seen = [];
    const d = createDispatcher({
      query: async (sql) => { seen.push(sql); return { rows: [] }; },
      deliveryRegistry: { deliver: vi.fn() },
      deliveryStore: fakeStore(),
      router: fakeRouter([]),
    });
    await d.pumpAllTenants({});
    const candidateSql = seen.find((s) => /SELECT DISTINCT tenant_id/.test(s));
    expect(candidateSql).toBeTruthy();
    expect(candidateSql).not.toMatch(/tenant_id\s*<>\s*'system'/);
  });

  it('D1：system 租户的 signal 确实被泵（pumpOnce 以 system 调用）', async () => {
    const pumped = [];
    const d = createDispatcher({
      query: async (sql, params) => {
        if (/SELECT DISTINCT tenant_id/.test(sql)) return { rows: [{ tenant_id: 'system' }] };
        if (/SELECT DISTINCT channel/.test(sql)) return { rows: [] };
        if (/FROM crm\.signal\b/.test(sql)) { pumped.push(params[0]); return { rows: [] }; }
        return { rows: [] };
      },
      deliveryRegistry: { deliver: vi.fn() },
      deliveryStore: fakeStore(),
      router: fakeRouter([]),
    });
    const r = await d.pumpAllTenants({});
    expect(pumped).toEqual(['system']);
    expect(r.tenants).toBe(1);
  });

  // ---- D2（设计 §3.1.1 修正）：候选集受时间窗约束，且窗口只收窄、不删行 ----
  it('D2：候选集 SQL 含时间窗谓词，且全程零 DELETE/UPDATE', async () => {
    const seen = [];
    const d = createDispatcher({
      query: async (sql) => { seen.push(sql); return { rows: [] }; },
      deliveryRegistry: { deliver: vi.fn() },
      deliveryStore: fakeStore(),
      router: fakeRouter([]),
      readConfig: async () => ({ value: { max_age_days: 3 } }), // 平台级旋钮
    });
    await d.pumpAllTenants({});
    const candidateSql = seen.find((s) => /SELECT DISTINCT tenant_id/.test(s));
    expect(candidateSql).toMatch(/created_at >= now\(\) - make_interval\(days => \$1\)/);
    expect(seen.some((s) => /DELETE|UPDATE/i.test(s))).toBe(false); // 窗口只收窄候选集，绝不删/迁移行
    expect(await d.resolveWindowDays()).toBe(3);
  });

  it('D2：配置缺省 → 窗口回落到兜底天数（不因配置缺失而泵空/泵满）', async () => {
    const d = createDispatcher({
      query: async () => ({ rows: [] }),
      deliveryRegistry: { deliver: vi.fn() },
      deliveryStore: fakeStore(),
      router: fakeRouter([]),
    });
    expect(await d.resolveWindowDays()).toBe(7); // 无 readConfig 注入 → 兜底值
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/signal/dispatcher.test.js`
Expected: FAIL —`Failed to resolve import "../../src/signal/dispatcher.js"`

- [ ] **Step 3: 写最小实现**

创建 `src/signal/dispatcher.js`：

```js
// src/signal/dispatcher.js — 投递编排器（水泵）
// 设计输入：docs/2026-09-16-full-chain-integration-design.md §3.1
// 存在理由（务必保留本注释，防后人误删）：
//   S1 交付了「投递 provider + 分发器类」（src/signal/delivery/index.js），但**没有任何生产触发点驱动它**
//   —— `createDeliveryRegistry` 在 src/ 下生产调用点为 0，仅被单元测试调用。
//   后果：crm.signal 有 174 行真实数据，而 crm.signal_delivery 恒为 0 行，
//   面板四条 delivery_silent 告警成立（正确防假绿行为，但暴露「造了水管没造水泵」）。
//   本模块即水泵：读 open signal → 经 route 决策 → 调既有 registry.deliver() → 落流水。
// 铁律：
//   ① 幂等：同 (signal_id, channel) 已 sent → 不重投（sentChannels）；
//   ② 重试上限来自配置（policy.retryLimit），编排器零阈值字面量；
//   ③ 不静默：所有 skipped 必带 last_error（no_recipient / quiet_hours / rate_limited / retry_exhausted）；
//   ④ **防双记**：provider 内部已调 deliveryStore.record()，编排器只在「自身判定 skip」时记录；
//   ⑤ **D1（设计 §3.1.1 修正）**：泵范围**含 `system` 平台租户** —— 严禁 `tenant_id <> 'system'`
//      （该写法会让平台级信号永久静默，正是「泵上线但红框不消失」的成因）；
//   ⑥ **D2（设计 §3.1.1 修正）**：候选集受时间窗约束（`make_interval(days => $n)`，来自
//      config_store['signal-dispatch'].max_age_days，缺省 7 天）——窗口**只收窄候选集**，
//      **绝不允许删除或迁移 `crm.signal` 行**（本仓绝对禁 DELETE）。
import { createDeliveryRegistry } from './delivery/index.js';
import { createDeliveryStore } from './delivery/signalDeliveryStore.js';

// D2：窗口缺省值。仅在配置读取不可用时兜底；正常路径来自 config_store（继承「差异化 100% 后台配置化」铁律）
const WINDOW_DAYS_FALLBACK = 7;
const WINDOW_CONFIG_KEY = 'signal-dispatch';

export function createDispatcher({ query, deliveryRegistry, deliveryStore, router, readConfig } = {}) {
  // D2：解析泵窗口（天）。**平台级旋钮**：口径统一由平台租户 `system` 的配置决定，
  //   避免同一批 signal 因租户不同而候选集语义分裂。读不到 → 兜底值（并允许注入以做零 DB 单测）。
  async function resolveWindowDays() {
    if (typeof readConfig !== 'function') return WINDOW_DAYS_FALLBACK;
    try {
      const row = await readConfig(WINDOW_CONFIG_KEY, { tenantId: 'system' });
      const v = row?.value?.max_age_days;
      return Number.isFinite(v) && v > 0 ? v : WINDOW_DAYS_FALLBACK;
    } catch {
      return WINDOW_DAYS_FALLBACK; // 配置读取异常 → 兜底（不阻断泵；异常本身由调用方 trace）
    }
  }

  // 已 sent 渠道集合（幂等依据）。只认 sent —— failed/skipped 允许按重试上限重投。
  async function sentChannels(signal_id) {
    const { rows } = await query(
      `SELECT DISTINCT channel FROM crm.signal_delivery WHERE signal_id=$1 AND status='sent'`,
      [signal_id],
    );
    return new Set((rows || []).map((r) => r.channel));
  }

  // 某渠道已尝试次数（含 failed / skipped 行）
  async function attemptCount(signal_id, channel) {
    const { rows: [r] } = await query(
      `SELECT COUNT(*)::int AS c FROM crm.signal_delivery WHERE signal_id=$1 AND channel=$2`,
      [signal_id, channel],
    );
    return Number(r?.c || 0);
  }

  // 单条 signal 的投递
  async function pumpSignal({ signal, tenantId, now }) {
    const resolved = await router.resolve({ signal, tenantId, now });
    if (!resolved.decisions || resolved.decisions.length === 0) return { sent: 0, failed: 0, skipped: 0 };

    const already = await sentChannels(signal.signal_id);
    const retryLimit = Number.isInteger(resolved.policy?.retryLimit) ? resolved.policy.retryLimit : 0;
    let sent = 0, failed = 0, skipped = 0;

    for (const d of resolved.decisions) {
      if (already.has(d.channel)) continue;              // ① 幂等
      if (d.skip) {                                      // ③ 自身判定 skip → 记录（不静默）
        await deliveryStore.record({
          signal_id: signal.signal_id, tenant_id: tenantId,
          channel: d.channel, status: 'skipped', last_error: d.reason,
        });
        skipped += 1;
        continue;
      }
      const attempts = await attemptCount(signal.signal_id, d.channel);
      if (attempts > retryLimit) {                       // ② 超重试上限 → 放弃（既有 failed 行已留痕）
        await deliveryStore.record({
          signal_id: signal.signal_id, tenant_id: tenantId,
          channel: d.channel, status: 'skipped', last_error: 'retry_exhausted',
        });
        skipped += 1;
        continue;
      }
      // ④ 交给 provider：其内部负责 record(sent/failed)，编排器不补记
      const res = await deliveryRegistry.deliver({ signal, channel: d.channel, store: deliveryStore });
      if (res?.ok && res?.skipped) skipped += 1;
      else if (res?.ok) sent += 1;
      else failed += 1;
    }
    return { sent, failed, skipped };
  }

  // 泵单租户。D2：候选集限定在时间窗内（窗口外 signal 仍留在库中，只是不再被泵）
  async function pumpOnce({ tenantId = 'system', maxSignals = 200, now = new Date(), windowDays } = {}) {
    const days = Number.isFinite(windowDays) ? windowDays : await resolveWindowDays();
    const { rows: signals } = await query(
      `SELECT * FROM crm.signal
        WHERE tenant_id=$1 AND status='open' AND created_at >= now() - make_interval(days => $2)
        ORDER BY created_at ASC LIMIT $3`,
      [tenantId, days, maxSignals],
    );
    const totals = { signals: (signals || []).length, sent: 0, failed: 0, skipped: 0 };
    for (const signal of signals || []) {
      try {
        const r = await pumpSignal({ signal, tenantId, now });
        totals.sent += r.sent; totals.failed += r.failed; totals.skipped += r.skipped;
      } catch (e) {
        totals.failed += 1;
        totals.errors = totals.errors || [];
        totals.errors.push({ signal_id: signal.signal_id, error: String(e?.message || e) });
      }
    }
    return totals;
  }

  // 泵全部租户：单租户失败不中断其余（失败项收集返回，由调用方 emit trace）
  //   D1：**不得排除 `system`** —— 平台级信号同样必须被泵（否则平台告警永久静默）
  async function pumpAllTenants({ maxSignals = 200, now = new Date(), windowDays } = {}) {
    const days = Number.isFinite(windowDays) ? windowDays : await resolveWindowDays();
    const { rows } = await query(
      `SELECT DISTINCT tenant_id FROM crm.signal
        WHERE status='open' AND created_at >= now() - make_interval(days => $1)`,
      [days],
    );
    const totals = { tenants: (rows || []).length, days, sent: 0, failed: 0, skipped: 0, failures: [] };
    for (const { tenant_id } of rows || []) {
      try {
        const r = await pumpOnce({ tenantId: tenant_id, maxSignals, now, windowDays: days });
        totals.sent += r.sent; totals.failed += r.failed; totals.skipped += r.skipped;
      } catch (e) {
        totals.failures.push({ tenant_id, error: String(e?.message || e) });
      }
    }
    return totals;
  }

  return { sentChannels, attemptCount, pumpSignal, pumpOnce, pumpAllTenants, resolveWindowDays };
}
```

> **📌 文件边界（务必遵守）**：`src/signal/dispatcher.js` **只导出 `createDispatcher` 一个函数**，到此结束——**不要**在文件里追加 `createProductionDispatcher` 之类的便捷构造器。理由：生产装配需要 `query`/`pool` 与 `createSignalRouter`，而 `timers.js` 本来就要 import 它们（见 Task Q1-3 Step 3/Step 4）；把装配下沉到本模块会造成 ESM 循环依赖与「两个装配点」的漂移源。本模块保持**纯工厂 + 依赖注入**，才能在 Task Q1-1 用替身做零 DB 单测。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/signal/dispatcher.test.js`
Expected: PASS（11 passed = 幂等 2 + 非静默 2 + 重试上限 2 + 全租户泵 1 + D1 2 + D2 2）

- [ ] **Step 5: 回归既有投递测试（确认未破坏 provider 契约）**

Run: `npx vitest run test/signal/delivery.test.js`
Expected: PASS（既有 7 用例全绿，编排器不改变 provider 行为）

- [ ] **Step 6: 提交**

```powershell
git add src/signal/dispatcher.js test/signal/dispatcher.test.js
git commit -m "feat(q1-1): 新增 signal/dispatcher.js 投递编排器（泵 open signal，幂等+重试上限+非静默留痕）"
```

---

## Task Q1-3: 注册定时器⑰ `signal-dispatch`

> 对应契约：`ct-followup`（设计 §4 Q1-3）
> 依赖：Task Q1-1（`dispatcher.js`）

**Files:**
- Modify: `src/scheduler/timers.js`（import 区 `:18` 之后；定时器⑯ 之后；文件尾部 `return timers.size` 之前）
- Modify: `test/timers.test.js:26`（`EXPECTED_TIMERS` 16 → 17）与 `:20-25` 注释

- [ ] **Step 1: 写失败测试（先把期望值改到 17）**

修改 `test/timers.test.js:26`：

```js
const EXPECTED_TIMERS = 17;
```

并更新 `:20-25` 的清单注释，追加一行：

```js
//   / signal-dispatch（全链集成 Q1-3 信号投递编排泵，2026-09-16）
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/timers.test.js`
Expected: FAIL —`expected 16 to be 17`

- [ ] **Step 3: 加 import**

在 `src/scheduler/timers.js:18` 之后追加：

```js
import { createDispatcher } from '../signal/dispatcher.js';
import { createDeliveryRegistry } from '../signal/delivery/index.js';
import { createDeliveryStore } from '../signal/delivery/signalDeliveryStore.js';
import { createSignalRouter } from '../signal/route.js';
```

> 注：`readConfig` **已在 `src/scheduler/timers.js:15` 导入**（`import { readConfig } from '../config/configStore.js'`），本节**无需重复导入**——直接透传给 `createDispatcher` 即可。

- [ ] **Step 4: 注册定时器⑰**

在 `src/scheduler/timers.js` 的定时器⑯ 代码块之后、`return timers.size;` 之前插入：

```js
  // ⑰ 全链集成 Q1-3 信号投递编排（泵 open signal → 四渠道投递 → crm.signal_delivery 流水）；每 5 分钟，受 VITEST 护栏
  //   存在的理由：S1 只交付了 provider，无生产驱动点 → signal_delivery 恒 0 行。本定时器即「驱动它的进程」。
  //   装配集中在此（timers.js 本就有 query/pool），dispatcher.js 保持纯工厂便于注入替身测试。
  const signalDispatchIntervalMs = Number(process.env.SIGNAL_DISPATCH_MS || 300000);
  const runSignalDispatch = () => {
    if (process.env.VITEST) return; // 测试隔离护栏
    const dispatcher = createDispatcher({
      query,
      deliveryRegistry: createDeliveryRegistry({}),
      deliveryStore: createDeliveryStore(pool),
      router: createSignalRouter({ query }),
      readConfig, // D2：窗口来自 config_store['signal-dispatch'].max_age_days（platform 口径）
    });
    dispatcher.pumpAllTenants()
      .then((r) => {
        if (r.sent || r.failed || r.skipped) emit('trace', 'signal-dispatch', r);
        for (const f of r.failures) {
          emit('trace', 'signal-dispatch-tenant-failed', f);
          recordFailure('signal-dispatch-tenant-failed', new Error(f.error));
        }
      })
      .catch((err) => {
        emit('trace', 'signal-dispatch-failed', { error: String(err?.message || err) });
        recordFailure('signal-dispatch-failed', err);
      });
  };
  const signalDispatchTimer = setInterval(runSignalDispatch, signalDispatchIntervalMs);
  timers.set('signal-dispatch', { handle: signalDispatchTimer, intervalMs: signalDispatchIntervalMs, kind: 'rule', registeredAt: now });
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run test/timers.test.js`
Expected: PASS（5 passed；`EXPECTED_TIMERS` = 17；VITEST 护栏下 `signal-dispatch` 不实际执行泵）

- [ ] **Step 6: 提交**

```powershell
git add src/scheduler/timers.js test/timers.test.js
git commit -m "feat(q1-3): 注册定时器17 signal-dispatch（信号投递编排泵，SIGNAL_DISPATCH_MS 默认5分钟），EXPECTED_TIMERS 16->17"
```

---

## Task Q1-4: 修正假绿判据 —— `enabledChannels` 从配置读取

> 对应契约：`ct-retro-decision`（设计 §4 Q1-4）
> 依赖：无（可与 Q1-2 并行；但**必须在 Q1-1/Q1-3 之后才能看到正确结果**——见 Step 7 说明）

**Files:**
- Modify: `src/monitor/signalMetrics.js:11`（删 `DEFAULT_CHANNELS`）、`:69-91`（`detectNegativePredicates` 判据 A 段）
- Test: `test/monitor/signalMetrics.test.js`（**追加**新用例，**不改动**既有 `:66-88` 的既有用例）

- [ ] **Step 1: 写失败测试（追加到 `test/monitor/signalMetrics.test.js` 文件末尾）**

```js
describe('detectNegativePredicates 配置驱动（Q1-4：消除 enabledChannels 假前提）', () => {
  it('租户无 signal-delivery 配置 → 不产生 delivery_silent（且不回退为「全开」）', async () => {
    const H = `q14-${randomUUID()}`;
    // 造一条信号，使判据 A 的前置（signalCount>0）成立
    await query(
      `INSERT INTO crm.signal (signal_id, tenant_id, source, kind, severity, target_role, status, created_at)
       VALUES ($1,$2,'rule-scan','q14-probe','medium','sales','open',now())`,
      [`sig-${randomUUID()}`, H],
    );
    const alerts = await detectNegativePredicates({ tenantId: H, since: new Date(Date.now() - 3600 * 1000) });
    const silent = alerts.filter((a) => a.type === 'delivery_silent');
    expect(silent).toEqual([]);   // 配置缺失 → 判据 A 不触发（而非按 DEFAULT_CHANNELS 全开误报）
    await query(`DELETE FROM crm.signal WHERE tenant_id=$1`, [H]);
  });

  it('配置只开 inbox → 只对 inbox 判 delivery_silent', async () => {
    const H2 = `q14b-${randomUUID()}`;
    await query(
      `INSERT INTO crm.signal (signal_id, tenant_id, source, kind, severity, target_role, status, created_at)
       VALUES ($1,$2,'rule-scan','q14-probe','medium','sales','open',now())`,
      [`sig-${randomUUID()}`, H2],
    );
    await query(
      `INSERT INTO crm.config_store (tenant_id, key, value, updated_by, updated_at)
       VALUES ($1,'signal-delivery',$2::jsonb,'test',now())
       ON CONFLICT (tenant_id, key) DO UPDATE SET value=$2::jsonb, updated_at=now()`,
      [H2, JSON.stringify({ channels: { inbox: 'on', email: 'off', im: 'off', webhook: 'off' } })],
    );
    const alerts = await detectNegativePredicates({ tenantId: H2, since: new Date(Date.now() - 3600 * 1000) });
    const silent = alerts.filter((a) => a.type === 'delivery_silent');
    expect(silent.map((a) => a.channel)).toEqual(['inbox']);
    await query(`DELETE FROM crm.signal WHERE tenant_id=$1`, [H2]);
    await query(`DELETE FROM crm.config_store WHERE tenant_id=$1 AND key='signal-delivery'`, [H2]);
  });

  it('配置读取抛错 → 不产生 delivery_silent 且不抛出（「读取失败」与「配置缺失」分别留痕）', async () => {
    const H3 = `q14c-${randomUUID()}`;
    await query(
      `INSERT INTO crm.signal (signal_id, tenant_id, source, kind, severity, target_role, status, created_at)
       VALUES ($1,$2,'rule-scan','q14-probe','medium','sales','open',now())`,
      [`sig-${randomUUID()}`, H3],
    );
    const alerts = await detectNegativePredicates({
      tenantId: H3,
      since: new Date(Date.now() - 3600 * 1000),
      readConfigFn: async () => { throw new Error('db down'); },
    });
    // 读取失败 → 判据 A 不触发（不得伪报渠道沉默），但**不得把异常吞成「配置缺失」**：
    //   两者 trace 名不同（read-failed / config-missing），由代码断言 + 巡检核对。
    expect(alerts.filter((a) => a.type === 'delivery_silent')).toEqual([]);
    await query(`DELETE FROM crm.signal WHERE tenant_id=$1`, [H3]);
  });
});
```

> **注**：既有 `:66-88` 的两个用例（`enabledChannels` 显式传入 / 不传时验 `gen_silent`）**一概不改**——本实现保证：判据 B（`gen_silent`）与渠道配置无关，函数**绝不因配置缺失而提前 return**。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/monitor/signalMetrics.test.js`
Expected: FAIL ——「租户无配置」用例得到 4 条 `delivery_silent`（因默认 `DEFAULT_CHANNELS` 全开）

- [ ] **Step 3: 删掉硬编码默认渠道**

`src/monitor/signalMetrics.js:11` 删除：

```js
const DEFAULT_CHANNELS = ['inbox', 'email', 'im', 'webhook'];
```

并在文件顶部 import 区追加（替换原 `:11` 位置）：

```js
import { readConfig } from '../config/configStore.js';
```

- [ ] **Step 4: 改写 `detectNegativePredicates` 的判据 A 段**

把 `src/monitor/signalMetrics.js:69-91` 整段替换为：

```js
// detectNegativePredicates({ tenantId, since, enabledChannels })
// → [{type:'delivery_silent',channel,tenant_id}] | [{type:'gen_silent',tenant_id,fired}]
//
// 判据 A（delivery_silent）：渠道配置为 on 但窗口内零投递行。
//   ⚠ Q1-4 修正（2026-09-16，全链集成设计 §3.3）：原实现 `enabledChannels = DEFAULT_CHANNELS`
//   （四渠道硬编码全开）且 timers.js:604 调用时未传参 → **面板上「渠道『email』已开启」是判据自己
//   注入的假前提**（一个防假绿的判据自己制造假绿）。现改为从 config_store['signal-delivery'].channels
//   读取真实启用集合；**读不到配置 → 判据 A 不触发并 emit trace**（不退回「全开」）。
//   显式传 enabledChannels 时仍按传入值工作（供纯逻辑单测，保持向后兼容）。
//
// 判据 B（gen_silent）：event-trigger 命中但无内部信号生成 = 摄取→信号桥静默。
//   ⚠ 与渠道配置无关 —— 故本函数**绝不因配置缺失而提前 return**，否则判据 B 会被连带跳过
//   （既有测试 test/monitor/signalMetrics.test.js:84 会转红，且真实静默会被漏报）。
export async function detectNegativePredicates({ tenantId, since, enabledChannels = null, readConfigFn = readConfig }) {
  const sinceTs = since instanceof Date ? since : new Date(since);
  const { rows: [sg] } = await query(
    `SELECT COUNT(*) AS c FROM crm.signal WHERE tenant_id=$1 AND created_at >= $2`,
    [tenantId, sinceTs]
  );
  const signalCount = Number(sg?.c || 0);
  const alerts = [];

  // ── 判据 A：渠道集合解析（配置驱动优先，显式参数其次）──
  let channels = enabledChannels;
  if (channels === null) {
    let cfg = null;
    let readFailed = null;
    try {
      const row = await readConfigFn('signal-delivery', { tenantId });
      cfg = row?.value || null;
    } catch (e) {
      readFailed = String(e?.message || e);
    }
    if (readFailed) {
      // ① **读取失败 ≠ 配置缺失**：分别留痕。否则 DB 故障会被误读成「客户还没配」，
      //    把一个真故障降级成一个"待配置项"（本项目最忌讳的误归因）。
      emit('trace', 'signal-observability-config-read-failed', { tenant_id: tenantId, error: readFailed });
      channels = [];
    } else if (!cfg || !cfg.channels || typeof cfg.channels !== 'object') {
      // ② 读到了但配置缺失 → 不判（留痕），**绝不**回退为默认全开（那正是本次修正消除的假前提）
      emit('trace', 'signal-observability-config-missing', { tenant_id: tenantId });
      channels = [];
    } else {
      channels = Object.entries(cfg.channels)
        .filter(([, v]) => v === 'on' || v === true)
        .map(([k]) => k);
    }
  }

  if (signalCount > 0 && channels.length > 0) {
    const { rows: ch } = await query(
      `SELECT channel, COUNT(*) AS c FROM crm.signal_delivery
       WHERE tenant_id=$1 AND created_at >= $2 GROUP BY channel`,
      [tenantId, sinceTs]
    );
    const delivered = new Set((ch || []).map(r => r.channel));
    for (const name of channels) {
      if (!delivered.has(name)) alerts.push({ type: 'delivery_silent', channel: name, tenant_id: tenantId });
    }
  }

  // ── 判据 B：与渠道配置无关，始终执行 ──
  const { rows: [fired] } = await query(
    `SELECT COUNT(*) AS c FROM crm.signal
     WHERE tenant_id=$1 AND source='event-trigger' AND created_at >= $2`,
    [tenantId, sinceTs]
  );
  const firedCount = Number(fired?.c || 0);
  if (firedCount > 0) {
    const { rows: [landed] } = await query(
      `SELECT COUNT(*) AS c FROM crm.signal
       WHERE tenant_id=$1 AND source IN ('rule-scan','agent-research','external') AND created_at >= $2`,
      [tenantId, sinceTs]
    );
    if (Number(landed?.c || 0) === 0) alerts.push({ type: 'gen_silent', tenant_id: tenantId, fired: firedCount });
  }
  return alerts;
}
```

- [ ] **Step 5: 运行测试确认通过（含既有用例全绿）**

Run: `npx vitest run test/monitor/signalMetrics.test.js`
Expected: PASS（既有 5 用例 + 新增 3 用例 = 8 全绿）。**重点核对**：`:76` / `:84` 两个**不传 `enabledChannels`** 的既有调用点必须仍绿——它们走「读配置 → 无配置 → `channels=[]` → 判据 A 跳过，判据 B 照跑」路径，**证明判据 B 未被配置缺失连带跳过**。`:68` 显式传入 `enabledChannels` 的用例走向后兼容分支，亦不变。

- [ ] **Step 6: 运行观测链相关回归**

Run: `npx vitest run test/signalObservabilityScan.test.js test/http/signalMetrics.test.js`
Expected: PASS

- [ ] **Step 7: ⚠ 上线顺序说明（写进提交信息，避免误判）**

> 本 Task 单独上线后，面板上四条 `delivery_silent` 会变为「无告警」。**这不是链路修好了**，而是判据不再携带假前提。真实结论以 **Q1-5 判据①** 为准：`crm.signal_delivery` 出现 `sent` 行才算通。**Q1-4 与 Q1-1/Q1-3 必须同批上线**，否则运维会看到「全绿但链路仍断」的假绿。

- [ ] **Step 8: 提交**

```powershell
git add src/monitor/signalMetrics.js test/monitor/signalMetrics.test.js
git commit -m "fix(q1-4): detectNegativePredicates 的 enabledChannels 改从 config_store 读取，消除判据自带假前提（判据B不受影响）"
```

---

## Task Q1-5: 出口真库端到端验收（判据①）

> 对应契约：`ct-followup`（设计 §4 Q1-5）
> 依赖：Task Q1-2 / Q1-1 / Q1-3 / Q1-4

**Files:**
- Test: `test/signal/dispatch-e2e.test.js`

- [ ] **Step 1: 写真库端到端测试（**不走定时器**，直接装配泵，避免时间依赖）**

创建 `test/signal/dispatch-e2e.test.js`：

```js
// test/signal/dispatch-e2e.test.js — 出口真库端到端（判据①：signal → 投递 → crm.signal_delivery 出现 sent 行）
// 依赖真库 crm_native_test；每个租户自建自清（tenant 前缀 e2e-，跨会话并发安全）
import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { query, pool } from '../src/db.js';
import { createDispatcher } from '../src/signal/dispatcher.js';
import { createDeliveryRegistry } from '../src/signal/delivery/index.js';
import { createDeliveryStore } from '../src/signal/delivery/signalDeliveryStore.js';
import { createSignalRouter } from '../src/signal/route.js';
import { readConfig } from '../src/config/configStore.js';
import { detectNegativePredicates } from '../src/monitor/signalMetrics.js';

const T = `e2e-${randomUUID()}`;
const createdSignals = [];

function buildDispatcher() {
  return createDispatcher({
    query,
    deliveryRegistry: createDeliveryRegistry({}),
    deliveryStore: createDeliveryStore(pool),
    router: createSignalRouter({ query }),
    readConfig, // D2：窗口解析走 config_store（真库路径必须装配，否则只能走兜底值）
  });
}

afterAll(async () => {
  await query(`DELETE FROM crm.signal_delivery WHERE tenant_id=$1`, [T]);
  await query(`DELETE FROM crm.signal WHERE tenant_id=$1`, [T]);
  await query(`DELETE FROM crm.config_store WHERE tenant_id=$1`, [T]);
});

describe('判据①：出口链路真库端到端', () => {
  it('配置开 inbox → 泵一次后 crm.signal_delivery 出现 sent 行，且判据A对该渠道不再触发', async () => {
    // 1) 造配置：只开 inbox（inbox 恒可用，无需外部凭据 → 真库可稳定复现）
    await query(
      `INSERT INTO crm.config_store (tenant_id, key, value, updated_by, updated_at)
       VALUES ($1,'signal-delivery',$2::jsonb,'e2e',now())
       ON CONFLICT (tenant_id, key) DO UPDATE SET value=$2::jsonb, updated_at=now()`,
      [T, JSON.stringify({ channels: { inbox: 'on', email: 'off', im: 'off', webhook: 'off' }, route: { medium: ['inbox'] } })],
    );
    // 2) 造一条 open 信号
    const sid = `sig-${randomUUID()}`;
    createdSignals.push(sid);
    await query(
      `INSERT INTO crm.signal (signal_id, tenant_id, source, kind, severity, target_role, status, created_at)
       VALUES ($1,$2,'rule-scan','e2e-probe','medium','sales','open',now())`,
      [sid, T],
    );
    // 3) 泵
    const r = await buildDispatcher().pumpOnce({ tenantId: T });
    expect(r.signals).toBeGreaterThanOrEqual(1);
    expect(r.sent).toBeGreaterThanOrEqual(1);

    // 4) 判据①：sent 行存在且 delivered_at 非空
    const { rows } = await query(
      `SELECT channel, status, delivered_at FROM crm.signal_delivery
       WHERE tenant_id=$1 AND signal_id=$2 AND status='sent'`,
      [T, sid],
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].delivered_at).not.toBeNull();

    // 5) 判据A：已投递渠道不再报 delivery_silent
    const alerts = await detectNegativePredicates({ tenantId: T, since: new Date(Date.now() - 3600 * 1000) });
    const silent = alerts.filter((a) => a.type === 'delivery_silent').map((a) => a.channel);
    expect(silent).not.toContain('inbox');
  });

  it('幂等：连跑两次不产生重复 sent 行', async () => {
    const before = await query(
      `SELECT COUNT(*)::int AS c FROM crm.signal_delivery WHERE tenant_id=$1 AND status='sent'`, [T]);
    await buildDispatcher().pumpOnce({ tenantId: T });
    const after = await query(
      `SELECT COUNT(*)::int AS c FROM crm.signal_delivery WHERE tenant_id=$1 AND status='sent'`, [T]);
    expect(after.rows[0].c).toBe(before.rows[0].c);
  });

  it('负向 N2：收件人解析不到 → 落 skipped 行且 last_error=no_recipient', async () => {
    const T2 = `e2e-${randomUUID()}`;
    await query(
      `INSERT INTO crm.config_store (tenant_id, key, value, updated_by, updated_at)
       VALUES ($1,'signal-delivery',$2::jsonb,'e2e',now())`,
      [T2, JSON.stringify({ channels: { email: 'on' }, route: { medium: ['email'] }, role_recipients: {} })],
    );
    await query(
      `INSERT INTO crm.signal (signal_id, tenant_id, source, kind, severity, target_role, status, created_at)
       VALUES ($1,$2,'rule-scan','e2e-probe','medium','sales','open',now())`,
      [`sig-${randomUUID()}`, T2],
    );
    await buildDispatcher().pumpOnce({ tenantId: T2 });
    const { rows } = await query(
      `SELECT status, last_error FROM crm.signal_delivery WHERE tenant_id=$1 AND channel='email'`, [T2]);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]).toMatchObject({ status: 'skipped', last_error: 'no_recipient' });
    await query(`DELETE FROM crm.signal_delivery WHERE tenant_id=$1`, [T2]);
    await query(`DELETE FROM crm.signal WHERE tenant_id=$1`, [T2]);
    await query(`DELETE FROM crm.config_store WHERE tenant_id=$1`, [T2]);
  });

  // ---- D1（设计 §3.1.1 修正）：平台租户 system 的出口路径必须真实可跑 ----
  it('负向 N8：tenant_id=system 的 signal 可被泵并落 sent 行（平台信号不得静默）', async () => {
    const sid = `sig-${randomUUID()}`;
    const kk = 'e2e-probe-system';
    await query(
      `INSERT INTO crm.config_store (tenant_id, key, value, updated_by, updated_at)
       VALUES ('system','signal-delivery',$1::jsonb,'e2e',now())
       ON CONFLICT (tenant_id, key) DO UPDATE SET value=$1::jsonb, updated_at=now()`,
      [JSON.stringify({ channels: { inbox: 'on', email: 'off', im: 'off', webhook: 'off' }, route: { medium: ['inbox'] } })],
    );
    await query(
      `INSERT INTO crm.signal (signal_id, tenant_id, source, kind, severity, target_role, status, created_at)
       VALUES ($1,'system','rule-scan',$2,'medium','sales','open',now())`,
      [sid, kk],
    );
    try {
      const r = await buildDispatcher().pumpOnce({ tenantId: 'system' });
      expect(r.signals).toBeGreaterThanOrEqual(1);
      expect(r.sent).toBeGreaterThanOrEqual(1);
      const { rows } = await query(
        `SELECT status, delivered_at FROM crm.signal_delivery
          WHERE tenant_id='system' AND signal_id=$1 AND status='sent'`, [sid]);
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(rows[0].delivered_at).not.toBeNull();
    } finally {
      await query(`DELETE FROM crm.signal_delivery WHERE tenant_id='system' AND signal_id=$1`, [sid]);
      await query(`DELETE FROM crm.signal WHERE tenant_id='system' AND signal_id=$1`, [sid]);
      await query(`DELETE FROM crm.config_store WHERE tenant_id='system' AND key='signal-delivery' AND updated_by='e2e'`);
    }
  });

  // ---- D2（设计 §3.1.1 修正）：窗口只收窄候选集，绝不删/迁移行 ----
  it('负向 N9：窗口外的 open signal 不被泵，但其行仍在库（零 DELETE）', async () => {
    const T3 = `e2e-${randomUUID()}`;
    const oldSid = `sig-${randomUUID()}`;
    await query(
      `INSERT INTO crm.config_store (tenant_id, key, value, updated_by, updated_at)
       VALUES ($1,'signal-delivery',$2::jsonb,'e2e',now())`,
      [T3, JSON.stringify({ channels: { inbox: 'on' }, route: { medium: ['inbox'] } })],
    );
    await query(
      `INSERT INTO crm.signal (signal_id, tenant_id, source, kind, severity, target_role, status, created_at)
       VALUES ($1,$2,'rule-scan','e2e-probe-old','medium','sales','open', now() - interval '30 days')`,
      [oldSid, T3],
    );
    try {
      const r = await buildDispatcher().pumpOnce({ tenantId: T3, windowDays: 7 });
      expect(r.signals).toBe(0); // 窗口外 → 不在候选集
      const { rows: s } = await query(
        `SELECT status FROM crm.signal WHERE tenant_id=$1 AND signal_id=$2`, [T3, oldSid]);
      expect(s).toHaveLength(1);            // 行仍在（窗口不删行）
      expect(s[0].status).toBe('open');      // 状态未迁移
      const { rows: d } = await query(
        `SELECT count(*)::int AS c FROM crm.signal_delivery WHERE tenant_id=$1 AND signal_id=$2`, [T3, oldSid]);
      expect(d[0].c).toBe(0);                // 未投递
    } finally {
      await query(`DELETE FROM crm.signal_delivery WHERE tenant_id=$1`, [T3]);
      await query(`DELETE FROM crm.signal WHERE tenant_id=$1`, [T3]);
      await query(`DELETE FROM crm.config_store WHERE tenant_id=$1`, [T3]);
    }
  });
});
```

> **⚠ 为何 N8 用 `pumpOnce({tenantId:'system'})` 而**不**在真库跑 `pumpAllTenants`**：`pumpAllTenants` 会泵走 `crm_native_test` 中**其它租户的全部遗留 open signal**，属跨测试污染（违反本仓「共享测试库隔离」纪律）。其「候选集含 `system` 且不含 `tenant_id <> 'system'`」的语义由 **Task Q1-1 单测的负向断言**守住（零 DB、可复跑）。本节只证明 **system 的端到端出口路径真实可跑**。
```

- [ ] **Step 2: 运行测试**

Run: `npx vitest run test/signal/dispatch-e2e.test.js`
Expected: PASS（5 passed = 判据① 1 + 幂等 1 + N2 收件人缺失 1 + N8 platform 1 + N9 窗口 1）。若 `sent` 为 0：先确认租户配置已落库（Step 1 第 1 段）、再确认 `route.loadPolicy` 读到的 `value.channels.inbox === 'on'`。

- [ ] **Step 3: 落验收报告（真库取证）**

把以下两条查询的真实输出写入新文件 `docs/2026-09-16-q1-export-acceptance.md`（**只填实跑结果，不得编造数字**）：

```sql
-- 判据① 出口
SELECT tenant_id, channel, status, count(*)
  FROM crm.signal_delivery
 WHERE created_at >= now() - interval '24 hours'
 GROUP BY 1,2,3 ORDER BY 1,2,3;

-- 面板四红框是否仍在（配置缺失时应给出 signal-observability-config-missing trace）
SELECT tenant_id, count(*) FROM crm.signal WHERE status='open' GROUP BY 1;
```

- [ ] **Step 4: 提交**

```powershell
git add test/signal/dispatch-e2e.test.js docs/2026-09-16-q1-export-acceptance.md
git commit -m "test(q1-5): 出口真库端到端验收（判据1：signal_delivery 真 sent 行 + 幂等 + N2 收件人缺失留痕）"
```

---

## 契约自检（每个 Task 完成后执行）

```powershell
node scripts/validate-contract.mjs docs/2026-09-16-full-chain-integration-design.md --registry src/agent/agentSpec.js
```

Expected: `{"valid": true, "errors": []}`（exit 0）。本计划的 5 个 Task 共对应 5 个已批准的 `contract-yaml` 块，**不新增、不改写契约**。

---

## Self-Review（写完计划后的自查，已完成）

**1. Spec coverage（设计 §4 Q1-1…Q1-5 → 任务映射）**

| 设计任务 | 本计划任务 | 覆盖 |
| --- | --- | --- |
| Q1-1 投递编排器 | Task Q1-1 | ✅ |
| Q1-2 路由与收件人解析 | Task Q1-2 | ✅ |
| Q1-3 定时器⑰ | Task Q1-3 | ✅ |
| Q1-4 假绿判据修正 | Task Q1-4 | ✅ |
| Q1-5 出口真库 e2e | Task Q1-5 | ✅ |
| **D1** 泵含 `system` + platform 收件人回退 | Q1-1 / Q1-2 / Q1-5（N8）+ 计划头 R4 | ✅ |
| **D2** 候选集时间窗（零 DDL） | Q1-1 / Q1-3 / Q1-5（N9）+ 计划头 R5 | ✅ |

**2. Placeholder scan**：全文无 TBD / TODO / 「稍后实现」/「类似 Task N」/ 空实现。（初稿曾在 Task Q1-1 尾部留过一段 `createProductionDispatcher` 占位骨架——已删除，改为显式的**文件边界约定**：`dispatcher.js` 只导出 `createDispatcher`，生产装配下沉到 `timers.js`。另：初稿的 `fakeQuery` 用 `/FROM crm\.signal WHERE/`，在新 SQL 有多行缩进后会**失配**——已改为 `/FROM crm\.signal\b/` 并调整分支顺序，避免「替身形状错误」这类假绿。）

**3. Type consistency**

| 接口 | 定义处 | 使用处 | 一致 |
| --- | --- | --- | --- |
| `createSignalRouter({readConfig, query})` | Task Q1-2 | Q1-1 测试、Q1-3 装配、Q1-5 | ✅ |
| `router.resolve({signal, tenantId, now}) → {configured, reason, policy, decisions[]}` | Task Q1-2 | Task Q1-1 `pumpSignal` | ✅ |
| `policy.retryLimit` | Task Q1-2 `loadPolicy` | Task Q1-1 `pumpSignal` | ✅ |
| `recipientsFor(signal, policy, tenantId)`（**D1 新增第 3 参**） | Task Q1-2 | Q1-2 `resolve` | ✅ |
| `decision = {channel, recipient, skip, reason}` | Task Q1-2 `resolve` | Task Q1-1 `pumpSignal`、Q1-5 | ✅ |
| `createDispatcher({query, deliveryRegistry, deliveryStore, router, readConfig})`（**D2 新增 `readConfig`**） | Task Q1-1 | Q1-3 装配、Q1-5 `buildDispatcher` | ✅ |
| `resolveWindowDays() → number`（**D2**） | Task Q1-1 | Q1-1 测试、Q1-5 | ✅ |
| `pumpOnce({tenantId,maxSignals,now,windowDays}) → {signals,sent,failed,skipped}` | Task Q1-1 | Q1-3（经 `pumpAllTenants`）、Q1-5 | ✅ |
| `pumpAllTenants({maxSignals,now,windowDays}) → {tenants,days,sent,failed,skipped,failures[]}` | Task Q1-1 | Task Q1-3 定时器 | ✅ |
| `deliveryStore.record({signal_id,tenant_id,channel,status,last_error})` | 既有 `signalDeliveryStore.js:7` | Task Q1-1 | ✅ |

**4. 计划期发现的 1 项设计缺口 —— ✅ 已裁决并落库（原「⚠ 待确认」）**

| 缺口 | 裁决 | 落点 |
| --- | --- | --- |
| `pumpAllTenants` 排除 `system`，而定时器只调它 → **平台级信号永不被泵**（截图红框若属 `system`，Q1 上线后不会消失） | **用户选定方案 A**：泵含 `system`；收件人回退 `role_recipients.platform` | 设计 v1.1 §3.1.1 / §3.2 / §8.3；本计划 Q1-1 / Q1-2 / Q1-5（N8）；红线 **R4** |
| 泵候选集单调增长（`status='open'` 无时间窗、投递后不迁移） | **模型保守裁决**：加时间窗（零 DDL）；**否决**改表加 `delivered_at` / 状态迁移（须复评全部 `status='open'` 读取点） | 设计 v1.1 §3.1.1 / §8.3；本计划 Q1-1 / Q1-3 / Q1-5（N9）；红线 **R5** |

---

## 后续计划（不在本文件范围）

| 计划文件 | 内容 | 状态 |
| --- | --- | --- |
| `2026-09-16-full-chain-q2-ingress-wiring.md` | Q2-1…Q2-5（线 A 接线 + generic-rest） | 待编写 |
| `2026-09-16-full-chain-q3-writeback-gate.md` | Q3-1…Q3-4 + Q4-1（回写 + `exportGate` + 端到端取证） | 待编写 |

---

## 执行完成记录（2026-09-16）

**验收报告**：`docs/2026-09-16-q1-export-acceptance.md`（含真库受控探针原始输出）

### 实跑结果（与计划预期对照）

| Task | 计划预期 | 实跑 | 差异原因 |
| --- | --- | --- | --- |
| Q1-2 `route.js` | 15 passed | **16 passed** | +1：P-2「读取失败 ≠ 配置缺失」用例 |
| Q1-1 `dispatcher.js` | 11 passed | **13 passed** | +2：P-5 空转可归因用例 |
| Q1-3 定时器⑰ | 5 passed，`EXPECTED_TIMERS`=17 | **一致** | — |
| Q1-4 判据修正 | 8 passed | **8 passed** | 与预期一致（既有 5 + 新增 3） |
| Q1-1 Step 5 回归 | `test/signal/delivery.test.js` 7 passed | **5 passed** | 计划预期值失准（该文件实为 5 例），非缺陷 |
| Q1-5 真库 e2e | 5 passed | **6 passed** | +1：P-5 真库空转归因用例 |

### 执行期修正（P-1…P-6）

| 编号 | 缺陷与处置 | 影响面 |
| --- | --- | --- |
| **P-1** | `import { readConfig, query } from '../config/configStore.js'` —— `configStore.js` **不导出 `query`**（仅从 `../db.js` 引入自用）。ESM 引用不存在的具名导出 = **链接期报错、整模块无法加载**。改为 `query` 自 `../db.js` 引入作默认值 | **阻断级**。另：原写法默认 `undefined` → `overRateLimit` 直接返回 false → **限速闸静默失效**（fail-open），修复后默认生效 |
| **P-2** | `.catch(() => null)` 把「DB 读取失败」压成「配置缺失」（真故障降级成"待配置项"）。拆为 `delivery_config_read_failed` / `delivery_config_missing` | Q1-2 `loadPolicy`；+1 用例 |
| **P-3** | 工厂名 `createSignalRouter` 与既有 `src/signal/router.js` 同名导出，路径仅差一字符（`router.js`/`route.js`）→ 同名漂移陷阱。更名 **`createDeliveryRouter`** | Q1-2 / Q1-3 / Q1-5 三处引用 |
| **P-4** | 计划原文 import 的 `createDeliveryRegistry` / `createDeliveryStore` 在最终代码中**均未使用**（装配按计划下沉 `timers.js`）。删除 | `dispatcher.js`（保持零副作用导入） |
| **P-5** | 泵空转**完全不可见**（`sent/failed/skipped` 全 0 → 不 emit 任何 trace）。`pumpOnce`/`pumpAllTenants` 增 `idle: {reason → 条数}`，定时器 emit `signal-dispatch-idle` | **真实库实测证明该风险已兑现**（配置 0 行）；+2 用例 |
| **P-6** | e2e 导入 `'../src/db.js'`，而文件位于 `test/signal/`（应 `'../../src/db.js'`） | Q1-5 |

### 计划步骤的盲点（已修正并暴露真实问题）

**Q1-4 Step 6 的命令路径 `test/signalObservabilityScan.test.js` 不存在**（实际在 `test/monitor/`）→ 该命令实际**只跑了 1 个文件**，故"Expected: PASS"是假结论。按正确路径复跑后暴露 **2 处真实回归**：

- `test/http/signalMetrics.test.js`（`src/http/signalMetricsRouter.js:17` 是**第三个生产调用点**，计划只盘点了 2 个测试调用点）
- `test/monitor/signalObservabilityScan.test.js`

二者**编码的正是被消除的假前提**（"无配置也按四渠道全开报警"）。处置：**只补前置条件（为测试租户写入渠道配置），断言一字未改**。

### 阻塞级遗留（须用户决策，模型不得自行写业务配置）

**R-A**：`crm_native` 中 `signal-delivery` 配置 **0 行** → Q1 上线后生产口径**判据①不成立**，面板转绿属"未开启渠道"而非"已送达"。配置写入属第 0 闸管辖，需显式决策（租户 / 渠道 / 收件人 / 静默时段 / 限速）。

其余残留 **R-B ~ R-E** 见验收报告 §6（泵的配置读放大 419 次/周期；观测巡检仍排除 `system` 与 D1 不对称；`recipient` 未透传 provider；面板无"未配置"状态位）。

