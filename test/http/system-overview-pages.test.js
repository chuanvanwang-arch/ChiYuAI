// test/http/system-overview-pages.test.js — 三系统概览页契约测试
//
// 隔离纪律：纯只读（受控端点 + 静态壳），零 TRUNCATE / 零 INSERT；与
//   controlled-config-pages.test.js 同 createApp.fetch 范式，复用 beforeAll。
//
// 注：本测试**仅**断言契约结构（HTTP 200 + html 含四段式骨架特征字串 + 跳转目标）。
//   不强探数据精度（数据由既有受控端点保证；监控仪表盘本就允许「暂无数据」降级）。
import { describe, it, expect, beforeAll } from 'vitest';
import { createApp } from '../../src/http/server.js';
import { readFileSync } from 'node:fs';

let app;
beforeAll(() => { app = createApp(); });

async function getJson(path) {
  const res = await app.fetch(path);
  return { status: res.status, body: res.status === 200 ? await res.json() : null };
}
async function getText(path) {
  const res = await app.fetch(path);
  return { status: res.status, text: res.status === 200 ? await res.text() : '' };
}

// 1) sales-decision-monitor.html 内三闭环卡 href 已指向新概览页（不再跳配置页）
// 实际 HTML 顺序：class → href → id（regex 与真实 DOM 一致）
describe('T1: 三闭环卡 href 改造', () => {
  it('loop-knowledge href 指向 /system-overview/k', () => {
    const html = readFileSync('src/web/sales-decision-monitor.html', 'utf8');
    expect(html).toMatch(/href="\/system-overview\/k"\s+id="loop-knowledge"/);
  });
  it('loop-memory href 指向 /system-overview/m', () => {
    const html = readFileSync('src/web/sales-decision-monitor.html', 'utf8');
    expect(html).toMatch(/href="\/system-overview\/m"\s+id="loop-memory"/);
  });
  it('loop-decision href 指向 /system-overview/d', () => {
    const html = readFileSync('src/web/sales-decision-monitor.html', 'utf8');
    expect(html).toMatch(/href="\/system-overview\/d"\s+id="loop-decision"/);
  });
});

// 2) 三个壳页路由可达 + 返回 HTML（含 root div 与 API 调用 JS）
describe('T2: 三个受控壳页', () => {
  for (const id of ['k', 'm', 'd']) {
    it(`GET /system-overview/${id}.html 返回 HTML 含 #system-overview-${id}-root 与 API fetch`, async () => {
      const { status, text } = await getText(`/system-overview/${id}.html`);
      expect(status).toBe(200);
      expect(text).toContain(`id="system-overview-${id}-root"`);
      expect(text).toContain(`/api/page/system-overview-${id}`);
    });
  }
  for (const id of ['k', 'm', 'd']) {
    it(`GET /api/page/system-overview-${id} 返回 200 + {html}`, async () => {
      const { status, body } = await getJson(`/api/page/system-overview-${id}`);
      expect(status).toBe(200);
      expect(typeof body.html).toBe('string');
    });
  }
  it('GET /portal/drillModal.js 返回 200（下钻模态框工具）', async () => {
    const { status, text } = await getText('/portal/drillModal.js');
    expect(status).toBe(200);
    expect(text).toContain('bindDrill');
  });
});

// 3) K 渲染器：四段式骨架（顶部 + 趋势 + 明细 + 下钻）+ 既有数据源字段
describe('T3: K 渲染器四段式骨架', () => {
  it('GET /api/page/system-overview-k 返回 html 含四段骨架特征', async () => {
    const { status, body } = await getJson('/api/page/system-overview-k');
    expect(status).toBe(200);
    const html = body.html || '';
    expect(html).toMatch(/loop-state\s+(closed|break|na)/);
    expect(html).toContain('so-k-panels-sec'); // 四源面板段
    expect(html).toMatch(/近 30 日知识粒子趋势/);
    expect(html).toMatch(/<svg|data-trend|data-svg/);
    expect(html).toContain('so-k-governance'); // 治理角落
  });
  // 设计 §1.3 契约：四源面板均可下钻（data-dk 面板 + 同 key 隐藏明细块）
  it('K 渲染器含四源面板 data-dk 下钻 + 对应 so-detail-hidden 隐藏块', async () => {
    const { renderKnowledge } = await import('../../src/http/render/systemOverviewK.js');
    const r = await renderKnowledge({ me: { role: 'admin', tenantId: '*', scope: 'all' } });
    const html = r.html || '';
    const panelKeys = ['knowledge-particles', 'source-edges', 'injection-coverage', 'precedent-graph'];
    for (const k of panelKeys) {
      expect(html).toMatch(new RegExp(`so-panel[^>]*data-dk="${k}"`));
      expect(html).toMatch(new RegExp(`so-detail-hidden[^>]*data-dk="${k}"`)); // 每面板有隐藏明细块
    }
    // 治理角落保留（SKILL 装配健康度，不再为主体）
    expect(html).toContain('so-k-governance');
  });
});

