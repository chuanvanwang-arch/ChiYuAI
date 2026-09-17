// src/agent/eventTrigger.js — 事件触发式智能体派发（C1 首批）
// 订阅 ontology 域 → 矩阵判定 → 三级防风暴 → 建派发任务（只读判定型 SKILL）
// 设计：docs/2026-09-03-agent-event-trigger-design.md ｜ 不新增 agent / SKILL / 定时器
import { on, emit } from '../events/bus.js';
import { readConfig } from '../config/configStore.js';
import { query, queryWrite, pool } from '../db.js';
import { recordFailure } from '../monitor/monitorStore.js';
import { createSignalStore } from '../signal/store.js';

const CONFIG_KEY = 'agent-event-trigger';

// 出厂默认（唯一事实源；config_store 缺键时回退，保证触发器不抛错）
// T12（2026-09-16）：矩阵扩三源——旧 3 行补 source:'event'（向后兼容），
//   新增 particle/approval（变更型域）+ timer/external 源行；旧行语义不变。
export const AGENT_EVENT_TRIGGER_DEFAULT = {
  enabled: true,
  cooldown_ms: 300000,
  matrix: [
    { source: 'event', domain: 'ontology', type: 'ontology-sync', entity_type: 'CRM_DEAL',
      intent: 'stage-progression', agent: 'quote-engine',
      skill_slug: 'method-stage-progression', dedup_field: 'payload.stage' },
    { source: 'event', domain: 'ontology', type: 'ontology-sync', entity_type: 'CRM_ACCOUNT',
      intent: 'funnel-classification', agent: 'followup-agent',
      skill_slug: 'method-funnel-classification', dedup_field: 'payload.tier' },
    { source: 'event', domain: 'ontology', type: 'ontology-sync', entity_type: 'CRM_KNOWLEDGE',
      intent: 'decision-enrich', agent: 'decision-agent',
      skill_slug: 'method-decision-enrich', dedup_field: null },
    // T12 新增：变更型域（particle/approval/decision）向后兼容扩矩阵
    { source: 'event', domain: 'particle', type: 'particle-change', entity_type: 'CRM_ACCOUNT',
      intent: 'funnel-classification', agent: 'followup-agent',
      skill_slug: 'method-funnel-classification', dedup_field: 'payload.tier' },
    { source: 'event', domain: 'approval', type: 'approval-event', entity_type: 'CRM_DEAL',
      intent: 'decision-enrich', agent: 'decision-agent',
      skill_slug: 'method-decision-enrich', dedup_field: null },
    // T12 新增：timer / external 源（由 timers.js / sync 引擎调用 dispatchFromTrigger）
    { source: 'timer', domain: 'schedule', type: 'signal-schedule', entity_type: 'CRM_DEAL',
      intent: 'quote-timeout', agent: 'quote-engine',
      skill_slug: 'method-stage-progression', dedup_field: null },
    { source: 'external', domain: 'external-sync', type: 'sync-new', entity_type: 'CRM_ACCOUNT',
      intent: 'discovery-research', agent: 'decision-agent',
      skill_slug: 'method-decision-enrich', dedup_field: null },
  ],
};

// 只读白名单闸（fail-closed）：事件触发任务无 decision_id，写操作必被第 0 闸拒；
// 首批只派发 kind:'read' 的 SKILL
export const READ_ONLY_SKILLS = new Set([
  'method-stage-progression', 'method-funnel-classification', 'method-decision-enrich',
]);

let unsubscribe = null;
const cooldownMap = new Map(); // 内存冷却（辅助，进程重启即失效）
// T12：感知落库信号 store（模块级，由 setSignalStore 在启动期注入；测试可注入替身）。
//   不自动从 pool 创建，避免单测（registerAgentEventTrigger 集成测试）无谓落库污染。
let signalStoreRef = null;
export function setSignalStore(poolOrStore) {
  signalStoreRef = poolOrStore && typeof poolOrStore.query === 'function' ? createSignalStore(poolOrStore) : poolOrStore;
}

// 读配置，缺键安全回退出厂默认
export async function loadTriggerConfig({ tenantId = 'system' } = {}) {
  const r = await readConfig(CONFIG_KEY, { tenantId });
  if (!r || !r.value) return AGENT_EVENT_TRIGGER_DEFAULT;
  const v = r.value || {};
  return {
    ...AGENT_EVENT_TRIGGER_DEFAULT,
    ...v,
    matrix: Array.isArray(v.matrix) && v.matrix.length ? v.matrix : AGENT_EVENT_TRIGGER_DEFAULT.matrix,
  };
}

