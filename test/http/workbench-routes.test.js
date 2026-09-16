// test/http/workbench-routes.test.js — G3-T2 待办工作台 /workbench 端点
// 设计输入：docs/superpowers/plans/2026-08-26-ai-10-gap-repair-plan.md Task G3-T2
//           + docs/2026-09-05-param-closedloop-adaptive-design.md §2.4（tuning「参数调优」视角）
// 注入式：不依赖真实 PG / 真实引擎；createWorkbenchRouter({ deps }) 直接测 handlers
// 审批签批端点：advanceTask（真实引擎依赖 PG）以 vi.mock 替身，只测路由层鉴权与参数透传
// 参数调优签批端点：approvePatch/rejectPatch（真实实现依赖 PG）以 deps 注入替身，只测路由层
import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../../src/approval/engine.js', () => ({ advanceTask: vi.fn(async () => ({ status: 'APPROVED' })) }));
import { advanceTask } from '../../src/approval/engine.js';
import { createWorkbenchRouter, VIEW_ALIASES, VIEWS } from '../../src/http/workbenchRouter.js';
import { renderPage } from '../../src/page/renderer.js';

const makeTuneRes = () => {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => { res.body = o; return res; };
  return res;
};

beforeEach(() => vi.clearAllMocks());

// fake 数据：审批任务粒子 + 看板任务 + 当前人
function makeDeps(over = {}) {
  const rows = {
    // CRM_APPROVAL_TASK 粒子（payload 承载体）
    'approval-tasks': [
      { id: 'at-1', payload: { instance_id: 'i-1', approver: 'role:manager', status: 'todo', seq: 1, title: '报价单审批' } },
      { id: 'at-2', payload: { instance_id: 'i-1', approver: 'sales', status: 'todo', seq: 2, title: '合同审批' } },
      { id: 'at-3', payload: { instance_id: 'i-2', approver: 'role:manager', status: 'approved', seq: 1, title: '已通过审批' } },
      { id: 'at-4', payload: { instance_id: 'i-4', approver: 'role:admin', status: 'todo', seq: 1, title: '管理员待审报价' } },
    ],
    // CRM_APPROVAL_INSTANCE 粒子（发起人/抄送）
    'approval-instances': [
      { id: 'i-1', payload: { submitter: 'sales', status: 'approving', current_node_name: '经理审批', cc: ['finance'], title: '报价单-100 审批' } },
      { id: 'i-2', payload: { submitter: 'finance', status: 'approved', current_node_name: null, cc: [], title: '回款计划审批' } },
    ],
    // 看板任务（tasks 表行；actor 在 payload JSONB）
    'kanban-tasks': [
      { id: 't-1', payload: { actor: 'sales' }, chain_id: 'c1', status: 'running', title: '生成报价' },
      { id: 't-2', payload: { actor: 'manager' }, chain_id: 'c1', status: 'ready', title: '审报价' },
    ],
  };
  return {
    currentActor: async () => ({ username: 'sales', roles: ['sales'] }),
    // 查询审批任务/实例（真实实现为 queryParticles({ type })）
    queryApprovalTasks: async () => rows['approval-tasks'],
    queryApprovalInstances: async () => rows['approval-instances'],
    // 查询看板任务（真实实现为 listTasks）
    queryKanbanTasks: async () => rows['kanban-tasks'],
    // 参数调优数据源（P1）：默认空（注入式不依赖真实 PG；tuning 用例以 makeTuneDeps 覆盖）
    queryPatches: async () => [],
    // 信号视角数据源（S1 2026-09-16 加入 VIEWS）：**必须显式置空**。
    //   本文件声明「注入式：不依赖真实 PG」，但 signals 视角默认走 defaultDeps.querySignals（真库 crm.signal）
    //   → badge ⑧c「零数据时返回全 0」随共享测试库残留时红时绿（2026-09-16 实测：期望 0，实得 4/5/6 波动；
    //   切回 HEAD 版本同样红 = pre-existing，非 T21 引入）。补此占位以对齐本文件的注入式契约。
    querySignals: async () => [],
    // 渲染器（复用 renderPage，不改）
    render: (schema, data) => renderPage(schema, data),
    ...over,
  };
}

