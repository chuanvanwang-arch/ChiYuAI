// scripts/shot-sales-menu-order.mjs — 真实浏览器取证：侧栏「销售」组渲染次序 + 菜单名=落点页名（2026-09-18）
// 只读：登录 alice(sales) → 打开 pipeline.html → 提取各分组渲染文本 → 逐个点开 5 个落点页读 title/h1 → 截图。
// 2026-09-18 二次裁定（两个改名）后新增跨层校验：菜单显示名必须出现在对应落点页的 title/h1 中。
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = process.env.CRM_BASE || 'http://localhost:3000';
const OUTDIR = 'reports/2026-09-18-menu-order';
fs.mkdirSync(OUTDIR, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();

const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));

const lr = await page.request.post(`${BASE}/api/auth/login`, { data: { username: 'alice', password: 'secret123' } });
const lj = await lr.json();
console.log(`[login] status=${lr.status()} role=${lj.role || lj.error}`);
if (!lj.token) { console.error('登录失败，终止'); process.exit(1); }

await ctx.addInitScript(([t, r]) => {
  localStorage.setItem('crm_token', t);
  localStorage.setItem('crm_role', r);
  localStorage.setItem('crm_name', '爱丽丝');
}, [lj.token, lj.role]);

await page.goto(`${BASE}/pipeline.html`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.nav-group', { timeout: 15000 });
await page.waitForTimeout(1200);

const groups = await page.$$eval('.nav-group', (gs) => gs.map((g) => ({
  group: (g.querySelector('.nav-group-title')?.textContent || '').trim(),
  items: [...g.querySelectorAll('.nav-item .nav-label')].map((x) => x.textContent.trim()),
})));
console.log('\n[侧栏实际渲染]');
for (const g of groups) console.log(`  ${g.group}: ${g.items.join(' → ')}`);

const sales = groups.find((g) => g.group === '销售');
const EXPECT = ['线索发现', '公海池', '销售管道', '客户跟踪', '销售过程看板'];
const okOrder = sales && JSON.stringify(sales.items) === JSON.stringify(EXPECT);
console.log(`\n[销售组次序判定] ${okOrder ? 'PASS' : 'FAIL'}  期望: ${EXPECT.join(' → ')}`);

const box = await page.evaluate(() => {
  const rs = [...document.querySelectorAll('.nav-group')].map((g) => g.getBoundingClientRect());
  const x = Math.min(...rs.map((r) => r.x)), y = Math.min(...rs.map((r) => r.y));
  const right = Math.max(...rs.map((r) => r.right)), bottom = Math.max(...rs.map((r) => r.bottom));
  return { x: Math.max(0, Math.floor(x) - 14), y: Math.max(0, Math.floor(y) - 40), width: Math.ceil(right - x) + 28, height: Math.ceil(bottom - y) + 70 };
});
await page.screenshot({ path: `${OUTDIR}/sales-menu-order.png`, clip: box });
console.log(`\n[截图] ${OUTDIR}/sales-menu-order.png  clip=${JSON.stringify(box)}`);

// ── 跨层校验：菜单名 ∈ 落点页 title/h1（改名后新增，防「点进去名字不一样」回潮）──
const PAGES = [
  ['线索发现', '/discovery.html'],
  ['公海池', '/lead-pool.html'],
  ['销售管道', '/pipeline.html'],
  ['客户跟踪', '/named-accounts.html'],
  ['销售过程看板', '/sales-behavior-board.html'],
];
console.log('\n[菜单名 = 落点页名]');
let okCross = true;
for (const [label, href] of PAGES) {
  await page.goto(`${BASE}${href}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(700);
  const t = await page.title();
  const h1 = await page.$eval('.page-title', (el) => el.textContent.trim()).catch(() => '');
  const hit = `${t} ${h1}`.includes(label);
  okCross = okCross && hit;
  console.log(`  ${hit ? 'PASS' : 'FAIL'}  菜单「${label}」 vs 页面 title="${t}" h1="${h1}"`);
  if (href === '/sales-behavior-board.html') {
    await page.screenshot({ path: `${OUTDIR}/renamed-board-page.png`, clip: { x: 0, y: 0, width: 1400, height: 220 } });
    console.log(`  [截图] ${OUTDIR}/renamed-board-page.png`);
  }
}

console.log(`[页面 JS 错误] ${errs.length ? errs.join(' | ') : '无'}`);

const ok = okOrder && okCross && errs.length === 0;
console.log(`\n总判定: ${ok ? 'PASS' : 'FAIL'}`);
await browser.close();
process.exit(ok ? 0 : 1);
