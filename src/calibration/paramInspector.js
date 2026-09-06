// src/calibration/paramInspector.js — 参数巡检器（26 项算法参数「每夜体检」确定性引擎，无 LLM；含九尺子扩展）
// 设计：docs/2026-09-05-param-closedloop-adaptive-design.md §2.1/§3
// 定位：夜间批量复盘（retro.js）的第三个独立 pass —— 对 config_store 里 22 项算法/参数配置逐项体检，
//       产出 { health, verdict, suggested, evidence, sample }，并转成 PENDING 处方（绝不自动 apply）。
// 铁律：
//   ① 确定性、无 LLM：判据全为可复现的采样指标 + 阈值比较（LLM 归因留在 retro 主 pass）。
//   ② 判据/走廊配置化：数值进 config_store['param-inspect']（可调），代码仅出厂兜底（阈值配置化铁律）。
//   ③ 样本不足守卫：对齐 R5/R6 —— 样本 < MIN_SAMPLE 的键 verdict='review'，不出 adjust（防过拟合噪声）。
//   ④ 冷却护栏：同键 calibration_patch 已有 APPLIED 且距今 < cooldown_days → 跳过（防抖）。
//   ⑤ fail-open：单键判据异常 → emit('trace') + health='unknown'，不阻断其余键；整体异常由调用方兜底。
//   ⑥ 红线：对 context-routing 只出 review 维度（不改轨道；A/B 由 routingReview 独立负责，不双处方打架）。
//   ⑦ 禁 DELETE、绝不自动写 config_store（处方 PENDING，仅人工批准生效）。
import { emit } from '../events/bus.js';
import { recordFailure } from '../monitor/monitorStore.js';
import { readConfig } from '../config/configStore.js';
import { query as defaultQuery } from '../db.js';
import { MIN_SAMPLE as MIN_SAMPLE_CONST } from './constants.js';

