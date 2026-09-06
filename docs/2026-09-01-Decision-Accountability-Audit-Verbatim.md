# 决策问责体系统一设计 · 逐字逐 Task 接线审计总表（2026-09-01 深夜补充审计）

> 审计基准：`docs/2026-09-01-decision-accountability-unified-design.md`（唯一批准目标）§0.4 执行顺序 / §6 实施计划（T0–T8 + A-T1–A-T7）/ §12 交付确认
> 审计方法：**逐字逐 Task**，每个 Task 核四列 —— ①代码存在（模块）②生产调用点（接线，不止存在性）③测试证据（测试文件：用例数）④接线状态判定
> 生产库事实基准：`crm_native`（用户明确"换数据库了，crm-native"；2026-09-01 直查）
> 结论先行：**设计文档 Phase 0–5 全部 Task 代码层均存在；接线层本次审计发现并修复 1 处 P0 断链（assembleContextV2 从未进生产决策创建）+ 3 处装配器契约适配缺陷（S2/S3/S4 degraded 根因）+ 2 处快照 query_text 线缝（写侧取错字段 + 读侧漏列）**。§12「9/9 快照 33.3% 供给」的「9/9」是旧库 plm 迁移残留，crm_native 真实快照 12 行、runtime 边 1 条。

---

## §0 执行摘要

| 结论 | 判定 | 证据 |
|---|---|---|
| 设计文档 **14 个 Task（T0–T8 + A-T1–A-T7）全部有代码实现** | ✅ | 逐 Task file:line 见 §1 |
| **但「有代码」≠「已接线」**：assembleContextV2 原先只挂在调试端点（routes.js:2089/2114），生产决策创建从不触发 | 🔴 已修 | §2-1 |
| **接线后真实装配暴露 3 处模块契约适配缺陷**（S2 向量炸 / S3/S4 返回形态错）→ 生产快照曾 9/9 全 degraded | 🔴 已修 | §2-2~2-4 |
| **运行时实证：createDecision → 自动装配 → 快照落库 → context_snapshot_id 回写，链路真通** | ✅ | §3 |
| **快照 `query_text` 线缝 2 处**：写侧取 `input.query_text`（签名只收 `query`）+ 读侧 SELECT 漏列 | ✅ 已修（写侧 ctx.query 双取 + 读侧补列） | §2-5 |

---

## §1 逐 Task 审计总表（设计 §6 + §12）

### Phase 0 — 数据可信度隔离

| Task | 设计目标 | 代码存在 | 生产调用点（接线） | 测试证据 | 判定 |
|---|---|---|---|---|---|
| **T0** | 边来源口径隔离 `edgeSource.js` + `listTypedEdges({runtimeOnly})` + 双口径展示 + 零 DELETE | ✅ `src/decision/edgeSource.js`（`DEMO_EDGE_SOURCES`/`isDemoEdgeSource`）；`relation.js:78 runtimeOnly` | ✅ 被 `snapshotStore.js:5`（供给健康边口径）+ `routes.js:2062`（/api/monitor/supply-health）调用 | `test/edge-caliber*.test.js`（edgeSource 双口径） | ✅ 已接线 |
| **T1** | BG-01a 注入层消费 `rationale`/`memories`（`clip`） | ✅ `src/context/injector.js:45-68`（clip 纯函数） | ✅ `agentLoop.js` prompt 构建调用 injector | A1–A5（设计 §3.1 验收） | ✅ 已接线 |
| **T8** | BG-01b 叙事时间线进注入层 + BG-08 `COALESCE(decided_at,created_at)` 时间基准统一 | ✅ `timelineSource.js:11`（DECISION_TIME_BASIS 单一事实源） | ✅ 叙事时间线(:75)/L2装配(:75)/先例列表(`insightService.js:244`)三处均引用 | F1–F4（设计 §3.8 验收） | ✅ 已接线 |

### Phase 2 — 边完整性

