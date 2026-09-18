-- db/migration-2026-09-18-particles-embedding-1024.sql
-- particles.embedding 384 → 1024 的**幂等**迁移（可重复执行；除「列类型不是 1024」这一条件外不做任何破坏）。
--
-- 背景（2026-09-18 实证）：
--   crm.decision.embedding 的 384→1024 迁移写在 db/migrate.js 内联段（幂等，容器启动自动生效），
--   而 crm.particles.embedding 的同款改造只存在于 migration-2026-09-14-particles-embedding-1024.sql，
--   该文件自述「按项目约定不进 INCREMENTAL_SQL，须由发布迁移步骤显式执行一次」⇒
--     · 任何既有库（本机开发库 / 生产库）只要漏跑这一步，就永久停在 vector(384)；
--     · 而 db/schema.sql 的声明基线已是 vector(1024)（新库 CREATE TABLE 直建生效）
--   ⇒ 两条建库路径长期不一致且**无人报警**（D0 环境基线漂移探针由此长期挂 WARN 1 项）。
--   D1「真向量 0%」的 69 条 hash 伪向量亦源于此：384 列装不下模型原生 1024 维向量，
--   写入路径只能 fail-open 写 NULL 或退化为 hash 签名。
--
-- 关键修正（原文件的缺陷）：
--   ① **非幂等且具破坏性**：原文件无条件 `ALTER ... USING NULL` —— 重复执行即清空全表向量。
--      本文件以「当前列类型」为闸：已是 vector(1024) 则整体跳过（DO 块 IF + RETURN），可安全重复跑。
--   ② **不在迁移清单内**：本文件登记进 db/migrate.js 的 INCREMENTAL_SQL，
--      使新库 / 本机旧库 / 生产库三条路径收敛到同一声明基线（漂移自愈，不再依赖人工记得跑一次）。
--
-- 数据安全：仅在列类型 ≠ vector(1024) 时执行。该情形下列只可能承载 hash 伪向量
--   （hashVector 为 384 桶 SHA-256 签名；模型原生向量 1024 维无法 CAST 进 vector(384)）→
--   按设计丢弃并由 scripts/backfill-knowledge-embeddings.mjs --force-hash 重算真向量；
--   丢弃行数以 NOTICE 留痕（可审计，非静默）。
SET search_path TO crm, public;

DO $$
DECLARE
  cur_type  text;
  discarded bigint := 0;
BEGIN
  SELECT format_type(a.atttypid, a.atttypmod)
    INTO cur_type
    FROM pg_attribute a
    JOIN pg_class c     ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'crm' AND c.relname = 'particles' AND a.attname = 'embedding';

  IF cur_type IS NULL THEN
    RAISE NOTICE '[migrate] crm.particles.embedding 不存在（表未建），跳过 —— 新库由 schema.sql 直建 vector(1024)';
    RETURN;
  END IF;

  IF cur_type = 'vector(1024)' THEN
    RAISE NOTICE '[migrate] crm.particles.embedding 已是 vector(1024)，跳过（幂等）';
    RETURN;
  END IF;

  SELECT count(*) INTO discarded FROM crm.particles WHERE embedding IS NOT NULL;

  -- 改列类型前必须先摘掉绑在该列类型上的索引（hnsw 索引依赖 vector 类型，否则 ALTER 报依赖错误）
  DROP INDEX IF EXISTS crm.idx_crm_particles_embedding;
  ALTER TABLE crm.particles ALTER COLUMN embedding TYPE vector(1024) USING NULL;
  CREATE INDEX IF NOT EXISTS idx_crm_particles_embedding
    ON crm.particles USING hnsw (embedding vector_cosine_ops);

  RAISE NOTICE '[migrate] crm.particles.embedding % -> vector(1024) 就绪；丢弃 % 条 hash 基线向量（待 backfill-knowledge-embeddings.mjs 重算）', cur_type, discarded;
END $$;
