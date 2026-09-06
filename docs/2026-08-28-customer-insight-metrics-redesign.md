# 数字化指标重设计 · 客户洞察页（S35）+ LTC 价值流（pipeline.html）

> 日期：2026-08-28 · 触发：用户反馈「显示很不好不直观，希望看到数字化的指标」，参照 `http://localhost:3000/portal-stage3`；随后追加「LTC 价值流（pipeline.html）也一样」
> 状态：**待批准**（设计闸门，未批准不写实现代码）

---

## §0 结论

两个页面统一做数字化指标改造，共享同一套视觉组件层：

| 页面 | 现状 | 改造后 |
|---|---|---|
| **S35 客户洞察** | 4 张纯表格 + 2 个裸数字卡 | 「指标带 → L2C 管道 → 明细」三段式，四类指标（交易金额四联 / L2C 六段管道 / 过程活跃度 / 决策与风险） |
| **LTC 价值流 `pipeline.html`** | 看板列头只有数量，无聚合指标 | 顶部「管道总览四联 + LTC 六段管道（数量+金额+转化率）+ 健康风险」，列头升级为「数量 · 金额」 |

实现路线采用 **方案 A：扩展受控渲染器** —— 新增 `kpi-strip` / `pipeline` / `progress-card` 三类组件，经 `renderer.js` 渲染、`page.css` 提供样式，`S35.schema.js` 声明式使用。守住「schema → renderPage → HTML 壳」铁律，`applyFieldPerms` 字段级权限与数据范围闸全部复用。

**唯一架构级契约变更**：新增 `aggregate` 数据源分支（理由见 §3.2）。

---

## §1 现状与问题（file:line 证据）

| 问题 | 证据 | 影响 |
|---|---|---|
| **组件类型贫乏**：仅 8 种 kind，无进度条/管道/指标带 | `src/page/schema.js:10` `COMPONENT_KINDS = ['metric-card','table','goal-form','result-card','reasoning-trace','subtable','select','attr-field']` | 无法表达数字化视觉 |
| **metric-card 只能渲染单个裸数字** | `src/page/renderer.js:104-113` `renderMetricCard`：输出 `<span class="pg-value">${val.toFixed(2)}</span>`，无单位/状态色/趋势 | 金额与比率混排，无语义 |
| **S35 主体是 4 张表格** | `src/pages/S35.schema.js`：时间线/任务线/完整交易链/决策链 四组 `table` | 用户需逐行扫读，不直观 |
| **仅 2 个指标卡** | `S35.schema.js` 内 `metric-card` ×2（交易总金额/回款率） | 指标维度严重不足 |
| **管道阶段无计数** | `insightService.js:buildTransactionRows` 只产出明细行 + `totals{contractAmt,paidAmt,rate}` | 看不出卡在 L2C 哪一环 |

### 1.2 LTC 价值流 `pipeline.html`（手写看板页）

| 问题 | 证据 | 影响 |
|---|---|---|
| **列头只有数量，无金额** | `src/web/pipeline.html:120` `col.innerHTML = \`<h3>${g.title}<b>${g.list.length}</b></h3>\`` | 看不出每阶段压了多少钱 |
| **聚合函数只产 count 不产 amount** | `src/portal/scoring.js:45-52` `pipelineCounts()` 返回 `{stage, count}` | 无金额维度可显示 |
| **无顶部聚合指标带** | `pipeline.html:54-68` 仅有 filter chips + 看板 `#cols` + `#detail` | 缺总数/总金额/加权预测/赢率 |
| **无阶段转化率** | 无计算逻辑 | 看不出卡在哪一段 |
| **停滞判定存在但未聚合** | `pipeline.html:100-103` `isStale()`（>7 天）仅用于单卡角标 | 缺「停滞商机数/停滞金额」全局视角 |

**数据源**：`pipeline.html:92` `fetch('/api/particles?type=CRM_DEAL')`；阶段模型 `scoring.js:33-42`：

```js
export const pipelineStages = [
  { key: 'lead', title: '线索' }, { key: 'opportunity', title: '商机' },
  { key: 'quoted', title: '报价' }, { key: 'contracted', title: '合同' },
  { key: 'ordered', title: '订单' }, { key: 'paid', title: '回款' },
];
export const LOST_STAGES = ['lost', 'disqualified'];
export function dealStageOf(p) { return (p && p.payload && p.payload.stage) || 'lead'; }
```

