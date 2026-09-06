# 预警规则配置页（item 21 · DB 持久化）设计文档

- 日期：2026-08-27
- 归属：CRM-ai-native 配置中心 B 组（item 21）
- 状态：设计已批准（用户「确认」），待 writing-plans

## §0 关键约束（已勘察，不可破）

1. 引擎热路径 `src/alerts/alertHook.js:22` **同步**调用 `evaluateForEvent(event)`；`test/alert.test.js` 的 T1/T4 **强制** `listAlertRules / setRuleEnabled / resetAlertRegistry / evaluateForEvent` 保持同步且签名不变。
   → **DB 持久化只能做异步旁路**，绝不能修改这些同步契约，否则破坏既有 5 类规则 + 写时触发热路径。
2. 决策第0闸（无决策不写、绝对禁删）落在 **Router（HTTP）层**，与已交付的 RBAC / business-tier / approval-flow 完全同构。
3. DB 访问范式：`import { query } from '../db.js'`，`query(text, params)` → `{ rows }`。

## §1 数据后端：新建 `crm.alert_rule` 表

建表（`db/schema.sql` 末尾追加，幂等）：

```sql
CREATE TABLE IF NOT EXISTS crm.alert_rule (
  kind         TEXT PRIMARY KEY,
  match        JSONB NOT NULL,
  check_params JSONB NOT NULL,
  severity     TEXT,                       -- 留 NULL（引擎默认 medium）
  target_role  TEXT,                       -- 留 NULL（引擎默认 ops）
  enabled      BOOLEAN NOT NULL DEFAULT TRUE,
  version      INTEGER NOT NULL DEFAULT 1,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

种子（`db/seed.sql` + `db/test-setup.sql` 末尾追加，幂等 `ON CONFLICT(kind) DO UPDATE`）：5 类规则，
`match` / `check_params` 精确镜像 `src/alerts/alertRegistry.js` 的 `DEFAULT_RULES`：

| kind | match.particleTypes | match.actions | check_params |
|------|---------------------|---------------|--------------|
| deal_stuck | CRM_DEAL | stage_update, advance | stuck_days: 30 |
| lead_overdue | CRM_DEAL | lead-picked, lead-recycled, followup, update | overdue_days: 30 |
| forecast_breach | CRM_DEAL | forecast_update, amount_update | breach_pct: 0.8 |
| approval_bottleneck | * | approval_create | bottleneck_count: 5 |
| payment_due | CRM_INVOICE | invoice_create, payment_create | due_days: 7 |

`severity` / `target_role` 种子留 NULL；`enabled=TRUE`；`version=1`。

## §2 注册表：保持同步，新增缓存层 `updateAlertRule`

`src/alerts/alertRegistry.js` 现有同步导出（`listAlertRules` / `setRuleEnabled` / `resetAlertRegistry` / `enabledAlertRules` / `evaluateForEvent`）**一律不动**。

新增纯缓存函数（**不 import db.js**，保持零 DB 依赖、零同步契约破坏）：

```js
export function updateAlertRule(kind, patch = {}) {
  const rule = rules.find(r => r.kind === kind);
  if (!rule) return { ok: false, error: 'rule_not_found' };
  if (patch.check_params != null && (typeof patch.check_params !== 'object' || Array.isArray(patch.check_params)))
    return { ok: false, error: 'invalid_check_params' };
  if (patch.enabled != null) rule.enabled = !!patch.enabled;
  if (patch.check_params != null) rule.check_params = { ...patch.check_params };
  if (patch.severity != null) rule.severity = patch.severity;
  if (patch.target_role != null) rule.target_role = patch.target_role;
  rule.version = (rule.version || 1) + 1;
  return { ok: true, rule: { ...rule } };
}
```

## §3 持久化 + 水合（异步、仅服务端）

新建 `src/alerts/alertPersist.js`（或并入 alertRegistry 模块末尾，二选一，本设计采用独立文件以隔离 DB 依赖）：

```js
import { query } from '../db.js';

