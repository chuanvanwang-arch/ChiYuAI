// src/context/routingExperiment.js — 场景路由时间片 A/B 实验（2026-09-05 P1，设计 §5）
//
// 红线（设计 §0）：本模块**绝不写** config_store['context-routing']。
//   实验臂只在装配期做**运行时覆盖**（tracks 加减一项），配置原值一字不动；
//   结论只出 calibration_patch PENDING 处方，人工批准 + 第0闸后才写配置。
//
// 存在理由（设计 §1 缺口 C）：routing 是确定性配置 —— 场景 tracks 不含 narrative 就**永远**不注入，
//   「注入 vs 不注入」的对照组恒空 → 反推在数学上不可能。时间片轮换是唯一能产生反事实样本的可解释方案。
//
// 铁律：
//   ① fail-open —— 实验表读取/解析失败 → 按配置原样，绝不阻断装配。
//   ② 禁裸 catch —— 所有失败路径 emit('trace') + recordFailure。
//   ③ 阈值配置化 —— 窗口天数/并发上限/黑名单走 config_store['routing-explore']，出厂兜底。
//   ④ 禁 DELETE —— 实验表 append-only，收口改 status。
import { query, queryWrite } from '../db.js';
import { emit } from '../events/bus.js';
import { readConfig } from '../config/configStore.js';

// 出厂兜底（阈值配置化铁律：禁散点硬编码；config_store['routing-explore'] 可覆盖）
export const DEFAULT_EXPLORE_CFG = {
  window_days: 14,          // 时间片长度
  max_running: 2,           // 全局同时 running 上限
  blacklist: ['QUOTE_PRICING', 'SIGN_RISK'], // 高风险场景默认不实验（错配上下文代价高）
  min_arm_sample: 20,       // 单臂最小样本（P1-4 判据用）
};

export async function readExploreConfig({ tenantId = 'system' } = {}) {
  try {
    const cfg = await readConfig('routing-explore', { tenantId });
    const v = cfg?.value && typeof cfg.value === 'object' ? cfg.value : {};
    return {
      window_days: Number(v.window_days) > 0 ? Number(v.window_days) : DEFAULT_EXPLORE_CFG.window_days,
      max_running: Number(v.max_running) > 0 ? Number(v.max_running) : DEFAULT_EXPLORE_CFG.max_running,
      min_arm_sample: Number(v.min_arm_sample) > 0 ? Number(v.min_arm_sample) : DEFAULT_EXPLORE_CFG.min_arm_sample,
      blacklist: Array.isArray(v.blacklist) ? v.blacklist : DEFAULT_EXPLORE_CFG.blacklist,
    };
  } catch (e) {
    emit('trace', 'routing-explore-config-fail', { tenantId, error: String(e?.message || e) });
    return { ...DEFAULT_EXPLORE_CFG };
  }
}

// ─────────────────── 纯函数：实验臂覆盖（易测，零 IO） ───────────────────
// arm='on'  → tracks ∪ {track}
// arm='off' → tracks \ {track}
// 无实验 / 参数非法 → 原样返回（fail-open）
export function applyExperimentArm(tracks, exp) {
  const base = Array.isArray(tracks) ? [...tracks] : [];
  if (!exp || !exp.track || (exp.arm !== 'on' && exp.arm !== 'off')) return base;
  const set = new Set(base);
  if (exp.arm === 'on') set.add(exp.track);
  else set.delete(exp.track);
  return [...set];
}

// ─────────────────── 读当前生效实验（fail-open） ───────────────────
export async function resolveActiveArm(scenarioId, { tenantId = 'system' } = {}) {
  if (!scenarioId) return null;
  try {
    const r = await query(
      `SELECT experiment_id, scenario_id, track, arm, baseline, window_start, window_end, status
         FROM crm.routing_experiment
        WHERE tenant_id=$1 AND scenario_id=$2 AND status='running'
          AND now() BETWEEN window_start AND window_end
        ORDER BY created_at DESC LIMIT 1`,
      [tenantId, scenarioId]
    );
    return r.rows[0] || null;
  } catch (e) {
    // 实验表不可用 ≠ 装配失败：按配置原样继续（fail-open），但必须留痕
    emit('trace', 'routing-experiment-read-failed', { scenarioId, tenantId, error: String(e?.message || e) });
    try {
      const { recordFailure } = await import('../monitor/monitorStore.js');
      recordFailure('routing-experiment-read-failed', e);
    } catch { /* 监控不可用不阻断 */ }
    return null;
  }
}

