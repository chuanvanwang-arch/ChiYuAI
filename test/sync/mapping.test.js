import { describe, it, expect } from 'vitest';
import { createMappingResolver } from '../../src/sync/mapping.js';

describe('sync mapping（声明式映射层）', () => {
  it('按映射配置把外部字段映射到粒子 payload（含类型转换）', () => {
    const m = createMappingResolver({
      mappings: {
        AccountObj: {
          particle_type: 'CRM_ACCOUNT',
          fields: [
            { ext: 'name', particle: 'name' },
            { ext: 'industry', particle: 'industry' },
          ],
        },
      },
    });
    const r = m.apply('AccountObj', { name: '客户A', industry: '制造', unknown_extra: 'x' });
    expect(r.ok).toBe(true);
    expect(r.payload.name).toBe('客户A');
    expect(r.payload.industry).toBe('制造');
    expect(r.payload.unknown_extra).toBeUndefined(); // 未知字段被拒（不进 payload）
  });

  it('未注册对象类型返回错（fail-closed）', () => {
    const m = createMappingResolver({ mappings: {} });
    const r = m.apply('GhostObj', { name: 'x' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('object_not_mapped');
  });

  // Q3-1（全链集成 §4）：未在 mappings.fields 声明的外部字段 → 拒绝并计入 skippedFields。
  // 契约原文："未在 mappings.fields 声明的外部字段被拒绝并计入 skipped；……不报错不静默"。
  // 既有 4 个用例覆盖了「正常映射 / 未注册对象 / external_id 两形状」，**独缺这一条**。
  it('未声明字段被拒并计入 skippedFields（不报错、不静默）', () => {
    const r = createMappingResolver({
      mappings: {
        AccountObj: {
          particle_type: 'CRM_ACCOUNT',
          fields: [{ ext: 'name', particle: 'company_name' }],
          identity: { external_id_field: '_id' },
        },
      },
    }).apply('AccountObj', { _id: 'x1', name: '甲公司', 未声明字段: 'y', 另一个: 'z' });
    expect(r.ok).toBe(true);                       // 不报错
    expect(r.payload).toEqual({ company_name: '甲公司' });  // 未声明字段**未**进入 payload
    expect(r.skippedFields).toEqual(expect.arrayContaining(['未声明字段', '另一个'])); // 且**可见**
    expect(r.external_id).toBe('x1');
  });

  it('已声明但值为 null/undefined 的字段 → 计入 skippedFields（与"未声明"同列可见）', () => {
    const r = createMappingResolver({
      mappings: { AccountObj: { particle_type: 'CRM_ACCOUNT', fields: [{ ext: 'name', particle: 'company_name' }] } },
    }).apply('AccountObj', { name: null });
    expect(r.payload).toEqual({});
    expect(r.skippedFields).toContain('name');
  });
});

// 外部 id 解析（设计 §9.1 identity.external_id_field）：映射声明优先于通用名
// 实坑：engine 原用硬编码 row.id||row.external_id → 纷享 _id 形状的行全被计 skipped，同步静默空转
describe('mapping · external_id 解析（identity.external_id_field）', () => {
  it('声明 external_id_field → 从该字段取（纷享 _id）', () => {
    const m = createMappingResolver({ mappings: {
      AccountObj: { particle_type: 'CRM_ACCOUNT', identity: { external_id_field: '_id' }, fields: [{ ext: 'name', particle: 'name' }] },
    } });
    expect(m.apply('AccountObj', { _id: 'a-9', name: 'A' }).external_id).toBe('a-9');
  });
  it('无声明 → 回退 row.id / row.external_id（零回归）', () => {
    const m = createMappingResolver({ mappings: {
      AccountObj: { particle_type: 'CRM_ACCOUNT', fields: [{ ext: 'name', particle: 'name' }] },
    } });
    expect(m.apply('AccountObj', { id: 'x-1', name: 'A' }).external_id).toBe('x-1');
    expect(m.apply('AccountObj', { external_id: 'x-2', name: 'A' }).external_id).toBe('x-2');
    expect(m.apply('AccountObj', { name: 'A' }).external_id).toBeNull();
  });
});
