# 线索公海池·租户隔离设计（三类池 + 四类退回通道）

- 日期：2026-09-11
- 状态：待用户评审（P8）
- 方案：A 池类型化改造 + **按租户完全隔离**（用户 2026-09-11 追加约束）
- 设计输入：用户口述流程（市场/展会/官网 → 公海池 → 认领 → BANT 校验 → 升级正式线索；四类退回触发）
- 上游文档：`docs/specs/2026-08-25-ai-native-crm-overall-design.md`（B6 池章节）

---

## §0 结论与红线

**结论**：主干「公海 → 认领 → 超期自动回收」已落地；用户列的四类退回仅 ① 可用，②③④ 缺失；三类公海当前只有单池概念；**租户隔离存在 3 处漏网（含 1 处 P0 写操作无租户限定）**。本设计补全之。

**红线（不可突破）**

1. 不新增粒子类型；线索 = `CRM_DEAL` 的 **S0 / S0P / S1** 阶段（公海 / 私海待校验 / 正式线索，见 §3.5；沿用 `src/sales/pool.js:3` 铁律「不新建 CRM_LEAD 粒子」）。
2. 池不是粒子，是**治理配置**；租户隔离靠 `crm.config_store` PK=(tenant_id, key)，不靠代码分叉。
3. 所有天数 / 目标池 / 权限 100% 配置化（`config_store` + `readThreshold`），禁字面量。
4. 写路径一律经**决策第 0 闸 + HITL**；`context-routing`（id36）禁改。
5. 禁 DELETE（项目铁律）：归档/回收均为字段变更 + 审计边，无物理删除。
6. 平台模板 `system` 仅作**克隆源**，运行时不回退（对齐 `configStore.js:4-6` G1 修复语义）。

---

## §1 现状证据（源码级盘点）

| # | 环节 | 状态 | 证据 |
|---|---|---|---|
| 1 | 池 = 组织治理配置，非粒子 | 🟢 | `src/sales/pool.js:5` `DEFAULT_POOL_CONFIG` |
| 2 | 销售认领 `crm-lead-pick` | 🟢 | `src/action/seed-actions.js:841`（PickRule 四项校验 `pool.js:54`、第 0 闸 autoDecision） |
| 3 | ① 超期未跟进自动回收 | 🟢 | `src/scheduler/timers.js:138`（30min 扫描 → emit `lead-overdue`）→ `crm-lead-recycle` `seed-actions.js:896` |
| 4 | 战败重开 | 🟢 | `crm-deal-reopen` `seed-actions.js:784` + `src/sales/reopenDeal.js`（S7/S8→S2） |
| 5 | ② 手动退回（无立项/无预算） | 🔴 | `seed-actions.js:916` 硬校验 `checkRecycleRule`，未超期即 `throw 未达回收条件` → 销售退回被引擎拒 |
| 6 | ③ 战败归档入公海 | 🔴 | S7/S8 保留 `owner_id`，无归档入池动作 |
| 7 | ④ 离职批量回收 | 🔴 | 全库无 offboard / 资产回收；`timers.js` 无该任务 |
| 8 | 三类池（new/nurture/lost） | 🔴 | 无 `pool_type`；`pool_id` 默认 `'org-hq'` 单池 |
| 9 | BANT 校验在线索侧 | 🟡→🟢设计已给落点 | 现状：BANTCC 闸挂 `executor.js:415 salesDealPrereq`，**S1 显式豁免**，实挂在 S2+；S1→S2 硬门是 `need_facts`（`executor.js:262`）。MANT 齐全性 `funnelQuality.js:15` 仅用于展示。**本设计新增 `S0P→S1` 边并挂该闸（§3.5.2），S1 豁免逻辑移除** |
| 10 | 「正式线索」状态载体 | 🔴→🟢设计已给载体 | 现状无；本设计以 **S1 = 正式线索** + `qualified_at`/`qualified_by` 表达 |

### 租户隔离缺陷（本设计必修）

