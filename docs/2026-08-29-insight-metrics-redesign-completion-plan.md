# 数字化指标重设计收尾实施计划（决策 1乙 · 决策 2折叠 · 决策 3乙）

> **For agentic workers:** REQUIRED SUB-SKILL: 使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 按 Task 逐步实施。步骤用 checkbox（`- [ ]`）跟踪。
>
> 设计来源：`docs/2026-08-28-customer-insight-metrics-redesign.md`（已批准，用户今日确认：**决策1=乙（浅色皮肤）· 决策2=折叠 · 决策3=乙（最小修复）**）。
> 前置事实：设计 §9 的 T1–T8（洞察页侧 schema/validator/renderer/insightService 聚合）**已落地**；本计划补齐**未落地**的 T9/T10/T11 + 三项决策落点。

**Goal:** 完成数字化指标重设计剩余工作——S35 明细段折叠、浅色皮肤（决策乙）、`pipeline.html` LTC 价值流指标与最小鉴权修复，全部 TDD 红→绿。

**Architecture:** 
- 决策1乙：在 `page.css` 为 `.pg-kpi/.pg-pipeline/.pg-stage/.pg-progress-card/.pg-bar` 增加**浅色局部皮肤变量层**（`--pg-bg/--pg-panel/--pg-ink/--pg-mut/--pg-line/--pg-ok/--pg-warn/--pg-err/--pg-ac`），作用于**账户洞察页容器**（`.pg-page[data-skin="insight"]` 作用域），不影响门户其余深色页面；`S35.schema.js` 布局声明 `skin: 'insight'`。
- 决策2折叠：S35 明细三组（时间线/任务线/决策链）改为 `<details class="pg-collapse">`（renderer 新增 `pg-collapse` 折叠容器渲染，table 保持原组件）；
- 决策3乙：`pipeline.html` 列表读取 `load()` 改用 `api()`（自动带 Bearer，`src/web/api.js` 已透传）+ 前端按 `GET /api/auth/me` 返回的 `role` 对金额字段套 `FIELD_PERMS` 隐藏（sales 隐藏 payment_amount 类字段；服务端 `/api/particles` 保持现状，不扩大改动面）。
- LTC 侧：`scoring.js` 新增纯函数 `pipelineMetrics(deals)`（六段 count/amount + 段间转化率 + 管道总览四联 + 停滞/赢单率/均值，口径对齐设计 §5.5）；`pipeline.html` 顶部渲染 `kpi-strip`×2 + `pipeline` 六段，列头升级「数量 · 金额」。

**Tech Stack:** Node 22 + ESM + Express 4 + vitest 3（注入式/纯函数测试）；浏览器 ESM 纯渲染子模块（`scoring.js` 浏览器可直接 import，零服务端依赖）。

---

## 文件结构（变更清单）

| 操作 | 文件 | 职责 |
|---|---|---|
| Modify | `src/web/page.css` | 新增 `.pg-collapse` 折叠样式 + `.pg-page[data-skin="insight"]` 浅色皮肤变量层（决策1乙） |
| Modify | `src/page/renderer.js` | 新增 `renderCollapse` 折叠容器（details/summary 包裹子组件），dispatch 支持 `kind:'collapse'` |
| Modify | `src/page/schema.js` | COMPONENT_KINDS 加 `collapse`；`CANONICAL_NAV`/类型常量同步 |
| Modify | `src/pages/S35.schema.js` | 明细三组包进 `kind:'collapse'`（决策2折叠）；布局 `skin:'insight'`（决策1乙） |
| Modify | `src/portal/scoring.js` | 新增 `pipelineMetrics(deals)` 纯函数 + `l2cStages`（T9） |
| Modify | `src/web/pipeline.html` | `load()` 改 `api()` + role 鉴权金额守卫 + 顶部 kpi-strip×2 + LTC 六段 + 列头「数量·金额」+ 引 page.css（T10 + 决策3乙） |
| Create | `test/portal/scoring.test.js` | `pipelineMetrics` 纯函数测试（T11） |
| Create | `test/page/collapse-renderer.test.js` | collapse 渲染测试 |
| Modify | `test/s35-schema.test.js` | 断言 5 views + 明细折叠 + skin 声明 |
| Modify | `test/page/renderer.test.js` | collapse dispatch case |
| Create | `test/page/insight-skin.test.js` | page.css 浅色皮肤令牌存在性断言 |

**兼容性铁律：**
- 不新增 `aggregate` 之外的组件数据源契约（collapse 是纯布局容器，不含 dataBinding，内部子组件各自保留粒子/聚合数据源）。
- `pipeline.html` 服务端 `/api/particles` 不加鉴权（决策3乙=最小修复，服务端收敛=决策3丙不在范围）。
- 每 Task 一 commit（沙箱无 git 凭证，交付本地提交命令，禁 `git add -A`）。

