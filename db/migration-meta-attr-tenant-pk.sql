-- db/migration-meta-attr-tenant-pk.sql
-- 2026-09-04 修复 meta_attr 跨租户隔离缺口（configCenter id19 声明 tenant 隔离，原实现未隔离）
--
-- 根因：schema.sql 原 PK 仅 (particle_type, attr_slug)；2026-09-03 的 ALTER 加了 tenant_id 列却未进 PK。
--   不同租户对同类型粒子写新键时，ensureAdaptiveRegistration 各自带 tenantId INSERT，
--   但 WHERE NOT EXISTS(...,tenant_id=$10) 通过后被 (particle_type, attr_slug) 旧 PK 拦截 → 撞 PK。
--
-- 修复：将 tenant_id 纳入 PK。旧 2 列 PK 下每个 (particle_type, attr_slug) 至多 1 行，
--   故 (particle_type, attr_slug, tenant_id) 必然唯一 → DROP+ADD 不会因重复行失败（无需 DELETE）。
--   若将来出现意外重复（不应发生），ADD PRIMARY KEY 会报错并 fail-open（迁移器捕获 42P01/42703 外也需感知，
--   故此处用 DO $$ 块包含，重复时仅本块跳过，不污染其它迁移）。
--
-- 幂等：仅当 PK 尚未含 tenant_id 时重建。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      USING (constraint_name, table_schema, table_name)
    WHERE tc.constraint_type = 'PRIMARY KEY'
      AND tc.table_schema = 'crm'
      AND tc.table_name = 'meta_attr'
      AND kcu.column_name = 'tenant_id'
  ) THEN
    ALTER TABLE crm.meta_attr DROP CONSTRAINT meta_attr_pkey;
    ALTER TABLE crm.meta_attr ADD PRIMARY KEY (particle_type, attr_slug, tenant_id);
    RAISE NOTICE '[migrate] meta_attr_pkey 已重建为 (particle_type, attr_slug, tenant_id)';
  ELSE
    RAISE NOTICE '[migrate] meta_attr_pkey 已含 tenant_id，跳过';
  END IF;
END $$;
