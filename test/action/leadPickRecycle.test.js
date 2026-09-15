// test/action/leadPickRecycle.test.js — 线索池 认领(crm-lead-pick) / 回收(crm-lead-recycle) 语义验证（T4）
// 设计：docs/2026-09-11-lead-public-pool-tenant-design.md（公海 S0 / 私海待校验 S0P / 正式线索 S1）
// 立场（对齐 anti-fake-green-probe）：断言锚在**写盘入参**上，而非返回体形态。
//   ① 认领只接受 S0（公海）；S1+ 或已归属 → 必拒。认领后必须落 S0P + pool_id/pool_type。
//   ② 回收只接受 S0P；回收后必须落 S0 + owner_id=null + 回 recycle_target 池。
//   ③ tenantId 必须透传到 updateParticle（P0：此前回收写无租户谓词 → 跨租户可写）。
//   ④ 认领当日计数 SQL 必须带 tenant 谓词（P1：跨租户计数串扰）。
//   ⑤ 认领/回收均**不得**走 advanceStage（lifecycle.js:17 前向单行 → S0P→S0 必被拒）。
// 本用例不依赖 PG：particleRepo / db / pool(读) / autonomyEngine / lifecycle 均已 mock。
import { describe, it, expect, beforeEach, vi } from 'vitest';

const H = vi.hoisted(() => ({
  state: { cfg: null },
  getParticle: vi.fn(),
  updateParticle: vi.fn(),
  query: vi.fn(),
  requireDecision: vi.fn(),
  advanceStage: vi.fn(),
  readPoolConfig: vi.fn(),
  emit: vi.fn(),
}));

const mkCfg = () => ({
  version: 1,
  default_pool: 'pool-new',
  pools: [
    {
      id: 'pool-new', type: 'new', enabled: true,
      pick_rule: { daily_limit: 10, prev_owner_only: false, pick_interval_hours: 24, new_data_only: true },
      recycle_rule: { recycle_days: 30, recycle_target: 'self' },
    },
    {
      id: 'pool-nurture', type: 'nurture', enabled: true,
      pick_rule: { daily_limit: 5, prev_owner_only: true, pick_interval_hours: 24, new_data_only: false },
      recycle_rule: { recycle_days: 90, recycle_target: 'pool-new' },
    },
    {
      id: 'pool-lost', type: 'lost', enabled: true,
      pick_rule: { daily_limit: 5, prev_owner_only: false, pick_interval_hours: 0, new_data_only: false },
      recycle_rule: { recycle_days: 180, recycle_target: 'self' },
    },
  ],
});

vi.mock('../../src/particles/particleRepo.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, getParticle: H.getParticle, updateParticle: H.updateParticle };
});
vi.mock('../../src/particles/lifecycle.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, advanceStage: H.advanceStage };
});
vi.mock('../../src/db.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, query: H.query, queryWrite: H.query };
});
vi.mock('../../src/sales/pool.js', async (importOriginal) => {
  const actual = await importOriginal();
  // 仅 stub 读路径（规则判定用真实 checkPickRule/checkRecycleRule/poolOf/resolvePoolId）
  return { ...actual, readPoolConfig: H.readPoolConfig };
});
vi.mock('../../src/decision/autonomyEngine.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, requireDecision: H.requireDecision };
});
vi.mock('../../src/events/bus.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, emit: H.emit };
});

const { seedActions } = await import('../../src/action/seed-actions.js');
const { resetRegistry, getAction } = await import('../../src/action/registry.js');

const DAY = 86400000;
const isoDaysAgo = (n) => new Date(Date.now() - n * DAY).toISOString();

describe('T4 · 线索池认领/回收 Action 注册形态', () => {
  beforeEach(() => {
    resetRegistry();
    seedActions();
    H.state.cfg = mkCfg();
    H.readPoolConfig.mockImplementation(async () => H.state.cfg);
    H.getParticle.mockReset();
    H.updateParticle.mockReset();
    H.query.mockReset();
    H.advanceStage.mockReset();
    H.requireDecision.mockReset();
    H.query.mockResolvedValue({ rows: [{ n: 0, last_pick: null }] });
    H.requireDecision.mockResolvedValue({ mode: 'AUTO', decision: { decision_id: 'dec-test-1' } });
    H.updateParticle.mockImplementation(async (id, { patch } = {}) => ({ id, payload: patch, tenant_id: 't-alpha' }));
  });

  it('crm-lead-pick / crm-lead-recycle 均已注册（write + autoDecision 第0闸）', () => {
    for (const name of ['crm-lead-pick', 'crm-lead-recycle']) {
      const a = getAction(name);
      expect(a, `${name} 必须注册`).not.toBeNull();
      expect(a.kind).toBe('write');
      expect(a.autoDecision).toBe(true);
      expect(a.namespace).toBe('crm');
    }
  });
});

