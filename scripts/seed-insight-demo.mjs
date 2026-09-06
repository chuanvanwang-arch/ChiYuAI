// scripts/seed-insight-demo.mjs
// 为多个客户注入完整 L2C 演示数据，使 S35 客户深度洞察页可切换展示不同客户。
// 幂等：对每个账户，若已存在关联事件则跳过该账户，可安全重跑。
// 用法：node scripts/seed-insight-demo.mjs
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

// 演示账户定义：id 固定，便于深链直达；title/name 对客户选择器可见。
const ACCOUNTS = [
  {
    id: 'a1111111-1111-1111-1111-111111111101',
    slug: 'account-yintong',
    name: '上海印通包装科技有限公司',
    industry: '包装印刷',
    region: '华东',
    deal: '彩盒打样询盘',
    product: '彩盒缓冲结构',
    contractNo: 'HT-2026-YT-001',
    orderNo: 'SO-2026-YT-001',
    invoiceNo: 'INV-2026-YT-001',
    quoteAmount: 48000,
    contractAmount: 1200000,
    orderAmount: 360000,
    paidAmount: 300000,
  },
  {
    id: 'a1111112-2222-2222-2222-222222222202',
    slug: 'account-huadong',
    name: '华东印务股份有限公司',
    industry: '出版印刷',
    region: '华东',
    deal: '精装画册年度合作',
    product: '精装画册',
    contractNo: 'HT-2026-HD-002',
    orderNo: 'SO-2026-HD-002',
    invoiceNo: 'INV-2026-HD-002',
    quoteAmount: 92000,
    contractAmount: 2400000,
    orderAmount: 600000,
    paidAmount: 800000,
  },
  {
    id: 'a1111113-3333-3333-3333-333333333303',
    slug: 'account-huacai',
    name: '深圳华彩包装科技有限公司',
    industry: '数码印刷',
    region: '华南',
    deal: '消费电子彩盒项目',
    product: '手机盒',
    contractNo: 'HT-2026-HC-003',
    orderNo: 'SO-2026-HC-003',
    invoiceNo: 'INV-2026-HC-003',
    quoteAmount: 65000,
    contractAmount: 1800000,
    orderAmount: 450000,
    paidAmount: 450000,
  },
  {
    id: 'a1111114-4444-4444-4444-444444444404',
    slug: 'account-beijing',
    name: '北京包装集团有限责任公司',
    industry: '瓦楞纸箱',
    region: '华北',
    deal: '物流纸箱集采',
    product: '瓦楞纸箱',
    contractNo: 'HT-2026-BJ-004',
    orderNo: 'SO-2026-BJ-004',
    invoiceNo: 'INV-2026-BJ-004',
    quoteAmount: 38000,
    contractAmount: 800000,
    orderAmount: 200000,
    paidAmount: 100000,
  },
];

const demoEvalDims = {
  discount: [
    { cond: 'discount_ratio', label: '折扣比例', weight: 0.35 },
    { cond: 'margin_impact', label: '毛利影响', weight: 0.35 },
    { cond: 'contract_volume', label: '合同体量', weight: 0.2 },
    { cond: 'time_window', label: '审批时间窗', weight: 0.1 },
  ],
  terms: [
    { cond: 'payment_days', label: '账期天数', weight: 0.35 },
    { cond: 'credit_risk', label: '信用风险', weight: 0.35 },
    { cond: 'customer_history', label: '历史回款', weight: 0.2 },
    { cond: 'governance_approval', label: '财务审批', weight: 0.1 },
  ],
};

async function upsertAccount(acc) {
  const exists = await q('SELECT id FROM crm.particles WHERE id=$1', [acc.id]);
  if (exists.rows.length) {
    await q(
      `UPDATE crm.particles SET title=$1, payload=jsonb_set(payload,'{name}',$2::jsonb,true), updated_at=now() WHERE id=$3`,
      [acc.name, j(acc.name), acc.id],
    );
    console.log(`[ok] account ${acc.slug} 已存在，更新标题`);
  } else {
    await q(
      `INSERT INTO crm.particles (id, tenant_id, type, slug, title, state, payload, created_at, updated_at)
       VALUES ($1,'system','CRM_ACCOUNT',$2,$3,'ACTIVE',$4::jsonb,now(),now())`,
      [acc.id, acc.slug, acc.name, j({ name: acc.name, industry: acc.industry, region: acc.region, rating: 'A' })],
    );
    console.log(`[ok] account ${acc.slug} 创建`);
  }
}

