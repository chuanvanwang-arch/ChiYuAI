// test/http/signalCenterWiring.test.js — S1 探针：页面/菜单/路由/端点「四向接线一致」
//
// 为什么需要它（2026-09-16 实测塌陷，5 条断链全部躲过了原测试）：
//   ① 菜单 href=/signal-center.html，但 routes.js 无该路由（本仓无通配 html 路由）→ 点开 404
//   ② 页面引用 /web/layout.js 等（本仓静态资源前缀是 /portal/）→ 样式与导航壳全 404，页面裸奔
//   ③ 页面用 x-tenant-id 头传租户，而 resolveMe 只认 Bearer token → 全部请求回落 system 租户
//   ④ /api/signals 端点未鉴权 + severity 筛选未接（页面上筛选项点了没反应）
//   ⑤ 端点把 {id:...} 传给 scopeTenant（其读 me.tenantId）→ 恒回落 'system'，登录用户看不到本租户信号
//   原「页面契约」测试只对 HTML 做字符串断言 → 以上全部为绿。本文件改为**跨文件一致性**断言。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const routesSrc = read('src/http/routes.js');
const menuSrc = read('src/portal/layoutMenu.js');
const pageSrc = read('src/web/signal-center.html');

// 2026-09-16 更名：菜单显示名「信号中心」→「销售自动化」，并入「协同」分组。
//   本探针改为按 label 定位菜单项，故同步更新；href/路由/页面文件标识不变，接线契约不变。
describe('销售自动化：菜单 ↔ 路由 ↔ 页面文件 三向一致', () => {
  it('菜单含「销售自动化」入口，且旧名「信号中心」已无残留', () => {
    expect(menuSrc).toMatch(/label:\s*'销售自动化'/);
    expect(menuSrc).not.toMatch(/label:\s*'信号中心'/);
  });

  it('菜单 href 指向 /signal-center.html，且该路径在 routes.js 有 sendFile 注册（防 404）', () => {
    const m = menuSrc.match(/\{[^}]*label:\s*'销售自动化'[^}]*\}/);
    expect(m).not.toBeNull();
    const href = m[0].match(/href:\s*'([^']+)'/)?.[1];
    expect(href).toBe('/signal-center.html');
    // 鉴别力：删掉 routes.js 的注册 → 此断言红（这正是修复前的状态）
    expect(routesSrc).toMatch(new RegExp(`app\\.get\\('${href}'`));
    expect(routesSrc).toMatch(/sendFile\(fileURLToPath\(new URL\('\.\.\/web\/signal-center\.html'/);
  });

  it('路由 sendFile 的目标文件真实存在', () => {
    expect(fs.existsSync(path.join(ROOT, 'src/web/signal-center.html'))).toBe(true);
  });

  it('/signal-center 短链有 redirect（与既有页面范式一致）', () => {
    expect(routesSrc).toMatch(/app\.get\('\/signal-center',\s*\(req,\s*res\)\s*=>\s*res\.redirect\('\/signal-center\.html'\)\)/);
  });
});

