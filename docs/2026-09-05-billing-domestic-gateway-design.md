# 设计文档：计费套餐维护入口可见化 + Stripe 替换为微信/支付宝网关

> 基线：用户两条诉求
> 1. 「各个套餐的 DB 维护 没有看到前端入口！」—— 套餐维护（admin-billing-console.html#plans）入口不可见
> 2. 「请将 stripe 改成微信/支付宝」—— 在线支付网关由 Stripe 改为微信支付/支付宝

- 创建日期：2026-09-05
- 状态：设计已批准（用户「同意」）

---

## §0 决策结论（用户已批准）

| 决策点 | 选择 | 理由 |
|---|---|---|
| 支付网关 | 微信/支付宝为主，Stripe **休眠**（代码保留、默认禁用、可配置启用） | 贴合「改成」语义，去掉境外 Stripe 资质依赖；保留海外租户零改启用能力 |
| 套餐入口 | admin + sysadmin 系统菜单**直链** → `/admin-billing-console.html#plans`，并让 sysadmin 可见配置中心 | sysadmin 是平台运营角色，应可维护套餐；直链避免层层点击 |

---

## §1 套餐维护前端入口（Task A — 小）

### 现状事实
- `src/portal/configCenter.js:19` 已定义 `id:41 平台套餐管理`（深链 `/admin-billing-console.html#plans`，status: ready），后端 `/api/billing/plans` 已就绪。
- `src/web/admin-billing-console.html` 真实存在、路由已注册（`routes.js:292`）、含 `#plans` 套餐管理 tab（新增/编辑/软停用 + 计费设置）。
- **根因**：`src/portal/layoutMenu.js:25` `const sys = role === 'admin' ? ADMIN_MENU : [];`
  - sysadmin 看不到任何系统菜单（含「配置中心」）→ 完全无入口；
  - admin 虽可见「配置中心」，但套餐维护埋在二级卡片，可发现性差。

### 改动
- `src/portal/layoutMenu.js`
  - `menuFor(role)`：`const sys = (role === 'admin' || role === 'sysadmin') ? ADMIN_MENU : [];`
  - `ADMIN_MENU` 新增直链：`{ group: '系统', label: '平台套餐管理', href: '/admin-billing-console.html#plans' }`
- 测试 `test/portal/layoutMenu.test.js`（新建或补）：
  - `menuFor('sysadmin')` 返回数组含 `href==='/admin-billing-console.html#plans'` 的项，且含「配置中心」；
  - `menuFor('ten_admin')` 不含该系统菜单（租户级不越权）。

### 成功契约
```
task: "套餐维护前端入口（sysadmin 可见 + 直链）"
success: "menuFor('sysadmin') 返回数组含 href='/admin-billing-console.html#plans' 的项且含『配置中心』；menuFor('ten_admin') 不含该系统菜单"
```

---

## §2 微信/支付宝网关替换 Stripe（Task B — 大）

### 现状事实
- `src/http/billingRoutes.js:200` `POST /api/billing/subscribe` → `import('../billing/stripeGateway.js').buildCheckoutSession(...)` → 返回 `{ url }`（Stripe Checkout）。
- `billingRoutes.js:215` `POST /api/billing/stripe/webhook` → `verifyWebhook` + `handleCheckoutCompleted`。
- `src/web/billing.html:538-554` `startUpgrade`/`startRenew`：调 `/api/billing/subscribe`，`if (r.url) window.location.href = r.url;`
- `src/billing/subscriptionService.js` 状态机 `createSubscription/renewSubscription/upgradeSubscription` 已就绪，可复用。
- `src/billing/billingService.js:161 updateBillingSettings` 持久化 `config_store['billing-settings']`。

### §2.1 新增 `src/billing/domesticGateway.js`

导出（契约，供 B2/B3 调用）：
- `createPayment({ provider, planId, cycle, tenantId, mode })`：
  - `wechat` → 调微信 Native 下单（需凭据），返回 `{ qrUrl: code_url }`；无凭据返回 `{ simulate: true, order: { tenantId, planId, mode, provider } }`。
  - `alipay` → 调支付宝 page 支付（需凭据），返回 `{ redirectUrl }`；无凭据返回 `{ simulate:true, ... }`。
  - 其他/缺省 → 默认 `wechat`。
