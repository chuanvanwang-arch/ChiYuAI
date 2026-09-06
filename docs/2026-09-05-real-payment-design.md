# 设计文档：真实支付全链路（微信+支付宝原生 HTTP 封装）

> 基线：用户两条诉求 + 已批准草稿
> - 启用真实支付（替换 `domesticGateway.js` 的 simulate 骨架）
> - 范围：含退款 + 对账全链路
> - 策略：先沙箱后生产
> - 实现方式：原生 HTTP 封装（零新增重依赖）
>
> 创建日期：2026-09-05
> 状态：设计已批准（用户「批准」）

---

## §0 决策结论（用户已批准）

| 决策点 | 选择 |
|---|---|
| 接入方式 | 原生 HTTP 封装（微信 v3 / 支付宝开放平台 API，自签 RSA/SHA256） |
| 范围 | 含退款 + 对账全链路 |
| 联调策略 | 先沙箱后生产（沙箱凭据联调通后填生产） |
| 凭据存储 | 仅 `config_store['billing-settings']`（DB），不进代码/不进 git |

---

## §1 现状缺口（代码级 evidence）

- `src/billing/domesticGateway.js:51-58` `wechatNativeOrder` / `alipayPagePay` 仅 `throw new Error('...requires live credentials')` —— 需替换为真实 HTTP 调用。
- 无独立**支付订单表**：`/api/billing/wechat|alipay/notify` 回调直接调 `applyPaymentResult`，无 `out_trade_no` 幂等中枢、无支付/退款状态留痕。
- `src/billing/subscriptionService.js:31-38` `renewSubscription` 的 `payment_ref = COALESCE($4, payment_ref)` 传入 `null` → `payment_ref` 永远不更新；退款/对账无锚点。
- 退款、对账**完全缺失**。
- `tenant_subscription.payment_ref` 是 `BIGINT FK → crm.billing_payment(id)`（线下缴费流），**不可破坏**；在线支付另起锚点列。

---

## §2 总体架构

```
billing.html（扫码/跳转/退款/对账视图）
   ↓ POST /api/billing/subscribe {provider, planId, cycle, mode}
domesticGateway.createPayment ──┬─ 无凭据 → { simulate:true, order }（保持现状，开发期可确认）
                                └─ 有凭据 → 真实下单 → 写 payment_order(pending) → 返回 qrUrl / redirectUrl
   用户支付 → 微信/支付宝异步通知
                                         ↓ POST /api/billing/wechat|alipay/notify
                                  verifyNotify(验签) → payment_order 置 paid → applyPaymentResult(状态机)
   退款：POST /api/billing/refund → 调微信/支付宝退款 API → payment_order(refunded) → 订阅转 grace
   对账：cron 拉对账单 → 与 payment_order 比对 → 差异写 billing_reconcile_diff 告警（不自动改账）
```

---

## §3 任务分解（含生命契约 §A）

### Task A — 支付订单表 + 迁移
```contract-yaml
- task: "新增 crm.payment_order 表（order_id/out_trade_no/tenant_id/plan_id/provider/amount/status/paid_at/refund_at）+ tenant_subscription.online_order_no 锚点列"
  agent: crm-native-backend
  skills: []
  memory: [CRM-ai-native]
  success: "db/schema.sql 含 payment_order 定义与 online_order_no 列；migration 后 payment_order 可 INSERT 且 out_trade_no 唯一"
```

### Task B — 微信 Native 真实下单（原生封装）
```contract-yaml
- task: "实现 wechatNativeOrder：RSA/AES 签名 + v3 Native 下单，返回 code_url；无凭据仍走 simulate"
  agent: crm-native-backend
  skills: []
  memory: [CRM-ai-native]
  success: "填入沙箱凭据后 createPayment({provider:'wechat'}) 返回真实 code_url（非 simulate）"
```

### Task C — 支付宝 page 真实支付（原生封装）
```contract-yaml
- task: "实现 alipayPagePay：RSA2 签名 + page 支付，返回 redirectUrl；无凭据仍走 simulate"
  agent: crm-native-backend
  skills: []
  memory: [CRM-ai-native]
  success: "填入沙箱凭据后 createPayment({provider:'alipay'}) 返回真实 redirectUrl（非 simulate）"
```

