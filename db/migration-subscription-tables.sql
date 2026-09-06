-- db/migration-subscription-tables.sql
-- 租户订阅史（append-only） + 模块用量（开关 + 按 (tenant_id,module,period) 计量）
-- 铁律：租户隔离 tenant_id NOT NULL + 状态枚举 CHECK + 绝对禁 DELETE（订阅=插记录+状态机流转）
-- 幂等：CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS
CREATE TABLE IF NOT EXISTS crm.tenant_subscription (
  id             BIGSERIAL PRIMARY KEY,
  tenant_id      TEXT NOT NULL,
  plan_id        TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active','pending','expired','canceled','grace')),
  started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL,
  grace_until    TIMESTAMPTZ,
  payment_ref    BIGINT REFERENCES crm.billing_payment(id),
  upgraded_from  TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, plan_id, started_at)
);
CREATE INDEX IF NOT EXISTS idx_tenant_subscription_tenant
  ON crm.tenant_subscription(tenant_id, status, expires_at);

CREATE TABLE IF NOT EXISTS crm.module_usage (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     TEXT NOT NULL DEFAULT 'system',
  module        TEXT NOT NULL,
  enabled       BOOLEAN NOT NULL DEFAULT true,
  calls         INT NOT NULL DEFAULT 0,
  tokens_in     BIGINT NOT NULL DEFAULT 0,
  tokens_out    BIGINT NOT NULL DEFAULT 0,
  period        TEXT NOT NULL DEFAULT 'YYYY-MM',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, module, period)
);
CREATE INDEX IF NOT EXISTS idx_module_usage_tenant ON crm.module_usage(tenant_id, module, period);
