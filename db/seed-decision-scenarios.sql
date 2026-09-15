-- db/seed-decision-scenarios.sql — 决策场景字典「每次 migrate 幂等 ensure」（根治种子漂移）
-- 背景：原 decision_scenario 种子整段只在 db/migrate.js --seed 时执行（seed.sql L227-356），
--   而生产/本地启动只跑 node db/migrate.js（无 --seed）→ 新增场景（LEAD_FIT / PROSPECTING_CONFIRM 等）
--   永不到达已存在数据的库（crm_native），导致 requireDecision 抛「未知决策场景」→ MCP 写退回 DECISION_NEEDED。
-- 修复（2026-09-15）：抽为独立文件，由 db/migrate.js 每次启动（含非 --seed 路径）幂等 INSERT
--   （ON CONFLICT (scenario_id, tenant_id) DO NOTHING），与 seed-outcome-event-map.sql 同范式。
-- 单一事实源：本文件 = 运行期决策场景字典；seed.sql 的对应段保留供 --seed 一次性全量（冗余但无害）。
-- ⚠ 新增/修改决策场景须两处同步：本文件 + seed.sql（或仅改本文件并删除 seed.sql 对应段）。
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
-- PROSPECTING_CONFIRM（2026-09-14）拓客模块确认入池：批量建公海池线索（每企业一个 CRM_DEAL S0）。
-- 与 LEAD_FIT 同档（tier=LEAD，自治可放行）；硬人工闸由 prospecting-confirm needsApproval + 第0闸两阶段承担。
('PROSPECTING_CONFIRM', '一、线索', '拓客批量入池确认（MCP 对话驱动，S0 + source=prospecting）',
 '{"action":["prospecting-confirm"],"connector":"prospecting"}'::jsonb,
 ARRAY['BANT','MEDDICC'],
 '[{"cond":"candidate_count","label":"候选数量","weight":0.5},{"cond":"fit_score_avg","label":"平均适配度","weight":0.5}]'::jsonb,
 'LEAD', TRUE)
ON CONFLICT (scenario_id, tenant_id) DO NOTHING;
