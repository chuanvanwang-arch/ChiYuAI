// test/http/workbenchTuningScope.test.js
// 「参数调优」视角的两道守卫（2026-09-17 修复的回归锚点）：
//
// ① 可见性闸：设计 docs/2026-09-05-param-closedloop-adaptive-design.md §2.4 明定
//    「PENDING 处方视角仅 ADMIN/SYSADMIN/tan_admin 可见，普通 sales 不可见」。
//    原实现 `case 'tuning'` **缺此闸** ⇒ 任何登录用户 GET ?view=tuning 都能拿到 queryPatches 结果。
//
// ② 租户收窄：queryPatches 必须对租户管理员下发 tenantFilter=本租户。
//    原实现按裸字面量比对（只列 'TAN_ADMIN' | 'tan_admin'），漏掉真实落库名 **ten_admin**
//    ⇒ tenantFilter 落 null ⇒ SQL `$1::text IS NULL OR tenant_id=$1` 命中【全平台】PENDING 处方（越权读）。
//    实证：角色 ten_admin 时返回 50 行（system 租户），tan_admin 时 0 行（正确收窄）。
import { describe, it, expect, vi } from 'vitest';

// 捕获真实下发的 SQL 参数（mock db 而非 mock queryPatches —— 要验的正是它算出的过滤值）
const captured = [];
vi.mock('../../src/db.js', () => ({
  query: vi.fn(async (sql, params) => { captured.push({ sql, params }); return { rows: [] }; }),
  pool: { query: vi.fn(async () => ({ rows: [] })) },
  poolRead: { query: vi.fn(async () => ({ rows: [] })) },
  queryWrite: vi.fn(async () => ({ rows: [] })),
  queryRead: vi.fn(async () => ({ rows: [] })),
  withTx: vi.fn(async () => ({ rows: [] })),
}));

import { buildViewRows, defaultDeps } from '../../src/http/workbenchRouter.js';

const ME = 'tenant-one';
const actor = (role) => ({ username: `u-${role}`, roles: [role], tenantId: ME });

function makeDeps() {
  const calls = [];
  return {
    calls,
    deps: {
      ...defaultDeps,
      queryPatches: async (a) => {
        calls.push(a);
        return [{ patch_id: 'P1', knob: 'k1', target: 'target', tenant_id: 'system', risk: 'LOW' }];
      },
    },
  };
}

describe('tuning 视角：可见性闸（§2.4）', () => {
  for (const role of ['sales', 'manager', 'presales', 'finance']) {
    it(`${role} → 空列表，且不触达 queryPatches（fail-closed，不抛错）`, async () => {
      const { deps, calls } = makeDeps();
      const rows = await buildViewRows('tuning', actor(role), deps);
      expect(rows).toEqual([]);
      expect(calls, `${role} 不该查到处方`).toHaveLength(0);
    });
  }

  for (const role of ['ten_admin', 'tan_admin', 'tan-admin', 'sysadmin', 'admin']) {
    it(`${role} → 可见本租户处方`, async () => {
      const { deps, calls } = makeDeps();
      const rows = await buildViewRows('tuning', actor(role), deps);
      expect(calls).toHaveLength(1);
      expect(rows).toHaveLength(1);
    });
  }
});

describe('queryPatches：租户管理员必须收窄到本租户（$1）', () => {
  const tenantAdminRoles = ['ten_admin', 'tan_admin', 'tan-admin', 'tenant-admin', 'TAN_ADMIN'];
  for (const role of tenantAdminRoles) {
    it(`${role} → $1 = 本租户（ten_admin 曾漏，退化为全平台）`, async () => {
      captured.length = 0;
      await defaultDeps.queryPatches(actor(role));
      expect(captured).toHaveLength(1);
      expect(captured[0].params[0]).toBe(ME);
      expect(captured[0].sql).toContain('tenant_id=$1');
    });
  }

  for (const role of ['admin', 'sysadmin']) {
    it(`${role} → $1 = null（跨租户可见，不变）`, async () => {
      captured.length = 0;
      await defaultDeps.queryPatches(actor(role));
      expect(captured[0].params[0]).toBe(null);
    });
  }

  it('越权兜底：即便绕过视角闸直接调数据源，sales 也不会拿到租户管理员的收窄视界', async () => {
    captured.length = 0;
    await defaultDeps.queryPatches(actor('sales'));
    expect(captured[0].params[0]).toBe(null); // 该角色由视角闸拦截；数据源层不做收窄（不假装安全）
  });
});
