// src/portal/businessTier.js — 业务分级配置（第 18 项）
// 渲染纯函数（浏览器 + vitest 共用） + 表驱动 GET/PUT 端点（决策第0闸）
// 设计输入：docs/superpowers/plans/2026-08-27-business-tier-config.md
// tier 取值：LEAD / NORMAL / HIGH；引擎 computeBusinessTier 按两维取高风险优先
import { Router } from 'express';
import { query } from '../db.js';
import { requireDecision, decisionIdOf } from '../decision/autonomyEngine.js';
import { recordDecisionEvent } from '../decision/decisionRepo.js';
import { resolveMe } from '../http/auth.js';
import { scopeTenant, scopeOf } from '../http/tenantScope.js';
// A3（2026-09-16，用户批准方案 i）：分级依据纳入决策冻结通道
import { writeConfig } from '../config/configStore.js';
import { emit } from '../events/bus.js';
import { recordFailure } from '../monitor/monitorStore.js';

// 渲染纯函数**单一实现**：一律来自 businessTierRender.js（浏览器可直接加载），此处只做转发。
// 2026-09-16 收口：此前本文件与 businessTierRender.js 各存一份 renderBusinessTier/tierBadge/
//   TIER_RANK —— 双实现无守卫，改一处漏一处即"页面与测试行为不一致"的静默漂移
//   （典型表现：测试全绿、页面照旧）。改为 re-export 后，两侧物理上不可能再不一致。
import {
  TIER_RANK, VALID_DIMENSIONS, VALID_TIERS,
  tierRank, tierBadge, tierStatus, statusBadge, renderBusinessTier,
} from './businessTierRender.js';

export {
  TIER_RANK, VALID_DIMENSIONS, VALID_TIERS,
  tierRank, tierBadge, tierStatus, statusBadge, renderBusinessTier,
};

// A2（2026-09-16）：授权人标签 —— 取 username（唯一且稳定），回退 display_name，最后 'system'。
// 不优先 display_name：它可重名、可改，作为审计主体不稳定（"谁批的"要能反查到人）。
function actorLabel(a) {
  if (!a) return 'system';
  return a.username || a.display_name || 'system';
}

