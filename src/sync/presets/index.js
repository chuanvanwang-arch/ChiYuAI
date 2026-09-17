// src/sync/presets/index.js — 同步预设加载器（纯配置入口，零产品代码）
// 三家 CRM（Salesforce / 销售易 / 纷享逍客）均以「预设」形式存在；运行时按名字加载，
// 合并租户凭据 / 对象清单后喂给唯一的 generic-rest 通用适配器。工厂本身不出现任何产品名。
import salesforce from './salesforce.js';
import neocrm from './neocrm.js';
import fxiaoke from './fxiaoke.js';
import { createGenericRestSyncProvider } from '../factory.js';
// —— 需求② 通道预设（2026-09-17）——
import { CHANNEL_EMAIL_PRESET } from './channel-email.js';
import { CHANNEL_CALENDAR_PRESET } from './channel-calendar.js';
import { CHANNEL_MEETING_PRESET } from './channel-meeting.js';
import { CHANNEL_WECHAT_PRESET } from './channel-wechat.js';
import { buildChannelFactories } from '../../channels/channelProvider.js';

const PRESETS = { salesforce, neocrm, fxiaoke };

export function listPresets() {
  return Object.keys(PRESETS);
}

export function getPresetConfig(name) {
  const p = PRESETS[name];
  if (!p) throw new Error(`unknown_preset: ${name}`);
  return p;
}

// 按预设名产出通用 provider：合并租户级凭据 / 对象清单 / 注入的 fetch（测试用 __fetch）
export function createProviderFromPreset(name, { credentials, objects, fetchFn } = {}) {
  const base = JSON.parse(JSON.stringify(getPresetConfig(name))); // 深拷贝，避免污染预设模板
  if (credentials) base.credentials = credentials;
  if (objects) base.objects = objects;
  if (fetchFn) base.__fetch = fetchFn;
  return createGenericRestSyncProvider(base);
}

// —— 生产装配：descriptor.kind = 预设名 → 通用 provider（把预设接入工厂字典，杜绝「零接线」）——
// kind 用产品名**仅是「预设选择器」（数据）**，实现仍是唯一 generic-rest，符合 R3（无产品专属代码）。
// 描述符若声明 objects[]，则仅取其中出现的对象（保留预设的 soql/request/since_field）；未声明则用预设全量对象。
export function buildPresetProvider(presetName, descriptor = {}) {
  const preset = getPresetConfig(presetName);
  const declared = Array.isArray(descriptor.objects) ? descriptor.objects : [];
  let objects = preset.objects;
  if (declared.length) {
    const names = new Set(declared.map((o) => o && o.name).filter(Boolean));
    const filtered = preset.objects.filter((o) => names.has(o.name));
    if (filtered.length) objects = filtered;
  }
  const cfg = JSON.parse(JSON.stringify(preset));
  cfg.objects = JSON.parse(JSON.stringify(objects));
  if (descriptor.credentials) cfg.credentials = descriptor.credentials;
  if (descriptor.__fetch) cfg.__fetch = descriptor.__fetch;
  return createGenericRestSyncProvider(cfg);
}

// 预设工厂字典：与 base 工厂合并后传入 mount.loadTenantSyncTargets（生产装配点 timers.js ⑩）
// ⚠ neocrm 覆盖 base 的同名别名：预设版带完整 token-flow 鉴权（比裸 generic 别名更正确）。
// 通道键（generic-email/calendar/meeting/wechat）由 channelProvider 装配（fetchIncremental →
//   事件行归一化 → 图谱汇入复用同步内核）；与 base 工厂的 `generic-*` 键**刻意同名覆盖**，确保
//   mount 消费到的是归一化版 provider（通道真接入时归一化才生效）。
// 红线：通道「未接通不得宣称」——预设只是模板，真实连通依赖租户凭据（P4）。
export const PRESET_FACTORIES = {
  salesforce: (d = {}) => buildPresetProvider('salesforce', d),
  neocrm: (d = {}) => buildPresetProvider('neocrm', d),
  fxiaoke: (d = {}) => buildPresetProvider('fxiaoke', d),
  // —— 需求② 通道预设（2026-09-17）——
  ...buildChannelFactories([CHANNEL_EMAIL_PRESET, CHANNEL_CALENDAR_PRESET, CHANNEL_MEETING_PRESET, CHANNEL_WECHAT_PRESET]),
};

// 合并 base 工厂 + 预设工厂（生产装配唯一入口）
export function syncFactoriesWithPresets(base = {}) {
  return { ...base, ...PRESET_FACTORIES };
}
