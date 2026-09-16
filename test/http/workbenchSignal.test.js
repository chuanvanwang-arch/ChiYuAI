import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { buildSignalView } from '../../src/signal/workbenchView.js';

describe('workbench 第7视角（信号）', () => {
  it('workbenchRouter 声明 signals 视角（VIEW_ALIASES/VIEWS 含 signals）', () => {
    const src = fs.readFileSync('src/http/workbenchRouter.js', 'utf8');
    expect(src).toContain("signals: '信号'");
    expect(src).toMatch(/signals/);
  });

  it('信号视角按 open 信号聚合返回（buildSignalView 契约）', async () => {
    const view = buildSignalView({
      store: {
        list: async () => [
          { signal_id: 's1', severity: 'high', status: 'open', kind: 'deal_stuck' },
          { signal_id: 's2', severity: 'low', status: 'acked', kind: 'lead_overdue' },
        ],
      },
    });
    const r = await view.list({ tenant_id: 't1' });
    expect(r.items.length).toBe(2);
    expect(r.open_count).toBe(1);
    expect(r.high_open).toBe(1);
  });

  it('buildViewRows 支持 signals case（返回信号行结构）', () => {
    const src = fs.readFileSync('src/http/workbenchRouter.js', 'utf8');
    expect(src).toMatch(/case 'signals'/);
  });
});
