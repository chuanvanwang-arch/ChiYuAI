// test/sync/mount.test.js — 线A 挂载层（descriptor → 同步目标 → 内核）
// 契约：① 有效信任档 min(descriptor, global)（无自动提权）；② L1 零写入；③ L2 每 run 一枚决策并透传；
//       ④ 单目标失败 emit trace + recordFailure 不静默、不传染；⑤ 无 objects[] → no-op（零回归）
// 计划：docs/superpowers/plans/2026-09-16-line-a-mount-points.md
import { describe, it, expect, vi } from 'vitest';
import {
  effectiveTrustLevel, normalizeSyncMappings, loadSyncMappings,
  loadTenantSyncTargets, runTenantSyncOnce, handleObjectChanged,
} from '../../src/sync/mount.js';

const designShape = {
  version: 1,
  mappings: [{
    object: 'AccountObj', particle_type: 'CRM_ACCOUNT', direction: 'in',
    identity: { external_id_field: '_id', since_field: 'last_modified_time' },
    fields: [{ external: 'name', particle: 'name', type: 'string' }],
  }, {
    object: 'OutObj', particle_type: 'CRM_ACCOUNT', direction: 'out',
    fields: [{ external: 'ai_fit_score', particle: 'fit_score' }],
  }],
};

describe('effectiveTrustLevel（有效信任档 = min）', () => {
  it('descriptor L3 + global L1 → L1（无自动提权）', () => {
    expect(effectiveTrustLevel('L3', 'L1')).toBe('L1');
  });
  it('descriptor L2 + global L3 → L2（取更严者）', () => {
    expect(effectiveTrustLevel('L2', 'L3')).toBe('L2');
  });
  it('descriptor 缺省 → 取 global；global 缺省 → 最严 L1', () => {
    expect(effectiveTrustLevel(null, 'L2')).toBe('L2');
    expect(effectiveTrustLevel(undefined, undefined)).toBe('L1');
    expect(effectiveTrustLevel('L9', 'L3')).toBe('L3'); // 非法档位不采信
  });
});

describe('normalizeSyncMappings（设计形状 §9.1 ↔ 实现形状兼容）', () => {
  it('设计形状（mappings[] + fields[].external）→ mapping.js 可用形状（fields[].ext）', () => {
    const m = normalizeSyncMappings(designShape);
    expect(m.AccountObj.particle_type).toBe('CRM_ACCOUNT');
    expect(m.AccountObj.fields[0]).toEqual({ ext: 'name', particle: 'name', type: 'string' });
    expect(m.OutObj).toBeUndefined(); // 出向映射不进读入表
  });
  it('实现形状（对象字典 + fields[].ext）原样通过（零回归）', () => {
    const impl = { AccountObj: { particle_type: 'CRM_ACCOUNT', fields: [{ ext: 'name', particle: 'name' }] } };
    expect(normalizeSyncMappings(impl).AccountObj.fields[0].ext).toBe('name');
  });
  it('空/非法输入 → 空对象（fail-closed，不抛）', () => {
    expect(normalizeSyncMappings(null)).toEqual({});
    expect(normalizeSyncMappings({ version: 1 })).toEqual({});
  });
  it('loadSyncMappings 读配置失败 → 空对象（不抛）', async () => {
    const m = await loadSyncMappings({ tenantId: 't1', readConfig: async () => { throw new Error('db down'); } });
    expect(m).toEqual({});
  });
});