describe('G3-T2 待办工作台 /workbench 端点', () => {
  it('① GET /workbench?view=approval 200 + 返回待我审批行（approver 匹配当前人）', async () => {
    const router = createWorkbenchRouter({ deps: makeDeps() });
    const res = { statusCode: 200, body: null };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (o) => { res.body = o; return res; };
    await router.handlers.get({ query: { view: 'approval' } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.view).toBe('approval');
    // 当前人 sales → 不匹配 role:manager；sales 直接匹配 at-2
    const rows = res.body.data.components?.table?.rows || [];
    expect(rows.some((r) => r.id === 'at-2')).toBe(true);
    expect(res.body.schema.type).toBe('workspace');
  });

  it('①b GET /workbench?view=approval：role:admin 匹配 admin 用户（角色集匹配）', async () => {
    const router = createWorkbenchRouter({ deps: makeDeps({ currentActor: async () => ({ username: 'admin', roles: ['admin'] }) }) });
    const res = { statusCode: 200, body: null };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (o) => { res.body = o; return res; };
    await router.handlers.get({ query: { view: 'approval' } }, res);
    const rows = res.body.data.components?.table?.rows || [];
    expect(rows.some((r) => r.id === 'at-4')).toBe(true);
  });

  it('①c 引擎大写 TODO 仍被待我审批捕获（大小写兼容）', async () => {
    const deps = makeDeps({ currentActor: async () => ({ username: 'admin', roles: ['admin'] }) });
    deps.queryApprovalTasks = async () => ([
      { id: 'at-u', payload: { instance_id: 'i-u', approver: 'role:admin', status: 'TODO', seq: 1, title: '大写TODO任务' } },
    ]);
    const router = createWorkbenchRouter({ deps });
    const res = { statusCode: 200, body: null };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (o) => { res.body = o; return res; };
    await router.handlers.get({ query: { view: 'approval' } }, res);
    const rows = res.body.data.components?.table?.rows || [];
    expect(rows.some((r) => r.id === 'at-u')).toBe(true);
  });

  it('② GET /workbench?view=processing 200 + 我处理的（看板任务 actor=当前人 + running）', async () => {
    const router = createWorkbenchRouter({ deps: makeDeps() });
    const res = { statusCode: 200, body: null };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (o) => { res.body = o; return res; };
    await router.handlers.get({ query: { view: 'processing' } }, res);
    expect(res.statusCode).toBe(200);
    const rows = res.body.data.components?.table?.rows || [];
    expect(rows.some((r) => r.id === 't-1')).toBe(true);   // sales+running
    expect(rows.some((r) => r.id === 't-2')).toBe(false);  // manager+ready 不匹配
  });

  it('③ GET /workbench?view=initiated 200 + 我发起的（实例 submitter=当前人）', async () => {
    const router = createWorkbenchRouter({ deps: makeDeps() });
    const res = { statusCode: 200, body: null };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (o) => { res.body = o; return res; };
    await router.handlers.get({ query: { view: 'initiated' } }, res);
    expect(res.statusCode).toBe(200);
    const rows = res.body.data.components?.table?.rows || [];
    expect(rows.some((r) => r.id === 'i-1')).toBe(true);   // submitter=sales
    expect(rows.some((r) => r.id === 'i-2')).toBe(false);  // submitter=finance
  });

  it('④ GET /workbench?view=cc 200 + 抄送我的（实例 cc 含当前人）', async () => {
    const router = createWorkbenchRouter({ deps: makeDeps() });
    const res = { statusCode: 200, body: null };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (o) => { res.body = o; return res; };
    await router.handlers.get({ query: { view: 'cc' } }, res);
    expect(res.statusCode).toBe(200);
    const rows = res.body.data.components?.table?.rows || [];
    // 当前人=sales；i-1 cc=['finance']、i-2 cc=[] 均不含 sales → cc 视角精确匹配，应返回空
    expect(rows.some((r) => r.id === 'i-1')).toBe(false);
    expect(rows.some((r) => r.id === 'i-2')).toBe(false);
  });

  it('⑤ 无用 view → 400 且提示合法值', async () => {
    const router = createWorkbenchRouter({ deps: makeDeps() });
    const res = { statusCode: 200, body: null };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (o) => { res.body = o; return res; };
    await router.handlers.get({ query: { view: 'bogus' } }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/approval|processing|initiated|cc/);
  });

  it('⑥ VIEW_ALIASES 别名映射（approval→待我审批等）', () => {
    expect(VIEW_ALIASES.approval).toBe('待我审批');
    expect(VIEW_ALIASES.processing).toBe('我处理的');
    expect(VIEW_ALIASES.initiated).toBe('我发起的');
    expect(VIEW_ALIASES.cc).toBe('抄送我的');
  });

  // 2026-09-09 修复：术语改造后阶段为 S1–S8，原「仅 lead/opportunity 计入」的断言前提已过期
  //   （contracted→S4 属在跟，应计入；S7 输单 / S8 丢单为终态，应排除）。
  //   现固件显式覆盖判定表关键行，防回归：设计 docs/2026-09-09-follow-stage-filter-fix-design.md §3.2
  it('⑦ GET /workbench?view=follow 200 + 待跟进（在跟=S1–S6 非终态，旧英文值归一计入，S7/S8 排除）', async () => {
    const deps = makeDeps({
      queryFollowSource: async () => ([
        { id: 'd-lead', type: 'CRM_DEAL', payload: { name: '彩盒打样', customer: '甲', stage: 'lead' } },       // 旧值 → S1 计入
        { id: 'd-s3', type: 'CRM_DEAL', payload: { name: '方案验证中', customer: '甲', stage: 'S3' } },          // S 码计入
        { id: 'd-s6', type: 'CRM_DEAL', payload: { name: '赢单移交', customer: '甲', stage: 'S6' } },            // 边界：S6 计入
        { id: 'x-1', type: 'CRM_DEAL', payload: { name: '已签约', customer: '丁', stage: 'contracted' } },        // 旧值 → S4 计入
        { id: 'd-s7', type: 'CRM_DEAL', payload: { name: '输单', customer: '戊', stage: 'S7' } },                // 终态排除
        { id: 'd-s8', type: 'CRM_DEAL', payload: { name: '丢单', customer: '己', stage: 'S8' } },                // 终态排除
        { id: 'd-lost', type: 'CRM_DEAL', payload: { name: '旧值输单', customer: '庚', stage: 'lost' } },         // 旧值 → S7 排除
        { id: 'q-1', type: 'CRM_QUOTATION', payload: { name: '报价A', customer: '乙', status: 'submitted' } },
        { id: 'p-1', type: 'CRM_PAYMENT_PLAN', payload: { name: '回款A', customer: '丙', status: 'pending' } },
      ]),
    });
    const router = createWorkbenchRouter({ deps });
    const res = { statusCode: 200, body: null };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (o) => { res.body = o; return res; };
    await router.handlers.get({ query: { view: 'follow' } }, res);
    expect(res.statusCode).toBe(200);
    const rows = res.body.data.components?.table?.rows || [];
    // 4 条在跟商机（lead/S3/S6/contracted）+ 报价审批 + 回款核对 = 6；S7/S8/lost 三条终态不计入
    expect(rows.length).toBe(6);
    expect(rows.every((r) => ['跟进', '审批', '核对'].includes(r.action))).toBe(true);
    // 阶段归一：旧英文值输出 S 码，脏值/终态不在结果中
    const dealStages = rows.filter((r) => r.action === '跟进').map((r) => r.stage).sort();
    expect(dealStages).toEqual(['S1', 'S3', 'S4', 'S6']);
    const dealNames = rows.map((r) => r.deal);
    expect(dealNames).not.toContain('输单');
    expect(dealNames).not.toContain('丢单');
    expect(dealNames).not.toContain('旧值输单');
  });

  // ── 侧栏角标端点（/api/my-todo/badge，对齐 followReminders 模式）───
  it('⑧ GET /api/my-todo/badge 200 + 各视角计数 + total=approval', async () => {
    const router = createWorkbenchRouter({ deps: makeDeps() });
    const res = { statusCode: 200, body: null };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (o) => { res.body = o; return res; };
    // badge 端点挂在 router 上（非 handlers），需通过 route stack 匹配
    const badgeRoute = router.stack.find((l) => l.route?.path === '/api/my-todo/badge');
    expect(badgeRoute, 'badge 路由已注册').toBeTruthy();
    await badgeRoute.route.stack[0].handle({ query: {} }, res);
    expect(res.statusCode).toBe(200);
    // sales 用户：approval 仅匹配 at-2（sales 直接名）；processing 匹配 t-1；initiated 匹配 i-1
    expect(typeof res.body.approval).toBe('number');
    expect(typeof res.body.total).toBe('number');
    expect(res.body.total).toBe(res.body.approval); // total = approval 主角标
    expect(res.body.approval).toBe(1); // sales → at-2 (approver='sales')
    expect(res.body.processing).toBe(1); // t-1 (actor='sales')
    expect(res.body.initiated).toBe(1); // i-1 (submitter='sales')
    expect(res.body.cc).toBe(0); // 无 cc 含 sales 的实例
  });

  it('⑧b badge：admin 角色 role:admin 匹配 at-4', async () => {
    const router = createWorkbenchRouter({
      deps: makeDeps({ currentActor: async () => ({ username: 'admin', roles: ['admin'] }) }),
    });
    const res = { statusCode: 200, body: null };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (o) => { res.body = o; return res; };
    const badgeRoute = router.stack.find((l) => l.route?.path === '/api/my-todo/badge');
    await badgeRoute.route.stack[0].handle({ query: {} }, res);
    expect(res.body.approval).toBe(1); // admin → at-4 (approver='role:admin')
    expect(res.body.total).toBe(1);
  });

  it('⑧c badge：零数据时返回全 0', async () => {
    const router = createWorkbenchRouter({
      deps: makeDeps({
        queryApprovalTasks: async () => [],
        queryApprovalInstances: async () => [],
        queryKanbanTasks: async () => [],
        queryFollowSource: async () => [],
      }),
    });
    const res = { statusCode: 200, body: null };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (o) => { res.body = o; return res; };
    const badgeRoute = router.stack.find((l) => l.route?.path === '/api/my-todo/badge');
    await badgeRoute.route.stack[0].handle({ query: {} }, res);
    expect(res.statusCode).toBe(200);
    VIEWS.forEach((v) => expect(res.body[v]).toBe(0));
    expect(res.body.total).toBe(0);
  });

  // ── 审批签批端点（/api/my-todo/approve|reject，advanceTask 已 mock）───
  const makeRes = () => {
    const res = { statusCode: 200, body: null };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (o) => { res.body = o; return res; };
    return res;
  };
  const getPostHandler = (router, path) =>
    router.stack.find((l) => l.route?.path === path).route.stack[0].handle;

  it('⑨ POST /api/my-todo/approve 200：approver 归属校验通过 → advanceTask 收到正确参数', async () => {
    const router = createWorkbenchRouter({ deps: makeDeps() });
    const res = makeRes();
    await getPostHandler(router, '/api/my-todo/approve')({ body: { task_id: 'at-2', opinion: '同意' } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(advanceTask).toHaveBeenCalledWith('i-1', 'at-2', expect.objectContaining({ approver: 'sales', decision: 'approve', opinion: '同意' }));
  });

  it('⑨b 越权闸：sales 尝试批准 role:admin 的任务 at-4 → 400 无权处理', async () => {
    const router = createWorkbenchRouter({ deps: makeDeps() });
    const res = makeRes();
    await getPostHandler(router, '/api/my-todo/approve')({ body: { task_id: 'at-4' } }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/无权|不存在/);
    expect(advanceTask).not.toHaveBeenCalled();
  });

  it('⑩ POST /api/my-todo/reject：decision=reject 透传 + 旧 /api/workbench/reject 双路径兼容', async () => {
    const router = createWorkbenchRouter({ deps: makeDeps() });
    const res1 = makeRes();
    await getPostHandler(router, '/api/my-todo/reject')({ body: { task_id: 'at-2', opinion: '资料不全' } }, res1);
    expect(res1.body.ok).toBe(true);
    expect(advanceTask).toHaveBeenLastCalledWith('i-1', 'at-2', expect.objectContaining({ decision: 'reject', opinion: '资料不全' }));
    // 旧路径仍可达
    const res2 = makeRes();
    await getPostHandler(router, '/api/workbench/reject')({ body: { task_id: 'at-2' } }, res2);
    expect(res2.body.ok).toBe(true);
  });

  it('⑩b task_id 不存在 → 400 且不触引擎', async () => {
    const router = createWorkbenchRouter({ deps: makeDeps() });
    const res = makeRes();
    await getPostHandler(router, '/api/my-todo/approve')({ body: { task_id: 'nope' } }, res);
    expect(res.statusCode).toBe(400);
    expect(advanceTask).not.toHaveBeenCalled();
  });

  // ── 参数调优视角（P1 2026-09-05，设计 §2.4）───
  // tuning 不消费审批/看板数据源，直接 queryPatches（calibration_patch PENDING）
  const tunePatches = () => ([
    {
      patch_id: 'pc-1', knob: 'config_store', target: 'rubric-thresholds.good',
      from_value: { good: 0.75 }, to_value: { good: 0.6 },
      risk: 'MEDIUM', assignee: 'ADMIN', tenant_id: 'system', created_at: '2026-09-05T02:00:00Z',
    },
  ]);
  const makeTuneDeps = (over = {}) => makeDeps({
    currentActor: async () => ({ username: 'admin', roles: ['ADMIN'] }),
    queryPatches: async () => tunePatches(),
    approvePatch: vi.fn(async (id, opts) => ({ patch: { patch_id: id, status: 'APPLIED' }, config: { threshold: 0.6 }, decision: 'dec-1' })),
    rejectPatch: vi.fn(async (id, opts) => ({ patch_id: id, status: 'REJECTED' })),
    ...over,
  });

  it('⑪ GET ?view=tuning 200 + PENDING 处方行（含 knob/target/from/to/risk）', async () => {
    const router = createWorkbenchRouter({ deps: makeTuneDeps() });
    const res = makeRes();
    await router.handlers.get({ query: { view: 'tuning' } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.view).toBe('tuning');
    const rows = res.body.data.components?.table?.rows || [];
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe('pc-1');
    expect(rows[0].knob).toBe('config_store');
    expect(rows[0].target).toBe('rubric-thresholds.good');
    expect(rows[0].from_value).toContain('0.75');
    expect(rows[0].to_value).toContain('0.6');
    expect(rows[0].risk).toBe('MEDIUM');
    expect(VIEW_ALIASES.tuning).toBe('参数调优');
  });

  it('⑪b tuning 空数据 → 空行（不报错）', async () => {
    const router = createWorkbenchRouter({ deps: makeTuneDeps({ queryPatches: async () => [] }) });
    const res = makeRes();
    await router.handlers.get({ query: { view: 'tuning' } }, res);
    expect(res.statusCode).toBe(200);
    const rows = res.body.data.components?.table?.rows || [];
    expect(rows.length).toBe(0);
  });

  it('⑫ POST /api/my-todo/tune-approve 200：patch_id 透传 approvePatch + resolved_by=当前人', async () => {
    const deps = makeTuneDeps();
    const router = createWorkbenchRouter({ deps });
    const res = makeRes();
    await getPostHandler(router, '/api/my-todo/tune-approve')({ body: { patch_id: 'pc-1' } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(deps.approvePatch).toHaveBeenCalledWith('pc-1', { resolved_by: 'admin' });
  });

  it('⑫b tune-approve 缺 patch_id → 400', async () => {
    const deps = makeTuneDeps();
    const router = createWorkbenchRouter({ deps });
    const res = makeRes();
    await getPostHandler(router, '/api/my-todo/tune-approve')({ body: {} }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/patch_id/);
    expect(deps.approvePatch).not.toHaveBeenCalled();
  });

  it('⑬ POST /api/my-todo/tune-reject 200：rejectPatch 被调 + resolved_by 透传', async () => {
    const deps = makeTuneDeps();
    const router = createWorkbenchRouter({ deps });
    const res = makeRes();
    await getPostHandler(router, '/api/my-todo/tune-reject')({ body: { patch_id: 'pc-1' } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(deps.rejectPatch).toHaveBeenCalledWith('pc-1', { resolved_by: 'admin' });
  });

  it('⑬b tune-approve 抛错（approvePatch 拒绝非 PENDING）→ 400 透传错误', async () => {
    const deps = makeTuneDeps({
      approvePatch: vi.fn(async () => { throw new Error('处方状态 APPLIED 不可批准'); }),
    });
    const router = createWorkbenchRouter({ deps });
    const res = makeRes();
    await getPostHandler(router, '/api/my-todo/tune-approve')({ body: { patch_id: 'pc-x' } }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/不可批准/);
  });
});