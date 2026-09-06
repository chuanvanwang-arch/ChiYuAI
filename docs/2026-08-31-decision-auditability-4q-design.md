# 决策可审计性「4 问验证」与销售决策监控台结合设计文档

> 文档类型：设计文档（已落地，含实现状态对照）
> 创建日期：2026-08-31
> 关联文档：`docs/2026-08-26-semantica-decision-accountability-design.md`（G1–G7 决策问责设计）、`docs/2026-08-30-workbench-redesign-design.md`（门户作战室）
> 改动文件：`src/http/routes.js`、`src/web/sales-decision-monitor.html`、`test/http/provenance-turtle.test.js`

---

## §0 摘要（结论先行）

本设计把「Semantica 可信决策审计」方法论工程化为一套**决策可审计性 4 问验证法**，并深度嵌入销售决策监控台（`/sales-decision-monitor`）：

1. **4 问法**：① 解释直接原因 / ② 追溯到源头 / ③ 发现冲突事实 / ④ 看下游影响。每问映射到一个后端能力，聚合为「可审计性 N/4」健康度分。
2. **界面重设计**：监控台决策网络区简化为 4 个 TAB（Q1 直接原因 / Q2 源头溯源 / Q3 冲突事实 / Q4 下游影响），每个 TAB 内整合「问题摘要卡 + 深度视图」；顶部常驻「可审计性 4/4」健康条。
3. **单一事实源**：前端四面板 100% 复用后端 `/api/graph/*` 与 `/api/decision/:id/audit-4q`、`/api/decision/:id/provenance-turtle`，不重复任何逻辑。
4. **零硬编码**：UI 色值 100% 走 `tokens.css` 语义变量，Cytoscape 边色由 `_readTok('--ac')` + `_rotateHue` 色相环生成。

**实现状态**：后端端点、前端四面板、Turtle 导出、测试套件已全部落地；`provenance-turtle` 测试 4/4 绿、`audit-4q` 回归 4/4 绿。

---

## §1 背景与动机

销售决策由 AI Agent 自主或半自主作出，业务方需回答四个信任问题：**这个决策为什么这么定？依据从哪来？有没有互相打架的事实？它会影响后续哪些决策？** 这正是 Semantica（MIT 开源、面向可信 AI Agent 的图原生上下文与决策基础设施）的核心关切——「决策必须可解释、可溯源、可问责」。

平台已在 2026-08-26 两份 Semantica 设计文档中规划了图原生决策网络、PROV-O 溯源链、7 类决策边、冲突检测等能力（详见 `docs/2026-08-26-semantica-decision-accountability-design.md` G1–G7）。本设计把这些能力**收口为一个可被业务人员直接使用的 4 问验证看板**，并使之可同时服务于：

- **人工审计**：业务/合规人员逐决策核对四问，定位信任缺口。
- **回归测试**：4 问契约固化为测试（T-AUDIT4Q / T-PROVTTL），作为决策子系统回归基线。
- **运行时监控**：可审计性 N/4 健康度可接入 `/agents` SLA 看板（待办，见 §9）。

---

## §2 设计来源与可借鉴点（深度）

### 2.1 三篇 Semantica 文章的核心借鉴

| 来源要点 | 本平台落地形态 |
|---|---|
| 图原生上下文（Graph-native context）：决策不是孤立行，而是决策网络中的节点，边上携带维度/理由 | Apache AGE 图 `crm_decision_network`（生产库 541 顶点 / 186 边）；7 类决策边（`decision_relation`） |
| 溯源即基础设施（Provenance as infrastructure）：每条审计条目 append-only + SHA-256 链 | `crm.decision_provenance` 表 + `verifyChain` 校验；PROV-O 标准导出 |
| 冲突事实保留不删（multi-source inconsistency preserved）：多源不同值保留待裁决（`needs_review`） | `crm.assertions.needs_review`；`detectConflicts` 聚合为未裁决冲突 |
| 可解释性四维度（直接原因 / 源头 / 冲突 / 下游） | 本设计 4 问法逐维工程化 |

### 2.2 与既有能力的衔接（避免重复建设）

- **图查询层**：复用 `graphTraceHandler` / `graphImpactHandler` / `graphProvenanceHandler` / `listTypedEdges`（routes.js:2198–2235）。
- **溯源层**：复用 `exportAudit` + `exportTurtle`（provenance.js:95 / 129），Turtle 端点不再重写逻辑。
- **冲突层**：复用 `detectConflicts`（逐实体 `needs_review` 聚合）。
- **测试基座**：`createApp().fetch()` 进程内适配器（server.js:41），不启真实端口、避免 PG 连接池耗尽伪失败。

