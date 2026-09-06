# 审批流配置页（item 17 / S22）设计文档

- 日期：2026-08-27
- 作者：WorkBuddy（设计先行，经 brainstorming 批准）
- 关联：B 组配置中心第 17 项（蓝图 S22）；`docs/superpowers/plans/2026-08-26-frontend-config-pages-master-plan.md`；`docs/superpowers/plans/2026-08-25-approval-flow-engine.md`（粒子引擎，独立）
- 范式对齐：刚建成的 RBAC（`src/portal/rbacMatrix.js` + `src/web/rbac.html`）与 business-tier（`src/portal/businessTier.js` + `src/web/business-tier.html`）配置页

---

## §0 背景与关键决策

### §0.1 发现：两套互相脱节的审批流实现
调研代码库后发现，当前存在两套互不相通的「审批流」实现：

1. **粒子模型（引擎唯一事实源）**：`CRM_APPROVAL_FLOW` + `CRM_APPROVAL_NODE / APPROVER / CONDITION / LINK / VERSION`（`src/particles/particleModel.js:148`；`src/approval/flow.js`；`src/approval/engine.js`）。这是「配置即粒子」原则的真源，但当前**无种子数据、无 UI、routes.js 未挂载任何审批流管理路由**。
2. **孤立的 `crm.approval_flow` 表**（`db/migrate-config.sql:26`）：`flow_id / name / description / stages JSONB / enabled`。由 S22.schema.js 注释指向 `createConfigRouter key='approvals'`，但该路由**未挂载于 routes.js**，引擎也**不读此表 / config_store** —— 是与运行态脱节的死表。

### §0.2 用户决策（2026-08-27 批准）
配置页管理 **`crm.approval_flow` 表**。

理由（用户侧）：与已建成的 RBAC / business-tier 配置页保持**同一范式**——每个配置中心项 = 专属表 + 专属 Router + 专属 portal 模块 + 专属 HTML 页 + 种子。配置中心保持同质化，不把审批流特殊化为粒子原生编辑。

### §0.3 已知限制（已闭环 ✅ 2026-08-31 方案 A 直写粒子）
- ~~该表与引擎粒子模型脱节，引擎不读此表~~ —— 已闭环：配置页存储后端从 `crm.approval_flow` 表改为直写 `CRM_APPROVAL_*` 粒子（`src/portal/approvalFlow.js` defaultDeps → `src/approval/flow.js` writeFlowFromStages），运行态引擎 `loadFlow` 按粒子 id 读取，单一事实源、零漂移。详见 `docs/2026-08-31-approval-flow-item17-wiring-design.md`。
- `crm.approval_flow` 表保留（不 DROP，禁删铁律），降级为只读兼容/审计。
- `crm.approval_flow` 表在 migrate-config.sql 已建，但**无种子、无路由、无页面**，本设计补全这三处。
- S22.schema.js 旧桩（`createConfigRouter key='approvals'` 注释）与本设计冲突，标记为**废弃**，本设计改用专属 Router（`createApprovalFlowRouter`），不依赖 config_store。

---

## §1 目标与范围
- **目标**：交付一个可列 / 可编辑 / 可保存的审批流配置页，管理 `crm.approval_flow` 表，含 G21 四审批域种子。
- **范围**：4 域流（deal / quote / contract / invoice）的列表、关卡（stages）编辑、启停、新增；写操作经决策第0闸。
- **非目标（YAGNI）**：不编辑粒子模型的 NODE/APPROVER/CONDITION/LINK 拓扑；不做流程可视化画布；不做与引擎运行态的实时同步。

---

## §2 数据模型

