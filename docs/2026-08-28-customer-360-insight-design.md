# 客户 360 深度洞察页设计文档

> 状态：已批准（brainstorming → writing-plans 待进入实现）
> 日期：2026-08-28
> 范围：升级现有 account-360 摘要页 + 新增 account-insight 深度洞察页
> 关联：src/web/account-360.html、src/http/routes.js、src/pages/S06.schema.js、src/page/renderer.js

---

## §0 结论

1. **双页分离**：保留 `account-360.html` 作为客户 360 摘要入口；新增 `account-insight.html`（路由 `/accounts/:id/insight`）承载深度洞察。
2. **洞察页 4 Tab**：时间线、任务线、交易链、决策链（AI 洞察作为 reasoning-trace 贯穿各 Tab）。
3. **权限双闸**：数据范围（roleProfiles.js data_scope）+ 字段级（schema attr-field perm 属性）。
4. **复用现有组件**：不新增 renderer 组件类型，时间线用 table/subtable，交易链用 subtable/metric-card。
5. **测试加码**：除单元测试外，增加浏览器端到端测试覆盖权限与跨页跳转。

---

## §1 背景与目标

### 1.1 现状

现有 `account-360.html` 已对接 `/api/page/account-360`，渲染 S06 schema，展示：
- 客户名称、行业、状态（attr-field，带四查徽标）
- 七维画像卡（身份/结构/语义/时间与配置/决策历史/运营状态/治理）
- 关联商机/联系人子表

但截图中大量区域显示「暂无数据」，且没有时间线、任务线、完整 L2C 交易链、决策链，也未按角色区分可见性。

### 1.2 目标

按客户维度进行洞察：
- **时间线**：聚合业务事件、记忆流水、决策记录、外部采集，按时间倒序展示。
- **任务线**：展示待办任务、跟进计划、历史任务。
- **交易信息**：完整回顾 L2C 链路（商机 → 报价 → 合同 → 订单 → 回款 → 发票）。
- **决策信息**：涉及该客户的决策事件、先例引用、审批链路。
- **最新状态**：摘要页顶部展示客户健康度、最近事件、下一步建议。
- **权限分离**：按角色控制可见客户/单据范围，以及敏感字段的隐藏/只读。

---

## §2 信息架构

### 2.1 页面结构

```
account-360.html（摘要页）
  ├─ 顶部：客户名称 / 行业 / 状态（四查徽标）
  ├─ 七维画像卡（精简，仅展示完整度）
  ├─ 最新状态区：最近事件 3 条 + 下一步 AI 建议
  └─ 快捷入口：「查看深度洞察」→ /accounts/:id/insight

account-insight.html（洞察页）
  ├─ 顶部：客户名称 + 返回摘要 + 当前角色提示
  ├─ Tab 导航：时间线 | 任务线 | 交易链 | 决策链
  ├─ Tab 内容：
  │   时间线：table（时间/类型/来源/摘要/关联实体）
  │   任务线：subtable（任务/状态/截止/执行者）
  │   交易链：subtable（阶段/单据/金额/状态）+ metric-card 汇总
  │   决策链：subtable（决策/场景/状态/先例）+ reasoning-trace
  └─ AI 洞察卡：基于聚合数据的下一步建议
```

### 2.2 路由

| 页面 | 路由 | 文件 |
|---|---|---|
| 摘要页 | `/account-360.html?id=` 或 `/accounts/:id` | `src/web/account-360.html` |
| 洞察页 | `/account-insight.html?id=` 或 `/accounts/:id/insight` | `src/web/account-insight.html` |
| 摘要 API | `GET /api/page/account-360?accountId=` | `src/http/routes.js` |
| 洞察 API | `GET /api/page/account-insight?accountId=` | `src/http/routes.js` |

---

## §3 数据模型与来源

### 3.1 主数据：particles

| 粒子类型 | 关联字段 | 用途 |
|---|---|---|
| `CRM_ACCOUNT` | `id` | 客户本体 |
| `CRM_CONTACT` | `payload.account_id` | 联系人 |
| `CRM_DEAL` | `payload.account_id` | 商机 |
| `CRM_QUOTATION` | `payload.account_id` 或 `payload.deal_id` → 回查 account | 报价 |
| `CRM_CONTRACT` | `payload.account_id` | 合同 |
| `CRM_ORDER` | `payload.account_id` 或 `payload.contract_id` → 回查 | 订单 |
| `CRM_PAYMENT_PLAN` | `payload.account_id` / `contract_id` | 回款计划 |
| `CRM_PAYMENT_RECORD` | `payload.account_id` / `contract_id` | 回款记录 |
| `CRM_INVOICE` | `payload.account_id` / `contract_id` | 发票 |
| `CRM_TECHNICAL_PROPOSAL` | `payload.account_id` / `deal_id` | 技术方案 |

### 3.2 事件数据

