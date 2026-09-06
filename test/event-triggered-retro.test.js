// test/event-triggered-retro.test.js —— ③ 事件触发式复盘验收（2026-09-01）
// 设计 docs/2026-09-01-event-triggered-retro-design.md（方案 A：事件总线订阅）
// 锁定六类行为：
//   ① HIGH/CRITICAL 决策确认 → 建 intent=retro 任务（tenant 随决策）
//   ② NORMAL 决策 → 分级闸拦下（不建单）
//   ③ 冷却窗内已有复盘任务 → 冷却闸拦下
//   ④ 配置 enabled=false → 总开关拦下；配置读失败 → fail-open 用出厂默认
//   ⑤ 建出的任务经 routeThroughIntake 真路由到 decision-retro 且不触发评审闸
//   ⑥ auto_pump 透传 tenantId（修 pumpReadyTasks 多租户缺口）
// 隔离 db / configStore / kanban；scheduler 用真实实现（以验证 tenantId 透传链路）。
import { describe, it, expect, vi, beforeEach } from 'vitest';

// —— 可控桩状态 ——
const state = {
  tier: 'HIGH',
  tenantId: 't-acme',
  decisionMissing: false,
  tenantColMissing: false, // 模拟旧库未跑 migrate-tenant.js（decision 无 tenant_id 列）
  hasRecentRetro: false,
  cfg: null,               // null → readConfig 返回 null（走出厂默认）
  cfgThrows: false,        // true → readConfig 抛错（验证 fail-open）
};

const queryMock = vi.fn(async (text) => {
  if (/FROM crm\.decision/.test(text)) {
    if (state.tenantColMissing && /tenant_id/.test(text)) {
      throw new Error('column "tenant_id" does not exist');
    }
    if (state.decisionMissing) return { rows: [] };
    return { rows: [{ business_tier: state.tier, tenant_id: state.tenantId }] };
  }
  if (/FROM crm\.tasks/.test(text)) {
    return { rows: state.hasRecentRetro ? [{ id: 'task-existing' }] : [] };
  }
  return { rows: [] };
});

vi.mock('../src/db.js', () => ({
  query: (...a) => queryMock(...a),
  queryWrite: (...a) => queryMock(...a),
  queryRead: (...a) => queryMock(...a),
  withTx: async (fn) => fn({ query: (...a) => queryMock(...a) }),
  pool: { query: (...a) => queryMock(...a) },
  poolRead: { query: (...a) => queryMock(...a) },
}));

vi.mock('../src/config/configStore.js', () => ({
  readConfig: async () => {
    if (state.cfgThrows) throw new Error('config_store unreachable');
    return state.cfg ? { value: state.cfg, decision_id: null } : null;
  },
  writeConfig: async () => ({ ok: true }),
}));

const createTaskMock = vi.fn(async (args) => ({ id: 'task-new', ...args }));
const listTasksMock = vi.fn(async () => []);
vi.mock('../src/kanban/kanban.js', () => ({
  createTask: (...a) => createTaskMock(...a),
  listTasks: (...a) => listTasksMock(...a),
  getTask: async () => null,
  claimTask: async () => null,
  completeTask: async () => null,
  failTask: async () => null,
  auditTransition: async () => {},
}));

const {
  maybeTriggerRetro,
  tierPasses,
  readEventRetroConfig,
  registerRetroTrigger,
  unregisterRetroTrigger,
  DEFAULT_EVENT_RETRO_CFG,
} = await import('../src/decision/retroTrigger.js');
const { routeThroughIntake } = await import('../src/kanban/scheduler.js');
const { emit } = await import('../src/events/bus.js');

const tick = () => new Promise((r) => setTimeout(r, 20));

beforeEach(() => {
  Object.assign(state, {
    tier: 'HIGH',
    tenantId: 't-acme',
    decisionMissing: false,
    tenantColMissing: false,
    hasRecentRetro: false,
    cfg: null,
    cfgThrows: false,
  });
  queryMock.mockClear();
  createTaskMock.mockClear();
  listTasksMock.mockClear();
  unregisterRetroTrigger();
});

