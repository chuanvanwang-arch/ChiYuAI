# 记忆系统收口 Sprint · 设计文档

| 项 | 内容 |
|---|---|
| 日期 | 2026-09-10 |
| 输入 | ①`CRM客户记忆未写入-根因排查报告_2026-09-10.md` ②`CRM客户记忆内容分析报告_2026-09-10.md` ③`2026-09-10-customer-memory-writeback-design.md`(v1.1) ④`2026-09-10-memory-system-governance-design.md`(§12.5 落地记录) ⑤本轮源码+生产库交叉核验 |
| 范围 | 收口设计已规划但未兑现的 **C3 / U4 / P4 / P5**（P0+P1+P2 已落地并生产验证，见 §0） |
| 状态 | 用户已批准范围（A+B+C 全收口）；P6 写文档 → P7 自检 → P9 writing-plans → 实现 |

> **与既有设计的关系**：本设计是 `memory-system-governance-design.md` P2/P3/P4/P5 阶段的**收口执行子集**，不新增架构、不改动已验证的 C1/C2/C5/C7/C8/C4/U1。所有改动均为"已设计未落地"项的补齐。

---

## §0 复审结论（生产库实证 · 2026-09-10 20:1x）

| 设计要素 | 生产实证 | 判定 |
|---|---|---|
| C1 租户解析 | 非 system 2059/3222 = 63.8%（≥30% 目标） | ✅ |
| C2 锚点解析函数 | `entity_id` 非空 80/3222 = 2.5%（≥80% 目标） | 🔴 逻辑在、覆盖低 |
| C5 决策租户 | acme-consult2 决策 0→18 | ✅ |
| C7 四段式投影 | 111/111 决策记忆含 summary | ✅ |
| C8 先例租户透传 | 代码到位 | ✅ |
| C4 噪声白名单 | 记忆表 631,616 → 3,222 | ✅ |
| U1 装配层租户 | 代码到位 | ✅ |
| U3 rrfSearch | 已删 | ✅ |
| **C3 自动沉淀** | `deal/account/contact:field-change` = **0 条** | 🔴 **未交付** |
| **U4 记忆页租户视图** | 仍 sysadmin-only | 🔴 原始投诉未闭环 |
| R7 先例自锁 | 生产 84/256 = 32.8% HUMAN | 🟡 B/C 独立立项（不在本 Sprint） |
| P4 治理排程 / P5 存量 apply | 脚本存在、未运营 | 🟡 本 Sprint 收口 |

**C3 0 条根因（源码级核实，非崩溃）**：`precipitate.js:shouldPrecipitate` 逻辑正确（单测 stage-change→ok、status-only→no-change）。缺口在：① 监控字段集过窄（仅 `stage/amount/owner/expected_close_date/close_date`，缺设计 §5 列明的 `decision_chain/scope/status`）；② hook 只在 `updateParticle` 触发，`createParticle` 不触发（建档不沉淀）；③ 部署后无命中窄字段的变更 → 0 条。C2 覆盖低是 C3 不触发的连带后果。

---

## §1 硬约束（红线）

| 红线 | 说明 |
|---|---|
| 禁 DELETE | 存量归档/回填一律 `archived=true` 软删或 UPDATE；P5 apply 全程 0 条 DELETE |
| 不破坏多租户隔离 | U4 放开记忆页视图**仍按 scopeTenant 隔离**；admin/sysadmin 传 `null`=全局，ten_admin 按 `me.tenantId`；禁止读侧回退 system |
| 配置化 | 沉淀字段集走 `config_store['memory-precipitate-rules']`；代码内只是出厂缺省，禁硬编码行业字面量 |
| 三重防雪崩 | 价值闸 + 字段闸（同值不写）+ 24h 去重窗；不得为"多沉淀"而削弱任一闸 |
| 不改 context-routing | `config_store['context-routing']` 与 `src/context/routing.js` 禁止修改 |
| 不改已验证投影 | C7 四段式只加字段不删字段，本 Sprint 不动 `projectDecisionMemory` |

---

## §2 任务分解（含生命契约）

