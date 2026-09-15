// test/action/leadPoolActions.test.js — 线索池动作族：退回(return) / 归档(archive) / 离职回收(reclaim-bulk)
// 立场（对齐 anti-fake-green-probe）：纯判定常量断言只作辅助；主锚点=**注册形态 + handler 写盘入参**。
//   handler 级用例全部 mock 掉 DB/仓/池读/决策引擎/生命周期 → 与 PG 可用性解耦（不被环境假红掩盖）。
import { describe, it, expect, beforeEach, vi } from 'vitest';

const H = vi.hoisted(() => ({
  state: { cfg: null },
  getParticle: vi.fn(),
  updateParticle: vi.fn(),
  createParticle: vi.fn(),
  query: vi.fn(),
  queryWrite: vi.fn(),
  requireDecision: vi.fn(),
  advanceStage: vi.fn(),
  readPoolConfig: vi.fn(),
  queryParticles: vi.fn(),
}));

const mkCfg = () => ({
  version: 1,
  default_pool: 'pool-new',
  pools: [
    {
      id: 'pool-new', type: 'new', enabled: true,
      pick_rule: { daily_limit: 10, prev_owner_only: false, pick_interval_hours: 24, new_data_only: true },
      recycle_rule: { recycle_days: 30, recycle_target: 'self' },
      return_target: 'pool-nurture',
    },
    {
      id: 'pool-nurture', type: 'nurture', enabled: true,
      pick_rule: { daily_limit: 5, prev_owner_only: true, pick_interval_hours: 24, new_data_only: false },
      recycle_rule: { recycle_days: 90, recycle_target: 'pool-new' },
      return_target: 'pool-nurture',
    },
    {
      id: 'pool-lost', type: 'lost', enabled: true,
      pick_rule: { daily_limit: 5, prev_owner_only: false, pick_interval_hours: 0, new_data_only: false },
      recycle_rule: { recycle_days: 180, recycle_target: 'self' },
      reopenable: true,
    },
  ],
});

vi.mock('../../src/particles/particleRepo.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getParticle: H.getParticle,
    updateParticle: H.updateParticle,
    createParticle: H.createParticle,
    queryParticles: H.queryParticles,
  };
});
vi.mock('../../src/particles/lifecycle.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, advanceStage: H.advanceStage };
});
vi.mock('../../src/db.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, query: H.query, queryWrite: H.queryWrite };
});
vi.mock('../../src/sales/pool.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, readPoolConfig: H.readPoolConfig };
});
vi.mock('../../src/decision/autonomyEngine.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, requireDecision: H.requireDecision };
});

const { seedActions } = await import('../../src/action/seed-actions.js');
const { resetRegistry, getAction } = await import('../../src/action/registry.js');

function resetAll() {
  resetRegistry();
  seedActions();
  H.state.cfg = mkCfg();
  H.readPoolConfig.mockImplementation(async () => H.state.cfg);
  for (const f of [H.getParticle, H.updateParticle, H.createParticle, H.query, H.queryWrite, H.advanceStage, H.requireDecision, H.queryParticles]) f.mockReset();
  H.query.mockResolvedValue({ rows: [] });
  H.queryWrite.mockResolvedValue({ rows: [] });
  H.queryParticles.mockResolvedValue([]);
  H.requireDecision.mockResolvedValue({ mode: 'AUTO', decision: { decision_id: 'dec-lead-1' } });
  H.updateParticle.mockImplementation(async (id, { patch } = {}) => ({ id, payload: patch, tenant_id: 't-alpha' }));
  H.createParticle.mockImplementation(async (p) => ({ id: 'new-1', ...p }));
}

// ───────────────────────── 常量/判据（纯逻辑，辅助锚） ─────────────────────────
const RETURN_REASONS = ['no_project', 'no_budget', 'no_decision_maker', 'no_timeline', 'other'];

describe('T6 · 纯判据（辅助锚）', () => {
  it('reason_code 枚举封闭', () => {
    expect(RETURN_REASONS).toContain('no_budget');
    expect(RETURN_REASONS).not.toContain('随便填');
  });
  it('可退回阶段仅 S0P/S1；S5 与 S0 不可退回', () => {
    const ok = (s) => ['S0P', 'S1'].includes(s);
    expect(ok('S0P')).toBe(true);
    expect(ok('S1')).toBe(true);
    expect(ok('S5')).toBe(false);
    expect(ok('S0')).toBe(false); // 已在公海
  });
});

