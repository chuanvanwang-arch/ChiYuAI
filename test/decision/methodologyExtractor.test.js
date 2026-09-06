// test/decision/methodologyExtractor.test.js — F5「方法论证据双端悬空」反假绿锁死
//
// 被测缺陷（F5）：`buildConditions` 读 methodology_dimension 生成 14 维 conditions，但
//   ① 输入端：7 个业务通道无一填 trigger_context.conditions
//   ② 数据端：系统无任何字段承载这 14 维
//   → met 全 null → 旧公式下 methodScore 恒 0、allMet 恒 false
//   → 绑方法论场景的置信度天花板 = similarity+coverage = 0.70 < 阈值 0.8 → **100% 升级**
//   → 倒挂：未绑方法论的场景（conditions=[]）反而能满分自主。
//
// 本文件锁死三条红线（任何一条被改回去必须立刻红）：
//   ① 反悬空：证据可得时 conditions.met 不得全 null，evidence_coverage 不得为 0
//   ② 反瞎自主：证据没采齐（覆盖率低）时不得自主，required 维缺证据不得判 required_met=true
//   ③ 反 F5 复发：「未采集」不得被写成 met=false（这正是 F5 的错误本身）
//
// 另锁「口径 parity」：提取器的字段表必须与 evaluator.js 的 bantcc scoreOf 同口径，
//   否则看板说"B 维已齐"而引擎说"B 维无证据"，同一事实两个答案。
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { query } from '../../src/db.js';
import {
  deriveDealEvidence, mergeEvidence, BANTCC_DIMS, DERIVED_SOURCE,
} from '../../src/decision/methodologyExtractor.js';
import { loadMethodologyEvidence } from '../../src/decision/methodologyEvidence.js';
import { deterministicEval } from '../../src/aiAttributes/evaluator.js';
import { requireDecision } from '../../src/decision/autonomyEngine.js';
import { confirmDecision } from '../../src/decision/decisionRepo.js';
import { mergedThresholds } from '../../src/sales/salesThresholds.js';

// LEAD_FOLLOW_UP 绑 BANT+MEDDICC+OPP_MATRIX = 14 维（BANT 4 + MEDDICC 7 + OPP_MATRIX 3）
const SCEN = 'LEAD_FOLLOW_UP';
const MIDS = ['BANT', 'MEDDICC', 'OPP_MATRIX'];
const DEAL_ID = 'f5000000-0000-4000-8000-000000000001';
const THR = mergedThresholds({});

// 生产实测形态（PGDATABASE=plm 抽样 5 条 CRM_DEAL 均为此形状）：
//   有 expected_amount / probability，无 authority / needs / expected_close_date / competition / coach
// → BANT 只有 B 维有事实，A/N/T 与 MEDDICC 全维无事实。测试数据必须与生产同形（铁律）。
const PROD_SHAPE = {
  name: '上海印通包装·礼品盒项目', stage: 'lead', amount: 173128,
  probability: 0.75, expected_amount: 3351935, win_strategy: '差异化方案设计',
};

async function upsertDeal(payload) {
  await query(
    `INSERT INTO particles (id, tenant_id, type, slug, title, state, payload)
     VALUES ($1,'system','CRM_DEAL',$2,$3,'ACTIVE',$4::jsonb)
     ON CONFLICT (id) DO UPDATE SET payload=EXCLUDED.payload`,
    [DEAL_ID, 'f5-deal-fixture', 'F5 测试商机', JSON.stringify(payload)]
  );
}

// 直接 INSERT 证据粒子（绕过 assertEvidence 的第 0 闸）：本用例要隔离验证的是
// 「引擎读证据 → 置信度解锁」这一段，不是写入闸门；写入闸门由 methodologyEvidence 自身守卫。
async function seedEvidence(rows) {
  for (const [i, r] of rows.entries()) {
    await query(
      `INSERT INTO particles (id, tenant_id, type, slug, title, state, payload)
       VALUES (gen_random_uuid(),'system','CRM_METHODOLOGY_EVIDENCE',$1,$2,'asserted',$3::jsonb)`,
      [`f5-ev-${i}-${r.dim_key}`, `证据 ${r.dim_key}`, JSON.stringify({
        subject_id: DEAL_ID, methodology_id: r.methodology_id, dim_key: r.dim_key,
        version_no: r.version_no || 1, met: r.met, value: r.value ?? '1',
        source: r.source || 'manual', evidence_ref: r.evidence_ref || 'test:fixture',
        asserted_by: 'tester', asserted_at: new Date().toISOString(),
      })]
    );
  }
}

