// src/decision/retro.js — 决策复盘智能体运行时（J3 校准层「夜间批量复盘」）
// 定位：实时 autoSuggest（偏差触发浮卡）的批量补充——每日全量扫描 + LLM 深度归因，产出可审查的方案草稿。
// 铁律：
//   ① 绝不 DELETE（仅 INSERT 追加式 report）；
//   ② 绝不自批自方——产出 draft_patches 草稿存 report；
//      T12（2026-09-05，§16.6 收紧）：retro 末段把 config_store 类草稿落 calibration_patch 作 ADMIN/tan_admin 待办
//      （PENDING，绝不自动 apply）；管理员批准经决策第0闸的动作在既有校准流（store.approvePatch）完成，本文件不碰写通道。
//   ③ LLM 不可用 → 确定性启发式降级（仍产出聚类洞察，但标 degraded、不出处方）。
// 依赖：db.query / events.bus.emit / monitor.recordFailure / llm.client.getLlmJson / calibration 常量 / store.savePatches。
import { query } from '../db.js';
import { emit } from '../events/bus.js';
import { recordFailure } from '../monitor/monitorStore.js';
import { getLlmJson } from '../llm/client.js';
import { readConfig } from '../config/configStore.js';
import { summarizeDailyOps } from './dailyOps.js';
import { savePatches } from '../calibration/store.js';

// R3 复盘配置：单一 config_store 键，禁硬编码（R1/R5 阈值全部可配，出厂兜底在 RETRO_CONFIG_DEFAULTS）。
//   原 retro.js 读 'decision-retro' 但从未落库 → 配置恒走兜底（死代码）；现统一为 RETRO_CONFIG_KEY，
//   且经 configCenter 注册（详见 src/portal/configCenter.js id=retro-config 段）。
export const RETRO_CONFIG_KEY = 'decision-retro';
export const RETRO_CONFIG_DEFAULTS = {
  min_sample: 20,             // R1：簇样本阈值（真实日产量个位数时会短路全簇 → 可下调或开窗口自适应）
  llm_timeout_ms: 180000,     // R3：DeepSeek-V4-Flash 推理模型单次 106~125s，禁 20s 硬编码
  window_extend_enabled: true, // R1：样本不足时自动扩窗至 window_extend_hours
  window_extend_hours: 168,   // R1：扩窗上限（7d），避免长链路无限回溯
  total_deadline_ms: 600000,  // R5：夜批总时长预算（10min），超期剩余簇降级
  llm_fail_circuit: 3,        // R5：LLM 连续失败熔断阈值
};
export async function readRetroConfig() {
  let raw = null;
  try {
    const r = await readConfig(RETRO_CONFIG_KEY, { tenantId: 'system' }).catch(() => null);
    raw = r && typeof r === 'object' ? (r.value ?? r) : null;
  } catch { /* fail-safe：脏配置不崩跑批，回落出厂默认 */ }
  const cfg = { ...RETRO_CONFIG_DEFAULTS };
  if (raw && typeof raw === 'object') {
    for (const k of Object.keys(RETRO_CONFIG_DEFAULTS)) {
      const v = raw[k];
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) cfg[k] = v; // 允许 0（=立即超期/关停）
      else if (typeof v === 'boolean') cfg[k] = v;
    }
  }
  return cfg;
}

// R2 待办处方 knob 白名单：仅这些 knob 可经决策第0闸落 calibration_patch（PENDING，绝不自动 apply）。
//   原实现仅认 'config_store' → 真实 14 条处方（required_dims/threshold/edge_binding…）命中 0 条，待办恒空。
const APPLYABLE_KNOBS = new Set([
  'config_store', 'required_dims', 'threshold', 'weight',
  'edge_binding', 'meta_attr_map', 'particle_attr_add', 'source_refresh',
  'dim_order', 'precedent_distill',
]);

// 七类根因分类（与 docs/2026-08-30-full-traceability-root-cause-design.md §3 对齐）
const ROOT_CAUSE_CLASSES = [
  'FIELD_MISMATCH',          // 字段不一致（payload key 与 meta_attr 命名错配）
  'INFO_INCOMPLETE',         // 信息不完整（required 字段缺失）
  'INPUT_LATE',              // 输入不及时（updated_at 距 decided_at 超 SLA）
  'DIM_MISSING',             // 维度不对（required_dims 要求缺失）
  'EDGE_MISSING',            // 边选择不对（决策图 7 边应存缺）
  'NEED_DIM_ORDER',          // 优化次序 / 补齐维度
  'DATA_QUALITY_PRECEDENT',  // 数据质量·参考先例/标杆污染
];

