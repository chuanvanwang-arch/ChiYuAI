# 第12项 用户管理配置（crm_users）— 设计计划

- 日期：2026-08-27
- 归属：配置中心 G1 平台与访问 / 运营组（id=12）
- 形态：端点+可编辑（含 org 归属与六角色绑定），对齐用户选择「含 org/角色绑定」
- 复用范式：第14项决策场景配置（GET/PUT + 决策第0闸 + 字段白名单 + 注入式 handler 测试）
- 状态：待批准

---

## §0 背景与目标

配置中心第12项 `用户管理 crm_users` 当前为 `pending`：仅有 `crm.crm_users` 表与登录读路径（`src/http/auth.js`），**无管理端点、无管理页**。本 Task 补齐：

- `GET /api/config/users` 用户列表（sysadmin 可读）
- `POST /api/config/users` 新建用户（密码 crypt hash、org_id、role∈六角色）
- `PUT /api/config/users` 改（display_name / role / org_id / 可选 password / enabled 启用态）
- 禁用 = `enabled=false` 软标记（**绝对物理删除**）
- 写操作经决策第0闸（`recordDecisionEvent('config_change')`）
- 前端 `users.html`（table + form，含 org 归属与六角色绑定 UI）

设计稿 `src/pages/S17.schema.js` 已存在但有 3 处偏差，本计划修正：
- 偏差① `dataBinding` 误指 `CRM_PERSON` 粒子 → 改为直查 `crm.crm_users`
- 偏差② table 列含 `status`（表无此列）→ 改为 `username/display_name/role/org_id/enabled`
- 偏差③ 密码明文编辑 → 前端 `secret` 字段仅作新建/改密输入，后端 `crypt` hash，明文永不出 node 进程、不进日志

---

## §1 范围与红线

**范围**
- 后端：列表 / 新建 / 改 / 禁用（软标记）
- 前端：用户列表 + 新建/编辑表单（含 org_id 与角色下拉）
- schema：crm_users 增 `enabled` 列（幂等）
- 配置中心第12卡 `pending` → `ready`

**红线（不可妥协）**
1. 密码安全：写密码一律 `crypt($1, gen_salt('bf'))` hash；明文仅在请求体出现、不落库、不进日志、不回显。
2. 权限：写端点（POST/PUT）仅 `role==='admin'`（sysadmin）可调用；读端点（GET）sysadmin 可读。复用 `resolveMe(req)` 取角色。
3. 绝对禁删：`crm_users` 不做任何 `DELETE`；禁用 = `enabled=false`。与 mcp_identity 同纪律。
4. 决策第0闸：每次写操作须 `recordDecisionEvent('config_change', {...})` 沉淀治理事件（满足「无决策不写」）。
5. 角色白名单：`['sales','manager','presales','contract_admin','finance','admin']`（对齐审批流种子 role 枚举 + role_context_profile）。越界→400。

---

## §2 后端模块 `src/portal/userManagement.js`

纯函数 + 路由工厂，浏览器/vitest 共用（无 DOM 依赖），与 `decisionScenario.js` 同构。

### 2.1 纯函数
- `validateUserPatch(patch, { requireUsername=false })`：校验 PUT 字段
  - 允许字段：`display_name`(string,≤64) / `role`(∈白名单) / `org_id`(string|null) / `password`(string,≥8，可选) / `enabled`(boolean)
  - 未知字段→拒绝；类型错→拒绝；role 越界→拒绝
- `validateCreateUser(body)`：校验 POST
  - 必填：`username`(string,unique 由 DB 约束) / `password`(≥8) / `role`(∈白名单)
  - 可选：`display_name` / `org_id`
  - 返回归一化 payload（不含明文密码，含 hash 占位由 router 填）
- `renderUsers(users)`：按 role 分组卡片/表格行（enabled 标注）

### 2.2 路由工厂 `createUserRouter(deps)`
`deps = { query, recordDecisionEvent, resolveMe, hashPassword, listRoleTags }`
- `GET /api/config/users`：`resolveMe`→非 admin 则 403；`SELECT user_id,username,display_name,role,org_id,enabled,created_at FROM crm.crm_users ORDER BY created_at`；返回列表
- `POST /api/config/users`：403 检查→`validateCreateUser`→`hashPassword(password)`→`INSERT ... (username,password_hash,role,display_name,org_id,enabled) VALUES($1,crypt($2,gen_salt('bf')),$3,$4,$5,true)`→`recordDecisionEvent('config_change',{type:'user_create',username})`→返回 `{ok:true,userId}`
- `PUT /api/config/users`：403 检查→body `{user_id, patch}`→`validateUserPatch`→组装 SET（password 走 `password_hash=crypt($n,gen_salt('bf'))`）→`UPDATE crm.crm_users SET ... WHERE user_id=$1`（**无 updated_at 列，变更时间由决策事件承载**）→`recordDecisionEvent('config_change',{type:'user_update',user_id,fields})`→返回 `{ok:true, decision}`
- 禁用：`PUT` 传 `{user_id, patch:{enabled:false}}`（复用 PUT，不单设端点）

