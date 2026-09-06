# CRM 独立数据库（crm_native / crm_native_test）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 CRM 从 `plm` 库（@5433 内的 `crm` schema）拆到独立 database `crm_native`（生产）/ `crm_native_test`（测试），实现 database 级隔离；新库开箱即用（schema + 扩展 + 用户种子 + 演示数据）。

**Architecture:** 同 PG 实例 @5433 新建两库；schema 名仍为 `crm`（代码 `crm.xxx` 引用不变，改动收敛）；`src/db.js` 默认库名 repoint；所有脚本硬编码 `plm` 改 `crm_native`；`crm_users` 的 `enabled`/`tenant_id` 烘焙进 `schema.sql` 基表，使 `db/migrate.js --seed` 一步产出可登录库。

**Tech Stack:** Node 22 + ESM + PostgreSQL 16（pgcrypto / vector / age 扩展）；`pg` 连接池；vitest（测试隔离）。

> 关联设计：`docs/2026-09-01-crm-standalone-database-design.md`（已批准，含 §A 契约与铁律）。

---

## 铁律（全程适用）

- **零 DELETE**：`plm` 库内 `crm` schema 原样保留，CRM 不再读取；不删任何行/表/库（新建库由 DBA 手动 `createdb`，非自动 DROP）。
- 不动前端、不动 PDM/PLM 对 `plm` 库的使用。
- `agent2b` 无权 `CREATE EXTENSION age`，AGE 扩展须 superuser 跑 `db/enable-age.sql`（跳过则 AGE 图 CTE 降级，功能不崩）。
- 每 Task 一 commit；推进不等提问；file:line 证据。

---

## 前置：建库 + AGE 扩展（DBA / superuser 手动，T1）

> 沙箱/AI 无 CREATEDB 与 superuser 权限，**此步由用户在本地以 superuser 执行**。新库须 `OWNED BY agent2b`，否则后续 `node db/migrate.js` 无建表权限。

- [ ] **Step 1: 建库（superuser，owner=agent2b）**

```powershell
# 以 superuser（如 postgres）执行；-O agent2b 让 agent2b 拥有建表权限
createdb -O agent2b crm_native
createdb -O agent2b crm_native_test
```

- [ ] **Step 2: 每库启用 AGE 扩展（superuser）**

```powershell
psql -U postgres -d crm_native -f db/enable-age.sql
psql -U postgres -d crm_native_test -f db/enable-age.sql
```

Expected: 两库均输出含 `age` 扩展 + `crm_decision_network` 图。若跳过，`migrate --age` 会日志"C启用失败（降级 CTE 生效）"并继续。

---

## Task 1: 烘焙 `enabled` / `tenant_id` 进 crm_users 基表

**Files:**
- Modify: `db/schema.sql:352-360`（`crm.crm_users` CREATE TABLE）

- [ ] **Step 1: 在 crm_users 基表补 `enabled` 与 `tenant_id` 列**

`db/schema.sql` 当前（L352-360）：
```sql
CREATE TABLE IF NOT EXISTS crm.crm_users (
  user_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text UNIQUE NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL,
  display_name text NOT NULL,
  org_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
```
改为（新增两列，默认值对齐既有迁移）：
```sql
CREATE TABLE IF NOT EXISTS crm.crm_users (
  user_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text UNIQUE NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL,
  display_name text NOT NULL,
  org_id text,
  enabled boolean NOT NULL DEFAULT true,
  tenant_id text NOT NULL DEFAULT 'system',
  created_at timestamptz NOT NULL DEFAULT now()
);
```
> 说明：`plm` 库因 `CREATE TABLE IF NOT EXISTS` 跳过此块（表已存在），不受影响；既有 `db/migrate-config.sql:89`（`ADD COLUMN IF NOT EXISTS enabled`）、`db/migrate-tenant.js:8`（`ADD COLUMN IF NOT EXISTS tenant_id`）变为 no-op，安全幂等。新库 `crm_native` 自此一步获得完整 `crm_users`。

- [ ] **Step 2: Commit**

```bash
git add db/schema.sql
git commit -m "schema(crm_users): 烘焙 enabled/tenant_id 进基表，使新库 migrate 一步可登录"
```

---

## Task 2: 新增 seed-users.sql 并由 migrate --seed 执行

**Files:**
- Create: `db/seed-users.sql`
- Modify: `db/migrate.js:62-80`（`--seed` 分支追加执行 `seed-users.sql`）

- [ ] **Step 1: 新建 db/seed-users.sql（引导用户种子）**

