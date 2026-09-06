-- db/migrations/2026-09-03-crm-tenants.sql
-- 租户注册表（设计文档 docs/2026-09-03-config-center-tenant-isolation-design.md §3.4）：
--   crm.tenants 表 + 存量租户灌入 + system 种子租户。
-- 幂等：CREATE TABLE IF NOT EXISTS / INSERT ... ON CONFLICT DO NOTHING。
-- 铁律：租户不可物理删除（禁 DELETE）——停用=status='suspended'，彻底下线=status='retired'。

CREATE TABLE IF NOT EXISTS crm.tenants (
  tenant_id    TEXT PRIMARY KEY,                          -- 与 crm_users.tenant_id / particles.tenant_id 同源字符串
  name         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'active'
               CHECK (status IN ('active','suspended','retired')),
  created_by_user_id uuid REFERENCES crm.crm_users(user_id) ON DELETE SET NULL,
  created_by_username text,
  plan         TEXT,                                      -- 可选：订阅档位（保留位）
  note         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  suspended_at TIMESTAMPTZ,                               -- 停用时间戳（status='suspended' 时记录）
  retired_at   TIMESTAMPTZ                                -- 彻底下线时间戳（status='retired' 时记录）
);

CREATE INDEX IF NOT EXISTS ix_tenants_status ON crm.tenants (status);

-- 存量兼容（设计 §3.4.1）：crm_users 既有 tenant_id 去重灌入（含 'system'——平台默认租户必须有）
INSERT INTO crm.tenants (tenant_id, name, status)
SELECT DISTINCT tenant_id, tenant_id, 'active'
FROM crm.crm_users
WHERE tenant_id IS NOT NULL
ON CONFLICT (tenant_id) DO NOTHING;

-- 平台默认租户兜底（即使 crm_users 为空也保证 system 存在，防巡检循环 0 租户）
INSERT INTO crm.tenants (tenant_id, name, status)
VALUES ('system', '平台默认租户', 'active')
ON CONFLICT (tenant_id) DO NOTHING;