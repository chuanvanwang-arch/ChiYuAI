// test/calibration/todo-loop.test.js — ADMIN 待办闭环（Task 12 / 设计 §16.1/16.3/16.4）
// 链路：retro/手动 createPatch(knob=config_store, PENDING=待办) → approvePatch（第0闸 + 事务）→ config_store 即时生效。
// 隔离：db.js 全 mock（calibration_patch / config_store 内存双 Map；withTx 以记录型 client 执行）；
//       第0闸 produce 以桩注入（approvePatch 签名支持）；LLM 经 llmFactory 注入。
// 计划缺陷修正对照（相对 plan 原文）：
//   #8  knob CHECK 须在既有 13 类上追加 config_store（计划 4 类枚举会把 10 类既有旋钮收窄致 createPatch 抛错）；
//   #9  ConfigStoreStrategy.apply 必须走事务 client.query（计划 writeConfig 是池级连接，脱离 approvePatch 的 withTx 原子性）；
//   #10 calibration_patch 补 tenant_id 列（计划仅 assignee；无租户列则 tan_admin 本租户过滤与租户级写入无从落地）；
//   #11 计划引用未定义的 retroDecisionId → 待办草稿 decision_id 留空，第0闸决策在批准时由 approvePatch.produce 产生；
//   #12 rbac 别名缺 ten_admin（用户管理页实际角色名）→ fail-closed 会 403 真实租户管理员。
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  patches: new Map(),   // patch_id → row
  configs: new Map(),   // 'tenant|key' → { value, decision_id }
  seq: 0,
  txClientSqls: [],     // 经事务 client 执行的 SQL（证明写通道在 withTx 内）
}));

function exec(sql, params = []) {
  const s = String(sql);
  // createPatch INSERT（列序：scenario,knob,target,from,to,evidence,expected_impact,risk,decision_id,assignee,tenant_id）
  if (s.includes('INSERT INTO crm.calibration_patch')) {
    const id = `p-${++h.seq}`;
    const row = {
      patch_id: id, scenario_id: params[0], knob: params[1], target: params[2],
      from_value: JSON.parse(params[3]), to_value: JSON.parse(params[4]),
      evidence: JSON.parse(params[5]), expected_impact: params[6] ? JSON.parse(params[6]) : null,
      risk: params[7], status: 'PENDING', decision_id: params[8] ?? null,
      assignee: params[9] ?? 'ADMIN', tenant_id: params[10] ?? 'system',
      created_at: `2026-09-05T02:0${h.seq}:00Z`,
    };
    h.patches.set(id, row);
    return { rows: [row] };
  }
  // savePatches 幂等去重（scenario_id+knob+target+to_value+PENDING+tenant_id）
  if (s.includes('FROM crm.calibration_patch') && s.includes('IS NOT DISTINCT FROM $1')) {
    const [scen, knob, target, toVal, tenant] = params;
    const dup = [...h.patches.values()].some((r) =>
      (r.scenario_id ?? null) === (scen ?? null) && r.knob === knob
      && (r.target ?? null) === (target ?? null) && JSON.stringify(r.to_value) === toVal
      && r.status === 'PENDING' && (r.tenant_id ?? 'system') === (tenant ?? 'system'));
    return { rows: dup ? [1] : [] };
  }
  // /api/admin/todos 列表（status + assignee? + tenant?）
  if (s.includes('FROM crm.calibration_patch') && s.includes('assignee=$2')) {
    const [status, assignee, tenant] = params;
    const rows = [...h.patches.values()].filter((r) => r.status === status
      && (!assignee || r.assignee === assignee)
      && (!tenant || (r.tenant_id ?? 'system') === tenant))
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).slice(0, 50);
    return { rows };
  }
  // getPatch
  if (s.includes('SELECT * FROM crm.calibration_patch WHERE patch_id=$1')) {
    const r = h.patches.get(params[0]);
    return { rows: r ? [r] : [] };
  }
  // UPDATE 状态（approvePatch/rollbackPatch 字面量形态 vs setStatus 参数形态）
  if (s.includes('UPDATE crm.calibration_patch SET status')) {
    const r = h.patches.get(params[0]);
    if (!r) return { rows: [] };
    const lit = s.match(/SET status='(\w+)'/);
    if (lit) {
      r.status = lit[1]; r.resolved_by = params[1] ?? null;
      r.decision_id = params[2] ?? r.decision_id;
    } else {
      r.status = params[1]; r.resolved_by = params[2] ?? null;
    }
    return { rows: [r] };
  }
  // config_store upsert（策略 apply / writeConf 同形态：tenant,key,value,decision_id[,updated_by]）
  if (s.includes('INSERT INTO crm.config_store') && s.includes('ON CONFLICT')) {
    h.configs.set(`${params[0]}|${params[1]}`, { value: JSON.parse(params[2]), decision_id: params[3] ?? null });
    return { rows: [] };
  }
  // readConfig（tenant 回退链）
  if (s.includes('SELECT value, decision_id FROM crm.config_store')) {
    const r = h.configs.get(`${params[0]}|${params[1]}`);
    return { rows: r ? [r] : [] };
  }
  // readConf（autonomy-conf 专用，无 decision_id 列）
  if (s.includes('SELECT value FROM crm.config_store')) return { rows: [] };
  // retro 窗口决策加载
  if (s.includes('FROM crm.decision') && s.includes('ORDER BY decided_at DESC')) {
    return { rows: h.decisionRows };
  }
  // retro 整改报告落库
  if (s.includes('INSERT INTO crm.decision_retro_report')) {
    return { rows: [{ report_id: 'rep-todo-1' }] };
  }
  // dailyOps 三源聚合（decision/tasks/sla）→ 空聚合兜底
  if (s.includes('FROM crm.decision') || s.includes('FROM crm.tasks') || s.includes('FROM crm.agent_sla')) {
    return { rows: [{}] };
  }
  if (s.includes('crm.config_store')) return { rows: [] };
  return { rows: [] };
}

