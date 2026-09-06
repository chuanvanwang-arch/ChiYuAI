// src/decision/traceRootCause.js — 全链路溯源（T25，设计：full-traceability-root-cause-design.md §1）
// 溯源链：J 决策脊柱 → M 记忆系统 → K 知识系统 → 粒子库（crm.particles 行）
// 纯核心 inspectParticlePayload() 可单测（无需 PG）；traceRootCause() 经注入 query 组装四层链。
//
// 命名体系：K 知识系统 / M 记忆系统（L1–L7 维度 + E1–E7 边）/ J 决策脊柱（J1–J3）
// ④ 跳三检：字段不一致(FIELD_MISMATCH) / 信息不完整(INFO_INCOMPLETE) / 输入不及时(INPUT_STALE)

import { query as defaultQuery } from '../db.js';
import { computeEdgeCompliance } from '../monitor/attribution.js';
import { computeParticleStableKey } from '../particles/mintId.js';

// 规范化字段名：小写 + 去非字母数字，使 cust_no / customer_no 可区分、customer_no / customer_no 视为一致
const norm = (k) => String(k == null ? '' : k).toLowerCase().replace(/[^a-z0-9]/g, '');

// PostgreSQL interval → 毫秒（支持 node-pg 的 Interval 对象 / '24 hours' / '1h' / '1 day 02:00:00' / '24:00:00' / 数字）
export function intervalToMs(v) {
  if (v == null) return null;
  // node-pg 解析 INTERVAL 为对象：{ years, months, days, hours, minutes, seconds, milliseconds }
  if (typeof v === 'object') {
    const any = (v.days || v.hours || v.minutes || v.seconds || v.milliseconds || v.weeks || v.years || v.months);
    if (!any) return null;
    const ms = ((v.weeks || 0) * 7 * 86400 + (v.days || 0) * 86400 + (v.hours || 0) * 3600 + (v.minutes || 0) * 60 + (v.seconds || 0)) * 1000 + (v.milliseconds || 0);
    return ms;
  }
  if (typeof v === 'number') return v;
  const s = String(v).trim().toLowerCase();
  let total = 0;
  let matched = false;
  const d = s.match(/([\d.]+)\s*day/); if (d) { total += parseFloat(d[1]) * 86400_000; matched = true; }
  const hms = s.match(/(\d+):(\d+):(\d+)/); if (hms) { total += (+hms[1] * 3600 + +hms[2] * 60 + +hms[3]) * 1000; matched = true; }
  const h = s.match(/([\d.]+)\s*h/); if (h) { total += parseFloat(h[1]) * 3600_000; matched = true; }
  const m = s.match(/([\d.]+)\s*mi?n/); if (m) { total += parseFloat(m[1]) * 60_000; matched = true; }
  return matched ? total : null;
}

function maxSlaMs(metaAttrs) {
  let max = null;
  for (const m of (metaAttrs || [])) {
    const ms = intervalToMs(m.source_refresh_sla);
    if (ms == null) continue;
    max = max == null ? ms : Math.max(max, ms);
  }
  return max;
}

// ④ 跳三检（纯函数）：对单个粒子的 payload 与 meta_attr 做字段级 diff
// 入参：{ payload, metaAttrs, decidedAtMs, particleUpdatedAtMs, fallbackStaleMs }
//   metaAttrs: [{ attr_slug, required, enabled, source_refresh_sla }]
//   fallbackStaleMs: T32 root_cause_thresholds.default_input_stale_ms——meta_attr 无 SLA 时的全局兜底时效
// 返回：{ field_mismatch, info_incomplete, input_stale, orphanFields[], missingRequired[] }
export function inspectParticlePayload({ payload = {}, metaAttrs = [], decidedAtMs = null, particleUpdatedAtMs = null, fallbackStaleMs = null } = {}) {
  const pKeys = Object.keys(payload || {});
  const pNorm = new Set(pKeys.map(norm));
  const enabled = (metaAttrs || []).filter((m) => m.enabled !== false);
  const mNorm = new Set(enabled.map((m) => norm(m.attr_slug)));

  // 字段不一致：payload 存在但 meta 未定义的孤儿字段（命名错配，如 cust_no vs customer_no）
  const orphanFields = pKeys.filter((k) => !mNorm.has(norm(k)));
  const field_mismatch = orphanFields.length > 0;

  // 信息不完整：enabled 且 required 的 meta 在 payload 缺失或为空
  const missingRequired = enabled.filter((m) => {
    const v = payload[m.attr_slug];
    return m.required && (v === undefined || v === null || v === '');
  });
  const info_incomplete = missingRequired.length > 0;

// 输入不及时：粒子更新时间距决策时间超过该类型配置的最大 sla（T32：无 SLA 时用 root_cause_thresholds 兜底）
    let input_stale = false;
    if (decidedAtMs != null && particleUpdatedAtMs != null) {
      const slaMs = maxSlaMs(metaAttrs);
      // T32：meta_attr 无 source_refresh_sla → 用全局兜底 default_input_stale_ms（缺省 null 保持旧行为：不判 stale）
      const effectiveSlaMs = slaMs != null ? slaMs : fallbackStaleMs;
      if (effectiveSlaMs != null && (decidedAtMs - particleUpdatedAtMs) > effectiveSlaMs) input_stale = true;
    }

  return {
    field_mismatch,
    info_incomplete,
    input_stale,
    orphanFields,
    missingRequired: missingRequired.map((m) => m.attr_slug),
  };
}

