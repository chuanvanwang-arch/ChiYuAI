# 销售管道页 + 前台互通（Lightfield 主轴收口）设计

> 状态：已落地（Task P1–P4 全绿，commit 30e99f4 / 91c8b74 / 0d7988b；**2026-08-27 追加方案 B：L2C 六段与管道页同源，Task L5 完成**）
> 日期：2026-08-26
> 关联：docs/2026-08-26-stage3-portal-home-design.md（v2，Lightfield 主轴）；docs/superpowers/plans/2026-08-26-stage3-portal-home.md（Task A–F）
> 触发：用户提问「线索池/商机为啥没有页面？其它页面没有挂到前台在哪里显示？」

---

## §0 结论

`index.html` 已是 AI 作战室（Lightfield 主轴，未提交），它的侧栏把「线索池/商机/L2C」指向 `/kanban.html`（agent 任务看板）——**那是占位错指**。深层根因不是"没做独立页"，而是**数据契约缺陷**：`/api/business/board` 聚合类型不含 `CRM_DEAL`（routes.js:184），导致 index 的「今日优先/L2C 六段」读 `grouped.CRM_DEAL || []` **恒为空**，再用 `stage:'报价'` 硬编码兜底 → **当前是假数据展示**。

本设计收口三件事（已与用户逐节确认）：

1. **数据契约修正**：board 聚合追加 `CRM_DEAL`；index 今日优先改用真实 `payload.stage`（消除假数据）。
2. **独立销售管道页 `/pipeline.html`**（方案 A3）：六列分列（按 DEAL.stage）+ 内联详情区（不弹抽屉），数据源 `/api/particles?type=CRM_DEAL`。
3. **前台互通**：新建 `src/web/nav.js`（ESM 共享导航，角色自适应 + token 守卫），6 个子页注入，消除死胡同；导航落点修正。

边界（YAGNI）：不动后端审批/代理逻辑；不改造 `kanban.html` 内容；不做移动端适配；不新增 ai-* 能力。

---

## §1 数据契约修正（前置，消除假数据）

### 1.1 现状缺陷（file:line 取证）

- `src/http/routes.js:184`：`/api/business/board` 聚合 `types = ['CRM_QUOTATION','CRM_CONTRACT','CRM_PAYMENT_PLAN','CRM_PAYMENT_RECORD','CRM_INVOICE','CRM_ORDER']` —— **不含 `CRM_DEAL`**。
- `src/web/index.html:133`：`const deals = (grouped.CRM_DEAL || []).map(p => ({ ..., stage:'报价', budget_fit:0.6 }))` —— 恒空 + 硬编码兜底。
- 后果：「今日优先」卡片与「L2C 六段」当前展示的是**假数据**（stage 恒为"报价"、FIT 恒 0.6)。

### 1.2 修法

| 变更 | 位置 | 说明 |
|---|---|---|
| board 追加 DEAL | `routes.js:184` types 数组加 `'CRM_DEAL'` | 一处聚合，pipeline 页与 index 共用 |
| index 今日优先 | `index.html:133` 删除 `stage:'报价'`/`budget_fit:0.6` 硬编码 | 改用 `p.payload?.stage` 真实值；FIT/TIMING 等打分仍走 `scoring.js` |
| L2C 六段计数 | `scoring.js pipelineCounts` | **（方案 B 追加）** 改为按 DEAL.stage 的**商机流**六段，与管道页同源：线索(lead)/商机(opportunity)/报价(quoted)/合同(contracted)/订单(ordered)/回款(paid)；`l2cCounts` 保留为 `pipelineCounts` 别名 |

### 1.3 验收标准

- 今日优先卡片上的 stage 来自 `payload.stage`，而非写死的"报价"。
- `/api/business/board` 返回 `grouped.CRM_DEAL` 非空（假设有种子 DEAL）。

---

## §2 销售管道页 `/pipeline.html`（方案 A3）

