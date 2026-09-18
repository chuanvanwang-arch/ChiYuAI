// src/sync/engine.js — 同步内核（runOnce）
// 设计输入：docs/2026-09-15-final-design-coexistence-and-proactive.md §T01 + §T04（L3 回写分支）
//          + docs/2026-09-18-unified-integration-design-v2.md §8.1（P1 隐私排除清单，双线共用）
// 职责：read（provider）→ map（mapping）→ upsert（resolver 幂等）→ 计数（created/updated/skipped）
//       L3 额外：writeback（callWriteback 注入的回写函数 → 白名单字段 → 字段级 CAS）
//       P1 额外：privacy（注入的隐私过滤器 → 落库**之前**排除）
// 幂等前提：resolver.upsert 按 external_id 对齐，二次同步不新建粒子
import { signalsFromSyncRow } from '../channels/privacyFilter.js';

export function createSyncEngine({ provider, mapping, resolver, cursor, trust = { level: () => 'L1' }, callWriteback, privacy = null, pendingWrite = null } = {}) {
  async function runOnce({ object, tenantId = 'system', decisionId = null } = {}) {
    if (!provider) return { ok: false, error: 'provider_missing' };
    const auth = await provider.verifyAuth().catch(() => ({ ok: false }));
    if (!auth?.ok) return { ok: false, error: `verifyAuth_failed: ${auth?.error || 'unknown'}` };
    // 信任分级闸：L1 只读 → 不 upsert（仅 read 计数）；L2 批量入库；L3 = L2 + 回写
    const level = await trust.level(tenantId);
    const allowWrite = level === 'L2' || level === 'L3';
    const allowWriteback = level === 'L3';
    const cur = await cursor.get({ tenantId, provider: provider.kind || 'mock', object }).catch(() => null);
    // ⚠ 必须传 object：描述符按对象声明（§9.3 objects[]），provider 需据此定位查询目标
    // ⚠ 去假健康（2026-09-16 P0-2）：provider 失败必须留痕并短路返回。
    //   旧实现 `.catch(() => ({ rows: [], cursor: null }))` 吞掉异常 + 不检查 `ok:false`
    //   → counts.read=0 且 last_status='ok' →「同步在跑」与「一条都没读到」不可区分（F2）。
    let inc;
    try {
      inc = await provider.readIncremental({ object, cursor: cur?.cursor_value || null });
    } catch (e) {
      inc = { ok: false, error: String(e?.message || e) };
    }
    if (inc?.ok === false) {
      const errMsg = String(inc.error || 'read_failed');
      const zeroCounts = { read: 0, created: 0, updated: 0, skipped: 0, conflicted: 0, writeback: 0, privacy_dropped: 0 };
      // 只读路径同样落 failed：L1 也不是「可以静默失败」的理由
      await cursor.set({
        tenantId, provider: provider.kind || 'mock', object,
        counts: zeroCounts, status: 'failed', error: errMsg,
        cursor: cur?.cursor_value || null, decisionId,
      }).catch(() => {});
      return { ok: false, error: errMsg, ...zeroCounts };
    }
    const read = (inc.rows || []).length;
    const counts = { read, created: 0, updated: 0, skipped: 0, conflicted: 0, writeback: 0, writeback_blocked: 0, privacy_dropped: 0, echo: 0, pending_write: 0 };
    if (!allowWrite) {
      await cursor.set({ tenantId, provider: provider.kind || 'mock', object, counts, status: 'ok', error: null, decisionId });
      return { ok: true, ...counts, readOnly: true };
    }
    // P1 隐私排除（§8.1）：判定放在 read → map → upsert **之前**，使被排除的行根本不进入落库链路
    //   （不是「落库后再隐藏」——后者在审计时可用 SQL 直接取回，不构成任何隐私承诺）。
    //   只在写路径生效：L1 不落库，无隐私风险，也不因此改变 L1 的既有计数语义（零回归）。
    //   isEmpty 短路：未配置规则时不产生任何逐行开销与行为差异。
    const pf = privacy && typeof privacy.evaluate === 'function' ? privacy : null;
    const byReason = {};
    for (const row of inc.rows || []) {
      if (pf && !pf.isEmpty) {
        const d = pf.evaluate(signalsFromSyncRow(row));
        if (d.drop) {
          counts.privacy_dropped++;
          byReason[d.reason] = (byReason[d.reason] || 0) + 1;
          continue; // 丢弃但**必计数**（丢弃计数可见；「被规则拦下」与「读不到数据」必须可区分）
        }
      }
      const m = mapping.apply(object, row);
      if (!m.ok) { counts.skipped++; continue; } // 映射失败（未知对象/字段）计入 skipped
      // 外部 id 优先取映射声明的 identity.external_id_field（§9.1；如纷享 _id），回退通用名（零回归）
      const extId = m.external_id || row.id || row.external_id;
      if (!extId) { counts.skipped++; continue; }
      const u = await resolver.upsert({
        tenantId, provider: provider.kind || 'mock', object,
        externalId: extId, particleType: m.particle_type, payload: m.payload,
      });
      if (u.echo) counts.echo++; // P0-3 回声：我方写出的被读回，不计 created/updated（防回环）
      else if (u.created) counts.created++;
      else if (u.updated) counts.updated++;
      else counts.skipped++;
      // L3 回写：把判定字段（白名单内的 AI 结论）写回客户侧（callWriteback 注入，带字段级 CAS）
      if (allowWriteback && typeof callWriteback === 'function') {
        const w = await callWriteback({
          tenantId, provider: provider.kind || 'mock', object, externalId: extId, particleId: u.particle_id,
          payload: m.payload, row, level, counts,
        }).catch(() => ({ ok: false }));
        if (w?.gate_blocked) counts.writeback_blocked++; // 被 enable-writeback 评审闸拦（fail-closed，见 mount 包裹层）
        else if (w?.ok) counts.writeback++;
        else {
          counts.conflicted++; // 回写失败（CAS 拒绝/外部已改）计入 conflicted，不静默
          // P0-2（ROX 立身之本）：写失败**不丢意图**——入待写队列，由 drain 重试/对账（防丢失）
          if (pendingWrite && typeof pendingWrite.enqueue === 'function') {
            await pendingWrite.enqueue({
              tenantId, provider: provider.kind || 'mock', object, externalId: extId, particleId: u.particle_id,
              target: level === 'L3' ? 'internal' : 'internal', // v1 默认落 internal；external 由 P6 放开
              fields: row,
              args: { tenantId, provider: provider.kind || 'mock', object, externalId: extId, particleId: u.particle_id, row, level },
            }).catch(() => {});
            counts.pending_write++;
          }
        }
      }
    }
    // P1 落痕：① 按原因的丢弃分组（界面/报告可解释「为什么少了」）；② 配置形状异常时显式记账
    //   （config_ok=false 却不留痕 = 用户以为规则生效、实际一条都没生效的假绿）。
    if (pf) {
      if (Object.keys(byReason).length) counts.privacy_dropped_by_reason = byReason;
      if (pf.config_ok === false) counts.privacy_config_ok = false;
    }
    await cursor.set({ tenantId, provider: provider.kind || 'mock', object, counts, status: 'ok', error: null, cursor: inc.cursor, decisionId });
    return { ok: true, ...counts, readOnly: false };
  }
  return { runOnce };
}
