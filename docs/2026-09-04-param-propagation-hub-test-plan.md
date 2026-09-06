# 参数传播中枢 — 测试计划（TDD 先行）

> 派生自 `docs/2026-09-04-param-propagation-hub-design.md` 与 `docs/2026-09-04-param-propagation-hub-plan.md`
> 状态：**开发前置测试计划**（先于实现；实现严格按设计文档，不得任意修改）
> 铁律复用：TDD（先写失败测试 → 实现 → 通过 → 每 Task 一 commit）；零信任（写必须经决策第 0 闸）；绝对禁 DELETE（写用 upsert）；per-tenant 隔离优先。

---

## §1 测试目标与不可妥协的断言（gates）

以下断言**每条测试都必须满足**，违反即判回归（fail-closed）：

1. **决策第 0 闸命中**：所有经 `acceptSuggestion` / `broadcastConfig`(HTTP) / `promoteMemoryToTenant` / `promoteSkill`(tenant→system) 的写操作，测试中必须断言 `requireDecision` 被调用且仅调用一次（或经 `requireDecision` 取得 `decision_id` 后落库）。
2. **绝对禁 DELETE**：源码 grep 扫描 `src/` 传播相关模块不得出现 `DELETE FROM` / `.delete(` 物理删除（迁移脚本除外，且仅 `ADD COLUMN`/`CREATE TABLE`，无 `DROP`）。CI 级断言：`grep -rn "DELETE FROM" src/config/broadcast.js src/memory/promote.js src/http/propagationRoutes.js src/decision/prescription.js` 必须为空。
3. **per-tenant 隔离**：跨租户记忆推广必须 `rejects`，错误含 `租户不匹配|tenant mismatch`；`broadcast fill-only` 不得覆盖已定制租户。
4. **幂等迁移**：每个 `db/migrate*.js` 可重复执行不报错（全部 `IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`）。
5. **可回退**：`config_store` 变更通过"写回旧值的新决策"回退，无物理删除（accept 测试须验证 `propagation_action` 留痕 status=accepted 且含 `decision_id`）。

---

## §2 测试分层与工具链

| 层 | 工具 | 用途 | 是否依赖真实 PG |
|---|---|---|---|
| **单元测试**（纯函数/逻辑） | vitest + fakePool 桩 | `measureClusterMetrics` / `prescribe` / `broadcastConfig` / `promoteMemoryToTenant` / `promoteSkill` / `requireRole` | 否（用内存桩拦截 `query`） |
| **路由/编排测试** | vitest + `__setDeps` 注入 | `acceptSuggestion` 经 `requireDecision`+`writeConfig` 落库；broadcast 角色闸 | 否（桩掉决策/写配置） |
| **集成测试**（全链路） | vitest + 真实 `pool` | retro→候选→accept→`loadPrecedentConf` 回读 0.4；待办批准即生效 | **是**（crm_native_test @5433） |
| **迁移测试** | `node db/migrate*.js` 跑两次 | 幂等 | 是 |

**运行环境（按 binary_context 强制）**：
- Node：托管版 `C:\Users\wangchuan08\.workbuddy\binaries\node\versions\22.22.2-2\node.exe`（优先）。
- 依赖安装隔离：仅当 `node_modules/vitest` 缺失时，于托管 workspace 安装：`cd C:\Users\wangchuan08\.workbuddy\binaries\node\workspace && <node> install vitest`。
- 跑单测：`npx vitest run test/propagation` / `test/decision` / `test/calibration`。

**fakePool 桩约定**（源自 plan 各 Task 测试）：拦截 `query(sql,args)`，按 SQL 子串返回 `rows`。`broadcast.test.js` 用 `DISTINCT tenant_id` 返回租户枚举、`FROM crm.config_store WHERE tenant_id=$1 AND key=$2` 探测已存在；`promote-memory.test.js` 用 `FROM crm.memory_log WHERE id=$1` 取记忆；`routes.test.js` 用 `__setDeps` 注入 `requireDecision`/`writeConfig`。

> **关键约束**：`db.js` 导出约定以 `src/db.js` 实际为准（计划引用 `query`/`queryWrite`/`pool`）。实现前先 Read 确认，测试 import 路径随之对齐，**不得臆测**。

---

