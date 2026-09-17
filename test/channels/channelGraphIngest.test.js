// test/channels/channelGraphIngest.test.js
// 需求② §5 图谱汇入接线（T7）。判据（红线）：
//   ① 只命中**既有** CRM_ACCOUNT（by domain）才写——无归属/未命中 → written=false（不入新图、不建新账户）；
//   ② L1 只读观察期不写；L2/L3 才追加 enrichment.email_intent[] + sourcedFrom 弱边（对齐 trust 语义）；
//   ③ 追加**幂等**（external_id 去重）——同一事件行重复汇入不产生重复条目；
//   ④ 写入失败 → ok:false 且不静默（emit trace）；
//   ⑤ 零内核：不新建粒子类型/不新建图（本层只追加既有账户 payload + 弱边）。
import { describe, it, expect } from 'vitest';
import { ingestChannelEvent } from '../../src/channels/channelGraphIngest.js';

describe('channelGraphIngest', () => {
  it('L1 且命中账户 → 只读，不写（written=false，reason=read_only_l1）', async () => {
    const deps = {
      findAccountByDomain: async () => ({ particle_id: 'p-acc-1' }),
      appendEnrichment: async () => ({ ok: true }),
      trustLevel: async () => 'L1',
    };
    const ev = { channel: 'email', domain: 'acme.com', kind: 'contact_change', external_id: 'm1', ts: '2026-09-17T08:00:00Z', content: { subject: '报价' } };
    const r = await ingestChannelEvent(ev, deps);
    expect(r.ok).toBe(true);
    expect(r.written).toBe(false);
    expect(r.reason).toBe('read_only_l1');
  });

  it('L2 且命中账户 → enrichment 追加（channel=email）+ sourcedFrom 弱边', async () => {
    const calls = [];
    const deps = {
      findAccountByDomain: async () => ({ particle_id: 'p-acc-1', enrichment: {} }),
      appendEnrichment: async (a) => { calls.push({ callsite: 'enrich', ...a }); return { ok: true }; },
      addWeakEdge: async (a) => { calls.push({ callsite: 'edge', ...a }); return { ok: true }; },
      trustLevel: async () => 'L2',
    };
    const ev = { channel: 'email', domain: 'acme.com', kind: 'contact_change', external_id: 'm1' };
    const r = await ingestChannelEvent(ev, deps);
    expect(r.ok).toBe(true);
    expect(r.written).toBe(true);
    const enrich = calls.find((c) => c.callsite === 'enrich');
    expect(enrich.channel).toBe('email');
    expect(enrich.payload.email_intent.length).toBeGreaterThan(0);
    expect(enrich.payload.email_intent[0].external_id).toBe('m1');
    const edge = calls.find((c) => c.callsite === 'edge');
    expect(edge.from).toBe('p-acc-1');
    expect(edge.kind).toBe('sourcedFrom');
  });

  it('无企业归属（no_domain）→ 不写、不查询账户', async () => {
    let queried = false;
    const deps = {
      findAccountByDomain: async () => { queried = true; return { particle_id: 'x' }; },
      appendEnrichment: async () => ({ ok: true }),
      trustLevel: async () => 'L3',
    };
    const r = await ingestChannelEvent({ channel: 'email', kind: 'contact_change' }, deps);
    expect(r.written).toBe(false);
    expect(r.reason).toBe('no_domain');
    expect(queried).toBe(false);
  });

  it('未命中既有账户（account_not_found）→ 不入新图', async () => {
    const deps = {
      findAccountByDomain: async () => null,
      appendEnrichment: async () => ({ ok: true }),
      trustLevel: async () => 'L3',
    };
    const r = await ingestChannelEvent({ channel: 'email', domain: 'nobody.com' }, deps);
    expect(r.written).toBe(false);
    expect(r.reason).toBe('account_not_found');
  });

  it('幂等：同一 external_id 重复汇入 → 第二次 written=false（duplicate），不重复追加', async () => {
    let enrichCalls = 0;
    const deps = {
      findAccountByDomain: async () => ({ particle_id: 'p-acc-1', enrichment: { email_intent: [{ external_id: 'm1' }] } }),
      appendEnrichment: async () => { enrichCalls++; return { ok: true }; },
      addWeakEdge: async () => ({ ok: true }),
      trustLevel: async () => 'L2',
    };
    const r = await ingestChannelEvent({ channel: 'email', domain: 'acme.com', external_id: 'm1' }, deps);
    expect(r.written).toBe(false);
    expect(r.reason).toBe('duplicate');
    expect(enrichCalls).toBe(0);
  });

  it('写入失败 → ok:false + emit trace（不静默）', async () => {
    const traces = [];
    const deps = {
      findAccountByDomain: async () => ({ particle_id: 'p-acc-1', enrichment: {} }),
      appendEnrichment: async () => ({ ok: false, error: 'db_down' }),
      trustLevel: async () => 'L3',
      emit: (lvl, name, meta) => traces.push({ lvl, name, meta }),
    };
    const r = await ingestChannelEvent({ channel: 'email', domain: 'acme.com', external_id: 'm9' }, deps);
    expect(r.ok).toBe(false);
    expect(r.written).toBe(false);
    expect(traces.some((t) => t.name === 'channel-ingest-failed')).toBe(true);
  });

  it('trustLevel 抛错 → fail-safe 降为 L1（只读，不越权写）', async () => {
    const deps = {
      findAccountByDomain: async () => ({ particle_id: 'p-acc-1', enrichment: {} }),
      appendEnrichment: async () => ({ ok: true }),
      trustLevel: async () => { throw new Error('config_down'); },
    };
    const r = await ingestChannelEvent({ channel: 'email', domain: 'acme.com', external_id: 'm1' }, deps);
    expect(r.written).toBe(false);
    expect(r.reason).toBe('read_only_l1');
  });

  it('无任何 deps（缺 findAccountByDomain）→ fail-closed 不写', async () => {
    const r = await ingestChannelEvent({ channel: 'email', domain: 'acme.com' }, {});
    expect(r.written).toBe(false);
  });
});
