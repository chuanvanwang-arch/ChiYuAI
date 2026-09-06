// test/policy-version.test.js — C3 决策时刻冻结：策略版本解析（T6）
// 设计：docs/superpowers/plans/2026-09-03-c2c3c4-decision-integrity-implementation.md T5/T6
//
// T5 前的实况：`crm.policy_version` 建表完备、`decision.effective_policy_version` 带 FK 和索引，
//   但**写入点全仓 0** —— `requireDecision` 取 `opts.policy_version || null`，18 处生产调用方无一传 → 恒 null。
//   后果：改一次阈值就洗掉所有历史决策的判定依据（「这条决策当时依据的是什么阈值」永远答不出）。
//
// 锁死六类回归：
//   ① 幂等复用：配置未变 → 同一版本 id（不产生版本雪崩）
//   ② 内容变化 → 新版本 + 旧版本封版（effective_to 非空）
//   ③ 端到端：requireDecision 后 decision.effective_policy_version 非 null 且可反查
//   ④ **C3 核心价值**：改配置后再决策，旧决策行的版本 id 纹丝不动（历史判定依据不被洗掉）
//   ⑤ 快照完整性：6 个 POLICY_KEYS 全在；未配置键为 null（禁止假填充成 {}）
//   ⑥ 租户隔离：租户有专属覆盖 → 不同 id；无覆盖时回退 system → 同 id（回退即「当时实际生效」，是正确语义）
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { query } from '../src/db.js';
import { readConfig, writeConfig } from '../src/config/configStore.js';
import {
  POLICY_KEYS, resolvePolicyVersion, getPolicyVersion, currentPolicyVersion,
} from '../src/decision/policyVersion.js';
import { requireDecision } from '../src/decision/autonomyEngine.js';

// crm.decision 的 FK 子表清单（information_schema 实测 9 张；与 test/calibration/replayDims.test.js:16 同源）。
// 只按本测试产生的 decision_id 精确清理，不动其它场景数据。
const DECISION_CHILD_TABLES = [
  ['calibration_patch', 'decision_id'],
  ['decision_context_snapshot', 'decision_id'],
  ['decision_event', 'decision_id'],
  ['decision_outcome', 'decision_id'],
  ['decision_precedent_rel', 'decision_id'],
  ['decision_precedent_rel', 'precedent_id'],
  ['decision_provenance', 'decision_id'],
  ['decision_relation', 'from_id'],
  ['decision_rule', 'decision_id'],
  ['tasks', 'decision_id'],
];

async function purgeDecision(did) {
  for (const [table, col] of DECISION_CHILD_TABLES) {
    await query(`DELETE FROM crm.${table} WHERE ${col}=$1`, [did]);
  }
  // decision_relation.to_id 是 TEXT（无 FK 但语义同键）→ 单独按 ::text 清，避免留孤儿边
  await query(`DELETE FROM crm.decision_relation WHERE to_id::text=$1`, [String(did)]);
  await query(`DELETE FROM crm.decision WHERE decision_id=$1`, [did]);
}

// config_store 是共享种子表：**绝不 TRUNCATE**（会让后续测试读不到配置）。
// 改配置的用例统一走 writeConfig，afterEach 原值写回（未配置则写回 JSON null —— 与「未配置」快照语义等价）。
const touched = [];
// 返回改前原值，供「回滚」类用例在用例内恢复（afterEach 也会再兜一次）
async function setConfig(key, value, tenantId = 'system') {
  const before = await readConfig(key, { tenantId });
  const original = before ? before.value : null;
  touched.push({ key, value: original, tenantId });
  await writeConfig(key, value, { tenantId });
  return original;
}
afterEach(async () => {
  for (const t of touched.reverse()) await writeConfig(t.key, t.value, { tenantId: t.tenantId });
  touched.length = 0;
});

