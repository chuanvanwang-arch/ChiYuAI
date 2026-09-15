// test/connectors/discovery/research.test.js
import { describe, it, expect, vi } from 'vitest';
import { claygentResearch } from '../../../src/connectors/discovery/claygent.js';
import { runDiscoveryResearch } from '../../../src/action/discoveryActions.js';

// LLM 调用器替身：严格按「工厂产出物」形状 (systemPrompt, userPrompt, o) => JSON
const scripted = (sections) => vi.fn(async (system /*, user, o */) => {
  if (system.includes('线索研究员')) return { sections };
  return { summary: 'S', signals: [{ type: 'funding_round', evidence: 'E' }], competitors: ['A'], risks: [] };
});

describe('claygentResearch（C2 研究代理）', () => {
  it('① 产 { report, why_narrative, signals[] }，layer=L3 / source=claygent', async () => {
    const out = await claygentResearch({ name: 'X', domain: 'x.com' }, '调查竞品与融资信号', { getLlmJson: scripted([{ name: 'pricing' }, { name: 'careers' }]) });
    expect(out.report).toBeTruthy();
    expect(out.why_narrative).toBeTruthy();
    expect(Array.isArray(out.signals)).toBe(true);
    expect(out.signals.length).toBeGreaterThan(0);
    expect(out.layer).toBe('L3');
    expect(out.source).toBe('claygent');
  });

  it('② why_narrative 带 glass-box（rule_ref + j_score），与 P0#1 的 2D judge 同源', async () => {
    const out = await claygentResearch({ name: 'X', domain: 'x.com' }, 'B', { getLlmJson: scripted([{ name: 'pricing' }]) });
    expect(out.why_narrative).toContain('lead-fit');
    expect(out.glass_box.judge.axis).toBe('capability');
    expect(out.glass_box.judge.rule_ref).toContain('lead-fit');
    expect(typeof out.glass_box.judge.j_score).toBe('number');
    expect(out.glass_box.trace.length).toBeGreaterThan(0);
  });

  it('③ 无 LLM 通道 → fail-open degraded，不抛、不伪造', async () => {
    const out = await claygentResearch({ name: 'X' }, 'B', {});
    expect(out.degraded).toBe(true);
    expect(out.signals).toEqual([]);
    expect(out.why_narrative).toBe('');
  });

  it('④ LLM 返 null（未配置/不可解析）→ degraded 返空，绝不编造 summary', async () => {
    const out = await claygentResearch({ name: 'X', domain: 'x.com' }, 'B', { getLlmJson: vi.fn(async () => null) });
    expect(out.degraded).toBe(true);
    expect(out.summary).toBe('');
    expect(out.signals).toEqual([]);
  });

  it('⑤ 区块二分：先规划区块再定向抓取；单区块抓取抛错不中断；无 fetchText 则零抓取且不伪造', async () => {
    const seen = [];
    const fetchText = vi.fn(async (url, section) => {
      seen.push(section);
      if (section === 'team') throw new Error('HTTP 500'); // 单区块失败须 fail-open
      return `raw-${section}`;
    });
    const out = await claygentResearch({ name: 'X', domain: 'x.com' }, 'B', { getLlmJson: scripted([{ name: 'pricing' }, { name: 'team' }]), fetchText });
    expect(seen).toEqual(['pricing', 'team']);          // 定向抓取（不是整站）
    expect(out.fetchedSections).toBe(2);                // 抛错仍计「已尝试」
    expect(out.signals.length).toBeGreaterThan(0);      // 单区块失败不中断整条研究

    const out2 = await claygentResearch({ name: 'X', domain: 'x.com' }, 'B', { getLlmJson: scripted([{ name: 'pricing' }]) });
    expect(out2.fetchedSections).toBe(0);               // 无通道 → 零抓取
    expect(out2.report).toBeTruthy();                   // 仍据模型已有知识产出，不伪造网页文本
  });
});

describe('runDiscoveryResearch（action 编排 · DI 替身零 DB）', () => {
  const ctx = { tenantId: 't1', decision_id: 'dec_1' };

  it('① 有产出 → 写 payload.research（tenantId + requireDecisionId 真实透传）', async () => {
    const updateParticle = vi.fn(async () => ({}));
    const getParticle = vi.fn(async () => ({ id: 'a1', payload: { name: 'X', domain: 'x.com' } }));
    const out = await runDiscoveryResearch({ account_id: 'a1', brief: 'B' }, ctx,
      { getParticle, updateParticle, getLlmJson: scripted([{ name: 'pricing' }]) });
    expect(out.written).toBe(true);
    expect(updateParticle).toHaveBeenCalledTimes(1);
    const [id, opts] = updateParticle.mock.calls[0];
    expect(id).toBe('a1');
    expect(opts.patch.research).toBeTruthy();
    expect(opts.patch.research.why_narrative).toBeTruthy();
    expect(opts.tenantId).toBe('t1');
    expect(opts.requireDecisionId).toBe('dec_1');
  });

  it('② 无产出（fail-open 返空）→ 绝不写库', async () => {
    const updateParticle = vi.fn(async () => ({}));
    const getParticle = vi.fn(async () => ({ id: 'a1', payload: {} }));
    const out = await runDiscoveryResearch({ account_id: 'a1', brief: 'B' }, ctx,
      { getParticle, updateParticle, getLlmJson: vi.fn(async () => null) });
    expect(out.written).toBe(false);
    expect(updateParticle).not.toHaveBeenCalled();
  });
});
