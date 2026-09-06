# 全站死信息活体化设计（reasoning-trace 服务端算真状态 + S35 外部工商采集闭环）

- 日期：2026-08-29
- 状态：P6 已写，待 P7 自检 + P8 用户评审
- 决策链：用户「B」（reasoning-trace 服务端算真状态）→「A」（外部采集手动同步+读链路补齐）→「完整 P4 呈现+契约」
- 关联：docs/specs/2026-08-29-agent-roster-4-agent-design.md（执行智能体 4 体）

## §0 背景与问题

全仓 8 处 reasoning-trace 组件中 7 处是**静态占位**——schema 里把 `status: 'ok'/'warn'/'pending'` 写死，handler 原样回传（或 S30 由渲染器 fallback 渲染），页面展示「看着是推理链、实则恒绿/恒灰」，无真实数据驱动。另有 4 处 `data_origin:'external'` 的 attr-field 呈现「待外部源接入（只读）」占位。

已修（P0，本轮前）：S09 `'reasoning-trace': {}` 空对象 → 回传 schema steps，恢复渲染。

## §1 目标

1. 7 处静态 reasoning-trace 改为**服务端按真实数据算状态**（方案 B，无前端 SSE 基建）。
2. S35 客户工商信息 attr-field 补齐「读链路 value 注入」+「写链路手动同步触发」，形成外部采集闭环。
3. 其余 3 处外部 attr-field（S06/S12/S16）读链路已存在，本轮只标注、不新增触发（范围收敛，后续立项）。

## §2 现状核实（file:line 证据）

### reasoning-trace 8 处
| 页面 | schema 位置 | handler 注入 | 现状 |
|---|---|---|---|
| S02 作战室 | S02.schema.js:49-55 | routes.js:645 回传写死 steps | 死（能渲染） |
| S03 工作台·详情 | S03.schema.js:54-61 `live:true` | routes.js:710 回传 + SSE trace | **活（示范）** |
| S06 客户360 | S06.schema.js:43-50 | routes.js:873 回传写死 steps | 死（能渲染） |
| S07 商机详情 | S07.schema.js:34-39 | routes.js:1161 回传写死 steps | 死（能渲染） |
| S09 合同详情 | S09.schema.js:27-34 | routes.js:1257 回传（P0 已修空对象） | 死（能渲染） |
| S14 决策图 | S14.schema.js:27-32 | routes.js:531-532 回传写死 steps | 死（能渲染） |
| S30 决策市场 | S30.schema.js:25-30 | controlledConfigPages.js 无注入，renderer.js:372 fallback | 死（能渲染） |
| S35 客户洞察 | S35.schema.js:132-139 | routes.js:1000-1001 回传写死 steps | 死（能渲染） |

### 外部采集 attr-field 4 处
| 页面 | 字段 | 声称来源 | 读链路 | 现状 |
|---|---|---|---|---|
| S06 客户360:19 | industry 所属行业 | 工商 0.92 | **已注入**（routes.js:867） | 缺外部写入触发 |
| S12 发票:14 | invoice_no 发票号 | 税务 0.98 | **已注入**（routes.js:1392） | 缺外部写入触发 |
| S16 LLM 配置:17 | api_key | secret-vault 0.99 | **已注入**（createConfigRouter secretFields，routes.js:118） | 缺外部写入触发（secret 既有加密存储） |
| S35 客户洞察:129-130 | biz 客户工商信息 | 工商 0.92 | **未注入**（routes.js:1000 无 attr-field 键） | **真正死** |

### 连接器现状
- `src/connectors/connectorActions.js:16-93`：`conn-attio-enrich-account` / `conn-zhizao-verify-account` 已注册，机制完备（写第0闸 autoDecision mint decision、sourcedFrom 弱边、F18 抬头校验 `sales/businessTitle.js`）。
- **无任何定时/手动触发接线**——这是外部采集「死」的共同根因。
- `conn-tender-push`（tenderConnector.js）已存在，本轮不涉及。

## §3 设计

### §3.1 reasoning-trace 服务端算真状态（方案 B）

新增纯函数模块 `src/page/reasoningSteps.js`，导出：

- `buildReasoningSteps(schemaSteps, facts)` —— 通用判定入口：对每个 schema step 按其 `label`/`key` 命中 facts 判定表，返回 `{status, label}` 数组。
- 每页一个 facts 收集函数（在各自 handler 内组装），判定规则表集中一处：

