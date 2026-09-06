# CRM 阶段 1 · 底座 MVP

## 启动
1. `docker compose up -d`（单库 postgres16+pgvector，端口 5433）
2. `npm run migrate && npm run seed`（幂等建表 + 种子）
3. `npm run dev`（http://127.0.0.1:3000 观测看板；/events SSE）

## 测试
- `npm test`（全量：粒子/钩子/kanban/dispatch/agentLoop/spec/http/e2e）
- `npm run test:e2e`（端到端三链路）

## 验收锚点（总体设计 §5 阶段 1）
- ✅ 粒子 Schema 全集落库（particles/edges）
- ✅ 写时向量管道跑通（embedding/tsvector 双写 + content_hash 幂等）
- ✅ kanban dispatch 派发真实任务（ready→running→done 全链路）
- ✅ SSE 事件总线雏形（5 域广播 + 观测看板实时刷新）
- ✅ 装配校验六条断言可查（/api/agents）

## 下一阶段（阶段 2）
context-layering L1-L4 注入 / memory 三构件 / Action Registry 写白名单 / 门户生成

---

## 对外分发：CRM 智能体包（技能市场）

> 设计输入：`docs/2026-08-25-ai-native-crm-overall-design.md` §6.13（对话式 CRM 智能体包）+ `docs/2026-08-26-mcp-pack-complete-plan.md`（四阶段实施计划）。

本仓库的 CRM 能力已封装为可发布到技能市场 / ClawHub 的插件包。包根结构（`agents/skills/avatars` 与 `.workbuddy-plugin/` **同级**，对齐 `@fit2-zhao/cordys-crm` 已发布格式）：

```
plugin/                      # 包根（上传单元）
  .workbuddy-plugin/
    plugin.json              # 插件清单（name/category/entries）
  agents/crm-native.md       # 对话面孔（角色自适应，5 角色）
  skills/                    # 全量打包：12 个 SKILL
    crm-native/              # 编排入口（意图路由 → 技能分发，惰性编排）
    crm-query/               # 跨模块推理查询（粒子图 + 决策网络 + pgvector）
    crm-write/               # 对话式写入（两阶段 + 决策第 0 闸 + action-confirm）
    crm-risk/                # 链断裂/异常主动探测（SSE 推送）
    method-bant/             # BANT 销售资质方法论
    method-meddicc/          # MEDDICC 决策链方法论
    method-opportunity-matrix/  # 机会矩阵排序
    method-role-map/         # 角色地图（决策链/影响者/使用者）
    method-risk-tradeoff/    # 风险权衡
    method-stop-loss/        # 止损点
    method-fact-vs-script/   # 事实 vs 话术
    method-presales/         # 售前解决方案方法论
    method-behavior-standard/ # 销售行为标准（行为达标自测）
    method-funnel-classification/ # 大漏斗分类（商机/目标/潜在客户）
    method-stage-progression/ # 阶段推进（S1-S6 阶段门禁与推进）
  avatars/crm-native.png
  README.md
```

### 2026-08-31 同步说明（对齐平台当日改动）

> 本包自仓库根 `skills/` 主源重新同步（README 第 71 行：plugin 为分发副本，源侧更新后需重打包）。本次同步覆盖平台当日改动：

- **销售术语统一重命名**：阶段码 `P1-P6` → `S1-S6`、旧英文阶段名（`lead/opportunity/quoted/contracted/ordered/paid/lost/disqualified`）→ `S1-S8` 单一事实源（`src/sales/stageTaxonomy.js`）；`DSM` → `sales`。插件内 `crm-risk`/`method-bant` 等陈旧阶段引用已一并校正。
- **新增 3 个完整方法技能**（含 `registry.json`，已注册可分发）：`method-behavior-standard`（销售行为标准）、`method-funnel-classification`（大漏斗分类）、`method-stage-progression`（阶段推进门禁）。注：`method-followup-engine`/`method-intake-routing`/`method-quote-engine`/`method-review-gate` 仍无 `registry.json`，属 WIP，暂未纳入分发包。
- **平台新增能力端点**（助手路由已可指向）：指名客户看板 `/api/board/named-accounts` 与管理面 `/api/board/named-account-manage`；漏斗质量看板 `/api/page/funnel-quality`；销售阈值配置 `/sales-thresholds-config.html`、审批流配置 `/approval-config.html`；决策可审计性 `/api/decision/:id/audit-4q` 与 `/api/monitor/auditability`。
- 版本号 `1.0.0` → `1.1.0`。

