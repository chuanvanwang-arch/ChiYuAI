# 参数传播中枢 — 实现核对与自检报告（Task 0–12）

> 核对日期：2026-09-05 | 分支：`feat-multi-industry-meta-model` | 基线 HEAD：`ecb5710`
> 核对方法：evidence-driven（代码锚点 + 数据库实际状态 + 真实测试执行三重交叉，不接受"声称已实现"）

---

## §0 结论摘要

| 维度 | 结论 |
|---|---|
| 功能实现 | **四大模块 18 项功能点全部落地**，代码锚点已逐项核实，无"文档写了代码没写"项 |
| 数据库迁移 | **5 项自检全绿**（2 新列 + 1 JSONB 列 + 14 类 CHECK + 1 索引） |
| 测试执行 | 聚焦批次 **80 文件 / 491 用例，484 绿 7 红** |
| 7 例失败甄别 | **4 例存量**（与本线改动零导入交集）+ **3 例 flaky**（隔离复跑 6/6 全绿） |
| 待提交 | Task 11/12 共 11 个文件未入库（Task 10 已由 3 个 commit 入库） |

**判定：实现完整、无本线引入回归。** 7 例失败均非本次改动所致，详见 §3.2。

---

## §1 核对范围与证据标准

### 1.1 核对对象

| 模块 | 覆盖 Task | 来源 |
|---|---|---|
| A. 参数传播中枢基础 | Task 0–9（前会话，已入库） | `docs/2026-09-04-param-propagation-hub-design.md` §3/§5/§12 |
| B. 权限重分组与 RBAC 闸 | Task 10 | 设计 §15 |
| C. 整改报告结构化 | Task 11 | 设计 §16.2 |
| D. ADMIN 待办闭环 | Task 12 | 设计 §16.3/§16.4/§16.6 |

### 1.2 三重证据标准

一项功能判定"已实现"须同时满足：

1. **代码锚点**：`file:line` 可定位到真实实现语句（grep 实证）
2. **数据库态**（涉表改动）：`information_schema` / `pg_constraint` 实测存在
3. **测试覆盖**：有对应断言且本轮执行通过

---

## §2 功能实现核对矩阵

### A. 参数传播中枢基础（Task 0–9）

| # | 功能点 | 实现锚点 | 自检证据 | 状态 |
|---|---|---|---|---|
| A1 | 配置三层读写（platform/tenant/task） | `src/config/configStore.js:10` `readConfig`、`:26` `writeConfig` | 全链路消费方 30 项配置键 | ✅ |
| A2 | 强制下发 broadcast | `src/http/propagationRoutes.js:188` `POST /api/config/broadcast` | `broadcast.test.js` 4 用例绿 | ✅ |
| A3 | 上行推广 promote（skill-scope 轴） | `src/http/decisionReadRoutes.js:388-391` | `skill-promote.test.js` 3 用例绿 | ✅ |
| A4 | 上行推广（记忆轴） | `src/memory/promote.js:6` `promoteMemoryToTenant`；路由 `:98` 调用 | `promote-memory.test.js` 3 用例绿 | ✅ |
| A5 | 决策第 0 闸 | `propagationRoutes.js:78/91/173/194`（4 处 `requireDecision`） | `routes.test.js` 断言调用次数 | ✅ |
| A6 | HITL 人工确认 | `propagationRoutes.js:113` `gateAccept`（未登录→401） | `permission.test.js` 16 用例绿 | ✅ |
| A7 | 处方定量引擎 | `src/decision/prescription.js:16` `prescribe`、`:60` `findKnobSpec` | `prescription.test.js` 绿 | ✅ |
| A8 | 禁 DELETE 铁律 | 全量 grep `DELETE FROM` → **空**（`propagationRoutes.js`/`store.js`/`knobs/*`） | `no-delete.test.js` 1 用例绿 | ✅ |
| A9 | 参数穿透五层落位分析 | 设计 §11.2 逐参数穿透表（17 配置键 × 落层 A–E × file:line） | 文档产物，非代码 | ✅ |
| A10 | 端到端集成 | `test/propagation/integration.test.js` 2 用例 | 绿 | ✅ |

### B. 权限重分组（Task 10，已入库：8004e53 / 9471ffd / 473ed06）

