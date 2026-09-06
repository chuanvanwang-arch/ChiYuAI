// src/calc/formulaEngine.js — L2 沙箱公式引擎（P4/T12-T13）
// 设计：表达式在 node:vm 白名单沙箱中求值，禁绝 process/require 等危险全局；
// 输入缺失或表达式非法 → fail-safe 返回 null（由调用方告警，绝不抛错阻断主写）。
import vm from 'node:vm';
import { readConfig } from '../config/configStore.js';

const ALLOWED_GLOBALS = ['Math', 'Number', 'parseFloat', 'parseInt', 'isNaN', 'toFixed'];

// 沙箱求值：expr 为算术表达式（如 '(revenue - cost) * commission_rate'），inputs 为变量映射
export function evalFormula(expr, inputs = {}) {
  // 白名单全局：仅暴露数学/数值工具，process/require 等危险全局绝不进沙箱
  const sandbox = { ...inputs };
  for (const g of ALLOWED_GLOBALS) {
    if (g === 'toFixed') sandbox.toFixed = (n, d) => Number(n).toFixed(d);
    else sandbox[g] = globalThis[g];
  }
  // fail-safe：任一输入缺失/非有限数 → 返回 null（不计算、不抛错）
  for (const k of Object.keys(inputs)) {
    const v = inputs[k];
    if (v === undefined || v === null || (typeof v === 'number' && !Number.isFinite(v))) return null;
  }
  const ctx = vm.createContext(sandbox);
  try {
    const out = vm.runInContext(`( ${expr} )`, ctx, { timeout: 100 });
    return typeof out === 'number' && Number.isFinite(out) ? out : null;
  } catch {
    return null; // 非法表达式 / 危险全局缺失（ReferenceError）→ fail-safe 返回 null，绝不执行
  }
}

// 按租户 profile.calculations 触发 on_write 公式，返回应合并进 payload 的计算结果（target 末段键）
export async function runProfileCalculations(type, payload = {}, tenantId = 'system') {
  if (!tenantId || tenantId === 'system') return {};
  const profile = await readConfig('tenant-profile', { tenantId }).catch(() => null);
  const calcs = (profile?.value?.calculations || []).filter((c) => c.trigger === 'on_write' && c.target?.startsWith(`${type}.`));
  const out = {};
  for (const c of calcs) {
    const inputs = Object.fromEntries((c.inputs || []).map((i) => [i, payload[i]]));
    const val = evalFormula(c.expr, inputs);
    if (val !== null) out[c.target.split('.').pop()] = val;
  }
  return out;
}