| Task | 设计目标 | 代码存在 | 生产调用点（接线） | 测试证据 | 判定 |
|---|---|---|---|---|---|
| **T2** | BG-06 `mirrorEdge` 留痕（三重留痕 + fail-open） | ✅ `src/decision/edgeWrite.js` | ✅ `decisionRepo.js:10` import + `:145-150` DECIDED_ON 权威写 | F1–F4 | ✅ 已接线 |
| **T3** | BG-02 `OVERRIDES` 接权威表 `linkDecisions` | ✅ `decisionRepo.js:330` 经 `linkDecisions` 落 `decision_relation` + AGE 双写 | ✅ 写时触发（linkDecisions 调用点） | B1–B4 | ✅ 已接线 |
| **T4** | BG-05a `WRITABLE_EDGES` + S20 装弹自检闸门 + `scripts/probe-edge-writability.mjs` | ✅ `relation.js` WRITABLE_EDGES + `scripts/probe-edge-writability.mjs`（b76c15b 已入库） | ✅ 只读台账脚本 | E1–E2 | ✅ 已接线 |
| **T5** | BG-03 结构扩容 → **已结案方案 B**（`to_id` 无 FK，无新表） | ✅ 方案 B 落地（`to_id` 放宽实测 + 写入点 `decisionRepo.js:117-209`） | ✅ 生产 backfill 11 边验证（crm_native `backfill` 来源现 11 条） | C1–C6 | ✅ 已接线 |
| **T6** | BG-03b 写入点补齐（DECIDED_ON/DERIVED_FROM_EXCEPTION） | ✅ `decisionRepo.js:117-209` | ✅ `createDecision` 主链路 + `@1fd712f` D4 | C1–C2 | ✅ 已接线 |
| **T7** | BG-05b 误报清零（`hasRealEdgeMissing` 守卫） | ✅ `relation.js`/`closure.js` `hasRealEdgeMissing` | ✅ 误报检测调用点 | E3–E6 | ✅ 已接线 |

### Phase 3 — 供给架构

| Task | 设计目标 | 代码存在 | 生产调用点（接线） | 测试证据 | 判定 |
|---|---|---|---|---|---|
| **A-T1** | `supplySpec.js`（S1–S7 + `validateSupplySpec` + 配置覆盖 fail-safe） | ✅ `src/context/supplySpec.js`（72 行） | ✅ `assembleContextV2.js:12` import（DEFAULT_SUPPLY_OPS）+ `:90` 覆盖判定 | `test/context/supply-spec.test.js` | ✅ 已接线 |
| **A-T2** | schema 迁移（独立 `CREATE TABLE decision_context_snapshot` + 独立 `ALTER ... ADD COLUMN context_snapshot_id`） | ✅ `db/schema.sql` + `db/migrate.js`（独立段，幂等） | ✅ crm_native 已应用（10+1 快照行实测） | 直查 `information_schema` | ✅ 已接线 |
| **A-T3** | `assembleContextV2` 接线 5 模块 + `Promise.allSettled` + 200ms 超时 | ✅ `src/context/assembleContextV2.js:134-181`（5 模块：searchPrecedents/detectConflicts/ruleEngine/buildTimelineRows/trackEntry 全接线） | 🔴 **P0 断链已修**：原只挂 routes.js:2089/2114 → 已插 `decisionRepo.js:105-123` 生产决策创建主链路 | `test/e2e-decision-accountability.test.js` 2/2（本会话新增） | ✅ 已接线（修复后） |
| **A-T4** | `snapshotStore` 落库 + `prompt_hash` + S7 操作级 PROV-O | ✅ `src/context/snapshotStore.js`（getDecisionContextSnapshot 篡改自检 + getPlatformSupplyHealth 聚合） | ✅ 快照 INSERT + `UPDATE decision SET context_snapshot_id`（assembleContextV2.js:164-165）+ 前台 `/api/monitor/supply-health` | e2e 2/2（读回 hash OK + 供给健康） | ✅ 已接线（修复后） |
| **A-T5** | `formatForPromptV2` 分层注入（事实/叙事/规则/先例四段） | ✅ `assembleContextV2.js:98-125`（四段带 source） | ✅ `assembleContextV2` 内联（promptBlock 生成） | e2e（prompt_hash 断言） | ✅ 已接线 |

### Phase 4 — 前台三层一屏

| Task | 设计目标 | 代码存在 | 生产调用点（接线） | 测试证据 | 判定 |
|---|---|---|---|---|---|
| **A-T6** | `sales-decision-monitor.html` 重构（1682→**2026 行**，未达 ≤1200 但三层已成立）：Layer0 双口径健康头 / Layer1 清单 / Layer2 五页签（②当时的上下文 + ⑤7×7 回跳） | ✅ 2026 行实测；Layer0 三卡 `:329` / 7×7 回跳 `:1053,1099` / 巡检卡 `:1379,1424` / 页签② `:461-473` | ✅ `routes.js:2062,2446` API 供数（supply-health + auditability） | 前台 md5 与磁盘一致（三层标记存在） | ✅ 已接线（行数未达 ≤1200，见 §4-4） |

### Phase 5 — 真实数据验收

