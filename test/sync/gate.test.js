import { describe, it, expect } from 'vitest';
import { createSyncGate } from 'file:///D:/system/CRM-ai-native/src/sync/gate.js';

describe('sync gate（接入评审闸门）', () => {
  it('四类动作未放行一律拒绝（fail-closed）', async () => {
    const g = createSyncGate({ reviewGate: { hasApproval: async () => false } });
    for (const action of ['first-connect', 'mapping-change', 'trust-elevate', 'enable-writeback']) {
      const r = await g.check({ action, tenantId: 't1' });
      expect(r.ok).toBe(false);
      expect(r.error).toContain('not_approved');
    }
  });

  it('放行记录留 decision_id 与审批人（无自动放行路径）', async () => {
    const approvals = [];
    const g = createSyncGate({
      reviewGate: {
        hasApproval: async ({ action, tenantId }) => {
          return approvals.find(a => a.action === action && a.tenantId === tenantId) || null;
        },
      },
    });
    // 模拟 review-gate 已人工放行
    approvals.push({ action: 'first-connect', tenantId: 't1', decision_id: 'dec-1', approver: 'admin' });
    const r = await g.check({ action: 'first-connect', tenantId: 't1' });
    expect(r.ok).toBe(true);
    expect(r.approval.decision_id).toBe('dec-1');
    expect(r.approval.approver).toBe('admin');
    // 无自动放行路径（无 autoApprove 方法）
    expect(typeof g.autoApprove).toBe('undefined');
  });
});
