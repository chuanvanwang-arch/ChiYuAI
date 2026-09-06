// src/decision/conflict.js — P4 冲突保留：多源事实断言并存，标记差异、绝不静默覆盖
// 设计输入：docs/superpowers/specs/2026-08-26-age-semantica-program-design.md P4
// 语义：不同来源对同一属性给出不同值 → 全部保留（keep disagreement），置 needs_review 待裁决；
//       裁决用 adoptValue（标记某值为权威 valid，其他源 valid=false，但物理保留不删）。
import { query, queryWrite } from '../db.js';

// 幂等建表（与 db/migration-conflict.sql 一致；测试/运行时自举用）
export async function ensureAssertionsSchema() {
  await queryWrite(`CREATE TABLE IF NOT EXISTS crm.assertions (
    id BIGSERIAL PRIMARY KEY,
    entity_id TEXT NOT NULL,
    attr TEXT NOT NULL,
    value TEXT NOT NULL,
    source_id TEXT NOT NULL,
    valid BOOLEAN NOT NULL DEFAULT true,
    needs_review BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await queryWrite(`CREATE INDEX IF NOT EXISTS idx_crm_assertions_entity_attr
    ON crm.assertions(entity_id, attr)`).catch(() => {});
}

// 记录一条事实断言（多源并存）
export async function recordAssertion(entity_id, attr, value, source_id) {
  const r = await queryWrite(
    `INSERT INTO crm.assertions (entity_id, attr, value, source_id)
     VALUES ($1,$2,$3,$4) RETURNING *`, [entity_id, attr, value, source_id]);
  // 标记冲突：同实体同属性已有不同值 → 整组置 needs_review
  const others = await query(
    `SELECT COUNT(DISTINCT value)::int n FROM crm.assertions
     WHERE entity_id=$1 AND attr=$2 AND value <> $3`, [entity_id, attr, value]);
  if (others.rows[0].n > 0) {
    await queryWrite(
      `UPDATE crm.assertions SET needs_review=true WHERE entity_id=$1 AND attr=$2`,
      [entity_id, attr]);
  }
  return r.rows[0];
}

// 检测某实体某属性（attr 为空则全部）的冲突现状
export async function detectConflicts(entity_id, attr) {
  const r = await query(
    `SELECT * FROM crm.assertions WHERE entity_id=$1 AND ($2::text IS NULL OR attr=$2) ORDER BY created_at`,
    [entity_id, attr || null]);
  const distinct = new Set(r.rows.map((x) => x.value));
  return {
    assertions: r.rows,
    hasConflict: distinct.size > 1,
    needsReview: r.rows.some((x) => x.needs_review),
  };
}

// 规则采用（人工/策略选定权威值：标记权威 valid=true，其他源 valid=false；不物理删除）
export async function adoptValue(entity_id, attr, value) {
  await queryWrite(
    `UPDATE crm.assertions SET valid=false WHERE entity_id=$1 AND attr=$2 AND value<>$3`,
    [entity_id, attr, value]);
  return detectConflicts(entity_id, attr);
}

// ───── G4：冲突 5 策略 + source_credibility ─────
// 测试计划 §5.3：timestamp（最新）/source_priority（源优先级）/confidence_weighted（可信加权）/
//              merge（合并多值）/human_arbitration（人工裁决，经决策第0闸 produceDecision）
// 纪律：裁决不物理删除——仅置 valid=false；human_arbitration 必须产出真实 decision 行。

// 幂等补 source_credibility 列（REAL，0~1）
export async function ensureCredibilityColumn() {
  await queryWrite(`ALTER TABLE crm.assertions ADD COLUMN IF NOT EXISTS source_credibility REAL NOT NULL DEFAULT 0.5`);
}

async function listAssertionRows(entity_id, attr) {
  return (await query(
    `SELECT * FROM crm.assertions WHERE entity_id=$1 AND attr=$2 ORDER BY created_at, id`,
    [entity_id, attr])).rows;
}

// 裁决辅助：标记某 value 为权威（其他 valid=false），返回检测结果
async function adoptAndReturn(entity_id, attr, value) {
  await queryWrite(
    `UPDATE crm.assertions SET valid=true, needs_review=false
     WHERE entity_id=$1 AND attr=$2 AND value=$3`,
    [entity_id, attr, value]);
  return adoptValue(entity_id, attr, value);
}

export async function resolveConflict(entity_id, attr, strategy, { produceDecision = null, sources = null } = {}) {
  const rows = await listAssertionRows(entity_id, attr);
  if (rows.length === 0) return { strategy, winner: null, decisionId: null, assertions: [] };

  // 1) timestamp：取 created_at 最新一条
  if (strategy === 'timestamp') {
    const winner = rows.reduce((a, b) => (new Date(a.created_at) > new Date(b.created_at) ? a : b));
    const det = await adoptAndReturn(entity_id, attr, winner.value);
    return { strategy, winner: { source_id: winner.source_id, value: winner.value }, decisionId: null, ...det };
  }

  // 2) source_priority：按 sources 优先级表取最高优先源（sources: [{source_id,priority}]）
  if (strategy === 'source_priority') {
    const pri = new Map((sources || []).map((s) => [s.source_id, s.priority]));
    const winner = rows.reduce((a, b) => {
      const pa = pri.get(a.source_id) ?? 0, pb = pri.get(b.source_id) ?? 0;
      return pa >= pb ? a : b;
    });
    const det = await adoptAndReturn(entity_id, attr, winner.value);
    return { strategy, winner: { source_id: winner.source_id, value: winner.value }, decisionId: null, ...det };
  }

  // 3) confidence_weighted：source_credibility 最高（默认 0.5，确保有列）
  if (strategy === 'confidence_weighted') {
    const winner = rows.reduce((a, b) =>
      (a.source_credibility ?? 0.5) >= (b.source_credibility ?? 0.5) ? a : b);
    const det = await adoptAndReturn(entity_id, attr, winner.value);
    return { strategy, winner: { source_id: winner.source_id, value: winner.value }, decisionId: null, ...det };
  }

  // 4) merge：多值合并为数组（保留全部，valid 不变，needs_review=false）
  if (strategy === 'merge') {
    const merged = rows.map((r) => r.value);
    await queryWrite(
      `UPDATE crm.assertions SET needs_review=false WHERE entity_id=$1 AND attr=$2`,
      [entity_id, attr]);
    return { strategy, winner: { value: merged }, decisionId: null, assertions: rows };
  }

  // 5) human_arbitration：必须经决策第0闸产出 decision 行
  if (strategy === 'human_arbitration') {
    if (typeof produceDecision !== 'function') {
      throw new Error('human_arbitration 需要 produceDecision（决策第0闸）');
    }
    const winner = rows.reduce((a, b) => (a.source_credibility ?? 0.5) >= (b.source_credibility ?? 0.5) ? a : b);
    const decision = await produceDecision({
      scenario_id: 'CALIBRATION_CHANGE',
      disposition: 'APPROVED',
      trigger_context: { conflict: { entity_id, attr, strategy } },
      conditions_evaluated: [{ name: 'conflict_resolution', met: true }],
      involved_entities: [entity_id],
      rationale: `G4 conflict resolve ${strategy} on ${entity_id}.${attr}`,
    });
    const det = await adoptAndReturn(entity_id, attr, winner.value);
    return { strategy, winner: { source_id: winner.source_id, value: winner.value }, decisionId: decision.decision_id, ...det };
  }

  throw new Error(`未知冲突策略: ${strategy}`);
}
