# 决策质量闭环重设计 · 销售决策作战室（sales-decision-monitor）

> 设计日期：2026-08-30 ｜ 状态：设计已含用户两处拍板（统一页 + Cytoscape 真图），待最终批准进入实现
> 设计输入：
> - 两篇公众号文章（Semantica：图原生上下文与决策问责基础设施）→ 借鉴过滤依据
> - `docs/2026-08-29-decision-quality-monitor-redesign.md`（已批准，本设计升级并补全其 L2 缺口）
> - `data-taxonomy-methodology.html`（Oleg 七维度上下文模型，边↔维度映射来源）
> - 用户与本文档作者的「7×7 + 三件套」讨论（L1 上下文图谱 / L2 反馈回路 / L3 校准层）
> - **用户拍板（本轮）**：① 作战室统一到 `sales-decision-monitor.html`；② 真图用 Cytoscape/vis-network（vendor 离线 + 接 tokens.css）

## §0 背景与唯一目的

用户明确：**本次重设计的唯一目的是监控智能体决策质量、持续提升决策质量、形成闭环**。一切取舍以「是否服务闭环验证」为判据。

由此导出借鉴铁律：
- **借鉴**：只引入能直接服务于「监控→改进→闭环」的机制。
- **不借鉴**：任何不能支撑闭环验证的特性一律不引入（详见 §2）。

### 用户本轮核心诉求（5 点 → 设计落点）

| 诉求 | 设计落点 |
|---|---|
| 看到真正的图谱 | L1 真图：Cytoscape 力导向，节点=决策+业务粒子，边按 7 类上色+标注 `serves_dimension`，点节点弹 7 维 facet 面板 |
| 前台查看 L1-L3 全部内容 | 生命周期环(模型Y)上每节点三色透镜；**每个决策可展开 7维+7边 巡检卡**（§1.1，硬性要求）；顶部全过程时间线贯穿 |
| 支持决策全过程 | 时间线：触发→上下文装配(L1 7维)→决策→处置/推翻(L3)→业务结果(L2)→校准建议(L3)→修正图谱→重跑场景→再监控 |
| 偏差自动调整建议 | 偏差（闸门标红/隐性错误簇/准确率低）触发**自动生成校准处方**（复用 `/api/calibration/patches/generate`），以「建议卡」直接浮在作战室 |
| 建议修正图谱→重跑场景→周而复始 | 建议卡一键批准→经第 0 闸写回 `required_dims`/阈值/边规则→图谱实时反映→跳转 `decision-scenarios` 重跑→再监控，闭环可见 |

### 现有状态与真实断点

既有 2026-08-29 设计已覆盖 L1（`decision.attribution` 写时物化 `required_fill` + 单次 7 维快照）与 L3（`human_disposition` → `accuracy_signal` + calibration 处方），但存在三处真实断点，且**前台目前看不到真正的图谱**：

1. **L1 不闭环（拦截缺失）**：`createDecision`（`src/decision/decisionRepo.js:38`）全程不调用 `sevenDimensionsCheck`；`required_dims` 对真实决策写入零约束力。
2. **L2 完全缺失（结果准确性无法验证）**：决策→业务结果（成交/丢单/回款）回写链路不存在；`outcome_verified` 设计已存在但恒为 null。
3. **边无 7 维规范（用户点名缺口）**：`ageGraph.js:136` 声明 7 类边，但 7 条边与 Oleg 七维度之间没有任何 schema/代码级绑定；仅 3 类边被实际写入，且全存 AGE 镜像，PG 侧仅 `decision_precedent_rel`（`schema.sql:191-196`）单类型表。
4. **前台看不到真图（本轮新确认根因）**：
   - 现有图是「星形」伪图：`decision-graph.html:104-150` 与 `sales-decision-monitor.html:516-561` 的 `drawGraph` 仅把根节点居中、上游画左、下游画右，**所有边都是同一条灰线连到根**，无 7 类边区分、无节点类型、无 7 维 facet。
   - `decision-graph-board.html` 走 S14 受控渲染，`routes.js:491` 的 `/api/page/decision-graph` 用 `renderPage` 产出的是**邻居表格**（`S14.schema.js:3` 注释明示），不是图。
   - **最致命**：`/api/graph/trace`(routes.js:1876) 与 `/api/graph/impact`(routes.js:1884) 返回节点只有 `decision_id/distance/state/disposition/confidence`，边只有 `from/to/depth`，**完全没有 `rel_type`（7 类边）字段** → 前端连按边类型上色的依据都没有。这正是 G1(T2) 要补的缺口。

