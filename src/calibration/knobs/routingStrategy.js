// src/calibration/knobs/routingStrategy.js — 场景路由旋钮策略（2026-09-05 P1-5，设计 §8）
//
// 三个旋钮，落点**全部**是 config_store['context-routing']：
//   routing_tracks     target=场景键   to_value={ tracks:[...] }   → scene_matrix[场景].tracks
//   routing_weight     target=维度 id  to_value={ weight:0.35 }    → dims[].weight（改后归一化到 1）
//   routing_threshold  target=graph|story to_value={ graph:0.55 }  → thresholds.{graph,story}
//
// 红线（设计 §0 / 2026-09-04 用户明令）：
//   ① 本模块**只在人工批准处方时被调用**（approvePatch/rollbackPatch 事务内）。
//      系统任何自动路径（routingReview / retro / agent）都不得直接调 apply —— 只出 PENDING 处方。
//   ② 写必经第0闸：decision_id 由 store.js 产生后透传，随 value 一起写入，可回溯。
//   ③ 禁 DELETE / 禁整键覆盖：未知键原样保留（extra 透传），只改目标子结构。
//
// 安全护栏（防"合法但危险"的批准）：
//   - tracks：白名单（TRACKS 全集）+ 非空。
//   - weight：单步 ≤ weight_step_max（出厂 0.05，可配）+ 改后整体归一化为 1 + 30 天冷却。
//   - threshold：graph - story ≥ min_gap（出厂 0.05，可配），防双阈值交叉导致分型塌陷。
//   - 回滚（ctx.rollback=true）豁免步进与冷却 —— 回滚是恢复已知安全态，不属于"再调一次"。
import { query } from '../../db.js';
import { emit } from '../../events/bus.js';
import { readConfig } from '../../config/configStore.js';
import {
  ROUTING_KEY, DEFAULT_DIMS, DEFAULT_SCENE_MATRIX, DEFAULT_THRESHOLDS, DEFAULT_TRACKS_ARR,
  classifyScene,
} from '../../context/routing.js';
import { KnobStrategy } from './base.js';

export const CALIB_CFG_KEY = 'routing-calibration';

// 出厂兜底（阈值配置化铁律：禁散点硬编码；config_store['routing-calibration'] 可覆盖）
export const DEFAULT_CALIB_CFG = {
  weight_step_max: 0.05, // 单场景单维权重一次最多挪多少
  cooldown_days: 30,     // 同 knob+target 两次生效之间最短间隔
  min_gap: 0.05,         // thresholds.graph - thresholds.story 最小间隔
};

export async function readCalibCfg({ tenantId = 'system' } = {}) {
  try {
    const rec = await readConfig(CALIB_CFG_KEY, { tenantId });
    const v = rec?.value && typeof rec.value === 'object' ? rec.value : {};
    // Number(null)===0 且 isFinite(0)===true → 必须先排 null/undefined，否则显式 null 会把阈值静默置 0
    const n = (x, d) => (x !== null && x !== undefined && Number.isFinite(Number(x)) ? Number(x) : d);
    return {
      weight_step_max: n(v.weight_step_max, DEFAULT_CALIB_CFG.weight_step_max),
      cooldown_days: n(v.cooldown_days, DEFAULT_CALIB_CFG.cooldown_days),
      min_gap: n(v.min_gap, DEFAULT_CALIB_CFG.min_gap),
    };
  } catch (e) {
    emit('trace', 'routing-calibration-config-fail', { tenantId, error: String(e?.message || e) });
    return { ...DEFAULT_CALIB_CFG };
  }
}

function clone(o) { return JSON.parse(JSON.stringify(o)); }

// 读路由配置的「可写视图」：
//   - dims / thresholds 缺段用出厂兜底补齐（与 routing.js loadRouting 同口径）。
//   - scene_matrix 与出厂矩阵**深合并**（出厂物化，保证只改一个场景不影响其它场景的既有判定）。
//     说明：首次写场景轨道会把出厂矩阵落进配置（显式优于隐式）；此后出厂矩阵演进需人工同步。
//   - extra 保留未识别键，写回时原样透传（禁整键覆盖）。
async function loadWritable(tenantId = 'system') {
  const rec = await readConfig(ROUTING_KEY, { tenantId });
  const v = rec?.value && typeof rec.value === 'object' ? rec.value : {};
  return {
    extra: { ...v },
    dims: Array.isArray(v.dims) && v.dims.length ? clone(v.dims) : clone(DEFAULT_DIMS),
    scene_matrix: {
      ...clone(DEFAULT_SCENE_MATRIX),
      ...(v.scene_matrix && typeof v.scene_matrix === 'object' ? clone(v.scene_matrix) : {}),
    },
    thresholds: {
      ...DEFAULT_THRESHOLDS,
      ...(v.thresholds && typeof v.thresholds === 'object' ? v.thresholds : {}),
    },
  };
}

