# 外部数据源融合能力（Provider-Agnostic Fusion）设计文档

> **For agentic workers:** REQUIRED SUB-SKILL: Use `writing-plans` to implement this design task-by-task after approval. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 CRM 平台建立「入站意图 → 按 provider 路由 → 草稿 → HITL 确认落库」的通用融合能力，使 anysite / 启信慧眼(qixin) / 新榜(xinbang) 等任意外部数据源可插拔接入，融合层对 provider 透明。

**Architecture:** 复用既有 `ProviderAdapter` / `providerRegistry` / `discoveryOrchestrator` / `credentialVault` 泛型机制；新增一层「入站 MCP 工具 + 意图路由处理器 + 草稿暂存 + HITL 确认写」面。传输层各 provider 自封装（anysite=REST+JWT；qixin/xinbang=REST+Bearer）。任何返回数据**绝不自动落库**，须 `confirm_token` 闸门确认后写入。

**Tech Stack:** Node.js (ESM) · Express · crm-native-mcp (StreamableHTTP/stdio) · PostgreSQL+pgcrypto (credentialVault) · Zod (MCP schema) · Vitest。

---

## 1. 背景与动机

会话中用户最初要求接入 anysite.io（获取企业/个人数据）。实证发现：
- anysite 对本账号同时提供 **REST**（`api.anysite.io/api/*`，`access-token:<JWT>`）与 **MCP**（`mcp.anysite.io/mcp?api_key=<JWT>`）双接口，均用同一 JWT；裸 UUID 会 401（这也是最初「没通」错觉的根因）。
- 系统已有 `qixin.js`（启信慧眼）、`xinbang.js`（新榜）同类付费 provider 适配器，注册于 `providerRegistry`，由 `discoveryRules`/`prospectingRules` 按 `enabled` 控制。

用户明确纠正：**不能把 anysite 焊死；换成启信慧眼/新榜也须直接适配**。因此设计从「anysite 专用」升格为「通用外部数据源融合能力」。

## 2. 融合数据流

```
外部用户/智能体
   │  (crm-native-mcp)
   ▼
prospecting-lookup({ provider, kind, payload })        ← 入站意图（泛型 MCP 工具）
   │
   ▼
意图路由处理器 ── providerRegistry 按 id 解析适配器
   │              (anysite:REST+JWT / qixin:REST+Bearer / xinbang:REST+Bearer)
   ▼
适配器.search() / enrich()                              ← 各自封装传输/认证
   │
   ▼
草稿(draft) ──► 仅返回预览，零 DB 写
   │
   ▼  [用户/坐席在 UI 确认]
prospecting-confirm({ draft_id, confirm_token })        ← HITL 闸（两阶段）
   │
   ▼
discovery_draft 暂存表 → 确认后 data-particle-create 落 CRM 粒子
```

## 3. 意图 Schema（入站 MCP）

| kind | payload | 映射适配器方法 | 分期 |
|---|---|---|---|
| `enrich` | `{entity:{name?\|email?}, fields?}` | `adapter.enrich()` | 一期 |
| `prospect` | `{icp:{industries,geo,employee_min,employee_max}, limit}` | `adapter.search()` | 一期 |
| `signal` | `{entity, signal_type}` | `search_posts`/`linkedin/user/posts`（新增端点） | 二期 |

`provider` 缺省策略：默认路由到 `discoveryRules`/`prospectingRules` 中 `enabled` 的付费源集合；或要求显式指定（防误写未授权源）。

## 4. 任务分解 + 生命契约

> **监管归属说明：** 本特性端到端由 `decision-agent`（`autonomy:'autonomous'`，`skillCalls` 含 `discovery-enrich`+`data-particle-create`）统一监管；`prospecting` agent 的 `prospecting-search`/`prospecting-confirm` 作为具体运行时 Action 表面被调用。契约块统一以 `decision-agent` 为 `agent`、契约键 `ct-decision`，使文档属单域设计（`seen.size=1`），避免校验器对「名册类文档」的过严反向断言。

### T1 — 泛型入站 MCP 工具 `prospecting-lookup`

