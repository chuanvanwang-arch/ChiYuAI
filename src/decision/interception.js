// src/decision/interception.js — T3 拦截纯函数（设计：decideInterception(check)）
// 单一事实源：createDecision 写入前调用 sevenDimensionsCheck，本函数消费其结果做「拦截判定」。
// 语义（设计 §T3 / 实现计划）：allowed=false（存在 on_missing='block' 的必填维缺失）→ 拦截拒写；
//        allowed=true → 透传（warn 缺失仅标红，不阻断）。
// 纯函数：无 DB/IO 依赖，可单测。
//
// check 契约（来自 src/sevenDimensions/engine.js#sevenDimensionsCheck）：
//   { required:[{dim,on_missing}], missing:[{dim,on_missing}], level:'ok'|'warn'|'block', allowed:boolean }

// 把 missing 项规整为字符串数组（兼容 {dim} 或纯字符串两种形态）
function extractDims(missing) {
  if (!Array.isArray(missing)) return [];
  return missing.map((m) => (typeof m === 'string' ? m : m?.dim)).filter(Boolean);
}

/**
 * @param {object|null|undefined} check sevenDimensionsCheck 结果
 * @returns {{blocked:boolean, missing:string[], level:string}}
 */
export function decideInterception(check) {
  const missing = extractDims(check && check.missing);
  // check 缺失或 allowed 非 false → 不拦截（默认放行，避免误伤既有写流程）
  const blocked = !!check && check.allowed === false;
  return {
    blocked,
    missing,
    level: blocked ? (check?.level || 'block') : 'ok',
  };
}

// 生成 missing_context 错误消息（与 decisionRepo 历史消息格式一致，便于前端识别）
export function missingContextMessage(intercept) {
  const dims = (intercept?.missing || []).join(',');
  return `missing_context: 维度缺失 ${dims}`;
}
