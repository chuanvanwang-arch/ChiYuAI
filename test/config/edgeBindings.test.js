// test/config/edgeBindings.test.js — 6.2 edge_bindings 配置中心门户卡片
// 契约：C-DAI 决策问责闭环（归属 decision-retro 智能体；knowledgeScope L1–L3）
// 测试计划 §5.7：edgeDimensionSpec E1–E7 × 维度校验完整（复用 DEFAULT_EDGE_DIMENSION_SPEC）。
// 数据面（sevenDimRouter PUT/GET）已有 test/http/sevenDimRouter-edge-bindings.test.js 覆盖；
// 本文件锁死门户入口（三处同步铁律：configCenter.js / config.html GROUPS / 断言）。
//
// 断言口径更正（2026-09-01）：边绑定已并入 id15「七维设计」页统一编辑
// （同 config_store['seven-dim'] 键下的 edge_bindings 子键，
//  见 src/http/sevenDimRouter.js:63-80 与 src/web/seven-dim.html:46），
// 故门户入口守卫断言 id15 承载。注：id33 原为边绑定占位已删除，后以
// 「销售决策思维要素总览」功能恢复（configCenter.js:35，endpoint /api/decision/thinking-templates），
// 不再断言 id33 不存在（存在与否由 configCenter.test.js 全量并集断言覆盖）。
import { describe, it, expect } from 'vitest';
import { CONFIG_ITEMS, renderConfigCenter } from '../../src/portal/configCenter.js';
import { EDGES, DIMENSIONS, DEFAULT_EDGE_DIMENSION_SPEC, validateEdgeDimensionSpec } from '../../src/decision/edgeDimensionSpec.js';

describe('6.2 edge_bindings 配置中心', () => {
  it('边绑定门户入口由 id15 七维设计承载（id33 不承载边绑定）', () => {
    const item33 = CONFIG_ITEMS.find((i) => i.id === 33);
    expect(item33).toBeTruthy(); // 33 为「思维要素总览」功能（非边绑定）
    expect(item33.endpoint).toBe('/api/decision/thinking-templates');
    const item = CONFIG_ITEMS.find((i) => i.id === 15);
    expect(item).toBeTruthy();
    expect(item.group).toBe('销售方法论与决策治理');
    expect(item.endpoint).toContain('seven-dim');
    expect(item.page).toBe('/seven-dim.html');
  });

  it('renderConfigCenter 渲染七维设计卡片（边绑定编辑入口）', () => {
    const html = renderConfigCenter(CONFIG_ITEMS, {});
    expect(html).toContain('data-id="15"');
    expect(html).toContain('href="/seven-dim.html"');
  });

  it('E1–E7 × 维度默认绑定校验完整（7 边 7 维全覆盖）', () => {
    const v = validateEdgeDimensionSpec(DEFAULT_EDGE_DIMENSION_SPEC);
    expect(v.valid).toBe(true);
    expect(v.errors).toEqual([]);
    expect(DEFAULT_EDGE_DIMENSION_SPEC).toHaveLength(EDGES.length);
    // 每边有绑定的维度
    for (const e of EDGES) {
      const row = DEFAULT_EDGE_DIMENSION_SPEC.find((r) => r.edge_type === e.key);
      expect(row).toBeTruthy();
      expect(row.serves_dimension.length).toBeGreaterThanOrEqual(1);
    }
    // 每维至少有一边服务
    const served = new Set(DEFAULT_EDGE_DIMENSION_SPEC.flatMap((r) => r.serves_dimension));
    for (const d of DIMENSIONS) expect(served.has(d.key)).toBe(true);
  });
});