beforeEach(async () => {
  await query('TRUNCATE crm.decision, crm.decision_precedent_rel, crm.decision_event, crm.memory_log RESTART IDENTITY CASCADE');
  await query(`DELETE FROM particles WHERE type='CRM_METHODOLOGY_EVIDENCE' AND payload->>'subject_id'=$1`, [DEAL_ID]);
  await upsertDeal(PROD_SHAPE);
});

afterAll(async () => {
  // 只清本文件造的 fixture（勿波及其它文件的粒子；测试库共享）
  await query(`DELETE FROM particles WHERE type='CRM_METHODOLOGY_EVIDENCE' AND payload->>'subject_id'=$1`, [DEAL_ID]);
  await query(`DELETE FROM particles WHERE id=$1`, [DEAL_ID]);
});

// ───────────────────── 红线③：「未采集」绝不写成「不达标」 ─────────────────────
describe('提取器三态语义（未采集 / 不达标 / 达标 互不混淆）', () => {
  it('字段全缺 → 一维都不产出（保持 met=null），绝不产出 met=false', () => {
    const out = deriveDealEvidence({}, { methodology_ids: MIDS, thresholds: THR, subject_id: DEAL_ID });
    expect(Object.keys(out)).toEqual([]);                       // 无事实即无证据
    expect(Object.values(out).some((e) => e.met === false)).toBe(false);
  });

  it('显式评分 0 → met=false（这是真「采集到且不达标」，与未采集必须可区分）', () => {
    const out = deriveDealEvidence({ bantcc: { b: 0 } }, { methodology_ids: MIDS, thresholds: THR, subject_id: DEAL_ID });
    expect(out.B).toBeTruthy();
    expect(out.B.met).toBe(false);
    expect(out.B.value).toBe('0');
    // 同一维在"字段全缺"时不产出 —— 两种 0 的区分点，F5 就是在这里翻的车
    const none = deriveDealEvidence({}, { methodology_ids: MIDS, thresholds: THR, subject_id: DEAL_ID });
    expect(none.B).toBeUndefined();
  });

  it('显式评分跨达标线翻转（≥ bantcc.pass 才 met=true），且证据带出处与人话理由', () => {
    const pass = THR.bantcc.pass; // 0.6
    const hi = deriveDealEvidence({ bantcc: { n: pass } }, { methodology_ids: MIDS, thresholds: THR, subject_id: DEAL_ID });
    const lo = deriveDealEvidence({ bantcc: { n: pass - 0.1 } }, { methodology_ids: MIDS, thresholds: THR, subject_id: DEAL_ID });
    expect(hi.N.met).toBe(true);
    expect(lo.N.met).toBe(false);
    expect(hi.N.source).toBe(DERIVED_SOURCE);
    expect(hi.N.evidence_ref).toContain(DEAL_ID);               // 有出处才算证据
    expect(hi.N.evidence_reason).toContain('bantcc.pass');       // 理由点名配置键（可追责到阈值）
  });

  it('methodology_ids 未绑的方法论不产出维度（场景只绑 OPP_MATRIX → 不产 BANT.B）', () => {
    const out = deriveDealEvidence(PROD_SHAPE, { methodology_ids: ['OPP_MATRIX'], thresholds: THR, subject_id: DEAL_ID });
    expect(out.B).toBeUndefined();
    expect(out.value).toBeTruthy();
  });
});

