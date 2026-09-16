-- 时间型信号默认规则（2026-09-16 S5 T15）
-- (system,'signal-schedule') = 平台模板源；对齐 migration-lead-pool-config.sql 范式。
-- 幂等：WHERE NOT EXISTS（两代主键下均成立）；仅 INSERT，不删不改既有行（已存在即跳过，不覆盖运营配置）。
-- 执行渠道：db/migrate.js 在 migrate-tenant 之后按「仅缺失时播种」读取本文件（容器启动即跑）。
-- 阈值全在 config（零字面量铁律）：scheduleScanner 读本配置逐租户扫描，命中落 crm.signal source='rule-scan'。
INSERT INTO crm.config_store (tenant_id, key, value, updated_by, updated_at)
SELECT 'system', 'signal-schedule', '{
  "version": 1,
  "enabled": true,
  "rules": [
    {"id":"quote-timeout","kind":"quote_approval_timeout","entity_type":"CRM_DEAL",
     "condition":{"field":"quote_status","op":"eq","value":"pending_approval"},
     "threshold_days":3,"severity":"high","target_role":"sales","enabled":true,"bucket":"day"},
    {"id":"stage-silence","kind":"stage_silence","entity_type":"CRM_DEAL",
     "condition":{"field":"last_activity_at","op":"ne","value":null},
     "threshold_days":7,"severity":"medium","target_role":"sales","enabled":true,"bucket":"day"}
  ]
}'::jsonb, 'system', now()
WHERE NOT EXISTS (SELECT 1 FROM crm.config_store WHERE key='signal-schedule');
