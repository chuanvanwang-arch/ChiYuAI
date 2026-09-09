// test/config/profileMerger.test.js — 多行业画像合并层纯函数单测（T1–T6, T17–T18）
import { describe, it, expect } from 'vitest';
import {
  mergeProfile, assignIndustry, removeIndustry, migrateFromV1,
  resolvePrototypeInMerged, isControlledPredicateInMerged,
} from '../../src/config/profileMerger.js';

const CHEM = { meta: { industry_label: '化工' }, prototypes: { PRODUCT: { label: '化工产品', edgeTypes: ['supplies'] } } };
const EDU = { meta: { industry_label: '培训' }, prototypes: { PRODUCT: { label: '培训产品', edgeTypes: ['teaches'] }, COURSE: { label: '课程' } } };

describe('mergeProfile', () => {
  it('T1 v1（无 industries 数组）原样返回', () => {
    const v1 = { prototypes: { A: { label: 'a' } } };
    expect(mergeProfile(v1)).toBe(v1); // 同引用，零回归
  });
  it('T2 v2 合并多 industry 为扁平 prototypes/calculations', () => {
    const v2 = { version: 2, industries: [CHEM, EDU].map((t, i) => ({ id: ['chem', 'edu'][i], label: t.meta.industry_label, prototypes: t.prototypes })) };
    const m = mergeProfile(v2);
    expect(Object.keys(m.prototypes).sort()).toEqual(['COURSE', 'PRODUCT']);
  });
});

describe('合并语义（C 静默覆盖）', () => {
  it('T3 同名类型后者覆盖前者', () => {
    const v2 = { version: 2, industries: [
      { id: 'chem', label: '化工', prototypes: CHEM.prototypes },
      { id: 'edu', label: '培训', prototypes: EDU.prototypes },
    ] };
    const m = mergeProfile(v2);
    expect(m.prototypes.PRODUCT.label).toBe('培训产品'); // edu 覆盖 chem
    expect(resolvePrototypeInMerged(m, 'PRODUCT').label).toBe('培训产品');
  });
  it('T4 多 industry edgeTypes 并集（后者覆盖同键 edgeType）', () => {
    const v2 = { version: 2, industries: [
      { id: 'chem', label: '化工', prototypes: CHEM.prototypes },
      { id: 'edu', label: '培训', prototypes: EDU.prototypes },
    ] };
    const m = mergeProfile(v2);
    // PRODUCT 被 edu 覆盖 → edgeTypes 仅 teaches
    expect(isControlledPredicateInMerged(m, 'teaches')).toBe(true);
    expect(isControlledPredicateInMerged(m, 'supplies')).toBe(false);
    expect(isControlledPredicateInMerged(m, 'x')).toBe(false);
  });
});

describe('assignIndustry / removeIndustry', () => {
  it('T5 幂等：同 templateId 重复 assign 长度不变', () => {
    const a1 = assignIndustry(null, { template: CHEM, templateId: 'chem' });
    expect(a1.next.industries.length).toBe(1);
    const a2 = assignIndustry(a1.next, { template: CHEM, templateId: 'chem' });
    expect(a2.skipped).toBe(true);
    expect(a2.next.industries.length).toBe(1);
  });
  it('T6 removeIndustry：指定 id 移除长度-1；不存在抛错', () => {
    const a = assignIndustry(null, { template: CHEM, templateId: 'chem' });
    const b = assignIndustry(a.next, { template: EDU, templateId: 'edu' });
    expect(b.next.industries.length).toBe(2);
    const r = removeIndustry(b.next, 'edu');
    expect(r.next.industries.length).toBe(1);
    expect(r.removed.id).toBe('edu');
    expect(() => removeIndustry(b.next, 'nope')).toThrow();
  });
});

describe('migrateFromV1 兼容性（T17/T18 byte-equal）', () => {
  it('T17 升级后 industries[0].prototypes 与旧 prototypes 字节级一致', () => {
    const v1 = { prototypes: { PRODUCT: { label: '化工产品' }, COURSE: { label: '课程' } } };
    const { value } = migrateFromV1(v1, { fallbackId: 'legacy', fallbackLabel: '化工' });
    expect(value.version).toBe(2);
    expect(value.industries[0].prototypes).toEqual(v1.prototypes);
    // mergeProfile 后顶层 prototypes 仍等于旧值（消费点零变动）
    expect(mergeProfile(value).prototypes).toEqual(v1.prototypes);
  });
  it('T18 升级后 edgeTypes 合并结果与旧一致', () => {
    const v1 = { prototypes: { PRODUCT: { label: 'p', edgeTypes: ['supplies'] } } };
    const { value } = migrateFromV1(v1, { fallbackId: 'legacy', fallbackLabel: 'x' });
    const m = mergeProfile(value);
    expect(isControlledPredicateInMerged(m, 'supplies')).toBe(true);
    expect(isControlledPredicateInMerged(m, 'other')).toBe(false);
  });
});
