# 公海池菜单查询页 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在销售菜单新增「公海池」入口与独立页 `lead-pool.html`，提供公海（S0）线索明细列表 + 认领闭环，并修复认领竞态与 `pooled_at` 缺失两个上线即带病的缺口。

**Architecture:** 复用现有 `crm-lead-pick` 动作（含池规则校验与自 mint 决策），新增两个 HTTP 端点（`GET /api/lead-pool` 明细、`POST /api/lead-pool/:id/pick` p1Dispatch 范式）；列表数据经 `scopeTenant` 隔离，明细用 `truncated/total` 防截断假绿；认领最终写改为 CAS 直更消除并发重复领取；`pooled_at` 写入源补齐 + 存量幂等回填。

**Tech Stack:** Node/Express（routes.js）、PostgreSQL（crm schema，pgvector 同实例）、原生 ESM 前端（`/portal/layout.js` + `tokens.css`/`common.css`）、vitest（单测）、Node 脚本（E2E）。

---

## File Structure

| 文件 | 职责 | 动作 |
|---|---|---|
| `src/http/routes.js` | 新增两个端点（~line 790 与 ~line 3223 之间） | Modify |
| `src/action/seed-actions.js` | `crm-lead-pick` 改 CAS；4 个回池动作补 `pooled_at` | Modify |
| `src/agent/discoveryOrchestrator.js` | 获客写入源补 `pooled_at` | Modify |
| `src/connectors/tenderConnector.js` | 获客写入源补 `pooled_at` | Modify |
| `src/web/pipeline.html` | 新建直落 S0 补 `pooled_at` | Modify |
| `src/portal/layoutMenu.js` | FULL_MENU 增「公海池」项 | Modify |
| `src/web/lead-pool.html` | 公海明细页（新建） | Create |
| `db/migration-lead-pool-pooled-at.sql` | 存量 `pooled_at` 回填（幂等） | Create |
| `src/db/migrate.js` | 挂载上条迁移（内联执行） | Modify |
| `test/leadPoolPage.test.js` | 端点 + 并发 + 菜单单测 | Create |
| `scripts/e2e-lead-pool-actions.mjs` | 页面链路 E2E 扩展 | Modify |

> **铁律（全程适用）**：绝对禁 `DELETE`；租户隔离读 `scopeTenant`、写 `tenantId ?? null` fail-closed；零硬编码颜色；不新增粒子/Action；不改 `context-routing`；`seed-actions.js` 混多 hunk → **必须 `git add -p`**；AI 不 commit，仅产出 PowerShell 命令（每 Task 一提交）。

---

### Task 1: `GET /api/lead-pool` 公海明细端点

**Files:**
- Modify: `src/http/routes.js`（在 `/api/pool-config` GET 之后，约 line 790）
- Test: `test/leadPoolPage.test.js`

- [ ] **Step 1: 写失败测试**

```js
// test/leadPoolPage.test.js
import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { createTestApp, seedTenant, clearTenant } from './testKit.js'; // 既有测试脚手架（见项目 test/ 既有范式）

describe('GET /api/lead-pool', () => {
  let app, srv, base;
  beforeAll(async () => { ({ app, srv, base } = await createTestApp()); });
  afterAll(async () => { await srv.close(); });

  it('返回 truncated/total 且跨租户不可见', async () => {
    const { tokenA, tokenB } = await seedTenant();
    // A 租户造 120 条 S0
    await seedDeals(tokenA, 120, 'S0');
    await seedDeals(tokenB, 5, 'S0');
    const r = await fetch(`${base}/api/lead-pool`, { headers: { Authorization: `Bearer ${tokenA}` } });
    const j = await r.json();
    expect(j.returned).toBe(100);
    expect(j.truncated).toBe(true);
    expect(j.total).toBe(120);            // 必须真实总数，非 LIMIT
    expect(j.items.every((x) => x.id && typeof x.in_pool_days === 'number')).toBe(true);
    // 跨租户：B 只应见自己 5 条
    const rB = await fetch(`${base}/api/lead-pool`, { headers: { Authorization: `Bearer ${tokenB}` } });
    expect((await rB.json()).total).toBe(5);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --experimental-vm-modules node_modules/.bin/vitest run test/leadPoolPage.test.js`
