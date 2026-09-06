// scripts/seed-workbench-data.mjs
// 工作台（作战室首页）批量演示数据注入器 —— 解决"工作台空"问题。
// 设计铁律：幂等（ON CONFLICT / 存在即跳过）、禁 DELETE、可安全重跑。
// 数据分布考虑 ownerFilter=me.username（admin 登录只看 named_owner='admin' 的账户），
//   故 owner 跨 admin/alice/bob/wangchuan 分布，且 admin 持有相当数量以保证 admin 视角下有内容。
// 驱动三大区：
//   管道总览  ← CRM_DEAL（pipelineMetrics，读 payload.stage/expected_amount/probability/updated_at）
//   客户跟踪  ← CRM_ACCOUNT（buildNamedAccountBoard，读 named_owner/tier/visit_notes）
//   销售行为  ← 账户 visit_notes（今日/本周/本月拜访+电话）+ created_at（本周新客户）
// 用法：node scripts/seed-workbench-data.mjs   （连 PGDATABASE，默认 plm）
import pg from 'pg';

const pool = new pg.Pool({
  host: process.env.PGHOST || '127.0.0.1',
  port: Number(process.env.PGPORT || 5433),
  user: process.env.PGUSER || 'agent2b',
  password: process.env.PGPASSWORD || 'agent2b',
  database: process.env.PGDATABASE || 'crm_native',
  options: '-c search_path=crm,public',
});
const q = (t, p = []) => pool.query(t, p);
const j = (o) => JSON.stringify(o);
const isoDaysAgo = (d) => new Date(Date.now() - d * 86400000).toISOString();
const rnd = (min, max) => Math.round(min + Math.random() * (max - min));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// ── 15 个指名账户（owner 跨 4 人，tier 三档，创建时间跨 1–120 天）──────────
const ACCOUNTS = [
  { id: 'a0000001-0000-0000-0000-000000000001', name: '上海印通包装科技有限公司', owner: 'admin', tier: '重点', created: 1, region: '华东', industry: '包装印刷' },
  { id: 'a0000002-0000-0000-0000-000000000002', name: '华东印务股份有限公司', owner: 'admin', tier: '目标', created: 3, region: '华东', industry: '出版印刷' },
  { id: 'a0000003-0000-0000-0000-000000000003', name: '深圳华彩包装科技有限公司', owner: 'admin', tier: '重点', created: 12, region: '华南', industry: '数码印刷' },
  { id: 'a0000004-0000-0000-0000-000000000004', name: '北京包装集团有限责任公司', owner: 'admin', tier: '潜力', created: 95, region: '华北', industry: '瓦楞纸箱' },
  { id: 'a0000005-0000-0000-0000-000000000005', name: '广州宏图标签有限公司', owner: 'admin', tier: '目标', created: 28, region: '华南', industry: '不干胶标签' },
  { id: 'a0000006-0000-0000-0000-000000000006', name: '苏州锦荣纸业有限公司', owner: 'admin', tier: '重点', created: 40, region: '华东', industry: '工业用纸' },
  { id: 'a0000007-0000-0000-0000-000000000007', name: '杭州智印数字印刷', owner: 'alice', tier: '目标', created: 2, region: '华东', industry: '数码印刷' },
  { id: 'a0000008-0000-0000-0000-000000000008', name: '宁波方太厨具包装', owner: 'alice', tier: '重点', created: 18, region: '华东', industry: '家电包装' },
  { id: 'a0000009-0000-0000-0000-000000000009', name: '南京苏美印务', owner: 'alice', tier: '潜力', created: 60, region: '华东', industry: '商业印刷' },
  { id: 'a0000010-0000-0000-0000-000000000010', name: '武汉楚天包装', owner: 'alice', tier: '目标', created: 5, region: '华中', industry: '食品包装' },
  { id: 'a0000011-0000-0000-0000-000000000011', name: '成都蜀风印务', owner: 'bob', tier: '重点', created: 22, region: '西南', industry: '酒类包装' },
  { id: 'a0000012-0000-0000-0000-000000000012', name: '重庆山城纸箱', owner: 'bob', tier: '潜力', created: 75, region: '西南', industry: '瓦楞纸箱' },
  { id: 'a0000013-0000-0000-0000-000000000013', name: '西安长安印刷', owner: 'bob', tier: '目标', created: 9, region: '西北', industry: '书刊印刷' },
  { id: 'a0000014-0000-0000-0000-000000000014', name: '青岛海蓝包装', owner: 'wangchuan', tier: '重点', created: 4, region: '华东', industry: '彩盒包装' },
  { id: 'a0000015-0000-0000-0000-000000000015', name: '天津津工印务', owner: 'wangchuan', tier: '目标', created: 33, region: '华北', industry: '工业印刷' },
];

