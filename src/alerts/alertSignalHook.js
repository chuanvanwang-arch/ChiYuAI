// src/alerts/alertSignalHook.js — 告警 → 信号 持久化接线（B-B2/B-B3，2026-09-16 主动运行时 S1）
// 设计输入：docs/2026-09-15-final-design-coexistence-and-proactive.md §8.3（信号统一收口）
//
// 定位：本模块是「告警进入 crm.signal」的**唯一接线点**。
//   实现方式不是"订阅 bus 'alert' 域"（实测不可靠：timers 到访逾期只发 alert_id 无 alert 对象、
//   alertEndpoints.create 根本不发事件），而是把落库 sink 挂到 createAlert 这个**唯一收口**上
//   （见 alertStore.setAlertPersister）——一处注册覆盖全部告警产生点与将来新增点。
//
// 契约：
//   - signal_id 沿用 alert_id（溯源性：信号可反查原始告警；与 router.signalFromAlert 同契约）
//   - 失败绝不抛出到 createAlert 调用方（persister 内抛错由 alertStore 捕获记 trace）
import { setAlertPersister } from './alertStore.js';
import { createSignalStore } from '../signal/store.js';
import { createSignalRouter } from '../signal/router.js';

// 注册落库 sink。pool 必传（或显式注入 store 便于测试）。
export function registerAlertSignalPersister({ pool = null, store = null, router = null } = {}) {
  if (!pool && !store) throw new Error('registerAlertSignalPersister: pool or store required');
  const signalStore = store || createSignalStore(pool);
  const signalRouter = router || createSignalRouter({});
  setAlertPersister(async (alert) => {
    const s = signalRouter.signalFromAlert(alert);
    return signalStore.create({
      signal_id: s.signal_id,          // = alert_id（溯源性）
      tenant_id: s.tenant_id,
      source: s.source,                // rule-scan
      kind: s.kind,
      severity: s.severity,
      target_role: s.target_role,
      owner_id: s.owner_id,
      l2c_stage: s.l2c_stage,
      particle_id: s.particle_id,
      payload: s.payload,
      evidence: s.evidence,
      suggestion: s.suggestion,
      dedup_key: s.dedup_key,
    });
  });
  return signalStore;
}

// 解除注册（测试隔离；生产不调用）
export function unregisterAlertSignalPersister() {
  setAlertPersister(null);
}
