// test/http/finance-receivables-config.test.js — S05 T5 应收配置后台化（TDD：先失败后实现）
// 验证：GET /api/config/finance-receivables 返回三项缺省；PUT 持久化 payment_overdue_days；非 sysadmin 403
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createApp } from '../../src/http/server.js';
import { issueToken } from '../../src/http/auth.js';
import { query } from '../../src/db.js';

let app;
beforeAll(() => { app = createApp(); });

// 测试隔离：每个用例前清掉 config_store 行（防 PUT 持久化泄漏到 GET 缺省断言）
beforeEach(async () => {
  await query(`DELETE FROM crm.config_store WHERE key='finance-receivables'`).catch(() => {});
});

const adminToken = issueToken({ username: 'admin-demo', role: 'admin', display_name: '管理演示' });
const salesToken = issueToken({ username: 'sales-demo', role: 'sales', display_name: '销售演示' });
const auth = (t) => ({ headers: { Authorization: `Bearer ${t}` } });
const json = async (res) => { const t = await res.text(); try { return JSON.parse(t); } catch { return {}; } };

describe('GET/PUT /api/config/finance-receivables（S05 T5）', () => {
  it('GET 返回缺省三项（逾期天数/差额阈值/账龄分档）', async () => {
    const res = await app.fetch('/api/config/finance-receivables', auth(adminToken));
    expect(res.status).toBe(200);
    const b = await json(res);
    expect(b.payment_overdue_days).toBe(7);
    expect(b.gap_threshold_pct).toBe(5);
    expect(Array.isArray(b.aging_buckets)).toBe(true);
  });

  it('非 sysadmin 角色返回 403', async () => {
    const res = await app.fetch('/api/config/finance-receivables', auth(salesToken));
    expect(res.status).toBe(403);
  });

  it('PUT 改 payment_overdue_days 持久化后 GET 读到新值', async () => {
    const put = await app.fetch('/api/config/finance-receivables', {
      ...auth(adminToken),
      method: 'PUT',
      headers: { ...auth(adminToken).headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ payment_overdue_days: 3 }),
    });
    expect(put.status).toBe(200);
    const g = await app.fetch('/api/config/finance-receivables', auth(adminToken));
    expect((await json(g)).payment_overdue_days).toBe(3);
  });
});