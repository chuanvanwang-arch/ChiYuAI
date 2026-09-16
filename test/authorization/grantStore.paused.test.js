// T20-3 grantStore.pauseGrant 补列单测：暂停落 paused_at/paused_reason（降级追溯前提）
import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { query } from '../../src/db.js';
import { createGrant, pauseGrant } from '../../src/authorization/grantStore.js';

const TENANT = `test-pause-${randomUUID()}`;

afterAll(async () => {
  await query(`DELETE FROM crm.standing_grant WHERE tenant_id=$1`, [TENANT]);
});

describe('pauseGrant 降级追溯（T20-3）', () => {
  it('暂停落 paused_at 非空 + paused_reason', async () => {
    const g = await createGrant({
      tenantId: TENANT, title: '暂停补列', scopeActions: ['crm-writeback-internal'],
      fieldWhitelist: ['ai_fit_score'], riskTier: 'T1', approvedBy: 'alice', decisionId: 'dec-t20-3',
    });
    const paused = await pauseGrant(TENANT, g.grant_id, 'consecutive-rejects');
    expect(paused.status).toBe('paused');
    expect(paused.paused_at).toBeTruthy();
    expect(paused.paused_reason).toBe('consecutive-rejects');
  });

  it('用量熔断暂停亦落 paused_reason=usage-limit', async () => {
    const { recordExecution } = await import('../../src/authorization/grantStore.js');
    const g = await createGrant({
      tenantId: TENANT, title: '熔断补列', scopeActions: ['crm-writeback-internal'],
      fieldWhitelist: null, riskTier: 'T1', maxUses: 1, approvedBy: 'alice', decisionId: 'dec-t20-3b',
    });
    await recordExecution({ tenantId: TENANT, grantId: g.grant_id, actionName: 'crm-writeback-internal', beforeState: {}, afterState: {}, decisionId: 'd-exec' });
    const after = await query(`SELECT status, paused_at, paused_reason FROM crm.standing_grant WHERE tenant_id=$1 AND grant_id=$2`, [TENANT, g.grant_id]);
    expect(after.rows[0].status).toBe('paused');
    expect(after.rows[0].paused_reason).toBe('usage-limit');
    expect(after.rows[0].paused_at).toBeTruthy();
  });
});