export async function persistAlertRule(kind, patch) {
  await query(
    `UPDATE crm.alert_rule
       SET enabled=$1, check_params=$2::jsonb, severity=$3, target_role=$4, version=$5, updated_at=now()
     WHERE kind=$6`,
    [patch.enabled !== false,
     JSON.stringify(patch.check_params ?? {}),
     patch.severity ?? null,
     patch.target_role ?? null,
     (patch.version || 1) + 1,
     kind]
  );
}

export async function hydrateAlertRules() {
  const { rows } = await query('SELECT * FROM crm.alert_rule');
  if (!rows.length) return false;            // 表空 → 缓退回 DEFAULT_RULES
  const byKind = new Map(rules.map(r => [r.kind, r]));
  for (const row of rows) {
    const r = byKind.get(row.kind);
    if (!r) continue;                         // 仅更新已知 kind，忽略漂移
    r.enabled = row.enabled;
    r.match = row.match;
    r.check_params = row.check_params;
    r.severity = row.severity;
    r.target_role = row.target_role;
    r.version = row.version;
  }
  return true;
}
```

挂载：在 `src/http/routes.js` 的 `createRoutes` 内、`ensureTimers({}).catch(()=>{})`（line 74）旁追加：

```js
import { hydrateAlertRules } from '../alerts/alertPersist.js';
// ...
hydrateAlertRules().catch(() => {});   // 启动水合，失败静默（缓存回退种子）
```

## §4 Router：`createAlertRuleConfigRouter`

新建 `src/portal/alertRuleConfig.js`（与 `approvalFlow.js` / `rbacMatrix.js` 同构）：

```js
import { Router } from 'express';
import { requireDecision, recordDecisionEvent } from '../decision/decisionRepo.js'; // 路径以 approvalFlow.js 实际导入为准
import { listAlertRules, updateAlertRule } from '../alerts/alertRegistry.js';
import { persistAlertRule } from '../alerts/alertPersist.js';

const defaultDeps = {
  query: null,                          // 预留（当前读缓存，不查 DB）
  listRules: listAlertRules,
  updateRule: updateAlertRule,
  persist: persistAlertRule,
  produceDecision: async (ctx) => {
    try {
      const r = await requireDecision('config-change', ctx || {});
      return { decisionId: r.decision_id || null, ok: !!r.decision_id };
    } catch {
      await recordDecisionEvent('config_change', { trigger_context: ctx });
      return { decisionId: null, ok: true };
    }
  },
};

export function createAlertRuleConfigRouter(deps = {}) {
  const D = { ...defaultDeps, ...deps };
  const router = Router();
  const handlers = {
    list: async (req, res) => {
      try { res.json({ rules: D.listRules() }); }
      catch (e) { res.status(500).json({ error: e.message }); }
    },
    put: async (req, res) => {
      try {
        const { kind } = req.params;
        const { enabled, check_params, severity, target_role } = req.body || {};
        const updated = D.updateRule(kind, { enabled, check_params, severity, target_role });
        if (!updated.ok) return res.status(404).json({ error: updated.error });
        await D.persist(kind, updated.rule);
        const decision = await D.produceDecision({ key: 'alert-rule', kind });
        res.json({ ok: true, rule: updated.rule, decision: decision?.decisionId || null });
      } catch (e) { res.status(400).json({ error: e.message }); }
    },
  };
  router.get('/api/alert-rules', handlers.list);
  router.put('/api/alert-rules/:kind', handlers.put);
  router.handlers = handlers;                // 注入式测试（无 delete）
  return router;
}
```

`routes.js` 挂载（与 RBAC 同位置）：

```js
import { createAlertRuleConfigRouter } from '../portal/alertRuleConfig.js';
// ...
app.use(createAlertRuleConfigRouter({}));
app.get('/alert-rules', (req, res) => res.sendFile(fileURLToPath(new URL('../web/alert-rules.html', import.meta.url))));
app.get('/portal/alertRuleConfig.js', (req, res) =>
  res.sendFile(fileURLToPath(new URL('../portal/alertRuleConfig.js', import.meta.url)),
    { headers: { 'Content-Type': 'text/javascript' } }));
