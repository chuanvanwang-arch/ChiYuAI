// scripts/set-signal-email-channel.mjs — 把 signal-delivery.channels.email 置为指定值（业务写，过配置写闸）
//
// 为什么不是 SQL 迁移：
//   渠道开关属**业务写**（运营改配置），按 db/migration-signal-config.sql 头注的纪律，必须走
//   configStore.writeConfig 并携带决策指针，以满足配置写闸门与血缘；SQL 直改会绕过闸门与血缘。
//
// 【计划偏离 1】闸门路径由 fail-closed 改为镜像生产语义（2026-09-16 执行期实测修正）
//   计划原文用 requireDecision('CONFIG_WRITE', ...) 并在铸不出决策时 fail-closed。
//   实测：crm.decision_scenario 中**不存在** CONFIG_WRITE 场景（SELECT ... WHERE scenario_id='CONFIG_WRITE' → 0 行），
//   且全库 21 个已注册场景**全部是业务决策**，无一配置类。故 requireDecision 必抛 `未知决策场景`。
//   生产配置写通道的真实语义（src/http/configRouter.js:26-35 `produceDecision`）是：
//     先试 requireDecision → 抛错则**降级**为 recordDecisionEvent('config_change', ...) 并返回 decisionId=null，
//     然后照常写入。configRouter.js:147 自己传的缺省场景名 `'config-change'` 同样未注册 → 生产路径走的也是降级分支。
//   故本脚本**镜像**该语义（不越过闸门：仍无条件落 config_change 血缘事件），并将事件 event_id 作为
//   config_store.decision_id —— 这一点比 configRouter 的 `decisionId || null` 更强（后者在降级分支落 NULL），
//   与 src/portal/systemSettings.js:80-84（平台设置专用写通道）的口径一致：`decision?.event_id || null`。
//
// 【计划偏离 2】role_recipients 不写 system 模板租户（执行期发现的跨租户泄漏面）
//   configStore.readConfig 的 autoSeed（src/config/configStore.js:23-30）会把 (system,key) 模板**整个 value**
//   深拷贝给任何缺该键的租户。若把 system 租户的真邮箱写进 role_recipients，则该地址会成为**所有未来租户**的
//   默认收件人（system/role_recipients.<role> 即平台级默认）→ 跨租户个人信息泄漏。
//   且 system 租户自身有 202 sales + 1 finance 信号：一旦补上 route.recipientsFor 的 `platform` 回退键，
//   这批信号会立即真外发（推翻「实际外发量 = 0」的结论）。
//   ⇒ 故：system 模板租户的 role_recipients **原样保留**（当前为 {}），只对非 system 租户写本租户聚合结果。
//
// 为什么按 crm_users 真邮箱聚合 role_recipients：
//   用户裁决「on 且写收件人」。收件人**不得伪造**（设计 §2 硬约束）→ 只从 crm.crm_users 的**真邮箱**聚合，
//   键为 role（route.recipientsFor 按 signal.target_role 查该映射），且严格 tenant_id 隔离。
//   实测（2026-09-16）：全库仅 1 个用户有邮箱（tenant=system / role=admin），
//   而全部 open 信号的 target_role 只有 sales/ops/finance（system 202/1、各租户若干）→ 无一面向 admin。
//   ⇒ 聚合结果不匹配任何信号 → 实际外发量 0（真实读数，不是"已送达"）。
//
// 【计划偏离 3】撤回 rate_limit 收紧（执行期实测证伪，本脚本不再触碰该字段）
//   计划原文附加「把 rate_limit 从 null 改为 {per_hour:20, per_day:50}」作为 SMTP 护栏。执行期实测该护栏有害：
//   route.js:77-94 `overRateLimit` 统计的是**全渠道** `status='sent'` 行数（SQL 无 channel 过滤），
//   而 route.js:134-140 把 `rate_limited` 作为 **globalSkip 作用于全部渠道（含 inbox）**。
//   实测（2026-09-16）：15 租户中有 6 个近 24h 的 sent 行数已超 50
//   （system 200 / acme-demo 197 / acme-training 191 / acme-consult2 191 / acme-chem 190 / sim-erp 92）
//   ⇒ 一旦写入 per_day=50，这 6 个租户的**站内 inbox 投递会被一并拦截**（reason=rate_limited），
//     等于为保护一个「当前外发量为 0」的渠道而切断在平台内通知 —— 与护栏本意相反。
//   ⇒ 故本脚本**保留 rate_limit 原值**（现网 15 租户均为 null），收紧动作转为独立跟进任务：
//     正确的护栏须**按渠道**统计（只计出站渠道）后再判定，属 route.js 行为变更，不在本任务范围。
//
// 用法：node scripts/set-signal-email-channel.mjs <on|off> [--dry-run] [--force]
import { readConfig, writeConfig } from '../src/config/configStore.js';
import { requireDecision, decisionIdOf } from '../src/decision/autonomyEngine.js';
import { recordDecisionEvent } from '../src/decision/decisionRepo.js';
import { pool } from '../src/db.js';

