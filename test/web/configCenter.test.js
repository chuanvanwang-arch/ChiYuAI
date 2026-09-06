import { test, expect } from 'vitest';
import { readFileSync } from 'fs';
import { renderConfigCenter, configSummary, CONFIG_ITEMS } from '../../src/portal/configCenter.js';

test('CONFIG_ITEMS 含 34 项配置（数组按组连续排列：G1[11,12,13,27,28,40,41,42]→G2[14,15,16,31,32,33,35,43,36,37,38,44]→G3[17,18,20,22,29,30,34]→G4[21,23,39]→系统日志[19,24,26,45]，不含已删 25；id22 拆为可编辑词汇(租户) + #45 本体只读(系统)）', () => {
  expect(CONFIG_ITEMS.length).toBe(34);
  const ids = CONFIG_ITEMS.map((i) => i.id);
  expect(ids).toEqual([11,12,13,27,28,40,41,42,14,15,16,17,18,19,20,21,22,23,24,26,29,30,31,32,33,35,43,34,36,37,38,39,44,45]);
});

test('id42 全局复用与经验蔓延：propagation 一级分组、深链复用 propagation-hub.html（对齐 id40/41 深链范式）', () => {
  const item = CONFIG_ITEMS.find((i) => i.id === 42);
  expect(item).toBeTruthy();
  expect(item.name).toBe('全局复用与经验蔓延');
  expect(item.level).toBe('propagation');
  expect(item.group).toBe('平台与访问');
  expect(item.page).toBe('/propagation-hub.html');
  expect(item.endpoint).toBe('/api/propagation/suggestions');
  expect(item.status).toBe('ready');
});

test('renderConfigCenter 渲染第三个一级分组「全局复用与经验蔓延」（data-level=propagation）', () => {
  const html = renderConfigCenter(CONFIG_ITEMS, {});
  expect(html).toContain('data-level="propagation"');
  expect(html).toContain('全局复用与经验蔓延');
  const propSec = html.match(/data-level="propagation">[\s\S]*?<\/section>/);
  expect(propSec ? propSec[0] : '').toContain('data-id="42"');
  expect(propSec ? propSec[0] : '').toContain('href="/propagation-hub.html"');
});

test('renderConfigCenter 按 §15.2 渲染两个一级分组（系统级/租户级），组内保留 G1–G4 子组', () => {
  const html = renderConfigCenter(CONFIG_ITEMS, {});
  // 两个一级分组（level）
  expect(html).toContain('data-level="system"');
  expect(html).toContain('data-level="tenant"');
  // 2026-09-05 用户决议：菜单/TAB 是导航不是权限声明，标签不含角色名
  expect(html).toContain('>系统级 <span');
  expect(html).toContain('>租户级 <span');
  // 角色名不得出现在渲染产物（权限归属由后端闸保证）
  expect(html).not.toContain('tan_admin');
  expect(html).not.toContain('ten_admin');
  // 组内 G1–G4 子组仍在（data-group 保留在子组 div 上）
  for (const g of ['平台与访问', '销售方法论与决策治理', '业务对象与流程建模', '智能体与运行']) {
    expect(html).toContain(`data-group="${g}"`);
  }
});

test('ready 卡（11 LLM）含新深链页面', () => {
  const html = renderConfigCenter(CONFIG_ITEMS, {});
  expect(html).toContain('href="/llm.html"');
  expect(html).toContain('href="/seven-dim.html"');
  expect(html).toContain('href="/pool-config.html"');
});

test('ready 卡（19 元模型）含深链 href', () => {
  const html = renderConfigCenter(CONFIG_ITEMS, {});
  expect(html).toContain('href="/meta-attr-drawer"');
  expect(html).toContain('href="/page-market"');
});

test('用户按 S 编号查找的 5 项均含 sRef 交叉引用（S16/S21/S25/S28/S31）', () => {
  const html = renderConfigCenter(CONFIG_ITEMS, {});
  expect(html).toContain('#11 · S16');
  expect(html).toContain('#16 · S21');
  expect(html).toContain('#20 · S25');
  expect(html).toContain('#23 · S28');
  expect(html).toContain('#26 · S31');
  // 三个 S 编号对应配置的真实页面深链
  expect(html).toContain('href="/skills.html"');
  expect(html).toContain('href="/pool-config.html"');
  expect(html).toContain('href="/agent-config.html"');
  expect(html).toContain('href="/memory.html"');
});

