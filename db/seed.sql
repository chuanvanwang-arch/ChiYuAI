-- db/seed.sql — 印刷行业销售全链路种子（Task 10 落地）
-- 设计输入：CRM-ai-native 粒子底座（crm.particles / crm.edges）；印刷行业销售管理场景
-- 加载：npm run seed  →  node db/migrate.js --seed  →  pool.query(seedSql) 单次多语句执行
-- 幂等：所有粒子/边用固定 UUID + ON CONFLICT (id) DO NOTHING，重跑安全、不重复、不删现有数据
-- 不碰库内已有粒子（北京智云科技壳子原样共存）
-- 注意：crm.particles.state 列是粒子生命周期（默认 ACTIVE）；业务阶段存 payload.stage。
--       实际扫描器 runRiskScan 仅按 payload.stage_changed_at 计算 ai.stuck_warning（>30天）。

SET search_path TO crm, public;

-- ============ 客户（指名客户演示数据：alice 负责 / 重点档 / 已激活）============
INSERT INTO crm.particles (id, tenant_id, type, slug, title, state, payload, created_at, updated_at) VALUES
('a1111111-1111-1111-1111-111111111101', 'system', 'CRM_ACCOUNT', 'account-yintong',
 '上海印通包装科技有限公司', 'ACTIVE',
 '{"name":"上海印通包装科技有限公司","industry":"包装印刷","region":"华东","business_title":"上海印通包装科技有限公司（一般纳税人）","source":"官网询盘","size":"中型企业","rating":"A","deal_count":4,"last_interaction":"2026-08-20T09:00:00+08:00","champion_strength":"strong","named_owner":"alice","named_tier":"重点","named_state":"active","visit_notes":[{"at":"2026-08-28T10:00:00+08:00","type":"visit","objective":"月度拜访","result":"确认 Q4 礼盒需求","next":"提供报价"},{"at":"2026-08-29T14:00:00+08:00","type":"call","objective":"电话跟进","result":"对方采购总监出差","next":"下周再约"}]}',
 '2026-06-01T09:00:00+08:00', '2026-08-20T09:00:00+08:00')
ON CONFLICT (id) DO NOTHING;

-- ============ 联系人 ============
INSERT INTO crm.particles (id, tenant_id, type, slug, title, state, payload, created_at, updated_at) VALUES
('a2222222-2222-2222-2222-222222222201', 'system', 'CRM_CONTACT', 'contact-liwei',
 '李伟', 'ACTIVE',
 '{"name":"李伟","email":"liwei@yintong-print.com","phone":"13800001111","title":"采购总监","department":"采购","decision_power":"high","relationship_strength":"strong"}',
 '2026-06-02T10:00:00+08:00', '2026-08-20T09:00:00+08:00')
ON CONFLICT (id) DO NOTHING;

-- ============ 商机（4 条，多阶段）============
-- D-lead：彩盒打样询盘（新建）
INSERT INTO crm.particles (id, tenant_id, type, slug, title, state, payload, created_at, updated_at) VALUES
('d1111111-1111-1111-1111-111111111111', 'system', 'CRM_DEAL', 'deal-lead',
 '彩盒打样询盘', 'ACTIVE',
 '{"name":"彩盒打样询盘","stage":"lead","expected_amount":120000,"probability":0.10,"stage_changed_at":"2026-08-18T09:00:00+08:00","account_id":"a1111111-1111-1111-1111-111111111101","owner":"王川","props":{"demo":true}}',
 '2026-08-18T09:00:00+08:00', '2026-08-18T09:00:00+08:00')
ON CONFLICT (id) DO NOTHING;

-- D-quoted：药品说明书画册（quoted 阶段，停留>30天，无技术方案 → 埋断裂点，扫描器命中 stuck_warning）
INSERT INTO crm.particles (id, tenant_id, type, slug, title, state, payload, created_at, updated_at) VALUES
('d2222222-2222-2222-2222-222222222222', 'system', 'CRM_DEAL', 'deal-quoted',
 '药品说明书画册', 'ACTIVE',
 '{"name":"药品说明书画册","stage":"quoted","expected_amount":380000,"probability":0.60,"stage_changed_at":"2026-07-05T09:00:00+08:00","account_id":"a1111111-1111-1111-1111-111111111101","owner":"王川","props":{"demo":true}}',
 '2026-05-20T09:00:00+08:00', '2026-07-05T09:00:00+08:00')
ON CONFLICT (id) DO NOTHING;

-- D-contracted：食品礼盒全年框架（赢单，挂技术方案）
INSERT INTO crm.particles (id, tenant_id, type, slug, title, state, payload, created_at, updated_at) VALUES
('d3333333-3333-3333-3333-333333333333', 'system', 'CRM_DEAL', 'deal-contracted',
 '食品礼盒全年框架', 'ACTIVE',
 '{"name":"食品礼盒全年框架","stage":"contracted","expected_amount":1500000,"probability":0.85,"stage_changed_at":"2026-07-28T09:00:00+08:00","account_id":"a1111111-1111-1111-1111-111111111101","owner":"王川","props":{"demo":true}}',
 '2026-06-10T09:00:00+08:00', '2026-07-28T09:00:00+08:00')
ON CONFLICT (id) DO NOTHING;

-- D-paid：年报精装印刷（已回款闭环）
INSERT INTO crm.particles (id, tenant_id, type, slug, title, state, payload, created_at, updated_at) VALUES
('d4444444-4444-4444-4444-444444444444', 'system', 'CRM_DEAL', 'deal-paid',
 '年报精装印刷', 'ACTIVE',
 '{"name":"年报精装印刷","stage":"paid","expected_amount":260000,"probability":1.00,"stage_changed_at":"2026-07-10T09:00:00+08:00","account_id":"a1111111-1111-1111-1111-111111111101","owner":"王川","props":{"demo":true}}',
 '2026-06-15T09:00:00+08:00', '2026-07-10T09:00:00+08:00')
ON CONFLICT (id) DO NOTHING;

-- ============ 技术方案（仅赢单 D-contracted 挂，D-quoted 故意不挂 → 无方案断裂语义）============
INSERT INTO crm.particles (id, tenant_id, type, slug, title, state, payload, created_at, updated_at) VALUES
('b1111111-1111-1111-1111-111111111111', 'system', 'CRM_TECHNICAL_PROPOSAL', 'tp-contracted',
 '食品礼盒烫金工艺方案', 'ACTIVE',
 '{"title":"食品礼盒烫金工艺方案","content":"定位烫金+逆向UV，承印物350g白卡，附SGS报告","solution_type":"工艺方案","owner_id":"王川","deal_id":"d3333333-3333-3333-3333-333333333333"}',
 '2026-07-20T09:00:00+08:00', '2026-07-20T09:00:00+08:00')
ON CONFLICT (id) DO NOTHING;

-- ============ 报价单 ============
INSERT INTO crm.particles (id, tenant_id, type, slug, title, state, payload, created_at, updated_at) VALUES
('f1111111-1111-1111-1111-111111111111', 'system', 'CRM_QUOTATION', 'quote-contracted',
 '食品礼盒框架报价', 'ACTIVE',
 '{"name":"食品礼盒框架报价","deal_id":"d3333333-3333-3333-3333-333333333333","valid_until":"2026-12-31","amount":1500000,"items":[{"product_id":"p-folding-box","qty":50000,"unit_price":30,"discount":0.05,"tax":0.13}],"approval_status":"approved","invalid":false}',
 '2026-07-22T09:00:00+08:00', '2026-07-22T09:00:00+08:00')
ON CONFLICT (id) DO NOTHING;

INSERT INTO crm.particles (id, tenant_id, type, slug, title, state, payload, created_at, updated_at) VALUES
('f2222222-2222-2222-2222-222222222222', 'system', 'CRM_QUOTATION', 'quote-paid',
 '年报精装报价', 'ACTIVE',
 '{"name":"年报精装报价","deal_id":"d4444444-4444-4444-4444-444444444444","valid_until":"2026-09-30","amount":260000,"items":[{"product_id":"p-hardcover","qty":3000,"unit_price":86.6,"discount":0,"tax":0.13}],"approval_status":"approved","invalid":false}',
 '2026-06-25T09:00:00+08:00', '2026-06-25T09:00:00+08:00')
ON CONFLICT (id) DO NOTHING;

-- ============ 合同 ============
INSERT INTO crm.particles (id, tenant_id, type, slug, title, state, payload, created_at, updated_at) VALUES
('c1111111-1111-1111-1111-111111111111', 'system', 'CRM_CONTRACT', 'contract-contracted',
 '食品礼盒框架合同', 'effective',
 '{"contract_no":"HT-2026-001","deal_id":"d3333333-3333-3333-3333-333333333333","quotation_id":"f1111111-1111-1111-1111-111111111111","amount":1500000,"start_date":"2026-08-01","end_date":"2027-07-31","approval_status":"effective"}',
 '2026-08-01T09:00:00+08:00', '2026-08-01T09:00:00+08:00')
ON CONFLICT (id) DO NOTHING;

INSERT INTO crm.particles (id, tenant_id, type, slug, title, state, payload, created_at, updated_at) VALUES
('c2222222-2222-2222-2222-222222222222', 'system', 'CRM_CONTRACT', 'contract-paid',
 '年报精装合同', 'effective',
 '{"contract_no":"HT-2026-002","deal_id":"d4444444-4444-4444-4444-444444444444","quotation_id":"f2222222-2222-2222-2222-222222222222","amount":260000,"start_date":"2026-07-01","end_date":"2026-07-31","approval_status":"effective"}',
 '2026-07-01T09:00:00+08:00', '2026-07-01T09:00:00+08:00')