| 级 | 缺陷 | 证据 | 后果 |
|---|---|---|---|
| **P0** | `crm-lead-recycle` 写粒子**未传 `tenantId`** | `src/action/seed-actions.js:929`（对比 `lead-pick` 第 887 行有传） | 回收写操作无租户谓词 → 跨租户写风险 |
| **P0** | 配置中心第 20 项「池配置」标 `scope:'tenant'`，实际 `getPoolConfig('org-hq')` **不带 tenantId** | `src/http/controlledConfigPages.js:194` | 租户管理员看到/改的是 system 配置（标签失真，同 id35/36/39/44 家族） |
| **P1** | 池标识硬编码 `'org-hq'` | `seed-actions.js:857` / `:911` | 多租户共用同一组织粒子 → 配置串租户 |
| **P1** | 配置页字段与引擎契约不对齐 | `poolConfigRender.js:4` 仅 `pickRule`/`recycleAfterDays`；引擎实际消费 `daily_limit`/`pick_interval_hours`/`prev_owner_only`/`new_data_only`（`pool.js:54-73`） | 页面改的键引擎不认，引擎读的键页面改不到 |
| **P1** | 池查询未带 tenant_id 谓词 | `seed-actions.js:863` 聚合查询仅按 `owner_id` | 跨租户计数串扰（领取限额算错） |

---

## §2 租户隔离模型

### 2.1 真源迁移：组织粒子 → `config_store`

| 项 | 现状 | 目标 |
|---|---|---|
| 载体 | `CRM_ORGANIZATION.payload.pool_config` | `crm.config_store` PK=(tenant_id, key)，key = `lead-pool-config` |
| 隔离 | 依赖调用方自觉传 `tenantId`，缺省回落 `system` | PK 天然隔离；缺键 **autoSeed 懒克隆** system 模板（`configStore.js:29-45`） |
| 下发 | 无 | 复用 `broadcastConfig`（`src/config/broadcast.js`，经第 0 闸 + HITL） |
| 审计 | 无 | `decision_id` + `updated_by` + `_seeded` 标记 |

**迁移理由**：`config_store` 已有成熟 per-tenant + autoSeed 范式（`configStore.js:1-70`），零新增隔离代码；组织粒子方案已被实测证明会漏传 `tenantId`（§1 P0）。

### 2.2 读优先级（三层，兼容存量）

```
config_store(tenant_id, 'lead-pool-config')   ← 租户自持（含 _seeded 标记）
  ↓ 缺（且组织粒子存在旧配置）
CRM_ORGANIZATION.payload.pool_config          ← 存量兼容读（只读，不回写）
  ↓ 缺
DEFAULT_POOL_CONFIG（pool.js:5）              ← 代码兜底
```

已知存量隔离测试基线：`test/sales/poolTenant.test.js`（2026-09-05）、`test/pool-config.test.js`。

### 2.3 租户视界

| 角色 | 可见范围 | 可写 |
|---|---|---|
| 租户管理员 | 本租户 `pools[]`（`_seeded` 时显示「继承自平台模板」徽标） | 本租户行 |
| 销售 / 经理 | 本租户池（只读规则，用于领取） | 否（仅触发领取/退回 Action） |
| 平台 sysadmin | `system` 模板 + 各租户 | 模板 + broadcast 强制下发 |

---

## §3 三类池模型（每租户一套）

```json
{
  "version": 1,
  "default_pool": "pool-new",
  "pools": [
    {
      "id": "pool-new", "type": "new", "label": "新线索公海", "enabled": true,
      "pick_rule":     { "daily_limit": 10, "prev_owner_only": false, "pick_interval_hours": 24, "new_data_only": true },
      "recycle_rule":  { "recycle_days": 30, "recycle_target": "self" },
      "return_target": "pool-nurture"
    },
    {
      "id": "pool-nurture", "type": "nurture", "label": "培育公海", "enabled": true,
      "pick_rule":     { "daily_limit": 5, "prev_owner_only": true, "pick_interval_hours": 24, "new_data_only": false },
      "recycle_rule":  { "recycle_days": 90, "recycle_target": "self" },
      "promote_to": "pool-new",
      "promote_signals": ["budget_confirmed", "project_approved"]
    },
    {
      "id": "pool-lost", "type": "lost", "label": "战败回收公海", "enabled": true,
      "pick_rule":     { "daily_limit": 5, "prev_owner_only": false, "pick_interval_hours": 0, "new_data_only": false },
      "recycle_rule":  { "recycle_days": 180, "recycle_target": "self" },
      "reopenable": true
    }
  ]
}
```

**DEAL 侧字段**：新增 `pool_type`（`new` / `nurture` / `lost`）、复用已有 `pool_id`。**不新增粒子类型、不改业务域模型**（§0 红线 1）。

