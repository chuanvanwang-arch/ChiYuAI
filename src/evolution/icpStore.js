// src/evolution/icpStore.js
// ICP 自进化 store：config_store['discovery-rules'] 读写 + 决策第 0 闸锚点。
// 铁律：
//   ① 写必经 requireDecision（落 crm.decision 行）+ decisionId 透传 writeConfig（configStore.js:64）；
//   ② 只 upsert，绝不 DELETE —— 草稿用数组 append + status 标记（'draft'|'approved'）；
//   ③ per-tenant (tenant_id, key) 收敛（configStore 自带 system 模板懒克隆）。
// 落点说明：草稿落 value.icp_draft（**生效键 value.icp 不动**）；唯一致效写在 setValidated。
//   不落 crm.decision_scenario —— 该表实测无 validated/status/draft 列，是生效场景字典而非草稿区。
import { readConfig, writeConfig } from '../config/configStore.js';
import { requireDecision } from '../decision/autonomyEngine.js';
import { ICP_DRAFT_KEY } from './icpSelfEvolution.js';

// 实测存在（tenant_id='system' / default_tier='HIGH' / autonomous_allowed=false）
//   ⚠ 不可用 'config-change'：该场景在测试库零行，requireDecision 对未知场景直接 throw（autonomyEngine.js:124）
export const ICP_DECISION_SCENARIO = 'CALIBRATION_CHANGE';

export function createIcpStore({ read = readConfig, write = writeConfig, gate = requireDecision } = {}) {
  return {
    // 读整行 value（租户感知；缺失返回 {}）
    async readConfigRow(tenantId) {
      const row = await read('discovery-rules', { tenantId });
      return (row && row.value) || {};
    },

    // 生效态 ICP（唯一事实源）
    async readActiveIcp({ tenantId = 'system' } = {}) {
      const v = await this.readConfigRow(tenantId);
      return v.icp || {};
    },

    // 落草稿：第 0 闸 → decisionId → writeConfig；生效键 icp **不动**
    async insertDraft(draft, { tenantId = 'system', actor = 'system' } = {}) {
      const res = await gate(
        ICP_DECISION_SCENARIO,
        { action: 'icp-recalibration-draft', tenantId, icp: (draft && draft.icp) || null },
        [{ type: 'CRM_ACCOUNT', id: null }],
        { actor_id: actor, tenantId }
      );
      // ⚠ 决策行在 requireDecision 返回体的 .decision 内（autonomyEngine.js:308），顶层无 decision_id
      const decisionId = res?.decision?.decision_id || null;
      const v = await this.readConfigRow(tenantId);
      const box = v[ICP_DRAFT_KEY] || {};
      const items = Array.isArray(box.items) ? box.items : [];
      const draftId = `icp-${Date.now()}-${items.length + 1}`;
      items.push({
        id: draftId,
        status: 'draft',
        validated: false,
        decision_id: decisionId,
        icp: (draft && draft.icp) || null,
        report: (draft && draft.report) || null,
        created_by: actor,
        created_at: new Date().toISOString(),
      });
      await write('discovery-rules', { ...v, [ICP_DRAFT_KEY]: { items } }, { tenantId, decisionId, updatedBy: actor });
      return { draftId, decisionId };
    },

    // HITL 生效：唯一致效写入口（草稿标 approved，绝不删除）
    async setValidated(draftId, validated, approver, { tenantId = 'system' } = {}) {
      const res = await gate(
        ICP_DECISION_SCENARIO,
        { action: 'icp-recalibration-approve', draftId, approver, tenantId },
        [{ type: 'CRM_ACCOUNT', id: null }],
        { actor_id: approver, tenantId }
      );
      const decisionId = res?.decision?.decision_id || null;
      const v = await this.readConfigRow(tenantId);
      const box = v[ICP_DRAFT_KEY] || {};
      const items = Array.isArray(box.items) ? box.items : [];
      const hit = items.find((d) => d.id === draftId);
      if (!hit) throw new Error(`setValidated: 草稿不存在 ${draftId}`);
      for (const d of items) {
        if (d.id === draftId) { d.status = 'approved'; d.validated = true; d.approved_by = approver; }
      }
      const next = { ...v, [ICP_DRAFT_KEY]: { items } };
      if (validated && hit.icp) next.icp = { ...(v.icp || {}), ...hit.icp };  // ← 唯一致效写
      await write('discovery-rules', next, { tenantId, decisionId, updatedBy: approver });
      return { draftId, decisionId, validated: !!validated };
    },
  };
}