- `verifyNotify(provider, payload, headers, secret)`：
  - `wechat`：HMAC-SHA256（key=api_key）验签；
  - `alipay`：RSA2（alipay_public_key）验签；
  - 失败返回 `false`。
- `applyPaymentResult({ tenantId, planId, mode })`：复用 `subscriptionService` 状态机（renew/upgrade/create）。

### §2.2 `src/http/billingRoutes.js` 改造
- `POST /api/billing/subscribe`：
  - 新增入参 `provider`（默认读 `billing-settings.default_provider`，缺省 `wechat`）。
  - `provider==='stripe' && settings.stripe?.enabled` → 走原 Stripe（休眠默认不进）；
  - 否则 → `import('../billing/domesticGateway.js').createPayment(...)` → 返回 `{ ok, provider, qrUrl? , redirectUrl? , simulate? , order? }`（**不再返 `url`**）。
  - `provider==='stripe' && !enabled` → `403 { error:'stripe disabled' }`。
- `POST /api/billing/wechat/notify`：读 rawBody + headers → `verifyNotify('wechat',...)` → 成功 `applyPaymentResult`。
- `POST /api/billing/alipay/notify`：同上 `verifyNotify('alipay',...)`。
- `POST /api/billing/subscribe/simulate-confirm`：开发期模拟支付落地 → `applyPaymentResult`（仅 simulate 模式生效，需传 `order` 回带参数）。
- 保留 `POST /api/billing/stripe/webhook`（仅 stripe.enabled 时业务有效，休眠）。

### §2.3 配置 `config_store['billing-settings']`（代码兜底默认值，无需迁移）
```
{
  enabled_providers: ['wechat','alipay'],
  default_provider: 'wechat',
  wechat:  { appid, mch_id, api_key, notify_url },
  alipay:  { app_id, private_key, alipay_public_key, notify_url },
  stripe:  { enabled:false, secret_key, webhook_secret }
}
```
- `domesticGateway.js` 内 `loadSettings()` 经 `readConfig('billing-settings')` 读取；无配置或空 → 用上述默认值（仅 `enabled_providers`/`default_provider` 生效，凭据空 → 走 simulate）。

### §2.4 `src/web/billing.html` 改造
- 升级/续费弹窗（#upgrade-modal）增加「支付方式」单选：微信支付 / 支付宝。
- `startUpgrade()` / `startRenew()`：请求体加 `provider`；按响应分流：
  - `qrUrl` → 弹二维码弹窗（渲染 `<img>` 或 `<canvas>` 由 qrUrl 生成，简单起见用 `<img src=...>` 或文本 code_url + 提示扫码）；
  - `redirectUrl` → `window.location.href = redirectUrl`；
  - `simulate` → 显示「模拟支付成功」按钮 → 调 `POST /api/billing/subscribe/simulate-confirm`。
- 现有 `pay-modal`（线下手动缴费含微信/支付宝标签）保持不变（那是 `/api/billing/pay` 平台内缴费，与在线网关无关）。

### 成功契约
```
task: "微信/支付宝网关替换 Stripe（默认通道）"
success:
  - POST /api/billing/subscribe 带 provider='wechat' 返回 qrUrl（或无凭据时 simulate:true）
  - POST /api/billing/wechat/notify 与 /alipay/notify 验签通过即 applyPaymentResult
  - billing-settings.stripe.enabled=false 时 provider='stripe' 返回 403
  - billing.html 升级弹窗出现支付方式选择且能渲染二维码/跳转/模拟确认
```

---

## §3 风险与说明
- **真实商户凭据未配置时走 simulate 模式**（与现有 `sk_test` 思路一致）：代码含真实签名/验签逻辑，填入凭据即生产可用；不阻塞当前沙箱验证。
- **Stripe 不删除**：仅默认禁用，符合「休眠」选择。
- **PG 沙箱仍不可用**：网关纯函数（签名/验签/simulate）可写单测在本地跑；需 PG 的订阅落地测试待用户本地起库后执行。
- **文件隔离**：本任务仅改 `layoutMenu.js` / `billingRoutes.js` / `billing.html` / 新建 `domesticGateway.js` / 测试，不触碰他任务文件。
