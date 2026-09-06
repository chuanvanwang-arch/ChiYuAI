// src/decision/methodologyEvidence.js — 方法论维度证据的读写（CRM_METHODOLOGY_EVIDENCE 粒子）
//
// 设计依据：docs/2026-09-02-lightfield-memory-decision-study.md §11（F5 修复，Q1=B+C 组合）
//
// 解决什么问题：`buildConditions` 从 `trigger_context.conditions` 取维度证据，
//   但 7 个业务通道无一传入，且系统里根本没有字段承载 14 个方法论维度
//   （生产库 CRM_DEAL payload 仅 8 键、meta_attr 0 行）→ 证据"双端悬空"。
//   本模块补上数据端：证据落独立粒子，引擎自动加载 → 调用点零改动全通道生效。
//
// 三条铁律：
//   ① **版本化追加，零 DELETE**：纠偏不改旧行，写 version_no+1 的新断言，旧行置 'superseded'。
//      历史断言必须可回溯（"当初凭什么判 B 达标" 是审计问题，不是数据整洁问题）。
//   ② **人工 > 自动**：同一维度若同时存在 source='manual' 与 'auto'，人工断言胜出。
//      提取器可以错，人不该被机器覆盖。
//   ③ **有出处才算证据**：evidence_ref 记 memory_log id / 粒子 id / URL。
//      无出处的 true 是主张不是证据，只在人工录入时允许（此时 asserted_by 即出处）。
import { query } from '../db.js';
import { createParticle, updateParticle, queryParticles } from '../particles/particleRepo.js';

export const EVIDENCE_TYPE = 'CRM_METHODOLOGY_EVIDENCE';
// 可落库的来源白名单。**不含 derived** —— derived 是引擎读时现算的内存态兜底（methodologyExtractor.js），
//   落库会与真断言混淆（"这条是当时算的还是当时记的"分不清），且每次决策都写等于版本号爆炸。
export const EVIDENCE_SOURCES = ['manual', 'auto', 'enrich'];
// 人工优先级最高：同维多源时按此序取胜者（铁律②）。derived 垫底，任何落库断言都能盖掉它。
// 导出供 methodologyExtractor.mergeEvidence 复用 —— 两处各写一份优先级表必然漂移。
export const EVIDENCE_SOURCE_RANK = Object.freeze({ manual: 3, enrich: 2, auto: 1, derived: 0 });
const SOURCE_RANK = EVIDENCE_SOURCE_RANK;

// 读取某主体在指定方法论集下的**现行**证据
// 现行 = state='asserted' 且同 (methodology_id,dim_key) 内 version_no 最大；多源冲突按 SOURCE_RANK 取胜
// @returns { [dim_key]: { met, value, source, evidence_ref, version_no, asserted_by, asserted_at, particle_id } }
export async function loadMethodologyEvidence({ subject_id, methodology_ids = [], tenantId = 'system' } = {}) {
  if (!subject_id || !methodology_ids.length) return {};
  // 走 SQL 而非 queryParticles 全量拉取 + JS 过滤：证据行数随商机×维度×版本增长，
  // 全量拉取在真实数据量下是 O(全表)。此处按 subject/方法论/state 精确下推。
  const r = await query(
    `SELECT id, payload, state
       FROM particles
      WHERE type = $1
        AND tenant_id = $2
        AND state = 'asserted'
        AND payload->>'subject_id' = $3
        AND payload->>'methodology_id' = ANY($4)
      ORDER BY (payload->>'version_no')::numeric ASC NULLS FIRST`,
    [EVIDENCE_TYPE, tenantId, String(subject_id), methodology_ids]
  );

  const out = {};
  for (const row of r.rows) {
    const p = row.payload || {};
    const key = p.dim_key;
    if (!key) continue;
    if (p.met == null) continue;                      // met 为空的行不构成证据（不应写入，防御性跳过）
    const cur = out[key];
    if (cur) {
      // 先比来源优先级（人工 > enrich > 自动），同级再比版本号（ORDER BY 已升序，后来者版本更高）
      const rNew = SOURCE_RANK[p.source] || 0;
      const rCur = SOURCE_RANK[cur.source] || 0;
      if (rNew < rCur) continue;
      if (rNew === rCur && Number(p.version_no || 0) < Number(cur.version_no || 0)) continue;
    }
    out[key] = {
      met: p.met === true || p.met === 'true',
      value: p.value ?? null,
      source: p.source || 'auto',
      evidence_ref: p.evidence_ref ?? null,
      version_no: Number(p.version_no || 1),
      asserted_by: p.asserted_by ?? null,
      asserted_at: p.asserted_at ?? null,
      particle_id: row.id,
    };
  }
  return out;
}

