// src/http/financeReceivablesConfigRouter.js — S05 T5 应收配置后台化（config_store 承载）
// 契约：
//   GET /api/config/finance-receivables → {payment_overdue_days, gap_threshold_pct, aging_buckets}
//   PUT /api/config/finance-receivables  → 局部更新三项（persist + 决策第0闸凭证）
// 两闸：sysadmin/admin 角色闸 + 写经决策第0闸（config_store.decision_id TEXT 无 FK，对齐 seven-dim 形态）
// 消费方：T1 应收端点（aging_buckets）/ T4 差额阈值 / T6 逾期规则
import { Router } from 'express';
import { scenarioDeps } from '../portal/decisionScenario.js';
import { resolveMe as realResolveMe } from './auth.js';
import { readConfig, writeConfig } from '../config/configStore.js';
import { scopeTenant, scopeOf } from './tenantScope.js';
import { canWriteTenantConfig } from './middleware/rbac.js';

const CONFIG_KEY = 'finance-receivables';
export const DEFAULTS = { payment_overdue_days: 7, gap_threshold_pct: 5, aging_buckets: [[0, 30], [31, 60], [61, 90], [91, 9999]] };

// 角色闸（§15.1 租户级三角色）：消费 rbac 单一事实源。
// 2026-09-17 修复：原 `role === 'admin' || role === 'sysadmin'` 漏掉 ten_admin
// （userManagement ROLE_TAGS 真实落库名）⇒ 上层 §15 level 闸（本端点 level='tenant'）放行、本闸却 403。
function roleOk(role) { return canWriteTenantConfig({ role }); }

async function ensureAdmin(req, res) {
  let me = null;
  try { me = await realResolveMe(req); } catch { me = { ok: false }; }
  if (!me?.ok || !roleOk(me.role)) { res.status(403).json({ error: '租户级配置需 ten_admin(本租户)/sysadmin/ADMIN 权限（§15.1）' }); return null; }
  return me;
}

async function readCurrent(tenantId) {
  try { const r = await readConfig(CONFIG_KEY, { tenantId }); return r?.value || {}; }
  catch { return {}; }
}

export function createFinanceReceivablesConfigRouter() {
  const router = Router();

  router.get('/api/config/finance-receivables', async (req, res) => {
    try {
      const me = await ensureAdmin(req, res);
      if (!me) return;
      res.json({ ...DEFAULTS, ...(await readCurrent(scopeTenant(me))) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.put('/api/config/finance-receivables', async (req, res) => {
    try {
      const me = await ensureAdmin(req, res);
      if (!me) return;
      const body = req.body || {};
      const allowed = ['payment_overdue_days', 'gap_threshold_pct', 'aging_buckets'];
      const pick = {};
      for (const k of allowed) if (k in body) pick[k] = body[k];
      if (!Object.keys(pick).length) return res.status(400).json({ error: '无可更新字段' });
      const next = { ...DEFAULTS, ...(await readCurrent(scopeOf(me))), ...pick };
      const decision = await scenarioDeps.produceDecision({ fields: Object.keys(pick) });
      await writeConfig(CONFIG_KEY, next, { tenantId: scopeOf(me), decisionId: decision?.decisionId || null, updatedBy: 'system' });
      res.json({ ...next, decision: decision?.decisionId || null, updated: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  return router;
}