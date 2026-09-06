// src/decision/methodologyExtractor.js — 方法论维度证据提取器（结构化事实 → 维度证据）
//
// 设计依据：docs/2026-09-02-lightfield-memory-decision-study.md §11（F5 修复，Q1=B+C 组合的 C）
//
// —— 本模块解决什么 ——
// 证据粒子（methodologyEvidence.js）补上了"证据能存哪"，但存量商机一条证据都没有；
// 若只靠人工录入，F5 的锁死状态要等到有人把 14 维一条条填完才解除。
// 本模块从**已有结构化事实**自动派生维度证据，让绑方法论的场景当场就有真证据可用。
//
// —— 两种产出形态（都不伪造证据）——
//   ① derived（读时派生，不落库）：引擎每次决策前现算，零写入、零第 0 闸负担、无版本膨胀。
//      定位：兜底供给。即使从未跑过填充器，绑方法论场景也不再"14 维全 null"。
//   ② auto（落库断言）：runEvidenceExtraction() 显式调用时落 CRM_METHODOLOGY_EVIDENCE 粒子，
//      可审计、可被人工纠偏（manual 覆盖 auto）。定位：需要留痕/需要人工复核时用。
//   优先级：manual > enrich > auto > derived（读端 mergeEvidence 与 loadMethodologyEvidence 同序）。
//
// —— 关键裁定：绝不把"未采集"当"不达标"（这正是 F5 的错误本身，不能在提取器里重犯）——
// 商机上已有 `ai.bantcc_detail`（六维 0..1 明细），看似可直接用，但**不能用**：
//   evaluator.js:113 的 scoreOf 在"既无显式评分、又无字段信号"时返回 **0**，
//   与"采集到了但确实不达标"（显式评分 0）产出的 0 完全无法区分。
//   拿这个 0 当 met=false，等于把 14 维未知重新伪装成 14 维不达标 —— F5 换个地方复发。
// 故本模块直接读**原始事实字段**，自行判定三态：
//   显式评分存在        → 有证据，met = (评分 ≥ bantcc.pass)
//   无评分但字段信号存在 → 有证据，met = true（信号即事实，口径与 evaluator scoreOf 一致）
//   两者皆无            → **不产出**（保持 met=null，让 evidenceCoverage 如实反映"没采到"）
//
// —— 已知边界（如实标注，不假装已覆盖）——
//   · 自然语言源（跟进记录/会议纪要）本期**未接**：生产库 CRM_UNSTRUCTURED_ASSET 0 行、
//     memory_log 38 行全是 event/decision/degradation 系统日志，payload 内无跟进正文。
//     没有文本源时写文本提取器，产出的只会是"跑通了但永远空手"的假通道。
//     文本源接通后从 extractFromText 入口接入（见文件末尾 TODO），届时 source 仍走 auto + evidence_ref。
//   · 未覆盖维度：MEDDICC 的 M/I/D1/D2/E、OPP_MATRIX.competitive_position、
//     以及 ROLE_MAP/PRESALES_SOLUTION/RISK_TRADEOFF/STOP_LOSS/FACT_VS_TALK 全部维度 —— 系统无对应字段。
//     这些维度会如实表现为"未采集"，压低 evidenceCoverage 而不冒充达标。
import { readThreshold, mergedThresholds } from '../sales/salesThresholds.js';
import { readConfig } from '../config/configStore.js';
import { assertEvidence, EVIDENCE_SOURCE_RANK, loadMethodologyEvidence } from './methodologyEvidence.js';

// derived 是内存态来源，不入 EVIDENCE_SOURCES 白名单（不可落库）
export const DERIVED_SOURCE = 'derived';

