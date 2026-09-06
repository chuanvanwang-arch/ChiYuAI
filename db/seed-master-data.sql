-- db/seed-master-data.sql — 业务主数据门户种子（P0 五面）
-- 设计：docs/superpowers/specs/2026-08-28-business-master-data-design.md
-- 实施：docs/superpowers/plans/2026-08-28-business-master-data-impl.md
--
-- 安全声明（重要）：本文件**不含** TRUNCATE / DELETE / DROP，仅 INSERT 且全部
-- `ON CONFLICT (id) DO NOTHING` → 幂等、增量，可安全重跑，绝不清理既有数据。
-- 执行：node scripts/seed-master-data.mjs
--
-- state 取值对齐各粒子 flow，且与页面软停用（PATCH /api/particles/:id）白名单一致：
--   CRM_PRODUCT      → on_sale / discontinued
--   CRM_PRICE_LIST   → draft / active / expired
--   CRM_OFFER_POLICY → draft / active / expired
--   CRM_DICT_ENTRY   → registered / deprecated
-- 注：字典面 activeDictValues() 只消费 state='registered' 且 payload.active!==false 的项。

-- ============ ① 产品目录（CRM_PRODUCT）============
INSERT INTO crm.particles (id, tenant_id, type, slug, title, state, payload, created_at, updated_at) VALUES
('b0000001-0000-0000-0000-000000000001', 'system', 'CRM_PRODUCT', 'product-crm-standard', 'CRM 标准版（SaaS 年费）', 'on_sale',
 '{"name":"CRM 标准版（SaaS 年费）","unit":"套/年","category":"软件","list_price":98000,"status":"on_sale"}',
 '2026-01-01T09:00:00+08:00', '2026-08-28T09:00:00+08:00'),
('b0000001-0000-0000-0000-000000000002', 'system', 'CRM_PRODUCT', 'product-colorbox', '彩盒印制服务', 'on_sale',
 '{"name":"彩盒印制服务","unit":"批","category":"印制服务","list_price":45000,"status":"on_sale"}',
 '2026-01-01T09:00:00+08:00', '2026-08-28T09:00:00+08:00'),
('b0000001-0000-0000-0000-000000000003', 'system', 'CRM_PRODUCT', 'product-instruction', '药品说明书印制', 'on_sale',
 '{"name":"药品说明书印制","unit":"万册","category":"印制服务","list_price":12000,"status":"on_sale"}',
 '2026-01-01T09:00:00+08:00', '2026-08-28T09:00:00+08:00'),
('b0000001-0000-0000-0000-000000000004', 'system', 'CRM_PRODUCT', 'product-implementation', '实施服务', 'on_sale',
 '{"name":"实施服务","unit":"人天","category":"服务","list_price":2000,"status":"on_sale"}',
 '2026-01-01T09:00:00+08:00', '2026-08-28T09:00:00+08:00'),
('b0000001-0000-0000-0000-000000000005', 'system', 'CRM_PRODUCT', 'product-giftbox', '食品礼盒定制', 'on_sale',
 '{"name":"食品礼盒定制","unit":"套","category":"印制服务","list_price":38000,"status":"on_sale"}',
 '2026-01-01T09:00:00+08:00', '2026-08-28T09:00:00+08:00'),
('b0000001-0000-0000-0000-000000000006', 'system', 'CRM_PRODUCT', 'product-carton-special', '特殊彩盒（异形/防伪）', 'on_sale',
 '{"name":"特殊彩盒（异形/防伪）","unit":"批","category":"印制服务","list_price":52000,"status":"on_sale"}',
 '2026-01-01T09:00:00+08:00', '2026-08-28T09:00:00+08:00'),
('b0000001-0000-0000-0000-000000000007', 'system', 'CRM_PRODUCT', 'product-direct-mail', '直邮信函印制', 'on_sale',
 '{"name":"直邮信函印制","unit":"万封","category":"印制服务","list_price":9000,"status":"on_sale"}',
 '2026-01-01T09:00:00+08:00', '2026-08-28T09:00:00+08:00'),
('b0000001-0000-0000-0000-000000000008', 'system', 'CRM_PRODUCT', 'product-tech-support', '技术支持服务（年包）', 'on_sale',
 '{"name":"技术支持服务（年包）","unit":"套/年","category":"服务","list_price":28000,"status":"on_sale"}',
 '2026-01-01T09:00:00+08:00', '2026-08-28T09:00:00+08:00'),