// 租户级隔离（Phase 1 #1）：system=平台模板，运行态经 ensureTenantBusinessTiers 懒克隆到本租户。
// 读用 scopeTenant（admin='*' 看全量）；写用 scopeOf（永远写自身租户，管理员写 system 模板）。
// 懒克隆：本租户无配置时把 system 模板拷过来（只插不删），保证「不同租户可各自分化」且首次访问即有默认值。
async function ensureTenantBusinessTiers(tenantId) {
  if (tenantId === 'system' || !tenantId) return;
  const sys = await query(
    `SELECT dimension, dimension_value, tier FROM crm.business_tier_config WHERE tenant_id='system'`
  ).catch((e) => {
    // 反静默（铁律：禁裸 .catch）：克隆源读失败会让新租户"看起来没有任何分级"→ 回退 default_tier，
    // 是无声的行为降级，必须留痕而不是吞掉。
    emit('trace', 'business-tier-template-read-failed', { tenantId, error: String(e?.message || e) });
    return { rows: [] };
  });
  for (const r of sys.rows) {
    await query(
      // 克隆行标 approved_by='system-template'（事实：它来自平台模板而非某人批准）；
      // decision_id 留 NULL —— 懒克隆不是决策驱动的写，不虚构凭据。
      `INSERT INTO crm.business_tier_config
         (tenant_id, dimension, dimension_value, tier, approved_by, approved_at)
       VALUES ($1, $2, $3, $4, 'system-template', now())
       ON CONFLICT (tenant_id, dimension, dimension_value) DO NOTHING`,
      [tenantId, r.dimension, r.dimension_value, r.tier]
    ).catch((e) => {
      emit('trace', 'business-tier-lazy-clone-failed', {
        tenantId, dimension: r.dimension, dimension_value: r.dimension_value,
        error: String(e?.message || e),
      });
    });
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
  // 镜像承载的是「**判定依据**」，不是「审计全貌」——审计全貌留在表里（零 DELETE，行永远可查）。
  // 因此 revoked_at 只取派生布尔 `revoked`（撤回的具体时刻不影响判定结果，进哈希只会制造版本噪音）；
  // expires_at 必须保留（它影响判定：到期即失效），且必须用 SQL 侧固定 UTC 文本输出——
  //   pg 驱动把 timestamptz 解析成 JS Date（毫秒精度），会**丢掉 DB 的微秒**，同一行序列化结果
  //   依赖驱动版本/时区设置 → 哈希不稳 → 版本表爆炸（与 mirrored_at 同族，见下行铁律）。
  const r = await query(
    `SELECT dimension, dimension_value, tier,
            (revoked_at IS NOT NULL) AS revoked,
            to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expires_at
       FROM crm.business_tier_config
      WHERE tenant_id=$1 ORDER BY dimension, dimension_value`,
    [tenantId]
  );
  const rules = r.rows.map((x) => ({
    dimension: x.dimension, dimension_value: x.dimension_value, tier: x.tier,
    revoked: x.revoked === true, expires_at: x.expires_at || null,
  }));
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
        `SELECT tenant_id, dimension, dimension_value, tier,
                approved_by, approved_at, decision_id, expires_at, revoked_at, revoked_reason
           FROM crm.business_tier_config ORDER BY tenant_id, dimension, dimension_value`
      );
      rows = r.rows;
    } else {
      // A2/A4：读侧返回授权元数据 —— 页面与审计据此回答「谁批的 / 是否已撤回 / 何时到期」。
      // 撤回行**照常返回**（不过滤）：零 DELETE 原则下，撤回的行是审计证据，不能在列表里"消失"；
      // 是否生效由 status 字段表达（前端灰显），而"是否参与判定"由 computeBusinessTier 的过滤决定。
      const r = await query(
        `SELECT dimension, dimension_value, tier,
                approved_by, approved_at, decision_id, expires_at, revoked_at, revoked_reason
           FROM crm.business_tier_config WHERE tenant_id=$1 ORDER BY dimension, dimension_value`,
        [tid]
      );
      rows = r.rows;
      if (!rows.length) {
        await ensureTenantBusinessTiers(tid); // 懒克隆 system 模板
        const r2 = await query(
          `SELECT dimension, dimension_value, tier,
                  approved_by, approved_at, decision_id, expires_at, revoked_at, revoked_reason
             FROM crm.business_tier_config WHERE tenant_id=$1 ORDER BY dimension, dimension_value`,
          [tid]
        );
        rows = r2.rows;
      }
    }
    return rows;
  },
  upsertTier: async (dimension, dimension_value, tier, actor, opts = {}) => {
    const tid = scopeOf(actor);
    // A2（2026-09-16）：授权元数据随写落库 —— 修 D2「决策产生了但只回显不落库」的溯源断链。
    //   approved_by 取 username（唯一稳定标识），不取 display_name（可重名/可改，作审计主体不稳）。
    // 「重新保存 = 再批准一次」：同时清空 revoked_at/revoked_reason（复活）——不这样做，
    //   撤回过的规则就只能删行重建才能恢复，与"绝对禁 DELETE"红线直接冲突。
    const approvedBy = actorLabel(actor);
    const r = await query(
      `INSERT INTO crm.business_tier_config
         (tenant_id, dimension, dimension_value, tier,
          approved_by, approved_at, decision_id, expires_at, revoked_at, revoked_reason)
       VALUES ($1, $2, $3, $4, $5, now(), $6, $7, NULL, NULL)
       ON CONFLICT (tenant_id, dimension, dimension_value) DO UPDATE
         SET tier=$4, approved_by=$5, approved_at=now(), decision_id=$6, expires_at=$7,
             revoked_at=NULL, revoked_reason=NULL
       RETURNING tenant_id, dimension, dimension_value, tier,
                 approved_by, approved_at, decision_id, expires_at, revoked_at, revoked_reason`,
      [tid, dimension, dimension_value, tier, approvedBy, opts.decisionId || null, opts.expiresAt || null]
    );
    // A3（方案 i）：写后镜像，fail-closed —— 镜像失败直接抛，让本次 PUT 失败。
    // 取舍：宁可"这次没改成"（用户可重试），也不要"改成了但决策冻结依据仍是旧的"
    //   （后者是静默断链：版本照常解析、决策照常落库，巡检也看不出来）。
    const mirrorCount = await mirrorBusinessTierConfig(tid, opts.decisionId || null);
    return { ...r.rows[0], mirror_count: mirrorCount };
  },
  // A4 撤回（2026-09-16）：**状态变更，零 DELETE**。
  // 效果：该规则不再参与 computeBusinessTier 判定 → 此取值回退 scenario.default_tier。
  // 注意方向性：撤回一条 `C→LEAD` 会让 C 类项目失去"低风险"依据而回退到 default_tier，
  //   即**收紧**自主边界（安全的失败方向）；撤回一条 `STRATEGIC→HIGH` 则相反 → 收紧/放松
  //   取决于被撤回规则本身，故撤回必须走第 0 闸并在决策链留痕（不做静默 UPDATE）。
  // ⚠ 刻意**不覆盖 decision_id**：它记的是"谁批准了这条分级"，是更重要的溯源；
  //   用撤回凭据覆盖它 = 用次要溯源换掉主要溯源。撤回动作的凭据在 crm.decision
  //   （config-change 场景，trigger_context 含 dimension/dimension_value/reason + 时间窗）可反查。
  revokeTier: async (dimension, dimension_value, reason, actor, opts = {}) => {
    const tid = scopeOf(actor);
    const r = await query(
      `UPDATE crm.business_tier_config
          SET revoked_at = now(), revoked_reason = $4
        WHERE tenant_id=$1 AND dimension=$2 AND dimension_value=$3 AND revoked_at IS NULL
        RETURNING tenant_id, dimension, dimension_value, tier,
                  approved_by, approved_at, decision_id, expires_at, revoked_at, revoked_reason`,
      [tid, dimension, dimension_value, reason || null]
    );
    // 幂等：不存在或已撤回 → null（由调用方决定 404 还是静默成功，不在这里猜）
    if (!r.rows[0]) return null;
    const mirrorCount = await mirrorBusinessTierConfig(tid, opts.decisionId || null);
    return { ...r.rows[0], mirror_count: mirrorCount };
  },
  // 第0闸：配置写一律需决策（无决策降级为记录事件，不硬抛）
  produceDecision: async (ctx) => {
    try {
      const r = await requireDecision('config-change', ctx || {});
      const did = decisionIdOf(r);
      return { decisionId: did, ok: !!did };
    } catch {
      await recordDecisionEvent('config_change', { trigger_context: ctx });
      return { decisionId: null, ok: true };
    }
  },
};