describe('信号中心：页面引用的本地静态资源必须真实注册', () => {
  it('每个 href/src 本地路径都能在 routes.js 找到注册（防 /web/* 类前缀错误）', () => {
    const refs = [...pageSrc.matchAll(/(?:href|src)="(\/[^"?#]+)"/g)].map((m) => m[1]);
    expect(refs.length).toBeGreaterThan(2); // 探针自检：确实扫到引用
    const missing = refs.filter((r) => !routesSrc.includes(`'${r}'`));
    // 鉴别力：原来页面的 /web/layout.js、/web/common.css、/web/api.js 均无注册 → 此断言红
    expect(missing).toEqual([]);
  });

  it('用 injectLayout 注入统一壳（含侧栏/导航），不手写 app-shell', () => {
    expect(pageSrc).toMatch(/import\s*\{\s*injectLayout\s*\}\s*from\s*'\/portal\/layout\.js'/);
    expect(pageSrc).toMatch(/injectLayout\(\)/);
    expect(pageSrc).not.toMatch(/class="app-shell"/);
  });
});

describe('信号中心：鉴权范式（防无效头导致租户错位）', () => {
  // 剥离注释后再断言：实现注释里解释「为何不用 x-tenant-id」是正确做法，
  //   若连注释一起断言，代码写得越清楚越红（假红比假绿更危险——会被"修"向删注释的错方向）。
  const strip = (s) => s
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const code = strip(pageSrc);

  it('探针自检/负向对照：注释里出现不算违规，代码行里出现必须被抓到', () => {
    expect(strip(`// 说明：不用 x-tenant-id 头\n`)).not.toMatch(/x-tenant-id/i);
    expect(strip(`fetch('/x', { headers: { 'x-tenant-id': '1' } });`) + 'code').toMatch(/x-tenant-id/i);
  });

  it('代码行中不使用 x-tenant-id 头（resolveMe 从不读取该头）', () => {
    expect(code).not.toMatch(/x-tenant-id/i);
  });

  it('使用 localStorage token + Authorization: Bearer（对齐 lead-pool / today-priority）', () => {
    expect(code).toMatch(/localStorage\.getItem\('crm_token'\)/);
    expect(code).toMatch(/Authorization:\s*`Bearer \$\{token\}`/);
  });

  it('未登录跳转 /home.html（不静默发无凭证请求）', () => {
    expect(code).toMatch(/if\s*\(!token\)\s*location\.href\s*=\s*'\/home\.html'/);
  });
});

describe('/api/signals 端点接线', () => {
  const block = routesSrc.slice(
    routesSrc.indexOf("app.get('/api/signals'") - 900,
    routesSrc.indexOf("app.post('/api/signals/:id/close'") + 500,
  );

  it('读端点：未登录返 401（防未授权读写 system 租户）', () => {
    expect(routesSrc).toMatch(/app\.get\('\/api\/signals'/);
    expect(block).toMatch(/status\(401\)/);
  });

  it('读端点：走 applyTenantOverride（admin 通配 / 普通用户自身租户，含越权防护）', () => {
    expect(block).toMatch(/applyTenantOverride\(req,\s*me\)/);
    // 鉴别力：原实现把 {id:...} 传给 scopeTenant（读 me.tenantId）→ 恒 'system'，此断言红
    expect(block).not.toMatch(/scopeTenant\(\(\s*\(\)\s*=>/);
  });

  it('读端点：severity 筛选透传到 store（否则页面筛选项点击无反应）', () => {
    expect(block).toMatch(/severity:\s*req\.query\.severity/);
  });

  it('写端点：走 scopeOf（写不跨租户铁律，admin 也写自身租户）', () => {
    const ackBlock = routesSrc.slice(routesSrc.indexOf("app.post('/api/signals/:id/ack'"), routesSrc.indexOf("app.post('/api/signals/:id/close'") + 400);
    expect(ackBlock).toMatch(/scopeOf\(me\)/);
    expect(ackBlock).not.toMatch(/setStatus\(applyTenantOverride/);
  });

  it('各端点均要求登录（401 守卫覆盖读+写）', () => {
    const guards = (block.match(/status\(401\)/g) || []).length;
    expect(guards).toBeGreaterThanOrEqual(1); // requireMe 统一实现
    expect(block).toMatch(/const requireMe = \(req, res\)/);
    // 自洽断言（2026-09-17）：原写死 3 —— 新增 GET /api/signals/delivery-status 后变 4 即假红。
    // 改为「块内注册的每个 /api/signals* 端点都必须走统一 requireMe 守卫」，与端点数量解耦。
    const endpoints = (block.match(/app\.(get|post|put|patch)\('\/api\/signals/g) || []).length;
    const requireMeUses = (block.match(/requireMe\(req, res\)/g) || []).length;
    expect(endpoints).toBeGreaterThanOrEqual(4);
    expect(requireMeUses, '每个 /api/signals* 端点都应调用 requireMe').toBe(endpoints);
  });
});
