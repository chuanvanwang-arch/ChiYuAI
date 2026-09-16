import { describe, it, expect } from 'vitest';
import { buildDailyDigest } from '../../src/signal/digest.js';

describe('signal digest（每日作战简报，对齐 Rox Daily Digest）', () => {
  it('按状态与严重度聚合 open 计数', () => {
    const signals = [
      { severity: 'high', status: 'open', target_role: 'sales', kind: 'deal_stuck' },
      { severity: 'low', status: 'open', target_role: 'ops', kind: 'lead_overdue' },
      { severity: 'medium', status: 'acted', target_role: 'ops', kind: 'lead_overdue' },
    ];
    const d = buildDailyDigest(signals);
    expect(d.open_high).toBe(1);
    expect(d.open_medium).toBe(0);
    expect(d.open_low).toBe(1);
    expect(d.open_total).toBe(2);
    expect(d.acted_total).toBe(1);
  });

  it('按角色分组（by_role）', () => {
    const signals = [
      { severity: 'high', status: 'open', target_role: 'sales', kind: 'deal_stuck' },
      { severity: 'low', status: 'open', target_role: 'ops', kind: 'lead_overdue' },
    ];
    const d = buildDailyDigest(signals);
    expect(d.by_role.sales.length).toBe(1);
    expect(d.by_role.ops.length).toBe(1);
  });

  it('空数组返回零值结构（不炸）', () => {
    const d = buildDailyDigest([]);
    expect(d.open_total).toBe(0);
    expect(d.acted_total).toBe(0);
    expect(d.by_role).toEqual({});
  });
});
