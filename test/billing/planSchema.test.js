// test/billing/planSchema.test.js — 套餐 schema 校验单测（DB-free）
// 守护点：
//   V1 合法套餐通过；V2 plan_id 格式/重复；V3 负数/非法数值；V4 included_seats 边界；
//   V5 权益白名单 fail-closed；V6 超量模式枚举；V7 白名单与 seed-actions requiresEntitlement 声明不漂移
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { validatePlan, validatePlans, KNOWN_ENTITLEMENTS } from '../../src/billing/planSchema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const goodPlan = {
  plan_id: 'pro', name: '增强版 · Pro', quote: '¥2980 / 账号·月',
  seat_unit_price: 2980, base_fee: 0, included_seats: 0,
  included_tokens: 1000000, token_hard_cap: 3000000,
  token_overage_mode: 'bill', token_overage_unit_price: 0.02,
  entitlements: ['core_crm', 'ai_agents', 'approval_flow'], enabled: true,
};

describe('planSchema.validatePlan', () => {
  it('V1 合法套餐通过', () => {
    const r = validatePlan(goodPlan);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });
  it('V1b 缺省可省字段（token_hard_cap 留空=不限）通过', () => {
    const r = validatePlan({ plan_id: 'mini', name: '迷你版', token_hard_cap: null });
    expect(r.ok).toBe(true);
  });
  it('V2 plan_id 非法格式被拒', () => {
    const r = validatePlan({ ...goodPlan, plan_id: 'Pro X!' });
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toContain('plan_id 非法');
  });
  it('V2b 跨档位 plan_id 重复被拒（validatePlans）', () => {
    const r = validatePlans([goodPlan, { ...goodPlan, name: '副本' }]);
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toContain('plan_id 重复');
  });
  it('V3 -1=不限 哨兵合法（seat_unit_price/included_tokens，对齐 seed 口径），-2 与非数字被拒', () => {
    expect(validatePlan({ ...goodPlan, seat_unit_price: -1 }).ok).toBe(true);
    expect(validatePlan({ ...goodPlan, included_tokens: -1 }).ok).toBe(true);
    const r1 = validatePlan({ ...goodPlan, seat_unit_price: -2 });
    expect(r1.ok).toBe(false);
    expect(r1.errors.join()).toContain('seat_unit_price');
    const r2 = validatePlan({ ...goodPlan, base_fee: -1 }); // base_fee 无 -1 语义，严格 ≥0
    expect(r2.ok).toBe(false);
    expect(r2.errors.join()).toContain('base_fee');
    const r3 = validatePlan({ ...goodPlan, seat_unit_price: '贵' });
    expect(r3.ok).toBe(false);
    expect(r3.errors.join()).toContain('seat_unit_price');
  });
  it('V3b 非数字价格被拒', () => {
    const r = validatePlan({ ...goodPlan, base_fee: '贵' });
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toContain('base_fee');
  });
  it('V4 included_seats -1/0/N 合法，-2 与小数被拒', () => {
    expect(validatePlan({ ...goodPlan, included_seats: -1 }).ok).toBe(true);
    expect(validatePlan({ ...goodPlan, included_seats: 25 }).ok).toBe(true);
    expect(validatePlan({ ...goodPlan, included_seats: -2 }).ok).toBe(false);
    expect(validatePlan({ ...goodPlan, included_seats: 1.5 }).ok).toBe(false);
  });
  it('V5 未登记权益键 fail-closed', () => {
    const r = validatePlan({ ...goodPlan, entitlements: ['core_crm', 'magic_ai'] });
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toContain('magic_ai');
  });
  it('V5b entitlements 非数组被拒', () => {
    const r = validatePlan({ ...goodPlan, entitlements: 'core_crm' });
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toContain('字符串数组');
  });
  it('V6 超量模式只允许 bill/block/none（none=不限量，seed 五档在用）', () => {
    expect(validatePlan({ ...goodPlan, token_overage_mode: 'bill' }).ok).toBe(true);
    expect(validatePlan({ ...goodPlan, token_overage_mode: 'block' }).ok).toBe(true);
    expect(validatePlan({ ...goodPlan, token_overage_mode: 'none' }).ok).toBe(true);
    const r = validatePlan({ ...goodPlan, token_overage_mode: 'explode' });
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toContain('token_overage_mode');
  });
  it('V6b enabled 非布尔被拒', () => {
    const r = validatePlan({ ...goodPlan, enabled: 'yes' });
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toContain('enabled');
  });
  it('V6c token_hard_cap 须 >0 或留空', () => {
    expect(validatePlan({ ...goodPlan, token_hard_cap: null }).ok).toBe(true);
    expect(validatePlan({ ...goodPlan, token_hard_cap: 0 }).ok).toBe(false);
    expect(validatePlan({ ...goodPlan, token_hard_cap: -5 }).ok).toBe(false);
  });
  it('V6d features 字符串数组通过', () => {
    const r = validatePlan({ ...goodPlan, features: ['含 3 席位', '核心 CRM（客户/商机/合同/报价/回款）', '社区支持'] });
    expect(r.ok).toBe(true);
  });
  it('V6d2 features 旧 string 形态读路径兼容放行', () => {
    const r = validatePlan({ ...goodPlan, features: '核心 CRM（...）/ 社区支持' });
    expect(r.ok).toBe(true);
  });
  it('V6d3 features 数组项须为非空字符串；非 string/非数组形态被拒', () => {
    const r1 = validatePlan({ ...goodPlan, features: ['合法', ''] });
    expect(r1.ok).toBe(false);
    expect(r1.errors.join()).toContain('非空字符串');
    const r2 = validatePlan({ ...goodPlan, features: ['合法', 123] });
    expect(r2.ok).toBe(false);
    const r4 = validatePlan({ ...goodPlan, features: 123 });
    expect(r4.ok).toBe(false);
    expect(r4.errors.join()).toContain('features 须为');
  });
  it('V6d4 features 单项 >200 字被拒', () => {
    const r = validatePlan({ ...goodPlan, features: ['x'.repeat(201)] });
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toContain('过长');
  });
});

