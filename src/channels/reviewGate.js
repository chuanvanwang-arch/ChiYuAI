// src/channels/reviewGate.js — channelRouter / sync 的 review-gate 生产默认（HITL 人工闸）
// 设计：docs/2026-09-17-channel-adapter-unified-design.md §4.5.1 步骤③ + docs/2026-09-18-unified-integration-design-v2.md §0-1/§5（P3 评审闸接线）
// 语义：四类评审动作 → 查既有 CRM_APPROVAL_INSTANCE（business_type 见下表、business_id=ctx.id）
//       status='APPROVED' 的行。无 → 未获人工放行（approval_required）。
// 铁律：fail-closed——查不到/查询失败一律视为未批准（绝不默认放行）；
//       无自动放行路径（与 src/sync/gate.js 同源红线）。
// 契约：reviewGate.hasApproval({ action, tenantId, ctx }) → truthy（批准记录）/ falsy（未批准）
//
// ⚠ P3 前此处只认 first-connect，mapping-change / trust-elevate / enable-writeback 一律返 null
//   → 即便 gate.js 把这三动作传给它，也永远 not_approved（纸面闸门根因）。现按动作映射到不同
//   business_type，使三类评审闸真正可查到对应批准实例（将来 P5/P6 放开回写/映射/提权时闸才放行）。
import { queryParticles as realQueryParticles } from '../particles/particleRepo.js';

// 评审动作 → 人工审批实例的业务类型（与 gate.js SYNC_GATE_ACTIONS 一一对应）
const ACTION_TO_BUSINESS_TYPE = {
  'first-connect': 'channel',
  'mapping-change': 'mapping',
  'trust-elevate': 'trust',
  'enable-writeback': 'writeback',
};

export function createChannelReviewGate({ queryParticles = realQueryParticles } = {}) {
  return {
    async hasApproval({ action, tenantId = 'system', ctx = {} } = {}) {
      try {
        const bt = ACTION_TO_BUSINESS_TYPE[action];
        if (!bt) return null; // 未知动作 → 未批准（绝不默认放行）
        const id = ctx?.id || null;
        if (!id) return null; // 无业务 id（通道/映射/提权/回写主体）无法定位批准实例
        const rows = await queryParticles({ type: 'CRM_APPROVAL_INSTANCE', tenantId, limit: 200 }).catch(() => []);
        const hit = rows.find(
          (r) => r?.payload?.business_type === bt && r?.payload?.business_id === id && r?.payload?.status === 'APPROVED'
        );
        return hit ? { approved: true, instance_id: hit.id, at: hit.updated_at || hit.created_at } : null;
      } catch {
        return null; // fail-closed：查询失败视为未批准
      }
    },
  };
}