---

## §3 4 问审计法定义与工程映射

| 问 | 业务含义 | 后端能力（单一事实源） | 评分逻辑（routes.js:2294–2299） |
|---|---|---|---|
| **Q1 直接原因** | 能否解释这个决策的直接依据 | `graphTraceHandler(id)` 上游 + `decision.rationale` | `upstreamCount>0 \|\| hasRationale` → `pass`，否则 `warn` |
| **Q2 源头溯源** | 能否把决策追溯到不可篡改的源头 | `graphProvenanceHandler(id)` + `verifyChain` | `chainStatus==='OK'` → `pass`；`'TAMPERED'` → `fail`；其余 `warn` |
| **Q3 冲突事实** | 能否发现互相打架的事实 | `detectConflicts(entity)` 聚合 `needs_review` | 无冲突且扫过实体 → `pass`；有未裁决冲突 → `warn` |
| **Q4 下游影响** | 能否观测该决策的下游传导链 | `graphImpactHandler(id)` 下游节点 | `impact.error`→`fail`（下游影响计算失败）；`downstreamCount>0`→`pass`（影响链可观测）；`downstreamCount===0`→`warn`（孤立/叶子决策，影响面不可观测，合法但需关注） |

**健康度分算法**：`score = count(status==='pass')`；`total=4`；`needs_review_count = conflicts.length`。返回结构 `health{score,total,statuses{Q1..Q4},needs_review_count}`（routes.js:2300–2302）。

**排序原则（用户 2026-08-30 明确）**：按「是否影响决策效果 / 是否影响业务闭环」重排 P0–P2——Q2 链被篡改（业务闭环断裂、问责失效）为最高危 `fail`；Q3 未裁决冲突（决策效果失真）为 `warn`；Q1/Q4 缺失为可解释性降级 `warn`。

---

## §4 与销售决策监控台结合的架构

```
                ┌─────────────────────────────────────────────┐
                │  sales-decision-monitor.html（前端四面板）      │
                │  顶部：可审计性 N/4 健康条（常驻）              │
                │  TAB 组①四问审计：总览/A/B/C/D  组②其它视图     │
                └───────────────┬─────────────────────────────┘
                                │ 仅消费，不重复逻辑（单一事实源）
        ┌───────────────────────┼───────────────────────────────┐
        ▼                       ▼                                ▼
 GET /api/decision/:id/audit-4q   GET /api/graph/{trace,impact,   GET /api/decision/:id/
 （聚合四问+健康分）                provenance,edges}               provenance-turtle（PROV-O RDF）
        │                       │                                │
        └───────────┬───────────┴────────────────────────────────┘
                    ▼
   graphTraceHandler / graphImpactHandler / graphProvenanceHandler / detectConflicts
   （routes.js:2198–2235；provenance.js:95,129）
                    ▼
   crm.decision / crm.decision_relation / crm.decision_provenance / crm.assertions（PG 权威）
   Apache AGE crm_decision_network（镜像，仅读）
```

**数据流纪律**：前端每个面板只调一个端点、缓存命中（`DN_CACHE`）则直接 `dnRender`，不重算。面板 A/D 的 Cytoscape 构图：节点取 `trace`（上游/下游），边取 `/api/graph/edges` 按 `keep` 集过滤（HTML:976–995）。

---

## §5 界面与 TAB 重设计

### 5.1 4-TAB 结构（HTML:652–668）

```js
const DN_VIEWS = [
  { v: 'q1', label: 'Q1 直接原因' },
  { v: 'q2', label: 'Q2 源头溯源' },
  { v: 'q3', label: 'Q3 冲突事实' },
  { v: 'q4', label: 'Q4 下游影响' },
];
```

`_tabsHtml` 渲单行 4 个 TAB；`dnSwitch(v)` 经 `DN_LOADERS` 路由到 `dnLoadQ(q)`（HTML:863），统一拉取 `audit-4q`，Q2 额外拉取 `provenance`。

### 5.2 每个 TAB = 问题摘要卡 + 深度视图

| TAB | 顶部摘要卡 | 深度视图 | 数据来源 |
|---|---|---|---|
| **Q1 直接原因** | Q1 状态/问题/答案 | Cytoscape 上游子图 | `/api/decision/:id/audit-4q` + `/api/graph/trace` + `/api/graph/edges` |
| **Q2 源头溯源** | Q2 状态/问题/答案 | PROV-O 链卡片 + 先例 + append-only 时间线 + **导出 Turtle 按钮** | `/api/decision/:id/audit-4q` + `/api/graph/provenance` |
| **Q3 冲突事实** | Q3 状态/问题/答案 | conflict 双值并陈列（`needs_review`） | `/api/decision/:id/audit-4q` Q3 |
| **Q4 下游影响** | Q4 状态/问题/答案 | Cytoscape 影响地图 | `/api/decision/:id/audit-4q` + `/api/graph/trace` + `/api/graph/edges` |

