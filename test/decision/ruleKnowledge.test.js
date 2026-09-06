// test/decision/ruleKnowledge.test.js — P3 D1 续：decision_rule 作为 Knowledge 第三载体注入 Pre（统一设计 v3 §3.5）
//
// 被测缺口（N4/F2「Knowledge 存在但零注入」残留）：`decision_rule` 此前仅被 S4 当治理维供给消费
// （ruleEngine.evaluateRules 只读 enabled 规则做命中校验），从未作为显式 Knowledge 清单注入决策前链路。
// 本文件锁死一条红线：getRuleKnowledge 必须只返回 enabled 规则——任何把 `WHERE enabled=true` 改没的回归都会立刻翻红。
//
// 反假绿：断言「禁用规则被排除」本身即 mutation 护栏（去掉 enabled 过滤 → 返回 3 条而非 2 条 → 红）。
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { query, pool } from '../../src/db.js';
import { getRuleKnowledge } from '../../src/knowledge/methodologyInjection.js';

// 仅动本文件自有的 3 个 code，避免 TRUNCATE 共享表污染其它测试 fixture（隔离纪律）
const CODES = ['RK_STAGE_FWD', 'RK_BUDGET_FLOOR', 'RK_DISABLED', 'RK_ACC_MERGE'];

async function cleanMine() {
  await query(`DELETE FROM crm.decision_rule WHERE code = ANY($1)`, [CODES]);
}
async function seedMine() {
  await cleanMine();
  const rows = [
    // 两条启用、CRM_DEAL 域
    ['RK_STAGE_FWD', 'CRM_DEAL.advance', { from: 'lead' }, { stage_forward_only: true }, true],
    ['RK_BUDGET_FLOOR', 'CRM_DEAL.qualify', { min: 100000 }, { budget_floor: true }, true],
    // 一条禁用（必须被排除）
    ['RK_DISABLED', 'CRM_DEAL.advance', {}, {}, false],
    // 一条启用但 CRM_ACCOUNT 域（entityType 过滤用例用）
    ['RK_ACC_MERGE', 'CRM_ACCOUNT.merge', {}, { dedup: true }, true],
  ];
  for (const [code, match_type, mp, cp, enabled] of rows) {
    await query(
      `INSERT INTO crm.decision_rule (code, match_type, match_payload, check_payload, enabled, decision_id)
       VALUES ($1,$2,$3::jsonb,$4::jsonb,$5, NULL)
       ON CONFLICT (code) DO NOTHING`,
      [code, match_type, JSON.stringify(mp), JSON.stringify(cp), enabled]
    );
  }
}

beforeEach(async () => { await seedMine(); });
afterAll(async () => { await cleanMine(); });

// 只断言本文件自造的 code（2026-09-03 隔离加固）：
//   原实现直接断言 getRuleKnowledge(pool).length（**全表长度**）→ 任何外来 decision_rule 行
//   （如 test/http/preContext.contract.test.js 的 TEST_RULE_NO_SIDE_DEAL，跨会话并发跑时残留）
//   都会把 3 击穿成 4，造成与被测代码无关的假红。按 CODES 过滤后断言，语义不变、隔离自持。
const mineOnly = (list) => list.filter((r) => CODES.includes(r.code));

describe('getRuleKnowledge — 第三载体 Knowledge 注入', () => {
  it('红线：仅返回 enabled 规则（禁用规则被排除）', async () => {
    const all = await getRuleKnowledge(pool);
    expect(Array.isArray(all)).toBe(true);
    const list = mineOnly(all);
    // 启用 3 条（2×CRM_DEAL + 1×CRM_ACCOUNT），禁用 1 条被排除
    expect(list.length).toBe(3);
    const codes = list.map((r) => r.code).sort();
    expect(codes).toEqual(['RK_ACC_MERGE', 'RK_BUDGET_FLOOR', 'RK_STAGE_FWD']);
    expect(list.find((r) => r.code === 'RK_DISABLED')).toBeUndefined();
  });

  it('entityType 前缀过滤：只返回匹配实体域的启用规则', async () => {
    const list = mineOnly(await getRuleKnowledge(pool, { entityType: 'CRM_DEAL' }));
    expect(list.length).toBe(2);
    expect(list.every((r) => String(r.match_type).startsWith('CRM_DEAL.'))).toBe(true);
    expect(list.find((r) => r.code === 'RK_ACC_MERGE')).toBeUndefined();
  });

  it('空库返回空数组（不返回 null，fail-open 友好）', async () => {
    await cleanMine();
    const list = await getRuleKnowledge(pool);
    expect(Array.isArray(list)).toBe(true);           // fail-open：空结果是 [] 而非 null
    expect(mineOnly(list)).toEqual([]);               // 只对本文件 code 负责，不受外来行干扰
    await seedMine(); // 还原，供后续用例
  });

  it('返回结构含人类可读 scope_hint（match_type 透传）', async () => {
    const list = await getRuleKnowledge(pool);
    const fwd = list.find((r) => r.code === 'RK_STAGE_FWD');
    expect(fwd).toBeDefined();
    expect(fwd.scope_hint).toBe('CRM_DEAL.advance');
    expect(fwd.match_payload).toBeDefined();
    expect(fwd.check_payload).toBeDefined();
  });
});
