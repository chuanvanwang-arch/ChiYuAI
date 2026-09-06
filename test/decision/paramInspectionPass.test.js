// test/decision/paramInspectionPass.test.js — 参数体检 pass 单测（P0 参数闭环）
// 覆盖：开关 disabled 跳过 / !dryRun 落 PENDING 处方（幂等）/ dryRun 不落库不落报告 /
//       落报告 param_inspection 列（reportId 存在时）/ 失败 emit+recordFailure 不抛（禁裸 catch）。
// 铁律：绝不自动 apply；三段不传染；禁 DELETE。
import { describe, it, expect, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  savePatches: vi.fn(),
  query: vi.fn(),
  emit: vi.fn(),
  recordFailure: vi.fn(),
  inspectAll: vi.fn(),
}));

vi.mock('../../src/calibration/store.js', () => ({
  savePatches: mocks.savePatches,
  produceDecision: vi.fn(),
}));
vi.mock('../../src/db.js', () => ({ query: mocks.query, queryWrite: vi.fn(), withTx: vi.fn() }));
vi.mock('../../src/events/bus.js', () => ({ emit: mocks.emit, on: vi.fn() }));
vi.mock('../../src/monitor/monitorStore.js', () => ({ recordFailure: mocks.recordFailure }));
vi.mock('../../src/config/configStore.js', () => ({
  readConfig: vi.fn().mockResolvedValue({ value: null }),
}));
const { runParamInspectionPass } = await import('../../src/decision/retro.js');

describe('参数体检 pass（runParamInspectionPass）', () => {
  it('配置 disabled → 跳过，不落库不落报告', async () => {
    // readConfig 返回 enabled:false
    const { readConfig } = await import('../../src/config/configStore.js');
    readConfig.mockResolvedValueOnce({ value: { enabled: false } });
    const out = await runParamInspectionPass({ tenantId: 'system', dryRun: false, reportId: 'r1' });
    expect(out.skipped).toBe('disabled');
    expect(mocks.savePatches).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('!dryRun：落 PENDING 处方（绝不 apply）+ 落报告 param_inspection 列 + SSE', async () => {
    mocks.inspectAll.mockResolvedValueOnce({
      inspected: 22, healthy: 21, drift: 1, degraded: 0, unknown: 0,
      items: [],
      patches: [{ knob: 'config_store', target: 'autonomy-conf.threshold', from_value: { threshold: 0.7 }, to_value: { threshold: 0.65 }, risk: 'MEDIUM', assignee: 'ADMIN', tenant_id: 'system' }],
    });
    mocks.savePatches.mockResolvedValueOnce({ created: 1 });
    mocks.query.mockResolvedValueOnce({ rows: [] });
    const out = await runParamInspectionPass({ tenantId: 'system', dryRun: false, reportId: 'r1', inspectAll: mocks.inspectAll });
    expect(mocks.savePatches).toHaveBeenCalledTimes(1);
    expect(mocks.savePatches.mock.calls[0][1][0].knob).toBe('config_store');
    expect(mocks.savePatches.mock.calls[0][1][0].to_value).toEqual({ threshold: 0.65 });
    // 落报告列（UPDATE ... param_inspection）
    expect(mocks.query.mock.calls.some((c) => String(c[0]).includes('param_inspection'))).toBe(true);
    // SSE calibration 域
    expect(mocks.emit.mock.calls.some((c) => c[0] === 'calibration' && c[1] === 'param-inspection')).toBe(true);
    expect(out.patches_created).toBe(1);
  });

  it('dryRun：不落处方、不落报告、不发 SSE', async () => {
    // 清跨用例计数（上一个 !dryRun 用例已调用 savePatches/query）——状态隔离
    mocks.savePatches.mockClear();
    mocks.query.mockClear();
    mocks.emit.mockClear();
    mocks.inspectAll.mockResolvedValueOnce({
      inspected: 22, healthy: 22, drift: 0, degraded: 0, unknown: 0,
      items: [],
      patches: [{ target: 'x.y' }],
    });
    const out = await runParamInspectionPass({ tenantId: 'system', dryRun: true, reportId: 'r1', inspectAll: mocks.inspectAll });
    expect(mocks.savePatches).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.emit.mock.calls.filter((c) => c[1] === 'param-inspection')).toHaveLength(0);
    expect(out.patches_created).toBe(0);
  });

  it('失败：emit+recordFailure 留痕且不抛（禁裸 catch）', async () => {
    mocks.inspectAll.mockRejectedValueOnce(new Error('db 不可达'));
    const out = await runParamInspectionPass({ tenantId: 'system', dryRun: false, inspectAll: mocks.inspectAll });
    expect(mocks.recordFailure).toHaveBeenCalledWith('param-inspection-failed', expect.any(Error));
    expect(mocks.emit.mock.calls.some((c) => c[0] === 'trace' && c[1] === 'param-inspection-failed')).toBe(true);
    expect(out.errors).toContain('db 不可达');
  });
});
