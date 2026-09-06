-- db/migration-conflict.sql — P4 冲突保留模型：多源事实断言并存，绝不静默覆盖
-- 设计输入：docs/superpowers/specs/2026-08-26-age-semantica-program-design.md P4
-- 纪律：与 Semantica 一致——冲突保留分歧（keep disagreement），标记 needs_review 待人工/策略裁决；不物理删除异源。
CREATE TABLE IF NOT EXISTS crm.assertions (
  id BIGSERIAL PRIMARY KEY,
  entity_id TEXT NOT NULL,
  attr TEXT NOT NULL,
  value TEXT NOT NULL,
  source_id TEXT NOT NULL,
  valid BOOLEAN NOT NULL DEFAULT true,
  needs_review BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_assertions_entity_attr
  ON crm.assertions(entity_id, attr);
