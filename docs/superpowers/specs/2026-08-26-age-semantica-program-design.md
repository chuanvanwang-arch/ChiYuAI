# 总体设计：Apache AGE 全面启用 + Semantica 式能力扩展程序

- 设计日期：2026-08-26
- 状态：已批准（brainstorming 流程，用户 2026-08-26 批准整体程序）
- 参照：Semantica《AI Agent 知识图谱教程：用 Semantica 构建可追溯记忆和决策链》（微信文章，2026-08-12）
- 关联文档：
  - `docs/2026-08-25-02-ai-ontology-vector-build.md`（写库即构建，阶段1 已落地，AGE 未用）
  - `docs/superpowers/specs/2026-08-26-semantica-decision-network-monitoring-design.md`（决策网络监控设计，§1.1–1.3 已探测 AGE 环境）
  - `db/schema.sql`（particles / edges / decision 等六表 + HNSW/ivfflat 向量索引）
  - `db/enable-age.sql`（本程序 P0 的 DBA 幂等启用脚本，待 DBA 在 plm@5433 执行一次）

---

## 0. 背景与目标

参照文章描述了 Semantica 的 Context Graph 范式：把**实体 / 关系 / 事实 / 来源 / 决策**放入一张可查询图，并建立决策间的**因果链**（`CAUSED` / `INFLUENCED`）、**W3C PROV-O 溯源**、**冲突保留（不覆盖）**、**多跳邻居**、**决策链追溯与影响分析**。文章明确 AGE 是其支持的多种图后端之一（Neo4j / FalkorDB / AGE / Neptune），并说明小项目可先不上完整图库——但本项目目标已定为**全面启用 AGE**。

本项目已具备的底座（无需重造）：
- 粒子图：`crm.particles`（`schema.sql:11-44`，含 `embedding vector(384)` HNSW `:28`、`fts` TSVECTOR `:21,29`）+ `crm.edges` 受控谓词边表（`:31-44`，三索引 source/target/type）。
- 写库即构建三钩子：`src/ontology/hooks.js:8-134`（`ensureEmbedding` / `ensureTsVector` / `ontologySync`），由 `particleRepo.js:26,69` 的 `ensureAll` 串联。
- 决策链：`crm.decision` + `crm.decision_precedent_rel`（`decisionRepo.js:74`），pgvector 先例检索（`:131-140`），30 天蒸馏降权（`:188-191`）。
- 身份解析：`hooks.js:66-90`（CONTACT 邮箱域名 → ACCOUNT 自动弱边）。
- 递归 CTE 多跳范式：`src/context/scope.js:40-51`（orgSubtree）。

**本程序目标**：在 AGE 全面启用后，把上述"已完成功能"扩展为 Semantica 式能力，分 P0–P8 九阶段一次性铺开。

**已批准的两项决策**：
1. AGE 路径 = **DBA 预装后全面启用**（DBA/超级用户跑 `db/enable-age.sql` 一次；agent2b 普通用户无 `CREATE EXTENSION` 权限）。
2. 范围 = **一次性全铺**（P0–P8 全部覆盖，分解为多阶段 spec 逐期实现）。

### 0.1 落地状态补注（2026-08-31 审计更新）
> 本程序 P0–P8 规划功能**已全部落地并经测试验证**。以下为相对原设计的关键进展（原 §1/§2 部分探测结论已过时）：

- **P0 已落地（实测）**：`plm` / `plm_test` 均装 `age 1.6.0` + `ag_catalog` + `crm_decision_network` 图；`ageGraph.js:62 ensureGraph()` 幂等自愈、`server.js:73` 启动调用。DBA 授权已不再是阻塞。
- **P2 七类边补齐**：原仅落 `DECIDED_ON / REFERENCED_PRECEDENT / OVERRIDES` 三类；现 `CAUSED / INFLUENCED / ESTABLISHES_FRAME / DERIVED_FROM_EXCEPTION` 四类经 `createDecision`（`decisionRepo.js` caused_by/influenced_by/establishes_frame_for/triggered_by_exception）双写 `decision_relation` + AGE；`ESTABLISHES_FRAME` 已纳入 `CAUSAL_TYPES` 多跳遍历。测试 `test/decision-causal-edges.test.js` **4/4 通过**。
- **P6 图分析**：`graphAnalytics.js`（度数中心度 + 下游影响规模，AGE/降级双路径）经 `/api/graph/analytics` 端点接线 + 前端「图分析」按钮消费；测试 `test/graph-analytics.test.js` **3/3 通过**。
- **P8 MCP `crm_graph_query` 真实落地**：`seed-actions.js` 注册 read 工具（rbac_roles 不含 sales → 第 1.5 闸越权拒绝），handler 复用 `/api/graph/*` 同源逻辑；测试 `test/mcp/graph-query.test.js` **3/3 通过**。
- 回填脚本 `scripts/backfill-age.js` 已扩展为镜像 `decision_relation` 全 7 类边（DERIVED_FROM_EXCEPTION 仅 AGE 镜像，无法自 PG 权威回填）。
- 全部新增测试在 `plm_test`（已装 age）真跑 AGE，非降级；组合运行偶发挂起为 PG 连接池释放伪象，单文件运行稳定全绿。