可用字段：`payload.expected_amount`、`payload.probability`（`scoring.js:7` 用 `d.probability ?? 0.5`）、`payload.stage`、`updated_at`、`created_at`。

**对照参照页**：`src/web/portal-stage3-mockup.html` 的视觉语言为
- 大数字计数 `.stage .n{font-size:20px;font-weight:700}`（`:62-64`）
- 维度进度条 `.bar > i{width:X%}` + 数值标签（`:48-52`、`:188-190`）
- L2C 六段管道 `STAGES=['线索','报价','合同','回款','发票','订单']` 逐段计数（`:146`、`:215-219`）
- 卡片栅格 + 柔和阴影 `--radius:14px;--shadow:...`（`:8-11`、`:43-44`）

---

## §2 设计目标与非目标

### 2.1 目标
1. **数字化优先**：经营结果以大数字 + 单位 + 状态色呈现，一眼可读。
2. **管道可视化**：L2C 六段各段数量/金额/转化率，定位卡点。
3. **过程可度量**：互动频次、任务逾期、最近跟进距今天数量化。
4. **风险可预警**：决策例外数、客户健康度分带进度条。
5. **权限不破防**：新增组件同样受 `FIELD_PERMS` 字段级闸门约束。

### 2.2 非目标
- **范围内仅两个页面**：S35 客户洞察 + `pipeline.html` LTC 价值流。其余页面（S01–S34 及其他手写页）保持原样；新增组件与 CSS 对它们可选可用，但不主动改造。
- 不引入前端图表库（保持零依赖，纯 CSS 进度条/管道）。
- 不改 `portal-stage3-mockup.html`（它仍是原型参照）。
- 不把 `pipeline.html` 改造成受控渲染页（理由见 §3.3）。

---

## §3 架构路线

### 3.1 方案取舍

| 方案 | 做法 | 优 | 劣 | 结论 |
|---|---|---|---|---|
| **A 扩展受控渲染器** | 新增 3 类组件 + renderer/CSS/schema 支持 | 守住受控铁律；权限/校验/NL 生成全复用；组件可被其他页面复用 | 改动面最大（7 个文件） | ✅ **采纳** |
| B 前端二次加工 | 在 HTML 壳用 JS 加工渲染后 DOM | 改动最小 | 视觉受限于表格；呈现逻辑散落前端；偏离受控精神 | ✗ |
| C 手写专用页 | 照 stage3 手写独立页 | 视觉最接近、最快 | 破坏受控铁律；权限闸需重复实现 | ✗ |

### 3.2 为什么必须引入 `aggregate` 数据源

`src/page/validator.js:40` 规定：

```js
const db = comp.dataBinding;
if (!db || db.source !== 'particle') { errors.push(`组件[${i}] 数据源非粒子`); continue; }
```

且 `validator.js:42` 要求 `db.particleType` ∈ `PARTICLE_TYPES_ENUM`（**单值**）。

而新指标组件是**跨粒子聚合产物**：
- 交易金额四联 = CRM_CONTRACT + CRM_PAYMENT_RECORD
- L2C 管道 = CRM_DEAL + CRM_QUOTATION + CRM_CONTRACT + CRM_ORDER + CRM_PAYMENT_RECORD + CRM_INVOICE（6 类）

单一 `particleType` 无法诚实表达。故新增 `source:'aggregate'` 分支：
- 允许 `sources: [<particleType>...]`（数组，声明聚合所依赖的粒子类型，值域仍受 `PARTICLE_TYPES_ENUM` 约束）
- 必填 `metrics: [{key, agg, label, unit}]`，显式声明消费的聚合键
- 复用既有③（快照字段仅 latest）与④（Action 白名单）护栏；①（粒子值域）改为对 `sources[]` 逐项校验；②（状态字段）仅在声明了 `filters` 时生效

> 与 `attr-field`（`validator.js:31-38` 元模型豁免）并列，形成三类契约：`particle`（明细/表格） / `aggregate`（派生指标） / 元模型（`attr-field`）。

### 3.3 关键架构判断：双范式共存 → 抽「共享视觉层」而非强行统一

核查发现本项目存在**两种页面范式**，且二者不可互相替代：

