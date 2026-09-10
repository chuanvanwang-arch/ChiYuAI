# 三系统概览页（监控仪表盘）设计

> 日期：2026-09-10　作者：WorkBuddy
> 目标：将销售决策监控台总览页（`sales-decision-monitor.html`）的三张系统闭环卡（知识/记忆/决策）从「跳配置页」改为「跳独立运行时监控概览页」。
> 性质：**设计文档，已获用户批准（2026-09-10 12:00）**。实施中仅可调整，不可改设计语义。

---

## §0 结论（先给答案）

**三张卡的 href 改为独立监控概览页**：知识→`/system-overview/k`、记忆→`/system-overview/m`、决策→`/system-overview/d`。

**新建三个受控壳页** `src/web/system-overview-k.html` / `m.html` / `d.html`，轻前端壳，加载 `/api/page/system-overview-{k|m|d}` 渲染器。**配置页 skills.html / memory.html / decision-scenarios.html 原样保留**，仍可从配置中心 id14/16/26 进入。

**每个概览页是「运行时监控仪表盘」（只读）**，采用四段式骨架：
1. 顶部状态条（已闭环/有漂移/断点 + 关键 KPI）
2. 近 30 日趋势（sparkline / mini chart，纯前端 SVG）
3. 明细表（K：SKILL 清单+维度漂移；M：先例边 Top+三构件+蒸馏；D：L1 拦截+L2 场景通过率+L3 待批）
4. 可下钻子页（点行 → 弹窗/折叠块）

**权限隔离**：K/D 登录可读；M 仅 sysadmin；非 admin 访问 M 时显「仅管理员可访问」+ 监控台三闭环卡 fallback 链接。

---

## §1 现状盘点

### 1.1 三闭环卡（截图位置）
`src/web/sales-decision-monitor.html:404-418`：
```html
<div id="loop-strip" class="loop-strip">
  <a class="loop-card" href="/skills.html" id="loop-knowledge">…</a>
  <a class="loop-card" href="/memory.html" id="loop-memory">…</a>
  <a class="loop-card" href="/decision-scenarios.html" id="loop-decision">…</a>
</div>
```
每张卡的 `desc` 区域由 `loadLoops()`（同文件 1049-1113 行）已填充摘要文本（**保留不动**）。

### 1.2 数据源（已有，零新增接口）

| 系统 | 数据源 |
|---|---|
| K | `/api/methodology/skew` + `/api/config/skill-registry` |
| M | `/api/memory`（仅 admin，GET 返回 `{logs, notes, snapshots, precedents}`） + `/api/monitor/decisions?limit=200`（先例边累加） |
| D | `/api/monitor/gates`（闸门清单唯一事实源）+ `/api/monitor/gate-attribution`（L1 拦截）+ `/api/monitor/gate-outcome?scenario_id=…`（L2 结果）+ `/api/calibration/patches?status=PENDING`（L3 待批，仅 admin） |

### 1.3 现有受控壳板范式（S21）
- `agent-workbench.html` 用 `GET /api/page/agent-workbench` → 渲染器返回已渲染 HTML
- skills.html 也是同范式：`/api/page/skill-registry` + 受控壳
- 参照：src/http/controlledConfigPages.js + src/http/routes.js 受控壳注册段

---

## §2 目标布局（三页公共骨架）

```
┌─ 顶部状态条：已闭环/有漂移/断点 + 关键 KPI（与 #loop-strip 同口径）
├─ 近 30 日趋势：sparkline / mini chart（纯前端 SVG，零依赖）
├─ 明细表：
│   K：方法 SKILL 清单（启停/维度漂移）+ 镜像维度矩阵
│   M：先例边 Top + 三构件（日志/笔记/快照）+ 蒸馏状态
│   D：L1 拦截明细（按闸门）+ L2 场景通过率分布 + L3 待批处方
└─ 可下钻：点行 → 弹窗（K：单 SKILL 详情；M：单先例/单条记忆；D：单决策三卡折叠块）
```

---

## §3 任务分解（含契约）

````contract-yaml
- task: "T1. sales-decision-monitor.html 三闭环卡 href 改造"
  agent: system-overview-shell
  skills: []
  memory: []
  knowledge_scope: { layers: [L0], max_hops: 0 }
  success: "#loop-knowledge/memory/decision 的 href 分别指向 /system-overview/{k|m|d}；配置中心 id14/16/26 仍指向 skills.html/memory.html/decision-scenarios.html（grep + curl 双验）"
- task: "T2. 三个受控壳页 system-overview-{k|m|d}.html"
  agent: system-overview-shell
  skills: []
  memory: []
  knowledge_scope: { layers: [L0], max_hops: 0 }
  success: "GET /system-overview/{k|m|d}.html 返回 HTML 含 #page-root[data-page]；JS 拉 /api/page/system-overview-{k|m|d}；浏览器无 404 与控制台报错；routes.js 已注册受控壳"
- task: "T3. /api/page/system-overview-k 渲染器（知识系统）"
  agent: system-overview-knowledge
  skills: []
  memory: []
  knowledge_scope: { layers: [L0], max_hops: 0 }
  success: "GET /api/page/system-overview-k 返回 HTML 含四段式骨架：①顶部状态 ②近 30 日趋势 SVG ③SKILL 清单+维度漂移表 ④行点击下钻弹窗；骨架含 data-* 钩子便于 ui-lint"
- task: "T4. /api/page/system-overview-m 渲染器（记忆系统）"
  agent: system-overview-memory
  skills: []
  memory: []
  knowledge_scope: { layers: [L0], max_hops: 0 }
  success: "GET /api/page/system-overview-m 返回 HTML 含四段式骨架；非 admin 访问显「仅管理员可访问」说明 + 监控台三闭环卡 fallback 链接"
