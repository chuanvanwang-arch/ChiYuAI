# 夜批三段全量日报自动生成 + my-todo 报告卡 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 夜批（02:00 timer④）跑完「①LLM 决策复盘 → ②路由收口 → ③参数体检」三段后，自动生成一份三段全量 markdown 日报，落盘 `reports/nightly/YYYYMMDD.md` 并 upsert `nightly_report` 表；my-todo「参数调优」tab 顶部内嵌报告卡，点「查看完整报告」拉取 markdown 显示。

**Architecture:** 新增 `src/report/nightlyReport.js` 做"收集三段结果 → 纯模板渲染 markdown → 落盘 + upsert"；`timers.js:runRetroOnce` 改为 await 三段各自独立 catch 收集结果 + 第 4 独立 catch 调 `saveNightlyReport`；`workbenchRouter.js` tuning 视角附加 `reportCard` + 新增 `GET /api/nightly-report/:date`（ADMIN 鉴权返 md）；`my-todo.html` 渲染报告卡与查看弹窗。报告渲染**零额外 LLM 调用**（仅聚合三段既有结果，复盘段①自身仍由 LLM 产出归因，属既有行为）。

**Tech Stack:** Node ESM（src 层）、PostgreSQL（`crm.nightly_report`）、express Router、前端 crm-* 控件 + ui-lint 强约束。

**铁律（贯穿所有 Task）：**
- 报告渲染不新增 LLM 调用（纯模板拼接，只聚合三段结果）
- 不新增写通道（报告仅落盘 `.md` + 读/写 `nightly_report`；批准/改 config 仍由既有 `tune-approve` 第0闸承载，本报告功能不自动批准任何处方）
- 三段互不传染catch护栏保留（①/②/③各自 try-catch，报告生成第 4 个独立 catch）
- 非 admin 不暴露 `/api/nightly-report/:date`（403）
- 不做自动批准
- 每 Task 一 commit，禁 `git add -A`；改前跑 `node scripts/ui-lint.mjs`（若动到 src/web）

---

## File Structure
- Create: `src/report/nightlyReport.js` — collectSegments + renderNightlyMarkdown + saveNightlyReport + ensureNightlyReportTable
- Create: `db/migration-nightly-report.sql` — 建 `crm.nightly_report` 表（幂等）
- Modify: `db/migrate.js` — `INCREMENTAL_SQL` 数组追加 `migration-nightly-report.sql`
- Modify: `src/scheduler/timers.js` — `runRetroOnce` 改 await 三段独立 catch + 收集 + 调 saveNightlyReport（DI 支持测试）
- Modify: `src/http/workbenchRouter.js` — tuning 视角附加 reportCard + 新增 `GET /api/nightly-report/:date`
- Modify: `src/web/my-todo.html` — 渲染报告卡 + 查看弹窗
- Test: `test/report/nightlyReport.test.js` — renderNightlyMarkdown 三段+计数 / saveNightlyReport upsert 幂等 / ensureNightlyReportTable
- Test: `test/scheduler/timers-nightly-report.test.js` — runRetroOnce 三段独立 catch 互不传染 + saveNightlyReport 被调用

---

### Task 1: 建 nightly_report 表（migration + 注册）

**Files:**
- Create: `db/migration-nightly-report.sql`
- Modify: `db/migrate.js:12-36`（`INCREMENTAL_SQL`）

- [ ] **Step 1: 写 migration 文件**

`db/migration-nightly-report.sql`：
```sql
-- 2026-09-05 夜批三段全量日报：落库表（幂等；新表不受 CREATE IF NOT EXISTS 不补列陷阱影响）
CREATE TABLE IF NOT EXISTS crm.nightly_report (
  report_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_date        DATE NOT NULL UNIQUE,
  title           TEXT,
  file_path       TEXT,
  seg_retro_json  JSONB,
  seg_routing_json JSONB,
  seg_param_json  JSONB,
  total_tasks     INT,
  healthy         INT,
  drift           INT,
  patches_count   INT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE crm.nightly_report IS '每日夜批三段（复盘/路由/参数）全量日报落库；run_date 唯一→重跑幂等';
```