// BANT 四维 + MEDDICC C1/C2 的字段口径。
// **必须与 evaluator.js:115-122 的 scoreOf 字段列表保持同口径** —— 两处漂移会导致
// 看板说"B 维已齐"而决策引擎说"B 维无证据"。守卫见 test/decision/methodologyExtractor.test.js
// 的口径 parity 用例（黑盒比对 evaluator 的 bantcc_detail 与本表的产出集合）。
export const BANTCC_DIMS = Object.freeze([
  { methodology_id: 'BANT', dim_key: 'B', score: 'b', signals: ['expected_amount', 'budget'] },
  { methodology_id: 'BANT', dim_key: 'A', score: 'a', signals: ['authority', 'decision_maker'] },
  { methodology_id: 'BANT', dim_key: 'N', score: 'n', signals: ['needs.product', 'needs.qty', 'pain_points'] },
  { methodology_id: 'BANT', dim_key: 'T', score: 't', signals: ['expected_close_date', 'timeline'] },
  { methodology_id: 'MEDDICC', dim_key: 'C1', score: 'c1', signals: ['competition', 'alternatives'] },
  { methodology_id: 'MEDDICC', dim_key: 'C2', score: 'c2', signals: ['coach', 'internal_support', 'stakeholders'] },
]);

// OPP_MATRIX 两维：从商机金额/赢率派生，达标线走配置（阈值配置化铁律，禁止硬编码数值）
const OPP_DIMS = Object.freeze([
  { methodology_id: 'OPP_MATRIX', dim_key: 'value', field: 'expected_amount', thresholdPath: 'methodology.opp_value_min' },
  { methodology_id: 'OPP_MATRIX', dim_key: 'win_prob', field: 'probability', thresholdPath: 'methodology.win_prob_min' },
]);

// 点路径取值；数组取长度（与 evaluator 对 pain_points 的处理同义：有几条痛点就是有信号）
function pickSignal(payload, path) {
  const keys = String(path || '').split('.').filter(Boolean);
  let cur = payload;
  for (const k of keys) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[k];
  }
  if (Array.isArray(cur)) return cur.length ? cur.length : undefined; // 空数组不算信号
  return cur;
}

// 信号"存在"的判据与 evaluator.js:107 的 sig() 一致：truthy 且不是 <=0 的数字
function hasSignal(v) {
  if (v === undefined || v === null || v === '') return false;
  if (typeof v === 'number') return v > 0;
  return Boolean(v);
}

/**
 * 从商机 payload 派生维度证据（纯函数，零 DB、零副作用）。
 * @param {object} dealPayload  CRM_DEAL.payload
 * @param {object} opts.methodology_ids 场景绑定的方法论（只派生这些方法论下的维度）
 * @param {object} opts.thresholds mergedThresholds 输出（缺省回退出厂默认）
 * @param {string} opts.subject_id 主体 id，用于 evidence_ref 溯源
 * @returns {{[dim_key]: {met, value, source:'derived', evidence_ref, evidence_reason}}}
 */
