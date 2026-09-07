import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('file://' + process.cwd() + '/doc/copyright/user-manual.html', { waitUntil: 'networkidle' });
await page.pdf({ path: 'doc/copyright/user-manual.pdf', format: 'A4', printBackground: true,
  margin: { top: '18mm', bottom: '18mm', left: '16mm', right: '16mm' } });
await browser.close();
console.log('OK -> doc/copyright/user-manual.pdf');
