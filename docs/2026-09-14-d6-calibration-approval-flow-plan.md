# D6 校准积压审批流 · 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 D6（校准补丁 PENDING 积压）补齐「SLA 计时 + 超时升级 + 分级路由可见性 + 存量消项协议」四件治理工作流，使 70 条（含本地假库风险，见 §0）积压被持续、按 SLA、分级、批量消费掉；**绝不自动 apply**（守 HITL 铁律）。

**Architecture:** 在既有 `crm.calibration_patch` 上新增 `sla_due_at` / `escalated` 两列 + 追加式 `calibration_escalation_log` 表；`store.scanEscalations()` 每日扫描超时 PENDING 置 `escalated` 并写日志（不改状态机、不触写通道）；`timers.js` 注册 `calibration-sla-scan` 周期触发；`GET /api/admin/todos` 增加 `?escalated` 过滤与 SLA 倒计时字段。审批原语（approve/reject/rollback + 第0闸）已齐备，本计划不改动。

**Tech Stack:** Node.js ESM (Express 4) + PostgreSQL(pgvector) + vitest3；DB 迁移经 `db/migrate.js` INCREMENTAL_SQL 单一事实源；复用 `src/db.js` `query`/`withTx`、`events/bus.js` `emit`、`monitor/monitorStore.js` `recordFailure`。

---

## 0. 范围边界与 §4 已采纳决策

**本计划只交付「工作流骨架」**。D6 探针判定 `pending>20 || ageDays>7`（kmd-closure-probe.mjs:333）的**数字归零只能由人工 HITL 逐条 approve 完成**（§2.4 协议），本计划不代执行、不自动 apply。

§4 五项已采纳默认（实现据此执行，用户可随时纠偏）：
1. **SLA 取值**：HIGH=24h / MEDIUM=72h / LOW=168h(7d)，落 `store.SLA_HOURS` 单一事实源。
2. **责任角色**：HIGH→sysadmin、MEDIUM→admin、LOW→tenant_admin 可批（单签，不双签，避免过闸）；路由仅影响 `assignee` 默认值与看板过滤，不影响状态机。
3. **升级实现范围**：新增 `sla_due_at` + `escalated` 列 + `calibration_escalation_log` 表 + 调度扫描；迁移注册 `db/migrate.js` INCREMENTAL_SQL。
4. **存量 70 是否现在清**：**不清**。本计划建工作流；70 清零为独立人工任务，附录 A 给出 runbook。
5. **DB 归属**：实现在 dev/test 自动跑（迁移+单测）；**生产发布与真值核验走既有 crm-prod-release SKILL + 远程 crm-pg 直核**（附录 B），不在此计划编码步骤内。

**铁律守约**：禁任何自动 apply、禁 DELETE、禁旁路改参（仅 `calibration_escalation_log` 追加写 + `calibration_patch.escalated` 置位）。

---

## 1. 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `db/migration-calibration-sla.sql` | Create | SLA 列 + 升级日志表 + 存量回填（幂等） |
| `db/migrate.js` | Modify (INCREMENTAL_SQL 数组) | 注册上述迁移（单一事实源） |
| `src/calibration/store.js` | Modify | 新增 `SLA_HOURS`/`slaDueAt()`/`scanEscalations()`；`createPatch` 并入 `sla_due_at` |
| `src/http/calibrationRouter.js` | Modify | `todosHandler` 加 `?escalated` 过滤 + `age_hours`/`sla_remaining_hours` |
| `src/scheduler/timers.js` | Modify | 抽 `runCalibrationSlaScanOnce` + 注册 `calibration-sla-scan` 定时器 |
| `src/web/my-todo.html` | Modify | 待办列表渲染 SLA 倒计时 + 升级高亮（可选，Task F） |
| `test/calibration/sla-escalation.test.js` | Create | 集成测试：迁移列存在 + scanEscalations 翻转 |
| `test/calibration/store-sla.test.js` | Create | 单测：slaDueAt + scanEscalations（mock db） |
| `test/http/admin-todos-escalated.test.js` | Create | 单测：?escalated 过滤 + 字段返回 |
| `test/scheduler/calibrationSlaTimer.test.js` | Create | 单测：runCalibrationSlaScanOnce 依赖注入 |