结论：既有「闭环」是**人工处置闭环（L1+L3）**，非**效果验证闭环（L1+L2+L3）**；且即使 L1 数据齐，前台也只能看到星形伪图。本设计补齐 L2 + 落边↔维度规范 + 用 Cytoscape 重做真图，使闭环完整且可见。

## §1 信息架构：决策生命周期闭环主轴 × 三透镜（可见闭环）

> **主轴模型（用户拍板 · 模型 Y）**：作战室不再用 L1/L2/L3 三块垂直面板，而是以**决策生命周期闭环**为唯一主轴；L1/L2/L3 退化为环上每个节点的「三色透镜」（叠加检视视角）。真图嵌在「装配→决策」段，自动建议卡长在校准节点。**每个决策节点可展开「7 维 + 7 边」巡检卡（见 §1.1）**——这是用户硬性要求：7 个上下文维度与 7 类决策边必须**按每个决策**完整可视。

```
        ┌──────────────────────────────────────────────────┐
  触发事件 → L1装配(7维+7边) → 智能体决策 → L3处置/推翻
     ↑                                                        │
  重跑场景                                                   L2业务结果
     ↑                                                        │
  修正图谱/阈值 ← L3校准建议(自动建议卡) ←────────────────────┘
```

- **主轴 = 8 节点闭环**：`触发事件 → L1装配(7维+7边) → 智能体决策 → L3处置/推翻 → L2业务结果 → L3校准建议 → 修正图谱/阈值 → 重跑场景 →（回到触发事件，周而复始）`。
- **三色透镜（叠加在环上每个节点）**：
  - 🔵 **L1 透镜（groundedness）**：该节点上下文齐不齐、7 类边全不全（缺口标红）。
  - 🟠 **L2 透镜（outcome）**：该决策业务结果成功与否。
  - 🟣 **L3 透镜（calibration）**：偏差归因 + 自动建议卡。
- **真图（Cytoscape）嵌在「L1装配→决策」段**：点环上节点即在真图里高亮它的 7 维 facet 与 7 类边。

### §1.1 每决策 7×7 巡检卡（硬性可视化要求）

点开任一决策节点（真图节点或环上节点）→ 右侧抽屉展开**该决策专属的 7×7 巡检卡**，左半 7 维度、右半 7 边，全部按 Oleg 七维度 + 七决策边定义逐条渲染：

- **左栏 · 7 维度（来自 `decision.attribution.required_fill`）**：每行 = 维度名 + 定义 + 失败模式 + 状态（✅已填 / ⚠️部分 / ❌缺失-红）+ 实际值。缺失维度直接标红，对应 Oleg「不允许 AI 脑补」。
- **右栏 · 7 边（来自 `decision_relation`，T2）**：每行 = 边类型 + 语义 + 方向 + 状态（✅存在-连目标/权重 / —无 / ❌应存缺-红）+ 连接目标。
- **交叉校验（7 边 × 7 维）**：依据 `edgeDimensionSpec.js`（T1）的 `serves_dimension` 映射，自动标注「某维度应有边支撑但边缺失」的 ❌，把 Oleg「维度由边生产出来」落到可校验。

> 例：一「报价决策」点开 → 左栏 `DecisionHistory` ✅（attribution 显示已引先例 D12）、`Governance` ⚠️（部分）；右栏 `DECIDED_ON` ✅→商机OPP-7、`REFERENCED_PRECEDENT` ✅→D12(sim 0.82)、`OVERRIDES` —、`CAUSED` ❌应存缺（该决策强因果触发了续约决策但未落边）。周而复始时，校准修正 `edgeDimensionSpec` → 重跑后 `CAUSED` 由 ❌转 ✅。

## §2 借鉴过滤（回应「不重要的不借鉴」）

