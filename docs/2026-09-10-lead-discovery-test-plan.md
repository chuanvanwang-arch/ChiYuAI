# 线索自主发现引擎 — 测试计划（TDD 先行）

> **派生自**：设计 `docs/2026-09-10-lead-discovery-design.md`（**v8.1 已批准**：自主循环主轴 + C1/C2/C3 + §12 行业包 handbook 同步）
> **配套实施计划**：`docs/superpowers/plans/2026-09-10-lead-discovery-engine.md`（**21 Task**）
> **状态**：**开发前置测试计划**（先于实现；实现严格按设计文档，不得任意修改设计）
> **铁律复用**：TDD（先写失败测试 → 实现 → 通过 → 每 Task 一 commit）；零信任（一切写必经决策第 0 闸）；**绝对禁 DELETE**；per-tenant 隔离优先；**不新增粒子类型、不改业务域模型**。

---

## §0 范围与派生关系

| 设计章节 | Task | 主测试文件 | 层 |
|---|---|---|---|
| §3 / §3.1（D1 分级） | T1 | `test/config/discoveryRules.test.js` | 单元 + 配置 |
| §3 / C1 | T2 | `test/connectors/discovery/waterfall.test.js` | 单元 |
| §3 / D2 | T3 | `test/connectors/discovery/adapters.test.js` | 单元（桩 HTTP） |
| §5（P0#1） | T4 | `test/agent/discoverySchema.test.js` | 单元 |
| §9.8（三处硬闭包） | T5 | `test/action/discoveryActions.test.js` | 装配 |
| §6.1 / §9.4 | T6 | `test/decision/leadFitScenario.test.js` | 集成（真实 PG） |
| §2②③ + §9.1 | T7 | `test/connectors/discovery/dedupResolver.test.js` + `orchestrator.test.js` | 单元 + 集成 |
| §4 / C2 | T8 | `test/connectors/discovery/research.test.js` | 单元（LLM 注入） |
| §9.3（P0#2） | T9 | `test/memory/discoveryCapture.test.js` | 单元 + 红线 |
| §9.6 | T10 | `test/connectors/discovery/s1Handoff.test.js` | 集成 |
| §8（P0#3） | T11 | `test/evolution/icpSelfEvolution.test.js` | 单元 + HITL |
| §9.11（P0#4） | T12 | `test/feedback/discoveryMetrics.test.js` | 单元 |
| §9.7 | T13 | `test/web/discoveryPage.test.js` + `test/http/discoveryRoutes.test.js` | 路由/页面 |
| §3.2（C1） | T14 | `test/connectors/discovery/orchestrationCompiler.test.js` | 单元 |
| §4（C2） | T15 | `test/agent/glassBox.test.js` | 单元 |
| §6.2（C3） | T16 | `test/connectors/discovery/monitorAccount.test.js` + `test/memory/accountMemory.test.js` | 单元 + 集成 |
| §9.7 | T17 | `test/web/discoveryRulesPage.test.js` | 页面 |
| §9.5 / §9.8 | T18 | `test/mcp/discoveryExpose.test.js` | MCP 面 |
| §9.7 | T19 | `scripts/verify-plugin-zips.py` + `scripts/buddy-capsule-binding-check.mjs` | 打包校验 |
| 四条触点面 | T20 | `scripts/e2e-lead-discovery.mjs` | E2E |
| **§12（新增）** | **T21** | `test/connectors/discovery/industryDiscovery.test.js` + `test/config/industryTemplateDiscovery.test.js` | 单元 + 集成 |

---

## §1 测试目标与不可妥协的断言（gates）

以下断言**每条测试都必须满足**，违反即判回归（fail-closed）：

