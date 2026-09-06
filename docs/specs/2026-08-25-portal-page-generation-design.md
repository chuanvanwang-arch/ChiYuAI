# 阶段 2 子系统四 · 门户生成 NL→Page（设计文档）

> 状态：**已批准（2026-08-25）+ 实施完成**（T1–T7 提交，见文末 commit 区间）
> 方法论：`ai-portal-page-generation`（NL→受控 Schema→运行时渲染器三段式、三层护栏、4 粒子校验、AI 原生 UI 铁律）
> 上游：`ai-particle-system-design`（粒子值域）、`ai-native-action-design`（交互白名单，子系统三已落地）
> 下游：`ai-event-driven-evolution`（页面使用反馈）、`ai-context-layering`（生成时角色上下文注入）

---

## §0 结论（一句话）

CRM 门户从「静态 index.html 占位」升级为 **NL→Page 能力**：NL 意图经护栏→受控 Schema→运行时渲染器产出可运行页面（本地 MVP 无 DB 依赖），交互按钮只映射注册 Action 白名单，页面可预览/发布/回退。

---

## §A 架构与模块划分（新建 `src/page/`，与 src/context、src/memory 同构：纯函数优先）

| 模块 | 职责 | 关键导出 |
|---|---|---|
| `schema.js` | 协议常量：页面类型/组件类型/主题/过滤算子/聚合函数/粒子值域/Action 白名单 | `PAGE_TYPES` / `COMPONENT_KINDS` / `PARTICLE_TYPES_ENUM` / `ACTION_WHITELIST`（读全量+写白名单） |
| `nlParser.js` | NL→Schema 解析（意图→页面类型/实体→粒子/指标→聚合/阈值→高亮/动作→按钮），**绝不产出 HTML** | `parseNlToSchema(nl)` → `{schema, confidence, needsClarification, notes}` |
| `validator.js` | 4 粒子校验：粒子值域/stage 仅 eq 不聚合/存量仅 latest/Action 白名单；navigation 强制权威枚举 | `validatePageSchema(schema)` → `{ok, errors[]}` |
| `guardrails.js` | 输入层护栏：拦截 `<script>`/`javascript:`/`on*`/`eval(` | `guardNlInput(nl)` → `{safe, reason}` |
| `renderer.js` | **唯一渲染出口**：先校验、动态值转义、交互仅 `data-action` 声明式、强制无 `<script>` | `renderPage(schema, data)` → `{html, warnings[]}`（四态 loading/empty/error/partial 齐备） |
| `pageStore.js` | 页面生命周期：createPageFromNl→draft→preview→publish→revert（**内存 Map store**，DB 持久化留 PG 环境） | `createPageFromNl` / `listPages` / `publishPage` / `revertPage` |

> 设计铁律（三段式）：NL 层只产出 Schema；渲染器是唯一渲染出口（Schema 唯一输入）；**禁止 NL 直出 HTML**。

---

## §B Schema 协议（受控结构，可校验/可审计）

```js
// 页面 Schema v0.1（本子系统 MVP 范围）
{
  version: '0.1',
  type: 'dashboard' | 'table' | 'form' | 'detail' | 'intake' | 'workspace',
  title: string,
  navigation: { group: string, to: string, icon: string },  // to 必须 ∈ CANONICAL_NAV
  layout: { columns: number, theme: 'light'|'dark' },
  components: [
    {
      kind: 'metric-card' | 'table' | 'goal-form' | 'result-card' | 'reasoning-trace',
      title: string,
      dataBinding: { source: 'particle', particleType: 'CRM_DEAL'|'CRM_ACCOUNT'|...,
        filters: [{ field, op: 'eq'|'lt'|'lte'|'gt'|'gte'|'contains', value }],
        metrics: [{ field, agg: 'count'|'sum'|'avg'|'latest', label }],
        columns?: [field...] },
      style?: { highlight: { when: {field, op:'lt'|'lte'|'gt'|'gte', value}, color: 'red'|'green'|'amber' } },
      actions?: [{ label: string, action: string }]  // action ∈ ACTION_WHITELIST
    }
  ]
}
```

