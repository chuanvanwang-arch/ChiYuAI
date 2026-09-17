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

// 2026-09-17 单源守门（前台可见性审计修复）：页面曾自建一份 KIND_TEXT/SEV_TEXT/summarizer 内联副本，
//   与 src/portal/signalLabels.js **重复**（违单源铁律）——新增 kind 漏改一处即直出英文码
//   （contact_change / relation_cooling / tender_deadline / report_due 四个新 kind 就是这样漏掉的）。
//   现：中文化 + 摘要全部取自单源模块；kind 覆盖度守卫迁至 test/portal/signalLabels.test.js（扫全部产生点）。
describe('signal-center 展示层单源守门（不得自建映射副本）', () => {
  const page = fs.readFileSync('src/web/signal-center.html', 'utf8');

  it('页面 import 单源展示模块 /portal/signalLabels.js', () => {
    expect(page).toContain("from '/portal/signalLabels.js'");
    expect(page).toMatch(/kindLabel|severityLabel/);
  });

  it('页面不再自建 KIND_TEXT / SEV_TEXT / STATUS_TEXT / summaryOf（内联副本 → 红）', () => {
    expect(page).not.toMatch(/const KIND_TEXT\s*=/);
    expect(page).not.toMatch(/const SEV_TEXT\s*=/);
    expect(page).not.toMatch(/const STATUS_TEXT\s*=/);
    expect(page).not.toMatch(/function summaryOf\s*\(/);
  });

  it('渲染调用单源函数（类型/严重度/说明/对象）', () => {
    expect(page).toMatch(/esc\(kindLabel\(s\.kind\)\)/);
    expect(page).toMatch(/esc\(severityLabel\(s\.severity\)\)/);
    expect(page).toMatch(/summarizeSignal\(s\)/);
    expect(page).toMatch(/scopeLabel\(s\)/);
  });

  it('类型下拉也用单源标签（避免「下拉中文、表格英文」）', () => {
    expect(page).toMatch(/o\.textContent\s*=\s*kindLabel\(k\)/);
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
