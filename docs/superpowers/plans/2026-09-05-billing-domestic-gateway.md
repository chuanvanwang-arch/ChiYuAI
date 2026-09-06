# 实施计划：计费套餐入口可见化 + 微信/支付宝网关

> 对应设计：`docs/2026-09-05-billing-domestic-gateway-design.md`（已批准）
> 模式：子代理驱动 + 两阶段评审；每 Task 独立子代理；沙箱无 git 凭证，仅改文件+跑测试，不 commit。
> 铁律：NO DELETE、迁移 `ADD COLUMN IF NOT EXISTS`、测试 `node node_modules/vitest/vitest.mjs run <file>`（禁 `&&`）、显式路径、不触碰他任务文件。

---

## Task A — 套餐维护前端入口（小）

**文件**：`src/portal/layoutMenu.js`（改）、`test/portal/layoutMenu.test.js`（新建）

A1. `src/portal/layoutMenu.js:25` 改为：
```js
const sys = (role === 'admin' || role === 'sysadmin') ? ADMIN_MENU : [];
```
A2. `ADMIN_MENU` 数组（`layoutMenu.js:17-22`）末尾追加：
```js
  { group: '系统', label: '平台套餐管理', href: '/admin-billing-console.html#plans' },
```

A3. 新建 `test/portal/layoutMenu.test.js`：
```js
import { describe, it, expect } from 'vitest';
import { menuFor } from '../../src/portal/layoutMenu.js';

describe('menuFor 角色可见性', () => {
  it('sysadmin 可见配置中心 + 平台套餐管理直链', () => {
    const m = menuFor('sysadmin');
    expect(m.some(x => x.label === '配置中心')).toBe(true);
    const plan = m.find(x => x.href === '/admin-billing-console.html#plans');
    expect(plan).toBeTruthy();
    expect(plan.label).toBe('平台套餐管理');
  });
  it('ten_admin 不可见系统菜单（不越权）', () => {
    const m = menuFor('ten_admin');
    expect(m.some(x => x.label === '配置中心')).toBe(false);
    expect(m.some(x => x.href === '/admin-billing-console.html#plans')).toBe(false);
  });
});
```

**验证**：`node --check src/portal/layoutMenu.js`；`node node_modules/vitest/vitest.mjs run test/portal/layoutMenu.test.js`（DB-free，应全绿）。

---

## Task B1 — 微信/支付宝网关核心 `domesticGateway.js`（新建）

**文件**：`src/billing/domesticGateway.js`（新建）、`test/billing/domesticGateway.test.js`（新建）

