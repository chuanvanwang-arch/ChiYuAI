// src/decision/policyVersion.js — C3 决策时刻冻结：策略版本解析（内容哈希幂等复用）
// 设计：docs/superpowers/plans/2026-09-03-c2c3c4-decision-integrity-implementation.md T5
//
// 语义：决策落库时冻结「当时生效的配置快照」。事后改配置**不得洗掉**历史决策的判定依据
//   （Semantica `apply_policies:226-238` 固化的正是这个；我们此前是 schema 完备但生产零写入、
//   18 处调用方无一传 policy_version → effective_policy_version 恒 null）。
//
// 不变量：
//   I6 幂等：内容相同 → 复用既有版本 id；内容变化 → 递增新版本并封旧版（effective_to=now()）。
//   I1 不留假绿：解析失败不阻断决策，但 effective_policy_version 落 null 会被巡检发现（有痕可查）。
import { query, queryWrite } from '../db.js';
import { readConfig } from '../config/configStore.js';
import { emit } from '../events/bus.js';
import { recordFailure } from '../monitor/monitorStore.js';
import { createHash } from 'node:crypto';
import { stableStringify } from '../ontology/embedding.js';

// 快照范围 = 决策链路**实际消费**的配置键（逐点取证，非拍脑袋）：
//   autonomy-conf        autonomyEngine.js:33（loadEngineConf：置信度阈值与权重）
//   sales-thresholds     autonomyEngine.js:179（mergedThresholds）、methodologyExtractor.js:271
//   hindsight-deviation  closureLoop.js:24
//   context-guard        contextGuard.js:18
//   context-routing      routing.js:72
//   event-retro          retroTrigger.js:38
//   agent-event-trigger   eventTrigger.js（loadTriggerConfig）
// 用户裁决（2026-09-03）：先落全量 dump，后续可演进到「实际使用路径子集」（需埋点支撑）。
// 增键即改版本语义：加一个键会让所有后续决策解析出新版本（内容哈希变化）——这是**期望行为**，
//   因为快照口径变了，新旧版本确实不可比。
export const POLICY_KEYS = [
  'autonomy-conf', 'sales-thresholds', 'hindsight-deviation',
  'context-guard', 'context-routing', 'event-retro', 'agent-event-trigger',
  'price-authority', // 2026-09-09 新增：折扣授权矩阵是决策依据须可追溯；增键后所有后续决策解析出新版本（policyVersion.js:27 明示的预期行为，已获用户批准）
  'discovery-rules', // 2026-09-10 新增：lead-fit 判定依据（信号权重/ICP/provider 序）；增键→后续决策解析新版本（policyVersion.js:27 明示预期行为）
  // 2026-09-16 新增（用户批准方案 i，设计 §11.1 A3）：业务分级配置（A 轴）。
  //   为什么必须加：分级（customer × project → LEAD/NORMAL/HIGH）直接驱动自主放行边界
  //   （autonomyEngine.js:145 取值 → :274 判定），属**决策依据**。但它存在独立表
  //   crm.business_tier_config，而 loadSnapshot（:46-53）只读 config_store → 此前**不在冻结范围**，
  //   改一次分级会静默改写历史决策的判定依据，使本文件 :4-6 的承诺「事后改配置不得洗掉历史判定依据」
  //   对分级不成立（审计断链，设计 §2.4 D3）。
  //   接入方式：businessTier.js 在写分级后**同步镜像**该表到 config_store['business-tier-config']，
  //   经本键进入冻结通道。镜像漂移由 verifyMirrorConsistency 探针守护（禁假绿）。
  'business-tier-config',
];

const POLICY_FAMILY = 'sales-decision-policy';

// policy_id **含租户**（与计划的固定 'sales-decision-policy' 不同）：
//   固定值时「封旧版」会跨租户误伤——t1 决策会把 t2 的当前生效版本一并封掉（两者 policy_id 相同），
//   且版本序号跨租户混排。含租户后，封版与序号天然按租户隔离，无需给表加 tenant_id 列。
const policyIdOf = (tenantId = 'system') => `${POLICY_FAMILY}:${tenantId || 'system'}`;

// 读快照。readConfig 自带 system 回退（configStore.js:10-21），故未配置键在租户无覆盖时
//   取到的是平台值——这正是「当时实际生效」的语义，不做二次加工。
//   显式 null = 未配置（消费方走出厂兜底），与 {} 语义区分（禁假填充）。
async function loadSnapshot(tenantId = 'system') {
  const out = {};
  await Promise.all(POLICY_KEYS.map(async (key) => {
    const row = await readConfig(key, { tenantId }).catch(() => null);
    out[key] = row ? (row.value ?? null) : null;
  }));
  return out;
}

