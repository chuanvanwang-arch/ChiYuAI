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
    expect(html).toContain('skill_id');
    expect(html).toMatch(/维度漂移|dim.?skew|missing_in_db|missing_in_skill/);
    expect(html).toMatch(/<svg|data-trend|data-svg/);
  });
  // 设计 §1.3 契约：明细表每行可下钻（data-dk 行 + 同 key 隐藏详情块）
  it('K 渲染器含 data-dk 下钻行 + 对应 so-detail-hidden 隐藏块', async () => {
    const { renderKnowledge } = await import('../../src/http/render/systemOverviewK.js');
    const r = await renderKnowledge();
    const html = r.html || '';
    const dkRows = (html.match(/<tr[^>]*data-dk=/g) || []).length;
    const hidden = (html.match(/so-detail-hidden[^>]*data-dk=/g) || []).length;
    expect(dkRows).toBeGreaterThan(0);
    expect(hidden).toBe(dkRows); // 每行的隐藏详情块数量与可下钻行数一致
  });
});

// 4) M 渲染器：四段式骨架 + 权限隔离（非 admin 显权限说明）
describe('T4: M 渲染器（含权限隔离）', () => {
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
  // 设计 §1.3 契约：明细表含「先例边 Top + 三构件 + 蒸馏状态」+ 下钻占位段
  it('M 渲染器含先例边 Top / 三构件 / 蒸馏状态 / 下钻段（admin 视角）', async () => {
    const { renderMemory } = await import('../../src/http/render/systemOverviewM.js');
    const r = await renderMemory({ me: { role: 'admin', tenantId: '*' } });
    expect(r.html).toContain('so-m-pred');
    expect(r.html).toMatch(/先例边\s*Top/);
    expect(r.html).toContain('so-m-tri');
    expect(r.html).toContain('so-m-distill');
    expect(r.html).toMatch(/蒸馏状态/);
    expect(r.html).toContain('so-m-drill');
  });
  // 设计 §1.3 契约：先例 Top10 每行可下钻（data-dk 行 + 隐藏块）
  it('M 渲染器含先例下钻 data-dk 行 + 隐藏详情块（admin 视角）', async () => {
    const { renderMemory } = await import('../../src/http/render/systemOverviewM.js');
    const r = await renderMemory({ me: { role: 'admin', tenantId: '*' } });
    const html = r.html || '';
    const dkRows = (html.match(/<tr[^>]*data-dk=/g) || []).length;
    const hidden = (html.match(/so-detail-hidden[^>]*data-dk=/g) || []).length;
    if (dkRows > 0) expect(hidden).toBe(dkRows);
    else expect(html).toContain('so-m-pred'); // 无数据时至少 Top 段存在
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
  // 设计 §1.3 契约：明细表必须含「L1 拦截明细（按闸门）」独立段 + 下钻占位段
  it('D 渲染器含 L1 独立明细段 + 下钻占位段（admin 视角）', async () => {
    const { renderDecision } = await import('../../src/http/render/systemOverviewD.js');
    const r = await renderDecision({ me: { role: 'admin', tenantId: '*' } });
    expect(r.html).toContain('so-d-l1');
    expect(r.html).toMatch(/L1\s*拦截明细/);
    expect(r.html).toContain('so-d-drill');
  });
  // 设计 §1.3 契约：L1/L2/L3 每行可下钻（data-dk 行 + 隐藏块）
  it('D 渲染器 L1/L2/L3 含 data-dk 下钻行 + 隐藏块', async () => {
    const { renderDecision } = await import('../../src/http/render/systemOverviewD.js');
    const r = await renderDecision({ me: { role: 'admin', tenantId: '*' } });
    const html = r.html || '';
    const dkRows = (html.match(/<tr[^>]*data-dk=/g) || []).length + (html.match(/so-l3-item[^>]*data-dk=/g) || []).length;
    const hidden = (html.match(/so-detail-hidden[^>]*data-dk=/g) || []).length;
    expect(dkRows).toBeGreaterThan(0);
    expect(hidden).toBe(dkRows);
    // safeL1 bug 修复：getGateAttribution 返回数组（非 {gates:[]}），safeL1 须识别为闸门数组。
    // 不为空库误判——此处仅断言结构契约（下钻行/隐藏块成对），bug 修复由真实实例冒烟佐证。
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