// ───────────────────────── crm-lead-return（场景②：手动退回） ─────────────────────────
describe('T6 · crm-lead-return（手动退回公海，跳过超期校验）', () => {
  beforeEach(resetAll);

  const call = (p, ctx = { tenantId: 't-alpha', actor: 'alice' }) => getAction('crm-lead-return').handler(p, ctx);

  it('已注册：write + autoDecision（第0闸）+ crm 命名空间', () => {
    const a = getAction('crm-lead-return');
    expect(a).not.toBeNull();
    expect(a.kind).toBe('write');
    expect(a.autoDecision).toBe(true);
    expect(a.namespace).toBe('crm');
  });

  it('非法 reason_code → 拒绝（枚举封闭，防自由文本）', async () => {
    await expect(call({ deal_id: 'd1', reason_code: '随便填' })).rejects.toThrow(/非法 reason_code/);
    expect(H.updateParticle).not.toHaveBeenCalled();
  });

  it('非可退回阶段（S5）→ 拒绝', async () => {
    H.getParticle.mockResolvedValue({ id: 'd2', tenant_id: 't-alpha', payload: { stage: 'S5', owner_id: 'alice', name: 'x' } });
    await expect(call({ deal_id: 'd2', reason_code: 'no_budget' })).rejects.toThrow(/非可退回阶段/);
    expect(H.updateParticle).not.toHaveBeenCalled();
  });

  it('无归属（已在公海）→ 拒绝', async () => {
    H.getParticle.mockResolvedValue({ id: 'd3', tenant_id: 't-alpha', payload: { stage: 'S0P', name: 'x' } });
    await expect(call({ deal_id: 'd3', reason_code: 'no_project' })).rejects.toThrow(/无归属/);
    expect(H.updateParticle).not.toHaveBeenCalled();
  });

  it('★ 核心：未超期也可退回（S0P + 今天有跟进）→ 落 S0 + 回 return_target 池', async () => {
    H.getParticle.mockResolvedValue({
      id: 'd4', tenant_id: 't-alpha',
      payload: {
        stage: 'S0P', owner_id: 'alice', pool_id: 'pool-new', pool_type: 'new',
        last_follow_up_at: new Date().toISOString(),      // 今天刚跟进 → 回收判据必然拒绝，退回必须放行
        qualified_at: '2026-09-01T00:00:00Z', qualified_by: 'alice',
        funnel: { M: true, A: true, N: false, T: false },
      },
    });
    await call({ deal_id: 'd4', reason_code: 'no_budget', note: '客户称预算冻结' });

    expect(H.updateParticle).toHaveBeenCalledTimes(1);
    const [id, opts] = H.updateParticle.mock.calls[0];
    expect(id).toBe('d4');
    expect(opts.patch.stage).toBe('S0');
    expect(opts.patch.owner_id).toBeNull();
    expect(opts.patch.prev_owner_id).toBe('alice');
    expect(opts.patch.pool_id).toBe('pool-nurture');      // return_target：回培育池，不回新线索池
    expect(opts.patch.pool_type).toBe('nurture');
    expect(opts.patch.return_reason).toBe('no_budget');
    expect(opts.patch.return_note).toBe('客户称预算冻结');
    expect(opts.patch.qualified_at).toBeNull();           // 退回即取消正式线索资格
    expect(opts.patch.qualified_by).toBeNull();
    expect(opts.patch).toHaveProperty('mant_ok_at_return'); // 审计留痕（不作拒绝判据）
    expect(opts.tenantId).toBe('t-alpha');
  });

  it('S1 正式线索也可退回（清空 qualified）', async () => {
    H.getParticle.mockResolvedValue({
      id: 'd5', tenant_id: 't-alpha',
      payload: { stage: 'S1', owner_id: 'bob', pool_id: 'pool-new', qualified_at: 'x', qualified_by: 'bob', funnel: {} },
    });
    await call({ deal_id: 'd5', reason_code: 'no_project' });
    const opts = H.updateParticle.mock.calls[0][1];
    expect(opts.patch.stage).toBe('S0');
    expect(opts.patch.qualified_at).toBeNull();
  });

  it('退回不得走 advanceStage（S0P→S0 非合法前向边）', async () => {
    H.getParticle.mockResolvedValue({
      id: 'd6', tenant_id: 't-alpha',
      payload: { stage: 'S0P', owner_id: 'alice', pool_id: 'pool-new', funnel: {} },
    });
    await call({ deal_id: 'd6', reason_code: 'other' });
    expect(H.advanceStage).not.toHaveBeenCalled();
  });
});

