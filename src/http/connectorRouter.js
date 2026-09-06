// src/http/connectorRouter.js — 外部采集手动同步端点（方案 A：读链路补齐 + 手动触发）
// 契约：POST /api/connector/zhizao-verify → 调 conn-zhizao-verify-account
//       （决策第0闸 + sourcedFrom 弱边 + F18 抬头校验，见 src/connectors/connectorActions.js）
// 闸：admin/sysadmin 才能触发外部写通道；sales 不可直触。
import { Router } from 'express';
import { actionExecutor } from '../action/executor.js';

export function createConnectorRouter({ resolveMe }) {
  const r = Router();
  // 外部工商采集写通道：仅 admin/sysadmin 可触发（写第0闸由 action 内部 produceDecision 保障）
  r.post('/zhizao-verify', async (req, res) => {
    try {
      const me = resolveMe(req);
      if (!me.ok) return res.status(401).json({ error: me.error });
      if (!['admin', 'sysadmin'].includes(me.role)) {
        return res.status(403).json({ error: 'forbidden', gate: 'role' });
      }
      const { account_id, verification } = req.body || {};
      if (!account_id || !verification) {
        return res.status(400).json({ error: 'account_id 与 verification 必填' });
      }
      const result = await actionExecutor.dispatch(
        'conn-zhizao-verify-account',
        { account_id, verification },
        {
          actor: me.username,
          tenantId: me.tenantId,
          decision_id: null,
          // 手动同步语义：admin/sysadmin 已在端点显式触发（403 闸之上），等同审批流通过 → 放行写通道第3闸
          // 否则 conn-zhizao-verify-account 的 needsApproval=true 会让手动同步永远被 HITL 拦截
          approvalPassed: true,
        }
      );
      // executor 返回 { ok, data, action, confirm }；decision_id 藏在 handler 返回的 data.decision_id
      // action 级失败（如 F18 抬头校验拒绝）不透传 200——4xx 语义（业务拒绝，非 5xx 服务器错误）
      if (!result?.ok) {
        return res.status(400).json({ error: result?.error || 'connector action failed', result });
      }
      res.json({ ok: true, decision_id: result?.data?.decision_id, result });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
  return r;
}
