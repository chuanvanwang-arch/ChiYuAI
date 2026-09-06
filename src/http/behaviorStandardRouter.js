// src/http/behaviorStandardRouter.js — 销售行为标准量化目标配置后台化（config_store['behavior-standard']）
// 契约：
//   GET /api/config/behavior-standard  → mergedBehaviorStd(readCurrent) + STANDARDS 清单（任意登录用户可读，目标公开给销售）
//   PUT /api/config/behavior-standard  → 局部更新量化目标（决策第0闸凭证 + sysadmin/admin 角色闸）
// 消费方：/behavior-standard-config.html（配置页）+ /named-accounts.html（看板行为指标卡 实际 vs 目标）
// 设计：docs/2026-08-29-sales-crm-integration-design-v1-full-layers.md §5
import { Router } from 'express';
import { scenarioDeps } from '../portal/decisionScenario.js';
import { resolveMe as realResolveMe } from './auth.js';
import { readConfig, writeConfig } from '../config/configStore.js';
import { scopeTenant, scopeOf } from './tenantScope.js';
import { DEFAULTS, STANDARDS, mergedBehaviorStd } from '../sales/behaviorStandard.js';

const CONFIG_KEY = 'behavior-standard';

function roleOk(role) { return role === 'admin' || role === 'sysadmin'; }

async function readCurrent(tenantId) {
  try {
    const r = await readConfig(CONFIG_KEY, { tenantId });
    return r?.value || {};
  } catch { return {}; }
}

export function createBehaviorStandardRouter() {
  const router = Router();

  // GET 公开（目标应对销售可见，便于看板对比实际 vs 目标）；按租户读（回退 system 默认）
  router.get('/api/config/behavior-standard', async (req, res) => {
    try {
      let me;
      try { me = await realResolveMe(req); } catch { me = { ok: false }; }
      if (!me?.ok) return res.status(401).json({ error: '未登录' });
      res.json({ ...mergedBehaviorStd(await readCurrent(scopeTenant(me))), standards: STANDARDS });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.put('/api/config/behavior-standard', async (req, res) => {
    try {
      let me;
      try { me = await realResolveMe(req); } catch { me = { ok: false }; }
      if (!me?.ok || !roleOk(me.role)) { res.status(403).json({ error: '需要 sysadmin 权限' }); return; }
      const body = req.body || {};
      const pick = {};
      for (const k of Object.keys(DEFAULTS)) if (k in body) pick[k] = Number(body[k]);
      if (!Object.keys(pick).length) return res.status(400).json({ error: '无可更新字段' });
      // 校验：量化目标必须为正负整数/数字
      for (const [k, v] of Object.entries(pick)) {
        if (typeof v !== 'number' || Number.isNaN(v) || v < 0) {
          return res.status(400).json({ error: `${k} 须为非负数字` });
        }
      }
      const next = mergedBehaviorStd({ ...(await readCurrent(scopeOf(me))), ...pick });
      const decision = await scenarioDeps.produceDecision({ scenario_id: 'config_change', fields: Object.keys(pick) });
      await writeConfig(CONFIG_KEY, next, { tenantId: scopeOf(me), decisionId: decision?.decisionId || null, updatedBy: 'system' });
      res.json({ ...next, decision: decision?.decisionId || null, updated: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  return router;
}

export { DEFAULTS, STANDARDS, CONFIG_KEY };
