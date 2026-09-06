-- db/migrate/2026-09-04-skill-registry-rbac-fix.sql
-- T2 命名收口：crm.skill_registry 已存行 rbac_roles 数组内 sys-admin→sysadmin（UPDATE 非 DELETE）
UPDATE crm.skill_registry
SET rbac_roles = array_replace(rbac_roles, 'sys-admin', 'sysadmin')
WHERE 'sys-admin' = ANY(rbac_roles);
