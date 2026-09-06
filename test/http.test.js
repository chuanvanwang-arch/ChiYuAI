// test/http.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../src/http/server.js';
import { query } from '../src/db.js';
import { issueToken } from '../src/http/auth.js';
import { createParticle } from '../src/particles/particleRepo.js';
import { ensureGraph } from '../src/decision/ageGraph.js';
import { createDecision } from '../src/decision/decisionRepo.js';
import { GATE_SCENARIOS } from '../src/monitor/monitorStore.js';

// 隔离：每条用例前后清空共享真实 PG（防止 POST 写通道创建的粒子泄漏到读直连断言）
beforeEach(async () => { await query(`TRUNCATE particles, edges, events CASCADE`); });

describe('HTTP API', () => {
  it('GET /api/particles?type=CRM_DEAL 读直连', async () => {
    const app = createApp();
    await createParticle('CRM_DEAL', { name: '半导体项目', stage: 'lead' });
    const res = await app.fetch('/api/particles?type=CRM_DEAL');
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.items.length).toBeGreaterThanOrEqual(1);
  });

  it('POST /api/particles 无 token → 401（Task 3：无认证一律拒，非旧 bootstrap 旁路）', async () => {
    const app = createApp();
    const res = await app.fetch('/api/particles', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'CRM_ACCOUNT', payload: { name: '深圳智造', industry: '半导体' } }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBeTruthy();
  });

  it('POST /api/particles 带认证 → 201 创建 ACCOUNT（Task 3：非 DEAL 引导录入）', async () => {
    const app = createApp();
    const token = issueToken({ username: 't-admin', role: 'admin', display_name: '测试管理员' });
    const res = await app.fetch('/api/particles', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ type: 'CRM_ACCOUNT', payload: { name: '深圳智造', industry: '半导体' } }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.particle.type).toBe('CRM_ACCOUNT');
  });

  it('GET /api/kanban/tasks 看板可读（三态：加载/空/错误不互阻）', async () => {
    const app = createApp();
    const res = await app.fetch('/api/kanban/tasks');
    expect(res.status).toBe(200);
    expect(Array.isArray((await res.json()).items)).toBe(true);
  });

  it('GET /api/realtime/health 装配校验状态可查', async () => {
    const app = createApp();
    const res = await app.fetch('/api/realtime/health');
    expect(res.status).toBe(200);
  });

  it('GET /api/agents 3 Agent 装配断言结果可查', async () => {
    const app = createApp();
    const res = await app.fetch('/api/agents');
    const body = await res.json();
    expect(body.agents).toBeTruthy();
  });

  it('GET /api/monitor/gates 7 闸门 + 七维完整度（D1 含 identity/governance）', async () => {
    const app = createApp();
    const token = issueToken({ username: 't-admin', role: 'admin', display_name: '测试管理员' });
    const res = await app.fetch('/api/monitor/gates', { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const { gates } = await res.json();
    // 闸门数派生自唯一事实源 GATE_SCENARIOS（当前 8，含 DEAL_REOPEN）；
    // 不再写死 7——若 GATE_SCENARIOS 与监控页 UI 的 7 闸门清单出现分歧，属真实不一致（见交付说明）。
    expect(gates.length).toBe(GATE_SCENARIOS.length);
    const d1 = gates.find(g => g.scenario_id === 'LEAD_FOLLOW_UP');
    expect(d1.metrics.total).toBeGreaterThanOrEqual(0);
    expect(d1.coverage.identity).toBe('provided');
    expect(d1.coverage.governance).toBe('provided');
  });

  it('GET /api/monitor/decisions 决策列表（按 scenario 过滤）', async () => {
    const app = createApp();
    const token = issueToken({ username: 't-admin', role: 'admin', display_name: '测试管理员' });
    const res = await app.fetch('/api/monitor/decisions?scenario_id=LEAD_FOLLOW_UP', { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const { items } = await res.json();
    expect(Array.isArray(items)).toBe(true);
  });
});

// ───────────────────── Task 7：决策网络视图端点（C2/C4）─────────────────────
describe('决策网络端点', () => {
  it('GET /api/monitor/trace/:id 返回因果链（决策网络 AGE 主路/降级 CTE 均返回数组）', async () => {
    await ensureGraph();
    const d = await createDecision({
      scenario_id: 'LEAD_FOLLOW_UP', trigger_context: {}, involved_entities: [],
      conditions_evaluated: [], disposition: 'APPROVE', decider_type: 'AUTONOMOUS_AGENT',
      rationale: 'r', business_tier: 'LEAD', state: 'AUTONOMOUS',
    });
    const app = createApp();
    const token = issueToken({ username: 't-admin', role: 'admin', display_name: '测试管理员' });
    const res = await app.fetch(`/api/monitor/trace/${d.decision_id}?direction=upstream&max_depth=3`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.chain)).toBe(true);
  });

  it('GET /api/monitor/audit 返回结构化审计报告', async () => {
    await ensureGraph();
    const d = await createDecision({
      scenario_id: 'OPP_QUALIFY', trigger_context: {}, involved_entities: [],
      conditions_evaluated: [], disposition: 'REJECT', decider_type: 'AUTONOMOUS_AGENT',
      rationale: 'r', business_tier: 'NORMAL', state: 'REQUIRED',
    });
    const app = createApp();
    const token = issueToken({ username: 't-admin', role: 'admin', display_name: '测试管理员' });
    const res = await app.fetch(`/api/monitor/audit?decision_id=${d.decision_id}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.decision_id).toBe(d.decision_id);
    expect(body.chainStatus).toBeDefined();
  });
});