async function seedAccount(acc) {
  // 幂等闸门：该账户已有事件则跳过
  const ex = await q('SELECT count(*)::int c FROM crm.events WHERE payload->>\'account_id\'=$1', [acc.id]);
  if (ex.rows[0].c > 0) {
    console.log(`[skip] ${acc.name} 已存在关联事件，跳过`);
    return;
  }

  await upsertAccount(acc);

  // 确保有一个 deals 挂到该账户
  const existingDeals = await q(
    `SELECT id, slug FROM crm.particles WHERE type='CRM_DEAL' AND payload->>'account_id'=$1 LIMIT 1`,
    [acc.id],
  );
  let dealId = existingDeals.rows[0]?.id;
  if (!dealId) {
    const newDeal = await q(
      `INSERT INTO crm.particles (id, tenant_id, type, slug, title, state, payload, created_at, updated_at)
       VALUES (gen_random_uuid(), 'system', 'CRM_DEAL', $1, $2, 'ACTIVE', $3::jsonb, now(), now()) RETURNING id`,
      [`demo-deal-${acc.slug}`, acc.deal, j({ name: acc.deal, stage: 'opportunity', expected_amount: acc.contractAmount, probability: 0.5, account_id: acc.id, owner: '王川' })],
    );
    dealId = newDeal.rows[0].id;
    console.log(`[ok] deal ${acc.deal} for ${acc.name}`);
  }

  // 1) L2C 关联粒子
  const particles = [
    ['CRM_QUOTATION', `demo-quote-${acc.slug}`, `${acc.product}报价单`, { name: `${acc.product}报价单`, account_id: acc.id, deal_id: dealId, amount: acc.quoteAmount, status: 'submitted', customer: acc.name }, '2026-08-06 10:00:00+08'],
    ['CRM_CONTRACT', `demo-contract-${acc.slug}`, `${acc.contractNo} 年度框架合同`, { name: `${acc.contractNo} 年度框架合同`, account_id: acc.id, deal_id: dealId, amount: acc.contractAmount, status: 'active', customer: acc.name, contract_no: acc.contractNo }, '2026-08-12 15:30:00+08'],
    ['CRM_ORDER', `demo-order-${acc.slug}`, `${acc.orderNo} 生产订单`, { name: `${acc.orderNo} 生产订单`, account_id: acc.id, deal_id: dealId, amount: acc.orderAmount, status: 'producing', customer: acc.name, order_no: acc.orderNo }, '2026-08-15 09:20:00+08'],
    ['CRM_PAYMENT_PLAN', `demo-pp-${acc.slug}`, '年度回款计划', { name: '年度回款计划', account_id: acc.id, deal_id: dealId, amount: acc.contractAmount, status: 'active', customer: acc.name }, '2026-08-12 16:00:00+08'],
    ['CRM_PAYMENT_RECORD', `demo-pr-${acc.slug}`, '首期回款', { name: '首期回款', account_id: acc.id, deal_id: dealId, paid_amount: acc.paidAmount, status: 'received', customer: acc.name }, '2026-08-20 11:00:00+08'],
    ['CRM_INVOICE', `demo-inv-${acc.slug}`, '增值税专用发票', { name: '增值税专用发票', account_id: acc.id, deal_id: dealId, amount: acc.orderAmount, status: 'issued', customer: acc.name, invoice_no: acc.invoiceNo }, '2026-08-18 14:00:00+08'],
    ['CRM_TECHNICAL_PROPOSAL', `demo-proposal-${acc.slug}`, `${acc.product}技术方案`, { name: `${acc.product}技术方案`, account_id: acc.id, deal_id: dealId, status: 'approved', customer: acc.name }, '2026-08-10 17:00:00+08'],
  ];
  for (const [type, slug, title, payload, ts] of particles) {
    const dup = await q('SELECT 1 FROM crm.particles WHERE slug=$1 AND tenant_id=\'system\'', [slug]);
    if (dup.rows.length) { console.log(`[skip] particle slug=${slug} 已存在`); continue; }
    await q(
      `INSERT INTO crm.particles (id, tenant_id, type, slug, title, state, payload, created_at, updated_at)
       VALUES (gen_random_uuid(), 'system', $1, $2, $3, 'ACTIVE', $4::jsonb, $5, $5)`,
      [type, slug, title, j(payload), ts],
    );
    console.log(`[ok] particle ${type} ${slug}`);
  }

  // 2) 时间线事件
  const events = [
    ['trace', `首次拜访${acc.region}客户（${acc.name}）`, '销售', 'visit', '2026-08-01 10:00:00+08', `现场走访${acc.name}，确认${acc.product}采购需求`],
    ['trace', `电话沟通${acc.product}需求`, '销售', 'call', '2026-08-03 14:30:00+08', `客户提出${acc.product}打样，关注交付周期`],
    ['trace', `提交${acc.product}报价`, '销售', 'quotation', '2026-08-06 10:00:00+08', `报价单金额 ¥${acc.quoteAmount.toLocaleString()}`],
    ['trace', `${acc.product}技术方案评审通过`, '售前', 'proposal', '2026-08-10 17:00:00+08', `${acc.product}技术方案评审通过`],
    ['trace', `签署${acc.contractNo}合同`, '合同', 'contract', '2026-08-12 15:30:00+08', `合同 ${acc.contractNo}，金额 ¥${acc.contractAmount.toLocaleString()}`],
    ['trace', `${acc.orderNo} 订单生产跟进`, '交付', 'order', '2026-08-15 09:20:00+08', `订单 ${acc.orderNo} 进入生产`],
    ['trace', '收到首期回款', '财务', 'payment', '2026-08-20 11:00:00+08', `首期回款 ¥${acc.paidAmount.toLocaleString()} 到账`],
  ];
  for (const [domain, title, source, entity_type, ts, note] of events) {
    await q(
      `INSERT INTO crm.events (domain, type, payload, actor, created_at)
       VALUES ($1, 'note', $2::jsonb, $3, $4)`,
      [domain, j({ title, type: 'note', source, entity_type, account_id: acc.id, deal_id: dealId, note }), source, ts],
    );
  }
  console.log(`[ok] ${acc.name} events x${events.length}`);

  // 3) 任务线
  const tasks = [
    [`跟进${acc.product}打样进度`, 'running', '2026-09-05', '王川'],
    [`准备${acc.name}年度对账资料`, 'ready', '2026-09-15', '王川'],
  ];
  for (const [title, status, due, actor] of tasks) {
    await q(
      `INSERT INTO crm.tasks (tenant_id, chain_id, step, title, action_name, payload, status, created_at)
       VALUES ('system', 'demo', 'followup', $1, 'crm-followup', $2::jsonb, $3, now())`,
      [title, j({ account_id: acc.id, status, due, actor }), status],
    );
  }
  console.log(`[ok] ${acc.name} tasks x${tasks.length}`);

  // 4) 决策链
  const decisions = [
    ['SC_DEMO_DISCOUNT', 'APPROVE', 'manager', `${acc.region}大客户，折扣在授权范围内`, 'dec-prev-001', 'NORMAL', 'approved', 'EFFECTIVE'],
    ['SC_DEMO_TERMS', 'EXCEPTION', 'manager', `${acc.name}历史回款良好，放宽账期`, null, 'HIGH', 'exception_granted', 'EFFECTIVE'],
  ];
  for (const [scenario_id, disposition, decider_role, rationale, precedent, tier, outcome, state] of decisions) {
    await q(
      `INSERT INTO crm.decision
         (scenario_id, trigger_context, involved_entities, conditions_evaluated, disposition,
          decider_type, decider_id, decider_role, rationale, referenced_precedents, business_tier, outcome, state)
       VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb, $5, 'human', 'admin', $6, $7, $8::jsonb, $9, $10, $11)`,
      [scenario_id, j({ source: 'seed' }), j({ account_id: acc.id, deal_id: dealId }), j({}), disposition,
        decider_role, rationale, j(precedent ? [precedent] : []), tier, outcome, state],
    );
  }
  console.log(`[ok] ${acc.name} decisions x${decisions.length}`);

  // 5) 记忆沉淀
  const mem = [
    ['decision', `${acc.name}决策偏好`, `${acc.name}决策链偏短，关键决策人关注交付时效与账期`],
    ['interaction', `${acc.name}历史合作记录`, `${acc.region}地区重要客户，${acc.product}复购率高，适合年度框架模式`],
  ];
  for (const [kind, title, summary] of mem) {
    await q(
      `INSERT INTO crm.memory_log (topic, kind, payload, weight, created_at)
       VALUES ($1, $2, $3::jsonb, 1.0, now())`,
      [`account:${acc.id}`, kind, j({ title, summary })],
    );
  }
  console.log(`[ok] ${acc.name} memory_log x${mem.length}`);
}

