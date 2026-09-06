// scripts/calibration-p0-acceptance.mjs — P0 手工验收（决策→待办→人工处置→被调量计数）
// 判定标准：步骤 4 的 human_disposition 计数从 0 → ≥1（P0 打通）
// 用法：node scripts/calibration-p0-acceptance.mjs
import { pool } from '../src/db.js';
import { createApp } from '../src/http/server.js';
import { issueToken } from '../src/http/auth.js';
import { createDecision } from '../src/decision/decisionRepo.js';

const app = createApp();

async function step1() {
  // 1) 先造一个 AI 自主决策（无先例 → LEAD_FOLLOW_UP 场景）作为被处置对象
  const d = await createDecision({
    scenario_id: 'LEAD_FOLLOW_UP',
    trigger_context: { name: 'P0验收商机' },
    involved_entities: [],
    conditions_evaluated: [],
    disposition: 'APPROVE',
    decider_type: 'AUTONOMOUS_AGENT',
    rationale: 'P0验收决策',
    business_tier: 'LEAD',
    state: 'AUTONOMOUS',
  });
  return d;
}

async function step3(decisionId) {
  // 3) 人工处置（改判：APPROVE → REJECT）——走 HTTP 端点（模拟经理 bob）
  const res = await app.fetch(`/api/decisions/${decisionId}/disposition`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${issueToken({ username: 'bob', role: 'manager', display_name: '鲍勃' })}`,
    },
    body: JSON.stringify({ disposition: 'REJECT', note: 'P0 验收' }),
  });
  return { status: res.status, body: await res.json() };
}

async function step4() {
  const r = await pool.query(`SELECT count(*) FROM crm.decision WHERE human_disposition IS NOT NULL`);
  return Number(r.rows[0].count);
}

// 基线：先确认当前为 0（P0 验收从 0 → ≥1）
const baseline = await step4();
console.log('⓪ 基线 human_disposition 计数 →', baseline);

const d = await step1();
console.log('① AI 自主决策已建 →', d.decision_id);

const s3 = await step3(d.decision_id);
console.log('② 人工处置(改判) →', s3.status, JSON.stringify(s3.body));
if (s3.status !== 200 || !s3.body.ok) {
  console.log('✗ 处置端点非 200，验收中止');
  await pool.end();
  process.exit(1);
}

const after = await step4();
console.log('③ 被调量计数(处置后) →', after);
console.log(after >= 1 ? '✅ P0 验收通过：被调量 0 → ' + after : '✗ 被调量仍为 0');

await pool.end();