## §3 测试执行顺序（严格 red-green，对应 plan Task 0–12）

每个 Task 内部遵循：① 写失败测试（RED）② 实现 ③ 跑测试（GREEN）④ commit。Task 间依赖：

```
Task 0 (measureClusterMetrics + 报告补列)
  └─ Task 9 (prescription.js) 依赖 §12.1 槽位命名 → 可并行起步
Task 1 (DDL 迁移: memory_log.tenant_id + tenant_precedent + skill_scope.tenant_id + propagation_action)
  ├─ Task 2 (broadcast.js)        [依赖 configStore.writeConfig/readConfig、emit]
  ├─ Task 3 (promote.js)          [依赖 Task1 表 + emit]
  ├─ Task 4 (skillScope tenant轴)  [依赖 Task1 列]
  ├─ Task 5 (retro knob=config_store + tenant_id)
  ├─ Task 6 (propagationRoutes + 第0闸) [依赖 T2/T3/T4/T5]
  ├─ Task 7 (propagation-hub.html + 接线) [依赖 T6]
  ├─ Task 8 (集成测试)            [依赖 T0–T7 + 真实PG]
  ├─ Task 10 (权限重分组 + rbac)   [依赖 T6 broadcast 已 ADMIN]
  ├─ Task 11 (整改报告结构化)      [依赖 T0 指标 + T5/T9]
  └─ Task 12 (ADMIN 待办闭环)      [依赖 T5/T9/T11 + calibration_patch]
```

执行顺序建议（最长依赖链先行）：**T1 → T0/T9（并行）→ T2 → T3 → T4 → T5 → T6 → T7 → T10 → T11 → T12 → T8（集成，最后）**。

---

## §4 每 Task 测试清单（断言级）

| Task | 测试文件 | 关键断言（RED→GREEN） | 验收 |
|---|---|---|---|
| **0** | `test/propagation/measure-metrics.test.js` | `measureClusterMetrics(cluster,{minSimilarity})` 产出 `precedent_recall`/`major_deviation_rate`/`unusable_rate`/`dim_missing_rate`/`upgrade_rate` 五槽位且 ∈[0,1]；`precedent_recall` 计算正确（used/(used+missing)） | 五槽位全覆盖；报告落库含 `config_snapshot`+`tenant_id` |
| **1** | `db/migrate-propagation.js` 跑两次 | 打印 done 两次无错；`\d crm.tenant_precedent` 存在；`memory_log.tenant_id` 列存在 | 幂等；4 张/列全部就位 |
| **2** | `test/propagation/broadcast.test.js` | `fill-only` 仅写未定制租户（`written=['t-b']`,`skipped=['t-a']`）；`override` 写全部；非法 `mode` 抛错 | 2/2 PASS；禁 DELETE 扫描通过 |
| **3** | `test/propagation/promote-memory.test.js` | 同租户提升成功且 `memory_id` 溯源；跨租户 `rejects /租户不匹配/`；`listTenantPrecedents` 返回 1 行 | 2/2 PASS；红线（限本租户）生效 |
| **4** | `test/propagation/skill-promote.test.js` | `from=tenant→to=system` 写 system 行且 `promoted_from='tenant:t-a:method-x'`；缺 `tenantId` 抛错；旧 `user` 分支回归 | 2/2 PASS；旧 skillScope 测试不回归 |
| **5** | `test/propagation/retro-knob.test.js` | `runDecisionRetro` 产 `knob='config_store'` 且 `target='precedent-conf.minSimilarity'` 且 `tenant_id='t-a'` 的 draft_patch | PASS；knob 枚举含 config_store |
| **6** | `test/propagation/routes.test.js` | `acceptSuggestion(config_store)` → `requireDecision` 调用 1 次 + `writeConfig` 调用 1 次；返回 `ok` | PASS；第0闸 + upsert 经注入验证 |
| **7** | 手动冒烟 / `test/propagation/routes.test.js` 复用 | 页面四 Tab 渲染；`/api/propagation/suggestions` 返回候选；`accept` 后前端提示决策 id | 页面可加载；接线无 500 |
| **8** | `test/propagation/integration.test.js`（真实 PG） | `runDecisionRetro` 产 config_store 候选 → `acceptSuggestion` → `loadPrecedentConf({tenantId}) .minSimilarity===0.4` | 全链路即时生效（无需重启） |
| **9** | `test/decision/prescription.test.js` | `prescribe` 0.45→0.40、step=-0.05、risk=LOW、`predicted_impact.to_est≈0.22`；`cur=0.32` 触 floor 夹回 `to=0.30` risk=MEDIUM | 两断言 PASS；覆盖 §12.3 全分支 |
| **10** | `test/propagation/permission.test.js` | 系统级非 ADMIN→false；三角色→true；tan_admin 限本租户；broadcast 非 ADMIN→403 | 全部 PASS；角色闸串行于决策闸前 |
| **11** | `test/decision/rectification.test.js`（真实 PG 或注入） | `runDecisionRetro` 报告 `rectification` 含 `daily_ops/problems/prescriptions` 三段落；`prescriptions[0]` 含 `target/from/to` | 三段落齐全；daily_ops 聚合正确 |
| **12** | `test/calibration/todo-loop.test.js`（真实 PG） | `createPatch(config_store)` → 落 ADMIN 待办 → `approvePatch` 后 `readConfig('precedent-conf').minSimilarity===0.4`；`before===0.45`；重复 createPatch 同 target 去重 | 批准即生效；幂等去重 |