| 来源表 | 关联方式 | 用途 |
|---|---|---|
| `crm.events` | `payload.account_id` / `deal_id` / `contract_id` / `order_id` | 业务事件、SSE 流水 |
| `crm.tasks` | `payload.account_id` 或上下文推断 | 待办/历史任务 |
| `crm.decision` | `decision_event` 表关联 | 决策记录 |
| `crm.memory_log` | `topic='account:{id}'` 或 `payload.account_id` | 记忆沉淀、拜访摘要 |
| `crm.decision_precedent_rel` | 通过 decision_id 多跳 | 先例网络 |

### 3.3 时间线条目生成规则

从上述来源抽取统一结构：

```js
{
  ts: ISOString,           // 排序键
  type: 'event'|'task'|'decision'|'memory'|'external',
  title: '事件标题',
  source: '人工'|'规则'|'AI'|'外部采集',
  actor: 'system'|'sales'|...,
  entityType: 'CRM_DEAL'|...,
  entityId: '...',
  summary: '摘要',
}
```

去重：同一秒内同 type 同 entityId 合并为一条。
排序：按 `ts` 倒序。

---

## §4 权限模型

### 4.1 数据范围（data_scope）

复用 `src/context/roleProfiles.js` 已落地的六角色配置：

| 角色 | data_scope.model | 可见范围 |
|---|---|---|
| sales | self | 仅 owner_id = 自己的客户/商机 |
| manager | org_subtree | 本人组织子树内所有客户 |
| exec | all | 全量 |
| finance | domain: [payment, contract, invoice] | 仅 payment/contract/invoice 域粒子 |
| presales | domain: [CRM_DEAL, CRM_TECHNICAL_PROPOSAL] | 仅 DEAL/技术方案 |
| contract_admin | domain: [contract, invoice] | 仅合同/发票 |

实现：复用 `enforceScope` 与 `scopePredicate`，在 `/api/page/account-insight` 查询时过滤 particles 与关联实体。

### 4.2 字段级权限

在 S06/S35 schema 的 `attr-field` 组件上增加 `perm` 属性：

```js
{ kind: 'attr-field', attrSlug: 'payment_amount', perm: 'finance_only', ... }
```

后端 `accountInsightHandler` 根据当前角色把 `perm` 解析为：
- `visible`：正常渲染
- `readonly`：只读展示
- `hidden`：不输出该组件

敏感字段映射（首版）：

| 字段 | sales | manager | exec | finance | presales | contract_admin |
|---|---|---|---|---|---|---|
| 回款金额 | hidden | readonly | visible | visible | hidden | readonly |
| 成本价/折扣 | hidden | hidden | visible | readonly | hidden | hidden |
| 合同金额 | readonly | visible | visible | visible | readonly | visible |
| 客户工商信息 | readonly | visible | visible | visible | readonly | visible |

renderer 已在 `renderAttrField` 中支持 `data-perm="hidden"` 渲染锁定提示，本设计扩展为服务端直接剔除 hidden 字段。

---

## §5 后端 API 设计

### 5.1 新增端点

```
GET /api/page/account-insight?accountId=<id>&tab=timeline|tasks|transactions|decisions
```

返回：

```json
{
  "schema": { /* S35 schema */ },
  "data": { /* components 数据 */ },
  "html": "<div class='pg-page'>...</div>",
  "warnings": [],
  "accountId": "...",
  "role": "sales"
}
```

### 5.2 handler 流程

```
1. 鉴权：从 Authorization 头解析 token → role
2. 加载 account：queryParticles({ type: 'CRM_ACCOUNT', id })
3. 数据范围过滤：enforceScope + scopePredicate
4. 加载关联实体：按 §3.1 并行查询并过滤
5. 按 Tab 聚合：
   - timeline：合并 events/tasks/decision/memory_log → table rows
   - tasks：kanban tasks + 跟进计划 → subtable
   - transactions：L2C 链 → subtable + metric-card 汇总
   - decisions：decision + precedent_rel → subtable + reasoning-trace
6. 字段级过滤：按 role 标记 hidden/readonly
7. 构建 S35 schema
8. renderPage(schema, data) → html
9. 返回 JSON
```

### 5.3 升级现有 /api/page/account-360

- 精简为只输出摘要信息：客户属性、七维画像、最新 3 条事件、AI 建议、洞察入口按钮。
- 移除现有的「关联商机/联系人」子表（迁移到洞察页）。
- 后端 handler 抽取公共函数 `loadAccountWithScope()` 供两个端点复用。

---

## §6 前端 Schema 设计

### 6.1 S06 摘要页 schema（精简版）

