// test/particles.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { query } from '../src/db.js';
import { createParticle, getParticle, queryParticles, createEdge, queryNeighbors } from '../src/particles/particleRepo.js';

beforeEach(async () => {
  await query(`TRUNCATE particles, edges, events CASCADE`);
});

describe('particleRepo', () => {
  it('创建 CRM_DEAL 粒子并写时触发三钩子（embedding/tsvector 落库）', async () => {
    const p = await createParticle('CRM_DEAL', {
      name: '半导体扩产项目', expected_amount: 1200000,
      stage: 'lead', owner_id: '11111111-1111-1111-1111-111111111111',
      org_id: '22222222-2222-2222-2222-222222222222',
    });
    const row = await query(`SELECT embedding, fts, content_hash FROM particles WHERE id=$1`, [p.id]);
    expect(row.rows[0].embedding).toBeTruthy();
    expect(row.rows[0].fts).toBeTruthy();
    expect(row.rows[0].content_hash).toBeTruthy();
  });

  it('受控谓词边：DEAL belongs_to ACCOUNT（重复建边幂等）', async () => {
    const acct = await createParticle('CRM_ACCOUNT', { name: '深圳智造科技', industry: '半导体' });
    const deal = await createParticle('CRM_DEAL', { name: '扩产项目', stage: 'lead' });
    const e1 = await createEdge('CRM_DEAL', deal.id, 'belongs_to', 'CRM_ACCOUNT', acct.id);
    const e2 = await createEdge('CRM_DEAL', deal.id, 'belongs_to', 'CRM_ACCOUNT', acct.id);
    expect(e2.id).toBe(e1.id); // 幂等
    const neighbors = await queryNeighbors('CRM_DEAL', deal.id);
    expect(neighbors.some(n => n.edge_type === 'belongs_to')).toBe(true);
  });

  it('未受控谓词拒绝', async () => {
    const acct = await createParticle('CRM_ACCOUNT', { name: 'X' });
    const deal = await createParticle('CRM_DEAL', { name: 'Y', stage: 'lead' });
    await expect(createEdge('CRM_DEAL', deal.id, 'hates', 'CRM_ACCOUNT', acct.id))
      .rejects.toThrow(/未受控/);
  });

  // 2026-09-01 基线同步：stage 已统一为 S1–S8（src/sales/stageTaxonomy.js 单一事实源），
  // 入参旧英文值 'lead' 在 createParticle 层经 normalizeStage→toStageCode 归一为 'S1' 存储，
  // 故推进/断言一律用 S 码；保留英文入参以覆盖兼容别名路径。
  it('CRM_DEAL 状态机：stage 只进不退（S1→S2 合法；S2→S1 被拒）', async () => {
    const deal = await createParticle('CRM_DEAL', { name: 'Z', stage: 'lead' });
    await import('../src/particles/lifecycle.js').then(m => m.advanceStage(deal.id, 'S2'));
    const p1 = await getParticle(deal.id);
    expect(p1.payload.stage).toBe('S2');
    await expect(import('../src/particles/lifecycle.js').then(m => m.advanceStage(deal.id, 'S1')))
      .rejects.toThrow(/只进不退/);
  });
});
