// 字段级历史视图（P1③）：查 audit_event.payload 投影 before→after + actor + decision_id
// TDD：projectFieldHistory 纯函数（可注入）—— 计划 §Task4
import { describe, it, expect } from 'vitest';
import { projectFieldHistory } from '../../src/http/fieldHistory.js';

describe('projectFieldHistory 字段投影', () => {
  const events = [
    { payload: { particle_id: 'p1', field: 'amount', before: 100, after: 200, price_change_reason: '折扣' }, actor: 'alice', decision_id: 'd1', created_at: '2026-09-01T00:00:00Z' },
    { payload: { particle_id: 'p1', field: 'amount', before: 200, after: 150 }, actor: 'bob', decision_id: 'd2', created_at: '2026-09-02T00:00:00Z' },
    { payload: { particle_id: 'p1', field: 'other', before: 'x', after: 'y' }, actor: 'carol', decision_id: null, created_at: '2026-09-03T00:00:00Z' },
  ];

  it('投影指定字段：只返回 amount 的 before/after', () => {
    const rows = projectFieldHistory(events, 'amount');
    expect(rows.length).toBe(2);
    expect(rows[0].before).toBe(100);
    expect(rows[0].after).toBe(200);
    expect(rows[0].actor).toBe('alice');
    expect(rows[0].decision_id).toBe('d1');
  });

  it('无匹配字段返回空', () => {
    const rows = projectFieldHistory(events, 'nope');
    expect(rows).toEqual([]);
  });

  it('时间升序（旧→新，时间线顺序）', () => {
    const rows = projectFieldHistory(events, 'amount');
    expect(rows[0].created_at < rows[1].created_at).toBe(true);
  });

  it('空事件返回空', () => {
    expect(projectFieldHistory([], 'amount')).toEqual([]);
  });
});