1. **决策第 0 闸命中**：所有写路径（`discovery-run` / `discovery-enrich` / `discovery-research` / `monitorAccount` 重评分落库 / ICP 草稿落库 / 行业 discovery 配置写入）必须经 `requireDecision` / `gateDecision` 并落 `crm.decision` 行；测试断言调用次数 = 1，且返回体含 `decision_id`。
2. **绝对禁 DELETE**：`src/connectors/discovery/`、`src/action/discoveryActions.js`、`src/memory/accountMemory.js`、`src/connectors/discovery/monitorAccount.js`、`src/evolution/icpSelfEvolution.js` 源码不得出现 `DELETE FROM` / `.delete(` 物理删除。移除类操作一律「数组 drop + 整体 UPDATE」或「append-only」。
3. **per-tenant 隔离**：`mergedDiscoveryRules(tenantId)` 跨租户不可见——A 租户启用 `attio` 后，`mergedDiscoveryRules('B')` 不得含 A 的启用态；`config_store` 读写一律 `(tenant_id, key)` 收敛。
4. **不新增粒子类型**：`src/particles/seed.js` 的 `PARTICLE_TYPES` **零改动**（运行时断言类型数不变 + `git diff --stat` 断言该文件未改）。
5. **三处硬闭包**：`getAction('discovery-run')` 非空 ∧ `assertAgentAssembly().ok === true` ∧ `skills/seed.js` 注册 `lead-discovery`（slug 精确匹配）；三者缺一即 RED。
6. **配置驱动（零硬编码）**：阈值 / 信号权重 / provider 顺序 / 编排 playbooks 100% 来自 `config_store`；`src/connectors/discovery/` 源码 grep 不得出现行业字面量（`化工|培训|医疗|咨询`）与魔法阈值。
7. **`context-routing(id36)` 红线**：`src/context/routing.js` **零改动**（`git diff --stat` 断言）；发现结论仅消费既有 **L2 通道**（§9.3）。
8. **付费源默认禁用**：`mergedDiscoveryRules()` 出厂默认中 Clearbit/LinkedIn 类 provider `enabled === false`；行业 onboarding **不得**启用付费源（T21 专项断言）。
9. **系统租户保护**：对 `tenant_id='system'` 的 discovery 配置写 / 行业 assign 一律 400（沿用行业包既有红线）。

---

## §2 测试分层与工具链

| 层 | 工具 | 用途 | 依赖真实 PG |
|---|---|---|---|
| **单元**（纯函数/逻辑） | vitest + fakePool / 桩 | `mergeDiscoveryRules` / `runWaterfall` / `resolveExistingOrCreate` / `compilePlaybook` / `buildGlassBox` / `appendAccountMemory` / `buildDiscoveryMetrics` / `profileMerger`-discovery 段 | 否 |
| **装配/契约** | vitest（import 真实 registry） | 三处硬闭包、MCP 工具面、`detectCrudExplosion` | 否（需先 `seedDiscoveryActions()`） |
| **路由/编排** | vitest + `__setDeps` 注入 | `discoveryRoutes`（只读候选池）、`monitorAccount` 重评分、决策第 0 闸 spy | 否 |
| **集成（全链路）** | vitest + 真实 `pool` | `lead-fit` scenario 落库、dedup 并发唯一约束、S1 衔接、行业 discovery 播种 | **是**（`crm_native_test@5433`） |
| **页面/E2E** | `scripts/*.mjs` + `verify-plugin-zips.py` | 门户页 id 清单、MCP stdio 工具面、打包版本链、胶囊绑定 | 混合 |

**运行环境（按 binary_context 强制）**：
- Node：托管版 `C:\Users\wangchuan08\.workbuddy\binaries\node\versions\22.22.2-2\node.exe`（优先）。
- 依赖隔离：仅当 `node_modules/vitest` 缺失时，于托管 workspace 安装；**禁止全局 npm install**。
- 跑单测：`npx vitest run test/config/discoveryRules.test.js`（逐 Task）；批量见 §3。
- 集成探活：跑集成前先 `SELECT 1` 连 `crm_native_test@5433`（**PG 监听 IPv6 回环，连 `localhost`/`::1`，勿写 `127.0.0.1`**）。

**桩约定**：
- `fakePool` 拦截 `query(sql, args)`，按 SQL 子串返回 `rows`（`config_store` / `providers` / `decision`）。
- LLM 一律注入 `llmFactory` 返回固定 JSON（**不调真实 LLM**），Claygent 研究报告与 `why_narrative` 走注入。
- 决策第 0 闸集成测试用 `__setDeps({ requireDecision: async () => ({ decision_id:'TEST-D' }) })` 隔离，避免污染 `crm.decision`。

> **关键约束**：`registerAction` / `registerSkill` / `particleRepo` / `configCenter` / `configRouter` 的签名**以真实源码为准**（已核实见实施计划 Self-Review）；测试 import 路径随实现对齐，**不得臆测**。

---

## §3 测试执行顺序（严格 red-green，对应 Task 1–21）

每个 Task 内部遵循：① 写失败测试（RED）② 实现 ③ 跑测试（GREEN）④ commit。Task 间依赖：

