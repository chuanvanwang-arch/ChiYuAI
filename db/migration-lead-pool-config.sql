-- 线索池三类池模板（2026-09-11 设计 §3）
-- (system,'lead-pool-config') = 平台模板源；租户缺键时由 configStore.readConfig autoSeed 克隆并打 _seeded 标记。
-- 幂等：WHERE NOT EXISTS（**两代主键下均成立** —— 旧库 key 单列 PK / migrate-tenant 升级后 (tenant_id,key) 复合 PK；
--   复合 PK 下 `ON CONFLICT (key)` 会报 no unique constraint，故一律不用 ON CONFLICT）。
-- 禁删铁律：仅 INSERT，不删不改任何既有行（已存在即跳过，不覆盖运营改过的配置）。
-- 执行渠道（T3 派发前复查 D1）：本文件**不是**一次性 psql 手工步骤，而是双通道自动执行——
--   ① 生产/新库：db/migrate.js 在 migrate-tenant 之后按「仅缺失时播种」范式读取本文件（容器启动即跑）；
--   ② 测试库：scripts/seed-test-config.mjs 的 ensureLeadPoolConfig() 于 pretest 读取本文件。
--   ⚠ 本文件为 JSON 单一事实源，与 src/sales/pool.js 的 DEFAULT_POOL_TEMPLATE 结构性一致（由守卫测试锁定）。
INSERT INTO crm.config_store (tenant_id, key, value, updated_by, updated_at)
SELECT 'system', 'lead-pool-config', '{
  "version": 1,
  "default_pool": "pool-new",
  "pools": [
    {"id":"pool-new","type":"new","label":"新线索公海","enabled":true,
     "pick_rule":{"daily_limit":10,"prev_owner_only":false,"pick_interval_hours":24,"new_data_only":true},
     "recycle_rule":{"recycle_days":30,"recycle_target":"self"},
     "return_target":"pool-nurture"},
    {"id":"pool-nurture","type":"nurture","label":"培育公海","enabled":true,
     "pick_rule":{"daily_limit":5,"prev_owner_only":true,"pick_interval_hours":24,"new_data_only":false},
     "recycle_rule":{"recycle_days":90,"recycle_target":"self"},
     "promote_to":"pool-new"},
    {"id":"pool-lost","type":"lost","label":"战败回收公海","enabled":true,
     "pick_rule":{"daily_limit":5,"prev_owner_only":false,"pick_interval_hours":0,"new_data_only":false},
     "recycle_rule":{"recycle_days":180,"recycle_target":"self"},
     "reopenable":true}
  ]
}'::jsonb, 'system', now()
WHERE NOT EXISTS (SELECT 1 FROM crm.config_store WHERE key='lead-pool-config');
