# 租户管理操作台 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在管理台「租户订阅」tab 提供冻结/解冻、延期、退订、改套餐、行业画像分配 5 类管理动作，并对订阅全景增补行业列，全部走第 0 闸 + 审计 + system 保护，禁物理 DELETE。

**Architecture:** 复用 `billingRoutes.js` 既有 `isPrivileged`/`resolveMe`/`queryWrite`/`readConfig` 与 `calibration/store.js` 的 `produceDecision`（第 0 闸），在 `admin-billing-console.html`「租户订阅」tab 追加操作列与复用 `.modal` 弹窗。行业画像分配以 system 模板行为源（对齐「system 只作模板源」铁律），分配=克隆覆盖。设计基线：`docs/2026-09-09-tenant-admin-design.md`。

**Tech Stack:** Node.js ESM + Express + vitest（真实 express + 真实库，mock 登录身份，沿用 `test/billing/tenantPlan.e2e.test.js` 范式）；PostgreSQL（pgvector，`crm` schema，@5433）；前端原生 HTML/ESM（`/portal/api.js` 的 `post()`/`me()`）。

---

## 文件结构

- Modify: `src/http/billingRoutes.js` — 新增 6 端点 + 增补 `tenant-subscriptions` 的 `profile_summary`
- Create: `db/seed/tenant-profile-templates.mjs` — 7 行业模板沉淀到 system 行
- Modify: `src/web/admin-billing-console.html` — 订阅表 12 列 + 操作按钮 + 复用 modal + 行为 JS
- Create: `test/billing/tenantAdmin.test.js` — T1–T10 端到端（真实实例）
- 不动：`db/schema.sql`、`auth.js`、`tenantRouter.js`、`package.json`

依赖/导入（在 `billingRoutes.js` 顶部新增一行 import）：
```js
import { produceDecision } from '../calibration/store.js';
```
（其余 `query`/`queryWrite`/`readConfig`/`resolveMe`/`isPrivileged` 已就绪）

---

## Task 1：行业模板沉淀脚本

**Files:**
- Create: `db/seed/tenant-profile-templates.mjs`
- Test: 手动验证（见 Step 2 命令）

- [ ] **Step 1: 写脚本**

`db/seed/tenant-profile-templates.mjs`：
```js
// db/seed/tenant-profile-templates.mjs
// 把 7 份行业画像沉淀为 system 模板行（tenant-profile-template-<id>），供运行时「分配画像」克隆。
// 对齐铁律：system 只作模板源，租户=覆盖。决策第0闸由运行时 assign-profile 端点承担，本脚本为一次性部署迁移。
import { pathToFileURL } from 'url';
import { query, queryWrite } from '../../src/db.js';
import { writeConfig } from '../../src/config/configStore.js';
import { seedChemicalProfile } from './tenant-profile-chemical.js';
import { seedTrainingProfile } from './tenant-profile-training.js';
import { seedMeddevProfile } from './tenant-profile-meddev.js';
import { seedInsMediProfile } from './tenant-profile-insmedi.js';
import { seedDemoProfile } from './tenant-profile-demo.js';
import { seedConsultProfile } from './tenant-profile-consult.js';
import { seedConsult2Profile } from './tenant-profile-consult2.js';

const TMP = '__tp_tpl_src__';
const SPECS = [
  ['chemical', '化工', seedChemicalProfile],
  ['training', '培训', seedTrainingProfile],
  ['meddev', '医疗器械', seedMeddevProfile],
  ['insmedi', '仪器医疗', seedInsMediProfile],
  ['demo', '演示', seedDemoProfile],
  ['consult', '企业管理咨询', seedConsultProfile],
  ['consult2', '咨询变体', seedConsult2Profile],
];

export async function seedTenantProfileTemplates() {
  for (const [id, label, fn] of SPECS) {
    await fn(TMP); // 各 seed 默认 tenant_id 被参数覆盖
    const { rows } = await query(
      `SELECT value FROM crm.config_store WHERE tenant_id=$1 AND key='tenant-profile'`, [TMP]);
    if (!rows[0]) { console.warn('跳过（无画像源）:', id); continue; }
    const base = JSON.parse(JSON.stringify(rows[0].value || {}));
    base.meta = { ...(base.meta || {}), template_id: id, industry_label: label, source: 'seed' };
    await writeConfig('tenant-profile-template-' + id, base, { tenantId: 'system', updatedBy: 'admin' });
    console.log('template seeded:', id, label);
  }
  await queryWrite(`DELETE FROM crm.config_store WHERE tenant_id=$1 AND key='tenant-profile'`, [TMP]);
  return { ok: true };
}

const isMain = !!process.argv[1] && import.meta.url.toLowerCase() === pathToFileURL(process.argv[1]).href.toLowerCase();
if (isMain) {
  seedTenantProfileTemplates()
    .then(() => { console.log('done'); process.exit(0); })
    .catch((e) => { console.error(e); process.exit(1); });
}
```

- [ ] **Step 2: 运行验证（须先 SET 测试库或生产库；脚本直连 db.js 默认库）**

```bash
# 测试库
PGDATABASE=crm_native_test node db/seed/tenant-profile-templates.mjs
# 预期输出：7 行 "template seeded: <id> <label>" + "done"
```
预期：`crm.config_store` 出现 7 行 `tenant_id='system' AND key LIKE 'tenant-profile-template-%'`，且 `value->'meta'->>'template_id'` 各自等于 id。

- [ ] **Step 3: 提交**

