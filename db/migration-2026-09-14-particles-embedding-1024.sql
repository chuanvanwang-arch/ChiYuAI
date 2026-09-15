-- db/migration-2026-09-14-particles-embedding-1024.sql
-- 既有库 ALTER：particles.embedding 384→1024（与 decision.embedding 对齐，承载真模型向量）
-- 生产经 crm-prod-release 迁移流程执行（HITL，非自动）；USING NULL 避免 384→1024 维度转换错误。
-- 说明：本文件为「既有库迁移」事实源；db/schema.sql 已同步为 vector(1024)（新库 CREATE TABLE 即生效）。
--   按项目约定 migration-*.sql 不进 INCREMENTAL_SQL 自动双建，须由发布迁移步骤对生产库显式执行一次。
SET search_path TO crm, public;
ALTER TABLE crm.particles ALTER COLUMN embedding TYPE vector(1024) USING NULL;
