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
});