```
T1 (discovery-rules 配置)  ──┬─ T2 (Adapter 框架 + waterfall)
                             ├─ T5 (三处硬闭包) ─── T18 (MCP 对外面) ─── T20 (E2E)
                             ├─ T14 (C1 编排编译) ─┐
                             └─ T21 (行业包 handbook 同步，依赖 T1 配置键)
T2 ─┬─ T3 (4 起步适配器)
    └─ T7 (编排 + dedupResolver，依赖 T3/T4)
T4 (2D payload) ── T7
T6 (lead-fit scenario + 事件矩阵) ──┬─ T7（评分入 payload）
                                    ├─ T11 (ICP 自进化回测)
                                    └─ T16 (C3 重评分)
T7 ─┬─ T8 (Claygent 研究)
    ├─ T10 (S1 衔接)
    └─ T13 (前台页面)
T6/T7 ── T12 (feedback 指标)
T4 ── T15 (glass-box C2)
T9 (记忆捕获 + L2 红线)
T16 ── 依赖 T15 + T7
T17 (后台配置页) ── 依赖 T1 + T14
T19 (buddy + 插件包) ── 依赖 T5 + T18
T20 (端到端验收) ── 最后
```

**建议最长依赖链先行**：`T1 → T2 → T3 → T4 → T5 → T6 → T14 → T7 → T15 → T16 → T9 → T12 → T11 → T8 → T10 → T13 → T17 → T18 → T21 → T19 → T20`。

---

## §4 每 Task 测试清单（断言级）

