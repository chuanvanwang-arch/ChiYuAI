// test/signal/derivationConfigTemplate.test.js — 派生配置模板守卫
// 为什么需要：阈值/窗口/启停必须 100% 配置化（零代码字面量）。若模板缺字段，派生器会以
//   「规则不完整 → 不命中」静默归零，而配置页显示"已配置"——正是需要防的假绿形态。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const sql = readFileSync(new URL('../../db/migration-internal-signal-derivation-config.sql', import.meta.url), 'utf8');

describe('internal-signal-derivation 模板', () => {
  it('含两条规则 id 与 kind', () => {
    expect(sql).toContain('contact-ledger-change');
    expect(sql).toContain('relation-cooling');
    expect(sql).toContain('contact_change');
    expect(sql).toContain('relation_cooling');
  });

  it('阈值齐全：window_days 与 threshold_days 各就位（缺一会使规则不命中）', () => {
    expect(sql).toMatch(/"window_days"\s*:\s*\d+/);
    expect(sql).toMatch(/"threshold_days"\s*:\s*\d+/);
  });

  it('不出现无源字段（招聘/新战略的桩映射一律禁止）', () => {
    const code = sql.replace(/--[^\n]*/g, '');
    expect(code).not.toMatch(/hiring|strategy_shift|new_strategy|leadership_change/);
  });

  it('零 DELETE / 零 DROP / 不使用 ON CONFLICT (key)', () => {
    const code = sql.replace(/--[^\n]*/g, '');
    expect(code).not.toMatch(/\bDELETE\b/i);
    expect(code).not.toMatch(/\bDROP\b/i);
    expect(code).not.toMatch(/ON\s+CONFLICT\s*\(\s*key\s*\)/i);
  });

  it('幂等：WHERE NOT EXISTS 按 key 判存在', () => {
    expect(sql).toMatch(/WHERE\s+NOT\s+EXISTS[\s\S]*key\s*=\s*'internal-signal-derivation'/i);
  });
});
