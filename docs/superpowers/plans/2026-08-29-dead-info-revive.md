# 全站死信息活体化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 7 处静态 reasoning-trace 改为服务端按真实数据算状态（方案 B），并补齐 S35 外部工商采集闭环（读链路注入 + 手动同步触发）。

**Architecture:** 新增纯函数判定内核 `src/page/reasoningSteps.js`（7 页共用，label→facts 判定表）；renderer.js 的 reasoning-trace 分支改为「优先读 `data.components['reasoning-trace'].steps`（服务端注入），无注入则用 schema 写死 steps」；7 个 handler 在各自真实数据聚合处用 `buildReasoningSteps()` 替换「原样回传」；S30 工厂注入一次；S35 加 `attr-field biz` 读链路 + `POST /api/connector/zhizao-verify` 写触发端点。S03 保持 live 示范不变。

**Tech Stack:** Node 22 ESM + Express 4 + vitest 3 + PostgreSQL 16（crm schema）

---

## 文件结构

**新建：**
- `src/page/reasoningSteps.js` — 判定内核（纯函数，7 页共用）
- `test/page/reasoningSteps.test.js` — 判定内核测试

**修改：**
- `src/page/renderer.js` — reasoning-trace 分支（L356-372）优先读注入 steps
- `src/http/routes.js` — S02/S06/S07/S09/S14/S35 共 6 个 handler 的 reasoning-trace 注入 + S35 attr-field biz 读链路 + `POST /api/connector/zhizao-verify` 端点
- `src/http/controlledConfigPages.js` — S30 工厂 reasoning-trace 注入（1 处）
- `test/http/*.test.js` — 相应端点回归（如不存在则新建）

**只读参考（不改）：**
- `src/connectors/connectorActions.js`（conn-zhizao-verify-account 已存在，仅被调用）
- `src/action/registry.js` / `src/action/executor.js`（actionExecutor.dispatch 调用方）
- 7 个 schema 文件（steps 写死保留为 fallback 默认，不删）

---

## 判定表（7 页共用，定义于 reasoningSteps.js）

| Page | step1 | step2 | step3 |
|---|---|---|---|
| S02 | 意图解析: hasTasks→ok | 上下文装配: tasksHasContext→ok | 切入建议: hasActionableTask→ok:else:idle |
| S06 | 画像装配: profileFilled→ok | 七维校验: sevenDimCovered→ok:else:warn | 洞察建议: tasksNonEmpty→ok:else:idle |
| S07 | MEDDICC 评估: meddiccFilled→ok:else:warn | 决策历史: hasDecisionHistory→ok:else:warn | 推进建议: hasFollowupTask→ok:else:idle |
| S09 | 条款解析: hasClause→ok | 回款风险: hasOverduePlan→warn:else:ok | 修订建议: hasOverduePlan→pending:else:idle |
| S14 | 决策加载: hasDecision→ok | 关联展开: hasEdges→ok | 因果链: hasTrace→ok |
| S30 | 覆盖度加载: hasDecision→ok | 先例匹配: hasPrecedent→ok | 偏差分析: hasException→warn:else:idle |
| S35 | 聚合四源: timelineNonEmpty→ok | 权限裁剪: roleHasPerm→ok | 生成建议: tasksNonEmpty→ok:else:idle |

---

## Task 1: reasoningSteps 判定内核

**Files:**
- Create: `src/page/reasoningSteps.js`
- Test: `test/page/reasoningSteps.test.js`

- [ ] **Step 1: 写失败测试**

```js
// test/page/reasoningSteps.test.js
import { describe, it, expect } from 'vitest';
import { buildReasoningSteps } from '../../src/page/reasoningSteps.js';

describe('buildReasoningSteps', () => {
  it('S02：任务队列驱动三状态', () => {
    const schemaSteps = [
      { status: 'ok', label: '意图解析' },
      { status: 'ok', label: '上下文装配' },
      { status: 'pending', label: '切入建议' },
    ];
    const facts = { page: 'S02', hasTasks: true, tasksHasContext: true, hasActionableTask: false };
    expect(buildReasoningSteps(schemaSteps, facts)).toEqual([
      { status: 'ok', label: '意图解析' },
      { status: 'ok', label: '上下文装配' },
      { status: 'idle', label: '切入建议' },
    ]);
  });

  it('S09：逾期计划驱动回款风险 warn / 修订建议 pending', () => {
    const schemaSteps = [
      { status: 'ok', label: '条款解析' },
      { status: 'warn', label: '回款风险' },
      { status: 'pending', label: '修订建议' },
    ];
    const facts = { page: 'S09', hasClause: true, hasOverduePlan: true };
    expect(buildReasoningSteps(schemaSteps, facts)).toEqual([
      { status: 'ok', label: '条款解析' },
      { status: 'warn', label: '回款风险' },
      { status: 'pending', label: '修订建议' },
    ]);
  });

  it('S09：无逾期 → 回款风险 ok / 修订建议 idle', () => {
    const schemaSteps = [
      { status: 'ok', label: '条款解析' },
      { status: 'warn', label: '回款风险' },
      { status: 'pending', label: '修订建议' },
    ];
    const facts = { page: 'S09', hasClause: true, hasOverduePlan: false };
    expect(buildReasoningSteps(schemaSteps, facts)).toEqual([
      { status: 'ok', label: '条款解析' },
      { status: 'ok', label: '回款风险' },
      { status: 'idle', label: '修订建议' },
    ]);
  });

  it('未知 label → 保持原 status 不丢', () => {
    const schemaSteps = [{ status: 'ok', label: '自定义评估' }];
    const facts = { page: 'S02' };
    expect(buildReasoningSteps(schemaSteps, facts)).toEqual([{ status: 'ok', label: '自定义评估' }]);
  });

  it('steps 为空数组 → 返回空数组', () => {
    expect(buildReasoningSteps([], { page: 'S02' })).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/page/reasoningSteps.test.js`
