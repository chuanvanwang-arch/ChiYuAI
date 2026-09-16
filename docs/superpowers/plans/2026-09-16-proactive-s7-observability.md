# S7 实施计划 · 链路观测与信任校准（T20）— TDD 实现计划

> 来源设计：`docs/2026-09-15-final-design-coexistence-and-proactive.md` §T20（线 B，S7）
> 范围锚定：T20 信号链路观测上墙（投递成功率/延迟/冲突/执行量）+ 负向判据报警（delivery_silent / gen_silent）+ 降级事件可追溯
> 配套：S6 已落地「连续 rejected 自动 paused + emit trace」（`grant-executions/:id/verdict` + `grantSweeper`）；T20 补**查询面 + 指标上墙 + 主动报警**，不重复造自动降级逻辑。
> conventions：TDD（先红后绿）→ 每 Task 一 commit；零 DELETE；第 0 闸（本计划只读/状态变更，不动写通道）；租户隔离（全部查询带 tenant_id）；相对 import。

## 0. 现状核验（本次实读，非臆测）

| 项 | 实测结论 | 影响 |
| --- | --- | --- |
| `crm.signal` 表 | **存在**（schema.sql:1028）：`tenant_id/source/kind/status/created_at/dedup_key` 等列齐全 | 指标与判据可直接聚合 |
| `crm.signal_delivery` 表 | **存在**（schema.sql:1059）：`channel/status[pending\|sent\|failed\|skipped]/delivered_at/created_at` 齐全 | 投递成功率/延迟/冲突可算 |
| `crm.grant_execution` 表 | **存在**（S6，schema.sql:1194）：`hitl_verdict[adopted\|rejected\|pending]/rejected_at/created_at` | 执行量 + 降级溯源可用 |
| `crm.standing_grant` 表 | **存在**（S6，schema.sql:1169）；但**无 `paused_at` / `paused_reason` 列**（`pauseGrant` 仅 `status='paused'`） | T20 须补列，否则「降级事件可在追溯链中查到」无时间戳/原因 → 不可窗口化查询 |
| `syncMetrics.js` / `syncMetricsRouter.js` | **存在**（T07 同构范式：getSyncMetrics({pool,tenantId}) + Router GET） | 直接镜像；**但 `syncMetricsRouter` 全仓未被 `app.use` 挂载（端点未上线）——独立发现，非 S7 范围** |
| `emit(domain,type,payload)` | 签名确认（events/bus.js:17） | 负向判据/降级报警用 `emit('trace', ...)` |
| `createAlert` / `createAlertWithDb` | 内存 Map + 可选 persister（alertStore.js）；persister 注入后落 `crm.signal` | 负向判据定时器报警复用之 |
| 自动降级逻辑 | **已落地**（S6）：verdict 连续 rejected 达阈值 → `pauseGrant` + `emit('trace','grant-auto-paused')` | T20 不重造，只补「可查询/可上墙」 |
| signal-center.html | **存在**（src/web/signal-center.html）：拉 `/api/signals` 列表 + ack/close | T20 加指标面板 + 负向告警 + 降级列表 |

## 1. 指标与负向判据模型（§T20 落地判据）

**4 指标（按 tenant_id 隔离）**：
- `delivery_success_rate` = sent / (sent+failed)；无投递尝试时返回 `null`（**不谎报 100%**，防假绿）
- `avg_latency_ms` = AVG(delivered_at − created_at)（仅 sent 且 delivered_at 非空）；无则 `null`
- `conflict` = failed + skipped（投递侧损失/冲突计数）
- `execution_volume` = COUNT(crm.grant_execution)（S6 自治执行量，串联主动运行时闭环）

**负向判据（success 要求「存在负向判据 → 报警」）**：
- **A. delivery_silent**（无投递行但渠道为 on）：`enabledChannels`（默认 `['inbox','email','im','webhook']`，可配置）中任一渠道在窗口内有信号产生（`signal_count>0`）但零投递行 → 报警 `{type:'delivery_silent', channel}`。
- **B. gen_silent**（hits>0 而新增 signal=0，摄取→信号桥静默）：窗口内 `source='event-trigger'` 信号（外部事件命中=fired）>0，但 `source IN ('rule-scan','agent-research','external')` 的新增内部信号=0 → 报警 `{type:'gen_silent', fired}`。
  > 解释说明（诚实口径，非臆测）：设计原文「hits>0 而新增 signal=0」的 hits 无独立计数表，本计划用 `crm.signal.source='event-trigger'` 作为「检测已触发」事实源、用内部生成信号作为「已落地」事实源，二者为独立子集，判据可真实触发且可单测。

