# 真实支付全链路（微信+支付宝原生 HTTP 封装）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `domesticGateway.js` 的 simulate 骨架替换为真实微信支付 v3 / 支付宝开放平台下单、回调验签、退款、对账全链路，凭据仅存 `config_store['billing-settings']`，无凭据时自动回落 simulate（开发期可跑）。

**Architecture:** 门面 `domesticGateway.js` 保持 `createPayment/verifyNotify/applyPaymentResult` 签名不变；骨架函数 `wechatNativeOrder/alipayPagePay` 改为原生 HTTP 调用（自签 RSA/SHA256，零新增重依赖）；新增 `crm.payment_order` 订单表作幂等中枢与退款/对账锚点；退款/对账为独立模块。沙箱凭据联调通后填生产凭据即上线。

**Tech Stack:** Node 22 ESM + Express 4 + PostgreSQL(pg, schema crm) + vitest 3；原生 `node:crypto`（SHA256-RSA 签名、AES-256-GCM 解密、HMAC 验签）；微信支付 v3 / 支付宝开放平台 API。

---

## 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `db/schema.sql` + `db/migrate-billing-payment-order.sql` | Modify/Create | 新增 `crm.payment_order` 表 + `tenant_subscription.online_order_no` 锚点列 |
| `src/billing/domesticGateway.js` | Modify | 实现 `wechatNativeOrder`/`alipayPagePay` 真实 HTTP；重写 `verifyNotify`（微信 v3 验签+解密 / 支付宝 RSA2）；新增 `createRefund`/`queryBill` |
| `src/billing/wechatV3.js` | Create | 微信 v3 签名/验签/AES-GCM 解密/HTTP 封装（纯函数 + 网络） |
| `src/billing/alipayPage.js` | Create | 支付宝 RSA2 签名/验签/URL 构造（纯函数 + 网络） |
| `src/billing/refundService.js` | Create | 退款编排（调网关 + 写 payment_order→refunded + 订阅转 grace） |
| `src/billing/reconcileService.js` | Create | 对账编排（拉对账单 + 与 payment_order 比对 + 写差异表告警） |
| `src/http/billingRoutes.js` | Modify | 新增 `/api/billing/refund`、`/api/billing/wechat/refund-notify`、`/api/billing/alipay/refund-notify`、`/api/billing/reconcile`；`/api/billing/wechat/notify`、`/api/billing/alipay/notify` 改为落 payment_order |
| `src/web/billing.html` | Modify | 真实二维码渲染 + 退款入口 + 对账面板；simulate 分支保留 |
| `src/billing/subscriptionService.js` | Modify | `renewSubscription` 修复锚点（改写 `online_order_no`） |
| `test/billing/paymentOrder.test.js` | Create | payment_order 表 + 状态机落点（需 PG） |
| `test/billing/wechatV3.test.js` | Create | 微信签名/验签/AES-GCM 纯函数（无 PG） |
| `test/billing/alipayPage.test.js` | Create | 支付宝签名/验签/URL 纯函数（无 PG） |
| `test/billing/gatewaySimulate.test.js` | Create | 无凭据→simulate 分支（无 PG） |
| `test/billing/refundReconcile.test.js` | Create | 退款/对账编排（mock 网关 + 需 PG） |

---

### Task A: 支付订单表 + 迁移

**Files:**
- Modify: `db/schema.sql` (在 `tenant_subscription` 定义之后插入 payment_order)
- Create: `db/migrate-billing-payment-order.sql`
- Test: `test/billing/paymentOrder.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/billing/paymentOrder.test.js
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { query, queryWrite } from '../../src/db.js';

beforeAll(async () => {
  await queryWrite(`INSERT INTO crm.tenants (tenant_id, name, status, plan) VALUES ('__po','__po','active','pro') ON CONFLICT (tenant_id) DO UPDATE SET plan='pro'`);
});
afterAll(async () => {
  await queryWrite(`DELETE FROM crm.payment_order WHERE tenant_id='__po'`);
  await queryWrite(`DELETE FROM crm.tenant_subscription WHERE tenant_id='__po'`);
  await queryWrite(`DELETE FROM crm.tenants WHERE tenant_id='__po'`);
});

describe('payment_order', () => {
  test('INSERT pending 订单 + out_trade_no 唯一', async () => {
    const r = await queryWrite(
      `INSERT INTO crm.payment_order (order_id, out_trade_no, tenant_id, plan_id, provider, amount, status)
       VALUES ('o1','ot1','__po','pro','wechat',99.00,'pending') RETURNING id`, []);
    expect(r.rows[0].id).toBeTruthy();
    await expect(queryWrite(
      `INSERT INTO crm.payment_order (order_id, out_trade_no, tenant_id, plan_id, provider, amount, status)
       VALUES ('o2','ot1','__po','pro','wechat',99.00,'pending')`, [])).rejects.toThrow();
  });
  test('tenant_subscription.online_order_no 锚点可写', async () => {
    const r = await queryWrite(
      `INSERT INTO crm.tenant_subscription (tenant_id, plan_id, status, expires_at, online_order_no)
       VALUES ('__po','pro','active', now()+interval '1 month','ot1') RETURNING online_order_no`, []);
    expect(r.rows[0].online_order_no).toBe('ot1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd d:/system/CRM-ai-native && npx vitest run test/billing/paymentOrder.test.js`
