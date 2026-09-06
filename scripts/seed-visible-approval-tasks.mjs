// scripts/seed-visible-approval-tasks.mjs
// 用途：在 live crm_native 库创建「待我审批」可见的种子数据（提交后不审批，保持 TODO 状态）
// 目标：让 sales(alice) 在浏览器「我的待办→待我审批」立即看到数据 + 侧栏角标亮起
//
// 关键：应用查询审批粒子过滤 tenant_id='system'（见 workbenchRouter.js:40-41 queryApprovalTasks/Instances），
//      故种子数据必须写 tenant_id='system'，否则 invisible（此前 default 租户写法是 bug）。
//
// 用法：node scripts/seed-visible-approval-tasks.mjs          （默认 crm_native）
//       PGDATABASE=crm_native_test node scripts/...           （测试库）
//
// 幂等：同 business_id 不重复创建实例；已存在 TODO 任务则跳过。

import pg from 'pg';
import { randomUUID } from 'crypto';

const PGDATABASE = process.env.PGDATABASE || 'crm_native';
const TENANT = 'system'; // ← 应用查询过滤的租户，必须与之一致
const pool = new pg.Pool({
  host: '127.0.0.1', port: 5433,
  user: 'agent2b', password: 'agent2b',
  database: PGDATABASE,
  options: '-c search_path=crm,public',
});

const ok = (cond, label) => { if (!cond) { console.error(`FAIL: ${label}`); process.exit(1); } else console.log(`  OK ${label}`); };
const now = () => new Date().toISOString();

// ── 0. 清理本脚本此前误写入 default 租户的孤儿数据（软退休，禁删铁律）──
const clean = await pool.query(
  `UPDATE particles SET payload = jsonb_set(jsonb_set(payload, '{status}', '"CANCELED"'), '{retired_note}', '"seed-default-orphan"')
   WHERE tenant_id='default'
     AND type IN ('CRM_APPROVAL_TASK','CRM_APPROVAL_INSTANCE','CRM_QUOTATION')
     AND (slug LIKE 'q-seed-%' OR slug LIKE 'inst-q-seed-%' OR slug LIKE 'task-q-seed-%')`,
);
if (clean.rowCount > 0) console.log(`[0] 软退休 default 租户孤儿数据 ${clean.rowCount} 条`);

// ── 1. 查 quote 审批流（seed-approval-flows.mjs 已建，tenant=system）──
const flows = await pool.query(
  "SELECT id, payload FROM particles WHERE type='CRM_APPROVAL_FLOW' AND tenant_id=$1 AND payload->>'enabled'='true' AND payload->>'domain'='quote'",
  [TENANT]
);
ok(flows.rows.length > 0, 'quote 审批流存在（tenant=system）');
const flowId = flows.rows[0].id;
console.log(`[1] flow_id=${flowId.slice(0,8)}…`);

// ── 2. 确保有一条报价单粒子（submitted 态，tenant=system）──
const quoteId = `q-seed-${Date.now()}`;
const existingQuote = await pool.query(
  "SELECT id FROM particles WHERE type='CRM_QUOTATION' AND tenant_id=$1 AND slug=$2", [TENANT, quoteId]
);
if (existingQuote.rows.length === 0) {
  await pool.query(
    `INSERT INTO particles (id, type, slug, title, tenant_id, payload, created_at, updated_at)
     VALUES ($1, 'CRM_QUOTATION', $2, $3, $4, $5::jsonb, $6, $6)`,
    [randomUUID(), quoteId, '测试报价单（审批流演示）', TENANT, JSON.stringify({
      name: '测试报价单（审批流演示）',
      customer: '演示客户A',
      amount: 128000,
      status: 'submitted',
      submitted_by: 'alice',
      submitted_at: now(),
    }), now()]
  );
  console.log(`[2] 新建报价单 ${quoteId}（tenant=system）`);
} else {
  console.log(`[2] 报价单 ${quoteId} 已存在，跳过`);
}

// ── 3. 查是否已有该报价单的进行中实例（限定 tenant=system）──
const existingInst = await pool.query(
  "SELECT id, payload->>'status' AS status FROM particles WHERE type='CRM_APPROVAL_INSTANCE' AND tenant_id=$1 AND payload->>'business_id'=$2 AND payload->>'status' IN ('PENDING','APPROVING')",
  [TENANT, quoteId]
);

let instanceId;
if (existingInst.rows.length > 0) {
  instanceId = existingInst.rows[0].id;
  console.log(`[3] 实例已存在（${existingInst.rows[0].status}），跳过创建`);
} else {
  instanceId = randomUUID();
  await pool.query(
    `INSERT INTO particles (id, type, slug, title, tenant_id, payload, created_at, updated_at)
     VALUES ($1, 'CRM_APPROVAL_INSTANCE', $2, $3, $4, $5::jsonb, $6, $6)`,
    [instanceId, `inst-${quoteId}`, `审批实例-${quoteId}`, TENANT, JSON.stringify({
      flow_id: flowId,
      domain: 'quote',
      business_type: 'CRM_QUOTATION',
      business_id: quoteId,
      submitter: 'alice',
      status: 'APPROVING',
      current_node: 'node_approver_1',
      created_at: now(),
    }), now()]
  );
  console.log(`[3] 新建实例 ${instanceId.slice(0,8)}…（APPROVING, tenant=system）`);
}

// ── 4. 创建待审批 TASK（role:sales → alice 可见，tenant=system）──
const taskId = randomUUID();
const existingTask = await pool.query(
  "SELECT id FROM particles WHERE type='CRM_APPROVAL_TASK' AND tenant_id=$1 AND payload->>'instance_id'=$2 AND (payload->>'status')='TODO'",
  [TENANT, instanceId]
);
if (existingTask.rows.length === 0) {
  await pool.query(
    `INSERT INTO particles (id, type, slug, title, tenant_id, payload, created_at, updated_at)
     VALUES ($1, 'CRM_APPROVAL_TASK', $2, $3, $4, $5::jsonb, $6, $6)`,
    [taskId, `task-${quoteId}`, '测试报价单审批任务', TENANT, JSON.stringify({
      instance_id: instanceId,
      title: '测试报价单（审批流演示）',
      approver: 'role:sales',
      status: 'TODO',
      seq: 1,
      created_at: now(),
    }), now()]
  );
  console.log(`[4] 新建 TODO 任务 ${taskId.slice(0,8)}…（approver=role:sales ← alice 可见, tenant=system）`);
} else {
  console.log(`[4] TODO 任务已存在，跳过`);
}

// ── 5. 验证：查询 alice 视角能看到的数据（模拟应用查询：tenant=system + role:sales）──
console.log('\n=== 验证：alice(sales) 待我审批视角（tenant=system）===');
const visible = await pool.query(
  `SELECT id, payload->>'title' AS title, payload->>'approver' AS approver, payload->>'status' AS status
   FROM particles WHERE type='CRM_APPROVAL_TASK' AND tenant_id=$1
   AND (payload->>'status') IN ('TODO','todo')
   AND payload->>'approver' IN ('alice', 'role:sales')
   ORDER BY created_at DESC LIMIT 10`,
  [TENANT]
);
console.table(visible.rows);
console.log(`\n✅ 种子完成：${visible.rows.length} 条待审批任务对 sales(alice) 可见（tenant=system）`);
console.log('   刷新浏览器「我的待办」页面即可看到数据，侧栏角标应显示数字');

await pool.end();
