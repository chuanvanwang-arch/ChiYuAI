---
name: user-rbac-admin
description: 平台管理员 / sysadmin 视角的「用户与权限」治理 Runbook——新增用户（crm.crm_users，pgcrypto crypt 哈希，禁删，首登改密，tenant 隔离）+ 配置 RBAC 权限矩阵（crm.rbac 角色×data_scope，禁 delete）。须 crm_login 登录验证 + 仅 sysadmin 角色可执。触发词：新增用户、开通账号、建销售员、配角色、配权限、RBAC、数据范围、禁用账号、重置密码、sysadmin。
type: domain
immutable_baseline: true
related_skills:
  - industry-onboarding      # 行业上线的最终交付 = 该行业初始销售员账号（本 SKILL 的用户新增范式）
  - crm-config-center-settings   # id12 用户管理 / id13 RBAC 矩阵同源；配置中心第0闸机制复用
  - system-bootstrap         # 系统初始化含默认 admin 引导账号，并注册 sysadmin 角色
---

# 用户与权限管理 Runbook（User & RBAC Provisioning）

## 0. 定位与边界

- 本 SKILL 管**平台用户与权限治理**（身份 + 授权），与业务主数据（`crm-basic-data-portal`）、配置参数（`crm-config-center-settings`）严格分离。
- 两块能力：
  - **用户管理**：`crm.crm_users`（专属表），经 `/api/config/users`。增 / 改 / **禁用（禁删）**；`pgcrypto crypt($pw, gen_salt('bf'))` 哈希；明文永不出库。
  - **RBAC 权限**：`crm.rbac`（角色 × data_scope 矩阵），经 `/api/rbac`。GET/list + GET/:id + PUT（**禁 delete**）；引擎按矩阵自动消费。
- **准入要求（双闸，缺一不可）**：① 必须先 `crm_login(username, password)` 验证通过（`gate != 'auth_required'`）；② 操作者角色必须为 **`sysadmin`**。普通 `admin` / 其它角色 → 403。未登录或角色不符，一律拒绝执行，绝不降级。
- 与「行业上线」互补：每上线一个行业，须用本 SKILL 为其建初始销售员并配最小权限（见 `industry-onboarding` Step 5/6）。

## 1. 红线（用户与权限铁律）

| 红线 | 说明 |
|---|---|
| 必须登录验证（首闸） | 任何用户 / 权限操作前须 `crm_login(username,password)` 验证通过（gate≠auth_required）；未登录 / 凭证失效 → 一律拒绝，绝不降级。 |
| sysadmin 角色闸（唯一） | 用户 / RBAC 写操作**仅** `sysadmin` 角色可执；普通 `admin` / 其它角色 → 403。 |
| 绝对禁 DELETE | 账号走「禁用」（`disabled=true`）而非物理删除；RBAC 走「改 / 覆盖」而非删行。去重走软合并。 |
| 写必经决策第 0 闸 | 一切写操作强制带 `decision_id`（无决策不写）；对话式写还需 HITL 确认。 |
| 密码不出明文 | 落库即 `crypt()` 哈希；GET 返回绝不带 password_hash 明文；初始密码仅交付一次，强制首登改密。 |
| per-tenant 隔离 | 用户按 `tenant_id` 收敛；跨租户不可见、不可越权操作。 |
| 最小权限默认 | 新增业务账号默认 `role=sales` + 最小 data_scope；提权须显式配置并留决策痕。 |

## 2. 用户新增（写路径）

### 2.1 端点与形态

- 读：`GET /api/config/users`（列表）/ `GET /api/config/users/:id`
- 写：`PUT /api/config/users`（增 / 改 / 禁用 合一，upsert 语义；**无 POST / 无 DELETE**）
- 写自动走决策第 0 闸（`produceDecision('user-change', {username,role})`）；**`sysadmin` 角色闸**拦截非授权（普通 `admin` → 403）。

### 2.2 新增销售员（含初始密码 + 首登改密）

```powershell
# 前提：crm_login 登录验证通过（Bearer <sysadmin_token>）；角色须 sysadmin
# PUT /api/config/users
# Authorization: Bearer <sysadmin_token>
# Body:
# {
#   "username": "chem_sales01",
#   "password": "Chem@2026!",          # 初始密码，仅交付一次
#   "role": "sales",
#   "display_name": "化工初始销售员",
#   "tenant_id": "acme-chem",          # 绑定行业租户（与 admin/alice 的 system 租户隔离）
#   "force_reset_on_first_login": true # 强制首登改密（治理要求）
# }
# → 200 { id, username, role, tenant_id, must_reset:true }（password 不回显）
```

要点：
- **不要命令行绕行**：用户管理 PUT 自带第 0 闸，优先用 PUT（设计铁律）。
- **初始密码策略**：遵循 `<行业>@2026!` 形态（见 `industry-onboarding`）；交付后立即强制改密，明文永落库 / 不写日志。
- **tenant 隔离**：`tenant_id` 锁定本行业；登录 token 自动携带 `tenantId`，后续写读按租户收敛。

### 2.3 禁用 / 改密（禁删）

```powershell
# 禁用账号（离职 / 风险）：PUT /api/config/users  Body: { "username":"chem_sales01", "disabled": true }
# 改密（用户遗忘 / 周期轮换）：PUT /api/config/users  Body: { "username":"chem_sales01", "password":"<新强密码>", "force_reset_on_first_login": true }
# 两者均 upsert、均带 decision_id、均不返回明文密码。
```

## 3. RBAC 权限新增 / 配置（写路径）

### 3.1 端点与形态