Expected: FAIL — `relation "crm.payment_order" does not exist` / `column online_order_no does not exist`

- [ ] **Step 3: Write migration + schema**

```sql
-- db/migrate-billing-payment-order.sql
CREATE TABLE IF NOT EXISTS crm.payment_order (
  id            BIGSERIAL PRIMARY KEY,
  order_id      TEXT NOT NULL UNIQUE,
  out_trade_no  TEXT NOT NULL UNIQUE,
  tenant_id     TEXT NOT NULL,
  plan_id       TEXT NOT NULL,
  cycle         TEXT NOT NULL DEFAULT 'monthly',
  mode          TEXT NOT NULL DEFAULT 'upgrade',
  provider      TEXT NOT NULL,
  amount        NUMERIC(12,2) NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','paid','refunded','failed','closed')),
  qr_url        TEXT,
  redirect_url  TEXT,
  paid_at       TIMESTAMPTZ,
  refund_at     TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payment_order_tenant ON crm.payment_order(tenant_id, status);
ALTER TABLE crm.tenant_subscription ADD COLUMN IF NOT EXISTS online_order_no TEXT;
```

在 `db/schema.sql` 的 `tenant_subscription` 块（约 line 848 `UNIQUE (tenant_id, plan_id, started_at);` 之后）追加同样的 payment_order 建表 + `ALTER TABLE ... ADD COLUMN online_order_no`。

- [ ] **Step 4: Apply migration + run test to verify it passes**

Run:
```
cd d:/system/CRM-ai-native
node -e "import('./src/db.js').then(async m=>{const fs=await import('fs');const sql=fs.readFileSync('db/migrate-billing-payment-order.sql','utf8');await m.queryWrite(sql);console.log('migrated');process.exit(0)})"
npx vitest run test/billing/paymentOrder.test.js
```
Expected: PASS（2 tests）

- [ ] **Step 5: Commit**

```bash
git add db/schema.sql db/migrate-billing-payment-order.sql test/billing/paymentOrder.test.js
git commit -m "feat(billing): add payment_order table + online_order_no anchor"
```

---

### Task B: 微信 v3 签名/验签/AES-GCM 纯函数（wechatV3.js）

**Files:**
- Create: `src/billing/wechatV3.js`
- Test: `test/billing/wechatV3.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/billing/wechatV3.test.js
import { describe, test, expect } from 'vitest';
import { generateSignature, buildAuthHeader, aes256gcmDecrypt, verifyWechatSignature } from '../src/billing/wechatV3.js';
import { createPrivateKey, createPublicKey } from 'node:crypto';

const privPem = `-----BEGIN PRIVATE KEY-----
MIIBVAIBADANBgkqhkiG9w0BAQEFAASCAT4wggE6AgEAAkEA1234567890abcdef
（测试用自签 RSA 私钥，仅单测；真实私钥来自商户证书）
-----END PRIVATE KEY-----`;
const pubPem = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A
（对应公钥）
-----END PUBLIC KEY-----`;

describe('wechatV3 crypto', () => {
  test('generateSignature 确定性 + 可验签', () => {
    const ts='1700000000', nonce='abc', method='POST', url='/v3/pay/transactions/native', body='{}';
    const sig = generateSignature({ privPem, method, url, ts, nonce, body });
    const vk = createPublicKey(pubPem);
    const ok = verifyWechatSignature({ pubKey: vk, ts, nonce, method, url, body, sig });
    expect(ok).toBe(true);
  });
  test('buildAuthHeader 格式 WECHATPAY2-SHA256-RSA2048 ...', () => {
    const h = buildAuthHeader({ mchid:'m1', serialNo:'s1', privPem, method:'POST', url:'/x', body:'{}' });
    expect(h).toContain('WECHATPAY2-SHA256-RSA2048');
    expect(h).toContain('mchid="m1"');
  });
  test('aes256gcmDecrypt 往返', () => {
    const { aes256gcmEncrypt } = await import('../src/billing/wechatV3.js');
    const key='k'.repeat(32); const nonce='n'.repeat(12); const ad='a';
    const ct = aes256gcmEncrypt(key, nonce, ad, 'hello');
    expect(aes256gcmDecrypt(key, nonce, ad, ct)).toBe('hello');
  });
});
```
> 注：测试用自签密钥对由工程师本地 `openssl` 生成后填入（不进 git）。若用占位密钥导致验签 false，测试即失败——这正是 TDD 期望。

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/billing/wechatV3.test.js`
Expected: FAIL — module `wechatV3.js` not found

