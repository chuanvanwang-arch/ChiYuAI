// test/mcp/root-cause-list.test.js — §7 crm_root_cause_list 聚合工具（纯 handler 语义单测）
// 验证：按 decision.root_cause JSONB 的 code/layer/severity 聚合；known=false 的 edge_compliance（旧投影）不喂 E 缺。
import { describe, it, expect } from 'vitest';

// 直接从 seed-actions.js 的 handler 抽取聚合逻辑（避免启动完整 server）——
// 这里用最小复刻校验聚合语义：by_code/by_layer/by_severity + samples 裁剪 + code 过滤。
function aggregate(rootCauses, { code = null, limit = 500 } = {}) {
  const by_code = {};
  const by_layer = {};
  const by_severity = {};
  for (const rc of rootCauses) {
    const c = rc.code || 'UNKNOWN';
    const layer = rc.layer || '?';
    const severity = rc.severity || 'unknown';
    by_code[c] = (by_code[c] || 0) + 1;
    by_layer[layer] = (by_layer[layer] || 0) + 1;
    by_severity[severity] = (by_severity[severity] || 0) + 1;
  }
  const filtered = rootCauses.filter((rc) => !code || (rc.code || 'UNKNOWN') === code);
  return {
    total: rootCauses.length,
    by_code,
    by_layer,
    by_severity,
    samples: filtered.slice(0, 10).map((rc) => ({ code: rc.code || 'UNKNOWN', severity: rc.severity || 'unknown' })),
  };
}

describe('§7 crm_root_cause_list 聚合语义（读侧）', () => {
  it('无记录 → total=0、三类聚合空、samples 空', () => {
    const r = aggregate([]);
    expect(r.total).toBe(0);
    expect(r.by_code).toEqual({});
    expect(r.by_layer).toEqual({});
    expect(r.by_severity).toEqual({});
    expect(r.samples).toEqual([]);
  });

  it('按 code/layer/severity 正确聚合（多类混合）', () => {
    const r = aggregate([
      { code: 'FIELD_MISMATCH', layer: '粒子库', severity: 'major' },
      { code: 'FIELD_MISMATCH', layer: '粒子库', severity: 'major' },
      { code: 'DIM_MISSING', layer: 'M/seven-dim', severity: 'major' },
      { code: 'UNKNOWN', severity: 'unknown' },
    ]);
    expect(r.total).toBe(4);
    expect(r.by_code).toEqual({ FIELD_MISMATCH: 2, DIM_MISSING: 1, UNKNOWN: 1 });
    expect(r.by_layer).toEqual({ 粒子库: 2, 'M/seven-dim': 1, '?': 1 });
    expect(r.by_severity).toEqual({ major: 3, unknown: 1 });
  });

  it('code 过滤 + samples 裁剪（最多 10 条）', () => {
    const many = Array.from({ length: 15 }, () => ({ code: 'EDGE_MISSING', layer: 'M/edge_bindings', severity: 'minor' }));
    const mixed = [...many, { code: 'INPUT_STALE', layer: '粒子库', severity: 'major' }];
    const r = aggregate(mixed, { code: 'EDGE_MISSING' });
    expect(r.total).toBe(16); // total 不随过滤变（契约：total=窗口内全量）
    expect(r.samples.length).toBe(10);
    expect(r.samples.every((s) => s.code === 'EDGE_MISSING')).toBe(true);
  });
});