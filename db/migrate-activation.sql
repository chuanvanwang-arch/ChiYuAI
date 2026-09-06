-- 自助注册激活闭环（2026-09-04）：crm_users.activated 列 + crm.activation_code 表
-- 幂等：对「已存在的旧库」补 activated 列（schema.sql 的 CREATE TABLE IF NOT EXISTS 不会给旧表补列）；
--       对「从零建库」本文件语句与 schema.sql 同构、IF NOT EXISTS 使其无副作用。
ALTER TABLE crm.crm_users ADD COLUMN IF NOT EXISTS activated BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS crm.activation_code (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('email', 'phone')),
  target text NOT NULL,
  code_hash text NOT NULL,
  purpose text NOT NULL DEFAULT 'activate',
  consumed_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_activation_code_username ON crm.activation_code(username, purpose, consumed_at, expires_at);