`_qHeaderHtml(a4,q)`（HTML:693）生成单个问题摘要卡，取代原 2×2 四问卡；`_summaryHtml` + `_healthStrip` 仍常驻顶部，显示根决策摘要与可审计性 N/4。

### 5.3 Turtle 导出（面板B 按钮）

`dnExportTurtle`(997) → `GET /api/decision/:id/provenance-turtle?download=1` → 下载 `provenance-<id>.ttl`（W3C PROV-O RDF，`text/turtle`）。零额外逻辑，复用 `exportAudit`+`exportTurtle`。

---

## §6 后端端点契约

### 6.1 `GET /api/decision/:id/audit-4q`（routes.js:2255–2319）
- 鉴权：`requireMe`（无 token → 401）；决策不存在 → 404。
- 并行聚合 `trace` / `impact` / `prov`，逐实体 `detectConflicts` 归并 Q3（routes.js:2264–2288）。
- 响应：`{ decision_id, health{score,total,statuses,needs_review_count}, questions{Q1..Q4{key,question,status,answer,...}} }`。

### 6.2 `GET /api/decision/:id/provenance-turtle`（routes.js:2321–2343，本次新增）
- 鉴权：同；决策不存在 → 404。
- `?download=1` → `text/turtle` 附件（`Content-Disposition: attachment; filename="provenance-<id>.ttl"`）。
- 否则 `res.json({ decision_id, chain_status, turtle })`。
- Turtle 内容（provenance.js:95–114）：`@prefix prov:` + `crm:decision_<id> a prov:Entity ; prov:wasAttributedTo crm:agent_engine ; prov:generatedAtTime ...` + 每条审计条目 `prov:Activity`。

### 6.3 图端点（单一事实源，routes.js:2198–2235）
- `/api/graph/trace`、`/api/graph/impact`、`/api/graph/provenance`、`/api/graph/edges`、`/api/graph/analytics`。
- 均带 `requireMe` 鉴权；`decisionId/decision_id/entityId` 缺失 → 400。

---

## §7 前端实现要点与一致性纪律

1. **Cytoscape 复用**：`_drawCy(elements,containerId,legendId)` 为 Q1 上游子图 / Q4 下游影响共享渲染器；`_cy` 单例，切换时 `destroy()` 重建。
2. **配色零硬编码**：节点底取 `_readTok('--panel')`、描边/根取 `_readTok('--ac')`、文字取 `_readTok('--ink')`；7 类边色由 `_rotateHue(base, i*51)` 色相环生成。全文件无 `#fff/#1e293b` 等硬编码 hex（UI 一致性铁律）。
3. **PROV-O 链**：Q2 面板渲决策元信息 + 引用先例 + append-only 时间线（SHA-256 摘要切片展示），链状态徽标 `ok/err/warn`。
4. **冲突并陈列**：Q3 面板对每个 `conflicts[]` 实体属性，双值并排（`values.sort()`），来源逐条列出 `source_id/value/valid`。
5. **死代码清除**：删除原 11 个 TAB 与 2×2 摘要卡、移除 `renderTrueGraph` 等冗余函数；4-TAB 统一走 `_qHeaderHtml` + `_panelCyHtml`/`_panelBHtml`/`_q3Html`。
6. **无重复声明**：`let _cy = null` / `REL_TYPES_ORDER` / `_readTok` / `_rotateHue` 仅在文件下方 token 助手区定义一次。

---

## §8 测试契约与回归基线

| 测试文件 | 模式 | 用例 | 状态 |
|---|---|---|---|
| `test/http/audit-4q.test.js` | `createApp().fetch()` 安全模式；种子决策 `a444…444a4` + 实体 `b444…444b4` + 两条 `needs_review` 冲突 | 401 / 200（N/4 结构）/ Q3 冲突聚合 / 404 | 4/4 绿（回归通过） |
| `test/http/provenance-turtle.test.js`（本次新增） | 同模式，复用同一场景种子 | 401 / 200（含 `turtle` 字段与 PROV-O 三元组）/ `?download=1` 附件头 / 404 | 4/4 绿 |