**默认池解析**：禁止硬编码 `'org-hq'`；改由 `default_pool` + `pool_type` 解析（`resolvePoolId(cfg, { pool_type, pool_id })`）。

---

## §3.5 阶段模型：公海 = S0（用户 2026-09-11 明确）

现状 `S1 线索发掘`（`stageTaxonomy.js:6`）不区分「有主 / 无主」，公海靠 `owner_id IS NULL` 隐式表达——公海因此不是一个可见阶段，看板、漏斗、待办都无法直接按阶段取公海。引入 **S0 = 公海**：

| 码 | 名称 | 语义 | 判定 |
|---|---|---|---|
| **S0** | **公海** | 未认领 / 已退回 / 已回收的公共线索 | `owner_id IS NULL` |
| **S0P** | **私海线索（待校验）** | 已认领进私海，BANT 校验中，**尚未成为正式线索** | `owner_id` 非空 且 BANT 未达标 |
| **S1** | **正式线索** | BANT 四要素齐 → 升级成功（原「线索发掘」语义收窄为正式线索） | `salesDealPrereq.ok` / `qualified_at` |
| S2–S6 | 需求确认…赢单移交 | 不变 | — |
| S7/S8 | 输单 / 丢单 | 终态，不变 | — |

> 用户 2026-09-11 两次校准：**公海 = S0**；**认领不等于 S1，BANT 校验通过升级后才进 S1**。故在 S0 与 S1 之间新增 `S0P`（private，私海待校验），`S1` 及之后编号与漏斗口径保持不动。
>
> 副产品：BANT 校验由此获得真正的落点闸门 `S0P→S1`（`executor.js:415 salesDealPrereq` 从「挂 S2+ 且 S1 豁免」改为在此边生效），顺带补上 §1-9 记录的「BANT 在线索侧缺位」。

### 3.5.1 两套阶段集合（关键：不污染漏斗口径）

`src/sales/funnelKpi.js:36` 用 `S_STAGES.indexOf(single)` 做前缀展开（`maxStage='S3'` → `['S1','S2','S3']`）。**若把 S0 插进 `S_STAGES`，漏斗上游会吞进公海线索，全部转化率口径失真**。因此：

| 常量 | 取值 | 用途 | 变更 |
|---|---|---|---|
| `S_STAGES` | `['S1'…'S8']` | 漏斗 / 统计 / 既有消费方 | **保持不变** |
| `S_POOL_STAGE` | `'S0'` | 公海语义常量 | 新增 |
| `S_PICKED_STAGE` | `'S0P'` | 私海待校验语义常量 | 新增 |
| `S_ALL_STAGES` | `['S0','S0P','S1'…'S8']` | 状态机校验、阶段合法性、推进边 | 新增 |
| `S_PRE_DEAL_STAGES` | `['S0','S0P']` | 公海/待校验查询、`isPoolStage` 判定 | 新增 |

消费方改造点：`seed-actions.js:443`（阶段合法性）、`mcp/gateway.js:96`（S 码校验）、`particleModel.js:13`（flow）、`particleRepo.js:18`（`DEAL_STAGES`）改用 `S_ALL_STAGES`；`funnelKpi.js` 不动。

### 3.5.2 推进边

新增 / 调整（其余不变）：

| 边 | 语义 | 闸门 |
|---|---|---|
| `S0→S0P` | 认领（公海 → 私海） | 阶段闸不设；由 `crm-lead-pick` 的 PickRule 把关 |
| `S0P→S1` | **BANT 校验通过，升级正式线索** | **hard：`salesDealPrereq`（B/A/T 三要素或 `bantcc_completeness ≥ bantcc.pass`）** |
| `S0P→S0` | 退回 / 超期回收 / 离职回收 | 阶段闸不设；`crm-lead-return` 需 `reason_code` |
| `S1→S0` | 正式线索退回（降级重估） | 需 `reason_code`，写 `qualified_at=null` |
| `S7/S8→S0` | 战败归档进战败公海 | 需 `pool_type=lost` + 写 `last_terminal_stage` 留痕 |
| `S0→S1` / `S0→S2` | **禁止** | 未经认领与校验不得升级 |
| `S0/S0P→S7/S8` | 公海/待校验直接判无效 | 允许（clean 掉无价值线索） |

