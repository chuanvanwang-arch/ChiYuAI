// scripts/seed-date-driven-demo.mjs
// 需求③「日期驱动的自动化」种子数据 —— 用**独立演示租户**承载，避免污染既有租户。
//
// 为什么必须是独立租户（而不是往 acme-demo 塞数据）：
//   投递泵 `dispatcher.pumpOnce/pumpAllTenants` 的候选集 = 该租户**全部 open signal**。
//   实测（2026-09-17 本地 crm_native）：acme-demo 近 7 天 open 且未 email-sent 的信号有 **269 条**
//   （medium 172 / low 89 / high 8）。一旦给它配上 role_recipients，服务器每 5 分钟的泵会立刻
//   把这 269 条**群发邮件** —— 这正是本项目红线「不学『投递即骚扰』」要防的事。
//   独立租户把爆炸半径锁死为「本脚本造的 4 条」。
//
// 造什么（4 条 CRM_DEAL，每条精确命中一条日期规则）：
//   D-DEMO-TENDER   投标截止  +3 天  → tender-deadline  (due_within_days 7)   high
//   D-DEMO-VISIT    约定拜访  +1 天  → visit-remind     (due_within_days 3)   high（本次新增规则）
//   D-DEMO-QUOTE    报价待批  6 天前 → quote-timeout    (age ≥ 3d)            high
//   D-DEMO-SILENCE  阶段静默 20 天前 → stage-silence    (age ≥ 7d)            medium
//
// 铁律遵守：
//   · 零 DELETE、零 TRUNCATE；粒子走官方幂等路径 upsertParticleByStableKey（stable_key upsert）。
//   · 只写**本演示租户**的 config_store 行；**绝不**触碰 (system, key) 模板行
//     （模板会被 autoSeed 深拷贝给缺键租户 → 写模板等于把演示收件人泄漏给未来所有租户）。
//   · 收件人不写进代码：从 env SMTP_FROM/SMTP_USER 取（= 账号本人地址，自收自发，不外发第三方）。
//
// 用法：node scripts/seed-date-driven-demo.mjs
import 'dotenv/config';
import pg from 'pg';
import { upsertParticleByStableKey } from '../src/particles/mintId.js';

export const DEMO_TENANT = 'demo-datadriven';

// 连接池**延迟到 main 内创建**：本模块会被 demo-date-driven-push.mjs import（取 DEMO_TENANT），
//   若在模块作用域建池，import 方会凭空多出一条常驻连接。侧效应只允许发生在「直接执行」路径。
let write = null;

const isoInDays = (d) => new Date(Date.now() + d * 86400000).toISOString();
const isoDaysAgo = (d) => new Date(Date.now() - d * 86400000).toISOString();

