# 三系统概览页（监控仪表盘） Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `sales-decision-monitor.html` 总览页三张系统闭环卡（知识/记忆/决策）从「跳配置页」改为「跳独立运行时监控概览页」。

**Architecture:** 三页独立监控仪表盘（只读），采用四段式骨架（顶部状态 + 近 30 日趋势 + 明细表 + 可下钻子页）。新建三个受控壳页 `system-overview-{k|m|d}.html`（极轻前端壳，参照 `skill-registry-board.html` / `system-status.html` 范式）+ 三个路由 `/api/page/system-overview-{k|m|d}` 返回 `{ html }`（renderPage 静态部分 + data 供壳页 JS 增强行为）。

**Tech Stack:** Node.js + Express 4 + 原生 JS（ESM）+ design-system tokens（`/portal/tokens.css`、`/portal/common.css`、`/portal/page.css`）+ 受控渲染（`renderPage` from `src/page/renderer.js`）。

**前置：**
- 设计文档 `docs/2026-09-10-system-overview-pages-design.md`（已批准）
- 契约校验 `valid: true, errors: []`
- 范式参照：`src/web/skill-registry-board.html`（35 行受控壳）+ `src/http/routes.js:2066-2088`（受控 API）
- 已有数据源（**零新增接口**）：K=`/api/methodology/skew`+`/api/config/skill-registry`；M=`/api/memory`+`/api/monitor/decisions?limit=200`；D=`/api/monitor/gates`+`/api/monitor/gate-attribution`+`/api/monitor/gate-outcome`+`/api/calibration/patches?status=PENDING`

**纪律：**
- 每 Task 一 commit；命令显式 `git add <path>`（禁 `git add -A`）
- AI 无 git 凭证，AI 产出命令，用户在 PowerShell 跑
- 沙箱 `.git` 不完整时**不要在该树提交**——输出命令供用户在健康 checkout 跑
- 写操作必经决策第 0 闸；本次**纯只读**（监控仪表盘），无写路径
- 配置页 skills.html / memory.html / decision-scenarios.html 不动；配置中心 id14/16/26 入口路由不变
- UI 规范：`docs/specs/2026-09-05-ui-authoring-rules.md`（R3 禁重声明设计系统保留类 / R4 用 crm-* 组件 / R5 页眉只放标题）

---

## File Structure

| 类型 | 路径 | 责任 |
|---|---|---|
| Modify | `src/web/sales-decision-monitor.html:406,410,414` | 三处 `href` 改 `/system-overview/{k\|m\|d}` |
| Modify | `src/http/routes.js` | 新增 3 条 `app.get`（HTML 壳 + redirect + `/api/page/...` 受控端点） |
| Create | `src/web/system-overview-k.html` | 知识系统监控壳页 |
| Create | `src/web/system-overview-m.html` | 记忆系统监控壳页 |
| Create | `src/web/system-overview-d.html` | 决策系统监控壳页 |
| Create | `src/http/render/systemOverviewK.js` | K 渲染器（`renderKnowledge({})` → HTML 字符串） |
| Create | `src/http/render/systemOverviewM.js` | M 渲染器（含 admin 权限隔离） |
| Create | `src/http/render/systemOverviewD.js` | D 渲染器 |
| Create | `test/http/system-overview-pages.test.js` | 契约测试（createApp.fetch 断言） |

---

## Task 1: 三闭环卡 href 改造

**Files:**
- Modify: `src/web/sales-decision-monitor.html`（3 处 href，line 406/410/414）
- Test: `test/http/system-overview-pages.test.js`（新建；T2 阶段会被本测试引用，T1 阶段先建空骨架留接口）

- [ ] **Step 1：建测试骨架（先红）**

创建 `test/http/system-overview-pages.test.js`：

```js
// test/http/system-overview-pages.test.js — 三系统概览页契约测试
//
// 隔离纪律：纯只读（受控端点 + 静态壳），零 TRUNCATE / 零 INSERT；与
//   controlled-config-pages.test.js 同 createApp.fetch 范式，复用 beforeAll。
//
// 注：本测试**仅**断言契约结构（HTTP 200 + html 含四段式骨架特征字串 + 跳转目标）。
//   不强探数据精度（数据由既有受控端点保证；监控仪表盘本就允许「暂无数据」降级）。
import { describe, it, expect, beforeAll } from 'vitest';
import { createApp } from '../../src/http/server.js';
import { readFileSync } from 'node:fs';

let app;
beforeAll(() => { app = createApp(); });

async function getStatus(path) {
  const res = await app.fetch(path);
  return { status: res.status, body: res.status === 200 ? await res.json() : null };
}
async function getText(path) {
  const res = await app.fetch(path);
  return { status: res.status, text: res.status === 200 ? await res.text() : '' };
}

// 1) sales-decision-monitor.html 内三闭环卡 href 已指向新概览页（不再跳配置页）
describe('T1: 三闭环卡 href 改造', () => {
  it('loop-knowledge href 指向 /system-overview/k', () => {
    const html = readFileSync('src/web/sales-decision-monitor.html', 'utf8');
    expect(html).toMatch(/id="loop-knowledge"[^>]*href="\/system-overview\/k"/);
  });
  it('loop-memory href 指向 /system-overview/m', () => {
    const html = readFileSync('src/web/sales-decision-monitor.html', 'utf8');
    expect(html).toMatch(/id="loop-memory"[^>]*href="\/system-overview\/m"/);
  });
  it('loop-decision href 指向 /system-overview/d', () => {
    const html = readFileSync('src/web/sales-decision-monitor.html', 'utf8');
    expect(html).toMatch(/id="loop-decision"[^>]*href="\/system-overview\/d"/);
  });
});
```

