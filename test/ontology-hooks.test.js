// test/ontology-hooks.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { query } from '../src/db.js';
import { ensureAll } from '../src/ontology/hooks.js';

beforeEach(async () => {
  await query(`TRUNCATE particles, edges, events CASCADE`);
});

function fakeParticle(type, payload) {
  return { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', type, payload, tenant_id: 'system' };
}

describe('ontology hooks', () => {
  it('ensureEmbedding 幂等：内容不变不重算（同 content_hash 返回同一向量）', async () => {
    const p = fakeParticle('CRM_DEAL', { name: '扩产项目', stage: 'lead' });
    await query(
      `INSERT INTO particles (id, tenant_id, type, slug, title, state, payload) VALUES ($1,'system','CRM_DEAL','deal','交易','lead',$2)`,
      [p.id, JSON.stringify(p.payload)]
    );
    await ensureAll(p);
    const r1 = await query(`SELECT embedding, content_hash FROM particles WHERE id=$1`, [p.id]);
    // 再次 ensureAll（无内容变化）→ 不重算（embedding 保持、content_hash 不变）
    await ensureAll(p);
    const r2 = await query(`SELECT embedding, content_hash FROM particles WHERE id=$1`, [p.id]);
    expect(r2.rows[0].content_hash).toBe(r1.rows[0].content_hash);
    expect(r2.rows[0].embedding).toEqual(r1.rows[0].embedding);
  });

  it('ensureTsVector 双写：FTS 索引与向量同时维护', async () => {
    const p = fakeParticle('CRM_ACCOUNT', { name: '半导体客户深圳智造', industry: '半导体' });
    await query(
      `INSERT INTO particles (id, tenant_id, type, slug, title, state, payload) VALUES ($1,'system','CRM_ACCOUNT','account','客户','potential',$2)`,
      [p.id, JSON.stringify(p.payload)]
    );
    await ensureAll(p);
    const r = await query(`SELECT fts FROM particles WHERE id=$1`, [p.id]);
    expect(r.rows[0].fts).toBeTruthy();
  });

  it('ontologySync 词汇表登记：枚举/业务名词写时登记 knowledge', async () => {
    const p = fakeParticle('CRM_DEAL', { name: '商机推进', stage: 'opportunity' });
    await query(
      `INSERT INTO particles (id, tenant_id, type, slug, title, state, payload) VALUES ($1,'system','CRM_DEAL','deal','交易','opportunity',$2)`,
      [p.id, JSON.stringify(p.payload)]
    );
    await ensureAll(p);
    const r = await query(`SELECT count(*) AS c FROM particles WHERE type='CRM_KNOWLEDGE'`);
    expect(r.rows[0].c >= 1).toBe(true);
  });
});