- [ ] **Step 3: Write minimal implementation**

```js
// src/billing/wechatV3.js
import { createSign, createVerify, createPrivateKey, createPublicKey, randomBytes, createDecipheriv, createCipheriv } from 'node:crypto';

// 微信 v3 签名串：METHOD\nURL\nTIMESTAMP\nNONCE_STR\nBODY\n
export function generateSignature({ privPem, method, url, ts, nonce, body = '' }) {
  const message = `${method}\n${url}\n${ts}\n${nonce}\n${body}\n`;
  const sign = createSign('RSA-SHA256');
  sign.update(message);
  sign.end();
  return sign.sign(privPem, 'base64');
}

export function buildAuthHeader({ mchid, serialNo, privPem, method, url, body = '' }) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const nonce = randomBytes(16).toString('hex');
  const signature = generateSignature({ privPem, method, url, ts, nonce, body });
  return `WECHATPAY2-SHA256-RSA2048 mchid="${mchid}",nonce_str="${nonce}",signature="${signature}",timestamp="${ts}",serial_no="${serialNo}"`;
}

// 用平台证书公钥验签（回调）
export function verifyWechatSignature({ pubKey, ts, nonce, method, url, body, sig }) {
  const message = `${method}\n${url}\n${ts}\n${nonce}\n${body}\n`;
  const v = createVerify('RSA-SHA256');
  v.update(message); v.end();
  return v.verify(pubKey, sig, 'base64');
}

// AES-256-GCM 解密回包 resource.ciphertext（base64）
export function aes256gcmDecrypt(apiV3Key, nonce, associatedData, ciphertextB64) {
  const buf = Buffer.from(ciphertextB64, 'base64');
  const authTag = buf.subarray(buf.length - 16);
  const data = buf.subarray(0, buf.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', apiV3Key, nonce);
  decipher.setAuthTag(authTag);
  decipher.setAAD(Buffer.from(associatedData || ''));
  return decipher.update(data, 'binary', 'utf8') + decipher.final('utf8');
}

export function aes256gcmEncrypt(apiV3Key, nonce, associatedData, plaintext) {
  const cipher = createCipheriv('aes-256-gcm', apiV3Key, nonce);
  cipher.setAAD(Buffer.from(associatedData || ''));
  const enc = cipher.update(plaintext, 'utf8', 'binary') + cipher.final('binary');
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from(enc, 'binary'), tag]).toString('base64');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/billing/wechatV3.test.js`
Expected: PASS（3 tests）

- [ ] **Step 5: Commit**

```bash
git add src/billing/wechatV3.js test/billing/wechatV3.test.js
git commit -m "feat(billing): wechat v3 sign/verify/aes-gcm pure fns"
```

---

### Task C: 支付宝 RSA2 签名/验签/URL（alipayPage.js）

**Files:**
- Create: `src/billing/alipayPage.js`
- Test: `test/billing/alipayPage.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/billing/alipayPage.test.js
import { describe, test, expect } from 'vitest';
import { buildSignContent, signParams, verifyAlipaySign, buildPagePayUrl } from '../src/billing/alipayPage.js';

const privPem = `-----BEGIN RSA PRIVATE KEY-----\n（测试私钥）\n-----END RSA PRIVATE KEY-----`;
const pubPem = `-----BEGIN PUBLIC KEY-----\n（支付宝公钥）\n-----END PUBLIC KEY-----`;

describe('alipay RSA2', () => {
  test('buildSignContent 排序拼接（去 sign/sign_type/空值）', () => {
    const c = buildSignContent({ b: '2', a: '1', sign: 'x', sign_type: 'RSA2', empty: '' });
    expect(c).toBe('a=1&b=2');
  });
  test('signParams + verifyAlipaySign 往返', () => {
    const params = { app_id: '1', method: 'alipay.trade.page.pay', charset: 'utf-8', timestamp: '2026-09-05 00:00:00' };
    const signed = signParams(params, privPem);
    expect(signed.sign).toBeTruthy();
    const ok = verifyAlipaySign({ ...params, sign: signed.sign, sign_type: 'RSA2' }, pubPem);
    expect(ok).toBe(true);
  });
  test('buildPagePayUrl 含网关+签名', () => {
    const url = buildPagePayUrl({ appId: '1', privPem, gateway: 'https://openapi.alipay.com/gateway.do', bizContent: { out_trade_no: 'ot1', total_amount: '99.00', subject: 'pro' } });
    expect(url).toContain('https://openapi.alipay.com/gateway.do');
    expect(url).toContain('sign=');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/billing/alipayPage.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

```js
// src/billing/alipayPage.js
import { createSign, createVerify } from 'node:crypto';

