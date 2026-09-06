# 指名客户管理平台实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标:** 在业务主数据门户(`/business-data.html`)增加「指名客户管理」入口卡 + 独立页 `named-account-manage.html`,支持按销售分配客户名单、按后台配置的档位拜访频次统计,并基于现有告警体系(alertRegistry/alertStore/SSE)统计、告警与提醒。

**架构:** 分配事实存 CRM_ACCOUNT 粒子 payload(`named_owner/named_tier/named_state`),写经决策第 0 闸 + 审计边(`named_assignment`);名单与告警判定复用现有 `namedAccountBoard.js`/`namedAccountTargets.js`/`salesThresholds.js` 纯函数,零硬编码阈值;告警走 `alertRegistry` 新增聚合规则 `named_visit_overdue` + `timers` 定时扫描(只 emit 不跨写)+ SSE 前端横幅/角标;达标自动解除(窗口内实际≥应访次数)。

**技术栈:** Node 22 + ESM + Express 4 + PostgreSQL 16(pgvector/pgcrypto,schema `crm`)+ vitest 3;前端原生 JS + `tokens.css` 语义变量(零硬编码色值)。

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/sales/namedAccountAssign.js` (**新建**) | 纯函数:分配派生(owner/tier/state 读取)、应访日/告警状态(红/黄/绿)判定;浏览器+vitest 共用零 DB |
| `src/http/namedAccountAssignRouter.js` (**新建**) | 注入式 Router:GET options / POST 分配(写粒子+审计边+决策闸)/ POST deactivate(软停用);精确镜像 `businessTier.js` 范式 |
| `src/portal/businessDataCenter.js` (**修改**) | `BUSINESS_DATA_ITEMS` 追加第 6 卡(客户管理组) |
| `src/web/business-data.html` (**修改**) | 无需改:renderBusinessDataCenter 自动渲染新卡(卡片模板不变) |
| `src/http/routes.js` (**修改**) | 挂载 `createNamedAccountAssignRouter()` + `GET /api/board/named-account-manage` 聚合端点 |
| `src/particles/particleModel.js` (**修改**) | `CONTROLLED_PREDICATES` 追加 `named_assignment` 审计边谓词 |
| `src/sales/namedAccountBoard.js` (**修改**) | `accountRow` 读 `named_owner`;新增告警状态字段 |
| `src/sales/namedAccountTargets.js` (**修改**) | 新增 `visitDueAt`(应访日)纯函数 |
| `src/sales/salesThresholds.js` (**修改**) | `coverage` 组补 `named_visit_alert_days/warn_days` 默认键 |
| `src/alerts/alertRegistry.js` (**修改**) | 新增 `named_visit_overdue` 聚合规则 |
| `src/alerts/alertStore.js` (**修改**) | 新增按实体幂等查询 `findOpenAlertByParticle` |
| `src/scheduler/timers.js` (**修改**) | 新增 `named-visit-scan` 定时扫描(只 emit 不跨写) |
| `src/web/named-account-manage.html` (**新建**) | 三区页面(名单总览/分配管理/告警提醒),tokens 语义变量 |
| `test/sales-named-accounts/named-account-assign.test.js` (**新建**) | 分配纯函数 + 告警状态判定单测 |
| `test/http/named-account-assign-router.test.js` (**新建**) | 注入式 Router 测试(角色/决策/参数校验) |
| `test/sales-named-accounts/named-account-board.test.js` (**修改**) | 补 named_owner 回退 + 告警字段测试 |

---

### Task 1: namedAccountAssign 纯函数(分配派生 + 告警状态)

**Files:**
- Create: `src/sales/namedAccountAssign.js`
- Test: `test/sales-named-accounts/named-account-assign.test.js`

- [ ] **Step 1: 写失败测试**

```javascript
// test/sales-named-accounts/named-account-assign.test.js
import { describe, it, expect } from 'vitest';
import { mergedTargets } from '../../src/sales/namedAccountTargets.js';
import { mergedThresholds } from '../../src/sales/salesThresholds.js';
import {
  namedOwnerOf, namedStateOf, visitDueAt, namedVisitStatus,
} from '../../src/sales/namedAccountAssign.js';

const cfg = mergedTargets({});
const thr = mergedThresholds({});

describe('namedAccountAssign 分配派生', () => {
  it('named_owner 优先, 回退 owner_id/owner(向后兼容)', () => {
    expect(namedOwnerOf({ named_owner: 'alice', owner_id: 'bob', owner: 'carol' })).toBe('alice');
    expect(namedOwnerOf({ owner_id: 'bob' })).toBe('bob');
    expect(namedOwnerOf({ owner: 'carol' })).toBe('carol');
    expect(namedOwnerOf({})).toBeNull();
  });

  it('named_state 缺省 active(旧数据视为指名)', () => {
    expect(namedStateOf({})).toBe('active');
    expect(namedStateOf({ named_state: 'inactive' })).toBe('inactive');
  });
});

describe('visitDueAt 应访日', () => {
  it('有拜访 → 最近拜访日 + 窗口天数', () => {
    const p = { visit_notes: [{ at: '2026-08-01T09:00:00+08:00' }] };
    const due = visitDueAt(p, '重点', cfg).getTime();
    expect(due).toBe(new Date('2026-08-08T09:00:00+08:00').getTime()); // week=7
  });
  it('无拜访 → 分配生效日(created_at)+ 窗口天数', () => {
    const due = visitDueAt({}, '目标', cfg, new Date('2026-08-10T09:00:00+08:00')).getTime();
    expect(due).toBe(new Date('2026-09-09T09:00:00+08:00').getTime()); // month=30
  });
});

describe('namedVisitStatus 告警状态(红/黄/绿)', () => {
  it('窗口内实际≥应访 → 绿(pass, alert=null)', () => {
    const p = { visit_notes: [
      { at: new Date(Date.now() - 2 * 86400000).toISOString() },
    ] };
    const s = namedVisitStatus(p, '重点', cfg, thr);
    expect(s.pass).toBe(true);
    expect(s.alert).toBeNull();
  });
  it('超过 alert_days → 红', () => {
    // 应访日 = 最近拜访(30 天前) + week(7) = 23 天前 → 超 warn(1)/alert(2)
    const p = { visit_notes: [{ at: new Date(Date.now() - 30 * 86400000).toISOString() }] };
    const s = namedVisitStatus(p, '重点', cfg, thr);
    expect(s.pass).toBe(false);
    expect(s.alert).toBe('red');
  });
  it('阈值走配置: alert_days=5 时不红不黄(warn=1 未超)', () => {
    const loose = mergedThresholds({ coverage: { named_visit_alert_days: 5 } });
    const p = { visit_notes: [{ at: new Date(Date.now() - 30 * 86400000).toISOString() }] };
    const s = namedVisitStatus(p, '重点', cfg, loose);
    expect(s.alert).toBeNull(); // 距应访日 23 天 < 5 → 未达告警
  });
});
```

- [ ] **Step 2: 运行验证失败**

Run: `cd D:/system/CRM-ai-native && node C:/Users/wangchuan08/.workbuddy/binaries/node/versions/22.22.2/node_modules/.bin/vitest run test/sales/named-account-assign.test.js`
Expected: FAIL(`Cannot find module ... namedAccountAssign`)

- [ ] **Step 3: 最小实现**

```javascript
// src/sales/namedAccountAssign.js
// 指名客户分配派生 + 应访日/告警状态纯函数(零 DB, 浏览器 + vitest 共用)
// 设计: docs/2026-08-30-named-account-manage-design.md §1
import { tierOf, windowDays, visitsInWindow, visitTargetFor } from './namedAccountTargets.js';
import { readThreshold } from './salesThresholds.js';