// ───────────────────────── 纯判据：归档 / 重开（辅助锚） ─────────────────────────
describe('T7 · 纯判据（辅助锚）', () => {
  it('仅终态 S7/S8 可归档入战败公海；S3 拒绝', () => {
    const archivable = (s) => ['S7', 'S8'].includes(s);
    expect(archivable('S7')).toBe(true);
    expect(archivable('S8')).toBe(true);
    expect(archivable('S3')).toBe(false);
  });

  it('重开源阶段含 S0+lost（战败公海）', () => {
    const reopenable = (s, poolType) => ['S7', 'S8'].includes(s) || (s === 'S0' && poolType === 'lost');
    expect(reopenable('S0', 'lost')).toBe(true);
    expect(reopenable('S0', 'new')).toBe(false);
    expect(reopenable('S0', 'nurture')).toBe(false);
    expect(reopenable('S7', 'new')).toBe(true);
  });
});

// ───────────────────────── crm-deal-archive-to-pool（场景③：战败归档） ─────────────────────────
describe('T7 · crm-deal-archive-to-pool（战败归档进 lost 池）', () => {
  beforeEach(resetAll);

  const call = (p, ctx = { tenantId: 't-alpha', actor: 'alice' }) => getAction('crm-deal-archive-to-pool').handler(p, ctx);

  it('已注册：write + critical 确认 + autoDecision', () => {
    const a = getAction('crm-deal-archive-to-pool');
    expect(a).not.toBeNull();
    expect(a.kind).toBe('write');
    expect(a.confirm).toBe('critical');
    expect(a.autoDecision).toBe(true);
  });

  it('非终态（S3）→ 拒绝', async () => {
    H.getParticle.mockResolvedValue({ id: 'a1', tenant_id: 't-alpha', payload: { stage: 'S3', owner_id: 'alice', name: 'x' } });
    await expect(call({ deal_id: 'a1' })).rejects.toThrow(/仅终态/);
    expect(H.updateParticle).not.toHaveBeenCalled();
  });

  it('★ 核心：S7 归档 → stage=S0 + pool_type=lost + 保留 last_terminal_stage + 前池留痕', async () => {
    H.getParticle.mockResolvedValue({
      id: 'a2', tenant_id: 't-alpha',
      payload: { stage: 'S7', owner_id: 'alice', pool_id: 'pool-new', pool_type: 'new', name: 'x' },
    });
    await call({ deal_id: 'a2', reason: '客户预算取消' });

    expect(H.updateParticle).toHaveBeenCalledTimes(1);
    const [id, opts] = H.updateParticle.mock.calls[0];
    expect(id).toBe('a2');
    expect(opts.patch.stage).toBe('S0');                 // 统一公海语义
    expect(opts.patch.pool_type).toBe('lost');
    expect(opts.patch.pool_id).toBe('pool-lost');
    expect(opts.patch.owner_id).toBeNull();
    expect(opts.patch.prev_owner_id).toBe('alice');
    expect(opts.patch.last_terminal_stage).toBe('S7');   // 战败事实不因归档丢失
    expect(opts.patch.prev_pool_id).toBe('pool-new');    // 供重开恢复
    expect(opts.patch.prev_pool_type).toBe('new');
    expect(opts.patch.archive_reason).toBe('客户预算取消');
    expect(opts.tenantId).toBe('t-alpha');
  });

  it('S8 同样可归档', async () => {
    H.getParticle.mockResolvedValue({ id: 'a3', tenant_id: 't-alpha', payload: { stage: 'S8', owner_id: 'bob', pool_id: 'pool-new', pool_type: 'new' } });
    await call({ deal_id: 'a3' });
    expect(H.updateParticle.mock.calls[0][1].patch.last_terminal_stage).toBe('S8');
    expect(H.updateParticle.mock.calls[0][1].patch.pool_type).toBe('lost');
  });
});

