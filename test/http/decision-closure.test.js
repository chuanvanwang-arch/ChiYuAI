// test/http/decision-closure.test.js — T-D6 GET /api/decision/:id/closure（K/M/J + D1-D5）
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createApp } from '../../src/http/server.js';
import { queryWrite } from '../../src/db.js';
import { issueToken } from '../../src/http/auth.js';
import { createDecision } from '../../src/decision/decisionRepo.js';
import { writeOutcome } from '../../src/decision/outcome.js';
import { seedScenario, cleanupScenario, baseDecision } from '../decision/_helpers.js';

const app = createApp();
const token = issueToken({ role: 'admin', display_name: 't', username: 'tester' });
const AUTH = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const SCEN = 'CLOSURE_SCEN';

beforeEach(async () => { await seedScenario(SCEN); });
afterEach(async () => { await cleanupScenario(SCEN); });

describe('T-D6 GET /api/decision/:id/closure', () => {
  it('返回 K/M/J 三区 + crossLoopMap D1-D5 + provenance', async () => {
    const d = await createDecision(baseDecision(SCEN, { trigger_context: { dim: 'B' } }));
    const res = await app.fetch(`/api/decision/${d.decision_id}/closure`, { headers: AUTH });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.decision_id).toBe(d.decision_id);
    expect(b.k).toBeDefined();
    expect(b.m).toBeDefined();
    expect(b.j).toBeDefined();
    expect(b.crossLoopMap).toHaveProperty('D1');
    expect(b.crossLoopMap).toHaveProperty('D5');
    expect(Array.isArray(b.provenance)).toBe(true);
  });

  it('未登录 → 401（G7 鉴权）', async () => {
    const d = await createDecision(baseDecision(SCEN));
    const res = await app.fetch(`/api/decision/${d.decision_id}/closure`);
    expect(res.status).toBe(401);
  });

  it('无 outcome → D4.exists=false；写入 outcome → D4.exists=true', async () => {
    const d = await createDecision(baseDecision(SCEN));
    let b = await (await app.fetch(`/api/decision/${d.decision_id}/closure`, { headers: AUTH })).json();
    expect(b.crossLoopMap.D4.exists).toBe(false);
    await writeOutcome(d.decision_id, { outcome_type: 'won', source: 'manual' });
    b = await (await app.fetch(`/api/decision/${d.decision_id}/closure`, { headers: AUTH })).json();
    expect(b.crossLoopMap.D4.exists).toBe(true);
    expect(b.j.outcomes.length).toBe(1);
  });

  it('不存在的决策 → 404', async () => {
    const res = await app.fetch('/api/decision/e0000000-0000-0000-0000-000000000000/closure', { headers: AUTH });
    expect(res.status).toBe(404);
  });
});
