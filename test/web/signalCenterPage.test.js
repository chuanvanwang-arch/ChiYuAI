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

// ===== P0-2 日历入口（2026-09-17 前台可见性审计）=====
// 后端 GET /api/signals/:id/ics 早已实现且可用，但**全前端零调用** —— 功能存在却无入口，
//   用户感知不到（这正是「落树≠可感知」的典型）。此守门锁住入口，防再度回退。
// 鉴权：该端点走 Bearer token（authHeaders），<a href> 不带 Authorization 头 ⇒ 必须 fetch + Blob 下载。
describe('signal-center 日历入口（ICS 下载）', () => {
  const page = fs.readFileSync('src/web/signal-center.html', 'utf8');

  it('仅对带日历时间（payload.event_at）的信号显示「加入日历」', () => {
    expect(page).toMatch(/payload\?\.event_at/);
    expect(page).toMatch(/data-ics/);
    expect(page).toContain('加入日历');
  });

  it('经 fetch + Blob 下载（Bearer 头无法用 a href 替代）', () => {
    expect(page).toMatch(/\/api\/signals\/\$\{[^}]*\}\/ics/);
    expect(page).toMatch(/createObjectURL/);
    expect(page).toMatch(/download/);
  });

  it('点击委托处理 data-ics（沿用表格级 listener，不逐行绑事件）', () => {
    expect(page).toMatch(/dataset\.ics/);
    expect(page).toMatch(/closest\('\[data-ics\]'\)/);
  });
});

// ── 负向判据文案必须与判据语义一对一（2026-09-17 修实体缺陷）────────────────────
// 缺陷：原实现只有 delivery_silent 一个分支，其余类型一律套用
//   「外部事件命中 N 次，系统却一条提醒都没生成」（读的是 a.fired）。
//   而 signalMetrics 的 `delivery_undelivered` 字段是 attempted/top_error —— 被误述为"零提醒生成"
//   ⇒ 运维拿到的是**错误的故障归因**（该报"渠道尝试过但一次都没送达"，却报"外部事件没生成提醒"）。
//   实测证据（demo-datadriven，2026-09-17）：/api/monitor/signal-link 返回
//   [{type:'delivery_undelivered',channel:'im',attempted:3,top_error:'retry_exhausted'},
//    {type:'delivery_undelivered',channel:'email',attempted:4,top_error:'retry_exhausted'}]
//   而页面没有任何分支能描述它们（且 a.fired 为 undefined 时会渲染出字面量 "undefined"）。
//
// 守卫口径（关键）：**扫描范围必须覆盖全部产生点** —— 从产生方 signalMetrics.js 抽取 type 字面量，
//   断言页面为每个类型都有一条文案分支。只断言页面自身（如"含 delivery_silent"）会漏掉新类型。
describe('负向判据文案覆盖（扫描产生方，不扫页面自身）', () => {
  const producer = fs.readFileSync('src/monitor/signalMetrics.js', 'utf8');
  const types = [...new Set([...producer.matchAll(/type:\s*'([a-z_]+)'/g)].map((m) => m[1]))];

  it('产生方至少登记了 delivery_silent / delivery_undelivered / gen_silent', () => {
    for (const t of ['delivery_silent', 'delivery_undelivered', 'gen_silent']) {
      expect(types, `signalMetrics 未产出 ${t}（若已删类型，请同步本条与页面文案表）`).toContain(t);
    }
  });

  it('页面为**每一个**产生方类型都提供文案分支（不得回落到通用话术）', () => {
    expect(types.length).toBeGreaterThan(0);
    for (const t of types) {
      // 以 `t: (a) =>` 形态判定：在该类型名下确实有一条专属文案函数
      expect(html, `页面缺负向判据「${t}」的专属文案 → 会套用其它判据的文案（错误归因）`)
        .toMatch(new RegExp(`${t}\\s*:\\s*\\(`));
    }
  });

  it('未知类型的兜底必须**原样暴露**类型名，不得借用其它判据文案', () => {
    expect(html).toContain('未知负向判据');
    expect(html).toMatch(/JSON\.stringify\(a\)/);
  });
});
