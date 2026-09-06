// src/memory/judge.js — 写入门槛闸门（纯函数，无 DB）
const CREDENTIAL_RE = /(api[_-]?key|token|password|secret|私钥|凭证)/i;

// 瞬态噪声判据 = 【形态】而非【裸词】。
//
// 历史缺陷（2026-09-03 修复）：原实现为单个裸词正则
//   /(grep|rg|find|ls|cat|echo|tmp|node_modules|\.cache|Error|Exception|traceback|timeout|搜索词)/i
// 三个叠加问题：① 无词边界；② /i 大小写不敏感；③ 对 JSON.stringify(payload) **整体**匹配（含键名）。
// 实测后果（tmp/_probe_noise_re.mjs）：
//   - 生产 memory_log 抽样 300 条 → 误判 25 条（8.3%），命中词 100% 是 `error` 键名，
//     而这些记录的 `"error": null`（边写降级留痕，本身没有错误）——**诚实带 error 字段的记忆反被拒**，
//     形成"不记录错误信息才能入库"的反向激励；
//   - 正常业务键/值系统性误伤：category·location·application（含 cat）、target·margin·large（含 rg）、
//     false·results·tools（含 ls）、template·attempt（含 tmp），业务语料误伤 4/7。
//
// 现按四类噪声**形态**判定，每类都要求上下文特征，单词出现不构成噪声：
const NOISE_PATTERNS = [
  // ① 工具命令痕迹：命令后必须跟参数形态（-x / 绝对路径 / ~/ ./），单独出现的 cat/find/ls 等词不算
  /(?:^|[\s"'`;(])(?:grep|rg|find|ls|cat|echo|tail|head|sed|awk)\s+(?:-[a-zA-Z]|\/|~|\.\/)/,
  // ② 临时 / 构建产物路径（要求路径分隔符形态，避免 tmp 出现在 template/attempt 里被误伤）
  /(?:^|[\s"'`;])\/tmp\//,
  /\bnode_modules\//,
  /[/\\]\.cache[/\\]/,
  // ③ 堆栈 / 运行时报错**文本形态**：键名 error 本身不算，必须是报错语句或标准错误类型
  /Traceback \(most recent call last\)/i,
  //    兼容两种 Node 形态：`at Object.<anonymous> (/app/src/db.js:42:11)` 与 `at /app/db.js:42:11`；
  //    要求文件扩展名 + 行:列，避免命中「at 12:30:45」这类正常时间文本。
  /at\s+(?:[^\s()]+\s*)?\(?[\w$./\\-]+\.(?:js|mjs|cjs|ts|tsx|jsx|py|java|go|rb|rs):\d+:\d+/,
  /\b(?:TypeError|ReferenceError|SyntaxError|RangeError|EvalError|URIError|AggregateError)\b/,
  /\bUnhandledPromiseRejectionWarning\b/,
  /\b(?:ETIMEDOUT|ECONNREFUSED|ECONNRESET)\b/,
  /timeout\s+of\s+\d+\s*ms/i,
  /(?:^|[\s"'`;])(?:Error|Exception)\s*:/,
  // ④ 业务语义噪声：搜索关键词本身无长期价值
  /搜索词/,
];

// 单一正则视图（审计/调试用；判定统一走 isTransientNoise 逐条匹配，便于定位命中类别）
export const NOISE_RE = new RegExp(NOISE_PATTERNS.map((r) => `(?:${r.source})`).join('|'));

/** 判定序列化文本是否为瞬态噪声；返回命中的模式序号（1 基），非噪声返回 0。 */
export function isTransientNoise(s) {
  const text = String(s ?? '');
  for (let i = 0; i < NOISE_PATTERNS.length; i++) {
    if (NOISE_PATTERNS[i].test(text)) return i + 1;
  }
  return 0;
}

export function judgeWorthiness(payload, { explicit = false, valueHorizonDays = 30 } = {}) {
  const s = typeof payload === 'string' ? payload : JSON.stringify(payload ?? '');
  if (CREDENTIAL_RE.test(s)) return { ok: false, code: 'credential', reason: '敏感凭证硬拒（即便显式也拦）' };
  if (explicit) return { ok: true, code: 'explicit' };
  if (isTransientNoise(s)) return { ok: false, code: 'noise', reason: '瞬态噪声不入记忆' };
  if (valueHorizonDays < 30) return { ok: false, code: 'horizon', reason: '价值视界<30天且非显式' };
  return { ok: true, code: 'pass' };
}