| # | 功能点 | 实现锚点 | 自检证据 | 状态 |
|---|---|---|---|---|
| B1 | 角色别名归一（fail-closed） | `src/http/middleware/rbac.js:22` `normalizeRole` | 别名表含 `ten_admin`（缺陷 #12 修复） | ✅ |
| B2 | 系统级闸（仅 ADMIN） | `rbac.js:27` `hasRole` + `:41` `SYSTEM_LEVEL_ROLES` | `permission.test.js` 系统级矩阵 | ✅ |
| B3 | 租户级闸（三角色） | `rbac.js:33` `hasAnyRole` + `:42` `TENANT_LEVEL_ROLES` | tan_admin 限本租户断言 | ✅ |
| B4 | 注册表闸（单一事实源） | `rbac.js:76` `createConfigLevelGate`；挂点 `routes.js` 首行 | 覆盖 30 项带端点配置面 | ✅ |
| B5 | 配置中心两级分组 | `src/portal/configCenter.js` 30 项全标 `level` + `LEVEL_GROUPS` | **实测 30 = system 16 + tenant 14，缺 level 项 = 0** | ✅ |
| B6 | 前端双 Tab | `src/web/config.html:94-98` `LEVEL_TABS`、`:62-63` 客户端别名闸 | `configCenter.test.js` 绿 | ✅ |
| B7 | 上下贯通强制 ADMIN | `decisionReadRoutes.js:388`（`to==='system'` → 403） | `permission.test.js` | ✅ |
| B8 | LLM 配置收紧 | `src/http/llmConfigRouter.js`（`hasRole(me,'ADMIN')`） | `configRouter.test.js` 绿 | ✅ |

### C. 整改报告结构化（Task 11，未提交）

| # | 功能点 | 实现锚点 | 自检证据 | 状态 |
|---|---|---|---|---|
| C1 | 迁移：rectification 列 | `db/migrate-propagation-rectification.js`；挂入 `db/migrate.js` `PROPAGATION_MIGRATIONS` | **实测：`jsonb` / `NOT NULL` / default `'{}'::jsonb`** | ✅ |
| C2 | 本日任务执行（三源聚合） | `src/decision/dailyOps.js:28` `summarizeDailyOps`（decision/tasks/agent_sla） | `rectification.test.js` 7 用例绿 | ✅ |
| C3 | 结论判定纯函数 | `dailyOps.js:12` `buildVerdict` | 单测绿 | ✅ |
| C4 | 三段落组装 + 落库 | `src/decision/retro.js:321/324/325`（组装）、`:355/358`（INSERT 第 9 列） | dryRun 契约（仅 2 次查询）未破坏 | ✅ |

**计划缺陷修正（evidence-driven）**：#5 无 `autonomy` 列→改用 `decider_type` 口径；#6 `tasks.status` 无 `timeout`→由 `blocked` 承载；#7 draftPatches 无 `prescription` 子对象→按实际字段映射。

### D. ADMIN 待办闭环（Task 12，未提交）

| # | 功能点 | 实现锚点 | 自检证据 | 状态 |
|---|---|---|---|---|
| D1 | 迁移：assignee + tenant_id 列 | `db/migrate-propagation-todo.js` | **实测：`assignee text default 'ADMIN'`、`tenant_id text default 'system'`** | ✅ |
| D2 | knob CHECK 扩至 14 类 | `db/migrate-propagation-todo.js` + `db/schema.sql` 同步 | **实测 CHECK 含 `config_store`，既有 13 类未收窄** | ✅ |
| D3 | 待办索引 | 同上 | **实测 `idx_calibration_patch_todo` 存在** | ✅ |
| D4 | ConfigStoreStrategy | `src/calibration/knobs/configStoreStrategy.js:16` class、`:25` `apply`（事务 client 写） | 注册于 `knobs/index.js` REGISTRY | ✅ |
| D5 | KNOBS 扩列 | `src/calibration/store.js` KNOBS 14 类 | `knobs-extended.test.js` 同步 13→14，112/112 绿 | ✅ |
| D6 | retro 末段推待办 | `src/decision/retro.js:327-335`（`savePatches` + `todo-created` SSE，仅 created=1 时 emit） | `todo-loop.test.js` 9 用例绿 | ✅ |
| D7 | 待办 API | `src/http/calibrationRouter.js:282` `GET /api/admin/todos`；`:259` 三角色闸、`:268` tan_admin 限本租户 | `todo-loop.test.js` | ✅ |

**计划缺陷修正**：#8 CHECK 须追加而非收窄；#9 apply 必须走事务 client（计划 `writeConfig` 是池级连接，破坏原子性）；#10 须补 `tenant_id` 列；#11 retroDecisionId 未定义→批准时由 `approvePatch.produce` 产生；#12 别名缺 `ten_admin`。

---

## §3 自检执行结果（本轮真实数据）

### 3.1 执行命令与结果