const PRODUCTS = ['彩盒', '精装画册', '手机盒', '瓦楞纸箱', '不干胶标签', '礼品盒', '说明书', '手提袋', '食品包装', '酒盒'];
const OBJECTIVES = ['推进打样方案', '确认规格参数', '商务报价沟通', '技术方案评审', '合同细节确认', '回款节点对齐', '年度框架续签', '竞品对比分析'];
const RESULTS = ['客户确认打样规格', '已签样', '客户认可报价', '通过技术评审', '合同已盖章', '首期回款到账', '达成续签意向', '明确采购窗口'];
const NEXTS = ['本周内提交报价', '安排上门拜访', '发会议邀请', '进入合同流程', '跟进生产进度', '催收尾款', '季度复盘'];

function genVisits(account) {
  // 每账户 2–6 条拜访，时间跨 今日/本周/本月/历史；type visit/call 混合
  const n = rnd(2, 6);
  const notes = [];
  for (let i = 0; i < n; i++) {
    // 时间分布：0.05 今天, 0.5-6 本周, 8-28 本月, 再老的
    const r = Math.random();
    let days;
    if (r < 0.2) days = rnd(0, 0.5);
    else if (r < 0.55) days = rnd(1, 6);
    else if (r < 0.85) days = rnd(8, 28);
    else days = rnd(35, 110);
    const type = Math.random() < 0.3 ? 'call' : 'visit';
    notes.push({
      at: isoDaysAgo(days),
      type,
      objective: pick(OBJECTIVES),
      result: pick(RESULTS),
      next: pick(NEXTS),
    });
  }
  return notes.sort((a, b) => new Date(b.at) - new Date(a.at));
}

// ── 商机：每个账户 2–4 个，覆盖六段 + 流失，金额/概率/停留分布 ──
const STAGES = [
  { key: 'lead', prob: 0.15, amt: [50000, 300000] },
  { key: 'opportunity', prob: 0.35, amt: [200000, 1200000] },
  { key: 'quoted', prob: 0.55, amt: [400000, 2000000] },
  { key: 'contracted', prob: 0.75, amt: [800000, 3500000] },
  { key: 'ordered', prob: 0.85, amt: [600000, 3000000] },
  { key: 'paid', prob: 1.0, amt: [300000, 2500000] },
  { key: 'lost', prob: 0, amt: [100000, 800000] },
];
let dealSeq = 0;
function genDeals(account) {
  const count = rnd(2, 4);
  const deals = [];
  // 至少保证一个主推进商机到 contracted/ordered/paid，使得管道下游有量
  const stagePlan = ['opportunity', 'quoted', 'contracted', 'ordered', 'paid', 'lead', 'lost'];
  for (let i = 0; i < count; i++) {
    const st = i === 0 ? pick(['contracted', 'ordered', 'paid', 'quoted']) : pick(stagePlan);
    const meta = STAGES.find((s) => s.key === st);
    const amt = rnd(meta.amt[0], meta.amt[1]);
    const createdDays = rnd(10, 120);
    // 停留：约 1/3 停滞 >7 天（updated_at 早）
    const idle = Math.random() < 0.34 ? rnd(8, 45) : rnd(0, 6);
    dealSeq += 1;
    deals.push({
      slug: `wb-deal-${account.id.slice(-4)}-${dealSeq}`,
      name: `${account.name.slice(0, 6)}·${pick(PRODUCTS)}项目`,
      stage: st,
      amount: amt,
      probability: meta.prob,
      createdDays,
      idleDays: idle,
    });
  }
  return deals;
}

