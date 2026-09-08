import { describe, it, expect } from 'vitest';
import { ENDPOINTS, DEFAULT_ENDPOINT, resolveEndpoint, diagnoseUnreachable } from '../src/endpoints.js';

describe('端点档位', () => {
  it('三档齐备且默认 prod', () => {
    expect(Object.keys(ENDPOINTS).sort()).toEqual(['local', 'prod', 'www']);
    expect(DEFAULT_ENDPOINT).toBe('prod');
  });

  it('prod/local 为 http，www 为 https', () => {
    expect(ENDPOINTS.prod.url).toBe('http://81.70.184.198/mcp');
    expect(ENDPOINTS.local.url).toBe('http://localhost:3001/mcp');
    expect(ENDPOINTS.www.url).toBe('https://www.chiyuai.com/mcp');
  });

  it('未知档位抛错并列出可选值', () => {
    expect(() => resolveEndpoint('staging')).toThrow(/未知端点档位: staging/);
    expect(() => resolveEndpoint('staging')).toThrow(/prod \| local \| www/);
  });

  it('www 不可达时给出 SNI/备案诊断，且不明示降级', () => {
    const msg = diagnoseUnreachable('www', new Error('connect ECONNREFUSED'));
    expect(msg).toMatch(/SNI|备案/);
    expect(msg).not.toMatch(/已切换|已降级/);
  });
});
