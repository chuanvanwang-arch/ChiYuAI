// test/sync/privacyWiring.test.js — P1 隐私排除清单的**接线**验证（不只是纯函数）
// 判据（设计 §10）：① 排除域名/关键词行 → 断言不入库且计数可见；② 变异「过滤写在入口之后」→ 必须变红
// 关键：这里断言的是**副作用未发生**（upsert 未被调用 / ingest 未被调用），而不是「计数好看」。
//   只断言计数 = 计数是自我报告的，一个把 rows 丢掉却不计数的实现也能通过。
import { describe, it, expect } from 'vitest';
import { createSyncEngine } from '../../src/sync/engine.js';
import { wrapProviderForIngest } from '../../src/channels/channelIngestWiring.js';
import { createPrivacyFilter } from '../../src/channels/privacyFilter.js';
import { loadPrivacyFilter, handleObjectChanged } from '../../src/sync/mount.js';

const RULES = { exclude_domains: ['secret.com'], exclude_keywords: ['验证码'], exclude_addresses: ['ceo@'] };

function mkEngine({ privacy, upserts }) {
  const calls = upserts || [];
  return createSyncEngine({
    provider: {
      kind: 'mock',
      verifyAuth: async () => ({ ok: true }),
      readIncremental: async () => ({
        rows: [
          { id: 'a1', email: 'bob@secret.com', subject: 'hello' },
          { id: 'a2', email: 'bob@ok.com', subject: 'hello' },
          { id: 'a3', email: 'bob@ok.com', subject: '验证码 1234' },
          { id: 'a4', email: 'ceo@ok.com', subject: 'hello' },
        ],
        cursor: 'c1',
      }),
    },
    mapping: { apply: (o, row) => ({ ok: true, particle_type: 'CRM_ACCOUNT', payload: { id: row.id } }) },
    resolver: { upsert: async (a) => { calls.push(a.externalId); return { created: true, particle_id: 'p-' + a.externalId }; } },
    cursor: { get: async () => null, set: async () => {} },
    trust: { level: async () => 'L2' },
    privacy,
  });
}

describe('P1 同步线接线：过滤必须发生在 upsert **之前**', () => {
  it('三类规则各自拦下对应行，其余照常落库', async () => {
    const calls = [];
    const engine = mkEngine({ privacy: createPrivacyFilter(RULES), upserts: calls });
    const r = await engine.runOnce({ object: 'AccountObj', tenantId: 't1' });
    expect(r.read).toBe(4);
    expect(r.privacy_dropped).toBe(3);
    expect(r.created).toBe(1);
    // 决定性断言：被排除的行**从未**到达 resolver（而非「落库后再隐藏」）
    expect(calls).toEqual(['a2']);
  });

  it('丢弃按原因分组可见（用户能解释「为什么少了」）', async () => {
    const engine = mkEngine({ privacy: createPrivacyFilter(RULES) });
    const r = await engine.runOnce({ object: 'AccountObj', tenantId: 't1' });
    expect(r.privacy_dropped_by_reason).toEqual({
      excluded_domain: 1, excluded_keyword: 1, excluded_address: 1,
    });
  });

  it('未注入 privacy → 零行为变化（既有调用方不被改变）', async () => {
    const calls = [];
    const engine = mkEngine({ privacy: null, upserts: calls });
    const r = await engine.runOnce({ object: 'AccountObj', tenantId: 't1' });
    expect(r.created).toBe(4);
    expect(r.privacy_dropped).toBe(0);
    expect(calls).toEqual(['a1', 'a2', 'a3', 'a4']);
  });

  it('空规则集 → 短路，不产生逐行判定开销也不丢弃任何行', async () => {
    const engine = mkEngine({ privacy: createPrivacyFilter({}) });
    const r = await engine.runOnce({ object: 'AccountObj', tenantId: 't1' });
    expect(r.created).toBe(4);
    expect(r.privacy_dropped).toBe(0);
  });

  it('配置形状坏掉 → 留痕（privacy_config_ok=false），且**不**因此丢弃全部（不制造数据消失的假红）', async () => {
    const engine = mkEngine({ privacy: createPrivacyFilter({ exclude_keywords: 'oops' }) });
    const r = await engine.runOnce({ object: 'AccountObj', tenantId: 't1' });
    expect(r.privacy_config_ok).toBe(false);
    expect(r.created).toBe(4);   // 不回退成「全丢」
    expect(r.privacy_dropped).toBe(0);
  });

  it('L1 只读不落库 → 不参与过滤（零回归：L1 计数语义不变）', async () => {
    const engine = createSyncEngine({
      provider: { kind: 'mock', verifyAuth: async () => ({ ok: true }), readIncremental: async () => ({ rows: [{ id: 'x', email: 'b@secret.com' }], cursor: null }) },
      mapping: { apply: () => ({ ok: true, particle_type: 'CRM_ACCOUNT', payload: {} }) },
      resolver: { upsert: async () => ({ created: true }) },
      cursor: { get: async () => null, set: async () => {} },
      trust: { level: async () => 'L1' },
      privacy: createPrivacyFilter(RULES),
    });
    const r = await engine.runOnce({ object: 'O', tenantId: 't1' });
    expect(r.readOnly).toBe(true);
    expect(r.privacy_dropped).toBe(0);
  });
});

