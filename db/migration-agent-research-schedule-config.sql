-- L3 主动研究默认调度（2026-09-16 S5 T17）
-- (system,'agent-research-schedule') = 平台模板源；对齐 migration-lead-pool-config.sql 范式。
-- 幂等：WHERE NOT EXISTS；仅 INSERT，不删不改既有行（已存在即跳过，不覆盖运营配置）。
-- 执行渠道：db/migrate.js 按「仅缺失时播种」读取本文件（容器启动即跑）。
-- researchScheduler 读本配置：限额 max_objects_per_run + 预算 daily_llm_budget 双重护栏；缺证据降级说明而非编造；零粒子写入。
INSERT INTO crm.config_store (tenant_id, key, value, updated_by, updated_at)
SELECT 'system', 'agent-research-schedule', '{
  "version": 1,
  "enabled": true,
  "max_objects_per_run": 5,
  "daily_llm_budget": 50,
  "select_rule": {"type":"CRM_ACCOUNT"}
}'::jsonb, 'system', now()
WHERE NOT EXISTS (SELECT 1 FROM crm.config_store WHERE key='agent-research-schedule');
