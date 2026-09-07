import { chromium } from 'playwright';

const items = [
  { sel: '#arch', out: '北京青羽智行科技有限公司-CRM-AI-Native-技术架构图.png' },
  { sel: '#features', out: '北京青羽智行科技有限公司-CRM-AI-Native-产品功能总览.png' },
  { sel: '#bizmodel', out: '北京青羽智行科技有限公司-CRM-AI-Native-商业模式图.png' },
  { sel: '#market', out: '北京青羽智行科技有限公司-CRM-AI-Native-市场定位图.png' }
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 2 });
await page.goto('file:///D:/system/CRM-ai-native/doc/event/bp/product-images.html', { waitUntil: 'networkidle' });
for (const it of items) {
  await page.locator(it.sel).screenshot({ path: 'D:/system/CRM-ai-native/doc/event/bp/' + it.out });
  console.log('ok', it.out);
}
await browser.close();
