// D6 admin/todos ?escalated 过滤 + SLA 字段单测（真实 Express app + HTTP 调用；Task C）
// 设计：docs/2026-09-14-d6-calibration-approval-flow-plan.md Task C。
// 验证：?escalated=true 只返回 escalated 行；每行带 age_hours / sla_remaining_hours 字段；非 admin 403。
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import { createCalibrationRouter } from '../../src/http/calibrationRouter.js';

function makeApp({ role = 'sysadmin', rows = [], queryImpl } = {}) {
  const app = express();
  app.use(express.json());
  const router = createCalibrationRouter({
    resolveMe: async () => ({ ok: true, role, username: 'tester', tenantId: 'system' }),
    // 其余依赖不触发（本用例只走 /api/admin/todos）；query 注入
    query: queryImpl || (async (sql, params) => ({ rows })),
  });
  app.use(router);
  return app;
}

async function call(app, method, path) {
  return await new Promise((resolve) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      fetch(`http://127.0.0.1:${port}${path}`, { method })
        .then(async (r) => resolve({ status: r.status, json: await r.json().catch(() => null) }))
        .finally(() => server.close());
    });
  });
}

describe('GET /api/admin/todos ?escalated', () => {
  it('escalated=true 仅返 escalated 行，且含 sla_remaining_hours / age_hours', async () => {
    const rows = [
      { patch_id: 'a', status: 'PENDING', escalated: true, sla_due_at: new Date(Date.now() + 3600000).toISOString(), sla_remaining_hours: 1, age_hours: 2 },
      { patch_id: 'b', status: 'PENDING', escalated: false, sla_due_at: new Date(Date.now() + 3600000).toISOString(), sla_remaining_hours: 1, age_hours: 3 },
    ];
    // 模拟服务端已按 $4 过滤：handler 会传 escalated 布尔到参数末位
    const app = makeApp({
      role: 'sysadmin',
      queryImpl: async (sql, params) => ({
        rows: rows.filter((r) => {
          const esc = params[params.length - 1];
          return esc === true ? r.escalated : true;
        }),
      }),
    });
    const r = await call(app, 'GET', '/api/admin/todos?status=PENDING&escalated=true');
    expect(r.status).toBe(200);
    expect(r.json.todos.map((t) => t.patch_id)).toEqual(['a']);
    expect(r.json.todos[0]).toHaveProperty('sla_remaining_hours');
    expect(r.json.todos[0]).toHaveProperty('age_hours');
  });

  it('escalated 缺省 → 返回全部行（兼容既有调用）', async () => {
    const rows = [
      { patch_id: 'a', status: 'PENDING', escalated: false, sla_due_at: new Date(Date.now() + 3600000).toISOString() },
      { patch_id: 'b', status: 'PENDING', escalated: true, sla_due_at: new Date(Date.now() + 3600000).toISOString() },
    ];
    const app = makeApp({ role: 'sysadmin', rows });
    const r = await call(app, 'GET', '/api/admin/todos?status=PENDING');
    expect(r.status).toBe(200);
    expect(r.json.todos.map((t) => t.patch_id)).toEqual(['a', 'b']);
  });

  it('非 admin 角色 → 403（fail-closed）', async () => {
    const app = makeApp({ role: 'sales', rows: [] });
    const r = await call(app, 'GET', '/api/admin/todos?status=PENDING');
    expect(r.status).toBe(403);
  });
});