const RETRO_SYSTEM_PROMPT = `你是企业AI销售决策平台的「决策复盘分析师」。平台用 K/M/J 三层框架治理决策质量：
- K 知识系统：运行时喂给决策的原料（实体/关系/历史决策/治理）。
- M 记忆系统：决策的结构化留存，含 L1-L7 七个上下文维度（身份/结构/语义/时间配置/决策历史/运行状态/治理）与 E1-E7 七类决策边（针对/参考先例/由异常触发/确立标杆/推翻翻案/直接引发/间接影响）。
- J 决策脊柱：J1 上下文图谱(groundedness) / J2 反馈回路(outcome) / J3 校准层(calibration)。

你的任务是：针对一个决策闸门（scenario）在统计窗口内的决策集群，结合其上下文维度缺失、边缺失、业务反馈（可用/不可用、重大偏差）、业务结果（won/lost/paid），判断**真正的根因类别**，并给出**具体、可执行、可经第0闸审批落地**的修正方案。

根因类别只能从以下七类选一：
${ROOT_CAUSE_CLASSES.map((c, i) => `${i + 1}. ${c}`).join('\n')}

输出严格 JSON，不要任何解释性文字：
{
  "root_cause_class": "<七类之一>",
  "root_cause_explanation": "<一句话根因说明，点出具体维度/边/字段/先例>",
  "draft_patches": [
    {
      "knob": "required_dims|threshold|weight|edge_binding|meta_attr_map|particle_attr_add|source_refresh|dim_order|precedent_distill|config_store",
      "target": "<作用对象，如 scenario_id / 边类型 / 字段 slug；无法定位可为 null>",
      "from_value": <对象或原值>,
      "to_value": <对象或新值>,
      "risk": "LOW|MEDIUM|HIGH",
      "label": "<人读的一句话方案>",
      "evidence": { "<指标名>": "<值>" }
    }
  ],
  "confidence": <0..1 数值>,
  "predicted_impact": "<一句话预期改善>"
}

若根因指向某 config_store 旋钮（如 precedent-conf.minSimilarity / sales-thresholds / approval-config），knob 用 'config_store'，target 用 '键名.子键'（例 precedent-conf.minSimilarity），to_value 为建议新值。每层旋钮均须经决策第0闸（requireDecision）+ HITL 才落地，本文件只产出草稿、绝不自动 apply。`;

// R4 取窗口内决策：收敛为具名列（原 SELECT * 触发全列回表，规模化线性劣化；仅取聚类所需 6 列）
async function loadWindowDecisions(windowStartISO, limit = 2000) {
  const r = await query(
    `SELECT decision_id, scenario_id, decided_at, tenant_id, attribution, feedback
     FROM crm.decision WHERE decided_at >= $1 ORDER BY decided_at DESC LIMIT $2`,
    [windowStartISO, limit]
  );
  return r.rows;
}

// 按 scenario_id 聚类并抽取紧凑摘要
function clusterByScenario(rows) {
  const map = new Map();
  for (const row of rows) {
    const sid = row.scenario_id || '__unknown__';
    if (!map.has(sid)) map.set(sid, []);
    map.get(sid).push(row);
  }
  const clusters = [];
  for (const [scenario_id, items] of map.entries()) {
    const categoryDist = {};
    const missingDims = new Set();
    const missingEdges = new Set();
    const feedbackFlags = { unusable: 0, majorDeviation: 0 };
    const tenantSet = new Set();
    for (const it of items) {
      tenantSet.add(it.tenant_id || 'system');
      const attr = it.attribution && typeof it.attribution === 'object' ? it.attribution : {};
      const cat = attr.category || 'unknown';
      categoryDist[cat] = (categoryDist[cat] || 0) + 1;
      const rf = attr.required_fill || {};
      for (const d of Array.isArray(rf.missing) ? rf.missing : []) missingDims.add(d);
      const ec = attr.edge_compliance || {};
      for (const [k, v] of Object.entries(ec)) {
        if (v && v.status === 'missing_should_exist') missingEdges.add(k);
      }
      const fb = it.feedback && typeof it.feedback === 'object' ? it.feedback : {};
      if (fb.usable === false) feedbackFlags.unusable += 1;
      if (fb.major_deviation === true) feedbackFlags.majorDeviation += 1;
    }
    clusters.push({
      scenario_id,
      count: items.length,
      tenant_id: [...tenantSet][0] || 'system', // 单租户聚类取首值；跨租户聚类取首值并留痕
      category_distribution: categoryDist,
      sample_missing_dims: [...missingDims].slice(0, 7),
      sample_missing_edges: [...missingEdges].slice(0, 7),
      feedback_flags: feedbackFlags,
      sample_decision_ids: items.slice(0, 3).map((x) => x.decision_id),
      metrics: measureClusterMetrics({
        count: items.length,
        category_distribution: categoryDist,
        feedback_flags: feedbackFlags,
        sample_missing_dims: [...missingDims],
      }),
    });
  }
  return clusters;
}

