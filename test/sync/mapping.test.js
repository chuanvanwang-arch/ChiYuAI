import { describe, it, expect } from 'vitest';
import { createMappingResolver } from 'file:///D:/system/CRM-ai-native/src/sync/mapping.js';

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
