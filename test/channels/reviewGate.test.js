// test/channels/reviewGate.test.js — 接入③ review-gate HITL 人工闸守卫
// 判据（设计 §4.5.1 步骤③ + §8 红线）：接入=first-connect 须有人工批准记录（CRM_APPROVAL_INSTANCE APPROVED）；
//   无记录/查询失败/非 APPROVED → 一律未批准（fail-closed，绝不默认放行）。
import { describe, it, expect } from 'vitest';
import { createChannelReviewGate } from '../../src/channels/reviewGate.js';

describe('channelReviewGate HITL', () => {
  it('存在 APPROVED 的 channel 审批实例 → 批准', async () => {
    const gate = createChannelReviewGate({
      queryParticles: async () => [
        { id: 'ap-1', payload: { business_type: 'channel', business_id: 'channel-email-1', status: 'APPROVED' } },
      ],
    });
    const a = await gate.hasApproval({ action: 'first-connect', tenantId: 't1', ctx: { id: 'channel-email-1' } });
    expect(a).toBeTruthy();
    expect(a.approved).toBe(true);
    expect(a.instance_id).toBe('ap-1');
  });

  it('仅 APPROVING（未批准）→ 未批准', async () => {
    const gate = createChannelReviewGate({
      queryParticles: async () => [
        { id: 'ap-2', payload: { business_type: 'channel', business_id: 'channel-email-1', status: 'APPROVING' } },
      ],
    });
    const a = await gate.hasApproval({ action: 'first-connect', tenantId: 't1', ctx: { id: 'channel-email-1' } });
    expect(a).toBeNull();
  });

  it('business_id 不匹配 → 未批准', async () => {
    const gate = createChannelReviewGate({
      queryParticles: async () => [
        { id: 'ap-3', payload: { business_type: 'channel', business_id: 'OTHER', status: 'APPROVED' } },
      ],
    });
    const a = await gate.hasApproval({ action: 'first-connect', tenantId: 't1', ctx: { id: 'channel-email-1' } });
    expect(a).toBeNull();
  });

  it('查询失败 → fail-closed 未批准（绝不因查询失败默认放行）', async () => {
    const gate = createChannelReviewGate({ queryParticles: async () => { throw new Error('db down'); } });
    const a = await gate.hasApproval({ action: 'first-connect', tenantId: 't1', ctx: { id: 'channel-email-1' } });
    expect(a).toBeNull();
  });

  it('非 first-connect 动作 → 不适用（null）', async () => {
    const gate = createChannelReviewGate({ queryParticles: async () => [] });
    const a = await gate.hasApproval({ action: 'trust-elevate', tenantId: 't1', ctx: { id: 'channel-email-1' } });
    expect(a).toBeNull();
  });
});
