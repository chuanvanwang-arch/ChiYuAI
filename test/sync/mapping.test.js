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
