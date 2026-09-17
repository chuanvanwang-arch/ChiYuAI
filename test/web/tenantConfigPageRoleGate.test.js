// test/web/tenantConfigPageRoleGate.test.js
// 租户级配置页「前端角色闸」守卫（2026-09-17）
//
// 【回归目标】
//   后端 4 处租户级路由的 level 闸已能放行 ten_admin，但前端配置页各自复制了裸比较
//   `r?.role !== 'admin' && r?.role !== 'sysadmin'` ⇒ 真实租户管理员打开页面被**整页**拦
//   （#app 隐藏 + #forbidden 显示）——「后端放行、前端拦住」的界面级伪隔离，用户感知仍是不可用。
//
// 【判据】
//   ① 前后端判定必须逐角色同结果（前端 canEditTenantConfig vs 后端 canWriteTenantConfig）——
//      这是防「一处改了另一处没改」的根因式守卫；
//   ② 4 个配置页必须消费共享判定，且（剥注释后）不得残留裸比较。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canEditTenantConfig, TENANT_CONFIG_ROLES } from '../../src/web/api.js';
import { canWriteTenantConfig } from '../../src/http/middleware/rbac.js';

const root = process.cwd();
// 剥整行注释后断言 —— 禁止用测试自身的说明注释/源码注释命中（同族教训已登记两次）
const codeOnly = (s) => s.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

const PAGES = [
  'src/web/behavior-standard-config.html', // /api/config/behavior-standard (CONFIG_ITEMS #31 level=tenant)
  'src/web/finance-receivables.html',      // /api/config/finance-receivables (#29 level=tenant)
  'src/web/named-account-targets.html',    // /api/config/named-account-targets (#30 level=tenant)
  'src/web/sales-thresholds-config.html',  // /api/config/sales-thresholds (#32 level=tenant)
];

const ALL_ROLES = [
  'admin', 'ADMIN', 'sysadmin', 'SYSADMIN', 'sys-admin',
  'ten_admin', 'tan_admin', 'tan-admin', 'tenant-admin', 'TAN_ADMIN',
  'sales', 'manager', 'presales', 'finance', 'contract_admin',
  '', 'system', undefined, null,
];

describe('前后端租户级配置角色判定必须一致（防单边修复）', () => {
  it('逐角色同结果', () => {
    for (const role of ALL_ROLES) {
      expect(canEditTenantConfig(role), `角色 ${JSON.stringify(role)} 前后端判定不一致`).toBe(
        canWriteTenantConfig({ role })
      );
    }
  });

  it('前端可编辑角色集含 canonical 名 ten_admin 与历史别名 tan_admin', () => {
    expect(TENANT_CONFIG_ROLES).toContain('ten_admin');
    expect(TENANT_CONFIG_ROLES).toContain('tan_admin');
    // 业务角色不得混入
    for (const r of ['sales', 'manager', 'presales', 'finance']) {
      expect(TENANT_CONFIG_ROLES).not.toContain(r);
    }
  });
});

describe('配置页必须消费共享判定，不得各自复制裸比较', () => {
  for (const rel of PAGES) {
    describe(rel, () => {
      const src = readFileSync(join(root, rel), 'utf8');
      const code = codeOnly(src);

      it('从 /portal/api.js 导入 canEditTenantConfig', () => {
        expect(src).toMatch(/import\s*\{[^}]*canEditTenantConfig[^}]*\}\s*from\s*['"]\/portal\/api\.js['"]/);
      });

      it('guard 调用 canEditTenantConfig(r?.role)', () => {
        expect(code).toContain('canEditTenantConfig(r?.role)');
      });

      it('（剥注释后）无 admin/sysadmin 裸比较残留', () => {
        expect(code).not.toMatch(/r\?\.role\s*!==\s*'admin'\s*&&\s*r\?\.role\s*!==\s*'sysadmin'/);
        expect(code).not.toMatch(/r\?\.role\s*===\s*'admin'\s*\|\|\s*r\?\.role\s*===\s*'sysadmin'/);
      });
    });
  }
});
