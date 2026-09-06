---
name: system-bootstrap
description: CRM-ai-native 平台「系统初始化」Runbook——首次部署的幂等引导：数据库迁移（tenant-isolation 等）+ 种子 UPSERT（默认账号 / 行业租户）+ 配置引导（LLM/system/tenant-profile）+ 注册 sysadmin 角色 + 校验清单。须 crm_login 登录验证 + 仅 sysadmin 角色可执。触发词：系统初始化、初始化、跑迁移、重置种子、引导默认配置、bootstrap、首次部署。
type: domain
immutable_baseline: true
related_skills:
  - user-rbac-admin         # Step 4 注册 sysadmin 角色 = 本 SKILL 的授权落地；用户/权限日常新增走该 SKILL
  - industry-onboarding     # Step 2 行业租户种子 = 行业上线前置；多行业逐个走 industry-onboarding
  - crm-config-center-settings   # Step 3 配置引导经配置中心 PUT（自带第0闸）
---

# 系统初始化 Runbook（System Bootstrap）

## 0. 定位与边界

- 本 SKILL 是**首次部署 / 环境重建**的一站式引导：让一套空的 CRM-ai-native 实例进入「可用」状态——库表就位、默认账号就位、默认配置就位、平台治理角色就位。
- **不是**日常业务操作：日常新增行业走 `industry-onboarding`、日常增用户走 `user-rbac-admin`；本 SKILL 仅做「从 0 到 1」的底座引导。
- **准入要求（双闸，缺一不可）**：① 必须先 `crm_login(username, password)` 验证通过（`gate != 'auth_required'`）；② 操作者角色必须为 **`sysadmin`**。普通 `admin` / 其它角色 → 403。
- 全程**幂等、禁删**：迁移 `IF NOT EXISTS` / `ON CONFLICT`；种子 `UPSERT`；配置 `writeConfig` upsert；绝不物理 DELETE。

## 1. 红线（系统初始化铁律）

| 红线 | 说明 |
|---|---|
| 必须登录验证（首闸） | 任何初始化操作前须 `crm_login` 验证通过；未登录 / 凭证失效 → 一律拒绝。 |
| sysadmin 角色闸（唯一） | 初始化写操作**仅** `sysadmin` 角色可执；普通 `admin` → 403。 |
| 绝对禁 DELETE | 迁移 / 种子 / 配置一律 upsert / 软停用；绝不 `DROP` / `DELETE` 生产数据。 |
| 幂等可重跑 | 所有脚本 `IF NOT EXISTS` / `ON CONFLICT`；重复执行结果一致，不报错不重复插入。 |
| 写必经决策第 0 闸 | 涉及配置写（Step 3）自动 `produceDecision`；种子旁路仅系统引导期使用。 |
| per-tenant 隔离 | 默认配置落 `system` 租户；行业租户种子按 `tenant_id` 隔离。 |

## 2. Step 1 — 跑数据库幂等迁移

```powershell
# 生产库（crm_native）先探活，再跑迁移
$env:PGDATABASE="crm_native"
node db/migrate.js            # 单一事实源：db/schema.sql + db/migrations/*（幂等）
# 若启用多行业租户，确保已含隔离迁移（可重复执行）：
# psql -h 127.0.0.1 -p 5433 -U agent2b -d crm_native -f db/migrations/2026-09-03-tenant-isolation.sql
```

**校验**：`node --input-type=module -e "import('./src/db.js')"` 连接 OK；`information_schema` 确认 `crm.particles`(15 列) / `crm.decision`(43 列) 等核心表就位（以当前实例为准，勿引用过时基线）。

## 3. Step 2 — 种子 UPSERT（默认账号 + 行业租户）

```powershell
# 默认账号（admin / alice，属 system 租户）+ 业务种子
$env:PGDATABASE="crm_native"
# db/seed.sql / db/test-setup.sql（幂等 UPSERT，禁 DELETE）
node -e "/* 走 npm run seed 等效 */"
# 或：npm run seed

# 多行业租户一次性引导（写 profile + 初始用户，幂等）：
# node db/seed/seed-all-tenants.mjs
```

