// db/seed/tenantDefaults.js — 通用按租户播种器（T10，P1）
// 设计：docs/2026-09-03-config-center-tenant-isolation-design.md §3.5
// 对齐范式：db/seed/tenant-profile-chemical.js:10-59 的 writeConfig('tenant-profile', {...}, {tenantId}) upsert 模式
// 铁律：
//   - 不复制 system 默认值（租户未覆盖键回退 system 天然成立——防「改 system 默认后租户副本不跟随」的漂移）
//   - 只播种「必须按租户差异化」的键；默认空 opts → 只登记注册表 + 返回 {ok, seededKeys: [], skippedKeys: []}
//   - 写经 configStore.writeConfig（禁裸 SQL；写无 decisionId 时传 null，属种子/引导豁免路径——对齐 seedTenantMasterData 惯例）
import { writeConfig } from '../../src/config/configStore.js';
// 写走 queryWrite（src/db.js 的 query 是读池，INSERT 必须经写池——以实际源码为准修正计划）
import { queryWrite } from '../../src/db.js';

// 默认「必须按租户差异化」的键清单（可增量扩展；其余键一律回退 system）
// 2026-09-05 扩展至 8 键（设计 §A-2 + 用户裁决）：完全独立不共享——租户缺键 autoSeed 落模板、播种器为新租户显式落 8 键。
// ⚠ context-routing 红线（2026-09-04）：平台核心配置禁止修改。播种 = INSERT 租户行复制模板（不改 system 行），
//   种子脚本只读 system + 写租户行，不触碰 system 行本身 → 红线仍守。
export const DEFAULT_TENANT_SEED_KEYS = [
  'sales-thresholds', 'named-account-targets', 'approval-config',
  'behavior-standard', 'finance-receivables', 'decision-retro',
  'agent-event-trigger', 'context-routing',
];

// 键 → opts 旗标映射（all=true 播全量；单键仍可显式开启）
const KEY_FLAG_MAP = {
  'sales-thresholds': 'salesThresholds',
  'named-account-targets': 'namedTargets',
  'approval-config': 'approvalConfig',
  'behavior-standard': 'behaviorStandard',
  'finance-receivables': 'financeReceivables',
  'decision-retro': 'decisionRetro',
  'agent-event-trigger': 'agentEventTrigger',
  'context-routing': 'contextRouting',
};

// 播种：① 注册表登记（幂等，若尚未注册则补）→ ② 差异化键写入（all=true 播全量；否则仅 opts 显式开启的键）→ ③ 返回统计
// opts：{ all=false, salesThresholds=false, namedTargets=false, ... }——false 表示「不播种该键，回退 system」；
//   all=true 播全量 DEFAULT_TENANT_SEED_KEYS（新租户 onboarding 默认用法）
export async function seedTenantDefaults(tenantId, opts = {}) {
  const tenant = String(tenantId || '').trim();
  if (!tenant) return { ok: false, error: 'tenantId 必填' };

  // ① 注册表登记（幂等）：INSERT ... ON CONFLICT DO NOTHING（禁 DELETE；停用走 status）
  //   queryWrite（写池）：src/db.js 的 query 是读池，INSERT 必须经写池（以实际源码为准修正计划）
  //   createdBy：责任 sysadmin 归属（设计 §D2）——首次创建者写入即胜出，后续 CONFLICT 跳过
  const cb = opts.createdBy && opts.createdBy.user_id ? opts.createdBy : null;
  await queryWrite(
    `INSERT INTO crm.tenants (tenant_id, name, status, created_by_user_id, created_by_username)
     VALUES ($1, $1, 'active', $2, $3)
     ON CONFLICT (tenant_id) DO NOTHING`,
    [tenant, cb ? cb.user_id : null, cb ? cb.username : null]
  ).catch(() => {}); // 注册表缺失（未迁 T9）→ 静默跳过，播种仍继续（fail-open）

  // ② 差异化键播种（writeConfig upsert；无 decisionId=种子引导豁免，对齐既有 seed 脚本）
  // 目标键：all=true → 全量；否则 → DEFAULT_TENANT_SEED_KEYS 中 opts 旗标为真的键
  // 语义：从 system 模板复制价值作为租户独立起点（不共享引用、不改 system 行）
  const seededKeys = [];
  const skippedKeys = [];
  const targetKeys = opts.all
    ? DEFAULT_TENANT_SEED_KEYS
    : DEFAULT_TENANT_SEED_KEYS.filter((key) => !!opts[KEY_FLAG_MAP[key]]);
  for (const key of targetKeys) {
    try {
      // 从 system 现行为复制价值配置作为差异化起点（避免「从 {} 开始漂移」）
      // 注意：系统默认仍以 system 行为唯一事实源——复制仅为「租户想要独立一份起点」的显式选择
      const src = await (await import('../../src/config/configStore.js')).readConfig(key, { tenantId: 'system' });
      await writeConfig(key, src?.value || {}, { tenantId: tenant });
      seededKeys.push(key);
    } catch {
      skippedKeys.push(key); // 播种失败跳过（fail-open 不阻断新租户开通）
    }
  }

  return { ok: true, tenantId: tenant, seededKeys, skippedKeys };
}

// 便捷：新租户全流程（注册 → 播种 → 返回），供 tenantRouter/维护脚本复用
export async function provisionTenant(tenantId, opts = {}) {
  const seeded = await seedTenantDefaults(tenantId, opts);
  return seeded;
}