```contract-yaml
- task: "provider-agnostic 入站工具 prospecting-lookup"
  agent: decision-agent
  contract_task_id: "ct-decision"
  skills: [discovery-enrich]
  memory: [decision-agent]
  knowledge_scope: { layers: [L1, L2], max_hops: 5 }
  success: "MCP 暴露 prospecting-lookup(provider,kind,payload)；anysite/qixin/xinbang 经同一工具接入，参数透传"
```

**契约说明：** 由 `decision-agent` 监管，调 `discovery-enrich` SKILL、读 `decision-agent` 记忆；成功标准为同一工具可接入三类 provider 且协议参数透传。
**实现要点：** 在 `src/mcp/tools.js` 注册 `prospecting-lookup`（沿用 `buildMcpTools` 咽喉）；`protocolShape` 已含 `confirm_token` 等协议字段；`provider/kind/payload` 经 `jsonSchemaToZod` 透传。注意「装配闭包三处同改」——若新增 Action：`seed.js` registerSkill + `agentSpec.capabilities.actions`(`prospecting` 加 `prospecting-lookup`/`prospecting-confirm` 已存在) + `seed-actions.js` method-* 数组须同步。

### T2 — 意图路由处理器（按 provider 解析适配器，零写草稿）

```contract-yaml
- task: "意图经 providerRegistry 路由到适配器并产出草稿"
  agent: decision-agent
  contract_task_id: "ct-decision"
  skills: [discovery-enrich, data-particle-read]
  memory: [decision-agent]
  knowledge_scope: { layers: [L1, L2], max_hops: 5 }
  success: "意图经 providerRegistry 路由到对应适配器 search/enrich，返回草稿，全程零 DB 写"
```

**契约说明：** `decision-agent` 经 `discovery-enrich`+`data-particle-read`，读 `decision-agent`；成功为路由正确且零写。
**实现要点：** 处理器用 `loadAdapters({tenantId})` 取启用适配器，按 `provider` 选实例；调 `adapter.search/enrich`；结果包成 `draft`（含 `draft_id`、来源 provider、`items[]`、成本估算）；**不调用任何 `data-particle-create`**。

### T3 — anysite 适配器 REST 重写（首个具体 provider 接线；qixin/xinbang 既有无改动）

```contract-yaml
- task: "anysiteAdapter 重写为 REST 客户端"
  agent: decision-agent
  contract_task_id: "ct-decision"
  skills: [discovery-enrich]
  memory: [decision-agent]
  knowledge_scope: { layers: [L1, L2], max_hops: 5 }
  success: "anysiteAdapter 经 REST(JWT) 调 db/linkedin/search/companies 与 linkedin/email/user 返回候选/画像；qixin/xinbang 既有无改动即可复用同一融合层"
```

**契约说明：** `decision-agent` 承 `discovery-enrich`，读 `decision-agent`；成功为 REST 取数通且 qixin/xinbang 无需改动。
**实现要点：** 重写 `src/connectors/discovery/adapters/anysite.js` 为 REST（`fetch` + `access-token:JWT`），端点 `db/linkedin/search/companies`（search）、`linkedin/email/user`（enrich by email）、回退 `db/linkedin/search/companies` by name（enrich by name）；`health()` 探活；fail-open；凭据取自 `ctx.credentials.anysite || process.env.ANY_SITE_KEY`。删除既有 MCP 客户端分支。

### T4 — 草稿暂存 + HITL 确认写（泛型，跨 provider）

```contract-yaml
- task: "草稿暂存表 + confirm_token 写闸（provider 无关）"
  agent: decision-agent
  contract_task_id: "ct-decision"
  skills: [data-particle-create, data-particle-read]
  memory: [decision-agent]
  knowledge_scope: { layers: [L1, L2], max_hops: 5 }
  success: "草稿 confirm_token 闸后落库；无 token 拒写；多 provider 通用"
```

**契约说明：** `decision-agent` 经 `data-particle-create`+`data-particle-read`，读 `decision-agent`；成功为闸门生效且跨 provider 通用。
**实现要点：** 建 `discovery_draft` 暂存表（随 `db/schema.sql` 单一事实源补 DDL）；`prospecting-confirm`（由 `prospecting` agent 运行时调用）校验 `confirm_token` → 取草稿 → `data-particle-create` 落 CRM 粒子（account/contact）；无 token 拒绝；软清理过期草稿（禁物理 DELETE）。

