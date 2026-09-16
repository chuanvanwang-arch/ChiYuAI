/**
 * scripts/seed-lead-pool-demo.mjs — 公海池演示种子（前台 /lead-pool.html 测试用）
 *
 * 背景：公海池页 /lead-pool.html 目前无数据（S0 无主线索为空），前台无法直观验证
 *   P0-1 freshness 徽标（hot/warm/stale）、in_pool_days 排序、pool_type 分类。
 *
 * 设计（对齐 src/http/routes.js:886-941 公海口径）：
 *   - 落 system 租户（演示用户 alice=system 租户，scopeTenant 返回 system → GET /api/lead-pool 可见）
 *   - 每条约 12 条 CRM_DEAL，stage='S0'、owner_id=null（公海无主）
 *   - freshness 由 payload.signals[] 的最小 ts 年龄决定：≤7d hot / ≤30d warm / >30d stale / 无 signals unknown
 *     （routes.js:917-928，徽标三档 + 无信号档，四档全覆盖）
 *   - pooled_at 决定 in_pool_days 与排序（routes.js:910-915 兜底链 pooled_at→returned_at→created_at）
 *   - 部分线索带决策链角色（P0-2 升级闸测试用：decision_chain.participants）
 *
 * 铁律：
 *   - 禁 DELETE：仅 INSERT，重复执行幂等（ON CONFLICT (stable_key) DO UPDATE，同
 *     scripts/e2e-lead-pool-actions.mjs:100-109 范式）
 *   - stable_key 前缀 seed-pool-demo-（与测试 fixture 前缀 e2e-pool- 区分，不影响 e2e 计数断言）
 *   - 不污染生产：默认落本地 dev 库 crm_native（无 PGDATABASE 时 db.js 默认库名 crm_native）
 *   - ESM 静态 import 陷阱：先设 PGDATABASE 再 await import（src/db.js 兜底在生产库）
 *
 * 用法：
 *   node scripts/seed-lead-pool-demo.mjs               # 本地 dev 库 crm_native
 *   PGDATABASE=crm_native_test node scripts/seed-lead-pool-demo.mjs   # 测试库
 *   LIMIT=2 node scripts/seed-lead-pool-demo.mjs       # 只造前 2 条（快速验证）
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 铁律：先设 PGDATABASE 再动态 import（ESM 静态 import 会让 db.js 兜底到默认库）
const PG = process.env.PGDATABASE || 'crm_native';
process.env.PGDATABASE = PG;

const { query, queryWrite } = await import(pathToFileURL(path.join(REPO_ROOT, 'src/db.js')).href);

// 相对时间的 ts（ISO）——距 now 的偏移
const H = 3600_000;
const D = 24 * H;
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

// 信号三档（freshness 判定源 routes.js:917-928）+ 无信号档
const SIG_HOT = [{ type: 'anysite', provider: 'anysite', ts: iso(2 * D), confidence: 0.8 }];
const SIG_WARM = [{ type: 'qixin', provider: 'qixin', ts: iso(15 * D), confidence: 0.6 }];
const SIG_STALE = [{ type: 'anysite', provider: 'anysite', ts: iso(60 * D), confidence: 0.3 }];

// 决策链角色（P0-2 完整度）——三条带完整链，其余部分链
const CHAIN_FULL = {
  participants: [
    { role: 'champion', name: '周研发', contact: 'zhou@acme.com' },
    { role: 'economic_buyer', name: '黄总', contact: 'huang@acme.com' },
    { role: 'technical', name: '李工', contact: 'li@acme.com' },
    { role: 'procurement', name: '吴采购', contact: 'wu@acme.com' },
  ],
};
const CHAIN_PARTIAL = { participants: [{ role: 'champion', name: '王工', contact: 'wang@demo.com' }] };

/**
 * 造一条公海 S0 线索（幂等 upsert，范式同 e2e-lead-pool-actions.mjs:100-109）
 */
async function upsertDeal(key, name, payload, { tenantId = 'system' } = {}) {
  const full = { name, stage: 'S0', owner_id: null, pool_type: 'new', ...payload };
  const r = await queryWrite(
    `INSERT INTO crm.particles (tenant_id, type, slug, title, state, payload, stable_key)
     VALUES ($1, 'CRM_DEAL', $2, $3, 'ACTIVE', $4::jsonb, $2)
     ON CONFLICT (stable_key) DO UPDATE
       SET payload = EXCLUDED.payload, title = EXCLUDED.title, updated_at = now()
     RETURNING id, title`,
    [tenantId, key, name, JSON.stringify(full)]
  );
  return r.rows[0];
}