ON CONFLICT (id) DO NOTHING;

-- ============ 订单 ============
INSERT INTO crm.particles (id, tenant_id, type, slug, title, state, payload, created_at, updated_at) VALUES
('b2111111-1111-1111-1111-111111111111', 'system', 'CRM_ORDER', 'order-contracted',
 '食品礼盒首批量产订单', 'shipped',
 '{"order_no":"SO-2026-001","deal_id":"d3333333-3333-3333-3333-333333333333","contract_id":"c1111111-1111-1111-1111-111111111111","amount":500000,"status":"shipped"}',
 '2026-08-05T09:00:00+08:00', '2026-08-15T09:00:00+08:00')
ON CONFLICT (id) DO NOTHING;

INSERT INTO crm.particles (id, tenant_id, type, slug, title, state, payload, created_at, updated_at) VALUES
('b2222222-2222-2222-2222-222222222222', 'system', 'CRM_ORDER', 'order-paid',
 '年报精装交付订单', 'completed',
 '{"order_no":"SO-2026-002","deal_id":"d4444444-4444-4444-4444-444444444444","contract_id":"c2222222-2222-2222-2222-222222222222","amount":260000,"status":"completed"}',
 '2026-07-05T09:00:00+08:00', '2026-07-12T09:00:00+08:00')
ON CONFLICT (id) DO NOTHING;

-- ============ 回款计划 ============
INSERT INTO crm.particles (id, tenant_id, type, slug, title, state, payload, created_at, updated_at) VALUES
('91111111-1111-1111-1111-111111111111', 'system', 'CRM_PAYMENT_PLAN', 'plan-contracted-1',
 '食品礼盒框架-首付款', 'pending',
 '{"contract_id":"c1111111-1111-1111-1111-111111111111","plan_amount":500000,"plan_end":"2026-08-15","plan_status":"pending"}',
 '2026-08-01T09:00:00+08:00', '2026-08-01T09:00:00+08:00')
ON CONFLICT (id) DO NOTHING;

INSERT INTO crm.particles (id, tenant_id, type, slug, title, state, payload, created_at, updated_at) VALUES
('92222222-2222-2222-2222-222222222222', 'system', 'CRM_PAYMENT_PLAN', 'plan-paid-1',
 '年报精装-全款', 'done',
 '{"contract_id":"c2222222-2222-2222-2222-222222222222","plan_amount":260000,"plan_end":"2026-07-20","plan_status":"done"}',
 '2026-07-01T09:00:00+08:00', '2026-07-20T09:00:00+08:00')
ON CONFLICT (id) DO NOTHING;

-- ============ 回款记录 ============
INSERT INTO crm.particles (id, tenant_id, type, slug, title, state, payload, created_at, updated_at) VALUES
('93333333-3333-3333-3333-333333333333', 'system', 'CRM_PAYMENT_RECORD', 'pay-paid-1',
 '年报精装回款', 'recorded',
 '{"contract_id":"c2222222-2222-2222-2222-222222222222","paid_amount":260000,"paid_at":"2026-07-19T09:00:00+08:00","voucher":"https://example.com/voucher/HT-2026-002.pdf"}',
 '2026-07-19T09:00:00+08:00', '2026-07-19T09:00:00+08:00')
ON CONFLICT (id) DO NOTHING;

-- ============ 发票 ============
INSERT INTO crm.particles (id, tenant_id, type, slug, title, state, payload, created_at, updated_at) VALUES
('94444444-4444-4444-4444-444444444444', 'system', 'CRM_INVOICE', 'invoice-paid-1',
 '年报精装发票', 'reconciled',
 '{"invoice_no":"INV-2026-002","invoice_type":"增值税专用发票","invoice_amount":260000,"invoice_date":"2026-07-08","contract_id":"c2222222-2222-2222-2222-222222222222","reconcile_status":"reconciled"}',
 '2026-07-08T09:00:00+08:00', '2026-07-19T09:00:00+08:00')
ON CONFLICT (id) DO NOTHING;

-- ============ 关系边（受控谓词，igraph 用）============
-- 客户 → 联系人（关键联系人）
INSERT INTO crm.edges (id, tenant_id, source_type, source_id, edge_type, target_type, target_id, meta, created_at) VALUES
('e1111111-1111-1111-1111-111111111111', 'system', 'CRM_ACCOUNT', 'a1111111-1111-1111-1111-111111111101', 'key_contact', 'CRM_CONTACT', 'a2222222-2222-2222-2222-222222222201', '{}', '2026-06-02T10:00:00+08:00')
ON CONFLICT (id) DO NOTHING;

-- 商机 → 客户（归属）
INSERT INTO crm.edges (id, tenant_id, source_type, source_id, edge_type, target_type, target_id, meta, created_at) VALUES
('e2222222-2222-2222-2222-222222222221', 'system', 'CRM_DEAL', 'd1111111-1111-1111-1111-111111111111', 'belongs_to', 'CRM_ACCOUNT', 'a1111111-1111-1111-1111-111111111101', '{}', '2026-08-18T09:00:00+08:00')
ON CONFLICT (id) DO NOTHING;
INSERT INTO crm.edges (id, tenant_id, source_type, source_id, edge_type, target_type, target_id, meta, created_at) VALUES
('e2222222-2222-2222-2222-222222222222', 'system', 'CRM_DEAL', 'd2222222-2222-2222-2222-222222222222', 'belongs_to', 'CRM_ACCOUNT', 'a1111111-1111-1111-1111-111111111101', '{}', '2026-05-20T09:00:00+08:00')
ON CONFLICT (id) DO NOTHING;
INSERT INTO crm.edges (id, tenant_id, source_type, source_id, edge_type, target_type, target_id, meta, created_at) VALUES
('e2222222-2222-2222-2222-222222222223', 'system', 'CRM_DEAL', 'd3333333-3333-3333-3333-333333333333', 'belongs_to', 'CRM_ACCOUNT', 'a1111111-1111-1111-1111-111111111101', '{}', '2026-06-10T09:00:00+08:00')
ON CONFLICT (id) DO NOTHING;
INSERT INTO crm.edges (id, tenant_id, source_type, source_id, edge_type, target_type, target_id, meta, created_at) VALUES
('e2222222-2222-2222-2222-222222222224', 'system', 'CRM_DEAL', 'd4444444-4444-4444-4444-444444444444', 'belongs_to', 'CRM_ACCOUNT', 'a1111111-1111-1111-1111-111111111101', '{}', '2026-06-15T09:00:00+08:00')
ON CONFLICT (id) DO NOTHING;

-- 赢单商机 → 技术方案（has_technical_proposal；D-quoted 故意不挂 → 无方案断裂语义）
INSERT INTO crm.edges (id, tenant_id, source_type, source_id, edge_type, target_type, target_id, meta, created_at) VALUES
('e3333333-3333-3333-3333-333333333333', 'system', 'CRM_DEAL', 'd3333333-3333-3333-3333-333333333333', 'has_technical_proposal', 'CRM_TECHNICAL_PROPOSAL', 'b1111111-1111-1111-1111-111111111111', '{}', '2026-07-20T09:00:00+08:00')
ON CONFLICT (id) DO NOTHING;

-- 报价 → 商机（引用）
INSERT INTO crm.edges (id, tenant_id, source_type, source_id, edge_type, target_type, target_id, meta, created_at) VALUES
('e4444444-4444-4444-4444-444444444441', 'system', 'CRM_QUOTATION', 'f1111111-1111-1111-1111-111111111111', 'referenced_in', 'CRM_DEAL', 'd3333333-3333-3333-3333-333333333333', '{}', '2026-07-22T09:00:00+08:00')
ON CONFLICT (id) DO NOTHING;
INSERT INTO crm.edges (id, tenant_id, source_type, source_id, edge_type, target_type, target_id, meta, created_at) VALUES
('e4444444-4444-4444-4444-444444444442', 'system', 'CRM_QUOTATION', 'f2222222-2222-2222-2222-222222222222', 'referenced_in', 'CRM_DEAL', 'd4444444-4444-4444-4444-444444444444', '{}', '2026-06-25T09:00:00+08:00')
ON CONFLICT (id) DO NOTHING;

