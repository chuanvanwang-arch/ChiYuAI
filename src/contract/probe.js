// src/contract/probe.js — success 探针运行器（v1 仅 http_get，限同源 /api/**）
export function isSameOriginApiPath(path) {
  return typeof path === 'string' && path.startsWith('/api/');
}
export function evaluateProbe(probe, { status, body }) {
  const expStatus = probe?.expect_status;
  const expContains = probe?.expect_contains;
  const issues = [];
  if (expStatus != null && status !== expStatus) issues.push(`status ${status} ≠ 期望 ${expStatus}`);
  if (expContains != null && !String(body).includes(expContains)) issues.push(`响应体不含 "${expContains}"`);
  return { ok: issues.length === 0, observed: issues.join('; ') || 'pass' };
}
export async function runProbe({ fetchImpl, baseUrl, contract }) {
  const probe = contract?.probe;
  if (!probe || probe.type !== 'http_get') throw new Error('无可用 probe（仅支持 http_get）');
  if (!isSameOriginApiPath(probe.path)) throw new Error('probe.path 限同源 /api/**');
  const res = await fetchImpl(baseUrl + probe.path);
  const body = await res.text();
  const ev = evaluateProbe(probe, { status: res.status, body });
  return { status: ev.ok ? 'pass' : 'fail', observed: ev.observed };
}