```powershell
$env:PGDATABASE = "crm_native_test"
node node_modules/vitest/vitest.mjs run test/propagation test/decision test/calibration test/http/configRouter.test.js test/web/configCenter.test.js
```

| 指标 | 数值 |
|---|---|
| 测试文件 | 80（75 绿 / 5 红） |
| 测试用例 | **491（484 绿 / 7 红）** |
| 耗时 | 125s |

### 3.2 7 例失败甄别

| 文件 | 用例数 | 根因 | 与本线关系 | 判定 |
|---|---|---|---|---|
| `test/decision/stopLossMirror.test.js` | 2 | 测试硬编码 `127.0.0.1:5433` → ECONNREFUSED（PG 仅监听 IPv6 `[::1]`，项目已知坑） | 导入面无交集 | **存量** |
| `test/decision/closed-loop-demo.test.js` | 2 | `scripts/seed-closed-loop-demo.mjs` 的 `ON CONFLICT` 无匹配唯一约束（测试库 schema 漂移） | 仅依赖 `db.js` + `closure.js`，不触碰 retro/store/knobs | **存量** |
| `test/decision/decision-outcome.test.js` | 1 | 批量运行时共享 DB 竞争 | 隔离复跑 **6/6 全绿** | **flaky** |
| `test/decision/pre-assembly-order.test.js` | 2 | 同上 | 隔离复跑 **6/6 全绿** | **flaky** |

**隔离复跑证据**：

```
run test/decision/decision-outcome.test.js test/decision/pre-assembly-order.test.js
→ Test Files 2 passed (2) | Tests 6 passed (6)
```

按项目铁律「PG 不稳时单次红不得直判」，后 3 例判定为批量并发 flaky，非回归。

### 3.3 数据库自检（实测输出）

```
[1] rectification列: [{"column_name":"rectification","data_type":"jsonb","column_default":"'{}'::jsonb","is_nullable":"NO"}]
[2] calibration_patch新列: [{"assignee","text","'ADMIN'::text"},{"tenant_id","text","'system'::text"}]
[3] knobCHECK: CHECK ((knob = ANY (ARRAY['threshold',...,'precedent_distill','config_store'])))
[4] config_store是否在CHECK: true
[5] todos索引: [{"indexname":"idx_calibration_patch_todo"}]
```

### 3.4 配置分组实测

```
CONFIG_ITEMS 总数: 30 | system: 16 | tenant: 14 | 未标注: 0 | LEVEL_GROUPS: ["system","tenant"]
```

---

## §4 测试路径与方法

### 4.1 环境前置（PowerShell，务必遵守）

```powershell
$env:PGDATABASE = "crm_native_test"
$env:PGHOST = "localhost"          # 禁 127.0.0.1：PG 仅监听 IPv6 [::1]:5433
$NODE = "C:/Users/wangchuan08/.workbuddy/binaries/node/versions/22.22.2-2/node.exe"
```

> **坑位警示**：`stopLossMirror.test.js` 的 2 例存量失败即因硬编码 `127.0.0.1` 触发 ECONNREFUSED。任何自写探测/脚本都不得硬编码该地址。

### 4.2 分层测试路径（由窄到宽）

| 层级 | 命令 | 覆盖 | 适用时机 |
|---|---|---|---|
| L1 单用例 | `& $NODE node_modules/vitest/vitest.mjs run test/calibration/todo-loop.test.js -t "关键词"` | 单断言 | 定位具体失败 |
| L2 单文件 | `& $NODE node_modules/vitest/vitest.mjs run test/decision/rectification.test.js` | 7 用例 | 改单模块后 |
| L3 功能目录 | `& $NODE node_modules/vitest/vitest.mjs run test/propagation` | 9 文件 35 用例 | 改传播中枢后 |
| L4 聚焦批次 | `... run test/propagation test/decision test/calibration` | 464+ 用例 | **本线标准回归批次** |
| L5 全量 | `& $NODE node_modules/vitest/vitest.mjs run` | ~2600 用例 | 发布前 |

### 4.3 本线测试资产地图