| 项 | 是否借鉴 | 理由（是否服务闭环） |
|---|---|---|
| ✅ 决策节点 + 7 边图（G1） | 借鉴 | L1 groundedness 的关系载体，闭环溯源基础 |
| ✅ 边↔维度规范（本次新增） | 借鉴 | 把 Oleg 七维度与决策边绑定，使「维度覆盖」可校验 |
| ✅ PROV-O 溯源（G3） | 借鉴 | 审计留痕，闭环可审计 |
| ✅ 规则引擎拦截止（G2） | 借鉴 | `sevenDimensionsCheck` 即此；接进 `createDecision` 形成 L1 拦截 |
| ✅ 置信度列（G5） | 借鉴 | L3 confidence 反算，驱动校准 |
| ✅ **Cytoscape 轻量图库（用户指定）** | 借鉴 | 渲染 L1 真图（力导向、边按 7 类上色标注）；**例外项**：经用户拍板引入，但须 vendor 离线 + 配色接 tokens.css，不违反 UI 一致性铁律 |
| ❌ NER / 图谱构建（hooks.js 已做） | 不借鉴 | `hooks.js:38-120` 已做身份解析 + 21 受控谓词，业务语义更强 |
| ❌ FAISS / Qdrant | 不借鉴 | pgvector 已有，重依赖污染 Node 内核 |
| ❌ Entity Merger 物理合并 | 不借鉴 | 违反禁删铁律，`dedup.js` 软合并已覆盖 |
| ❌ 双时态图 | 不借鉴 | `policy_version` + `memory_snapshot` 已覆盖 |
| ❌ Semantica Python 内核(torch/transformers) | 不借鉴 | 重依赖跨进程，打穿 L2 装配延迟，违反读路径零跨进程铁律 |

## §3 详细设计（T1–T14）

### L1 上下文图谱（算且拦 · 真图）

**T1 边↔维度规范 `edgeDimensionSpec.js`**
- 新建 `src/decision/edgeDimensionSpec.js`：固化 7 边 × 7 维绑定。
- 每张边：`{ edge_type, serves_dimensions:[...], required_facets:[...], direction }`。
- 映射（Oleg 七维度 §2）：`REFERENCED_PRECEDENT`→#5；`OVERRIDES`→#7+#5；`DERIVED_FROM_EXCEPTION`→#6；`ESTABLISHES_FRAME`→#3+#7；`DECIDED_ON`→#1+#2；`CAUSED`→#4；`INFLUENCED`→#4。
- 单测断言：7 边覆盖 7 维、每维≥1 条边服务、无悬空边/悬空维。

**T2 决策边权威持久化（G1）**
- PG 新表 `decision_relation`：`(rel_id, from_id, to_id, rel_type enum(7), serves_dimension, props jsonb, created_at)`。
- `linkDecisions()` 单一写入口双写 AGE + PG；AGE 不可用时降级改读 PG。
- `serves_dimension` 取自 T1，写入时校验。

**T3 拦截闭环（修复 §0 断点 1）**
- `createDecision` 写入前调 `sevenDimensionsCheck`，据 `allowed` 拒写或打 `missing_context`。
- attribution 物化与拦截共用同一 `missing` 结果；不阻断既有人工处置链路。

**T11 API 暴露 7 类边（依赖 T2）**
- 扩展 `graphTraceHandler` / `graphImpactHandler`（routes.js:1876/1884）：从 `decision_relation` 读取 `rel_type` + `serves_dimension`，在返回节点/边中附 `rel_type`（枚举 7 类）、`serves_dimension`、`props`。
- 新增 `GET /api/graph/edges?entityId=`：返回该实体的 7 类 typed 边（供 Cytoscape 渲染），降级回 ctePrecedents 时仅含 `REFERENCED_PRECEDENT`。
- 补全鉴权（§0 断点 4 同源）：`/api/graph/*` 加 `requireMe` + `enforceScope`（与 calibration 同口径）。

**T12 Cytoscape 真图（前台，统一进 sales-decision-monitor）**
- vendor：`npm install cytoscape` 于受管 workspace → 拷 `node_modules/cytoscape/dist/cytoscape.min.js` 至 `src/web/portal/vendor/cytoscape.min.js`；页面 `<script src="/portal/vendor/cytoscape.min.js">` 引用（离线、随仓库）。
- 配色经 JS 从 CSS 变量读取（`getComputedStyle(document.documentElement).getPropertyValue('--ac')` 等），注入 Cytoscape `style`——**零硬编码色值**。
- 节点按类型（决策/客户/商机/报价）区分 shape/label；边按 `rel_type`（7 类）上色 + 标注 `serves_dimension`；力导向布局；点节点弹「7 维 facet 抽屉」（读 `attribution.required_fill`）。
- 复用现有深色主题容器（`.panel/.sect`），不新建样式体系。

### L2 反馈回路（结果准确性，补 §0 断点 2）

**T5 业务结果回写**
- 新表 `decision_outcome`：`(outcome_id, decision_id, outcome_type enum(won/lost/paid/stalled/other), payload jsonb, verified_at)`。
- 轻量端点 `POST /api/decision/:id/outcome` 落库并回写 `decision.outcome_verified`（幂等 upsert）。
- 复用既有业务事件（成交/丢单/回款）触发，不新建业务系统。