vi.mock('../../src/db.js', () => ({
  query: async (sql, params) => exec(sql, params),
  queryWrite: async (sql, params) => exec(sql, params),
  withTx: async (fn) => fn({
    query: async (sql, params) => { h.txClientSqls.push(String(sql)); return exec(sql, params); },
  }),
}));

import { createPatch, savePatches, approvePatch } from '../../src/calibration/store.js';
import { runDecisionRetro } from '../../src/decision/retro.js';
import { createCalibrationRouter } from '../../src/http/calibrationRouter.js';
import { normalizeRole } from '../../src/http/middleware/rbac.js';

const produce = async () => ({ decisionId: 'dec-todo-1', ok: true });

function mkRow(scenarioId, i, tenantId) {
  return {
    decision_id: `d-${scenarioId}-${i}`,
    scenario_id: scenarioId,
    tenant_id: tenantId,
    decided_at: new Date().toISOString(),
    attribution: { category: 'dim_missing', required_fill: { missing: ['identity'] }, edge_compliance: {} },
    feedback: { usable: true, major_deviation: false },
  };
}
const VALID_OUT = {
  root_cause_class: 'DATA_QUALITY_PRECEDENT',
  root_cause_explanation: '先例命中率 12% vs 健康线 30%',
  draft_patches: [{
    knob: 'config_store', target: 'precedent-conf.minSimilarity',
    from_value: 0.45, to_value: 0.40, risk: 'LOW',
    label: 'minSimilarity 下调 0.45→0.40', evidence: { hit_rate_measured: '0.12' },
  }],
  confidence: 0.8, predicted_impact: '先例召回提升',
};

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => { res.body = o; return res; };
  return res;
}

beforeEach(() => {
  h.patches.clear(); h.configs.clear(); h.seq = 0; h.txClientSqls = [];
});

