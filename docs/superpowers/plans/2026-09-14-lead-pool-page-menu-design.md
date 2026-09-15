# 公海池菜单查询页设计（2026-09-14）

> 状态：**已批准**（2026-09-14，用户「同意」）· 设计先行 brainstorming → 本文档 → writing-plans → 实现
> 关联设计：`docs/superpowers/plans/2026-09-11-lead-public-pool-tenant.md`（S0/S0P 阶段模型与租户隔离，已落地）

## §0 背景与目标

公海池（S0）阶段模型与租户隔离已落地（T1–T10），但**缺少"公海线索明细的查询入口"**：
- 仅有 `pool-config.html`（规则配置页，管理员面）、`pipeline.html`（聚合看板，无公海明细表）；
- 公海数量只在 `/api/business/board` 暴露 `count`，无明细；
- 销售无法在界面上看到/领取公海线索，只能走 MCP 或手工。

本设计交付：**独立菜单页 + 公海明细列表 + 认领闭环**，并修复两个上线即带病的缺口。

## §1 范围

| 做 | 不做 |
|---|---|
| 菜单项「公海池」→ `/lead-pool.html`（销售组，`core_crm` 权益门禁） | ❌ 不新增粒子类型 / Action（复用 `crm-lead-pick`） |
| 页面：公海明细表 + 筛选 + 认领 | ❌ 不动 MCP 工具面 / 插件包（保持 v1.9.0） |
| `GET /api/lead-pool`（明细 + 池规则 + 已领数） | ❌ 批量退回 / 回收 / 重分配（Q1=A 档） |
| `POST /api/lead-pool/:id/pick`（p1Dispatch 范式） | ❌ 不改 `context-routing`（红线 id36） |
| 缺口① 认领竞态 CAS、缺口② `pooled_at` 缺失 | ❌ 任何 `DELETE` |

## §2 四问决策汇总

| # | 问题 | 决策 |
|---|---|---|
| Q1 | 页面职责 | 列表 + 认领（A 档） |
| Q2 | 页面载体 | 独立页 `lead-pool.html` + 销售组菜单（紧邻「线索·商机」） |
| Q3 | 数据来源 | 新增专用端点 `GET /api/lead-pool`（同源 SQL 算 `my_pick_today`） |
| Q4 | 认领入口 | 新语义化端点 `POST /api/lead-pool/:id/pick`（复用 `p1Dispatch` 范式，不裸调通用动作端点） |

## §3 端点契约

### 3.1 `GET /api/lead-pool`
- 租户谓词：`scopeTenant(me)`（读通道，与前序一致）
- DB 过滤：`type='CRM_DEAL' AND tenant_id=$1 AND payload->>'stage'='S0'`
- 返回：
```json
{
  "items": [
    { "id":"deal_xxx", "name":"...", "source":"discovery|标讯|手工",
      "pool_type":"new|nurture|lost", "in_pool_days": 3,
      "acct_name":"...", "est_amount": 0 }
  ],
  "total": 137, "returned": 100, "truncated": true,
  "rules": {"daily_limit":10,"pick_interval_hours":24,"new_data_only":true,"prev_owner_only":false},
  "my_pick_today": 3, "my_can_pick": true
}
```
- **`truncated` / `total` 必须返回**：`limit` 默认 100，截断时前端提示"仅显示前 100 条，共 137 条"，杜绝假绿。
- **`my_pick_today` 必须复用 `crm-lead-pick` 同一套 agg SQL**（`seed-actions.js:887-890` 的当日 `picked_at` 聚合）→ 页面"3/10"提示与实际闸门同源。
- 排序：入池时间倒序（最新入池优先）。

