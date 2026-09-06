# 销售决策监控台 TAB 分组重构设计

> 日期：2026-09-04　作者：WorkBuddy
> 目标页：`http://localhost:3000/sales-decision-monitor`（`src/web/sales-decision-monitor.html`，2282 行）
> 前置：2026-09-01 前后台重设计（docs/archive/）、2026-08-25 监控设计（docs/specs/）
> 性质：**设计文档，已获用户批准（2026-09-04 20:30）**。实施中不可再删模块，仅可删重复冗余。

---

## §0 执行摘要（先结论）

**结论一：页面"乱"的根因是 14 个信息区平铺，无任务主线。** 用户四个动作全部高频（看总览 / 查单个决策 / 处理待办 / 治理校准），页面是四合一作战中枢。按"任务流"而非"抽象性质"分 3 个 TAB，每个 TAB 自含闭环。

**结论二：6 处重复/冗余可删（含被覆盖的死区），其余 8 处全部保留。** 用户明确"相似/重复的内容可删除、不能轻易删除内容"。重复判定以"同源同接口双份渲染"为准，非内容价值判定。

**结论三：技术改动纯前端单文件，零后端、零删函数。** 所有 id（gates/tasklist/dn-output/cy 等）保持不变，仅重排 DOM + 合并渲染 + 懒加载轮询 + URL 状态。弹窗/抽屉/浮卡原样保留。

**结论四：轮询混乱（10+ 接口×5-30s 并发）是"乱"的技术根因之一，改为按 TAB 懒加载 + 仅激活 TAB 轮询。**

---

## §1 现状盘点（14 信息区 → 判定）

| # | 信息区 | id/锚点 | 性质 | 判定 |
|---|---|---|---|---|
| 1 | Layer0 平台问责健康头 | `#layer0` | 监控 | 保留（①可审计性 ②供给健康；**③三闭环删**，与 #2 重复） |
| 2 | 三系统闭环条（知识/记忆/决策） | `#loop-strip` | 监控 | 保留（#1 的③与它重复 → 删 #1 的③） |
| 3 | 闸门质量卡（左栏） | `#gates` | 监控 | 保留（合并后为单份） |
| 3b | 归因面板（右栏） | `#attribution-panel` | 监控 | **删**（与 #3 同源 `/api/monitor/gate-attribution` 双份渲染） |
| 4 | 待办/决策任务列表 | `#tasklist` | 操作 | 保留（升级筛选：场景/处置/名称/「待处理」） |
| 5 | 决策网络内联摘要 | `#dn-output` | 操作 | 保留 |
| 6 | 决策网络弹窗（7 视图） | `#dn-modal`（动态） | 操作 | 保留（常驻浮层） |
| 7 | 归因下钻弹窗（3 视图） | `#attrib-modal` | 操作 | 保留（常驻浮层） |
| 8 | L2 反馈回路区 | `#l2-feedback` | 监控 | 保留（双环+隐性错误簇）；补录表单并入档案 tab 详览 |
| 9 | Cytoscape 决策真图 | `#true-graph`/`#cy` | 操作 | 保留（并入档案 tab） |
| 10 | 闭环活度看板 | `#closure-loop` | 监控 | 保留（移入治理 tab，与校准同域） |
| 11 | 决策三卡（自检/评分/思维） | `#decision-cards` | 操作 | 保留（档案 tab 折叠块） |
| 12 | 夜间复盘浮卡（SSE） | `#retro-fab` | 监控/治理 | 保留（常驻浮层，admin） |
| 13 | 7×7 巡检卡抽屉 | `#dn-77-drawer` | 操作 | 保留（常驻浮层） |
| 14 | 决策校准（P2 四段式） | `#page-calibration` | 治理 | 保留（独立 tab，sysadmin） |
| 15 | 决策详览下钻区（原 `#detail`/`drill()`） | `#detail` | 操作 | **删**（决策列表已被清单+弹窗覆盖，函数保留但入口移除） |
| 16 | `dn-select` 下拉+「打开」行 | `#decision-network .row` | 操作 | **删可见行**（隐藏元素保留兼容；清单行点击联动详览） |

---

## §2 目标布局（3 TAB 任务流）

### 2.1 TAB1 总览监控（overview）——总体仪表盘
```
Layer0 健康头（①可审计性 ②供给健康）
总体指标条（总决策数 / 整体可审计率 · 供给率 / 三闭环状态汇总）
闸门质量汇总卡（仅头部：各闸门质量分，点击 → 跳 TAB2 明细展开）
L2 反馈汇总卡（决策通过率 · 业务成功率 · 隐性错误数，点击 → 跳 TAB2 明细展开）
三系统闭环条（知识/记忆/决策）
```
职责：一眼回答"平台整体健康吗 → 哪些数据亮红灯 → 想看哪个闸门点进去"。**明细（9 闸门质量卡、L2 双环）不在总览铺开，集中到 TAB2，总览入口点击跳 TAB2 对应区**。

