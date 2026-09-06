// test/portal/sevenDimTabs.test.js — T22 七维页签：边绑定 + 归因阈值渲染契约
// 设计依据：docs/2026-08-30-full-traceability-root-cause-design.md §5/T32 + j2-j3 设计
// 锁定：renderEdgeBindings 渲染 E1-E7×维度 checkbox（data-edge/data-dim 供 DOM 反收集）；
//   renderRootCauseThresholds 渲染归因阈值块（id 供 collect 读取）；输出全部用语义 token（零硬编码）。
// 环境：vitest node（无 DOM）——只断言 HTML 字符串契约，collect*FromDom 由 data-/id 属性间接锁定。
import { describe, it, expect } from 'vitest';
import {
  renderEdgeBindings,
  renderRootCauseThresholds,
  SEVEN_KEYS,
} from '../../src/portal/sevenDimRender.js';

const SAMPLE_BINDINGS = [
  { edge_type: 'DECIDED_ON', serves_dimension: ['identity', 'structure'], direction: 'decision->entity' },
  { edge_type: 'REFERENCED_PRECEDENT', serves_dimension: ['decision_history'], direction: 'decision->decision' },
  { edge_type: 'DERIVED_FROM_EXCEPTION', serves_dimension: ['operational_state'], direction: 'decision->exception' },
  { edge_type: 'ESTABLISHES_FRAME', serves_dimension: ['semantics', 'governance'], direction: 'decision->decision' },
  { edge_type: 'OVERRIDES', serves_dimension: ['governance', 'decision_history'], direction: 'decision->decision' },
  { edge_type: 'CAUSED', serves_dimension: ['time_config'], direction: 'decision->decision' },
  { edge_type: 'INFLUENCED', serves_dimension: ['time_config'], direction: 'decision->decision' },
];

describe('renderEdgeBindings（T22 边绑定页签）', () => {
  it('渲染 7 条边，每条含 data-edge + 每维 checkbox（data-dim）', () => {
    const html = renderEdgeBindings({ edgeBindings: SAMPLE_BINDINGS, dims: SEVEN_KEYS.map((k) => ({ key: k, label: k })) });
    for (const b of SAMPLE_BINDINGS) expect(html).toContain(`data-edge="${b.edge_type}"`);
    for (const k of SEVEN_KEYS) expect(html).toContain(`data-dim="${k}"`);
    expect(html).toContain('id="sd7-eb-save"');
    expect(html).toContain('id="sd7-eb-matrix"');
  });

  it('勾选态与 serves_dimension 一致（checked 只出现在绑定维）', () => {
    const html = renderEdgeBindings({ edgeBindings: SAMPLE_BINDINGS, dims: SEVEN_KEYS.map((k) => ({ key: k, label: k })) });
    const decided = html.match(/<tr data-edge="DECIDED_ON">.*?<\/tr>/s)?.[0] || '';
    expect(decided).toContain(`data-dim="identity" checked`);
    expect(decided).toContain(`data-dim="structure" checked`);
    expect(decided).not.toContain(`data-dim="semantics" checked`);
  });

  it('无 dims 参数 → 用 SEVEN_KEYS 兜底渲染（浏览器安全）', () => {
    const html = renderEdgeBindings({ edgeBindings: SAMPLE_BINDINGS });
    for (const k of SEVEN_KEYS) expect(html).toContain(`data-dim="${k}"`);
  });
});

describe('renderRootCauseThresholds（T22 归因阈值块）', () => {
  const DEFAULTS = { default_input_stale_ms: 24 * 3600 * 1000, field_mismatch_enabled: true, info_incomplete_enabled: true, input_stale_enabled: true };

  it('渲染兜底时效（小时 24）+ 三开关（id 契约供 collect）', () => {
    const html = renderRootCauseThresholds({ thresholds: DEFAULTS });
    expect(html).toContain('id="sd7-rc-hours"');
    expect(html).toContain('id="sd7-rc-field"');
    expect(html).toContain('id="sd7-rc-info"');
    expect(html).toContain('id="sd7-rc-stale"');
    expect(html).toContain('id="sd7-rc-save"');
    expect(html).toContain('value="24"');
  });

  it('开关关闭态 → checkbox 无 checked（input_stale_enabled=false）', () => {
    const html = renderRootCauseThresholds({ thresholds: { ...DEFAULTS, input_stale_enabled: false } });
    const staleLabel = html.match(/<label><input type="checkbox" id="sd7-rc-stale"[^>]*>输入不及时检<\/label>/)?.[0] || '';
    expect(staleLabel).not.toContain('checked');
    const fieldLabel = html.match(/<label><input type="checkbox" id="sd7-rc-field"[^>]*>字段不一致检<\/label>/)?.[0] || '';
    expect(fieldLabel).toContain('checked');
  });

  it('缺省 ms → 兜底 24h 渲染（浏览器安全）', () => {
    const html = renderRootCauseThresholds({ thresholds: {} });
    expect(html).toContain('value="24"');
  });
});