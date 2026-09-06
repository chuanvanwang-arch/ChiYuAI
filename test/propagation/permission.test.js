// test/propagation/permission.test.js
// Task 10（RED→GREEN）：后台按系统级/租户级重分组 + RBAC 角色闸门
// 设计依据：docs/2026-09-04-param-propagation-hub-design.md §15（15.1 权限矩阵 / 15.2 导航分组 / 15.3 路由闸门 / 15.4 别名映射 / 15.5 传播影响）
// 用户决议：系统级仅 ADMIN；租户级 tan_admin+sysadmin+ADMIN（tan_admin 限本租户）；上下贯通强制 ADMIN。
import { describe, it, expect } from 'vitest';
import {
  normalizeRole, hasRole, hasAnyRole, requireRole, requireAnyRole, createConfigLevelGate,
  TENANT_LEVEL_ROLES, LEVEL_ROLE_MAP,
} from '../../src/http/middleware/rbac.js';
import { issueToken } from '../../src/http/auth.js';
import { CONFIG_ITEMS } from '../../src/portal/configCenter.js';

// ───────────────────────── §15.1 权限矩阵（纯函数） ─────────────────────────
describe('rbac 纯函数：§15.1 角色矩阵', () => {
  it('系统级仅 ADMIN（sysadmin/tan_admin/sales 均拒）', () => {
    expect(hasRole({ role: 'ADMIN' }, 'ADMIN')).toBe(true);
    expect(hasRole({ role: 'admin' }, 'ADMIN')).toBe(true);       // 别名归一（§15.4）
    expect(hasRole({ role: 'sysadmin' }, 'ADMIN')).toBe(false);
    expect(hasRole({ role: 'sys-admin' }, 'ADMIN')).toBe(false);  // 连字符别名
    expect(hasRole({ role: 'tan_admin' }, 'ADMIN')).toBe(false);
    expect(hasRole({ role: 'sales' }, 'ADMIN')).toBe(false);
    expect(hasRole({ role: null }, 'ADMIN')).toBe(false);
  });

  it('租户级三角色通过（tan_admin/sysadmin/ADMIN）', () => {
    expect(hasAnyRole({ role: 'tan_admin', tenantId: 't-a' }, TENANT_LEVEL_ROLES)).toBe(true);
    expect(hasAnyRole({ role: 'sysadmin' }, TENANT_LEVEL_ROLES)).toBe(true);
    expect(hasAnyRole({ role: 'admin' }, TENANT_LEVEL_ROLES)).toBe(true);
    expect(hasAnyRole({ role: 'sales' }, TENANT_LEVEL_ROLES)).toBe(false);
  });

  it('tan_admin 限本租户：目标租户不一致 → 拒；sysadmin/ADMIN 不受限', () => {
    expect(hasAnyRole({ role: 'tan_admin', tenantId: 't-a' }, TENANT_LEVEL_ROLES, { targetTenantId: 't-a' })).toBe(true);
    expect(hasAnyRole({ role: 'tan_admin', tenantId: 't-a' }, TENANT_LEVEL_ROLES, { targetTenantId: 't-b' })).toBe(false);
    expect(hasAnyRole({ role: 'sysadmin', tenantId: 't-a' }, TENANT_LEVEL_ROLES, { targetTenantId: 't-b' })).toBe(true);
    expect(hasAnyRole({ role: 'admin', tenantId: 't-a' }, TENANT_LEVEL_ROLES, { targetTenantId: 't-b' })).toBe(true);
  });

  it('normalizeRole 别名归一（§15.4：不改传播中枢逻辑，仅做角色名映射）', () => {
    expect(normalizeRole('admin')).toBe('ADMIN');
    expect(normalizeRole('ADMIN')).toBe('ADMIN');
    expect(normalizeRole('sysadmin')).toBe('SYSADMIN');
    expect(normalizeRole('sys-admin')).toBe('SYSADMIN');
    expect(normalizeRole('tan_admin')).toBe('TAN_ADMIN');
    expect(normalizeRole('tan-admin')).toBe('TAN_ADMIN');
    expect(normalizeRole('tenant-admin')).toBe('TAN_ADMIN');
    expect(normalizeRole('sales')).toBe(null);
    expect(normalizeRole(undefined)).toBe(null);
  });
});

