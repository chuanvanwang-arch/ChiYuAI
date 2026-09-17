// test/web/crmSyncConsolePage.test.js — CRM 同步控制台契约（2026-09-17 前台可见性审计·第二轮）
//
// 取证到的三处缺口（本测试逐一锁住）：
//   ① `createSyncMetricsRouter` **零生产调用点**（仅定义处 + 单测）⇒ 注释里声称存在的
//      `GET /api/monitor/sync` **实际不存在** ——「模块已建但零接线」重演。→ 断言必须已挂载。
//   ② `sync-mappings` / `sync-trust` 两键此前**零配置位点** ⇒ 只能改库，且信任档无人工闸位点。
//   ③ `kind 不在工厂字典 → mount 静默跳过`（现象＝「配置了但没数据」）此前只能 node -e 手查
//      → 断言页面有「可构造性校验」，把该根因送到前台。
//
// 另断言「不造第二个编辑面」：描述符与凭据的编辑仍归 /discovery-rules.html#integration-sources（#47/#48）。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { CONFIG_ITEMS } from '../../src/portal/configCenter.js';

const page = fs.readFileSync('src/web/crm-sync-console.html', 'utf8');
const routes = fs.readFileSync('src/http/routes.js', 'utf8');

// ⚠ 判据③「注释≠实现」：对**生产接线**的断言必须作用于剥离注释后的代码体。
//   本轮变异验证实拍到反例：把挂载行改成 `// app.use('/api/monitor', createSyncMetricsRouter(...))`
//   后，断言仍匹配（注释行含同样子串）→ 无判别力 = 假绿。
//   实现取**保守的行级剥离**（仅剔除以 `//` 开头的整行）：曾试过正则剥块注释，实测误吞 76KB 代码
//   （源文件含 `/*` 形态的字符串/正则，`[\s\S]*?` 被误导）——**宁可少剥，不可误剥**。
const codeOnly = (s) => s.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
const routesCode = codeOnly(routes);

describe('crm-sync-console 页面契约', () => {
  it('页面读写两个配置键（sync-mappings / sync-trust）', () => {
    expect(page).toContain("'sync-mappings'");
    expect(page).toContain("'sync-trust'");
    expect(page).toMatch(/\/api\/config\/\$\{KEYS\[tab\]\}/);
  });

  it('读用 get、写用 put，并挂载统一布局', () => {
    expect(page).toMatch(/import\s*\{[^}]*get[^}]*put[^}]*\}\s*from\s*'\/portal\/api\.js'/);
    expect(page).toContain('injectLayout()');
  });

  it('三个只读数据源齐备：同步状态 / 连接清单 / 工厂字典', () => {
    expect(page).toContain('/api/monitor/sync');
    expect(page).toContain('/api/integration/providers');
    expect(page).toContain('/api/sync/factories');
  });

  it('⛔ 假绿防线：必须做「kind 是否可构造」校验（否则「配置了但没数据」无法当场归因）', () => {
    expect(page).toMatch(/factories/);
    expect(page).toContain('静默跳过');
    expect(page).toContain('可构造');
  });

  it('信任档暴露 L1/L2/L3 且明示「绝不自动提权」', () => {
    expect(page).toMatch(/TRUST_LEVELS = \['L1', 'L2', 'L3'\]/);
    expect(page).toContain('绝不自动提权');
  });

  it('状态区必须区分「未接入」与「已接入但无增量」（游标行为空 = 尚未跑过）', () => {
    expect(page).toContain('sync_cursor');
    expect(page).toMatch(/尚未跑过/);
  });

  it('不造第二个描述符编辑面——指向既有的外部数据接入 TAB（单源）', () => {
    expect(page).toContain('/discovery-rules.html#integration-sources');
  });

  it('映射编辑器保留 fields 结构且 direction 可选 in/out', () => {
    expect(page).toMatch(/DIRECTIONS = \['in', 'out'\]/);
    expect(page).toContain('f-ext');
    expect(page).toContain('f-par');
  });
});

describe('CRM 同步后端接线契约（零接线即假绿）', () => {
  it('① createSyncMetricsRouter 必须有生产挂载（此前零调用点 = GET /api/monitor/sync 实际不存在）', () => {
    expect(routesCode).toMatch(/import\s*\{[^}]*createSyncMetricsRouter[^}]*\}\s*from\s*'\.\/syncMetricsRouter\.js'/);
    // 剥离注释后断言：注释掉的挂载不算接线
    expect(routesCode).toMatch(/app\.use\('\/api\/monitor',\s*createSyncMetricsRouter\(/);
  });

  it('② routes.js 为两键各挂一个通用配置路由', () => {
    expect(routesCode).toMatch(/createConfigRouter\(\{\s*key:\s*'sync-mappings'/);
    expect(routesCode).toMatch(/createConfigRouter\(\{\s*key:\s*'sync-trust'/);
  });

  it('③ routes.js 暴露控制台页面与工厂字典端点', () => {
    expect(routesCode).toMatch(/app\.get\('\/crm-sync-console\.html'/);
    expect(routesCode).toMatch(/app\.get\('\/api\/sync\/factories'/);
  });

  it('工厂字典端点从「SYNC_PROVIDER_FACTORY ∪ PRESET_FACTORIES」取并集（与生产装配同源）', () => {
    const i = routesCode.indexOf("'/api/sync/factories'");
    const seg = routesCode.slice(i, i + 700);
    expect(seg).toContain('SYNC_PROVIDER_FACTORY');
    expect(seg).toContain('PRESET_FACTORIES');
  });
});

describe('配置中心登记位点', () => {
  it('CONFIG_ITEMS 含 #53 与 #54 且指向 /crm-sync-console.html', () => {
    const a = CONFIG_ITEMS.find((i) => i.id === 53);
    const b = CONFIG_ITEMS.find((i) => i.id === 54);
    expect(a, '缺 #53 CRM 同步字段映射').toBeTruthy();
    expect(b, '缺 #54 CRM 同步信任档').toBeTruthy();
    expect(a.endpoint).toBe('/api/config/sync-mappings');
    expect(b.endpoint).toBe('/api/config/sync-trust');
    expect(a.page).toBe('/crm-sync-console.html');
    expect(b.page).toBe('/crm-sync-console.html');
    expect(a.status).toBe('ready');
    expect(a.group).toBe('智能体与运行');
  });
});
