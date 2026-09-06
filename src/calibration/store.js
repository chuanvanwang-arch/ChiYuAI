// src/calibration/store.js — 校准配置与处方存储（config_store['autonomy-conf'] + calibration_patch CRUD）
// 设计依据：docs/2026-08-28-decision-quality-calibration-design.md §2.2/§2.3/§7
// 三闸契约：
//   ① 写配置必经第0闸：APPLY 先 createDecision({scenario_id:'CALIBRATION_CHANGE'})（真实 decision 行，
//      设计 §7 原文 createDecision；calibration_patch.decision_id REFERENCES crm.decision(decision_id) 锚定该行）
//   ② 回滚 = 恢复 from_value（同样经第0闸），patch 置 ROLLED_BACK
//   ③ 缺省回退：config_store 无 autonomy-conf 时返回 DEFAULT_CONF（与 autonomyEngine.js:8 逐字一致，parity 由 test/calibration/parity.test.js 锁死）
import { query, withTx } from '../db.js';
import { createDecision } from '../decision/decisionRepo.js';
import { getStrategy } from './knobs/index.js';

// 与 autonomyEngine.js DEFAULT_CONF 逐字对齐（parity 守卫见 parity.test.js）
// F5 修复（2026-09-02）：旧 method:0.2 拆为 method:0.1 + evidence_coverage:0.1 —— 权重和恒 1.0 不变。
//   method = 已采集维度的加权达标率；evidence_coverage = 证据采齐度。
//   拆分理由：合并时"未采集"被当"不达标"扣分，绑方法论场景置信度天花板 0.70 < 阈值 → 自主路径结构性锁死。
// 阈值调低（2026-09-02，用户批准）：0.8 → 0.7，与 autonomyEngine.js 逐字同步（parity 守卫锁死）。
export const DEFAULT_CONF = {
  threshold: 0.7,
  weights: { similarity: 0.4, coverage: 0.3, method: 0.1, evidence_coverage: 0.1, allMet: 0.1 },
};

// 可配置权重键的单一事实源。从 DEFAULT_CONF 派生而非另写一份数组 ——
//   F5 教训：calibrationRouter.js 曾硬编码 ['similarity','coverage','method','allMet'] 白名单，
//   新增权重若漏改该行，则该权重**永远无法经 API 调参**（阈值配置化铁律的静默失效）。派生后自动跟随。
export const WEIGHT_KEYS = Object.freeze(Object.keys(DEFAULT_CONF.weights));

export const PATCH_STATUS = ['PENDING', 'APPROVED', 'REJECTED', 'APPLIED', 'ROLLED_BACK'];
// T28/J3 扩展：覆盖 confidence/edge_binding/outcome_threshold/strictness（J3 文档）+ 七类根因 knob（溯源文档）
// T12 扩展（2026-09-05，§16.3）：加 'config_store' 承载 retro 草稿→待办→批准即生效闭环（ConfigStoreStrategy）。
// 2026-09-05 P1 扩展（§8）：routing_tracks / routing_weight / routing_threshold —— 场景路由自适应回路处方。
//   落点为 config_store['context-routing']，**只出 PENDING 处方**，人工批准 + 第0闸后才写（红线：系统永不自动改）。
export const KNOBS = [
  'threshold', 'weight', 'required_dims',
  'confidence', 'edge_binding', 'outcome_threshold', 'strictness',
  'meta_attr_map', 'particle_attr_add', 'k_edge_add', 'source_refresh', 'dim_order', 'precedent_distill',
  'config_store',
  'routing_tracks', 'routing_weight', 'routing_threshold',
];

// 读当前生效配置（缺省回退 DEFAULT_CONF；per-tenant 兼容：未指定租户按平台租户 system 读）
export async function readConf() {
  const r = await query(`SELECT value FROM crm.config_store WHERE tenant_id='system' AND key=$1`, ['autonomy-conf']);
  const v = r.rows[0]?.value;
  if (!v || typeof v !== 'object') return { ...DEFAULT_CONF };
  return {
    threshold: typeof v.threshold === 'number' ? v.threshold : DEFAULT_CONF.threshold,
    weights: { ...DEFAULT_CONF.weights, ...(v.weights || {}) },
  };
}