---

## §5 合规性专项测试（gates 落地）

独立于功能测试，额外两类"护栏测试"：

1. **零信任闸测试**：`routes.test.js` 中 `acceptSuggestion` 必须 spy `requireDecision` 且断言调用次数=1；`broadcast` 路由非 ADMIN（role=sysadmin）必须 403（Task 10）。
2. **禁 DELETE 静态扫描**：在 `test/propagation/no-delete.test.js` 用 `fs.readFileSync` 读取传播模块源码，断言不包含 `DELETE FROM crm.`（迁移文件排除）。提供 fail-closed。
3. **迁移幂等测试**：`test/db/migration-idempotent.test.js` 连真实 PG 跑 `run(pool)` 两次，第二次不得抛错。

---

## §6 已知风险与 flaky 处理（按项目记忆）

- **PG 不稳**：集成/待办/整改测试（T8/T11/T12）依赖真实 `crm_native_test@5433`。按项目铁律「单次红不得直判回归」——PG 连接超时导致的红，须先 `SELECT 1` 探活重试，再判定。
- **决策第 0 闸副作用**：集成测试若真实 mint decision 会写 `crm.decision`，用 `__setDeps({requireDecision: async()=>({decision_id:'TEST-D'})})` 隔离，避免污染。
- **`db.js` 导出差异**：若项目用 `queryWrite` 而非 `pool.query`，测试桩与实现同步改用；以 Read 实际为准。
- **LLM 依赖**：`runDecisionRetro` 测试通过注入 `llmFactory` 返回固定处方，不调真实 LLM；`degraded` 路径由 `prescribe` 纯函数补位（§12.6）。

---

## §7 交付与 commit 纪律

- 每 Task 一 commit，消息前缀 `feat(propagation):` / `test(propagation):`（严格按 plan 各 Task 末尾命令）。
- **绝不 `git add -A`**：仅 `git add` 本 Task 显式路径（脚本由本 agent 提供 PowerShell 命令，用户在本地执行；沙箱无 git 凭证，AI 不 commit）。
- 全量自检：`npx vitest run test/propagation test/decision/prescription.test.js test/calibration/todo-loop.test.js` 全绿后，再 `git status --short` 确认仅相关文件改动。
- 集成/待办/整改三类真实 PG 测试单独跑、单独标注，避免与单元红混淆。

---

## §8 出口标准（Definition of Done）

1. 所有单元/路由测试（T0–T7、T9、T10）全绿，无 DELETE 扫描通过。
2. T8/T11/T12 在真实 PG 探活重试后全绿（或明确标注 flaky 根因=PG 不稳，非代码缺陷）。
3. `config_snapshot`/`tenant_id`/`rectification`/`assignee` 列就位；`calibration_patch.knob` 含 `config_store`。
4. 端到端演示：02:00 复盘 → 产 minSimilarity 0.45→0.40 定量处方 → 落 ADMIN 待办 → 批准 → `loadPrecedentConf` 次日即时读到 0.40。
5. 全部变更按 Task 分组 commit，零信任/禁删/隔离断言均绿。