// 事务内写回（必须传 client：approvePatch 在 withTx 内执行原子写）
async function writeRouting(client, tenantId, decisionId, next) {
  const payload = { ...next.extra, dims: next.dims, scene_matrix: next.scene_matrix, thresholds: next.thresholds };
  await client.query(
    `INSERT INTO crm.config_store (tenant_id, key, value, decision_id, updated_by, updated_at)
     VALUES ($1,$2,$3::jsonb,$4,'calibration',now())
     ON CONFLICT (tenant_id, key) DO UPDATE SET value=$3::jsonb, decision_id=$4, updated_at=now()`,
    [tenantId, ROUTING_KEY, JSON.stringify(payload), decisionId || null]
  );
  return payload;
}

// ─────────────────── 纯函数：权重归一化（易测，零 IO） ───────────────────
// 设定 target 维为新权重后，其余维按原比例缩放，使总和恒为 1（末位吸收舍入残差）。
export function normalizeDims(dims, targetId, newWeight) {
  const base = Array.isArray(dims) ? dims.map((d) => ({ ...d })) : [];
  const idx = base.findIndex((d) => d.id === targetId);
  if (idx < 0) throw new Error(`normalizeDims: 未知道路维度 ${targetId}`);
  const w = Math.min(1, Math.max(0, Number(newWeight) || 0));
  base[idx] = { ...base[idx], weight: round4(w) };
  const others = base.map((_, i) => i).filter((i) => i !== idx);
  const rest = 1 - round4(w);
  if (!others.length) return base;
  const sum = others.reduce((s, i) => s + (Number(base[i].weight) || 0), 0);
  if (sum <= 0) {
    // 其余维全为 0（或非法）→ 均分，避免除零与"权重永远回不来"
    const each = round4(rest / others.length);
    others.forEach((i) => { base[i].weight = each; });
  } else {
    others.forEach((i) => { base[i].weight = round4(((Number(base[i].weight) || 0) / sum) * rest); });
  }
  // 残差归末位（保证 sum===1，避免累积漂移）
  const total = base.reduce((s, d) => s + (Number(d.weight) || 0), 0);
  const last = others[others.length - 1];
  base[last].weight = round4((Number(base[last].weight) || 0) + (1 - total));
  return base;
}
function round4(n) { return Math.round((Number(n) || 0) * 10000) / 10000; }

// ─────────────────── 纯函数：影子重放（分型迁移，零 IO） ───────────────────
// 用候选配置重算所有场景的 mode，列出会翻转分型的场景 —— 这是批准前唯一的确定性影响面。
export function diffModes(fromCfg, toCfg) {
  const matrix = { ...(toCfg?.scene_matrix || {}), ...(fromCfg?.scene_matrix || {}) };
  const changed = [];
  for (const s of Object.keys(matrix)) {
    const a = classifyScene(s, fromCfg) || { mode: 'UNKNOWN', score: 0 };
    const b = classifyScene(s, toCfg) || { mode: 'UNKNOWN', score: 0 };
    if (a.mode !== b.mode) changed.push({ scenario: s, from: a.mode, to: b.mode, score_from: a.score, score_to: b.score });
  }
  return { total: Object.keys(matrix).length, changed };
}

// ─────────────────── 冷却闸门（生成侧 + apply 侧共用） ───────────────────
// 同 knob+target 在 cooldown_days 内已有 APPLIED 生效记录 → 不再出/不再应用新处方。
// 回滚豁免（ctx.rollback / opts.rollback）：回滚是恢复已知安全态，不是"再调一次"。
export async function checkCooldown({ knob, target = null, tenantId = 'system', patchId = null, days = null, client = null, rollback = false } = {}) {
  if (rollback) return { ok: true, days: 0, last: null, skipped: 'rollback' };
  const cfg = await readCalibCfg({ tenantId });
  // 注意：Number(null)===0 且 isFinite(0)===true —— 若只判 Number.isFinite，days=null 会把冷却期静默变成 0（闸门失效）。
  //   必须先判 null/undefined，再判有限性。
  const d = days !== null && days !== undefined && Number.isFinite(Number(days)) ? Number(days) : cfg.cooldown_days;
  if (!Number.isFinite(d)) return { ok: false, days: cfg.cooldown_days, last: null, error: `非法冷却天数：${days}` };
  if (!(d > 0)) return { ok: true, days: d, last: null, skipped: 'disabled' };
  const sql = `SELECT patch_id, resolved_at, status FROM crm.calibration_patch
                WHERE knob=$1 AND target IS NOT DISTINCT FROM $2
                  AND tenant_id IS NOT DISTINCT FROM $3 AND status='APPLIED'
                  AND resolved_at > now() - make_interval(days => $4)
                  AND ($5::bigint IS NULL OR patch_id <> $5::bigint)
                ORDER BY resolved_at DESC LIMIT 1`;
  const params = [knob, target, tenantId, Math.round(d), patchId];
  try {
    const r = client ? await client.query(sql, params) : await query(sql, params);
    return { ok: r.rows.length === 0, days: d, last: r.rows[0] || null };
  } catch (e) {
    // 冷却查不到 ≠ 放行：留痕并判为冷却中（fail-closed，宁可不批准）
    emit('trace', 'routing-cooldown-check-failed', { knob, target, tenantId, error: String(e?.message || e) });
    return { ok: false, days: d, last: null, error: String(e?.message || e) };
  }
}