### 2.2 TAB2 决策档案（archive）——唯一明细区
```
闸门质量明细（9 闸门质量卡 + 归因章，由总览入口点击展开）
L2 反馈明细（双环对比 + 隐性错误簇 + 补录表单）
决策清单（筛选：场景/处置/名称/待处理快捷筛；行点击 → 联动详览）
决策详览（内联摘要 7 类边/上下游 + 补录业务结果表单）
Cytoscape 决策真图（渲染当前决策）
决策三卡（自检/评分/思维，折叠块）
```
职责：查单个决策、处理待办补录、看闸门质量与 L2 反馈明细，一步不跨页。**总览 Tab 的闸门质量/L2 汇总卡点击 → 切到本 Tab 并滚动到对应区（`_activateTab('archive')` + 锚点滚动）**。

### 2.3 TAB3 校准治理（governance）
```
决策校准（P2 四段式：指标/归因/处方/历史，sysadmin）
闭环活度看板（偏差处方/改善/概念覆盖）
复盘建议（读取 retro-latest，admin；夜间复盘浮卡保留于任意 tab）
```
职责：治理校准、处方审批、复盘沉淀。

### 2.4 常驻浮层（任意 tab 可开）
决策网络弹窗（7 视图）、归因下钻弹窗（3 视图）、7×7 巡检卡抽屉、夜间复盘 SSE 浮卡。

---

## §3 关键机制

1. **懒加载 + 按 TAB 轮询**：切到哪个 TAB 才首拉 + 只轮询激活 TAB（`setInterval` 句柄统一管理，tab 切换时 clear/启动）。首屏只发激活 tab 的接口，不再 10+ 并发。
2. **URL 状态保持**：`?tab=overview|archive|governance`；`history.replaceState` 不刷新。
3. **二级折叠不删除**：TAB 内子区块用 `<details>`，默认展开；三卡/真图/复盘建议可折叠。
4. **合并渲染**：`load()` 复用 `renderGates()` 输出单份网格（左栏内容 + 右栏归因章合并为一张卡内 cat-row），删 `loadAttribution()` 独立渲染（函数保留不删，仅不再调用）。
5. **清单联动**：`tasklist` 行点击 → `openDnModal(decision_id)`；`dn-select` 隐藏元素保留（供 `renderDnInline`/`openScenarioModal` 代码引用，不破坏既有函数契约）。

---

## §4 删除清单（仅重复/冗余，全部有替代承载）

| 删除项 | 替代承载 | 依据 |
|---|---|---|
| Layer0 卡③三闭环汇总 | 三系统闭环条 #2 | 同指标双份（loadSupplyHealth ③ 与 loadLoops 重复） |
| `#attribution-panel` 右栏 | 闸门质量卡（合并单份） | **同源同接口** `/api/monitor/gate-attribution` 双份渲染（load + loadAttribution） |
| `#detail` + `drill()` 入口 | 清单+弹窗 | `openScenarioModal` 已直开弹窗，drill 输出空列表冗余 |
| `dn-select` 可见下拉行 | 清单行点击联动 | 与清单重复选决策 |
| `page-calibration` 触发路径不变 | — | 保留 |

**铁律：不删任何 JS 函数/模块、不删 id 元素引用契约**（`drill/gotoRerun/renderTrueGraph/openScenarioModal` 等函数保留；仅移除可见 DOM 挂载点或不再调用）。禁 DELETE，本页零 DB 变更。

---

## §5 验收锚点

| 验收项 | 判定 |
|---|---|
| 首屏仅请求 overview tab 接口 | 打开页面 Network 面板，无 archive/governance 接口请求 |
| TAB1 为总体仪表盘 | 总览显示总体指标（总决策数/整体率/三闭环汇总），不铺 9 闸门明细卡 |
| TAB1 汇总卡点击 → TAB2 明细 | 闸门质量/L2 汇总卡点击 → `_activateTab('archive')` + 锚点滚动到对应区 |
| 切换 archive tab 才拉 `/api/monitor/decisions`、`/api/graph/*` | 切 tab 触发懒加载 |
| 3 tab URL 状态保持 | `?tab=governance` 刷新后仍在治理 tab |
| 14 模块可达（8 保留 + 6 删除项确认有替代） | 逐个核验 |
| 弹窗/抽屉/浮卡行为一致 | 打开决策网络弹窗、7×7 抽屉、夜间浮卡正常 |
| 零 JS 函数删除 | `grep` 计数函数名全集前后一致（仅删调用点） |

### §5.1 实测闭环（2026-09-04 已验收 ✅）

