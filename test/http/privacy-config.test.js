// test/http/privacy-config.test.js — P1 隐私排除清单配置面（GET/PUT /api/config/sync-privacy）
// 设计：docs/2026-09-18-unified-integration-design-v2.md §8.1
// 验证：读缺省、角色闸、持久化往返、**形状坏掉必须报出来**（不是静默忽略）、丢弃计数可观测
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createApp } from '../../src/http/server.js';
import { issueToken } from '../../src/http/auth.js';
import { query } from '../../src/db.js';

let app;
beforeAll(() => { app = createApp(); });
beforeEach(async () => {
  // 测试隔离（仅测试库清理，非生产删除）：防上一用例的持久化污染缺省断言
  await query(`DELETE FROM crm.config_store WHERE key='sync-privacy'`).catch(() => {});
});

const adminToken = issueToken({ username: 'admin-demo', role: 'admin', display_name: '管理演示' });
const salesToken = issueToken({ username: 'sales-demo', role: 'sales', display_name: '销售演示' });
const auth = (t) => ({ headers: { Authorization: `Bearer ${t}` } });
const json = async (res) => { const t = await res.text(); try { return JSON.parse(t); } catch { return {}; } };
const put = (t, body) => app.fetch('/api/config/sync-privacy', {
  ...auth(t), method: 'PUT', headers: { ...auth(t).headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

describe('GET/PUT /api/config/sync-privacy（P1 · G7）', () => {
  it('GET 返回三类空规则 + config_ok（未配置 ≠ 配置坏了）', async () => {
    const res = await app.fetch('/api/config/sync-privacy', auth(adminToken));
    expect(res.status).toBe(200);
    const b = await json(res);
    expect(b.exclude_domains).toEqual([]);
    expect(b.exclude_addresses).toEqual([]);
    expect(b.exclude_keywords).toEqual([]);
    expect(b.config_ok).toBe(true);
    expect(b.can_write).toBe(true);
  });

  it('销售可读但不可写（can_write=false）——权限差异必须在响应里可见，不让用户点了才知道', async () => {
    const b = await json(await app.fetch('/api/config/sync-privacy', auth(salesToken)));
    expect(b.can_write).toBe(false);
  });

  it('销售 PUT → 403（租户级配置需管理员）', async () => {
    const res = await put(salesToken, { exclude_domains: ['x.com'] });
    expect(res.status).toBe(403);
  });

  it('管理员 PUT 后 GET 读到新规则（持久化往返）', async () => {
    const p = await put(adminToken, { exclude_domains: ['competitor.com'], exclude_keywords: ['验证码'] });
    expect(p.status).toBe(200);
    const b = await json(p);
    expect(b.exclude_domains).toEqual(['competitor.com']);
    expect(b.decision).toBeTruthy(); // 写无决策不落库
    const g = await json(await app.fetch('/api/config/sync-privacy', auth(adminToken)));
    expect(g.exclude_keywords).toEqual(['验证码']);
    expect(g.exclude_domains).toEqual(['competitor.com']);
    expect(g.config_ok).toBe(true);
  });

  it('局部更新：只传 keywords 不得抹掉已存的 domains', async () => {
    await put(adminToken, { exclude_domains: ['a.com'] });
    await put(adminToken, { exclude_keywords: ['k'] });
    const g = await json(await app.fetch('/api/config/sync-privacy', auth(adminToken)));
    expect(g.exclude_domains).toEqual(['a.com']);
    expect(g.exclude_keywords).toEqual(['k']);
  });

  it('非数组形状 → 400 且指出问题（不是静默截断）', async () => {
    const res = await put(adminToken, { exclude_domains: 'a.com' });
    expect(res.status).toBe(400);
    const b = await json(res);
    expect(String(b.error)).toContain('无可更新字段');
    expect(b.issues.join()).toContain('exclude_domains');
  });

  it('空 body → 400（不得把「什么都没传」当成「清空所有规则」）', async () => {
    const res = await put(adminToken, {});
    expect(res.status).toBe(400);
  });

  it('GET 带回丢弃计数通道（available 真值）——界面据此区分「拦下了 0 条」与「不知道」', async () => {
    const b = await json(await app.fetch('/api/config/sync-privacy', auth(adminToken)));
    expect(b.recent).toBeTruthy();
    expect(typeof b.recent.available).toBe('boolean');
    if (!b.recent.available) expect(b.recent.reason).toBeTruthy(); // 不可用必须带原因（不静默）
  });
});