-- 合同 → 商机 / 报价（引用）
INSERT INTO crm.edges (id, tenant_id, source_type, source_id, edge_type, target_type, target_id, meta, created_at) VALUES
('e5555555-5555-5555-5555-555555555551', 'system', 'CRM_CONTRACT', 'c1111111-1111-1111-1111-111111111111', 'referenced_in', 'CRM_DEAL', 'd3333333-3333-3333-3333-333333333333', '{}', '2026-08-01T09:00:00+08:00')
ON CONFLICT (id) DO NOTHING;
INSERT INTO crm.edges (id, tenant_id, source_type, source_id, edge_type, target_type, target_id, meta, created_at) VALUES
('e5555555-5555-5555-5555-555555555552', 'system', 'CRM_CONTRACT', 'c1111111-1111-1111-1111-111111111111', 'referenced_in', 'CRM_QUOTATION', 'f1111111-1111-1111-1111-111111111111', '{}', '2026-08-01T09:00:00+08:00')
ON CONFLICT (id) DO NOTHING;
INSERT INTO crm.edges (id, tenant_id, source_type, source_id, edge_type, target_type, target_id, meta, created_at) VALUES
('e5555555-5555-5555-5555-555555555553', 'system', 'CRM_CONTRACT', 'c2222222-2222-2222-2222-222222222222', 'referenced_in', 'CRM_DEAL', 'd4444444-4444-4444-4444-444444444444', '{}', '2026-07-01T09:00:00+08:00')
ON CONFLICT (id) DO NOTHING;
INSERT INTO crm.edges (id, tenant_id, source_type, source_id, edge_type, target_type, target_id, meta, created_at) VALUES
('e5555555-5555-5555-5555-555555555554', 'system', 'CRM_CONTRACT', 'c2222222-2222-2222-2222-222222222222', 'referenced_in', 'CRM_QUOTATION', 'f2222222-2222-2222-2222-222222222222', '{}', '2026-07-01T09:00:00+08:00')
ON CONFLICT (id) DO NOTHING;

-- 订单 → 合同 / 商机（引用）
INSERT INTO crm.edges (id, tenant_id, source_type, source_id, edge_type, target_type, target_id, meta, created_at) VALUES
('e6666666-6666-6666-6666-666666666661', 'system', 'CRM_ORDER', 'b2111111-1111-1111-1111-111111111111', 'referenced_in', 'CRM_CONTRACT', 'c1111111-1111-1111-1111-111111111111', '{}', '2026-08-05T09:00:00+08:00')
ON CONFLICT (id) DO NOTHING;
INSERT INTO crm.edges (id, tenant_id, source_type, source_id, edge_type, target_type, target_id, meta, created_at) VALUES
('e6666666-6666-6666-6666-666666666662', 'system', 'CRM_ORDER', 'b2111111-1111-1111-1111-111111111111', 'referenced_in', 'CRM_DEAL', 'd3333333-3333-3333-3333-333333333333', '{}', '2026-08-05T09:00:00+08:00')
ON CONFLICT (id) DO NOTHING;
INSERT INTO crm.edges (id, tenant_id, source_type, source_id, edge_type, target_type, target_id, meta, created_at) VALUES
('e6666666-6666-6666-6666-666666666663', 'system', 'CRM_ORDER', 'b2222222-2222-2222-2222-222222222222', 'referenced_in', 'CRM_CONTRACT', 'c2222222-2222-2222-2222-222222222222', '{}', '2026-07-05T09:00:00+08:00')
ON CONFLICT (id) DO NOTHING;
INSERT INTO crm.edges (id, tenant_id, source_type, source_id, edge_type, target_type, target_id, meta, created_at) VALUES
('e6666666-6666-6666-6666-666666666664', 'system', 'CRM_ORDER', 'b2222222-2222-2222-2222-222222222222', 'referenced_in', 'CRM_DEAL', 'd4444444-4444-4444-4444-444444444444', '{}', '2026-07-05T09:00:00+08:00')
ON CONFLICT (id) DO NOTHING;

-- 回款计划 → 合同（引用）
INSERT INTO crm.edges (id, tenant_id, source_type, source_id, edge_type, target_type, target_id, meta, created_at) VALUES
('e7777777-7777-7777-7777-777777777771', 'system', 'CRM_PAYMENT_PLAN', '91111111-1111-1111-1111-111111111111', 'referenced_in', 'CRM_CONTRACT', 'c1111111-1111-1111-1111-111111111111', '{}', '2026-08-01T09:00:00+08:00')
ON CONFLICT (id) DO NOTHING;
INSERT INTO crm.edges (id, tenant_id, source_type, source_id, edge_type, target_type, target_id, meta, created_at) VALUES
('e7777777-7777-7777-7777-777777777772', 'system', 'CRM_PAYMENT_PLAN', '92222222-2222-2222-2222-222222222222', 'referenced_in', 'CRM_CONTRACT', 'c2222222-2222-2222-2222-222222222222', '{}', '2026-07-01T09:00:00+08:00')
ON CONFLICT (id) DO NOTHING;

-- 回款记录 → 合同（引用）
INSERT INTO crm.edges (id, tenant_id, source_type, source_id, edge_type, target_type, target_id, meta, created_at) VALUES
('e8888888-8888-8888-8888-888888888881', 'system', 'CRM_PAYMENT_RECORD', '93333333-3333-3333-3333-333333333333', 'referenced_in', 'CRM_CONTRACT', 'c2222222-2222-2222-2222-222222222222', '{}', '2026-07-19T09:00:00+08:00')
ON CONFLICT (id) DO NOTHING;

-- 发票 → 合同（引用）
INSERT INTO crm.edges (id, tenant_id, source_type, source_id, edge_type, target_type, target_id, meta, created_at) VALUES
('e9999999-9999-9999-9999-999999999991', 'system', 'CRM_INVOICE', '94444444-4444-4444-4444-444444444444', 'referenced_in', 'CRM_CONTRACT', 'c2222222-2222-2222-2222-222222222222', '{}', '2026-07-08T09:00:00+08:00')
ON CONFLICT (id) DO NOTHING;

-- ============ 决策场景字典（§6 决策事件主轴；业务库 plm 8 行事实源，幂等补齐测试库/重建）============
-- 唯一事实源：docs/specs/2026-08-25-ai-native-crm-overall-design.md §6.5 决策场景配置表（8 场景），
-- 与 db/schema.sql crm.decision_scenario 列定义对齐；PK=(scenario_id, tenant_id)（2026-09-05 G5 复合化），
-- ON CONFLICT (scenario_id, tenant_id) DO NOTHING 重跑安全。tenant_id 走列默认 'system'（平台模板）。
INSERT INTO crm.decision_scenario
  (scenario_id, stage, description, trigger, methodology_ids, eval_dimensions, default_tier, autonomous_allowed) VALUES
('LEAD_FOLLOW_UP', '一、线索', '新线索跟不跟/升级/放弃/培育',
 '{"cond":{"event":"created","stage":"lead"},"entity":"DEAL","source":"particle_event"}'::jsonb,
 ARRAY['BANT','MEDDICC','OPP_MATRIX'],
 '[{"cond":"industry_fit","label":"行业匹配","weight":0.2},{"cond":"budget_cycle","label":"预算周期","weight":0.2},{"cond":"pain_clear","label":"痛点清晰","weight":0.2},{"cond":"contact_level","label":"对接人级别","weight":0.2},{"cond":"our_fit","label":"我方适配","weight":0.2},{"cond":"identity_dedup","label":"CRM主体查重","weight":0.15},{"cond":"governance_approval","label":"线索分级审批权限","weight":0.15},{"cond":"time_window","label":"跟进时间窗","weight":0.1}]'::jsonb,
 'LEAD', TRUE),
('OPP_QUALIFY', '二、机会评估', '真机会/伪需求/陪标/加资源',
 '{"cond":{"event":"qualify","stage":"opportunity"},"entity":"DEAL","source":"particle_event"}'::jsonb,
 ARRAY['MEDDICC','OPP_MATRIX','ROLE_MAP'],
 '[{"cond":"pain_source","label":"痛点来源","weight":0.2},{"cond":"budget_approved","label":"预算获批","weight":0.2},{"cond":"decision_chain","label":"决策链完整","weight":0.2},{"cond":"competition","label":"竞品进展","weight":0.2},{"cond":"win_prob","label":"赢率","weight":0.2},{"cond":"identity_dedup","label":"CRM主体查重","weight":0.15},{"cond":"governance_approval","label":"机会分级审批","weight":0.15},{"cond":"time_window","label":"评估时间窗","weight":0.1}]'::jsonb,
 'NORMAL', FALSE),
('CLIENT_STRATEGY', '三、客户策略', '主攻角色/支持者-中立-反对者策略',
 '{"cond":{"event":"client_strategy_due","stage":"opportunity"},"entity":"DEAL","source":"particle_event"}'::jsonb,
 ARRAY['ROLE_MAP','FACT_VS_TALK','MEDDICC'],
 '[{"cond":"role_identified","label":"关键人识别","weight":0.2},{"cond":"decision_chain","label":"决策链图谱","weight":0.2},{"cond":"support_stance","label":"支持者真实立场","weight":0.2},{"cond":"oppose_stance","label":"反对者真实立场","weight":0.2},{"cond":"role_change","label":"人事时效","weight":0.1},{"cond":"governance_auth","label":"角色权限治理","weight":0.1}]'::jsonb,
 'NORMAL', FALSE),
('SOLUTION_VALUE', '四、方案价值', '方案取舍/定制边界/差异化',
 '{"cond":{"event":"solution_due","stage":"quoted"},"entity":"DEAL","source":"particle_event"}'::jsonb,
 ARRAY['OPP_MATRIX','RISK_TRADEOFF'],
 '[{"cond":"need_covered","label":"刚需覆盖","weight":0.34},{"cond":"custom_cost","label":"定制成本>毛利","weight":0.33},{"cond":"diff_bind","label":"差异化绑定指标","weight":0.33},{"cond":"governance_approval","label":"方案变更审批","weight":0.15},{"cond":"time_window","label":"方案输出时间窗","weight":0.1}]'::jsonb,
 'NORMAL', FALSE),
