-- 2026-09-06 F4（方案 C）：sysadmin 写范围收敛（治理类 + 业务写拒）
-- 设计：docs/2026-09-06-rbac-f4-design.md §C1
-- 幂等：仅当 data_scope 无 write_scope 时补（已是 governance 则不动）；禁 DELETE、只 UPDATE。
-- 注意：exclude_types 由 src/context/scope.js 的 BUSINESS_PARTICLE_TYPES 权威导出，
--       此处写实际类型列表以保持 DB 自包含（与代码不一致时以代码为准）。
UPDATE crm.role_context_profile
SET data_scope = jsonb_set(
  data_scope,
  '{write_scope}',
  '{"model":"governance","exclude_types":["CRM_DEAL","CRM_ACCOUNT","CRM_CONTACT","CRM_TECHNICAL_PROPOSAL","CRM_INVOICE","CRM_PAYMENT_RECORD","CRM_CONTRACT","CRM_QUOTATION","CRM_ORDER"]}'
)
WHERE role_tag = 'sysadmin'
  AND data_scope->>'model' = 'all'
  AND NOT (data_scope ? 'write_scope');