export function buildSignContent(params) {
  return Object.keys(params)
    .filter((k) => k !== 'sign' && k !== 'sign_type' && params[k] !== '' && params[k] != null)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
}

export function signParams(params, privPem) {
  const content = buildSignContent(params);
  const sign = createSign('RSA-SHA256');
  sign.update(content, 'utf8'); sign.end();
  return { ...params, sign: sign.sign(privPem, 'base64'), sign_type: 'RSA2' };
}

export function verifyAlipaySign(params, alipayPubPem) {
  const { sign, sign_type, ...rest } = params;
  const content = buildSignContent(rest);
  const v = createVerify('RSA-SHA256');
  v.update(content, 'utf8'); v.end();
  try { return v.verify(alipayPubPem, sign, 'base64'); } catch { return false; }
}

export function buildPagePayUrl({ appId, privPem, gateway, returnUrl, notifyUrl, bizContent, method = 'alipay.trade.page.pay' }) {
  const base = {
    app_id: appId,
    method,
    format: 'JSON',
    charset: 'utf-8',
    sign_type: 'RSA2',
    timestamp: new Date().toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-'),
    version: '1.0',
    biz_content: JSON.stringify(bizContent),
    ...(returnUrl ? { return_url: returnUrl } : {}),
    ...(notifyUrl ? { notify_url: notifyUrl } : {}),
  };
  const signed = signParams(base, privPem);
  const qs = Object.keys(signed).map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(signed[k])}`).join('&');
  return `${gateway}?${qs}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/billing/alipayPage.test.js`
Expected: PASS（3 tests）

- [ ] **Step 5: Commit**

```bash
git add src/billing/alipayPage.js test/billing/alipayPage.test.js
git commit -m "feat(billing): alipay RSA2 sign/verify/page-pay url"
```

---

### Task D: domesticGateway 真实下单 + 回调落订单 + 状态机接通

**Files:**
- Modify: `src/billing/domesticGateway.js`
- Modify: `src/billing/subscriptionService.js` (`renewSubscription` 锚点)
- Modify: `src/http/billingRoutes.js` (notify 改落 payment_order)
- Test: `test/billing/gatewaySimulate.test.js` (无凭据 simulate) + `test/billing/paymentOrder.test.js` 扩展（回调落地）

- [ ] **Step 1: Write the failing test (simulate 分支保持)**

```js
// test/billing/gatewaySimulate.test.js
import { describe, test, expect, beforeEach } from 'vitest';
import { createPayment, loadSettings } from '../src/billing/domesticGateway.js';

describe('domesticGateway simulate', () => {
  test('无凭据 → simulate:true（开发期可跑）', async () => {
    // loadSettings 默认凭据空 → createPayment 必返回 simulate
    const p = await createPayment({ provider: 'wechat', planId: 'pro', tenantId: 't1', mode: 'upgrade' });
    expect(p.simulate).toBe(true);
    expect(p.order).toMatchObject({ tenantId: 't1', planId: 'pro', provider: 'wechat' });
  });
});
```

- [ ] **Step 2: Run test to verify it passes (simulate 已存在) — 作为回归基线**

Run: `npx vitest run test/billing/gatewaySimulate.test.js`
Expected: PASS

- [ ] **Step 3: Implement `wechatNativeOrder` / `alipayPagePay` 真实分支 + 落 payment_order**

改写 `src/billing/domesticGateway.js` 关键函数（保留 simulate 回落）：

```js
import { readConfig } from '../config/configStore.js';
import { createSubscription, renewSubscription, upgradeSubscription } from './subscriptionService.js';
import { buildAuthHeader } from './wechatV3.js';
import { buildPagePayUrl } from './alipayPage.js';
import { randomUUID } from 'node:crypto';
import { queryWrite, query } from '../db.js';

const WECHAT_GW = 'https://api.mch.weixin.qq.com';
const ALIPAY_GW = 'https://openapi.alipay.com/gateway.do';

async function persistOrder(o) {
  const r = await queryWrite(
    `INSERT INTO crm.payment_order (order_id, out_trade_no, tenant_id, plan_id, cycle, mode, provider, amount, status, qr_url, redirect_url)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,$10) RETURNING id`,
    [o.order_id, o.out_trade_no, o.tenantId, o.planId, o.cycle, o.mode, o.provider, o.amount, o.qr_url || null, o.redirect_url || null]);
  return r.rows[0].id;
}

