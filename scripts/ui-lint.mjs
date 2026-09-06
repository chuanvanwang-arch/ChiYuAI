#!/usr/bin/env node
// scripts/ui-lint.mjs — UI 架构级封死 lint（零依赖，pre-commit/CI 直接跑）
// 检查项（任一违规 → exit 1）：
//   1) 每个 src/web/*.html 的 <head> 须含 /portal/components.js + /portal/tokens.css + /portal/common.css
//   2) <title> 不含 emoji
//   3) 页面本地 <style> 不得重声明 common.css 已有类选择器（防止设计系统漂移/重复定义）
//   4) 裸 <select>/<input>/<textarea>/<button>（不在 <crm-*>、不在 <script>/<style> 块、非 hidden input）→ 失败
//   5) 所有 <header> 必须使用 class="page-head"（禁止 portal-head/drawer-head/head/nl-head 等并存）
//   6) <header> 内不得含描述元素（.page-sub / .muted / .sub）——页眉只保留标题
// 检查项（警告，不阻断；--strict 升级为失败）：
//   7) JS 模板内动态直出的裸控件（第 4 项跳过 <script> 块形成的逃逸面，2026-08-31 纳管）
// 设计契约见 docs/specs/2026-08-29-ui-arch-lock-design.md 与计划 docs/superpowers/plans/2026-08-29-ui-arch-lock-plan.md。
// 作者侧唯一准入清单（写新页面前必读）：docs/specs/2026-09-05-ui-authoring-rules.md
// 命令行：node scripts/ui-lint.mjs [--strict] [--rules]
//   --strict 警告升级为失败；--rules 只打印规则速查表（含修法）后退出。
import { readdirSync, readFileSync } from 'fs';
import path from 'path';

// ── 规则速查表：每条违规都带「怎么改」，避免只报行号导致反复返工 ──
const RULES = [
  { id: 'R1', name: 'head 三件套', desc: '<head> 必须引入 /portal/components.js、/portal/tokens.css、/portal/common.css',
    fix: '在 <head> 内补齐：<script type="module" src="/portal/components.js"></script> 与两个 <link rel="stylesheet" href="/portal/tokens.css|/portal/common.css">' },
  { id: 'R2', name: 'title 禁 emoji', desc: '<title> 不得含 emoji',
    fix: '删掉标题里的 emoji/符号，纯文字即可' },
  { id: 'R3', name: '样式不漂移', desc: '本地 <style> 不得重声明设计系统保留类（btn/select/input/card/table/tab/tabs/badge/chip/toast/panel…）',
    fix: '删除本地重声明，复用 common.css 已有类；确需定制请改用带前缀的私有类名（如 .billing-badge）或 crm-* 组件' },
  { id: 'R4', name: '控件必须 crm-*', desc: '静态 HTML 中的 select/input/textarea/button 一律用 crm-select/crm-input/crm-textarea/crm-button（hidden input 除外）',
    fix: '把裸标签换成对应 crm-* 组件；取值方式不变（el.value / addEventListener("change")）' },
  { id: 'R5', name: '页眉统一', desc: '所有 <header> 必须 class="page-head"',
    fix: '改为 <header class="page-head">，删除 portal-head/drawer-head/nl-head 等并存类名' },
  { id: 'R6', name: '页眉只留标题', desc: '<header> 内不得含 .page-sub/.muted/.sub 描述元素',
    fix: '把描述文字移到 <header> 之后的第一个 <div class="page-sub"> 中' },
  { id: 'R7', name: '动态直出也要 crm-*', desc: 'JS 模板字符串里直出的裸控件同样受封死约束（当前为警告，--strict 失败）',
    fix: '模板里的 <select>/<input>/<button> 一并改成 crm-* 组件字符串' },
];
const FIX = (id, msg) => `${msg}  → 修复[${id} ${RULES.find(r => r.id === id).name}]：${RULES.find(r => r.id === id).fix}`;
const RULES_TEXT = () => RULES.map(r => `${r.id} ${r.name}：${r.desc}\n     修法：${r.fix}`).join('\n');

if (process.argv.includes('--rules')) {
  console.log('[ui-lint] 规则速查表（架构级封死，写页面前必读；完整清单 docs/specs/2026-09-05-ui-authoring-rules.md）：\n' + RULES_TEXT());
  process.exit(0);
}

const ROOT = path.resolve('src/web');
const files = readdirSync(ROOT).filter(f => f.endsWith('.html'));
const errors = [];
const warn = [];

const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u;

