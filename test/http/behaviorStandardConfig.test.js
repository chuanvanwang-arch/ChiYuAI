// test/http/behaviorStandardConfig.test.js — T21 behavior-standard-config ④⑤⑥ 实时接线（红灯先行）
// 依据：docs/2026-08-30-sales-3layer-behavior-design.md §2/§3（④读 metricDimensions；⑤⑥取真实实例）
// 契约：
//   GET /api/config/named-account-targets → mergedTargets + metricDimensions[{code,label}]（admin）
//   GET /api/board/named-accounts → rows[]（取首行做 ⑤达标/⑥档位 实例）
//   src/web/behavior-standard-config.html 含 ④/⑤/⑥ 实时区块容器
import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../../src/http/server.js';
import { issueToken } from '../../src/http/auth.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

let app;
beforeEach(() => { app = createApp(); });

const adminToken = issueToken({ username: 'admin-demo', role: 'admin', display_name: '管理演示' });
const salesToken = issueToken({ username: 'alice', role: 'sales', display_name: '销售' });
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const json = async (res) => { const t = await res.text(); try { return JSON.parse(t); } catch { return {}; } };

describe('GET /api/config/named-account-targets 含 ④ metricDimensions（T21）', () => {
  it('返回 mergedTargets 且附带 metricDimensions 可读标签数组', async () => {
    const res = await app.fetch('/api/config/named-account-targets', { headers: auth(adminToken) });
    expect(res.status).toBe(200);
    const b = await json(res);
    expect(Array.isArray(b.metrics)).toBe(true);
    expect(Array.isArray(b.metricDimensions)).toBe(true);
    expect(b.metricDimensions[0]).toHaveProperty('code');
    expect(b.metricDimensions[0]).toHaveProperty('label');
    expect(b.metricDimensions.length).toBeGreaterThan(0);
  });

  it('非 admin 拒绝（403）', async () => {
    const res = await app.fetch('/api/config/named-account-targets', { headers: auth(salesToken) });
    expect(res.status).toBe(403);
  });
});

describe('behavior-standard-config.html ④⑤⑥ 实时区块容器（T21）', () => {
  it('页面含 ④指标口径 / ⑤达标实例 / ⑥档位实例 容器', () => {
    const html = readFileSync(
      fileURLToPath(new URL('../../src/web/behavior-standard-config.html', import.meta.url)),
      'utf8',
    );
    expect(html).toContain('metric-dims');       // ④ 指标口径容器
    expect(html).toContain('pass-instances');     // ⑤ 达标判定实例容器
    expect(html).toContain('tier-instances');     // ⑥ 档位归属实例容器
  });
});
