-- db/migrate/2026-09-04-tenant-created-by.sql
-- 租户责任 sysadmin 归属（设计 docs/2026-09-04-sysadmin-role-tenant-attribution-design.md D2）
-- 幂等：ADD COLUMN IF NOT EXISTS；存量租户 created_by_* 留 NULL（无责任归属，列表显示「—」）。
ALTER TABLE crm.tenants
  ADD COLUMN IF NOT EXISTS created_by_user_id uuid
    REFERENCES crm.crm_users(user_id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS created_by_username text;

CREATE INDEX IF NOT EXISTS ix_tenants_created_by ON crm.tenants (created_by_user_id);