**降级追溯（「降级事件可在追溯链中查到」）**：
- `getDowngradeEvents`：查 `crm.standing_grant WHERE status='paused'`（须 `paused_at`/`paused_reason` 列，T20-3 补）+ 近期 `crm.grant_execution WHERE hitl_verdict='rejected'`。
- S6 已 `emit('trace','grant-auto-paused')`；T20 补查询面使其可在 signal-center 上墙追溯。

## 2. 文件结构

```
db/schema.sql                              (+ standing_grant.paused_at / paused_reason 两列，建表单一事实源)
db/migration-standing-grant-paused.sql    (新：ALTER TABLE ADD COLUMN IF NOT EXISTS)
db/migrate.js                              (注册 migration-standing-grant-paused.sql)
src/authorization/grantStore.js            (MODIFY：pauseGrant 置 paused_at=now()/paused_reason)
src/monitor/signalMetrics.js               (新建：getSignalMetrics + detectNegativePredicates + getDowngradeEvents)
src/http/signalMetricsRouter.js            (新建：GET /api/monitor/signal-link，per-tenant；挂载于 createRoutes)
src/scheduler/timers.js                     (+ 定时器⑯ signal-observability-scan，VITEST 护栏)
src/web/signal-center.html                 (MODIFY：加指标卡 + 负向告警 + 降级列表面板)
test/monitor/signalMetrics.test.js         (新建：纯函数 + 真库指标 + 负向判据 + 降级查询)
test/http/signalMetrics.test.js            (新建：live express + fetch e2e，per-tenant 隔离)
test/authorization/grantStore.paused.test.js (新建：pauseGrant 补列落库)
```

## 3. 任务（TDD，逐 Task 一 commit）

### T20-1：getSignalMetrics（投递成功率/延迟/冲突/执行量，per-tenant）

- [ ] **Step 1（红）**：`test/monitor/signalMetrics.test.js` 连真库 `crm_native_test`，建测试租户 `t20m1`，插入 `crm.signal` + `crm.signal_delivery`（sent/failed/skipped 混合）+ `crm.grant_execution` 若干；断言 `getSignalMetrics({tenantId, since})` 返回 `delivery_success_rate`/`avg_latency_ms`/`conflict`/`execution_volume`/`by_channel` 正确；另一租户 `t20m2` 无数据 → `delivery_success_rate=null`（不谎报）。先跑→红（函数不存在）。
- [ ] **Step 2（绿）**：`src/monitor/signalMetrics.js`：
  ```js
  import { query } from '../db.js';

  const DEFAULT_CHANNELS = ['inbox', 'email', 'im', 'webhook'];

  // getSignalMetrics({ tenantId, since }) — 全部聚合带 tenant_id（租户隔离）
  export async function getSignalMetrics({ tenantId, since }) {
    const sinceTs = since instanceof Date ? since : new Date(since);
    const { rows: [d] } = await query(
      `SELECT
         COUNT(*) FILTER (WHERE status='sent') AS sent,
         COUNT(*) FILTER (WHERE status='failed') AS failed,
         COUNT(*) FILTER (WHERE status='skipped') AS skipped,
         COUNT(*) AS total,
         AVG(EXTRACT(EPOCH FROM (delivered_at - created_at)) * 1000)
           FILTER (WHERE status='sent' AND delivered_at IS NOT NULL) AS avg_latency_ms
       FROM crm.signal_delivery WHERE tenant_id=$1 AND created_at >= $2`,
      [tenantId, sinceTs]
    );
    const delivery = d || { sent: 0, failed: 0, skipped: 0, total: 0, avg_latency_ms: null };
    const sent = Number(delivery.sent || 0);
    const failed = Number(delivery.failed || 0);
    const attempted = sent + failed;
    const success_rate = attempted > 0 ? sent / attempted : null; // 无尝试→null（防假绿）

    const { rows: ch } = await query(
      `SELECT channel,
         COUNT(*) FILTER (WHERE status='sent') AS sent,
         COUNT(*) FILTER (WHERE status='failed') AS failed,
         COUNT(*) FILTER (WHERE status='skipped') AS skipped,
         COUNT(*) AS total
       FROM crm.signal_delivery WHERE tenant_id=$1 AND created_at >= $2 GROUP BY channel`,
      [tenantId, sinceTs]
    );
    const by_channel = (ch || []).map(r => ({
      channel: r.channel,
      sent: Number(r.sent || 0), failed: Number(r.failed || 0),
      skipped: Number(r.skipped || 0), total: Number(r.total || 0),
    }));

    const { rows: [ex] } = await query(
      `SELECT COUNT(*) AS execution_volume FROM crm.grant_execution WHERE tenant_id=$1 AND created_at >= $2`,
      [tenantId, sinceTs]
    );
    const { rows: [sg] } = await query(
      `SELECT COUNT(*) AS signal_count FROM crm.signal WHERE tenant_id=$1 AND created_at >= $2`,
      [tenantId, sinceTs]
    );
    return {
      tenant_id: tenantId,
      since: sinceTs.toISOString(),
      delivery_success_rate: success_rate,
      avg_latency_ms: delivery.avg_latency_ms != null ? Number(delivery.avg_latency_ms) : null,
      conflict: failed + Number(delivery.skipped || 0),     // failed+skipped 视为投递侧冲突/损失
      execution_volume: Number(ex?.execution_volume || 0),
      signal_count: Number(sg?.signal_count || 0),
      delivery: { sent, failed, skipped: Number(delivery.skipped || 0), total: Number(delivery.total || 0) },
      by_channel,
    };
  }
  ```
