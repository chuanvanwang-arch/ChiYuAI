# 设计文档：认知决策子系统 P2/P3 前端可视化接入

- **作者 / 日期**：AI 助手 / 2026-09-02
- **关联设计**：`docs/2026-09-02-cognitive-decision-unified-design.md`（v3，§9 闭环回流 / §11.5 知识沉淀）
- **关联实施**：`docs/superpowers/plans/2026-09-02-cognitive-decision-unified-implementation.md`（P2/P3 已落地后端）
- **前置结论**：P2(C1–C5) / P3(D1–D4) 后端 API 与模块已全部落地并通过真实库 L3 实证；前端页面尚未消费这些能力（仅 P1 的「决策三卡」已接）。本设计补齐前端可视化。

## 1. 背景与目标

用户打开 `http://localhost:3000/sales-decision-monitor` 与 `http://localhost:3000/config.html`，发现「没有看到变化」。根因诊断（已实证）：

1. Server 是最新的（`/api/decision/pre-context`、`/api/skill/scope` 返回 `{"error":"未登录"}` 而非 404，证明路由已注册；`npm run dev` 用 `node --watch` 热重载）。
2. **P2/P3 是纯后端子系统**，前端页面未接入其可视化；`config.html` 本就未改动。

**目标**：把已落地的 P2/P3 真实 API 接入前端，让闭环回流与知识沉淀「在 UI 上可见、可操作」。

## 2. 范围与边界（铁律）

- **接已有 API，不新增后端端点**（除 Task 2 的 system 层 skill 种子初始化，见 §5.2）。
- **数据真实性**：生产库当前 `decision_retro_report`/`calibration_patch`/`decision_skill_quality`/`skill_scope` 均为 0 行（P0-② 真实流量未到）。面板**诚实显「暂无数据」，绝不造假填充**（BG-04 铁律）。
- **UI 一致性**：零硬编码色值，全部走 `src/web/tokens.css` 语义变量；受控页链 `/portal/page.css`；复用现有 `.dn-section/.card/.l2-*` 样式类。
- **登录态**：所有端点 `requireMe`（401 未登录）。前端未登录时统一提示「请先登录」。

## 3. Task 1：sales-decision-monitor 闭环/知识可视化

实现方式：原生内联扩展（在两 HTML 文件内加 `<section>` + `fetch` + 渲染，零新依赖）。

### 3.1 全局闭环活度看板（只读，新增 `<section id="closure-loop" class="dn-section">`）

放置于 `决策真图` section（约 415 行）之后、决策质量校准之前。消费 3 个已有 GET 端点：

| 卡片 | 端点 | 渲染字段 | 空策略 |
|---|---|---|---|
| ① 偏差处方（C3） | `GET /api/decision/monitor/deviation?windowDays=90` | `deviation.rate` / `threshold` / `over`/`total`，超阈值红标 | `total=0` → 显「窗口内无决策，暂无偏差率」 |
| ② Q(Skill,T) 改善（C5） | `GET /api/decision/monitor/q-skill?windowDays=90` | 逐 `(scenario_id, skill)`：`q0→qN`，`improved` 绿 / `stagnant` 黄（反假绿判据） | `skills=[]` → 「暂无采样」 |
| ③ 知识概念覆盖（D3） | `GET /api/knowledge/concept-vectors?scenario_id=<当前选中场景>` | `count` + 维度分布（methodology_id×dim_key） | `count=0` → 「无概念向量」 |

> **C1/C2/C4 通道说明**：retro（C1）、记忆影响/反面先例（C2）、校准处方批准（C4）目前无独立「全局聚合 GET 端点」，其活度通过 **3.2 单决策穿透**的写回落库体现。本看板不伪造它们的全局计数；如需全局聚合，列为后续 Task（新增 `/api/decision/monitor/loop-health` 聚合端点）。

### 3.2 单决策闭环穿透（写回入口，复用决策列表点击）

在现有决策列表/三卡旁增加「闭环」按钮，打开 modal：

- **只读展示**（已有端点）：`GET /api/decision/:id/selfcheck`、`/rubric`、`/thinking`（复用 P1 三卡数据，呈现该决策八要素/九尺子/思维）。
- **写回操作**（已有 POST 端点，需登录）：
  - `POST /api/decision/:id/retro` — C1 复盘三通道（A 事实/B 假设/C 推论/G 目标）
  - `POST /api/decision/:id/memory/:action`（action=reinforce|rewrite）— C2 记忆影响/后见之明
  - `POST /api/decision/:id/hindsight-baseline` + `/hindsight-check` — C2/C3 后见之明基线/偏差校验
- 写回成功后乐观提示「已落库（provenance/记忆）」，关闭 modal。
- **历史读取**：本 Task 不新增读端点，故 modal 不展示该决策「已有 retro/记忆历史列表」；仅提供写回入口 + 八要素展示。读历史列为后续增强（需新增 `GET /api/decision/:id/loop` 汇总端点，另立 Task）。

### 3.3 Living Contract（Task 1）

