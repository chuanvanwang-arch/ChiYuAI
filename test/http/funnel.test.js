// test/http/funnel.test.js — T8 漏斗质量端点 + 看板（红灯先行）
// 依据：docs/2026-08-30-sales-p0-p1-test-plan.md §6 T8-C1~C4
//       docs/2026-08-30-sales-p0-p1-taoran-bantcc-swas-funnel-design.md §5.3
import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../../src/http/server.js';
import { issueToken } from '../../src/http/auth.js';
import { query } from '../../src/db.js';
import { createParticle } from '../../src/particles/particleRepo.js';

let app;
beforeEach(() => { app = createApp(); });

beforeEach(async () => {
  await query('TRUNCATE crm.particles, crm.edges RESTART IDENTITY CASCADE');
  // 种子：A（alice，M 缺 → 机会-，优势，基线 100，承诺 100/85）；B（bob，won，确保）
  await createParticle('CRM_DEAL', {
    name: '商机A', owner_id: 'alice', stage: 'opportunity', expected_amount: 100,
    funnel: { mant: { m: { ok: false }, a: { ok: true }, n: { ok: true }, t: { ok: true } }, forecast_class: '优势', baseline_amount: 100, committed: { amount: 100, actual: 85 } },
  });
  await createParticle('CRM_DEAL', {
    name: '商机B', owner_id: 'bob', stage: 'paid', expected_amount: 50,
    funnel: { mant: { m: { ok: true }, a: { ok: true }, n: { ok: true }, t: { ok: true } }, forecast_class: '确保' },
  });
});

const adminToken = issueToken({ username: 'admin-demo', role: 'admin', display_name: '管理演示' });
const auth = (t) => ({ headers: { Authorization: `Bearer ${t}` } });
const json = async (res) => { const t = await res.text(); try { return JSON.parse(t); } catch { return {}; } };

describe('GET /api/funnel/quality', () => {
  it('【T8-C1】未登录 → 401', async () => {
    const res = await app.fetch('/api/funnel/quality');
    expect(res.status).toBe(401);
  });

  it('【T8-C2】返回健康度：真实性(authenticity)+健康性(health)+加权+抖动+承诺', async () => {
    const res = await app.fetch('/api/funnel/quality?annualTarget=100', auth(adminToken));
    expect(res.status).toBe(200);
    const b = await json(res);
    // 真实性：A 缺 M → authenticity 至少 1 条
    expect(Array.isArray(b.authenticity)).toBe(true);
    expect(b.authenticity.length).toBeGreaterThanOrEqual(1);
    expect(b.authenticity[0].missing).toContain('m');
    // 健康性：销售潜力可算
    expect(typeof b.health.salesPotential).toBe('number');
    // 加权总额：A 优势 0.6×100=60 + B 确保 0.9×50=45 = 105
    expect(b.weightedTotal).toBe(105);
    // 区域分布：A 机会- / B 漏斗内
    expect(b.zones['机会-']).toBe(1);
    expect(b.zones['漏斗内']).toBe(1);
    // 承诺兑现：A 100/85 → yellow
    expect(b.commit.some((c) => c.level === 'yellow')).toBe(true);
    // 抖动率：基线 100，无 lost → moved 0 → rate 0（非 null）
    expect(b.jitter).not.toBeNull();
    expect(b.jitter.rate).toBe(0);
  });

  it('【T8-C3】?owner=alice 仅返回 alice 名下商机', async () => {
    const res = await app.fetch('/api/funnel/quality?owner=alice', auth(adminToken));
    const b = await json(res);
    expect(b.total).toBe(1);
    expect(b.zones['机会-']).toBe(1);
    expect(b.authenticity.length).toBe(1);
  });
});

describe('GET /api/funnel/deals', () => {
  it('按 zone 过滤（漏斗内）', async () => {
    const res = await app.fetch('/api/funnel/deals?zone=' + encodeURIComponent('漏斗内'), auth(adminToken));
    const b = await json(res);
    expect(b.deals.length).toBe(1);
    expect(b.deals[0].weighted).toBe(45);
    expect(b.deals[0].zone).toBe('漏斗内');
  });
});

describe('【T8-C4】漏斗质量看板页 UI 合规', () => {
  it('复用 .page-head + 受控注入容器，不另造样式', async () => {
    const res = await app.fetch('/funnel-quality.html');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('class="page-head"');
    // 2026-08-31 架构演进（S36 受控化，funnel-design §5.3「受控渲染，不写自由 HTML」）：
    //   页面改为容器页——卡片/表格/KPI 全部由 renderPage(S36) 产物运行时注入（page.css 提供 .card 等外壳），
    //   静态 HTML 不再自带 .card（旧断言已过时）。合规语义 = 零自造样式 + 受控容器 + 引受控样式。
    expect(html).toContain('id="funnel-root"');   // 受控出片注入容器
    expect(html).toContain('/portal/page.css');   // 受控渲染样式（与 S02/S15 同口径）
    expect(html).not.toContain('<style>');        // 零自造样式块（UI 一致性铁律）
  });
});