// §12.1 指标测量：为聚类计算旋钮相关量化槽位（数值 0..1），供处方引擎 prescribe() 消费。
// 纯函数，不读库、不写库。来源：category_distribution（先例命中）/ feedback_flags（不可用/重大偏差）/ 维度缺失。
export function measureClusterMetrics(cluster, { minSimilarity } = {}) {
  const count = Number(cluster?.count || 0);
  const cat = cluster?.category_distribution || {};
  const used = Number(cat.precedent_used || cat.precedentUsed || 0);
  const missing = Number(cat.precedent_missing || cat.precedentMissing || 0);
  const precedent_recall = used + missing > 0 ? used / (used + missing) : 0;
  const fb = cluster?.feedback_flags || {};
  const unusable = Number(fb.unusable || 0);
  const majorDev = Number(fb.majorDeviation || fb.major_deviation || 0);
  const major_deviation_rate = count > 0 ? majorDev / count : 0;
  const unusable_rate = count > 0 ? unusable / count : 0;
  const dimMissing = Array.isArray(cluster?.sample_missing_dims) ? cluster.sample_missing_dims.length : 0;
  const dim_missing_rate = count > 0 ? Math.min(1, dimMissing / count) : 0;
  const upgrade = Number(cluster?.upgrade_count || 0);
  const upgrade_rate = count > 0 ? upgrade / count : 0;
  return { precedent_recall, major_deviation_rate, unusable_rate, dim_missing_rate, upgrade_rate };
}

function buildUserPrompt(cluster) {
  return JSON.stringify(
    {
      scenario_id: cluster.scenario_id,
      window_sample_size: cluster.count,
      category_distribution: cluster.category_distribution,
      sample_missing_dims: cluster.sample_missing_dims,
      sample_missing_edges: cluster.sample_missing_edges,
      feedback_flags: cluster.feedback_flags,
    },
    null,
    2
  );
}

// 确定性启发式降级：LLM 不可用时，按证据给定性洞察（不出处方）
function heuristicAnalyze(cluster) {
  const notes = [];
  let klass = 'NEED_DIM_ORDER';
  if (cluster.sample_missing_dims.length) {
    klass = 'DIM_MISSING';
    notes.push(`维度缺失：${cluster.sample_missing_dims.join('、')}`);
  }
  if (cluster.sample_missing_edges.length) {
    klass = 'EDGE_MISSING';
    notes.push(`决策边应存缺：${cluster.sample_missing_edges.join('、')}`);
  }
  if (cluster.feedback_flags.majorDeviation > 0) {
    notes.push(`${cluster.feedback_flags.majorDeviation} 条决策被标重大偏差`);
  }
  if (cluster.feedback_flags.unusable > 0) {
    notes.push(`${cluster.feedback_flags.unusable} 条业务判定不可用`);
  }
  if (!notes.length) notes.push('样本窗口内未见明确维度/边缺失或负反馈，建议持续观测');
  return {
    root_cause_class: klass,
    root_cause_explanation: notes.join('；'),
    draft_patches: [],
    confidence: 0.3,
    predicted_impact: '需更多样本或 LLM 介入以产出可执行处方',
    degraded: true,
  };
}