- [ ] **Step 3**：重跑 → 绿。提交：`src/monitor/signalMetrics.js test/monitor/signalMetrics.test.js`（本步只含 getSignalMetrics；负向判据/降级在 T20-2/3 续加同文件）。

### T20-2：detectNegativePredicates（delivery_silent + gen_silent）

- [ ] **Step 1（红）**：`test/monitor/signalMetrics.test.js` 追加：租户 `t20n1` 插 3 条 `crm.signal`（窗口内）+ 0 条 `crm.signal_delivery` → `detectNegativePredicates({tenantId, since, enabledChannels:['email']})` 返回含 `{type:'delivery_silent', channel:'email'}`；插 `crm.signal source='event-trigger'` 2 条 + 0 条内部信号 → 返回 `{type:'gen_silent'}`；正常有投递+有内部信号 → 返回 `[]`。先跑→红。
- [ ] **Step 2（绿）**：`src/monitor/signalMetrics.js` 追加：
  ```js
  // detectNegativePredicates({ tenantId, since, enabledChannels=DEFAULT_CHANNELS })
  // → [{type:'delivery_silent',channel}] | [{type:'gen_silent',fired}]
  export async function detectNegativePredicates({ tenantId, since, enabledChannels = DEFAULT_CHANNELS }) {
    const sinceTs = since instanceof Date ? since : new Date(since);
    const { rows: [sg] } = await query(
      `SELECT COUNT(*) AS c FROM crm.signal WHERE tenant_id=$1 AND created_at >= $2`,
      [tenantId, sinceTs]
    );
    const signalCount = Number(sg?.c || 0);
    const alerts = [];
    // 判据 A：无投递行但渠道为 on（enabledChannels 视为 on）
    if (signalCount > 0) {
      const { rows: ch } = await query(
        `SELECT channel, COUNT(*) AS c FROM crm.signal_delivery
         WHERE tenant_id=$1 AND created_at >= $2 GROUP BY channel`,
        [tenantId, sinceTs]
      );
      const delivered = new Set((ch || []).map(r => r.channel));
      for (const name of enabledChannels) {
        if (!delivered.has(name)) alerts.push({ type: 'delivery_silent', channel: name, tenant_id: tenantId });
      }
    }
    // 判据 B：hits>0 而新增 signal=0（event-trigger 命中但无内部信号生成）
    const { rows: [fired] } = await query(
      `SELECT COUNT(*) AS c FROM crm.signal
       WHERE tenant_id=$1 AND source='event-trigger' AND created_at >= $2`,
      [tenantId, sinceTs]
    );
    const firedCount = Number(fired?.c || 0);
    if (firedCount > 0) {
      const { rows: [landed] } = await query(
        `SELECT COUNT(*) AS c FROM crm.signal
         WHERE tenant_id=$1 AND source IN ('rule-scan','agent-research','external') AND created_at >= $2`,
        [tenantId, sinceTs]
      );
      if (Number(landed?.c || 0) === 0) alerts.push({ type: 'gen_silent', tenant_id: tenantId, fired: firedCount });
    }
    return alerts;
  }
  ```