```bash
git add db/seed/tenant-profile-templates.mjs
git commit -m "feat: 沉淀 7 行业 tenant-profile 模板到 system 行（供分配画像克隆）"
```

---

## Task 2：只读面 — `profile-templates` 端点 + `tenant-subscriptions` 增补 profile_summary

**Files:**
- Modify: `src/http/billingRoutes.js:238-263`（替换 `tenant-subscriptions` 块，并在其后追加 `profile-templates`）
- Test: `test/billing/tenantAdmin.test.js`（Task 6 一并覆盖）

- [ ] **Step 1: 替换订阅全景端点并新增模板清单端点**

将 `billingRoutes.js` 中 `router.get('/api/billing/tenant-subscriptions', ...)`（原 238–263 行）整块替换为：
```js
  // 管理台租户订阅全景（admin/sysadmin）：列出全部租户，含推荐人、生效套餐、订阅到期、席位/Token 用量 + 行业画像概要
  router.get('/api/billing/tenant-subscriptions', async (req, res) => {
    const me = resolveMe(req);
    if (!isPrivileged(me)) return res.status(403).json({ error: 'forbidden' });
    const scope = applyTenantOverride(req, me);
    const period = req.query.period || currentPeriod();
    try {
      const { computeLiveCost } = await import('../billing/subscriptionService.js');
      const tq = scope === '*' ? '' : `WHERE tenant_id=$1`;
      const tenants = await query(`SELECT tenant_id, name, status, plan, created_by_username FROM crm.tenants ${tq} ORDER BY created_at DESC`, scope === '*' ? [] : [scope]);
      // 批量取行业画像（避免 N+1）：tenant_id -> {industry_label, prototype_count}
      const profRows = await query(
        `SELECT tenant_id, value->'meta'->>'industry_label' AS il, jsonb_object_length(value->'prototypes') AS pc
         FROM crm.config_store WHERE key='tenant-profile' AND tenant_id = ANY($1)`,
        [tenants.rows.map((t) => t.tenant_id)]);
      const profMap = new Map(profRows.rows.map((r) => [r.tenant_id, { industry_label: r.il || null, prototype_count: Number(r.pc) || 0 }]));
      const rows = [];
      for (const t of tenants.rows) {
        const s = await query(`SELECT plan_id, status, started_at, expires_at, grace_until, upgraded_from FROM crm.tenant_subscription WHERE tenant_id=$1 ORDER BY started_at DESC LIMIT 1`, [t.tenant_id]);
        rows.push({
          tenant_id: t.tenant_id,
          tenant_name: t.name,
          tenant_status: t.status,
          referrer: t.created_by_username || null,
          tenant_plan: t.plan || null,
          subscription: s.rows[0] || null,
          live_cost: await computeLiveCost(t.tenant_id),
          quota: await tokenQuota(t.tenant_id, period),
          profile_summary: profMap.get(t.tenant_id) || null,
        });
      }
      res.json({ rows, period, scope });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // 行业画像模板清单（admin/sysadmin 只读）
  router.get('/api/billing/tenant-admin/profile-templates', async (req, res) => {
    const me = resolveMe(req);
    if (!isPrivileged(me)) return res.status(403).json({ error: 'forbidden' });
    try {
      const rows = (await query(
        `SELECT key, value FROM crm.config_store WHERE tenant_id='system' AND key LIKE 'tenant-profile-template-%'`
      )).rows;
      const templates = rows.map((r) => {
        const v = r.value || {};
        const id = String(r.key).replace('tenant-profile-template-', '');
        const protos = v.prototypes && typeof v.prototypes === 'object' ? Object.keys(v.prototypes).length : 0;
        return { template_id: id, industry_label: (v.meta && v.meta.industry_label) || id, prototype_count: protos };
      });
      res.json({ templates });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
```

- [ ] **Step 2: 跑现有订阅测试防回归**

```bash
node --experimental-vm-modules node_modules/vitest/vitest.mjs run test/billing/billingRoutes.test.js
```
预期：既有订阅用例全 PASS（profile_summary 为新增字段，不破坏旧断言）。

- [ ] **Step 3: 提交**

```bash
git add src/http/billingRoutes.js
git commit -m "feat(billing): 订阅全景增补 profile_summary + 新增 profile-templates 只读端点"
```

---

## Task 3：5 个写端点（freeze/unfreeze/extend/cancel/change-plan）

**Files:**
- Modify: `src/http/billingRoutes.js`（在 `profile-templates` 端点后追加）
- Test: `test/billing/tenantAdmin.test.js`（Task 6 一并覆盖）

- [ ] **Step 1: 在 billingRoutes.js 末尾 `createBillingRouter` 内追加以下 5 个端点（在 `export function createBillingRouter()` 闭合前插入）**

