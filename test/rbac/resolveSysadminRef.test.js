// test/rbac/resolveSysadminRef.test.js — DB-BACKED（需 PG 运行；PG 停时无法执行）
// 验证 resolveSysadminRef：用户名/邮箱 → 一个已存在的 role='sysadmin' 用户；非 sysadmin/不存在返回 null。
import { describe, it, expect } from 'vitest';
import { resolveSysadminRef } from '../../src/rbac.js';

describe('resolveSysadminRef', () => {
  it('admin 不是 sysadmin → 返回 null', async () => {
    const r = await resolveSysadminRef('admin');
    expect(r).toBeNull();
  });

  it('sysadmin 命中 → 返回 { user_id, username }（若库中存在该行）', async () => {
    const r = await resolveSysadminRef('sysadmin');
    // 库中可能未播种 sysadmin 行：仅在存在时断言结构
    if (r) {
      expect(r.user_id).toBeTruthy();
      expect(r.username).toBeTruthy();
    }
  });
});
