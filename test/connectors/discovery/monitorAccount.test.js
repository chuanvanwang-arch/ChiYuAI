import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { monitorAccount } from '../../../src/connectors/discovery/monitorAccount.js';

const mkCtx = (over = {}) => ({
  getAccount: vi.fn(async () => ({
    id: 'acc1',
    payload: {
      discovery: {
        icp_fit_score: { value: 0.6, judge: { axis: 'capability', rule_ref: 'scenario:lead-fit#ruler:industry', j_score: 0.6 } },
        enrichment: { industry: { source: 'gaode', provider: 'gaode' } },
      },
    },
  })),
  rescore: vi.fn(async () => ({ score: 0.77, ruleRef: 'scenario:lead-fit#ruler:funding_round' })),
  appendMemory: vi.fn(async () => ({ ok: true, row: { id: 'm1' } })),
  updateParticle: vi.fn(async () => ({})),
  ...over,
});

describe('monitorAccount (C3)', () => {
  it('① 重评分 + append 记忆 + 只 update（零 DELETE）', async () => {
    const ctx = mkCtx();
    const out = await monitorAccount(ctx, 'acc1', [{ type: 'funding_round' }]);
    expect(ctx.getAccount).toHaveBeenCalledWith('acc1');
    expect(ctx.rescore).toHaveBeenCalled();
    expect(ctx.appendMemory).toHaveBeenCalledTimes(1);
    expect(out.why_narrative).toContain('funding_round');
    expect(ctx.deleteParticle).toBeUndefined();
  });

  it('② patch 读-改-写：保留 payload.discovery 既有子键（防整体替换）', async () => {
    const ctx = mkCtx();
    await monitorAccount(ctx, 'acc1', [{ type: 'funding_round' }]);
    const { patch } = ctx.updateParticle.mock.calls[0][1];
    expect(patch.discovery.enrichment).toEqual({ industry: { source: 'gaode', provider: 'gaode' } }); // 未被抹掉
    expect(patch.discovery.icp_fit_score.value).toBe(0.6);                                        // 未被抹掉
    expect(patch.discovery.intent_score.value).toBe(0.77);                                        // 本次新增
  });

  it('③ 参数名必须是 patch（防写 payload 键静默丢）', async () => {
    const ctx = mkCtx();
    await monitorAccount(ctx, 'acc1', []);
    const arg = ctx.updateParticle.mock.calls[0][1];
    expect(arg.patch).toBeDefined();
    expect(arg.payload).toBeUndefined();
  });

  it('④ 喂 Task 12 指标（feedback verdict 非空）', async () => {
    const ctx = mkCtx();
    const out = await monitorAccount(ctx, 'acc1', []);
    expect(out.feedback.metric).toBe('monitorAccount_refresh_rate');
    expect(['green', 'yellow', 'red']).toContain(out.feedback.verdict);
  });

  it('⑤ 不触发外发（源码零 agent-mail / sendMail）', () => {
    const src = fs.readFileSync(path.resolve(process.cwd(), 'src/connectors/discovery/monitorAccount.js'), 'utf8');
    expect(/agent-?mail|sendMail|send_mail/i.test(src)).toBe(false);
  });

  it('⑥ 缺 score → fail-fast（不静默置 0）', async () => {
    const ctx = mkCtx({ rescore: vi.fn(async () => ({ ruleRef: 'r' })) });
    await expect(monitorAccount(ctx, 'acc1', [])).rejects.toThrow(/score/);
  });

  it('⑦ 错误路径：rescore 抛错透传（不静默吞）', async () => {
    const ctx = mkCtx({ rescore: vi.fn(async () => { throw new Error('lead-fit unavailable'); }) });
    await expect(monitorAccount(ctx, 'acc1', [])).rejects.toThrow('lead-fit unavailable');
  });
});
