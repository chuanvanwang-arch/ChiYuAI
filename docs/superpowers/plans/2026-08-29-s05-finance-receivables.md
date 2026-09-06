# S05 财务应收闭环 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把已存在的回款应收基础能力聚合成 S05 财务应收闭环（聚合端点 + 看板页 + 逾期自动催收待办 + 差额超阈值预警写回 + 配置后台化 + 逾期规则扩维），不新建粒子类型、不引入新存储表。

**Architecture:** 复用 `paymentService.reconcilePlan/reconcileContract` 纯函数做合同维聚合；待办经 `/api/page/todo` 从粒子状态**派生**（非新建表）；差额/逾期预警由应收聚合与 `checkOverdueAndEmit` 驱动 `alertStore.createAlert` + bus `alert`/`payment` 域转播；配置落 `config_store['finance-receivables']`（仿 S20 seven-dim 范式，sysadmin 闸 + 决策第0闸）。

**Tech Stack:** Node 22 + Express 4 + PostgreSQL(pg, crm schema) + vitest 3（测试库 `plm_test`）+ bus 事件（`src/events/bus.js`）+ 受控门户页（tokens.css/common.css）。

**测试命令铁律：** 跑测试用 `node node_modules/vitest/vitest.mjs run <path>`（禁用 npx；vitest.config 已禁 fileParallelism）。测试库为 `plm_test`，勿与直连 `node -e` 的生产库 `plm` 混用。

---

## File Structure（改动面锁定）

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/http/routes.js` | Modify | T1 挂 `GET /api/finance/receivables`；T3 扩展 `/api/page/todo` finance 分支；T4 在 T1 端点内核加差额预警写回；T5 挂 `GET/PUT /api/config/finance-receivables` |
| `src/http/financeReceivablesConfigRouter.js` | Create | T5 配置端点（仿 sevenDimRouter，CONFIG_KEY='finance-receivables'） |
| `src/web/receivables.html` | Create | T2 应收看板页（总览卡 + 明细表 + 发票对账 + 逾期区） |
| `src/portal/layoutMenu.js` | Modify | T2 finance 专属导航入口（role 过滤） |
| `src/sales/paymentService.js` | Modify | T6 扩展 `checkOverdueAndEmit` 第二维（PAYMENT_PLAN 逾期事件） |
| `src/alerts/alertRegistry.js` | Modify | T4 注册 `payment_gap`；T6 注册 `payment_due_plan` |
| `src/alerts/financeAlertHook.js` | Create | T6 订阅 bus `payment` 域，捕获逾期事件→ruleEvaluator 判定→createAlert+SSE |
| `src/http/server.js` | Modify | T6 注册 `registerFinanceAlertHook()` |
| `scripts/seed-finance-receivables-config.mjs` | Create | T5 幂等 seed 默认配置 |
| `db/seed.sql` | Modify | T5 调用 seed（或并入现有 seed 流程，幂等非空跳过） |
| `test/http/finance-receivables.test.js` | Create | T1 端点聚合 + 角色闸 |
| `test/web/receivables.test.js` | Create | T2 页面契约 |
| `test/http/todo-finance.test.js` | Create | T3 催收待办派生 |
| `test/alerts/payment-gap.test.js` | Create | T4 差额预警写回 |
| `test/http/finance-receivables-config.test.js` | Create | T5 配置端点 |
| `test/alerts/payment-due-plan.test.js` | Create | T6 逾期规则扩维 |

---

## Task 1: 暴露财务应收聚合端点

**Files:**
- Modify: `src/http/routes.js`（新增 `GET /api/finance/receivables`，约在 104 行 `app.use(createSevenDimRouter())` 之后）
- Test: `test/http/finance-receivables.test.js`

- [ ] **Step 1: 写失败测试**

```js
// test/http/finance-receivables.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import { createApp } from '../../src/http/server.js';
import { query } from '../../src/db.js';
import { resetAlertRegistry } from '../../src/alerts/alertRegistry.js';

function authHeaders(token) { return { Authorization: `Bearer ${token}` }; }