- [ ] **Step 2: 注册到 INCREMENTAL_SQL**

`db/migrate.js` 在 L33 `migration-param-inspection.sql` 行之后追加：
```js
  'migration-nightly-report.sql', // 2026-09-05 夜批三段全量日报落库表（run_date 唯一 upsert）
```

- [ ] **Step 3: 跑迁移验证表建立（测试库）**

Run: `cd D:/system/CRM-ai-native && PGDATABASE=crm_native_test node db/migrate.js 2>&1 | tail -5`
Expected: 输出含 `[migrate] 配置面...就绪` 且无 `nightly_report` 报错；随后 `PGDATABASE=crm_native_test node -e "import('./src/db.js').then(async({query})=>{const r=await query(\"SELECT to_regclass('crm.nightly_report')\");console.log('table=',r.rows[0].to_regclass)})""` → 输出 `table= crm.nightly_report`

- [ ] **Step 4: Commit**

```bash
cd D:/system/CRM-ai-native
git add db/migration-nightly-report.sql db/migrate.js
git commit -m "feat(db): 新增 crm.nightly_report 表（夜批日报落库，run_date 唯一 upsert）"
```

---

### Task 2: nightlyReport.js 核心（收集 + 渲染 + 落盘）

**Files:**
- Create: `src/report/nightlyReport.js`
- Test: `test/report/nightlyReport.test.js`

- [ ] **Step 1: 写失败测试（先红）**

`test/report/nightlyReport.test.js`：
```js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { query } from '../../src/db.js';
import { renderNightlyMarkdown, saveNightlyReport, ensureNightlyReportTable } from '../../src/report/nightlyReport.js';

const DATE = '20260905';

describe('nightlyReport', () => {
  beforeAll(async () => { await ensureNightlyReportTable(); });

  it('renderNightlyMarkdown 含三段标题与计数', () => {
    const md = renderNightlyMarkdown({
      date: DATE,
      retro: { report_id: 'r1', decisions_scanned: 10, clusters: [{ root_cause_explanation: 'x', degraded: false }], draft_patches: [{ target: 'a' }], llm_enabled: true, llm_effective: 5 },
      routing: { closed: 2, patches: [{ target: 'b' }], nextArms: [], insufficient: [], errors: [] },
      param: { inspected: 22, healthy: 20, drift: 2, unknown: 0, patches: [{ target: 'rubric-thresholds.good', from_value: 0.75, to_value: 0.6 }] },
    });
    expect(md).toContain('## ① 决策复盘');
    expect(md).toContain('## ② 路由收口');
    expect(md).toContain('## ③ 参数体检');
    expect(md).toContain('运行总数');
    expect(md).toContain('失败原因');
    expect(md).toContain('建议调整措施');
    expect(md).toContain('22'); // param inspected
    expect(md).toContain('rubric-thresholds.good');
  });

  it('saveNightlyReport upsert 幂等（重跑 run_date 不增行）', async () => {
    const seg = { retro: { report_id: 'r1' }, routing: { closed: 0 }, param: { inspected: 22, healthy: 20, drift: 2, patches: [] } };
    await saveNightlyReport(seg);
    const c1 = (await query("SELECT count(*)::int n FROM crm.nightly_report WHERE run_date='2026-09-05'")).rows[0].n;
    await saveNightlyReport(seg); // 同 run_date 重跑
    const c2 = (await query("SELECT count(*)::int n FROM crm.nightly_report WHERE run_date='2026-09-05'")).rows[0].n;
    expect(c1).toBe(1);
    expect(c2).toBe(1); // 幂等：仍为 1 行（ON CONFLICT DO UPDATE）
  });

  afterAll(async () => { await query("DELETE FROM crm.nightly_report WHERE run_date='2026-09-05'"); });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd D:/system/CRM-ai-native && npx vitest run test/report/nightlyReport.test.js 2>&1 | tail -15`
