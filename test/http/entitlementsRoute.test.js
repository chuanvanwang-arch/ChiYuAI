// test/http/entitlementsRoute.test.js（DB-free，mock）
import { expect, test, vi } from 'vitest';
import express from 'express';
import http from 'http';
import { createBillingRouter } from '../../src/http/billingRoutes.js';

vi.mock('../../src/billing/billingService.js', () => ({ /* 不影响本端点 */ }));
vi.mock('../../src/billing/entitlements.js', () => ({ resolveEntitlements: async () => new Set(['core_crm', 'customer_360']) }));
vi.mock('../../src/http/auth.js', () => ({ resolveMe: () => ({ ok: true, role: 'sales', tenantId: 't1' }) }));
vi.mock('../../src/http/tenantScope.js', () => ({ applyTenantOverride: (r, m) => m.tenantId || 't1', scopeTenant: (m) => m.tenantId || 't1' }));

test('GET /api/billing/entitlements 返回权益集', async () => {
  const app = express();
  app.use(createBillingRouter());
  await new Promise((resolve, reject) => {
    const srv = app.listen(0, async () => {
      try {
        const port = srv.address().port;
        const res = await new Promise((r) => http.get(`http://127.0.0.1:${port}/api/billing/entitlements`, (x) => { let d = ''; x.on('data', (c) => (d += c)); x.on('end', () => r({ status: x.statusCode, body: JSON.parse(d) })); }));
        expect(res.status).toBe(200);
        expect(res.body.entitlements).toContain('customer_360');
        srv.close(() => resolve());
      } catch (e) { srv.close(() => reject(e)); }
    });
  });
});
