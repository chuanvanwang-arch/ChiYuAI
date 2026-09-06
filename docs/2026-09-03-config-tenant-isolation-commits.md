# 配置中心租户隔离改造（T1–T12）提交分组建议

- 日期：2026-09-03
- 范围：新增 12 + 修改 21 = 33 文件（工程师权威清单，QA 独立验收通过）
- 铁律：**每 Task 一 commit；禁 `git add -A`；显式路径 add；AI 无凭证，请本地提交**；署名 `Co-Authored-By: 王川 <watchm@163.com>`（对齐项目惯例）
- ⚠ 工作区混有并行任务未提交改动（monitor 收敛、knowledge seed、userManagement、users.html、docs 研究稿、probe-*、seed-lin-* 等），**下述每个 commit 只 add 本计划文件路径**，勿顺带并入。

## 提交分组表（按依赖顺序执行）

| # | Task | 建议 commit message | 文件清单（相对项目根） |
|---|------|--------------------|------------------------|
| 1 | T9 | `feat(tenant): 租户注册表 crm.tenants + 存量迁移 + 登录闸联查 status（幂等）` | `db/2026-09-03-crm-tenants.sql`（新增）`src/tenant/tenantRepo.js`（新增）`db/migrate.js`（修改）`src/http/auth.js`（修改）`test/tenant/tenant-repo.test.js`（新增） |
| 2 | T1 | `feat(config): configRouter scope 声明 + platform 分支（28 项全量声明）` | `src/http/configRouter.js`（修改）`src/http/routes.js`（修改）`src/portal/configCenter.js`（修改）`test/http/configRouter.test.js`（修改） |
| 3 | T2 | `fix(alerts): financeAlertHook 读配置按租户（tenantId 兜底链）` | `src/alerts/financeAlertHook.js`（修改）`test/alerts/financeAlertHook.test.js`（新增） |
| 4 | T3 | `fix(scheduler): 巡检/派发租户循环 + upload loadThresholdsFor 按租户` | `src/scheduler/timers.js`（修改）`src/assets/upload.js`（修改）`test/scheduler/timers-tenant-scan.test.js`（新增）`test/assets/upload-tenant.test.js`（新增） |
| 5 | T7 | `fix(http): decisionReadRoutes 场景读补租户优先回退` | `src/http/decisionReadRoutes.js`（修改） |
| 6 | T8 | `fix(agent): eventTrigger 去重按租户（粒子/任务双条件）` | `src/agent/eventTrigger.js`（修改）`test/agent/event-trigger-tenant.test.js`（新增） |
| 7 | T4 | `feat(context): assembler 显式传租户至 resolveTracks` | `src/context/assembler.js`（修改）`src/agent/agentLoop.js`（修改）`test/context/assembler-tenant-routing.test.js`（新增） |
| 8 | T5 | `feat(decision): 七维/复盘消费方按租户读配置（relation 平台基线保持）` | `src/calibration/knobs/sevenDimConfigStrategy.js`（修改）`src/decision/relation.js`（修改）`src/decision/traceRootCause.js`（修改）`src/decision/retroTrigger.js`（修改）`test/decision/retro-trigger-tenant.test.js`（新增） |
| 9 | T6 | `fix(decision): searchPrecedents 粗召回补租户条件（tenant ∪ system）` | `src/decision/decisionRepo.js`（修改） |
| 10 | T10 | `feat(seed): seedTenantDefaults 通用播种器 + 建租户三步流程（注册→播种→引导）` | `db/seed/tenantDefaults.js`（新增）`db/seed/seed-all-tenants.mjs`（修改）`src/http/tenantRouter.js`（修改）`test/db/tenant-defaults.test.js`（新增） |
| 11 | T11 | `feat(decision): patrolChains 按租户巡检 + runPatrol 租户循环（P2）` | `src/decision/provenance.js`（修改）`src/scheduler/timers.js`（修改，与 T3 同文件——若 T3 已先 commit，此处 add 同一文件的新增部分再 commit） |
| 12 | T12 | `test(verify): 配置中心租户隔离联测脚本 V1–V10（只读/+--with-seed）` | `scripts/verify-config-tenant-isolation.mjs`（新增） |

## PowerShell 命令示例（每 Task 一组，禁 git add -A）

```powershell
# Commit 1（T9）
git add db/2026-09-03-crm-tenants.sql src/tenant/tenantRepo.js db/migrate.js src/http/auth.js test/tenant/tenant-repo.test.js
git commit -m "feat(tenant): 租户注册表 crm.tenants + 存量迁移 + 登录闸联查 status（幂等）"

# Commit 2（T1）
git add src/http/configRouter.js src/http/routes.js src/portal/configCenter.js test/http/configRouter.test.js
git commit -m "feat(config): configRouter scope 声明 + platform 分支（28 项全量声明）"

# Commit 3-12（T2/T3/T7/T8/T4/T5/T6/T10/T11/T12）按上表文件清单逐一 add + commit
```

## 备注

- **T11 与 T3 均改 `src/scheduler/timers.js`**：T3 先 commit 后，T11 再 add 同一文件的新增改动提交即可（git 按内容差异区分）。
- **提交顺序**：T9 前置（T10/T11 依赖注册表），再 T1（声明锚点），其余 P0/P1 随后，T12 收口。也可按你自己的节奏合并相邻小 commit，但保持「一个 Task 一个逻辑提交」。
- **不提交**：工作区中 parallel 任务改动（见文首 ⚠）与 18 个 backlog 真红用例（decision-gate/swas 假 UUID、replayDims 子表清理等，QA 已定性与本计划无因果）。
