# 设计文档：缺省角色 sysadmin + 租户创建者归属（含自助注册推荐者）

- 日期：2026-09-04
- 状态：待批准（brainstorming P6 落盘，待 P5 批准 → writing-plans → 实现）
- 关联需求：① 在系统缺省角色中新增 `sysadmin`（即企业AI销售决策管理专家所需角色），用于行业初始化 / 租户新增 / 用户新增；② 记录每个租户由哪个 sysadmin 创建；③ 租户列表可查创建者；④（本论新增）用户自主注册生成租户时，首次注册须填写推荐者（即具有 `sysadmin` 角色的人）。

---

## 0. 背景与目标

平台管理插件（`plugin-platform-admin`）的三个 SKILL（industry-onboarding / user-rbac-admin / system-bootstrap）当前以 `rbac_roles: ["sys-admin"]` 作为准入闸门，但：

1. 应用侧（租户管理、计费控制台、自助注册 UI）使用的角色标识是 **`sysadmin`（无连字符）**，与插件侧的 **`sys-admin`（带连字符）不一致** → `executor.js` 的 `rbac_roles.includes(role.role_tag)` 硬闸会互相 403。
2. 系统缺省角色种子（`roleProfiles.js` 的 `SEED_PROFILES`）**不含 `sysadmin`** → 即使 `crm_users.role='sysadmin'`，角色解析为 null，闸门反而拦截。
3. `crm.tenants` **无创建者字段** → 无法追溯「谁建的租户」，列表也无法按创建者查询。
4. 自助注册（`/api/auth/register`）会自动建租户，但**不要求、也不记录推荐者** → 新租户无责任 sysadmin 归属。

目标：补齐 `sysadmin` 缺省角色、统一命名、在 `crm.tenants` 记录责任 sysadmin（创建者 = 后台操作者 / 自助注册推荐者），并在租户列表提供「创建者」列与按创建者筛选。

---

## 1. 决策记录

| # | 决策点 | 结论 |
|---|---|---|
| D1 | 角色命名统一 | **统一为 `sysadmin`（无连字符）**。修正 `seed-actions.js:210` + 3 个插件 `registry.json` 的 `sys-admin`→`sysadmin`，消除 403。 |
| D2 | 创建者字段 | `crm.tenants` 加 `created_by_user_id uuid`（FK→`crm.crm_users.user_id`，ON DELETE SET NULL）+ `created_by_username text`。引用完整性 + 列表免 join 直接显示。 |
| D3 | 列表查询 | 租户列表加**「创建者」常驻列**（显示 `created_by_username`）+ 顶部**「按创建者筛选」**输入框（`?createdBy=`）。 |
| D4 | 自助注册推荐者建模 | 推荐者**统一写入 `created_by`**（即该租户的责任 sysadmin）。`created_by` 恒为 sysadmin，对后台创建 + 自助注册两路径语义一致；**不**新增独立 referrer 字段。 |
| D5 | 公司开通人角色 | 自助注册首注册者由 `admin` 改为 **`ten_admin`（租户管理员）**。理由：`admin` 在本仓是**平台级超级管理员**（`tenantScope.js:5` 返回 `*` 跨租户、`tenantRouter.js:15` 管所有租户、`portal/*` 平台配置页），当前 `selfRegister.js:101` 把任意新公司开通人设成 `admin` 属**权限越界 bug**。`ten_admin` 仅在本租户内有 admin 能力，排除全部平台/跨租户闸（边界见 T9）。三层角色模型：`sysadmin`（平台运营，跨租户）/ `admin`（平台超级管理员，跨租户 `*`）/ `ten_admin`（租户管理员，仅本租户）。 |

**范围共识（本论）**：推荐者为**必填且仅当新租户被生成**（`isNew === true`，即该公司首次注册）时强制；加入已有租户（`isNew === false`）不强制。

---

## 2. 现状事实（evidence）

