// test/billing/pricing.test.js — 计价纯函数单测（零 DB）
import { describe, test, expect } from 'vitest';
import { computeBilling } from '../../src/billing/pricing.js';

const pro = { base_fee: 199, included_seats: 20, seat_unit_price: 99, included_tokens: 1000000, token_overage_unit_price: 0.020 };

describe('computeBilling（2026-09-04 批准的按席位单线模型：账号费 = 席位 × 单席价，token_fee 恒 0）', () => {
  test('超席场景：seat_fee = 单席价 × 席位数，无独立 Token 费', () => {
    const b = computeBilling(pro, 1200000, 800000, 25);
    expect(b.seat_fee).toBeCloseTo(2475, 2); // 25 × 99
    expect(b.token_fee).toBe(0);
    expect(b.total_fee).toBeCloseTo(2475, 2);
  });

  test('未超量时仍按席位计费（10 × 99 = 990）', () => {
    const b = computeBilling(pro, 100000, 0, 10);
    expect(b.seat_fee).toBe(990);
    expect(b.token_fee).toBe(0);
    expect(b.total_fee).toBe(990);
  });

  test('企业版不限（-1）不计超额', () => {
    const ent = { base_fee: 0, included_seats: -1, seat_unit_price: 0, included_tokens: -1, token_overage_unit_price: 0 };
    const b = computeBilling(ent, 9e9, 9e9, 999);
    expect(b.seat_fee).toBe(0);
    expect(b.token_fee).toBe(0);
    expect(b.total_fee).toBe(0);
  });

  test('席位 NaN 容错（seats→0 → 不计费）', () => {
    const b = computeBilling(pro, 0, 0, undefined);
    expect(b.seat_count).toBe(0);
    expect(b.seat_fee).toBe(0);
    expect(b.total_fee).toBe(0);
  });
});
