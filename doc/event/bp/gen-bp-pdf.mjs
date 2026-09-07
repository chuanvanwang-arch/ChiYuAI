import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('file:///D:/system/CRM-ai-native/doc/event/bp/bp.html', { waitUntil: 'networkidle' });
await page.pdf({
  path: 'D:/system/CRM-ai-native/doc/event/bp/北京青羽智行科技有限公司-CRM-AI-Native-商业计划书.pdf',
  format: 'A4',
  printBackground: true,
  preferCSSPageSize: true
});
await browser.close();
console.log('done');
