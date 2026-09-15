// src/connectors/discovery/builtinAdapters.js
// 唯一职责：让 4 个出厂 system 档适配器在启动时完成注册。
// 为什么必须有本模块：适配器用 registerProvider 自注册（providerRegistry.js:8），而注册表**刻意不 import
//   任何 adapter**（Task 2 契约：避免 注册表 → 适配器 → 注册表 的静态环）。Task 2/3 只交付了「自注册能力」，
//   却没有交付「谁来触发注册」——若不显式调用，REGISTRY 运行时恒空，resolveAdapters 因 registry.has(id)
//   恒假而返回 []，富集静默零产出（最隐蔽的死接线：无报错、无日志、测试仍绿）。
// 实现要点：**函数内显式 registerProvider**，而非只依赖 import 副作用 —— 因为测试会用 _resetRegistry()
//   清空注册表，此时模块缓存命中、副作用不会重跑，只靠副作用会让「重新注册」静默失效。
//   Map.set 幂等，重复调用安全。
import { emailVerify } from './adapters/emailVerify.js';
import { webResearch } from './adapters/webResearch.js';
import { tenderAdapter } from './adapters/tender.js';
import { gaodeAdapter } from './adapters/gaode.js';
import { qixinAdapter } from './adapters/qixin.js';     // 外部数据接入：启信慧眼（付费源，出厂 enabled:false）
import { xinbangAdapter } from './adapters/xinbang.js'; // 外部数据接入：新榜（付费源，出厂 enabled:false）
import { anysiteAdapter } from './adapters/anysite.js'; // 外部数据接入：anysite.io 企业/个人画像（付费源，出厂 enabled:false）
import { registerProvider, listProviderIds } from './providerRegistry.js';

// 出厂 system 档（与 config/discoveryRules.js:19-22 的 providers[].id 同源，禁新增字面量）
const BUILTIN_ADAPTERS = Object.freeze({
  'email-verify': emailVerify,
  'web-research': webResearch,
  tender: tenderAdapter,
  gaode: gaodeAdapter,
  qixin: qixinAdapter,       // 新增（与 discoveryRules.providers[].id 同源）
  anysite: anysiteAdapter,   // 新增（与 discoveryRules.providers[].id 同源）
  xinbang: xinbangAdapter,   // 新增
});

export function registerBuiltinAdapters() {
  for (const [id, factory] of Object.entries(BUILTIN_ADAPTERS)) registerProvider(id, factory);
  return listProviderIds();
}

export { BUILTIN_ADAPTERS };
