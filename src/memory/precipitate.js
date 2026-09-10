// src/memory/precipitate.js — C3 粒子写入自动记忆沉淀（P2）
//
// 定位：把「事实变更」自动变成客户记忆，不再依赖调用方记得手动 crm-memory-upsert。
//   R3/R4 根因：沉淀只挂决策落库与决策 SKILL step2，粒子写入（改阶段/改金额/改负责人）
//   完全不沉淀 → 销售改了商机却查不到历史。
//
// 三重防雪崩（缺一不可，否则 62 万条噪声会换个形态重演）：
//   ① 价值闸  —— appendMemory 内 judgeWorthiness（凭证/瞬态噪声/价值视界）
//   ② 字段闸  —— 只沉淀规则显式 watch 的字段，且值**真的变了**（同值提交 0 条）
//   ③ 去重窗  —— 同 (锚点, topic, 字段, 新值) 在 dedupeHours 内已写过 → 跳过
//
// 配置化铁律：规则走 config_store['memory-precipitate-rules']，代码内只是**出厂缺省**。
//   禁在逻辑里硬编码业务字段与行业字面量。
// 失败策略：fail-open —— 沉淀失败只 emit trace + recordFailure，绝不阻断业务写。
import { query } from '../db.js';
import { appendMemory, resolveEntityAnchor } from './memoryLog.js';

// 出厂缺省规则（config_store 缺失时使用；覆盖后以配置为准）
// 2026-09-10 C3 收口：拓宽 CRM_DEAL 监控字段（status/decision_chain/scope）、
//   CRM_ACCOUNT（business_tier/named_owner）、CRM_CONTACT（decision_power），
//   并新增 CRM_QUOTATION/CRM_CONTRACT/CRM_APPROVAL_FLOW 域（报价/合同/审批事实变更自动沉淀）。
//   禁硬编码行业字面量以外的业务字段；新增域统一走 kind='fact'。
export const DEFAULT_RULES = {
  dedupeHours: 24,
  rules: [
    { type: 'CRM_DEAL', fields: ['stage', 'amount', 'owner', 'expected_close_date', 'close_date', 'status', 'decision_chain', 'scope'], topic: 'deal:field-change', ttlDays: 180 },
    { type: 'CRM_ACCOUNT', fields: ['industry', 'tier', 'business_tier', 'named_owner', 'name'], topic: 'account:field-change', ttlDays: 365 },
    { type: 'CRM_CONTACT', fields: ['role', 'title', 'phone', 'decision_power'], topic: 'contact:field-change', ttlDays: 365 },
    { type: 'CRM_QUOTATION', fields: ['amount', 'discount_rate', 'status'], topic: 'quote:change', ttlDays: 180 },
    { type: 'CRM_CONTRACT', fields: ['status', 'amount'], topic: 'contract:change', ttlDays: 365 },
    { type: 'CRM_APPROVAL_FLOW', fields: ['status'], topic: 'approval:change', ttlDays: 180 },
  ],
};

const norm = (v) => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
};

/** 纯函数：字段级 diff（只比较规则 watch 的字段；值未变不产出）。可单测，无 DB。 */
export function diffFields(before = {}, after = {}, fields = []) {
  const out = [];
  for (const f of fields) {
    const a = norm(before?.[f]);
    const b = norm(after?.[f]);
    if (a === b) continue;               // 同值提交 → 不产出（防雪崩 ②）
    if (b === null || b === undefined || b === '') continue; // 清空不沉淀（删值非事实推进）
    out.push({ field: f, from: a, to: b });
  }
  return out;
}

/** 纯函数：按规则判定是否沉淀。可单测，无 DB。 */
export function shouldPrecipitate({ type = null, before = null, after = null, config = DEFAULT_RULES } = {}) {
  const rules = Array.isArray(config?.rules) ? config.rules : [];
  const rule = rules.find((r) => r.type === type);
  if (!rule) return { ok: false, reason: 'no-rule', changes: [] };
  if (!Array.isArray(rule.fields) || !rule.fields.length) return { ok: false, reason: 'no-fields', changes: [] };
  const changes = diffFields(before, after, rule.fields);
  if (!changes.length) return { ok: false, reason: 'no-change', changes: [] };
  return {
    ok: true,
    changes,
    topic: rule.topic || `particle:${type}`,
    ttlDays: Number(rule.ttlDays) || 180,
    kind: rule.kind || 'fact',
  };
}

