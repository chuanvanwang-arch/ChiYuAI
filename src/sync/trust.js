// src/sync/trust.js — 同步信任分级（config_store['sync-trust']）
// 设计输入：docs/2026-09-15-final-design-coexistence-and-proactive.md §9.2 + §T05
// 三档：L1 只读（无写）/ L2 批量入库（每批 1 决策）/ L3 回写（首 N 批人工确认）
// 铁律：无自动提升路径（elevate 不存在）；级别变更走 review-gate 人工闸（T10）
export function createTrustManager({ readConfig } = {}) {
  const DEFAULTS = {
    default_level: 'L1',
    levels: {
      L1: { allow_read: true, allow_upsert: false, allow_writeback: false },
      L2: { allow_read: true, allow_upsert: true, allow_writeback: false, decision_granularity: 'per_run' },
      L3: { allow_read: true, allow_upsert: true, allow_writeback: true, decision_granularity: 'per_run', first_n_batches_require_human: 3 },
    },
  };

  async function cfg(tenantId) {
    const r = await readConfig('sync-trust', { tenantId }).catch(() => null);
    return r?.value || DEFAULTS;
  }

  async function level(tenantId) {
    const c = await cfg(tenantId);
    return c.default_level || DEFAULTS.default_level;
  }

  async function levelCfg(tenantId) {
    const c = await cfg(tenantId);
    const l = c.default_level || DEFAULTS.default_level;
    return { ...(DEFAULTS.levels[l] || DEFAULTS.levels.L1), ...(c.levels?.[l] || {}) };
  }

  async function canUpsert(tenantId) {
    const l = await levelCfg(tenantId);
    return !!l.allow_upsert;
  }
  async function canWriteBack(tenantId) {
    const l = await levelCfg(tenantId);
    return !!l.allow_writeback;
  }
  async function decisionGranularity(tenantId) {
    const l = await levelCfg(tenantId);
    return l.decision_granularity || 'per_run';
  }
  async function firstNBatchesHuman(tenantId) {
    const l = await levelCfg(tenantId);
    return l.first_n_batches_require_human ?? 0;
  }
  // 铁律：无 elevate() 方法（信任级别不可自动提升，走 review-gate）
  return { level, canUpsert, canWriteBack, decisionGranularity, firstNBatchesHuman };
}