// 写配置（第0闸决策凭证由调用方 produceDecision 提供；tenant_id 固定平台租户 system）
export async function writeConf(value, decisionId) {
  await query(
    `INSERT INTO crm.config_store (tenant_id, key, value, decision_id, updated_by, updated_at)
     VALUES ('system', $1, $2::jsonb, $3, 'system', now())
     ON CONFLICT (tenant_id, key) DO UPDATE SET value=$2::jsonb, decision_id=$3, updated_at=now()`,
    ['autonomy-conf', JSON.stringify(value), decisionId]
  );
}

// 第0闸：创建真实 decision 行（CALIBRATION_CHANGE 场景，设计 §7 原文 createDecision；HIGH+autonomous_allowed=FALSE）
// disposition='APPROVE' 语义 = 「批准应用本次配置变更」；返回 decision.decision_id 作为锚定
export async function produceDecision(ctx = {}) {
  const row = await createDecision({
    scenario_id: 'CALIBRATION_CHANGE',
    trigger_context: { fields: ctx.fields || [] },
    involved_entities: ctx.involved_entities || [],
    conditions_evaluated: [],
    disposition: 'APPROVE',
    decider_type: 'HUMAN', decider_id: ctx.by_id || null, decider_role: ctx.by_role || 'sysadmin',
    rationale: `校准参数变更（第0闸）：${(ctx.fields || []).join('+')}`,
    business_tier: 'HIGH', state: 'CONFIRMED',
  });
  return { decisionId: row?.decision_id || null, ok: true };
}

// 处方 CRUD
// T12 扩展（§16.1/16.4）：assignee（默认 'ADMIN'，租户级候选 'tan_admin'）+ tenant_id（默认 'system'，承载租户上下文）。
export async function createPatch({ scenario_id = null, knob, target, from_value, to_value, evidence, expected_impact = null, risk, decision_id = null, assignee = 'ADMIN', tenant_id = 'system' }) {
  if (!KNOBS.includes(knob)) throw new Error(`createPatch: knob 须为 ${KNOBS.join('/')}`);
  if (!['LOW', 'MEDIUM', 'HIGH'].includes(risk)) throw new Error('createPatch: risk 须为 LOW/MEDIUM/HIGH');
  const r = await query(
    `INSERT INTO crm.calibration_patch
       (scenario_id, knob, target, from_value, to_value, evidence, expected_impact, risk, status, decision_id, assignee, tenant_id)
     VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb,$8,'PENDING',$9,$10,$11)
     RETURNING *`,
    [scenario_id, knob, target || null, JSON.stringify(from_value), JSON.stringify(to_value),
     JSON.stringify(evidence), expected_impact ? JSON.stringify(expected_impact) : null, risk, decision_id,
     assignee, tenant_id]
  );
  return r.rows[0];
}

// 幂等批量落库（P2 generate 端点用）：同 scenario_id+knob+target+to_value 的 PENDING 行已存在 → 跳过
// 返回 { created, skipped }；scenario_id 可空（全部场景视角）
// T23 扩展：decision_id（第0闸凭证）透传至 createPatch，保证「写处方必经真实决策行」契约
// T12 扩展（§16.6）：去重维度扩到 tenant_id，同 target+to_value 在不同租户各自独立待办；
//   透传 assignee/tenant_id 到 createPatch（assignee 字面值，租户上下文保留）。
export async function savePatches(scenario_id, patches = [], { pool: _pool = null, decision_id = null } = {}) {
  let created = 0;
  const skipped = [];
  for (const p of patches) {
    const tenant = p.tenant_id || 'system';
    const dup = await query(
      `SELECT 1 FROM crm.calibration_patch
       WHERE scenario_id IS NOT DISTINCT FROM $1 AND knob=$2
         AND target IS NOT DISTINCT FROM $3 AND to_value=$4::jsonb AND status='PENDING'
         AND tenant_id IS NOT DISTINCT FROM $5
       LIMIT 1`,
      [scenario_id, p.knob, p.target || null, JSON.stringify(p.to_value), tenant]
    );
    if (dup.rows.length) { skipped.push(p.id || p.rule_id || p.patch_id); continue; }
    await createPatch({
      scenario_id, knob: p.knob, target: p.target,
      from_value: p.from_value, to_value: p.to_value,
      evidence: p.evidence, expected_impact: p.expected_impact || null, risk: p.risk,
      decision_id, assignee: p.assignee || 'ADMIN', tenant_id: tenant,
    });
    created += 1;
  }
  return { created, skipped };
}

