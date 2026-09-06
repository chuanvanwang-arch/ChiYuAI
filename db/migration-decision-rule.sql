-- db/migration-decision-rule.sql — G2 规则 DB 化迁移（独立幂等脚本，生产 plm 库对齐）
-- 设计输入：docs/superpowers/plans/2026-08-30-cdai-dev-plan.md Task 2
-- 纪律：与 db/schema.sql 决策质量闭环段同构；幂等（IF NOT EXISTS）；不物理删（规则软停 enabled=false）。
-- 应用方式：psql -d plm -f db/migration-decision-rule.sql（或 npm run migrate 链路自动执行）

-- 规则表（DB 权威护栏清单；match_type 'TYPE.action'，check_payload 承载 op/flow 等判定参数）
CREATE TABLE IF NOT EXISTS crm.decision_rule (
  id BIGSERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  match_type TEXT NOT NULL,
  match_payload JSONB NOT NULL DEFAULT '{}',
  check_payload JSONB NOT NULL DEFAULT '{}',
  enabled BOOLEAN DEFAULT true,
  decision_id UUID REFERENCES crm.decision(decision_id),  -- 规则经第0闸产生（可追溯）
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 留痕表（rule_hit：block/命中 100% 落库，obs 观测）
CREATE TABLE IF NOT EXISTS crm.rule_hit (
  id BIGSERIAL PRIMARY KEY,
  rule_code TEXT NOT NULL,
  decision_id UUID,
  blocked BOOLEAN NOT NULL,
  reasons JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 索引（按 code 查重 + 按决策留痕追溯）
CREATE INDEX IF NOT EXISTS idx_crm_decision_rule_code ON crm.decision_rule(code);
CREATE INDEX IF NOT EXISTS idx_crm_rule_hit_decision ON crm.rule_hit(decision_id, created_at);