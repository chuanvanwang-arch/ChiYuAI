#!/usr/bin/env node
// scripts/migrate-ui-wc.mjs — UI 架构级封死一次性迁移（幂等、可重跑）
// 用法：node scripts/migrate-ui-wc.mjs [--write] [file1 file2 ...]
//   默认 dry-run（仅 report，不写文件）；--write 真实改写。
// 安全边界（执行计划批2 细化）：
//   - <script> 块内标签不替换（防误伤 JS 模板串动态生成的 select/input/button）
//   - tab 语义 button（class="tab" / data-view / data-page-tab / data-v）不自动转 crm-tab，
//     因会破坏 querySelectorAll('.tab') / classList.toggle('active')，须人工同步改 JS
//   - select/input/textarea/动作button 仅在 light DOM 静态区替换，JS 用 id/.value/addEventListener 均兼容
import { readFileSync, writeFileSync, readdirSync, appendFileSync, mkdirSync } from 'fs';
import path from 'path';

const ROOT = path.resolve('src/web');
const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const files = args.filter(a => a !== '--write');
const targets = files.length
  ? files.map(f => path.resolve(f))
  : readdirSync(ROOT).filter(f => f.endsWith('.html')).map(f => path.join(ROOT, f));

const isTabButton = (attrs) =>
  /\bclass="[^"]*\btab\b/.test(attrs) || /data-view=/.test(attrs) ||
  /data-page-tab=/.test(attrs) || /data-v=/.test(attrs);

const log = [];
let changedFiles = 0;

for (const file of targets) {
  let html = readFileSync(file, 'utf8');
  const before = html;
  const ch = [];

  // 1) head 注入 components.js（C3：双重保障，经 layout.js 注册者冗余但幂等安全）
  if (!/\/portal\/components\.js/.test(html)) {
    html = html.replace(/<\/head>/i, `  <script type="module" src="/portal/components.js"></script>\n</head>`);
    ch.push('+ head: inject /portal/components.js');
  }

  // 2) 抽取 <script> 块占位（script 内标签/金额单独处理）
  const scripts = [];
  html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, (m) => {
    scripts.push(m);
    return ` SCRIPT${scripts.length - 1} `;
  });

  // 3) body 区标签替换（仅 light DOM 静态结构）
  html = html.replace(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi, (m, attrs, inner) => {
    if (/crm-select/.test(attrs)) return m;
    ch.push(`~ select  -> crm-select   (${attrs.trim().slice(0, 46)})`);
    return `<crm-select${attrs}>${inner}</crm-select>`;
  });
  html = html.replace(/<input\b([^>]*?)\/?>/gi, (m, attrs) => {
    if (/crm-input/.test(attrs) || /type="hidden"/.test(attrs)) return m;
    const a = attrs.replace(/\/\s*$/, '');
    ch.push(`~ input   -> crm-input    (${a.trim().slice(0, 46)})`);
    return `<crm-input${a}></crm-input>`;
  });
  html = html.replace(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/gi, (m, attrs, inner) => {
    if (/crm-textarea/.test(attrs)) return m;
    ch.push(`~ textarea -> crm-textarea`);
    return `<crm-textarea${attrs}>${inner}</crm-textarea>`;
  });
  html = html.replace(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi, (m, attrs, inner) => {
    if (/crm-button/.test(attrs)) return m;
    if (isTabButton(attrs)) { ch.push(`! button.tab SKIP (manual)  (${attrs.trim().slice(0, 46)})`); return m; }
    ch.push(`~ button  -> crm-button   (${attrs.trim().slice(0, 46)})`);
    return `<crm-button${attrs}>${inner}</crm-button>`;
  });

  // 4) 还原 script 块
  html = html.replace(/ SCRIPT(\d+) /g, (_, i) => scripts[Number(i)]);

  // 5) script 块内金额拼接 -> fmtMoney（根治 R3 乱序；并注入 import）
  html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, (m) => {
    let s = m;
    const moneyRe = /'¥'\s*\+\s*([\w.$(), \s]+?)\.toLocaleString\('zh-CN'\)/g;
    if (moneyRe.test(m)) {
      moneyRe.lastIndex = 0; // 重置：避免 test 推进 lastIndex 导致 replace 跳过首个匹配
      s = m.replace(moneyRe, (_, expr) => `fmtMoney(${expr.trim()})`);
      ch.push('~ script: ¥+toLocaleString -> fmtMoney');
    }
    if (/fmtMoney\(/.test(s) && !/import\s*\{[^}]*fmtMoney/.test(s)) {
      s = s.replace(/(import\s+[^;]*\s+from\s+'(\/portal\/api\.js|\/portal\/calibrationRender\.js)'[^;]*;)/,
        `$1\n  import { fmtMoney } from '/portal/util.js';`);
      ch.push('  + import { fmtMoney } from /portal/util.js');
    }
    return s;
  });

  if (html !== before) {
    changedFiles++;
    if (WRITE) writeFileSync(file, html);
    log.push(`\n=== ${path.basename(file)} ===\n` + ch.join('\n'));
  }
}

const summary = `\n[${new Date().toISOString()}] dry-run=${!WRITE} files_scanned=${targets.length} files_changed=${changedFiles}\n`;
mkdirSync('scripts', { recursive: true });
appendFileSync('scripts/migrate-report.log', log.join('\n') + summary);
console.log((WRITE ? '[WRITE] ' : '[DRYRUN] ') + `scanned=${targets.length} changed=${changedFiles}`);
if (log.length) console.log(log.join('\n'));