### 2.1 定位与语义澄清

| 视图 | 数据口径 | 位置 |
|---|---|---|
| L2C 六段主线 | 按 **DEAL.stage** 分列（商机流）＝ **与管道页同源** | `index.html` 紧凑副区 |
| **销售管道（新）** | 按 **DEAL.stage** 分列（商机流） | **`/pipeline.html`**（新页） |

**（2026-08-27 用户拍板方案 B）两视图同源：** 首页 L2C 六段不再按粒子类型（单据流），改为与管道页一致的 DEAL.stage 商机流六段（线索/商机/报价/合同/订单/回款）。`STAGES`/`byStage` 上移 `src/portal/scoring.js` 共享单源，两页 import 同一份定义，杜绝漂移。

### 2.2 布局（A3：六列分列 + 内联详情区）

```
/pipeline.html
├─ 顶部筛选条：全部 / 线索 / 商机 / 报价 / 合同 / 订单 / 回款 / 已流失
├─ 六列管道（DEAL.flow 映射）：
│   线索(lead) → 商机(opportunity) → 报价(quoted) → 合同(contracted) → 订单(ordered) → 回款(paid)
│   （lost/disqualified 并入「已流失」折叠列，不进管道主线）
├─ 每卡片：名称 + stage 徽标 + updated_at + 未跟进角标（stage_change_reason/why 载体）
└─ 🔍 内联详情区（点击卡片后，页面下方展开，不弹抽屉）：
     ├─ 该 DEAL 的 payload 全部属性（owner / customer / 金额 / 阶段）
     ├─ 决策历史（复用粒子详情/出边数据通道：决策事件、受控边）
     └─ 「怎么切入」CTA → 注入命令栏（与 index 今日优先一致）
```

### 2.3 数据源

- 列表：`GET /api/particles?type=CRM_DEAL`（routes.js:57，返回真实 DEAL 含 `payload.stage`）。
- 详情：复用现有粒子详情通道（`/api/particles/:id` + 出边决策，routes.js:76/82）。
- 与 index 共用 board（§1.2 追加 DEAL 后）。

### 2.4 导航修正

| 导航项 | 现值 | 修正为 |
|---|---|---|
| 🎯 线索池 | `/kanban.html`（占位） | **`/pipeline.html`** |
| 💼 商机 | `/kanban.html`（占位） | **`/pipeline.html`** |
| 📊 L2C 看板 | `/kanban.html` | **`/pipeline.html`** |
| `/kanban.html` 本体 | —（任务看板） | 保留，主导航改「📋 任务执行」项指向它 |

---

## §3 前台互通（共享导航 + token 守卫）

### 3.1 现状核实（非印象）

- ✅ `src/portal/scoring.js` 已存在（今日优先打分 + L2C 聚合单源）
- ✅ `src/http/auth.js` 已存在；`/api/auth/login`(route:149) + `/api/auth/me`(route:154) 已挂
- ✅ `/portal/scoring.js` 路由已挂(route:428)
- ❌ **6 个子页全部 0 处返回/互链**：`workbench.html` / `decision-graph.html` / `sales-decision-monitor.html` / `particle-detail.html` / `meta-attr-drawer.html` / `kanban.html` —— 挂了路由但互不可达

### 3.2 修法：`src/web/nav.js`（ESM 共享导航组件）

- 职责：读取 `/api/auth/me` → 渲染侧栏 7 项（首页 / pipeline / 审批 / 决策网络 / 报告 / 任务看板 / 线索池配置 + 身份 + 退出）；无 token → `/home.html`；`/api/auth/me` 失败 → 清 token 回登录。
- 接入：6 个子页 `<script type="module">import '/portal/nav.js'</script>` 注入 header 区块。
- 复用 index 现有守卫逻辑（index.html:94-103），抽为 nav.js 统一实现，避免每页重复。

### 3.3 导航落点（统一 7 项）

