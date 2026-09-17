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
| §2②③ + §9.1 | T7 | `test/connectors/discovery/dedupResolver.test.js`(3) + `test/agent/discoveryOrchestrator.test.js`(7) | 单元（DI 替身，零 DB） |
| §4 / C2 | T8 | `test/connectors/discovery/research.test.js` | 单元（LLM 注入） |
| §9.3（P0#2） | T9 | `test/memory/discoveryCapture.test.js` | 单元 + 红线 |
| §9.6 | T10 | `test/integration/discoveryToS1.test.js` | 集成（连 PG） |
| §8（P0#3） | T11 | `test/evolution/icpSelfEvolution.test.js` | 单元 + HITL |
| §9.11（P0#4） | T12 | `test/feedback/discoveryMetrics.test.js` | 单元 |
| §9.7 | T13 | `test/web/discoveryPage.test.js` + `test/http/discoveryRoutes.test.js` | 路由/页面 |
| §3.2（C1） | T14 | `test/connectors/discovery/orchestrationCompiler.test.js` | 单元 |
| §4（C2） | T15 | `test/agent/glassBox.test.js` | 单元 |
| §6.2（C3） | T16 | `test/connectors/discovery/monitorAccount.test.js` + `test/memory/accountMemory.test.js` | 单元 + 集成 |
| §9.7 | T17 | `test/web/discoveryRulesPage.test.js` | 页面 |
| §9.5 / §9.8 | T18 | `test/mcp/discoveryExpose.test.js` | MCP 面 |
| §9.7 | T19 | `scripts/verify-plugin-zips.py` + `scripts/buddy-capsule-binding-check.mjs` | 打包校验 |
| 四条触点面 | T20 | `scripts/e2e-discovery-touchpoints.mjs`（原写 `e2e-lead-discovery.mjs` 已裁定作废——以计划 Task 20 为准） | E2E |
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
7. **`context-routing(id36)` 红线**：`src/context/routing.js` + `src/context/assembler.js` **sha256 内容哈希冻结值不变**（零 git 依赖；`git diff --stat` 因「只反映未提交改动 + 本项目 `.git` 对象库常不完整」不可用，2026-09-11 换判据）+ 两文件源码不含 `discovery` 字样 + `ROUTING_KEY==='context-routing'`；发现结论仅消费既有 **L2 通道**（§9.3）。
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
T6 (LEAD_FIT 场景字典·三处幂等) ──┬─ T7（评分入 payload）
                                    ├─ T11 (ICP 自进化回测)
                                    └─ T16 (C3 重评分)
T7 ─┬─ T8 (Claygent 研究)
    ├─ T10 (S1 衔接)
    └─ T13 (前台页面)
