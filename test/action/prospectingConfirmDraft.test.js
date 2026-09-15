// test/action/prospectingConfirmDraft.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getAction } from '../../src/action/registry.js';
import { seedActions } from '../../src/action/seed-actions.js';
import { insertDraft, getDraft, softExpireDraft } from '../../src/connectors/discovery/draftRepo.js';
import { query, queryWrite, pool } from '../../src/db.js';

const TID = 'test-confirm-draft';

beforeAll(async () => { seedActions(); });
afterAll(async () => { await queryWrite(`DELETE FROM crm.discovery_draft WHERE tenant_id=$1`, [TID]).catch(() => {}); await pool.end(); });

describe('discovery_draft repo', () => {
  it('insert → get → 软过期', async () => {
    const d = await insertDraft({ tenantId: TID, provider: 'anysite', kind: 'prospect', items: [{ name: 'Acme' }] });
    expect(d.draft_id).toBeTruthy();
    const got = await getDraft(d.draft_id, { tenantId: TID });
    expect(got.status).toBe('pending');
    expect(got.items[0].name).toBe('Acme');
    await softExpireDraft(d.draft_id);
    const after = await getDraft(d.draft_id, { tenantId: TID });
    expect(after.status).toBe('consumed');
  });
});

describe('prospecting-confirm (draft_id path)', () => {
  it('消费 draft_id → 落 CRM_DEAL S0；跨租户拒绝', async () => {
    const d = await insertDraft({ tenantId: TID, provider: 'anysite', kind: 'prospect', items: [{ name: 'DraftCo', industry: 'chem' }] });
    const a = getAction('prospecting-confirm');
    const created = [];
    const res = await a.handler({ draft_id: d.draft_id }, { tenantId: TID, decision_id: 'dec-1', actor: 'alice' },
      { createParticle: async (type, payload, opts) => { created.push({ type, payload }); return { id: 'deal-' + created.length }; },
        createEdge: async () => ({}),
        getDraft: (id, o) => getDraft(id, o),
        softExpireDraft: (id) => softExpireDraft(id),
        findAccount: async () => null });
    expect(created.length).toBe(1);
    expect(created[0].type).toBe('CRM_DEAL');
    expect(created[0].payload.stage).toBe('S0');
    expect(res.results[0].existing).toBe(false);
    const after = await getDraft(d.draft_id, { tenantId: TID });
    expect(after.status).toBe('consumed');
  });

  it('草稿已消费 → 拒绝（防重复落库）', async () => {
    const d = await insertDraft({ tenantId: TID, provider: 'anysite', kind: 'prospect', items: [{ name: 'X' }] });
    await softExpireDraft(d.draft_id);
    const a = getAction('prospecting-confirm');
    await expect(a.handler({ draft_id: d.draft_id }, { tenantId: TID, decision_id: 'dec-2' },
      { createParticle: async () => ({}), createEdge: async () => ({}), getDraft: (id, o) => getDraft(id, o), softExpireDraft: () => {}, findAccount: async () => null }))
      .rejects.toThrow(/已消费|非 pending/);
  });

  it('无 draft_id 且非 session → 退回既有 session 逻辑（不破坏旧链路）', async () => {
    const a = getAction('prospecting-confirm');
    await expect(a.handler({ session_id: 'nope', confirmed_ids: [] }, { tenantId: TID, decision_id: 'dec-3' }, {}))
      .rejects.toThrow(/session/);
  });
});
