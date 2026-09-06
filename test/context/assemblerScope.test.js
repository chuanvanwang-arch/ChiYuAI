// assembleContext 注入前置 data_scope 裁剪（P0① 权限即架构最后一公里）
// 复用 retrievers 注入 stub，聚焦过滤逻辑；data_scope=all 保持零过滤（现状）
import { describe, it, expect } from 'vitest';
import { assembleContext } from '../../src/context/assembler.js';

const baseRetrievers = {
  L1: async () => [{ entity_id: 'a1', entity_type: 'CRM_ACCOUNT', title: 'A公司', payload: { owner_id: 'alice' } }],
  L2: async () => ({ decisions: [], memories: [] }),
  L3: async () => ({ tasks: [], agents: [] }),
  L4: async () => ({ profile: null, data_scope: null, tiers: [] }),
  LK: async () => [],
};

describe('assembleContext 注入前置 data_scope 过滤', () => {
  it('data_scope.all 零过滤（现状行为不变）', async () => {
    const bundle = await assembleContext(
      { actor: 'alice', profile: { data_scope: { model: 'all' } }, intent: { scenario: 'account_insight' }, query: 'A公司' },
      baseRetrievers
    );
    expect(bundle.layers.L1.length).toBeGreaterThan(0);
  });

  it('data_scope.self 过滤：L1 只含 owner=actor 的粒子', async () => {
    // 注入 retrievers 观察参数——真实实现会在 retrieveL1 SQL 加 scopePredicate
    const spyL1 = async (actor, q, profile) => {
      // 断言 profile 传入且 model=self
      expect(profile?.data_scope?.model).toBe('self');
      return profile?.data_scope?.model === 'self'
        ? [{ entity_id: 'a1', entity_type: 'CRM_ACCOUNT', title: 'A公司', payload: { owner_id: 'alice' } }]
        : [];
    };
    const bundle = await assembleContext(
      { actor: 'alice', profile: { data_scope: { model: 'self' } }, intent: { scenario: 'account_insight' }, query: 'A公司' },
      { ...baseRetrievers, L1: spyL1 }
    );
    expect(bundle.layers.L1[0].payload.owner_id).toBe('alice');
  });

  it('data_scope.domain 过滤：L1 只含 domain 内类型粒子', async () => {
    const spyL1 = async (actor, q, profile) => {
      expect(profile?.data_scope?.domain).toEqual(['CRM_DEAL']);
      return [];
    };
    const bundle = await assembleContext(
      { actor: 'bob', profile: { data_scope: { model: 'domain', domain: ['CRM_DEAL'] } }, intent: { scenario: 'account_insight' }, query: '商机' },
      { ...baseRetrievers, L1: spyL1 }
    );
    expect(bundle.layers.L1).toEqual([]);
  });

  it('叙事越界：target 不在 data_scope 时 unavailable_reason=scope-excluded（非 degraded）', async () => {
    // 契约（计划 §Task1 Step3）：越界叙事 = 返回空 rows；组装层在「非 all 模型 + 有实体作用域 + 空返回」时标 scope-excluded
    const bundle = await assembleContext(
      { actor: 'alice', profile: { data_scope: { model: 'self' } }, intent: { scenario: 'account_insight', accountId: 'not-mine' }, query: '客户' },
      { ...baseRetrievers, narrative: async () => [] }
    );
    expect(bundle.narrative.available).toBe(false);
    expect(bundle.narrative.unavailable_reason).toBe('scope-excluded');
    expect(bundle.degraded).toBe(false);
  });
});
