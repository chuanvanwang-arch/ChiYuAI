// src/calibration/knobs/index.js — 旋钮策略注册表
// 6.5 回落实施（2026-08-30）：REGISTRY 由 3 类扩至 13 类，与 store.js KNOBS 声明对齐。
//   新增 10 类（confidence/edge_binding/outcome_threshold/strictness/meta_attr_map/
//   particle_attr_add/k_edge_add/source_refresh/dim_order/precedent_distill）共用
//   SevenDimConfigStrategy 泛型（落 config_store['seven-dim'] 不同子键，见 sevenDimConfigStrategy.js），
//   消除 rules.js R7–R17 处方「可生成、不可批准」的 J3 闭环断点。
// 12 闭合（2026-09-05 Task 12）：新增 ConfigStoreStrategy（14 类），承载 retro 草稿→待办→批准即生效完整闭环。
// 2026-09-05 P1-5（§8）：新增 3 类路由旋钮（17 类），落 config_store['context-routing']；
//   只出 PENDING 处方，人工批准 + 第0闸后才写（红线：context-routing 系统永不自动改）。
import { ThresholdStrategy } from './threshold.js';
import { WeightStrategy } from './weight.js';
import { RequiredDimsStrategy } from './requiredDims.js';
import {
  ConfidenceStrategy, EdgeBindingStrategy, OutcomeThresholdStrategy, StrictnessStrategy,
  MetaAttrMapStrategy, ParticleAttrAddStrategy, KEdgeAddStrategy, SourceRefreshStrategy,
  DimOrderStrategy, PrecedentDistillStrategy,
} from './sevenDimConfigStrategy.js';
import { ConfigStoreStrategy } from './configStoreStrategy.js';
import {
  RoutingTracksStrategy, RoutingWeightStrategy, RoutingThresholdStrategy,
} from './routingStrategy.js';

const REGISTRY = {
  threshold: ThresholdStrategy,
  weight: WeightStrategy,
  required_dims: RequiredDimsStrategy,
  // 6.5 新扩 10 类（J3/R7–R17 闭环）
  confidence: ConfidenceStrategy,
  edge_binding: EdgeBindingStrategy,
  outcome_threshold: OutcomeThresholdStrategy,
  strictness: StrictnessStrategy,
  meta_attr_map: MetaAttrMapStrategy,
  particle_attr_add: ParticleAttrAddStrategy,
  k_edge_add: KEdgeAddStrategy,
  source_refresh: SourceRefreshStrategy,
  dim_order: DimOrderStrategy,
  precedent_distill: PrecedentDistillStrategy,
  // Task 12 / §16.3：admin 待办闭环（retro 草稿 / 手动 createPatch 落 config_store 任意键）
  config_store: ConfigStoreStrategy,
  // 2026-09-05 P1-5（§8）：场景路由自适应回路处方（只出 PENDING，人工批准 + 第0闸后才写 context-routing）
  routing_tracks: RoutingTracksStrategy,
  routing_weight: RoutingWeightStrategy,
  routing_threshold: RoutingThresholdStrategy,
};

export function getStrategy(knob) {
  const S = REGISTRY[knob];
  return S ? new S(knob) : null;
}

export { REGISTRY };