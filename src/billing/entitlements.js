// src/billing/entitlements.js — 套餐权益解析（dispatch 第 1.7 闸 plan_entitlement 消费）
// 设计基线：docs/2026-09-04-tenant-billing-page-design.md §6
// 解析链：tenants.plan → config_store['billing-plans'][plan_id].entitlements → Set
// 铁律：
//   - 解析异常 → fail-open 返回空集（不误杀，由闸二次判定）；但『明确缺权益』→ 闸 fail-closed 拦截
//   - system 租户（平台/内部 Agent 运行身份）恒返回全部权益集，内部操作不被计费门禁阻断
import { query } from '../db.js';
import { readConfig } from '../config/configStore.js';

export async function resolveEntitlements(tenantId) {
  try {
    if (tenantId === 'system') {
      const plansRow = await readConfig('billing-plans', { tenantId: 'system' });
      const plans = Array.isArray(plansRow?.value) ? plansRow.value : [];
      const all = new Set();
      for (const p of plans) (p.entitlements || []).forEach((e) => all.add(e));
      return all;
    }
    const t = await query(`SELECT plan FROM crm.tenants WHERE tenant_id=$1`, [tenantId]);
    const settingsRow = await readConfig('billing-settings', { tenantId: 'system' });
    const planId = t.rows[0]?.plan || settingsRow?.value?.default_plan;
    const plansRow = await readConfig('billing-plans', { tenantId: 'system' });
    const plans = Array.isArray(plansRow?.value) ? plansRow.value : [];
    // 2026-09-06：无效 planId（档位被停用/改名/脏数据）不得静默回退数组首项（可能恰是免费档 → 权益被悄悄降级），
    //   改为显式回落 billing-settings.default_plan，无则回落首项（保底不误杀）。
    const plan = plans.find((p) => p.plan_id === planId)
      || plans.find((p) => p.plan_id === settingsRow?.value?.default_plan)
      || plans[0];
    return new Set(plan?.entitlements || []);
  } catch {
    return new Set(); // fail-open：解析失败默认放行（权益缺失由闸显式拦截，此处仅容错）
  }
}
