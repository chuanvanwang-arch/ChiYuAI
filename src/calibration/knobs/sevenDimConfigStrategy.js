// src/calibration/knobs/sevenDimConfigStrategy.js — 7+ 类新旋钮的泛型策略基类（6.5 回落实施）
// 落点约定：全部写 config_store['seven-dim'] 的不同子键（与 sevenDimRouter.js CONFIG_KEY 同源）。
//   edge_bindings ── 读取由 edgeDimensionSpec.loadEdgeDimensionSpecFromConfig 负责（校验通过才采用，fail-safe）
//   confidence / outcome_threshold / default_strictness / meta_attr_map / particle_attr_add /
//   k_edge_add / source_refresh / dim_order / precedent_distill ── 同 key 不同子键
// 合并语义：UPSERT 读整行 value → 改目标子键 → 写回（保留其他子键，不覆盖）。全部经第0闸 decision_id 落库。
// 与 threshold/weight（autonomy-conf 直替）不同：本族是「子键合并」而非「整对象直替」，因为 seven-dim 是多元配置承载。
import { KnobStrategy } from './base.js';
import { query } from '../../db.js';
import { readConfig } from '../../config/configStore.js';

export const SEVEN_DIM_KEY = 'seven-dim';

// 读 config_store['seven-dim'] 整行 value（缺省返回 {}）
// 租户化（T5，P1）：内部处理器显式传租户；缺省 'system' 保持既有行为（回读平台基线）
export async function readSevenDimConfig({ tenantId = 'system' } = {}) {
  const r = await readConfig(SEVEN_DIM_KEY, { tenantId });
  const v = r?.value;
  return v && typeof v === 'object' ? v : {};
}

// 子键合并写回（UPSERT 语义；decisionId 为第0闸凭证，落 decision_id 列；tenant_id=system）
export async function writeSevenDimSubKey(subKey, subValue, decisionId = null) {
  const cur = await readSevenDimConfig();
  const next = { ...cur, [subKey]: subValue };
  await query(
    `INSERT INTO crm.config_store (tenant_id, key, value, decision_id, updated_by, updated_at)
     VALUES ('system', $1, $2::jsonb, $3, 'calibration', now())
     ON CONFLICT (tenant_id, key) DO UPDATE SET value=$2::jsonb, decision_id=$3, updated_at=now()`,
    [SEVEN_DIM_KEY, JSON.stringify(next), decisionId]
  );
}

// 泛型策略：apply 时把 toValue 整体写入子键；readCurrent 读当前子键
export class SevenDimSubKeyStrategy extends KnobStrategy {
  constructor(knob, subKey) {
    super(knob);
    this.subKey = subKey;
  }

  async readCurrent() {
    const v = await readSevenDimConfig();
    return v[this.subKey] ?? null;
  }

  // toValue 形态：{ [subKey]: value }（与 createPatch to_value 一致）或裸值
  // current 来源 = config_store['seven-dim'] 现配置（非 ctx.current——那是旧策略
  //   autonomy-conf 的来源；混用会把 autonomy-conf 键污染进 seven-dim）。
  async apply(client, toValue, ctx) {
    const payload = toValue && typeof toValue === 'object' && this.subKey in toValue
      ? toValue[this.subKey] : toValue;
    const cur = await readSevenDimConfig();
    await client.query(
      `INSERT INTO crm.config_store (tenant_id, key, value, decision_id, updated_by, updated_at)
       VALUES ('system', $1, $2::jsonb, $3, 'calibration', now())
       ON CONFLICT (tenant_id, key) DO UPDATE SET value=$2::jsonb, decision_id=$3, updated_at=now()`,
      [SEVEN_DIM_KEY, JSON.stringify({ ...cur, [this.subKey]: payload }), ctx.decisionId || null]
    );
  }

  async replayImpact(ctx, toValue) {
    return { knob: this.knob, subKey: this.subKey, toValue, note: '配置面改动；重跑由 decision-scenarios 触发（同 required_dims 语义）' };
  }

  riskLevel(from, to) {
    // 严格度/映射/蒸馏影响面大 → MEDIUM；纯阈值/顺序 → LOW（子类可覆盖）
    return ['strictness', 'precedent_distill', 'meta_attr_map'].includes(this.knob) ? 'MEDIUM' : 'LOW';
  }
}

// ---- 具体策略（每类一个轻量子类，落点子键不同）----
export class ConfidenceStrategy extends SevenDimSubKeyStrategy {
  constructor(knob) { super(knob, 'confidence'); }
}
export class EdgeBindingStrategy extends SevenDimSubKeyStrategy {
  constructor(knob) { super(knob, 'edge_bindings'); }
  riskLevel() { return 'MEDIUM'; }
}
export class OutcomeThresholdStrategy extends SevenDimSubKeyStrategy {
  constructor(knob) { super(knob, 'outcome_threshold'); }
}
export class StrictnessStrategy extends SevenDimSubKeyStrategy {
  constructor(knob) { super(knob, 'default_strictness'); }
}
export class MetaAttrMapStrategy extends SevenDimSubKeyStrategy {
  constructor(knob) { super(knob, 'meta_attr_map'); }
}
export class ParticleAttrAddStrategy extends SevenDimSubKeyStrategy {
  constructor(knob) { super(knob, 'particle_attr_add'); }
}
export class KEdgeAddStrategy extends SevenDimSubKeyStrategy {
  constructor(knob) { super(knob, 'k_edge_add'); }
}
export class SourceRefreshStrategy extends SevenDimSubKeyStrategy {
  constructor(knob) { super(knob, 'source_refresh'); }
}
export class DimOrderStrategy extends SevenDimSubKeyStrategy {
  constructor(knob) { super(knob, 'dim_order'); }
}
export class PrecedentDistillStrategy extends SevenDimSubKeyStrategy {
  constructor(knob) { super(knob, 'precedent_distill'); }
}