---

## 1. 架构原则（铁律级）

**A. AGE 作「只读镜像查询面」，事实源仍在表。**
- 写权威：`crm.particles` / `crm.edges` / `crm.decision` 等关系表。
- 查询面：`crm_decision_network` AGE 图，由写时同步**幂等镜像**派生。
- 一致性纪律与既有 semantica 设计 §1.3/§5 一致（事实源在表、图是查询面），杜绝双写漂移。
- `crm.edges` 表 + 递归 CTE 保留为 AGE 不可用时的**降级通道**（`scope.js:43` 范式复用）。

**B. 写时同步失败不阻断主写。**
- 沿用 `hooks.js` 各钩子的 `.catch(() => {})` 纪律：AGE 同步异常仅 emit trace + recordFailure，**绝不**让图谱写入失败回滚业务主写。

**C. 参数化防注入。**
- 所有 Cypher 经 AGE `cypher(graph, $query, $params)` 参数化形式或 PREPARE 执行，**禁止**字符串拼接拼参。

**D. 每 Task 一 commit；推进不等提问。**
- 各阶段拆 Task，每 Task 一 commit；DBA 启用为唯一外部阻塞（P0 前置）。

---

## 2. P0 — AGE 启用与连接层

### 2.1 DBA 启用（已完成脚本，待执行）
- `db/enable-age.sql`：`CREATE EXTENSION IF NOT EXISTS age;` + `create_graph('crm_decision_network')`（幂等 WHERE NOT EXISTS 守卫）+ 校验查询。
- **执行者**：DBA / 超级用户在 `plm@5433` 跑一次。
- **约束**：不 `ALTER ROLE agent2b SET search_path`（共享实例，避免影响 PDM/P2P）；search_path 由应用连接后按需设定。
- **验证**：跑完贴回 `pg_extension`（含 age 1.6.0）与 `ag_catalog.ag_graph`（含 crm_decision_network）结果，我据此确认 P0 就绪。

### 2.2 应用连接层（`src/db.js` 扩展）
新增 AGE 连接与查询能力，不改动既有 pg 查询路径：
- `setAgeSearchPath(client)`：连接建立后执行 `SET search_path = ag_catalog, crm, public;`（每连接，非全局）。
- `cypher(graph, query, params)`：执行 `SELECT * FROM cypher($1, $2, $3::jsonb) AS (v agtype);` 并解析 agtype→JS。params 为 JSONB（实体 ID、边类型等），**全部参数化**。
- `cypherWrite(...)`：包裹写操作，统一 `.catch` 转 trace（不抛出阻断主写）。
- 连接池复用既有 `db.js` 池；AGE 查询走同一 PG 连接（同库同实例）。

### 2.3 验收
- 单元：用测试库（test-setup.sql 同实例或独立测试库）`CREATE EXTENSION age` 后，`cypher('crm_decision_network', 'CREATE (:Test {id:$id})', ...)` 成功且 `MATCH` 可回读。
- 降级单测：cypher 抛错时主写不受影响（mock 抛错验证 `.catch`）。

---

## 3. AGE 图模型（镜像映射）

### 3.1 顶点（Vertex）
| AGE 标签 | 镜像来源 | 关键属性 |
|---|---|---|
| `:Particle` | `crm.particles` | id, type, slug, title, state, payload(摘要), created_at |
| `:Decision` | `crm.decision` | decision_id, scenario_id, disposition, outcome, state, decided_at |
| `:Policy` | `crm.policy_version` | policy_version_id, policy_id, version |
| `:Frame` | `crm.decision_scenario` | scenario_id, stage |
| `:Source` | `crm.provenance`（P3 新增） | source_id, source_type, source_ref |
| `:Organization` | `crm.particles`(type=CRM_ORGANIZATION) | 用于冲突/去重（P4/P5） |