| 范式 | 代表 | 特征 | 能否表达看板 |
|---|---|---|---|
| **受控渲染** | `account-insight.html` → `S35.schema.js` → `renderPage` | schema 声明式，校验/权限/NL 生成全链路 | ✗ 无 `kanban` 组件 |
| **手写交互页** | `pipeline.html` | 自有 JS，看板拖拽/模态/筛选/详情抽屉 | ✓ |

**结论**：不把 `pipeline.html` 强行改造成受控渲染页（成本高且表达力不足），而是**抽取共享视觉层**：

```
page.css 新增 .pg-kpi-strip / .pg-kpi / .pg-pipeline / .pg-stage / .pg-progress-card / .pg-bar
        ↑                                    ↑
   S35 经 renderPage 新组件消费        pipeline.html 直接写同套 class 消费
```

- **视觉与交互语义统一**：两页数字卡/管道/进度条观感一致；
- **不破坏既有交互**：看板筛选、模态、预览、详情跳转全部保留；
- **不重复造轮子**：`pipeline.html` 只引 `page.css`（现仅引 `tokens.css`+`common.css`）即可复用。

---

## §4 新增组件契约

### 4.1 `kpi-strip` 大数字指标带

**Schema 声明**
```js
{
  kind: 'kpi-strip',
  title: '交易金额四联',
  dataBinding: {
    source: 'aggregate',
    sources: ['CRM_CONTRACT', 'CRM_PAYMENT_RECORD'],
    metrics: [
      { key: 'contractAmt', agg: 'sum', field: 'amount',      label: '合同总额', unit: '¥' },
      { key: 'paidAmt',     agg: 'sum', field: 'paid_amount', label: '已回款',   unit: '¥' },
      { key: 'unpaidAmt',   agg: 'sum', field: 'amount',      label: '未回款',   unit: '¥' },
      { key: 'payRate',     agg: 'sum', field: 'amount',      label: '回款率',   unit: '%' },
    ],
  },
  permMetrics: { payment_amount: ['paidAmt', 'unpaidAmt', 'payRate'], contract_amount: ['contractAmt'] },
}
```

**数据形状**（`resolveDatum` 按 `kind → title` 索引）
```js
data.components['kpi-strip']['交易金额四联'] = {
  items: [
    { key: 'contractAmt', label: '合同总额', value: 6200000, unit: '¥', state: 'neutral', hint: '4 份合同' },
    { key: 'paidAmt',     label: '已回款',   value: 1650000, unit: '¥', state: 'good',    hint: '' },
    { key: 'unpaidAmt',   label: '未回款',   value: 4550000, unit: '¥', state: 'warn',    hint: '' },
    { key: 'payRate',     label: '回款率',   value: 26.6,    unit: '%', state: 'warn',    hint: '' },
  ],
};
```

**渲染输出**
```html
<div class="pg-kpi-strip">
  <div class="pg-kpi" data-state="good">
    <div class="pg-kpi-label">已回款</div>
    <div class="pg-kpi-value">1,650,000<span class="pg-kpi-unit">¥</span></div>
    <div class="pg-kpi-hint">…</div>
  </div>
  …
</div>
```

### 4.2 `pipeline` L2C 六段管道

**Schema 声明**：`source:'aggregate'`，`sources` 含 6 类粒子，`stages` 声明六段顺序与粒子映射（顺序即 L2C 主线，非数据字段）。

**数据形状**
```js
data.components['pipeline']['L2C 六段管道'] = {
  stages: [
    { key: 'lead',    name: '线索', count: 5, amount: 3200000, unit: '¥' },
    { key: 'quote',   name: '报价', count: 4, amount: 243000,  unit: '¥' },
    { key: 'contract',name: '合同', count: 4, amount: 6200000, unit: '¥' },
    { key: 'order',   name: '订单', count: 4, amount: 1610000, unit: '¥' },
    { key: 'payment', name: '回款', count: 4, amount: 1650000, unit: '¥' },
    { key: 'invoice', name: '发票', count: 4, amount: 1610000, unit: '¥' },
  ],
  conversions: [80, 100, 100, 100, 100],   // 后段/前段 ×100，长度 = stages-1
};
```

**渲染**：每段 `<div class="pg-stage">` 含大数字 count、金额、段名；段间 `→` 与转化率徽标。

### 4.3 `progress-card` 进度条卡

**数据形状**：`{ percent, value, total, label, state }`
**渲染**：`<div class="pg-progress-card"><div class="pg-progress-head">…</div><div class="pg-bar"><i style="width:X%"></i></div></div>`

