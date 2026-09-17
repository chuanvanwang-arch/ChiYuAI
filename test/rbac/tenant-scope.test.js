// 纯函数测试（DB-FREE）：验证 ten_admin 的作用域与门禁分类。
// 重点：ten_admin 落在「租户内管理员」闸（tenant-internal admin gates），
// 但被排除在「平台级」闸（platform-level gates）之外。
//
// ⚠ 2026-09-17 改造：原实现把门禁谓词**在本文件内复刻**（`const roleOk = (r) => ...`），
//   等于测试自己的字面量 —— 生产代码里少一个角色也照样全绿（守卫永不触发 = 假绿）。
//   现改为直接消费 src/http/middleware/rbac.js 的单一事实源。
import { describe, it, expect } from 'vitest';
import { scopeTenant } from '../../src/http/tenantScope.js';
import { canWriteTenantConfig, hasRole, normalizeRole } from '../../src/http/middleware/rbac.js';

// 租户内管理员门禁（生产实现：canWriteTenantConfig —— 4 个租户级配置路由的共用判定）
// 平台级门禁（生产实现：hasRole(me,'ADMIN') 或 hasRole(me,'sysadmin')，ten_admin 被排除）

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
  it('canWriteTenantConfig 包含 ten_admin 与历史别名 tan_admin（租户内管理员闸）', () => {
    expect(canWriteTenantConfig({ role: 'ten_admin' })).toBe(true); // canonical 落库名
    expect(canWriteTenantConfig({ role: 'tan_admin' })).toBe(true); // 历史别名，同权
    expect(canWriteTenantConfig({ role: 'admin' })).toBe(true);
    expect(canWriteTenantConfig({ role: 'sysadmin' })).toBe(true);
    expect(canWriteTenantConfig({ role: 'manager' })).toBe(false);
    expect(canWriteTenantConfig({ role: 'sales' })).toBe(false);
  });

  it('平台级闸排除 ten_admin（ten_admin 不在平台级）', () => {
    expect(hasRole({ role: 'ten_admin' }, 'ADMIN')).toBe(false); // 关键：ten_admin 不在平台级
    expect(hasRole({ role: 'ten_admin' }, 'sysadmin')).toBe(false);
    expect(hasRole({ role: 'admin' }, 'ADMIN')).toBe(true);
    expect(hasRole({ role: 'sysadmin' }, 'sysadmin')).toBe(true);
    // 归一事实源：别名与 canonical 等价（旧行为漂移的根源）
    expect(normalizeRole('ten_admin')).toBe(normalizeRole('tan_admin'));
  });
});