- `src/http/tenantRouter.js:15` — 闸 `me.role !== 'admin' && me.role !== 'sysadmin'` → 应用侧用 `sysadmin`。
- `src/web/tenant-management.html:72/31` — UI 用 `sysadmin`。
- `src/action/seed-actions.js:210` + `plugin-platform-admin/skills/{industry-onboarding,user-rbac-admin,system-bootstrap}/registry.json` — 用 `sys-admin`（带连字符）。
- `src/context/roleProfiles.js` — `SEED_PROFILES` 仅含 sales/manager/exec/finance/presales/contract_admin，**无 sysadmin**。
- `db/2026-09-03-crm-tenants.sql` — `crm.tenants` 无创建者字段（列：tenant_id/name/status/plan/note/created_at/suspended_at/retired_at）。
- `src/http/selfRegister.js` — `registerUser` 经 `resolveTenantByCompany` → `seedTenantDefaults` 自动建租户（与后台控制台**同一函数**）；`selfRegister.js:101` `isNew ? 'admin' : 'sales'` 把首注册者设为 `admin`。**问题**：`admin` 在本仓是平台级超级管理员（`tenantScope.js:5` 返回 `*` 跨租户、`tenantRouter.js:15` 管所有租户、`portal/*` 平台配置页），任意自助注册的新公司开通人据此获得跨租户超级权限 → **权限越界 bug**（D5 修正为 `ten_admin`）。`ROLE_TAGS`(`selfRegister.js:12`) 当前含 `admin` 但不含 `ten_admin`。
- `src/web/landing.html:440-470` — `doReg()` 表单字段 `r_company/r_email/r_name/r_phone/r_pwd`，未传、未校验推荐者。
- `src/http/auth.js:53,57-66` — JWT 与 `resolveMe` 仅携带 `username/role/display_name/tenantId`，**不含 `user_id`** → 存 `created_by_user_id` 需按 `username` 反查。

---

## 3. 数据模型

### 3.1 新迁移 `db/migrate/2026-09-04-tenant-created-by.sql`
```sql
-- 租户责任 sysadmin 归属（设计 docs/2026-09-04-sysadmin-role-tenant-attribution-design.md）
-- 幂等：ADD COLUMN IF NOT EXISTS；存量租户 created_by_* 留 NULL（无责任归属，列表显示「—」）。
ALTER TABLE crm.tenants
  ADD COLUMN IF NOT EXISTS created_by_user_id uuid
    REFERENCES crm.crm_users(user_id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS created_by_username text;

CREATE INDEX IF NOT EXISTS ix_tenants_created_by ON crm.tenants (created_by_user_id);
```

### 3.2 `db/schema.sql` 同步
`crm.tenants` 的 `CREATE TABLE` 补两列（与迁移一致，保证全新库一致）。

### 3.3 `db/migrate.js` 注册
在迁移清单追加本文件（保持字母/日期序）。

---

## 4. 后端改动

### T1 — 缺省角色定义
- `src/context/roleProfiles.js`：`SEED_PROFILES` 增 `sysadmin`（`data_scope='all'`，治理上下文，行业初始化/租户/用户管理）；`seedProfiles` 幂等补行，同时满足 `mcp_identity.role_tag` FK。
- 契约：agent=`platform-admin`；success=`role_context_profile` 含 `sysadmin` 且 `mcp_identity` 可引用。

### T2 — 命名收口
- `src/action/seed-actions.js:210` + 3 个插件 `registry.json` 的 `sys-admin`→`sysadmin`。
- `plugin-platform-admin/agents/platform-admin.md` 同步表述。
- 如 `crm.skill_registry` 已存行的 `rbac_roles` 含 `sys-admin`，补一条迁移/UPDATE 修正（**UPDATE 非 DELETE，符合禁 DELETE 铁律**）。
- 契约：success=全仓无 `sys-admin` 残留，且 `executor` 闸门对 `sysadmin` 放行。

### T4 — 创建者捕获（两路径统一）
- 新增 helper `resolveSysadminRef(identifier)`：`SELECT user_id, display_name FROM crm.crm_users WHERE (username=$1 OR email=$1) AND role='sysadmin'`；无命中→null（调用方据此 400/403）。
- `db/seed/tenantDefaults.js:seedTenantDefaults(slug, opts)` 增 `opts.createdBy={user_id,username}`；INSERT 写入 `created_by_user_id/username`（`ON CONFLICT DO NOTHING` 保证首建者胜、不覆盖）。
- **控制台路径**：`tenantRouter.createTenant` 取 `me.username` → `resolveSysadminRef(me.username)` → 透传 `createdBy`。
- **自助注册路径**：`resolveTenantByCompany(companyName, createdBy)` 透传 `createdBy` 到 `seedTenantDefaults`（见 T8）。
- 契约：success=`POST /api/tenants` 后 `crm.tenants.created_by_username` = 操作者；`POST /api/auth/register`（新租户）后 = 推荐者。

### T8 — 自助注册推荐者（本论核心）
- `src/http/selfRegister.js:validateRegister` 增 `referrer` 字段：
  - 仅当将生成新租户（`isNew` 待定，先解析租户再判定）时**必填**；缺失/非法→`errors.push('推荐者必填，且须为 sysadmin 角色')`。
  - 合法值：调用 `resolveSysadminRef(referrer)` 必须命中（`role='sysadmin'`）；否则 400 `推荐者不存在或不具备 sysadmin 角色`。
  - 加入已有租户（`isNew===false`）时不强制（范围共识）。
