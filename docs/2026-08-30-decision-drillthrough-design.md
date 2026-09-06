# 单决策穿透追溯与字段全落库设计（决策闭环前台视图 + 数据底座）

- 日期：2026-08-30
- 触发：用户要求"页面展示按单个决策穿透追溯；所有决策字段都要落库"
- 上层设计（必读对齐）：
  - `2026-08-30-semantica-decision-accountability-design.md`（C-DAI v2：三图闭环 K/M/J + D1–D5 跨环映射）
  - `2026-08-30-j2-j3-comprehensive-design.md`（J2 反馈闭环 / J3 校准闭环）
  - `2026-08-30-full-traceability-root-cause-design.md`（四层全链路溯源 J→M→K→粒子库）
- 方法论：`ai-portal-page-generation`（受控渲染）+ `ai-memory-lifecycle`（M 落库）+ `ai-feedback-loop`（J2/J3 回写）
- 状态：**待批准**（批准前不写实现代码；commit 由用户本地执行）

---

## §0 执行摘要（先结论）

用户要求拆成两件事，本设计一并覆盖：

1. **单决策穿透追溯（drill-through）**：在 `sales-decision-monitor` 页面，从决策任务列表行点击 → 弹窗内不仅展示"决策之间"的网络（现有 `openDnModal`），**新增"决策闭包"视图**——把单个决策内部拆成 K 知识图谱 / M 上下文图谱 / J 决策图谱三区，并用 D1–D5 跨环映射把三图连成可追溯的闭环。
2. **所有决策字段全落库（零空列）**：核查真实代码发现 `createDecision`（`decisionRepo.js:68-79`）**漏落 4 列**（`confidence`/`root_cause`/`feedback`/`feedback_link`），且 `decision_relation`/`decision_outcome` 两张跨环专表**真实库未迁移**。本设计补齐落库路径 + 迁移，使三图闭环在真实数据里可闭合。

**核心判定**：前端"决策闭包"视图不是新概念，而是把 C-DAI v2 的 §2（三图构建-使用-进化）与 §3（D1–D5 跨环映射）**落到一个 HTTP 聚合端点 + 一个受控渲染页签**。后端新增 `GET /api/decision/:id/closure`，前端 `openDnModal` 新增"三图闭环"页签。

---

## §1 当前真实状态对账（代码事实，非理论）

### §1.1 `createDecision` 落库字段现状（`decisionRepo.js:68-79`）

INSERT 实际写入的列：
```
scenario_id, trigger_context, involved_entities, conditions_evaluated,
effective_policy_version, disposition, decider_type, decider_id, decider_role,
rationale, referenced_precedents, business_tier, state, outcome, embedding, attribution, decided_at
```

**未写入但 schema 已存在的列（漏落库）**：
| 列 | schema 位置 | 漏落后果 |
|---|---|---|
| `confidence` | 迁移列（G5 提列） | J2/J3 反算结果无处落；v2 §4 G5"唯一定义"未贯通到物化 |
| `root_cause` | 迁移列（6.1） | J3 根因无法附着在决策上 |
| `feedback` | 迁移列（6.1） | J2 业务反馈无法落库（仅 `outcome` 经 `writebackOutcome` 写） |
| `feedback_link` | `schema.sql:168` | 反馈关联外键空置 |

`human_*` 四列（`:179-183`）由 `writebackHumanDisposition`（`decisionRepo.js:282-291`）回写，物化时为空——**属正常**（人工处置滞后发生），但 J2/J3 回写路径必须接通。

### §1.2 `decision` 表列全景（`schema.sql:153-189` + 迁移）

必填约束（`NOT NULL`）：`trigger_context` / `involved_entities` / `conditions_evaluated` / `disposition` / `decider_type` / `rationale` / `business_tier` / `state`。这些在真实库调试决策里**被传了空对象/空数组**（导致闭包断），需调用方真实填充（见 §3.4 守卫）。

### §1.3 跨环专表存在性（真实库探测，2026-08-30 12:12）

| 表 | 状态 | 影响 |
|---|---|---|
| `decision_relation`（E1–E7 + `serves_dimension`） | **不存在（relation does not exist）** | D2 M→J 的"决策引用情境节点"边无载体 |
| `decision_outcome`（J2 业务结果） | **不存在** | D4 J→M 反馈反哺断 |
| `attribution` | 是 `decision.attribution` JSONB 列（非表），已落 | 七态（6.4）待升级 |
| `calibration_patch` | 存在，0 行 | D3 J→K 写回暂空 |