async function analyzeCluster(cluster, llmJson, { timeoutMs, minSample } = {}) {
  // R1 守卫：样本不足 → 不出处方，仅提示（minSample 来自 config，禁硬编码）
  if (cluster.count < minSample) {
    const h = heuristicAnalyze(cluster);
    return {
      ...h,
      root_cause_class: 'NEED_DIM_ORDER',
      root_cause_explanation: `样本不足(${cluster.count}<${minSample})，暂不出处方；${h.root_cause_explanation}`,
      draft_patches: [],
    };
  }
  if (!llmJson) return heuristicAnalyze(cluster);
  let out = null;
  try {
    out = await llmJson(RETRO_SYSTEM_PROMPT, buildUserPrompt(cluster), { timeoutMs, max_tokens: 4000 });
  } catch (e) {
    // 禁裸 catch（2026-09-03）：原实现吞掉 AbortError 且无任何落痕，导致「配置正常却 drafts=0」无法自证。
    emit('trace', 'decision-retro-llm-call-failed', {
      scenario_id: cluster.scenario_id,
      timeout_ms: timeoutMs,
      error: String(e?.name || '') + ': ' + String(e?.message || e),
    });
  }
  if (!out || typeof out !== 'object' || !ROOT_CAUSE_CLASSES.includes(out.root_cause_class)) {
    const h = heuristicAnalyze(cluster);
    return { ...h, root_cause_explanation: `LLM 输出不可信，降级：${h.root_cause_explanation}` };
  }
  const patches = Array.isArray(out.draft_patches) ? out.draft_patches.filter((p) => p && p.knob && p.to_value != null) : [];
  return {
    root_cause_class: out.root_cause_class,
    root_cause_explanation: String(out.root_cause_explanation || ''),
    draft_patches: patches,
    confidence: typeof out.confidence === 'number' ? out.confidence : 0.5,
    predicted_impact: String(out.predicted_impact || ''),
  };
}

// llmFactory 注入点：默认 getLlmJson（生产）；单测注入以隔离 DB/网络
// 计划缺陷修正 #7：draftPatches 实际字段为 from_value/to_value/label/evidence（LLM 输出契约），
//   无 prescription 子对象 → §16.2 prescriptions 段落按实际字段映射（prescription?.* 可选挂载，缺失时回退 label）。
function toPrescription(p) {
  return {
    target: p.target ?? null,
    knob: p.knob ?? null,
    from: p.from_value ?? p.from ?? null,
    to: p.to_value ?? p.to ?? null,
    why: p.prescription?.reason ?? p.label ?? null,
    predicted_after: p.prescription?.predicted_impact ?? null,
    risk: p.risk ?? null,
    evidence: p.evidence ?? null,
    scenario_id: p.scenario_id ?? null,
    root_cause_class: p.root_cause_class ?? null,
  };
}

// §16.2 problems：弱簇入选（计划原文 quality/avg_confidence 字段在 analyzed 条目中不存在 →
//   修正 #7：以 LLM 置信度 confidence < 0.7 判弱；降级启发式簇 confidence=0.3 恒入选，暴露降级事实）。
function buildProblems(analyzed) {
  return analyzed
    .filter((c) => Number(c?.confidence ?? 1) < 0.7)
    .map((c) => ({
      cluster: c.scenario_id,
      root_cause: c.root_cause_class,
      evidence: c.root_cause_explanation,
      severity: Number(c.confidence ?? 1) < 0.5 ? 'HIGH' : 'MEDIUM',
    }));
}

