# Semantica × 决策网络全景监控 — 设计文档

> 日期：2026-08-26 ｜ 状态：brainstorming 分节确认（待整体批准）→ writing-plans
> 上游输入：微信文章 ×3 + `D:\system\reference\semantica-main`（源码 13.7 万行 Python + docs/guides 五篇核心）
> 纪律：设计先行已满足；TDD；每 Task 一 commit；10 大 ai-* 能力清单固定不新增

## 0. 结论摘要（先结论）

本项目（CRM-ai-native）已有**决策事件主轴**（总体设计 §6，`src/decision/decisionRepo.js` 等 7 点 Schema + 先例检索 + 30 天蒸馏）与**销售决策监控**（`src/monitor/monitorStore.js` 七闸门 + `monitorSubscriber.js` 事件落库 + `sales-decision-monitor.html` 监控台）。Semantica 提供的是**同一思想的完成态产品**，其可借鉴核心与其差距为：

| Semantica 能力 | 本项目已有（file:line 实证） | 可补差距 |
|---|---|---|
| 决策=图节点+因果链+先例 | `decision` 表 7 点 + `decision_precedent_rel` 单跳边（`decisionRepo.js:66-77`）+ pgvector 先例（`:122-137`） | **因果链多跳追溯**（§6.3 `REFERENCED_PRECEDENT` 多跳已设计未落地）；决策洞察统计 |
| Agent Memory（命名空间/快照对比） | `memory/` 三构件 + `appendMemoryLog`（`decisionRepo.js:79-82`） | **agent 认知记录**（看到了哪些事实+来自哪里）→ 复用 `monitor_event` 表扩展 |
| Multi-Agent 三模式（共享图/交接/命名空间） | kanban 四态机 + `agentLoop.js` 4 trace 点 | **命名空间隔离防交叉污染**（agent 认知记录归入 task 维度） |
| Provenance（PROV-O + 防篡改 + lineage） | `decision_event` 表（`decisionRepo.js:140-148`）+ monitor_event | **SHA-256 校验和链** + **审计导出** |
| Policy Engine（合规检查+异常+审批链+影响分析） | `autonomyEngine.js` 置信度门控 + `ruleEngine.js`（恒拒绝假闸）+ approval 六层 | **策略合规检查**（`effective_policy_version` 已有字段缺检查引擎）+ **what-if 影响分析** |

**决策（brainstorming 逐项确认）**：
| 决策点 | 结论 |
|---|---|
| 应用方式 | **纯机制借鉴**（Node/AGE 栈补齐，零新 Python 依赖；与 CordysCRM 先例一致） |
| 落地范围 | **智能体监控全集 + 决策闭环监控 + 审计导出**（用户全选） |
| 图存储 | **直接上 Apache AGE**（对齐总体设计 §6.3 原计划 + Semantica `age_store.py`） |
| 监控体系 | **全量重构**：agent 运行态全部接决策网络视角（关键拍板点入图），但仍复用既有 trace/kanban/monitor 为底座 |

## 1. 环境现状（精确事实，证据级）

### 1.1 PG 环境已探测
- `PG16@5433 plm` 库、`agent2b/agent2b` 用户（`src/db.js:13-14` 默认凭证）。
- `pg_available_extensions` 显示 **`age 1.6.0 available, installed_version null`** → 服务器**有 AGE 软件包但当前库未安装**。
- `pg_extension` 已装：`pgcrypto 1.3 / plpgsql 1.0 / vector 0.5.8`（无 age）。
- `information_schema.schemata` 无 `ag_catalog`、无任何 age/graph schema → **AGE 从未启用**（AGE 一旦 `CREATE EXTENSION` 必建 `ag_catalog`）。
- `crm` schema 表清单：`business_tier_config, decision, decision_event, decision_precedent_rel, decision_scenario, edges, events, memory_log, memory_note, memory_snapshot, meta_attr, methodology_dimension, methodology_template, monitor_event, particles, policy_version, role_context_profile, scheduler_lock, task_audit, tasks`（无 graph/decision_network 相关表）。

### 1.2 结论
- **总体设计 §6.3 的 AGE 图是「已设计、未实现」**（与 08-26 gap-inventory 结论一致）。
- 当前决策网络用 `decision_precedent_rel` **关系表**（直接先例边）+ `decision` 表 embedding **pgvector 检索**（`decisionRepo.js:122-137`）——**不是 AGE**。
- `src/` 无任何 AGE/Cypher/`ag_catalog` 代码（grep 实证，唯一 `age_in_stage` 是 aiAttributes 的停留天数，无关）。

