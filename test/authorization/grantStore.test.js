// T19-2 grantStore 单测：纯函数（零 DB）+ 真库 CRUD/解析/熔断（租户隔离）
import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  grantCovers, createGrant, getGrant, listGrants, revokeGrant,
  resolveActiveGrant, recordExecution, getExecution, pauseGrant, recentVerdicts,
} from '../../src/authorization/grantStore.js';

const TENANT = `test-sg-${randomUUID()}`;

describe('grantStore.grantCovers（纯函数）', () => {
  it('active 且动作/字段命中 → true', () => {
    expect(grantCovers(
      { status: 'active', scope_actions: ['crm-writeback-internal'], field_whitelist: ['ai_fit_score', 'ai_next_action'] },
      { action: 'crm-writeback-internal', fields: ['ai_fit_score'] }
    )).toBe(true);
  });
  it('status=revoked → false', () => {
    expect(grantCovers(
      { status: 'revoked', scope_actions: ['a'], field_whitelist: null },
      { action: 'a', fields: [] }
    )).toBe(false);
  });
  it('动作不在白名单 → false', () => {
    expect(grantCovers(
      { status: 'active', scope_actions: ['a'], field_whitelist: null },
      { action: 'b', fields: [] }
    )).toBe(false);
  });
  it('字段超出白名单 → false', () => {
    expect(grantCovers(
      { status: 'active', scope_actions: ['a'], field_whitelist: ['x'] },
      { action: 'a', fields: ['x', 'y'] }
    )).toBe(false);
  });
  it('已过期 → false', () => {
    expect(grantCovers(
      { status: 'active', scope_actions: ['a'], field_whitelist: null, expires_at: '2000-01-01T00:00:00Z' },
      { action: 'a', fields: [] }
    )).toBe(false);
  });
  it('白名单为 NULL 不限制字段', () => {
    expect(grantCovers(
      { status: 'active', scope_actions: ['a'], field_whitelist: null },
      { action: 'a', fields: ['anything'] }
    )).toBe(true);
  });
});

describe('grantStore 真库 CRUD', () => {
  let grantId;
  it('createGrant 落库', async () => {
    const g = await createGrant({
      tenantId: TENANT, title: 'T1 内部字段回写', scopeActions: ['crm-writeback-internal'],
      fieldWhitelist: ['ai_fit_score', 'ai_next_action'], riskTier: 'T1',
      maxUses: 2, approvedBy: 'alice', decisionId: 'dec-1',
    });
    expect(g.grant_id).toBeTruthy();
    expect(g.status).toBe('active');
    grantId = g.grant_id;
  });
  it('getGrant / listGrants', async () => {
    const g = await getGrant(TENANT, grantId);
    expect(g.title).toBe('T1 内部字段回写');
    const all = await listGrants(TENANT);
    expect(all.some((x) => x.grant_id === grantId)).toBe(true);
  });
  it('resolveActiveGrant 命中', async () => {
    const g = await resolveActiveGrant({ tenantId: TENANT, action: 'crm-writeback-internal', fields: ['ai_fit_score'] });
    expect(g?.grant_id).toBe(grantId);
  });
  it('resolveActiveGrant 字段越界 → null', async () => {
    const g = await resolveActiveGrant({ tenantId: TENANT, action: 'crm-writeback-internal', fields: ['external_field'] });
    expect(g).toBe(null);
  });
  it('revokeGrant 仅状态变更（零 DELETE），保留行', async () => {
    const g = await revokeGrant(TENANT, grantId, 'no-longer-needed');
    expect(g.status).toBe('revoked');
    expect(g.revoked_reason).toBe('no-longer-needed');
    expect(g.revoked_at).toBeTruthy();
    const stillThere = await getGrant(TENANT, grantId);
    expect(stillThere).not.toBe(null); // 行未被删
  });
});

describe('grantStore 执行流水 + 用量熔断', () => {
  let g2;
  it('recordExecution 写入前后快照', async () => {
    g2 = await createGrant({
      tenantId: TENANT, title: '熔断测试', scopeActions: ['act-x'], fieldWhitelist: null,
      riskTier: 'T1', maxUses: 2, approvedBy: 'alice', decisionId: 'dec-2',
    });
    const e = await recordExecution({
      tenantId: TENANT, grantId: g2.grant_id, actionName: 'act-x', targetId: 'p1',
      beforeState: { v: 1 }, afterState: { v: 2 }, decisionId: 'dec-exec-1',
    });
    expect(e.execution_id).toBeTruthy();
    expect(e.before_state).toEqual({ v: 1 });
    expect(e.after_state).toEqual({ v: 2 });
    expect(e.actor).toBe('standing-auth');
    expect(e.hitl_verdict).toBe('pending');
    const updated = await getGrant(TENANT, g2.grant_id);
    expect(updated.used_count).toBe(1);
  });
  it('达到 max_uses → 自动 paused（用量熔断）', async () => {
    await recordExecution({ tenantId: TENANT, grantId: g2.grant_id, actionName: 'act-x', beforeState: {}, afterState: {}, decisionId: 'dec-exec-2' });
    const updated = await getGrant(TENANT, g2.grant_id);
    expect(updated.used_count).toBe(2);
    expect(updated.status).toBe('paused'); // 熔断
  });
  it('paused 后 resolveActiveGrant 不再命中', async () => {
    const g = await resolveActiveGrant({ tenantId: TENANT, action: 'act-x', fields: [] });
    expect(g).toBe(null);
  });
});

describe('grantStore 暂停 + 连续否决计数', () => {
  it('pauseGrant 状态变更', async () => {
    const g = await createGrant({ tenantId: TENANT, title: '暂停测试', scopeActions: ['act-y'], fieldWhitelist: null, riskTier: 'T1', approvedBy: 'alice', decisionId: 'dec-3' });
    const paused = await pauseGrant(TENANT, g.grant_id);
    expect(paused.status).toBe('paused');
  });
  it('recentVerdicts 返回最近 N 条', async () => {
    const g = await createGrant({ tenantId: TENANT, title: '否决测试', scopeActions: ['act-z'], fieldWhitelist: null, riskTier: 'T1', approvedBy: 'alice', decisionId: 'dec-4' });
    await recordExecution({ tenantId: TENANT, grantId: g.grant_id, actionName: 'act-z', beforeState: {}, afterState: {}, decisionId: 'd1', hitlVerdict: 'rejected' });
    await recordExecution({ tenantId: TENANT, grantId: g.grant_id, actionName: 'act-z', beforeState: {}, afterState: {}, decisionId: 'd2', hitlVerdict: 'rejected' });
    const v = await recentVerdicts(TENANT, g.grant_id, 2);
    expect(v).toEqual(['rejected', 'rejected']);
  });
});
