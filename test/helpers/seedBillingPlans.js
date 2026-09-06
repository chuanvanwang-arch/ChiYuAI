// test/helpers/seedBillingPlans.js — 测试用：幂等播种完整 5 档 billing-plans（含 token_overage_mode/token_hard_cap/quote/features）
// 用途：依赖套餐配置的测试各自在 beforeAll 调用，保证运行顺序无关、不污染共享 config 状态。
// 数据镜像 db/seed-billing-config.sql，两者均对齐「配置中心现网口径」（唯一真相源）。
// ⚠ 2026-09-06 三源对齐（止血）：此前本文件缺 quote/features、权益集合也不全，测试库被本文件播种后
//    会让 billingRoutes.test.js 判定「缺 quote」→ 重播 db/seed（旧口径 token=-1）→ 与依赖现网数值的
//    测试（tokenUsage）互相打架。真相源一致性由 test/billing/planSourceConsistency.test.js 常驻校验。
// 改价/改权益请同步三处：配置中心现网、db/seed-billing-config.sql、本文件。
import { queryWrite } from '../../src/db.js';

export const FULL_PLANS = [
  { plan_id: 'free', name: '免费版 · Free', enabled: true, base_fee: 99, included_seats: 3, seat_unit_price: 99, original_price: null, tag_text: '前三月免费', included_tokens: 50000, token_overage_unit_price: 0.030, token_overage_mode: 'block', token_hard_cap: null, currency: 'CNY', quote: '原价：¥99 / 账号（前三月免费）', features: ['核心 CRM（客户/商机/合同/报价/回款）'], entitlements: ['core_crm', 'ai_agents', 'customer_360', 'memory'] },
  { plan_id: 'starter', name: '成长版 · Starter', enabled: true, base_fee: 0, included_seats: 0, seat_unit_price: 398, original_price: 698, tag_text: '首月特价', included_tokens: 200000, token_overage_unit_price: 0.025, token_overage_mode: 'bill', token_hard_cap: 600000, currency: 'CNY', quote: '¥698 / 账号·月', features: ['AI 智能体四件套 + 客户 360 洞察'], entitlements: ['core_crm', 'ai_agents', 'customer_360', 'approval_flow', 'mcp_access', 'memory'] },
  { plan_id: 'pro', name: '增强版 · Pro', enabled: true, highlight: true, base_fee: 0, included_seats: 0, seat_unit_price: 2980, original_price: null, tag_text: '热销', included_tokens: 1000000, token_overage_unit_price: 0.020, token_overage_mode: 'bill', token_hard_cap: 3000000, currency: 'CNY', quote: '¥2980 / 账号·月', features: ['决策自治', '事件自动化', '审批流', 'LLM', 'MCP', '高级报表', '审计'], entitlements: ['core_crm', 'ai_agents', 'customer_360', 'decision_autonomy', 'event_automation', 'approval_flow', 'llm_config', 'mcp_access', 'advanced_reporting', 'audit_provenance', 'memory'] },
  { plan_id: 'enterprise', name: '企业版 · Enterprise', enabled: true, base_fee: 0, included_seats: 0, seat_unit_price: 8800, original_price: null, tag_text: '企业首选', included_tokens: 5000000, token_overage_unit_price: 0.015, token_overage_mode: 'bill', token_hard_cap: 15000000, currency: 'CNY', quote: '¥8800 / 账号·月', features: ['行业配置化', '高级 RBAC', '客户记忆', 'SLA'], entitlements: ['core_crm', 'ai_agents', 'customer_360', 'decision_autonomy', 'event_automation', 'approval_flow', 'llm_config', 'mcp_access', 'advanced_reporting', 'audit_provenance', 'industry_config', 'rbac_advanced', 'memory'] },
  { plan_id: 'local_flagship', name: '本地旗舰版 · Local Flagship', enabled: true, base_fee: 0, included_seats: -1, seat_unit_price: -1, original_price: null, tag_text: '', included_tokens: -1, token_overage_unit_price: 0, token_overage_mode: 'bill', token_hard_cap: null, currency: 'CNY', quote: '面议', features: ['私有化本地部署', '全量功能', '数据不出域'], entitlements: ['core_crm', 'ai_agents', 'customer_360', 'decision_autonomy', 'event_automation', 'approval_flow', 'llm_config', 'mcp_access', 'advanced_reporting', 'audit_provenance', 'industry_config', 'rbac_advanced', 'memory', 'local_integration', 'distributed_db', 'vector_store'] },
];

export async function seedBillingPlans(by = 'test') {
  await queryWrite(
    `INSERT INTO crm.config_store (tenant_id, key, value, updated_by) VALUES ('system','billing-plans',$1::jsonb,$2)
     ON CONFLICT (tenant_id, key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()`,
    [JSON.stringify(FULL_PLANS), by]
  );
}