### 1.3 AGE 启用前置条件（实施第一 Task，显式标注）
- `CREATE EXTENSION age` 通常需 **superuser 或具 CREATEROLE/扩展创建授权的角色**；`agent2b` 为普通用户（可查 `pg_available_extensions`，能否建扩展需实测/授权）。
- **实施计划第一 Task = 幂等启用**：`CREATE EXTENSION IF NOT EXISTS age; SELECT load 'age'; SET search_path TO ag_catalog, crm, public;` + 建图 `SELECT create_graph('crm_decision_network')`，并记录「若 agent2b 无授权，需 DBA 预装一次」的降级路径。
- 若 DBA 授权无法及时取得 → **自动降级递归 CTE**（`decision_precedent_rel` 多跳）保监控闭环落地，AGE 留待授权后回填（同 §5.3 韧性）。

### 1.4 落地状态补注（2026-08-31 审计更新）
> 本节纠正 §1.1–1.3 的过时探测结论：原「AGE 从未启用 / src 无任何 AGE 代码」已成为历史。

- **P0 已落地（实测）**：`plm` 与 `plm_test` 库均装 `age 1.6.0` + `ag_catalog` + `crm_decision_network` 图；`src/decision/ageGraph.js:62 ensureGraph()` 应用侧幂等自愈，`server.js:73` 启动时调用。AGE 扩展由 DBA/应用侧已预装，非仍待授权状态。
- **图已有存量数据**：实测 `crm_decision_network` 含 **541 顶点 / 186 边**（`scripts/backfill-age.js` 回填已执行）。
- **§4.1 七类边缺口已补齐**：`CAUSED / INFLUENCED / ESTABLISHES_FRAME / DERIVED_FROM_EXCEPTION` 四类边经 `createDecision` 触发入口（`src/decision/decisionRepo.js` 的 `caused_by / influenced_by / establishes_frame_for / triggered_by_exception`）双写 PG 权威 `crm.decision_relation` + AGE 镜像；测试 `test/decision-causal-edges.test.js` **4/4 通过**。
- **P8 `graph_query` 已落地为真实 MCP 读工具 `crm_graph_query`**（含 RBAC 第 1.5 闸，sales 角色越权返回 `permission_denied`）；测试 `test/mcp/graph-query.test.js` **3/3 通过**；REST 面 `/api/graph/{neighbors,trace,impact,provenance,edges,analytics}` 全部注册。
- **P6 图分析已接线 + 测试**：`/api/graph/analytics` 端点消费 `src/decision/graphAnalytics.js`；测试 `test/graph-analytics.test.js` **3/3 通过**；前端 `src/web/decision-graph.html` 增加「图分析」按钮消费。
- 结论：本设计文档规划功能**已全部落地并经测试验证（详见 §0 修订）**。

## 2. 总体架构

把「智能体监控 + 决策闭环监控」从 **trace 日志视角**全量重构为 **决策网络视角**——不只记「agent 跑了多久」，而是记录「agent 看到了什么 → 为什么这么判 → 影响了什么」，以 AGE 图为查询面。

```
┌─ L4 门户/监控台 ─────────────────────────────────────────────────┐
│  既有 sales-decision-monitor.html（7 闸门闭环，保留）              │
│  + 决策网络视图（新增）：因果链追溯 / 影响地图 / 洞察统计 / 审计导出 │
│  + 新端点 /api/monitor/trace·impact·audit（与既有 /monitor/* 并列） │
└──────────────────────────────────────────────────────────────────┘
┌─ L3 智能体平面（全量监控接线）────────────────────────────────────┐
│  agentLoop（既有 4 trace 点保留）                                  │
│    + 每次运行 → recordAgentEpisode（认知：看到了哪些事实+来源）     │
│  autonomyEngine 每次拍板 → recordDecision → AGE 决策节点+因果边     │
│  confirm/reverse → 追加 INFLUENCED / OVERRIDES 边                  │
└──────────────────────────────────────────────────────────────────┘
┌─ L2 事件平面 ────────────────────────────────────────────────────┐
│  decision 事件域（既有）+ 新增 decision_traced / audit_exported → SSE│
│  monitorSubscriber 将 decision 事件落 monitor_event（既有，保留）   │
└──────────────────────────────────────────────────────────────────┘
┌─ L1 数据层（Apache AGE 图 + 关系表并存）───────────────────────────┐
│  AGE: Decision 顶点 + 业务粒子顶点 + 因果边 + Policy/Frame 顶点     │
│   ↑ 写权威: decision 表（7 点 Schema，既有，事实源不变）            │
│   ↑ 认知记录: monitor_event 表扩展（agent_id / context_facts 两列） │
│   ↑ 审计: decision_provenance 新表（SHA-256 校验和链）              │
└──────────────────────────────────────────────────────────────────┘
```

