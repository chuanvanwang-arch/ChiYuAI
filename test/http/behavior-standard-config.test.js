// test/http/behavior-standard-config.test.js — 销售行为标准配置后台化（id 31）
// 验证：GET 返回量化目标缺省 + 21 条标准清单；PUT 持久化（决策第0闸 + admin 闸）；非 admin 403
import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../../src/http/server.js';
import { issueToken } from '../../src/http/auth.js';
import { query } from '../../src/db.js';

let app;
beforeEach(() => { app = createApp(); });

// 测试隔离：每个用例前清掉 config_store 行（防 PUT 持久化泄漏到 GET 缺省断言）
beforeEach(async () => {
  await query(`DELETE FROM crm.config_store WHERE key='behavior-standard'`).catch(() => {});
});

const adminToken = issueToken({ username: 'admin-demo', role: 'admin', display_name: '管理演示' });
const salesToken = issueToken({ username: 'sales-demo', role: 'sales', display_name: '销售演示' });
const auth = (t) => ({ headers: { Authorization: `Bearer ${t}` } });
const json = async (res) => { const t = await res.text(); try { return JSON.parse(t); } catch { return {}; } };

describe('GET/PUT /api/config/behavior-standard（id 31）', () => {
  it('GET 返回量化目标缺省 + 21 条标准清单', async () => {
    const res = await app.fetch('/api/config/behavior-standard', auth(adminToken));
    expect(res.status).toBe(200);
    const b = await json(res);
    expect(b.daily_visit_count).toBe(2);
    expect(b.weekly_visit_customer).toBe(8);
    expect(b.weekly_new_customer).toBe(5);
    expect(b.daily_call_count).toBe(10);
    expect(Array.isArray(b.standards)).toBe(true);
    expect(b.standards.length).toBe(21);
  });

  it('非 admin 角色 PUT 返回 403', async () => {
    const res = await app.fetch('/api/config/behavior-standard', {
      ...auth(salesToken),
      method: 'PUT',
      headers: { ...auth(salesToken).headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ daily_visit_count: 3 }),
    });
    expect(res.status).toBe(403);
  });

  it('PUT 改 daily_visit_count 持久化后 GET 读到新值', async () => {
    const put = await app.fetch('/api/config/behavior-standard', {
      ...auth(adminToken),
      method: 'PUT',
      headers: { ...auth(adminToken).headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ daily_visit_count: 3 }),
    });
    expect(put.status).toBe(200);
    const g = await app.fetch('/api/config/behavior-standard', auth(adminToken));
    expect((await json(g)).daily_visit_count).toBe(3);
  });

  it('PUT 非法值（负数）返回 400', async () => {
    const put = await app.fetch('/api/config/behavior-standard', {
      ...auth(adminToken),
      method: 'PUT',
      headers: { ...auth(adminToken).headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ daily_visit_count: -1 }),
    });
    expect(put.status).toBe(400);
  });
});
