// src/decision/adviceRecord.js — 建议落库（E3，2026-09-16）
//
// 目的：补上「AI 曾建议过什么」的可观测回路。此前 `advise()` 有 6 处生产调用，
//   返回值一律只做即时回显、从不落库；`ADVISED` 是死状态（`src/` 零写入点）
//   → 第 9 大能力（反馈闭环）缺一条回路：建议准确率/采纳率无从度量，
//   也答不出「这次决策是采纳了 AI 建议，还是人自己想的」。
//
// ⚠ 设计裁决（2026-09-16）：**不落 crm.decision + state='ADVISED'**
//   （原设计 docs/2026-09-08-dialog-driven-decision-advice-design.md §5 的方案）。
//   源码级盘点（同日）给出三条否决证据：
//     ① **污染面**：`crm.decision` 有 15 个读取点，其中 8 个是聚合/统计面——
//        `dailyOps`（日报 total/escalated/avg_confidence）、`retro`（每日复盘窗口抽样）、
//        `calibration/sampleLoader|autoSuggest|paramInspector`（校准样本与调参建议）、
//        `auditability`（可审计性 Q1–Q4 抽检）、`assembler.retrieveL2`（决策史注入上下文）、
//        `controlledConfigPages`（`state <> 'APPROVED'` 计数）。
//        写非决策行进去 = 每个未来新增查询都是一个新污染点，且**验收会通过**（部分假绿）。
//     ② **无天然免疫**：`createDecision` 的 `decided_at` 硬写 `now()`（decisionRepo.js:270），
//        不会因 NULL 被时间窗聚合自动排除。
//     ③ **写不进去**：`createDecision` 内 `sevenDimensionsCheck` + `decideInterception`
//        在 required_dims 缺失时**直接抛错**（decisionRepo.js:200-203）；而建议恰恰产生于
//        「证据不足」——最该记录的场景反而落不了库。
//   ⇒ 改用独立运行态表 `crm.advice_record`（与 proactive 的 signal / external_ref 同范式）：
//     零读取点改动、零决策内核改动。**原「先例检索须排除 ADVISED」的硬前置因此结构性消解**
//     （`crm.decision` 里永远不会出现 ADVISED 行），并由
//     `test/decision/advice-precedent-guard.test.js` 机械化锁死（不靠人工清单）。
//
// 铁律：
//  - **fail-open**：本模块任何异常都不得阻断 `advise()` 主链路（观测写入，非业务写）。
//  - **不落对话原文**：只存结构化摘要 + 关键词 hits（沿用 adviceStore 的摘要口径）。
//  - 属运行态观测写入（与 decision_event / audit_event 同类），**不经决策第 0 闸**——
//    建议先于决策，挂在第 0 闸上会形成循环依赖。
import { query } from '../db.js';
import { emit } from '../events/bus.js';
import { buildStructuredSummary } from './adviceStore.js';

export const ADVICE_SOURCE = 'dialog-advisor';
const SUMMARY_MAX = 120;

// 发起人标识：取 username（唯一且稳定）；display_name 可重名可改，不作为审计主体。
function actorLabel(a) {
  if (!a) return null;
  return a.username || a.name || a.display_name || null;
}