// ── 种子定义 ────────────────────────────────────────────────────────────────
const DEALS = [
  {
    slug: 'demo-deal-tender',
    hitRule: 'tender-deadline',
    title: '丙二醇甲醚-北方化工集团年度框架招标',
    payload: {
      name: '丙二醇甲醚-北方化工集团年度框架招标',
      stage: 'S3', amount: 480000, owner_id: 'demo_sales01',
      account_name: '北方化工集团',
      tender_deadline: isoInDays(3),           // ← 命中：截止日落在未来 7 天内
      quote_status: 'none',
      last_activity_at: isoDaysAgo(1),
      updated_at: isoDaysAgo(1),
      source: 'demo-seed',
    },
  },
  {
    slug: 'demo-deal-visit',
    hitRule: 'visit-remind',
    title: '润湿剂-苏州精密制造现场技术交流',
    payload: {
      name: '润湿剂-苏州精密制造现场技术交流',
      stage: 'S3', amount: 90000, owner_id: 'demo_sales01',
      account_name: '苏州精密制造',
      visit_at: isoInDays(1),                  // ← 命中：拜访日落在未来 3 天内
      visit_purpose: '产线试料 + 工艺参数对齐',
      quote_status: 'none',
      last_activity_at: isoDaysAgo(2),
      updated_at: isoDaysAgo(2),
      source: 'demo-seed',
    },
  },
  {
    slug: 'demo-deal-quote-timeout',
    hitRule: 'quote-timeout',
    title: '固化剂-常州涂料科技季度框架报价',
    payload: {
      name: '固化剂-常州涂料科技季度框架报价',
      stage: 'S4', amount: 260000, owner_id: 'demo_sales01',
      account_name: '常州涂料科技',
      quote_status: 'pending_approval',        // ← 命中：待审批
      approval_requested_at: isoDaysAgo(6),    // ← 且已挂 6 天（阈值 3 天）
      last_activity_at: isoDaysAgo(6),
      updated_at: isoDaysAgo(6),
      source: 'demo-seed',
    },
  },
  {
    slug: 'demo-deal-stage-silence',
    hitRule: 'stage-silence',
    title: '分散剂-华东新材料中试项目',
    payload: {
      name: '分散剂-华东新材料中试项目',
      stage: 'S2', amount: 150000, owner_id: 'demo_manager01',
      account_name: '华东新材料',
      last_activity_at: isoDaysAgo(20),        // ← 命中：静默 20 天（阈值 7 天）
      updated_at: isoDaysAgo(20),
      quote_status: 'none',
      source: 'demo-seed',
    },
  },
  {
    // 2026-09-17 追加：用于「当场产生一条全新信号并真实外发」的复核粒子。
    //   存在的理由：日期规则按天分桶去重、投递按 (signal_id, channel) 幂等 ⇒
    //   同一批粒子重复播种**不再产生新投递**（这是正确行为，不是缺陷）。
    //   要观察一次真实的 2xx 往返/站内送达，必须有一条此前未产生过信号的粒子。
    slug: 'demo-deal-tender2',
    hitRule: 'tender-deadline',
    title: '南方建材-水性树脂招标（复核用新信号）',
    payload: {
      name: '南方建材-水性树脂招标（复核用新信号）',
      stage: 'S2', amount: 320000, owner_id: 'demo_sales01',
      account_name: '南方建材',
      tender_deadline: isoInDays(5),           // ← 命中：截止日落在未来 7 天内
      quote_status: 'none',
      last_activity_at: isoDaysAgo(1),
      updated_at: isoDaysAgo(1),
      source: 'demo-seed',
    },
  },
];

// 演示收件人：账号本人地址（自收自发）。缺 env 则不出站渠道——宁可邮件不发，也不猜收件人。
const SELF = process.env.SMTP_FROM || process.env.SMTP_USER || null;