| Task | 测试文件 | 关键断言（RED→GREEN） | 验收 |
|---|---|---|---|
| **T1** | `test/config/discoveryRules.test.js` | ① `DEFAULT_DISCOVERY_RULES` 含 `providers`/`signals`/`icp`/`duplicate_criteria`/`playbooks` 五键；② 出厂 providers 中 `clearbit`/`linkedin` `enabled===false`，`email-verify`/`web-research`/`tender`/`gaode` `enabled===true`；③ `mergedDiscoveryRules('A')` 不含 B 租户定制；④ 未 seed 租户懒克隆系统默认 | 五键齐 + 付费默认禁 + 隔离成立 |
| **T2** | `test/connectors/discovery/waterfall.test.js`、`test/connectors/discovery/providerRegistry.test.js` | ① 逐字段按 `costTier` 升序扫描，**首个命中即停**（call log 断言更贵者未被调用）；② 成本计量累计 `cost`；③ 全 miss 返回 `{ values:{}, cost:0 }` **不抛**；④ **无「取并集覆盖」语义**（同字段被多源命中时只记最廉一次，第二源不被调用）；⑤ 单适配器抛错不中断整条 waterfall（记入 `calls[].error` 后继续降级）；⑥ `resolveAdapters(rules,{allowIds})`：`enabled===false`（含付费源默认禁）不实例化、未注册 id 跳过、`costTier` 升序、工厂收到 provider 配置；⑦ `loadAdapters({tenantId})` 走 `mergedDiscoveryRules` 租户感知（A 租户启用 `attio` 不影响 B 租户） | 首命中即停 + 成本正确 + 注册表隔离 |
| **T3** | `test/connectors/discovery/adapters.test.js` | 4 适配器同契约 **`{ id, kind, costTier, coverageFields, enrich(entity, fields, ctx) }`（对齐设计 v8.1 §3 统一接口；**非 `fetch`**）**；**模块加载即自注册**（`listProviderIds()` 含 4 个 id）；无命中一律返 `{}`（**非 `null`**，让 waterfall 判 miss）；`email-verify` 仅本地语法+一次性域名判定（`confidence < 0.9`，**不得伪称「已验证」**）；`web-research` 委托注入的 `ctx.research`（无通道 → `{}`，**绝不伪造字段**）；`tender` 委托既有 `filterTenders(sub, tenders)`（**真实**关键词+区域过滤；注意真实签名是 `matchTender(sub, tender)`，**不是** `matchTender(entity)`）；`gaode` 走 `vi.stubGlobal('fetch')` 桩 HTTP（**无 key 不发起请求** / HTTP 失败 fail-open / 第二字段 `cost=0` 不重复计费） | 4/4 同契约 + 自注册 |
| **T4** | `test/agent/discoverySchema.test.js` | ① `enrichment.<field>` 含 `{value, provider, confidence, ts, layer, source}` 六元；② `judge` 含 `{axis, rule_ref, j_score}`（2D：能力轴 × 来源轴）；③ `why_narrative` 非空且含 `rule_ref`（+`decision_id`）；④ `layer ∈ {L1,L2,L3,L4}`，非法 layer **抛错**（非静默降级） | 2D + why_narrative 齐 |
| **T5** | `test/action/discoveryActions.test.js` | 先 `seedDiscoveryActions()`；① `getAction('discovery-run')` 非空；② `assertAgentAssembly().ok===true`；③ `skillCalls ⊆ capabilities.actions`；④ `kind/permission/namespace/agentTool/handler` 平铺字段齐（**非 JSON Schema**） | 三处硬闭包全绿 |
| **T6** | `test/decision/leadFitScenario.test.js` | seed 后 `decision_scenario` 存在 `lead-fit`；九标尺可对该 scenario 评分；`eventTrigger` 矩阵含 `CRM_KNOWLEDGE/discovery-sync → lead-fit` 行 | scenario + 矩阵行就位 |
| **T7** | `test/connectors/discovery/dedupResolver.test.js`、`orchestrator.test.js` | ① `resolveExistingOrCreate` 依 `duplicate_criteria` 多级回退（account: `external_id→domain→linkedin_url→name`；contact: `email`）——**domain 命中既有记录时不调 `create`**；② 短串（`len<MIN_STR_LEN`）不参与判重；③ `23505` 唯一约束冲突 → catch 后重查赢家转 `update`（**并发不重复创建**）；④ 编排：本体优先富集 → 仅缺口走 waterfall → `lead-fit` 评分入 payload；⑤ **零 DELETE** | 防重 + 并发兜底 + 零 DELETE |
| **T8** | `test/connectors/discovery/research.test.js` | ① `discovery-research` 产 `{report, why_narrative, signals[]}`；② LLM 注入固定 JSON（不调真实）；③ 无命中不写库（fail-open 返空） | 研究报告 + 信号 |
| **T9** | `test/memory/discoveryCapture.test.js` | ① `DEFAULT_CAPTURE_DOMAINS` 含 `discovery`；② **`src/context/routing.js` 零改动**（`git diff --stat` 断言）；③ 发现结论经既有 **L2 通道**注入（断言未新增路由分支）；④ 注入体积 ≤ 64KB 闸 | 捕获域 + id36 红线守 |
| **T10** | `test/connectors/discovery/s1Handoff.test.js` | ① 命中线索经既有 `intake-router` 落商机（**不新增 stage/scenario**）；② BANT 四维驱动阶段门控；③ 决策行含 `decision_id` | 复用 not 新增 |
| **T11** | `test/evolution/icpSelfEvolution.test.js` | ① 产 ICP 草稿 `status='draft'`；② 有回测报告；③ **无 HITL 批准时绝不生效**（断言 `icp` 未写入生效配置）；④ 批准后落 `decision_id` | 绝不自动生效 |
| **T12** | `test/feedback/discoveryMetrics.test.js` | ① 7 要素指标模板齐（含 `monitorAccount_refresh_rate`）；② Token–业务因果对账字段存在；③ evaluator 返回 `{score, verdict}` | 7 要素 + evaluator |
| **T13** | `test/web/discoveryPage.test.js`、`test/http/discoveryRoutes.test.js` | ① `src/web/discovery.html` 存在且 triggerBar/candidatePool/glassBoxDrawer 三区 id 齐；② `/api/discovery/candidates` 只读返回候选池；③ **无写端点**（grep 断言 routes 无 POST） | 页面 + 只读端点 |
| **T14** | `test/connectors/discovery/orchestrationCompiler.test.js` | ① `selectPlaybook(rules, audience)` 命中 `audience` 对应 playbook；② `compilePlaybook(pb)` 产四段原语 `data→condition→ai→action` 有序计划；③ 未知名/缺段抛错；④ 全配置驱动（无硬编码段） | 四段原语编译 |
| **T15** | `test/agent/glassBox.test.js` | `buildGlassBox(judge, narrative, trace)` 产 `{judge:{rule_ref,j_score}, why_narrative, trace[]}`，与 P0#1 2D judge **同源结构**（断言字段集一致） | glass-box 结构齐 |
| **T16** | `test/connectors/discovery/monitorAccount.test.js`、`test/memory/accountMemory.test.js` | ① 信号/定时触发 `lead-fit` 重评分；② 增量**append** 账户记忆（断言旧记忆仍在，非覆盖）；③ 30 天蒸馏产 curated note；④ **零 DELETE**；⑤ **不触发外发**（断言未调 agent-mail） | append + 蒸馏 + 不外发 |
| **T17** | `test/web/discoveryRulesPage.test.js` | `src/web/discovery-rules.html` 5 TAB id 齐（`icp`/`providers`/`signals`/`duplicate`/`playbooks`）；接线无 500；PUT 走配置中心（自带第 0 闸） | 5 TAB 就位 |
| **T18** | `test/mcp/discoveryExpose.test.js` | ① `agentTool:true` 的 discovery-* 自动出现于 MCP 工具面（计数断言）；② 写动作 blast-radius 默认 `human_gate`（**不进 autonomous 白名单**）；③ gateway `decisionScenario` 锚定；④ `detectCrudExplosion()` 无 R3 违规（新 Action 已折叠/合并） | MCP 暴露 + 反爆炸 |
| **T19** | `scripts/verify-plugin-zips.py`、`scripts/buddy-capsule-binding-check.mjs` | ① `crm-native-plugin.zip` `version=1.8.0`、`connector-meta.json=1.6.0`、`plugin-platform-admin.zip=1.2.0`；② `skills/crm-native/SKILL.md` 工具表含 discovery-*；③ buddy portal CAPS 含「线索发现」；④ 胶囊绑定校验通过 | 版本链 + 工具表 + 绑定 |
| **T20** | `scripts/e2e-lead-discovery.mjs` | ① HTTP 双端点（页面 + 只读候选池）200；② 真实 MCP stdio 调 `discovery-run`；③ 断言 **`ok===true`**（未登录仅 `gate=auth_required` 仍合法 JSON → **只判字段会假绿**）；④ 插件包校验 | `ok===true` 硬判据 |
| **T21** | `test/connectors/discovery/industryDiscovery.test.js`、`test/config/industryTemplateDiscovery.test.js` | ① 7 份 `db/seed/tenant-profile-*.js` 均含 `discovery` 段（providers/icp/signals/playbooks）；② **Step 4C 文本存在**于两份 SKILL；③ 模板 `providers` **不含付费源启用**（断言 `clearbit/linkedin` 缺省或 `false`）；④ `assign-profile` / `remove-profile` 对 `system` 租户 400；⑤ 播种后 `mergedDiscoveryRules(tenantId).providers` 命中手册清单；⑥ 其它租户不可见（隔离）；⑦ `profileMerger` 三消费点 **byte-equal 零回归**；⑧ **零 DELETE** | 行业 onboarding 闭环 + 零污染 |

