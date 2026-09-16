-- 主动运行时 S6 · 常驻授权（线 B｜B-N8）增量迁移
-- 与 db/schema.sql 尾部 DDL 同构（幂等叠加，防已存在库缺表/缺列）
-- 注册：db/migrate.js INCREMENTAL_SQL 数组追加本文件名

-- B/C 轴：动作边界 + 授权凭证
CREATE TABLE IF NOT EXISTS crm.standing_grant (
  grant_id        TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL DEFAULT 'system',
  title           TEXT NOT NULL,
  scope_actions   TEXT[] NOT NULL,
  scope_objects   TEXT[] NULL,
  field_whitelist TEXT[] NULL,
  risk_tier       TEXT NOT NULL DEFAULT 'T1',
  max_uses        INT NULL,
  used_count      INT NOT NULL DEFAULT 0,
  period          TEXT NULL,
  limit_payload   JSONB NOT NULL DEFAULT '{}'::jsonb,
  status          TEXT NOT NULL DEFAULT 'active',
  approved_by     TEXT NOT NULL,
  approved_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  decision_id     TEXT NULL,
  expires_at      TIMESTAMPTZ NULL,
  revoked_at      TIMESTAMPTZ NULL,
  revoked_reason  TEXT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_grant_active
  ON crm.standing_grant(tenant_id, status, risk_tier);

CREATE TABLE IF NOT EXISTS crm.grant_execution (
  execution_id TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL DEFAULT 'system',
  grant_id     TEXT NOT NULL,
  signal_id    TEXT NULL,
  action_name  TEXT NOT NULL,
  target_id    TEXT NULL,
  before_state JSONB NOT NULL DEFAULT '{}'::jsonb,
  after_state  JSONB NOT NULL DEFAULT '{}'::jsonb,
  decision_id  TEXT NULL,
  actor        TEXT NOT NULL DEFAULT 'standing-auth',
  hitl_verdict TEXT NULL,
  rejected_at  TIMESTAMPTZ NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_exec_grant ON crm.grant_execution(grant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_exec_verdict
  ON crm.grant_execution(tenant_id, hitl_verdict, created_at DESC);

-- 决策表补列：常驻授权执行凭据
ALTER TABLE crm.decision
  ADD COLUMN IF NOT EXISTS grant_ref        TEXT,
  ADD COLUMN IF NOT EXISTS autonomy_level   TEXT;

-- 常驻授权全局策略（system 模板，租户经 configStore autoSeed 克隆）
INSERT INTO crm.config_store (tenant_id, key, value, decision_id, updated_by, updated_at)
VALUES ('system', 'standing-grants-policy',
  '{"default_tier":"T1","allow_tier_upgrade_by_ai":false,"auto_pause_on_consecutive_rejects":3,"max_daily_executions":null,"notify_on_execution":true}'::jsonb,
  NULL, 'system', now())
ON CONFLICT (tenant_id, key) DO NOTHING;

-- Q3-4（全链集成 §3.4）：给既有 system 模板补 require_export_healthy 字段（缺省 false）。
-- 用 jsonb `||` 合并：**不覆盖**既有键，只补缺失键；已存在该键时幂等无变化。
-- 为什么不用 INSERT ... ON CONFLICT DO UPDATE：既有行的 value 由运营维护，整块覆盖会丢运营改动。
UPDATE crm.config_store
   SET value = value || '{"require_export_healthy": false}'::jsonb
 WHERE tenant_id = 'system' AND key = 'standing-grants-policy'
   AND NOT (value ? 'require_export_healthy');