// ───────────────────────── §15.3 中间件（requireRole / requireAnyRole） ─────────────────────────
function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => { res.body = o; return res; };
  return res;
}
function reqAs(role, tenantId = 'system') {
  const token = issueToken({ username: 'tester', role, tenantId });
  return { headers: { authorization: `Bearer ${token}` } };
}

describe('rbac 中间件', () => {
  it('requireRole(ADMIN)：未登录 401；sysadmin 403；admin 放行', () => {
    const mw = requireRole('ADMIN');
    let r401 = fakeRes(); mw({ headers: {} }, r401, () => {});
    expect(r401.statusCode).toBe(401);
    let r403 = fakeRes(); mw(reqAs('sysadmin'), r403, () => {});
    expect(r403.statusCode).toBe(403);
    let ok = false; let r200 = fakeRes(); mw(reqAs('admin'), r200, () => { ok = true; });
    expect(ok).toBe(true);
  });

  it('requireAnyRole(租户级三角色)：tan_admin 本租户放行、越租户 403；sales 403', () => {
    const mw = requireAnyRole(TENANT_LEVEL_ROLES, { targetTenantId: 't-a' });
    let ok = false; let rOk = fakeRes(); mw(reqAs('tan_admin', 't-a'), rOk, () => { ok = true; });
    expect(ok).toBe(true);
    let r403 = fakeRes(); mw(reqAs('tan_admin', 't-b'), r403, () => {});
    expect(r403.statusCode).toBe(403);
    let rSales = fakeRes(); mw(reqAs('sales'), rSales, () => {});
    expect(rSales.statusCode).toBe(403);
  });
});

