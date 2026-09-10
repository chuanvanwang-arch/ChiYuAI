# R7 先例自锁 · B/C 立项实施计划（真因复核版）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把先例池闸门从仅收 `CONFIRMED/AUTONOMOUS`（22 条，8.6%）对齐到真实已决终态集 `{CONFIRMED,AUTONOMOUS,DECIDED,PROCESSED}`（153 条，59.8%），消除 131 条已决决策被旧闸门挡在池外的真自锁；HUMAN/REQUIRED 仍排除（待确认/待触发，无终态结论）。

**Architecture:** 纯闸门放宽 + 常量化（T1）+ 幂等 embedding 回填脚本（T2，解决 DECIDED/PROCESSED 0 embedding 导致的每查询重嵌放大）+ 回归护栏（T3）+ 覆盖率量化（T4）。零 DELETE、不改"先例必须对应已决结论"语义、不改 HUMAN→CONFIRMED 既有流转（`disposition.js:recordHumanDisposition`）。

**Tech Stack:** Node.js + pg（`src/db.js`）+ `embedText`/`stableStringify`（`src/ontology/embedding.js`）+ vitest。

---

### 任务 0：基线验证（确认真缺口存在）

**Files:**
- Read-only: `src/decision/decisionRepo.js:544`

- [ ] **Step 1: 确认当前闸门仅收两态**

Run:
```bash
cd D:/system/CRM-ai-native
grep -n "state IN ('CONFIRMED','AUTONOMOUS')" src/decision/decisionRepo.js
```
Expected: 命中 1 行（line 544），证明闸门未含 DECIDED/PROCESSED。

---

### 任务 1：闸门对齐真实终态 + 回归护栏（T1 + T3）

**Files:**
- Modify: `src/decision/decisionRepo.js:540-548`（常量 + IN 子句）
- Test: `test/decision/r7-precedent-lock.test.js`（追加 DECIDED 召回用例）

- [ ] **Step 1: 写失败测试（DECIDED 应被先例池召回）**

在 `test/decision/r7-precedent-lock.test.js` 末尾 `});` 前追加：

```js
  it('T1/B-C: DECIDED 决策被先例池召回（已决终态入池）', async () => {
    const d = await createDecision({
      scenario_id: SID, trigger_context: CTX, conditions_evaluated: COND,
      disposition: 'APPROVE', business_tier: 'LEAD', state: 'DECIDED',
    });
    const precs = await searchPrecedents(SID, {
      trigger_context: CTX, conditions_evaluated: COND, business_tier: 'LEAD', disposition: null,
    }, { k: 5 });
    const hit = precs.find((p) => p.decision_id === d.decision_id);
    expect(hit).toBeTruthy();
    expect(hit.similarity).toBeGreaterThan(0.45); // 与既有 CONFIRMED 用例同口径
  });
```

- [ ] **Step 2: 运行测试确认红灯**

Run:
```bash
cd D:/system/CRM-ai-native
node node_modules/vitest/vitest.mjs run test/decision/r7-precedent-lock.test.js 2>&1 | tail -20
```
Expected: 新用例 FAIL（DECIDED 当前被闸门排除，`hit` 为 undefined）。

- [ ] **Step 3: 实现闸门放宽（常量 + IN 子句）**

在 `src/decision/decisionRepo.js` 顶部 import 区之后（约 line 30 后）新增常量：

```js
// R7 B/C（2026-09-10）：先例池闸门——已决终态集。
// 原仅收 CONFIRMED/AUTONOMOUS，漏收重构前遗留的 DECIDED/PROCESSED（占生产 50%），导致先例自锁。
// HUMAN/REQUIRED 仍排除（待人工确认/待触发，无终态结论，入池会污染先例+误导置信度）。
export const DECISION_DECIDED_STATES = ['CONFIRMED', 'AUTONOMOUS', 'DECIDED', 'PROCESSED'];
```

将 `searchPrecedents` 内 line 544 的 SQL 片段：
```js
     WHERE scenario_id=$1 AND state IN ('CONFIRMED','AUTONOMOUS')
```
改为（常量内插，因 DECISION_DECIDED_STATES 是内部硬编码常量，非外部输入，字符串插值安全）：
```js
     WHERE scenario_id=$1 AND state IN (${DECISION_DECIDED_STATES.map((s) => `'${s}'`).join(',')})
```