// ───────────────────── 阈值配置化铁律（禁硬编码达标线）─────────────────────
describe('达标线全部走配置（改配置即改判定，代码零硬编码）', () => {
  it('OPP_MATRIX.value 达标线上调 → 同一商机由达标翻为不达标', () => {
    const low = deriveDealEvidence(PROD_SHAPE, { methodology_ids: MIDS, thresholds: THR, subject_id: DEAL_ID });
    expect(low.value.met).toBe(true);                            // 335 万 ≥ 出厂 10 万
    const strict = mergedThresholds({ methodology: { opp_value_min: 9_000_000 } });
    const high = deriveDealEvidence(PROD_SHAPE, { methodology_ids: MIDS, thresholds: strict, subject_id: DEAL_ID });
    expect(high.value.met).toBe(false);                          // 335 万 < 900 万
    expect(high.value.evidence_reason).toContain('9000000');
  });

  it('OPP_MATRIX.win_prob 走 methodology.win_prob_min（0.5）', () => {
    const out = deriveDealEvidence({ probability: 0.3 }, { methodology_ids: MIDS, thresholds: THR, subject_id: DEAL_ID });
    expect(out.win_prob.met).toBe(false);
    const ok = deriveDealEvidence({ probability: 0.75 }, { methodology_ids: MIDS, thresholds: THR, subject_id: DEAL_ID });
    expect(ok.win_prob.met).toBe(true);
  });
});

// ───────────────────── 口径 parity：提取器 ≡ evaluator（同一事实一个答案）─────────────────────
describe('字段口径与 evaluator.bantcc_detail 一致（防看板/引擎两套说法）', () => {
  it('纯字段信号形态：derived 判 true 的维 ≡ evaluator 六维中记 1 的维', () => {
    const detail = deterministicEval('CRM_DEAL', PROD_SHAPE, { key: 'bantcc_detail' }).value;
    const evaluatorOne = Object.entries(detail).filter(([, v]) => v === 1).map(([k]) => k).sort();
    const out = deriveDealEvidence(PROD_SHAPE, { methodology_ids: MIDS, thresholds: THR, subject_id: DEAL_ID });
    const derivedTrue = BANTCC_DIMS.map((d) => d.dim_key).filter((k) => out[k]?.met === true).sort();
    expect(derivedTrue).toEqual(evaluatorOne);                  // 生产形态下双方都只认 B
    expect(derivedTrue).toEqual(['B']);
  });

  it('六维字段齐全形态：双方仍逐维一致（A/N/T/C1/C2 全覆盖）', () => {
    const full = {
      ...PROD_SHAPE, authority: '总经理拍板', needs: { product: '礼品盒', qty: 5000 },
      expected_close_date: '2026-10-01', competition: '裕同/劲嘉', coach: '采购部王经理',
    };
    const detail = deterministicEval('CRM_DEAL', full, { key: 'bantcc_detail' }).value;
    const evaluatorOne = Object.entries(detail).filter(([, v]) => v === 1).map(([k]) => k).sort();
    const out = deriveDealEvidence(full, { methodology_ids: MIDS, thresholds: THR, subject_id: DEAL_ID });
    const derivedTrue = BANTCC_DIMS.map((d) => d.dim_key).filter((k) => out[k]?.met === true).sort();
    expect(derivedTrue).toEqual(evaluatorOne);
    expect(derivedTrue).toEqual(['A', 'B', 'C1', 'C2', 'N', 'T']);
  });

  it('legacy 单一 C 评分：C1/C2 各自继承（口径同 evaluator.js:123-130 迁移回退）', () => {
    const out = deriveDealEvidence({ bantcc: { c: 0.8 } }, { methodology_ids: MIDS, thresholds: THR, subject_id: DEAL_ID });
    expect(out.C1.met).toBe(true);
    expect(out.C2.met).toBe(true);
    expect(out.C1.evidence_ref).toContain('bantcc.c');
    // 已拆分数据（c1 显式）不再走 legacy
    const split = deriveDealEvidence({ bantcc: { c: 0.8, c1: 0.2, c2: 0.9 } }, { methodology_ids: MIDS, thresholds: THR, subject_id: DEAL_ID });
    expect(split.C1.met).toBe(false);                           // 0.2 < 0.6，按显式评分判
    expect(split.C2.met).toBe(true);
  });
});