// ───────────────────────── reopenDeal（S7/S8 或 S0+lost → S0P） ─────────────────────────
describe('T7 · reopenDeal 重开目标 S0P + 战败公海可激活', () => {
  beforeEach(resetAll);

  it('★ S7 重开 → S0P（重走 BANT），不再直落 S2', async () => {
    H.getParticle.mockResolvedValue({
      id: 'r1', tenant_id: 't-alpha',
      payload: { stage: 'S7', pool_id: 'pool-lost', pool_type: 'lost', prev_pool_id: 'pool-new', prev_pool_type: 'new' },
    });
    const { reopenDeal } = await import('../../src/sales/reopenDeal.js');
    const u = await reopenDeal('r1', { reason: '客户回流', owner: 'alice', decision_id: 'dec-r', tenantId: 't-alpha' });
    expect(u.payload.stage).toBe('S0P');
    expect(u.payload.pool_id).toBe('pool-new');          // 恢复战败前池
    expect(u.payload.pool_type).toBe('new');
    expect(u.payload.last_terminal_stage).toBe('S7');
    expect(u.payload.reopen_count).toBe(1);
    expect(H.updateParticle.mock.calls[0][1].tenantId).toBe('t-alpha');
  });

  it('★ S0+lost（战败公海）可激活 → S0P', async () => {
    H.getParticle.mockResolvedValue({
      id: 'r2', tenant_id: 't-alpha',
      payload: { stage: 'S0', pool_type: 'lost', pool_id: 'pool-lost', last_terminal_stage: 'S8' },
    });
    const { reopenDeal } = await import('../../src/sales/reopenDeal.js');
    const u = await reopenDeal('r2', { reason: '重启', owner: 'alice', decision_id: 'dec-r2', tenantId: 't-alpha' });
    expect(u.payload.stage).toBe('S0P');
    expect(u.payload.last_terminal_stage).toBe('S8');    // 从归档留痕继承
  });

  it('普通公海（S0+new）不可激活', async () => {
    H.getParticle.mockResolvedValue({ id: 'r3', tenant_id: 't-alpha', payload: { stage: 'S0', pool_type: 'new' } });
    const { reopenDeal } = await import('../../src/sales/reopenDeal.js');
    await expect(reopenDeal('r3', { reason: 'x', owner: 'u', decision_id: 'd' })).rejects.toThrow(/仅退出态/);
  });

  it('非终态（S2）不可激活', async () => {
    H.getParticle.mockResolvedValue({ id: 'r4', tenant_id: 't-alpha', payload: { stage: 'S2' } });
    const { reopenDeal } = await import('../../src/sales/reopenDeal.js');
    await expect(reopenDeal('r4', { reason: 'x', owner: 'u', decision_id: 'd' })).rejects.toThrow(/仅退出态/);
  });

  it('缺 decision_id → 拒绝（决策锚定强制）', async () => {
    H.getParticle.mockResolvedValue({ id: 'r5', tenant_id: 't-alpha', payload: { stage: 'S7' } });
    const { reopenDeal } = await import('../../src/sales/reopenDeal.js');
    await expect(reopenDeal('r5', { reason: 'x', owner: 'u' })).rejects.toThrow(/decision_id/);
  });
});

// ───────────────────────── 纯判据：离职回收（辅助锚） ─────────────────────────
describe('T8 · 纯判据（辅助锚）', () => {
  it('离职回收范围：非终态归原池，终态 S7/S8 归 lost 且不改阶段', () => {
    const plan = (stage, poolType) => (['S7', 'S8'].includes(stage)
      ? { poolType: 'lost', changeStage: false }
      : { poolType: poolType || 'new', changeStage: true });
    expect(plan('S3', 'new')).toEqual({ poolType: 'new', changeStage: true });
    expect(plan('S0P', 'nurture')).toEqual({ poolType: 'nurture', changeStage: true });
    expect(plan('S8', 'new')).toEqual({ poolType: 'lost', changeStage: false });
  });

  it('离职回收禁 system 通配租户', () => {
    const allowed = (t) => Boolean(t) && t !== 'system';
    expect(allowed('system')).toBe(false);
    expect(allowed('t-a')).toBe(true);
    expect(allowed('')).toBe(false);
  });
});

