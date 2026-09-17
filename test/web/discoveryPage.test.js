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