---

## Task 1 — renderer 新增 collapse 折叠容器（决策2）

**Files:**
- Modify: `src/page/schema.js`（COMPONENT_KINDS + collapse）
- Modify: `src/page/renderer.js`（renderCollapse + dispatch）
- Test: `test/page/collapse-renderer.test.js`（新建）
- Test: `test/page/renderer.test.js`（补 dispatch case）

- [ ] **Step 1: 写失败测试（collapse 容器契约）**

新建 `test/page/collapse-renderer.test.js`：

```js
// test/page/collapse-renderer.test.js — 折叠容器（决策2）渲染契约
import { describe, it, expect } from 'vitest';

// 直接从 renderer.js 导入 renderCollapse（若未导出，导入 renderPage 后断言 HTML）
import { renderPage } from '../../src/page/renderer.js';

const schema = {
  type: 'workspace', title: '折叠测试', navigation: { to: '/x' }, layout: { columns: 1, theme: 'light' },
  components: [
    {
      kind: 'collapse', title: '明细区', open: false,
      children: [
        { kind: 'table', title: '时间线',
          dataBinding: { source: 'particle', particleType: 'CRM_ACCOUNT', filters: [], metrics: [],
                          columns: ['ts', 'type', 'title'] }, columns: ['ts', 'type', 'title'] },
      ],
    },
  ],
};
const data = {
  components: { table: { '时间线': { rows: [ { ts: '2026-08-29', type: 'event', title: '拜访' } ] } } },
};

describe('collapse 折叠容器', () => {
  it('① 渲染 <details class="pg-collapse">，默认未 open', () => {
    const html = renderPage(schema, data);
    expect(html).toContain('<details class="pg-collapse"');
    expect(html).toContain('<summary>明细区</summary>');
    expect(html).not.toContain('open');
  });
  it('② open=true 时渲染 open 属性', () => {
    const s = structuredClone(schema);
    s.components[0].open = true;
    const html = renderPage(s, data);
    expect(html).toContain('<details class="pg-collapse" open>');
  });
  it('③ 内部子组件正常渲染（table 行存在）', () => {
    const html = renderPage(schema, data);
    expect(html).toContain('pg-table');
    expect(html).toContain('拜访');
  });
});
```

同时修改 `test/page/renderer.test.js`，在既有 dispatch 用例后追加：

```js
  it('dispatch 支持 kind=collapse', async () => {
    const { renderPage } = await import('../../src/page/renderer.js');
    const html = renderPage(
      { type: 'workspace', title: 't', navigation: { to: '/x' }, layout: { columns: 1 }, components: [
        { kind: 'collapse', title: '区', children: [] } ] },
      { components: {} }
    );
    expect(html).toContain('pg-collapse');
  });
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/page/collapse-renderer.test.js test/page/renderer.test.js`
Expected: `kind='collapse'` 未识别 → 渲染失败/无 pg-collapse 断言 FAIL。

- [ ] **Step 3: schema.js 注册 collapse 类型**

`src/page/schema.js` — COMPONENT_KINDS 数组追加 `'collapse'`（§7 契约：纯布局容器，无 dataBinding 要求）：

```js
export const COMPONENT_KINDS = [
  'metric-card', 'table', 'goal-form', 'result-card', 'reasoning-trace',
  'subtable', 'select', 'attr-field', 'kpi-strip', 'pipeline', 'progress-card',
  'collapse',
];
```

- [ ] **Step 4: renderer.js 实现 renderCollapse + dispatch**

在 `renderer.js` 的 dispatch（switch/if 链）中，`progress-card` 分支之后追加 `collapse` 分支，并新增函数：

```js
// 折叠容器（决策2，docs/2026-08-29-insight-metrics-redesign-completion-plan.md Task1）
// 纯布局容器：无 dataBinding；children 递归走主 render 函数；渲染 <details class="pg-collapse">
function renderCollapse(comp, data, ctx) {
  const body = (comp.children || [])
    .map((c) => ctx.renderComponent(c, data, ctx))
    .join('');
  return `<details class="pg-collapse"${comp.open ? ' open' : ''}>` +
    `<summary>${escapeHtml(comp.title || '明细')}</summary><div class="pg-collapse-body">${body}</div></details>`;
}
```

dispatch 处（renderPage 主循环组件 switch / 组件分派函数）追加：

```js
    if (comp.kind === 'collapse') return renderCollapse(comp, data, ctx);
```

> 注意：`ctx.renderComponent` 或等价主分派函数须由你按现有 renderer.js 实际结构接入（读 `src/page/renderer.js` 的 dispatch 链，把 collapse 分支加在与 kpi-strip/pipeline/progress-card 并列的位置，使 `children` 内组件能拿到 `data.components`）。

- [ ] **Step 5: 运行测试，确认通过**