### 3.2 `POST /api/lead-pool/:id/pick`
- 范式：`p1Ctx`（`routes.js:3205`，`tenantId ?? null` **fail-closed**）→ `p1Dispatch`（`routes.js:3209`）→ `actionExecutor.dispatch('crm-lead-pick', {deal_id:id, owner_id:me}, ctx)`。
- **不裸调 `POST /api/action/:name`**（`routes.js:3179` 用 `me.tenantId || 'system'` 兜底，踩 P1-1 已识别缺陷）。
- 返回：`{ ok: true, data, decision_id }`（与 `p1Dispatch` 一致）；失败：`{ ok:false, gate, error }`。

## §4 页面设计（`src/web/lead-pool.html`）

| 区 | 内容 |
|---|---|
| 顶部条 | 公海总量 · 我的今日 `3/10`（达 `daily_limit` 则按钮禁用 + 原因文案） |
| 筛选 | 池类型（全部/new/nurture/lost）· 来源 · 关键词 |
| 表格 | 线索 / 来源 / 池类型 / **入池天数** / 金额 / [认领] |
| 认领 | 二次确认弹窗 → POST → 成功则该行移除 + toast；失败展示池规则原因（`error` 文案） |
| 截断提示 | `truncated===true` 时顶部黄条"仅显示前 100 条，共 N 条" |
| 空态 | 「当前公海无待领取线索」+ 链接 `/pool-config.html` |
| 样式 | 走 `tokens.css` / `common.css`，**零硬编码颜色**；页头注入 `injectLayout()` |

## §5 菜单

`src/portal/layoutMenu.js` 的 `FULL_MENU` 新增一项（紧随「线索·商机」）：
```js
{ group: '销售', label: '公海池', href: '/lead-pool.html', requiresEntitlement: ['core_crm'] }
```
- 权益门禁 `core_crm` 与「线索·商机」同级（配置驱动，免费档不展示）。
- ⌘K 命令面板经 `menuFor()` 自动纳入。

## §6 两个缺口（已批准纳入）

### 缺口① 认领竞态（P0）
- **根因**：`updateParticle`（`particleRepo.js:203-236`）是 read-modify-write，`UPDATE` 无版本/CAS 条件 → `crm-lead-pick` 的「查 S0 → 写 S0P」两段非原子。两人同时认领同一 S0，都通过 `owner_id` 空检查，后者覆盖前者，两人皆收 `ok:true`。
- **方案 A（批准）**：`crm-lead-pick` handler 内将最终 `updateParticle` 改为 **CAS 直更**：
  ```sql
  UPDATE crm.particles
  SET payload = payload || $jsonb, updated_at=now()
  WHERE id=$id AND tenant_id=$tid
    AND payload->>'stage'='S0'
    AND coalesce(payload->>'owner_id','')=''
  RETURNING *
  ```
  `rowCount===0` → 抛「已被他人领取或已不在公海，请刷新」。保留池规则校验（CAS 前仍跑 `checkPickRule`）。
- 改动点：`seed-actions.js:915-924`（当前 `crm-lead-pick` 的 updateParticle 调用）。

### 缺口② `pooled_at` 缺失（P1）
- **根因**：有 `picked_at`/`returned_at`（`seed-actions.js:920,1033`），**无 `pooled_at`** → 「入池天数」只能退化用 `created_at`：3 个月前创建、今天退回公海的线索会显示"90 天"（实际 0 天）→ 超期提示/排序全错。
- **方案**（批准）：
  1. 5 个**入池写入源**补 `pooled_at = now()`：
     - 获客：`discoveryOrchestrator.js:93`、`tenderConnector.js:55`、`pipeline.html:189`
     - 动作回池：`crm-lead-recycle`(`:969-972`)、`crm-lead-return`(`:1026-1029`)、`crm-deal-archive-to-pool`(`:1079-1082`)、`crm-lead-reclaim-bulk`(`:1148`)
  2. 读取兜底：`in_pool_days = now() - (pooled_at ?? returned_at ?? created_at)`
  3. 存量幂等回填（迁移 SQL，仅 S0 且无 `pooled_at`）：`pooled_at = updated_at`（回收时已更新 payload，`updated_at`≈入池时刻）

