// test/web/signalDeliveryConfigPage.test.js — 信号投递配置页契约（2026-09-17 前台可见性审计·第二轮）
//
// 问题（两处静默，都已取证）：
//   ① 配置中心零位点：`signal-delivery` / `signal-dispatch` 两键 2026-09-16 已播种，但没有任何
//      配置位点 → 运营**改不了渠道开关**（只能改库）。
//   ② 生产装配零注入：`src/scheduler/timers.js` 的 `createDeliveryRegistry({})` 不传 providers，
//      而 webhook provider 又**无 env 兜底** ⇒ 该渠道**结构性恒 fail-closed**
//      （设计上「全渠道可配置」、部署上不可达）。本次为 webhook 补 `SIGNAL_WEBHOOK_URL`（与 email 的 SMTP_* 对称）。
//
// 本测试锁四件套：① 页面读写两键 ② 后端挂通用配置路由 + 页面路由 + 只读状态端点 ③ 配置中心登记 ④ 假绿防线
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { CONFIG_ITEMS } from '../../src/portal/configCenter.js';

const page = fs.readFileSync('src/web/signal-delivery-config.html', 'utf8');
const routes = fs.readFileSync('src/http/routes.js', 'utf8');

// ⚠ 判据③「注释≠实现」：对生产接线的断言必须剥离注释后执行——
//   否则把挂载行注释掉（内容仍在文件里）断言照样通过 = 无判别力。
//   取**保守的行级剥离**（仅剔除以 `//` 开头的整行）；不剥块注释：正则剥块注释实测会误吞大段代码。
const codeOnly = (s) => s.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
const routesCode = codeOnly(routes);
const pageCode = codeOnly(page);

describe('signal-delivery 配置页契约', () => {
  it('页面读写两个配置键（signal-delivery / signal-dispatch）', () => {
    expect(page).toContain("'signal-delivery'");
    expect(page).toContain("'signal-dispatch'");
    expect(page).toMatch(/\/api\/config\/\$\{KEYS\[tab\]\}/);
  });

  it('读用 get、写用 put（写经决策第0闸由后端承担），并挂载统一布局', () => {
    expect(page).toMatch(/import\s*\{[^}]*get[^}]*put[^}]*\}\s*from\s*'\/portal\/api\.js'/);
    expect(page).toContain('injectLayout()');
  });

  it('渠道集合与严重度取值对齐消费端契约（route.js ALL_CHANNELS），非页面自造', () => {
    expect(page).toMatch(/const CHANNELS = \['inbox', 'email', 'im', 'webhook'\]/);
    expect(page).toMatch(/const SEVERITIES = \['high', 'medium', 'low'\]/);
  });

  it('⛔ 假绿防线：渠道「已开启」不得等同于「会送达」——须区分凭据未配与渠道未实现', () => {
    // 本页最易出现的假绿：显示「已启用」让运营以为已送达（而 im 实际恒落 failed/skipped）
    expect(page).toContain('渠道未实现');
    expect(page).toContain('skipped');
    expect(page).toMatch(/凭据未配置/);
    expect(page).toContain('channelState');
  });

  // ── 2026-09-17 二次加固：**配置预测 ≠ 投递事实**（本页自身曾假绿）────────────────
  // 实证：本页原用「已开启 ∧ 凭据就绪 ∧ 已实现 ⇒ 可送达」，而 email 的 verifyConfig 只查凭据
  //   **是否配置（非空）**。当 .env 的 SMTP_PASS 是占位符 `__REPLACE_WI…` 时，页面显示「可送达」，
  //   真实投递却 4/4 落 failed（Invalid login: 550 User has no permission）。
  //   ⇒ 判决必须锚在**台账事实**（{last, verdict}，由 /api/signals/delivery-status 回显），
  //     且不得再出现「可送达」这类把配置预测说成结论的措辞。
  it('⛔ 判决以真实台账为准：使用 verdict 四态，且不得出现「可送达」式承诺', () => {
    expect(page).toContain('verdict');
    for (const v of ['last_sent', 'last_failed', 'last_skipped', 'never_attempted']) {
      expect(page, `缺 verdict 分支 ${v}`).toContain(v);
    }
    // 「凭据已配置」必须显式说明其语义边界（非空 ≠ 有效）
    expect(page).toMatch(/有效性.*(?:待|由).*真实投递/);
    // 事实与配置冲突时必须**并列**呈现（不得只报配置层结论）
    expect(page, '缺「冲突并列」分支：配置看起来就绪但台账失败时会把证据盖掉').toMatch(/真实投递未通过/);
    // 反例锚：原实现写死 '可送达' —— 该词一旦回归即视为假绿复发
    //   ⚠ 必须剥注释后断言：本页的**说明性注释**里逐字引用了旧文案（"原实现…显示「可送达」"），
    //     直接对原文 not.toContain 会被自己的注释命中 → 永久假红。这是本仓已登记两次的教训。
    expect(pageCode, '页面重新承诺「可送达」= 假绿复发').not.toContain('可送达');
  });

  it('状态端点回显真实台账：last（最近一行）+ verdict + credential_check 语义标注', () => {
    const c = codeOnly(routes);
    expect(c).toMatch(/DISTINCT ON \(channel\)/);
    expect(c).toMatch(/last_error, recipient, attempts, delivered_at/);
    expect(c).toMatch(/verdict\s*=/);
    expect(c).toMatch(/credential_check:/);
    // 语义必须写明：credentials_ok = 存在性，不是有效性（否则后人会再把它当"可送达"用）
    expect(c).toMatch(/presence_only/);
  });

  it('状态来自只读探测端点，且明示零写（探测行为不得制造投递证据）', () => {
    expect(page).toContain('/api/signals/delivery-status');
    expect(page).toMatch(/零写/);
  });

  it('暴露的旋钮齐备（渠道/路由/收件人/静默/限速/重试/泵窗口），且以服务端原值为底本覆盖', () => {
    for (const cls of ['ch-on', 'rt', 'rr', 'qh-on', 'rl-day', 'retry', 'mad']) {
      expect(page, `缺旋钮 ${cls}`).toContain(cls);
    }
    expect(page).toMatch(/\.\.\.\(current \|\| \{\}\)/);
  });
});

