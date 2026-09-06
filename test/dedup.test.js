// test/dedup.test.js — P5 实体去重：全称/简称经 alias_of 归一到同一 canonical id
import { describe, it, expect, beforeEach } from 'vitest';
import { query } from '../src/db.js';
import { ensureDedupSchema, suggestMerge, confirmMerge } from '../src/particles/dedup.js';
import { createParticle } from '../src/particles/particleRepo.js';

beforeEach(async () => {
  await ensureDedupSchema();
  await query('TRUNCATE crm.particles, crm.edges RESTART IDENTITY CASCADE');
});

describe('P5 去重', () => {
  it('全称/简称经 alias_of 指向同一 canonical id', async () => {
    const a = await createParticle('CRM_ACCOUNT', { name: '北京智云科技有限公司', domains: ['zhiyun.com'] });
    const b = await createParticle('CRM_ACCOUNT', { name: '智云科技', alias_of: a.id });
    const s = await suggestMerge(b.id);
    expect(s.candidateId).toBe(a.id);
    await confirmMerge(b.id, a.id);
    const r = await query(`SELECT meta->>'merged_into' AS m FROM crm.particles WHERE id=$1`, [b.id]);
    expect(r.rows[0].m).toBe(String(a.id));
  });
});
