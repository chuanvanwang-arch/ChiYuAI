// src/agent/eventTrigger.js — 事件触发式智能体派发（C1 首批）
// 订阅 ontology 域 → 矩阵判定 → 三级防风暴 → 建派发任务（只读判定型 SKILL）
// 设计：docs/2026-09-03-agent-event-trigger-design.md ｜ 不新增 agent / SKILL / 定时器
import { on, emit } from '../events/bus.js';
import { readConfig } from '../config/configStore.js';
import { query, queryWrite } from '../db.js';
import { recordFailure } from '../monitor/monitorStore.js';

const CONFIG_KEY = 'agent-event-trigger';

// 出厂默认（唯一事实源；config_store 缺键时回退，保证触发器不抛错）
export const AGENT_EVENT_TRIGGER_DEFAULT = {
  enabled: true,
  cooldown_ms: 300000,
  matrix: [
    { domain: 'ontology', type: 'ontology-sync', entity_type: 'CRM_DEAL',
      intent: 'stage-progression', agent: 'quote-engine',
      skill_slug: 'method-stage-progression', dedup_field: 'payload.stage' },
    { domain: 'ontology', type: 'ontology-sync', entity_type: 'CRM_ACCOUNT',
      intent: 'funnel-classification', agent: 'followup-agent',
      skill_slug: 'method-funnel-classification', dedup_field: 'payload.tier' },
    { domain: 'ontology', type: 'ontology-sync', entity_type: 'CRM_KNOWLEDGE',
      intent: 'decision-enrich', agent: 'decision-agent',
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

// 纯函数：根据事件类型+实体类型匹配矩阵行；非只读 SKILL 直接拒（留痕）
export function matchTrigger(evType, evPayload, config) {
  if (!config || !config.enabled) return null;
  const m = (config.matrix || []).find(
    (x) => x.domain === 'ontology' && x.type === evType && x.entity_type === evPayload?.entity_type
  );
  if (!m) return null;
  if (!READ_ONLY_SKILLS.has(m.skill_slug)) {
    emit('trace', 'agent-event-trigger-rejected', { intent: m.intent, skill_slug: m.skill_slug, reason: 'not-readonly' });
    return null;
  }
  return m;
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

export function registerAgentEventTrigger() {
  if (unsubscribe) return; // 幂等
  unsubscribe = on('ontology', (msg) => {
    const { type, payload, summary } = msg;
    const evt = payload || summary || {};
    const tenantId = evt.tenant_id || 'system';
    loadTriggerConfig({ tenantId })
      .then((cfg) => {
        const m = matchTrigger(type, evt, cfg);
        if (m) return tryDispatch(m, evt, tenantId);
      })
      .catch((e) => recordFailure('agent-event-trigger-load', e));
  });
}

export function unregisterAgentEventTrigger() {
  if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  cooldownMap.clear();
}
