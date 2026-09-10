-- db/migration-requirement-collect-scenario.sql
-- 2026-09-09：新增决策场景 REQUIREMENT_COLLECT（followup-agent 采集 SHOULD/NICE 需求维度证据第 0 闸 mint 载体）
-- 背景：collectFollowupRequirement 写 CRM_METHODOLOGY_EVIDENCE，经 autoDecision mint 决策
--   （src/action/seed-actions.js crm-followup-requirement-collect）；而 requireDecision 强校验场景存在
--   （src/decision/autonomyEngine.js:124，未知场景直接 throw）→ 缺此行则 mint 失败、退回 DECISION_NEEDED，
--   跟进采集永久不可用。
-- 与 db/seed.sql / db/test-setup.sql 的 PARTICLE_UPDATE 同构（tier=NORMAL + autonomous_allowed=TRUE：
--   硬人工闸门由 approval 流程承担，自治与否交 autonomyEngine 按配置判定）。
--
-- 幂等：ON CONFLICT (scenario_id, tenant_id) DO NOTHING，可重复执行。
-- 禁 DELETE 铁律：仅 INSERT，不删不改任何既有行。
INSERT INTO crm.decision_scenario
  (scenario_id, stage, description, trigger, methodology_ids, eval_dimensions, default_tier, autonomous_allowed) VALUES
('REQUIREMENT_COLLECT', 'meta', '跟进采集 SHOULD/NICE 需求维度证据（REQUIREMENT 方法论，auto 来源）',
 '{"action":["crm-followup-requirement-collect"]}'::jsonb,
 ARRAY['REQUIREMENT'],
 '[{"cond":"requirement_evidence_ref","label":"证据出处（auto 来源须带 evidence_ref）","weight":0.5},{"cond":"requirement_met","label":"维度满足判据","weight":0.5}]'::jsonb,
 'NORMAL', TRUE)
ON CONFLICT (scenario_id, tenant_id) DO NOTHING;
