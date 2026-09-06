// src/aiAttributes/evaluator.js — AI 属性评估器（② AI 自动产生的落地）
// 设计输入：01 粒子设计 §2.3 AI 属性 2D 模型（能力轴 × 来源轴）+ 12 文档 §7-1
// 铁律：AI 属性永远落 payload.ai.*（带轴/置信度/理由/时间戳），不冒充人工事实字段；
//       置信度 < 0.6 → needsReview 语义；LLM 可注入，无 LLM 走确定性兜底（可复现+degraded 标记）
import { pickNote } from '../sales/visitNote.js';
import { readThreshold, deriveRhythmDays, DEFAULT_THRESHOLDS } from '../sales/salesThresholds.js';

export const AI_ATTR_DEFS = {
  CRM_DEAL: {
    revenue_forecast: { axis: 'F_Forecast', source: 'AI生成', confidence: 0.7 },
    win_probability_adjusted: { axis: 'J_Judge', source: '规则+AI确认', confidence: 0.85 },
    age_in_stage: { axis: 'J_Judge', source: 'AI度量', confidence: 0.8 },
    stuck_warning: { axis: 'A_Alert', source: 'AI生成', confidence: 0.8 },
    engagement_trend: { axis: 'J_Judge', source: 'AI生成', confidence: 0.82 },
    funnel_velocity: { axis: 'F_Forecast', source: 'AI生成', confidence: 0.7 },
    // 行为属性（设计 §5/§8 P0：BANTCC 商机资质齐全度；商机级数据，无 LLM 走确定性兜底）
    bantcc_completeness: { axis: 'J_Judge', source: '规则+AI确认', confidence: 0.8 },
    // BANTCC 六维明细（B/A/N/T/C1/C2）：供看板与阶段门控定位「缺哪一维」
    bantcc_detail: { axis: 'J_Judge', source: '规则+AI确认', confidence: 0.8 },
    // SWAS 商机回顾（设计 §4 P1-A）：S/W/A/S 四项齐全度 + 回顾新鲜度（无 LLM 走确定性兜底）
    swas_completeness: { axis: 'J_Judge', source: '规则+AI确认', confidence: 0.8 },
    swas_staleness_days: { axis: 'J_Judge', source: 'AI生成', confidence: 0.8 },
  },
  CRM_ACCOUNT: {
    account_segment: { axis: 'C_Classify', source: 'AI生成', confidence: 0.8 },
    customer_health_score: { axis: 'J_Judge', source: '规则+AI确认', confidence: 0.85 },
    churn_risk: { axis: 'A_Alert', source: 'AI生成', confidence: 0.7 },
    business_verified: { axis: 'C_Compliance', source: '规则+AI确认', confidence: 0.9 },
    // 行为属性（设计 §5/§8 P0：拜访质检 + 行为合格线；无 LLM 走确定性兜底）
    sales_visit_frequency_adherence: { axis: 'B_Behavior', source: '规则+AI确认', confidence: 0.85 },
    sales_visit_value: { axis: 'B_Behavior', source: '规则+AI确认', confidence: 0.85 },
    sales_visit_gaps: { axis: 'A_Alert', source: 'AI生成', confidence: 0.8 },
    // 21 条行为标准合格线（BH-01~07）：账户级聚合，无 LLM 走确定性兜底
    sales_behavior_checklist: { axis: 'B_Behavior', source: '规则+AI确认', confidence: 0.85 },
  },
  CRM_CONTACT: {
    relationship_heatmap: { axis: 'B_Brief', source: 'AI生成', confidence: 0.85 },
    stakeholder_influence: { axis: 'J_Judge', source: 'AI生成+人工确认', confidence: 0.8 },
  },
};