describe('config_store 待办 · 批准即生效（§16.3）', () => {
  it('批准 config_store 处方 → config_store 即时生效（子键合并不丢兄弟键，写经事务 client）', async () => {
    h.configs.set('system|precedent-conf', { value: { minSimilarity: 0.45, topK: 5 }, decision_id: null });
    const patch = await createPatch({
      knob: 'config_store', target: 'precedent-conf.minSimilarity',
      from_value: 0.45, to_value: 0.40, evidence: { hit_rate: 0.12 }, risk: 'LOW',
      assignee: 'ADMIN', tenant_id: 'system',
    });
    expect(patch.status).toBe('PENDING');
    expect(patch.assignee).toBe('ADMIN');

    const r = await approvePatch(patch.patch_id, { produce, resolved_by: 'admin' });
    expect(r.patch.status).toBe('APPLIED');
    expect(r.patch.decision_id).toBe('dec-todo-1');

    // 批准即生效：minSimilarity 0.45→0.40，topK 兄弟子键保留（缺陷 #9：合并语义，禁整行覆盖）
    const after = h.configs.get('system|precedent-conf');
    expect(after.value).toEqual({ minSimilarity: 0.40, topK: 5 });
    expect(after.decision_id).toBe('dec-todo-1');

    // 写通道必须经 withTx 的 client（approvePatch 事务原子性），而非池级 writeConfig
    expect(h.txClientSqls.some((s) => s.includes('INSERT INTO crm.config_store'))).toBe(true);
  });

  it('租户级待办（tenant_id=t1, assignee=tan_admin）批准 → 写本租户配置，system 行不动', async () => {
    h.configs.set('system|precedent-conf', { value: { minSimilarity: 0.45, topK: 5 }, decision_id: null });
    const patch = await createPatch({
      knob: 'config_store', target: 'precedent-conf.minSimilarity',
      from_value: 0.45, to_value: 0.40, evidence: {}, risk: 'LOW',
      assignee: 'tan_admin', tenant_id: 't1',
    });
    await approvePatch(patch.patch_id, { produce, resolved_by: 'ten_admin@t1' });

    expect(h.configs.get('t1|precedent-conf').value).toEqual({ minSimilarity: 0.40, topK: 5 });
    expect(h.configs.get('system|precedent-conf').value).toEqual({ minSimilarity: 0.45, topK: 5 });
  });

  it('approve 非 PENDING 状态 → 抛错（APPLIED 不可再批）', async () => {
    const patch = await createPatch({
      knob: 'config_store', target: 'seven-dim.confidence', from_value: null,
      to_value: 0.8, evidence: {}, risk: 'LOW', assignee: 'ADMIN', tenant_id: 'system',
    });
    await approvePatch(patch.patch_id, { produce });
    await expect(approvePatch(patch.patch_id, { produce })).rejects.toThrow('不可批准');
  });

  it('savePatches 幂等去重含 tenant 维度（重复跑批不刷屏待办，§16.6）', async () => {
    const mk = (tenant_id) => [{
      knob: 'config_store', target: 'precedent-conf.minSimilarity',
      from_value: 0.45, to_value: 0.40, evidence: {}, risk: 'LOW',
      expected_impact: { predicted: 0.22 }, assignee: tenant_id === 'system' ? 'ADMIN' : 'tan_admin',
      tenant_id,
    }];
    const r1 = await savePatches('OPP_QUALIFY', mk('system'));
    expect(r1.created).toBe(1);
    const r2 = await savePatches('OPP_QUALIFY', mk('system')); // 同 target+to_value+PENDING+同租户 → 跳过
    expect(r2.created).toBe(0);
    expect(r2.skipped).toHaveLength(1);
    const r3 = await savePatches('OPP_QUALIFY', mk('t1')); // 不同租户 → 各自独立待办
    expect(r3.created).toBe(1);
  });
});