| 项 | 落点 |
|---|---|
| 🏠 首页 | `/` |
| 🎯 线索池 / 💼 商机 / 📊 L2C | `/pipeline.html` |
| ✅ 审批 | `/workbench.html` |
| 🕸 决策网络 | `/decision-graph` |
| 📈 报告 | `/sales-decision-monitor` |
| 📋 任务执行 | `/kanban.html` |
| ⚙ 线索池配置 | index 内 pool 面板（锚点） |
| 退出 | `/home.html`（清 token） |

---

## §4 文件清单

**新建**
- `src/web/pipeline.html` — 销售管道页（六列 + 内联详情区）
- `src/web/nav.js` — 共享导航组件（ESM）

**修改**
- `src/http/routes.js` — ① board types 追加 `CRM_DEAL`(184)；② 新增 `/pipeline.html`、`/pipeline` 路由；③ 新增 `/portal/nav.js` 静态路由
- `src/web/index.html` — ① 今日优先用真实 stage(133)；② 侧栏导航改 `/pipeline.html` + 任务执行项
- 6 个子页（workbench / decision-graph / sales-decision-monitor / particle-detail / meta-attr-drawer / kanban）— 注入 nav.js

**测试**
- `test/portal-pipeline.test.js` — 路由冒烟（`GET /pipeline.html` 含「销售管道」标记）+ board 含 DEAL 断言

---

## §5 风险与对策

| 风险 | 对策 |
|---|---|
| 种子无 DEAL 数据，管道页空 | 空态提示「暂无商机，用命令栏新建」；今日优先展示降级文案 |
| board 追加 DEAL 影响既有调用方 | 只增不减，既有 grouped 键不变，向后兼容 |
| nav.js 注入破坏子页既有布局 | 注入点为统一 header 区块（页面顶部），样式隔离 |
| token 守卫与现有 index 逻辑重复 | 抽 nav.js 统一，index 改 import，消除重复 |

---

## §6 测试与验收

- `test/portal-pipeline.test.js`：`GET /pipeline.html` 200 且含「销售管道」；`GET /` 含 `/pipeline.html` 导航。
- `GET /api/business/board` 断言 `grouped.CRM_DEAL` 存在。
- 路由冒烟：`/pipeline.html` · `/portal/nav.js` · 6 子页导航注入后均含 nav 侧栏标记。
- 验收口径（用户）：业务页面**不再有死胡同**（每页可回首页/互通）；线索池/商机**真实可看**（非占位、非假数据）。

---

## §7 实施拆分（writing-plans 展开）

- **Task P1**：routes.js board 追加 DEAL + 今日优先真实 stage（数据契约修正，含测试）
- **Task P2**：`/pipeline.html` 六列管道 + 内联详情区 + 路由
- **Task P3**：`src/web/nav.js` 共享导航 + 6 子页注入 + index 导航落点修正
- **Task P4**：全量回归（portal-pages / pipeline / auth / scoring 无回归）+ 设计文档落状态提交
- **Task L5（2026-08-27 追加，用户拍板方案 B）**：首页 L2C 六段与管道页**同源**（按 DEAL.stage 的商机流），推翻原 §2「两套并存不合并」；STAGES/byStage 上移 `src/portal/scoring.js` 共享单源（`pipelineStages`/`dealStageOf`/`pipelineCounts`），pipeline.html 与 index.html 都 import 它。

---

## §8 自查

- 无占位符、无矛盾：三节（数据契约 / pipeline / 互通）对应 §1/§2/§3，文件清单 §4 与之一致。
- 范围明确：只做前端门户收口，不触后端业务逻辑（边界 §0）。
- 数据通道为真实端点 file:line 取证（routes.js:57/76/82/149/154/184/428），非文档臆测。
- 与现有 Stage3 门户计划衔接：本设计**复用**其已落地部分（scoring/auth/作战室），只补数据缺陷 + 管道页 + 互通，不推翻。