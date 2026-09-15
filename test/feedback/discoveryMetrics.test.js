// test/feedback/discoveryMetrics.test.js — Task 12（P0#4）feedback-loop 指标模板 + evaluator + Token 对账
// 纪律：本文件零 PG 依赖（落库走注入式 recorder 替身；指标模板/evaluator 为纯函数）。
// 权威：docs/2026-09-10-lead-discovery-design.md §9.11；test-plan（evaluator 返回 {score,verdict}）。
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  METRIC_TEMPLATES, METRIC_KEYS, SEVEN_KEYS, RECONCILE_FACILITY,
  evaluate, verdictOf, actionsFor, ledgerCost,
} from '../../src/feedback/discoveryMetrics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, '../../src/feedback/discoveryMetrics.js');

// ① 七要素齐 + 恰 3 指标（含冻结值 + 真实 id）
describe('① 指标模板：七要素齐 + 恰 3 指标', () => {
  it('METRIC_KEYS 恰为 3 项且顺序冻结', () => {
    expect(METRIC_KEYS).toEqual([
      'discovered_to_won_rate', 'enrichment_coverage', 'monitorAccount_refresh_rate',
    ]);
    expect(METRIC_KEYS.length).toBe(3);
  });

  it('SEVEN_KEYS 恰 7 项且逐字等于权威定义', () => {
    expect(SEVEN_KEYS.length).toBe(7);
    expect(SEVEN_KEYS).toEqual([
      'direction', 'formula', 'target', 'alert', 'owner_agent', 'evaluator_skill', 'adjust_actions',
    ]);
  });

  it('每个模板七要素齐 + 形状正确', () => {
    for (const k of METRIC_KEYS) {
      const t = METRIC_TEMPLATES[k];
      expect(SEVEN_KEYS.every((key) => key in t)).toBe(true);
      expect(['up', 'down']).toContain(t.direction);
      expect(typeof t.formula === 'string' && t.formula.length > 0).toBe(true);
      expect(typeof t.target).toBe('number');
      expect(typeof t.alert).toBe('number');
      expect(typeof t.owner_agent === 'string' && t.owner_agent.length > 0).toBe(true);
      expect(typeof t.evaluator_skill === 'string' && t.evaluator_skill.length > 0).toBe(true);
      expect(Array.isArray(t.adjust_actions) && t.adjust_actions.length > 0).toBe(true);
    }
  });

  it('冻结值：monitorAccount_refresh_rate.target===0.9；discovered_to_won_rate target/alert', () => {
    expect(METRIC_TEMPLATES.monitorAccount_refresh_rate.target).toBe(0.9);
    expect(METRIC_TEMPLATES.discovered_to_won_rate.target).toBe(0.15);
    expect(METRIC_TEMPLATES.discovered_to_won_rate.alert).toBe(0.08);
  });

  it('owner_agent / evaluator_skill 为真实存在 id（防虚构）', () => {
    for (const k of METRIC_KEYS) {
      expect(METRIC_TEMPLATES[k].owner_agent).toBe('decision-retro');
      expect(METRIC_TEMPLATES[k].evaluator_skill).toBe('method-decision-enrich');
    }
  });
});

// ② Token–业务因果对账字段存在（注入式 recorder，零 PG）
describe('② ledgerCost：Token-业务因果对账字段存在', () => {
  it('返回对账记录对象 + recorder 恰调 1 次且入参正确', async () => {
    const recorder = vi.fn().mockResolvedValue({ ok: true });
    const rec = await ledgerCost({
      accountId: 'ACC-1', provider: 'gaode', cost: 0.01,
      tokensIn: 120, tokensOut: 30, tenantId: 't12', decisionId: 'DEC-1', recorder,
    });
    expect(rec).toMatchObject({
      account_id: 'ACC-1', provider: 'gaode', cost: 0.01,
      decision_id: 'DEC-1', tenant_id: 't12',
    });
    expect(rec.tokens).toEqual({ in: 120, out: 30 });
    expect(rec.ts).toBeTruthy();
    expect(recorder).toHaveBeenCalledTimes(1);
    const arg = recorder.mock.calls[0][0];
    expect(arg).toMatchObject({
      source: 'discovery-provider', action: 'discovery:gaode',
      module: 'discovery', tenantId: 't12', decision_id: 'DEC-1',
    });
    expect(arg.tokensIn).toBe(120);
    expect(arg.tokensOut).toBe(30);
  });
});