**默认 deps**：`createUserRouter({})` 从 `../db.js` / `../decision/decisionRepo.js` / `../http/auth.js` 取真实依赖（与 decisionScenario 同构）。

---

## §3 schema 变更 `db/migrate-config.sql`

在 `crm.crm_users` 建表段后追加（幂等）：
```sql
ALTER TABLE crm.crm_users
  ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT TRUE;
```
- 已存在用户默认 `enabled=true`（兼容登录）
- 不补 `updated_at`（变更时间由 config_change 决策事件承载，与 decision_scenario 一致）

---

## §4 前端 `src/web/users.html`

`#users-root` + `<script type="module">` import `* as um`；纯函数 `renderUsers` 共用。
- 列表：`username / display_name / role / org_id / enabled` 表格
- 新建按钮：行内表单（username/display_name/password[secret]/role[select 六角色]/org_id）
- 编辑：行内表单（display_name/role/org_id/可选 password/enabled 开关）
- 角色下拉选项来自 `GET /api/config/users` 之外的静态六角色常量（或 `listRoleTags` 端点；本期用静态白名单常量，对齐 `role_context_profile` 语义）
- `setInterval(load, 15000)`；失败降级提示
- 密码字段 `type=password`，提交后清空，绝不在 DOM 持久化明文

---

## §5 路由挂载 + configCenter 翻转

- `src/http/routes.js`：`import { createUserRouter }`；挂载区 `app.use(createUserRouter({}))`；静态 `/users.html` + `/config/users`(302) + `/portal/userManagement.js`(text/javascript)
- `src/portal/configCenter.js`：第12卡 `{ id:12, name:'用户管理', group:'运营', status:'ready', page:'/users.html', endpoint:'/api/config/users', note:'增/改/禁用(禁删)，密码 crypt hash，sysadmin 权限，写经决策第0闸' }`
- `src/web/nav.js`：加 `{ href:'/users.html', label:'👤 用户管理' }`（若 config 页有用户管理入口）

---

## §6 测试（TDD RED→GREEN）

`test/web/userManagement.test.js`（注入式 handler + 假 deps，对齐 decisionScenario.test.js）：
- 纯函数：`validateUserPatch`（合法/未知字段/role 越界/坏类型/enabled 非 bool/password 短）6 例
- `validateCreateUser`（缺 username/缺 password/role 越界/合法）4 例
- `renderUsers`（分组/空降级）2 例
- handler：GET 列表（8 行假数据）/ POST 新建落库+hash+决策事件 / POST 缺密码 400 / PUT 改 role 落库+决策事件 / PUT role 越界 400 / PUT enabled=false 禁用 / 非 admin 写 403 / 还原 8 例
- 假 deps：`query` mock（内存数组模拟 crm_users）、`recordDecisionEvent` mock 返回 `{event_id}`、`resolveMe` mock 返回 `{role:'admin'}`、`hashPassword` mock 返回固定串（验证调用而非真实 hash）

---

## §7 GAP / 风险

- **G1 角色下拉数据源**：本期用静态六角色白名单常量（与审批流枚举一致）。若未来 `role_context_profile` 有种子，可改 `listRoleTags` 端点动态拉取。低风险。
- **G2 首个 admin 用户**：本 Task 不创建初始 admin（登录基础已存在）。若真实库无 admin，运维须手工 `INSERT`（crypt hash）。不影响本 Task 端点实现与测试（测试用假 admin）。
- **G3 enabled 列迁移**：`ALTER TABLE ADD COLUMN IF NOT EXISTS` 幂等，真实库与 plm_test 均安全。种子用户默认 enabled=true。
- **G4 密码强度**：本期仅 `≥8` 最小约束，未做复杂度策略。后续可加。

---

## §8 提交物（沙箱无凭证，用户本地 commit）

```
src/portal/userManagement.js              (新)
test/web/userManagement.test.js           (新)
src/web/users.html                        (新)
db/migrate-config.sql                     (改：crm_users ADD enabled)
src/http/routes.js                        (改：挂载+静态)
src/portal/configCenter.js                (改：第12卡 ready)
src/web/nav.js                            (改：入口)
docs/superpowers/plans/2026-08-27-user-management-config.md (新)
```
建议 commit message：
`feat(config): 第12项 用户管理端点+可编辑（GET/POST/PUT+禁用软标记，密码 crypt hash，sysadmin 权限，写经决策第0闸）`
