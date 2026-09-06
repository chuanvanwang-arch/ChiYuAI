// test/billing/entitlements.test.js — 权益解析 + 门禁拦截（T5）
import { describe, test, expect, afterAll } from 'vitest';
import { query, queryWrite } from '../../src/db.js';
import { resolveEntitlements } from '../../src/billing/entitlements.js';

afterAll(async () => {
  await queryWrite(`UPDATE crm.tenants SET plan='free' WHERE tenant_id='__et'`);
});

describe('resolveEntitlements', () => {
  test('pro 档含 decision_autonomy，不含 industry_config', async () => {
    await queryWrite(`INSERT INTO crm.tenants (tenant_id, name, status, plan) VALUES ('__et','__et','active','pro') ON CONFLICT (tenant_id) DO UPDATE SET plan='pro'`, []);
    const e = await resolveEntitlements('__et');
    expect(e.has('decision_autonomy')).toBe(true);
    expect(e.has('industry_config')).toBe(false);
  });

  // 2026-09-06：现网配置里免费档含 core_crm/ai_agents/customer_360/memory（基础能力），
  //   门禁语义是「免费档不含高档能力」，而非「仅 core_crm」一条。
  //   断言改为校验高档权益被挡（与 billing-plans 配置解耦，改档位不误红）。
  test('free 档不含高档权益（decision_autonomy / industry_config / rbac_advanced）', async () => {
    await queryWrite(`UPDATE crm.tenants SET plan='free' WHERE tenant_id='__et'`);
    const e = await resolveEntitlements('__et');
    expect(e.has('core_crm')).toBe(true);
    expect(e.has('decision_autonomy')).toBe(false);
    expect(e.has('industry_config')).toBe(false);
    expect(e.has('rbac_advanced')).toBe(false);
  });

  test('system 租户恒全权益（内部/agent 不被门禁阻断）', async () => {
    const e = await resolveEntitlements('system');
    expect(e.has('ai_agents')).toBe(true);
    expect(e.has('decision_autonomy')).toBe(true);
  });
});