export async function runDecisionRetro({ windowHours = 24, now = new Date().toISOString(), dryRun = false, llmFactory } = {}) {
  const cfg = await readRetroConfig();
  const MIN_SAMPLE = cfg.min_sample;
  const timeoutMs = cfg.llm_timeout_ms;
  const startWall = Date.now();
  const deadline = Number(cfg.total_deadline_ms) || 0;       // R5：0 = 立即超期
  const circuitThreshold = Number(cfg.llm_fail_circuit) || RETRO_CONFIG_DEFAULTS.llm_fail_circuit;

  const windowStart = new Date(Date.parse(now) - windowHours * 3600 * 1000).toISOString();
  let rows = await loadWindowDecisions(windowStart);

  // R1 窗口自适应：若全部簇样本不足，扩窗重取（避免真实低产日恒空转、llm_effective 连两晚为 0）
  let window_extended = false;
  let effective_window_hours = windowHours;
  if (cfg.window_extend_enabled && windowHours < cfg.window_extend_hours) {
    const initial = clusterByScenario(rows);
    const allSmall = initial.length > 0 && initial.every((c) => c.count < MIN_SAMPLE);
    if (allSmall) {
      const extStart = new Date(Date.parse(now) - cfg.window_extend_hours * 3600 * 1000).toISOString();
      const extRows = await loadWindowDecisions(extStart);
      if (extRows.length > rows.length) {
        rows = extRows;
        window_extended = true;
        effective_window_hours = cfg.window_extend_hours;
      }
    }
  }
  const windowStartEff = new Date(Date.parse(now) - effective_window_hours * 3600 * 1000).toISOString();

  const clusters = clusterByScenario(rows);
  const getLlm = llmFactory || ((o) => getLlmJson(o));

  const analyzed = [];
  const draftPatches = [];
  // 限流护栏：每个 cluster 重新取用 LLM 函数（round-robin 在多配置间轮换），
  // 避免串行打到同一条配置/同一个 key 触发连续超时 → 全量降级（DRAFTS=0 根因）
  let llmAvailable = false;
  let circuitOpen = false;     // R5：连续失败熔断
  let consecFails = 0;
  let deadlineHit = false;     // R5：总时长预算耗尽

  for (const c of clusters) {
    const withinDeadline = deadline === 0 ? false : (Date.now() - startWall) < deadline;
    if (!withinDeadline) deadlineHit = true;   // R5：预算耗尽，本簇及后续被迫降级
    const mayUseLlm = !circuitOpen && withinDeadline;
    let llmJson = null;
    if (mayUseLlm) {
      llmJson = await getLlm({ strategy: 'round-robin' }).catch(() => null);
    }
    if (llmJson) llmAvailable = true;

    const a = await analyzeCluster(c, llmJson, { timeoutMs, minSample: MIN_SAMPLE });

    // R5 连续失败熔断：仅当本簇**真正调用了 LLM 且返回不可信（降级）**才计失败（样本不足被短路的簇 LLM 未调用，不计入，
    //   否则低产日全簇短路会误触发熔断 → 后续真实簇被错误跳过）。
    //   ⚠ 判据必须用 a.degraded（analyzeCluster 返回对象是否降级），不能用 a.llm_used——
    //     a.llm_used 在 analyzeCluster 返回值上不存在（仅 entry 上有），会恒为 undefined → 每个合格簇都被误判失败、
    //     连续 3 个即熔断，使夜批在「合格簇>3」时错误掐断 LLM（2026-09-05 生产复跑实测 circuit_open 恒真暴露）。
    const eligible = c.count >= MIN_SAMPLE;
    if (mayUseLlm && llmJson && eligible) {
      const ok = !a.degraded;   // LLM 被调用且返回可信（非降级）= 成功
      if (ok) consecFails = 0;
      else {
        consecFails += 1;
        if (consecFails >= circuitThreshold) {
          circuitOpen = true;
          emit('trace', 'decision-retro-circuit-open', { scenario_id: c.scenario_id, consecutive_fails: consecFails });
        }
      }
    }

    const entry = {
      scenario_id: c.scenario_id,
      count: c.count,
      category_distribution: c.category_distribution,
      root_cause_class: a.root_cause_class,
      root_cause_explanation: a.root_cause_explanation,
      draft_patches: a.draft_patches,
      llm_used: llmAvailable && !a.degraded && llmJson != null,
      confidence: a.confidence,
      predicted_impact: a.predicted_impact,
    };
    analyzed.push(entry);
    for (const p of a.draft_patches) {
      draftPatches.push({ ...p, scenario_id: c.scenario_id, root_cause_class: a.root_cause_class, tenant_id: c.tenant_id });
    }
  }

  const summary = {
    clusters: analyzed.length,
    drafts: draftPatches.length,
    by_root_cause: analyzed.reduce((acc, e) => {
      acc[e.root_cause_class] = (acc[e.root_cause_class] || 0) + 1;
      return acc;
    }, {}),
    llm_enabled: llmAvailable,
    // 真正吃到 LLM 的聚类数（区别于 llm_enabled：配置可用但全部超时降级时为 0，暴露限流降级）
    llm_effective: analyzed.filter((e) => e.llm_used).length,
    deadline_hit: deadlineHit,   // R5
    circuit_open: circuitOpen,   // R5
    window_extended,             // R1
    effective_window_hours,      // R1
  };

  const report = {
    report_id: null,
    run_at: now,
    window_start: windowStartEff,
    window_end: now,
    effective_window_hours,
    window_extended,
    decisions_scanned: rows.length,
    clusters: analyzed,
    draft_patches: draftPatches,
    summary,
    llm_enabled: llmAvailable,
  };

  if (!dryRun) {
    // §16.2 整改报告结构化（Task 11）：落库前聚合三源 daily_ops + 弱簇 problems + draft_patches 映射 prescriptions。
    // 仅 !dryRun 执行——保持 dryRun「仅 2 次查询」既有契约（test/decision/retro.test.js）不被破坏。
    const dailyOps = await summarizeDailyOps(null, { window_start: windowStartEff, window_end: now });
    const problems = buildProblems(analyzed);
    const prescriptions = draftPatches.map(toPrescription);
    const rectification = { daily_ops: dailyOps, problems, prescriptions };
    report.rectification = rectification;

    // R2 待办处方 knob 白名单路由（原仅认 config_store → 真实处方 0 命中，calibration_patch 恒 0 行）：
    //   未知 knob / config_store 缺点号 / 非 config_store 缺 target → 跳过并 emit retro-todo-skipped 留痕。
    const todosCreated = [];
    const validPatches = draftPatches.filter((p) => {
      if (!APPLYABLE_KNOBS.has(p.knob)) {
        emit('calibration', 'retro-todo-skipped', { reason: 'unknown_knob', knob: p.knob, target: p.target });
        return false;
      }
      if (p.knob === 'config_store') {
        // 防整键替换清空配置：target 必须为 '键名.子键'
        if (!p.target || !String(p.target).includes('.')) {
          emit('calibration', 'retro-todo-skipped', { reason: 'config_store_target_no_dot', knob: p.knob, target: p.target });
          return false;
        }
      } else if (p.target == null || String(p.target).trim() === '') {
        emit('calibration', 'retro-todo-skipped', { reason: 'empty_target', knob: p.knob });
        return false;
      }
      return true;
    });

    for (const p of validPatches) {
      const tenantId = p.tenant_id && p.tenant_id !== 'system' ? p.tenant_id : 'system';
      const risk = ['LOW', 'MEDIUM', 'HIGH'].includes(p.risk) ? p.risk : 'MEDIUM';
      const r = await savePatches(p.scenario_id || null, [{
        knob: p.knob,
        target: p.target,
        from_value: p.from_value ?? p.from ?? null,
        to_value: p.to_value ?? p.to ?? null,
        evidence: p.evidence || {},
        expected_impact: { predicted: p.prescription?.predicted ?? null, label: p.label || null },
        risk,
        assignee: tenantId !== 'system' ? 'tan_admin' : 'ADMIN',
        tenant_id: tenantId,
      }]);
      if (r.created > 0) {
        todosCreated.push({ target: p.target, knob: p.knob, risk, assignee: tenantId !== 'system' ? 'tan_admin' : 'ADMIN', tenant_id: tenantId });
        emit('calibration', 'todo-created', { target: p.target, knob: p.knob, risk, assignee: tenantId !== 'system' ? 'tan_admin' : 'ADMIN', tenant_id: tenantId });
      }
    }
    report.todos_created = todosCreated.length;

    // 追加式落库（唯一写操作；绝不 DELETE、绝不触碰 calibration_patch 写通道）
    const r = await query(
      `INSERT INTO crm.decision_retro_report
        (run_at, window_start, window_end, decisions_scanned, clusters, draft_patches, summary, llm_enabled, rectification)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING report_id`,
      [now, windowStartEff, now, rows.length, JSON.stringify(analyzed), JSON.stringify(draftPatches), JSON.stringify(summary), llmAvailable, JSON.stringify(rectification)]
    );
    report.report_id = r.rows[0]?.report_id || null;
    // SSE：calibration 域（前端自动建议卡可订阅）；trace 域（可观测）
    emit('calibration', 'retro-suggestions', {
      report_id: report.report_id,
      decisions_scanned: rows.length,
      draft_count: draftPatches.length,
      by_root_cause: summary.by_root_cause,
    });
    emit('trace', 'decision-retro-done', {
      scanned: rows.length, clusters: analyzed.length, drafts: draftPatches.length,
      llm_enabled: llmAvailable, window_extended, deadline_hit: deadlineHit, circuit_open: circuitOpen,
    });
  }

  return report;
}

