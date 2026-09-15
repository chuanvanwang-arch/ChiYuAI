-- db/test-setup.sql — 测试环境重置（幂等清空所有 crm 表）
-- 用途：本地/CI 重置共享真实 PG；E2E 用例另有 beforeEach TRUNCATE，本文件供手动/独立重置
TRUNCATE particles, edges, tasks, task_audit, scheduler_lock, events,
         decision, decision_precedent_rel, decision_event, memory_log,
         memory_snapshot, memory_note,
         decision_scenario, methodology_template, methodology_dimension, policy_version, business_tier_config,
         role_context_profile
         RESTART IDENTITY CASCADE;

-- 决策场景字典重建（§6 决策事件主轴；与 db/seed.sql 的决策场景段同源，幂等重跑安全）
-- 注：TRUNCATE 会清空 decision_scenario，不重建则 createDecision 外键 decision_scenario_id_fkey 失败（历史教训 2026-08-26）
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
-- PARTICLE_CREATE（2026-09-04，与 db/seed.sql 同构）：MCP 建档第 0 闸 mint 载体
('PARTICLE_CREATE', 'meta', 'MCP/对话通道粒子建档（客户/商机/合同等主数据创建）',
 '{"action":["data-particle-create"]}'::jsonb,
 ARRAY[]::TEXT[],
 '[{"cond":"data_origin","label":"数据来源与字段合法","weight":0.34},{"cond":"identity_dedup","label":"主体查重（不重复建档）","weight":0.33},{"cond":"ownership","label":"归属完整（named_owner 必填）","weight":0.33},{"cond":"governance_approval","label":"人工确认","weight":0.15}]'::jsonb,
 'NORMAL', TRUE),
-- PARTICLE_UPDATE（2026-09-09，与 db/seed.sql 同构）：MCP 事实变更第 0 闸 mint 载体
('PARTICLE_UPDATE', 'meta', 'MCP/对话通道粒子事实变更（字段级并入，禁删）',
 '{"action":["data-particle-update"]}'::jsonb,
 ARRAY[]::TEXT[],
 '[{"cond":"data_origin","label":"数据来源与字段合法","weight":0.34},{"cond":"identity_dedup","label":"目标唯一（id 精确定位）","weight":0.33},{"cond":"ownership","label":"归属完整（同租户）","weight":0.33},{"cond":"governance_approval","label":"人工确认","weight":0.15}]'::jsonb,
 'NORMAL', TRUE),
-- REQUIREMENT_COLLECT（2026-09-09，与 db/seed.sql 同构）：followup-agent 采集 SHOULD/NICE 证据第 0 闸 mint 载体
('REQUIREMENT_COLLECT', 'meta', '跟进采集 SHOULD/NICE 需求维度证据（REQUIREMENT 方法论，auto 来源）',
 '{"action":["crm-followup-requirement-collect"]}'::jsonb,
 ARRAY['REQUIREMENT'],
 '[{"cond":"requirement_evidence_ref","label":"证据出处（auto 来源须带 evidence_ref）","weight":0.5},{"cond":"requirement_met","label":"维度满足判据","weight":0.5}]'::jsonb,
 'NORMAL', TRUE),
-- LEAD_FIT（2026-09-10 线索自主发现引擎 T6）：线索 ICP 适配度评分——发现引擎富集后对 CRM_ACCOUNT 评分。
-- 与 LEAD_FOLLOW_UP 同 stage 分组（'一、线索'），配置页 ORDER BY stage, scenario_id 自然归位。
-- tier=LEAD + autonomous_allowed=TRUE：与 LEAD_FOLLOW_UP/LOSS_REVIEW 同档（低风险线索评分可自治）；
--   对外写仍由 discovery-* Action 的 needsApproval + 第 0 闸两阶段 confirm_token 承担硬人工闸。
-- 无 required_dims → 不触发七维拦截（ICP 评分在发现引擎内完成，七维闸由业务场景承担）。
('LEAD_FIT', '一、线索', '线索 ICP 适配度评分（发现引擎：industry/headcount/geo/hiring/funding）',
 '{"cond":{"event":"created","stage":"lead"},"entity":"ACCOUNT","source":"particle_event"}'::jsonb,
 ARRAY['BANT','MEDDICC','OPP_MATRIX'],
 '[{"cond":"industry","label":"行业匹配","weight":0.25},{"cond":"headcount","label":"规模匹配","weight":0.2},{"cond":"geo","label":"地域匹配","weight":0.15},{"cond":"hiring_icp_role","label":"招聘信号","weight":0.2},{"cond":"funding_round","label":"融资信号","weight":0.2}]'::jsonb,
 'LEAD', TRUE),
-- PROSPECTING_CONFIRM（2026-09-14，与 db/seed.sql 同构）：拓客家模块确认入池（S0 + source=prospecting）。
-- 测试库与生产 seed 同步，避免契约校验/决策场景查询在测试库缺场景。
('PROSPECTING_CONFIRM', '一、线索', '拓客批量入池确认（MCP 对话驱动，S0 + source=prospecting）',
 '{"action":["prospecting-confirm"],"connector":"prospecting"}'::jsonb,
 ARRAY['BANT','MEDDICC'],
 '[{"cond":"candidate_count","label":"候选数量","weight":0.5},{"cond":"fit_score_avg","label":"平均适配度","weight":0.5}]'::jsonb,
 'LEAD', TRUE),
-- PREHEAT_MARK（2026-09-15 P1-3，与 seed-decision-scenarios.sql 同构）：触达前预热标记——payload.preheat 子状态机迁移。
--   HITL 铁律：engage 需 hitl_confirm（人工确认），AI 不得自动对外互动；写经第 0 闸（decisionScenario 锚定 mint）。
('PREHEAT_MARK', '一、线索', '触达前预热标记（HITL：engage 需人工确认，AI 不自动对外互动）',
 '{"action":["preheat-mark"],"connector":"preheat"}'::jsonb,
 ARRAY['BANT'],
 '[{"cond":"hitl_confirm","label":"人工确认（HITL）","weight":1.0}]'::jsonb,
 'LEAD', TRUE)
ON CONFLICT (scenario_id, tenant_id) DO NOTHING;

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
-- 2026-09-06：alert_rule 主键已复合化为 (kind, tenant_id)，ON CONFLICT 目标列必须同步，否则整份 test-setup.sql 执行即报 no unique or exclusion constraint
ON CONFLICT (kind, tenant_id) DO UPDATE SET
  match=EXCLUDED.match, check_params=EXCLUDED.check_params, enabled=EXCLUDED.enabled, updated_at=now();
