import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const src = resolve('doc/sales-platform-features.html');
const out = resolve('doc/sales-platform-features.pdf');

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(pathToFileURL(src).href, { waitUntil: 'networkidle' });

// 打印适配：展开全部面板、隐藏交互元素、按幕分页
await page.addStyleTag({ content: `
  .panel { display: block !important; }
  .acts { display: none !important; }
  .stage { display: none !important; }
  section.panel { page-break-before: always; padding-top: 8px; }
  section.panel#panel1 { page-break-before: auto; }
  .wrap { max-width: 100%; padding: 20px 8mm; }
  body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
`});

await page.pdf({
  path: out,
  format: 'A4',
  printBackground: true,
  margin: { top: '10mm', bottom: '10mm', left: '8mm', right: '8mm' },
});
await browser.close();
console.log('PDF 已生成:', out);
