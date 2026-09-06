// test/age-sync.test.js — P1 写时镜像：粒子落库即旁路镜像进 AGE 顶点（写库即构建）
import { describe, it, expect, beforeEach } from 'vitest';
import { query } from '../src/db.js';
import { ensureGraph, isAvailable, runCypher } from '../src/decision/ageGraph.js';
import { createParticle } from '../src/particles/particleRepo.js';
import { createEdge } from '../src/particles/particleRepo.js';

beforeEach(async () => {
  await query('TRUNCATE crm.particles, crm.edges RESTART IDENTITY CASCADE');
  await ensureGraph();
});

describe('P1 粒子镜像', () => {
  const lit = (v) => `'${String(v).replace(/'/g, "''")}'`; // 自生成 UUID，安全内联
  it('createParticle 后 AGE 顶点自动镜像（写库即构建）', async () => {
    const p = await createParticle('CRM_ACCOUNT', { name: 'Acme', domains: ['acme.com'] });
    if (!isAvailable()) return; // 降级环境跳过断言
    // 用 ageGraph.runCypher（内部 LOAD 'age' + search_path 含 ag_catalog），避免裸 query 依赖 search_path 可解析 agtype
    const r = await runCypher(`MATCH (n:CRM_ACCOUNT {entity_id:$id}) RETURN n`, { id: p.id });
    expect(r.length).toBe(1);
  });

  it('受控边自动镜像：account belongs_to deal 后 AGE 存在 belongs_to 边', async () => {
    const acct = await createParticle('CRM_ACCOUNT', { name: 'Acme', domains: ['acme.com'] });
    const deal = await createParticle('CRM_DEAL', { name: 'Deal', stage: 'lead' });
    await createEdge('CRM_ACCOUNT', acct.id, 'belongs_to', 'CRM_DEAL', deal.id, { edge_source: 'auto' });
    if (!isAvailable()) return;
    const r = await runCypher(
      `MATCH (a:CRM_ACCOUNT {entity_id:$a})-[r:belongs_to]->(b:CRM_DEAL {entity_id:$b}) RETURN r`,
      { a: acct.id, b: deal.id }
    );
    expect(r.length).toBe(1);
  });
});