Run: `node node_modules/vitest/vitest.mjs run test/page/collapse-renderer.test.js test/page/renderer.test.js`
Expected: ①②③ + dispatch case 全 PASS。

- [ ] **Step 6: 提交**

```bash
git add src/page/schema.js src/page/renderer.js test/page/collapse-renderer.test.js test/page/renderer.test.js
git commit -m "feat(renderer): collapse 折叠容器（决策2）+ COMPONENT_KINDS 注册"
```

---

## Task 2 — S35 明细段折叠 + 布局 skin 声明（决策1乙+决策2）

**Files:**
- Modify: `src/pages/S35.schema.js`
- Modify: `test/s35-schema.test.js`

- [ ] **Step 1: 写失败测试（S35 折叠 + skin）**

在 `test/s35-schema.test.js` 现有用例后追加：

```js
  it('明细三组包进 collapse（决策2 折叠）', () => {
    const { schema } = await import('../../src/pages/S35.schema.js');
    const collapses = schema.components.filter(c => c.kind === 'collapse');
    expect(collapses.length).toBeGreaterThanOrEqual(1);
    const titles = collapses.flatMap(c => (c.children || []).map(x => x.title));
    expect(titles).toContain('时间线');
    expect(titles).toContain('任务线');
    expect(titles).toContain('决策链');
  });
  it('布局声明 skin=insight（决策1乙 浅色皮肤作用域标识）', async () => {
    const { schema } = await import('../../src/pages/S35.schema.js');
    expect(schema.layout.skin).toBe('insight');
  });
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/s35-schema.test.js`
Expected: 两个新用例 FAIL（当前无 collapse、无 skin）。

- [ ] **Step 3: 改造 S35.schema.js**

把 §6 的「明细（下区，保留不折叠）」三组（时间线/任务线/决策链三个 table）整体包进一个 `collapse` 组件，并在 layout 增加 `skin:'insight'`：

```js
export const schema = {
  type: 'workspace',
  title: '客户洞察',
  navigation: { to: '/accounts/:id/insight' },
  // 决策1乙：浅色皮肤仅在洞察页作用域生效（page.css 用 [data-skin="insight"] 局部变量）
  layout: { columns: 1, theme: 'light', skin: 'insight' },
  components: [
    // ── ① 交易金额四联 ──（保留原状）
    // ── ② L2C 六段管道 ──（保留原状）
    // ── ③ 进度卡×2 ──（保留原状）
    // ── ④ 过程活跃度 ──（保留原状）
    // ── ⑤ 决策与风险 ──（保留原状）
    {
      // 决策2：明细三组折叠（默认收起，首屏让位指标区）
      kind: 'collapse', title: '明细（时间线 / 任务线 / 决策链）', open: false,
      children: [
        { kind: 'result-card', title: '客户时间线', dataBinding: ACC },
        {
          kind: 'table', title: '时间线',
          dataBinding: { ...ACC, columns: ['ts', 'type', 'title', 'source', 'actor'] },
          columns: ['ts', 'type', 'title', 'source', 'actor'],
        },
        { kind: 'result-card', title: '客户任务线', dataBinding: ACC },
        {
          kind: 'table', title: '任务线',
          dataBinding: { ...ACC, columns: ['task', 'status', 'due', 'actor'] },
          columns: ['task', 'status', 'due', 'actor'],
        },
        { kind: 'result-card', title: '决策链与先例', dataBinding: ACC },
        {
          kind: 'table', title: '决策链',
          dataBinding: { ...ACC, columns: ['decision', 'scenario', 'state', 'precedent'] },
          columns: ['decision', 'scenario', 'state', 'precedent'],
        },
      ],
    },
    { kind: 'attr-field', attrSlug: 'biz', attrType: 'text', label: '客户工商信息', perm: 'biz_info',
      attr: { data_origin: 'external', sourcedFrom: { source: '工商', relation_confidence: 0.92 } } },
    { kind: 'reasoning-trace', title: 'AI 洞察', steps: [...原样...], dataBinding: ACC },
  ],
};
```

> 上述 `...原样...` 处保留 S35.schema.js 现有 AI 洞察 steps 原内容（核对 `src/pages/S35.schema.js:120-127`）。`ACC` 常量保留原定义。

- [ ] **Step 4: 运行测试，确认通过**

Run: `node node_modules/vitest/vitest.mjs run test/s35-schema.test.js`
Expected: 新用例 + 既有用例全 PASS（schema 仍通过 `validatePageSchema`）。

- [ ] **Step 5: 提交**

```bash
git add src/pages/S35.schema.js test/s35-schema.test.js
git commit -m "feat(S35): 明细段折叠（决策2）+ layout.skin=insight（决策1乙）"
```

---

## Task 3 — page.css 浅色皮肤变量层（决策1乙）