describe('① 分级闸：重大决策确认即建复盘任务', () => {
  it('HIGH 决策 → 建 intent=retro 任务，tenant 随决策', async () => {
    const r = await maybeTriggerRetro('dec-1234567890');
    expect(r.created).toBe(true);
    expect(createTaskMock).toHaveBeenCalledTimes(1);
    const arg = createTaskMock.mock.calls[0][0];
    expect(arg.tenantId).toBe('t-acme');
    expect(arg.step).toBe('retro');
    expect(arg.actionName).toBe('decision-retrospective');
    expect(arg.decisionId).toBe('dec-1234567890');
    expect(arg.payload.intent).toBe('retro');
    expect(arg.payload.level).toBe('L2');
    expect(arg.payload.triggered_by).toBe('event');
    expect(arg.payload.business_tier).toBe('HIGH');
    expect(arg.title).toContain('dec-1234'); // 决策短号入标题，便于人工识别
  });

  it('CRITICAL 决策同样触发', async () => {
    state.tier = 'CRITICAL';
    expect((await maybeTriggerRetro('dec-c1')).created).toBe(true);
  });

  it('NORMAL 决策被分级闸拦下', async () => {
    state.tier = 'NORMAL';
    const r = await maybeTriggerRetro('dec-n1');
    expect(r.created).toBe(false);
    expect(r.reason).toBe('tier_below_min:NORMAL');
    expect(createTaskMock).not.toHaveBeenCalled();
  });

  it('min_tier 可配置为 CRITICAL（HIGH 随之被拦）', async () => {
    state.cfg = { min_tier: 'CRITICAL' };
    expect(tierPasses('HIGH', { min_tier: 'CRITICAL' })).toBe(false);
    expect(tierPasses('CRITICAL', { min_tier: 'CRITICAL' })).toBe(true);
    const r = await maybeTriggerRetro('dec-h1');
    expect(r.created).toBe(false);
    expect(r.reason).toBe('tier_below_min:HIGH');
  });

  it('未知/缺失 tier 视作最低级（不触发）', async () => {
    state.tier = null;
    expect((await maybeTriggerRetro('dec-x')).created).toBe(false);
  });
});

describe('② 冷却闸与前置校验', () => {
  it('冷却窗内已有复盘任务 → 跳过', async () => {
    state.hasRecentRetro = true;
    const r = await maybeTriggerRetro('dec-2');
    expect(r).toEqual({ created: false, reason: 'cooldown' });
    expect(createTaskMock).not.toHaveBeenCalled();
  });

  it('冷却查询按 tenant + intent=retro + 可配置窗口', async () => {
    state.cfg = { cooldown_hours: 6 };
    await maybeTriggerRetro('dec-3');
    const call = queryMock.mock.calls.find((c) => /FROM crm\.tasks/.test(c[0]));
    expect(call[0]).toMatch(/payload->>'intent'='retro'/);
    expect(call[0]).toMatch(/make_interval\(hours => \$2::int\)/);
    expect(call[1]).toEqual(['t-acme', 6]);
  });

  it('决策不存在 / 无 decision_id → 跳过', async () => {
    expect((await maybeTriggerRetro(null)).reason).toBe('no_decision_id');
    state.decisionMissing = true;
    expect((await maybeTriggerRetro('dec-missing')).reason).toBe('decision_not_found');
  });
});

describe('③ 配置总开关与 fail-open', () => {
  it('enabled=false → 不建单', async () => {
    state.cfg = { enabled: false };
    expect(await maybeTriggerRetro('dec-4')).toEqual({ created: false, reason: 'disabled' });
  });

  it('配置读失败 → 回落出厂默认（fail-open，链路不断）', async () => {
    state.cfgThrows = true;
    const cfg = await readEventRetroConfig();
    expect(cfg).toEqual({ ...DEFAULT_EVENT_RETRO_CFG });
    expect((await maybeTriggerRetro('dec-5')).created).toBe(true);
  });

  it('出厂默认：启用 / HIGH 起触发 / 24h 冷却', () => {
    expect(DEFAULT_EVENT_RETRO_CFG.enabled).toBe(true);
    expect(DEFAULT_EVENT_RETRO_CFG.min_tier).toBe('HIGH');
    expect(DEFAULT_EVENT_RETRO_CFG.cooldown_hours).toBe(24);
  });
});

