# CRM 独立数据库设计（database 级隔离）

> 状态：已批准（2026-09-01，brainstorming P5 闸门）
> 关联：docs/2026-09-01-mcp-tenant-resolution-design.md（MCP 通道租户解析补齐，同轮实施）
> 铁律：零 DELETE（plm.crm 原样保留）；不动前端；不动 PDM/PLM 对 plm 库的使用。

---

## §0 背景与动机

CRM-ai-native 自 2026-08-24 选型起，一直**复用 PDM/PLM 项目的同一个 PostgreSQL 实例（@5433）、同一个 `plm` 数据库**，仅落在独立的 `crm` schema 内（`search_path=crm,public`）。当初的"隔离"只做到 **schema 级**：

- `src/db.js:1-2` 注释：`// 现有 PG16@5433，agent2b 用户，plm 库内 crm schema（与 PDM 隔离）`
- `src/db.js:17,28`：`database: process.env.PGDATABASE || 'plm'`

schema 级隔离 ≠ 项目级隔离：备份、权限、容量、故障域全部与 `plm` 库绑死。用户明确裁决：**不同项目需要分库**。本设计将 CRM 拆为独立 database `crm_native`（生产）/ `crm_native_test`（测试），与 PDM/PLM 的 `plm` 库彻底分离。

---

## §1 目标

1. CRM 使用独立 database，与 `plm` 库物理分库（同实例 @5433 即可满足"分库"诉求，避免再起一个 PG 实例的运维成本）。
2. 新库开箱即用：schema + 表 + 扩展 + **用户种子（admin 登录）** + 演示数据齐备。
3. 全仓连接配置统一 repoint 到新库名，无 `plm` 硬编码残留。
4. `plm` 库内 `crm` schema 原样保留（禁删铁律），PDM/PLM 不受影响。

---

## §2 现状盘点（证据）

| 项 | 现状 | 证据 |
|---|---|---|
| 迁移主入口 | `db/migrate.js` 读 `schema.sql` 建 `crm` schema + 表 + `pgcrypto`/`vector`；`--seed` 灌 `seed.sql`；`--age` 建 AGE 图 | `db/migrate.js:5,9,62-86` |
| 默认库名 | `src/db.js:17,28` `database: process.env.PGDATABASE || 'plm'`；PGSCHEMA 默认 `'crm'`（`src/db.js:8`） | 已读 |
| 测试库名 | `vitest.config.js:9` `process.env.PGDATABASE = process.env.CRM_TEST_DB || 'plm_test'` | 已读 |
| 预测试种子 | `package.json:12` `"pretest": "PGDATABASE=plm_test node scripts/seed-test-config.mjs"` | 已读 |
| **crm_users 种子缺口** | `seed.sql` / `seed-master-data.sql` / `test-setup.sql` **均不灌 `crm_users`**；全仓 `INSERT INTO crm.crm_users` 仅出现在 test、tmp、`src/http/tenantRouter.js:26`（建租户时建 admin）、`src/portal/userManagement.js:112`（UI 建用户）、`scripts/seed-tenant-demo.mjs:17` | grep 实测 |
| AGE 扩展 | `schema.sql` **不装 `age`**；`db/enable-age.sql:8` 注明 agent2b 无 `CREATE EXTENSION age` 权限，须 superuser 预装 | 已读 |
| 建库脚本 | 仓库无 `CREATE DATABASE`（plm/plm_test 系 DBA 手动建） | grep 无 `CREATE DATABASE` |
| 硬编码 `|| 'plm'` 的脚本 | `seed-workbench-data.mjs:18`、`seed-visible-approval-tasks.mjs:16`、`seed-seven-dim.mjs:12`、`seed-named-accounts-demo.mjs:14`、`seed-insight-demo.mjs:12`、`enrich-workbench-data.mjs:15`、`backup-crm-pre-migration.mjs:11`、`_seed_verify.mjs:8`（DSN）、`tmp_probe_db.mjs:2`、`tmp_apply_patch.mjs:6` | grep 实测 |
| 硬编码 `|| 'plm_test'` 的脚本 | `scripts/seed-test-config.mjs:16` | grep 实测 |

---

## §3 方案

**同实例新建库 `crm_native` + `crm_native_test`，重新 seed**（用户 2026-09-01 裁决，推荐方案）。

- 库名 `crm_native`（生产）/ `crm_native_test`（测试）：schema 名仍为 `crm`，代码 `crm.xxx` 引用不变，改动收敛。
- 不迁 `plm.crm` 现有数据（经前期核查均为种子/演示数据，视为可丢弃；且禁删铁律要求保留 plm.crm 原样）。
- AGE 图扩展由 superuser 在新库各跑一次 `db/enable-age.sql`。

---

## §4 改动清单（6 Task，每 Task 一 commit）