async function main() {
  const pool = new pg.Pool({
    host: process.env.PGHOST || 'localhost',
    port: Number(process.env.PGPORT || 5433),
    user: process.env.PGUSER || 'agent2b',
    password: process.env.PGPASSWORD || 'agent2b',
    database: process.env.PGDATABASE || 'crm_native',
    options: '-c search_path=crm,public',
  });
  write = (t, p = []) => pool.query(t, p);

  console.log(`[seed] 目标库 = ${process.env.PGDATABASE || 'crm_native (默认)'}`);
  console.log(`[seed] 演示租户 = ${DEMO_TENANT}`);
  console.log(`[seed] 演示收件人 = ${SELF ? SELF.replace(/^(..).*(@.*)$/, '$1***$2') : '<未配置 SMTP_FROM/SMTP_USER → 出站渠道将关闭>'}`);

  // ── 1. 租户（幂等：存在即跳过）──
  await write(
    `INSERT INTO crm.tenants (tenant_id, name, status, plan, note, created_by_username)
     VALUES ($1, $2, 'active', 'pro', $3, 'seed-date-driven-demo')
     ON CONFLICT (tenant_id) DO NOTHING`,
    [DEMO_TENANT, '演示·日期驱动自动化', '需求③ 日期驱动演示租户（scripts/seed-date-driven-demo.mjs 生成）']
  );

  // ── 2. 演示用户（幂等；口令经 pgcrypto crypt，与登录链路同算法）──
  for (const [username, role, display] of [
    ['demo_admin', 'tan_admin', '演示租户管理员'],
    ['demo_sales01', 'sales', '演示销售 01'],
    ['demo_manager01', 'manager', '演示销售经理'],
  ]) {
    await write(
      `INSERT INTO crm.crm_users (username, password_hash, role, display_name, tenant_id, enabled, activated)
       VALUES ($1, crypt($2, gen_salt('bf')), $3, $4, $5, true, true)
       ON CONFLICT (username) DO UPDATE
         SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role,
             display_name = EXCLUDED.display_name, tenant_id = EXCLUDED.tenant_id,
             enabled = true, activated = true`,
      [username, 'demo123', role, display, DEMO_TENANT]
    );
  }

  // ── 3. 4 条商机粒子（官方幂等路径：stable_key upsert；重跑安全）──
  const created = [];
  for (const d of DEALS) {
    const row = await upsertParticleByStableKey(
      { type: 'CRM_DEAL', slug: d.slug, title: d.title, payload: d.payload, tenantId: DEMO_TENANT },
      { write }
    );
    created.push({ slug: d.slug, id: row.id, hitRule: d.hitRule });
    console.log(`[seed] 粒子 ${d.slug.padEnd(26)} id=${row.id} → 目标规则 ${d.hitRule}`);
  }

  // ── 4. 配置：先让 autoSeed 克隆平台模板（signal-schedule / signal-delivery），再叠加演示值 ──
  //    4.1 signal-delivery（**只写本租户**）：开启四渠道 + 收件人 + 严重度路由 + 限速
  //        出站限速是关键护栏：即便将来该租户被其它扫描器产出新信号，日配额也把外发封在 8 封内。
  const channels = SELF
    ? { inbox: 'on', email: 'on', im: 'on', webhook: 'on' }
    : { inbox: 'on', email: 'off', im: 'off', webhook: 'off' };
  const deliveryValue = {
    version: 1,
    channels,
    // 严重度路由：high 走全渠道（含出站），medium/low 只站内 —— 演示「路由可配」且天然收敛外发量
    route: {
      high: ['inbox', 'email', 'im', 'webhook'],
      medium: ['inbox', 'email'],
      low: ['inbox'],
    },
    role_recipients: SELF
      ? { sales: [SELF], manager: [SELF], platform: [SELF] }
      : {},
    quiet_hours: null,
    rate_limit: { per_hour: 4, per_day: 8 },   // 出站配额（inbox 不计入，见 route.js Task 2b）
    retry: 1,
    _seeded: 'date-driven-demo',
  };
  // readConfig 触发 autoSeed（幂等 INSERT ON CONFLICT DO NOTHING）→ 保证键存在后再覆盖
  const { readConfig, writeConfig } = await import('../src/config/configStore.js');
  await readConfig('signal-delivery', { tenantId: DEMO_TENANT });
  await readConfig('signal-schedule', { tenantId: DEMO_TENANT });
  const before = await readConfig('signal-delivery', { tenantId: DEMO_TENANT });
  console.log(`[seed] signal-delivery 原值（autoSeed 模板）= ${JSON.stringify(before?.value?.channels)}`);
  await writeConfig('signal-delivery', deliveryValue, { tenantId: DEMO_TENANT, updatedBy: 'seed-date-driven-demo' });
  console.log(`[seed] signal-delivery 已写 = ${JSON.stringify(channels)}`);

  //    4.2 signal-schedule：确保 visit-remind 在本租户存在
  //        生产路径由 db/migration-signal-schedule-visit-rule.sql 统一追加；此处兜底（脚本可能先于迁移跑）
  const sched = await readConfig('signal-schedule', { tenantId: DEMO_TENANT });
  const rules = Array.isArray(sched?.value?.rules) ? sched.value.rules : [];
  if (!rules.some((r) => r.id === 'visit-remind')) {
    await writeConfig(
      'signal-schedule',
      { ...sched.value, rules: [...rules, {
        id: 'visit-remind', kind: 'visit_remind', entity_type: 'CRM_DEAL',
        condition: { op: 'due_within_days', threshold_days: 3 },
        ts_field: 'visit_at', severity: 'high', target_role: 'sales',
        enabled: true, bucket: 'day',
      }] },
      { tenantId: DEMO_TENANT, updatedBy: 'seed-date-driven-demo' }
    );
    console.log('[seed] signal-schedule 追加 visit-remind（本租户）');
  } else {
    console.log('[seed] signal-schedule 已含 visit-remind（跳过）');
  }
  const finalRules = (await readConfig('signal-schedule', { tenantId: DEMO_TENANT })).value.rules;
  console.log(`[seed] 本租户日期规则 = ${finalRules.map((r) => r.id).join(', ')}`);

  console.log('\n[seed] 完成。下一步：node scripts/demo-date-driven-push.mjs');
  await pool.end();
}

// 直接执行时跑 main；被 import 时（如 demo-date-driven-push.mjs 取 DEMO_TENANT 常量）不产生副作用。
//   用 fileURLToPath 而非字符串拼 `file://` —— Windows 盘符大小写会让朴素拼接判定失败。
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const isMain = process.argv[1]
  && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isMain) await main();
