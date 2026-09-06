// src/page/guardrails.js — 输入层护栏（NL→Schema 前拦截注入，三层护栏①）
// 设计输入：ai-portal-page-generation 三层护栏；拦截 <script>/javascript:/on*/eval( 等注入尝试
// 输出 {safe, reason}：safe=false 时调用方必须拒绝继续（不解析/不落库/不渲染）

const INJECTION_PATTERNS = [
  /<\s*script/i,            // <script>
  /javascript\s*:/i,        // javascript:
  /on\w+\s*=/i,             // onerror=/onclick=/onload= 等
  /eval\s*\(/i,             // eval(
  /<\s*iframe/i,            // <iframe>
  /<\s*img\s+on/i,          // <img onerror= 等
  /<\s*svg\s+on/i,          // <svg onload= 等
];

export function guardNlInput(nl) {
  const text = String(nl || '').trim();
  if (!text) return { safe: false, reason: '空输入' };
  for (const re of INJECTION_PATTERNS) {
    if (re.test(text)) return { safe: false, reason: `拦截注入模式: ${re.source}` };
  }
  return { safe: true, reason: 'ok' };
}