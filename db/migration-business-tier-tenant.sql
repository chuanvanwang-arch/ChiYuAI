-- db/migration-business-tier-tenant.sql
-- 2026-09-06 Phase 1 #1：business_tier_config 按租户隔离（configCenter id18 标 tenant 级，原实现未隔离）
-- 仿 db/migration-alert-tenant.sql 先例：补 tenant_id 列 + PK 复合化 (tenant_id, dimension, dimension_value)。
--   business_tier_config 无 FK 引用（纯配置叶表），故无需卸/建外键，改造比 decision_scenario 更简单。
-- 幂等：仅当列/PK 未含 tenant_id 时执行；旧 1 列 PK 下每个 (dimension, dimension_value) 至多 1 行，
--   加 tenant_id='system' 后复合 (tenant_id, dimension, dimension_value) 必然唯一 → 不会因重复行失败。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='crm' AND table_name='business_tier_config' AND column_name='tenant_id'
  ) THEN
    ALTER TABLE crm.business_tier_config ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'system';
    RAISE NOTICE '[migrate] business_tier_config 已补 tenant_id（default system）';
  ELSE
    RAISE NOTICE '[migrate] business_tier_config 已有 tenant_id，跳过补列';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu USING (constraint_name, table_schema, table_name)
    WHERE tc.constraint_type='PRIMARY KEY' AND tc.table_schema='crm'
      AND tc.table_name='business_tier_config' AND kcu.column_name='tenant_id'
  ) THEN
    ALTER TABLE crm.business_tier_config DROP CONSTRAINT business_tier_config_pkey;
    ALTER TABLE crm.business_tier_config ADD PRIMARY KEY (tenant_id, dimension, dimension_value);
    RAISE NOTICE '[migrate] business_tier_config_pkey 已重建为 (tenant_id, dimension, dimension_value)';
  ELSE
    RAISE NOTICE '[migrate] business_tier_config_pkey 已含 tenant_id，跳过';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_business_tier_tenant ON crm.business_tier_config(tenant_id);
