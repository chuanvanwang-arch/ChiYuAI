// src/decision/contextGuard.js — 决策写时上下文守卫（T-D5，配置化）
// 背景：真实库曾出现 trigger_context 全空的调试决策，致三图闭包仅 40% 闭合（D2/D3/D4 断链）。
// 设计要点（2026-08-30 实测修正）：
//   ① 首版实现为「硬编码阻断」——实测打挂 24 个既有测试（大量调用方以空 trigger_context 造决策）；
//      故改为**配置化**：模式走 config_store，业务方可按需收紧，非代码硬编码（阈值配置化铁律）。
//   ② mode: 'warn'（默认，仅 trace 留痕不阻断）/ 'block'（拒写，抛 missing_context）。
//   ③ 关键字段：trigger_context（非空对象）/ conditions_evaluated（非空数组）。
//   ④ readConfig 可注入以便单测；生产走 query（config_store.key='decision-context-guard'）。
import { emit } from '../events/bus.js';
import { readConfig } from '../config/configStore.js';
import { missingContextMessage } from './interception.js';

export const GUARD_CONFIG_KEY = 'decision-context-guard';
export const DEFAULT_MODE = 'warn';

// 平台级护栏配置（tenantId='system'）；readConfig 可注入以便单测
const defaultReadConfig = async (key) => {
  const r = await readConfig(key, { tenantId: 'system' });
  return r?.value ?? null;
};

// 判定缺失的关键上下文字段（纯函数，可单测）
export function missingContextFields({ trigger_context, conditions_evaluated } = {}) {
  const missing = [];
  const isPlainObj = trigger_context && !Array.isArray(trigger_context) && typeof trigger_context === 'object';
  if (!isPlainObj || Object.keys(trigger_context).length === 0) missing.push('trigger_context');
  if (!Array.isArray(conditions_evaluated) || conditions_evaluated.length === 0) missing.push('conditions_evaluated');
  return missing;
}

// 读模式（配置化；非法值回退默认，防配置脏数据致全线阻断）
export async function readGuardMode(readConfig) {
  const fn = readConfig || defaultReadConfig;
  try {
    const cfg = await fn(GUARD_CONFIG_KEY);
    const mode = typeof cfg === 'string' ? cfg : cfg?.mode;
    return mode === 'block' || mode === 'warn' ? mode : DEFAULT_MODE;
  } catch {
    return DEFAULT_MODE; // 配置读取失败 → 保守回退 warn（不阻断主链路）
  }
}

// 执行守卫：block 模式抛错（拒写）；warn 模式仅留痕
export async function checkContextGuard(input = {}, readConfig) {
  const missing = missingContextFields(input);
  if (missing.length === 0) return { ok: true, missing: [] };

  const mode = await readGuardMode(readConfig);
  if (mode === 'block') {
    throw new Error(missingContextMessage({ blocked: true, missing }));
  }
  emit('trace', 'decision-context-incomplete', {
    scenario_id: input.scenario_id || null, missing,
    note: '上下文不完整（warn 模式不阻断；置 config_store.decision-context-guard.mode=block 可收紧为拒写）',
  });
  return { ok: true, missing, warned: true };
}
