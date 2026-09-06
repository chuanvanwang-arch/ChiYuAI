# 指名客户管理 · 设计文档

- 日期：2026-08-30
- 需求：在 `/business-data.html`（业务主数据门户）增加「指名客户管理」入口，对每个销售员应负责的客户名单进行管理；根据后台配置的指名客户拜访频次进行统计、告警与提醒。
- 流程：brainstorming → 批准 → 本文档 → writing-plans → 实施
- 关联方法论：（指名客户拜访频次=档位×窗口）、ai-portal-page-generation（受控渲染）、ai-multi-agent-orchestration（写通道第 0 闸）、ai-feedback-loop（告警闭环）

---

## §0 决策记录（brainstorming 收敛）

| 问点 | 用户选择 | 落点 |
|---|---|---|
| 名单数据模型 | 分配信息存 CRM_ACCOUNT 粒子 payload | §1.1 |
| 是否复用 CRM_ACCOUNT 表 | 是，payload 加 named_owner/tier/named_state + 审计边 | §1.1 |
| 告警形态 | 全量告警体系 + 主动提醒 | §4 |
| 主动提醒载体 | 登录后页面顶部横幅 + 页签角标（基于现有 SSE 总线，无外部依赖） | §4 |
| 拜访统计口径 | 档位配置（named-account-targets tiers）为唯一事实源 | §1.3 |
| 页面功能 | 分配管理 + 名单列表 + 统计告警 | §2 |
| 达标重置 | 窗口内实际拜访数 ≥ 应访次数即自动解除（无人工确认） | §4 |
| 页面形态 | 方案 B：总览卡入口 + 独立页 named-account-manage.html | §2 |
| 告警阈值 | 走 DB 配置（sales-thresholds），零硬编码 | §1.2 |

---

## §1 数据模型与写通道

### 1.1 CRM_ACCOUNT payload 新增字段（分配事实）

在 `crm.particles` 的 CRM_ACCOUNT payload 上新增 3 字段，与现有 `payload.owner`（DEAL 归属）语义并存：

```jsonc
{
  "name": "上海印通包装科技有限公司",
  "named_owner": "wangchuan",      // 负责销售的 username（与 auth.resolveMe 口径一致）
  "named_tier": "重点",             // 档位：重点/目标/潜力（值域= named-account-targets tiers）
  "named_state": "active",          // 分配状态：active=指名 / inactive=软停用（不删客户粒子）
  ...原字段
}
```

关键设计点：

- **向后兼容**：现有 `namedAccountBoard.js:25` 读 `p.owner_id || p.owner` → 扩展为 `p.named_owner || p.owner_id || p.owner`；老数据无 `named_owner` 时行为不变。
- **档位唯一事实源**：`named_tier` 值域来自 `named-account-targets` 配置（id30）的 `tiers[].tier`；拜访频次目标 = 档位 × `tiers[].visit_freq`（`namedAccountTargets.js:6-15` DEFAULTS：重点 1次/周、目标 1次/月、潜力 1次/季）。
- **写通道**：分配变更 = 粒子更新，必须经**决策第 0 闸**（`requireDecision` / `scenarioDeps.produceDecision`，对齐 `namedAccountTargetsRouter.js:57` 与 `businessTier.js:59-67` 范式）。
- **审计边**：每次分配变更同步建 `crm.edges` 审计边：`edge_type='named_assignment'`，`meta` 存 `{pre, post, owner, ts, decision_id}`（对齐 `db/seed.sql:146` 受控谓词机制；绝对禁 DELETE）。
- **禁删铁律**：停用 = `named_state:'inactive'`，客户粒子仍 ACTIVE（绝对禁止 DELETE，对齐项目铁律）。

### 1.2 告警阈值（走 DB 配置，零硬编码）

复用 `salesThresholds.js` 配置层（id32），在 `coverage` 组下补 2 键（默认值=建议值，客户可调）：

```js
coverage: {
  ...（现有 lost_contact_days: 90 等）,
  named_visit_alert_days: 2,   // 应访日过后 N 天进入告警（红）
  named_visit_warn_days: 1,    // 应访日过后 N 天进入提醒（黄），须 < alert_days
}
```

- 判定逻辑纯函数 `namedVisitStatus(accountPayload, targetsCfg, thresholds)`（供页面/扫描器共用）。
- 代码零硬编码业务数值，只经 `readThreshold()`（`salesThresholds.js:69`）读取，对齐「阈值配置化铁律（2026-08-30 用户明确）」。
- `namedAccountBoard.js:43-45` 已有同范式（`bantcc.pass` / `stage.stuck_days` 读配置）。