**T6 反馈聚合**
- `monitorStore.getGateOutcome()` 按闸门聚合业务成功率；与 L1 准确率交叉，暴露「人工未推翻但业务失败」隐性错误簇。

**T7 页面 L2 区**
- 每闸门「决策通过率 vs 业务成功率」对比条；隐性错误簇标红。

### L3 校准层（持续纠偏，闭环回边）

**T8 置信度提列（G5）**
- `decision.confidence` 提列（现藏 `decision_event.payload`）；由 `outcome_verified` + `human_disposition` 反算。

**T9 校准处方回写**
- calibration 处方（`CALIBRATION_CHANGE`）依据 L1 归因 + L2 outcome 生成，经第 0 闸写回 `sevenDimensionsCheck` 阈值 / 置信度模型。
- 处方批准走 HITL（sysadmin 闸）。

**T10 页面 L3 区**
- 处方审核流（指标→归因→处方→批准/驳回/回滚→效果）；可见闭环。

### 前端作战室集成（T13-T14）

**T13 全过程时间线（sales-decision-monitor 顶部）**
- 顶部横向时间线组件：触发事件 → 上下文装配(L1 7维) → 决策 → 处置/推翻(L3) → 业务结果(L2) → 校准建议(L3) → 修正图谱 → 重跑场景 → 再监控。
- 每节点可点开对应详情；当前处于哪一阶段高亮。

**T14 自动建议卡 + 应用闭环**
- 作战室加载（及每 N 秒轮询）时：若检测到偏差（闸门准确率<阈值 / 隐性错误簇非空 / L3 准确率低），自动调用 `/api/calibration/patches/generate` 生成处方，以「建议卡」浮于作战室（保留手动「生成处方」按钮）。
- 建议卡：展示「偏差现象 → 根因归因 → 建议修正（改哪些 required_dims/阈值/边规则）→ 预期影响」。
- 一键批准 → `POST /api/calibration/patches/:id/approve`（经第 0 闸）→ 真图与阈值实时反映 → 提供「去重跑场景」按钮跳转 `decision-scenarios.html` → 重跑后作战室再监控，形成周而复始闭环。

## §4 DDL（幂等迁移）

```sql
-- T1/T3 依赖：attribution 列（2026-08-29 已设计，幂等确保存在）
ALTER TABLE crm.decision ADD COLUMN IF NOT EXISTS
  attribution JSONB;  -- {required_fill:{provided[],missing[]}, category, accuracy_signal, outcome_verified, computed_at}

-- T8 置信度提列（G5）
ALTER TABLE crm.decision ADD COLUMN IF NOT EXISTS
  confidence REAL;

-- T2 决策边权威表（G1，7 类边枚举）
CREATE TABLE IF NOT EXISTS crm.decision_relation (
  rel_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_id         UUID NOT NULL,
  to_id           UUID NOT NULL,
  rel_type        TEXT NOT NULL CHECK (rel_type IN
    ('DECIDED_ON','REFERENCED_PRECEDENT','DERIVED_FROM_EXCEPTION',
     'ESTABLISHES_FRAME','OVERRIDES','CAUSED','INFLUENCED')),
  serves_dimension TEXT NOT NULL,   -- 取自 edgeDimensionSpec，受 T1 约束
  props          JSONB,
  created_at     TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_dr_from ON crm.decision_relation(from_id);
CREATE INDEX IF NOT EXISTS idx_crm_dr_to   ON crm.decision_relation(to_id);
CREATE INDEX IF NOT EXISTS idx_crm_dr_type ON crm.decision_relation(rel_type);

-- T5 业务结果回写（L2）
CREATE TABLE IF NOT EXISTS crm.decision_outcome (
  outcome_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_id  UUID NOT NULL REFERENCES crm.decision,
  outcome_type TEXT NOT NULL CHECK (outcome_type IN ('won','lost','paid','stalled','other')),
  payload      JSONB,
  verified_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_do_dec ON crm.decision_outcome(decision_id);
```

## §5 页面结构（sales-decision-monitor.html 作战室 · 模型 Y）

以**决策生命周期闭环**为主轴（8 节点环，模型 Y），环上每节点叠加三色透镜；点任一决策节点 → 右侧抽屉展开 **§1.1 每决策 7×7 巡检卡**。始终可见全过程时间线 + 浮动建议卡：