- `registerUser`：先 `resolveTenantByCompany` 判定 `isNew`；若 `isNew` 且 referrer 命中 → 取 `{user_id, display_name}` 作为 `createdBy` 透传；若 `isNew` 但 referrer 未命中 → 400 拒绝（不建租户、不建用户）。
- `src/web/landing.html:doReg()`：新增「推荐者」输入框（`r_referrer`），随 body 传出 `referrer`。
- 契约：success=新租户注册缺 referrer→400；referrer 非 sysadmin→400；合法→租户 `created_by_username` = 推荐者。

### T9 — 新增 `ten_admin` 角色 + 闸点重分类（D5）
- **角色档案**：`src/context/roleProfiles.js` `SEED_PROFILES` 增 `ten_admin`（`data_scope={model:'tenant'}` 或等效本租户范围；业务上下文=公司开通人/租户内管理员）；`seedProfiles` 幂等补行（同时满足 `mcp_identity.role_tag` FK）。
- **自助注册改角色**：`selfRegister.js:12` `ROLE_TAGS` 增 `'ten_admin'`；`:101` 改为 `const role = isNew ? 'ten_admin' : 'sales';`。
- **闸点重分类（核心工作量，逐处裁定 ten_admin 是否通过）**：
  - **EXCLUDE ten_admin（平台/跨租户闸）**：`tenantRouter.js:15`、`tenantScope.js:5`（**绝不可**对 ten_admin 返回 `*`）、`behaviorStandardRouter.js:16,42`、`contractRouter.js:11,28`、`configRouter.js:46`、`calibrationRouter.js:27`、`financeReceivablesConfigRouter.js:16,21`、`namedAccountTargetsRouter.js:17,22`、`salesThresholdsRouter.js:17,105`、`sevenDimRouter.js:89`、`routes.js:156`(admin bypass)、`routes.js:207`、`routes.js:344`、`routes.js:2160`、`portal/systemSettings.js:61,73,94`、`portal/ontologyConfig.js:110,120,144`、`portal/memoryConfig.js:64,75`、`portal/skillRegistry.js:48`、`mcp/auth.js:126`、`layout.js:33`、`portal/layoutMenu.js:25`。
  - **INCLUDE ten_admin（租户内 admin 闸，且强制本租户范围）**：`portal/userManagement.js:226/249/271/297`（管本租户用户，须叠加 `tenantId` 校验防越租户）；本租户计费/销售阈值配置入口（如 `billingRoutes.js:25`、`salesThresholdsRouter.js` 的租户内配置，须限定本租户，不可沿用平台 admin 全量闸）。
- 契约：success=① `role_context_profile` 含 `ten_admin`；② 自助注册新租户首用户 `role='ten_admin'`，且 `tenantScope` 仅返回本租户（不 `*`）；③ ten_admin 访问平台配置页 / 跨租户租户管理 → 403；④ ten_admin 在本租户内能管用户/本租户计费。

### T5 — 列表透出
- `listTenants`：数据源切到 `crm.tenants`（LEFT JOIN 取用户数/粒子数），返回 `created_by_username`，支持 `?createdBy=`（如带则 `WHERE created_by_username ILIKE $1`）。
- `src/web/tenant-management.html`：表头加「创建者」列；顶部加「按创建者筛选」输入框，变更即带 `?createdBy=` 重查。
- 契约：success=列表显示创建者且按创建者筛可选中。

### T6 — 种子 sysadmin 账号（建议）
- `db/seed-users.sql`（或对应种子脚本）增 `sysadmin` 引导账号（`role='sysadmin'`，crypt 同既有种子）。
- **依赖说明**：自助注册必须先有可被引用的 sysadmin，否则首注即死锁；故 T6 与 system-bootstrap 的首个 sys-admin 注册共同兜底。
- 契约：success=该账号登录后 `role='sysadmin'`，可见租户管理页。

### T7 — 测试
- `roleProfiles` 含 `sysadmin`；全仓无 `sys-admin` 残留；
- 控制台建租户 → `created_by_username` 写入；
- 自助注册新租户缺 referrer→400、referrer 非 sysadmin→400、合法→`created_by_username`=推荐者；
- 列表筛选 `?createdBy=` 命中。

---

## 5. 前端改动

| 页面 | 改动 |
|---|---|
| `src/web/tenant-management.html` | 租户表加「创建者」列（显示 `created_by_username`，空显「—」）；顶部加「按创建者筛选」输入框，输入即带 `?createdBy=` 重查。 |
| `src/web/landing.html` | `doReg()` 表单加「推荐者」输入框（`r_referrer`，占位提示「请填写推荐您的 sysadmin 账号」），随 `referrer` 传出。 |

---