// ─────────────────── 建实验（第0闸 + 守卫） ───────────────────
// 返回 { ok:true, experiment } 或 { ok:false, reason }（不抛错，便于调用方处理）
export async function createExperiment({
  scenarioId, track = 'narrative', arm, tenantId = 'system', createdBy = null, windowDays = null,
} = {}) {
  if (!scenarioId) return { ok: false, reason: 'scenario_id 必填' };
  if (arm !== 'on' && arm !== 'off') return { ok: false, reason: "arm 须为 'on'|'off'" };

  const cfg = await readExploreConfig({ tenantId });
  // 守卫 1：黑名单（报价/签单风险场景错配上下文代价高）
  if (cfg.blacklist.includes(scenarioId)) {
    return { ok: false, reason: `场景 ${scenarioId} 在实验黑名单内（需显式配置放行）` };
  }
  // 守卫 2：单场景同时只允许 1 个进行中实验（防同场景多臂互相污染）
  try {
    const dup = await query(
      `SELECT experiment_id FROM crm.routing_experiment
        WHERE tenant_id=$1 AND scenario_id=$2 AND status IN ('planned','running') LIMIT 1`,
      [tenantId, scenarioId]
    );
    if (dup.rows.length) return { ok: false, reason: `场景 ${scenarioId} 已有进行中实验` };
    // 守卫 3：全局并发上限
    const run = await query(
      `SELECT COUNT(*)::int AS n FROM crm.routing_experiment
        WHERE tenant_id=$1 AND status='running'`, [tenantId]
    );
    if (Number(run.rows[0]?.n || 0) >= cfg.max_running) {
      return { ok: false, reason: `全局 running 已达上限 ${cfg.max_running}` };
    }
  } catch (e) {
    emit('trace', 'routing-experiment-guard-failed', { scenarioId, error: String(e?.message || e) });
    return { ok: false, reason: `守卫查询失败：${e?.message || e}` };
  }

  // baseline = 配置原值（该 track 当前是否启用）
  let baseline = null;
  try {
    const { resolveTracks } = await import('./routing.js');
    const rt = await resolveTracks(scenarioId, { tenantId });
    baseline = Array.isArray(rt?.tracks) && rt.tracks.includes(track) ? 'on' : 'off';
  } catch (e) {
    emit('trace', 'routing-experiment-baseline-failed', { scenarioId, error: String(e?.message || e) });
    return { ok: false, reason: `baseline 解析失败：${e?.message || e}` };
  }
  // 守卫 4（核心）：实验臂必须反转配置原值，否则无对照价值（"假实验"假绿）
  if (arm === baseline) {
    return { ok: false, reason: `arm(${arm}) 与配置原值 baseline(${baseline}) 相同，无对照价值` };
  }

  // 第0闸：创建真实决策产证（动态 import 避免 context↔calibration 静态环）
  let decisionId = null;
  try {
    const { produceDecision } = await import('../calibration/store.js');
    const d = await produceDecision({
      fields: [`routing_experiment:${scenarioId}:${track}:${arm}`],
      by_role: 'sysadmin', by_id: createdBy,
    });
    decisionId = d?.decisionId || null;
  } catch (e) {
    emit('trace', 'routing-experiment-decision-failed', { scenarioId, error: String(e?.message || e) });
    return { ok: false, reason: `第0闸未通过：${e?.message || e}` };
  }

  const days = Number(windowDays) > 0 ? Number(windowDays) : cfg.window_days;
  try {
    const r = await queryWrite(
      `INSERT INTO crm.routing_experiment
         (tenant_id, scenario_id, track, arm, baseline, window_start, window_end, status, decision_id, created_by)
       VALUES ($1,$2,$3,$4,$5, now(), now() + make_interval(days => $6), 'running', $7, $8)
       RETURNING *`,
      [tenantId, scenarioId, track, arm, baseline, days, decisionId, createdBy]
    );
    return { ok: true, experiment: r.rows[0] };
  } catch (e) {
    emit('trace', 'routing-experiment-create-failed', { scenarioId, error: String(e?.message || e) });
    return { ok: false, reason: `建实验失败：${e?.message || e}` };
  }
}

// 收口/翻臂：只改 status 或插新行，**绝不删行**（禁 DELETE）
export async function closeExperiment(experimentId, status = 'done') {
  if (!['done', 'aborted'].includes(status)) return { ok: false, reason: 'status 须为 done|aborted' };
  try {
    await queryWrite(`UPDATE crm.routing_experiment SET status=$2 WHERE experiment_id=$1`, [experimentId, status]);
    return { ok: true };
  } catch (e) {
    emit('trace', 'routing-experiment-close-failed', { experimentId, error: String(e?.message || e) });
    return { ok: false, reason: String(e?.message || e) };
  }
}