| 区 | 内容 | 数据来源 |
|---|---|---|
| **生命周期闭环主轴（作战室主视觉）** | 8 节点环：触发→L1装配(7维+7边)→决策→L3处置→L2结果→L3校准建议→修正→重跑；当前阶段高亮，每节点三色透镜标记 | `decision` + `attribution` + `outcome_verified` + `human_disposition` + `decision_relation` |
| **L1 真图（嵌「装配→决策」段）** | Cytoscape 力导向：7 类边着色标注 + 节点类型；点节点即在环/巡检卡中联动高亮 | `/api/graph/edges` + `/api/graph/trace`（T11 暴露 rel_type） |
| **每决策 7×7 巡检卡（§1.1，硬性）** | 右抽屉：左 7 维度(缺失红)+ 右 7 边(应存缺红) + 交叉校验条 | `attribution.required_fill` + `decision_relation` + `edgeDimensionSpec` |
| **L2 反馈** | 决策通过率 vs 业务成功率对比 + 隐性错误簇（人工未推翻但业务失败） | `monitorStore.getGateOutcome` |
| **L3 校准** | 处方审核流（指标→归因→处方→批准/驳回/回滚→效果） | `calibration/*` + `decision.confidence` |
| **建议卡（浮动）** | 偏差→根因→建议修正→预期影响；一键批准/去重跑 | `/api/calibration/patches/generate` + approve |

页面复用深色主题与 `.panel/.sect/.btn` 等 common.css 类；Cytoscape 配色经 JS 注入 tokens.css 变量（零硬编码色值）。

## §6 生命契约（双轨 · T1–T14）

```contract-yaml
- task: "T1 边↔维度规范 edgeDimensionSpec.js + 单测"
  agent: review-gate
  skills: [data-particle-read, method-review-gate]
  memory: [review-gate]
  success: "src/decision/edgeDimensionSpec.js 导出 7 边绑定；单测断言 7 维全覆盖且每维≥1 边、无悬空"
- task: "T2 decision_relation 表 + linkDecisions 双写 + 降级读 PG"
  agent: review-gate
  skills: [data-particle-read, method-review-gate]
  memory: [review-gate]
  success: "crm.decision_relation 含 7 类边枚举；linkDecisions 双写 AGE+PG；AGE 关时 trace 仍可读全 7 类边"
- task: "T3 createDecision 写入前调 sevenDimensionsCheck 拦截闭环"
  agent: review-gate
  skills: [data-particle-read, method-review-gate]
  memory: [review-gate, quote-engine]
  success: "required_dims 不齐时 createDecision 拒写或打 missing_context；已人工处置决策仍可落库；存量无回归"
- task: "T5 decision_outcome 表 + POST /api/decision/:id/outcome 回写"
  agent: review-gate
  skills: [data-particle-read, method-review-gate]
  memory: [review-gate]
  success: "端点落库并回写 decision.outcome_verified；幂等 upsert；monitorStore 可聚合并发安全"
- task: "T6 monitorStore.getGateOutcome 聚合业务成功率"
  agent: review-gate
  skills: [data-particle-read, method-review-gate]
  memory: [review-gate]
  success: "GET /api/monitor/gates 含每闸门 business_success_rate 与隐性错误簇计数"
- task: "T7 页面 L2 区（通过率 vs 成功率对比）"
  agent: review-gate
  skills: [data-particle-read, method-review-gate]
  memory: [review-gate]
  success: "sales-decision-monitor.html L2 区显示决策通过率 vs 业务成功率对比条，隐性错误标红"
- task: "T8 decision.confidence 提列 + 反算"
  agent: review-gate
  skills: [data-particle-read, method-review-gate]
  memory: [review-gate]
  success: "crm.decision.confidence 由 outcome_verified+human_disposition 反算写入；calibrationRouter 不再侧信道取"
- task: "T9 校准处方经第0闸回写 sevenDimensionsCheck 阈值"
  agent: review-gate
  skills: [data-particle-read, method-review-gate]
  memory: [review-gate]
  success: "CALIBRATION_CHANGE 处方批准后经第0闸写回拦截阈值；留痕可审计"
- task: "T10 页面 L3 区（处方审核闭环流）"
  agent: review-gate
  skills: [data-particle-read, method-review-gate]
  memory: [review-gate]
  success: "sales-decision-monitor.html L3 区可见 指标→归因→处方→批准/驳回/回滚→效果 闭环"
- task: "T11 API 暴露 7 类边 + 补全 /api/graph/* 鉴权"
  agent: review-gate
  skills: [data-particle-read, method-review-gate]
  memory: [review-gate]
  success: "/api/graph/trace|impact 返回含 rel_type(7类)+serves_dimension；新增 /api/graph/edges；三端点加 requireMe+enforceScope"
- task: "T12 Cytoscape 真图（vendor 离线 + tokens.css 配色）"
  agent: review-gate
  skills: [data-particle-read, method-review-gate]
  memory: [review-gate]
  success: "src/web/portal/vendor/cytoscape.min.js 随仓库离线；真图按 7 类边上色标注、节点分型、点开 7 维 facet；配色零硬编码"
- task: "T13 全过程时间线（sales-decision-monitor 顶部）"
  agent: review-gate
  skills: [data-particle-read, method-review-gate]
  memory: [review-gate]
  success: "作战室顶部 8 阶段时间线高亮当前阶段，每阶段可点开详情"
- task: "T14 自动建议卡 + 应用闭环（偏差→生成→批准→重跑）"
  agent: review-gate
  skills: [data-particle-read, method-review-gate]
  memory: [review-gate]
  success: "偏差检测自动浮建议卡；一键批准经第0闸写回；提供「去重跑场景」跳转；闭环可见"
```

