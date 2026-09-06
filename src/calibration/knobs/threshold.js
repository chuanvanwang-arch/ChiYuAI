// src/calibration/knobs/threshold.js — threshold 旋钮策略（写 config_store['autonomy-conf']）
import { KnobStrategy } from './base.js';

export class ThresholdStrategy extends KnobStrategy {
  async readCurrent() {
    const { readConf } = await import('../store.js');
    const c = await readConf();
    return { threshold: c.threshold };
  }

  // 写落点：config_store['autonomy-conf']（与 P1 store.js:127 同源；tenant_id=system）
  async apply(client, toValue, ctx) {
    const cur = ctx.current || { threshold: 0.8, weights: {} };
    const next = { threshold: toValue.threshold, weights: cur.weights };
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
    const candidate = { ...cur, threshold: toValue.threshold };
    return replayScenario(ctx.decisions, candidate);
  }
}