('QUOTE_PRICING', '五、商务报价', '三级报价/折扣换条件/让步边界/付款风险',
 '{"cond":{"event":"quote_submit","stage":"quoted"},"entity":"DEAL","source":"particle_event"}'::jsonb,
 ARRAY['RISK_TRADEOFF','STOP_LOSS'],
 '[{"cond":"price_vs_floor","label":"开盘/目标/底价对比","weight":0.25},{"cond":"discount_condition","label":"折扣对等条件","weight":0.2},{"cond":"pay_ratio","label":"付款比例","weight":0.2},{"cond":"warranty","label":"维保","weight":0.15},{"cond":"accept_quant","label":"验收量化","weight":0.1},{"cond":"margin_redline","label":"毛利红线","weight":0.1},{"cond":"identity_dedup","label":"客户主体查重","weight":0.1},{"cond":"time_window","label":"报价有效期","weight":0.1}]'::jsonb,
 'HIGH', FALSE),
('SIGN_RISK', '六、签单前风险', '风险可控/卡住策略',
 '{"cond":{"event":"opposition_appears","stage":"contracted"},"entity":"DEAL","source":"particle_event"}'::jsonb,
 ARRAY['RISK_TRADEOFF','STOP_LOSS'],
 '[{"cond":"opposer_level","label":"反对者级别","weight":0.2},{"cond":"change_volume","label":"需求变更量","weight":0.2},{"cond":"delivery_staff","label":"交付人力","weight":0.2},{"cond":"accept_std","label":"验收标准","weight":0.2},{"cond":"budget_approved","label":"预算获批","weight":0.1},{"cond":"biz_status","label":"经营状况","weight":0.1},{"cond":"governance_approval","label":"签单风险审批","weight":0.15},{"cond":"time_window","label":"签单时间窗","weight":0.1}]'::jsonb,
 'HIGH', FALSE),
('POST_CONTRACT', '七、终局决策', '需求变更/回款策略/续约/丢单孵化放弃',
 '{"cond":{"event":"post_contract","stage":"ordered"},"entity":"DEAL","source":"particle_event"}'::jsonb,
 ARRAY['RISK_TRADEOFF','OPP_MATRIX'],
 '[{"cond":"contract_scope","label":"合同范围","weight":0.25},{"cond":"impl_load","label":"实施负荷","weight":0.25},{"cond":"overdue_reason","label":"逾期原因","weight":0.25},{"cond":"renew_value","label":"续约价值","weight":0.15},{"cond":"satisfaction","label":"满意度","weight":0.1},{"cond":"governance_approval","label":"回款/变更审批","weight":0.15},{"cond":"time_window","label":"回款时间窗","weight":0.1}]'::jsonb,
 'NORMAL', TRUE),
('LOSS_REVIEW', '八、丢单复盘', '放弃/长期孵化',
 '{"cond":{"event":"created","stage":"lost"},"entity":"DEAL","source":"particle_event"}'::jsonb,
 ARRAY['FACT_VS_TALK','OPP_MATRIX'],
 '[{"cond":"future_budget","label":"未来1-2年预算","weight":0.2},{"cond":"pain_longterm","label":"痛点长期性","weight":0.2},{"cond":"internal_supporter","label":"内部支持者","weight":0.2},{"cond":"strategic_value","label":"战略价值","weight":0.2},{"cond":"coach_fact","label":"Coach真实情报","weight":0.2},{"cond":"identity_dedup","label":"主体查重","weight":0.15},{"cond":"governance_approval","label":"放弃审批","weight":0.15},{"cond":"time_window","label":"放弃时间窗","weight":0.1}]'::jsonb,
 'LEAD', TRUE),
('DEAL_REOPEN', '商机重开', '输单/丢单后客户回流，重开并重置止损线',
 '{"cond":{"event":"reopen","stage":"S2"},"entity":"DEAL","source":"particle_event"}'::jsonb,
 ARRAY['STOP_LOSS'],
 '[{"cond":"condition","label":"重开止损条件","weight":1,"required":true},{"cond":"deadline","label":"重开止损期限","weight":0.5}]'::jsonb,
 'NORMAL', TRUE),
('ATTR_SCHEMA_CHANGE', 'meta', '粒子属性元模型配置变更（新增/启用/改权限/改控件）',
 '{"action":["data-particle-attr-update"]}'::jsonb,
 ARRAY[]::TEXT[],
 '[{"cond":"impact","label":"影响面","weight":1,"required":true},{"cond":"consistency","label":"与既有数据一致性","weight":1,"required":true},{"cond":"permission","label":"字段权限","weight":1,"required":true}]'::jsonb,
 'HIGH', FALSE),
('CALIBRATION_CHANGE', 'meta', '决策引擎校准参数变更（阈值/权重）',
 '{"action":["calibration-patch-apply"]}'::jsonb,
 ARRAY[]::TEXT[],
 '[{"cond":"impact","label":"影响面","weight":1,"required":true},{"cond":"evidence","label":"证据充分性","weight":1,"required":true},{"cond":"rollback","label":"可回滚性","weight":1,"required":true}]'::jsonb,
 'HIGH', FALSE),
('EXTERNAL_ENRICHMENT', 'meta', '外部数据自动采集（连接器写客户，connector-enrich/conn-zhizao-verify 第0闸载体）',
 '{"action":["conn-attio-enrich-account","conn-zhizao-verify-account"]}'::jsonb,
 ARRAY[]::TEXT[],
 '[{"cond":"source_legit","label":"来源合规（外部连接器身份）","weight":1,"required":true},{"cond":"data_origin","label":"数据落唯一事实字段（不覆盖人工）","weight":1,"required":true},{"cond":"approval","label":"对外部写已授权（admin/sysadmin 显式触发）","weight":1,"required":true}]'::jsonb,
 'HIGH', FALSE),
-- 以下 4 场景（2026-09-03 T5）：补全发票/订单/评审把关/批量导入的 autoDecision 第0闸锚定场景；
-- 均为财务/闸门/批量高风险写，tier=HIGH + autonomous_allowed=FALSE 强制人工复核（与 QUOTE_PRICING/SIGN_RISK 一致）。
('INVOICE_APPROVE', '七、回款开票', '发票开具/提交/核销的财务合规与超合同校验',
 '{"cond":{"event":"invoice_submit","stage":"invoiced"},"entity":"INVOICE","source":"particle_event"}'::jsonb,
 ARRAY['RISK_TRADEOFF','STOP_LOSS'],
 '[{"cond":"amount_vs_contract","label":"开票金额≤合同金额","weight":0.25},{"cond":"discount_condition","label":"折扣对等条件","weight":0.2},{"cond":"pay_ratio","label":"付款比例","weight":0.2},{"cond":"margin_redline","label":"毛利红线","weight":0.1},{"cond":"identity_dedup","label":"客户主体查重","weight":0.1},{"cond":"governance_approval","label":"开票审批权限","weight":0.15},{"cond":"time_window","label":"开票有效期","weight":0.1}]'::jsonb,
 'HIGH', FALSE),
('ORDER_APPROVE', '七、订单交付', '订单创建/提交/推进的交付与回款承诺校验',
 '{"cond":{"event":"order_submit","stage":"ordered"},"entity":"ORDER","source":"particle_event"}'::jsonb,
 ARRAY['RISK_TRADEOFF','STOP_LOSS'],
 '[{"cond":"contract_scope","label":"合同范围一致","weight":0.25},{"cond":"impl_load","label":"实施负荷","weight":0.2},{"cond":"budget_approved","label":"预算获批","weight":0.15},{"cond":"accept_std","label":"验收标准","weight":0.15},{"cond":"governance_approval","label":"订单审批权限","weight":0.15},{"cond":"time_window","label":"订单时效","weight":0.1}]'::jsonb,
 'HIGH', FALSE),
('REVIEW_GATE', 'S4→S5 评审把关', '双闸门评审（报价复核+合同确认）放行落库',
 '{"cond":{"event":"review_gate","stage":"quoted"},"entity":"DEAL","source":"particle_event"}'::jsonb,
 ARRAY['RISK_TRADEOFF'],
 '[{"cond":"arch_compliance","label":"架构合规","weight":0.34},{"cond":"sec_compliance","label":"安全合规","weight":0.33},{"cond":"func_coverage","label":"功能覆盖","weight":0.33},{"cond":"governance_approval","label":"评审把关审批","weight":0.15},{"cond":"time_window","label":"评审时效","weight":0.1}]'::jsonb,
 'HIGH', FALSE),
('IMPORT_BATCH', 'T3 批量导入', '批量 upsert 写的数据来源/结构/幂等校验',
 '{"cond":{"event":"import_batch","stage":"import"},"entity":"PARTICLE","source":"particle_event"}'::jsonb,
 ARRAY[]::TEXT[],
 '[{"cond":"data_origin","label":"数据来源合规","weight":0.34},{"cond":"schema_valid","label":"字段结构合法","weight":0.33},{"cond":"dup_policy","label":"幂等/去重策略","weight":0.33},{"cond":"governance_approval","label":"导入审批","weight":0.15},{"cond":"time_window","label":"导入窗口","weight":0.1}]'::jsonb,
 'HIGH', FALSE),
