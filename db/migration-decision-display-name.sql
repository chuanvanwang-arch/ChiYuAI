-- 【C 方案 2026-09-03】决策可读名称列（根治「名称」列空白）
-- 设计背景：销售决策「名称」列此前仅读 trigger_context.name，
--   而 QUOTE_PRICING / LOSS_REVIEW 等场景创建决策时未填 .name → 列表恒显示「—」。
--   根治：crm.decision 增加独立 display_name 列，由 deriveDisplayName（src/decision/decisionRepo.js）统一生成。
-- 幂等：可重复执行（ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS）。
-- 回填：详见 scripts/backfill-decision-display-name.mjs（对 display_name IS NULL 的历史行按同规则补齐）。

ALTER TABLE crm.decision
  ADD COLUMN IF NOT EXISTS display_name TEXT;

CREATE INDEX IF NOT EXISTS idx_crm_decision_display_name
  ON crm.decision(display_name) WHERE display_name IS NOT NULL;