// ── 种子清单（12 条，覆盖四档 freshness + 三种 in_pool_days + 行业面）──
// 字段命名对齐 routes.js 消费点：name / source / pool_type / amount / signals / decision_chain
const SEEDS = [
  // ❶ hot（≤7d）×4 —— 前排，带完整决策链，可测 P0-2
  { key: 'seed-pool-demo-01', name: '华东精密制造-设备改造商机', pool_type: 'new', source: 'anysite',
    amount: 860000, signals: SIG_HOT, decision_chain: CHAIN_FULL, pooled_at: iso(2 * D) },
  { key: 'seed-pool-demo-02', name: '苏州医疗科技-影像设备采购', pool_type: 'new', source: 'anysite',
    amount: 520000, signals: SIG_HOT, decision_chain: CHAIN_FULL, pooled_at: iso(3 * D) },
  { key: 'seed-pool-demo-03', name: '宁波化工新材料-产线升级', pool_type: 'new', source: 'qixin',
    amount: 1200000, signals: SIG_HOT, decision_chain: CHAIN_PARTIAL, pooled_at: iso(5 * D) },
  { key: 'seed-pool-demo-04', name: '东莞工业涂料-配方研发项目', pool_type: 'new', source: 'anysite',
    amount: 300000, signals: SIG_HOT, pooled_at: iso(6 * D) },
  // ❷ warm（≤30d）×3 —— 中排
  { key: 'seed-pool-demo-05', name: '无锡添加剂-复配产线规划', pool_type: 'new', source: 'qixin',
    amount: 650000, signals: SIG_WARM, decision_chain: CHAIN_PARTIAL, pooled_at: iso(12 * D) },
  { key: 'seed-pool-demo-06', name: '常州装备制造-售后维保平台', pool_type: 'new', source: 'anysite',
    amount: 420000, signals: SIG_WARM, pooled_at: iso(18 * D) },
  { key: 'seed-pool-demo-07', name: '山东医疗器械-渠道数字化', pool_type: 'nurture', source: 'qixin',
    amount: 280000, signals: SIG_WARM, pooled_at: iso(25 * D) },
  // ❸ stale（>30d）×3 —— 后排（回收池观察）
  { key: 'seed-pool-demo-08', name: '安徽工业涂料-厂房扩建', pool_type: 'new', source: 'anysite',
    amount: 980000, signals: SIG_STALE, pooled_at: iso(40 * D) },
  { key: 'seed-pool-demo-09', name: '河南添加剂-产能二期', pool_type: 'nurture', source: 'qixin',
    amount: 750000, signals: SIG_STALE, pooled_at: iso(55 * D) },
  { key: 'seed-pool-demo-10', name: '河北化工-智能仓储改造', pool_type: 'lost', source: 'anysite',
    amount: 360000, signals: SIG_STALE, pooled_at: iso(70 * D) },
  // ❹ 无 signals（unknown）×2 —— 徽标空档（routes.js:920 无信号 → unknown）
  { key: 'seed-pool-demo-11', name: '江西制造-ERP 选型咨询', pool_type: 'new', source: '手动录入',
    amount: 150000, pooled_at: iso(8 * D) },
  { key: 'seed-pool-demo-12', name: '福建医疗-实验室管理系统', pool_type: 'new', source: '展会',
    amount: 200000, pooled_at: iso(20 * D) },
];

// ═══ 执行 ═══
const dbName = (await query('SELECT current_database() AS db, host(inet_server_addr()) AS host')).rows[0];
console.log(`\n[crm-native] 目标库：${PG}（current=${dbName.db}, host=${dbName.host}）`);
// 白名单制护栏：仅本地回环（::1 / 127.0.0.1 / localhost）可直落；其它一律告警并中断（防误连远程生产）
const LOOPBACK = new Set(['::1', '[::1]', '127.0.0.1', 'localhost']);
if (dbName.db !== PG || !LOOPBACK.has(dbName.host.toLowerCase())) {
  console.error(`⛔ 护栏拦截：目标库 ${dbName.db}（host=${dbName.host}）非本地回环或库名与 PGDATABASE 不一致。`);
  console.error('   仅允许 loopback（::1/127.0.0.1/localhost）直落 dev 库；远程生产库禁止本脚本写入。');
  process.exit(1);
}

const limit = process.env.LIMIT ? parseInt(process.env.LIMIT, 10) : SEEDS.length;
const list = SEEDS.slice(0, limit);
let ok = 0;
for (const s of list) {
  try {
    await upsertDeal(s.key, s.name, {
      source: s.source, amount: s.amount,
      signals: s.signals || [], decision_chain: s.decision_chain || null,
      pooled_at: s.pooled_at,
      pool_type: s.pool_type,
    });
    ok++;
  } catch (e) {
    console.error(`❌ ${s.key} — ${e.message}`);
  }
}

// 验证：system 租户 S0 公海总数
const n = (await query(
  `SELECT count(*)::int AS n FROM crm.particles
    WHERE tenant_id='system' AND type='CRM_DEAL' AND payload->>'stage'='S0'`)).rows[0]?.n || 0;
console.log(`✅ 已写入 ${ok}/${list.length} 条（幂等 upsert）`);
console.log(`✅ system 租户公海 S0 现有：${n} 条（刷新 /lead-pool.html 即可看到）`);
console.log('提示：freshness 徽标=signals 最近 ts 年龄（hot≤7d/warm≤30d/stale>30d/无信号 unknown）；pooled_at 决定排序。');
