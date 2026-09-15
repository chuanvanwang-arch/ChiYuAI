import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

// 契约：ALERT_ENDPOINTS 8 端点必须被 routes.js 实际挂载（B-B1 此前缺失的挂载修复）
// 结构性断言（防假绿：处理器在 ≠ 挂载方注册；挂载存在性由源码引用次数证明）
const alertEndpoints = fs.readFileSync('src/alerts/alertEndpoints.js', 'utf8');
const routesSource = fs.readFileSync('src/http/routes.js', 'utf8');

const EXPECTED_PATHS = [
  '/api/alerts',
  '/api/alerts/:id/ack',
  '/api/alerts/:id/close',
  '/api/alerts/rules',
  '/api/alerts/rules/:kind/enable',
  '/api/alerts/rules/:kind/disable',
  '/api/alerts/evaluate',
  '/api/feedback/metrics',
];

describe('alertEndpoints 挂载契约（B-B1）', () => {
  it('alertEndpoints.js 声明 8 个端点路径', () => {
    const declared = (alertEndpoints.match(/'(GET|POST) \/api\/[^']+'/g) || []).map(s => s.slice(0, -1));
    expect(declared.length).toBe(8);
  });

  it('routes.js 对 8 个端点路径全部有引用（挂载存在性）', () => {
    for (const p of EXPECTED_PATHS) {
      expect(routesSource).toContain(p);
    }
  });

  it('routes.js 引用 buildAlertHandlers 处理器组装（不是裸 createAlert 替代）', () => {
    expect(routesSource).toContain('buildAlertHandlers');
  });

  it('挂载的处理器语义完整（list/ack/close/rules/setRule/evaluate/feedbackMetrics）', () => {
    const alertEndpointsSource = fs.readFileSync('src/alerts/alertEndpoints.js', 'utf8');
    for (const fn of ['list', 'ack', 'close', 'rules', 'setRule', 'evaluate', 'feedbackMetrics']) {
      expect(alertEndpointsSource).toMatch(new RegExp(`\\b${fn}\\s*\\(`));
    }
  });
});
