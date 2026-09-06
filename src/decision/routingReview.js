// src/decision/routingReview.js — 场景路由实验：聚合 + 反推判据 + 每日收口（2026-09-05，设计 §6/§7/§10）
//
// 定位：把「某场景注入叙事后决策质量分是否提升」变成**可判定的确定性结论**，产出 PENDING 处方。
// 红线（设计 §0）：本模块**绝不自动写** config_store['context-routing'] —— 只 createPatch(PENDING)，
//   人工批准 + 第0闸后才由旋钮策略 apply。
//
// 三取二判据（§7.1）：ΔQ（质量）/ ΔO（业务结果）/ ΔR（人机覆写率）至少两项显著且符号一致才出结论；
//   样本不足（任一组 < min_arm_sample）→ 明确判 insufficient_evidence，**不硬凑结论**（对齐 retro.js R6 守卫精神）。
// 全确定性算法（无 LLM）：可复现、可回归。
import { query, queryWrite } from '../db.js';
import { emit } from '../events/bus.js';
import { readConfig } from '../config/configStore.js';

// 出厂兜底（阈值配置化铁律：config_store['routing-explore'] 可覆盖）
export const DEFAULT_JUDGE_CFG = {
  q_eps: 0.05,           // 质量分显著阈值
  o_eps: 0.10,           // 业务结果显著阈值
  r_eps: 0.05,           // 覆写率改善阈值（ΔR ≤ -r_eps 为有利）
  min_arm_sample: 20,    // 单臂最小样本
};

export async function readJudgeCfg({ tenantId = 'system' } = {}) {
  try {
    const cfg = await readConfig('routing-explore', { tenantId });
    const v = cfg?.value && typeof cfg.value === 'object' ? cfg.value : {};
    // Number(null)===0 且 isFinite(0)===true → 先排 null/undefined，否则显式 null 会把判据阈值静默置 0（判据失效）
    const n = (x, d) => (x !== null && x !== undefined && Number.isFinite(Number(x)) ? Number(x) : d);
    return {
      q_eps: n(v.q_eps, DEFAULT_JUDGE_CFG.q_eps),
      o_eps: n(v.o_eps, DEFAULT_JUDGE_CFG.o_eps),
      r_eps: n(v.r_eps, DEFAULT_JUDGE_CFG.r_eps),
      min_arm_sample: n(v.min_arm_sample, DEFAULT_JUDGE_CFG.min_arm_sample),
    };
  } catch (e) {
    emit('trace', 'routing-judge-config-fail', { tenantId, error: String(e?.message || e) });
    return { ...DEFAULT_JUDGE_CFG };
  }
}

// ─────────────────── 纯函数：三取二判据（零 IO，易测） ───────────────────
// 入参 on/off = { n, qbar, success_rate, override_rate }
// 返回 { verdict, delta, significant, reason }
//   verdict: 'prefer_on' | 'prefer_off' | 'insufficient'
export function judgeArms(on, off, cfg = DEFAULT_JUDGE_CFG) {
  const c = { ...DEFAULT_JUDGE_CFG, ...(cfg || {}) };
  const empty = { verdict: 'insufficient', delta: null, significant: null, reason: 'no-data' };
  if (!on || !off) return { ...empty, reason: 'missing-arm' };
  if (on.n < c.min_arm_sample || off.n < c.min_arm_sample) {
    return {
      ...empty,
      reason: 'insufficient_evidence',
      samples: { on: on.n, off: off.n, need: c.min_arm_sample },
    };
  }
  const dq = Number(on.qbar) - Number(off.qbar);
  const dO = Number(on.success_rate) - Number(off.success_rate);
  const dR = Number(on.override_rate) - Number(off.override_rate);

  const qSig = Math.abs(dq) >= c.q_eps;
  const oSig = Math.sign(dO) === Math.sign(dq) && dq !== 0 && Math.abs(dO) >= c.o_eps;
  const rSig = dR <= -c.r_eps;
  const significant = { quality: qSig, outcome: oSig, override: rSig };
  const hits = [qSig, oSig, rSig].filter(Boolean).length;

  if (hits < 2) {
    return {
      verdict: 'insufficient',
      delta: { dq, dO, dR },
      significant,
      reason: 'not-significant',
      hits,
    };
  }
  // 符号一致已由 oSig 的同号条件保证；方向以 ΔQ 为准
  return {
    verdict: dq > 0 ? 'prefer_on' : 'prefer_off',
    delta: { dq, dO, dR },
    significant,
    reason: 'significant',
    hits,
  };
}