### §2.1 表结构（既有，migrate-config.sql:26）
```sql
CREATE TABLE IF NOT EXISTS crm.approval_flow (
  flow_id     TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  stages      JSONB NOT NULL,   -- [{stage, role, action, auto_allowed}]
  enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### §2.2 stages 元素结构
每个关卡为对象：`{ stage: string, role: string, action: string, auto_allowed: boolean }`
- `stage`：关卡名（如「销售经理」「总监」）
- `role`：审批角色（`sales` / `manager` / `finance` / `contract_admin` / `presales` / `admin`）
- `action`：`approve`（本版仅支持审批；预留 `review` / `sign`）
- `auto_allowed`：该关卡是否允许自动通过（默认 false）

### §2.3 种子（G21 四审批域）
写入 `db/seed.sql` 与 `db/test-setup.sql`（与 business-tier 种子同放置约定）：

| flow_id | name | stages（顺序） | enabled |
|---|---|---|---|
| `deal` | 商机审批流 | 销售经理(manager) → 总监(executive/未落地用 admin) | true |
| `quote` | 报价审批流 | 销售经理(manager) → 财务(finance) | true |
| `contract` | 合同审批流 | 售前(presales) → 合同管理员(contract_admin) | true |
| `invoice` | 发票审批流 | 财务(finance) → 合同管理员(contract_admin) | true |

> 注：代码实际角色集为 `sales/manager/finance/contract_admin/presales`（executive 在设计文档但未落地，见 MEMORY）。deal 第二关用 `admin` 占位以避免引入未落地角色；如用户要求可改。每流 2 关卡，`auto_allowed=false`。

---

## §3 后端 Router — `src/portal/approvalFlow.js` 内 `createApprovalFlowRouter`

完全镜像 `createRbacRouter`（`src/portal/rbacMatrix.js:147`）：
- `export function createApprovalFlowRouter(deps = {})`，默认依赖 `defaultDeps` 与注入 `deps` 合并。
- 暴露 `router.handlers = { list, get, put }` 供注入式测试（与 RBAC 一致）。

端点：
- `GET /api/approval-flows` → 全部行（`flow_id,name,description,stages,enabled`），`handlers.list`。
- `GET /api/approval-flows/:id` → 单流；不存在返回 404，`handlers.get`。
- `PUT /api/approval-flows/:id` → upsert（`name/description/stages/enabled`）；`handlers.put`：
  - 校验 `stages` 为数组，且每项含 `stage`(str)/`role`(str)/`action`(str)/`auto_allowed`(bool)；否则 400。
  - 写经**决策第0闸**：`produceDecision` 默认实现调用 `requireDecision('config-change', {flow_id, stages})`，失败时降级 `recordDecisionEvent('config_change', {trigger_context})`（与 rbacMatrix.js:136 同语义）。
  - 落库：`INSERT ... ON CONFLICT (flow_id) DO UPDATE`（upsert，无 DELETE）。
- **无 DELETE 端点**（铁律：绝对禁删）。

依赖注入结构（镜像 rbacMatrix.js:118-145）：
```js
const defaultDeps = {
  readList: async () => query(`SELECT * FROM crm.approval_flow ORDER BY flow_id`),
  readOne: async (id) => query(`SELECT * FROM crm.approval_flow WHERE flow_id=$1`, [id]),
  upsert:   async (row) => query(`INSERT INTO crm.approval_flow (flow_id,name,description,stages,enabled,updated_at) VALUES ($1,$2,$3,$4,$5,now()) ON CONFLICT (flow_id) DO UPDATE SET name=$2,description=$3,stages=$4,enabled=$5,updated_at=now()`, [...]),
  produceDecision: async (ctx) => { try { const r = await requireDecision('config-change', ctx||{}); return {decisionId:r.decision_id||null, ok:!!r.decision_id}; } catch { await recordDecisionEvent('config_change',{trigger_context:ctx}); return {decisionId:null, ok:true}; } },
};
```

---

## §4 Portal 渲染模块 — `src/portal/approvalFlow.js`

纯函数（浏览器 + vitest 共用，无副作用）：
- `renderApprovalFlows(flows)` → 流列表 HTML 表格；每行可展开 `stages` 编辑器；含启停开关与「保存」按钮。
- `renderStages(stages)` → 关卡行（`stage` / `role` / `action` / `auto_allowed` 开关）。
- `approvalFlowSummary(flows)` → 概要：流数 / 启用数 / 关卡总数。
- `DOMAIN_LABEL` 映射：`deal→商机` / `quote→报价` / `contract→合同` / `invoice→发票`。
- `ROLE_LABEL` 映射：`sales→销售` / `manager→经理` / `finance→财务` / `contract_admin→合同管理员` / `presales→售前` / `admin→管理员`。

---

## §5 页面 — `src/web/approval-flow.html`

- 载入 `/portal/approvalFlow.js`（module，`Content-Type: text/javascript`），调用 `renderApprovalFlows` 渲染。
- `DOMContentLoaded`：fetch `/api/approval-flows` → 渲染；「保存」→ `PUT /api/approval-flows/:id`（body 含 `stages`）；成功提示。
- 「新增流」：生成 `flow_id` 草稿行（空 stages），保存即 upsert 新建。
- 纯前端，**无轮询**（与 RBAC / business-tier 一致；配置页非实时）。

---

## §6 路由挂载 — `src/http/routes.js` 改动

镜像 RBAC 挂载块（routes.js:30-31,57-58,781-788）：
1. `import { createApprovalFlowRouter } from '../portal/approvalFlow.js';`（置于 line 31 附近）
2. `app.use(createApprovalFlowRouter({}));`（置于 line 58 附近）
3. `app.get('/approval-flow', (req,res)=> res.redirect('/approval-flow.html'));`
4. `app.get('/approval-flow.html', (req,res)=> res.sendFile(...'../web/approval-flow.html'...));`
5. `app.get('/portal/approvalFlow.js', (req,res)=> res.sendFile(...'../portal/approvalFlow.js'..., {headers:{'Content-Type':'text/javascript'}}));`

---

## §7 配置中心集成
- `src/portal/configCenter.js` 的 `CONFIG_ITEMS`（18 项）中 S22（审批流配置）卡片，将其 `to` 指向 `/approval-flow`（若当前为占位/未接，则修正）。
- `src/page/schema.js:63` 已含 `/config/approvals`；保留导航可达性（或改为指向 `/approval-flow`，二选一，实现时取 `/approval-flow` 以保证单一入口）。

---

## §8 测试（TDD：先 RED 后 GREEN）

新增 `test/web/approvalFlow.test.js`（vitest，globals OFF，需 `import { test, expect } from 'vitest'`）：
- Portal 渲染（约 8 例）：列表渲染 / 关卡渲染 / 概要统计 / 域标签 / 角色标签 / 空 stages / 启停态展示 / 新增草稿行结构。
- Router handler 注入测试（约 6 例）：`list` 返回全部 / `get` 命中与 404 / `put` upsert 新建 / `put` upsert 更新 / `put` 校验失败 400 / `put` 经决策闸（注入 `produceDecision` 断言被调用）。

基线：当前 web 测试 44/44 绿 → 本设计后 ≈ 58/58 绿。

---

## §9 验收口径
1. `npm test` 全绿（web 套件 44 → ≈ 58）。
2. `npm start` 后访问 `/approval-flow` 可列出 G21 四流，编辑 stages 后保存生效（DB 落库）。
3. `/config` 页 S22 卡片可跳转至 `/approval-flow`。
4. 写操作经决策第0闸（注入测试断言 `produceDecision` 被调用；无决策不写）。
5. 无 DELETE 端点（routes 仅 list/get/put）。

---

## §10 风险与已知限制
- **表↔引擎脱节**（§0.3）：~~本页改动不实时影响运行态~~ —— 已闭环（2026-08-31 方案 A）：配置页直写 `CRM_APPROVAL_*` 粒子，运行态引擎直接消费，无需同步桥或引擎改读表。
- **角色集不一致**：代码实际角色无 `executive`，deal 第二关用 `admin` 占位（§2.3 注）。
- **S22.schema.js 旧桩废弃**：不与本设计冲突，但需明确不挂载 `createConfigRouter key='approvals'`。

---

## §11 自检结论（写后内审）
- 占位扫描：无 TBD / TODO；种子角色已明确（admin 占位已说明）。
- 内部一致性：§3 端点与 §6 挂载、§4 函数与 §5 调用一致。
- 范围检查：单实现计划可覆盖（列表/编辑/启停/新增 + 种子 + 测试），无需再分解。
- 歧义检查：`stages` 结构、决策闸语义、无 DELETE 均唯一明确。

---

## §12 后续（writing-plans 阶段细化）
- 任务拆分：①写失败测试 RED → ②`approvalFlow.js`(render+router) → ③`approval-flow.html` → ④routes 挂载 → ⑤种子 → ⑥冒烟 → ⑦工作日志。
- 每 Task 一 commit（用户本地执行）。