// ── 参数清单（26 项，单一事实源：与 configCenter CONFIG_ITEMS 对应；2026-09-06 扩 4 项九尺子）─────────────────
// 每项：{ key, group, param, valueOf(cur), judge(cur, sample), suggest(cur, sample), floor, ceiling, risk }
//   valueOf        ：从配置当前值取「本参数」数值（字符串化显示）
//   judge(cur, s)  ：→ { health:'healthy'|'drift'|'degraded'|'unknown', verdict:'keep'|'adjust'|'review' }
//   suggest(cur,s) ：→ 目标数值（仅 judge 判 adjust 时被调用）
//   floor/ceiling  ：安全走廊（prescribe 夹回）
//   risk           ：处方风险级 LOW/MEDIUM/HIGH
// 判据数值全部取自已配置化的 DEFAULT_INSPECT_CFG.rules（config_store['param-inspect'].rules 可覆盖），
//   代码仅存出厂建议值（阈值配置化铁律：禁硬编码业务阈值）。
export const PARAM_ITEMS = [
  // ── 决策链 6 项核心（方案 B 首批，也是 A 全量里最可证据化的）──
  { key: 'autonomy-conf',        group: '决策治理', param: 'threshold', valueOf: (c) => c?.threshold, floor: 0.5, ceiling: 0.95, risk: 'MEDIUM' },
  { key: 'autonomy-conf',        group: '决策治理', param: 'weights',   valueOf: (c) => c?.weights, floor: 0, ceiling: 1, risk: 'MEDIUM' },
  { key: 'rubric-thresholds',    group: '决策治理', param: 'good',      valueOf: (c) => c?.good, floor: 0.6, ceiling: 0.95, risk: 'MEDIUM' },
  { key: 'rubric-weights',       group: '决策治理', param: 'weights',   valueOf: (c) => c?.weights, floor: 0, ceiling: 1, risk: 'MEDIUM' },
  // ── 九尺子扩展（2026-09-06）：全局 LLM 开关 + 场景级 focus/subset/passline 全量可见 ──
  { key: 'rubric-llm',             group: '决策治理', param: 'llm',            valueOf: (c) => c?.llm, floor: null, ceiling: null, risk: 'MEDIUM' },
  { key: 'rubric-scenario-focus',  group: '决策治理', param: 'focus_rulers',    source: 'scenario-rubric', valueOf: (a) => (a ? `${a.withFocus}/${a.total}` : null), risk: 'LOW' },
  { key: 'rubric-scenario-subset', group: '决策治理', param: 'enabled_rulers',  source: 'scenario-rubric', valueOf: (a) => (a ? `${a.withSubset}/${a.total}` : null), risk: 'LOW' },
  { key: 'rubric-scenario-passline', group: '决策治理', param: 'rubric_pass_line', source: 'scenario-rubric', valueOf: (a) => (a && a.passLineMin != null ? `min ${a.passLineMin}/max ${a.passLineMax}/avg ${a.passLineAvg}` : null), risk: 'LOW' },
  { key: 'precedent-conf',       group: '决策治理', param: 'minSimilarity', valueOf: (c) => c?.minSimilarity, floor: 0.3, ceiling: 0.6, risk: 'MEDIUM' },
  { key: 'sales-thresholds',     group: '业务判定', param: 'bantcc',    valueOf: (c) => c?.bantcc, floor: 0, ceiling: 1, risk: 'MEDIUM' },
  // ── 行为 / 目标 / 阈值类（有「达标率」「误报率」等可采样指标）──
  { key: 'behavior-standard',    group: '行为管理', param: 'daily_visits', valueOf: (c) => c?.daily_visits, floor: 0, ceiling: 30, risk: 'LOW' },
  { key: 'named-account-targets', group: '行为管理', param: 'visit_freq', valueOf: (c) => c?.visit_freq, floor: 0, ceiling: 30, risk: 'LOW' },
  { key: 'alert-rules',          group: '预警',     param: 'threshold', valueOf: (c) => c?.threshold, floor: 0, ceiling: 1, risk: 'LOW' },
  { key: 'approval-config',      group: '流程',     param: 'amount_tiers', valueOf: (c) => c?.amount_tiers, floor: 0, ceiling: 1e9, risk: 'HIGH' },
  // ── 观察 / 复盘 / 派发类（有「命中率」「产出率」可采样）──
  { key: 'event-retro',          group: '复盘',     param: 'cooldown_hours', valueOf: (c) => c?.cooldown_hours, floor: 1, ceiling: 720, risk: 'LOW' },
  { key: 'agent-event-trigger',  group: '派发',     param: 'cooling_ms', valueOf: (c) => c?.cooling_ms, floor: 1000, ceiling: 3600000, risk: 'MEDIUM' },
  { key: 'decision-retro',       group: '复盘',     param: 'min_sample', valueOf: (c) => c?.min_sample, floor: 5, ceiling: 200, risk: 'MEDIUM' },
  { key: 'decision-retro',       group: '复盘',     param: 'window_extend_hours', valueOf: (c) => c?.window_extend_hours, floor: 24, ceiling: 720, risk: 'LOW' },
  // ── 治理 / 守卫类（有「拦截率」「告警数」可采样）──
  { key: 'hindsight-deviation',  group: '治理',     param: 'deviation_threshold', valueOf: (c) => c?.deviation_threshold, floor: 0, ceiling: 1, risk: 'LOW' },
  { key: 'decision-context-guard', group: '治理',   param: 'guard_threshold', valueOf: (c) => c?.guard_threshold, floor: 0, ceiling: 1, risk: 'MEDIUM' },
  { key: 'seven-dim',            group: '治理',     param: 'dim_levels', valueOf: (c) => c?.dim_levels, floor: 0, ceiling: 5, risk: 'MEDIUM' },
  { key: 'business-tier',        group: '治理',     param: 'tier_matrix', valueOf: (c) => c?.tier_matrix, floor: 0, ceiling: 1, risk: 'HIGH' },
  // ── 运行 / 计费类（有「成功率」「拦截率」可采样）──
  { key: 'llm',                  group: '运行',     param: 'temperature', valueOf: (c) => c?.temperature, floor: 0, ceiling: 1, risk: 'LOW' },
  { key: 'pool-config',          group: '运行',     param: 'recycle', valueOf: (c) => c?.recycle, floor: 1, ceiling: 365, risk: 'LOW' },
  { key: 'billing-plans',        group: '计费',     param: 'entitlements', valueOf: () => null, floor: 0, ceiling: 1, risk: 'HIGH' },
  { key: 'context-routing',      group: '决策治理', param: 'scene_matrix', valueOf: (c) => c?.scene_matrix, floor: null, ceiling: null, risk: 'MEDIUM' },
];

