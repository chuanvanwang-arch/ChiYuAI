# 决策校准 P2：监控页「校准」页签 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `/sales-decision-monitor` 增加「校准」段，使管理员能在一个页面内完成「看指标 → 看归因 → 审处方 → 批准/驳回/回滚 → 看效果」。

**Architecture:** 渲染逻辑全部放 `src/portal/calibrationRender.js`（纯函数、浏览器安全、零服务端 import），页面 HTML 只做挂载与事件绑定——对齐 `src/portal/businessTierRender.js` 的既有分工。新增 `POST /api/calibration/patches/generate` 负责「计算候选 + 填预期影响 + 幂等落库」，使 GET 保持只读、写操作集中在显式端点。

**Tech Stack:** Node 22 + ESM + Express 4 + PostgreSQL（pg）+ vitest 3；前端为静态 HTML + ES module（无构建步骤）

**设计依据：** `docs/2026-08-28-decision-quality-calibration-design.md` §7（已批准）

**前置依赖：** P0（处置回写）+ P1（度量/归因/重放/处方落库）已合入。

**测试命令约定：** 沙箱内禁 `npx`，统一用
`node node_modules/vitest/vitest.mjs run <files>`

**前端硬约束（已核实，违反即整页脚本不执行）**
1. `/portal/*.js` **不在静态托管目录内**，每个文件都必须在 `routes.js` 显式 `sendFile` 注册（样板见 `routes.js:1507-1509`）。新渲染模块不注册 → 浏览器 404 → 整个 module script 静默失败。
2. 浏览器侧渲染模块**禁止 import 任何服务端模块**（`src/calibration/constants.js`、`src/db.js` 等），否则同样 404。该坑在 S20 设计中已有明确记载。
3. `src/web/api.js` 的 `get/post` **直接透传后端 JSON，不包裹 `ok`**（既有踩坑：`config.html` 曾写 `if(!r?.ok)` 导致恒拦截）。`post()` 返回的 `{ok:true}` 是**端点自己的**字段，不是 `api()` 加的。
4. `api.js` 自动带 `Authorization: Bearer <localStorage.crm_token>`，401 自动跳 `/home.html`。

---

## 文件清单

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/http/calibrationRouter.js` | 改 | 新增 `POST /api/calibration/patches/generate`（含预期影响） |
| `src/portal/calibrationRender.js` | 新建 | 纯渲染函数（指标卡 / 归因 / 处方卡 / 历史） |
| `src/web/sales-decision-monitor.html` | 改 | 新增「校准」section + module script |
| `src/http/routes.js` | 改 | 注册 `/portal/calibrationRender.js` |
| `test/web/calibrationRender.test.js` | 新建 | 渲染纯函数 |
| `test/http/calibrationGenerate.test.js` | 新建 | generate 端点契约 |

---

## Task 1: `POST /api/calibration/patches/generate`

**Files:**
- Modify: `src/http/calibrationRouter.js`
- Test: `test/http/calibrationGenerate.test.js`

> **为什么单独一个 generate 端点**：候选处方由规则实时算出，若无落库步骤就没有 `patch_id`，批准/驳回无从下手。让 `GET /api/calibration/metrics` 顺手写库会变成"GET 有副作用"，故写操作收敛到显式端点，且落库幂等（同内容 PENDING 不重复插入）。

- [ ] **Step 1: 写失败测试**

```js
// test/http/calibrationGenerate.test.js — 处方生成端点
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createApp } from '../../src/http/server.js';
import { issueToken } from '../../src/http/auth.js';
import { query } from '../../src/db.js';

let app;
beforeAll(() => { app = createApp(); });
beforeEach(async () => {
  await query(`TRUNCATE crm.calibration_patch, crm.decision, crm.decision_event RESTART IDENTITY CASCADE`);
});

const sysadmin = `Bearer ${issueToken({ username: 'admin', role: 'sysadmin', display_name: '管理员' })}`;
const sales = `Bearer ${issueToken({ username: 'alice', role: 'sales', display_name: '销售' })}`;

const call = (body, auth = sysadmin) => app.fetch('/api/calibration/patches/generate', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: auth },
  body: JSON.stringify(body),
});