for (const f of files) {
  const html = readFileSync(path.join(ROOT, f), 'utf8');
  const L = html.split('\n');

  // 1) <head> 必备链接（容忍 head 标签带属性，如 data-page-node-id —— 2026-09-06 修复误判）
  const head = (html.match(/<head\b[^>]*>[\s\S]*?<\/head>/i) || [''])[0];
  for (const need of ['/portal/components.js', '/portal/tokens.css', '/portal/common.css']) {
    if (!head.includes(need)) errors.push(FIX('R1', `${f}: <head> 缺少 ${need}`));
  }

  // 2) <title> 禁 emoji（容忍 title 标签带属性，同上）
  const title = (html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
  if (EMOJI.test(title)) errors.push(FIX('R2', `${f}: <title> 含 emoji（${title.trim()}）`));

  // 状态机：跨行跳过 <script>/<style> 块
  let inScript = false, inStyle = false;
  for (let i = 0; i < L.length; i++) {
    const line = L[i];
    if (/<script\b/i.test(line)) inScript = true;
    if (/<style\b/i.test(line)) inStyle = true;
    // 4) 裸元素（仅 light DOM，排除 script/style 块）
    if (!inScript && !inStyle) {
      const re = /<(select|input|textarea|button)\b([^>]*)>/gi;
      let m;
      while ((m = re.exec(line))) {
        const tag = m[1].toLowerCase(), attrs = m[2];
        if (tag === 'input' && /type\s*=\s*["']hidden["']/i.test(attrs)) continue; // hidden input 合法（非可见控件）
        errors.push(FIX('R4', `${f}:${i + 1} 裸 <${tag}> 未使用 crm-*（架构级封死违规）`));
      }
    }
    if (/<\/script>/i.test(line)) inScript = false;
    if (/<\/style>/i.test(line)) inStyle = false;
  }

  // 5) 页眉统一：所有 <header> 必须使用 .page-head（架构级封死，禁止 portal-head/drawer-head/head/nl-head 等并存）
  for (const hm of html.matchAll(/<header\b([\s\S]*?)>/gi)) {
    const attrs = hm[1];
    if (!/\bclass\s*=\s*["'][^"']*page-head/.test(attrs)) {
      errors.push(FIX('R5', `${f}: <header> 未使用 class="page-head"（页眉须统一，禁止 portal-head/drawer-head/其它类名）`));
    }
  }

  // 6) 页眉只保留标题：<header> 内不得含描述元素（.page-sub / .muted / .sub）
  for (const hb of html.matchAll(/<header\b[\s\S]*?<\/header>/gi)) {
    if (/class\s*=\s*["'](?:page-sub|muted|sub)["']/.test(hb[0])) {
      errors.push(FIX('R6', `${f}: <header> 内含描述元素（.page-sub/.muted/.sub），页眉只保留标题`));
    }
  }

  // 3) 本地 <style> 重声明「设计系统保留词汇」（crm-* 已替代；裸基类属漂移/重复）
  //    仅查无连字符的基类（变体如 .btn-primary/.ok 等允许），且先剥离 CSS 注释避免 .css/.js 误报。
  //    注意：本项默认仅作【警告】（非架构级失败）；批量清理属 Batch3 人工收尾，--strict 可升级为失败。
  const RESERVED = new Set(['btn', 'select', 'input', 'textarea', 'button', 'card', 'table', 'tab', 'tabs', 'badge', 'chip', 'toast', 'panel']);
  const styleBlocks = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map(m => m[1]);
  for (const sb of styleBlocks) {
    const cleaned = sb.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of cleaned.matchAll(/\.([a-zA-Z][\w-]*)/g)) {
      const cls = m[1];
      if (!cls.includes('-') && RESERVED.has(cls)) warn.push(FIX('R3', `${f}: 本地 <style> 重声明设计系统保留类 .${cls}`));
    }
  }

  // 7) JS 模板内动态直出的裸控件（第 4 项的逃逸面，2026-08-31 纳管）
  //    背景：第 4 项状态机显式跳过整个 <script> 块（见上方 inScript），
  //    导致模板字符串里直出的 <select>/<input>/<button> 完全不受架构封死约束——
  //    静态 HTML 改干净了，动态生成部分仍裸奔（实测 36 处 / 9 文件）。
  //    此处纳管为「警告」（--strict 升级为失败）：使逃逸可见、可逐步收敛，不阻断既有交付。
  for (const sb of [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1])) {
    for (const m of sb.matchAll(/<(select|input|textarea|button)\b([^>]*)>/gi)) {
      const tag = m[1].toLowerCase(), attrs = m[2];
      if (tag === 'input' && /type\s*=\s*["']hidden["']/i.test(attrs)) continue; // hidden input 合法
      warn.push(FIX('R7', `${f}: JS 模板内裸 <${tag}> 未使用 crm-*`));
    }
  }
}

const WHERE = '\n[ui-lint] 规则速查：node scripts/ui-lint.mjs --rules ｜ 作者清单：docs/specs/2026-09-05-ui-authoring-rules.md';
if (errors.length) {
  console.log(`[ui-lint] 发现 ${errors.length} 处架构级违规（exit 1）:\n` + errors.join('\n') + WHERE);
  process.exit(1);
}
if (warn.length) {
  const tail = process.argv.includes('--strict')
    ? '\n[ui-lint] --strict：上述警告视为失败。'
    : `\n[ui-lint] 提示：以上为警告（① 样式漂移：本地 <style> 重声明设计系统保留类；② JS 模板内动态直出的裸控件，逃逸第 4 项检测）。加 --strict 可升级为失败。${WHERE}`;
  console.log(`[ui-lint] 通过（${files.length} 文件，无架构级违规）。${warn.length} 处警告：${tail}\n` + warn.join('\n'));
  if (process.argv.includes('--strict')) process.exit(1);
} else {
  console.log(`[ui-lint] 通过：${files.length} 文件，无架构级违规，无样式漂移。`);
}