// ③ evaluator 返回 {score, verdict} 三档 + 边界闭区间 + 单调性 + 未知指标 throw
describe('③ evaluate：{score,verdict} 三档 + 边界 + 单调 + fail-closed', () => {
  const m = 'discovered_to_won_rate';

  it('返回 {score,verdict} 形状，score 为 0..1 数字', () => {
    const r = evaluate(m, 0.20);
    expect(Object.keys(r).sort()).toEqual(['score', 'verdict']);
    expect(typeof r.score).toBe('number');
    expect(r.score).toBeGreaterThan(0);
    expect(r.score).toBeLessThanOrEqual(1);
  });

  it('三档：0.20→green / 0.10→yellow / 0.02→red', () => {
    expect(evaluate(m, 0.20).verdict).toBe('green');
    expect(evaluate(m, 0.10).verdict).toBe('yellow');
    expect(evaluate(m, 0.02).verdict).toBe('red');
  });

  it('边界闭区间：value===target → green；value===alert → yellow', () => {
    const t = METRIC_TEMPLATES[m];
    expect(evaluate(m, t.target).verdict).toBe('green');
    expect(evaluate(m, t.alert).verdict).toBe('yellow');
  });

  it('score 单调不降（同指标）', () => {
    expect(evaluate(m, 0.20).score).toBeGreaterThanOrEqual(evaluate(m, 0.10).score);
    expect(evaluate(m, 0.10).score).toBeGreaterThanOrEqual(evaluate(m, 0.02).score);
  });

  it('未知指标 → throw（fail-closed，非静默默认档）', () => {
    expect(() => evaluate('nope', 1)).toThrow();
  });
});

// ④ down/up 方向语义（防方向写死）
describe('④ verdictOf：down/up 方向语义', () => {
  it('down：越小越好（0.01→green，0.06→red）', () => {
    expect(verdictOf({ direction: 'down', target: 0.03, alert: 0.05 }, 0.01)).toBe('green');
    expect(verdictOf({ direction: 'down', target: 0.03, alert: 0.05 }, 0.06)).toBe('red');
  });

  it('up：越大越好（0.95→green）', () => {
    expect(verdictOf({ direction: 'up', target: 0.9, alert: 0.7 }, 0.95)).toBe('green');
  });
});

// ⑤ 红档动作 = 回滚/重校准而非仅熔断
describe('⑤ actionsFor：红档回滚/重校准，绿档空', () => {
  it('全部指标红档非空', () => {
    for (const k of METRIC_KEYS) {
      expect(actionsFor(k, 'red').length).toBeGreaterThan(0);
    }
  });

  it('回滚语义指标（discovered_to_won_rate）红档含 rollback/recalibrate', () => {
    const acts = actionsFor('discovered_to_won_rate', 'red');
    expect(acts.length).toBeGreaterThan(0);
    expect(acts.some((a) => /rollback|recalibrat/i.test(a))).toBe(true);
  });

  it('绿档为空数组', () => {
    expect(actionsFor('discovered_to_won_rate', 'green')).toEqual([]);
  });

  it('未知指标 → throw', () => {
    expect(() => actionsFor('nope', 'red')).toThrow();
  });
});

// ⑥ 零 PG + 禁 DELETE + 复用证据（fs 读源码）
describe('⑥ 源码纪律：零 PG + 禁 DELETE + 复用 tokenAccounting', () => {
  const code = fs.readFileSync(SRC, 'utf8');

  it('不匹配 /DELETE\\s+FROM|\\.delete\\s*\\(/i', () => {
    expect(/DELETE\s+FROM|\.delete\s*\(/i.test(code)).toBe(false);
  });

  it('不含虚构表名 discovery_cost_ledger', () => {
    expect(code.includes('discovery_cost_ledger')).toBe(false);
  });

  it('^import 行不含 pg / db.js（纯函数模块）', () => {
    const imports = code.split('\n').filter((l) => /^\s*import\b/.test(l));
    expect(imports.length).toBeGreaterThan(0);
    for (const l of imports) {
      expect(/from\s+['"].*pg['"]/.test(l)).toBe(false);
      expect(/db\.js/.test(l)).toBe(false);
    }
  });

  it("含 from '../alerts/tokenAccounting.js'（复用真实设施）", () => {
    expect(code.includes("from '../alerts/tokenAccounting.js'")).toBe(true);
  });
});

// ⑦ 文档锚点常量
describe('⑦ RECONCILE_FACILITY 锚点常量', () => {
  it("=== 'token_accounting+reconcileTokenToBusiness'", () => {
    expect(RECONCILE_FACILITY).toBe('token_accounting+reconcileTokenToBusiness');
  });
});
