// test/http/tenantLevelConfigRoleGate.test.js
// 租户级配置角色闸一致性守卫（2026-09-17）
//
// 【回归目标 · 实证缺陷】
//   4 处 level='tenant' 的配置路由各自手写 `role === 'admin' || role === 'sysadmin'` 裸比较，
//   漏掉真实租户管理员落库名 ten_admin ⇒ 上层 §15 level 闸（createConfigLevelGate，按 normalizeRole
//   双边归一）放行，下层 router 闸却 403 —— 同一角色、同一 level、两套结果（闸不一致）。
//   现网反证（角色 tan_admin）：/api/config/sales-thresholds（已修范例）→ 200；
//     /api/config/finance-receivables | named-account-targets | seven-dim → 403。
//
// 【判据】用替身 resolveMe 真跑各 router 的 handler（不 mock 判定函数本身）：
//   ① ten_admin（canonical 落库名）与 tan_admin（历史别名）都必须放行；
//   ② sales / manager 必须 403 —— 防「修漏杀」被顺手放宽成「放所有人」。
import { describe, it, expect, vi, beforeEach } from 'vitest';

// resolveMe 替身：这些 router 内部硬编码 import realResolveMe，无法走构造注入，
// 故在模块层替换（vi.mock 被提升到所有 import 之前）。
const mockMe = { current: null };
vi.mock('../../src/http/auth.js', () => ({ resolveMe: async () => mockMe.current }));

import { createBehaviorStandardRouter } from '../../src/http/behaviorStandardRouter.js';
import { createFinanceReceivablesConfigRouter } from '../../src/http/financeReceivablesConfigRouter.js';
import { createNamedAccountTargetsRouter } from '../../src/http/namedAccountTargetsRouter.js';
import { createSevenDimRouter } from '../../src/http/sevenDimRouter.js';
import { canWriteTenantConfig, isTenantAdmin } from '../../src/http/middleware/rbac.js';

function fakeRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(c) { res.statusCode = c; return res; },
    json(b) { res.body = b; return res; },
    type() { return res; },
    send(b) { res.body = b; return res; },
  };
  return res;
}

// Express 4：router.stack[i].route.{path,methods} + .route.stack[0].handle
function handlerOf(router, path, method) {
  const layer = (router.stack || []).find(
    (l) => l?.route?.path === path && l.route.methods?.[method]
  );
  if (!layer) throw new Error(`未注册 ${method.toUpperCase()} ${path}`);
  return layer.route.stack[0].handle;
}

const T1 = 'tenant-one';
const CASES = [
  ['ten_admin', true],
  ['tan_admin', true],      // 历史别名，必须与 canonical 同权
  ['tan-admin', true],      // 连字符变体
  ['sysadmin', true],
  ['admin', true],
  ['sales', false],         // 负向：不得被放宽
  ['manager', false],
];

// 被测端点：[名称, 取 handler, 是否用空 body PUT（GET 走角色闸的端点用 GET）]
const ENDPOINTS = [
  {
    name: 'PUT /api/config/behavior-standard (level=tenant)',
    // 该端点 GET 是公开的（目标公开给销售），角色闸只在 PUT 上 ⇒ 必须以 PUT 驱动。
    // 空 body ⇒ 过闸后落 400「无可更新字段」（零写库副作用），被闸拦则 403。
    make: () => ({ handler: handlerOf(createBehaviorStandardRouter(), '/api/config/behavior-standard', 'put'), req: { headers: {}, body: {} } }),
    passCode: 400, missCode: 403,
  },
  {
    name: 'GET /api/config/finance-receivables (level=tenant)',
    make: () => ({ handler: handlerOf(createFinanceReceivablesConfigRouter(), '/api/config/finance-receivables', 'get'), req: { headers: {}, query: {} } }),
    passCode: 200, missCode: 403,
  },
  {
    name: 'GET /api/config/named-account-targets (level=tenant)',
    make: () => ({ handler: handlerOf(createNamedAccountTargetsRouter(), '/api/config/named-account-targets', 'get'), req: { headers: {}, query: {} } }),
    passCode: 200, missCode: 403,
  },
  {
    name: 'GET /api/config/seven-dim (level=tenant)',
    make: () => ({ handler: handlerOf(createSevenDimRouter(), '/api/config/seven-dim', 'get'), req: { headers: {}, query: {} } }),
    passCode: 200, missCode: 403,
  },
];

describe('租户级配置角色闸：判定收敛到 rbac 单一事实源', () => {
  beforeEach(() => { mockMe.current = null; });

  it('契约：canWriteTenantConfig 认 ten_admin（canonical）与 tan_admin（别名），拒业务角色', () => {
    for (const r of ['ten_admin', 'tan_admin', 'tan-admin', 'tenant-admin', 'TAN_ADMIN', 'sysadmin', 'admin']) {
      expect(canWriteTenantConfig({ role: r }), `${r} 应放行`).toBe(true);
    }
    for (const r of ['sales', 'manager', 'presales', 'finance', 'contract_admin', '', undefined, null]) {
      expect(canWriteTenantConfig({ role: r }), `${r} 应拒绝`).toBe(false);
    }
    expect(isTenantAdmin({ role: 'ten_admin' })).toBe(true);
    expect(isTenantAdmin({ role: 'tan_admin' })).toBe(true);
    expect(isTenantAdmin({ role: 'admin' })).toBe(false);
    // fail-closed：非对象/缺角色一律拒
    expect(canWriteTenantConfig(null)).toBe(false);
    expect(canWriteTenantConfig({})).toBe(false);
    expect(canWriteTenantConfig({ ok: false })).toBe(false);
  });

  for (const ep of ENDPOINTS) {
    describe(ep.name, () => {
      for (const [role, shouldPass] of CASES) {
        it(`${role} → ${shouldPass ? '放行' : '403'}`, async () => {
          mockMe.current = { ok: true, username: `u-${role}`, role, tenantId: T1 };
          const { handler, req } = ep.make();
          const res = fakeRes();
          await handler(req, res);
          if (shouldPass) {
            expect(res.statusCode, `${role} 被误杀：${JSON.stringify(res.body)}`).not.toBe(403);
          } else {
            expect(res.statusCode, `${role} 不该放行`).toBe(403);
          }
        });
      }
    });
  }

  it('闸不一致的残留信号：403 文案不得再声称「需要 sysadmin 权限」（误导为平台管理员）', async () => {
    mockMe.current = { ok: true, username: 'u-sales', role: 'sales', tenantId: T1 };
    const { handler, req } = ENDPOINTS[0].make();
    const res = fakeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toContain('租户级配置需');
    expect(res.body.error).not.toContain('需要 sysadmin 权限');
  });
});
