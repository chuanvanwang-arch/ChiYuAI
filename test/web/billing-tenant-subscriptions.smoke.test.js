// DB-free 冒烟：租户订阅全景端点 + 管理台页面列头
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { createBillingRouter } from '../../src/http/billingRoutes.js';

const html = readFileSync('src/web/admin-billing-console.html', 'utf8');
const routes = () => {
  const r = createBillingRouter();
  const out = [];
  r.stack.forEach((layer) => {
    if (layer.route) {
      Object.keys(layer.route.methods).forEach((m) => out.push(`${m.toUpperCase()} ${layer.route.path}`));
    }
  });
  return out.join('\n');
};

describe('billing tenant subscriptions smoke', () => {
  it('S1 管理台调用新端点 /api/billing/tenant-subscriptions', () => {
    expect(html).toContain('/api/billing/tenant-subscriptions');
  });
  it('S2 页面表格包含推荐人、当前套餐、到期日列头', () => {
    expect(html).toContain('<th>推荐人</th>');
    expect(html).toContain('<th>当前套餐</th>');
    expect(html).toContain('<th>到期日</th>');
    expect(html).toContain('<th>租户</th>');
  });
  it('S3 billingRoutes 注册了 GET /api/billing/tenant-subscriptions', () => {
    expect(routes()).toContain('GET /api/billing/tenant-subscriptions');
  });
});