用于：**回款进度**（已回款/合同总额）、**客户健康度**（0–100 分）。

---

## §5 指标计算口径（§5.1–5.4 客户洞察 · §5.5 LTC 价值流）

数据均取自 `insightService.js` 已加载的 `related` 粒子、`timelineSources`、`tasks`、`decisions`，**不新增 DB 查询**（除 §5.3 最近跟进天数可复用 events 最新 ts）。

### 5.1 交易金额四联

| 指标 | 口径 | 权限键 |
|---|---|---|
| 合同总额 | `Σ CRM_CONTRACT.payload.amount` | `contract_amount` |
| 已回款 | `Σ CRM_PAYMENT_RECORD.payload.paid_amount`（status='received'） | `payment_amount` |
| 未回款 | 合同总额 − 已回款 | `payment_amount` |
| 回款率 | 已回款 / 合同总额 × 100（合同总额为 0 → 0） | `payment_amount` |

### 5.2 L2C 六段管道

| 段 | 粒子 | count | amount 字段 |
|---|---|---|---|
| 线索 | CRM_DEAL（stage='lead'） | 条数 | `expected_amount` |
| 报价 | CRM_QUOTATION | 条数 | `amount` |
| 合同 | CRM_CONTRACT | 条数 | `amount` |
| 订单 | CRM_ORDER | 条数 | `amount` |
| 回款 | CRM_PAYMENT_RECORD | 条数 | `paid_amount` |
| 发票 | CRM_INVOICE | 条数 | `amount` |

转化率 `conversions[i] = stages[i+1].count / stages[i].count × 100`（前段为 0 → 0）。

### 5.3 过程活跃度

| 指标 | 口径 |
|---|---|
| 互动次数 | `timelineSources` 中 `type='event'` 条数 |
| 30 天互动 | 同上且 ts ≥ now−30d |
| 任务总数 / 逾期数 | `tasks.length` / `tasks` 中 `due < today` 条数（`due` 为空不算逾期） |
| 最近跟进距今 | `floor((now − max(event.ts)) / 86400000)` 天 |

**边界**：无任何 event 时，互动次数 = 0、30 天互动 = 0、最近跟进距今 = `null`，该 KPI 渲染 `—`（`data-state="partial"`），**不显示 0 天**以免误导为「今天刚跟进」。

### 5.4 决策与风险

| 指标 | 口径 |
|---|---|
| 决策总数 | `decisions.length` |
| 例外数 | `decisions` 中 `disposition === 'EXCEPTION'` 条数 |
| 例外率 | 例外数 / 决策总数 × 100 |
| 客户健康度 | `0.3×回款率 + 0.3×活跃度分 + 0.2×(100−例外率) + 0.2×无逾期分`，归一 0–100 |

- 活跃度分 = `clamp(30天互动 / 5 × 100)`
- 无逾期分 = `逾期数 === 0 ? 100 : clamp(100 − 逾期数×25)`
- 回款率分 = clamp(回款率)（0–100）

**边界**：
- 决策总数 = 0 → 例外率记 0，且健康度按 `0.45×回款率分 + 0.45×活跃度分 + 0.1×无逾期分` 重新归一（决策维度因无样本而剔除，不以 0 分拉低总分）。
- 合同总额 = 0 → 回款率分记 0（无合同即无回款业绩），不触发除零。
- 客户健康度最终 `round` 到整数，`state` 分档：`≥70 good` / `40–69 warn` / `<40 bad`。

### 5.5 LTC 价值流指标（`pipeline.html`）

**口径前提**：`inPipeline` = `stage ∉ LOST_STAGES`（即排除 lost/disqualified）；`amount = payload.expected_amount ?? 0`；`prob = payload.probability ?? 0.5`（对齐 `scoring.js:7`）。

#### A. 管道总览四联（`kpi-strip`）

| 指标 | 口径 |
|---|---|
| 在管道商机数 | `count(inPipeline)` |
| 管道总金额 | `Σ amount` over `inPipeline` |
| 加权预测金额 | `Σ (amount × prob)` over `inPipeline` |
| 加权赢率 | `Σ(amount×prob) / Σ(amount) × 100`（**按金额加权**，避免小额高概率单拉高均值） |

#### B. LTC 六段管道（`pipeline`）

