// test/http/tenantRouter.test.js — DB-BACKED（需 PG 运行；PG 停时无法执行）
// 验证 tenantRouter 默认 listTenants 实现：
//   1) listTenants() 返回数组；
//   2) listTenants(createdBy) 过滤时，每行 created_by_username 均包含过滤串。
// 经 router.listTenants 测试接缝直接调用真实 SQL（见 tenantRouter.js 暴露的 router.listTenants）。
import { describe, it, expect, beforeAll } from 'vitest';
import { createTenantRouter } from '../../src/http/tenantRouter.js';

let router;
beforeAll(() => {
  router = createTenantRouter();
});

describe('tenantRouter.listTenants', () => {
  it('listTenants() 返回数组', async () => {
    const rows = await router.listTenants();
    expect(Array.isArray(rows)).toBe(true);
  });

  it('listTenants(createdBy) 过滤：每行 created_by_username 均含过滤串', async () => {
    const filter = 'sys';
    const rows = await router.listTenants(filter);
    expect(Array.isArray(rows)).toBe(true);
    for (const row of rows) {
      expect(String(row.created_by_username || '').toLowerCase()).toContain(filter);
    }
  });
});