// ─────────────────── 按 (scenario, track, arm) 聚合质量信号 ───────────────────
// 信号源全部现成：Q=rubric 加权总分 / O=outcome_verified / R=human_disposition≠disposition
export async function aggregateArms(scenarioId, track, { tenantId = 'system', windowStart = null, windowEnd = null } = {}) {
  try {
    const r = await query(
      `SELECT s.routing->>'exp_arm' AS arm,
              COUNT(*)::int AS n,
              AVG(NULLIF(d.rubric->>'weighted_total','')::numeric) AS qbar,
              AVG(CASE WHEN d.outcome_verified IN ('won','partial') THEN 1.0 ELSE 0.0 END) AS success_rate,
              AVG(CASE WHEN d.human_disposition IS NOT NULL AND d.human_disposition <> d.disposition
                       THEN 1.0 ELSE 0.0 END) AS override_rate
         FROM crm.decision d
         JOIN crm.decision_context_snapshot s ON s.decision_id = d.decision_id
        WHERE d.tenant_id = $1
          AND ($2::text IS NULL OR d.scenario_id = $2)
          AND s.routing->>'exp_track' = $3
          AND s.routing->>'exp_arm' IN ('on','off')
          AND ($4::timestamptz IS NULL OR s.created_at >= $4)
          AND ($5::timestamptz IS NULL OR s.created_at <= $5)
        GROUP BY 1`,
      [tenantId, scenarioId || null, track, windowStart, windowEnd]
    );
    const pick = (arm) => {
      const row = r.rows.find((x) => x.arm === arm);
      if (!row) return null;
      return {
        n: Number(row.n) || 0,
        qbar: row.qbar == null ? null : Number(row.qbar),
        success_rate: row.success_rate == null ? 0 : Number(row.success_rate),
        override_rate: row.override_rate == null ? 0 : Number(row.override_rate),
      };
    };
    return { on: pick('on'), off: pick('off') };
  } catch (e) {
    emit('trace', 'routing-aggregate-failed', { scenarioId, track, error: String(e?.message || e) });
    try {
      const { recordFailure } = await import('../monitor/monitorStore.js');
      recordFailure('routing-aggregate-failed', e);
    } catch { /* 监控不可用不阻断 */ }
    return { on: null, off: null };
  }
}

// 每日收口总开关（P2-2）：config_store['routing-explore'].daily_review_enabled === false → 暂停。
// 默认开启 —— 无 running 实验时 routingReview 是空转（扫库返回 0 行即结束），不会产出噪声。
export async function dailyReviewEnabled({ tenantId = 'system' } = {}) {
  try {
    const cfg = await readConfig('routing-explore', { tenantId });
    const v = cfg?.value && typeof cfg.value === 'object' ? cfg.value : {};
    return v.daily_review_enabled !== false;
  } catch (e) {
    emit('trace', 'routing-daily-flag-fail', { tenantId, error: String(e?.message || e) });
    return true; // 读不到开关按开启处理（该 pass 本身是空转安全的）
  }
}