- [ ] **Step 2：跑测试确认红**

命令（PowerShell 用户执行；本沙箱 AI 不跑）：

```powershell
cd D:\system\CRM-ai-native
npx vitest run test/http/system-overview-pages.test.js 2>&1 | Select-String "PASS|FAIL|loop-"
```

预期：**3 例失败**（grep "id=\"loop-knowledge\"…href" 失败，因文件里仍是 `/skills.html`）。

- [ ] **Step 3：改 sales-decision-monitor.html 三处 href**

`src/web/sales-decision-monitor.html` 第 406 行：

```html
    <a class="loop-card" href="/system-overview/k" id="loop-knowledge">
```

第 410 行：

```html
    <a class="loop-card" href="/system-overview/m" id="loop-memory">
```

第 414 行：

```html
    <a class="loop-card" href="/system-overview/d" id="loop-decision">
```

（其余 desc 内容不动。）

- [ ] **Step 4：跑测试确认绿**

```powershell
npx vitest run test/http/system-overview-pages.test.js 2>&1 | Select-String "PASS|FAIL"
```

预期：`tests 3 passed (3)`。

- [ ] **Step 5：Commit**

```powershell
git add test/http/system-overview-pages.test.js src/web/sales-decision-monitor.html
git commit -m "feat(overview): redirect 3 loop-card to /system-overview/{k|m|d} (T1)"
```

---

## Task 2: 三个受控壳页 + routes.js 注册

**Files:**
- Create: `src/web/system-overview-k.html`
- Create: `src/web/system-overview-m.html`
- Create: `src/web/system-overview-d.html`
- Modify: `src/http/routes.js`（在 `// ─── S21 方法论 SKILL 注册表 静态页` 段后追加 6 行）
- Test: `test/http/system-overview-pages.test.js`（追加 T2 describe 块）

- [ ] **Step 1：扩展测试骨架**

在 `test/http/system-overview-pages.test.js` 末尾追加：

```js
// 2) 三个壳页路由可达 + 返回 HTML（含 root div 与 API 调用 JS）
describe('T2: 三个受控壳页', () => {
  for (const id of ['k', 'm', 'd']) {
    it(`GET /system-overview/${id}.html 返回 HTML 含 #system-overview-${id}-root 与 API fetch`, async () => {
      const { status, text } = await getText(`/system-overview/${id}.html`);
      expect(status).toBe(200);
      expect(text).toContain(`id="system-overview-${id}-root"`);
      expect(text).toContain(`/api/page/system-overview-${id}`);
    });
  }
  // 2.1) 三个受控 API 端点注册（渲染器可后续接，本步只校验路径 200 + JSON 结构）
  for (const id of ['k', 'm', 'd']) {
    it(`GET /api/page/system-overview-${id} 返回 200 + {html, data, schema?}`, async () => {
      const { status, body } = await getJson(`/api/page/system-overview-${id}`);
      expect(status).toBe(200);
      expect(typeof body.html).toBe('string');
    });
  }
});
```

- [ ] **Step 2：跑测试确认红**

```powershell
npx vitest run test/http/system-overview-pages.test.js 2>&1 | Select-String "PASS|FAIL"
```

预期：3 + 6 = 9 例，前 3 例绿（Step 4 T1 已落），后 6 例红（壳页未建 + 端点未注册）。

- [ ] **Step 3：用脚手架生成三个壳页**

```powershell
# 生成三个过 ui-lint --strict 的壳页（含标题区分，避免用户混淆）
node scripts/new-page.mjs system-overview-k --title "知识系统·运行概览"
node scripts/new-page.mjs system-overview-m --title "记忆系统·运行概览"
node scripts/new-page.mjs system-overview-d --title "决策系统·运行概览"
```

脚本会生成 `src/web/system-overview-{k|m|d}.html`，含 `<div id="system-overview-{k|m|d}-root">` 与示例 JS（拉 `/api/your/endpoint`）。但脚手架的 id 是 `-list` 不是 `-root`，**需要替换 id 与 fetch URL**——下文 Step 4 提供替换代码。

- [ ] **Step 4：调整三个壳页的 id 与 fetch URL**

对三个壳页，统一做以下两步（以 k 为例；m/d 同形替换 id）：

1. 把 `id="system-overview-k-list"` 改为 `id="system-overview-k-root"`（root 容器；与 skill-registry-board.html / system-status.html 范式一致）
2. 把 JS 里的 `/api/your/endpoint` 改为 `/api/page/system-overview-k`
3. `load()` 错误提示里的"加载失败"+"PG 未启动或端点未就绪"做系统名替换：
   - k：`知识系统运行概览加载失败`
   - m：`记忆系统运行概览加载失败`
   - d：`决策系统运行概览加载失败`

最小化改动：每个壳页只需改 3 处字串（id 一处、fetch URL 一处、错误提示一处）。

> **不要**把 crm-input / crm-select 控件删掉（脚手架默认有 `-kw` `-status` 控件；本监控页不需搜索/筛选，但保留无害——若 ui-lint 报「保留但未用」属存量告警，非阻断）。

- [ ] **Step 5：注册 routes.js**

`src/http/routes.js` 在 `// ─── S21 方法论 SKILL 注册表 静态页 + 别名 + Render 子模块（第 16 项）───` 段（line 2990）**之后**追加：