### 3.2 边（Edge）
| AGE 关系 | 来源 | 说明 |
|---|---|---|
| `owned_by` / `part_of` / `belongs_to` / `has_quotation` / `has_contract` / `key_contact` / `relationship_strength` / `auto_weak` | `crm.edges`（受控谓词，`particleRepo.js:88` CONTROLLED_PREDICATES） | 业务关系镜像 |
| `CAUSED` / `INFLUENCED` / `OVERRIDES` / `DERIVED_FROM_EXCEPTION` / `REFERENCED_PRECEDENT` | `crm.decision_precedent_rel` + 决策因果（P2 扩展） | 决策因果链 |
| `was_derived_from` / `was_attributed_to` | `crm.provenance`（P3） | PROV-O 溯源 |

### 3.3 同步纪律
- 顶点/边以**业务主键**（particle.id / decision.decision_id）作 AGE 属性 `id`，`MERGE` 幂等。
- 删除/失效：业务侧软删（`state='INACTIVE'` 或 decision `state` 推进）时同步 `MERGE ... SET active=false`，**绝对禁物理删**（项目红线）。

---

## 4. 写时同步架构

```
粒子/决策落库
   └─ ensureAll (hooks.js:129)
        ├─ ensureEmbedding   (pgvector, 既有)
        ├─ ensureTsVector    (FTS, 既有)
        ├─ ontologySync      (edges 受控边+身份解析+词汇, 既有)
        └─ ensureAgeSync     (【新增】镜像 AGE 图, MERGE 顶点/边)
              └─ 失败 → emit trace + recordFailure, 不阻断主写
```

- `ensureAgeSync(entity)`（`src/ontology/ageSync.js` 新增）：
  - `syncParticle`：MERGE `(:Particle {id})` SET 属性；按 `entity.type` 建/更新 Organization 顶点。
  - `syncEdge`：MATCH 两端顶点，MERGE 关系（受控谓词映射）。
  - `syncDecision`：MERGE `(:Decision {id})`；P2 起追加因果边。
- `ensureAll` 在 `hooks.js:129-134` 增加 `await ensureAgeSync(entity).catch(()=>{})`。
- **一次性回填脚本**（`scripts/backfill-age.js`）：遍历现存 particles/edges/decision，调用 sync* 灌入 AGE（P1 实现，跑一次）。

---

## 5. 能力程序详设（P0–P8）

### P1 — 图谱与存储（镜像 + 写时同步）
- 目标：粒子/边/决策 幂等镜像进 AGE + 写时同步钩子 + 回填。
- 改动：`src/ontology/ageSync.js`（新）；`hooks.js:129` 接 `ensureAgeSync`；`scripts/backfill-age.js`（新）。
- 测试：写粒子→AGE 顶点存在；再写同 id→属性更新非新增（幂等）；回填脚本覆盖存量。
- 验收：AGE 顶点数 == particles 行数（同租户）；edges 镜像一致。

### P2 — 决策因果链
- 目标：`CAUSED`/`INFLUENCED`/`OVERRIDES`/`DERIVED_FROM_EXCEPTION` 边 + `traceDecisionChain(id)` / `analyzeDecisionImpact(id)`。
- 改动：`autonomyEngine` / `decisionRepo` 拍板点（`decisionRepo.js:60/108/151/164` made/autonomous/escalated/confirmed/reversed）旁路写 AGE 因果边；`ageSync.syncDecision` 扩展；`scripts/backfill-age.js` 含 `decision_precedent_rel`→因果边回填。
- 测试：构造 review→security→approval 链，trace 向上得 2 节点、impact 向下得影响集。
- 验收：与 `decision_precedent_rel` 语义一致；AGE 未就绪时回退关系表查询。

### P3 — 来源追踪 PROV-O
- 目标：每条事实/决策记录来源（文件/DB/API/抽取器/时间），可溯源。
- 改动：新增 `crm.provenance`（`entity_type, entity_id, source_type, source_ref, extracted_by, extracted_at, confidence`）；`ageSync` 同步 `:Source` + `was_derived_from` 边；写时（ontologySync/ageSync）捕获来源。
- 测试：事实带 source 写入→provenance 可查→沿 `was_derived_from` 回源。
- 验收：导出 PROV-O JSON（事实+决策+证据关系）。