**战败归档的阶段取舍**：归档后阶段置 `S0`（统一公海语义）+ `pool_type=lost`，同时写 `last_terminal_stage`（`S7`/`S8`）保留输单/丢单事实，避免归档即丢失战败信息。再激活 `crm-deal-reopen` 从 `S0(lost)` → `S2`，读 `last_terminal_stage` 回填复盘口径。

### 3.5.3 存量迁移（一次性，禁 DELETE）

```sql
-- ① 无主线索 → S0（公海）
UPDATE crm.particles
   SET payload = payload || jsonb_build_object('stage','S0','pool_type', COALESCE(payload->>'pool_type','new'))
 WHERE type='CRM_DEAL'
   AND payload->>'stage' IN ('lead','S1','S0')
   AND payload->>'owner_id' IS NULL;

-- ② 有主 且 BANT 已达标 → S1（正式线索），补 qualified_at
UPDATE crm.particles
   SET payload = payload || jsonb_build_object('stage','S1','qualified_at', COALESCE(payload->>'qualified_at', to_char(now(),'YYYY-MM-DD')))
 WHERE type='CRM_DEAL'
   AND payload->>'stage' IN ('lead','S1')
   AND payload->>'owner_id' IS NOT NULL
   AND ( COALESCE((payload->'ai'->'bantcc_completeness'->>'value')::numeric, 0) >= 0.6
      OR (payload->'bantcc'->>'budget' IS NOT NULL AND payload->'bantcc'->>'authority' IS NOT NULL) );

-- ③ 有主 且 BANT 未达标 → S0P（私海待校验）
UPDATE crm.particles
   SET payload = payload || jsonb_build_object('stage','S0P')
 WHERE type='CRM_DEAL'
   AND payload->>'stage' IN ('lead','S1')
   AND payload->>'owner_id' IS NOT NULL
   AND NOT ( COALESCE((payload->'ai'->'bantcc_completeness'->>'value')::numeric, 0) >= 0.6
          OR (payload->'bantcc'->>'budget' IS NOT NULL AND payload->'bantcc'->>'authority' IS NOT NULL) );
```

三条语句互斥且覆盖全部存量（无主 / 有主达标 / 有主未达标），执行顺序 ①→②→③；`0.6` 取 `bantcc.pass` 配置值（迁移脚本读 `config_store` 而非硬编码）。迁移后校验：`count(S0)+count(S0P)+count(S1) = 迁移前线线索总数`。

**兼容读**：`S_ALIAS_FWD.lead` 仍映射 `S1`；新增 `normalizeDealStage(deal)` —— 公海判定**以 `owner_id` 为准**（无主且 stage∈{S0,S1} → S0），防止迁移遗漏时出现「无主却算 S1」的假象。

### 3.5.4 `'lead'` 语义分流清单（12 处，必须逐处判定）

| 文件:行 | 现状语义 | 改为 |
|---|---|---|
| `seed-actions.js:854` `crm-lead-pick` | `stage !== 'lead'` 拒领 | `toStageCode(stage) !== 'S0'` → **仅公海可领**，写 `S0→S0P` |
| `seed-actions.js:909` `crm-lead-recycle` | `stage !== 'lead'` 拒收 | 回收对象为已认领线索 → `toStageCode(stage) !== 'S0P'`，写 `S0P→S0` |
| `seed-actions.js:862` 池聚合查询 | `'lead'` + `owner_id=$1` | `'S0P'`（已认领计数，带 tenant 谓词） |
| `timers.js:141` 超期扫描 | `'lead'` + `owner_id IS NOT NULL` | `'S0P'` + `owner_id IS NOT NULL`（**不是 S0**——公海无人跟进，不该被回收） |
| `agent/discoveryOrchestrator.js:92` | 新建线索 `stage:'lead'` | `stage:'S0'` + `pool_type:'new'`（拓客结果直接落公海） |
| `connectors/tenderConnector.js:54` | 标讯入库 `stage:'lead'` | `stage:'S0'` + `source:'标讯'` |
| `http/routes.js:932/1081/1236/948` | 阶段兜底 `'lead'` | 走 `normalizeDealStage()`：无主 → S0；有主未达标 → S0P；有主达标 → S1 |
| `account/insightService.js:159` | 线索分组 `==='lead'` | 线索域 = `S_PRE_DEAL_STAGES + ['S1']` |
| `portal/businessBoard.js:87` | 线索计数 `==='lead'` | 拆两列：**公海 S0** / 私海（S0P + S1） |
| `sales/namedAccountBoard.js:20` | 同上 | 同上 |
| `portal/detailSections.js:46/50` | 阶段显示映射表 `['lead','线索']` | 增 `['S0','公海']`、`['S0P','私海线索']`，`S1` 显示「正式线索」 |
| `portal/scoring.js:34` | 浏览器内联 `S_ALIAS` | 同步 S0 / S0P |

