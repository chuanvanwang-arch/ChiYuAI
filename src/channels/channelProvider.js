// src/channels/channelProvider.js — 需求② 通道 provider 工厂（T4/T2 装配核心）
// 设计：docs/2026-09-17-channel-adapter-unified-design.md §3（4 通道归一化输出）+ §4（同步内核复用）
// 职责：fetchIncremental（复用 generic-rest 模板引擎）→ 原始行 → 事件行归一化（eventNormalizer）。
// 签名：createChannelProvider(preset) 返回工厂（receive 租户 descriptor cfg → provider 实例），
//       与 SYNC_PROVIDER_FACTORY[kind] 契约一致（verifyAuth/discoverObjects/readIncremental），
//       供 mount.loadTenantSyncTargets 装配（kind 受支持才构造，防零接线假绿）。
// 零通道专属分支：模板引擎差异由 descriptor 表达；归一化是纯函数（eventNormalizer）。
import { createGenericRestSyncProvider } from '../sync/factory.js';
import { normalizeChannelRow } from './eventNormalizer.js';
// §3.0 契约：事件行 channel 是「真实通道短名」（email/calendar/meeting/wechat），非 provider kind。
// 该映射表已上收 kinds.js（通道单一事实源），本文件不再自建（防两处解释权）。
import { CHANNEL_SHORT } from './kinds.js';

export function createChannelProvider(preset = {}) {
  // 返回工厂（mount 消费）：receive 租户 descriptor cfg → provider 实例
  return function makeProvider(cfg = {}) {
    // cfg 是租户 descriptor（含 endpoint/auth/objects/credentials）；preset 提供模板默认值
    // 以租户 cfg 覆盖 preset（租户可覆盖 endpoint/objects/auth/response 形状），kind 取 descriptor
    const kind = cfg.kind || preset.kind || 'generic-email';
    const base = createGenericRestSyncProvider({
      ...preset,
      ...cfg,
      kind, // T1：kind 注入，实例保留真实通道 kind（cursor 分表防串）
    });
    return {
      kind,
      verifyAuth: base.verifyAuth,
      discoverObjects: base.discoverObjects,
      async readIncremental({ object, cursor = null } = {}) {
        const r = await base.readIncremental({ object, cursor });
        if (!r.ok) return r; // fail-closed：上游错误原样返回（含 credentials_missing / http_*）
        const rows = (r.rows || []).map((raw) => normalizeChannelRow({
          ...raw,
          // §3.0 契约：channel 取「真实通道语义」email/calendar/meeting/wechat（短名），
          // 不取 provider kind（generic-*）。raw 自带通道名则保留；缺省按 kind 映射回短名。
          channel: raw.channel || CHANNEL_SHORT[kind] || 'email',
        }));
        return { ok: true, rows, cursor: r.cursor };
      },
    };
  };
}

// 构建挂载字典：presets 列表 → { kind: factory }（供 presets/index.js 并入 PRESET_FACTORIES）
export function buildChannelFactories(presets = []) {
  const out = {};
  for (const p of presets) {
    const kind = p.kind;
    if (!kind) continue;
    out[kind] = createChannelProvider(p);
  }
  return out;
}
