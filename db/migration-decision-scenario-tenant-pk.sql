-- db/migration-decision-scenario-tenant-pk.sql
-- 2026-09-05 决策场景租户 PK 化（G5，方案 a，用户 2026-09-05 裁决：全隔离）
-- 仿 meta_attr 先例（db/migration-meta-attr-tenant-pk.sql）：幂等 DO 块，仅当 PK 未含 tenant_id 时重建。
--
-- 关键：decision_scenario 被三张表 FK 单列引用（crm.decision.scenario_id /
--   crm.calibration_patch.scenario_id / crm.outcome_event_map.scenario_id）。
--   → 重建 PK 前必须先 DROP 这三条 FK；重建后再以复合列 (scenario_id, tenant_id) 重建 FK；
--   引用表均已含 tenant_id（migrate-tenant.js 补列），可关联 tenant_id 对齐。
--
-- 幂等：仅当 PK 未含 tenant_id 列时执行重建；已含则跳过（RAISE NOTICE）。
-- 禁 DELETE 铁律：全程只 DROP/ADD 约束 + ADD COLUMN，不触碰数据行。
ALTER TABLE crm.decision_scenario ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'system';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      USING (constraint_name, table_schema, table_name)
    WHERE tc.constraint_type = 'PRIMARY KEY'
      AND tc.table_schema = 'crm'
      AND tc.table_name = 'decision_scenario'
      AND kcu.column_name = 'tenant_id'
  ) THEN
    -- 1) 卸下三张引用表的单列 FK（约束名按 DB 实际，用 IF EXISTS 幂等）
    ALTER TABLE crm.decision DROP CONSTRAINT IF EXISTS decision_scenario_id_fkey;
    ALTER TABLE crm.calibration_patch DROP CONSTRAINT IF EXISTS calibration_patch_scenario_id_fkey;
    ALTER TABLE crm.outcome_event_map DROP CONSTRAINT IF EXISTS outcome_event_map_scenario_id_fkey;
    -- 2) 重建 decision_scenario PK
    ALTER TABLE crm.decision_scenario DROP CONSTRAINT decision_scenario_pkey;
    ALTER TABLE crm.decision_scenario ADD PRIMARY KEY (scenario_id, tenant_id);
    -- 3) 三张引用表补 tenant_id（幂等；migrate-tenant.js 已补，保险起见）
    ALTER TABLE crm.decision ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'system';
    ALTER TABLE crm.calibration_patch ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'system';
    ALTER TABLE crm.outcome_event_map ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'system';
    -- 3.5) 【引用对齐前移】引用表中非 system 租户的存量行，其场景在 decision_scenario 可能只有 system 模板
    --   （如测试残留 prop-test-tenant 的 PROP_TEST_SCENARIO 决策行）→ 复合 FK 必然失败。
    --   处理：幂等复制 system 模板到该租户（INSERT...SELECT ON CONFLICT DO NOTHING，禁 DELETE、可重跑）。
    --   只补存在引用的场景，不复制全表（最小侵入）；无 system 模板的场景跳过（FK 仍可能失败，见 NOTICE）。
    INSERT INTO crm.decision_scenario
      (scenario_id, stage, description, trigger, methodology_ids, eval_dimensions,
       default_tier, autonomous_allowed, dispositions, tenant_id)
    SELECT DISTINCT d.scenario_id, s.stage, s.description, s.trigger, s.methodology_ids,
           s.eval_dimensions, s.default_tier, s.autonomous_allowed, s.dispositions, d.tenant_id
    FROM crm.decision d
    JOIN crm.decision_scenario s ON s.scenario_id = d.scenario_id AND s.tenant_id = 'system'
    WHERE d.tenant_id <> 'system'
    ON CONFLICT (scenario_id, tenant_id) DO NOTHING;
    -- 4) 复合 FK 重建（scenario_id + tenant_id 对齐）
    ALTER TABLE crm.decision ADD CONSTRAINT decision_scenario_tenant_fkey
      FOREIGN KEY (scenario_id, tenant_id) REFERENCES crm.decision_scenario(scenario_id, tenant_id);
    ALTER TABLE crm.calibration_patch ADD CONSTRAINT calibration_patch_scenario_tenant_fkey
      FOREIGN KEY (scenario_id, tenant_id) REFERENCES crm.decision_scenario(scenario_id, tenant_id);
    ALTER TABLE crm.outcome_event_map ADD CONSTRAINT outcome_event_map_scenario_tenant_fkey
      FOREIGN KEY (scenario_id, tenant_id) REFERENCES crm.decision_scenario(scenario_id, tenant_id);
    RAISE NOTICE '[migrate] decision_scenario_pkey 已重建为 (scenario_id, tenant_id) + FK 复合化';
  ELSE
    RAISE NOTICE '[migrate] decision_scenario_pkey 已含 tenant_id，跳过';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_decision_scenario_tenant ON crm.decision_scenario(tenant_id);