async function seedScenarios() {
  await q(
    `INSERT INTO crm.decision_scenario
       (scenario_id, stage, description, trigger, methodology_ids, eval_dimensions, default_tier, autonomous_allowed, dispositions)
     VALUES
       ('SC_DEMO_DISCOUNT','contract','合同折扣审批',$1::jsonb,ARRAY['method-bant'],$2::jsonb,'NORMAL',false,ARRAY['APPROVE','REJECT','ESCALATE']),
       ('SC_DEMO_TERMS','payment','账期放宽例外',$3::jsonb,ARRAY['method-risk-tradeoff'],$4::jsonb,'HIGH',false,ARRAY['APPROVE','REJECT','EXCEPTION'])
     ON CONFLICT (scenario_id, tenant_id) DO NOTHING`,
    [j({ type: 'contract_discount' }), j(demoEvalDims.discount), j({ type: 'payment_terms_exception' }), j(demoEvalDims.terms)],
  );
  console.log('[ok] decision_scenarios');
}

async function main() {
  await seedScenarios();
  for (const acc of ACCOUNTS) {
    console.log(`\n--- seeding ${acc.name} ---`);
    await seedAccount(acc);
  }
  console.log('\n✅ 全部注入完成。深链示例：');
  for (const acc of ACCOUNTS) {
    console.log(`  /account-insight.html?id=${acc.id}  → ${acc.name}`);
  }
}

main()
  .catch((e) => { console.error('SEED ERROR:', e); process.exit(1); })
  .finally(() => pool.end());
