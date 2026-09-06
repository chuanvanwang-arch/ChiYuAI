// scripts/seed-named-accounts-demo.mjs
// 指名客户分工演示数据补种（集成 T6 验收数据）：
//  1) 确保 CRM_PERSON 存在 alice/bob（resolveActor 依赖 payload.username）
//  2) 给既有 4 个演示账户分配 owner_id/owner（username）+ tier 档位 + visit_notes 拜访记录
// 幂等：UPDATE 全量覆盖 payload（合并：先读后写），重跑安全。
// 用法：node scripts/seed-named-accounts-demo.mjs
import pg from 'pg';

const pool = new pg.Pool({
  host: process.env.PGHOST || '127.0.0.1',
  port: Number(process.env.PGPORT || 5433),
  user: process.env.PGUSER || 'agent2b',
  password: process.env.PGPASSWORD || 'agent2b',
  database: process.env.PGDATABASE || 'crm_native',
  options: '-c search_path=crm,public',
});

const q = (text, params = []) => pool.query(text, params);
const j = (o) => JSON.stringify(o);

const now = Date.now;
const isoDaysAgo = (d) => new Date(Date.now() - d * 86400000).toISOString();

// 指名客户分工：id → {owner(登录名 username), tier, created_days_ago, visits[]}
// 设计意图：让 alice 名下出现「今日/本周/本月」拜访、电话、新客户 3 类实际值非 0，
//         同时覆盖 重点/目标/潜力 三档达标/缺口场景。
const NAMED = [
  {
    id: 'a1111111-1111-1111-1111-111111111101', name: '上海印通包装科技有限公司', slug: 'account-yintong',
    owner: 'alice', tier: '重点', created_days_ago: 2, // 本周新客户
    visits: [
      { at: isoDaysAgo(0.3), type: 'visit', objective: '推进彩盒打样方案', result: '客户确认打样规格', next: '本周内提交报价' },
      { at: isoDaysAgo(2), type: 'visit', objective: '确认打样规格', result: '已签样', next: '报价' },
      { at: isoDaysAgo(0.15), type: 'call', objective: '电话确认参会', result: '客户同意参加技术评审', next: '发会议邀请' },
      { at: isoDaysAgo(5), type: 'call', objective: '电话确认需求', result: '约到本周拜访', next: '上门拜访' },
    ],
  },
  {
    id: 'a1111112-2222-2222-2222-222222222202', name: '华东印务有限公司', slug: 'account-huadong',
    owner: 'alice', tier: '目标', created_days_ago: 5, // 本周新客户
    visits: [
      { at: isoDaysAgo(3), type: 'visit', objective: '介绍公司案例', result: '客户留下资料', next: '下周二访' },
    ],
  },
  {
    id: 'a1111113-3333-3333-3333-333333333303', name: '深圳华彩包装股份有限公司', slug: 'account-huacai',
    owner: 'bob', tier: '重点', created_days_ago: 90, // 老客户
    visits: [
      { at: isoDaysAgo(3), type: 'visit', objective: '手机盒项目技术对接', result: '确认打样周期', next: '提交样品' },
      { at: isoDaysAgo(7), type: 'call', objective: '电话确认交期', result: '客户认可', next: '发合同' },
      { at: isoDaysAgo(35), type: 'visit', objective: '上月拜访', result: '签样', next: '报价' },
    ],
  },
  {
    id: 'a1111114-4444-4444-4444-444444444404', name: '北京包装集团有限责任公司', slug: 'account-beijing',
    owner: 'bob', tier: '潜力', created_days_ago: 120, // 老客户
    visits: [],
  },
];

async function upsertPerson(slug, username, name, role) {
  // 幂等：按 username 查既有行（有则更新，无则 gen_random_uuid 新建）
  const cur = await q(`SELECT id FROM crm.particles WHERE type='CRM_PERSON' AND payload->>'username'=$1 LIMIT 1`, [username]);
  if (cur.rows[0]) {
    await q(`UPDATE crm.particles SET payload=$2, updated_at=now() WHERE id=$1`, [cur.rows[0].id, j({ username, name, role })]);
    return cur.rows[0].id;
  }
  const pid = (await q(`SELECT gen_random_uuid() AS id`)).rows[0].id;
  await q(
    `INSERT INTO crm.particles (id, tenant_id, type, slug, title, state, payload, created_at, updated_at)
     VALUES ($1, 'system', 'CRM_PERSON', $2, $3, 'ACTIVE', $4, now(), now())`,
    [pid, slug, name, j({ username, name, role })],
  );
  return pid;
}

async function upsertAccount(a) {
  const cur = await q(`SELECT id FROM crm.particles WHERE id=$1 LIMIT 1`, [a.id]);
  const createdAt = isoDaysAgo(a.created_days_ago);
  const payload = { name: a.name, owner_id: a.owner, owner: a.owner, tier: a.tier, visit_notes: a.visits };
  if (cur.rows[0]) {
    const old = (await q(`SELECT payload FROM crm.particles WHERE id=$1`, [a.id])).rows[0].payload || {};
    const merged = { ...old, ...payload };
    await q(`UPDATE crm.particles SET payload=$2, created_at=$3, updated_at=now() WHERE id=$1`, [a.id, j(merged), createdAt]);
    return a.id;
  }
  await q(
    `INSERT INTO crm.particles (id, tenant_id, type, slug, title, state, payload, created_at, updated_at)
     VALUES ($1, 'system', 'CRM_ACCOUNT', $2, $3, 'ACTIVE', $4, $5, now())`,
    [a.id, a.slug, a.name, j(payload), createdAt],
  );
  return a.id;
}

async function main() {
  // 1) CRM_PERSON（resolveActor 按 payload.username 查 slug）
  await upsertPerson('person-alice', 'alice', '销售-示例', 'sales');
  await upsertPerson('person-bob', 'bob', '销售-Bob', 'sales');
  console.log('CRM_PERSON 就绪：alice / bob');

  // 2) CRM_ACCOUNT owner/档位/拜访/创建时间（created_at 用于 L1 新客户数计算）
  for (const a of NAMED) {
    await upsertAccount(a);
    console.log(`账户 ${a.id} → owner=${a.owner} tier=${a.tier} visits=${a.visits.length} created=${isoDaysAgo(a.created_days_ago).slice(0,10)}`);
  }

  await pool.end();
  console.log('指名客户分工演示数据补种完成 ✅');
}

main().catch((e) => { console.error(e); process.exit(1); });