('b0000001-0000-0000-0000-000000000009', 'system', 'CRM_PRODUCT', 'product-crm-professional', 'CRM 专业版（SaaS 年费）', 'on_sale',
 '{"name":"CRM 专业版（SaaS 年费）","unit":"套/年","category":"软件","list_price":158000,"status":"on_sale"}',
 '2026-01-01T09:00:00+08:00', '2026-08-28T09:00:00+08:00'),
('b0000001-0000-0000-0000-000000000010', 'system', 'CRM_PRODUCT', 'product-poster-brochure', '海报/画册印制', 'on_sale',
 '{"name":"海报/画册印制","unit":"批","category":"印制服务","list_price":26000,"status":"on_sale"}',
 '2026-01-01T09:00:00+08:00', '2026-08-28T09:00:00+08:00'),
('b0000001-0000-0000-0000-000000000011', 'system', 'CRM_PRODUCT', 'product-crm-enterprise', 'CRM 企业版（私有化部署）', 'on_sale',
 '{"name":"CRM 企业版（私有化部署）","unit":"套","category":"软件","list_price":680000,"status":"on_sale"}',
 '2026-01-01T09:00:00+08:00', '2026-08-28T09:00:00+08:00'),
('b0000001-0000-0000-0000-000000000012', 'system', 'CRM_PRODUCT', 'product-voucher-label', '代金券/标签防伪印制', 'on_sale',
 '{"name":"代金券/标签防伪印制","unit":"万份","category":"印制服务","list_price":6500,"status":"on_sale"}',
 '2026-01-01T09:00:00+08:00', '2026-08-28T09:00:00+08:00')
ON CONFLICT (id) DO NOTHING;

-- ============ ② 基础价格表（CRM_PRICE_LIST）============
-- 报价自动取价（quoteService/priceCalc）消费；state=active 方生效
INSERT INTO crm.particles (id, tenant_id, type, slug, title, state, payload, created_at, updated_at) VALUES
('b0000002-0000-0000-0000-000000000001', 'system', 'CRM_PRICE_LIST', 'pricelist-2026-standard', '2026 标准价格表', 'active',
 '{"name":"2026 标准价格表","valid_from":"2026-01-01","valid_to":"2026-12-31","permission":"internal","products":["CRM 标准版（SaaS 年费）","实施服务","彩盒印制服务"],"change_log":"2026-01-01 建立"}',
 '2026-01-01T09:00:00+08:00', '2026-08-28T09:00:00+08:00'),
('b0000002-0000-0000-0000-000000000002', 'system', 'CRM_PRICE_LIST', 'pricelist-2026-ka', '2026 大客户专享价', 'active',
 '{"name":"2026 大客户专享价","valid_from":"2026-01-01","valid_to":"2026-12-31","permission":"restricted","products":["食品礼盒定制","药品说明书印制"],"change_log":"2026-03-01 新增 KA 折扣"}',
 '2026-03-01T09:00:00+08:00', '2026-08-28T09:00:00+08:00'),
('b0000002-0000-0000-0000-000000000003', 'system', 'CRM_PRICE_LIST', 'pricelist-2026-ecommerce', '2026 电商渠道价', 'active',
 '{"name":"2026 电商渠道价","valid_from":"2026-01-01","valid_to":"2026-12-31","permission":"public","products":["食品礼盒定制","海报/画册印制","直邮信函印制"],"change_log":"2026-05-01 电商上架 3 款"}',
 '2026-05-01T09:00:00+08:00', '2026-08-28T09:00:00+08:00'),
('b0000002-0000-0000-0000-000000000004', 'system', 'CRM_PRICE_LIST', 'pricelist-2026-renewal', '2026 老客户续约价', 'draft',
 '{"name":"2026 老客户续约价","valid_from":"2026-07-01","valid_to":"2027-06-30","permission":"internal","products":["CRM 标准版（SaaS 年费）","技术支持服务（年包）"],"change_log":"2026-07-01 续约专项，审批后生效"}',
 '2026-07-01T09:00:00+08:00', '2026-08-28T09:00:00+08:00')
ON CONFLICT (id) DO NOTHING;