async function loadRules(tenantId) {
  try {
    const { readConfig } = await import('../config/configStore.js');
    const cfg = await readConfig('memory-precipitate-rules', { tenantId: tenantId || 'system' });
    if (cfg && Array.isArray(cfg.rules)) {
      return { dedupeHours: Number(cfg.dedupeHours) || DEFAULT_RULES.dedupeHours, rules: cfg.rules };
    }
  } catch { /* 配置不可用 → 出厂缺省生效 */ }
  return DEFAULT_RULES;
}

// 防雪崩 ③：24h 去重窗（同锚点+topic+字段+新值近期已沉淀则跳过）
async function recentlyPrecipitated({ entityId, topic, changes, dedupeHours }) {
  if (!entityId) return false;
  try {
    const r = await query(
      `SELECT 1 FROM crm.memory_log
        WHERE entity_id=$1 AND topic=$2 AND archived IS NOT TRUE
          AND created_at > now() - ($3 || ' hours')::interval
          AND payload->>'changeKeys' = $4
        LIMIT 1`,
      [entityId, topic, String(dedupeHours), changes.map((c) => `${c.field}=${c.to}`).sort().join(',')]
    );
    return r.rows.length > 0;
  } catch {
    return false; // 查不到 → 不因此阻断沉淀（宁可重复一条，不丢一条事实）
  }
}

/**
 * 粒子写入后的记忆沉淀入口（fail-open）。
 * @param {object} after  写入后的粒子行（含 payload）
 * @param {object} before 写入前的粒子行（含 payload）
 * @param {object} [opts] { tenantId, actor, decisionId }
 * @returns {Promise<{ok:boolean, reason?:string, memoryId?:string}>}
 */
export async function precipitateFromParticleWrite(after, before, opts = {}) {
  try {
    const type = after?.type || before?.type || null;
    const isCreate = !before;                       // 建档模式：before 为 null
    const tenantId = opts.tenantId || after?.tenant_id || null;
    if (!type) return { ok: false, reason: 'no-type' };

    const config = await loadRules(tenantId);
    const verdict = shouldPrecipitate({
      type, before: before?.payload, after: after?.payload, config,
    });
    if (!verdict.ok) return { ok: false, reason: verdict.reason };

    const anchor = resolveEntityAnchor({ payload: after?.payload || {} });
    const entityId = anchor.entity_id || after?.id || null;
    if (await recentlyPrecipitated({
      entityId, topic: verdict.topic, changes: verdict.changes, dedupeHours: config.dedupeHours,
    })) return { ok: false, reason: 'dedupe-window' };

    const payload = {
      type, id: after?.id || null,
      changeType: isCreate ? 'created' : 'field-change',
      changes: verdict.changes,
      changeKeys: verdict.changes.map((c) => `${c.field}=${c.to}`).sort().join(','),
      actor: opts.actor || null,
      decision_id: opts.decisionId || null,
      // summary 键是消费端硬契约（injector.js#memoryText 只认 text|summary|note|content）
      summary: isCreate
        ? `创建 ${type}（${after?.id || ''}）`
        : `${type} ${verdict.changes.map((c) => `${c.field}: ${c.from ?? '空'} → ${c.to}`).join('；')}`,
    };

    const res = await appendMemory({
      topic: verdict.topic,
      kind: verdict.kind,
      payload,
      layer: 'L-Workspace',
      actor: opts.actor || null,
      eventType: isCreate ? 'particle-created' : 'particle-updated',
      ttlDays: verdict.ttlDays,
      explicit: true,               // 事实变更属高价值，豁免价值视界闸
      tenantId,
      entityId,
      entityType: anchor.entity_type,
    });
    if (!res?.ok) return { ok: false, reason: res?.code || 'append-failed' };
    return {
      ok: true, memoryId: res.row?.id, row: res.row, changes: verdict.changes.length,
      topic: verdict.topic, changeType: payload.changeType,
    };
  } catch (e) {
    try {
      const { emit } = await import('../events/bus.js');
      emit('trace', 'memory-precipitate-failed', { id: after?.id, error: String(e?.message || e) });
      const { recordFailure } = await import('../monitor/monitorStore.js');
      recordFailure('memory-precipitate-failed', e);
    } catch { /* 二次失败不抛 */ }
    return { ok: false, reason: 'exception' };
  }
}
