// src/calibration/patchAssembler.js — 处方组装共享模块（HTTP 路由与 MCP 工具共用的单一事实源）
// 设计依据：docs/2026-08-28-decision-quality-calibration-design.md §7 + docs/2026-08-30-j2-j3-comprehensive-design.md L185-L190
// 定位：POST /api/calibration/patches/generate 与 MCP crm_calibration_patch_generate 复用同一条
//   「attribute 处方 →（delta → from/to/target）→ 影子重放预期影响 → 幂等 savePatches」链路，
//   杜绝双口径漂移。守卫命中 → 不出处方（blocked_by）；非 threshold/weight 不自动产出
//   （required_dims 走手动七维页分支：src/http/calibrationRouter.js generateRequiredDims）。
import { replayScenario } from './replay.js';
import { savePatches } from './store.js';

// 入参：{ decisions, metrics, att(attribute() 结果), conf(readConf() 结果), scenario_id,
//        savePatches: doSave(可注入，测试或 MCP 传真实 savePatches),
//        replayScenario: doReplay(可注入) }
// 返回：{ created, skipped_duplicates, blocked_by, metrics, sample, patches(富化未落库形), decisions }
export async function enrichPatchesAndSave({
  decisions, metrics, att, conf, scenario_id,
  savePatches: doSave = savePatches,
  replayScenario: doReplay = replayScenario,
  produceDecision: doProduce = null, // 第0闸：生产路径必传 store.produceDecision；测试注入 mock；缺省 null = 跳过（防注入式测试意外连 DB）
} = {}) {
  if (att.guards?.length) {
    return {
      created: 0, skipped_duplicates: 0,
      blocked_by: att.guards.map((g) => ({ rule_id: g.id, reason: g.reason })),
      metrics, sample: decisions.length, patches: [], decisions,
    };
  }
  if (!att.patches?.length) {
    return { created: 0, skipped_duplicates: 0, blocked_by: [], metrics, sample: decisions.length, patches: [], decisions };
  }
  const baseline = doReplay(decisions, conf);
  const enriched = att.patches
    .map((p) => {
      let target = null;
      let from_value, to_value;
      if (p.knob === 'threshold') {
        from_value = { threshold: conf.threshold };
        to_value = { threshold: conf.threshold + (p.delta.threshold || 0) };
      } else if (p.knob === 'weight') {
        target = Object.keys(p.delta.weights || {})[0];
        from_value = { weights: { [target]: conf.weights[target] } };
        to_value = { weights: { [target]: conf.weights[target] + p.delta.weights[target] } };
      } else {
        return null; // 非 threshold/weight 不自动产出（required_dims 走手动七维页分支）
      }
      const next = { threshold: conf.threshold, weights: { ...conf.weights } };
      if (p.knob === 'threshold') next.threshold = to_value.threshold;
      else if (p.knob === 'weight') next.weights[target] = to_value.weights[target];
      const after = doReplay(decisions, next);
      return {
        ...p,
        knob: p.knob, target,
        from_value, to_value,
        evidence: { rule_id: p.id, reason: p.label, metrics: p.evidence },
        expected_impact: {
          autonomy_before: baseline.autonomy, autonomy_after: after.autonomy,
          escalated_before: baseline.escalated, escalated_after: after.escalated,
          estimated_override_rate: after.estimated_override_rate,
          sample_size: decisions.length,
        },
      };
    })
    .filter(Boolean);
  const valid = enriched.filter((p) => p.knob && p.from_value && p.to_value);
  // T23 第0闸：写处方必经真实决策行（createDecision CALIBRATION_CHANGE 凭证），
  //   doProduce 由调用方显式注入（HTTP/MCP 传 store.produceDecision；测试传 mock；null=跳过）
  const dec = typeof doProduce === 'function' ? await doProduce({ fields: ['calibration_patch'] }) : null;
  const decisionId = dec?.decisionId || null;
  const res2 = await doSave(scenario_id, valid, { decision_id: decisionId });
  return {
    created: res2.created,
    skipped_duplicates: res2.skipped.length,
    blocked_by: [],
    decision_id: decisionId,
    metrics, sample: decisions.length,
    patches: enriched, decisions,
  };
}