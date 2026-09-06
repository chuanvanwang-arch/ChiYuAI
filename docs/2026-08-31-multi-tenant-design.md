# AI 原生 CRM · 多租户（行级共享库）设计文档

- 日期：2026-08-31
- 触发：用户问「什么时候用 system？什么时候用 default？」→ 审计揭示系统是"伪单租户"（tenant_id 列已在、隔离未通电）→ 用户明确「需要考虑并新增多租户。全面系统予以考虑」
- 范围：把单租户升级为真·行级多租户——租户身份落 JWT → resolveMe 携带 → 全读写按租户过滤；现有数据零迁移；sysadmin 跨租户
- 流程：brainstorming（四枢轴已批准）→ 本文档 → 用户评审 → writing-plans → 实现

---

## §0 决策记录（brainstorming 收敛）

| 问点 | 用户选择 | 落点 |
|---|---|---|
| 隔离模型 | **行级共享库**（复用现有 tenant_id 列） | §1 数据层 |
| 租户解析 | **登录绑定**（用户隶属租户，JWT 携带 tenant claim） | §2 身份层 |
| system 数据与 sysadmin | **system=种子租户；sysadmin 凭 role 跨租户（tenant='*' 通配）** | §2.3 |
| 隔离边界 | **全量 per-tenant**（业务+配置+审批+决策） | §4（含读默认回退机制） |

**关键事实基线（审计所得）**：
- 数据层已具备多租户物理骨架：`particles`/`edges`/`tasks` 均 `tenant_id TEXT NOT NULL DEFAULT 'system'` 且建有含 tenant 的复合索引（`schema.sql:13/26/27/35/51/70/71`）。
- 但 **60+ 处源码把 `tenantId` 钉死 `'system'`**（`routes.js` 全量、`workbenchRouter.js:40-42`、`approval/engine.js:11`、`approval/flow.js:6` 的 `const TENANT='system'`、各 `sales/*Service`、`agentLoop.js:30`）。
- 身份解析不携带租户：`auth.js:45` `resolveMe` 返回 `{ok, role, display_name, username}`，**无 tenantId** → `me.tenantId || 'system'` 恒落 `'system'`（`routes.js:2729`）。
- 写链路已部分透传：`actionExecutor.dispatch`（`executor.js:21`）与 `seed-actions.js:54` 已正确使用 `ctx.tenantId`——只差"源"解析。
- `'default'` 在源码零出现（此前 seed 笔误，已修正）；唯一合法租户值是 `'system'`。

**结论**：隔离的物理基础已就位（列+索引+action 透传），缺的是 **①租户身份 ②请求→租户解析 ③强制作用域** 三层。

---

## §1 数据层（行级共享库）

现状已满足物理层；本设计仅做**两处缺列补齐**（全幂等迁移，禁删铁律）：

| 表 | 变更 | 证据基线 |
|---|---|---|
| `crm.crm_users` | `ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'system'` | `schema.sql:352` 现无 tenant 列 |
| `mcp_identity` | `ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'system'` | `schema.sql:380` |

索引：`crm_users` 增 `(tenant_id, username)`。已含 tenant 的复合索引（particles/edges/tasks）不动。

---

## §2 身份层（租户锚）

### §2.1 登录签发（`src/http/auth.js`）

- `login`：SELECT 增 `tenant_id`（`auth.js:36`），`issueToken` payload 增 `tenant_id`（`auth.js:41`）。
- `resolveMe`：返回增 `tenantId: p.tenant_id`（`auth.js:45-54`）。

### §2.2 旧 token 兼容

已签发 token 无 tenant claim → `resolveMe` 回退 `tenantId:'system'`（种子租户）。不强制全员重登录。

### §2.3 sysadmin 跨租户

`role==='admin'` → 作用域通配 `'*'`（见 §3.1），可跨租户读写。普通用户严格按 `me.tenantId`。

---

## §3 作用域强制（读写路由）