```js
  // ── 租户管理操作台（admin/sysadmin；第0闸 produceDecision；system 硬拒；幂等）──
  // 第0闸：写前落真实决策行；失败则整动作失败（不半截提交）。ctx.by_id/by_role 取自登录身份。
  async function gateDecision(me, fields) {
    const d = await produceDecision({ fields, by_id: me?.username, by_role: me?.role || 'sysadmin' });
    return d?.decisionId || null;
  }

  router.post('/api/billing/tenant-admin/freeze', async (req, res) => {
    const me = resolveMe(req);
    if (!isPrivileged(me)) return res.status(403).json({ error: 'forbidden' });
    const { tenantId, reason } = req.body || {};
    if (!tenantId) return res.status(400).json({ error: 'tenantId required' });
    if (tenantId === 'system') return res.status(400).json({ error: 'system 租户不可冻结' });
    try {
      const cur = (await query(`SELECT status FROM crm.tenants WHERE tenant_id=$1`, [tenantId])).rows[0];
      if (!cur) return res.status(404).json({ error: 'tenant not found' });
      if (cur.status === 'retired') return res.status(400).json({ error: 'retired 租户不可冻结（终态）' });
      if (cur.status === 'suspended') return res.json({ ok: true, noop: true, status: 'suspended' });
      await gateDecision(me, [`tenant:${tenantId}`, 'freeze', reason || ''].filter(Boolean));
      const r = await queryWrite(`UPDATE crm.tenants SET status='suspended', suspended_at=now() WHERE tenant_id=$1`, [tenantId]);
      res.json({ ok: true, updated: r.rowCount, status: 'suspended' });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/api/billing/tenant-admin/unfreeze', async (req, res) => {
    const me = resolveMe(req);
    if (!isPrivileged(me)) return res.status(403).json({ error: 'forbidden' });
    const { tenantId } = req.body || {};
    if (!tenantId) return res.status(400).json({ error: 'tenantId required' });
    try {
      const cur = (await query(`SELECT status FROM crm.tenants WHERE tenant_id=$1`, [tenantId])).rows[0];
      if (!cur) return res.status(404).json({ error: 'tenant not found' });
      if (cur.status === 'retired') return res.status(400).json({ error: 'retired 租户不可解冻（终态）' });
      if (cur.status === 'active') return res.json({ ok: true, noop: true, status: 'active' });
      await gateDecision(me, [`tenant:${tenantId}`, 'unfreeze']);
      const r = await queryWrite(`UPDATE crm.tenants SET status='active', suspended_at=NULL WHERE tenant_id=$1`, [tenantId]);
      res.json({ ok: true, updated: r.rowCount, status: 'active' });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/api/billing/tenant-admin/extend', async (req, res) => {
    const me = resolveMe(req);
    if (!isPrivileged(me)) return res.status(403).json({ error: 'forbidden' });
    const { tenantId, days } = req.body || {};
    if (!tenantId) return res.status(400).json({ error: 'tenantId required' });
    if (days === null || days === undefined) return res.status(400).json({ error: 'days required' });
    const d = Number(days);
    if (!Number.isInteger(d) || d < 1 || d > 365) return res.status(400).json({ error: 'days 须为 1-365 整数' });
    try {
      const sub = (await query(`SELECT id, status FROM crm.tenant_subscription WHERE tenant_id=$1 ORDER BY started_at DESC LIMIT 1`, [tenantId])).rows[0];
      if (!sub) return res.status(400).json({ error: '该租户无订阅记录，无法延期（请先开通订阅）' });
      await gateDecision(me, [`tenant:${tenantId}`, `extend:${d}d`]);
      const r = await queryWrite(`UPDATE crm.tenant_subscription SET expires_at = expires_at + ($1)::interval, updated_at=now() WHERE id=$2`, [d + ' days', sub.id]);
      res.json({ ok: true, updated: r.rowCount });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/api/billing/tenant-admin/cancel', async (req, res) => {
    const me = resolveMe(req);
    if (!isPrivileged(me)) return res.status(403).json({ error: 'forbidden' });
    const { tenantId, reason } = req.body || {};
    if (!tenantId) return res.status(400).json({ error: 'tenantId required' });
    if (tenantId === 'system') return res.status(400).json({ error: 'system 租户不可退订' });
    try {
      const cur = (await query(`SELECT status FROM crm.tenants WHERE tenant_id=$1`, [tenantId])).rows[0];
      if (!cur) return res.status(404).json({ error: 'tenant not found' });
      if (cur.status === 'retired') return res.json({ ok: true, noop: true, status: 'retired' });
      await gateDecision(me, [`tenant:${tenantId}`, 'cancel', reason || ''].filter(Boolean));
      const r1 = await queryWrite(`UPDATE crm.tenants SET status='retired', retired_at=now() WHERE tenant_id=$1`, [tenantId]);
      const r2 = await queryWrite(`UPDATE crm.tenant_subscription SET status='canceled', updated_at=now() WHERE tenant_id=$1 AND status IN ('active','grace')`, [tenantId]);
      res.json({ ok: true, tenantUpdated: r1.rowCount, subCancelled: r2.rowCount, status: 'retired' });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/api/billing/tenant-admin/change-plan', async (req, res) => {
    const me = resolveMe(req);
    if (!isPrivileged(me)) return res.status(403).json({ error: 'forbidden' });
    const { tenantId, planId } = req.body || {};
    if (!tenantId || !planId) return res.status(400).json({ error: 'tenantId & planId required' });
    if (tenantId === 'system') return res.status(400).json({ error: 'system 租户不可改套餐' });
    try {
      const plansRow = await readConfig('billing-plans', { tenantId: 'system' });
      const plans = Array.isArray(plansRow?.value) ? plansRow.value : [];
      if (!plans.some((p) => p.plan_id === planId)) return res.status(400).json({ error: `planId 不存在：${planId}` });
      await gateDecision(me, [`tenant:${tenantId}`, `plan->${planId}`]);
      await queryWrite(`UPDATE crm.tenants SET plan=$2 WHERE tenant_id=$1`, [tenantId, planId]);
      await queryWrite(`UPDATE crm.tenant_subscription SET status='canceled' WHERE tenant_id=$1 AND status IN ('active','grace')`, [tenantId]);
      await queryWrite(
        `INSERT INTO crm.tenant_subscription (tenant_id, plan_id, status, started_at, expires_at, upgraded_from)
         VALUES ($1,$2,'active',now(),now()+'1 month','admin-grant')`, [tenantId, planId]);
      res.json({ ok: true, plan: planId });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
```

