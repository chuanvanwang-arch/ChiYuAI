// T19-4 grantSweeper 单测：过期 → expired；连续否决达阈值 → paused
import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createGrantSweeper } from '../../src/authorization/grantSweeper.js';
import { createGrant, getGrant, recordExecution } from '../../src/authorization/grantStore.js';

const TENANT = `test-sweep-${randomUUID()}`;
const sweeper = createGrantSweeper();

describe('grantSweeper.sweepOnce', () => {
  it('过期凭证 → status=expired', async () => {
    const g = await createGrant({
      tenantId: TENANT, title: '过期测试', scopeActions: ['a'], fieldWhitelist: null,
      riskTier: 'T1', approvedBy: 'alice', decisionId: 'dec-1',
      expiresAt: '2000-01-01T00:00:00Z',
    });
    const r = await sweeper.sweepOnce();
    expect(r.expired).toBeGreaterThanOrEqual(1);
    const after = await getGrant(TENANT, g.grant_id);
    expect(after.status).toBe('expired');
  });

  it('连续 N 次 rejected → 自动 paused', async () => {
    const N = 3;
    const g = await createGrant({
      tenantId: TENANT, title: '否决测试', scopeActions: ['b'], fieldWhitelist: null,
      riskTier: 'T1', maxUses: null, approvedBy: 'alice', decisionId: 'dec-2',
    });
    for (let i = 0; i < N; i++) {
      await recordExecution({
        tenantId: TENANT, grantId: g.grant_id, actionName: 'b',
        beforeState: {}, afterState: {}, decisionId: `d${i}`, hitlVerdict: 'rejected',
      });
    }
    const r = await sweeper.sweepOnce();
    expect(r.paused).toBeGreaterThanOrEqual(1);
    const after = await getGrant(TENANT, g.grant_id);
    expect(after.status).toBe('paused');
  });

  it('混合 verdict（含 adopted）不暂停', async () => {
    const g = await createGrant({
      tenantId: TENANT, title: '混合测试', scopeActions: ['c'], fieldWhitelist: null,
      riskTier: 'T1', approvedBy: 'alice', decisionId: 'dec-3',
    });
    await recordExecution({ tenantId: TENANT, grantId: g.grant_id, actionName: 'c', beforeState: {}, afterState: {}, decisionId: 'd1', hitlVerdict: 'rejected' });
    await recordExecution({ tenantId: TENANT, grantId: g.grant_id, actionName: 'c', beforeState: {}, afterState: {}, decisionId: 'd2', hitlVerdict: 'adopted' });
    await recordExecution({ tenantId: TENANT, grantId: g.grant_id, actionName: 'c', beforeState: {}, afterState: {}, decisionId: 'd3', hitlVerdict: 'rejected' });
    await sweeper.sweepOnce();
    const after = await getGrant(TENANT, g.grant_id);
    expect(after.status).toBe('active'); // 非连续全 rejected
  });
});
