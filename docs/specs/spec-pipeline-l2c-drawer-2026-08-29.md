# 设计文档：CRM 销售管道页 — 移除顶部过滤栏 + L2C 数字下钻抽屉清单

- **文档类型**：UI 交互改造（spec）
- **日期**：2026-08-29
- **状态**：待用户批准（HARD-GATE：未批准不写实现代码）
- **方案选型**：A · 抽屉浮层清单（用户 2026-08-29 拍板）

---

## §0 目标与范围

**用户原始诉求**（基于截图与对话）：
1. 去掉管道页「上边一排」的过滤 chip 栏。
2. 点击「下边」L2C 价值流的具体数字，就地展开该阶段的单据清单。
3. 点击清单中某条单据，进入其详情页。

**在管范围**：`src/web/pipeline.html` 单文件改造 + 内联 `<style>` 新增抽屉样式。
**不在范围**：后端 API、路由、其它页面、下方看板（kanban）整体移除（见 §5 决策点）。

---

## §1 当前状态（证据）

| 关注点 | 位置 | 说明 |
|---|---|---|
| 顶部过滤 chip 行 | `pipeline.html:61-70` | `<div class="filter" id="filter">` 含 全部/线索/商机/报价/合同/订单/回款/已流失 |
| chip 点击事件 | `pipeline.html:225-231` | `getElementById('filter').addEventListener` 切换 `filter` 并重渲染 |
| L2C 概览渲染 | `pipeline.html:112-140` | `renderOverview()` 用 `pipelineMetrics(all)` 生成 `l2cPipeline`（六段 count/amount + 段间转化率） |
| 阶段 cell 生成 | `pipeline.html:133-136` | `m.stages.map(s => ... .pg-stage ...)`，`s.key` ∈ {lead,opportunity,quoted,contracted,ordered,paid} |
| 数据源 | `pipeline.html:146-147` | `get('/api/particles?type=CRM_DEAL')` → `all` |
| 阶段判定 | `scoring.js:42` | `dealStageOf(p)` 返回 `p.payload.stage`（缺省 lead） |
| 卡片→详情跳转 | `pipeline.html:193` | `location.href='/deal-detail.html?id='+p.id` |
| 详情页路由 | `routes.js:1661-1663` | `/deal-detail.html` 静态发送；详情页读 `?id`（`deal-detail.html:31-33`） |
| 金额角色掩码 | `pipeline.html:104` | `canSeeAmount()`：sales 角色金额显示 🔒 |

**关键事实**：`pg-stage`/`pg-pipeline` 等类在 `page.css`/`common.css` 中**无显式样式**（grep 无命中），当前靠默认渲染正常显示数字——改造只需新增抽屉专属样式，不影响既有文字呈现。

---

## §2 目标交互（方案 A）

```
[管道页]
  ┌─────────────────────────────────────────┐
  │ （已移除顶部 chip 栏）                      │
  │ ＋新建商机                                  │
  │ ┌── 管道总览 ──┐ ┌── L2C 价值流 ────────┐ │
  │ │ 在管/总额/加权… │ │ [12]线索 [8]商机 … [3]回款 │ │  ← 数字可点击
  │ └────────────┘ └────────────────────┘ │
  │ [下方看板：六列卡片（保持不变）]             │
  └─────────────────────────────────────────┘
        │ 点击某阶段数字（如 [8]商机）
        ▼
  ┌─────────────── 抽屉浮层（右侧滑入）──────────────┐
  │ 商机（8 条）              [✕]                    │
  │ ─────────────────────────────────────────       │
  │ 半导体产线一期    ¥1,200,000   2026-08-25         │
  │ 华东医院信息化    🔒            2026-08-20         │
  │ …（每条=该 stage 的 CRM_DEAL）                    │
  │ ─────────────────────────────────────────       │
  │ 点击任意一行 → /deal-detail.html?id=<id>          │
  └──────────────────────────────────────────────────┘
```

**抽屉特征**（A 方案核心）：
- 从右滑入的浮层（overlay），**不打断** L2C 概览与下方看板。
- 抽屉内只列**被点击阶段**的单据；其余阶段数字仍可见、可再次点击切换。
- 点击清单行 → 跳转 `/deal-detail.html?id=<id>`（复用既有详情页）。
- 点击遮罩或 ✕ 关闭抽屉。

---

## §3 改造清单（精确编辑点）

### 3.1 移除顶部 chip 栏
- 删除 `pipeline.html:61-70`（`<div class="filter" id="filter">…</div>`）。
- 删除 `pipeline.html:225-231`（`filter` 的 `addEventListener` 整段）。
- `filter` 变量（`:98`）保留为 `'all'` 常量即可——`render()` 下方看板逻辑无需变动，恒显示全部阶段。
- 可选清理：`.filter`/`.chip` 的 CSS（`:12-14`）成为死样式，标记待删（不阻塞功能）。

### 3.2 阶段数字可点击
- 改写 `renderOverview()` 的 cell 模板（`pipeline.html:133-136`）：
  ```js
  return `<div class="pg-stage" data-stage="${s.key}" role="button" tabindex="0" title="查看${esc(s.name)}清单">
            <div class="pg-stage-n">${s.count}</div>
            <div class="pg-stage-name">${esc(s.name)}</div>
            <div class="pg-stage-amt">${amt}</div>
          </div>`;
  ```