-- ============ ③ 报价商务规则包（CRM_OFFER_POLICY, subtype=standard）============
-- cost_structure / price_bands / tier_discount 以 JSON 文本存放（payload JSONB 自由形态），
-- 由 offerPolicyRender 的 resolvePriceBands / costTotal / marginView 消费（报价毛利透视 + 三级定价）
INSERT INTO crm.particles (id, tenant_id, type, slug, title, state, payload, created_at, updated_at) VALUES
('b0000003-0000-0000-0000-000000000001', 'system', 'CRM_OFFER_POLICY', 'policy-standard-2026', '标准方案包（印制+实施）', 'active',
 '{"name":"标准方案包（印制+实施）","subtype":"standard","cost_structure":"[{\"item\":\"印制成本\",\"cost\":52000},{\"item\":\"实施服务\",\"cost\":16000}]","price_bands":"{\"open\":120000,\"target\":100000,\"floor\":85000}","discount_conditions":"预付 50% 享 95 折；年度框架享 9 折。对等条件：客户承诺年度最低采购量 30 万","margin_redline":0.25,"tier_discount":"[{\"qty\":1,\"discount\":0},{\"qty\":5,\"discount\":0.05},{\"qty\":10,\"discount\":0.08}]","change_billing":"需求变更按 2000 元/人天计费","valid_from":"2026-01-01","valid_to":"2026-12-31"}',
 '2026-01-01T09:00:00+08:00', '2026-08-28T09:00:00+08:00'),
('b0000003-0000-0000-0000-000000000002', 'system', 'CRM_OFFER_POLICY', 'policy-ka-2026', '大客户方案包（全年框架）', 'active',
 '{"name":"大客户方案包（全年框架）","subtype":"standard","cost_structure":"[{\"item\":\"印制成本\",\"cost\":980000},{\"item\":\"实施服务\",\"cost\":120000}]","price_bands":"{\"open\":1500000,\"target\":1350000,\"floor\":1200000}","discount_conditions":"全年框架总量≥1000 万享 88 折；账期与预付比例按回款政策执行","margin_redline":0.18,"tier_discount":"[{\"qty\":1,\"discount\":0},{\"qty\":3,\"discount\":0.06},{\"qty\":6,\"discount\":0.1}]","change_billing":"框架内变更免费，超出部分按 1800 元/人天","valid_from":"2026-01-01","valid_to":"2026-12-31"}',
 '2026-01-01T09:00:00+08:00', '2026-08-28T09:00:00+08:00'),
('b0000003-0000-0000-0000-000000000003', 'system', 'CRM_OFFER_POLICY', 'policy-pharma-traceability', '医药追溯专案（赋码 + 说明书）', 'active',
 '{"name":"医药追溯专案（赋码 + 说明书）","subtype":"standard","cost_structure":"[{\"item\":\"说明书印制\",\"cost\":8500},{\"item\":\"赋码追溯服务\",\"cost\":12000}]","price_bands":"{\"open\":68000,\"target\":58000,\"floor\":50000}","discount_conditions":"需通过药企资质备案；预付 30% 享 97 折；单批起订 5 万册","margin_redline":0.30,"tier_discount":"[{\"qty\":1,\"discount\":0},{\"qty\":5,\"discount\":0.04},{\"qty\":10,\"discount\":0.07}]","change_billing":"赋码内容变更按 1500 元/次","valid_from":"2026-02-01","valid_to":"2026-12-31"}',
 '2026-02-01T09:00:00+08:00', '2026-08-28T09:00:00+08:00'),
('b0000003-0000-0000-0000-000000000004', 'system', 'CRM_OFFER_POLICY', 'policy-ecommerce-pack', '电商促销包装方案', 'active',
 '{"name":"电商促销包装方案","subtype":"standard","cost_structure":"[{\"item\":\"礼盒印制\",\"cost\":28000},{\"item\":\"直邮信函\",\"cost\":6000}]","price_bands":"{\"open\":88000,\"target\":76000,\"floor\":65000}","discount_conditions":"订单≥2000 套享 95 折；双 11/618 大促期享 9 折（限时）","margin_redline":0.22,"tier_discount":"[{\"qty\":1,\"discount\":0},{\"qty\":10,\"discount\":0.05},{\"qty\":50,\"discount\":0.08}]","change_billing":"包装改版按 2500 元/款","valid_from":"2026-03-01","valid_to":"2026-12-31"}',
 '2026-03-01T09:00:00+08:00', '2026-08-28T09:00:00+08:00'),
