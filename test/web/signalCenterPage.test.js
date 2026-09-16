import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

const html = fs.readFileSync('src/web/signal-center.html', 'utf8');
// 剥离 HTML 注释后再做负向断言：注释里记录「原名信号中心」是正确做法，
//   若连注释一起断言，代码写得越清楚越红（假红会被"修"向删注释的错方向）——与 signalCenterWiring 同口径。
const markup = html.replace(/<!--[\s\S]*?-->/g, '');

describe('signal-center 页面契约', () => {
  // 2026-09-16 更名：显示名对齐左侧菜单「销售自动化」（文件/路由/端点标识仍为 signal-center）
  it('页面显示名与菜单一致（「销售自动化」），且无旧名残留', () => {
    expect(markup).toContain('<h2>销售自动化</h2>');
    expect(markup).toContain('<title>销售自动化 · 主动运行时</title>');
    expect(markup).not.toContain('信号中心'); // 鉴别力：改回旧显示名 → 此断言红
  });

  it('页面调用 /api/signals（与后端双向对应）', () => {
    expect(html).toMatch(/\/api\/signals/);
  });

  it('含筛选（状态/严重度）与确认/否决按钮语义', () => {
    expect(html).toMatch(/data-signal-status|data-severity/);
    expect(html).toContain('确认');
    expect(html).toContain('否决');
  });

  it('「采纳」置灰不造假绿（S3 提供）', () => {
    expect(html).toContain('S3');
    expect(html).toContain('不造假绿');
  });

  it('调用确认/否决端点 /api/signals/:id/ack|close', () => {
    expect(html).toContain('/api/signals/${signalId}/');
    expect(html).toContain("'ack'");
    expect(html).toContain("'close'");
  });
});

// 2026-09-16 可读性守门：页面曾直出后端代码（s0_stale / high / 裸 UUID），业务方反馈「看不懂」。
// 以下锁住「展示层中文化」，并带扫描有效性对照（防正则失效 → 空集 → 断言空转的假绿）。
describe('signal-center 展示层可读性守门', () => {
  const page = fs.readFileSync('src/web/signal-center.html', 'utf8');
  const block = page.match(/const KIND_TEXT = \{([\s\S]*?)\n\};/);
  const reg = fs.readFileSync('src/alerts/alertRegistry.js', 'utf8');
  // 权威登记表 = DEFAULT_RULES 里 4 空格缩进的 kind
  const regKinds = [...reg.matchAll(/^ {4}kind: '([a-z0-9_]+)'/gm)].map((m) => m[1]);

  it('扫描有效性对照：可从 alertRegistry 解析出登记 kind（防正则失效致空集）', () => {
    expect(regKinds.length).toBeGreaterThanOrEqual(13);
    expect(regKinds).toContain('deal_stuck');
    expect(regKinds).toContain('named_visit_overdue');
    expect(new Set(regKinds).size).toBe(regKinds.length);
  });

  it('每个登记 kind 都有中文标签（新增 kind 未登记 → 红）', () => {
    expect(block).toBeTruthy();
    const missing = regKinds.filter((k) => !new RegExp(`['"]?${k}['"]?\\s*:`).test(block[1]));
    expect(missing, `缺少中文标签的 kind: ${missing.join(', ')}`).toEqual([]);
  });

  it('严重度列渲染中文（不再直出 high/medium/low）', () => {
    expect(page).toMatch(/SEV_TEXT\[s\.severity\]/);
    expect(page).not.toMatch(/esc\(s\.severity \|\| ''\)/);
  });

  it('说明列优先取业务字段（滞留/逾期天数），不直出 payload.subject 原文', () => {
    expect(page).toContain('function summaryOf');
    expect(page).toMatch(/p\.ageDays/);
    expect(page).not.toMatch(/esc\(\(s\.payload\?\.subject \|\| s\.kind/);
  });

  // 2026-09-16 截图实证：payload.suggestion 是 JSONB 且实测值为 {}（truthy），
  //   String({}) 把 "[object Object]" 直接渲染到说明列 → 必须有字符串类型闸。
  it('说明列不产出 [object Object]（JSONB 对象须被 asText 挡掉）', () => {
    expect(page).toContain('const asText');
    expect(page).toMatch(/typeof v === 'string'/);
    expect(page).toMatch(/asText\(s\.suggestion/);
    expect(page).not.toMatch(/\|\|\s*s\.suggestion\s*\|\|/); // 反向：裸接对象 → 红
  });

  it('列表含租户列（跨租户巡检时才分得清这行是谁的）', () => {
    expect(page).toContain('<th>租户</th>');
    expect(page).toMatch(/s\.tenant_id/);
  });

  // ===== T21 个人隔离（2026-09-16 用户指令「除管理外，需要进行个人隔离！」）=====
  // 页面侧只负责「表达意图 + 呈现作用域」，真正的收窄在服务端强制（tenantScope.signalOwnerScope）。
  it('请求声明窄意图（mine=1），不依赖前端过滤', () => {
    expect(page).toContain("q.set('mine', '1')");
  });

  it('依服务端 meta.enforced 呈现作用域：普通用户只给提示、管理员才给切换', () => {
    expect(page).toContain('function applyScopeUi');
    expect(page).toMatch(/meta\.enforced\s*===\s*true/);
    expect(page).toContain('filter-scope');
    expect(page).toContain('scope-lock');
    // 提示带视图者，便于排查「为什么看不到某条」
    expect(page).toMatch(/meta\.viewer/);
    // 负向对照：不得把 enforced 恒判为假（那会让每个销售员都拿到「全租户」选项）
    expect(page).not.toMatch(/const enforced = false/);
  });

  it('切换范围会重新拉取（否则选项点了没反应）', () => {
    expect(page).toMatch(/filter-scope'\)?\?\.addEventListener\('change', load\)/);
  });
});