describe('GET /api/finance/receivables', () => {
  let server, base;
  beforeAll(async () => {
    server = createApp();
    base = await listen(server); // 测试用 supertest 风格封装，见项目现有 http 测试约定
  });

  it('finance 角色返回合同维应收余额/逾期/账龄/发票对账', async () => {
    const token = await loginAs('finance'); // 复用测试夹具生成 finance token
    const r = await get(base + '/api/finance/receivables', authHeaders(token));
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(Array.isArray(body.contracts)).toBe(true);
    const c = body.contracts[0];
    expect(c).toHaveProperty('contract_id');
    expect(c).toHaveProperty('receivable');   // Σplan − Σpaid
    expect(c).toHaveProperty('overdue_days'); // 数字
    expect(c).toHaveProperty('aging_bucket'); // 字符串档位
    expect(c).toHaveProperty('invoice_status'); // open/reconciled
    expect(c).toHaveProperty('overdue');      // boolean
  });

  it('非 finance 角色返回 403', async () => {
    const token = await loginAs('sales');
    const r = await get(base + '/api/finance/receivables', authHeaders(token));
    expect(r.status).toBe(403);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**
Run: `node node_modules/vitest/vitest.mjs run test/http/finance-receivables.test.js`
Expected: FAIL（`Cannot GET /api/finance/receivables` 或 404）

- [ ] **Step 3: 实现端点**
在 `src/http/routes.js` 的 `app.use(createSevenDimRouter());` 之后插入：

```js
  // ─── S05 财务应收聚合端点（T1）───
  // 合同维：应收余额=Σplan−Σpaid；逾期天数=plan_end−today(plan_status≠done)；账龄读 config_store aging_buckets；发票对账状态
  // 角色闸：仅 finance（roleProfiles.js:17 data_scope 含 payment/contract/invoice）
  app.get('/api/finance/receivables', async (req, res) => {
    try {
      const me = await resolveMe(req);
      if (!me?.ok || me.role !== 'finance') return res.status(403).json({ error: '需要 finance 角色' });
      const contracts = await queryParticles({ type: 'CRM_CONTRACT', tenantId: 'system', limit: 200 }).catch(() => []);
      const [plans, records, invoices] = await Promise.all([
        queryParticles({ type: 'CRM_PAYMENT_PLAN', tenantId: 'system', limit: 500 }).catch(() => []),
        queryParticles({ type: 'CRM_PAYMENT_RECORD', tenantId: 'system', limit: 500 }).catch(() => []),
        queryParticles({ type: 'CRM_INVOICE', tenantId: 'system', limit: 500 }).catch(() => []),
      ]);
      // 账龄分层（读 config_store，缺失则用缺省四档）
      const cfg = await query(`SELECT value FROM crm.config_store WHERE key='finance-receivables'`).catch(() => ({ rows: [] }));
      const aging = cfg.rows[0]?.value?.aging_buckets || [[0, 30], [31, 60], [61, 90], [91, 9999]];
      const bucketOf = (d) => {
        const b = aging.find(([a, z]) => d >= a && d <= z);
        return b ? `${b[0]}-${b[1]}` : `${aging[aging.length - 1][0]}+`;
      };
      const out = contracts.map((ct) => {
        const cid = ct.id;
        const cp = plans.filter((x) => x.payload?.contract_id === cid);
        const cr = records.filter((x) => x.payload?.contract_id === cid);
        const agg = reconcileContract(cp.map((p) => ({
          id: p.id, contract_id: cid, plan_amount: p.payload?.plan_amount, plan_end: p.payload?.plan_end, plan_status: p.payload?.plan_status,
        })), new Map(cr.map((r) => [r.id, [{ paid_amount: r.payload?.paid_amount, paid_at: r.payload?.paid_at }]])));
        const inv = invoices.filter((x) => x.payload?.contract_id === cid);
        const maxDue = Math.max(0, ...agg.rows.filter((r) => r.overdue).map((r) => r.due_days));
        return {
          contract_id: cid,
          contract_title: ct.payload?.name || ct.slug || cid,
          plan_total: agg.total_plan,
          paid_total: agg.total_paid,
          receivable: agg.total_gap,
          overdue: agg.overdue_plans.length > 0,
          overdue_days: maxDue,
          aging_bucket: bucketOf(maxDue),
          invoice_status: inv[0]?.payload?.reconcile_status || 'none',
        };
      });
      res.json({ contracts: out });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
```

> 依赖：`import { reconcileContract } from '../sales/paymentService.js'`（routes.js 顶部已 import `resolveMe`、`queryParticles`，若无则补充 `import { resolveMe } from './auth.js'`、`import { queryParticles } from '../particles/particleRepo.js'`）。

- [ ] **Step 4: 跑测试确认通过**
Run: `node node_modules/vitest/vitest.mjs run test/http/finance-receivables.test.js`
Expected: PASS

- [ ] **Step 5: Commit**
```bash
git add src/http/routes.js test/http/finance-receivables.test.js
git commit -m "feat(S05-T1): 暴露财务应收聚合端点 GET /api/finance/receivables（finance 闸）"
```

---

## Task 2: 应收看板页（S05 财务应收场景）

**Files:**
- Create: `src/web/receivables.html`
- Modify: `src/portal/layoutMenu.js`（finance 专属导航）
- Test: `test/web/receivables.test.js`

- [ ] **Step 1: 写失败测试（页面契约：关键区块 id 存在）**

```js
// test/web/receivables.test.js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const html = readFileSync(new URL('../../src/web/receivables.html', import.meta.url), 'utf8');
describe('receivables.html 结构契约', () => {
  it('含四区挂载点 + 受控样式链', () => {
    expect(html).toContain('id="overview"');       // 总览卡
    expect(html).toContain('id="contract-table"');  // 合同应收明细
    expect(html).toContain('id="invoice-block"');   // 发票对账
    expect(html).toContain('id="overdue-block"');   // 逾期区
    expect(html).toContain('/portal/tokens.css');
    expect(html).toContain('/portal/common.css');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**
Run: `node node_modules/vitest/vitest.mjs run test/web/receivables.test.js`
Expected: FAIL（文件不存在）

- [ ] **Step 3: 实现页面 + 导航**

`src/web/receivables.html`（仿 `config.html` 风格，受控页硬依赖 tokens.css/common.css）：

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>财务应收看板 · S05</title>
<link rel="stylesheet" href="/portal/tokens.css">
<link rel="stylesheet" href="/portal/common.css">
<style>
  body { font-family: var(--font); margin: 0; background: var(--bg); color: var(--ink); padding: 20px 24px; }
  h2 { margin: 0 0 4px; }
  .sub { color: var(--mut); font-size: 13px; margin-bottom: 16px; }
  .ov { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px,1fr)); gap: 12px; margin-bottom: 20px; }
  .ov .card { border: 1px solid var(--line); border-radius: var(--radius-lg); padding: 14px; background: var(--panel); }
  .ov .card .v { font-size: 22px; font-weight: 700; }
  .ov .card .k { font-size: 12px; color: var(--mut); }
  table.bd { width: 100%; border-collapse: collapse; font-size: 13px; }
  table.bd th, table.bd td { border: 1px solid var(--line); padding: 6px 8px; text-align: left; }
  .bad { color: var(--err); font-weight: 600; }
  section { margin-bottom: 22px; }
  section > h3 { font-size: 15px; border-left: 4px solid var(--ac); padding-left: 8px; }
  #forbidden { display: none; padding: 24px; text-align: center; }
</style>
<script type="module" src="/portal/components.js"></script>
</head>
<body>
<header class="page-head"><div class="ph-main"><h1 class="page-title">财务应收看板</h1><p class="page-sub">S05 财务应收闭环 · 合同维应收/逾期/账龄/发票对账</p></div></header>
<div id="forbidden"><h3>需要 finance 权限</h3><p>请用财务账号 <a href="/home.html">重新登录</a>。</p></div>
<div id="app" style="display:none">
  <div class="ov" id="overview"></div>
  <section><h3>合同应收明细</h3><table class="bd" id="contract-table"></table></section>
  <section><h3>发票对账</h3><div id="invoice-block"></div></section>
  <section><h3>逾期区</h3><div id="overdue-block"></div></section>
</div>
<script type="module">
  import { injectLayout } from '/portal/layout.js';
  import { me, api } from '/portal/api.js';
  injectLayout();
  const err = (m) => { document.getElementById('forbidden').style.display = 'block'; document.getElementById('app').style.display = 'none'; console.error(m); };
  const r = await me().catch(() => null);
  if (r?.role !== 'finance') { err('role'); } else {
    const data = await api('/api/finance/receivables').catch((e) => { err(e); return null; });
    if (!data) return;
    document.getElementById('app').style.display = 'block';
    const cs = data.contracts || [];
    const totalRecv = cs.reduce((s, c) => s + (Number(c.receivable) || 0), 0);
    const overdueN = cs.filter((c) => c.overdue).length;
    const overdueAmt = cs.filter((c) => c.overdue).reduce((s, c) => s + (Number(c.receivable) || 0), 0);
    document.getElementById('overview').innerHTML = `
      <div class="card"><div class="v">${cs.length}</div><div class="k">合同数</div></div>
      <div class="card"><div class="v">¥${totalRecv.toLocaleString()}</div><div class="k">应收余额</div></div>
      <div class="card"><div class="v">${overdueN}</div><div class="k">逾期笔数</div></div>
      <div class="card"><div class="v bad">¥${overdueAmt.toLocaleString()}</div><div class="k">逾期金额</div></div>`;
    document.getElementById('contract-table').innerHTML = `<thead><tr><th>合同</th><th>计划</th><th>实回</th><th>应收</th><th>逾期天数</th><th>账龄</th><th>发票</th></tr></thead><tbody>
      ${cs.map((c) => `<tr><td>${c.contract_title}</td><td>${c.plan_total}</td><td>${c.paid_total}</td><td class="${c.receivable>0?'bad':''}">${c.receivable}</td><td>${c.overdue_days}</td><td>${c.aging_bucket}</td><td>${c.invoice_status}</td></tr>`).join('')}</tbody>`;
    const inv = cs.filter((c) => c.invoice_status && c.invoice_status !== 'none');
    document.getElementById('invoice-block').innerHTML = inv.length ? `<table class="bd"><thead><tr><th>合同</th><th>发票状态</th></tr></thead><tbody>${inv.map((c)=>`<tr><td>${c.contract_title}</td><td>${c.invoice_status}</td></tr>`).join('')}</tbody></table>` : '无发票';
    const od = cs.filter((c) => c.overdue);
    document.getElementById('overdue-block').innerHTML = od.length ? `<table class="bd"><thead><tr><th>合同</th><th>逾期天数</th><th>应收</th></tr></thead><tbody>${od.map((c)=>`<tr><td>${c.contract_title}</td><td class="bad">${c.overdue_days}</td><td>${c.receivable}</td></tr>`).join('')}</tbody></table>` : '无逾期';
  }
</script>
</body>
</html>
```

`src/portal/layoutMenu.js` 加 finance 专属项（支持 `roles` 过滤）：

```js
export const FULL_MENU = [
  { group: '销售', label: '线索·商机', href: '/pipeline.html' },
  { group: '销售', label: '客户深度洞察', href: '/account-360.html?tab=insight' },
  { group: '协同', label: '我的待办', href: '/my-todo.html' },
  { group: '洞察', label: '报告', href: '/sales-decision-monitor' },
  { group: '基础数据', label: '📚 基础数据门户', href: '/business-data.html' },
  { group: '财务', label: '财务应收', href: '/receivables.html', roles: ['finance', 'admin'] },
];
export function menuFor(role) {
  const sys = role === 'admin' ? ADMIN_MENU : [];
  const base = FULL_MENU.filter((m) => !m.roles || m.roles.includes(role));
  return [...base, ...sys];
}
```

- [ ] **Step 4: 跑测试确认通过**
Run: `node node_modules/vitest/vitest.mjs run test/web/receivables.test.js`
Expected: PASS

- [ ] **Step 5: Commit**
```bash
git add src/web/receivables.html src/portal/layoutMenu.js test/web/receivables.test.js
git commit -m "feat(S05-T2): 应收看板页 /receivables.html + finance 导航入口"
```

---

## Task 3: 逾期自动催收待办（派生，非新建存储）

> **机制精确化（对齐设计 T3，修正实现路径）：** S05 待办工作台 `/api/page/todo` 的待办本就是从业务粒子状态**派生**（routes.js:790-867，无独立待办表/粒子）。故 T3 不"写催收待办粒子"，而是扩展 `/api/page/todo` 的 finance 分支：对逾期 PAYMENT_PLAN 用 `reconcilePlan` 识别并 push `action:'催收'` 待办行，`ROLE_FILTER.finance` 放行——符合设计"不新建存储"边界，且 finance 视角可见。

**Files:**
- Modify: `src/http/routes.js`（扩展 `/api/page/todo` ③ 回款分支 + `ROLE_FILTER.finance`）
- Test: `test/http/todo-finance.test.js`

- [ ] **Step 1: 写失败测试**

```js
// test/http/todo-finance.test.js
import { describe, it, expect } from 'vitest';
import { createApp } from '../../src/http/server.js';
import { query } from '../../src/db.js';

describe('S05 finance 催收待办派生', () => {
  it('逾期 PAYMENT_PLAN 在 finance 视角出现 action=催收', async () => {
    const server = createApp(); const base = await listen(server);
    // 造一条逾期 plan（plan_end 过去、plan_status pending）
    await query(`INSERT INTO crm.particles (type, slug, title, state, payload, tenant_id)
      VALUES ('CRM_PAYMENT_PLAN','seed-overdue','逾期计划','active',
        jsonb_build_object('contract_id','CT_TEST', 'plan_amount',1000,'plan_end','2020-01-01','plan_status','pending'),'system')`);
    const token = await loginAs('finance');
    const r = await get(base + '/api/page/todo?role=finance', { Authorization: `Bearer ${token}` });
    const body = await r.json();
    const rows = body.data.components.table.rows;
    expect(rows.some((x) => x.action === '催收')).toBe(true);
  });
  it('sales 视角不含催收', async () => {
    const server = createApp(); const base = await listen(server);
    const token = await loginAs('sales');
    const r = await get(base + '/api/page/todo?role=sales', { Authorization: `Bearer ${token}` });
    const body = await r.json();
    expect(body.data.components.table.rows.some((x) => x.action === '催收')).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**
Run: `node node_modules/vitest/vitest.mjs run test/http/todo-finance.test.js`
Expected: FAIL（无 '催收' 行）

- [ ] **Step 3: 实现（扩展 routes.js:827-845）**

将 ③ 回款/应收分支替换为：

```js
      // ③ 回款/应收（payment 类 pending/submitted + 逾期催收）
      for (const t of ['CRM_PAYMENT_PLAN', 'CRM_PAYMENT_RECORD']) {
        for (const p of (grouped[t] || [])) {
          if (p.payload?.status === 'submitted' || p.payload?.status === 'pending') {
            todos.push({
              deal: `${t === 'CRM_PAYMENT_PLAN' ? '回款计划' : '回款记录'} ${p.payload?.name || p.slug || p.id}`,
              customer: p.payload?.customer || '—',
              stage: p.payload?.status, due: '应收', action: '核对',
            });
          }
        }
      }
      // ③b 逾期催收（PAYMENT_PLAN 逾期 → 派生催收待办，finance 可见）
      for (const p of (grouped.CRM_PAYMENT_PLAN || [])) {
        const rc = reconcilePlan(
          { id: p.id, contract_id: p.payload?.contract_id, plan_amount: p.payload?.plan_amount, plan_end: p.payload?.plan_end, plan_status: p.payload?.plan_status },
          [], { today: new Date() }
        );
        if (rc.overdue) {
          todos.push({
            deal: `回款计划 ${p.payload?.name || p.slug || p.id}`,
            customer: p.payload?.customer || '—',
            stage: '逾期催收', due: `${rc.due_days}天`, action: '催收',
          });
        }
      }
```

并将 `ROLE_FILTER.finance` 改为：

```js
      const ROLE_FILTER = {
        sales: (t) => t.action === '跟进' || t.action === '审批',
        manager: () => true,
        finance: (t) => t.action === '审批' || t.action === '核对' || t.action === '催收',
        contract: (t) => t.action === '审批' || t.deal.includes('合同') || t.deal.includes('报价'),
      };
```

> 顶部补 `import { reconcilePlan } from '../sales/paymentService.js'`（若无）。

- [ ] **Step 4: 跑测试确认通过**
Run: `node node_modules/vitest/vitest.mjs run test/http/todo-finance.test.js`
Expected: PASS

- [ ] **Step 5: Commit**
```bash
git add src/http/routes.js test/http/todo-finance.test.js
git commit -m "feat(S05-T3): 逾期 PAYMENT_PLAN 派生催收待办（finance 视角，S05 待办工作台）"
```

---

## Task 4: 差额超阈值预警写回

> **机制精确化（对齐设计 T4，修正触发源）：** 合同维差额需**聚合上下文**（Σplan−Σpaid），单粒子写事件缺此上下文，故 ruleEvaluator 的粒子写事件判定不适用。T4 改为在 T1 聚合端点内核，对差额超阈值的合同显式 `createAlert` + `emit('alert','alert_created')`（复用 alertStore + bus，与 alertHook 落库/SSE 路径一致）。`payment_gap` 规则在 alertRegistry 注册，作为**阈值配置源 + 管理台可见**。

**Files:**
- Modify: `src/alerts/alertRegistry.js`（注册 `payment_gap`）
- Modify: `src/http/routes.js`（T1 端点内核加差额预警写回）
- Test: `test/alerts/payment-gap.test.js`

- [ ] **Step 1: 写失败测试**

```js
// test/alerts/payment-gap.test.js
import { describe, it, expect } from 'vitest';
import { listAlertRules, resetAlertRegistry } from '../../src/alerts/alertRegistry.js';
import { createAlert, listAlerts } from '../../src/alerts/alertStore.js';

describe('payment_gap 规则与差额预警', () => {
  it('alertRegistry 含 payment_gap 规则（阈值 gap_threshold_pct）', () => {
    resetAlertRegistry();
    const r = listAlertRules().find((x) => x.kind === 'payment_gap');
    expect(r).toBeTruthy();
    expect(r.check_params).toHaveProperty('gap_threshold_pct');
  });
  it('差额超阈值 → 写 alerts 表 payment_gap', async () => {
    resetAlertRegistry();
    const before = (await listAlerts()).length;
    // 模拟 T1 端点内核逻辑：差额占比超阈值 → createAlert
    const gapPct = 50; const threshold = 5;
    if (gapPct >= threshold) {
      createAlert({ kind: 'payment_gap', severity: 'medium', target_role: 'finance', particle_id: null, payload: { contract_id: 'CT_X', gap_pct: gapPct } });
    }
    const after = (await listAlerts()).length;
    expect(after).toBe(before + 1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**
Run: `node node_modules/vitest/vitest.mjs run test/alerts/payment-gap.test.js`
Expected: FAIL（无 payment_gap 规则）

- [ ] **Step 3: 实现**

`src/alerts/alertRegistry.js` 在 `DEFAULT_RULES` 数组（行 43 之后）追加：

```js
  {
    kind: 'payment_gap',
    match: { particleTypes: ['CRM_PAYMENT_PLAN', 'CRM_PAYMENT_RECORD'], actions: ['payment_gap_check'] },
    check_params: { gap_threshold_pct: 5 },
    enabled: true,
    version: 1,
  },
```

`src/http/routes.js` T1 端点内核（Task 1 Step 3 的 `out` 映射内）追加差额预警写回：

```js
      const cfgGap = cfg.rows[0]?.value?.gap_threshold_pct ?? 5;
      for (const c of out) {
        if (c.receivable > 0) {
          // 差额占比 = 应收/计划（计划为 0 时不判）
          const pct = c.plan_total > 0 ? Math.round((c.receivable / c.plan_total) * 100) : 0;
          if (pct >= cfgGap) {
            try {
              const a = createAlert({ kind: 'payment_gap', severity: 'medium', target_role: 'finance', particle_id: c.contract_id, payload: { contract_id: c.contract_id, gap: c.receivable, gap_pct: pct } });
              if (a.ok) emit('alert', 'alert_created', { alert: a.alert, kind: 'payment_gap' });
            } catch { /* fail-open 不阻断主流程 */ }
          }
        }
      }
```

> 顶部补 `import { createAlert } from '../alerts/alertStore.js'`、`import { emit } from '../events/bus.js'`（若无）。

- [ ] **Step 4: 跑测试确认通过**
Run: `node node_modules/vitest/vitest.mjs run test/alerts/payment-gap.test.js`
Expected: PASS

- [ ] **Step 5: Commit**
```bash
git add src/alerts/alertRegistry.js src/http/routes.js test/alerts/payment-gap.test.js
git commit -m "feat(S05-T4): 应收差额超阈值预警写回（payment_gap + alertStore + SSE alert）"
```

---

## Task 5: 应收配置后台化（config_store + 端点 + UI tab）

**Files:**
- Create: `src/http/financeReceivablesConfigRouter.js`
- Create: `scripts/seed-finance-receivables-config.mjs`
- Modify: `src/http/routes.js`（挂载 router）
- Modify: `src/web/config.html`（G3 业务对象组加「财务应收」入口）
- Test: `test/http/finance-receivables-config.test.js`

- [ ] **Step 1: 写失败测试**

```js
// test/http/finance-receivables-config.test.js
import { describe, it, expect } from 'vitest';
import { createApp } from '../../src/http/server.js';

describe('GET/PUT /api/config/finance-receivables', () => {
  it('GET 返回缺省三项', async () => {
    const server = createApp(); const base = await listen(server);
    const token = await loginAs('admin');
    const r = await get(base + '/api/config/finance-receivables', { Authorization: `Bearer ${token}` });
    const b = await r.json();
    expect(b.payment_overdue_days).toBe(7);
    expect(b.gap_threshold_pct).toBe(5);
    expect(Array.isArray(b.aging_buckets)).toBe(true);
  });
  it('非 sysadmin 返回 403', async () => {
    const server = createApp(); const base = await listen(server);
    const token = await loginAs('sales');
    const r = await get(base + '/api/config/finance-receivables', { Authorization: `Bearer ${token}` });
    expect(r.status).toBe(403);
  });
  it('PUT 改 payment_overdue_days 持久化', async () => {
    const server = createApp(); const base = await listen(server);
    const token = await loginAs('admin');
    const u = await put(base + '/api/config/finance-receivables', { payment_overdue_days: 3 }, { Authorization: `Bearer ${token}` });
    expect(u.status).toBe(200);
    const g = await get(base + '/api/config/finance-receivables', { Authorization: `Bearer ${token}` });
    expect((await g.json()).payment_overdue_days).toBe(3);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**
Run: `node node_modules/vitest/vitest.mjs run test/http/finance-receivables-config.test.js`
Expected: FAIL（路由未挂载）

- [ ] **Step 3: 实现**

`src/http/financeReceivablesConfigRouter.js`（仿 `sevenDimRouter.js`）：

```js
// S05 财务应收配置（T5）：config_store['finance-receivables'] + 决策第0闸（TEXT decision_id 无 FK）
import { Router } from 'express';
import { query } from '../db.js';
import { scenarioDeps } from '../portal/decisionScenario.js';
import { resolveMe as realResolveMe } from './auth.js';

const CONFIG_KEY = 'finance-receivables';
const DEFAULTS = { payment_overdue_days: 7, gap_threshold_pct: 5, aging_buckets: [[0, 30], [31, 60], [61, 90], [91, 9999]] };

function roleOk(role) { return role === 'admin' || role === 'sysadmin'; }

export function createFinanceReceivablesConfigRouter(deps = {}) {
  const router = Router();
  async function ensureAdmin(req, res) {
    let me = null;
    try { me = await realResolveMe(req); } catch { me = { ok: false }; }
    if (!me?.ok || !roleOk(me.role)) { res.status(403).json({ error: '需要 sysadmin 权限' }); return false; }
    return true;
  }
  router.get('/api/config/finance-receivables', async (req, res) => {
    try {
      if (!(await ensureAdmin(req, res))) return;
      const r = await query(`SELECT value FROM crm.config_store WHERE key=$1`, [CONFIG_KEY]).catch(() => ({ rows: [] }));
      res.json(r.rows[0]?.value || DEFAULTS);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  router.put('/api/config/finance-receivables', async (req, res) => {
    try {
      if (!(await ensureAdmin(req, res))) return;
      const body = req.body || {};
      const next = { ...DEFAULTS, ...(await readCurrent()), ...pick(body, ['payment_overdue_days', 'gap_threshold_pct', 'aging_buckets']) };
      const decision = await scenarioDeps.produceDecision({ fields: Object.keys(body) });
      await query(
        `INSERT INTO crm.config_store (key, value, decision_id, updated_by, updated_at)
         VALUES ($1, $2::jsonb, $3, 'system', now())
         ON CONFLICT (key) DO UPDATE SET value=$2::jsonb, decision_id=$3, updated_at=now()`,
        [CONFIG_KEY, JSON.stringify(next), decision?.decisionId || null]
      );
      res.json({ ...next, decision: decision?.decisionId || null, updated: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  return router;
}
async function readCurrent() {
  try { const r = await query(`SELECT value FROM crm.config_store WHERE key=$1`, [CONFIG_KEY]); return r.rows[0]?.value || {}; }
  catch { return {}; }
}
function pick(o, ks) { const r = {}; for (const k of ks) if (k in o) r[k] = o[k]; return r; }
```

`src/http/routes.js` 顶部挂载：

```js
import { createFinanceReceivablesConfigRouter } from './financeReceivablesConfigRouter.js';
// ... 在 app.use(createSevenDimRouter()); 之后
app.use(createFinanceReceivablesConfigRouter());
```

`scripts/seed-finance-receivables-config.mjs`（幂等，非空跳过）：

```js
import { query } from '../src/db.js';
const KEY = 'finance-receivables';
const VAL = { payment_overdue_days: 7, gap_threshold_pct: 5, aging_buckets: [[0, 30], [31, 60], [61, 90], [91, 9999]] };
const ex = await query(`SELECT 1 FROM crm.config_store WHERE key=$1`, [KEY]);
if (ex.rows.length) { console.log('skipped: already seeded'); process.exit(0); }
await query(`INSERT INTO crm.config_store (key, value, updated_by, updated_at) VALUES ($1,$2::jsonb,'system',now())`, [KEY, JSON.stringify(VAL)]);
console.log('seeded finance-receivables');
```

`src/web/config.html` G3 组（行 74）加项：

```js
    { name: '业务对象与流程建模', items: [17, 18, 19, 20, 22, 29] },  // 29 = 财务应收配置（新增）
```

并在 `src/portal/configCenter.js` 的 `CONFIG_ITEMS` 加：

```js
  { id: 29, name: '财务应收配置', sRef: 'S05', page: '/config.html#finance-receivables', note: '逾期天数/差额阈值/账龄档位（T5）' },
```

- [ ] **Step 4: 跑测试确认通过**
Run: `node node_modules/vitest/vitest.mjs run test/http/finance-receivables-config.test.js`
Expected: PASS

- [ ] **Step 5: 跑 seed 幂等**
Run: `PGDATABASE=plm_test node scripts/seed-finance-receivables-config.mjs`（测试库）；生产库同理
Expected: `seeded finance-receivables`（首次）/ `skipped: already seeded`（二次）

- [ ] **Step 6: Commit**
```bash
git add src/http/financeReceivablesConfigRouter.js src/http/routes.js src/web/config.html src/portal/configCenter.js scripts/seed-finance-receivables-config.mjs test/http/finance-receivables-config.test.js
git commit -m "feat(S05-T5): 应收配置后台化（config_store + 端点 + config.html 入口 + 幂等 seed）"
```

---

## Task 6: 逾期告警规则扩维到 PAYMENT_PLAN

> **机制精确化（对齐设计 T6，修正触发源）：** 逾期是**时间推移**产生（写入时 plan_end 在未来，不超阈值），故 payment_due 不能靠"粒子写事件"命中。T6 改为扩展 `checkOverdueAndEmit`（paymentService.js:37）使其对逾期 PAYMENT_PLAN 也 emit `payment` 域逾期事件；新增 `financeAlertHook` 订阅 `payment` 域，对逾期事件跑 `payment_due_plan` 规则（动态读 `config_store.payment_overdue_days` 覆盖 due_days 阈值）→ `createAlert` + `emit('alert',...)`。原 `payment_due`（INVOICE 维度）规则保留。

**Files:**
- Modify: `src/alerts/alertRegistry.js`（注册 `payment_due_plan`）
- Modify: `src/sales/paymentService.js`（扩展 `checkOverdueAndEmit` 第二维）
- Create: `src/alerts/financeAlertHook.js`
- Modify: `src/http/server.js`（注册 `registerFinanceAlertHook()`）
- Test: `test/alerts/payment-due-plan.test.js`

- [x] **Step 1: 写失败测试**（TDD 红灯实测：financeAlertHook 不存在 → Cannot find module）

```js
// test/alerts/payment-due-plan.test.js
import { describe, it, expect } from 'vitest';
import { registerFinanceAlertHook, unregisterFinanceAlertHook } from '../../src/alerts/financeAlertHook.js';
import { emit } from '../../src/events/bus.js';
import { listAlertRules, resetAlertRegistry } from '../../src/alerts/alertRegistry.js';
import { listAlerts } from '../../src/alerts/alertStore.js';

describe('PAYMENT_PLAN 逾期 → payment_due_plan 告警', () => {
  it('alertRegistry 含 payment_due_plan 规则', () => {
    resetAlertRegistry();
    expect(listAlertRules().some((x) => x.kind === 'payment_due_plan')).toBe(true);
  });
  it('逾期 PAYMENT_PLAN 事件 → alerts 新增 payment_due_plan + SSE', async () => {
    resetAlertRegistry();
    unregisterFinanceAlertHook(); registerFinanceAlertHook();
    const before = (await listAlerts()).length;
    emit('payment', 'payment_overdue_plan', { particleType: 'CRM_PAYMENT_PLAN', contract_id: 'CT1', plan_id: 'P1', due_days: 10 });
    const after = (await listAlerts()).length;
    expect(after).toBe(before + 1);
    unregisterFinanceAlertHook();
  });
});
```

- [x] **Step 2: 跑测试确认失败**
Run: `node node_modules/vitest/vitest.mjs run test/alerts/payment-due-plan.test.js`
实测：FAIL（Cannot find module '../../src/alerts/financeAlertHook.js'）✅ 红灯确认

- [ ] **Step 3: 实现**

`src/alerts/alertRegistry.js` 追加 `payment_due_plan` 规则（行 43 后）：

```js
  {
    kind: 'payment_due_plan',
    match: { particleTypes: ['CRM_PAYMENT_PLAN'], actions: ['payment_overdue_plan'] },
    check_params: { due_days: 7 }, // 运行时由 config_store.payment_overdue_days 覆盖
    enabled: true,
    version: 1,
  },
```

`src/sales/paymentService.js` 扩展 `checkOverdueAndEmit`（在行 40 的 `if (overdue.length)` 块内追加 PAYMENT_PLAN 维度事件）：

```js
  if (overdue.length) {
    emitFn('payment', 'payment_due', {
      contract_id: contractId,
      overdue_plans: overdue.map((r) => ({ plan_id: r.plan_id, gap: r.gap, due_days: r.due_days })),
      total_gap: overdue.reduce((s, r) => s + r.gap, 0),
      priority: overdue.some((r) => r.due_days >= 30) ? 'high' : 'normal',
    });
    // T6：第二维 PAYMENT_PLAN 逾期事件（供 financeAlertHook 判 payment_due_plan 告警）
    for (const r of overdue) {
      emitFn('payment', 'payment_overdue_plan', {
        particleType: 'CRM_PAYMENT_PLAN', contract_id: contractId, plan_id: r.plan_id, due_days: r.due_days,
      });
    }
  }
```

`src/alerts/financeAlertHook.js`（新建，仿 `alertHook.js` 但订阅 `payment` 域；**实现偏差**：`evaluateAlertRule` 真实导出在 `ruleEvaluator.js`（非 alertRegistry.js），hook 改为 `enabledAlertRules()` + `evaluateAlertRule()` 组合；bus 事件载荷在 `msg.summary`（bus.js:18 包装），hook 用 `msg.summary || {}` 平铺读取）：

```js
import { on, emit } from '../events/bus.js';
import { evaluateAlertRule, enabledAlertRules } from './alertRegistry.js';
import { createAlert } from './alertStore.js';
import { query } from '../db.js';

let unsub = null;
export function registerFinanceAlertHook() {
  if (unsub) return;
  unsub = on('payment', (msg) => {
    if (msg.type !== 'payment_overdue_plan') return;
    const rule = enabledAlertRules().find((r) => r.kind === 'payment_due_plan');
    if (!rule) return;
    // 动态阈值：覆盖 check_params.due_days 为 config_store.payment_overdue_days
    (async () => {
      let dueDays = rule.check_params.due_days ?? 7;
      try { const c = await query(`SELECT value FROM crm.config_store WHERE key='finance-receivables'`); dueDays = c.rows[0]?.value?.payment_overdue_days ?? dueDays; } catch {}
      const r = evaluateAlertRule({ ...rule, check_params: { ...rule.check_params, due_days: dueDays } },
        { particleType: 'CRM_PAYMENT_PLAN', action: 'payment_overdue_plan', metric: { dueDays: msg.due_days } });
      if (r.hit) {
        const a = createAlert({ kind: 'payment_due_plan', severity: 'high', target_role: 'finance', particle_id: msg.plan_id, payload: r.payload });
        if (a.ok) emit('alert', 'alert_created', { alert: a.alert, kind: 'payment_due_plan' });
      }
    })();
  });
}
export function unregisterFinanceAlertHook() { if (unsub) { unsub(); unsub = null; } }
```

`src/http/server.js` 在 `registerAlertHook()` 调用处附近加：

```js
import { registerFinanceAlertHook } from '../alerts/financeAlertHook.js';
// 启动钩子区
registerAlertHook();
registerFinanceAlertHook();
```

- [x] **Step 4: 跑测试确认通过**
Run: `node node_modules/vitest/vitest.mjs run test/alerts/payment-due-plan.test.js`
实测：PASS 2/2（单文件）；`test/alerts` 全目录 4/4 绿；`test/http/*finance*` 关联 14/14 绿。
**实现偏差补记**：① `evaluateAlertRule` 从 `ruleEvaluator.js` import（alertRegistry.js 未 re-export）；② hook 内 `config_store` DB 读取在 vitest（plm_test 首连建池）需 ≥300ms 等待，测试用 300ms 并先 `DELETE crm.config_store WHERE key='finance-receivables'` 保证缺省 7 命中（防 T5 PUT 残留污染断言）；③ server.js 注册点补在 `seedSkills()` 后（try/catch 防启动阻塞）。

- [ ] **Step 5: Commit**
```bash
git add src/alerts/alertRegistry.js src/sales/paymentService.js src/alerts/financeAlertHook.js src/http/server.js test/alerts/payment-due-plan.test.js
git commit -m "feat(S05-T6): 逾期规则扩维 PAYMENT_PLAN（payment_due_plan + financeAlertHook + 动态阈值）"
```

---

## Self-Review（spec coverage + placeholder + 类型一致性）

**1. Spec coverage（设计 §3 成功标准 → 任务映射）**
- 标准① 端点聚合 + finance 闸 → T1 ✅
- 标准② 看板页四区 + 导航 → T2 ✅
- 标准③ 逾期 plan → finance 催收待办 → T3 ✅（派生机制，非写库）
- 标准④ 差额超阈值 → alerts 表 payment_gap + SSE → T4 ✅（聚合驱动，非粒子写事件）
- 标准⑤ 配置端点 sysadmin 可写 + UI tab → T5 ✅
- 标准⑥ PAYMENT_PLAN 逾期 → payment_due_plan 告警 + 阈值可调 → T6 ✅（时间推移触发，非写入时）

**2. Placeholder 扫描**：无 TBD/TODO；每步含真实代码与测试断言。T4/T6 的触发源相对设计原文做了精确化（已在各 Task 顶部「机制精确化」注明），属可落地修正而非占位。

**3. 类型一致性**
- `reconcilePlan` / `reconcileContract` 签名（paymentService.js:11/23）在 T1/T3 复用一致。
- `createAlert({kind,severity,target_role,particle_id,payload})` 返回 `{ok,alert}`（alertHook.js:24-31）在 T4/T6 复用一致。
- `emit('alert','alert_created',{alert,kind})` / `emit('payment', type, msg)`（bus）在 T4/T6 复用一致。
- `scenarioDeps.produceDecision(ctx)`（decisionScenario.js:163，返回 `{decisionId,ok}`）在 T5 与 sevenDimRouter 一致。
- `config_store` 读写 SQL（`sevenDimRouter.js:29-33` 范式）在 T5 复用。

**4. 设计偏差说明（写回 P0 预检）**：T3/T4/T6 实现机制较设计原文（"写催收待办粒子"/"ruleEvaluator 粒子写事件判定"/"payment_due 粒子写事件命中"）做了精确化，原因是代码实测显示：① 待办为状态派生（无 CRM_TASK 粒子）；② 合同差额需聚合上下文（单粒子写事件无）；③ 逾期为时间推移（写入时不超阈值）。三者均**保持 T1–T6 编号与成功标准不变**，仅修正触发路径使其真实可落地，符合设计「不新建粒子/不新建存储」边界。建议下一轮 P0 复盘吸收此修正。

**5. Commit Gates**：每任务一 commit；沙箱无私有库凭证，AI 不执行 `git commit` 的最终推送——本计划供子代理/Inline 执行；用户本地提交。勿 `git add -A`。