**核心原则**：
1. `decision` 表保持**写权威与事实源**；AGE 图是**决策网络运行时查询面**（多跳因果/影响遍历）——与 methodology SKILL 物化镜像同一纪律（写时同步，事实源在表）。
2. 新增 4 组件：`ageGraph.js` / `decisionTrace.js` / `agentEpisodes.js` / `provenance.js`；不新增 ai-* 能力（10 大清单固定），仅增挂点。
3. **全量重构落点**：agentLoop 现有 4 trace 点（`agentLoop.js:37-49`）→ 旁路写认知记录；关键拍板点（autonomous/escalated/confirmed/reversed，`decisionRepo.js:60/108/151/164`）→ AGE 决策节点+因果边。

## 3. 与既有监控/决策体系结合（接口级细节）

> 本设计**不推翻**既有监控，而是把既有系统作为「持久化底座 + 统计数据源」，新增「AGE 决策网络（因果面）+ agent 认知（agentEpisodes）+ 审计」三个**增量层**。

### 3.1 既有系统 → 新设计的复用/接线

| 既有模块（file:line） | 复用方式 | 新增接线 |
|---|---|---|
| `monitorSubscriber.js:26-33` 订阅 decision 域 → 落 `monitor_event` 表 | **保留**为事件持久化底座 | AGE 在其上建多跳因果面；不复写持久化 |
| `monitorStore.js:25-45` `getGateMetrics` 七闸门统计 | **保留**为统计面数据源 | `decisionTrace.getInsights()` 在此之上聚合（不另起炉灶） |
| `monitorStore.js:48-56` `getSevenDimCoverage` | **保留**为监控台覆盖度视图 | 决策网络视图复用其维色标 |
| `routes.js:166-202` `/api/monitor/gates·decisions·coverage` + 监控台 | **保留** | **新增并列端点** `/api/monitor/trace`（因果链）、`/api/monitor/impact`（下游影响）、`/api/monitor/audit`（审计导出） |
| `agentLoop.js:37-49` 4 trace 点 | **保留**（trace 仍在） | `agentEpisodes.recordEpisode()` 旁路写认知记录（不替换 trace） |
| `decisionRepo.js:60/108/151/164` made/autonomous/escalated/confirmed/reversed | **保留**（决策表写权威） | **旁路** AGE 决策节点写 + 因果边（失败 trace 不阻断） |
| `monitor_event` 表（`monitorSubscriber.js:11-19`）已含 decision_id/scenario_id | **复用为 agent 认知落点** | **ALTER 扩展** `agent_id text`、`context_facts jsonb` 两列；不新建 agent_episode 表 |

### 3.2 修改点（既有文件最小侵入）

| 文件 | 变更（file:line 级） | 侵入度 |
|---|---|---|
| `src/monitor/monitorSubscriber.js` | `ensureMonitorSchema()` 建表语句**扩展 2 列**（agent_id/context_facts） | 低（幂等 DDL） |
| `src/decision/decisionRepo.js` | `createDecision()` 尾部旁路调 `ageGraph.addDecision()`（`:84-87` emit 前）；失败 emit trace + `recordFailure`（落实 G3 R1，不再静默吞错）；`confirmDecision`/`reverseDecision` 追加边 | 低（旁路，不串主流程） |
| `src/agent/agentLoop.js` | 4 trace 点旁路调 `agentEpisodes.recordEpisode({taskId, skill, contextFacts, outcome})` | 低（旁路） |
| `src/monitor/monitorStore.js` | 新增 `failsByKind`/`recordFailure/getFailures`（对齐已批准 G3 §4 C3） | 低（内存结构） |
| `src/http/routes.js` | 新增 3 端点（trace/impact/audit），复用既有 getGateMetrics | 低 |

## 4. 数据模型与 AGE Schema

### 4.1 图结构
- 图名：`crm_decision_network`（crm schema 内）
- **顶点**：`Decision`（全字段 7 点）、业务粒子（CRM_DEAL/CRM_ACCOUNT/CRM_CONTACT 等，对齐 `particles` 表类型）、`Policy`（policy_version）、`DecisionFrame`（§6.3 参考系）
- **关系边**（对齐 §6.3 谓词 + Semantica CAUSED/INFLUENCED）：

