// MCP 页面浏览器实测：加载 → 列表 → 点击新增 → 校验 token 弹窗与网络
import { chromium } from 'playwright';

const logs = [];
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.on('console', (m) => logs.push(`[console.${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
page.on('requestfailed', (r) => logs.push(`[reqfail] ${r.url()} ${r.failure()?.errorText}`));
page.on('response', (r) => { if (r.url().includes('/api/')) logs.push(`[resp ${r.status()}] ${r.url()}`); });

await page.goto('http://localhost:3000/mcp-identities.html', { waitUntil: 'networkidle' });
console.log('=== 页面标题 ===', await page.title());
const addBtn = page.locator('#add');
console.log('=== add 按钮可见性 ===', await addBtn.isVisible());
console.log('=== 表格行数 ===', await page.locator('.mcp-row').count());
console.log('=== summary ===', (await page.locator('#summary').textContent()).trim());

// 触发新增：两个 prompt 依次接受
page.once('dialog', async (d) => { console.log('=== dialog1:', d.message()); await d.accept('qa-page-test-bot'); });
page.once('dialog', async (d) => { console.log('=== dialog2:', d.message()); await d.accept('sales'); });
await addBtn.click();
await page.waitForTimeout(1500);

const tokenVisible = await page.locator('#tokenModal').isVisible().catch(() => false);
console.log('=== token 弹窗可见 ===', tokenVisible);
if (tokenVisible) {
  const t = (await page.locator('#tokenText').textContent()).trim();
  console.log('=== token 前缀 ===', String(t).slice(0, 12) + '...');
}

console.log('\n=== 浏览器日志 ===');
for (const l of logs) console.log(l);
await browser.close();