// test/web/channelConfigPage.test.js — T8：通道配置台（设计 §4.5.3 日常自助面）
// 判据：
//   ① 列表唯一数据源＝GET /api/channels（不另建数据源、不直读 config_store）；
//   ② 凭据表单 password 类型直传后端入 vault，前端不落明文、提交后清空；
//   ③ 信任档 L1/L2/L3 可选（默认 L1 只读）；
//   ④ 断开＝POST /api/channels/:id/disconnect（软停用，禁物理删除）；
//   ⑤ 入口可达性：指向首次接入向导（`/onboarding-guide.html`），且上游页（channel-adapters）有指向本页的链接；
//   ⑥ 写面单一：不出现 `/api/integration/providers` 写调用（那是通用数据源面，kind 域不相交）。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { KIND_PROBE } from '../../src/channels/kinds.js';
import { PROBE_REQUIRED_FIELDS } from '../../src/channels/probes.js';

const src = readFileSync(new URL('../../src/web/channel-config.html', import.meta.url), 'utf8');
// 页面内联的必填字段表（与后端同源，见下方跨层守卫）
function pageCredFields() {
  const m = src.match(/const CRED_FIELDS = (\{[\s\S]*?\n    \});/);
  if (!m) throw new Error('未找到 CRED_FIELDS —— 跨层守卫失去锚点');
  return JSON.parse(m[1].replace(/'/g, '"').replace(/,(\s*\})/g, '$1'));
}
// 上游入口页：`discovery-rules.html`（「外部数据接入」面板，已提交）——通道 kind 域与该面不相交，故由此互链。
const upstream = readFileSync(new URL('../../src/web/discovery-rules.html', import.meta.url), 'utf8');
const routesSrc = readFileSync(new URL('../../src/http/routes.js', import.meta.url), 'utf8');

describe('channel-config.html 配置台', () => {
  it('列表唯一数据源＝GET /api/channels', () => {
    expect(src).toContain('/api/channels?tenant_id=');
    expect(src).not.toContain('/api/integration/providers'); // 不越界到通用数据源面
  });

  it('凭据 password 直传后端 + 提交后清空（明文不驻留 DOM）', () => {
    expect(src).toContain('type="password"');
    expect(src).toContain("$('f-cred').value = ''");
  });

  it('信任档 L1/L2/L3 可选，默认 L1 只读', () => {
    expect(src).toContain('value="L1"');
    expect(src).toContain('value="L2"');
    expect(src).toContain('value="L3"');
    expect(src).toContain('L1 只读（默认）');
  });

  it('断开＝POST /api/channels/:id/disconnect（软停用·禁物理删除）', () => {
    expect(src).toContain('/disconnect?tenant_id=');
    expect(src).toContain('软停用');
    expect(src).toContain('禁物理删除');
  });

  it('接入调 /api/channels/connect（与向导/WorkBuddy 同一后端引擎）', () => {
    expect(src).toContain('/api/channels/connect');
  });

  // ── 入口可达性（2026-09-17 实缺陷回归）────────────────────────────────
  // 事实：本页有 routes serve + 上面全部契约测试全绿 + 与 discovery-rules / 360 / 接入台互链，
  //   但**主导航零入口**（layoutMenu 无 /channel-config.html）⇒ 用户从侧边栏根本到不了接入面。
  //   与 discovery.html 同一形态（「页面在、链路通、没人到得了」；判据⑤同族：绿在测试、死在使用）。
  //   ⚠ 只断言「页面内部有什么」的契约测试，永远发现不了「没人到得了」——入口必须自身成为断言对象，
  //   否则补完入口后仍会随下次重构静默脱落。
  it('入口可达性：主导航有入口（防孤岛回归）+ 链到首次接入向导 + 上游页互链', async () => {
    const { FULL_MENU } = await import('../../src/portal/layoutMenu.js');
    const hit = FULL_MENU.find((m) => m.href === '/channel-config.html');
    expect(hit, 'channel-config.html 失去导航入口 → 又变孤岛').toBeTruthy();
    expect(hit.group).toBe('协同');
    expect(hit.requiresEntitlement).toEqual(['core_crm']);
    expect(src).toContain('/onboarding-guide.html');
    expect(upstream).toContain('/channel-config.html');
  });

  it('routes.js 有 serve（有 serve 才到得了）', () => {
    expect(routesSrc).toContain('/channel-config.html');
  });

  it('凭据必填字段与后端探针要求**逐通道严格一致**（漂移 ⇒ 填完仍被后端拒）', () => {
    const page = pageCredFields();
    expect(Object.keys(page).sort()).toEqual(Object.keys(KIND_PROBE).sort());
    for (const [kind, fields] of Object.entries(page)) {
      expect(fields, `${kind} 与后端不一致`).toEqual(PROBE_REQUIRED_FIELDS[KIND_PROBE[kind]]);
    }
  });

  it('按通道类型提示必填字段（用户不必猜 JSON 键），且留空凭据不被拦', () => {
    expect(src).toContain('renderCredHint');
    expect(src).toContain("id=\"cred-hint\"");
    // 仅在**填了凭据**时预检：留空表示沿用库里已有凭据，拦截即误伤
    const seg = src.slice(src.indexOf('if (credentials) {'), src.indexOf('if (miss.length)'));
    expect(seg).toContain('CRED_FIELDS[kind]');
  });
});
