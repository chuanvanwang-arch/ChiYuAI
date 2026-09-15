# 线索自主发现引擎 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **⚠ TDD 先行（项目铁律）**：**测试计划先于开发计划** —— `docs/2026-09-10-lead-discovery-test-plan.md`（TDD 先行版：§1 gates / §2 分层工具链 / §3 执行顺序 / §4 每 Task 断言 / §5 合规护栏 / §6 flaky / §7 commit 纪律 / §8 DoD）。**每个 Task 必须先写失败测试（RED）→ 实现 → 通过（GREEN）→ commit**；Task 顺序、依赖与断言一律以测试计划为准。
>
> **状态**：**v9**（据设计 **v8.1 已批准** 重出 —— 新增 **Task 21 行业包扩展 handbook 同步**；Task 1–20 契约已据源码校正、正文保留；`tests/`→`test/`、`.test.js`→`.test.js` 全量校正）。

**Goal:** 在 CRM-ai-native 平台原生认知架构（KMD/本体/记忆/零信任写闸）之上，落地「线索自主发现引擎」——把 Clay 真正稀缺的「可编排自主发现循环 + 信号→触达闭环」嫁接到平台原语，不新增粒子类型、不改业务域模型；并按 v8 吸收 Clay 三项最佳能力——**C1 可组合编排层（playbooks）/ C2 Claygent+glass-box 可解释 / C3 monitorAccount 持续监控闭环**。

**Architecture:** 发现引擎 = 既有 Agent（`intake-router`/`decision-agent`）经事件矩阵 / intake 路由驱动的 `lead-discovery` SKILL 循环；富集走 `ontologySync` 写时自动补全 + Provider Adapter 仅补缺口；评分 = 新 `decision_scenario(lead-fit)` 复用九标尺；写出过零信任第 0 闸；溯源经 `sourcedFrom` 边。设计基线见 `docs/2026-09-10-lead-discovery-design.md`（**v8.1 已批准**：自主循环主轴 + **C1 可组合编排层 / C2 Claygent+glass-box / C3 持续监控闭环** + **§12 行业包扩展 handbook 同步**）与配套自检 `docs/2026-09-10-lead-discovery-capability-audit.md`。

**Tech Stack:** Node 22 ESM、Express 4、PostgreSQL 16（pgvector+pgcrypto, schema crm, :5433, 连 localhost/::1）、vitest 3、现有 `getLlmJson` LLM 客户端、MCP（crm-native-mcp）。

**铁律（来自项目 memory，不可违反）：**
- 不新增粒子类型、不改业务域模型；写操作必经决策第 0 闸（HITL confirm_token）；绝对禁止 DELETE。
- 注册新 Action 必须过 **三处硬闭包**：`src/action/registry.js` registerAction + `src/agent/agentSpec.js` capabilities.actions/skillCalls + `src/skills/seed.js` SKILL steps。
- 配置驱动差异化：阈值/行业/provider 顺序 100% 后台 `config_store` 化，禁硬编码。
- 受保护 `src/context/routing.js` 的 `context-routing(id36)` **禁止修改**（2026-09-04 红线）。
- 多租户隔离：每次写/读透传 `ctx.tenantId`；`config_store` 按 `(tenant_id,key)` 隔离。
- 提交：AI 无 git 凭证，**提交命令由用户在本地 PowerShell 执行**；每 Task 一提交、显式路径 `git add`、禁 `git add -A`；本环境仅跑测试。
- **测试计划先于开发计划**：`docs/2026-09-10-lead-discovery-test-plan.md` 是本计划的前置件；某 Task 未先落测试即实现，视为违反铁律（RED→GREEN 不可跳）。
- **行业包扩展必须同步**：新增/扩展行业（`industry-onboarding` Runbook）须同步更新 handbook（双份对齐）+ 行业模板 `discovery` 段 + 打包版本链，否则 D1「按租户启用数据源」无落地通道（见 Task 21）。
- **测试目录 = `test/`（单数），测试文件后缀 = `.test.js`**（项目 550 个测试文件的实际约定）。

---

## Task 索引与 TDD 链路（21 Task）

> 测试断言 ID 见测试计划 `docs/2026-09-10-lead-discovery-test-plan.md` §4。

| Task | 主题 | 主测试文件（`test/`） | 依赖 |
|---|---|---|---|
| T1 | discovery-rules 配置键 + 按租户隔离 | `config/discoveryRules.test.js` | — |
| T2 | Provider Adapter Framework + waterfall | `connectors/discovery/waterfall.test.js`、`providerRegistry.test.js` | T1 |
| T3 | 起步适配器 ×4（email-verify/web-research/标讯/高德） | `connectors/discovery/adapters.test.js` | T2 |
| T4 | 溯源 2D + why_narrative + layer（P0#1） | `agent/discoverySchema.test.js` | T2 |
| T5 | discovery-* Action 三处硬闭包 | `action/discoveryActions.test.js` | T1 |
| T6 | LEAD_FIT decision_scenario 场景字典（seed.sql + test-setup.sql + pretest 三处幂等） | `test/decision/leadFitScenario.test.js` | T1 |
| T7 | 发现编排 + dedupResolver | `connectors/discovery/dedupResolver.test.js`、`orchestrator.test.js` | T3/T4/T6 |
| T8 | Claygent 研究 Action | `test/connectors/discovery/research.test.js` | T7 |
| T9 | 记忆捕获域 + L2 注入红线（P0#2） | `memory/discoveryCapture.test.js` | T4 |
| T10 | S1 衔接验证 | `connectors/discovery/s1Handoff.test.js` | T7 |
| T11 | ICP 自进化草稿→回测→HITL（P0#3）**（无 HITL 绝不生效）** | `evolution/icpSelfEvolution.test.js` | T6 |
| T12 | feedback-loop 指标模板 + evaluator（P0#4） | `feedback/discoveryMetrics.test.js` | T6/T7 |
| T13 | 前台门户页面 | `web/discoveryPage.test.js`、`http/discoveryRoutes.test.js` | T7 |
| T14 | 可组合编排引擎（C1） | `connectors/discovery/orchestrationCompiler.test.js` | T1 |
| T15 | Claygent glass-box（C2） | `agent/glassBox.test.js` | T4 |
| T16 | monitorAccount 持续监控闭环（C3） | `connectors/discovery/monitorAccount.test.js`、`memory/accountMemory.test.js` | T7/T15 |
| T17 | 后台配置页（5 TAB） | `web/discoveryRulesPage.test.js` | T1/T14 |
| T18 | ACTION 对外面（MCP 暴露 + 白名单 + 反爆炸） | `mcp/discoveryExpose.test.js` | T5 |
| T19 | buddy 应用 + 两个插件包同步 | `scripts/verify-plugin-zips.py`、`scripts/buddy-capsule-binding-check.mjs` | T5/T18 |
| T20 | 触点面端到端验收（HTTP + MCP） | `scripts/e2e-lead-discovery.mjs` | 全部 |
| **T21** | **行业包扩展 handbook 同步（v8.1 §12）** | `connectors/discovery/industryDiscovery.test.js`、`config/industryTemplateDiscovery.test.js` | T1 |

---

## File Structure

**新增文件**
- `src/connectors/discovery/providerAdapter.js` — Provider Adapter 统一接口契约与基类
- `src/connectors/discovery/providerRegistry.js` — 注册表读取（来自 `discovery-rules.providers`）+ 按租户解析 + cheapest-first 排序
- `src/connectors/discovery/waterfall.js` — 瀑布编排（逐字段 `costTier` 升序、**首命中即停**、成本计量；**不取并集覆盖**——与 Clay 成本语义一致）
- `src/connectors/discovery/adapters/emailVerify.js` — email-verify 适配器
- `src/connectors/discovery/adapters/webResearch.js` — web-research 适配器（Claygent 驱动）
- `src/connectors/discovery/adapters/tender.js` — 标讯适配器（复用 `tenderConnector`）
- `src/connectors/discovery/adapters/gaode.js` — 高德地理/工商适配器
- `src/connectors/discovery/dedupResolver.js` — 落库前查重解析器（**duplicateCriteria 配置驱动** + 确定性外部 id upsert + 并发唯一约束兜底，借鉴 Twenty flatObjectMetadata.duplicateCriteria / find-or-create；字段级合并策略预留设计，当前阶段不启用、零 DELETE）
- `test/connectors/discovery/dedupResolver.test.js` — 查重解析器单元/并发测试
- `src/skills/lead-discovery.js` — `lead-discovery` SKILL 定义（steps 引用 discovery-* actions）
- `src/agent/discoveryOrchestrator.js` — 发现编排（本体优先富集 + 瀑布 + 评分入 payload）
- `src/feedback/discoveryMetrics.js` — feedback-loop 指标模板 + evaluator（P0#4）
- `src/evolution/icpSelfEvolution.js` — ICP 自进化草稿→回测→HITL（P0#3；纯编排，store 注入）
- `src/evolution/icpStore.js` — ICP 自进化 store（`config_store['discovery-rules']` 读写 + `requireDecision('CALIBRATION_CHANGE')` 第 0 闸锚点）
- `src/scheduler/timers.js`（改）— `runRetroOnce` 增第 ③.5 段 ICP 自进化 pass（可注入 `icpFn` + 独立 catch，默认不产草稿）
- `src/connectors/discovery/orchestrationCompiler.js` — **C1 可组合编排引擎**：把 `discovery-rules.playbooks` 编译为四段原语（data→condition→ai→action）可执行计划（配置驱动、零核心改动）
- `src/agent/glassBox.js` — **C2 glass-box 可解释推理链**：每个评分/研究判定附 `rule_ref`+`j_score`+`trace`，与 P0#1 的 2D judge 同源
- `src/connectors/discovery/monitorAccount.js` — **C3 持续监控闭环**：信号/定时触发 `lead-fit` 重评分 + 增量 append 账户持久记忆 + glass-box 输出（禁 DELETE）
- `src/memory/accountMemory.js` — **C3 账户持久记忆**：append-only 写入 + 30 天蒸馏为 curated note（吸收 Clay Account Agent 持久记忆）
- `test/connectors/discovery/orchestrationCompiler.test.js`、`test/agent/glassBox.test.js`、`test/connectors/discovery/monitorAccount.test.js`、`test/memory/accountMemory.test.js` — C1/C2/C3 测试
- `src/web/discovery.html` + `src/http/discoveryRoutes.js` — **前台门户页面**（线索发现工作台 + 只读候选池端点）（Task 13）
- `src/web/discovery-rules.html` — **后台配置页**（5 TAB：ICP / 数据源分级 / 信号权重 / 查重条件 / 编排 playbooks）（Task 18）
- `src/action/discoveryActions.js` — discovery-* 动作（独立文件 + `seedDiscoveryActions()`，仿 `src/connectors/connectorActions.js`）（Task 5）
- `test/connectors/discovery/*.test.js`、`test/web/*.test.js`、`test/action/discoveryActions.test.js` — 各单元/集成测试
- `test/connectors/discovery/industryDiscovery.test.js` + `test/config/industryTemplateDiscovery.test.js` — **行业包扩展 handbook 同步**测试（Task 21）

**修改文件**
- `db/seed.sql` — 新增 `decision_scenario(lead-fit)` 行 + provider 注册种子（系统默认源）
- `db/seed/tenantDefaults.js` — `DEFAULT_TENANT_SEED_KEYS` 加 `discovery-rules`
- `src/agent/agentSpec.js:74-89` — `decision-agent` 的 `capabilities.actions`/`skillCalls` 加 `discovery-*`
- `src/skills/seed.js` — `lead-discovery` SKILL 注册（steps 加 `discovery-run` 等）
- `src/agent/agents.js:66` 与 `src/http/routes.js:467-469` — 调用 `seedDiscoveryActions()`（与 `seedActions()`/`seedConnectorActions()` 同处）
- `src/agent/eventTrigger.js` — 事件矩阵加行（**T16 落地**：C3 信号→重评分；**T6 不加**——`matchTrigger` 只读白名单闸会静默丢弃写 SKILL）
- `src/memory/capture.js` — `DEFAULT_CAPTURE_DOMAINS` 加 `discovery`
- `src/portal/configCenter.js:11-72` — `CONFIG_ITEMS` 加 id46 `discovery-rules`（**真实路径 `src/portal/`**）
- `src/http/configRouter.js:51-161` — 无需改本体；在 `src/http/routes.js:224` 附近挂 `createConfigRouter({key:'discovery-rules',...})`（**工厂 + deps 注入范式**）
- `src/config/discoveryRules.js`（新建）— `DEFAULT_DISCOVERY_RULES` + `mergedDiscoveryRules()`
- `src/action/whitelist.js` — discovery-* 写动作的 blast-radius 判定（默认 `human_gate`）
- `src/mcp/tools.js` — 验证 `agentTool:true` 动作自动暴露（+ 工具计数断言）
- `buddy-crm-manifest.json` — `home.workModes[].skills` + `home.workModes[].capsules[]` 加「线索发现」+ `market.skills`
- `src/web/buddy-crm-portal.html:54-94` — `CAPS` 加 discovery 项（**真实路径 `src/web/`**）
- `.workbuddy-plugin/plugin.json`（version 1.7.1→1.8.0）、`skills/crm-native/SKILL.md`（Action 读写清单）、`.workbuddy-plugin/agents/crm-native.md`、`connector/connector-meta.json`（version 1.5.0→1.6.0）、`scripts/verify-plugin-zips.py`（`expect_version` 1.7.1→1.8.0）
- `src/ontology/hooks.js` — 确认 `ontologySync` 已自动落 `CRM_KNOWLEDGE`（无需改，仅验证）
- `plugin-platform-admin/skills/industry-onboarding/SKILL.md`（新增 **Step 4C**）+ `plugin-platform-admin/skills/industry-onboarding/registry.json`（`version` 1.0.0→1.1.0）+ `plugin-platform-admin/.codebuddy-plugin/plugin.json` / `openclaw.plugin.json` / `package.json`（三处 `version` 1.1.1→**1.2.0**，须一次改齐）（**Task 21**）
- `.workbuddy/skills/new-industry-onboarding/SKILL.md` — 补 **Step 4C**（与平台侧同文）。⚠ 该文件被 `.gitignore:134`（`.workbuddy/`）忽略 ⇒ **运行时生效但不入库**；且其章节结构为 `Step 1..9`，**本无** Step 4B/4.5 ⇒ 不再要求"补 4B/4.5"（原表述为臆造对齐，已作废）（**Task 21**）
- `db/seed/discovery-rules-templates.js`（**新建**，7 行业 discovery 配置单一事实源，纯模块零 DB import）+ `db/seed/tenant-profile-{chemical,consult,consult2,demo,insmedi,meddev,training}.js` ×7（新增 `seed<X>Discovery` + `seed<X>Profile(tenantId, opts)` 守卫）+ `db/seed/tenant-profile-templates.mjs`（传 `{withDiscovery:false}` 防哨兵残留）—— **独立落 `discovery-rules` 键、不写 `tenant-profile`**（**Task 21**）
- `scripts/verify-plugin-zips.py:176` — `expect_version` 1.1.1→1.2.0 + 3 条**锚定**内容规则（Step 4C / discovery-rules / 付费源，第三元素锚定 `skills/industry-onboarding/SKILL.md`）+ `:15` docstring 补 Step 4C（**Task 21**）
- `dist/buddy-import/industry-config.json` — **只重生成、不入库**（`.gitignore:3` 覆盖 `dist/`）：入口是 `node scripts/pack-buddy-import.mjs`（读 `buddy-crm-manifest.json`）；T19 已把「线索发现」胶囊写入 manifest，故重生成即自动带上（15 胶囊）。`version` 保持 `1.0.0`（导入**格式**版本，非内容版本，bump 有平台校验风险）（**Task 21**）

---

## Task 1: discovery-rules 配置键 + 按租户隔离

**Files:**
- Create: `src/config/discoveryRules.js`
- Create: `test/config/discoveryRules.test.js`
- Modify: `db/seed/tenantDefaults.js`（`DEFAULT_TENANT_SEED_KEYS` 加 `discovery-rules`，并同步 `KEY_FLAG_MAP` 加旗标）
- Modify: `src/portal/configCenter.js`（`CONFIG_ITEMS` 加 id46；**真实路径是 `src/portal/`，非 `src/config/`**；当前 id 上限 45，故 46 可用）
- Modify: `src/http/routes.js`（前置结构校验中间件 + 挂载 `createConfigRouter` + serve 页面；仿 `:222-224` routing-explore 范式）
- Modify: `src/decision/policyVersion.js:29-33`（`POLICY_KEYS` 加 `discovery-rules`）
- ❌ **不修改** `src/http/configRouter.js`（守「不改共享路由本体」）

> **契约前提（源码核实，2026-09-10）**：`createConfigRouter({ key, role, level, decisionScene, secretFields, scope, resolve }, deps)`（`src/http/configRouter.js:51-54`）**无 `validate` 选项**；挂载恒为 `app.use(createConfigRouter({ ... }))`，路由内部自声明 `/api/config/${key}`（`:155-156`）。
> 故 PUT 结构校验**不得**塞进共享路由，改为在 `routes.js` 注册**同路径 `app.put` 前置中间件**（Express 按注册序执行，前置中间件先于 `app.use(router)`）——零共享代码改动。
>
> **测试计划对齐（TDD 先行）**：T1 ① 要求出厂默认含 **5 键**（`icp` / `providers` / `signals` / `duplicate_criteria` / **`playbooks`**）；T1 ③④ 与 §1 闸 3 要求 `mergedDiscoveryRules(tenantId)` **租户感知**（读 `config_store`，未配置租户懒克隆系统默认）。故本 Task 实现为「**纯合并函数 + 租户感知加载器**」双函数（对齐 `src/decision/retroTrigger.js:19-44` 范式）。

- [ ] **Step 1: Write the failing test**

```js
// test/config/discoveryRules.test.js
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_DISCOVERY_RULES, mergeDiscoveryRules, mergedDiscoveryRules,
} from '../../src/config/discoveryRules.js';

describe('discovery-rules · 出厂默认（T1 ① ②）', () => {
  it('五键齐：icp / providers / signals / duplicate_criteria / playbooks', () => {
    for (const k of ['icp', 'providers', 'signals', 'duplicate_criteria', 'playbooks']) {
      expect(DEFAULT_DISCOVERY_RULES[k]).toBeDefined();
    }
    expect(Array.isArray(DEFAULT_DISCOVERY_RULES.providers)).toBe(true);
    expect(Array.isArray(DEFAULT_DISCOVERY_RULES.playbooks)).toBe(true);
  });
  it('付费源出厂 enabled:false；系统默认源 enabled:true（D1）', () => {
    const byId = Object.fromEntries(DEFAULT_DISCOVERY_RULES.providers.map((p) => [p.id, p]));
    for (const id of ['clearbit', 'linkedin']) expect(byId[id].enabled).toBe(false);
    for (const id of ['email-verify', 'web-research', 'tender', 'gaode']) expect(byId[id].enabled).toBe(true);
  });
  it('三档 scope 正确：system / system-candidate / paid', () => {
    const byId = Object.fromEntries(DEFAULT_DISCOVERY_RULES.providers.map((p) => [p.id, p]));
    expect(byId.gaode.scope).toBe('system');
    expect(byId.attio.scope).toBe('system-candidate');
    expect(byId.clearbit.scope).toBe('paid');
  });
  it('查重条件为配置驱动列组（对齐 Twenty duplicateCriteria）', () => {
    expect(DEFAULT_DISCOVERY_RULES.duplicate_criteria.CRM_ACCOUNT).toEqual(
      [['external_id'], ['domain'], ['linkedin_url'], ['name']]
    );
  });
});

describe('discovery-rules · 合并与租户隔离（T1 ③ ④）', () => {
  it('mergeDiscoveryRules 按 id 覆盖 provider.enabled，不增删条数，且不改出厂默认', () => {
    const merged = mergeDiscoveryRules(DEFAULT_DISCOVERY_RULES, {
      icp: { min_confidence: 0.9 },
      providers: [{ id: 'attio', enabled: true }],
    });
    expect(merged.icp.min_confidence).toBe(0.9);
    expect(merged.providers.length).toBe(DEFAULT_DISCOVERY_RULES.providers.length);
    expect(merged.providers.find((p) => p.id === 'attio').enabled).toBe(true);
    expect(DEFAULT_DISCOVERY_RULES.icp.min_confidence).toBe(0.6); // 纯函数：出厂默认未被污染
    expect(DEFAULT_DISCOVERY_RULES.providers.find((p) => p.id === 'attio').enabled).toBe(false);
  });
  it('mergedDiscoveryRules 租户感知：A 的定制不出现在 B（注入式 deps，无 PG）', async () => {
    const store = { A: { value: { icp: { min_confidence: 0.95 } } }, B: null };
    const deps = { readConfig: async (key, { tenantId }) => store[tenantId] || null };
    const a = await mergedDiscoveryRules({ tenantId: 'A' }, deps);
    const b = await mergedDiscoveryRules({ tenantId: 'B' }, deps);
    expect(a.icp.min_confidence).toBe(0.95);
    expect(b.icp.min_confidence).toBe(DEFAULT_DISCOVERY_RULES.icp.min_confidence);
  });
  it('未配置租户懒克隆出厂默认（readConfig → null 时回退）', async () => {
    const deps = { readConfig: async () => null };
    const r = await mergedDiscoveryRules({ tenantId: 'fresh' }, deps);
    expect(r.providers.length).toBe(DEFAULT_DISCOVERY_RULES.providers.length);
  });
  it('读配置异常 fail-open：回退出厂默认而非抛出', async () => {
    const deps = { readConfig: async () => { throw new Error('pg down'); } };
    const r = await mergedDiscoveryRules({ tenantId: 'x' }, deps);
    expect(r.signals.funding_round.weight).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/config/discoveryRules.test.js`
Expected: FAIL — 模块不存在（`src/config/discoveryRules.js` 未建）

- [ ] **Step 3: Write minimal implementation**

```js
// src/config/discoveryRules.js
// 线索发现规则：ICP / 数据源三档 / 信号权重 / 查重条件 / 编排 playbooks
// 铁律：
//   1. 唯一事实源 = config_store['discovery-rules']（per-tenant）；本文件仅存「出厂默认」兜底
//   2. 阈值/权重/顺序 100% 配置化，禁硬编码（对齐 src/decision/retroTrigger.js:19-44 范式）
//   3. 付费源（scope='paid'）出厂 enabled:false，需显式授权 + 填 key（D1）
//   4. 租户隔离：(tenant_id, key) 收敛；system 仅作模板源（configStore.js:16-49 autoSeed 懒克隆）
import { readConfig as storeRead } from './configStore.js';

export const DEFAULT_DISCOVERY_RULES = Object.freeze({
  icp: {
    industries: ['industrial_coatings', 'chemical', 'additives'],
    min_headcount: 50,
    geo: ['CN'],
    min_confidence: 0.6,
  },
  // 三档数据源：system（出厂启用）/ system-candidate（按行业启用）/ paid（严禁默认启用）
  providers: [
    { id: 'email-verify', kind: 'email/phone',       scope: 'system',           costTier: 1, enabled: true },
    { id: 'web-research', kind: 'web/serp',          scope: 'system',           costTier: 0, enabled: true },
    { id: 'tender',       kind: 'internal-signal',   scope: 'system',           costTier: 0, enabled: true },
    { id: 'gaode',        kind: 'geo_firmographics', scope: 'system',           costTier: 1, enabled: true },
    { id: 'attio',        kind: 'firmographics',     scope: 'system-candidate', costTier: 2, enabled: false },
    { id: 'zhizao',       kind: 'biz-verify',        scope: 'system-candidate', costTier: 1, enabled: false },
    { id: 'clearbit',     kind: 'firmographics',     scope: 'paid',             costTier: 3, enabled: false },
    { id: 'linkedin',     kind: 'social',            scope: 'paid',             costTier: 3, enabled: false },
  ],
  signals: {
    funding_round:     { weight: 0.9 },
    hiring_icp_role:   { weight: 0.7 },
    tender_match:      { weight: 0.8 },
    leadership_change: { weight: 0.5 },
    tech_adopt:        { weight: 0.6 },
    website_redesign:  { weight: 0.3 },
  },
  // 查重条件（配置驱动列组；对齐 Twenty flatObjectMetadata.duplicateCriteria，禁硬编码匹配键）
  duplicate_criteria: {
    CRM_ACCOUNT: [['external_id'], ['domain'], ['linkedin_url'], ['name']],
    CRM_CONTACT: [['external_id'], ['email']],
  },
  // 可组合编排 playbooks（C1）：出厂不预置 —— Task 14 定义段 schema，Task 21 按行业播种
  playbooks: [],
});

// 纯函数合并：出厂默认 ⊕ 租户覆盖（无 IO，单测友好）
//   语义：icp/signals/duplicate_criteria 浅合并；providers 以 id 为键覆盖（**不增删条数**，防租户越权新增付费源）
export function mergeDiscoveryRules(base, tenantCfg = {}) {
  const out = structuredClone(base);
  if (tenantCfg.icp) Object.assign(out.icp, tenantCfg.icp);
  if (tenantCfg.signals) Object.assign(out.signals, tenantCfg.signals);
  if (tenantCfg.duplicate_criteria) Object.assign(out.duplicate_criteria, tenantCfg.duplicate_criteria);
  if (Array.isArray(tenantCfg.providers)) {
    const byId = Object.fromEntries(out.providers.map((p) => [p.id, p]));
    for (const p of tenantCfg.providers) {
      if (byId[p.id]) Object.assign(byId[p.id], p); // 仅覆盖既有 id
    }
  }
  if (Array.isArray(tenantCfg.playbooks)) out.playbooks = structuredClone(tenantCfg.playbooks);
  return out;
}

// 租户感知加载：读 config_store（自带 system 模板 autoSeed 懒克隆）⊕ 出厂默认
//   deps.readConfig 可注入 → 单测无需 PG；fail-open：读失败回退出厂默认，不阻断调用方
export async function mergedDiscoveryRules({ tenantId = 'system' } = {}, deps = {}) {
  try {
    const read = deps.readConfig || ((key, opts) => storeRead(key, opts));
    const row = await read('discovery-rules', { tenantId });
    return mergeDiscoveryRules(DEFAULT_DISCOVERY_RULES, row?.value || {});
  } catch {
    return structuredClone(DEFAULT_DISCOVERY_RULES);
  }
}
```

- [ ] **Step 4: 登记配置键（种子 / 配置中心 / 路由 / 策略快照）**

**(a) `db/seed/tenantDefaults.js`** — 加键 + 旗标（`DEFAULT_TENANT_SEED_KEYS` 由 8 键 → 9 键）：
```js
export const DEFAULT_TENANT_SEED_KEYS = [
  'sales-thresholds', 'named-account-targets', 'approval-config',
  'behavior-standard', 'finance-receivables', 'decision-retro',
  'agent-event-trigger', 'context-routing',
  'discovery-rules',   // 2026-09-10 新增：线索发现规则按租户差异化
];

// KEY_FLAG_MAP 必须同步加一行，否则 opts.discoveryRules 单键播种不生效
const KEY_FLAG_MAP = {
  // ...existing...
  'discovery-rules': 'discoveryRules',
};
```

**(b) `src/portal/configCenter.js`** — `CONFIG_ITEMS` 加 id46（**真实路径 `src/portal/`**；当前 id 上限 45）：
```js
{ id: 46, name: '线索发现规则', group: '智能体与运行', level: 'tenant', status: 'ready',
  page: '/discovery-rules.html', endpoint: '/api/config/discovery-rules', scope: 'tenant', resolve: 'tenant-first',
  note: 'ICP（行业/规模/地域/置信下限）、数据源三档（system/system-candidate/paid，付费源出厂 enabled:false 需显式授权）、信号权重、查重条件 duplicate_criteria（配置驱动，对齐 Twenty flatObjectMetadata.duplicateCriteria）、编排 playbooks（data→condition→ai→action）；config_store 承载，写经决策第0闸' },
```

**(c) `src/http/routes.js`** — 前置结构校验 + 挂载 + serve 页面（仿 `:222-224` routing-explore 范式）：
```js
// 线索发现规则后台化（配置中心 id46）：PUT 结构校验前置 —— 不修改共享 configRouter 本体
// Express 按注册序执行：本 app.put 先于下面的 app.use(router) 命中同路径，校验后 next() 交棒
app.put('/api/config/discovery-rules', (req, res, next) => {
  const v = req.body?.value;
  if (v && typeof v === 'object') {
    const missing = ['icp', 'providers', 'signals'].filter((k) => v[k] === undefined);
    if (missing.length) {
      return res.status(400).json({ error: `discovery-rules 缺结构键: ${missing.join(',')}` });
    }
  }
  next();
});
// GET/PUT /api/config/discovery-rules（写经决策第0闸 + sysadmin 闸；scope 默认 tenant = 租户级差分）
app.use(createConfigRouter({ key: 'discovery-rules', role: 'sysadmin', decisionScene: 'config-change' }));
app.get('/discovery-rules.html', (req, res) =>
  res.sendFile(fileURLToPath(new URL('../web/discovery-rules.html', import.meta.url))));
```
> 说明：`src/web/discovery-rules.html` 本体由 **Task 17** 交付；本 Task 先挂 serve 路由（文件暂缺属预期，不阻断测试）。

**(d) `src/decision/policyVersion.js:29-33`** — `POLICY_KEYS` 加键（发现规则是 `lead-fit` 决策输入，须冻结可追溯）：
```js
export const POLICY_KEYS = [
  'autonomy-conf', 'sales-thresholds', 'hindsight-deviation',
  'context-guard', 'context-routing', 'event-retro', 'agent-event-trigger',
  'price-authority',
  'discovery-rules', // 2026-09-10 新增：lead-fit 判定依据（信号权重/ICP/provider 序）；增键→后续决策解析新版本
];
```
> ⚠ **副作用（须用户知悉）**：`policyVersion.js:27` 已明示——增键会令所有后续决策解析出**新策略版本**（内容哈希变化）。这是期望行为（快照口径变了），先例 `price-authority`（2026-09-09，已获批）。若不予纳入，则本 Task 跳过 (d)，发现规则不参与决策冻结。

- [ ] **Step 5: Run tests to verify pass**

Run: `npx vitest run test/config/discoveryRules.test.js`
Expected: PASS（8 例）

- [ ] **Step 6: Commit (用户在本地 PowerShell 执行)**

```powershell
git add src/config/discoveryRules.js test/config/discoveryRules.test.js db/seed/tenantDefaults.js src/portal/configCenter.js src/http/routes.js src/decision/policyVersion.js
git commit -m "feat(discovery): add discovery-rules config key with tenant isolation + provider tiers (D1)"
```

---

## Task 2: Provider Adapter Framework（统一接口 + 注册表 + 瀑布）

> **契约以设计 v8.1 §3 为准**：`enrich(entity, fields, ctx) -> { [field]: { value, confidence, cost, provider, ts } }`（**非 `fetch`**；无命中返 `{}`）。
> **注册表自注册**：`providerRegistry.js` **不 import 任何 adapter 文件**（否则 Task 2 反向依赖 Task 3，模块图断裂）；适配器在 Task 3 加载时调用 `registerProvider(id, factory)` 自注册。
> **waterfall 返回 `{ values, cost, calls }`**：`values` 为扁平字段表；全 miss 时 `values={}`、`cost=0`，**不抛**；单源抛错不中断（记入 `calls[].error`）。

**Files:**
- Create: `src/connectors/discovery/providerAdapter.js`, `src/connectors/discovery/providerRegistry.js`, `src/connectors/discovery/waterfall.js`
- Test: `test/connectors/discovery/waterfall.test.js`, `test/connectors/discovery/providerRegistry.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/connectors/discovery/waterfall.test.js
import { describe, it, expect } from 'vitest';
import { runWaterfall } from '../../../src/connectors/discovery/waterfall.js';

const mkAdapter = (id, costTier, hit, log) => ({
  id, costTier, coverageFields: ['email', 'phone'],
  async enrich(entity, fields) {
    log.push([id, fields[0]]);
    return hit
      ? { [fields[0]]: { value: `${id}-val`, confidence: 0.9, cost: costTier, provider: id } }
      : {};
  },
});

describe('waterfall', () => {
  it('按 costTier 升序扫描，首个命中即停（更贵者不被调用）', async () => {
    const log = [];
    const adapters = [mkAdapter('a', 3, false, log), mkAdapter('c', 2, true, log), mkAdapter('b', 1, true, log)];
    const out = await runWaterfall(adapters, { name: 'X' }, ['email']);
    expect(out.values.email.provider).toBe('b'); // 最廉命中者胜
    expect(log.some(([id]) => id === 'c')).toBe(false); // c 从未被调用
    expect(out.cost).toBe(1);
    expect(out.calls.map((c) => c.provider)).toEqual(['b']);
  });

  it('不取并集覆盖：同字段只记最廉一次，第二源不被调用', async () => {
    const log = [];
    const adapters = [mkAdapter('a', 1, true, log), mkAdapter('b', 2, true, log)];
    const out = await runWaterfall(adapters, { name: 'X' }, ['email']);
    expect(out.values.email.provider).toBe('a');
    expect(log.filter(([, f]) => f === 'email').length).toBe(1);
  });

  it('多字段各自独立 waterfall，成本累计', async () => {
    const log = [];
    const adapters = [mkAdapter('a', 1, true, log), mkAdapter('b', 2, true, log)];
    const out = await runWaterfall(adapters, { name: 'X' }, ['email', 'phone']);
    expect(Object.keys(out.values)).toEqual(['email', 'phone']);
    expect(out.cost).toBe(2);
  });

  it('全 miss 返回空 values + cost 0，不抛', async () => {
    const log = [];
    const adapters = [mkAdapter('a', 1, false, log), mkAdapter('b', 2, false, log)];
    const out = await runWaterfall(adapters, { name: 'X' }, ['email']);
    expect(out.values).toEqual({});
    expect(out.cost).toBe(0);
    expect(out.calls.length).toBe(2);
  });

  it('单适配器抛错不中断，记入 calls[].error 后继续降级', async () => {
    const boom = { id: 'boom', costTier: 0, async enrich() { throw new Error('provider down'); } };
    const ok = mkAdapter('b', 1, true, []);
    const out = await runWaterfall([boom, ok], { name: 'X' }, ['email']);
    expect(out.values.email.provider).toBe('b');
    expect(out.calls.find((c) => c.provider === 'boom').error).toContain('provider down');
  });
});
```

```js
// test/connectors/discovery/providerRegistry.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerProvider, resolveAdapters, loadAdapters, _resetRegistry, listProviderIds,
} from '../../../src/connectors/discovery/providerRegistry.js';

const mkFactory = (id) => (cfg) => ({ id, costTier: cfg.costTier, cfg, async enrich() { return {}; } });
const RULES = {
  providers: [
    { id: 'cheap', costTier: 1, enabled: true },
    { id: 'mid', costTier: 2, enabled: true },
    { id: 'paid', costTier: 3, enabled: false },
    { id: 'unregistered', costTier: 1, enabled: true },
  ],
};

describe('providerRegistry', () => {
  beforeEach(() => _resetRegistry());

  it('只实例化 enabled 且已注册的适配器，按 costTier 升序', () => {
    registerProvider('cheap', mkFactory('cheap'));
    registerProvider('mid', mkFactory('mid'));
    registerProvider('paid', mkFactory('paid'));
    const out = resolveAdapters(RULES);
    expect(out.map((a) => a.id)).toEqual(['cheap', 'mid']); // paid disabled + unregistered 跳过
    expect(listProviderIds()).toContain('paid');
  });

  it('allowIds 可选过滤（C1 编排按 playbook 收窄数据源）', () => {
    registerProvider('cheap', mkFactory('cheap'));
    registerProvider('mid', mkFactory('mid'));
    expect(resolveAdapters(RULES, { allowIds: ['mid'] }).map((a) => a.id)).toEqual(['mid']);
  });

  it('适配器工厂收到该租户的 provider 配置', () => {
    registerProvider('cheap', mkFactory('cheap'));
    const [a] = resolveAdapters(RULES);
    expect(a.cfg.id).toBe('cheap');
    expect(a.cfg.costTier).toBe(1);
  });

  it('loadAdapters 走租户感知 mergedDiscoveryRules（A 租户启用不影响 B 租户）', async () => {
    registerProvider('attio', mkFactory('attio'));
    registerProvider('email-verify', mkFactory('email-verify'));
    const readConfig = async (key, { tenantId }) => ({
      value: tenantId === 'A' ? { providers: [{ id: 'attio', enabled: true }] } : {},
    });
    const A = await loadAdapters({ tenantId: 'A' }, { readConfig });
    const B = await loadAdapters({ tenantId: 'B' }, { readConfig });
    expect(A.map((a) => a.id)).toContain('attio');
    expect(B.map((a) => a.id)).not.toContain('attio');
  });

  it('rules 缺 providers 时不抛，返空数组', () => {
    expect(resolveAdapters({})).toEqual([]);
    expect(resolveAdapters(undefined)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/connectors/discovery/waterfall.test.js test/connectors/discovery/providerRegistry.test.js`
Expected: FAIL — `Cannot find module '../../../src/connectors/discovery/waterfall.js'`

- [ ] **Step 3: Write minimal implementation**

```js
// src/connectors/discovery/providerAdapter.js
// 统一接口（设计 v8.1 §3）：enrich(entity, fields, ctx) -> { [field]: { value, confidence, cost, provider, ts } }
// 铁律：无命中必须返回 {}（不是 null）；不得抛业务异常（waterfall 侧兜底，但适配器应自愈）
export class ProviderAdapter {
  constructor(cfg = {}) {
    this.id = cfg.id;
    this.kind = cfg.kind ?? 'unknown';
    this.scope = cfg.scope ?? 'system';
    this.costTier = Number.isFinite(cfg.costTier) ? cfg.costTier : 3;
    this.enabled = cfg.enabled !== false;
    this.coverageFields = Array.isArray(cfg.coverageFields) ? [...cfg.coverageFields] : [];
    this.credentialsRef = cfg.credentialsRef ?? null;
    this.config = cfg;
  }
  async enrich() { throw new Error(`[provider:${this.id}] enrich() not implemented`); }
}

// 统一结果条目构造：保证 6 元齐全（value/confidence/cost/provider/ts），防各适配器字段漂移
export function fieldHit(field, { value, confidence = 0.5, cost = 0, provider, ts } = {}) {
  return { [field]: { value, confidence, cost, provider, ts: ts || new Date().toISOString() } };
}
```

```js
// src/connectors/discovery/providerRegistry.js
// 注意：本模块 **不 import 任何 adapter 文件**（避免 Task 2 → Task 3 反向依赖）；
// 适配器在 Task 3 由各自模块加载时调用 registerProvider(id, factory) 自注册。
import { mergedDiscoveryRules } from '../../config/discoveryRules.js';

const REGISTRY = new Map();

export function registerProvider(id, factory) {
  if (!id || typeof factory !== 'function') throw new Error('registerProvider(id, factory) 参数非法');
  REGISTRY.set(id, factory);
  return factory;
}
export function listProviderIds() { return [...REGISTRY.keys()]; }
export function _resetRegistry() { REGISTRY.clear(); }

// 纯函数：enabled 过滤 → allowIds 过滤 → costTier 升序 → 实例化（零 IO，单测友好）
export function resolveAdapters(rules, { allowIds, registry = REGISTRY } = {}) {
  const providers = Array.isArray(rules?.providers) ? rules.providers : [];
  return providers
    .filter((p) => p && p.enabled && registry.has(p.id))     // 未注册 / disabled（付费源出厂 false）一律跳过
    .filter((p) => !Array.isArray(allowIds) || allowIds.includes(p.id))
    .slice()
    .sort((a, b) => (a.costTier ?? 3) - (b.costTier ?? 3))   // cheapest-first
    .map((p) => registry.get(p.id)(p));
}

// 租户感知加载：config_store['discovery-rules']（per-tenant）⊕ 出厂默认
export async function loadAdapters({ tenantId = 'system' } = {}, deps = {}) {
  const rules = await mergedDiscoveryRules({ tenantId }, deps);
  return resolveAdapters(rules, { allowIds: deps.allowIds, registry: deps.registry });
}
```

```js
// src/connectors/discovery/waterfall.js
// 瀑布补缺口：成本升序 → 逐字段首命中即停
// **不取并集覆盖**：同字段只记最廉命中一次（对齐 Clay 成本语义；费用不重复消耗）
export async function runWaterfall(adapters, entity, fields, ctx = {}) {
  const values = {};
  const calls = [];
  let cost = 0;
  const ordered = [...(adapters || [])].sort((a, b) => (a?.costTier ?? 3) - (b?.costTier ?? 3));

  for (const field of fields || []) {
    if (values[field]) continue;
    for (const ad of ordered) {
      const call = { provider: ad.id, field };
      calls.push(call);
      try {
        const r = await ad.enrich(entity, [field], ctx);
        const hit = r && r[field] && r[field].value != null;
        if (!hit) continue;
        values[field] = { ...r[field], cost: r[field].cost ?? 0, ts: r[field].ts || new Date().toISOString() };
        cost += values[field].cost;
        break; // 首命中即停
      } catch (err) {
        call.error = String(err?.message || err); // 单源失败不中断整条瀑布（fail-open）
      }
    }
  }
  return { values, cost, calls };
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run test/connectors/discovery/waterfall.test.js test/connectors/discovery/providerRegistry.test.js`
Expected: PASS（waterfall 5 例 + providerRegistry 5 例）
回归：`npx vitest run test/config/`（Task 1 的 8 例不得回退）

- [ ] **Step 5: Commit**

```powershell
git add src/connectors/discovery/providerAdapter.js src/connectors/discovery/providerRegistry.js src/connectors/discovery/waterfall.js test/connectors/discovery/waterfall.test.js test/connectors/discovery/providerRegistry.test.js
git commit -m "feat(discovery): provider adapter framework + self-registering registry + cheapest-first waterfall (D2/C1)"
```

---

## Task 3: 起步适配器（email-verify / web-research / 标讯 / 高德）

> **契约以设计 v8.1 §3.1 为准**（4 个系统默认档均「✅ 实现真实 fetch」，**不是**占位空实现）。
> **自注册**：每个适配器模块在加载时调用 `registerProvider(id, factory)`（Task 2 的注册表契约；注册表本身不 import 适配器，无环）。
> **六元归一**：一律用 `fieldHit(field, {...})` 产出 `{ value, confidence, cost, provider, ts }`。
> **无命中返 `{}`**（不是 `null`）；**绝不伪造字段/绝不伪称「已验证」**；网络失败 fail-open 不抛。
> **测试打桩范式**：本仓库既有范式为 `vi.stubGlobal('fetch', ...)`（见 `test/llm/client.test.js`）。
> **修正计划原文 2 处错误**：① 测试相对路径原写 `../../../../src/...`（4 级）→ 实际 `test/connectors/discovery/` 到仓库根是 **3 级** `../../../src/...`；② 标讯委托原写 `tenderConnector.matchTender(entity)` → 真实签名为 **`matchTender(sub, tender)` / `filterTenders(sub, tenders)`**（`src/connectors/tenderConnector.js:13,26`）。

**Files:**
- Create: `src/connectors/discovery/adapters/emailVerify.js`, `webResearch.js`, `tender.js`, `gaode.js`
- Test: `test/connectors/discovery/adapters.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/connectors/discovery/adapters.test.js — 单元（桩 HTTP / 注入研究通道，绝不触真实网络）
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { emailVerify } from '../../../src/connectors/discovery/adapters/emailVerify.js';
import { webResearch } from '../../../src/connectors/discovery/adapters/webResearch.js';
import { tenderAdapter } from '../../../src/connectors/discovery/adapters/tender.js';
import { gaodeAdapter } from '../../../src/connectors/discovery/adapters/gaode.js';
import { listProviderIds } from '../../../src/connectors/discovery/providerRegistry.js';

beforeEach(() => { delete process.env.GAODE_KEY; vi.restoreAllMocks(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('适配器统一契约（设计 v8.1 §3）', () => {
  it('4 适配器同契约：id / costTier / coverageFields / enrich', () => {
    const list = [
      emailVerify({ id: 'email-verify', costTier: 1, enabled: true }),
      webResearch({ id: 'web-research', costTier: 0, enabled: true }),
      tenderAdapter({ id: 'tender', costTier: 0, enabled: true }),
      gaodeAdapter({ id: 'gaode', costTier: 1, enabled: true, credentialsRef: 'env:GAODE_KEY' }),
    ];
    for (const a of list) {
      expect(typeof a.enrich).toBe('function');
      expect(Number.isFinite(a.costTier)).toBe(true);
      expect(Array.isArray(a.coverageFields) && a.coverageFields.length).toBeTruthy();
    }
  });

  it('模块加载即自注册：4 个 id 均在 Provider Registry', () => {
    const ids = listProviderIds();
    for (const id of ['email-verify', 'web-research', 'tender', 'gaode']) expect(ids).toContain(id);
  });
});

describe('email-verify（本地语法判定，不联网）', () => {
  it('命中：合法邮箱 → 六元齐全，confidence < 0.9（不伪称「已验证」）', async () => {
    const a = emailVerify({ id: 'email-verify', costTier: 1, enabled: true });
    const r = await a.enrich({ email: 'a@b.com' }, ['email'], {});
    expect(r.email.provider).toBe('email-verify');
    expect(r.email.value).toBe('a@b.com');
    expect(r.email.ts).toBeTruthy();
    expect(r.email.confidence).toBeLessThan(0.9);
  });

  it('无邮箱 / 语法非法 / 一次性域名 → 返 {}（不是 null）', async () => {
    const a = emailVerify({ id: 'email-verify', costTier: 1, enabled: true });
    expect(await a.enrich({}, ['email'], {})).toEqual({});
    expect(await a.enrich({ email: 'not-an-email' }, ['email'], {})).toEqual({});
    expect(await a.enrich({ email: 'x@mailinator.com' }, ['email'], {})).toEqual({});
  });

  it('未请求 email 字段 → 不做事，返 {}', async () => {
    const a = emailVerify({ id: 'email-verify', costTier: 1, enabled: true });
    expect(await a.enrich({ email: 'a@b.com' }, ['phone'], {})).toEqual({});
  });
});

describe('web-research（Claygent 委托，无通道不伪造）', () => {
  it('委托 ctx.research 并归一化为六元', async () => {
    const research = vi.fn(async () => ({ tech_stack: { value: 'k8s', confidence: 0.8, cost: 0 } }));
    const a = webResearch({ id: 'web-research', costTier: 0, enabled: true });
    const r = await a.enrich({ name: 'X' }, ['tech_stack'], { research });
    expect(research).toHaveBeenCalledTimes(1);
    expect(r.tech_stack.provider).toBe('web-research');
    expect(r.tech_stack.value).toBe('k8s');
    expect(r.tech_stack.ts).toBeTruthy();
  });

  it('无研究通道 → fail-open 返 {}（绝不伪造字段）', async () => {
    const a = webResearch({ id: 'web-research', costTier: 0, enabled: true });
    expect(await a.enrich({ name: 'X' }, ['tech_stack'], {})).toEqual({});
  });

  it('研究通道抛错 → 返 {}，不向上抛', async () => {
    const a = webResearch({ id: 'web-research', costTier: 0, enabled: true });
    const research = vi.fn(async () => { throw new Error('llm down'); });
    expect(await a.enrich({ name: 'X' }, ['tech_stack'], { research })).toEqual({});
  });
});

describe('tender（复用既有 tenderConnector 管道）', () => {
  it('委托 filterTenders：标题关键词 + 区域真过滤，命中取首条', async () => {
    const a = tenderAdapter({ id: 'tender', costTier: 0, enabled: true });
    const ctx = {
      tenderSubscription: { keywords: ['涂料'], region: '北京' },
      tenders: [
        { id: 'T1', title: '某涂料厂招标', region: '北京市', amount: 100 },
        { id: 'T2', title: '无关钢材采购', region: '上海市' },
      ],
    };
    const r = await a.enrich({ name: 'X' }, ['tender_match'], ctx);
    expect(r.tender_match.provider).toBe('tender');
    expect(r.tender_match.value).toBe('某涂料厂招标');
    expect(r.tender_match.ts).toBeTruthy();
  });

  it('无命中 → {}', async () => {
    const a = tenderAdapter({ id: 'tender', costTier: 0, enabled: true });
    expect(await a.enrich({ name: 'X' }, ['tender_match'], { tenders: [] })).toEqual({});
  });

  it('tender_signals：返回命中聚合（tender_id / keyword / amount）', async () => {
    const a = tenderAdapter({ id: 'tender', costTier: 0, enabled: true });
    const ctx = { tenderSubscription: { keywords: [] }, tenders: [{ id: 'T9', title: '任意标讯', region: '北京', amount: 5 }] };
    const r = await a.enrich({ name: 'X' }, ['tender_signals'], ctx);
    expect(Array.isArray(r.tender_signals.value)).toBe(true);
    expect(r.tender_signals.value[0].tender_id).toBe('T9');
  });
});

describe('gaode（桩 HTTP，不触真实网络）', () => {
  it('地址 → geo_coord + registered_address（第二字段 cost=0，同次调用不重复计费）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ status: '1', geocodes: [{ location: '116.48,39.99', formatted_address: '北京市朝阳区' }] }),
    })));
    process.env.GAODE_KEY = 'test-key';
    const a = gaodeAdapter({ id: 'gaode', costTier: 1, enabled: true, credentialsRef: 'env:GAODE_KEY' });
    const r = await a.enrich({ registered_address: '北京市朝阳区' }, ['geo_coord', 'registered_address'], {});
    expect(r.geo_coord.provider).toBe('gaode');
    expect(r.geo_coord.value).toBe('116.48,39.99');
    expect(r.geo_coord.cost).toBe(1);
    expect(r.registered_address.cost).toBe(0);
  });

  it('无 key → 不发起任何网络请求，返 {}', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    const a = gaodeAdapter({ id: 'gaode', costTier: 1, enabled: true });
    expect(await a.enrich({ registered_address: '北京市朝阳区' }, ['geo_coord'], {})).toEqual({});
    expect(spy).not.toHaveBeenCalled();
  });

  it('HTTP 抛错 / 状态非 1 → fail-open 返 {}，不抛', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('net down'); }));
    process.env.GAODE_KEY = 'test-key';
    const a = gaodeAdapter({ id: 'gaode', costTier: 1, enabled: true });
    expect(await a.enrich({ registered_address: '北京市朝阳区' }, ['geo_coord'], {})).toEqual({});

    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ status: '0', info: 'INVALID_USER_KEY' }) })));
    expect(await a.enrich({ registered_address: '北京市朝阳区' }, ['geo_coord'], {})).toEqual({});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/connectors/discovery/adapters.test.js`
Expected: FAIL — `Cannot find module '../../../src/connectors/discovery/adapters/emailVerify.js'`

- [ ] **Step 3: Write minimal implementations**（4 个文件，各文件末尾调用 `registerProvider`）

```js
// src/connectors/discovery/adapters/emailVerify.js
// 只补「本体推断不出」的邮箱可信度。诚实原则：本地仅做语法 + 一次性域名判定（confidence 0.6），
// **不得伪称「已验证」**；真实验证 API 经 ctx.verifyEmail 注入（出厂不联网、零成本）。
import { ProviderAdapter, fieldHit } from '../providerAdapter.js';
import { registerProvider } from '../providerRegistry.js';

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const DEFAULT_DISPOSABLE_DOMAINS = ['mailinator.com', 'guerrillamail.com', '10minutemail.com', 'tempmail.com'];

export function localEmailCheck(email, disposable = DEFAULT_DISPOSABLE_DOMAINS) {
  const e = String(email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(e)) return { valid: false, reason: 'syntax' };
  const domain = e.split('@')[1];
  if (disposable.includes(domain)) return { valid: false, reason: 'disposable' };
  return { valid: true, reason: 'syntax-only', confidence: 0.6 };
}

export function emailVerify(cfg = {}) {
  return new (class extends ProviderAdapter {
    constructor() {
      super({ id: 'email-verify', kind: 'email/phone', scope: 'system', costTier: 1,
              coverageFields: ['email', 'phone'], ...cfg });
    }
    async enrich(entity, fields = [], ctx = {}) {
      if (!fields.includes('email')) return {};
      const email = entity?.email;
      if (!email) return {};
      const disposable = this.config.disposableDomains || DEFAULT_DISPOSABLE_DOMAINS;
      let check;
      try {
        check = typeof ctx.verifyEmail === 'function'
          ? await ctx.verifyEmail(email, ctx)                  // 真实验证 API（编排侧注入）
          : localEmailCheck(email, disposable);                // 出厂：纯本地、确定性、不联网
      } catch { return {}; }
      if (!check || !check.valid) return {};
      return fieldHit('email', { value: email, confidence: check.confidence ?? 0.6, cost: check.cost ?? 0, provider: this.id });
    }
  })();
}

registerProvider('email-verify', emailVerify);
```

```js
// src/connectors/discovery/adapters/webResearch.js
// Claygent 的真实研究在 Task 8 的 discovery-research Action；本适配器只做「编排侧注入的抽取通道」委托。
// 无通道 → {}（fail-open），绝不伪造字段。
import { ProviderAdapter, fieldHit } from '../providerAdapter.js';
import { registerProvider } from '../providerRegistry.js';

export function webResearch(cfg = {}) {
  return new (class extends ProviderAdapter {
    constructor() {
      super({ id: 'web-research', kind: 'web/serp', scope: 'system', costTier: 0,
              coverageFields: ['tech_stack', 'hiring_signal', 'website_change', 'description'], ...cfg });
    }
    async enrich(entity, fields = [], ctx = {}) {
      const research = ctx.research || this.config.research;
      if (typeof research !== 'function') return {};
      let raw;
      try { raw = await research(entity, fields, ctx); } catch { return {}; }
      const out = {};
      for (const f of fields) {
        const v = raw?.[f];
        if (v == null) continue;
        const entry = typeof v === 'object' ? v : { value: v };
        if (entry.value == null) continue;
        Object.assign(out, fieldHit(f, {
          value: entry.value,
          confidence: entry.confidence ?? 0.6,
          cost: entry.cost ?? 0,
          provider: entry.provider || this.id,
        }));
      }
      return out;
    }
  })();
}

registerProvider('web-research', webResearch);
```

```js
// src/connectors/discovery/adapters/tender.js
// 内部信号源：**复用**既有 tenderConnector 管道（filterTenders → matchTender），不重复造匹配逻辑。
// 铁律：不在此发起网络请求（外部标讯由订阅推送进总线，编排侧经 ctx.tenders 注入命中流）。
import { ProviderAdapter, fieldHit } from '../providerAdapter.js';
import { registerProvider } from '../providerRegistry.js';
import { filterTenders } from '../../tenderConnector.js';

export function tenderAdapter(cfg = {}) {
  return new (class extends ProviderAdapter {
    constructor() {
      super({ id: 'tender', kind: 'internal-signal', scope: 'system', costTier: 0,
              coverageFields: ['tender_match', 'tender_signals'], ...cfg });
    }
    async enrich(entity, fields = [], ctx = {}) {
      const sub = ctx.tenderSubscription || this.config.subscription || { keywords: [], region: '' };
      const hits = filterTenders(sub, ctx.tenders || []);   // 委托既有管道（关键词 + 区域）
      if (!hits.length) return {};
      const out = {};
      if (fields.includes('tender_match')) {
        Object.assign(out, fieldHit('tender_match', { value: hits[0].title, confidence: 0.8, cost: 0, provider: this.id }));
      }
      if (fields.includes('tender_signals')) {
        Object.assign(out, fieldHit('tender_signals', {
          value: hits.map((h) => ({ tender_id: h.id, keyword: h.matched_keyword, amount: h.amount ?? null })),
          confidence: 0.8, cost: 0, provider: this.id,
        }));
      }
      return out;
    }
  })();
}

registerProvider('tender', tenderAdapter);
```

```js
// src/connectors/discovery/adapters/gaode.js
// 地理/工商定位（系统默认档）。铁律：无 key 绝不发起请求；网络/JSON/业务失败一律 fail-open 返 {}。
import { ProviderAdapter, fieldHit } from '../providerAdapter.js';
import { registerProvider } from '../providerRegistry.js';

const AMAP_GEOCODE = 'https://restapi.amap.com/v3/geocode/geo';

export function gaodeAdapter(cfg = {}) {
  return new (class extends ProviderAdapter {
    constructor() {
      super({ id: 'gaode', kind: 'geo_firmographics', scope: 'system', costTier: 1,
              coverageFields: ['registered_address', 'geo_coord', 'industry_zone'], ...cfg });
    }
    async enrich(entity, fields = [], ctx = {}) {
      const key = ctx.gaodeKey || process.env.GAODE_KEY;
      if (!key) return {};                                   // 无凭据 → 零请求
      const wants = ['geo_coord', 'registered_address'].filter((f) => fields.includes(f));
      if (!wants.length) return {};
      const q = entity?.registered_address || entity?.name;
      if (!q) return {};
      let res;
      try {
        const r = await fetch(`${AMAP_GEOCODE}?key=${key}&address=${encodeURIComponent(q)}`);
        if (!r.ok) return {};
        res = await r.json();
      } catch { return {}; }
      if (res?.status !== '1' || !res.geocodes?.length) return {};
      const gc = res.geocodes[0];
      const out = {};
      // 同一次 API 调用产出的字段：首个计费，其余 cost=0（不重复计费）
      if (fields.includes('geo_coord')) {
        Object.assign(out, fieldHit('geo_coord', { value: gc.location, confidence: 0.9, cost: this.costTier, provider: this.id }));
      }
      if (fields.includes('registered_address')) {
        Object.assign(out, fieldHit('registered_address', { value: gc.formatted_address, confidence: 0.9, cost: 0, provider: this.id }));
      }
      return out;
    }
  })();
}

registerProvider('gaode', gaodeAdapter);
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run test/connectors/discovery/adapters.test.js`
Expected: PASS（14 例）
回归：`npx vitest run test/connectors/discovery/`（Task 3 的 14 + Task 2 的 10 = 24 例，Task 2 不得回退）

- [ ] **Step 5: Commit**

```powershell
git add src/connectors/discovery/adapters/ test/connectors/discovery/adapters.test.js
git commit -m "feat(discovery): 4 starter adapters email-verify/web-research/tender/gaode with self-registration (D2)"
```

---

## Task 4: 溯源 2D + why_narrative + layer（P0 #1）

**Files:**
- New: `src/agent/discoverySchema.js`（2D payload 组装辅助；供 Task 7 orchestrator / Task 15 glassBox / Task 16 monitorAccount 复用）
- Test: `test/agent/discoverySchema.test.js`
- 说明（派发前复查裁定）：本 Task **不修改** `src/agent/discoveryOrchestrator.js`（Task 7 才创建，改了就是反向依赖）；也 **不修改** `src/connectors/tenderConnector.js`（源码 `tenderConnector.js:51 createLeadFromTender` 已内置 `sourcedFrom` 边 + `auto_weak`/低置信 review，§5 溯源**复用即可**，无需改动）。

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect } from 'vitest';
import { buildEnrichmentPayload, buildDiscoveryPayload, LAYERS } from '../../src/agent/discoverySchema.js';

describe('P0#1 2D judge', () => {
  it('enrichment field carries six elements incl. ts/layer/source', () => {
    const p = buildEnrichmentPayload({ industry: { value: 'X', provider: 'attio', confidence: 0.9 } });
    for (const k of ['value', 'provider', 'confidence', 'ts', 'layer', 'source']) {
      expect(p.industry[k], k).toBeDefined();
    }
    expect(p.industry.layer).toBe('L2');
    expect(p.industry.source).toBe('ontologySync');
  });
  it('non-ontology provider defaults to source=provider_adapter', () => {
    const p = buildEnrichmentPayload({ email: { value: 'a@b.com', provider: 'email-verify', confidence: 0.6 } });
    expect(p.email.source).toBe('provider_adapter');
  });
  it('explicit layer honored; illegal layer throws (no silent fake-green)', () => {
    expect(buildEnrichmentPayload({ x: { value: 1, provider: 'p', confidence: 0.5, layer: 'L3' } }).x.layer).toBe('L3');
    expect(() => buildEnrichmentPayload({ x: { value: 1, provider: 'p', confidence: 0.5, layer: 'L9' } })).toThrow();
  });
  it('discovery score carries 2D judge axis + rule_ref', () => {
    const d = buildDiscoveryPayload(0.82, 0.64, [{ type: 'funding_round' }], 'dec_1');
    for (const k of ['axis', 'rule_ref', 'j_score']) expect(d.icp_fit_score.judge[k], k).toBeDefined();
    expect(d.icp_fit_score.judge.axis).toBe('capability');
    expect(d.intent_score.judge.rule_ref).toContain('ruler:');
  });
  it('why_narrative non-empty and carries rule_ref + decision_id', () => {
    const d = buildDiscoveryPayload(0.82, 0.64, [{ type: 'funding_round' }], 'dec_1');
    expect(d.why_narrative.length).toBeGreaterThan(0);
    expect(d.why_narrative).toContain('dec_1');
    expect(d.why_narrative).toContain('ruler:');
  });
  it('layer enum is L1-L4', () => {
    expect(LAYERS).toEqual(['L1', 'L2', 'L3', 'L4']);
  });
});
```

- [ ] **Step 2: Run test** → FAIL（`Cannot find module '../../src/agent/discoverySchema.js'`）

- [ ] **Step 3: Implement `src/agent/discoverySchema.js`**

```js
// src/agent/discoverySchema.js — 线索发现 payload 组装（P0#1：AI 属性 2D + glass-box why_narrative）
// 设计：docs/2026-09-10-lead-discovery-design.md §5（数据模型 2D）+ §4（C2 glass-box 推理链）
// 铁律：纯函数、零副作用、不触 DB、不新增粒子；无行业/租户字面量。
// 复用点：Task 7 orchestrator（import './discoverySchema.js'）、Task 15 glassBox、Task 16 monitorAccount。

// 知识资产分层（与 src/agent/agents.js:19 KG_LAYER_ORDER 同口径）
export const LAYERS = ['L1', 'L2', 'L3', 'L4'];

// 「本体同步」来源的 provider：其数据由 src/ontology/hooks.js:39 ontologySync 写时入图，
//   故 source 轴记 'ontologySync'（非 'provider_adapter'）。attio 为例（设计 §5 示例逐字）。
export const ONTOLOGY_SYNC_PROVIDERS = ['attio', 'ontologySync', 'native'];

const sourceOf = (v) => v.source || (ONTOLOGY_SYNC_PROVIDERS.includes(v.provider) ? 'ontologySync' : 'provider_adapter');

// 富集字段 2D：来源轴（provider / confidence / ts）+ 能力轴（layer / source）
export function buildEnrichmentPayload(fields, { ts } = {}) {
  const now = ts || new Date().toISOString();
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) {
    const layer = v.layer || 'L2';
    // 非法 layer 显式抛错：layer 决定 L1–L4 检索语义，静默改写 = 假绿
    if (!LAYERS.includes(layer)) throw new TypeError(`invalid layer: ${layer} (expected ${LAYERS.join('/')})`);
    out[k] = { ...v, ts: v.ts || now, layer, source: sourceOf(v) };
  }
  return out;
}

// 发现评分 2D：value（来源轴）+ judge（能力轴 axis/rule_ref/j_score），并产 glass-box why_narrative。
// ruleRef 可覆盖（scenario/ruler 由 decision_scenario 侧配置驱动，C1）。
export function buildDiscoveryPayload(fit, intent, signals, decisionId, { ruleRef = {} } = {}) {
  const refFit = ruleRef.fit || 'scenario:lead-fit#ruler:industry';
  const refIntent = ruleRef.intent || 'scenario:lead-fit#ruler:hiring';
  const list = Array.isArray(signals) ? signals : [];
  return {
    icp_fit_score: { value: fit, judge: { axis: 'capability', rule_ref: refFit, j_score: fit } },
    intent_score: { value: intent, judge: { axis: 'capability', rule_ref: refIntent, j_score: intent } },
    signals: list,
    why_narrative: `由 discovery scenario 判定为目标客户（rule_ref=${refFit}；decision_id=${decisionId}）；信号=${list.map((s) => s.type).join(',')}`,
  };
}
```

- [ ] **Step 4: Run test** → PASS（6 例）

- [ ] **Step 5: Commit**

```powershell
git add src/agent/discoverySchema.js test/agent/discoverySchema.test.js
git commit -m "feat(discovery): P0#1 enrichment 2D + judge rule_ref + glass-box why_narrative"
```

---

## Task 5: discovery-* Action 三处硬闭包注册

**Files:**
- Create: `src/action/discoveryActions.js` — `seedDiscoveryActions()`；**仿 `src/connectors/connectorActions.js` 同构范式**（独立文件 + 独立 seed 函数，不塞进 2000+ 行的 `seed-actions.js`）
- Modify: `src/agent/agents.js:66`（`seedActions()` 之后）、`src/http/routes.js:485`（`seedConnectorActions()` 之后；import 加在 `:18` 附近）、`src/agent/agentSpec.js`（`decision-agent` capabilities 两数组）、`src/skills/seed.js`（`lead-discovery` SKILL steps）
- Test: `test/action/discoveryActions.test.js`

> **契约校正声明（派发前源码级复查，2026-09-11；6 条，全部经源码实证）**
> ① `registerAction` 真实签名 = **平铺对象** + `kind/permission/namespace/agentTool/handler`（`registry.js:6-22`、`connectorActions.js:17-32` 实证），**不是** `{schema:{type,properties}, run(ctx,input)}`；`namespace` 缺省由 name 前缀自动推导（`registry.js:20`，`discovery-*` → `discovery`）。
> ② `registerSkill` 真实签名 `{slug, version, steps[], enabled?, rbac_roles?, description?}`（`skills/registry.js:24-30`）；steps 项 = `{step, action, decision, params, prompt?, preconditions, postconditions}`（`seed.js:8-17` 实证）。
> ③ **硬错：`assertAgentAssembly()` 是 `async`**（`agents.js:64 export async function`）→ 测试必须 `await`，否则 `.ok` 恒 `undefined`、断言恒红（原稿直接 `assertAgentAssembly().ok`）。
> ④ **硬错：决策场景 id 冻结为 `'LEAD_FIT'`**（UPPER_SNAKE）。真实 `crm.decision_scenario` 键**全为 UPPER_SNAKE**（`db/seed.sql:227-233`：`LEAD_FOLLOW_UP`/`OPP_QUALIFY`/`CLIENT_STRATEGY`…），且 `executor.js:65 getScenario()` 是**精确匹配** `WHERE scenario_id=$1`。原稿 `'LEAD_DISCOVERY'` 与 Task 6 要 seed 的 `'lead-fit'` **两边都对不上** → 运行时 `executor.js:71` 走 else 分支**静默不 mint**（只 emit trace），写通道第 0 闸形同虚设。Task 6 / Task 18 已同步改齐为 `LEAD_FIT`。
> ⑤ 下游真实签名（防本 Task 写死错误调用）：`runDiscovery(ctx, input)`（Task 7）、**`claygentResearch(entity, brief, { getLlmJson })` 且模块是 `src/connectors/discovery/claygent.js`**（Task 8）——原稿 `claygentResearch(ctx, input)` 是**错序错模块**；`loadAdapters({tenantId})` + `runWaterfall(adapters, entity, fields, ctx)`（Task 2 已落地）；`selectPlaybook(rules, signals)`（Task 14 真实签名，原稿 `selectPlaybook('enrich', {tenantId})` 错）；`getLlmJson(opts)`（`src/llm/client.js:110`）。原稿 `plan.adapters` / `plan.fields` 字段在 `compilePlaybook()` 返回体里**不存在**（真实返回 `{name, steps[]}`），故本 Task **不前置依赖 Task 14**，enrich 直接走 Task 2 的 `loadAdapters`。
> ⑥ **`lead-discovery` 不得写进 `skillCalls`**：`assertAgentAssembly` 断言 3（`agents.js:72-78`）要求 `skillCalls ⊆ capabilities.actions`，断言 4（`:81-88`）要求每个 `actions` 项都在 Registry 存在；平台既有惯例是「method-* SKILL slug **同时**登记为同名 Action」才能进 `skillCalls`。本 Task 只把 3 个 `discovery-*` **Action** 写进两数组，SKILL slug 仅经 `registerSkill` 登记（硬闭包 3）。→ **遗留项（交 T6/T7）**：若 `lead-discovery` 需被 agent 自动选中（`agentSkillAllowed` 闸 `skills/registry.js:17-23`），须按 method-* 三处同改惯例补一个同名 Action；否则该 SKILL 只经 MCP 人工调用（`rbac_roles` 已含 `sales`）。

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect, beforeAll } from 'vitest';
import { getAction } from '../../src/action/registry.js';
import { seedDiscoveryActions } from '../../src/action/discoveryActions.js';
import { assertAgentAssembly } from '../../src/agent/agents.js';
import { agentSpecs } from '../../src/agent/agentSpec.js';
import { seedSkills } from '../../src/skills/seed.js';
import { getSkill } from '../../src/skills/registry.js';

beforeAll(() => { seedDiscoveryActions(); seedSkills(); });

const NAMES = ['discovery-run', 'discovery-enrich', 'discovery-research'];
const FLAT_FIELDS = ['kind', 'permission', 'namespace', 'agentTool', 'handler', 'schema'];

describe('discovery actions hard closures', () => {
  it('① discovery-* registered in Action Registry', () => {
    for (const n of NAMES) expect(getAction(n), n).not.toBeNull();
  });
  it('④ flat def fields present (non JSON-Schema) + namespace 自动推导', () => {
    const a = getAction('discovery-run');
    for (const k of FLAT_FIELDS) expect(a[k], k).toBeDefined();
    expect(a.namespace).toBe('discovery');
    expect(a.kind).toBe('write');
    expect(a.permission).toBe('auth');
  });
  it('② assertAgentAssembly passes with discovery actions wired', async () => {
    const r = await assertAgentAssembly();   // ⚠ async：必须 await（原稿漏 await → 假红）
    expect(r.ok).toBe(true);
  });
  it('③ skillCalls ⊆ capabilities.actions（discovery-* 两数组同改）', () => {
    const spec = agentSpecs['decision-agent'];
    for (const c of spec.capabilities.skillCalls) expect(spec.capabilities.actions, c).toContain(c);
    for (const n of NAMES) expect(spec.capabilities.skillCalls, n).toContain(n);
  });
  it('⑤ lead-discovery SKILL registered (slug 精确匹配)', () => {
    expect(getSkill('lead-discovery')).not.toBeNull();
    expect(getSkill('lead-discovery').slug).toBe('lead-discovery');
  });
});
```

- [ ] **Step 2: Run test** → FAIL（`Cannot find module '../../src/action/discoveryActions.js'`）

- [ ] **Step 3: Create `src/action/discoveryActions.js`**

```js
// src/action/discoveryActions.js — 线索自主发现 Action 族
// 铁律（逐条继承 connectors/connectorActions.js:1-7）：
//   ① 写通道第 0 闸（autoDecision=true + decisionScenario → executor.js:64-70 统一 mint，无决策不写）
//   ② 外部数据只落 payload 事实字段 + sourcedFrom 弱边（auto_weak；relation_confidence 落边 meta）
//   ③ 低置信 → confirm 信号（stage2 review），绝不冒充人工确认
//   ④ 禁删：只增改，不删除粒子/边
import { registerAction } from './registry.js';
import { createEdge } from '../particles/particleRepo.js';

// 决策场景 id（UPPER_SNAKE，与 db/seed.sql 的 crm.decision_scenario 键同源；Task 6 落 'LEAD_FIT' 行）。
const DISCOVERY_SCENARIO = 'LEAD_FIT';

// 写通道 fail-closed 守卫：executor 已 mint 时 ctx.decision_id 必有值（executor.js:68-70）。
//   为 undefined 说明场景行缺失 → executor.js:71 只会 emit trace 'auto-decision-no-scenario'
//   然后**照常执行 handler**（静默无决策写）。此处把静默失败顶成硬错，不留假绿。
function requireMintedDecision(ctx, actionName) {
  if (!ctx?.decision_id) {
    throw new Error(
      `decision_required: ${actionName} 无 decision_id（检查 crm.decision_scenario 是否已 seed '${DISCOVERY_SCENARIO}'）`
    );
  }
}

function registerDiscovery(def) {
  registerAction({
    kind: 'write', permission: 'auth', requiresEntitlement: ['core_crm'],
    namespace: 'discovery', agentTool: true, force: false, needsApproval: true,
    autoDecision: true, confirm: 'stage2', owner: 'crm-native', version: '1.0.0',
    autoWeakEdge: true, weakPredicate: 'sourcedFrom',
    decisionScenario: DISCOVERY_SCENARIO,
    schema: {}, parameters: { required: [] },
    ...def,
  });
}

export function seedDiscoveryActions() {
  // discovery-run：一次自主发现（本体优先富集 + 缺口瀑布 + 评分入 payload）
  registerDiscovery({
    name: 'discovery-run',
    schema: { tenant_id: 'string', seed: 'object', limit: 'number' },
    parameters: { required: ['seed'] },
    handler: async (input, ctx) => {
      requireMintedDecision(ctx, 'discovery-run');
      // Task 7 落地；动态 import → 注册期零模块依赖（Task 5 可独立绿）
      const { runDiscovery } = await import('../agent/discoveryOrchestrator.js');
      return runDiscovery(ctx, input);
    },
  });

  // discovery-enrich：对指定 account 执行一次瀑布富集（写 payload + sourcedFrom 弱边）
  registerDiscovery({
    name: 'discovery-enrich',
    schema: { account_id: 'string', fields: 'array' },
    parameters: { required: ['account_id'] },
    handler: async ({ account_id, fields }, ctx) => {
      requireMintedDecision(ctx, 'discovery-enrich');
      const { loadAdapters } = await import('../connectors/discovery/providerRegistry.js');
      const { runWaterfall } = await import('../connectors/discovery/waterfall.js');
      const { buildEnrichmentPayload } = await import('../agent/discoverySchema.js');
      const adapters = await loadAdapters({ tenantId: ctx.tenantId });
      const entity = (ctx.getParticle ? await ctx.getParticle(account_id) : null) || { id: account_id };
      const { values, cost } = await runWaterfall(adapters, entity, fields || ['email', 'firmographics'], ctx);
      const enrichment = buildEnrichmentPayload(values);
      // 来源语义落边：ACCOUNT --sourcedFrom--> KNOWLEDGE（auto_weak，relation_confidence 落 meta）
      const k = values?.source_knowledge_id;
      if (k?.value) {
        await createEdge('CRM_ACCOUNT', account_id, 'sourcedFrom', 'CRM_KNOWLEDGE', k.value, {
          edge_source: 'auto_weak', relation_confidence: k.confidence ?? 0.5,
          provenance: 'discovery-enrich', decision_id: ctx.decision_id,
        }, ctx.tenantId).catch(() => {});
      }
      return { account_id, enrichment, cost, decision_id: ctx.decision_id };
    },
  });

  // discovery-research：Claygent 式自主研究（区块二分抓取 + getLlmJson 抽取，见 Task 8）
  registerDiscovery({
    name: 'discovery-research',
    schema: { account_id: 'string', brief: 'string' },
    parameters: { required: ['account_id', 'brief'] },
    handler: async ({ account_id, brief }, ctx) => {
      requireMintedDecision(ctx, 'discovery-research');
      // Task 8 落地（模块 = connectors/discovery/claygent.js，签名 (entity, brief, {getLlmJson})）
      const { claygentResearch } = await import('../connectors/discovery/claygent.js');
      const { getLlmJson } = await import('../llm/client.js');
      const entity = (ctx.getParticle ? await ctx.getParticle(account_id) : null) || { id: account_id };
      return claygentResearch(entity, brief, { getLlmJson: ctx.getLlmJson || getLlmJson });
    },
  });
}
```

> **命名空间**：`registry.js:20` 由 name 前缀自动推导 `namespace='discovery'`；`run/enrich/research` **非 CRUD 动词**，不触发 `detectCrudExplosion()` 的 R3 护栏（`registry.js:52-57` 的 `CRUD_VERBS = create/read/update/delete`）。
> **entitlement**：复用 `core_crm`（既有 41 处），**不新增功能键**——新增键会连动「配置中心 ≡ `db/seed-billing-config.sql` ≡ `seedBillingPlans.js`」三源一致铁律，超本轮范围（标 future）。
> **`needsApproval: true`**（原稿 `false` 已改）：`discovery-run` 会用外部数据**创建 CRM_ACCOUNT/CRM_DEAL 粒子**，与 `connectorActions.js` 同类 blast radius（该类全部 `needsApproval: true` + `confirm:'stage2'`）；Task 18 亦要求写动作默认 `human_gate`、不进 autonomous 白名单。
> **`requiresEntitlement` 取值须落在既有集合**：`core_crm / ai_agents / approval_flow / decision_autonomy / event_automation / memory / advanced_reporting / audit_provenance / customer_360 / industry_config / rbac_advanced`。

- [ ] **Step 4: Wire into `src/agent/agentSpec.js`** — 在 `decision-agent`（`identity.autonomy:'autonomous'`）的 `capabilities.actions` **与** `capabilities.skillCalls` 两数组各追加 `'discovery-run','discovery-enrich','discovery-research'`。硬闭包 2 约束 `skillCalls ⊆ capabilities.actions`（`agents.js:72-78`）+ 断言 4 要求全部在 Registry 存在（`:81-88`），两处必须同改，漏一处整册断言失败。
  > ⚠ **commit 卫生**：`src/agent/agentSpec.js` 在本次工作前**已存在一处未提交改动**（followup agent 加 `crm-followup-requirement-collect`，mtime 2026-09-09）——按「每 Task 一 commit / 禁混功能线」铁律，请**先把该既有改动单独提交**，再提交本 Task；否则 `git add src/agent/agentSpec.js` 会把两条功能线裹进同一个 commit。

- [ ] **Step 4b: 注册入口接线** — 两条路径都要接（否则 Action 表在真实运行时为空、MCP 工具缺失）：
  - `src/agent/agents.js`：顶部（`import { seedActions } from '../action/seed-actions.js';`，`:5` 附近）加 `import { seedDiscoveryActions } from '../action/discoveryActions.js';`；在 `assertAgentAssembly()` 内 `seedActions();`（`:66`）之后加 `seedDiscoveryActions();`。
  - `src/http/routes.js`：`import { seedConnectorActions } from '../connectors/connectorActions.js';`（`:18`）附近加 `import { seedDiscoveryActions } from '../action/discoveryActions.js';`；在 `seedConnectorActions();`（**`:485`**，非原稿 `:469`）之后加 `seedDiscoveryActions();`。

- [ ] **Step 5: Register SKILL in `src/skills/seed.js`**（在 `seedSkills()` 内追加；**真实契约 `{slug, version, steps[]}`**，`skills/registry.js:24-30` + `seed.js:8-17` 实证）

```js
registerSkill({
  slug: 'lead-discovery', version: 1, enabled: true, rbac_roles: ['sales', 'ten_admin'],
  description: '线索自主发现循环：本体优先富集 → 缺口瀑布 → 评分入 payload → 持续监控重评分',
  steps: [
    { step: 1, action: 'discovery-run', decision: 'rule',
      params: { limit: 50 }, preconditions: [], postconditions: ['result.candidates>=0'] },
    { step: 2, action: 'discovery-enrich', decision: 'rule',
      params: { fields: ['email', 'phone', 'firmographics'] },
      preconditions: ['steps[0].done'], postconditions: ['decision.finalized'] },
    { step: 3, action: 'discovery-research', decision: 'j_judge',
      prompt: '基于 enrichment+signals 产出 why_narrative 与 2D 判定 {{steps[1].result}}',
      preconditions: ['steps[1].done'], postconditions: ['payload.research.why_narrative!=null'] },
  ],
});
```

- [ ] **Step 6: Run test** → PASS（5 例：① ② ③ ④ ⑤ 全绿；`assertAgentAssembly().ok === true`）

- [ ] **Step 7: Commit**

```powershell
git add src/action/discoveryActions.js src/agent/agents.js src/http/routes.js src/skills/seed.js test/action/discoveryActions.test.js
git commit -m "feat(discovery): register discovery-* actions via 3 hard closures"
```

> `src/agent/agentSpec.js` 若已按上述「commit 卫生」先行单独提交其既有 followup 改动，本 commit 再补一次：
> `git add src/agent/agentSpec.js` + `git commit -m "feat(discovery): wire discovery-* into decision-agent capabilities"`。

---

## Task 6: LEAD_FIT decision_scenario 行（KMD 结合 · 场景字典）

**Files:**
- Modify: `db/seed.sql` —— 在 `crm.decision_scenario` 的 INSERT VALUES 段**末尾**、`ON CONFLICT` **之前**追加 1 行（仿 `REQUIREMENT_COLLECT` 行写法）
- Modify: `db/test-setup.sql` —— **同一行双源同步**（测试库 `crm_native_test` 的场景字典来自本文件；只改 seed.sql 会让 T6 集成断言假红）
- Modify: `scripts/seed-test-config.mjs` —— 新增幂等前置步骤 `ensureDiscoveryScenario()`（与 `ensureCalibrationPatch`（`:228`）同构）
- Test: `test/decision/leadFitScenario.test.js`

**契约校正声明（2026-09-11 派发前源码级复查，7 处）**：

1. 🔴 **`src/decision/eventTrigger.js` 不存在**。真实事件矩阵在 **`src/agent/eventTrigger.js:12-26`** 的 `AGENT_EVENT_TRIGGER_DEFAULT.matrix`（设计文档引用的行号 `:15-26`/`:22-24` 是对的，**目录写错**）。
2. 🔴 **矩阵行形状错**。真实行 = `{domain,type,entity_type,intent,agent,skill_slug,dedup_field}`；原稿 `{event,kind,intent,agent}` 是把既有第 3 行的 `entity_type:'CRM_KNOWLEDGE'` 误当 `event`、并臆造了 `kind`。
3. 🔴 **`matchTrigger` 只读白名单闸 → 本 Task 不加矩阵行**。`src/agent/eventTrigger.js:30-32` 硬编码 `READ_ONLY_SKILLS`（3 个 `method-*`），`:65-76` 对白名单外 SKILL **静默 `return null`**；且 `grep 'discovery-sync' src/ scripts/` **0 命中**（无 emitter）。故硬编码该行 = **死配置**（运行时永不命中、且无任何报错）= 假绿。设计 §368/§424 本就把该行标为「**可选**」→ **改由 Task 16（C3 monitorAccount，信号事件与重评分同源）落地**；Task 16 Step 5 已加「派发前必须复查」标记。
4. 🔴 **测试库场景字典来源是 `db/test-setup.sql`，不是 `db/seed.sql`**；且 `pretest` 只跑 `scripts/seed-test-config.mjs`（**不**整体应用 test-setup.sql）→ 必须**三处同步**：`db/seed.sql` + `db/test-setup.sql` + `scripts/seed-test-config.mjs` 幂等步骤。（历史教训：2026-08-26 场景字典 TRUNCATE 未重建 → FK 假失败；2026-08-29 场景种子「入双库」。）
5. ⚠ **禁止用 `npm run seed` 落测试库**：`src/db.js:17` 默认库是**生产库 `crm_native`**（`:75-78` 有告警），`npm run seed` = 直写生产（红线，需 HITL 显式授权）。测试库走 `node scripts/seed-test-config.mjs`（`:20-27` 显式拒绝生产库名）。
6. **场景 `trigger.cond.event` 取值错**：原稿 `"event":"discovery-sync"` 非既有域事件（既有全为 `created`/`qualify`/`quote_submit`/`reopen` 等；`discovery-sync` 全仓 0 命中，且 `trigger` 仅作元数据透传，`decisionRepo.js:281`）→ 改为 `"event":"created"`（与 `LEAD_FOLLOW_UP` 同域事件，靠 `"entity":"ACCOUNT"` 区分）。
7. **断言加严**：原稿只断言 `default_tier`/`autonomous_allowed`。补 ①**双源静态一致**（两文件都含该行 + 5 条 ICP 权重和 = 1，防权重静默漂移）；②真实 PG 执行 seed 语句（幂等）后断言行属性 + `eval_dimensions` 5 个 cond 序。
   - 列契约已核（`db/migrate.js:266-272` + `db/migrate-config.sql:85`）：`stage_code/focus_elements/focus_rulers/rubric_pass_line/enabled_rulers` 可空、`retro_required` NOT NULL DEFAULT false、`required_dims` NOT NULL DEFAULT '[]' → 原稿列清单可安全 INSERT。
   - 无 `required_dims` → **不触发七维拦截**（`decisionRepo.js:180-182` 仅对 `required_dims` 命中维判定；`test/decision/_helpers.js:11` 即以空 `required_dims` 绕过拦截）。与决策引擎分工自洽：ICP 评分在发现引擎内完成，七维闸由业务场景承担。
   - ⚠ `query()` 走**只读池** `poolRead`（`src/db.js:91`）→ 测试里写库**必须**用 `queryWrite`。

- [ ] **Step 1: Write the failing test**

```js
// test/decision/leadFitScenario.test.js
// T6（测试计划 §4）：LEAD_FIT 场景字典 —— 集成（真实 PG crm_native_test@5433）
// ⚠ 无 resolveScenario 导出、亦无 src/decision/scenarioStore.js（原稿虚构）——真实场景读取只有
//   executor.js:25-27 的私有 getScenario()（未导出）+ autonomyEngine.requireDecision()（:115-122）。
//   故本 Task 走「① 双源静态一致 + ② 真执行 db/seed.sql 场景段（幂等）后断言行属性」。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { query, queryWrite } from '../../src/db.js';

const SEED_FILES = ['db/seed.sql', 'db/test-setup.sql'];
const TAIL = 'ON CONFLICT (scenario_id, tenant_id) DO NOTHING;';
const seedUrl = (rel) => new URL(`../../${rel}`, import.meta.url);

// 抽取 crm.decision_scenario 的完整 INSERT 语句（VALUES 全行 + 收尾 ON CONFLICT）
function extractScenarioInsert(rel) {
  const sql = fs.readFileSync(seedUrl(rel), 'utf8');
  const i = sql.indexOf('INSERT INTO crm.decision_scenario');
  expect(i, `${rel} 应含 crm.decision_scenario 段`).toBeGreaterThanOrEqual(0);
  const j = sql.indexOf(TAIL, i);
  expect(j, `${rel} 场景段应以 ON CONFLICT (scenario_id, tenant_id) DO NOTHING; 收尾`).toBeGreaterThanOrEqual(0);
  return sql.slice(i, j + TAIL.length);
}

// 抽取 LEAD_FIT 那一行。约定：追加在 VALUES 段「末尾、ON CONFLICT 之前」→ 直接切到语句尾即该行
function leadFitRow(stmt) {
  const i = stmt.indexOf("('LEAD_FIT'");
  expect(i, 'LEAD_FIT 行应存在').toBeGreaterThanOrEqual(0);
  return stmt.slice(i);
}

describe('LEAD_FIT decision_scenario', () => {
  it('双源（db/seed.sql + db/test-setup.sql）均含 LEAD_FIT 行：tier=LEAD / autonomous=TRUE / 5 个 ICP cond / 权重和=1', () => {
    for (const f of SEED_FILES) {
      const stmt = extractScenarioInsert(f);
      expect(stmt, `${f} 含 LEAD_FIT`).toContain("'LEAD_FIT'");
      const row = leadFitRow(stmt);
      expect(row, `${f} default_tier=LEAD + autonomous_allowed=TRUE`).toContain("'LEAD', TRUE");
      for (const cond of ['industry', 'headcount', 'geo', 'hiring_icp_role', 'funding_round']) {
        expect(row, `${f} 含 cond=${cond}`).toContain(`"cond":"${cond}"`);
      }
      const w = [...row.matchAll(/"weight":([0-9.]+)/g)].map((m) => Number(m[1]));
      expect(w, `${f} 5 条 ICP 权重`).toHaveLength(5);
      expect(w.reduce((a, b) => a + b, 0), `${f} 权重和=1`).toBeCloseTo(1, 6);
    }
  });

  it('真实 PG：执行 db/seed.sql 场景段（幂等）后 LEAD_FIT 行落库且属性正确', async () => {
    await queryWrite(extractScenarioInsert('db/seed.sql'));
    const r = await query(
      `SELECT scenario_id, stage, default_tier, autonomous_allowed, methodology_ids, eval_dimensions
         FROM crm.decision_scenario WHERE scenario_id='LEAD_FIT' AND tenant_id='system'`
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].stage).toBe('一、线索');
    expect(r.rows[0].default_tier).toBe('LEAD');
    expect(r.rows[0].autonomous_allowed).toBe(true);
    expect(r.rows[0].methodology_ids).toEqual(['BANT', 'MEDDICC', 'OPP_MATRIX']);
    expect(r.rows[0].eval_dimensions.map((d) => d.cond))
      .toEqual(['industry', 'headcount', 'geo', 'hiring_icp_role', 'funding_round']);
  });
});
```

- [ ] **Step 2: Run test** → FAIL（双源均无 LEAD_FIT 行）

```
npx vitest run test/decision/leadFitScenario.test.js
```

- [ ] **Step 3a: Add the row in `db/seed.sql`**（VALUES 段末尾、`ON CONFLICT` 前；锚点唯一：`'NORMAL', TRUE)\nON CONFLICT (scenario_id, tenant_id) DO NOTHING;`）

```sql
-- LEAD_FIT（2026-09-10 线索自主发现引擎 T6）：线索 ICP 适配度评分——发现引擎富集后对 CRM_ACCOUNT 评分。
-- 与 LEAD_FOLLOW_UP 同 stage 分组（'一、线索'），配置页 ORDER BY stage, scenario_id 自然归位。
-- tier=LEAD + autonomous_allowed=TRUE：与 LEAD_FOLLOW_UP/LOSS_REVIEW 同档（低风险线索评分可自治）；
--   对外写仍由 discovery-* Action 的 needsApproval + 第 0 闸两阶段 confirm_token 承担硬人工闸。
-- 无 required_dims → 不触发七维拦截（ICP 评分在发现引擎内完成，七维闸由业务场景承担）。
('LEAD_FIT', '一、线索', '线索 ICP 适配度评分（发现引擎：industry/headcount/geo/hiring/funding）',
 '{"cond":{"event":"created","stage":"lead"},"entity":"ACCOUNT","source":"particle_event"}'::jsonb,
 ARRAY['BANT','MEDDICC','OPP_MATRIX'],
 '[{"cond":"industry","label":"行业匹配","weight":0.25},{"cond":"headcount","label":"规模匹配","weight":0.2},{"cond":"geo","label":"地域匹配","weight":0.15},{"cond":"hiring_icp_role","label":"招聘信号","weight":0.2},{"cond":"funding_round","label":"融资信号","weight":0.2}]'::jsonb,
 'LEAD', TRUE)
```

- [ ] **Step 3b: 同一行同步进 `db/test-setup.sql`**（同锚点、同位置；**双源必须逐字一致**）

- [ ] **Step 4: Add idempotent pretest step in `scripts/seed-test-config.mjs`**

```js
// ⑫ 线索发现场景（T6）：LEAD_FIT 场景行幂等补齐。
//   测试库场景字典来自 db/test-setup.sql（TRUNCATE 后重建）；本步骤让 `npx vitest run`（不经 pretest）
//   也能自足——与 ensureCalibrationPatch 同构（ON CONFLICT DO NOTHING；禁 DELETE、禁 UPDATE 覆盖）。
async function ensureDiscoveryScenario() {
  return run(`
    INSERT INTO crm.decision_scenario
      (scenario_id, stage, description, trigger, methodology_ids, eval_dimensions, default_tier, autonomous_allowed)
    VALUES ('LEAD_FIT','一、线索','线索 ICP 适配度评分（发现引擎：industry/headcount/geo/hiring/funding）',
      '{"cond":{"event":"created","stage":"lead"},"entity":"ACCOUNT","source":"particle_event"}'::jsonb,
      ARRAY['BANT','MEDDICC','OPP_MATRIX'],
      '[{"cond":"industry","label":"行业匹配","weight":0.25},{"cond":"headcount","label":"规模匹配","weight":0.2},{"cond":"geo","label":"地域匹配","weight":0.15},{"cond":"hiring_icp_role","label":"招聘信号","weight":0.2},{"cond":"funding_round","label":"融资信号","weight":0.2}]'::jsonb,
      'LEAD', TRUE)
    ON CONFLICT (scenario_id, tenant_id) DO NOTHING;
  `);
}
```

并在 `main()` 的 `steps` 数组末尾（`['套餐基线…', ensureBillingPlans]` 之后）追加：

```js
    ['线索发现场景（LEAD_FIT）', ensureDiscoveryScenario],
```

- [ ] **Step 5: Run test** → PASS

```
node scripts/seed-test-config.mjs
npx vitest run test/decision/leadFitScenario.test.js
```

- [ ] **Step 6: Commit**

```powershell
git add db/seed.sql db/test-setup.sql scripts/seed-test-config.mjs test/decision/leadFitScenario.test.js
git commit -m "feat(discovery): seed LEAD_FIT decision_scenario in seed.sql/test-setup/pretest (T6)"
```

---

## Task 7: 发现编排（本体优先富集 + 瀑布 + 评分入 payload）

**Files:**
- Create: `src/agent/discoveryOrchestrator.js`, `src/connectors/discovery/dedupResolver.js`, `src/connectors/discovery/builtinAdapters.js`
- Modify: `src/http/routes.js`（启动点：注册内置适配器）、`src/agent/agents.js`（装配点：注册内置适配器）
- Test: `test/agent/discoveryOrchestrator.test.js`, `test/connectors/discovery/dedupResolver.test.js`

> **契约校正声明（派发前源码级复查 · 2026-09-11）** —— 原稿 7 处问题已消解，本 Task 为最终裁决版本：
>
> ① 🔴 **`ctx.createParticle` / `ctx.updateParticle` / `ctx.findParticle` / `ctx.createEdge` 在真实 runtime 根本不存在**。`src/action/executor.js:208` 只把 `def.handler(params, ctx)` 交给 handler，而 `ctx` = `{tenantId, actor, decision_id, bootstrap, channel, approvalPassed, getParticle?…}` —— **无任何写助手**。全仓 grep `ctx.createParticle|ctx.findParticle` = **0 命中**；既有合规范式（`connectorActions.js:38,41` / `tenderConnector.js:52-61`）一律**直调 `particleRepo` 并透传 `ctx.tenantId`**。设计 §9.1 原话是「写助手 `createParticle/createEdge` **收** `ctx.tenantId`」= 直调 repo + 透传租户，**不是** ctx 上有方法。原稿照抄会把单测打成「ctx 打桩替身通过、生产 undefined 崩溃」的经典假绿。→ 改为 **直调 repo + `deps` 注入**（生产默认真实现 / 单测注入替身）。
> ② 🔴 **`createEdge` 真实签名 7 参**：`(sourceType, sourceId, edgeType, targetType, targetId, meta = {}, tenantId = 'system')`（`particleRepo.js:290`）。原稿 `ctx.createEdge('sourcedFrom', account.id, {...})` 是 **3 参错形状**，缺 target 类型与 id。
> ③ 🔴 **DEAL/ACCOUNT 的 `identity = ['name']`**（`particleModel.js:10,18`）→ `createParticle` 会跑 `missing required field: name` 校验（`particleRepo.js:86-90`）。原稿 DEAL 只传 `{stage:'lead', account_id}` → **生产必抛**（单测因 create 被打桩而假绿）。→ DEAL 补 `name`。
> ④ 🔴 **`mergedSafe(tenantId)` 返回出厂常量 = 租户配置完全不生效**（违反「阈值/行业差异化 100% 后台配置化」铁律，且是假绿：看起来读了 config，其实恒为默认）。→ 改为真实 `await mergedDiscoveryRules({ tenantId }, deps)`（Task 1 已落地，`deps.readConfig` 可注入）。
> ⑤ 🔴 **适配器从未被任何生产代码 import → `REGISTRY` 运行时恒空 → 富集静默零产出（本引擎最致命的一处死接线）**。证据：`grep -rn "discovery/adapters" src/` 仅命中 4 个适配器**自身的文件头注释**；而 `providerRegistry.js:20` 只实例化 `registry.has(p.id)` 的项 → 无人 import 时 `resolveAdapters` **恒返 `[]`**，`discovery-enrich`/`discovery-run` 全部静默空转。Task 2 契约「注册表不 import 适配器」是对的（防静态环），但**缺一个显式汇聚启动点**。→ 新增 `builtinAdapters.js` 汇聚模块，并在两个启动点注册（`routes.js:488` 后、`agents.js` `assertAgentAssembly()` 内 `seedDiscoveryActions()` 后）。
> ⑥ **测试路径三方不一致**：Task 头写 `test/agent/discoveryOrchestrator.test.js`、测试计划 T7 行写 `test/connectors/discovery/orchestrator.test.js`。以**已提交的硬证据**为准 —— Task 5（commit `f2c6ab2`）`src/action/discoveryActions.js:45` 是 `await import('../agent/discoveryOrchestrator.js')` → 源在 `src/agent/`，测试同域放 `test/agent/discoveryOrchestrator.test.js`。
> ⑦ **断言过弱（假绿）**：原稿 T7 只断言 `icp_fit_score` defined 与 `createParticle` 被调用 —— 在 ctx 打桩下必然通过、与生产无关。→ 补 6 条强断言：查重命中不重复建号 / 租户 + decision_id 真实透传 / 瀑布 enriched 落 payload 且六元齐 / `why_narrative` 含 `decision_id` / 缺 `seed.name` fail-closed / 启动即注册 4 个 system 源。
>
> **另修正 2 处元数据**：`Modify src/connectors/tenderConnector.js` 已从 Files 移除 —— `createLeadFromTender`（`tenderConnector.js:51-64`）入参是 `{tender, tenantId}` 的**标讯专用**函数，发现编排只需复用其「createParticle + sourcedFrom 弱边」范式，**无需改它**；`mergedSafe` 这一死桩一并删除。

- [ ] **Step 1: Write the failing test（查重解析器）**

```js
// test/connectors/discovery/dedupResolver.test.js
import { describe, it, expect, vi } from 'vitest';
import { resolveExistingOrCreate } from '../../../src/connectors/discovery/dedupResolver.js';

describe('dedupResolver', () => {
  it('finds existing account by domain before create', async () => {
    const find = vi.fn(async () => ({ id: 'acc-existing' }));
    const create = vi.fn(async () => ({ id: 'acc-new' }));
    const out = await resolveExistingOrCreate('CRM_ACCOUNT', { domain: 'x.com', name: 'X' }, { find, create });
    expect(find).toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(out.id).toBe('acc-existing');
  });

  // ⚠ 契约校正（2026-09-11）：原稿把「并发兜底」写成「第二次 create 成功」——与实现语义相反。
  //   实现语义 = 唯一约束冲突（23505）后**重查赢家**（find 二次命中）→ 转 update 或直接复用，
  //   **绝不重试 create**（重试 = 可能建出重复行）。原稿测试必然失败（find 恒 null → 无赢家 → throw e）。
  it('concurrent unique-constraint collision falls back to the winner found by re-query', async () => {
    const find = vi.fn()
      .mockResolvedValueOnce(null)          // 首轮扫描：未命中
      .mockResolvedValue({ id: 'acc-race' }); // 冲突后重查：并发赢家已落库
    const create = vi.fn().mockRejectedValue(Object.assign(new Error('dup'), { code: '23505' }));
    const out = await resolveExistingOrCreate('CRM_ACCOUNT', { domain: 'y.com' }, { find, create });
    expect(create).toHaveBeenCalledTimes(1); // 绝不重试 create
    expect(out.id).toBe('acc-race');
  });

  it('honors config-driven criteria groups (OR) instead of hardcoded keys', async () => {
    const find = vi.fn(async () => null);
    const create = vi.fn(async () => ({ id: 'acc-cfg' }));
    const out = await resolveExistingOrCreate('CRM_ACCOUNT', { domain: 'z.com' }, {
      find, create,
      criteria: [['domain'], ['vat_id']], // 来自 config.duplicate_criteria，非硬编码
    });
    expect(find).toHaveBeenCalledWith('CRM_ACCOUNT', 'domain', 'z.com');
    expect(create).toHaveBeenCalled();
    expect(out.id).toBe('acc-cfg');
  });
});
```

- [ ] **Step 2: Run test（查重）** → FAIL（`Cannot find module`）

```powershell
npx vitest run test/connectors/discovery/dedupResolver.test.js
```

- [ ] **Step 3: Implement dedupResolver（duplicateCriteria 配置驱动，借鉴 Twenty 核心层）**

新增 `src/connectors/discovery/dedupResolver.js`：**查重条件从 `config.duplicate_criteria` 读取，不再硬编码匹配键**（对齐 Twenty `build-duplicate-conditions.utils.ts:24` 读 `flatObjectMetadata.duplicateCriteria` 的元数据驱动范式，且与项目「配置驱动差异化 + 阈值后台可配」铁律同构）。每组（group）内任一键命中即判重、组间为 OR；新增数据源/对象类型只改 config，**零核心代码改动**。
落库仍走**先查后建 + 确定性外部 id upsert + 并发唯一约束（`23505`）兜底重查赢家**；**全程零 DELETE，预防式去重**——契合项目「禁 DELETE」铁律，规避 Twenty `mergeMany` 的 soft-delete 输家模式。字段级合并策略（`scalar→winner-priority` / `array→deduped-union`）已作**预留设计**（`MERGE_STRATEGY_RESERVED.enabled=false`），启用前必须经决策第 0 闸 + 显式 HITL 授权。

```js
// src/connectors/discovery/dedupResolver.js
// 查重条件来自配置（duplicateCriteria），不再硬编码匹配键 —— 对齐 Twenty
// build-duplicate-conditions.utils.ts:24 读 flatObjectMetadata.duplicateCriteria 的元数据驱动范式；
// 与项目「配置驱动差异化 + 阈值后台可配」铁律同构，新增对象类型只改 config、零核心改动。
// 默认来源：mergedDiscoveryRules(ctx).duplicate_criteria
//   例：{ CRM_ACCOUNT: [['external_id'],['domain'],['linkedin_url'],['name']],
//         CRM_CONTACT: [['external_id'],['email']] }
//   每组（group）内任一键命中即判重；组间为 OR（与 Twenty 语义一致）。
const MIN_STR_LEN = 2; // 短串防误判（对齐 Twenty minLengthOfStringForDuplicateCheck）

export function defaultCriteriaFor(type) {
  return type === 'CRM_CONTACT'
    ? [['external_id'], ['email']]
    : [['external_id'], ['domain'], ['linkedin_url'], ['name']]; // 可被 config 覆盖
}

// 并发兜底语义（勿改）：唯一约束冲突后**只重查赢家**，绝不重试 create（重试可能建出重复行）。
export async function resolveExistingOrCreate(type, attrs, { find, create, update, criteria }) {
  const groups = criteria ?? defaultCriteriaFor(type); // criteria 由调用方从 config 注入
  for (const group of groups) {
    for (const k of group) {
      const v = attrs[k];
      if (v == null || String(v).length <= MIN_STR_LEN) continue; // 短串跳过，防误判
      const hit = await find(type, k, v);
      if (hit) return hit; // 先查后建，预防式去重（零 DELETE）
    }
  }
  try {
    return await create(type, attrs); // 确定性外部 id 直接 upsert（createOrUpdate）
  } catch (e) {
    if (e?.code === '23505' || /unique/i.test(String(e?.message || ''))) {
      for (const group of groups) { // 并发兜底：唯一约束冲突 → 重查赢家（不重试 create）
        for (const k of group) {
          const v = attrs[k];
          if (v == null || String(v).length <= MIN_STR_LEN) continue;
          const winner = await find(type, k, v);
          if (winner) return update ? await update(winner.id, attrs) : winner;
        }
      }
    }
    throw e;
  }
}

// —— 字段级合并策略（预留设计，当前阶段不启用）——
// 项目铁律「禁 DELETE」：本阶段仅做预防式去重（命中即复用赢家，不创建重复、不删除输家）。
// 未来若需显式合并两条已存在记录，才启用以下策略（参考 Twenty
// mergeFieldValues / mergeEmails / mergePhones / mergeLinks / mergeArrayFieldValues）：
//   scalar 字段 → 优先级赢家优先；array 字段（邮箱/电话/链接）→ 去重并集。
// 启用前提：必须经决策第 0 闸 + 显式 HITL 授权（绝不自动 DELETE 输家记录）。
export const MERGE_STRATEGY_RESERVED = Object.freeze({
  scalar: 'winner-priority',
  array: 'deduped-union',
  enabled: false, // 默认关闭；违反「禁 DELETE」前不得置 true
});
```

Run: `npx vitest run test/connectors/discovery/dedupResolver.test.js` → PASS（3 例）

- [ ] **Step 4: 内置适配器汇聚模块（消除死接线 ⑤）**

```js
// src/connectors/discovery/builtinAdapters.js
// 唯一职责：让 4 个出厂 system 档适配器在启动时完成注册。
// 为什么必须有本模块：适配器用 registerProvider 自注册（providerRegistry.js:8），而注册表**刻意不 import
//   任何 adapter**（Task 2 契约：避免 注册表 → 适配器 → 注册表 的静态环）。Task 2/3 只交付了「自注册能力」，
//   却没有交付「谁来触发注册」——若不显式调用，REGISTRY 运行时恒空，resolveAdapters 因 registry.has(id)
//   恒假而返回 []，富集静默零产出（最隐蔽的死接线：无报错、无日志、测试仍绿）。
// 实现要点：**函数内显式 registerProvider**，而非只依赖 import 副作用 —— 因为测试会用 _resetRegistry()
//   清空注册表，此时模块缓存命中、副作用不会重跑，只靠副作用会让「重新注册」静默失效。
//   Map.set 幂等，重复调用安全。
import { emailVerify } from './adapters/emailVerify.js';
import { webResearch } from './adapters/webResearch.js';
import { tenderAdapter } from './adapters/tender.js';
import { gaodeAdapter } from './adapters/gaode.js';
import { registerProvider, listProviderIds } from './providerRegistry.js';

// 出厂 system 档（与 config/discoveryRules.js:19-22 的 providers[].id 同源，禁新增字面量）
const BUILTIN_ADAPTERS = Object.freeze({
  'email-verify': emailVerify,
  'web-research': webResearch,
  tender: tenderAdapter,
  gaode: gaodeAdapter,
});

export function registerBuiltinAdapters() {
  for (const [id, factory] of Object.entries(BUILTIN_ADAPTERS)) registerProvider(id, factory);
  return listProviderIds();
}

export { BUILTIN_ADAPTERS };
```

- [ ] **Step 5: Implement orchestrator**

```js
// src/agent/discoveryOrchestrator.js — 线索自主发现主编排（设计 v8.1 §2 发现循环 ①-④）
// 契约校正（2026-09-11）：ctx 上**没有** createParticle/updateParticle/findParticle/createEdge
//   （executor.js:208 只传 (params, ctx)；ctx = {tenantId, actor, decision_id, bootstrap, channel, ...}）。
//   故一律**直调 particleRepo 并透传 ctx.tenantId**（设计 §9.1 原话；范式同 connectorActions.js:38,41），
//   同时开放 deps 注入供单测替换（生产默认=真实现，不留假绿缝隙）。
// 铁律：
//   ① 写必带第 0 闸 decision_id（requireDecisionId 透传 repo；缺值由 Task 5 的 requireMintedDecision 先拦）
//   ② 租户隔离 = 每次写透传 tenantId（对照 id18/17/21/15 伪隔离坑：本路径走「载体自带 tenant_id + 透传」）
//   ③ 禁 DELETE：查重为预防式（命中即复用赢家），不删任何记录
//   ④ 配置驱动：ICP / 数据源三档 / 查重条件 / 覆盖字段全部来自 mergedDiscoveryRules，禁硬编码
//   ⑤ 本体优先：写粒子即由 ontology hooks 自动入图补全，外部适配器只补缺口
import { createParticle, updateParticle, createEdge } from '../particles/particleRepo.js';
import { query } from '../db.js';
import { mergedDiscoveryRules } from '../config/discoveryRules.js';
import { resolveAdapters } from '../connectors/discovery/providerRegistry.js';
import { runWaterfall } from '../connectors/discovery/waterfall.js';
import { resolveExistingOrCreate } from '../connectors/discovery/dedupResolver.js';
import { buildEnrichmentPayload, buildDiscoveryPayload } from './discoverySchema.js';
import { registerBuiltinAdapters } from '../connectors/discovery/builtinAdapters.js'; // 幂等：确保内置适配器已注册

// 生产写助手的 opts（抽为纯函数 → 单测可断言「租户 / decision_id 真的透传」，无需连库）
export function repoWriteOpts(ctx = {}) {
  return { tenantId: ctx.tenantId || 'system', actor: ctx.actor || null, requireDecisionId: ctx.decision_id || null };
}

// 默认查找器：按 payload 字段值查同类型同租户粒子。
// key 走 $3 参数化（不是字符串拼接）→ 无注入面；tenant_id 显式收窄 → 真隔离。
async function defaultFind(type, key, value, tenantId) {
  const r = await query(
    `SELECT id, type, payload FROM crm.particles WHERE type=$1 AND tenant_id=$2 AND payload->>$3 = $4 LIMIT 1`,
    [type, tenantId, key, String(value)]
  );
  return r.rows[0] || null;
}

export async function runDiscovery(ctx = {}, input = {}, deps = {}) {
  const tenantId = ctx.tenantId || input.tenantId || 'system';
  const decisionId = ctx.decision_id || null;
  const seed = input.seed || {};
  // fail-closed：ACCOUNT/DEAL 的 identity 均为 name（particleModel.js:10,18），缺 name 必抛 missing required field
  if (!seed.name) throw new Error('discovery-run: seed.name 必填（CRM_ACCOUNT / CRM_DEAL 的 identity 均为 name）');

  // ① 内置适配器注册（幂等）：必须**显式调用**，否则 REGISTRY 恒空 → 富集静默零产出
  registerBuiltinAdapters();

  // ② 规则：租户感知（config_store['discovery-rules'] ⊕ 出厂默认）；deps.rules 可整体注入
  const rules = deps.rules || await mergedDiscoveryRules({ tenantId }, deps.ruleDeps || {});

  // ③ 数据源：enabled 过滤 + costTier 升序（付费源出厂 false，需显式授权）；deps.adapters 可注入（单测零 IO）
  const adapters = deps.adapters || resolveAdapters(rules, { allowIds: input.allowIds });

  // ④ 写助手：生产默认真实现（直调 repo + 透传 tenantId / decision_id），单测可注入替身
  const opts = repoWriteOpts(ctx);
  const find = deps.find || ((type, key, value) => defaultFind(type, key, value, opts.tenantId));
  const create = deps.create || ((type, attrs) => createParticle(type, attrs, opts));
  const update = deps.update || ((id, attrs) =>
    updateParticle(id, { patch: attrs, tenantId: opts.tenantId, requireDecisionId: opts.requireDecisionId }));
  const addEdge = deps.createEdge || ((...a) => createEdge(...a));

  // ⑤ 本体优先 + 查重：先查后建（duplicate_criteria 配置驱动 → 命中即复用赢家，零 DELETE）
  const criteria = (rules.duplicate_criteria || {})['CRM_ACCOUNT'] || undefined;
  const account = await resolveExistingOrCreate(
    'CRM_ACCOUNT',
    { state: 'potential', name: seed.name, domain: seed.domain, source: seed.source || 'discovery' },
    { find, create, update, criteria }
  );

  // ⑥ 缺口瀑布：字段默认取「已启用适配器的 coverageFields 并集」（配置驱动；禁硬编码字段清单）
  const fields = Array.isArray(input.fields) && input.fields.length
    ? input.fields
    : [...new Set(adapters.flatMap((a) => a.coverageFields || []))];
  const { values, cost, calls } = await runWaterfall(adapters, { ...seed, id: account.id }, fields, ctx);
  const enrichment = buildEnrichmentPayload(values);

  // ⑦ 评分入 payload：初值占位，真实评分由 lead-fit 场景（Task 6）经 decision 回写（glass-box 见 Task 15）
  //    decisionId 取**真实**第 0 闸 mint 值（不是 'pending'）→ why_narrative 可溯源到具体决策
  const signals = Object.entries(values).map(([field, v]) => ({ type: field, provider: v?.provider, ts: v?.ts }));
  const discovery = buildDiscoveryPayload(0.5, 0.5, signals, decisionId || 'pending');

  // ⑧ 写回客户（只增改，不删除）
  await update(account.id, { enrichment, discovery });

  // ⑨ 产出线索商机（identity=name 必填；stage 经 normalizeStage 归一 → S1）
  const deal = await create('CRM_DEAL', {
    name: seed.deal_name || `${seed.name} · 线索`,
    stage: 'lead', source: 'discovery', account_id: account.id,
  });

  // ⑩ 溯源弱边：仅在确实拿到知识粒子 id 时落边（沿用 connectorActions.js:41 范式）；无则不落，绝不伪造
  const kid = values?.source_knowledge_id?.value;
  if (kid) {
    await addEdge('CRM_ACCOUNT', account.id, 'sourcedFrom', 'CRM_KNOWLEDGE', kid, {
      edge_source: 'auto_weak',
      relation_confidence: values.source_knowledge_id.confidence ?? 0.5,
      provenance: 'discovery-run', decision_id: decisionId,
    }, opts.tenantId).catch(() => {});
  }

  return {
    accountId: account.id, dealId: deal.id, tenantId,
    enriched: Object.keys(values), cost, calls,
    payload: { enrichment, discovery },
  };
}
```

- [ ] **Step 6: 两个启动点接线内置适配器（消除死接线 ⑤）**

`src/http/routes.js` —— 在 `seedDiscoveryActions();`（约 `:488`）之后追加：

```js
  // 线索发现内置适配器（Task 7 死接线修复）：适配器自注册但注册表刻意不 import 适配器，
  // 缺此显式汇聚 → REGISTRY 恒空 → enrich 静默零产出。启动点 import 一次即可（ESM 单例幂等）。
  registerBuiltinAdapters();
```

并在 import 区（约 `:19`，`seedDiscoveryActions` 之后）追加：

```js
import { registerBuiltinAdapters } from '../connectors/discovery/builtinAdapters.js';
```

`src/agent/agents.js` —— 在 `assertAgentAssembly()` 内 `seedDiscoveryActions();` 之后追加同样的 `registerBuiltinAdapters();`，并在 import 区追加同名 import。

> 两个启动点都接线的原因：`routes.js` = 真实服务启动路径；`agents.js` 的 `assertAgentAssembly()` = 装配/测试路径。缺任一都会让某条路径上的注册表为空。

- [ ] **Step 7: Write the orchestrator test**

```js
// test/agent/discoveryOrchestrator.test.js
// 全部注入替身（deps），零 IO / 零 DB；生产默认真实现由 Step 5 保证（不留「打桩绿、生产崩」缝隙）
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runDiscovery, repoWriteOpts } from '../../src/agent/discoveryOrchestrator.js';
import { registerBuiltinAdapters } from '../../src/connectors/discovery/builtinAdapters.js';
import { resolveAdapters, _resetRegistry } from '../../src/connectors/discovery/providerRegistry.js';
import { DEFAULT_DISCOVERY_RULES } from '../../src/config/discoveryRules.js';

const ctx = { tenantId: 't1', actor: 'alice', decision_id: 'dec-1' };
const mkDeps = (over = {}) => {
  const calls = { create: [], update: [], edge: [] };
  const deps = {
    rules: DEFAULT_DISCOVERY_RULES,
    adapters: [],
    find: vi.fn(async () => null),
    create: vi.fn(async (type, attrs) => { calls.create.push({ type, attrs }); return { id: `new-${type}` }; }),
    update: vi.fn(async (id, attrs) => { calls.update.push({ id, attrs }); return { id }; }),
    createEdge: vi.fn(async (...a) => { calls.edge.push(a); return { ok: true }; }),
    ...over,
  };
  return { deps, calls };
};

describe('runDiscovery（自主发现编排）', () => {
  it('新建链路：ACCOUNT(potential) + DEAL(lead，含 name) + 评分入 payload', async () => {
    const { deps, calls } = mkDeps();
    const out = await runDiscovery(ctx, { seed: { name: '测试公司', domain: 'x.com' } }, deps);
    expect(calls.create.map((c) => c.type)).toEqual(['CRM_ACCOUNT', 'CRM_DEAL']);
    expect(calls.create[0].attrs.state).toBe('potential');          // ACCOUNT 生命周期态（非业务阶段）
    expect(calls.create[0].attrs.name).toBe('测试公司');
    expect(calls.create[1].attrs.name).toBeTruthy();                // identity=name 必填，缺则生产必抛
    expect(calls.create[1].attrs.account_id).toBe('new-CRM_ACCOUNT');
    expect(out.payload.discovery.icp_fit_score).toBeDefined();
    expect(out.payload.discovery.why_narrative).toContain('decision_id=dec-1'); // 真实溯源，非 'pending'
    expect(out.accountId).toBe('new-CRM_ACCOUNT');
  });

  it('查重命中：复用既有客户，不重复建号', async () => {
    const { deps, calls } = mkDeps({ find: vi.fn(async () => ({ id: 'acc-existing' })) });
    const out = await runDiscovery(ctx, { seed: { name: 'X', domain: 'x.com' } }, deps);
    expect(calls.create.map((c) => c.type)).toEqual(['CRM_DEAL']); // 只建 DEAL，不再建 ACCOUNT
    expect(out.accountId).toBe('acc-existing');
  });

  it('瀑布命中 → enrichment 落 payload 且六元齐（layer/source 由 buildEnrichmentPayload 补齐）', async () => {
    const stub = {
      id: 'stub', costTier: 1, coverageFields: ['email'],
      async enrich() { return { email: { value: 'a@b.com', confidence: 0.6, cost: 1, provider: 'stub' } }; },
    };
    const { deps, calls } = mkDeps({ adapters: [stub] });
    const out = await runDiscovery(ctx, { seed: { name: 'X', domain: 'x.com' } }, deps);
    const patch = calls.update[0].attrs;
    expect(patch.enrichment.email.value).toBe('a@b.com');
    expect(patch.enrichment.email.layer).toBe('L2');
    expect(patch.enrichment.email.source).toBe('provider_adapter');
    expect(out.cost).toBe(1);
    expect(out.enriched).toEqual(['email']);
  });

  it('溯源弱边：有知识 id 才落边，且为 7 参真实形状', async () => {
    const stub = {
      id: 'stub', costTier: 1, coverageFields: ['source_knowledge_id'],
      async enrich() {
        return { source_knowledge_id: { value: 'k-9', confidence: 0.7, cost: 0, provider: 'stub' } };
      },
    };
    const a = mkDeps({ adapters: [stub] });
    await runDiscovery(ctx, { seed: { name: 'X', domain: 'x.com' } }, a.deps);
    expect(a.calls.edge[0]).toEqual([
      'CRM_ACCOUNT', 'new-CRM_ACCOUNT', 'sourcedFrom', 'CRM_KNOWLEDGE', 'k-9',
      expect.objectContaining({ edge_source: 'auto_weak', provenance: 'discovery-run', decision_id: 'dec-1' }),
      't1',
    ]);
    const b = mkDeps();
    await runDiscovery(ctx, { seed: { name: 'X', domain: 'x.com' } }, b.deps);
    expect(b.calls.edge.length).toBe(0); // 无知识 id → 不落边，不伪造来源
  });

  it('生产写助手 opts 真实透传租户 + decision_id（防伪隔离，零 DB 可断言）', async () => {
    expect(repoWriteOpts({ tenantId: 't9', actor: 'bob', decision_id: 'dec-9' }))
      .toEqual({ tenantId: 't9', actor: 'bob', requireDecisionId: 'dec-9' });
    expect(repoWriteOpts({}).tenantId).toBe('system'); // 缺租户兜底 system（与 particleRepo 默认一致）
    const { deps } = mkDeps();
    const out = await runDiscovery(ctx, { seed: { name: 'X', domain: 'x.com' } }, deps);
    expect(out.tenantId).toBe('t1');
  });

  it('缺 seed.name → fail-closed 抛错（不让 identity 校验在生产才炸）', async () => {
    const { deps } = mkDeps();
    await expect(runDiscovery(ctx, { seed: { domain: 'x.com' } }, deps)).rejects.toThrow(/seed\.name/);
  });
});

describe('内置适配器启动接线（死接线回归护栏）', () => {
  beforeEach(() => _resetRegistry());
  it('registerBuiltinAdapters 后 4 个 system 源按 costTier 升序可解析', () => {
    registerBuiltinAdapters();
    const ids = resolveAdapters(DEFAULT_DISCOVERY_RULES).map((a) => a.id);
    expect(ids).toEqual(['web-research', 'tender', 'email-verify', 'gaode']);
  });
});
```

- [ ] **Step 8: Run test** → PASS（6 + 1 = 7 例）

```powershell
npx vitest run test/agent/discoveryOrchestrator.test.js test/connectors/discovery/dedupResolver.test.js
```

> ⚠ 本 Task 全部为 DI 替身单测（零 DB）：「生产写助手是否真的透传租户 / decision_id」由抽出的纯函数 `repoWriteOpts()` 断言覆盖；真实落库链路（createParticle/updateParticle/createEdge 真实现）由 Task 20 触点面验收的端到端用例覆盖，不在此处连库。

- [ ] **Step 9: 回归**

```powershell
npx vitest run test/connectors/discovery/ test/config/ test/agent/discoverySchema.test.js test/action/
```

- [ ] **Step 10: Commit**

```powershell
git add src/agent/discoveryOrchestrator.js src/connectors/discovery/dedupResolver.js src/connectors/discovery/builtinAdapters.js test/agent/discoveryOrchestrator.test.js test/connectors/discovery/dedupResolver.test.js src/http/routes.js src/agent/agents.js
git commit -m "feat(discovery): orchestrator + config-driven dedup + builtin adapter boot wiring"
```

---

## Task 8: Claygent 研究（`discovery-research`，区块二分抓取 + glass-box）

> **⚠ 契约校正声明（2026-09-11 派发前源码级复查；共 8 条，6 条硬错）**
>
> **① 硬错 — `getLlmJson` 不是「单参 → JSON」函数，而是工厂。**
> 真实 `src/llm/client.js:110`：`export async function getLlmJson(opts = {})` → **返回** `async (systemPrompt, userPrompt, o = {}) => JSON|null`；无 LLM 配置时 `await getLlmJson(...)` **返回 `null`**。
> 原稿 `await getLlmJson('给定公司…只输出 JSON:{sections:[]}', { schema: { sections: ['array'] } })` 把 prompt 当成 `opts` → 得到的是**函数**而不是 JSON，且第二参被忽略 ⇒ 生产必然错、单测（注入 fn）却假绿。
> **权威消费范式**：`src/llm/aiAttributes.js:79-89` —— 先 `const json = await getLlmJson({...}).catch(() => null); if (!json) return null;` 再 `await json(SYSTEM_PROMPT, userPrompt, { timeoutMs })`。本 Task 一律照此形状。
>
> **② 硬错 — `ctx.getParticle` / `ctx.getLlmJson` 在 runtime 不存在。**
> `src/action/executor.js` 调 handler 只传 `(params, ctx)`，真实 `ctx` = `{ tenantId, actor, decision_id, bootstrap, channel, approvalPassed, ... }`；全仓 grep `ctx.getParticle` / `ctx.getLlmJson` **仅命中 Task 5 自己写的这两处三行**（`discoveryActions.js:61` 属 `discovery-enrich`、`:86,87` 属 `discovery-research`）。
> 原稿 `ctx.getParticle ? await ctx.getParticle(id) : null` 是**恒假守卫** → entity 永远退化为 `{ id }`（无 `name`/`domain`），Claygent 拿不到任何研究输入。→ 改为**直调** `getParticle(account_id)`（`src/particles/particleRepo.js:171`）+ 自行构造 LLM 调用器。
>
> **③ 硬错 — Files 头模块错位。** `discovery-research` 的 handler 真实落在 **`src/action/discoveryActions.js`**（Task 5 落盘），**不是** `src/action/seed-actions.js`（2000+ 行旧文件，本引擎刻意不塞）。Task 15 的 Files 头有同一错位，一并改齐。
>
> **④ 硬错 — 测试文件名三方不一致。** 原稿 Step 1/6 写 `test/connectors/discovery/claygent.test.js`，而**计划 Task 索引表 `:41`** 与**测试计划 §4 T8 行 `:121`** 都写 `test/connectors/discovery/research.test.js`。裁定以测试计划为准 → **`test/connectors/discovery/research.test.js`**（索引表补 `test/` 前缀，见补丁）。
>
> **⑤ 死桩 — `async function fetchPageSection() { return ''; }`。** 空实现 + 计划原稿通篇未调用它 ⇒ 死代码；照抄会让「区块二分抓取」永不发生而测试仍绿。→ 改为**可注入** `deps.fetchText`（生产默认包装 `globalThis.fetch`，见 Step 3）；**无通道时跳过抓取并如实标注，绝不伪造网页文本**（守「不伪造」铁律）。
>
> **⑥ 缺失 — `why_narrative` 是本 Task 的硬交付，原稿完全没有。** 依据：① 已落盘的 `src/skills/seed.js`（Task 5）step 3 `postconditions: ['payload.research.why_narrative!=null']`；② 设计 §4 `:225` 与 §9.4 验收 `:318`「getLlmJson 产出研究报告 + why_narrative（含 rule_ref/j_score）落 payload.research」。→ claygent 必须产**非空** `why_narrative` 与 `glass_box`，形状**与 Task 15 的 `buildGlassBox` 同构**（`judge:{axis,rule_ref,j_score}` + `trace[]`）；**Task 8 用内联最小实现**（`localGlassBox`）以免前向依赖 Task 15 尚未创建的模块。
>
> **⑦ 假绿 — 断言③「无命中不写库」原不可测。** 原稿把全部逻辑塞在 Action handler 里 → 想验「不写库」就得连真库。→ 把编排抽为**可导出、可注入**的 `runDiscoveryResearch(input, ctx, deps)`（DI `getParticle`/`updateParticle`/`getLlmJson` ⇒ 单测零 DB）；handler 仅保留「决策守卫 + 转发」。
>
> **⑧ 范围裁定 — `sourcedFrom:claygent` 边不属本 Task。** 测试计划 T8 三条断言（`{report, why_narrative, signals[]}` / LLM 注入 / 无命中不写库）**无一条要求边**；设计 §4 的该边由 **Task 9（记忆捕获）** 统一承接。本 Task 只写 `payload.research`。
> 佐证安全：`updateParticle` 的 `patch` 是**浅合并** `{ ...cur.payload, ...patch }`（`particleRepo.js:210`）⇒ 写 `research` **不会**冲掉既有 `discovery`/`enrichment` 段。
>
> **⑨ 附带收口 — `discovery-enrich` 的同款恒假守卫（本 Task 一并修）。**
> 执行时子代理指出本 Task 自检期望「全文件 0 命中」与范围约束「不得改 `discovery-enrich`」**互斥**，属实。复查确认 `discoveryActions.js:61`（`discovery-enrich`）用了同款 `ctx.getParticle ? await ctx.getParticle(id) : null` —— 同一文件、同一类「runtime 不存在的 API」恒假守卫，会让富集 `entity` 恒退化为 `{ id }`（适配器拿不到 `name`/`domain`/`email`，**静默退化且测试仍绿**）。
> ⇒ 当场**一并收口**（改法与本 Task 同构：直调 `getParticle`），不留已知假绿。这是声明②同一根因的完整消除（收口后该文件 `ctx.getParticle`/`ctx.getLlmJson` **全仓 0 命中**）。

> **另注**：`CRM_KNOWLEDGE` 的 `identity` 是 `['term']`（`particleModel.js:78-80`，不是 `name`）—— 本 Task 不建知识粒子（见⑧），仅记录以免后续 Task 踩坑。

**Files:**
- Create: `src/connectors/discovery/claygent.js`（纯函数式研究代理，不写库）
- Modify: `src/action/discoveryActions.js`（`discovery-research` handler 收口 + 新增导出 `runDiscoveryResearch`）
- Test: `test/connectors/discovery/research.test.js`

- [ ] **Step 1: Write the failing test**（7 例：claygent 5 + 编排 2）

```js
// test/connectors/discovery/research.test.js
import { describe, it, expect, vi } from 'vitest';
import { claygentResearch } from '../../../src/connectors/discovery/claygent.js';
import { runDiscoveryResearch } from '../../../src/action/discoveryActions.js';

// LLM 调用器替身：严格按「工厂产出物」形状 (systemPrompt, userPrompt, o) => JSON
const scripted = (sections) => vi.fn(async (system /*, user, o */) => {
  if (system.includes('线索研究员')) return { sections };
  return { summary: 'S', signals: [{ type: 'funding_round', evidence: 'E' }], competitors: ['A'], risks: [] };
});

describe('claygentResearch（C2 研究代理）', () => {
  it('① 产 { report, why_narrative, signals[] }，layer=L3 / source=claygent', async () => {
    const out = await claygentResearch({ name: 'X', domain: 'x.com' }, '调查竞品与融资信号', { getLlmJson: scripted([{ name: 'pricing' }, { name: 'careers' }]) });
    expect(out.report).toBeTruthy();
    expect(out.why_narrative).toBeTruthy();
    expect(Array.isArray(out.signals)).toBe(true);
    expect(out.signals.length).toBeGreaterThan(0);
    expect(out.layer).toBe('L3');
    expect(out.source).toBe('claygent');
  });

  it('② why_narrative 带 glass-box（rule_ref + j_score），与 P0#1 的 2D judge 同源', async () => {
    const out = await claygentResearch({ name: 'X', domain: 'x.com' }, 'B', { getLlmJson: scripted([{ name: 'pricing' }]) });
    expect(out.why_narrative).toContain('lead-fit');
    expect(out.glass_box.judge.axis).toBe('capability');
    expect(out.glass_box.judge.rule_ref).toContain('lead-fit');
    expect(typeof out.glass_box.judge.j_score).toBe('number');
    expect(out.glass_box.trace.length).toBeGreaterThan(0);
  });

  it('③ 无 LLM 通道 → fail-open degraded，不抛、不伪造', async () => {
    const out = await claygentResearch({ name: 'X' }, 'B', {});
    expect(out.degraded).toBe(true);
    expect(out.signals).toEqual([]);
    expect(out.why_narrative).toBe('');
  });

  it('④ LLM 返 null（未配置/不可解析）→ degraded 返空，绝不编造 summary', async () => {
    const out = await claygentResearch({ name: 'X', domain: 'x.com' }, 'B', { getLlmJson: vi.fn(async () => null) });
    expect(out.degraded).toBe(true);
    expect(out.summary).toBe('');
    expect(out.signals).toEqual([]);
  });

  it('⑤ 区块二分：先规划区块再定向抓取；单区块抓取抛错不中断；无 fetchText 则零抓取且不伪造', async () => {
    const seen = [];
    const fetchText = vi.fn(async (url, section) => {
      seen.push(section);
      if (section === 'team') throw new Error('HTTP 500'); // 单区块失败须 fail-open
      return `raw-${section}`;
    });
    const out = await claygentResearch({ name: 'X', domain: 'x.com' }, 'B', { getLlmJson: scripted([{ name: 'pricing' }, { name: 'team' }]), fetchText });
    expect(seen).toEqual(['pricing', 'team']);          // 定向抓取（不是整站）
    expect(out.fetchedSections).toBe(2);                // 抛错仍计「已尝试」
    expect(out.signals.length).toBeGreaterThan(0);      // 单区块失败不中断整条研究

    const out2 = await claygentResearch({ name: 'X', domain: 'x.com' }, 'B', { getLlmJson: scripted([{ name: 'pricing' }]) });
    expect(out2.fetchedSections).toBe(0);               // 无通道 → 零抓取
    expect(out2.report).toBeTruthy();                   // 仍据模型已有知识产出，不伪造网页文本
  });
});

describe('runDiscoveryResearch（action 编排 · DI 替身零 DB）', () => {
  const ctx = { tenantId: 't1', decision_id: 'dec_1' };

  it('① 有产出 → 写 payload.research（tenantId + requireDecisionId 真实透传）', async () => {
    const updateParticle = vi.fn(async () => ({}));
    const getParticle = vi.fn(async () => ({ id: 'a1', payload: { name: 'X', domain: 'x.com' } }));
    const out = await runDiscoveryResearch({ account_id: 'a1', brief: 'B' }, ctx,
      { getParticle, updateParticle, getLlmJson: scripted([{ name: 'pricing' }]) });
    expect(out.written).toBe(true);
    expect(updateParticle).toHaveBeenCalledTimes(1);
    const [id, opts] = updateParticle.mock.calls[0];
    expect(id).toBe('a1');
    expect(opts.patch.research).toBeTruthy();
    expect(opts.patch.research.why_narrative).toBeTruthy();
    expect(opts.tenantId).toBe('t1');
    expect(opts.requireDecisionId).toBe('dec_1');
  });

  it('② 无产出（fail-open 返空）→ 绝不写库', async () => {
    const updateParticle = vi.fn(async () => ({}));
    const getParticle = vi.fn(async () => ({ id: 'a1', payload: {} }));
    const out = await runDiscoveryResearch({ account_id: 'a1', brief: 'B' }, ctx,
      { getParticle, updateParticle, getLlmJson: vi.fn(async () => null) });
    expect(out.written).toBe(false);
    expect(updateParticle).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/connectors/discovery/research.test.js`
Expected: FAIL — `Cannot find module '../../../src/connectors/discovery/claygent.js'`

- [ ] **Step 3: Implement `src/connectors/discovery/claygent.js`**

```js
// src/connectors/discovery/claygent.js — C2 Claygent 研究代理
// 范式（Clay 二分搜索法）：不整站抓取，先让模型判定目标信息最可能所在的**页面区块**，
//   再针对性抓取该区块、从文本抽取结构化笔记（区块级二分收敛）。
// 铁律：
//   ① 不伪造 —— 无 LLM 通道 / 无抓取通道 / LLM 不可用 / 零产出 → fail-open 返空并标 degraded，
//      绝不编造 summary/signals/competitors（假绿温床）。
//   ② 纯函数式，不写库（写库在 Action handler，过决策第 0 闸）。③ 禁 DELETE（本模块无写操作）。
//   ⚠ Task 15 将把 localGlassBox 替换为 src/agent/glassBox.js 的 buildGlassBox（同构输出）。

export const CLAYGENT_LAYER = 'L3';
export const CLAYGENT_SOURCE = 'claygent';
export const MAX_SECTIONS = 5;
const RULE_REF = 'scenario:lead-fit#ruler:hiring_icp_role';

// glass-box 兼容产出：与 Task 15 buildGlassBox 同构（judge{axis,rule_ref,j_score} + trace[]）。
// 本 Task 内联最小实现，避免前向依赖 Task 15 尚未创建的模块。
function localGlassBox({ score, ruleRef, signals = [] }) {
  const names = signals.map((x) => (typeof x === 'string' ? x : x && x.type)).filter(Boolean);
  return {
    judge: { axis: 'capability', rule_ref: ruleRef, j_score: score },
    trace: names.map((n) => ({ signal: n, rule_ref: ruleRef, j_score: score })),
    why_narrative: `因 ${names.join('、') || '无信号'} 命中 ${ruleRef} 判定为目标客户（j_score=${score}）`,
  };
}

const SECTION_SYSTEM =
  '你是 B2B 线索研究员。仅输出一个 JSON 对象：'
  + '{"sections":[{"name":"<页面区块名，如 pricing/team/careers/footer>","reason":"<一句话理由>"}]}；'
  + '最多 5 项，按信息价值降序。禁止输出 JSON 之外的任何字符。';

const EXTRACT_SYSTEM =
  '你是研究笔记抽取器。仅输出一个 JSON 对象：'
  + '{"summary":"<不超过120字>","signals":[{"type":"<funding_round|hiring_icp_role|leadership_change|tech_adopt|website_redesign|tender_match>","evidence":"<原文片段>"}],'
  + '"competitors":["<公司名>"],"risks":["<风险>"]}。无依据的字段留空串/空数组，禁止编造。';

const asArray = (x) => (Array.isArray(x) ? x : []);
const uniqBy = (arr, keyOf) => { const m = new Map(); for (const x of arr) { const k = keyOf(x); if (!m.has(k)) m.set(k, x); } return [...m.values()]; };

export async function claygentResearch(entity = {}, brief = '', deps = {}) {
  const { getLlmJson, fetchText } = deps || {};
  const base = {
    summary: '', report: '', signals: [], competitors: [], risks: [], sections: [],
    why_narrative: '', layer: CLAYGENT_LAYER, source: CLAYGENT_SOURCE,
    degraded: false, fetchedSections: 0,
  };
  // fail-open ①：无 LLM 调用器（未配置 provider 时调用方传 null）
  if (typeof getLlmJson !== 'function') return { ...base, degraded: true };

  // ① 区块规划（二分起点：先判信息所在区块，不整站抓取）
  let plan = null;
  try {
    plan = await getLlmJson(SECTION_SYSTEM,
      `公司：${entity.name || '(未知)'}；域名：${entity.domain || '(未知)'}\n研究简报：${brief || '(无)'}`,
      { timeoutMs: 30000 });
  } catch { return { ...base, degraded: true }; }

  const sections = asArray(plan && plan.sections)
    .slice(0, MAX_SECTIONS)
    .map((x) => (typeof x === 'string' ? { name: x } : x))
    .filter((x) => x && x.name);
  // fail-open ②：模型未给出任何区块 → 无产出（不伪造）
  if (!sections.length) return { ...base, degraded: true };

  // ② 逐区块：定向抓取（有通道才抓；单区块失败不中断）→ LLM 抽取笔记
  let summary = ''; let fetchedSections = 0;
  const signals = []; const competitors = []; const risks = [];
  for (const sec of sections) {
    let raw = '';
    const url = sec.url || (entity.domain ? `https://${entity.domain}` : null);
    if (typeof fetchText === 'function' && url) {
      fetchedSections += 1;
      try { raw = await fetchText(url, sec.name); } catch { raw = ''; } // fail-open：单区块抓取失败不中断
    }
    let part = null;
    try {
      part = await getLlmJson(EXTRACT_SYSTEM,
        `区块：${sec.name}\n网页文本：${raw || '(未取得网页文本；仅可基于已知信息作答，无依据则留空)'}`,
        { timeoutMs: 30000 });
    } catch { part = null; }
    if (!part) continue;
    if (part.summary) summary = `${summary} ${part.summary}`.trim();
    signals.push(...asArray(part.signals));
    competitors.push(...asArray(part.competitors));
    risks.push(...asArray(part.risks));
  }

  const uniqSignals = uniqBy(signals, (x) => (x && x.type) || JSON.stringify(x));
  const uniqComp = [...new Set(competitors.filter(Boolean))];
  const uniqRisks = [...new Set(risks.filter(Boolean))];

  // fail-open ③：全程零产出 → degraded（不写库由 handler 依 hasContent 判定）
  if (!summary && !uniqSignals.length && !uniqComp.length && !uniqRisks.length) {
    return { ...base, sections: sections.map((x) => x.name), fetchedSections, degraded: true };
  }

  // ③ glass-box（C2）：why_narrative 非空（SKILL postcondition payload.research.why_narrative!=null）
  const score = Number(Math.min(0.95, 0.5 + 0.1 * uniqSignals.length).toFixed(2));
  const gb = localGlassBox({ score, ruleRef: RULE_REF, signals: uniqSignals });

  return {
    summary, report: summary,
    signals: uniqSignals, competitors: uniqComp, risks: uniqRisks,
    sections: sections.map((x) => x.name),
    why_narrative: gb.why_narrative, glass_box: gb,
    layer: CLAYGENT_LAYER, source: CLAYGENT_SOURCE, degraded: false, fetchedSections,
  };
}
```

- [ ] **Step 4: Wire `discovery-research`——改 `src/action/discoveryActions.js`**

**4a. 顶部 import 区追加**（与既有 `import { createEdge } from '../particles/particleRepo.js';` 同源追加一行，避免第二个 import 语句）：

```js
import { createEdge, getParticle, updateParticle } from '../particles/particleRepo.js';
```

**4b. 在 `seedDiscoveryActions()` 之外新增导出编排函数**（DI 注入 ⇒ 单测零 DB；handler 只做守卫 + 转发）：

```js
// 编排（可独立单测：deps 注入替身 → 零 DB）。handler 仅做「决策守卫 + 转发」。
// fail-open：无产出绝不写库（T8 断言②）。写 payload.research 用浅合并 patch（particleRepo.js:210
//   { ...cur.payload, ...patch }）→ 不冲掉既有 discovery/enrichment 段。
export async function runDiscoveryResearch(input = {}, ctx = {}, deps = {}) {
  const { account_id, brief } = input || {};
  const getP = deps.getParticle || getParticle;               // 顶部已静态 import
  const updP = deps.updateParticle || updateParticle;
  const claygentResearch = deps.claygentResearch
    || (await import('../connectors/discovery/claygent.js')).claygentResearch;
  let getLlmJson = deps.getLlmJson;
  if (getLlmJson === undefined) {
    const { getLlmJson: factory } = await import('../llm/client.js');
    // 真实形状：工厂 → 调用器；无 LLM 配置返回 null（fail-open）
    getLlmJson = await factory({ tenantId: ctx && ctx.tenantId }).catch(() => null);
  }
  const p = account_id ? await getP(account_id).catch(() => null) : null;
  const entity = p ? { id: p.id, name: p.payload && p.payload.name, domain: p.payload && p.payload.domain } : { id: account_id };
  const research = await claygentResearch(entity, brief, { getLlmJson, fetchText: deps.fetchText });
  const hasContent = !!(research.summary || (research.signals || []).length
    || (research.competitors || []).length || (research.risks || []).length);
  if (!hasContent) return { account_id, research, written: false, decision_id: (ctx && ctx.decision_id) || null };
  await updP(account_id, { patch: { research }, tenantId: ctx && ctx.tenantId, requireDecisionId: (ctx && ctx.decision_id) || null });
  return { account_id, research, written: true, decision_id: (ctx && ctx.decision_id) || null };
}
```

**4c. 把 `discovery-research` 的 handler 收口为**（**原地替换** Task 5 遗留的旧 handler —— 旧体用了 runtime 不存在的 `ctx.getParticle` / `ctx.getLlmJson`，见校正声明②）：

```js
    handler: async ({ account_id, brief }, ctx) => {
      requireMintedDecision(ctx, 'discovery-research');
      return runDiscoveryResearch({ account_id, brief }, ctx);
    },
```

> ⚠ 该 handler 是**原地替换**（唯一例外：此处允许改写既有行，因为旧体是 runtime 不存在的 API 调用）。`registerDiscovery` 的其余字段、另外两个 Action（`discovery-run` / `discovery-enrich`）**一律不动**。
> ⚠ `function` 声明存在提升，故 `seedDiscoveryActions()` 在前、`runDiscoveryResearch` 在后亦可正常引用。

**4d. 附带收口 `discovery-enrich` 的同款缺陷**（同文件同类，见校正声明⑨；`getParticle` 已由 4a 引入，无需 extra import）：

```js
      // 原：const entity = (ctx.getParticle ? await ctx.getParticle(account_id) : null) || { id: account_id };
      // ctx 上没有 getParticle（executor.js 只传 params+ctx）→ 直调 repo；旧写法是恒假守卫，
      // entity 会退化为 { id } 致适配器拿不到 name/domain/email（静默退化、测试仍绿）。
      const p = await getParticle(account_id).catch(() => null);
      const entity = p ? { id: p.id, name: p.payload?.name, domain: p.payload?.domain } : { id: account_id };
```


- [ ] **Step 5: Run tests to verify pass**

Run: `npx vitest run test/connectors/discovery/research.test.js`
Expected: PASS（7 例）

- [ ] **Step 6: Regression + red-line self-check**

Run: `npx vitest run test/action/ test/connectors/discovery/ test/config/ test/agent/discoverySchema.test.js`
Expected: 既有用例零回退（Task 1–7 全部）；`test/action/discoveryActions.test.js` 5 例仍绿。
另须自检：
- `grep -n "DELETE FROM\|\.delete(" src/connectors/discovery/claygent.js` → **0 命中**
- `grep -n "ctx\.getParticle\|ctx\.getLlmJson" src/action/discoveryActions.js` → **0 命中**（两处旧缺陷均已收口：`discovery-research`（Step 4c）+ `discovery-enrich`（Step 4d，见校正声明⑨））
- `grep -n "^import " src/connectors/discovery/claygent.js` → **0 命中**（纯函数、零静态依赖）

- [ ] **Step 7: Commit**

```powershell
git add src/connectors/discovery/claygent.js src/action/discoveryActions.js test/connectors/discovery/research.test.js
git commit -m "feat(discovery): Claygent block-bisect research with glass-box why_narrative (C2)"
```

---

## Task 9: 记忆捕获域 + 上下文 L2 注入红线（P0 #2）

**Files:**
- Modify: `src/memory/capture.js:16-19`（`DEFAULT_CAPTURE_DOMAINS` 增 `'discovery'`）
- Modify: `src/agent/discoverySchema.js`（新增纯函数 `enforceContextByteLimit()` + 常量 `KNOWLEDGE_CONTEXT_BYTE_LIMIT`）
- Modify: `src/agent/discoveryOrchestrator.js`（产出后 emit `discovery` 域事件，payload 先过闸）
- Test: `test/memory/discoveryCapture.test.js`

**派发前契约复查结论（2026-09-11 · 源码级逐条实证 · 已消解）：**

1. 🔴 **死配置陷阱（必须消解）**：全仓 `emit('discovery', …)` **零命中**（`grep -rn "emit('discovery'"` 为空；`discoveryOrchestrator.js:64,86` 出现的 `source:'discovery'` 只是 payload 字段值，**不是事件域**）。若只加白名单、不交付 emit 源 → capture 永不触发 → 「捕获域」是**加即死配置**（与 T6 判死 `discovery-sync` emitter 同源缺陷）。**本 Task 必须同时交付 emit 源**。

2. 🔴 **三条 payload 硬约束（缺一即假闭环 / 静默不落库）**：
   - ① **必须带非空 `summary` 键**：`capture.js:58` 以 `msg.summary` 作 payload 落库；而 `injector.js#memoryText` **只认 `text|summary|note|content` 四键** → 不带 `summary` 则「写得进、读不出」，与 `memoryLog.js:112-119` 记载的旧决策投影（写读双向落空）同款坑。
   - ② **必须带 `account_id`**：`memoryLog.js:55` 的 C2 锚点解析会把 `payload.account_id` 归为 `entity_type='ACCOUNT'` → 跨商机累积客户记忆（锚商机则换单即断链，设计取舍 C2）。
   - ③ **不得触发瞬态噪声 / 凭证闸**：`judge.js:59-65` 的 `judgeWorthiness` 命中即返 `{ok:false}`，**静默不落库（无异常抛出）**；`CREDENTIAL_RE` 命中则硬拒。测试与生产 payload 均须干净（禁 `/tmp/`、`Error:`、`at file.js:1:2` 等形态）。

3. 🔴 **红线判据须换（`git diff --stat` 不可用）**：原判据（test-plan §5-3 / :48 / :122）有两处致命缺陷 —— ① 依赖 git 子进程，而本项目 `.git` 对象库常不完整（项目长期记忆）；② `git diff --stat` 只反映**未提交**改动，一旦提交即失效，**零回归防护力**。改判据为**内容 sha256 冻结**（零 git 依赖、永久有效）+ 源码语义断言。
   - 冻结值（2026-09-11 实测，`sha256(readFileSync(f))`）：`src/context/routing.js` = `aa7a5ad7b5ca7d12fce8a1063a0e4d6107a640632ff62891415c428ec8671f67`；`src/context/assembler.js` = `12ac9bc27edc76a8ffa03c082ae94cd43d261c492e6001524de8c0fa73e5b54a`
   - 语义断言：两文件源码**均不含 `discovery` 字样**（已实测为空）+ `routing.js` 的 `ROUTING_KEY === 'context-routing'`（`:18`，id36 键名不被篡改）。
   - 红线机制：任何对这两个文件的改动（含合法需求）**必须先 brainstorming 批准**，批准后同步更新本测试的冻结值 —— 强制显式面对，不留静默通道。

4. 🟠 **64KB 闸的落点与命名**：`degradedLayers` 在 `src/` **零实现**（仅文档契约：ai-context-layering `:55` 定义 `KNOWLEDGE_CONTEXT_BYTE_LIMIT = 64KB`、`:193` 示例 `"degradedLayers": ["L2"]`；design `:359`）。故闸函数落 **`discoverySchema.js`（T4 已建的纯函数模块）**，常量沿用文档既有命名 `KNOWLEDGE_CONTEXT_BYTE_LIMIT`（**禁发明新名**）；落点**不在 orchestrator 内联** —— 纯函数才可零 DB 单测（对齐 `test/memory/` 全纯函数范式，见 `memory-writeback.test.js:1-2`）。

5. 🟡 **测试零 PG 依赖**：`test/memory/` 现有用例全为纯函数、无 PG。T9 用 `vi.mock` 替换 `memoryLog.appendMemory` 以捕获「emit → 订阅者 → appendMemory」链路入参，**不连库**（比真写 PG 更精确、零 flaky）。

6. 🟡 **副作用核验（test-plan :153）**：捕获域变更可能影响既有记忆用例 → Step 4 须加跑 `test/memory/` 全量确认零回归。

- [ ] **Step 1: Write failing test**（`test/memory/discoveryCapture.test.js`，**零 PG**）
  - ① `getCaptureDomains()` 含 `'discovery'`；`isCapturable('discovery') === true`。
  - ② **白名单硬闸不可绕过**：`setCaptureDomains(['discovery','trace'])` 后 `isCapturable('trace') === false`（`BLOCKED_DOMAINS` 永远不生效）。
  - ③ **id36 红线（内联，取代原 §5-3 独立文件）**：`sha256(readFileSync(src/context/routing.js)) === 冻结值`，同 `assembler.js`；两文件源码不含 `discovery`；`ROUTING_KEY === 'context-routing'`。
  - ④ **emit → 捕获闭环**（`vi.mock('../../src/memory/memoryLog.js')` 替身）：`registerCaptureSubscriber()` 后 `emit('discovery','lead-discovered',{summary:'…',account_id:'ACC-1'})` → `appendMemory` **被调用**且入参 `payload.summary` 非空；`emit('unlisted','x',{})` → **不被调用**（未列域不捕获）。
  - ⑤ **64KB 纯函数闸**：`enforceContextByteLimit(smallPayload)` → `truncated === false` 且结构原样；`enforceContextByteLimit(hugePayload)`（>64KB）→ `truncated === true`、`degradedLayers` 含 `'L2'`、`Buffer.byteLength(JSON.stringify(out)) <= KNOWLEDGE_CONTEXT_BYTE_LIMIT`，且关键键 `summary` 仍非空（关键字段不被裁空）。

- [ ] **Step 2: Run** → FAIL（`Cannot find module .../discoveryCapture.test.js` 的前置：`enforceContextByteLimit` 未导出 / 白名单未含 discovery → 断言红）

- [ ] **Step 3: 实现**
  - `capture.js:16-19`：`DEFAULT_CAPTURE_DOMAINS` 数组加 `'discovery'`（**其余一字不改**）。
  - `discoverySchema.js`：新增 `export const KNOWLEDGE_CONTEXT_BYTE_LIMIT = 64 * 1024;` + `export function enforceContextByteLimit(payload, { limitBytes = KNOWLEDGE_CONTEXT_BYTE_LIMIT } = {})`；超限时按**字段文本长度降序**裁剪长文本（保 `summary` 非空、`account_id` 原样），标 `truncated:true` + `degradedLayers:['L2']`；不超限则**原样返回且 `truncated:false`**。**纯函数、零副作用、不触 DB**。
  - `discoveryOrchestrator.js`：`return` 前组装 memory payload `{ summary: \`发现线索 ${seed.name} → ${deal.id}（rule_ref=scenario:lead-fit；decision_id=${decisionId||'pending'}）\`, account_id: account.id, deal_id: deal.id, tenant_id: tenantId, evidence: enriched }` → `const gated = enforceContextByteLimit(memPayload)` → `emit('discovery', 'lead-discovered', gated)`（`import { emit } from '../events/bus.js'`）。
  - **绝不修改 `src/context/routing.js` / `src/context/assembler.js`**（红线；Step 1 ③ 会当场抓）。

- [ ] **Step 4: Run** → PASS；**并加跑回归**（捕获域变更零回归 + T4/T7/T8 不红）：
  `npx vitest run test/memory/ test/agent/discoverySchema.test.js test/agent/discoveryOrchestrator.test.js test/connectors/discovery/`

- [ ] **Step 5: Commit**

```powershell
git add src/memory/capture.js src/agent/discoverySchema.js src/agent/discoveryOrchestrator.js test/memory/discoveryCapture.test.js
git commit -m "feat(discovery): P0#2 discovery capture domain + emit source + 64KB context gate + id36 redline freeze"
```

## Task 10: S1 衔接验证（复用 intake-router + BANT，不新增 · test-only）

**Files:**
- Test only: `test/integration/discoveryToS1.test.js`（连 PG 端到端：DEAL 落 S1 归一 + 既有 `salesStageGate` 闸 + 既有 `routeThroughIntake` 分级 + 决策行真落 `decision_id`）

**派发前契约复查结论（2026-09-11 · 源码级实证 · 已消解）：**

1. 🔴 **测试路径裁决**：取主计划路径 `test/integration/discoveryToS1.test.js`（本 Task 是**连 PG 的端到端集成验证**：真写粒子 + 真 mint 决策行）。test-plan §4 原写 `test/connectors/discovery/s1Handoff.test.js` 语义不符 —— 该目录现有 5 个测试（waterfall / providerRegistry / adapters / dedupResolver / research）**全为零 PG 的替身单测**；而 `test/integration/` 现有 5 个（training-tenant-e2e 等）**全是连 PG 集成测试**。两侧已同步为 integration 路径。

2. 🔴 **「经 BANT 闸进入 S1」是错误语义（必须重定义）**：`S_ALIAS_FWD.lead = 'S1'`（`src/sales/stageTaxonomy.js:13`）→ `createParticle` 内部走 `normalizeStage`（`src/particles/particleRepo.js:88` → `:20`），**写入时即把 `stage:'lead'` 归一成 `'S1'` 存储**。即 **S1 是「新建即达」，不经任何闸**；`S_GATE_DEFS` 的第一道闸是 **`S1→S2`**（`need_facts`，`stageTaxonomy.js:44-52`）。故本 Task 只验证两件**真实**的事：
   - ① **落库归一**（不是闸推进）：DEAL 落库 `stage === 'S1'`，且 `source === 'discovery'`、`account_id` 已绑；
   - ② **既有阶段/BANT 闸复用**：`salesStageGate()` 对 `S1→S2` 的 hard 拦截与放行。

3. 🔴 **BANT 闸不在 `crm-deal-advance` handler 内**：handler（`src/action/seed-actions.js:733-772`）只做 `ruleEngine.check('CRM_DEAL','advance')` + 第 0 闸 + `advanceStage()`；**第 3.5 闸（阶段推进前置 = BANT/需求事实门控）在 `src/action/executor.js:165-175`**，其判定调用 **`salesStageGate()`** —— 后者是 **`export function`（`executor.js:355`）**，可直接导入单测。故：**不要**只调 handler（会绕过闸，得假绿），要调 `salesStageGate` 或经 `actionExecutor.dispatch('crm-deal-advance', …)` 走完整闸链。

4. 🔴 **`intake-router` 不是可调用函数**：它是 agentSpec 的子智能体定义（`src/agent/agentSpec.js:4`），且 `src/kanban/scheduler.js:116` 注释明说「intake-router 是内嵌路由逻辑、**无独立 dispatch 路径**」。真实可测面是 **`routeThroughIntake(task)`（`export function`，`scheduler.js:38`）** —— 断言线索任务被既有接诊分流**分级路由**（返回 `targetAgent` + `payload.level`），以此证明"复用既有入口"而非新增路由。

5. 🟠 **`discovery-run` 经 executor 会走第 0 闸 mint**（`executor.js:63-71`：`autoDecision && !decisionId && decisionScenario` → `getScenario('LEAD_FIT', tenantId)` 命中才 mint）。**`getScenario` 租户专属缺失时回退 `system`**（`executor.js:23-24` 注释）→ 测试可用**专用租户**，场景行由 T6 落在 `system` 即可命中。若场景缺失 → `:71` 只 emit trace **静默不 mint** → T5 的 `requireMintedDecision`（`discoveryActions.js:14-19`）抛错。故测试**必须断言 decision 表真落行**（防「静默不 mint」假绿）。

6. 🟠 **`beforeAll` 须显式 `seedDiscoveryActions()`**：`seed-actions.js` 的 `seedActions()` **不含** discovery 注册（T5 的三处注册入口是 `agents.js` / `http/routes.js` / `skills/seed.js`）。范式对齐 `test/integration/training-tenant-e2e.test.js:8-18`。

7. 🟡 **本 Task 是 test-only**：若测试暴露既有管道缺陷 → **停下报告、判定归属**（既有缺陷另立 Task 修），**本 Task 不改任何 `src/`**。原 Step 2 写"衔接点需微调"有越界风险，已改写。

8. 🟠 **租户 FK 前置（执行时发现 · 已实证 · 2026-09-11）**：`crm.decision` 有复合外键 `decision_scenario_tenant_fkey`，要求 `(scenario_id, tenant_id)` 在 `decision_scenario` 中存在。`getScenario` 的「租户缺失回退 system」只解决**读取**，**不解决写入 FK** → **新租户首次 mint 直接 FK 违例**；且 mint 位于 `executor.js:64-74`，在 `:207` 的 try/catch **之外**，异常会逃逸出 `dispatch()`。**此非管道缺陷**，而是 G5「全隔离」的租户预置前提 —— 测试 `beforeAll` 须先把 `system` 的场景行克隆到本租户（范式：`portal/decisionScenario.js:192-202`、`test/propagation/integration.test.js:20-27`）。**该结论对 T16（monitorAccount 重评分）同样适用**，勿重蹈。

9. 🟠 **payload 落点（我的原稿错，执行时纠正）**：`discovery` 段由 `discoveryOrchestrator.js:81` 的 `update(account.id, { enrichment, discovery })` 写在 **ACCOUNT** 上，**不在 DEAL**（DEAL 仅 `name/stage/source/account_id`）。故 `why_narrative` / `decision_id` 须从 **ACCOUNT** payload 提取。已实测：DEAL 无 `discovery` 字段。

- [ ] **Step 1: Write integration test**（`test/integration/discoveryToS1.test.js`，专用租户 `discovery-t10`，连 PG）
  - `beforeAll`：`seedActions()` + `seedDiscoveryActions()`；清理该租户粒子/边。
  - `afterAll`：清理该租户粒子/边。（**测试清理用 DELETE 是 `test/integration/` 既有惯例**，见 `training-tenant-e2e.test.js:15-21`；业务 `src/` 仍零 DELETE。）
  - ① **落库归一**：`actionExecutor.dispatch('discovery-run', { seed: { name: 'T10 线索客户', domain: 't10.example.com' } }, { tenantId: 'discovery-t10', actor: 't10', bootstrap: true })` → `res.ok === true`；查库断言 DEAL：`stage === 'S1'`（**写入归一，非闸推进**）、`source === 'discovery'`、`account_id` 非空；ACCOUNT 落 `state === 'potential'`。
  - ② **决策第 0 闸真落行**：从 **ACCOUNT** payload 的 `discovery.why_narrative` 正则提取 `decision_id=([\w-]+)`，断言其非 `'pending'`，且 `crm.decision WHERE decision_id = …` 恰 1 行。（两处易错：a) `runDiscovery` **返回值不含** `decision_id`，它只被 `discoverySchema.js:38` 写进 why_narrative；b) `discovery` 段由 `:81` 落在 **ACCOUNT**、**不在 DEAL** —— 见复查结论第 9 条。）
  - ③ **既有阶段闸复用（不新增）**：`salesStageGate({ curStage: 'S1', toStage: 'S2', dealPayload: {} })` → `ok === false` 且 `gaps` 含需求事实缺失；`salesStageGate({ curStage: 'S1', toStage: 'S2', dealPayload: { needs: { product: 'X', qty: 1, spec: 'Y' } } })` → `ok === true`。
  - ④ **既有接诊分流复用（不新增）**：`routeThroughIntake(...)` 对线索任务返回 `targetAgent` 与 `payload.level`（证明复用既有 A 入口路由，**未新增 stage/scenario**）。
  - ⑤ **零新增护栏**：静态断言 `S_STAGES.length === 8` 且 `S_GATE_DEFS[0]` 为 `S1→S2`（防本 Task 顺带改阶段字典）；并断言 `src/` 内 `emit('discovery'` 的 domain 未被改成新 scenario 名。

- [ ] **Step 2: Run** → 若红：先判定是**既有管道缺陷**还是**测试设计缺陷**；本 Task 只改测试，既有缺陷**停下报告**另立 Task，绝不在此改 `src/`。

- [ ] **Step 3: Commit (test only)**

```powershell
git add test/integration/discoveryToS1.test.js
git commit -m "test(discovery): verify S1 handoff reuses intake-router + BANT gate (no new logic)"
```

## Task 11: ICP 自进化草稿→回测→HITL（P0 #3）

**硬约束：无 HITL 批准绝不生效**（`CALIBRATION_CHANGE.autonomous_allowed=false`，测试库实证）。

**Files:**
- Create: `src/evolution/icpSelfEvolution.js` — 纯编排（propose / backtest / approve；`store` 注入）
- Create: `src/evolution/icpStore.js` — 真实 store（`config_store['discovery-rules']` 读写 + 决策第 0 闸锚点）
- Modify: `src/scheduler/timers.js` — `runRetroOnce` 增第 ④ 段 pass（可注入 + 独立 catch）
- Test: `test/evolution/icpSelfEvolution.test.js`（**零 PG**，替身 store）

> **派发前源码级复查消解（2026-09-11）**——原稿 6 项契约级缺陷，逐条消解如下：
> 1. 🔴 **触发源缺失 = 交付即死代码**：`icpSelfEvolution` 全仓（`src/` `test/` `scripts/`）**零命中**，仅计划文档提及；原稿无任何调用方。→ 挂 `src/scheduler/timers.js:31` 的 `runRetroOnce` 第 ④ 段（既有 ① ② ③ 段范式：可注入 + 独立 catch + 只出 PENDING 绝不自动 apply），与本 Task 一并交付（这是「让改动生效的那条接线」）。
> 2. 🔴 **违反 test-plan §1 gate 1**：原稿 `store.insertScenarioDraft` **无 `requireDecision`** → 草稿落库不落 `crm.decision` 行。→ 真实 store 内必经 `requireDecision('CALIBRATION_CHANGE', …)`，并把 `decisionId` 传入 `writeConfig(..., { decisionId })`（`configStore.js:64` 已有该参数）。
> 3. 🔴 **`store.insertScenarioDraft` / `setScenarioValidated` 全仓零命中（虚构接口）**：且 `crm.decision_scenario` 实测列（`scenario_id…tenant_id, stage_code, focus_rulers, rubric_pass_line, enabled_rulers`）**无 `validated` / `status` / `draft` 列** → 草稿**不可落字典表**。→ 落点 = `config_store['discovery-rules']` 的 **`icp_draft` 子键**（生效态仍是既有 `icp` 键；`DEFAULT_DISCOVERY_RULES.icp` 见 `src/config/discoveryRules.js:11-16`）。
> 4. 🔴 **场景 id 必须复用实测存在的**：`requireDecision` 对未知场景 **直接 throw**（`autonomyEngine.js:124`）。实测测试库仅有 `CALIBRATION_CHANGE`(system/HIGH/`autonomous_allowed=false`) 与 `LEAD_FIT`；原拟用的 `config-change` **零行**（仅 `configRouter.js:146` 等处引用，场景本身未 seed）。→ 冻结 **`CALIBRATION_CHANGE`**：语义为「决策引擎校准参数变更（阈值/权重）」，`autonomous_allowed=false` 天然强制 HITL；**零 seed 改动**。
> 5. 🔴 **返回形状陷阱**：`requireDecision` 返回 `{ mode, decision, confidence, tier, … }`（`autonomyEngine.js:308`），决策行在 **`.decision` 对象内**，顶层**无** `decision_id`。→ store 取 `res?.decision?.decision_id`；测试断言该值非空且 `crm.decision` 真落行。
> 6. 🔴 **`needsApproval: report.passed` 语义反转**：回测「通过」反而标记为需要审批。→ 改 **`needsApproval: true` 恒真**（硬约束「无 HITL 绝不生效」），`passed` 仅表「回测是否支持本次变更」。
> 7. 🟠 `backtest(store, draft)` 原稿**未定义、无 import**，判据 `threshold/count/noop` 无出处。→ 三态显式化，样本闸复用 `MIN_SAMPLE = 20`（`src/calibration/constants.js:5`）；`noop` = 草稿与现行 ICP 零差异（空操作闸，防 churn）。
> 8. 🟠 禁 DELETE 红线须覆盖本 Task 新文件（test-plan §1 gate 2 已列 `src/evolution/icpSelfEvolution.js`）。
> 9. 🟠 与既有 `src/calibration/` 层的关系需说明：calibration = 阈值旋钮（`crm.calibration_patch` 表 + `PENDING→APPROVED/ROLLED_BACK`）；ICP = 发现规则（`config_store['discovery-rules']`）。**不新建表**，但复用其 `dryRun` / 「只出草稿绝不自动 apply」范式。

- [ ] **Step 1: Write failing test** — `test/evolution/icpSelfEvolution.test.js`（**零 PG**：替身 store + 纯函数回测）。断言 6 组：
  - ① **草稿先落、绝不自动生效**：`proposeIcpRecalibration(store, draft, { tenantId, samples })` 返回 `{ draftId, decisionId, report, needsApproval: true, validated: false }`；断言 `needsApproval === true` **恒真**（与回测是否通过无关）、`store.insertDraft` 被调用恰 1 次、**生效写 (`store.writeActiveIcp`) 调用 0 次**。
  - ② **回测报告存在且含三态判据**：`report.verdict ∈ ['threshold','count','noop']`、`report.sample_size`、`report.hit_rate` 为数值。
  - ③ **无 HITL 绝不生效**：仅调 `proposeIcpRecalibration` 后，断言`store.writeActiveIcp` **从未被调用**（这是本 Task 的**核心红线断言**，须独立成例）。
  - ④ **批准后生效 + 落 decision_id**：`approveIcpRecalibration(store, draftId, 'admin')` → `store.setValidated(draftId, true, 'admin')` 被调用；返回体含**非空 `decisionId`**（且 ≠ `null`/`'pending'`）。
  - ⑤ **三态回测**（`backtestIcpDraft` 纯函数直测）：
    - `noop`：`draft.icp` 与 `current` 深度相等 → `verdict==='noop'`、`passed===false`（空操作不得推进）。
    - `count`：`samples.length < minSample`（默认 20）→ `verdict==='count'`、`passed===false`（防过拟合噪声，对齐 R5/R6）。
    - `threshold`：`samples.length >= 20` 且命中率 ≥ `passLine` → `verdict==='threshold'`、`passed===true`。
  - ⑥ **禁 DELETE 源码断言**：读 `src/evolution/icpSelfEvolution.js` + `src/evolution/icpStore.js` 源码，断言不含 `DELETE FROM` 与 `.delete(`（使用 `/DELETE\s+FROM|\.delete\s*\(/i`）；归档一律状态标记。
  - ⑦ **真实 store 契约测（零 PG：注入替身 read/write/gate）** —— 本组是防「真实 store 从未被验证」的关键，必须独立成例：
    - `createIcpStore({ read, write, gate })` 注入替身后：
      - `insertDraft()` 调 `gate` 恰 1 次、`gate` 首参 === `'CALIBRATION_CHANGE'`；**`write` 收到的 value 中 `icp` 未被覆盖**（生效键不动）+ `icp_draft.items` 长度 +1 且 `status==='draft'`。
      - **gate 替身返回 `{ decision: { decision_id: 'DEC-T11' } }` → 断言 `write` 收到的 `opts.decisionId === 'DEC-T11'`**（这一条专防 `.decision` 取值路径写错 → `decisionId` 恒 `null` 的静默假绿）。
      - `setValidated(draftId, true, 'admin')` → `write` 收到的 value 中 `icp` **=== 草稿 icp**（唯一致效写）+ 该草稿 `status==='approved'`、`validated===true`、`approved_by==='admin'`。
      - **无 `approver` 时 `approveIcpRecalibration` 抛错**（fail-closed，不得静默生效）。

- [ ] **Step 2: Run** → FAIL（`Cannot find module '../../../src/evolution/icpSelfEvolution.js'`）

- [ ] **Step 3: Implement**

**3a. `src/evolution/icpSelfEvolution.js`（纯编排；`store` 注入 → 单测零 PG）**

```js
// src/evolution/icpSelfEvolution.js
// ICP 自进化：草稿 → 回测 → HITL 生效（P0#3）
// 铁律：
//   1. **无 HITL 批准绝不生效**——propose 只落草稿（icp_draft），生效写（icp）仅由 approve 触发。
//   2. 决策第 0 闸（requireDecision）由 store 层承担（config_change 类写必经）；本层纯编排。
//   3. 阈值/权重 100% 配置驱动（config_store['discovery-rules'].icp）；本文件零行业字面量。
//   4. 禁 DELETE：草稿归档用 status 标记（'draft'|'approved'|'rejected'），绝不物理删除。
import { MIN_SAMPLE } from '../calibration/constants.js';

export const ICP_DRAFT_KEY = 'icp_draft';
export const DRAFT_STATUS = Object.freeze(['draft', 'approved', 'rejected']);
export const BACKTEST_VERDICTS = Object.freeze(['threshold', 'count', 'noop']);

// 回测（纯函数、零 IO）：现行 ICP vs 草稿 ICP + 历史样本
//   三态判据（顺序即优先级）：
//     noop      —— 草稿与现行零差异 → 空操作闸（防 churn，绝不无意义改写线上配置）
//     count     —— 样本不足（< minSample，默认 MIN_SAMPLE=20）→ 拒绝推进（防过拟合噪声，对齐 R5/R6）
//     threshold —— 样本充足且命中率 ≥ passLine → passed=true
export function backtestIcpDraft({ draft, current = {}, samples = [], minSample = MIN_SAMPLE, passLine = 0.6 } = {}) {
  const proposed = draft?.icp || draft || {};
  const deltas = {};
  for (const k of new Set([...Object.keys(current || {}), ...Object.keys(proposed || {})])) {
    const a = current?.[k]; const b = proposed?.[k];
    if (JSON.stringify(a) !== JSON.stringify(b)) deltas[k] = { from: a, to: b };
  }
  const sampleSize = Array.isArray(samples) ? samples.length : 0;
  const hitRate = sampleSize ? samples.filter((s) => s?.hit === true).length / sampleSize : 0;
  let verdict;
  if (Object.keys(deltas).length === 0) verdict = 'noop';
  else if (sampleSize < minSample) verdict = 'count';
  else verdict = 'threshold';
  const passed = verdict === 'threshold' && hitRate >= passLine;
  return { verdict, passed, hit_rate: Number(hitRate.toFixed(4)), sample_size: sampleSize, deltas, min_sample: minSample, pass_line: passLine };
}

// 出草稿：先回测 → 再落草稿（绝不自动生效）→ needsApproval 恒真
export async function proposeIcpRecalibration(store, draft, { tenantId = 'system', samples = [], actor = 'system' } = {}) {
  const current = await store.readActiveIcp({ tenantId });
  const report = backtestIcpDraft({ draft, current, samples });
  const { draftId, decisionId } = await store.insertDraft({ ...draft, status: 'draft', report }, { tenantId, actor });
  return { draftId, decisionId, report, needsApproval: true, validated: false };
}

// HITL 生效：唯一把草稿写进线上 icp 的入口（approver 必填，缺失即 fail-closed）
export async function approveIcpRecalibration(store, draftId, approver, { tenantId = 'system' } = {}) {
  if (!approver) throw new Error('approveIcpRecalibration: approver 必填（HITL 硬约束）');
  if (!draftId) throw new Error('approveIcpRecalibration: draftId 必填');
  const { decisionId } = await store.setValidated(draftId, true, approver, { tenantId });
  return { draftId, decisionId, validated: true, approver };
}

// 夜批 pass（对齐 runParamInspectionPass 范式：dryRun / 只出草稿 / 独立 catch）
export async function runIcpEvolutionPass({ tenantId = 'system', dryRun = false, store = null, samples = [], draft = null } = {}) {
  if (!store) return { tenantId, drafts: 0, skipped: 'no_store' };
  if (!draft) return { tenantId, drafts: 0, skipped: 'no_draft_proposed' };  // 无候选即不产草稿（绝不自动编造）
  const r = await proposeIcpRecalibration(store, draft, { tenantId, samples });
  return { tenantId, drafts: 1, dryRun, draftId: r.draftId, verdict: r.report.verdict, needsApproval: true };
}
```

**3b. `src/evolution/icpStore.js`（真实 store：config_store 读写 + 决策第 0 闸）**

```js
// src/evolution/icpStore.js
// ICP 自进化 store：config_store['discovery-rules'] 读写 + 决策第 0 闸锚点。
// 铁律：① 写必经 requireDecision（落 crm.decision 行）+ decisionId 透传 writeConfig；
//      ② 只 upsert，绝不 DELETE（icp_draft 多草稿用数组 append + status 标记）；
//      ③ per-tenant (tenant_id, key) 收敛。
import { readConfig, writeConfig } from '../config/configStore.js';
import { requireDecision } from '../decision/autonomyEngine.js';
import { ICP_DRAFT_KEY } from './icpSelfEvolution.js';

export const ICP_DECISION_SCENARIO = 'CALIBRATION_CHANGE'; // 实测存在（system/HIGH/autonomous_allowed=false）

export function createIcpStore({ read = readConfig, write = writeConfig, gate = requireDecision } = {}) {
  return {
    async readConfigRow(tenantId) {
      const row = await read('discovery-rules', { tenantId });
      return row?.value || {};
    },
    async readActiveIcp({ tenantId = 'system' } = {}) {
      const v = await this.readConfigRow(tenantId);
      return v.icp || {};           // 生效态
    },
    // 落草稿（第 0 闸 → decisionId → writeConfig）；生效键 icp **不动**
    async insertDraft(draft, { tenantId = 'system', actor = 'system' } = {}) {
      const res = await gate(ICP_DECISION_SCENARIO,
        { action: 'icp-recalibration-draft', tenantId, icp: draft?.icp || null },
        [{ type: 'CRM_ACCOUNT', id: null }],
        { actor_id: actor, tenantId });
      const decisionId = res?.decision?.decision_id || null;   // ⚠ 决策行在 .decision 内
      const v = await this.readConfigRow(tenantId);
      const drafts = Array.isArray(v[ICP_DRAFT_KEY]?.items) ? v[ICP_DRAFT_KEY].items : [];
      const draftId = `icp-${Date.now()}-${drafts.length + 1}`;
      drafts.push({ id: draftId, status: 'draft', validated: false, decision_id: decisionId,
        icp: draft?.icp || null, report: draft?.report || null, created_by: actor, created_at: new Date().toISOString() });
      await write('discovery-rules', { ...v, [ICP_DRAFT_KEY]: { items: drafts } }, { tenantId, decisionId, updatedBy: actor });
      return { draftId, decisionId };
    },
    // HITL 生效：把草稿 icp 写进生效键（唯一入口），草稿标 approved（不删）
    async setValidated(draftId, validated, approver, { tenantId = 'system' } = {}) {
      const res = await gate(ICP_DECISION_SCENARIO,
        { action: 'icp-recalibration-approve', draftId, approver, tenantId },
        [{ type: 'CRM_ACCOUNT', id: null }],
        { actor_id: approver, tenantId });
      const decisionId = res?.decision?.decision_id || null;
      const v = await this.readConfigRow(tenantId);
      const box = v[ICP_DRAFT_KEY] || { items: [] };
      const items = Array.isArray(box.items) ? box.items : [];
      const hit = items.find((d) => d.id === draftId);
      if (!hit) throw new Error(`setValidated: 草稿不存在 ${draftId}`);
      const next = { ...v };
      for (const d of items) if (d.id === draftId) { d.status = 'approved'; d.validated = true; d.approved_by = approver; }
      next[ICP_DRAFT_KEY] = { items };
      if (validated && hit.icp) next.icp = { ...(v.icp || {}), ...hit.icp };   // ← 唯一致效写
      await write('discovery-rules', next, { tenantId, decisionId, updatedBy: approver });
      return { draftId, decisionId, validated: !!validated };
    },
  };
}
```

**3c. `src/scheduler/timers.js`（接线：`runRetroOnce` 增第 ④ 段）**

在既有 ③ 参数体检之后、④ 报告生成之前插入（保持「每段独立 catch 互不传染」范式）：

```js
  // ③.5 ICP 自进化（P0#3；确定性；只出草稿，HITL 前绝不生效）
  const icp = await runIcp({ tenantId: 'system', store: icpStore || createIcpStore() }).catch((err) => {
    emit('trace', 'icp-evolution-failed', { error: String(err?.message || err) });
    recordFailure('icp-evolution-failed', err);
    return null;
  });
```

并在函数头 `const runParam = paramFn || runParamInspectionPass;` 之后加两行：
`const runIcp = icpFn || runIcpEvolutionPass;` 与 `const icpStore = icpStoreFn ? icpStoreFn() : createIcpStore();`（**store 可注入**，单测零 PG）；
签名扩为 `{ retroFn, routingFn, paramFn, icpFn, icpStoreFn, saveReportFn } = {}`，返回体加 `icp`。
import 增：`import { runIcpEvolutionPass } from '../evolution/icpSelfEvolution.js';` + `import { createIcpStore } from '../evolution/icpStore.js';`

**默认不产草稿**（`runIcpEvolutionPass` 无 `draft` 时 `skipped:'no_draft_proposed'`，**每次都会真调 `gate`？不——`skipped` 分支在 `gate` 之前 return，夜批不落决策行**）→ 夜批零行为变化；候选由后台配置页（T17）/ CLI 显式注入 `draft` 才产草稿。
**说明（范围裁决，显式记录）**：改 `timers.js` 超出原稿「2 文件」范围，但**不改即死代码**（§0.5「复核让改动生效的那条接线」）。本 Task 只增一个可注入 pass 段，不动既有 ① ② ③ 段与 `saveNightlyReport` 契约。

- [ ] **Step 4: Run** → PASS

- [ ] **Step 5: Commit**

```powershell
git add src/evolution/icpSelfEvolution.js src/evolution/icpStore.js src/scheduler/timers.js test/evolution/icpSelfEvolution.test.js
git commit -m "feat(discovery): P0#3 ICP self-evolution draft->backtest->HITL (no-HITL-never-active)"
```

---

## Task 12: feedback-loop 指标模板 + evaluator + Token 对账（P0 #4）

> **依赖**：Task 9（记忆捕获 + emit 源）已落地。
> **权威来源**：设计文档 §9.11（7 要素指标模板 + 三档阈值 + Token-业务对账）；方法论 `ai-feedback-loop` SKILL.md:143（七要素定义）。
> **定位**：本 Task 是**纯库模块**（常量 + 纯函数 + 注入式落库）。消费方 = **Task 16**（monitorAccount 重评分喂指标）、Task 17（后台配置页只读展示）——已在 Task 16 节补接线要求，避免「无消费方 = 死码」。

**Files:**
- Create: `src/feedback/discoveryMetrics.js`
- Test: `test/feedback/discoveryMetrics.test.js`

- [ ] **Step 1: 派发前已裁定的 6 条硬契约（禁照抄原稿）**

| # | 原稿（错） | 实为（已源码级核实） |
|---|---|---|
| 1 | `ledgerCost()` 写 `discovery_cost_ledger` 表 | **虚构表名**（`grep` 全仓 src/db/scripts **零命中**）。真实设施 = `src/alerts/tokenAccounting.js`：`recordTokens()`（append-only 明细 → `crm.token_accounting`，含 `tenant_id`/`decision_id`，**无 `account_id` 列**）+ `reconcileTokenToBusiness()`（烧 token vs 业务产出二元组）。**零新表、零 schema 改动** |
| 2 | `evaluate()` 返回 `'green'/'yellow'/'red'` **字符串** | test-plan 权威要求返回 **`{score, verdict}`**；`verdict` 取 `'green'\|'yellow'\|'red'`（设计文档 §9.11「三档（绿/黄/红）」），`score` 为 0..1 达成度 |
| 3 | 仅 2 个指标模板 | **3 个**（设计文档 §9.11 权威）：`discovered_to_won_rate` / `enrichment_coverage` / **`monitorAccount_refresh_rate`**（C3 增，冻结 `target≥0.9`） |
| 4 | 七要素 = 7 个键名 | 对（`direction/formula/target/alert/owner_agent/evaluator_skill/adjust_actions`，`ai-feedback-loop` SKILL.md:143 权威）。但**值形状取扁平数字**（`target: 0.15` / `alert: 0.08`，设计文档口径），非 SKILL 范本的 `{value,window}` 对象 |
| 5 | `ledgerCost(accountId, provider, cost)` 仅注释占位 | 真实落库走既有 `recordTokens`（**注入式 DI**：`recorder` 替身 → 单测零 PG）；返回**对账记录对象**含 `account_id`（`token_accounting` 无该列，故 account 维度由记录对象承载 + `decision_id` 关联实体决策行） |
| 6 | 无消费方 | `grep` 证实 T13/T16/T17 均未 import → **死码风险**（本会话第 4 次同源陷阱）。已在 Task 16 节补接线要求（consume `monitorAccount_refresh_rate` + `evaluate`） |

- [ ] **Step 2: Write the failing test** — `test/feedback/discoveryMetrics.test.js`（**零 PG**，全部替身）

7 组断言：

```js
import { describe, it, expect, vi } from 'vitest';
import {
  METRIC_TEMPLATES, METRIC_KEYS, SEVEN_KEYS, RECONCILE_FACILITY,
  evaluate, verdictOf, actionsFor, ledgerCost,
} from '../../src/feedback/discoveryMetrics.js';
```

① **七要素齐 + 恰 3 指标**：`METRIC_KEYS` 恰 `['discovered_to_won_rate','enrichment_coverage','monitorAccount_refresh_rate']`；`SEVEN_KEYS.length === 7` 且逐字等于 `['direction','formula','target','alert','owner_agent','evaluator_skill','adjust_actions']`；对每个模板断言 `SEVEN_KEYS.every(k => k in t)`、`direction ∈ {'up','down'}`、`formula` 非空字符串、`target`/`alert` 为数字、`owner_agent`/`evaluator_skill` 非空字符串、`adjust_actions` 非空数组。
  - 冻结值：`METRIC_TEMPLATES.monitorAccount_refresh_rate.target === 0.9`（设计文档 §9.11）；`discovered_to_won_rate.target === 0.15 && alert === 0.08`。
  - `owner_agent === 'decision-retro'`（`agentSpec.js:57` 真实存在）、`evaluator_skill === 'method-decision-enrich'`（`skills/seed.js:112` 真实存在）——防虚构 id。

② **Token–业务因果对账字段存在**：
```js
const recorder = vi.fn().mockResolvedValue({ ok: true });
const rec = await ledgerCost({ accountId: 'ACC-1', provider: 'gaode', cost: 0.01, tokensIn: 120, tokensOut: 30, tenantId: 't12', decisionId: 'DEC-1', recorder });
expect(rec).toMatchObject({ account_id: 'ACC-1', provider: 'gaode', cost: 0.01, decision_id: 'DEC-1', tenant_id: 't12' });
expect(rec.tokens).toEqual({ in: 120, out: 30 });
expect(rec.ts).toBeTruthy();
expect(recorder).toHaveBeenCalledTimes(1);
const arg = recorder.mock.calls[0][0];
expect(arg).toMatchObject({ source: 'discovery-provider', action: 'discovery:gaode', module: 'discovery', tenantId: 't12', decision_id: 'DEC-1' });
```

③ **evaluator 返回 `{score, verdict}` 三档 + 边界 + fail-closed**（纯函数直测）：
  - `evaluate('discovered_to_won_rate', 0.20)` → `verdict === 'green'`，`score` 为 0..1 数字且 `> 0`
  - `evaluate('discovered_to_won_rate', 0.10)` → `'yellow'`；`evaluate('discovered_to_won_rate', 0.02)` → `'red'`
  - **边界闭区间**：`value === target` → `'green'`；`value === alert` → `'yellow'`
  - **单调性**：`evaluate(m, 0.20).score >= evaluate(m, 0.10).score`
  - **未知指标 → throw**（fail-closed，非静默返默认档）：`expect(() => evaluate('nope', 1)).toThrow()`

④ **`down` 方向语义**（防方向写死）：`verdictOf({direction:'down',target:0.03,alert:0.05}, 0.01) === 'green'`；`(…, 0.06) === 'red'`；`up` 反之（`verdictOf({direction:'up',target:0.9,alert:0.7}, 0.95) === 'green'`）。

⑤ **红档动作 = 回滚/重校准而非仅熔断**（设计文档 §9.11 硬要求）：`actionsFor('discovered_to_won_rate','red').length > 0` 且其中至少一项匹配 `/rollback|recalibrat/i`；`actionsFor(m,'green')` 为 `[]`；未知指标 throw。

⑥ **零 PG + 禁 DELETE + 复用证据**（`fs` 读源码断言）：不匹配 `/DELETE\s+FROM|\.delete\s*\(/i`；`^import` 行**不含 `pg` / `db.js`**（纯函数模块，落库靠注入）；**含 `from '../alerts/tokenAccounting.js'`**（真实设施复用，防再自造表）。

⑦ **`RECONCILE_FACILITY === 'token_accounting+reconcileTokenToBusiness'`**（文档锚点常量，防未来有人再自造 `discovery_cost_ledger`）。

- [ ] **Step 3: Run** → FAIL（`Cannot find module '…/src/feedback/discoveryMetrics.js'`）

- [ ] **Step 4: Implement** `src/feedback/discoveryMetrics.js`

```js
// src/feedback/discoveryMetrics.js — feedback-loop（P0#4）指标模板 + evaluator + Token 对账
// 权威来源：docs/2026-09-10-lead-discovery-design.md §9.11；方法论：ai-feedback-loop SKILL（七要素 + 三档阈值）
// 纪律：纯函数 + 常量（零 DB import）；落库经注入式 recorder（缺省复用既有 tokenAccounting，禁自造表）
import { recordTokens } from '../alerts/tokenAccounting.js';

// 七要素（ai-feedback-loop SKILL.md:143 权威定义，禁增删改名）
export const SEVEN_KEYS = Object.freeze(['direction','formula','target','alert','owner_agent','evaluator_skill','adjust_actions']);

export const METRIC_TEMPLATES = Object.freeze({
  discovered_to_won_rate: Object.freeze({
    direction: 'up',
    formula: 'COUNT(DEAL lead→closed-won)/COUNT(DEAL lead)',
    target: 0.15, alert: 0.08,
    owner_agent: 'decision-retro',
    evaluator_skill: 'method-decision-enrich',
    adjust_actions: Object.freeze(['recalibrate lead-fit scenario', 'rollback icp_draft']),
  }),
  enrichment_coverage: Object.freeze({
    direction: 'up',
    formula: '已补字段/应补字段',
    target: 0.8, alert: 0.5,
    owner_agent: 'decision-retro',
    evaluator_skill: 'method-decision-enrich',
    adjust_actions: Object.freeze(['add adapter', 'enable provider']),
  }),
  // 【C3 接入 · 设计文档 §9.11 冻结 target=0.9】持续监控闭环活跃度
  monitorAccount_refresh_rate: Object.freeze({
    direction: 'up',
    formula: '已监控账户重评分次数/应监控账户数',
    target: 0.9, alert: 0.7,
    owner_agent: 'decision-retro',
    evaluator_skill: 'method-decision-enrich',
    adjust_actions: Object.freeze(['reschedule monitor pass', 'backfill account_memory']),
  }),
});
export const METRIC_KEYS = Object.freeze(Object.keys(METRIC_TEMPLATES));
// 文档锚点：Token-业务对账的真实设施（防再自造 discovery_cost_ledger 表）
export const RECONCILE_FACILITY = 'token_accounting+reconcileTokenToBusiness';

const clamp01 = (n) => Math.max(0, Math.min(1, Number(n) || 0));

// 三档判定（纯函数；闭区间下界：value===target → green，value===alert → yellow）
export function verdictOf(template, value) {
  const v = Number(value) || 0, t = Number(template.target) || 0, a = Number(template.alert) || 0;
  if (template.direction === 'down') {            // down：越小越好
    if (v <= t) return 'green';
    if (v <= a) return 'yellow';
    return 'red';
  }
  if (v >= t) return 'green';                     // up：越大越好
  if (v >= a) return 'yellow';
  return 'red';
}

// evaluator（纯函数）：返回 { score, verdict }（test-plan 权威形状；未知指标 fail-closed）
export function evaluate(metric, value) {
  const t = METRIC_TEMPLATES[metric];
  if (!t) throw new Error(`unknown metric: ${metric}`);
  const v = Number(value) || 0;
  const score = t.direction === 'down'
    ? clamp01(v > 0 ? t.target / v : 1)
    : clamp01(t.target > 0 ? v / t.target : 0);
  return { score, verdict: verdictOf(t, v) };
}

// 红档动作（回滚草稿而非仅熔断 —— 设计文档 §9.11 硬要求）
export function actionsFor(metric, verdict) {
  const t = METRIC_TEMPLATES[metric];
  if (!t) throw new Error(`unknown metric: ${metric}`);
  return verdict === 'red' ? [...t.adjust_actions] : [];
}

// Token-业务因果对账（复用既有 token_accounting；account 维度由返回记录承载 + decision_id 关联）
export async function ledgerCost({
  accountId = null, provider = 'unknown', cost = 0, tokensIn = 0, tokensOut = 0,
  tenantId = 'system', decisionId = null, recorder = null, ts = null,
} = {}) {
  const record = recorder || recordTokens;
  await record({
    actor: 'discovery',
    action: `discovery:${provider}`,
    tokensIn, tokensOut,
    source: 'discovery-provider',
    decision_id: decisionId,
    tenantId,
    module: 'discovery',
  });
  return {
    account_id: accountId,
    provider,
    cost,
    tokens: { in: Number(tokensIn) || 0, out: Number(tokensOut) || 0 },
    decision_id: decisionId,
    tenant_id: tenantId,
    ts: ts || new Date().toISOString(),
  };
}
```

- [ ] **Step 5: Run** → PASS

- [ ] **Step 6: 自检**

```powershell
grep -n "DELETE FROM\|\.delete(\|discovery_cost_ledger" src/feedback/discoveryMetrics.js   # 期望 0 命中（含虚构表名）
git status --porcelain   # 恰 2 文件（改动计划文档需说明）
node -e "const fs=require('fs'),c=require('crypto');for(const f of ['src/context/routing.js','src/context/assembler.js'])console.log(f,c.createHash('sha256').update(fs.readFileSync(f)).digest('hex'))"   # 红线冻结值不变
```

- [ ] **Step 7: 回归**

```powershell
npx vitest run test/feedback/ test/alerts/ test/billing/ test/config/
```

（含既有 `test/token-accounting.test.js` / `test/billing/tokenTenant.test.js` —— 本 Task 复用 `recordTokens`，须零回归。若疑似 flaky（共享库 TRUNCATE 干扰），**复跑相同组合命令**确认，不要直接改代码。）

- [ ] **Step 8: Commit**

```powershell
git add src/feedback/discoveryMetrics.js test/feedback/discoveryMetrics.test.js
git commit -m "feat(discovery): P0#4 feedback metric templates (7-element x3) + evaluator + token ledger via existing token_accounting"
```

---

## Task 13: 前台门户页面（线索发现工作台）

> **路径校正**：门户页面真实目录是 `src/web/`（91 页），**不是 `public/`**；serve 走 `src/http/routes.js` 的 `app.get('/xxx.html', sendFile(...))` 范式（见 `:218-219`）。UI 胶囊归 Task 20（buddy 应用面），本 Task 只做前台页面本体。

**Files:**
- Create: `src/web/discovery.html`（线索发现工作台）
- Create: `src/http/discoveryRoutes.js`（只读候选池端点，租户隔离）
- Modify: `src/http/routes.js`（挂 `createDiscoveryRouter()` + serve `/discovery.html`）
- Test: `test/web/discoveryPage.test.js` + `test/http/discoveryRoutes.test.js`（test-plan §9.7 两个测试文件）

- [ ] **Step 1: Write the failing test**

```js
// test/web/discoveryPage.test.js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const html = readFileSync(new URL('../../src/web/discovery.html', import.meta.url), 'utf8');
describe('discovery.html 前台页', () => {
  it('含三区与只读端点，且无 DELETE 入口（禁 DELETE 铁律）', () => {
    expect(html).toContain('线索发现');
    expect(html).toContain('/api/discovery/candidates');
    expect(html).toContain('why_narrative');            // C2 glass-box 展示位
    expect(html).toContain('icp_fit_score');
    expect(/\bdelete\b|\bDELETE\b/.test(html)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test** → `npx vitest run test/web/discoveryPage.test.js` → FAIL（文件不存在）

- [ ] **Step 3: Create `src/web/discovery.html`** — 三区（复用门户既有 `assets/` 样式令牌，light 主题）
  1. **触发条**：显示当前租户 dataset（ICP 摘要 + 启用的数据源徽标 + 上次运行时间）；「运行发现」按钮经 **MCP 胶囊注入 prompt**（`discovery-run`）触发，**不裸调写端点**（写走两阶段 + 第 0 闸）。
  2. **候选线索池表**：列 = 公司 / ICP 适配分（`icp_fit_score`）/ 信号 chips（funding_round·hiring_icp_role·tech_adopt…）/ `why_narrative` 摘要 / 来源徽标（本体自动补全 vs 外部 adapter）；只读。
  3. **详情抽屉（C2 glass-box）**：`rule_ref` + `j_score` + `trace` 时间线 + 编排轨迹（命中的 playbook 四段：data→condition→ai→action）+ 账户持久记忆追加记录（C3）。
  界面只读；评分重校准、外联发送一律走 HITL，不在本页直接写。

```html
<!-- src/web/discovery.html — 线索发现工作台（前台只读面）
     三区：triggerBar（触发条）/ candidatePool（候选线索池表）/ glassBoxDrawer（C2 详情抽屉）
     只读：评分重校准、外联发送一律走 MCP 胶囊入口（discovery-run HITL + 第0闸），本页不裸调写端点
     样式：/portal/tokens.css + /portal/common.css + /portal/page.css（受控渲染页既有令牌） -->
<div id="app">
  <header class="page-head">
    <div class="ph-main"><h1 class="page-title">线索发现工作台</h1></div>
  </header>
  <!-- ① 触发条 triggerBar：当前租户 dataset（ICP 摘要 + 数据源徽标 + 上次运行时间） -->
  <section id="triggerBar" class="pg-card">
    <div id="icp-summary"></div>
    <div id="data-source-badges"></div>
    <div id="last-run-at"></div>
    <button id="run-discovery-btn" type="button">运行发现</button>
  </section>
  <!-- ② 候选线索池表 candidatePool：只读 -->
  <section id="candidatePool" class="pg-card">
    <table id="candidate-table">
      <thead><tr>
        <th>公司</th><th>ICP 适配分</th><th>信号</th><th>why_narrative</th><th>来源</th>
      </tr></thead>
      <tbody id="candidate-tbody"></tbody>
    </table>
  </section>
  <!-- ③ 详情抽屉 glassBoxDrawer（C2）：rule_ref + j_score + trace 时间线 + 编排轨迹 -->
  <aside id="glassBoxDrawer" class="drawer" hidden>
    <div id="gbox-rule-ref"></div>
    <div id="gbox-j-score"></div>
    <div id="gbox-trace"></div>
    <div id="gbox-playbook"></div>
    <div id="gbox-account-memory"></div>
  </aside>
</div>
<script type="module">
  // 只读端点：GET /api/discovery/candidates（候选池）；detail 经 /api/particles/:id/schema（既有只读）
  // 触发：<buddy-capsule> 注入 prompt（discovery-run）→ 写经 MCP 两阶段 + 第0闸，本页不裸调
  const { fetchJson } = await import('/portal/api.js');
  const items = await fetchJson('/api/discovery/candidates');
  // ... 渲染 candidatePool（icp_fit_score / signals chips / why_narrative / sources）与 glassBoxDrawer
</script>
```

- [ ] **Step 4: Create `src/http/discoveryRoutes.js`**（只读端点，无写、无 DELETE）

```js
// src/http/discoveryRoutes.js — 线索发现只读面（候选池；租户隔离，零写零删）
// 契约（已源码级核实）：
//   · 身份解析：import { resolveMe } from './auth.js'（同步函数，返回 {ok, role, tenantId}）
//     —— 注意：req.resolveMe 全仓无挂载（非 Express 中间件），计划旧写法三态分支生产恒 403
//   · 租户隔离：scopeTenant(me)（sysadmin '*' 回退 system）；applyTenantOverride(req, me) 处理通配
//   · icp_fit_score 是嵌套对象 {value, judge}（discoverySchema.js:35），读 .value；0 也是有效候选
//   · sources 不在 discovery payload 内（buildDiscoveryPayload 无此字段）→ 从 enrichment 六元汇总
//   · 只读端点：GET /api/discovery/candidates；无 POST / PUT / DELETE（禁 DELETE + 零写铁律）
import { Router } from 'express';
import { resolveMe as realResolveMe } from './auth.js';
import { scopeTenant, applyTenantOverride } from './tenantScope.js';
import { queryParticles } from '../particles/particleRepo.js'; // 真实导出（particleRepo.js:176）

// 候选池组装（只读投影；无写路径）
async function defaultList(me, q) {
  const tenantId = applyTenantOverride(q, me); // 兼容既有 /api/particles 的通配语义（routes.js:521）
  const rows = await queryParticles({ type: 'CRM_ACCOUNT', tenantId, limit: Number(q.limit) || 50 });
  return rows.map((r) => {
    const p = r.payload || {};
    const disc = p.discovery || {};
    const enrich = p.enrichment || {};
    // 来源徽标（C1 消费面）：enrichment 六元 source/provider 去重汇总；无富集 → []
    const sources = [...new Set(Object.values(enrich).map((v) => v?.source).filter(Boolean))];
    const providers = [...new Set(Object.values(enrich).map((v) => v?.provider).filter(Boolean))];
    return {
      account_id: r.id,
      name: disc?.name || p.name || r.name || r.slug || '',
      icp_fit_score: disc?.icp_fit_score?.value ?? null, // 嵌套对象取 .value；0 仍候选
      intent_score: disc?.intent_score?.value ?? null,
      signals: Array.isArray(disc?.signals) ? disc.signals : [],
      why_narrative: disc?.why_narrative || '',
      sources, providers, // 本体自动补全 vs 外部 adapter 徽标
      rule_ref: disc?.icp_fit_score?.judge?.rule_ref || '', // C2 glass-box 展示位
      j_score: disc?.icp_fit_score?.judge?.j_score ?? null,
    };
  }).filter((x) => x.icp_fit_score != null); // 仅已评分候选（数值 0 保留）
}

export function createDiscoveryRouter({ resolveMe = realResolveMe, scopeTenant: _st, list = defaultList } = {}) {
  const router = Router();
  const handlers = {
    candidates: async (req, res) => {
      try {
        // 真实范式：resolveMe(req) 同步返回（既有 billingRoutes 一致）；测试注入替身
        const me = typeof resolveMe === 'function' ? resolveMe(req) : { ok: false };
        if (!me?.ok) return res.status(403).json({ error: 'auth required' });
        res.json({ items: await list(me, req.query || {}) });
      } catch (e) { res.status(500).json({ error: e.message }); }
    },
  };
  router.get('/api/discovery/candidates', handlers.candidates);
  // 只读面：零 POST / PUT / DELETE（grep 断言依据：本文件仅一处 router.get）
  router.handlers = handlers; // 注入式测试契约（同 configRouter 范式）
  return router;
}
``````

- [ ] **Step 5: Mount in `src/http/routes.js`**（两处：Router 挂载区 + 页面 serve 区）

```js
// 顶部 import 区（与既有 routes.js import 并列）
import { createDiscoveryRouter } from './discoveryRoutes.js';
// Router 挂载区（与既有 Router 挂载 196-215 并列）：只读候选池端点
app.use(createDiscoveryRouter());
// 页面 serve 区（与 320-345 既有页面 serve 并列）：
// 注意：241-242 行的 /discovery-rules.html 是 Task 17 的【后台配置页】，与本页 discovery.html 是两页，勿混
app.get('/discovery.html', (req, res) =>
  res.sendFile(fileURLToPath(new URL('../web/discovery.html', import.meta.url))));
```

- [ ] **Step 6: Run test** → PASS

- [ ] **Step 7: Commit**

```powershell
git add src/web/discovery.html src/http/discoveryRoutes.js src/http/routes.js test/web/discoveryPage.test.js
git commit -m "feat(discovery): frontend workbench page + read-only candidates endpoint"
```

---

## Task 14: 可组合编排引擎（C1 · discovery-rules.playbooks）

> **依赖**：Task 1（config）、Task 2（适配器/瀑布）、Task 7（orchestrator）已落地。
> **目的**：把「数据适配器→判定条件→AI 研究→触达动作」四段原语做成**可组合、按租户配置驱动、无固定流程**的编排层（吸收 Clay #1 最深护城河）；零核心代码改动即可新增客群/编排。
>
> **⚠ 派发前源码级复查消解（2026-09-11，已核实源码，务必按本节实现）**
>
> | # | 级别 | 初稿缺陷（源码级证据） | 消解 |
> |---|---|---|---|
> | 1 | 🔴 | 初稿 Step 4 要往 `DEFAULT_DISCOVERY_RULES` 预置 3 条 playbook（high-funding/lite-redesign/default）+ 改合并语义；但 **Task 1 已落地** `src/config/discoveryRules.js:41-42` = `playbooks: []` + 注释「**出厂不预置 —— Task 14 定义段 schema，Task 21 按行业播种**」，`:58` 已有 `out.playbooks = structuredClone(tenantCfg.playbooks)` | **Step 4 整段作废**：`src/config/discoveryRules.js` **零改动**（出厂播种 = Task 21 职责；本节只定义 compiler 的段 schema） |
> | 2 | 🔴 | 初稿 Step 5 要「给 `resolveAdapters` 加可选 `allowIds` 参数（`if (allowIds && !allowIds.includes(p.id)) continue;`）」；但 **Task 7 已落地** `providerRegistry.js:17` = `resolveAdapters(rules, { allowIds, registry })`，且 `discoveryOrchestrator.js:51` 已在用 `{ allowIds: input.allowIds }` | **重复劳动删除**：只补 playbook→allowIds 的接线，复用既有 `{allowIds}` 签名；`providerRegistry.js` **零改动** |
> | 3 | 🔴 | 初稿 `selectPlaybook` fallback **硬编码** `{name:'default', data:['web-research'], ai:[], action:[]}`：出厂 `playbooks=[]` 时恒返回它 → `allowIds=['web-research']` → **静默停用 tender/gaode/email-verify**（收窄 Task 7 既有链路 + 断言假绿） | `selectPlaybook` **无 match 命中且无 `default` 项 ⇒ 返回 `null`**（语义：「无编排配置 = 不过滤 = 全量启用源」）；orchestrator **仅在拿到 pb 时**收窄，否则保持 `input.allowIds` 原语义 |
> | 4 | 🟠 | 初稿测试缺 test-plan T14 要求的「**未知名/缺段抛错**」与「**全配置驱动（无硬编码段）**」两组断言（test-plan:127 ③④） | 补 2 组测试：非法入参（null / 无 name）抛错；计划段的 stage 全部源自入参（缺段不产出，非硬编码） |
> | 5 | 🟠 | 初稿 Step 7 commit 清单含 `src/connectors/discovery/providerRegistry.js`，按 #2 该文件零改动 | 剔除 |

**Files:**
- Modify: `src/agent/discoveryOrchestrator.js`（消费编译后的 plan，推导 `allowIds`）
- Create: `src/connectors/discovery/orchestrationCompiler.js`
- Test: `test/connectors/discovery/orchestrationCompiler.test.js`（1 个测试文件，与 test-plan T14 一致）
- **零改动（红线）**：`src/config/discoveryRules.js`、`src/connectors/discovery/providerRegistry.js`、`src/context/routing.js`、`src/context/assembler.js`

- [ ] **Step 1: Write the failing test**

```js
// test/connectors/discovery/orchestrationCompiler.test.js
import { describe, it, expect } from 'vitest';
import { compilePlaybook, selectPlaybook } from '../../../src/connectors/discovery/orchestrationCompiler.js';

const RULES = {
  playbooks: [
    { name: 'high-funding', match: 'funding_round && hiring_icp_role',
      data: ['tender', 'gaode'], ai: ['claygentResearch:deep'], action: ['method-followup-engine'] },
    { name: 'lite-redesign', match: 'website_redesign',
      data: ['web-research'], ai: ['claygentResearch:lite'], action: ['method-followup-engine'] },
    { name: 'default', match: '', data: ['web-research'], ai: [], action: [] },
  ],
};

describe('orchestration compiler (C1)', () => {
  it('① selects playbook by signal match (all terms of && must hit)', () => {
    const pb = selectPlaybook(RULES, [{ type: 'funding_round' }, { type: 'hiring_icp_role' }]);
    expect(pb.name).toBe('high-funding');
  });
  it('①b partial match does NOT hit (&& is conjunctive)', () => {
    const pb = selectPlaybook(RULES, [{ type: 'funding_round' }]); // 缺 hiring_icp_role → 落 default
    expect(pb.name).toBe('default');
  });
  it('② compiles playbook into executable 4-primitive plan (ordered)', () => {
    const plan = compilePlaybook(RULES.playbooks[0]);
    expect(plan.steps.map((st) => st.stage)).toEqual(['data', 'condition', 'ai', 'action']);
    expect(plan.steps[0].adapters).toContain('gaode');
    expect(plan.steps[3].skills).toContain('method-followup-engine');
  });
  it('③ falls back to declared default playbook when no match', () => {
    const pb = selectPlaybook(RULES, [{ type: 'unknown_signal' }]);
    expect(pb.name).toBe('default');
  });
  it('③b returns null when no match AND no default entry (factory playbooks=[])', () => {
    expect(selectPlaybook({ playbooks: [] }, [{ type: 'x' }])).toBeNull();
    expect(selectPlaybook({}, [{ type: 'x' }])).toBeNull();
    expect(selectPlaybook({ playbooks: [{ name: 'a', match: 'zzz', data: ['tender'] }] }, [])).toBeNull();
  });
  it('④ throws on malformed playbook (null / missing name)', () => {
    expect(() => compilePlaybook(null)).toThrow();
    expect(() => compilePlaybook(undefined)).toThrow();
    expect(() => compilePlaybook({})).toThrow();
    expect(() => compilePlaybook({ data: ['tender'] })).toThrow(); // 无名编排禁止静默进主干
  });
  it('④b plan stages come 100% from input (no hardcoded stage when段缺)', () => {
    const plan = compilePlaybook({ name: 'action-only', action: ['method-followup-engine'] });
    expect(plan.steps.map((s) => s.stage)).toEqual(['action']);
    expect(plan.steps.some((s) => s.adapters)).toBe(false);
    expect(plan.name).toBe('action-only');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/connectors/discovery/orchestrationCompiler.test.js`
Expected: FAIL — `Failed to resolve import .../orchestrationCompiler.js`（模块不存在）

- [ ] **Step 3: Implement `src/connectors/discovery/orchestrationCompiler.js`**

```js
// src/connectors/discovery/orchestrationCompiler.js
// C1: 可组合 GTM 编排层（吸收 Clay #1 最深护城河）。
// 把 discovery-rules.playbooks 编译为可执行的四段原语计划：
//   data(适配器) -> condition(判定条件) -> ai(AI 研究) -> action(触达动作)。
// 铁律：
//   ① 零核心代码改动：新增客群/编排只改 config（配置驱动差异化铁律）
//   ② 段缺失 ⇒ 该段不产出（可组合 = 任一段可选），不抛错
//   ③ 非法入参（无 name）⇒ 抛错（fail-fast，禁匿名编排静默进主干）
//   ④ 无 match 命中且无 default 项 ⇒ selectPlaybook 返回 null
//      （= 不过滤 ⇒ 全量启用源，保持 Task 7 既有语义，绝不静默收窄适配器集）
export function compilePlaybook(pb) {
  if (!pb || typeof pb !== 'object' || !pb.name) {
    throw new Error('compilePlaybook: playbook 必须是有 name 的对象');
  }
  const steps = [];
  if (pb.data?.length) steps.push({ stage: 'data', adapters: [...pb.data] });
  if (pb.match) steps.push({ stage: 'condition', match: pb.match });
  if (pb.ai?.length) steps.push({ stage: 'ai', research: [...pb.ai] });
  if (pb.action?.length) steps.push({ stage: 'action', skills: [...pb.action] });
  return { name: pb.name, steps };
}

// 按先验信号选择 playbook：显式 match（&& 全命中）> 显式 default > null
export function selectPlaybook(rules, signals = []) {
  const list = Array.isArray(rules?.playbooks) ? rules.playbooks : [];
  const types = new Set((signals || []).map((sg) => sg?.type).filter(Boolean));
  const matches = (m) => (m || '').split('&&').map((x) => x.trim()).filter(Boolean).every((t) => types.has(t));
  const hit = list.find((pb) => pb?.match && matches(pb.match));
  if (hit) return hit;
  return list.find((pb) => pb?.name === 'default') || null;
}
```

- [ ] **Step 4: ~~Add `playbooks` default to `src/config/discoveryRules.js`~~ —— **已作废（见消解 #1）**

不改 `src/config/discoveryRules.js`：出厂 `playbooks: []`（`:42`）+ playbooks 合并（`:58`）均为 **Task 1 已落地**，行业播种由 **Task 21** 负责（`db/seed/tenant-profile-*.js` 的 `discovery.playbooks`）。

- [ ] **Step 5: Wire plan into `src/agent/discoveryOrchestrator.js`**

顶部 import 区（`:15` 附近）追加：

```js
import { selectPlaybook, compilePlaybook } from '../connectors/discovery/orchestrationCompiler.js';
```

替换 `:50-51` 两行（原注释 + `const adapters = ...`）为：

```js
  // ③ 数据源：playbook 推导 allowIds（配置驱动）；enabled 过滤 + costTier 升序；deps.adapters 可注入（单测零 IO）
  //    playbook 未配置（selectPlaybook → null）⇒ 退回 input.allowIds 原语义（不过滤 = 全量启用源）
  const playbook = selectPlaybook(rules, input.signals || []);
  const dataStep = playbook ? compilePlaybook(playbook).steps.find((st) => st.stage === 'data') : null;
  const allowIds = dataStep?.adapters?.length ? dataStep.adapters : input.allowIds;
  const adapters = deps.adapters || resolveAdapters(rules, { allowIds });
```

> **注意**：`resolveAdapters` 的 `{allowIds}` 与 `allowIds` 过滤逻辑（`providerRegistry.js:17-25`）**已存在**，本节不修改该文件。`allowIds === undefined` ⇒ 不过滤（全量启用源），与 `[]` ⇒ 全过滤 语义不同，故 `selectPlaybook → null` 时必须回退 `input.allowIds`（通常 undefined），**不可传 `[]`**。

- [ ] **Step 6: Run tests to verify pass**

Run: `npx vitest run test/connectors/discovery/orchestrationCompiler.test.js`
Expected: PASS（7 例）

再跑 orchestrator 回归（确认接线未破坏既有链路）：

Run: `npx vitest run test/agent/discoveryOrchestrator.test.js test/connectors/discovery/`
Expected: 全绿（既有测试均以 `deps.adapters` 注入 → 走第一分支，不经 `resolveAdapters`，不受本次收窄影响）

- [ ] **Step 7: Commit**

```powershell
git add src/connectors/discovery/orchestrationCompiler.js src/agent/discoveryOrchestrator.js test/connectors/discovery/orchestrationCompiler.test.js
git commit -m "feat(discovery): C1 composable GTM orchestration (playbooks -> 4-primitive plan)"
```

> ⛔ 不含 `src/config/discoveryRules.js` / `src/connectors/discovery/providerRegistry.js`（依消解 #1/#2 零改动）。
---

## Task 15: Claygent glass-box 可解释推理链（C2）

> **依赖**：Task 4（discoverySchema）、Task 8（claygent）已落地。
> **目的**：研究/评分输出 `why_narrative` 必带可解释推理链（每步 `rule_ref`+`j_score`+`trace`），与 P0#1 的 2D judge 同源；可解释升为一等公民（吸收 Clay glass-box 卖点）。
>
> **⚠ 派发前源码级复查消解（2026-09-11，已核实源码，务必按本节实现）**
>
> | # | 级别 | 初稿缺陷（源码级证据） | 消解 |
> |---|---|---|---|
> | 1 | 🔴 | **Step 5 改 `rule_ref` 取值会打红 2 条既有断言**：初稿把 claygent 的 glass-box ruleRef 写成 `'research#sig:web'`；但 `test/connectors/discovery/research.test.js:25,27` 断言 `out.why_narrative` / `out.glass_box.judge.rule_ref` **必须 `toContain('lead-fit')`**，而 `claygent.js:13` 的 `RULE_REF = 'scenario:lead-fit#ruler:hiring_icp_role'` 含之 | **保留 `RULE_REF` 常量原值**作 ruleRef（`claygent.js:13`）；本 Step 只做「**消除重复实现**」（删 `localGlassBox`、改调 `buildGlassBox`），**不改任何取值语义** |
> | 2 | 🔴 | **Step 4 骨架签名丢第 5 参 `{ruleRef}`**：初稿写 `buildDiscoveryPayload(fit, intent, signals, decisionId)`；但 Task 4 已落地 `discoverySchema.js:30-32` = `(fit, intent, signals, decisionId, { ruleRef = {} } = {})`，**支持按 scenario/ruler 覆盖** fit/intent 的 ruler 引用（配置驱动） | **保留 `{ruleRef = {}}` 签名**；只把内部 judge/why_narrative 生成改为经 `buildGlassBox` + **追加 `trace`** |
> | 3 | 🟠 | **`buildGlassBox` 不过滤脏信号 = 替换后行为退化**：初稿 `signals.map(...)` 直取；而 claygent 既有 `localGlassBox`（`:18`）用 `.filter(Boolean)`。若 signals 含 `null` / `{type:undefined}`，初稿版 `trace` 会含 `{signal:undefined}` 脏项 | `buildGlassBox` 内加 `.filter(Boolean)`（**与 `localGlassBox` 完全同构**），并补测试断言脏信号被过滤 |
> | 4 | 🟠 | **`ruleRef.intent` 默认值口径不一致**：`discoverySchema.js:32` 为 `'scenario:lead-fit#ruler:hiring'`；claygent `RULE_REF`（`:13`）为 `'...ruler:hiring_icp_role'`（与信号类型名 `hiring_icp_role` 对齐）。初稿写 `hiring_icp_role` 但未说明 | **采纳 `hiring_icp_role`**（有意修正，统一口径）；全仓除上述两处外无其它引用，零测试风险（既有断言只 `toContain('ruler:')`） |
> | 5 | 🟠 | **缺 test-plan T15 要求的「与 P0#1 2D judge 同源结构（字段集一致）」断言组** | 补第 ② 组测试：断言 `buildGlassBox().judge` 键集 **===** `buildDiscoveryPayload().icp_fit_score.judge` 键集 |
> | 6 | 🟠 | **Step 5 末句「`discovery-research` action 落 `payload.research` 时一并写入 `glass_box`」是多余动作**：`src/action/discoveryActions.js:108-112` 已把 `claygentResearch()` 返回值整体 `patch: { research }`，而该返回值**已含 `glass_box`**（claygent `:104`）⇒ 无需任何改动 | **`src/action/discoveryActions.js` 列为零改动**（Files 区改正） |
> | 7 | 🟠 | test-plan T15 入参措辞 `buildGlassBox(judge, narrative, trace)` 与实现的对象入参 `({score, ruleRef, signals, axis})` 不符 | 按**分层裁决**：结构层以 test-plan 的**返回结构** `{judge:{rule_ref,j_score}, why_narrative, trace[]}` 为准（✓ 满足）；入参形状以源码/既有 `localGlassBox` 同构为准，test-plan 补注 |

**Files:**
- Create: `src/agent/glassBox.js`（纯函数 `buildGlassBox`）
- Modify: `src/agent/discoverySchema.js`（`buildDiscoveryPayload` 内部复用 glassBox + 追加 `trace`，**保留 `{ruleRef}` 第 5 参**）
- Modify: `src/connectors/discovery/claygent.js`（删内联 `localGlassBox`，改调 `buildGlassBox`，**`RULE_REF` 不变**）
- Test: `test/agent/glassBox.test.js`
- **零改动（红线）**：`src/action/discoveryActions.js`、`src/config/discoveryRules.js`、`src/connectors/discovery/providerRegistry.js`、`src/context/routing.js`、`src/context/assembler.js`

- [ ] **Step 1: Write the failing test**

```js
// test/agent/glassBox.test.js
import { describe, it, expect } from 'vitest';
import { buildGlassBox } from '../../src/agent/glassBox.js';
import { buildDiscoveryPayload } from '../../src/agent/discoverySchema.js';

describe('glass-box (C2)', () => {
  it('① emits why_narrative with rule_ref + j_score per decision', () => {
    const gb = buildGlassBox({ score: 0.82, ruleRef: 'scenario:lead-fit#ruler:industry', signals: ['funding_round'] });
    expect(gb.why_narrative).toContain('industry');
    expect(gb.judge.rule_ref).toBe('scenario:lead-fit#ruler:industry');
    expect(gb.judge.j_score).toBe(0.82);
    expect(gb.trace.length).toBe(1);
    expect(gb.trace[0].rule_ref).toBe('scenario:lead-fit#ruler:industry');
  });
  it('①b handles empty signals without throwing', () => {
    const gb = buildGlassBox({ score: 0.3, ruleRef: 'scenario:lead-fit#ruler:geo', signals: [] });
    expect(gb.why_narrative).toContain('无信号');
    expect(gb.trace).toEqual([]);
  });
  it('② 结构与 P0#1 的 2D judge 同源（字段集一致）', () => {
    const gb = buildGlassBox({ score: 0.5, ruleRef: 'r', signals: [] });
    const d = buildDiscoveryPayload(0.5, 0.5, [], 'dec_x');
    expect(Object.keys(gb.judge).sort()).toEqual(Object.keys(d.icp_fit_score.judge).sort());
    expect(gb.judge.axis).toBe('capability');
    expect(Object.keys(gb).sort()).toEqual(['judge', 'trace', 'why_narrative']);
  });
  it('③ 脏信号被过滤：trace 项数 = 有效信号数（与 localGlassBox 同构）', () => {
    const gb = buildGlassBox({ score: 0.6, ruleRef: 'r', signals: [null, { type: 'funding_round' }, {}] });
    expect(gb.trace.map((t) => t.signal)).toEqual(['funding_round']);
  });
  it('④ ruleRef / axis 可覆盖（配置驱动，禁硬编码 ruler 名）', () => {
    const gb = buildGlassBox({ score: 0.4, ruleRef: 'x#ruler:y', signals: [], axis: 'coverage' });
    expect(gb.judge.axis).toBe('coverage');
    expect(gb.judge.rule_ref).toBe('x#ruler:y');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/agent/glassBox.test.js`
Expected: FAIL — `Failed to resolve import .../src/agent/glassBox.js`（模块不存在）

- [ ] **Step 3: Implement `src/agent/glassBox.js`**

```js
// src/agent/glassBox.js
// C2: glass-box 可解释推理链（吸收 Clay glass-box 范式，升为一等公民）。
// 每个评分/研究判定附 rule_ref（引用哪条 ruler/信号）+ j_score（能力轴置信），
// 与 P0#1 的 2D judge（axis=capability）同源；销售可见「为何此刻判定为目标客户」。
// 铁律：
//   ① 纯函数、零副作用、不触 DB、不新增粒子
//   ② 脏信号（null / 无 type）必须过滤 —— trace 项数 = 有效信号数（与 claygent 既有实现同构）
//   ③ 无信号不抛错：why_narrative 走「无信号」分支
//   ④ ruleRef / axis 均可覆盖（配置驱动，禁在签名外硬编码具体 ruler 名）
export function buildGlassBox({ score, ruleRef, signals = [], axis = 'capability' }) {
  const names = (Array.isArray(signals) ? signals : [])
    .map((sg) => (typeof sg === 'string' ? sg : sg && sg.type))
    .filter(Boolean);
  const trace = names.map((n) => ({ signal: n, rule_ref: ruleRef, j_score: score }));
  return {
    judge: { axis, rule_ref: ruleRef, j_score: score },
    trace,
    why_narrative: `因 ${names.join('、') || '无信号'} 命中 ${ruleRef} 判定为目标客户（j_score=${score}）`,
  };
}
```

- [ ] **Step 4: Reuse glass-box in `src/agent/discoverySchema.js`**

顶部加 `import { buildGlassBox } from './glassBox.js';`，并把 `buildDiscoveryPayload`（`:30-40`）**整体替换**为以下实现 —— **注意保留第 5 参 `{ ruleRef = {} }` 与 `ruleRef.fit/intent` 覆盖能力（消解 #2）**：

```js
// 发现评分 2D：value（来源轴）+ judge（能力轴 axis/rule_ref/j_score）+ trace（glass-box 推理链）。
// ruleRef 可覆盖（scenario/ruler 由 decision_scenario 侧配置驱动，C1）。
export function buildDiscoveryPayload(fit, intent, signals, decisionId, { ruleRef = {} } = {}) {
  const refFit = ruleRef.fit || 'scenario:lead-fit#ruler:industry';
  const refIntent = ruleRef.intent || 'scenario:lead-fit#ruler:hiring_icp_role'; // 与信号类型名 / claygent RULE_REF 对齐
  const list = Array.isArray(signals) ? signals : [];
  const fitGb = buildGlassBox({ score: fit, ruleRef: refFit, signals: list });
  const intentGb = buildGlassBox({ score: intent, ruleRef: refIntent, signals: list });
  return {
    icp_fit_score: { value: fit, judge: fitGb.judge, trace: fitGb.trace },
    intent_score: { value: intent, judge: intentGb.judge, trace: intentGb.trace },
    signals: list,
    why_narrative: `${fitGb.why_narrative}；decision_id=${decisionId}`,
  };
}
```

> **既有断言兼容性（已核实，零打红）**：`discoverySchema.test.js:29-31` 只断言 `why_narrative` 非空 + 含 `dec_1` + 含 `ruler:` ⇒ 新措辞 `因 funding_round 命中 scenario:lead-fit#ruler:industry …；decision_id=dec_1` 全过。`discoveryOrchestrator.test.js:34` 断言含 `decision_id=dec-1` ⇒ 过。**无任何 `toEqual` 严格键集断言**，故在 `icp_fit_score`/`intent_score` 追加 `trace` 键零风险；`discoveryRoutes.js:28` 只读 `?.value`，亦不受影响。

- [ ] **Step 5: Emit glass-box from `claygentResearch`（替换内联实现，不改取值）**

> ⚠ Task 8 已产出 `glass_box` + `why_narrative`（`claygent.js:17-24` 内联 `localGlassBox`，与本文同构）。本 Step 的动作是**替换为复用**（消除重复实现），**不是从零新增，也不得改动 `RULE_REF` 取值**（消解 #1）：

1) 顶部 import 区加：

```js
import { buildGlassBox } from '../../agent/glassBox.js';
```

2) **删除** `claygent.js:15-24` 的 `localGlassBox` 函数定义（含其上 2 行注释），保留 `:13` 的 `const RULE_REF = 'scenario:lead-fit#ruler:hiring_icp_role';` **原值不动**。

3) 把 `:98` 的调用由 `localGlassBox({...})` 改为：

```js
  const gb = buildGlassBox({ score, ruleRef: RULE_REF, signals: uniqSignals });
```

其余（`:104` `glass_box: gb`、`:102` `signals: uniqSignals`）**保持不变**。

> **`src/action/discoveryActions.js` 零改动**：其 `:108-112` 已把 `claygentResearch()` 的返回值整体写入 `patch: { research }`，而该返回值已含 `glass_box` ⇒ 「一并写入 glass_box」天然满足，**无需改该文件**（消解 #6）。

- [ ] **Step 6: Run tests to verify pass**

Run: `npx vitest run test/agent/glassBox.test.js test/agent/discoverySchema.test.js`
Expected: PASS

再跑 glass-box 影响面全量（必须全绿，零回退）：

Run: `npx vitest run test/agent/ test/connectors/discovery/`
Expected: 全绿（其中 `research.test.js` 的 `toContain('lead-fit')` 2 条依赖 `RULE_REF` 不变；`discoveryOrchestrator.test.js` 的 `decision_id=dec-1` 依赖新 why_narrative 措辞）

- [ ] **Step 7: Commit**

```powershell
git add src/agent/glassBox.js src/agent/discoverySchema.js src/connectors/discovery/claygent.js test/agent/glassBox.test.js
git commit -m "feat(discovery): C2 glass-box explainable reasoning chain (rule_ref+j_score+trace)"
```

> ⛔ 不含 `src/action/discoveryActions.js`（依消解 #6 零改动）。
---

## Task 16: monitorAccount 持续监控闭环（C3 · 升 P0）

> **依赖**：Task 6（lead-fit scenario）、Task 7（orchestrator）、Task 8（claygent）、Task 9（memory capture）、Task 12（discoveryMetrics）、Task 15（glassBox）已落地。
> **目的**：发现不是一次性动作，而是**常驻监控循环**——信号/定时触发 `lead-fit` 重评分 → 增量 append 到账户 append-only 持久记忆 → 30 天蒸馏 curated note → glass-box 可见优先级变化（吸收 Clay #3 Account Agent）。**禁 DELETE；跨外联绝不自动发信。**
> **消费 Task 12**：`monitorAccount` 返回值须带 `feedback`（`evaluate('monitorAccount_refresh_rate', rate)` 的 `{score, verdict}`），否则 `src/feedback/discoveryMetrics.js` 全仓零消费方 = 死码（`discoveryMetrics.js:27` 模板已冻结 `target=0.9`）。

> ### ⚠ 派发前源码级复查消解（2026-09-11，8 项 · 5 项 🔴）
>
> 本轮特征：**计划初稿与已落地的记忆层基础设施大面积冲突**（Task 9 已交付完整 memory_log/memory_note/distill 设施，初稿未同步）。
>
> | # | 级别 | 缺陷（源码级证据） | 消解 |
> |---|---|---|---|
> | 1 | 🔴 | **Step 5 矩阵行键名全错**：初稿 `{ event:'CRM_ACCOUNT', kind:'signal-detected', intent, agent }`；真实形状是 `{domain, type, entity_type, intent, agent, skill_slug, dedup_field}`（`eventTrigger.js:15-26`）。且 `matchTrigger`（`:68`）**硬编码 `x.domain === 'ontology'`** → 无 `domain` 的行恒不匹配；无 `skill_slug` → 白名单闸（`:71` `READ_ONLY_SKILLS.has(undefined)` = false）静默 `return null`。**双重死配置** | **Step 5 整段作废** → `src/agent/eventTrigger.js` 零改动 |
> | 2 | 🔴 | **即使改对键也恒不可达**：`matchTrigger` 用 `.find()` **首匹配胜出**，而 `(ontology, ontology-sync, CRM_ACCOUNT)` 三元组**已被 funnel-classification 行占用**（`:19`）→ 新增同三元组行恒被截胡。换 `type:'discovery-sync'` 则无 emitter（全仓 0 命中）；`discovery` 域唯一 emitter 是 `emit('discovery','lead-discovered')`（`orchestrator.js:109`）但 domain 不匹配硬编码闸门 | 矩阵行落地**明确延后**：前置条件 = ① discovery 域 emitter、② `matchTrigger` domain 闸门放宽（须先经 brainstorming 批准）。已同步 test-plan |
> | 3 | 🔴 | **Step 4 自造三契约均不存在**：`store.insertMemoryLog` / `store.listMemoryLog` / `store.upsertMemoryNote` 全仓零命中。真实契约 = `appendMemory({topic,kind,payload,...})`（`memoryLog.js`）/ `retrieveMemory({layer,topic,tenantId})`（同）/ `upsertNote({layer,topic,content,ttlDays})`（`note.js:4`）。且初稿字段 `particle_type`/`particle_id` **在 `crm.memory_log` 表不存在**（真实列 = `id,topic,kind,payload,weight,created_at,layer,actor,event_type,distilled,archived,ttl_days,entity_id,tenant_id,entity_type`） | Step 4 重写为**账户维度薄封装**，复用真实三契约 + `classifyForDistill`（`memoryLog.js` 纯函数） |
> | 4 | 🔴 | **Step 3 参数名错 + 整体替换 `payload.discovery`**：初稿 `ctx.updateParticle(id, { payload: {...} })`；真实签名是 `updateParticle(id, {state, patch, ...})`（`particleRepo.js:203`），且实现为 `{...cur.payload, ...patch}` **顶层浅合并**（`:212`）→ `patch:{discovery:{intent_score,why_narrative}}` 会**整体替换 `payload.discovery`，静默丢掉 `icp_fit_score` / `enrichment` / `judge`** | 读-改-写：`patch: { discovery: { ...(acct.payload?.discovery || {}), intent_score, why_narrative } }` |
> | 5 | 🔴 | **Step 6 改 capture.js 三重错误**：初稿引用 `evt.particleType` / `evt.particleId` / `store` —— `captureMemory(event)` 的 event 字段是 `{domain,type,payload,actor,...}`（`capture.js:64`），**前两者不存在**（恒 false 死分支），`store` 在作用域内**不存在**。更致命：`discoveryCapture.test.js:25-27` 用 `vi.mock` **整模块替换** `memoryLog.js` 且 `:88` 断言 `appendMemory` **toHaveBeenCalledTimes(1)** → 新增落点必打红既有 Task 9 测试 | **Step 6 整段作废** → `src/memory/capture.js` 零改动（账户记忆由 Step 3 的 `ctx.appendMemory` 承担，职责单一） |
> | 6 | 🟠 | 计划测试断言 `note.summary` —— 真实 `upsertNote` 返回 `r.rows[0]` = `crm.memory_note` 行，键为 **`content`**（`note.js:11`） | 测试改断言 `note.content` |
> | 7 | 🟠 | 计划要求「喂 Task 12 否则死码」，但 Step 未实现 | `monitorAccount` 返回 `feedback: evaluate('monitorAccount_refresh_rate', rate)` + `metric` 字段 |
> | 8 | 🟠 | 计划 `store.listMemoryLog({before})` 的时间筛选契约不存在（`retrieveMemory` 无 `before` 参） | 用真实纯函数 `classifyForDistill(rows, {ttlDays, now})` 做 30 天筛选（`memoryLog.js:6`） |
>
> **零改动清单（新增 2 项）**：`src/agent/eventTrigger.js`（#1/#2 裁定）、`src/memory/capture.js`（#5 裁定）。
> **测试断言要求（test-plan T16 ⑤）**：`monitorAccount` 源码须零 `agent-mail` / `sendMail` 引用（跨外联绝不自动发信）。

**Files:**
- Create: `src/connectors/discovery/monitorAccount.js`, `src/memory/accountMemory.js`
- Test: `test/connectors/discovery/monitorAccount.test.js`, `test/memory/accountMemory.test.js`

> ⛔ **不含** `src/agent/eventTrigger.js`、`src/memory/capture.js`（消解 #1/#2/#5 裁定零改动）。

- [ ] **Step 1: Write the failing tests**

```js
// test/memory/accountMemory.test.js
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { appendAccountMemory, distillAccountMemory, DISTILL_AFTER_DAYS } from '../../src/memory/accountMemory.js';

const OLD = new Date(Date.now() - 40 * 86400000).toISOString();

describe('accountMemory (C3)', () => {
  it('append 走真实 appendMemory 契约（topic 规约 + ACCOUNT 锚点 + 租户透传）', async () => {
    const store = { appendMemory: vi.fn(async (e) => ({ ok: true, row: { id: 'm1', ...e } })) };
    const r = await appendAccountMemory('acc1', { kind: 'rescore', payload: { why_narrative: 'x' } }, { store, tenantId: 't1' });
    expect(store.appendMemory).toHaveBeenCalledTimes(1);
    const arg = store.appendMemory.mock.calls[0][0];
    expect(arg.topic).toBe('account:acc1');
    expect(arg.entityId).toBe('acc1');
    expect(arg.entityType).toBe('ACCOUNT');
    expect(arg.tenantId).toBe('t1');
    expect(arg.kind).toBe('rescore');
    expect(r.ok).toBe(true);
  });

  it('蒸馏：30 天前历史聚合成 curated note，且 log 仍保留（append-only，零 DELETE）', async () => {
    const store = {
      retrieveMemory: vi.fn(async () => ({ channel: 'log', rows: [
        { kind: 'rescore', created_at: OLD, payload: { why_narrative: 'a' } },
        { kind: 'rescore', created_at: OLD, payload: { why_narrative: 'b' } },
      ] })),
      upsertNote: vi.fn(async (n) => ({ id: 'note1', ...n })),
    };
    const note = await distillAccountMemory('acc1', { store, now: Date.now() });
    expect(note.content).toContain('a');           // 真实 note 行键是 content，非 summary
    expect(DISTILL_AFTER_DAYS).toBe(30);
    expect(store.upsertNote).toHaveBeenCalledTimes(1);
    expect(store.deleteMemoryLog).toBeUndefined(); // 零 DELETE
  });

  it('无过期历史 → null（不产空 note）', async () => {
    const store = {
      retrieveMemory: vi.fn(async () => ({ channel: 'log', rows: [
        { kind: 'rescore', created_at: new Date().toISOString(), payload: {} },
      ] })),
      upsertNote: vi.fn(async () => ({ id: 'x' })),
    };
    expect(await distillAccountMemory('acc1', { store, now: Date.now() })).toBeNull();
    expect(store.upsertNote).not.toHaveBeenCalled();
  });

  it('零 DELETE：源码无删写字面', () => {
    const src = fs.readFileSync(path.resolve(process.cwd(), 'src/memory/accountMemory.js'), 'utf8');
    expect(/DELETE\s+FROM|\.delete\s*\(/i.test(src)).toBe(false);
  });
});
```

```js
// test/connectors/discovery/monitorAccount.test.js
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { monitorAccount } from '../../../src/connectors/discovery/monitorAccount.js';

const mkCtx = (over = {}) => ({
  getAccount: vi.fn(async () => ({
    id: 'acc1',
    payload: {
      discovery: {
        icp_fit_score: { value: 0.6, judge: { axis: 'capability', rule_ref: 'scenario:lead-fit#ruler:industry', j_score: 0.6 } },
        enrichment: { industry: { source: 'gaode', provider: 'gaode' } },
      },
    },
  })),
  rescore: vi.fn(async () => ({ score: 0.77, ruleRef: 'scenario:lead-fit#ruler:funding_round' })),
  appendMemory: vi.fn(async () => ({ ok: true, row: { id: 'm1' } })),
  updateParticle: vi.fn(async () => ({})),
  ...over,
});

describe('monitorAccount (C3)', () => {
  it('① 重评分 + append 记忆 + 只 update（零 DELETE）', async () => {
    const ctx = mkCtx();
    const out = await monitorAccount(ctx, 'acc1', [{ type: 'funding_round' }]);
    expect(ctx.getAccount).toHaveBeenCalledWith('acc1');
    expect(ctx.rescore).toHaveBeenCalled();
    expect(ctx.appendMemory).toHaveBeenCalledTimes(1);
    expect(out.why_narrative).toContain('funding_round');
    expect(ctx.deleteParticle).toBeUndefined();
  });

  it('② patch 读-改-写：保留 payload.discovery 既有子键（防整体替换）', async () => {
    const ctx = mkCtx();
    await monitorAccount(ctx, 'acc1', [{ type: 'funding_round' }]);
    const { patch } = ctx.updateParticle.mock.calls[0][1];
    expect(patch.discovery.enrichment).toEqual({ industry: { source: 'gaode', provider: 'gaode' } }); // 未被抹掉
    expect(patch.discovery.icp_fit_score.value).toBe(0.6);                                        // 未被抹掉
    expect(patch.discovery.intent_score.value).toBe(0.77);                                        // 本次新增
  });

  it('③ 参数名必须是 patch（防写 payload 键静默丢）', async () => {
    const ctx = mkCtx();
    await monitorAccount(ctx, 'acc1', []);
    const arg = ctx.updateParticle.mock.calls[0][1];
    expect(arg.patch).toBeDefined();
    expect(arg.payload).toBeUndefined();
  });

  it('④ 喂 Task 12 指标（feedback verdict 非空）', async () => {
    const ctx = mkCtx();
    const out = await monitorAccount(ctx, 'acc1', []);
    expect(out.feedback.metric).toBe('monitorAccount_refresh_rate');
    expect(['green', 'yellow', 'red']).toContain(out.feedback.verdict);
  });

  it('⑤ 不触发外发（源码零 agent-mail / sendMail）', () => {
    const src = fs.readFileSync(path.resolve(process.cwd(), 'src/connectors/discovery/monitorAccount.js'), 'utf8');
    expect(/agent-?mail|sendMail|send_mail/i.test(src)).toBe(false);
  });

  it('⑥ 缺 score → fail-fast（不静默置 0）', async () => {
    const ctx = mkCtx({ rescore: vi.fn(async () => ({ ruleRef: 'r' })) });
    await expect(monitorAccount(ctx, 'acc1', [])).rejects.toThrow(/score/);
  });

  it('⑦ 错误路径：rescore 抛错透传（不静默吞）', async () => {
    const ctx = mkCtx({ rescore: vi.fn(async () => { throw new Error('lead-fit unavailable'); }) });
    await expect(monitorAccount(ctx, 'acc1', [])).rejects.toThrow('lead-fit unavailable');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/connectors/discovery/monitorAccount.test.js test/memory/accountMemory.test.js`
Expected: FAIL — `Failed to resolve import ... monitorAccount.js`

- [ ] **Step 3: Implement `src/memory/accountMemory.js`（账户维度薄封装 · 复用既有记忆层）**

```js
// src/memory/accountMemory.js
// C3: 账户持久记忆（append-only + 30 天蒸馏）。吸收 Clay Account Agent 持久记忆范式，
// 但守「禁 DELETE」：只 append，绝不删历史；30 天后蒸馏为 curated note（memory_log 仍保留）。
//
// ⚠ 本模块**不发明新契约**（消解 #3）：全部复用既有记忆层真实函数——
//   写：memoryLog.appendMemory({topic,kind,payload,entityId,entityType,tenantId})
//   读：memoryLog.retrieveMemory({layer,topic,tenantId})
//   蒸馏筛选：memoryLog.classifyForDistill(rows,{ttlDays,now})（纯函数）
//   写 note：note.upsertNote({layer,topic,content,ttlDays})（返回 memory_note 行，键为 content）
// 生产默认走真实模块；测试注入替身（DI，零 PG）——与 createXxxRouter 的 deps 范式一致。
import { appendMemory as realAppendMemory, retrieveMemory as realRetrieveMemory, classifyForDistill } from './memoryLog.js';
import { upsertNote as realUpsertNote } from './note.js';

// 默认 store（生产真实契约）；测试注入替身即可完全离线
const DEFAULT_STORE = { appendMemory: realAppendMemory, retrieveMemory: realRetrieveMemory, upsertNote: realUpsertNote };

export const DISTILL_AFTER_DAYS = 30;
const ACCOUNT_LAYER = 'L-Workspace';

/** topic 规约：account:<id>（跨商机累积的账户维度记忆；与事件流 topic `event:*` 并列不冲突）。 */
export function accountTopic(accountId) {
  return `account:${accountId}`;
}

/**
 * 增量 append 账户记忆（append-only）。
 * @returns appendMemory 原始结果 { ok, row, tenant_id, entity_id, entity_type }
 */
export async function appendAccountMemory(accountId, entry = {}, { store = DEFAULT_STORE, tenantId = null } = {}) {
  const { kind = 'event', payload = {}, ...rest } = entry || {};
  return store.appendMemory({
    topic: accountTopic(accountId),
    kind,
    payload,
    layer: ACCOUNT_LAYER,
    entityId: String(accountId),
    entityType: 'ACCOUNT',
    tenantId,
    ...rest,
  });
}

/**
 * 30 天蒸馏：把账户 memory_log 中过期行聚合成一条 curated note（memory_log 行保持不动）。
 * @returns note 行（含 content）｜null（无过期历史时不产空 note）
 */
export async function distillAccountMemory(accountId, { store = DEFAULT_STORE, now = Date.now(), ttlDays = DISTILL_AFTER_DAYS } = {}) {
  const { rows = [] } = (await store.retrieveMemory({
    layer: ACCOUNT_LAYER, topic: accountTopic(accountId), limit: 200,
  })) || {};
  // 复用真实纯函数做时间筛选（不发明 before 参数）
  const older = classifyForDistill(rows, { ttlDays, now: new Date(now) }).filter((r) => r._markDistilled);
  if (!older.length) return null;
  // payload.why_narrative 优先（glass-box 叙事），退回 kind
  const summary = older.map((e) => e.payload?.why_narrative || e.kind).filter(Boolean).join('; ');
  return store.upsertNote({
    layer: ACCOUNT_LAYER,
    topic: `${accountTopic(accountId)}:curated`,
    content: summary,
    ttlDays: 365,
  });
}
```

- [ ] **Step 4: Implement `src/connectors/discovery/monitorAccount.js`**

```js
// src/connectors/discovery/monitorAccount.js
// C3: 持续账户监控闭环（吸收 Clay Account Agent 持久记忆 + 持续刷新）。
// 信号到达 或 定时增量刷新 ->
//   lead-fit 重评分(复用九标尺+2D judge) -> 增量 append 账户 append-only 记忆 -> glass-box 输出。
// 铁律：禁 DELETE（只 append 记忆、只 update payload）；跨外联绝不自动发信（走 HITL，本模块零邮件依赖）。
// 契约（DI）：ctx = { getAccount, rescore, appendMemory, updateParticle }，与 orchestrator deps 范式一致。
import { buildGlassBox } from '../../agent/glassBox.js';
import { evaluate } from '../../feedback/discoveryMetrics.js';

export async function monitorAccount(ctx, accountId, signals = []) {
  const acct = await ctx.getAccount(accountId);                 // 读既有账户（不新建）
  if (!acct) throw new Error(`账户不存在: ${accountId}`);
  const rescored = await ctx.rescore(accountId, { signals });   // lead-fit scenario 重跑（复用九标尺+2D judge）
  const score = rescored?.score;
  if (score == null) throw new Error('monitorAccount: rescore 未返回 score（拒绝静默置 0）');

  const gb = buildGlassBox({ score, ruleRef: rescored.ruleRef, signals });

  // 增量 append 到账户持久记忆（append-only，不覆盖、不删除）
  await ctx.appendMemory('CRM_ACCOUNT', accountId, { kind: 'rescore', ...gb, ts: new Date().toISOString() });

  // 只 update payload（且**读-改-写**：顶层浅合并会整体替换 payload.discovery，须展开既有子键）
  const prevDiscovery = acct.payload?.discovery && typeof acct.payload.discovery === 'object' ? acct.payload.discovery : {};
  await ctx.updateParticle(accountId, {
    patch: {
      discovery: {
        ...prevDiscovery,
        intent_score: { value: score, judge: gb.judge },
        why_narrative: gb.why_narrative,
      },
    },
  });

  // 喂 Task 12 feedback-loop（否则 discoveryMetrics 全仓零消费方 = 死码）；单账户本轮=1/1
  const fb = evaluate('monitorAccount_refresh_rate', 1);

  return { accountId, score, why_narrative: gb.why_narrative, glass_box: gb, feedback: { metric: 'monitorAccount_refresh_rate', value: 1, ...fb } };
}
```

- [ ] **Step 5: 事件矩阵行 —— 本 Task 不作落地（消解 #1/#2 裁定）**

> **裁定**：`src/agent/eventTrigger.js` **零改动**。三条硬证据：
> 1. `matchTrigger`（`eventTrigger.js:68`）硬编码 `x.domain === 'ontology'`；初稿用 `event/kind` 键连 `domain` 都没有 → 恒不匹配。
> 2. 无 `skill_slug` → `READ_ONLY_SKILLS.has(undefined)` = false → 白名单闸（`:71`）静默 `return null`（无报错）。
> 3. 即便改对键：`(ontology, ontology-sync, CRM_ACCOUNT)` 已被 funnel-classification 行占用（`:19`），`.find()` **首匹配胜出** → 新行恒被截胡；换 `type:'discovery-sync'` 则无 emitter（全仓 0 命中，test-plan §119 已预警）。
>
> **延后落地前置条件**（须先在后续 Task / brainstorming 解决）：① 为 `discovery` 域建真实 emitter（现仅 `orchestrator.js:109` 的 `lead-discovered`）；② `matchTrigger` 放宽 domain 闸门为配置驱动（属行为修改，**须 brainstorming 批准**）；③ 行形状须为 `{domain,type,entity_type,intent,agent,skill_slug,dedup_field}` 且 `skill_slug ∈ READ_ONLY_SKILLS`。
> **验证锚点（供未来 Task 复用）**：加行时须断言既有 3 行矩阵**未被替换**（append 非 overwrite），即 `AGENT_EVENT_TRIGGER_DEFAULT.matrix.length === 4` 且前三行 `toEqual` 原值。
>
> **⚠ 级联遗留（知情，非静默死码）**：Step 5 作废 ⇒ 本 Task 交付的 `monitorAccount` **暂无生产触发源**（全仓零调用方，仅被测试调用）。同理 `src/memory/accountMemory.js` 亦无生产消费方。两模块均**已实现 + 已测**（11 例全绿），接线待上述前置条件满足后由后续 Task（建议归 Task 18/20 对外面与端到端验收）完成。**接缝提示**：`monitorAccount` 的 DI 契约是 `ctx.appendMemory(particleType, accountId, entry)` **三参**，而 `accountMemory.appendAccountMemory(accountId, entry, opts)` 是**两参** —— 生产接线时须写适配（`(type, id, e) => appendAccountMemory(id, { ...e, payload: ... }, { tenantId })`），勿直接赋值。

- [ ] **Step 6: Run tests to verify pass**

Run: `npx vitest run test/connectors/discovery/monitorAccount.test.js test/memory/accountMemory.test.js`
Expected: PASS

- [ ] **Step 7: 回归（必须全绿，零回退）**

Run: `npx vitest run test/memory/ test/connectors/discovery/ test/agent/eventTrigger.test.js test/feedback/`

> 关键：`test/memory/discoveryCapture.test.js` 必须全绿（本 Task 零改 `capture.js` ⇒ 其 `appendMemory` toHaveBeenCalledTimes(1) 断言不受影响）；`test/agent/eventTrigger.test.js` 必须全绿（零改 `eventTrigger.js`）。
> 若出现红：先判断是否本次引入；疑似 flaky（共享库 TRUNCATE 干扰）→ **复跑相同组合命令**确认，不要直接改代码。

- [ ] **Step 8: Commit**

```powershell
git add src/connectors/discovery/monitorAccount.js src/memory/accountMemory.js test/connectors/discovery/monitorAccount.test.js test/memory/accountMemory.test.js
git commit -m "feat(discovery): C3 monitorAccount loop (rescore + append-only account memory + feedback metric, no DELETE)"
```

> ⛔ 不含 `src/agent/eventTrigger.js`、`src/memory/capture.js`（消解 #1/#2/#5：初稿为死配置 / 会打红既有 Task 9 测试）。

---



## Task 17: 后台配置页（`src/web/discovery-rules.html`，5 TAB）

> **路径校正**：真实目录 `src/web/`；模板取 `src/web/agent-event-trigger-config.html`（83 行同范式）。
>
> ⚠ **本节的接线（serve / configRouter / PUT 校验）已由 Task 1 全部完成，`src/http/routes.js` 零改动** —— 见下方消解 #1。

**Files:**
- Create: `src/web/discovery-rules.html`（5 TAB 配置页）
- Modify: `src/web/discovery.html`（**Task 13 遗留缺陷补修**，见 Step 0；同功能线 bug 修复，非新增功能）
- Test: `test/web/discoveryRulesPage.test.js`
- ⛔ **零改动**：`src/http/routes.js`（Task 1 已挂 serve `:244-245` + PUT 结构校验 `:232-240` + configRouter `:243`）、`src/portal/configCenter.js`（id46 已登记 `:73`）、`src/config/discoveryRules.js`、`src/context/routing.js`、`src/context/assembler.js`

---

### 派发前源码级复查消解（8 项 + T13 补修）

| # | 级别 | 缺陷（源码级证据） | 消解 |
|---|---|---|---|
| 0 | 🔴 | **Task 13 遗留：`discovery.html` 三处缺陷**（①**未接 layout 壳** → `test/web/nav-path.test.js:44` 硬断言「所有非排除 html 须含 `from '/portal/layout.js'` + `injectLayout()`」→ **实测 `missing = ['discovery.html']`，该测试当前红**；② `:48` `const { fetchJson } = await import('/portal/api.js')` —— `/portal/api.js` → `src/web/api.js` **只导出 `token/api/get/post/put/me`，无 `fetchJson`** → 运行时 `TypeError`；③ `:50` 渲染仅 `// ... 渲染` 注释 → 页面无功能） | 本 Task **Step 0 一并补修**（bug fix，豁免 brainstorming）；单独 commit |
| 1 | 🔴 | **计划「Modify routes.js」是重复劳动**：`routes.js:232-240` 已有 `app.put('/api/config/discovery-rules', ...)` 结构校验包装（缺 `icp/providers/signals` → 400）、`:243` 已有 `createConfigRouter({key:'discovery-rules', role:'sysadmin', decisionScene:'config-change'})`、`:244-245` 已有 `app.get('/discovery-rules.html', ...)` serve | **routes.js 零改动**；从 commit 清单剔除 |
| 2 | 🔴 | **`/portal/api.js` 无 `fetchJson`**（真实导出 `token/api/get/post/put/me`，`src/web/api.js:24-26`）→ 若照抄 T13 写法必死 | 用 `import { get, put } from '/portal/api.js'`（模板范式） |
| 3 | 🔴 | **必须接 layout 壳**：`nav-path.test.js:41` 遍历 `src/web/*.html`（排除 home/portal-stage3-mockup/landing/buddy-crm-portal），要求含 `from '/portal/layout.js'` **且** `injectLayout()` | 页面 script 首两行接壳（模板 `agent-event-trigger-config.html` 同款） |
| 4 | 🟠 | **计划「light 主题」与真实令牌冲突**：`tokens.css:15` `--bg:#0f172a` / `--ink:#e2e8f0` 是**深色**（slate 系） | **只用 `var(--*)` 令牌、禁写死色值**（主题随令牌，勿写 light） |
| 5 | 🟠 | **test-plan T17 要求 5 TAB「id 齐」= `icp`/`providers`/`signals`/`duplicate`/`playbooks`**，计划只给中文名（ICP/数据源/信号权重/查重条件/编排） | TAB 按钮同时带 `id="tab-<key>"` + `data-tab="<key>"` + 中文名；测试断言 5 个 key 齐 |
| 6 | 🟠 | **GET 未配置返 404**（`configRouter.js:97` `return res.status(404).json({error:'config ... 未配置'})`）→ 计划 Step 4「未配置时展示出厂默认」需页面 **catch 404 分支** | 页面内嵌 `DEFAULTS`（与 `DEFAULT_DISCOVERY_RULES` 逐键一致）+ catch 后亮只读态 |
| 7 | 🟠 | test-plan 要求「接线无 500」，但页面测试是 fs 断言（**无法验 HTTP**） | 分层：本测试 fs 断言页面结构；接线正确性由既有 `configRouter` 测试 + `discoveryRules` 路由测试覆盖（测试文件头注明） |
| 8 | 🟠 | 计划 Step 1 断言 `html.toContain('decision')` / `toContain('付费源')` —— 页面须真实含这两串 | 页面 note 含「决策第0闸…返回 **decision** 票据」+ 数据源 TAB 含「付费源」字样 |

**既有可复用契约（已逐条核实，勿再造轮子）**

| 契约 | 事实 | 锚点 |
|---|---|---|
| configRouter GET | `GET /api/config/:key` → `{key, value, decision}`（`decision = rec.decision_id \|\| null`）；**未配置 → 404**；sysadmin 闸 | `src/http/configRouter.js:95-106` |
| configRouter PUT | `PUT /api/config/:key` body `{value}` → `{key, value: nextValue, decision: decision?.decisionId \|\| null, updated: true}`；经 `requireDecision` 第 0 闸 | `src/http/configRouter.js:146-148` |
| 出厂默认结构 | `DEFAULT_DISCOVERY_RULES`：`icp{industries[],min_headcount,geo[],min_confidence}` / `providers[]`（8 源：`email-verify,web-research,tender,gaode`=system `enabled:true`；`attio,zhizao`=system-candidate `false`；`clearbit,linkedin`=paid `false`）/ `signals{6 维 {weight}}` / `duplicate_criteria{CRM_ACCOUNT:[[external_id],[domain],[linkedin_url],[name]], CRM_CONTACT:[[external_id],[email]]}` / `playbooks:[]` | `src/config/discoveryRules.js:10-45` |
| 门户 API | `get(path)` / `put(path, body)`（自动 Authorization、401 跳登录、非 2xx 抛 `{status, body}`） | `src/web/api.js:24-26` |
| 模板范式 | `import { injectLayout } from '/portal/layout.js'` + `import { get, put } from '/portal/api.js'` + `injectLayout()` + `load()`/`fill()`/`save()` | `src/web/agent-event-trigger-config.html` |
| 配置中心登记 | id46 已登记 `page:'/discovery-rules.html'`，`config.html` 经 `CONFIG_ITEMS` 动态渲染 → **可达** | `src/portal/configCenter.js:73` |

---

### Step 0: 补修 `src/web/discovery.html`（Task 13 遗留缺陷，🔴）

**当前测试为红（不修则本 Task 回归无法全绿）**：`test/web/nav-path.test.js` → `missing = ['discovery.html']`。

改 `src/web/discovery.html` 的 `<script type="module">`（保留三区结构 `triggerBar`/`candidatePool`/`glassBoxDrawer`，只重写脚本）：

```html
<script type="module">
  import { injectLayout } from '/portal/layout.js';
  import { get } from '/portal/api.js';
  injectLayout();
  // 只读端点：GET /api/discovery/candidates（候选池）；detail 经 /api/particles/:id/schema（既有只读）
  // 触发：<buddy-capsule> 注入 prompt（discovery-run）→ 写经 MCP 两阶段 + 第0闸，本页不裸调
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function render(items) {
    const tbody = document.getElementById('candidate-tbody');
    if (!tbody) return;
    if (!items.length) { tbody.innerHTML = '<tr><td colspan="5">暂无已评分候选</td></tr>'; return; }
    // 渲染进既有表体（列：公司 / ICP 适配分 / 信号 / why_narrative / 来源），保留表头语义
    tbody.innerHTML = items.map((it) => `
      <tr data-account-id="${esc(it.account_id)}">
        <td>${esc(it.name || it.account_id)}</td>
        <td>${it.icp_fit_score == null ? '—' : Number(it.icp_fit_score).toFixed(2)}</td>
        <td>${(it.signals || []).map((s) => `<span class="badge">${esc(typeof s === 'string' ? s : s && s.type)}</span>`).join('')}</td>
        <td>${esc(it.why_narrative || '')}</td>
        <td>${(it.sources || []).map((s) => `<span class="badge">${esc(s)}</span>`).join('')}</td>
      </tr>`).join('');
  }
  async function load() {
    try {
      const data = await get('/api/discovery/candidates');
      render(data?.items || []);
    } catch (e) {
      // 未登录/未配置 → 空态，不阻断页面
      render([]);
    }
  }
  load();
</script>
```

**补修判据**：`grep -c "injectLayout" src/web/discovery.html` = 1（原 0）；`grep -c "fetchJson" src/web/discovery.html` = **0**（原 1）；`npx vitest run test/web/nav-path.test.js test/web/discoveryPage.test.js` **全绿**（原 nav-path 红）。

---

### Step 1: Write the failing test

```js
// test/web/discoveryRulesPage.test.js
// 分层说明：本测试为 fs 源码断言（页面结构/契约字面），不连库、不起 HTTP。
// 「接线无 500」由既有 test/http/configRouter.test.js + 本功能线路由测试覆盖（见计划消解 #7）。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const html = readFileSync(new URL('../../src/web/discovery-rules.html', import.meta.url), 'utf8');
const routes = readFileSync(new URL('../../src/http/routes.js', import.meta.url), 'utf8');

describe('discovery-rules.html 后台配置页', () => {
  it('① 5 TAB id 齐（icp/providers/signals/duplicate/playbooks）', () => {
    for (const k of ['icp', 'providers', 'signals', 'duplicate', 'playbooks']) {
      expect(html).toContain(`data-tab="${k}"`);
    }
    for (const t of ['ICP', '数据源', '信号权重', '查重条件', '编排']) expect(html).toContain(t);
  });
  it('② 写端点 + 第0闸票据 + 付费源出厂禁用提示', () => {
    expect(html).toContain('/api/config/discovery-rules');
    expect(html).toContain('decision');   // 回显第0闸 decision 票据
    expect(html).toContain('付费源');      // D1：付费源出厂禁用
  });
  it('③ 接 layout 壳 + 用门户 api 封装（禁裸 fetch）', () => {
    expect(html).toContain("from '/portal/layout.js'");
    expect(html).toContain('injectLayout()');
    expect(html).toContain("from '/portal/api.js'");
    const code = html.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
    expect(code).not.toMatch(/\bfetch\(\s*['"`]\s*\/api\//);   // 禁裸 fetch
    expect(code).toMatch(/\b(get|put)\s*\(\s*['"`]\/api\//);  // 必用 get/put
  });
  it('④ 五段配置面齐（icp/providers/signals/duplicate_criteria/playbooks 键字面）', () => {
    for (const k of ['icp', 'providers', 'signals', 'duplicate_criteria', 'playbooks']) expect(html).toContain(k);
  });
  it('⑤ 零写零删：无 DELETE 字面', () => {
    expect(/\bDELETE\b/i.test(html)).toBe(false);
  });
  it('⑥ routes.js 已挂载（Task 1 落地，本 Task 零改动）', () => {
    expect(routes).toContain("app.use(createConfigRouter({ key: 'discovery-rules'");
    expect(routes).toContain("app.get('/discovery-rules.html'");
  });
});
```

### Step 2: Run

`npx vitest run test/web/discoveryRulesPage.test.js` → **FAIL**（`src/web/discovery-rules.html` 不存在 → `ENOENT`）

---

### Step 3: Create `src/web/discovery-rules.html`

**结构（5 TAB 编辑面 → 配置键）**

| TAB key | 中文名 | 编辑面 | 配置键 |
|---|---|---|---|
| `icp` | ICP | industries（逗号分隔文本）/ min_headcount（number）/ geo（逗号分隔）/ min_confidence（number 0–1 step .05） | `icp.*` |
| `providers` | 数据源 | 8 源按 `scope` 三档（`system`/`system-candidate`/`paid`）分组表 + enabled checkbox；**paid 行 disabled 置灰 + 标「付费源出厂禁用，需显式授权 + 填 key」**（D1） | `providers[]` |
| `signals` | 信号权重 | 6 维 `type=range` min 0 max 1 step .05 + 实时数值 | `signals.<k>.weight` |
| `duplicate` | 查重条件 | 按对象类型（CRM_ACCOUNT / CRM_CONTACT）的**有序列组** textarea（JSON 数组的数组，多级回退序） | `duplicate_criteria` |
| `playbooks` | 编排 | 四段原语（data→condition→ai→action）playbook 列表 textarea（JSON，出厂 `[]`） | `playbooks` |

**完整骨架（照此实现，勿改契约）**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>线索发现规则 · 配置中心</title>
<link rel="stylesheet" href="/portal/tokens.css">
<link rel="stylesheet" href="/portal/common.css">
<style>
  /* 只用 tokens.css 令牌，禁写死色值（主题随令牌） */
  body { font-family: -apple-system, "Microsoft YaHei", sans-serif; margin: 0; background: var(--bg); color: var(--ink); }
  .wrap { padding: 18px 20px; max-width: 1180px; margin: 0 auto; }
  .note { background: var(--warn); color: #fff; padding: 10px 12px; border-radius: 6px; font-size: 12px; margin-bottom: 14px; }
  .tabs { display: flex; gap: 6px; border-bottom: 1px solid var(--line); margin-bottom: 14px; }
  .tabs button { background: transparent; border: 0; border-bottom: 2px solid transparent; color: var(--mut); padding: 8px 14px; cursor: pointer; font-size: 13px; }
  .tabs button.active { color: var(--ink); border-bottom-color: var(--ac); }
  .panel { display: none; background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 14px 16px; margin-bottom: 14px; }
  .panel.active { display: block; }
  .sect-title { font-weight: 600; margin-bottom: 10px; }
  .field { display: flex; gap: 10px; align-items: center; margin: 6px 0; }
  .field label { width: 300px; font-size: 13px; color: var(--mut); }
  .field input, .field textarea { padding: 5px 8px; border: 1px solid var(--line); border-radius: 4px; background: var(--bg); color: var(--ink); }
  .field textarea { width: 100%; min-height: 72px; font-family: ui-monospace, Consolas, monospace; font-size: 12px; }
  table.cfg { width: 100%; border-collapse: collapse; font-size: 13px; }
  table.cfg th, table.cfg td { border: 1px solid var(--line); padding: 6px 8px; text-align: left; }
  tr.disabled { opacity: .45; }
  .muted { color: var(--mut); font-size: 12px; }
  #status { font-size: 12px; color: var(--mut); }
  .toolbar { display: flex; gap: 10px; align-items: center; }
</style>
<script type="module" src="/portal/components.js"></script>
</head>
<body>
<header class="page-head"><div class="ph-main"><h1 class="page-title">线索发现规则</h1></div></header>
<div class="wrap">
  <div class="note">
    ICP / 数据源三档 / 信号权重 / 查重条件 / 编排 playbooks 全部后台可配，代码零硬编码。
    数据存入 <b>config_store['discovery-rules']</b>（租户级差分），写操作经 <b>决策第 0 闸</b> + sysadmin 权限，保存后回显 <b>decision</b> 票据。
  </div>

  <div class="tabs">
    <button data-tab="icp" class="active">ICP</button>
    <button data-tab="providers">数据源</button>
    <button data-tab="signals">信号权重</button>
    <button data-tab="duplicate">查重条件</button>
    <button data-tab="playbooks">编排</button>
  </div>

  <section class="panel active" id="panel-icp">
    <div class="sect-title">ICP 目标客户画像</div>
    <div class="field"><label>目标行业（逗号分隔）</label><input id="icp-industries" /></div>
    <div class="field"><label>最小员工规模</label><input type="number" id="icp-headcount" min="0" step="1" /></div>
    <div class="field"><label>地理范围（逗号分隔）</label><input id="icp-geo" /></div>
    <div class="field"><label>最低置信度（0–1）</label><input type="number" id="icp-confidence" min="0" max="1" step="0.05" /></div>
  </section>

  <section class="panel" id="panel-providers">
    <div class="sect-title">数据源（三档）</div>
    <table class="cfg">
      <thead><tr><th>数据源</th><th>类型</th><th>档位</th><th>成本档</th><th>启用</th></tr></thead>
      <tbody id="providers-body"></tbody>
    </table>
    <div class="muted">system 出厂启用；system-candidate 按行业启用；<b>付费源</b>（paid）出厂禁用，需显式授权 + 填 key（D1）。</div>
  </section>

  <section class="panel" id="panel-signals">
    <div class="sect-title">信号权重（0–1）</div>
    <div id="signals-body"></div>
  </section>

  <section class="panel" id="panel-duplicate">
    <div class="sect-title">查重条件（有序列组，多级回退序）</div>
    <div class="field"><label>CRM_ACCOUNT（JSON: 数组的数组）</label><textarea id="dup-account" spellcheck="false"></textarea></div>
    <div class="field"><label>CRM_CONTACT（JSON: 数组的数组）</label><textarea id="dup-contact" spellcheck="false"></textarea></div>
    <div class="muted">例：<code>[["external_id"],["domain"],["name"]]</code> —— 组内 AND，组间按顺序回退（对齐 Twenty flatObjectMetadata.duplicateCriteria）。</div>
  </section>

  <section class="panel" id="panel-playbooks">
    <div class="sect-title">编排 playbooks（四段原语 data→condition→ai→action）</div>
    <div class="field"><label>playbooks（JSON 数组）</label><textarea id="playbooks-json" spellcheck="false"></textarea></div>
    <div class="muted">出厂不预置（<code>[]</code>）—— 按客群命名 playbook，命中后收窄数据源 + 挂 SKILL（C1，Task 14 编译）。</div>
  </section>

  <div class="toolbar">
    <crm-button id="saveBtn">保存变更</crm-button>
    <crm-button class="sec" id="reloadBtn">重新加载</crm-button>
    <span id="status">就绪</span>
    <span class="muted" id="readonlyHint"></span>
  </div>
</div>

<script type="module">
import { injectLayout } from '/portal/layout.js';
import { get, put } from '/portal/api.js';
injectLayout();

// 出厂默认 = src/config/discoveryRules.js DEFAULT_DISCOVERY_RULES（未配置时只读回显该组值）
const DEFAULTS = {
  icp: { industries: ['industrial_coatings', 'chemical', 'additives'], min_headcount: 50, geo: ['CN'], min_confidence: 0.6 },
  providers: [
    { id: 'email-verify', kind: 'email/phone',       scope: 'system',           costTier: 1, enabled: true },
    { id: 'web-research', kind: 'web/serp',          scope: 'system',           costTier: 0, enabled: true },
    { id: 'tender',       kind: 'internal-signal',   scope: 'system',           costTier: 0, enabled: true },
    { id: 'gaode',        kind: 'geo_firmographics', scope: 'system',           costTier: 1, enabled: true },
    { id: 'attio',        kind: 'firmographics',     scope: 'system-candidate', costTier: 2, enabled: false },
    { id: 'zhizao',       kind: 'biz-verify',        scope: 'system-candidate', costTier: 1, enabled: false },
    { id: 'clearbit',     kind: 'firmographics',     scope: 'paid',             costTier: 3, enabled: false },
    { id: 'linkedin',     kind: 'social',            scope: 'paid',             costTier: 3, enabled: false },
  ],
  signals: {
    funding_round: { weight: 0.9 }, hiring_icp_role: { weight: 0.7 }, tender_match: { weight: 0.8 },
    leadership_change: { weight: 0.5 }, tech_adopt: { weight: 0.6 }, website_redesign: { weight: 0.3 },
  },
  duplicate_criteria: { CRM_ACCOUNT: [['external_id'], ['domain'], ['linkedin_url'], ['name']], CRM_CONTACT: [['external_id'], ['email']] },
  playbooks: [],
};

let current = null;
function setStatus(s) { document.getElementById('status').textContent = s; }

document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === 'panel-' + b.dataset.tab));
}));

function renderProviders(list) {
  document.getElementById('providers-body').innerHTML = (list || []).map((p) => `
    <tr class="${p.scope === 'paid' ? 'disabled' : ''}">
      <td>${p.id}${p.scope === 'paid' ? ' <span class="muted">（付费源）</span>' : ''}</td>
      <td>${p.kind || ''}</td><td>${p.scope || ''}</td><td>${p.costTier ?? ''}</td>
      <td><input type="checkbox" data-provider="${p.id}" ${p.enabled ? 'checked' : ''} ${p.scope === 'paid' ? 'disabled' : ''}></td>
    </tr>`).join('');
}
function renderSignals(sig) {
  document.getElementById('signals-body').innerHTML = Object.keys(sig || {}).map((k) => `
    <div class="field"><label>${k}</label>
      <input type="range" data-signal="${k}" min="0" max="1" step="0.05" value="${sig[k]?.weight ?? 0}">
      <span class="muted" id="sigval-${k}">${sig[k]?.weight ?? 0}</span></div>`).join('');
  document.querySelectorAll('input[data-signal]').forEach((el) => el.addEventListener('input', () => {
    document.getElementById('sigval-' + el.dataset.signal).textContent = el.value;
  }));
}
function fill(v) {
  const icp = v.icp || {};
  document.getElementById('icp-industries').value = (icp.industries || []).join(', ');
  document.getElementById('icp-headcount').value = icp.min_headcount ?? '';
  document.getElementById('icp-geo').value = (icp.geo || []).join(', ');
  document.getElementById('icp-confidence').value = icp.min_confidence ?? '';
  renderProviders(v.providers || []);
  renderSignals(v.signals || {});
  const dc = v.duplicate_criteria || {};
  document.getElementById('dup-account').value = JSON.stringify(dc.CRM_ACCOUNT || []);
  document.getElementById('dup-contact').value = JSON.stringify(dc.CRM_CONTACT || []);
  document.getElementById('playbooks-json').value = JSON.stringify(v.playbooks || [], null, 2);
}
function collect() {
  const signals = {};
  document.querySelectorAll('input[data-signal]').forEach((el) => { signals[el.dataset.signal] = { weight: Number(el.value) }; });
  const providers = (current?.providers || DEFAULTS.providers).map((p) => {
    const box = document.querySelector(`input[data-provider="${p.id}"]`);
    return { ...p, enabled: p.scope === 'paid' ? false : !!box?.checked };
  });
  return {
    icp: {
      industries: document.getElementById('icp-industries').value.split(',').map((s) => s.trim()).filter(Boolean),
      min_headcount: Number(document.getElementById('icp-headcount').value) || 0,
      geo: document.getElementById('icp-geo').value.split(',').map((s) => s.trim()).filter(Boolean),
      min_confidence: Number(document.getElementById('icp-confidence').value) || 0,
    },
    providers, signals,
    duplicate_criteria: {
      CRM_ACCOUNT: JSON.parse(document.getElementById('dup-account').value || '[]'),
      CRM_CONTACT: JSON.parse(document.getElementById('dup-contact').value || '[]'),
    },
    playbooks: JSON.parse(document.getElementById('playbooks-json').value || '[]'),
  };
}
async function load() {
  setStatus('加载中…');
  try {
    const data = await get('/api/config/discovery-rules');
    current = (data && data.value) ? data.value : {};
    document.getElementById('readonlyHint').textContent = '';
    fill({ ...DEFAULTS, ...current });
    setStatus('已加载（decision=' + (data?.decision || '—') + '）');
  } catch (e) {
    // 未配置 → 404（configRouter.js:97）：亮出厂默认（只读态）
    current = {};
    fill(DEFAULTS);
    document.getElementById('readonlyHint').textContent = '（当前展示出厂默认，尚未落库）';
    setStatus('未配置或加载失败，显示出厂默认：' + (e.message || e));
  }
}
async function save() {
  setStatus('保存中…');
  let value;
  try { value = collect(); } catch (err) { setStatus('JSON 格式错误：' + (err.message || err)); return; }
  try {
    const r = await put('/api/config/discovery-rules', { value });
    current = r.value || value;
    setStatus('已保存（写经决策第 0 闸，decision=' + (r.decision || '—') + '）');
  } catch (e) { setStatus('保存失败：' + (e.message || e)); }
}
document.getElementById('saveBtn').addEventListener('click', save);
document.getElementById('reloadBtn').addEventListener('click', load);
load();
</script>
</body>
</html>
```

### Step 4: 接线（**零改动** —— Task 1 已落地）

`src/http/routes.js` 无需改动，既有三处已满足本页全部需求（消解 #1）：

```js
// :232-240  PUT 结构校验前置（缺 icp/providers/signals → 400）
// :243      app.use(createConfigRouter({ key: 'discovery-rules', role: 'sysadmin', decisionScene: 'config-change' }));
// :244-245  app.get('/discovery-rules.html', ...)
```

**核验命令**：`grep -n "discovery-rules" src/http/routes.js` → 应见 `:232/:243/:244-245`（与本次实现前逐字相同）。

### Step 5: Run

`npx vitest run test/web/discoveryRulesPage.test.js test/web/nav-path.test.js test/web/discoveryPage.test.js` → **PASS**（含 Step 0 的 nav-path 由红转绿）

### Step 6: 回归

`npx vitest run test/web/ test/http/configRouter.test.js test/config/discoveryRules.test.js`

> 已知**既有红**（与本 Task 无关，勿修勿判）：`test/web/configCenter.test.js`（`CONFIG_ITEMS.length` 断言 34、实际 35 —— id46 为 Task 1 登记）、`test/web/pipeline-new-deal.test.js`（POST 调用写法断言漂移）。若出现**其他**红：先判断是否本次引入；疑似 flaky（共享库 TRUNCATE 干扰）→ **复跑相同组合命令**确认，不要直接改代码。

### Step 7: Commit（按功能线分两条）

```powershell
git add src/web/discovery.html
git commit -m "fix(discovery): wire workbench page into layout shell + real candidate fetch (T13 regression)"

git add src/web/discovery-rules.html test/web/discoveryRulesPage.test.js
git commit -m "feat(discovery): admin config page (ICP/providers/signals/dedup/playbooks, 5 tabs)"
```

> ⛔ commit 清单**不含** `src/http/routes.js`（本 Task 零改动）。

---

## Task 18: ACTION 对外面（MCP 暴露 + 白名单 + gateway 决策锚定 + 反爆炸护栏）

> Task 5 解决「注册进去」（三处硬闭包）；本 Task 解决「对外可见且守闸」。

**Files:**
- Modify: `src/action/whitelist.js`（**注释级零逻辑改动**：补决策记录注释）
- Test: `test/action/discoveryActions.test.js`（**追加** describe 块，保留既有 T5 五例）

### 派发前源码级复查消解（7 项，含 5 🔴）

> 复查方式：`grep` + 实跑 `tmp/_probe_t18.mjs`（`seedActions(); seedDiscoveryActions();` 后实测各契约返回形状）。

| # | 级别 | 缺陷 | 实测证据 | 消解 |
|---|---|---|---|---|
| 1 | 🔴 | 原稿 `buildMcpTools({seed:false}).map(...)` —— **返回值不是数组** | 实测 `Array.isArray(buildMcpTools(...)) === false`，keys = `tools,readTools,writeTools,readSensitiveTools,authTools`（`src/mcp/tools.js:141`） | 改 `buildMcpTools().tools.map((t) => t.name)` |
| 2 | 🔴 | 原稿 `detectCrudExplosion().exploded===false` 在**空/仅 discovery 注册表**下**恒真 = 假绿**（无可聚合 CRUD 动词） | 实测 `resetRegistry()` 后 `{"exploded":false,"offenders":[]}`；仅 discovery 亦 false | 断言**必须在真实全量 surface 上**做：新 describe 内 `beforeAll(() => seedActions())` / 暴露断言走 `buildMcpTools()`（默认 `seed:true`）+ 加非平凡计数闸（`names.length > 30`） |
| 3 | 🔴 | 原稿 Step 4 断言 `gate='confirm_required'` —— **该 gate 值全仓 0 命中** | `grep -rn "confirm_required" src/ test/ scripts/` → **空**。写通道真实 gate 值仅：`auth_required`/`mcp_entitlement*`/`decision_required`/`confirm_expired`/`permission_denied`/`confirm_params_conflict` | 删除该断言，改**静态契约锚定**（见 Step 4） |
| 4 | 🔴 | 原稿 Step 4 语义**把设计行为判成失败**：discovery-* 声明了 `decisionScenario='LEAD_FIT'` → `gateway.js:165` **代为 mint** → 成功即 `{ok:true, confirm_token}`（两阶段），**非闸失败**。原稿「只判 `ok!==true`」在 mint 失败时亦为 `ok:false` → 与「无场景」**不可区分 = 回退假绿** | 实测 `discovery-run`：`{autoDecision:true, decisionScenario:'LEAD_FIT', confirm:'stage2', needsApproval:true}`；`gateway.js:165-183` mint 落 `params.decision_id`；`:200-216` 仅 mint 失败才 `decision_required` | 改判「锚定字段齐 + handler 级 fail-closed」（Step 4） |
| 5 | 🔴 | **DB-free 直调 `mcpWritePhase1` 做单测必然假绿**：无 token → `buildMcpCtx` degraded → `gateway.js:149-153` 早返 `auth_required` → 「只判 `ok!==true`」**对错误原因恒通过** | `gateway.js:149-153` 早返；`mint` 需 PG（`requireDecision`→`autonomyEngine`） | **禁止** DB-free 直调 gateway；第 0 闸真实链路锚定归 **Task 20**（真实实例 + 真实 MCP stdio） |
| 6 | 🔴 | 原稿 Step 1 给的是**整文件内容**（含 `getAction`/`seedDiscoveryActions` 重复 import）→ 照抄会**覆盖**既有 T5 五例（现 `test/action/discoveryActions.test.js` 38 行） | 既有文件 `beforeAll(() => { seedDiscoveryActions(); seedSkills(); })` + 5 个硬闭包用例 | 明确为**追加 describe 块**，只在文件顶部补 4 行 import；既有 `beforeAll` **零改动**（新 describe 内自带 `beforeAll(() => seedActions())`） |
| 7 | 🟡 | **文件路径两处冲突**：计划写 `test/action/discoveryActions.test.js（扩展）`，`test-plan §4 T18` 写 `test/mcp/discoveryExpose.test.js` | 计划 Task 18 Files + Step 7 commit 清单 vs test-plan §4 | **裁定以计划为准**（复用既有脚手架、与 T5 同文件、commit 清单一致）；同步修订 `test-plan §4 T18` 文件名 |

> **零逻辑改动确认**：`src/action/whitelist.js:4-9` 的 `WRITE_WHITELIST` **仅 4 项**（`crm-deal-advance`/`data-particle-create`/`data-particle-update`/`data-particle-attr-update`），**天然不含** discovery-* → `writeBlastRadius('discovery-run')` 实测恒为 `'human_gate'`。故 Step 3 为**注释级**改动，无任何判定逻辑变更。human_gate 真实执行点 = `src/action/executor.js:149`（`!isWriteWhitelisted(actionName) && !ctx.authorizedWrite` → 拒），原稿表述准确，保留。

- [ ] **Step 1: Extend the failing test（追加，勿覆盖）**

> 只在 `test/action/discoveryActions.test.js` **顶部补 4 行 import**，并在文件末尾**追加**下述 describe 块。既有 `beforeAll` 与 5 个用例**保持一字不改**。

```js
// ── 顶部追加的 import（与既有 import 并列）──
import { detectCrudExplosion } from '../../src/action/registry.js';          // getAction 已 import
import { writeBlastRadius, isWriteWhitelisted } from '../../src/action/whitelist.js';
import { seedActions } from '../../src/action/seed-actions.js';
import { buildMcpTools } from '../../src/mcp/tools.js';

// ── 文件末尾追加 ──
describe('discovery ACTION 对外面（T18）', () => {
  const EXPOSE = ['discovery-run', 'discovery-enrich', 'discovery-research'];
  // 关键：R3 护栏与暴露计数必须在**真实全量注册表**上判定，否则空表恒绿（假绿，见消解 #2）
  beforeAll(() => { seedActions(); });

  it('① 三个动作均为 write / agentTool / namespace=discovery', () => {
    for (const n of EXPOSE) {
      const a = getAction(n);
      expect(a, n).not.toBeNull();
      expect(a.kind, n).toBe('write');
      expect(a.agentTool, n).toBe(true);
      expect(a.namespace, n).toBe('discovery');
    }
  });

  it('② 第 0 闸锚定字段齐（gateway.js:165 mint 触发键 + 两阶段确认）', () => {
    for (const n of EXPOSE) {
      const a = getAction(n);
      expect(a.decisionScenario, n).toBe('LEAD_FIT');  // gateway 据此 mint 决策
      expect(a.autoDecision, n).toBe(true);            // executor 第 0 闸放行键
      expect(a.confirm, n).toBe('stage2');             // 两阶段（先表单后执行）
      expect(a.needsApproval, n).toBe(true);           // 外联/主数据写 → 人工闸
    }
  });

  it('③ 默认 human_gate —— 不进 autonomous 写白名单', () => {
    for (const n of EXPOSE) {
      expect(isWriteWhitelisted(n), n).toBe(false);
      expect(writeBlastRadius(n), n).toBe('human_gate');
    }
  });

  it('④ handler 级 fail-closed：无 decision_id 必拒（第 0 闸不假绿）', async () => {
    await expect(getAction('discovery-run').handler({ seed: {} }, {})).rejects.toThrow(/decision_required/);
    await expect(getAction('discovery-enrich').handler({ account_id: 'x' }, {})).rejects.toThrow(/decision_required/);
    await expect(getAction('discovery-research').handler({ account_id: 'x', brief: 'b' }, {}))
      .rejects.toThrow(/decision_required/);
  });

  it('⑤ 经 MCP 列表对外暴露（全量 surface + 非平凡计数闸）', () => {
    const names = buildMcpTools().tools.map((t) => t.name);  // 默认 seed:true → 真实全量
    expect(names.length).toBeGreaterThan(30);                // 防「空注册表恒含」假绿
    for (const n of EXPOSE) expect(names, n).toContain(n);
  });

  it('⑥ 不触发 R3 CRUD 爆炸护栏（全量注册表上判定）', () => {
    const r = detectCrudExplosion();
    expect(r.exploded).toBe(false);
    expect(r.offenders).toEqual([]);
  });
});
```

- [ ] **Step 2: Run** → FAIL（`whitelist.js` 未 export 时 / 断言未满足时红；确认红因是真实缺陷而非 import 错）

```powershell
npx vitest run test/action/discoveryActions.test.js
```

- [ ] **Step 3: 白名单判定（**注释级零逻辑改动**）** — `src/action/whitelist.js` 的 `WRITE_WHITELIST` **不加入** `discovery-*`（天然已成立，见消解「零逻辑改动确认」）。在文件内**补注释**记录该决策与依据：discovery-* 写主数据（CRM_ACCOUNT/CONTACT payload）且跨到外联面；进白名单会使其在对话入口 autonomous 自主写入 —— 与分析引擎「跨外联走 HITL 绝不自动发信」（设计 §6.2）同构。

- [ ] **Step 4: gateway 决策锚定核对（静态契约 + handler 级 fail-closed；**禁止 DB-free 直调 gateway**）**

原稿断言 `gate='confirm_required'` 作废（消解 #3/#4/#5）。改为两条**可核实且非假绿**的断言，均已落在 Step 1 用例中：

1. **静态锚定**（用例 ②）：三个动作的 `decisionScenario === 'LEAD_FIT'` + `autoDecision === true` —— 此二键正是 `src/mcp/gateway.js:165`（`!params?.decision_id && def?.decisionScenario` → `requireDecision(def.decisionScenario, …, { actor_id, tenantId })`）的 mint 触发条件；`confirm === 'stage2'` 保证 mint 后仍走两阶段（`ok:true + confirm_token`），**phase1 绝不执行写**。
2. **handler 级 fail-closed**（用例 ④）：`handler(payload, {})` **无 `ctx.decision_id` 必 reject `/decision_required/`** —— 落点 `src/action/discoveryActions.js:16-22`（`requireMintedDecision`，把 executor `:71` 的静默「无场景不 mint 但照常执行」顶成硬错）。

> ⛔ **不得**在单测里直调 `mcpWritePhase1` 断言闸值：无 token ⇒ `buildMcpCtx` degraded ⇒ `gateway.js:149-153` 早返 `auth_required`，「只判 `ok!==true`」对错误原因恒通过。**第 0 闸真实链路锚定（mint 真落 `crm.decision` 行）归 Task 20 端到端**（真实实例 + 真实 MCP stdio）。

- [ ] **Step 5: Run** → PASS

```powershell
npx vitest run test/action/discoveryActions.test.js
```

- [ ] **Step 6: 回归**（T18 触碰 MCP 暴露面与 Action 注册表，须连带跑）

```powershell
npx vitest run test/action test/mcp test/decision test/meta-attr-actions.test.js
```

Expected: 全绿。**基线红单列（非本 Task 引入，勿修）**：`test/config/configCenter.test.js`（34 vs 35）、`test/integration/pipeline-new-deal.test.js`（post vs fetch）。

- [ ] **Step 7: Commit**

```powershell
git add src/action/whitelist.js test/action/discoveryActions.test.js
git commit -m "feat(discovery): ACTION exposure gate (human_gate + decisionScenario mint + no CRUD explosion)"
```

> 🔴 **后续补注（T19 执行期发现，见 Task 19 §执行期新增发现 D17）**：本 Task 的「经 MCP 列表对外暴露」断言是**假绿** —— `buildMcpTools()` 只调 `seedActions()`，而 discovery 族由独立的 `seedDiscoveryActions()` 注册；`src/mcp/server.js` 既不 import `agents.js` 也不 import `routes.js`，故**独立 MCP 进程里三个动作从未注册**（真实暴露 57 而非 60）。单测在 `beforeAll` 显式 seed 了 discovery 族，掩盖了这一点。修复落在 `src/mcp/tools.js`（MCP 暴露面唯一咽喉），归 **Task 19** 落地。

---
## Task 19: buddy 应用 + 两个插件包同步

> **分发铁律（项目 memory）**：新增对外 MCP 工具 = 必须同步插件包（4 份 `SKILL.md` + 2 份 `agents/crm-native.md` + 版本清单），并让 `verify-plugin-zips.py` 对齐（`expect_version` **+ 防漂移内容规则**）。

**Files（16 项，勿按原稿 8 项执行）：**
- Modify: `buddy-crm-manifest.json`（`home.workModes[销售坐席].capsules[]` 加项；**`market.skills` 不动**、**`workModes[].skills` 不动**——见消解 #3/#4）
- Modify: `src/web/buddy-crm-portal.html`（`CAPS["客户洞察"]` 加项）
- Modify: `scripts/buddy-capsule-binding-check.mjs`（`BINDINGS` 加行 + 修 1 处既有漂移 客户调研→客户拜访）
- Modify: `scripts/gen-capsule-icons.mjs`（`ICONS` 加 `discovery` 槽位）+ **Add** `assets/capsules/discovery.svg`（由上脚本生成）
- Modify: `assets/capsules/index.html`（预览计数 14→15 + 销售坐席网格加卡）
- Modify ×4（**byte-equal**）：`skills/crm-native/SKILL.md`、`.workbuddy-plugin/skills/crm-native/SKILL.md`、`connector/skills/crm-native/SKILL.md`、`plugin/skills/crm-native/SKILL.md`
- Modify ×2（**byte-equal**）：`.workbuddy-plugin/agents/crm-native.md`、`plugin/agents/crm-native.md`
- Modify: `.workbuddy-plugin/plugin.json`（1.7.1→**1.8.0**）
- Modify: `plugin/openclaw.plugin.json`（1.7.1→**1.8.0**）
- Modify: `plugin/package.json`（1.7.1→**1.8.0**）
- Modify: `connector/connector-meta.json`（1.5.0→**1.6.0** + 一条 example）
- Modify: `scripts/verify-plugin-zips.py`（`expect_version` 1.7.1→**1.8.0** + **2 条内容规则**）
- Modify: `plugin/README.md`（新增「2026-09-11 同步说明」一节）
- Test: `test/ui/discoveryCapsule.test.js`（**新建 `test/ui/` 目录**；vitest.config.js 无 `include` 限制，会被自动收集）

### 派发前源码级复查消解（16 项，含 6 🔴）

> 复查方式：`grep` + `sha256sum` 全仓副本盘点 + 实跑 `tmp/_probe_t19.mjs`（manifest 值域不变量）/ `tmp/_probe_t19b.mjs`（门户↔校验表 parity）。

| # | 级别 | 缺陷 | 实测证据 | 消解 |
|---|---|---|---|---|
| 1 | 🔴 | 计划 `icon:'assets/capsules/discovery.svg'` **文件不存在** → `pack-buddy-import.mjs:82-92` 的 MISSING ICONS 校验**直接 `exit(1)`** | `ls assets/capsules/` = 14 个 svg，**无 discovery.svg**；图标单一事实源 `scripts/gen-capsule-icons.mjs:16-31` 的 `ICONS` 仅 14 项 | 改 `gen-capsule-icons.mjs` 加 `discovery` 槽位（`sales` 档）→ 跑 `node scripts/gen-capsule-icons.mjs` 生成 SVG |
| 2 | 🔴 | 原稿胶囊对象**缺 `prompts[]` / `inspirations[]`** → 三个消费脚本**无保护取用**、必崩 | `gen-capsule-form-cards.mjs:56-58`（`c.prompts.map` / `c.inspirations.length`）、`build-buddy-import-zip.mjs:174-197`（`c.prompts.map` / `inspirationIds: c.inspirations`）、`pack-buddy-import.mjs:47-55` 透传 | 按既有形状补 `prompts`（3 条）+ `inspirations`（3 条）；实测 14/14 既有胶囊均恰好 3/3 |
| 3 | 🔴 | 原稿 `skills:['discovery-run']` **越界** —— `capsules[].skills` / `workModes[].skills` 的值域是**已上架技能**（⊆ `connector/skills/`），**不是 MCP 工具名** | `tmp/_probe_t19.mjs`：全 manifest 14 个 skill id **全部 ∈ `connector/skills`（21 目录）**，violations=[]；而 `discovery-run` **不在**其中 | 改 `skills:['crm-native','crm-query','method-funnel-classification']`（对齐「管道看板」形状，`crm-native` 恒为首项）；**`workModes[销售坐席].skills` 不加任何项** |
| 4 | 🔴 | 原稿 Step 3 ③「`market.skills` 加同名 skill」**无效且加重既有不一致** | `pack-buddy-import.mjs:60-66` 打包时 **用 `readdirSync(connector/skills)` 覆盖** `market.skills` → manifest 那份**不进包**；且实测 `manifest.market.skills ⊄ connector/skills`（多 `method-decision-enrich`/`method-decision-execute`/`user-rbac-admin`，少 10 个）= **既有不一致** | **本 Task 不改 `market.skills`**；计划内记明理由（改无效果 + 越权扩大范围） |
| 5 | 🔴 | 计划只改 **1 份** `skills/crm-native/SKILL.md`，实际有 **4 份 byte-equal 副本** | `sha256sum` 四者全为 `1fe55b25…a1ba`（143 行）：`skills/`（`pack-crm-plugin.py:42 SRC_SKILLS_DIR` 权威源）、`.workbuddy-plugin/skills/`、`connector/skills/`（第三通道）、`plugin/skills/` | 四份**同内容**改；Step 8 用 PowerShell 断言 `Hash | Sort-Object -Unique` 计数 = 1 |
| 6 | 🔴 | 计划只改 **1 份** `.workbuddy-plugin/agents/crm-native.md`，实际有 **2 份 byte-equal 副本** | 两者 sha256 均为 `a170cf68…4b7a`：`.workbuddy-plugin/agents/`、`plugin/agents/` | 两份同内容改；Step 8 断言去重后计数 = 1 |
| 7 | 🔴 | 计划只改 **1 处** `verify-plugin-zips.py`（`expect_version`），**漏内容规则** → 「已上线但包里看不到」漂移原样复现 | 该文件既有模式明写（`:153-159`）：「2026-09-09 新增对外 MCP 工具：data-particle-update……**防漂移**」；不加规则则 SKILL.md 日后丢 discovery 行仍全绿 | 加 2 条规则：`("skill 含 discovery-run 自主发现路由", (r"discovery-run", True))`、`("skill 含线索发现写闸说明（两阶段 + 第0闸）", (r"两阶段", True))` |
| 8 | 🔴 | 计划只在门户加 `CAPS` 项，**不同步 `scripts/buddy-capsule-binding-check.mjs` 的 `BINDINGS` 表** → 门户 24→25 vs 校验表 24 条**静默分叉**，且 Step 7 跑该脚本**仍全绿（假绿）** | 该脚本是**表驱动硬编码**（`BINDINGS` 24 条，不读 manifest）；门户注释 + 文档均称「已通过 `scripts/buddy-capsule-binding-check.mjs` 校验」 | `BINDINGS` 加 `{ tab:'客户洞察', cap:'线索发现', skill:'discovery-run', targetAgent:'decision-agent', deterministic:true }`（实测 `agentSpec.js:78` decision-agent `skillCalls` 含 `discovery-run` → `routeThroughIntake` 原样保留） |
| 9 | 🟡 | **门户 `CAPS` 未指定落在哪个 tab** | 原稿只说「`CAPS` 对应 tab 加项」 | 裁定 **`客户洞察`**（线索发现=客户获取入口；与 BINDINGS 的 tab 对齐）；`targetAgent:'decision-agent'` 合法（门户既有 6 个之一） |
| 10 | 🟡 | `assets/capsules/index.html` 是**手维护预览页**（无生成器；`pack-buddy-import.mjs:73-77` 打包时**显式排除**）→ 文案「14 个场景胶囊」与卡片列表会过时 | `grep` 无生成器写该文件；`filter: (s) => !s.endsWith('index.html')` | 计数 14→15 + 销售坐席网格追加一卡（保持预览真实） |
| 11 | 🟡 | 门户↔校验表**既有 1 处名字漂移**（与本 Task 无关但会挡住新加的 parity 断言） | `tmp/_probe_t19b.mjs`：门户 label `客户拜访` vs 校验表 `cap: '客户调研'`（skill 序列 24/24 全一致，纯 label 漂移） | 校验表改 `客户拜访`（对齐产品面）；本 Task 顺手修正并记明 |
| 12 | 🟡 | `connector/connector-meta.json` 版本 bump **无任何自动校验** | `grep -n "connector" scripts/verify-plugin-zips.py` **0 命中** → Step 8 的 Expected 覆盖不到它 | Step 8 补人工核对：`Select-String -Path connector\connector-meta.json -Pattern '1\.6\.0'` |
| 13 | 🟡 | `connector-meta.json` 的 `examples_zh/en` 是**连接器市场可见面**，原稿只 bump version → 市场页缺失线索发现 | 该文件含 `description_zh` + `examples_zh`（5 条） | 各加 1 条 example（zh/en 对齐），保持对外面诚实 |
| 14 | 🟡 | **版本清单不止三处**：`plugin/openclaw.plugin.json` 与 `plugin/package.json` 同为 `1.7.1` | `grep '"version"'` 实测 3 个文件均为 `1.7.1`；`plugin/README.md:134`（1.5.0→1.6.0 那次）明文把 `openclaw.plugin.json` / `package.json` 列入改动清单 | 三处一起升 `1.8.0`；Step 8 断言 `1.8.0` 在 4 个文件（含 `verify-plugin-zips.py`）中命中 ≥4 |
| 15 | 🟡 | `plugin/README.md` 是随包 README 且**有逐版「同步说明 + 本包改动清单」惯例**（`:107-140`，1.5.0→1.6.0 一节） | 该文件被 `pack-crm-plugin.py:44 SRC_README` 打进 zip | 追加「2026-09-11 同步说明：线索发现」一节 + 改动清单表 |
| 16 | 🟡 | `test/ui/` **目录不存在**（新建）；vitest.config.js 无 `include` 限制 | `ls test/ui` 空；`vitest.config.js` 仅设 `environment/pool/fileParallelism` | 按计划新建 `test/ui/discoveryCapsule.test.js`（属「分发面契约」测试，与 `test/web/` 的页面遍历守护不同类） |

> **原稿正确项（保留固化）**：`.workbuddy-plugin/plugin.json` = `1.7.1` ✅；`connector/connector-meta.json` = `1.5.0` ✅；`verify-plugin-zips.py:129` `expect_version="1.7.1"` ✅；`:162` platform-admin `"1.1.1"` ✅（升 1.2.0 归 **Task 21**）；两个 pack 脚本均支持 `--out` ✅。

- [ ] **Step 1: Write the failing test**

```js
// test/ui/discoveryCapsule.test.js
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';

const manifest = JSON.parse(readFileSync('buddy-crm-manifest.json', 'utf8'));
const portal = readFileSync('src/web/buddy-crm-portal.html', 'utf8');
const check = readFileSync('scripts/buddy-capsule-binding-check.mjs', 'utf8');
const UPLOADED = new Set(readdirSync('connector/skills'));   // 已上架技能 = 场景「绑定技能」合法值域
const CAPS = manifest.home.workModes.flatMap((m) => m.capsules || []);
const TARGET = '线索发现';

describe('buddy 线索发现胶囊（T19）', () => {
  it('① manifest 有「线索发现」胶囊且形状完整（prompts/inspirations 非空）', () => {
    const cap = CAPS.find((c) => c.name === TARGET);
    expect(cap, TARGET).toBeTruthy();
    expect(cap.en).toBe('Lead Discovery');
    expect(cap.expert).toBe('AI 原生销售管理助手');
    expect(Array.isArray(cap.prompts) && cap.prompts.length > 0).toBe(true);
    expect(Array.isArray(cap.inspirations) && cap.inspirations.length > 0).toBe(true);
    expect(cap.systemPrompt).toContain('discovery-run');   // MCP 工具名落在 prompt，不落 skills
  });

  it('② 图标文件真实存在（pack-buddy-import 的 MISSING ICONS 硬闸）', () => {
    const cap = CAPS.find((c) => c.name === TARGET);
    expect(cap.icon).toBe('assets/capsules/discovery.svg');
    expect(existsSync(cap.icon), cap.icon).toBe(true);
  });

  it('③ 全 manifest 场景/模式 skills ⊆ 已上架技能（值域不变量）', () => {
    const viol = [];
    for (const w of manifest.home.workModes) {
      for (const s of w.skills || []) if (!UPLOADED.has(s)) viol.push(`${w.name}:${s}`);
      for (const c of w.capsules || []) {
        for (const s of c.skills || []) if (!UPLOADED.has(s)) viol.push(`${c.name}:${s}`);
      }
    }
    expect(viol).toEqual([]);
  });

  it('④ 门户 CAPS 在「客户洞察」tab 含 discovery-run（MCP 工具名 + 合法 targetAgent）', () => {
    const seg = portal.slice(portal.indexOf('"客户洞察": ['), portal.indexOf('"商机推进": ['));
    expect(seg).toContain('discovery-run');
    expect(seg).toContain('decision-agent');
  });

  it('⑤ 门户每个 CAPS label 都有 BINDINGS 行（防「加了 CAPS 却没进校验表」静默分叉）', () => {
    const labels = [...portal.matchAll(/\{ label: "([^"]+)"/g)].map((m) => m[1]);
    const caps = [...check.matchAll(/cap: '([^']+)'/g)].map((m) => m[1]);
    expect(labels.filter((l) => !caps.includes(l))).toEqual([]);
    expect(check).toContain("cap: '线索发现'");
    expect(check).toContain("skill: 'discovery-run'");
  });
});
```

- [ ] **Step 2: Run** → FAIL（胶囊/图标/绑定行均缺）

```powershell
npx vitest run test/ui/discoveryCapsule.test.js
```

- [ ] **Step 3: 图标（先改单一事实源，再生成）** — `scripts/gen-capsule-icons.mjs` 的 `ICONS` 加一项（`sales` 档配色，与「客户360」同档）：

```js
  'discovery': ['sales', `<circle cx="28" cy="28" r="11"/><path d="M36 36l11 11"/><path d="M44 12v8M40 16h8"/>`],
```

```powershell
node scripts/gen-capsule-icons.mjs
```

Expected: `generated 15 capsule icons -> assets/capsules/ | 3 mode icons -> assets/modes/`

- [ ] **Step 4: `buddy-crm-manifest.json`** — 只在 **`home.workModes[销售坐席]`（`id`/`name` 为「销售坐席」）的 `capsules[]` 末尾**追加（**不动** `workModes[].skills`、**不动** `market.skills`）：

```json
{
  "name": "线索发现",
  "en": "Lead Discovery",
  "icon": "assets/capsules/discovery.svg",
  "expert": "AI 原生销售管理助手",
  "skills": ["crm-native", "crm-query", "method-funnel-classification"],
  "systemPrompt": "调用 discovery-run 运行一次线索自主发现：按本租户 ICP（行业/规模/地域/招聘信号/融资轮次）扫描已启用数据源，输出候选线索池（ICP 适配分 + 信号 + why_narrative）。缺口字段走 discovery-enrich 瀑布富集；需要深度画像时走 discovery-research。全部只读展示，不自动外联、不自动发信；写入 CRM 须走两阶段（先取表单再确认）并带 decision_id（决策第 0 闸）。\n\n【方法论内核】\n【编排】先识别意图（查询 / 写入 / 风险 / 方法论），再分发到对应能力；意图不明时先向用户澄清再执行，不臆测。\n【大漏斗分类】客户分三类：商机客户（已有在跟商机）、目标客户（有明确意向待开发）、潜力客户（画像匹配但未接触）。按类确定接触节奏与资源投入。\n【事实 vs 话术】严格区分可验证证据（有记录 / 有文件 / 第三方佐证）与口头表述；外部抓取字段须标来源与置信度，低置信不冒充已验证。",
  "prompts": [
    "运行一次线索自主发现，输出候选线索池（ICP 适配分 + 信号 + 理由），按适配分排序",
    "这家候选线索为什么被判定匹配我们的 ICP？给出信号证据与缺口字段",
    "对这条线索做一次深度研究，补齐规模、融资、关键人信息并标注来源"
  ],
  "inspirations": ["ICP 适配分排序", "缺口字段才付费富集", "低置信不冒充已验证"]
}
```

- [ ] **Step 5: `src/web/buddy-crm-portal.html`** — 在 `CAPS["客户洞察"]` 数组末尾加项（`skill` = MCP 工具名；`targetAgent` 取注册表 6 key 之一）：

```js
{ label: "线索发现", skill: "discovery-run", targetAgent: "decision-agent",
  prompt: "调用 discovery-run 运行线索自主发现，输出候选线索池（ICP 适配分/信号/why_narrative），只读展示，不自动外联。" }
```

- [ ] **Step 6: `scripts/buddy-capsule-binding-check.mjs`** — ① 在 `BINDINGS` 的「客户洞察」组末尾加行；② 顺手修既有漂移 `cap: '客户调研'` → `cap: '客户拜访'`（对齐门户 label）：

```js
  { tab: '客户洞察', cap: '线索发现', skill: 'discovery-run', targetAgent: 'decision-agent', deterministic: true },
```

- [ ] **Step 7: 文档副本同步（4 份 SKILL.md + 2 份 agents md，内容必须完全一致）**

① **Action 写清单表**加三行（紧接 `crm-import-batch` 行之后）：

```markdown
| `discovery-run` / `discovery-enrich` / `discovery-research` | 线索自主发现三段（发现→富集→研究）：外部数据只落 payload 事实字段 + `sourcedFrom` 弱边；写主数据走**两阶段**（先取表单再确认）+ **第 0 闸** `decision_id`（`LEAD_FIT` 场景）；`human_gate`（不进 autonomous 白名单） |
```

② **`.workbuddy-plugin/agents/crm-native.md` 的「一句话能力映射」表**加一行：

```markdown
| "帮我找找符合我们画像的新线索 / 这批候选线索按适配分排一下" | `discovery-run`（ICP 适配分 × 信号扫描，候选池只读展示；补齐走 `discovery-enrich`，深研走 `discovery-research`） |
```

> 改完后 `skills/` 与 `.workbuddy-plugin/skills/` 与 `connector/skills/` 与 `plugin/skills/` 四份、`.workbuddy-plugin/agents/` 与 `plugin/agents/` 两份必须 **byte-equal**（Step 8 有断言）。

- [ ] **Step 8: 版本清单（5 处一次改齐）+ verify 规则 + README**

① `.workbuddy-plugin/plugin.json` `1.7.1→1.8.0`；② `plugin/openclaw.plugin.json` `1.7.1→1.8.0`；③ `plugin/package.json` `1.7.1→1.8.0`；④ `connector/connector-meta.json` `1.5.0→1.6.0` + `examples_zh`/`examples_en` 各加一条（`"帮我找找符合我们画像的新线索，按 ICP 适配分排序"` / `"Find new leads that match our ICP profile, ranked by fit score"`）；⑤ `scripts/verify-plugin-zips.py:129` `expect_version="1.7.1"` → `"1.8.0"`，并在 `check_zip(...)` 的 `content_rules` 末尾加 2 条：

```python
        # 2026-09-11 新增对外 MCP 工具：discovery-*（线索自主发现，防「已上线但包里看不到」漂移）
        "skill 含 discovery-run 自主发现路由": (r"discovery-run", True),
        "skill 含线索发现写闸说明（两阶段 + 第0闸）": (r"两阶段", True),
```

⑥ `plugin/README.md` 追加一节（沿用 1.5.0→1.6.0 那节的格式）：标题「## 2026-09-11 同步说明：线索自主发现（discovery-*）」+「**版本 1.7.1 → 1.8.0。**」+ 新增能力说明（三动作 + `human_gate` + `LEAD_FIT` 第 0 闸）+ **本包改动清单**表（列 `skills/crm-native/SKILL.md`、`agents/crm-native.md`、四处版本文件）。

- [ ] **Step 9: 重新打包并校验**

```powershell
python scripts/pack-crm-plugin.py --out plugin/crm-native-plugin.zip
python scripts/pack-platform-admin-plugin.py --out plugin-platform-admin.zip
node scripts/build-buddy-import-zip.mjs
python scripts/verify-plugin-zips.py
```

Expected: `version = 1.8.0` / `1.1.1` 均 OK；2 条新 discovery 内容规则 `ok`（命中 SKILL.md）；无 `bad`。

- [ ] **Step 10: 副本一致性 + 版本清单人工核对（脚本覆盖不到的部分）**

```powershell
# ① 四份 SKILL.md byte-equal → 期望输出 1
(Get-FileHash skills\crm-native\SKILL.md, .workbuddy-plugin\skills\crm-native\SKILL.md, connector\skills\crm-native\SKILL.md, plugin\skills\crm-native\SKILL.md -Algorithm SHA256).Hash | Sort-Object -Unique | Measure-Object | Select-Object -ExpandProperty Count
# ② 两份 agents/crm-native.md byte-equal → 期望输出 1
(Get-FileHash .workbuddy-plugin\agents\crm-native.md, plugin\agents\crm-native.md -Algorithm SHA256).Hash | Sort-Object -Unique | Measure-Object | Select-Object -ExpandProperty Count
# ③ 版本 1.8.0 命中 4 个文件（plugin.json / openclaw.plugin.json / package.json / verify-plugin-zips.py）→ 期望 4
Select-String -Path .workbuddy-plugin\plugin.json, plugin\openclaw.plugin.json, plugin\package.json, scripts\verify-plugin-zips.py -Pattern '1\.8\.0' | Measure-Object | Select-Object -ExpandProperty Count
# ④ connector 版本（verify 不覆盖，人工核对）→ 期望含 1.6.0
Select-String -Path connector\connector-meta.json -Pattern '"version": "1\.6\.0"'
# ⑤ 残留 1.7.1 应为 0 命中（排除 docs/ 与 tmp/）
Select-String -Path .workbuddy-plugin\plugin.json, plugin\openclaw.plugin.json, plugin\package.json, scripts\verify-plugin-zips.py -Pattern '1\.7\.1'
```

- [ ] **Step 11: Run 测试**

```powershell
npx vitest run test/ui/discoveryCapsule.test.js
node scripts/buddy-capsule-binding-check.mjs
```

Expected: 5/5 绿；绑定校验 `胶囊绑定总数: 25 | 通过: 25 | 失败: 0`。

- [ ] **Step 12: Commit（按功能线分三条）**

```powershell
git add buddy-crm-manifest.json src/web/buddy-crm-portal.html scripts/buddy-capsule-binding-check.mjs scripts/gen-capsule-icons.mjs assets/capsules/discovery.svg assets/capsules/index.html test/ui/discoveryCapsule.test.js
git commit -m "feat(discovery): buddy lead-discovery capsule (manifest + portal CAPS + binding check + icon)"

git add skills/crm-native/SKILL.md .workbuddy-plugin/skills/crm-native/SKILL.md connector/skills/crm-native/SKILL.md plugin/skills/crm-native/SKILL.md .workbuddy-plugin/agents/crm-native.md plugin/agents/crm-native.md
git commit -m "docs(discovery): sync discovery-* into 4 SKILL.md copies + 2 agent faces (byte-equal)"

git add .workbuddy-plugin/plugin.json plugin/openclaw.plugin.json plugin/package.json connector/connector-meta.json scripts/verify-plugin-zips.py plugin/README.md plugin/crm-native-plugin.zip
git commit -m "chore(plugin): bump crm-native 1.8.0 / connector 1.6.0 + 3 anchored anti-drift rules"
```

> ⚠ **打包产物是否入库**：`plugin/crm-native-plugin.zip` 历史上随版本提交（见 `docs/2026-09-09-nightly-audit-report.md:66` 的核对记录）。若用户在本地核对后认为不入库，从第 3 条 `git add` 中删去 `plugin/crm-native-plugin.zip` 即可。
> ⚠ `plugin-platform-admin.zip`（仓库根）本 Task **零改动** → 不入 commit（重打包会因 `--out` 传无目录路径而报错，见 D18）。

### 执行期新增发现（4 项，🔴 1 + 🟡 3 —— 已落地并验证）

| # | 级别 | 发现 | 证据 | 处置（已执行） |
|---|---|---|---|---|
| D17 | 🔴 | **`src/mcp/server.js` 从不注册 discovery 族** —— `buildMcpTools()` 只调 `seedActions()`，而 discovery-* 由独立的 `seedDiscoveryActions()` 注册（调用方仅 `agents.js:70` / `routes.js:495`，两者都只挂在 Express 进程）；**独立 MCP 进程（`npm run mcp:http\|stdio`）里三个动作从未注册** | 修前 `node scripts/buddy-capsule-binding-check.mjs` → `MCP 暴露工具总数: 57`，`[客户洞察/线索发现] skill=discovery-run \| mcp-tool=false\|registry=false`（绑定 24/25） | 在 **MCP 暴露面唯一咽喉** `src/mcp/tools.js:buildMcpTools` 内改为 `if (seed) { seedActions(); seedDiscoveryActions(); }`（+import）。修后 `MCP 暴露工具总数: 60`、绑定 **25/25 通过** |
| D17-注 | — | **连带结论**：T18 的「经 MCP 列表对外暴露」断言此前是**假绿** —— 单测在 `beforeAll` 里显式 `seedDiscoveryActions()`，掩盖了真实进程未注册；同样地 Task 20 的「真实 MCP stdio 调 discovery-run」若不带上本修复必然失败 | 同上 | 已在 Task 18 节补注（`src/mcp/tools.js` **需改**，非「无需改逻辑」） |
| D18 | 🟡 | `pack-platform-admin-plugin.py --out plugin-platform-admin.zip` **报错**（`FileNotFoundError: ''`）—— `os.makedirs(os.path.dirname(out), ...)`，无目录的相对路径 dirname 为空串 | 实跑 traceback（脚本 `:96`） | 正确用法：**省略 `--out`**（`DEFAULT_OUT = <repo>/plugin-platform-admin.zip`，正是 `verify-plugin-zips.py:163` 读取的位置）；本 Task platform-admin 零改动 → 跳过重打包。Step 9 已更正 |
| D19 | 🟡 | `verify-plugin-zips.py` 的 `content_rules` **命中即 `break`、无路径锚定** → 「想校验 SKILL.md」的规则会被 `agents/crm-native.md` / `plugin.json` 抢先满足，目标文件丢内容仍全绿 | 首轮实测：`skill 含 discovery-run 自主发现路由  (agents/crm-native.md)`（非 SKILL.md，且**规则名写着 skill**） | 给规则加**可选第三元素路径锚定** `(pattern, should_exist, path_filter?)`（向后兼容，既有 16 条规则零改动）；3 条新规则分别锚定 `skills/crm-native/SKILL.md` ×2 + `agents/crm-native.md` ×1。**变异测试证明鉴别力**：删 SKILL.md 的 discovery 行 → 重打包 → `rc=1` 且该规则 `[FAIL]（锚定路径 skills/crm-native/SKILL.md）`；还原后 `rc=0` 全绿 |

```powershell
# Step 9（更正后）
python scripts/pack-crm-plugin.py --out plugin/crm-native-plugin.zip
# platform-admin：本 Task 零改动；且 --out 传无目录相对路径会崩 → 直接跳过（或省略 --out 走 DEFAULT_OUT）
node scripts/build-buddy-import-zip.mjs
python scripts/verify-plugin-zips.py
```

---
## Task 20: 触点面端到端验收（HTTP + MCP 双通道）

> 项目铁律：**单测全绿 ≠ 链路通**。本 Task 用真实实例 + 真实 MCP stdio 验证四条触点面真的通了（范式见 `scripts/e2e-dialog-advice.mjs`）。
>
> ⚠ **本节的断言全部来自 2026-09-11 实测**（起真实实例 + 真实 stdio 逐条打真实响应），非书面推导。原稿 5 条 🔴 断言与真实行为**相反**，照抄必红或假绿，详见下方「契约事实」。

**Files:**
- Create: `scripts/e2e-discovery-touchpoints.mjs`（自起实例 + 真实 MCP stdio）

**契约事实（实测，不得凭印象改）:**

| 位置 | 真实行为 |
|---|---|
| `GET /api/config/discovery-rules` 未登录 | `401 {error:'未登录'}`（全局 auth 中间件先拦，**不是 403**） |
| 同上 · `admin` | `404 {error:'config discovery-rules 未配置'}` —— 端点**只回退 404，不回退出厂默认**（出厂默认兜底在 `discoveryRules.js:64` 的读路径，不在端点） |
| 同上 · `alice(sales)` | `403 {error:'租户级配置仅 tan_admin/sysadmin/ADMIN 可访问'}` |
| `PUT` 缺 `icp/providers/signals` | `400 {error:'discovery-rules 缺结构键: icp,providers,signals'}`（`routes.js:232` 前置校验） |
| `PUT` 完整结构 | `200 {key,value,decision,updated:true}` —— **`decision` 恒为 `null`**（`configRouter.js:26-34`：`requireDecision` 抛错 → catch 降级记录事件 → `decisionId:null, ok:true`）。**只可断言「含 `decision` 键」，不可断言非空** |
| 写作用域 | `admin` 的 `tenant_id='system'` → PUT 写 `(system,'discovery-rules')`；GET 读 `scopeTenant(admin)='*'` → `configStore.js:19` 通配回退 system ⇒ **PUT/GET 同键，round-trip 成立**（须用**深比较**，`JSON.stringify` 会因键序误判不等） |
| ⚠ 副作用 | 步骤②的 PUT **真写** `config_store(system,'discovery-rules')`，且**禁 DELETE 不可回滚**。写入值必须**等于 `DEFAULT_DISCOVERY_RULES`**（语义零变更），且 GET 断言须**幂等**（首跑 404、复跑 200 均合法）。脚本注释须显式声明 |
| `GET /api/discovery/candidates` 未登录 | `403 {error:'auth required'}` —— 字段是 `error`、值是 `auth required`（**下划线形态 `auth_required` 仅存在于 MCP 通道**） |
| 登录后 | `200 {items:[]}`（`crm_native_test` 无 `CRM_ACCOUNT` 粒子，空数组合法） |
| `/discovery.html`、`/discovery-rules.html` | `200 text/html`（无鉴权，静态面） |
| MCP `discovery-run` **无 token** | `{ok:false, gate:'auth_required', error, hint}` —— **负向基准**，证明闸门真拦 |
| MCP `discovery-run` **有 token、无 confirm_token** | `{ok:true, confirm_token:'ct_…', advice, form:{code:'CONFIRM_REQUIRED', action, kind:'write', decision_id:'<uuid>', switch_options, …}}` —— 声明 `decisionScenario='LEAD_FIT'` → `gateway.js:165` 代为 mint（`crm.decision_scenario` 已有该行）→ 产证成功 |
| ⚠ 陷阱 | `gate='confirm_required'` **全仓 0 命中**；`confirm` 语义在**写通道**体现为 `ok:true` + `form.code='CONFIRM_REQUIRED'`（敏感读通道才是 `ok:false` + 顶层 `code`）。断言「`ok!==true`」与真实相反 |
| ⚠ 陷阱 | 脚本若**静态** import 任一 `src/` 模块（如 `DEFAULT_DISCOVERY_RULES`），ESM 提升会让 `src/db.js` 在 `PGDATABASE` 赋值前初始化 → **连生产库 `crm_native`**（实测已打印该警告）。必须**先设 `process.env.PGDATABASE` 再动态 `await import()`** |
| ⚠ 陷阱 | 3000/3100/3211 已被本项目实例占用，**硬编码端口必 EADDRINUSE**（实测）；且外部手动起实例不可复现 → 脚本内 **spawn + 动态选空闲端口 + 就绪轮询 + 结束时 kill** |

- [ ] **Step 1: 脚本自起隔离实例** —— `spawn(process.execPath, ['src/http/server.js'], { env: { ...process.env, PORT: String(port), PGDATABASE: 'crm_native_test' }, cwd: repoRoot })`；`port` 由 `net.createServer().listen(0)` 动态取空闲端口（避让 3000/3100）；轮询 `/discovery.html` 至 `200/404`（40×500ms 超时，超时打印子进程日志并退出 1）；`finally` 中 `child.kill()`（改 `src/` 后为防旧代码假绿，实例必须由本脚本新建）

- [ ] **Step 2: HTTP 后台配置面**（7 条）
  ① 未登录 GET → `401`；
  ② `admin` GET → **`200` 或 `404` 均合法**（幂等：首跑未配置=404，复跑=200；200 时 `value` 须含 `icp`/`providers`/`signals`）；
  ③ `alice` GET → `403`；
  ④ PUT 仅 `{value:{playbooks:[]}}` → `400` 且 `error` 含 `icp`；
  ⑤ PUT `{value: structuredClone(DEFAULT_DISCOVERY_RULES)}` → `200`、`updated===true`、响应**含 `decision` 键**（值可为 `null`，勿断言非空）；
  ⑥ GET → `assert.deepStrictEqual(get.value, putBody.value)`（**深比较**，禁 `JSON.stringify` 比对）；
  ⑦ 复跑 PUT 同值 → `200 updated===true`（幂等）

- [ ] **Step 3: HTTP 前台面**（4 条）
  ① 未登录 GET `/api/discovery/candidates` → `403` 且 `json.error==='auth required'`（**精确等值，非 `auth_required`**）；
  ② `alice` login 后 GET → `200` 且 `Array.isArray(json.items)`；
  ③ GET `/discovery.html` → `200` + `content-type` 含 `text/html`；
  ④ GET `/discovery-rules.html` → `200` + `text/html`

- [ ] **Step 4: MCP 工具面**（5 条，stdio 起 `src/mcp/server.js --stdio`）
  ① `tools/list` 含 `discovery-run`/`discovery-enrich`/`discovery-research`（三项逐个断言，不只看总数）；
  ② `discovery-run`（`seed:{name,domain}`）**无 `api_token`** → 断言 `ok===false && gate==='auth_required'`（**负向基准：判据必须 `ok!==true`，只判 `gate` 字段存在会假绿**）；
  ③ `crm_login(alice)` → `ok===true && token` 非空；
  ④ `discovery-run` **带 token、不带 `confirm_token`** → 断言 `ok===true && typeof confirm_token==='string' && form.code==='CONFIRM_REQUIRED' && form.decision_id` 非空（**第 0 闸真 mint 成功的唯一证据**）；
  ⑤ `discovery-enrich`（`account_id:'e2e-probe'`）与 `discovery-research`（`account_id:'e2e-probe', brief:'x'`）同 ④ 判据（两条独立断言）；
  > 收尾 `await client.close()` 放 `finally`；MCP 统一 `unpack()`（非法 JSON → `{ok:false, raw}`），**不得 `!!payload` 即判通过**。

- [ ] **Step 5: buddy 绑定 + 插件包（子进程真跑，断言退出码）**
  ① `node scripts/buddy-capsule-binding-check.mjs` → `rc===0`；
  ② `python scripts/verify-plugin-zips.py` → `rc===0`

- [ ] **Step 6: 汇总** —— `process.exit(failed.length ? 1 : 0)`；失败项逐条打印名称 + detail（范式同 `e2e-dialog-advice.mjs:179-186`）

- [ ] **Step 7: Commit**

```powershell
git add scripts/e2e-discovery-touchpoints.mjs
git commit -m "test(discovery): e2e acceptance for all four touchpoints (HTTP + MCP stdio)"
```

> ⚠ **运行副作用声明（须写入脚本头部注释）**：本脚本会向 `crm_native_test` 写入 ① `config_store(system,'discovery-rules')` = 出厂默认结构（幂等，禁 DELETE 不可回滚，语义等价）；② 每次 MCP phase1 调用经第 0 闸 mint 各 1 条决策 + memory 记录。均落测试库；实测生产库 `crm_native` 该键 **0 行**（安全）。

---

## Task 21: 行业包扩展 handbook 同步（v8.1 §12 新增）

> **派发前源码级复查消解（2026-09-11，18 项缺陷 / 8 🔴，均实测证实）**
> | 级 | 缺陷 | 实测证据 → 修法 |
> |---|---|---|
> | 🔴 | 测试用 `readdirSync('db/seed')` 全量 glob → 命中 **8** 份模板（含**未跟踪**的 `tenant-profile-manufacturing.js`，属另一功能线），计划只列 7 份 → 照抄必因第 8 份无 discovery 段而 RED | `readdirSync` 实测 8 项 → 改**显式白名单**（与 `db/seed/tenant-profile-templates.mjs:16-23` 的 `SPECS` 同源 7 项） |
> | 🔴 | `providers: { attio: true }` 是**对象**；真实 schema 是**数组** `[{id,kind,scope,costTier,enabled}]` → `mergeDiscoveryRules:52` 的 `Array.isArray()` 为 false ⇒ **整段静默丢弃**（写入等于没写 = 假绿） | 改 `providers: [{ id:'attio', enabled:true }]` |
> | 🔴 | `signals: { funding_round: 1.0 }` 是**数字**；真实 schema 是 `{weight:n}` → `mergeDiscoveryRules:50` 的 `Object.assign` 用数字**覆盖掉对象** ⇒ 消费方 `.weight === undefined` | 改 `{ funding_round: { weight: 1.0 } }` |
> | 🔴 | `icp: { headcount:{min}, regions:[] }` 是**臆造键**（`discoveryRules.js:11-16` 真实字段为 `industries` / `min_headcount`(number) / `geo`(array) / `min_confidence`） | 对齐真实字段名 |
> | 🔴 | `playbooks: ['chem-default']` 是**字符串数组**；真实 schema 是对象数组 `{name,data[],match,ai[],action[]}`（`orchestrationCompiler.js:13` 无名即 throw；`:25` `selectPlaybook` 按 `.name` 取默认项） | 改对象数组，每项含 `name` |
> | 🔴 | `git add dist/buddy-import/industry-config.json` **必失败** | `.gitignore:3` = `dist/` → 该产物不入库；改为「重生成（不入库）」 |
> | 🔴 | `git add .workbuddy/skills/new-industry-onboarding/SKILL.md` **必失败** | `.gitignore:134` = `.workbuddy/` → 该文件是**本地运行时技能**，不入库；修改有效但须从 commit 清单移除 |
> | 🔴 | 「重生成」命令错：`gen-industry-config-variants.mjs` 只写 `dist/buddy-import/variants/`，**不产** `industry-config.json` | 正确入口 = `node scripts/pack-buddy-import.mjs`（读 `buddy-crm-manifest.json` → 产 `dist/buddy-import/industry-config.json`） |
> | 🔴 | `python scripts/pack-platform-admin-plugin.py --out plugin-platform-admin.zip` **必崩**（`pack-platform-admin-plugin.py:96` `os.makedirs(os.path.dirname('plugin-platform-admin.zip'))` = `makedirs('')`） | **省略 `--out`**（`DEFAULT_OUT` = 仓库根 `plugin-platform-admin.zip`，与 verify 读取路径一致） |
> | 🔴 | 测试要求**本地侧** SKILL 含 `Step 4B` / `Step 4\.5` —— 本地侧结构为 `Step 1..9`（`## 2.`–`## 15.`），**从未有 4B/4.5**（grep 零命中）；照抄必 RED，且不该为此**臆造**对齐（两文档本非同构） | 本地侧断言降为 `Step 4C` + `discovery-rules` + `付费源` + `system-candidate` + `第0闸`；`Step 4B`/`Step 4\.5` 断言**仅留平台侧**（该处真实存在） |
> | 🟡 | `scripts/verify-plugin-zips.py:162` 行号错（实际 `:176`）；3 条新规则未用 T19 的**路径锚定** → 会被 `README.md` / `agents/platform-admin.md` 抢先满足而假绿 | 行号更正 + 第三元素锚定 `skills/industry-onboarding/SKILL.md`（zip 内实测存在该路径，12 项之一） |
> | 🟡 | platform-admin 版本为**三处**同 `1.1.1`（`.codebuddy-plugin/plugin.json` / `openclaw.plugin.json` / `package.json`），计划只提一处 | 三处一并升 `1.2.0`（对齐 T19 对 crm 包的处理） |
> | 🟡 | `verify-plugin-zips.py:15` docstring 仍写「platform-admin 须含 Step 4B / Step 4.5」 | 补 `Step 4C` |
> | 🟡 | Step 4C 拟用编号 `## 4.6` 与文件既有编号（`## 5. Step 4B` → `## 4.5 Step 4.5`）冲突，插在 4B 与 4.5 之间会得 `5 → 4.6 → 4.5`（更乱） | 平台侧用 `## 5.5 Step 4C`（得 `5 → 5.5 → 4.5`） |
> | 🟡 | `db/seed/tenant-profile-templates.mjs:28` 以哨兵租户 `__tp_tpl_src__` 调 7 个 seed，末尾仅清 `tenant-profile` 键 → 新增的 discovery 写入会**残留**一条哨兵行 | 不碰既有 DELETE（红线）；改给 7 个 seed 加 `opts.withDiscovery !== false`（默认 true）守卫，templates 处传 `{ withDiscovery: false }` → **零残留、零 DELETE、向后兼容** |
> | 🟡 | 三面分叉：`docs/runbooks/2026-09-03-new-industry-onboarding.md`（**tracked**，246 行，无 `Step` 标签）是第三面，Task 21 **不更新** | **声明为已知分叉**（不擅自扩范围）；建议后续 Task 补 |
> | 🟡 | T19 已交付的 commit 清单含 `plugin/crm-native-plugin.zip`，但 `.gitignore:15` = `*.zip` 且 `git log --all -- "*.zip"` 为空（**从未跟踪**）→ 该 `git add` 会报 ignored | **本期更正声明**：`plugin/*.zip`、`plugin-platform-admin.zip` **一律不入库**（T19 第 4 条 add 请删去 zip 路径） |
> | 🟡 | `industry-config.json` 的 `version:'1.0.0'` 是**导入格式版本**（`pack-buddy-import.mjs:36` 硬编码），非内容版本 | **不 bump**（避免触发平台侧未知版本校验）；只重生成内容（含 T19 新增胶囊） |

**Files:**
- Modify: `plugin-platform-admin/skills/industry-onboarding/SKILL.md`（Step 4B 之后、Step 4.5 之前插入 **Step 4C**）
- Modify: `plugin-platform-admin/skills/industry-onboarding/registry.json`（`version` 1.0.0 → 1.1.0）
- Modify: `plugin-platform-admin/.codebuddy-plugin/plugin.json`（`version` 1.1.1 → 1.2.0）
- Modify: `plugin-platform-admin/openclaw.plugin.json`（`version` 1.1.1 → 1.2.0）
- Modify: `plugin-platform-admin/package.json`（`version` 1.1.1 → 1.2.0）
- Modify: `.workbuddy/skills/new-industry-onboarding/SKILL.md`（**本地运行时技能，`.gitignore:134` 不入库**）
- Modify: `docs/runbooks/2026-09-03-new-industry-onboarding.md`（**第三面，tracked**；新增 `## 4.5 Step 4C` + §9 清单 2 条 + §8 回归命令）
- Create: `db/seed/discovery-rules-templates.js`（**纯模块**，7 行业 discovery 配置单源；零 DB import ⇒ 单测无 PG 耦合）
- Modify: `db/seed/tenant-profile-{chemical,consult,consult2,demo,insmedi,meddev,training}.js` ×7（新增 `seed<X>Discovery` + `seed<X>Profile(tenantId, opts)` 守卫）
- Modify: `db/seed/tenant-profile-templates.mjs`（`fn(TMP, { withDiscovery: false })`，防哨兵残留）
- Modify: `scripts/verify-plugin-zips.py:176`（`expect_version` 1.1.1 → 1.2.0 + 3 条**锚定**内容规则 + `:15` docstring）
- Create: `test/connectors/discovery/industryDiscovery.test.js`、`test/config/industryTemplateDiscovery.test.js`

**关键设计约束（§12.3）**：`discovery` 段**独立落 `discovery-rules` 键**，**绝不写入 `tenant-profile`** —— 保证 `mergeProfile` 合并结果形状不变，`resolvePrototype`（`src/particles/particleModel.js:338`）/ `isControlledPredicateConfig`（`:362`）/ `runProfileCalculations`（`src/calc/formulaEngine.js:32`）三消费点 **byte-equal 零回归**。

**Step 1（RED）** — 先写两个失败测试

写入形状铁律（**这是本 Task 的核心风险点**）：`mergeDiscoveryRules(base, tenantCfg)`（`src/config/discoveryRules.js:47-60`）**只认**以下形状，写错一律**静默丢弃**（无异常、无日志 ⇒ 假绿）：
```
icp        浅合并 → 键名必须 ∈ {industries, min_headcount, geo, min_confidence}
signals    浅合并 → 每项必须是 { weight: <number> }（写数字会把对象整个换掉）
providers  Array.isArray() 为真才处理，且仅**覆盖既有 id**（不增删条数，防租户越权新增付费源）
playbooks  Array.isArray() 为真才处理 → 每项必须是有 name 的对象（compilePlaybook 无名即 throw）
```

```js
// test/config/industryTemplateDiscovery.test.js
// §12.3 行业模板 discovery 段：形状有效性 + 付费源铁律 + 键分离（纯单测，零 PG）
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { mergeDiscoveryRules, DEFAULT_DISCOVERY_RULES } from '../../src/config/discoveryRules.js';
import { DISCOVERY_RULES_BY_INDUSTRY } from '../../db/seed/discovery-rules-templates.js';

// ⚠ 显式白名单（与 db/seed/tenant-profile-templates.mjs 的 SPECS 同源 7 项）
//    **不得**用 readdirSync 全量 glob —— db/seed 下另有未跟踪的 tenant-profile-manufacturing.js（另一功能线）
const TEMPLATES = ['chemical', 'consult', 'consult2', 'demo', 'insmedi', 'meddev', 'training'];
const seedPath = (f) => `db/seed/tenant-profile-${f}.js`;

describe('行业模板 discovery 段（§12.3）', () => {
  it('① 白名单 7 项与实际文件一一对应（防"新模板漏配"）', () => {
    expect(TEMPLATES.length).toBe(7);
    for (const f of TEMPLATES) expect(existsSync(seedPath(f)), f).toBe(true);
    expect(Object.keys(DISCOVERY_RULES_BY_INDUSTRY).sort()).toEqual([...TEMPLATES].sort());
  });

  it('② 每份模板的 discovery 配置经真实 mergeDiscoveryRules 后形状有效（防静默丢弃）', () => {
    for (const f of TEMPLATES) {
      const cfg = DISCOVERY_RULES_BY_INDUSTRY[f];
      expect(cfg, f).toBeTruthy();
      const merged = mergeDiscoveryRules(DEFAULT_DISCOVERY_RULES, cfg);
      // providers：仍是数组，条数不变（仅覆盖既有 id）
      expect(Array.isArray(merged.providers), f).toBe(true);
      expect(merged.providers.length, f).toBe(DEFAULT_DISCOVERY_RULES.providers.length);
      // signals：每一项必须仍是 { weight:number }（写数字会覆盖对象 → .weight === undefined）
      for (const [name, v] of Object.entries(merged.signals)) {
        expect(typeof v?.weight, `${f}.signals.${name}`).toBe('number');
      }
      // playbooks：每项必须有 name（compilePlaybook 前置）
      expect(Array.isArray(merged.playbooks), f).toBe(true);
      for (const pb of merged.playbooks) expect(typeof pb?.name, f).toBe('string');
    }
  });

  it('③ 出厂默认不被污染（纯函数无副作用）', () => {
    expect(JSON.stringify(DEFAULT_DISCOVERY_RULES.playbooks)).toBe('[]');
    expect(DEFAULT_DISCOVERY_RULES.icp.min_headcount).toBe(50);
  });

  it('④ 付费源铁律（D1）：模板不得声明付费源，且合并后付费源恒 enabled:false', () => {
    for (const f of TEMPLATES) {
      const src = readFileSync(seedPath(f), 'utf8');
      // 声明期即禁：模板里连付费源的名字都不该出现（比"enabled 不为 true"更强）
      expect(src, f).not.toMatch(/clearbit|linkedin/i);
      const merged = mergeDiscoveryRules(DEFAULT_DISCOVERY_RULES, DISCOVERY_RULES_BY_INDUSTRY[f]);
      for (const p of merged.providers.filter((x) => x.scope === 'paid')) {
        expect(p.enabled, `${f}.${p.id}`).toBe(false);
      }
    }
  });

  it('⑤ discovery 段独立落 discovery-rules 键，不并入 tenant-profile', () => {
    for (const f of TEMPLATES) {
      const src = readFileSync(seedPath(f), 'utf8');
      expect(src, f).toMatch(/writeConfig\(\s*'discovery-rules'/);
      // tenant-profile 的写入块内不得出现 discovery 字段（保 mergeProfile 零回归）
      const from = src.indexOf("writeConfig('tenant-profile'");
      expect(from, f).toBeGreaterThan(-1);
      const block = src.slice(from, src.indexOf('}, { tenantId });', from));
      expect(block, f).not.toMatch(/^\s*discovery\s*:/m);
    }
  });
});
```

```js
// test/connectors/discovery/industryDiscovery.test.js
// §12.2/§12.4 行业 handbook Step 4C 双面一致性
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const PLATFORM = 'plugin-platform-admin/skills/industry-onboarding/SKILL.md';
const LOCAL = '.workbuddy/skills/new-industry-onboarding/SKILL.md';

describe('行业 handbook Step 4C（§12.2/§12.4）', () => {
  it('① 平台侧：Step 4C 存在，且既有 Step 4B / Step 4.5 未被破坏', () => {
    const src = readFileSync(PLATFORM, 'utf8');
    expect(src).toMatch(/Step 4C/);
    expect(src).toMatch(/discovery-rules/);
    expect(src).toMatch(/付费源/);
    expect(src).toMatch(/Step 4B/);
    expect(src).toMatch(/Step 4\.5/);
  });
  it('② 本地侧（运行时技能）：Step 4C 同款指引存在', () => {
    const src = readFileSync(LOCAL, 'utf8');
    expect(src).toMatch(/Step 4C/);
    expect(src).toMatch(/discovery-rules/);
    expect(src).toMatch(/付费源/);
  });
  it('③ 两面关键铁律一致：D1 三档 + 系统候选 + 第 0 闸', () => {
    for (const f of [PLATFORM, LOCAL]) {
      const src = readFileSync(f, 'utf8');
      expect(src, f).toMatch(/system-candidate/);
      expect(src, f).toMatch(/第\s*0\s*闸/);
    }
  });
});
```

跑：`npx vitest run test/config/industryTemplateDiscovery.test.js test/connectors/discovery/industryDiscovery.test.js` → **RED**（`db/seed/discovery-rules-templates.js` 不存在 → 模块解析失败；SKILL 无 Step 4C）。

**Step 2（GREEN）** — 实现

2a. **Create `db/seed/discovery-rules-templates.js`**（纯模块，**零 DB import**，单测无 PG 耦合）：

```js
// db/seed/discovery-rules-templates.js
// §12.3 行业 discovery 配置单一事实源（7 行业）。
// 形状铁律（写错 = 静默丢弃，见 test/config/industryTemplateDiscovery.test.js ②）：
//   providers → 数组 [{ id, enabled }]（非数组被 mergeDiscoveryRules:52 的 Array.isArray 挡掉）
//   icp       → 键名仅 industries / min_headcount / geo / min_confidence
//   signals   → 每项 { weight: <number> }（写数字会覆盖掉对象）
//   playbooks → 对象数组，每项必含 name（compilePlaybook 无名即 throw）
// 付费源铁律（D1）：模板**不得声明**付费源；系统候选（system-candidate）按行业清单置 true。
export const DISCOVERY_RULES_BY_INDUSTRY = Object.freeze({
  chemical: {
    providers: [{ id: 'attio', enabled: true }, { id: 'zhizao', enabled: true }],
    icp: { industries: ['chemical'], min_headcount: 200, geo: ['CN'] },
    signals: { tender_match: { weight: 0.95 }, funding_round: { weight: 0.5 } },
    playbooks: [
      { name: 'tender-first', match: 'tender_match', data: ['tender', 'gaode'], ai: ['claygentResearch:lite'], action: ['method-followup-engine'] },
      { name: 'default', match: '', data: ['web-research'], ai: [], action: [] },
    ],
  },
  consult: {
    providers: [{ id: 'zhizao', enabled: true }],
    icp: { industries: ['consulting'], min_headcount: 50, geo: ['CN'] },
    signals: { hiring_icp_role: { weight: 0.85 } },
    playbooks: [
      { name: 'hiring-first', match: 'hiring_icp_role', data: ['web-research'], ai: ['claygentResearch:lite'], action: ['method-followup-engine'] },
      { name: 'default', match: '', data: ['web-research'], ai: [], action: [] },
    ],
  },
  consult2: {
    providers: [],
    icp: { industries: ['consulting'], min_headcount: 20, geo: ['CN'] },
    signals: { website_redesign: { weight: 0.7 } },
    playbooks: [{ name: 'default', match: '', data: ['web-research'], ai: [], action: [] }],
  },
  demo: {
    providers: [],
    icp: { industries: ['b2b'], min_headcount: 10, geo: ['CN'] },
    signals: {},
    playbooks: [],
  },
  insmedi: {
    providers: [{ id: 'zhizao', enabled: true }],
    icp: { industries: ['medical_device'], min_headcount: 100, geo: ['CN'] },
    signals: { tender_match: { weight: 0.9 } },
    playbooks: [
      { name: 'tender-first', match: 'tender_match', data: ['tender', 'gaode'], ai: ['claygentResearch:lite'], action: ['method-followup-engine'] },
      { name: 'default', match: '', data: ['web-research'], ai: [], action: [] },
    ],
  },
  meddev: {
    providers: [{ id: 'attio', enabled: true }],
    icp: { industries: ['medical_device'], min_headcount: 150, geo: ['CN'] },
    signals: { funding_round: { weight: 0.8 } },
    playbooks: [
      { name: 'funding-first', match: 'funding_round', data: ['web-research', 'gaode'], ai: ['claygentResearch:lite'], action: ['method-followup-engine'] },
      { name: 'default', match: '', data: ['web-research'], ai: [], action: [] },
    ],
  },
  training: {
    providers: [],
    icp: { industries: ['training'], min_headcount: 20, geo: ['CN'] },
    signals: { hiring_icp_role: { weight: 0.8 }, website_redesign: { weight: 0.5 } },
    playbooks: [{ name: 'default', match: '', data: ['web-research'], ai: [], action: [] }],
  },
});
```

2b. 7 份 `db/seed/tenant-profile-*.js` — 在既有 `writeConfig('tenant-profile', ...)` 之后另起一次（**绝不并入** `tenant-profile`）。以 chemical 为例（其余 6 份同构，仅行业键不同）：

```js
import { DISCOVERY_RULES_BY_INDUSTRY } from './discovery-rules-templates.js';

// §12.3：discovery 段独立落 discovery-rules 键（不并入 tenant-profile，保 mergeProfile 三消费点零回归）
export async function seedChemicalDiscovery(tenantId) {
  if (!tenantId) throw new Error('tenantId is required');
  await writeConfig('discovery-rules', DISCOVERY_RULES_BY_INDUSTRY.chemical, { tenantId });
  return { ok: true, tenantId, key: 'discovery-rules' };
}

export async function seedChemicalProfile(tenantId, opts = {}) {
  if (!tenantId) throw new Error('tenantId is required (pass as argv[2] or argument)');
  await writeConfig('tenant-profile', { /* 既有内容零改动 */ }, { tenantId });
  // opts.withDiscovery === false ⇒ 跳过（供 tenant-profile-templates.mjs 的哨兵租户使用，避免残留）
  if (opts.withDiscovery !== false) await seedChemicalDiscovery(tenantId);
  return { ok: true, tenantId };
}
```

> 逐行业替换关系（其余 6 份按此对号）：`consult → DISCOVERY_RULES_BY_INDUSTRY.consult`（`seedConsultProfile(tenantId, opts)`）／`consult2`／`demo`／`insmedi`／`meddev`／`training`；**既有 `writeConfig('tenant-profile', ...)` 与行业 `prototypes` 内容一字不改**。

2c. `db/seed/tenant-profile-templates.mjs:28` — `await fn(TMP);` → `await fn(TMP, { withDiscovery: false });`
（哨兵租户 `__tp_tpl_src__` 只需取出 `tenant-profile` 快照，无需 discovery；否则会残留一条 `discovery-rules` 哨兵行，而该脚本末尾的清理语句**只清 `tenant-profile` 键**——不修改该 DELETE（红线），改由守卫从源头避免写入。）

2d. `plugin-platform-admin/skills/industry-onboarding/SKILL.md` — 在 **Step 4B 之后、Step 4.5 之前**插入（heading 编号用 `## 5.5`，使序为 `5 → 5.5 → 4.5`）：

```markdown
## 5.5 Step 4C — 启用本租户 discovery 数据源 + 播种行业 ICP/信号/编排

新行业上线即具备**本租户自有**的线索发现能力（设计 §12）。**D1 落地通道**：把 `discovery-rules`
从 `system` 模板懒克隆到本租户（`src/config/configStore.js` autoSeed），再按本行业清单启用。

### 5.5.1 启用规则（D1 三档，`scope` 即档位）

| 档 | `scope` | provider | 克隆后默认 | 本 Step 是否启用 |
|---|---|---|---|---|
| 系统级默认 | `system` | `email-verify` / `web-research` / `tender` / `gaode` | `enabled: true` | 无需干预（开箱即用） |
| 系统候选 | `system-candidate` | `attio` / `zhizao` | `enabled: false` | **按本行业清单置 `true`** |
| 付费源 | `paid` | 两个商用源（**模板不得声明其名**） | `enabled: false` | **严禁启用**（须管理员显式授权 + 填 key） |

### 5.5.2 落地方式（二选一，均须过决策第 0 闸）

**方式 A — 配置中心 PUT（推荐，自带第 0 闸）**
```
PUT /api/config/discovery-rules
Body: { "tenantId": "<真实租户ID>", "value": {
  "providers": [ { "id": "attio", "enabled": true } ],
  "icp": { "industries": ["chemical"], "min_headcount": 200, "geo": ["CN"] },
  "signals": { "tender_match": { "weight": 0.95 } },
  "playbooks": [ { "name": "default", "match": "", "data": ["web-research"], "ai": [], "action": [] } ]
} }
```

**方式 B — 种子脚本 bootstrap 旁路（仅系统引导 / 种子态）**
```js
import { writeConfig } from '../../src/config/configStore.js';
// ⚠ 形状铁律（写错会被 mergeDiscoveryRules 静默丢弃 = 假绿，无异常无日志）：
//   providers 必须是**数组** [{id,enabled}]（写 { attio:true } 对象会被 Array.isArray 挡掉）
//   icp 键名 = industries / min_headcount(number) / geo(array) / min_confidence
//   signals 每项必须是 { weight: number }（直接写数字会覆盖掉对象 → 消费方 .weight === undefined）
//   playbooks 必须是对象数组且每项有 name（compilePlaybook 无名直接 throw）
await writeConfig('discovery-rules', {
  providers: [{ id: 'attio', enabled: true }, { id: 'zhizao', enabled: true }],
  icp: { industries: ['chemical'], min_headcount: 200, geo: ['CN'] },
  signals: { tender_match: { weight: 0.95 } },
  playbooks: [{ name: 'default', match: '', data: ['web-research'], ai: [], action: [] }],
}, { tenantId });
```

### 5.5.3 验收
- `mergedDiscoveryRules({ tenantId }).providers` 命中本行业手册清单，**且 `signals[*].weight` 仍为 number**、`playbooks[*].name` 均存在；
- 本租户发现候选池可产出 ≥1 条；其它租户不可见（隔离）；
- **付费源 `enabled === false`**（断言）；
- `profileMerger` 三消费点 byte-equal 零回归（`discovery` 段**不进 `tenant-profile`**）。
```

2e. `.workbuddy/skills/new-industry-onboarding/SKILL.md` — 在 `## 5. Step 4 — 经真实写通道建粒子` 之后、`## 6. Step 5 — 关系与受控谓词` 之前插入**同款 Step 4C**（heading `## 5.5 Step 4C — 启用本租户 discovery 数据源 + 播种行业 ICP/信号/编排`，正文含 5.5.1 三档表 / 5.5.2 二选一 + **形状铁律** / 5.5.3 验收，与平台侧同文）。
> ⚠ 该文件被 `.gitignore:134`（`.workbuddy/`）忽略 ⇒ **修改生效但无法提交**；它是**本地运行时技能**，事实源仍是 `plugin-platform-admin/skills/industry-onboarding/SKILL.md`。

2f. 版本链（T19 同理，**一次改齐**）：
- `plugin-platform-admin/skills/industry-onboarding/registry.json` `version` → `1.1.0`
- `plugin-platform-admin/.codebuddy-plugin/plugin.json` `version` → `1.2.0`
- `plugin-platform-admin/openclaw.plugin.json` `version` → `1.2.0`
- `plugin-platform-admin/package.json` `version` → `1.2.0`

2g. `scripts/verify-plugin-zips.py` — 两处：
- `:176` `expect_version="1.1.1"` → `"1.2.0"`
- platform-admin 的 `content_rules` 追加 3 条（**第三元素锚定**到 zip 内真实路径 `skills/industry-onboarding/SKILL.md`，否则会被 `README.md` / `agents/platform-admin.md` 抢先满足而假绿）：

```python
"industry-onboarding 含 Step 4C 启用本租户数据源": (r"Step 4C", True, "skills/industry-onboarding/SKILL.md"),
"industry-onboarding 含 discovery-rules 键": (r"discovery-rules", True, "skills/industry-onboarding/SKILL.md"),
"industry-onboarding 标注付费源不得启用": (r"付费源", True, "skills/industry-onboarding/SKILL.md"),
```

- `:15` docstring：`platform-admin 须含 Step 4B / Step 4.5` → `Step 4B / Step 4.5 / Step 4C`。

2h. `dist/buddy-import/industry-config.json` — **只重生成，不入库**（`dist/` 在 `.gitignore:3`）：

```powershell
node scripts/pack-buddy-import.mjs
```

期望：`industry-config.json: 3 模式 / 15 胶囊`（T19 新增「线索发现」随 manifest 自动进入），`assets: modes 3 + capsules 15`。`version` 保持 `1.0.0`（`pack-buddy-import.mjs:36` 硬编码，是**导入格式版本**而非内容版本；bump 有触发平台侧未知版本校验的风险）。

**Step 3** — 打包 + 校验

```powershell
python scripts/pack-platform-admin-plugin.py
python scripts/verify-plugin-zips.py
```

> ⚠ `pack-platform-admin-plugin.py` **必须省略 `--out`**：其 `:96` 为 `os.makedirs(os.path.dirname(out_zip))`，传 `--out plugin-platform-admin.zip` 时 `dirname` 得空串 → `makedirs('')` 抛 `FileNotFoundError`。省略后走 `DEFAULT_OUT`（`REPO_ROOT/plugin-platform-admin.zip`），**与 verify 读取路径一致**。

**期望**：`crm-platform-admin` version = **1.2.0**；`Step 4C` / `discovery-rules` / `付费源` 三条内容规则 OK（且带锚定路径回显）；`crm-native` 侧不回归（version = 1.8.0）。

**Step 4** — 回归 + commit

```powershell
npx vitest run test/config/industryTemplateDiscovery.test.js test/connectors/discovery/industryDiscovery.test.js test/config/profileMerger.test.js test/billing/tenantAdminMultiProfile.test.js test/config/discoveryRules.test.js
```
→ **GREEN**。后三个为**零回归验证**，覆盖 test-plan §4 T21 的 ④⑦⑤⑥：
- ④ `assign-profile` / `remove-profile` 对 `system` 租户 400 → `tenantAdminMultiProfile.test.js:106-108`（T13）
- ⑦ `profileMerger` 三消费点 byte-equal → `test/config/profileMerger.test.js:65-80`（T17/T18）
- ⑤⑥ `mergedDiscoveryRules` 租户感知 + 隔离（注入式 deps，无 PG）→ `test/config/discoveryRules.test.js:45-58`（T1）

```powershell
git add db/seed/discovery-rules-templates.js db/seed/tenant-profile-chemical.js db/seed/tenant-profile-consult.js db/seed/tenant-profile-consult2.js db/seed/tenant-profile-demo.js db/seed/tenant-profile-insmedi.js db/seed/tenant-profile-meddev.js db/seed/tenant-profile-training.js db/seed/tenant-profile-templates.mjs test/config/industryTemplateDiscovery.test.js test/connectors/discovery/industryDiscovery.test.js
git commit -m "feat(discovery): per-industry discovery rules templates + 7 seed sections (shape-validated, zero-DELETE)"

git add plugin-platform-admin/skills/industry-onboarding/SKILL.md plugin-platform-admin/skills/industry-onboarding/registry.json plugin-platform-admin/.codebuddy-plugin/plugin.json plugin-platform-admin/openclaw.plugin.json plugin-platform-admin/package.json
git commit -m "docs(industry): Step 4C enable per-tenant discovery data sources (D1 three tiers)"

git add scripts/verify-plugin-zips.py docs/superpowers/plans/2026-09-10-lead-discovery-engine.md docs/2026-09-10-lead-discovery-test-plan.md
git commit -m "chore(plugin): bump platform-admin 1.2.0 + 3 anchored anti-drift rules"
```

> **不入库清单（gitignore 已覆盖，`git add` 会报 ignored，勿加）**：
> - `plugin-platform-admin.zip`、`plugin/crm-native-plugin.zip`（`.gitignore:15` `*.zip`；`git log --all -- "*.zip"` 为空 ⇒ **历史上从未跟踪**）
> - `dist/buddy-import/industry-config.json`（`.gitignore:3` `dist/`）
> - `.workbuddy/skills/new-industry-onboarding/SKILL.md`（`.gitignore:134` `.workbuddy/`）
>
> ⚠ **对 T19 已交付命令的更正**：T19 第 4 条 `git add` 含 `plugin/crm-native-plugin.zip`，该路径被忽略、`git add` 会报错 —— **请从该条命令中删去 zip 路径**（其余文件可正常提交）。

**验收**：7 模板 `discovery` 段齐（形状经真实 `mergeDiscoveryRules` 有效性验证）+ Step 4C **三面**（平台侧 + 本地运行时 + runbook）+ `plugin-platform-admin.zip` 1.2.0 + `profileMerger` 三消费点零回归 + **零 DELETE**（templates 由 `withDiscovery:false` 守卫替代清库）。

---

## Self-Review（计划自检）

**1. Spec coverage**
- D1 多租户分级数据源 → Task 1（providers tiers + tenantDefaults）+ Task 3（4 起步适配器）✅
- D2 P1 起步 = email-verify/web-research/标讯/高德 → Task 3 ✅
- D3 溯源双写 → Task 4（payload.enrichment）+ Task 5（autoWeakEdge sourcedFrom）✅
- D4 阶段顺序 → Task 1–13 按 P1→P2→P3 排布 ✅
- P0#1 2D judge → Task 4 ✅；P0#2 context-routing 红线 → Task 9 ✅；P0#3 ICP HITL → Task 11 ✅；P0#4 feedback → Task 12 ✅
- 不新增粒子/不改域模型 → 全程复用 CRM_ACCOUNT(potential)/CONTACT/DEAL(lead) ✅
- 三处硬闭包 → Task 5 ✅；S1 衔接复用 → Task 10 ✅
- 落库前查重（借鉴 Twenty find-or-create 多级回退 + 确定性 id upsert + 并发兜底）→ Task 7 Step 2b（`dedupResolver.js`，零 DELETE 预防式去重）✅
- **C1 可组合编排层**（v8 吸收）= 四段原语 data→condition→ai→action + `discovery-rules.playbooks` 按客群/租户配置驱动 → Task 14 ✅
- **C2 Claygent+glass-box**（v8 吸收）= `why_narrative` 带 `rule_ref`+`j_score`+`trace`，与 P0#1 2D judge 同源 → Task 15 ✅
- **C3 持续监控闭环**（v8 吸收，升 P0）= `monitorAccount` 重评分 + 账户 append-only 记忆 + 30 天蒸馏，禁 DELETE/不外发 → Task 16 ✅
- **不借** 200+ 数据源（Clay 最弱护城河、已商品化）→ 设计 §3.1 明确不纳入 ✅

**四条触点面（本轮补全）**
- **前台页面** → Task 13（`src/web/discovery.html` 工作台 + `src/http/discoveryRoutes.js` 只读候选池端点）✅
- **后台配置** → Task 1（config key / 租户 seed / `configCenter` id46 / `createConfigRouter` 挂载）+ Task 17（`src/web/discovery-rules.html` 5 TAB 编辑页）✅
- **ACTION 改造** → Task 5（三处硬闭包 + 独立 `discoveryActions.js`）+ Task 18（MCP 暴露 / `human_gate` 白名单 / gateway decisionScenario 锚定 / R3 反爆炸护栏）✅
- **buddy 应用 + 两个插件包** → Task 19（manifest 三处 + portal CAPS + `plugin.json` v1.8.0 / `connector-meta.json` v1.6.0 + `SKILL.md` 工具表 + 重新打包 + `verify-plugin-zips.py` expect_version）✅
- **端到端验收** → Task 20（HTTP 双端点 + MCP stdio 工具面 + 胶囊绑定 + 插件包校验）✅

**平台契约校正（本轮据源码修正，防"计划照抄导致实现返工"）**
- `registerAction` = 平铺对象 + `kind/permission/namespace/agentTool/handler`；`schema` 为**扁平 map**（`{ account_id:'string' }`）而非 JSON Schema（`mcp/tools.js:33-39` 注释实证）✅
- `registerSkill` = `{ slug, version, steps[] }`（`skills/registry.js:24-30`）✅
- `createConfigRouter` = 工厂 + deps 注入，无 `read`/`write` 入参（`src/http/configRouter.js:51-53`）✅
- 页面目录 = `src/web/`（非 `public/`，91 页）；配置中心 = `src/portal/configCenter.js`（非 `src/config/`）✅
- 测试目录 = `test/`（单数，556 个测试文件；非 `test/`）✅
- `particleRepo` 导出为 `queryParticles({type,tenantId,limit})` / `updateParticle` / `createEdge`（**无 `listParticles`**）✅
- `autoWeakEdge`/`weakPredicate:'sourcedFrom'` 为**连接器族专用**扩展（`src/connectors/connectorActions.js:21,102`），非 `registry.js` 通用字段 ✅
- 同构范式样板 = `src/connectors/connectorActions.js`（`seedConnectorActions()` 于 `routes.js:469` 调用）——发现引擎应照此落地 ✅

**2. Placeholder scan** — 所有代码步骤均含真实片段；`fetchPageSection`/`tender.matchTender` 标注为真实实现占位但接口契约完整（非 "TBD" 空步）。无 "add validation later" 类空话。

**3. Type consistency** — `selectPlaybook/compilePlaybook`（Task 14 定义，Task 14 Step 5 orchestrator 调用）、`buildGlassBox`（Task 15 定义，Task 15/16 复用）、`monitorAccount`（Task 16 定义，eventTrigger/capture 调用）、`appendAccountMemory/distillAccountMemory`（Task 16 定义+调用）命名一致；`runWaterfall(adapters, entity, fields, ctx)` 在 Task 2 定义、Task 3/7 同签名调用；`buildEnrichmentPayload/buildDiscoveryPayload` 在 Task 4 定义、Task 7 调用；`mergedDiscoveryRules` 在 Task 1 定义、Task 2/7 复用。命名一致。

**4. 行业包扩展 handbook 同步（Task 21 · v8.1 §12）** — 7 份 `db/seed/tenant-profile-*.js` 新增 `discovery` 段（**独立落 `discovery-rules` 键、不写 `tenant-profile`**，保 `mergeProfile` 三消费点 byte-equal 零回归）；`industry-onboarding` Step 4C（D1 三档按租户启用，**付费源严禁启用**）；双 SKILL 逐节对齐（消除分叉）；打包版本链 1.1.1→**1.2.0** + `verify-plugin-zips.py` `expect_version` 同步 + 3 条内容规则。测试见 T21 八条断言。

**5. TDD 先行链路** — 本计划所有 Task 的断言级测试清单见 `docs/2026-09-10-lead-discovery-test-plan.md` §4；§1 gates（决策第 0 闸 / 禁 DELETE / 隔离 / 粒子零增长 / 三处硬闭包 / 配置驱动 / id36 红线 / 付费源禁用 / system 保护）与 §5 护栏测试为 **fail-closed** 前提；Task 顺序与依赖以测试计划 §3 为准。

**执行移交见末尾提示。**