- 读：`GET /api/rbac`（矩阵列表）/ `GET /api/rbac/:role`
- 写：`PUT /api/rbac`（角色 × data_scope 覆盖式配置；**无 DELETE**）
- 写自动走决策第 0 闸；**`sysadmin` 角色闸**（仅 sysadmin 可 PUT）。

### 3.2 角色矩阵与 data_scope 维度

`crm.rbac` 表达「角色 → 可访问的数据范围」：

```jsonc
{
  "role": "sales",
  "data_scope": {
    "tenant_id": "acme-chem",     // 限定行业租户
    "org_ids": [],                // 空 = 不限组织（或填具体 org）
    "team_ids": [],               // 空 = 不限团队
    "self_only": false            // true = 仅本人创建的记录
  },
  "permissions": ["particle:read", "particle:write", "decision:propose"] // 该角色可调用的动作集
}
```

- **data_scope 维度**：`tenant_id`（行业）→ `org_ids`（组织）→ `team_ids`（团队）→ `self_only`（本人）。引擎按矩阵自动收敛查询 / 写范围，越权 → 403。
- **角色取值**（与 `crm-native` 五角色 + 管理角色对齐）：`sales` / `manager` / `presales` / `exec` / `finance` / `admin` / **`sysadmin`（平台管理专用角色，唯一可执行业务无关的平台治理操作：行业上线 / 用户权限 / 系统初始化）** / `sysadmin`（历史兼容别名，建议统一收敛到 `sysadmin`）。
- **如何注册 sysadmin 角色**：若 `crm.rbac` 尚无 `sysadmin` 角色，须先 `PUT /api/rbac` 注册该角色并赋予管理员账号（`role:"sysadmin"`，`data_scope` 覆盖全平台或指定 tenant）；之后该账号方可执行本 SKILL 全部操作。首次部署可由 `system-bootstrap` 的默认引导账号完成此授权。
- **引擎自动消费**：权限判定在 Action Registry 五闸（决策 / 范围 / RBAC / 字段 / 审批）内读取 `crm.rbac`，无需业务代码硬编码。

### 3.3 配置 / 新增范式

```powershell
# 给新行业销售员配「仅本行业 + 本人+团队」最小权限
# PUT /api/rbac
# Authorization: Bearer <sysadmin_token>
# Body:
# {
#   "role": "sales",
#   "data_scope": { "tenant_id": "acme-chem", "org_ids": [], "team_ids": [], "self_only": false },
#   "permissions": ["particle:read", "particle:write", "decision:propose"]
# }
# → 200 { role, data_scope, permissions, decision:<decision_id> }
```

要点：
- **不要物理删除 RBAC 行**：调整权限走 PUT 覆盖；废弃角色置 `enabled=false`（软停用），保留溯源。
- **最小权限默认**：新账号先给 `sales` + 最小 data_scope，提权须显式且留决策痕。
- **sysadmin 仅授权、不泛滥**：`sysadmin` 是平台治理角色，仅赋予平台管理员；业务账号一律 `sales` 起，按需提权。

## 4. 调用示范

**场景 A — 给化工行业建初始销售员并配权限**（接 `industry-onboarding` 化工示范）
用户：「给 acme-chem 开个销售员，配最小权限」
→ ① `PUT /api/config/users`（Bearer `<sysadmin_token>`）：`{username:"chem_sales01", password:"Chem@2026!", role:"sales", display_name:"化工初始销售员", tenant_id:"acme-chem", force_reset_on_first_login:true}` → 返回 `{id, role, tenant_id, must_reset:true}`。
→ ② `PUT /api/rbac`（Bearer `<sysadmin_token>`）：`{role:"sales", data_scope:{tenant_id:"acme-chem"}, permissions:["particle:read","particle:write","decision:propose"]}` → 覆盖式配置，引擎自动收敛其查询 / 写范围。
→ 交付用户：`chem_sales01` / `Chem@2026!`，首登强制改密；该账号仅见 `acme-chem` 租户数据。

**场景 B — 禁用离职账号**
用户：「chem_sales01 离职，禁用」
→ `PUT /api/config/users`（Bearer `<sysadmin_token>`）：`{username:"chem_sales01", disabled:true}`（禁删，保留历史）。

**场景 C — 注册并授予 sysadmin 角色（首次 / 补授权）**
用户：「把账号 platform_op 设为平台管理员」
→ 确认操作者自身为 sysadmin 且已 crm_login 验证 → `PUT /api/rbac`（Bearer `<sysadmin_token>`）：`{role:"sysadmin", data_scope:{tenant_id:"*"}, permissions:["platform:all"]}` → 该账号获得平台治理全权；之后其登录即可执行 industry-onboarding / user-rbac-admin / system-bootstrap。

## 5. 验收

- `GET /api/config/users` 列表不含 `password_hash` 明文；禁用账号 `disabled=true` 仍可查（软停用）。
- `GET /api/rbac/:role` 返回 `data_scope` + `permissions`；PUT 覆盖后读取一致，且无 delete 路由。
- 跨租户验证：用 `chem_sales01` 登录，其 token.tenantId=`acme-chem`，查询 `crm` 租户数据返回空 / 403。
- 准入验证：未 `crm_login` 或角色非 `sysadmin` 调用 PUT `/api/config/users` / `/api/rbac` → 403 / auth_required。
- 涉及 DB：用户本地起 CRM Postgres 跑全量；改动 `crm_users` / `crm.rbac` 列须同步 schema + 迁移 + ensure 三处。

## 6. 铁律声明

本 SKILL 是**领域专属**用户与权限操作手册，与 10 大 ai-* 方法论能力 SKILL **无关、不交叉写入**。通用方法论以交叉引用复用，绝不向 ai-* 基线增删改任何内容。
