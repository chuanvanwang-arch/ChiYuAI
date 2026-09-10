// test/memory/precipitate-closure.test.js — C3 收口：字段集拓宽 + 建档即沉淀
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_RULES, shouldPrecipitate, diffFields, precipitateFromParticleWrite,
} from '../../src/memory/precipitate.js';

describe('C3 沉淀字段集拓宽', () => {
  it('CRM_DEAL 改 status/decision_chain/scope 应沉淀', () => {
    const v = shouldPrecipitate({
      type: 'CRM_DEAL',
      before: { stage: 'S1', status: 'open' },
      after: { stage: 'S1', status: 'won', decision_chain: 'A>B' },
      config: DEFAULT_RULES,
    });
    expect(v.ok).toBe(true);
    const fields = v.changes.map((c) => c.field).sort();
    expect(fields).toEqual(['decision_chain', 'status']);
  });

  it('CRM_QUOTATION 改 discount_rate 应沉淀（新增域）', () => {
    const v = shouldPrecipitate({
      type: 'CRM_QUOTATION',
      before: { discount_rate: 0.1 }, after: { discount_rate: 0.2 }, config: DEFAULT_RULES,
    });
    expect(v.ok).toBe(true);
    expect(v.topic).toBe('quote:change');
  });

  it('CRM_APPROVAL_FLOW 改 status 应沉淀（新增域）', () => {
    const v = shouldPrecipitate({
      type: 'CRM_APPROVAL_FLOW',
      before: { status: 'pending' }, after: { status: 'approved' }, config: DEFAULT_RULES,
    });
    expect(v.ok).toBe(true);
  });

  it('before=null 时 diffFields 把所有声明字段视为新增（created 模式）', () => {
    const d = diffFields(null, { stage: 'S1', amount: 100 }, ['stage', 'amount']);
    expect(d).toHaveLength(2);
    expect(d.every((c) => c.from == null)).toBe(true);
  });
});

describe('C3 建档即沉淀（created 分支，集成）', () => {
  it('precipitateFromParticleWrite(before=null) 产出 changeType=created 且带客户锚点', async () => {
    // 唯一锚点避免跨运行 24h 去重窗拦截（去重本身正确，仅测试须幂等安全）
    const accId = `acc-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const dealId = `deal-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const after = { id: dealId, type: 'CRM_DEAL', tenant_id: 'acme-demo', payload: { account_id: accId, stage: 'S1' } };
    const res = await precipitateFromParticleWrite(after, null, { tenantId: 'acme-demo', actor: 'system' });
    expect(res.ok).toBe(true);
    expect(res.row.payload.changeType).toBe('created');
    expect(res.row.entity_id).toBe(accId);   // 客户优先锚点
    expect(res.row.entity_type).toBe('ACCOUNT');
    expect(res.row.tenant_id).toBe('acme-demo');
    expect(res.row.payload.summary).toContain('创建');
  });
});
