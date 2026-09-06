// src/calibration/knobs/configStoreStrategy.js — config_store 旋钮策略（Task 12 / 设计 §16.3）
// 落点：config_store（任意键名子键），经传播中枢 upsert 路径写 crm.config_store；合并语义（子键写不丢兄弟键）。
// 计划缺陷修正 #9：apply 必须走事务 client.query（approvePatch 在 withTx 内执行原子写 + 状态置 APPLIED），
//   禁调传播中枢 writeConfig（那是池级连接，会脱离 approvePatch 的事务边界）。
// 设计 §16.6「绝不自动 apply」：此策略仅在 approvePatch 显式调用时执行；retro 末段只 createPatch=待办。
import { KnobStrategy } from './base.js';
import { readConfig } from '../../config/configStore.js';

// 拆 target='key.subkey' → [key, sub]；无点号 → [key, null]（整键替换）。
function splitTarget(target) {
  const s = String(target || '');
  const i = s.indexOf('.');
  return i < 0 ? [s, null] : [s.slice(0, i), s.slice(i + 1)];
}

export class ConfigStoreStrategy extends KnobStrategy {
  constructor(knob) { super(knob); }

  async readCurrent(ctx = {}) {
    const [key, sub] = splitTarget(ctx.target);
    const r = await readConfig(key, { tenantId: ctx.tenantId || 'system' });
    return sub ? r?.value?.[sub] ?? null : r?.value ?? null;
  }

  async apply(client, toValue, ctx = {}) {
    const tenantId = ctx.tenantId || 'system';
    const [key, sub] = splitTarget(ctx.target);
    const cur = await readConfig(key, { tenantId });
    const curVal = cur?.value && typeof cur.value === 'object' ? cur.value : {};
    const next = sub ? { ...curVal, [sub]: toValue } : toValue;
    await client.query(
      `INSERT INTO crm.config_store (tenant_id, key, value, decision_id, updated_by, updated_at)
       VALUES ($1,$2,$3::jsonb,$4,'calibration',now())
       ON CONFLICT (tenant_id, key) DO UPDATE SET value=$3::jsonb, decision_id=$4, updated_at=now()`,
      [tenantId, key, JSON.stringify(next), ctx.decisionId || null]
    );
    return next;
  }

  async replayImpact(ctx, toValue) {
    return {
      knob: this.knob,
      target: ctx.target,
      toValue,
      note: 'config_store 旋钮；批准即经传播中枢 upsert 生效（禁删、可回退 to from_value）',
    };
  }

  // config_store 面广（影响任意业务键）→ MEDIUM；子类可按目标键再细化
  riskLevel() { return 'MEDIUM'; }
}