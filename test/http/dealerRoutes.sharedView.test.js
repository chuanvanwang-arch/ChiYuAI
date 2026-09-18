// test/http/dealerRoutes.sharedView.test.js — 锁死 hSharedView 假绿回归
// 背景：federationReadScope 返回【数组】，旧实现误读 scope.tenantIds/.vendor/.grants（恒 undefined）
//       导致 /api/dealers/shared-view 返回空字段。本测试断言修复后返回可用数组与真值。
// 独立文件 + 部分 mock：仅覆盖 hSharedView 依赖的三个底层模块，不影响 dealerRoutes.test.js。
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/http/auth.js', async (importOriginal) => ({
  ...(await importOriginal()),
  resolveMe: (req) => req.__me || { ok: false, error: 'no-me' },
}));
vi.mock('../../src/federation/scope.js', async (importOriginal) => ({
  ...(await importOriginal()),
  federationReadScope: async () => ['dealer1', 'vendor'],
}));
vi.mock('../../src/federation/config.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getFederation: async () => ({ vendor_tenant: 'vendor' }),
}));
vi.mock('../../src/config/configStore.js', async (importOriginal) => ({
  ...(await importOriginal()),
  readConfig: async () => ({
    value: [{ from_tenant: 'vendor', to_tenant: 'dealer1', direction: 'push', particle_types: ['CRM_OFFER_POLICY'], read_only: true }],
  }),
}));

import { createDealerRouter } from '../../src/http/dealerRoutes.js';

function mockRes() {
  const res = {};
  res._json = null; res._status = 200;
  res.status = (s) => { res._status = s; return res; };
  res.json = (o) => { res._json = o; return res; };
  return res;
}

describe('dealerRoutes — GET /api/dealers/shared-view（经销商只读视图）', () => {
  it('dealer_user 调用返回 readableTenants 数组 + 真值 vendorTenant/grants', async () => {
    const router = createDealerRouter({});
    const res = mockRes();
    const req = { __me: { ok: true, tenantId: 'dealer1', role: 'dealer_user' } };
    await router.handlers.hSharedView(req, res);
    expect(res._status).toBe(200);
    expect(Array.isArray(res._json.readableTenants)).toBe(true);
    expect(res._json.readableTenants).toEqual(['dealer1', 'vendor']); // 数组，非 undefined
    expect(res._json.vendorTenant).toBe('vendor');
    expect(Array.isArray(res._json.grants) && res._json.grants.length >= 1).toBe(true);
  });

  it('非 dealer_user 角色被拒 403', async () => {
    const router = createDealerRouter({});
    const res = mockRes();
    const req = { __me: { ok: true, tenantId: 'dealer1', role: 'sales' } };
    await router.handlers.hSharedView(req, res);
    expect(res._status).toBe(403);
  });
});