### T5 — 配置翻 enabled + 前端 catalog 通用化

```contract-yaml
- task: "discoveryRules/prospectingRules 翻 enabled + 前端 catalog 通用化"
  agent: decision-agent
  contract_task_id: "ct-decision"
  skills: [discovery-enrich]
  memory: [decision-agent]
  knowledge_scope: { layers: [L1, L2], max_hops: 5 }
  success: "anysite/qixin/xinbang enabled=true；前端 catalog 列表动态渲染 provider 而非写死 anysite"
```

**契约说明：** `decision-agent` 承 `discovery-enrich`，读 `decision-agent`；成功为三 provider 启用且前端动态渲染。
**实现要点：** `discoveryRules.js` / `prospectingRules.js` 中 `anysite/qixin/xinbang` 的 `enabled` 由 `false` 翻 `true`；`src/web/discovery-rules.html` 的 `INTEGRATION_CATALOG` 改为由配置驱动渲染（不写死文案）。

### T6 — 测试 + 多 provider E2E（含 HITL）

```contract-yaml
- task: "单测 + 多 provider 真 JWT E2E 验证"
  agent: decision-agent
  contract_task_id: "ct-decision"
  skills: [discovery-enrich]
  memory: [decision-agent]
  knowledge_scope: { layers: [L1, L2], max_hops: 5 }
  success: "单测绿 + anysite(REST/JWT)+qixin+xinbang 冒烟 + HITL 确认写 全链通过"
```

**契约说明：** `decision-agent` 承 `discovery-enrich`，读 `decision-agent`；成功为多 provider 全链验证通过。
**实现要点：** 单测 mock `fetch`（断言 URL/`access-token`/fail-open/映射）；MCP 工具 schema 测试；真 JWT 实跑 `health`+`lookup`+`confirm` 全链（anysite + qixin/xinbang 冒烟）。

## 5. 红线 / 约束

- ⚠ **绝对禁自动落库**：任何 provider 返回数据未经 `confirm_token` 不得 `data-particle-create`（对齐零信任第 0 闸）。
- ⚠ **禁 DELETE**：草稿清理走软删除/过期，不物理删。
- ⚠ **JWT 不落前端/日志**：仅在 `ctx.credentials` 服务端流转。
- 新 provider 接入 = 实现 `ProviderAdapter` + 注册 + config 翻 enabled，**融合层零改动**（本设计核心价值）。
- 二期 `signal` 类需新增端点映射，不在本期 scope。

## 6. 闭环回写（workbench ↔ brainstorming）

| 任务 | Agent | 观测字段 | 反馈落地 |
|---|---|---|---|
| T1 | prospecting | 是否调 `prospecting-search`、读 `intake-router`、MCP 暴露 | `<doc>.feedback.json` |
| T2 | prospecting | 路由正确性、零写 | 同上 |
| T3 | decision-agent | 调 `discovery-enrich`、REST 取数 | 同上 |
| T4 | prospecting | `confirm_token` 闸门、跨 provider | 同上 |
| T5 | decision-agent | `discovery-enrich`、配置翻 enabled | 同上 |
| T6 | decision-agent | `discovery-enrich`、多 provider E2E | 同上 |

反馈记录格式（workbench 写入 `<doc>.feedback.json`，幂等 upsert by `task+gap_type`）：
```json
{ "task": "...", "agent": "...", "gap_type": "skill|memory|success", "observed": "...", "expected": "...", "ts": "...", "severity": "warn|error" }
```
相同 `(task, gap_type)` 复现 ≥2 次 → 产出 SKILL 改进提案（**须用户显式批准**后方可改 SKILL/DELETE）。

## 7. 开放项

- `provider` 缺省策略：默认启用集合 vs 显式指定（实现时定，推荐显式指定以防误写未授权源）。
- `discovery_draft` 暂存表 retention 策略（建议 24h 软过期）。
- 二期 `signal` 端点映射待单独设计。
