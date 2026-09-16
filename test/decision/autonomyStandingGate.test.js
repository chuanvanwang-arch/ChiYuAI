// T19-6 B/C 轴门控：consultStandingGate 在 A 轴放行结果上叠加常驻授权判定（opt-in + fail-closed）
import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { consultStandingGate } from '../../src/authorization/standingAuthorization.js';
import { createGrant } from '../../src/authorization/grantStore.js';

const TENANT = `test-gate-${randomUUID()}`;

describe('consultStandingGate（B/C 轴）', () => {
  it('A 轴已升级 → 保持升级（不受 standingAction 影响）', async () => {
    const r = await consultStandingGate(true, { tenantId: TENANT, standingAction: 'crm-writeback-internal' });
    expect(r).toBe(true);
  });

  it('A 轴放行但未声明 standingAction → 保持自主（opt-in）', async () => {
    const r = await consultStandingGate(false, { tenantId: TENANT });
    expect(r).toBe(false);
  });

  it('A 轴放行 + 动作无活跃凭证 → 升级（fail-closed）', async () => {
    const r = await consultStandingGate(false, { tenantId: TENANT, standingAction: 'crm-writeback-internal' });
    expect(r).toBe(true);
  });

  it('A 轴放行 + T1 凭证覆盖动作 → 保持自主', async () => {
    await createGrant({
      tenantId: TENANT, title: '内部回写', scopeActions: ['crm-writeback-internal'],
      fieldWhitelist: ['ai_fit_score'], riskTier: 'T1', approvedBy: 'alice', decisionId: 'dec-1',
    });
    const r = await consultStandingGate(false, { tenantId: TENANT, standingAction: 'crm-writeback-internal', standingFields: ['ai_fit_score'] });
    expect(r).toBe(false);
  });

  it('A 轴放行 + 字段越出白名单 → 升级', async () => {
    const r = await consultStandingGate(false, { tenantId: TENANT, standingAction: 'crm-writeback-internal', standingFields: ['external_field'] });
    expect(r).toBe(true);
  });
});
