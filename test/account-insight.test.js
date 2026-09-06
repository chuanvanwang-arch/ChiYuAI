// test/account-insight.test.js — 客户洞察 纯函数单测（无 DB：不调用 query）
// 覆盖：applyScopeFilter（self/domain/all）/ applyFieldPerms（列隐藏+字段只读）/ buildTimelineRows / buildTransactionRows
// 设计/计划：docs/2026-08-28-customer-360-insight-design.md §4.2；plans/2026-08-28-customer-360-insight-plan.md Task A/B
import { describe, it, expect } from 'vitest';
import {
  applyScopeFilter, applyFieldPerms, buildTimelineRows, buildTransactionRows,
} from '../src/account/insightService.js';

const SALES = { data_scope: { model: 'self' } };
const FINANCE = { data_scope: { model: 'domain', domain: ['payment', 'contract', 'invoice'] } };

describe('applyScopeFilter', () => {
  it('self 模型仅保留 owner_id === actor 的粒子', () => {
    const ps = [
      { type: 'CRM_DEAL', payload: { owner_id: 'u1' } },
      { type: 'CRM_DEAL', payload: { owner_id: 'u2' } },
    ];
    const r = applyScopeFilter(ps, SALES, 'u1');
    expect(r).toHaveLength(1);
    expect(r[0].payload.owner_id).toBe('u1');
  });
  it('domain 模型按 token→类型映射保留 domain 内类型', () => {
    const ps = [
      { type: 'CRM_DEAL' }, { type: 'CRM_PAYMENT_RECORD' }, { type: 'CRM_CONTRACT' },
    ];
    const r = applyScopeFilter(ps, FINANCE, 'u9');
    expect(r.map(x => x.type).sort()).toEqual(['CRM_CONTRACT', 'CRM_PAYMENT_RECORD']);
  });
  it('all 模型全保留', () => {
    const ps = [{ type: 'CRM_DEAL' }, { type: 'CRM_ACCOUNT' }];
    expect(applyScopeFilter(ps, { data_scope: { model: 'all' } }, 'x')).toHaveLength(2);
  });
});

describe('applyFieldPerms', () => {
  const baseSchema = () => ({
    type: 'workspace', title: 't', navigation: { to: '/accounts/:id/insight' },
    layout: { columns: 1, theme: 'light' },
    components: [
      {
        kind: 'table', title: '完整交易链（L2C）',
        dataBinding: { source: 'particle', particleType: 'CRM_ACCOUNT', filters: [], metrics: [], columns: ['doc', 'amount', 'status'] },
        permColumns: { sales: ['amount'], finance: [] },
      },
      { kind: 'attr-field', attrSlug: 'biz', attrType: 'text', label: '工商信息', perm: 'biz_info',
        attr: { data_origin: 'external' } },
    ],
  });
  it('sales 隐藏回款金额列、biz_info 只读；finance 全可见', () => {
    const sHidden = applyFieldPerms(baseSchema(), 'sales');
    const sub = sHidden.components.find(c => c.kind === 'table');
    expect(sub.dataBinding.columns).toEqual(['doc', 'status']);
    const af = sHidden.components.find(c => c.kind === 'attr-field');
    expect(af.readonly).toBe(true);
    expect(af.hidden).toBeUndefined();

    const fVisible = applyFieldPerms(baseSchema(), 'finance');
    const subF = fVisible.components.find(c => c.kind === 'table');
    expect(subF.dataBinding.columns).toEqual(['doc', 'amount', 'status']);
    const afF = fVisible.components.find(c => c.kind === 'attr-field');
    expect(afF.readonly).toBeUndefined();
  });
});

describe('buildTimelineRows', () => {
  it('按 ts 倒序且同秒同实体去重', () => {
    const src = [
      { ts: '2026-08-28T10:00:00Z', type: 'event', title: 'A', entityId: '1', entityType: 'D', source: 'x', actor: 's', summary: '' },
      { ts: '2026-08-28T09:00:00Z', type: 'event', title: 'B', entityId: '2', entityType: 'D', source: 'x', actor: 's', summary: '' },
      { ts: '2026-08-28T10:00:00Z', type: 'event', title: 'A', entityId: '1', entityType: 'D', source: 'x', actor: 's', summary: '' },
    ];
    const r = buildTimelineRows(src);
    expect(r).toHaveLength(2);
    expect(r[0].title).toBe('A');
  });
});

describe('buildTransactionRows', () => {
  it('计算各阶段金额与回款率', () => {
    const related = {
      deals: [{ payload: { expected_amount: 100 } }],
      contracts: [{ payload: { amount: 200 } }],
      payments: [{ payload: { paid_amount: 50 } }],
    };
    const { rows, totals } = buildTransactionRows(related);
    expect(rows.find(r => r.stage === '合同').amount).toBe(200);
    expect(totals.rate).toBe(25);
  });
});
