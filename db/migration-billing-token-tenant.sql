-- db/migration-billing-token-tenant.sql
-- 计费域前置缺口修复：token_accounting 补 tenant_id（按租户统计 LLM Token 用量的必需维度）
-- 铁律：新列走独立 ALTER，不进 CREATE TABLE IF NOT EXISTS 块（避免本地库 IF NOT EXISTS 跳过掩盖缺列）
-- 幂等：ADD COLUMN IF NOT EXISTS + 默认值 'system'（既有行归属平台默认租户，零破坏）
ALTER TABLE crm.token_accounting
  ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'system';

CREATE INDEX IF NOT EXISTS idx_crm_token_accounting_tenant
  ON crm.token_accounting(tenant_id, created_at);
