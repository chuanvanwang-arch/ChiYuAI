import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const billing = readFileSync('src/web/billing.html', 'utf8');
const routes = readFileSync('src/http/billingRoutes.js', 'utf8');

describe('billing 国内支付前端与路由冒烟（DB-free）', () => {
  it('billing.html 含支付方式选择 + 二维码弹窗 + 模拟确认 + simulate 接口', () => {
    expect(billing).toContain('upgrade-provider');
    expect(billing).toContain('qr-modal');
    expect(billing).toContain('sim-modal');
    expect(billing).toContain('subscribe/simulate-confirm');
  });

  it('billingRoutes 接入国内网关（wechat/alipay notify + simulate-confirm，stripe 休眠）', () => {
    expect(routes).toContain('/api/billing/wechat/notify');
    expect(routes).toContain('/api/billing/alipay/notify');
    expect(routes).toContain('/api/billing/subscribe/simulate-confirm');
    // 默认走 domesticGateway，stripe 仅 enabled 时
    expect(routes).toContain('domesticGateway.js');
    expect(routes).toContain("'stripe disabled'");
  });
});