// 确定性兜底（无 LLM 可复现）：基于既有事实推导，输出可解释 rationale
export function deterministicEval(type, payload, def) {
  const p = payload || {};
  // 阈值经 def 透传（避免改签名影响既有调用点）；缺省回退默认，行为与改造前一致
  const th = (def && def.thresholds) || DEFAULT_THRESHOLDS;
  const tCfg = (def && def.targetsCfg) || {};
  const nowMs = Date.now();
  if (type === 'CRM_DEAL') {
    if (def.key === 'revenue_forecast') {
      const amount = Number(p.expected_amount || 0);
      return { value: amount, rationale: `确定性兜底：revenue_forecast=expected_amount(${amount})（无 LLM，待真实模型注入）` };
    }
    if (def.key === 'age_in_stage') {
      const changed = p.stage_changed_at || null;
      const days = changed ? Math.max(0, Math.round((nowMs - new Date(changed).getTime()) / 86400000)) : 0;
      return { value: days, rationale: `确定性兜底：age_in_stage=${days}天（自 ${changed || '未知'} 起）` };
    }
    if (def.key === 'stuck_warning') {
      const changed = p.stage_changed_at || null;
      const stuckDays = readThreshold(th, 'stage.stuck_days');
      const stageStuck = changed ? (nowMs - new Date(changed).getTime()) > stuckDays * 86400000 : false;
      // SWAS 回顾新鲜度联动（设计 §4.1）：reviewed_at 过期 > swas.stale_days 同样标 stuck
      const swas = p.swas || {};
      const reviewedAt = swas.reviewed_at || null;
      const swasStaleDays = readThreshold(th, 'swas.stale_days');
      const swasStale = reviewedAt ? (nowMs - new Date(reviewedAt).getTime()) > swasStaleDays * 86400000 : false;
      const stuck = stageStuck || swasStale;
      const why = stageStuck ? `阶段停留>${stuckDays}天` : (swasStale ? `SWAS 回顾过期>${swasStaleDays}天` : '');
      return { value: stuck, rationale: stuck ? `确定性兜底：${why} → stuck_warning=true` : '确定性兜底：未触发停留/回顾过期' };
    }
    // SWAS 商机回顾（设计 §4 P1-A）：S/W/A/S 四项齐全度（每项 0.25，缺项递减）
    //   S status / W win_strategy / A action / S schedule（时间节点）
    if (def.key === 'swas_completeness') {
      const swas = p.swas || {};
      const present = (v) => {
        if (v === undefined || v === null || v === '') return false;
        if (Array.isArray(v)) return v.length > 0;
        if (typeof v === 'object') return Object.keys(v).length > 0;
        return true;
      };
      const fields = ['status', 'win_strategy', 'action', 'schedule'];
      const filled = fields.filter(f => present(swas[f])).length;
      const completeness = filled / 4;
      return { value: completeness, rationale: `确定性兜底：swas_completeness=${completeness}（${filled}/4 项齐全：S/W/A/S）` };
    }
    // SWAS 回顾新鲜度（设计 §4.1）：now - reviewed_at 天数，>swas.stale_days 触发 stuck_warning 联动
    if (def.key === 'swas_staleness_days') {
      const reviewedAt = (p.swas || {}).reviewed_at || null;
      if (!reviewedAt) return { value: 0, rationale: '确定性兜底：swas_staleness_days=0（未回顾）' };
      const days = Math.max(0, Math.round((nowMs - new Date(reviewedAt).getTime()) / 86400000));
      return { value: days, rationale: `确定性兜底：swas_staleness_days=${days}天（自 ${reviewedAt} 起）` };
    }
    if (def.key === 'win_probability_adjusted') {
      const base = Number(p.probability || 0);
      return { value: base, rationale: `确定性兜底：win_probability_adjusted=probability(${base})（未叠加 AI 修正）` };
    }
    // BANTCC 六维齐全度（BH-03-01）：
    //   B 预算 / A 决策流程 / N 需求 / T 时间表 / C1 竞争情况 / C2 公司支持与条件
    // 拆分说明（2026-08-30）：旧实现把 coach（内线）与 competition（竞争）混进单一 C，
    //   两者处置动作完全不同（前者要发展内线、后者要摸竞情），故按 SKILL 拆为 C1/C2。
    // 商机级数据；显式评分（method-bant 产出）取数值，否则按字段信号记 1/0；齐全度 = 六维均值
    if (def.key === 'bantcc_completeness') {
      const direct = Number(p.bantcc_completeness);
      if (direct > 0) return { value: direct, rationale: `确定性兜底：bantcc_completeness=${direct}（payload 直取）` };
      const b = (p.bantcc && typeof p.bantcc === 'object') ? p.bantcc : {};
      const sig = (x) => Boolean(x) && !(typeof x === 'number' && x <= 0);
      const scoreOf = (key, ...fallbacks) => {
        const explicit = Number(b[key]);
        if (b[key] !== undefined && b[key] !== null && !Number.isNaN(explicit)) {
          return Math.max(0, Math.min(1, explicit)); // 显式评分（0~1）
        }
        return sig(fallbacks.find(f => f !== undefined && f !== null)) ? 1 : 0;
      };
      const dims = {
        B: scoreOf('b', p.expected_amount, p.budget),
        A: scoreOf('a', p.authority, p.decision_maker),
        N: scoreOf('n', p.needs?.product, p.needs?.qty, (Array.isArray(p.pain_points) ? p.pain_points.length : p.pain_points)),
        T: scoreOf('t', p.expected_close_date, p.timeline),
        C1: scoreOf('c1', p.competition, p.alternatives),
        C2: scoreOf('c2', p.coach, p.internal_support, p.stakeholders),
      };
      // 迁移回退：旧版只落过单一 C 评分（bantcc.c）。当 C1/C2 既无显式评分也无字段信号时，
      // 二者各继承旧 C 值 —— 分母 5→6 的同时分子同步增加，老商机齐全度不被系统性拉低。
      const legacyC = Number(b.c);
      const hasLegacyC = b.c !== undefined && b.c !== null && !Number.isNaN(legacyC);
      if (hasLegacyC && b.c1 === undefined && b.c2 === undefined && dims.C1 === 0 && dims.C2 === 0) {
        dims.C1 = Math.max(0, Math.min(1, legacyC));
        dims.C2 = Math.max(0, Math.min(1, legacyC));
      }
      const filled = Object.values(dims).filter(v => v > 0).length;
      const completeness = Object.values(dims).reduce((s, v) => s + v, 0) / 6;
      const detail = Object.entries(dims).map(([k, v]) => `${k}=${v}`).join(' ');
      return { value: completeness, rationale: `确定性兜底：bantcc_completeness=${completeness}（${filled}/6 维齐全：${detail}）` };
    }
    // BANTCC 六维明细（供看板/门控定位「缺哪一维」，仅聚合值无法给出可行动建议）
    if (def.key === 'bantcc_detail') {
      // 复用 completeness 分支的维度计算，解析其 rationale 得到六维明细（避免两处重复实现维度表）
      const r = deterministicEval('CRM_DEAL', p, { key: 'bantcc_completeness' });
      const dims = {};
      for (const m of (r.rationale.match(/[BANTC][12]?=[\d.]+/g) || [])) {
        const [k, v] = m.split('=');
        dims[k] = Number(v);
      }
      return { value: dims, rationale: `确定性兜底：bantcc_detail=${JSON.stringify(dims)}（六维明细）` };
    }
    return { value: p[def.key] ?? null, rationale: `确定性兜底：${def.key} 直接取既有事实（无 LLM）` };
  }
  if (type === 'CRM_ACCOUNT') {
    if (def.key === 'business_verified') {
      const ok = Boolean(p.business_title && String(p.business_title).length > 4);
      return { value: ok, rationale: ok ? '确定性兜底：business_title 已填且>4字 → verified' : 'business_title 缺失 → 未验证（需人工/企查查）' };
    }
    if (def.key === 'customer_health_score') {
      const score = (p.deal_count || 0) * 10 + (p.last_interaction ? 40 : 0);
      return { value: Math.min(100, score), rationale: `确定性兜底：health=deal_count×10+last_interaction×40（≤100）` };
    }
    // 行为属性（设计 §5/§8 P0：拜访质检 + 行为合格线；窗口天数走 sales-thresholds 配置）
    if (def.key === 'sales_visit_frequency_adherence') {
      const notes = Array.isArray(p.visit_notes) ? p.visit_notes : [];
      const winDays = readThreshold(th, 'rhythm.adherence_window_days');
      const recent = notes.filter(n => n?.at && (Date.now() - new Date(n.at).getTime()) <= winDays * 86400000).length;
      const seg = p.account_segment || 'potential';
      const need = seg === 'potential' ? 0 : 1; // 目标/商机要求窗口内≥1；潜力只要求有接触
      const ok = recent >= need;
      return { value: ok, rationale: `确定性兜底：sales_visit_frequency_adherence=${ok}（近${winDays}天拜访 ${recent} 次，segment=${seg} 需 ${need} 次）` };
    }
    if (def.key === 'sales_visit_value') {
      const notes = Array.isArray(p.visit_notes) ? p.visit_notes : [];
      const last = notes[notes.length - 1] || {};
      // TAORAN 判定口径（字段名经 pickNote 兼容新旧写法）：
      //   O/R/N 为「必需要素」，缺任一即判无效拜访；
      //   T（客户类型）同属必需要素——无 T 则无法校验「拜访目的是否与客户类型/阶段匹配」；
      //   A（是否预约）仅作告警，不判负（避免把有效拜访误判为无效）。
      const keys = ['customer_type', 'objective', 'result', 'next'];
      const missing = keys.filter(k => !pickNote(last, k));
      const ok = missing.length === 0;
      const label = { customer_type: 'T', objective: 'O', result: 'R', next: 'N' };
      return {
        value: ok,
        rationale: ok
          ? '确定性兜底：sales_visit_value=true（TAORAN 六要素齐全：T/O/R/N 为必需要素，A 缺失仅告警）'
          : `确定性兜底：sales_visit_value=false（最近拜访缺 ${missing.map(k => label[k]).join('/')}）`,
      };
    }
    if (def.key === 'sales_visit_gaps') {
      const notes = Array.isArray(p.visit_notes) ? p.visit_notes : [];
      const last = notes[notes.length - 1] || {};
      const gaps = [];
      if (!pickNote(last, 'customer_type')) gaps.push('缺客户类型(T)');
      if (!pickNote(last, 'objective')) gaps.push('缺拜访目的(O)');
      if (!pickNote(last, 'result')) gaps.push('缺结果事实(R)');
      if (!pickNote(last, 'next')) gaps.push('缺下一步(N)');
      if (pickNote(last, 'achieved') === '未达到') gaps.push('本次未达目标');
      if (gaps.length === 0 && !pickNote(last, 'appointment') && (p.account_segment === 'opportunity')) gaps.push('商机客户无预约');
      return { value: gaps, rationale: gaps.length ? `确定性兜底：sales_visit_gaps=${gaps.join(';')}` : '确定性兜底：sales_visit_gaps=[]（无缺口）' };
    }
    // 21 条行为标准（degraded 单账户视图：仅基于 payload 内 visit_notes/needs；完整评估需 dealList+contacts）
    if (def.key === 'sales_behavior_checklist') {
      const notes = Array.isArray(p.visit_notes) ? p.visit_notes : [];
      const last = notes[notes.length - 1] || {};
      // degraded 版同样走配置（与 behaviorChecklist 完整版同源，避免两处漂移）
      const T = {
        recentDays: readThreshold(th, 'behavior.recent_visit_days'),
        minTypes: readThreshold(th, 'behavior.min_customer_types'),
        minContacts: readThreshold(th, 'behavior.min_contacts'),
      };
      const rhythm = deriveRhythmDays(tCfg, th);
      const items = {
        '01-01': notes.some(n => n?.at && (Date.now() - new Date(n.at).getTime()) <= T.recentDays * 86400000),
        '01-02': (() => { const o = pickNote(last, 'objective'); return Boolean(o && String(o).length > 4 && !String(o).includes('维护关系')); })(),
        '01-03': Boolean(pickNote(last, 'prepare') && String(pickNote(last, 'prepare')).length > 0),
        // 02-01「拜访所有客户」读客户类型（customer_type），非拜访方式（type）——见 behaviorChecklist.js 同项
        '02-01': new Set(notes.map(n => pickNote(n, 'customer_type')).filter(Boolean)).size >= T.minTypes,
        '02-02': Boolean((p.needs || p.pain_points) ? notes.length > 0 : true),
        '03-01': false, // 需要 dealList 算 BANTCC，degraded 标为待评估
        '03-02': Boolean(p.needs?.pain || p.pain_points),
        '03-03': !(pickNote(last, 'achieved') === '未达到' && !pickNote(last, 'next')),
        '03-04': Boolean(pickNote(last, 'prepare') && String(pickNote(last, 'prepare')).length > 0),
        '04-01': Boolean(p.contacts?.some?.(c => c.business_title)),
        '04-02': (p.contacts?.length || 0) >= T.minContacts || Boolean(pickNote(last, 'new_contact')),
        '04-03': (() => { const n = pickNote(last, 'next'); return Boolean(n && String(n).length > 0); })(),
        '05-01': Boolean(p.account_segment && p.account_segment !== 'potential'),
        '05-02': p.account_segment === 'potential' ? notes.some(n => n?.at && (Date.now() - new Date(n.at).getTime()) <= rhythm.potential_days * 86400000) : true,
        '05-03': p.account_segment === 'target' ? notes.some(n => n?.at && (Date.now() - new Date(n.at).getTime()) <= rhythm.target_days * 86400000) : true,
        '06-01': true, // 无 dealList 无法判定 hidden，degraded 默认合规
        '06-02': false, // 需要 dealList 判定 win_strategy
        '06-03': Boolean(pickNote(last, 'collaboration')),
        '06-04': false, // 需要 dealList 判定 closed_lost review
        '07-01': (() => { const v = p.ai?.sales_visit_value; return typeof v === 'object' ? Boolean(v.value) : Boolean(v); })(),
        '07-02': Boolean(last.review && String(last.review).length > 0),
      };
      const pass = Object.values(items).filter(Boolean).length;
      return {
        value: { pass, total: 21, gaps: [], items },
        rationale: `确定性兜底（degraded）：sales_behavior_checklist=${pass}/21（仅账户级事实；BANTCC/win_strategy/team 等需 dealList 完整评估）`,
      };
    }
    return { value: p[def.key] ?? null, rationale: `确定性兜底：${def.key}（无 LLM）` };
  }
  return { value: p[def.key] ?? null, rationale: `确定性兜底：${def.key}（无 LLM）` };
}

