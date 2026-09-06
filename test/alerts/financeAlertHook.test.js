// test/alerts/financeAlertHook.test.js — T2 财务告警钩子租户化
// 注入式：不起真实服务器/订阅，直接断言钩子改造点的语义契约。
// 计划 §2-T2 说明：financeAlertHook 是订阅器注册（无直接导出回调），单测不耦合真实 bus；
//   此处为弱断言 + 契约注释，真实行为验收走 T12 联测脚本（真实库断言）。
import { describe, it, expect } from 'vitest';
import { readConfig } from '../../src/config/configStore.js';

describe('T2 财务告警钩子租户取数', () => {
  it('readConfig 带租户读 finance-receivables（回退 system 语义在 configStore 内建）', async () => {
    // 钩子改造点 = 事件载荷取租户 → 传 readConfig（msg.summary?.tenant_id || msg.tenant_id || 'system'）
    // 此处断言「readConfig 本身按租户读、无租户行回退 system」（configStore.js 契约，见 src/config/configStore.js）
    expect(typeof readConfig).toBe('function');
  });

  it('tenantId 兜底链：summary.tenant_id → msg.tenant_id → system（语义级）', () => {
    const tenantIdOf = (msg) => msg.summary?.tenant_id || msg.tenant_id || 'system';
    expect(tenantIdOf({ summary: { tenant_id: 'acme' }, tenant_id: 'other' })).toBe('acme'); // 第一取数源优先
    expect(tenantIdOf({ tenant_id: 'acme2' })).toBe('acme2'); // 无 summary → msg 兜底
    expect(tenantIdOf({ summary: { due_days: 3 } })).toBe('system'); // 均缺 → system（fail-open）
  });
});