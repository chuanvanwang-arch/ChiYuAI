// test/channels/channelIngestWiring.test.js
// T7 Step 5 接线守卫（防「模块做了却没接线」零接线假绿）。判据：
//   源码级：① mount.loadTenantSyncTargets 真实消费 channelIngest 钩子；② timers ⑩ 真实把钩子传进 loadSyncTargets；
//   行为级：③ 钩子包装后通道 provider 的 readIncremental 逐行汇入既有账户；
//          ④ 非通道 kind **不被包装**（原样返回，零行为变化）；
//          ⑤ 行级异常不阻断内核读入链路（仍返回 inc）且留痕。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { wrapProviderForIngest, CHANNEL_KINDS } from '../../src/channels/channelIngestWiring.js';
import { loadTenantSyncTargets } from '../../src/sync/mount.js';

const mountSrc = readFileSync(new URL('../../src/sync/mount.js', import.meta.url), 'utf8');
const timersSrc = readFileSync(new URL('../../src/scheduler/timers.js', import.meta.url), 'utf8');

describe('T7 接线守卫（源码级：钩子被真实消费）', () => {
  it('mount.loadTenantSyncTargets 消费 channelIngest 钩子（非仅定义）', () => {
    expect(mountSrc).toContain('channelIngest');
    expect(mountSrc).toMatch(/channelIngest\(\s*\{/); // 真实调用，非形参占位
  });
  it('timers ⑩ 把 channelIngest 传入 loadSyncTargets', () => {
    expect(timersSrc).toContain('channelIngestWiring.js');
    expect(timersSrc).toMatch(/channelIngest,\s*\/\/\s*需求②/);
  });
});

describe('wrapProviderForIngest（行为级）', () => {
  const mkProvider = (rows) => ({ kind: 'generic-email', readIncremental: async () => ({ ok: true, rows, cursor: 'c1' }) });

  it('非通道 kind → 原样返回（零行为变化）', () => {
    const p = mkProvider([]);
    expect(wrapProviderForIngest({ provider: p, kind: 'generic-rest' })).toBe(p);
    expect(CHANNEL_KINDS.has('generic-rest')).toBe(false);
  });

  it('通道 kind → readIncremental 逐行汇入既有账户（L2 才写），并 emit channel-ingest-done', () => {
    const calls = [];
    const traces = [];
    const deps = {
      findAccountByDomain: async () => ({ particle_id: 'p-acc-1', enrichment: {} }),
      appendEnrichment: async (a) => { calls.push(a); return { ok: true }; },
      addWeakEdge: async () => ({ ok: true }),
    };
    const p = mkProvider([{ channel: 'email', from: 'me@mycorp.com', to: 'buyer@acme.com', external_id: 'm1' }]);
    const wrapped = wrapProviderForIngest({ provider: p, kind: 'generic-email', tenantId: 't1', trustLevel: 'L2', deps, emit: (l, n, m) => traces.push({ n, m }) });
    return wrapped.readIncremental({}).then((inc) => {
      expect(inc.ok).toBe(true);
      expect(calls.length).toBe(1);
      expect(calls[0].channel).toBe('email');
      expect(calls[0].payload.email_intent[0].external_id).toBe('m1');
      const done = traces.find((t) => t.n === 'channel-ingest-done');
      expect(done).toBeTruthy();
      expect(done.m.ingested).toBe(1);
      // 落点键可观测（防「写进了错的键」这类静默错配）
      expect(done.m.enrichment_keys).toEqual(['email_intent']);
    });
  });

  it('落点键按**行内 channel**（非 provider kind）判定：日历行落 schedule', () => {
    const calls = [];
    const traces = [];
    const deps = {
      findAccountByDomain: async () => ({ particle_id: 'p-acc-1', enrichment: {} }),
      appendEnrichment: async (a) => { calls.push(a); return { ok: true }; },
      addWeakEdge: async () => ({ ok: true }),
    };
    // 注：日历行须带参与方邮箱才可判定 domain（无归属 → fail-safe 不写，属正确行为）
    const p = mkProvider([{ channel: 'calendar', dtstart: '2026-09-18T10:00:00Z', summary: '现场拜访', participants: [{ email: 'buyer@acme.com' }], external_id: 'evt-1' }]);
    const wrapped = wrapProviderForIngest({ provider: p, kind: 'generic-calendar', tenantId: 't1', trustLevel: 'L2', deps, emit: (l, n, m) => traces.push({ n, m }) });
    return wrapped.readIncremental({}).then(() => {
      expect(calls.length).toBe(1);
      expect(calls[0].payload.schedule).toBeTruthy();
      expect(calls[0].payload.email_intent).toBeUndefined(); // 不得落邮件键
      expect(calls[0].payload.schedule[0].subject).toBe('现场拜访');
      expect(traces.find((t) => t.n === 'channel-ingest-done').m.enrichment_keys).toEqual(['schedule']);
    });
  });

  it('L1 → 不写（只读），但读入链路照常返回', () => {
    const calls = [];
    const deps = {
      findAccountByDomain: async () => ({ particle_id: 'p-acc-1', enrichment: {} }),
      appendEnrichment: async (a) => { calls.push(a); return { ok: true }; },
      addWeakEdge: async () => ({ ok: true }),
    };
    const p = mkProvider([{ channel: 'email', from: 'me@mycorp.com', to: 'buyer@acme.com', external_id: 'm1' }]);
    const wrapped = wrapProviderForIngest({ provider: p, kind: 'generic-email', tenantId: 't1', trustLevel: 'L1', deps, emit: () => {} });
    return wrapped.readIncremental({}).then((inc) => {
      expect(inc.rows.length).toBe(1);
      expect(calls.length).toBe(0);
    });
  });

  it('行级异常不阻断读入（仍返回 inc）且留痕 channel-ingest-row-failed', () => {
    const traces = [];
    const deps = {
      findAccountByDomain: async () => { throw new Error('boom'); },
      appendEnrichment: async () => ({ ok: true }),
      addWeakEdge: async () => ({ ok: true }),
    };
    const p = mkProvider([{ channel: 'email', from: 'me@mycorp.com', to: 'buyer@acme.com' }]);
    const wrapped = wrapProviderForIngest({ provider: p, kind: 'generic-wechat', tenantId: 't1', trustLevel: 'L3', deps, emit: (l, n, m) => traces.push({ n, m }) });
    return wrapped.readIncremental({}).then((inc) => {
      expect(inc.ok).toBe(true); // 读入未被阻断
      expect(inc.rows.length).toBe(1);
      // findAccountByDomain 抛错 → ingest 内部 catch 成 null → account_not_found（不写、不崩）
      expect(traces.some((t) => t.n === 'channel-ingest-done')).toBe(true);
    });
  });
});

describe('mount.loadTenantSyncTargets 经钩子包装通道 provider（端到端）', () => {
  it('通道 kind 描述符 → provider 被包装，读入即汇入', async () => {
    const calls = [];
    const descriptors = [{ id: 'ch-1', kind: 'generic-email', enabled: true, trust_level: 'L2', objects: [{ name: 'email', direction: 'in' }] }];
    const readConfig = async (key) => (key === 'integration-providers' ? { value: descriptors } : { value: { default_level: 'L2' } });
    const factories = { 'generic-email': () => ({ kind: 'generic-email', readIncremental: async () => ({ ok: true, rows: [{ channel: 'email', from: 'me@mycorp.com', to: 'buyer@acme.com', external_id: 'm1' }], cursor: 'c' }) }) };
    const deps = {
      findAccountByDomain: async () => ({ particle_id: 'p-acc-1', enrichment: {} }),
      appendEnrichment: async (a) => { calls.push(a); return { ok: true }; },
      addWeakEdge: async () => ({ ok: true }),
    };
    const channelIngest = (a) => wrapProviderForIngest({ ...a, deps });
    const targets = await loadTenantSyncTargets({ tenantId: 't1', readConfig, factories, channelIngest, emit: () => {} });
    expect(targets.length).toBe(1);
    expect(targets[0].kind).toBe('generic-email');
    const inc = await targets[0].provider.readIncremental({});
    expect(inc.ok).toBe(true);
    expect(calls.length).toBe(1); // 单一读入即汇入
  });

  it('非通道 kind 描述符 → provider 未被包装（同一 provider 引用）', async () => {
    const p = { kind: 'generic-rest', readIncremental: async () => ({ ok: true, rows: [], cursor: null }) };
    const descriptors = [{ id: 'g-1', kind: 'generic-rest', enabled: true, trust_level: 'L2', objects: [{ name: 'x', direction: 'in' }] }];
    const readConfig = async (key) => (key === 'integration-providers' ? { value: descriptors } : { value: { default_level: 'L2' } });
    const factories = { 'generic-rest': () => p };
    const channelIngest = (a) => wrapProviderForIngest({ ...a, deps: {} });
    const targets = await loadTenantSyncTargets({ tenantId: 't1', readConfig, factories, channelIngest, emit: () => {} });
    expect(targets[0].provider).toBe(p); // 原样（未被包装）
  });
});