describe('loadTenantSyncTargets（descriptor → 同步目标）', () => {
  const readConfig = async (key) => {
    if (key === 'integration-providers') {
      return {
        value: [
          {
            id: 'fx-1', kind: 'fxiaoke', enabled: true, trust_level: 'L3',
            objects: [{ name: 'AccountObj', direction: 'in', cadence_min: 30, mapping_ref: 'AccountObj' }],
          },
          { id: 'off', kind: 'fxiaoke', enabled: false, objects: [{ name: 'X', direction: 'in' }] },
          { id: 'no-obj', kind: 'generic-rest', enabled: true, endpoint: 'https://e.com' },
          { id: 'bad-kind', kind: 'unknown-xyz', enabled: true, objects: [{ name: 'X', direction: 'in' }] },
          { id: 'out-only', kind: 'generic-rest', enabled: true, endpoint: 'https://e.com', objects: [{ name: 'Y', direction: 'out' }] },
        ],
      };
    }
    if (key === 'sync-trust') return { value: { default_level: 'L1' } };
    return null;
  };
  const factories = { fxiaoke: () => ({ kind: 'fxiaoke' }), 'generic-rest': () => ({ kind: 'generic-rest' }) };

  it('仅 enabled + 有入向 objects + kind 受支持者成为目标', async () => {
    const t = await loadTenantSyncTargets({ tenantId: 't1', readConfig, resolveCredentials: async () => ({}), factories });
    expect(t.map((x) => x.id)).toEqual(['fx-1']);
    expect(t[0].objects).toHaveLength(1);
  });

  it('有效信任档取 min：descriptor L3 + global L1 → L1', async () => {
    const t = await loadTenantSyncTargets({ tenantId: 't1', readConfig, resolveCredentials: async () => ({}), factories });
    expect(t[0].trustLevel).toBe('L1');
    expect(t[0].descriptorLevel).toBe('L3'); // 声明值留痕，便于观测钳制
  });

  it('descriptor L2 + global L3 → L2', async () => {
    const rc = async (k) => (k === 'integration-providers'
      ? { value: [{ id: 'a', kind: 'fxiaoke', enabled: true, trust_level: 'L2', objects: [{ name: 'O', direction: 'in' }] }] }
      : { value: { default_level: 'L3' } });
    const t = await loadTenantSyncTargets({ tenantId: 't1', readConfig: rc, resolveCredentials: async () => ({}), factories });
    expect(t[0].trustLevel).toBe('L2');
  });

  it('凭据解密结果注入 provider（按 descriptor id 取值）', async () => {
    const seen = [];
    const f = { fxiaoke: (cfg) => { seen.push(cfg); return { kind: 'fxiaoke' }; } };
    await loadTenantSyncTargets({
      tenantId: 't1', readConfig, factories: f,
      resolveCredentials: async () => ({ 'fx-1': { appId: 'a', appSecret: 's', permanentCode: 'p' } }),
    });
    expect(seen[0].credentials).toEqual({ appId: 'a', appSecret: 's', permanentCode: 'p' });
  });

  it('读配置失败 → 空数组（fail-closed，定时器不炸）', async () => {
    const t = await loadTenantSyncTargets({
      tenantId: 't1', factories: {}, resolveCredentials: async () => ({}),
      readConfig: async () => { throw new Error('db down'); },
    });
    expect(t).toEqual([]);
  });
});

describe('runTenantSyncOnce（L1 只读 / L2 决策 / 失败不静默）', () => {
  const mkDeps = (over = {}) => ({
    createEngine: vi.fn(() => ({ runOnce: vi.fn(async () => ({ ok: true, read: 2, created: 2, readOnly: false })) })),
    pool: {}, mappings: {},
    mintDecision: vi.fn(async () => ({ decisionId: 'dec-1' })),
    emit: vi.fn(), recordFailure: vi.fn(),
    ...over,
  });
  const target = (over = {}) => ({
    id: 'a', kind: 'fxiaoke', provider: {}, objects: [{ name: 'O', direction: 'in' }], trustLevel: 'L1', ...over,
  });

  it('L1：跑一轮且不 mint 决策，emit sync-run-done 带信任档', async () => {
    const deps = mkDeps();
    const out = await runTenantSyncOnce({ tenantId: 't1', targets: [target()], deps });
    expect(out.runs).toBe(1);
    expect(out.created).toBe(2);
    expect(deps.mintDecision).not.toHaveBeenCalled();
    expect(deps.emit).toHaveBeenCalledWith('trace', 'sync-run-done', expect.objectContaining({ tenant_id: 't1', object: 'O', trust_level: 'L1' }));
  });

  it('L2：每 run mint 一枚决策并透传 decisionId（第 0 闸）', async () => {
    const runOnce = vi.fn(async () => ({ ok: true, created: 1 }));
    const deps = mkDeps({ createEngine: vi.fn(() => ({ runOnce })) });
    await runTenantSyncOnce({ tenantId: 't1', targets: [target({ trustLevel: 'L2' })], deps });
    expect(deps.mintDecision).toHaveBeenCalledTimes(1);
    expect(runOnce).toHaveBeenCalledWith(expect.objectContaining({ object: 'O', tenantId: 't1', decisionId: 'dec-1' }));
  });

  it('L2/L3 铸不出决策 → 拒绝本轮（写无决策不落库，fail-closed）', async () => {
    const runOnce = vi.fn();
    const deps = mkDeps({ createEngine: vi.fn(() => ({ runOnce })), mintDecision: vi.fn(async () => ({ decisionId: null })) });
    const out = await runTenantSyncOnce({ tenantId: 't1', targets: [target({ trustLevel: 'L2' })], deps });
    expect(runOnce).not.toHaveBeenCalled();
    expect(out.errors).toBe(1);
    expect(deps.recordFailure).toHaveBeenCalledWith('sync-run-failed', expect.any(Error));
  });

  it('信任档以定值注入内核（level() 返回 min 结果，不查库提权）', async () => {    const createEngine = vi.fn(() => ({ runOnce: async () => ({ ok: true }) }));
    await runTenantSyncOnce({ tenantId: 't1', targets: [target({ trustLevel: 'L1' })], deps: mkDeps({ createEngine }) });
    const trust = createEngine.mock.calls[0][0].trust;
    expect(await trust.level('any')).toBe('L1');
    expect(await trust.canWriteBack('any')).toBe(false);
  });

  it('单 target 抛错 → emit trace + recordFailure，其余 target 继续（不静默、不传染）', async () => {
    const deps = mkDeps({
      createEngine: vi.fn()
        .mockImplementationOnce(() => ({ runOnce: async () => { throw new Error('boom'); } }))
        .mockImplementationOnce(() => ({ runOnce: async () => ({ ok: true }) })),
    });
    const out = await runTenantSyncOnce({
      tenantId: 't1',
      targets: [target({ id: 'bad', objects: [{ name: 'O1', direction: 'in' }] }), target({ id: 'good', objects: [{ name: 'O2', direction: 'in' }] })],
      deps,
    });
    expect(deps.recordFailure).toHaveBeenCalledWith('sync-run-failed', expect.any(Error));
    expect(deps.emit).toHaveBeenCalledWith('trace', 'sync-run-failed', expect.objectContaining({ provider: 'bad', object: 'O1' }));
    expect(out.runs).toBe(2);
    expect(out.errors).toBe(1);
  });

  it('出向 object 不触发拉取（direction=out 走回写通道，非本函数）', async () => {
    const out = await runTenantSyncOnce({ tenantId: 't1', targets: [target({ objects: [{ name: 'O', direction: 'out' }] })], deps: mkDeps() });
    expect(out.runs).toBe(0);
  });

  it('零目标 → 全零结果（no-op，既有租户零行为变化）', async () => {
    const out = await runTenantSyncOnce({ tenantId: 't1', targets: [], deps: mkDeps() });
    // privacy_dropped（P1 §8.1）同为零：零目标时隐私过滤不可能拦下任何行
    expect(out).toEqual({ runs: 0, errors: 0, created: 0, updated: 0, skipped: 0, conflicted: 0, writeback: 0, privacy_dropped: 0 });
  });
});

