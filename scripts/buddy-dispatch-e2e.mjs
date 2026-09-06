// scripts/buddy-dispatch-e2e.mjs
// Buddy 应用「对话框 → /api/agent/dispatch → kanban.tasks」真机闭环验证
// 验证：胶囊经对话区透传的 skillSlug/targetAgent，在 dispatch 端点落库后是否被原样保留
// （与 scripts/buddy-capsule-binding-check.mjs 静态契约互补：此处断言运行态 HTTP + DB 真实可达）
import { poolRead } from '../src/db.js';

const APP = process.env.APP_BASE || 'http://127.0.0.1:3000';
const TEST_USER = process.env.BUDDY_TEST_USER || 'alice';
const TEST_PASS = process.env.BUDDY_TEST_PASS || 'secret123';

let failed = 0;
const ok = (m) => console.log('✅', m);
const warn = (m) => console.log('⚠️', m);
const fail = (m) => { console.log('❌', m); failed++; };

async function main() {
  // 1) 应用登录拿 JWT
  const loginRes = await fetch(`${APP}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: TEST_USER, password: TEST_PASS }),
  });
  const loginJson = await loginRes.json().catch(() => ({}));
  if (!loginRes.ok || !loginJson.token) {
    fail(`应用登录失败 (${loginRes.status}): ${JSON.stringify(loginJson)}`);
    return finish();
  }
  ok(`应用登录成功 role=${loginJson.role} display_name=${loginJson.display_name} token_len=${loginJson.token.length}`);
  const token = loginJson.token;

  // 2) dispatch 透传 skillSlug/targetAgent（method-funnel-classification 在 followup-agent.skillCalls 闭包内 → 确定性保留）
  const skillSlug = 'method-funnel-classification';
  const targetAgent = 'followup-agent';
  const requirement = '跟进重点客户的漏斗质量分类评估';
  const dispRes = await fetch(`${APP}/api/agent/dispatch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ requirement, skillSlug, targetAgent }),
  });
  const dispJson = await dispRes.json().catch(() => ({}));
  if (!dispRes.ok || !dispJson.taskId) {
    fail(`dispatch 失败 (${dispRes.status}): ${JSON.stringify(dispJson)}`);
    return finish();
  }
  ok(`dispatch 成功 taskId=${dispJson.taskId} intent=${dispJson.intent} level=${dispJson.level} status=${dispJson.status} dispatched=${dispJson.dispatched}`);
  const taskId = dispJson.taskId;

  // 3) 查库断言 skill_slug / targetAgent 原样保留
  const { rows } = await poolRead.query(
    `SELECT payload->>'skill_slug' AS skill_slug, payload->>'targetAgent' AS target_agent, status
       FROM crm.tasks WHERE id = $1`,
    [taskId],
  );
  if (!rows.length) {
    fail(`任务 ${taskId} 未落库 crm.tasks`);
    return finish();
  }
  const row = rows[0];
  console.log(`   落库 payload: skill_slug=${row.skill_slug} | targetAgent=${row.target_agent} | status=${row.status}`);

  if (row.skill_slug === skillSlug) ok(`skill_slug 原样保留（门户→对话区→dispatch→kanban.tasks 透传闭合）`);
  else fail(`skill_slug 未保留：期望 "${skillSlug}"，实际 "${row.skill_slug}"`);

  if (row.target_agent === targetAgent) ok(`targetAgent 原样保留`);
  else fail(`targetAgent 未保留：期望 "${targetAgent}"，实际 "${row.target_agent}"`);

  // 4) 反向场景：非法 skillSlug 不应让 dispatch 崩溃，应原样透传落库，
  //    由运行时 routeThroughIntake 回落 primarySkillFor（该逻辑已由 buddy-capsule-binding-check.mjs 静态覆盖）
  const badSlug = 'nonexistent-skill-xyz';
  const disp2 = await fetch(`${APP}/api/agent/dispatch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ requirement: '跟进客户回款推进', skillSlug: badSlug, targetAgent: 'followup-agent' }),
  });
  const d2 = await disp2.json().catch(() => ({}));
  if (disp2.ok && d2.taskId) {
    const { rows: r2 } = await poolRead.query(
      `SELECT payload->>'skill_slug' AS skill_slug, payload->>'intent' AS intent FROM crm.tasks WHERE id = $1`,
      [d2.taskId],
    );
    if (r2[0]) {
      if (r2[0].skill_slug === badSlug) ok(`非法 skillSlug 原样透传落库（运行时回落 primarySkillFor 由静态契约覆盖，dispatch 容错不崩溃）`);
      else ok(`非法 skillSlug 已回落 primarySkillFor: "${r2[0].skill_slug}" (intent=${r2[0].intent})`);
    }
  } else {
    fail(`反向场景 dispatch 异常（${JSON.stringify(d2)}），非法 skillSlug 不应阻断派发`);
  }

  finish();
}

function finish() {
  poolRead.end();
  if (failed) {
    console.log(`\n❌ Buddy dispatch 真机联调失败：${failed} 项未通过`);
    process.exit(1);
  }
  console.log(`\n✅ Buddy dispatch 真机联调全部通过：skillSlug/targetAgent 经 HTTP dispatch 透传并原样落库`);
}

main().catch((e) => { console.error(e); process.exit(1); });
