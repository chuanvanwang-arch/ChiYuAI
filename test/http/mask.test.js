// 出参脱敏中间件（P0② 展示层，不落库）：个人字段默认*** / 商业敏感仅 exec/sysadmin
// TDD：maskFields 纯函数 + 配置化字段表 —— 计划 §Task3
import { describe, it, expect } from 'vitest';
import { maskFields } from '../../src/http/middleware/mask.js';

const DEFAULT_MASK_CFG = {
  personal: ['phone_numbers', 'email_addresses'],
  commercial: ['list_price', 'net_price', 'commission_rate'],
};

describe('maskFields 分级脱敏', () => {
  it('个人字段默认脱敏为 ***', () => {
    const out = maskFields({ phone_numbers: '13800138000', email_addresses: 'a@b.com' }, { role: 'sales' }, DEFAULT_MASK_CFG);
    expect(out.phone_numbers).toBe('***');
    expect(out.email_addresses).toBe('***');
  });

  it('商业敏感字段仅 exec/sysadmin 可见，其他角色 ***', () => {
    const out = maskFields({ list_price: 1000, net_price: 800 }, { role: 'sales' }, DEFAULT_MASK_CFG);
    expect(out.list_price).toBe('***');
    const outExec = maskFields({ list_price: 1000, net_price: 800 }, { role: 'exec' }, DEFAULT_MASK_CFG);
    expect(outExec.list_price).toBe(1000);
  });

  it('配置化字段表可覆盖（自定义字段也脱敏）', () => {
    const out = maskFields({ cost_base: 500 }, { role: 'finance' }, { ...DEFAULT_MASK_CFG, commercial: ['cost_base'] });
    expect(out.cost_base).toBe('***'); // finance 非 exec/sysadmin → commercial 也脱敏
  });

  it('非敏感字段原样透传', () => {
    const out = maskFields({ name: '张三', stage: 'S2' }, { role: 'sales' }, DEFAULT_MASK_CFG);
    expect(out.name).toBe('张三');
    expect(out.stage).toBe('S2');
  });

  it('脱敏不落库（纯展示层）：原对象不变', () => {
    const original = { list_price: 1000 };
    const out = maskFields(original, { role: 'sales' }, DEFAULT_MASK_CFG);
    expect(out.list_price).toBe('***');
    expect(original.list_price).toBe(1000);
  });
});
