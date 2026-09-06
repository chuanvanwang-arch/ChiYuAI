// scripts/buddy-ui-e2e.mjs
// Buddy 应用 · 浏览器端到端联调（Playwright）
//
// 覆盖此前三层套件未触达的 UI 盲区：
//   ① 主 Tab 渲染 + 切换（finance 角色含财务 Tab 共 6 个，其余角色 5 个）
//   ② 全部场景胶囊「点击 → postMessage(inject-prompt) → agent-workbench 对话区输入框预填」
//      （核心 UX：门户胶囊驱动对话，此前 0% 自动化）
//   ③ 财务 Tab 角色闸门（零信任防御纵深）：仅 finance 角色可见
//   ④ 单点完整闭环：胶囊(重点客户/method-funnel-classification) → 注入 → 提交 →
//      /api/agent/dispatch → crm.tasks 落库且 skill_slug 原样保留
//
// 前置：App(3000) + PG(5433) + （派发可选）MCP(3001) 在线；本脚本只依赖 App + PG。
// 用法：
//   node scripts/buddy-ui-e2e.mjs
// 环境变量：
//   BASE_URL        默认 http://127.0.0.1:3000
//   BUDDY_TEST_USER 默认 alice（业务账号）
//   BUDDY_TEST_PASS 默认 secret123
import { chromium } from 'playwright';
import { poolRead } from '../src/db.js';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';
const TEST_USER = process.env.BUDDY_TEST_USER || 'alice';
const TEST_PASS = process.env.BUDDY_TEST_PASS || 'secret123';
const EXPECT_CAPS_PER_TAB = 4;
const FINANCE_ROLES = ['finance', 'admin', 'sysadmin'];

let failed = 0;
const log = (...a) => console.log(...a);
const ok = (m) => log('  ✅', m);
const warn = (m) => log('  ⚠️ ', m);
const fail = (m) => { log('  ❌', m); failed++; };

async function pollInputValue(goal, predicate, timeoutMs = 4000) {
  const steps = Math.max(1, Math.floor(timeoutMs / 150));
  for (let i = 0; i < steps; i++) {
    const v = await goal.inputValue().catch(() => '');
    if (predicate(v)) return v;
    await new Promise((r) => setTimeout(r, 150));
  }
  return goal.inputValue().catch(() => '');
}