| Task | 设计目标 | 代码存在 | 生产调用点（接线） | 测试证据 | 判定 |
|---|---|---|---|---|---|
| **A-T7** | 清理 7 条 seed 边 `props.demo=true` 软标记（零 DELETE）+ 真实场景回路验收 | ✅ `scripts/seed-edge-demo-mark.mjs`（b76c15b）+ `relation.js:78 runtimeOnly` | ✅ 双口径实测：边 19 = seed-script 7（demo）+ backfill 11 + engine 1（runtime）→ **演示不计入分母** | e2e A-T7 用例 + supply-health 实测 | ✅ 已接线（runtime 仅 1 条 = 真实缺口暴露，非假绿） |

### D4 智能体接线（独立设计文档，§12 同步）

| Task | 设计目标 | 代码存在 | 生产调用点（接线） | 测试证据 | 判定 |
|---|---|---|---|---|---|
| **D4** | 决策复盘智能体接线：SKILL 取值链 + retro 路由 + contractIds 五键 + registry | ✅ `agentLoop.js:63-66` 取值链 + `scheduler.js:28/46/52` + `contractIds.js` 五键 + `skills/decision-retrospective/registry.json` | ✅ 生产库五契约键真实 episode（30 天窗口内） | `test/retro-wiring.test.js` + 回归 5 文件 39 例全绿 | ✅ 已实施并验证（独立文档 §8） |

---

## §2 本会话审计发现并修复的缺陷（接线层，非模块存在性）

### 2-1 【P0 断链】assembleContextV2 从未进生产决策创建（已修）

- 证据：`grep -rn "assembleContextV2" src/` 修复前唯一调用点是调试端点 `routes.js:2089/2114`（`/api/decision/:id/context-reassemble`）。
- **生产决策创建路径（`createDecision`）从不调用** → 7×7 快照永远空盒（crm_native 直查曾 0 快照）。
- 修复：`src/decision/decisionRepo.js:100-123` 决策落库后自动 `assembleContextV2`（fail-open：装配失败仅 emit trace + recordFailure，不阻断决策本身）。

### 2-2 【S2 契约缺陷】searchPrecedents 传 null 向量 → pgvector 炸（已修）

- 证据：生产快照 `ops` 里 S2 `status=degraded, note="invalid input syntax for type vector: \"null\""`。
- 契约（`decisionRepo.js:284`）：`searchPrecedents(scenario_id, qvec, {k,minSimilarity})`，qvec 必须向量字面量。
- 修复：`assembleContextV2.js:57-59` 用 `buildDecisionEmbedding({scenario_id, trigger_context})` 生成确定性向量替代 null。
- 复测：S2 `empty`（无相似先例时诚实 empty，不再炸）。

### 2-3 【S3 契约缺陷】detectConflicts 返回对象被当数组消费（已修）

- 证据：生产快照 S3 `degraded, note="(cf || []).map is not a function"`。
- 契约（`conflict.js:41`）：返回 **对象** `{assertions, hasConflict, needsReview}`（不是数组）。
- 修复：`assembleContextV2.js:62-64` 按 `cf?.assertions` 消费 + `status_hint`。
- 复测：S3 `empty`（无断言时诚实 empty）。

### 2-4 【S4 契约缺陷】ruleEngine.check 三参调用 + 当数组消费（已修）

- 证据：生产快照 S4 `degraded, note="(hits || []).map is not a function"`。
- 契约（`ruleEngine.js:101`）：`check(type, action, patch, ctx)` 四参，返回 **对象** `{ok, reasons}`（不是数组）。
- 修复：`assembleContextV2.js:65-67` `('CRM_DEAL','context-assembly', trigger_context, {decision_id})` + `.reasons` 消费（违规转 items，ok 时 empty）。
- 复测：S4 `empty`。

### 2-5 【快照 `query_text` 线缝 2 处】恒 NULL → 已修（2026-09-02）

- **写侧**：`assembleContextV2.js:172` 落 `input.query_text`，但签名 `assembleContextV2(input)` 只收 `input.query`（decisionRepo 调用传 `query`）→ query_text 恒 NULL。
- **读侧**：`snapshotStore.js:11-12` SELECT 列清单**漏 `query_text`**（有 token_est 无 query_text）→ 即使落库成功，读回也是 undefined。
- 修复：写侧 ctx 增加 `query: input.query || input.query_text || null`，SQL 取 `ctx.query`；读侧 SELECT 补 `query_text`。
- 影响面：Layer2 页签②「当时的上下文」如果要展示 query_text，之前恒空——现已通。
- E2E 护栏用例断言 query_text 落库（`expect(snap.query_text).toBe('真实实体路径契约护栏')`）。

---

## §3 运行时实证（决定性：接线真假不靠断言，靠真实链路）