export function deriveDealEvidence(dealPayload, { methodology_ids = [], thresholds, subject_id = null } = {}) {
  const p = (dealPayload && typeof dealPayload === 'object') ? dealPayload : {};
  const mids = Array.isArray(methodology_ids) ? methodology_ids : [];
  const out = {};
  const refBase = subject_id ? `particle:${subject_id}` : 'particle:unknown';

  // ① BANT / MEDDICC C1C2 —— 显式评分优先，其次字段信号，两者皆无则不产出
  const pass = Number(readThreshold(thresholds, 'bantcc.pass'));
  const b = (p.bantcc && typeof p.bantcc === 'object') ? p.bantcc : {};
  for (const d of BANTCC_DIMS) {
    if (!mids.includes(d.methodology_id)) continue;
    const raw = b[d.score];
    const explicit = Number(raw);
    if (raw !== undefined && raw !== null && !Number.isNaN(explicit)) {
      const score = Math.max(0, Math.min(1, explicit));
      out[d.dim_key] = {
        met: score >= pass,
        value: String(score),
        source: DERIVED_SOURCE,
        evidence_ref: `${refBase}#bantcc.${d.score}`,
        evidence_reason: `显式评分 ${score} ${score >= pass ? '≥' : '<'} 达标线 ${pass}（配置键 bantcc.pass）`,
      };
      continue;
    }
    // 无显式评分 → 找字段信号；命中即视为该维有事实且达标（与 evaluator scoreOf 记 1 同口径）
    const hit = d.signals.map((s) => [s, pickSignal(p, s)]).find(([, v]) => hasSignal(v));
    if (hit) {
      out[d.dim_key] = {
        met: true,
        value: String(hit[1]),
        source: DERIVED_SOURCE,
        evidence_ref: `${refBase}#${hit[0]}`,
        evidence_reason: `字段 ${hit[0]} 已有值（${hit[1]}）→ 该维有事实支撑`,
      };
    }
    // else: 不产出 —— 保持"未采集"，绝不因无数据记 met=false
  }

  // ①b legacy C 迁移回退（**必须与 evaluator.js:123-130 同口径**）：
  //   旧版只落过单一 `bantcc.c` 评分（C1 竞争 / C2 公司支持尚未拆分）。看板侧已让 C1/C2
  //   各继承旧 C 值，此处若不跟着做，同一条老商机会出现「看板说 C1 已齐、引擎说 C1 无证据」。
  //   触发条件与 evaluator 逐条一致：c1/c2 既无显式评分、也无字段信号（即上文未产出）。
  const legacyC = Number(b.c);
  const hasLegacyC = b.c !== undefined && b.c !== null && !Number.isNaN(legacyC);
  if (hasLegacyC && b.c1 === undefined && b.c2 === undefined) {
    const score = Math.max(0, Math.min(1, legacyC));
    for (const k of ['C1', 'C2']) {
      if (out[k]) continue;                                     // 已有真证据的维不被 legacy 覆盖
      if (!mids.includes('MEDDICC')) continue;
      out[k] = {
        met: score >= pass,
        value: String(score),
        source: DERIVED_SOURCE,
        evidence_ref: `${refBase}#bantcc.c`,
        evidence_reason: `旧版单一 C 评分 ${score} 迁移继承（C1/C2 拆分前数据，口径同 evaluator legacy 回退）`,
      };
    }
  }

  // ② OPP_MATRIX 金额/赢率 —— 字段缺失同样不产出
  for (const d of OPP_DIMS) {
    if (!mids.includes(d.methodology_id)) continue;
    const v = p[d.field];
    if (v === undefined || v === null || Number.isNaN(Number(v))) continue;
    const line = Number(readThreshold(thresholds, d.thresholdPath));
    const num = Number(v);
    out[d.dim_key] = {
      met: num >= line,
      value: String(num),
      source: DERIVED_SOURCE,
      evidence_ref: `${refBase}#${d.field}`,
      evidence_reason: `${d.field}=${num} ${num >= line ? '≥' : '<'} 达标线 ${line}（配置键 ${d.thresholdPath}）`,
    };
  }

  return out;
}

/**
 * 按来源优先级合并两组证据（高优先级覆盖低优先级；同级取后者）。
 * 用于「落库证据 覆盖 读时派生」——人工纠偏过的维度不能被派生值盖回去。
 */
export function mergeEvidence(lower = {}, higher = {}) {
  const out = { ...(lower || {}) };
  for (const [k, v] of Object.entries(higher || {})) {
    if (!v) continue;
    const cur = out[k];
    if (!cur) { out[k] = v; continue; }
    const rNew = EVIDENCE_SOURCE_RANK[v.source] || 0;
    const rCur = EVIDENCE_SOURCE_RANK[cur.source] || 0;
    if (rNew >= rCur) out[k] = v;
  }
  return out;
}

/**
 * 落库填充：把派生结果写成 source='auto' 的证据粒子（可审计、可被人工覆盖）。
 * 幂等策略：与现行等值的维度**跳过**（否则每次跑都 version_no+1，历史里全是同值噪音）；
 *           已有 manual/enrich 断言的维度**跳过**（人工优先，铁律②）。
 * @param opts.existing 可选，已加载的现行证据（避免重复查库）
 * @returns {{written:string[], skipped:string[], reason:object}}
 */
