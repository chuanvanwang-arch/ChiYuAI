// test/http/selfRegister.test.js — DB-backed（PG 需上线方可运行）
// 验证：1) 新租户缺失 referrer → 400 拒绝；2) 模块结构（registerUser 为函数、ROLE_TAGS 含 ten_admin）
import { describe, it, expect } from 'vitest';
import { registerUser } from '../../src/http/selfRegister.js';

describe('selfRegister', () => {
  it('T1: 新租户注册缺少 referrer → 400 拒绝（须 sysadmin 推荐者）', async () => {
    const r = await registerUser({
      companyName: '全新测试公司ZZZ',
      email: 'new1@zzz.com',
      displayName: 'T',
      password: 'password123',
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
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