test('config.html 6 组全量覆盖 34 项（G1–G4 + 系统日志 + 传播 TAB，不含已删除的 25）', () => {
  const html = readFileSync(new URL('../../src/web/config.html', import.meta.url), 'utf8');
  // GROUPS 数组字面量（静态文本可断言）：6 组、id 并集 = 11–45 全量（不含 25）
  const groups = [...html.matchAll(/items: \[([\d,\s]+)\]/g)].map((m) => m[1].split(',').map((s) => Number(s.trim())));
  expect(groups.length).toBe(6);                   // 4 组 + 系统日志 + 传播 TAB 专属子组
  const flat = groups.flat();
  expect([...new Set(flat)].sort((a, b) => a - b)).toEqual([11,12,13,14,15,16,17,18,19,20,21,22,23,24,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45]);
  // 2026-08-29 页眉统一规范：页眉仅保留标题，不再含副标题，因此不再断言 .page-sub 文本
  expect(html).toContain('平台与访问');             // G1 组名
  expect(html).toContain('销售方法论与决策治理');   // G2 组名
  expect(html).toContain('业务对象与流程建模');     // G3 组名
  expect(html).toContain('智能体与运行');           // G4 组名
  expect(html).toContain('系统日志');               // 纯显示只读参考子组
  // 卡片标题模板引用 sRef（运行时渲染产物，#16 · S21 等只在浏览器展开，静态文件只断言模板引用）
  expect(html).toContain('it.sRef');
});

test('config.html 增第三 TAB「全局复用与经验蔓延」（仅 ADMIN 可见，深链 /propagation-hub.html）', () => {
  const html = readFileSync(new URL('../../src/web/config.html', import.meta.url), 'utf8');
  expect(html).toContain("level: 'propagation'");
  expect(html).toContain('全局复用与经验蔓延');
  expect(html).toContain("visible: me.level === 'ADMIN'");
  expect(html).toContain('/propagation-hub.html');
  expect(html).toContain('items: [42]');   // 传播 TAB 的专属子组
});

test('CONFIG_ITEMS 的 6 个 schema 页带 sRef 交叉引用（S16/S19/S21/S25/S28/S31）', () => {
  const byId = Object.fromEntries(CONFIG_ITEMS.map((i) => [i.id, i]));
  expect(byId[11].sRef).toBe('S16');   // LLM 配置
  expect(byId[14].sRef).toBe('S19');   // 销售决策场景配置
  expect(byId[16].sRef).toBe('S21');   // 方法论 SKILL 注册表
  expect(byId[20].sRef).toBe('S25');   // 池配置
  expect(byId[23].sRef).toBe('S28');   // 智能体配置
  expect(byId[26].sRef).toBe('S31');   // 记忆/先例管理
  // renderConfigCenter 卡片标题输出 #id · S编号（渲染函数输出可断言）
  const html = renderConfigCenter(CONFIG_ITEMS, {});
  expect(html).toContain('#11 · S16');
  expect(html).toContain('#16 · S21');
  expect(html).toContain('#20 · S25');
  expect(html).toContain('#23 · S28');
  expect(html).toContain('#26 · S31');
});

test('第 12 用户管理已建端点 → ready 卡含页面链接与 note', () => {
  const html = renderConfigCenter(CONFIG_ITEMS, {});
  expect(html).toContain('/users.html');
  expect(html).toContain('密码 crypt hash');
});

test('第 13 RBAC 已建端点 → ready 卡含页面链接与 note', () => {
  const html = renderConfigCenter(CONFIG_ITEMS, {});
  expect(html).toContain('/rbac.html');
  expect(html).toContain('角色×数据范围矩阵');
});

test('id 31 销售行为标准配置卡在 G2 子组且含深链（§15 重分组：属租户级一级分组）', () => {
  const html = renderConfigCenter(CONFIG_ITEMS, {});
  expect(html).toContain('data-id="31"');
  expect(html).toContain('销售行为标准配置');
  expect(html).toContain('href="/behavior-standard-config.html"');
  // id 31 属于 G2 子组（销售方法论与决策治理）且在租户级一级分组内
  const tenantSec = html.match(/data-level="tenant">[\s\S]*?<\/section>/);
  expect(tenantSec ? tenantSec[0] : '').toContain('data-id="31"');
  // 同一租户级 section 内含 G2 子组名（嵌套 div 深度不定，改断言 section 级共现）
  expect(tenantSec ? tenantSec[0] : '').toContain('data-group="销售方法论与决策治理"');
});