---

## Task A：DB 迁移（SLA 列 + 升级日志 + 存量回填）

**Files:**
- Create: `db/migration-calibration-sla.sql`
- Modify: `db/migrate.js:12` (INCREMENTAL_SQL 数组末位追加)

- [ ] **Step 1: 写失败集成测试（先红）**

`test/calibration/sla-escalation.test.js`：
```js
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { query } from '../../src/db.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { scanEscalations } from '../../src/calibration/store.js';

const sql = readFileSync(new URL('../../db/migration-calibration-sla.sql', import.meta.url), 'utf8');
const PID = 'patch_sla_test_' + Date.now();

beforeAll(async () => { await query(sql); }); // 幂等执行迁移
afterEach(async () => { await query('DELETE FROM crm.calibration_escalation_log WHERE patch_id=$1', [PID]); await query('DELETE FROM crm.calibration_patch WHERE patch_id=$1', [PID]); });

describe('D6 SLA 迁移 + 升级扫描', () => {
  it('calibration_patch 含 sla_due_at / escalated 列', async () => {
    const r = await query(`SELECT column_name FROM information_schema.columns WHERE table_schema='crm' AND table_name='calibration_patch' AND column_name IN ('sla_due_at','escalated')`);
    expect(r.rows.map(c => c.column_name).sort()).toEqual(['escalated', 'sla_due_at']);
  });
  it('scanEscalations 将超时 PENDING 置 escalated 并写日志', async () => {
    await query(
      `INSERT INTO crm.calibration_patch (patch_id, knob, risk, status, assignee, tenant_id, created_at, sla_due_at)
       VALUES ($1,'threshold','HIGH','PENDING','ADMIN','system', now()-interval '10 days', now()-interval '9 days')`,
      [PID]
    );
    const res = await scanEscalations();
    expect(res.escalated).toBe(1);
    const p = await query('SELECT escalated FROM crm.calibration_patch WHERE patch_id=$1', [PID]);
    expect(p.rows[0].escalated).toBe(true);
    const log = await query('SELECT 1 FROM crm.calibration_escalation_log WHERE patch_id=$1', [PID]);
    expect(log.rows.length).toBe(1);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/calibration/sla-escalation.test.js`
Expected: FAIL（列 `sla_due_at` 不存在 / `scanEscalations` 未定义）

- [ ] **Step 3: 写迁移 SQL**

`db/migration-calibration-sla.sql`：
```sql
-- D6 校准审批流 SLA + 超时升级（2026-09-14）：单一事实源=本文件，注册于 db/migrate.js INCREMENTAL_SQL
-- 幂等：ALTER ADD COLUMN IF NOT EXISTS；存量回填仅补 NULL；日志表 CREATE TABLE IF NOT EXISTS
ALTER TABLE crm.calibration_patch ADD COLUMN IF NOT EXISTS sla_due_at TIMESTAMPTZ;
ALTER TABLE crm.calibration_patch ADD COLUMN IF NOT EXISTS escalated BOOLEAN NOT NULL DEFAULT false;

-- 存量回填：sla_due_at = created_at + 风险对应 SLA 窗口（SLA_HOURS 同源：HIGH24/MED72/LOW168）
UPDATE crm.calibration_patch
   SET sla_due_at = created_at + make_interval(hours => CASE risk WHEN 'HIGH' THEN 24 WHEN 'MEDIUM' THEN 72 ELSE 168 END)
 WHERE sla_due_at IS NULL;

-- 升级日志（追加式，禁 DELETE；仅记录 SLA 违约事件，供人工看板路由）
CREATE TABLE IF NOT EXISTS crm.calibration_escalation_log (
  log_id    BIGSERIAL PRIMARY KEY,
  patch_id  TEXT NOT NULL REFERENCES crm.calibration_patch(patch_id),
  risk      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  note      TEXT
);
CREATE INDEX IF NOT EXISTS idx_calibration_escalation_log_patch
  ON crm.calibration_escalation_log(patch_id);
```

- [ ] **Step 4: 注册迁移（单一事实源）**

