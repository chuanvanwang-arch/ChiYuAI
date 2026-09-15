// test/action/leadQualifyGate.test.js — S0P→S1（升级「正式线索」）B/A/T 硬闸
// 设计：docs/2026-09-11-lead-public-pool-tenant-design.md §3.5.2
// 五层：① 纯判据  ② 闸门集成  ③ 三件套一致性  ④ D1 DRY 同源  ⑤ D2 qualified_at 落库
import { test, describe, vi } from 'vitest';
import assert from 'node:assert';
import { leadQualifyGap, bantMissing } from '../../src/sales/leadQualify.js';
import { salesStageGate, salesDealPrereq } from '../../src/action/executor.js';

const full = { bantcc: { budget: 100, authority: 'CTO', timetable_ok: true } };

// ── ⑤ D2 落库：handler 直调，mock 粒子仓 + 规则引擎（不经 executor 写通道） ──
const H = vi.hoisted(() => ({ updates: [] }));
vi.mock('../../src/db.js', () => ({
  query: async () => ({ rows: [] }), queryWrite: async () => ({ rows: [] }),
}));
vi.mock('../../src/ruleEngine.js', () => ({
  ruleEngine: { check: async () => ({ ok: true, reasons: [] }) },
}));
vi.mock('../../src/events/bus.js', () => ({ emit: () => {} }));
vi.mock('../../src/particles/particleRepo.js', () => ({
  getParticle: async () => ({
    id: 'd1', type: 'CRM_DEAL',
    payload: { stage: 'S0P', bantcc: { budget: 'x', authority: 'y', timetable_ok: true } },
  }),
  updateParticle: async (id, arg) => {
    H.updates.push(arg);
    return { id, type: 'CRM_DEAL', payload: { stage: 'S0P', ...(arg && arg.patch ? arg.patch : {}) } };
  },
  createParticle: async (type, payload) => ({ id: 'k1', type, payload }),
  createEdge: async () => ({}),
  queryParticles: async () => [],
  queryNeighbors: async () => [],
}));

describe('① 纯判据 leadQualifyGap / bantMissing（零 DB）', () => {
  test('B/A/T 三要素齐 → null（放行）', () => {
    assert.strictEqual(leadQualifyGap(full), null);
  });
  test('缺预算 → 返回缺失串（含「预算」）', () => {
    const g = leadQualifyGap({ bantcc: { authority: 'CTO', timetable_ok: true } });
    assert.ok(typeof g === 'string' && g.includes('预算'));
  });
  test('ai.bantcc_completeness >= pass → null（AI 评估路径）', () => {
    assert.strictEqual(leadQualifyGap({ ai: { bantcc_completeness: { value: 0.75 } } }, { pass: 0.6 }), null);
  });
  test('ai 低于 pass 且三要素缺 → 返回串（不得假绿）', () => {
    const g = leadQualifyGap({ ai: { bantcc_completeness: { value: 0.4 } } }, { pass: 0.6 });
    assert.ok(typeof g === 'string' && g.length > 0);
  });
  test('bantMissing 缺项精确有序（预算/责任人/时间表）', () => {
    assert.deepStrictEqual(bantMissing({}), ['预算', '责任人', '时间表']);
    assert.deepStrictEqual(bantMissing({ budget: 'x' }), ['责任人', '时间表']);
    assert.deepStrictEqual(bantMissing({ budget: 'x', authority: 'y', timetable_ok: true }), []);
  });
  test('ai 为裸数字亦识别（判据比 .value-only 更宽容，不误杀）', () => {
    assert.strictEqual(leadQualifyGap({ ai: { bantcc_completeness: 0.9 } }, { pass: 0.6 }), null);
  });
  test('P0-2b：B/A/T 齐但决策链缺角色 → 仍然拦截（决策链完整性并入升级闸）', () => {
    // B/A/T 齐（bantMissing=[]）但 decision_chain 缺 approve → 不得放行（防假绿：仅看 B/A/T 会误放）
    const g = leadQualifyGap({
      bantcc: { budget: 100, authority: 'CTO', timetable_ok: true },
      decision_chain: {
        contacts: [
          { title: '采购总监', department: '采购', decision_power: 'veto' },
          { title: '研发经理', department: '研发', decision_power: 'recommend' },
          { title: 'CFO', department: '财务', decision_power: 'budget' },
        ],
      },
    }, { pass: 0.6 });
    assert.ok(typeof g === 'string' && g.includes('决策链'));
  });
  test('P0-2b：B/A/T 齐 + 决策链完整 → 放行', () => {
    const g = leadQualifyGap({
      bantcc: { budget: 100, authority: 'CTO', timetable_ok: true },
      decision_chain: {
        contacts: [
          { title: '采购总监', department: '采购', decision_power: 'veto' },
          { title: '研发经理', department: '研发', decision_power: 'recommend' },
          { title: 'CFO', department: '财务', decision_power: 'budget' },
          { title: '总经理', department: '管理层', decision_power: 'approve' },
        ],
      },
    }, { pass: 0.6 });
    assert.strictEqual(g, null);
  });
});

