# 决策作战室合并修复 · 复活真图 + 三系统闭环（知识/记忆/决策）

> 设计日期：2026-08-31 ｜ 状态：用户方案 A 拍板 → 实现中
> 关联：`docs/2026-08-30-decision-quality-closed-loop-redesign.md`（闭环重设计，本次是其落地点）
> 用户本轮指令（原话约束）：
> - 「每页都需要认真检查一下，图模型呢，所需要的知识呢，3闭环呢？」
> - 「以前版本里面内容不能直接删除，而是需要合并进行，把业务逻辑搞正确，显示给用户！」
> - 三闭环口径（用户答疑）：**知识系统、记忆系统、决策系统**三大闭环系统。

## §0 现状审计结论（evidence，先证据后判定）

### 0.1 页面级真图是死区
- `sales-decision-monitor.html:297` 有 `<section id="true-graph">` + `:300 <div id="cy">`，**全文件无任何 JS 调用把它渲染**。
- 旧入口 `renderTrueGraph()` 在 commit `269f577` 被删（`git show 269f577: -<crm-button onclick="renderTrueGraph()">真图</crm-button>`），容器留下 → 死区。

### 0.2 弹窗下部为空的直接根因 = id 冲突
- 弹窗 Q1/Q4 动态渲染 `<div id="cy" class="dn-cy">`（`:818`），
- `_drawCy()`（`:861`）用 `getElementById('cy')` → **永远命中页面级 `#cy`（先出现）**，弹窗内反而空白 → 截图下部空白的直接原因。

### 0.3 旧 5 视图被折叠成 4Q、入口删除但函数残留（应合并非删除）
- `DN_VIEWS`（`:654`）只剩 q1-q4；
- `dnRootCause`（rc 溯源 J→M→K + 七类根因）与 `dnLoop`（`_loopHtml` 三图闭环 K/M/J + D1-D5 跨环条）**函数完整**（`:918`/`:939`，渲染器 `_rootCauseHtml` `:1033`、`_loopHtml` `:960`），**仅 tab 入口被删** → 孤儿代码。

### 0.4 三系统闭环现状
| 系统 | 后端 | 前端 | 断点 |
|---|---|---|---|
| 知识系统 | 本体/词汇/方法 SKILL 装配（`/api/config/ontology`、`/api/method/*`）在位 | 作战室无「决策消费了哪些知识」视图 | 无 7×7 巡检卡（设计 §1.1 硬性要求未落地） |
| 记忆系统 | `memory.html` 记忆流水/笔记/快照/先例网络/蒸馏在位（`/api/memory`） | 先例相似度只在 Q2 审计 tab 出现，无图 | 无「记忆→决策」边可视化（REFERENCED_PRECEDENT） |
| 决策系统 | **L1 拦截已接线**（`decisionRepo.js:76-79` sevenDimensionsCheck→decideInterception→block）；PROV-O 溯源在位；校准 tab + retro-fab 建议卡在位 | 页面 Q1-Q4 + L2 反馈区在位 | **L2 断**：`decision_outcome` 表 0 行 → 无业务结果 → L3 处方无源 |

### 0.5 数据侧
- `crm.decision` 9 条、`decision_relation` 4 条（REFERENCED_PRECEDENT/CAUSED/INFLUENCED/DERIVED_FROM_EXCEPTION 各 1）、`decision_precedent_rel` 4 条、**`decision_outcome` 0 条**。
- 7 类边只落 4 类：缺 `DECIDED_ON`（决策→实体，L1 identity/structure 主边）、`ESTABLISHES_FRAME`（确立标杆）、`OVERRIDES`（推翻）→ 与设计 §0 断点 3 一致。

## §1 修复设计（T1–T8 · 合并保留，不删任何既有能力）

### T1 修 id 冲突（弹窗图与页面图容器唯一化）
- 弹窗 Q1/Q4 渲染目标容器由固定 `cy` 改为按 kind 唯一：`dn-cy-up` / `dn-cy-down`（`_panelCyHtml(kind,title)` 传 id）。
- `_drawCy(elements, containerId, legendId)` 支持任意容器 id（已接收参数，不改签名）。
- 页面级 `#true-graph` 的 `#cy` 保持唯一（死区复活为全图容器）。
- 约定：**全页面 id 唯一**；渲染器以「传入容器 id」为单一事实源，禁止 `getElementById('cy')` 兜底。

