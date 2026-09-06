// test/calibration/parity.test.js — 校准参数外置 parity 锁死
// 设计依据：docs/2026-08-28-decision-quality-calibration-design.md §2.3/§8
// 契约：
//   ① config_store['autonomy-conf'] 缺省时 loadEngineConf() 返回与 autonomyEngine.js 出厂 DEFAULT_CONF 逐字一致
//   ② 引擎真实决策输出与手工 DEFAULT_CONF 公式一致（同输入同 conf）
//   ③ CALIBRATION_CHANGE 场景在 db/seed.sql 与 db/test-setup.sql 双库种子存在（文件契约守卫）
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { query, withTx } from '../../src/db.js';
import { loadEngineConf, requireDecision } from '../../src/decision/autonomyEngine.js';
import { DEFAULT_CONF as STORE_DEFAULT, WEIGHT_KEYS, readConf } from '../../src/calibration/store.js';
import { getStrategy } from '../../src/calibration/knobs/index.js';
import { replayConfidence } from '../../src/calibration/replay.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// F5（2026-09-02）：method 0.2 拆为 method 0.1 + evidence_coverage 0.1，权重和仍为 1.0
// 阈值调低（2026-09-02，用户批准）：0.8 → 0.7（与 autonomyEngine.js / store.js 出厂值逐字同步）
const ENGINE_DEFAULT = {
  threshold: 0.7,
  weights: { similarity: 0.4, coverage: 0.3, method: 0.1, evidence_coverage: 0.1, allMet: 0.1 },
};

describe('parity — 配置外置与出厂缺省逐字一致', () => {
  beforeAll(async () => {
    // 测试库幂等恢复缺省态（校准测试可能残留 autonomy-conf；parity 只测缺省基线）
    await query(`DELETE FROM crm.config_store WHERE key='autonomy-conf'`);
  });

  it('loadEngineConf 缺省返回与引擎出厂 DEFAULT_CONF 逐字一致（先于任何写配置）', async () => {
    const conf = await loadEngineConf();
    expect(conf).toEqual(ENGINE_DEFAULT);
  });

  it('store.DEFAULT_CONF 与引擎出厂 DEFAULT_CONF 逐字一致（两处单一事实源不漂移）', () => {
    expect(STORE_DEFAULT).toEqual(ENGINE_DEFAULT);
  });

  it('引擎真实决策的置信度与手工 DEFAULT_CONF 公式一致（同配方同输出）', async () => {
    // 用 LEAD_FOLLOW_UP（LEAD + autonomous_allowed）触发一次真实决策
    const r = await requireDecision(
      'LEAD_FOLLOW_UP',
      { customer: { id: 'parity-c1' }, conditions: { priority: true }, relations: {} },
      [{ type: 'DEAL', id: 'parity-d1' }],
      { actor_id: 'parity-test', actor_role: 'sales' }
    );
    // 重放复核：用落库的决策行复算应与引擎输出一致（跨引擎与重放的 parity 双锁）
    const replayed = replayConfidence(r.decision, ENGINE_DEFAULT);
    expect(Math.abs(replayed - r.confidence)).toBeLessThan(1e-6);
    // 手工公式复核 —— 故意**不 import methodologyScoring.js**：parity 的价值在于在测试侧独立
    //   写一遍公式做交叉验证；若 import 生产模块，公式改错时两边一起错，测试反而给出假绿。
    const cs = Array.isArray(r.decision.conditions_evaluated) ? r.decision.conditions_evaluated : [];
    const totalW = cs.reduce((s, c) => s + (c.weight || 1), 0);
    // ① methodScore：分母只含已采集维度（met != null）；零证据 → 0；未绑方法论（cs 空）→ 1.0
    const assessed = cs.filter((c) => c.met != null);
    const assessedW = assessed.reduce((s, c) => s + (c.weight || 1), 0);
    const methodScore = !cs.length
      ? 1.0
      : (assessed.length && assessedW
        ? assessed.reduce((s, c) => s + (c.weight || 1) * (c.met ? 1 : 0), 0) / assessedW
        : 0);
    // ② evidenceCov：已采集维度权重 / 全维度权重；未绑方法论 → 1.0
    const evidenceCov = !cs.length
      ? 1.0
      : (totalW ? cs.reduce((s, c) => s + (c.weight || 1) * (c.met != null ? 1 : 0), 0) / totalW : 1.0);
    // ③ allMet 新语义：只看 required=true 维度是否有证据且达标（旧语义 every(c=>c.met) 把未采集也算不达标）
    const reqDims = cs.filter((c) => c.required);
    const allMet = reqDims.length ? reqDims.every((c) => c.met === true) : true;
    const avgSim = r.decision.referenced_precedents.length
      ? r.decision.referenced_precedents.reduce((s, p) => s + Number(p.similarity), 0) / r.decision.referenced_precedents.length
      : 0;
    const cov = Math.min(r.decision.referenced_precedents.length / 5, 1);
    const rel = (r.decision.trigger_context?.relations) || {};
    const relBoost = (['high', 'champion'].includes(rel.champion_strength) ? 0.3 : 0)
      + (['high', 'strong'].includes(rel.relationship_strength) ? 0.3 : 0);
    const confRaw =
      ENGINE_DEFAULT.weights.similarity * avgSim
      + ENGINE_DEFAULT.weights.coverage * cov
      + ENGINE_DEFAULT.weights.method * methodScore
      + ENGINE_DEFAULT.weights.evidence_coverage * evidenceCov
      + ENGINE_DEFAULT.weights.allMet * (allMet ? 1 : 0)
      + relBoost;
    expect(Math.abs(r.confidence - Math.min(confRaw, 0.95))).toBeLessThan(1e-6);
    // 引擎返回值须同时带出三项（缺任一项 → 监控/校准端看不到"为什么这个分"）
    expect(typeof r.method_score).toBe('number');
    expect(typeof r.evidence_coverage).toBe('number');
    expect(typeof r.required_met).toBe('boolean');
  });

  // 反语义漂移：权重和必须恒 1.0，否则 confidence 不再是 0..1 语义，
  //   而 threshold（0.8）是按 0..1 标定的 —— 和变了等于所有阈值静默失准。
  it('权重和恒 1.0（拆分 method → method + evidence_coverage 不改变量纲）', () => {
    const sum = Object.values(ENGINE_DEFAULT.weights).reduce((s, v) => s + v, 0);
    expect(Math.abs(sum - 1.0)).toBeLessThan(1e-9);
    const storeSum = Object.values(STORE_DEFAULT.weights).reduce((s, v) => s + v, 0);
    expect(Math.abs(storeSum - 1.0)).toBeLessThan(1e-9);
  });
});