B1.1 创建 `src/billing/domesticGateway.js`，导出 `createPayment` / `verifyNotify` / `applyPaymentResult` / `loadSettings`：
```js
// src/billing/domesticGateway.js — 国内支付网关（微信支付 Native + 支付宝 page 支付）
// 凭据来自 config_store['billing-settings']；无凭据走 simulate 模式（开发期可跑，填凭据即生产）
import { readConfig } from '../config/configStore.js';
import { createSubscription, renewSubscription, upgradeSubscription } from './subscriptionService.js';

const DEFAULTS = {
  enabled_providers: ['wechat', 'alipay'],
  default_provider: 'wechat',
  wechat: { appid: '', mch_id: '', api_key: '', notify_url: '' },
  alipay: { app_id: '', private_key: '', alipay_public_key: '', notify_url: '' },
  stripe: { enabled: false },
};

export async function loadSettings() {
  const row = await readConfig('billing-settings', { tenantId: 'system' });
  const v = row?.value || {};
  return {
    enabled_providers: v.enabled_providers || DEFAULTS.enabled_providers,
    default_provider: v.default_provider || DEFAULTS.default_provider,
    wechat: { ...DEFAULTS.wechat, ...(v.wechat || {}) },
    alipay: { ...DEFAULTS.alipay, ...(v.alipay || {}) },
    stripe: { ...DEFAULTS.stripe, ...(v.stripe || {}) },
  };
}

// 构建支付单：wechat→二维码(code_url)；alipay→跳转收银台(url)；无凭据→simulate
export async function createPayment({ provider, planId, cycle, tenantId, mode = 'upgrade' }) {
  const s = await loadSettings();
  const prov = provider || s.default_provider || 'wechat';
  const order = { tenantId, planId, cycle: cycle || 'monthly', mode, provider: prov };
  if (prov === 'wechat') {
    const w = s.wechat;
    if (!w.appid || !w.mch_id || !w.api_key) return { simulate: true, order };
    const code_url = await wechatNativeOrder({ ...order, ...w });
    return { qrUrl: code_url, provider: 'wechat', order };
  }
  if (prov === 'alipay') {
    const a = s.alipay;
    if (!a.app_id || !a.private_key) return { simulate: true, order };
    const redirectUrl = await alipayPagePay({ ...order, ...a });
    return { redirectUrl, provider: 'alipay', order };
  }
  if (prov === 'stripe') {
    if (!s.stripe?.enabled) return { disabled: true, provider: 'stripe' };
    return { provider: 'stripe', order }; // 由 billingRoutes 走原 stripeGateway
  }
  return { simulate: true, order };
}

// 微信 Native 下单（curl 风格 fetch；返回 code_url）
async function wechatNativeOrder({ tenantId, planId, cycle, mode, appid, mch_id, api_key, notify_url }) {
  // 真实实现：组装 unifiedorder XML + 签名（MD5/HMAC），调 https://api.mch.weixin.qq.com/pay/unifiedorder
  // 沙箱无凭据不进此分支；保留真实签名骨架待凭据注入
  throw new Error('wechat native order requires live credentials');
}

// 支付宝 page 支付（返回跳转 URL）
async function alipayPagePay({ tenantId, planId, cycle, mode, app_id, private_key, alipay_public_key, notify_url }) {
  // 真实实现：组装 alipay.trade.page.pay 表单 + RSA2 签名，返回 redirect form/url
  throw new Error('alipay page pay requires live credentials');
}

// 异步通知验签：wechat HMAC-SHA256 / alipay RSA2；失败 false
export async function verifyNotify(provider, payload, headers = {}, secret = '') {
  if (provider === 'wechat') {
    if (!secret) return false;
    try {
      const crypto = await import('node:crypto');
      const hmac = crypto.createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex');
      return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(headers['wechat-signature'] || ''));
    } catch { return false; }
  }
  if (provider === 'alipay') {
    if (!secret) return false;
    try {
      const crypto = await import('node:crypto');
      const vk = crypto.createPublicKey(secret);
      return crypto.verify('RSA-SHA256', Buffer.from(payload.signContent || ''), vk, Buffer.from(payload.signature || '', 'base64'));
    } catch { return false; }
  }
  return false;
}

// 支付结果落地：复用订阅状态机
export async function applyPaymentResult({ tenantId, planId, mode = 'upgrade', cycle = 'monthly' }) {
  if (!tenantId || !planId) return { ok: false, error: 'missing params' };
  if (mode === 'renew') await renewSubscription(tenantId, planId, cycle);
  else if (mode === 'upgrade') await upgradeSubscription(tenantId, planId, cycle);
  else await createSubscription(tenantId, planId, cycle);
  return { ok: true };
}
```

B1.2 新建 `test/billing/domesticGateway.test.js`（DB-free，验证 simulate + 验签分支）：
```js
import { describe, it, expect } from 'vitest';
import { verifyNotify, applyPaymentResult } from '../../src/billing/domesticGateway.js';

describe('domesticGateway 单元', () => {
  it('verifyNotify 无密钥返回 false', async () => {
    expect(await verifyNotify('wechat', { a: 1 }, {}, '')).toBe(false);
    expect(await verifyNotify('alipay', { signContent: 'x' }, {}, '')).toBe(false);
  });
  it('applyPaymentResult 缺参返回 ok:false', async () => {
    const r = await applyPaymentResult({ tenantId: null, planId: null });
    expect(r.ok).toBe(false);
  });
});
```
> 注：`createPayment` 依赖 PG（readConfig）→ 不在 DB-free 测试内；其 simulate 分支业务逻辑由 billingRoutes 集成测试覆盖（PG 起后跑）。

**验证**：`node --check src/billing/domesticGateway.js`；`node node_modules/vitest/vitest.mjs run test/billing/domesticGateway.test.js`。

---

## Task B2 — billingRoutes 接入国内网关（改）

**文件**：`src/http/billingRoutes.js`（改）