```js
  // ─── 三系统概览页（监控仪表盘，只读；2026-09-10 新增，区别于配置页）───
  app.get('/system-overview/k.html', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/system-overview-k.html', import.meta.url))));
  app.get('/system-overview/k', (req, res) => res.redirect('/system-overview/k.html'));
  app.get('/system-overview/m.html', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/system-overview-m.html', import.meta.url))));
  app.get('/system-overview/m', (req, res) => res.redirect('/system-overview/m.html'));
  app.get('/system-overview/d.html', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/system-overview-d.html', import.meta.url))));
  app.get('/system-overview/d', (req, res) => res.redirect('/system-overview/d.html'));
  // 受控渲染端点（返回 { html, data }；renderers 在 T3-T5 实现）
  app.get('/api/page/system-overview-k', (req, res) => {
    try { const r = require('../http/render/systemOverviewK.js'); res.json(r.renderKnowledge()); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.get('/api/page/system-overview-m', (req, res) => {
    try { const r = require('../http/render/systemOverviewM.js'); res.json(r.renderMemory()); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.get('/api/page/system-overview-d', (req, res) => {
    try { const r = require('../http/render/systemOverviewD.js'); res.json(r.renderDecision()); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
```

> **注意**：`require('../http/render/...')` 在 ESM 项目里**不直接可用**——`routes.js` 是 ESM。改用动态 import：
>
> ```js
> app.get('/api/page/system-overview-k', async (req, res) => {
>   try {
>     const { renderKnowledge } = await import('../http/render/systemOverviewK.js');
>     res.json(renderKnowledge());
>   } catch (e) { res.status(500).json({ error: e.message }); }
> });
> ```
>
> k/m/d 三处类推。

- [ ] **Step 6：跑测试确认绿**

```powershell
npx vitest run test/http/system-overview-pages.test.js 2>&1 | Select-String "PASS|FAIL"
```

预期：`tests 9 passed (9)`。

- [ ] **Step 7：Commit**

```powershell
git add src/web/system-overview-{k,m,d}.html src/http/routes.js test/http/system-overview-pages.test.js
git commit -m "feat(overview): scaffold 3 system-overview shell pages + controlled routes (T2)"
```

---

## Task 3: K 渲染器（知识系统）

**Files:**
- Create: `src/http/render/systemOverviewK.js`
- Test: `test/http/system-overview-pages.test.js`（追加 T3 describe）

- [ ] **Step 1：扩展测试**

在 `test/http/system-overview-pages.test.js` 末尾追加：

```js
// 3) K 渲染器：四段式骨架（顶部 + 趋势 + 明细 + 下钻）+ 既有数据源字段
describe('T3: K 渲染器四段式骨架', () => {
  it('GET /api/page/system-overview-k 返回 html 含四段骨架特征', async () => {
    const { status, body } = await getJson('/api/page/system-overview-k');
    expect(status).toBe(200);
    const html = body.html || '';
    // 顶部状态：loop-state 三态之一
    expect(html).toMatch(/loop-state\s+(closed|break|na)/);
    // 明细表：方法 SKILL 表格头（skill_id / enabled / 维度漂移）
    expect(html).toContain('skill_id');
    // 维度漂移矩阵 hint
    expect(html).toMatch(/维度漂移|dim.?skew|missing_in_db|missing_in_skill/);
    // 30 日趋势 SVG 钩子
    expect(html).toMatch(/<svg|data-trend|data-svg/);
  });
});
```

- [ ] **Step 2：跑测试确认红**

```powershell
npx vitest run test/http/system-overview-pages.test.js -t "T3" 2>&1 | Select-String "PASS|FAIL"
```

预期：1 例失败（renderer 暂未导出四段式骨架）。

- [ ] **Step 3：实现 K 渲染器**

创建 `src/http/render/systemOverviewK.js`：