| 测试文件 | 用例数 | 守护契约 |
|---|---|---|
| `test/propagation/permission.test.js` | 16 | §15 权限矩阵、注册表闸、gateAccept 目标层级 |
| `test/propagation/broadcast.test.js` | 4 | 强制下发 + 第 0 闸 |
| `test/propagation/skill-promote.test.js` | 3 | 上行推广 + 上下贯通 ADMIN 闸 |
| `test/propagation/promote-memory.test.js` | 3 | 记忆轴推广 |
| `test/propagation/no-delete.test.js` | 1 | **禁 DELETE 铁律** |
| `test/propagation/routes.test.js` | 2 | 端点 + 第 0 闸调用次数 |
| `test/propagation/measure-metrics.test.js` | 3 | 五槽位聚类度量 |
| `test/propagation/retro-knob.test.js` | 1 | 旋钮映射 |
| `test/propagation/integration.test.js` | 2 | 端到端 |
| `test/decision/rectification.test.js` | 7 | **Task 11**：三源聚合 / 数值换算 / buildVerdict / 三段落 / dryRun 契约 |
| `test/calibration/todo-loop.test.js` | 9 | **Task 12**：待办推送 / 角色闸 / 租户隔离 / 批准即生效 |
| `test/calibration/knobs-extended.test.js` | — | KNOBS 14 类全注册 |
| `test/web/configCenter.test.js` | — | 配置中心两级分组渲染契约 |
| `test/http/configRouter.test.js` | — | 配置路由角色闸文案 |

### 4.4 数据库自检路径

```powershell
# 一次性跑通 §3.3 的 5 项校验（列 / 约束 / 索引）
& $NODE -e "import('pg').then(async ({default:pg})=>{ ... })"
```

必查 5 项：`decision_retro_report.rectification`、`calibration_patch.assignee`、`calibration_patch.tenant_id`、`calibration_patch_knob_check` 含 `config_store`、`idx_calibration_patch_todo`。

### 4.5 迁移执行路径

```powershell
# 单迁移（幂等，可重复执行）
& $NODE db/migrate-propagation-rectification.js
& $NODE db/migrate-propagation-todo.js

# 全量（含新迁移，已挂入 db/migrate.js 的 PROPAGATION_MIGRATIONS）
& $NODE db/migrate.js

# 语法自检
& $NODE --check db/migrate.js
```

> 铁律：迁移必须挂入 `db/migrate.js` 清单 + 同步 `db/schema.sql`，否则 fresh install 会缺列（历史教训：`migration-decision-display-name.sql` 未入清单）。

### 4.6 手工端到端验证（尚未执行，推荐发布前跑）

| 步骤 | 动作 | 期望 |
|---|---|---|
| 1 | 启动服务 `localhost:3000` | 正常监听 |
| 2 | 触发一次复盘（非 dryRun，播种 ≥20 条决策跨过 `MIN_SAMPLE`） | `decision_retro_report` 新增一行，`rectification` 三段落非空 |
| 3 | `GET /api/admin/todos?status=PENDING` | 返回 config_store 类待办 |
| 4 | 以 `tan_admin` 登录重取 | 仅见本租户待办 |
| 5 | 调 `approvePatch` 批准 | `config_store` 值即时变更 + `status='APPLIED'`（原子） |
| 6 | 回退验证 `rollbackPatch` | 值还原 + `status='ROLLED_BACK'` |

> 注意：mock 测试无法覆盖真实 PG 连接、索引命中、并发与 LLM 超时。§4.6 是发布前唯一能暴露这些盲点的路径。

---

## §5 未覆盖与遗留风险

| # | 风险 | 等级 | 说明 |
|---|---|---|---|
| R1 | 夜间复盘未真实跑过 | **P1** | Task 11/12 均 mock 验证，真实 PG + LLM 链路未端到端验证（见 §4.6） |
| R2 | 4 例存量失败未修 | P2 | 与本线无交集，需单独排期 |
| R3 | 批量并发 flaky | P2 | 共享 DB 竞争；建议引入 `test/...` 隔离前缀或串行执行 |
| R4 | `closed-loop-demo` seed 缺唯一约束 | P2 | 测试库 schema 与迁移漂移，需补约束或改 seed |

---

## §6 提交建议（按功能线拆分，禁 `git add -A`）

```powershell
# Task 11 整改报告结构化
git add db/migrate.js db/migrate-propagation-rectification.js src/decision/dailyOps.js src/decision/retro.js test/decision/rectification.test.js
git commit -m "feat(retro): 整改报告结构化（rectification 三段落 + summarizeDailyOps 三源聚合）"

# Task 12 ADMIN 待办闭环
git add db/migrate.js db/migrate-propagation-todo.js db/schema.sql src/calibration/store.js src/calibration/knobs/configStoreStrategy.js src/calibration/knobs/index.js src/decision/retro.js src/http/calibrationRouter.js src/http/middleware/rbac.js test/calibration/todo-loop.test.js test/calibration/knobs-extended.test.js
git commit -m "feat(propagation): ADMIN 待办闭环（retro→calibration_patch 推送→批准即生效 config_store）"
```