六段（lead/opportunity/quoted/contracted/ordered/paid）各输出 `{ count, amount }`，段间转化率 `后段.count / 前段.count × 100`。

> 注：与 S35 的 L2C 管道**复用同一组件**，但数据源不同——S35 是单客户的 6 类粒子聚合，此处是全量 CRM_DEAL 按 `payload.stage` 分组。

#### C. 健康与风险（`kpi-strip`）

| 指标 | 口径 |
|---|---|
| 停滞商机数 | `count(inPipeline && (now − updated_at) > 7d)`（复用 `pipeline.html:100-103` `isStale` 阈值） |
| 停滞金额占比 | `Σ 停滞商机 amount / 管道总金额 × 100` |
| 赢单率 | `paid 段数 / (paid 段数 + lost/disqualified 段数) × 100` |
| 平均商机金额 | `管道总金额 / 在管道商机数` |

#### D. 看板列头升级

`pipeline.html:120` 由 `<h3>${g.title}<b>${g.list.length}</b></h3>` 改为 **「数量 · 金额」**：

```html
<h3>线索 <b>5</b><span class="pg-col-amt">¥3.2M</span></h3>
```

**边界**：`inPipeline` 为空 → 总金额/加权/均值均显示 `—`（`data-state="partial"`），**不显示 0**；赢单率分母为 0 → 显示 `—`。

#### E. ⚠️ 既有权限缺口（本设计附带暴露，需决策是否一并修复）

`pipeline.html:92` 为**裸 fetch、未带 token**：

```js
const r = await fetch('/api/particles?type=CRM_DEAL');   // 无 authorization 头
```

且 `routes.js:131` 的 `/api/particles` **无鉴权中间件**。后果：任何访客可拉取全量商机，且金额不受 `FIELD_PERMS` 约束（sales 本应隐藏 `payment_amount` 类字段）。

> 本设计**默认不在本次修复**（避免扩大改动面），但新增的指标带若展示金额会放大该缺口。故列为 §11 决策 3。

> 健康度权重为**首版启发式**，后续可由 `method-*` SKILL 或治理配置覆盖（不硬编码于 SKILL，符 10 大能力不污染纪律）。

---

## §6 权限处理

复用 `insightService.js:applyFieldPerms(schema, role)`，扩展以支持新组件：

| 组件 | 新增 schema 字段 | 行为 |
|---|---|---|
| `kpi-strip` | `permMetrics: { <FIELD_PERMS键>: [<metricKey>...] }` | 角色 perm=`hidden` → 该 item 替换为 `{ state:'hidden' }`，渲染 🔒「字段对当前角色隐藏」 |
| `pipeline` | `permStages: { contract_amount: ['contract'], payment_amount: ['payment'] }` | 隐藏段仅显示 count，金额显示 🔒 |
| `progress-card` | `permKey: 'payment_amount'` | 隐藏时整卡替换为 🔒 占位 |

`FIELD_PERMS` 现有键：`payment_amount / cost / contract_amount / biz_info`（`insightService.js` 顶部常量），新组件直接复用，不新增权限维度。

---

## §7 数据契约变更

`src/http/routes.js` `/api/page/account-insight` handler（现 `:638-655`）的 `data.components` 追加：

```js
'kpi-strip': {
  '交易金额四联': { items: [...] },
  '过程活跃度':  { items: [...] },
  '决策与风险':  { items: [...] },
},
pipeline:      { 'L2C 六段管道': { stages: [...], conversions: [...] } },
'progress-card': {
  '回款进度':   { percent, value, total, label: '已回款 / 合同总额', state },
  '客户健康度': { percent, value: score, total: 100, label: '客户健康度', state },
},
```

明细段（时间线/任务线/决策链）**保留为 table**，但压缩列宽并移到下区，避免抢占首屏。

---

## §8 样式体系

### 8.1 ⚠️ 主题冲突（需决策，见 §11）

自查发现**参照页与本站主题相反**：

| 来源 | 主题 | 证据 |
|---|---|---|
| 本站设计 Token（单源） | **深色** | `src/web/tokens.css`：`--bg:#0f172a; --panel:#1e293b; --ink:#e2e8f0; --mut:#cbd5e1` |
| 参照页 `portal-stage3-mockup.html` | **浅色** | 自带 `:root{--bg:#f7f8fb;--panel:#fff;--ink:#0f172a;--muted:#64748b}`（`:8-12`），**未引用 tokens.css** |