('b0000003-0000-0000-0000-000000000005', 'system', 'CRM_OFFER_POLICY', 'policy-preprint-point', '印前服务点价包', 'draft',
 '{"name":"印前服务点价包","subtype":"standard","cost_structure":"[{\"item\":\"打样\",\"cost\":1800},{\"item\":\"拼版设计\",\"cost\":2500}]","price_bands":"{\"open\":30000,\"target\":26000,\"floor\":20000}","discount_conditions":"仅对已建档客户开放；首单享 98 折","margin_redline":0.35,"tier_discount":"[{\"qty\":1,\"discount\":0},{\"qty\":3,\"discount\":0.03}]","change_billing":"改版费按 800 元/次","valid_from":"2026-01-01","valid_to":"2026-12-31"}',
 '2026-01-01T09:00:00+08:00', '2026-08-28T09:00:00+08:00')
ON CONFLICT (id) DO NOTHING;

-- ============ ④ 回款政策（CRM_OFFER_POLICY, subtype=payment）============
-- 与商务规则包共用粒子，靠 subtype='payment' 区分；页面侧按 subtype 过滤展示
INSERT INTO crm.particles (id, tenant_id, type, slug, title, state, payload, created_at, updated_at) VALUES
('b0000005-0000-0000-0000-000000000001', 'system', 'CRM_OFFER_POLICY', 'paypolicy-standard-30', '标准回款政策（30 天账期）', 'active',
 '{"name":"标准回款政策（30 天账期）","subtype":"payment","payment_term":30,"collection_tier":"沟通","prepay_ratio":0,"valid_from":"2026-01-01","valid_to":"2026-12-31"}',
 '2026-01-01T09:00:00+08:00', '2026-08-28T09:00:00+08:00'),
('b0000005-0000-0000-0000-000000000002', 'system', 'CRM_OFFER_POLICY', 'paypolicy-ka-60', '大客户回款政策（60 天账期 + 20% 预付）', 'active',
 '{"name":"大客户回款政策（60 天账期 + 20% 预付）","subtype":"payment","payment_term":60,"collection_tier":"施压","prepay_ratio":20,"valid_from":"2026-01-01","valid_to":"2026-12-31"}',
 '2026-01-01T09:00:00+08:00', '2026-08-28T09:00:00+08:00'),
('b0000005-0000-0000-0000-000000000003', 'system', 'CRM_OFFER_POLICY', 'paypolicy-ecom-30', '电商渠道回款政策（30 天账期）', 'active',
 '{"name":"电商渠道回款政策（30 天账期）","subtype":"payment","payment_term":30,"collection_tier":"沟通","prepay_ratio":0,"valid_from":"2026-01-01","valid_to":"2026-12-31"}',
 '2026-01-01T09:00:00+08:00', '2026-08-28T09:00:00+08:00'),
('b0000005-0000-0000-0000-000000000004', 'system', 'CRM_OFFER_POLICY', 'paypolicy-pharma-90', '医药客户回款政策（90 天账期 + 10% 预付）', 'active',
 '{"name":"医药客户回款政策（90 天账期 + 10% 预付）","subtype":"payment","payment_term":90,"collection_tier":"施压","prepay_ratio":10,"valid_from":"2026-02-01","valid_to":"2026-12-31"}',
 '2026-02-01T09:00:00+08:00', '2026-08-28T09:00:00+08:00')
ON CONFLICT (id) DO NOTHING;

-- ============ ⑤ 字典值域（CRM_DICT_ENTRY）============
-- 供 meta-attr 元模型 select 下拉消费（activeDictValues：state='registered' 且 active!==false）
INSERT INTO crm.particles (id, tenant_id, type, slug, title, state, payload, created_at, updated_at) VALUES
-- industry（行业）
('b0000004-0000-0000-0000-000000000001', 'system', 'CRM_DICT_ENTRY', 'dict-industry-1', '包装印刷', 'registered',
 '{"dict_key":"industry","dict_value":"包装印刷","sort_order":1,"active":true}', '2026-08-28T09:00:00+08:00', '2026-08-28T09:00:00+08:00'),
('b0000004-0000-0000-0000-000000000002', 'system', 'CRM_DICT_ENTRY', 'dict-industry-2', '医药', 'registered',
 '{"dict_key":"industry","dict_value":"医药","sort_order":2,"active":true}', '2026-08-28T09:00:00+08:00', '2026-08-28T09:00:00+08:00'),
('b0000004-0000-0000-0000-000000000003', 'system', 'CRM_DICT_ENTRY', 'dict-industry-3', '食品', 'registered',
 '{"dict_key":"industry","dict_value":"食品","sort_order":3,"active":true}', '2026-08-28T09:00:00+08:00', '2026-08-28T09:00:00+08:00'),