### 值域与约束（4 粒子护栏 + 权威导航）
- `PARTICLE_TYPES_ENUM`：`['CRM_DEAL','CRM_ACCOUNT','CRM_CONTACT','CRM_PRODUCT','CRM_PRICE_LIST','CRM_PERSON','CRM_ORGANIZATION','CRM_KNOWLEDGE','CRM_UNSTRUCTURED_ASSET']`（对齐 particleModel.js L6-70；旧值如 `DEAL`/`ACCOUNT`/废弃拆分模型直接拒绝渲染，非静默映射）。
- **状态字段约束**：filter 的 op 仅 `eq`（状态无序枚举）；**metric-card 聚合状态字段 → 拒绝**（枚举不可聚合）。
- **存量快照字段约束**：聚合仅 `latest`（不支持 sum/avg 跨记录）。
- **Action 白名单**：读 `data-particle-read`/`crm-account-360`；写 `crm-deal-advance`/`data-particle-create`/`data-particle-update`（对齐子系统三 WRITE_WHITELIST）；**禁止 NL 生成未注册动作**。
- `navigation.to` ∈ CANONICAL_NAV（`/dashboard` `/deals` `/accounts` `/contacts` `/products` `/pricelists` `/persons` `/organizations` `/knowledge` `/workspace`），否则拒绝渲染。

---

## §C 关键逻辑

### C1 解析映射（确定性规则，非 LLM）
| NL 片段 | Schema 映射 |
|---|---|
| 「看板/概览/分布」 | type=dashboard；实体未识别 → needsClarification（confidence 0.3） |
| 「表格/列表/明细」 | type=table；columns 从粒子 coreAttributes 取前 4 |
| 「商机/交易」 | particleType=CRM_DEAL（旧词「机会」同映射） |
| 「客户」 | CRM_ACCOUNT |
| 「联系人/人」 | CRM_PERSON 或 CRM_CONTACT（上下文歧义 → note） |
| 「产品/价格」 | CRM_PRODUCT / CRM_PRICE_LIST |
| 「金额/总量」 | metrics agg=sum |
| 「低于 X%」 | highlight when op=lt value=X/100 color=red |
| 「审批/推进」 | actions.action=crm-deal-advance（受控，非自由按钮） |
| 完整实体+指标+动作为 0.9，缺实体 0.3，注入尝试 0.5（需澄清） | confidence 三档 |

### C2 三层护栏（纵深防御）
1. **输入层** `guardNlInput`：拦截 `<script>`/`javascript:`/`onerror`/`onclick`/`on*`/`eval(`，命中 → `{safe:false, reason}`（源头杜绝「NL 直出 HTML」）。
2. **结构层** `validatePageSchema`：拒绝未知粒子类型、非白名单 Action、非法算子（stage 非 eq）、存量快照非 latest、navigation.to 非法。
3. **渲染层** `renderPage`：渲染前再校验；所有动态值 HTML 转义（`& < > " '`）；交互仅 `data-action` 声明式属性（**无 onclick/inline JS**）；**输出强制不含 `<script>`**（检测到即报 warning 并剔除该交互）；四态齐备（loading/empty/error/partial 由数据层注入）。

### C3 页面生命周期（pageStore）
- `createPageFromNl(nl)`：guardNlInput → parseNlToSchema → validatePageSchema → 存 draft（内存 Map，key=page_id）→ 返回 `{page, previewHtml}`。
- `publishPage(page_id)`：draft→published（**绝不自动覆盖人工页面**——发布须显式调用）。
- `revertPage(page_id)`：published→draft（可回退）。
- `listPages()`：所有 draft/published 页清单。
- 生成记录保留 `{nl原文, schema, confidence, notes}`（可解释/可追溯）。

---

## §D 接口边界（不越权）

- 消费方：`src/http/routes.js` 挂 `POST /api/page/from-nl`（guard→parse→validate→draft）与 `POST /api/page/:id/publish`；页面 HTML 由渲染器出（非手写页面）。MVP 不替换 `/` 静态页（保留现有 index.html 占位；NL→Page 页面挂 `/pages/:id` 预览）。
- 触发源：HTTP 调用（本子系统 MVP 无事件订阅；SSE 刷新留阶段 5 预警反馈子系统）。
- 不覆盖：真实 DB 持久化（pageStore 内存 Map，DB 表留 PG 环境/阶段 3）、MCP 双输出（v0.2 留后续）、LLM 解析（本子系统用确定性规则；LLM 解析留 LLM+Tools 管线）、相似页语义检索（ai-ontology-vector-build）。