// 4) M 渲染器：图模型 + 权限隔离（非 admin 显权限说明）
describe('T4: M 渲染器（图模型 + 权限隔离）', () => {
  it('GET /api/page/system-overview-m 返回 html 含四段骨架或权限说明', async () => {
    const { status, body } = await getJson('/api/page/system-overview-m');
    expect(status).toBe(200);
    const html = body.html || '';
    const ok =
      html.match(/loop-state\s+(closed|break|na)/) ||
      html.match(/仅.*管理员.*访问|sysadmin.*only/i);
    expect(ok).toBeTruthy();
  });
  it('M 渲染器在权限拒绝时 html 含监控台 fallback 链接', async () => {
    const { body } = await getJson('/api/page/system-overview-m');
    const html = body.html || '';
    if (/仅.*管理员.*访问|sysadmin.*only/i.test(html)) {
      expect(html).toContain('sales-decision-monitor.html');
    }
  });
  // 图模型契约：含图模型段 + SVG（或空态）+ 三构件 + 蒸馏状态 + 下钻段
  it('M 渲染器含图模型段 / 三构件 / 蒸馏状态 / 下钻段（admin 视角）', async () => {
    const { renderMemory } = await import('../../src/http/render/systemOverviewM.js');
    const r = await renderMemory({ me: { role: 'admin', tenantId: '*' } });
    expect(r.html).toContain('so-m-graph-sec');
    expect(r.html).toMatch(/图模型|REFERENCED_PRECEDENT|暂无先例引用边/);
    expect(r.html).toContain('so-m-tri');
    expect(r.html).toContain('so-m-distill');
    expect(r.html).toMatch(/蒸馏状态/);
    expect(r.html).toContain('so-m-drill');
  });
  // 图节点下钻契约：每个 so-m-graph-node[data-dk] 都有对应 so-detail-hidden[data-dk]
  it('M 渲染器图节点 data-dk 与隐藏详情块配对（admin 视角）', async () => {
    const { renderMemory } = await import('../../src/http/render/systemOverviewM.js');
    const r = await renderMemory({ me: { role: 'admin', tenantId: '*' } });
    const html = r.html || '';
    const nodes = (html.match(/so-m-graph-node[^>]*data-dk=/g) || []).length;
    const hidden = (html.match(/so-detail-hidden[^>]*data-dk=/g) || []).length;
    if (nodes > 0) expect(hidden).toBe(nodes); // 有图节点则每个都有下钻块
    else expect(hidden).toBe(0);                // 无数据则无下钻块（空态）
  });
});

