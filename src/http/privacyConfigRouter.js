// src/http/privacyConfigRouter.js — P1 隐私排除清单的配置面（G7）
// 设计：docs/2026-09-18-unified-integration-design-v2.md §8.1（配置）+ §11 P1（界面 + 丢弃计数）
//
// 契约：
//   GET /api/config/sync-privacy → { exclude_domains, exclude_addresses, exclude_keywords,
//                                    config_ok, invalid_items, recent }
//   PUT /api/config/sync-privacy → 局部更新三类数组（决策第 0 闸 + 租户配置角色闸）
//
// `recent` = 各同步目标最近一次的隐私丢弃计数（来源 crm.sync_cursor.last_counts，由 sync/engine.js 写入）。
//   为什么必须回这个：界面若只显示「已配置 N 条规则」，用户无法区分「规则生效了」与
//   「规则配了但一条都没生效」（后者是纸面能力）——判据是**丢弃计数**，不是配置项存在。
//
// 两闸（与 financeReceivablesConfigRouter 同源）：
//   ① sysadmin/ADMIN/ten_admin(本租户) 角色闸（rbac 单一事实源 canWriteTenantConfig）
//   ② 写经决策第 0 闸（produceDecision，无决策不写）
import { Router } from 'express';
import { scenarioDeps } from '../portal/decisionScenario.js';
import { resolveMe as realResolveMe } from './auth.js';
import { readConfig, writeConfig } from '../config/configStore.js';
import { scopeTenant, scopeOf } from './tenantScope.js';
import { canWriteTenantConfig } from './middleware/rbac.js';
import { PRIVACY_CONFIG_KEY, DEFAULT_PRIVACY, normalizePrivacyConfig } from '../channels/privacyFilter.js';

const ALLOWED = ['exclude_domains', 'exclude_addresses', 'exclude_keywords'];

async function ensureAdmin(req, res) {
  let me = null;
  try { me = await realResolveMe(req); } catch { me = { ok: false }; }
  if (!me?.ok || !canWriteTenantConfig({ role: me.role })) {
    res.status(403).json({ error: '租户级配置需 ten_admin(本租户)/sysadmin/ADMIN 权限（§15.1）' });
    return null;
  }
  return me;
}

/** 输入校验：只收字符串数组（其余一律拒绝并**指出具体哪一项**，避免用户面对静默丢弃猜原因）。 */
function validatePayload(body) {
  const pick = {};
  const bad = [];
  for (const k of ALLOWED) {
    if (!(k in body)) continue;
    const v = body[k];
    if (!Array.isArray(v)) { bad.push(`${k} 必须是数组`); continue; }
    const ok = v.filter((x) => typeof x === 'string' && x.trim());
    if (ok.length !== v.length) bad.push(`${k} 含非字符串或空项（已忽略 ${v.length - ok.length} 项）`);
    pick[k] = ok.map((s) => s.trim());
  }
  return { pick, bad };
}

/**
 * 最近一次同步的隐私丢弃计数（可观测性入口）。
 * 查询失败**不阻断**配置读取（展示层故障不应让配置不可读），但必须显式回报 unavailable（不静默）。
 */
async function readRecentDrops({ pool, tenantId }) {
  if (!pool) return { available: false, reason: 'pool_not_wired' };
  try {
    const { rows } = await pool.query(
      `SELECT provider, external_object, last_counts, last_run_at
         FROM crm.sync_cursor WHERE tenant_id=$1 ORDER BY last_run_at DESC NULLS LAST LIMIT 20`,
      [tenantId],
    );
    const items = rows.map((r) => ({
      provider: r.provider,
      object: r.external_object,
      last_run_at: r.last_run_at,
      read: Number(r.last_counts?.read || 0),
      privacy_dropped: Number(r.last_counts?.privacy_dropped || 0),
      by_reason: r.last_counts?.privacy_dropped_by_reason || null,
      config_ok: r.last_counts?.privacy_config_ok === false ? false : true,
    })).filter((x) => x.privacy_dropped > 0 || x.config_ok === false);
    return { available: true, items };
  } catch (e) {
    return { available: false, reason: String(e?.message || e) };
  }
}

export function createPrivacyConfigRouter({ pool = null, deps = {} } = {}) {
  const D = { ...scenarioDeps, ...deps };
  const router = Router();

  router.get('/api/config/sync-privacy', async (req, res) => {
    try {
      let me = null;
      try { me = await realResolveMe(req); } catch { me = { ok: false }; }
      if (!me?.ok) return res.status(401).json({ error: 'unauthorized' });
      const tenantId = scopeTenant(me);
      const row = await readConfig(PRIVACY_CONFIG_KEY, { tenantId }).catch(() => null);
      const norm = normalizePrivacyConfig(row?.value);
      res.json({
        ...DEFAULT_PRIVACY,
        exclude_domains: norm.exclude_domains,
        exclude_addresses: norm.exclude_addresses,
        exclude_keywords: norm.exclude_keywords,
        // 配置形状是否可解析：形状坏掉时界面必须说出来（否则「规则都在但一条没生效」无从察觉）
        config_ok: norm.config_ok,
        invalid_items: norm.invalid_items,
        recent: await readRecentDrops({ pool, tenantId }),
        can_write: canWriteTenantConfig({ role: me.role }),
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.put('/api/config/sync-privacy', async (req, res) => {
    try {
      const me = await ensureAdmin(req, res);
      if (!me) return;
      const body = req.body || {};
      const { pick, bad } = validatePayload(body);
      if (!Object.keys(pick).length) {
        return res.status(400).json({ error: '无可更新字段（只接受 exclude_domains / exclude_addresses / exclude_keywords）', issues: bad });
      }
      const tenantId = scopeOf(me);
      const row = await readConfig(PRIVACY_CONFIG_KEY, { tenantId }).catch(() => null);
      const base = normalizePrivacyConfig(row?.value);
      const next = {
        exclude_domains: pick.exclude_domains ?? base.exclude_domains,
        exclude_addresses: pick.exclude_addresses ?? base.exclude_addresses,
        exclude_keywords: pick.exclude_keywords ?? base.exclude_keywords,
      };
      const decision = await D.produceDecision({ key: PRIVACY_CONFIG_KEY, fields: Object.keys(pick) });
      await writeConfig(PRIVACY_CONFIG_KEY, next, {
        tenantId, decisionId: decision?.decisionId || null, updatedBy: me?.id || 'system',
      });
      const norm = normalizePrivacyConfig(next);
      res.json({ ...next, config_ok: norm.config_ok, issues: bad, decision: decision?.decisionId || null, updated: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  return router;
}
