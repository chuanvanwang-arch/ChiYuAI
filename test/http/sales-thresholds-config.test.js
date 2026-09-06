// test/http/sales-thresholds-config.test.js — 判定阈值配置后台化（id 32）
// 原则验证：业务阈值走 config_store['sales-thresholds']，客户可按需调整；
//           SKILL 与代码中不保留写死数值（见 docs/2026-08-30-sales-thresholds-config-design.md）
import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../../src/http/server.js';
import { issueToken } from '../../src/http/auth.js';
import { query } from '../../src/db.js';

let app;
beforeEach(() => { app = createApp(); });

// 测试隔离：每个用例前清掉 config_store 行（防 PUT 持久化泄漏到 GET 缺省断言）
beforeEach(async () => {
  await query(`DELETE FROM crm.config_store WHERE key='sales-thresholds'`).catch(() => {});
});

const adminToken = issueToken({ username: 'admin-demo', role: 'admin', display_name: '管理演示' });
const salesToken = issueToken({ username: 'sales-demo', role: 'sales', display_name: '销售演示' });
const auth = (t) => ({ headers: { Authorization: `Bearer ${t}` } });
const json = async (res) => { const t = await res.text(); try { return JSON.parse(t); } catch { return {}; } };
const putAs = (token, body) => app.fetch('/api/config/sales-thresholds', {
  method: 'PUT',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

describe('GET/PUT /api/config/sales-thresholds（id 32）', () => {
  it('GET 返回 10 项阈值默认值 + 校验规则', async () => {
    const res = await app.fetch('/api/config/sales-thresholds', auth(adminToken));
    expect(res.status).toBe(200);
    const b = await json(res);
    expect(b.bantcc.pass).toBe(0.6);
    expect(b.bantcc.unknown).toBe(0.5);
    expect(b.behavior.min_customer_types).toBe(2);
    expect(b.behavior.min_contacts).toBe(2);
    expect(b.behavior.recent_visit_days).toBe(7);
    expect(b.rhythm.adherence_window_days).toBe(30);
    expect(b.stage.stuck_days).toBe(30);
    expect(b.gate.s1_s2_min_need_facts).toBe(2);
    expect(b.ui.behavior_pass_rate_ok).toBe(80);
    expect(b.taoran.achieved_ratio).toBe(80);
    // 漏斗质量（P1-B）默认加权值：确保/优势/可能+/可能-
    expect(b.funnel.weighted.win).toBe(0.9);
    expect(b.funnel.weighted.adv).toBe(0.6);
    expect(b.funnel.weighted.even).toBe(0.3);
    expect(b.funnel.weighted.weak).toBe(0);
    // SWAS 商机回顾（P1-A）默认阈值
    expect(b.swap === undefined).toBe(true); // 防护：确认无拼写错位的遗留键
    expect(b.swas.stale_days).toBe(30);
    expect(b.swas.soft_warn_below).toBe(0.5);
    // 覆盖频度/拜访数量（来自外部 SKILL to-b-sales-management 默认建议值）
    expect(b.coverage.target_month_days).toBe(30);
    expect(b.coverage.potential_quarter_days).toBe(90);
    expect(b.coverage.lost_contact_days).toBe(90);
    expect(b.coverage.daily_visits_target).toBe(3);
    expect(b.coverage.weekly_visits_target).toBe(15);
    expect(b.coverage.daily_visits_optimized).toBe(4);
    expect(b.coverage.info_collect_weekly).toBe(5);
    expect(b.coverage.customer_count_min).toBe(60);
    expect(b.coverage.customer_count_target).toBe(75);
    expect(b.coverage.named_visit_warn_days).toBe(1);  // 指名应访黄色提醒（Task7 新增键）
    expect(b.coverage.named_visit_alert_days).toBe(2); // 指名应访红色告警（Task7 新增键）
    // TAORAN 补充分档 + 漏斗健康/新增开标 + 承诺紫带（外部 SKILL 默认建议值）
    expect(b.taoran.unachieved_ratio).toBe(20);
    expect(b.funnel.health_min_ratio).toBe(1);
    expect(b.funnel.month_new_bid_ratio).toBe(0.35);
    expect(b.funnel.commit.purple_low).toBe(1.1);
    expect(b.rules['funnel.weighted.win']).toBeTruthy();
    expect(b.rules['funnel.annual_target']).toBeTruthy();
    expect(b.rules['swas.stale_days']).toBeTruthy();
    expect(b.rules['swas.soft_warn_below']).toBeTruthy();
    expect(b.rules['bantcc.pass']).toBeTruthy();
    expect(b.rules['coverage.daily_visits_target']).toBeTruthy();
    expect(b.rules['coverage.customer_count_target']).toBeTruthy();
    expect(b.rules['funnel.month_new_bid_ratio']).toBeTruthy();
    expect(b.rules['funnel.commit.purple_low']).toBeTruthy();
  });

  it('未登录 GET 返回 401', async () => {
    const res = await app.fetch('/api/config/sales-thresholds');
    expect(res.status).toBe(401);
  });

  it('非 admin 角色 PUT 返回 403', async () => {
    const res = await putAs(salesToken, { bantcc: { pass: 0.8 } });
    expect(res.status).toBe(403);
  });

  it('PUT 改 bantcc.pass 持久化后 GET 读到新值', async () => {
    const put = await putAs(adminToken, { bantcc: { pass: 0.8 } });
    expect(put.status).toBe(200);
    const b = await json(put);
    expect(b.changed).toContain('bantcc.pass');
    expect(b.decision).toBeTruthy(); // 决策第 0 闸凭证
    const g = await app.fetch('/api/config/sales-thresholds', auth(adminToken));
    const gb = await json(g);
    expect(gb.bantcc.pass).toBe(0.8);
    expect(gb.bantcc.unknown).toBe(0.5); // 未覆写项保留默认（深层合并）
  });

  it('PUT 越界（bantcc.pass=2）返回 400', async () => {
    const res = await putAs(adminToken, { bantcc: { pass: 2 } });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toContain('0~1');
  });

  it('PUT 未知字段被忽略（防注入任意配置）', async () => {
    const res = await putAs(adminToken, { evil_key: 123 });
    expect(res.status).toBe(400); // 无有效可更新字段
  });

  it('PUT 值未变化返回 400', async () => {
    await putAs(adminToken, { stage: { stuck_days: 45 } });
    const again = await putAs(adminToken, { stage: { stuck_days: 45 } });
    expect(again.status).toBe(400);
  });

  it('PUT 整数型字段传小数返回 400', async () => {
    const res = await putAs(adminToken, { stage: { stuck_days: 30.5 } });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toContain('整数');
  });

  it('PUT 改 swas 阈值持久化后 GET 读到新值', async () => {
    const put = await putAs(adminToken, { swas: { stale_days: 45, soft_warn_below: 0.4 } });
    expect(put.status).toBe(200);
    const b = await json(put);
    expect(b.changed).toContain('swas.stale_days');
    expect(b.changed).toContain('swas.soft_warn_below');
    const g = await app.fetch('/api/config/sales-thresholds', auth(adminToken));
    const gb = await json(g);
    expect(gb.swas.stale_days).toBe(45);
    expect(gb.swas.soft_warn_below).toBe(0.4);
  });

  it('PUT 改 coverage 拜访数量阈值持久化（外部 SKILL 建议值可调）', async () => {
    const put = await putAs(adminToken, { coverage: { daily_visits_target: 4, weekly_visits_target: 20, customer_count_target: 100 } });
    expect(put.status).toBe(200);
    const b = await json(put);
    expect(b.changed).toContain('coverage.daily_visits_target');
    expect(b.changed).toContain('coverage.weekly_visits_target');
    expect(b.changed).toContain('coverage.customer_count_target');
    const g = await app.fetch('/api/config/sales-thresholds', auth(adminToken));
    const gb = await json(g);
    expect(gb.coverage.daily_visits_target).toBe(4);
    expect(gb.coverage.weekly_visits_target).toBe(20);
    expect(gb.coverage.customer_count_target).toBe(100);
    // 未覆写项保留默认（深层合并）
    expect(gb.coverage.target_month_days).toBe(30);
    expect(gb.coverage.potential_quarter_days).toBe(90);
  });

  it('PUT 改 coverage.named_visit_warn_days / alert_days 持久化（指名应访阈值可调）', async () => {
    const put = await putAs(adminToken, { coverage: { named_visit_warn_days: 2, named_visit_alert_days: 3 } });
    expect(put.status).toBe(200);
    const b = await json(put);
    expect(b.changed).toContain('coverage.named_visit_warn_days');
    expect(b.changed).toContain('coverage.named_visit_alert_days');
    const g = await app.fetch('/api/config/sales-thresholds', auth(adminToken));
    const gb = await json(g);
    expect(gb.coverage.named_visit_warn_days).toBe(2);
    expect(gb.coverage.named_visit_alert_days).toBe(3);
  });

  it('PUT 改 funnel.health_min_ratio / month_new_bid_ratio / purple_low 持久化', async () => {
    const put = await putAs(adminToken, { funnel: { health_min_ratio: 0.95, month_new_bid_ratio: 0.3, commit: { purple_low: 1.2 } } });
    expect(put.status).toBe(200);
    const b = await json(put);
    expect(b.changed).toContain('funnel.health_min_ratio');
    expect(b.changed).toContain('funnel.month_new_bid_ratio');
    expect(b.changed).toContain('funnel.commit.purple_low');
    const g = await app.fetch('/api/config/sales-thresholds', auth(adminToken));
    const gb = await json(g);
    expect(gb.funnel.health_min_ratio).toBe(0.95);
    expect(gb.funnel.month_new_bid_ratio).toBe(0.3);
    expect(gb.funnel.commit.purple_low).toBe(1.2);
  });
});