// 取去重键中的「当前值」：事件载荷不含 stage/tier（recordEvent 仅落 entity_id/type/tenant_id），
// 故从粒子当前 payload 读（只读，安全）。dedup_field=null → 'new'（每次都算新）
async function resolveDedupValue(entityId, dedupField, tenantId) {
  if (!dedupField) return 'new';
  const key = dedupField.split('.').pop();
  try {
    // 租户化（T8，P0）：去重键取值本租户粒子（防 entity_id 撞号跨租串取；粒子 id 全局唯一，条件为双保险）
    const r = await query('SELECT payload FROM crm.particles WHERE id=$1 AND tenant_id=$2', [entityId, tenantId]);
    const p = r.rows[0]?.payload || {};
    return p[key] ?? '';
  } catch {
    return '';
  }
}

// 纯函数：三源统一匹配（source + domain + type + entity_type）；非只读 SKILL 直接拒（留痕）
// T12：source 缺省视为 'event'（向后兼容旧矩阵行）；timer/external 源行由此可匹配。
export function matchTriggerBySource(desc, config) {
  if (!config || !config.enabled) return null;
  const m = (config.matrix || []).find(
    (x) => (x.source || 'event') === desc.source
      && x.domain === desc.domain
      && x.type === desc.type
      && x.entity_type === desc.entity_type
  );
  if (!m) return null;
  if (!READ_ONLY_SKILLS.has(m.skill_slug)) {
    emit('trace', 'agent-event-trigger-rejected', { intent: m.intent, skill_slug: m.skill_slug, reason: 'not-readonly' });
    return null;
  }
  return m;
}

// 向后兼容旧签名：旧调用方仅匹配 ontology 域事件（source 恒 'event'）
export function matchTrigger(evType, evPayload, config) {
  return matchTriggerBySource(
    { source: 'event', domain: 'ontology', type: evType, entity_type: evPayload?.entity_type },
    config,
  );
}

// 纯函数：构建去重键（单测用；值直接取 evPayload）
export function dedupKeyFor(match, evPayload) {
  const val = evPayload?.[match.dedup_field?.split('.').pop()] ?? '';
  return `${evPayload?.entity_id}:${match.intent}:${val === '' ? 'new' : val}`;
}

async function tryDispatch(match, evPayload, tenantId) {
  const curVal = await resolveDedupValue(evPayload.entity_id, match.dedup_field, tenantId);
  const dedupKey = `${evPayload.entity_id}:${match.intent}:${curVal === '' ? 'new' : curVal}`;
  const now = Date.now();
  // ② 内存冷却（辅助）
  const last = cooldownMap.get(dedupKey);
  const cool = match.cooldown_ms ?? 300000;
  if (last && now - last < cool) {
    emit('trace', 'agent-event-trigger-skipped', { dedup_key: dedupKey, reason: 'cooldown' });
    return;
  }
  // ① DB 去重（主，重启后仍有效）
  try {
    const dup = await query(
      // 租户化（T8，P0）：同 dedup_key 跨租户防撞（A/B 同名 key 各自派发，任务表已带 tenant_id）
      `SELECT 1 FROM crm.tasks
       WHERE tenant_id=$2 AND payload->>'dedup_key'=$1 AND status IN ('ready','running')
       LIMIT 1`,
      [dedupKey, tenantId]
    );
    if (dup.rows.length) {
      emit('trace', 'agent-event-trigger-skipped', { dedup_key: dedupKey, reason: 'db-dedup' });
      return;
    }
  } catch (e) {
    recordFailure('agent-event-trigger-dedup', e); // 查失败保守放行 + 留痕
  }
  cooldownMap.set(dedupKey, now);
  try {
    await queryWrite(
      `INSERT INTO crm.tasks (tenant_id, step, title, action_name, payload, status)
       VALUES ($1,'agent-event-trigger',$2,$3,$4::jsonb,'ready')`,
      [tenantId,
       `事件触发·${match.intent}·${evPayload.entity_id}`,
       'agent-dispatch',
       JSON.stringify({
         intent: match.intent,
         targetAgent: match.agent,
         entity_id: evPayload.entity_id,
         entity_type: evPayload.entity_type,
         dedup_key: dedupKey,
         skill_slug: match.skill_slug,
         dispatchedFrom: 'intake-router',
       })]
    );
    emit('trace', 'agent-event-trigger-dispatch', { dedup_key: dedupKey, agent: match.agent, skill_slug: match.skill_slug });
  } catch (e) {
    recordFailure('agent-event-trigger-dispatch', e);
    emit('trace', 'agent-event-trigger-failed', { dedup_key: dedupKey, error: e?.message });
  }
}