B2.1 替换 `POST /api/billing/subscribe`（原 `billingRoutes.js:200-212`）为：
```js
  router.post('/api/billing/subscribe', async (req, res) => {
    const me = resolveMe(req);
    if (!me?.ok) return res.status(401).json({ error: 'unauthorized' });
    const { tenantId, planId, cycle = 'monthly', mode = 'upgrade', provider } = req.body || {};
    if (!tenantId || !planId) return res.status(400).json({ error: 'tenantId & planId required' });
    const scope = scopeTenant(me);
    if (scope !== '*' && scope !== tenantId) return res.status(403).json({ error: 'cannot subscribe other tenant' });
    try {
      const { createPayment, loadSettings } = await import('../billing/domesticGateway.js');
      const s = await loadSettings();
      const prov = provider || s.default_provider || 'wechat';
      if (prov === 'stripe') {
        if (!s.stripe?.enabled) return res.status(403).json({ error: 'stripe disabled' });
        const { buildCheckoutSession } = await import('../billing/stripeGateway.js');
        const session = await buildCheckoutSession(planId, cycle, tenantId, mode);
        return res.json({ ok: true, provider: 'stripe', url: session.url, session_id: session.id });
      }
      const pay = await createPayment({ provider: prov, planId, cycle, tenantId, mode });
      if (pay.disabled) return res.status(403).json({ error: 'provider disabled', provider: pay.provider });
      return res.json({ ok: true, ...pay });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
```

B2.2 在 subscribe 之后新增三个路由（notify + simulate-confirm；保留 stripe webhook 不变）：
```js
  // 微信支付异步通知（验签 → 状态机）
  router.post('/api/billing/wechat/notify', async (req, res) => {
    try {
      const { verifyNotify, applyPaymentResult } = await import('../billing/domesticGateway.js');
      const s = (await readConfig('billing-settings', { tenantId: 'system' }))?.value?.wechat || {};
      const raw = req.body || {};
      if (!(await verifyNotify('wechat', raw, req.headers, s.api_key))) return res.status(400).json({ error: 'invalid signature' });
      const { tenant_id, plan_id, mode } = raw;
      await applyPaymentResult({ tenantId: tenant_id, planId: plan_id, mode });
      res.json({ received: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // 支付宝异步通知
  router.post('/api/billing/alipay/notify', async (req, res) => {
    try {
      const { verifyNotify, applyPaymentResult } = await import('../billing/domesticGateway.js');
      const s = (await readConfig('billing-settings', { tenantId: 'system' }))?.value?.alipay || {};
      const raw = req.body || {};
      if (!(await verifyNotify('alipay', raw, req.headers, s.alipay_public_key))) return res.status(400).json({ error: 'invalid signature' });
      const { tenant_id, plan_id, mode } = raw;
      await applyPaymentResult({ tenantId: tenant_id, planId: plan_id, mode });
      res.json({ received: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // 开发期模拟支付确认（simulate 模式）
  router.post('/api/billing/subscribe/simulate-confirm', async (req, res) => {
    const me = resolveMe(req);
    if (!me?.ok) return res.status(401).json({ error: 'unauthorized' });
    const { order } = req.body || {};
    if (!order) return res.status(400).json({ error: 'order required' });
    const scope = scopeTenant(me);
    if (scope !== '*' && scope !== order.tenantId) return res.status(403).json({ error: 'cannot confirm other tenant' });
    try {
      const { applyPaymentResult } = await import('../billing/domesticGateway.js');
      const r = await applyPaymentResult(order);
      res.json(r);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
```

**验证**：`node --check src/http/billingRoutes.js`。

---

## Task B3 — billing.html 前端支付方式选择（改）

**文件**：`src/web/billing.html`（改）

B3.1 在 `#upgrade-modal` 内（原升级弹窗，含 `upgrade-plan` / `upgrade-cycle` 选择器）增加支付方式单选：
```html
<label class="fld">支付方式
  <select id="upgrade-provider">
    <option value="wechat">微信支付（扫码）</option>
    <option value="alipay">支付宝</option>
  </select>
</label>
```

B3.2 改写 `startUpgrade()`（`billing.html:538-545`）与 `startRenew()`（`billing.html:546-554`）：
```js
  async function startUpgrade() {
    const planId = document.getElementById('upgrade-plan').value;
    const cycle = document.getElementById('upgrade-cycle').value;
    const provider = document.getElementById('upgrade-provider').value;
    try {
      const r = await api('/api/billing/subscribe', { method: 'POST', body: JSON.stringify({ tenantId: ME_TENANT, planId, cycle, mode: 'upgrade', provider }) });
      if (r.disabled) { alert('该支付渠道已停用'); return; }
      if (r.qrUrl) return showQr(r.qrUrl, r.order);
      if (r.redirectUrl) { window.location.href = r.redirectUrl; return; }
      if (r.simulate) { showSimulate(r.order); return; }
      if (r.url) window.location.href = r.url; // 仅 stripe 休眠通道
    } catch (e) { alert('升级失败：' + e.message); }
  }
  async function startRenew() {
    const sub = await loadSubscription();
    const planId = sub?.plan_id || PLANS[0]?.plan_id;
    const cycle = document.getElementById('upgrade-cycle').value;
    const provider = document.getElementById('upgrade-provider').value;
    try {
      const r = await api('/api/billing/subscribe', { method: 'POST', body: JSON.stringify({ tenantId: ME_TENANT, planId, cycle, mode: 'renew', provider }) });
      if (r.disabled) { alert('该支付渠道已停用'); return; }
      if (r.qrUrl) return showQr(r.qrUrl, r.order);
      if (r.redirectUrl) { window.location.href = r.redirectUrl; return; }
      if (r.simulate) { showSimulate(r.order); return; }
      if (r.url) window.location.href = r.url;
    } catch (e) { alert('续费失败：' + e.message); }
  }
```

