// test/web/portalModuleMount.test.js — 守卫：HTML 引用 /portal/*.js 必须有 routes.js 对应 sendFile
// 根因：2026-09-05 决策场景配置报「无销售场景」，实质 ESM 模块若未挂静态路由，浏览器拉空 200
//         → 命名空间对象内容空 → 渲染分支 null 兜底显示「无销售场景」
// 校验：每条 src/web/*.html 里形如 /portal/<Name>.js 的 import，src/http/routes.js 必须有 sendFile(...)
//       命中该路径（要么 `/portal/<Name>.js` 字面，要么 sendFile 引用 '...portal/<Name>.js'）
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.cwd());
const WEB_DIR = path.join(ROOT, 'src/web');
const ROUTES_FILE = path.join(ROOT, 'src/http/routes.js');

function readSafe(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}
function walk(dir, ext = ['.html', '.htm']) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, ext));
    else if (ext.includes(path.extname(e.name))) out.push(p);
  }
  return out;
}

describe('门户模块静态挂载守卫 (/portal/*.js)', () => {
  const htmlFiles = walk(WEB_DIR);
  const routesSrc = readSafe(ROUTES_FILE);
  // 把 routes.js 里所有「/portal/<name>.js」字面 / 模板字符串组合 / sendFile 引用 / app.get 注册路径 抓出来
  // 4 种字面模式逐一命中任一即视为已挂载：
  //   ① app.get('/portal/X.js', ...)         直接字面 app.get 注册
  //   ② app.get(`/portal/${var}.js`, ...)     模板字符串循环注册（如 BD_PAGES）
  //   ③ sendFile('...portal/X.js' | `...portal/${var}.js`) 引用文件
  //   ④ 任何 '/portal/X.js' 文本出现
  const directAppGet = /\bapp\.get\(\s*['"`]\/portal\/([A-Za-z][A-Za-z0-9_]*)\.js['"`]/g;
  const tplAppGet    = /\bapp\.get\(\s*`\/portal\/\$\{([^}]+)\}\.js`/g;
  const directSrv    = /sendFile\([^)]*['"`]\.?\.\/portal\/([A-Za-z][A-Za-z0-9_]*)\.js['"`]/g;
  const tplSrv       = /sendFile\([^)]*`\.?\.\/portal\/\$\{([^}]+)\}\.js`/g;
  const anyLiteral   = /\/portal\/([A-Za-z][A-Za-z0-9_]*)\.js/g;
  const mounted = new Set();
  for (const m of routesSrc.matchAll(directAppGet)) mounted.add(`${m[1]}.js`);
  // 模板 app.get 里需要从外层 foreach 抓 [pg, mod] 等解构——这里保守检测：只要含有 /portal/${...}.js 模板，假设 BD_PAGES 中所有 mod 都被注册
  if (tplAppGet.test(routesSrc) || tplSrv.test(routesSrc)) {
    // 抓 routes.js 中所有 `[name, 'modName']` 元组（BD_PAGES 形态 / 双元素数组）
    const entryRe = /\[\s*['"]?[a-z0-9-]+['"]?\s*,\s*['"]([A-Za-z][A-Za-z0-9_]+)['"]\s*\]/g;
    for (const m of routesSrc.matchAll(entryRe)) mounted.add(`${m[1]}.js`);
  }
  for (const m of routesSrc.matchAll(directSrv)) mounted.add(`${m[1]}.js`);
  for (const m of routesSrc.matchAll(anyLiteral)) mounted.add(`${m[1]}.js`);
  // HTML 里的 import / src 形如 '/portal/<name>.js' 或 "/portal/<name>.js"
  const importRe = /['"`]\/portal\/([A-Za-z][A-Za-z0-9_]*\.js)['"`]/g;
  const missing = []; // 缺失挂载的清单

  for (const hf of htmlFiles) {
    const html = readSafe(hf);
    const htmlImports = new Set([...html.matchAll(importRe)].map((m) => m[1]));
    for (const mod of htmlImports) {
      if (!mounted.has(mod)) {
        missing.push({ page: path.relative(ROOT, hf), module: mod });
      }
    }
  }

  it('所有 /portal/*.js 静态引用都有 sendFile 挂载', () => {
    if (missing.length) {
      const lines = missing.map((m) => `  ${m.page}: ${m.module}`).join('\n');
      throw new Error(
        `以下 ${missing.length} 个 /portal/*.js 在 HTML 被引用，但 routes.js 未挂 sendFile，浏览器拉空 200 导致页面崩溃:\n${lines}\n\n` +
        `修法: 在 src/http/routes.js 加 app.get('/portal/<name>.js', (req, res) => res.sendFile(...))，参照 2707/2727 行。`
      );
    }
    expect(missing).toEqual([]);
  });

  it('mounted 集合非空（确保守卫本身工作）', () => {
    expect(mounted.size).toBeGreaterThan(0);
  });
});