-- PARTICLE_CREATE（2026-09-04）：MCP/对话通道经 data-particle-create 建档（客户/商机/合同等主数据）
--   第 0 闸锚定载体——无此场景则 MCP 侧 mint 无落点，写操作退化为「无决策写入」（决策链断裂）。
--   tier=NORMAL + autonomous_allowed=TRUE：硬人工闸门已由 gateway 两阶段 confirm_token 承担，
--   自治与否交 autonomyEngine 按置信度/先例判定（禁硬编码，走配置）。
('PARTICLE_CREATE', 'meta', 'MCP/对话通道粒子建档（客户/商机/合同等主数据创建）',
 '{"action":["data-particle-create"]}'::jsonb,
 ARRAY[]::TEXT[],
 '[{"cond":"data_origin","label":"数据来源与字段合法","weight":0.34},{"cond":"identity_dedup","label":"主体查重（不重复建档）","weight":0.33},{"cond":"ownership","label":"归属完整（named_owner 必填）","weight":0.33},{"cond":"governance_approval","label":"人工确认","weight":0.15}]'::jsonb,
 'NORMAL', TRUE),
-- PARTICLE_UPDATE（2026-09-09）：MCP/对话通道粒子事实变更（字段级并入，禁删）。
--   第 0 闸锚定载体——无此场景则 gateway mint 抛「未知决策场景」，写操作退回 DECISION_NEEDED
--   （fail-safe，绝不无决策放行），MCP 侧事实变更永久不可用。
--   tier=NORMAL + autonomous_allowed=TRUE：硬人工闸门已由 gateway 两阶段 confirm_token 承担，
--   自治与否交 autonomyEngine 按置信度/先例判定（禁硬编码，走配置）。
('PARTICLE_UPDATE', 'meta', 'MCP/对话通道粒子事实变更（字段级并入，禁删）',
 '{"action":["data-particle-update"]}'::jsonb,
 ARRAY[]::TEXT[],
 '[{"cond":"data_origin","label":"数据来源与字段合法","weight":0.34},{"cond":"identity_dedup","label":"目标唯一（id 精确定位）","weight":0.33},{"cond":"ownership","label":"归属完整（同租户）","weight":0.33},{"cond":"governance_approval","label":"人工确认","weight":0.15}]'::jsonb,
 'NORMAL', TRUE),
-- REQUIREMENT_COLLECT（2026-09-09）：followup-agent 跟进时采集 SHOULD/NICE 需求维度证据（REQUIREMENT 方法论，auto 来源）
--   第 0 闸锚定载体——collectFollowupRequirement 写 CRM_METHODOLOGY_EVIDENCE 经 autoDecision mint；
--   无此场景则 mint 抛「未知决策场景」，证据采集退回 DECISION_NEEDED。tier=NORMAL + autonomous_allowed=TRUE：
--   硬人工闸门由 approval 流程承担，自治与否交 autonomyEngine 按配置判定（与 PARTICLE_UPDATE 同构）。
('REQUIREMENT_COLLECT', 'meta', '跟进采集 SHOULD/NICE 需求维度证据（REQUIREMENT 方法论，auto 来源）',
 '{"action":["crm-followup-requirement-collect"]}'::jsonb,
 ARRAY['REQUIREMENT'],
 '[{"cond":"requirement_evidence_ref","label":"证据出处（auto 来源须带 evidence_ref）","weight":0.5},{"cond":"requirement_met","label":"维度满足判据","weight":0.5}]'::jsonb,
 'NORMAL', TRUE)
ON CONFLICT (scenario_id, tenant_id) DO NOTHING;

-- ============ A+B：8 销售场景差异化评分配置（2026-09-04 用户拍板：销售场景不强制全 9 尺子）============
-- focus_rulers    = 聚焦尺子 ×1.5 加权（场景主线尺子）
-- rubric_pass_line = 场景及格线（ratio 低于此判 poor/warn）
-- enabled_rulers  = 真子集白名单：非空时只跑列出的尺子，其余不计入总分；NULL/空 = 跑全 9 尺子（meta/财务场景保持 NULL）
-- 重跑安全：行已存在则 UPDATE，不存在则跳过（WHERE 命中）。
UPDATE crm.decision_scenario AS t SET
  focus_rulers     = v.focus_rulers,
  rubric_pass_line = v.rubric_pass_line,
  enabled_rulers   = v.enabled_rulers
FROM (VALUES
  ('LEAD_FOLLOW_UP', '[{"key":"clarity","weight":1.5},{"key":"relevance","weight":1.5}]'::jsonb, 0.50,
    '["clarity","relevance","logic","importance"]'::jsonb),
  ('OPP_QUALIFY',    '[{"key":"relevance","weight":1.5},{"key":"depth","weight":1.5}]'::jsonb, 0.60,
    '["relevance","depth","logic","breadth","importance"]'::jsonb),
  ('CLIENT_STRATEGY','[{"key":"breadth","weight":1.5},{"key":"depth","weight":1.5}]'::jsonb, 0.60,
    '["breadth","depth","logic","relevance","importance"]'::jsonb),
  ('SOLUTION_VALUE', '[{"key":"relevance","weight":1.5},{"key":"logic","weight":1.5}]'::jsonb, 0.60,
    '["relevance","logic","depth","precision","importance"]'::jsonb),
  ('QUOTE_PRICING',  '[{"key":"precision","weight":1.5},{"key":"relevance","weight":1.5}]'::jsonb, 0.65,
    '["precision","relevance","logic","importance","clarity"]'::jsonb),
  ('SIGN_RISK',     '[{"key":"depth","weight":1.5},{"key":"breadth","weight":1.5}]'::jsonb, 0.65,
    '["depth","breadth","logic","relevance","importance"]'::jsonb),
  ('POST_CONTRACT',  '[{"key":"logic","weight":1.5},{"key":"relevance","weight":1.5}]'::jsonb, 0.60,
    '["logic","relevance","depth","importance"]'::jsonb),
  ('LOSS_REVIEW',    '[{"key":"breadth","weight":1.5},{"key":"depth","weight":1.5}]'::jsonb, 0.55,
    '["breadth","depth","logic","relevance","importance","fairness"]'::jsonb)
) AS v(scenario_id, focus_rulers, rubric_pass_line, enabled_rulers)
WHERE t.scenario_id = v.scenario_id;

-- 审批流配置种子（item 17，G21 四审批域；与引擎粒子模型脱节属已知限制）
-- 审批流配置种子（item 17，G21 五审批域；方案 A 2026-08-31 接通运行态引擎）
-- 说明：crm.approval_flow 表降级为只读兼容/审计（表结构保留）；运行态事实源为 CRM_APPROVAL_* 粒子（配置页直写）。
INSERT INTO crm.approval_flow (flow_id, name, description, stages, enabled) VALUES
  ('deal', '商机审批流', '商机推进至赢单前的两级审批',
   '[{"stage":1,"role":"manager","action":"approve","auto_allowed":false},{"stage":2,"role":"admin","action":"approve","auto_allowed":false}]'::jsonb, TRUE),
  ('quote', '报价审批流', '报价单发出前审批',
   '[{"stage":1,"role":"presales","action":"approve","auto_allowed":false},{"stage":2,"role":"manager","action":"approve","auto_allowed":false}]'::jsonb, TRUE),
  ('contract', '合同审批流', '合同签署前审批',
   '[{"stage":1,"role":"sales","action":"approve","auto_allowed":false},{"stage":2,"role":"contract_admin","action":"approve","auto_allowed":false}]'::jsonb, TRUE),
  ('invoice', '发票审批流', '发票开具前审批',
   '[{"stage":1,"role":"sales","action":"approve","auto_allowed":false},{"stage":2,"role":"finance","action":"approve","auto_allowed":false}]'::jsonb, TRUE),
  ('order', '订单审批流', '订单草稿至确认前的两级审批',
   '[{"stage":1,"role":"sales","action":"approve","auto_allowed":false},{"stage":2,"role":"manager","action":"approve","auto_allowed":false}]'::jsonb, TRUE)
ON CONFLICT (flow_id) DO UPDATE SET
  name=EXCLUDED.name, description=EXCLUDED.description, stages=EXCLUDED.stages, enabled=EXCLUDED.enabled, updated_at=now();

