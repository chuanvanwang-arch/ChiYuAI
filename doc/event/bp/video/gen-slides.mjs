import { chromium } from 'playwright';
const ids = ['s1','s2','s3','s4','s5','s6','s7','s8','s9','s10'];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1980, height: 1160 }, deviceScaleFactor: 1 });
await page.goto('file:///D:/system/CRM-ai-native/doc/event/bp/video/slides.html', { waitUntil: 'networkidle' });
for (const id of ids) {
  await page.locator('#' + id).screenshot({ path: `D:/system/CRM-ai-native/doc/event/bp/video/${id}.png` });
  console.log('ok', id);
}
await browser.close();