即：stage3 是独立原型、自成一套浅色皮肤；而 CRM 门户其余页面（含当前洞察页）走 `tokens.css` 深色皮肤。

**本设计默认取「深色 · 沿用 tokens.css」**（选项 甲），保证与门户其余页面一致；若你明确要 stage3 的浅色观感，则走选项 乙。详见 §11 决策项。

> 自查修正记录：初稿曾引用 `var(--good)/var(--bad)/var(--accent)`，经核对 **`tokens.css` 中并不存在这三个变量**——真实令牌为 `--ok / --err / --ac`。下方样式已全部改用真实令牌，避免样式静默失效。

### 8.2 `src/web/page.css` 新增（现 6655 字节，类前缀 `pg-`）

```css
.pg-kpi-strip { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; }
.pg-kpi { background:var(--panel); border:1px solid var(--line); border-radius:var(--radius-lg); padding:14px 16px; }
.pg-kpi-value { font-size:26px; font-weight:700; color:var(--ink); line-height:1.15; }
.pg-kpi-unit  { font-size:13px; color:var(--mut); margin-left:3px; font-weight:600; }
.pg-kpi[data-state="good"] .pg-kpi-value { color:var(--ok); }
.pg-kpi[data-state="warn"] .pg-kpi-value { color:var(--warn); }
.pg-kpi[data-state="bad"]  .pg-kpi-value { color:var(--err); }
.pg-pipeline { display:flex; align-items:stretch; gap:0; flex-wrap:wrap; }
.pg-stage { flex:1; min-width:96px; text-align:center; padding:12px 6px; position:relative; }
.pg-stage-n { font-size:22px; font-weight:700; }
.pg-stage-conv { font-size:11px; color:var(--mut); }
.pg-bar { height:8px; background:var(--bg); border-radius:5px; overflow:hidden; }
.pg-bar > i { display:block; height:100%; border-radius:5px; background:var(--ac); }
```

**不新增色板**：仅使用 `tokens.css` 既有 `--panel/--line/--ink/--mut/--ok/--err/--warn/--ac/--bg/--radius-lg`。
（选项 乙 若被采纳，则需另加一层浅色皮肤变量——见 §11。）

---

## §9 实施任务与验收

| # | 任务 | 产出 | 验收 |
|---|---|---|---|
| T1 | `schema.js`：COMPONENT_KINDS 加 3 类；新增 `DATA_SOURCES`、`AGGREGATE_STAGES` | 常量导出 | 既有 schema 单测全绿 |
| T2 | `validator.js`：新增 `aggregate` 分支（`sources[]` 值域 + `metrics` 必填 + 复用③④护栏） | 校验分支 | 非法 sources/metrics 被拒；既有用例不受影响 |
| T3 | `renderer.js`：`renderKpiStrip` / `renderPipeline` / `renderProgressCard` + dispatch | 3 个渲染函数 | 单测断言 HTML 结构 |
| T4 | `page.css`：新增 §8 样式 | 样式 | 页面经服务访问可见（非 file://） |
| T5 | `insightService.js`：新增 `buildMetrics(related, timeline, tasks, decisions)`；扩展 `applyFieldPerms` 支持 `permMetrics`/`permStages`/`permKey` | 聚合函数 | 纯函数单测（含权限剔除） |
| T6 | `S35.schema.js`：重排为「kpi-strip×3 → pipeline → progress-card×2 → table×3」 | 新 schema | `validatePageSchema` 通过 |
| T7 | `routes.js`：handler 组装 §7 数据形状 | 数据装配 | 集成测试断言指标出现 |
| T8 | 测试（洞察页侧）：`account-insight-metrics.test.js`（聚合纯函数）、`s35-schema.test.js` 扩充、集成测试扩充 | 3 个测试文件 | 全绿 |
| **T9** | **`scoring.js` 新增 `pipelineMetrics(deals)`**：六段 `{count,amount}`、段间转化率、管道总览四联、停滞/赢单率/均值（口径见 §5.5） | 纯函数 | 单测覆盖含空数组、除零、缺 probability |
| **T10** | **`pipeline.html` 改造**：引 `page.css`；顶部渲染 `pg-kpi-strip`×2（总览四联 + 健康风险）与 `pg-pipeline`（LTC 六段）；列头升级为「数量 · 金额」（§5.5-D） | 页面改造 | 看板交互（筛选/模态/预览/跳转）全部保留；服务下可见 |
| T11 | 测试（LTC 侧）：`scoring.test.js` 扩充 `pipelineMetrics` | 1 个测试文件 | 全绿 |
| T12 | 全量回归 | — | 不新增失败（既有 5 例失败为 interaction-index/migrateConfig/readableConfig，非本任务） |

