// src/signal/activityDerivation.js — 内部可观测客户异动派生（设计 docs/2026-09-16-internal-signal-derivation-design.md §3.1）
//
// 立论：用户主张「可以筛选新客户，比如新战略、高层变动、人员招聘」此前只有一条**权重配置**
//   （src/config/discoveryRules.js:35 的 leadership_change），全仓无任何适配器产出该字段 —— 典型
//   「配置承诺 ≠ 实现」。本模块把该主张收敛为**内部可观测、可证伪**的两类信号。
//
// 数据面实测（2026-09-16，本地 crm_native）与据此的两处**口径收敛**（必须保留本注释）：
//   ① 「招聘 / 新战略」在本平台**零数据源**（无 HR、无战略情报面）⇒ 本模块**不产出**这两个字段。
//      绝不写"看起来在跑"的桩映射（P0 刚清掉的假绿形态）。
//   ② `decision_relation`（125 行：REFERENCED_PRECEDENT 71 / DECIDED_ON 49 / OVERRIDES / CAUSED…）
//      语义是「我方某决策作用于某实体」= 平台内部决策网，**不是**客户组织人事 ⇒ **不可**用作
//      「关键人变动」代理。据此派生等于新造一个桩，故排除。
//   ③ `relation_cooling` 原设计含「且无近期互动」。实测 `src/particles/interactionIndex.js` 声明的
//      email/calendar/call/meeting 枚举**全仓零外部消费者**（孤儿模块）、DB 侧亦无互动流水表
//      ⇒ 本批**只用粒子 updated_at 停滞**近似，并以此作为该信号的语义边界（不宣称"互动缺失"）。
//   ④ 【2026-09-17 修复】上述 `updated_at` 的**权威源是表列**，不是 payload 键。原实现读
//      `entity.payload.updated_at` 且 SQL 未取该列 ⇒ 真库 ACCOUNT 38 行 `payload ? 'updated_at'` = 0，
//      `relation_cooling` **结构性永零命中**（模块已接线、单测全绿、生产零产出＝典型假绿）。
//      真凭：schema.sql:24 `updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`；主业务写
//      `updateParticle`（particleRepo.js:249）每次 `SET …, updated_at=now()`；`mintId.js:62` upsert 同步刷新。
//      修复＝判定源**单一化**为列（不做 payload 回退，避免双源解释权），并让测试替身按 SQL 的
//      SELECT 列表投影返回行——漏取列即复现缺陷，使该缺陷无法再被"替身形状"掩盖。
//
// 铁律：
//   A. 派生信号必须自带来源与置信语义（source='derived'、payload.confidence_basis='internal_inference'），
//      且不得与实测情报同权（权重低于实测来源，见 discoveryRules.coverage 与守卫测试）。
//   B. 阈值/窗口/启停 100% 配置化（config_store['internal-signal-derivation']），零代码字面量。
//   C. fail-closed：读不到配置 / 实体缺失 → 不产出，并在返回值 missing[] 中显式归因（不静默、不造假）。
//   D. 零 DELETE；dedup_key 与 idx_signal_dedup 的部分索引谓词配合（同 (tenant_id,dedup_key) 未关闭唯一）。
import { readConfig as defaultRead } from '../config/configStore.js';