- [ ] **Step 3**：重跑 → 绿。提交：`src/monitor/signalMetrics.js test/monitor/signalMetrics.test.js`（同文件追加）。

### T20-3：standing_grant 补 paused_at/paused_reason + getDowngradeEvents（降级追溯）

- [ ] **Step 1（红）**：`test/authorization/grantStore.paused.test.js`：插一条 `standing_grant`（status='active'），调 `pauseGrant(tenantId, grantId, 'consecutive-rejects')` → 断言 `paused_at` 非空、`paused_reason='consecutive-rejects'`。`test/monitor/signalMetrics.test.js` 追加：`getDowngradeEvents({tenantId, since})` 返回 `paused_grants`（含 paused_at/原因）+ `rejected_executions`。先跑→红（列不存在 / paused_at 不落）。
- [ ] **Step 2（绿）**：
  - `db/schema.sql`：`crm.standing_grant` 追加 `paused_at TIMESTAMPTZ NULL,` + `paused_reason TEXT NULL,`（在 `revoked_reason` 后，`created_at` 前，保持列序一致）。
  - `db/migration-standing-grant-paused.sql`：`ALTER TABLE crm.standing_grant ADD COLUMN IF NOT EXISTS paused_at TIMESTAMPTZ;` + `ADD COLUMN IF NOT EXISTS paused_reason TEXT;`。
  - `db/migrate.js`：数组追加 `'migration-standing-grant-paused.sql'`（在 `migration-standing-grant.sql` 之后）。
  - `src/authorization/grantStore.js`：`pauseGrant(tenantId, grantId, reason)` 的 UPDATE 改为 `SET status='paused', paused_at=now(), paused_reason=$3 WHERE tenant_id=$1 AND grant_id=$2`（参数 `$3=reason`）。
  - `src/monitor/signalMetrics.js` 追加：
    ```js
    // getDowngradeEvents({ tenantId, since }) — 降级（paused）凭证 + 近期 rejected 执行
    export async function getDowngradeEvents({ tenantId, since }) {
      const sinceTs = since instanceof Date ? since : new Date(since);
      const { rows: grants } = await query(
        `SELECT grant_id, tenant_id, title, risk_tier, status, paused_at, paused_reason
         FROM crm.standing_grant
         WHERE tenant_id=$1 AND status='paused' AND (paused_at IS NULL OR paused_at >= $2)
         ORDER BY paused_at DESC NULLS LAST`,
        [tenantId, sinceTs]
      );
      const { rows: execs } = await query(
        `SELECT execution_id, grant_id, hitl_verdict, rejected_at
         FROM crm.grant_execution
         WHERE tenant_id=$1 AND hitl_verdict='rejected' AND created_at >= $2
         ORDER BY created_at DESC`,
        [tenantId, sinceTs]
      );
      return {
        paused_grants: (grants || []).map(r => ({ ...r, paused_at: r.paused_at ? new Date(r.paused_at).toISOString() : null })),
        rejected_executions: (execs || []).map(r => ({ ...r })),
      };
    }
    ```
- [ ] **Step 3**：重跑两测试 → 绿。提交：`db/schema.sql db/migration-standing-grant-paused.sql db/migrate.js src/authorization/grantStore.js src/monitor/signalMetrics.js test/authorization/grantStore.paused.test.js test/monitor/signalMetrics.test.js`。

### T20-4：signalMetricsRouter（GET /api/monitor/signal-link，per-tenant）+ 挂载