// ═══════════════════ routing_tracks ═══════════════════
export class RoutingTracksStrategy extends KnobStrategy {
  async readCurrent(ctx = {}) {
    const s = await loadWritable(ctx.tenantId || 'system');
    const row = s.scene_matrix?.[ctx.target];
    return { tracks: Array.isArray(row?.tracks) ? [...row.tracks] : null, dims: row?.dims ? { ...row.dims } : null };
  }

  async apply(client, toValue, ctx = {}) {
    const tenantId = ctx.tenantId || 'system';
    const scenario = ctx.target;
    if (!scenario) throw new Error('routing_tracks: target（场景键）必填');

    const tracks = Array.isArray(toValue?.tracks) ? toValue.tracks : (Array.isArray(toValue) ? toValue : null);
    if (!Array.isArray(tracks) || !tracks.length) throw new Error('routing_tracks: to_value.tracks 须为非空数组');
    const bad = tracks.filter((t) => !DEFAULT_TRACKS_ARR.includes(t));
    if (bad.length) throw new Error(`routing_tracks: 未知轨道 ${bad.join(',')}（允许 ${DEFAULT_TRACKS_ARR.join('/')}）`);

    const s = await loadWritable(tenantId);
    // 保留该场景既有 dims（分型判定不受改轨道影响），只覆盖 tracks
    s.scene_matrix = { ...s.scene_matrix, [scenario]: { ...(s.scene_matrix[scenario] || {}), tracks: [...tracks] } };
    return writeRouting(client, tenantId, ctx.decisionId, s);
  }

  async replayImpact(ctx, toValue) {
    const tenantId = ctx.tenantId || 'system';
    const s = await loadWritable(tenantId);
    const from = s.scene_matrix?.[ctx.target]?.tracks || [];
    const to = Array.isArray(toValue?.tracks) ? toValue.tracks : (Array.isArray(toValue) ? toValue : []);
    return {
      knob: this.knob, scenario: ctx.target,
      from_tracks: from, to_tracks: to,
      added: to.filter((t) => !from.includes(t)),
      removed: from.filter((t) => !to.includes(t)),
      note: '轨道变更只影响装配注入面（叙事/图谱/结构化），不改变 L1–L4 层级检索；mode 分型由 dims 决定，不受此旋钮影响',
    };
  }

  riskLevel() { return 'MEDIUM'; }
}

// ═══════════════════ routing_weight ═══════════════════
export class RoutingWeightStrategy extends KnobStrategy {
  async readCurrent(ctx = {}) {
    const s = await loadWritable(ctx.tenantId || 'system');
    const d = (s.dims || []).find((x) => x.id === ctx.target);
    return { weight: d ? Number(d.weight) : null, dims: s.dims.map((x) => ({ id: x.id, weight: Number(x.weight) })) };
  }

  async apply(client, toValue, ctx = {}) {
    const tenantId = ctx.tenantId || 'system';
    const dimId = ctx.target;
    if (!dimId) throw new Error('routing_weight: target（维度 id）必填');

    const raw = toValue && typeof toValue === 'object' && !Array.isArray(toValue) ? toValue.weight : toValue;
    const w = Number(raw);
    if (!Number.isFinite(w) || w < 0 || w > 1) throw new Error(`routing_weight: 权重须在 [0,1]，收到 ${raw}`);

    const s = await loadWritable(tenantId);
    const dim = (s.dims || []).find((x) => x.id === dimId);
    if (!dim) {
      throw new Error(`routing_weight: 未知道路维度 ${dimId}（现有 ${(s.dims || []).map((x) => x.id).join('/')}；新增维度属元模型变更，走 ATTR_SCHEMA_CHANGE）`);
    }

    const cfg = await readCalibCfg({ tenantId });
    if (!ctx.rollback) {
      const from = Number(dim.weight);
      if (Number.isFinite(from) && Math.abs(w - from) > cfg.weight_step_max + 1e-9) {
        throw new Error(`routing_weight: 单步调整 ${from}→${w} 超过上限 ${cfg.weight_step_max}（分多次小步走，每步都要有证据）`);
      }
      const cd = await checkCooldown({ knob: this.knob, target: dimId, tenantId, patchId: ctx.patchId || null, client });
      if (!cd.ok) throw new Error(`routing_weight: 冷却期内（${cd.days} 天）已有生效处方，拒绝再次调整`);
    }

    s.dims = normalizeDims(s.dims, dimId, w);
    return writeRouting(client, tenantId, ctx.decisionId, s);
  }

