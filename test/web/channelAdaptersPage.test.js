// test/web/channelAdaptersPage.test.js — 通道接入台契约（2026-09-17 需求②呈现层）
//
// 背景：需求②（邮箱/日历/会议/微信 → 提取客户信息 → 形成图谱）在 09-17 审计中判定为「0/4 未落地」，
//   其权威设计 `docs/2026-09-17-channel-adapter-unified-design.md` v1 已批准、P1–P4 分期。
//   **P1 已于 2026-09-17 交付**（dbfeee2 四键注册 / 2979f49 纯数据预设 + channelProvider / 4dceef8
//   eventNormalizer + entityExtractor）——因此四通道在工厂字典内，本页显示「模板就绪」。
//   本页是 **P3 的呈现层先行件**：把四通道的接入状态与缺口如实搬到前台，消除「配置了但没数据」的无处归因。
//
// 三条设计纪律必须被锁住：
//   ① 单源：接入动作只在 /discovery-rules.html#integration-sources（#47/#48），本页**不得**造第二个编辑面
//      → 断言本页不 import post/put（无写能力）。
//   ② 不谎称：kind **不在工厂字典**时（P1 未交付 / kind 未注册 / 名字写错），页面必须显式说明
//      「会被 mount 静默跳过」——否则运营添加通道后会遇到零数据且无处归因（正是本项目反复出现的「静默」缺陷）。
//      判定须**动态**取自工厂字典，不得硬编码「未交付」结论（否则 P1 交付后本页会谎报缺陷）。
//   ③ 状态判定与生产同源：kind 可构造性取自 /api/sync/factories（= SYNC_PROVIDER_FACTORY ∪ PRESET_FACTORIES）。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { CONFIG_ITEMS } from '../../src/portal/configCenter.js';

const page = fs.readFileSync('src/web/channel-adapters.html', 'utf8');
const routes = fs.readFileSync('src/http/routes.js', 'utf8');
// 保守行级剥离（同 crmSyncConsolePage.test.js）：注释掉的挂载不算接线
const codeOnly = (s) => s.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
const routesCode = codeOnly(routes);

describe('channel-adapters 页面契约', () => {
  it('四通道 kind 齐备（与设计 §3 一致）', () => {
    for (const k of ['generic-email', 'generic-calendar', 'generic-meeting', 'generic-wechat']) {
      expect(page, `缺通道 ${k}`).toContain(k);
    }
  });

  it('状态判定与生产同源：可构造性取自 /api/sync/factories', () => {
    expect(page).toContain('/api/sync/factories');
  });

  it('已声明实例从 /api/integration/providers 读取（同一键，不另建数据源）', () => {
    expect(page).toContain('/api/integration/providers');
  });

  it('① 单源：本页无写能力（不得成为第二个接入编辑面）', () => {
    expect(page).not.toMatch(/import\s*\{[^}]*\bpost\b[^}]*\}\s*from\s*'\/portal\/api\.js'/);
    expect(page).not.toMatch(/import\s*\{[^}]*\bput\b[^}]*\}\s*from\s*'\/portal\/api\.js'/);
    expect(page).toContain('/discovery-rules.html#integration-sources');
  });

  it('② 不谎称：kind 不可构造时必须显式提示「会被静默跳过」', () => {
    expect(page).toContain('静默跳过');
    expect(page).toContain('不会同步任何数据');
  });

  it('说明图谱汇入落点（enrichment 四类 + sourcedFrom 弱边），且不新建粒子类型', () => {
    for (const k of ['email_intent', 'schedule', 'meeting_intents', 'wechat_intents']) {
      expect(page, `缺落点 ${k}`).toContain(k);
    }
    expect(page).toContain('sourcedFrom');
    expect(page).toContain('不新建粒子类型');
  });

  it('写明 P1–P4 分期与「未接通不得宣称已接通」红线', () => {
    expect(page).toMatch(/P1/);
    expect(page).toMatch(/P4/);
    expect(page).toContain('未接通不得宣称已接通');
  });

  it('微信通道标注个人微信无开放 API（历史假绿的边界）', () => {
    expect(page).toContain('个人微信无开放 API');
  });

  it('默认信任档为 L1 只读（写需 L2/L3 且过决策第 0 闸）', () => {
    expect(page).toContain('L1 只读');
    expect(page).toContain('decision_id');
  });
});