// ── 出厂兜底配置（阈值配置化：可经 config_store['param-inspect'] 覆盖）───────────────
export const DEFAULT_INSPECT_CFG = {
  min_sample: 20,          // 样本不足守卫（对齐 MIN_SAMPLE）
  cooldown_days: 30,       // 同键「已 APPLIED」冷却期（防抖）
  window_days: 30,         // 采样窗口（近 30 天）
  rules: {
    // 各键「健康判据」出厂参考线（可调；键名= 配置 key）
    'autonomy-conf.threshold': {
      adjust_if: (s) => s.adopted && (s.override_rate > 0.25 || s.escalate_rate > 0.6 || s.fatigue_rate > 0.3),
      target: (c, s) => (s.override_rate > 0.25 || s.fatigue_rate > 0.3 ? Number(c) - 0.05 : Number(c) + 0.05),
    },
    'rubric-thresholds.good': {
      adjust_if: (s) => s.scene_pass_rate != null && Math.abs(s.scene_pass_rate - 0.75) > 0.2,
      target: (c, s) => Math.min(0.95, Math.max(0.6, 0.75 + (s.scene_pass_rate - 0.75) * 0.5)),
    },
    'precedent-conf.minSimilarity': {
      adjust_if: (s) => s.hit_rate != null && s.hit_rate < 0.1,
      target: () => null, // 命中率极低 → 建议下调（具体步长交 prescribe 护栏）
    },
    // 其余键：出厂只给「健康」默认（adjust 判据由实际采样补充，缺失时按 keep/review）
  },
};

// ── 采样 SQL（只读；对齐 retro.js 具名列约定）──────────────────────────────────────
// decision 近窗行：adopted=人工采纳（human_disposition 非 OVERRIDDEN/CORRECTED）/ 结果失败率 / 各场景通过率
export const SAMPLE_SQL = {
  decisions: `
    SELECT scenario_id, human_disposition, outcome_verified, feedback, attribution
    FROM crm.decision
    WHERE created_at >= now() - ($1::int || ' days')::interval`,
  patchesCooldown: `
    SELECT key, resolved_at FROM crm.calibration_patch
    WHERE status='APPLIED' AND resolved_at >= now() - ($1::int || ' days')::interval`,
};