async function main() {
  // ① 登录领 JWT（提交闭环需在 localStorage 带 token）
  const loginRes = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: TEST_USER, password: TEST_PASS }),
  });
  const loginJson = await loginRes.json().catch(() => ({}));
  if (!loginRes.ok || !loginJson.token) {
    fail(`应用登录失败 (${loginRes.status}): ${JSON.stringify(loginJson)}`);
    return finish();
  }
  const token = loginJson.token;
  ok(`登录 ${TEST_USER} 成功（role=${loginJson.role}）`);
  const isFinance = FINANCE_ROLES.includes(loginJson.role);

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  // 令牌在页面脚本执行前注入，门户角色闸门（applyRoleGating）才能取到 token
  await ctx.addInitScript((t) => localStorage.setItem('crm_token', t), token);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => warn('pageerror: ' + e.message));

  await page.goto(`${BASE}/portal/buddy-crm-portal.html`, { waitUntil: 'domcontentloaded' });

  // 等待对话区 iframe 的 goal 输入框就绪（inject 目标）
  const chat = page.frameLocator('#buddy-chat');
  const goal = chat.locator('form.pg-form input[name="goal"]');
  try {
    await goal.waitFor({ state: 'visible', timeout: 15000 });
    ok('对话区 iframe 加载，goal 输入框可见（inject 目标存在）');
  } catch {
    fail('对话区 iframe 未加载 goal 输入框（inject 目标缺失，门户接线断裂）');
    await browser.close();
    return finish();
  }

  // ② Tab 渲染（仅统计可见 Tab；财务 Tab 对非 finance 角色隐藏）
  const allTabCount = await page.locator('.buddy-tab').count();
  const visibleTabs = page.locator('.buddy-tab:visible');
  const tabLabels = (await visibleTabs.allInnerTexts()).map((s) => s.trim()).filter(Boolean);
  log(`\n① Tab 渲染：DOM ${allTabCount} 个，可见 ${tabLabels.length} 个 → ${tabLabels.join(' / ')}`);
  const EXPECT_TABS = isFinance ? 6 : 5;
  if (tabLabels.length !== EXPECT_TABS) fail(`可见 Tab 数量应为 ${EXPECT_TABS}（finance 角色含财务 Tab），实际 ${tabLabels.length}`);
  else ok(`${tabLabels.length} 个可见主 Tab 渲染`);

  // ③ 财务 Tab 角色闸门（零信任防御纵深）
  const finVisible = await page.locator('.buddy-tab[data-tab="财务"]').isVisible().catch(() => false);
  if (isFinance) finVisible ? ok('财务 Tab 对 finance 角色可见（角色闸门正确放行）') : fail('finance 角色下财务 Tab 应可见但未显示');
  else finVisible ? fail('非 finance 角色下财务 Tab 不应可见（角色闸门泄露）') : ok('非 finance 角色下财务 Tab 已隐藏（零信任防御纵深生效）');

  // ④ 遍历可见 Tab 的全部胶囊，断言点击→对话区预填（隐藏 Tab 跳过，避免误点不可见元素）
  let capTotal = 0;
  for (const tab of tabLabels) {
    await page.locator('.buddy-tab', { hasText: tab }).click();
    await page.waitForTimeout(250); // 等 Tab 切换后胶囊重渲染稳定（避免首胶囊点击竞态）
    await page.locator('#buddy-caps crm-button.buddy-cap').first()
      .waitFor({ state: 'visible', timeout: 5000 });
    const caps = page.locator('#buddy-caps crm-button.buddy-cap');
    const n = await caps.count();
    capTotal += n;
    if (n !== EXPECT_CAPS_PER_TAB) warn(`Tab[${tab}] 胶囊数=${n}（期望 ${EXPECT_CAPS_PER_TAB}）`);
    for (let i = 0; i < n; i++) {
      const capEl = page.locator('#buddy-caps crm-button.buddy-cap').nth(i);
      const label = (await capEl.innerText()).trim();
      await goal.evaluate((el) => { el.value = ''; }); // 清空，确保断言检测的是本次注入
      const before = await goal.inputValue();
      await capEl.click();
      const v = await pollInputValue(goal, (val) => val.trim().length > 0 && val !== before, 4000);
      if (v.trim().length > 0) ok(`  [${tab}/${label}] 点击 → 对话区注入预填 ✔`);
      else fail(`  [${tab}/${label}] 点击后对话区未预填（inject-prompt 未送达）`);
    }
  }
  log(`\n② 胶囊注入覆盖：${capTotal} 个`);
  const expectCaps = isFinance ? 24 : 20;
  if (capTotal !== expectCaps) warn(`胶囊总数 ${capTotal}（期望 ${expectCaps}，若门户调整以实际为准）`);

  // ⑤ 业务视图 iframe 加载（软校验，避免 account-360 数据缺失误判）
  const view = page.frameLocator('#buddy-view');
  const viewOk = await view.locator('body').innerText().then((t) => t.trim().length > 0).catch(() => false);
  viewOk ? ok('业务视图 iframe 已加载内容') : warn('业务视图 iframe 未返回内容（不影响胶囊注入闭环）');

  // ⑥ 单点完整闭环：重点客户 → method-funnel-classification → 提交 → dispatch → DB
  log('\n③ 闭环验证：胶囊 → 注入 → 提交 → dispatch → DB');
  await page.locator('.buddy-tab', { hasText: '客户洞察' }).click();
  await page.waitForTimeout(250);
  await page.locator('#buddy-caps crm-button.buddy-cap', { hasText: '重点客户' }).click();
  const gv = await pollInputValue(goal, (v) => v.includes('method-funnel-classification'), 5000);
  if (gv.includes('method-funnel-classification')) ok('注入内容为正确绑定 method-funnel-classification');
  else warn(`注入内容未含预期 skill：${gv.slice(0, 60)}`);

  // 提交前记录时间戳，用于判定本次提交新建的任务（避免与历史行混淆）
  const { rows: cut } = await poolRead.query('SELECT COALESCE(MAX(created_at), now()) AS mx FROM crm.tasks');
  const cutoff = cut[0].mx;

  await chat.locator('form.pg-form button').click();
  ok('已点击对话区提交按钮（派发请求已发出）');

  // 以 DB 落库为权威判定：轮询 crm.tasks 是否出现本次提交的 method-funnel-classification 任务
  let loopTask = null;
  for (let i = 0; i < 50; i++) {
    const { rows: nr } = await poolRead.query(
      `SELECT id, payload->>'skill_slug' AS s, status FROM crm.tasks
         WHERE payload->>'skill_slug' = $1 AND created_at > $2 ORDER BY created_at DESC LIMIT 1`,
      ['method-funnel-classification', cutoff],
    );
    if (nr[0]) { loopTask = nr[0]; break; }
    await new Promise((r) => setTimeout(r, 300));
  }
  if (loopTask) {
    ok(`DB 落库闭环成功：taskId=${loopTask.id} skill_slug=${loopTask.s} status=${loopTask.status}`);
    if (loopTask.s !== 'method-funnel-classification') fail('DB skill_slug 与注入绑定不符');
  } else {
    fail('提交后 crm.tasks 未出现新的 method-funnel-classification 任务（闭环断裂）');
  }

  // 软校验：对话区结果文本（不阻塞，dispatch 异步刷新可能慢于 DB 落库）
  const boxText = await chat.locator('body').innerText().catch(() => '');
  if (/已派发任务/.test(boxText)) ok('对话区结果框显示「已派发任务」');
  else if (/需澄清/.test(boxText)) warn('对话区显示「需澄清」（链路通，但未生成任务）');
  else warn('对话区结果框尚未刷新为终态（不影响 DB 闭环判定）');

  await browser.close();
  finish();
}

function finish() {
  try { poolRead.end(); } catch {}
  if (failed) {
    log(`\n❌ Buddy UI E2E 失败：${failed} 项未通过`);
    process.exit(1);
  }
  log('\n✅ Buddy UI E2E 全部通过：主 Tab 渲染 + 角色闸门 + 胶囊注入 + 单点闭环（DB skill_slug 保留）');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