- [ ] **Step 4: 运行测试确认绿灯**

Run:
```bash
cd D:/system/CRM-ai-native
node node_modules/vitest/vitest.mjs run test/decision/r7-precedent-lock.test.js 2>&1 | tail -20
```
Expected: 全部用例 PASS（含新增 DECIDED 召回 + 既有 HUMAN 不召回）。

- [ ] **Step 5: 语法检查 + 提交**

```bash
cd D:/system/CRM-ai-native
node --check src/decision/decisionRepo.js
git add src/decision/decisionRepo.js test/decision/r7-precedent-lock.test.js
git commit -m "R7-B/C T1/T3: widen precedent gate to decided states + regression guard"
```

---

### 任务 2：决策 embedding 幂等回填（T2）

**Files:**
- Create: `scripts/decision-embed-backfill.mjs`

- [ ] **Step 1: 写回填脚本**

```js
// scripts/decision-embed-backfill.mjs — R7 B/C（2026-09-10）
// 回填 DECIDED/PROCESSED 决策的 embedding 列（生产库该两态 0 embedding，导致 searchPrecedents 每查询即时重嵌放大）。
// 幂等：仅补 embedding IS NULL 的行；零 DELETE；--apply 才写，否则 dry-run 仅统计。
import { query, queryWrite } from '../src/db.js';
import { embedText, stableStringify } from '../src/ontology/embedding.js';

const DRY = !process.argv.includes('--apply');
const stats = { scanned: 0, embedded: 0, skipped: 0, errors: 0 };

try {
  const rows = await query(
    `SELECT decision_id, scenario_id, trigger_context, conditions_evaluated
       FROM crm.decision WHERE state IN ('DECIDED','PROCESSED') AND embedding IS NULL`
  );
  stats.scanned = rows.length;
  for (const r of rows) {
    try {
      const ev = await embedText(stableStringify({
        scenario_id: r.scenario_id,
        ctx: r.trigger_context || {},
        cond: r.conditions_evaluated || [],
      }), { metering: { tenantId: 'system', actor: 'decision', action: 'precedent-backfill-embed' } });
      if (!ev?.vector?.length) { stats.skipped++; continue; }
      const vec = JSON.stringify(ev.vector); // 与 decisionRepo.js:160 写入格式一致
      if (DRY) { stats.embedded++; continue; }
      await queryWrite(`UPDATE crm.decision SET embedding=$2 WHERE decision_id=$1`, [r.decision_id, vec]);
      stats.embedded++;
    } catch (e) {
      stats.errors++;
      console.error('ERR', r.decision_id, e?.message || e);
    }
  }
  console.log(JSON.stringify({ dry: DRY, ...stats }, null, 2));
} catch (e) {
  console.error('FATAL', e?.message || e);
  process.exit(1);
} finally {
  process.exit(0);
}
```

- [ ] **Step 2: 测试库 dry-run 验证**

```bash
cd D:/system/CRM-ai-native
PGDATABASE=crm_native_test node scripts/decision-embed-backfill.mjs 2>&1 | grep -v "未设置 PGDATABASE\|测试/演示"
```
Expected: 输出 `{ dry: true, scanned: <n>, embedded: <n>, skipped: 0, errors: 0 }`（测试库 DECIDED/PROCESSED 行若有 NULL embedding 则 embedded>0）。

- [ ] **Step 3: 测试库 --apply 演练**

```bash
cd D:/system/CRM-ai-native
PGDATABASE=crm_native_test node scripts/decision-embed-backfill.mjs --apply 2>&1 | grep -v "未设置 PGDATABASE\|测试/演示"
```
Expected: `dry: false`，`embedded` 与前步一致；重跑应 `scanned:0`（幂等）。

- [ ] **Step 4: 提交**

```bash
cd D:/system/CRM-ai-native
git add scripts/decision-embed-backfill.mjs
git commit -m "R7-B/C T2: add idempotent decision embedding backfill script"
```