### MCP Server（对外无头暴露）

任意办公智能体经 MCP Server 调用本平台能力（零信任、凭证隔离、绝对禁删）。**首次接入必须先 `crm_login(username,password)` 用户名密码验证领取 token**，之后所有工具调用携带 `api_token`（或 `Authorization: Bearer`）；无有效凭证 → `gate='auth_required'` 硬拒绝（08-29 强制登录改造，`requireAuth=true`，不再免登录降级）：

```bash
npm run mcp:http     # StreamableHTTP @3001 /mcp（供外部 Agent 无头调用）
npm run mcp:stdio     # stdio（供本地 Agent 子进程调用）
```

- **登录**：`crm_login(username,password)`（免 token 调用）→ 返回 `{ok, token, role, display_name}`；仅业务账号可登录（admin 仅限 HTTP 后台）。
- **读工具**：直连 Action Registry 读操作，无需确认。
- **写工具**：两阶段（phase1 取表单 → 返回 `confirm_token`；phase2 携 `confirm_token` 执行），并强制 `decision_id`（决策第 0 闸）。
- **安全红线**：无 delete/remove 工具；凭证格式升级后旧 token 需重新 `crm_login`（结构化 token `crm_<id>_<secret>`）；无凭证一律 `auth_required`。

### 技能市场 / ClawHub 安装

1. 将整个 `plugin/` 包根（含 `.workbuddy-plugin/` + 包根 `agents/ skills/ avatars/` + `README.md`）整体打包为 zip 上传。
2. 在 WorkBuddy「技能市场 → 上传插件」，或 ClawHub（`openclaw skills install @<you>/crm-native`）提交该 zip（外部发布操作，需用户在对应平台侧完成）。
3. 安装后，办公智能体挂载 `crm-native` 即获得一句话查询 / 两阶段写入 / 链断裂预警能力。

> 注意：`plugin/skills/` 是分发副本（源事实在仓库根 `skills/`）。源侧更新后需重新执行打包；跨会话维护以仓库根 `skills/` 为准。包结构已对齐 `@fit2-zhao/cordys-crm` 的 ClawHub 发布格式（agents/skills/avatars 与 `.workbuddy-plugin/` 同级）。

---

## API 端点口径（graph=canonical / monitor=deprecated · 2026-08-26 拍板）

> 决策查询（决策因果链/影响地图/PROV-O 溯源）对外暴露**单一 canonical 查询面**，旧 monitor 面保留为 **deprecated 薄转发**（不删、可回滚、带 Deprecation+Link 头）。详见总体设计 `docs/specs/2026-08-25-ai-native-crm-overall-design.md` §9。

| 端点 | 口径 | 说明 |
|---|---|---|
| `GET /api/graph/trace?decisionId=&max_depth=` | **canonical** | 决策因果链（上游=为什么 / 下游=导致了什么，AGE 多跳，降级 ctePrecedents） |
| `GET /api/graph/impact?decisionId=&max_depth=` | **canonical** | 影响地图（下游全节点+深度+边） |
| `GET /api/graph/provenance?decision_id=` | **canonical** | PROV-O 溯源审计（链完整+条目+上下游+先例） |
| `GET /api/monitor/trace/:decisionId` | **deprecated** | 兼容薄转发 → graph/trace（含 Deprecation+Link 头） |
| `GET /api/monitor/impact/:decisionId` | **deprecated** | 兼容薄转发 → graph/impact |
| `GET /api/monitor/audit?decision_id=` | **deprecated** | 兼容薄转发 → graph/provenance |

**纪律**：新代码/新智能体一律接 `/api/graph/*`；monitor 壳仅供旧调用兼容，不得新增引用；未来无流量（可观测确认）后经决策事件主轴批准再删。