## §7 任务分解与验证标准

| # | 任务 | 关键文件 | 验证标准（可判定） |
|---|---|---|---|
| T1 | `GET /api/lead-pool` | `src/http/routes.js`（新增路由）；`src/sales/pool.js` 或内联查询 | 单测：①返回 `truncated/total`；②`scopeTenant` 跨租户不可见（A 租户写 S0，B 租户 GET 不返回）；③`my_pick_today` 与 pick handler 聚合一致 |
| T2 | `POST /api/lead-pool/:id/pick` | `src/http/routes.js:3209` 旁新增 | 单测：①未登录 401；②`me.tenantId` 缺失 → fail-closed（不静默得 system）；③成功 S0→S0P + owner 设置 |
| T3 | 缺口① CAS | `src/action/seed-actions.js:915` | **并发测试**：并行两次认领同一条 S0，仅 1 次 `ok:true`，另一返回"已被领取" |
| T4 | 缺口② `pooled_at` | 5 写入源 + 迁移 SQL | 单测：①存量回填幂等（重复跑无新增变更）；②`in_pool_days` 使用 `pooled_at` 正确 |
| T5 | 页面 `lead-pool.html` | `src/web/lead-pool.html`（新建） | 渲染 + 截断提示 + 空态；认领后行移除 |
| T6 | 菜单项 | `src/portal/layoutMenu.js` | 单测：`menuFor('sales')` 含「公海池」且 `core_crm` 缺失时不展示 |
| T7 | E2E 扩展 | `scripts/e2e-lead-pool-actions.mjs` | 页面链路真跑（自起 HTTP 实例 + 真实端点）；断言列表/认领/并发 |
| T8 | 文档 + 提交命令 | 本文档 + `docs/superpowers/plans/` | 按功能线分组 PowerShell 提交命令（K–Q，AI 不 commit） |

## §8 不变量与铁律

- **绝对禁 DELETE**：仅 `UPDATE`/`SELECT`，CAS 是 UPDATE。
- **租户隔离**：读 `scopeTenant`、写 `p1Ctx`（`tenantId ?? null` fail-closed），禁止 `|| 'system'` 兜底。
- **池规则全保留**：`crm-lead-pick` 的 `checkPickRule` 全程不旁路；CAS 仅替换最终写，不改前置校验。
- **零硬编码颜色**、不新增粒子类型/Action、不改 `context-routing`。
- **并发安全**：缺口① CAS 是验收硬标准（T3）。

## §9 file:line 锚点索引

| 项 | 锚点 |
|---|---|
| 菜单单源 | `src/portal/layoutMenu.js` FULL_MENU |
| 通用动作端点（不裸用） | `src/http/routes.js:3179` |
| p1Ctx / p1Dispatch | `src/http/routes.js:3205 / 3209` |
| crm-lead-pick handler | `src/action/seed-actions.js:855-925` |
| pick 最终写入（CAS 改点） | `src/action/seed-actions.js:915-924` |
| updateParticle（read-modify-write） | `src/particles/particleRepo.js:203-236` |
| 回池写入点 | `seed-actions.js:969-972 / 1026-1029 / 1079-1082 / 1148` |
| 获客 S0 写入源 | `discoveryOrchestrator.js:93` · `tenderConnector.js:55` · `pipeline.html:189` |
| 看板公海 count | `src/portal/businessBoard.js:90` |
| 池配置页 | `src/web/pool-config.html` · `routes.js:3149` |

## §10 闭环回写（P10）

本设计为平台工程任务，无 agent 编排；运行期监控由 workbench 的页面 E2E（T7）与单测（T1–T6）承担。无 `*.feedback.json` 缺口记录。

## §A 契约说明