B3.3 新增两个辅助函数 + 两个弹窗（二维码弹窗、模拟确认弹窗）：
```js
  function showQr(codeUrl, order) {
    const m = document.getElementById('qr-modal');
    document.getElementById('qr-img').src = 'https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=' + encodeURIComponent(codeUrl);
    document.getElementById('qr-raw').textContent = codeUrl;
    m.dataset.order = JSON.stringify(order);
    m.classList.add('show');
  }
  function showSimulate(order) {
    const m = document.getElementById('sim-modal');
    m.dataset.order = JSON.stringify(order);
    m.classList.add('show');
  }
  document.getElementById('qr-cancel').onclick = () => document.getElementById('qr-modal').classList.remove('show');
  document.getElementById('sim-confirm').onclick = async () => {
    const order = JSON.parse(document.getElementById('sim-modal').dataset.order || '{}');
    try {
      await api('/api/billing/subscribe/simulate-confirm', { method: 'POST', body: JSON.stringify({ order }) });
      document.getElementById('sim-modal').classList.remove('show');
      alert('模拟支付成功，套餐已生效');
      await loadSubscription(); await loadLiveCost();
    } catch (e) { alert('模拟支付失败：' + e.message); }
  };
  document.getElementById('sim-cancel').onclick = () => document.getElementById('sim-modal').classList.remove('show');
```
> 在 `billing.html` 的 modal 区（与 `upgrade-modal`/`pay-modal` 同级）追加：
```html
<div class="modal" id="qr-modal"><div class="box">
  <h3>微信扫码支付</h3>
  <img id="qr-img" alt="qr" style="width:220px;height:220px;display:block;margin:8px auto">
  <div class="sub" id="qr-raw"></div>
  <crm-button class="btn" id="qr-cancel">关闭</crm-button>
</div></div>
<div class="modal" id="sim-modal"><div class="box">
  <h3>模拟支付（开发期）</h3>
  <p class="sub">当前未配置真实商户凭据，使用模拟支付确认。</p>
  <crm-button class="btn" id="sim-confirm">模拟支付成功</crm-button>
  <crm-button class="btn" id="sim-cancel">取消</crm-button>
</div></div>
```

**验证**：读回 `billing.html` 确认 selector id 与 JS 引用一致（HTML 非可执行，靠读审 + 冒烟测试）。

---

## Task B5 — 冒烟 + 回归（DB-free）

**文件**：`test/web/billing-domestic.smoke.test.js`（新建，DB-free）

```js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const billing = readFileSync('src/web/billing.html', 'utf8');
describe('billing.html 国内支付前端冒烟', () => {
  it('含支付方式选择 + 二维码弹窗 + 模拟确认', () => {
    expect(billing).toContain('upgrade-provider');
    expect(billing).toContain('qr-modal');
    expect(billing).toContain('sim-modal');
    expect(billing).toContain('subscribe/simulate-confirm');
  });
});
```

**验证**：`node node_modules/vitest/vitest.mjs run test/web/billing-domestic.smoke.test.js`。

---

## 提交分组（PowerShell · 显式路径 · 禁 git add -A）

```powershell
# 线A 套餐入口
git add src/portal/layoutMenu.js test/portal/layoutMenu.test.js
git commit -m "feat(billing): 平台套餐管理入口 sysadmin 可见 + 系统菜单直链"

# 线B 国内支付网关
git add src/billing/domesticGateway.js src/http/billingRoutes.js src/web/billing.html
git commit -m "feat(billing): 微信/支付宝网关替换 Stripe（默认通道，Stripe 休眠）"

# 线C 测试
git add test/billing/domesticGateway.test.js test/web/billing-domestic.smoke.test.js
git commit -m "test(billing): 国内支付网关单元 + 前端冒烟"
```
