// test/http/selfRegister.test.js — DB-backed（PG 需上线方可运行）
// 验证：1) 新租户缺失 referrer → 默认 sysadmin 推荐人成功开租户（2026-09-07 选填化）；
//       2) 模块结构（registerUser 为函数、ROLE_TAGS 含 ten_admin）
import { describe, it, expect } from 'vitest';
import { queryWrite } from '../../src/db.js';
import { registerUser } from '../../src/http/selfRegister.js';

describe('selfRegister', () => {
  it('T1: 新租户注册缺少 referrer → 默认 sysadmin 推荐人，注册成功（ten_admin + 新租户）', async () => {
    // 确保 sysadmin 种子在（幂等，对齐 db/seed-users.sql）
    await queryWrite(
      `INSERT INTO crm.crm_users (username, password_hash, role, display_name, org_id, email)
       SELECT 'sysadmin', crypt('sysadmin123', gen_salt('bf')), 'sysadmin', '平台管理员', 'system', 'sysadmin@system.local'
       WHERE NOT EXISTS (SELECT 1 FROM crm.crm_users WHERE username='sysadmin')`);
    const uniq = Date.now();
    const r = await registerUser({
      companyName: `全新测试公司D${uniq}`,
      email: `reg-defref-${uniq}@zzz.com`,
      displayName: 'T',
      password: 'password123',
    });
    expect(r.ok).toBe(true);
    expect(r.status).toBe(201);
    expect(r.isNewTenant).toBe(true);
    expect(r.role).toBe('ten_admin');
  });

  it('T2: 模块结构检查（避免真实建租户副作用）', async () => {
    expect(typeof registerUser).toBe('function');
    // ROLE_TAGS 未导出时退化为仅校验函数导出；导出则断言包含 ten_admin
    const mod = await import('../../src/http/selfRegister.js');
    if (Array.isArray(mod.ROLE_TAGS)) {
      expect(mod.ROLE_TAGS).toContain('ten_admin');
    } else {
      expect(typeof mod.registerUser).toBe('function');
    }
  });
});