### Task A · C3 字段集拓宽 + 创建即沉淀
```contract-yaml
- task: "C3 记忆自动沉淀：拓宽字段集并覆盖创建事件"
  agent: intake-router
  contract_task_id: ct-intake-route
  skills: [method-intake-routing, data-particle-read]
  memory: [intake-router, followup-agent]
  knowledge_scope: { layers: [L1, L2], maxHops: 3 }
  success: "data-particle-update 改 CRM_DEAL.stage 后 memory_log 新增 1 条 tenant_id=本租户且 entity_id=客户id 的 fact；createParticle(CRM_DEAL) 后新增 1 条 created 事实；同值 24h 内重复 0 条；规则缺失/关闭时 0 条"
```
**契约说明**：由 `intake-router` 承接，调用 `method-intake-routing`/`data-particle-read`、读 `intake-router`/`followup-agent` 记忆；成功判定为自动沉淀生效、去重与白名单有效、锚点按客户优先口径解析。

**改动点**
1. `src/memory/precipitate.js` `DEFAULT_RULES` 对齐设计 §5：
   - `CRM_DEAL` fields 扩为 `['stage','amount','owner','expected_close_date','close_date','status','decision_chain','scope']`，增 `created` 主题处理新建。
   - `CRM_ACCOUNT` 增 `tier`/`business_tier`/`named_owner`（对齐设计 §5.2 表）。
   - `CRM_CONTACT` 增 `decision_power`。
   - 新增 `CRM_QUOTATION`（fields `amount/discount_rate/status`）、`CRM_CONTRACT`（fields `status/amount`）、`CRM_APPROVAL_FLOW`（fields `status`）域，topic 分别为 `quote:change`/`contract:change`/`approval:change`。
2. `src/particles/particleRepo.js` `createParticle` 尾部挂 `precipitateFromParticleWrite(p, null, {...})`（建档=事实，`explicit:true`，去重窗豁免——设计 §5.2 表#1「建档必记」）。`before=null` 时 `diffFields` 对新建实体全字段视为新增（仅取规则声明字段），生成 `created` 事实。
3. `precipitateFromParticleWrite` 对 `before=null` 增加 `created` 分支：payload 加 `changeType:'created'`，summary 文案「创建 <type>」。

### Task B · U4 记忆页放开租户视图
```contract-yaml
- task: "U4 记忆页：从 sysadmin-only 放开为租户视图（scopeTenant 隔离）"
  agent: review-gate
  contract_task_id: ct-review-gate
  skills: [method-review-gate, data-particle-read]
  memory: [review-gate, intake-router]
  knowledge_scope: { layers: [L1, L2], maxHops: 4 }
  success: "业务租户(非 admin)登录后 GET /api/memory 仅返回本租户记忆、跨租户不可见；admin 传 ?tenant= 可收窄；tenant_id 隔离断言通过、无 system 回退泄漏"
```
**契约说明**：由 `review-gate` 承接；成功判定为记忆页对业务租户返回本租户数据且严格隔离。

**改动点**
1. `src/portal/memoryConfig.js` `handlers.get`：当前 `isMemoryViewer` 闸之后 `scopedTenant = isTenantAdmin ? me.tenantId : null`。改为：`if (!me?.ok) return forbid`；`const viewer = isMemoryViewer(me.role)`；非 viewer → forbid；`scopedTenant = (me.role==='admin'||me.role==='sysadmin') ? (query.tenant||null) : (me.tenantId||'system')`（业务用户/租户管理员按自身租户，admin 可 `?tenant=` 收窄，绝不回退全量 system 污染）。
2. `listLogs/listNotes/listSnapshots` 已支持 `tenantId` 参数；`listPrecedents` 保持全局（无 tenant_id 列）。
3. `src/web/memory.html` 文案同步放开表述。

