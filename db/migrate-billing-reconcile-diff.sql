-- db/migrate-billing-reconcile-diff.sql
-- 支付对账差异表（2026-09-05）；单一事实源见 db/schema.sql
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
