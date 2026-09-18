// test/http/dealerRoutes.test.js — 经销商接入面 handler 级校验（DI 注入 fake，免 DB）
// 覆盖：厂商准入编排、列表、冲突列表、冲突仲裁；以及越权闸（非 channel_manager 拒 403）
import { describe, it, expect, beforeEach } from 'vitest';
import { createDealerRouter } from '../../src/http/dealerRoutes.js';

function mockRes() {
  const res = {};
  res._json = null; res._status = 200;
  res.status = (s) => { res._status = s; return res; };
  res.json = (o) => { res._json = o; return res; };
  return res;
}

function makeRouter(overrides = {}) {
  const calls = [];
  const deps = {
    ensureChannelManager: async () => ({ ok: true, username: 'cm', tenantId: 'vendor', role: 'channel_manager', vendorTenant: 'vendor' }),
    createDealerTenant: async ({ tenantId, dealerUser }) => { calls.push(['createDealerTenant', tenantId, dealerUser]); return { tenantId, dealerUser }; },
    onboardDealer: async (p) => { calls.push(['onboardDealer', p]); return { tenant: { tenantId: p.dealerTenant }, decisionId: 'dec-1' }; },
    produceDecision: async () => ({ decisionId: 'dec-x' }),
    resolveConflict: async () => ({ status: 'resolved', resolution: '归甲' }),
    ...overrides,
  };
  return { router: createDealerRouter({ deps }), calls };
}

describe('dealerRoutes — 厂商渠道管理面', () => {
  let h, calls, res;
  beforeEach(() => { const r = makeRouter(); h = r.router.handlers; calls = r.calls; res = mockRes(); });

  it('POST /api/dealers/onboard 经编排建租户+联邦+双向视图', async () => {
    const req = { body: { vendorTenant: 'vendor', dealerTenant: 'dealerA', dealerUser: 'da', dealerPass: 'pw', dealerName: '甲经销', region: '华东' } };
    await h.hOnboard(req, res);
    expect(res._status).toBe(200);
    expect(res._json.ok).toBe(true);
    expect(res._json.decisionId).toBe('dec-1');
    const onboard = calls.find((c) => c[0] === 'onboardDealer');
    expect(onboard).toBeTruthy();
    expect(onboard[1].dealerName).toBe('甲经销');
  });

  it('onboard 缺必填字段 → 400', async () => {
    const req = { body: { vendorTenant: 'vendor' } };
    await h.hOnboard(req, res);
    expect(res._status).toBe(400);
  });

  it('GET /api/dealers 列经销商', async () => {
    const req = { query: {}, params: {} };
    await h.hListDealers(req, res);
    expect(res._status).toBe(200);
    expect(res._json).toHaveProperty('dealers');
  });

  it('GET /api/dealers/conflicts 列冲突', async () => {
    const req = { query: {}, params: {} };
    await h.hListConflicts(req, res);
    expect(res._status).toBe(200);
    expect(res._json).toHaveProperty('conflicts');
  });

  it('POST /api/dealers/conflicts/:id/resolve 仲裁', async () => {
    const req = { params: { id: '2026-01-01T00:00:00.000Z' }, body: { resolution: '归甲' } };
    await h.hResolveConflict(req, res);
    expect(res._status).toBe(200);
    expect(res._json.ok).toBe(true);
  });
});

describe('dealerRoutes — 越权闸', () => {
  it('非 channel_manager 被拒 403', async () => {
    const { router } = makeRouter({
      ensureChannelManager: async (req, res) => { res.status(403).json({ error: 'forbidden' }); return null; },
    });
    const res = mockRes();
    const req = { body: { vendorTenant: 'vendor', dealerTenant: 'd', dealerUser: 'u', dealerPass: 'p', dealerName: 'x', region: 'r' } };
    await router.handlers.hOnboard(req, res);
    expect(res._status).toBe(403);
  });
});