## 6. 测试策略
- 单元/集成：`test/` 下新增/调整覆盖 T1/T2/T4/T5/T6/T7/T8。
- 跑法（铁律）：`node node_modules/vitest/vitest.mjs run`（非 `.bin/vitest`，非 `&&`）。
- 冒烟：租户列表页含「创建者」列 + 筛选框；自助注册页含「推荐者」输入框。

---

## 7. 风险与边界
1. **`resolveMe` 不含 `user_id`**：存 `created_by_user_id` 必须按 `username` 反查（T4 helper `resolveSysadminRef`），非热路径，仅建租户时一次 SELECT。
2. **自助注册 sysadmin 鸡生蛋**：首注前须已有 sysadmin（T6 种子 / system-bootstrap 首启注册）。否则新公司首注必 400。文档如实标注。
3. **存量租户 `created_by` 为 NULL**：列表统一显「—」，筛选时 NULL 不匹配具体创建者（符合预期）。
4. **`platform-admin` 不在 `src/agent/agentSpec.js`**：生命契约 `agent` 字段用 `platform-admin`（语义正确但不在销售注册表），P7 校验走**结构校验**（不带 `--registry`）；「在 agentSpec 补 platform-admin 条目」列为后续项。
5. **命名修正波及 `crm.skill_registry` 已存行**：须同步 UPDATE（`rbac_roles` 数组内 `sys-admin`→`sysadmin`），避免运行时闸门仍拒。
6. **ten_admin 闸点重分类漏判风险**：T9 需逐处裁定约 20 个 `role==='admin'` 闸点，漏改任一平台闸会让 ten_admin 越权、漏改任一租户内闸会让 ten_admin 无法自理本租户。必须回归测试覆盖「ten_admin 访问平台配置页→403」「tenantScope 不返回 `*`」。

---

## 8. 生命契约（living contract）

| 维度 | 内容 |
|---|---|
| agent | `platform-admin`（注：不在本仓销售 agentSpec 注册表，结构校验放行，后续补条目） |
| skills | `industry-onboarding` / `user-rbac-admin` / `system-bootstrap`（3 个平台管理 SKILL，`rbac_roles` 统一 `sysadmin`） |
| memory | 写入项目日志 `D:\system\CRM-ai-native\.workbuddy\memory\2026-09-04.md`：sysadmin 角色落地 + 租户 created_by 归属 + 自助注册推荐者必填 |
| success | ① `role_context_profile` 含 `sysadmin`；② 全仓无 `sys-admin` 残留且 executor 对 `sysadmin` 放行；③ `crm.tenants` 含 `created_by_*` 且新租户（后台/自助）写入责任 sysadmin；④ 租户列表显示创建者并可按创建者筛选；⑤ 自助注册新租户缺/错推荐者→400 |

---

## 9. 不做项 / 范围边界
- 不新增独立 `referrer` 字段（D4 已定统一进 `created_by`）。
- 不改动 `crm_users.role` 既有六角色语义，仅扩充缺省角色集。
- 不引入 `crm.rbac` 物理表（角色闸门仍由 `crm_users.role` + `role_context_profile` + skill `rbac_roles` 三元承担）。
- 自助注册推荐者仅新租户强制；既有「加入已有租户」流程不变。

---

## 10. 提交分组建议（功能线，PowerShell 兼容、禁 `&`/`&&`）
- 线A 角色与命名：`git add src/context/roleProfiles.js src/action/seed-actions.js plugin-platform-admin ... db/seed-users.sql` → 提交「feat(role): 新增 sysadmin 缺省角色并统一命名 sysadmin」
- 线A2 ten_admin 角色与闸点：`git add src/context/roleProfiles.js src/http/selfRegister.js src/http/tenantRouter.js src/http/tenantScope.js src/portal/userManagement.js src/portal/systemSettings.js src/portal/ontologyConfig.js src/portal/memoryConfig.js src/portal/skillRegistry.js src/portal/layoutMenu.js src/web/layout.js src/http/billingRoutes.js src/http/salesThresholdsRouter.js src/http/routes.js src/http/mcp/auth.js` → 提交「feat(role): 新增 ten_admin 租户管理员角色并重分类约 20 处闸点（排除平台/跨租户闸）」
- 线B 数据模型：`git add db/migrate/2026-09-04-tenant-created-by.sql db/schema.sql db/migrate.js` → 提交「feat(tenant): crm.tenants 加 created_by_user_id/username」
- 线C 后端捕获：`git add db/seed/tenantDefaults.js src/http/tenantRouter.js src/http/selfRegister.js` → 提交「feat(tenant): 后台+自助注册写入责任 sysadmin（含推荐者必填）」
- 线D 前端与列表：`git add src/web/tenant-management.html src/web/landing.html` → 提交「feat(ui): 租户列表创建者列+筛选、自助注册推荐者输入框」
- 线E 测试：`git add test/...` → 提交「test: sysadmin 角色与租户归属覆盖」