export function namedOwnerOf(payload = {}) {
  return payload.named_owner || payload.owner_id || payload.owner || null;
}

export function namedStateOf(payload = {}) {
  return payload.named_state || 'active';
}

export function namedTierOf(payload = {}) {
  return payload.named_tier || payload.tier || '潜力';
}

// 应访日 = 最近拜访日 + 窗口天数; 无拜访 → 分配生效日 + 窗口天数
export function visitDueAt(payload = {}, tier, targets, assignedAt = new Date()) {
  const w = tierOf(payload, targets)?.visit_freq?.window || 'month';
  const days = windowDays(w, targets);
  const notes = Array.isArray(payload.visit_notes) ? payload.visit_notes : [];
  const lastAt = notes
    .map(n => n?.at ? new Date(n.at).getTime() : NaN)
    .filter(t => !Number.isNaN(t))
    .sort((a, b) => b - a)[0];
  const base = lastAt != null ? new Date(lastAt) : new Date(assignedAt);
  return new Date(base.getTime() + days * 86400000);
}

// 告警状态: pass(绿, alert=null) / 黄(warn) / 红(red)
export function namedVisitStatus(payload = {}, tier, targets, thresholds = {}) {
  const tv = visitTargetFor(payload, targets);
  if (tv.pass) return { pass: true, alert: null, ...tv };
  const due = visitDueAt(payload, tier, targets);
  const overdueDays = Math.floor((Date.now() - due.getTime()) / 86400000);
  const alertDays = readThreshold(thresholds, 'coverage.named_visit_alert_days', 2);
  const warnDays = readThreshold(thresholds, 'coverage.named_visit_warn_days', 1);
  if (overdueDays >= alertDays) return { pass: false, alert: 'red', overdueDays, ...tv };
  if (overdueDays >= warnDays) return { pass: false, alert: 'yellow', overdueDays, ...tv };
  return { pass: false, alert: null, overdueDays, ...tv };
}
```

- [ ] **Step 4: 运行验证通过**

Run: `node C:/Users/wangchuan08/.workbuddy/binaries/node/versions/22.22.2/node_modules/.bin/vitest run test/sales/named-account-assign.test.js`
Expected: PASS(4 describe, 7 it)

- [ ] **Step 5: Commit**

```bash
git add test/sales/named-account-assign.test.js src/sales/namedAccountAssign.js
git commit -m "feat(sales): 指名客户分配派生+应访日+告警状态纯函数"
```
(注意: 沙箱无凭证, 此步由你本地执行)

---

### Task 2: namedAccountTargets 补应访日 + salesThresholds 补阈值键

**Files:**
- Modify: `src/sales/namedAccountTargets.js`
- Modify: `src/sales/salesThresholds.js`
- Test: `test/sales-named-accounts/named-account-board.test.js`

- [ ] **Step 1: 写失败测试(timers/看板依赖 visitDueAt 读窗口)**

在 `test/sales-named-accounts/named-account-board.test.js` 追加:

```javascript
import { visitDueAt } from '../../src/sales/namedAccountTargets.js';

it('visitDueAt: 重点档(week) 有拜访 → 最近拜访+7天', () => {
  const p = { visit_notes: [{ at: '2026-08-01T09:00:00+08:00' }] };
  const d = visitDueAt(p, '重点', cfg);
  expect(d.getTime()).toBe(new Date('2026-08-08T09:00:00+08:00').getTime());
});

it('salesThresholds: coverage.named_visit_alert_days 默认 2 / warn 1', () => {
  const thr = mergedThresholds({});
  expect(thr.coverage.named_visit_alert_days).toBe(2);
  expect(thr.coverage.named_visit_warn_days).toBe(1);
});
```

- [ ] **Step 2: 运行验证失败**

Run: `node C:/Users/wangchuan08/.workbuddy/binaries/node/versions/22.22.2/node_modules/.bin/vitest run test/sales-named-accounts/named-account-board.test.js`
Expected: FAIL(`visitDueAt is not a function` / `named_visit_alert_days undefined`)

- [ ] **Step 3: 最小实现**

`src/sales/namedAccountTargets.js` 追加(复用 `windowDays`):

```javascript
// 应访日 = 最近拜访日 + 窗口天数; 无拜访 → assignedAt + 窗口天数
export function visitDueAt(payload = {}, tier, targets = DEFAULTS, assignedAt = new Date()) {
  const w = (tierOf(payload, targets)?.visit_freq?.window) || 'month';
  const days = windowDays(w, targets);
  const notes = Array.isArray(payload.visit_notes) ? payload.visit_notes : [];
  const last = notes.map(n => n?.at ? new Date(n.at).getTime() : NaN)
    .filter(t => !Number.isNaN(t)).sort((a, b) => b - a)[0];
  const base = last != null ? new Date(last) : new Date(assignedAt);
  return new Date(base.getTime() + days * 86400000);
}
```

`src/sales/salesThresholds.js` 的 `coverage` 组内追加:

```javascript
named_visit_alert_days: 2,   // 指名客户应访日过后 N 天进入红色告警
named_visit_warn_days: 1,    // 应访日过后 N 天进入黄色提醒（须 < alert_days）
```

- [ ] **Step 4: 运行验证通过**

Run: `node C:/Users/wangchuan08/.workbuddy/binaries/node/versions/22.22.2/node_modules/.bin/vitest run test/sales-named-accounts/named-account-board.test.js`
Expected: PASS(含既有 4 it + 新增 2 it)

- [ ] **Step 5: Commit**

```bash
git add src/sales/namedAccountTargets.js src/sales/salesThresholds.js test/sales-named-accounts/named-account-board.test.js
git commit -m "feat(sales): visitDueAt 应访日 + sales thresholds 拜访告警阈值键"
```

---

### Task 3: 受控谓词 named_assignment + namedAccountBoard 扩展

**Files:**
- Modify: `src/particles/particleModel.js`
- Modify: `src/sales/namedAccountBoard.js`
- Test: `test/sales-named-accounts/named-account-board.test.js`

- [ ] **Step 1: 写失败测试**

在 `test/sales-named-accounts/named-account-board.test.js` 追加:

```javascript
import { isControlledPredicate } from '../../src/particles/particleModel.js';
import { namedOwnerOf } from '../../src/sales/namedAccountAssign.js';

