// src/channels/reviewGate.js — channelRouter 的 review-gate 生产默认（HITL 人工闸）
// 设计：docs/2026-09-17-channel-adapter-unified-design.md §4.5.1 步骤③
// 语义：接入=四类动作 first-connect → 查既有 CRM_APPROVAL_INSTANCE（business_type='channel'，
//       business_id=channel id）status='APPROVED' 的行。无 → 未获人工放行（approval_required）。
// 铁律：fail-closed——查不到/查询失败一律视为未批准（绝不默认放行）；
//       无自动放行路径（与 src/sync/gate.js 同源红线）。
// 契约：reviewGate.hasApproval({ action, tenantId, ctx }) → truthy（批准记录）/ falsy（未批准）
import { queryParticles as realQueryParticles } from '../particles/particleRepo.js';

export function createChannelReviewGate({ queryParticles = realQueryParticles } = {}) {
  return {
    async hasApproval({ action, tenantId = 'system', ctx = {} } = {}) {
      try {
        if (action !== 'first-connect') return null; // 本闸只管 first-connect（与 sync/gate.js 动作集口径一致）
        const id = ctx?.id || null;
        if (!id) return null;
        const rows = await queryParticles({ type: 'CRM_APPROVAL_INSTANCE', tenantId, limit: 200 }).catch(() => []);
        const hit = rows.find(
          (r) => r?.payload?.business_type === 'channel' && r?.payload?.business_id === id && r?.state === 'APPROVED'
        );
        return hit ? { approved: true, instance_id: hit.id, at: hit.updated_at || hit.created_at } : null;
      } catch {
        return null; // fail-closed：查询失败视为未批准
      }
    },
  };
}