---

## §5 合规性专项测试（护栏，fail-closed）

独立于功能测试，额外四类"护栏测试"：

1. **禁 DELETE 静态扫描** — `test/connectors/discovery/no-delete.test.js`：用 `fs.readFileSync` 读 `src/connectors/discovery/*.js`、`src/action/discoveryActions.js`、`src/memory/accountMemory.js`、`src/evolution/icpSelfEvolution.js`，断言不含 `DELETE FROM` / `.delete(`（迁移脚本排除）。**fail-closed**。
2. **不新增粒子类型** — `test/connectors/discovery/no-new-particle.test.js`：断言 `PARTICLE_TYPES` 键集合与基线快照**完全一致**；并断言 `src/particles/seed.js` 未在 `git diff --stat` 中（人工核）。
3. **id36 红线** — `test/connectors/discovery/id36-redline.test.js`：断言 `src/context/routing.js` 与 `src/context/assembler.js` 改动为零（`git diff --stat` 输出为空）。
4. **三处硬闭包** — `test/action/discoveryActions.test.js` 内固化三条：`getAction` 非空 / `assertAgentAssembly().ok` / skill slug 注册；任一失败即 CI 红。

---

## §6 已知风险与 flaky 处理（按项目记忆）

- **PG 不稳**：T6/T7/T10/T16/T21 依赖真实 `crm_native_test@5433`。按铁律「**单次红不得直判回归**」——连接超时导致的红，须先 `SELECT 1` 探活重试，再判定。
- **跨会话共享测试库**：`crm_native_test` 被多 vitest 会话共享，并发 `TRUNCATE` 会互踩→伪失败。**集成测试单独跑、不与单元并发**；新增测试须完整清理外键子表。
- **`DEFAULT_CAPTURE_DOMAINS` 副作用**：T9 改捕获域可能影响既有记忆测试，须跑 `test/memory/` 全量确认不回归。
- **事件矩阵膨胀**：T6/T16 各加矩阵行，须断言既有矩阵行**未被替换**（append，非 overwrite）。
- **LLM 依赖**：T8/T15 一律注入 `llmFactory`；`degraded` 路径（无 LLM）须 fail-open 返回空而非抛错。
- **打包版本链漂移**：T19/T21 涉及 4 处版本号（`plugin.json` / `connector-meta.json` / `plugin-platform-admin` / `verify-plugin-zips.py` `expect_version`），须**一次改齐**，否则 `verify-plugin-zips.py` 必红（历史漂移根因）。
- **`test/` 单数**：测试目录真实名为 `test/`（**非 `tests/`**），556 个测试文件；新增测试落此。
- **行业模板直跑守卫**：`db/seed/tenant-profile-*.js` 的 `isMain` 守卫须用 `pathToFileURL` 归一化（win32 盘符大小写坑，范式 `scripts/seed-tenant-master-data.mjs:116-118`），否则直跑静默无操作。