---

## §E 测试与验收（承接前两子系统策略）

- **纯逻辑（本沙箱无 PG 可本地全绿）**：
  - `parseNlToSchema`：看板意图→dashboard；商机实体→CRM_DEAL；缺实体→confidence 0.3+needsClarification；金额→sum 聚合；「低于 X%」→highlight red。
  - `validator`：未知粒子（DEAL 旧值）→拒；stage 聚合→拒；存量 latest 校验；非白名单 Action→拒；navigation.to 非法→拒。
  - `guardNlInput`：注入 `<script>`/`onerror=`/`eval(`→拒；正常 NL→safe。
  - `renderer`：动态值转义（`<b>` 变 `&lt;b&gt;`）；输出无 `<script>`；data-action 声明式；四态注入；渲染前再校验失败→空结果+warning。
  - `pageStore`：createFromNl→draft→publish→revert 状态机；发布不覆盖人工页。
- **DB 集成（需 PG 就绪环境）**：pageStore DB 持久化表（`crm.page`，留阶段 3）。
- 验收判据对齐 SKILL 自检：三段式未破坏、三层护栏齐备、4 粒子护栏生效、旧粒子拒绝渲染、Action 白名单、无 `<script>`、四态齐备。

---

## §F 不做（YAGNI）

- ❌ DB 持久化 `crm.page` 表（阶段 3 或 PG 环境）。
- ❌ MCP 双输出 v0.2（workspace 页型+双输出同源）——本子系统 MVP 只做 v0.1（dashboard/table/form/detail/intake + 渲染器）。
- ❌ LLM 解析（确定性规则 MVP；LLM 留后续 LLM+Tools 管线）。
- ❌ 相似页语义检索（ai-ontology-vector-build 规划项）。
- ❌ 替换 `/` 静态页（保留现有门户占位）。

---

## §G 实施 Task 拆分（writing-plans 详）

- T1 schema.js 协议常量 + 值域 + Action 白名单
- T2 nlParser.js 解析映射（确定性规则）
- T3 validator.js 4 粒子校验 + navigation 强制
- T4 guardrails.js 输入层护栏
- T5 renderer.js 唯一渲染出口（转义/data-action/无 script/四态）
- T6 pageStore.js 页面生命周期 + routes 接线（POST /api/page/from-nl + publish）
- T7 测试聚合 + 文档收尾（设计文档状态行 + 总体设计 §8.6）

> 每 Task 一 commit；纯逻辑本地绿（无 PG 依赖）；DB 集成留阶段 3/PG 环境。

---

## §H 交付 commit 区间（实施后回填）

`T1..T7` 已实施，**（2026-08-25，阶段 2 子系统四）**：

| Task | commit | 内容 |
|---|---|---|
| T1 | `8f61989` | schema.js 协议常量+粒子值域+Action 白名单+CANONICAL_NAV |
| T2 | `c722fc5` | nlParser.js NL→Schema 确定性解析（意图→type/实体→粒子/指标→聚合/阈值→高亮/动作→按钮）+ 空格容忍 |
| T3 | `64401c6` | validator.js 4 粒子护栏（值域/状态仅 eq 不可聚合/快照仅 latest/Action 白名单）+ navigation 强制 |
| T4 | `16da3bf` | guardrails.js 输入层护栏（拦截 script/javascript:/on*/eval/iframe/img·svg 事件） |
| T5 | `c306b6b` | renderer.js 唯一渲染出口（校验+转义+四态+data-action 声明式，禁内联 script）+ 快照字段语义对齐 |
| T6 | `3e8db8c` | pageStore.js 页面生命周期（draft→publish→revert，注入拒绝不落库，内存 Map）+ routes 4 端点接线 |
| T7 | `（本文档回填，见上）` | 测试聚合 + 文档收尾 |

**验证**：`test/page.test.js` 31/31 全绿（纯逻辑，无 PG 依赖）。
**DB 持久化**（crm.page 表）留阶段 3/PG 环境；本子系统 pageStore 为内存 Map。