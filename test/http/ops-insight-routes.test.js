import { describe, it, expect } from 'vitest';
import { createApp } from '../../src/http/server.js';
import { issueToken } from '../../src/http/auth.js';

const app = createApp();
const adminToken = issueToken({ role: 'admin', display_name: 't', username: 'tester' });
const AUTH = { Authorization: `Bearer ${adminToken}` };

describe('平台运营洞察聚合端点', () => {
  it('GET /api/monitor/agent-summary 返回聚合结构', async () => {
    const res = await app.fetch('/api/monitor/agent-summary?days=7', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('totals');
    expect(body).toHaveProperty('by_agent');
  });

  it('GET /api/monitor/decision-health 返回决策聚合', async () => {
    const res = await app.fetch('/api/monitor/decision-health?days=30', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('outcomes');
    expect(body).toHaveProperty('by_scenario');
  });

  it('GET /api/admin/param-diagnosis 返回诊断报告（含 red_lines）', async () => {
    const res = await app.fetch('/api/admin/param-diagnosis?days=7', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('patches');
    expect(Array.isArray(body.patches)).toBe(true);
    expect(body.red_lines).toContain('context-routing');
  });

  it('未鉴权 → 403', async () => {
    const res = await app.fetch('/api/monitor/agent-summary?days=7');
    expect(res.status).toBe(403);
  });
});