```sql
-- db/seed-users.sql — 引导用户种子（admin 登录账号）
-- 幂等：WHERE NOT EXISTS 防重复；crypt 哈希不落明文；与 src/http/auth.js / src/mcp/auth.js 校验同款
-- 仅插基表列（enabled/tenant_id 由 schema.sql 默认值填充），与迁移顺序解耦
SET search_path TO crm, public;

INSERT INTO crm.crm_users (username, password_hash, role, display_name, org_id)
SELECT 'admin', crypt('admin123', gen_salt('bf')), 'admin', '系统管理员', 'system'
WHERE NOT EXISTS (SELECT 1 FROM crm.crm_users WHERE username = 'admin');

INSERT INTO crm.crm_users (username, password_hash, role, display_name, org_id)
SELECT 'alice', crypt('secret123', gen_salt('bf')), 'sales', 'Alice 销售', 'system'
WHERE NOT EXISTS (SELECT 1 FROM crm.crm_users WHERE username = 'alice');
```

- [ ] **Step 2: 修改 db/migrate.js，让 `--seed` 顺带执行 seed-users.sql**

`db/migrate.js` 当前 `--seed` 块（约 L62-74）：
```js
  if (seed) {
    // seed.sql 在 Task 10（种子注入）落地；当前不存在时给友好提示而非崩溃
    try {
      const seedSql = readFileSync(new URL('./seed.sql', import.meta.url), 'utf8');
      await pool.query(seedSql);
      console.log('[migrate] 种子已注入（幂等）');
    } catch (e) {
      if (e.code === 'ENOENT') {
        console.log('[migrate] 提示：seed.sql 尚未生成（Task 10 落地），跳过种子注入');
      } else {
        throw e;
      }
    }
```
在 `seed.sql` 执行之后、`runRiskScan` 之前，插入用户种子：
```js
    // 引导用户种子（admin 登录账号）——独立于演示粒子种子，保证新库可登录
    try {
      const userSql = readFileSync(new URL('./seed-users.sql', import.meta.url), 'utf8');
      await pool.query(userSql);
      console.log('[migrate] 用户种子已注入（幂等）');
    } catch (e) {
      if (e.code === 'ENOENT') {
        console.log('[migrate] 提示：seed-users.sql 尚未生成，跳过用户种子注入');
      } else {
        throw e;
      }
    }
```

- [ ] **Step 3: 验证用户种子可独立执行（连测试库，幂等）**

Run:
```powershell
$env:PGDATABASE="crm_native_test"; node -e "import('node:fs').then(async fs=>{const {pool}=await import('./src/db.js');await pool.query(fs.readFileSync('./db/seed-users.sql','utf8'));const r=await pool.query(\"SELECT username,role FROM crm.crm_users WHERE username IN ('admin','alice')\");console.log(JSON.stringify(r.rows));await pool.end();})"
```
Expected: `[{"username":"admin","role":"admin"},{"username":"alice","role":"sales"}]`（若 T1 尚未建库则报连接错——属预期，待 T1 完成后重跑）。

- [ ] **Step 4: Commit**

```bash
git add db/seed-users.sql db/migrate.js
git commit -m "feat(seed): 新增 seed-users.sql 并由 migrate --seed 执行，新库开箱可登录"
```

---

## Task 3: Repoint 连接配置（核心代码改动）

**Files:**
- Modify: `src/db.js:17,28`
- Modify: `vitest.config.js:9`
- Modify: `package.json:12`

- [ ] **Step 1: src/db.js 默认库名 plm → crm_native**

`src/db.js:17` 与 `:28`：
```js
  database: process.env.PGDATABASE || 'plm',
```
改为：
```js
  database: process.env.PGDATABASE || 'crm_native',
```

- [ ] **Step 2: vitest.config.js 测试库名 plm_test → crm_native_test**

`vitest.config.js:9`：
```js
process.env.PGDATABASE = process.env.CRM_TEST_DB || 'plm_test';
```
改为：
```js
process.env.PGDATABASE = process.env.CRM_TEST_DB || 'crm_native_test';
```

- [ ] **Step 3: package.json pretest 指 crm_native_test**

`package.json:12`：
```json
    "pretest": "PGDATABASE=plm_test node scripts/seed-test-config.mjs",
```
改为：
```json
    "pretest": "PGDATABASE=crm_native_test node scripts/seed-test-config.mjs",
```

- [ ] **Step 4: Commit**

```bash
git add src/db.js vitest.config.js package.json
git commit -m "refactor(db): repoint 默认库 plm→crm_native / plm_test→crm_native_test"
```

---

## Task 4: Repoint 脚本 / 临时文件硬编码 plm

