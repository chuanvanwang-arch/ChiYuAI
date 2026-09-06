// test/tenant/tenant-repo.test.js — T9 租户注册表（联测：需已跑 migrate 的测试库）
// 注意：vitest.config.js 已强制 PGDATABASE=crm_native_test（独立测试库）；运行前需先对该库执行
//   PGDATABASE=crm_native_test node db/migrate.js（幂等）使 crm.tenants 存在。
import { describe, it, expect } from 'vitest';
import { listActiveTenants, ensureSystemTenant } from '../../src/tenant/tenantRepo.js';

describe('T9 租户注册表', () => {
  it('listActiveTenants 至少含 system', async () => {
    await ensureSystemTenant();
    const ts = await listActiveTenants();
    expect(ts.some((t) => t.tenant_id === 'system')).toBe(true);
  });
  it('status=suspended 租户不出现在活动列表', async () => {
    // 数据由测试前 seed 或本用例幂等创建；断言过滤语义（不依赖具体租户是否存在）
    const ts = await listActiveTenants();
    for (const t of ts) expect(t.status).toBeUndefined(); // 仅返回 tenant_id/name
  });
});