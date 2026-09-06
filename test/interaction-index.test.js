// test/interaction-index.test.js — ATTIO 借鉴 DB 集成：key_contact 自动边 + interaction_index 写时维护
import { describe, it, expect, beforeEach } from 'vitest';
import { query } from '../src/db.js';
import {
  createParticle, getParticle, queryNeighbors,
} from '../src/particles/particleRepo.js';
import { recordInteraction } from '../src/particles/interactionIndex.js';

beforeEach(async () => {
  await query(`TRUNCATE particles, edges, events CASCADE`);
});

describe('ATTIO 借鉴 DB 集成', () => {
  it('ACCOUNT 带 key_contact 落库自动建 key_contact 受控边', async () => {
    const contact = await createParticle('CRM_CONTACT', { name: '李工', email: 'li@x.com' });
    const acct = await createParticle('CRM_ACCOUNT', { name: 'X 科技', key_contact: contact.id });
    const n = await queryNeighbors('CRM_ACCOUNT', acct.id);
    expect(n.some(e => e.edge_type === 'key_contact' && e.target_id === contact.id)).toBe(true);
  });

  it('recordInteraction 写时维护 interaction_index（按渠道 first/last/next）', async () => {
    const acct = await createParticle('CRM_ACCOUNT', { name: 'X 科技' });
    await recordInteraction({ relatedType: 'CRM_ACCOUNT', relatedId: acct.id, channel: 'email', at: '2026-08-10T00:00:00Z', kind: 'last' });
    await recordInteraction({ relatedType: 'CRM_ACCOUNT', relatedId: acct.id, channel: 'email', at: '2026-09-01T00:00:00Z', kind: 'next' });
    const p = await getParticle(acct.id);
    expect(p.payload.interaction_index.email.last_at).toBe('2026-08-10T00:00:00Z');
    expect(p.payload.interaction_index.email.next_at).toBe('2026-09-01T00:00:00Z');
    const ev = await query(`SELECT count(*) c FROM events WHERE domain='particle' AND payload->>'channel'='email'`);
    expect(ev.rows[0].c >= 1).toBe(true);
  });
});