### 1.3 拜访统计口径（唯一事实源）

- **应访次数** = `named_tier` 命中 `tiers[]` → `visit_freq.times`（缺省 1 次）；窗口 = `visit_freq.window`（week=7 天 / month=30 天 / quarter=90 天，`window_days` 可配）。
- **实际拜访次数** = `payload.visit_notes[]` 在窗口内计数（`namedAccountTargets.js:42-47 visitsInWindow`，JSONB 数组必须 `Array.isArray` — 铁律）。
- **达标判定** = `visitTargetFor`（`namedAccountTargets.js:50-62`）：`actual >= target` → pass。
- **应访日**（新增派生） = 最近一次拜访日 + 窗口周期（或无拜访 = 分配生效日 + 窗口周期）。
- **告警状态**：
  - 绿：pass（窗口内实际 ≥ 应访次数）
  - 黄（提醒）：未达，且 `距离应访日 >= named_visit_warn_days`
  - 红（告警）：未达，且 `距离应访日 >= named_visit_alert_days`

---

## §2 页面结构（方案 B：总览卡入口 + 独立页）

### 2.1 入口卡（business-data.html）

`businessDataCenter.js` 的 `BUSINESS_DATA_ITEMS` 末尾追加第 6 项（组：客户管理）：

```js
{ id: 6, name: '指名客户管理', group: '客户管理',
  page: '/named-account-manage.html',
  endpoint: '/api/board/named-account-manage',
  note: '客户×销售责任分配 + 拜访频次达标统计与告警提醒' }
```

保持门户卡片目录定位（对齐 `businessDataCenter.js:8-14` 5 项主数据卡范式）。

### 2.2 独立页 `src/web/named-account-manage.html`（三区一体）

页签风格复用 `named-accounts.html:104-110` tabs 范式；颜色 100% 走 `tokens.css` 语义变量（`--bg/--panel/--ink/--mut/--line/--ac/--ok/--err/--warn`），零硬编码色值（对齐 UI 一致性铁律 2026-08-30）。

```
┌─ page-head: 指名客户管理
│   右上：销售切换下拉（manager/admin 可切，复用 named-accounts.html:405-413 逻辑）
├─ nav.tabs: [ 📋 名单总览 | ➕ 分配管理 | 🔔 告警提醒 ]   ← 三个页签
│
├─ 📋 名单总览
│   ├─ KPI strip: 指名客户总数 / 应访未访(红) / 临近提醒(黄) / 达标(绿)
│   ├─ 表: 客户名 | 销售 | 档位 | 应访次数/窗口 | 窗口内实际 | 应访日 | 距应访日 | 状态🚨
│   └─ 每行 → 客户360 链接（/account-360.html?id=）
├─ ➕ 分配管理（admin/sysadmin/manager）
│   ├─ 新增分配: 选择客户(CRM_ACCOUNT 未分配) + 销售(user) + 档位(重点/目标/潜力)
│   ├─ 调整: 改档位 / 改负责人 / 停用分配（软停用）
│   └─ 写通道: POST 走粒子更新 + 决策第0闸 + 审计边
└─ 🔔 告警提醒
    ├─ 告警横幅(顶部, 登录后即见): 「你有 N 个指名客户应访未访(M 个超过红阈值)」
    ├─ 告警列表: 客户 | 销售 | 已逾期天数 | 应访次数 | 实际 | 跳转客户360
    └─ 达标自动解除(窗口内实际≥应访次数即回绿, 无人工确认)
```

---

## §3 接口契约

| 方法 | 路径 | 说明 | 角色闸 |
|---|---|---|---|
| GET | `/api/board/named-account-manage` | 全量名单：客户+分配+拜访统计+告警状态（按 `?owner=` 过滤） | sales 本人 / manager·admin 任意 |
| GET | `/api/named-account-assign/options` | 可选客户（未分配 CRM_ACCOUNT）+ 可选销售（users） | admin/sysadmin/manager |
| POST | `/api/named-account-assign` | 新增/调整分配；body `{account_id, owner, tier}` | admin/sysadmin/manager + 决策第0闸 |
| POST | `/api/named-account-assign/:id/deactivate` | 软停用分配（置 inactive） | admin/sysadmin/manager + 决策第0闸 |

