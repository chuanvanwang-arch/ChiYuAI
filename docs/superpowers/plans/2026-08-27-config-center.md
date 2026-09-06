# 配置中心统一入口 `/config` 聚合页（实施计划）

> 来源：2026-08-27 审计（A 组业务页 + B 组配置中心 11–28 现状）→ 用户批准「配置中心统一入口」设计
> 纪律：brainstorming（设计已批准）→ writing-plans（本文件）→ 实现（TDD，每 Task 一 commit）
> 范围：B 组 18 项配置的统一只读入口；**不做 11 个 CRUD 编辑器**

## 0. 后端真实状态（取证，src/http/routes.js + db/schema.sql）

| # | 配置项 | 前端可达性 |
|---|---|---|
| 11 | LLM 配置 | `GET/PUT /api/config/llm`（configRouter key=llm）🔵可读取 |
| 12 | 用户管理 crm_users | 仅表(326)+登录，无端点/页 ⚪待建设 |
| 13 | 权限/RBAC | 无表/无端点/无页 ⚪待建设 |
| 14 | 销售决策场景 | `decision_scenario` 表+种子，但无端点 ⚪待建设(后端缺端点) |
| 15 | 七维设计 | `GET/PUT /api/config/seven-dim`（configRouter，decisionScene=scene-quote）🔵可读取 |
| 16 | 方法论 SKILL 注册表 | `GET /api/methodology/skew` + `POST /api/methodology/sync` 🔵可读取(skew) |
| 17 | 审批流配置 | 无端点/页 ⚪待建设 |
| 18 | 业务分级配置 | `business_tier_config` 表(179)，但**无端点** ⚪待建设(后端缺端点) |
| 19 | 粒子属性元模型 | ✅ 已有页 `/meta-attr-drawer` + `/api/meta-attr` |
| 20 | 池配置 | `GET/PUT /api/pool-config`(182/190) 🔵可读取 |
| 21 | 预警规则 | 无端点/页 ⚪待建设 |
| 22 | 粒子模型/本体/词汇 | 无端点/页 ⚪待建设 |
| 23 | 智能体配置 | 无端点/页（代码层 agentSpec）⚪待建设 |
| 24 | 门户/页面生成 | ✅ 已有页 `/page-market` + `/api/page/from-nl`(434) |
| 25 | 决策质量监控 | ✅ 已有页 `/sales-decision-monitor`(642) |
| 26 | 记忆/先例管理 | `memory_log/snapshot/note` 表 + `POST /api/memory/distill`(468)，无管理页 ⚪待建设 |
| 27 | 连接器/MCP | `mcp_identity` 表(354)，无端点/页 ⚪待建设 |
| 28 | 系统设置 | 无端点/页 ⚪待建设 |

**统计**：已就绪 UI 3（19/24/25）· 可读取 4（11/15/16/20）· 待建设 11（12/13/14/17/18/21/22/23/26/27/28）

## 1. 架构

- **新增** `src/web/config.html`：聚合页（6 类分组卡片网格 + 顶部总览 + 15s 轮询可读取项）。
- **新增** `src/portal/configCenter.js`：纯函数 `renderConfigCenter(items, statusMap, fetched)` → 浏览器与 vitest 共用（类比 agentsPage.js / detailSections.js）。
- **路由**：`src/http/routes.js` 补 `/config` + `/config.html` 静态别名（对齐 `/agents`）；可读取项端点已存在，无需新增后端。
- **导航**：`src/web/nav.js` 新增「⚙ 配置中心」入口（侧栏顶部，配置类聚合位）。

## 2. 数据模型（前端配置清单常量）

`configCenter.js` 内导出 `CONFIG_ITEMS` 数组（18 项），每项：
```
{ id:11, name:'LLM 配置', group:'智能体', status:'readable',
  endpoint:'/api/config/llm', page:null, note:'configStore key=llm' }
```
status ∈ `ready`(已就绪页) | `readable`(有 GET 端点) | `pending`(待建设)
- ready：`page` 指向现有页 href（19/24/25）
- readable：`endpoint` 指向 GET 端点（11/15/16/20）
- pending：`note` 说明原因

## 3. 渲染函数签名

```js
export function renderConfigCenter(items, fetched = {}) {
  // 返回 6 类 <section> 卡片网格 HTML 字符串
  // 每卡：标题 + 状态徽标(✅/🔵/⚪) + 摘要(fetched[endpoint] 或 note) + 动作
  //   ready   → <a href=page>打开</a>
  //   readable→ <button data-endpoint>查看</button>（点击 fetch 展开到 #detail-<id>）
  //   pending → 灰显 + note
}
export function configSummary(status, fetchedVal) { /* 字段摘要：llm→provider/model；pool→规则数；seven-dim→维度数；skew→skills 数 */ }
```

## 4. 页面行为（config.html）

- 顶部：`renderConfigCenter` 注入 + 总览计数（已就绪 N / 可读取 M / 待建设 K）+ 刷新时间。
- `init()`：对 4 个 readable 项 `fetch(endpoint)` → 存 `fetched` → 重渲染该卡摘要（失败降级为"读取失败"）。
- `setInterval(15s)` 重拉 readable 项。
- 模块 `configCenter.js` 经 `/portal/configCenter.js` 挂载（路由补）。

## 5. 测试（TDD，test/web/configCenter.test.js）

- 6 类分组均渲染（断言含 group 标题）
- 🔵 readable 卡含 `data-endpoint="/api/config/llm"` 且含"查看"
- ✅ ready 卡含 `href="/meta-attr-drawer"` 等深链
- ⚪ pending 卡含"待建设" + note
- `configSummary` 对 llm/pool/seven-dim/skew 返回非空摘要
- 空 `items` 降级返回空容器
- RED→GREEN

## 6. 改动文件清单

| 文件 | 动作 |
|---|---|
| `docs/superpowers/plans/2026-08-27-config-center.md` | 新增（本计划） |
| `src/portal/configCenter.js` | 新增（渲染器） |
| `test/web/configCenter.test.js` | 新增（TDD） |
| `src/web/config.html` | 新增（聚合页） |
| `src/http/routes.js` | 改（`/config` 别名 + `/portal/configCenter.js` 挂载） |
| `src/web/nav.js` | 改（入口） |

## 7. 范围边界（YAGNI）

- 仅聚合 + 只读视图；不含 11 个配置项的写入编辑器、不含 RBAC/审批流/预警建设。
- 写入编辑（11/15/20 的 PUT、18/14 的端点建设）留作独立 Task，每项一个实施计划。
- 不新增任何后端端点（全部复用既有）。

## 8. 验证口径

- `node node_modules/vitest/vitest.mjs run test/web/configCenter.test.js` → 全绿
- `test/web/` 整体回归（configCenter + agentsPage + detailSections）
- `node --check src/http/routes.js` / `configCenter.js`
- 起服务冒烟：`/config` → 200 html；`/portal/configCenter.js` → 200 js；readable 卡含 endpoint
