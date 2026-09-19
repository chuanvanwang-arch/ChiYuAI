import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  CHANNEL_PORTAL_MENU_ROLES,
  CHANNEL_PORTAL_ACCESS_ROLES,
  FULL_MENU,
  menuFor,
} from '../../src/portal/layoutMenu.js';

const PAGE = new URL('../../src/web/channel-admin.html', import.meta.url);
const html = fs.readFileSync(PAGE, 'utf8');
const codeOnly = (s) => s.replace(/<!--[\s\S]*?-->/g, '');
const moduleBlocks = () => [...html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)].map((m) => m[1]);

// 用真实 JS 引擎解析（node --check），不是 grep
function checkSyntax(src) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chadmin-'));
  const f = path.join(dir, 'block.mjs');
  try {
    fs.writeFileSync(f, src, 'utf8');
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
    return { ok: true, err: '' };
  } catch (e) {
    return { ok: false, err: String(e.stderr || e.message || e) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── 2026-09-18 实缺陷回归：「页面点进去卡死」──────────────────────────────────
// 事实：channel-admin.html 的 module script 曾有一个多余闭合 `}`（renderOverview 后多写一层）。
//   后果不是报错弹窗，而是**整个 <script type="module"> 块无法解析 → 一行都不执行**：
//   页面骨架在、tab 在，但点击/渲染/守卫全无响应，用户观感就是「进去就死机」。
// ⚠ 为什么既有测试全绿却没发现：ui-lint 与页面契约都只做**静态 grep**（查字符串是否出现），
//   grep 从不解析语法，语法错误属于 grep 的盲区——「字符串都在」与「能被执行」是两件事。
//   故此处必须用真实引擎解析，且用变异自证守卫本身有鉴别力（见末尾用例）。
describe('渠道门户落点页 · 脚本可解析（防「静态 grep 全绿但页面死机」假绿）', () => {
  it('每个 <script type="module"> 块都能被 JS 引擎解析（语法错误 ⇒ 整块不执行 ⇒ 页面卡死）', () => {
    const blocks = moduleBlocks();
    expect(blocks.length, '页面应含至少一个 module 脚本块').toBeGreaterThan(0);
    blocks.forEach((src, i) => {
      const r = checkSyntax(src);
      expect(r.ok, `script 块 #${i} 语法错误，整块不执行（页面表现为点进去无响应）：\n${r.err}`).toBe(true);
    });
  });

  it('守卫自证：注入一个多余闭合括号，语法检查必须变红（证明守卫有鉴别力、不是恒绿）', () => {
    const src = moduleBlocks()[0];
    const broken = `${src}\n}\n`; // 复现 2026-09-18 的缺陷形态
    expect(checkSyntax(broken).ok, '注入多余 } 后仍判通过 ⇒ 本守卫恒绿、无鉴别力').toBe(false);
  });
});

// ── 入口死区结构守卫（2026-09-18 实缺陷）──────────────────────────────────────
// 事实：菜单 roles=['ten_admin','channel_manager']，页面却用 canEditTenantConfig(role) 守卫，
//   而该函数白名单（src/web/api.js TENANT_CONFIG_ROLES）**不含 channel_manager**。
//   ⇒ 渠道经理「看得到入口、点进去被整页拒绝」。这类缺陷的判据不是某一侧的字面量，
//     而是**两侧的交集关系**：菜单放行的角色集合必须是页面放行集合的子集。
describe('渠道门户 · 菜单面 ⊆ 页面面（入口死区结构守卫）', () => {
  it('菜单可见的每个角色，落点页守卫都必须放行（MENU_ROLES ⊆ ACCESS_ROLES）', () => {
    for (const r of CHANNEL_PORTAL_MENU_ROLES) {
      expect(CHANNEL_PORTAL_ACCESS_ROLES, `角色 ${r} 菜单可见但页面拒绝 = 入口死区`).toContain(r);
      expect(menuFor(r).some((x) => x.href === '/channel-admin.html'), `角色 ${r} 应见菜单入口`).toBe(true);
    }
  });

  it('治理角色可达：admin/sysadmin 不在侧边栏菜单，但页面守卫放行（#57 深链落点）', () => {
    // 配置中心 #57 的 page = '/channel-admin.html#overview'，admin 点治理卡片会落到这里。
    // 若页面守卫拒绝 admin，则从治理面点进去又被拒 = 换了个方向的死区。
    for (const r of ['admin', 'sysadmin']) {
      expect(CHANNEL_PORTAL_ACCESS_ROLES, `治理角色 ${r} 须能进落点页（#57 深链）`).toContain(r);
      expect(CHANNEL_PORTAL_MENU_ROLES, `治理角色 ${r} 不应占侧边栏入口（走 #57）`).not.toContain(r);
    }
  });

  it('菜单项 roles 取单一事实源常量（禁止在 FULL_MENU 内另写一份角色数组）', () => {
    const item = FULL_MENU.find((m) => m.href === '/channel-admin.html');
    expect(item).toBeTruthy();
    expect(item.roles).toEqual(CHANNEL_PORTAL_MENU_ROLES);
  });

  it('页面守卫取 ACCESS_ROLES，不得退回 canEditTenantConfig(me_.role)', () => {
    const code = codeOnly(html);
    expect(code).toContain('CHANNEL_PORTAL_ACCESS_ROLES');
    expect(code).not.toMatch(/canEditTenantConfig\s*\(\s*me_\.role/);
  });
});