test('id 32 判定阈值卡在 G2 子组且含深链（§15 重分组：属租户级一级分组）', () => {
  const html = renderConfigCenter(CONFIG_ITEMS, {});
  expect(html).toContain('data-id="32"');
  expect(html).toContain('判定阈值');
  expect(html).toContain('href="/sales-thresholds-config.html"');
  const tenantSec = html.match(/data-level="tenant">[\s\S]*?<\/section>/);
  expect(tenantSec ? tenantSec[0] : '').toContain('data-id="32"');
});

test('id 35 事件触发复盘配置卡在 G2 组且含深链与端点（③ 事件触发式复盘，2026-09-01）', () => {
  const item = CONFIG_ITEMS.find((i) => i.id === 35);
  expect(item).toBeTruthy();
  expect(item.group).toBe('销售方法论与决策治理');
  expect(item.endpoint).toBe('/api/config/event-retro');
  expect(item.page).toBe('/event-retro-config.html');
  const html = renderConfigCenter(CONFIG_ITEMS, {});
  expect(html).toContain('data-id="35"');
  expect(html).toContain('事件触发复盘配置');
  expect(html).toContain('href="/event-retro-config.html"');
  // §15.2：id 35 属系统级一级分组（数据 scope 仍 tenant，权限层级 system）
  const sysSec = html.match(/data-level="system">[\s\S]*?<\/section>/);
  expect(sysSec ? sysSec[0] : '').toContain('data-id="35"');
});

test('configSummary 对 4 个 readable 端点返回非空摘要', () => {
  const llm = configSummary('readable', { endpoint: '/api/config/llm' }, { provider: 'siliconflow', model: 'deepseek-v4' });
  expect(llm).toContain('siliconflow');
  const pool = configSummary('readable', { endpoint: '/api/pool-config' }, { pickRule: 'round_robin', recycleAfterDays: 30 });
  expect(pool).toContain('round_robin');
  const seven = configSummary('readable', { endpoint: '/api/config/seven-dim' }, { dims: ['why', 'who', 'what', 'when', 'where', 'how', 'cost'] });
  expect(seven).toContain('7');
  const skew = configSummary('readable', { endpoint: '/api/methodology/skew' }, { skills: ['bant', 'meddicc'] });
  expect(skew).toContain('bant');
});

test('空 items 降级返回空容器', () => {
  const html = renderConfigCenter([], {});
  expect(html).toContain('config-center');
  expect(html).not.toContain('data-group');
});

test('G1 两项（id40 租户管理 / id41 平台套餐管理）page 深链到 admin-billing-console 对应 tab', () => {
  const t = CONFIG_ITEMS.find((i) => i.id === 40);
  const p = CONFIG_ITEMS.find((i) => i.id === 41);
  expect(t.page).toContain('admin-billing-console.html#subs');
  expect(p.page).toContain('admin-billing-console.html#plans');
});

test('id44 路由实验（routing-explore）：G2 组、level=system、深链 decision-route-config.html（2026-09-05 P1 注册）', () => {
  const item = CONFIG_ITEMS.find((i) => i.id === 44);
  expect(item).toBeTruthy();
  expect(item.name).toBe('路由实验（routing-explore）');
  expect(item.group).toBe('销售方法论与决策治理');
  expect(item.level).toBe('system');   // 与 id36 场景路由同级（系统级，仅 ADMIN）
  expect(item.status).toBe('ready');
  expect(item.page).toBe('/decision-route-config.html');
  expect(item.endpoint).toBe('/api/config/routing-explore');
  const html = renderConfigCenter(CONFIG_ITEMS, {});
  expect(html).toContain('data-id="44"');
  expect(html).toContain('路由实验');
  expect(html).toContain('href="/decision-route-config.html"');
  // 系统级一级分组内（§15.2：id44 属 system level）
  const sysSec = html.match(/data-level="system">[\s\S]*?<\/section>/);
  expect(sysSec ? sysSec[0] : '').toContain('data-id="44"');
});

test('纯显示只读项（id19/24/26/45）归入系统级「系统日志」子组；id22 业务词汇留租户级（2026-09-05 拆分）', () => {
  const html = renderConfigCenter(CONFIG_ITEMS, {});
  expect(html).toContain('data-group="系统日志"');
  const sysHtml = html.match(/data-level="system">[\s\S]*?<\/section>/)?.[0] || '';
  expect(sysHtml).toContain('data-group="系统日志"');
  for (const id of [19, 24, 26, 45]) {
    expect(sysHtml).toContain(`data-id="${id}"`);
  }
  // id22 业务词汇（可编辑，租户主数据）仍在租户级一级分组内
  const tenHtml = html.match(/data-level="tenant">[\s\S]*?<\/section>/)?.[0] || '';
  expect(tenHtml).toContain('data-id="22"');
});