-- 运行态审批流粒子种子（CRM_APPROVAL_*；与 crm.approval_flow 同源 stages，domain 对齐；固定 UUID 幂等）
INSERT INTO crm.particles (id, tenant_id, type, slug, title, state, payload, created_at, updated_at) VALUES
  ('af000001-0000-0000-0000-000000000101', 'system', 'CRM_APPROVAL_FLOW', 'approval-flow-deal', '商机审批流', 'ACTIVE', '{"name":"商机审批流","enabled":true,"domain":"deal","description":"商机推进至赢单前的两级审批","stages":[{"stage":1,"role":"manager","action":"approve","auto_allowed":false},{"stage":2,"role":"admin","action":"approve","auto_allowed":false}],"versions":[]}'::jsonb, now(), now()),
  ('af000001-0000-0000-0000-000000000111', 'system', 'CRM_APPROVAL_NODE', 'node', '开始', 'ACTIVE', '{"flow_id":"af000001-0000-0000-0000-000000000101","node_type":"START","name":"开始","pos":0}'::jsonb, now(), now()),
  ('af000001-0000-0000-0000-000000000112', 'system', 'CRM_APPROVAL_NODE', 'node', '1', 'ACTIVE', '{"flow_id":"af000001-0000-0000-0000-000000000101","node_type":"APPROVER","name":"1","pos":1}'::jsonb, now(), now()),
  ('af000001-0000-0000-0000-000000000113', 'system', 'CRM_APPROVAL_NODE', 'node', '2', 'ACTIVE', '{"flow_id":"af000001-0000-0000-0000-000000000101","node_type":"APPROVER","name":"2","pos":2}'::jsonb, now(), now()),
  ('af000001-0000-0000-0000-000000000114', 'system', 'CRM_APPROVAL_NODE', 'node', '结束', 'ACTIVE', '{"flow_id":"af000001-0000-0000-0000-000000000101","node_type":"END","name":"结束","pos":3}'::jsonb, now(), now()),
  ('af000001-0000-0000-0000-000000000121', 'system', 'CRM_APPROVAL_APPROVER', 'approver', 'manager', 'ACTIVE', '{"node_id":"af000001-0000-0000-0000-000000000112","approver_type":"ROLE","role":"manager","multi_approver_mode":"ANY","empty_approver_action":"ASSIGN_ADMIN","same_submitter_action":"ALLOW","approver_direction":"BOTTOM_UP","cc_list":[],"field_permissions":{},"pass_post_config":{},"reject_post_config":{}}'::jsonb, now(), now()),
  ('af000001-0000-0000-0000-000000000122', 'system', 'CRM_APPROVAL_APPROVER', 'approver', 'admin', 'ACTIVE', '{"node_id":"af000001-0000-0000-0000-000000000113","approver_type":"ROLE","role":"admin","multi_approver_mode":"ANY","empty_approver_action":"ASSIGN_ADMIN","same_submitter_action":"ALLOW","approver_direction":"BOTTOM_UP","cc_list":[],"field_permissions":{},"pass_post_config":{},"reject_post_config":{}}'::jsonb, now(), now()),
  ('af000001-0000-0000-0000-000000000131', 'system', 'CRM_APPROVAL_LINK', 'link', 'link', 'ACTIVE', '{"from_node":"af000001-0000-0000-0000-000000000111","to_node":"af000001-0000-0000-0000-000000000112","condition_ref":null}'::jsonb, now(), now()),
  ('af000001-0000-0000-0000-000000000132', 'system', 'CRM_APPROVAL_LINK', 'link', 'link', 'ACTIVE', '{"from_node":"af000001-0000-0000-0000-000000000112","to_node":"af000001-0000-0000-0000-000000000113","condition_ref":null}'::jsonb, now(), now()),
  ('af000001-0000-0000-0000-000000000133', 'system', 'CRM_APPROVAL_LINK', 'link', 'link', 'ACTIVE', '{"from_node":"af000001-0000-0000-0000-000000000113","to_node":"af000001-0000-0000-0000-000000000114","condition_ref":null}'::jsonb, now(), now()),
  ('af000002-0000-0000-0000-000000000101', 'system', 'CRM_APPROVAL_FLOW', 'approval-flow-quote', '报价审批流', 'ACTIVE', '{"name":"报价审批流","enabled":true,"domain":"quote","description":"报价单发出前审批","stages":[{"stage":1,"role":"presales","action":"approve","auto_allowed":false},{"stage":2,"role":"manager","action":"approve","auto_allowed":false}],"versions":[]}'::jsonb, now(), now()),
  ('af000002-0000-0000-0000-000000000111', 'system', 'CRM_APPROVAL_NODE', 'node', '开始', 'ACTIVE', '{"flow_id":"af000002-0000-0000-0000-000000000101","node_type":"START","name":"开始","pos":0}'::jsonb, now(), now()),
  ('af000002-0000-0000-0000-000000000112', 'system', 'CRM_APPROVAL_NODE', 'node', '1', 'ACTIVE', '{"flow_id":"af000002-0000-0000-0000-000000000101","node_type":"APPROVER","name":"1","pos":1}'::jsonb, now(), now()),
  ('af000002-0000-0000-0000-000000000113', 'system', 'CRM_APPROVAL_NODE', 'node', '2', 'ACTIVE', '{"flow_id":"af000002-0000-0000-0000-000000000101","node_type":"APPROVER","name":"2","pos":2}'::jsonb, now(), now()),
  ('af000002-0000-0000-0000-000000000114', 'system', 'CRM_APPROVAL_NODE', 'node', '结束', 'ACTIVE', '{"flow_id":"af000002-0000-0000-0000-000000000101","node_type":"END","name":"结束","pos":3}'::jsonb, now(), now()),
  ('af000002-0000-0000-0000-000000000121', 'system', 'CRM_APPROVAL_APPROVER', 'approver', 'presales', 'ACTIVE', '{"node_id":"af000002-0000-0000-0000-000000000112","approver_type":"ROLE","role":"presales","multi_approver_mode":"ANY","empty_approver_action":"ASSIGN_ADMIN","same_submitter_action":"ALLOW","approver_direction":"BOTTOM_UP","cc_list":[],"field_permissions":{},"pass_post_config":{},"reject_post_config":{}}'::jsonb, now(), now()),
  ('af000002-0000-0000-0000-000000000122', 'system', 'CRM_APPROVAL_APPROVER', 'approver', 'manager', 'ACTIVE', '{"node_id":"af000002-0000-0000-0000-000000000113","approver_type":"ROLE","role":"manager","multi_approver_mode":"ANY","empty_approver_action":"ASSIGN_ADMIN","same_submitter_action":"ALLOW","approver_direction":"BOTTOM_UP","cc_list":[],"field_permissions":{},"pass_post_config":{},"reject_post_config":{}}'::jsonb, now(), now()),
  ('af000002-0000-0000-0000-000000000131', 'system', 'CRM_APPROVAL_LINK', 'link', 'link', 'ACTIVE', '{"from_node":"af000002-0000-0000-0000-000000000111","to_node":"af000002-0000-0000-0000-000000000112","condition_ref":null}'::jsonb, now(), now()),
  ('af000002-0000-0000-0000-000000000132', 'system', 'CRM_APPROVAL_LINK', 'link', 'link', 'ACTIVE', '{"from_node":"af000002-0000-0000-0000-000000000112","to_node":"af000002-0000-0000-0000-000000000113","condition_ref":null}'::jsonb, now(), now()),
  ('af000002-0000-0000-0000-000000000133', 'system', 'CRM_APPROVAL_LINK', 'link', 'link', 'ACTIVE', '{"from_node":"af000002-0000-0000-0000-000000000113","to_node":"af000002-0000-0000-0000-000000000114","condition_ref":null}'::jsonb, now(), now()),
  ('af000003-0000-0000-0000-000000000101', 'system', 'CRM_APPROVAL_FLOW', 'approval-flow-contract', '合同审批流', 'ACTIVE', '{"name":"合同审批流","enabled":true,"domain":"contract","description":"合同签署前审批","stages":[{"stage":1,"role":"sales","action":"approve","auto_allowed":false},{"stage":2,"role":"contract_admin","action":"approve","auto_allowed":false}],"versions":[]}'::jsonb, now(), now()),
  ('af000003-0000-0000-0000-000000000111', 'system', 'CRM_APPROVAL_NODE', 'node', '开始', 'ACTIVE', '{"flow_id":"af000003-0000-0000-0000-000000000101","node_type":"START","name":"开始","pos":0}'::jsonb, now(), now()),
  ('af000003-0000-0000-0000-000000000112', 'system', 'CRM_APPROVAL_NODE', 'node', '1', 'ACTIVE', '{"flow_id":"af000003-0000-0000-0000-000000000101","node_type":"APPROVER","name":"1","pos":1}'::jsonb, now(), now()),
  ('af000003-0000-0000-0000-000000000113', 'system', 'CRM_APPROVAL_NODE', 'node', '2', 'ACTIVE', '{"flow_id":"af000003-0000-0000-0000-000000000101","node_type":"APPROVER","name":"2","pos":2}'::jsonb, now(), now()),
  ('af000003-0000-0000-0000-000000000114', 'system', 'CRM_APPROVAL_NODE', 'node', '结束', 'ACTIVE', '{"flow_id":"af000003-0000-0000-0000-000000000101","node_type":"END","name":"结束","pos":3}'::jsonb, now(), now()),
  ('af000003-0000-0000-0000-000000000121', 'system', 'CRM_APPROVAL_APPROVER', 'approver', 'sales', 'ACTIVE', '{"node_id":"af000003-0000-0000-0000-000000000112","approver_type":"ROLE","role":"sales","multi_approver_mode":"ANY","empty_approver_action":"ASSIGN_ADMIN","same_submitter_action":"ALLOW","approver_direction":"BOTTOM_UP","cc_list":[],"field_permissions":{},"pass_post_config":{},"reject_post_config":{}}'::jsonb, now(), now()),
  ('af000003-0000-0000-0000-000000000122', 'system', 'CRM_APPROVAL_APPROVER', 'approver', 'contract_admin', 'ACTIVE', '{"node_id":"af000003-0000-0000-0000-000000000113","approver_type":"ROLE","role":"contract_admin","multi_approver_mode":"ANY","empty_approver_action":"ASSIGN_ADMIN","same_submitter_action":"ALLOW","approver_direction":"BOTTOM_UP","cc_list":[],"field_permissions":{},"pass_post_config":{},"reject_post_config":{}}'::jsonb, now(), now()),
  ('af000003-0000-0000-0000-000000000131', 'system', 'CRM_APPROVAL_LINK', 'link', 'link', 'ACTIVE', '{"from_node":"af000003-0000-0000-0000-000000000111","to_node":"af000003-0000-0000-0000-000000000112","condition_ref":null}'::jsonb, now(), now()),
  ('af000003-0000-0000-0000-000000000132', 'system', 'CRM_APPROVAL_LINK', 'link', 'link', 'ACTIVE', '{"from_node":"af000003-0000-0000-0000-000000000112","to_node":"af000003-0000-0000-0000-000000000113","condition_ref":null}'::jsonb, now(), now()),
  ('af000003-0000-0000-0000-000000000133', 'system', 'CRM_APPROVAL_LINK', 'link', 'link', 'ACTIVE', '{"from_node":"af000003-0000-0000-0000-000000000113","to_node":"af000003-0000-0000-0000-000000000114","condition_ref":null}'::jsonb, now(), now()),
  ('af000004-0000-0000-0000-000000000101', 'system', 'CRM_APPROVAL_FLOW', 'approval-flow-invoice', '发票审批流', 'ACTIVE', '{"name":"发票审批流","enabled":true,"domain":"invoice","description":"发票开具前审批","stages":[{"stage":1,"role":"sales","action":"approve","auto_allowed":false},{"stage":2,"role":"finance","action":"approve","auto_allowed":false}],"versions":[]}'::jsonb, now(), now()),
  ('af000004-0000-0000-0000-000000000111', 'system', 'CRM_APPROVAL_NODE', 'node', '开始', 'ACTIVE', '{"flow_id":"af000004-0000-0000-0000-000000000101","node_type":"START","name":"开始","pos":0}'::jsonb, now(), now()),
  ('af000004-0000-0000-0000-000000000112', 'system', 'CRM_APPROVAL_NODE', 'node', '1', 'ACTIVE', '{"flow_id":"af000004-0000-0000-0000-000000000101","node_type":"APPROVER","name":"1","pos":1}'::jsonb, now(), now()),
  ('af000004-0000-0000-0000-000000000113', 'system', 'CRM_APPROVAL_NODE', 'node', '2', 'ACTIVE', '{"flow_id":"af000004-0000-0000-0000-000000000101","node_type":"APPROVER","name":"2","pos":2}'::jsonb, now(), now()),
  ('af000004-0000-0000-0000-000000000114', 'system', 'CRM_APPROVAL_NODE', 'node', '结束', 'ACTIVE', '{"flow_id":"af000004-0000-0000-0000-000000000101","node_type":"END","name":"结束","pos":3}'::jsonb, now(), now()),
  ('af000004-0000-0000-0000-000000000121', 'system', 'CRM_APPROVAL_APPROVER', 'approver', 'sales', 'ACTIVE', '{"node_id":"af000004-0000-0000-0000-000000000112","approver_type":"ROLE","role":"sales","multi_approver_mode":"ANY","empty_approver_action":"ASSIGN_ADMIN","same_submitter_action":"ALLOW","approver_direction":"BOTTOM_UP","cc_list":[],"field_permissions":{},"pass_post_config":{},"reject_post_config":{}}'::jsonb, now(), now()),
  ('af000004-0000-0000-0000-000000000122', 'system', 'CRM_APPROVAL_APPROVER', 'approver', 'finance', 'ACTIVE', '{"node_id":"af000004-0000-0000-0000-000000000113","approver_type":"ROLE","role":"finance","multi_approver_mode":"ANY","empty_approver_action":"ASSIGN_ADMIN","same_submitter_action":"ALLOW","approver_direction":"BOTTOM_UP","cc_list":[],"field_permissions":{},"pass_post_config":{},"reject_post_config":{}}'::jsonb, now(), now()),
  ('af000004-0000-0000-0000-000000000131', 'system', 'CRM_APPROVAL_LINK', 'link', 'link', 'ACTIVE', '{"from_node":"af000004-0000-0000-0000-000000000111","to_node":"af000004-0000-0000-0000-000000000112","condition_ref":null}'::jsonb, now(), now()),
  ('af000004-0000-0000-0000-000000000132', 'system', 'CRM_APPROVAL_LINK', 'link', 'link', 'ACTIVE', '{"from_node":"af000004-0000-0000-0000-000000000112","to_node":"af000004-0000-0000-0000-000000000113","condition_ref":null}'::jsonb, now(), now()),
  ('af000004-0000-0000-0000-000000000133', 'system', 'CRM_APPROVAL_LINK', 'link', 'link', 'ACTIVE', '{"from_node":"af000004-0000-0000-0000-000000000113","to_node":"af000004-0000-0000-0000-000000000114","condition_ref":null}'::jsonb, now(), now()),
  ('af000005-0000-0000-0000-000000000101', 'system', 'CRM_APPROVAL_FLOW', 'approval-flow-order', '订单审批流', 'ACTIVE', '{"name":"订单审批流","enabled":true,"domain":"order","description":"订单草稿至确认前的两级审批","stages":[{"stage":1,"role":"sales","action":"approve","auto_allowed":false},{"stage":2,"role":"manager","action":"approve","auto_allowed":false}],"versions":[]}'::jsonb, now(), now()),
  ('af000005-0000-0000-0000-000000000111', 'system', 'CRM_APPROVAL_NODE', 'node', '开始', 'ACTIVE', '{"flow_id":"af000005-0000-0000-0000-000000000101","node_type":"START","name":"开始","pos":0}'::jsonb, now(), now()),
  ('af000005-0000-0000-0000-000000000112', 'system', 'CRM_APPROVAL_NODE', 'node', '1', 'ACTIVE', '{"flow_id":"af000005-0000-0000-0000-000000000101","node_type":"APPROVER","name":"1","pos":1}'::jsonb, now(), now()),
  ('af000005-0000-0000-0000-000000000113', 'system', 'CRM_APPROVAL_NODE', 'node', '2', 'ACTIVE', '{"flow_id":"af000005-0000-0000-0000-000000000101","node_type":"APPROVER","name":"2","pos":2}'::jsonb, now(), now()),
  ('af000005-0000-0000-0000-000000000114', 'system', 'CRM_APPROVAL_NODE', 'node', '结束', 'ACTIVE', '{"flow_id":"af000005-0000-0000-0000-000000000101","node_type":"END","name":"结束","pos":3}'::jsonb, now(), now()),
  ('af000005-0000-0000-0000-000000000121', 'system', 'CRM_APPROVAL_APPROVER', 'approver', 'sales', 'ACTIVE', '{"node_id":"af000005-0000-0000-0000-000000000112","approver_type":"ROLE","role":"sales","multi_approver_mode":"ANY","empty_approver_action":"ASSIGN_ADMIN","same_submitter_action":"ALLOW","approver_direction":"BOTTOM_UP","cc_list":[],"field_permissions":{},"pass_post_config":{},"reject_post_config":{}}'::jsonb, now(), now()),
  ('af000005-0000-0000-0000-000000000122', 'system', 'CRM_APPROVAL_APPROVER', 'approver', 'manager', 'ACTIVE', '{"node_id":"af000005-0000-0000-0000-000000000113","approver_type":"ROLE","role":"manager","multi_approver_mode":"ANY","empty_approver_action":"ASSIGN_ADMIN","same_submitter_action":"ALLOW","approver_direction":"BOTTOM_UP","cc_list":[],"field_permissions":{},"pass_post_config":{},"reject_post_config":{}}'::jsonb, now(), now()),
  ('af000005-0000-0000-0000-000000000131', 'system', 'CRM_APPROVAL_LINK', 'link', 'link', 'ACTIVE', '{"from_node":"af000005-0000-0000-0000-000000000111","to_node":"af000005-0000-0000-0000-000000000112","condition_ref":null}'::jsonb, now(), now()),
  ('af000005-0000-0000-0000-000000000132', 'system', 'CRM_APPROVAL_LINK', 'link', 'link', 'ACTIVE', '{"from_node":"af000005-0000-0000-0000-000000000112","to_node":"af000005-0000-0000-0000-000000000113","condition_ref":null}'::jsonb, now(), now()),
  ('af000005-0000-0000-0000-000000000133', 'system', 'CRM_APPROVAL_LINK', 'link', 'link', 'ACTIVE', '{"from_node":"af000005-0000-0000-0000-000000000113","to_node":"af000005-0000-0000-0000-000000000114","condition_ref":null}'::jsonb, now(), now())
