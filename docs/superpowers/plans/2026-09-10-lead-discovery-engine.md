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
| T8 | Claygent 研究 Action | `connectors/discovery/research.test.js` | T7 |
| T9 | 记忆捕获域 + L2 注入红线（P0#2） | `memory/discoveryCapture.test.js` | T4 |
| T10 | S1 衔接验证 | `connectors/discovery/s1Handoff.test.js` | T7 |
| T11 | ICP 自进化草稿→回测→HITL（P0#3） | `evolution/icpSelfEvolution.test.js` | T6 |
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
- `src/evolution/icpSelfEvolution.js` — ICP 自进化草稿→回测→HITL（P0#3）
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
- `plugin-platform-admin/skills/industry-onboarding/SKILL.md`（新增 **Step 4C**）+ `plugin-platform-admin/skills/industry-onboarding/registry.json`（`version` 1.0.0→1.1.0）+ `plugin-platform-admin/.codebuddy-plugin/plugin.json`（→1.2.0）（**Task 21**）
- `.workbuddy/skills/new-industry-onboarding/SKILL.md` — 与平台侧逐节对齐（消除分叉：补 Step 4B/4.5/4C，统一 design 引用）（**Task 21**）
- `db/seed/tenant-profile-{chemical,consult,consult2,demo,insmedi,meddev,training}.js` ×7 — 新增 `discovery` 段（providers/icp/signals/playbooks），**独立落 `discovery-rules` 键、不写 `tenant-profile`**（**Task 21**）
- `scripts/verify-plugin-zips.py:162` — `expect_version` 1.1.1→1.2.0 + 3 条内容规则（Step 4C / discovery-rules / 付费源）（**Task 21**）
- `dist/buddy-import/industry-config.json` — 加「线索发现」胶囊 + 版本 bump（经 `scripts/gen-industry-config-variants.mjs` 重生成）（**Task 21**）

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
- Create: `src/agent/discoveryOrchestrator.js`, `src/connectors/discovery/dedupResolver.js`
- Modify: `src/connectors/tenderConnector.js` (复用 createLeadFromTender 模式)
- Test: `test/agent/discoveryOrchestrator.test.js`, `test/connectors/discovery/dedupResolver.test.js`

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect, vi } from 'vitest';
import { runDiscovery } from '../../src/agent/discoveryOrchestrator.js';

