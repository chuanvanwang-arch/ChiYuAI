// test/kanban/gate-block.test.js — gateBlockTask / approveGateBlock（② gate 阻断式）
import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../../src/db.js', () => ({ query: vi.fn(), queryWrite: vi.fn() }));
import { query, queryWrite } from '../../src/db.js';
import { gateBlockTask, approveGateBlock } from '../../src/kanban/kanban.js';

const mockTask = (over = {}) => ({ id: 't1', status: 'running', block_kind: null, error: null, consecutive_failures: 0, ...over });

describe('gateBlockTask', () => {
  beforeEach(() => vi.clearAllMocks());
  it('running → blocked(gate_reject)', async () => {
    query.mockResolvedValue({ rows: [mockTask({ status: 'running' })] });
    queryWrite.mockResolvedValue({ rows: [{ id: 't1', status: 'blocked', block_kind: 'gate_reject' }] });
    const gate = { 'review-gate': { ok: false, verdict: 'reject', defects: ['毛利不达标'] } };
    const r = await gateBlockTask('t1', { gate });
    expect(r.status).toBe('blocked');
    expect(queryWrite.mock.calls[0][0]).toContain("status='blocked'");
    expect(queryWrite.mock.calls[0][0]).toContain("block_kind='gate_reject'");
  });
  it('非 running 抛错', async () => {
    query.mockResolvedValue({ rows: [mockTask({ status: 'done' })] });
    await expect(gateBlockTask('t1', {})).rejects.toThrow('不可 gate 阻断');
  });
});

describe('approveGateBlock', () => {
  beforeEach(() => vi.clearAllMocks());
  it('blocked(gate_reject) → done', async () => {
    query.mockResolvedValue({ rows: [mockTask({ status: 'blocked', block_kind: 'gate_reject' })] });
    queryWrite.mockResolvedValue({ rows: [{ id: 't1', status: 'done' }] });
    const r = await approveGateBlock('t1', { byActor: 'user' });
    expect(r.status).toBe('done');
    expect(queryWrite.mock.calls[0][0]).toContain("status='done'");
  });
  it('非 blocked(gate_reject) 抛错', async () => {
    query.mockResolvedValue({ rows: [mockTask({ status: 'running' })] });
    await expect(approveGateBlock('t1', {})).rejects.toThrow('不在 blocked(gate_reject)');
  });
});
