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
// A3（2026-09-16，用户批准方案 i）：分级依据纳入决策冻结通道
import { writeConfig } from '../config/configStore.js';
import { emit } from '../events/bus.js';
import { recordFailure } from '../monitor/monitorStore.js';

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

// ---- A3 镜像（2026-09-16，用户批准方案 i）：分级表 → config_store['business-tier-config'] ----
// 目的：让分级依据进入 loadSnapshot（policyVersion.js:46-53）的读取半径，从而被 effective_policy_version 冻结。
// 不做会怎样：分级变更不产生新版本 → 历史决策的判定依据不可复现（设计 §2.4 D3，审计断链）。
// 一致性铁律：镜像与表不一致 = 冻结的是**错误依据**，比不冻结更危险 → verifyMirrorConsistency 探针守护；
//   且写入路径上镜像失败必须 **fail-closed**（抛错让 PUT 失败），不许出现"配置改了但冻结没跟上"。
export const TIER_MIRROR_KEY = 'business-tier-config';

export async function mirrorBusinessTierConfig(tenantId, decisionId = null) {
  if (!tenantId || tenantId === '*') {
    // '*' 是 admin 通配视界（非真实租户）——镜像只服务真实租户，跳过并留痕（反静默）
    emit('trace', 'business-tier-mirror-skipped', { tenantId, reason: 'wildcard-or-empty-tenant' });
    return null;
  }
  const r = await query(
    `SELECT dimension, dimension_value, tier FROM crm.business_tier_config
     WHERE tenant_id=$1 ORDER BY dimension, dimension_value`,
    [tenantId]
  );
  const rules = r.rows.map((x) => ({ dimension: x.dimension, dimension_value: x.dimension_value, tier: x.tier }));
  // decisionId 复用同一第 0 闸凭据 → 镜像变更本身也可溯源（不是一次"无凭据的写"）
  // ⚠ 铁律：镜像 value **禁放任何易变字段**（时间戳/随机值）。policyVersion 用**内容哈希**做版本寻址
  //   （policyVersion.js:55-58），带 new Date() 会让每次 mirror 都解析成"新版本" → 版本表爆炸，
  //   且破坏该文件 :9 声明的不变量 I6「内容相同 → 复用既有版本 id」。
  //   写入时间由 config_store.updated_at 列承载，不重复进 value（2026-09-16 实证发现，见 T21 验收）。
  await writeConfig(TIER_MIRROR_KEY, {
    rules, mirror_count: rules.length,
  }, { tenantId, decisionId, updatedBy: 'business-tier-mirror' });
  return rules.length;
}

// 一致性探针（禁假绿）：镜像条数 == 表行数？不等 → 留痕 + ok:false。
// 为什么必须有：镜像引入双写，同步失败时冻结的是旧依据，且**表面全绿**（版本照常解析、决策照常落库）。
export async function verifyMirrorConsistency(tenantId) {
  const t = await query(`SELECT count(*)::int n FROM crm.business_tier_config WHERE tenant_id=$1`, [tenantId]);
  const c = await query(
    `SELECT value FROM crm.config_store WHERE tenant_id=$1 AND key=$2`, [tenantId, TIER_MIRROR_KEY]
  );
  const tableCount = t.rows[0]?.n ?? 0;
  // JSONB 读取须走 Array.isArray 守卫（横切踩坑：直接 .length 在非数组形态下静默得 undefined）
  const mirrorCount = Array.isArray(c.rows[0]?.value?.rules) ? c.rows[0].value.rules.length : null;
  const ok = mirrorCount === tableCount;
  if (!ok) {
    emit('trace', 'business-tier-mirror-drift', { tenantId, tableCount, mirrorCount });
    recordFailure('business-tier-mirror-drift', new Error(`table=${tableCount} mirror=${mirrorCount}`));
  }
  return { ok, tableCount, mirrorCount };
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
  upsertTier: async (dimension, dimension_value, tier, actor, opts = {}) => {
    const tid = scopeOf(actor);
    const r = await query(
      `INSERT INTO crm.business_tier_config (tenant_id, dimension, dimension_value, tier)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, dimension, dimension_value) DO UPDATE SET tier=$4
       RETURNING tenant_id, dimension, dimension_value, tier`,
      [tid, dimension, dimension_value, tier]
    );
    // A3（方案 i）：写后镜像，fail-closed —— 镜像失败直接抛，让本次 PUT 失败。
    // 取舍：宁可"这次没改成"（用户可重试），也不要"改成了但决策冻结依据仍是旧的"
    //   （后者是静默断链：版本照常解析、决策照常落库，巡检也看不出来）。
    const mirrorCount = await mirrorBusinessTierConfig(tid, opts.decisionId || null);
    return { ...r.rows[0], mirror_count: mirrorCount };
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
        // 第 0 闸凭据同时传给镜像（A3）：镜像写入本身也带 decision_id，可溯源
        const row = await D.upsertTier(dimension, dimension_value, tier, me, { decisionId: decision?.decisionId || null });
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
