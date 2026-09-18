// src/sync/trust.js — 同步信任分级（config_store['sync-trust']）
// 设计输入：docs/2026-09-15-final-design-coexistence-and-proactive.md §9.2 + §T05
// 三档：L1 只读（无写）/ L2 批量入库（每批 1 决策）/ L3 回写（首 N 批人工确认）
// 铁律：无自动提升路径（elevate 不存在）；级别变更走 review-gate 人工闸（T10）

// 单一事实源（P3 §收敛）：某信任档是否允许回写。此前 engine.js:18 与 mount.js:170 各自内联
// `level === 'L3'`，与本文档重实现（零消费点同族缺陷）。统一收口到此处，任何「L3 才回写」的
// 判定改一处即可，不再分散漂移。非法档位一律 false（fail-closed）。
export function allowWritebackForLevel(level) {
  return level === 'L3';
}

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
  return {
    level, canUpsert, canWriteBack,
    allowWritebackForLevel: (lvl) => allowWritebackForLevel(lvl), // 委托纯函数，确保与 engine/mount 同源
    decisionGranularity, firstNBatchesHuman,
  };
}
