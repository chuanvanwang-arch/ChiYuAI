#!/usr/bin/env node
// scripts/new-page.mjs — 生成「一次通过 ui-lint」的合规页面骨架
//
// 背景：ui-lint（src/web/*.html 架构级封死）过去反复在提交时被拦截，
// 根因是写页面时不知道规则、报错只有行号没有修法。本脚本把规则固化进骨架：
// 生成即可通过 lint（含 --strict），从源头消灭返工。
//
// 用法：
//   node scripts/new-page.mjs <page-name> [--title "页面标题"] [--force] [--dry]
//     <page-name>   不含 .html；写入 src/web/<page-name>.html
//     --title       页面 <title>（默认取 page-name）
//     --force       目标文件已存在时覆盖
//     --dry         只打印骨架，不写文件
// 生成后自动跑 `node scripts/ui-lint.mjs --strict` 自检；若骨架自身违规，删除文件并 exit 1（止血）。
// 规则速查：node scripts/ui-lint.mjs --rules ｜ 作者清单：docs/specs/2026-09-05-ui-authoring-rules.md
import { existsSync, writeFileSync, unlinkSync } from 'fs';
import { spawnSync } from 'child_process';
import path from 'path';

const argv = process.argv.slice(2);
const name = argv.find(a => !a.startsWith('--'));
if (!name || !/^[a-z0-9][a-z0-9-]*$/i.test(name)) {
  console.error('用法：node scripts/new-page.mjs <page-name> [--title "页面标题"] [--force] [--dry]');
  process.exit(2);
}
const get = (flag, dflt) => { const i = argv.indexOf(flag); return i >= 0 ? (argv[i + 1] ?? dflt) : dflt; };
const title = get('--title', name);
const force = argv.includes('--force');
const dry = argv.includes('--dry');

const out = path.resolve('src/web', `${name}.html`);
if (!dry && existsSync(out) && !force) {
  console.error(`❌ 已存在 ${out}（加 --force 覆盖）`);
  process.exit(2);
}

const skeleton = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${title}</title>
<link rel="stylesheet" href="/portal/tokens.css">
<link rel="stylesheet" href="/portal/common.css">
<script type="module" src="/portal/components.js"></script>
<style>
  /* 规则 R3：禁止在此重声明 btn/card/table/tab/tabs/badge/chip/toast/panel/select/input/textarea 等设计系统保留类；
     需要定制样式请用带页面前缀的私有类（示例：.${name}-row）或改用 crm-* 组件属性。 */
  .${name}-bar { display: flex; gap: 12px; align-items: center; margin-bottom: 16px; }
  .${name}-err { color: var(--err); font-size: 12px; margin-bottom: 8px; }
</style>
</head>
<body>
<!-- 规则 R5/R6：页眉标签必须带 class="page-head"，且内部只放标题；描述放到下方 .page-sub -->
<header class="page-head"><div class="ph-main"><h1 class="page-title">${title}</h1></div></header>
<div class="page-sub">一句话说明本页用途（页眉只保留标题，描述写在这里）。</div>

<div class="${name}-err" id="${name}-err"></div>

<div class="${name}-bar">
  <!-- 规则 R4：一律使用 crm-* 组件，禁止裸控件标签；取值仍用 el.value -->
  <crm-input id="${name}-kw" type="text" placeholder="关键字"></crm-input>
  <crm-select id="${name}-status">
    <option value="">全部</option>
    <option value="active">启用</option>
  </crm-select>
  <crm-button id="${name}-search">查询</crm-button>
</div>

<div id="${name}-list"></div>

<script type="module">
  import { injectLayout } from '/portal/layout.js';
  import { api } from '/portal/api.js';
  injectLayout();

  const err = document.getElementById('${name}-err');
  const list = document.getElementById('${name}-list');

  async function load() {
    err.textContent = '';
    try {
      const kw = document.getElementById('${name}-kw').value;
      const status = document.getElementById('${name}-status').value;
      const r = await api('/api/your/endpoint?kw=' + encodeURIComponent(kw) + '&status=' + encodeURIComponent(status));
      // 规则 R7：动态直出的控件同样必须是 crm-* 组件，禁止拼接裸控件标签
      list.innerHTML = (r.items || []).map(x => '<div class="${name}-row">' + (x.name || '') + '</div>').join('');
    } catch (e) {
      err.textContent = '加载失败：' + (e?.message || e);
    }
  }

  document.getElementById('${name}-search').addEventListener('click', load);
  document.getElementById('${name}-status').addEventListener('change', load);
  load();
</script>
</body>
</html>
`;

if (dry) { console.log(skeleton); process.exit(0); }

writeFileSync(out, skeleton, 'utf8');
// 自检：跑 --strict 后只挑「本文件」的条目——历史存量警告不应阻塞新页面生成
const r = spawnSync(process.execPath, ['scripts/ui-lint.mjs', '--strict'], { encoding: 'utf8' });
const mine = (r.stdout || '').split('\n').filter(l => l.startsWith(`${name}.html:`));
if (mine.length) {
  unlinkSync(out); // 骨架自身不合规 → 立即删除，绝不污染 src/web（避免阻断他人提交）
  console.error('❌ 生成的骨架未通过 ui-lint --strict，已回滚删除：\n' + mine.join('\n'));
  process.exit(1);
}
console.log(`✅ 已生成 ${out}（通过 ui-lint --strict）\n下一步：补业务接口与字段；改完再跑 node scripts/ui-lint.mjs`);
