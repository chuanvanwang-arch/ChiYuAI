// test/scripts/ui-lint-guards.test.js — UI lint「可自愈」守护（DB-free）
// 背景：2026-09-05 反复出现「提交才被告知违规」（billing.html 裸 <select> 等），
// 根因是报错只有行号、没有修法，且新页面没有合规起手式。本测试守护三件事：
//   G1 规则自解释：--rules 输出 R1–R7 且每条带「修法」
//   G2 报错可自愈：真实违规时，每条 error 尾部必须带 → 修复[R#]
//   G3 脚手架合规：new-page 生成的骨架本身零违规（生成→自检→清理）
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import path from 'path';

const ROOT = path.resolve(process.cwd());
const NODE = process.execPath;
const run = (args) => spawnSync(NODE, args, { cwd: ROOT, encoding: 'utf8' });

const TMP_PAGE = 'ui-lint-guard-tmp';
const TMP_FILE = path.resolve(ROOT, 'src/web', `${TMP_PAGE}.html`);
const SCAF_PAGE = 'ui-lint-guard-page';
const SCAF_FILE = path.resolve(ROOT, 'src/web', `${SCAF_PAGE}.html`);

afterAll(() => {
  for (const f of [TMP_FILE, SCAF_FILE]) {
    try { if (existsSync(f)) unlinkSync(f); } catch { /* 清理失败不阻断 */ }
  }
});

describe('ui-lint 可自愈守护', () => {
  it('G1 规则速查表自解释（R1–R7 均带修法）', () => {
    const r = run(['scripts/ui-lint.mjs', '--rules']);
    expect(r.status).toBe(0);
    for (const id of ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7']) {
      expect(r.stdout).toContain(id);
    }
    const fixLines = r.stdout.split('\n').filter(l => l.includes('修法：'));
    expect(fixLines.length).toBeGreaterThanOrEqual(7);
    expect(r.stdout).toContain('docs/specs/2026-09-05-ui-authoring-rules.md');
  });

  it('G2 违规报错必须带修复指引（→ 修复[R#]）', () => {
    // 故意制造 R4/R5 违规：裸 <button> + 非 page-head 页眉
    const bad = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>guard</title>
<link rel="stylesheet" href="/portal/tokens.css">
<link rel="stylesheet" href="/portal/common.css">
<script type="module" src="/portal/components.js"></script>
</head>
<body>
<header class="head"><h1>guard</h1></header>
<button id="x">点我</button>
</body>
</html>
`;
    writeFileSync(TMP_FILE, bad, 'utf8');
    const r = run(['scripts/ui-lint.mjs']);
    expect(r.status).toBe(1);
    const mine = r.stdout.split('\n').filter(l => l.startsWith(`${TMP_PAGE}.html:`));
    expect(mine.length).toBeGreaterThanOrEqual(2); // 至少裸 button + 页眉
    for (const line of mine) expect(line).toMatch(/→ 修复\[R\d/);
    expect(r.stdout).toContain('--rules');
  });

  it('G3 脚手架生成即合规（生成→自检→清理）', () => {
    const r = run(['scripts/new-page.mjs', SCAF_PAGE, '--title', '守护自检', '--force']);
    expect(r.status).toBe(0);
    expect(existsSync(SCAF_FILE)).toBe(true);
    const html = readFileSync(SCAF_FILE, 'utf8');
    expect(html).toContain('/portal/components.js');
    expect(html).toContain('/portal/tokens.css');
    expect(html).toContain('/portal/common.css');
    expect(html).toContain('class="page-head"');
    expect(html).toContain('crm-button');
    // 脚手架自身不得带任何裸控件（否则会污染全仓 lint）
    expect(/<(select|input|textarea|button)\b/i.test(html)).toBe(false);
    // 全仓再跑一次：脚手架不应引入任何违规/警告
    const lint = run(['scripts/ui-lint.mjs', '--strict']);
    expect((lint.stdout || '').split('\n').filter(l => l.startsWith(`${SCAF_PAGE}.html:`))).toEqual([]);
  });
});
