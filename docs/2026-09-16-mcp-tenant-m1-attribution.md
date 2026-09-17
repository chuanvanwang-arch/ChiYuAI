# mcp-tenant M1 超时归因（2026-09-16）

> 任务归属：Plan A · Task 11（`docs/superpowers/plans/2026-09-16-signal-calendar-ics-and-date-rules.md`）
> 纪律红线：不得以「放宽超时阈值」作为通过手段；不得用 `it.skip` 当修复。
> 结论性质：**环境性 + 可复现**（非生产代码缺陷、非阈值问题），已据实取证。

## 现象

- 单跑 `npx vitest run test/mcp-tenant.test.js`：
  - **M1** 登录 alice(system) 后 `mcp_identity.tenant_id` 落库 = system → **超时 15028ms**（阈值 15s）
  - **M4** 老 token 软迁移：migrateTenant 幂等 → **超时 5005ms**（阈值 5s）
  - M2（acme 租户登录）/ M3（显式 tenantId 优先）→ 通过（135ms / 65ms）
- 历史：`1e8bb9a` 曾把 M1 阈值放宽到 15s，问题未解 → 证明**不是阈值问题**（与本次结论一致）。

## 分层读数（实测，非猜测）

| 探针 | 耗时 | 结论 |
|---|---|---|
| DB 基础查询（crm_users / tenants / bcrypt 成本 / 登录同谓词） | 总计 **131ms**（各步 <100ms，bcrypt 77ms） | DB 层**无阻塞** |
| 裸 node `mcpLogin(alice)` | **124ms** | 函数本身快 |
| 裸 node `migrateTenant()` | **77ms** | 函数本身快 |
| vitest 独立探针文件：写池首次 query / 读池首次 query / `mcpLogin` 内调 | 51ms / 21ms / **38ms** | vitest 环境下函数也快 |
| **`crm.mcp_identity` 测试库行数**（`crm_native_test`） | **3867 → 3868 行**（每次登录 +1） | ⚠ 无清理机制累积 |
| **M1 原查询** `WHERE token_hash = crypt($1, token_hash)` 全表逐行 bcrypt 比对 | **17996ms → 26809ms**（行数增长后更慢） | 🔴 **阻塞点** |
| M1 加 `actor='alice'` 限定（走 actor 索引） | **1898ms** | 仍慢——alice 自身也累积数百行，治标不治本 |

## 阻塞点

**一句话**：`test/mcp-tenant.test.js:12` 的 `SELECT tenant_id FROM crm.mcp_identity WHERE token_hash = crypt($1, token_hash)` 对 `crm.mcp_identity` **全表逐行 bcrypt 比对**；该表在测试库 `crm_native_test` 累积 **3867+ 行**（每次 `mcpLogin` 颁发新 token + 软吊销仅置 `revoked_at`、不删行 → 只增不减）→ O(N) 慢哈希超阈值。

- M1 超时机制：`crypt($1, token_hash)` 无法走索引（对**每一行**用已存哈希作 salt 重算比对），N=3867 时单查询 ~18–26s。
- M4 超时机制同源：`migrateTenant()` 内 `UPDATE ... WHERE tenant_id IS NULL` + `SELECT count(*) ... WHERE tenant_id IS NULL` 对全表扫描/更新，3867 行下超 5s 阈值（`tenant_id` 为 `NOT NULL DEFAULT 'system'`，实际 0 行命中但仍全表扫）。
- M2/M3 只走 `query`（读池，无全表 crypt 比对）→ 不触发 → 通过。

## 处置

**判定：环境性（测试库卫生 + 测试查询未走主键），非生产缺陷。**

本批**不修代码**（遵守纪律：不以放宽阈值了结；不清 TRUNCATE 共享表引入并发伪失败）。附复现命令与失败读数如下。

**复现命令**：
```bash
cd D:/system/CRM-ai-native
npx vitest run test/mcp-tenant.test.js --reporter=verbose 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | tail -40
# 失败读数：M1 Test timed out in 15000ms / M4 Test timed out in 5000ms
```

**根因实证命令**（定位用，已执行）：
```bash
PGDATABASE=crm_native_test node -e "import('./src/db.js').then(({pool})=>pool.query('SELECT count(*)::int n FROM crm.mcp_identity')).then(r=>{console.log('rows',r.rows[0].n);process.exit(0)})"
# → 3867 行
```

**修复建议（不在本批，供后续会话/用户拍板）**：
1. **测试卫生（环境性根治）**：给 `mcp-tenant.test.js` 加 `beforeAll` 清理 `crm.mcp_identity` 本文件用到的 actor 行（或 `DELETE` 全表——注意 `fileParallelism:false` 但多 mcp 文件仍经 threads 并发，清理需评估与其他 mcp 测试隔离）；清后 M1 全表比对行数≈0 → 快。
2. **主键回查（O(1) 根治，推荐）**：`mcpLogin` 透传 `issueMcpIdentity` 已返回的 `id`（identity_id），M1 改 `WHERE id=$1` 走主键索引，彻底消除全表 crypt 比对。属合理生产改动（identity_id 已存在于返回结构）。
3. **migrateTenant 性能**：评估 `UPDATE ... WHERE tenant_id IS NULL` 在大数据量下的全表扫描，必要时加 `tenant_id` 部分索引或限批（生产迁移兜底路径，非热路径，优先级低）。

## 反假绿声明

- 未以「放宽超时阈值」作为通过手段（M1 阈值 15s 是 `1e8bb9a` 遗留，本次不进一步放宽）。
- 未把 `it.skip` 当作修复。
- 根因以「测试库行数 3867 + 全表 crypt 比对实测 17.9–26.8s」实证，非猜测；加 `actor` 限定实测 1898ms 仍慢，已排除「单纯缺索引」误判。
