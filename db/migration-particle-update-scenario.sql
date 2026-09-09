-- db/migration-particle-update-scenario.sql
-- 2026-09-09：新增决策场景 PARTICLE_UPDATE（MCP 事实变更通道第 0 闸 mint 载体）
-- 背景：data-particle-update 经 mcpExpose 对外开放（方案 A，用户拍板），gateway 需代 mint 决策
--   （src/mcp/gateway.js:138）；而 requireDecision 强校验场景存在（src/decision/autonomyEngine.js:124，
--   未知场景直接 throw）→ 缺此行则 mint 失败、退回 DECISION_NEEDED，MCP 侧事实变更永久不可用。
-- 与 db/seed.sql / db/test-setup.sql 的 PARTICLE_CREATE 同构（tier=NORMAL + autonomous_allowed=TRUE：
--   硬人工闸门已由 gateway 两阶段 confirm_token 承担，自治与否交 autonomyEngine 按配置判定）。
--
-- 幂等：ON CONFLICT (scenario_id, tenant_id) DO NOTHING，可重复执行。
-- 禁 DELETE 铁律：仅 INSERT，不删不改任何既有行。
INSERT INTO crm.decision_scenario
  (scenario_id, stage, description, trigger, methodology_ids, eval_dimensions, default_tier, autonomous_allowed) VALUES
('PARTICLE_UPDATE', 'meta', 'MCP/对话通道粒子事实变更（字段级并入，禁删）',
 '{"action":["data-particle-update"]}'::jsonb,
 ARRAY[]::TEXT[],
 '[{"cond":"data_origin","label":"数据来源与字段合法","weight":0.34},{"cond":"identity_dedup","label":"目标唯一（id 精确定位）","weight":0.33},{"cond":"ownership","label":"归属完整（同租户）","weight":0.33},{"cond":"governance_approval","label":"人工确认","weight":0.15}]'::jsonb,
 'NORMAL', TRUE)
ON CONFLICT (scenario_id, tenant_id) DO NOTHING;