- 默认引导账号：`admin`(admin) / `alice`(sales) 属 `system` 租户（`db/seed-users.sql` 范式，`crypt()` 哈希）。
- 行业租户种子：`db/seed/tenant-profile-<industry>.js` + `db/seed/tenant-users-<industry>.js` 经 `seed-all-tenants.mjs` 幂等落库（写 profile + 初始销售员）。逐个行业走 `industry-onboarding` 范式。

## 4. Step 3 — 配置引导（经配置中心 PUT，自带第 0 闸）

默认平台 / 治理配置落 `config_store`（或专属表），全部 upsert：

```powershell
# 角色：sysadmin；PUT 自带决策第 0 闸（无需手动 mint decision_id）
# LLM 配置（id11，密钥字段 api_key 加密掩码）： PUT /api/config/llm
# 系统设置（id28）： PUT /api/config/system
# 行业租户画像（key='tenant-profile'，逐行业）： PUT /api/config/tenant-profile
# 其它出厂默认：判定阈值 / 七维 / 审批流 等按各配置项 SKILL 引导
```

要点：
- **不要命令行绕行**：配置中心 PUT 自带第 0 闸，优先用 PUT（设计铁律）。
- 密钥字段（如 LLM `api_key`）PUT 提供明文即加密落库，GET 返回 `********`；不提供则保留既有。
- 业务数值禁硬编码：阈值 / 权重一律 `config_store` 承载，代码仅存出厂默认。

## 5. Step 4 — 注册并授予 sysadmin 角色（平台治理解锁）

首次部署后，须让平台管理员账号具备 `sysadmin` 角色，否则 `industry-onboarding` / `user-rbac-admin` / `system-bootstrap` 均因角色闸被拒：

```powershell
# 用默认 admin 账号 crm_login 验证后，PUT /api/rbac 注册 sysadmin 并赋给管理员
# Authorization: Bearer <admin_token>
# Body:
# { "role": "sysadmin", "data_scope": { "tenant_id": "*" }, "permissions": ["platform:all"] }
# → 200 { role:"sysadmin", data_scope, permissions, decision:<decision_id> }
```

> 治理提示：默认 `admin` 账号仅具 `admin` 角色；平台治理操作需 `sysadmin`。本步将 `sysadmin` 角色授给指定管理员账号后，该账号方可执行全部平台治理 SKILL。日常新增管理员复用 `user-rbac-admin` 的 RBAC 配置范式。

## 6. Step 5 — 校验清单（提交前必跑）

- [ ] `node db/migrate.js` 幂等跑通，核心表列数就位（参考 Step 1 校验）。
- [ ] 默认账号 `admin` / `alice` 可登录（`crm_login` 返回 token，role 正确）。
- [ ] `config_store` 默认配置（llm / system / tenant-profile 等）已 upsert 落入。
- [ ] `sysadmin` 角色已在 `crm.rbac` 注册并赋给管理员账号（Step 4）。
- [ ] 路由加载 OK：`node --input-type=module -e "import('./src/http/routes.js')"` 无环依赖报错。
- [ ] 回归基线不降：用户本地起 CRM Postgres 跑全量测试（涉及 DB 改动须同步 schema + 迁移 + ensure 三处）。
- [ ] MCP 探活：启动 `node src/mcp/server.js --http`（3001），`crm_login` 握手成功，工具列表可用。

## 7. 调用示范

**用户指令**：「初始化系统 / 跑一遍引导」
→ ① `crm_login(admin, <密码>)` 验证通过（首闸）。
→ ② `node db/migrate.js`（Step 1）+ `npm run seed`（Step 2），幂等落库。
→ ③ 配置引导：`PUT /api/config/llm`、`PUT /api/config/system`（Step 3，自带第 0 闸）。
→ ④ `PUT /api/rbac` 注册 `sysadmin` 并赋给 `admin` 账号（Step 4）→ 平台治理解锁。
→ ⑤ 跑校验清单（Step 5）：路由加载 OK + 默认账号可登录 + MCP 探活成功。
→ 交付：实例进入「可用」状态，管理员以 `sysadmin` 角色可执行后续行业上线 / 用户权限治理。

## 8. 铁律声明

本 SKILL 是**领域专属**系统初始化操作手册，与 10 大 ai-* 方法论能力 SKILL **无关、不交叉写入**。通用方法论以交叉引用复用，绝不向 ai-* 基线增删改任何内容。