describe('T4 · crm-lead-pick（认领：仅公海 S0 → 私海待校验 S0P）', () => {
  beforeEach(() => {
    resetRegistry();
    seedActions();
    H.state.cfg = mkCfg();
    H.readPoolConfig.mockImplementation(async () => H.state.cfg);
    H.getParticle.mockReset();
    H.updateParticle.mockReset();
    H.query.mockReset();
    H.advanceStage.mockReset();
    H.requireDecision.mockReset();
    H.query.mockResolvedValue({ rows: [{ n: 0, last_pick: null }] });
    H.requireDecision.mockResolvedValue({ mode: 'AUTO', decision: { decision_id: 'dec-test-1' } });
    H.updateParticle.mockImplementation(async (id, { patch } = {}) => ({ id, payload: patch, tenant_id: 't-alpha' }));
  });

  const pick = (p) => getAction('crm-lead-pick').handler(p, { tenantId: 't-alpha', actor: 'alice' });

  it('① 非 S0（公海）拒领 —— stage=S1 必抛「非公海阶段」', async () => {
    H.getParticle.mockResolvedValue({ id: 'd1', tenant_id: 't-alpha', payload: { stage: 'S1', name: 'x' } });
    await expect(pick({ deal_id: 'd1', owner_id: 'alice' })).rejects.toThrow(/非公海阶段/);
    expect(H.updateParticle).not.toHaveBeenCalled();
  });

  it('② 已归属拒重复领取 —— S0 但带 owner_id 必抛「已有归属」', async () => {
    H.getParticle.mockResolvedValue({ id: 'd2', tenant_id: 't-alpha', payload: { stage: 'S0', owner_id: 'bob', name: 'x' } });
    await expect(pick({ deal_id: 'd2', owner_id: 'alice' })).rejects.toThrow(/已有归属/);
    expect(H.updateParticle).not.toHaveBeenCalled();
  });

  it('③ 认领成功：落 S0P + pool_id/pool_type，且 tenantId 透传写通道', async () => {
    H.getParticle.mockResolvedValue({
      id: 'd3', tenant_id: 't-alpha',
      payload: { stage: 'S0', name: '新线索', is_new: true, prev_owner_id: 'carol' },
    });
    await pick({ deal_id: 'd3', owner_id: 'alice' });

    expect(H.updateParticle).toHaveBeenCalledTimes(1);
    const [id, opts] = H.updateParticle.mock.calls[0];
    expect(id).toBe('d3');
    expect(opts.patch.stage).toBe('S0P');           // 认领 ≠ 正式线索
    expect(opts.patch.owner_id).toBe('alice');
    expect(opts.patch.pool_id).toBe('pool-new');
    expect(opts.patch.pool_type).toBe('new');
    expect(opts.patch.prev_owner_id).toBe('carol'); // 前归属保留（回收池 prev_owner_only 依赖）
    expect(opts.tenantId).toBe('t-alpha');          // 写通道租户谓词
  });

  it('④ 当日领取计数 SQL 必须带 tenant 谓词（P1 防跨租户串扰）', async () => {
    H.getParticle.mockResolvedValue({ id: 'd4', tenant_id: 't-alpha', payload: { stage: 'S0', name: 'x', is_new: true } });
    await pick({ deal_id: 'd4', owner_id: 'alice' });
    const call = H.query.mock.calls.find((c) => String(c[0]).includes('count(*)'));
    expect(call, '认领必须查当日领取计数').toBeTruthy();
    expect(String(call[0])).toContain('tenant_id=$2');
    expect(String(call[0])).toContain("payload->>'stage'='S0P'");
    expect(call[1]).toEqual(['alice', 't-alpha']);
  });

  it('⑤ 池规则拒绝（daily_limit 已达上限）→ 不写盘', async () => {
    H.getParticle.mockResolvedValue({ id: 'd5', tenant_id: 't-alpha', payload: { stage: 'S0', name: 'x', is_new: true } });
    H.query.mockResolvedValue({ rows: [{ n: 99, last_pick: null }] });
    await expect(pick({ deal_id: 'd5', owner_id: 'alice' })).rejects.toThrow(/池领取规则拒绝/);
    expect(H.updateParticle).not.toHaveBeenCalled();
  });

  it('⑥ 认领不得走 advanceStage（lifecycle 前向单行，S0→S0P 不在合法边内）', async () => {
    H.getParticle.mockResolvedValue({ id: 'd6', tenant_id: 't-alpha', payload: { stage: 'S0', name: 'x', is_new: true } });
    await pick({ deal_id: 'd6', owner_id: 'alice' });
    expect(H.advanceStage).not.toHaveBeenCalled();
  });
});

