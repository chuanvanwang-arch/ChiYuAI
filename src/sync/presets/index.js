// src/sync/presets/index.js — 同步预设加载器（纯配置入口，零产品代码）
// 三家 CRM（Salesforce / 销售易 / 纷享逍客）均以「预设」形式存在；运行时按名字加载，
// 合并租户凭据 / 对象清单后喂给唯一的 generic-rest 通用适配器。工厂本身不出现任何产品名。
import salesforce from './salesforce.js';
import neocrm from './neocrm.js';
import fxiaoke from './fxiaoke.js';
import { createGenericRestSyncProvider } from '../factory.js';

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
export const PRESET_FACTORIES = {
  salesforce: (d = {}) => buildPresetProvider('salesforce', d),
  neocrm: (d = {}) => buildPresetProvider('neocrm', d),
  fxiaoke: (d = {}) => buildPresetProvider('fxiaoke', d),
};

// 合并 base 工厂 + 预设工厂（生产装配唯一入口）
export function syncFactoriesWithPresets(base = {}) {
  return { ...base, ...PRESET_FACTORIES };
}
