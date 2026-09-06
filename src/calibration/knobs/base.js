// src/calibration/knobs/base.js — 旋钮策略抽象基类
// 所有校准处方（threshold / weight / required_dims）统一抽象为策略类：
//   readCurrent(ctx)  → 读当前值（from_value 来源）
//   apply(client, toValue, ctx) → 写回（落点因 knob 而异，必须传事务 client）
//   replayImpact(ctx, toValue) → 预期影响（影子重放）
//   riskLevel(from, to) → 'LOW' | 'MEDIUM' | 'HIGH'
export class KnobStrategy {
  constructor(knob) { this.knob = knob; }
  async readCurrent(ctx) { throw new Error('not implemented'); }
  async apply(client, toValue, ctx) { throw new Error('not implemented'); }
  async replayImpact(ctx, toValue) { throw new Error('not implemented'); }
  riskLevel(from, to) { return 'LOW'; }
}