describe('② 闸门集成 salesStageGate', () => {
  test('B/A/T 三要素齐 → S0P→S1 放行', () => {
    const v = salesStageGate({ curStage: 'S0P', toStage: 'S1', dealPayload: full });
    assert.strictEqual(v.ok, true);
    assert.deepStrictEqual(v.gaps, []);
  });
  test('缺预算 → S0P→S1 硬拦', () => {
    const v = salesStageGate({
      curStage: 'S0P', toStage: 'S1',
      dealPayload: { bantcc: { authority: 'CTO', timetable_ok: true } },
    });
    assert.strictEqual(v.ok, false);
    assert.ok(v.gaps.join(';').includes('预算'));
  });
  test('ai.bantcc_completeness>=0.6 → 放行（AI 评估路径）', () => {
    const v = salesStageGate({
      curStage: 'S0P', toStage: 'S1',
      dealPayload: { ai: { bantcc_completeness: { value: 0.75 } } },
    });
    assert.strictEqual(v.ok, true);
  });
  test('S0→S1 无闸定义（合法性由 S_TRANSITIONS 保证，不造放行假象）', () => {
    const v = salesStageGate({ curStage: 'S0', toStage: 'S1', dealPayload: full });
    assert.strictEqual(v.gaps.length, 0);
  });
});

describe('③ 三件套一致性（声明 ↔ 证据 ↔ 机器实现）', () => {
  test('S_GATE_DEFS 的 S0P→S1 key 可被 GATE_EVIDENCE 解析', async () => {
    const { S_GATE_DEFS } = await import('../../src/sales/stageTaxonomy.js');
    const def = S_GATE_DEFS.find((g) => g.from === 'S0P' && g.to === 'S1');
    assert.ok(def, 'S_GATE_DEFS 必须含 S0P→S1 条目');
    assert.strictEqual(def.key, 'bantcc_lead');
    assert.strictEqual(def.hard, true);
    // 锚定：该 key 必须同时存在于 seed-actions 的证据表（反向防漏）
    const src = await import('node:fs').then((m) => m.readFileSync('src/action/seed-actions.js', 'utf8'));
    assert.ok(src.includes('bantcc_lead:'), 'GATE_EVIDENCE 必须含 bantcc_lead 键（否则建议恒报缺证据）');
  });
  test('S0P→S1 无强制附件门（attach=null 且 S_ATTACHMENT_GATES 无该键）', async () => {
    const { S_ATTACHMENT_GATES } = await import('../../src/sales/stageTaxonomy.js');
    assert.ok(!S_ATTACHMENT_GATES['S0P->S1'], 'S0P→S1 不应有强制附件门');
  });
  test('D6 索引不变量：S0P→S1 为末尾追加，S_GATE_DEFS[0] 仍 S1→S2（免 DB 守护 discoveryToS1.test.js:128）', async () => {
    const { S_GATE_DEFS } = await import('../../src/sales/stageTaxonomy.js');
    assert.strictEqual(S_GATE_DEFS[0].from, 'S1');
    assert.strictEqual(S_GATE_DEFS[0].to, 'S2');
  });
});

describe('④ D1 DRY：建单闸 salesDealPrereq 与共享判定核 bantMissing 同源', () => {
  test('同一 payload 判定一致（missing 逐项相等）', () => {
    const cases = [
      { bantcc: {} },
      { bantcc: { budget: 'x' } },
      { bantcc: { budget: 'x', authority: 'y' } },
      { bantcc: { budget: 'x', authority: 'y', timetable_ok: true } },
      { bantcc: { schedule: '2026-12' } },
    ];
    for (const c of cases) {
      const missing = bantMissing(c.bantcc);
      const r = salesDealPrereq({ stage: 'S3', ...c });
      assert.deepStrictEqual(r.missing, missing, JSON.stringify(c));
      assert.strictEqual(r.ok, missing.length === 0, JSON.stringify(c));
    }
  });
  test('salesDealPrereq 保持 .value-only AI 语义（不因委托而宽化）', () => {
    // 裸数字 ai.bantcc_completeness 在 salesDealPrereq 中按原语义视作未评估
    const r = salesDealPrereq({ stage: 'S3', ai: { bantcc_completeness: 0.9 } });
    assert.strictEqual(r.ok, false);
  });
});

describe('⑤ D2 落库：S0P→S1 落 qualified_at / qualified_by', () => {
  test('通过该边 → 最终 updateParticle patch 含 stage=S1 + qualified_at/qualified_by', async () => {
    H.updates.length = 0;
    vi.resetModules();
    const { seedActions } = await import('../../src/action/seed-actions.js');
    const { getAction, resetRegistry } = await import('../../src/action/registry.js');
    resetRegistry();
    seedActions();
    const def = getAction('crm-deal-advance');
    assert.ok(def, 'crm-deal-advance 必须已注册');
    await def.handler(
      { deal_id: 'd1', to_stage: 'S1', transitionedBecause: 'BANT 三要素齐' },
      { actor: 'alice', tenantId: 'system', decision_id: 'dec-1' },
    );
    const patches = H.updates.map((u) => (u && u.patch) || null).filter(Boolean);
    const last = patches[patches.length - 1];
    assert.ok(last, 'handler 必须调用 updateParticle 落库');
    assert.strictEqual(last.stage, 'S1');
    assert.ok(last.qualified_at, 'qualified_at 必须写入（设计 §3.5.2）');
    assert.strictEqual(last.qualified_by, 'alice');
  });
  test('非 S0P→S1 边不写 qualified_at（不误伤）', async () => {
    H.updates.length = 0;
    vi.resetModules();
    const { seedActions } = await import('../../src/action/seed-actions.js');
    const { getAction, resetRegistry } = await import('../../src/action/registry.js');
    resetRegistry();
    seedActions();
    const def = getAction('crm-deal-advance');
    await def.handler(
      { deal_id: 'd1', to_stage: 'S3', transitionedBecause: 'x' },
      { actor: 'alice', tenantId: 'system', decision_id: 'dec-1' },
    );
    const patches = H.updates.map((u) => (u && u.patch) || null).filter(Boolean);
    const last = patches[patches.length - 1];
    assert.ok(last && !last.qualified_at, '非 S0P→S1 不得写 qualified_at');
  });
});