```contract-yaml
- task: "sales-decision-monitor 接入 P2/P3 闭环与知识可视化"
  agent: frontend-impl
  skills: [ui-consistency]
  memory: [crm-ui-nav-standards]
  knowledge_scope: { layers: [L1], max_hops: 1 }
  success: "GET /sales-decision-monitor 新增 #closure-loop 看板调 /deviation、/q-skill、/knowledge/concept-vectors 成功渲染指标（空则显『暂无数据』）；决策列表『闭环』按钮打开 modal 可写回 retro/memory/hindsight（POST 成功落库）且未登录提示登录"
```

> `agent: frontend-impl` 为非运行时 agent（CRM 注册表 4 agent 均为业务运行时智能体，不含前端实现），故本 contract 走**结构校验**（不绑 registry）；`skills: [ui-consistency]` 指 UI 一致性铁律约束；`memory: [crm-ui-nav-standards]` 指 `2026-08-27-ui-nav-standards-design.md`。

## 4. Task 2：config.html Skill 三层作用域 UI

### 4.1 内嵌表格区（新增 `<section id="skill-scope" class="dn-section">`）

- 加载时 `GET /api/skill/scope` → 表格列：`skill` / `system` / `workspace` / `user` / `生效层` / `推广溯源(promoted_from)`。
- 行内「推广到 workspace」按钮 → `POST /api/skill/scope/promote` `{skill, to:'workspace', note}` → 成功后刷新表格（HITL：端点本身 requireMe，写操作留痕 emit）。
- 空策略：若 `skill_scope` 表无记录 → 显「暂无作用域记录，可在某 skill 试跑后推广」。

### 4.2 system 层 skill 种子初始化（让表格有基线内容）

为使 config.html 打开即见内容（避免「又是空的」误判），在 `db/migrate.js` **幂等**插入 system 层 skill（取自 `src/agent/agentSpec.js` 的 `skillCalls` 并集，约 data-particle-read / method-*-engine 等）。仅 `scope_level='system'`、owner 全局（null）。已存在则跳过（`ON CONFLICT`）。

> 此种子是**展示基线**，非业务数据；不违反「不造假」——它声明「这些 skill 在 system 层默认启用」，是真实的配置事实。

### 4.3 Living Contract（Task 2）

```contract-yaml
- task: "config.html 接入 Skill 三层作用域配置 UI"
  agent: frontend-impl
  skills: [ui-consistency]
  memory: [crm-ui-nav-standards]
  knowledge_scope: { layers: [L1], max_hops: 1 }
  success: "GET /config.html 新增 #skill-scope 表格调 /skill/scope 渲染三层启用态；『推广到 workspace』按钮 POST /promote 成功后表格刷新且生效层变为 workspace"
```

## 5. UI 一致性约束（强制）

- 所有色值用 `var(--panel)` / `var(--line)` / `var(--ok)` / `var(--warn)` / `var(--text)` 等 tokens.css 语义变量；禁硬编码 `#xxx`。
- 新 section 复用 `.dn-section` / `.card` / `.l2-*` 结构；不新建全局 `:root` 变量。
- 受控页（config.html 属受控页）必须链 `/portal/page.css`（现有已链）。

## 6. 数据真实性预期（必读）

当前生产库 P2/P3 相关表均为 0 行。**接完前端后**：
- 监控页全局看板：C3/C5/D3 卡片显「暂无数据/暂无采样」（真实，非 bug）。
- config.html：经 §4.2 种子后显 system 层 skill 基线；推广后显 workspace 层。
- 单决策穿透：写回按钮可用，但历史列表（retro/记忆）需真实流量或用户手动补录才填充。

**一旦真实拜访/报价/合同推进经系统发生，上述表自然被填充**——这是设计预期的真实流量闭环，不提前伪造。

## 7. 验收 / 成功标准（可验证）

1. `GET /sales-decision-monitor` 含 `#closure-loop`：登录后三卡调真实端点渲染（空显「暂无」）；未登录显「请先登录」。
2. 决策列表「闭环」按钮 → modal 写回 retro/memory/hindsight 成功落库（L3 验证：事务内写回后 ROLLBACK 零残留）。
3. `GET /config.html` 含 `#skill-scope`：种子后显 system 层 skill；推广按钮生效。
4. 全站零硬编码色值（审计 `tmp/audit_css_vars.py` 通过）。
5. 回归：既有 `sales-decision-monitor.html` / `config.html` 其他面板不受影响；`npm run dev` 正常启动。

## 8. 风险与回归

- **登录态**：所有端点 401，前端必须处理未登录分支（否则用户见报错误以为「没变化」）。
- **并行会话**：本 Task 仅改两个 HTML + migrate seed，改动集中、零冲突风险；Edit 遇 modified-since-read 需重读重改。
- **不新增后端端点**（除 seed）：范围受控，不触碰 P2/P3 已验证模块。

## 9. 闭环回写（P10 预备）

本设计为前端实现 Task，无运行时 agent 承接；交付后由用户在 `/agents` 工作台人工核对 contract 的 `success` 达成情况，反馈记入 `<doc>.feedback.json`（如有）。