**Files:**
- Modify: `src/web/page.css`
- Create: `test/page/insight-skin.test.js`

- [ ] **Step 1: 写失败测试（浅色皮肤契约）**

新建 `test/page/insight-skin.test.js`：

```js
// test/page/insight-skin.test.js — 决策1乙：洞察页浅色皮肤局部变量层契约
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CSS = readFileSync(fileURLToPath(new URL('../../src/web/page.css', import.meta.url)), 'utf8');

describe('page.css 洞察页浅色皮肤（决策1乙）', () => {
  it('① 存在 [data-skin="insight"] 作用域 + 浅色局部变量', () => {
    expect(CSS).toContain('[data-skin="insight"]');
    expect(CSS).toMatch(/--pg-bg:\s*#f7f8fb/);
    expect(CSS).toMatch(/--pg-panel:\s*#fff/);
    expect(CSS).toMatch(/--pg-ink:\s*#0f172a/);
  });
  it('② 新组件类在浅色作用域内被重定义（pg-kpi/pg-pipeline/pg-stage/pg-bar）', () => {
    expect(CSS).toMatch(/\[data-skin="insight"\]\s*\.pg-kpi/);
    expect(CSS).toMatch(/\.pg-stage/);
    expect(CSS).toMatch(/\.pg-bar/);
  });
  it('③ 不新增全局色板（浅色变量仅在作用域内，不污染门户其余页面）', () => {
    // 浅色变量名必须出现在 [data-skin="insight"] 块内；全局段不得出现 --pg-ink
    const globalPart = CSS.split('[data-skin="insight"]')[0];
    expect(globalPart).not.toMatch(/--pg-ink/);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/page/insight-skin.test.js`
Expected: ① ② FAIL（page.css 无浅色层）。

- [ ] **Step 3: 在 page.css 追加浅色皮肤层**

在 `page.css` 末尾追加（对齐 `portal-stage3-mockup.html:8-12` 的浅色观感，仅作用于洞察页容器）：

```css
/* ── 决策1乙：客户洞察页浅色皮肤（作用域局部，不污染门户其余深色页面）──
   S35 schema layout.skin='insight' → renderer 在 .pg-page 上输出 data-skin="insight" */
.pg-page[data-skin="insight"] {
  --pg-bg:#f7f8fb; --pg-panel:#fff; --pg-ink:#0f172a; --pg-mut:#64748b; --pg-line:#e2e8f0;
  --pg-ac:#4f46e5; --pg-ok:#10b981; --pg-warn:#f59e0b; --pg-err:#ef4444;
  background:var(--pg-bg); color:var(--pg-ink);
}
.pg-page[data-skin="insight"] .pg-kpi { background:var(--pg-panel); border:1px solid var(--pg-line); }
.pg-page[data-skin="insight"] .pg-kpi-value { color:var(--pg-ink); }
.pg-page[data-skin="insight"] .pg-kpi-unit { color:var(--pg-mut); }
.pg-page[data-skin="insight"] .pg-kpi[data-state="good"] .pg-kpi-value { color:var(--pg-ok); }
.pg-page[data-skin="insight"] .pg-kpi[data-state="warn"] .pg-kpi-value { color:var(--pg-warn); }
.pg-page[data-skin="insight"] .pg-kpi[data-state="bad"] .pg-kpi-value { color:var(--pg-err); }
.pg-page[data-skin="insight"] .pg-pipeline { background:var(--pg-panel); border:1px solid var(--pg-line); border-radius:12px; }
.pg-page[data-skin="insight"] .pg-stage-n { color:var(--pg-ink); }
.pg-page[data-skin="insight"] .pg-stage-conv { color:var(--pg-mut); }
.pg-page[data-skin="insight"] .pg-bar { background:var(--pg-line); }
.pg-page[data-skin="insight"] .pg-bar > i { background:var(--pg-ac); }
.pg-page[data-skin="insight"] .pg-progress-card { background:var(--pg-panel); border:1px solid var(--pg-line); }
```

同时在 `src/page/renderer.js` 的 renderPage 顶层输出容器 `.pg-page` 处，若 schema.layout.skin 存在则输出 `data-skin="insight"`：

```js
// renderPage 顶层容器（读现有实现，把 layout=... 输出处补上 data-skin）
const skinAttr = schema?.layout?.skin ? ` data-skin="${escapeHtml(schema.layout.skin)}"` : '';
// 例如：`<div class="pg-page"${skinAttr}>...</div>`
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `node node_modules/vitest/vitest.mjs run test/page/insight-skin.test.js test/page/renderer.test.js test/page/collapse-renderer.test.js`
Expected: ①②③ PASS；renderer/collapse 无回归。

- [ ] **Step 5: 提交**

```bash
git add src/web/page.css src/page/renderer.js test/page/insight-skin.test.js
git commit -m "feat(page): 洞察页浅色皮肤作用域变量层（决策1乙）+ data-skin 输出"
```

---

## Task 4 — scoring.js 新增 pipelineMetrics（T9）

**Files:**
- Modify: `src/portal/scoring.js`
- Create: `test/portal/scoring.test.js`

- [ ] **Step 1: 写失败测试（pipelineMetrics 纯函数）**

新建 `test/portal/scoring.test.js`：

```js
// test/portal/scoring.test.js — scoring.js pipelineMetrics（设计 §5.5）
import { describe, it, expect } from 'vitest';
import { pipelineMetrics, pipelineStages } from '../../src/portal/scoring.js';

