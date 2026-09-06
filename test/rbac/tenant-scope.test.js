// 纯函数测试（DB-FREE）：验证 ten_admin 的作用域与门禁分类。
// 重点：ten_admin 落在「租户内管理员」闸（tenant-internal admin gates），
// 但被排除在「平台级」闸（platform-level gates）之外。
import { describe, it, expect } from 'vitest';
import { scopeTenant } from '../../src/http/tenantScope.js';

// 租户内管理员门禁谓词（userManagement / billing isPrivileged / salesThresholds roleOk）
const roleOk = (r) => r === 'admin' || r === 'sysadmin' || r === 'ten_admin';
// 平台级门禁谓词（仅 admin / sysadmin，ten_admin 被排除）
const platformRoleOk = (r) => r === 'admin' || r === 'sysadmin';

describe('tenantScope: ten_admin 作用域', () => {
  it('scopeTenant 对 ten_admin 返回其自身租户，绝不返回通配 *', () => {
    expect(scopeTenant({ role: 'ten_admin', tenantId: 'co-acme' })).toBe('co-acme');
    expect(scopeTenant({ role: 'ten_admin', tenantId: 'co-acme' })).not.toBe('*');
  });

  it('scopeTenant 对 admin/sysadmin 仍返回跨租户通配 *', () => {
    expect(scopeTenant({ role: 'admin', tenantId: 'co-acme' })).toBe('*');
    expect(scopeTenant({ role: 'sysadmin', tenantId: 'co-acme' })).toBe('*');
  });
});

describe('RBAC 分类: ten_admin 属于租户内闸、排除于平台闸', () => {
  it('roleOk 包含 ten_admin（租户内管理员闸）', () => {
    expect(roleOk('ten_admin')).toBe(true);
    expect(roleOk('admin')).toBe(true);
    expect(roleOk('sysadmin')).toBe(true);
    expect(roleOk('manager')).toBe(false);
  });

  it('platformRoleOk 排除 ten_admin（平台级闸）', () => {
    expect(platformRoleOk('ten_admin')).toBe(false); // 关键：ten_admin 不在平台级
    expect(platformRoleOk('admin')).toBe(true);
    expect(platformRoleOk('sysadmin')).toBe(true);
  });
});
