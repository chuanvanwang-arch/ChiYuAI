// 生成软著「程序鉴别材料」：源程序前连续30页 + 后连续30页（每页50行）的打印用 HTML
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const SOFTWARE = 'AI 原生智能销售管理平台（CRM-AI-Native）';
const VERSION = 'V1.0';
const LINES_PER_PAGE = 50;

function collect(absDir, exts, acc = []) {
  let entries;
  try { entries = readdirSync(absDir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    const p = join(absDir, e.name);
    if (e.isDirectory()) { if (e.name === 'node_modules') continue; collect(p, exts, acc); }
    else if (exts.includes('.' + e.name.split('.').pop().toLowerCase())) acc.push(p);
  }
  return acc;
}

const jsFiles = collect(join(ROOT, 'src'), ['.js']).sort();
const htmlFiles = collect(join(ROOT, 'src'), ['.html']).sort();
const sqlFiles = collect(join(ROOT, 'db'), ['.sql']).sort();

const rel = (p) => p.slice(ROOT.length + 1).replace(/\\/g, '/');
const allLines = [];
function pushFile(abs) {
  allLines.push(`// ===== FILE: ${rel(abs)} =====`);
  const txt = readFileSync(abs, 'utf8');
  for (const ln of txt.split('\n')) allLines.push(ln.replace(/\t/g, '  '));
}
for (const f of jsFiles) pushFile(f);
for (const f of htmlFiles) pushFile(f);
for (const f of sqlFiles) pushFile(f);

const total = allLines.length;
const head = allLines.slice(0, LINES_PER_PAGE * 30);
const tail = allLines.slice(-LINES_PER_PAGE * 30);
const selected = [...head, ...tail];
const pages = Math.ceil(selected.length / LINES_PER_PAGE);

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

let body = '';
for (let i = 0; i < pages; i++) {
  const pg = i + 1;
  const slice = selected.slice(i * LINES_PER_PAGE, (i + 1) * LINES_PER_PAGE);
  const code = slice.map((l) => esc(l)).join('\n');
  body += `<div class="page">
  <div class="header">${SOFTWARE} ${VERSION} — 源程序鉴别材料（一般交存）　第 ${pg} 页 / 共 ${pages} 页</div>
  <pre class="codelines">${code}</pre>
  <div class="footer">${SOFTWARE} ${VERSION}</div>
</div>`;
}

const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<style>
@page { size: A4; margin: 0; }
* { box-sizing: border-box; }
body { font-family: Consolas, "Courier New", monospace; font-size: 7.5pt; color:#111; margin:0; }
.page { page-break-before: always; height: 297mm; display:flex; flex-direction:column; }
.page:first-child { page-break-before: auto; }
.page:last-child { page-break-after: auto; }
.header { flex:0 0 auto; border-bottom:1px solid #333; padding:2mm 3mm 1mm; font-size:7.5pt; }
.footer { flex:0 0 auto; border-top:1px solid #ccc; padding:1mm 3mm; font-size:6.5pt; color:#555; text-align:right; }
.codelines { flex:1 1 auto; overflow:hidden; white-space:pre; margin:0; padding:0 3mm; line-height:1.12; font-size:7.5pt; }
td.ln { width:34px; color:#999; text-align:right; user-select:none; border-right:1px solid #eee; }
</style></head><body>${body}</body></html>`;

mkdirSync('doc/copyright', { recursive: true });
writeFileSync('doc/copyright/source-material.html', html, 'utf8');
writeFileSync('doc/copyright/source-lines.txt', selected.join('\n'), 'utf8');
console.log(`源文件: .js=${jsFiles.length} .html=${htmlFiles.length} .sql=${sqlFiles.length}`);
console.log(`源程序总行数: ${total}`);
console.log(`提取页数: ${pages}（前30+后30），输出 doc/copyright/source-material.html`);