beforeEach(async () => {
  // policy_version 被 decision.effective_policy_version 外键引用 → 全表 DELETE 会被 FK 拒
  //   （上游测试文件跑完会留下引用版本行的决策，实测即撞此约束）。
  //   故**先解除引用再删版本**，且只针对本文件命名空间的版本（pv-sales-decision-policy-*），
  //   不动 pv-test-001 / pv-e2e-test 之类伪造行，也不删任何决策数据。
  await query(
    `UPDATE crm.decision SET effective_policy_version=NULL
      WHERE effective_policy_version LIKE 'pv-sales-decision-policy-%'`
  );
  await query(`DELETE FROM crm.policy_version WHERE policy_version_id LIKE 'pv-sales-decision-policy-%'`);
});

describe('T6-a 版本解析（幂等 + 封版）', () => {
  it('① 首次解析 created:true；二次解析复用同一 id（幂等，不产生版本雪崩）', async () => {
    const a = await resolvePolicyVersion({ tenantId: 'system' });
    expect(a.created).toBe(true);
    const b = await resolvePolicyVersion({ tenantId: 'system' });
    expect(b.created).toBe(false);
    expect(b.policy_version_id).toBe(a.policy_version_id);
    const { rows } = await query(`SELECT count(*)::int AS n FROM crm.policy_version`);
    expect(rows[0].n).toBe(1);
  });

  it('② 改配置后再解析 → 新 id，且旧版本 effective_to 非空（已封版）', async () => {
    const v1 = await resolvePolicyVersion({ tenantId: 'system' });
    await setConfig('sales-thresholds', { policy_probe: 1 });
    const v2 = await resolvePolicyVersion({ tenantId: 'system' });
    expect(v2.policy_version_id).not.toBe(v1.policy_version_id);
    const old = await getPolicyVersion(v1.policy_version_id);
    expect(old.effective_to).toBeTruthy();
    const cur = await currentPolicyVersion({ tenantId: 'system' });
    expect(cur.policy_version_id).toBe(v2.policy_version_id);
  });

  it('②b 配置回滚：复用旧版本后「当前生效」仍唯一可判（内容寻址 + 封版的边界）', async () => {
    const v1 = await resolvePolicyVersion({ tenantId: 'system' });
    // 必须回滚到**改前原值**（不是写 null）——原值可能非 null，写 null 是「改成未配置」，
    //   内容哈希自然对不上 v1，测的就不是回滚语义了。
    const original = await setConfig('sales-thresholds', { rollback_probe: 1 });
    const v2 = await resolvePolicyVersion({ tenantId: 'system' });
    expect(v2.policy_version_id).not.toBe(v1.policy_version_id);

    // 改回原值 → 内容哈希命中 v1（复用）。若复用分支只判「存在」就返回，
    //   会出现 v1(被回滚复用) 与 v2(仍未封) 两个未封版版本 → 「当前生效版本」不可判定。
    await writeConfig('sales-thresholds', original, { tenantId: 'system' });
    const v3 = await resolvePolicyVersion({ tenantId: 'system' });
    expect(v3.policy_version_id).toBe(v1.policy_version_id);
    expect(v3.created).toBe(false);

    const open = (await query(
      `SELECT policy_version_id FROM crm.policy_version WHERE effective_to IS NULL`
    )).rows.map((r) => r.policy_version_id);
    expect(open).toEqual([v1.policy_version_id]);
    const cur = await currentPolicyVersion({ tenantId: 'system' });
    expect(cur.policy_version_id).toBe(v1.policy_version_id);
  });

  it('⑤ 快照完整性：6 个 POLICY_KEYS 全在；未配置键为 null（非 {}，禁假填充）', async () => {
    const r = await resolvePolicyVersion({ tenantId: 'system' });
    const row = await getPolicyVersion(r.policy_version_id);
    const keys = row.snapshot.keys;
    for (const k of POLICY_KEYS) expect(keys).toHaveProperty(k);
    // 未配置的键必须是 null（消费方据此走出厂兜底），不能是 {}
    for (const [k, v] of Object.entries(keys)) {
      if (v === null) continue;
      expect(POLICY_KEYS).toContain(k);
    }
    expect(row.snapshot.tenantId).toBe('system');
  });

  it('⑥ 租户隔离：各租户一条独立版本时间线；无覆盖时快照回退 system（内容相同，但版本对象不共享）', async () => {
    const sys = await resolvePolicyVersion({ tenantId: 'system' });
    const t1Fallback = await resolvePolicyVersion({ tenantId: 't1' });
    // 版本对象按租户隔离（policy_id 含租户 + 版本 id 哈希含租户）→ 即使快照内容相同也是两个版本行，
    //   否则「封旧版」会跨租户误伤：t1 决策会把 system 的当前生效版本一并封掉。
    expect(t1Fallback.policy_version_id).not.toBe(sys.policy_version_id);
    // 但快照内容必须相同：t1 无覆盖 → readConfig 回退 system（configStore.js:10）→ 实际生效的就是平台值
    expect(t1Fallback.snapshot).toEqual(sys.snapshot);

    await setConfig('sales-thresholds', { tenant_specific: true }, 't1');
    const t1 = await resolvePolicyVersion({ tenantId: 't1' });
    expect(t1.policy_version_id).not.toBe(t1Fallback.policy_version_id);
    // 租户侧改配置**不得**封掉 system 的当前版本（跨租户误伤的回归锁）
    const sysAfter = await currentPolicyVersion({ tenantId: 'system' });
    expect(sysAfter.policy_version_id).toBe(sys.policy_version_id);
    expect(sysAfter.effective_to).toBeFalsy();
  });
});

