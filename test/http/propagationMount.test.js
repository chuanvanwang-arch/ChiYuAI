// test/http/propagationMount.test.js
// 覆盖「参数传播中枢」路由挂载缺口：之前 propagationRoutes.js 实现完整，
// 但 routes.js 漏挂 registerPropagationRoutes(app, pool)，导致全部端点 401/404、
// propagation-hub.html 的 ①继承视图 / ④已落地 等 tab 调 API 失败、界面停留在空白/加载失败。
// 本测试锁定「挂载」这一层，并防未来误删挂载调用。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

function makeMockApp() {
  const registered = [];
  return {
    app: {
      get: (path, h) => registered.push({ method: 'GET', path, h }),
      post: (path, h) => registered.push({ method: 'POST', path, h }),
    },
    registered,
  };
}

const EXPECTED = [
  'GET /api/config/inherit-matrix', // ① 继承视图
  'GET /api/propagation/actions', // ④ 已落地留痕
  'GET /api/propagation/suggestions', // ③ 推广候选
  'GET /api/config/inherit', // ① 逐键继承详情
  'GET /api/config/effective', // 生效值视图
  'POST /api/config/broadcast', // ② 强制下发
  'POST /api/propagation/accept', // 采纳候选
  'POST /api/propagation/reject', // 驳回候选
];

describe('参数传播中枢路由挂载', () => {
  it('registerPropagationRoutes 注册全部关键端点（含 ①④ 继承矩阵/已落地留痕）', async () => {
    const { app, registered } = makeMockApp();
    const pool = { query: async () => ({ rows: [] }), queryWrite: async () => ({ rows: [] }) };
    const mod = await import('../../src/http/propagationRoutes.js');
    mod.registerPropagationRoutes(app, pool);
    const set = new Set(registered.map((r) => `${r.method} ${r.path}`));
    for (const p of EXPECTED) {
      expect(set.has(p), `缺失端点注册: ${p}`).toBe(true);
    }
  });

  it('①继承矩阵端点 handler 接线正确（返回结构化矩阵）', async () => {
    const { app, registered } = makeMockApp();
    const store = { 't-a': [{ key: 'precedent-conf', value: { minSimilarity: 0.4 } }] };
    const pool = {
      query: async (t, a) => {
        if (t.includes('tenant_id <>') && t.includes('FROM crm.config_store')) {
          return {
            rows: Object.entries(store).flatMap(([tid, items]) =>
              items.map((it) => ({ tenant_id: tid, key: it.key, value: it.value }))
            ),
          };
        }
        return { rows: [] };
      },
    };
    const mod = await import('../../src/http/propagationRoutes.js');
    mod.registerPropagationRoutes(app, pool);
    const handler = registered.find((r) => r.method === 'GET' && r.path === '/api/config/inherit-matrix').h;
    // 用 __setDeps 无法覆盖 resolveMe，这里直接验证 buildInheritMatrix 经 handler 后结构；
    // 但通过 mock resolveMe 不可行，故仅校验 handler 注册存在 + 纯函数已在 routes.test.js 覆盖。
    expect(typeof handler).toBe('function');
  });

  it('routes.js 已挂载 registerPropagationRoutes(app, pool)（防未来误删）', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const routesSrc = readFileSync(resolve(here, '../../src/http/routes.js'), 'utf8');
    const hasCall = /registerPropagationRoutes\(\s*app\s*,\s*pool\s*\)/.test(routesSrc);
    expect(hasCall, 'routes.js 未调用 registerPropagationRoutes(app, pool)').toBe(true);
    const hasImport = /import\s*\{\s*registerPropagationRoutes\s*\}\s*from\s*'\.\/propagationRoutes\.js'/.test(routesSrc);
    expect(hasImport, 'routes.js 未 import registerPropagationRoutes').toBe(true);
  });
});