**Files:**
- Modify（连接默认 `|| 'plm'` → `|| 'crm_native'`）：
  - `scripts/seed-workbench-data.mjs:18`
  - `scripts/seed-visible-approval-tasks.mjs:16`（`const PGDATABASE = process.env.PGDATABASE || 'plm';`）
  - `scripts/seed-seven-dim.mjs:12`
  - `scripts/seed-named-accounts-demo.mjs:14`
  - `scripts/seed-insight-demo.mjs:12`
  - `scripts/enrich-workbench-data.mjs:15`
  - `scripts/backup-crm-pre-migration.mjs:11`（`const TARGET = process.env.PGDATABASE || 'plm';`）
  - `_seed_verify.mjs:8`（DSN `...5433/plm?schema=crm` → `...5433/crm_native?schema=crm`）
  - `tmp_probe_db.mjs:2`（`database: 'plm'` → `'crm_native'`）
  - `tmp_apply_patch.mjs:6`（`database: 'plm'` → `'crm_native'`）
- Modify（`|| 'plm_test'` → `|| 'crm_native_test'`）：
  - `scripts/seed-test-config.mjs:16`（`const PGDATABASE = process.env.PGDATABASE || 'plm_test';`）
- Modify（用法注释，非连接但需一致）：
  - `db/migrate-tenant.js:2` 注释 `PGDATABASE=plm_test node db/migrate-tenant.js` → `crm_native_test`

- [ ] **Step 1: 逐文件替换连接默认库名**

对上列每个 `database: process.env.PGDATABASE || 'plm'` 改为 `database: process.env.PGDATABASE || 'crm_native'`；`const PGDATABASE = process.env.PGDATABASE || 'plm'` 改为 `|| 'crm_native'`；`_seed_verify.mjs` DSN 的 `/plm?schema=` 改为 `/crm_native?schema=`；`tmp_*.mjs` 的 `database: 'plm'` 改为 `'crm_native'`；`seed-test-config.mjs` 的 `|| 'plm_test'` 改为 `|| 'crm_native_test'`；`migrate-tenant.js:2` 注释 `plm_test` → `crm_native_test`。

- [ ] **Step 2: 验收——全仓无连接级 plm 残留**

Run（PowerShell，在仓库根）：
```powershell
rg -n "PGDATABASE\s*=\s*'plm'|database:\s*process\.env\.PGDATABASE\s*\|\|\s*'plm'|/plm\?schema" src scripts db _seed_verify.mjs tmp_probe_db.mjs tmp_apply_patch.mjs
```
Expected: 无匹配（注释/DBA 说明文档中的历史提及除外，如 docs/ 内 plm 说明）。

- [ ] **Step 3: Commit**

```bash
git add scripts/seed-workbench-data.mjs scripts/seed-visible-approval-tasks.mjs scripts/seed-seven-dim.mjs scripts/seed-named-accounts-demo.mjs scripts/seed-insight-demo.mjs scripts/enrich-workbench-data.mjs scripts/backup-crm-pre-migration.mjs scripts/seed-test-config.mjs _seed_verify.mjs tmp_probe_db.mjs tmp_apply_patch.mjs db/migrate-tenant.js
git commit -m "refactor(scripts): repoint 硬编码 plm→crm_native / plm_test→crm_native_test"
```

---

## Task 5: 验证（全量回归 + 新库可登录）

> 前置：T1 已由 DBA 完成（crm_native / crm_native_test 存在且 owner=agent2b，AGE 已装）。

- [ ] **Step 1: 迁移 + 种子到两库（含用户种子 + 租户列）**

```powershell
$env:PGDATABASE="crm_native"; node db/migrate.js --seed --age; node db/migrate-config.sql 2>$null; node db/migrate-tenant.js
$env:PGDATABASE="crm_native_test"; node db/migrate.js --seed --age; node db/migrate-config.sql 2>$null; node db/migrate-tenant.js
# 测试库补 scenario/flow 演示数据
$env:PGDATABASE="crm_native_test"; node -e "import('node:fs').then(async fs=>{const {pool}=await import('./src/db.js');await pool.query(fs.readFileSync('./db/test-setup.sql','utf8'));await pool.end();})"
```
> 注：`db/migrate-config.sql` 为 .sql 文件，用 `node -e` 经连接池执行；若含 psql 元命令则改 `psql -U agent2b -d crm_native -f db/migrate-config.sql`。`migrate-config.sql`/`migrate-tenant.js` 对 crm_users 的加列现为 no-op（Task 1 已烘焙），但对 config_store / mcp_identity / decision 等仍生效，必须跑。

- [ ] **Step 2: 全量测试（强制连 crm_native_test）**

