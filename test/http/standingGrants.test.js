// test/http/standingGrants.test.js — S6 T19-7/T19-8 端到端（真实 express + 真实库，mock 登录身份）
// 覆盖：凭证 CRUD（第0闸 decision_id 必需 / 仅 T0 T1 / T3 动作永久不可）+ revoke 零DELETE + 租户隔离
//      + 执行流水 HITL 判定回写（J2：写 decision_outcome）+ 连续否决自动暂停（信任降级）
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import { query, queryWrite } from '../../src/db.js';
import { recordExecution } from '../../src/authorization/grantStore.js';
import { createStandingGrantRouter } from '../../src/http/routes.js';
import { T3_ACTIONS } from '../../src/authorization/standingAuthorization.js';

vi.mock('../../src/http/auth.js', () => ({ resolveMe: vi.fn() }));
const { resolveMe } = await import('../../src/http/auth.js');

const NS = '__sg_' + process.pid + '_' + Date.now();
const T = NS + '_tenant';
const T2 = NS + '_other';
let server = null, baseUrl = '';

const me = (tenantId = T, role = 'admin', username = 'tester') =>
  resolveMe.mockReturnValue({ ok: true, role, tenantId, username });

async function call(method, path, body) {
  me();
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

let DECISION_ID = null;
const grantStatus = async (gid) =>
  (await query(`SELECT status, decision_id FROM crm.standing_grant WHERE tenant_id=$1 AND grant_id=$2`, [T, gid])).rows[0];
const execRow = async (eid) =>
  (await query(`SELECT * FROM crm.grant_execution WHERE tenant_id=$1 AND execution_id=$2`, [T, eid])).rows[0];
const outcomeCount = async (decisionId) =>
  (await query(`SELECT count(*)::int c FROM crm.decision_outcome WHERE decision_id=$1 AND source='standing-auth-verdict'`, [decisionId])).rows[0].c;

beforeAll(async () => {
  // 真实决策行（供 J2 writeOutcome 通过 decision_outcome FK；scenario OPP_QUALIFY 由 seed 保证存在）
  const r = await queryWrite(
    `INSERT INTO crm.decision (scenario_id, trigger_context, involved_entities, conditions_evaluated, disposition, decider_type, rationale, business_tier, state)
     VALUES ('OPP_QUALIFY','{}'::jsonb,'[]'::jsonb,'[]'::jsonb,'APPROVE','HUMAN','test','NORMAL','CONFIRMED')
     RETURNING decision_id`,
    []
  );
  DECISION_ID = r.rows[0].decision_id;
  const app = express();
  app.use(express.json());
  app.use(createStandingGrantRouter());
  await new Promise((rs) => { server = app.listen(0, '127.0.0.1', () => { baseUrl = `http://127.0.0.1:${server.address().port}`; rs(); }); });
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  await queryWrite(`DELETE FROM crm.grant_execution WHERE tenant_id=$1`, [T]).catch(() => {});
  await queryWrite(`DELETE FROM crm.standing_grant WHERE tenant_id=$1`, [T]).catch(() => {});
  await queryWrite(`DELETE FROM crm.standing_grant WHERE tenant_id=$1`, [T2]).catch(() => {});
  await queryWrite(`DELETE FROM crm.decision_outcome WHERE decision_id=$1`, [DECISION_ID]).catch(() => {});
  await queryWrite(`DELETE FROM crm.decision WHERE decision_id=$1`, [DECISION_ID]).catch(() => {});
});

describe('T19-7 凭证列表与第0闸', () => {
  it('T1 空租户 → items 为空', async () => {
    const r = await call('GET', '/api/standing-grants');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.items)).toBe(true);
    expect(r.body.items.length).toBe(0);
  });

  it('T2 缺 decision_id → 400（溯源铁律）', async () => {
    const r = await call('POST', '/api/standing-grants', { scope_actions: ['crm-writeback-internal'], title: 'x' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('decision_required');
  });

  it('T3 T2 档位 → 400（仅 T0/T1 常驻授权）', async () => {
    const r = await call('POST', '/api/standing-grants', { decision_id: DECISION_ID, risk_tier: 'T2', title: 'x' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('only_t0_t1_allowed');
  });

  it('T4 T3 对外动作 → 400（永久不可常驻授权）', async () => {
    const r = await call('POST', '/api/standing-grants', {
      decision_id: DECISION_ID, scope_actions: [T3_ACTIONS[0]], title: 'x',
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('t3_actions_not_standable');
  });

  it('T5 合法 T1 凭证 → 201 + 落库 active', async () => {
    const r = await call('POST', '/api/standing-grants', {
      decision_id: DECISION_ID, title: '内部回写', risk_tier: 'T1',
      scope_actions: ['crm-writeback-internal'], field_whitelist: ['ai_fit_score'],
    });
    expect(r.status).toBe(201);
    expect(r.body.ok).toBe(true);
    expect(r.body.grant.grant_id).toBeTruthy();
    const g = await grantStatus(r.body.grant.grant_id);
    expect(g.status).toBe('active');
    expect(g.decision_id).toBe(DECISION_ID);
  });

  it('T6 租户隔离：他租户凭证不出现在本租户列表', async () => {
    await queryWrite(
      `INSERT INTO crm.standing_grant (grant_id, tenant_id, title, scope_actions, risk_tier, status, approved_by, approved_at, decision_id)
       VALUES ($1,$2,'other','{crm-writeback-internal}','T1','active','alice',now(),$3)`,
      [`grant-${T2}-iso`, T2, DECISION_ID]
    );
    const r = await call('GET', '/api/standing-grants');
    expect(r.body.items.every((x) => x.tenant_id === T)).toBe(true);
    expect(r.body.items.some((x) => x.grant_id === `grant-${T2}-iso`)).toBe(false);
  });
});

describe('T19-7 revoke（零 DELETE）', () => {
  let gid = null;
  beforeAll(async () => {
    const r = await call('POST', '/api/standing-grants', {
      decision_id: DECISION_ID, title: '待撤回', risk_tier: 'T1', scope_actions: ['crm-writeback-internal'],
    });
    gid = r.body.grant.grant_id;
  });
  it('T7 revoke → status=revoked 且 revoked_at 非空（行数不变）', async () => {
    const before = (await query(`SELECT count(*)::int c FROM crm.standing_grant WHERE tenant_id=$1`, [T])).rows[0].c;
    const r = await call('POST', `/api/standing-grants/${gid}/revoke`, { reason: 'test-revoke' });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    const g = (await query(`SELECT status, revoked_at, revoked_reason FROM crm.standing_grant WHERE tenant_id=$1 AND grant_id=$2`, [T, gid])).rows[0];
    expect(g.status).toBe('revoked');
    expect(g.revoked_at).not.toBeNull();
    expect(g.revoked_reason).toBe('test-revoke');
    const after = (await query(`SELECT count(*)::int c FROM crm.standing_grant WHERE tenant_id=$1`, [T])).rows[0].c;
    expect(after).toBe(before); // 零 DELETE
  });
});

describe('T19-8 J2 回写 + 连续否决自动暂停', () => {
  it('T8 verdict=adopted → hitl_verdict=adopted 且 decision_outcome 落行（J2）', async () => {
    const cg = await call('POST', '/api/standing-grants', {
      decision_id: DECISION_ID, title: '执行用', risk_tier: 'T1', scope_actions: ['crm-writeback-internal'],
    });
    const gid = cg.body.grant.grant_id;
    const exec = await recordExecution({ tenantId: T, grantId: gid, actionName: 'crm-writeback-internal', targetId: 'p-1', decisionId: DECISION_ID });
    const before = await outcomeCount(DECISION_ID);
    const r = await call('POST', `/api/grant-executions/${exec.execution_id}/verdict`, { verdict: 'adopted' });
    expect(r.status).toBe(200);
    const er = await execRow(exec.execution_id);
    expect(er.hitl_verdict).toBe('adopted');
    expect(er.rejected_at).toBeNull();
    expect(await outcomeCount(DECISION_ID)).toBe(before + 1);
  });

  it('T9 verdict=rejected 连续达阈值 → 凭证自动 paused（信任降级）', async () => {
    const cg = await call('POST', '/api/standing-grants', {
      decision_id: DECISION_ID, title: '否决用', risk_tier: 'T1', scope_actions: ['crm-writeback-internal'],
    });
    const gid = cg.body.grant.grant_id;
    const execs = [];
    for (let i = 0; i < 3; i++) {
      execs.push(await recordExecution({ tenantId: T, grantId: gid, actionName: 'crm-writeback-internal', targetId: 'p-' + i, decisionId: null }));
    }
    // 逐条否决；第 3 条后最近 3 条全 rejected → 自动 paused
    for (const e of execs) {
      const r = await call('POST', `/api/grant-executions/${e.execution_id}/verdict`, { verdict: 'rejected' });
      expect(r.status).toBe(200);
    }
    const g = await grantStatus(gid);
    expect(g.status).toBe('paused');
    // 每条 rejected 均置 rejected_at
    for (const e of execs) expect((await execRow(e.execution_id)).rejected_at).not.toBeNull();
  });

  it('T10 非法 verdict → 400', async () => {
    const r = await call('POST', `/api/grant-executions/nonexistent/verdict`, { verdict: 'maybe' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('invalid_verdict');
  });

  it('T11 不存在的执行 → 404', async () => {
    const r = await call('POST', `/api/grant-executions/exec-none/verdict`, { verdict: 'adopted' });
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('not_found');
  });
});