### Task D — 回调验签 + 订单落地 + 状态机接通
```contract-yaml
- task: "wechat/notify 与 alipay/notify：验签→payment_order 置 paid→applyPaymentResult；修复 renewSubscription payment_ref 锚点（改写 online_order_no）"
  agent: crm-native-backend
  skills: []
  memory: [CRM-ai-native]
  success: "模拟回调带正确签名 → payment_order.status='paid' 且 tenant_subscription 状态机流转；online_order_no 已落库"
```

### Task E — 退款全链路
```contract-yaml
- task: "实现 POST /api/billing/refund + 退款回调：调微信/支付宝退款 API，payment_order→refunded，订阅转 grace 不立即停服"
  agent: crm-native-backend
  skills: []
  memory: [CRM-ai-native]
  success: "退款接口返回 success；payment_order.status='refunded'；订阅转 grace 不立即落 free"
```

### Task F — 对账定时任务
```contract-yaml
- task: "cron 拉微信/支付宝对账单，与 payment_order 比对，差异写 billing_reconcile_diff 告警（fail-open）"
  agent: crm-native-backend
  skills: []
  memory: [CRM-ai-native]
  success: "对账任务跑通：本地缺/多/金额不符记录写入差异表且发出告警（不自动改账）"
```

### Task G — 前端适配
```contract-yaml
- task: "billing.html：真实二维码渲染、退款入口、对账视图；simulate 分支保留"
  agent: crm-native-frontend
  skills: []
  memory: [CRM-ai-native]
  success: "billing.html 升级弹窗渲染真实二维码；新增退款按钮与对账面板；simulate 模式仍可开发期确认"
```

### Task H — 沙箱联调 + 单测
```contract-yaml
- task: "微信/支付宝沙箱联调签名与回调；纯函数（签名/验签/simulate）单测本地跑通"
  agent: crm-native-backend
  skills: []
  memory: [CRM-ai-native]
  success: "沙箱下单+回调跑通；签名/验签/simulate 分支单测全绿（PG 依赖的订阅落地待本地起库后补）"
```

---

## §4 数据模型（Task A 落地）

```sql
-- 支付订单（在线支付幂等中枢，独立于线下 billing_payment）
CREATE TABLE IF NOT EXISTS crm.payment_order (
  id            BIGSERIAL PRIMARY KEY,
  order_id      TEXT NOT NULL UNIQUE,            -- 平台内部订单号
  out_trade_no  TEXT NOT NULL UNIQUE,            -- 微信/支付宝交易号（幂等锚点）
  tenant_id     TEXT NOT NULL,
  plan_id       TEXT NOT NULL,
  cycle         TEXT NOT NULL DEFAULT 'monthly',
  mode          TEXT NOT NULL DEFAULT 'upgrade', -- create/renew/upgrade
  provider      TEXT NOT NULL,                   -- wechat/alipay
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

-- tenant_subscription 新增在线支付锚点（不动现有 payment_ref FK→billing_payment）
ALTER TABLE crm.tenant_subscription ADD COLUMN IF NOT EXISTS online_order_no TEXT;
```

---

## §5 风险与铁律

- **绝不触碰 `config-routing` 红线配置**（平台核心场景路由）；本任务只动 `domesticGateway.js` / `subscriptionService.js` / `billingRoutes.js` / `billing.html` / 新表，**不新增粒子类型、不改多租户架构纯度**。
- 真实凭据**不进代码、不进 git**；只存 `config_store['billing-settings']`（DB），沙箱/生产凭据切换靠配置。
- 退款/对账 fail-open：异常只告警不阻断主链路。
- PG 沙箱不稳：纯函数（签名/验签/simulate）单测本地跑；需 PG 的订阅落地测试待用户本地起库后执行。
- 文件隔离：本任务仅改上述文件/新建 domesticGateway 内函数体 + 新表迁移 + 测试，不触碰他任务文件。

---

## §A 闭环回写

| 任务 | 观察缺口（实现后由 workbench 回填） | 严重度 |
|---|---|---|
| （待 P10 吸收） | — | — |