响应字段（`GET /api/board/named-account-manage`）：

| 字段 | 说明 |
|---|---|
| `rows[]` | 名单行：id/name/owner/tier/visitTarget/visitWindow/visits30/visitPass/named/alert/overdueDays/visitDue；2026-08-31 扩展 `lostContact`/`lastContactDays` |
| `alertRed` / `alertYellow` | 应访未访红 / 临近黄（Task5 既有，与看板同源） |
| `followReminders` | **逾期红 ∪ 长期失联（≥`coverage.lost_contact_days`）去重计数** —— 侧栏「客户跟踪」角标数据源（2026-08-31 扩展） |
| `lostContactCount` | 长期失联客户数（细分明细，同上扩展） |

实现要点：

- 新增 router 工厂 `src/http/namedAccountAssignRouter.js`：注入式工厂（`defaultDeps + createRouter(deps) + router.handlers`），精确镜像 `businessTier.js:70-109` 范式，便于 vitest 注入测试。
- 名单聚合扩展 `buildNamedAccountBoard`：读 `named_owner/named_tier/named_state`，未分配客户剔除；告警状态按 `namedVisitStatus` 判定。
- 写通道 100% 决策第 0 闸；0 DELETE（停用走 deactivate）。

---

## §4 告警与提醒联动

```
scheduler/timers.js 新增定时扫描 namedVisitScan（每 N 分钟，对齐现有 30min 范式）
  → 查询 named_state='active' 的 CRM_ACCOUNT 粒子
  → namedVisitStatus(account, targetsCfg, thresholds) 纯函数判定 红/黄/绿
  → 红/黄命中 → emit('alert','named-visit-overdue', {particleType:'CRM_ACCOUNT', action:'named-visit-scan',
       metric:{account_id, owner, overdueDays}})   ← 只产生预警事件，不做跨粒子写（对齐 timers.js:5-6 铁律）
  → alertStore.createAlert({kind:'named_visit_overdue', severity, target_role:'sales',
       particle_id: account_id, payload:{account_id, owner, overdueDays, ...}})
  → alertStore 幂等：同 account+kind 未关闭不重复建
  → SSE 总线推事件（复用现有 events 流水）→ 前端横幅/角标实时刷新

前端：
  named-account-manage.html 打开时：
    GET /api/board/named-account-manage → rows（含 alert/overdueDays/visitDue 字段）→ 角标/横幅数字
      ※ 实现修正（2026-08-30 Task8）：/api/alerts 端点属 alertEndpoints.js 独立交付、当前**未挂载**（见 2026-08-27-alert-rule-config-design.md），
        告警列表与角标数字从聚合端点 rows 过滤 alert==='red' 派生（字段更全：owner/overdueDays/visitDue/visits30 齐全），
        不依赖未挂载端点；/api/alerts 后续挂载后如需切换，仅改 renderAlerts 数据源一行。
    EventSource 监听 → 实时刷新横幅数字
  登录后首页已存在 SSE 连接 → 横幅出现（无外部依赖）

  侧栏「客户跟踪」入口告警角标（2026-08-31 扩展，见 docs/2026-08-31-follow-reminder-sidebar-design.md）：
    layout.js 的 injectLayout() 启动时 GET /api/board/named-account-manage 取 followReminders
      → 在侧栏「客户跟踪」项右侧渲染红色角标（.nav-badge，色值走 --err 语义变量）
      → 之后每 60s 轮询刷新一次；仅在数字变化时重渲染侧栏 DOM（避免无谓重排）
      → 未登录/端点异常静默容错，角标保持上次成功值，绝不阻断页面
    指名客户管理页「🔔 告警提醒」页签 badge 取同一 followReminders 值（两处同源，不会各说各话）

达标自动解除：
  visitTargetFor（窗口内实际 ≥ 应访次数）时，扫描器对该 account 已 open 的
  named_visit_overdue 告警 closeAlert(alert_id, {reason:'达标自动解除'})；
  页面横幅数字随之下降（SSE 推送）—— 与「窗口内实际拜访数达标即重置」决策一致。
```

规则注册（`alertRegistry.js` 新增，与现有 7 条并列）：

```js
{ kind: 'named_visit_overdue',
  match: { particleTypes: ['CRM_ACCOUNT'], actions: ['named-visit-scan'] },
  check_params: { overdue_days: 2 },   // 阈值经 sales-thresholds coverage.named_visit_alert_days 可配
  enabled: true, version: 1 }
```

