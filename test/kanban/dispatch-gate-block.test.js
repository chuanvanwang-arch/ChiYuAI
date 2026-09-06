// test/kanban/dispatch-gate-block.test.js — dispatchOneCore 两阶段分支（② gate 阻断式）
import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../../src/kanban/kanban.js', () => ({
  claimTask: vi.fn(async (id) => ({ id, status: 'running' })),
  completeTask: vi.fn(async (id) => ({ id, status: 'done' })),
  failTask: vi.fn(async (id) => ({ id, status: 'failed' })),
  gateBlockTask: vi.fn(async (id) => ({ id, status: 'blocked', block_kind: 'gate_reject' })),
}));
import { dispatchOneCore } from '../../src/kanban/scheduler.js';
import { completeTask, gateBlockTask } from '../../src/kanban/kanban.js';

const majorTask = { id: 'm1', payload: { intent: 'quote', level: 'major' } };

describe('dispatchOneCore gate blocking', () => {
  beforeEach(() => vi.clearAllMocks());
  it('major reject → gateBlockTask, 不 completeTask', async () => {
    const runWithSkillFn = async (t) =>
      t.payload.contract_task_id === 'ct-quote-calc'
        ? { draft: 'quote' }
        : { verdict: 'reject', defects: ['毛利不达标'] };
    await dispatchOneCore(majorTask, { runWithSkillFn });
    expect(gateBlockTask).toHaveBeenCalledWith('m1', expect.any(Object));
    expect(completeTask).not.toHaveBeenCalled();
  });
  it('major pass → completeTask', async () => {
    const runWithSkillFn = async (t) =>
      t.payload.contract_task_id === 'ct-quote-calc'
        ? { draft: 'quote' }
        : { verdict: 'pass', defects: [] };
    await dispatchOneCore(majorTask, { runWithSkillFn });
    expect(completeTask).toHaveBeenCalledWith('m1', expect.any(Object));
    expect(gateBlockTask).not.toHaveBeenCalled();
  });
  it('L2 复盘任务(gateAgents=[]) → 不受影响', async () => {
    const retroTask = { id: 'r1', payload: { intent: 'retro', level: 'L2' } };
    const runWithSkillFn = async () => ({ draft: 'retro' });
    await dispatchOneCore(retroTask, { runWithSkillFn });
    expect(completeTask).toHaveBeenCalledWith('r1', expect.any(Object));
    expect(gateBlockTask).not.toHaveBeenCalled();
  });
});
