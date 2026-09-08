// src/particles/dedup.js — P5 实体去重/解析：别名合并 + 确认闭环（软合并，不物理删）
// 设计输入：docs/superpowers/specs/2026-08-26-age-semantica-program-design.md P5
// 语义：同实体多名称（全称/简称/历史名）归一到 canonical id；确认用软合并（meta.merged_into），保留溯源。
// 2026-09-08 追加：客户去重系统（docs/plans/2026-09-07-crm-dedup.md 任务1/3）——
//   创建闸查重（detectAccountDuplicate）+ 归并执行器（mergeIntoExisting/mergeTwoAccounts）+ 存量批处理支撑。
import { query, queryWrite } from '../db.js';

// 幂等：particles.meta 列（与 db/migration-particle-meta.sql 一致）+ dedup_audit 表（db/schema.sql 单一事实源）
export async function ensureDedupSchema() {
  await queryWrite(`ALTER TABLE crm.particles ADD COLUMN IF NOT EXISTS meta JSONB NOT NULL DEFAULT '{}'::jsonb`).catch(() => {});
  await queryWrite(
    `CREATE TABLE IF NOT EXISTS crm.dedup_audit (
       id BIGSERIAL PRIMARY KEY,
       tenant_id TEXT NOT NULL DEFAULT 'system',
       report JSONB NOT NULL DEFAULT '{}'::jsonb,
       created_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`).catch(() => {});
}

// 合并候选：① 显式 alias_of ② 已确认 auto_weak 边 ③ 同域名（退化）
export async function suggestMerge(particleId) {
  const p = (await query(`SELECT payload, meta FROM crm.particles WHERE id=$1`, [particleId])).rows[0];
  if (!p) return { candidateId: null };
  if (p?.payload?.alias_of) return { candidateId: String(p.payload.alias_of) };
  const w = await query(
    `SELECT target_id FROM crm.edges
     WHERE source_id=$1 AND edge_type='auto_weak' AND meta->>'confirmed'='true' LIMIT 1`,
    [particleId]);
  if (w.rows[0]) return { candidateId: w.rows[0].target_id };
  const dom = p?.payload?.domains?.[0];
  if (dom) {
    const c = await query(
      `SELECT id FROM crm.particles WHERE type='CRM_ACCOUNT'
       AND payload->'domains' ? $1 AND id<>$2 LIMIT 1`, [dom, particleId]);
    if (c.rows[0]) return { candidateId: c.rows[0].id };
  }
  return { candidateId: null };
}

// 确认合并（软合并：标记 merged_into，不物理删除；保留双源溯源）
export async function confirmMerge(particleId, canonicalId) {
  await ensureDedupSchema();
  await queryWrite(
    `UPDATE crm.particles SET meta = COALESCE(meta,'{}') || jsonb_build_object('merged_into',$1::text) WHERE id=$2`,
    [String(canonicalId), particleId]);
  return { ok: true, mergedInto: canonicalId };
}

// ─── 客户去重系统（2026-09-08 任务1 · 检测服务）───────────────────────────
// 设计：docs/plans/2026-09-07-crm-dedup.md 任务1
// 创建闸主判据：归一化精确相等 + 行业相同（或无行业约束）→ MERGE
//   复合门槛②（模糊≥0.9 + 联系人/电话重叠）在存量批处理经 detectAccountDuplicateDeep 触发
import { normalizeAccountName } from '../sales/accountGuard.js';
import { getParticle, updateParticle } from './particleRepo.js';
import { recordAudit } from '../action/auditHook.js';

const FUZZY_MERGE = 0.9;   // 高置信（存量批处理，需配合联系人重叠）
const FUZZY_PROMPT = 0.6;  // 低置信阈值（仅提示，不静默归并）

// 编辑距离（DP）
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => Array(n + 1).fill(0));
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    dp[i][0] = i;
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[m][n];
}
function similarity(a, b) {
  const s1 = normalizeAccountName(a), s2 = normalizeAccountName(b);
  if (!s1 || !s2) return 0;
  if (s1 === s2) return 1;
  const max = Math.max(s1.length, s2.length) || 1;
  return 1 - levenshtein(s1, s2) / max;
}

// 创建闸主判据：归一化精确相等 + 行业相同（或无行业约束）→ MERGE
//   composite ②（模糊+联系人）在 backfill 场景经 hasContactOverlap 触发
export async function detectAccountDuplicate(name, industry, tenantId = 'system') {
  const nn = normalizeAccountName(name);
  if (!nn) return { decision: 'CREATE', candidateId: null };
  const rows = (await query(
    `SELECT id, payload FROM crm.particles
     WHERE tenant_id=$1 AND type='CRM_ACCOUNT'
       AND (meta->>'merged_into') IS NULL`,
    [tenantId]
  )).rows;
  let best = null, bestSim = 0;
  for (const r of rows) {
    const p = r.payload || {};
    if (p.name && normalizeAccountName(p.name) === nn) {
      // 归一精确相等：行业相同或无行业约束 → 高置信 MERGE
      if (!industry || !p.industry || p.industry === industry) {
        return { decision: 'MERGE', candidateId: r.id, reason: 'exact_name+industry' };
      }
      best = best || { id: r.id, sim: 1, p }; // 同名但行业不同：不直接判 MERGE，留给模糊兜底
    }
    const sim = similarity(name, p.name || '');
    if (sim > bestSim) { bestSim = sim; best = { id: r.id, sim, p }; }
  }
  // 低置信：仅模糊相似（≥PROMPT 且非精确）→ PROMPT（降级提示，不静默归并）
  if (best && bestSim >= FUZZY_PROMPT) {
    return { decision: 'PROMPT', candidateId: best.id, similarity: Number(bestSim.toFixed(3)) };
  }
  return { decision: 'CREATE', candidateId: null };
}