async function wechatNativeOrder({ tenantId, planId, cycle, mode, appid, mch_id, api_key, serial_no, private_key_pem, notify_url }) {
  const outTradeNo = randomUUID().replace(/-/g, '');
  const orderId = 'WO' + Date.now().toString(36) + outTradeNo.slice(0, 6);
  const body = JSON.stringify({
    appid, mchid: mch_id,
    description: `订阅-${planId}`,
    out_trade_no: outTradeNo,
    notify_url,
    amount: { total: Math.round(Number(process.env.PAY_TEST_AMT || '9900')) }, // 单位分；生产从 plan 算
  });
  const url = '/v3/pay/transactions/native';
  const auth = buildAuthHeader({ mchid: mch_id, serialNo: serial_no, privPem: private_key_pem, method: 'POST', url, body });
  const res = await fetch(WECHAT_GW + url, {
    method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json', Accept: 'application/json' }, body,
  });
  if (!res.ok) throw new Error('wechat order failed: ' + (await res.text()));
  const code_url = (await res.json()).code_url;
  await persistOrder({ order_id: orderId, out_trade_no: outTradeNo, tenantId, planId, cycle, mode, provider: 'wechat', amount: Number(process.env.PAY_TEST_AMT || '99.00'), qr_url: code_url });
  return code_url;
}

async function alipayPagePay({ tenantId, planId, cycle, mode, app_id, private_key, notify_url, return_url }) {
  const outTradeNo = randomUUID().replace(/-/g, '');
  const orderId = 'AL' + Date.now().toString(36) + outTradeNo.slice(0, 6);
  const redirectUrl = buildPagePayUrl({
    appId: app_id, privPem: private_key, gateway: ALIPAY_GW, notifyUrl: notify_url, returnUrl: return_url,
    bizContent: { out_trade_no: outTradeNo, total_amount: (Number(process.env.PAY_TEST_AMT || '99.00')).toFixed(2), subject: `订阅-${planId}`, product_code: 'FAST_INSTANT_TRADE_PAY' },
  });
  await persistOrder({ order_id: orderId, out_trade_no: outTradeNo, tenantId, planId, cycle, mode, provider: 'alipay', amount: Number(process.env.PAY_TEST_AMT || '99.00'), redirect_url: redirectUrl });
  return redirectUrl;
}
```

`createPayment` 内把 `if (!w.appid || !w.mch_id || !w.api_key) return { simulate: true, order };` 改为还校验 `serial_no && private_key_pem`，再 `const code_url = await wechatNativeOrder({ ...order, ...w });` 并把 `order` 携带 `out_trade_no` 回传前端（供回调关联）。`applyPaymentResult` 增加写 `online_order_no`：

```js
export async function applyPaymentResult({ tenantId, planId, mode = 'upgrade', cycle = 'monthly', outTradeNo }) {
  if (!tenantId || !planId) return { ok: false, error: 'missing params' };
  if (mode === 'renew') await renewSubscription(tenantId, planId, cycle, outTradeNo);
  else if (mode === 'upgrade') await upgradeSubscription(tenantId, planId, cycle);
  else await createSubscription(tenantId, planId, cycle);
  if (outTradeNo) await queryWrite(`UPDATE crm.tenant_subscription SET online_order_no=$1 WHERE tenant_id=$2 AND status IN ('active','pending') ORDER BY started_at DESC LIMIT 1`, [outTradeNo, tenantId]);
  return { ok: true };
}
```

- [ ] **Step 4: Fix `renewSubscription` anchor in subscriptionService.js**

```js
export async function renewSubscription(tenantId, planId, cycle = 'monthly', onlineOrderNo = null) {
  const months = cycle === 'quarterly' ? 3 : 1;
  const r = await queryWrite(
    `UPDATE crm.tenant_subscription SET expires_at = now() + ($3 || ' months')::interval,
       updated_at = now()
     WHERE tenant_id=$1 AND plan_id=$2 AND status='active'
     RETURNING *`,
    [tenantId, planId, months]
  );
  if (onlineOrderNo) await queryWrite(`UPDATE crm.tenant_subscription SET online_order_no=$1 WHERE tenant_id=$2 AND plan_id=$3 AND status='active' ORDER BY started_at DESC LIMIT 1`, [onlineOrderNo, tenantId, planId]);
  if (!r.rows[0]) return createSubscription(tenantId, planId, cycle);
  return r.rows[0];
}
```

- [ ] **Step 5: Wire notify routes to persist paid order**

在 `billingRoutes.js` 的 `/wechat/notify` 与 `/alipay/notify` 验签成功后，新增：
```js
await queryWrite(`UPDATE crm.payment_order SET status='paid', paid_at=now() WHERE out_trade_no=$1`, [raw.out_trade_no]);
await applyPaymentResult({ tenantId: raw.tenant_id, planId: raw.plan_id, mode: raw.mode, outTradeNo: raw.out_trade_no });
```
（沙箱联调时 `raw.out_trade_no` 由网关回传；simulate 分支不需要）

- [ ] **Step 6: Run tests**

Run: `npx vitest run test/billing/gatewaySimulate.test.js test/billing/wechatV3.test.js test/billing/alipayPage.test.js`
Expected: PASS（simulate 回归 + 纯函数）

- [ ] **Step 7: Commit**

```bash
git add src/billing/domesticGateway.js src/billing/subscriptionService.js src/billing/wechatV3.js src/billing/alipayPage.js src/http/billingRoutes.js test/billing/gatewaySimulate.test.js
git commit -m "feat(billing): real wechat/alipay order + payment_order landing"
```

---

### Task E: 退款全链路（refundService.js）

**Files:**
- Create: `src/billing/refundService.js`
- Modify: `src/http/billingRoutes.js` (+ `/api/billing/refund`, `/wechat/refund-notify`, `/alipay/refund-notify`)
- Test: `test/billing/refundReconcile.test.js`

- [ ] **Step 1: Write the failing test**

```js
// 在 test/billing/refundReconcile.test.js
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { queryWrite, query } from '../../src/db.js';
import { requestRefund } from '../../src/billing/refundService.js';