| Page | step 1 | step 2 | step 3 | 判定事实源（handler 已有） |
|---|---|---|---|---|
| S02 | 意图解析 | 上下文装配 | 切入建议 | task 队列（getTasks）：有任务→意图 ok；任务有 context→上下文 ok；有可行动→切入 pending→ok |
| S06 | 画像装配 | 七维校验 | 洞察建议 | p 字段非空→画像 ok；seven-dim 覆盖→七维 ok/warn；tasks 非空→洞察 ok 否则 idle |
| S07 | MEDDICC 评估 | 决策历史 | 推进建议 | deal payload MEDDICC 字段→ok/warn；决策历史项(decision trace)→ok/warn；有跟进任务→pending 否则 idle |
| S09 | 条款解析 | 回款风险 | 修订建议 | 合同条款（contract.payload）→ok；有逾期 plan→warn 否则 ok；有逾期→pending 否则 idle |
| S14 | 决策加载 | 关联展开 | 因果链 | decision 非空→ok；有边→ok；有 trace→ok |
| S30 | 覆盖度加载 | 先例匹配 | 偏差分析 | decision 行→ok；有 precedent→ok；有例外→warn 否则 idle |
| S35 | 聚合四源 | 权限裁剪 | 生成建议 | timelineSources 非空→ok；role 命中 FIELD_PERMS→ok；tasks 非空→ok 否则 idle |

**判定状态四态**（对齐 renderer 语义）：`ok`（绿）/ `warn`（黄）/ `pending`（进行中）/ `idle`（未触发）。

**各 handler 改动**（`routes.js` 7 处 + `controlledConfigPages.js` S30 1 处）：
- 每页 handler 在组装 `data.components['reasoning-trace']` 处，用 `buildReasoningSteps(schemaSteps, facts)` 替换「原样回传」。
- S30 特殊：`controlledConfigPages.js` S30 项补 `reasoningSteps(data)` 注入（工厂不注入 trace 需加一次）。

### §3.2 S35 外部工商采集闭环

**读链路**（routes.js:1000-1001）：`data.components` 增加
```js
'attr-field': { biz: { value: account.payload?.business_title || '' , verified: account.payload?.business_verified === true } },
```
有值后 renderer.js:405-406 自动切「外部源已同步（只读）」。

**写链路触发**：新增端点 `POST /api/connector/zhizao-verify`（admin/sysadmin 闸，复用既有 auth 中间件）→ `actionExecutor.dispatch('conn-zhizao-verify-account', { account_id, verification })`。
- 复用既有 action 完整机制：第0闸 autoDecision mint decision → updateParticle 写 `business_title/business_verified` → sourcedFrom 边落 `relation_confidence` → F18 抬头校验。
- 一次一问澄清过：手动同步按钮（非定时）。前端 S35 页加「同步工商」按钮（POST 该端点，成功后 reload 页面数据）。

**其余 3 处**（S06/S12/S16）：读链路已存在，本轮标注「已有 value 注入，外部触发待接」；不进本轮清单（防范围膨胀，后续单独立项接真实 API 时统一处理）。

### §3.3 范围外（YAGNI）
- 不引入前端 SSE（A 方案否决）。
- 不接真实企查查/爱企查 API（外部依赖独立立项）。
- 不改 S03（live 示范保持）。
- 不做定时采集（用户选手动）。

## §4 测试计划（TDD）

- `test/page/reasoningSteps.test.js`：7 页判定纯函数各 3-6 例（含空数据→idle、逾期→warn 边界）。
- 端点回归：`/api/page/home`、`/api/page/account-360`、`/api/page/account-insight`、`/api/page/deal-detail`、`/api/page/contract-detail`、`/api/page/decision-graph`、`/api/page/decision-market`（S30）。
- 端到端验证：`data.components['reasoning-trace'].steps` 的 status 不再全 `ok` 写死。
- 连接器验证：`POST /api/connector/zhizao-verify` → 断言 `business_title` 落库 + `sourcedFrom` 边 + decision 行。

## §5 Task 拆分（8 Task，每 Task 一 commit）

### Task 1 — `src/page/reasoningSteps.js` 判定内核
```contract-yaml
- task: "实现 reasoningSteps 判定内核"
  agent: quote-engine
  skills: [method-quote-engine]
  memory: [quote-engine]
  knowledge_scope: { layers: [L1], max_hops: 3 }
  success: "test/page/reasoningSteps.test.js 覆盖 7 页判定纯函数，空数据→idle、逾期→warn 边界用例通过"
```
**契约说明：** 由 `quote-engine` 承接，调用 `method-quote-engine` SKILL、读取 `quote-engine` 记忆（L1，≤3 跳）；成功标准为判定内核纯函数测试通过，含 7 页映射、空数据/逾期边界。

### Task 2 — S02 作战室 trace 活体化
```contract-yaml
- task: "S02 reasoning-trace 服务端算真状态"
  agent: intake-router
  skills: [method-intake-routing]
  memory: [intake-router]
  knowledge_scope: { layers: [L1], max_hops: 3 }
  success: "GET /api/page/home 返回 reasoning-trace steps，status 按真实 task 队列判定（非全 ok 写死）"
```
**契约说明：** 由 `intake-router` 承接，调用 `method-intake-routing` SKILL、读取 `intake-router` 记忆（L1，≤3 跳）；成功标准为 `/api/page/home` 的 trace steps 状态由任务队列真实驱动。