### §1.4 前端弹窗现状（`sales-decision-monitor.html:877-904`）

`openDnModal(id)` 结构：`dn-modal` → `dn-modal-panel` → `dn-modal-head` + `dn-modal-body`。
默认渲染 `dnGraph()`（决策网络，决策**之间**的 7 类 `decision_relation` 边 via Cytoscape）。另有 trace/impact/audit 页签（`:855-873`）。
**缺口**：无"单决策内部三图分解 + 跨环映射"视图。任务列表点击（`:951` `openDnModal(d.decision_id)`）是穿透入口，但落点是"网络"而非"闭包"。

### §1.5 三图闭环真实闭合度（2026-08-30 真实追溯）

逐决策真实追溯结果：闭包闭合度 **40%**（D1 K→M ✅、D5 K↔M ✅；D2 M→J ❌、D3 J→K ❌、D4 J→M ❌）。根因即 §1.1–§1.3 的漏落库 + 未迁移。

---

## §2 设计目标与原则

| 目标 | 说明 |
|---|---|
| **G-A 单决策穿透追溯** | 任一决策可一键穿透到"三图闭环"视图，看清它引用了哪些 K 粒子、M 给了哪些上下文、J 自身判定 + J2 outcome + J3 calibration，以及 D1–D5 如何在三者间流动 |
| **G-B 所有字段全落库** | `decision` 表 21 列 + 跨环专表 `decision_relation`/`decision_outcome` 全部有写入路径，零空列（除业务滞后发生的 `human_*`/`outcome`/`root_cause`/`feedback` 允许初始空，但必须有回写路径且不为 NULL 约束阻断） |
| **G-C 复用不重复** | 不新建第二套决策图；`closure` 端点复用现有 `/api/graph/*` + `decisionRepo` 能力 |
| **G-D 受控渲染铁律** | 新增页签 100% 走 `common.css`（`.panel/.sect/.card`）+ `tokens.css` 语义变量，零硬编码色值（违反则整页回落白底，见 UI 铁律） |
| **G-E 第0闸** | 任何写回 K/M 的校准（D3/D4）必经 `produceDecision`（`scenario_id='CALIBRATION_CHANGE'`），`decision_id` 落 `calibration_patch` |

---

## §3 数据层：所有决策字段全落库

### §3.1 `createDecision` 补齐落库（`decisionRepo.js:68-79`）

INSERT 增加 4 列写入：
```js
// 现有 input 解构增加：
const { confidence = null, root_cause = null, feedback = null, feedback_link = null } = input;
// INSERT 列增加 confidence, root_cause, feedback, feedback_link
// 值：$17=confidence, $18=root_cause, $19=feedback, $20=feedback_link
```
- `confidence`：由 `computeConfidence`（`decisionRepo.js:14` 已 import）在物化时反算写入（G5 唯一定义贯通）。
- `root_cause`/`feedback`：物化时允许 NULL；J2 `writebackOutcome`（`decisionRepo.js:294-301`）扩为同时写 `feedback`+`root_cause`（对齐 j2-j3 设计）。

### §3.2 迁移落地跨环专表

**`decision_relation`**（E1–E7 + `serves_dimension`，对应 C-DAI v2 §4 G1 + 6.2）：
```sql
CREATE TABLE IF NOT EXISTS crm.decision_relation (
  id            BIGSERIAL PRIMARY KEY,
  from_decision UUID NOT NULL REFERENCES crm.decision(decision_id),
  to_decision   UUID REFERENCES crm.decision(decision_id),
  to_particle   TEXT,                       -- 指向 K 粒子 id（D2 载体）
  rel_type      TEXT NOT NULL CHECK (rel_type IN
                ('DECIDED_ON','REFERENCED_PRECEDENT','DERIVED_FROM_EXCEPTION',
                 'ESTABLISHES_FRAME','OVERRIDES','CAUSED','INFLUENCED')),
  serves_dimension TEXT,                    -- 绑 L1–L7 维度（6.2）
  props         JSONB DEFAULT '{}',
  UNIQUE (from_decision, to_decision, to_particle, rel_type)
);
```
物化时在 `createDecision` 内遍历 `involved_entities` 生成 `DECIDED_ON`→`to_particle`（D2 边）；遍历 `referenced_precedents` 生成 `REFERENCED_PRECEDENT`（已有 `decision_precedent_rel`，此处扩为统一 `decision_relation`）。