**测试铁律（已记入项目记忆）**：
- vitest 强制连 `plm_test`（vitest.config.js:9），单 fork 顺序执行，防同库多文件并发 TRUNCATE 踩踏。
- `app.fetch` 适配器的 `res.headers` 是 Node 原生 `IncomingMessage.headers`（小写键、非 `Headers` 实例），断言须用 `res.headers['content-type']`，**不可用 `.get()`**（T-PROVTTL 已修正验证）。
- 多文件同进程跑偶发连接池伪失败；各文件分进程 `vitest run <file>` 稳定绿。
- `routes.js` 改动需**重启 server** 生效（routes 改动非热加载）。

---

## §9 实现状态对照与待办风险

### 9.1 已落地（本设计全部条目）
- [x] 后端 `audit-4q` 聚合端点 + 健康度 N/4 评分
- [x] 后端 `provenance-turtle` 端点（含 `?download=1`）
- [x] 前端简化为 4 个 TAB（Q1–Q4），每个 TAB 整合问题摘要卡 + 深度视图
- [x] 顶部健康条常驻
- [x] Cytoscape 上游/下游子图复用 `_drawCyPanel`
- [x] PROV-O 链面板 + Turtle 导出按钮
- [x] 冲突双值并陈列（needs_review）
- [x] 测试套件（audit-4q 回归 + provenance-turtle 新增）全绿
- [x] Q4 评分细化（2026-08-31）：Q4 不再恒 `pass`，`impact.error`→`fail` / 有下游→`pass` / 无下游→`warn`，经 `computeAudit4q` 单一事实源同步作用于单决策 `audit-4q` 与平台级 `/api/monitor/auditability` SLA 聚合

### 9.2 待办与风险
1. **server 已重启验证通过**：`routes.js` 改动生效；`sales-decision-monitor.html` 静态文件已可访问。实机验证 4 问看板 + Turtle 下载已在本会话完成。
2. **git 提交**：沙箱无凭证，AI 未代提交；需本地提交 `src/http/routes.js`、`src/web/sales-decision-monitor.html`、`src/portal/agentsPage.js`、`src/web/agents.html`、`test/http/provenance-turtle.test.js`、`test/http/auditability-sla.test.js`、本设计文档。
3. **SLA 接入（已落地 2026-08-31）**：可审计性 N/4 已接入 `/agents` SLA 看板（新增 `GET /api/monitor/auditability` 公开聚合端点 + `renderAuditabilitySla` 卡片），成为平台级 SLA 指标。
4. **Q4 评分细化（已落地 2026-08-31）**：Q4 不再恒 `pass`——`impact.error`→`fail`（下游影响计算失败）；`downstreamCount>0`→`pass`（影响链可观测）；`downstreamCount===0`→`warn`（孤立/叶子决策，影响面不可观测，合法但需关注）。评分口径经 `computeAudit4q` 单一事实源，单决策 `audit-4q` 与平台级 `/api/monitor/auditability` SLA 同步生效（routes.js:2292–2294、2308–2312）。

---

## 附录 A 关键字段契约

**`audit-4q` 响应**
```json
{
  "decision_id": "uuid",
  "health": { "score": 4, "total": 4,
    "statuses": { "Q1":"pass","Q2":"pass","Q3":"pass","Q4":"pass" },
    "needs_review_count": 0 },
  "questions": {
    "Q1": { "key":"direct_cause","question":"能否解释直接原因","status":"pass",
            "upstream_count":3,"has_rationale":true,"answer":"上游 3 条先例 + 决策理由" },
    "Q2": { "key":"source_trace","question":"能否追溯到源头","status":"pass",
            "chain_status":"OK","entries":5,"answer":"PROV-O 链完整性 OK" },
    "Q3": { "key":"conflict_facts","question":"能否发现冲突事实","status":"warn",
            "entities_scanned":1,"unresolved_count":1,
            "conflicts":[{"entity_id":"...","attr":"customer_name","values":["张三","李四"],"sources":[...]}] },
    "Q4": { "key":"downstream_impact","question":"能否看下游影响","status":"pass",
            "downstream_count":2,"depth":1,"answer":"下游 2 个节点 / 最大 1 跳" }
  }
}
```

**`provenance-turtle` 响应（JSON 模式）**
```json
{ "decision_id":"uuid", "chain_status":"OK",
  "turtle": "@prefix prov: <http://www.w3.org/ns/prov#>.\n@prefix crm: <http://localhost:3000/crm#>.\ncrm:decision_<uuid> a prov:Entity ;\n  prov:wasAttributedTo crm:agent_engine ;\n  prov:generatedAtTime \"...\" .\n..." }
```