> 注意：两笔 commit 均含 `db/migrate.js`、`src/decision/retro.js`，须按顺序提交（先 11 后 12），避免同一文件跨 commit 拆分冲突。

---

## §7 真实端到端预演结果（2026-09-05 执行，补录）

> 目的：兑现 §5-R1 的承诺——mock 单测无法覆盖真实 PG 连接、索引命中、并发与 LLM 超时。
> 载体：`scripts/e2e-retro-todo.mjs`（可复用，发布前回归入口）。

### 7.1 六步执行结果：**全绿**

| 步骤 | 实测结果 |
|---|---|
| Step 1 播种 | 24 条决策（场景 `OPP_QUALIFY`，20 自主 + 4 升级，avg_confidence 0.55），跨过 `MIN_SAMPLE=20` |
| Step 2 真实跑批 | `report_id` 落库成功；`scanned=25`、`clusters=2`；`rectification` 三段落齐备，DB 回读非空 |
| Step 3 mock 补跑 | 产出 1 条 `config_store` 处方（`precedent-conf.minSimilarity` 0.45→0.4） |
| Step 4 待办生成 | `calibration_patch` 出现 PENDING 待办，`assignee=ADMIN`、`tenant_id=system` 均落库 |
| Step 5 批准即生效 | `approvePatch` → `status=APPLIED`，`config_store` 即时变为 `minSimilarity=0.4`，写入 `decision_id`（第0闸） |
| Step 6 回退 | `rollbackPatch` → `status=ROLLED_BACK`，值回写 `0.45`（写回 `from_value` 而非删键，符合禁 DELETE 铁律） |

**Task 11/12 真实链路验证通过**：daily_ops 三源聚合数值与播种构成完全吻合（total 24 / autonomous 20 / escalated 4 / avg_confidence 0.55），证明缺陷 #5（`decider_type` 口径修正）在真实 SQL 下正确。

### 7.2 预演暴露的 4 个真实问题（mock 测试全部掩盖）

| # | 问题 | 严重度 | 处置 |
|---|---|---|---|
| **N1** | **共享测试库被并发重置**：播种的 24 条 `OPP_QUALIFY` 在 1 分钟后被其他会话冲掉，库内换成 31 条异源数据。E2E 在共享库上不具备可重复性 | **P1** | 需独立 E2E 库。已尝试 `CREATE DATABASE ... TEMPLATE crm_native_test` → 被拒（55006 源库有活跃连接），强行断连会打断其他会话，**未执行**。建议低峰期建 `crm_native_e2e` |
| **N2** | **fresh install 缺陷①（已修）**：`crm.meta_attr` 的 `PRIMARY KEY(particle_type, attr_slug, tenant_id)` 引用了 CREATE 段未定义的 `tenant_id`（该列靠文件后段 ALTER 补）。schema.sql 单事务执行 → 新库从零迁移必失败（42703），**整文件回滚、crm schema 表数=0** | **P0** | 已在 CREATE 段补齐 `tenant_id TEXT NOT NULL DEFAULT 'system'`；后段 `ADD COLUMN IF NOT EXISTS` 保留供旧库幂等。**已修并验证：错误推进到下一处（证明修复生效）** |
| **N3** | **fresh install 缺陷②（未修，非本线）**：修复 N2 后暴露 `relation "crm.billing_payment" does not exist`（42P01）——billing 线迁移未同步进 `schema.sql` | **P0** | **超出参数传播中枢范围**，须由 billing 线补齐。在此之前**新库无法从零初始化** |
| **N4** | **真实 LLM 不可用**：跑批 `llm_enabled=false, llm_effective=0` → 全部簇走 `heuristicAnalyze` 降级（confidence 0.3），**`drafts=0`、`prescriptions=[]`、待办永不生成** | **P1（运维红线）** | 生产部署前必须确认 `crm.llm_config` 已配置且可达；否则"每晚复盘出整改报告+推待办"只会产出空壳报告 |

### 7.3 附带发现（实现脆弱性，非阻塞）

`src/decision/retro.js:274` 的 `llmFactory` 注入契约要求**返回 Promise**（`getLlm(...).catch(...)`）；若注入同步函数直接抛 `TypeError: getLlm(...).catch is not a function`。生产路径不受影响（`getLlmJson` 本就返回 Promise），但建议加固为 `Promise.resolve(getLlm(...)).catch(...)` 以兼容两种形态。**未改动**（属实现调整，待您批准）。

### 7.4 复跑方式

```powershell
$env:PGDATABASE="crm_native_test"; $env:PGHOST="localhost"
node scripts/e2e-retro-todo.mjs                 # 完整六步
node scripts/e2e-retro-todo.mjs --seed-only     # 只播种
node scripts/e2e-retro-todo.mjs --skip-approve  # 跳过批准/回退
```