- 在 `renderOverview()` 末尾或独立绑定：对 `#l2cPipeline` 内 `.pg-stage` 绑定 `click` → `openStageDrawer(s.key)`。
  - 实现方式：渲染后在 `renderOverview` 内 `document.querySelectorAll('#l2cPipeline .pg-stage').forEach(el => el.onclick = () => openStageDrawer(el.dataset.stage))`。

### 3.3 抽屉浮层（HTML + CSS + JS）
- **HTML**：在 `</main>` 之后（或 `<body>` 末尾）新增：
  ```html
  <div class="drawer-backdrop" id="drawerBackdrop" hidden></div>
  <aside class="stage-drawer" id="stageDrawer" aria-hidden="true">
    <header class="drawer-head"><span id="drawerTitle"></span><button id="drawerClose" class="drawer-close">✕</button></header>
    <div class="drawer-body" id="drawerBody"></div>
  </aside>
  ```
- **CSS**（加进 `<style>`，`:9-58` 之后）：`.stage-drawer`（fixed right, width 420px, transform 滑入）、`.drawer-backdrop`（半透明遮罩）、`.drawer-row`（hover 高亮、cursor pointer）、`.pg-stage{cursor:pointer}` + hover 反馈。
- **JS**：
  ```js
  function openStageDrawer(stageKey) {
    const list = all.filter(p => dealStageOf(p) === stageKey);
    const name = (pipelineStages.find(s=>s.key===stageKey)||{}).title || stageKey;
    document.getElementById('drawerTitle').textContent = `${name}（${list.length} 条）`;
    const body = document.getElementById('drawerBody');
    if (!list.length) { body.innerHTML = '<div class="empty">该阶段暂无商机</div>'; }
    else body.innerHTML = list.map(p => {
      const amtRaw = p.payload?.expected_amount ?? p.payload?.amount;
      const amt = !canSeeAmount() ? '🔒' : (amtRaw==null||amtRaw==='' ? '—' : '¥'+Number(amtRaw).toLocaleString('zh-CN'));
      return `<div class="drawer-row" data-id="${esc(p.id)}">
                <div class="dr-name">${esc(p.payload?.name || p.slug || '商机')}</div>
                <div class="dr-meta">${amt} · ${(p.updated_at||'').slice(0,10)}</div>
              </div>`;
    }).join('');
    body.querySelectorAll('.drawer-row').forEach(r => r.onclick = () => { location.href = '/deal-detail.html?id=' + encodeURIComponent(r.dataset.id); });
    document.getElementById('stageDrawer').classList.add('open');
    document.getElementById('drawerBackdrop').hidden = false;
  }
  function closeDrawer(){ document.getElementById('stageDrawer').classList.remove('open'); document.getElementById('drawerBackdrop').hidden = true; }
  document.getElementById('drawerClose').onclick = closeDrawer;
  document.getElementById('drawerBackdrop').onclick = closeDrawer;
  ```

### 3.4 复用既有能力
- 数据源 `all`、阶段判定 `dealStageOf`、金额掩码 `canSeeAmount`、详情页 `/deal-detail.html` —— 全部现有，无新增 API / 路由。
- 因此**无需重启 server**（routes.js 以 `sendFile` 实时读取静态 html；仅改 `.html` 与内联样式）。

---

## §4 验收口径

1. 管道页顶部不再出现过滤 chip 一排。
2. L2C 价值流六个数字均可点击（hover 有指针/高亮反馈）。
3. 点击某数字 → 右侧抽屉滑入，列出该阶段全部 CRM_DEAL（名称/金额/slug/更新日期）。
4. 抽屉内点击任意一行 → 正确跳转到 `/deal-detail.html?id=<该单据id>`，详情页正常加载。
5. 点击遮罩或 ✕ → 抽屉关闭，概览与看板不受影响。
6. 切换点击不同数字 → 抽屉内容随之切换。
7. sales 角色下抽屉金额显示 🔒；其余角色显示真实金额。
8. 0 条阶段的数字点击 → 抽屉显示「该阶段暂无商机」空态，不报错。

---

## §5 待确认决策点（2 项）

1. **下方看板（六列卡片）是否保留？**
   现状下方 `.cols` 看板按阶段分列展示卡片，与抽屉清单在「按阶段列清单」上部分重叠。
   - 默认建议：**保留**（用户仅要求移除顶部 chip + 加数字下钻；看板是更广的全景视图，且改动最小、风险最低）。
   - 备选：移除看板，仅留 L2C 概览 + 抽屉下钻（更聚焦，但改动更大）。

2. **抽屉样式取向**：右侧滑入浮层（true 抽屉，推荐，符合「抽屉浮层」命名）vs 概览下方就地展开区块。默认按右侧滑入实现。

---

## §6 影响与风险

- **范围**：单文件 `pipeline.html`，无后端/路由/DB 变更，无写操作，不触决策第 0 闸。
- **回归**：下方看板渲染逻辑（`render()`）不变；仅移除 chip 事件，看板默认显示全部阶段。
- **可复现**：纯前端交互，浏览器刷新即可验证，无需 server 重启。
- **可回退**：改动集中、可逆，单文件 git 可还原。