// T12：感知落库（三类源匹配即记一条 crm.signal；dedup 生效）。
//   ⚠ E5-2 修正（2026-09-16，设计附录 E.5）：本函数是**判据 B（`gen_silent`）的前提量来源**
//   （`src/monitor/signalMetrics.js` 以 `crm.signal.source='event-trigger'` 的行数当"命中"），
//   而此前它有**两处静默**，使「前提量缺失」与「本来就没命中」**不可区分** ⇒ 判据 B 对"感知桥全断"结构性失明
//   （**桥越坏、判据越安静**，属"自指仪器"族）：
//     ① `!signalStoreRef` 直接 `return null` —— **未注入 ≠ 未命中**，且无任何留痕；
//     ② 写入失败 `.catch(() => null)` 空吞 —— 违 §15「不静默失败」。
//   现两处均留痕。**返回契约刻意不变**（失败仍 resolve `null`，不向调用方抛）：
//   调用方 `dispatchFromTrigger` 是 `await` 且无 try/catch，抛异常会打断派发主流程 ——
//   留痕的目的是"可观测"，不是"改变失败语义"。
async function recordPerception({ tenantId, m, evPayload }) {
  if (!signalStoreRef) {
    emit('trace', 'agent-event-trigger-perception-skipped', {
      tenant_id: tenantId, intent: m.intent, reason: 'signal-store-not-injected',
    });
    return null;
  }
  return signalStoreRef.create({
    tenant_id: tenantId, source: 'event-trigger', kind: m.intent,
    severity: 'medium', target_role: 'sales',
    particle_id: evPayload?.entity_id || null,
    payload: { subject: `${m.intent} 感知`, intent: m.intent },
    evidence: { source: m.source, domain: m.domain },
    dedup_key: `evt:${m.intent}:${evPayload?.entity_id || evPayload?.externalId || 'new'}`,
  }).catch((e) => {
    recordFailure('agent-event-trigger-perception', e);
    emit('trace', 'agent-event-trigger-perception-failed', {
      tenant_id: tenantId, intent: m.intent, error: String(e?.message || e),
    });
    return null;
  });
}

// T12：三源统一 dispatch（模块级，registerAgentEventTrigger 事件路径 + createEventTrigger 共用）
async function dispatchFromTrigger(desc, evPayload, tenantId) {
  const cfg = await loadTriggerConfig({ tenantId });
  const m = matchTriggerBySource(desc, cfg);
  if (!m) return null;
  // 感知落库（统一；只读闸只约束任务派发，不约束感知信号）
  await recordPerception({ tenantId, m, evPayload });
  if (READ_ONLY_SKILLS.has(m.skill_slug)) {
    await tryDispatch(m, evPayload, tenantId);
  }
  return m;
}

// T12：工厂（供 timers/sync 的 timer/external 路径注入 pool 取得 signalStore；事件路径用模块级 dispatchFromTrigger）
export function createEventTrigger({ pool } = {}) {
  const signalStore = pool ? createSignalStore(pool) : null;
  return { dispatchFromTrigger, matchTriggerBySource, signalStore };
}

export function registerAgentEventTrigger() {
  if (unsubscribe) return; // 幂等
  const domains = ['ontology', 'particle', 'approval', 'decision'];
  const offs = domains.map((d) => on(d, (msg) => {
    const { type, payload, summary } = msg;
    const evt = payload || summary || {};
    const tenantId = evt.tenant_id || 'system';
    // T12：扩域订阅；统一走 dispatchFromTrigger（感知落库 + 只读 SKILL 派发）
    dispatchFromTrigger({ source: 'event', domain: d, type, entity_type: evt.entity_type }, evt, tenantId)
      .catch((e) => recordFailure('agent-event-trigger-load', e));
  }));
  unsubscribe = () => offs.forEach((f) => f());
}

export function unregisterAgentEventTrigger() {
  if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  cooldownMap.clear();
}