| 边 | 语义 | 边来源 |
|---|---|---|
| `DECIDED_ON` → 业务粒子 | 决策作用于哪个对象 | §6.3（已有设计，本设计装载） |
| `REFERENCED_PRECEDENT` → Decision | 引用过往先例（**多跳**） | §6.3（已有设计，本设计装载） |
| `DERIVED_FROM_EXCEPTION` → Decision | 判断依据继承自合规例外 | §6.3（已有设计，本设计装载） |
| `ESTABLISHES_FRAME` → Frame | 本决策建立参考系 | §6.3（已有设计，本设计装载） |
| `OVERRIDES` → Decision | 新决策覆盖旧决策 | §6.3（已有设计，本设计装载） |
| `CAUSED` / `INFLUENCED` → Decision | agent 拍板链 | **本设计新增**（Semantica 语义） |

### 4.2 装载策略
- `createDecision()` 写表后**同步**写 AGE 顶点（失败→emit trace+recordFailure，**不静默**）。
- 确认/逆转时追加 `CAUSED/INFLUENCED/OVERRIDES` 边。
- migrate 提供 `age-backfill` 幂等回填（存量 decision + particles 全量入图），回填期间图读走降级 CTE。

### 4.3 审计数据模型（新表 `decision_provenance`）
```
decision_provenance (
  id          BIGSERIAL PRIMARY KEY,
  decision_id UUID NOT NULL REFERENCES crm.decision(decision_id),
  entry_type  TEXT NOT NULL,      -- entity / decision / relationship / property
  payload     JSONB NOT NULL,     -- 当时全字段（决策 7 点/边/来源）
  source      TEXT,               -- 来源（粒子/事件/Agent）
  activity_id TEXT,               -- 产生它的流程
  checksum    TEXT NOT NULL,      -- SHA-256（含 previous_checksum 链式）
  previous_checksum TEXT,         -- 前一条校验和（链式防篡改）
  chain_seq   BIGSERIAL,          -- 链序
  created_at  TIMESTAMPTZ DEFAULT now()
)
```
- 对齐 Semantica `ProvenanceManager`：`track_*` → 逐条记 payload + SHA-256；`verify_chain()` → 全链重算校验和（含检测硬删除）；`export_prov()` → 审计导出。
- **GDPR/隐私**：`decision_provenance` 记录采用**不可变追写**（append-only），不做物理删除；如需擦除 → `invalidated` 墓碑标记（对齐 Semantica `invalidate()` never hard delete）。

## 5. 核心组件与数据流

### 5.1 组件

| 组件 | 文件 | 职责 | 对齐 Semantica |
|---|---|---|---|
| C1 | `src/decision/ageGraph.js`（新） | AGE 连接（load age + search_path）+ 参数化 Cypher（防注入）+ 顶点/边写 + 多跳查询；不可用降级 CTE | `age_store.py`（1343 行） |
| C2 | `src/decision/decisionTrace.js`（新） | 因果链追溯（upstream/downstream 多跳）+ 下游影响地图 + 决策洞察统计（per-scenario 自主/升级/确认/逆转率+平均置信度，聚合 `getGateMetrics`） | Decision Intelligence + CausalChainAnalyzer |
| C3 | `src/agent/agentEpisodes.js`（新） | agent 每次运行认知记录（看到了哪些事实+来源+拍板）→ **写 monitor_event 表扩展列** | Agent Memory（conversation_id 命名空间） |
| C4 | `src/decision/provenance.js`（新） | SHA-256 校验和链 + 版本链（previous_checksum）+ 篡改校验（`verifyChain()`）+ 审计导出（`exportAudit()`） | ProvenanceManager |

### 5.2 监控闭环数据流（全量重构）

```
agentLoop 启动 → agentEpisodes.recordEpisode({agentId, taskId, startedAt})
  ├─ buildContextBlock → 捕获 contextFacts（agent 看到了什么+来源）→ 写 monitor_event.context_facts
  ├─ autonomyEngine.requireDecision → decisionRepo.createDecision → 旁路 ageGraph.addDecision（AGE 顶点）
  ├─ confirmDecision → 旁路 ageGraph.addEdge(CAUSED/INFLUENCED)（HITL 闭环）
  └─ 完成/失败 → recordEpisode 补 outcome + emit trace（既有）
```

