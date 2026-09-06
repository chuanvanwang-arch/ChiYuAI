// test/meta-attr-model.test.js — metaAttrModel 纯逻辑（无 DB）
import { describe, it, expect } from 'vitest';
import {
  inferAttrType, mapSemanticTag, adaptiveRecordFor, recordFor, modelFor, identityRecordFor,
} from '../src/metaAttr/metaAttrModel.js';

describe('类型推断 inferAttrType', () => {
  it('值形态 → 19 类型映射', () => {
    expect(inferAttrType('hello')).toBe('text');
    expect(inferAttrType('li@x.com')).toBe('email-address');       // email 优先
    expect(inferAttrType('13800138000')).toBe('phone-number');      // 11 位手机号
    expect(inferAttrType(42)).toBe('number');
    expect(inferAttrType(42.5)).toBe('number');
    expect(inferAttrType(true)).toBe('boolean');
    expect(inferAttrType(['a', 'b'])).toBe('multi-select');
    expect(inferAttrType({ record_id: 'x' })).toBe('record-reference'); // JSON 对象候选
    expect(inferAttrType('2026-08-26')).toBe('date');               // ISO 日期
    expect(inferAttrType(null)).toBe(null);                          // 未命中
  });
});

describe('语义桶归类 mapSemanticTag', () => {
  it('未命中 → legacy；已知桶字段归桶', () => {
    expect(mapSemanticTag('domains')).toBe('firmographic');
    expect(mapSemanticTag('champion_strength')).toBe('relation');
    expect(mapSemanticTag('logo_url')).toBe('ui');
    expect(mapSemanticTag('interaction_index')).toBe('interaction');
    expect(mapSemanticTag('totally_new_attr')).toBe('legacy');
  });
});

describe('自适应登记记录 adaptiveRecordFor', () => {
  it('新键 → 记录 {attr_type, source:ai, enabled:false, version:1, semantic_tag}', () => {
    const rec = adaptiveRecordFor('CRM_ACCOUNT', 'custom_score', 88, 'system');
    expect(rec.attr_type).toBe('number');
    expect(rec.source).toBe('ai');
    expect(rec.enabled).toBe(false);
    expect(rec.version).toBe(1);
    expect(rec.semantic_tag).toBe('legacy');
    expect(rec.title).toBe('custom_score');
    expect(rec.created_by).toBe('system');
  });
});

describe('模型视图 modelFor', () => {
  it('只含 enabled 属性（type+attr_slug+attr_type+semantic_tag 元组）', () => {
    const rows = [
      { attr_slug: 'name', attr_type: 'text', semantic_tag: 'legacy', enabled: true },
      { attr_slug: 'hidden_x', attr_type: 'text', semantic_tag: 'legacy', enabled: false },
    ];
    expect(modelFor('CRM_DEAL', rows)).toEqual([
      { attr_slug: 'name', attr_type: 'text', semantic_tag: 'legacy' },
    ]);
  });
});

describe('recordFor（coreAttributes 物化 seed 记录）', () => {
  it('seed 记录：title=slug、source=manual、enabled=true（latent 修正：baseline 即生效）、语义桶归位', () => {
    const def = { coreAttributes: { name: 'text', domains: 'domain' } };
    const rec = recordFor('CRM_ACCOUNT', 'domains', def);
    expect(rec).toEqual({
      particle_type: 'CRM_ACCOUNT', attr_slug: 'domains', title: 'domains',
      attr_type: 'domain', semantic_tag: 'firmographic',
      required: false, unique: false, description: null, options: null, source: 'manual',
      display: {}, validation: {}, permission: {}, enabled: true, version: 1, created_by: 'seed',
    });
  });

  it('类型不在 19 集 → 抛错（对齐 validateCoreAttributesSchema 纪律）', () => {
    const def = { coreAttributes: { name: 'magic-type' } };
    expect(() => recordFor('CRM_DEAL', 'name', def)).toThrow(/不在 19 类型集内/);
  });
});

describe('identityRecordFor（种子完整性：identity 兜底）', () => {
  it('缺省类型兜底 text + required=true + source=manual', () => {
    // CRM_DEAL 仅 identity=['name']，无 coreAttributes → 类型兜底 text
    const r = identityRecordFor('CRM_DEAL', 'name');
    expect(r.enabled).toBe(true);
    expect(r.required).toBe(true);
    expect(r.source).toBe('manual');
    expect(r.attr_type).toBe('text');
  });

  it('slug 同现 coreAttributes 时取真实类型（去重由 repo 层负责）', () => {
    // CRM_ACCOUNT coreAttributes.name='text'
    const r = identityRecordFor('CRM_ACCOUNT', 'name');
    expect(r.attr_type).toBe('text');
    expect(r.required).toBe(true);
  });
});