**契约说明**：全部 Task 锚定 `review-gate`（`src/agent/agentSpec.js:40`），`skills` 落在 `review-gate.skillCalls` 子集，`memory` 落在 `review-gate.memory.read` 子集，满足 §A 自校验。

## §7 验收口径

- **L1 真图可见**：`sales-decision-monitor.html` 作战室用 Cytoscape 渲染力导向图；7 类边按 `rel_type` 上色+标注 `serves_dimension`；点节点弹出该决策 7 维 facet；离线可用（vendor 文件随仓库）。
- **L1 闭环**：`required_dims` 不齐的真实决策被拦截/标红；`decision_relation` 在 AGE 关闭时仍可查全 7 类边。
- **L2 闭环**：业务结果能回写并驱动 `outcome_verified`；监控台可见「决策通过率 vs 业务成功率」差异与隐性错误。
- **L3 闭环**：置信度列由 outcome + disposition 反算；校准处方经第 0 闸回写并留痕。
- **自动建议闭环**：偏差出现时作战室自动浮建议卡；一键批准经第 0 闸写回；可跳 `decision-scenarios` 重跑并再监控。
- **边维度规范**：7 边 × 7 维绑定有单测守护。
- **借鉴纪律**：仅 Cytoscape 为破例引入项（用户拍板），vendor 离线 + 接 tokens.css；未引入其余 §2「不借鉴」项；DDL/依赖零新增 Python 重依赖。

## §8 风险与注意

- **口径单一事实源**：`attribution.required_fill` 与 T3 拦截共用 `sevenDimensionsCheck` 的 `ctx[dim]` 空值语义；严禁回到 `DIM_PREFIX` 前缀匹配。
- **存量兼容**：T3 拦截仅作用于新写入；存量决策保持可读，不回填拦截结果。
- **业务结果链路**：T5 依赖业务事件（成交/丢单/回款）触发源存在；若某业务结果暂无触发源，`outcome_verified` 暂为 null，不影响 L1/L3 主流程。
- **写纪律**：所有写操作必经第 0 闸；绝对禁止 DELETE（去重走软合并 `meta.merged_into`）。
- **UI 一致性（Cytoscape 例外项铁律）**：`src/web/portal/vendor/cytoscape.min.js` 离线随仓库；其节点/边 `style` 的 color/fgColor/lineColor **必须**经 JS 从 `getComputedStyle(document.documentElement).getPropertyValue('--xxx')` 注入，**禁止在 style 里写死 hex**；背景用 `--bg`/面板用 `--panel`。
- **静态目录确认**：`/portal/*` 静态根目录以实现时 `server.js` 的 `express.static` 映射为准（预期 `src/web/portal/`）；vendor 文件放该目录下 `vendor/`。
- **图规模**：单次查询 `max_depth` 限 4，Cytoscape 节点超 200 时启用 `hideEdgesOnViewport` 保性能。

## 闭环回写

| task | agent | gap_type | observed | expected | severity | status |
|------|-------|----------|----------|----------|----------|--------|
| （待 workbench 运行时监控 contract-yaml 执行后 upsert） | | | | | | |

> 本表由 workbench 运行时监控 contract-yaml 执行并 upsert；同一 `(task, gap_type)` 复发 ≥2 次时产出 SKILL 改进提案（需用户批准）。
