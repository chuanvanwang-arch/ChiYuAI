# 工作台（首页 `/`）重构设计

> 日期：2026-08-30 ｜ 作者：开发小助手 ｜ 状态：已批准（方案 A）

## 1. 背景与问题

当前工作台（`src/web/index.html`，经 `GET /api/page/home` 受控渲染，schema = `src/pages/S02.schema.js`）仍是 S02 早期骨架：

- Copilot ⌘K 目标输入（goal-form）
- 今日优先三卡（FIT / TIMING / CONN）
- 一张纯名单「L2C 管线」表（无金额、无转化率、无分段）
- 审批收件箱、推理轨迹、SSE 事件子表、线索池配置

而三个业务看板分散在独立页面：

| 页面 | 内容 | 数据源 |
|------|------|--------|
| `/pipeline.html` | 管道总览 KPI 八联 + L2C 六段价值流（数量·金额·段间转化率，可下钻） | `CRM_DEAL` + `pipelineMetrics` |
| `/named-accounts.html` | 客户跟踪 KPI 八联 + 客户列表（拜访/21条/线索/商机/合同/缺口） | `/api/board/named-accounts` |
| `/sales-behavior-board.html` | 销售个人行为 6 卡（实际 vs 目标） | `/api/board/named-accounts` summary |

验收口径要求「晨会速览 3–10 秒」，但当前首页无法一屏给全，销售每天需在 4 个页面间跳转。

## 2. 方案选定（已批准：方案 A）

扩展 S02 受控渲染 schema，在首页原生复刻三页的核心指标区。理由：

- 受控渲染器 `src/page/renderer.js` 已原生支持 `kpi-strip` / `pipeline` / `progress-card` / `collapse`（renderer.js:343-353），且 `COMPONENT_KINDS`（schema.js:11-15）已收录——**零新增渲染代码**。
- 守住「NL → 受控 JSON Schema → 运行时渲染器」架构铁律；schema 经 `validatePageSchema` 启动即校验（护栏）。
- 复用既有服务函数：`pipelineMetrics`（`src/portal/scoring.js:75`）、`buildNamedAccountBoard` / `boardSummary`（`src/sales/namedAccountBoard.js`）、`mergedTargets` / `mergedBehaviorStd`。

不采用方案 B（首页改手写页，脱离受控渲染单一出口）与方案 C（iframe 聚合壳，视觉割裂）。

## 3. 目标布局（一屏晨会速览）

```
┌─ Copilot ⌘K（goal-form，保留）────────────────────┐
├─ 今日优先三卡 FIT / TIMING / CONN（保留）─────────┤
├─ ▼ 管道总览（collapse open）──────────────────────┤
│   kpi-strip×2：在管商机｜管道总额｜加权预测｜加权胜率 │
│                ｜停滞商机｜停滞占比｜胜率｜平均客单    │
│   pipeline 六段：线索→需求→方案→报价→合同→赢单（含转化率）│
├─ ▼ 客户跟踪（collapse open）──────────────────────┤
│   kpi-strip×1：目标客户数｜今日拜访/目标｜今日电话/目标 │
│     ｜本周拜访客户/目标｜本周新客户/目标｜本周/本月拜访 │
│     ｜21条合格率                                   │
│   table：Top N 客户（客户名🔗→/account-360｜档位｜拜访│
│     ｜21条｜线索｜商机｜合同｜缺口）                  │
├─ ▶ 销售行为达标（collapse）───────────────────────┤
│   progress-card×4：今日拜访｜今日电话｜本周拜访客户    │
│     ｜本周新客户（percent=实际/目标×100，ok/warn 态）│
├─ 审批收件箱（table，保留）────────────────────────┤
└─ 实时事件流（SSE subtable，保留）+ 推理轨迹 + 线索池 ┘
```

## 4. 数据源与角色掩码

| 区 | 取数 | 数据落点（data.components） |
|----|------|----------------------------|
| 管道 | `queryParticles({type:'CRM_DEAL'})` → `pipelineMetrics(deals)` | `kpi-strip['管道 KPI-A'/'管道 KPI-B']`.items、`pipeline['管道六段']`{stages,conversions} |
| 客户 | `buildNamedAccountBoard({accounts,deals,contracts,contacts,targetsCfg,ownerFilter})` + `boardSummary(...)` | `kpi-strip['客户 KPI']`.items、`table['指名客户 Top N']`.rows |
| 行为 | `boardSummary(...).summary` | `progress-card['今日拜访'/'今日电话'/'本周拜访客户'/'本周新客户']`{percent,label,state,hint} |
| ownerFilter | `resolveMe(req).username`（默认当前登录销售；manager/admin 可按 `?owner=` 切视角） | — |

**角色掩码**：`role==='sales'` 时，管道类金额项 `state:'hidden'`（渲染为 🔒），与 `pipeline.html:92 canSeeAmount()` 口径一致；`pipeline` 组件用 `permHiddenStages`（renderer.js:158 已支持）隐藏段金额。其它角色金额可见。

## 5. 实施 Task（每 Task 一 commit）

- T1：扩展 `S02.schema.js`（3 个 collapse 区 + 其子组件），`validatePageSchema` 通过。
- T2：扩展 `/api/page/home` handler，聚合管道 + 客户 + 行为三数据源，注入 `data.components`。
- T3：角色掩码（sales 金额 🔒）。
- T4：测试 `test/http/homePage.test.js`（schema 合法 + 三区数据非空 + sales 掩码生效）。
- T5：端到端验收（真浏览器多角色截图）。

## 6. 验收口径

- 首页一屏覆盖：管道健康 + 客户达标 + 行为达标 + 待办/审批。
- 不破坏现有 S02 出片/NL/goal-form 机制（回归 `test/page/` 全绿）。
- sales 角色金额域自动掩码，非 sales 可见。