// 断言一条维度证据（幂等版本化：同维已有断言 → 旧行 superseded + 新行 version_no+1）
// @param decision_id 第 0 闸凭据。证据是决策依据，写它本身也是写操作 → 必须携带决策 id。
export async function assertEvidence({
  subject_id, methodology_id, dim_key, met, value = null,
  source = 'manual', evidence_ref = null, asserted_by = null,
  evidence_reason = null, tenantId = 'system', decision_id = null,
} = {}) {
  if (!subject_id) throw new Error('证据缺 subject_id（证据必须挂在具体主体上）');
  if (!methodology_id || !dim_key) throw new Error('证据缺 methodology_id/dim_key');
  if (met == null) throw new Error('证据 met 不可为空（未采集就不该落证据行，否则与"零证据"混淆）');
  if (!EVIDENCE_SOURCES.includes(source)) throw new Error(`证据 source 须为 ${EVIDENCE_SOURCES.join('/')}`);
  // 铁律③：自动/enrich 来源必须给出处；人工录入以 asserted_by 为出处
  if (source !== 'manual' && !evidence_ref) throw new Error(`source=${source} 的证据必须带 evidence_ref（无出处的断言不是证据）`);

  const prior = await query(
    `SELECT id, payload FROM particles
      WHERE type=$1 AND tenant_id=$2
        AND payload->>'subject_id'=$3 AND payload->>'methodology_id'=$4 AND payload->>'dim_key'=$5
      ORDER BY (payload->>'version_no')::numeric DESC NULLS LAST LIMIT 1`,
    [EVIDENCE_TYPE, tenantId, String(subject_id), methodology_id, dim_key]
  );
  const last = prior.rows[0];
  const nextVer = last ? Number(last.payload?.version_no || 1) + 1 : 1;

  const created = await createParticle(EVIDENCE_TYPE, {
    subject_id: String(subject_id), methodology_id, dim_key,
    version_no: nextVer, met: Boolean(met), value,
    source, evidence_ref, asserted_by,
    asserted_at: new Date().toISOString(),
    evidence_reason,
  }, { tenantId, actor: asserted_by, requireDecisionId: decision_id });

  // 旧断言退位（零 DELETE：state 迁 superseded，行体保留可回溯）
  if (last) {
    await updateParticle(last.id, { state: 'superseded', why: `被 v${nextVer} 取代` }).catch(() => {});
  }
  return created;
}

// 列出某主体的证据历史（含 superseded/refuted），供审计与人工纠偏界面
export async function listEvidenceHistory({ subject_id, tenantId = 'system' } = {}) {
  if (!subject_id) return [];
  const all = await queryParticles({ type: EVIDENCE_TYPE, tenantId });
  return all
    .filter((p) => String(p.payload?.subject_id) === String(subject_id))
    .sort((a, b) => {
      const k = String(a.payload?.methodology_id) + a.payload?.dim_key;
      const k2 = String(b.payload?.methodology_id) + b.payload?.dim_key;
      if (k !== k2) return k < k2 ? -1 : 1;
      return Number(b.payload?.version_no || 0) - Number(a.payload?.version_no || 0);
    });
}