脚本幂等（按 `rationale` 前缀探测已播种数据），仅 INSERT、绝不 DELETE。

---

## §8 待裁决：配置分组「二分 vs 三分」契约冲突（需您拍板）

### 8.1 冲突事实

| 方 | 契约 | 载体 |
|---|---|---|
| 本线（Task 10，§15） | `level` 只取 `system` / `tenant` **二分**；注册表闸 `createConfigLevelGate` 对非 `system` 一律按租户级三角色放行 | `test/propagation/permission.test.js:88-93`「系统级/租户级 二分完备」 |
| 并发会话（2026-09-05 08:54 新增 id42） | 存在**第三个一级分组** `propagation`（传播中枢），UI 渲染 `data-level="propagation"` | `test/web/configCenter.test.js`「渲染第三个一级分组…（data-level=propagation）」 |

**两项断言互斥**：满足二分则第三组消失（对方 2 例红）；保留第三组则二分断言红（本线 1 例红）。当前状态为后者（我已把 id42 回滚为 `propagation`，对方恢复绿，本线 1 例红）。

### 8.2 风险（若维持现状不裁决）

`level='propagation'` 在 `createConfigLevelGate` 中走 `else` 分支 → **传播中枢配置页/端点按「租户级三角色」放行**，即 sysadmin 可入。而 §15.5 规定「上下贯通（broadcast / tenant→system 推广）强制 ADMIN」——**实际权限比设计宽松**，属静默降级的安全口径偏差。

### 8.3 三个方案（建议方案 1）

| 方案 | 做法 | 影响 | 评价 |
|---|---|---|---|
| **1（推荐）** | 保留三分组 UI；闸门层加 `LEVEL_ROLE_MAP`，把 `propagation` 显式映射为 **system 权限（仅 ADMIN）**；本线断言改三分 | 改 `rbac.js` 闸门 + `permission.test.js` 断言各 1 处；对方测试不受影响 | UI 与权限解耦，两边全绿，符合 §15.5 |
| 2 | 合并进 `system` 组（我一度改为此值，已回滚） | 须删改对方 `configCenter.test.js` 2 条断言 | 破坏并发会话的 UI 设计，**不推荐** |
| 3 | 为 propagation 定义独立第三类角色策略 | 改动最大，需设计文档支撑 | 过度设计 |

### 8.4 裁决结果（2026-09-05 补录）：**已按方案 1 落地**

| 项 | 内容 |
|---|---|
| 实施 | `src/http/middleware/rbac.js` 新增 `LEVEL_ROLE_MAP`（`system`/`tenant`/`propagation` → 角色策略），`createConfigLevelGate` 改为查表 |
| propagation 权限 | 显式映射为 `['ADMIN']`（UI 仍为独立第三 TAB，权限等同系统级） |
| 未知 level | **fail-closed 403**（原为静默按租户级放行），错误信息提示需先登记 |
| 测试 | `permission.test.js` 断言同步三分 + 新增 `LEVEL_ROLE_MAP.propagation.roles === ['ADMIN']` |
| 结果 | `test/propagation + test/web/configCenter` **10 文件 57 用例全绿**；`test/web + test/http` 747 例中 9 例红经甄别全部属于并发会话的 UI/菜单线（`page-tab-calibration` 缺 id、"报告"菜单归属变更等），与本线**无导入交集** |

> 注：并发会话曾把 `permission.test.js:88` 自行改为三分，并在注释中描述「API 层走租户级三角色闸、TAB 可见性仅 ADMIN 由前端控制」。本次裁决将 API 层收紧为 ADMIN-only（纵深防御：前端隐藏可被直接调 API 绕过），注释已同步更正。

---

## §9 新库（fresh-install）初始化缺陷：N2 / N3 / N5（2026-09-05 修复）

### 9.0 背景与验证方法

前序核对只覆盖了**既有库**（`crm_native_test`，长期由增量迁移叠加而成），无法暴露"从零建库"的缺口。本节改用**空库重建法**验证：

```powershell
# 1) 重建空库（host 必须 localhost）
node -e "...DROP DATABASE IF EXISTS crm_native_e2e; CREATE DATABASE crm_native_e2e"
# 2) 跑真实初始化链路 db/migrate.js
$env:PGDATABASE="crm_native_e2e"; $env:PGHOST="localhost"; node db/migrate.js
# 3) 校验对象落库情况
```

### 9.1 初始化链路事实（修正前序推断）

新库初始化**不是**只跑 `db/schema.sql`，链路为（`db/migrate.js`）：

