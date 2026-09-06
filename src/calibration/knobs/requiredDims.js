// src/calibration/knobs/requiredDims.js — required_dims 旋钮策略（写 decision_scenario.required_dims）
// 落点与 src/http/sevenDimRouter.js:93 同源，但经校准第 0 闸 + 事务原子（由 store.js 驱动）
import { KnobStrategy } from './base.js';
import { query } from '../../db.js';

export class RequiredDimsStrategy extends KnobStrategy {
  async readCurrent(scenarioId) {
    const r = await query(`SELECT required_dims FROM crm.decision_scenario WHERE scenario_id=$1`, [scenarioId]);
    const v = r.rows[0]?.required_dims;
    return Array.isArray(v) ? v : [];
  }

  // 写落点：decision_scenario.required_dims（非 config_store）—— 同 S20 的 TEXT 无 FK 形态
  async apply(client, toValue, ctx) {
    await client.query(
      `UPDATE crm.decision_scenario SET required_dims=$1::jsonb WHERE scenario_id=$2`,
      [JSON.stringify(toValue), ctx.scenario_id]
    );
  }

  async replayImpact(ctx, toValue) {
    const { replayDims } = await import('../replayDims.js');
    return replayDims(ctx.scenarioId, toValue, ctx.windowDays || 30);
  }

  // from/to 为 [{dim,on_missing}]；降级（block→非 block / 移除 dim）→ HIGH，否则 MEDIUM
  riskLevel(from = [], to = []) {
    const fm = new Map((from || []).map((d) => [d.dim, d.on_missing]));
    const tm = new Map((to || []).map((d) => [d.dim, d.on_missing]));
    let high = false;
    for (const [dim, om] of tm) {
      const f = fm.get(dim);
      if (f === 'block' && om !== 'block') high = true; // 放宽 = 降级
    }
    for (const dim of fm.keys()) if (!tm.has(dim)) high = true; // 移除要求 = 降级
    return high ? 'HIGH' : 'MEDIUM';
  }
}