describe('planSchema 白名单防漂移', () => {
  it('V7 seed-actions 所有 requiresEntitlement 声明的权益键都在白名单内', () => {
    const src = readFileSync(path.join(ROOT, 'src/action/seed-actions.js'), 'utf8');
    const declared = new Set();
    for (const m of src.matchAll(/requiresEntitlement:\s*\[([^\]]*)\]/g)) {
      for (const k of m[1].matchAll(/'([a-z0-9_]+)'/g)) declared.add(k[1]);
    }
    expect(declared.size).toBeGreaterThan(0); // 确认真解析到了声明
    const unknown = [...declared].filter((k) => !KNOWN_ENTITLEMENTS.includes(k));
    expect(unknown).toEqual([]); // 新增权益键须同步 planSchema.KNOWN_ENTITLEMENTS
  });
  it('V7b 白名单含现网五档在用的全部 13 个权益键', () => {
    expect(KNOWN_ENTITLEMENTS).toEqual(expect.arrayContaining([
      'core_crm', 'ai_agents', 'customer_360', 'decision_autonomy', 'event_automation',
      'approval_flow', 'llm_config', 'mcp_access', 'advanced_reporting', 'audit_provenance',
      'industry_config', 'rbac_advanced', 'memory',
    ]));
  });
  it('V8 db/seed-billing-config.sql 现网五档全部通过校验（防校验器与种子配置漂移）', () => {
    const sql = readFileSync(path.join(ROOT, 'db/seed-billing-config.sql'), 'utf8');
    const m = sql.match(/'(\[[\s\S]*?\])'\s*::jsonb/); // billing-plans 数组字面量（settings 为对象字面量，不匹配）
    expect(m).toBeTruthy();
    const plans = JSON.parse(m[1]);
    expect(plans).toHaveLength(5);
    const r = validatePlans(plans);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });
});
