// src/decision/prescription.js — 处方定量计算引擎（闭环最后一公里：调多少、为什么、敏感度边界）
// 设计依据：docs/2026-09-04-param-propagation-hub-design.md §12.3
// 铁律：纯函数、不依赖 LLM、不写库、不删。所有旋钮映射由 config_store['retro-knob-map'] 配置化驱动（见 §12.2）。
// 调用方：retro.js analyzeCluster 在 LLM 归因后调用；degraded 模式也调用以补 heuristicAnalyze 恒空 draft_patches 的缺口。

/**
 * 生成一条定量处方。
 * @param {object} p
 * @param {number} p.cur        当前旋钮值（如 minSimilarity=0.45）
 * @param {number} p.measured   实测指标（如 precedent_recall=0.12）
 * @param {object} p.spec       retro-knob-map 条目：{ healthy_baseline, direction('down'|'up'|'shrink'), sensitivity_k, sensitivity_slope, max_step, min_step, metric }
 * @param {number} p.floor      安全下限（精度/合规）
 * @param {number} p.ceiling    安全上限
 * @returns {null|{from,to,step,predicted,risk,prescription}} 已健康则不产处方返回 null
 */
export function prescribe({ cur, measured, spec, floor, ceiling }) {
  if (spec == null) return null;
  const gap = (spec.healthy_baseline ?? 0) - (measured ?? 0);
  const dirDown = spec.direction === 'down' || spec.direction === 'shrink';
  // 方向校验：指标已健康（gap 方向与期望相反）则不产处方
  const expectSign = dirDown ? 1 : -1;
  if (Math.sign(gap) !== expectSign) return null;

  const rawStep = gap * (spec.sensitivity_k ?? 0.5);
  let step = Math.min(Math.max(rawStep, spec.min_step ?? 0.01), spec.max_step ?? 0.05);
  let target = dirDown ? cur - step : cur + step;
  let risk = 'LOW';
  // 边界与安全闸：越界则夹回并升 risk（防精度崩塌 / 过冲）
  if (target < floor || target > ceiling) {
    target = Math.min(Math.max(target, floor), ceiling);
    risk = 'MEDIUM';
  }
  const predicted = Math.min(Math.max((measured ?? 0) + step * (spec.sensitivity_slope ?? 0), 0), 1);
  const stepForReason = dirDown ? -step : step;
  return {
    from: cur,
    to: target,
    step: stepForReason,
    predicted,
    risk,
    prescription: {
      action: dirDown ? '下调' : '上调',
      reason:
        `当前${spec.metric}=${measured}，健康线=${spec.healthy_baseline}（缺口${gap.toFixed(2)}）；` +
        `每变动0.01 预计${spec.metric}+${((spec.sensitivity_slope ?? 0) * 0.01).toFixed(3)}；` +
        `${dirDown ? '下调' : '上调'}${step.toFixed(2)} 后预计≈${predicted.toFixed(2)}`,
      predicted_impact: { metric: spec.metric, from: measured, to_est: predicted, target: spec.healthy_baseline },
      sensitivity: {
        floor,
        ceiling,
        current: cur,
        further_step_risk: `低于 ${floor} 时精度(specificity)<下限，误召回风险陡升 → 不建议一步到位，本轮仅调至 ${target.toFixed(2)}`,
      },
      bounds: { do_not_below: floor, do_not_above: ceiling },
    },
  };
}

// 从 retro-knob-map 取匹配条目（根因类 + 指标）的 spec；无匹配返回 null（由调用方决定降级策略）
export function findKnobSpec(knobMap, { rootCauseClass, metric }) {
  if (!knobMap || !Array.isArray(knobMap.knob_map)) return null;
  return (
    knobMap.knob_map.find(
      (e) => e.root_cause_class === rootCauseClass && (metric == null || e.metric === metric)
    ) || null
  );
}
