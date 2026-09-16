// test/http/workbench-badge-perf.test.js — badge 端点查询开销收敛（2026-09-16 性能 P0）
//
// 背景（实测）：侧栏角标 /api/my-todo/badge 被 layout.js 以 60s 周期在全部页面轮询，
//   但实现是「对 7 个视角各调一次 buildViewRows」，而 buildViewRows 内部
//   Promise.all 无条件拉取 4 个数据源（无论该视角是否需要）→ 4×7 = 28 次依赖调用；
//   其中 queryFollowSource 自身串行 7 条 SQL → 合计约 72 条 SQL/次。
//   生产实测该端点回环 TTFB 12.8–20.3ms（静态页 1.8–2.9ms）。
//
// 本文件锁定两项不变量（先测试后实现）：
//   ① 计数语义不变（与原实现等价）；
//   ② 查询开销收敛：全视角共用一批数据源；单视角只拉自己需要的源。
import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../../src/approval/engine.js', () => ({ advanceTask: vi.fn(async () => ({ status: 'APPROVED' })) }));
import { createWorkbenchRouter, VIEWS } from '../../src/http/workbenchRouter.js';
import { renderPage } from '../../src/page/renderer.js';

const TRACKED = ['queryApprovalTasks', 'queryApprovalInstances', 'queryKanbanTasks', 'queryFollowSource', 'queryPatches', 'querySignals'];

// 夹具：各视角计数可手算 —— approval 1 / processing 1 / initiated 1 / cc 1 / follow 1 / tuning 1 / signals 0
const FIXTURE = {
  approvalTasks: [
    { id: 'at-sales', payload: { instance_id: 'i-1', approver: 'sales', status: 'todo', seq: 1, title: '报价审批' } },
    { id: 'at-role', payload: { instance_id: 'i-1', approver: 'role:manager', status: 'todo', seq: 2, title: '经理审批' } },
    { id: 'at-done', payload: { instance_id: 'i-1', approver: 'sales', status: 'approved', seq: 3, title: '已通过' } },
  ],
  instances: [
    { id: 'i-1', payload: { submitter: 'sales', cc: ['sales'], status: 'approving', title: '报价单审批' } },
  ],
  kanbanTasks: [
    { id: 't-1', payload: { actor: 'sales' }, chain_id: 'c1', status: 'running', title: '生成报价' },
  ],
  followSource: [
    { id: 'd-s3', type: 'CRM_DEAL', payload: { name: '方案验证中', stage: 'S3' } },
    { id: 'd-s7', type: 'CRM_DEAL', payload: { name: '输单', stage: 'S7' } }, // 终态，不计入
  ],
  patches: [{ patch_id: 'pc-1', knob: 'config_store', target: 'x', risk: 'LOW', assignee: 'ADMIN' }],
  signals: [],
};

const EXPECTED = { approval: 1, processing: 1, initiated: 1, cc: 1, follow: 1, tuning: 1, signals: 0, total: 1 };

/** 计数版依赖：统计每个数据源被调用几次（这是本文件的核心断言维度） */
function makeCountingDeps(over = {}) {
  const calls = Object.fromEntries(TRACKED.map((k) => [k, 0]));
  const raw = {
    currentActor: async () => ({ username: 'sales', roles: ['sales'] }),
    queryApprovalTasks: async () => FIXTURE.approvalTasks,
    queryApprovalInstances: async () => FIXTURE.instances,
    queryKanbanTasks: async () => FIXTURE.kanbanTasks,
    queryFollowSource: async () => FIXTURE.followSource,
    queryPatches: async () => FIXTURE.patches,
    querySignals: async () => FIXTURE.signals,
    render: (schema, data) => renderPage(schema, data),
    ...over,
  };
  const deps = { ...raw };
  for (const k of TRACKED) {
    deps[k] = async (...a) => { calls[k] += 1; return raw[k](...a); };
  }
  deps.currentActor = raw.currentActor;
  deps.render = raw.render;
  return { deps, calls };
}