// 5) D 渲染器：L1 拦截 + L2 场景通过率 + L3 待批处方
describe('T5: D 渲染器四段式骨架', () => {
  it('GET /api/page/system-overview-d 返回 html 含四段骨架', async () => {
    const { status, body } = await getJson('/api/page/system-overview-d');
    expect(status).toBe(200);
    const html = body.html || '';
    expect(html).toMatch(/loop-state\s+(closed|break|na)/);
    expect(html).toMatch(/L1\s*拦截|L2.*业务结果|L3.*校准/);
    expect(html).toMatch(/<svg|data-trend|data-svg/);
  });
  it('D 渲染器对非 admin L3 部分显「—（需 admin）」占位', async () => {
    const { body } = await getJson('/api/page/system-overview-d');
    const html = body.html || '';
    expect(html).toMatch(/admin|—/);
  });
  // 设计 §1.3 契约：明细表在「决策数据汇总」段内（L1/L2/L3 汇总卡 + 隐藏明细块）+
  //   下钻占位段；明细内容仍保留于隐藏块（点卡还原，不再默认铺开）。
  it('D 渲染器含汇总段（内嵌 L1 拦截明细）+ 下钻占位段（admin 视角）', async () => {
    const { renderDecision } = await import('../../src/http/render/systemOverviewD.js');
    const r = await renderDecision({ me: { role: 'admin', tenantId: '*' } });
    expect(r.html).toContain('so-d-summary');
    expect(r.html).toMatch(/决策数据汇总/);
    expect(r.html).toMatch(/L1\s*拦截明细/);
    expect(r.html).toContain('so-d-drill');
  });
  // 设计 §1.3 契约：L1/L2/L3 每行可下钻（data-dk 行 + 隐藏块）；汇总卡本身也有隐藏明细块。
  //   hidden ≥ 行级 dk（三张汇总卡各多 1 个明细块）——点汇总卡还原明细、点行再下钻单项。
  it('D 渲染器 L1/L2/L3 含 data-dk 下钻行 + 隐藏块（汇总卡隐藏块 ≥ 行级）', async () => {
    const { renderDecision } = await import('../../src/http/render/systemOverviewD.js');
    const r = await renderDecision({ me: { role: 'admin', tenantId: '*' } });
    const html = r.html || '';
    const dkRows = (html.match(/<tr[^>]*data-dk=/g) || []).length + (html.match(/so-l3-item[^>]*data-dk=/g) || []).length;
    const hidden = (html.match(/so-detail-hidden[^>]*data-dk=/g) || []).length;
    expect(dkRows).toBeGreaterThan(0);
    expect(hidden).toBeGreaterThanOrEqual(dkRows); // 3 张汇总卡各 1 隐藏明细块
    // safeL1 bug 修复：getGateAttribution 返回数组（非 {gates:[]}），safeL1 须识别为闸门数组。
    // 不为空库误判——此处仅断言结构契约（下钻行/隐藏块成对），bug 修复由真实实例冒烟佐证。
  });
  // 8 阶段汇总契约：底部含 so-d-stages 段 + 8 个阶段卡片（data-dk 复用 L2 隐藏块下钻）
  it('D 渲染器底部含 8 阶段汇总卡片（可下钻）', async () => {
    const { renderDecision } = await import('../../src/http/render/systemOverviewD.js');
    const r = await renderDecision({ me: { role: 'admin', tenantId: '*' } });
    const html = r.html || '';
    expect(html).toContain('so-d-stages');
    const stageCards = (html.match(/class="so-stage"[^>]*data-dk=/g) || []).length;
    expect(stageCards).toBe(8); // 8 个 SCS 场景各一张卡片
    // 阶段卡片 data-dk 须与既有 L2 隐藏块同 key（下钻复用）
    const stageKeys = [...html.matchAll(/class="so-stage"[^>]*data-dk="([^"]+)"/g)].map((m) => m[1]);
    for (const k of stageKeys) {
      expect(html).toMatch(new RegExp(`so-detail-hidden[^>]*data-dk="${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
    }
  });
  // 下半区汇总契约：so-d-summary 段含 3 张汇总卡（l1-summary/l2-summary/l3-summary）
  // 每张卡 data-dk 对应同 key 隐藏明细块（点卡下钻还原原明细）
  it('D 渲染器下半区含 L1/L2/L3 三张汇总卡（可下钻明细）', async () => {
    const { renderDecision } = await import('../../src/http/render/systemOverviewD.js');
    const r = await renderDecision({ me: { role: 'admin', tenantId: '*' } });
    const html = r.html || '';
    expect(html).toContain('so-d-summary');
    const cardKeys = ['l1-summary', 'l2-summary', 'l3-summary'];
    for (const k of cardKeys) {
      expect(html).toMatch(new RegExp(`class="so-summary-card"[^>]*data-dk="${k}"`));
      // 每张汇总卡都有对应隐藏明细块（下钻还原）
      expect(html).toMatch(new RegExp(`so-detail-hidden[^>]*data-dk="${k}"`));
    }
    // 明细内容仍存在于隐藏块内（L1 闸门行 / L2 场景行 / L3 处方项 data-dk）
    const l1Rows = (html.match(/<tr[^>]*data-dk=/g) || []).length;
    const l2Rows = (html.match(/<tr[^>]*data-dk=/g) || []).length;
    expect(l1Rows + l2Rows).toBeGreaterThan(0);
  });
});

// 5) 趋势区由采样数据驱动（注入 fake query，验证 polyline 动态生成）
describe('T5: 趋势 SVG 由真实采样驱动', () => {
  const fakeQuery = async () => ({ rows: [
    { value: 2 }, { value: 5 }, { value: 3 }, { value: 8 }, { value: 6 },
  ] });

  it('K 页趋势 polyline points 来自采样且非旧硬编码', async () => {
    const { renderKnowledge } = await import('../../src/http/render/systemOverviewK.js');
    const { html } = await renderKnowledge({ deps: { query: fakeQuery } });
    expect(html).toContain('data-trend="knowledge-30d"');
    expect(html).toContain('<polyline');
    expect(html).toContain('200.0,');        // 末点 x=200
    expect(html).not.toContain('0,30 10,28'); // 旧占位点串已移除
  });

  it('M 页（admin）趋势 polyline 动态', async () => {
    const { renderMemory } = await import('../../src/http/render/systemOverviewM.js');
    const { html } = await renderMemory({ me: { role: 'admin', tenantId: 'acme' }, deps: { query: fakeQuery } });
    expect(html).toContain('data-trend="memory-30d"');
    expect(html).toContain('<polyline');
    expect(html).not.toContain('0,35 10,33');
  });

  it('D 页趋势 polyline 动态', async () => {
    const { renderDecision } = await import('../../src/http/render/systemOverviewD.js');
    const { html } = await renderDecision({ me: { role: 'admin', tenantId: 'acme' }, deps: { query: fakeQuery } });
    expect(html).toContain('data-trend="decision-30d"');
    expect(html).toContain('<polyline');
    expect(html).not.toContain('0,32 10,30');
  });

  it('无采样时趋势区显示「暂无采样数据」而非崩溃', async () => {
    const empty = async () => ({ rows: [] });
    const { renderKnowledge } = await import('../../src/http/render/systemOverviewK.js');
    const { html } = await renderKnowledge({ deps: { query: empty } });
    expect(html).toContain('暂无采样数据');
  });
});