### T1 建库 + AGE 扩展（DBA 一次性，superuser）
- `createdb crm_native` / `createdb crm_native_test`
- 每库 `psql -U postgres -d <db> -f db/enable-age.sql`（装 `age` 扩展 + 建 `crm_decision_network` 图）
````contract-yaml
- task: "T1 建库 crm_native/crm_native_test + AGE 扩展"
  agent: crm-copilot
  skills: []
  memory: []
  success: "crm_native 与 crm_native_test 两库 EXISTS；各自 crm schema 就绪；age 扩展已装（或记录降级 CTE 生效）"
````

### T2 迁移 + 补用户种子到新库
- **新增 `db/seed-users.sql`**：插入 `admin`（role=admin，密码 `admin123`）+ `alice`（role=sales），用 `crypt($2, gen_salt('bf'))`，`WHERE NOT EXISTS` 幂等。
- `db/migrate.js` 的 `--seed` 分支在跑完 `seed.sql` 后**顺带执行 `seed-users.sql`**（让一次 `--seed` 产出可登录的 CRM 库）。
- **必须补跑 `db/migrate-tenant.js`**：该脚本给 `crm.crm_users` 加 `tenant_id` 列（`migrate-tenant.js:8`，`mcpLogin` 依赖此列；基表 `schema.sql:352-360` 只有 `org_id` 无 `tenant_id`）。否则新建库 `crm_users` 缺 `tenant_id`，MCP 登录报错。
- 执行序列（新库须先经 T1 建库）：
  ```
  PGDATABASE=crm_native node db/migrate.js --seed --age
  PGDATABASE=crm_native node db/migrate-tenant.js
  # 测试库额外需要 scenario/flow 演示数据：
  PGDATABASE=crm_native_test node db/migrate.js --seed --age
  PGDATABASE=crm_native_test node db/migrate-tenant.js
  PGDATABASE=crm_native_test node -e "import('node:fs').then(async fs=>{const {pool}=await import('./src/db.js');await pool.query(fs.readFileSync('./db/test-setup.sql','utf8'));await pool.end();})"
  ```
- **特性迁移补全（按需）**：为达到与生产 `plm.crm` 同等特性覆盖，下列文件也应对 `crm_native` 各跑一次（均为幂等 DDL）：`db/migrate-approval-flow-wiring.mjs`、`db/migrate-agent-contract-feedback.sql`、`db/migrate-config.sql`、`db/migrate-monitor-event-agent.sql`、`db/migration-decision-rule.sql`、`db/migration-confirm-audit.sql`、`db/migration-particle-meta.sql`、`db/migration-conflict.sql`、`db/migrate-named-owner-backfill.sql`、`db/cleanup-methodology-skew.sql`、`db/fix-2026-08-27-dirty-deal.sql`。`npx vitest run` 会暴露任何缺失 DDL，补跑对应文件即可。
````contract-yaml
- task: "T2 迁移 schema+粒子+用户种子到 crm_native"
  agent: crm-copilot
  skills: []
  memory: []
  success: "PGDATABASE=crm_native node db/migrate.js --seed --age 成功；crm.particles 有演示数据；crm.crm_users 有 admin(admin123) 且 crypt 校验通过"
````

### T3 Repoint 连接配置（核心代码改动）
- `src/db.js:17,28`：`'plm'` → `'crm_native'`
- `vitest.config.js:9`：`'plm_test'` → `'crm_native_test'`
- `package.json:12` pretest：`PGDATABASE=plm_test` → `PGDATABASE=crm_native_test`
````contract-yaml
- task: "T3 repoint 默认库名 plm→crm_native / plm_test→crm_native_test"
  agent: crm-copilot
  skills: []
  memory: []
  success: "src/db.js 默认 crm_native；vitest.config.js 默认 crm_native_test；npm run pretest 指 crm_native_test"
````

### T4 Repoint 脚本硬编码 plm
- 下列脚本连接默认 `|| 'plm'` → `|| 'crm_native'`：`seed-workbench-data.mjs`、`seed-visible-approval-tasks.mjs`、`seed-seven-dim.mjs`、`seed-named-accounts-demo.mjs`、`seed-insight-demo.mjs`、`enrich-workbench-data.mjs`、`backup-crm-pre-migration.mjs`、`_seed_verify.mjs`（DSN）、`tmp_probe_db.mjs`、`tmp_apply_patch.mjs`。
- `scripts/seed-test-config.mjs:16` `|| 'plm_test'` → `|| 'crm_native_test'`。
- 验收：`grep -rn "plm" --include=*.{js,mjs} src scripts db _seed_verify.mjs | grep -i database` 无 `plm` 残留（注释与 DBA 说明文档除外）。
````contract-yaml
- task: "T4 repoint 脚本/临时文件硬编码 plm→crm_native"
  agent: crm-copilot
  skills: []
  memory: []
  success: "全仓连接默认 `|| 'plm'`→crm_native；`|| 'plm_test'`→crm_native_test；grep 无连接级 plm 残留"
````

