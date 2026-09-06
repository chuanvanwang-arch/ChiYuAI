// src/alerts/alertHook.js — 写时触发接线（粒子写事件 → 规则判定 → 告警落库 + SSE alert 域转播）
// 设计输入：docs/2026-08-25-alert-feedback-loop-design.md §E（写时触发接线，不阻塞主事务）
// 职责：registerAlertHook() 订阅 bus 'particle' 域；命中规则 → createAlert（open）→ emit('alert', ...) SSE 转播
// 2026-09-05 G3：事件上下文透传租户（粒子写事件不携带 tenant_id → 从粒子 id 反查；fail-open 回落 system + trace）
import { on, emit } from '../events/bus.js';
import { query } from '../db.js';
import { evaluateForEvent } from './alertRegistry.js';
import { createAlert } from './alertStore.js';

let unsubscribe = null;

async function resolveTenant(evt) {
  // 事件可能携带 tenant_id（部分写路径已有）；否则粒子 id 反查（禁裸 catch：失败记 trace + fail-open system）
  if (evt.tenant_id) return evt.tenant_id;
  if (!evt.id && !evt.particle_id) return 'system';
  const id = evt.id || evt.particle_id;
  try {
    const r = await query(`SELECT tenant_id FROM crm.particles WHERE id=$1`, [id]);
    return r.rows[0]?.tenant_id || 'system';
  } catch (e) {
    emit('trace', 'alert-tenant-resolve-failed', { id, error: String(e?.message || e) });
    return 'system';
  }
}

// 订阅粒子写事件（bus 同步分发但订阅者不阻塞写路径——对齐 §E「不阻塞主事务」）
export function registerAlertHook() {
  if (unsubscribe) return; // 幂等
  unsubscribe = on('particle', async (msg) => {
    const { type, summary, payload } = msg;
    // 事件形如 { domain:'particle', type:'stage_update', payload:{ particleType, action, metric } }（bus 包装 summary）
    const evt = payload || summary || {};
    const event = {
      particleType: evt.particleType,
      action: evt.action || type,
      metric: evt.metric || {},
    };
    const tenantId = await resolveTenant(evt);
    for (const { rule, payload: hitPayload } of evaluateForEvent(event, { tenantId })) {
      // severity 对齐规则/风险分档：默认 medium（§3.10 分档；后续可按规则 params 扩展）
      const a = createAlert({
        kind: rule.kind,
        severity: rule.severity || 'medium',
        target_role: rule.target_role || 'ops',
        tenant_id: tenantId,
        particle_id: evt.particle_id || null,
        payload: hitPayload || {},
      });
      if (a.ok) {
        emit('alert', 'alert_created', { alert: a.alert, kind: rule.kind, tenantId });
      }
    }
  });
}

// 退订（测试隔离）
export function unregisterAlertHook() {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
}