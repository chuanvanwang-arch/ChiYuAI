// src/endpoints.js — 三档端点单一事实源
// ⚠ prod 必须 http：nginx /mcp 为 http 直连，改 https 会因证书不匹配丢失 Authorization 头。
export const ENDPOINTS = Object.freeze({
  prod:  { id: 'prod',  url: 'http://81.70.184.198/mcp',    note: '生产（IP 直连免备案；必须 http）', reachable: true },
  local: { id: 'local', url: 'http://localhost:3001/mcp',   note: '本机联调',                          reachable: true },
  www:   { id: 'www',   url: 'https://www.chiyuai.com/mcp', note: '备案解除后的目标形态；当前 SNI 级拦截', reachable: false },
});

export const DEFAULT_ENDPOINT = 'prod';

export function resolveEndpoint(id = DEFAULT_ENDPOINT) {
  const ep = ENDPOINTS[id];
  if (!ep) throw new Error(`未知端点档位: ${id}（可选: ${Object.keys(ENDPOINTS).join(' | ')}）`);
  return ep;
}

// 失败诊断：必须明确原因，禁止静默重试或降级到其他档位（降级会让用户误判通道已通）
export function diagnoseUnreachable(id, err) {
  const ep = ENDPOINTS[id] || { url: '(未知档位)' };
  const reason = err?.message || String(err);
  if (id === 'www') {
    return `端点 ${id} (${ep.url}) 不可达：疑似 SNI 级拦截 / 未 ICP 备案（原始错误: ${reason}）。` +
           `该档位在备案解除前不可用；请改用 crm-cli use prod 或 crm-cli use local。本次未做任何自动切换。`;
  }
  return `端点 ${id} (${ep.url}) 不可达：${reason}。请确认服务已启动、URL 与 Basic Auth 配置正确。`;
}