// ── 巡检入口 ─────────────────────────────────────────────────────────────────────
export async function inspectAll({ tenantId = 'system', windowDays, now = new Date(), query: q = defaultQuery } = {}) {
  const cfg = { ...DEFAULT_INSPECT_CFG, ...(await readInspectCfg({ tenantId }).catch(() => ({}))) };
  const wd = Number(windowDays) || cfg.window_days;
  const [decRows, cdRows] = await Promise.all([
    q(SAMPLE_SQL.decisions, [wd]).catch(() => ({ rows: [] })),
    q(SAMPLE_SQL.patchesCooldown, [cfg.cooldown_days]).catch(() => ({ rows: [] })),
  ]);
  const cdMap = {}; // key → 最近 APPLIED 时间（冷却）
  for (const r of cdRows.rows || []) {
    const k = r.key || r.target || '';
    if (k && !cdMap[k]) cdMap[k] = r.resolved_at;
  }
  const sample = buildSample(decRows.rows || []);

  const items = [];
  const patches = [];
  for (const spec of PARAM_ITEMS) {
    const key = spec.key;
    // 冷却跳过
    if (cdMap[key]) {
      items.push({ key, group: spec.group, param: spec.param, current: spec.valueOf(null), health: 'cooling', verdict: 'keep', suggested: null, evidence: { reason: 'cooldown', last_applied: cdMap[key] }, sample: null, risk: spec.risk });
      continue;
    }
    // 场景级九尺子配置（decision_scenario 行，非 config_store）：仅观测，verdict=review 不出 PENDING 处方（守住禁自动 apply 红线）
    if (spec.source === 'scenario-rubric') {
      try {
        const agg = await readScenarioRubric(q, tenantId).catch(() => null);
        const cur = spec.valueOf(agg);
        items.push({
          key, group: spec.group, param: spec.param, current: cur,
          health: 'healthy', verdict: 'review', suggested: null,
          evidence: { scenarioAggregate: agg, note: '场景级九尺子配置（focus_rulers/enabled_rulers/rubric_pass_line），仅观测不自动出方；调参走决策场景配置页' },
          sample: null, risk: spec.risk,
        });
      } catch (e) {
        emit('trace', 'param-inspect-scenario-failed', { key, error: String(e?.message || e) });
        items.push({ key, group: spec.group, param: spec.param, current: null, health: 'unknown', verdict: 'review', suggested: null, evidence: { error: String(e?.message || e) }, sample: null, risk: spec.risk });
      }
      continue;
    }
    try {
      const curVal = await readParamValue(key, { tenantId }).catch(() => null);
      const cur = spec.valueOf(curVal);
      // 红线：context-routing 只过 overview（不改轨道）
      if (key === 'context-routing') {
        items.push({ key, group: spec.group, param: spec.param, current: null, health: 'healthy', verdict: 'review', suggested: null, evidence: { reason: 'context-routing 红线：A/B 由 routingReview 独立闭环，不重复出方' }, sample: null, risk: spec.risk });
        continue;
      }
      const { health, verdict } = judge(spec, cur, sample, cfg);
      let suggested = null;
      if (verdict === 'adjust') suggested = suggest(spec, cur, sample, cfg);
      // 处方：adjust + 有建议值 → 过本地三步定量护栏（接线，禁 LLM 自由定步长）。
      //   ⚠ Bug B 修复（2026-09-05 方案①）：原 prescribe 护栏以 measured=sample[spec.param]??0 作方向判定，
      //     而 buildSample 仅产出 override_rate/escalate_rate/hit_rate/scene_pass_rate 等，无 good/threshold/minSimilarity 键
      //     → measured 恒为 0 → good 方向('up',baseline=0.75) 永远 sign 不匹配 → 处方被静默抑制。
      //     改由 judge+ suggest 已完成「是否调/调到多少」决策，本地护栏只守三件确定性事实：
      //       ① 建议值有限数；② 落在安全走廊 [floor,ceiling]；③ 与当前值非空操作(|Δ|>1e-9)。
      //     prescribe 核心 / retro 主链路零改动；处方仍 PENDING，仅人工批准生效（禁自动 apply）。
      if (verdict === 'adjust' && suggested != null && spec.floor != null) {
        const s = Number(suggested);
        const lo = Number(spec.floor);
        const hi = spec.ceiling != null ? Number(spec.ceiling) : Infinity;
        const curN = Number(cur) || 0;
        if (Number.isFinite(s) && lo <= s && s <= hi && Math.abs(s - curN) > 1e-9) {
          patches.push({
            knob: 'config_store',
            target: `${key}.${spec.param === 'weights' ? 'weights' : spec.param}`,
            // ⚠ 处方 value 契约：to_value/from_value 传「子键裸值」（非 {param:val} 包裹）。
            //   ConfigStoreStrategy.apply 对 target='key.sub' 直接赋 next[sub]=toValue，
            //   包裹会把子键写成嵌套对象（end-to-end 实测：threshold 变 {threshold:0.65} → 引擎消费 object）。
            from_value: cur,
            to_value: s,
            evidence: { inspector: 'paramInspector', key, param: spec.param, rule: spec.param, sample },
            expected_impact: { note: `参数体检：${key}.${spec.param} 建议由 ${cur} → ${s}` },
            risk: spec.risk,
            assignee: 'ADMIN', tenant_id: tenantId,
          });
        }
      }
      items.push({ key, group: spec.group, param: spec.param, current: cur, health, verdict, suggested, evidence: { reason: reasonFor(verdict) }, sample: null, risk: spec.risk });
    } catch (e) {
      // fail-open 单键
      emit('trace', 'param-inspect-item-failed', { key, error: String(e?.message || e) });
      items.push({ key, group: spec.group, param: spec.param, current: null, health: 'unknown', verdict: 'review', suggested: null, evidence: { error: String(e?.message || e) }, sample: null, risk: spec.risk });
    }
  }

  return {
    inspected_at: now.toISOString ? now.toISOString() : new Date(now).toISOString(),
    inspected: items.length,
    healthy: items.filter((i) => i.health === 'healthy').length,
    drift: items.filter((i) => i.health === 'drift').length,
    degraded: items.filter((i) => i.health === 'degraded').length,
    cooling: items.filter((i) => i.health === 'cooling').length,
    unknown: items.filter((i) => i.health === 'unknown').length,
    items,
    patches,
  };
}