### §3.1 读：particleRepo 通配语义

`queryParticles({ type, tenantId:'*' })` → SQL 省略 tenant 条件（全部租户）。普通用户 `tenantId = me.tenantId`，admin 通配 `'*'`。`createParticle` 恒写 `ctx.tenantId`（写不跨租户）。

### §3.2 写：ctx 透传（现状已通，补源）

`routes.js:2729` `ctx = { tenantId: me.tenantId || 'system', actor: ..., role: ... }` —— 加 claim 后自动生效。`executor.js:21` / `seed-actions.js:54` 已透传零改。

### §3.3 60+ 处硬编码替换

| 位置 | 改为 |
|---|---|
| `routes.js` 全量 `tenantId:'system'` | `me.tenantId`（普通）/ `'*'`（admin） |
| `workbenchRouter.js:40-42` 审批任务/实例/看板 | `me.tenantId` |
| `funnelRouter.js:41,100` / `namedAccountAssignRouter.js:23` | `me.tenantId` |
| 各 `sales/*Service` / `agentLoop.js:30`（方法参数默认值） | 保留 `'system'` 默认（向后兼容），调用方传 `ctx.tenantId` |

### §3.4 审批子系统（engine/flow）

`engine.js:11` / `flow.js:6` 的 `const TENANT='system'` → 改为函数参数 `{ tenantId = 'system' }` 默认值；`startInstance`/`loadFlow`/`advanceTask` 全链透传。跨租户提交不串数据。

---

## §4 配置全量 per-tenant（读默认回退机制）

**问题**：全量 per-tenant 下新租户 config_store 为空表 → 阈值读空破坏既有默认行为。

**机制（关键）**：读 `config_store` 某 key：
1. 先查 `(tenant, key)`；
2. 无 → 回退 `(system, key)` 平台默认；
3. 返回。租户首次 PUT 才落 `(tenant, key)` 覆盖。

零租户初始化成本、天然继承默认、可选择性覆盖；**不引入 overlay 合并逻辑**（最简）。

`config_store` 唯一键改 `(tenant_id, key)`（`ALTER TABLE ... ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'system'` + 重建 PK）；`configRouter`/`configCenter` 读写按 `me.tenantId` 过滤；`system_config` 同理。

---

## §5 决策域与审计分租户

- `decision_scenario` / `decision`：`ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'system'`；查询按租户隔离。
- `audit_event`：加 `tenant_id`（审计可分租户对账）。
- 决策链（scenario → decision → calibration_patch → retro_report）全部 per-tenant 独立。

---

## §6 租户管理（管理面）

| 端点 | 鉴权 | 行为 |
|---|---|---|
| `GET /api/tenants` | sysadmin | 列租户及用量（粒子数/用户数） |
| `POST /api/tenants` | sysadmin + 决策第0闸 | 建租户 = 插 `crm_users`（username + tenant_id）+ 系统配置留空（read-fallback 自动接管） |

**禁删铁律**：租户下线 = 软停（`enabled=false`），不物理删除。

---

## §7 Task 分解（T1–T6）

| Task | 内容 | 验收 |
|---|---|---|
| **T1 身份层** | schema 两表加列 + auth.js（login claim/resolveMe 返回 tenantId + 旧 token 回退） | `resolveMe` 返回 `tenantId`；旧 token 回退 'system' |
| **T2 读作用域** | particleRepo 通配 `'*'` + routes.js 60+ 处改 `me.tenantId` | 普通用户只见本租户；admin 见全部（行级隔离断言锁死） |
| **T3 审批域** | engine/flow `TENANT` 常量改函数参数透传 | 跨租户提交不串数据（同 slug 两租户各走各流） |
| **T4 配置面** | config_store 加 tenant + 唯一键改 `(tenant,key)` + read-fallback + configRouter/configCenter 按租户过滤 | 新租户读默认；PUT 后覆盖生效 |
| **T5 决策/审计** | decision_scenario/decision/audit_event 加列 + 查询隔离 | 决策链 per-tenant 独立 |
| **T6 租户+测试** | `/api/tenants` + T2 行级隔离断言 + 迁移脚本 | E2E 全绿（两租户同 slug 不串） |

