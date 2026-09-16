// T19-3 standingAuthorization 单测：policy 加载 + isActionAuthorized（T3/白名单/字段越界）+ executeUnderGrant（mint 决策 + 快照）
import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  loadGrantsPolicy, isActionAuthorized, executeUnderGrant, T3_ACTIONS, STANDING_AUTH_SCENARIO,
} from '../../src/authorization/standingAuthorization.js';
import { createGrant, getGrant } from '../../src/authorization/grantStore.js';
import { getExecution } from '../../src/authorization/grantStore.js';

const TENANT = `test-sa-${randomUUID()}`;

describe('loadGrantsPolicy', () => {
  it('返回默认值合并（default_tier=T1, 不可自动提升, 连续否决=3）', async () => {
    const p = await loadGrantsPolicy(TENANT);
    expect(p.default_tier).toBe('T1');
    expect(p.allow_tier_upgrade_by_ai).toBe(false);
    expect(p.auto_pause_on_consecutive_rejects).toBe(3);
    expect(p.notify_on_execution).toBe(true);
  });
});

describe('isActionAuthorized', () => {
  it('T3 对外动作永久不可授权', async () => {
    const r = await isActionAuthorized({ tenantId: TENANT, action: T3_ACTIONS[0], fields: [] });
    expect(r.authorized).toBe(false);
    expect(r.reason).toBe('T3 actions are never standing-authorizable');
  });

  it('无活跃凭证 → no-active-grant', async () => {
    const r = await isActionAuthorized({ tenantId: TENANT, action: 'crm-writeback-internal', fields: ['ai_fit_score'] });
    expect(r.authorized).toBe(false);
    expect(r.reason).toBe('no-active-grant');
  });

  it('命中 T1 凭证 + 字段在白名单 → authorized', async () => {
    await createGrant({
      tenantId: TENANT, title: '内部回写', scopeActions: ['crm-writeback-internal'],
      fieldWhitelist: ['ai_fit_score', 'ai_next_action'], riskTier: 'T1',
      approvedBy: 'alice', decisionId: 'dec-x',
    });
    const r = await isActionAuthorized({ tenantId: TENANT, action: 'crm-writeback-internal', fields: ['ai_fit_score'] });
    expect(r.authorized).toBe(true);
    expect(r.grant).toBeTruthy();
  });

  it('字段越出白名单 → field-out-of-whitelist', async () => {
    const r = await isActionAuthorized({ tenantId: TENANT, action: 'crm-writeback-internal', fields: ['external_field'] });
    expect(r.authorized).toBe(false);
    expect(r.reason).toBe('field-out-of-whitelist');
  });
});

describe('executeUnderGrant', () => {
  it('mint 决策带 grant_ref + 落前后快照', async () => {
    const g = await createGrant({
      tenantId: TENANT, title: '执行测试', scopeActions: ['act-run'], fieldWhitelist: null,
      riskTier: 'T1', approvedBy: 'alice', decisionId: 'dec-y',
    });
    const fakeCreate = async (input) => ({ decision_id: `fake-${randomUUID()}`, ...input });
    let ran = false;
    const { decision, execution } = await executeUnderGrant({
      tenantId: TENANT, grant: g,
      actionName: 'act-run', targetId: 'p-1', fields: [],
      beforeState: { v: 1 },
      execFn: async () => { ran = true; return { v: 2 }; },
      createDecisionFn: fakeCreate,
    });
    expect(decision.grant_ref).toBe(g.grant_id);
    expect(decision.decider_type).toBe('STANDING_AUTH');
    expect(ran).toBe(true);
    const exec = await getExecution(TENANT, execution.execution_id);
    expect(exec.before_state).toEqual({ v: 1 });
    expect(exec.after_state).toEqual({ v: 2 });
    expect(exec.decision_id).toBe(decision.decision_id);
    expect(exec.actor).toBe('standing-auth');
  });

  it('STANDING_AUTH_SCENARIO 常量存在', () => {
    expect(STANDING_AUTH_SCENARIO).toBeTruthy();
  });
});
