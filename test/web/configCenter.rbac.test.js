// test/web/configCenter.rbac.test.js — F3 id12 level + F2 propagation 元数据（无 DB）
import { describe, it, expect } from 'vitest';
import { CONFIG_ITEMS, LEVEL_GROUPS } from '../../src/portal/configCenter.js';

describe('configCenter RBAC 元数据 (F3 / F2)', () => {
  it('T4.1 id12 用户管理 level=tenant', () => {
    const it12 = CONFIG_ITEMS.find((i) => i.id === 12);
    expect(it12.level).toBe('tenant');
  });
  it('T4.2 id42 propagation 仅 ADMIN', () => {
    const g = LEVEL_GROUPS.find((l) => l.level === 'propagation');
    expect(g.roles).toContain('ADMIN');
    expect(g.roles).not.toContain('ten_admin');
  });
});