// 纯函数：建议卡 → 落库行。无 scenario_id 返回 null（未定位的建议无观测价值，防脏数据）。
export function buildAdviceRecord(advice = {}, { tenantId = 'system', actor = null, stage = null, source = ADVICE_SOURCE } = {}) {
  if (!advice || !advice.scenario_id) return null;
  const reasons = Array.isArray(advice.reasons) ? advice.reasons : [];
  const gaps = Array.isArray(advice.gaps) ? advice.gaps : [];
  const redlines = Array.isArray(advice.redlines) ? advice.redlines : [];
  const hits = Array.isArray(advice.hits) ? advice.hits : [];
  const confidence = advice.confidence;
  const structured = {
    scenario_id: advice.scenario_id,
    stage: stage || advice.stage || null,
    hits,
  };
  return {
    tenant_id: tenantId || 'system',
    scenario_id: advice.scenario_id,
    stage: stage || advice.stage || null,
    advice_tier: advice.tier || null,
    disposition: advice.disposition || null,
    coverage: Number.isFinite(Number(advice.coverage)) ? Number(advice.coverage) : null,
    card_confidence: typeof confidence === 'string' ? confidence : null,
    headline: advice.headline ? String(advice.headline).slice(0, 200) : null,
    summary: buildStructuredSummary(structured).slice(0, SUMMARY_MAX),
    hits: JSON.stringify(hits),
    // 条件清单只保留标识与标签，不保留任何自然语言原文
    conditions: JSON.stringify([
      ...reasons.map((r) => ({ cond: r?.cond ?? null, label: r?.label ?? null, ok: true })),
      ...gaps.map((g) => ({ cond: g?.cond ?? null, label: g?.label ?? null, ok: false })),
    ]),
    risk_flags: JSON.stringify(redlines.map((r) => r?.cond ?? r?.label ?? null).filter(Boolean)),
    actor_id: actorLabel(actor),
    actor_role: actor?.role || actor?.role_tag || null,
    source,
  };
}

// 落库（fail-open：任何异常只 trace，绝不抛给调用方）
export async function recordAdvice(advice, opts = {}) {
  let row = null;
  try {
    row = buildAdviceRecord(advice, opts);
  } catch (e) {
    emit('trace', 'advice-record-build-failed', { error: String(e?.message || e) });
    return null;
  }
  if (!row) return null; // 未定位到场景 → 不落库
  try {
    const r = await query(
      `INSERT INTO crm.advice_record
         (tenant_id, scenario_id, stage, advice_tier, disposition, coverage, card_confidence,
          headline, summary, hits, conditions, risk_flags, actor_id, actor_role, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13,$14,$15)
       RETURNING advice_id`,
      [row.tenant_id, row.scenario_id, row.stage, row.advice_tier, row.disposition, row.coverage,
        row.card_confidence, row.headline, row.summary, row.hits, row.conditions, row.risk_flags,
        row.actor_id, row.actor_role, row.source]
    );
    return r.rows[0]?.advice_id || null;
  } catch (e) {
    // 表未迁移等情形：不阻断建议主链路，但必须留痕（禁静默）
    emit('trace', 'advice-record-write-failed', { scenario_id: row.scenario_id, error: String(e?.message || e) });
    return null;
  }
}

// 采纳配对（后置回填）：该建议最终落成的决策锚点。零 DELETE，UPDATE 覆盖。
export async function linkAdviceToDecision(adviceId, decisionId, { tenantId = 'system' } = {}) {
  if (!adviceId || !decisionId) return 0;
  try {
    const r = await query(
      `UPDATE crm.advice_record SET linked_decision_id=$3
        WHERE advice_id=$1 AND tenant_id=$2`,
      [adviceId, tenantId, decisionId]
    );
    return r.rowCount || 0;
  } catch (e) {
    emit('trace', 'advice-link-failed', { adviceId, error: String(e?.message || e) });
    return 0;
  }
}

// 观测读取（租户隔离：租户行 + system 兜底，与既有 tenant 回退范式一致）
export async function listAdvice({ tenantId = 'system', scenarioId = null, limit = 50 } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const r = await query(
    `SELECT advice_id, tenant_id, scenario_id, stage, advice_tier, disposition, coverage,
            card_confidence, headline, summary, hits, risk_flags, actor_id, actor_role, source,
            linked_decision_id, created_at
       FROM crm.advice_record
      WHERE (tenant_id=$1 OR tenant_id='system')
        AND ($2::text IS NULL OR scenario_id=$2)
      ORDER BY created_at DESC LIMIT $3`,
    [tenantId, scenarioId, lim]
  );
  return r.rows;
}
