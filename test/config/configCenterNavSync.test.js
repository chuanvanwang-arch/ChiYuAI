// test/config/configCenterNavSync.test.js — 配置中心导航白名单同步护栏（三处同步铁律）
// 契约：configCenter.js 注册的 CONFIG_ITEMS 必须全部登记进 src/web/config.html 的
//       LEVEL_GROUPS_MARKUP 导航白名单，否则该配置在 /config 页面「永不渲染」不可发现
//       （2026-09-14 实测：id46 线索发现规则漏登 → 用户找不到；此测试防回归）。
// 口径：解析 config.html 文本提取 items:[...] 数字，与 CONFIG_ITEMS id 集合做差集断言。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { CONFIG_ITEMS } from '../../src/portal/configCenter.js';

const html = readFileSync('src/web/config.html', 'utf8');
const whitelist = [...html.matchAll(/items:\s*\[([^\]]*)\]/g)]
  .flatMap((m) => m[1].split(',').map((x) => parseInt(x.trim(), 10)).filter((n) => !Number.isNaN(n)));

describe('配置中心导航白名单同步（三处同步铁律护栏）', () => {
  it('所有 CONFIG_ITEMS 均登记进 config.html 导航白名单（防漏登导致不可发现）', () => {
    const missing = CONFIG_ITEMS.map((i) => i.id).filter((id) => !whitelist.includes(id));
    expect(missing, `漏登 id: ${missing.join(',')}`).toEqual([]);
  });

  it('白名单不含未注册 id（防幽灵卡片）', () => {
    const registered = new Set(CONFIG_ITEMS.map((i) => i.id));
    const extra = whitelist.filter((id) => !registered.has(id));
    expect(extra, `多余 id: ${extra.join(',')}`).toEqual([]);
  });
});