Run:
```powershell
npx vitest run
```
Expected: 全绿（与改造前基线一致）。若有失败指向"关系/表不存在"，按设计文档 T2「特性迁移补全」列表补跑对应 `db/migrate-*.{mjs,sql}` / `db/migration-*.sql` 后重跑。

- [ ] **Step 3: 直查 crm_native 有 admin 且密码可校验**

Run:
```powershell
$env:PGDATABASE="crm_native"; node --input-type=module -e "import {query} from './src/db.js'; const r=await query(\"SELECT username,role,enabled,tenant_id FROM crm.crm_users WHERE username='admin'\"); console.log(JSON.stringify(r.rows)); const ok=await query(\"SELECT crypt('admin123', password_hash)=password_hash AS ok FROM crm.crm_users WHERE username='admin'\"); console.log('admin/admin123 校验:', ok.rows[0]?.ok);"
```
Expected: `[{"username":"admin","role":"admin","enabled":true,"tenant_id":"system"}]` 与 `admin/admin123 校验: true`。

- [ ] **Step 4: 登录冒烟（HTTP 通道）**

Run:
```powershell
node --input-type=module -e "fetch('http://127.0.0.1:3000/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'admin123'})}).then(r=>r.json()).then(j=>console.log('login ok:', !!j.token, 'tenantId:', j.tenantId))"
```
Expected: `login ok: true tenantId: system`（需服务已起；若未起可仅依赖 Step 3 的密码校验）。

- [ ] **Step 5: 确认 plm.crm 原样保留（禁删铁律）**

Run:
```powershell
$env:PGDATABASE="plm"; node --input-type=module -e "import {query} from './src/db.js'; const r=await query(\"SELECT count(*) FROM crm.crm_users\"); console.log('plm.crm.crm_users 行数:', r.rows[0].count);"
```
Expected: 仍为改造前数值（9），未被删/改。

- [ ] **Step 6: Commit（无代码变更则跳过）**

本 Task 无新代码文件；若仅需提交验证产物（如新增冒烟脚本）才 commit。否则直接进入 Task 6。

---

## Task 6: 文档验证命令更新

**Files:**
- Modify: `docs/2026-09-01-mcp-tenant-resolution-design.md`（验证章节 `PGDATABASE=plm_test` → `crm_native_test`）
- Modify: `docs/2026-09-01-crm-standalone-database-design.md`（§6 已更新，确认一致；若有遗留 `plm_test` 一并改）

- [ ] **Step 1: 两份设计文档验证命令 plm_test → crm_native_test**

在 `docs/2026-09-01-mcp-tenant-resolution-design.md` 的「验证」章节，将 `PGDATABASE=plm_test npx vitest run ...` 改为 `PGDATABASE=crm_native_test ...`（共 3 处：multi-tenant / mcp-tenant / verify-t6 引用）。`docs/2026-09-01-crm-standalone-database-design.md` 的 §6 已在设计中更新，grep 确认无 `plm_test` 残留。

- [ ] **Step 2: 验收**

Run:
```powershell
rg -n "plm_test" docs/2026-09-01-mcp-tenant-resolution-design.md docs/2026-09-01-crm-standalone-database-design.md
```
Expected: 无匹配（或仅历史说明性提及）。

- [ ] **Step 3: Commit**

```bash
git add docs/2026-09-01-mcp-tenant-resolution-design.md docs/2026-09-01-crm-standalone-database-design.md
git commit -m "docs: 验证命令 plm_test→crm_native_test 与设计文档对齐"
```

---

## Self-Review

**1. Spec coverage：**
- 建库 + AGE 扩展 → 前置 T1（superuser 手动，命令齐全）✓
- 补 crm_users 用户种子缺口 → Task 1（烘焙列）+ Task 2（seed-users.sql）✓
- Repoint 连接配置 → Task 3（db.js/vitest/package）+ Task 4（脚本硬编码）✓
- 不删 plm.crm → Task 5 Step 5 验收 + 铁律声明 ✓
- 测试全绿 → Task 5 Step 2 ✓

**2. Placeholder scan：** 无 TBD/TODO；每步含确切代码/命令与 Expected。

**3. Type consistency：** `crm_users` 插入仅用基表列（username/password_hash/role/display_name/org_id），`enabled`/`tenant_id` 由 schema.sql 默认值填充（Task 1 烘焙），与 `src/http/auth.js:36` / `src/mcp/auth.js:119` 读取列一致 ✓。库名 `crm_native` / `crm_native_test` 全计划统一 ✓。

**4. 已知依赖：** `migrate-config.sql` / `migrate-tenant.js` 必须跑（不止 crm_users，还含 config_store / mcp_identity / decision 租户列 + §6 软迁移）；Task 5 Step 1 已纳入。
