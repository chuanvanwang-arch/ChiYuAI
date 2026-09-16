// test/connectors/discovery/providerDescriptor.test.js
// 线A A-B1：integration-providers 描述符归一化（单一事实源）
// 设计：docs/2026-09-15-final-design-coexistence-and-proactive.md §6.1 A-B1 + §9.3
// 判据重点：① 旧字段零回归；② 非法输入**拒绝而非猜**，且必须记入 issues（不静默）；
//          ③ trust_level 非法回落 null（最严侧），绝不静默改写为 L1 假绿。
import { describe, it, expect } from 'vitest';
import {
  normalizeProviderDescriptor,
  normalizeProviderDescriptors,
  normalizeSyncObject,
  inboundObjects,
} from '../../../src/connectors/discovery/providerDescriptor.js';

describe('A-B1 · providerDescriptor 归一化（单一事实源）', () => {
  it('旧形状原样透传（field_map / signal_map / endpoint / credentials 零回归）', () => {
    const raw = {
      id: 'legacy-1', kind: 'generic-rest', enabled: true,
      endpoint: 'https://x/api', field_map: { legal_person: 'lp' }, signal_map: { hiring: 'hr' },
      credentials: 'plain-token',
    };
    const { descriptor, issues } = normalizeProviderDescriptor(raw);
    expect(issues).toEqual([]);
    expect(descriptor.endpoint).toBe('https://x/api');
    expect(descriptor.field_map).toEqual({ legal_person: 'lp' });
    expect(descriptor.signal_map).toEqual({ hiring: 'hr' });
    expect(descriptor.credentials).toBe('plain-token');
    expect(descriptor.objects).toEqual([]); // 无 objects[] → 空数组，读入面 no-op
  });

  it('objects[]：缺 direction 视为入向；出向保留；未知 direction 丢弃并记 issue', () => {
    const { descriptor, issues } = normalizeProviderDescriptor({
      id: 'p', kind: 'fxiaoke', enabled: true,
      objects: [
        { name: 'AccountObj' },
        { name: 'OutObj', direction: 'out' },
        { name: 'BadObj', direction: 'sideways' },
      ],
    });
    expect(descriptor.objects.map((o) => `${o.name}:${o.direction}`)).toEqual(['AccountObj:in', 'OutObj:out']);
    expect(issues.some((s) => s.includes('unknown_direction:sideways'))).toBe(true);
  });

  it('objects[]：缺 name 丢弃并记 issue（不猜对象名）', () => {
    const { descriptor, issues } = normalizeProviderDescriptor({
      id: 'p', kind: 'fxiaoke', enabled: true, objects: [{ direction: 'in' }, { name: '  ' }, { name: 'OkObj' }],
    });
    expect(descriptor.objects.map((o) => o.name)).toEqual(['OkObj']);
    expect(issues.filter((s) => s.includes('name_missing')).length).toBe(2);
  });

  it('objects[] 可选字段仅在有值时落键（不造“存在但为空”的第三态）', () => {
    const { descriptor } = normalizeProviderDescriptor({
      id: 'p', kind: 'fxiaoke', enabled: true,
      objects: [{ name: 'A', cadence_min: 30, mapping_ref: 'A', id_field: '_id', since_field: 'last_modified_time' }],
    });
    const o = descriptor.objects[0];
    expect(o).toEqual({ name: 'A', direction: 'in', cadence_min: 30, mapping_ref: 'A', id_field: '_id', since_field: 'last_modified_time' });
    expect(Object.prototype.hasOwnProperty.call(o, 'cursor')).toBe(false);
  });

  it('trust_level 非法 → null 且记 issue（不回落到宽松值）', () => {
    const bad = normalizeProviderDescriptor({ id: 'p', kind: 'fxiaoke', enabled: true, trust_level: 'L9' });
    expect(bad.descriptor.trust_level).toBeNull();
    expect(bad.issues.some((s) => s.includes('unknown_trust_level:L9'))).toBe(true);
    const ok = normalizeProviderDescriptor({ id: 'p', kind: 'fxiaoke', enabled: true, trust_level: 'L2' });
    expect(ok.descriptor.trust_level).toBe('L2');
    const absent = normalizeProviderDescriptor({ id: 'p', kind: 'fxiaoke', enabled: true });
    expect(absent.descriptor.trust_level).toBeNull();
    expect(absent.issues).toEqual([]); // 未声明 ≠ 非法：不该报错
  });

  it('token_mode 归一化（空串/非串 → null）', () => {
    expect(normalizeProviderDescriptor({ id: 'p', kind: 'fxiaoke', token_mode: ' corp-access-token ' }).descriptor.token_mode)
      .toBe('corp-access-token');
    expect(normalizeProviderDescriptor({ id: 'p', kind: 'fxiaoke', token_mode: '   ' }).descriptor.token_mode).toBeNull();
    expect(normalizeProviderDescriptor({ id: 'p', kind: 'fxiaoke', token_mode: 123 }).descriptor.token_mode).toBeNull();
  });

  it('objects 非数组 → 空数组 + issue（不静默当无对象）', () => {
    const { descriptor, issues } = normalizeProviderDescriptor({ id: 'p', kind: 'fxiaoke', objects: { name: 'A' } });
    expect(descriptor.objects).toEqual([]);
    expect(issues.some((s) => s.includes('objects_not_array'))).toBe(true);
  });

  it('event_subscription 缺省关闭；给形状才认 enabled/objects', () => {
    expect(normalizeProviderDescriptor({ id: 'p', kind: 'fxiaoke' }).descriptor.event_subscription)
      .toEqual({ enabled: false, objects: [] });
    const on = normalizeProviderDescriptor({ id: 'p', kind: 'fxiaoke', event_subscription: { enabled: true, objects: ['AccountObj', '', 3] } });
    expect(on.descriptor.event_subscription).toEqual({ enabled: true, objects: ['AccountObj'] });
  });

  it('缺 id / kind → 整个描述符拒绝（无法实例化），并记 issue', () => {
    expect(normalizeProviderDescriptor({ kind: 'fxiaoke' }).descriptor).toBeNull();
    expect(normalizeProviderDescriptor({ id: 'p' }).descriptor).toBeNull();
    expect(normalizeProviderDescriptor(null).descriptor).toBeNull();
  });

  it('enabled 缺省为 false（未显式启用不得被当成启用）', () => {
    expect(normalizeProviderDescriptor({ id: 'p', kind: 'fxiaoke' }).descriptor.enabled).toBe(false);
  });

  it('normalizeProviderDescriptors：保留合法项、汇总 issues、不静默丢', () => {
    const { descriptors, issues } = normalizeProviderDescriptors([
      { id: 'a', kind: 'fxiaoke', enabled: true, objects: [{ name: 'A' }] },
      { kind: 'fxiaoke' },                    // 缺 id → 拒绝
      { id: 'b', kind: 'fxiaoke', objects: [{ name: 'B', direction: 'up' }] }, // 对象非法
    ]);
    expect(descriptors.map((d) => d.id)).toEqual(['a', 'b']);
    expect(descriptors[1].objects).toEqual([]);
    expect(issues.length).toBe(2); // id_missing + unknown_direction
    expect(normalizeProviderDescriptors(null)).toEqual({ descriptors: [], issues: [] });
    expect(normalizeProviderDescriptors({}).issues).toEqual(['integration-providers: not_an_array']);
  });

  it('inboundObjects：只返入向（出向由回写通道消费），缺 direction 视为入向（兼容直接构造的 targets）', () => {
    const { descriptor } = normalizeProviderDescriptor({
      id: 'p', kind: 'fxiaoke',
      objects: [{ name: 'A' }, { name: 'B', direction: 'out' }],
    });
    expect(inboundObjects(descriptor).map((o) => o.name)).toEqual(['A']);
    // 未经归一化的原始形状（调用方直接构造）同样适用同一判据
    expect(inboundObjects({ objects: [{ name: 'C' }, { name: 'D', direction: 'out' }, { direction: 'in' }] }).map((o) => o.name))
      .toEqual(['C']);
    expect(inboundObjects(null)).toEqual([]);
  });

  it('normalizeSyncObject 非法入参返回 issue 而非半成品', () => {
    expect(normalizeSyncObject(null).value).toBeUndefined();
    expect(normalizeSyncObject(null).issue).toContain('not_an_object');
  });
});
