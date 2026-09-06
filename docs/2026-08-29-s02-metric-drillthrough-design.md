# S02 三卡钻取 + 文案语义校准设计文档

- 状态：**已批准（2026-08-29 用户「同意」）**
- 关联流程：`brainstorming` → 本设计（P6） → `writing-plans` → 实现
- 验收基线：生产库 `CRM_DEAL` 共 13 条，三卡真实口径 `FIT=3 / TIMING=1 / CONN=3`（routes.js:562-564 同源复算已验证）

## 0. 背景与问题

首页（S02 AI 作战室，`GET /api/page/home`）三张「今日优先」指标卡（FIT/TIMING/CONN）当前是**纯展示数字**，无可钻取能力，且副标题文案（匹配商机/应跟进/需接触）语义偏泛。用户诉求：

> 「能否直接点数字进去……页面的内容表述更准确」

即：①数字可点击 → 跳转到对应商机清单；②文案表述更准确。

## 1. 已澄清设计决策（brainstorming 阶段结论）

- **落点策略（混合）**：
  - **FIT**（`probability >= 0.6`，跨阶段）→ 跳**新建明细页** `/today-priority.html?dim=FIT`
  - **TIMING**（`stage = quoted`）→ 跳**业务看板** `/business-board.html?focus=quoted`（高亮+过滤「报价」段）
  - **CONN**（`stage = contracted`）→ 跳**业务看板** `/business-board.html?focus=contracted`（高亮+过滤「合同」段）
- **FIT 不可复用看板**：业务看板 S15 按 stage 六段组织，FIT 是赢率维度跨阶段，纯复用会失真 → 单独明细页语义最准。
- **详情页复用**：FIT 明细行可直链已存在的 `/deal-detail.html?id=`（routes.js:1811 + `GET /api/page/deal-detail` 971），无需新建详情页。

## 2. 口径校准（文案语义）

| 卡片 | 计数规则（不变，routes.js:562-564） | 新副标题文案 | 跳转目标 |
|---|---|---|---|
| 今日优先 · FIT | `payload.probability >= 0.6` | **赢率≥60% 的高匹配商机** | `/today-priority.html?dim=FIT` |
| 今日优先 · TIMING | `payload.stage === 'quoted'` | **报价阶段待跟进** | `/business-board.html?focus=quoted` |
| 今日优先 · CONN | `payload.stage === 'contracted'` | **合同阶段待接触** | `/business-board.html?focus=contracted` |

> 注意：三卡是**计数卡**（数量），非 `src/portal/scoring.js` 的 0-100 平均分模型，两套口径不混用。

## 3. 改造任务与生命契约

### Task 1 — metric-card 钻取通用能力（renderer 层）
- **文件**：`src/page/renderer.js:104-113` `renderMetricCard(comp, data)`
- **改造**：
  - 读 `comp.navigation?.to`；若存在 → 输出 `<a class="pg-metric-card" href="<to>"{hlAttr}>…</a>`
  - 否则维持 `<div class="pg-metric-card"{hlAttr}>…</div>`（回归安全，S01/S15 不受影响）
  - `href` 经 `escapeHtml` 防注入
- **契约**：带 `navigation.to` 的 metric-card 渲染为 `<a href>` 可点击；无 `navigation` 的卡维持 `<div>`（S01/S15 回归不破）

### Task 2 — S02 三卡加 navigation + 口径
- **文件**：`src/pages/S02.schema.js:20-34`
- **改造**：三 metric-card 加 `navigation: { to: '…' }`；`dataBinding.metrics[0].label` 改为精准口径文案（§2 表）
- **契约**：`GET /api/page/home` 返回 html 中三卡为 `<a href>` 且副标题含精准口径文案

### Task 3 — 业务看板 focus 高亮+过滤
- **文件**：`src/http/routes.js:502` `/api/page/business-board` + `src/web/business-board.html`
- **改造**：
  - 端点读 `req.query.focus`（quoted|contracted）：过滤 `data.components.table.rows` 仅该 stage；对应 metric-card（报价/合同）加 `data-highlight`
  - `business-board.html` 前端读 `location.search` 的 `focus` 透传给 `/api/page/business-board?focus=…`（若当前为静态 sendFile，则需注入 query 转发逻辑，或改为点击看板卡时带 focus 跳转）
- **契约**：`GET /api/page/business-board?focus=quoted` 返回的 html table 仅 quoted 行且「报价」卡高亮；`focus=contracted` 同理

### Task 4 — 新建今日优先明细页（FIT 钻取目标）
- **新增文件**：
  - `src/pages/S34.schema.js`：1 个 `table`（列：名称/阶段/赢率/金额/负责人）+ 顶部口径 header（赢率≥60%）；注：S21 已被「方法论 SKILL 注册表」占用，FIT 明细页用空闲编号 S34
  - `src/http/routes.js` 新增 `GET /api/page/today-priority`：读 `dim=FIT` 过滤 `deals` 中 `probability>=0.6`，返回 rows（含 `id` 供详情链接）
  - `src/web/today-priority.html`：复用 `home.html` 注入模式（`renderPage` 产物 + `page.css`）
- **改造**：`src/http/routes.js` 末尾新增 `GET /today-priority.html` sendFile 路由
- **契约**：`GET /api/page/today-priority?dim=FIT` 返回 3 行（prob≥0.6：食品礼盒全年框架/年报精装印刷/药品说明书画册），每行 name 链接 `/deal-detail.html?id=<id>`；页头标注口径

## 4. 约束

- **受控渲染单源**：所有出片经 `renderPage`，不手写旁路 HTML（首页/看板/明细页统一）
- **组件级 navigation 合法性**：`validator.js:19` 仅校验 schema 级 `navigation.to`；组件级 `navigation` 不受 `CANONICAL_NAV` 约束，可自由加（已确认 renderer.js 不依赖 validator 拦截组件级 navigation）
- **数据面不动**：三卡计数逻辑（routes.js:562-564）已验证正确，仅加钻取 metadata，不改算法
- **测试库 vs 生产库**：实现代码走 writing-plans；验证用生产库只读（3/1/3 已复算）

## 5. 端到端验证（实现后）

启动 server，依次点击：
1. FIT → 明细页显 3 条，每行进 deal-detail
2. TIMING → 看板显 1 条（药品说明书画册），「报价」卡高亮
3. CONN → 看板显 3 条，「合同」卡高亮
4. 三卡副标题显示精准口径（赢率≥60% 的高匹配商机 / 报价阶段待跟进 / 合同阶段待接触）

## 6. 提交约定

每 Task 一 commit（Git 提交闸门：沙箱无私有库凭证，AI 写码后由用户在本地提交，绝不 `git add -A`）。