// ───────────────────────── §15.3 注册表闸（CONFIG_ITEMS level → API 闸） ─────────────────────────
describe('createConfigLevelGate：按 CONFIG_ITEMS.level 统一闸门', () => {
  it('CONFIG_ITEMS 全量带 level 字段（系统级/租户级/传播 三分完备；propagation=2026-09-05 id42 传播 TAB）', () => {
    expect(CONFIG_ITEMS.length).toBeGreaterThan(20);
    for (const it of CONFIG_ITEMS) {
      expect(['system', 'tenant', 'propagation']).toContain(it.level);
    }
    // propagation 级仅 id42：UI 上独立成第三 TAB（data-level="propagation"，见 test/web/configCenter.test.js），
    //   但 **API 权限等同系统级（仅 ADMIN）**——2026-09-05 契约冲突裁决（方案 1，audit §8）：
    //   §15.5 规定上下贯通（broadcast / tenant→system 推广）强制 ADMIN；原实现走 else 分支按租户级放行，
    //   会让 sysadmin 绕过前端 TAB 隐藏直接调 API（"隐藏式安全"不牢靠）→ 在 rbac.LEVEL_ROLE_MAP 显式登记为 ADMIN-only。
    const propIds = CONFIG_ITEMS.filter((i) => i.level === 'propagation').map((i) => i.id);
    expect(propIds).toEqual([42]);
    expect(LEVEL_ROLE_MAP.propagation.roles).toEqual(['ADMIN']);
  });

  it('§15.2 分组归属：11 LLM=system / 12 用户管理=system / 35 事件复盘=system / 36 场景路由=system / 39 事件派发=system（22 本体词汇 2026-09-05 移租户级）', () => {
    const byId = Object.fromEntries(CONFIG_ITEMS.map((i) => [i.id, i]));
    expect(byId[11].level).toBe('system');
    expect(byId[12].level).toBe('system');
    expect(byId[24].level).toBe('system');
    expect(byId[35].level).toBe('system');
    expect(byId[36].level).toBe('system');
    expect(byId[39].level).toBe('system');
  });

  it('§15.2 分组归属：14 决策场景=tenant / 17 审批流=tenant / 22 本体词汇=tenant（2026-09-05） / 32 判定阈值=tenant / 38 先例检索=tenant', () => {
    const byId = Object.fromEntries(CONFIG_ITEMS.map((i) => [i.id, i]));
    expect(byId[14].level).toBe('tenant');
    expect(byId[17].level).toBe('tenant');
    expect(byId[22].level).toBe('tenant');
    expect(byId[32].level).toBe('tenant');
    expect(byId[38].level).toBe('tenant');
  });

  it('系统级端点：sysadmin 403 / admin 放行；租户级端点：tan_admin 放行；未注册路径直通', () => {
    const gate = createConfigLevelGate(CONFIG_ITEMS);
    // 系统级：/api/config/llm（id 11）
    let rSys = fakeRes(); gate({ ...reqAs('sysadmin'), path: '/api/config/llm' }, rSys, () => {});
    expect(rSys.statusCode).toBe(403);
    let sysPassed = false; let rAdmin = fakeRes();
    gate({ ...reqAs('admin'), path: '/api/config/llm' }, rAdmin, () => { sysPassed = true; });
    expect(sysPassed).toBe(true);
    // 租户级：/api/config/sales-thresholds（id 32）
    let tPassed = false; let rTan = fakeRes();
    gate({ ...reqAs('tan_admin', 't-a'), path: '/api/config/sales-thresholds' }, rTan, () => { tPassed = true; });
    expect(tPassed).toBe(true);
    // 未注册路径：直通（不拦业务 API）
    let pass = false; let rOther = fakeRes();
    gate({ ...reqAs('sales'), path: '/api/deals' }, rOther, () => { pass = true; });
    expect(pass).toBe(true);
  });
});

// ───────────────────────── §15.5 传播中枢叠闸（accept 按目标层级） ─────────────────────────
describe('传播中枢 gateAccept：accept 候选按目标层级叠闸', () => {
  it('目标=系统级（tenant_id 缺省 system）→ 仅 ADMIN；sysadmin 拒', async () => {
    const mod = await import('../../src/http/propagationRoutes.js');
    const patch = { knob: 'config_store', target: 'provenance-patrol.interval', to_value: 7200000 };
    expect(mod.gateAccept({ ok: true, role: 'admin', tenantId: 'system' }, { kind: 'config_store', patch }).ok).toBe(true);
    const g = mod.gateAccept({ ok: true, role: 'sysadmin' }, { kind: 'config_store', patch });
    expect(g.ok).toBe(false);
    expect(g.status).toBe(403);
  });

  it('目标=租户级 → tan_admin 本租户放行、跨租户拒；sysadmin/ADMIN 放行', async () => {
    const mod = await import('../../src/http/propagationRoutes.js');
    const patch = { knob: 'config_store', target: 'precedent-conf.minSimilarity', to_value: 0.4, tenant_id: 't-a' };
    expect(mod.gateAccept({ ok: true, role: 'tan_admin', tenantId: 't-a' }, { kind: 'config_store', patch }).ok).toBe(true);
    expect(mod.gateAccept({ ok: true, role: 'tan_admin', tenantId: 't-b' }, { kind: 'config_store', patch }).ok).toBe(false);
    expect(mod.gateAccept({ ok: true, role: 'sysadmin' }, { kind: 'config_store', patch }).ok).toBe(true);
    expect(mod.gateAccept({ ok: true, role: 'admin' }, { kind: 'config_store', patch }).ok).toBe(true);
  });

  it('memory_promote → 租户级三角色（tan_admin 限本租户）；sales 拒；未登录 401', async () => {
    const mod = await import('../../src/http/propagationRoutes.js');
    expect(mod.gateAccept({ ok: true, role: 'tan_admin', tenantId: 't-a' }, { kind: 'memory_promote', tenantId: 't-a' }).ok).toBe(true);
    expect(mod.gateAccept({ ok: true, role: 'tan_admin', tenantId: 't-b' }, { kind: 'memory_promote', tenantId: 't-a' }).ok).toBe(false);
    expect(mod.gateAccept({ ok: true, role: 'sales' }, { kind: 'memory_promote', tenantId: 't-a' }).ok).toBe(false);
    const g401 = mod.gateAccept({ ok: false }, { kind: 'memory_promote', tenantId: 't-a' });
    expect(g401.status).toBe(401);
  });

  it('broadcast（上下贯通）路由：sysadmin 403、admin 放行进入第0闸', async () => {
    const mod = await import('../../src/http/propagationRoutes.js');
    const handlers = {};
    const app = {
      get: (p, h) => { handlers[p] = h; },
      post: (p, h) => { handlers[p] = h; },
    };
    mod.registerPropagationRoutes(app, {});
    let called = 0;
    mod.__setDeps({
      requireDecision: async () => { called++; return { decision: { decision_id: 'D9' } }; },
      broadcastConfig: async () => ({ ok: true, applied: [] }),
    });
    const r403 = fakeRes();
    await handlers['/api/config/broadcast']({ ...reqAs('sysadmin'), body: { key: 'k', value: {} } }, r403);
    expect(r403.statusCode).toBe(403);
    const r200 = fakeRes();
    await handlers['/api/config/broadcast']({ ...reqAs('admin'), body: { key: 'k', value: {} } }, r200);
    expect(r200.statusCode).toBe(200);
    expect(called).toBe(1); // 先角色闸、后第0闸（双闸串行）
  });
});

