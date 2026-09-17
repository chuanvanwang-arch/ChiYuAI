// test/web/signalConfigPage.test.js — 信号规则配置页契约（P0-3 前台可见性审计）
//
// 问题：Plan A/B 播种的两键（signal-schedule / internal-signal-derivation）此前**配置中心零位点**
//   → 用户只能改库、不能改界面（「后台配置也没有」。）本测试锁住三件套：
//   ① 配置页存在且读写两键；② 后端为两键挂通用配置路由（GET/PUT 自动生成）；③ 配置中心有登记位点。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { CONFIG_ITEMS } from '../../src/portal/configCenter.js';

const page = fs.readFileSync('src/web/signal-config.html', 'utf8');
const routes = fs.readFileSync('src/http/routes.js', 'utf8');

describe('signal-config 配置页契约', () => {
  it('页面读写两个配置键（signal-schedule / internal-signal-derivation）', () => {
    expect(page).toContain("'signal-schedule'");
    expect(page).toContain("'internal-signal-derivation'");
    expect(page).toMatch(/\/api\/config\/\$\{KEYS\[tab\]\}/);
  });

  it('读用 get、写用 put（写经决策第0闸由后端承担），并挂载统一布局', () => {
    expect(page).toMatch(/import\s*\{[^}]*get[^}]*put[^}]*\}\s*from\s*'\/portal\/api\.js'/);
    expect(page).toContain('injectLayout()');
  });

  it('只暴露安全旋钮（启停/严重度/窗口/阈值/去重桶），语义字段（kind/entity_type）只读', () => {
    expect(page).toContain('r-enabled');
    expect(page).toContain('r-severity');
    expect(page).toMatch(/r-window/);
    // 反向对照：kind 不得做成可编辑控件（改 kind = 改业务语义，超出本页范围）
    expect(page).not.toMatch(/class="r-kind"/);
  });

  it('保存以服务端原值为底本覆盖（不丢未展示字段，如 ts_field）', () => {
    expect(page).toMatch(/srcRules\[i\]/);
  });
});

describe('signal-config 后端接线契约（零接线即假绿）', () => {
  it('routes.js 为两键各挂一个通用配置路由（GET/PUT 自动生成）', () => {
    expect(routes).toMatch(/createConfigRouter\(\{\s*key:\s*'signal-schedule'/);
    expect(routes).toMatch(/createConfigRouter\(\{\s*key:\s*'internal-signal-derivation'/);
  });

  it('routes.js 暴露 /signal-config.html 页面', () => {
    expect(routes).toMatch(/app\.get\('\/signal-config\.html'/);
  });
});

describe('配置中心登记位点', () => {
  it('CONFIG_ITEMS 含 #49 与 #50 且指向 /signal-config.html', () => {
    const a = CONFIG_ITEMS.find((i) => i.id === 49);
    const b = CONFIG_ITEMS.find((i) => i.id === 50);
    expect(a, '缺 #49 信号时间规则配置').toBeTruthy();
    expect(b, '缺 #50 内部异动派生配置').toBeTruthy();
    expect(a.endpoint).toBe('/api/config/signal-schedule');
    expect(b.endpoint).toBe('/api/config/internal-signal-derivation');
    expect(a.page).toBe('/signal-config.html');
    expect(b.page).toBe('/signal-config.html');
    expect(a.status).toBe('ready');
    expect(a.group).toBe('智能体与运行');
  });
});