---

## §4 流转矩阵（全部带 tenant_id）

| 触发 | 动作 | 阶段迁移 | 目标池 / 结果 | 状态 |
|---|---|---|---|---|
| 市场 / 展会 / 官网 / 标讯 / 拓客录入 | `data-particle-create`（`owner_id=null`，`pool_type=new`，`source` 归因） | — → **S0** | `pool-new` | 改造（T7） |
| 销售认领 | `crm-lead-pick`（改造：按目标池 `pick_rule` + 租户谓词） | **S0 → S0P** | 私海（`owner_id`） | 已有 |
| **BANT 校验通过** | `crm-deal-advance`（闸门 `salesDealPrereq`） | **S0P → S1** | 私海不变，落 `qualified_at` | 已有（闸门迁移到本边） |
| ① 超期未跟进 | `crm-lead-recycle`（改造：回 `recycle_target`） | **S0P → S0** | 原池 / 转培育（配置） | 已有 |
| ② 无立项/无预算，手动退回 | **`crm-lead-return`（新增）** | **S0P/S1 → S0** | `return_target`（默认 `pool-nurture`） | 新增 |
| ③ 战败 S7/S8 归档 | **`crm-deal-archive-to-pool`（新增）** | **S7/S8 → S0** + `last_terminal_stage` | `pool-lost` | 新增 |
| ③' 战败再激活 | `crm-deal-reopen` | **S0(lost) → S0P** | 从 lost 取出回私海，重走 BANT | 改造 |
| 培育转新线索 | **`crm-lead-promote`（新增，可选）** | S0 → S0（换池） | `promote_to`（`pool-new`） | 可选 |
| ④ 销售离职 | **`crm-lead-reclaim-bulk`（新增）** | **S0P/S1–S6 → S0** | 按原 `pool_type` 归池 | 新增 |

---

## §5 Action 清单

| Action | 类型 | 关键校验 | confirm |
|---|---|---|---|
| `crm-lead-return` | 新增 write | **跳过 `checkRecycleRule` 超期校验**（根因 `seed-actions.js:916`）；校验 `stage ∈ {S0P,S1}` + `reason_code ∈ {no_project, no_budget, no_decision_maker, no_timeline, other}` + **MANT 齐全性断言**（复用 `funnelQuality.js:15 mantOk`）；写 `→S0` + `pool_type=return_target` | normal |
| `crm-deal-archive-to-pool` | 新增 write | stage ∈ {S7,S8}；写 `S0` + `pool_type=lost` + `owner_id=null` + `last_terminal_stage` + `archived_at` + 审计边 | critical |
| `crm-lead-reclaim-bulk` | 新增 write | 入参 `user_id` + `tenantId`；批量回收其名下 S1–S6 未成交 DEAL（S7/S8 归 lost，其余归原池）+ 单条审计边 | critical |
| `crm-lead-pick` | 改造 | 目标池规则解析（弃 `'org-hq'` 硬编码）+ **仅 S0 可领**（`seed-actions.js:854`）+ 跨租户拒绝 + 聚合查询带 tenant 谓词；写 `S0→S0P` | normal |
| `crm-lead-recycle` | 改造 | 判定对象改为 **S0P（已认领）**；**补传 `tenantId`**（P0）；回 `recycle_target` 并置 `S0`；保留 `pool_type` | normal |
| `crm-deal-advance` | 改造 | `S0P→S1` 边挂 **hard 闸**：在 `executor.js` 的 `STAGE_GATES` 新增 `S0P→S1` 条目（第 3.5 闸仅对 `crm-deal-advance` 生效，`executor.js:166`），判据为 B/A/T 三要素或 `bantcc_completeness ≥ bantcc.pass`；通过后写 `qualified_at` / `qualified_by`。**`salesDealPrereq`（`executor.js:380`）的 S1 豁免保留不动**——它只作用于 `data-particle-create`，移除会使「新建商机默认 stage=S1」被三要素闸硬拦（实施期实测后的刻意偏离，见实施计划「偏离 A」） | normal |
| `crm-deal-reopen` | 改造 | 源阶段从 `{S7,S8}` 扩展为 `{S7,S8,S0(lost)}`；目标由 `S2` 改为 **`S0P`**（重走 BANT）；回填 `last_terminal_stage` 到复盘口径 | critical |

