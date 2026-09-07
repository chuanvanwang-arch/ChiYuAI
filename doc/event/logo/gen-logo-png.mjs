import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const svgPath = resolve('doc/event/logo/qingyu-logo.svg');
const outPath = resolve('doc/event/logo/qingyu-logo.png');

// deviceScaleFactor=2：1200x360 逻辑尺寸 → 2400x720 物理像素（300dpi 展示足够）
const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1200, height: 360 },
  deviceScaleFactor: 2,
});
await page.goto(pathToFileURL(svgPath).href, { waitUntil: 'load' });
await page.locator('svg').screenshot({ path: outPath, omitBackground: true });
await browser.close();
console.log('PNG 已生成:', outPath);