`schema.sql`（整文件单事务）→ `migrate-config.sql` → `INCREMENTAL_SQL` 20 项 → `migrate-tenant.js` → 传播中枢 4 个 js → 内联兼容 ALTER。

因此 `tenants` / `config_store` / `approval_flow` / `connectors` / `system_config` / `alert_rule` / `assertions` / `routing_experiment` 8 张表虽不在 schema.sql 中，**但由链路后续步骤创建，不构成缺口**（前序扫描结论在此更正，避免误判）。

### 9.2 缺陷清单与修复

| 编号 | 严重度 | 现象 | 根因 | 修复 | 状态 |
|---|---|---|---|---|---|
| **N2** | P0 | 空库执行 schema.sql 报 `42703 column "tenant_id" does not exist`，整文件单事务回滚（crm 表数=0） | `crm.meta_attr` 的 PK 引用 `tenant_id`，但 CREATE 段未定义该列 | `db/schema.sql` 的 `meta_attr` CREATE 段补 `tenant_id TEXT NOT NULL DEFAULT 'system'` | ✅ 已修并验证 |
| **N3** | P0 | 修复 N2 后报 `42P01 relation "crm.billing_payment" does not exist` | `tenant_subscription.payment_ref` 外键引用 `crm.billing_payment`，而 billing 两表只在 `db/migration-billing-tables.sql`，未并入单一事实源 | 在 `tenant_subscription` 之前**前置并入** `billing_statement` + `billing_payment` 及 2 个索引（保留 `IF NOT EXISTS` 幂等） | ✅ 已修并验证 |
| **N5** | P0 | 空库 migrate 日志出现 `migrate-propagation.js 跳过（42P01 目标不存在，幂等容忍）`，**静默跳过** | **执行顺序缺陷**：`migrate-propagation.js` 内 `ALTER TABLE crm.skill_scope ADD COLUMN tenant_id`，而 `skill_scope` 在 migrate.js 后段（P3-D2，原 L296-312）才创建；旧库因表已存在故长期不报错 | 将 `PROPAGATION_MIGRATIONS` 块**移至 skill_scope 建表与种子之后**；并把 42P01 静默跳过升级为 `console.warn` 显式告警 | ✅ 已修并验证 |

### 9.3 N5 影响面（修复前实测，空库）

失败点精确落在 `ALTER TABLE crm.skill_scope`（`db/migrate-propagation.js:30`），其后的语句全部未执行：

| 传播中枢对象 | 修复前 | 修复后 | 说明 |
|---|---|---|---|
| `memory_log.tenant_id` | ✅ | ✅ | 在失败点之前 |
| `crm.tenant_precedent` 表 | ✅ | ✅ | 在失败点之前 |
| `skill_scope.tenant_id` | ❌ **缺** | ✅ | **失败点** |
| `crm.propagation_action` 表 | ❌ **缺** | ✅ | 抛出后中断未执行 |

后果：全新库部署时，传播中枢 accept/reject **留痕无法落库**（`propagation_action` 缺失 → 42P01 运行时报错），租户轴 skill 推广不可用。旧库因表已存在而始终正常——**这是典型的"只在旧库验证"盲区**。

### 9.4 修复后验证（三重证据）

| 验证项 | 命令/方式 | 结果 |
|---|---|---|
| 空库 schema.sql 整文件 | `crm_native_e2e` 从零执行 | ✅ 成功，crm 表 **43** |
| 空库完整 migrate 链路 | `PGDATABASE=crm_native_e2e node db/migrate.js` | ✅ 全部步骤「就绪」，**零跳过、零失败** |
| 对象落库 | information_schema 查询 | ✅ 4 表 + 3 列齐全，crm 表 **56**（修复前 55） |
| 既有库幂等 | `PGDATABASE=crm_native_test node db/migrate.js` | ✅ 57 表不变、`decision` 30 行完好、零跳过 |
| 本线回归 | vitest 16 文件 | ✅ **121/121 全绿** |

### 9.5 遗留与建议

1. **INCREMENTAL_SQL 的"幂等容忍"是双刃剑**（`db/migrate.js:50-51`）：对 `42P01/42703` 静默跳过，历史上掩盖了 N5。本次已为传播中枢块升级为 `console.warn`，其余 20 项仍静默——建议后续统一改为告警 + 汇总计数（属 migrate.js 公共改动，需您批准）。
2. **单一事实源仍未彻底**：schema.sql 与 20 个增量迁移文件并存，任何新增表若只写增量文件，空库链路仍可能出缺口。建议把"空库重建 + 全链路 migrate"纳入 CI 冒烟（当前靠手工执行）。
3. **N4（P1 运维红线，未处理）**：真实 LLM 不可用（`llm_enabled=false` → 全簇降级 → 整改待办永不生成），生产部署前必须确认 `crm.llm_config` 可达。

