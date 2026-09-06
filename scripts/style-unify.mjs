// scripts/style-unify.mjs — CRM 平台风格统一（内容区页头组件化）
// 仅新增/包裹，不删改既有规则；纯静态文件处理，无后端依赖。
// 用法：node scripts/style-unify.mjs   （幂等，可重复跑）
import fs from 'fs';
import path from 'path';

const DIR = 'src/web';
const EXCLUDE = new Set(['home.html', 'portal-stage3-mockup.html', 'layout.js']);
const EMOJI_RE = /^[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{2049}\u{2122}\u{2139}\u{23}\u{24}\u{25}\u{2A}\u{303D}\u{3297}\u{3299}\s]+/u;

function ensureLinks(html) {
  const need = [];
  const has = (re) => re.test(html);
  if (!has(/href=["']\/portal\/tokens\.css["']/)) need.push('<link rel="stylesheet" href="/portal/tokens.css">');
  if (!has(/href=["']\/portal\/common\.css["']/)) need.push('<link rel="stylesheet" href="/portal/common.css">');
  const usesPg = /pg-page|class="pg-/.test(html);
  if (usesPg && !has(/href=["']\/portal\/page\.css["']/)) need.push('<link rel="stylesheet" href="/portal/page.css">');
  if (need.length) {
    const anchor = /<\/title>/.test(html) ? '</title>' : (/<head[^>]*>/.test(html) ? '<head>' : null);
    if (anchor) html = html.replace(anchor, m => m + '\n  ' + need.join('\n  '));
  }
  // 去重（保留首个）
  const seen = new Set();
  html = html.replace(/(<link rel="stylesheet" href="\/portal\/(tokens|common|page)\.css">)/g, (m) => {
    if (seen.has(m)) return '';
    seen.add(m); return m;
  });
  return { html, added: need };
}

function wrapHeader(html) {
  const bodyRe = /<body[^>]*>([\s\S]*?)<\/body>/i;
  const bm = html.match(bodyRe);
  if (!bm) return { html, wrapped: false, reason: 'no-body' };
  const body = bm[1];
  const h2idx = body.search(/<h2[\s>]/i);
  if (h2idx < 0) return { html, wrapped: false, reason: 'no-h2' };
  // 仅当 h2 前（去注释/空白）无包裹块元素时，才视为页面标题
  const pre = body.slice(0, h2idx).replace(/<!--[\s\S]*?-->/g, '').trim();
  if (pre && /<(div|section|main|header|table|ul|form|article|aside)\b/i.test(pre)) {
    return { html, wrapped: false, reason: 'wrapped-in-block' };
  }
  const m = body.slice(h2idx).match(/<h2([^>]*)>([\s\S]*?)<\/h2>/i);
  if (!m) return { html, wrapped: false, reason: 'no-h2-match' };
  const titleRaw = m[2].replace(/<[^>]+>/g, '').trim();
  const title = titleRaw.replace(EMOJI_RE, '').trim() || titleRaw;
  // 紧跟的 .sub
  const after = body.slice(h2idx + m[0].length);
  const subm = after.match(/^\s*<div class="sub">([\s\S]*?)<\/div>/i);
  const subHtml = subm ? `<p class="page-sub">${subm[1].trim()}</p>` : '';
  const replacement = `<header class="page-head"><div class="ph-main"><h1 class="page-title">${title}</h1>${subHtml}</div></header>`;
  const newBody = body.slice(0, h2idx) + replacement + body.slice(h2idx + m[0].length + (subm ? subm[0].length + after.indexOf(subm[0]) : 0));
  const newHtml = html.replace(bodyRe, () => `<body>${newBody}</body>`);
  return { html: newHtml, wrapped: true, title, hadSub: !!subm };
}

const files = fs.readdirSync(DIR).filter(f => f.endsWith('.html') && !EXCLUDE.has(f));
const report = { wrapped: [], linked: [], skipped: {} };
for (const f of files) {
  const fp = path.join(DIR, f);
  let html = fs.readFileSync(fp, 'utf8');
  const before = html;
  const { html: h1, added } = ensureLinks(html);
  html = h1;
  const r = wrapHeader(html);
  html = r.html;
  if (added.length) report.linked.push(`${f} +${added.length}`);
  if (r.wrapped) report.wrapped.push(`${f} «${r.title}»${r.hadSub ? ' (+sub)' : ''}`);
  else report.skipped[r.reason] = (report.skipped[r.reason] || []).concat(f);
  if (html !== before) fs.writeFileSync(fp, html);
}
console.log('=== 链接补齐 ==='); console.log(report.linked.join('\n') || '(无)');
console.log('\n=== 页头包裹 ==='); console.log(report.wrapped.join('\n') || '(无)');
console.log('\n=== 跳过（需人工） ===');
for (const [k, v] of Object.entries(report.skipped)) console.log(`${k}: ${v.join(', ')}`);