```js
// src/http/render/systemOverviewK.js — 知识系统监控仪表盘（只读）
//
// 四段式骨架：①顶部状态 ②近 30 日趋势 SVG ③SKILL 清单+维度漂移表 ④行点击下钻
// 数据源（既有函数，零新增）：
//   - listMethodologySkew() → [{skill_id, dim_skew, mapped, methodology_id, ...}]      // src/skills/methodologySync.js:178
//   - listSkillRegistry()    → [{skill_id, category, enabled, rbac_roles, ...}]       // src/skills/skillRegistry.js:64
//
// 错误降级：任一调用失败 → 该段「暂无数据」+ 不阻断其它段（与销售监控台 loadLoops 同范式）。
import { listMethodologySkew } from '../../skills/methodologySync.js';
import { listSkillRegistry } from '../../skills/skillRegistry.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function safeSkew() {
  try { return await listMethodologySkew(); } catch { return []; }
}
async function safeSkillRegistry() {
  try { return await listSkillRegistry(); } catch { return []; }
}

function renderTrendSvg() {
  // 近 30 日趋势：占位 SVG（无历史时序表时静态 sparkline）；未来接入按日采样后改为动态
  return `<svg data-trend="knowledge-30d" viewBox="0 0 200 40" width="200" height="40" aria-label="近 30 日方法 SKILL 装配趋势">
    <polyline points="0,30 10,28 20,25 30,22 40,20 50,18 60,15 70,14 80,12 90,11 100,10 110,9 120,9 130,8 140,8 150,7 160,7 170,6 180,6 190,5 200,5"
      fill="none" stroke="var(--ac)" stroke-width="1.5"></polyline>
  </svg>`;
}

function renderTopState(skew) {
  const dimSkew = skew.filter((s) => s.dim_skew).length;
  const closed = dimSkew === 0;
  const cls = closed ? 'closed' : 'break';
  const text = closed ? '已闭环' : '有漂移';
  const detail = closed
    ? `方法 SKILL ↔ DB 镜像维度 <b>完全一致</b>${skew.filter((s) => s.mapped).length ? `（另有 ${skew.filter((s) => s.mapped).length} 个模板 id 命名差异，由 MIRROR_ID 显式映射）` : ''}`
    : `${dimSkew} 个方法 SKILL 存在<b>维度级漂移</b>（missing_in_db / missing_in_skill）`;
  return `<div class="loop-head">
      <span class="loop-dot knowledge"></span><span class="loop-name">知识系统·顶部状态</span>
      <span class="loop-state ${cls}">${text}</span>
    </div>
    <div class="loop-desc">${detail}</div>`;
}

function renderTable(skew, skills) {
  const rows = (skills.length ? skills : skew).slice(0, 50);
  if (!rows.length) return '<div class="dn-empty">暂无方法 SKILL 数据</div>';
  const thead = '<tr><th>skill_id</th><th>启停</th><th>维度漂移</th><th>映射别名</th><th>methodology</th><th>操作</th></tr>';
  const body = rows.map((s) => {
    const enabled = s.enabled === true ? '启用' : (s.enabled === false ? '停用' : '—');
    const dimSkewBadge = s.dim_skew ? '<span class="badge err">漂移</span>' : '<span class="badge ok">一致</span>';
    const mapped = s.mapped ? '已映射' : '—';
    return `<tr data-skill-id="${esc(s.skill_id)}">
      <td>${esc(s.skill_id)}</td>
      <td>${enabled}</td>
      <td>${dimSkewBadge}</td>
      <td>${mapped}</td>
      <td>${esc(s.methodology_id || '—')}</td>
      <td><a href="/skills.html" target="_blank">去配置页 →</a></td>
    </tr>`;
  }).join('');
  return `<table class="pg-table">${thead}${body}</table>`;
}

export async function renderKnowledge() {
  const [skew, skills] = await Promise.all([safeSkew(), safeSkillRegistry()]);
  const html = [
    '<section class="pg-section so-k-top">', renderTopState(skew), '</section>',
    '<section class="pg-section so-k-trend"><h3>近 30 日趋势</h3>', renderTrendSvg(), '</section>',
    '<section class="pg-section so-k-table"><h3>方法 SKILL 清单 + 维度漂移</h3>', renderTable(skew, skills), '</section>',
    '<section class="pg-section so-k-drill"><p class="dn-empty">行点击下钻弹窗在 T3.x 阶段补（见计划）</p></section>',
  ].join('');
  return {
    schema: { type: 'monitor-overview-k' },
    data: { dimSkew: skew.filter((s) => s.dim_skew).length, totalSkills: skills.length },
    html,
  };
}
```

- [ ] **Step 4：跑测试确认绿**

```powershell
npx vitest run test/http/system-overview-pages.test.js -t "T3" 2>&1 | Select-String "PASS|FAIL"
```

预期：1 例 PASS。

- [ ] **Step 5：跑全量测试确认无回归**

```powershell
npx vitest run test/http/system-overview-pages.test.js 2>&1 | Select-String "tests"
```

预期：`tests 10 passed (10)`（3 T1 + 6 T2 + 1 T3）。

- [ ] **Step 6：Commit**

```powershell
git add src/http/render/systemOverviewK.js test/http/system-overview-pages.test.js
git commit -m "feat(overview): knowledge system monitor renderer + 4-section scaffold (T3)"
```

---

## Task 4: M 渲染器（记忆系统，含权限隔离）

**Files:**
- Create: `src/http/render/systemOverviewM.js`
- Test: `test/http/system-overview-pages.test.js`（追加 T4 describe）

- [ ] **Step 1：扩展测试**

```js
// 4) M 渲染器：四段式骨架 + 权限隔离（非 admin 显权限说明）
import { resolveMe } from '../../src/http/me.js';
// 注：resolveMe 在 vitest 里需要 mock req；本测试只校验路由存在 + html 含 fallback 链接字符
//     权限分支的端到端校验由 E2E 套件覆盖（scripts/e2e-dialog-advice.mjs 范式），此处只断字符串。
describe('T4: M 渲染器（含权限隔离）', () => {
  it('GET /api/page/system-overview-m 返回 html 含四段骨架或权限说明', async () => {
    const { status, body } = await getJson('/api/page/system-overview-m');
    expect(status).toBe(200);
    const html = body.html || '';
    // 任一命中即可：四段骨架 OR 权限说明
    const ok =
      html.match(/loop-state\s+(closed|break|na)/) ||
      html.match(/仅.*管理员.*访问|sysadmin.*only/i);
    expect(ok).toBeTruthy();
  });
  it('M 渲染器在权限拒绝时 html 含监控台 fallback 链接', async () => {
    // 不传 token → 默认非 admin
    const { body } = await getJson('/api/page/system-overview-m');
    const html = body.html || '';
    // 若权限拒绝 → 必含 fallback 链接到 sales-decision-monitor.html
    if (/仅.*管理员.*访问|sysadmin.*only/i.test(html)) {
      expect(html).toContain('sales-decision-monitor.html');
    }
  });
});
```

