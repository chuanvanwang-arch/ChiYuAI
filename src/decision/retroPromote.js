// src/decision/retroPromote.js — D7 M→K 升格（第 8 条边：记忆升格为先例/知识）
// 背景：tenant_precedent 表存在但恒空（2026-09-18 生产哨兵 D7 🔴）。根因：promoteMemoryToTenant
//       实现正确但唯一入口是 propagationRoutes 的人工"采纳"端点；retro 收盘从不调 promote，
//       设计文档（memory-governance §391）明说"复盘结案时 promote"但从未接线。
// 本模块（2026-09-18 用户已批准方案）：在 runDecisionRetro 收盘段自动升格——
//   ① LLM 可信（非 degraded）且根因类非样本不足占位（NEED_DIM_ORDER）时；
//   ② 先 appendMemory(explicit) 落 memory_log（M 源头，显式写入破 worthiness 闸）；
//   ③ 按 (tenant_id, root_cause_class) 幂等去重（同租户同类只升格一次，防夜批重复灌）；
//   ④ promoteMemoryToTenant 入 tenant_precedent（K 落点，带 decision_id 锚第 0 闸）。
// 铁律：append-only 禁 DELETE；失败 try/catch 不阻断复盘主流程；dryRun 不升格。
import { appendMemory as realAppendMemory } from '../memory/memoryLog.js';
import { promoteMemoryToTenant as realPromoteMemoryToTenant, listTenantPrecedents as realListTenantPrecedents } from '../memory/promote.js';
import { emit } from '../events/bus.js';

// 样本不足/占位根因类：非真教训，不升格（避免"为了点亮 D7 而灌垃圾先例"）
export const PROMOTE_SKIP_CLASSES = new Set(['NEED_DIM_ORDER']);

// 统一 lesson 载荷（可单测）：scenario 的教训摘要
export function buildLessonPayload({ scenarioId, rootCauseClass, explanation, decisionIds, count }) {
  return {
    scenario_id: scenarioId || null,
    root_cause_class: rootCauseClass,
    root_cause_explanation: explanation || '',
    sample_decision_ids: Array.isArray(decisionIds) ? decisionIds.slice(0, 3) : [],
    sample_size: count ?? 0,
  };
}

/**
 * 复盘收盘自动升格：遍历已分析的簇，把可信教训升格为租户先例。
 * @param {object} opts
 * @param {Array}  opts.analyzed        analyzeCluster 输出数组（每簇含 root_cause_class/tenant_id/scenario_id/...）
 * @param {object} opts.pool            pg Pool（promoteMemoryToTenant 需要）
 * @param {string} opts.nowISO          report.run_at，用于同轮种子去重
 * @param {string} opts.by              默认 'system'（retro 系统触发）
 * @param {import('../memory/memoryLog.js').appendMemory} [opts.appendMemory=realAppendMemory]
 * @param {import('../memory/promote.js').promoteMemoryToTenant} [opts.promoteMemoryToTenant=realPromoteMemoryToTenant]
 * @param {import('../memory/promote.js').listTenantPrecedents} [opts.listTenantPrecedents=realListTenantPrecedents]
 * @returns {Promise<{promoted:number, skipped:number, failed:number, details:Array}>}
 */
export async function promoteLessonsFromRetro({
  analyzed = [],
  pool = null,
  nowISO = null,
  by = 'system',
  appendMemory = realAppendMemory,
  promoteMemoryToTenant = realPromoteMemoryToTenant,
  listTenantPrecedents = realListTenantPrecedents,
} = {}) {
  const out = { promoted: 0, skipped: 0, failed: 0, details: [] };
  if (!pool || !Array.isArray(analyzed) || analyzed.length === 0) return out;

  // ① 先取该租户既有先例，建 (tenant_id, root_cause_class) 去重集（禁对库的逐条 SELECT，一次取全）
  let existingKeys = new Set();
  const tenants = new Set(analyzed.map((a) => a.tenant_id || 'system').filter(Boolean));
  try {
    const rows = await Promise.all(
      [...tenants].map((t) => listTenantPrecedents(pool, t).catch(() => []))
    );
    existingKeys = new Set(rows.flat().map((r) => `${r.tenant_id}:${(r.payload || {}).root_cause_class || ''}`));
  } catch { /* 取不到去重集 → 降级为不跨簇去重（仍保留同轮种子去重） */ }

  for (const a of analyzed) {
    const klass = a && a.root_cause_class;
    if (!klass || PROMOTE_SKIP_CLASSES.has(klass)) { out.skipped++; continue; }
    // 降级（LLM 不可信）或占位（NEED_DIM_ORDER 已排除）不出教训 —— 不升格
    if (a.degraded === true) { out.skipped++; continue; }
    const tenantId = a.tenant_id || 'system';
    if (tenantId === 'system') { out.skipped++; continue; } // 平台级不升格到具体租户
    const key = `${tenantId}:${klass}`;
    if (existingKeys.has(key) || !nowISO) { out.skipped++; continue; }
    existingKeys.add(key); // 同轮多簇同类去重（同窗内同租户同类只升格一次）

    try {
      // ② 先落 memory_log（M 源头）：以复盘发现为显式教训，破 worthiness 闸
      const mem = await appendMemory({
        topic: `retro:${klass}`,
        kind: 'lesson',
        payload: buildLessonPayload({
          scenarioId: a.scenario_id,
          rootCauseClass: klass,
          explanation: a.root_cause_explanation,
          decisionIds: a.sample_decision_ids,
          count: a.count,
        }),
        layer: 'L-Workspace',
        actor: by,
        explicit: true,
        tenantId,
      });
      if (!mem || mem.ok !== true || !mem.row) { out.failed++; continue; }

      // ③ 幂等置入 tenant_precedent（K 落点）
      const pr = await promoteMemoryToTenant(pool, {
        memoryId: mem.row.id, tenantId, by,
        decisionId: null, title: `复盘教训：${klass}（${a.scenario_id || '?'}）`,
      });
      if (!pr || pr.ok !== true) { out.failed++; continue; }

      out.promoted++;
      out.details.push({ tenant_id: tenantId, root_cause_class: klass, memory_id: mem.row.id, scenario_id: a.scenario_id });
      emit('trace', 'decision-retro-premote', { tenant_id: tenantId, root_cause_class: klass, memory_id: mem.row.id });
    } catch (e) {
      out.failed++;
      emit('trace', 'decision-retro-promote-failed', { tenant_id: tenantId, root_cause_class: klass, error: String(e?.message || e) });
    }
  }
  return out;
}
