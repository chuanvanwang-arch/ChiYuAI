-- db/migrate-billing-payment-order.sql
-- 真实支付订单表 + tenant_subscription 在线支付锚点列（2026-09-05）
-- 单一事实源见 db/schema.sql；本文件为增量迁移，可重复执行（IF NOT EXISTS / IF NOT EXISTS）

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

ALTER TABLE crm.tenant_subscription ADD COLUMN IF NOT EXISTS online_order_no TEXT;