// 存量批处理用：模糊≥0.9 + 任意联系人/电话重叠 → MERGE
export async function detectAccountDuplicateDeep(name, industry, tenantId = 'system') {
  const base = await detectAccountDuplicate(name, industry, tenantId);
  if (base.decision !== 'PROMPT' || !base.candidateId) return base;
  const cand = await getParticle(base.candidateId);
  const candPayload = cand?.payload || {};
  const overlap = hasContactOverlap(industry, candPayload);
  if (base.similarity >= FUZZY_MERGE && overlap) {
    return { decision: 'MERGE', candidateId: base.candidateId, reason: 'fuzzy+contact' };
  }
  return base; // 仍 PROMPT
}

function hasContactOverlap(incomingContact, candPayload) {
  // incomingContact: 创建时可为空（用于 PROMPT 场景）；存量为 {phone, contacts:[...]}
  const aPhones = collectPhones(incomingContact);
  const bPhones = collectPhones(candPayload);
  if (aPhones.size && bPhones.size) {
    for (const p of aPhones) if (bPhones.has(p)) return true;
  }
  return false;
}
function collectPhones(obj) {
  const s = new Set();
  if (!obj) return s;
  if (obj.phone) s.add(String(obj.phone));
  for (const c of (obj.contacts || [])) if (c?.phone) s.add(String(c.phone));
  return s;
}

// ─── 客户去重系统（2026-09-08 任务3 · 归并执行器）───────────────────────────
// 字段级 merge + 软合并（confirmMerge）；不物理删，守禁删铁律
// 身份字段：主档已有值时禁止被从档覆盖
// 背景：从档常带 "(中试推进)" 之类后缀，若无保护会把主档名称污染成从档名（2026-09-08 实测）
const IDENTITY_KEYS = new Set(['name', 'id', 'slug', 'title', 'account_name']);

// 字段级并入：非空覆盖、数组追加去重、对象深合并
function mergePayloads(base, inc) {
  const out = { ...base };
  for (const [k, v] of Object.entries(inc || {})) {
    if (v === undefined || v === null) continue;
    if (k === 'possible_duplicate_of' || k === 'merged_into') continue; // 不回写查重标记
    if (IDENTITY_KEYS.has(k) && out[k] != null && out[k] !== '') continue; // 主档身份优先，仅在主档缺失时补齐
    if (Array.isArray(v) && Array.isArray(out[k])) out[k] = [...new Set([...out[k], ...v])];
    else if (v && typeof v === 'object' && out[k] && typeof out[k] === 'object') out[k] = { ...out[k], ...v };
    else out[k] = v;
  }
  return out;
}

// 静默归并（创建闸用）：不新建粒子，把 incoming 并入已有 candidate
export async function mergeIntoExisting(candidateId, incomingPayload, tenantId = 'system', actor = null) {
  const cur = await getParticle(candidateId);
  if (!cur) return null;
  const merged = mergePayloads(cur.payload, incomingPayload);
  const p = await updateParticle(candidateId, { patch: merged, tenantId });
  await recordAudit({
    target_particle_type: 'CRM_ACCOUNT', source: 'dedup', action: 'auto_merge',
    actor: actor || 'system', decision_id: null,
    payload: { target: candidateId, merged_keys: Object.keys(incomingPayload || {}) },
  }).catch(() => {});
  return p;
}

// 存量双账户归并：边迁移 + 字段并入 + 软合并标记（不物理删）
export async function mergeTwoAccounts(primaryId, secondaryId, tenantId = 'system') {
  // 0) 多租户硬闸：两侧必须同租户。
  // 背景：updateParticle 对 tenantId='system' 有跨租户豁免，若不校验会把 acme-chem 的客户
  // 静默并进 system 租户（实测库中存在同名不同租户的 M 涂料科技），属数据隔离事故。
  const [pRow, sRow] = await Promise.all([getParticle(primaryId), getParticle(secondaryId)]);
  if (!pRow || !sRow) throw new Error('mergeTwoAccounts: 粒子不存在');
  const pTenant = pRow.tenant_id || 'system';
  const sTenant = sRow.tenant_id || 'system';
  if (pTenant !== sTenant) {
    throw new Error(`cross_tenant_merge_denied: 主档属 ${pTenant}，从档属 ${sTenant}，禁止跨租户归并`);
  }
  if (tenantId && tenantId !== 'system' && pTenant !== tenantId) {
    throw new Error(`cross_tenant_merge_denied: 目标租户 ${pTenant} ≠ 调用方 ${tenantId}`);
  }
  // 1) 迁移受控边：source/target = secondary → primary
  await queryWrite(`UPDATE crm.edges SET source_id=$1 WHERE source_id=$2 AND tenant_id=$3`,
    [primaryId, secondaryId, tenantId]).catch(() => {});
  await queryWrite(`UPDATE crm.edges SET target_id=$1 WHERE target_id=$2 AND tenant_id=$3`,
    [primaryId, secondaryId, tenantId]).catch(() => {});
  // 2) 字段级并入
  const sec = await getParticle(secondaryId);
  if (sec) await mergeIntoExisting(primaryId, sec.payload, tenantId);
  // 3) 软合并标记（复用既有 confirmMerge，不物理删）
  await confirmMerge(secondaryId, primaryId);
  return { ok: true, primaryId, secondaryId, decision_basis: 'BACKFILL_MERGE' };
}