> 生产执行（HITL，待用户在本地健康 checkout 授权）：
> ```powershell
> cd D:\system\CRM-ai-native
> $env:PGDATABASE="crm_native"; node scripts/decision-embed-backfill.mjs   # 先 dry-run 核对计数
> $env:PGDATABASE="crm_native"; node scripts/decision-embed-backfill.mjs --apply   # 生产回填
> ```

---

### 任务 3：覆盖率量化复核（T4）

**Files:**
- Create: `scripts/r7-precedent-pool-coverage.mjs`

- [ ] **Step 1: 写覆盖率脚本**

```js
// scripts/r7-precedent-pool-coverage.mjs — R7 B/C（2026-09-10）闭环指标
// 输出先例池覆盖率：旧闸门(CONFIRMED/AUTONOMOUS) vs 新闸门(已决四态)，证明自锁消除。
import { poolRead } from '../src/db.js';
const q = (t, p = []) => poolRead.query(t, p).then((r) => r.rows);
try {
  const total = (await q(`SELECT count(*)::int n FROM crm.decision`)).map((r) => r.n)[0];
  const oldPool = (await q(`SELECT count(*)::int n FROM crm.decision WHERE state IN ('CONFIRMED','AUTONOMOUS')`)).map((r) => r.n)[0];
  const newPool = (await q(`SELECT count(*)::int n FROM crm.decision WHERE state IN ('CONFIRMED','AUTONOMOUS','DECIDED','PROCESSED')`)).map((r) => r.n)[0];
  console.log(JSON.stringify({
    total,
    old_pool: oldPool, old_coverage_pct: +((oldPool / total) * 100).toFixed(1),
    new_pool: newPool, new_coverage_pct: +((newPool / total) * 100).toFixed(1),
  }, null, 2));
} catch (e) {
  console.error('ERR', e?.message || e);
} finally {
  await poolRead.end();
}
```

- [ ] **Step 2: 运行（生产只读）**

```bash
cd D:/system/CRM-ai-native
node scripts/r7-precedent-pool-coverage.mjs 2>&1 | grep -v "未设置 PGDATABASE\|测试/演示"
```
Expected: `old_coverage_pct ≈ 8.6 (22)`，`new_coverage_pct ≈ 59.8 (153)`（与设计 §5 口径一致）。

- [ ] **Step 3: 回填设计文档 §5 闭环表**

将运行结果写入 `docs/2026-09-10-r7-precedent-lock-bc-design.md` §5 闭环回写表「观测」列（替换占位）。

- [ ] **Step 4: 提交**

```bash
cd D:/system/CRM-ai-native
git add scripts/r7-precedent-pool-coverage.mjs docs/2026-09-10-r7-precedent-lock-bc-design.md
git commit -m "R7-B/C T4: add pool coverage metric + fill closure table"
```

---

### 任务 4：全量决策回归

**Files:**
- Read-only verification

- [ ] **Step 1: 运行完整决策测试套件**

```bash
cd D:/system/CRM-ai-native
node node_modules/vitest/vitest.mjs run test/decision.test.js test/decision/ 2>&1 | tail -15
```
Expected: 全绿、无新增红。

- [ ] **Step 2: 清理临时审计脚本（若残留）**

```bash
cd D:/system/CRM-ai-native
rm -f scripts/_audit_*.mjs
```

---

## 自检（Spec 覆盖 / 占位符 / 类型一致）

1. **Spec 覆盖**：T1(闸门常量+IN) → 任务1；T2(回填脚本) → 任务2；T3(回归护栏) → 任务1 Step1/4；T4(量化) → 任务3。1:1 覆盖。
2. **占位符扫描**：无 TBD/TODO/"类似任务 N"/"适当处理"。
3. **类型一致**：`DECISION_DECIDED_STATES` 在任务1 Step3 定义、同任务内使用；`embedText(stableStringify(...), { metering })` 签名与 `decisionRepo.js:553` 一致；`JSON.stringify(ev.vector)` 写入格式与 `decisionRepo.js:160` 一致；`query/queryWrite/poolRead` 来自 `src/db.js`（与决策模块同源）。
