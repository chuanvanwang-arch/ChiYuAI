// test/http/funnel-page.test.js — S36 漏斗质量看板经渲染器受控出片（方案 A：受控页签补建）
// 设计输入：docs/2026-08-30-sales-p0-p1-taoran-bantcc-swas-funnel-design.md §5.3
//   「新增 src/pages/S36.schema.js（漏斗质量看板）+ src/http/funnelRouter.js；受控渲染，不写自由 HTML」
// 契约：GET /api/page/funnel-quality → { schema:S36, data, html }；html 为 renderPage 产物（pg-page 顶层）
// 数据面：/api/funnel/quality（真实性 MANT 缺失 + 健康性销售潜力 + 加权 + 抖动 + 承诺）
//        /api/funnel/deals（按区域/预测分类列商机）
// 铁律：受控渲染唯一出口（禁自由 HTML）；UI 零硬编码色值（颜色 100% 走 tokens.css）
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createApp } from '../../src/http/server.js';
import { query } from '../../src/db.js';
import { createParticle } from '../../src/particles/particleRepo.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let app;
beforeAll(() => { app = createApp(); });

beforeEach(async () => {
  await query('TRUNCATE crm.particles, crm.edges RESTART IDENTITY CASCADE');
  // 自造 DEAL 种子（测试库无 seed）：MANT 全齐一条 + 缺 M 一条（驱动 authenticity 缺失清单）
  await createParticle('CRM_DEAL', {
    name: '漏斗商机A', stage: 'quoted', expected_amount: 100000, probability: 0.6,
    owner_id: 'alice',
    funnel: { m: 'q3预算', a: 'vp审批', n: '已验证痛点', t: 'Q3签', committed: { amount: 100000, actual: 80000 }, baseline_amount: 100000 },
  });
  await createParticle('CRM_DEAL', {
    name: '漏斗商机B', stage: 'lead', expected_amount: 50000, probability: 0.3,
    owner_id: 'alice', funnel: { baseline_amount: 50000 },
  });
});

describe('S36 漏斗质量看板受控出片（/api/page/funnel-quality）', () => {
  it('返回 renderPage 产物（pg-page 顶层 + 受控 schema 合法）', async () => {
    const res = await app.fetch('/api/page/funnel-quality');
    expect(res.status).toBe(200);
    const j = await res.json();
    // 契约：schema 经 validatePageSchema（非法会在模块加载即抛，此处校验关键字段）
    expect(j.schema.type).toBe('dashboard');
    expect(j.schema.navigation.to).toBe('/funnel-quality');
    // 契约：html 为 renderPage 唯一出口（pg-page 顶层，非自由 HTML）
    expect(j.html).toContain('pg-page');
    expect(j.html).toContain('data-page-type="dashboard"');
  });

  it('数据面四区齐全（健康性 KPI + 真实性缺失清单 + 商机明细表 + 预测分类）', async () => {
    const res = await app.fetch('/api/page/funnel-quality');
    const c = (await res.json()).data.components;
    // 健康性：销售潜力 / 年度目标 / 已回款 / 加权额
    expect(Object.keys(c['kpi-strip'] || {})).toEqual(expect.arrayContaining(['漏斗健康性']));
    expect(c['kpi-strip']['漏斗健康性'].items.length).toBeGreaterThanOrEqual(3);
    // 真实性：MANT 缺失清单（商机 B 缺 M/A/N/T）
    expect(Array.isArray(c['table']['MANT 缺失清单'].rows)).toBe(true);
    expect(c['table']['MANT 缺失清单'].rows.length).toBeGreaterThanOrEqual(1);
    // 商机明细（按区域/预测分类）
    expect(Array.isArray(c['table']['商机明细'].rows)).toBe(true);
    expect(c['table']['商机明细'].rows.length).toBe(2);
    // 渲染层出现受控区块（kpi-strip + table）
    expect((await res.json()).html).toContain('pg-kpi-strip');
    expect((await res.json()).html).toContain('pg-table');
  });

  it('前端页不再自由直连 API（改为消费受控出片，禁 /api/funnel 直连）', () => {
    const html = readFileSync(path.join(__dirname, '../../src/web/funnel-quality.html'), 'utf8');
    // 受控化改造后：页面只经 /api/page/funnel-quality 出片渲染，不再直接 fetch /api/funnel/*
    expect(html).toContain('/api/page/funnel-quality');
    expect(html).not.toContain("'/api/funnel/quality'");
    expect(html).not.toContain('/api/funnel/deals');
  });

  it('UI 零硬编码色值（UI 铁律：颜色走 tokens.css 语义变量）', () => {
    const html = readFileSync(path.join(__dirname, '../../src/web/funnel-quality.html'), 'utf8');
    // 排除合法例外：深色底白字 #fff 与 tokens 定义文件自身
    const hexRe = /#[0-9a-fA-F]{3,8}\b/g;
    const hits = (html.match(hexRe) || []).filter((h) => !/^#f{3,8}$/i.test(h));
    expect(hits).toEqual([]);
    // 且页面链接受控渲染样式（/portal/page.css）
    expect(html).toContain('/portal/page.css');
  });
});