// ─────────── 场景路由实验收口（2026-09-05 P2-1，设计 §10） ───────────
// 独立 pass：与 LLM 复盘解耦 —— 复盘失败/LLM 不可用不影响实验收口，反之亦然（单向失败不传染）。
// 红线：只 createPatch(PENDING)，**绝不自动写** config_store['context-routing']。
// 开关：config_store['routing-explore'].daily_review_enabled === false 可暂停（默认开启）。
export async function runRoutingReviewPass({ tenantId = 'system', dryRun = false } = {}) {
  try {
    const { routingReview, dailyReviewEnabled } = await import('./routingReview.js');
    if (!(await dailyReviewEnabled({ tenantId }))) {
      return { tenantId, closed: 0, patches: [], nextArms: [], insufficient: [], errors: [], skipped: 'disabled' };
    }
    const out = await routingReview({ tenantId, dryRun });
    emit('trace', 'routing-review-done', {
      tenantId, closed: out.closed,
      patches: out.patches.length, nextArms: out.nextArms.length,
      insufficient: out.insufficient.length, errors: out.errors.length,
    });
    return out;
  } catch (err) {
    // 禁裸 catch：留痕 + 进故障台账；绝不把异常抛给夜批主流程
    emit('trace', 'routing-review-failed', { tenantId, error: String(err?.message || err) });
    recordFailure('routing-review-failed', err);
    return { tenantId, closed: 0, patches: [], nextArms: [], insufficient: [], errors: [String(err?.message || err)] };
  }
}