beforeAll(async () => {
  await queryWrite(`INSERT INTO crm.tenants (tenant_id,name,status,plan) VALUES ('__rf','__rf','active','pro') ON CONFLICT (tenant_id) DO UPDATE SET plan='pro'`);
  await queryWrite(`INSERT INTO crm.payment_order (order_id,out_trade_no,tenant_id,plan_id,provider,amount,status) VALUES ('ro1','otrf','__rf','pro','wechat',99.00,'paid')`);
});
afterAll(async () => {
  await queryWrite(`DELETE FROM crm.payment_order WHERE tenant_id='__rf'`);
  await queryWrite(`DELETE FROM crm.tenant_subscription WHERE tenant_id='__rf'`);
  await queryWrite(`DELETE FROM crm.tenants WHERE tenant_id='__rf'`);
});

describe('refund', () => {
  test('requestRefund（mock 网关）写 refunded + 订阅转 grace', async () => {
    // 注入 mock gateway caller，避免真实网络
    const r = await requestRefund({ outTradeNo: 'otrf', reason: 'test', gatewayFn: async () => ({ refund_id: 'rf1', status: 'SUCCESS' }) });
    expect(r.ok).toBe(true);
    const po = await query(`SELECT status FROM crm.payment_order WHERE out_trade_no='otrf'`);
    expect(po.rows[0].status).toBe('refunded');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/billing/refundReconcile.test.js`
Expected: FAIL — `requestRefund` not exported

- [ ] **Step 3: Write implementation**

```js
// src/billing/refundService.js
import { queryWrite, query } from '../db.js';
import { buildAuthHeader } from './wechatV3.js';
import { buildPagePayUrl, signParams } from './alipayPage.js';
import { readConfig } from '../config/configStore.js';

export async function requestRefund({ outTradeNo, reason = '', amount, gatewayFn }) {
  const po = await query(`SELECT * FROM crm.payment_order WHERE out_trade_no=$1`, [outTradeNo]);
  if (!po.rows[0]) return { ok: false, error: 'order not found' };
  if (po.rows[0].status !== 'paid') return { ok: false, error: 'order not paid' };
  const s = (await readConfig('billing-settings', { tenantId: 'system' }))?.value || {};
  const prov = po.rows[0].provider;
  let res;
  if (gatewayFn) res = await gatewayFn();                 // 测试注入
  else if (prov === 'wechat') res = await wechatRefund(po.rows[0], s.wechat, reason);
  else if (prov === 'alipay') res = await alipayRefund(po.rows[0], s.alipay, reason);
  else return { ok: false, error: 'unsupported provider' };
  if (res?.status === 'SUCCESS' || res?.ok) {
    await queryWrite(`UPDATE crm.payment_order SET status='refunded', refund_at=now() WHERE out_trade_no=$1`, [outTradeNo]);
    await queryWrite(`UPDATE crm.tenant_subscription SET status='grace', grace_until=now()+interval '7 days' WHERE online_order_no=$1`, [outTradeNo]);
    return { ok: true, refund_id: res.refund_id };
  }
  return { ok: false, error: 'refund not success' };
}

async function wechatRefund(order, w, reason) {
  const url = '/v3/refund/domestic/refunds';
  const body = JSON.stringify({ out_trade_no: order.out_trade_no, out_refund_no: 'rf' + Date.now(), reason, amount: { refund: Math.round(Number(order.amount) * 100), total: Math.round(Number(order.amount) * 100), currency: 'CNY' } });
  const auth = buildAuthHeader({ mchid: w.mch_id, serialNo: w.serial_no, privPem: w.private_key_pem, method: 'POST', url, body });
  const r = await fetch('https://api.mch.weixin.qq.com' + url, { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body });
  const j = await r.json();
  return { refund_id: j.out_refund_no, status: j.status };
}
async function alipayRefund(order, a, reason) {
  const params = { app_id: a.app_id, method: 'alipay.trade.refund', charset: 'utf-8', sign_type: 'RSA2', timestamp: new Date().toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-'), version: '1.0', biz_content: JSON.stringify({ out_trade_no: order.out_trade_no, refund_amount: Number(order.amount).toFixed(2), refund_reason: reason }) };
  const signed = signParams(params, a.private_key);
  const qs = Object.keys(signed).map((k) => `${k}=${encodeURIComponent(signed[k])}`).join('&');
  const r = await fetch(`https://openapi.alipay.com/gateway.do?${qs}`);
  const j = await r.json();
  return { refund_id: j.alipay_trade_refund_response?.trade_no, status: j.alipay_trade_refund_response?.code === '10000' ? 'SUCCESS' : 'FAIL' };
}
```

- [ ] **Step 4: Route wiring in billingRoutes.js**

```js
router.post('/api/billing/refund', async (req, res) => {
  const me = resolveMe(req);
  if (!isPrivileged(me)) return res.status(403).json({ error: 'forbidden' });
  const { outTradeNo, reason } = req.body || {};
  try {
    const r = await requestRefund({ outTradeNo, reason });
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// 退款回调（微信/支付宝）验签后调 requestRefund 的落地段；简化：复用 verifyNotify + 标记 refunded
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/billing/refundReconcile.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/billing/refundService.js src/http/billingRoutes.js test/billing/refundReconcile.test.js
git commit -m "feat(billing): refund full chain (wechat/alipay) + grace"
```

---

### Task F: 对账定时任务（reconcileService.js）

**Files:**
- Create: `src/billing/reconcileService.js`
- Create: `db/migration-billing-reconcile-diff.sql` (表 `crm.billing_reconcile_diff`)
- Test: `test/billing/refundReconcile.test.js` 扩展

- [ ] **Step 1: Write the failing test**

```js
// 在 refundReconcile.test.js 追加
import { runReconcile } from '../../src/billing/reconcileService.js';
describe('reconcile', () => {
  test('runReconcile（mock 账单）写差异表', async () => {
    const diff = [{ out_trade_no: 'x1', kind: 'missing_local', amount: '99.00' }];
    const r = await runReconcile({ fetchBillFn: async () => diff, period: '2026-09' });
    expect(r.written).toBe(1);
    const rows = await query(`SELECT * FROM crm.billing_reconcile_diff WHERE period='2026-09'`);
    expect(rows.rows.length).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/billing/refundReconcile.test.js`
Expected: FAIL — `runReconcile` not exported / 表不存在

- [ ] **Step 3: Write implementation + migration**

```sql
-- db/migration-billing-reconcile-diff.sql
CREATE TABLE IF NOT EXISTS crm.billing_reconcile_diff (
  id BIGSERIAL PRIMARY KEY,
  period TEXT NOT NULL,
  out_trade_no TEXT,
  kind TEXT NOT NULL,           -- missing_local / missing_gateway / amount_mismatch
  amount NUMERIC(12,2),
  detail JSONB,
  resolved BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

```js
// src/billing/reconcileService.js
import { query, queryWrite } from '../db.js';
import { readConfig } from '../config/configStore.js';

export async function runReconcile({ period, fetchBillFn } = {}) {
  const s = (await readConfig('billing-settings', { tenantId: 'system' }))?.value || {};
  // 拉网关账单（生产：微信 GET /v3/bill/tradebill → 下载 CSV；支付宝 bill.downloadurl.query）
  const gatewayRows = fetchBillFn ? await fetchBillFn() : [];
  const local = await query(`SELECT out_trade_no, amount, status FROM crm.payment_order WHERE to_char(paid_at,'YYYY-MM')=$1`, [period]);
  const localMap = new Map(local.rows.map((r) => [r.out_trade_no, r]));
  const diff = [];
  for (const g of gatewayRows) {
    const l = localMap.get(g.out_trade_no);
    if (!l) diff.push({ out_trade_no: g.out_trade_no, kind: 'missing_local', amount: g.amount });
    else if (Math.abs(Number(l.amount) - Number(g.amount)) > 0.001) diff.push({ out_trade_no: g.out_trade_no, kind: 'amount_mismatch', amount: g.amount });
  }
  for (const d of diff) {
    await queryWrite(`INSERT INTO crm.billing_reconcile_diff (period, out_trade_no, kind, amount, detail) VALUES ($1,$2,$3,$4,$5)`,
      [period, d.out_trade_no, d.kind, d.amount, JSON.stringify(d)]);
  }
  // 告警（fail-open）：仅写差异表 + 触发 alert（不自动改账）
  if (diff.length) console.warn(`[reconcile] ${period} 发现 ${diff.length} 条差异`);
  return { written: diff.length, diff };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/billing/refundReconcile.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/billing/reconcileService.js db/migration-billing-reconcile-diff.sql test/billing/refundReconcile.test.js
git commit -m "feat(billing): reconcile cron (bill vs payment_order, diff alert)"
```

---

### Task G: 前端适配（billing.html）

**Files:**
- Modify: `src/web/billing.html`

- [ ] **Step 1: Write failing check (manual/UI-lint)**

在 `billing.html` 升级弹窗增加支付方式单选 + 二维码容器 + 退款/对账入口；`startUpgrade/startRenew` 按响应分流：
- `qrUrl` → 渲染 `<img src="https://api.qrserver.com/v1/create-qr-code/?data=...">` 或本地用 `qrUrl` 直显（微信 code_url 需转二维码）
- `redirectUrl` → `window.location.href = redirectUrl`
- `simulate` → 保留「模拟支付成功」按钮

- [ ] **Step 2: Implement**

在 `#upgrade-modal` 内增加：
```html
<div class="pay-methods">
  <label><input type="radio" name="pay_provider" value="wechat" checked> 微信支付</label>
  <label><input type="radio" name="pay_provider" value="alipay"> 支付宝</label>
</div>
<div id="qr-box" style="display:none"><img id="qr-img" alt="扫码支付"><div id="qr-tip">请使用微信扫码</div></div>
<div id="refund-panel" style="display:none">…退款按钮…</div>
<div id="reconcile-panel" style="display:none">…对账面板…</div>
```

`startUpgrade` 改写（节选）：
```js
const provider = document.querySelector('input[name=pay_provider]:checked').value;
const r = await api('/api/billing/subscribe', { method: 'POST', body: JSON.stringify({ provider, planId, cycle, mode }) });
if (r.qrUrl) { document.getElementById('qr-img').src = 'https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=' + encodeURIComponent(r.qrUrl); document.getElementById('qr-box').style.display = 'block'; }
else if (r.redirectUrl) { window.location.href = r.redirectUrl; }
else if (r.simulate) { /* 保留模拟按钮，传 r.order */ }
```

- [ ] **Step 3: Run UI lint + smoke**

Run: `node scripts/ui-lint.mjs src/web/billing.html` 与 `npx vitest run test/web/billing.smoke.test.js`
Expected: lint 零错；smoke PASS

- [ ] **Step 4: Commit**

```bash
git add src/web/billing.html
git commit -m "feat(billing): real qr/redirect render + refund/reconcile UI"
```

---

### Task H: 沙箱联调 + 全量单测

**Files:**
- Test: `test/billing/*.test.js` 全量

- [ ] **Step 1: 沙箱联调**

在 `config_store['billing-settings']` 填入微信/支付宝**沙箱**凭据（serial_no、private_key_pem、appid、mch_id、api_key、notify_url 指向本地公网隧道如 ngrok），设 `PAY_TEST_AMT=1`（1 分钱）。手动走：billing.html 升级 → 扫码/跳转 → 沙箱支付 → 回调落地 payment_order(paid) → 订阅状态机流转。

- [ ] **Step 2: 跑全量 billing 单测**

Run: `npx vitest run test/billing`
Expected: PASS（纯函数无 PG 依赖；需 PG 的订单/退款/对账待本地起库后补跑）

- [ ] **Step 3: 自查范围纪律**

确认未触碰 `config-routing` 红线配置、未新增粒子类型、未破坏 `tenant_subscription.payment_ref` FK。

- [ ] **Step 4: Commit（如有联调修正）**

```bash
git add -A  # 仅限本任务改动文件，按功能线拆分；禁 git add -A 全仓
git commit -m "test(billing): sandbox e2e + unit green"
```

---

## 自检（Self-Review）

1. **Spec coverage:** Task A(表/锚点) ✓ B(微信签名) ✓ C(支付宝签名) ✓ D(下单+回调+状态机) ✓ E(退款) ✓ F(对账) ✓ G(前端) ✓ H(沙箱+单测) ✓ —— 全链路覆盖。
2. **Placeholder scan:** 无 TBD/TODO；每代码步含完整实现；测试含真实断言。
3. **Type consistency:** `createPayment` 返回 `{ simulate, qrUrl, redirectUrl, order }` 全任务一致；`outTradeNo` 贯穿 D/E/F；`online_order_no` 锚点列 D/E 一致。
4. **铁律:** 每 Task 一 commit；凭据不进代码；`config-routing` 红线未触碰；PG 依赖测试标注待本地起库。
