# 设计文档：合并两套待办页 →「我的待办」中心

> 状态：已批准（brainstorming 阶段，待转 writing-plans）
> 日期：2026-08-28
> 触发：用户截图反馈「待办为空 + 分不清待办/审批区别」
> 关联任务：`@skill:brainstorming` 流程 Task #1-#4

## §0 结论（先行）

将现有两套重叠的待办页——`todo.html`(S05，四角色视角) 与 `workbench.html`(S33，四审批视角)——**合并为单一「我的待办」中心** `/my-todo.html`，以当前登录人为中心统一为五视角（待我审批 / 我处理的 / 我发起的 / 抄送我的 / 待跟进）。

同步修复 `workbenchRouter.js` 的 **actor 角色匹配 bug**（确凿根因），并按 **`role:admin` / `role:sales`** 对齐演示种子数据（不动账号体系），使开箱即有数据、概念不再混淆。

## §1 用户困惑与问题陈述

用户截图反馈两点：
1. **待办页数据为空**（视图全空，无法操作）。
2. **分不清「待办」与「审批」的区别**。

概念澄清（不是 bug，是入口设计导致的认知重叠）：
- **审批（approval）** = 一个业务流程/引擎（HITL 审批流动作）；业务单提交时触发，生成 `CRM_APPROVAL_TASK` + `CRM_APPROVAL_INSTANCE`。
- **待办（todo）** = 用户视角的**聚合收件箱**（"需要我处理的事"）；审批任务只是待办的一种**来源**。
- 现状把两者拆成两个独立菜单项（`layoutMenu.js` 协同分组「审批」→ `/workbench.html`、「待办」→ `/todo.html`），且 workbench 的"待我审批"本质就是"待办"的一种 → 直接造成用户的混淆与"一个空一个满"的割裂感。

## §2 现状证据（代码 + 实测数据，2026-08-28）

两套入口（导航层概念重叠）：
- `src/portal/layoutMenu.js`：`协同 › 审批` → `/workbench.html`（S33 四视角）
- `src/portal/layoutMenu.js`：`协同 › 待办` → `/todo.html`（S05 四角色视角）

实测数据（直连 DB + 接口）：
- `CRM_APPROVAL_TASK` 共 **4 条，全部 `status=APPROVED`**，approver = `role:manager`(2) / `role:exec`(2)；**0 条 `status=todo`**。
- `GET /api/page/todo?role=sales`（S05）：**5 行**（来自商机跟进/回款核对类；无审批项，因业务粒子 `status` 多为 `null`，无 `submitted`）。
- `GET /api/workbench?view=approval`：**0 行**；`?view=initiated`：**0 行**。
- 可用账号：`admin`(role=admin)、`alice`(role=sales)；`SMOKE_*`(manager) 3 个全部 `enabled=false` 且密码不可恢复。

## §3 三层根因（file:line 证据）

**R1（主因）actor 类型矛盾**：`matchApprover` 的两种匹配分支与 `currentActor` 返回类型互相矛盾，对 `role:xxx` 永远不成立。
- `workbenchRouter.js:30-36` — `currentActor` 返回 `me.username`（如 `admin`/`alice`）。
- `workbenchRouter.js:44-52` — `matchApprover`：
  - L46：`approver === actor`（actor=username，但种子 approver=`role:manager` → 不匹配）；
  - L49：`approver.slice(5) === actor`（要求 actor=角色名如 `manager`，但 actor=username 如 `admin` → 也不匹配）。
  - 两条分支对 `role:xxx` 均不成立 → **待我审批恒空**。
- `workbenchRouter.js:65` — 过滤 `status==='todo' && matchApprover(...)` 后必空。

**R2 种子无待审批数据**：`CRM_APPROVAL_TASK` 4 条全 `APPROVED` 终态，L65 过滤后必空（即使修了 R1，无 `todo` 数据仍空）。

**R3 角色不对齐**：种子 approver=`role:manager`/`role:exec`，而可用账号仅 `admin`/`sales` → 即使修 R1 且补充 `todo` 数据，若仍写 `role:manager` 也对 admin/sales 不可见。

## §4 设计目标与已确认决策

**目标**：单一入口、开箱有数据、消除概念混淆、修复空数据 bug；不改动审批流 engine 自身的写入逻辑（`CRM_APPROVAL_*` 的产生链路不在本次范围）。

**已确认决策（用户回复"按推荐"）**：
- **D1 演示数据对齐（推荐）**：种子审批任务 `approver` 改为 `role:admin`（admin 主演示可见）+ 可选 `role:sales`（alice 可见）；**不动账号体系、不改密码**。
- **D2 「待跟进」tab 保留**（合并 S05 业务跟进/回款核对，避免该部分能力丢失）。

## §5 目标架构

- 新页 **`/my-todo.html`** 替代 `workbench.html` + `todo.html`。
- 旧 URL `/workbench.html`、`/todo.html` → **301 重定向**到 `/my-todo.html`（保书签/外链兼容）。
- 统一路由 **`GET /api/my-todo?view=approval|processing|initiated|cc|follow`**，合并 `workbenchRouter` 与 `/api/page/todo` 逻辑。
- 旧 `/api/workbench`、`/api/page/todo` 保留为兼容代理（内部转发 `/api/my-todo`），不立即删除（防其它页面/测试引用）。