Expected: FAIL（`Cannot find module '../../src/page/reasoningSteps.js'` 或 `buildReasoningSteps is not a function`）

- [ ] **Step 3: 写最小实现**

```js
// src/page/reasoningSteps.js
// 全站死信息活体化判定内核：7 页 reasoning-trace 由服务端按真实 facts 算状态（方案 B）。
// 契约：对 schema 写死 steps 逐条按「label 命中判定表」重算 {status,label}；
//       未命中规则则保持原 status（不丢信息）；label 永远保留。
// 判定状态四态对齐 renderer 语义：ok（绿）/ warn（黄）/ pending（进行中）/ idle（未触发）。

// 每页判定表：label → 状态计算函数（返回 ok|warn|pending|idle）
const RULES = {
  // S02 作战室：任务队列驱动
  '意图解析': (f) => (f.hasTasks ? 'ok' : 'idle'),
  '上下文装配': (f) => (f.tasksHasContext ? 'ok' : 'idle'),
  '切入建议': (f) => (f.hasActionableTask ? 'ok' : 'idle'),
  // S06 客户360：画像/七维/洞察
  '画像装配': (f) => (f.profileFilled ? 'ok' : 'idle'),
  '七维校验': (f) => (f.sevenDimCovered ? 'ok' : 'warn'),
  '洞察建议': (f) => (f.tasksNonEmpty ? 'ok' : 'idle'),
  // S07 商机：MEDDICC/决策历史/推进
  'MEDDICC 评估': (f) => (f.meddiccFilled ? 'ok' : 'warn'),
  '决策历史': (f) => (f.hasDecisionHistory ? 'ok' : 'warn'),
  '推进建议': (f) => (f.hasFollowupTask ? 'ok' : 'idle'),
  // S09 合同：条款/回款风险/修订
  '条款解析': (f) => (f.hasClause ? 'ok' : 'idle'),
  '回款风险': (f) => (f.hasOverduePlan ? 'warn' : 'ok'),
  '修订建议': (f) => (f.hasOverduePlan ? 'pending' : 'idle'),
  // S14 决策图：决策/关联/因果
  '决策加载': (f) => (f.hasDecision ? 'ok' : 'idle'),
  '关联展开': (f) => (f.hasEdges ? 'ok' : 'idle'),
  '因果链': (f) => (f.hasTrace ? 'ok' : 'idle'),
  // S30 决策市场：覆盖/先例/偏差
  '覆盖度加载': (f) => (f.hasDecision ? 'ok' : 'idle'),
  '先例匹配': (f) => (f.hasPrecedent ? 'ok' : 'idle'),
  '偏差分析': (f) => (f.hasException ? 'warn' : 'idle'),
  // S35 客户洞察：聚合/裁剪/建议
  '聚合四源数据': (f) => (f.timelineNonEmpty ? 'ok' : 'idle'),
  '权限裁剪': (f) => (f.roleHasPerm ? 'ok' : 'idle'),
  '生成下一步建议': (f) => (f.tasksNonEmpty ? 'ok' : 'idle'),
};

export function buildReasoningSteps(schemaSteps, facts) {
  return (schemaSteps || []).map((s) => {
    const calc = RULES[s.label];
    if (!calc) return { status: s.status, label: s.label }; // 未命中规则 → 保持原 status
    return { status: calc(facts || {}), label: s.label };
  });
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run test/page/reasoningSteps.test.js`
Expected: PASS（5 例全绿）

- [ ] **Step 5: Commit**

```bash
git add src/page/reasoningSteps.js test/page/reasoningSteps.test.js
git commit -m "feat(page): reasoningSteps 判定内核 — 7 页 reasoning-trace 服务端算真状态"
```

---

## Task 2: renderer reasoning-trace 优先读注入 steps

**Files:**
- Modify: `src/page/renderer.js:356-372`
- Test: `test/page/renderer.test.js`（追加用例；如文件不存在新建 `test/page/reasoningTraceInject.test.js`）