- 配置中心 id21（预警规则配置）自动出现该规则（`alertRuleConfig.js` KIND_LABELS 补 `named_visit_overdue: '指名拜访逾期'`）。
- id32（判定阈值）自动出现 `coverage.named_visit_alert_days/warn_days` 两键。

---

## §5 测试与验收

| 文件 | 测试 |
|---|---|
| `namedAccountAssign.js`（纯函数） | 档位×窗口×告警状态判定单测；未分配/软停用剔除；回退兼容（无 named_owner） |
| `namedAccountAssignRouter.js` | 注入式 GET/POST/deactivate 单测（角色闸 403 / 决策闸 / 参数校验 400） |
| `businessDataCenter.js` 新卡 | 渲染含 第6卡 + 组名「客户管理」+ 链接 |
| routes.js `/api/board/named-account-manage` | 只读聚合 + owner 过滤 + 告警状态字段 |
| `timers.js` namedVisitScan | 扫描→emit 预警事件→alertStore 幂等→达标自动关闭 |
| 回归：`named-accounts.test.js` / `home-page.test.js` | 旧行为不变（回退兼容） |

验收标准：

- 页面可分配（客户+销售+档位）→ 名单总览出现该客户+正确应访次数/窗口。
- 达到应访日 N 天未访 → 黄/红告警出现，横幅数字 +1，角标亮起。
- 窗口内补足拜访 → 自动回绿，告警自动关闭，横幅数字 -1。
- 角色闸：sales 只见本人名单；manager/admin 可切任意销售；写通道无决策返回 400。
- 禁删合规：无 DELETE 端点；停用仅置 inactive。

---

## §6 生命契约（Living Contract，双轨）

### A. Web 页面与分配管理

```contract-yaml
- task: "实现指名客户管理页（入口卡 + 三区独立页 + 分配写通道）"
  agent: followup-agent
  skills: [data-particle-read, data-particle-create, method-followup-engine]
  memory: [followup-agent]
  knowledge_scope: { layers: [L1, L2], max_hops: 3 }
  success: "GET /api/board/named-account-manage 返回分配名单且 POST 分配经决策第0闸落 payload+审计边；页面三区渲染"
```

**契约说明**：页面与分配管理由 `followup-agent` 承接，调用 `data-particle-read/create/edge-create`、读取 `followup-agent` 记忆（L1–L2，≤3 跳）；成功标准为名单接口可用、写通道经决策第 0 闸且页面三区可渲染。

### B. 告警与提醒闭环

```contract-yaml
- task: "实现指名拜访告警（namedVisitScan 定时扫描 + alertStore + SSE + 达标自动解除）"
  agent: followup-agent
  skills: [data-particle-read, method-followup-engine]
  memory: [followup-agent]
  knowledge_scope: { layers: [L1, L2], max_hops: 3 }
  success: "named_visit_overdue 规则命中产生 alertStore 记录；SSE 推送横幅；达标后自动 close"
```

**契约说明**：告警闭环由 `followup-agent` 承接，调用 `data-particle-read` + `method-followup-engine`、读取 `followup-agent` 记忆（L1–L2，≤3 跳）；成功标准为告警记录产生、SSE 推送、达标自动关闭。（注：`data-particle-edge-create` 不在该 agent skillCalls，审计边由契约 A 承载并在 writing-plans 同步扩展 agentSpec。）

### C. 配置与阈值（DB 化，零硬编码）

```contract-yaml
- task: "接入 sales-thresholds coverage.named_visit_* 阈值与 alert_rule named_visit_overdue 规则（DB 配置）"
  agent: followup-agent
  skills: [data-particle-read, method-followup-engine]
  memory: [followup-agent]
  knowledge_scope: { layers: [L1, L2], max_hops: 3 }
  success: "阈值 100% 经 readThreshold 读取；规则在 id21 列表可见；代码零硬编码业务数值"
```

**契约说明**：阈值/规则配置化由 `followup-agent` 承接，调用 `data-particle-read`、读取 `followup-agent` 记忆（L1–L2，≤3 跳）；成功标准为阈值读配置、规则可见、无硬编码。

---

## §7 闭环回写

| task | gap_type | observed | expected | severity |
|---|---|---|---|---|
| （P10 由工作台监控回写） | — | — | — | — |

（实施后由 agent-workbench 监控回写，本表初始为空；若 skill/memory/success 任一缺失，按 brainstorming §B 追加。）