## §6 五视角数据面

| 视角 | 数据来源 | 过滤条件 |
|---|---|---|
| 待我审批 | `CRM_APPROVAL_TASK` | `status='todo'` AND `matchApprover(approver, {username, roles})` |
| 我处理的 | kanban tasks | `status='running'` AND `payload.actor = 当前 username`（按人） |
| 我发起的 | `CRM_APPROVAL_INSTANCE` | `submitter = 当前 username` |
| 抄送我的 | `CRM_APPROVAL_INSTANCE` | `payload.cc` 数组包含当前 username |
| 待跟进（来自 S05） | `CRM_DEAL`(stage∈lead/opportunity) + `CRM_PAYMENT_*`(status∈pending/submitted) | 按角色可见（销售/经理/财务/合同） |

## §7 核心修复：actor 角色匹配

`currentActor` 返回身份对象（用户名 + 角色集）；`matchApprover` 同时支持 `role:xxx` 与裸人名：

```js
// workbenchRouter.js defaultDeps.currentActor
currentActor: async (req) => {
  const me = resolveMe(req);
  return me.ok
    ? { username: me.username, roles: [me.role] }
    : { username: 'system', roles: [] };
}

// workbenchRouter.js matchApprover（替换 L44-52）
function matchApprover(approver, { username, roles }) {
  if (!approver) return false;
  if (approver.startsWith('role:')) return roles.includes(approver.slice('role:'.length));
  return approver === username;
}
```

**重要区分（防歧义）**：「我处理的」(kanban) 仍按 **username** 匹配（kanban `payload.actor` 是具体执行人，非角色）；审批类视角按 **角色集** 匹配。两类语义在 §6 已显式分列，不混用。

## §8 演示数据对齐（D1）

- 在种子中新增/改写 `CRM_APPROVAL_TASK`：至少 **2 条 `status=todo`**，`approver=role:admin`（admin 主演示可见）；可选 1 条 `role:sales`（alice 可见）。
- **不新增账号、不改密码体系**。
- 同时补少量业务粒子 `status=submitted`（如 `CRM_QUOTATION`/`CRM_CONTRACT`），让「待跟进」及 S05 的审批类待办有真实数据，避免空表。

## §9 前端与菜单改造

- 新建 **`src/web/my-todo.html`**：复用 `workbench.html` 的四 tab 框架 + SSE 实时刷新；扩展为 **5 个 tab**（新增「待跟进」）；**必须链 `/portal/page.css`**（前端渲染硬性依赖，缺失会样式乱码，详见项目 MEMORY.md 前端渲染铁律）。
- `src/portal/layoutMenu.js`：协同分组「审批」+「待办」两项 → 合并为 **「我的待办」→ `/my-todo.html`**。
- `src/pages/S33-workbench.schema.js`：扩展声明「待跟进」tab 组件。
- `src/web/workbench.html`、`src/web/todo.html`：改为 301（或仅保留重定向头）指向 `/my-todo.html`；`S05.schema.js` 随 todo 页一并收口。
- `src/web/layout.js` 的「📋 我的任务」等链接同步改为 `/my-todo.html`。

## §10 影响文件清单与验收

**影响文件**：
- `src/http/workbenchRouter.js`（actor/matchApprover 修复 + 合并 todo 逻辑 + follow 视角）
- `src/http/routes.js`（新增 `/api/my-todo`；`/api/workbench`、`/api/page/todo` 兼容代理；`/workbench.html`、`/todo.html` 301）
- `src/web/my-todo.html`（新建）
- `src/web/workbench.html`、`src/web/todo.html`（改 301）
- `src/portal/layoutMenu.js`、`src/web/layout.js`（菜单/链接）
- `src/pages/S33-workbench.schema.js`（扩展 tab）
- 种子：`db/seed*.sql` 或 `scripts/seed.js`（演示数据对齐 D1）
- `test/http/workbenchRouter.test.js`（扩展角色匹配用例）

**验收标准**：
1. `admin` 登录 → 我的待办 → 「待我审批」有数据（`role:admin` 命中）。
2. 五视角切换 + SSE 实时刷新正常。
3. 旧 URL `/workbench.html`、`/todo.html` 重定向生效。
4. 全量测试无新增回归；`workbenchRouter` 注入式测试 + **角色集合匹配**用例全绿（`role:admin` 匹配 admin 用户、`role:sales` 匹配 alice）。

## §11 自检记录

- **占位符**：无 `[TBD]`/`[TODO]`/未决项。
- **矛盾**：§7 已显式区分「我处理的」按 username、「待我审批」按角色集，无冲突。
- **歧义**：D1 明确"不动账号体系"，防止范围蔓延；§5 明确旧接口保留为兼容代理而非删除，避免破坏其它引用。
- **范围**：仅合并"待办展示域"，审批流 engine 写入逻辑（`CRM_APPROVAL_*` 产生）不在本次范围；如后续需让真实业务单自动产生 `todo` 审批任务，另立任务。

---

下一步：本设计获用户评审批准后，转 `writing-plans` 产出含完整代码的实施计划（每 Task 一 commit）。