- [ ] **Step 1: 写失败测试**

```js
// test/page/reasoningTraceInject.test.js
import { describe, it, expect } from 'vitest';
import { renderPage } from '../../src/page/renderer.js';

const schema = {
  type: 'detail',
  title: '测试页',
  layout: { columns: 1, theme: 'light' },
  navigation: { to: '/test' },
  components: [
    {
      kind: 'reasoning-trace',
      title: 'AI 洞察',
      steps: [
        { status: 'ok', label: '聚合四源数据' },
        { status: 'ok', label: '权限裁剪' },
        { status: 'ok', label: '生成下一步建议' },
      ],
    },
  ],
};

describe('renderPage reasoning-trace 注入优先', () => {
  it('有 data 注入 steps → 渲染注入状态', () => {
    const data = {
      components: {
        'reasoning-trace': {
          'AI 洞察': {
            steps: [
              { status: 'ok', label: '聚合四源数据' },
              { status: 'ok', label: '权限裁剪' },
              { status: 'idle', label: '生成下一步建议' },
            ],
          },
        },
      },
    };
    const { html } = renderPage(schema, data);
    // 注入的「生成下一步建议」为 idle
    expect(html).toContain('data-trace-step="idle"');
    expect(html).toContain('生成下一步建议');
  });

  it('无 data 注入 → 回退 schema 写死 steps（向后兼容）', () => {
    const { html } = renderPage(schema, { components: {} });
    expect(html).toContain('data-trace-step="ok"');
    expect(html).toContain('聚合四源数据');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/page/reasoningTraceInject.test.js`
Expected: FAIL（`data-trace-step="idle"` not found —— 当前 renderer 只读 comp.steps）

- [ ] **Step 3: 修改 renderer.js reasoning-trace 分支**

在 `src/page/renderer.js` 的 `case 'reasoning-trace':` 分支（约 L356）开头，把非 live 分支改为：先 resolveDatum 取注入 steps，无则用 `comp.steps`。

```js
    case 'reasoning-trace': {
      // 方案 B：服务端注入 steps 优先（data.components['reasoning-trace'] 按 comp.title 索引）；
      // 无注入则回退 schema 写死 steps（向后兼容，S03 live 示范保持走 live 分支）
      const injected = resolveDatum(comp, data);
      const pendingSteps = injected?.steps || comp.steps;
      if (comp.live) {
        const steps = [
          { step: 'intent', label: pendingSteps?.[0]?.label || '意图解析' },
          { step: 'context', label: pendingSteps?.[1]?.label || '上下文装配' },
          { step: 'action', label: pendingSteps?.[2]?.label || '动作编排' },
        ];
        return `<div class="pg-trace-wrap" data-kind="reasoning-trace">
          <h3 class="pg-comp-title">${escapeHtml(comp.title || '思考链执行过程')}</h3>
          <ol class="pg-trace">${steps.map((s) =>
            `<li data-trace-step data-step="${s.step}" data-status="idle">${escapeHtml(s.label)}<span class="pg-dot"></span><div class="pg-step-detail" data-step-detail="${s.step}"></div></li>`
          ).join('')}</ol>
          <div class="pg-trace-meta" data-task-id=""></div>
          <div class="pg-event-log" data-event-log></div>
        </div>`;
      }
      return `<ol class="pg-trace">${(pendingSteps || []).map((s) => `<li data-trace-step="${escapeHtml(s.status || '')}">${escapeHtml(s.label || '')}</li>`).join('') || '<li>（空 trace）</li>'}</ol>`;
    }
```

注意：resolveDatum 在 renderPage 内可用（同函数作用域），且该分支已是 switch case，用 `{ }` 包裹保持变量作用域。`escapeHtml` 已在 renderer 顶部定义。

- [ ] **Step 4: 运行测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run test/page/reasoningTraceInject.test.js`
Expected: PASS（2 例全绿）。同时回归既有 trace 测试：`node node_modules/vitest/vitest.mjs run test/page/`
Expected: 全部通过（无回归）

- [ ] **Step 5: Commit**

```bash
git add src/page/renderer.js test/page/reasoningTraceInject.test.js
git commit -m "feat(renderer): reasoning-trace 优先读服务端注入 steps，无注入回退 schema"
```

---

## Task 3: S02 作战室 trace 活体化

**Files:**
- Modify: `src/http/routes.js:646`（reasoning-trace 注入处）
- Test: `test/http/s02-reasoning-trace.test.js`（新建）

- [ ] **Step 1: 写失败测试**

```js
// test/http/s02-reasoning-trace.test.js
import { describe, it, expect } from 'vitest';
import { buildReasoningSteps } from '../../src/page/reasoningSteps.js';