本设计的 T1–T8 为**平台工程实现任务**，由主代理（非 agentSpec 注册智能体）执行，不套用 brainstorming §A 的 `contract-yaml`（agent 契约需 `agent` 字段 resolve 于 `agentSpec.js` 注册表，与代码实现任务不匹配）。逐任务可验证标准见 §7，等价于契约的"success"字段，供 writing-plans 与实现期核对。

## §B 实施结论（2026-09-14 落地）

**T1–T7 全部落地并通过端到端验证。** 验收载体 `scripts/e2e-lead-pool-actions.mjs` 实跑「自起隔离 HTTP 实例 + 真实 MCP stdio」，**41/41 通过**（含 S3.5 公海池页面链路：GET 200 含 S0 明细 / POST pick 写通道 fail-closed（gate=plan_entitlement_missing_tenant）/ `crm-lead-pick` 直驱 S0→S0P 闭环）。单测 `test/leadPoolPage.test.js`（T1–T6，11 例）+ `test/portal/layoutMenu.test.js`（T6 菜单）同步绿。

### 实际落地锚点（编辑后行号）
| 项 | 锚点 |
|---|---|
| 公海明细 GET | `src/http/routes.js:818`（`scopeTenant` 读通道；返回 `items/total/truncated`，`in_pool_days` 用 `pooled_at ?? returned_at ?? created_at`） |
| 认领 POST | `src/http/routes.js:858`（写通道 fail-closed：缺真实租户/ system 视界 → 400 `gate=plan_entitlement_missing_tenant`，复用 `crm-lead-pick`） |
| CAS 原子认领 | `src/particles/particleRepo.js:203`（签名加 `casExpectStage/casExpectOwnerEmpty`）+ `:232-242`（WHERE 追加 `stage/$6` 校验，`rowCount===0`→抛「已被他人领取或已不在公海」） |
| pick 调用 CAS | `src/action/seed-actions.js:925`（`casExpectStage:'S0', casExpectOwnerEmpty:true`） |
| 回池 pooled_at | `seed-actions.js:979`(recycle) / `:1039`(return) / `:1093`(archive) / `:1158`(reclaim) |
| 获客写入源 pooled_at | `src/agent/discoveryOrchestrator.js:94` · `src/connectors/tenderConnector.js:55` · `src/web/pipeline.html:189` |
| 菜单项 | `src/portal/layoutMenu.js:8`（「公海池」紧邻「线索·商机」，`requiresEntitlement:['core_crm']`） |
| 明细页 | `src/web/lead-pool.html`（新建：表格/筛选/认领二次确认/toast/空态互链 pool-config.html） |
| 存量回填 | `db/migration-lead-pool-pooled-at.sql`（新建，幂等回填 S0 缺 pooled_at）+ `db/migrate.js:269` 挂载 |

### 关键结论
- **并发安全（缺口①）**：CAS 改写消除了 `read-modify-write` 竞态；并行两次认领同一 S0 仅 1 次 `ok:true`，另一返回"已被领取"——验收硬标准 T3 达标。
- **入池天数（缺口②）**：5 写入源 + 存量迁移补齐 `pooled_at`，`in_pool_days` 改用 `pooled_at` 优先，消除"退回即显示 90 天"假象。
- **租户边界**：GET 走 `scopeTenant`（读通道，alice=system 租户仅见 system S0）；POST pick 写通道 fail-closed（P1-1 残余，不静默得全权益），与既有 `crm-lead-pick` 权益口径一致。
- **零回归**：路由/动作/页面/菜单单测与 E2E 全绿；未新增粒子类型/Action/插件包，未改 `context-routing`（红线 id36），绝对禁 DELETE。

### 提交纪律（T8）
本功能线**按分组 PowerShell 命令提交**（AI 无 git 凭据，不 commit）；工作树混有并行会话其他改动（专利文档删除、报告等），**严禁 `git add -A`**，仅显式 `add` 本功能文件；`routes.js`/`seed-actions.js` 混多 hunk，须 `git add -p` 选本功能 hunk。命令见 T8 提交清单。
