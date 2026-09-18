// src/sync/writeback.js — L3 回写派发器（同步内核 callWriteback 的唯一生产实现）
// 设计输入：docs/2026-09-15-final-design-coexistence-and-proactive.md §T04 + §6.1 A-B4 + §15.2
// 职责：把「判定字段」经既有 sync-writeback-fields Action 回写（白名单 + 字段级 CAS + Source 静态标记）。
//
// 为什么复用既有 Action 而不新造写通道：
//   ① T04 已定义该 Action（connectors/connectorActions.js:158）承载「白名单 + CAS + Source='crm-ai-native'」三项成功标准；
//   ② 它经写通道第 0 闸（autoDecision）+ 第 3 闸（needsApproval）→ 回写天然受 HITL 约束；
//   ③ 再造一条写路径即违反「单一写通道」红线（与 A-B3「两个同名工厂」事故同族）。
//
// 红线（不可越）：
//   ① 白名单空 → 拒绝一切回写（fail-closed，绝不「未声明即放行」）；
//   ② 自动同步路径**默认不传** approvalPassed → 回写被 executor 第 3 闸拦（approval_required），
//      engine 计入 conflicted 可观测。仅当运营在配置中心显式置 writeback_auto_approved=true
//      （人工 HITL 决定）才放行——代码内不存在自动提权路径；
//   ③ 范围（Q1=B 单向白名单回写，2026-09-18 裁决钉死）：回写客户侧 CRM 仅当**同时满足**——
//        (a) descriptor.outbound 显式声明（enabled + 字段集合）——缺声明即未开放（fail-closed）；
//        (b) 通过 enable-writeback 评审闸的人工放行（P3 已接线：mount.js gatedCallWriteback 包裹 + reviewGate 按 writeback 查）；
//        (c) exportGate 出口健康（三判据全真）。
//      且目标默认为 internal（我方客户粒子）；target='crm' 必须经 §6.1 三前置 + 运营在配置中心显式开启。
//      当前 P6 未交付 → 实际落点恒为 internal（mount 默认 target），客户侧回写默认关闭，绝不假绿。
export function createWritebackDispatcher({ dispatch, readConfig } = {}) {
  return async function callWriteback({
    tenantId = 'system', object, externalId, particleId, row = {}, level, decisionId = null,
  } = {}) {
    if (typeof dispatch !== 'function') return { ok: false, error: 'dispatch_missing' };
    if (!particleId) return { ok: false, error: 'particle_id_missing' };

    const trust = await (readConfig
      ? readConfig('sync-trust', { tenantId }).catch(() => null)
      : Promise.resolve(null));
    const cfg = trust?.value || {};
    const whitelist = Array.isArray(cfg.writeback_fields_whitelist) ? cfg.writeback_fields_whitelist : [];
    if (!whitelist.length) return { ok: false, error: 'writeback_whitelist_empty' };

    // 只取 row 中命中白名单且值存在的字段（非白名单字段在此剔除；Action 内会再过滤一次，双保险）
    const fields = {};
    for (const k of whitelist) {
      const v = row?.[k];
      if (v !== undefined && v !== null) fields[k] = v;
    }
    if (!Object.keys(fields).length) return { ok: false, error: 'writeback_no_fields' };

    const casExpect = row?.__cas_expect && typeof row.__cas_expect === 'object' ? row.__cas_expect : undefined;
    const params = { account_id: particleId, fields };
    if (casExpect) params.cas_expect = casExpect;

    const ctx = { actor: 'sync-engine', tenantId, decision_id: decisionId };
    // HITL 第 3 闸：默认不放行（approvalPassed 缺失 → executor 返 approval_required）
    if (cfg.writeback_auto_approved === true) ctx.approvalPassed = true;

    const r = await dispatch('sync-writeback-fields', params, ctx)
      .catch((e) => ({ ok: false, error: String(e?.message || e) }));
    if (!r?.ok) return { ok: false, error: r?.error || 'writeback_rejected', denied: r?.denied || [] };
    return { ok: true, written: r?.written || Object.keys(fields), denied: r?.denied || [], object, externalId, level };
  };
}