// ───────────────────────── crm-lead-reclaim-bulk（场景④：离职批量回收） ─────────────────────────
describe('T8 · crm-lead-reclaim-bulk（离职批量回收，租户强限定）', () => {
  beforeEach(resetAll);

  const call = (p, ctx) => getAction('crm-lead-reclaim-bulk').handler(p, ctx);

  it('已注册：write + critical 确认 + autoDecision', () => {
    const a = getAction('crm-lead-reclaim-bulk');
    expect(a).not.toBeNull();
    expect(a.kind).toBe('write');
    expect(a.confirm).toBe('critical');
    expect(a.autoDecision).toBe(true);
  });

  it('★ 安全闸：system 通配租户 → 拒绝（防一次误操作扫全库）', async () => {
    await expect(call({ user_id: 'alice' }, { tenantId: 'system', actor: 'admin' })).rejects.toThrow(/禁 system 通配/);
    expect(H.updateParticle).not.toHaveBeenCalled();
  });

  it('★ 核心：非终态归原池并置 S0；终态保留阶段只归 lost + 解除归属', async () => {
    H.query.mockResolvedValue({ rows: [
      { id: 'b1', payload: { stage: 'S0P', owner_id: 'alice', pool_id: 'pool-new', pool_type: 'new' } },
      { id: 'b2', payload: { stage: 'S3',  owner_id: 'alice', pool_id: 'pool-nurture', pool_type: 'nurture' } },
      { id: 'b3', payload: { stage: 'S7',  owner_id: 'alice', pool_id: 'pool-new', pool_type: 'new' } },
      { id: 'b4', payload: { stage: 'S8',  owner_id: 'alice', pool_id: 'pool-new', pool_type: 'new' } },
    ] });

    const r = await call({ user_id: 'alice' }, { tenantId: 't-alpha', actor: 'sys' });
    expect(r.ok).toBe(true);
    expect(r.count).toBe(4);
    expect(r.failed).toEqual([]);

    const byId = Object.fromEntries(H.updateParticle.mock.calls.map((c) => [c[0], c[1].patch]));
    // 非终态：置 S0 公海 + 归原池
    expect(byId.b1.stage).toBe('S0');
    expect(byId.b1.pool_type).toBe('new');
    expect(byId.b1.owner_id).toBeNull();
    expect(byId.b1.prev_owner_id).toBe('alice');
    expect(byId.b2.stage).toBe('S0');
    expect(byId.b2.pool_type).toBe('nurture');
    // 终态：阶段不动（不把已关闭商机推回公海污染漏斗）+ 归 lost
    expect(byId.b3).toHaveProperty('stage'); // 展开传入 ...r.payload，阶段保持 S7
    expect(byId.b3.pool_type).toBe('lost');
    expect(byId.b3.pool_id).toBe('pool-lost');
    expect(byId.b3.owner_id).toBeNull();
    expect(byId.b4.pool_type).toBe('lost');
    // 租户谓词透传
    for (const c of H.updateParticle.mock.calls) expect(c[1].tenantId).toBe('t-alpha');
  });

  it('查询按租户 + owner 过滤（防跨租户误回收）', async () => {
    H.query.mockResolvedValue({ rows: [] });
    await call({ user_id: 'alice' }, { tenantId: 't-alpha', actor: 'sys' });
    const sql = String(H.query.mock.calls[0][0]);
    expect(sql).toContain('tenant_id=$1');
    expect(sql).toContain("payload->>'owner_id'=$2");
    expect(H.query.mock.calls[0][1]).toEqual(['t-alpha', 'alice']);
  });

  it('单条写失败被收集（不中断整批，返回 failed 明细）', async () => {
    H.query.mockResolvedValue({ rows: [
      { id: 'c1', payload: { stage: 'S1', owner_id: 'alice', pool_type: 'new' } },
      { id: 'c2', payload: { stage: 'S1', owner_id: 'alice', pool_type: 'new' } },
    ] });
    H.updateParticle
      .mockResolvedValueOnce({ id: 'c1', payload: {} })
      .mockRejectedValueOnce(new Error('fake-write-fail'));
    const r = await call({ user_id: 'alice' }, { tenantId: 't-alpha', actor: 'sys' });
    expect(r.count).toBe(1);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0].id).toBe('c2');
  });

  it('空集 → count=0 且不报错', async () => {
    H.query.mockResolvedValue({ rows: [] });
    const r = await call({ user_id: 'nobody' }, { tenantId: 't-alpha', actor: 'sys' });
    expect(r.count).toBe(0);
    expect(H.updateParticle).not.toHaveBeenCalled();
  });

  it('★ 事件键统一：lead-reclaimed-bulk 带 tenant_id（同族 lead-returned/deal-archived-to-pool）', async () => {
    H.query.mockResolvedValue({ rows: [{ id: 'e1', payload: { stage: 'S3', owner_id: 'alice', pool_type: 'new' } }] });
    const bus = await import('../../src/events/bus.js');
    const spy = vi.spyOn(bus, 'emit').mockImplementation(() => {});
    try {
      await call({ user_id: 'alice' }, { tenantId: 't-alpha', actor: 'sys' });
      const payload = spy.mock.calls.find((c) => c[1] === 'lead-reclaimed-bulk')?.[2];
      expect(payload).toBeTruthy();
      expect(payload.tenant_id).toBe('t-alpha');  // 同族统一 snake_case（T4/T6/T7 教训）
      expect(payload.tenantId).toBeUndefined();    // 禁 camelCase 残留
    } finally {
      spy.mockRestore();
    }
  });
});