// 装配四层溯源链（DB 版）
// 返回：{ decision_id, layer_j, layer_m, layer_k, particle_checks }
//   layer_j: { attribution, human_disposition, outcome_verified, decided_at }
//   layer_m: { edges:[{rel_type,serves_dimension,props}], edge_count }
//   layer_k: { involved_entities, particles:[{id,type,missing?,checks?}] }
//   particle_checks: { field_mismatch, info_incomplete, input_stale }（任一粒子命中即 true）
export async function traceRootCause(decisionId, { query: q = defaultQuery } = {}) {
  if (!decisionId) return null;

  // ① J→M：决策 + 写时物化归因（tenant_id 一并回查——T5 租户化：溯源有决策上下文，按决策租户读配置）
  const dRes = await q(
    `SELECT decision_id, scenario_id, attribution, involved_entities, decided_at, human_disposition, outcome_verified, tenant_id
     FROM crm.decision WHERE decision_id=$1`,
    [decisionId]
  );
  const d = dRes.rows[0];
  if (!d) return null;

  // T32：读归因阈值兜底（config_store['seven-dim'].root_cause_thresholds；查不到回退默认 24h）
  // 租户化（T5，P1）：按决策租户读（租户优先回退 system）；dRes 已回查 d.tenant_id，无需二次查询
  let staleFallbackMs = null;
  const traceTenantId = d.tenant_id || 'system';
  try {
    const thr = await q(
      `SELECT value FROM crm.config_store WHERE key=$1 AND (tenant_id=$2 OR tenant_id='system') ORDER BY (tenant_id=$2) DESC LIMIT 1`,
      ['seven-dim', traceTenantId]
    );
    const v = thr?.rows?.[0]?.value?.root_cause_thresholds;
    if (v && typeof v === 'object' && typeof v.default_input_stale_ms === 'number') staleFallbackMs = v.default_input_stale_ms;
  } catch { /* 配置缺失不阻断溯源（fail-safe） */ }

  const attribution = d.attribution || {};
  const decidedAtMs = d.decided_at ? new Date(d.decided_at).getTime() : null;

  // T29-b：读取场景 required_dims（7×7 交叉校验依据）——「应连边 = 服务必填维的边」
  //   fail-safe：场景不存在/读失败 → 空必填维 → known=false（不臆断 E 缺）
  let reqDims = [];
  try {
    const sRes = await q(`SELECT required_dims FROM crm.decision_scenario WHERE scenario_id=$1`, [d.scenario_id]);
    reqDims = sRes.rows[0]?.required_dims || [];
    if (!Array.isArray(reqDims)) reqDims = [];
  } catch { reqDims = []; }

  // M：七边快照（decision_relation，T2 落地后为 7 类边权威表）
  const relRes = await q(
    `SELECT rel_type, serves_dimension, props FROM crm.decision_relation WHERE from_id::text=$1::text`,
    [decisionId]
  );
  const edges = (relRes.rows || []).map((r) => ({
    rel_type: r.rel_type,
    serves_dimension: r.serves_dimension,
    props: r.props,
  }));

  // T29/T29-b：E1-E7 边合规（应存/实存/缺）——requiredDims 推导应连边，EDGE_MISSING 判定真正可触发
  const edge_compliance = computeEdgeCompliance(edges.map((e) => e.rel_type), { requiredDims: reqDims });

  // ② M→K：involved_entities → 粒子 id 列表
  const ents = Array.isArray(d.involved_entities) ? d.involved_entities : [];
  const particleIds = ents.filter((e) => e && e.id).map((e) => e.id);

  // ③ K 内部 + ④ K→粒子库：逐粒子做字段级三检
  const particles = [];
  for (const pid of particleIds) {
    const pRes = await q(`SELECT id, type, slug, tenant_id, payload, updated_at FROM crm.particles WHERE id=$1`, [pid]);
    const p = pRes.rows[0];
    if (!p) { particles.push({ id: pid, missing: true }); continue; }
    const maRes = await q(`SELECT attr_slug, required, enabled, source_refresh_sla FROM crm.meta_attr WHERE particle_type=$1`, [p.type]);
    const pUpdatedMs = p.updated_at ? new Date(p.updated_at).getTime() : null;
    const checks = inspectParticlePayload({
      payload: p.payload || {},
      metaAttrs: maRes.rows || [],
      decidedAtMs,
      particleUpdatedAtMs: pUpdatedMs,
      fallbackStaleMs: staleFallbackMs,
    });
    // 6.7 确定性标识：同一事实跨运行同标识，溯源链不再因 UUID 随机而断裂
    const stable_key = p.stable_key || computeParticleStableKey(p.type, p.slug, p.tenant_id || 'system');
    particles.push({ id: p.id, type: p.type, slug: p.slug, stable_key, checks });
  }

  const particle_checks = {
    field_mismatch: particles.some((p) => p.checks && p.checks.field_mismatch),
    info_incomplete: particles.some((p) => p.checks && p.checks.info_incomplete),
    input_stale: particles.some((p) => p.checks && p.checks.input_stale),
  };

  return {
    decision_id: decisionId,
    layer_j: {
      attribution,
      human_disposition: d.human_disposition,
      outcome_verified: d.outcome_verified,
      decided_at: d.decided_at,
    },
    layer_m: { edges, edge_count: edges.length, edge_compliance },
    layer_k: { involved_entities: ents, particles },
    particle_checks,
    edge_compliance,
  };
}