// ─────────────────── 每日收口：到期实验 → 判据 → 处方/补对照 ───────────────────
// 设计 §10：挂每日复盘（timers.js runRetroOnce 之后）。本函数失败仅留痕，不阻断复盘主流程。
export async function routingReview({ tenantId = 'system', dryRun = false } = {}) {
  const cfg = await readJudgeCfg({ tenantId });
  const out = { tenantId, closed: 0, patches: [], nextArms: [], insufficient: [], errors: [] };
  let due = [];
  try {
    const r = await query(
      `SELECT * FROM crm.routing_experiment
        WHERE tenant_id=$1 AND status='running' AND window_end <= now()
        ORDER BY window_end ASC`, [tenantId]
    );
    due = r.rows;
  } catch (e) {
    emit('trace', 'routing-review-scan-failed', { tenantId, error: String(e?.message || e) });
    out.errors.push(String(e?.message || e));
    return out;
  }

  for (const exp of due) {
    try {
      const arms = await aggregateArms(exp.scenario_id, exp.track, {
        tenantId, windowStart: exp.window_start, windowEnd: exp.window_end,
      });
      const j = judgeArms(arms.on, arms.off, cfg);
      out.closed += 1;

      if (j.verdict === 'insufficient') {
        // 证据不足 → 排**反向臂**补对照（禁删原行，append-only 新开一期）
        out.insufficient.push({ scenario_id: exp.scenario_id, track: exp.track, reason: j.reason, samples: j.samples });
        const nextArm = exp.arm === 'on' ? 'off' : 'on';
        if (!dryRun) {
          const { createExperiment } = await import('../context/routingExperiment.js');
          const c = await createExperiment({
            scenarioId: exp.scenario_id, track: exp.track, arm: nextArm, tenantId, createdBy: 'routing-review',
          });
          if (c.ok) out.nextArms.push({ scenario_id: exp.scenario_id, arm: nextArm, experiment_id: c.experiment.experiment_id });
          else out.errors.push(`排反向臂失败 ${exp.scenario_id}: ${c.reason}`);
        } else {
          out.nextArms.push({ scenario_id: exp.scenario_id, arm: nextArm, experiment_id: null, dryRun: true });
        }
      } else {
        // 三取二成立 → 出 routing_tracks 处方（PENDING，人工批准才生效）
        //   实测偏好臂 与 配置原值(baseline) 不同 → 才需要改配置；相同 → 维持现状（配置已经是对的）
        const preferred = j.verdict === 'prefer_on' ? 'on' : 'off';
        if (preferred !== exp.baseline) {
          // to_value 必须是**完整 tracks 数组**（routing_tracks 旋钮 apply 的入参契约），
          //   不能只写 {narrative:'on'} —— 那样批准时会把场景轨道写成非法值。
          //   from_value = 当前配置原值 → 回滚可精确恢复（禁"猜"回滚目标）。
          const { resolveTracks } = await import('../context/routing.js');
          const rt = await resolveTracks(exp.scenario_id, { tenantId });
          const curTracks = Array.isArray(rt?.tracks) ? rt.tracks : [];
          const set = new Set(curTracks);
          if (preferred === 'on') set.add(exp.track); else set.delete(exp.track);
          const toTracks = [...set];

          const patch = {
            scenario_id: exp.scenario_id,
            knob: 'routing_tracks',
            target: exp.scenario_id, // 场景键（routing_tracks 策略按 ctx.target 定位 scene_matrix[target]）
            from_value: { tracks: curTracks },
            to_value: { tracks: toTracks },
            evidence: { experiment_id: exp.experiment_id, arms, delta: j.delta, significant: j.significant, hits: j.hits },
            risk: 'MEDIUM',
            tenant_id: tenantId,
          };
          if (!dryRun) {
            const { createPatch } = await import('../calibration/store.js');
            const row = await createPatch({ ...patch, expected_impact: { note: `场景 ${exp.scenario_id} 的 ${exp.track} 轨道切为 ${preferred}` } });
            out.patches.push({ scenario_id: exp.scenario_id, to: preferred, tracks: toTracks, patch_id: row?.patch_id ?? null });
          } else {
            out.patches.push({ scenario_id: exp.scenario_id, to: preferred, tracks: toTracks, patch_id: null, dryRun: true });
          }
        } else {
          out.patches.push({ scenario_id: exp.scenario_id, to: preferred, skipped: 'already-aligned' });
        }
      }

      // 收口：改 status，不删行（禁 DELETE）
      if (!dryRun) {
        await queryWrite(`UPDATE crm.routing_experiment SET status='done' WHERE experiment_id=$1`, [exp.experiment_id]);
      }
    } catch (e) {
      emit('trace', 'routing-review-exp-failed', { experiment_id: exp.experiment_id, error: String(e?.message || e) });
      out.errors.push(String(e?.message || e));
    }
  }
  return out;
}