### Task 3 — S06 客户360 trace 活体化
```contract-yaml
- task: "S06 reasoning-trace 服务端算真状态"
  agent: followup-agent
  skills: [method-followup-engine]
  memory: [followup-agent]
  knowledge_scope: { layers: [L1], max_hops: 3 }
  success: "GET /api/page/account-360 返回 reasoning-trace steps，七维校验/洞察建议按真实数据判定"
```
**契约说明：** 由 `followup-agent` 承接，调用 `method-followup-engine` SKILL、读取 `followup-agent` 记忆（L1，≤3 跳）；成功标准为 `account-360` 的 trace 由画像/覆盖/tasks 真实驱动。

### Task 4 — S07 商机 trace 活体化
```contract-yaml
- task: "S07 reasoning-trace 服务端算真状态"
  agent: review-gate
  skills: [method-review-gate]
  memory: [review-gate]
  knowledge_scope: { layers: [L1], max_hops: 4 }
  success: "GET /api/page/deal-detail 返回 reasoning-trace steps，MEDDICC/决策历史/推进建议按真实数据判定"
```
**契约说明：** 由 `review-gate` 承接，调用 `method-review-gate` SKILL、读取 `review-gate` 记忆（L1，≤4 跳）；成功标准为 `deal-detail` 的 trace 由 MEDDICC/决策历史字段与跟进任务真实驱动。

### Task 5 — S09 合同 trace 活体化
```contract-yaml
- task: "S09 reasoning-trace 服务端算真状态"
  agent: followup-agent
  skills: [method-followup-engine]
  memory: [followup-agent]
  knowledge_scope: { layers: [L1], max_hops: 3 }
  success: "GET /api/page/contract-detail 返回 reasoning-trace steps，回款风险按逾期计划判定 warn/ok"
```
**契约说明：** 由 `followup-agent` 承接，调用 `method-followup-engine` SKILL、读取 `followup-agent` 记忆（L1，≤3 跳）；成功标准为 `contract-detail` 的「回款风险」按逾期计划真实判定 warn/ok。

### Task 6 — S14 + S30 trace 活体化
```contract-yaml
- task: "S14/S30 reasoning-trace 服务端算真状态"
  agent: review-gate
  skills: [method-review-gate]
  memory: [review-gate]
  knowledge_scope: { layers: [L1], max_hops: 4 }
  success: "GET /api/page/decision-graph 与 /api/page/decision-market 返回 reasoning-trace steps 按真实决策网络判定"
```
**契约说明：** 由 `review-gate` 承接，调用 `method-review-gate` SKILL、读取 `review-gate` 记忆（L1，≤4 跳）；成功标准为决策图/决策市场的 trace 由真实 decision/边/例外驱动。

### Task 7 — S35 客户洞察 trace 活体化
```contract-yaml
- task: "S35 reasoning-trace 服务端算真状态"
  agent: followup-agent
  skills: [method-followup-engine]
  memory: [followup-agent]
  knowledge_scope: { layers: [L1], max_hops: 3 }
  success: "GET /api/page/account-insight 返回 reasoning-trace steps，聚合/裁剪/建议按真实数据判定"
```
**契约说明：** 由 `followup-agent` 承接，调用 `method-followup-engine` SKILL、读取 `followup-agent` 记忆（L1，≤3 跳）；成功标准为 `account-insight` 的 trace 由 timeline/role/tasks 真实驱动。

### Task 8 — S35 外部工商采集闭环
```contract-yaml
- task: "S35 工商字段读链路+手动同步触发"
  agent: intake-router
  skills: [method-intake-routing]
  memory: [intake-router]
  knowledge_scope: { layers: [L1], max_hops: 3 }
  success: "POST /api/connector/zhizao-verify 写入 business_title + sourcedFrom 边 + decision 行；GET /api/page/account-insight 的 attr-field.biz.value 非空"
```
**契约说明：** 由 `intake-router` 承接，调用 `method-intake-routing` SKILL、读取 `intake-router` 记忆（L1，≤3 跳）；成功标准为手动同步端点写入工商字段落库、读链路 value 注入生效、外部采集闭环贯通。

## §6 风险与边界

- **判定语义需 reviewer 逐页校准**：各页 steps 的 label 语义（七维校验/回款风险/偏差分析）由真实数据驱动后，可能出现「无数据→idle」而非恒绿——这是预期行为，不是回归。
- **S30 工厂注入是唯一新增注入点**：controlledConfigPages.js 目前不注入 trace，需补一次；其余同构页面（S31-S33 等无 trace）不受影响。
- **连接器端点鉴权**：`POST /api/connector/zhizao-verify` 必须 admin/sysadmin 闸（写通道纪律），sales 不可直接触发外部写入。

## §7 闭环回写
| Task | skill 缺口 | memory 缺口 | success 缺口 |
|---|---|---|---|
| T1 | — | — | — |
| T2 | — | — | — |
| T3 | — | — | — |
| T4 | — | — | — |
| T5 | — | — | — |
| T6 | — | — | — |
| T7 | — | — | — |
| T8 | — | — | — |
（执行后由 agent-workbench 监控回写 `*.feedback.json` 同步此表）