function versionIdOf(tenantId, snapshot) {
  const digest = createHash('sha256').update(stableStringify({ tenantId, snapshot })).digest('hex').slice(0, 12);
  return `pv-${POLICY_FAMILY}-${digest}`;
}

// 幂等解析：内容相同 → 复用；内容变化 → 新版本 + 封旧版。
//   并发安全：同 policy_version_id 并发 INSERT 由 ON CONFLICT DO NOTHING 收敛。
//   version 仅作排序参考（并发下允许并列），唯一性由内容哈希 id 保证——不把 version 当业务主键用。
export async function resolvePolicyVersion({ tenantId = 'system' } = {}) {
  const snapshot = await loadSnapshot(tenantId);
  const policy_version_id = versionIdOf(tenantId, snapshot);

  // 复用分支**必须连 effective_to 一起读**：内容寻址使「配置改回旧值」时命中既有版本行，
  //   若只判断「存在」就直接返回，会出现两个未封版版本并存（旧行被回滚复用、新行仍生效），
  //   于是「当前生效版本」不可判定（实测测试库出现 3 行、currentPolicyVersion 与实际生效者不一致）。
  const exist = (await query(
    `SELECT policy_version_id, effective_to FROM crm.policy_version WHERE policy_version_id=$1`, [policy_version_id]
  )).rows[0];
  if (exist) {
    // 正常路径（配置未变）：已是当前生效版本 → 零写返回，不给决策路径增加写放大。
    if (exist.effective_to === null) return { policy_version_id, created: false, snapshot };
    // 回滚路径：配置改回旧值 → 本行重新生效（effective_from 刷新），其余未封版行封掉。
    //   语义取舍：本表一行只承载一个活跃区间，回滚的「区间历史」不在本表表达（需独立区间表，超出本期）。
    await queryWrite(
      `UPDATE crm.policy_version SET effective_from=now(), effective_to=NULL WHERE policy_version_id=$1`,
      [policy_version_id]
    );
    await sealOthers(policyIdOf(tenantId), policy_version_id);
    return { policy_version_id, created: false, snapshot };
  }

  const seq = (await query(
    `SELECT COALESCE(MAX(version),0)+1 AS v FROM crm.policy_version WHERE policy_id=$1`, [policyIdOf(tenantId)]
  )).rows[0];

  await queryWrite(
    `INSERT INTO crm.policy_version (policy_version_id, policy_id, version, effective_from, snapshot)
     VALUES ($1,$2,$3, now(), $4::jsonb)
     ON CONFLICT (policy_version_id) DO NOTHING`,
    [policy_version_id, policyIdOf(tenantId), Number(seq?.v || 1), JSON.stringify({ tenantId, keys: snapshot })]
  );

  await sealOthers(policyIdOf(tenantId), policy_version_id);
  return { policy_version_id, created: true, snapshot };
}

// 封旧版：同租户（policy_id）下其他未封版本置 effective_to，保证「当前生效版本」唯一可判定。
//   fail-open：封版失败不影响本次决策（版本行已落库，最坏是旧版本未标记 effective_to）。
async function sealOthers(policy_id, keep_id) {
  await queryWrite(
    `UPDATE crm.policy_version SET effective_to=now()
      WHERE policy_id=$1 AND policy_version_id<>$2 AND effective_to IS NULL`,
    [policy_id, keep_id]
  ).catch((e) => {
    emit('trace', 'policy-version-seal-failed', { policy_version_id: keep_id, error: String(e?.message || e) });
    recordFailure('policy-version-seal-failed', e);
  });
}

// 审计面读取：按版本 id 取回冻结快照（回答「这条决策当时依据的是什么阈值」）
export async function getPolicyVersion(policy_version_id) {
  if (!policy_version_id) return null;
  const r = await query(
    `SELECT policy_version_id, policy_id, version, effective_from, effective_to, snapshot
     FROM crm.policy_version WHERE policy_version_id=$1`, [policy_version_id]
  );
  return r.rows[0] || null;
}

// 当前生效版本（effective_to IS NULL 者；同租户理论上至多一条）
export async function currentPolicyVersion({ tenantId = 'system' } = {}) {
  const r = await query(
    // effective_to 一并选出（WHERE 已限定 IS NULL，取回是为让调用方能自证「未封版」，不靠推断）
    `SELECT policy_version_id, policy_id, version, effective_from, effective_to, snapshot
     FROM crm.policy_version WHERE policy_id=$1 AND effective_to IS NULL
     ORDER BY effective_from DESC, version DESC LIMIT 1`, [policyIdOf(tenantId)]
  );
  return r.rows[0] || null;
}