('b0000004-0000-0000-0000-000000000004', 'system', 'CRM_DICT_ENTRY', 'dict-industry-4', '电子制造', 'registered',
 '{"dict_key":"industry","dict_value":"电子制造","sort_order":4,"active":true}', '2026-08-28T09:00:00+08:00', '2026-08-28T09:00:00+08:00'),
-- size（规模）
('b0000004-0000-0000-0000-000000000005', 'system', 'CRM_DICT_ENTRY', 'dict-size-1', '微型企业', 'registered',
 '{"dict_key":"size","dict_value":"微型企业","sort_order":1,"active":true}', '2026-08-28T09:00:00+08:00', '2026-08-28T09:00:00+08:00'),
('b0000004-0000-0000-0000-000000000006', 'system', 'CRM_DICT_ENTRY', 'dict-size-2', '小型企业', 'registered',
 '{"dict_key":"size","dict_value":"小型企业","sort_order":2,"active":true}', '2026-08-28T09:00:00+08:00', '2026-08-28T09:00:00+08:00'),
('b0000004-0000-0000-0000-000000000007', 'system', 'CRM_DICT_ENTRY', 'dict-size-3', '中型企业', 'registered',
 '{"dict_key":"size","dict_value":"中型企业","sort_order":3,"active":true}', '2026-08-28T09:00:00+08:00', '2026-08-28T09:00:00+08:00'),
('b0000004-0000-0000-0000-000000000008', 'system', 'CRM_DICT_ENTRY', 'dict-size-4', '大型企业', 'registered',
 '{"dict_key":"size","dict_value":"大型企业","sort_order":4,"active":true}', '2026-08-28T09:00:00+08:00', '2026-08-28T09:00:00+08:00'),
-- region（区域）
('b0000004-0000-0000-0000-000000000009', 'system', 'CRM_DICT_ENTRY', 'dict-region-1', '华东', 'registered',
 '{"dict_key":"region","dict_value":"华东","sort_order":1,"active":true}', '2026-08-28T09:00:00+08:00', '2026-08-28T09:00:00+08:00'),
('b0000004-0000-0000-0000-000000000010', 'system', 'CRM_DICT_ENTRY', 'dict-region-2', '华南', 'registered',
 '{"dict_key":"region","dict_value":"华南","sort_order":2,"active":true}', '2026-08-28T09:00:00+08:00', '2026-08-28T09:00:00+08:00'),
('b0000004-0000-0000-0000-000000000011', 'system', 'CRM_DICT_ENTRY', 'dict-region-3', '华北', 'registered',
 '{"dict_key":"region","dict_value":"华北","sort_order":3,"active":true}', '2026-08-28T09:00:00+08:00', '2026-08-28T09:00:00+08:00'),
('b0000004-0000-0000-0000-000000000012', 'system', 'CRM_DICT_ENTRY', 'dict-region-4', '西南', 'registered',
 '{"dict_key":"region","dict_value":"西南","sort_order":4,"active":true}', '2026-08-28T09:00:00+08:00', '2026-08-28T09:00:00+08:00'),
-- payment_method（付款方式）
('b0000004-0000-0000-0000-000000000013', 'system', 'CRM_DICT_ENTRY', 'dict-pay-1', '电汇', 'registered',
 '{"dict_key":"payment_method","dict_value":"电汇","sort_order":1,"active":true}', '2026-08-28T09:00:00+08:00', '2026-08-28T09:00:00+08:00'),
('b0000004-0000-0000-0000-000000000014', 'system', 'CRM_DICT_ENTRY', 'dict-pay-2', '银行承兑', 'registered',
 '{"dict_key":"payment_method","dict_value":"银行承兑","sort_order":2,"active":true}', '2026-08-28T09:00:00+08:00', '2026-08-28T09:00:00+08:00'),
('b0000004-0000-0000-0000-000000000015', 'system', 'CRM_DICT_ENTRY', 'dict-pay-3', '信用证', 'registered',
 '{"dict_key":"payment_method","dict_value":"信用证","sort_order":3,"active":true}', '2026-08-28T09:00:00+08:00', '2026-08-28T09:00:00+08:00'),
-- decision_power（决策力）
('b0000004-0000-0000-0000-000000000016', 'system', 'CRM_DICT_ENTRY', 'dict-power-1', 'high', 'registered',
 '{"dict_key":"decision_power","dict_value":"high","sort_order":1,"active":true}', '2026-08-28T09:00:00+08:00', '2026-08-28T09:00:00+08:00'),