export function createActivityDerivation({ query, signalStore, readConfig = defaultRead } = {}) {
  // 桶键：决定「多久算一次新的异动提醒」。同日/同周/同月内重复派生 → 键相同 → 由 store.create 幂等吸收。
  function bucketKey(now = Date.now(), bucket = 'day') {
    const d = new Date(now);
    const p = (n) => String(n).padStart(2, '0');
    if (bucket === 'month') return `${d.getFullYear()}-${p(d.getMonth() + 1)}`;
    if (bucket === 'week') {
      const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
      const day = t.getUTCDay() || 7;
      t.setUTCDate(t.getUTCDate() + 4 - day);
      const yStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
      return `${t.getUTCFullYear()}-W${p(Math.ceil(((t - yStart) / 86400000 + 1) / 7))}`;
    }
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  // 单实体命中评估（纯函数，可单测）：
  //   window_days  —— 近 N 天内**发生过变动**（= 近期变动）
  //   threshold_days —— 已停滞**超过 N 天**（= 冷却）
  //   两者语义相反，故必须由规则显式声明、互斥判定；缺字段一律不命中（不把"未知时间"当"刚更新"）。
  function hitsRule(rule, entity, now = Date.now()) {
    // 时间戳源＝**列** `updated_at`（单一权威源，2026-09-17 修复）：不读 payload，也不做 payload
    //   回退——双源会重新制造"同一字段两处解释权"（判据⑥），并把本文件头注 ④ 的结构缺陷掩盖回去。
    const ts = entity?.updated_at;
    if (!ts) return false;
    const t = new Date(ts).getTime();
    if (Number.isNaN(t)) return false;
    const ageDays = (now - t) / 86400000;
    if (rule.window_days != null) return ageDays <= Number(rule.window_days);
    if (rule.threshold_days != null) return ageDays > Number(rule.threshold_days);
    return false;   // 两条都没声明 → 规则不完整，不命中（不猜测语义）
  }

  async function loadConfig(tenantId) {
    try {
      const row = await readConfig('internal-signal-derivation', { tenantId });
      return row?.value || null;
    } catch {
      return null;
    }
  }

  // 责任人解析（2026-09-17 个人隔离延伸）：
  //   派生信号锚定的实体未必自带 owner（典型：CRM_CONTACT 挂在 CRM_ACCOUNT 下，责任人记在**父账户**）。
  //   原实现只读 `entity.payload.owner_id` ⇒ 这类信号 owner_id 恒为 NULL ⇒ 经 store.list 的
  //   ownerScope 谓词（owner_id IS NULL AND target_role=…）**广播给同租户全体销售**——
  //   这正是用户实测「没有完全按照销售员进行隔离」的第四处来源（真库 12 条 contact_change 全无主）。
  //   铁律 B（配置化）：父链接键由规则声明 owner_via，缺省 'account_id'；不做类型硬分支。
  //   fail-closed：父缺失 / 父无主 → null（回退按角色广播），不猜测、不伪造责任人。
  const DEFAULT_OWNER_VIA = 'account_id';

  // 批量解析：只对「无直接 owner 且有父链接」的实体一次性补齐父表（每租户每规则最多 1 次查询）。
  async function buildOwnerResolver({ query, tenantId, entities, viaKey, cache }) {
    const missing = [];
    for (const e of entities) {
      if (e?.payload?.owner_id) continue;
      const pid = e?.payload?.[viaKey];
      if (pid) missing.push(String(pid));
    }
    const todo = [...new Set(missing)].filter((id) => !cache.has(id));
    if (todo.length && query) {
      const { rows } = await query(
        `SELECT id::text AS id, payload FROM crm.particles WHERE tenant_id=$1 AND id::text = ANY($2::text[])`,
        [tenantId, todo],
      ).catch(() => ({ rows: [] }));
      for (const p of rows) cache.set(String(p.id), p?.payload?.owner_id || null);
      for (const id of todo) if (!cache.has(id)) cache.set(id, null);   // 父不存在亦留痕，避免重复查
    }
    return (entity) => {
      const direct = entity?.payload?.owner_id || null;
      if (direct) return direct;                                       // 直接责任人优先
      const pid = entity?.payload?.[viaKey];
      return pid ? (cache.get(String(pid)) || null) : null;
    };
  }

  async function deriveOnce({ tenantId = 'system', now = Date.now() } = {}) {
    const cfg = await loadConfig(tenantId);
    const missing = [];
    if (!cfg || typeof cfg !== 'object') {
      return { scanned: 0, signals: 0, deduped: 0, missing: [{ reason: 'config_missing' }] };
    }
    if (cfg.enabled === false) return { scanned: 0, signals: 0, deduped: 0, missing: [] };
    const rules = Array.isArray(cfg.rules) ? cfg.rules.filter((r) => r.enabled !== false) : [];
    if (!rules.length) return { scanned: 0, signals: 0, deduped: 0, missing: [{ reason: 'no_rules' }] };

    let scanned = 0, signals = 0, deduped = 0;
    const cache = new Map();   // 父 id → owner（跨规则复用，同租户内同一父只查一次）
    for (const rule of rules) {
      if (!rule.entity_type) { missing.push({ rule_id: rule.id, reason: 'entity_type_required' }); continue; }
      const { rows } = await query(
        // ⚠ 必取 updated_at **列**（2026-09-17 修复）：payload 内从无该键（真库 ACCOUNT 38 行 payload?updated_at=0），
        //   权威时间戳是列（schema.sql:24；updateParticle/particleRepo.js:249 每次业务写刷新）。漏取该列 ⇒ 永久零命中。
        `SELECT id, tenant_id, payload, updated_at FROM crm.particles WHERE type=$1 AND tenant_id=$2`,
        [rule.entity_type, tenantId],
      ).catch(() => ({ rows: [] }));
      scanned += rows.length;
      let hit = 0;
      const ownerOf = await buildOwnerResolver({
        query, tenantId, entities: rows, cache, viaKey: rule.owner_via || DEFAULT_OWNER_VIA,
      });
      for (const entity of rows) {
        if (!hitsRule(rule, entity, now)) continue;
        hit += 1;
        const r = await signalStore.create({
          tenant_id: tenantId,
          source: 'derived',                                  // 铁律 A：来源可辨（低置信，不与实测情报同权）
          kind: rule.kind,
          severity: rule.severity || 'low',
          target_role: rule.target_role || 'sales',
          // 责任人：自身 → 父实体（经 owner_via，默认 account_id）→ null（回退按角色广播）
          owner_id: ownerOf(entity),
          particle_id: entity.id,
          payload: {
            subject: `${rule.kind}（内部推断）`,
            rule_id: rule.id,
            confidence_basis: 'internal_inference',           // 铁律 A：置信依据显式落 payload
            entity_type: rule.entity_type,
          },
          evidence: {
            rule_id: rule.id,
            window_days: rule.window_days ?? null,
            threshold_days: rule.threshold_days ?? null,
            updated_at: entity.updated_at || null,            // 证据链与判定同源（列），不留 payload 口子
          },
          dedup_key: `derived:${rule.id}:${entity.id}:${bucketKey(now, rule.bucket)}`,
        });
        if (r?.ok) { signals += 1; if (r.deduped) deduped += 1; }
      }
      // 铁律 C：规则就绪但零命中 → 显式归因（真库数据面缺失时不得静默）
      if (hit === 0) missing.push({ rule_id: rule.id, reason: 'zero_hit', scanned: rows.length });
    }
    return { scanned, signals, deduped, missing };
  }

  // 全部租户：单租户失败不中断其余（失败项收集返回，由调用方 emit trace）
  // ⚠ 【2026-09-17 修复 · 结构性永零命中】原实现按
  //     `SELECT DISTINCT tenant_id FROM crm.config_store WHERE key='internal-signal-derivation'`
  //   枚举租户 ⇒ **新租户永远不会被扫描**：autoSeed 是「只读触发」的懒克隆
  //   （configStore.js:12「读：先查 (tenantId,key)；缺 → 从 (system,key) 模板 autoSeed 落租户」），
  //   而唯一会去读该键的消费方**正是本扫描器本身** ⇒ 循环依赖：租户要先有键才会被扫，
  //   而键又要靠被扫（读配置）才 autoSeed 出来。与 `payload.updated_at`（本文件头注 ④）同族。
  //   真凭·设计文档 2026-09-16-internal-signal-derivation-design.md §验收：
  //     「配置就位 | count(*) FROM config_store WHERE key='internal-signal-derivation' | **1**
  //       （system 模板，经 readConfig autoSeed 覆盖租户）」——即设计意图是
  //       「扫全活跃租户 → 读配置时 autoSeed 落键」，**不是**「键先存在才扫」。
  //   修法：与兄弟扫描器 T15 `signal-schedule-scan`（timers.js:598-601 用
  //     tenantRepo.listActiveTenants()）统一枚举源；可经 `tenants` 显式注入（测试/复用）。
  //   枚举来源写入返回值 tenant_source（不静默：能区分「扫了没人」与「根本没扫到人」）。
  async function resolveTenantIds(explicit) {
    if (Array.isArray(explicit) && explicit.length) {
      return { ids: explicit.map((t) => (typeof t === 'string' ? t : t?.tenant_id)).filter(Boolean), source: 'injected' };
    }
    const m = await import('../tenant/tenantRepo.js').catch(() => ({ listActiveTenants: null }));
    const rows = m.listActiveTenants ? await m.listActiveTenants().catch(() => []) : [];
    const ids = (rows || []).map((r) => r?.tenant_id).filter(Boolean);
    // fail-safe：租户表不可用时至少扫平台模板租户（宁可少扫，不可把「枚举失败」伪装成「无信号」）
    return ids.length ? { ids, source: 'active_tenants' } : { ids: ['system'], source: 'fallback_system' };
  }

  async function deriveAllTenants({ now = Date.now(), tenants = null } = {}) {
    const { ids, source } = await resolveTenantIds(tenants);
    const totals = { tenants: ids.length, tenant_source: source, signals: 0, deduped: 0, missing: [], failures: [] };
    for (const tenant_id of ids) {
      try {
        const r = await deriveOnce({ tenantId: tenant_id, now });
        totals.signals += r.signals;
        totals.deduped += r.deduped;
        for (const m of r.missing) totals.missing.push({ tenant_id, ...m });
      } catch (e) {
        totals.failures.push({ tenant_id, error: String(e?.message || e) });
      }
    }
    return totals;
  }

  return { deriveOnce, deriveAllTenants, hitsRule, bucketKey, buildOwnerResolver };
}
