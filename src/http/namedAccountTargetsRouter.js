// src/http/namedAccountTargetsRouter.js — 目标指标配置后台化（config_store['named-account-targets']）
// 契约：
//   GET /api/config/named-account-targets → mergedTargets(readCurrent)（DEFAULTS 铺底 + 已存覆写）
//   PUT /api/config/named-account-targets  → 局部更新 tiers/window_days/metrics（决策第0闸凭证）
// 两闸：sysadmin/admin 角色闸 + 写经决策第0闸（config_store.decision_id TEXT 无 FK，对齐 seven-dim/finance-receivables）
// 消费方：/api/page/account-360（target vs actual）+ /api/board/named-accounts（达标标记）
// 设计：docs/2026-08-29-sales-crm-integration-design-v1-full-layers.md §13
import { Router } from 'express';
import { scenarioDeps } from '../portal/decisionScenario.js';
import { resolveMe as realResolveMe } from './auth.js';
import { readConfig, writeConfig } from '../config/configStore.js';
import { scopeTenant, scopeOf } from './tenantScope.js';
import { DEFAULTS, mergedTargets, metricDimensions } from '../sales/namedAccountTargets.js';

const CONFIG_KEY = 'named-account-targets';

function roleOk(role) { return role === 'admin' || role === 'sysadmin'; }

async function ensureAdmin(req, res) {
  let me = null;
  try { me = await realResolveMe(req); } catch { me = { ok: false }; }
  if (!me?.ok || !roleOk(me.role)) { res.status(403).json({ error: '需要 sysadmin 权限' }); return null; }
  return me;
}

async function readCurrent(tenantId) {
  try {
    const r = await readConfig(CONFIG_KEY, { tenantId });
    return r?.value || {};
  } catch { return {}; }
}

export function createNamedAccountTargetsRouter() {
  const router = Router();

  router.get('/api/config/named-account-targets', async (req, res) => {
    try {
      const me = await ensureAdmin(req, res);
      if (!me) return;
      const merged = mergedTargets(await readCurrent(scopeTenant(me)));
      // ④ 引擎口径：附带 metricDimensions 可读标签（单一事实源 namedAccountTargets.js，前端展示用）
      res.json({ ...merged, metricDimensions: metricDimensions(merged) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.put('/api/config/named-account-targets', async (req, res) => {
    try {
      const me = await ensureAdmin(req, res);
      if (!me) return;
      const body = req.body || {};
      const allowed = ['tiers', 'window_days', 'metrics'];
      const pick = {};
      for (const k of allowed) if (k in body) pick[k] = body[k];
      if (!Object.keys(pick).length) return res.status(400).json({ error: '无可更新字段' });
      // 校验：tiers 必须是带 tier/visit_freq 的数组（防非法配置落库）
      if (pick.tiers !== undefined && (!Array.isArray(pick.tiers) || pick.tiers.some((t) => !t?.tier || !t?.visit_freq))) {
        return res.status(400).json({ error: 'tiers 须为 [{tier, visit_freq:{times,window}}] 数组' });
      }
      const next = mergedTargets({ ...(await readCurrent(scopeOf(me))), ...pick });
      const decision = await scenarioDeps.produceDecision({ scenario_id: 'config_change', fields: Object.keys(pick) });
      await writeConfig(CONFIG_KEY, next, { tenantId: scopeOf(me), decisionId: decision?.decisionId || null, updatedBy: 'system' });
      res.json({ ...next, decision: decision?.decisionId || null, updated: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  return router;
}

export { DEFAULTS, CONFIG_KEY };