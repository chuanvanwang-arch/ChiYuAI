// test/http/propagationRoutes.test.js — F2 gateAccept memory_promote 单元验证（无 DB）
import { describe, it, expect } from 'vitest';
import { gateAccept } from '../../src/http/propagationRoutes.js';

describe('gateAccept memory_promote (F2)', () => {
  const tenAdmin = { ok: true, role: 'ten_admin', tenantId: 'T1', username: 'ta' };
  const sysadmin = { ok: true, role: 'sysadmin', tenantId: 'T1', username: 'sa' };
  const admin = { ok: true, role: 'admin', tenantId: 'T1', username: 'ad' };

  it('T3.1 ten_admin 同租户推广放行', () => {
    const g = gateAccept(tenAdmin, { kind: 'memory_promote', tenantId: 'T1' });
    expect(g.ok).toBe(true);
  });
  it('T3.2 ten_admin 上行至 system 拒', () => {
    const g = gateAccept(tenAdmin, { kind: 'memory_promote', tenantId: 'system' });
    expect(g.ok).toBe(false); expect(g.status).toBe(403);
  });
  it('T3.3 ten_admin 推广至他租户拒', () => {
    const g = gateAccept(tenAdmin, { kind: 'memory_promote', tenantId: 'T2' });
    expect(g.ok).toBe(false); expect(g.status).toBe(403);
  });
  it('T3.4 sysadmin 上行至 system 放行', () => {
    const g = gateAccept(sysadmin, { kind: 'memory_promote', tenantId: 'system' });
    expect(g.ok).toBe(true);
  });
  it('T3.5 admin 上行至 system 放行', () => {
    const g = gateAccept(admin, { kind: 'memory_promote', tenantId: 'system' });
    expect(g.ok).toBe(true);
  });
  it('config_store system 目标仅 ADMIN（回归）', () => {
    const g = gateAccept(tenAdmin, { kind: 'config_store', patch: { tenant_id: 'system' } });
    expect(g.ok).toBe(false); expect(g.status).toBe(403);
  });
});
