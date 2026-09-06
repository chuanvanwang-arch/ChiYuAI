// test/e2e.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { query } from '../src/db.js';
import { createParticle, createEdge } from '../src/particles/particleRepo.js';
import { advanceStage } from '../src/particles/lifecycle.js';
import { on, emit } from '../src/events/bus.js';
import { getTask } from '../src/kanban/kanban.js';

beforeEach(async () => {
  await query(`TRUNCATE particles, edges, tasks, task_audit, events CASCADE`);
});

describe('E2E：L1 粒子旅程 + L2 事件 + L3 任务', () => {
  it('建客户 → 建 DEAL → belongs_to 边 → 推进阶段 → 全链路事件', async () => {
    const received = [];
    const off = on('*', (m) => received.push(`${m.domain}:${m.type}`));

    // 1. 建客户（L1 写入，触发写时三钩子）
    const acct = await createParticle('CRM_ACCOUNT', { name: '深圳智造', industry: '半导体', region: '华南' });
    // 2. 建交易（DEAL 归属客户）
    const deal = await createParticle('CRM_DEAL', { name: '扩产项目', stage: 'S1', account_id: acct.id });
    // 3. 自动建边 belongs_to（ontologySync 引用型字段）
    const neighbors = await (await import('../src/particles/particleRepo.js')).queryNeighbors('CRM_DEAL', deal.id);
    expect(neighbors.some(e => e.edge_type === 'belongs_to')).toBe(true);
    // 4. 阶段推进（商机）
    await advanceStage(deal.id, 'S2', { transitionedBecause: '客户意向明确，进入商机评估' });
    const p = await (await import('../src/particles/particleRepo.js')).getParticle(deal.id);
    expect(p.payload.stage).toBe('S2');
    expect(p.payload.stage_change_reason).toBe('客户意向明确，进入商机评估');

    // 5. 事件全链路：particle 域收到 created/updated/edge-created
    expect(received).toContain('particle:created');
    expect(received).toContain('particle:edge-created');
    expect(received).toContain('particle:updated');

    off();
  });

  it('写后验证：DEAL 更新后 embedding 覆盖（内容变更重算）', async () => {
    const deal = await createParticle('CRM_DEAL', { name: 'A 项目', stage: 'S1' });
    const r1 = await query(`SELECT content_hash FROM particles WHERE id=$1`, [deal.id]);
    await (await import('../src/particles/particleRepo.js')).updateParticle(deal.id,
      { patch: { name: 'A 项目（改名）' } });
    const r2 = await query(`SELECT content_hash FROM particles WHERE id=$1`, [deal.id]);
    expect(r2.rows[0].content_hash).not.toBe(r1.rows[0].content_hash); // 内容变 → 重算
  });

  it('编排链路：任务创建 → 认领 → 完成（kanban 全链路）', async () => {
    const { createTask, claimTask, completeTask } = await import('../src/kanban/kanban.js');
    const t = await createTask({ step: 'agent', title: 'E2E任务', actionName: 'crm-deal-analyze', payload: {}, chainId: 'stage1-e2e' });
    await claimTask(t.id);
    await completeTask(t.id, { result: { ok: true, steps: 1 } });
    const done = await getTask(t.id);
    expect(done.status).toBe('done');
    expect(done.result.ok).toBe(true);
  });
});