### 9.6 复跑方式

```powershell
# 空库全链路验证（需 PG 可 DROP/CREATE）
node -e "import('pg').then(async({default:pg})=>{const c=new pg.Client({host:'localhost',port:5433,user:'agent2b',password:'agent2b',database:'postgres'});await c.connect();await c.query('DROP DATABASE IF EXISTS crm_native_e2e');await c.query('CREATE DATABASE crm_native_e2e');await c.end();process.exit(0)})"
$env:PGDATABASE="crm_native_e2e"; $env:PGHOST="localhost"; node db/migrate.js
# 期望：输出中不得出现「跳过」或「⚠」
```

---

## §10 N4 真相追查与 N6（P0 测试污染生产配置，2026-09-05 已修）

### 10.1 N4 原判与复核

原判「生产 LLM 不可用（`llm_enabled=false` → 全簇降级 → 待办永不生成）」。复核**双库对照**后结论修正：

| 库 | llm_config 现状 | 判定 |
|---|---|---|
| **生产 `crm_native`** | 1 条：`siliconflow` / `deepseek-ai/DeepSeek-V4-Flash` / `api_key` 长度 **51**（前缀 `sk-`，非占位）/ `base_url=https://api.siliconflow.cn/v1` / `is_default=true` / `is_deleted=false` / `updated_by='migration'` | ✅ **健康，N4 解除** |
| **测试 `crm_native_test`** | 原 2 条 `updated_by='test'`、`updated_at=2026-09-05T00:57:44`，均 `is_deleted=true`，key 为 `sk-test`(7)/`sk-b`(4) 占位假值 | ❌ 被测试污染（见 N6） |

### 10.2 N6（P0）：`test/llm/llmConfigStore.test.js` 以 system 租户为沙箱并全量软删

| 行 | 代码 | 问题 |
|---|---|---|
| L8 | `const TID = 'system'` | 以**真实 system 租户**当测试沙箱 |
| L11 | `UPDATE crm.llm_config SET is_deleted=true WHERE tenant_id=$1` | 按租户**全量软删**，不区分真实配置与测试数据 |
| L14/15 | beforeAll + afterAll 各清一次 | 结束时 system 租户再无可用配置，**不回滚** |
| L19/26 | `api_key: 'sk-test'` / `'sk-b'` | 用假 key 覆盖，即便恢复也调不通 |

**危害分级**：
- 测试库：导致 N4 表象（LLM 恒降级、复盘全簇降级、整改待办永不生成）。
- **生产库：只要在生产的库上跑一次该测试，全平台 LLM 即静默降级且无任何告警**——这是最危险的形态（软删 + 静默）。

### 10.3 修复与验证

| 项 | 内容 |
|---|---|
| 修复 | `TID` 改为独立测试租户 `'test-llm-cfg'`，并加注释固化教训；clean() 只作用于该租户 |
| 验证 1 | `vitest run test/llm/llmConfigStore.test.js` → **5/5 全绿** |
| 验证 2 | 运行后库中仅新增 `test-llm-cfg` 两行且已由 afterAll 自行软删；system 租户行 `updated_at` 未变化 → **未被触碰** |
| 全量扫描 | `test/` 下「以 system 为清理沙箱」**仅此一例**；其余均用独立租户（`CHEM_TENANT`/`TRAINING_TENANT`/billing 的 `T`）。大量 `tenantId:'system'` 仅为传参上下文，非清理目标，属正常 |

### 10.4 遗留

1. **生产真实连通性未实测**：需发起外部 API 调用（消耗 token 且需外网），按零信任未擅自执行。建议上线前在生产做**一次真实复盘冒烟**，确认 `llm_effective=true`。
2. **测试库无可用 LLM 配置**（当前 0 条 active）：E2E 依赖 mock 注入（`scripts/e2e-retro-todo.mjs`），不影响验证；如需测试库真实链路，须由您写入真 key（涉密钥落库，需 HITL 授权）。
3. **测试侧物理 DELETE 违规（非本线，仅记录）**：`test/billing/billingService.test.js:15-19` 等使用 `DELETE FROM crm.tenants / billing_payment ...`，与「禁 DELETE（走软合并）」铁律不一致。测试隔离场景下可接受，但有扩散风险——建议后续统一为独立租户 + 软删，**未擅自改动**（属他线文件）。
