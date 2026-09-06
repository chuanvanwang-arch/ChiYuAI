// 对象级 ACL（P1④）：visible_roles[] / confidential 过滤
// TDD：scopePredicate 第 4 参数 opts 扩展 —— 计划 §Task2
import { describe, it, expect } from 'vitest';
import { scopePredicate } from '../../src/context/scope.js';

describe('scopePredicate 对象级 ACL', () => {
  const profileAll = { data_scope: { model: 'all' } };
  const profileSelf = { data_scope: { model: 'self' } };

  it('visible_roles 为空数组 = 不限制（缺省开放）', () => {
    const p = scopePredicate(profileAll, 'alice', [], { visibleRoles: [] });
    expect(p.clause).toBe('');
    expect(p.params).toEqual([]);
  });

  it('meta.visible_roles 非空：SQL 追加 ?| 角色匹配', () => {
    const p = scopePredicate(profileAll, 'alice', [], { visibleRoles: ['sales'] });
    expect(p.clause).toContain('visible_roles');
    expect(p.clause).toContain('?|');
    expect(JSON.stringify(p.params)).toContain('sales'); // params 为嵌套数组（pg 参数占位）
  });

  it('confidential=true：隐式仅 exec/sysadmin 可见（profile.model=all 时也过滤）', () => {
    const p = scopePredicate(profileAll, 'alice', [], { confidential: true, role: 'sales' });
    expect(p.clause).toContain('confidential');
    expect(p.clause).toContain('exec');
    expect(p.clause).toContain('sysadmin');
  });

  it('self 模型 + visible_roles 叠加（同谓词链）', () => {
    const p = scopePredicate(profileSelf, 'alice', [], { visibleRoles: ['manager'] });
    expect(p.clause).toContain('owner_id');
    expect(p.clause).toContain('visible_roles');
  });
});