describe('④ 旧库容错：decision.tenant_id 为迁移列', () => {
  it('缺 tenant_id 列时退化查询并落 system 租户（不中断建单）', async () => {
    state.tenantColMissing = true;
    const r = await maybeTriggerRetro('dec-6');
    expect(r.created).toBe(true);
    expect(r.tenantId).toBe('system');
    expect(createTaskMock.mock.calls[0][0].tenantId).toBe('system');
  });
});

describe('⑤ 建出的任务真路由到复盘智能体', () => {
  it('routeThroughIntake → decision-retro，且 L2 不触发评审闸', async () => {
    await maybeTriggerRetro('dec-7');
    const payload = createTaskMock.mock.calls[0][0].payload;
    const routed = routeThroughIntake({ id: 'task-new', payload });
    expect(routed.targetAgent).toBe('decision-retro');
    expect(routed.gateAgents).toEqual([]);
    expect(routed.payload.contract_task_id).toBe('ct-retro-decision');
    expect(routed.payload.skill_slug).toBe('decision-retrospective');
  });
});

describe('⑥ auto_pump 多租户透传（pumpReadyTasks 缺口修复）', () => {
  it('建单后泵队列时按决策租户扫描 ready', async () => {
    await maybeTriggerRetro('dec-8');
    expect(listTasksMock).toHaveBeenCalledWith({ status: 'ready', chainId: null, tenantId: 't-acme' });
  });

  it('auto_pump=false 时不泵队列', async () => {
    state.cfg = { auto_pump: false };
    await maybeTriggerRetro('dec-9');
    expect(listTasksMock).not.toHaveBeenCalled();
  });
});

describe('⑦ 事件订阅：decision:confirmed 触发，其它类型不触发', () => {
  it('confirmed 事件驱动建单', async () => {
    registerRetroTrigger();
    emit('decision', 'confirmed', { decision_id: 'dec-evt-1', by_role: 'admin' });
    await tick();
    expect(createTaskMock).toHaveBeenCalledTimes(1);
    expect(createTaskMock.mock.calls[0][0].payload.source).toBe('decision:confirmed');
  });

  it('非 confirmed 事件（created / outcome-set）不触发', async () => {
    registerRetroTrigger();
    emit('decision', 'created', { decision_id: 'dec-evt-2' });
    emit('decision', 'outcome-set', { decision_id: 'dec-evt-3' });
    await tick();
    expect(createTaskMock).not.toHaveBeenCalled();
  });

  it('缺 decision_id 的 confirmed 事件被忽略', async () => {
    registerRetroTrigger();
    emit('decision', 'confirmed', {});
    await tick();
    expect(createTaskMock).not.toHaveBeenCalled();
  });

  it('重复注册幂等（单次事件只建一单）', async () => {
    const a = registerRetroTrigger();
    const b = registerRetroTrigger();
    expect(a).toBe(b);
    emit('decision', 'confirmed', { decision_id: 'dec-evt-4' });
    await tick();
    expect(createTaskMock).toHaveBeenCalledTimes(1);
  });

  it('订阅器内异常不外抛（emit 写路径不被阻断）', async () => {
    registerRetroTrigger();
    state.tier = 'HIGH';
    createTaskMock.mockImplementationOnce(async () => { throw new Error('db down'); });
    expect(() => emit('decision', 'confirmed', { decision_id: 'dec-evt-5' })).not.toThrow();
    await tick();
  });

  it('退订后不再响应事件', async () => {
    registerRetroTrigger();
    unregisterRetroTrigger();
    emit('decision', 'confirmed', { decision_id: 'dec-evt-6' });
    await tick();
    expect(createTaskMock).not.toHaveBeenCalled();
  });
});
