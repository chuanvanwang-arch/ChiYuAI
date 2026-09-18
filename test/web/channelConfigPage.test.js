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

  // ── 提交反馈可辨识（2026-09-18 用户实缺陷回归：「点了就没有反应了」）──────
  // 事实：原实现把成功/失败/校验错误一律写进 `<p class="hint" id="out">`——灰字、与周围静态
  //   说明同色同字号，且实机落在视口底边（y=719 / 视口高 720）⇒ 用户点了「确认接入」看到的唯一
  //   变化是一行与说明文字无法区分的灰字；重复点击文本一字不变 ⇒ 读作「点了没反应」。
  // 判据：**反馈必须可辨识，且指向一个不同的下一步动作**（与项目「假失败」同族）。
  //   ⚠ 上面的静态契约测试当时全绿——绿在「页面里有 /api/channels/connect 这个串」，
  //     死在「用户点了看不见任何东西」。故本组断言**只锚状态语义与就地改错点**，
  //     真实渲染结果由运行期探针锁定：`node scripts/verify-channel-config-feedback.mjs`。
  it('反馈区可辨识：role=status + err/ok/busy 三态着色（不再与灰字说明同形）', () => {
    expect(src).toMatch(/id="out"[^>]*role="status"[^>]*aria-live="polite"/);
    expect(src).toContain("el.className = 'status show ' + state");
    expect(src).toMatch(/\.status\.err[^}]*--err/);
    expect(src).toMatch(/\.status\.err[^}]*--err-soft/);   // 底走令牌，不自带 rgba 色值
    expect(src).toContain('white-space: pre-wrap');          // guidedHint 的多行「↳ 下一步」不被压成一行
    expect(src).not.toMatch(/id="out"[^>]*class="hint"/);    // 不再沿用「静态说明」的样式
  });

  it('校验失败就地改错：出错字段标红 + 聚焦（不把用户留在一行灰字前）', () => {
    expect(src).toContain('function fieldError(');
    expect(src).toContain("fieldError('f-cred', 'cred-hint'");   // 错误落在用户视线所在的凭据框原位
    expect(src).toContain("inp.className = 'bad'");
    expect(src).toContain('if (inp.focus) inp.focus()');
    expect(src).toContain('input.bad { border-color: var(--err); }');
    // 用户一动手就清掉上一轮红字，否则改完了错误提示还挂着＝反向误导
    expect(src).toContain("$('f-cred').oninput = () => clearFieldError(");
    // 非法 JSON 必须给出「本通道必填键 + 可照抄示例」，而不是一句不可执行的「须为合法 JSON」
    expect(src).toMatch(/凭据须为合法 JSON[\s\S]{0,200}sampleOf\(kind\)/);
  });

  it('提交中即刻反馈 + 按钮禁用（点下去必有可见变化，且不叠加请求）', () => {
    expect(src).toContain("if (btn.disabled) return;");
    expect(src).toContain('btn.disabled = true;');
    expect(src).toContain("btn.textContent = '提交中…'");
    expect(src).toContain('btn.disabled = false;');           // 无论成败都恢复可点（否则按钮变砖）
    expect(src).toContain("setOut('busy'");
    expect(src).toContain('button[disabled]');                // 禁用态必须有可见样式
  });

  it('反馈探针在（运行期真跑 onclick；静态绿不等于用户看得见）', () => {
    const probe = readFileSync(new URL('../../scripts/verify-channel-config-feedback.mjs', import.meta.url), 'utf8');
    expect(probe).toContain("src/web/channel-config.html");
    expect(probe).toContain('role="status"');
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    const hit = Object.entries(pkg.scripts).find(([, v]) => v.includes('verify-channel-config-feedback.mjs'));
    expect(hit, '探针未接 npm script ⇒ 下轮重构会静默脱落').toBeTruthy();
  });
});

// P1 隐私排除清单面板（设计 2026-09-18-unified-integration-design-v2.md §8.1 / §11 P1）
describe('channel-config.html 隐私排除清单面板', () => {
  it('配置读写走唯一数据源 /api/config/sync-privacy（读写各一次，不旁路 config_store）', () => {
    expect(src).toContain("fetch('/api/config/sync-privacy')");
    expect(src).toContain("fetch('/api/config/sync-privacy', {");
    expect(src).toContain("method: 'PUT'");
  });

  it('三类规则输入齐备（域名/地址/关键词）', () => {
    for (const id of ['p-domains', 'p-addrs', 'p-keys']) expect(src).toContain(`id="${id}"`);
  });

  it('**判据是丢弃计数，不是规则条数**：页面必须渲染真实拦下数（否则「配了但没生效」无从察觉）', () => {
    expect(src).toContain('privacy_dropped');
    expect(src).toContain('renderRecent');
    expect(src).toContain('最近一轮同步实际拦下');
    // 计数不可用必须说出来（否则「拦下 0 条」与「不知道」在界面上长得一样）
    expect(src).toContain('rec.available === false');
  });

  it('保存成功文案把用户导向「生效证据」而非「配置成功」（防把配置存在当能力存在）', () => {
    expect(src).toContain('生效证据看下方「实际拦下」计数');
  });

  it('只读权限：非管理员不得看到可点的保存按钮（can_write=false → disabled）', () => {
    expect(src).toContain('res.can_write === false');
    expect(src).toContain("$('p-save').disabled = true");
  });
});