- task: "T5. /api/page/system-overview-d 渲染器（决策系统）"
  agent: system-overview-decision
  skills: []
  memory: []
  knowledge_scope: { layers: [L0], max_hops: 0 }
  success: "GET /api/page/system-overview-d 返回 HTML 含四段式骨架（L1 拦截明细 + L2 场景通过率分布 + L3 待批处方），L3 部分对非 admin 显「—（需 admin）」"
- task: "T6. 契约校验 + 浏览器冒烟"
  agent: system-overview-shell
  skills: []
  memory: []
  knowledge_scope: { layers: [L0], max_hops: 0 }
  success: "node scripts/validate-contract.mjs docs/2026-09-10-system-overview-pages-design.md 通过（结构校验，不传 --registry）；3 个新页面过 node scripts/ui-lint.mjs；Playwright 截图 k/m/d 三页含 KPI/趋势/明细/下钻四段"
````
> **契约说明**：本任务由四个页面级壳板 agent 承接（`system-overview-{shell|knowledge|memory|decision}`），均无 SKILL 调用、无记忆读取、无 KG 层级消费——属纯前端受控壳板渲染任务。沿用既有先例（`sales-decision-monitor` 页面级 key 不在 agentSpec 注册），validate-contract 在不传 `--registry` 时仅做结构校验。

---

## §4 不做的事（YAGNI）

- ❌ 不新增 SKILL / 不动 agentSpec
- ❌ 不改 skills.html / memory.html / decision-scenarios.html 配置页
- ❌ 不动配置中心 id14/16/26 入口（路由仍指向配置页）
- ❌ 不改 sales-decision-monitor.html 其它部分（仅 3 个 href + 保持 #loop-strip desc 文本）
- ❌ 不改现有所有 API 端点

---

## §5 范围/影响

- **修改**：sales-decision-monitor.html（3 处 href，约 6 字节变化）、routes.js（3 处 `app.get` 受控壳注册）
- **新建**：
  - `src/web/system-overview-k.html` / `m.html` / `d.html`（约 50 行/个壳页）
  - `src/http/render/systemOverviewK.js` / `M.js` / `D.js`（约 250-400 行/个渲染器）
  - 受控壳注册段（参照 `controlledConfigPages.js` 已有模式）
- **零修改**：skills.html / memory.html / decision-scenarios.html / 配置中心元数据 / 现有所有 API

---

## §6 验收口径（执行后必须真实通过）

1. `curl -s http://localhost:3000/system-overview/k` → HTML 含四段式骨架（顶部+趋势+明细+下钻钩子）
2. m/d 类推；非 admin 访问 m 显权限说明 + 监控台 fallback 链接
3. `#loop-strip` 三张卡点击 → 浏览器无 404，地址栏变为 `/system-overview/{k|m|d}`
4. `node scripts/ui-lint.mjs src/web/system-overview-{k|m|d}.html` 通过
5. `node scripts/validate-contract.mjs docs/2026-09-10-system-overview-pages-design.md` 通过（结构校验）

---

## §7 实施顺序（粗粒度）

1. T1：sales-decision-monitor.html 三个 href 改完（前置，但截图页面要暂留工作避免监控台断链）
2. T2：三个受控壳页 + routes.js 注册
3. T3-T5：三个渲染器（可并行，按数据源就位即可）
4. T6：契约校验 + 浏览器冒烟

---

## §8 闭环回写（待 P10）

本任务为**纯前端受控壳板渲染**，无 SKILL/agent 真实调用，不进入 `agent_health/agent_sla/agent_alerts` 等监控表。契约 ID 命名约定沿用 `ct-<scope>-<n>` 模式但**不写入** `src/agent/contractIds.js`（仅本设计文档 + 渲染器文件内部使用）。

- T1-T2 任务：受控壳板 DOM 注入
- T3-T5 任务：渲染器输出 HTML
- T6 任务：契约 + ui-lint + 浏览器冒烟

> 真实运行反馈：本任务无 agent episode 产生，**不进入 agent_workbench 监控面板**。如未来某天该渲染器引入 LLM 摘要，再增补 contract_task_id。

---

## §9 与既有 2026-09-04 文档关系

本设计是 `docs/2026-09-04-sales-decision-monitor-tab-redesign.md` 的**收口补强**——彼时「三闭环条」保留但仅作为摘要卡，点击跳配置页一直被诟病「看不到运行情况」。本次把「运行情况」独立成概览页，与配置页（skills.html/memory.html/decision-scenarios.html）形成**两层职责分离**：

| 入口 | 职责 | 角色 |
|---|---|---|
| **配置页**（skills.html 等） | 启停 SKILL / 蒸馏触发 / 调整场景尺子 | sysadmin 写入 |
| **概览页**（/system-overview/{k\|m\|d}） | 只读监控：状态/指标/趋势/明细 | 登录可读（M 仅 admin） |
| **监控台三闭环卡**（#loop-strip） | 顶部实时摘要 | 全员 |

---

## §10 风险与回退

- **风险 1**：非 admin 用户点击记忆卡后看到「仅管理员可访问」，体验不友好 → 设计上保留监控台 fallback，避免硬阻。
- **风险 2**：三个新页与现有三个配置页路径相似（`/system-overview/m` vs `/memory.html`），用户混淆 → 概览页 title 明确为「记忆系统·运行概览」，配置页 title「记忆/先例管理」。
- **回退**：若实施失败或用户反馈不佳，把 T1 的三个 href 改回 `/skills.html` / `/memory.html` / `/decision-scenarios.html`，新页面保留为「另一种入口」。