// 共性组装：把「每属性的求值结果」落进 payload.ai.*（带轴/来源/置信度/理由/时间戳/degraded）
// results: { [key]: { value, rationale, degraded } }
function assembleAi(entity, results, now) {
  const defs = AI_ATTR_DEFS[entity.type] || {};
  const ai = { ...(entity.payload?.ai || {}) };
  let degraded = false;
  for (const [key, def] of Object.entries(defs)) {
    const r = results[key] || {};
    if (r.degraded) degraded = true;
    ai[key] = {
      value: r.value ?? null,
      axis: def.axis, source: def.source, confidence: def.confidence,
      rationale: r.rationale || `未评估：${key}`,
      generated_at: now,
      degraded: !!r.degraded,
    };
  }
  return { ai, degraded, changed: JSON.stringify(ai) !== JSON.stringify(entity.payload?.ai || {}) };
}

// 同步求值（写时触发链路用：particleRepo create/update）
// llm 可注入（传 summaryText → {value, rationale}）；缺省确定性兜底
export function evaluateAiAttributesFor(entity, { llm = null, now = new Date().toISOString() } = {}) {
  const defs = AI_ATTR_DEFS[entity.type] || {};
  const results = {};
  for (const [key, def] of Object.entries(defs)) {
    const summaryText = JSON.stringify({ type: entity.type, payload: entity.payload });
    if (typeof llm === 'function') {
      results[key] = llm(summaryText, { type: entity.type, key, axis: def.axis })
        || { value: null, rationale: `LLM 分析 ${key}` };
    } else {
      results[key] = { ...deterministicEval(entity.type, entity.payload, { ...def, key }), degraded: true };
    }
  }
  return assembleAi(entity, results, now);
}