---

## §6 任务与生命契约（T0–T7）

> **承接方说明**：全部 8 个任务归口 `followup-agent`（理由见 T1 下方注释），契约键统一 `ct-followup`。

### T0 引入 S0 公海阶段 + 存量迁移（前置任务，必须先做）

```contract-yaml
- task: "T0 引入 S0 公海阶段与存量迁移"
  agent: followup-agent
  skills: [data-particle-read, data-particle-create]
  memory: [followup-agent]
  knowledge_scope: { layers: [L1, L2], max_hops: 2 }
  contract_task_id: "ct-followup"
  success: "S_ALL_STAGES 含 S0/S0P 而 S_STAGES 仍为 S1-S8（funnelKpi 前缀展开结果不变）；存量 lead 迁移后 count(S0)+count(S0P)+count(S1) 等于迁移前线线索总数；无主 lead→S0、有主达标→S1、有主未达标→S0P；S0→S1 与 S0→S2 推进均被拒"
```
**契约说明**：由 `followup-agent` 承接；成功判定为两套阶段集合隔离生效、迁移三分支守恒、越级推进被拒。

改动：`src/sales/stageTaxonomy.js`（`S_POOL_STAGE` / `S_PICKED_STAGE` / `S_ALL_STAGES` / `S_PRE_DEAL_STAGES` / 推进边 / `normalizeDealStage` / `STAGE_DEFAULT_SCENARIO`：`S0`/`S0P`→`LEAD_FOLLOW_UP`、`S1`→`OPP_QUALIFY`）、迁移脚本 `db/migration-lead-pool-s0.sql`、单测。

### T1 池配置真源迁 `config_store`（per-tenant，autoSeed）+ 三类池模型

```contract-yaml
- task: "T1 池配置真源迁 config_store 并类型化为三池"
  agent: followup-agent
  skills: [data-particle-read, data-particle-create]
  memory: [followup-agent]
  knowledge_scope: { layers: [L1, L2], max_hops: 2 }
  contract_task_id: "ct-followup"
  success: "readConfig('lead-pool-config',{tenantId:'t-a'}) 返回 pools 含 new/nurture/lost 三池；租户写后 system 行 value 不变；缺键触发 autoSeed 且带 _seeded 标记"
```
**契约说明**：由 `followup-agent` 承接（线索池领取/退回/回收/归档全生命周期与其跟进时效职责同源），调用 `data-particle-read` 与 `data-particle-create`，读其自身记忆（L1–L2，≤2 跳）；成功判定为租户读返回三池、租户写不污染 system、缺键自动克隆。

> 承接方收敛说明：全部 6 个任务归口 `followup-agent` 单一 agent，而非按「配置 / 动作」拆给两个 agent。原因：`scripts/validate-contract.mjs` 的反向断言要求覆盖 ≥2 个注册 agent 的文档必须补齐全部 6 个契约键（`contractParser.js:151`），为本设计凭空造 4 个无关任务即构成假绿；而线索池的配置面与动作面本属同一治理闭环，归口单一承接方在职责上同样成立。

改动：`src/sales/pool.js` 增 `readPoolConfig({ tenantId })` / `writePoolConfig({ tenantId, patch, decisionId })`，内部走 `configStore`；保留 `getPoolConfig/setPoolConfig` 旧签名作兼容层（组织粒子路径）。新增 `resolvePoolId(cfg, { pool_type, pool_id })` 取代 `'org-hq'` 硬编码。

### T2 补齐三处租户参数漏传（P0/P1）

