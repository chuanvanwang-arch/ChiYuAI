// src/scheduler/riskScanner.js — crm-risk 真扫描器（G3 C1：全量重算 AI 属性 + 差异检测 + trace 观测）
// 设计输入：docs/superpowers/specs/2026-08-26-observability-risk-scan-design.md §3/§4-C1
// ⚠️ 依赖真实 PG（query 直查 + 直接合并 payload.ai 落库）；沙箱无 PG 时纯逻辑由 test/observability-risk-scan.test.js 契约锁
// 2026-08-28 接线修复（B 方案·批量单调用）：原先 timers.js 恒传 llm:null → 即使后台配了 LLM 也永远走确定性兜底。
//   现改为：未显式传 llm/llmBatch 时自动按 config_store('llm') 解析批量适配器（src/llm/aiAttributes.js），
//   每条粒子 1 次调用算完 6 个属性；未配置/失败/超时 → null → 该条回退确定性兜底并标 degraded。
import { query } from '../db.js';
import { evaluateAiAttributesForAsync } from '../aiAttributes/evaluator.js';
import { resolveAiAttributeLlm } from '../llm/aiAttributes.js';
import { emit } from '../events/bus.js';

const SCAN_TYPES = ['CRM_DEAL', 'CRM_ACCOUNT', 'CRM_CONTACT'];
// 单轮扫描的 LLM 调用预算：超出部分走确定性兜底（防粒子规模增长击穿额度/触发限流）
export const AI_LLM_BUDGET = 200;

// 全量扫描：三类粒子 → 逐条评估 AI 属性 → ai 差异才直写 payload.ai → trace 完成
// 参数语义：
//   llm      — 逐属性 LLM（历史契约；显式传入含 null 时不自动解析配置）
//   llmBatch — 批量 LLM 适配器（测试注入用）
//   两者都不传 → 自动解析 config_store('llm')
// 探测：DEAL 止损已触发 → 告警（只读粒子 payload，不写业务数据；设计 Task 3）
export function collectStopLossAlerts(entities = []) {
  const alerts = [];
  for (const e of entities) {
    if (e.type !== 'CRM_DEAL') continue;
    const sl = e.payload && e.payload.stop_loss;
    if (sl && sl.status === 'triggered') {
      alerts.push({ type: 'stop_loss_triggered', deal_id: e.id, severity: 'medium-high' });
    }
  }
  return alerts;
}

export async function runRiskScan(opts = {}) {
  const { llm, llmBatch, dryRun = false, llmBudget = AI_LLM_BUDGET } = opts;
  const explicit = 'llm' in opts || 'llmBatch' in opts;
  let batch = llmBatch ?? null;
  if (!explicit) {
    batch = await resolveAiAttributeLlm().catch(() => null);
  }
  const perAttr = llm ?? null;

  const r = await query(
    `SELECT id, type, payload FROM crm.particles
     WHERE type = ANY($1::text[])`,
    [SCAN_TYPES]
  );
  const entities = r.rows;
  let changed = 0;
  let degraded = 0;
  let llmCalls = 0;
  for (let i = 0; i < entities.length; i++) {
    const e = entities[i];
    const useBatch = batch && i < llmBudget ? batch : null;
    if (useBatch) llmCalls += 1;
    const { ai, degraded: d } = await evaluateAiAttributesForAsync(e, { llm: perAttr, llmBatch: useBatch });
    if (d) degraded += 1;
    const prev = JSON.stringify(e.payload?.ai || {});
    const next = JSON.stringify(ai);
    if (next !== prev) {
      if (!dryRun) {
        // 直接合并 payload.ai，绕开 updateParticle 的整条写时管道（ontologySync F18 工商校验/
        // embedding/审计重跑）——扫描器只重算 AI 属性，不应触发本体重同步或校验拒绝；
        // 写法与 createParticle:36 同款（payload || {ai}::jsonb）
        await query(
          `UPDATE crm.particles SET payload = payload || $1::jsonb WHERE id=$2`,
          [JSON.stringify({ ai }), e.id]
        );
      }
      changed += 1;
    }
  }
  // 止损触发探测（只读粒子 payload，不写业务数据；设计 Task 3）
  const alerts = collectStopLossAlerts(entities);
  for (const a of alerts) emit('crm-risk-alert', a);

  emit('trace', 'crm-risk-scan', {
    scanned: entities.length, changed, degraded,
    llm_calls: llmCalls, llm_enabled: Boolean(batch || perAttr), alerts,
  });
  return { scanned: entities.length, changed, degraded, llm_calls: llmCalls, llm_enabled: Boolean(batch || perAttr), alerts };
}