// ── 判断（确定性判据，纯函数）──────────────────────────────────────────────────────
export function judge(spec, cur, sample, cfg) {
  const ruleKey = `${spec.key}.${spec.param}`;
  const rule = (cfg.rules || {})[ruleKey];
  if (!rule || !rule.adjust_if) return { health: 'healthy', verdict: 'keep' };
  const s = sample || {};
  if (rule.adjust_if(s)) return { health: 'drift', verdict: 'adjust' };
  return { health: 'healthy', verdict: 'keep' };
}
export function suggest(spec, cur, sample, cfg) {
  const ruleKey = `${spec.key}.${spec.param}`;
  const rule = (cfg.rules || {})[ruleKey];
  if (!rule || typeof rule.target !== 'function') return null;
  return rule.target(cur, sample || {});
}

// ── 样本聚合（决策近窗 → 供判据消费的指标）────────────────────────────────────────
export function buildSample(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const withOutcome = list.filter((d) => d.outcome_verified);
  const adopted = list.filter(
    (d) => !(d.human_disposition === 'OVERRIDDEN' || d.human_disposition === 'CORRECTED')
  );
  const bizFail = adopted.filter(
    (d) => d.outcome_verified === 'lost' || d.outcome_verified === 'partial' || d.outcome_verified === 'stalled'
  );
  const byScene = {};
  for (const d of list) {
    const sc = d.scenario_id || '?';
    byScene[sc] = byScene[sc] || { n: 0, pass: 0 };
    byScene[sc].n += 1;
    if (d.outcome_verified === 'won' || d.outcome_verified === 'paid' || d.outcome_verified === 'other') byScene[sc].pass += 1;
  }
  const sceneRates = Object.fromEntries(
    Object.entries(byScene).map(([k, v]) => [k, v.n ? v.pass / v.n : null])
  );
  const escalate = list.filter((d) => d.decider_type === 'HUMAN' || d.disposition === 'ESCALATE');
  // override_rate 基于「全量 list」而非 adopted：adopted 已过滤掉 OVERRIDDEN 行，
  //   若用 adopted 集合 filter → 恒 0 → autonomy-conf.threshold 永不 drift（假绿，端到端实测）。
  const overridden = list.filter((d) => d.human_disposition === 'OVERRIDDEN');
  return {
    sample_size: list.length,
    adopted: adopted.length,
    override_rate: list.length ? overridden.length / list.length : 0,
    escalate_rate: list.length ? escalate.length / list.length : 0,
    fatigue_rate: 0, // 升级疲劳率暂以 0 兜底（需 agent_sla 数据源，二期补）
    biz_fail_rate: adopted.length ? bizFail.length / adopted.length : 0,
    hit_rate: list.length ? list.filter((d) => d.attribution?.category === 'precedent' || d.referenced_precedents?.length).length / list.length : 0,
    scene_pass_rate: sceneRates[Object.keys(sceneRates)[0]] ?? null,
  };
}

