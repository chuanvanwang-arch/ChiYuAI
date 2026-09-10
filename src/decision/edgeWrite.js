// src/decision/edgeWrite.js — BG-06：决策边写入的唯一入口（降级必留痕，fail-open 不阻断主链路）
//
// 缺陷背景：ageGraph.addEdge 在 AGE 不可用时直接 `return {ok:false, skipped:'age-unavailable'}`
//   却**不 emit、不 recordFailure**；decisionRepo 7 处调用又一律 `.catch(() => {})` 吞掉
//   → 边写失败完全静默，监控台永远显示"边齐备"（与 BG-04 seed 假绿叠加成双重假绿）。
//
// 契约：
//   1. 所有写边调用一律经 mirrorEdge，禁止再裸调 addEdge + .catch(()=>{})
//   2. 降级/失败三重留痕：内存环形缓冲（即时可查）+ emit trace（总线）+ memory_log（持久可审计）
//   3. 永不抛错（fail-open）：边是审计资产，不能因图库抖动阻断决策写主链路
import { emit } from '../events/bus.js';
import { recordFailure } from '../monitor/monitorStore.js';
import { appendMemory } from '../memory/memoryLog.js';
import { addEdge, isAvailable } from './ageGraph.js';

const RING_MAX = 100;            // 内存环形缓冲上限（防无界增长）
const ring = [];

// 端点归一：决策 uuid（字符串）或 {id,label} 粒子/异常顶点对象
function idOf(x) {
  if (x === null || x === undefined) return null;
  return typeof x === 'string' ? x : String(x.id ?? '');
}

// 留痕：三重（环形缓冲 / 事件总线 / 持久 memory_log），任一环失败不影响其余
function traceDegradation(rec) {
  ring.push(rec);
  if (ring.length > RING_MAX) ring.shift();
  try { emit('trace', 'decision-edge-mirror-degraded', rec); } catch { /* 总线不可用时仍留痕于 ring */ }
  try { recordFailure('decision-edge-mirror-degraded'); } catch { /* 计数失败不影响主链路 */ }
  try {
    // explicit=true 绕过价值闸门：降级留痕是审计证据，不因"内容不够有价值"被拒收
    // 显式 tenantId:'system'：这是平台基础设施事件的审计留痕，不归属任何业务租户的客户记忆，
    //   显式声明可避免 resolveTenantId 对"缺租户"误 emit memory-tenant-missing 噪声。
    void appendMemory({
      topic: `decision:edge-degraded`,
      kind: 'degradation',
      payload: { ...rec, text: `[边写降级] ${rec.rel_type} → ${rec.reason}` },
      layer: 'L-Workspace',
      actor: rec.actor || 'system',
      tenantId: 'system',
      eventType: 'decision-edge-mirror-degraded',
      explicit: true,
    }).catch(() => {});
  } catch { /* 持久化失败不阻断 */ }
}

// 写边（AGE 主路）。返回 {ok, degraded, reason?, error?}，永不抛错
// ctx: { decision_id, actor } 仅用于留痕定位，不参与图写
export async function mirrorEdge(relType, from, to, props = {}, ctx = {}) {
  const rec = {
    ts: new Date().toISOString(),
    rel_type: relType,
    from_id: idOf(from),
    to_id: idOf(to),
    decision_id: ctx.decision_id || null,
    actor: ctx.actor || null,
  };
  try {
    if (!isAvailable()) {
      const r = { ...rec, reason: 'age-unavailable', error: null };
      traceDegradation(r);
      return { ok: false, degraded: true, reason: 'age-unavailable' };
    }
    const res = await addEdge(relType, from, to, props, { toLabel: ctx.toLabel || null });
    if (!res || res.ok !== true) {
      const r = { ...rec, reason: res?.skipped || 'write-failed', error: res?.error || null };
      traceDegradation(r);
      return { ok: false, degraded: true, reason: r.reason, error: r.error };
    }
    return { ok: true, degraded: false };
  } catch (e) {
    const r = { ...rec, reason: 'exception', error: String(e?.message || e) };
    traceDegradation(r);
    return { ok: false, degraded: true, reason: 'exception', error: r.error };
  }
}

// 最近降级留痕（监控台/诊断脚本读；倒序，最新在前）
export function recentEdgeDegradations(limit = 20) {
  return [...ring].reverse().slice(0, Math.max(0, Number(limit) || 0));
}

// 测试隔离：清空环形缓冲
export function resetEdgeDegradations() {
  ring.length = 0;
}