ON CONFLICT (id) DO NOTHING;

-- 预警规则配置种子（item 21，5 类；severity/target_role 留 NULL 由引擎默认 medium/ops）
INSERT INTO crm.alert_rule (kind, match, check_params, enabled, version) VALUES
  ('deal_stuck', '{"particleTypes":["CRM_DEAL"],"actions":["stage_update","advance"]}'::jsonb, '{"stuck_days":30}'::jsonb, TRUE, 1),
  ('lead_overdue', '{"particleTypes":["CRM_DEAL"],"actions":["lead-picked","lead-recycled","followup","update"]}'::jsonb, '{"overdue_days":30}'::jsonb, TRUE, 1),
  ('forecast_breach', '{"particleTypes":["CRM_DEAL"],"actions":["forecast_update","amount_update"]}'::jsonb, '{"breach_pct":0.8}'::jsonb, TRUE, 1),
  ('approval_bottleneck', '{"particleTypes":["*"],"actions":["approval_create"]}'::jsonb, '{"bottleneck_count":5}'::jsonb, TRUE, 1),
  ('payment_due', '{"particleTypes":["CRM_INVOICE"],"actions":["invoice_create","payment_create"]}'::jsonb, '{"due_days":7}'::jsonb, TRUE, 1)
-- 2026-09-06：alert_rule 主键已复合化为 (kind, tenant_id)（租户化改造），ON CONFLICT 目标列必须同步，
--   否则整份 seed.sql 执行即报 no unique or exclusion constraint（连带 reseedBase() 的所有测试文件级失败）。
ON CONFLICT (kind, tenant_id) DO UPDATE SET
  match=EXCLUDED.match, check_params=EXCLUDED.check_params, enabled=EXCLUDED.enabled, updated_at=now();

