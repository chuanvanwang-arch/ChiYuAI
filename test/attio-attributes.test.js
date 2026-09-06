// test/attio-attributes.test.js — ATTIO 借鉴：粒子属性声明纪律 + 交互渠道索引纯逻辑
import { describe, it, expect } from 'vitest';
import {
  PARTICLE_TYPES, ATTRIBUTE_TYPE_SET, CONTROLLED_PREDICATES,
  validateCoreAttributesSchema,
} from '../src/particles/particleModel.js';
import {
  INTERACTION_CHANNELS, emptyInteractionIndex, applyInteraction,
} from '../src/particles/interactionIndex.js';

describe('ATTIO 属性声明 + 19 类型集纪律', () => {
  it('所有粒子 coreAttributes 类型均落在 19 类型集内', () => {
    expect(validateCoreAttributesSchema()).toBe(true);
  });

  it('CRM_ACCOUNT 含 ATTIO A/D 桶属性（类型合法）', () => {
    const a = PARTICLE_TYPES.CRM_ACCOUNT.coreAttributes;
    expect(a.domains).toBe('domain');
    expect(a.funding_raised_usd).toBe('currency');
    expect(a.foundation_date).toBe('date');
    expect(a.estimated_arr_usd).toBe('select');
    expect(a.employee_range).toBe('select');
    expect(a.categories).toBe('select');
    expect(a.logo_url).toBe('url');
    expect(a.linkedin).toBe('url');
    expect(a.champion_strength).toBe('select');
    expect(a.key_contact).toBe('actor-reference');
  });

  it('CRM_CONTACT 含 ATTIO B/D 桶 enrichment', () => {
    const c = PARTICLE_TYPES.CRM_CONTACT.coreAttributes;
    expect(c.job_title).toBe('text');
    expect(c.avatar_url).toBe('url');
    expect(c.primary_location).toBe('location');
    expect(c.company).toBe('record-reference');
    expect(c.relationship_strength).toBe('select');
  });

  it('key_contact 进入受控谓词', () => {
    expect(CONTROLLED_PREDICATES).toContain('key_contact');
  });
});

describe('ATTIO C 桶 交互渠道索引纯逻辑', () => {
  it('渠道枚举 = email/calendar/call/meeting/general', () => {
    expect(INTERACTION_CHANNELS).toEqual(['email', 'calendar', 'call', 'meeting', 'general']);
  });
  it('空索引结构正确', () => {
    const idx = emptyInteractionIndex();
    expect(idx.email).toEqual({ first_at: null, last_at: null, next_at: null });
  });
  it('applyInteraction last 取最大值、first 取最小值、next 取最小值', () => {
    let idx = emptyInteractionIndex();
    idx = applyInteraction(idx, { channel: 'email', at: '2026-08-10T00:00:00Z', kind: 'last' });
    idx = applyInteraction(idx, { channel: 'email', at: '2026-08-05T00:00:00Z', kind: 'last' });
    expect(idx.email.last_at).toBe('2026-08-10T00:00:00Z'); // 取晚
    idx = applyInteraction(idx, { channel: 'email', at: '2026-08-01T00:00:00Z', kind: 'first' });
    expect(idx.email.first_at).toBe('2026-08-01T00:00:00Z'); // 取早
    idx = applyInteraction(idx, { channel: 'email', at: '2026-09-01T00:00:00Z', kind: 'next' });
    idx = applyInteraction(idx, { channel: 'email', at: '2026-08-20T00:00:00Z', kind: 'next' });
    expect(idx.email.next_at).toBe('2026-08-20T00:00:00Z'); // 最早计划
  });
  it('未知渠道/未知指针抛错', () => {
    expect(() => applyInteraction(emptyInteractionIndex(), { channel: 'sms', at: '2026-08-10T00:00:00Z', kind: 'last' })).toThrow(/未知交互渠道/);
    expect(() => applyInteraction(emptyInteractionIndex(), { channel: 'email', at: '2026-08-10T00:00:00Z', kind: 'wrong' })).toThrow(/未知指针类型/);
  });
});