// ── 配置读取（null 陷阱防御：先排空再判有限，禁 Number(null) 静默）──────────────────
export async function readInspectCfg({ tenantId = 'system' } = {}) {
  const r = await readConfig('param-inspect', { tenantId }).catch(() => null);
  const v = r?.value && typeof r.value === 'object' ? r.value : {};
  const out = { ...DEFAULT_INSPECT_CFG };
  if (v.min_sample != null && Number.isFinite(Number(v.min_sample)) && Number(v.min_sample) > 0) out.min_sample = Number(v.min_sample);
  if (v.cooldown_days != null && Number.isFinite(Number(v.cooldown_days)) && Number(v.cooldown_days) > 0) out.cooldown_days = Number(v.cooldown_days);
  if (v.window_days != null && Number.isFinite(Number(v.window_days)) && Number(v.window_days) > 0) out.window_days = Number(v.window_days);
  if (v.rules && typeof v.rules === 'object') out.rules = { ...out.rules, ...v.rules };
  return out;
}
async function readParamValue(key, { tenantId = 'system' } = {}) {
  const r = await readConfig(key, { tenantId }).catch(() => null);
  return r?.value ?? null;
}
// 场景级九尺子配置聚合（decision_scenario 行，非 config_store）：
//   focus_rulers（聚焦×1.5）/ enabled_rulers（真子集白名单，NULL=全9）/ rubric_pass_line（场景及格线）。
//   只读聚合，绝不写场景行（调参走决策场景配置页）；夜报仅观测呈现（verdict=review，不出 PENDING 处方）。
async function readScenarioRubric(q, tenantId = 'system') {
  const r = await q(
    `SELECT scenario_id, focus_rulers, enabled_rulers, rubric_pass_line
       FROM crm.decision_scenario`
  ).catch(() => ({ rows: [] }));
  const rows = Array.isArray(r?.rows) ? r.rows : [];
  const total = rows.length;
  const withFocus = rows.filter((x) => Array.isArray(x.focus_rulers) && x.focus_rulers.length > 0).length;
  const withSubset = rows.filter((x) => Array.isArray(x.enabled_rulers) && x.enabled_rulers.length > 0).length;
  const passLines = rows
    .map((x) => (x.rubric_pass_line == null ? null : Number(x.rubric_pass_line)))
    .filter((v) => v != null && Number.isFinite(v));
  const passLineMin = passLines.length ? Math.min(...passLines) : null;
  const passLineMax = passLines.length ? Math.max(...passLines) : null;
  const passLineAvg = passLines.length ? Number((passLines.reduce((a, b) => a + b, 0) / passLines.length).toFixed(3)) : null;
  return {
    total, withFocus, withSubset,
    focusCoverage: total ? Number((withFocus / total).toFixed(3)) : 0,
    subsetCoverage: total ? Number((withSubset / total).toFixed(3)) : 0,
    passLineMin, passLineMax, passLineAvg,
  };
}
// retro-knob-map 读取（处方定量护栏驱动；缺失回退出厂兜底）
export const DEFAULT_KNOB_MAP = {
  knob_map: [
    { root_cause_class: 'PARAM_DRIFT', metric: 'threshold', healthy_baseline: 0.25, direction: 'down', sensitivity_k: 0.2, sensitivity_slope: 0.4, max_step: 0.05, min_step: 0.01 },
    { root_cause_class: 'PARAM_DRIFT', metric: 'minSimilarity', healthy_baseline: 0.1, direction: 'down', sensitivity_k: 0.5, sensitivity_slope: 0.3, max_step: 0.05, min_step: 0.01 },
    { root_cause_class: 'PARAM_DRIFT', metric: 'good', healthy_baseline: 0.75, direction: 'up', sensitivity_k: 0.5, sensitivity_slope: 0.5, max_step: 0.05, min_step: 0.01 },
  ],
};
export async function readKnobMap({ tenantId = 'system' } = {}) {
  const r = await readConfig('retro-knob-map', { tenantId }).catch(() => null);
  const v = r?.value && typeof r.value === 'object' ? r.value : null;
  // ⚠ 空 knob_map([]) 视为「未配置」→ 回退 DEFAULT_KNOB_MAP；否则空数组会静默抑制全部出厂旋钮，
  // 导致自动处方永远不触发（生产库 retro-knob-map 为空数组时已实测：22 项体检 0 处方）。
  return v && Array.isArray(v.knob_map) && v.knob_map.length > 0 ? v : DEFAULT_KNOB_MAP;
}

function reasonFor(verdict) {
  return verdict === 'adjust' ? '采样指标偏离健康走廊，建议调整' : (verdict === 'review' ? '样本不足或纯观察维度，仅记录' : '采样指标在健康走廊内，保持当前值');
}