Expected: FAIL（`/api/lead-pool` 404）

- [ ] **Step 3: 实现端点（追加到 routes.js，紧接 `/api/pool-config` GET 之后）**

```js
// 2026-09-14：公海池明细列表（S0）→ 菜单页 lead-pool.html 数据源（T1）
app.get('/api/lead-pool', async (req, res) => {
  try {
    const me = resolveMe(req);
    if (!me?.ok) return res.status(401).json({ error: '未登录' });
    const tid = scopeTenant(me);
    const LIMIT = 100;
    const r = await query(
      `SELECT id, payload, created_at, updated_at
       FROM crm.particles
       WHERE type='CRM_DEAL' AND tenant_id=$1 AND payload->>'stage'='S0'
       ORDER BY coalesce(NULLIF(payload->>'pooled_at','')::timestamptz, created_at) DESC
       LIMIT $2`,
      [tid, LIMIT + 1]
    );
    const rows = r.rows.slice(0, LIMIT);
    const truncated = r.rows.length > LIMIT;
    const total = truncated
      ? (await query(
          `SELECT count(*)::int n FROM crm.particles WHERE type='CRM_DEAL' AND tenant_id=$1 AND payload->>'stage'='S0'`,
          [tid])).rows[0].n
      : rows.length;
    const { readPoolConfig, poolOf, resolvePoolId } = await import('../sales/pool.js');
    const cfg = await readPoolConfig({ tenantId: tid });
    const pool = poolOf(cfg, resolvePoolId(cfg, {}));
    const ownerKey = me.username || me.display_name || 'user';
    // 我的今日已领数：与 crm-lead-pick handler 同一套 agg SQL（seed-actions.js:887-890）
    const agg = await query(
      `SELECT count(*) FILTER (WHERE NULLIF(payload->>'picked_at','')::timestamptz >= date_trunc('day', now()))::int AS n
       FROM crm.particles
       WHERE type='CRM_DEAL' AND tenant_id=$1 AND payload->>'stage'='S0P' AND payload->>'owner_id'=$2`,
      [tid, ownerKey]
    ).catch(() => ({ rows: [{ n: 0 }] }));
    const myPickToday = agg.rows[0].n;
    const items = rows.map((x) => {
      const p = x.payload || {};
      const pooledAt = new Date(p.pooled_at || p.returned_at || x.created_at);
      const inPoolDays = Math.max(0, Math.floor((Date.now() - pooledAt.getTime()) / 86400000));
      return {
        id: x.id, name: p.name || '(未命名)', source: p.source || '未知',
        pool_type: p.pool_type || 'new', in_pool_days: inPoolDays,
        acct_name: p.account_name || '', est_amount: Number(p.amount) || 0,
      };
    });
    res.json({
      items, total, returned: rows.length, truncated,
      rules: pool.pick_rule,
      my_pick_today: myPickToday,
      my_can_pick: myPickToday < (pool.pick_rule?.daily_limit ?? 999),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --experimental-vm-modules node_modules/.bin/vitest run test/leadPoolPage.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```powershell
