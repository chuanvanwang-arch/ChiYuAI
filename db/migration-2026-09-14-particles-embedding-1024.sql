-- db/migration-2026-09-14-particles-embedding-1024.sql
-- 【已废弃 · 保留以防外部 runbook 仍引用本文件名】particles.embedding 384→1024（既有库 ALTER）。
--
-- ⚠ 原实现为无条件 `ALTER TABLE crm.particles ALTER COLUMN embedding TYPE vector(1024) USING NULL;`
--   —— **非幂等且具破坏性：重复执行即清空全表向量**（含已回填的真模型向量）。
--   2026-09-18 已由同语义的幂等文件取代并登记进迁移清单：
--     db/migration-2026-09-18-particles-embedding-1024.sql（以列类型为闸，重复执行安全）
--
-- 本文件现为**幂等空操作壳**：仅做类型巡检，不再执行任何 DDL。
--   目的：① 旧 runbook / 文档引用本文件名时不会造成数据损失；② `psql -f` 仍可安全执行。
-- 新库 / 旧库 / 生产库的列维度收敛一律由 db/migrate.js 的 INCREMENTAL_SQL 自动完成。
SET search_path TO crm, public;

DO $$
DECLARE
  cur_type text;
BEGIN
  SELECT format_type(a.atttypid, a.atttypmod)
    INTO cur_type
    FROM pg_attribute a
    JOIN pg_class c     ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'crm' AND c.relname = 'particles' AND a.attname = 'embedding';

  IF cur_type IS NULL THEN
    RAISE NOTICE '[migrate] (deprecated) crm.particles.embedding 不存在，跳过';
  ELSIF cur_type = 'vector(1024)' THEN
    RAISE NOTICE '[migrate] (deprecated) crm.particles.embedding 已是 vector(1024)，无需处理';
  ELSE
    RAISE WARNING '[migrate] (deprecated) crm.particles.embedding 仍为 % —— 请改跑幂等迁移 db/migration-2026-09-18-particles-embedding-1024.sql（本文件不再执行 DDL，以免重跑清空向量）', cur_type;
  END IF;
END $$;
