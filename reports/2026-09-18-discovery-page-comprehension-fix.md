# 线索发现工作台「看不懂」排查与修复（2026-09-18）

> 用户输入「北京海底捞」→ 点「搜索候选」→ 截图圈出候选池表头与「暂无已评分候选」，反馈「看不懂」。
> 结论：**不是功能缺失，而是三处「不可理解」+ 一处响应形状错配**。以下每条均有 file:line 或实机证据。

---

## 一、先翻译你圈的那两行

| 你看到的 | 它其实是 |
|---|---|
| `公司 ICP 适配分 信号 why_narrative 来源` | **表头**（5 列）。因为表体无数据，列宽塌缩，5 个 `<th>` 挤成一行文字，读起来像一句乱话 |
| `暂无已评分候选` | **表体空态行**（colspan=5 的单行文案） |

也就是说：那两行合起来 = **一个空的候选池表格**，不是一句话。

---

## 二、为什么是空的（四条独立原因，逐条取证）

| # | 现象 | 根因 | 证据 |
|---|---|---|---|
| 1 | 候选池恒空 | 该表只显示「带 ICP 适配分」的客户，而**全库 17 个租户、41 个 CRM_ACCOUNT 里该字段命中数为 0** ⇒ 结构性永空（非本租户特例） | `discoveryRoutes.js:48` 过滤器；库查询 `payload->'discovery'->'icp_fit_score'` = 0 |
| 2 | 搜「北京海底捞」没有画像 | ① 下拉默认项 `value=""` —— 后端以 `allowIds:[provider]` **精确匹配**适配器 id，空串不可能命中任何 id，**实测恒返回 `provider_not_enabled_or_unknown`**；② 选 gaode 则需 `GAODE_KEY`（`.env` 中未配置）；③ qixin/anysite 无凭据槽 | `lookupRouter.js:20,29`；实测探针四值全 0 |
| 3 | 画像表**即使源返回数据也渲染不出来** | 前端读**顶层** `data.items`，而后端信封是 `{ok, data:{items,...}}` ⇒ `items` 恒 `undefined`、`draft_id` 恒显示 `-`。同库正确范式见 `lead-pool.html:263 (data.data \|\| data)` | 实机抓包：`{"ok":true,"data":{"draft_id":"069de8e3-…","items":[]}}` 而页面显示 `draft_id=-` |
| 4 | 顶部整块空白 + 「运行发现」点了没反应 | `#icp-summary`／`#data-source-badges`／`#last-run-at`／`#run-discovery-btn` **全仓 grep 仅命中自身 HTML 声明**，零 JS 消费 | 四 id 全仓各 1 命中，`layout.js` 无绑定 |

补充：页面注释称触发走 `<buddy-capsule>`，但**页面里根本没有该元素**（`buddy-capsule` 仅存在于 `buddy-crm-portal.html`）。
真正的 discovery-run 入口在 `/buddy` → Tab「客户洞察」→ 胶囊「线索发现」（`agent-workbench.html:329` 监听 `inject-prompt`，链路已核实接通）。

---

## 三、修复清单（仅 `src/web/discovery.html`，纯前端、零新增写路径）

| # | 改动 | 解决 |
|---|---|---|
| 1 | 两张表加 `class="table"`（复用 `common.css:69-72` 既有样式）+ `th{white-space:nowrap}` | 表头分列，不再挤成一句乱话；实机 x 坐标 244→383→640→779→1117 单调递增 |
| 2 | 空态改为**自解释**：说明数据来源字段、只由 discovery-run 写入、与「定向拓客」是两条独立链路、给出可点触发入口 | 「为什么空 + 去哪触发」 |
| 3 | 取数失败显式区分：`render([], errMsg)` —— 不再把 403/网络错误 `render([])` 伪装成「空数据」 | 失败态 ≠ 空数据态 |
| 4 | 响应按信封取数 `const payload = data.data \|\| data`；消费 `payload.error`；`draft_id` 取自 `payload` | **本页恒空的核心根因** |
| 5 | 后端 error 显式暴露为「**未执行**」+ 错误码（`PROVIDER_ERR_TEXT` 翻译） | 不再吞成「预期 fail-open」 |
| 6 | 下拉移除 `value=""` 默认项（gaode 置首并标注需 `GAODE_KEY`）；按钮文案「搜索候选」→「补全画像」 | 消除「默认项必错」与「搜索/补全」语义误导 |
| 7 | `#run-discovery-btn` 由死按钮改为 `<a class="btn primary" href="/buddy">去对话运行发现 →</a>`，并补三行静态自解释（ICP／数据源／运行记录） | 死区接线；不裸调写端点（discovery-run 属写类） |