// 真实实现的直连入口（供集成测试调用，不经 HTTP）。
// 为什么导出：集成测试若自己重写一遍 SQL 去"模拟"写入，测的就是测试自己的 SQL，
// 而真实 SQL 写错列名/漏列照样全绿——这是最典型的假绿。导出后测试打的是生产代码路径。
export const businessTierRepo = defaultDeps;

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
        const { dimension, dimension_value, tier, expires_at: expiresAt } = req.body || {};
        if (!dimension || !dimension_value || !tier) {
          return res.status(400).json({ error: 'dimension / dimension_value / tier 必填' });
        }
        if (!VALID_DIMENSIONS.includes(dimension)) {
          return res.status(400).json({ error: `dimension 必须为 ${VALID_DIMENSIONS.join(' / ')}` });
        }
        if (!VALID_TIERS.includes(tier)) {
          return res.status(400).json({ error: `tier 必须为 ${VALID_TIERS.join(' / ')}` });
        }
        // expires_at 可选；给了必须是合法时间 —— 否则会静默存成 Invalid Date，让该规则
        // "永远不过期"（比较恒 false），属只在到期日才暴露的隐形错误。
        if (expiresAt != null && expiresAt !== '' && Number.isNaN(new Date(expiresAt).getTime())) {
          return res.status(400).json({ error: 'expires_at 必须是合法时间（如 2026-12-31T00:00:00Z）' });
        }
        // 写第0闸：无决策不写
        const decision = await D.produceDecision({ dimension, dimension_value, tier });
        // 第 0 闸凭据同时传给镜像（A3）：镜像写入本身也带 decision_id，可溯源
        const row = await D.upsertTier(dimension, dimension_value, tier, me, {
          decisionId: decision?.decisionId || null,
          expiresAt: expiresAt || null,
        });
        res.json({ ok: true, row, decision: decision?.decisionId || null });
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    },
    // A4 撤回：状态变更（零 DELETE）。走与写入同一第 0 闸 ——
    // 撤回改的是"AI 自主边界"，不是普通配置，不能有"无凭据的撤回"。
    revoke: async (req, res) => {
      try {
        const me = resolveMe(req);
        const { dimension, dimension_value, reason } = req.body || {};
        if (!dimension || !dimension_value) {
          return res.status(400).json({ error: 'dimension / dimension_value 必填' });
        }
        if (!VALID_DIMENSIONS.includes(dimension)) {
          return res.status(400).json({ error: `dimension 必须为 ${VALID_DIMENSIONS.join(' / ')}` });
        }
        const decision = await D.produceDecision({
          dimension, dimension_value, action: 'revoke', reason: reason || null,
        });
        const row = await D.revokeTier(dimension, dimension_value, reason, me, {
          decisionId: decision?.decisionId || null,
        });
        if (!row) return res.status(404).json({ error: '规则不存在或已撤回' });
        res.json({ ok: true, row, decision: decision?.decisionId || null });
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    },
  };

  router.get('/api/business-tier-config', handlers.get);
  router.put('/api/business-tier-config', handlers.put);
  router.post('/api/business-tier-config/revoke', handlers.revoke);
  router.handlers = handlers; // 注入式测试
  return router;
}
