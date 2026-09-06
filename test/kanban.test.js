// test/kanban.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { query } from '../src/db.js';
import { FAILURE_LIMIT } from '../src/kanban/types.js';
import { createTask, claimTask, completeTask, failTask, resetTask, getTask } from '../src/kanban/kanban.js';

beforeEach(async () => {
  await query(`TRUNCATE tasks, task_audit, scheduler_lock CASCADE`);
});

describe('kanban 状态机', () => {
  it('极简四态流转：ready→running→done', async () => {
    const t = await createTask({ step: 'agent', title: 'T1', actionName: 'crm-deal-analyze', payload: {} });
    await claimTask(t.id);
    await completeTask(t.id, { result: { ok: true } });
    const done = await getTask(t.id);
    expect(done.status).toBe('done');
  });

  it('熔断：连续失败 >= FAILURE_LIMIT → blocked(circuit_break)', async () => {
    const t = await createTask({ step: 'agent', title: 'T2', actionName: 'x', payload: {} });
    for (let i = 0; i < FAILURE_LIMIT; i++) {
      await claimTask(t.id);
      await failTask(t.id, { error: `err${i}` });
    }
    const b = await getTask(t.id);
    expect(b.status).toBe('blocked');
    expect(b.block_kind).toBe('circuit_break');
    expect(b.consecutive_failures).toBe(FAILURE_LIMIT);
  });

  it('审计：每个状态转换留 task_audit 记录', async () => {
    const t = await createTask({ step: 'agent', title: 'T3', actionName: 'x', payload: {} });
    await claimTask(t.id, { byActor: 'scheduler' });
    const r = await query(`SELECT count(*) AS c FROM task_audit WHERE task_id=$1`, [t.id]);
    expect(Number(r.rows[0].c)).toBeGreaterThanOrEqual(1);
  });

  it('reset 幂等：任意状态→ready（清失败计数/block）', async () => {
    const t = await createTask({ step: 'agent', title: 'T4', actionName: 'x', payload: {} });
    await claimTask(t.id);
    await failTask(t.id, { error: 'e1' });
    await resetTask(t.id);
    const r = await getTask(t.id);
    expect(r.status).toBe('ready');
    expect(r.consecutive_failures).toBe(0);
  });
});