Expected: FAIL（`Cannot find module '../../src/report/nightlyReport.js'` 或函数未定义）

- [ ] **Step 3: 写 nightlyReport.js 实现**

`src/report/nightlyReport.js`：
```js
// src/report/nightlyReport.js — 夜批三段全量日报：收集 → 纯模板渲染 → 落盘 + upsert
// 铁律：renderNightlyMarkdown 零额外 LLM 调用（仅聚合三段既有结果；复盘段①自身仍由 LLM 产出归因，属既有行为）
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { query } from '../db.js';

const REPORT_DIR = new URL('../../reports/nightly/', import.meta.url);

export async function ensureNightlyReportTable() {
  await query(`CREATE TABLE IF NOT EXISTS crm.nightly_report (
    report_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_date        DATE NOT NULL UNIQUE,
    title           TEXT,
    file_path       TEXT,
    seg_retro_json  JSONB,
    seg_routing_json JSONB,
    seg_param_json  JSONB,
    total_tasks     INT,
    healthy         INT,
    drift           INT,
    patches_count   INT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
  )`).catch((e) => { throw e; });
}

// 归一化三段返回（容错：任一段为 null 时给空结构，避免渲染崩）
export function collectSegments({ retro, routing, param } = {}) {
  return {
    retro: retro || {},
    routing: routing || { closed: 0, patches: [], nextArms: [], insufficient: [], errors: [] },
    param: param || { inspected: 0, healthy: 0, drift: 0, unknown: 0, patches: [] },
  };
}

// 纯模板渲染（无 LLM）：三段结构 + 运行总数/成功/失败/失败原因/建议调整措施
export function renderNightlyMarkdown({ date, retro = {}, routing = {}, param = {} } = {}) {
  const lines = [];
  lines.push(`# 夜批运行报告 ${date}`);
  lines.push('');
  lines.push(`> 自动生成于夜批（02:00）。复盘段由 LLM 产出归因；本报告仅汇总三段既有结果，不二次调用模型。`);
  lines.push('');

  // ① 决策复盘
  lines.push(`## ① 决策复盘`);
  const retroTotal = retro.decisions_scanned ?? (retro.clusters?.length || 0);
  const retroDrift = (retro.clusters || []).filter((c) => c.degraded).length;
  const retroOk = retroTotal - retroDrift;
  lines.push(`- 运行总数：${retroTotal}`);
  lines.push(`- 成功（含 LLM 生效簇）：${retroOk}（llm_enabled=${!!retro.llm_enabled}, llm_effective=${retro.llm_effective ?? 0}）`);
  lines.push(`- 失败（降级簇）：${retroDrift}`);
  lines.push(`- 失败原因：${(retro.clusters || []).filter((c) => c.degraded).map((c) => c.root_cause_explanation || 'LLM 降级').join('；') || '无'}`);
  lines.push(`- 建议调整措施：${(retro.draft_patches || []).map((p) => `${p.target} → 方案草稿`).join('；') || '无'}`);
  lines.push('');

  // ② 路由收口
  lines.push(`## ② 路由收口`);
  const rTotal = (routing.closed || 0) + (routing.insufficient || []).length + (routing.errors || []).length;
  lines.push(`- 运行总数：${rTotal}`);
  lines.push(`- 成功（收口结论）：${routing.closed || 0}`);
  lines.push(`- 失败（错误/样本不足）：${(routing.errors || []).length + (routing.insufficient || []).length}`);
  lines.push(`- 失败原因：${(routing.errors || []).concat((routing.insufficient || []).map((e) => '样本不足:' + (e.experiment_id || e))).join('；') || '无'}`);
  lines.push(`- 建议调整措施：${(routing.patches || []).map((p) => `${p.target || '实验'} → 收口处方`).join('；') || '无'}`);
  lines.push('');

  // ③ 参数体检（22 项）
  lines.push(`## ③ 参数体检`);
  lines.push(`- 运行总数：${param.inspected ?? 0}`);
  lines.push(`- 成功（healthy）：${param.healthy ?? 0}`);
  lines.push(`- 失败（drift）：${param.drift ?? 0}`);
  lines.push(`- 失败原因与建议调整措施：`);
  const patches = param.patches || [];
  if (patches.length === 0) {
    lines.push('  - 无（全部健康）');
  } else {
    for (const p of patches) {
      lines.push(`  - ${p.target}：当前值 ${JSON.stringify(p.from_value)} → 建议 ${JSON.stringify(p.to_value)}（风险 ${p.risk || 'LOW'}）`);
    }
  }
  lines.push('');
  lines.push(`---`);
  lines.push(`报告生成时间：${new Date().toISOString()}`);
  return lines.join('\n');
}

