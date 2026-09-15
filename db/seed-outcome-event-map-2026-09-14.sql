-- db/seed-outcome-event-map-2026-09-14.sql
-- D4 回流闭环：扩展业务事件→决策结果映射（覆盖 payload 确含 decision_id 的事件）
-- outcome_type 受 decision_outcome.outcome_type CHECK 约束（won|lost|paid|stalled|partial|other）
--   所有映射事件均在 src/action/seed-actions.js 实测 emit('decision', <type>, {deal_id, decision_id, ...})
-- 自包含：含既有 contract_sign 规则（WHERE NOT EXISTS 幂等，prod 已存在则跳过）+ 新增 3 条。
-- 应用：node 读取本文件经 queryWrite 执行（psql 在本环境不可用）。
SET search_path TO crm, public;

INSERT INTO crm.outcome_event_map (event_type, outcome_type, scenario_id, matcher, enabled)
SELECT 'decision.contract_sign', 'won', NULL,
       '{"deal_id_field":"deal_id"}'::jsonb, true
WHERE NOT EXISTS (SELECT 1 FROM crm.outcome_event_map WHERE event_type='decision.contract_sign');

INSERT INTO crm.outcome_event_map (event_type, outcome_type, scenario_id, matcher, enabled)
SELECT 'decision.deal-advance', 'partial', NULL,
       '{"decision_id_field":"decision_id","deal_id_field":"deal_id"}'::jsonb, true
WHERE NOT EXISTS (SELECT 1 FROM crm.outcome_event_map WHERE event_type='decision.deal-advance');

INSERT INTO crm.outcome_event_map (event_type, outcome_type, scenario_id, matcher, enabled)
SELECT 'decision.quote-create', 'other', NULL,
       '{"decision_id_field":"decision_id"}'::jsonb, true
WHERE NOT EXISTS (SELECT 1 FROM crm.outcome_event_map WHERE event_type='decision.quote-create');

INSERT INTO crm.outcome_event_map (event_type, outcome_type, scenario_id, matcher, enabled)
SELECT 'decision.deal-archive', 'lost', NULL,
       '{"decision_id_field":"decision_id"}'::jsonb, true
WHERE NOT EXISTS (SELECT 1 FROM crm.outcome_event_map WHERE event_type='decision.deal-archive');
