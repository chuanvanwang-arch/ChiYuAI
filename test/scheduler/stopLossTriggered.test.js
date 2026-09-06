// 回归测试：crm-risk 探测 stop_loss_triggered（只读粒子 payload，不写业务数据）
import { describe, it, expect } from 'vitest';
import { collectStopLossAlerts } from '../../src/scheduler/riskScanner.js';

describe('collectStopLossAlerts', () => {
  it('status=triggered 的 DEAL → 产出 stop_loss_triggered 告警', () => {
    const entities = [
      { id: 'd1', type: 'CRM_DEAL', payload: { stop_loss: { status: 'triggered' } } },
      { id: 'a1', type: 'CRM_ACCOUNT', payload: {} },
      { id: 'd2', type: 'CRM_DEAL', payload: { stop_loss: { status: 'armed' } } },
    ];
    expect(collectStopLossAlerts(entities)).toEqual([
      { type: 'stop_loss_triggered', deal_id: 'd1', severity: 'medium-high' },
    ]);
  });

  it('无 stop_loss 字段 → 不误报', () => {
    expect(collectStopLossAlerts([{ id: 'd3', type: 'CRM_DEAL', payload: {} }])).toEqual([]);
  });

  it('非 CRM_DEAL 实体被忽略', () => {
    expect(collectStopLossAlerts([{ id: 'a2', type: 'CRM_ACCOUNT', payload: { stop_loss: { status: 'triggered' } } }])).toEqual([]);
  });
});