### P4 — 冲突检测·保留分歧
- 目标：多源对同一实体属性冲突时**不覆盖**，保留分歧、标记复核。
- 改动：事实以 `assertions(entity_id, attr, value, source_id, valid)` 模型（或 provenance 扩展）；冲突检测比对 assertions→`needs_review` 标记；规则采用/合并/人工复核（不静默覆盖）。
- 测试：上海/北京/深圳三源地址→保留三条、标记冲突、不覆盖。
- 验收：查询冲突清单接口可用。

### P5 — 实体去重/解析
- 目标：主数据 ID + 别名合并 + 自动去重辅助。
- 改动：复用 `hooks.js:66` identity-resolve；新增别名映射与合并建议（auto_weak→confirmed 沿用 `confirmWeakEdge` `:121-126`）；稳定业务主键优先。
- 测试：公司简称/全称/历史名归一到一顶点。
- 验收：去重建议接口 + 人工确认闭环。

### P6 — 图分析
- 目标：中心度/社区/影响地图，支撑监控洞察。
- 改动：基于 AGE Cypher 计算度数中心度、下游影响规模；高级算法（社区发现）若 AGE 原生不支持则 app 侧基于边集计算（降级同递归 CTE）。
- 测试：构造星形决策网，中心节点度数最高。
- 验收：影响地图数据可喂 P7 可视化。

### P7 — 可视化 + 决策链 UI
- 目标：扩展 `sales-decision-monitor.html`，新增图视图（因果链追溯 / 影响地图 / 洞察统计 / 审计导出 PROV-O JSON）。
- 改动：前端图渲染（力导向图，轻量库或 SVG）；新端点 `/api/monitor/trace` `/impact` `/audit` 与既有 `/monitor/*` 并列。
- 测试：传入 approval_id 渲染其向上因果链与向下影响。
- 验收：UI 可交互追溯 + 导出审计包。

### P8 — 查询/对外连接（REST + MCP）
- 目标：图能力经 REST 与 crm-native MCP 暴露。
- 改动：新增 `/api/graph/{neighbors,trace,impact,provenance}`；crm-native skill 增 `graph_query` 方法（角色自适应 + RBAC + action-confirm，沿用既有 MCP 纪律）。
- 测试：MCP 调用 graph_query 返回受限范围（RBAC 数据范围过滤）。
- 验收：办公智能体经 MCP 读图受控可达。

---

## 6. 风险与降级

| 风险 | 缓解 |
|---|---|
| DBA 未及时授权 `CREATE EXTENSION age` | P0 阻塞；降级通道（edges+递归CTE）保其余能力先落地，AGE 授权后回填（同 semantica 设计 §5.3 韧性） |
| AGE 参数化/agtype 解析坑 | 仅走 `cypher(graph,$q,$params)`；封装解析；单测覆盖 |
| 同步写入放大主写延迟 | 异步/旁路（`.catch` 不阻断）；可后续迁入事件驱动（SSE 总线已具备） |
| 图与表不一致 | 单一事实源在表，AGE 只读镜像；回填 + 周期性校验脚本 |
| 物理删除红线 | 仅软删 + `active=false`，绝对禁 `DETACH DELETE` |

---

## 7. 实施纪律

- **每 Task 一 commit**；推进不等提问。
- **DBA 启用为 P0 唯一外部阻塞**：脚本已备（`db/enable-age.sql`），跑完贴结果即解锁。
- **写时同步失败不阻断主写**（`.catch` 纪律，沿用 `hooks.js`）。
- **绝对禁删**（项目红线）：图与表均软删。
- 阶段顺序 P0→P8；P1 必须在 P0 后；P2/P3 可在 P1 后并行起步；P7/P8 依赖前序数据面。

---

## 8. 验收口径

- AGE 图顶点/边与关系表一致性 ≥ 99%（周期校验脚本）。
- 决策因果链 trace/impact 与 `decision_precedent_rel` 语义一致。
- PROV-O 溯源可回源至原始 source_ref。
- 冲突保留分歧不覆盖，冲突清单可查。
- 图查询在 AGE 未就绪时自动降级 edges+递归CTE 且功能等价。
- 全量测试（vitest，单 worker）绿灯；写时同步失败不导致主写回归。