('b0000004-0000-0000-0000-000000000017', 'system', 'CRM_DICT_ENTRY', 'dict-power-2', 'medium', 'registered',
 '{"dict_key":"decision_power","dict_value":"medium","sort_order":2,"active":true}', '2026-08-28T09:00:00+08:00', '2026-08-28T09:00:00+08:00'),
('b0000004-0000-0000-0000-000000000018', 'system', 'CRM_DICT_ENTRY', 'dict-power-3', 'low', 'registered',
 '{"dict_key":"decision_power","dict_value":"low","sort_order":3,"active":true}', '2026-08-28T09:00:00+08:00', '2026-08-28T09:00:00+08:00'),
-- contact_level（对接人级别）
('b0000004-0000-0000-0000-000000000019', 'system', 'CRM_DICT_ENTRY', 'dict-level-1', '决策者', 'registered',
 '{"dict_key":"contact_level","dict_value":"决策者","sort_order":1,"active":true}', '2026-08-28T09:00:00+08:00', '2026-08-28T09:00:00+08:00'),
('b0000004-0000-0000-0000-000000000020', 'system', 'CRM_DICT_ENTRY', 'dict-level-2', '影响者', 'registered',
 '{"dict_key":"contact_level","dict_value":"影响者","sort_order":2,"active":true}', '2026-08-28T09:00:00+08:00', '2026-08-28T09:00:00+08:00'),
('b0000004-0000-0000-0000-000000000021', 'system', 'CRM_DICT_ENTRY', 'dict-level-3', '使用者', 'registered',
 '{"dict_key":"contact_level","dict_value":"使用者","sort_order":3,"active":true}', '2026-08-28T09:00:00+08:00', '2026-08-28T09:00:00+08:00'),
-- industry 继续（5-6）
('b0000004-0000-0000-0000-000000000022', 'system', 'CRM_DICT_ENTRY', 'dict-industry-5', '汽车零部件', 'registered',
 '{"dict_key":"industry","dict_value":"汽车零部件","sort_order":5,"active":true}', '2026-08-28T09:00:00+08:00', '2026-08-28T09:00:00+08:00'),
('b0000004-0000-0000-0000-000000000023', 'system', 'CRM_DICT_ENTRY', 'dict-industry-6', '医疗器械', 'registered',
 '{"dict_key":"industry","dict_value":"医疗器械","sort_order":6,"active":true}', '2026-08-28T09:00:00+08:00', '2026-08-28T09:00:00+08:00'),
-- region 继续（5-7）
('b0000004-0000-0000-0000-000000000024', 'system', 'CRM_DICT_ENTRY', 'dict-region-5', '华中', 'registered',
 '{"dict_key":"region","dict_value":"华中","sort_order":5,"active":true}', '2026-08-28T09:00:00+08:00', '2026-08-28T09:00:00+08:00'),
('b0000004-0000-0000-0000-000000000025', 'system', 'CRM_DICT_ENTRY', 'dict-region-6', '东北', 'registered',
 '{"dict_key":"region","dict_value":"东北","sort_order":6,"active":true}', '2026-08-28T09:00:00+08:00', '2026-08-28T09:00:00+08:00'),
('b0000004-0000-0000-0000-000000000026', 'system', 'CRM_DICT_ENTRY', 'dict-region-7', '西北', 'registered',
 '{"dict_key":"region","dict_value":"西北","sort_order":7,"active":true}', '2026-08-28T09:00:00+08:00', '2026-08-28T09:00:00+08:00'),
-- payment_method 继续（4-5）
('b0000004-0000-0000-0000-000000000027', 'system', 'CRM_DICT_ENTRY', 'dict-pay-4', '商业承兑', 'registered',
 '{"dict_key":"payment_method","dict_value":"商业承兑","sort_order":4,"active":true}', '2026-08-28T09:00:00+08:00', '2026-08-28T09:00:00+08:00'),
('b0000004-0000-0000-0000-000000000028', 'system', 'CRM_DICT_ENTRY', 'dict-pay-5', '分期付款', 'registered',
 '{"dict_key":"payment_method","dict_value":"分期付款","sort_order":5,"active":true}', '2026-08-28T09:00:00+08:00', '2026-08-28T09:00:00+08:00')
ON CONFLICT (id) DO NOTHING;