  async replayImpact(ctx, toValue) {
    const tenantId = ctx.tenantId || 'system';
    const s = await loadWritable(tenantId);
    const raw = toValue && typeof toValue === 'object' && !Array.isArray(toValue) ? toValue.weight : toValue;
    const w = Number(raw);
    if (!Number.isFinite(w)) return { knob: this.knob, target: ctx.target, error: `非法权重 ${raw}` };
    const dim = (s.dims || []).find((x) => x.id === ctx.target);
    if (!dim) return { knob: this.knob, target: ctx.target, error: `未知道路维度 ${ctx.target}` };
    const fromCfg = { dims: s.dims, scene_matrix: s.scene_matrix, thresholds: s.thresholds };
    const toCfg = { dims: normalizeDims(s.dims, ctx.target, w), scene_matrix: s.scene_matrix, thresholds: s.thresholds };
    return {
      knob: this.knob, target: ctx.target,
      from_weight: Number(dim.weight), to_weight: w,
      normalized_dims: toCfg.dims.map((d) => ({ id: d.id, weight: d.weight })),
      ...diffModes(fromCfg, toCfg),
      note: '影子重放=用候选权重重算全场景分型；changed 非空说明会影响场景路由结果，需人工确认',
    };
  }

  riskLevel() { return 'HIGH'; }
}

// ═══════════════════ routing_threshold ═══════════════════
export class RoutingThresholdStrategy extends KnobStrategy {
  async readCurrent(ctx = {}) {
    const s = await loadWritable(ctx.tenantId || 'system');
    const t = s.thresholds || {};
    return { thresholds: { graph: Number(t.graph), story: Number(t.story) } };
  }

  async apply(client, toValue, ctx = {}) {
    const tenantId = ctx.tenantId || 'system';
    const key = ctx.target;
    if (key !== 'graph' && key !== 'story') throw new Error(`routing_threshold: target 须为 graph|story，收到 ${key}`);

    const raw = toValue && typeof toValue === 'object' && !Array.isArray(toValue) ? (toValue[key] ?? toValue.threshold) : toValue;
    const v = Number(raw);
    if (!Number.isFinite(v) || v < 0 || v > 1) throw new Error(`routing_threshold: ${key} 须在 [0,1]，收到 ${raw}`);

    const s = await loadWritable(tenantId);
    const cand = { ...s.thresholds, [key]: v };
    const cfg = await readCalibCfg({ tenantId });
    const gap = Number(cand.graph) - Number(cand.story);
    if (!(gap >= cfg.min_gap)) {
      throw new Error(`routing_threshold: graph(${cand.graph}) - story(${cand.story}) = ${gap} < 最小间隔 ${cfg.min_gap}（双阈值交叉会导致分型塌陷）`);
    }

    if (!ctx.rollback) {
      const cd = await checkCooldown({ knob: this.knob, target: key, tenantId, patchId: ctx.patchId || null, client });
      if (!cd.ok) throw new Error(`routing_threshold: 冷却期内（${cd.days} 天）已有生效处方，拒绝再次调整`);
    }

    s.thresholds = cand;
    return writeRouting(client, tenantId, ctx.decisionId, s);
  }

  async replayImpact(ctx, toValue) {
    const tenantId = ctx.tenantId || 'system';
    const s = await loadWritable(tenantId);
    const key = ctx.target;
    const raw = toValue && typeof toValue === 'object' && !Array.isArray(toValue) ? (toValue?.[key] ?? toValue.threshold) : toValue;
    const v = Number(raw);
    if (!Number.isFinite(v)) return { knob: this.knob, target: key, error: `非法阈值 ${raw}` };
    const fromCfg = { dims: s.dims, scene_matrix: s.scene_matrix, thresholds: s.thresholds };
    const toCfg = { dims: s.dims, scene_matrix: s.scene_matrix, thresholds: { ...s.thresholds, [key]: v } };
    return {
      knob: this.knob, target: key,
      from_threshold: Number(s.thresholds?.[key]), to_threshold: v,
      ...diffModes(fromCfg, toCfg),
      note: '阈值下调=更多场景落 BOTH（全轨安全）；上调=更多场景被二分（省 token 但可能漏上下文）',
    };
  }

  riskLevel() { return 'HIGH'; }
}
