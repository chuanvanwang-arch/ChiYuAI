-- db/migration-particle-meta.sql — P5 去重：particles 增加 meta 列（与 edges.meta 对齐，存 merged_into 等治理标记）
-- 幂等：仅当列不存在时添加（不改既有列、不锁表长时间）
ALTER TABLE crm.particles ADD COLUMN IF NOT EXISTS meta JSONB NOT NULL DEFAULT '{}'::jsonb;