```js
{
  type: 'detail',
  title: '客户 360',
  navigation: { to: '/accounts/:id' },
  layout: { columns: 3, theme: 'light' },
  components: [
    { kind: 'attr-field', attrSlug: 'name', label: '客户名称', attr: { data_origin: 'manual' } },
    { kind: 'attr-field', attrSlug: 'industry', label: '所属行业', attr: { data_origin: 'external' } },
    { kind: 'attr-field', attrSlug: 'status', label: '客户状态', attr: { data_origin: 'rule' } },
    { kind: 'metric-card', title: '身份' },
    { kind: 'metric-card', title: '结构' },
    { kind: 'metric-card', title: '语义' },
    { kind: 'metric-card', title: '运营状态' },
    { kind: 'table', title: '最新动态', dataBinding: { columns: ['ts', 'type', 'title'] } },
    { kind: 'reasoning-trace', title: 'AI 建议', steps: [...] },
    { kind: 'goal-form', action: 'navigate-insight', placeholder: '查看深度洞察' }
  ]
}
```

### 6.2 S35 洞察页 schema

```js
{
  type: 'workspace',
  title: '客户洞察',
  navigation: { to: '/accounts/:id/insight' },
  layout: { columns: 1, theme: 'light' },
  components: [
    {
      kind: 'select',
      name: 'insight_tab',
      label: '视图',
      defaultValue: 'timeline',
      options: [
        { value: 'timeline', label: '时间线' },
        { value: 'tasks', label: '任务线' },
        { value: 'transactions', label: '交易链' },
        { value: 'decisions', label: '决策链' }
      ]
    },
    { kind: 'table', title: '时间线', dataBinding: { columns: ['ts', 'type', 'title', 'source', 'actor'] } },
    { kind: 'subtable', title: '任务线', mainColumn: 'task', subColumns: ['status', 'due', 'actor'], subRows: 'details' },
    { kind: 'subtable', title: '交易链', mainColumn: 'stage', subColumns: ['doc', 'amount', 'status'], subRows: 'items' },
    { kind: 'metric-card', title: '交易总金额' },
    { kind: 'metric-card', title: '回款率' },
    { kind: 'subtable', title: '决策链', mainColumn: 'decision', subColumns: ['scenario', 'state', 'precedent'], subRows: 'links' },
    { kind: 'reasoning-trace', title: 'AI 洞察', steps: [...] }
  ]
}
```

### 6.3 Tab 切换交互

- 首版用 `select` 组件切换 Tab，前端 JS 根据 `data-select` 的值显示/隐藏对应 `pg-table/pg-subtable`。
- 后续可扩展为 `tabs` 组件，但首版避免新增 renderer 组件类型。

---

## §7 错误处理

| 场景 | 行为 |
|---|---|
| accountId 缺失 | 返回 `state: 'empty'`，提示「请选择客户」 |
| accountId 不存在 | 返回 `state: 'empty'` |
| 越权访问 | HTTP 403，`{ error: 'scope_violation', gate: 'scope', reason: '...' }` |
| 部分数据源失败 | 返回 `partial` 状态 + `warnings` 数组，不阻断其他数据渲染 |
| renderPage 失败 | 返回 `{ error, schema, data }`，前端显示错误状态 |

---

## §8 测试策略

### 8.1 单元测试（vitest）

新增测试文件 `test/account-insight.test.js`：

1. **scope 过滤**：sales 只能查看 owner_id 匹配自己的 account 及关联 deal。
2. **字段级权限**：finance 可见回款金额，sales 不可见。
3. **时间线排序**：多源事件按时间倒序，同秒同实体去重。
4. **交易链汇总**：L2C 各阶段数量、金额、回款率计算正确。
5. **schema 校验**：S35 schema 通过 `validatePageSchema`。

### 8.2 集成测试

1. `/api/page/account-insight` 返回 schema + data + html。
2. `/api/page/account-360` 返回精简摘要。
3. 越权请求返回 403。

### 8.3 浏览器端到端测试

新增 `test-e2e/account-insight.spec.js`（Playwright）：

1. 登录 sales 角色 → 访问 `/account-360.html?id=xxx` → 可见摘要 → 点击「查看深度洞察」→ 跳转 `/account-insight.html?id=xxx`。
2. 验证时间线表格有数据、任务线子表渲染、交易链金额字段对 sales 隐藏。
3. 登录 finance 角色 → 访问同一客户洞察页 → 验证回款金额可见。

---

## §9 实施拆分（待 writing-plans 展开）

1. **Task A**：公共函数 `loadAccountWithScope(accountId, role)` + 关联粒子加载/过滤。
2. **Task B**：升级 `/api/page/account-360` 为精简摘要 schema（S06 精简版）。
3. **Task C**：新增 `/api/page/account-insight` 与 S35 schema，实现 4 Tab 数据聚合。
4. **Task D**：新增 `src/web/account-insight.html` 与 Tab 切换交互。
5. **Task E**：摘要页增加「查看深度洞察」入口按钮。
6. **Task F**：字段级权限映射表落地，renderer 支持 readonly/hidden。
7. **Task G**：单元测试 + 集成测试 + 浏览器 E2E 测试。

---

## §10 自查

- 无占位符、无矛盾。
- 范围明确：双页 + 4 Tab + 权限双闸 + 测试。
- 复用现有 renderer 组件，不新增组件类型。
- 后端端点与现有 routes.js 模式一致（/api/page/* + renderPage）。