describe('P1 通道线接线：汇入前排除，ingest 不得被调用', () => {
  const mkProvider = () => ({
    kind: 'generic-email',
    readIncremental: async () => ({
      rows: [
        { channel: 'email', from: 'bob@secret.com', to: 'me@ok.com', subject: 'hi', external_id: 'm1' },
        { channel: 'email', from: 'bob@ok.com', to: 'me@ok.com', subject: 'hi', external_id: 'm2' },
      ],
      cursor: 'c1',
    }),
  });

  it('被排除行不进图谱汇入（ingest 调用次数 = 1），且 trace 计数可见', async () => {
    const ingested = [];
    const traces = [];
    const wrapped = wrapProviderForIngest({
      provider: mkProvider(), kind: 'generic-email', tenantId: 't1', trustLevel: 'L2',
      emit: (lvl, name, meta) => traces.push({ name, meta }),
      privacy: createPrivacyFilter(RULES),
      deps: {
        findAccountByDomain: async () => ({ particle_id: 'acc-1' }),
        appendEnrichment: async (a) => { ingested.push(a); return { ok: true }; },
        addWeakEdge: async () => ({ ok: true }),
      },
    });
    await wrapped.readIncremental({});
    expect(ingested.length).toBe(1);
    const done = traces.find((t) => t.name === 'channel-ingest-done');
    expect(done.meta.privacy_dropped).toBe(1);
    expect(done.meta.privacy_dropped_by_reason).toEqual({ excluded_domain: 1 });
  });

  it('未注入 privacy → 两行都汇入（零行为变化）', async () => {
    const ingested = [];
    const wrapped = wrapProviderForIngest({
      provider: mkProvider(), kind: 'generic-email', tenantId: 't1', trustLevel: 'L2', emit: () => {},
      deps: {
        findAccountByDomain: async () => ({ particle_id: 'acc-1' }),
        appendEnrichment: async (a) => { ingested.push(a); return { ok: true }; },
        addWeakEdge: async () => ({ ok: true }),
      },
    });
    await wrapped.readIncremental({});
    expect(ingested.length).toBe(2);
  });
});

describe('P1 装配层：两线共用同一份规则（同一隐私承诺不得两个答案）', () => {
  it('loadPrivacyFilter 从 config_store 读 sync-privacy；读失败 → 空规则 + config_ok=false（不抛）', async () => {
    const ok = await loadPrivacyFilter({ tenantId: 't1', readConfig: async () => ({ value: RULES }) });
    expect(ok.rules.exclude_domains).toEqual(['secret.com']);
    const bad = await loadPrivacyFilter({ tenantId: 't1', readConfig: async () => { throw new Error('db down'); } });
    expect(bad.isEmpty).toBe(true);
    expect(bad.config_ok).toBe(false);
  });

  it('webhook 入口（第二条路径）同样过滤——只在定时器路径过滤等于留下一个旁路', async () => {
    const upserts = [];
    const r = await handleObjectChanged({
      tenantId: 't1', provider: 'p1', object: 'AccountObj', row: { id: 'x1', email: 'a@secret.com' },
      deps: {
        // 按 key 区分：sync-trust 给信任档，sync-privacy 给排除规则（同一 readConfig 两个键）
        readConfig: async (key) => (key === 'sync-privacy' ? { value: { exclude_domains: ['secret.com'] } } : { value: { default_level: 'L2' } }),
        mappings: { AccountObj: { particle_type: 'CRM_ACCOUNT', fields: [{ ext: 'email', particle: 'email' }] } },
        createResolver: () => ({ upsert: async (a) => { upserts.push(a); return { created: true, particle_id: 'p' }; } }),
        pool: null,
        mintDecision: async () => ({ decisionId: 'd1' }),
        emit: () => {},
      },
    });
    expect(r.privacy_dropped).toBe(true);
    expect(r.reason).toBe('excluded_domain');
    expect(upserts.length).toBe(0); // 决定性：未落库
  });
});