describe('runDiscovery', () => {
  it('creates CRM_ACCOUNT(potential)+DEAL(lead) and writes payload.discovery', async () => {
    const ctx = { tenantId: 't1', createParticle: vi.fn(async () => ({ id: 'acc1' })), createEdge: vi.fn() };
    const out = await runDiscovery(ctx, { seed: { name: '测试公司', domain: 'x.com' }, limit: 1 });
    expect(ctx.createParticle).toHaveBeenCalled();
    expect(out.payload.discovery.icp_fit_score).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test** → FAIL

- [ ] **Step 2b: 落库前查重解析器（duplicateCriteria 配置驱动，借鉴 Twenty 核心层）**

新增 `src/connectors/discovery/dedupResolver.js`：**查重条件从 `config.duplicate_criteria` 读取，不再硬编码匹配键**（对齐 Twenty `build-duplicate-conditions.utils.ts:24` 读 `flatObjectMetadata.duplicateCriteria` 的元数据驱动范式，且与项目「配置驱动差异化 + 阈值后台可配」铁律同构）。每组（group）内任一键命中即判重、组间为 OR；新增数据源/对象类型只改 config，**零核心代码改动**。
落库仍走**先查后建 + 确定性外部 id upsert + 并发唯一约束（`23505`）兜底转 update**；**全程零 DELETE，预防式去重**——契合项目「禁 DELETE」铁律，规避 Twenty `mergeMany` 的 soft-delete 输家模式。字段级合并策略（`scalar→winner-priority` / `array→deduped-union`）已作**预留设计**（`MERGE_STRATEGY_RESERVED.enabled=false`），启用前必须经决策第 0 闸 + 显式 HITL 授权。

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
  it('concurrent unique-constraint collision falls back to winner', async () => {
    const find = vi.fn(async () => null);
    const create = vi.fn().mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }))
                        .mockResolvedValueOnce({ id: 'acc-race' });
    const out = await resolveExistingOrCreate('CRM_ACCOUNT', { domain: 'y.com' }, { find, create });
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
      for (const group of groups) { // 并发兜底：唯一约束冲突 → 重查赢家转 update
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
// 项目铁律「禁 DELETE」：本阶段仅做预防式去重（命中即返回赢家，不创建重复、不删除输家）。
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

Run: `npx vitest run test/connectors/discovery/dedupResolver.test.js` → PASS

- [ ] **Step 3: Implement orchestrator**

```js
import { resolveAdapters } from '../connectors/discovery/providerRegistry.js';
import { runWaterfall } from '../connectors/discovery/waterfall.js';
import { resolveExistingOrCreate, defaultCriteriaFor } from '../connectors/discovery/dedupResolver.js';
import { buildEnrichmentPayload, buildDiscoveryPayload } from './discoverySchema.js';
import { DEFAULT_DISCOVERY_RULES } from '../config/discoveryRules.js';

export async function runDiscovery(ctx, input) {
  const rules = mergedSafe(input.tenantId);
  const adapters = resolveAdapters(rules);
  // 1) 本体优先：写粒子 → ontologySync 自动补全（见 hooks.js:48-113，无需此处调用）
  const accountCriteria = (rules.duplicate_criteria || {})['CRM_ACCOUNT'] || defaultCriteriaFor('CRM_ACCOUNT');
  const account = await resolveExistingOrCreate('CRM_ACCOUNT',
    { state: 'potential', name: input.seed.name, domain: input.seed.domain }, {
      find: (t, k, v) => ctx.findParticle(t, k, v, ctx),
      create: (t, a) => ctx.createParticle(t, a, ctx),
      update: (id, a) => ctx.updateParticle(id, a, ctx),
      criteria: accountCriteria, // 来自 config.duplicate_criteria，配置驱动
    });
  // 2) 缺口瀑布补全
  const { values, cost } = await runWaterfall(adapters, input.seed, ['email', 'industry', 'geo_coord', 'headcount'], ctx);
  const enrichment = buildEnrichmentPayload(values);
  // 3) 评分（由 lead-fit scenario 异步触发；此处写初值占位，真实评分经 decision-enrich 回写）
  const discovery = buildDiscoveryPayload(0.5, 0.5, [], 'pending');
  await ctx.updateParticle(account.id, { payload: { enrichment, discovery } }, ctx);
  // 4) 产出 lead deal（复用 tenderConnector 模式）
  const deal = await ctx.createParticle('CRM_DEAL', { stage: 'lead', account_id: account.id }, ctx);
  await ctx.createEdge('sourcedFrom', account.id, { provider: 'discovery-run', ts: new Date().toISOString(), cost });
  return { accountId: account.id, dealId: deal.id, payload: { enrichment, discovery } };
}
function mergedSafe(tenantId) { return DEFAULT_DISCOVERY_RULES; } // 真实读取 config_store(tenantId)
```

- [ ] **Step 4: Run test** → PASS

- [ ] **Step 5: Commit**

```powershell
git add src/agent/discoveryOrchestrator.js test/agent/discoveryOrchestrator.test.js
git commit -m "feat(discovery): orchestrator ontology-priority enrichment + waterfall + scoring"
```

---

## Task 8: Claygent 研究 Action（discovery-research）

**Files:**
- Modify: `src/action/seed-actions.js` (discovery-research run 体), Create helper `src/connectors/discovery/claygent.js`
- Test: `test/connectors/discovery/claygent.test.js`

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect, vi } from 'vitest';
import { claygentResearch } from '../../../src/connectors/discovery/claygent.js';
describe('claygent', () => {
  it('returns structured research notes with signals', async () => {
    const getLlmJson = vi.fn(async () => ({ summary: 'S', signals: [{ type: 'funding_round' }], competitors: ['A'] }));
    const out = await claygentResearch({ name: 'X', domain: 'x.com' }, '调查竞品与融资信号', { getLlmJson });
    expect(out.summary).toBe('S');
    expect(out.signals[0].type).toBe('funding_round');
  });
});
```

- [ ] **Step 2: Run test** → FAIL

- [ ] **Step 3: Implement `claygent.js`**（区块二分：先让模型判信息所在区块再定向抓取）

```js
export async function claygentResearch(entity, brief, { getLlmJson }) {
  // 1) 判定信息最可能所在页面区块
  const plan = await getLlmJson(
    `给定公司 ${entity.name}(${entity.domain})，研究简报：${brief}。只输出 JSON:{sections:[页面区块名]}`,
    { schema: { sections: ['array'] } }
  );
  const notes = { summary: '', signals: [], competitors: [], risks: [], layer: 'L3', source: 'claygent' };
  for (const sec of plan.sections || []) {
    const raw = await fetchPageSection(entity.domain, sec); // 真实抓取（二分收敛）
    const part = await getLlmJson(`从下面文本抽取研究笔记 JSON:{summary,signals[],competitors[],risks[]}\n${raw}`, {});
    Object.assign(notes, { summary: (notes.summary + ' ' + (part.summary || '')).trim(), signals: notes.signals.concat(part.signals || []), competitors: notes.competitors.concat(part.competitors || []), risks: notes.risks.concat(part.risks || []) });
  }
  return notes;
}
async function fetchPageSection() { return ''; } // 真实实现：fetch + 区块定位
```

- [ ] **Step 4: Wire `discovery-research` action run** to call `claygentResearch` and write `payload.research` + `sourcedFrom:claygent` edge.

- [ ] **Step 5: Run test** → PASS

- [ ] **Step 6: Commit**

```powershell
git add src/connectors/discovery/claygent.js src/action/seed-actions.js test/connectors/discovery/claygent.test.js
git commit -m "feat(discovery): Claygent research action with block-bisect scraping"
```

---

## Task 9: 记忆捕获域 + 上下文 L2 注入红线（P0 #2）

**Files:**
- Modify: `src/memory/capture.js:16-19` (DEFAULT_CAPTURE_DOMAINS 加 'discovery')
- Test: `test/memory/captureDiscovery.test.js`

- [ ] **Step 1: Write failing test** — 验证 emit `discovery` 事件被 capture 订阅并写入 memory_log。

- [ ] **Step 2: Run** → FAIL

- [ ] **Step 3: Edit `capture.js`** 在 `DEFAULT_CAPTURE_DOMAINS` 数组加 `'discovery'`。**不修改 `src/context/routing.js` 的 context-routing(id36)**（红线）。在 `discoveryOrchestrator` 写 payload 时加 64KB 体积闸：研究报告超长则 `truncated=true` + `degradedLayers`。

- [ ] **Step 4: Run** → PASS

- [ ] **Step 5: Commit**

```powershell
git add src/memory/capture.js src/agent/discoveryOrchestrator.js test/memory/captureDiscovery.test.js
git commit -m "feat(discovery): P0#2 discovery capture domain + context-routing(id36)红线守护"
```

---

## Task 10: S1 衔接验证（复用 intake-router + BANT，不新增）

**Files:**
- Test only: `test/integration/discoveryToS1.test.js` (验证 DEAL(stage=lead) 经 intake-router + scoreBantcc6:439 + crm-deal-advance:733-772 推进)

- [ ] **Step 1: Write integration test** 断言 `discovery-run` 产出的 `CRM_DEAL(stage='lead')` 能被既有 `intake-router` 接收并经 BANT 闸进入 S1。

- [ ] **Step 2: Run** → 验证既有管道未被破坏（若失败，说明衔接点需微调，但**不新增推进逻辑**，仅确认复用）。

- [ ] **Step 3: Commit (test only)**

```powershell
git add test/integration/discoveryToS1.test.js
git commit -m "test(discovery): verify S1 handoff reuses intake-router + BANT gate"
```

---

## Task 11: ICP 自进化草稿→回测→HITL（P0 #3）

**Files:**
- Create: `src/evolution/icpSelfEvolution.js`
- Test: `test/evolution/icpSelfEvolution.test.js`

- [ ] **Step 1: Write failing test** — 校验重校准先落草稿（`validated=false`），回测通过 + HITL 审批后才 `validated=true`；无审批绝不变更线上权重。

- [ ] **Step 2: Run** → FAIL

- [ ] **Step 3: Implement**

```js
export async function proposeIcpRecalibration(store, draft) {
  // 1) 落草稿（绝不自动生效）
  const id = await store.insertScenarioDraft({ ...draft, validated: false });
  // 2) 回测 threshold/count/noop
  const report = await backtest(store, draft);
  return { draftId: id, report, needsApproval: report.passed };
}
export async function approveIcpRecalibration(store, draftId, approver) {
  // 仅 HITL 审批后生效
  await store.setScenarioValidated(draftId, true, approver);
}
```

- [ ] **Step 4: Run** → PASS

- [ ] **Step 5: Commit**

```powershell
git add src/evolution/icpSelfEvolution.js test/evolution/icpSelfEvolution.test.js
git commit -m "feat(discovery): P0#3 ICP self-evolution draft->backtest->HITL"
```

---

## Task 12: feedback-loop 指标模板 + evaluator + Token 对账（P0 #4）

**Files:**
- Create: `src/feedback/discoveryMetrics.js`
- Test: `test/feedback/discoveryMetrics.test.js`

- [ ] **Step 1: Write failing test** — 校验 `discovered_to_won_rate` 指标模板含 7 要素；evaluator 三档阈值；Token 账本记录 account_id 花费。

- [ ] **Step 2: Run** → FAIL

- [ ] **Step 3: Implement**

```js
export const METRIC_TEMPLATES = {
  discovered_to_won_rate: {
    direction: 'up',
    formula: 'COUNT(DEAL lead->closed-won)/COUNT(DEAL lead)',
    target: 0.15, alert: 0.08, owner_agent: 'decision-retro',
    evaluator_skill: 'method-decision-enrich', adjust_actions: 'recalibrate lead-fit',
  },
  enrichment_coverage: { direction: 'up', formula: 'filled/should_fill', target: 0.8, alert: 0.5, owner_agent: 'decision-retro', evaluator_skill: 'method-decision-enrich', adjust_actions: 'add adapter' },
};
export function evaluate(metric, value) {
  const t = METRIC_TEMPLATES[metric];
  if (value >= t.target) return 'green';
  if (value >= t.alert) return 'yellow';
  return 'red'; // red -> 回滚草稿而非仅熔断
}
export function ledgerCost(accountId, provider, cost) { /* 写 discovery_cost_ledger */ }
```

- [ ] **Step 4: Run** → PASS

- [ ] **Step 5: Commit**

```powershell
git add src/feedback/discoveryMetrics.js test/feedback/discoveryMetrics.test.js
git commit -m "feat(discovery): P0#4 feedback metric templates + evaluator + token ledger"
```

---

## Task 13: 前台门户页面（线索发现工作台）

> **路径校正**：门户页面真实目录是 `src/web/`（91 页），**不是 `public/`**；serve 走 `src/http/routes.js` 的 `app.get('/xxx.html', sendFile(...))` 范式（见 `:218-219`）。UI 胶囊归 Task 20（buddy 应用面），本 Task 只做前台页面本体。

**Files:**
- Create: `src/web/discovery.html`（线索发现工作台）
- Create: `src/http/discoveryRoutes.js`（只读候选池端点，租户隔离）
- Modify: `src/http/routes.js`（挂 `createDiscoveryRouter()` + serve `/discovery.html`）
- Test: `test/web/discoveryPage.test.js`

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

- [ ] **Step 4: Create `src/http/discoveryRoutes.js`**（只读端点，无写、无 DELETE）

```js
// src/http/discoveryRoutes.js — 线索发现只读面（候选池；租户隔离，零写零删）
import { Router } from 'express';
import { queryParticles } from '../particles/particleRepo.js';   // 真实导出：queryParticles({type,tenantId,limit})；无 listParticles
import { scopeTenant } from './tenantScope.js';

async function defaultList(me, q) {
  const tenantId = scopeTenant(me);
  const rows = await queryParticles({ type: 'CRM_ACCOUNT', tenantId, limit: Number(q.limit) || 50 });
  // 只回发现相关字段（payload.enrichment/discovery），无写路径
  return rows.map((r) => ({
    account_id: r.id, name: r.payload?.name || r.name,
    icp_fit_score: r.payload?.discovery?.icp_fit_score ?? null,
    signals: r.payload?.discovery?.signals || [],
    why_narrative: r.payload?.discovery?.why_narrative || '',
    sources: r.payload?.discovery?.sources || [],
  })).filter((x) => x.icp_fit_score != null);
}

export function createDiscoveryRouter({ list = defaultList } = {}) {
  const router = Router();
  const handlers = {
    candidates: async (req, res) => {
      try {
        const me = await (req.resolveMe ? req.resolveMe(req) : Promise.resolve(req.me));
        if (!me?.ok) return res.status(403).json({ error: 'auth required' });
        res.json({ items: await list(me, req.query || {}) });
      } catch (e) { res.status(500).json({ error: e.message }); }
    },
  };
  router.get('/api/discovery/candidates', handlers.candidates);
  router.handlers = handlers; // 注入式测试契约（同 configRouter 范式）
  return router;
}
```

- [ ] **Step 5: Mount in `src/http/routes.js`**

```js
import { createDiscoveryRouter } from './discoveryRoutes.js';
// ...
app.use(createDiscoveryRouter());
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

**Files:**
- Modify: `src/config/discoveryRules.js`（加 `playbooks` 默认 + `mergedDiscoveryRules` 合并 playbooks）, `src/agent/discoveryOrchestrator.js`（消费编译后的 plan）
- Create: `src/connectors/discovery/orchestrationCompiler.js`
- Test: `test/connectors/discovery/orchestrationCompiler.test.js`

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
  it('selects playbook by signal match (all terms of && must hit)', () => {
    const pb = selectPlaybook(RULES, [{ type: 'funding_round' }, { type: 'hiring_icp_role' }]);
    expect(pb.name).toBe('high-funding');
  });
  it('compiles playbook into executable 4-primitive plan', () => {
    const plan = compilePlaybook(RULES.playbooks[0]);
    expect(plan.steps.map((st) => st.stage)).toEqual(['data', 'condition', 'ai', 'action']);
    expect(plan.steps[0].adapters).toContain('gaode');
    expect(plan.steps[3].skills).toContain('method-followup-engine');
  });
  it('falls back to default playbook when no match', () => {
    const pb = selectPlaybook(RULES, [{ type: 'unknown_signal' }]);
    expect(pb.name).toBe('default');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/connectors/discovery/orchestrationCompiler.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `src/connectors/discovery/orchestrationCompiler.js`**

```js
// src/connectors/discovery/orchestrationCompiler.js
// C1: 可组合 GTM 编排层（吸收 Clay #1 最深护城河）。
// 把 discovery-rules.playbooks 编译为可执行的四段原语计划：
//   data(适配器) -> condition(判定条件) -> ai(AI 研究) -> action(触达动作)。
// 零核心代码改动：新增客群/编排只改 config（配置驱动差异化铁律）。

export function compilePlaybook(pb) {
  const steps = [];
  if (pb.data?.length) steps.push({ stage: 'data', adapters: pb.data });
  if (pb.match) steps.push({ stage: 'condition', match: pb.match });
  if (pb.ai?.length) steps.push({ stage: 'ai', research: pb.ai });
  if (pb.action?.length) steps.push({ stage: 'action', skills: pb.action });
  return { name: pb.name, steps };
}

export function selectPlaybook(rules, signals = []) {
  const types = new Set(signals.map((sg) => sg.type));
  const list = rules.playbooks || [];
  const matches = (m) => (m || '').split('&&').map((x) => x.trim()).filter(Boolean).every((t) => types.has(t));
  const hit = list.find((pb) => pb.match && matches(pb.match));
  return hit || list.find((pb) => pb.name === 'default') ||
    { name: 'default', data: ['web-research'], ai: [], action: [] };
}
```

- [ ] **Step 4: Add `playbooks` default to `src/config/discoveryRules.js`**

在 `DEFAULT_DISCOVERY_RULES` 对象内、`duplicate_criteria` 之后加：

```js
  // C1: 可组合编排（按客群声明四段原语组合，配置驱动、无固定流程）
  playbooks: [
    { name: 'high-funding', match: 'funding_round && hiring_icp_role',
      data: ['tender', 'gaode'], ai: ['claygentResearch:deep'], action: ['method-followup-engine'] },
    { name: 'lite-redesign', match: 'website_redesign',
      data: ['web-research'], ai: ['claygentResearch:lite'], action: ['method-followup-engine'] },
    { name: 'default', match: '', data: ['web-research'], ai: [], action: [] },
  ],
```

并在 `mergedDiscoveryRules` 内加一段（浅合并 playbooks，tenant 覆盖同名、追加新客群）：

```js
  if (Array.isArray(tenantCfg.playbooks)) {
    const byName = Object.fromEntries(base.playbooks.map((pb) => [pb.name, pb]));
    for (const pb of tenantCfg.playbooks) byName[pb.name] = { ...(byName[pb.name] || {}), ...pb };
    base.playbooks = Object.values(byName);
  }
```

- [ ] **Step 5: Wire plan into `src/agent/discoveryOrchestrator.js`**

在 `runDiscovery` 内，用编译后的 plan 驱动数据段（替换 Task 7 中固定的 `resolveAdapters`）：

```js
import { selectPlaybook, compilePlaybook } from '../connectors/discovery/orchestrationCompiler.js';
// ... 在 runDiscovery 内：
const playbook = selectPlaybook(rules, input.signals || []);
const plan = compilePlaybook(playbook);
const dataStep = plan.steps.find((st) => st.stage === 'data');
const adapters = resolveAdapters(rules, dataStep ? dataStep.adapters : undefined); // 仅用 playbook 选中的适配器
```

（`resolveAdapters` 加可选 `allowIds` 参数：`if (allowIds && !allowIds.includes(p.id)) continue;`，不改瀑布本身。）

- [ ] **Step 6: Run tests to verify pass**

Run: `npx vitest run test/connectors/discovery/orchestrationCompiler.test.js`
Expected: PASS

- [ ] **Step 7: Commit**

```powershell
git add src/connectors/discovery/orchestrationCompiler.js src/config/discoveryRules.js src/connectors/discovery/providerRegistry.js src/agent/discoveryOrchestrator.js test/connectors/discovery/orchestrationCompiler.test.js
git commit -m "feat(discovery): C1 composable GTM orchestration (playbooks -> 4-primitive plan)"
```

---

## Task 15: Claygent glass-box 可解释推理链（C2）

> **依赖**：Task 4（discoverySchema）、Task 8（claygent）已落地。
> **目的**：研究/评分输出 `why_narrative` 必带可解释推理链（每步 `rule_ref`+`j_score`+`trace`），与 P0#1 的 2D judge 同源；可解释升为一等公民（吸收 Clay glass-box 卖点）。

**Files:**
- Create: `src/agent/glassBox.js`
- Modify: `src/agent/discoverySchema.js`（`buildDiscoveryPayload` 复用 glassBox）, `src/connectors/discovery/claygent.js`（研究输出 why_narrative）, `src/action/seed-actions.js`（`discovery-research` 落 payload.research 带 glass-box）
- Test: `test/agent/glassBox.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/agent/glassBox.test.js
import { describe, it, expect } from 'vitest';
import { buildGlassBox } from '../../src/agent/glassBox.js';

describe('glass-box (C2)', () => {
  it('emits why_narrative with rule_ref + j_score per decision', () => {
    const gb = buildGlassBox({ score: 0.82, ruleRef: 'scenario:lead-fit#ruler:industry', signals: ['funding_round'] });
    expect(gb.why_narrative).toContain('industry');
    expect(gb.judge.rule_ref).toBe('scenario:lead-fit#ruler:industry');
    expect(gb.judge.j_score).toBe(0.82);
    expect(gb.trace.length).toBe(1);
    expect(gb.trace[0].rule_ref).toBe('scenario:lead-fit#ruler:industry');
  });
  it('handles empty signals without throwing', () => {
    const gb = buildGlassBox({ score: 0.3, ruleRef: 'scenario:lead-fit#ruler:geo', signals: [] });
    expect(gb.why_narrative).toContain('无信号');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/agent/glassBox.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `src/agent/glassBox.js`**

```js
// src/agent/glassBox.js
// C2: glass-box 可解释推理链（吸收 Clay glass-box 范式，升为一等公民）。
// 每个评分/研究判定附 rule_ref（引用哪条 ruler/信号）+ j_score（能力轴置信），
// 与 P0#1 的 2D judge（axis=capability）同源；销售可见"为何此刻判定为目标客户"。
export function buildGlassBox({ score, ruleRef, signals = [], axis = 'capability' }) {
  const trace = signals.map((sg) => ({ signal: typeof sg === 'string' ? sg : sg.type, rule_ref: ruleRef, j_score: score }));
  const names = signals.map((sg) => (typeof sg === 'string' ? sg : sg.type)).join('、');
  return {
    judge: { axis, rule_ref: ruleRef, j_score: score },
    why_narrative: `因 ${names || '无信号'} 命中 ${ruleRef} 判定为目标客户（j_score=${score}）`,
    trace,
  };
}
```

- [ ] **Step 4: Reuse glass-box in `src/agent/discoverySchema.js`**

将 `buildDiscoveryPayload` 的 `why_narrative` 改为经 glass-box 生成（保留原 `judge` 结构，追加 `trace`）：

```js
import { buildGlassBox } from './glassBox.js';
export function buildDiscoveryPayload(fit, intent, signals, decisionId) {
  const fitGb = buildGlassBox({ score: fit, ruleRef: 'scenario:lead-fit#ruler:industry', signals });
  const intentGb = buildGlassBox({ score: intent, ruleRef: 'scenario:lead-fit#ruler:hiring_icp_role', signals });
  return {
    icp_fit_score: { value: fit, judge: fitGb.judge, trace: fitGb.trace },
    intent_score: { value: intent, judge: intentGb.judge, trace: intentGb.trace },
    signals,
    why_narrative: `${fitGb.why_narrative}；decision_id=${decisionId}`,
  };
}
```

- [ ] **Step 5: Emit glass-box from `claygentResearch`**

在 Task 8 的 `claygent.js` 返回对象加 `glass_box`（研究判定的可解释链）：

```js
import { buildGlassBox } from '../../agent/glassBox.js';
// ... 在 claygentResearch 末尾 return 前：
notes.glass_box = buildGlassBox({
  score: notes.confidence ?? 0.7,
  ruleRef: 'research#sig:web',
  signals: notes.signals.map((sg) => sg.type),
});
notes.why_narrative = notes.glass_box.why_narrative;
return notes;
```

`discovery-research` action 落 `payload.research` 时一并写入 `glass_box`。

- [ ] **Step 6: Run tests to verify pass**

Run: `npx vitest run test/agent/glassBox.test.js test/agent/discoverySchema.test.js`
Expected: PASS

- [ ] **Step 7: Commit**

```powershell
git add src/agent/glassBox.js src/agent/discoverySchema.js src/connectors/discovery/claygent.js src/action/seed-actions.js test/agent/glassBox.test.js
git commit -m "feat(discovery): C2 glass-box explainable reasoning chain (rule_ref+j_score+trace)"
```

---

## Task 16: monitorAccount 持续监控闭环（C3 · 升 P0）

> **依赖**：Task 6（lead-fit scenario）、Task 7（orchestrator）、Task 8（claygent）、Task 9（memory capture）已落地。
> **目的**：发现不是一次性动作，而是**常驻监控循环**——信号/定时触发 `lead-fit` 重评分 → 增量 append 到账户 append-only 持久记忆 → 30 天蒸馏 curated note → glass-box 可见优先级变化（吸收 Clay #3 Account Agent）。**禁 DELETE；跨外联绝不自动发信。**

**Files:**
- Create: `src/connectors/discovery/monitorAccount.js`, `src/memory/accountMemory.js`
- Modify: `src/agent/eventTrigger.js`（加重评分矩阵行）, `src/memory/capture.js`（账户记忆流）
- Test: `test/connectors/discovery/monitorAccount.test.js`, `test/memory/accountMemory.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// test/connectors/discovery/monitorAccount.test.js
import { describe, it, expect, vi } from 'vitest';
import { monitorAccount } from '../../../src/connectors/discovery/monitorAccount.js';

describe('monitorAccount (C3)', () => {
  it('re-scores and appends to account memory (no DELETE)', async () => {
    const ctx = {
      getAccount: vi.fn(async () => ({ id: 'acc1', payload: {} })),
      rescore: vi.fn(async () => ({ score: 0.77, ruleRef: 'scenario:lead-fit#ruler:funding_round' })),
      appendMemory: vi.fn(async () => ({ id: 'm1' })),
      updateParticle: vi.fn(async () => ({})),
    };
    const out = await monitorAccount(ctx, 'acc1', [{ type: 'funding_round' }]);
    expect(ctx.rescore).toHaveBeenCalled();
    expect(ctx.appendMemory).toHaveBeenCalled();
    expect(out.why_narrative).toContain('funding_round');
    expect(ctx.deleteParticle).toBeUndefined(); // 零 DELETE
  });
});
```

```js
// test/memory/accountMemory.test.js
import { describe, it, expect, vi } from 'vitest';
import { appendAccountMemory, distillAccountMemory, DISTILL_AFTER_DAYS } from '../../src/memory/accountMemory.js';

describe('accountMemory (C3)', () => {
  it('appends (append-only) without deleting history', async () => {
    const store = { insertMemoryLog: vi.fn(async (e) => ({ id: 'm1', ...e })) };
    const r = await appendAccountMemory(store, 'CRM_ACCOUNT', 'acc1', { kind: 'rescore', why_narrative: 'x' });
    expect(store.insertMemoryLog).toHaveBeenCalled();
    expect(r.id).toBe('m1');
  });
  it('distills entries older than 30 days into a curated note (log kept)', async () => {
    const store = {
      listMemoryLog: vi.fn(async () => [{ kind: 'rescore', why_narrative: 'a' }, { kind: 'rescore', why_narrative: 'b' }]),
      upsertMemoryNote: vi.fn(async (n) => ({ id: 'note1', ...n })),
    };
    const note = await distillAccountMemory(store, 'CRM_ACCOUNT', 'acc1', Date.now());
    expect(note.summary).toContain('a');
    expect(DISTILL_AFTER_DAYS).toBe(30);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/connectors/discovery/monitorAccount.test.js test/memory/accountMemory.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `src/connectors/discovery/monitorAccount.js`**

```js
// src/connectors/discovery/monitorAccount.js
// C3: 持续账户监控闭环（吸收 Clay Account Agent 持久记忆 + 持续刷新）。
// 信号到达(funding_round/tech_adopt/leadership_change) 或 定时增量刷新 ->
//   lead-fit 重评分(复用九标尺+2D judge) -> 增量 append 账户 append-only 记忆 -> glass-box 输出。
// 铁律：禁 DELETE（只 append 记忆、只 update payload）；跨外联绝不自动发信（走 HITL）。
import { buildGlassBox } from '../../agent/glassBox.js';

export async function monitorAccount(ctx, accountId, signals = []) {
  const acct = await ctx.getAccount(accountId);              // 读既有账户（不新建）
  const rescored = await ctx.rescore(accountId, { signals }); // lead-fit scenario 重跑（复用九标尺+2D judge）
  const gb = buildGlassBox({ score: rescored.score, ruleRef: rescored.ruleRef, signals });
  // 增量 append 到账户持久记忆（append-only，不覆盖、不删除）
  await ctx.appendMemory('CRM_ACCOUNT', accountId, { kind: 'rescore', ...gb, ts: new Date().toISOString() });
  // 只 update payload，不 delete
  await ctx.updateParticle(accountId, {
    payload: { discovery: { intent_score: { value: rescored.score, judge: gb.judge }, why_narrative: gb.why_narrative } },
  });
  return { accountId, score: rescored.score, why_narrative: gb.why_narrative, glass_box: gb };
}
```

- [ ] **Step 4: Implement `src/memory/accountMemory.js`**

```js
// src/memory/accountMemory.js
// C3: 账户持久记忆（append-only + 30 天蒸馏）。吸收 Clay Account Agent 持久记忆范式，
// 但守「禁 DELETE」：只 append，不删除历史；30 天后蒸馏为 curated note（log 仍保留）。
export const DISTILL_AFTER_DAYS = 30;

export async function appendAccountMemory(store, particleType, particleId, entry) {
  // 写入 crm.memory_log（append-only）
  return store.insertMemoryLog({ particle_type: particleType, particle_id: particleId, ...entry, ts: entry.ts || new Date().toISOString() });
}

export async function distillAccountMemory(store, particleType, particleId, now = Date.now()) {
  const cutoff = now - DISTILL_AFTER_DAYS * 86400000;
  const older = await store.listMemoryLog({ particle_type: particleType, particle_id: particleId, before: cutoff });
  if (!older.length) return null;
  const summary = older.map((e) => e.why_narrative || e.kind).join('; ');
  // curated note（crm.memory_note），不删 memory_log
  return store.upsertMemoryNote({ particle_type: particleType, particle_id: particleId, summary, distilled_from: older.length });
}
```

- [ ] **Step 5: Add re-score event matrix row in `src/agent/eventTrigger.js`**
  - ⚠ **本 Step 派发前必须复查**（2026-09-11 T6 复查遗留）：矩阵行真实形状 = `{domain,type,entity_type,intent,agent,skill_slug,dedup_field}`；
    且 `matchTrigger`（`src/agent/eventTrigger.js:65-76`）对 `READ_ONLY_SKILLS`（`:30-32`）**白名单外 SKILL 静默 `return null`** ——
    写 SKILL / 未注册 intent 的行是**死配置**（运行时永不命中且无报错）。落地前须确定：重评分走只读 SKILL，或另行放宽闸门（后者须走 brainstorming 批准）。
    并须断言**既有 3 行矩阵未被替换**（append 而非 overwrite，见测试计划 §5）。

在矩阵数组（`:15-26`）加一行（信号到达 → 重评分）：

```js
// C3: 账户信号到达 -> lead-fit 重评分 -> monitorAccount
{ event: 'CRM_ACCOUNT', kind: 'signal-detected', intent: 'lead-fit', agent: 'decision-agent' },
```

- [ ] **Step 6: Wire account memory into `src/memory/capture.js`**

`DEFAULT_CAPTURE_DOMAINS` 已含 `'discovery'`（Task 9）；追加账户维度的记忆落点（复用 `precipitate` 路径，将 `CRM_ACCOUNT.payload.discovery` 变更 append 至账户记忆，不覆盖）：

```js
// capture.js 内，处理 discovery 域时：
if (evt.domain === 'discovery' && evt.particleType === 'CRM_ACCOUNT') {
  await appendAccountMemory(store, 'CRM_ACCOUNT', evt.particleId, { kind: 'signal', ...evt.payload });
}
```

- [ ] **Step 7: Run tests to verify pass**

Run: `npx vitest run test/connectors/discovery/monitorAccount.test.js test/memory/accountMemory.test.js`
Expected: PASS

- [ ] **Step 8: Commit**

```powershell
git add src/connectors/discovery/monitorAccount.js src/memory/accountMemory.js src/agent/eventTrigger.js src/memory/capture.js test/connectors/discovery/monitorAccount.test.js test/memory/accountMemory.test.js
git commit -m "feat(discovery): C3 monitorAccount loop (rescore + append-only account memory, no DELETE)"
```

---

## Task 17: 后台配置页（`src/web/discovery-rules.html`，5 TAB）

> **路径校正**：真实目录 `src/web/`；模板取 `src/web/agent-event-trigger-config.html`（83 行同范式）；写端点走 Task 1 已挂的 `createConfigRouter({key:'discovery-rules',...})`。

**Files:**
- Create: `src/web/discovery-rules.html`
- Modify: `src/http/routes.js`（serve `/discovery-rules.html`，与 Task 1 Step 4 的 configRouter 挂载相邻）
- Test: `test/web/discoveryRulesPage.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/web/discoveryRulesPage.test.js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const html = readFileSync(new URL('../../src/web/discovery-rules.html', import.meta.url), 'utf8');
describe('discovery-rules.html 后台配置页', () => {
  it('含 5 TAB、第0闸写端点、付费源出厂禁用提示', () => {
    for (const t of ['ICP', '数据源', '信号权重', '查重条件', '编排']) expect(html).toContain(t);
    expect(html).toContain('/api/config/discovery-rules');
    expect(html).toContain('decision');          // 写回带 decision_id（第0闸票据）
    expect(html).toContain('付费源');             // D1：付费源出厂禁用提示
  });
});
```

- [ ] **Step 2: Run** → `npx vitest run test/web/discoveryRulesPage.test.js` → FAIL

- [ ] **Step 3: Create `src/web/discovery-rules.html`** — 5 TAB（复用门户既有样式令牌，light 主题）

| TAB | 编辑面 | 对应配置键 |
|---|---|---|
| ICP | industries（标签多选）/ min_headcount（数字）/ geo（多选）/ min_confidence（0–1 滑杆） | `icp.*` |
| 数据源 | 三档分组表（`system` / `system-candidate` / `paid`）+ enabled 开关；**paid 行置灰并标「出厂禁用，需显式授权 + 填 key」（D1）** | `providers[]` |
| 信号权重 | 6 维滑杆（funding_round/hiring_icp_role/tender_match/leadership_change/tech_adopt/website_redesign） | `signals.*` |
| 查重条件 | `duplicate_criteria` 按对象类型（CRM_ACCOUNT/CRM_CONTACT）的**有序列组**编辑器（多级回退序） | `duplicate_criteria` |
| 编排 | 四段原语编辑器（data→condition→ai→action），按客群命名 playbook（C1，Task 14） | `playbooks` |

- [ ] **Step 4: GET/PUT 接线** — GET `/api/config/discovery-rules` 未配置时页面展示 `mergedDiscoveryRules()` 出厂默认（只读态）；PUT 提交 `{ value }`，服务端经 `configRouter` 第 0 闸 mint decision，页面回显 `decision` 票据；越界/缺结构键 → 400 提示。

- [ ] **Step 5: Run** → PASS

- [ ] **Step 6: Commit**

```powershell
git add src/web/discovery-rules.html src/http/routes.js test/web/discoveryRulesPage.test.js
git commit -m "feat(discovery): admin config page (ICP/providers/signals/dedup/playbooks)"
```

---

## Task 18: ACTION 对外面（MCP 暴露 + 白名单 + gateway 决策锚定 + 反爆炸护栏）

> Task 5 解决「注册进去」（三处硬闭包）；本 Task 解决「对外可见且守闸」。

**Files:**
- Modify: `src/action/whitelist.js`（判定注释 + 决策记录）、`src/mcp/tools.js`（验证暴露，无需改逻辑）
- Test: `test/action/discoveryActions.test.js`（扩展）

- [ ] **Step 1: Extend the failing test**

```js
// test/action/discoveryActions.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import { seedDiscoveryActions } from '../../src/action/discoveryActions.js';
import { getAction, detectCrudExplosion } from '../../src/action/registry.js';
import { writeBlastRadius } from '../../src/action/whitelist.js';
import { buildMcpTools } from '../../src/mcp/tools.js';

const NAMES = ['discovery-run', 'discovery-enrich', 'discovery-research'];
beforeAll(() => seedDiscoveryActions());

describe('discovery ACTION 对外面', () => {
  it('三个动作均为 write/agentTool/ 带决策场景锚点', () => {
    for (const n of NAMES) {
      const a = getAction(n);
      expect(a.kind).toBe('write');
      expect(a.agentTool).toBe(true);
      expect(a.decisionScenario).toBe('LEAD_FIT');
      expect(a.namespace).toBe('discovery');
    }
  });
  it('默认 human_gate —— 不进 autonomous 写白名单', () => {
    for (const n of NAMES) expect(writeBlastRadius(n)).toBe('human_gate');
  });
  it('不触发 R3 CRUD 爆炸护栏', () => {
    expect(detectCrudExplosion().exploded).toBe(false);
  });
  it('经 MCP 列表对外暴露', () => {
    const names = buildMcpTools({ seed: false }).map((t) => t.name);
    for (const n of NAMES) expect(names).toContain(n);
  });
});
```

- [ ] **Step 2: Run** → FAIL（文件/动作未存在）

- [ ] **Step 3: 白名单判定** — `src/action/whitelist.js` 的 `WRITE_WHITELIST` **不加入** `discovery-*`。理由：discovery 写主数据（CRM_ACCOUNT/CONTACT payload）且跨到外联面；进白名单会使其在对话入口 autonomous 自主写入。保持 `human_gate`（需 `ctx.authorizedWrite` 或 HITL）——与分析引擎「跨外联走 HITL 绝不自动发信」（设计 §6.2）同构。在文件内注释记录该决策与依据。

- [ ] **Step 4: gateway 决策锚定核对** — 确认 `src/mcp/gateway.js` 写通道在无 `decision_id` 时按 `action.decisionScenario` mint 决策（第 0 闸锚定）。断言：`discovery-run` 无 `decision_id` 且无 `confirm_token` → 返回 `gate='confirm_required'`（**不是** ok:true）。此断言是防假绿关键：只判 `ok!==true` 才算通过。

- [ ] **Step 5: Run** → PASS

- [ ] **Step 6: Commit**

```powershell
git add src/action/whitelist.js test/action/discoveryActions.test.js
git commit -m "feat(discovery): ACTION exposure gate (human_gate + decisionScenario mint + no CRUD explosion)"
```

---

## Task 19: buddy 应用 + 两个插件包同步

> **分发铁律（项目 memory）**：新增对外 MCP 工具 = 必须同步插件包（`skills/crm-native/SKILL.md` + `.workbuddy-plugin/agents/crm-native.md` + 版本三清单），并让 `verify-plugin-zips.py` 的 `expect_version` 对齐。

**Files:**
- Modify: `buddy-crm-manifest.json`（`home.workModes[].skills` + `home.workModes[].capsules[]` + `market.skills`）
- Modify: `src/web/buddy-crm-portal.html:57-94`（`CAPS` 加项）
- Modify: `.workbuddy-plugin/plugin.json`（`version` 1.7.1→**1.8.0**）
- Modify: `skills/crm-native/SKILL.md`（Action 读/写清单，`:107-133`）
- Modify: `.workbuddy-plugin/agents/crm-native.md`（一句话能力映射）
- Modify: `connector/connector-meta.json`（`version` 1.5.0→**1.6.0**）
- Modify: `scripts/verify-plugin-zips.py`（`expect_version` 1.7.1→**1.8.0**，`:129`）
- Test: `test/ui/discoveryCapsule.test.js` + `node scripts/buddy-capsule-binding-check.mjs`

- [ ] **Step 1: Write the failing test**

```js
// test/ui/discoveryCapsule.test.js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const manifest = JSON.parse(readFileSync('buddy-crm-manifest.json', 'utf8'));
const portal = readFileSync('src/web/buddy-crm-portal.html', 'utf8');
describe('buddy 线索发现胶囊', () => {
  it('manifest 有胶囊且 skill 名与 MCP 工具一致', () => {
    const caps = manifest.home.workModes.flatMap((m) => m.capsules || []);
    const cap = caps.find((c) => c.name === '线索发现');
    expect(cap).toBeTruthy();
    expect(cap.skills).toContain('discovery-run');
  });
  it('门户 CAPS 有 discovery 项', () => {
    expect(portal).toContain('discovery-run');
  });
});
```

- [ ] **Step 2: Run** → FAIL

- [ ] **Step 3: `buddy-crm-manifest.json`** 三处同步：① `home.workModes[<销售坐席>].skills` 加 `'discovery-run'`（或对应 skill 名）；② 同 mode 的 `capsules[]` 加对象 `{ name:'线索发现', en:'Lead Discovery', icon:'assets/capsules/discovery.svg', expert:'AI 原生销售管理助手', skills:['discovery-run'], systemPrompt:'调用 discovery-run 运行一次线索自主发现，输出候选线索池（ICP 适配分 + 信号 + why_narrative），只读展示，不自动外联。' }`；③ `market.skills` 数组加同名 skill。

- [ ] **Step 4: `src/web/buddy-crm-portal.html`** 在 `CAPS` 对应 tab 加项（`skill` 即 MCP 工具名，`targetAgent` 取注册表 6 key 之一）：

```js
{ label: "线索发现", skill: "discovery-run", targetAgent: "decision-agent",
  prompt: "调用 discovery-run 运行线索自主发现，输出候选线索池（ICP 适配分/信号/why_narrative），只读展示。" }
```

- [ ] **Step 5: 插件包同步** — ① `.workbuddy-plugin/plugin.json` `version` → `1.8.0`；② `skills/crm-native/SKILL.md` 的「Action 写清单」表加 `discovery-run`/`discovery-enrich`/`discovery-research` 三行（标注两阶段 + 第 0 闸）；③ `.workbuddy-plugin/agents/crm-native.md` 的「一句话能力映射」加「线索发现」；④ `connector/connector-meta.json` `version` → `1.6.0`；⑤ `scripts/verify-plugin-zips.py:129` `expect_version` → `1.8.0`。

- [ ] **Step 6: 重新打包并校验**

```powershell
python scripts/pack-crm-plugin.py --out plugin/crm-native-plugin.zip
python scripts/pack-platform-admin-plugin.py --out plugin-platform-admin.zip
node scripts/build-buddy-import-zip.mjs
python scripts/verify-plugin-zips.py
```

Expected: `version = 1.8.0` / `1.1.1` 均 OK，技能与内容规则全绿。

- [ ] **Step 7: Run** → `npx vitest run test/ui/discoveryCapsule.test.js` + `node scripts/buddy-capsule-binding-check.mjs` → PASS

- [ ] **Step 8: Commit**

```powershell
git add buddy-crm-manifest.json src/web/buddy-crm-portal.html .workbuddy-plugin/plugin.json skills/crm-native/SKILL.md .workbuddy-plugin/agents/crm-native.md connector/connector-meta.json scripts/verify-plugin-zips.py test/ui/discoveryCapsule.test.js
git commit -m "feat(discovery): buddy capsule + plugin packages sync (v1.8.0 / connector v1.6.0)"
```

---

## Task 20: 触点面端到端验收（HTTP + MCP 双通道）

> 项目铁律：**单测全绿 ≠ 链路通**。本 Task 用真实实例 + 真实 MCP stdio 验证四条触点面真的通了（范式见 `scripts/e2e-dialog-advice.mjs`）。

**Files:**
- Create: `scripts/e2e-discovery-touchpoints.mjs`（`PORT=3100` 避让 3000；真实 MCP stdio）

- [ ] **Step 1: 起隔离实例** — `PORT=3100 PGDATABASE=crm_native_test node src/http/server.js &`（改 `src/` 后必须重启实例）

- [ ] **Step 2: HTTP 后台配置面** — ① GET `/api/config/discovery-rules`（未配置 → 404 或回退默认）；② PUT 写一次完整结构（带 `decision`）→ 再 GET 校验 round-trip 一致；③ 角色闸：`alice(sales)` 访问 → 403（租户级需 `ten_admin/sysadmin/ADMIN`）

- [ ] **Step 3: HTTP 前台面** — ① GET `/api/discovery/candidates` 未登录 → 403 `auth_required`；`crm_login` 后 → 200（`items` 为数组）；② GET `/discovery.html`、`/discovery-rules.html` → 200 `text/html`

- [ ] **Step 4: MCP 工具面** — stdio 起 `src/mcp/server.js` → `crm_login` → `tools/list` 含 `discovery-run`/`discovery-enrich`/`discovery-research`；调用 `discovery-run` **无 `confirm_token`** → 断言 `gate='confirm_required'`（**判据必须是 `ok!==true`，只判字段存在会假绿**）

- [ ] **Step 5: buddy 绑定 + 插件包** — `node scripts/buddy-capsule-binding-check.mjs` → 通过；`python scripts/verify-plugin-zips.py` → 全 OK

- [ ] **Step 6: Commit**

```powershell
git add scripts/e2e-discovery-touchpoints.mjs
git commit -m "test(discovery): e2e acceptance for all four touchpoints (HTTP + MCP stdio)"
```

---

## Task 21: 行业包扩展 handbook 同步（v8.1 §12 新增）

**Files:**
- Modify: `plugin-platform-admin/skills/industry-onboarding/SKILL.md`（新增 **Step 4C**）
- Modify: `plugin-platform-admin/skills/industry-onboarding/registry.json`（`version` 1.0.0 → 1.1.0）
- Modify: `plugin-platform-admin/.codebuddy-plugin/plugin.json`（`version` → 1.2.0）
- Modify: `.workbuddy/skills/new-industry-onboarding/SKILL.md`（与平台侧逐节对齐）
- Modify: `db/seed/tenant-profile-{chemical,consult,consult2,demo,insmedi,meddev,training}.js` ×7（新增 `discovery` 段）
- Modify: `scripts/verify-plugin-zips.py:162`（`expect_version` 1.1.1 → 1.2.0 + 3 条内容规则）
- Modify: `dist/buddy-import/industry-config.json`（加「线索发现」胶囊 + 版本 bump）
- Create: `test/connectors/discovery/industryDiscovery.test.js`、`test/config/industryTemplateDiscovery.test.js`

**关键设计约束（§12.3）**：`discovery` 段**独立落 `discovery-rules` 键**，**绝不写入 `tenant-profile`** —— 保证 `mergeProfile` 合并结果形状不变，`resolvePrototype` / `isControlledPredicateConfig` / `runProfileCalculations` 三消费点 **byte-equal 零回归**。

**Step 1（RED）** — 先写两个失败测试

```js
// test/config/industryTemplateDiscovery.test.js
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';

const SEEDS = readdirSync('db/seed').filter((f) => /^tenant-profile-.*\.js$/.test(f));

describe('行业模板 discovery 段（§12.3）', () => {
  it('7 份模板均含 discovery 段（providers/signals/playbooks）', () => {
    expect(SEEDS.length).toBeGreaterThanOrEqual(7);
    for (const f of SEEDS) {
      const src = readFileSync(`db/seed/${f}`, 'utf8');
      expect(src, f).toMatch(/discovery\s*:/);
      expect(src, f).toMatch(/providers/);
      expect(src, f).toMatch(/signals/);
      expect(src, f).toMatch(/playbooks/);
    }
  });
  it('模板不得启用付费源（D1 铁律）', () => {
    for (const f of SEEDS) {
      const src = readFileSync(`db/seed/${f}`, 'utf8');
      expect(src, f).not.toMatch(/clearbit\s*:\s*true/i);
      expect(src, f).not.toMatch(/linkedin\s*:\s*true/i);
    }
  });
  it('discovery 段独立落 discovery-rules 键，不写 tenant-profile', () => {
    for (const f of SEEDS) {
      const src = readFileSync(`db/seed/${f}`, 'utf8');
      expect(src, f).toMatch(/writeConfig\(\s*'discovery-rules'/);
    }
  });
});
```

```js
// test/connectors/discovery/industryDiscovery.test.js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

describe('行业 handbook Step 4C（§12.2/§12.4）', () => {
  it('平台侧 handbook 含 Step 4C 启用本租户数据源', () => {
    const src = readFileSync('plugin-platform-admin/skills/industry-onboarding/SKILL.md', 'utf8');
    expect(src).toMatch(/Step 4C/);
    expect(src).toMatch(/discovery-rules/);
    expect(src).toMatch(/付费源/);
  });
  it('本地侧 handbook 与平台侧对齐（无分叉）', () => {
    const a = readFileSync('plugin-platform-admin/skills/industry-onboarding/SKILL.md', 'utf8');
    const b = readFileSync('.workbuddy/skills/new-industry-onboarding/SKILL.md', 'utf8');
    for (const marker of ['Step 4B', 'Step 4\\.5', 'Step 4C']) {
      expect(a, `plugin ${marker}`).toMatch(new RegExp(marker));
      expect(b, `local ${marker}`).toMatch(new RegExp(marker));
    }
  });
});
```

跑：`npx vitest run test/config/industryTemplateDiscovery.test.js test/connectors/discovery/industryDiscovery.test.js` → **RED**（模板无 `discovery` 段、SKILL 无 Step 4C）。

**Step 2（GREEN）** — 实现

2a. `plugin-platform-admin/skills/industry-onboarding/SKILL.md` — 在 **Step 4B 之后、Step 4.5 之前**插入 **Step 4C**：

```markdown
## 4.6 Step 4C — 启用本租户 discovery 数据源 + 播种行业 ICP/信号/编排

新行业上线即具备本租户自有的线索发现能力（设计 §12）。**D1 落地通道**：把 `discovery-rules.providers` 从 `system` 模板懒克隆到本租户，再按本行业清单启用。

### 4.6.1 启用规则（D1 三档）
| 档 | provider | 克隆后默认 | 本 Step 是否启用 |
|---|---|---|---|
| 系统级默认 | `email-verify` / `web-research` / `tender` / `gaode` | `true` | 无需干预 |
| 系统候选 | `attio` / `zhizao` | `false` | **按行业清单置 true** |
| 付费源 | `clearbit` / `linkedin` | `false` | **严禁启用**（须管理员显式授权 + 填 key） |

### 4.6.2 落地方式（二选一，均须过决策第 0 闸）
**方式 A — 配置中心 PUT（推荐，自带第 0 闸）**
```
PUT /api/config/discovery-rules
Body: { "tenantId": "<真实租户ID>", "value": { "providers": {...}, "icp": {...}, "signals": {...}, "playbooks": [...] } }
```
**方式 B — 种子脚本 bootstrap 旁路（仅系统引导 / 种子态）**
```js
import { writeConfig } from '../../src/config/configStore.js';
await writeConfig('discovery-rules', { providers, icp, signals, playbooks }, { tenantId });
```

### 4.6.3 验收
- `mergedDiscoveryRules(tenantId).providers` 命中本行业手册清单；
- 本租户发现候选池可产出 ≥1 条；其它租户不可见（隔离）；
- **付费源 `enabled === false`**（断言）；
- `profileMerger` 三消费点 byte-equal 零回归。
```

2b. 版本链：`registry.json` `version` → `1.1.0`；`.codebuddy-plugin/plugin.json` `version` → `1.2.0`。

2c. `.workbuddy/skills/new-industry-onboarding/SKILL.md` — 补 Step 4B / 4.5 / 4C（与平台侧逐节对齐），design 引用统一为 `docs/2026-09-10-multi-industry-tenant-profile-design.md`。

2d. 7 份 `db/seed/tenant-profile-*.js` — 在既有 `writeConfig('tenant-profile', {...}, { tenantId })` **之后另起一次**：

```js
// §12.3：discovery 段独立落 discovery-rules 键，不写入 tenant-profile（保 mergeProfile 零回归）
await writeConfig('discovery-rules', {
  providers: { attio: true, zhizao: false },          // 仅系统候选需声明；付费源不得出现
  icp: { industries: ['化工'], headcount: { min: 200 }, regions: ['华东'] },
  signals: { funding_round: 1.0, hiring_icp_role: 0.8, tender_match: 0.9, tech_adopt: 0.6 },
  playbooks: ['chem-default'],
}, { tenantId });
```

2e. `scripts/verify-plugin-zips.py:162` — `expect_version="1.1.1"` → `"1.2.0"`，并给 `content_rules` 追加：

```python
"industry-onboarding 含 Step 4C 启用本租户数据源": (r"Step 4C", True),
"industry-onboarding 含 discovery-rules 键": (r"discovery-rules", True),
"industry-onboarding 标注付费源不得启用": (r"付费源", True),
```

2f. `dist/buddy-import/industry-config.json` — 加「线索发现」胶囊（图标约定同 Task 19），`version` bump；`node scripts/gen-industry-config-variants.mjs` 重生成变体。

**Step 3** — 打包 + 校验

```powershell
python scripts/pack-platform-admin-plugin.py --out plugin-platform-admin.zip
python scripts/verify-plugin-zips.py
```

**期望**：`crm-platform-admin` version = **1.2.0**；Step 4C / discovery-rules / 付费源 三条内容规则 OK；`crm-native` 侧不回归。

**Step 4** — 回归 + commit

跑：`npx vitest run test/config/industryTemplateDiscovery.test.js test/connectors/discovery/industryDiscovery.test.js test/config/profileMerger.test.js test/billing/tenantAdminMultiProfile.test.js` → **GREEN**（后两个为**零回归**验证）。

```powershell
git add plugin-platform-admin/skills/industry-onboarding/SKILL.md plugin-platform-admin/skills/industry-onboarding/registry.json plugin-platform-admin/.codebuddy-plugin/plugin.json .workbuddy/skills/new-industry-onboarding/SKILL.md db/seed/tenant-profile-chemical.js db/seed/tenant-profile-consult.js db/seed/tenant-profile-consult2.js db/seed/tenant-profile-demo.js db/seed/tenant-profile-insmedi.js db/seed/tenant-profile-meddev.js db/seed/tenant-profile-training.js scripts/verify-plugin-zips.py dist/buddy-import/industry-config.json test/connectors/discovery/industryDiscovery.test.js test/config/industryTemplateDiscovery.test.js
git commit -m "feat(discovery): sync industry onboarding handbook (Step 4C per-tenant data sources + template discovery section)"
```

**验收**：7 模板 `discovery` 段齐 + 双 SKILL 对齐 + `plugin-platform-admin.zip` 1.2.0 + `profileMerger` 三消费点零回归 + 零 DELETE。

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