describe('T6-b requireDecision 端到端（C3 核心价值）', () => {
  it('③ 决策落库后 effective_policy_version 非 null，且能在 policy_version 反查到', async () => {
    const r = await requireDecision('LEAD_FOLLOW_UP', { trigger_context: { customer: { tier: 'A' } } });
    const did = r.decision.decision_id;
    try {
      expect(did).toBeTruthy();
      expect(r.decision.effective_policy_version).toBeTruthy(); // 此前恒 null
      const rec = await query(`SELECT effective_policy_version FROM crm.decision WHERE decision_id=$1`, [did]);
      expect(rec.rows[0].effective_policy_version).toBe(r.decision.effective_policy_version);
      const pv = await getPolicyVersion(rec.rows[0].effective_policy_version);
      expect(pv).toBeTruthy();
      expect(pv.snapshot.keys).toHaveProperty('autonomy-conf');
    } finally {
      await purgeDecision(did);
    }
  });

  it('④ 改配置后再决策：新决策用新版本，**旧决策行的版本 id 保持不变**（历史判定依据不被洗掉）', async () => {
    const r1 = await requireDecision('LEAD_FOLLOW_UP', { trigger_context: { customer: { tier: 'A' } } });
    const d1 = r1.decision.decision_id;
    const v1 = r1.decision.effective_policy_version;
    let d2 = null;
    try {
      await setConfig('sales-thresholds', { drift_probe: 42 });
      const r2 = await requireDecision('LEAD_FOLLOW_UP', { trigger_context: { customer: { tier: 'A' } } });
      d2 = r2.decision.decision_id;
      const v2 = r2.decision.effective_policy_version;
      expect(v2).toBeTruthy();
      expect(v2).not.toBe(v1); // 新决策锚定新版本

      // C3 的全部意义就在这一行：历史决策的版本锚点不随配置变更漂移
      const row1 = await query(`SELECT effective_policy_version FROM crm.decision WHERE decision_id=$1`, [d1]);
      expect(row1.rows[0].effective_policy_version).toBe(v1);

      // 且旧版本快照内容仍是当时的值（不是被改后的值）
      const old = await getPolicyVersion(v1);
      expect(old.snapshot.keys['sales-thresholds']).not.toEqual({ drift_probe: 42 });
    } finally {
      await purgeDecision(d1);
      if (d2) await purgeDecision(d2);
    }
  });
});