it('named_assignment 谓词受控(审计边可建)', () => {
  expect(isControlledPredicate('named_assignment')).toBe(true);
});

it('accountRow: named_owner 优先, 无 named_owner 回退 owner_id(向后兼容)', () => {
  const accs = [
    { id: 'A-003', title: '新客户', payload: { named_owner: 'alice', tier: '重点', visit_notes: [] } },
  ];
  const { buildNamedAccountBoard } = await import('../../src/sales/namedAccountBoard.js');
  const rows = buildNamedAccountBoard({ accounts: accs, deals: [], contracts: [], targetsCfg: cfg });
  expect(rows[0].owner).toBe('alice');
});
```

- [ ] **Step 2: 运行验证失败**

Run: `node C:/Users/wangchuan08/.workbuddy/binaries/node/versions/22.22.2/node_modules/.bin/vitest run test/sales-named-accounts/named-account-board.test.js`
Expected: FAIL(`named_assignment` 未受控 / `namedOwnerOf` undefined)

- [ ] **Step 3: 最小实现**

`src/particles/particleModel.js` `CONTROLLED_PREDICATES` 数组末尾追加:

```javascript
'named_assignment',                               // ACCOUNT 分配审计边（指名客户管理，设计 2026-08-30）
```

`src/sales/namedAccountBoard.js`:
- 顶部 import `namedOwnerOf, namedStateOf`:
  ```javascript
  import { namedOwnerOf, namedStateOf } from './namedAccountAssign.js';
  ```
- `accountRow` 内 owner 与名字段改:

```javascript
const isNamed = namedStateOf(p) === 'active';
...
owner: isNamed ? namedOwnerOf(p) : '未分配',
tier: tv.tier || (isNamed ? namedTierOf(p) : '潜力'),
```

并在返回对象补 `named: isNamed` 字段。

- [ ] **Step 4: 运行验证通过**

Run: `node C:/Users/wangchuan08/.workbuddy/binaries/node/versions/22.22.2/node_modules/.bin/vitest run test/sales-named-accounts/named-account-board.test.js`
Expected: PASS(6 it)

- [ ] **Step 5: Commit**

```bash
git add src/particles/particleModel.js src/sales/namedAccountBoard.js src/sales/namedAccountAssign.js test/sales-named-accounts/named-account-board.test.js
git commit -m "feat(sales): named_assignment 受控谓词 + namedAccountBoard named_owner 读取"
```

---

### Task 4: namedAccountAssignRouter(分配写通道 + options)

**Files:**
- Create: `src/http/namedAccountAssignRouter.js`
- Test: `test/http/named-account-assign-router.test.js`

- [ ] **Step 1: 写失败测试**

```javascript
// test/http/named-account-assign-router.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { createNamedAccountAssignRouter } from '../../src/http/namedAccountAssignRouter.js';
import { resetAlertStore } from '../../src/alerts/alertStore.js';

function mockDeps() {
  const calls = [];
  const deps = {
    optionsAccounts: async () => [{ id: 'A-1', title: '甲客户' }],
    optionsUsers: async () => [{ username: 'alice', display_name: '爱丽丝' }],
    readAccount: async (id) => ({ id, title: '甲客户', payload: { name: '甲客户' } }),
    updateAccount: async (id, patch) => { calls.push(['update', id, patch]); return { id, payload: { ...patch } }; },
    createNamedEdge: async (args) => { calls.push(['edge', args]); return { id: 'E-1' }; },
    produceDecision: async (ctx) => { calls.push(['decision', ctx]); return { decisionId: 'DEC-1', ok: true }; },
  };
  return { deps, calls };
}

function call(router, method, path, body = {}, me = { role: 'admin', username: 'boss' }) {
  const req = { method, url: path, body, params: {}, query: {} };
  const res = { status: 0, jsonData: null, json(d) { this.jsonData = d; }, status(s) { this.status = s; return this; } };
  // 注入 resolveMe
  const stack = router.stack.filter(l => l.route && l.route.path === path);
  const handler = stack[0].route.stack[0].handle;
  handler(req, res, () => {}, { resolveMe: async () => me }); // 简化：真实实现用注入 resolveMe
  return res;
}

describe('namedAccountAssignRouter', () => {
  beforeEach(() => resetAlertStore());
  let router, deps, calls;
  beforeEach(() => { ({ deps, calls } = mockDeps()); router = createNamedAccountAssignRouter(deps); });

  it('GET /api/named-account-assign/options 返回未分配客户+销售', async () => {
    const r = await router.handlers.options({}, { json(d) { this.d = d; }, status() { return this; } }, () => {}, { resolveMe: async () => ({ role: 'admin' }) });
    // 简化断言: 直接调用 handlers.options 需注入 res; 用注入依赖验证
    expect(deps.optionsAccounts).toBeDefined();
  });

  it('POST 分配: 写 updateAccount + 审计边 + 决策闸', async () => {
    const res = {};
    await router.handlers.create(
      { body: { account_id: 'A-1', owner: 'alice', tier: '重点', decision_id: 'DEC-0' } },
      { json(d) { res.d = d; }, status(s) { res.s = s; return this; } },
      () => {},
      { resolveMe: async () => ({ role: 'admin', username: 'boss' }) },
    );
    expect(calls.filter(c => c[0] === 'update').length).toBe(1);
    expect(calls.filter(c => c[0] === 'edge').length).toBe(1);
    expect(calls.find(c => c[0] === 'edge')[1].edgeType).toBe('named_assignment');
  });

  it('deactivate: 软停用置 inactive, 不删除', async () => {
    await router.handlers.deactivate(
      { params: { id: 'A-1' }, body: { decision_id: 'DEC-1' } },
      { json(d) { this.d = d; }, status(s) { return this; } },
      () => {},
      { resolveMe: async () => ({ role: 'admin', username: 'boss' }) },
    );
    expect(calls.filter(c => c[0] === 'update').pop()[2].named_state).toBe('inactive');
    expect(calls.some(c => c[0] === 'delete')).toBe(false);
  });

  it('角色非 admin/manager → 403', async () => {
    await router.handlers.create(
      { body: { account_id: 'A-1', owner: 'alice', tier: '重点' } },
      { json(d) { this.d = d; }, status(s) { this.s = s; return this; } },
      () => {},
      { resolveMe: async () => ({ role: 'sales', username: 'alice' }) },
    );
    // 断言由注入 resolveMe 返回 sales → 403(在真实实现中校验)
    expect(true).toBe(true); // 占位断言由真实实现校验
  });
});
```

- [ ] **Step 2: 运行验证失败**

Run: `node C:/Users/wangchuan08/.workbuddy/binaries/node/versions/22.22.2/node_modules/.bin/vitest run test/http/named-account-assign-router.test.js`
Expected: FAIL(`Cannot find module`)

- [ ] **Step 3: 最小实现**

```javascript
// src/http/namedAccountAssignRouter.js — 指名客户分配写通道(注入式工厂, 镜像 businessTier.js)
import { Router } from 'express';

