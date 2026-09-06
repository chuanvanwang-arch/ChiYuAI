import { describe, it, expect } from 'vitest';
import { planCopy, passFilter } from '../../scripts/seed-tenant-master-data.mjs';
import { computeParticleStableKey } from '../../src/particles/mintId.js';

const rows = [
  { slug: 'p1', title: '产品1', state: 'ACTIVE', payload: { category: '软件' }, created_at: new Date(), updated_at: new Date() },
  { slug: 'p2', title: '产品2', state: 'ACTIVE', payload: { category: '硬件' }, created_at: new Date(), updated_at: new Date() },
  { slug: 'p3', title: '产品3', state: 'ACTIVE', payload: {}, created_at: new Date(), updated_at: new Date() },
];

describe('planCopy', () => {
  it('默认全复制（filter 空）', () => {
    const out = planCopy({ sourceRows: rows, type: 'CRM_PRODUCT', tenantId: 'acme-chem', filter: {} });
    expect(out).toHaveLength(3);
    expect(out[0].tenant_id).toBe('acme-chem');
    expect(out[0].stable_key).toBe(computeParticleStableKey('CRM_PRODUCT', 'p1', 'acme-chem'));
    expect(out[0].decision_id).toBeUndefined();
  });

  it('CRM_PRODUCT 按 payload.category 白名单筛选', () => {
    const out = planCopy({ sourceRows: rows, type: 'CRM_PRODUCT', tenantId: 'acme-chem', filter: { category: ['软件'] } });
    expect(out.map((r) => r.slug)).toEqual(['p1']);
  });

  it('非 CRM_PRODUCT 忽略 filter 放行', () => {
    const out = planCopy({ sourceRows: rows, type: 'CRM_PRICE_LIST', tenantId: 'acme-chem', filter: { category: ['软件'] } });
    expect(out).toHaveLength(3);
  });
});

describe('passFilter', () => {
  it('非 CRM_PRODUCT 恒放行', () => {
    expect(passFilter('CRM_DICT_ENTRY', rows[0], { category: ['软件'] })).toBe(true);
  });
  it('CRM_PRODUCT 命中/未命中白名单', () => {
    expect(passFilter('CRM_PRODUCT', rows[0], { category: ['软件'] })).toBe(true);
    expect(passFilter('CRM_PRODUCT', rows[1], { category: ['软件'] })).toBe(false);
  });
});

describe('stable_key 租户隔离', () => {
  it('同一 slug 在不同租户 stable_key 不同 → 复制不冲突', () => {
    const a = computeParticleStableKey('CRM_PRODUCT', 'p1', 'system');
    const b = computeParticleStableKey('CRM_PRODUCT', 'p1', 'acme-chem');
    expect(a).not.toBe(b);
  });
});