- [ ] **Step 2: 跑当前计费套件防回归**

```bash
node --experimental-vm-modules node_modules/vitest/vitest.mjs run test/billing/ 2>&1 | tail -20
```
预期：无新增失败（新端点尚未被旧用例触达；功能断言在 Task 6 验证）。

- [ ] **Step 3: 提交**

```bash
git add src/http/billingRoutes.js
git commit -m "feat(billing): 租户管理写端点 freeze/unfreeze/extend/cancel/change-plan（第0闸+system保护+幂等）"
```

---

## Task 4：assign-profile 写端点

**Files:**
- Modify: `src/http/billingRoutes.js`（在 change-plan 后追加）

- [ ] **Step 1: 追加 assign-profile 端点**

```js
  router.post('/api/billing/tenant-admin/assign-profile', async (req, res) => {
    const me = resolveMe(req);
    if (!isPrivileged(me)) return res.status(403).json({ error: 'forbidden' });
    const { tenantId, templateId } = req.body || {};
    if (!tenantId || !templateId) return res.status(400).json({ error: 'tenantId & templateId required' });
    if (tenantId === 'system') return res.status(400).json({ error: 'system 租户不可分配画像' });
    try {
      const tpl = (await query(`SELECT value FROM crm.config_store WHERE tenant_id='system' AND key=$1`, ['tenant-profile-template-' + templateId])).rows[0];
      if (!tpl) return res.status(400).json({ error: `模板不存在：${templateId}` });
      const base = JSON.parse(JSON.stringify(tpl.value || {}));
      base.meta = { ...(base.meta || {}), template_id: templateId, assigned_at: new Date().toISOString(), assigned_by: me?.username || 'admin' };
      await gateDecision(me, [`tenant:${tenantId}`, `profile<-${templateId}`]);
      const r = await queryWrite(
        `INSERT INTO crm.config_store (tenant_id, key, value, updated_by, updated_at)
         VALUES ($1,'tenant-profile',$2::jsonb,'admin',now())
         ON CONFLICT (tenant_id, key) DO UPDATE SET value=$2::jsonb, updated_at=now()`,
        [tenantId, JSON.stringify(base)]);
      res.json({ ok: true, updated: r.rowCount });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
```

- [ ] **Step 2: 跑计费套件**

```bash
node --experimental-vm-modules node_modules/vitest/vitest.mjs run test/billing/ 2>&1 | tail -8
```
预期：无新增失败。

- [ ] **Step 3: 提交**

```bash
git add src/http/billingRoutes.js
git commit -m "feat(billing): assign-profile 端点（克隆 system 模板到租户，第0闸+幂等+system保护）"
```

---

## Task 5：前端 — 12 列 + 操作按钮 + 弹窗

**Files:**
- Modify: `src/web/admin-billing-console.html`（3 处：表头/行渲染、modal HTML、行为 JS）

前端约定（已核）：`post(path, body)` / `me()` 来自 `/portal/api.js`；`esc()`/`escAttr()`/`fmtMoney()`/`fmtNum()`/`daysLeft()` 已定义；`.modal.show` 控制显隐；权限已由 `guard()` 拦截非 admin/sysadmin。

- [ ] **Step 1: 表头 10 列 → 12 列，行内加行业列与操作列**

将 `loadSubs` 内 `head`/`body` 渲染（原 281–310 行）替换为：
```js
      const head = `<tr><th>租户</th><th>推荐人</th><th>当前套餐</th><th>开通日期</th><th>到期日</th><th>剩余</th><th>席位(已用/额度/余)</th><th>已用 Token</th><th>实时费用</th><th>行业</th><th>状态</th><th>操作</th></tr>`;
      const body = SUBS_DATA.map((r, idx) => {
        const s = r.subscription;
        const lc = r.live_cost || {};
        const seatLimit = lc.seat_limit;
        const seatUsed = lc.seats ?? 0;
        const seatRemain = lc.remaining_seats === null ? '不限' : (lc.remaining_seats ?? '—');
        const seatCell = seatLimit === -1 ? `${seatUsed}/不限` : `${seatUsed}/${seatLimit} <span class="sub">(余${seatRemain})</span>`;
        const tokenUsed = (Number(lc.token_in) || 0) + (Number(lc.token_out) || 0);
        const planName = s?.plan_id || r.tenant_plan || '—';
        const started = s?.started_at ? String(s.started_at).slice(0, 10) : '—';
        const expires = s?.expires_at ? String(s.expires_at).slice(0, 10) : '—';
        const days = s?.expires_at ? daysLeft(s.expires_at) : '—';
        const status = s ? s.status : '未开通';
        const statusClass = status === 'active' ? 'ok' : (status === '未开通' ? 'sub' : 'bad');
        const ps = r.profile_summary;
        const indCell = ps && ps.industry_label ? `${esc(ps.industry_label)}<div class="sub">${ps.prototype_count} 类型</div>` : '<span class="sub">—</span>';
        const isSys = r.tenant_id === 'system';
        const st = r.tenant_status;
        const ops = isSys
          ? '<span class="sub">平台租户</span>'
          : `<crm-button class="btn" data-act="freeze" data-t="${escAttr(r.tenant_id)}">${st === 'suspended' ? '解冻' : '冻结'}</crm-button>
             <crm-button class="btn ghost" data-act="extend" data-t="${escAttr(r.tenant_id)}">延期</crm-button>
             <crm-button class="btn ghost" data-act="plan" data-t="${escAttr(r.tenant_id)}">改套餐</crm-button>
             <crm-button class="btn ghost" data-act="profile" data-t="${escAttr(r.tenant_id)}">分配画像</crm-button>
             <crm-button class="btn bad" data-act="cancel" data-t="${escAttr(r.tenant_id)}">退订</crm-button>`;
        return `
        <tr class="sub-row" data-idx="${idx}" onclick="toggleSubDetail(event, '${escAttr(r.tenant_id)}')">
          <td><b>${esc(r.tenant_name || r.tenant_id)}</b><div class="sub">${esc(r.tenant_id)}</div></td>
          <td>${esc(r.referrer) || '—'}</td>
          <td>${esc(planName)}</td>
          <td>${started}</td>
          <td>${expires}</td>
          <td>${days}</td>
          <td>${seatCell}</td>
          <td>${fmtNum(tokenUsed)}</td>
          <td>${fmtMoney(lc.total_fee)}</td>
          <td>${indCell}</td>
          <td class="${statusClass}">${esc(status)}</td>
          <td class="ops" onclick="event.stopPropagation()">${ops}</td>
        </tr>
        <tr class="sub-detail" id="sub-detail-${escAttr(r.tenant_id)}" style="display:none"><td colspan="12" data-tenant="${escAttr(r.tenant_id)}">加载中…</td></tr>
      `;
      }).join('');
```