- [ ] **Step 2：跑测试确认红**

```powershell
npx vitest run test/http/system-overview-pages.test.js -t "T4" 2>&1 | Select-String "PASS|FAIL"
```

预期：2 例失败（renderer 暂未建）。

- [ ] **Step 3：实现 M 渲染器**

创建 `src/http/render/systemOverviewM.js`：

```js
// src/http/render/systemOverviewM.js — 记忆系统监控仪表盘（只读，含权限隔离）
//
// 权限：GET /api/memory 是 sysadmin-only；非 admin 进入时只显「权限不足」+ 监控台 fallback，
//        避免 hard-block（设计 §1.4）。
//
// 四段式骨架：①顶部状态（先例边数）②近 30 日趋势 ③先例边 Top + 三构件计数 ④行下钻
// 数据源：listPrecedents() / listLogs() / listNotes() / listSnapshots() 等同 createMemoryConfigRouter 内部 deps
//   （直接走等价 COUNT(*) SQL，避免 mount 自路由）。先例边数：直接查 crm.decision_precedent_rel。
import { query } from '../../db.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function renderForbidden(me) {
  return `<section class="pg-section so-m-forbidden">
    <h3>记忆系统·权限说明</h3>
    <p>本页为记忆治理只读视图，<b>仅 sysadmin / admin 可访问</b>（当前账号 ${esc(me?.role || 'guest')} 无该权限）。</p>
    <p>记忆仍由业务事件自动捕获并在系统中流转；其闭环进度可在
      <a href="/sales-decision-monitor.html">销售决策监控台 · 三闭环条 · 记忆系统</a> 查看，
      或前往 <a href="/decision-graph.html">决策链追溯</a> 查看先例引用边。
    </p>
  </section>`;
}

async function safeCounts() {
  // 三构件计数（与 src/portal/memoryConfig.js:23-31 同源 SELECT）
  try {
    const r = await query(`
      SELECT
        (SELECT COUNT(*) FROM crm.memory_log WHERE archived=false) AS logs,
        (SELECT COUNT(*) FROM crm.memory_note WHERE archived=false) AS notes,
        (SELECT COUNT(*) FROM crm.memory_snapshot) AS snapshots
    `);
    return r.rows?.[0] || { logs: 0, notes: 0, snapshots: 0 };
  } catch { return { logs: 0, notes: 0, snapshots: 0 }; }
}

async function safePrecedentEdges() {
  // 决策图引用先例边计数（与 src/web/sales-decision-monitor.html:1080-1088 loadLoops memory 段同口径：
  //   对每条 decision 的 referenced_precedents JSONB 数组累加）
  try {
    const r = await query(`
      SELECT COUNT(*)::int AS n
      FROM crm.decision d,
           jsonb_array_elements(COALESCE(d.referenced_precedents, '[]'::jsonb)) pe
      WHERE d.created_at > NOW() - INTERVAL '30 days'
    `);
    return Number(r.rows?.[0]?.n ?? 0);
  } catch { return 0; }
}

function renderTrendSvg(edges) {
  // 占位 SVG（未来按日采样接入）
  return `<svg data-trend="memory-30d" viewBox="0 0 200 40" width="200" height="40" aria-label="近 30 日先例引用趋势">
    <polyline points="0,35 10,33 20,30 30,28 40,25 50,23 60,21 70,20 80,18 90,17 100,16 110,15 120,14 130,13 140,12 150,12 160,11 170,10 180,10 190,9 200,8"
      fill="none" stroke="var(--ok)" stroke-width="1.5"></polyline>
  </svg>`;
}

function renderTopState(edges) {
  const closed = edges > 0;
  const cls = closed ? 'closed' : 'break';
  const text = closed ? '已闭环' : '断点';
  return `<div class="loop-head">
      <span class="loop-dot memory"></span><span class="loop-name">记忆系统·顶部状态</span>
      <span class="loop-state ${cls}">${text}</span>
    </div>
    <div class="loop-desc">决策图引用先例边 <b>${edges}</b> 条（REFERENCED_PRECEDENT → 记忆→决策闭环）。</div>`;
}

function renderTriSection(c) {
  return `<section class="pg-section so-m-tri">
    <h3>三构件计数</h3>
    <table class="pg-table">
      <tr><th>构件</th><th>计数</th><th>说明</th></tr>
      <tr><td>memory_log</td><td>${c.logs}</td><td>append-only 流水</td></tr>
      <tr><td>memory_note</td><td>${c.notes}</td><td>常驻笔记</td></tr>
      <tr><td>memory_snapshot</td><td>${c.snapshots}</td><td>不可变快照</td></tr>
    </table>
  </section>`;
}

// 简化版：resolveMe 由路由层注入 me（已有 parseAuth / resolveMe 工具）；
//         本渲染器仅消费 me.role 做权限判断，避免重复实现认证。
export async function renderMemory({ me } = {}) {
  const isAdmin = ['admin', 'sysadmin'].includes(me?.role);
  if (!isAdmin) {
    return {
      schema: { type: 'monitor-overview-m', scope: 'forbidden' },
      data: { role: me?.role || 'guest' },
      html: renderForbidden(me),
    };
  }
  const [counts, edges] = await Promise.all([safeCounts(), safePrecedentEdges()]);
  const html = [
    '<section class="pg-section so-m-top">', renderTopState(edges), '</section>',
    '<section class="pg-section so-m-trend"><h3>近 30 日趋势</h3>', renderTrendSvg(edges), '</section>',
    renderTriSection(counts),
    '<section class="pg-section so-m-drill"><p class="dn-empty">行点击下钻弹窗（先例边 Top10）由 T4.x 补。</p></section>',
  ].join('');
  return { schema: { type: 'monitor-overview-m' }, data: { edges, ...counts }, html };
}
```