const makeRes = () => {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => { res.body = o; return res; };
  return res;
};

const badgeHandler = (router) =>
  router.stack.find((l) => l.route?.path === '/api/my-todo/badge').route.stack[0].handle;

beforeEach(() => vi.clearAllMocks());

describe('2026-09-16 性能 P0：badge 查询开销收敛', () => {
  it('① 计数语义与手算一致（重构不得改变业务数值）', async () => {
    const { deps } = makeCountingDeps();
    const res = makeRes();
    await badgeHandler(createWorkbenchRouter({ deps }))({ query: {} }, res);
    expect(res.statusCode).toBe(200);
    for (const v of VIEWS) expect(res.body[v]).toBe(EXPECTED[v]);
    expect(res.body.total).toBe(EXPECTED.total);
  });

  it('② 全视角共用一批数据源：每个数据源只被调用 1 次（原实现为 7 次）', async () => {
    const { deps, calls } = makeCountingDeps();
    const res = makeRes();
    await badgeHandler(createWorkbenchRouter({ deps }))({ query: {} }, res);
    expect(calls.queryApprovalTasks).toBe(1);
    expect(calls.queryApprovalInstances).toBe(1);
    expect(calls.queryKanbanTasks).toBe(1);
    expect(calls.queryFollowSource).toBe(1); // 原实现 7 次；其内部串行 7 条 SQL → 49 条
    expect(calls.queryPatches).toBe(1);
    expect(calls.querySignals).toBe(1);
  });

  it('③ 单视角 GET 只拉该视角需要的源（tuning 不碰审批/看板/业务粒子）', async () => {
    const { deps, calls } = makeCountingDeps();
    const res = makeRes();
    await createWorkbenchRouter({ deps }).handlers.get({ query: { view: 'tuning' } }, res);
    expect(res.statusCode).toBe(200);
    expect(calls.queryApprovalTasks).toBe(0);
    expect(calls.queryApprovalInstances).toBe(0);
    expect(calls.queryKanbanTasks).toBe(0);
    expect(calls.queryFollowSource).toBe(0);
    expect(calls.queryPatches).toBe(1);
  });

  it('④ 单视角 GET /view=approval 只拉审批任务源', async () => {
    const { deps, calls } = makeCountingDeps();
    const res = makeRes();
    await createWorkbenchRouter({ deps }).handlers.get({ query: { view: 'approval' } }, res);
    expect(res.statusCode).toBe(200);
    expect(calls.queryApprovalTasks).toBe(1);
    expect(calls.queryApprovalInstances).toBe(0);
    expect(calls.queryKanbanTasks).toBe(0);
    expect(calls.queryFollowSource).toBe(0);
  });

  it('⑤ 单视角 GET /view=signals 不拉任何粒子源（只走信号 store）', async () => {
    const { deps, calls } = makeCountingDeps();
    const res = makeRes();
    await createWorkbenchRouter({ deps }).handlers.get({ query: { view: 'signals' } }, res);
    expect(res.statusCode).toBe(200);
    expect(calls.queryApprovalTasks).toBe(0);
    expect(calls.queryKanbanTasks).toBe(0);
    expect(calls.queryFollowSource).toBe(0);
    expect(calls.querySignals).toBe(1);
  });

  it('⑥ 每视角结果与逐视角单独请求一致（等价性回归）', async () => {
    const { deps: badgeDeps } = makeCountingDeps();
    const badgeRes = makeRes();
    await badgeHandler(createWorkbenchRouter({ deps: badgeDeps }))({ query: {} }, badgeRes);

    for (const v of VIEWS) {
      const { deps } = makeCountingDeps();
      const res = makeRes();
      await createWorkbenchRouter({ deps }).handlers.get({ query: { view: v } }, res);
      expect(res.body.data.components.table.rows.length, `视角 ${v} 行数应与角标计数一致`).toBe(badgeRes.body[v]);
    }
  });
});