async function upsertAccount(a) {
  const ex = await q('SELECT id FROM crm.particles WHERE id=$1', [a.id]);
  const payload = {
    name: a.name,
    named_owner: a.owner,
    owner_id: a.owner,
    owner: a.owner,
    tier: a.tier,
    named_tier: a.tier,
    named_state: 'active',
    region: a.region,
    industry: a.industry,
    visit_notes: genVisits(a),
  };
  if (ex.rows.length) {
    const old = (await q('SELECT payload FROM crm.particles WHERE id=$1', [a.id])).rows[0].payload || {};
    await q('UPDATE crm.particles SET payload=$2, updated_at=now() WHERE id=$1', [a.id, j({ ...old, ...payload })]);
  } else {
    await q(
      `INSERT INTO crm.particles (id, tenant_id, type, slug, title, state, payload, created_at, updated_at)
       VALUES ($1,'system','CRM_ACCOUNT',$2,$3,'ACTIVE',$4,$5,now())`,
      [a.id, `wb-acct-${a.id.slice(-4)}`, a.name, j(payload), isoDaysAgo(a.created)],
    );
  }
  return a.id;
}

async function seedDeal(accountId, accountName, d) {
  const dup = await q('SELECT 1 FROM crm.particles WHERE slug=$1 AND tenant_id=\'system\'', [d.slug]);
  if (dup.rows.length) return false;
  const createdAt = isoDaysAgo(d.createdDays);
  const updatedAt = isoDaysAgo(d.idleDays);
  await q(
    `INSERT INTO crm.particles (id, tenant_id, type, slug, title, state, payload, created_at, updated_at)
     VALUES (gen_random_uuid(),'system','CRM_DEAL',$1,$2,'ACTIVE',$3,$4,$5)`,
    [d.slug, d.name, j({
      name: d.name, account_id: accountId, account_name: accountName,
      stage: d.stage, expected_amount: d.amount, amount: d.amount,
      probability: d.probability, stage_changed_at: updatedAt,
    }), createdAt, updatedAt],
  );
  return true;
}

async function seedContract(accountId, accountName, d) {
  const slug = `wb-contract-${accountId.slice(-4)}-${d.idx}`;
  const dup = await q('SELECT 1 FROM crm.particles WHERE slug=$1 AND tenant_id=\'system\'', [slug]);
  if (dup.rows.length) return false;
  const createdAt = isoDaysAgo(d.createdDays);
  await q(
    `INSERT INTO crm.particles (id, tenant_id, type, slug, title, state, payload, created_at, updated_at)
     VALUES (gen_random_uuid(),'system','CRM_CONTRACT',$1,$2,'ACTIVE',$3,$4,$4)`,
    [slug, d.no, j({
      name: d.no, account_id: accountId, account_name: accountName,
      amount: d.amount, status: 'active', contract_no: d.no,
      approval_status: 'approved',
    }), createdAt],
  );
  return true;
}

async function main() {
  let acctN = 0, dealN = 0, contractN = 0;
  for (const a of ACCOUNTS) {
    await upsertAccount(a);
    acctN++;
    const deals = genDeals(a);
    for (const d of deals) { if (await seedDeal(a.id, a.name, d)) dealN++; }
    // 重点/目标账户各挂 1–2 份合同
    if (a.tier !== '潜力') {
      const cn = rnd(1, 2);
      for (let i = 1; i <= cn; i++) {
        if (await seedContract(a.id, a.name, { idx: i, no: `HT-2026-${a.id.slice(-4)}-${String(i).padStart(2, '0')}`, amount: rnd(400000, 3000000), createdDays: rnd(10, 90) })) contractN++;
      }
    }
    console.log(`[ok] ${a.name} | owner=${a.owner} tier=${a.tier} deals=${deals.length}`);
  }
  console.log(`\n✅ 工作台演示数据注入完成：账户 ${acctN} / 商机 ${dealN} / 合同 ${contractN}`);
  await pool.end();
}

main().catch((e) => { console.error('SEED ERROR:', e); process.exit(1); });