- [ ] **Step 1（红）**：`test/http/signalMetrics.test.js`（live express + `vi.mock('../../src/http/auth.js', () => ({ resolveMe: vi.fn() }))`，仿 S6 standingGrants 模式）：租户 `t20h1` 有信号+投递 → `GET /api/monitor/signal-link` 返回 `metrics.delivery_success_rate` 等 + `negative_predicates` + `downgrades`；租户 `t20h2`（无数据）→ `delivery_success_rate=null` 且 `negative_predicates` 含 delivery_silent（信号>0 无投递场景由测试构造）；`resolveMe` 返回 `ok:false` → 401。先跑→红。
- [ ] **Step 2（绿）**：`src/http/signalMetricsRouter.js`：
  ```js
  // src/http/signalMetricsRouter.js — GET /api/monitor/signal-link（T20 上墙，per-tenant）
  import { Router } from 'express';
  import { resolveMe } from '../http/auth.js';
  import { getSignalMetrics, detectNegativePredicates, getDowngradeEvents } from '../monitor/signalMetrics.js';

  export function createSignalMetricsRouter() {
    const r = Router();
    r.get('/signal-link', async (req, res) => {
      try {
        const me = resolveMe(req);
        if (!me?.ok) return res.status(401).json({ error: me?.error || 'unauthorized' });
        const since = req.query.since ? new Date(req.query.since) : new Date(Date.now() - 24 * 3600 * 1000);
        const [metrics, negative_predicates, downgrades] = await Promise.all([
          getSignalMetrics({ tenantId: me.tenantId, since }),
          detectNegativePredicates({ tenantId: me.tenantId, since }),
          getDowngradeEvents({ tenantId: me.tenantId, since }),
        ]);
        res.json({ metrics, negative_predicates, downgrades });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });
    return r;
  }
  ```
  挂载：在 `src/http/routes.js` 的 `createRoutes` 内（靠近 standing-grants 挂载处）加 `import { createSignalMetricsRouter } from './signalMetricsRouter.js';`（文件顶）并 `app.use(createSignalMetricsRouter());`（与生产同源，规避 syncMetricsRouter 未挂载的坑）。
- [ ] **Step 3**：重跑 → 绿；并跑 `node` 冒烟确认 `createRoutes` 仍加载（仿 S6）。提交：`src/http/signalMetricsRouter.js src/http/routes.js test/http/signalMetrics.test.js`。

### T20-5：signal-center.html 上墙面板（指标卡 + 负向告警 + 降级列表）

- [ ] **Step 1（红）**：无独立单测（前端）；以「页面含 `#signal-metrics` 区块且 `load()` 拉 `/api/monitor/signal-link` 并渲染」为契约，由 `test/http/signalMetrics.test.js` 已锁后端；前端改动走人工 review。
- [ ] **Step 2（绿）**：`src/web/signal-center.html`：
  - `<head>` 样式加 `.sc-metrics`（卡片网格）、`.sc-alert`（红框）、`.sc-down`（灰框）。
  - `<body>` 在 toolbar 下插入 `<section id="signal-metrics">`：4 张指标卡（投递成功率 / 平均延迟 / 冲突 / 执行量）+ `#neg-alerts`（负向判据列表）+ `#down-list`（降级事件列表）。
  - `<script>` 加 `async function loadMetrics()`：拉 `/api/monitor/signal-link`，渲染 `metrics.delivery_success_rate`（null→「无投递」）、`avg_latency_ms`（null→「—」）、`conflict`、`execution_volume`；遍历 `negative_predicates` 渲染红框报警（含 channel / type）；遍历 `downgrades.paused_grants` 渲染降级行（title / reason / paused_at）。
  - `load()` 末尾调 `loadMetrics()`；`refresh` 按钮同时触发两者。
- [ ] **Step 3**：人工 review 通过；提交：`src/web/signal-center.html`（本任务单独 commit，不混后端）。

### T20-6：定时器 signal-observability-scan（主动报警，VITEST 护栏）