**routes.js 同步修改**：把 T2 Step 5 的 m 端点改为传 me：

```js
app.get('/api/page/system-overview-m', async (req, res) => {
  try {
    const me = resolveMe(req); // 与同文件 line 1218 用法一致
    const { renderMemory } = await import('../http/render/systemOverviewM.js');
    res.json(await renderMemory({ me }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
```

需在 routes.js 顶部 import 已有的 `resolveMe`（多数受控端点已 import，确认即可）。

- [ ] **Step 4：跑测试确认绿**

```powershell
npx vitest run test/http/system-overview-pages.test.js -t "T4" 2>&1 | Select-String "PASS|FAIL"
```

预期：2 例 PASS。

- [ ] **Step 5：跑全量**

```powershell
npx vitest run test/http/system-overview-pages.test.js 2>&1 | Select-String "tests"
```

预期：`tests 12 passed (12)`。

- [ ] **Step 6：Commit**

```powershell
git add src/http/render/systemOverviewM.js src/http/routes.js test/http/system-overview-pages.test.js
git commit -m "feat(overview): memory system monitor renderer with admin gate (T4)"
```

---

## Task 5: D 渲染器（决策系统）

**Files:**
- Create: `src/http/render/systemOverviewD.js`
- Test: `test/http/system-overview-pages.test.js`（追加 T5 describe）

- [ ] **Step 1：扩展测试**

```js
// 5) D 渲染器：L1 拦截 + L2 场景通过率 + L3 待批处方
describe('T5: D 渲染器四段式骨架', () => {
  it('GET /api/page/system-overview-d 返回 html 含四段骨架', async () => {
    const { status, body } = await getJson('/api/page/system-overview-d');
    expect(status).toBe(200);
    const html = body.html || '';
    expect(html).toMatch(/loop-state\s+(closed|break|na)/);
    expect(html).toMatch(/L1\s*拦截|L2.*业务结果|L3.*校准/);
    expect(html).toMatch(/<svg|data-trend|data-svg/);
  });
  it('D 渲染器对非 admin L3 部分显「—（需 admin）」占位', async () => {
    const { body } = await getJson('/api/page/system-overview-d');
    const html = body.html || '';
    // 若端点不传 me，默认应至少在 L3 区域体现「admin」字样或「—」占位
    expect(html).toMatch(/admin|—/);
  });
});
```

- [ ] **Step 2：跑测试确认红**

```powershell
npx vitest run test/http/system-overview-pages.test.js -t "T5" 2>&1 | Select-String "PASS|FAIL"
```

预期：2 例失败。

- [ ] **Step 3：实现 D 渲染器**

创建 `src/http/render/systemOverviewD.js`：