**`decision_outcome`**（J2 业务结果，对应 6.1）：
```sql
CREATE TABLE IF NOT EXISTS crm.decision_outcome (
  id            BIGSERIAL PRIMARY KEY,
  decision_id   UUID NOT NULL REFERENCES crm.decision(decision_id),
  outcome_type  TEXT NOT NULL,             -- business_success / business_fail /人工采纳 / 人工拒
  verified      BOOLEAN,
  source        TEXT,                      -- task/trace/approval/particle/payment 总线事件
  payload       JSONB DEFAULT '{}',
  occurred_at   TIMESTAMPTZ DEFAULT now()
);
```
由 `outcomeIngester`（订阅 SSE 五域总线）写入，`writebackOutcome` 改为优先写此表 + 冗余回写 `decision.outcome`/`feedback`。

### §3.3 `attribution` 七态升级（C-DAI v2 §4 之 6.4）

`computeAttribution`（`attribution.js`）当前输出 `category` 三态（ok/warning/error）。扩为**七态**：`ok / missing_context / low_confidence / conflict / reversed / pending_outcome / drift`，并加 `edge_compliance`（E1–E7 应存/实存/缺）。落库列不变（`decision.attribution` JSONB），仅结构升级。

### §3.4 写时必填守卫（杜绝"全空调试决策"）

`createDecision` 在 `sevenDimensionsCheck`（`:63`）前增加**实体/上下文非空守卫**：
```js
if (!Array.isArray(involved_entities) || !involved_entities.length)
  throw new Error('decision 缺 involved_entities（K 引用断）');
if (!trigger_context || Object.keys(trigger_context).length === 0)
  throw new Error('decision 缺 trigger_context（M 上下文断）');
```
注意：`NOT NULL` 约束下空 `{}` 能入库但破坏闭包，故用**业务守卫**拦截空对象（不靠 SQL 约束，避免与遗留数据冲突）。

---

## §4 API 层：单决策穿透追溯端点

### §4.1 新增 `GET /api/decision/:id/closure`

一次性聚合 K/M/J 三区 + 跨环映射，前端单请求渲染（避免并发 5+ 请求）。
**复用**：`/api/graph/neighbors`（K 邻居，`routes.js:1916`）、`/api/graph/edges`（7 类边）、`/api/decision/:id/outcome`（J2）、`/api/calibration/patches`（J3）、`getDecision`（`decisionRepo.js:166`）。

**响应 schema**：
```jsonc
{
  "decision": { /* decision 全列 + attribution + confidence + root_cause + feedback */ },
  "k": {
    "particles": [ { "id":"s1", "type":"CRM_DEAL", "attrs":{...}, "edges":[...21谓词...] } ],
    "freshness": { "source_refresh_sla":"...", "age_days": 3, "status":"fresh|stale" },
    "write_check": { "meta_attr_valid": true }   // 6.6 SHACL-equivalent
  },
  "m": {
    "trigger_context": {...}, "conditions_evaluated": [...],
    "effective_policy_version": "pv-2026-08", "memory_snapshot": {...},
    "decision_relation": [ {rel_type, to_particle, serves_dimension, props} ]  // E1–E7
  },
  "j": {
    "disposition":"...", "confidence":0.93, "state":"CONFIRMED",
    "outcome": [...decision_outcome rows...],            // J2
    "calibration": [...calibration_patch rows...]        // J3
  },
  "crossLoopMap": {                 // D1–D5 跨环映射（显式边）
    "D1_K_to_M": { "exists":true,  "carrier":"involved_entities→decision.involved_entities" },
    "D2_M_to_J": { "exists":true,  "carrier":"decision_relation.DECIDED_ON→to_particle" },
    "D3_J_to_K": { "exists":false, "carrier":"calibration_patch(knob=PARTICLE_ATTR_ADD)→particles" },
    "D4_J_to_M": { "exists":false, "carrier":"decision_outcome→memory_log(decision:<id>)" },
    "D5_K_to_M": { "exists":true,  "carrier":"meta_attr.required/source_refresh_sla 写时约束" }
  },
  "closureRatio": 0.4              // 5 腿中成立数 / 5
}
```

