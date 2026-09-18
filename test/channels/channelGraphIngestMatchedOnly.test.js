// test/channels/channelGraphIngestMatchedOnly.test.js — P0-4（ATTIO 事实标准：未匹配不落库）
// 判据：
//   ① matched_only（默认 true）下未命中既有客户粒子 → 不落 enrichment（written=false）+ 计 discard（skipped_unmatched）
//   ② 命中既有账户 → 正常落 enrichment（行为不变）
//   ③ 丢弃计数为可见字段，便于与「隐私排除/数据变少」区分，防误读为故障
import { describe, it, expect } from 'vitest';
import { ingestChannelEvent } from '../../src/channels/channelGraphIngest.js';

describe('channelGraphIngest 未匹配不落库（P0-4）', () => {
  it('matched_only=true 且未命中账户 → 不落库 + skipped_unmatched 计数', async () => {
    let appended = 0;
    const deps = {
      findAccountByDomain: async () => null,
      appendEnrichment: async () => { appended++; return { ok: true }; },
      trustLevel: async () => 'L3',
    };
    const r = await ingestChannelEvent({ channel: 'email', domain: 'nobody.com', external_id: 'x-1' }, { ...deps, matchedOnly: true });
    expect(r.written).toBe(false);
    expect(r.reason).toBe('account_not_found');
    expect(r.skipped_unmatched).toBe(true);
    expect(appended).toBe(0);
  });

  it('缺省（不传 matchedOnly）→ 等同 true：未命中亦不落库', async () => {
    let appended = 0;
    const deps = {
      findAccountByDomain: async () => null,
      appendEnrichment: async () => { appended++; return { ok: true }; },
      trustLevel: async () => 'L3',
    };
    const r = await ingestChannelEvent({ channel: 'email', domain: 'nobody.com', external_id: 'x-2' }, deps);
    expect(r.written).toBe(false);
    expect(r.skipped_unmatched).toBe(true);
    expect(appended).toBe(0);
  });

  it('命中既有账户 → 正常落 enrichment（matched_only 不改变命中路径语义）', async () => {
    let appended = 0;
    const deps = {
      findAccountByDomain: async () => ({ particle_id: 'p-acc-1', enrichment: {} }),
      appendEnrichment: async () => { appended++; return { ok: true }; },
      addWeakEdge: async () => ({ ok: true }),
      trustLevel: async () => 'L2',
    };
    const r = await ingestChannelEvent({ channel: 'email', domain: 'acme.com', external_id: 'm1' }, { ...deps, matchedOnly: true });
    expect(r.written).toBe(true);
    expect(r.skipped_unmatched).toBeFalsy();
    expect(appended).toBe(1);
  });
});