git add src/http/routes.js test/leadPoolPage.test.js
git commit -m "feat(lead-pool): GET /api/lead-pool 公海明细端点(S0+truncated+已领数)"
```

---

### Task 2: `POST /api/lead-pool/:id/pick` 认领端点

**Files:**
- Modify: `src/http/routes.js`（紧接 p1Dispatch 语义化端点群，约 line 3223）
- Test: `test/leadPoolPage.test.js`（追加 describe）

- [ ] **Step 1: 写失败测试**

```js
describe('POST /api/lead-pool/:id/pick', () => {
  it('未登录 401', async () => {
    const r = await fetch(`${base}/api/lead-pool/deal_x/pick`, { method: 'POST' });
    expect(r.status).toBe(401);
  });
  it('缺租户 fail-closed（不静默得 system 全权益）', async () => {
    // 用 token 但 tenantId 缺失的测试身份（测试脚手架提供 noTenant token）
    const r = await fetch(`${base}/api/lead-pool/deal_x/pick`, {
      method: 'POST', headers: { Authorization: `Bearer ${noTenantToken}` },
    });
    // crm-lead-pick 经 actionExecutor.dispatch → tenantId=null 触发第 1.7 闸 fail-closed
    expect(r.status).toBe(400);
    expect((await r.json()).ok).toBe(false);
  });
  it('S0 认领成功 → S0P + owner 设置', async () => {
    const { token, dealId } = await seedOneDeal(tokenA, 'S0');
    const r = await fetch(`${base}/api/lead-pool/${dealId}/pick`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` },
    });
    const j = await r.json();
    expect(j.ok).toBe(true);
    const after = await getDeal(dealId, token);
    expect(after.payload.stage).toBe('S0P');
    expect(after.payload.owner_id).toBeTruthy();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `vitest run test/leadPoolPage.test.js` → FAIL（404/405）

- [ ] **Step 3: 实现端点（追加 routes.js）**

```js
// 2026-09-14：公海认领语义化端点（T2）—— p1Ctx 范式（tenantId ?? null fail-closed）
// 复用 crm-lead-pick 动作（池规则校验 + 自 mint 决策全保留）；owner_id 强制为当前登录人，前端不传。
app.post('/api/lead-pool/:id/pick', async (req, res) => {
  try {
    const me = resolveMe(req);
    if (!me?.ok) return res.status(401).json({ error: '未登录' });
    const owner_id = me.username || me.display_name || 'user';
    const r = await actionExecutor.dispatch('crm-lead-pick',
      { deal_id: req.params.id, owner_id },
      { actor: owner_id, role: me.role, tenantId: me.tenantId ?? null, decision_id: null });
    if (!r.ok) return res.status(400).json({ ok: false, gate: r.gate, error: r.error });
    res.json({ ok: true, ...r });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
```

- [ ] **Step 4: 运行确认通过**

Run: `vitest run test/leadPoolPage.test.js` → PASS

- [ ] **Step 5: 提交**

```powershell
git add src/http/routes.js test/leadPoolPage.test.js
git commit -m "feat(lead-pool): POST /api/lead-pool/:id/pick 认领端点(p1Dispatch fail-closed)"
```

---

### Task 3: 缺口① 认领竞态 CAS（crm-lead-pick）

**Files:**
- Modify: `src/action/seed-actions.js`（line 871 改导入；line 915-924 改写入）
- Test: `test/leadPoolPage.test.js`（追加并发 describe）

- [ ] **Step 1: 写并发失败测试**

```js
describe('crm-lead-pick 并发安全（CAS）', () => {
  it('并行两次认领同一条 S0，仅 1 次成功', async () => {
    const { token } = await seedOneDeal(tokenA, 'S0'); // 返回 dealId
    const fire = () => fetch(`${base}/api/lead-pool/${dealId}/pick`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` },
    }).then((r) => r.json());
    const [a, b] = await Promise.all([fire(), fire()]);
    const okCount = [a, b].filter((x) => x.ok === true).length;
    expect(okCount).toBe(1); // 竞态修复前会 = 2（假绿）
    const after = await getDeal(dealId, token);
    expect(after.payload.stage).toBe('S0P');
    expect(after.payload.owner_id).toBeTruthy();
  });
});
```

- [ ] **Step 2: 运行确认失败（竞态存在时 okCount=2）**

Run: `vitest run test/leadPoolPage.test.js` → FAIL

- [ ] **Step 3: 改 handler 导入（line 871）**

```js
// 原：const { query } = await import('../db.js');
const { query, queryWrite } = await import('../db.js');
```

- [ ] **Step 4: 改最终写入为 CAS（替换 line 915-924 的 updateParticle 调用）**

```js
      // 竞态修复（T3）：CAS 直更——WHERE 同时锁 stage=S0 与 owner 空，0 行即已被他人领取
      const ts = new Date().toISOString();
      const cas = await queryWrite(
        `UPDATE crm.particles
         SET payload = payload || jsonb_build_object(
              'stage','S0P','owner_id',$2,'prev_owner_id',$3,
              'picked_at',$4,'pool_id',$5,'pool_type',$6,'pooled_at',NULL),
             updated_at = now()
         WHERE id=$1 AND tenant_id=$7
           AND payload->>'stage'='S0'
           AND coalesce(payload->>'owner_id','')=''
         RETURNING *`,
        [deal_id, owner_id, prev_owner, ts, pool.id, pool.type || 'new', tenantId]
      );
      if (cas.rowCount === 0) throw new Error('已被他人领取或已不在公海，请刷新后重试');
      const updated = cas.rows[0];
```

- [ ] **Step 5: 运行确认通过**

Run: `vitest run test/leadPoolPage.test.js` → PASS（含并发断言）

- [ ] **Step 6: 提交（seed-actions.js 混多 hunk → 必须 git add -p）**

```powershell
git add -p src/action/seed-actions.js   # 仅选 T3 相关 2 个 hunk（导入行 + CAS 改写），跳过无关 hunk
git add test/leadPoolPage.test.js
git commit -m "fix(lead-pool): crm-lead-pick 认领改 CAS 防并发重复领取"
```

---

### Task 4: 缺口② `pooled_at` 补齐（写入源 + 存量回填）

**Files:**
- Modify: `src/agent/discoveryOrchestrator.js:93`、`src/connectors/tenderConnector.js:55`、`src/web/pipeline.html:189`
- Modify: `src/action/seed-actions.js`（line 969-972 / 1026-1029 / 1079-1082 / 1148 四个回池 patch）
- Create: `db/migration-lead-pool-pooled-at.sql`
- Modify: `src/db/migrate.js`
- Test: `test/leadPoolPage.test.js`（追加回填幂等 + in_pool_days 正确性）

- [ ] **Step 1: 写测试**

```js
describe('pooled_at 写入与回填', () => {
  it('获客直落 S0 带 pooled_at', async () => {
    const d = await seedDiscovery('S0'); // 经 discoveryOrchestrator 写入
    expect(d.payload.pooled_at).toBeTruthy();
  });
  it('存量回填幂等：重复执行无新增变更', async () => {
    // 造 10 条无 pooled_at 的 S0
    await seedDeals(tokenA, 10, 'S0', { pooled_at: null });
    await runMigration('migration-lead-pool-pooled-at.sql');
    const first = await countNullPooledAt(tokenA);
    await runMigration('migration-lead-pool-pooled-at.sql'); // 再跑
    const second = await countNullPooledAt(tokenA);
    expect(first).toBe(0); expect(second).toBe(0);
  });
  it('in_pool_days 用 pooled_at（非 created_at）', async () => {
    const r = await fetch(`${base}/api/lead-pool`, { headers: { Authorization: `Bearer ${tokenA}` } });
    const j = await r.json();
    expect(j.items.every((x) => x.in_pool_days >= 0)).toBe(true);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `vitest run test/leadPoolPage.test.js` → FAIL

- [ ] **Step 3: 获客写入源补 `pooled_at`**

`src/agent/discoveryOrchestrator.js:93` 的 seed 对象加 `pooled_at: new Date().toISOString(),`
`src/connectors/tenderConnector.js:55` 的 deal 对象加 `pooled_at: new Date().toISOString(),`
`src/web/pipeline.html:189`：`const payload = { name, stage: 'S0', pool_type: 'new', pooled_at: new Date().toISOString() };`

- [ ] **Step 4: 四个回池动作补 `pooled_at`**

`seed-actions.js` 四处回池 patch（stage:'S0' 或含 stage:'S0'），在 patch 对象内加 `pooled_at: new Date().toISOString(),`：
- `crm-lead-recycle`（~line 969-972）
- `crm-lead-return`（~line 1026-1029）
- `crm-deal-archive-to-pool`（~line 1079-1082，pool_type:'lost'）
- `crm-lead-reclaim-bulk`（~line 1148，仅 terminal 分支）

- [ ] **Step 5: 创建迁移 SQL（幂等）**

`db/migration-lead-pool-pooled-at.sql`：
```sql
-- (system+per-tenant) 存量 S0 线索补 pooled_at；幂等：已有则跳过
UPDATE crm.particles
SET payload = payload || jsonb_build_object('pooled_at', to_char(updated_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
WHERE type='CRM_DEAL'
  AND payload->>'stage'='S0'
  AND payload->>'pooled_at' IS NULL;
```

- [ ] **Step 6: 在 migrate.js 挂载（内联执行，不进 INCREMENTAL_SQL）**

参照 `src/db/migrate.js:202-260` 的 lead-pool-config 范式，在 `migrate-tenant` 之后追加：
```js
// 2026-09-14 T4：存量 S0 补 pooled_at（幂等，重复执行无副作用）
try {
  const atSql = readFileSync(new URL('./migration-lead-pool-pooled-at.sql', import.meta.url), 'utf8');
  await queryWrite(atSql, []);
  console.log('[migrate] 存量公海线索 pooled_at 回填完成');
} catch (e) { console.error('[migrate] pooled_at 回填跳过:', e.message); }
```

- [ ] **Step 7: 运行确认通过**

Run: `vitest run test/leadPoolPage.test.js` → PASS

- [ ] **Step 8: 提交（seed-actions.js 再次混 hunk → git add -p）**

```powershell
git add -p src/action/seed-actions.js   # 选 T4 的 4 处 pooled_at hunk
git add src/agent/discoveryOrchestrator.js src/connectors/tenderConnector.js src/web/pipeline.html db/migration-lead-pool-pooled-at.sql src/db/migrate.js test/leadPoolPage.test.js
git commit -m "feat(lead-pool): 补齐 pooled_at 写入源 + 存量幂等回填"
```

---

### Task 5: 页面 `lead-pool.html`

**Files:**
- Create: `src/web/lead-pool.html`

- [ ] **Step 1: 写页面（完整，含 injectLayout + 列表/筛选/认领/空态/截断提示）**

```html
<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>公海池</title>
<link rel="stylesheet" href="/portal/tokens.css"><link rel="stylesheet" href="/portal/common.css">
<script type="module" src="/portal/components.js"></script></head>
<body>
<div class="panel">
  <h2>🌊 公海池<span id="badge"></span></h2>
  <p class="muted">公海（S0）待领取线索 · 领取即进入你的私海（S0P）待 BANT 校验</p>
  <div id="trunc" class="trunc" hidden></div>
  <div class="filters">
    <select id="fType"><option value="">全部池</option><option value="new">新线索</option><option value="nurture">培育</option><option value="lost">战败回收</option></select>
    <input id="fKw" placeholder="关键词…" />
    <button id="refresh">刷新</button>
  </div>
  <div id="quota" class="quota"></div>
  <table class="tbl"><thead><tr>
    <th>线索</th><th>来源</th><th>池类型</th><th>入池天数</th><th>金额</th><th>操作</th>
  </tr></thead><tbody id="rows"></tbody></table>
  <div id="empty" class="empty" hidden>当前公海无待领取线索 · <a href="/pool-config.html">查看池规则</a></div>
</div>
<script type="module">
import { injectLayout } from '/portal/layout.js';
injectLayout();
const TOKEN = localStorage.getItem('crm_token');
if (!TOKEN) location.href = '/home.html';
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const POOL_LABEL = { new:'新线索', nurture:'培育', lost:'战败回收' };

async function load() {
  const j = await (await fetch('/api/lead-pool', { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
  const kw = $('#fKw').value.trim().toLowerCase();
  const ft = $('#fType').value;
  let items = (j.items||[]).filter((x) => (!ft || x.pool_type===ft) && (!kw || (x.name+x.acct_name).toLowerCase().includes(kw)));
  $('#badge').textContent = j.total ? ` · ${j.total} 条` : '';
  $('#trunc').hidden = !j.truncated;
  if (j.truncated) $('#trunc').textContent = `仅显示前 ${j.returned} 条，公海共 ${j.total} 条（请用筛选缩小范围）`;
  const lim = j.rules?.daily_limit ?? 999;
  $('#quota').textContent = `今日已领取 ${j.my_pick_today ?? 0} / ${lim}` + (j.my_can_pick ? '' : '（已达上限）');
  const rows = $('#rows'); rows.innerHTML = '';
  $('#empty').hidden = j.total > 0;
  for (const x of items) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${esc(x.name)}</td><td>${esc(x.source)}</td><td>${POOL_LABEL[x.pool_type]||x.pool_type}</td>
      <td>${x.in_pool_days}</td><td>${x.est_amount||0}</td>
      <td><button data-id="${x.id}" class="pick" ${j.my_can_pick?'':'disabled'}>认领</button></td>`;
    rows.appendChild(tr);
  }
  rows.querySelectorAll('.pick').forEach((b) => b.addEventListener('click', () => pick(b.dataset.id, b)));
}
async function pick(id, btn) {
  if (!confirm('确认领取该公海线索？领取后进入你的私海（S0P）待 BANT 校验。')) return;
  btn.disabled = true;
  const r = await fetch(`/api/lead-pool/${id}/pick`, { method:'POST', headers: { Authorization: `Bearer ${TOKEN}` } });
  const j = await r.json();
  if (j.ok) { toast('已领取，进入你的私海'); load(); }
  else { alert('领取失败：' + (j.error || j.gate || '未知错误')); btn.disabled = false; }
}
function toast(m){ const t=document.createElement('div'); t.className='toast'; t.textContent=m; document.body.appendChild(t); setTimeout(()=>t.remove(),2000); }
$('#refresh').addEventListener('click', load);
$('#fType').addEventListener('change', load);
$('#fKw').addEventListener('input', load);
load();
</script></body></html>
```

- [ ] **Step 2: 写页面存在性/关键元素测试**

```js
describe('lead-pool.html', () => {
  it('存在且含公海池关键交互节点', async () => {
    const html = await readFile('src/web/lead-pool.html', 'utf8');
    expect(html).toContain("import { injectLayout } from '/portal/layout.js'");
    expect(html).toContain('/api/lead-pool');
    expect(html).toContain('/api/lead-pool/${id}/pick');
    expect(html).toContain('pool-config.html'); // 空态互链
  });
});
```

- [ ] **Step 3: 运行确认通过**

Run: `vitest run test/leadPoolPage.test.js` → PASS

- [ ] **Step 4: 提交**

```powershell
git add src/web/lead-pool.html test/leadPoolPage.test.js
git commit -m "feat(lead-pool): 公海池菜单页 lead-pool.html(列表/筛选/认领/空态)"
```

---

### Task 6: 菜单项

**Files:**
- Modify: `src/portal/layoutMenu.js`
- Test: `test/leadPoolPage.test.js`（追加 describe，或在既有 layoutMenu 测试文件追加）

- [ ] **Step 1: 写测试**

```js
describe('layoutMenu 公海池项', () => {
  it('sales 角色菜单含「公海池」且 core_crm 缺失时不展示', async () => {
    const { menuFor } = await import('../src/portal/layoutMenu.js');
    const sales = menuFor('sales', new Set(['core_crm']));
    expect(sales.some((m) => m.href === '/lead-pool.html' && m.label === '公海池')).toBe(true);
    const noEnt = menuFor('sales', new Set()); // 无权益
    expect(noEnt.some((m) => m.href === '/lead-pool.html')).toBe(false);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `vitest run test/leadPoolPage.test.js` → FAIL

- [ ] **Step 3: 实现（FULL_MENU 紧随「线索·商机」后加一行）**

```js
export const FULL_MENU = [
  { group: '销售', label: '线索·商机', href: '/pipeline.html' },
  { group: '销售', label: '公海池', href: '/lead-pool.html', requiresEntitlement: ['core_crm'] },
  // 客户跟踪：…
```

- [ ] **Step 4: 运行确认通过**

Run: `vitest run test/leadPoolPage.test.js` → PASS

- [ ] **Step 5: 提交**

```powershell
git add src/portal/layoutMenu.js test/leadPoolPage.test.js
git commit -m "feat(lead-pool): 销售菜单新增「公海池」项(core_crm 权益门禁)"
```

---

### Task 7: E2E 扩展（页面链路真跑）

**Files:**
- Modify: `scripts/e2e-lead-pool-actions.mjs`

- [ ] **Step 1: 在既有 E2E 脚本追加页面链路段（自起 HTTP 实例 + 真实端点）**

```js
// 追加到 scripts/e2e-lead-pool-actions.mjs（复用既有实例启动范式）
async function pageFlowE2E() {
  const { base, stop } = await startHttpInstance();
  try {
    const tok = await loginAsSales(); // 既有 fixture 登录
    // 1) 造 S0
    const dealId = await createDealViaAction(tok, 'S0');
    // 2) GET 列表含该条
    const list = await (await fetch(`${base}/api/lead-pool`, { headers: { Authorization: `Bearer ${tok}` } })).json();
    assert(list.items.some((x) => x.id === dealId), '列表应包含新建 S0');
    assert(list.truncated === false, '少量数据不应 truncated');
    // 3) 认领 → 列表移除 + 阶段 S0P
    const pick = await (await fetch(`${base}/api/lead-pool/${dealId}/pick`, { method:'POST', headers:{Authorization:`Bearer ${tok}`} })).json();
    assert(pick.ok === true, '认领应成功');
    const after = await (await fetch(`${base}/api/lead-pool`, { headers:{Authorization:`Bearer ${tok}`} })).json();
    assert(!after.items.some((x) => x.id === dealId), '认领后应从公海列表消失');
    pass('页面链路 E2E');
  } finally { await stop(); }
}
```

- [ ] **Step 2: 运行 E2E（exit=0）**

Run: `node scripts/e2e-lead-pool-actions.mjs`
Expected: 全部断言 PASS，exit 0

- [ ] **Step 3: 提交**

```powershell
git add scripts/e2e-lead-pool-actions.mjs
git commit -m "test(lead-pool): E2E 扩展页面链路(列表/认领/消失)"
```

---

### Task 8: 文档与提交命令汇总

**Files:**
- Modify: `docs/superpowers/plans/2026-09-14-lead-pool-page-menu-design.md`（补实施结论）

- [ ] **Step 1: 在设计文档追加「实施结论」段**

```markdown
## §11 实施结论（2026-09-14）
- T1–T7 落地：端点 2 + 页面 1 + 菜单项 1 + CAS 并发修复 + pooled_at 补齐 + E2E 扩张。
- 验证：单测 test/leadPoolPage.test.js 全绿；E2E 退出码 0。
- 关键约束：seed-actions.js 混 hunk → 每次按 Task 单独 `git add -p`；未触发插件包改动（v1.9.0 不变）。
```

- [ ] **Step 2: 提交**

```powershell
git add docs/superpowers/plans/2026-09-14-lead-pool-page-menu-design.md
git commit -m "docs(lead-pool): 补实施结论段"
```

---

## Self-Review（作者自查）

1. **Spec 覆盖**：§1 范围（菜单/页面/端点/两缺口）↔ T1/T2/T5/T6/T3/T4 ✅；§3 端点契约（truncated/total/my_pick_today 同源）↔ T1 ✅；§4 页面（筛选/空态/截断/互链）↔ T5 ✅；§5 缺口①② ↔ T3/T4 ✅；§7 任务分解 ↔ T1–T8 ✅。
2. **Placeholder 扫描**：无 TBD/TODO；每个代码 step 给出完整片段；测试含断言。
3. **类型一致性**：`in_pool_days`（number）、`pooled_at`（ISO 字符串）、`my_pick_today`（number）、`truncated`（bool）在 T1 产出与 T5 消费一致；`owner_id` 在 T2 强制为 `me.username||me.display_name`，与 crm-lead-pick schema 的 `owner_id` 一致 ✅。

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-09-14-lead-pool-implementation-plan.md`（设计文档：`...-design.md`）。

**两种执行方式：**
1. **Subagent-Driven（推荐）** — 每个 Task 派发独立子代理，任务间两阶段评审，迭代快、隔离好。
2. **Inline Execution** — 本会话内按 Task 批量执行 + 检查点（注意 `seed-actions.js` 混 hunk 必须用 `git add -p`）。

请选择执行方式，或直接说「开始」走 Inline 默认。
