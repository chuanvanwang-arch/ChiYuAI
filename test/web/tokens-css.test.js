// test/web/tokens-css.test.js — tokens.css 全站 Token 断言 + common.css 存在性
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';

const webDir = join(dirname(fileURLToPath(import.meta.url)), '../../src/web');

describe('tokens.css 全站 Token', () => {
  const css = readFileSync(join(webDir, 'tokens.css'), 'utf8');
  it('含深色底与主色', () => {
    for (const k of [
      '--bg:#0f172a', '--panel:#1e293b', '--line:#334155',
      '--ink:#e2e8f0', '--mut:#cbd5e1',
      '--ac:#6366f1', '--ac-hover:#818cf8', '--on-ac:#ffffff',
      '--ok:#10b981', '--err:#f87171', '--warn:#fbbf24',
    ]) {
      expect(css).toContain(k);
    }
  });
  it('含统一字体/圆角/间距/阴影', () => {
    for (const k of [
      '--radius:8px', '--radius-lg:14px',
      '--space:8px', '--space-2:16px', '--space-3:24px',
      '--font:', '--shadow:',
    ]) {
      expect(css).toContain(k);
    }
  });

  // 2026-09-16 用户截图实证：下拉展开后的 option 列表白底浅字、几乎不可读。
  // 根因 = 只给 select 设了 background，未给 option 设 background；color 却被 option 继承（浅色）。
  // 故守卫「弹层必须成对声明 background + color」，且只用令牌（禁硬编码色值）。
  it('原生下拉弹层（option/optgroup）必须成对声明 background + color（防「白底浅字」回归）', () => {
    const rule = css.match(/select\s+option[^{]*\{[^}]*\}/);
    expect(rule, 'tokens.css 缺少 select option 弹层着色规则').not.toBeNull();
    const body = rule[0];
    expect(body, '弹层缺 background（会回落系统白底）').toMatch(/background\s*:\s*var\(--panel\)/);
    expect(body, '弹层缺 color（会继承浅色 select 字色）').toMatch(/color\s*:\s*var\(--ink\)/);
    // 鉴别力：整条规则内不得出现硬编码色值（浅色 fallback 是本仓明令禁止的历史事故源）
    expect(body).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
  });

  // 2026-09-16 补充：警示底必须从 token 取（此前页面自带 rgba(220,38,38,.08) 硬编码，违背「页面禁自带色值」铁律）。
  // 注意：token 本身允许 rgba（--accent-soft 即 rgba），禁令针对的是页面层。
  it('警示底有语义 token（--err-soft）', () => {
    expect(css).toMatch(/--err-soft\s*:/);
    expect(css).toContain('--accent-soft'); // 对照：同范式已有软底 token 存在，说明 --err-soft 是补齐而非新增异类
  });
});

describe('common.css 存在', () => {
  it('存在且含公共组件类', () => {
    const p = join(webDir, 'common.css');
    expect(existsSync(p)).toBe(true);
    const css = readFileSync(p, 'utf8');
    for (const cls of ['.btn', '.card', '.table', '.form', '.badge', '.empty', '.sidebar', '.topbar', '.tabs', '.user-menu']) {
      expect(css).toContain(cls);
    }
  });
});