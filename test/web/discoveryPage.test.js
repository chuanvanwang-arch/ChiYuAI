// test/web/discoveryPage.test.js — Task 13: 前台线索发现工作台页面（只读面）
// 范式：test/web/billing.smoke.test.js（fs 读文件断言，零 DB）
// 断言面：三区 id / 只读端点串 / C2 glass-box 展示位 / 禁 DELETE / serve 路径 / portal 令牌引入
import { readFileSync, existsSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

const pageFile = new URL('../../src/web/discovery.html', import.meta.url);
const html = readFileSync(pageFile, 'utf8');

describe('discovery.html 前台线索发现工作台（只读面）', () => {
  it('含三区：triggerBar / candidatePool / glassBoxDrawer', () => {
    expect(html).toContain('id="triggerBar"');
    expect(html).toContain('id="candidatePool"');
    expect(html).toContain('id="glassBoxDrawer"');
  });

  it('只调只读端点 GET /api/discovery/candidates', () => {
    expect(html).toContain('/api/discovery/candidates');
    // 页面内不得出现对 POST / PUT / DELETE 该端点的裸调用（写走 MCP 两阶段 + 第0闸）
    expect(/fetch\([^)]*\/(api\/discovery\/candidates)[^)]*,\s*\{[^}]*method\s*:\s*['"](POST|PUT|DELETE)['"]/i.test(html)).toBe(false);
  });

  it('含 C2 glass-box 展示位：why_narrative / icp_fit_score / rule_ref', () => {
    expect(html).toContain('why_narrative');
    expect(html).toContain('icp_fit_score');
    expect(html).toContain('rule_ref');
    expect(html).toContain('j_score');
  });

  it('需求① 定向拓客：含「输入邮箱/公司名/域名」表单 + 只读 prospecting-lookup enrich（画像补全，非候选搜索）', () => {
    expect(html).toContain('id="directProbe"');
    expect(html).toContain('id="dpName"');
    expect(html).toContain('id="dpDomain"');
    expect(html).toContain('id="dpEmail"');
    expect(html).toContain('id="dpSearch"');
    // 只读画像富集：调用 prospecting-lookup（read 类 Action）且 kind:'enrich'
    //   —— 适配器 search() 只接受 ICP 批量条件、不接受 name/domain/email 定点；
    //       定点必须走 enrich 分支，否则恒空=假绿（判据⑤同型）
    expect(html).toContain('/api/action/prospecting-lookup');
    expect(html).toContain("kind: 'enrich'");
    expect(html).toContain("fields: ['industry', 'registered_address', 'legal_person', 'funding_round', 'hiring_icp_role', 'tender_match']");
    // 画像不引导入池（防止画像字段被误当线索落公海）：落主数据走 data-particle-create 两阶段
    expect(html).toContain('data-particle-create');
    expect(/fetch\([^)]*\/(api\/action\/prospecting-confirm)[^)]*,\s*\{[^}]*method\s*:\s*['"](POST|PUT)['"]/i.test(html)).toBe(false);
  });

  it('无 DELETE 关键字（禁 DELETE 铁律）', () => {
    expect(/\bdelete\b|\bDELETE\b/.test(html)).toBe(false);
  });

  it('页面 serve 路径正确（src/web/discovery.html 存在）', () => {
    expect(existsSync(pageFile)).toBe(true);
  });

  // ── 「看不懂」回归闸（2026-09-18 用户实报，附截图）─────────────────────────
  // 事实：本页当时契约测试全绿，但用户输入「北京海底捞」后整页无一处可理解：
  //   · 候选池空态只写「暂无已评分候选」（不解释为什么空 / 数据从哪来 / 去哪触发）；
  //   · 两张表未套 .table ⇒ 空表时 5 个表头挤成一行文字，被读成一句乱话；
  //   · 定向拓客读**顶层** data.items，而后端信封是 {ok,data:{items,error}} ⇒ 恒空、draft_id 恒 '-'；
  //   · 后端 error（provider_not_enabled_or_unknown）被吞成「预期 fail-open」。
  // 行为断言见 scripts/verify-discovery-page-render.mjs（真跑 onclick + fetch 桩，24 断言 + 6 变异自证）；
  // 此处只做**防整段删除**的静态锚点。
  it('空态必须自解释（含触发入口），且表格套 .table 类', () => {
    expect(html).toContain('候选池暂无');            // 空态文案存在
    expect(html).toContain('icp_fit_score');         // 字段名收进 th[title]（hover 可见），不占常驻文案
    expect(html).toContain('href="/buddy"');         // 给出可点触发入口
    expect(html).toContain('id="candidate-table" class="table"');
    expect(html).toContain('<table id="dpTable" class="table">');
    expect(html).toContain('empty-cell');            // 左对齐空态样式类
  });

  // ── 文案预算闸（2026-09-18 用户二次反馈）──────────────────────────────────
  // 事实：用户报「显示了一堆说明，完全看不懂，这个页面需要干净点，无用信息删除」。
  //   上一轮为治「看不懂」补的自解释文案总量 ≈360 字（m5 全回退变异体实测 530 字），
  //   属**把机制原理当用户信息常驻显示**；且 triggerBar 里三条说明绑定的 div 全仓零 JS 消费
  //   （grep 仅命中自身声明），只能写死假值 —— 写死的数据源名会与配置中心真实配置相互撒谎。
  //   本闸把「干净」变成可回归判据：行为断言见 scripts/verify-discovery-page-render.mjs【⓪】+ 5 变异自证。
  it('文案预算：常驻可见文案 ≤160 字，且不得回流零消费说明性死元素', () => {
    const text = html
      .replace(/<!--[\s\S]*?-->/g, '').replace(/<script[\s\S]*?<\/script>/g, '')
      .replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    expect(text.length, `常驻可见文案 ${text.length} 字（预算 160）`).toBeLessThanOrEqual(160);
    expect(html).not.toContain('id="icp-summary"');
    expect(html).not.toContain('id="data-source-badges"');
    expect(html).not.toContain('id="last-run-at"');
    expect(/<section id="triggerBar"[\s\S]*?<\/section>/.exec(html)[0]).not.toContain('class="sub"');
    expect(html, '常驻文案不解释内部容错机制').not.toMatch(/fail-open/);
    // 表头不得暴露内部字段名（用户圈出的 why_narrative）；字段名改由 th[title] 承载
    const heads = [...html.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1].trim()).filter(Boolean);
    expect(heads.some((t) => /[a-z]_[a-z]/i.test(t)), `表头：${heads.join('/')}`).toBe(false);
    expect(html).toContain('title="payload.discovery.why_narrative"');
  });

  it('action 响应必须按信封取数（data.data），且不得吞后端 error / 使用空值 provider', () => {
    expect(html, '读顶层 data.items 会让本页恒空（后端信封见 executor.js:233 + routes.js:3718）')
      .toContain('data.data || data');
    expect(html).toContain('payload.error');
    expect(/<option value="">/.test(html), '空串 provider 恒返回 provider_not_enabled_or_unknown')
      .toBe(false);
  });

  it('引入 portal 令牌（受控页既有范式）', () => {
    expect(html).toContain('/portal/tokens.css');
    expect(html).toContain('/portal/common.css');
  });

  // ── 可达性守卫（2026-09-17 实缺陷回归）────────────────────────────────────
  // 事实：本页此前有 routes.js:570 的 serve + 上面 7 条契约测试全绿，但**全仓零导航入口**
  //   —— 菜单（layoutMenu）/ 配置中心（CONFIG_ITEMS）/ 其他页面均无链接指向它。
  //   即「功能完备、测试全绿、无人可达」：判据⑤的同族形态（绿在测试、死在使用）。
  //   ⚠ 教训：契约测试若只断言「页面内部有什么」，永远发现不了「没人到得了」。必须把
  //   「入口存在」本身变成可断言对象，否则补完入口后仍会随下次重构静默脱落。
  it('可达性：必须有导航入口且与公海池互链（防「页面在但没人到得了」回归）', async () => {
    const { FULL_MENU } = await import('../../src/portal/layoutMenu.js');
    const hit = FULL_MENU.find((m) => m.href === '/discovery.html');
    expect(hit, 'discovery.html 失去导航入口 → 又变孤岛').toBeTruthy();
    expect(hit.group).toBe('销售');
    // 与公海池同档 core_crm（同属拓客能力；无权益时整体隐藏，避免「能看不能用」）
    expect(hit.requiresEntitlement).toEqual(['core_crm']);
    // 上游↔下游互链：公海池「主动拓客」面板的文案指向本工作台（定点补全画像 / 评分解释）
    const lp = readFileSync(new URL('../../src/web/lead-pool.html', import.meta.url), 'utf8');
    expect(lp, 'lead-pool 未链到线索发现工作台').toContain('href="/discovery.html"');
  });
});