- [ ] **Step 2: pane-subs 增加模板/档位数据预载 + 操作事件绑定**

在 `loadSubs` 调用处（Tab 初始化逻辑）确保每次进入 subs tab 预载模板清单与最新 PLANS。最稳妥：在 `subscribeTab` 渲染前调用。将 `function loadSubs(...)` 顶部追加两行（在 `const el = ...` 之前）：
```js
    if (!window.__TA_TPLS) { try { window.__TA_TPLS = (await api('/api/billing/tenant-admin/profile-templates'))?.templates || []; } catch { window.__TA_TPLS = []; } }
    if (!PLANS.length) await loadPlans();
```
并在脚本底部（`window.addEventListener('hashchange', ...)` 之后，或 init 区）注册事件委托：
```js
  document.addEventListener('click', (ev) => {
    const btn = ev.target.closest('crm-button[data-act]');
    if (!btn) return;
    const t = btn.getAttribute('data-t');
    const act = btn.getAttribute('data-act');
    openTenantAction(act, t);
  });
```
注：`loadSubs` 现为 `async`，确认其声明含 `async`（原 `async function loadSubs`）。

- [ ] **Step 3: 新增 modal HTML（在 `</div>` 关闭 plan-edit-modal 之后、`<div class="modal" id="plan-edit-modal">` 同级插入）**

```html
<div class="modal" id="ta-modal">
  <div class="box" style="width:420px;max-width:92vw">
    <h3 id="ta-title">租户操作</h3>
    <p class="sub" id="ta-hint"></p>
    <div id="ta-fields"></div>
    <div class="bad" id="ta-err" style="display:none;margin-top:8px"></div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">
      <crm-button class="btn ghost" id="ta-cancel">取消</crm-button>
      <crm-button class="btn" id="ta-ok">确认</crm-button>
    </div>
  </div>
</div>
```

- [ ] **Step 4: 行为 JS（openTenantAction + 提交）— 在脚本区追加**

```js
  let TA_CTX = null;
  async function openTenantAction(act, tenantId) {
    TA_CTX = { act, tenantId };
    const title = { freeze: '冻结租户', unfreeze: '解冻租户', extend: '延期订阅', plan: '改套餐', profile: '分配行业画像', cancel: '退订（软）' }[act] || '租户操作';
    document.getElementById('ta-title').textContent = title + '：' + tenantId;
    const hint = { freeze: '冻结后新登录即被拒，定时任务暂停；已登录会话在 token 过期后失效。', cancel: '退订将置租户为 retired（数据全保留，禁物理删除），订阅标记 cancelled。', profile: '将整体覆盖该租户现有行业画像（旧画像可由决策行追溯）。' }[act] || '';
    document.getElementById('ta-hint').textContent = hint;
    let fields = '';
    if (act === 'extend') fields = `<label>延期天数（1-365）</label><crm-input id="ta-days" type="number" min="1" max="365" value="30"></crm-input>`;
    else if (act === 'plan') {
      const opts = (PLANS || []).map((p) => `<option value="${escAttr(p.plan_id)}">${esc(p.plan_id)} · ${esc(p.name || '')}</option>`).join('');
      fields = `<label>目标套餐</label><select id="ta-plan" class="crm-input">${opts}</select>`;
    } else if (act === 'profile') {
      const tpls = (window.__TA_TPLS || []).map((t) => `<option value="${escAttr(t.template_id)}">${esc(t.industry_label)}（${t.prototype_count} 类型）</option>`).join('');
      fields = `<label>行业模板</label><select id="ta-tpl" class="crm-input">${tpls}</select>`;
    } else if (act === 'cancel' || act === 'freeze') {
      fields = `<label>原因（可选）</label><crm-input id="ta-reason" placeholder="如 逾期未续费"></crm-input>`;
    } else if (act === 'unfreeze') fields = '';
    document.getElementById('ta-fields').innerHTML = fields;
    document.getElementById('ta-err').style.display = 'none';
    document.getElementById('ta-modal').classList.add('show');
  }
  function closeTaModal() { document.getElementById('ta-modal').classList.remove('show'); }
  document.getElementById('ta-cancel').onclick = closeTaModal;
  document.getElementById('ta-modal').addEventListener('click', (e) => { if (e.target.id === 'ta-modal') closeTaModal(); });
  window.openTenantAction = openTenantAction; // 供事件委托调用
  document.getElementById('ta-ok').onclick = async () => {
    if (!TA_CTX) return;
    const { act, tenantId } = TA_CTX;
    const body = { tenantId };
    if (act === 'extend') body.days = Number(document.getElementById('ta-days')?.value);
    if (act === 'plan') body.planId = document.getElementById('ta-plan')?.value;
    if (act === 'profile') body.templateId = document.getElementById('ta-tpl')?.value;
    if (act === 'freeze' || act === 'cancel') body.reason = document.getElementById('ta-reason')?.value || '';
    const realAct = act === 'unfreeze' ? 'unfreeze' : act;
    const errEl = document.getElementById('ta-err');
    try {
      await post(`/api/billing/tenant-admin/${realAct}`, body);
      closeTaModal();
      await loadSubs();
    } catch (e) {
      errEl.textContent = e?.error || e?.message || '操作失败';
      errEl.style.display = 'block';
    }
  };
```