describe('POST /api/calibration/patches/generate', () => {
  it('非 sysadmin → 403', async () => {
    const res = await call({ scenario_id: 'QUOTE_PRICING' }, sales);
    expect(res.status).toBe(403);
  });

  it('样本不足 → 生成 0 条，返回 blocked_by=R6', async () => {
    const res = await call({ scenario_id: 'QUOTE_PRICING' });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.created).toBe(0);
    expect(j.blocked_by?.[0]?.rule_id).toBe('R6');
  });

  it('幂等：连续两次生成不产生重复 PENDING', async () => {
    await call({ scenario_id: 'QUOTE_PRICING' });
    const res = await call({ scenario_id: 'QUOTE_PRICING' });
    expect(res.status).toBe(200);
    const n = (await query(`SELECT count(*)::int n FROM crm.calibration_patch`)).rows[0].n;
    expect(n).toBe((await res.json()).created + (await res.json()).skipped_duplicates);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/http/calibrationGenerate.test.js`
Expected: FAIL —— 404（端点未注册）

- [ ] **Step 3: 实现**

在 `src/http/calibrationRouter.js` 的 `createCalibrationRouter` 内、`router.get('/api/calibration/replay', ...)` 之后插入：

```js
  // 生成处方：规则归因 → 影子重放算预期影响 → 幂等落库（写操作集中于此端点，GET 保持只读）
  router.post('/api/calibration/patches/generate', async (req, res) => {
    if (!guard(req, res)) return;
    try {
      const scenario_id = req.body?.scenario_id || null;
      const windowDays = Number(req.body?.window_days) || 30;

      const rows = await listDecisions({ scenario_id, limit: 500 });
      const cutoff = Date.now() - windowDays * 86400000;
      const inWindow = rows.filter((r) => new Date(r.created_at).getTime() >= cutoff);
      const metrics = computeMetrics(inWindow);
      const conf = await loadAutonomyConf();
      const avg = inWindow.length
        ? inWindow.reduce((s, d) => s + replayConfidence(d, conf), 0) / inWindow.length : null;

      const att = attribute(metrics, {
        scenario_id, config: conf, decisions: inWindow,
        confidenceStats: avg == null ? null
          : { avg, threshold: conf.threshold, gap: Math.abs(avg - conf.threshold) },
      });
      if (att.blocked_by.length) {
        return res.json({ created: 0, skipped_duplicates: 0, blocked_by: att.blocked_by, metrics });
      }

      // 为每条候选填预期影响：当前配置 vs 应用该处方后的配置
      const baseline = replayScenario(inWindow, conf);
      const enriched = att.patches.map((p) => {
        const next = { threshold: conf.threshold, weights: { ...conf.weights } };
        if (p.knob === 'threshold') next.threshold = p.to;
        else if (p.knob === 'weight') next.weights[p.target] = p.to;
        const after = replayScenario(inWindow, next);
        return {
          ...p,
          expected_impact: {
            autonomy_before: baseline.autonomy, autonomy_after: after.autonomy,
            escalated_before: baseline.escalated, escalated_after: after.escalated,
            estimated_override_rate: after.estimated_override_rate,
            sample_size: inWindow.length,
          },
        };
      });

      // 幂等落库：savePatches 对同 scenario+knob+target+to 的 PENDING 行跳过
      // scenario_id 已放宽为可空（P2 Task 1）：全场景生成时传 null，外键对 NULL 天然放行
      const before = await listPatches({ status: 'PENDING' });
      await savePatches(scenario_id, enriched, { evidence: { metrics, window_days: windowDays } });
      const afterRows = await listPatches({ status: 'PENDING' });
      res.json({
        created: Math.max(afterRows.length - before.length, 0),
        skipped_duplicates: Math.max(enriched.length - Math.max(afterRows.length - before.length, 0), 0),
        blocked_by: [], metrics,
        patches: enriched,
      });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
```

> `savePatches(scenario_id || '__ALL__', ...)`：`calibration_patch.scenario_id` 是 `NOT NULL` 且有外键指向 `decision_scenario`。**若传 `null` 会违反外键**；全场景生成时无法填具体场景。
> **正确做法**：在 Task 1 的迁移里把该列放宽为可空、外键保留（见下）。若选择不放宽，则 generate 必须要求 `scenario_id` 非空，端点在缺失时返回 400。**二选一，实现前先定：本计划选「放宽为可空」**，因为全场景视角是本页签的默认用法。
>
> 相应地在 P1 已建的 `db/schema.sql` 与 `scripts/seed-test-config.mjs` 建表语句中，把
> `scenario_id TEXT NOT NULL REFERENCES crm.decision_scenario(scenario_id)` 改为
> `scenario_id TEXT REFERENCES crm.decision_scenario(scenario_id)`，
> 并在业务库执行 `ALTER TABLE crm.calibration_patch ALTER COLUMN scenario_id DROP NOT NULL;`（幂等，已建库的兼容步骤）。

- [ ] **Step 4: 放宽 scenario_id 可空（业务库 + 测试库）**

Run: `psql -h 127.0.0.1 -p 5433 -U agent2b -d plm -c "ALTER TABLE crm.calibration_patch ALTER COLUMN scenario_id DROP NOT NULL;"`
Run: `psql -h 127.0.0.1 -p 5433 -U agent2b -d plm_test -c "ALTER TABLE crm.calibration_patch ALTER COLUMN scenario_id DROP NOT NULL;"`

并同步修改 `db/schema.sql` 与 `scripts/seed-test-config.mjs` 中的建表语句（去掉 `NOT NULL`）。

- [ ] **Step 5: 运行测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run test/http/calibrationGenerate.test.js`
Expected: 3 passed

- [ ] **Step 6: Commit**

```bash
git add src/http/calibrationRouter.js db/schema.sql scripts/seed-test-config.mjs test/http/calibrationGenerate.test.js
git commit -m "feat(calibration-p2): 处方生成端点（含影子重放预期影响）"
```

---

## Task 2: 纯渲染模块

**Files:**
- Create: `src/portal/calibrationRender.js`
- Test: `test/web/calibrationRender.test.js`

- [ ] **Step 1: 写失败测试**

```js
// test/web/calibrationRender.test.js — 校准页签渲染纯函数
import { test, expect, describe } from 'vitest';
import {
  renderMetricCards, renderAttribution, renderPatchCard, renderHistory, renderCalibration,
} from '../../src/portal/calibrationRender.js';

const metrics = {
  sample_size: 42, sufficient_sample: true, autonomy_rate: 0.3, escalate_rate: 0.7,
  autonomy_override_rate: 0.35, escalated_override_rate: 0.02,
  escalation_fatigue_rate: 0.1, human_latency_p50_ms: 7200000,
  reversal_rate: 0.05, precedent_coverage_avg: 0.6,
};

describe('renderMetricCards', () => {
  test('主指标 autonomy_override_rate 以百分比呈现', () => {
    const html = renderMetricCards(metrics);
    expect(html).toContain('35.0%');
    expect(html).toContain('42');
  });

  test('样本不足时给出提示', () => {
    const html = renderMetricCards({ ...metrics, sample_size: 3, sufficient_sample: false });
    expect(html).toContain('样本不足');
  });
});

describe('renderAttribution', () => {
  test('守卫命中 → 展示拒绝出方原因，不出处方卡', () => {
    const html = renderAttribution({ patches: [], blocked_by: [{ rule_id: 'R6', reason: '样本不足（3 < 20），不产生处方' }] });
    expect(html).toContain('R6');
    expect(html).toContain('样本不足');
  });
});

describe('renderPatchCard', () => {
  const p = {
    patch_id: 'p1', scenario_id: 'QUOTE_PRICING', knob: 'threshold', target: null,
    from_value: 0.8, to_value: 0.85, risk: 'LOW', status: 'PENDING',
    evidence: { rule_id: 'R1', reason: '自主覆写率偏高' },
    expected_impact: { autonomy_before: 10, autonomy_after: 6, escalated_before: 20, escalated_after: 24, sample_size: 30 },
  };

  test('展示旋钮与 from→to', () => {
    const html = renderPatchCard(p);
    expect(html).toContain('threshold');
    expect(html).toContain('0.8');
    expect(html).toContain('0.85');
    expect(html).toContain('R1');
  });

  test('展示预期影响（自主数变化）', () => {
    const html = renderPatchCard(p);
    expect(html).toContain('10');
    expect(html).toContain('6');
  });

  test('PENDING 才给批准/驳回按钮', () => {
    expect(renderPatchCard(p)).toContain('data-cal-approve="p1"');
    expect(renderPatchCard({ ...p, status: 'APPLIED' })).not.toContain('data-cal-approve');
    expect(renderPatchCard({ ...p, status: 'APPLIED' })).toContain('data-cal-rollback="p1"');
  });

  test('HTML 转义：证据文本含尖括号不破页', () => {
    const html = renderPatchCard({ ...p, evidence: { rule_id: '<script>x</script>', reason: 'a > b' } });
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('renderCalibration', () => {
  test('组合输出含指标与处方两段', () => {
    const html = renderCalibration(
      { metrics, patches: [], blocked_by: [] },
      { patches: [] },
    );
    expect(html).toContain('35.0%');
    expect(html).toContain('决策质量校准');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/web/calibrationRender.test.js`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现**

```js
// src/portal/calibrationRender.js — 校准页签渲染（纯函数 · 浏览器安全）
// 硬约束：禁止 import 任何服务端模块（src/db.js / src/calibration/constants.js 等）——
//   /portal/*.js 不在静态托管目录，服务端模块路径会 404 并导致整个 module script 静默失败。
// 数据形状：rules.attribute 产出用 from/to；DB 行用 from_value/to_value。两种都要能吃下。
const _esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const _pct = (x) => `${(Number(x) || 0) * 100 >= 0 ? ((Number(x) || 0) * 100).toFixed(1) : '0.0'}%`;
const _num = (x) => (x == null ? '—' : String(x));
const _dur = (ms) => (ms == null ? '—' : `${(ms / 3600000).toFixed(1)} h`);

const KNOB_LABEL = { threshold: '自主阈值', weight: '置信权重', required_dims: '七维严格度' };

export function renderMetricCards(m = {}) {
  const warn = m.sufficient_sample
    ? ''
    : `<div class="cal-warn">样本不足（${_num(m.sample_size)} &lt; 20）：指标仅供观察，不产生处方</div>`;
  const card = (label, value, hint = '') =>
    `<div class="cal-card"><div class="cal-card-v">${value}</div><div class="cal-card-l">${label}</div>${
      hint ? `<div class="cal-card-h">${hint}</div>` : ''}</div>`;
  return `<div class="cal-cards">${warn}
    ${card('自主决策覆写率', _pct(m.autonomy_override_rate), '核心质量指标')}
    ${card('升级率', _pct(m.escalate_rate))}
    ${card('升级件改判率', _pct(m.escalated_override_rate))}
    ${card('升级疲劳率', _pct(m.escalation_fatigue_rate), '超时未处置')}
    ${card('人工延迟 p50', _dur(m.human_latency_p50_ms))}
    ${card('先例覆盖率', _pct(m.precedent_coverage_avg))}
    ${card('样本量', _num(m.sample_size))}
  </div>`;
}

export function renderAttribution(att = {}) {
  const { patches = [], blocked_by = [] } = att;
  if (blocked_by.length) {
    const items = blocked_by.map((b) =>
      `<li><code>${_esc(b.rule_id)}</code> ${_esc(b.reason)}</li>`).join('');
    return `<div class="cal-block"><h3>归因</h3><div class="cal-blocked">不出方：</div><ul>${items}</ul></div>`;
  }
  if (!patches.length) {
    return `<div class="cal-block"><h3>归因</h3><div class="cal-muted">无规则命中（当前指标处于可接受区间）</div></div>`;
  }
  const items = patches.map((p) =>
    `<li><code>${_esc(p.rule_id || p.evidence?.rule_id)}</code> ${_esc(p.reason || p.evidence?.reason)}</li>`).join('');
  return `<div class="cal-block"><h3>归因（命中规则）</h3><ul>${items}</ul></div>`;
}

export function renderPatchCard(p = {}) {
  const from = p.from_value !== undefined ? p.from_value : p.from;
  const to = p.to_value !== undefined ? p.to_value : p.to;
  const knob = `${KNOB_LABEL[p.knob] || p.knob}${p.target ? ` · ${_esc(p.target)}` : ''}`;
  const imp = p.expected_impact || {};
  const impact = imp.sample_size == null ? '' :
    `<div class="cal-impact">预期影响：自主 ${_num(imp.autonomy_before)} → <b>${_num(imp.autonomy_after)}</b>，${
      imp.estimated_override_rate == null ? '' : `预估覆写率 ${_pct(imp.estimated_override_rate)}（估算，非承诺）`}</div>`;
  const acts = p.status === 'PENDING'
    ? `<button data-cal-approve="${_esc(p.patch_id)}">批准</button>
       <button data-cal-reject="${_esc(p.patch_id)}">驳回</button>`
    : p.status === 'APPLIED'
    ? `<button data-cal-rollback="${_esc(p.patch_id)}">回滚</button>`
    : '';
  const ev = p.evidence || {};
  return `<div class="cal-patch cal-risk-${_esc(String(p.risk || 'LOW').toLowerCase())}">
    <div class="cal-patch-head"><b>${knob}</b>
      <span class="cal-mono">${_esc(JSON.stringify(from))} → ${_esc(JSON.stringify(to))}</span>
      <span class="cal-tag">${_esc(p.risk || 'LOW')}</span>
      <span class="cal-tag">${_esc(p.status || '')}</span>
    </div>
    <div class="cal-muted">规则 <code>${_esc(ev.rule_id || '')}</code>：${_esc(ev.reason || p.reason || '')}</div>
    ${impact}
    <div class="cal-actions">${acts}</div>
  </div>`;
}

export function renderHistory(rows = []) {
  if (!rows.length) return `<div class="cal-block"><h3>历史</h3><div class="cal-muted">尚无已应用处方</div></div>`;
  return `<div class="cal-block"><h3>历史（已应用 / 已回滚）</h3>${
    rows.map(renderPatchCard).join('')}</div>`;
}

export function renderCalibration(data = {}, patchList = []) {
  const { metrics = {}, patches = [], blocked_by = [] } = data;
  const pending = (patchList.patches || patchList || []).filter((p) => p.status === 'PENDING');
  const done = (patchList.patches || patchList || []).filter((p) => ['APPLIED', 'ROLLED_BACK'].includes(p.status));
  return `<h3>决策质量校准</h3>
    ${renderMetricCards(metrics)}
    ${renderAttribution({ patches, blocked_by })}
    <div class="cal-block"><h3>待审处方（${pending.length}）</h3>
      ${pending.length ? pending.map(renderPatchCard).join('') : '<div class="cal-muted">无待审处方</div>'}
    </div>
    ${renderHistory(done)}`;
}

export default { renderMetricCards, renderAttribution, renderPatchCard, renderHistory, renderCalibration };
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run test/web/calibrationRender.test.js`
Expected: 8 passed

- [ ] **Step 5: Commit**

```bash
git add src/portal/calibrationRender.js test/web/calibrationRender.test.js
git commit -m "feat(calibration-p2): 校准页签渲染纯函数"
```

---

## Task 3: 监控页挂载

**Files:**
- Modify: `src/web/sales-decision-monitor.html`

- [ ] **Step 1: 追加 section**

在文件末尾 `</body>` 之前、现有 `<script type="module">` 之前插入：

```html
<section id="calibration" class="dn-section">
  <h2>决策质量校准</h2>
  <div class="sub">指标 → 归因 → 处方。处方由规则引擎生成并附影子重放算出的预期影响；批准需 sysadmin，落库走第0闸且可回滚。</div>
  <div class="row">
    <select id="cal-scenario">
      <option value="">全部场景</option>
      <option value="LEAD_FOLLOW_UP">一、线索 LEAD_FOLLOW_UP</option>
      <option value="OPP_QUALIFY">二、机会评估 OPP_QUALIFY</option>
      <option value="SOLUTION_VALUE">三、方案价值 SOLUTION_VALUE</option>
      <option value="QUOTE_PRICING">四、商务报价 QUOTE_PRICING</option>
      <option value="SIGN_RISK">五、签单前风险 SIGN_RISK</option>
      <option value="POST_CONTRACT">六、签约后 POST_CONTRACT</option>
      <option value="LOSS_REVIEW">七、丢单复盘 LOSS_REVIEW</option>
    </select>
    <select id="cal-window">
      <option value="7">近 7 天</option>
      <option value="30" selected>近 30 天</option>
      <option value="90">近 90 天</option>
    </select>
    <button id="cal-refresh">刷新</button>
    <button id="cal-generate">生成处方</button>
  </div>
  <div id="cal-output">— 等待查询 —</div>
</section>
```

- [ ] **Step 2: 追加 module script**

在现有 `<script type="module">`（含 `injectLayout()`）**之后**追加：

```html
<script type="module">
import { get, post } from '/portal/api.js';
import { renderCalibration } from '/portal/calibrationRender.js';

const out = document.getElementById('cal-output');
const scn = document.getElementById('cal-scenario');
const win = document.getElementById('cal-window');

async function load() {
  if (!out) return;
  out.textContent = '加载中…';
  try {
    const q = `scenario_id=${encodeURIComponent(scn.value)}&window_days=${encodeURIComponent(win.value)}`;
    const data = await get(`/api/calibration/metrics?${q}`);
    const list = await get('/api/calibration/patches');
    out.innerHTML = renderCalibration(data, list.patches || []);
    bind();
  } catch (e) {
    out.textContent = `加载失败：${e.message || e}（本段需 sysadmin）`;
  }
}

function bind() {
  const wire = (attr, fn) => out.querySelectorAll(`[data-cal-${attr}]`).forEach((b) => {
    b.onclick = async () => {
      b.disabled = true;
      try { await fn(b.dataset[`cal${attr[0].toUpperCase()}${attr.slice(1)}`]); }
      catch (e) { alert(`操作失败：${e.message || e}`); }
      await load();
    };
  });
  wire('approve', (id) => post(`/api/calibration/patches/${id}/approve`, {}));
  wire('reject', (id) => post(`/api/calibration/patches/${id}/reject`, {}));
  wire('rollback', (id) => post(`/api/calibration/patches/${id}/rollback`, {}));
}

document.getElementById('cal-refresh').addEventListener('click', load);
document.getElementById('cal-generate').addEventListener('click', async () => {
  const btn = document.getElementById('cal-generate');
  btn.disabled = true;
  try {
    const r = await post('/api/calibration/patches/generate', {
      scenario_id: scn.value || null,
      window_days: Number(win.value),
    });
    if (r.blocked_by?.length) alert(`未生成处方：${r.blocked_by.map((b) => b.reason).join('；')}`);
  } catch (e) { alert(`生成失败：${e.message || e}`); }
  btn.disabled = false;
  await load();
});
load();
</script>
```

> 注意：`post()` 返回的是**端点原始 JSON**（`api()` 不包裹 `ok`）。`generate` 端点返回 `{created, skipped_duplicates, blocked_by, metrics, patches}`，故用 `r.blocked_by` 直接判断。

- [ ] **Step 3: 追加样式**

在文件 `<style>` 块内（`.dn-modal-body #dn-output` 规则之后）追加：

```css
  .cal-cards { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0; }
  .cal-card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 10px 14px; min-width: 120px; }
  .cal-card-v { font-size: 18px; font-weight: 600; color: var(--ink); }
  .cal-card-l { font-size: 12px; color: var(--mut); margin-top: 2px; }
  .cal-card-h { font-size: 11px; color: var(--mut); margin-top: 2px; }
  .cal-warn { flex-basis: 100%; background: var(--panel); border: 1px solid var(--line); border-left: 3px solid var(--ac); border-radius: 6px; padding: 8px 12px; font-size: 12px; color: var(--ink); }
  .cal-block { margin: 14px 0; }
  .cal-block h3 { font-size: 13px; font-weight: 600; color: var(--ink); margin: 0 0 6px; }
  .cal-muted { color: var(--mut); font-size: 12px; }
  .cal-blocked { color: var(--err); font-size: 12px; font-weight: 600; }
  .cal-patch { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; margin-bottom: 8px; }
  .cal-patch-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 13px; color: var(--ink); }
  .cal-mono { font-family: ui-monospace, monospace; font-size: 12px; color: var(--ink); }
  .cal-tag { border: 1px solid var(--line); border-radius: 4px; padding: 1px 6px; font-size: 11px; color: var(--mut); }
  .cal-impact { font-size: 12px; color: var(--mut); margin-top: 4px; }
  .cal-actions { margin-top: 8px; display: flex; gap: 8px; }
  .cal-actions button { background: var(--ac); color: #fff; border: none; border-radius: 4px; padding: 4px 12px; font-size: 12px; cursor: pointer; }
  .cal-risk-medium { border-left: 3px solid var(--ac); }
  .cal-risk-high { border-left: 3px solid var(--err); }
```

- [ ] **Step 4: Commit**

```bash
git add src/web/sales-decision-monitor.html
git commit -m "feat(calibration-p2): 监控页新增校准段"
```

---

## Task 4: 注册 `/portal/calibrationRender.js`

**Files:**
- Modify: `src/http/routes.js`

- [ ] **Step 1: 注册路由**

在 `app.get('/portal/businessTierRender.js', ...)`（`routes.js:1507-1509`）之后插入：

```js
  app.get('/portal/calibrationRender.js', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../portal/calibrationRender.js', import.meta.url)), { headers: { 'Content-Type': 'text/javascript' } }));
```

- [ ] **Step 2: 冒烟验证可访问**

Run（先重启 server）：`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/portal/calibrationRender.js`
Expected: `200`

> 不注册该文件 = 浏览器 404 = 整个 module script 静默失败，页面只剩 "— 等待查询 —"，且控制台报模块加载错误。**这是本 Task 最易漏的一步。**

- [ ] **Step 3: Commit**

```bash
git add src/http/routes.js
git commit -m "feat(calibration-p2): 注册 /portal/calibrationRender.js"
```

---

## Task 5: 验收与全量回归

- [ ] **Step 1: 全量回归**

Run: `node node_modules/vitest/vitest.mjs run`
Expected: 无新增失败（基线 1107 例 / 1099 通过 / 6 失败，均为既有问题）

- [ ] **Step 2: 浏览器验收（sysadmin 登录）**

1. 以 sysadmin 登录，打开 `http://localhost:3000/sales-decision-monitor`，滚到底部
2. 期望看到「决策质量校准」段，指标卡已渲染（初始样本不足时显示「样本不足」提示）
3. 点「生成处方」→ 样本不足时弹窗提示 R6 原因；样本充足时处方出现在「待审处方」
4. 点「批准」→ 处方状态变 `APPLIED`，出现在「历史」，且可用 `curl` 验证：
   `psql -h 127.0.0.1 -p 5433 -U agent2b -d plm -c "SELECT knob, from_value, to_value, status, decision_id FROM crm.calibration_patch ORDER BY created_at DESC LIMIT 3;"`
5. 点「回滚」→ 状态变 `ROLLED_BACK`，`config_store['autonomy-conf']` 恢复原值：
   `psql -h 127.0.0.1 -p 5433 -U agent2b -d plm -c "SELECT value FROM crm.config_store WHERE key='autonomy-conf';"`
6. 以 sales 身份登录同一页面 → 校准段显示「加载失败：需要 sysadmin」

- [ ] **Step 3: Commit（若有修补）**

```bash
git add -A
git commit -m "fix(calibration-p2): 验收修补"
```

---

## 自检清单

- [x] 覆盖设计 §7 的 UI 四段（指标卡 / 归因 / 处方卡 / 历史回测）
- [x] 渲染逻辑与页面分离，纯函数可测
- [x] 浏览器侧零服务端 import；`/portal/*.js` 已注册路由
- [x] 遵守 `api()` 不包裹 `ok` 的既有契约
- [x] 写操作集中在 `generate` / `approve` / `reject` / `rollback` 四个端点，GET 保持只读
- [x] 每个 Task 自带测试与 commit