describe('parity — CALIBRATION_CHANGE 场景双库种子', () => {
  it('db/seed.sql 含 CALIBRATION_CHANGE', () => {
    const sql = readFileSync(join(ROOT, 'db', 'seed.sql'), 'utf8');
    expect(sql).toContain("'CALIBRATION_CHANGE'");
  });
  it('db/test-setup.sql 含 CALIBRATION_CHANGE', () => {
    const sql = readFileSync(join(ROOT, 'db', 'test-setup.sql'), 'utf8');
    expect(sql).toContain("'CALIBRATION_CHANGE'");
  });
});

describe('parity — 旋钮策略抽象重构不破坏 P1 行为', () => {
  beforeAll(async () => {
    await query(`DELETE FROM crm.config_store WHERE key='autonomy-conf'`);
  });

  it('ThresholdStrategy.apply 写回与出厂缺省仅 threshold 变更（weights 不变）', async () => {
    const cur = await readConf();
    await withTx(async (client) => {
      await getStrategy('threshold').apply(client, { threshold: 0.85 }, { scenario_id: null, target: null, decisionId: null, current: cur });
    });
    const c = await readConf();
    expect(c.threshold).toBe(0.85);
    expect(c.weights).toEqual(STORE_DEFAULT.weights);
  });

  it('WeightStrategy.apply 写回仅更新 target 权重（其余权重与出厂逐字一致）', async () => {
    const cur = await readConf();
    await withTx(async (client) => {
      await getStrategy('weight').apply(client, { weights: { method: 0.25 } }, { scenario_id: null, target: 'method', decisionId: null, current: cur });
    });
    const c = await readConf();
    expect(c.weights.method).toBe(0.25);
    expect(c.weights.similarity).toBe(STORE_DEFAULT.weights.similarity);
    expect(c.weights.coverage).toBe(STORE_DEFAULT.weights.coverage);
    expect(c.weights.evidence_coverage).toBe(STORE_DEFAULT.weights.evidence_coverage);
    expect(c.weights.allMet).toBe(STORE_DEFAULT.weights.allMet);
  });

  // 防「新权重不可配置」：WEIGHT_KEYS 是 calibrationRouter 调参白名单的唯一来源，
  //   若它与 DEFAULT_CONF.weights 键集不等，某些权重会静默失去调参能力（阈值配置化铁律）
  it('WEIGHT_KEYS 与 DEFAULT_CONF.weights 键集逐字相等（含 evidence_coverage）', () => {
    expect([...WEIGHT_KEYS].sort()).toEqual(Object.keys(STORE_DEFAULT.weights).sort());
    expect(WEIGHT_KEYS).toContain('evidence_coverage');
  });
});