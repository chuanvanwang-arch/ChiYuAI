// test/web/billing.smoke.test.js — 费用页面存在性 + 关键节点冒烟
import { readFileSync } from 'fs';
import { describe, test, expect } from 'vitest';

const html = readFileSync('src/web/billing.html', 'utf8');
const consoleHtml = readFileSync('src/web/admin-billing-console.html', 'utf8');

describe('billing.html 结构', () => {
  test('含关键节点 id', () => {
    expect(html).toContain('id="tier-cards"');
    expect(html).toContain('id="overview"');
    expect(html).toContain('id="statement-table"');
    expect(html).toContain('id="reconcile"');
    expect(html).toContain('id="pay-modal"');
  });
  test('引入 portal 辅助模块', () => {
    expect(html).toContain("'/portal/layout.js'");
    expect(html).toContain("'/portal/api.js'");
    expect(html).toContain("'/portal/util.js'");
    expect(html).toContain("'/portal/tenantScopeBar.js'");
  });
  test('挂载计费路由端点', () => {
    expect(html).toContain('/api/billing/summary');
    expect(html).toContain('/api/billing/pay');
    expect(html).toContain('/api/billing/reconcile');
    expect(html).toContain('/api/billing/export');
  });
  test('含订阅/实时费用/模块用量/升级节点', () => {
    expect(html).toContain('id="sub-card"');       // 订阅高亮区
    expect(html).toContain('id="live-cost"');      // 实时费用卡
    expect(html).toContain('id="module-usage"');   // 模块用量区
    expect(html).toContain('id="upgrade-modal"');  // 一键升级弹窗
    expect(html).toContain('id="renew-cta"');      // 续费 CTA
    expect(html).toContain('id="sub-seat"');       // 席位余量展示（自助侧）
  });
  test('三 Tab 信息架构（避免单页堆叠）', () => {
    expect(html).toContain('data-tab="overview"');
    expect(html).toContain('data-tab="usage"');
    expect(html).toContain('data-tab="billing"');
    expect(html).toContain('id="pane-overview"');
    expect(html).toContain('id="pane-usage"');
    expect(html).toContain('id="pane-billing"');
  });
});

describe('admin-billing-console.html 结构', () => {
  test('存在且含套餐维护', () => {
    expect(consoleHtml).toContain('套餐维护');
  });
  test('含订阅全景与配置节点', () => {
    expect(consoleHtml).toContain('id="plan-table"');
    expect(consoleHtml).toContain('id="subs-table"');
    expect(consoleHtml).toContain('id="settings-edit"');
  });
  test('三 Tab + 订阅开通日期/余量展开', () => {
    expect(consoleHtml).toContain('data-tab="plans"');     // 定义套餐后台入口
    expect(consoleHtml).toContain('data-tab="subs"');      // 查询各租户套餐
    expect(consoleHtml).toContain('data-tab="settings"');   // 计费设置
    expect(consoleHtml).toContain('toggleSubDetail');       // 行展开 Token 余量
    expect(consoleHtml).toContain('开通日期');              // 开通日期列
  });
  test('租户订阅 Tab 含席位余量列 + 实时费用合计列 + 行展开', () => {
    expect(consoleHtml).toContain('席位(已用/额度/余)');    // 席位余量列
    expect(consoleHtml).toContain('实时费用合计');          // 列表级实时费用合计列
    // 实时费用数据源（2026-09-06 修正）：实现已从「逐行调 /api/billing/live-cost」演进为
    //   /api/billing/tenant-subscriptions 一次性下发 live_cost / quota（避免 N+1 请求），
    //   断言改为校验真实实现（消费 r.live_cost），而非死守已被取代的端点字面量。
    expect(consoleHtml).toContain('live_cost');
    expect(consoleHtml).toContain('实时费用合计：');        // 行展开实时费用区块（含冒号区分）
  });
});