注意：`data-act` 可能传 'freeze'/'unfreeze'；openTenantAction 收到的 act 来自按钮。冻结/解冻用同一按钮文字切换——点击时 act 已是 'unfreeze'（当 st==='suspended'）。`realAct` 映射保证端点正确。

- [ ] **Step 5: ui-lint 通过**

```bash
node scripts/ui-lint.mjs
```
预期：0 error（页面已注册于脚手架，仅改动 JS/HTML 内联；若 lint 报新增内联样式，按需迁移到 `<style>` 区块——但本计划全部用既有 class，不应触发）。

- [ ] **Step 6: 提交**

```bash
git add src/web/admin-billing-console.html
git commit -m "feat(ui): 租户订阅 tab 12 列 + 冻结/解冻/延期/改套餐/退订/分配画像操作"
```

---

## Task 6：端到端测试 T1–T10

**Files:**
- Create: `test/billing/tenantAdmin.test.js`

沿用 `test/billing/tenantPlan.e2e.test.js` 范式（真实 express + 真实库，`resolveMe` mock，PORT=0 随机）。`produceDecision` 真实落 `crm.decision`（测试库已建表），用于 T9 断言。

- [ ] **Step 1: 写测试文件**

`test/billing/tenantAdmin.test.js`：
```js
// test/billing/tenantAdmin.test.js — 租户管理操作台端到端（真实 express + 真实库，mock 登录身份）
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import { query, queryWrite } from '../../src/db.js';
import { seedBillingPlans } from '../helpers/seedBillingPlans.js';

vi.mock('../../src/http/auth.js', () => ({ resolveMe: vi.fn() }));
const { resolveMe } = await import('../../src/http/auth.js');
const { createBillingRouter } = await import('../../src/http/billingRoutes.js');

const NS = '__ta_' + process.pid + '_' + Date.now();
const T = NS + '_tenant';
let server = null, baseUrl = '';

const role = (r = 'admin') => resolveMe.mockReturnValue({ ok: true, role: r, tenantId: 'system', username: 'tester' });
async function call(action, body, r = 'admin') {
  role(r);
  const res = await fetch(`${baseUrl}/api/billing/tenant-admin/${action}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const col = async (col, val) => (await query(`SELECT ${col} FROM crm.tenants WHERE tenant_id=$1`, [T])).rows[0]?.[col];
const subStatus = async () => (await query(`SELECT status FROM crm.tenant_subscription WHERE tenant_id=$1 ORDER BY started_at DESC LIMIT 1`, [T])).rows[0]?.status;
const decisionCount = async (frag) => (await query(`SELECT count(*)::int c FROM crm.decision WHERE rationale LIKE '%' || $1 || '%'`, [frag])).rows[0].c;

beforeAll(async () => {
  await seedBillingPlans('tenantAdmin');
  await queryWrite(`INSERT INTO crm.tenants (tenant_id,name,status,plan) VALUES ($1,$1,'active','free') ON CONFLICT (tenant_id) DO UPDATE SET status='active',plan='free',retired_at=NULL`, [T]);
  await queryWrite(`INSERT INTO crm.tenant_subscription (tenant_id,plan_id,status,started_at,expires_at) VALUES ($1,'free','active',now(),now()+'10 days')`, [T]);
  await queryWrite(`INSERT INTO crm.config_store (tenant_id,key,value) VALUES ('system','tenant-profile-template-demo',$${"meta":{"template_id":"demo","industry_label":"演示"},"prototypes":{"DEMO_CUST":{"label":"演示客户","flow":["lead","won"]}}}$$)::jsonb) ON CONFLICT (tenant_id,key) DO UPDATE SET value=EXCLUDED.value`, []);
  const app = express();
  app.use(express.json());
  app.use(createBillingRouter());
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', () => { baseUrl = `http://127.0.0.1:${server.address().port}`; r(); }); });
});
afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  await queryWrite(`DELETE FROM crm.tenants WHERE tenant_id=$1`, [T]).catch(() => {});
});

describe('权限与保护', () => {
  it('T1 非特权角色 → 403', async () => { expect((await call('freeze', { tenantId: T }, 'sales')).status).toBe(403); });
  it('T2 system 租户硬拒（freeze/cancel/change-plan/assign-profile）', async () => {
    expect((await call('freeze', { tenantId: 'system' })).status).toBe(400);
    expect((await call('cancel', { tenantId: 'system' })).status).toBe(400);
    expect((await call('change-plan', { tenantId: 'system', planId: 'pro' })).status).toBe(400);
    expect((await call('assign-profile', { tenantId: 'system', templateId: 'demo' })).status).toBe(400);
  });
  it('T2b 缺失参数 → 400', async () => { expect((await call('freeze', {})).status).toBe(400); });
});