### §4.2 鉴权与路由

- 复用 `requireMe`（`routes.js:1939` 已用于 graph 端点）——**修正 C-DAI v2 §4 G7 指出的"无鉴权"问题**，closure 端点默认带鉴权。
- 路由注册于 `src/http/routes.js`（决策图谱段，紧邻 `/api/graph/*`）。

---

## §5 前端层：单决策三图闭环穿透视图

### §5.1 集成点：`openDnModal` 新增页签

现有 `openDnModal`（HTML:877）默认 `dnGraph()`（网络）。新增页签按钮"**三图闭环**"，点击调用 `dnClosure()`：
```
任务列表行点击(:951) → openDnModal(id)
  ├─ [决策网络]  dnGraph()      （决策之间，已有）
  ├─ [三图闭环]  dnClosure()    （单决策内部 K/M/J + D1–D5，新增）★ 穿透追溯入口
  ├─ [溯源]      dnAudit()      （已有）
  └─ [影响]      dnImpact()     （已有）
```
`dnClosure()` 拉 `/api/decision/:id/closure`，渲染三区 + 跨环映射。

### §5.2 三区渲染（复用 `common.css` 类，零硬编码）

```html
<div class="panel">            <!-- K 知识图谱 -->
  <div class="sect-title">K 知识图谱 <span class="badge">感知→应用→进化</span></div>
  <div class="card">粒子卡：type / 属性 / 21谓词边 / 新鲜度</div>
</div>
<div class="panel">            <!-- M 上下文图谱 -->
  <div class="sect-title">M 上下文图谱 <span class="badge">供给→装配→蒸馏</span></div>
  <div class="card">conditions_evaluated / policy_version(不可变) / decision_relation E1–E7(serves_dimension)</div>
</div>
<div class="panel">            <!-- J 决策图谱 -->
  <div class="sect-title">J 决策图谱 <span class="badge">记录→规则门→写回</span></div>
  <div class="card">disposition/confidence + decision_outcome(J2) + calibration_patch(J3)</div>
</div>
<div class="sect-title">跨环映射 D1–D5</div>
<!-- 每条边：green=exists / red=broken，点开显 carrier 字段 + provenance 链接 -->
```

### §5.3 跨环映射可视化

D1–D5 用 5 个状态条渲染：`✅ exists`（绿，走 `--ok`）/ `❌ broken`（红，走 `--err`）/ `🟡 partial`。每条点开显示 `carrier` 字段路径 + 跳转对应查询（如 D3 断 → 提示"运行 J3 校准以闭合"）。

### §5.4 空态与性能（G-D/G-C）

- **空态**：无 J2 outcome / J3 calibration → 显示"待反馈/待校准"（`dn-empty` 类），不报错。
- **懒加载**：默认展开 J 区，K/M 折叠（避免单决策拉全粒子图慢）。
- **零硬编码**：色值全部 `var(--ok)/var(--err)/var(--mut)/var(--ac)`；复用现有 `_readTok()` 注入（HTML:791-832 已有）。

---

## §6 与既有设计/计划的交叉引用

| 本设计章节 | 对应上游 |
|---|---|
| §3.1 confidence 落库 | C-DAI v2 §4 G5（唯一定义） |
| §3.2 decision_relation | C-DAI v2 §4 G1 + 6.2；全链路溯源 §5（E1–E7×维度） |
| §3.2 decision_outcome | C-DAI v2 §4 之 6.1；j2-j3 §J2 |
| §3.3 attribution 七态 | C-DAI v2 §4 之 6.4 |
| §4 closure 端点 | C-DAI v2 §7（三图闭环视图）+ §3（D1–D5） |
| §5 前端三图页签 | sales-decision-monitor 现有 `openDnModal`；`ai-portal-page-generation` 受控渲染 |
| 第0闸 D3/D4 | C-DAI v2 §4 之 6.5 + calibration/store.js 已落第0闸 |