// 异步批量求值（定时扫描链路用：riskScanner）
// llmBatch(summaryText, {type, keys}) → { [key]: {value, rationale} } | null，一次调用算完全部属性（B 方案）
// 优先级：llmBatch 命中 > llm 逐属性 > deterministicEval 兜底；任一属性兜底即整体 degraded=true
export async function evaluateAiAttributesForAsync(entity, { llm = null, llmBatch = null, now = new Date().toISOString() } = {}) {
  const defs = AI_ATTR_DEFS[entity.type] || {};
  const keys = Object.keys(defs);
  const summaryText = JSON.stringify({ type: entity.type, payload: entity.payload });
  let batch = null;
  if (typeof llmBatch === 'function' && keys.length) {
    batch = await llmBatch(summaryText, { type: entity.type, keys }).catch(() => null);
  }
  const results = {};
  for (const [key, def] of Object.entries(defs)) {
    if (batch && batch[key]) {
      results[key] = { ...batch[key], degraded: false };
    } else if (typeof llm === 'function') {
      results[key] = llm(summaryText, { type: entity.type, key, axis: def.axis })
        || { value: null, rationale: `LLM 分析 ${key}`, degraded: false };
    } else {
      results[key] = { ...deterministicEval(entity.type, entity.payload, { ...def, key }), degraded: true };
    }
  }
  return assembleAi(entity, results, now);
}

// 便捷读取单 AI 属性（查询/上下文注入用；未生成回退 fallback）
export function aiAttrFor(entity, key, fallback = null) {
  return entity?.payload?.ai?.[key] ?? fallback;
}

// AI 属性轴源标记（元模型 source 轴对照；设计 §7 —— AI 属性轴永不进 meta_attr，此表供消费方跨域对照）
// 键格式：`<粒子类型>.<属性键>`，值 = { axis, source, confidence }
export const AI_ATTR_AXIS_SOURCE = Object.fromEntries(
  Object.entries(AI_ATTR_DEFS).flatMap(([ptype, defs]) =>
    Object.entries(defs).map(([key, d]) => [`${ptype}.${key}`, { axis: d.axis, source: d.source, confidence: d.confidence }]))
);