-- db/seed-users.sql — 引导用户种子（admin 登录账号）
-- 幂等：WHERE NOT EXISTS 防重复；crypt 哈希不落明文；与 src/http/auth.js / src/mcp/auth.js 校验同款
-- enabled 与 tenant_id 由 schema.sql 默认值填充（与迁移顺序解耦）
SET search_path TO crm, public;

INSERT INTO crm.crm_users (username, password_hash, role, display_name, org_id, email)
SELECT 'admin', crypt('admin123', gen_salt('bf')), 'admin', '系统管理员', 'system', 'admin@123.com'
WHERE NOT EXISTS (SELECT 1 FROM crm.crm_users WHERE username = 'admin');

INSERT INTO crm.crm_users (username, password_hash, role, display_name, org_id, email)
SELECT 'alice', crypt('secret123', gen_salt('bf')), 'sales', 'Alice 销售', 'system', 'alice@system.local'
WHERE NOT EXISTS (SELECT 1 FROM crm.crm_users WHERE username = 'alice');

-- 已存在种子账号但 email 为空时补默认值（支持用户名/邮箱双登录）
UPDATE crm.crm_users SET email = 'admin@123.com' WHERE username = 'admin' AND email IS NULL;
UPDATE crm.crm_users SET email = 'alice@system.local' WHERE username = 'alice' AND email IS NULL;

INSERT INTO crm.crm_users (username, password_hash, role, display_name, org_id, email)
SELECT 'sysadmin', crypt('sysadmin123', gen_salt('bf')), 'sysadmin', '平台管理员', 'system', 'sysadmin@system.local'
WHERE NOT EXISTS (SELECT 1 FROM crm.crm_users WHERE username = 'sysadmin');

UPDATE crm.crm_users SET email = 'sysadmin@system.local' WHERE username = 'sysadmin' AND email IS NULL;