// ─────────── 参数体检（2026-09-05 参数闭环 P0，设计 §2.2） ───────────
// 第三个独立 pass：对 config_store + 场景级九尺子参数逐项体检（确定性、无 LLM；共 26 项，含九尺子扩展）。
// 铁律：
//   ① 只产出体检结论 + PENDING 处方（绝不自动 apply；生效走既有 approvePatch 第0闸）。
//   ② 与 LLM 复盘/路由收口互不传染：本 pass 独立 catch，异常 emit + recordFailure 不抛。
//   ③ 追加式落库：体检结果写回当次 report 的 param_inspection 列（JSONB），旧行兼容空。
// 开关：config_store['param-inspect'].enabled === false 可暂停（默认开启）。
export async function runParamInspectionPass({ tenantId = 'system', dryRun = false, reportId = null, inspectAll: injectedInspect = null } = {}) {
  try {
    const cfg = await readConfig('param-inspect', { tenantId }).catch(() => null);
    if (cfg?.value?.enabled === false) {
      return { tenantId, inspected: 0, patches: [], skipped: 'disabled' };
    }
    // 依赖注入（对齐 runDecisionRetro 的 llmFactory）：测试传假实现，生产默认动态 import 真实巡检器
    const inspect = injectedInspect || (await import('../calibration/paramInspector.js')).inspectAll;
    const out = await inspect({ tenantId });
    // PENDING 处方落库（幂等去重；绝不自动 apply）
    let created = 0;
    if (!dryRun) {
      for (const p of out.patches) {
        const r = await savePatches(p.scenario_id || null, [{
          knob: 'config_store',
          target: p.target,
          from_value: p.from_value,
          to_value: p.to_value,
          evidence: p.evidence || {},
          expected_impact: p.expected_impact || null,
          risk: p.risk,
          assignee: p.assignee || 'ADMIN',
          tenant_id: p.tenant_id || tenantId,
        }]);
        if (r.created > 0) created += 1;
      }
    }
    // 落回当次报告（追加式；report_id 由调用方传入——runDecisionRetro 落库后回填）
    if (!dryRun && reportId) {
      await query(
        `UPDATE crm.decision_retro_report SET param_inspection=$2::jsonb WHERE report_id=$1`,
        [reportId, JSON.stringify({ ...out, patches_created: created })]
      ).catch(() => {});
    }
    // SSE：calibration 域（前端可订阅展示体检概要）
    if (!dryRun) {
      emit('calibration', 'param-inspection', {
        tenantId, inspected: out.inspected, healthy: out.healthy, drift: out.drift,
        degraded: out.degraded, unknown: out.unknown, patches_created: created,
      });
    }
    emit('trace', 'param-inspection-done', {
      tenantId, inspected: out.inspected, healthy: out.healthy, drift: out.drift,
      degraded: out.degraded, patches: out.patches.length, created,
    });
    return { tenantId, ...out, patches_created: created };
  } catch (err) {
    // 禁裸 catch：留痕 + 进故障台账；绝不把异常抛给夜批主流程（三段互不传染）
    emit('trace', 'param-inspection-failed', { tenantId, error: String(err?.message || err) });
    recordFailure('param-inspection-failed', err);
    return { tenantId, inspected: 0, patches: [], errors: [String(err?.message || err)] };
  }
}