**开发计划衔接**：本设计落地任务并入 C-DAI 开发计划 `2026-08-30-cdai-dev-plan.md` 的 T1（G5 落库）、T2（G1 relation 迁移）、T3（G2）、T11（作战室溯源面板）、T12（巡检卡反馈行）；新增"closure 端点 + 三图页签"作为 T15，与在途 j2-j3 / 全链路溯源的 T15–T32 对齐。

---

## §7 实施任务切分（bite-sized，待批准转 writing-plans）

| Task | 内容 | 真实 file:line | 状态 |
|---|---|---|---|
| **T-D1** | `createDecision` 补落 confidence/root_cause/feedback/feedback_link | `decisionRepo.js:68-79` | 仅改 INSERT |
| **T-D2** | `decision_relation` 迁移 + 物化时写 DECIDED_ON/REFERENCED_PRECEDENT | `schema.sql:191` 后 + `decisionRepo.js:87-89` | 新建表 |
| **T-D3** | `decision_outcome` 迁移 + `outcomeIngester` 写入 | 新表 + `outcome.js` | 新建表 |
| **T-D4** | `attribution` 七态 + `edge_compliance` | `attribution.js` | 升级结构 |
| **T-D5** | `createDecision` 写时非空守卫 | `decisionRepo.js:49-50` 后 | 加 2 段 |
| **T-D6** | `GET /api/decision/:id/closure` 端点 + requireMe | `routes.js:1752` 段 | 新建路由 |
| **T-D7** | 前端 `dnClosure()` 三图闭环页签 + D1–D5 映射 | `sales-decision-monitor.html:877` | 新增页签 |
| **T-D8** | seed 端到端闭环 demo 决策（带完整 M+J2+J3，让闭包首次 100%） | `scripts/seed-*.mjs` | 验证用 |

每 Task 附 `decision-retro` 生命契约（agent=`decision-retro`，skills⊆其 skillCalls，可过校验）。TDD：先写失败测试（`test/decision/*` + `test/http/closure.test.js`）→ 实现 → 验证 → commit（用户本地）。

---

## §8 验收口径

- **落库**：`decision` 21 列全部有写入路径；`decision_relation`/`decision_outcome` 表存在且物化时写入；真实库逐决策追溯闭包闭合度 **≥ 0.8**（D1–D5 至少 4 腿成立）。
- **穿透**：`sales-decision-monitor` 任务列表行点击 → 弹窗"三图闭环"页签 → K/M/J 三区 + D1–D5 状态条全部渲染；无硬编码色值（审计脚本 `tmp/audit_css_vars.py` 通过）。
- **闭环**：seed 一个端到端 demo 决策，其 closureRatio=1.0（D1–D5 全 ✅）。
- **鉴权**：closure 端点经 `requireMe`，无匿名访问（修正 G7）。

---

## §9 风险与开放问题

1. **现有"决策网络" vs 新增"决策闭包"**：两类视图层级不同（决策之间 vs 决策内部），UI 上用页签区分，不互相覆盖（G-C）。
2. **性能**：closure 端点聚合 K 邻居 + M 记忆 + J 子图，单决策可能拉大图；默认折叠 K/M（§5.4）缓解。
3. **`confidence` 反算依赖**：`computeConfidence` 须返回数值；若当前为占位，T-D1 前需先确认其实现（见 C-DAI v2 §9 风险）。
4. **决策第0闸**：D3/D4 写回必经 `produceDecision`，`calibration_patch` 已含 `decision_id` 约束（store.js 已落），无需新约束。
5. **开放问题**：EU AI Act 导出格式（Turtle/RDF vs PDF）优先级——影响 `closure` 是否内嵌 PROV-O 导出按钮（待用户拍板）。

---

## 附：证据基础（保留 file:line）

- `decisionRepo.js:42-153` createDecision 物化 + 落库
- `decisionRepo.js:68-79` INSERT 列（漏 4 列）
- `decisionRepo.js:282-301` 人工/业务回写（扩 feedback/root_cause）
- `schema.sql:153-189` decision 表 + human_* + attribution 列
- `schema.sql:168` feedback_link 列
- `sales-decision-monitor.html:855-904` 弹窗 + 页签 + 任务列表穿透入口
- `routes.js:1752-1939` 决策图谱端点段（trace/impact/provenance/neighbors + requireMe）
- 真实库探测（2026-08-30 12:12）：decision_relation/decision_outcome 不存在；calibration_patch 0 行；闭包 40%