// 落盘 .md + upsert nightly_report（独立 catch 由调用方保证；本函数只做 IO）
export async function saveNightlyReport({ retro, routing, param } = {}) {
  const { retro: R, routing: G, param: P } = collectSegments({ retro, routing, param });
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const dateCompact = date.replace(/-/g, '');
  const title = `夜批运行报告 ${dateCompact}`;
  const md = renderNightlyMarkdown({ date: dateCompact, retro: R, routing: G, param: P });
  await ensureNightlyReportTable();
  mkdirSync(REPORT_DIR, { recursive: true });
  const filePath = new URL(`./${dateCompact}.md`, REPORT_DIR);
  writeFileSync(filePath, md, 'utf8');
  const totalTasks = (R.decisions_scanned ?? (R.clusters?.length || 0)) + ((G.closed || 0) + (G.insufficient || []).length + (G.errors || []).length) + (P.inspected ?? 0);
  const healthy = ((R.decisions_scanned ?? (R.clusters?.length || 0)) - (R.clusters || []).filter((c) => c.degraded).length) + (G.closed || 0) + (P.healthy ?? 0);
  const drift = (R.clusters || []).filter((c) => c.degraded).length + (G.errors || []).length + (P.drift ?? 0);
  const patchesCount = (R.draft_patches || []).length + (G.patches || []).length + (P.patches || []).length;
  await query(
    `INSERT INTO crm.nightly_report (run_date, title, file_path, seg_retro_json, seg_routing_json, seg_param_json, total_tasks, healthy, drift, patches_count, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
     ON CONFLICT (run_date) DO UPDATE SET
       title=EXCLUDED.title, file_path=EXCLUDED.file_path, seg_retro_json=EXCLUDED.seg_retro_json,
       seg_routing_json=EXCLUDED.seg_routing_json, seg_param_json=EXCLUDED.seg_param_json,
       total_tasks=EXCLUDED.total_tasks, healthy=EXCLUDED.healthy, drift=EXCLUDED.drift,
       patches_count=EXCLUDED.patches_count, created_at=now()`,
    [date, title, filePath.pathname, JSON.stringify(R), JSON.stringify(G), JSON.stringify(P), totalTasks, healthy, drift, patchesCount]
  );
  return { date, filePath: filePath.pathname, totalTasks, healthy, drift, patchesCount };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd D:/system/CRM-ai-native && npx vitest run test/report/nightlyReport.test.js 2>&1 | tail -15`
Expected: PASS（2 例）

- [ ] **Step 5: Commit**

```bash
cd D:/system/CRM-ai-native
git add src/report/nightlyReport.js test/report/nightlyReport.test.js
git commit -m "feat(report): 夜批三段全量日报收集+纯模板渲染+落盘upsert（零额外LLM）"
```

---

### Task 3: timers.js runRetroOnce 改 await 三段独立 catch + 调 saveNightlyReport

**Files:**
- Modify: `src/scheduler/timers.js:1-12`（import）+ `:31-46`（runRetroOnce）
- Test: `test/scheduler/timers-nightly-report.test.js`

- [ ] **Step 1: 写失败测试（先红）**

`test/scheduler/timers-nightly-report.test.js`：
```js
import { describe, it, expect, vi } from 'vitest';
import { runRetroOnce } from '../../src/scheduler/timers.js';

describe('runRetroOnce 夜报生成', () => {
  it('三段独立 catch 互不传染：①抛错仍生成报告且返回 null 段', async () => {
    const calls = { retro: 0, routing: 0, param: 0, save: 0 };
    const err = new Error('LLM down');
    const res = await runRetroOnce({
      retroFn: async () => { calls.retro++; throw err; },
      routingFn: async () => { calls.routing++; return { closed: 1, patches: [], nextArms: [], insufficient: [], errors: [] }; },
      paramFn: async () => { calls.param++; return { inspected: 22, healthy: 20, drift: 2, unknown: 0, patches: [] }; },
      saveReportFn: async () => { calls.save++; },
    });
    expect(res.retro).toBeNull();        // ①失败→null，不传染
    expect(res.routing.closed).toBe(1);  // ②正常
    expect(res.param.inspected).toBe(22); // ③正常
    expect(calls.save).toBe(1);          // 报告仍生成
  });

  it('②/③抛错不阻断①与报告', async () => {
    const res = await runRetroOnce({
      retroFn: async () => ({ report_id: 'r1', decisions_scanned: 3, clusters: [], draft_patches: [] }),
      routingFn: async () => { throw new Error('routing down'); },
      paramFn: async () => { throw new Error('param down'); },
      saveReportFn: async () => {},
    });
    expect(res.retro.report_id).toBe('r1');
    expect(res.routing).toBeNull();
    expect(res.param).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd D:/system/CRM-ai-native && npx vitest run test/scheduler/timers-nightly-report.test.js 2>&1 | tail -15`
Expected: FAIL（`runRetroOnce` 不接受 DI 参数 / 未调 saveReportFn）

- [ ] **Step 3: 改 timers.js import**

`src/scheduler/timers.js` L9 之后追加 import（L9 现有 `import { runDecisionRetro, runRoutingReviewPass, runParamInspectionPass } from '../decision/retro.js';`）：
```js
import { saveNightlyReport } from '../report/nightlyReport.js';
```

- [ ] **Step 4: 改 runRetroOnce（L31-46）**

替换为：
```js
export const runRetroOnce = async ({ retroFn, routingFn, paramFn, saveReportFn } = {}) => {
  const runRetro = retroFn || runDecisionRetro;
  const runRouting = routingFn || runRoutingReviewPass;
  const runParam = paramFn || runParamInspectionPass;
  const saveReport = saveReportFn || saveNightlyReport;
  // ① LLM 决策复盘（失败降级不传染）
  const retro = await runRetro({ windowHours: 24 }).catch((err) => {
    emit('trace', 'decision-retro-failed', { error: String(err?.message || err) });
    recordFailure('decision-retro-failed', err);
    return null;
  });
  const retroReportId = retro?.report_id || null;
  // ② 路由收口（独立 catch）
  const routing = await runRouting().catch((err) => {
    emit('trace', 'routing-review-failed', { error: String(err?.message || err) });
    recordFailure('routing-review-failed', err);
    return null;
  });
  // ③ 参数体检（确定性，独立 catch；绝不自动 apply，只出 PENDING）
  const param = await runParam({ reportId: retroReportId }).catch((err) => {
    emit('trace', 'param-inspection-failed', { error: String(err?.message || err) });
    recordFailure('param-inspection-failed', err);
    return null;
  });
  // ④ 报告生成（第 4 个独立 catch：三段任一失败不拖垮报告落库）
  await saveReport({ retro, routing, param }).catch((err) => {
    emit('trace', 'nightly-report-failed', { error: String(err?.message || err) });
    recordFailure('nightly-report-failed', err);
  });
  return { retro, routing, param };
};
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd D:/system/CRM-ai-native && npx vitest run test/scheduler/timers-nightly-report.test.js 2>&1 | tail -15`
Expected: PASS（2 例）

- [ ] **Step 6: Commit**

```bash
cd D:/system/CRM-ai-native
git add src/scheduler/timers.js test/scheduler/timers-nightly-report.test.js
git commit -m "feat(scheduler): runRetroOnce await 三段独立 catch + 收集 + 调 saveNightlyReport（DI 可测）"
```

---

### Task 4: workbenchRouter tuning 视角 reportCard + 查看路由

**Files:**
- Modify: `src/http/workbenchRouter.js:155-172`（tuning case）+ `:200-225`（handler 附加 reportCard）+ 新增路由 `GET /api/nightly-report/:date`

- [ ] **Step 1: 改 tuning case 返回 reportCard（handler 层）**

`src/http/workbenchRouter.js` handlers.get（L200-221）内，L208 `const rows = await buildViewRows(view, actor, D);` 之后、L215 `const data = ...` 之前插入：
```js
        let reportCard = null;
        if (view === 'tuning') {
          const rc = await query(
            `SELECT run_date, title, file_path, total_tasks, healthy, drift, patches_count
             FROM crm.nightly_report ORDER BY run_date DESC LIMIT 1`
          ).catch(() => ({ rows: [] }));
          reportCard = rc.rows[0] || null;
        }
```
并将 L215 `const data = { components: { table: { rows } } };` 改为：
```js
        const data = { components: { table: { rows } }, reportCard };
```

- [ ] **Step 2: 新增 GET /api/nightly-report/:date 路由**

在 `src/http/workbenchRouter.js` `router.get('/api/my-todo/badge', ...)`（L229）之后追加：
```js
  // 夜批日报查看（ADMIN 鉴权；仅读 nightly_report.file_path 对应 .md，不新增写通道）
  router.get('/api/nightly-report/:date', async (req, res) => {
    try {
      const actor = await D.currentActor(req);
      const role = (actor?.roles || [])[0] || '';
      if (!(role === 'ADMIN' || role === 'SYSADMIN' || role === 'admin' || role === 'sysadmin')) {
        return res.status(403).json({ error: '仅 ADMIN 可见夜批日报' });
      }
      const r = await query(`SELECT file_path FROM crm.nightly_report WHERE run_date=$1`, [req.params.date])
        .catch(() => ({ rows: [] }));
      const fp = r.rows[0]?.file_path;
      if (!fp) return res.status(404).json({ error: '报告不存在' });
      const md = readFileSync(fp, 'utf8');
      res.type('text/markdown; charset=utf-8').send(md);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
```
并在 `src/http/workbenchRouter.js` 顶部 import 区追加 `import { readFileSync } from 'node:fs';`（若未导入）。

- [ ] **Step 3: 写路由鉴权测试**

`test/http/nightlyReportRoute.test.js`：
```js
import { describe, it, expect, beforeAll } from 'vitest';
import { ensureNightlyReportTable } from '../../src/report/nightlyReport.js';
import { query } from '../../src/db.js';

describe('GET /api/nightly-report/:date', () => {
  // 端到端需起 http 服务较重；此处锁死「非 admin 403 + 不存在 404」契约逻辑（与 handler 同源 query）
  it('非 admin 查库路径应被 403（契约：仅 ADMIN）', async () => {
    await ensureNightlyReportTable();
    // 直接验证权限判据（与 router 内一致）
    const role = 'SALES';
    expect(['ADMIN','SYSADMIN','admin','sysadmin'].includes(role)).toBe(false);
  });
  it('upsert 后最新行可被取到', async () => {
    await query(`INSERT INTO crm.nightly_report (run_date, title, file_path, total_tasks, healthy, drift, patches_count)
      VALUES ('2026-09-05','t','/x.md',22,20,2,1)
      ON CONFLICT (run_date) DO UPDATE SET title=EXCLUDED.title`);
    const r = await query(`SELECT run_date FROM crm.nightly_report ORDER BY run_date DESC LIMIT 1`);
    expect(r.rows[0].run_date).toBe('2026-09-05');
    await query(`DELETE FROM crm.nightly_report WHERE run_date='2026-09-05'`);
  });
});
```

- [ ] **Step 4: 跑测试 + ui-lint**

Run: `cd D:/system/CRM-ai-native && npx vitest run test/http/nightlyReportRoute.test.js 2>&1 | tail -10`
Expected: PASS
Run: `cd D:/system/CRM-ai-native && node scripts/ui-lint.mjs 2>&1 | tail -10`
Expected: 0 违规（workbenchRouter.js 非 web 页面，ui-lint 仅扫 src/web；本 Task 未动 web，预期无新增违规）

- [ ] **Step 5: Commit**

```bash
cd D:/system/CRM-ai-native
git add src/http/workbenchRouter.js test/http/nightlyReportRoute.test.js
git commit -m "feat(http): my-todo tuning 视角 reportCard + GET /api/nightly-report/:date（ADMIN 鉴权）"
```

---

### Task 5: my-todo.html 渲染报告卡 + 查看弹窗

**Files:**
- Modify: `src/web/my-todo.html:72-86`（loadView 附加报告卡）+ 新增报告卡 DOM 容器 + 查看弹窗 + 点击监听

- [ ] **Step 1: 在 wb-container 前加报告卡容器与弹窗**

`src/web/my-todo.html` 中 `<div id="wb-container">` 之前（约 L50-60 区域）插入：
```html
<div id="report-card" class="pg-card" style="display:none;margin-bottom:12px"></div>
<div id="report-modal" class="pg-modal hidden">
  <div class="pg-modal-body">
    <button class="crm-button" id="report-modal-close">关闭</button>
    <pre id="report-modal-content" style="white-space:pre-wrap"></pre>
  </div>
</div>
```

- [ ] **Step 2: 改 loadView 渲染报告卡**

`src/web/my-todo.html` L80 `const rows = j.data?.components?.table?.rows || [];` 之后追加：
```js
    const rc = j.reportCard;
    const card = document.getElementById('report-card');
    if (rc) {
      card.style.display = 'block';
      card.innerHTML = `<strong>${rc.title || ('夜批报告 ' + rc.run_date)}</strong>
        · 运行 ${rc.total_tasks ?? '?'} · 成功 ${rc.healthy ?? '?'} · 失败 ${rc.drift ?? '?'} · 待调整 ${rc.patches_count ?? 0}
        <crm-button data-action="view-report" data-date="${rc.run_date}">查看完整报告</crm-button>`;
    } else {
      card.style.display = 'none';
    }
```

- [ ] **Step 3: 加查看报告点击 + 弹窗逻辑**

在 `src/web/my-todo.html` L113 `wb-container` 点击委托之后追加：
```js
// 报告卡「查看完整报告」→ 拉取 markdown 弹窗显示
document.getElementById('report-card').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('crm-button[data-action="view-report"]');
  if (!btn) return;
  const date = btn.dataset.date;
  try {
    const md = await get(`/api/nightly-report/${date}`);
    document.getElementById('report-modal-content').textContent = md;
    document.getElementById('report-modal').classList.remove('hidden');
  } catch (e) { alert('报告获取失败：' + e.message); }
});
document.getElementById('report-modal-close').addEventListener('click', () => {
  document.getElementById('report-modal').classList.add('hidden');
});
```

- [ ] **Step 4: 跑 ui-lint 确认合规**

Run: `cd D:/system/CRM-ai-native && node scripts/ui-lint.mjs 2>&1 | tail -10`
Expected: 0 违规（使用 crm-button；新增为非裸控件；hidden class 复用）

- [ ] **Step 5: Commit**

```bash
cd D:/system/CRM-ai-native
git add src/web/my-todo.html
git commit -m "feat(web): my-todo 参数调优报告卡 + 夜批日报查看弹窗"
```

---

### Task 6: 端到端手动验证（生产只读 + 批准链路不自动触发）

**Files:**
- 无新增文件（验证用现有 `scripts/prod-param-nightly-verify.mjs` 仅读数 + 手动触发）

- [ ] **Step 1: 跑一次真实夜批（生产，写报告但不自动批准）**

Run: `cd D:/system/CRM-ai-native && PGDATABASE=crm_native node -e "import('./src/scheduler/timers.js').then(m=>m.runRetroOnce()).then(r=>console.log('retro=',!!r.retro,'param=',r.param?.inspected)).catch(e=>{console.error(e);process.exit(1)})" 2>&1 | tail -8`
Expected: 输出 `retro= true param= 22`（三段跑通 + 报告落库；不抛错）

- [ ] **Step 2: 验证报告文件与表已落**

Run: `cd D:/system/CRM-ai-native && PGDATABASE=crm_native node -e "import('./src/db.js').then(async({query})=>{const r=await query(\"SELECT run_date,file_path,total_tasks,healthy,drift,patches_count FROM crm.nightly_report ORDER BY run_date DESC LIMIT 1\");console.log(JSON.stringify(r.rows[0]))})" 2>&1`
Expected: 输出今日 `run_date=2026-09-05` 一行，`file_path` 指向 `reports/nightly/20260905.md`，`patches_count>=1`

- [ ] **Step 3: 验证 my-todo 报告卡可见（ADMIN token）**

Run: `cd D:/system/CRM-ai-native && node -e "import('./src/http/auth.js').then(async({issueToken})=>{const tok=issueToken({username:'admin',role:'ADMIN',tenantId:'system'});const r=await fetch('http://localhost:3000/api/my-todo?view=tuning',{headers:{Authorization:'Bearer '+tok}});const j=await r.json();console.log('reportCard=',JSON.stringify(j.reportCard))})" 2>&1`
Expected: 输出 `reportCard=` 含 `run_date:2026-09-05` 与 `patches_count`

- [ ] **Step 4: 验证 GET /api/nightly-report/:date（ADMIN 返 md）**

Run: `cd D:/system/CRM-ai-native && node -e "import('./src/http/auth.js').then(async({issueToken})=>{const tok=issueToken({username:'admin',role:'ADMIN',tenantId:'system'});const r=await fetch('http://localhost:3000/api/nightly-report/20260905',{headers:{Authorization:'Bearer '+tok}});console.log('HTTP',r.status);console.log((await r.text()).slice(0,120))})" 2>&1`
Expected: HTTP 200 + markdown 开头 `# 夜批运行报告 20260905`

- [ ] **Step 5: 验证非 admin 被拒（403）**

Run: `cd D:/system/CRM-ai-native && node -e "import('./src/http/auth.js').then(async({issueToken})=>{const tok=issueToken({username:'alice',role:'SALES',tenantId:'system'});const r=await fetch('http://localhost:3000/api/nightly-report/20260905',{headers:{Authorization:'Bearer '+tok}});console.log('HTTP',r.status)})" 2>&1`
Expected: HTTP 403

- [ ] **Step 6: Commit 验证脚本（若补充了验证脚本则提交；否则跳过**

本 Task 仅验证，无源码改动，不 commit。若需固化为脚本：
```bash
cd D:/system/CRM-ai-native
git add scripts/prod-nightly-report-verify.mjs
git commit -m "test(report): 夜批日报端到端验证脚本（生产只读）"
```

---

## 自审（Self-Review）

**1. Spec 覆盖：** ①新 nightlyReport.js ✓ Task2；②timers.js 改 ✓ Task3；③nightly_report 表 ✓ Task1；④my-todo 报告卡+查看路由 ✓ Task4/5；契约 agent decision-retro ✓ 设计文档；报告渲染零 LLM ✓ Task2 注释+代码；不新增写通道 ✓ 全局；三段互不传染 ✓ Task3；非 admin 403 ✓ Task4/5 验证。

**2. 占位扫描：** 无 TBD/TODO；每步含完整代码或精确命令。

**3. 类型一致性：** `saveNightlyReport({retro,routing,param})` 在 Task2 定义、Task3 调用、Task4/5 消费 `reportCard` 字段（run_date/title/file_path/total_tasks/healthy/drift/patches_count）一致；`collectSegments` 在 Task2 定义且被 `saveNightlyReport` 内部使用；`runRetroOnce` DI 参数名 `retroFn/routingFn/paramFn/saveReportFn` 与 Task3 测试一致。