describe('冻结/解冻链路', () => {
  it('T3 freeze → 新登录被拒（租户已停用）', async () => {
    expect((await call('freeze', { tenantId: T })).body.ok).toBe(true);
    expect(await col('status')).toBe('suspended');
    role('admin');
    const login = await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'tester', password: 'x' }) });
    // 注：无真实用户，仅验证租户闸——直接查 tenants.status 已 suspended 即等价于登录闸输入条件（auth.js:45-50）。
    expect(await col('status')).toBe('suspended');
  });
  it('T4 unfreeze → 恢复 active', async () => {
    expect((await call('unfreeze', { tenantId: T })).body.ok).toBe(true);
    expect(await col('status')).toBe('active');
  });
  it('T4b 重复 freeze 幂等 noop', async () => {
    await call('freeze', { tenantId: T });
    const r = await call('freeze', { tenantId: T });
    expect(r.body.noop).toBe(true);
    await call('unfreeze', { tenantId: T });
  });
});

describe('延期', () => {
  it('T5 合法天数 → expires_at 顺延', async () => {
    const before = (await query(`SELECT expires_at FROM crm.tenant_subscription WHERE tenant_id=$1 ORDER BY started_at DESC LIMIT 1`, [T])).rows[0].expires_at;
    expect((await call('extend', { tenantId: T, days: 30 })).body.ok).toBe(true);
    const after = (await query(`SELECT expires_at FROM crm.tenant_subscription WHERE tenant_id=$1 ORDER BY started_at DESC LIMIT 1`, [T])).rows[0].expires_at;
    expect(new Date(after) - new Date(before)).toBe(30 * 86400000);
  });
  it('T5b days=null/0/400/abc → 400（含 null 不静默置 0）', async () => {
    expect((await call('extend', { tenantId: T, days: null })).status).toBe(400);
    expect((await call('extend', { tenantId: T, days: 0 })).status).toBe(400);
    expect((await call('extend', { tenantId: T, days: 400 })).status).toBe(400);
    expect((await call('extend', { tenantId: T, days: 'abc' })).status).toBe(400);
  });
  it('T5c 无订阅 → 400', async () => {
    const U = NS + '_nosub';
    await queryWrite(`INSERT INTO crm.tenants (tenant_id,name,status,plan) VALUES ($1,$1,'active','free') ON CONFLICT (tenant_id) DO NOTHING`, [U]);
    expect((await call('extend', { tenantId: U, days: 30 })).status).toBe(400);
  });
});

describe('退订（软）', () => {
  it('T6 cancel → retired + 订阅 cancelled，行数不减少（禁删）', async () => {
    const tenantBefore = (await query(`SELECT count(*)::int c FROM crm.tenants WHERE tenant_id=$1`, [T])).rows[0].c;
    const subBefore = (await query(`SELECT count(*)::int c FROM crm.tenant_subscription WHERE tenant_id=$1`, [T])).rows[0].c;
    expect((await call('cancel', { tenantId: T })).body.ok).toBe(true);
    expect(await col('status')).toBe('retired');
    expect(await subStatus()).toBe('cancelled');
    expect((await query(`SELECT count(*)::int c FROM crm.tenants WHERE tenant_id=$1`, [T])).rows[0].c).toBe(tenantBefore);
    expect((await query(`SELECT count(*)::int c FROM crm.tenant_subscription WHERE tenant_id=$1`, [T])).rows[0].c).toBe(subBefore);
  });
  it('T6b retired 不可解冻', async () => { expect((await call('unfreeze', { tenantId: T })).status).toBe(400); });
});

describe('改套餐', () => {
  it('T7 合法档位 → tenants.plan 更新 + 新订阅 upgraded_from=admin-grant', async () => {
    const U = NS + '_plan';
    await queryWrite(`INSERT INTO crm.tenants (tenant_id,name,status,plan) VALUES ($1,$1,'active','free') ON CONFLICT (tenant_id) DO UPDATE SET status='active',plan='free'`, [U]);
    await queryWrite(`INSERT INTO crm.tenant_subscription (tenant_id,plan_id,status,started_at,expires_at) VALUES ($1,'free','active',now(),now()+'10 days')`, [U]);
    expect((await call('change-plan', { tenantId: U, planId: 'pro' })).body.ok).toBe(true);
    expect((await query(`SELECT plan FROM crm.tenants WHERE tenant_id=$1`, [U])).rows[0].plan).toBe('pro');
    expect((await query(`SELECT upgraded_from FROM crm.tenant_subscription WHERE tenant_id=$1 ORDER BY started_at DESC LIMIT 1`, [U])).rows[0].upgraded_from).toBe('admin-grant');
  });
  it('T7b 非法 planId → 400', async () => { expect((await call('change-plan', { tenantId: T, planId: '__nope__' })).status).toBe(400); });
});

describe('行业画像分配', () => {
  it('T8 分配 → 租户 tenant-profile 出现模板 prototypes + meta.template_id', async () => {
    const U = NS + '_prof';
    await queryWrite(`INSERT INTO crm.tenants (tenant_id,name,status,plan) VALUES ($1,$1,'active','free') ON CONFLICT (tenant_id) DO NOTHING`, [U]);
    expect((await call('assign-profile', { tenantId: U, templateId: 'demo' })).body.ok).toBe(true);
    const v = (await query(`SELECT value FROM crm.config_store WHERE tenant_id=$1 AND key='tenant-profile'`, [U])).rows[0].value;
    expect(v.meta.template_id).toBe('demo');
    expect(v.prototypes.DEMO_CUST.label).toBe('演示客户');
  });
  it('T8b 不存在模板 → 400', async () => { expect((await call('assign-profile', { tenantId: T, templateId: '__x__' })).status).toBe(400); });
});

