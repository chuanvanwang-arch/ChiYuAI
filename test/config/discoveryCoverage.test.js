// test/config/discoveryCoverage.test.js — 口径守卫（含页面镜像防漂移）
// 为什么需要：
//   ① 「招聘 / 新战略 / 高层变动」在本平台**无数据源**。若这些字段继续以"可用信号"示人，
//      就是「配置承诺 ≠ 实现」——本仓已多次为此付出代价（审计 §1.2）。
//      故须显式标注 coverage:'no_internal_source'，让任何读配置的人都看得到边界。
//   ② src/web/discovery-rules.html 第 196-198 行是 signals 的**第二份副本**（漂移源）：
//      改了一处、漏另一处 → 配置页显示的权重与后端实际生效的不一致。故加镜像一致守卫。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { DEFAULT_DISCOVERY_RULES } from '../../src/config/discoveryRules.js';

const html = readFileSync(new URL('../../src/web/discovery-rules.html', import.meta.url), 'utf8');
const S = DEFAULT_DISCOVERY_RULES.signals;

describe('口径：三字段显式标注无内部数据源', () => {
  it('hiring_icp_role / leadership_change 等无源字段带 coverage 标注', () => {
    for (const k of ['hiring_icp_role', 'leadership_change']) {
      expect(S[k], `缺 ${k}`).toBeDefined();
      expect(S[k].coverage, `${k} 缺 coverage 标注`).toBe('no_internal_source');
    }
  });
});

describe('内部可观测异动：低置信派生，不得与实测情报同权', () => {
  it('contact_ledger_change / relation_cooling 存在且标注 internal_inference', () => {
    for (const k of ['contact_ledger_change', 'relation_cooling']) {
      expect(S[k], `缺 ${k}`).toBeDefined();
      expect(S[k].coverage).toBe('internal_inference');
      expect(typeof S[k].weight).toBe('number');
    }
  });

  it('派生权重严格低于最高实测情报权重（不同权）', () => {
    const maxMeasured = Math.max(
      ...Object.entries(S).filter(([, v]) => v.coverage !== 'internal_inference').map(([, v]) => v.weight),
    );
    for (const k of ['contact_ledger_change', 'relation_cooling']) {
      expect(S[k].weight).toBeLessThan(maxMeasured);
    }
  });
});

describe('页面镜像防漂移', () => {
  it('discovery-rules.html 的 signals 副本与 DEFAULT_DISCOVERY_RULES.signals 键与权重一致', () => {
    for (const [k, v] of Object.entries(S)) {
      // 页面写法形如 `funding_round: { weight: 0.9 },`（允许同行多个）
      const re = new RegExp(`${k}\\s*:\\s*\\{\\s*weight\\s*:\\s*${v.weight}\\s*\\}`);
      expect(re.test(html), `页面镜像与后端不一致：${k} weight=${v.weight}`).toBe(true);
    }
  });

  it('页面含两项新信号的业务标签（且不再把无源字段表述为可用筛选）', () => {
    expect(html).toContain('contact_ledger_change');
    expect(html).toContain('relation_cooling');
    expect(html).toMatch(/内部推断/);           // 面板须显式提示置信边界
  });
});