// ───────────────────── 来源优先级：人工纠偏不被机器算回去 ─────────────────────
describe('mergeEvidence 优先级 manual > enrich > auto > derived', () => {
  it('落库断言覆盖读时派生；派生只填补空缺维', () => {
    const derived = { B: { met: true, source: 'derived' }, N: { met: false, source: 'derived' } };
    const stored = { B: { met: false, source: 'manual' } };
    const m = mergeEvidence(derived, stored);
    expect(m.B.source).toBe('manual');                          // 人工胜出（哪怕结论相反）
    expect(m.B.met).toBe(false);
    expect(m.N.source).toBe(DERIVED_SOURCE);                    // 人工未覆盖的维保留派生
  });

  it('auto 覆盖 derived，但不覆盖 manual', () => {
    expect(mergeEvidence({ B: { met: true, source: 'derived' } }, { B: { met: false, source: 'auto' } }).B.source).toBe('auto');
    expect(mergeEvidence({ B: { met: true, source: 'manual' } }, { B: { met: false, source: 'auto' } }).B.source).toBe('manual');
  });
});

// ───────────────────── 红线①②：引擎端（DB）─────────────────────
describe('引擎接线（F5 锁死解除，但不放水）', () => {
  it('红线①反悬空：绑方法论场景的 conditions 不再全 null，evidence_coverage > 0', async () => {
    const r = await requireDecision(SCEN, { customer: 'normal', project: 'pilot' }, [{ type: 'CRM_DEAL', id: DEAL_ID }]);
    expect(r.conditions.length).toBe(14);                        // BANT 4 + MEDDICC 7 + OPP_MATRIX 3
    const assessed = r.conditions.filter((c) => c.met != null);
    expect(assessed.length).toBeGreaterThan(0);                  // 修复前恒为 0（双端悬空）
    expect(r.evidence_coverage).toBeGreaterThan(0);              // 修复前恒 0 → 天花板 0.70
    // 每条被判定的维必须带出处（人工要能查"凭什么这么判"）
    for (const c of assessed) {
      expect(c.evidence_source).toBeTruthy();
      expect(c.evidence_ref || c.evidence_source === 'trigger_context').toBeTruthy();
    }
    expect(assessed.map((c) => c.cond).sort()).toEqual(['B', 'value', 'win_prob']); // 生产形态可派生的 3 维
  });

  it('红线②反瞎自主：证据只采到 3/14 → 仍升级人工，且 required 维缺证据不得判达标', async () => {
    const r = await requireDecision(SCEN, { customer: 'normal', project: 'pilot' }, [{ type: 'CRM_DEAL', id: DEAL_ID }]);
    expect(r.mode).toBe('escalated');
    expect(r.evidence_coverage).toBeLessThan(0.5);               // 3/14 权重占比
    expect(r.required_met).toBe(false);                          // BANT.A/N、MEDDICC.D1/D2/E/I 皆无证据
    expect(r.method_score).toBe(1);                              // 已采集的 3 维确实都达标 —— 两项语义正交
    // 理由必须是人话的活儿清单（升级给人看的东西不能是 methodScore=0.21）
    expect(r.decision.rationale).toContain('已采集');
    expect(r.decision.rationale).toContain('必填维缺证据');
  });

  it('红线③零证据不给中性分：主体无任何可派生事实 → method_score=0（不白送 w.method）', async () => {
    await upsertDeal({ name: '空壳商机', stage: 'lead' });        // 无 expected_amount / probability
    const r = await requireDecision(SCEN, { customer: 'normal', project: 'pilot' }, [{ type: 'CRM_DEAL', id: DEAL_ID }]);
    expect(r.conditions.every((c) => c.met == null)).toBe(true);
    expect(r.method_score).toBe(0);
    expect(r.evidence_coverage).toBe(0);
    expect(r.mode).toBe('escalated');
  });

  it('证据采齐且达标 + 充足先例 → 自主放行（证明锁死真的解除，不是"少扣一点分"）', async () => {
    // 14 维全部落 manual 证据（模拟人工/填充器把证据补齐后的稳态）
    const dims = (await query(
      `SELECT methodology_id, dim_key FROM methodology_dimension WHERE methodology_id = ANY($1) ORDER BY methodology_id, dim_key`,
      [MIDS]
    )).rows;
    await seedEvidence(dims.map((d) => ({ ...d, met: true })));

    const ev = await loadMethodologyEvidence({ subject_id: DEAL_ID, methodology_ids: MIDS, tenantId: 'system' });
    expect(Object.keys(ev).length).toBe(14);                     // 读端确认 14 维证据可见

    const C = { customer: 'normal', project: 'pilot' };
    for (let i = 0; i < 2; i++) {                               // 造 2 条已确认先例（同 decision.test.js 模式）
      const p = await requireDecision(SCEN, C, [{ type: 'CRM_DEAL', id: DEAL_ID }]);
      await confirmDecision(p.decision.decision_id, { by_role: 'sales' });
    }
    const r = await requireDecision(SCEN, C, [{ type: 'CRM_DEAL', id: DEAL_ID }]);
    expect(r.evidence_coverage).toBe(1);
    expect(r.method_score).toBe(1);
    expect(r.required_met).toBe(true);
    expect(r.confidence).toBeGreaterThanOrEqual(0.8);
    expect(r.mode).toBe('autonomous');                          // 修复前此处恒为 escalated（天花板 0.70）
    // 证据来源必须是落库断言，不是派生（人工证据优先级已生效）
    expect(r.conditions.every((c) => c.evidence_source === 'manual')).toBe(true);
  });

  it('②a-3 落库填充：requireDecision 后派生事实固化为 auto 断言（可审计 + 人工纠偏不被算回）', async () => {
    const r = await requireDecision(SCEN, { customer: 'normal', project: 'pilot' }, [{ type: 'CRM_DEAL', id: DEAL_ID }]);
    expect(r.evidence_autofill).toBeTruthy();
    expect(r.evidence_autofill.written.sort()).toEqual(['B', 'value', 'win_prob']); // 生产形态可派生的 3 维落库
    // 落库实证：粒子确有 source='auto' 断言（不是只停在内存 derived）
    const rows = (await query(
      `SELECT payload->>'dim_key' AS dim, payload->>'source' AS src FROM particles
        WHERE type='CRM_METHODOLOGY_EVIDENCE' AND payload->>'subject_id'=$1`, [DEAL_ID]
    )).rows;
    expect(rows.filter((x) => x.src === 'auto').map((x) => x.dim).sort()).toEqual(['B', 'value', 'win_prob']);
    // 人工纠偏不被算回：manual 覆盖同维
    await query(
      `INSERT INTO particles (id, tenant_id, type, slug, title, state, payload)
       VALUES (gen_random_uuid(),'system','CRM_METHODOLOGY_EVIDENCE','f5-fix-B','固定 B','asserted',$1::jsonb)`,
      [JSON.stringify({ subject_id: DEAL_ID, methodology_id: 'BANT', dim_key: 'B', version_no: 1,
        met: false, value: '0', source: 'manual', evidence_ref: 'test:manual-fix',
        asserted_by: 'tester', asserted_at: new Date().toISOString() })]
    );
    const r2 = await requireDecision(SCEN, { customer: 'normal', project: 'pilot' }, [{ type: 'CRM_DEAL', id: DEAL_ID }]);
    // 幂等：首次已落 auto（value/win_prob）且 B 已被 manual 占 → 二次零新写（不制造版本噪音）
    expect((r2.evidence_autofill?.written || []).sort()).toEqual([]);
    // B 的现行断言仍为 manual（用引擎同款 loadMethodologyEvidence 解析，按来源优先级裁决，非版本号先后）
    const evNow = await loadMethodologyEvidence({ subject_id: DEAL_ID, methodology_ids: MIDS, tenantId: 'system' });
    expect(evNow.B.source).toBe('manual'); // 人工纠偏持续生效，未被 auto 覆盖
  });
});
