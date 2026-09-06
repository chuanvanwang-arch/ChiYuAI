-- db/migration-billing-tables.sql
-- 计费域表：billing_statement（账单） + billing_payment（平台内缴费记录流，不接真实支付网关）
-- 铁律：tenant 隔离（tenant_id NOT NULL）+ 状态枚举 CHECK + 绝对禁 DELETE（缴费=插记录+状态机流转；逾期=读时幂等翻转）
-- 幂等：CREATE TABLE IF NOT EXISTS + ADD INDEX IF NOT EXISTS
CREATE TABLE IF NOT EXISTS crm.billing_statement (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   TEXT NOT NULL DEFAULT 'system',
  period      TEXT NOT NULL,                                   -- 账期（YYYY-MM）
  cycle       TEXT NOT NULL DEFAULT 'monthly' CHECK (cycle IN ('monthly','quarterly')),
  token_in    INT NOT NULL DEFAULT 0,
  token_out   INT NOT NULL DEFAULT 0,
  token_fee   NUMERIC(12,2) NOT NULL DEFAULT 0,
  seat_count  INT NOT NULL DEFAULT 0,
  seat_fee    NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_fee   NUMERIC(12,2) NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','issued','paid','overdue')),
  issued_at   TIMESTAMPTZ,
  due_at      TIMESTAMPTZ,
  paid_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, period, cycle)
);

CREATE TABLE IF NOT EXISTS crm.billing_payment (
  id           BIGSERIAL PRIMARY KEY,
  tenant_id    TEXT NOT NULL,
  statement_id BIGINT NOT NULL REFERENCES crm.billing_statement(id),
  amount       NUMERIC(12,2) NOT NULL,
  method       TEXT NOT NULL CHECK (method IN ('bank_transfer','wechat','alipay','other')),
  status       TEXT NOT NULL DEFAULT 'paid' CHECK (status IN ('pending','paid','failed')),
  paid_at      TIMESTAMPTZ,
  txn_ref      TEXT,
  note         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- tenants.plan 列已存在于 2026-09-03-crm-tenants.sql（保留位）；此处仅补索引（幂等）
CREATE INDEX IF NOT EXISTS idx_crm_billing_statement_tenant_period
  ON crm.billing_statement(tenant_id, period, cycle);
CREATE INDEX IF NOT EXISTS idx_crm_billing_payment_statement
  ON crm.billing_payment(statement_id);