describe('retro 跑批 → ADMIN 待办推送（§16.1）', () => {
  it('config_store 草稿处方落 PENDING 待办：system 簇→ADMIN、租户簇→tan_admin（不自动 apply）', async () => {
    h.decisionRows = [
      ...Array.from({ length: 25 }, (_, i) => mkRow('OPP_QUALIFY', i, 'system')),
      ...Array.from({ length: 25 }, (_, i) => mkRow('T1_SCEN', i, 't1')),
    ];
    const f = async () => async () => VALID_OUT;

    const rep = await runDecisionRetro({ windowHours: 24, dryRun: false, llmFactory: f, now: '2026-09-05T02:00:00.000Z' });

    const todos = [...h.patches.values()].filter((r) => r.knob === 'config_store');
    expect(todos).toHaveLength(2);
    expect(rep.todos_created).toBe(2);

    const sys = todos.find((r) => r.tenant_id === 'system');
    expect(sys.assignee).toBe('ADMIN');
    expect(sys.status).toBe('PENDING'); // 绝不自动 apply（铁律②）
    expect(sys.decision_id).toBeNull(); // 第0闸决策在批准时产生（缺陷 #11）

    const t1 = todos.find((r) => r.tenant_id === 't1');
    expect(t1.assignee).toBe('tan_admin');
    expect(t1.status).toBe('PENDING');
  });

  it('重复跑批（同 target/to_value/租户 PENDING）→ 不刷屏（幂等跳过）', async () => {
    h.decisionRows = Array.from({ length: 25 }, (_, i) => mkRow('OPP_QUALIFY', i, 'system'));
    const f = async () => async () => VALID_OUT;
    await runDecisionRetro({ windowHours: 24, dryRun: false, llmFactory: f, now: '2026-09-05T02:00:00.000Z' });
    const rep2 = await runDecisionRetro({ windowHours: 24, dryRun: false, llmFactory: f, now: '2026-09-05T03:00:00.000Z' });
    expect(rep2.todos_created).toBe(0);
    expect([...h.patches.values()].filter((r) => r.knob === 'config_store')).toHaveLength(1);
  });
});

describe('GET /api/admin/todos · 可见性（§16.4）', () => {
  it('tan_admin（角色名 ten_admin）仅见本租户待办；admin 全量', async () => {
    await createPatch({
      knob: 'config_store', target: 'precedent-conf.minSimilarity', from_value: 0.45,
      to_value: 0.40, evidence: {}, risk: 'LOW', assignee: 'ADMIN', tenant_id: 'system',
    });
    await createPatch({
      knob: 'config_store', target: 'sales-thresholds.discount', from_value: 0.8,
      to_value: 0.75, evidence: {}, risk: 'MEDIUM', assignee: 'tan_admin', tenant_id: 't1',
    });

    const mkRouter = (role, tenantId) => createCalibrationRouter({
      resolveMe: async () => ({ ok: true, role, tenantId }),
    });

    // ten_admin（用户管理页实际角色名）限本租户
    const resTan = fakeRes();
    await mkRouter('ten_admin', 't1').handlers.todos({ query: {} }, resTan);
    expect(resTan.statusCode).toBe(200);
    expect(resTan.body.todos).toHaveLength(1);
    expect(resTan.body.todos[0].tenant_id).toBe('t1');

    // admin 全量
    const resAdmin = fakeRes();
    await mkRouter('admin', 'system').handlers.todos({ query: {} }, resAdmin);
    expect(resAdmin.statusCode).toBe(200);
    expect(resAdmin.body.todos).toHaveLength(2);
  });

  it('未登录/无权限角色 → 403（fail-closed）', async () => {
    const router = createCalibrationRouter({ resolveMe: async () => ({ ok: true, role: 'sales' }) });
    const res = fakeRes();
    await router.handlers.todos({ query: {} }, res);
    expect(res.statusCode).toBe(403);
  });
});

describe('rbac 别名补齐（缺陷 #12）', () => {
  it("normalizeRole('ten_admin') → TAN_ADMIN（用户管理页实际角色名，勿 fail-closed 误杀）", () => {
    expect(normalizeRole('ten_admin')).toBe('TAN_ADMIN');
    expect(normalizeRole('tan_admin')).toBe('TAN_ADMIN');
    expect(normalizeRole('sales')).toBeNull();
  });
});
