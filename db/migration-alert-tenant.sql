-- db/migration-alert-tenant.sql
-- 2026-09-05 修复 alert_rule 跨租户隔离缺口（configCenter id21 声明 tenant 隔离，原实现未隔离）
--
-- 根因：schema.sql 原 PK 仅 (kind)；2026-09-04 加的 alert_rule 表无 tenant_id 列——租户级声明落空。
--   不同租户配置预警规则写同 kind 时，UPDATE 无 tenant 限定会互相覆盖；GET 也无过滤。
--
-- 修复：补 tenant_id 列 + PK 复合化 (kind, tenant_id)。旧 1 列 PK 下每个 kind 至多 1 行，
--   故 (kind, tenant_id) 必然唯一 → DROP+ADD 不会因重复行失败（无需 DELETE）。
--
-- 幂等：仅当 PK 尚未含 tenant_id 时重建（仿 db/migration-meta-attr-tenant-pk.sql 先例）。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'crm' AND table_name = 'alert_rule' AND column_name = 'tenant_id'
  ) THEN
    ALTER TABLE crm.alert_rule ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'system';
    RAISE NOTICE '[migrate] alert_rule 已补 tenant_id（default system）';
  ELSE
    RAISE NOTICE '[migrate] alert_rule 已有 tenant_id，跳过补列';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      USING (constraint_name, table_schema, table_name)
    WHERE tc.constraint_type = 'PRIMARY KEY'
      AND tc.table_schema = 'crm'
      AND tc.table_name = 'alert_rule'
      AND kcu.column_name = 'tenant_id'
  ) THEN
    ALTER TABLE crm.alert_rule DROP CONSTRAINT alert_rule_pkey;
    ALTER TABLE crm.alert_rule ADD PRIMARY KEY (kind, tenant_id);
    RAISE NOTICE '[migrate] alert_rule_pkey 已重建为 (kind, tenant_id)';
  ELSE
    RAISE NOTICE '[migrate] alert_rule_pkey 已含 tenant_id，跳过';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_alert_rule_tenant ON crm.alert_rule(tenant_id);
