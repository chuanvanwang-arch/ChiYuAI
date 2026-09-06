-- db/migration-login-email-column.sql — 登录标识支持用户名或邮箱
-- 纪律：仅新增 nullable UNIQUE 列，存量 NULL 可共存；禁 DELETE / 禁改既有 username 逻辑
SET search_path TO crm, public;

ALTER TABLE crm.crm_users
  ADD COLUMN IF NOT EXISTS email TEXT UNIQUE;

CREATE INDEX IF NOT EXISTS idx_crm_users_email
  ON crm.crm_users(email);