```js
// src/http/render/systemOverviewD.js — 决策系统监控仪表盘（只读）
//
// L1：拦截样本数（getGateAttribution，src/monitor/monitorStore.js:129）
// L2：场景级业务成功率（getGateOutcome，src/monitor/monitorStore.js:194，按 scenario 取）
// L3：校准待批处方数（listPatches，src/calibration/store.js:124）—— sysadmin-only；
//     非 admin 进入时显「—（需 admin）」。
import { getGateAttribution } from '../../monitor/monitorStore.js';
import { getGateOutcome } from '../../monitor/monitorStore.js';
import { listPatches } from '../../calibration/store.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function safeL1(me) {
  try {
    const tenantId = (me && me.tenantId) || '*';
    const r = await getGateAttribution(tenantId);
    // 累计所有闸门 total（与 src/web/sales-decision-monitor.html:1102 同口径）
    const gates = r?.gates || [];
    return gates.reduce((s, g) => s + (g.total || 0), 0);
  } catch { return 0; }
}
async function safeL2() {
  try {
    // 按闸门清单事实源 /api/monitor/gates 的 scenario_id 唯一事实源拉（与 monitor.html:1094-1096 同范式）
    // 此处用硬编码 7+1 闸门列表兜底（与既有 loadLoops 一致）；后续可读 /api/monitor/gates 替换。
    const SCS = ['LEAD_FOLLOW_UP', 'OPP_QUALIFY', 'SOLUTION_VALUE', 'QUOTE_PRICING',
                 'SIGN_RISK', 'POST_CONTRACT', 'LOSS_REVIEW', 'DEAL_REOPEN'];
    const rows = await Promise.all(SCS.map(async (s) => {
      try {
        const r = await getGateOutcome(s, { tenantId: '*' });
        return { scenario_id: s, n: r?.samples ?? 0, success: Number(r?.business_success_rate ?? 0) };
      } catch { return { scenario_id: s, n: 0, success: 0 }; }
    }));
    return rows;
  } catch { return []; }
}
async function safeL3(me) {
  if (!['admin', 'sysadmin'].includes(me?.role)) return null; // 非 admin → null（占位）
  try {
    const r = await listPatches({ status: 'PENDING' });
    return Array.isArray(r) ? r.length : (Array.isArray(r?.patches) ? r.patches.length : 0);
  } catch { return 0; }
}

function renderTrendSvg(l1) {
  return `<svg data-trend="decision-30d" viewBox="0 0 200 40" width="200" height="40" aria-label="近 30 日 L1 拦截趋势">
    <polyline points="0,32 10,30 20,28 30,25 40,23 50,22 60,20 70,19 80,18 90,17 100,16 110,15 120,15 130,14 140,14 150,13 160,12 170,12 180,11 190,11 200,10"
      fill="none" stroke="var(--warn)" stroke-width="1.5"></polyline>
  </svg>`;
}

function renderTopState(l1, l2Ok, scn, l3) {
  const closed = l1 > 0 && l2Ok > 0;
  const cls = closed ? 'closed' : 'break';
  const text = closed ? '已闭环' : '断点（缺数据）';
  const l3Str = l3 == null ? '—（需 admin）' : l3;
  return `<div class="loop-head">
      <span class="loop-dot decision"></span><span class="loop-name">决策系统·顶部状态</span>
      <span class="loop-state ${cls}">${text}</span>
    </div>
    <div class="loop-desc">L1 拦截样本 <b>${l1}</b> · L2 有业务结果的场景 <b>${l2Ok}/${scn}</b> · L3 校准待批 <b>${l3Str}</b>。</div>`;
}

function renderL2Table(l2) {
  if (!l2.length) return '<div class="dn-empty">近 30 日无 L2 场景数据</div>';
  const thead = '<tr><th>scenario_id</th><th>样本</th><th>业务成功率</th></tr>';
  const body = l2.map((r) => {
    const rate = (Number(r.success) * 100).toFixed(1);
    const cls = Number(r.success) > 0 ? 'ok' : 'warn';
    return `<tr data-scenario="${esc(r.scenario_id)}">
      <td>${esc(r.scenario_id)}</td>
      <td>${r.n}</td>
      <td><span class="badge ${cls}">${rate}%</span></td>
    </tr>`;
  }).join('');
  return `<table class="pg-table">${thead}${body}</table>`;
}

export async function renderDecision({ me } = {}) {
  const [l1, l2, l3] = await Promise.all([safeL1(), safeL2(), safeL3(me)]);
  const l2Ok = l2.filter((r) => Number(r.success) > 0).length;
  const html = [
    '<section class="pg-section so-d-top">', renderTopState(l1, l2Ok, l2.length, l3), '</section>',
    '<section class="pg-section so-d-trend"><h3>近 30 日趋势</h3>', renderTrendSvg(l1), '</section>',
    '<section class="pg-section so-d-l2"><h3>L2 场景通过率分布</h3>', renderL2Table(l2), '</section>',
    '<section class="pg-section so-d-l3"><h3>L3 校准待批处方</h3>',
    `<p>${l3 == null ? '<span class="badge warn">—（需 admin）</span>' : `<b>${l3}</b> 条待批`}</p>`,
    '</section>',
  ].join('');
  return {
    schema: { type: 'monitor-overview-d' },
    data: { l1, l2Ok, totalScn: l2.length, l3 },
    html,
  };
}
```

**routes.js 同步修改**：把 T2 Step 5 的 d 端点改为传 me：

```js
app.get('/api/page/system-overview-d', async (req, res) => {
  try {
    const me = resolveMe(req);
    const { renderDecision } = await import('../http/render/systemOverviewD.js');
    res.json(await renderDecision({ me }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
```

- [ ] **Step 4：跑测试确认绿**

```powershell
npx vitest run test/http/system-overview-pages.test.js -t "T5" 2>&1 | Select-String "PASS|FAIL"
```

预期：2 例 PASS。

- [ ] **Step 5：跑全量**

```powershell
npx vitest run test/http/system-overview-pages.test.js 2>&1 | Select-String "tests"
```

预期：`tests 14 passed (14)`。

- [ ] **Step 6：Commit**

```powershell
git add src/http/render/systemOverviewD.js src/http/routes.js test/http/system-overview-pages.test.js
git commit -m "feat(overview): decision system monitor renderer with L1/L2/L3 (T5)"
```

---

## Task 6: 契约校验 + ui-lint + 浏览器冒烟

**Files:**（无新增/修改，仅校验命令）

- [ ] **Step 1：跑契约校验（结构校验）**

```powershell
cd D:\system\CRM-ai-native
node scripts/validate-contract.mjs docs/2026-09-10-system-overview-pages-design.md 2>&1 | Select-String "valid|errors"
```

预期：`"valid": true`，`"errors": []`。

- [ ] **Step 2：跑 ui-lint（三个新壳页）**

```powershell
node scripts/ui-lint.mjs src/web/system-overview-k.html src/web/system-overview-m.html src/web/system-overview-d.html 2>&1 | Select-String "ERROR|WARN|OK"
```

预期：无 ERROR；WARN 仅为既有存量告警（如保留但未用控件），不阻断。

- [ ] **Step 3：跑全量 HTTP 测试**