describe('T4 · crm-lead-recycle（回收：仅私海待校验 S0P → 回公海 S0）', () => {
  beforeEach(() => {
    resetRegistry();
    seedActions();
    H.state.cfg = mkCfg();
    H.readPoolConfig.mockImplementation(async () => H.state.cfg);
    H.getParticle.mockReset();
    H.updateParticle.mockReset();
    H.query.mockReset();
    H.advanceStage.mockReset();
    H.requireDecision.mockReset();
    H.query.mockResolvedValue({ rows: [{ n: 0, last_pick: null }] });
    H.requireDecision.mockResolvedValue({ mode: 'AUTO', decision: { decision_id: 'dec-test-2' } });
    H.updateParticle.mockImplementation(async (id, { patch } = {}) => ({ id, payload: patch, tenant_id: 't-alpha' }));
  });

  const recycle = (p) => getAction('crm-lead-recycle').handler(p, { tenantId: 't-alpha', actor: 'system' });

  it('① 公海 S0 不可回收（无归属，不参与超期回收）→ 抛「非私海待校验阶段」', async () => {
    H.getParticle.mockResolvedValue({ id: 'r1', tenant_id: 't-alpha', payload: { stage: 'S0', name: 'x' } });
    await expect(recycle({ deal_id: 'r1' })).rejects.toThrow(/非私海待校验阶段/);
    expect(H.updateParticle).not.toHaveBeenCalled();
  });

  it('② 未超期（近期有跟进）→ 抛「未达回收条件」', async () => {
    H.getParticle.mockResolvedValue({
      id: 'r2', tenant_id: 't-alpha',
      payload: { stage: 'S0P', owner_id: 'alice', pool_id: 'pool-new', last_follow_up_at: isoDaysAgo(3) },
    });
    await expect(recycle({ deal_id: 'r2' })).rejects.toThrow(/未达回收条件/);
    expect(H.updateParticle).not.toHaveBeenCalled();
  });

  it('③ 超期回收成功：回 S0 + owner 置空 + 保留前归属 + 回 pool-new，且 tenantId 透传（P0 锚点）', async () => {
    H.getParticle.mockResolvedValue({
      id: 'r3', tenant_id: 't-alpha',
      payload: { stage: 'S0P', owner_id: 'alice', pool_id: 'pool-new', pool_type: 'new', last_follow_up_at: isoDaysAgo(45) },
    });
    await recycle({ deal_id: 'r3', reason: '超期未跟进' });

    expect(H.updateParticle).toHaveBeenCalledTimes(1);
    const [id, opts] = H.updateParticle.mock.calls[0];
    expect(id).toBe('r3');
    expect(opts.patch.stage).toBe('S0');            // 回公海
    expect(opts.patch.owner_id).toBeNull();
    expect(opts.patch.prev_owner_id).toBe('alice'); // 前归属留痕（供 prev_owner_only 领取策略）
    expect(opts.patch.pool_id).toBe('pool-new');    // recycle_target='self' → 回本池
    expect(opts.patch.recycle_reason).toBe('超期未跟进');
    // ★ P0：回收写通道必须带租户谓词（此前缺失 → 跨租户可写）
    expect(opts.tenantId).toBe('t-alpha');
  });

  it('④ recycle_target 指向他池 → 回收落到目标池（nurture → pool-new）', async () => {
    H.getParticle.mockResolvedValue({
      id: 'r4', tenant_id: 't-alpha',
      payload: { stage: 'S0P', owner_id: 'alice', pool_id: 'pool-nurture', pool_type: 'nurture', last_follow_up_at: isoDaysAgo(120) },
    });
    await recycle({ deal_id: 'r4' });
    const opts = H.updateParticle.mock.calls[0][1];
    expect(opts.patch.pool_id).toBe('pool-new');       // nurture.recycle_target
    expect(opts.patch.pool_type).toBe('new');          // 目标池类型（非源池 nurture）
    expect(opts.patch.stage).toBe('S0');
  });

  it('⑤ 回收不得走 advanceStage（S0P→S0 非合法前向边，须走 updateParticle）', async () => {
    H.getParticle.mockResolvedValue({
      id: 'r5', tenant_id: 't-alpha',
      payload: { stage: 'S0P', owner_id: 'alice', pool_id: 'pool-new', last_follow_up_at: isoDaysAgo(60) },
    });
    await recycle({ deal_id: 'r5' });
    expect(H.advanceStage).not.toHaveBeenCalled();
  });

  it('⑥ 无 last_follow_up_at（从未跟进）→ 不回收（避免新线索误回收）', async () => {
    H.getParticle.mockResolvedValue({
      id: 'r6', tenant_id: 't-alpha',
      payload: { stage: 'S0P', owner_id: 'alice', pool_id: 'pool-new' },
    });
    await expect(recycle({ deal_id: 'r6' })).rejects.toThrow(/未达回收条件/);
  });
});

