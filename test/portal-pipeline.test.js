// test/portal-pipeline.test.js — 销售管道页 + 前台互通（P1 数据契约 / P2 pipeline / P3 nav.js）
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createApp } from '../src/http/server.js';
import { query } from '../src/db.js';
import { createParticle } from '../src/particles/particleRepo.js';

let app;
beforeAll(() => { app = createApp(); });

beforeEach(async () => {
  await query('TRUNCATE crm.particles, crm.edges RESTART IDENTITY CASCADE');
  // 自造 DEAL 种子（测试库 plm_test 无 seed，测试数据自备——对齐 age-sync.test.js:8-11 范式）
  await createParticle('CRM_DEAL', { name: '测试商机', stage: 'lead' });
});

describe('数据契约修正', () => {
  it('/api/business/board 聚合含 CRM_DEAL 键', async () => {
    const res = await app.fetch('/api/business/board');
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.grouped).toHaveProperty('CRM_DEAL');
    expect((j.grouped.CRM_DEAL || []).length).toBe(1);
  });
});

describe('销售管道页 /pipeline.html', () => {
  it('GET /pipeline.html 返回管道页含「销售管道」与六段结构锚点', async () => {
    const res = await app.fetch('/pipeline.html');
    const html = await res.text();
    expect(res.status).toBe(200);
    // 方案 A（2026-08-29 并行重构）：六段阶段由 scoring.js pipelineStages 动态渲染（pg-stage 单元），
    // 静态 HTML 不再含字面「线索/商机/回款」；契约锚点改为标题 + L2C 容器（六段结构渲染位）。
    expect(html).toContain('销售管道');
    expect(html).toContain('l2cPipeline');
  });
  it('GET /pipeline 重定向到 /pipeline.html', async () => {
    const res = await app.fetch('/pipeline');
    expect([301, 302]).toContain(res.status);
  });
});

describe('导航收敛（G6：nav.js 已由 layout.js 取代并删除）', () => {
  it('GET /portal/nav.js 已下线（404，layout.js 取代）', async () => {
    const res = await app.fetch('/portal/nav.js');
    expect(res.status).toBe(404);
  });
  it('首页通过 layout.js 注入左侧导航（/portal/layout.js 引用）', async () => {
    const res = await app.fetch('/');
    const html = await res.text();
    expect(html).toContain('/portal/layout.js');
  });
  it('导航菜单单源 layoutMenu.js 指向 /pipeline.html', async () => {
    const { FULL_MENU } = await import('../src/portal/layoutMenu.js');
    expect(FULL_MENU.some((m) => m.href === '/pipeline.html')).toBe(true);
  });
});