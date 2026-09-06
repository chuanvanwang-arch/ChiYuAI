// src/calibration/knobs/weight.js — weight 旋钮策略（写 config_store['autonomy-conf'].weights[target]）
import { KnobStrategy } from './base.js';

export class WeightStrategy extends KnobStrategy {
  async readCurrent(ctx) {
    const { readConf } = await import('../store.js');
    const c = await readConf();
    return { weights: { [ctx.target]: c.weights[ctx.target] } };
  }

  // 写落点：config_store['autonomy-conf'].weights[target]（与 P1 store.js:128 同源；tenant_id=system）
  async apply(client, toValue, ctx) {
    const cur = ctx.current || { threshold: 0.8, weights: {} };
    const next = { threshold: cur.threshold, weights: { ...cur.weights, [ctx.target]: toValue.weights[ctx.target] } };
    await client.query(
      `INSERT INTO crm.config_store (tenant_id, key, value, decision_id, updated_by, updated_at)
       VALUES ('system', $1, $2::jsonb, $3, 'system', now())
       ON CONFLICT (tenant_id, key) DO UPDATE SET value=$2::jsonb, decision_id=$3, updated_at=now()`,
      ['autonomy-conf', JSON.stringify(next), ctx.decisionId]
    );
  }

  async replayImpact(ctx, toValue) {
    const { replayScenario } = await import('../replay.js');
    const cur = ctx.current || { threshold: 0.8, weights: {} };
    const candidate = { threshold: cur.threshold, weights: { ...cur.weights, [ctx.target]: toValue.weights[ctx.target] } };
    return replayScenario(ctx.decisions, candidate);
  }
}