// ── T4 派发前复查补强（2026-09-11）：D1 日限语义 / D5 事件租户键 / D6 显式池解析 ──
// 立场：断言锚在**写盘入参与 SQL 文本**上，而非返回体。前六例只证明「有 SQL 带 tenant」，
//   无法鉴别「daily_limit 退化为在库总量上限」与「pool_id 解析被绕过」两类静默失效。
describe('T4 · 日限语义 / 事件租户键 / 显式池（D1/D5/D6）', () => {
  beforeEach(() => {
    resetRegistry();
    seedActions();
    H.state.cfg = mkCfg();
    H.readPoolConfig.mockImplementation(async () => H.state.cfg);
    H.getParticle.mockReset();
    H.updateParticle.mockReset();
    H.query.mockReset();
    H.advanceStage.mockReset();
    H.requireDecision.mockReset();
    H.emit.mockReset();
    H.query.mockResolvedValue({ rows: [{ n: 0, last_pick: null }] });
    H.requireDecision.mockResolvedValue({ mode: 'AUTO', decision: { decision_id: 'dec-test-3' } });
    H.updateParticle.mockImplementation(async (id, { patch } = {}) => ({ id, payload: patch, tenant_id: 't-alpha' }));
  });

  const pick = (p) => getAction('crm-lead-pick').handler(p, { tenantId: 't-alpha', actor: 'alice' });

  it('⑦ D1 日限计数必须限定「当日」且基于 picked_at —— 否则 daily_limit 退化为在库 S0P 总量上限', async () => {
    H.getParticle.mockResolvedValue({ id: 'd7', tenant_id: 't-alpha', payload: { stage: 'S0', name: 'x', is_new: true } });
    await pick({ deal_id: 'd7', owner_id: 'alice' });
    const call = H.query.mock.calls.find((c) => String(c[0]).includes('count(*)'));
    expect(call, '认领必须查领取计数').toBeTruthy();
    const sql = String(call[0]);
    // 无日期谓词 → 统计的是历史累计在库量；销售累计持有 N 条即锁死当日份额
    expect(sql, '日限计数缺「当日」谓词（daily_limit 语义失效）').toMatch(/date_trunc\('day'/);
    // 必须锚在领取时间 picked_at，而非会被任意更新刷新的 updated_at
    expect(sql, '计数未锚定 picked_at').toContain("payload->>'picked_at'");
    expect(call[1]).toEqual(['alice', 't-alpha']);
  });

  it('⑧ D6 认领可显式落非默认池（pool_id=pool-nurture → nurture 池，证明 resolvePoolId 未被绕过）', async () => {
    H.getParticle.mockResolvedValue({ id: 'd8', tenant_id: 't-alpha', payload: { stage: 'S0', name: 'x', is_new: true } });
    await pick({ deal_id: 'd8', owner_id: 'alice', pool_id: 'pool-nurture' });
    const opts = H.updateParticle.mock.calls[0][1];
    expect(opts.patch.pool_id).toBe('pool-nurture');
    expect(opts.patch.pool_type).toBe('nurture');
  });

  it('⑨ D5 lead-picked 事件租户键为 tenant_id（与 timers lead-overdue 一致，多租户可路由）', async () => {
    H.getParticle.mockResolvedValue({ id: 'd9', tenant_id: 't-alpha', payload: { stage: 'S0', name: 'x', is_new: true } });
    await pick({ deal_id: 'd9', owner_id: 'alice' });
    const ev = H.emit.mock.calls.find((c) => c[1] === 'lead-picked');
    expect(ev, 'lead-picked 事件必须发出').toBeTruthy();
    expect(ev[2].tenant_id, '事件租户键须为 tenant_id（非 tenantId）').toBe('t-alpha');
  });

  it('⑩ D5 lead-recycled 事件租户键为 tenant_id（与 lead-picked / lead-overdue 三处一致）', async () => {
    H.getParticle.mockResolvedValue({
      id: 'r10', tenant_id: 't-alpha',
      payload: { stage: 'S0P', owner_id: 'alice', pool_id: 'pool-new', pool_type: 'new', last_follow_up_at: isoDaysAgo(45) },
    });
    await getAction('crm-lead-recycle').handler({ deal_id: 'r10' }, { tenantId: 't-alpha', actor: 'system' });
    const ev = H.emit.mock.calls.find((c) => c[1] === 'lead-recycled');
    expect(ev, 'lead-recycled 事件必须发出').toBeTruthy();
    expect(ev[2].tenant_id, '事件租户键须为 tenant_id（非 tenantId）').toBe('t-alpha');
  });
});