// ───────────────────────── configRouter level 闸（系统级/租户级） ─────────────────────────
describe('configRouter level 选项：level=system 仅 ADMIN / level=tenant 三角色', () => {
  function makeDeps(role, tenantId = 'system') {
    return {
      readConfig: async () => null,
      writeConfig: async () => ({ ok: true }),
      produceDecision: async () => ({ decisionId: 'd', ok: true }),
      sevenCheck: async () => ({ allowed: true, level: 'ok', missing: [] }),
      resolveMe: async () => ({ ok: true, role, tenantId }),
      encryptSecret: (p) => p,
      maskSecret: () => '****',
    };
  }
  it('level=system：sysadmin GET → 403；admin GET → 200/404（过闸）', async () => {
    const { createConfigRouter } = await import('../../src/http/configRouter.js');
    const rSys = fakeRes();
    await createConfigRouter({ key: 'llm', level: 'system' }, makeDeps('sysadmin')).handlers.get({ headers: {} }, rSys);
    expect(rSys.statusCode).toBe(403);
    const rAdmin = fakeRes();
    await createConfigRouter({ key: 'llm', level: 'system' }, makeDeps('admin')).handlers.get({ headers: {} }, rAdmin);
    expect(rAdmin.statusCode).not.toBe(403); // 过角色闸（未配置 → 404）
  });

  it('level=tenant：tan_admin GET → 过闸；scope=platform 缺省派生 system', async () => {
    const { createConfigRouter } = await import('../../src/http/configRouter.js');
    const rTan = fakeRes();
    await createConfigRouter({ key: 'sales-thresholds', level: 'tenant' }, makeDeps('tan_admin', 't-a')).handlers.get({ headers: {} }, rTan);
    expect(rTan.statusCode).not.toBe(403);
    // scope=platform 未显式给 level → 派生 system（sysadmin 拒）
    const rDerive = fakeRes();
    await createConfigRouter({ key: 'llm', scope: 'platform' }, makeDeps('sysadmin')).handlers.get({ headers: {} }, rDerive);
    expect(rDerive.statusCode).toBe(403);
  });
});
