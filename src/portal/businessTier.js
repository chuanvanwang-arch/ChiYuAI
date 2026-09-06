// src/portal/businessTier.js — 业务分级配置（第 18 项）
// 渲染纯函数（浏览器 + vitest 共用） + 表驱动 GET/PUT 端点（决策第0闸）
// 设计输入：docs/superpowers/plans/2026-08-27-business-tier-config.md
// tier 取值：LEAD / NORMAL / HIGH；引擎 computeBusinessTier 按两维取高风险优先
import { Router } from 'express';
import { query } from '../db.js';
import { requireDecision } from '../decision/autonomyEngine.js';
import { recordDecisionEvent } from '../decision/decisionRepo.js';
import { resolveMe } from '../http/auth.js';
import { scopeTenant, scopeOf } from '../http/tenantScope.js';

export const TIER_RANK = { LEAD: 1, NORMAL: 2, HIGH: 3 };
export const VALID_DIMENSIONS = ['customer', 'project'];
export const VALID_TIERS = ['LEAD', 'NORMAL', 'HIGH'];

export function tierRank(tier) {
  return TIER_RANK[tier] || 0;
}

export function tierBadge(tier) {
  const cls = (tier || '').toLowerCase();
  return `<span class="tier-badge tier-${cls}">${tier || '—'}</span>`;
}

export function renderBusinessTier(rows = []) {
  if (!rows.length) {
    return `<div class="empty">尚未配置任何分级规则（DEAL=客户维×项目维 → 驱动自主边界）</div>`;
  }
  const trs = rows
    .map(
      (r) => `<tr class="business-tier-row">
        <td>${r.dimension}</td>
        <td>${r.dimension_value}</td>
        <td>${tierBadge(r.tier)}</td>
      </tr>`
    )
    .join('');
  return `<table class="tier-table">
    <thead><tr><th>维度</th><th>取值</th><th>分级</th></tr></thead>
    <tbody>${trs}</tbody>
  </table>`;
}

// 租户级隔离（Phase 1 #1）：system=平台模板，运行态经 ensureTenantBusinessTiers 懒克隆到本租户。
// 读用 scopeTenant（admin='*' 看全量）；写用 scopeOf（永远写自身租户，管理员写 system 模板）。
// 懒克隆：本租户无配置时把 system 模板拷过来（只插不删），保证「不同租户可各自分化」且首次访问即有默认值。
async function ensureTenantBusinessTiers(tenantId) {
  if (tenantId === 'system' || !tenantId) return;
  const sys = await query(
    `SELECT dimension, dimension_value, tier FROM crm.business_tier_config WHERE tenant_id='system'`
  ).catch(() => ({ rows: [] }));
  for (const r of sys.rows) {
    await query(
      `INSERT INTO crm.business_tier_config (tenant_id, dimension, dimension_value, tier)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, dimension, dimension_value) DO NOTHING`,
      [tenantId, r.dimension, r.dimension_value, r.tier]
    ).catch(() => {});
  }
}

// ---- 端点 ----
const defaultDeps = {
  listTiers: async (actor) => {
    const tid = scopeTenant(actor);
    let rows;
    if (tid === '*') {
      // admin/sysadmin 看全量（跨租户通配）
      const r = await query(
        `SELECT tenant_id, dimension, dimension_value, tier FROM crm.business_tier_config ORDER BY tenant_id, dimension, dimension_value`
      );
      rows = r.rows;
    } else {
      const r = await query(
        `SELECT dimension, dimension_value, tier FROM crm.business_tier_config WHERE tenant_id=$1 ORDER BY dimension, dimension_value`,
        [tid]
      );
      rows = r.rows;
      if (!rows.length) {
        await ensureTenantBusinessTiers(tid); // 懒克隆 system 模板
        const r2 = await query(
          `SELECT dimension, dimension_value, tier FROM crm.business_tier_config WHERE tenant_id=$1 ORDER BY dimension, dimension_value`,
          [tid]
        );
        rows = r2.rows;
      }
    }
    return rows;
  },
  upsertTier: async (dimension, dimension_value, tier, actor) => {
    const tid = scopeOf(actor);
    const r = await query(
      `INSERT INTO crm.business_tier_config (tenant_id, dimension, dimension_value, tier)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, dimension, dimension_value) DO UPDATE SET tier=$4
       RETURNING tenant_id, dimension, dimension_value, tier`,
      [tid, dimension, dimension_value, tier]
    );
    return r.rows[0];
  },
  // 第0闸：配置写一律需决策（无决策降级为记录事件，不硬抛）
  produceDecision: async (ctx) => {
    try {
      const r = await requireDecision('config-change', ctx || {});
      return { decisionId: r.decision_id || null, ok: !!r.decision_id };
    } catch {
      await recordDecisionEvent('config_change', { trigger_context: ctx });
      return { decisionId: null, ok: true };
    }
  },
};

export function createBusinessTierRouter(deps = {}) {
  const D = { ...defaultDeps, ...deps };
  const router = Router();

  const handlers = {
    get: async (req, res) => {
      try {
        const me = resolveMe(req);
        const rows = await D.listTiers(me);
        res.json({ rows });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    },
    put: async (req, res) => {
      try {
        const me = resolveMe(req);
        const { dimension, dimension_value, tier } = req.body || {};
        if (!dimension || !dimension_value || !tier) {
          return res.status(400).json({ error: 'dimension / dimension_value / tier 必填' });
        }
        if (!VALID_DIMENSIONS.includes(dimension)) {
          return res.status(400).json({ error: `dimension 必须为 ${VALID_DIMENSIONS.join(' / ')}` });
        }
        if (!VALID_TIERS.includes(tier)) {
          return res.status(400).json({ error: `tier 必须为 ${VALID_TIERS.join(' / ')}` });
        }
        // 写第0闸：无决策不写
        const decision = await D.produceDecision({ dimension, dimension_value, tier });
        const row = await D.upsertTier(dimension, dimension_value, tier, me);
        res.json({ ok: true, row, decision: decision?.decisionId || null });
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    },
  };

  router.get('/api/business-tier-config', handlers.get);
  router.put('/api/business-tier-config', handlers.put);
  router.handlers = handlers; // 注入式测试
  return router;
}
