// test/scheduler-router.test.js — A 唯一入口路由（意图识别+分级派发）
import { describe, it, expect, vi } from 'vitest';

// mock kanban（防真实 DB 调用）；routeThroughIntake 是纯函数，不依赖 DB
vi.mock('../src/kanban/kanban.js', () => ({
  claimTask: vi.fn(async (id) => ({ id })),
  completeTask: vi.fn(async () => {}),
  failTask: vi.fn(async () => {}),
  listTasks: vi.fn(async () => []),
}));

import { routeThroughIntake } from '../src/kanban/scheduler.js';

describe('A 唯一入口路由', () => {
  it('一般商机 → 派发 quote-engine（B 报价）', () => {
    const r = routeThroughIntake({ id: 'task-1', payload: { intent: 'quote', level: 'normal' } });
    expect(r.targetAgent).toBe('quote-engine');
    expect(r.gateAgents).toEqual([]);
    expect(r.payload.contract_task_id).toBeTruthy();
    expect(r.payload.dispatchedFrom).toBe('intake-router');
  });

  it('重大商机 → 派发 quote-engine + review-gate 把关（D）', () => {
    const r = routeThroughIntake({ id: 'task-2', payload: { intent: 'quote', level: 'major' } });
    expect(r.targetAgent).toBe('quote-engine');
    expect(r.gateAgents).toContain('review-gate');
    expect(r.payload.contract_task_id).toBeTruthy();
  });

  it('跟进意图 → 派发 followup-agent（C）', () => {
    const r = routeThroughIntake({ id: 'task-3', payload: { intent: 'followup', level: 'normal' } });
    expect(r.targetAgent).toBe('followup-agent');
  });
});