export async function runEvidenceExtraction({
  subject_id, deal_payload, methodology_ids = [], thresholds,
  decision_id = null, tenantId = 'system', actor = 'system', existing = null,
} = {}) {
  if (!subject_id) throw new Error('填充器缺 subject_id');
  if (!decision_id) throw new Error('填充器缺 decision_id（写证据是写操作，必经第 0 闸）');

  const derived = deriveDealEvidence(deal_payload, { methodology_ids, thresholds, subject_id });
  const cur = existing || {};
  const written = [];
  const skipped = [];
  const reason = {};

  // dim_key → methodology_id 反查（证据粒子 identity 需要 methodology_id）
  const owner = {};
  for (const d of [...BANTCC_DIMS, ...OPP_DIMS]) owner[d.dim_key] = d.methodology_id;

  for (const [dim, ev] of Object.entries(derived)) {
    const c = cur[dim];
    if (c && (EVIDENCE_SOURCE_RANK[c.source] || 0) > (EVIDENCE_SOURCE_RANK.auto || 0)) {
      skipped.push(dim); reason[dim] = `已有 ${c.source} 断言，人工优先不覆盖`; continue;
    }
    if (c && c.met === ev.met && String(c.value ?? '') === String(ev.value ?? '')) {
      skipped.push(dim); reason[dim] = '与现行断言等值，跳过（不制造同值版本）'; continue;
    }
    await assertEvidence({
      subject_id, methodology_id: owner[dim], dim_key: dim,
      met: ev.met, value: ev.value,
      source: 'auto', evidence_ref: ev.evidence_ref,
      asserted_by: actor, evidence_reason: ev.evidence_reason,
      tenantId, decision_id,
    });
    written.push(dim);
  }
  return { written, skipped, reason };
}

// TODO（文本源接通后）：extractFromText(text, { dims }) —— 从跟进记录/会议纪要正文提取维度证据。
//   前置条件：CRM_UNSTRUCTURED_ASSET 或跟进记录通道有真实正文数据（当前生产库为 0 行）。
//   实现约束：① 提取规则（关键词/正则/LLM prompt）走 config_store，不硬编码；
//            ② evidence_ref 必须定位到具体来源与片段（如 memory_log:<id>#L12-L18），无出处不落证据；
//            ③ LLM 提取结果 source='auto'，不得写 manual —— 机器不能冒充人的断言。

// —— Pre 装配复用入口：把「当前方法论证据」并回决策前链路（Knowledge 注入三件套收口）——
// 与 autonomyEngine ②a-2 **完全同口径**（先读落库断言 → DEAL 粒子读时派生垫底 → mergeEvidence 派生垫底），
// 但本函数**只读、无 autofill 副作用**——Pre 阶段只展示证据现状，不落库（落库走 ②a-3 决策后填充）。
// 这样决策者在写前即看到「概念清单(concept_checklist) + 启用规则(rule_knowledge) + 当前证据(methodology_evidence)」三件套。
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 构建某主体的「方法论证据视图」（读时，用于 Pre 装配展示）。
 * @param {object} pool  pg Pool（须已 SET search_path crm）
 * @param {object} opts { subjectId?:string, methodologyIds?:string[], tenant?:string }
 * @returns {Promise<object>} 维度证据 Map（dim_key → {met,value,source,...}），无主体/无方法论返回 {}
 */
export async function buildMethodologyEvidenceView(pool, opts = {}) {
  const subjectId = opts && opts.subjectId ? String(opts.subjectId) : null;
  const methodologyIds = Array.isArray(opts && opts.methodologyIds) ? opts.methodologyIds : [];
  const tenant = (opts && opts.tenant) || 'system';
  if (!subjectId || !methodologyIds.length) return {};

  // 1) 先读落库断言（auto/manual/enrich），与 ②a 同口径
  let evidence = {};
  try {
    evidence = await loadMethodologyEvidence({
      subject_id: subjectId, methodology_ids: methodologyIds, tenantId: tenant,
    });
  } catch {
    evidence = {}; // fail-open：读库失败不阻断 Pre 骨架
  }

  // 2) 读时派生垫底（仅当主体是 DEAL 粒子；形状闸防 uuid 短键假故障，与 ②a-2 同）
  const isParticleRef = UUID_RE.test(subjectId);
  if (isParticleRef) {
    try {
      const dr = await pool.query(
        `SELECT type, payload FROM crm.particles WHERE id=$1 AND tenant_id=$2`,
        [subjectId, tenant]
      );
      const row = dr.rows[0];
      if (row && String(row.type).endsWith('DEAL')) {
        const thrCfg = await readConfig('sales-thresholds', { tenantId: tenant }).catch(() => null);
        const derived = deriveDealEvidence(row.payload, {
          methodology_ids: methodologyIds,
          thresholds: mergedThresholds(thrCfg?.value || {}),
          subject_id: subjectId,
        });
        evidence = mergeEvidence(derived, evidence); // derived 垫底，落库断言胜出
      }
    } catch {
      // fail-open：派生失败仅留痕由调用方处理，不阻断 Pre 骨架
    }
  }
  return evidence;
}