```contract-yaml
- task: "T2 补齐池读写三处租户参数漏传"
  agent: followup-agent
  skills: [data-particle-read, data-particle-create]
  memory: [followup-agent]
  knowledge_scope: { layers: [L1, L2], max_hops: 2 }
  contract_task_id: "ct-followup"
  success: "crm-lead-recycle 的 updateParticle 带 tenantId；/api/pool-config GET 按 scopeTenant 返回租户配置；池聚合查询带 tenant_id 谓词"
```
**契约说明**：由 `followup-agent` 承接（回收/跟进职责），成功判定为三处调用点均带租户限定且跨租户写被拒。

改动：`seed-actions.js:929`（补 `tenantId: ctx.tenantId`）、`controlledConfigPages.js:194`（改 `scopeTenant`）、`seed-actions.js:863`（聚合查询加 `AND tenant_id=$2`，阶段条件 `'lead'` → `'S0P'`）、`timers.js:141`（扫描条件 `'lead'` → `'S0P'`，语义 = 已认领未跟进；**公海 S0 不参与回收扫描**）。

### T3 配置页三类池 TAB + 字段对齐 + 租户徽标

```contract-yaml
- task: "T3 池配置页三类池与引擎字段对齐"
  agent: followup-agent
  skills: [data-particle-read, data-particle-create]
  memory: [followup-agent]
  knowledge_scope: { layers: [L1, L2], max_hops: 2 }
  contract_task_id: "ct-followup"
  success: "配置页呈现 new/nurture/lost 三 TAB；POOL_KEYS 覆盖 daily_limit/pick_interval_hours/prev_owner_only/new_data_only/recycle_days；_seeded 时显示平台模板徽标"
```
**契约说明**：由 `followup-agent` 承接；成功判定为三 TAB 渲染且表单键集合与 `DEFAULT_POOL_TEMPLATE` 完全一致。

改动：`src/portal/poolConfigRender.js`（`POOL_KEYS` 对齐引擎）、`src/web/pool-config.html`（三 TAB + 租户徽标）、`src/http/controlledConfigPages.js:186`（改走新读写）。

### T4 `crm-lead-return` 手动退回

```contract-yaml
- task: "T4 实现 crm-lead-return 手动退回公海"
  agent: followup-agent
  skills: [data-particle-read, data-particle-create, method-funnel-classification]
  memory: [followup-agent]
  knowledge_scope: { layers: [L1, L2], max_hops: 3 }
  contract_task_id: "ct-followup"
  success: "S0P/S1 且未超期线索可凭 reason_code 退回成功（stage 转 S0、owner_id=null、pool_type 转 return_target）；空 reason_code 或 stage=S5 被拒；写操作带 tenantId 与 decision_id"
```
**契约说明**：由 `followup-agent` 承接，复用漏斗分类做 MANT 断言；成功判定为合法退回成功、非法入参被拒、写带租户与决策锚定。

### T5 `crm-deal-archive-to-pool` 战败归档 + 再激活

```contract-yaml
- task: "T5 实现战败归档入 lost 池与再激活"
  agent: followup-agent
  skills: [data-particle-read, data-particle-create]
  memory: [followup-agent]
  knowledge_scope: { layers: [L1, L2], max_hops: 3 }
  contract_task_id: "ct-followup"
  success: "S7/S8 商机归档后 stage=S0 且 pool_type=lost 且 owner_id=null 且 last_terminal_stage 保留；reopen 后回到 S0P 且 pool_type 复位；非终态归档被拒"
```
**契约说明**：由 `followup-agent` 承接；成功判定为归档/重开双向语义正确且非终态被拒。

### T6 `crm-lead-reclaim-bulk` 离职批量回收

```contract-yaml
- task: "T6 实现离职批量回收"
  agent: followup-agent
  skills: [data-particle-read, data-particle-create]
  memory: [followup-agent]
  knowledge_scope: { layers: [L1, L2], max_hops: 3 }
  contract_task_id: "ct-followup"
  success: "传入 user_id+tenantId 后其名下 S0P/S1-S6 未成交 DEAL 全部 stage=S0 且 owner_id=null 并按 pool_type 归池，S7/S8 归 lost；返回 count 与实际变更行数一致；跨租户资产不被回收"
```
**契约说明**：由 `followup-agent` 承接；成功判定为回收条数可核对、终态归 lost、跨租户零影响。

### T7 `'lead'` 语义分流 + 前端公海口径（§3.5.4 十二处）