describe('handleObjectChanged（A-B5 单记录事件路由）', () => {
  const mappings = { AccountObj: { particle_type: 'CRM_ACCOUNT', fields: [{ ext: 'name', particle: 'name' }] } };

  it('L2：按 event.object 路由到内核 upsert（不经富化瀑布）', async () => {
    const upsert = vi.fn(async () => ({ created: true, particle_id: 'p1' }));
    const r = await handleObjectChanged({
      tenantId: 't1', provider: 'fxiaoke', object: 'AccountObj', row: { id: 'a1', name: '客户A' },
      deps: { mappings, createResolver: () => ({ upsert }), mintDecision: async () => ({ decisionId: 'dec-a5' }),
        readConfig: async () => ({ value: { default_level: 'L2' } }) },
    });
    expect(r.ok).toBe(true);
    expect(r.created).toBe(true);
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      externalId: 'a1', particleType: 'CRM_ACCOUNT', object: 'AccountObj', payload: { name: '客户A' },
    }));
  });

  it('未声明映射的 object → fail-closed 拒绝（不越权建粒子）', async () => {
    const r = await handleObjectChanged({
      tenantId: 't1', provider: 'fxiaoke', object: 'UnknownObj', row: { id: 'x' },
      deps: { mappings: {}, readConfig: async () => ({ value: { default_level: 'L2' } }) },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('object_not_mapped');
  });

  it('缺外部 id → 拒绝（幂等前提缺失不可静默）', async () => {
    const r = await handleObjectChanged({
      tenantId: 't1', provider: 'fxiaoke', object: 'AccountObj', row: { name: '无 id' },
      deps: { mappings, readConfig: async () => ({ value: { default_level: 'L2' } }) },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('external_id_missing');
  });

  it('默认 L1（只读）→ 事件不写库（与轮询同口径）', async () => {
    const upsert = vi.fn();
    const r = await handleObjectChanged({
      tenantId: 't1', provider: 'fxiaoke', object: 'AccountObj', row: { id: 'a1' },
      deps: { mappings, createResolver: () => ({ upsert }), readConfig: async () => ({ value: { default_level: 'L1' } }) },
    });
    expect(r.ok).toBe(true);
    expect(r.readOnly).toBe(true);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('未知对象字段不进入 payload（未知字段拒绝）', async () => {
    const upsert = vi.fn(async () => ({ created: true }));
    await handleObjectChanged({
      tenantId: 't1', provider: 'fxiaoke', object: 'AccountObj', row: { id: 'a1', name: 'A', secret_field: 'X' },
      deps: { mappings, createResolver: () => ({ upsert }), mintDecision: async () => ({ decisionId: 'dec-a5' }),
        readConfig: async () => ({ value: { default_level: 'L2' } }) },
    });
    expect(upsert.mock.calls[0][0].payload).toEqual({ name: 'A' });
  });

  it('L2 铸不出决策 → 拒绝写库（第 0 闸 fail-closed，与轮询同口径）', async () => {
    const upsert = vi.fn();
    const r = await handleObjectChanged({
      tenantId: 't1', provider: 'fxiaoke', object: 'AccountObj', row: { id: 'a1', name: '客户A' },
      deps: { mappings, createResolver: () => ({ upsert }), mintDecision: async () => ({ decisionId: null }),
        readConfig: async () => ({ value: { default_level: 'L2' } }) },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^decision_required/);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('缺 mintDecision 注入 + L2 → 同样拒写（漏注入视同铸不出，不得静默放开写权）', async () => {
    const upsert = vi.fn();
    const r = await handleObjectChanged({
      tenantId: 't1', provider: 'fxiaoke', object: 'AccountObj', row: { id: 'a1', name: '客户A' },
      deps: { mappings, createResolver: () => ({ upsert }), readConfig: async () => ({ value: { default_level: 'L2' } }) },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^decision_required/);
    expect(upsert).not.toHaveBeenCalled();
  });
});

// ─── A-B1（2026-09-16）：描述符单一事实源接线——objects[]/token_mode/trust_level ───
// 设计 §6.1 A-B1 + §9.3；归一化实现见 src/connectors/discovery/providerDescriptor.js
// 红线：非法方向/非法 trust_level 不得被"猜"成合法值；issues 必须留痕（不静默）
describe('A-B1 · loadTenantSyncTargets 走统一描述符归一化', () => {
  const mkRead = (value) => async (key) => (key === 'integration-providers' ? { value } : { value: { default_level: 'L2' } });

  it('合法入向对象进入目标；出向与未知方向被剔除并 emit issues', async () => {
    const issues = [];
    const seen = [];
    const targets = await loadTenantSyncTargets({
      tenantId: 't1',
      readConfig: mkRead([
        { id: 'fx', kind: 'fxiaoke', enabled: true, token_mode: 'corp-access-token', trust_level: 'L2',
          objects: [{ name: 'AccountObj' }, { name: 'BadObj', direction: 'up' }, { name: 'OutObj', direction: 'out' }] },
      ]),
      factories: { fxiaoke: (cfg) => { seen.push(cfg); return { kind: 'fxiaoke' }; } },
      emit: (lvl, name, p) => issues.push({ name, p }),
    });
    expect(targets).toHaveLength(1);
    expect(targets[0].objects.map((o) => o.name)).toEqual(['AccountObj']);
    expect(targets[0].trustLevel).toBe('L2');
    expect(issues.some((x) => x.name === 'integration-providers-invalid' && x.p.issues.some((s) => s.includes('unknown_direction:up')))).toBe(true);
    // token_mode 与**完整归一化 objects**（含出向：回写侧需要；仅非法项被剔除）一并交给工厂
    expect(seen[0].token_mode).toBe('corp-access-token');
    expect(seen[0].objects.map((o) => `${o.name}:${o.direction}`)).toEqual(['AccountObj:in', 'OutObj:out']);
  });

  it('非法 trust_level → 回落 global（取最严），不静默当合法', async () => {
    const issues = [];
    const targets = await loadTenantSyncTargets({
      tenantId: 't1',
      readConfig: mkRead([
        { id: 'fx', kind: 'fxiaoke', enabled: true, trust_level: 'L9', objects: [{ name: 'AccountObj' }] },
      ]),
      factories: { fxiaoke: () => ({ kind: 'fxiaoke' }) },
      emit: (lvl, name, p) => issues.push({ name, p }),
    });
    expect(targets[0].descriptorLevel).toBeNull();          // 非法值不得被当成声明值留痕
    expect(targets[0].trustLevel).toBe('L2');               // 回落 global
    expect(issues.some((x) => x.p.issues.some((s) => s.includes('unknown_trust_level:L9')))).toBe(true);
  });

  it('缺 id/kind 的描述符整条拒绝（不实例化、不进目标）', async () => {
    const targets = await loadTenantSyncTargets({
      tenantId: 't1',
      readConfig: mkRead([{ kind: 'fxiaoke', enabled: true, objects: [{ name: 'A' }] }]),
      factories: { fxiaoke: () => ({ kind: 'fxiaoke' }) },
      emit: () => {},
    });
    expect(targets).toHaveLength(0);
  });
});