```

## §5 渲染 + 页面

`src/portal/alertRuleConfig.js` 追加渲染纯函数（浏览器 + 测试共用）：

- `KIND_LABELS`：`{ deal_stuck:'商机停滞', lead_overdue:'线索超期', forecast_breach:'预测破口', approval_bottleneck:'审批瓶颈', payment_due:'发票到期' }`
- `renderAlertRules(rules)`：5 行；每行 启停 `<input type=checkbox>` + `check_params` 阈值编辑（按 kind 渲染对应字段：stuck_days / overdue_days / breach_pct / due_days / bottleneck_count，数字输入）+ `severity` 下拉（low/medium/high）+ `target_role` 下拉（sales/finance/contract_admin/presales/manager/ops）
- `alertRuleSummary(rules)`：`{ count, enabled }`

`src/web/alert-rules.html`：拉取 `GET /api/alert-rules` → `renderAlertRules` → 编辑 → 「保存」`PUT /api/alert-rules/:kind`（带决策闸）；纯前端、无轮询（与 approval-flow.html 同构）。页面顶部注明已知限制（§8）。

## §6 配置中心

`src/portal/configCenter.js` 第 21 项：

```js
{ id: 21, name: '预警规则配置', group: '运营', status: 'ready', page: '/alert-rules.html', endpoint: '/api/alert-rules', note: 'DB 持久化 crm.alert_rule + 决策第0闸' },
```

## §7 测试（TDD 红→绿）

- `test/web/alertRuleConfig.test.js`：
  - 渲染 ~7 例：列表渲染 / 启停开关 / 按 kind 渲染对应阈值字段 / severity 下拉 / target_role 下拉 / 概要 / 域标签。
  - handler ~7 例：`list` 返回 5 规则 / `put` upsert 缓存+persist / `put` 校验失败（`invalid_check_params`）400 / 决策闸被调用 / **无 delete 路由** / 未知 kind 404 / persist 注入验证。
  - 测试注入 `persist: async()=>{}` 与 `produceDecision: async()=>({ok:true,decisionId:'d1'})`，用真实 registry（beforeEach `resetAlertRegistry()`），**零 PG 依赖**。
- 既有 `test/alert.test.js` T1/T4 **不受影响**（同步契约不变，注册表无 db 依赖）。

## §8 已知限制（写入 spec + 页面 note）

1. 内存缓存为实时热路径，DB 为持久源，启动 `hydrateAlertRules()` 回填。首次部署须先跑 `seed.sql` 建表+种子；未跑则缓存回退 `DEFAULT_RULES`（评估仍可用，配置改动不落库直到建表）。
2. 运营态告警处置端点（`/api/alerts` ack / close / evaluate / feedback metrics）仍由 `src/alerts/alertEndpoints.js` 提供，本次**不挂载**（item 21 仅配置页，留作独立任务）。
3. `severity` / `target_role` 种子为 NULL，引擎在 `alertHook.js` 默认 `medium` / `ops`；配置页可编辑，空值即沿用默认。

## §9 验收

- `test/web/` 全绿（基线 55 + ~14 = 69）；`routes.js` 加载无解析错误。
- `/alert-rules` 可列 / 编 / 存 5 类规则；写经决策第0闸；**无 DELETE**。
- 重启经 `hydrateAlertRules()` 从 DB 还原配置（PG 环境验证）。
- `db/seed.sql` + `db/test-setup.sql` 含 `crm.alert_rule` 幂等种子。

## §10 自检（spec 内审）

- 占位符：无 TBD / TODO。
- 一致性：§2 `updateAlertRule` 同步签名与 §0 约束一致；§4 Router 复用默认 `produceDecision` 与 approvalFlow.js:97 同构；§3 persist/hydrate 异步、仅服务端。
- 范围：单计划可覆盖（建表+种子+注册表缓存函数+persist/hydrate+Router+渲染+页面+配置中心+测试），无外部依赖。
- 歧义：① 决策模块导入路径以 `approvalFlow.js` 实际 `requireDecision/recordDecisionEvent` 来源为准（实施时对齐）；② `query:null` 预留项在 handler 中不使用（当前读缓存），不引入未用变量。已唯一化。
