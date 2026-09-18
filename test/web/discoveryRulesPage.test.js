// test/web/discoveryRulesPage.test.js
// 分层说明：本测试为 fs 源码断言（页面结构/契约字面），不连库、不起 HTTP。
// 「接线无 500」由既有 test/http/configRouter.test.js + 本功能线路由测试覆盖（见计划消解 #7）。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const html = readFileSync(new URL('../../src/web/discovery-rules.html', import.meta.url), 'utf8');
const routes = readFileSync(new URL('../../src/http/routes.js', import.meta.url), 'utf8');

// data-tab key 与 panel id（用于「Tab ↔ Panel 一一对应」契约断言，替代脆弱的文案断言）
const tabs = [...html.matchAll(/data-tab="([^"]+)"/g)].map((m) => m[1]);
const panels = [...html.matchAll(/id="panel-([^"]+)"/g)].map((m) => m[1]);

describe('discovery-rules.html 后台配置页', () => {
  // 2026-09-15 改造：原断言绑定中文短名文案（ICP/数据源/信号权重/查重条件/编排），
  // 页面做业务语言改写（ICP→目标客户画像 / 编排→自动策略 / 外部数据接入）后必红——
  // 契约测试只锚结构（data-tab key / panel id），不锚文案；并补齐第 6 个 Tab
  // 「接入数据源」(integration-sources)，此前 5 TAB 版本的守护漏掉了它。
  it('① 6 TAB key 齐且与面板一一对应（含 integration-sources）', () => {
    for (const k of ['icp', 'providers', 'signals', 'duplicate', 'playbooks', 'integration-sources']) {
      expect(html, `缺 tab ${k}`).toContain(`data-tab="${k}"`);
      expect(html, `缺 panel ${k}`).toContain(`id="panel-${k}"`);
    }
    for (const t of tabs) expect(panels, `tab ${t} 缺对应面板（死区：点了没内容）`).toContain(t);
    for (const p of panels) expect(tabs, `面板 ${p} 缺对应 tab`).toContain(p);
  });
  it('② 写端点 + 第0闸票据 + 付费源出厂禁用提示', () => {
    expect(html).toContain('/api/config/discovery-rules');
    expect(html).toContain('decision');   // 回显第0闸 decision 票据
    expect(html).toContain('付费源');      // D1：付费源出厂禁用
  });
  it('③ 接 layout 壳 + 用门户 api 封装（禁裸 fetch）', () => {
    expect(html).toContain("from '/portal/layout.js'");
    expect(html).toContain('injectLayout()');
    expect(html).toContain("from '/portal/api.js'");
    const code = html.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
    expect(code).not.toMatch(/\bfetch\(\s*['"`]\s*\/api\//);   // 禁裸 fetch
    expect(code).toMatch(/\b(get|put)\s*\(\s*['"`]\/api\//);  // 必用 get/put
  });
  it('④ 五段配置面齐（icp/providers/signals/duplicate_criteria/playbooks 键字面）', () => {
    for (const k of ['icp', 'providers', 'signals', 'duplicate_criteria', 'playbooks']) expect(html).toContain(k);
  });
  it('⑤ 零写零删：无 DELETE 字面', () => {
    expect(/\bDELETE\b/i.test(html)).toBe(false);
  });
  it('⑥ routes.js 已挂载（Task 1 落地，本 Task 零改动）', () => {
    expect(routes).toContain("app.use(createConfigRouter({ key: 'discovery-rules'");
    expect(routes).toContain("app.get('/discovery-rules.html'");
  });

  // ── 2026-09-15 补：第 6 个 Tab「接入数据源」的租户实例 CRUD 守护 ──
  // 背景：该 Tab 是配置中心 id47/48 的前台落地入口，先前只由 5 TAB 契约覆盖 → 缺守护。
  it('⑦ 接入数据源面板元素契约完整（授权表 + 实例表 + 弹层 + 表单字段）', () => {
    const ids = [
      'panel-integration-sources', 'intsrc-body', 'inst-body',       // 两张表
      'inst-dialog', 'inst-dialog-title', 'inst-add', 'inst-form',    // 弹层与触发
      'f-id', 'f-kind', 'f-endpoint', 'f-fieldmap', 'f-enabled', 'f-save', 'f-cancel',
    ];
    for (const id of ids) expect(html, `缺元素 #${id}`).toContain(`id="${id}"`);
  });

  it('⑧ 实例 CRUD 接线：启动即加载 + 新增/编辑/软停用（禁物理删除）', () => {
    expect(html).toMatch(/async function loadIntegrationSources/);
    expect(html).toMatch(/loadIntegrationSources\(\);/); // 启动即调用，否则空表 = 伪死区
    expect(html).toMatch(/function openInstDialog/);
    expect(html).toMatch(/async function saveInstDialog/);
    expect(html).toMatch(/async function toggleInst/);   // 软停用开关
    expect(html).toContain("getElementById('inst-add').addEventListener('click'");
  });

  it('⑨ 防回归：保存按钮不得落在 method="dialog" 表单内（否则校验失败即丢输入）', () => {
    // 2026-09-18 随 R4（控件必须 crm-*）同步：断言由裸 <button> 改为 <crm-button>——
    // 契约意图（提交型保存 + 按钮型取消 + 统一走 form submit）不变，强度不降（同时锁死组件形态）。
    expect(html).not.toMatch(/<form[^>]*method="dialog"/);
    expect(html).toMatch(/<crm-button type="submit"[^>]*id="f-save"/);
    expect(html).toMatch(/<crm-button type="button"[^>]*id="f-cancel"/);
    expect(html).toContain("getElementById('inst-form').addEventListener('submit'");
    expect(html).toMatch(/preventDefault\(\)/);
  });

  it('⑩ 端点契约：实例 providers（GET/POST/PUT）+ 凭据 secret（加密落库，明文不回传）', () => {
    expect(html).toContain("get('/api/integration/providers')");
    expect(html).toContain("post('/api/integration/providers'");
    expect(html).toContain('put(`/api/integration/providers/');
    expect(html).toContain("post('/api/integration/secret'");
    expect(html).not.toMatch(/method:\s*'DELETE'/);
  });

  // ── 2026-09-15 补：前端出厂默认「离线副本」与后端 DEFAULT_DISCOVERY_RULES 的键集对齐守护 ──
  // 背景：页面第 164 行的 DEFAULTS 是后端出厂默认的离线兜底副本，注释声称与后端相等，
  //       实际已漂移（缺 providers qixin/xinbang + signals social_content）→
  //       未配置态回显了错误的出厂默认（付费源只有 8 个而非 10 个、信号少一项）。
  //       唯一事实源在 src/config/discoveryRules.js；此处只锚 key 字面防再次漂移。
  it('⑪ 前端出厂默认副本与后端对齐（qixin/xinbang/anysite/social_content 不得缺）', () => {
    for (const k of ['qixin', 'xinbang', 'anysite', 'social_content']) {
      expect(html, `出厂默认副本漂移：缺 ${k}（应对齐 src/config/discoveryRules.js）`).toContain(k);
    }
    // 显示名映射需覆盖新增信号键，否则回退渲染原始 key（用户看到 social_content 而非中文）
    expect(html, 'signals 显示名映射缺 social_content 中文名').toContain('社媒内容');
  });

  // ── 2026-09-15 补：区分「未配置(404)」与「真实加载失败」（假绿防护）──
  // 旧文案「未配置或加载失败，显示出厂默认」把 404 与 403/500/网络错误合并，
  // 故障会被当成默认态 → 用户以为只是没配，实际是坏了。
  it('⑫ 未配置(404) 与 加载失败 分流，用户可见文案不含混淆措辞', () => {
    expect(html).toMatch(/e\.status === 404/);
    expect(html).toMatch(/setStatus\('加载失败（HTTP/);
    const visible = html.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
    expect(visible, '不得再用「未配置或加载失败」合并故障与默认态').not.toContain('未配置或加载失败，显示出厂默认');
  });

  // ── 2026-09-15 补：自动策略（playbooks）面板改为可视化表格编辑器（方案③），替代裸 JSON textarea ──
  it('⑬ 自动策略面板改为可视化表格编辑器：表格+新建按钮+只读预览（不再裸 JSON textarea）', () => {
    expect(html, '缺「出厂不预置」提示（[] 是正常态而非故障）').toContain('出厂不预置');
    expect(html, '缺策略表格主体').toContain('id="pb-body"');
    expect(html, '缺新建策略按钮').toContain('id="pb-add"');
    expect(html, '缺只读 JSON 预览').toContain('id="pb-preview"');
    expect(html, '缺表头列定义').toMatch(/<th[^>]*>名称\(必填\)<\/th>/);
    expect(html, '旧裸 JSON textarea 应已移除').not.toContain('id="playbooks-json"');
  });

  // ── 2026-09-15 补：表格编辑器契约（行模板字段/名称必填闸门/模型驱动序列化）──
  it('⑭ 表格编辑器契约：行内字段类 + 名称必填闸门 + pbRows 模型驱动序列化', () => {
    for (const c of ['pb-name', 'pb-match', 'pb-data', 'pb-ai', 'pb-action']) {
      expect(html, `缺行内输入类 .${c}`).toContain(`class="${c}"`);
    }
    expect(html, '缺名称必填校验闸门字面值').toContain('策略名称必填');
    expect(html, '缺逗号分隔→数组序列化逻辑').toMatch(/splitCsv/);
    expect(html, 'collect 应读 pbRows 模型而非 textarea').toContain('pbRows.filter((p) => p.name).map(toPbObj)');
  });
});