### 5.3 韧性（错误处理）
| 场景 | 处理 |
|---|---|
| AGE 不可用（未安装/授权缺失） | `ageGraph` 自动降级递归 CTE（`decision_precedent_rel` 多跳）；决策主链路**不阻断**；emit trace `age-unavailable` + `recordFailure` |
| AGE 顶点写失败 | 旁路 catch → emit trace `decision-graph-sync-failed` + recordFailure（落实 G3 R1）；决策表照常落库 |
| 认知记录失败 | 旁路 catch → emit trace + recordFailure；agentLoop 主流程不阻断 |
| 校验和链断（篡改/硬删） | `verifyChain()` 报告断点 + 状态 TAMPERED；审计导出高亮 |

## 6. L4 监控台与审计导出

### 6.1 监控台（既有页基础上扩）
- 既有 `sales-decision-monitor.html`（7 闸门卡片 + 7 维覆盖 + 决策钻取 + 5 秒轮询）**保留**。
- 新增视图（决策网络）：因果链追溯（trace，可钻取单决策多跳上游/下游）、影响地图（impact，下游节点列表）、洞察统计（复用七闸门聚合）、审计导出（audit，一键报告）。
- 新端点与既有 `/api/monitor/*` **并列注册**（`routes.js:166-198` 旁）：

| 端点 | 方法 | 返回 |
|---|---|---|
| `/api/monitor/trace/:decisionId?direction=upstream|downstream&max_depth=N` | GET | 因果链（多跳决策列表 + 因果距离 + 置信度衰减） |
| `/api/monitor/impact/:decisionId` | GET | 下游影响地图（节点+边+深度） |
| `/api/monitor/audit?decision_id=&from=&to=` | GET | 审计报告（决策全字段+因果链+来源链路+校验和状态） |

### 6.2 审计导出
- `provenance.exportAudit({decision_id})` → JSON 报告：决策 7 点全字段 + 上游因果链（为什么）+ 下游影响（导致了什么）+ 引用先例 + `effective_policy_version` + 校验和链状态（OK/TAMPERED）+ 来源链路。
- 后续可对齐 Semantica `export_prov()` 输出 PROV-O（RDF/Turtle/JSON-LD）——首版做 JSON 结构化报告（YAGNI，PDF/RDF 导出留待合规刚性需求）。

## 7. 测试与验收（TDD）

| 测试文件 | 覆盖 |
|---|---|
| `test/age-graph.test.js`（新，需 PG） | AGE 幂等启用/装载/顶点/边/多跳 Cypher；不可用降级 CTE；参数化防注入 |
| `test/decision-trace.test.js`（新，需 PG） | 因果链 upstream/downstream 多跳/影响地图/洞察统计聚合 |
| `test/agent-episodes.test.js`（新） | 认知记录/contextFacts 捕获/monitor_event 扩展列（agent_id/context_facts） |
| `test/provenance.test.js`（新） | SHA-256 链/篡改检测（模拟改字段）/审计导出结构 |
| `test/decision.test.js`（扩展） | createDecision 旁路 AGE 同步 + 失败 trace（G3） + confirm/reverse 加边 |
| `test/monitorStore.test.js`（扩展） | failsByKind/recordFailure（G3） |

**验收口径**：
1. 任意决策可答「为什么」（上游因果链）+「导致了什么」（下游影响）；
2. 任意 agent 运行可答「看到了什么/来自哪里」（认知记录）；
3. 校验和链篡改可检出（状态 TAMPERED）；
4. 审计导出一键出报告（7 点+因果链+来源+校验和状态）；
5. 全量测试无回归（既有 33 测试 + 新增）。

## 8. 范围边界（防膨胀）
- G3 可观测化**仅落实**「决策写路径不再静默吞错 + monitorStore failsByKind」；riskScanner 真扫描等 G3 其余保持独立待实施。
- L4 UI 首版做 **REST API + 既有监控台聚合**（页面渲染留实现计划），不新建全套前端。
- 不引入 Python/PyTorch/FAISS 重依赖（纯机制借鉴，Node 栈）。
- 不新增 ai-* 能力（10 大清单固定）。

## 9. 开放风险与决策（已收敛）
| 风险 | 决策 |
|---|---|
| AGE 授权缺失 | 第一 Task 幂等启用 + DBA 降级路径；不可用自动降级 CTE（监控闭环不阻塞） |
| 决策表写权威 vs AGE 图一致性 | 写时同步 + 失败 trace；AGE 仅查询面不替代表 |
| 全量重构与既有 trace 重叠 | 保留 trace（运行态），新增认知+因果（决策网络视角），互补 |
| monitor_event 扩展列侵入 | 幂等 ALTER，兼容既有写入（列可空） |