T6/T7 ── T12 (feedback 指标)
T4 ── T15 (glass-box C2)
T9 (记忆捕获域 + emit 源 + L2 红线)
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
| **T5** | `test/action/discoveryActions.test.js` | 先 `seedDiscoveryActions()`；① `getAction('discovery-run')` 非空；② **`(await assertAgentAssembly()).ok===true`（async，必须 await）**；③ `skillCalls ⊆ capabilities.actions`；④ `kind/permission/namespace/agentTool/handler` 平铺字段齐（**非 JSON Schema**） | 三处硬闭包全绿 |
| **T6** | `test/decision/leadFitScenario.test.js` | ① **双源静态一致**：`db/seed.sql` 与 `db/test-setup.sql` 的 `decision_scenario` INSERT 段均含 `('LEAD_FIT'` 行，`default_tier='LEAD'` + `autonomous_allowed=TRUE` + 5 个 ICP cond（industry/headcount/geo/hiring_icp_role/funding_round）+ 权重和 = 1；② **真实 PG**：执行 seed 语句（幂等）后 `crm.decision_scenario WHERE scenario_id='LEAD_FIT' AND tenant_id='system'` 恰 1 行且属性正确。**事件矩阵行移 T16**（`matchTrigger` 只读白名单闸 + 无 `discovery-sync` emitter ⇒ 现在加即死配置） | 场景字典三处（seed.sql / test-setup.sql / seed-test-config.mjs）就位 |
| **T7** | `test/connectors/discovery/dedupResolver.test.js`、`test/agent/discoveryOrchestrator.test.js` | ① `resolveExistingOrCreate` 依 `duplicate_criteria` 多级回退（account: `external_id→domain→linkedin_url→name`；contact: `email`）——**domain 命中既有记录时不调 `create`**；② 短串（`len<MIN_STR_LEN`）不参与判重；③ `23505` 唯一约束冲突 → catch 后重查赢家转 `update`（**并发不重复创建**）；④ 编排（真实写助手直调 repo + 透传 tenantId/decision_id）：本体优先富集 → 仅缺口走 waterfall → `lead-fit` 评分入 payload；另提供 `registerBuiltinAdapters()` 启动接线护栏；⑤ **零 DELETE** | 防重 + 并发兜底 + 零 DELETE |
| **T8** | `test/connectors/discovery/research.test.js`（7 例：claygent 5 + 编排 2） | ① `claygentResearch` 产 `{report/summary, why_narrative, signals[], layer=L3, source=claygent}`；② **why_narrative 非空**且带 glass-box（`judge.rule_ref` 含 `lead-fit`、`judge.j_score` 为 number、`trace[]` 非空）—— SKILL postcondition `payload.research.why_narrative!=null`；③ LLM 一律注入替身（`(systemPrompt,userPrompt,o)=>JSON` 形状，**不调真实**）；④ 无 LLM 通道 / LLM 返 null → `degraded=true`、返空、**不抛不伪造**；⑤ 区块二分：先规划区块再**定向**抓取（单区块抛错不中断），无 `fetchText` 通道 → 零抓取且不伪造；⑥ 编排 `runDiscoveryResearch`（DI 替身零 DB）：有产出 → 写 `patch.research` + 透传 `tenantId`/`requireDecisionId`；**无产出 → `updateParticle` 未被调用** | 研究报告 + 非空 why_narrative + fail-open 不写库 |
| **T9** | `test/memory/discoveryCapture.test.js` | ① `DEFAULT_CAPTURE_DOMAINS` 含 `discovery` 且 `isCapturable('discovery')===true`（`BLOCKED_DOMAINS` 域仍硬拒）；② **id36 红线内联**：routing.js + assembler.js 的 **sha256 冻结值不变** + 源码不含 `discovery` + `ROUTING_KEY==='context-routing'`；③ **emit→捕获闭环**（`vi.mock` 替身 `appendMemory`，零 PG）：`emit('discovery','lead-discovered',{summary,account_id})` → `appendMemory` 被调且 payload 带非空 `summary`；未列域不被捕获；④ **64KB 纯函数闸**：超限 → `truncated===true` + `degradedLayers` 含 `'L2'` + 结果 ≤ `KNOWLEDGE_CONTEXT_BYTE_LIMIT`，关键键 `summary` 保留 | 捕获域 + emit 源 + id36 红线守 |
| **T10** | `test/integration/discoveryToS1.test.js`（**连 PG**；原写 `test/connectors/discovery/s1Handoff.test.js` 语义不符——该目录全为零 PG 替身单测，integration 目录才是 PG 集成测试的家） | ① **落库归一**：经 `actionExecutor.dispatch('discovery-run',…)` 产出的 DEAL 落库 `stage==='S1'`（`S_ALIAS_FWD.lead='S1'` 写入即归一，**非闸推进**）+ `source==='discovery'` + `account_id` 已绑；② **决策第 0 闸真落行**：从 payload `discovery.why_narrative` 提取 `decision_id=` 且 `crm.decision` 恰 1 行（防「场景缺失→静默不 mint」假绿）；③ **既有闸复用**：`salesStageGate({curStage:'S1',toStage:'S2'})` hard 拦空 payload、放行带 `needs` 的（BANT/阶段闸在 `executor.js:165`，**不在** `crm-deal-advance` handler 内）；④ **既有入口复用**：`routeThroughIntake(task)`（`scheduler.js:38` export）返回 `targetAgent`+`payload.level`（`intake-router` 是 agentSpec 子智能体、无独立 dispatch 路径）；⑤ 零新增护栏：`S_STAGES.length===8` 且 `S_GATE_DEFS[0]` 为 `S1→S2` | 复用 not 新增（test-only） |
| **T11** | `test/evolution/icpSelfEvolution.test.js` | ① 产 ICP 草稿 `status='draft'`（`validated=false`，`needsApproval` 恒真）；② 有回测报告（`verdict ∈ threshold/count/noop`）；③ **无 HITL 批准时绝不生效**（断言生效写 0 次）；④ 批准后落非空 `decision_id`（`requireDecision('CALIBRATION_CHANGE').decision.decision_id`）；⑤ 三态回测（noop/count/threshold）；⑥ 源码零 DELETE | 绝不自动生效（`CALIBRATION_CHANGE.autonomous_allowed=false`） |
| **T12** | `test/feedback/discoveryMetrics.test.js` | ① 7 要素指标模板齐（`SEVEN_KEYS.length===7`）且**恰 3 指标**（`discovered_to_won_rate`/`enrichment_coverage`/**`monitorAccount_refresh_rate`**，C3 冻结 `target===0.9`）；② Token–业务因果对账**字段存在**（`ledgerCost` 返回含 `account_id`/`provider`/`cost`/`tokens`/`decision_id`/`tenant_id`；注入式 `recorder` 替身被调 1 次且 `source==='discovery-provider'`）；③ evaluator 返回 **`{score, verdict}`**（三档 `green/yellow/red` + 边界闭区间 + 未知指标 throw + `down` 方向语义）；④ 红档 `actionsFor(m,'red')` 非空（回滚/重校准，**非仅熔断**）；⑤ 零 PG + 零 DELETE + 模块含 `from '../alerts/tokenAccounting.js'`（**复用既有设施，禁自造 `discovery_cost_ledger`**） | 7 要素 + 3 指标 + evaluator |
| **T13** | `test/web/discoveryPage.test.js`、`test/http/discoveryRoutes.test.js` | ① `src/web/discovery.html` 存在且 triggerBar/candidatePool/glassBoxDrawer 三区 id 齐；② `/api/discovery/candidates` 只读返回候选池；③ **无写端点**（grep 断言 routes 无 POST） | 页面 + 只读端点 |
| **T14** | `test/connectors/discovery/orchestrationCompiler.test.js` | ① `selectPlaybook(rules, signals)` 命中对应 playbook（`&&` 全命中；部分命中不收窄）；①b 无 match 命中且无 `default` 项 ⇒ 返回 `null`（= 不过滤，保持全量启用源，防静默收窄适配器集）；② `compilePlaybook(pb)` 产四段原语 `data→condition→ai→action` 有序计划；③ 非法入参（`null`/无 `name`）抛错；**缺段 ⇒ 该段不产出（可组合 = 任一段可选，不抛错）**；④ 全配置驱动（计划段全部源自入参，无硬编码段） | 四段原语编译 |
| **T15** | `test/agent/glassBox.test.js` | `buildGlassBox({score, ruleRef, signals, axis})`（**对象入参**，与 claygent 既有内联实现同构）产 `{judge:{axis,rule_ref,j_score}, trace[], why_narrative}`，与 P0#1 2D judge **同源结构**（断言 `buildGlassBox().judge` 键集 === `buildDiscoveryPayload().icp_fit_score.judge` 键集）；脏信号（`null`/无 `type`）被过滤（trace 项数 = 有效信号数）；无信号走「无信号」分支不抛错；`ruleRef`/`axis` 可覆盖 | glass-box 结构齐 |
| **T16** | `test/connectors/discovery/monitorAccount.test.js`、`test/memory/accountMemory.test.js` | ① 信号/定时触发 `lead-fit` 重评分（`ctx.rescore` 注入）；② 增量**append** 账户记忆（断言旧记忆仍在，非覆盖）；③ 30 天蒸馏产 curated note（`classifyForDistill` 纯函数筛选，note 键为 `content`）；④ **零 DELETE**；⑤ **不触发外发**（源码零 `agent-mail`/`sendMail`）；⑥ **`patch` 读-改-写**（断言 `payload.discovery` 既有子键 `icp_fit_score`/`enrichment` 未被整体替换，且入参键为 `patch` 非 `payload`）；⑦ **喂 Task 12**（`feedback.metric==='monitorAccount_refresh_rate'` 且 `verdict` ∈ green/yellow/red）；⑧ 缺 `score` fail-fast（拒绝静默置 0）。**事件矩阵行本 Task 不加**（见 §5） | append + 蒸馏 + 不外发 + 指标回接 |
| **T17** | `test/web/discoveryRulesPage.test.js` | `src/web/discovery-rules.html` 5 TAB **id** 齐（`icp`/`providers`/`signals`/`duplicate`/`playbooks`，`data-tab="<key>"`）+ 中文名齐；含写端点 `/api/config/discovery-rules`、`decision` 票据回显、`付费源` 出厂禁用提示（D1）；**接 layout 壳**（`from '/portal/layout.js'` + `injectLayout()`，`nav-path.test.js` 全站硬守护）+ 用门户 `get/put`（禁裸 fetch）；断 `routes.js` 已挂载（**Task 1 落地，本 Task 零改动**）。**分层说明**：「接线无 500」无法由 fs 断言验，由既有 `test/http/configRouter.test.js` + 本功能线路由测试覆盖。**另含 T13 补修**：`src/web/discovery.html` 接壳 + 改 `get`（原 `fetchJson` 不存在）+ 真实渲染 —— 该补修使 `nav-path.test.js` 由红转绿 | 5 TAB 就位 + T13 回归修复 |
| **T18** | `test/action/discoveryActions.test.js`（**追加 T18 describe 块**，保留 T5 五例；原写 `test/mcp/discoveryExpose.test.js` 已裁定作废——以计划 Task 18 为准，复用既有脚手架） | ① `agentTool:true` 的 discovery-* 出现于 MCP 工具面（`buildMcpTools().tools.map(t=>t.name)`；**注意返回是对象非数组**，且须默认 `seed:true` + `names.length>30` 非平凡闸防假绿）；② 写动作 blast-radius 默认 `human_gate`（`isWriteWhitelisted(n)===false` + `writeBlastRadius(n)==='human_gate'`；whitelist 天然不含 discovery-*，**注释级零逻辑改动**）；③ 第 0 闸锚定 = **静态契约**（`decisionScenario==='LEAD_FIT'` + `autoDecision===true` + `confirm==='stage2'`，即 `gateway.js:165` mint 触发键）+ **handler 级 fail-closed**（`handler(payload,{})` rejects `/decision_required/`，落点 `discoveryActions.js:16-22`）。**禁 DB-free 直调 `mcpWritePhase1` 断言闸值**（无 token ⇒ degraded ⇒ 恒返 `auth_required`，`ok!==true` 对错误原因恒通过 = 假绿）；真实 mint 落 `crm.decision` 行归 **T20** 端到端。⚠ 原稿「`gate='confirm_required'`」作废——该值**全仓 0 命中**；④ `detectCrudExplosion()` 无 R3 违规（新 Action 已折叠/合并；**须在 `seedActions()` 后的全量注册表上判定**，空表恒 `{exploded:false}` = 假绿） | MCP 暴露 + 反爆炸 |
| **T19** | `test/ui/discoveryCapsule.test.js`（**新建 `test/ui/` 目录**）+ `scripts/verify-plugin-zips.py` + `scripts/buddy-capsule-binding-check.mjs` | ① **胶囊形状**：manifest `home.workModes[销售坐席].capsules[]` 含「线索发现」（`en='Lead Discovery'`、`expert='企业AI销售决策专家'`）；**`prompts`/`inspirations` 均非空**（`gen-capsule-form-cards.mjs:56-58` 与 `build-buddy-import-zip.mjs:174-197` 硬依赖，缺则 TypeError 崩）；② **图标存在**：`assets/capsules/discovery.svg` 真实存在（`pack-buddy-import.mjs:82-92` MISSING ICONS → `exit(1)`）；图标须由单一事实源 `scripts/gen-capsule-icons.mjs` 的 `ICONS` 生成；③ **值域不变量**：全 manifest 的 `workModes[].skills` 与 `capsules[].skills` **⊆ `connector/skills/`**（已上架技能）——**不是 MCP 工具名**（`discovery-run` 只出现在 `systemPrompt`，不入 `skills`）；④ **门户 CAPS**：`CAPS["客户洞察"]` 含 `skill:'discovery-run'` + `targetAgent:'decision-agent'`；⑤ **绑定表 parity**：门户每个 `{ label: ... }` 都有对应 `cap: '...'` 行（防「加了 CAPS 却没进校验表」静默分叉；本 Task 顺手修既有漂移 `客户调研`→`客户拜访`）。**版本链**：`plugin.json`/`plugin/openclaw.plugin.json`/`plugin/package.json` 三处 1.7.1→**1.8.0** + `verify-plugin-zips.py:129` `expect_version`→1.8.0（`:162` platform-admin 保持 **1.1.1**，升 1.2.0 归 **T21**）+ `connector-meta.json` 1.5.0→**1.6.0**（`verify-plugin-zips.py` **不覆盖该文件**，须人工核对）；**2 条防漂移内容规则**（`discovery-run` / `两阶段`）。**副本一致性**：`SKILL.md` **4 份** byte-equal（`skills/` + `.workbuddy-plugin/skills/` + `connector/skills/` + `plugin/skills/`）、`agents/crm-native.md` **2 份** byte-equal（`.workbuddy-plugin/` + `plugin/`），PowerShell `Get-FileHash | Sort-Object -Unique` 计数 = 1。**`manifest.market.skills` 不改**（`pack-buddy-import.mjs:60-66` 打包时被 `readdirSync(connector/skills)` 覆盖 → 改无效果） | 胶囊 + 图标 + 4/2 副本 + 版本链 |
| **T20** | `scripts/e2e-discovery-touchpoints.mjs`（**自起实例 + 动态空闲端口**；原写 `e2e-lead-discovery.mjs`/`PORT=3100` 均作废） | ① HTTP 配置面：未登录 GET `401`（全局 auth 先拦）、`admin` GET `404` 或 `200`（端点**不回退出厂默认**）、`alice` GET `403`、PUT 缺 `icp/providers/signals` `400`、PUT 完整 `200 {updated:true, decision}`（**`decision` 恒 `null`，只可断言键存在**）、GET **深比较** round-trip 相等、复跑 PUT 幂等；② HTTP 前台面：`/api/discovery/candidates` 未登录 `403 {error:'auth required'}`（**非 `auth_required`**）、登录后 `200` 且 `Array.isArray(items)`、`/discovery.html` + `/discovery-rules.html` `200 text/html`；③ 真实 MCP stdio：`tools/list` 逐个含三个 discovery-*；**负向基准** —— 无 token 调 `discovery-run` 断言 `ok===false && gate==='auth_required'`；**有 token 无 confirm_token** 断言 `ok===true && confirm_token 为 string && form.code==='CONFIRM_REQUIRED' && form.decision_id 非空`（第 0 闸真 mint 证据）；`discovery-enrich`/`discovery-research` 各一条同判据。⚠ 原稿「`gate='confirm_required'`」+「判据必须 `ok!==true`」**双重作废**——该 gate 值全仓 0 命中，且有 token 路径**实测即 `ok===true`**；④ 插件包校验（子进程**断言退出码 `rc===0`**）。⚠ 脚本须**先设 `PGDATABASE` 再动态 import**（静态 import 会让 `db.js` 连生产库）；PUT 副作用（写 `config_store(system,'discovery-rules')`=出厂默认，禁 DELETE 不可回滚）须注释声明 | 双通道真实链路 + `ok` 双向判据 |
| **T21** | `test/connectors/discovery/industryDiscovery.test.js`、`test/config/industryTemplateDiscovery.test.js` | ① **显式白名单 7 项**（`chemical/consult/consult2/demo/insmedi/meddev/training`，与 `db/seed/tenant-profile-templates.mjs:16-23` 的 `SPECS` 同源）**不得用 `readdirSync` 全量 glob**——`db/seed` 下另有**未跟踪**的 `tenant-profile-manufacturing.js`（另一功能线），glob 得 8 ⇒ 照抄必 RED；② **形状有效性**：`db/seed/discovery-rules-templates.js`（纯模块，零 DB import）的 7 份配置经**真实 `mergeDiscoveryRules`** 后须满足 `providers` 仍为数组且条数不变 / `signals[*].weight` 仍为 number / `playbooks[*].name` 均存在 —— 这三条正是 `mergeDiscoveryRules:47-60` 的静默丢弃面（写 `{attio:true}` 对象、写 `signals:{x:1}` 数字、写 `playbooks:['x']` 字符串，全部**无异常无日志地失效**）；③ 付费源铁律：7 份 seed 源文本**不得出现付费源名字**（`clearbit|linkedin` 零命中），且合并后 `scope==='paid'` 恒 `enabled:false`；④ **键分离**：每份 seed 含 `writeConfig('discovery-rules'`，且 `tenant-profile` 写入块内不出现 `discovery:` 字段（保 `mergeProfile` 零回归）；⑤ **Step 4C 文本存在**于**三面**（平台侧 `plugin-platform-admin/skills/industry-onboarding/SKILL.md` + 本地运行时 `.workbuddy/skills/new-industry-onboarding/SKILL.md` + 上线 runbook `docs/runbooks/2026-09-03-new-industry-onboarding.md`，**2026-09-11 补第三面，原「已知分叉」已消除**），且三面须含 `system-candidate` 与「第 0 闸」；平台侧另须保留既有 `Step 4B` / `Step 4.5`（**本地侧结构为 `Step 1..9`、runbook 结构为 `## N.`，二者本无 4B/4.5 ⇒ 不得对其断言**，原表述为臆造对齐已作废；runbook 亦不得出现 `Step 4B`——已加反向断言）；⑥ `assign-profile` / `remove-profile` 对 `system` 租户 400 → 复用 `test/billing/tenantAdminMultiProfile.test.js:106-108`（T13）；⑦ `profileMerger` 三消费点 **byte-equal 零回归** → 复用 `test/config/profileMerger.test.js:65-80`（T17/T18）；⑧ `mergedDiscoveryRules` 租户感知 + 隔离（注入式 deps，无 PG）→ 复用 `test/config/discoveryRules.test.js:45-58`（T1）；⑨ **零 DELETE**：`tenant-profile-templates.mjs` 以 `fn(TMP, { withDiscovery: false })` 守卫替代"新增清库语句"，既有 DELETE 语句**一字不改**。**不入库**（`.gitignore` 覆盖，`git add` 会报 ignored）：`plugin-platform-admin.zip`（`:15` `*.zip`，`git log --all -- "*.zip"` 为空 ⇒ 历史从未跟踪）、`dist/buddy-import/industry-config.json`（`:3` `dist/`）、`.workbuddy/skills/new-industry-onboarding/SKILL.md`（`:134` `.workbuddy/`）。**版本链**：`registry.json` 1.0.0→**1.1.0**；`plugin-platform-admin` 三处（`.codebuddy-plugin/plugin.json` / `openclaw.plugin.json` / `package.json`）1.1.1→**1.2.0** + `verify-plugin-zips.py:176` `expect_version`→1.2.0（**行号原写 `:162` 已作废**）+ 3 条**锚定**内容规则（第三元素 `skills/industry-onboarding/SKILL.md`，防被 `README.md` / `agents/platform-admin.md` 抢先满足而假绿）+ `:15` docstring 补 Step 4C。**打包须省略 `--out`**（`pack-platform-admin-plugin.py:96` `makedirs(os.path.dirname('plugin-platform-admin.zip'))` = `makedirs('')` ⇒ 必崩） | 行业 onboarding 闭环 + 零污染 |


---

## §5 合规性专项测试（护栏，fail-closed）

独立于功能测试，额外四类"护栏测试"：

1. **禁 DELETE 静态扫描** — `test/connectors/discovery/no-delete.test.js`：用 `fs.readFileSync` 读 `src/connectors/discovery/*.js`、`src/action/discoveryActions.js`、`src/memory/accountMemory.js`、`src/evolution/icpSelfEvolution.js`，断言不含 `DELETE FROM` / `.delete(`（迁移脚本排除）。**fail-closed**。
2. **不新增粒子类型** — `test/connectors/discovery/no-new-particle.test.js`：断言 `PARTICLE_TYPES` 键集合与基线快照**完全一致**；并断言 `src/particles/seed.js` 未在 `git diff --stat` 中（人工核）。
3. **id36 红线** — **内联于 T9**（`test/memory/discoveryCapture.test.js`；不再另建独立文件，避免与 Task 9 的 commit 范围脱节）：断言 `src/context/routing.js` 与 `src/context/assembler.js` 的 **sha256 内容哈希冻结值不变**（零 git 依赖）+ 源码不含 `discovery` 字样 + `ROUTING_KEY==='context-routing'`。
4. **三处硬闭包** — `test/action/discoveryActions.test.js` 内固化三条：`getAction` 非空 / `assertAgentAssembly().ok` / skill slug 注册；任一失败即 CI 红。

---

## §6 已知风险与 flaky 处理（按项目记忆）

- **PG 不稳**：T6/T7/T10/T16/T21 依赖真实 `crm_native_test@5433`。按铁律「**单次红不得直判回归**」——连接超时导致的红，须先 `SELECT 1` 探活重试，再判定。
- **跨会话共享测试库**：`crm_native_test` 被多 vitest 会话共享，并发 `TRUNCATE` 会互踩→伪失败。**集成测试单独跑、不与单元并发**；新增测试须完整清理外键子表。
- **`DEFAULT_CAPTURE_DOMAINS` 副作用**：T9 改捕获域可能影响既有记忆测试，须跑 `test/memory/` 全量确认不回归。
- **事件矩阵膨胀（T16 复查 2026-09-11 更新）**：T6 **不再**动事件矩阵（原计划行归 T16）；**T16 亦不加行**——派发前源码级复查确认三条硬证据：① `matchTrigger`（`eventTrigger.js:68`）**硬编码 `x.domain === 'ontology'`**，初稿 `{event,kind,...}` 键连 `domain` 都没有 ⇒ 恒不匹配；② 无 `skill_slug` ⇒ `READ_ONLY_SKILLS.has(undefined)===false`（`:71`）静默 `return null`（无报错）；③ 即便改对键，`(ontology,ontology-sync,CRM_ACCOUNT)` 已被 funnel-classification 行占用（`:19`），`.find()` **首匹配胜出** ⇒ 新行恒被截胡；换 `type:'discovery-sync'` 则全仓无 emitter。**故 T16 `eventTrigger.js` 零改动**，矩阵行延后至：discovery 域 emitter 就位 + `matchTrigger` domain 闸门改配置驱动（属行为修改，**须 brainstorming 批准**）。**延后判据（保留供未来 Task）**：加行时须断言既有 3 行矩阵**未被替换**（append 非 overwrite，即 `matrix.length===4` 且前三行 `toEqual` 原值），且行形状为真实 `{domain,type,entity_type,intent,agent,skill_slug,dedup_field}`、`skill_slug ∈ READ_ONLY_SKILLS`（否则 `matchTrigger` 静默丢弃 = 死配置）。
- **LLM 依赖**：T8/T15 一律注入 `llmFactory`；`degraded` 路径（无 LLM）须 fail-open 返回空而非抛错。
- **打包版本链漂移**：T19/T21 涉及 4 处版本号（`plugin.json` / `connector-meta.json` / `plugin-platform-admin` / `verify-plugin-zips.py` `expect_version`），须**一次改齐**，否则 `verify-plugin-zips.py` 必红（历史漂移根因）。
- **`test/` 单数**：测试目录真实名为 `test/`（**非 `tests/`**），556 个测试文件；新增测试落此。
- **既存基线红清单（勿误判为本功能线引入；2026-09-11 T18 复核实测）**：均经 A/B（还原源码至干净基线）或源码级证据证实，**不在本功能线修复范围**：
  - `test/mcp/confirm-params-merge.test.js:42-50` 1 红 —— 断言 `force` 应被 `mergePhase2Params` 当协议位剥离；但 `src/mcp/gateway.js:20-23` 注释明确「**force 不在此列（2026-09-09 修复）**……故 force 作为业务执行参数随 phase2 增补合并，参与第 2 闸判定」⇒ 用例与**已记录的刻意修复相反**，属**过时用例**（前会话 A/B 已证：还原 gateway 干净基线仍红，见 `.workbuddy/memory/2026-09-10.md:232,331`）。
  - `test/config/configCenter.test.js`（34 vs 35 key）、`test/integration/pipeline-new-deal.test.js`（`post` vs `fetch`）、`test/decision/decision-network-linkage.test.js`、`test/decision/calibrationMonitor.test.js`、`test/ai/aiFill.test.js`（`TRAINING_TENANT` 未导出）。
  - **`*_TENANT` 未导出族（2026-09-11 T21 A/B 证实）**：`test/integration/chemical-tenant-runbook-validation.test.js`、`test/integration/insmedi-tenant-runbook-validation.test.js` —— 二者 `import { …, CHEM_TENANT | INSMEDI_TENANT } from '../../db/seed/tenant-profile-<x>.js'`，但 HEAD 版 seed 文件 `grep "^export"` **仅** `export async function seed<X>Profile`（**0 个 `export const`**）⇒ ESM 下常量为 `undefined` ⇒ `beforeAll` 里 `seedChemicalProfile(undefined)` 首行 throw ⇒ **整个 suite 8/8 skipped**。**判据三连**：① 该测试文件 `git status --short` 为空（本次未触碰）；② `git show HEAD:<seed>` 同样无该导出（非本次引入）；③ 与 `test/ai/aiFill.test.js`（`TRAINING_TENANT`）**同族同根因**。**修法归后续**：或补 `export const <X>_TENANT`，或改测试用 `process.env`/`beforeAll` 显式构造租户 id（属行为修改，须单独 Task）。
  - **`*_TENANT` 族实测规模（2026-09-11 全量回归复核，**10 例**）**：`test/meta-model/type-resolver.test.js`（2）、`test/meta-model/edge-config.test.js`（4）、`test/calc/formulaEngine.test.js`（3）、`test/agent/aiFill.test.js`（1 例 `tenantId is required`；另 1 例 `expected 0 to be greater than 0` 为**同根因** —— seed 抛错致无数据）—— 四者均 `import { seedTrainingProfile, TRAINING_TENANT } from '../../db/seed/tenant-profile-training.js'`，而该文件 `git show HEAD:` 与工作区版 `grep "TENANT"` **均零命中** ⇒ 常量恒 `undefined` ⇒ `seedTrainingProfile(undefined)` 首行 throw。**A/B 判据**：HEAD 版与工作区版**都无该导出**，故**非本次/T21 引入**。
  - **测试库残留态 / 顺序依赖（2026-09-11 实测 3 例）**：`test/multi-tenant.test.js`（`sales-thresholds` 实际 13 键 vs system 12 键 —— 同文件 `:99` 自己写入 `_mt_test` 累积，**禁 DELETE 下的残留**）、`test/policy-version.test.js`（9 vs 8 键，同理）、`test/monitor/agent-summary.test.js`（`[]` vs 2 行）。**特征**：干净库首跑绿、重复跑红 ⇒ 属**测试自身无清理**，非代码缺陷。
  - **其它功能线（需求采集，2026-09-11）**：`test/method-skill-real-execution.test.js`（`method-followup-engine` 实为 **4** 步 vs 断言 3 —— 第 4 步 `crm-followup-requirement-collect` 由需求采集线加入，与 `src/skills/seed.js` 的 T5 提交 `f2c6ab2` **无关**，该提交只追加 `lead-discovery` SKILL）、`test/db/migrateConfig.test.js`（`dangling=[ 'REQUIREMENT' ]` vs `[]`）。二者均指向提交 `d4616ab`（`feat(db): 种子与需求采集场景迁移增量`）那条线。
  - **环境/DB 层（2026-09-11 实测 3 例）**：`test/monitor.test.js`、`test/multi-tenant.test.js`（T5 段）报 `pg-pool/index.js:45` + `queryWrite src/db.js:82`（连接层）；`test/llm/ai-attributes.test.js` 单例 `Test timed out in 5000ms`（重试延迟×N 累积 >5s）。均属环境/flaky，非确定性缺陷。
  - **全量回归口径（2026-09-11 收口实测）**：全仓 **583 文件 / 3871 例**（28 red / 3823 passed / 20 skipped）。**必须加 `--no-file-parallelism`**：默认并发下多 worker 争 `crm_native_test` 会 DB 争用，`test/billing/tokenTenant.test.js` 单例曾挂 **3508243ms（≈58 分钟）**导致全量 1h14m 未完；串行后同文件单跑 **95ms**、`test/billing` 全目录 **157/157 绿 44s**。**并发 hang ≠ 代码缺陷**。
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
6. E2E（T20）双通道的通过判据**不是单一 `ok===true`**：MCP **有授权**路径须 `ok===true`，**无授权**路径须 `ok===false && gate==='auth_required'`（双向判据才防假绿）；HTTP 面无 `ok` 语义，按**状态码 + 精确 error 文本**判定。
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