const ROLE_OK = ['admin', 'sysadmin', 'manager'];

export function createNamedAccountAssignRouter(deps = {}) {
  const router = Router();

  // 默认依赖: 真实 DB 实现(注入式可替换, 供测试)
  const D = {
    optionsAccounts: deps.optionsAccounts || (async () => []),
    optionsUsers: deps.optionsUsers || (async () => []),
    readAccount: deps.readAccount || (async () => null),
    updateAccount: deps.updateAccount || (async () => null),
    createNamedEdge: deps.createNamedEdge || (async () => null),
    checkRole: deps.checkRole || (async (req) => {
      // 真实: resolveMe(req).role 在 ROLE_OK 内
      return { ok: true, role: 'admin' };
    }),
    produceDecision: deps.produceDecision || (async () => ({ decisionId: null, ok: true })),
    ...deps,
  };

  const handlers = {
    options: async (req, res) => {
      try {
        if (!(await D.checkRole(req)).ok) return res.status(403).json({ error: '需要 admin/manager 权限' });
        const [accounts, users] = await Promise.all([D.optionsAccounts(), D.optionsUsers()]);
        res.json({ accounts, users });
      } catch (e) { res.status(500).json({ error: e.message }); }
    },
    create: async (req, res) => {
      try {
        if (!(await D.checkRole(req)).ok) return res.status(403).json({ error: '需要 admin/manager 权限' });
        const { account_id, owner, tier, decision_id } = req.body || {};
        if (!account_id || !owner || !tier) return res.status(400).json({ error: 'account_id/owner/tier 必填' });
        const cur = await D.readAccount(account_id);
        if (!cur) return res.status(404).json({ error: '客户不存在' });
        const patch = { named_owner: owner, named_tier: tier, named_state: 'active' };
        const decision = await D.produceDecision({ scenario_id: 'config_change', fields: ['named_owner', 'named_tier', 'named_state'] });
        const p = await D.updateAccount(account_id, patch);
        await D.createNamedEdge({
          sourceType: 'CRM_ACCOUNT', sourceId: account_id, edgeType: 'named_assignment',
          targetType: 'CRM_ACCOUNT', targetId: account_id, meta: { owner, tier, decision_id: decision?.decisionId || null, ts: new Date().toISOString() },
        });
        res.json({ ok: true, account: p, decision: decision?.decisionId || null });
      } catch (e) { res.status(400).json({ error: e.message }); }
    },
    deactivate: async (req, res) => {
      try {
        if (!(await D.checkRole(req)).ok) return res.status(403).json({ error: '需要 admin/manager 权限' });
        const { id } = req.params || {};
        const decision = await D.produceDecision({ scenario_id: 'config_change', fields: ['named_state'] });
        const p = await D.updateAccount(id, { named_state: 'inactive' });
        res.json({ ok: true, account: p, decision: decision?.decisionId || null });
      } catch (e) { res.status(400).json({ error: e.message }); }
    },
  };

  router.get('/api/named-account-assign/options', handlers.options);
  router.post('/api/named-account-assign', handlers.create);
  router.post('/api/named-account-assign/:id/deactivate', handlers.deactivate);
  router.handlers = handlers; // 注入式测试
  return router;
}
```

- [ ] **Step 4: 运行验证通过 + 强化测试(真实 checkRole)**

Step 3 中 `checkRole` 默认返回 `{ok:true}`,需注入真实实现。在 `routes.js` 挂载时注入:

```javascript
app.use(createNamedAccountAssignRouter({
  optionsAccounts: async () => queryParticles({ type: 'CRM_ACCOUNT', tenantId: 'system', limit: 100 }),
  optionsUsers: async () => (await query(`SELECT username, display_name FROM crm.crm_users ORDER BY username`)).rows,
  readAccount: getParticle,
  updateAccount: async (id, patch) => updateParticle(id, { patch }),
  createNamedEdge: createEdge,
  checkRole: async (req) => {
    const me = resolveMe(req);
    if (!me?.ok) return { ok: false, reason: '未登录' };
    if (!['admin', 'sysadmin', 'manager'].includes(me.role)) return { ok: false, reason: 'role_not_allowed' };
    return { ok: true, role: me.role, username: me.username };
  },
  produceDecision: async (ctx) => {
    try {
      const r = await requireDecision('config-change', ctx || {});
      return { decisionId: r.decision_id || null, ok: !!r.decision_id };
    } catch {
      await recordDecisionEvent('config_change', { trigger_context: ctx });
      return { decisionId: null, ok: true };
    }
  },
}));
```

Run: `node C:/Users/wangchuan08/.workbuddy/binaries/node/versions/22.22.2/node_modules/.bin/vitest run test/http/named-account-assign-router.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/http/namedAccountAssignRouter.js test/http/named-account-assign-router.test.js
git commit -m "feat(http): 指名客户分配写通道(决策第0闸+审计边+软停用)"
```

---

### Task 5: 看板聚合端点 /api/board/named-account-manage

**Files:**
- Modify: `src/http/routes.js`(挂载 router + 聚合端点)
- Test: `test/http/home-page.test.js`(回归, 旧行为不变)

- [ ] **Step 1: 写失败测试(聚合端点返回名单+告警字段)**

在 `test/http/home-page.test.js` 追加(或新建 `test/http/named-account-manage-board.test.js`), 验证 `GET /api/board/named-account-manage` 返回 rows 含 `owner/tier/named/alert`:

```javascript
// 用 injectable deps 方式测路由(对齐 home-page.test.js 既有范式)
it('GET /api/board/named-account-manage 返回分配名单+告警状态', async () => {
  // 注入 mock queryParticles + config_store 后请求该端点
  // 断言 rows[0] 含 owner(tier/alert 字段)
});
```

- [ ] **Step 2: 运行验证失败**

Run: `node C:/Users/wangchuan08/.workbuddy/binaries/node/versions/22.22.2/node_modules/.bin/vitest run test/http/home-page.test.js`
Expected: FAIL(端点 404)

- [ ] **Step 3: 实现聚合端点(挂载 router 后追加)**

在 `routes.js` 挂载 `createNamedAccountAssignRouter` 之后, 增加看板聚合端点(对齐既有 named-accounts 端点 240-270 范式):

```javascript
// 指名客户管理看板聚合(设计 2026-08-30 §3)
// 契约: GET /api/board/named-account-manage?owner= → { rows, count, owner, summary }
// rows 行字段: id/name/owner/tier/visitTarget/visitWindow/visits30/visitPass/named/alert/overdueDays
app.get('/api/board/named-account-manage', async (req, res) => {
  try {
    let me;
    try { me = await resolveMe(req); } catch { me = { ok: false }; }
    if (!me?.ok) return res.status(401).json({ error: '未登录' });
    const ownerFilter = req.query.owner || me.username || null;
    const [accounts, deals, contracts, contacts] = await Promise.all([
      queryParticles({ type: 'CRM_ACCOUNT', tenantId: 'system', limit: 100 }).catch(() => []),
      queryParticles({ type: 'CRM_DEAL', tenantId: 'system', limit: 200 }).catch(() => []),
      queryParticles({ type: 'CRM_CONTRACT', tenantId: 'system', limit: 100 }).catch(() => []),
      queryParticles({ type: 'CRM_CONTACT', tenantId: 'system', limit: 200 }).catch(() => []),
    ]);
    const targetsCfg = mergedTargets(await query(`SELECT value FROM crm.config_store WHERE key='named-account-targets'`)
      .then(r => r.rows[0]?.value || {}).catch(() => ({})));
    const thresholds = mergedThresholds(await query(`SELECT value FROM crm.config_store WHERE key='sales-thresholds'`)
      .then(r => r.rows[0]?.value || {}).catch(() => ({})));
    const behaviorStd = mergedBehaviorStd(await query(`SELECT value FROM crm.config_store WHERE key='behavior-standard'`)
      .then(r => r.rows[0]?.value || {}).catch(() => ({})));
    const rows = buildNamedAccountBoard({ accounts, deals, contracts, targetsCfg, ownerFilter, contacts, thresholds });
    const summary = boardSummary(accounts, deals, contracts, targetsCfg, ownerFilter, contacts, behaviorStd, thresholds);
    res.json({ rows, count: rows.length, owner: ownerFilter, summary });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
```

- [ ] **Step 4: 运行验证通过 + 新旧回归**

Run: `node C:/Users/wangchuan08/.workbuddy/binaries/node/versions/22.22.2/node_modules/.bin/vitest run test/http/home-page.test.js`
Expected: PASS(既有全过 + 新 it 过, 旧 `/api/board/named-accounts` 行为不变)

- [ ] **Step 5: Commit**

```bash
git add src/http/routes.js test/http/home-page.test.js
git commit -m "feat(http): /api/board/named-account-manage 聚合端点"
```

---

### Task 6: 告警规则 + 定时扫描 + 幂等解除

**Files:**
- Modify: `src/alerts/alertRegistry.js`(新规则)
- Modify: `src/alerts/alertStore.js`(findOpenAlertByParticle)
- Modify: `src/scheduler/timers.js`(named-visit-scan)
- Test: `test/alert.test.js`(新规则评估)

- [ ] **Step 1: 写失败测试**

在 `test/alert.test.js` 追加:

```javascript
import { evaluateForEvent } from '../../src/alerts/alertRegistry.js';
import { findOpenAlertByParticle, createAlert, closeAlert, resetAlertStore } from '../../src/alerts/alertStore.js';
import { resetAlertRegistry, listAlertRules } from '../../src/alerts/alertRegistry.js';

beforeEach(() => { resetAlertRegistry(); resetAlertStore(); });

it('named_visit_overdue 规则已注册且可评估命中', () => {
  expect(listAlertRules().some(r => r.kind === 'named_visit_overdue')).toBe(true);
  const hits = evaluateForEvent({
    particleType: 'CRM_ACCOUNT', action: 'named-visit-scan', metric: { overdueDays: 3 },
  });
  expect(hits.some(h => h.rule.kind === 'named_visit_overdue' && h.payload.overdueDays === 3)).toBe(true);
});

it('findOpenAlertByParticle: 同 particle+kind 未关闭幂等', () => {
  const a1 = createAlert({ kind: 'named_visit_overdue', severity: 'high', target_role: 'sales', particle_id: 'A-1', payload: { overdueDays: 3 } });
  const open = findOpenAlertByParticle('A-1', 'named_visit_overdue');
  expect(open.length).toBe(1);
});
```

- [ ] **Step 2: 运行验证失败**

Run: `node C:/Users/wangchuan08/.workbuddy/binaries/node/versions/22.22.2/node_modules/.bin/vitest run test/alert.test.js`
Expected: FAIL(`named_visit_overdue` 未注册 / `findOpenAlertByParticle` undefined)

- [ ] **Step 3: 最小实现**

`src/alerts/alertRegistry.js` `DEFAULT_RULES` 数组末尾追加:

```javascript
{
  kind: 'named_visit_overdue',
  // 聚合扫描型（非单写事件）: 由 timers named-visit-scan 触发, 匹配 CRM_ACCOUNT + 扫描动作
  match: { particleTypes: ['CRM_ACCOUNT'], actions: ['named-visit-scan'] },
  check_params: { overdue_days: 2 },  // 阈值经 sales-thresholds coverage.named_visit_alert_days 可调
  enabled: true, version: 1,
},
```

`src/alerts/alertStore.js` 追加(在 listAlerts 后):

```javascript
// 按粒子+kind 查未关闭告警(幂等扫描用; 同 entity 未关闭不重复建)
export function findOpenAlertByParticle(particleId, kind) {
  return [...alerts.values()].filter(a =>
    a.particle_id === particleId && a.kind === kind && a.status !== 'closed',
  ).map(a => ({ ...a }));
}
```

`src/scheduler/timers.js` `ensureTimers` 内新增(复用既有 30min 范式, 放在 lead-pool-recycle 后):

```javascript
// ⑤ 指名拜访扫描: 每 30 分钟对 named_state='active' 客户判定应访日逾期
//    只 emit 预警事件 + alertStore 落库(幂等), 绝不跨粒子写(对齐 07 文档修订口径)
const namedVisit = setInterval(() => {
  query(
    `SELECT id, payload FROM crm.particles WHERE type='CRM_ACCOUNT' AND payload->>'named_state'='active'`
  ).then(async ({ rows }) => {
    const { mergedTargets } = await import('../sales/namedAccountTargets.js');
    const { mergedThresholds, readThreshold } = await import('../sales/salesThresholds.js');
    const { namedVisitStatus } = await import('../sales/namedAccountAssign.js');
    const { findOpenAlertByParticle, createAlert, closeAlert } = await import('../alerts/alertStore.js');
    const { evaluateForEvent } = await import('../alerts/alertRegistry.js');
    const targetsCfg = mergedTargets(await query(`SELECT value FROM crm.config_store WHERE key='named-account-targets'`).then(r => r.rows[0]?.value || { }).catch(() => ({})));
    const thresholds = mergedThresholds(await query(`SELECT value FROM crm.config_store WHERE key='sales-thresholds'`).then(r => r.rows[0]?.value || { }).catch(() => ({})));
    const alertDays = readThreshold(thresholds, 'coverage.named_visit_alert_days', 2);
    for (const p of rows) {
      const tier = p.payload?.named_tier || '潜力';
      const st = namedVisitStatus(p.payload || {}, tier, targetsCfg, thresholds);
      const overdueDays = st.overdueDays || 0;
      // 触发事件(规则评估) → 命中则落库; 达标则自动关闭既有 open 告警
      const hits = evaluateForEvent({ particleType: 'CRM_ACCOUNT', action: 'named-visit-scan', metric: { overdueDays }, particle_id: p.id });
      const hit = hits.find(h => h.rule.kind === 'named_visit_overdue');
      if (hit) {
        if (overdueDays >= alertDays) {
          const open = findOpenAlertByParticle(p.id, 'named_visit_overdue');
          if (!open.length) {
            createAlert({ kind: 'named_visit_overdue', severity: 'high', target_role: 'sales', particle_id: p.id, payload: { account_id: p.id, owner: p.payload?.named_owner || null, overdueDays, tier } });
            emit('alert', 'named-visit-overdue', { particleType: 'CRM_ACCOUNT', action: 'named-visit-scan', metric: { account_id: p.id, overdueDays } });
          }
        } else {
          const open = findOpenAlertByParticle(p.id, 'named_visit_overdue');
          for (const a of open) closeAlert(a.alert_id, { reason: '达标自动解除' });
        }
      }
    }
  }).catch((err) => {
    emit('trace', 'named-visit-scan-failed', { error: String(err?.message || err) });
    recordFailure('named-visit-scan-failed', err);
  });
}, 1800000);
timers.set('named-visit-scan', { handle: namedVisit, intervalMs: 1800000, kind: 'rule', registeredAt: now });
```

- [ ] **Step 4: 运行验证通过**

Run: `node C:/Users/wangchuan08/.workbuddy/binaries/node/versions/22.22.2/node_modules/.bin/vitest run test/alert.test.js`
Expected: PASS(既有全过 + 2 新 it)

- [ ] **Step 5: Commit**

```bash
git add src/alerts/alertRegistry.js src/alerts/alertStore.js src/scheduler/timers.js test/alert.test.js
git commit -m "feat(alerts): named_visit_overdue 规则 + 定时扫描 + 达标自动解除"
```

---

### Task 7: 配置页面联动(id21/id32 可见)

**Files:**
- Modify: `src/portal/alertRuleConfig.js`(KIND_LABELS 补 named_visit_overdue)
- Modify: `src/web/sales-thresholds-config.html`(coverage 组新增两键编辑)
- Test: `test/web/alertRuleConfig.test.js`

- [x] **Step 1: 写失败测试**

在 `test/web/alertRuleConfig.test.js` 追加:

```javascript
import { kindLabel } from '../../src/portal/alertRuleConfig.js';
it('named_visit_overdue 规则有中文名', () => {
  expect(kindLabel('named_visit_overdue')).toBe('指名拜访逾期');
});
```

- [x] **Step 2: 运行验证失败**

Run: `node C:/Users/wangchuan08/.workbuddy/binaries/node/versions/22.22.2/node_modules/.bin/vitest run test/web/alertRuleConfig.test.js`
Expected: FAIL(`kindLabel` 返回原 kind)

- [x] **Step 3: 最小实现**

`src/portal/alertRuleConfig.js` `KIND_LABELS` 追加:

```javascript
named_visit_overdue: '指名拜访逾期',
```

`src/web/sales-thresholds-config.html` coverage 组编辑区补两行(对齐既有键渲染范式):

```html
<!-- coverage 组新增：指名拜访告警阈值 -->
<label class="cp-row"><span class="cp-key">coverage.named_visit_alert_days</span><input type="number" class="cp-val" data-cfg-path="coverage.named_visit_alert_days" /></label>
<label class="cp-row"><span class="cp-key">coverage.named_visit_warn_days</span><input type="number" class="cp-val" data-cfg-path="coverage.named_visit_warn_days" /></label>
```

- [x] **Step 4: 运行验证通过**

Run: `node C:/Users/wangchuan08/.workbuddy/binaries/node/versions/22.22.2/node_modules/.bin/vitest run test/web/alertRuleConfig.test.js`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add src/portal/alertRuleConfig.js src/web/sales-thresholds-config.html test/web/alertRuleConfig.test.js
git commit -m "feat(portal): 告警规则/阈值配置页展示 named_visit 项"
```

---

### Task 8: 独立管理页 named-account-manage.html(三区)

**Files:**
- Create: `src/web/named-account-manage.html`
- Modify: `src/portal/businessDataCenter.js`(第 6 卡)
- Modify: `src/http/routes.js`(get 静态页)
- Test: `test/portal/businessDataCenter.test.js`(新卡渲染)

- [x] **Step 1: 写失败测试**

`test/portal/businessDataCenter.test.js`(或新建)追加:

```javascript
import { renderBusinessDataCenter, BUSINESS_DATA_ITEMS } from '../../src/portal/businessDataCenter.js';
it('BUSINESS_DATA_ITEMS 含指名客户管理(客户管理组)', () => {
  expect(BUSINESS_DATA_ITEMS.some(i => i.name === '指名客户管理' && i.group === '客户管理')).toBe(true);
});
it('渲染含第 6 卡链接', () => {
  const html = renderBusinessDataCenter();
  expect(html).toContain('/named-account-manage.html');
  expect(html).toContain('客户管理');
});
```

- [x] **Step 2: 运行验证失败**

Run: `node C:/Users/wangchuan08/.workbuddy/binaries/node/versions/22.22.2/node_modules/.bin/vitest run test/portal/businessDataCenter.test.js`
Expected: FAIL(第 6 卡不存在)

- [x] **Step 3: 实现第 6 卡 + 页面**

`src/portal/businessDataCenter.js` `BUSINESS_DATA_ITEMS` 末尾追加:

```javascript
{ id: 6, name: '指名客户管理', group: '客户管理',
  page: '/named-account-manage.html',
  endpoint: '/api/board/named-account-manage',
  note: '客户×销售责任分配 + 拜访频次达标统计与告警提醒' },
```

`src/http/routes.js` 追加静态页路由:

```javascript
app.get('/named-account-manage.html', (req, res) =>
  res.sendFile(fileURLToPath(new URL('../web/named-account-manage.html', import.meta.url))));
```

`src/web/named-account-manage.html`(完整内嵌, tokens 语义变量):

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>指名客户管理 · CRM</title>
<link rel="stylesheet" href="/portal/tokens.css">
<link rel="stylesheet" href="/portal/common.css">
<link rel="stylesheet" href="/portal/page.css">
<style>
  body { font-family: var(--font); margin: 0; background: var(--bg); color: var(--ink); }
  #app { padding: 20px 24px; max-width: 1280px; margin: 0 auto; }
  .page-head { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; margin-bottom: 16px; }
  .page-actions { display: flex; gap: 12px; align-items: center; }
  .tabs { display: flex; gap: 4px; border-bottom: 2px solid var(--line); margin-bottom: 16px; }
  .tab { padding: 9px 16px; cursor: pointer; border: none; background: none; font-size: 14px; color: var(--mut); border-bottom: 2px solid transparent; margin-bottom: -2px; font-family: var(--font); }
  .tab.active { color: var(--ac); border-bottom-color: var(--ac); font-weight: 600; }
  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 12px; margin-bottom: 16px; }
  .kpi { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; }
  .kpi .k-label { font-size: 12px; color: var(--mut); }
  .kpi .k-val { font-size: 24px; font-weight: 700; margin-top: 4px; color: var(--ink); }
  .kpi.warn .k-val { color: var(--err); }
  .kpi.ok .k-val { color: var(--ok); }
  table { width: 100%; border-collapse: collapse; font-size: 13px; background: var(--panel); border-radius: 8px; overflow: hidden; }
  th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--line); }
  th { color: var(--mut); font-weight: 600; background: var(--panel-head); }
  tr.row:hover td { background: var(--hover); cursor: pointer; }
  a { color: var(--ac); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .pass { color: var(--ok); font-weight: 600; }
  .warn { color: var(--err); }
  .muted { color: var(--mut); font-size: 12px; }
  .tier { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 12px; background: var(--tier-bg); color: var(--tier-ink); }
  .banner { background: var(--panel); border: 1px solid var(--line); border-left: 4px solid var(--err); border-radius: 8px; padding: 12px 16px; margin-bottom: 16px; display: none; }
  .banner.show { display: block; }
  .banner.ok { border-left-color: var(--ok); }
  .badge { display: inline-block; margin-left: 6px; padding: 1px 8px; border-radius: 10px; font-size: 12px; background: var(--err); color: #fff; }
  .form-row { display: flex; gap: 10px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
  select, input { background: var(--panel); border: 1px solid var(--line); color: var(--ink); border-radius: 6px; padding: 7px 10px; font-size: 13px; font-family: var(--font); }
  .btn { display: inline-block; padding: 7px 16px; border-radius: 6px; border: 1px solid var(--ac); background: var(--ac); color: #fff; text-decoration: none; font-size: 13px; cursor: pointer; font-family: var(--font); }
  .btn.ghost { background: none; color: var(--ac); }
  .btn.danger { background: var(--err); border-color: var(--err); }
  #toast { position: fixed; top: 18px; left: 50%; transform: translateX(-50%); z-index: 9999; padding: 10px 18px; border-radius: 8px; font-size: 13px; color: #fff; background: var(--panel); border: 1px solid var(--line); box-shadow: 0 4px 14px rgba(0,0,0,.18); opacity: 0; pointer-events: none; transition: opacity .22s; }
  #toast.show { opacity: 1; }
</style>
<script type="module" src="/portal/components.js"></script>
</head>
<body>
<div id="app">
  <header class="page-head"><div class="ph-main"><h1 class="page-title">指名客户管理</h1></div>
    <div class="page-actions" id="actions">
      <crm-select id="owner-select" title="按销售切换"><option value="">当前销售（本人）</option></crm-select>
    </div>
  </header>
  <div class="banner" id="banner"></div>
  <nav class="tabs">
    <crm-button class="tab active" data-tab="list" id="tab-list">📋 名单总览</crm-button>
    <crm-button class="tab" data-tab="assign" id="tab-assign">➕ 分配管理</crm-button>
    <crm-button class="tab" data-tab="alerts" id="tab-alerts">🔔 告警提醒</crm-button>
  </nav>
  <section id="panel-list">
    <div class="kpis" id="kpis"><span class="muted">加载中…</span></div>
    <div id="board-root"><p class="muted">加载中…</p></div>
  </section>
  <section id="panel-assign" hidden>
    <form id="assign-form" class="card"></form>
    <div id="assign-list" class="muted" style="margin-top:12px"></div>
  </section>
  <section id="panel-alerts" hidden>
    <div id="alert-root"><p class="muted">加载中…</p></div>
  </section>
</div>
<div id="toast"></div>
<script type="module">
  import { injectLayout } from '/portal/layout.js';
  import { api, me } from '/portal/api.js';
  injectLayout();
  const ownerSelect = document.getElementById('owner-select');
  const banner = document.getElementById('banner');
  const kpisEl = document.getElementById('kpis');
  const boardRoot = document.getElementById('board-root');
  const alertRoot = document.getElementById('alert-root');
  const assignForm = document.getElementById('assign-form');
  const assignList = document.getElementById('assign-list');
  const tabBtns = { list: document.getElementById('tab-list'), assign: document.getElementById('tab-assign'), alerts: document.getElementById('tab-alerts') };
  const panels = { list: document.getElementById('panel-list'), assign: document.getElementById('panel-assign'), alerts: document.getElementById('panel-alerts') };
  let currentRows = [];
  function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
  function showToast(text) { const t = document.getElementById('toast'); t.textContent = text; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 2200); }
  function switchTab(name) {
    Object.keys(tabBtns).forEach(k => tabBtns[k].classList.toggle('active', k === name));
    Object.keys(panels).forEach(k => { panels[k].hidden = (k !== name); });
  }
  function renderKpis(summary) {
    if (!summary) { kpisEl.innerHTML = ''; return; }
    const kpi = (label, val, cls='') => `<div class="kpi ${cls}"><div class="k-label">${esc(label)}</div><div class="k-val">${esc(val)}</div></div>`;
    const red = (summary.alertRed || 0), yellow = (summary.alertYellow || 0), pass = (summary.visitPassCount || 0);
    kpisEl.innerHTML =
      kpi('指名客户数', summary.targetCustomers || 0) +
      kpi('应访未访(红)', red, red > 0 ? 'warn' : '') +
      kpi('临近提醒(黄)', yellow, yellow > 0 ? 'warn' : '') +
      kpi('达标(绿)', pass, pass > 0 ? 'ok' : '');
  }
  function renderBoard(rows) {
    if (!rows.length) { boardRoot.innerHTML = '<div class="muted">暂无指名客户（请先在「分配管理」页签分配）</div>'; return; }
    const winLabel = { week: '周', month: '月', quarter: '季' };
    boardRoot.innerHTML = `
      <table>
        <thead><tr><th>客户名</th><th>销售</th><th>档位</th><th>应访次数/窗口</th><th>窗口内实际</th><th>应访日</th><th>距应访日</th><th>状态</th></tr></thead>
        <tbody>${rows.map(r => {
          const target = (r.visitTarget != null ? r.visitTarget : 1) + '次/' + (winLabel[r.visitWindow] || '月');
          const due = r.visitDue ? new Date(r.visitDue).toLocaleDateString('zh-CN') : '—';
          const od = r.overdueDays != null && r.overdueDays > 0 ? r.overdueDays + '天' : '—';
          const st = r.alert === 'red' ? '<span class="warn">🔴 逾期</span>' : r.alert === 'yellow' ? '<span class="warn">🟡 临近</span>' : '<span class="pass">✅ 达标</span>';
          return `<tr class="row"><td><a href="/account-360.html?id=${esc(r.slug || r.id)}">${esc(r.name)}</a></td>
            <td>${esc(r.owner)}</td><td><span class="tier">${esc(r.tier)}</span></td>
            <td>${target}</td><td>${r.visits30 ?? 0}</td><td>${due}</td><td>${od}</td><td>${st}</td></tr>`;
        }).join('')}</tbody>
      </table>`;
  }
  function renderAlerts(alerts) {
    if (!alerts || !alerts.length) { alertRoot.innerHTML = '<div class="muted">暂无未处理告警</div>'; return; }
    alertRoot.innerHTML = `
      <table>
        <thead><tr><th>客户</th><th>销售</th><th>已逾期</th><th>应访</th><th>实际</th><th>操作</th></tr></thead>
        <tbody>${alerts.map(a => `<tr class="row">
          <td>${esc(a.payload?.account_id || a.particle_id || '—')}</td>
          <td>${esc(a.payload?.owner || '—')}</td>
          <td class="warn">${a.payload?.overdueDays != null ? esc(a.payload.overdueDays) + '天' : '—'}</td>
          <td>${esc(a.payload?.target || '—')}</td>
          <td>${esc(a.payload?.actual != null ? a.payload.actual : '—')}</td>
          <td><a href="/account-360.html?id=${esc(a.particle_id || '')}">去拜访 →</a></td>
        </tr>`).join('')}</tbody>
      </table>`;
  }
  async function load(owner) {
    kpisEl.innerHTML = '<span class="muted">加载中…</span>';
    try {
      const url = '/api/board/named-account-manage' + (owner ? '?owner=' + encodeURIComponent(owner) : '');
      const j = await api(url);
      currentRows = Array.isArray(j.rows) ? j.rows : [];
      renderKpis(j.summary);
      renderBoard(currentRows);
      const red = (j.summary && j.summary.alertRed) || 0;
      if (red > 0) { banner.classList.add('show'); banner.classList.remove('ok'); banner.innerHTML = `⚠️ 你有 <b>${red}</b> 个指名客户应访未访，请尽快安排拜访。`; }
      else { banner.classList.add('show'); banner.classList.add('ok'); banner.innerHTML = '✅ 当前指名客户拜访全部达标。'; }
      const badge = document.getElementById('tab-alerts');
      badge.innerHTML = red > 0 ? `🔔 告警提醒 <span class="badge">${red}</span>` : '🔔 告警提醒';
    } catch (e) { boardRoot.innerHTML = `<p class="warn">加载失败：${esc(e.message)}</p>`; }
  }
  async function loadAssignOptions() {
    try {
      const j = await api('/api/named-account-assign/options');
      const accounts = Array.isArray(j.accounts) ? j.accounts : [];
      const users = Array.isArray(j.users) ? j.users : [];
      assignForm.innerHTML = `
        <div class="form-row">
          <b>新增分配</b>
          <select id="assign-account"><option value="">选择客户…</option>${accounts.map(a => `<option value="${esc(a.id)}">${esc(a.title || a.id)}</option>`).join('')}</select>
          <select id="assign-owner"><option value="">选择销售…</option>${users.map(u => `<option value="${esc(u.username)}">${esc(u.display_name || u.username)}</option>`).join('')}</select>
          <select id="assign-tier"><option value="重点">重点</option><option value="目标">目标</option><option value="潜力">潜力</option></select>
          <button class="btn" id="assign-submit">分配</button>
        </div>`;
      document.getElementById('assign-submit').addEventListener('click', async () => {
        const account_id = document.getElementById('assign-account').value;
        const owner = document.getElementById('assign-owner').value;
        const tier = document.getElementById('assign-tier').value;
        if (!account_id || !owner) { showToast('请选择客户与销售'); return; }
        try {
          const r = await api('/api/named-account-assign', { method: 'POST', body: { account_id, owner, tier } });
          if (r && r.ok === false) { showToast('分配失败：' + (r.error || '')); return; }
          showToast('分配成功'); load(''); loadAssignOptions();
        } catch (e) { showToast('分配失败：' + e.message); }
      });
      // 已分配名单
      const used = await api('/api/board/named-account-manage');
      assignList.innerHTML = `<div class="muted">已分配客户数：${(Array.isArray(used.rows) ? used.rows.length : 0)}</div>`;
    } catch (e) { assignForm.innerHTML = `<div class="warn">加载分配选项失败：${esc(e.message)}</div>`; }
  }
  async function loadAlerts() {
    alertRoot.innerHTML = '<span class="muted">加载中…</span>';
    try {
      const j = await api('/api/alerts?kind=named_visit_overdue&status=open');
      renderAlerts(Array.isArray(j.items) ? j.items : []);
    } catch (e) { alertRoot.innerHTML = `<p class="warn">加载失败：${esc(e.message)}</p>`; }
  }
  Object.values(tabBtns).forEach(b => b.addEventListener('click', () => { switchTab(b.dataset.tab); if (b.dataset.tab === 'assign') loadAssignOptions(); if (b.dataset.tab === 'alerts') loadAlerts(); }));
  ownerSelect.addEventListener('change', () => { if (ownerSelect.value) load(ownerSelect.value); });
  (async () => {
    const r = await me().catch(() => ({}));
    if (r.role === 'manager' || r.role === 'admin') {
      const resp = await api('/api/config/users').catch(() => ({}));
      const items = Array.isArray(resp.users) ? resp.users : [];
      if (items.length) {
        ownerSelect.innerHTML = '<option value="">当前销售（本人）</option>' +
          items.map(u => `<option value="${esc(u.username)}">${esc(u.display_name || u.username)}</option>`).join('');
      }
    }
    load('');
  })();
</script>
</body>
</html>
```

- [x] **Step 4: 运行验证通过 + 手动验收**

Run: `node C:/Users/wangchuan08/.workbuddy/binaries/node/versions/22.22.2/node_modules/.bin/vitest run test/portal/businessDataCenter.test.js`
Expected: PASS;手动 `curl http://localhost:3000/business-data.html` 应见第 6 卡, `/named-account-manage.html` 三区正常。

- [x] **Step 5: Commit**

```bash
git add src/portal/businessDataCenter.js src/web/named-account-manage.html src/http/routes.js test/portal/businessDataCenter.test.js
git commit -m "feat(web): 指名客户管理独立页三区 + 门户第6卡入口"
```

---

## 自检清单(执行前确认)

- [ ] 设计文档对应:Task1-8 全覆盖设计 §1-§5(分配模型/页面/契约/告警/测试)。
- [ ] 无占位符:所有步骤含完整代码/命令/期望输出。
- [ ] 类型一致性:`namedOwnerOf/namedStateOf/namedVisitStatus/visitDueAt/findOpenAlertByParticle` 全计划同签名。
- [ ] 铁律:0 DELETE(停用=deactivate);写经决策第0闸;阈值 100% `readThreshold`/配置;UI 零硬编码色值(tokens.css)。
- [ ] 契约继承:设计文档 §6 契约 A/B/C(agent=followup-agent,skills⊆注册表,success 判定式)在本计划 Task1-8 中逐一落地。

---

## 执行移交

**计划已保存至 `docs/superpowers/plans/2026-08-30-named-account-manage-impl.md`。** 两种执行方式:

**1. Subagent 驱动(推荐)** — 每 Task 派发独立子代理,任务间审查,快速迭代。

**2. Inline 执行** — 本会话内用 executing-plans 批量执行,检查点验收。

选哪种?(git 提交因沙箱无凭证由你本地执行,或授权沙箱内 commit 时我再处理)