describe('signal-delivery 后端接线契约（零接线即假绿）', () => {
  it('routes.js 为两键各挂一个通用配置路由（GET/PUT 自动生成）', () => {
    expect(routesCode).toMatch(/createConfigRouter\(\{\s*key:\s*'signal-delivery'/);
    expect(routesCode).toMatch(/createConfigRouter\(\{\s*key:\s*'signal-dispatch'/);
  });

  it('routes.js 暴露页面与只读渠道状态端点', () => {
    expect(routesCode).toMatch(/app\.get\('\/signal-delivery-config\.html'/);
    expect(routesCode).toMatch(/app\.get\('\/api\/signals\/delivery-status'/);
  });

  it('状态端点必须排在 /api/signals/:id/... 之前（否则被 :id 段吞掉 = 静默 404）', () => {
    const iStatus = routesCode.indexOf("'/api/signals/delivery-status'");
    const iAck = routesCode.indexOf("'/api/signals/:id/ack'");
    expect(iStatus).toBeGreaterThan(0);
    expect(iAck).toBeGreaterThan(0);
    expect(iStatus).toBeLessThan(iAck);
  });
});

describe('配置中心登记位点', () => {
  it('CONFIG_ITEMS 含 #51 与 #52 且指向 /signal-delivery-config.html', () => {
    const a = CONFIG_ITEMS.find((i) => i.id === 51);
    const b = CONFIG_ITEMS.find((i) => i.id === 52);
    expect(a, '缺 #51 信号投递渠道配置').toBeTruthy();
    expect(b, '缺 #52 信号投递泵窗口').toBeTruthy();
    expect(a.endpoint).toBe('/api/config/signal-delivery');
    expect(b.endpoint).toBe('/api/config/signal-dispatch');
    expect(a.page).toBe('/signal-delivery-config.html');
    expect(b.page).toBe('/signal-delivery-config.html');
    expect(a.status).toBe('ready');
    expect(a.group).toBe('智能体与运行');
  });
});