```contract-yaml
- task: "T7 lead 语义分流与前端公海口径"
  agent: followup-agent
  skills: [data-particle-read, data-particle-create]
  memory: [followup-agent]
  knowledge_scope: { layers: [L1, L2], max_hops: 2 }
  contract_task_id: "ct-followup"
  success: "§3.5.4 十二处 lead 字面量按表分流完成；discoveryOrchestrator 与 tenderConnector 新建线索落 S0+pool_type=new+source 归因；看板与洞察页拆出公海 S0 与私海 S1 两列且计数之和等于迁移前线线索总数"
```
**契约说明**：由 `followup-agent` 承接；成功判定为分流全覆盖、新入库线索直落公海、前端口径拆分后总数守恒（防漏改导致线索消失）。

---

## §7 验收与测试

| 层 | 用例 |
|---|---|
| 单元 | 三池解析 / `resolvePoolId` 默认池 / autoSeed 幂等 / 旧组织粒子兼容读 / `checkPickRule` 按池规则 / `normalizeDealStage` 归一口径 |
| **阶段** | `S0→S0P` 认领成立、`S0→S1`/`S0→S2` 被拒、`S0P→S1` 在 BANT 达标时通过且不达标时被拒、`S0P/S1→S0` 退回成立、`S7/S8→S0(lost)` 归档保留 `last_terminal_stage`、`S0(lost)→S0P` 重开成立 |
| **漏斗口径** | `funnelKpi` 展开结果与迁移前逐项一致（S0/S0P 不进 `S_STAGES` 前缀）；`isOpenStage('S0')` 语义确认（见 §9-4） |
| **迁移** | 存量 `lead` 按 `owner_id` 正确二分；迁移后公海数 + 私海数 = 迁移前线线索总数；`funnelKpi` 转化率与迁移前一致（口径零漂移） |
| 隔离 | 租户 A 写池配置 → `system` 与租户 B 的 `config_store` 行不变；租户 A 的 DEAL 不出现在租户 B 池查询 |
| Action | T4/T5/T6 正向 + 反向（非法 stage、缺 reason_code、跨租户） |
| 回归 | `test/sales/poolTenant.test.js`、`test/pool-config.test.js`、`test/action/*`、漏斗相关单测全绿；新增失败 0 |
| 契约 | `node scripts/validate-contract.mjs <doc> --registry src/agent/agentSpec.js` 退出码 0 |

---

## §8 范围边界

**本轮做**：§6 T0–T7（阶段模型 S0/S0P、池类型化、租户隔离、②③④ 三类退回通道）。
**本轮不做**：

1. 拓客候选线索 → 新线索公海落库（`discoveryActions.js` 现状无 `CRM_DEAL` 落库动作）——独立断点，需另立专项。
2. 培育自动触达（邮件/短信/企微）——只做池归属与培育期限回收。
3. 官网表单 / 展会名录接入（线索来源归因仅预留 `source` 字段）。
4. 池容量硬限制、线索评分排序。

---

## §9 未决项（2026-09-11 已拍板，结论随实施计划落地）

| # | 议题 | 结论 |
|---|---|---|
| 1 | 组织级 override（分公司/大区级池配置） | **不纳入本轮**。`CRM_ORGANIZATION.pool_config` 仅作存量兼容读源（`legacyToPools`），不提供写入 |
| 2 | `S0P` 命名 | **采纳 `S0P`**（private，私海待校验）；显示名「私海线索」，`S0` 显示「公海」，`S1` 显示「正式线索」 |
| 3 | 培育转新线索 `crm-lead-promote` | **不纳入本轮**，池配置保留 `promote_to` / `promote_signals` 字段供后续接线 |
| 4 | `isOpenStage('S0')` 语义 | **保持 fail-open `true`**（不动既有判定），新增 `isPoolStage()`；待办/跟进视图（`routes.js:1655`、`workbenchRouter.js:188`）显式 `continue` 排除公海 |
| 5 | 战败再激活落点 | **落 `S0P`**（重走 BANT）；`S7/S8→S0P` 保持，另支持 `S0(lost)→S0P` |

---

## 闭环回写

| task | agent | gap_type | observed | expected | ts | severity |
|---|---|---|---|---|---|---|
| — | — | — | — | — | — | — |

（运行时由 `/agents` 工作台按 contract-yaml 监控写入；同 (task, gap_type) 复发 ≥2 次 → 生成 SKILL 改进提案，需用户批准后方可应用。）