describe('通道接入台后端接线契约', () => {
  it('routes.js 暴露 /channel-adapters.html 页面', () => {
    expect(routesCode).toMatch(/app\.get\('\/channel-adapters\.html'/);
  });
});

describe('配置中心登记位点', () => {
  it('CONFIG_ITEMS 含 #55 且指向 /channel-adapters.html', () => {
    const a = CONFIG_ITEMS.find((i) => i.id === 55);
    expect(a, '缺 #55 通道接入').toBeTruthy();
    expect(a.page).toBe('/channel-adapters.html');
    expect(a.status).toBe('ready');
    expect(a.group).toBe('智能体与运行');
    // ⚠ 本项是**只读呈现位点**，endpoint 必须为 null（不进 §15 注册表闸）。
    //   endpoint 的语义是「声明该 HTTP 端点受角色闸」（唯一消费者 rbac.js:89
    //   createConfigLevelGate）；而 /api/sync/factories 是**只读工厂字典**，
    //   登记进去会被误判为租户级配置面 → sales 读字典 403（2026-09-17 实缺陷）。
    //   同惯例：#19 / #24 / #45（纯只读位点）皆为 endpoint: null。
    expect(a.endpoint, '只读呈现位点不得登记进 §15 闸表（会 403 普通角色）').toBeNull();
  });

  it('只读数据源路径不得出现在任何 CONFIG_ITEMS.endpoint（§15 闸登记语义守卫）', () => {
    // 本页状态区依赖的两个只读源：工厂字典 + 描述符列表；描述符写面归 #47，
    // 其只读列表端点 /api/integration/providers 自带 ensureAdmin 闸（ADMIN/sysadmin），
    // 属设计意图而非本页要登记的配置面。
    const readonly = ['/api/sync/factories', '/api/monitor/sync'];
    for (const p of readonly) {
      expect(CONFIG_ITEMS.filter((i) => i.endpoint === p).map((i) => i.id), `${p} 是只读源，不得登记为受闸配置端点`).toEqual([]);
    }
  });
});

describe('状态判定必须动态（防「交付后仍谎报缺陷」）', () => {
  it('状态徽章不得硬编码「未交付」类结论，必须读工厂字典判定', () => {
    // 反例（本页 2026-09-17 首版）：徽章写死 '适配器模板未交付 → 接入会被静默跳过'。
    //   P1 于同日交付（dbfeee2/2979f49/4dceef8）后，该硬编码文案立刻变成**谎报缺陷**
    //   ——页面会宣称一个已存在的通道不可构造。这是判据⑥（单源）在文案层的体现：
    //   「是否可构造」的解释权唯一属于工厂字典，不得在页面里复制一份结论。
    //
    //   ⚠ 断言范围**必须收窄到徽章表达式**，不得全页 not.toContain('未交付')：
    //     页面另有一处**正确**用法——说明「图谱汇入落库（P2 T7）尚未交付」这一事实。
    //     全页级否定断言会误伤该用法（本条守卫初版即因此假红），属判据⑩「告警谓词粒度」问题。
    const badgeExpr = page.match(/const badge\s*=[\s\S]*?;\s*\n/)?.[0] || '';
    expect(badgeExpr, '未匹配到徽章表达式（页面结构变了，须同步更新守卫）').toBeTruthy();
    expect(badgeExpr, '徽章硬编码了「未交付」结论 → P1 交付后会谎报').not.toContain('未交付');
    expect(badgeExpr, '徽章硬编码了「未交付」结论').not.toContain('尚未交付');
    // 正向锚点：ready 判定必须来自工厂字典返回集合（badge 消费 ready 变量，不自己再判一次）
    const readyExpr = page.match(/const ready\s*=[\s\S]*?;\s*\n/)?.[0] || '';
    expect(readyExpr, '未匹配到 ready 判定（页面结构变了，须同步更新守卫）').toBeTruthy();
    expect(readyExpr, 'ready 判定必须取 /api/sync/factories 的返回集合').toMatch(/factories\.includes\(c\.kind\)/);
    // 且徽章三态由 ready/enabled 两个变量驱动（非写死字符串）
    expect(badgeExpr).toMatch(/ready/);
    // 精确历史反例串不得回归（该串曾把「模板未交付」与「会被跳过」因果绑定，实为错误归因）
    expect(page).not.toContain('适配器模板未交付');
  });

  it('四通道 kind 已在工厂字典内（P1 已交付的事实锚点）', () => {
    // 这条断言的意义：若哪天四键被移出注册表，本测试会红，提示「呈现层会自动变成未就绪」。
    const CHANNEL_KINDS = ['generic-email', 'generic-calendar', 'generic-meeting', 'generic-wechat'];
    for (const k of CHANNEL_KINDS) {
      expect(page, `页面缺通道 ${k}`).toContain(k);
    }
    // 页面声明的通道集合与设计 §3.1–§3.4 一致（4 个，不多不少）
    expect((page.match(/kind: 'generic-/g) || []).length).toBeGreaterThanOrEqual(4);
  });
});
