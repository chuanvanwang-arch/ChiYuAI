-- 外部数据接入（S2）配置模板三键（2026-09-16 P0-3）
-- (system,'sync-mappings')         = 对象↔粒子声明式映射（src/sync/mapping.js 消费）
-- (system,'sync-trust')            = 信任分级 + 回写白名单（src/sync/trust.js、src/sync/writeback.js 消费）
-- (system,'integration-providers') = provider 描述符（src/sync/mount.js loadTenantSyncTargets 消费）
-- 幂等：WHERE NOT EXISTS（仅缺失时播种，绝不覆盖运营配置）；禁删铁律：仅 INSERT，不删不改。
--
-- ⚠ 三键缺失时的后果（本 P0 的由来）：loadSyncMappings 返 {} → mapping.apply 恒 object_not_mapped
--   → 全部 skipped；loadTenantSyncTargets 返 [] → 定时器「在跑但零目标」；两处 catch 静默 → 零报错零日志。
--
-- ⚠ enabled:false + 占位 endpoint = **模板骨架，不是已接通**。接入客户 CRM 时必须由人工（HITL）
--   在配置中心改 enabled/endpoint/凭据，并把 objects[].name 对齐客户 CRM 的真实对象 API 名。
--   纷享销客需提供 appId/appSecret/permanentCode + corpId + currentOpenUserId（见 src/sync/fxiaoke.js）。
--
-- ⚠ writeback_fields_whitelist 为空 = 拒绝一切回写（fail-closed）。启用回写前必须由人工显式声明
--   可回写字段；writeback_auto_approved 保持 false（回写逐批人工确认，不得自动放行）。
INSERT INTO crm.config_store (tenant_id, key, value, updated_by, updated_at)
SELECT 'system', 'sync-mappings', '{
  "version": 1,
  "mappings": [
    {"object":"account","particle_type":"CRM_ACCOUNT","direction":"in",
     "identity":{"external_id_field":"id"},
     "fields":[{"external":"name","particle":"name"},{"external":"industry","particle":"industry"},
               {"external":"region","particle":"region"},{"external":"size","particle":"size"},
               {"external":"source","particle":"source"},{"external":"rating","particle":"rating"},
               {"external":"domains","particle":"domains"},{"external":"business_title","particle":"business_title"}]},
    {"object":"lead","particle_type":"CRM_DEAL","direction":"in",
     "identity":{"external_id_field":"id"},
     "fields":[{"external":"name","particle":"name"},{"external":"stage","particle":"stage"},
               {"external":"owner","particle":"owner"},{"external":"source","particle":"source"}]},
    {"object":"opportunity","particle_type":"CRM_DEAL","direction":"in",
     "identity":{"external_id_field":"id"},
     "fields":[{"external":"name","particle":"name"},{"external":"stage","particle":"stage"},
               {"external":"amount","particle":"amount"},{"external":"account_id","particle":"account_id"},
               {"external":"close_date","particle":"expected_close_date"}]},
    {"object":"contract","particle_type":"CRM_CONTRACT","direction":"in",
     "identity":{"external_id_field":"id"},
     "fields":[{"external":"contract_no","particle":"contract_no"},{"external":"amount","particle":"amount"},
               {"external":"start_date","particle":"start_date"},{"external":"end_date","particle":"end_date"},
               {"external":"approval_status","particle":"approval_status"}]},
    {"object":"product","particle_type":"CRM_PRODUCT","direction":"in",
     "identity":{"external_id_field":"id"},
     "fields":[{"external":"name","particle":"name"},{"external":"unit","particle":"unit"},
               {"external":"category","particle":"category"},{"external":"list_price","particle":"list_price"}]},
    {"object":"quotation","particle_type":"CRM_QUOTATION","direction":"in",
     "identity":{"external_id_field":"id"},
     "fields":[{"external":"name","particle":"name"},{"external":"amount","particle":"amount"},
               {"external":"valid_until","particle":"valid_until"},{"external":"approval_status","particle":"approval_status"}]}
  ]
}'::jsonb, 'system', now()
WHERE NOT EXISTS (SELECT 1 FROM crm.config_store WHERE key='sync-mappings');

INSERT INTO crm.config_store (tenant_id, key, value, updated_by, updated_at)
SELECT 'system', 'sync-trust', '{
  "version": 1,
  "default_level": "L1",
  "levels": {
    "L1": {"label":"只读观察期","allow_read":true,"allow_upsert":false,"allow_writeback":false},
    "L2": {"label":"批量入库","allow_read":true,"allow_upsert":true,"allow_writeback":false,"decision_granularity":"per_run"},
    "L3": {"label":"启用回写","allow_read":true,"allow_upsert":true,"allow_writeback":true,
           "decision_granularity":"per_run","first_n_batches_require_human":3}
  },
  "writeback_fields_whitelist": [],
  "writeback_auto_approved": false
}'::jsonb, 'system', now()
WHERE NOT EXISTS (SELECT 1 FROM crm.config_store WHERE key='sync-trust');

INSERT INTO crm.config_store (tenant_id, key, value, updated_by, updated_at)
SELECT 'system', 'integration-providers', '[
  {
    "id": "customer-crm",
    "kind": "generic-rest",
    "enabled": false,
    "endpoint": "https://customer-crm.invalid/api/sync",
    "token_mode": "bearer",
    "trust_level": "L1",
    "objects": [
      {"name":"account","direction":"in","id_field":"id","since_field":"updated_at"},
      {"name":"lead","direction":"in","id_field":"id","since_field":"updated_at"},
      {"name":"opportunity","direction":"in","id_field":"id","since_field":"updated_at"},
      {"name":"contract","direction":"in","id_field":"id","since_field":"updated_at"},
      {"name":"product","direction":"in","id_field":"id","since_field":"updated_at"},
      {"name":"quotation","direction":"in","id_field":"id","since_field":"updated_at"},
      {"name":"account","direction":"out"}
    ]
  }
]'::jsonb, 'system', now()
WHERE NOT EXISTS (SELECT 1 FROM crm.config_store WHERE key='integration-providers');
