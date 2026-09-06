// test/sales/listUnassignedAccounts.test.js
// 2026-08-31 根因修复：listUnassignedAccounts 纯函数（src/sales/namedAccountBoard.js）
// 消费方：/api/board/named-accounts?includeUnassigned=1（admin/manager 视角）
// 设计：零 DB、可单测；过滤 named_owner/owner_id/owner 三键全空 + 字段映射（id/name/tier/state/created_at）
import { describe, it, expect } from 'vitest';
import { listUnassignedAccounts } from '../../src/sales/namedAccountBoard.js';

describe('listUnassignedAccounts（2026-08-31 root cause fix 配套纯函数）', () => {
  it('空数组 → 空数组', () => {
    expect(listUnassignedAccounts([])).toEqual([]);
    expect(listUnassignedAccounts(null)).toEqual([]);
  });

  it('named_owner 已设置 → 过滤掉', () => {
    const rows = listUnassignedAccounts([
      { id: 'a1', state: 'active', created_at: '2026-01-01', payload: { name: '已分配-A', named_owner: 'alice' } },
    ]);
    expect(rows).toEqual([]);
  });

  it('三键全空 → 进入无主分桶；name 优先 payload.name → slug → id', () => {
    const rows = listUnassignedAccounts([
      { id: 'uuid-1', slug: 'account-slug', state: 'potential', created_at: '2026-08-31', payload: { name: '青煜智能', industry: '智能' } },
      { id: 'uuid-2', slug: 'no-name-slug', state: 'potential', created_at: '2026-08-30', payload: { industry: '制造' } },
    ]);
    expect(rows.length).toBe(2);
    expect(rows[0].name).toBe('青煜智能');
    expect(rows[0].tier).toBe('潜力'); // payload.named_tier/tier 都缺，兜底
    expect(rows[1].name).toBe('no-name-slug'); // slug 兜底
  });

  it('owner_id/owner 任一存在 → 不进无主（兼容旧字段约定）', () => {
    const rows = listUnassignedAccounts([
      { id: 'x1', payload: { name: '旧-data-A', owner_id: 'bob' } }, // owner_id 设了，剔除
      { id: 'x2', payload: { name: '旧-data-B', owner: 'carol' } }, // owner 设了，剔除
      { id: 'x3', payload: { name: '旧-data-C' } }, // 完全无主，留
    ]);
    expect(rows.length).toBe(1);
    expect(rows[0].name).toBe('旧-data-C');
  });

  it('non-array 输入安全返回空', () => {
    expect(listUnassignedAccounts('not-array')).toEqual([]);
    expect(listUnassignedAccounts({})).toEqual([]);
  });
});