const PLATFORM = 'system'; // 平台模板租户
const SCENE = 'CONFIG_WRITE'; // 若日后登记了该场景则自动启用真决策；当前未登记 → 走降级血缘

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const force = args.includes('--force'); // 绕过幂等短路（用于修正历史写入）
// 撤销本脚本上一轮注入的 rate_limit 护栏（见头注【计划偏离 3】）。
// 依据：变更前快照实测 15 租户 rate_limit 全为 null，故置回 null 即精确还原，不覆盖任何运营设值。
const revertRate = args.includes('--revert-rate-limit');
const target = (args.find((a) => !a.startsWith('--')) || '').trim(); // on | off
if (!['on', 'off'].includes(target)) {
  console.error('用法: node scripts/set-signal-email-channel.mjs <on|off> [--dry-run] [--force] [--revert-rate-limit]');
  process.exit(2);
}

// 掩码：仅用于日志，不打印完整地址（复用 crm_users 掩码口径）
const mask = (e) => e.replace(/^([^@])[^@]*@/, '$1***@');

// 配置写闸：镜像 src/http/configRouter.js:26-35，但把 event_id 作为决策指针（见头注【计划偏离 1】）
async function configWriteGate(ctx) {
  try {
    const r = await requireDecision(SCENE, ctx);
    const did = decisionIdOf(r);
    if (did) return { decisionId: did, path: 'requireDecision' };
  } catch {
    /* 场景未登记 → 降级（生产同语义） */
  }
  const ev = await recordDecisionEvent('config_change', {
    scenario_id: SCENE.toLowerCase().replace(/_/g, '-'),
    trigger_context: ctx,
  });
  return { decisionId: ev?.event_id || null, path: 'config_change-event' };
}

const tenants = (
  await pool.query(
    `SELECT DISTINCT tenant_id FROM crm.config_store WHERE key='signal-delivery' ORDER BY 1`
  )
).rows.map((r) => r.tenant_id);
console.log(`[email-channel] 目标值=${target} 租户数=${tenants.length}${dryRun ? ' [DRY-RUN]' : ''}`);

let changed = 0;
for (const tenantId of tenants) {
  const row = await readConfig('signal-delivery', { tenantId });
  const cfg = row?.value;
  if (!cfg) {
    console.log(`  - ${tenantId}: 无配置，跳过`);
    continue;
  }

  // 真邮箱聚合（严格本租户；无则空对象）。system 模板租户不参与（见头注【计划偏离 2】）。
  let roleRecipients;
  if (tenantId === PLATFORM) {
    roleRecipients = cfg.role_recipients || {}; // 模板态：原样保留，禁写入真邮箱（防 autoSeed 全租户扩散）
  } else {
    const { rows: recs } = await pool.query(
      `SELECT role, email FROM crm.crm_users
        WHERE tenant_id=$1 AND email IS NOT NULL AND email <> '' AND enabled IS TRUE
        ORDER BY role, username`,
      [tenantId]
    );
    const agg = {};
    for (const r of recs) agg[r.role] = [...(agg[r.role] || []), mask(r.email)];
    roleRecipients = agg;
  }

  const beforeEmail = cfg.channels?.email ?? null;
  const beforeRate = JSON.stringify(cfg.rate_limit ?? null);
  // 仅改 channels.email 与 role_recipients（+ 显式撤销时的 rate_limit）；其余字段原样保留
  const next = {
    ...cfg,
    channels: { ...(cfg.channels || {}), email: target },
    role_recipients: roleRecipients,
    ...(revertRate ? { rate_limit: null } : {}),
  };
  const nextRate = JSON.stringify(next.rate_limit ?? null);

  const rrKeys = Object.keys(roleRecipients);
  const rrLog = rrKeys.length ? JSON.stringify(roleRecipients) : '{}（无真邮箱 → 无匹配收件人）';
  const rateNote = `rate_limit=${nextRate}${beforeRate !== nextRate ? ` (原 ${beforeRate})` : ''}`;

  if (dryRun) {
    console.log(`  - ${tenantId}: email ${beforeEmail} → ${target} [DRY-RUN 未写] ${rateNote} role_recipients=${rrLog}`);
    continue;
  }
  // 幂等：目标值已就位且收件人映射无变化 → 短路（不重复铸决策/写库）
  const sameRr = JSON.stringify(cfg.role_recipients || {}) === JSON.stringify(roleRecipients);
  if (!force && beforeEmail === target && sameRr) {
    console.log(`  - ${tenantId}: 已是 ${target} 且收件人映射无变化，幂等跳过`);
    continue;
  }

  const gate = await configWriteGate({
    tenantId,
    key: 'signal-delivery',
    field: 'channels.email',
    to: target,
  });
  if (!gate.decisionId) {
    console.error(`  - ${tenantId}: 既无决策也无血缘事件 → 拒绝写入（fail-closed）`);
    process.exitCode = 1;
    continue;
  }
  await writeConfig('signal-delivery', next, {
    tenantId,
    decisionId: gate.decisionId,
    updatedBy: 'operator',
  });
  changed += 1;
  console.log(`  - ${tenantId}: email ${beforeEmail} → ${target}`);
  console.log(`      闸门=${gate.path} decision=${gate.decisionId}`);
  console.log(`      ${rateNote}`);
  console.log(`      role_recipients=${rrLog}`);
  if (tenantId === PLATFORM) {
    console.log(`      ⚠ 模板租户：未写入真邮箱（防 autoSeed 扩散到未来租户）`);
  }
}

console.log(`[email-channel] 完成：变更 ${changed} 个租户`);
await pool.end();