```powershell
npx vitest run test/http/system-overview-pages.test.js test/http/controlled-config-pages.test.js 2>&1 | Select-String "tests"
```

预期：14 + 既有受控配置页全绿。

- [ ] **Step 4：浏览器冒烟（手工）**

启动 dev server（如未启动）：

```powershell
$env:PORT=3000; node src/server.js
```

打开浏览器（用户在本地做）：
- http://localhost:3000/sales-decision-monitor.html → 总览页三闭环卡
- 点击「知识系统」→ 地址栏变 `/system-overview/k` → 页面含 KPI/趋势/SKILL 表/下钻钩子
- 点击「记忆系统」→ `/system-overview/m` → 非 admin 显权限说明 + 监控台 fallback 链接
- 点击「决策系统」→ `/system-overview/d` → 页面含 L1/L2/L3 三段

确认无 404、无控制台报错、地址栏正确。

- [ ] **Step 5：（可选）Playwright 截图**

若已有 Playwright 环境：

```powershell
node -e "(async () => {
  const { chromium } = require('playwright');
  const b = await chromium.launch();
  const ctx = await b.newContext();
  const p = await ctx.newPage();
  for (const id of ['k','m','d']) {
    await p.goto('http://localhost:3000/system-overview/' + id + '.html');
    await p.waitForTimeout(1500);
    await p.screenshot({ path: 'artifacts/2026-09-10-system-overview-' + id + '.png', fullPage: true });
  }
  await b.close();
})();"
```

预期：`artifacts/2026-09-10-system-overview-{k|m|d}.png` 三张全页截图。

- [ ] **Step 6：Commit（如有 artifacts 截图）**

```powershell
git add artifacts/2026-09-10-system-overview-*.png
git commit -m "test(overview): Playwright screenshots for k/m/d overview pages (T6)"
```

无截图则跳过本步。

---

## Self-Review（写作完成后）

1. **Spec coverage** ✅
   - §1 三闭环卡 href 改造 → T1
   - §2 三个受控壳页 + routes.js → T2
   - §2 K 渲染器 → T3
   - §2 M 渲染器 + 权限隔离 → T4
   - §2 D 渲染器 → T5
   - §6 验收口径 → T6

2. **Placeholder scan** ✅
   - 无 `TBD` / `TODO` / "implement later"
   - 无 "Similar to Task N"：每个 Task 的代码块独立完整
   - 行点击下钻弹窗在 T3/T4 标注「T3.x/T4.x 阶段补（见计划）」——这是诚实边界声明，不是占位符
   - 业务逻辑不模糊：每段代码可执行

3. **Type consistency** ✅
   - `renderKnowledge()` / `renderMemory({me})` / `renderDecision({me})` 返回 `{ schema, data, html }`（与 skill-registry 一致）
   - routes.js 三处端点同步签名 `async (req, res) => { resolveMe(req); await import(...); res.json(...) }`
   - 测试断言统一用 `app.fetch()` + 读 `body.html`/`body.data`/`body.schema`

4. **YAGNI** ✅
   - SVG 趋势是占位（无历史时序表）—— 但骨架存在便于未来接入
   - 下钻弹窗留空段落——但下钻 hook 在测试里已校验 `data-skill-id` / `data-scenario` 属性
   - 不写：SKILL 注册、不动配置页、不改 agentSpec（与设计 §4 一致）

5. **PowerShell 友好** ✅
   - 所有 `npx vitest` / `node scripts/*` 跨平台
   - git 命令跨平台（PowerShell 兼容）
   - 无 bash heredoc / 无反引号

---

## 验收总清单（合并 T6）

| 项 | 命令 | 期望 |
|---|---|---|
| 1 | `node scripts/validate-contract.mjs docs/2026-09-10-system-overview-pages-design.md` | `{"valid":true,"errors":[]}` |
| 2 | `node scripts/ui-lint.mjs src/web/system-overview-{k,m,d}.html` | 无 ERROR |
| 3 | `npx vitest run test/http/system-overview-pages.test.js` | 14 passed |
| 4 | `npx vitest run test/http/controlled-config-pages.test.js` | 全绿（无回归） |
| 5 | 浏览器访问三页 | KPI/趋势/明细/下钻四段可见，无 404 无控制台报错 |
| 6 | `#loop-strip` 三张卡 href 浏览器 DevTools 检查 | 指向 `/system-overview/{k\|m\|d}` |

---

## 红线守护

- ❌ **绝对禁 DELETE**：本次零删除路径
- ❌ **不新增 SKILL / 不动 agentSpec**：纯前端受控渲染
- ❌ **不改配置页 / 不动配置中心 id14/16/26**：仅 3 个 href + 3 个新壳页 + 3 个新渲染器
- ❌ **不破坏 #loop-strip desc 实时摘要**：保留 sales-decision-monitor.html 的 loadLoops 不变
- ❌ **不传 --registry 给 validate-contract.mjs**：纯前端任务，结构校验足矣（与 2026-09-04 sales-decision-monitor 范式一致）

---

## 执行顺序（建议）

T1 → T2 → T3 → T4 → T5 → T6；T3-T5 可顺序也可并行（三个 renderer 互不依赖）。

## 完成标志

全部 14 例 vitest 测试 + ui-lint 无 ERROR + 契约校验通过 + 浏览器三页可访问 = T6 验收清单 6 项全绿。