### Task C · P4 排程 + P5 存量 apply
```contract-yaml
- task: "P4 治理闭环排程与 P5 存量回填 apply"
  agent: review-gate
  contract_task_id: ct-review-gate
  skills: [method-review-gate, data-particle-read]
  memory: [review-gate]
  knowledge_scope: { layers: [L1, L2], maxHops: 4 }
  success: "memory-loop-closed.mjs 可加入夜批；memory-backfill.mjs --step=anchor --step=project --apply 执行后锚点覆盖率从 2.5% 提升且 0 条 DELETE；health-check 退出码 0"
```
**契约说明**：由 `review-gate` 承接；成功判定为巡检可复跑、阈值配置化、自愈严守禁删红线、存量回填只 UPDATE。

**改动点**
1. 新增 `scripts/memory-nightly.sh`（或文档化 cron 条目）：`node scripts/memory-health-check.mjs --json >> logs/mem-health.jsonl && node scripts/memory-loop-closed.mjs`（夜批接入，缺口累积→达阈值产 pending-review 提案）。
2. `scripts/memory-backfill.mjs --step=anchor --step=project --apply`：
   - `anchor`：按 `topic='decision:<id>'` 回查 `crm.decision.involved_entities` 补 `entity_id`/`entity_type`（S3）。
   - `project`：对存量 `decision` 表跑 C7 投影重放，生成新记忆（标 `rebuilt:true`），旧空壳置 `archived`（S4，幂等可重跑）。
   - 全程 0 条 DELETE（已修 UUID=text 强转 bug，违约即中止）。

---

## §3 验收

| 层 | 用例 | 断言 |
|---|---|---|
| 单测 | `shouldPrecipitate` 字段集 | 改 `status`/`decision_chain`/`scope` 均 `ok:true`；`CRM_QUOTATION` 改 `discount_rate` `ok:true` |
| 单测 | `diffFields` 新建分支 | `before=null` 时声明字段全视为新增（生成 created 事实） |
| 集成 | `createParticle(CRM_DEAL)` | `memory_log` 新增 1 条 `kind=fact`、`topic=deal:created`、`entity_id=客户id`、`tenant_id=本租户` |
| 集成 | `data-particle-update` 改 stage | 新增 1 条 `deal:field-change` 事实 + 24h 同值 0 条 |
| 集成 | 业务租户 `GET /api/memory` | 仅本租户；admin `?tenant=` 收窄；跨租户 0 泄漏 |
| 回归 | 全量 | `test/memory` + `test/particles` + `test/portal` + `test/web/memoryConfig` 全绿 |
| 运营 | `memory-backfill --apply` | 锚点覆盖率↑、0 DELETE；`health-check` 退出码 0 |

## §4 风险与回滚

| 风险 | 缓解 / 回滚 |
|---|---|
| C3 字段集拓宽导致沉淀量上升 | 三重防雪崩（价值闸+字段闸+24h 去重窗）已就位；`memory-precipitate-rules` 可配置关闭单域。回滚=还原 `DEFAULT_RULES` 出厂值 |
| U4 放开记忆页暴露跨租户 | 严格 `scopeTenant` 隔离；回滚=还原 `handlers.get` 为 `isTenantAdmin` 原逻辑（仍比 sysadmin-only 宽，若需更严可改回 sysadmin-only） |
| P5 回填大批量 UPDATE | `--dry-run` 默认开启、分批、只 UPDATE；回滚=无（UPDATE 可逆，且标 `rebuilt`/`backfilled` 可追溯） |
| 全部改动零语义变更 | 回滚成本极低（删新增行/还原函数即可），不影响 C1/C2/C5/C7/C8/C4/U1 已验证路径 |

## §5 待办与未决

1. **R7 先例自锁（独立子立项）**：生产 32.8% HUMAN 未确认，按 `customer-memory-writeback-design.md §4` 走 B/C 独立立项（扩收 HUMAN 经 HITL 确认后入池），不在本 Sprint。
2. **U3 rrfSearch** 已删，不做。
3. **P5 历史噪声**：S1 噪声已随蒸馏 TTL 自然归档（631,616→3,222），无需再跑；若残余 trace 复发由 P4 巡检捕获。

*设计文档 · 证据驱动，所有结论附源码 file:line 与生产库只读查询；遵循 brainstorming → writing-plans → 实施流程。*
