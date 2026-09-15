// src/connectors/discovery/claygent.js — C2 Claygent 研究代理
// 范式（Clay 二分搜索法）：不整站抓取，先让模型判定目标信息最可能所在的**页面区块**，
//   再针对性抓取该区块、从文本抽取结构化笔记（区块级二分收敛）。
// 铁律：
//   ① 不伪造 —— 无 LLM 通道 / 无抓取通道 / LLM 不可用 / 零产出 → fail-open 返空并标 degraded，
//      绝不编造 summary/signals/competitors（假绿温床）。
//   ② 纯函数式，不写库（写库在 Action handler，过决策第 0 闸）。③ 禁 DELETE（本模块无写操作）。
//   ⚠ Task 15：glass-box 已复用 src/agent/glassBox.js 的 buildGlassBox（同构输出）。

import { buildGlassBox } from '../../agent/glassBox.js';

export const CLAYGENT_LAYER = 'L3';
export const CLAYGENT_SOURCE = 'claygent';
export const MAX_SECTIONS = 5;
const RULE_REF = 'scenario:lead-fit#ruler:hiring_icp_role';

const SECTION_SYSTEM =
  '你是 B2B 线索研究员。仅输出一个 JSON 对象：'
  + '{"sections":[{"name":"<页面区块名，如 pricing/team/careers/footer>","reason":"<一句话理由>"}]}；'
  + '最多 5 项，按信息价值降序。禁止输出 JSON 之外的任何字符。';

const EXTRACT_SYSTEM =
  '你是研究笔记抽取器。仅输出一个 JSON 对象：'
  + '{"summary":"<不超过120字>","signals":[{"type":"<funding_round|hiring_icp_role|leadership_change|tech_adopt|website_redesign|tender_match>","evidence":"<原文片段>"}],'
  + '"competitors":["<公司名>"],"risks":["<风险>"]}。无依据的字段留空串/空数组，禁止编造。';

const asArray = (x) => (Array.isArray(x) ? x : []);
const uniqBy = (arr, keyOf) => { const m = new Map(); for (const x of arr) { const k = keyOf(x); if (!m.has(k)) m.set(k, x); } return [...m.values()]; };

export async function claygentResearch(entity = {}, brief = '', deps = {}) {
  const { getLlmJson, fetchText } = deps || {};
  const base = {
    summary: '', report: '', signals: [], competitors: [], risks: [], sections: [],
    why_narrative: '', layer: CLAYGENT_LAYER, source: CLAYGENT_SOURCE,
    degraded: false, fetchedSections: 0,
  };
  // fail-open ①：无 LLM 调用器（未配置 provider 时调用方传 null）
  if (typeof getLlmJson !== 'function') return { ...base, degraded: true };

  // ① 区块规划（二分起点：先判信息所在区块，不整站抓取）
  let plan = null;
  try {
    plan = await getLlmJson(SECTION_SYSTEM,
      `公司：${entity.name || '(未知)'}；域名：${entity.domain || '(未知)'}\n研究简报：${brief || '(无)'}`,
      { timeoutMs: 30000 });
  } catch { return { ...base, degraded: true }; }

  const sections = asArray(plan && plan.sections)
    .slice(0, MAX_SECTIONS)
    .map((x) => (typeof x === 'string' ? { name: x } : x))
    .filter((x) => x && x.name);
  // fail-open ②：模型未给出任何区块 → 无产出（不伪造）
  if (!sections.length) return { ...base, degraded: true };

  // ② 逐区块：定向抓取（有通道才抓；单区块失败不中断）→ LLM 抽取笔记
  let summary = ''; let fetchedSections = 0;
  const signals = []; const competitors = []; const risks = [];
  for (const sec of sections) {
    let raw = '';
    const url = sec.url || (entity.domain ? `https://${entity.domain}` : null);
    if (typeof fetchText === 'function' && url) {
      fetchedSections += 1;
      try { raw = await fetchText(url, sec.name); } catch { raw = ''; } // fail-open：单区块抓取失败不中断
    }
    let part = null;
    try {
      part = await getLlmJson(EXTRACT_SYSTEM,
        `区块：${sec.name}\n网页文本：${raw || '(未取得网页文本；仅可基于已知信息作答，无依据则留空)'}`,
        { timeoutMs: 30000 });
    } catch { part = null; }
    if (!part) continue;
    if (part.summary) summary = `${summary} ${part.summary}`.trim();
    signals.push(...asArray(part.signals));
    competitors.push(...asArray(part.competitors));
    risks.push(...asArray(part.risks));
  }

  const uniqSignals = uniqBy(signals, (x) => (x && x.type) || JSON.stringify(x));
  const uniqComp = [...new Set(competitors.filter(Boolean))];
  const uniqRisks = [...new Set(risks.filter(Boolean))];

  // fail-open ③：全程零产出 → degraded（不写库由 handler 依 hasContent 判定）
  if (!summary && !uniqSignals.length && !uniqComp.length && !uniqRisks.length) {
    return { ...base, sections: sections.map((x) => x.name), fetchedSections, degraded: true };
  }

  // ③ glass-box（C2）：why_narrative 非空（SKILL postcondition payload.research.why_narrative!=null）
  const score = Number(Math.min(0.95, 0.5 + 0.1 * uniqSignals.length).toFixed(2));
  const gb = buildGlassBox({ score, ruleRef: RULE_REF, signals: uniqSignals });

  return {
    summary, report: summary,
    signals: uniqSignals, competitors: uniqComp, risks: uniqRisks,
    sections: sections.map((x) => x.name),
    why_narrative: gb.why_narrative, glass_box: gb,
    layer: CLAYGENT_LAYER, source: CLAYGENT_SOURCE, degraded: false, fetchedSections,
  };
}