---

## §A 生命契约（living contract，双轨）

```contract-yaml
- task: "T1 身份层：租户锚落地（schema 列 + auth.js claim）"
  agent: crm-copilot
  skills: [data-particle-read]
  memory: [crm-copilot]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "resolveMe(req) 返回 {ok:true, role, display_name, username, tenantId}；旧 token（无 tenant claim）回退 tenantId='system'；crm_users/mcp_identity 含 tenant_id 列"
- task: "T2 读作用域：particleRepo 通配 + routes.js 60+ 处改 me.tenantId"
  agent: crm-copilot
  skills: [data-particle-read]
  memory: [crm-copilot]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "行级隔离断言：两租户同 slug 粒子，普通用户只见本租户、admin 见全部"
- task: "T3 审批域：engine/flow TENANT 常量改函数参数透传"
  agent: crm-copilot
  skills: [data-particle-read]
  memory: [crm-copilot]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "跨租户提交审批不串数据（同 slug 两租户各走各流，CRM_APPROVAL_INSTANCE 归属正确租户）"
- task: "T4 配置面：config_store 加 tenant + read-fallback"
  agent: crm-copilot
  skills: [data-particle-read]
  memory: [crm-copilot]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "新租户读 config_store 某 key 回退平台默认；PUT 后覆盖生效且不污染 system 默认"
- task: "T5 决策/审计分租户"
  agent: crm-copilot
  skills: [data-particle-read]
  memory: [crm-copilot]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "decision_scenario/decision/audit_event 含 tenant_id 列且查询按租户隔离"
- task: "T6 租户管理 + 测试 + 迁移"
  agent: crm-copilot
  skills: [data-particle-read]
  memory: [crm-copilot]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "GET/POST /api/tenants（admin 闸+第0闸）可用；行级隔离 E2E 全绿；迁移脚本幂等"
```

**契约说明**：本任务组由 `crm-copilot` 承接，必须调用 `data-particle-read` SKILL、读取 `crm-copilot` 记忆（L1，≤2 跳）；每个 Task 的成功标准均为可验证判定式（接口返回 / 断言 / 迁移幂等）。

---

## §8 风险与权衡

1. **T4（read-fallback）是唯一非纯机械替换**：配置读多一次回退查询；已用"查租户→空回退 system"最简化，不引入 overlay 合并逻辑。
2. **60+ 处硬编码替换面大**：全部机械改 `me.tenantId`，T2 行级隔离断言锁死防漏网。
3. **旧 token 兼容**：无 claim 回退 `'system'`，不强制重登录。
4. **禁删铁律**：全部 `ADD COLUMN IF NOT EXISTS` 幂等；租户下线软停，不物理删除。

---

## §9 参考（证据基线）

- `db/schema.sql`：particles/edges/tasks tenant 列与索引（L13/35/51，idx L26/27/70/71）；crm_users（L352）；mcp_identity（L380）。
- `src/http/auth.js`：login（L33-43）→ issueToken（L7-13）；resolveMe（L45-54）。
- `src/http/routes.js`：`me.tenantId || 'system'`（L2729）；60+ 处硬编码 `tenantId:'system'`。
- `src/approval/engine.js:11` / `src/approval/flow.js:6`：`const TENANT='system'`。
- `src/particles/particleRepo.js`：createParticle（L57）/queryParticles（L120）/createEdge（L174）/queryNeighbors（L209）默认 `'system'`。
- `src/http/workbenchRouter.js`：审批任务/实例查询（L40-42）硬编码 `'system'`。
- `db/migrate-config.sql`：config_store（L10-16）无 tenant 列。