- [ ] **Step 1（红）**：`src/scheduler/timers.test.js` 当前 `EXPECTED_TIMERS` 为 S6 值（15）；T20 加 1 → 改期望为 16（仿 S6 模式）；`test/scheduler/signalObservabilityScan.test.js`（新建）：直接调 sweep 函数，构造 delivery_silent 场景 → 断言 `createAlert` 被调用（内存 alerts 含 `kind='signal-observability'`）+ `emit('trace',...)` 触发。
- [ ] **Step 2（绿）**：`src/monitor/signalMetrics.js` 追加 `createSignalObservabilitySweep({ getPolicy } = {})`：
  ```js
  import { createAlert } from '../alerts/alertStore.js';
  import { emit } from '../events/bus.js';
  // 扫描全部租户（从 crm.signal 去重 tenant_id），对每个租户跑 detectNegativePredicates；命中则 createAlert + emit trace
  export function createSignalObservabilitySweep() {
    return {
      async sweepOnce() {
        const { rows } = await query(`SELECT DISTINCT tenant_id FROM crm.signal WHERE tenant_id <> 'system'`);
        const since = new Date(Date.now() - 24 * 3600 * 1000);
        for (const { tenant_id } of rows) {
          try {
            const alerts = await detectNegativePredicates({ tenantId: tenant_id, since });
            for (const a of alerts) {
              createAlert({ kind: 'signal-observability', severity: 'high', target_role: 'ops',
                tenant_id, payload: { predicate: a.type, channel: a.channel, fired: a.fired } });
              emit('trace', 'signal-observability-alert', { tenant_id, ...a });
            }
          } catch (e) { emit('trace', 'signal-observability-scan-failed', { tenant_id, error: String(e?.message || e) }); }
        }
      },
    };
  }
  ```
  `src/scheduler/timers.js`：顶加 `import { createSignalObservabilitySweep } from '../monitor/signalMetrics.js';`；注册定时器⑯ `signal-observability-scan`（间隔 3600000ms，VITEST 护栏跳过真扫，仅 `emit trace`）；`EXPECTED_TIMERS` 15→16。
- [ ] **Step 3**：重跑 `test/scheduler/signalObservabilityScan.test.js` + `timers.test.js` → 绿。提交：`src/monitor/signalMetrics.js src/scheduler/timers.js test/scheduler/signalObservabilityScan.test.js test/timers.test.js`。

## 4. 契约验收矩阵（对照 §T20 success）

| 判据 | 落点 | 验证 |
| --- | --- | --- |
| 指标按 tenant_id 隔离返回 | `getSignalMetrics` 全查询带 `tenant_id`；端点 `resolveMe` 取自身租户 | test/http/signalMetrics.test.js 两租户隔离 |
| 投递成功率/延迟/冲突/执行量 | T20-1 | signalMetrics.test.js 真库断言 |
| 负向判据 delivery_silent（无投递行但渠道为 on） | T20-2 判据 A | signalMetrics.test.js + 端点 |
| 负向判据 gen_silent（hits>0 而新增 signal=0） | T20-2 判据 B | signalMetrics.test.js |
| 连续 rejected 自动 paused 并 emit 告警 | **S6 已落地**；T20-3 补查询面使其可追溯 | getDowngradeEvents + grantStore.paused 测试 |
| 降级事件可在追溯链中查到 | T20-3 `getDowngradeEvents`（paused_at/paused_reason）+ T20-4 端点 + T20-5 上墙 | signal-center.html 渲染 |

## 5. 红线

- **零 DELETE**：本计划只增列 + 状态变更（pauseGrant 补 paused_at）+ 只读聚合；任何 DELETE 一律拒绝。
- **防假绿**：`delivery_success_rate` 无投递尝试时返回 `null`，前端显「无投递」，不得显示 100%。
- **租户隔离**：所有查询带 `tenant_id`；端点用 `resolveMe` 取自身租户，禁止 `x-tenant-id` 头（S6 已踩坑）。
- **不重造自动降级**：T20 不修改 S6 的 `pauseGrant` 触发逻辑，只补列 + 查询面 + 上墙。
- **VITEST 护栏**：定时器⑯ 在测试环境跳过真扫（仿 S6 grant-sweep）。
- 每 Task 一 commit；AI 无 git 凭证，提交命令按功能线显式 `add`（禁 `git add -A`）。