export async function listPatches({ status = null, limit = 50 } = {}) {
  const params = [limit];
  let where = '';
  if (status) { params.unshift(status); where = 'WHERE status=$1'; }
  const r = await query(
    `SELECT * FROM crm.calibration_patch ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
    params
  );
  return r.rows;
}

export async function getPatch(patch_id) {
  const r = await query(`SELECT * FROM crm.calibration_patch WHERE patch_id=$1`, [patch_id]);
  return r.rows[0] || null;
}

async function setStatus(patch_id, status, resolved_by = null) {
  const r = await query(
    `UPDATE crm.calibration_patch SET status=$2, resolved_at=now(), resolved_by=$3 WHERE patch_id=$1 RETURNING *`,
    [patch_id, status, resolved_by]
  );
  return r.rows[0] || null;
}

// 批准：第0闸 createDecision → 【事务】写配置 + patch APPLIED + 回写 decision_id（原子，失败全回滚）
// knob=weight 时按 target 定位 weights 键；threshold 时直接替换 threshold
// 事务内写用 client（withTx 通道）；第0闸决策在事务前产生（配置变更尝试留痕，不随事务回滚）
export async function approvePatch(patch_id, { produce = produceDecision, resolved_by = null } = {}) {
  const patch = await getPatch(patch_id);
  if (!patch) throw new Error(`未知处方: ${patch_id}`);
  if (patch.status !== 'PENDING' && patch.status !== 'APPROVED') {
    throw new Error(`处方状态 ${patch.status} 不可批准（仅 PENDING/APPROVED）`);
  }
  const strat = getStrategy(patch.knob);
  if (!strat) throw new Error(`未知 knob: ${patch.knob}`);

  const cur = await readConf();
  const dec = await produce({ scenario_id: 'CALIBRATION_CHANGE', fields: [patch.knob, patch.target].filter(Boolean) });
  await withTx(async (client) => {
    await strat.apply(client, patch.to_value, { scenario_id: patch.scenario_id, target: patch.target, decisionId: dec.decisionId, current: cur, tenantId: patch.tenant_id || 'system', patchId: patch_id });
    await client.query(
      `UPDATE crm.calibration_patch SET status='APPLIED', resolved_at=now(), resolved_by=$2,
         decision_id=COALESCE($3, decision_id)
       WHERE patch_id=$1 RETURNING *`,
      [patch_id, resolved_by, dec.decisionId]
    );
  });
  return { patch: await getPatch(patch_id), config: await readConf(), decision: dec.decisionId };
}

// 驳回
export async function rejectPatch(patch_id, { resolved_by = null } = {}) {
  const patch = await getPatch(patch_id);
  if (!patch) throw new Error(`未知处方: ${patch_id}`);
  if (!['PENDING', 'APPROVED'].includes(patch.status)) throw new Error(`处方状态 ${patch.status} 不可驳回`);
  return setStatus(patch_id, 'REJECTED', resolved_by);
}

// 回滚：恢复 from_value（仅 APPLIED 可回滚）→ 同样经第0闸 + 事务原子
export async function rollbackPatch(patch_id, { produce = produceDecision, resolved_by = null } = {}) {
  const patch = await getPatch(patch_id);
  if (!patch) throw new Error(`未知处方: ${patch_id}`);
  if (patch.status !== 'APPLIED') throw new Error(`处方状态 ${patch.status} 不可回滚（仅 APPLIED）`);

  const cur = await readConf();
  const strat = getStrategy(patch.knob);
  if (!strat) throw new Error(`未知 knob: ${patch.knob}`);

  const dec = await produce({ scenario_id: 'CALIBRATION_CHANGE', fields: ['rollback', patch.knob, patch.target].filter(Boolean) });
  await withTx(async (client) => {
    await strat.apply(client, patch.from_value, { scenario_id: patch.scenario_id, target: patch.target, decisionId: dec.decisionId, current: cur, tenantId: patch.tenant_id || 'system', patchId: patch_id, rollback: true });
    await client.query(
      `UPDATE crm.calibration_patch SET status='ROLLED_BACK', resolved_at=now(), resolved_by=$2,
         decision_id=COALESCE($3, decision_id)
       WHERE patch_id=$1 RETURNING *`,
      [patch_id, resolved_by, dec.decisionId]
    );
  });
  return { patch: await getPatch(patch_id), config: await readConf(), decision: dec.decisionId };
}