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