---

## §7 交付与 commit 纪律

- 每 Task 一 commit，消息前缀 `feat(discovery):` / `test(discovery):` / `chore(plugin):`（严格按实施计划各 Task 末尾命令）。
- **绝不 `git add -A`**：仅 `git add` 本 Task 显式路径；**AI 无 git 凭证、不 commit**，命令由用户在本地 PowerShell 粘贴执行。
- 每个 Task 的 commit 须**同时包含实现 + 其测试文件**（TDD 同批），便于二分定位。
- 全量自检命令（收口前）：
  ```
  npx vitest run test/config/discoveryRules.test.js test/connectors/discovery test/action/discoveryActions.test.js test/agent/glassBox.test.js test/memory/accountMemory.test.js test/evolution test/feedback
  python scripts/verify-plugin-zips.py
  node scripts/buddy-capsule-binding-check.mjs
  ```
- 红线核验（每次提交前）：
  ```
  git diff --stat -- src/particles/seed.js src/context/routing.js src/context/assembler.js
  ```
  **必须为空**。

---

## §8 出口标准（Definition of Done）

1. T1–T21 全部测试绿；§5 四类护栏测试全绿。
2. 红线全守：`PARTICLE_TYPES` 零改动、`context-routing(id36)` 零改动、物理 DELETE 零调用、付费源默认禁用、system 租户 400。
3. 三处硬闭包成立：`getAction('discovery-run')` 非空 ∧ `assertAgentAssembly().ok===true` ∧ `lead-discovery` SKILL 注册。
4. 集成类（T6/T7/T10/T16/T21）在真实 PG 探活重试后全绿；若红，须明确标注 flaky 根因（PG 不稳 / 并发互踩），**非代码缺陷方可放行**。
5. **行业包扩展 handbook 闭环**（T21）：两份 SKILL 对齐含 Step 4C；7 份模板有 `discovery` 段；`plugin-platform-admin.zip=1.2.0`；`verify-plugin-zips.py` 全过；`profileMerger` 三消费点 byte-equal 零回归。
6. E2E（T20）双通道（HTTP + MCP stdio）以 **`ok===true`** 为唯一通过判据。
7. 端到端演示：新行业上线 → Step 4C 启用本租户数据源 → 触发 `discovery-run` → 产候选池 → `lead-fit` 评分带 glass-box `why_narrative` → 落 `CRM_ACCOUNT`（经 `dedupResolver` 防重）→ C3 `monitorAccount` 重评分并 append 账户记忆。
8. 全部变更按 Task 分组 commit，零信任 / 禁删 / 隔离断言均绿。

---

## §9 测试计划 ↔ 设计 ↔ 计划 三方一致性自检

| 校验项 | 结论 | 证据 |
|---|---|---|
| 每个设计章节都有对应 Task 与测试 | ✅ | §0 覆盖 21 行矩阵 |
| 每个 Task 都有断言级测试清单 | ✅ | §4 覆盖 T1–T21 |
| gates（§1）均落到具体测试 | ✅ | 决策第 0 闸→T5/T7/T11/T16/T21；禁 DELETE→§5.1；隔离→T1/T21；粒子零增长→§5.2；三处硬闭包→§5.4；配置驱动→T1/T14；id36→§5.3；付费源→T1/T21；system 保护→T21 |
| 执行顺序与 Task 依赖一致 | ✅ | §3 依赖图源自实施计划 Task 依赖 |
| 行业包 handbook 同步（v8.1 §12）已纳入测试 | ✅ | T21 八条断言 + §8.5 出口标准 |
| 测试目录 / 契约与实际代码一致 | ✅ | `test/`（单数）、真实签名已核实（见实施计划 Self-Review） |