### T5 验证
- `npx vitest run` 全绿（强制连 `crm_native_test`）。
- 直查 `crm_native`：`crm.crm_users` 含 admin；`crypt('admin123', password_hash)=password_hash` → true。
- 登录 `POST /api/auth/login {admin/admin123}` 成功换 token。
- 确认 `plm.crm` schema 仍存在、未被删/改（禁删铁律）。
````contract-yaml
- task: "T5 全量验证（测试全绿 + 新库可登录）"
  agent: crm-copilot
  skills: [data-particle-read]
  memory: []
  success: "npx vitest run 全绿（连 crm_native_test）；直查 crm_native 有 admin 且登录成功；plm.crm 原样保留"
````

### T6 文档验证命令更新（低风险）
- 今日两份设计文档（`2026-09-01-mcp-tenant-resolution-design.md`、`2026-09-01-crm-standalone-database-design.md`）中 `PGDATABASE=plm_test` 验证命令 → `crm_native_test`。
````contract-yaml
- task: "T6 文档验证命令 plm_test→crm_native_test"
  agent: crm-copilot
  skills: []
  memory: []
  success: "设计文档验证命令与代码默认库名一致"
````

---

## §5 风险与权衡

| 风险 | 说明 | 缓解 |
|---|---|---|
| AGE 扩展权限 | agent2b 无权 `CREATE EXTENSION age`，须 superuser 跑 `enable-age.sql` | T1 由 DBA 执行；跳过则 AGE 图降级 CTE 生效（决策网络图查询走 CTE，功能不崩但图查询面缺失） |
| 用户种子缺口 | `crm_users` 原无任何种子文件，新库不补则无法登录 | T2 新增 `db/seed-users.sql` 并由 `migrate.js --seed` 自动执行 |
| 测试库首跑需建 schema | `crm_native_test` 首次须手动跑一次 `db/migrate.js --seed`（同 plm_test 惯例） | 实施时先跑迁移再 `npm test`；`pretest` 仅灌 config |
| 零删除 | `plm.crm` 含历史种子/演示数据 | 原样保留，CRM 不再读取；PDM/PLM 不受影响 |

---

## §6 验证脚本（供本地执行）

```powershell
# 1. 建库（superuser）
createdb crm_native; createdb crm_native_test
# 2. 每库启用 AGE（superuser）
psql -U postgres -d crm_native -f db/enable-age.sql
psql -U postgres -d crm_native_test -f db/enable-age.sql
# 3. 迁移 + 种子（含用户种子）+ AGE 图 + 租户列
$env:PGDATABASE="crm_native"; node db/migrate.js --seed --age; node db/migrate-tenant.js
$env:PGDATABASE="crm_native_test"; node db/migrate.js --seed --age; node db/migrate-tenant.js
# 测试库补 scenario/flow 演示数据
$env:PGDATABASE="crm_native_test"; node -e "import('node:fs').then(async fs=>{const {pool}=await import('./src/db.js');await pool.query(fs.readFileSync('./db/test-setup.sql','utf8'));await pool.end();})"
# 4. 测试
npx vitest run
# 5. 直查确认
$env:PGDATABASE="crm_native"; node --input-type=module -e "import {query} from './src/db.js'; const r=await query(\"SELECT username,role FROM crm.crm_users WHERE username='admin'\"); console.log(JSON.stringify(r.rows));"
```

---

## §7 回滚

- 任一 Task 失败，回退手段：将 `src/db.js` / `vitest.config.js` / `package.json` 的库名改回 `plm` / `plm_test` 即恢复现状——**不删任何数据**，回滚零风险。
- 新建的 `crm_native` / `crm_native_test` 库如不再需要，由 DBA 手动 `dropdb`（非本设计范畴，且不在自动执行内）。

---

## §8 自检清单

- [x] §A 每个 Task 含 `task/agent/skills/memory/success` 五字段
- [x] `agent: crm-copilot` 为项目主智能体（参照既有契约惯例）
- [x] 铁律合规：零 DELETE；不动前端；不迁 plm.crm（保留）；不动 PDM/PLM
- [x] 用户种子缺口已识别并在 T2 闭环（否则新库不可用）
- [x] AGE 扩展权限约束已在 §5/§6 显式说明（superuser 步骤）
- [x] file:line 证据齐备（§2 现状盘点表）
- [x] 验证命令与代码默认库名一致（T3/T6 闭环）

> P7 契约校验：仓库未提供 `scripts/validate-contract.mjs` 时，按 brainstorming 规范做**结构自检**（上表已完成）；若后续提供校验器，补跑 `node scripts/validate-contract.mjs <doc> --registry src/agent/agentSpec.js`。

---

## §A 闭环回写

| Task | 预期 SKILL | 预期记忆 | 成功判定 |
|---|---|---|---|
| T1 | — | — | 两库 EXISTS + age 已装 |
| T2 | — | — | 新库有 particles + admin 可登录 |
| T3 | — | — | 默认库名切换 |
| T4 | — | — | 无连接级 plm 残留 |
| T5 | data-particle-read | — | 测试全绿 + 登录通 |
| T6 | — | — | 文档与代码一致 |