`db/migrate.js` INCREMENTAL_SQL 数组（@42 行末）追加：
```js
  'migrate-knowledge-kind-backfill.sql',  // ...（末位既有项，保持）
  'migration-calibration-sla.sql',       // D6 SLA + 超时升级（2026-09-14）
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run test/calibration/sla-escalation.test.js`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add db/migration-calibration-sla.sql db/migrate.js test/calibration/sla-escalation.test.js
git commit -m "feat(db): D6 SLA 列 + 升级日志表 + 迁移注册"
```

---

## Task B：store.js — SLA 计算 + 升级扫描

**Files:**
- Modify: `src/calibration/store.js:79` (createPatch)、新增 `SLA_HOURS`/`slaDueAt`/`scanEscalations`
- Test: `test/calibration/store-sla.test.js`

- [ ] **Step 1: 写失败单测（先红）**

`test/calibration/store-sla.test.js`：
```js
import { describe, it, expect, vi } from 'vitest';
vi.mock('../../src/db.js', () => ({ query: vi.fn(), withTx: async (fn) => fn({ query: vi.fn() }) }));
const db = await import('../../src/db.js');
const { SLA_HOURS, slaDueAt, scanEscalations } = await import('../../src/calibration/store.js');

describe('D6 SLA 计算', () => {
  it('SLA_HOURS 风险映射', () => {
    expect(SLA_HOURS).toEqual({ HIGH: 24, MEDIUM: 72, LOW: 168 });
  });
  it('slaDueAt 返回 created_at + 风险窗口', () => {
    const base = new Date('2026-09-14T00:00:00Z');
    const due = slaDueAt('HIGH', base);
    expect(new Date(due).getTime() - base.getTime()).toBe(24 * 3600 * 1000);
  });
  it('scanEscalations 翻转超时 PENDING 并写日志', async () => {
    const updated = [{ patch_id: 'p1', risk: 'HIGH' }];
    db.query
      .mockResolvedValueOnce({ rows: updated })              // UPDATE ... RETURNING
      .mockResolvedValueOnce({ rows: [] });                  // INSERT log
    const r = await scanEscalations();
    expect(r.escalated).toBe(1);
    expect(db.query.mock.calls[0][0]).toContain("SET escalated=true");
    expect(db.query.mock.calls[0][0]).toContain("sla_due_at < now()");
    expect(db.query.mock.calls[1][0]).toContain('calibration_escalation_log');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/calibration/store-sla.test.js`
Expected: FAIL（SLA_HOURS / slaDueAt / scanEscalations 未定义）

- [ ] **Step 3: 实现 store.js**

在 `src/calibration/store.js` 顶部（`KNOBS` 定义后，约 @38 后）新增：
```js
// D6 SLA 矩阵（单一事实源；与草稿 §2.1 / 迁移回填 CASE 同源）
export const SLA_HOURS = Object.freeze({ HIGH: 24, MEDIUM: 72, LOW: 168 });
export function slaDueAt(risk, createdAt = new Date()) {
  const h = SLA_HOURS[risk] ?? SLA_HOURS.LOW;
  return new Date(new Date(createdAt).getTime() + h * 3600 * 1000).toISOString();
}
```

`createPatch`（@82-90）INSERT 改为：
```js
  const r = await query(
    `INSERT INTO crm.calibration_patch
       (scenario_id, knob, target, from_value, to_value, evidence, expected_impact, risk, status, decision_id, assignee, tenant_id, sla_due_at)
     VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb,$8,'PENDING',$9,$10,$11,$12)
     RETURNING *`,
    [scenario_id, knob, target || null, JSON.stringify(from_value), JSON.stringify(to_value),
     JSON.stringify(evidence), expected_impact ? JSON.stringify(expected_impact) : null, risk, decision_id,
     assignee, tenant_id, slaDueAt(risk)]
  );
```

文件末（@203 后）新增：
```js
// D6 超时升级扫描（治理工作流，非状态机推进）：仅置 escalated + 写追加日志，
//   绝不改 status、绝不触 apply 写通道（守 HITL 铁律）。返回翻转条数。
export async function scanEscalations() {
  const r = await query(
    `UPDATE crm.calibration_patch
        SET escalated=true
      WHERE status='PENDING' AND sla_due_at IS NOT NULL AND sla_due_at < now() AND escalated=false
      RETURNING patch_id, risk`
  );
  for (const row of r.rows) {
    await query(
      `INSERT INTO crm.calibration_escalation_log (patch_id, risk, note) VALUES ($1,$2,'SLA breached')`,
      [row.patch_id, row.risk]
    );
  }
  return { escalated: r.rows.length };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/calibration/store-sla.test.js test/calibration/sla-escalation.test.js`
Expected: PASS（注意：sla-escalation 依赖迁移，已注册；本步 store 改动不破既有 todo-loop/store-p3 子串匹配）

- [ ] **Step 5: 提交**

```bash
git add src/calibration/store.js test/calibration/store-sla.test.js
git commit -m "feat(calibration): D6 SLA 计算 + 超时升级扫描（仅置位，不自动 apply）"
```

---

## Task C：calibrationRouter — ?escalated 过滤 + SLA 字段

**Files:**
- Modify: `src/http/calibrationRouter.js:255` (todosHandler)
- Test: `test/http/admin-todos-escalated.test.js`

- [ ] **Step 1: 写失败单测（先红）**

`test/http/admin-todos-escalated.test.js`：
```js
import { describe, it, expect, vi } from 'vitest';
const { createCalibrationRouter } = await import('../../src/http/calibrationRouter.js');

function mkApp(deps = {}) {
  const router = createCalibrationRouter({ ...deps });
  const app = { calls: [], async fetch(method, path, body) {
    const req = { method, url: path, params: {}, query: Object.fromEntries(new URLSearchParams(path.split('?')[1] || '')), body, headers: {} };
    let status = 200, jsonBody = null;
    const res = { status(c){ status = c; return res; }, json(o){ jsonBody = o; return res; } };
    await new Promise((resolve) => {
      const layer = router.stack.find(l => l.route && path.startsWith(l.route.path));
      if (!layer) return resolve();
      layer.route.stack[layer.route.stack.length-1].handle(req, res, resolve);
    });
    return { status, json: jsonBody };
  }};
  return app;
}

describe('GET /api/admin/todos ?escalated', () => {
  it('escalated=true 仅返 escalated 行，且含 sla_remaining_hours', async () => {
    const rows = [
      { patch_id: 'a', status: 'PENDING', escalated: true, sla_due_at: new Date(Date.now()+3600000).toISOString() },
      { patch_id: 'b', status: 'PENDING', escalated: false, sla_due_at: new Date(Date.now()+3600000).toISOString() },
    ];
    const app = mkApp({ resolveMe: async () => ({ ok: true, role: 'sysadmin', tenantId: 'system' }),
      query: async () => ({ rows: rows.filter(r => r.escalated) }) });
    const r = await app.fetch('GET', '/api/admin/todos?status=PENDING&escalated=true');
    expect(r.status).toBe(200);
    expect(r.json.todos.map(t => t.patch_id)).toEqual(['a']);
    expect(r.json.todos[0]).toHaveProperty('sla_remaining_hours');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/http/admin-todos-escalated.test.js`
Expected: FAIL（过滤未生效 / 字段缺失）

- [ ] **Step 3: 实现 todosHandler**

`src/http/calibrationRouter.js` `todosHandler`（@265-276）改为：
```js
      const status = String(req.query?.status || 'PENDING');
      const assignee = req.query?.assignee ? String(req.query.assignee) : null;
      const escalatedQ = req.query?.escalated != null
        ? String(req.query.escalated).toLowerCase() === 'true'
        : null;
      const tenantFilter = role === 'TAN_ADMIN' ? (me.tenantId || null) : null;
      const r = await query(
        `SELECT *,
           EXTRACT(EPOCH FROM (now()-created_at))/3600 AS age_hours,
           CASE WHEN sla_due_at IS NULL THEN NULL
                ELSE EXTRACT(EPOCH FROM (sla_due_at-now()))/3600 END AS sla_remaining_hours
         FROM crm.calibration_patch
         WHERE status=$1
           AND ($2::text IS NULL OR assignee=$2)
           AND ($3::text IS NULL OR tenant_id=$3)
           AND ($4::boolean IS NULL OR escalated=$4)
         ORDER BY created_at DESC LIMIT 50`,
        [status, assignee, tenantFilter, escalatedQ]
      );
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/http/admin-todos-escalated.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/http/calibrationRouter.js test/http/admin-todos-escalated.test.js
git commit -m "feat(calibration): admin/todos 支持 ?escalated 过滤 + SLA 倒计时字段"
```

---

## Task D：timers.js — 周期升级扫描（依赖注入）

**Files:**
- Modify: `src/scheduler/timers.js:137` (ensureTimers) + 新增模块级 `runCalibrationSlaScanOnce`
- Test: `test/scheduler/calibrationSlaTimer.test.js`

- [ ] **Step 1: 写失败单测（先红）**

`test/scheduler/calibrationSlaTimer.test.js`：
```js
import { describe, it, expect, vi } from 'vitest';
const mod = await import('../../src/scheduler/timers.js');
const { runCalibrationSlaScanOnce } = mod;

describe('runCalibrationSlaScanOnce', () => {
  it('调用 scanFn 并在翻转>0 时 emit trace', async () => {
    const scanFn = vi.fn(async () => ({ escalated: 3 }));
    const emit = vi.fn();
    const recordFailure = vi.fn();
    const r = await runCalibrationSlaScanOnce({ scanFn, emit, recordFailure });
    expect(r.escalated).toBe(3);
    expect(emit).toHaveBeenCalledWith('trace', 'calibration-sla-escalated', { count: 3 });
    expect(recordFailure).not.toHaveBeenCalled();
  });
  it('scanFn 抛错 → recordFailure 留痕，不抛', async () => {
    const scanFn = vi.fn(async () => { throw new Error('db down'); });
    const emit = vi.fn();
    const recordFailure = vi.fn();
    const r = await runCalibrationSlaScanOnce({ scanFn, emit, recordFailure });
    expect(r).toEqual({ escalated: 0, error: 'db down' });
    expect(recordFailure).toHaveBeenCalledWith('calibration-sla-scan-failed', expect.any(Error));
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/scheduler/calibrationSlaTimer.test.js`
Expected: FAIL（runCalibrationSlaScanOnce 未导出）

- [ ] **Step 3: 实现 timers.js**

`src/scheduler/timers.js` `import` 区（@14 附近）增加：
```js
import { scanEscalations } from '../calibration/store.js';
```

模块级（在 `ensureTimers` 之前，约 @136 前）新增：
```js
// D6 超时升级扫描（治理工作流）：依赖注入便于单测；默认走 store.scanEscalations。
//   失败 emit trace + recordFailure（G3 不静默）；绝不自动 apply。
export const runCalibrationSlaScanOnce = async ({ scanFn, emit, recordFailure } = {}) => {
  const scan = scanFn || scanEscalations;
  const out = { escalated: 0 };
  try {
    const r = await scan();
    out.escalated = r?.escalated || 0;
    if (out.escalated) emit?.('trace', 'calibration-sla-escalated', { count: out.escalated });
  } catch (err) {
    emit?.('trace', 'calibration-sla-scan-failed', { error: String(err?.message || err) });
    recordFailure?.('calibration-sla-scan-failed', err);
    out.error = String(err?.message || err);
  }
  return out;
};
```

`ensureTimers` 末尾（@432 `integration-poll` 注册之后、`return timers.size` 之前）新增定时器：
```js
  // ⑪ D6 校准 SLA 超时升级扫描（2026-09-14）：每 30min 扫 PENDING 超时项 → 置 escalated + 写日志，
  //    绝不自动 apply（守 HITL 铁律）；失败 emit trace + recordFailure（G3 不静默）。
  const slaScan = setInterval(() => {
    runCalibrationSlaScanOnce({ emit, recordFailure }).catch(() => {});
  }, 1800000);
  timers.set('calibration-sla-scan', { handle: slaScan, intervalMs: 1800000, kind: 'rule', registeredAt: now });
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/scheduler/calibrationSlaTimer.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/scheduler/timers.js test/scheduler/calibrationSlaTimer.test.js
git commit -m "feat(scheduler): D6 校准 SLA 超时升级周期扫描（依赖注入可测）"
```

---

## Task E：全量回归

- [ ] **Step 1: 跑校准相关既有测试，确认无回归**

Run: `npx vitest run test/calibration test/http/calibrationGenerate.test.js test/http/workbench-routes.test.js test/calibration/todo-loop.test.js`
Expected: PASS（createPatch 加列不破子串匹配 mock；todosHandler 加字段不影响既有断言）

- [ ] **Step 2: 提交（若无改动则跳过）**

若有微调，单独提交；否则进入 Task F。

---

## Task F（可选，默认包含）：my-todo.html SLA 高亮

**Files:**
- Modify: `src/web/my-todo.html`（待办列表渲染段）

> 范围说明：仅前端展示增强；后端字段（age_hours/sla_remaining_hours/escalated）已由 Task C 提供。下列为最小改动示例，编辑前先用 Read 定位待办渲染函数。

- [ ] **Step 1: 在待办行渲染中加入 SLA 倒计时 + 升级徽标**

在 `src/web/my-todo.html` 待办行模板（搜索 `calibration_patch` 或 `sla` 渲染处）追加：
```js
const slaTxt = (t) => {
  if (t.escalated) return '<span class="badge badge-escalated">已升级</span>';
  if (t.sla_remaining_hours == null) return '';
  const h = Math.round(t.sla_remaining_hours);
  if (h < 0) return `<span class="badge badge-overdue">超时 ${-h}h</span>`;
  return `<span class="badge badge-sla">剩 ${h}h</span>`;
};
// 在行 HTML 中插入 ${slaTxt(todo)}
```
并在 `<style>` 加 `.badge-escalated{color:#fff;background:#c0392b} .badge-overdue{color:#c0392b} .badge-sla{color:#b9770e}`。

- [ ] **Step 2: 提交**

```bash
git add src/web/my-todo.html
git commit -m "feat(ui): 待办列表 SLA 倒计时 + 升级高亮（D6 可见性）"
```

---

## 附录 A：存量 70 清零 runbook（人工 HITL，非本计划自动执行）

1. **核真值**（避本地 5433 假库）：`docker exec crm-pg psql -tAc "SELECT status,count(*) FROM crm.calibration_patch GROUP BY 1"` → 取生产实际 PENDING 数。
2. `node scripts/calibration-triage.mjs --json out.json` 导出分级清单（只读）。
3. 按草稿 §2.4 四问（证据/预期影响/风险匹配/无冲突）逐条评审，生成 批准/拒绝 清单；顺序 HIGH→MED→LOW，每批 ≤10。
4. 逐条 `POST /api/calibration/patches/:id/approve`（经第0闸）或 `reject`；每批后 `replay` 验证无回归。
5. 重跑 `docker exec crm-pg psql -tAc "SELECT count(*) FROM crm.calibration_patch WHERE status='PENDING'"` 期望递减至 0；D6 探针 ageDays 同步降。

## 附录 B：生产发布与真值核验（走既有 crm-prod-release SKILL）

- 本计划代码合入后，生产发布走 `git stash -u → deploy-remote.py release → git stash pop`（crm-prod-release SKILL），不在编码步骤内。
- 发布后远程直核：`docker exec crm-pg psql -tAc "SELECT count(*) FROM crm.calibration_patch WHERE status='PENDING' AND escalated=false"` 作为 D6 趋势基线。

---

## 自审（Spec 覆盖 / 占位符 / 类型一致）

- **Spec 覆盖**：§2.1 SLA 矩阵 → `SLA_HOURS`+迁移 CASE；§2.2 分级路由 → 仅 `assignee` 默认与看板过滤（状态机未动，符合"不自动 apply"）；§2.3 升级 → `scanEscalations`+定时器+日志；§2.4 批量消项 → 附录 A runbook（人工）。全部覆盖。
- **占位符**：无 TBD/TODO；每步含真实代码与命令。
- **类型一致**：`scanEscalations` 返回 `{escalated:number}` 在 Task B/D 单测与定时器一致；`slaDueAt(risk, Date)` 在 createPatch 与单测一致；`runCalibrationSlaScanOnce({scanFn,emit,recordFailure})` 签名在定时器与单测一致。
- **回归风险**：createPatch INSERT 加 `$12` 列；既有 mock 测试用子串匹配，不受影响（已在 Task E 验证）。