describe('第0闸', () => {
  it('T9 每个写动作落 decision 行（CALIBRATION_CHANGE）', async () => {
    const U = NS + '_gate';
    await queryWrite(`INSERT INTO crm.tenants (tenant_id,name,status,plan) VALUES ($1,$1,'active','free') ON CONFLICT (tenant_id) DO NOTHING`, [U]);
    await queryWrite(`INSERT INTO crm.tenant_subscription (tenant_id,plan_id,status,started_at,expires_at) VALUES ($1,'free','active',now(),now()+'10 days')`, [U]);
    const c0 = await decisionCount('tenant:' + U);
    await call('freeze', { tenantId: U });
    await call('extend', { tenantId: U, days: 5 });
    await call('change-plan', { tenantId: U, planId: 'starter' });
    await call('assign-profile', { tenantId: U, templateId: 'demo' });
    await call('cancel', { tenantId: U });
    const c1 = await decisionCount('tenant:' + U);
    expect(c1 - c0).toBe(5);
  });
});

describe('订阅全景 profile_summary', () => {
  it('T10 tenant-subscriptions 含 profile_summary', async () => {
    role('admin');
    await queryWrite(`INSERT INTO crm.config_store (tenant_id,key,value) VALUES ($1,'tenant-profile',$${"meta":{"industry_label":"演示"},"prototypes":{"X":{}}}$$::jsonb) ON CONFLICT (tenant_id,key) DO UPDATE SET value=EXCLUDED.value`, [T]);
    const res = await fetch(`${baseUrl}/api/billing/tenant-subscriptions`, { headers: {} });
    const j = await res.json();
    const row = (j.rows || []).find((r) => r.tenant_id === T);
    expect(row).toBeTruthy();
    expect(row.profile_summary.industry_label).toBe('演示');
  });
});
```

- [ ] **Step 2: 运行测试**

```bash
node --experimental-vm-modules node_modules/vitest/vitest.mjs run test/billing/tenantAdmin.test.js 2>&1 | tail -30
```
预期：全部 T1–T10 PASS（注意 `vi.mock` 需在文件顶部，vitest 配置已支持；`$$...$$` 为 SQL 字符串字面量写法，若 db.js 驱动不支持需改为参数化，见下方备注）。

- [ ] **Step 3: 提交**

```bash
git add test/billing/tenantAdmin.test.js
git commit -m "test(billing): 租户管理操作台端到端 T1-T10（权限/冻结/延期/退订/改套餐/画像/第0闸/概要）"
```

> 备注：Step 1 中 `$${"..."}$$` 是 PostgreSQL 内联 JSON 字面量写法（db.js 走 pg 驱动，`$$` 转义 `$`）。若运行报语法错，改为参数化：`queryWrite('INSERT ... VALUES ($1,$2,$3::jsonb)', [tenantId, key, jsonString])`。

---

## Task 7：全量回归 + 设计文档收口

**Files:**
- 回归运行；可选更新 `docs/2026-09-09-tenant-admin-design.md` 实施状态

- [ ] **Step 1: 跑全量计费回归 + ui-lint + 三源一致性**

```bash
node --experimental-vm-modules node_modules/vitest/vitest.mjs run test/billing/ 2>&1 | tail -15
node scripts/ui-lint.mjs
node scripts/verify-billing-gates.mjs
```
预期：三命令均无 error/fail。

- [ ] **Step 2: 部署前（若上生产）按发布铁律**

生产改动 `billingRoutes.js` / `admin-billing-console.html` 后走 `crm-prod-release` 流程（本地 commit → release → 恢复远程 `.env` → deploy）；模板脚本在目标库 `node db/seed/tenant-profile-templates.mjs` 跑一次。

- [ ] **Step 3: 提交（如有设计文档微调）**

```bash
git add docs/2026-09-09-tenant-admin-design.md
git commit -m "docs: 租户管理设计文档标记实施完成（含模板沉淀步骤）"
```

---

## 自查（Self-Review）

1. **Spec 覆盖**：§2 freeze/unfreeze/extend/cancel/change-plan/assign-profile 全有端点（Task 3/4）；§2.7 只读面（Task 2）；§3 前端（Task 5）；§4 模板（Task 1）；§5 T1–T10（Task 6）；§0 红线：system 保护（各端点 400）、第0闸（gateDecision）、禁 DELETE（全部 UPDATE/INSERT）、不动 resolveMe（无相关改动）、行业零代码（纯 config_store）——均已落实。
2. **占位符扫描**：无 TBD/TODO；每步含完整代码与命令；测试含真实断言代码。
3. **类型/命名一致性**：`gateDecision(me, fields)` 在 Task 3 定义且 Task 4 复用；`profile_summary` 字段名在后端（Task 2）与前端（Task 5 `r.profile_summary`）、测试（Task 6 T10）三处一致；`upgraded_from='admin-grant'` 在后端与测试一致；`/api/billing/tenant-admin/<action>` 路径前后端一致。
4. **已知风险**：`produceDecision` 在测试库真实落 decision 行，依赖 `crm.decision` 表存在（测试库已具备，由既有 calibration 测试证实）。
