-- db/seed-billing-config.sql
-- 计费域配置化播种：config_store['billing-plans']（5 档）+ ['billing-settings']（账期/宽限/币种）
-- 铁律：配置驱动，禁硬编码；ON CONFLICT(tenant_id,key) 幂等可重复执行（改价/改权益安全重播）
-- 权益键必须对应本平台真实落地能力（非 attio/Lightfield 外部功能名）：
--   core_crm / ai_agents / customer_360 / decision_autonomy / event_automation / approval_flow
--   / llm_config / mcp_access / advanced_reporting / audit_provenance / industry_config / rbac_advanced / memory
-- 计价模型：混合（账号费 base_fee + 席位超量 + Token 超量），与 landing「按账号数线性、含 AI 用量费」一致；
--   quote 字段为对外展示价（landing 口径），前端优先展示 quote，实际账单按混合模型计算。
--   included_seats/included_tokens/seat_unit_price = -1 表示「不限」（本地旗舰版）。
-- token_overage_mode：block=用完即封（免费档）；bill=按量计费至 token_hard_cap 封顶（付费档）。
--   ⚠ 2026-09-06 三源对齐（止血）：此前本文件的 included_tokens 全为 -1、token_overage_mode 全为 'none'，
--     与现网配置（50000/block、200000/bill…）严重漂移——任何一次 `npm run seed` / migrate 重播都会把
--     Token 闸门整体关掉（quotaGate 对 'none' 不拦截）。现以「配置中心现网口径」为唯一真相源同步本文件，
--     并与 test/helpers/seedBillingPlans.js 保持一致，由 test/billing/planSourceConsistency.test.js 常驻校验。
-- features：套餐卡项目数组（landing 卡片 <ul><li> 由其动态重建；planSchema 校验 string[]）。
-- highlight：对外高亮「推荐」档（landing/billing 卡片由该标记驱动，禁前端硬编码）。
-- original_price / tag_text：卡片结构化展示字段（向后兼容；缺省不显示），用于原账号价划线 + 角标（2026-09-06）。

INSERT INTO crm.config_store (tenant_id, key, value, updated_by, updated_at) VALUES
('system','billing-settings',
 '{"cycle":"monthly","default_plan":"free","currency":"CNY","grace_days":15,"billing_intro":{"headline":"套餐","subtitle":"档位与价格均由后台配置驱动（配置中心 · 套餐管理），改配置即改页面。","legend":["档位与价格均由后台配置（配置中心 · 套餐管理）驱动","功能权益按档解锁，不为「AI 加价」单独收费","私有化与定制需求请联系我们另行报价"]}}'::jsonb,
 'system', now())
ON CONFLICT (tenant_id, key) DO UPDATE SET value=EXCLUDED.value, updated_at=now();

INSERT INTO crm.config_store (tenant_id, key, value, updated_by, updated_at) VALUES
('system','billing-plans',
 '[{"plan_id":"free","name":"免费版 · Free","enabled":true,"base_fee":99,"included_seats":3,"seat_unit_price":99,"original_price":null,"tag_text":"前三月免费","included_tokens":50000,"token_overage_unit_price":0.03,"token_overage_mode":"block","token_hard_cap":null,"currency":"CNY","quote":"原价：¥99 / 账号（前三月免费）","features":["核心 CRM（客户/商机/合同/报价/回款）"],"entitlements":["core_crm","ai_agents","customer_360","memory"]},
   {"plan_id":"starter","name":"成长版 · Starter","enabled":true,"base_fee":0,"included_seats":0,"seat_unit_price":398,"original_price":698,"tag_text":"首月特价","included_tokens":200000,"token_overage_unit_price":0.025,"token_overage_mode":"bill","token_hard_cap":600000,"currency":"CNY","quote":"¥698 / 账号·月","features":["AI 智能体四件套 + 客户 360 洞察"],"entitlements":["core_crm","ai_agents","customer_360","approval_flow","mcp_access","memory"]},
   {"plan_id":"pro","name":"增强版 · Pro","enabled":true,"highlight":true,"base_fee":0,"included_seats":0,"seat_unit_price":2980,"original_price":null,"tag_text":"热销","included_tokens":1000000,"token_overage_unit_price":0.02,"token_overage_mode":"bill","token_hard_cap":3000000,"currency":"CNY","quote":"¥2980 / 账号·月","features":["决策自治","事件自动化","审批流","LLM","MCP","高级报表","审计"],"entitlements":["core_crm","ai_agents","customer_360","decision_autonomy","event_automation","approval_flow","llm_config","mcp_access","advanced_reporting","audit_provenance","memory"]},
   {"plan_id":"enterprise","name":"企业版 · Enterprise","enabled":true,"base_fee":0,"included_seats":0,"seat_unit_price":8800,"original_price":null,"tag_text":"企业首选","included_tokens":5000000,"token_overage_unit_price":0.015,"token_overage_mode":"bill","token_hard_cap":15000000,"currency":"CNY","quote":"¥8800 / 账号·月","features":["行业配置化","高级 RBAC","客户记忆","SLA"],"entitlements":["core_crm","ai_agents","customer_360","decision_autonomy","event_automation","approval_flow","llm_config","mcp_access","advanced_reporting","audit_provenance","industry_config","rbac_advanced","memory"]},
   {"plan_id":"local_flagship","name":"本地旗舰版 · Local Flagship","enabled":true,"base_fee":0,"included_seats":-1,"seat_unit_price":-1,"original_price":null,"tag_text":"","included_tokens":-1,"token_overage_unit_price":0,"token_overage_mode":"bill","token_hard_cap":null,"currency":"CNY","quote":"面议","features":["私有化本地部署","全量功能","数据不出域"],"entitlements":["core_crm","ai_agents","customer_360","decision_autonomy","event_automation","approval_flow","llm_config","mcp_access","advanced_reporting","audit_provenance","industry_config","rbac_advanced","memory","local_integration","distributed_db","vector_store"]}]'::jsonb,
 'system', now())
ON CONFLICT (tenant_id, key) DO UPDATE SET value=EXCLUDED.value, updated_at=now();
