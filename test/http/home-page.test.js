// test/http/home-page.test.js — S02 AI 作战室首页经渲染器出片（Task 11 收尾）
// 设计输入：docs/2026-08-26-frontend-config-pages-master-plan.md Task 11
// 契约：GET /api/page/home → { schema:S02, data, html }；html 为 renderPage 产物（pg-page 唯一渲染出口）
// 对齐 workbench 注入式范式（createApp().fetch，真实 PG plm_test 自造种子）
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createApp } from '../../src/http/server.js';
import { query } from '../../src/db.js';
import { createParticle } from '../../src/particles/particleRepo.js';

let app;
beforeAll(() => { app = createApp(); });

beforeEach(async () => {
  await query('TRUNCATE crm.particles, crm.edges RESTART IDENTITY CASCADE');
  // 自造 DEAL 种子（测试库 plm_test 无 seed）：今日优先/L2C 数据面
  await createParticle('CRM_DEAL', { name: '测试商机', stage: 'lead', probability: 0.6 });
});

describe('S02 首页经渲染器出片（/api/page/home）', () => {
  it('返回 renderPage 产物（pg-page + goal-form + metric-card + table）', async () => {
    const res = await app.fetch('/api/page/home');
    expect(res.status).toBe(200);
    const j = await res.json();
    // 契约：schema = S02（type=dashboard，含 goal-form）
    expect(j.schema.type).toBe('dashboard');
    expect(j.schema.components.some(c => c.kind === 'goal-form')).toBe(true);
    // 契约：html 为 renderPage 唯一出口（pg-page 顶层）
    expect(j.html).toContain('pg-page');
    expect(j.html).toContain('data-page-type="dashboard"');
    // 契约：组件齐备（goal-form 受控表单 + metric-card + table）
    expect(j.html).toContain('data-action');
    expect(j.html).toContain('pg-metric-card');
    expect(j.html).toContain('pg-table');
  });

  it('首页注入容器骨架（id=home-root，S02 即渲染于此）', async () => {
    const res = await app.fetch('/');
    const html = await res.text();
    expect(html).toContain('id="home-root"');
  });

  // T3（死信息活体化）：S02 reasoning-trace 注入真状态——handler 用 buildReasoningSteps 取代原样回传 schema steps
  it('S02 reasoning-trace 注入真状态（清空任务 → 三步 idle）', async () => {
    // 确定性准备：plm_test 的 tasks 可能残留（home-page beforeEach 只清 particles/edges），
    // 先清空 tasks 保证 hasTasks=false → 三步全 idle（不再是 schema 写死 ok/pending）
    await query('TRUNCATE crm.tasks RESTART IDENTITY CASCADE');
    const res = await app.fetch('/api/page/home');
    expect(res.status).toBe(200);
    const j = await res.json();
    const steps = j.data?.components?.['reasoning-trace']?.steps;
    expect(Array.isArray(steps)).toBe(true);
    expect(steps.length).toBe(3);
    expect(steps.map(s => s.status)).toEqual(['idle', 'idle', 'idle']);
    expect(steps.map(s => s.label)).toEqual(['意图解析', '上下文装配', '切入建议']);
    // 渲染层消费注入态
    expect(j.html).toContain('data-trace-step="idle"');
  });
});

// ── 2026-08-30 工作台重构：聚合管道/客户跟踪/销售行为三业务区（方案 A：扩展 S02 受控 schema）──
describe('S02 工作台业务作战面板（三区聚合）', () => {
  beforeEach(async () => {
    await createParticle('CRM_DEAL', { name: '聚合商机', stage: 'quoted', expected_amount: 120000, probability: 0.7 });
    await createParticle('CRM_ACCOUNT', { name: '指名客户甲', tier: '目标', owner: 'alice' });
  });

  it('聚合三区数据面齐全（kpi-strip×3 + pipeline 六段 + progress-card×4 + 指名客户表）', async () => {
    const res = await app.fetch('/api/page/home');
    expect(res.status).toBe(200);
    const j = await res.json();
    const c = j.data.components;
    // 管道 KPI 两联 + 客户 KPI 一联
    expect(Object.keys(c['kpi-strip'])).toEqual(expect.arrayContaining(['管道 KPI-A', '管道 KPI-B', '客户 KPI']));
    // L2C 六段管道（数量·金额·段间转化率）
    expect(Object.keys(c['pipeline'])).toContain('管道六段');
    expect(c['pipeline']['管道六段'].stages.length).toBe(6);
    expect(c['pipeline']['管道六段'].conversions.length).toBe(5);
    // 销售行为四张进度条（实际 vs 目标）
    expect(Object.keys(c['progress-card'])).toEqual(expect.arrayContaining(['今日拜访', '今日电话', '本周拜访客户', '本周新客户']));
    // 指名客户 Top N 表
    expect(Array.isArray(c['table']['指名客户 Top N'].rows)).toBe(true);
    // 渲染层出现新区块（collapse + pg-pipeline + pg-progress-card + pg-kpi-strip）
    expect(j.html).toContain('pg-collapse');
    expect(j.html).toContain('pg-pipeline');
    expect(j.html).toContain('pg-progress-card');
    expect(j.html).toContain('pg-kpi-strip');
  });

  it('销售角色金额掩码：管道总额隐藏 + 六段金额全锁（sales=alice）', async () => {
    const login = await app.fetch('/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'secret123' }),
    });
    expect(login.status).toBe(200);
    const { token } = await login.json();
    const res = await app.fetch('/api/page/home', { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const c = (await res.json()).data.components;
    const total = c['kpi-strip']['管道 KPI-A'].items.find(i => i.label === '管道总额');
    expect(total.state).toBe('hidden');
    expect(c['pipeline']['管道六段'].permHiddenStages.length).toBe(6);
    // 历史 L2C 管线表金额列也同步掩码
    expect(c['table']['L2C 管线'].rows.some(r => r.amount === '🔒')).toBe(true);
  });

  it('非销售角色不掩码（无 token=guest → 管道总额可见、六段不锁）', async () => {
    const res = await app.fetch('/api/page/home');
    expect(res.status).toBe(200);
    const c = (await res.json()).data.components;
    const total = c['kpi-strip']['管道 KPI-A'].items.find(i => i.label === '管道总额');
    expect(total.state).not.toBe('hidden');
    expect(c['pipeline']['管道六段'].permHiddenStages.length).toBe(0);
  });
});