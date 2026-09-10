# 三大系统概览页 UI 重构设计（K/M/D 三页）

- 日期：2026-09-10
- 触发：本地 localhost:3000 实测三页后反馈
  - K：`/system-overview/k.html` 显示不像"知识系统"
  - M：`/system-overview/m.html` 看不懂，希望按"图模型"显示
  - D：`/system-overview/d.html` 底部希望按"8 个阶段"汇总，可点明细进去
- 基线：沿用既有受控壳板范式（shell.html + `/api/page/*` + drillModal.js），零新增对外 API，M 仍 admin-only（不改权限铁律）。

---

## 设计原则

1. **复用图范式**：M 的图模型复用 `src/web/decision-graph.html` 的原生 SVG 节点/边渲染（无第三方库、CSS 变量取色，禁硬编码 hex）。
2. **零新 API**：所有数据取自既有函数（`listMethodologySkew` / `listSkillRegistry` / `query` 先例边 / `getGateAttribution` / `getGateOutcome` / `getTrendSamples`），不新增端点。
3. **权限铁律不变**：M 仍 sysadmin/admin 才渲染内容；非 admin 显示权限说明 + 登录提示（不降级为可读）。
4. **下钻复用**：D 的 8 阶段汇总点击后复用既有 `renderScenarioDetail` 下钻块；M 图节点点击复用既有 `renderPrecedentDetail` / 新增决策下钻块。

---

## K 改造：重构为"知识系统"概览

**问题**：当前 K 围绕"方法 SKILL ↔ DB 镜像维度漂移"展开，技术视角过窄，未呈现"知识系统"本体。
**方案**：保留四段骨架，但重新定位为知识系统三支柱概览：

- ① **顶部状态**：方法 SKILL 装配健康度——总数 N / 启用 X / 停用 Y / 维度镜像一致 Z%，闭环标识。
- ② **近 30 日趋势**：`k_method_skill` 采样 polyline（已接，不变）。
- ③ **知识系统构成**（核心改造，三栏/三表）：
  - 方法 SKILL 注册清单（按 `category` 分组，启停态徽标）
  - 维度镜像一致性（dim_skew 明细行，点击下钻到字段级漂移）
  - 本体词表覆盖（调用 `registerVocabulary` 同源 `enumHintFields()` 计数，体现知识系统"词汇治理"面）
- ④ **下钻**：点击 SKILL 行 → 完整字段（启停/RBAC/methodology_id/mirror_id/维度漂移明细）。

> 判定：K 维持**结构化概览（非图模型）**——图模型仅用于 M（用户明确点名）。若你希望 K 也改成图（方法 SKILL → DB 镜像节点），请在设计评审中提出，我将升级方案。

---

## M 改造：图模型显示

**问题**：当前 M 是 admin-only 表格（先例边 Top10 + 三构件计数），可读性差。
**方案**：admin 下渲染**节点-边图**：

- **节点**：先例节点（precedent，来自 `decision.referenced_precedents` 去重 Top N）+ 决策节点（引用这些先例的 decision）。
- **边**：`REFERENCED_PRECEDENT`（precedent → decision），沿用 `decision-graph.html` 的着色/箭头范式。
- **布局**：原生 SVG，先例节点在左列、决策节点在右列，边按引用连接；无库依赖。
- **交互**：点击先例节点 → 下钻"被哪些决策引用"清单（`renderPrecedentDetail` 复用）；点击决策节点 → 下钻该决策引用的先例（`renderDecisionDetail` 新增）。
- **顶部/趋势**：先例边数 + 30 日 `m_precedent_edge` 趋势（已接，不变）。
- **非 admin**：显示权限说明 + "请以 admin 登录后查看图模型"提示（不降级为可读）。

---

## D 改造：底部新增「8 阶段汇总」

**问题**：当前 D 底部是 L1/L2/L3 三表，缺"按 8 阶段汇总"的全局视图。
**方案**：在 L3 段之后新增 `so-d-stages` 段，复用 `safeL2()` 的 8 个 SCS 场景：

- 8 阶段常量（已在 `systemOverviewD.js:26`）：`LEAD_FOLLOW_UP / OPP_QUALIFY / SOLUTION_VALUE / QUOTE_PRICING / SIGN_RISK / POST_CONTRACT / LOSS_REVIEW / DEAL_REOPEN`。
- 渲染：8 个阶段卡片（一行展示阶段名 + 样本数 + 业务成功率徽标），按管道顺序排列。
- 交互：点击阶段卡片 → 下钻既有 `renderScenarioDetail(raw)`（样本/通过率/业务成功率/隐性错误簇），复用 `so-detail-hidden[data-dk]` 机制。
- 顶部状态、趋势、L1/L2/L3 段保持不变。

---

## 任务拆分（含生命契约）

- **T1** K 重构：顶部健康度 + 构成三栏（方法 SKILL/维度一致/本体词表）→ 成功：K 页呈现知识系统三支柱，维度明细可下钻
- **T2** M 图模型：节点-边 SVG + 节点点击下钻（先例/决策）→ 成功：admin 下 M 显示图，节点可点开明细；非 admin 显提示
- **T3** D 8 阶段汇总：底部 8 卡片 + 点击下钻 → 成功：D 底部 8 阶段汇总，每阶段可下钻到 L2 明细
- **T4** 契约测试：断言 K 含知识系统三支柱、M 含 svg 图节点、D 含 8 阶段 data-dk → 成功：测试全绿
- **T5** ui-lint + 手动浏览器冒烟（用户侧 localhost:3000）

## 验证

- `node scripts/validate-contract.mjs` 通过。
- 三页过 `ui-lint` 零新增警告。
- 用户侧 localhost:3000 实测：K 显知识系统概览、M（admin）显图模型、D 底部 8 阶段可下钻。

```contract-yaml
- task: "K/M/D 三概览页 UI 重构（知识概览 + 图模型 + 8阶段汇总）"
  agent: crm-copilot
  skills: [ai-portal-page-generation, ai-context-layering]
  memory: [crm-native]
  success: "K 呈知识系统三支柱、M(admin)呈节点-边图、D 底部 8 阶段可下钻；契约测试全绿，ui-lint 零新增警告"
```