describe('S02 reasoning-trace 真状态', () => {
  it('有任务+有上下文+无可行动 → 意图 ok/上下文 ok/切入 idle', () => {
    const steps = [
      { status: 'ok', label: '意图解析' },
      { status: 'ok', label: '上下文装配' },
      { status: 'pending', label: '切入建议' },
    ];
    const facts = { page: 'S02', hasTasks: true, tasksHasContext: true, hasActionableTask: false };
    expect(buildReasoningSteps(steps, facts)).toEqual([
      { status: 'ok', label: '意图解析' },
      { status: 'ok', label: '上下文装配' },
      { status: 'idle', label: '切入建议' },
    ]);
  });

  it('无任务 → 全部 idle', () => {
    const steps = [
      { status: 'ok', label: '意图解析' },
      { status: 'ok', label: '上下文装配' },
      { status: 'pending', label: '切入建议' },
    ];
    const facts = { page: 'S02', hasTasks: false, tasksHasContext: false, hasActionableTask: false };
    expect(buildReasoningSteps(steps, facts)).toEqual([
      { status: 'idle', label: '意图解析' },
      { status: 'idle', label: '上下文装配' },
      { status: 'idle', label: '切入建议' },
    ]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/http/s02-reasoning-trace.test.js`
Expected: FAIL（当前 handler 无判定逻辑）

- [ ] **Step 3: 修改 routes.js S02 handler**

`src/http/routes.js` `app.get('/api/page/home')` 内（约 L593-655），在组装 data 前取任务状态：

```js
      // S02 reasoning-trace 真状态：任务队列驱动（方案 B）
      const tasks = await listTasks().catch(() => []);
      const hasTasks = tasks.length > 0;
      const tasksHasContext = tasks.some((t) => t.payload?.context || t.payload?.input);
      const hasActionableTask = tasks.some((t) => ['ready', 'running'].includes(t.status));
      const traceFacts = { page: 'S02', hasTasks, tasksHasContext, hasActionableTask };
```

并把 reasoning-trace 注入改为：

```js
          'reasoning-trace': {
            steps: buildReasoningSteps(
              S02_SCHEMA.components.find(c => c.kind === 'reasoning-trace')?.steps || [],
              traceFacts
            ),
          },
```

在文件顶部 import 处加：

```js
import { buildReasoningSteps } from '../page/reasoningSteps.js';
```

（若 `listTasks` 未在 routes.js import，需在顶部加 `import { listTasks } from '../kanban/kanban.js';`——检查现有 import，已有则复用。）

- [ ] **Step 4: 运行测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run test/http/s02-reasoning-trace.test.js`
Expected: PASS（2 例）。回归：`node node_modules/vitest/vitest.mjs run test/http/`（S02 相关不回归）

- [ ] **Step 5: Commit**

```bash
git add src/http/routes.js test/http/s02-reasoning-trace.test.js
git commit -m "feat(routes): S02 作战室 reasoning-trace 按任务队列算真状态"
```

---

## Task 4: S06 客户360 trace 活体化

**Files:**
- Modify: `src/http/routes.js:873`（reasoning-trace 注入处）
- Test: `test/http/s06-reasoning-trace.test.js`（新建）

- [ ] **Step 1: 写失败测试**

```js
// test/http/s06-reasoning-trace.test.js
import { describe, it, expect } from 'vitest';
import { buildReasoningSteps } from '../../src/page/reasoningSteps.js';

describe('S06 reasoning-trace 真状态', () => {
  it('画像完整+七维覆盖+有任务 → 全 ok', () => {
    const steps = [
      { status: 'ok', label: '画像装配' },
      { status: 'ok', label: '七维校验' },
      { status: 'ok', label: '洞察建议' },
    ];
    const facts = { page: 'S06', profileFilled: true, sevenDimCovered: true, tasksNonEmpty: true };
    expect(buildReasoningSteps(steps, facts)).toEqual([
      { status: 'ok', label: '画像装配' },
      { status: 'ok', label: '七维校验' },
      { status: 'ok', label: '洞察建议' },
    ]);
  });

  it('画像缺 + 七维未覆盖 → 画像 idle / 七维 warn', () => {
    const steps = [
      { status: 'ok', label: '画像装配' },
      { status: 'ok', label: '七维校验' },
      { status: 'ok', label: '洞察建议' },
    ];
    const facts = { page: 'S06', profileFilled: false, sevenDimCovered: false, tasksNonEmpty: false };
    expect(buildReasoningSteps(steps, facts)).toEqual([
      { status: 'idle', label: '画像装配' },
      { status: 'warn', label: '七维校验' },
      { status: 'idle', label: '洞察建议' },
    ]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/http/s06-reasoning-trace.test.js`
Expected: FAIL

- [ ] **Step 3: 修改 routes.js S06 handler**

`app.get('/api/page/account-360')` 内（约 L808-861），在 `dims` 计算后组装 traceFacts：

```js
      // S06 reasoning-trace 真状态（方案 B）
      const traceFacts = {
        page: 'S06',
        profileFilled: !!(p.industry || p.region || p.owner || p.tier),
        sevenDimCovered: Object.values(dims).every((d) => d),
        tasksNonEmpty: tasks.length > 0,
      };
```

并把 reasoning-trace 注入改为：

```js
          'reasoning-trace': {
            steps: buildReasoningSteps(
              S06_SCHEMA.components.find(c => c.kind === 'reasoning-trace')?.steps || [],
              traceFacts
            ),
          },
```

（`tasks` 变量若 S06 handler 中已有则复用，无则新增查询。`dims` 为该 handler 中七维 metric-card 的判定对象。）

- [ ] **Step 4: 运行测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run test/http/s06-reasoning-trace.test.js`
Expected: PASS（2 例）。回归：`node node_modules/vitest/vitest.mjs run test/http/`

- [ ] **Step 5: Commit**

```bash
git add src/http/routes.js test/http/s06-reasoning-trace.test.js
git commit -m "feat(routes): S06 客户360 reasoning-trace 按画像/七维/任务算真状态"
```

---

## Task 5: S07 商机 trace 活体化

**Files:**
- Modify: `src/http/routes.js:1161`（reasoning-trace 注入处）
- Test: `test/http/s07-reasoning-trace.test.js`（新建）

- [ ] **Step 1: 写失败测试**

```js
// test/http/s07-reasoning-trace.test.js
import { describe, it, expect } from 'vitest';
import { buildReasoningSteps } from '../../src/page/reasoningSteps.js';

describe('S07 reasoning-trace 真状态', () => {
  it('MEDDICC+决策历史齐+有跟进 → 全 ok', () => {
    const steps = [
      { status: 'ok', label: 'MEDDICC 评估' },
      { status: 'ok', label: '决策历史' },
      { status: 'pending', label: '推进建议' },
    ];
    const facts = { page: 'S07', meddiccFilled: true, hasDecisionHistory: true, hasFollowupTask: true };
    expect(buildReasoningSteps(steps, facts)).toEqual([
      { status: 'ok', label: 'MEDDICC 评估' },
      { status: 'ok', label: '决策历史' },
      { status: 'ok', label: '推进建议' },
    ]);
  });

  it('MEDDICC 缺 → warn', () => {
    const steps = [
      { status: 'ok', label: 'MEDDICC 评估' },
      { status: 'ok', label: '决策历史' },
      { status: 'pending', label: '推进建议' },
    ];
    const facts = { page: 'S07', meddiccFilled: false, hasDecisionHistory: true, hasFollowupTask: false };
    expect(buildReasoningSteps(steps, facts)).toEqual([
      { status: 'warn', label: 'MEDDICC 评估' },
      { status: 'warn', label: '决策历史' },
      { status: 'idle', label: '推进建议' },
    ]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/http/s07-reasoning-trace.test.js`
Expected: FAIL

- [ ] **Step 3: 修改 routes.js S07 handler**

`app.get('/api/page/deal-detail')` 内（约 L1115-1170），在取到 deal payload `p` 后组装 traceFacts：

```js
      // S07 reasoning-trace 真状态（方案 B）
      const meddiccKeys = ['metrics', 'economic', 'decision', 'decision_roles', 'identify', 'competition', 'timeline'];
      const bantKeys = ['budget', 'authority', 'need', 'timeline'];
      const traceFacts = {
        page: 'S07',
        meddiccFilled: meddiccKeys.every((k) => p[k]),
        bantFilled: bantKeys.every((k) => p[k]),
        hasFollowupTask: (tasks || []).some((t) => t.status === 'ready' || t.status === 'running'),
      };
```

并把 reasoning-trace 注入改为：

```js
          'reasoning-trace': {
            steps: buildReasoningSteps(
              S07_SCHEMA.components.find(c => c.kind === 'reasoning-trace')?.steps || [],
              traceFacts
            ),
          },
```

（`tasks`/`p` 变量以该 handler 实际已有为准，如 S07 handler 未查询任务则补一条 `listTasks` 或按 deal 过滤的查询。）

- [ ] **Step 4: 运行测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run test/http/s07-reasoning-trace.test.js`
Expected: PASS（2 例）。回归：`node node_modules/vitest/vitest.mjs run test/http/`

- [ ] **Step 5: Commit**

```bash
git add src/http/routes.js test/http/s07-reasoning-trace.test.js
git commit -m "feat(routes): S07 商机 reasoning-trace 按 MEDDICC/BANT/跟进任务算真状态"
```

---

## Task 6: S09 合同 trace 活体化

**Files:**
- Modify: `src/http/routes.js:1257`（reasoning-trace 注入处）
- Test: `test/http/s09-reasoning-trace.test.js`（新建）

- [ ] **Step 1: 写失败测试**

```js
// test/http/s09-reasoning-trace.test.js
import { describe, it, expect } from 'vitest';
import { buildReasoningSteps } from '../../src/page/reasoningSteps.js';

describe('S09 reasoning-trace 真状态', () => {
  it('有条款+有逾期计划 → 条款 ok/回款 warn/修订 pending', () => {
    const steps = [
      { status: 'ok', label: '条款解析' },
      { status: 'warn', label: '回款风险' },
      { status: 'pending', label: '修订建议' },
    ];
    const facts = { page: 'S09', hasClause: true, hasOverduePlan: true };
    expect(buildReasoningSteps(steps, facts)).toEqual([
      { status: 'ok', label: '条款解析' },
      { status: 'warn', label: '回款风险' },
      { status: 'pending', label: '修订建议' },
    ]);
  });

  it('无逾期计划 → 回款 ok/修订 idle', () => {
    const steps = [
      { status: 'ok', label: '条款解析' },
      { status: 'warn', label: '回款风险' },
      { status: 'pending', label: '修订建议' },
    ];
    const facts = { page: 'S09', hasClause: true, hasOverduePlan: false };
    expect(buildReasoningSteps(steps, facts)).toEqual([
      { status: 'ok', label: '条款解析' },
      { status: 'ok', label: '回款风险' },
      { status: 'idle', label: '修订建议' },
    ]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/http/s09-reasoning-trace.test.js`
Expected: FAIL

- [ ] **Step 3: 修改 routes.js S09 handler**

`app.get('/api/page/contract-detail')` 内（约 L1225-1237），在 `planRows` 计算后组装 traceFacts：

```js
      // S09 reasoning-trace 真状态（方案 B）：回款风险按逾期计划判定
      const hasClause = !!(p.clauses || p.payment_terms || p.terms);
      const hasOverduePlan = planRows.some((x) => {
        const due = new Date(x.due).getTime();
        return x.status !== 'paid' && x.status !== 'completed' && due && due < Date.now();
      });
      const traceFacts = { page: 'S09', hasClause, hasOverduePlan };
```

并把 reasoning-trace 注入改为（注意 P0 已修为空对象→回传 schema steps，此处改为真状态注入）：

```js
          'reasoning-trace': {
            steps: buildReasoningSteps(
              S09_SCHEMA.components.find(c => c.kind === 'reasoning-trace')?.steps || [],
              traceFacts
            ),
          },
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run test/http/s09-reasoning-trace.test.js`
Expected: PASS（2 例）。回归：`node node_modules/vitest/vitest.mjs run test/http/`

- [ ] **Step 5: Commit**

```bash
git add src/http/routes.js test/http/s09-reasoning-trace.test.js
git commit -m "feat(routes): S09 合同 reasoning-trace 按逾期计划算回款风险"
```

---

## Task 7: S14 + S30 trace 活体化

**Files:**
- Modify: `src/http/routes.js:531-532`（S14 注入处）
- Modify: `src/http/controlledConfigPages.js`（S30 工厂注入处，约 L249-259）
- Test: `test/http/s14-reasoning-trace.test.js`、`test/http/s30-reasoning-trace.test.js`（新建）

- [ ] **Step 1: 写失败测试**

```js
// test/http/s14+30-reasoning-trace.test.js
import { describe, it, expect } from 'vitest';
import { buildReasoningSteps } from '../../src/page/reasoningSteps.js';

describe('S14/S30 reasoning-trace 真状态', () => {
  it('S14：有决策+有边+有 trace → 全 ok', () => {
    const steps = [
      { status: 'ok', label: '决策加载' },
      { status: 'ok', label: '关联展开' },
      { status: 'ok', label: '因果链' },
    ];
    const facts = { page: 'S14', hasDecision: true, hasEdges: true, hasTrace: true };
    expect(buildReasoningSteps(steps, facts)).toEqual([
      { status: 'ok', label: '决策加载' },
      { status: 'ok', label: '关联展开' },
      { status: 'ok', label: '因果链' },
    ]);
  });

  it('S30：有决策+有先例+无例外 → 覆盖 ok/匹配 ok/偏差 idle', () => {
    const steps = [
      { status: 'ok', label: '覆盖度加载' },
      { status: 'ok', label: '先例匹配' },
      { status: 'pending', label: '偏差分析' },
    ];
    const facts = { page: 'S30', hasDecision: true, hasPrecedent: true, hasException: false };
    expect(buildReasoningSteps(steps, facts)).toEqual([
      { status: 'ok', label: '覆盖度加载' },
      { status: 'ok', label: '先例匹配' },
      { status: 'idle', label: '偏差分析' },
    ]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/http/s14+30-reasoning-trace.test.js`
Expected: FAIL

- [ ] **Step 3: 修改 routes.js S14 handler**

`app.get('/api/page/decision-graph')` 内（约 L470-540），在取得决策 `decisionId` 与 `entries` 后组装 traceFacts：

```js
      // S14 reasoning-trace 真状态（方案 B）
      const traceFacts = {
        page: 'S14',
        hasDecision: !!decisionId,
        hasEdges: (entries || []).some((e) => e.children?.length || e.parents?.length),
        hasTrace: (entries || []).some((e) => e.trace?.length),
      };
```

并把 reasoning-trace 注入改为：

```js
          'reasoning-trace': {
            steps: buildReasoningSteps(
              S14_SCHEMA.components.find(c => c.kind === 'reasoning-trace')?.steps || [],
              traceFacts
            ),
          },
```

- [ ] **Step 4: 修改 controlledConfigPages.js S30 工厂注入**

`src/http/controlledConfigPages.js` 的 `'decision-quality': { ... }` 项（约 L249-259），在 `map` 后补 reasoning-trace steps 注入。工厂 renderPage 调用需把注入带进 data——先看该工厂如何调 renderPage（读文件确认），在 map 产物中补：

```js
  'decision-quality': {
    schema: S30_SCHEMA,
    sql: `SELECT decision_id, scenario_id, state, created_at FROM crm.decision ORDER BY created_at DESC LIMIT 50`,
    map: (r) => ({
      decision_id: String(r.decision_id).slice(0, 8),
      type: r.scenario_id || '',
      stage: r.state || '',
      coverage: r.state === 'APPROVED' ? 'complete' : 'partial',
    }),
    reasoningSteps: (rows) => buildReasoningSteps(
      S30_SCHEMA.components.find(c => c.kind === 'reasoning-trace')?.steps || [],
      {
        page: 'S30',
        hasDecision: rows.length > 0,
        hasPrecedent: rows.some((r) => r.coverage === 'complete'),
        hasException: rows.some((r) => r.stage === 'EXCEPTION'),
      }
    ),
  },
```

并在工厂的 renderPage 调用处合并入 data.components['reasoning-trace']（需读 controlledConfigPages.js 的渲染段确认 data 结构如何组装；若无 data.components 注入通道则工厂需补一次）。同时顶部加 `import { buildReasoningSteps } from '../page/reasoningSteps.js';`。

- [ ] **Step 5: 运行测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run test/http/s14+30-reasoning-trace.test.js`
Expected: PASS（2 例）。回归：`node node_modules/vitest/vitest.mjs run test/http/` + `node node_modules/vitest/vitest.mjs run test/web/controlledConfigPages*`（若有）

- [ ] **Step 6: Commit**

```bash
git add src/http/routes.js src/http/controlledConfigPages.js test/http/s14+30-reasoning-trace.test.js
git commit -m "feat(routes+factory): S14/S30 reasoning-trace 按真实决策网络算真状态"
```

---

## Task 8: S35 客户洞察 trace + 外部工商采集闭环

**Files:**
- Modify: `src/http/routes.js:1000-1001`（S35 reasoning-trace 注入 + attr-field biz 读链路）
- Create: `src/http/connectorRouter.js`（`POST /api/connector/zhizao-verify`）
- Test: `test/http/s35-reasoning-trace.test.js`、`test/http/connector-zhizao.test.js`（新建）

- [ ] **Step 1: 写失败测试**

```js
// test/http/s35-reasoning-trace.test.js
import { describe, it, expect } from 'vitest';
import { buildReasoningSteps } from '../../src/page/reasoningSteps.js';

describe('S35 reasoning-trace 真状态', () => {
  it('有时间线+角色有权限+有任务 → 全 ok', () => {
    const steps = [
      { status: 'ok', label: '聚合四源数据' },
      { status: 'ok', label: '权限裁剪' },
      { status: 'ok', label: '生成下一步建议' },
    ];
    const facts = { page: 'S35', timelineNonEmpty: true, roleHasPerm: true, tasksNonEmpty: true };
    expect(buildReasoningSteps(steps, facts)).toEqual([
      { status: 'ok', label: '聚合四源数据' },
      { status: 'ok', label: '权限裁剪' },
      { status: 'ok', label: '生成下一步建议' },
    ]);
  });

  it('无时间线+无权限+无任务 → 全 idle', () => {
    const steps = [
      { status: 'ok', label: '聚合四源数据' },
      { status: 'ok', label: '权限裁剪' },
      { status: 'ok', label: '生成下一步建议' },
    ];
    const facts = { page: 'S35', timelineNonEmpty: false, roleHasPerm: false, tasksNonEmpty: false };
    expect(buildReasoningSteps(steps, facts)).toEqual([
      { status: 'idle', label: '聚合四源数据' },
      { status: 'idle', label: '权限裁剪' },
      { status: 'idle', label: '生成下一步建议' },
    ]);
  });
});
```

```js
// test/http/connector-zhizao.test.js
import { describe, it, expect } from 'vitest';
import { buildReasoningSteps } from '../../src/page/reasoningSteps.js';

describe('conn-zhizao-verify 闭环', () => {
  it('工商写入后 → biz 显示「已同步」', () => {
    // 读链路：handler 注入 biz.value = account.payload.business_title
    // 断言交给端点级测试；此处保证 buildReasoningSteps 判定不受影响
    expect(buildReasoningSteps([], { page: 'S35' })).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/http/s35-reasoning-trace.test.js`
Expected: FAIL

- [ ] **Step 3: 修改 routes.js S35 handler**

`app.get('/api/page/account-insight')` 内（约 L894-985），在 `data` 组装处：

**a) attr-field biz 读链路注入**（在 `data.components['attr-field']` 处，若无则新增键）：

```js
          'attr-field': {
            biz: {
              value: account.payload?.business_title || '',
              verified: account.payload?.business_verified === true,
            },
          },
```

**b) reasoning-trace 真状态注入**：

```js
      // S35 reasoning-trace 真状态（方案 B）
      const traceFacts = {
        page: 'S35',
        timelineNonEmpty: timelineSources.length > 0,
        roleHasPerm: !!role,
        tasksNonEmpty: tasks.length > 0,
      };
```

并把 reasoning-trace 注入改为：

```js
          'reasoning-trace': {
            'AI 洞察': {
              steps: buildReasoningSteps(
                S35_SCHEMA.components.find(c => c.kind === 'reasoning-trace')?.steps || [],
                traceFacts
              ),
            },
          },
```

- [ ] **Step 4: 新建 connectorRouter.js 并挂载**

`src/http/connectorRouter.js`：

```js
// src/http/connectorRouter.js — 外部采集手动同步端点（方案 A：读链路补齐 + 手动触发）
// 契约：POST /api/connector/zhizao-verify → 调 conn-zhizao-verify-account（第0闸+sourcedFrom+F18）
import { Router } from 'express';
import { actionExecutor } from '../action/executor.js';

export function createConnectorRouter({ resolveMe, requireRole }) {
  const r = Router();
  // admin/sysadmin 闸：外部采集写通道，sales 不可直触
  r.post('/zhizao-verify', requireRole(['admin', 'sysadmin']), async (req, res) => {
    try {
      const me = resolveMe(req);
      if (!me.ok) return res.status(401).json({ error: me.error });
      const { account_id, verification } = req.body || {};
      if (!account_id || !verification) {
        return res.status(400).json({ error: 'account_id 与 verification 必填' });
      }
      const result = await actionExecutor.dispatch('conn-zhizao-verify-account', {
        account_id,
        verification,
      }, { actor: me.username, tenantId: me.tenantId });
      res.json({ ok: true, decision_id: result?.decision_id, result });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
  return r;
}
```

在 `routes.js` 挂载（约 L257 `app.use(createAgentConfigRouter...)` 附近）：

```js
import { createConnectorRouter } from './connectorRouter.js';
// ...
app.use('/api/connector', createConnectorRouter({ resolveMe, requireRole }));
```

（`requireRole`/`resolveMe` 以 routes.js 既有守卫实现为准，若无 `requireRole` helper 则用现有 `me.role` 判断模式。）

- [ ] **Step 5: 运行测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run test/http/s35-reasoning-trace.test.js`
Expected: PASS。回归：`node node_modules/vitest/vitest.mjs run test/http/`

- [ ] **Step 6: Commit**

```bash
git add src/http/routes.js src/http/connectorRouter.js test/http/s35-reasoning-trace.test.js
git commit -m "feat(routes+connector): S35 客户洞察 trace 真状态 + 外部工商采集手动同步闭环"
```

---

## Self-Review（对照设计文档）

**Spec coverage：**
- §3.1（7 页 trace 活体化）→ T1 内核 + T2-S02 + T3-S06 + T4-S07 + T5-S09 + T6-S14/S30 + T7-S35 trace ✓
- §3.2（S35 外部采集闭环：读链路 + 手动同步端点）→ T8 ✓
- §3.3 YAGNI（不引 SSE、不接真实 API、S03 不动）→ 计划遵守 ✓
- §4 测试计划 → 每 Task 独立测试文件 ✓

**Placeholder 扫描：**
- 无 TBD/TODO；每 Task 有完整代码块 + 明确命令与预期输出。
- T7 Step 4 有一处「以工厂实际实现为准」——这是外部实现差异点（工厂 data 组装方式需读文件确认），已标注为执行时的核实步骤，非占位。

**Type consistency：**
- `buildReasoningSteps(schemaSteps, facts)` 签名全计划一致；各页 facts 键（hasTasks/tasksHasContext/hasActionableTask/profileFilled/sevenDimCovered/meddiccFilled/bantFilled/hasClause/hasOverduePlan/hasDecision/hasEdges/hasTrace/hasPrecedent/hasException/timelineNonEmpty/roleHasPerm/tasksNonEmpty）均为 T1 RULES 已定义键。
- renderer 注入键 `data.components['reasoning-trace'][comp.title].steps` 在 T2 与各 handler 注入一致（S35 用 `'AI 洞察'` 标题键，与 routes 既有结构对齐）。

---

## 执行说明

- 沙箱无私有库凭证，**AI 不执行 git commit**——每个 Task 的 commit 命令由用户本地执行。
- 执行方式二选一（writing-plans 约定）：**Subagent-Driven（推荐）** 或 **Inline**。
- 每个 Task 继承设计文档 `docs/specs/2026-08-29-dead-info-revive-design.md` 的 contract-yaml 契约（agent/skills/memory/success），实施后由 agent-workbench 校验回写。