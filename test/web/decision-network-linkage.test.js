// test/web/decision-network-linkage.test.js — 决策网络三页联动契约（静态校验，零浏览器依赖）
// 背景（2026-09-01 死区审计）：作战室「重跑场景」带 ?decisionId= 跳转到场景配置页，目标页完全不消费该参数；
// 决策链追溯页的本地 api() 未带 Authorization，命中 requireMe 端点恒 401 却被 catch {} 静默吞掉
// → 图永远只有一个孤立根决策点、四个按钮点了没反应。以下断言锁定修复不回退。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL('../../' + p, import.meta.url), 'utf8');
const monitor = read('src/web/sales-decision-monitor.html');
const scenarios = read('src/web/decision-scenarios.html');
const graph = read('src/web/decision-graph.html');
const closure = read('src/web/business-closure.html');

// 零硬编码色值审计（#fff/#ffffff 为深底白字合法保留）
function nonWhiteHexes(html) {
  return (html.match(/#[0-9a-fA-F]{3,8}\b/g) || []).filter((h) => !/^#(fff|ffffff)$/i.test(h));
}

describe('T8 联动：作战室 → 场景配置页（?decisionId= 不丢上下文）', () => {
  it('作战室两个「重跑场景」出口都会带出当前决策 id', () => {
    expect(monitor).toMatch(/id="loop-decision"/);
    expect(monitor).toMatch(/id="retro-rerun-link"/);
    // renderDnInline 成功后把 ?decisionId= 写进两个出口的 href
    expect(monitor).toMatch(/loopLink\.setAttribute\('href',\s*'\/decision-scenarios\.html'\s*\+\s*q\)/);
    expect(monitor).toMatch(/retroLink\.setAttribute\('href',\s*'\/decision-scenarios\.html'\s*\+\s*q\)/);
  });

  it('场景配置页消费 ?decisionId= 并反查归属场景（数据源 /api/decision/:id/closure）', () => {
    expect(scenarios).toMatch(/new URLSearchParams\(location\.search\)\.get\('decisionId'\)/);
    expect(scenarios).toMatch(/\/api\/decision\/'\s*\+\s*encodeURIComponent\(FOCUS_ID\)\s*\+\s*'\/closure'/);
    expect(scenarios).toMatch(/focusScenario\s*=\s*j\?\.m\?\.scenario_id/);
  });

  it('场景配置页用 api()（带 Authorization）而非裸 fetch 读 closure 端点', () => {
    // 回归点：closure 走 requireMe，裸 fetch 恒 401 → 上下文条恒显示「未能定位归属场景」
    const seg = scenarios.slice(scenarios.indexOf('async function loadFocusContext'));
    expect(seg.slice(0, 1200)).toMatch(/await get\('\/api\/decision\//);
    expect(seg.slice(0, 1200)).not.toMatch(/await fetch\('\/api\/decision\//);
  });

  it('命中场景高亮且可在 15s 自动刷新后重放（applyFocus 挂在 render 内）', () => {
    expect(scenarios).toMatch(/function applyFocus\(\)/);
    expect(scenarios).toMatch(/card\.classList\.add\('focus'\)/);
    // applyFocus() 必须挂在 render() 内（首屏 + 每次 15s 自动刷新后重放高亮）
    expect(scenarios).toMatch(/function render\(scenarios\)[\s\S]{0,2000}applyFocus\(\)/);
  });

  it('场景数动态计数（副标题不再写死「8 场景」）', () => {
    expect(scenarios).toMatch(/id="ds-sub-count"/);
    expect(scenarios).toMatch(/subCount\.textContent\s*=\s*String\(scenarios\.length\)/);
    expect(scenarios).not.toMatch(/（§6）8 场景/);
  });
});

describe('T8 联动：决策链追溯页消费 ?decisionId=（预填 + 自动追溯）', () => {
  it('initFromQuery 读取参数、预填输入框并自动触发 renderTrace', () => {
    expect(graph).toMatch(/function initFromQuery\(\)/);
    expect(graph).toMatch(/new URLSearchParams\(location\.search\)\.get\('decisionId'\)/);
    expect(graph).toMatch(/renderTrace\(q\)/);
  });
});

describe('决策链追溯页鉴权死区（回归闸门）', () => {
  it('本地 api() 必须携带 Authorization: Bearer crm_token', () => {
    const seg = graph.slice(graph.indexOf('async function api(path)'));
    expect(seg.slice(0, 900)).toMatch(/localStorage\.getItem\('crm_token'\)/);
    expect(seg.slice(0, 900)).toMatch(/headers\.Authorization\s*=\s*'Bearer '\s*\+\s*tk/);
  });

  it('追溯失败必须可见（不得 catch {} 静默吞异常）', () => {
    expect(graph).not.toMatch(/catch\s*\{\s*\}\s*;?\s*\n\s*const nodes/);
    expect(graph).toMatch(/traceErr/);
    expect(graph).toMatch(/追溯失败：/);
  });

  it('决策链图卡片不塌缩（svg width:100% 在 flex item 需给定基础宽度）', () => {
    expect(graph).toMatch(/\.stage\s*>\s*\.rcard\s*\{\s*flex:1 1 0;\s*min-width:0;/);
  });
});

describe('业务闭环页鉴权一致性（回归闸门）', () => {
  it('业务闭环页读 /api/business/board 必须走带鉴权的 get()（不得裸 fetch 无 Authorization）', () => {
    // /api/business/board 经 resolveMe 做租户隔离；裸 fetch 无 token 会依赖 scopeTenant 回退，
    // 属与决策链追溯页同源的鉴权死区隐患。页面已 import { get } from '/portal/api.js'。
    expect(closure).toMatch(/import\s*\{\s*get\s*,\s*post\s*,\s*put\s*\}\s*from\s*'\/portal\/api\.js'/);
    expect(closure).toMatch(/await get\('\/api\/business\/board'\)/);
    expect(closure).not.toMatch(/fetch\('\/api\/business\/board'\)/);
  });
});

describe('三页 UI 一致性铁律（零硬编码色值）', () => {
  it('sales-decision-monitor.html', () => expect(nonWhiteHexes(monitor)).toEqual([]));
  it('decision-scenarios.html', () => expect(nonWhiteHexes(scenarios)).toEqual([]));
  it('decision-graph.html', () => expect(nonWhiteHexes(graph)).toEqual([]));
});

describe('作战室 rc/loop 页签死区（回归闸门）', () => {
  it('dnRender 含 rc / loop 分支，且置于 4 问审计守卫之前', () => {
    const start = monitor.indexOf('function dnRender(');
    const seg = monitor.slice(start, start + 1400);
    expect(seg).toMatch(/active === 'rc'/);
    expect(seg).toMatch(/active === 'loop'/);
    // 分支必须早于 a4 守卫，否则恒被拦成「请先加载 4 问审计」
    expect(seg.indexOf("active === 'rc'")).toBeLessThan(seg.indexOf('const a4 ='));
    expect(seg.indexOf("active === 'loop'")).toBeLessThan(seg.indexOf('const a4 ='));
  });

  it('页面级 #dn-output 有内联摘要渲染入口（renderDnInline）', () => {
    expect(monitor).toMatch(/async function renderDnInline\(id\)/);
    expect(monitor).toMatch(/renderDnInline\(DN_CACHE\.root\)/);
    expect(monitor).toMatch(/renderDnInline\(sel\.value\)/);
  });
});