### T2 复活页面级真图（全图渲染）
- 页面 `#true-graph` 区补「渲染全图」按钮 → `renderTrueGraph()`：拉 `/api/graph/trace`（up+down）+ `/api/graph/edges?entityId=`（typed 7 类边）→ `_drawCy` 力导向全图（节点=根+上下游，边按 rel_type 7 类上色 + 标注 serves_dimension）。
- 复用的是现有 `_drawCyPanel` 的 keep 过滤逻辑（kind='all'），改动面最小：`_drawCy` 已支持。

### T3 补回 rc/loop 视图 tab 入口（合并非删除）
- `DN_VIEWS` 恢复两条：
  - `rc`「溯源归因（J→M→K）」→ `dnRootCause()`（四层链 + 七类根因卡）
  - `loop`「三图闭环（K/M/J）」→ `dnLoop()`（三系统闭环 + D1-D5 跨环状态条）
- 零新逻辑：仅补入口，复用现有函数与渲染器。
- tab 分组（`_tabsHtml` 加 `dn-tabgroup-label`）：**四问审计（Q1-Q4）** / **其它视图（rc/loop）**，已有 `.dn-tabgroup-label` 样式（`:89`）。

### T4 三系统闭环条（顶部常驻 · 用户点名「3闭环」）
- 作战室 `#page-monitor` 顶部（`#gates` 上方）加横向三环条：
  - 🔵 **知识系统**：本体词汇数（`/api/config/ontology/vocabulary`）+ 方法 SKILL 装配数（`/api/config/methods`）→ 闭环态（有装配=闭合，无=断点）→ 跳 `ontology.html` / `skills.html`
  - 🟢 **记忆系统**：记忆流水/先例数（`/api/memory` → logs/precedents）+ 先例相似度 Top → 跳 `memory.html`
  - 🟠 **决策系统**：L1 拦截（decision.attribution 写时物化数）+ L2 结果（decision_outcome 数）+ L3 校准（calibration patches 待批数 /api/monitor/*）→ 跳 `decision-scenarios.html`（重跑）
- 每环显示「数字 + 已闭环/断点」状态点，点击跳对应管理页 → 三系统闭环「周而复始」在作战室可见。
- 数据：并行 fetch 三个端点，失败降级为「数据不可用」不阻断主流程。
- 色值全走 tokens.css 语义变量（`.loop-*` class），零硬编码。

### T5 每决策 7×7 巡检卡（设计 §1.1 硬性要求）
- 弹窗/真图点节点 → 右侧抽屉：
  - **左 7 维**：`decision.attribution.required_fill`（provided/missing，missing 标红）+ 维度名/定义（`edgeDimensionSpec.js` DIMENSIONS）。
  - **右 7 边**：`decision_relation` 7 类（存在=✅ 连目标/权重，应存缺=❌ 红，无=—）按 `edgeDimensionSpec` serves_dimension 交叉校验。
  - **交叉校验条**：某维度应有边支撑但边缺失 → ❌ 红（Oleg「维度由边生产出来」可校验）。
- 复用现有节点点击链路（`.snap` 快照 + `_drawCy` 节点 tap 事件），补一个 `dnDrawer` 区域。

### T6 决策系统 L2 补数据（让闭环「真闭环」）
- 扩展 `scripts/seed-decision-network.mjs`：
  - `decision_outcome` 补 3-4 条真实业务结果（root won / quote paid / loss lost / stalled 等，`outcome_type` + `verified_at` + `payload`），幂等 upsert。
  - 7 类边补全：`DECIDED_ON`（决策→CRM_DEAL/CRM_ACCOUNT 实体）、`ESTABLISHES_FRAME`、`OVERRIDES`；使 7 类边齐（当前 4/7）。
- 同步 AGE 镜像（失败不阻断，沿用现有 `.catch(()=>{})`）。
- 幂等：全部 `ON CONFLICT DO NOTHING`；可重复执行。

### T7 decision-graph.html 去硬编码色 + 补 7 类边
- `:82` `COLORS = {ROOT:'#2563eb', UPSTREAM:'#16a34a', DOWNSTREAM:'#ea580c'}` **硬编码 hex** → 改 `_readTok('--ac'/'--ok'/'--warn')`（tokens.css 注入），守 UI 铁律。
- SVG 星形伪图补 `rel_type` 边标注：拉 `/api/graph/edges?entityId=` typed 边，按 7 类边色轮（复用 `_rotateHue` 逻辑）上色，替代灰线。
- 独立追溯入口保留（不删旧页，符合「合并非删除」）。

### T8 三闭环页联动（重跑闭环可见）
- 作战室三系统闭环条 + L2 反馈区「重跑场景」跳转 `decision-scenarios.html`（已实现入口保留）→ 修正图谱/阈值 → 重回作战室 → 周而复始。

## §2 生命契约（双轨 · 每任务继承）

```contract-yaml
- task: "T1+T2 修 id 冲突 + 复活页面级全图"
  agent: review-gate
  skills: [data-particle-read, method-review-gate]
  memory: [review-gate]
  success: "sales-decision-monitor.html 页面 #true-graph 显示当前决策全图（7 类边上色+serves_dimension）；弹窗 Q1/Q4 cytoscape 图正常渲染（无 id 冲突）"
- task: "T3 补回 rc/loop 视图 tab 入口"
  agent: review-gate
  skills: [data-particle-read, method-review-gate]
  memory: [review-gate]
  success: "DN_VIEWS 含 q1-q4 + rc + loop；rc 显示四层溯源+七类根因；loop 显示三系统闭环 K/M/J + D1-D5 跨环条"
- task: "T4 三系统闭环条"
  agent: review-gate
  skills: [data-particle-read, method-review-gate]
  memory: [review-gate]
  success: "作战室顶部显示 知识/记忆/决策 三环状态+数字，点击跳转对应管理页；零硬编码色值"
- task: "T5 每决策 7×7 巡检卡"
  agent: review-gate
  skills: [data-particle-read, method-review-gate]
  memory: [review-gate]
  success: "点决策节点 → 右抽屉：左 7 维（missing 红）+ 右 7 边（应存缺红）+ 交叉校验"
- task: "T6 决策系统 L2 补数据"
  agent: review-gate
  skills: [data-particle-read, method-review-gate]
  memory: [review-gate]
  success: "decision_outcome ≥3 条业务结果；decision_relation 7 类边齐（含 DECIDED_ON/ESTABLISHES_FRAME/OVERRIDES）；幂等可重跑"
- task: "T7 decision-graph.html 去硬编码色+补 7 类边"
  agent: review-gate
  skills: [data-particle-read, method-review-gate]
  memory: [review-gate]
  success: "COLORS 全走 tokens.css；SVG 边按 7 类 rel_type 上色（零硬编码 hex）"
```

## §3 验收口径（per T）
| T | 验收 | 判定 |
|---|---|---|
| T1 | 弹窗 Q1/Q4 图清晰渲染；页面 #true-graph 无 id 冲突 | `_drawCy` 容器唯一 |
| T2 | 页面全图出现 7 类边力导向图（含当前决策上下游） | 截图可证 |
| T3 | rc/loop tab 可用，内容非空（rc 有七类根因、loop 有三系统闭环条） | 交互可证 |
| T4 | 三系统闭环条 3 环数字 + 跳转正常 | 截图可证 |
| T5 | 点节点开 7×7 巡检卡，missing 红、应存缺红 | 交互可证 |
| T6 | outcome ≥3、7 类边齐（4/7→7/7） | DB 查询可证 |
| T7 | decision-graph.html 无 `#2563eb` 等硬编码 | grep 可证 |
| T8 | 重跑跳转可用 | 交互可证 |

## §4 风险与注意
- **写纪律**：T6 只 upsert（ON CONFLICT DO NOTHING），绝对禁 DELETE。
- **UI 铁律**：所有新色值走 tokens.css 语义变量；禁止 `:root` 重定义全局 token、禁止硬编码 hex。
- **存量兼容**：T3/T5 只加入口/抽屉，不改既有 q1-q4 渲染；存量决策无 attribution 时巡检卡显示「无数据」不空白（沿用 `.dn-empty`）。
- **T4 降级**：任一闭环端点失败 → 该环显示「数据不可用」灰态，不阻断其它环。
- **AGE 依赖**：T6 同步 AGE 失败仅 trace，不阻断 PG 权威写。

## 闭环回写
| task | agent | gap_type | observed | expected | severity | status |
|------|-------|----------|----------|----------|----------|--------|
| （待 workbench 运行时监控 contract-yaml 执行后 upsert） | | | | | | |

> 表由 workbench 运行时监控 contract-yaml 执行并 upsert；同一 `(task, gap_type)` 复发 ≥2 次时产出 SKILL 改进提案（需用户批准）。