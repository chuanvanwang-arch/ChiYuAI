// test/decision/routingReviewPass.test.js — 夜间跑批第②段：路由实验收口（2026-09-05 P2-1/P2-2，设计 §10）
//
// 契约：
//   ① 收口是**独立 pass**：复盘（LLM）失败不拖垮它，它失败也不抛给夜批主流程（绝不裸 catch）
//   ② 总开关可关（config_store['routing-explore'].daily_review_enabled=false）→ 空转跳过
//   ③ 异常 → emit trace + recordFailure + 返回 errors，**不抛出**（timers.js runRetroOnce 依赖此不抛语义）
// 零真实 DB：db / configStore / routingReview / llm.client / calibration.store 全 mock。
import { describe, it, expect, vi, beforeEach } from 'vitest';

const dbMock = vi.hoisted(() => ({ query: vi.fn() }));
const cfgMock = vi.hoisted(() => ({ readConfig: vi.fn() }));
const reviewMock = vi.hoisted(() => ({ routingReview: vi.fn(), dailyReviewEnabled: vi.fn() }));
const monMock = vi.hoisted(() => ({ recordFailure: vi.fn() }));
const emitMock = vi.hoisted(() => ({ emit: vi.fn() }));

vi.mock('../../src/db.js', () => ({ query: (...a) => dbMock.query(...a), queryWrite: vi.fn() }));
vi.mock('../../src/config/configStore.js', () => ({ readConfig: (...a) => cfgMock.readConfig(...a) }));
vi.mock('../../src/decision/routingReview.js', () => ({
  routingReview: (...a) => reviewMock.routingReview(...a),
  dailyReviewEnabled: (...a) => reviewMock.dailyReviewEnabled(...a),
}));
vi.mock('../../src/monitor/monitorStore.js', () => ({ recordFailure: (...a) => monMock.recordFailure(...a) }));
vi.mock('../../src/events/bus.js', () => ({ emit: (...a) => emitMock.emit(...a) }));
vi.mock('../../src/llm/client.js', () => ({ getLlmJson: vi.fn(async () => null) }));
vi.mock('../../src/calibration/store.js', () => ({ savePatches: vi.fn(async () => ({ created: 0, skipped: [] })), createPatch: vi.fn() }));

const { runRoutingReviewPass } = await import('../../src/decision/retro.js');

const OK_OUT = { tenantId: 'system', closed: 1, patches: [{ patch_id: 1 }], nextArms: [], insufficient: [], errors: [] };

beforeEach(() => {
  dbMock.query.mockReset();
  cfgMock.readConfig.mockReset();
  reviewMock.routingReview.mockReset();
  reviewMock.dailyReviewEnabled.mockReset();
  monMock.recordFailure.mockReset();
  emitMock.emit.mockReset();

  dbMock.query.mockImplementation(async () => ({ rows: [] }));
  cfgMock.readConfig.mockImplementation(async () => ({ value: null }));
  reviewMock.dailyReviewEnabled.mockImplementation(async () => true);
  reviewMock.routingReview.mockImplementation(async () => structuredClone(OK_OUT));
});

describe('runRoutingReviewPass — 夜间独立 pass', () => {
  it('开关开 → 跑收口并 emit routing-review-done（带计数）', async () => {
    const out = await runRoutingReviewPass({ tenantId: 'system' });
    expect(reviewMock.routingReview).toHaveBeenCalledWith({ tenantId: 'system', dryRun: false });
    expect(out.closed).toBe(1);
    const done = emitMock.emit.mock.calls.find((c) => c[1] === 'routing-review-done');
    expect(done).toBeTruthy();
    expect(done[2]).toMatchObject({ closed: 1, patches: 1, errors: 0 });
  });

  it('② 开关关 → 空转跳过（不调 routingReview）', async () => {
    reviewMock.dailyReviewEnabled.mockImplementation(async () => false);
    const out = await runRoutingReviewPass({ tenantId: 'system' });
    expect(out.skipped).toBe('disabled');
    expect(reviewMock.routingReview).not.toHaveBeenCalled();
  });

  it('③ 收口抛错 → 不抛出：留痕 emit + recordFailure + 返回 errors', async () => {
    reviewMock.routingReview.mockImplementation(async () => { throw new Error('boom-review'); });
    const out = await runRoutingReviewPass({ tenantId: 'system' });
    expect(out.errors).toEqual(['boom-review']);
    expect(out.closed).toBe(0);
    expect(emitMock.emit.mock.calls.some((c) => c[1] === 'routing-review-failed')).toBe(true);
    expect(monMock.recordFailure).toHaveBeenCalledWith('routing-review-failed', expect.any(Error));
  });

  it('收口内部错误（errors 非空但没抛）→ 仍 emit done，错误数如实上报', async () => {
    reviewMock.routingReview.mockImplementation(async () => ({ ...structuredClone(OK_OUT), errors: ['scan-failed'] }));
    const out = await runRoutingReviewPass({ tenantId: 'system' });
    expect(out.errors).toEqual(['scan-failed']);
    const done = emitMock.emit.mock.calls.find((c) => c[1] === 'routing-review-done');
    expect(done[2].errors).toBe(1);
  });

  it('dryRun 透传（排障用，不写库）', async () => {
    await runRoutingReviewPass({ tenantId: 'system', dryRun: true });
    expect(reviewMock.routingReview).toHaveBeenCalledWith({ tenantId: 'system', dryRun: true });
  });
});