| 验收锚点 | 实测结果 | 佐证 |
|---|---|---|
| 3 TAB 可切换 | ✅ 总览监控 / 决策档案 / 校准治理 三 tab 均激活 | agent-browser 实测 |
| URL 状态保持 | ✅ `?tab=overview→archive→governance` 往返，`replaceState` 生效 | 切 tab 后 `location.search` 复核 |
| 首屏仅 overview | ✅ archive/governance 接口未在首屏发出（懒加载契约） | `_activateTab` 首拉行为 |
| archive 懒加载 | ✅ 切 tab 才拉 `/api/monitor/decisions`，场景/处置筛选下拉出现真实选项（20 条） | 清单「共 20 条 · 当前显示 20 条」 |
| 行点击联动 | ✅ 点击行打开决策网络弹窗（根决策 + 可审计性 3/4 + 四问） | `dn-modal` display=flex |
| 治理 admin 可见 | ✅ 校准治理含 P2 四段式（覆写率 53.8%/升级率 51.4%…）+ 闭环活度 | admin 登录实测 |
| 零函数删除 | ✅ 仅删 DOM 挂载点/残骸，`dcLoad`/`drill`/`loadAttribution` 等保留并重定向 | 三块 script 语法全绿 |
| TAB1 为总体仪表盘 | ✅ 总览只含总体指标条 + 闸门质量汇总 + L2 汇总 + 三闭环条，9 闸门明细卡与 L2 双环已移出 TAB1 | 实测总决策数 173 / 可审计率 41%（0/50）/ 供给率 49.7% · 50 快照 / 闭环状态「三闭环」；闸门汇总 10 行真实数据（9 闸门 + CLIENT_STRATEGY）；L2 汇总 90% | 4% | 1 簇 |
| TAB1 汇总卡点击 → TAB2 明细 | ✅ `goArchive('gates')|('l2')` 切换 archive tab（URL `?tab=archive`）→ 精确滚动 `#gates`/`#l2-feedback` 到视口顶部（top≈0）→ 9 卡/L2 双环渲染 | agent-browser 实测 -0.31px / 0.19px |
| 明细集中在 TAB2 | ✅ `#gates`、`#l2-feedback` id 唯一归属 TAB2；TAB1 无明细铺开 | DOM 结构归属校验 |
| 首屏仍无明细接口 | ✅ 首屏零 `/api/decision/`、`/api/graph/` 请求，仅 overview 支撑接口；汇总数据复用既有轮询（gate-attribution/auditability/supply-health/loops/L2）尾部填充，零新增接口 | Network 实测 |

**实施中修复的额外缺陷**（浏览实测发现，非设计范围）：
1. `_dnSyncHiddenSelect` 用 `sel.options.length`（`<crm-select>` 自定义元素无 `options`）→ TypeError 中断清单渲染 → 改 `querySelectorAll('option').length` + try 守卫。
2. `DN_IS_ADMIN` 跨 script 块不共享（module 赋值不进 window）→ `window.DN_IS_ADMIN` defineProperty 桥接。
3. 隐藏 `dn-select` 契约元素补回 TAB2（10+ 处 JS getElementById 引用）。

---

## §A 生命契约（双轨）

```contract-yaml
- task: "按 3-TAB 任务流重构 sales-decision-monitor.html"
  agent: sales-decision-monitor
  skills: [data-particle-read]
  memory: [crm-copilot]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "重排后页面 3 tab 可切换、URL 状态保持、首屏仅 overview 接口、全部保留模块可达且零函数删除"
```
**契约说明**：任务由 `sales-decision-monitor` 承接，调用 `data-particle-read` SKILL 读取监控数据（L1，≤2 跳）；成功标准为 3 tab 可切换、URL 保持、懒加载生效、保留模块可达、零函数删除。

> 注：`sales-decision-monitor` 为页面级任务代理 key（本页无独立 agentSpec 注册；执行 agent 为 WorkBuddy 前端实施代理，skills/memory 按现有监控页数据契约对齐）。

---

## §6 实施范围边界

- **本会话验证**：HTML 结构重排 JS 语法、3 tab 切换、懒加载、URL 状态；浏览器预览。
- **继承自前会话**：弹窗 7 视图、7×7 抽屉、SSE 浮卡、校准 P2 四段式的渲染逻辑——**不改动**，仅保留挂载点。
- **不做**：后端 API 修改、DB 变更、其他页面改动。

## §7 实施顺序

1. 备份 `src/web/sales-decision-monitor.html` → `tmp/scriptfix-bak/`（或 `tmp/`）
2. 重排 body 三 TAB 容器（overview/archive/governance）
3. JS：合并 gates 渲染、删除 drill 调用、tasklist 行点击联动、懒加载轮询管理、URL tab
4. node --check 语法校验 + 服务探活 + 浏览器预览
5. 验收对照 §5