> ⚠ 未改动：`#icp-summary` 等三处**未编造运行时间**（无法取证），改为静态事实陈述。

---

## 四、验证（三层，均可复跑）

| 层 | 手段 | 结果 |
|---|---|---|
| 运行期探针 | `scripts/verify-discovery-page-render.mjs`（DOM 桩真跑 `onclick` + fetch 桩，7 场景） | **24/24 通过**；`npm run probe:discovery-ui` |
| 变异自证 | `tmp/_mutate_disc_render.mjs` 六变异体：扁平信封／哑空态／吞错误／去 `.table`／空值默认项／吞后端 error | **6/6 被抓**（红 6/5/3/2/2/3） |
| 实机（Playwright 真登录真点击） | 表头几何 + 三场景点击 + 按钮接线 | 全 ✅；`draft_id=d9aaf01e-…` 已能真实显示 |
| 静态契约 | `test/web/discoveryPage.test.js` +2 条（防整段删除） | 10 通过 |
| 回归 | `vitest run test/web` | 4 红，断言对象为 `sales-decision-monitor/decision-scenarios/pipeline`（本轮未修改，属既有红） |

---

## 五、待你裁决（本轮未动）

| 级别 | 问题 | 说明 |
|---|---|---|
| **P1** | **gaode 凭据键名接线缺失**：`gaode.js:15` 读 `ctx.gaodeKey`，而 `lookupRouter.js:33` 构造的 ctx 只有 `{tenantId, credentials}` ⇒ 即使配了凭据也不会被使用，只能靠环境变量 | 同源对照：`qixin.js:38`/`anysite.js:82` 读 `ctx.credentials?.qixin`（正确）。建议统一为 `ctx.credentials?.<id>` |
| **P1** | **三个适配器经此通路恒空**：`emailVerify` 读 `ctx.verifyEmail`、`webResearch` 读 `ctx.research`、`tender` 读 `ctx.tenderSubscription` —— lookupRouter 均未注入 | 若定位为「仅 search 通路可用」需在页面/文档标注，否则仍是「点了没数据」 |
| P2 | `lead-pool.html:98` 的 `class="btn-primary"` 在 `common.css` 中**不存在**（只有 `.btn.primary`）⇒ 渲染为浏览器默认按钮 | 1 行修复；本轮为控制 diff 范围未动 |
| P2 | `common.css:72` `.table tr:hover td{background:#16233b}` 为**硬编码深色**，浅色主题下 hover 会异常 | 属「危险兜底色值」同族，建议换 token |

---

## 六、给你的操作路径（要看到候选池有数据）

1. 打开 `/portal/buddy-crm-portal.html`（或 `/buddy`）→ Tab「客户洞察」→ 点胶囊「线索发现」
2. 对话区会填入 `调用 discovery-run 运行线索自主发现…` → **确认发送**
3. 该策略产出带 `icp_fit_score` 的 CRM_ACCOUNT 后，回到 `/discovery.html`，候选池即出现行
4. 若只想按 ICP 批量搜候选企业入公海池 → 到 `/lead-pool.html` 的「主动拓客」Tab（本页无该 Tab，原文案指向不存在的位置，已改为带链接）

> 定向拓客（画像补全）与候选池是**两条独立链路**：前者只读、不写粒子，其数据永远不会出现在后者。