### 验收口径（对齐项目既有）
- 查询 3-5 分钟 → 3-10 秒；本页为单客户聚合，实测 200 响应。
- 权限：sales 视角隐藏 `payment_amount` 类指标（🔒），finance/admin 可见金额。
- 每 Task 一 commit（**注意：沙箱 `.git` 目录当前缺失，需用户本地提交**）。

---

## §10 风险与权衡

| 风险 | 说明 | 缓解 |
|---|---|---|
| `aggregate` 分支弱化「四护栏」 | 聚合组件不逐条过滤状态字段 | 护栏③（快照 latest）与④（Action 白名单）保留；`sources[]` 仍受粒子值域约束 |
| 健康度分为启发式 | 权重首版硬编码于服务层 | 标注为可配置；后续迁治理配置，不写入 `ai-*` SKILL |
| 数据不足时指标为 0 | 新客户无合同/回款 | 大数字显示 `—`（`data-state="partial"`），不显示误导性 0 |
| 改动面 7 文件 | 回归风险 | T9 全量回归 + 分 Task 提交 |
| 参照页为浅色、本站为深色 | 照搬 stage3 皮肤会与门户其余页面割裂 | §11 决策；默认沿用深色 Token |

---

## §11 待你决策项（批准前需确认）

### 决策 1：主题 —— 深色（沿用本站 Token）还是浅色（照 stage3）？

| 选项 | 做法 | 优 | 劣 |
|---|---|---|---|
| **甲 · 深色沿用 Token（默认推荐）** | 新组件全部用 `tokens.css` 既有变量，与门户其余页面（S01–S34）视觉一致 | 一致性好；零新增色板；改动小 | 与你贴的 stage3 截图浅色观感不同 |
| 乙 · 洞察页套浅色皮肤 | 在 `page.css` 为 `.pg-kpi/.pg-stage/.pg-bar` 加一层浅色局部变量（白面板 + 深字），仅洞察页生效 | 观感最接近 stage3 截图 | 洞察页与门户其余页面割裂；需额外维护一套局部皮肤 |

> 说明：若要全局改为浅色，那是独立的设计体系变更（影响所有页面），不在本次范围。

### 决策 2：明细段（时间线 / 任务线 / 决策链）保留还是折叠？

| 选项 | 做法 |
|---|---|
| **保留在下区（默认）** | 指标带与管道占据首屏，明细表格下移，仍全量可见 |
| 折叠为 `<details>` | 首屏更纯净，明细按需展开 |

### 决策 3：`pipeline.html` 的既有权限缺口是否一并修复？

见 §5.5-E：该页裸 fetch 未带 token，且 `/api/particles` 无鉴权，任何访客可拉全量商机且金额不受 `FIELD_PERMS` 约束。

| 选项 | 做法 | 影响 |
|---|---|---|
| **甲 · 本次不修（默认）** | 仅加指标展示，缺口保持原状 | 改动面最小；但新增金额指标会放大缺口 |
| 乙 · 最小修复 | `pipeline.html` 改用 `api()`（自动带 Bearer）+ 前端按 `/api/auth/me` 的 role 对金额套 `FIELD_PERMS` | +1 文件改动；前端闸不算强边界（服务端仍裸开） |
| 丙 · 服务端收敛 | 给 `/api/particles` 加鉴权 + 服务端按 role 过滤金额字段 | 最正确；但影响所有调用方，回归面大 |

---

## §12 批准与后续

确认后按 §9 的 **T1–T12** 顺序实施（T1–T8 洞察页侧，T9–T11 LTC 侧，T12 全量回归），每 Task 一 commit。

**建议回复格式**：`决策1=甲/乙 · 决策2=保留/折叠 · 决策3=甲/乙/丙`，或「按默认来」——默认即 **甲 / 保留 / 甲**。

⚠️ **提交提醒**：沙箱内 `D:\system\CRM-ai-native\.git` 目录当前缺失（`git status` 报 not a git repository），本次设计文档与后续代码**需你本地提交**。