-- ============ 演示审批流待办（D1：让「我的待办·待我审批」开箱有数据）============
-- status 用 'TODO'（大写，与审批引擎运行态一致：engine.advanceTask 写/读均用大写；
--   引擎内部已做大小写归一，故存小写也能签，但种子统一大写以消除歧义）；
-- approver 用 role:admin（admin 主演示可见）+ role:sales（alice 可见）；不新增账号、不改密码体系。
-- 固定 UUID + ON CONFLICT DO NOTHING 幂等（重跑安全、不删现有数据）。
INSERT INTO crm.particles (id, tenant_id, type, slug, title, state, payload, created_at, updated_at) VALUES
  ('a9000000-0000-0000-0000-000000000001', 'system', 'CRM_APPROVAL_INSTANCE', 'demo-inst-1',
   '报价单-演示审批', 'ACTIVE',
   '{"flow_id":"demo-flow","business_type":"CRM_QUOTATION","business_id":"f1111111-1111-1111-1111-111111111111","submitter":"alice","status":"approving","current_node":"n1","current_node_name":"经理审批","node_mode":"ANY","approvers":{"role:admin":true},"ctx":{}}',
   now(), now()),
  ('a9000000-0000-0000-0000-000000000011', 'system', 'CRM_APPROVAL_TASK', 'demo-task-admin',
   '管理员待审演示报价', 'ACTIVE',
   '{"instance_id":"a9000000-0000-0000-0000-000000000001","node_id":"n1","approver":"role:admin","status":"TODO","opinion":null,"seq":1}',
   now(), now()),
  ('a9000000-0000-0000-0000-000000000012', 'system', 'CRM_APPROVAL_TASK', 'demo-task-sales',
   '销售待审演示合同', 'ACTIVE',
   '{"instance_id":"a9000000-0000-0000-0000-000000000001","node_id":"n1","approver":"role:sales","status":"TODO","opinion":null,"seq":2}',
   now(), now())
ON CONFLICT (id) DO NOTHING;

-- ============ 智能体契约合规矩阵演示数据（让 /agent-workbench 契约矩阵不全 X）============
-- 对应 DEFAULT_CONTRACT_DOC = docs/specs/2026-08-29-agent-workbench-contract-monitor-design.md §3-§7
-- 共 5 个 contract task：每个 task 各 1 条 loop-started + 1 条 loop-done + 1 条 context-injected。
-- 幂等守卫：WHERE NOT EXISTS 防止重跑堆积（monitor_event 无 UNIQUE 约束）。
INSERT INTO crm.monitor_event (domain, event_type, agent_id, context_facts, payload)
SELECT v.domain, v.event_type, v.agent_id, v.context_facts::jsonb, v.payload::jsonb
FROM (VALUES
  -- A 接诊分流（intake-router；需 L1+L2；skills: data-particle-read + method-intake-routing）
  ('agent','loop-started','intake-router','{"contract_task_id":"A 接诊分流：意图识别 + 商机分级 + 派发路由（唯一入口）","skill":"data-particle-read"}','{}'),
  ('agent','loop-done','intake-router','{"contract_task_id":"A 接诊分流：意图识别 + 商机分级 + 派发路由（唯一入口）","skill":"method-intake-routing"}','{}'),
  ('agent','context-injected','intake-router','{"contract_task_id":"A 接诊分流：意图识别 + 商机分级 + 派发路由（唯一入口）","knowledge_layers_read":["L1","L2"]}','{}'),
  -- B 报价测算（quote-engine；需 L1+L2；skills: data-particle-read + method-quote-engine）
  ('agent','loop-started','quote-engine','{"contract_task_id":"B 报价测算：配置/成本/毛利实时测算，输出 A/B 方案","skill":"data-particle-read"}','{}'),
  ('agent','loop-done','quote-engine','{"contract_task_id":"B 报价测算：配置/成本/毛利实时测算，输出 A/B 方案","skill":"method-quote-engine"}','{}'),
  ('agent','context-injected','quote-engine','{"contract_task_id":"B 报价测算：配置/成本/毛利实时测算，输出 A/B 方案","knowledge_layers_read":["L1","L2"]}','{}'),
  -- C 跟进催办（followup-agent；需 L1+L2；skills: data-particle-read + data-particle-create + method-followup-engine）
  ('agent','loop-started','followup-agent','{"contract_task_id":"C 跟进催办：自动跟进/节点催办/超时转人工","skill":"data-particle-read"}','{}'),
  ('agent','loop-done','followup-agent','{"contract_task_id":"C 跟进催办：自动跟进/节点催办/超时转人工","skill":"data-particle-create"}','{}'),
  ('agent','loop-done','followup-agent','{"contract_task_id":"C 跟进催办：自动跟进/节点催办/超时转人工","skill":"method-followup-engine"}','{}'),
  ('agent','context-injected','followup-agent','{"contract_task_id":"C 跟进催办：自动跟进/节点催办/超时转人工","knowledge_layers_read":["L1","L2"]}','{}'),
  -- D 评审把关（review-gate；需 L1+L2+L3；skills: data-particle-read + method-review-gate）
  ('agent','loop-started','review-gate','{"contract_task_id":"D 评审把关：双闸门 + 专家介入 + 内置四维审查","skill":"data-particle-read"}','{}'),
  ('agent','loop-done','review-gate','{"contract_task_id":"D 评审把关：双闸门 + 专家介入 + 内置四维审查","skill":"method-review-gate"}','{}'),
  ('agent','context-injected','review-gate','{"contract_task_id":"D 评审把关：双闸门 + 专家介入 + 内置四维审查","knowledge_layers_read":["L1","L2","L3"]}','{}')
) AS v(domain, event_type, agent_id, context_facts, payload)
WHERE NOT EXISTS (
  SELECT 1 FROM crm.monitor_event me
  WHERE me.domain = v.domain
    AND me.event_type = v.event_type
    AND me.context_facts->>'contract_task_id' = v.context_facts::jsonb->>'contract_task_id'
    AND me.context_facts->>'skill' IS NOT DISTINCT FROM v.context_facts::jsonb->>'skill'
);

-- 演示 success 标记：T4 工作台展示 = pass（驱动前端 ✓ 渲染）
INSERT INTO crm.agent_contract_feedback (contract_task_id, agent, gap_type, observed, expected, severity)
VALUES
  ('D 评审把关：双闸门 + 专家介入 + 内置四维审查', 'review-gate', 'success', 'pass',
   '评审把关契约三维度合规通过（演示 ✓）', 'info')
ON CONFLICT (contract_task_id, gap_type) DO UPDATE SET
  observed = EXCLUDED.observed, ts = now();

-- ============ 对话决策建议配置（2026-09-08 设计 §4.2；后台可改，禁硬编码）============
-- 对话驱动决策建议（docs/2026-09-08-dialog-driven-decision-advice-design.md）：
--   dialog-scenario-map = 诉求关键词 → 8 大决策场景 × S1-S8 阶段映射表（后台可改，代码仅为缺配置兜底）
--   dialog-advisor-config = 建议阈值（毛利下限/成本估算比例/阶段停留/跟进超期），禁硬编码
INSERT INTO crm.config_store (tenant_id, key, value, updated_by)
VALUES ('system', 'dialog-scenario-map',
  '{"map":[{"scenario_id":"QUOTE_PRICING","keywords":["报价","折扣","降价","价格","账期","付款","让价","折"],"stages":["S4","S5"]},{"scenario_id":"SOLUTION_VALUE","keywords":["样品","寄样","试用","演示","方案","定制","需求变更"],"stages":["S3"]},{"scenario_id":"CLIENT_STRATEGY","keywords":["拜访","跟进","联系","谁拍板","关键人","决策链"],"stages":["S2","S3"]},{"scenario_id":"OPP_QUALIFY","keywords":["预算","竞品","值不值得","真需求","陪标"],"stages":["S2"]},{"scenario_id":"SIGN_RISK","keywords":["合同","签单","风险","卡住","反对"],"stages":["S5"]},{"scenario_id":"POST_CONTRACT","keywords":["回款","续约","交付变更","验收"],"stages":["S6"]},{"scenario_id":"LOSS_REVIEW","keywords":["丢单","输单","复盘","放弃"],"stages":["S7","S8"]},{"scenario_id":"DEAL_REOPEN","keywords":["重新跟","再跟","重开"],"stages":["S7","S8"]},{"scenario_id":"LEAD_FOLLOW_UP","keywords":["新线索","跟不跟","询盘"],"stages":["S1"]}]}'::jsonb,
  'system')
ON CONFLICT (tenant_id, key) DO NOTHING;

INSERT INTO crm.config_store (tenant_id, key, value, updated_by)
VALUES ('system', 'dialog-advisor-config',
  '{"margin_floor_pct":20,"cost_estimate_ratio":0.6,"stuck_days":30,"forgotten_days":7}'::jsonb,
  'system')
ON CONFLICT (tenant_id, key) DO NOTHING;