const mk = (id, stage, amount, prob, updatedAt) => ({
  id, payload: { name: id, stage, expected_amount: amount, probability: prob },
  updated_at: updatedAt,
});
const DAY = 86400000;
const NOW = Date.now();

describe('pipelineMetrics（LTC 价值流聚合）', () => {
  it('① 六段 count/amount 按 stage 分组（lead/opportunity/quoted/contracted/ordered/paid）', () => {
    const deals = [
      mk('d1', 'lead', 100000, 0.3), mk('d2', 'lead', 200000, 0.4),
      mk('d3', 'opportunity', 300000, 0.5), mk('d4', 'quoted', 400000, 0.6),
      mk('d5', 'paid', 500000, 1.0),
    ];
    const m = pipelineMetrics(deals);
    expect(m.stages.map(s => s.key)).toEqual(['lead', 'opportunity', 'quoted', 'contracted', 'ordered', 'paid']);
    const lead = m.stages.find(s => s.key === 'lead');
    expect(lead.count).toBe(2);
    expect(lead.amount).toBe(300000);
    const paid = m.stages.find(s => s.key === 'paid');
    expect(paid.count).toBe(1);
    expect(paid.amount).toBe(500000);
  });
  it('② 段间转化率 = 后段/count 前段 ×100（前段 0 → null）', () => {
    const deals = [ mk('d1', 'lead', 0, 0.5), mk('d2', 'opportunity', 0, 0.5), mk('d3', 'paid', 0, 1) ];
    const m = pipelineMetrics(deals);
    expect(m.stages[1].count / m.stages[0].count).toBe(1);   // 100% 转化（1/1）
    expect(m.conversions[1]).toBe(0);                        // quoted 0/opportunity 1 → 0
    const empty = pipelineMetrics([]);
    expect(empty.conversions[0]).toBeNull();                 // 空数组前段 0 → null
  });
  it('③ 管道总览四联：总数/总金额/加权预测/加权赢率（按金额加权）', () => {
    const deals = [
      mk('d1', 'lead', 100000, 0.3), mk('d2', 'opportunity', 300000, 0.8), mk('d3', 'quoted', 200000, 0.5),
      mk('d4', 'lost', 50000, 0.2),                             // 排除
    ];
    const m = pipelineMetrics(deals);
    expect(m.overview.inPipelineCount).toBe(3);
    expect(m.overview.totalAmount).toBe(600000);
    expect(m.overview.weightedForecast).toBe(100000*0.3 + 300000*0.8 + 200000*0.5);
    expect(m.overview.weightedWinRate).toBeCloseTo((100000*0.3 + 300000*0.8 + 200000*0.5) / 600000 * 100, 5);
  });
  it('④ 赢单率 = paid/(paid+lost+disqualified)；分母 0 → null', () => {
    const m1 = pipelineMetrics([ mk('a','paid',0,1), mk('b','lost',0,0.2) ]);
    expect(m1.overview.winRate).toBe(50);
    const m2 = pipelineMetrics([ mk('c','lost',0,0.2) ]);
    expect(m2.overview.winRate).toBe(0);
    const m3 = pipelineMetrics([]);
    expect(m3.overview.winRate).toBeNull();
  });
  it('⑤ 停滞判定（>7 天）与平均金额；空 inPipeline → null 不显示 0', () => {
    const stale = mk('s1', 'lead', 100000, 0.5, new Date(NOW - 8 * DAY).toISOString());
    const fresh = mk('s2', 'lead', 200000, 0.5, new Date(NOW - 1 * DAY).toISOString());
    const m = pipelineMetrics([stale, fresh]);
    expect(m.overview.staleCount).toBe(1);
    expect(m.overview.staleAmountPct).toBeCloseTo(100000 / 300000 * 100, 5);
    expect(m.overview.avgDealAmount).toBe(150000);
    expect(pipelineMetrics([]).overview.avgDealAmount).toBeNull();
  });
  it('⑥ 缺 probability → 默认 0.5（对齐 scoring.js:7）', () => {
    const p = { id: 'p1', payload: { name: 'p1', stage: 'lead', expected_amount: 1000 } };
    const m = pipelineMetrics([p]);
    expect(m.overview.weightedForecast).toBe(500);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/portal/scoring.test.js`
Expected: `pipelineMetrics` not defined → FAIL。

- [ ] **Step 3: 实现 pipelineMetrics（scoring.js 末尾追加）**

```js
// LTC 价值流聚合（docs/2026-08-28-customer-insight-metrics-redesign.md §5.5）
// 口径：inPipeline = stage ∉ LOST_STAGES；amount = expected_amount ?? 0；prob = probability ?? 0.5（对齐 L7）
export function pipelineMetrics(deals = []) {
  const list = deals || [];
  const now = Date.now();
  const inPipe = list.filter(d => !LOST_STAGES.includes(dealStageOf(d)));
  const amountOf = (d) => Number(d?.payload?.expected_amount ?? d?.payload?.amount ?? 0) || 0;
  const probOf = (d) => Number(d?.payload?.probability ?? 0.5);

  // 六段（stage 顺序 = scoring.js pipelineStages 既有定义：lead/opportunity/quoted/contracted/ordered/paid）
  const stages = pipelineStages.map(st => {
    const items = inPipe.filter(d => dealStageOf(d) === st.key);
    const amount = items.length ? items.reduce((s, d) => s + amountOf(d), 0) : null;
    return { key: st.key, name: st.title, count: items.length, amount };
  });
  // 段间转化率（后段 count / 前段 count ×100，前段 0 → null）
  const conversions = stages.slice(1).map((s, i) => {
    const prev = stages[i].count;
    return prev > 0 ? Math.round((s.count / prev) * 100) : null;
  });

  // 管道总览四联
  const totalAmount = inPipe.reduce((s, d) => s + amountOf(d), 0);
  const weighted = inPipe.reduce((s, d) => s + amountOf(d) * probOf(d), 0);
  const inPipelineCount = inPipe.length;
  const weightedWinRate = totalAmount > 0 ? Math.round((weighted / totalAmount) * 1000) / 10 : null;

  // 健康与风险
  const staleItems = inPipe.filter(d => {
    const u = d.updated_at ? Date.parse(d.updated_at) : NaN;
    return Number.isFinite(u) && (now - u) > 7 * 86400000;   // >7 天（对齐 pipeline.html isStale 阈值）
  });
  const staleCount = staleItems.length;
  const staleAmountPct = totalAmount > 0 ? Math.round((staleItems.reduce((s, d) => s + amountOf(d), 0) / totalAmount) * 1000) / 10 : null;
  const paidCount = stages.find(s => s.key === 'paid')?.count || 0;
  const lostCount = list.filter(d => LOST_STAGES.includes(dealStageOf(d))).length;
  const winRate = (paidCount + lostCount) > 0 ? Math.round((paidCount / (paidCount + lostCount)) * 100) : null;
  const avgDealAmount = inPipelineCount > 0 ? Math.round(totalAmount / inPipelineCount) : null;

  return {
    stages,
    conversions,
    overview: {
      inPipelineCount, totalAmount, weightedForecast: Math.round(weighted), weightedWinRate,
      staleCount, staleAmountPct, winRate, avgDealAmount,
    },
  };
}
```

> 依赖检查：使用既有导出 `pipelineStages`、`LOST_STAGES`、`dealStageOf`（scoring.js:33-42），**同文件内直接引用即可**。

- [ ] **Step 4: 运行测试，确认通过**

Run: `node node_modules/vitest/vitest.mjs run test/portal/scoring.test.js`
Expected: ①～⑥ 全 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/portal/scoring.js test/portal/scoring.test.js
git commit -m "feat(scoring): pipelineMetrics 纯函数（LTC 六段+总览四联+健康风险）T9"
```

---

## Task 5 — pipeline.html LTC 价值流 + 最小鉴权（T10 + 决策3乙）

**Files:**
- Modify: `src/web/pipeline.html`

- [ ] **Step 1: 引 page.css + 顶部指标区**

`<head>` 中追加（在 tokens/common 之后）：

```html
<link rel="stylesheet" href="/portal/page.css">
```

`<main class="main">` 顶部插入指标区容器：

```html
<main class="main">
  <div id="kpi-overview" class="pipeline-kpis"></div>
  <div id="l2c-pipeline" class="pipeline-l2c"></div>
  <div class="cols" id="cols"></div>
  <div class="detail" id="detail"><div id="detailBody"></div></div>
</main>
```

- [ ] **Step 2: 列表读取改 api() + role 金额守卫（决策3乙）**

在 `<script type="module">` 中：

1. `import { get, post, put } from '/portal/api.js';` 行追加用 `get`：
```js
import { get, post, put } from '/portal/api.js';
```

2. 替换 `load()`（第 90-97 行）为带 token 的 `api()` 读取 + role 鉴权：

```js
  const gated = { payment_amount: { sales: true }, cost: { sales: true } }; // 最小修复：sales 隐藏金额
  let role = null;
  async function ensureRole() {
    if (role) return role;
    try { const me = await get('/api/auth/me'); role = me?.role || null; }
    catch (e) { role = null; }
    return role;
  }
  async function load() {
    try {
      const r = await get('/api/particles?type=CRM_DEAL');   // api() 自动带 Bearer（决策3乙）
      all = r.items || [];
      await ensureRole();
      render();
    } catch (e) { document.getElementById('cols').innerHTML = '<div class="empty">加载失败：' + esc(e.message) + '</div>'; }
  }
```

3. 卡片金额渲染加权限守卫（`render()` 内 L126-128 处）：

```js
        const showAmt = !(role === 'sales');   // sales 不显示金额（payment_amount 类字段最小守卫）
        const amtRaw = showAmt ? (p.payload?.expected_amount ?? p.payload?.amount) : undefined;
        const amtTxt = (amtRaw === undefined || amtRaw === null || amtRaw === '')
          ? '' : '¥' + Number(amtRaw).toLocaleString('zh-CN');
```

- [ ] **Step 3: 顶部指标渲染（pipelineMetrics 消费）**

在 `load()` 末尾的 `render()` 之后补指标渲染函数，并在 `render()` 内调用：

```js
  import { pipelineMetrics } from '/portal/scoring.js';

  function renderKpis() {
    const kpiBox = document.getElementById('kpi-overview');
    const l2cBox = document.getElementById('l2c-pipeline');
    if (!kpiBox || !l2cBox) return;
    const m = pipelineMetrics(all);   // 全量商机（含 lost/disqualified 用于赢单率）
    const ov = m.overview;
    const fmt = (n) => (n === null || n === undefined ? '—' : '¥' + Number(n).toLocaleString('zh-CN'));
    const pct = (n) => (n === null || n === undefined ? '—' : n.toFixed(1) + '%');
    const showAmt = !(role === 'sales');
    kpiBox.innerHTML = `<div class="pg-kpi-strip">` +
      `<div class="pg-kpi"><div class="pg-kpi-label">在管道商机数</div><div class="pg-kpi-value">${ov.inPipelineCount}</div></div>` +
      `<div class="pg-kpi"><div class="pg-kpi-label">管道总金额</div><div class="pg-kpi-value">${showAmt ? fmt(ov.totalAmount) : '🔒'}</div></div>` +
      `<div class="pg-kpi"><div class="pg-kpi-label">加权预测金额</div><div class="pg-kpi-value">${showAmt ? fmt(ov.weightedForecast) : '🔒'}</div></div>` +
      `<div class="pg-kpi"><div class="pg-kpi-label">加权赢率</div><div class="pg-kpi-value">${pct(ov.weightedWinRate)}</div></div>` +
      `<div class="pg-kpi" data-state="warn"><div class="pg-kpi-label">停滞商机</div><div class="pg-kpi-value">${ov.staleCount}</div><div class="pg-kpi-hint">${showAmt ? pct(ov.staleAmountPct) : '🔒'}</div></div>` +
      `<div class="pg-kpi" data-state="${ov.winRate === null ? 'neutral' : (ov.winRate >= 50 ? 'good' : 'warn')}"><div class="pg-kpi-label">赢单率</div><div class="pg-kpi-value">${pct(ov.winRate)}</div></div>` +
      `</div>`;
    l2cBox.innerHTML = `<div class="pg-pipeline">` +
      m.stages.map((s, i) => {
        const conv = i < m.conversions.length ? `<span class="pg-stage-conv">→ ${pct(m.conversions[i])}</span>` : '';
        return `<div class="pg-stage"><div class="pg-stage-n">${s.count}</div>` +
          `<div class="pg-stage-t">${esc(s.name)}</div>` +
          `<div class="pg-stage-amt">${showAmt ? fmt(s.amount) : '🔒'}</div>${conv}</div>`;
      }).join('') + `</div>`;
  }
```

在 `render()` 函数开头调用 `renderKpis()`（保证 filter 变化时指标区更新）：

```js
  function render() {
    renderKpis();
    const cols = document.getElementById('cols');
    ...
```

- [ ] **Step 4: 列头升级「数量 · 金额」（§5.5-D）**

`render()` 内列头（L120）改为：

```js
      const showAmt = !(role === 'sales');
      const colAmt = g.list.reduce((s, p) => s + (Number(p.payload?.expected_amount ?? p.payload?.amount) || 0), 0);
      col.innerHTML = `<h3>${g.title}<b>${g.list.length}</b>` +
        `${showAmt ? `<span class="pg-col-amt">¥${colAmt.toLocaleString('zh-CN')}</span>` : '<span class="pg-col-amt">🔒</span>'}</h3>`;
```

（`page.css` 已含 `.pg-col-amt` 类，见设计 §8.2 与既有 page.css grep 结果。）

- [ ] **Step 5: 服务端验证**

Run: `node node_modules/vitest/vitest.mjs run test/portal/scoring.test.js`
Expected: 全 PASS（pipelineMetrics 无回归）。

手工冒烟（若 server 运行中）：
```bash
curl -s http://localhost:3000/pipeline.html | grep -c "pg-kpi-strip\|pg-pipeline\|page.css"
```
Expected: ≥3（引了 page.css、顶部指标容器在源码中）。

- [ ] **Step 6: 提交**

```bash
git add src/web/pipeline.html
git commit -m "feat(pipeline): LTC 价值流指标（kpi-strip×1+pipeline+列头金额）+ api() 鉴权与金额守卫（决策3乙）"
```

---

## Task 6 — 全量回归 + 浏览器验证（收尾）

**Files:** 无新增（验证动作）

- [ ] **Step 1: 全量测试，确认无新增回归**

Run: `node node_modules/vitest/vitest.mjs run`
Expected: 本次新增/修改套件（collapse-renderer / s35-schema / insight-skin / portal-scoring / renderer）全绿；与基线对比无新增失败（既有基线失败：migrateConfig skill_registry CANON 断言 + skill-registry-page 测试库 pkey 残留，非本次引入）。

- [ ] **Step 2: 浏览器端到端验证（account-insight 页）**

使用 agent-browser（或手动）：
1. `admin / admin123` 登录 `http://localhost:3000/home.html`；
2. 打开 `/account-insight.html?id=<某客户>`；
3. 断言：
   - 顶部指标区**浅色观感**（白面板 + 深字，与门户其余深色页不同，`.pg-page[data-skin="insight"]` 生效）；
   - 明细区为可折叠 `<details>`（首屏只看到「明细（时间线 / 任务线 / 决策链）」summary，点击展开三表）；
   - 金额权限：admin 可见全部；`sales`(alice) 登录后 `payment_amount` 类指标显示 🔒。

- [ ] **Step 3: 浏览器端到端验证（pipeline.html）**

1. 打开 `/pipeline.html`；
2. 断言：
   - 顶部「在管道商机数/管道总金额/加权预测金额/加权赢率/停滞商机/赢单率」六卡 + LTC 六段管道渲染；
   - 列头显示「数量 · 金额」；
   - admin 可见金额；`alice`(sales) 金额区显示 🔒；
   - 看板交互（筛选 chips / 卡片预览 / 详情跳转 / 新建商机模态）全部保留。

- [ ] **Step 4: 提交（本次计划总收口，可选）**

```bash
git log --oneline -8
```
确认 Task1–Task5 约 5 个 commit 就位；必要时追加一条收口说明 commit。

---

## 自检（writing-plans Self-Review）

1. **Spec 覆盖**：
   - 决策1乙（浅色皮肤）→ Task2（layout.skin）+ Task3（page.css 作用域变量层 + renderer data-skin 输出）✅
   - 决策2折叠 → Task1（collapse 容器）+ Task2（S35 明细三组折叠）✅
   - 决策3乙（最小鉴权）→ Task5 Step2（api() + role 守卫）✅（服务端 `/api/particles` 不加鉴权=丙，不在范围）
   - T9（`pipelineMetrics`）→ Task4 ✅；T10（pipeline.html 改造）→ Task5 ✅；T11（scoring 测试）→ Task4 ✅
   - 设计 §5.5 口径（inPipeline/amount/prob/停滞7天/赢单率/均值）→ Task4 ①-⑥ 逐条覆盖 ✅
   - 设计 §6 权限（permMetrics/permStages/permKey）→ 已在既有落地代码中（insightService.js applyFieldPerms/maskMetricsByPerm），本计划不重复 ✅
2. **占位符扫描**：无 `TBD`/`TODO`；唯一留白处为「S35 的 AI 洞察 steps 原内容保留照抄」（已指向 `src/pages/S35.schema.js:120-127` 原文），Task 各步均有完整代码或既有代码保留指示。
3. **类型一致性**：`pipelineMetrics(deals)` 返回 `{stages, conversions, overview}`；Task4 测试与 Task5 消费 (`.stages/.conversions/.overview`) 一致；`renderKpis()` 使用 `m.stages`/`m.conversions`/`m.overview` 一致；`data-skin` 在 renderer 输出、page.css 作用域、S35 `skin:'insight'` 三者命名一致；`showAmt`/`role` 在 load/ensureRole/render/renderKpis 间作用域一致（Task5 Step2 在 module 顶层声明，Step3/4 复用）。
4. **已知注意**：`src/web/api.js` 的 `get()` 为直接透传后端 JSON（不包裹 ok），`me?.role` 从 `/api/auth/me` 的 `{role, display_name, username}` 取（铁律：勿假设 ok 字段）。