```
命令：真实 createDecision（OPP_QUALIFY, policy_version=null 避开 FK，involved_entities 含 CRM_ACCOUNT）
结果：
  decision_id   : 0e8b3f9f-9eb4-4f19-a967-26d0f7275edc
  快照落库       : 45e044aa-72a1-4c05-b463-f603848b0a2d（INSERT crm.decision_context_snapshot 成功）
  supplied_dims : 2（identity + structure，来自 S1 实体结构 hit）
  degraded      : false（S2/S3/S4 修复后不再炸）
  context_snapshot_id 回写：45e044aa…（UPDATE crm.decision 生效，DB 权威值正确）
  createDecision 返回值 context_snapshot_id=null 属正常（RETURNING 先于装配，以 DB 为准）
```

**结论：P0 接线 + 三契约适配后，决策创建 → 7×7 装配 → 快照落库 → 回写 → Layer0 供给健康，链路真通。**

生产库现状（2026-09-01 直查 crm_native）：

| 指标 | 值 | 说明 |
|---|---|---|
| decision | 12 条 / **12 条已回写** context_snapshot_id | 100% 回写（含 2026-09-02 线缝验证探针 2 条） |
| decision_context_snapshot | 12 行 | 含线缝验证探针 2 行，query_text 已非 NULL |
| decision_relation | 19 条 = seed-script 7（demo）+ backfill 11 + engine 1（runtime） | 双口径分离，演示不计分母 |
| 旧库 plm | §12「9/9 快照 33.3%」为旧库迁移残留 | 现以 crm_native 为准 |

---

## §4 逐字审计结论（对应 §12 交付确认逐条核对）

| §12 条目 | 设计陈述 | 逐字核对结果 |
|---|---|---|
| §8 七项裁决闭环 | Q1 结构=方案 B / Q2 ③ / Q3 ② / Q4 ② / Q5 软标记 / Q6 多租户 / Q7 调试鉴权 | ✅ 全部闭环（Q4 时间基准=已落地 timelineSource:11；Q6 快照多租户=待增量 Phase，非本批准范围） |
| D4 接线 | 独立文档收口 | ✅ 已实施并验证（§1 D4 行） |
| **Phase 0–5 实施且真实数据通过** | 「9/9 决策快照、供给 33.3%」 | ⚠️ **措辞需修正**：9/9 是旧库 plm 迁移残留；crm_native 真实快照 12 行（12 决策全回写 + 探针），runtime 边 1 条 = **真实缺口诚实暴露**（这正是双口径设计目的）。§12 的「9/9」应更新为「12 快照 / runtime 边 1 条 / 供给 2/7 起」 |
| 前台三层一屏 | 1682→≤1200 行 | ⚠️ **实测 2026 行**，未达 ≤1200 硬指标；但三层结构（Layer0 双口径健康头 :329 / Layer1 清单 / Layer2 五页签+7×7 回跳 :1053,1099）已成立。行数超标是设计目标偏差，功能未达标 | 
| 测试覆盖面 | 「已实施并验证」 | ⚠️ **E2E 曾漏抓 S2/S3/S4 degraded**（测试用 entities:[] 走 empty 分支，掩盖了真查询路径的契约缺陷）→ 本会话补 `test/e2e-decision-accountability.test.js` **3/3**（含生产形态装配契约护栏：真实 entities 断言 S2/S3/S4 不 degraded + query_text 落库） |

---

## §5 后续红线（状态更新 2026-09-02）

1. **【已修】query_text 线缝**：写侧 ctx.query 双取 + 读侧 SELECT 补列（§2-5），生产库实证 query_text 非 NULL，E2E 护栏断言通过。
2. **【已修】E2E 契约护栏**：`test/e2e-decision-accountability.test.js` **3/3 全绿**（真实 entities 断言 S2/S3/S4 不 degraded + query_text 落库）。防 S2/S3/S4 契约漂移回潮的回归护栏已就位。
3. **【待办】提交**：本会话改动 = `src/context/assembleContextV2.js`（S2/S3/S4 + query_text 写侧）+ `src/context/snapshotStore.js`（读侧补列）+ `test/e2e-decision-accountability.test.js`（护栏用例）+ `docs/2026-09-01-Decision-Accountability-Audit-Verbatim.md`（状态同步）——用户本地按功能线 `git add <files>` + commit（每 Task 一 commit，不 add -A；注意工作树还有并行会话的 12 个文件改动，勿整树 add）。
4. **【待办】§12 措辞修正**：把「9/9 快照 33.3%」改为 crm_native 实测口径（12 快照 / runtime 边 1 / 供给 2/7），避免文档与生产双态误导（生产库 vs 测试库双态铁律）。
5. **【待办】A-T6 行数**：2026 行 > 1200 目标——三层功能已达标，行数属设计约束偏差，是否压缩另立任务（不阻塞本次验收）。