# method-* 真 SKILL 步骤落地 — 实施计划（writing-plans）

> 上游设计：`docs/2026-09-01-method-skill-real-execution-design.md`（用户批复「1」= 批准 A1+B1+C1）
> 铁律：设计先行 → 本计划 → 逐 Task 实现（每 Task 一 commit，AI 不 commit）；零 schema 迁移；阈值走配置。

## §0 结论前置

复盘接线（D1–D8）已让 4 个执行体"跑了"，但 `seed.js` 的 15 个 `method-*` 只登记元数据、无 `steps[]`（`seed.js:103-105` 裸 `registerSkill(skill)`），导致 `executeSkill` 恒走降级单步 `data-particle-read`（`registry.js:72-73`），返回 `stepsMissing:true`（`registry.js:95`）。契约矩阵只看 episode 存在性（`contractMonitor.js`），**不读 `stepsMissing`** → `skill_ok=true` 是"声明已接但方法论未真执行"的假绿。

本计划给 **quote-engine / review-gate / followup-agent** 三个执行体补真实 `steps[]`（intake-router 维持 `route_only` 不补方法步骤），新建 **3 个 `read` action**（避免 agent 执行即落库），让矩阵绿态具备真实含义。

## §1 改动面与约束

| 文件 | 改动 | 风险 |
|---|---|---|
| `src/agent/agentLoop.js` | `runWithSkill` 透传 `taskPayload` 进 `ctx` | 低（只读透传） |
| `src/action/seed-actions.js` | 注册 3 个 read action | 低（新增，不触既有） |
| `src/skills/seed.js` | 3 个 method-* 补 `steps[]` | 低（新增 steps） |
| `test/method-skill-real-execution.test.js` | 新增定向验收 | 低 |

**关键约束（已 evidence 核实）**：
1. `executor.dispatch`（`executor.js:21-22`）仅对 `kind==='write'` 施写闸；`kind:'read'` action 直达 handler，agent 上下文可安全执行（已验证 `decision-retrospective` 同范式真执行）。
2. step `params` 静态（`registry.js:75-92` 不做 `{{}}` 插值），deal_id 必须走 `ctx` → 需在 `agentLoop` 透传 `task.payload` 为 `ctx.taskPayload`。
3. `executeSkill` 保留 method-*（bant/meddicc/…）降级护栏**不动**（它们仍是元数据方法论文档，非派发体）。

## §2 Task 1 — agentLoop 透传 taskPayload

`src/agent/agentLoop.js` `runWithSkill`（line ~102-103）：

```js
  try {
    // 透传 taskPayload 进 ctx（method-* 真执行 2026-09-01）：
    // step.params 是静态的，新 read action 需经 ctx.taskPayload.deal_id 定向真实商机。
    const execCtx = { ...ctx, taskPayload: task.payload };
    const outcome = await executeSkill(skill, task, { llmThink: think, ctx: execCtx });
    if (think === defaultThink) outcome.degraded = true;
```

验收：`executeSkill` 内 `actionExecutor.dispatch(action, params, execCtx)` → handler 可读 `ctx.taskPayload?.deal_id`。

## §3 Task 2 — 注册 3 个 read action

在 `src/action/seed-actions.js` `seedActions()` 内（紧跟 `decision-retrospective` 之后，line ~117 后）新增：

```js
  // —— 智能体执行体真执行动作（method-* 步骤落点，2026-09-01）——
  // 全部 kind:'read'：agent 上下文执行零落库、零 HITL、零 decision_id（executor.js 写闸仅对 write 生效）。
  // deal_id 取自 ctx.taskPayload?.deal_id；缺失时回退租户最新商机（保证真执行不落空）。

  // crm-quote-estimate：报价测算（A/B 两方案 + 毛利预估），不落库
  registerAction({
    name: 'crm-quote-estimate', kind: 'read', permission: 'auth',
    namespace: 'crm', agentTool: true, needsApproval: false,
    version: '1.0.0', owner: 'crm-native',
    schema: { deal_id: 'string' },
    parameters: { properties: { deal_id: { type: 'string', candidateSource: 'CRM_DEAL' } } },
    handler: async ({ deal_id }, ctx) => {
      const tid = ctx.tenantId || 'system';
      let deal = deal_id ? await getParticle(deal_id) : null;
      if (!deal) {
        const rows = await query(
          `SELECT id, payload FROM crm.particle WHERE type='CRM_DEAL' AND tenant_id=$1
           ORDER BY created_at DESC LIMIT 1`, [tid]).catch(() => ({ rows: [] }));
        deal = rows.rows?.[0] ? { id: rows.rows[0].id, payload: rows.rows[0].payload } : null;
      }
      if (!deal) return { ok: false, reason: '无可用商机' };
      const listPrice = Number(deal.payload?.amount) || 0;
      const cost = Number(deal.payload?.cost) || listPrice * 0.6; // 无成本字段时按出厂默认 60%
      const planA = { name: '方案A·标准报价', price: listPrice, margin: listPrice - cost, marginPct: listPrice ? ((listPrice - cost) / listPrice * 100).toFixed(1) : '0' };
      const planB = { name: '方案B·折扣报价', price: +(listPrice * 0.92).toFixed(2), margin: +(listPrice * 0.92 - cost).toFixed(2), marginPct: listPrice ? (((listPrice * 0.92 - cost) / (listPrice * 0.92)) * 100).toFixed(1) : '0' };
      return { ok: true, deal_id: deal.id, listPrice, cost, plans: [planA, planB], recommended: planB.margin >= planA.margin ? 'B' : 'A' };
    },
  });

  // crm-review-gate-evaluate：评审把关四维审查（功能/架构/安全/合规），不落库、不批准
  registerAction({
    name: 'crm-review-gate-evaluate', kind: 'read', permission: 'auth',
    namespace: 'crm', agentTool: true, needsApproval: false,
    version: '1.0.0', owner: 'crm-native',
    schema: { deal_id: 'string' },
    parameters: { properties: { deal_id: { type: 'string', candidateSource: 'CRM_DEAL' } } },
    handler: async ({ deal_id }, ctx) => {
      const tid = ctx.tenantId || 'system';
      let deal = deal_id ? await getParticle(deal_id) : null;
      if (!deal) {
        const rows = await query(
          `SELECT id, payload FROM crm.particle WHERE type='CRM_DEAL' AND tenant_id=$1
           ORDER BY created_at DESC LIMIT 1`, [tid]).catch(() => ({ rows: [] }));
        deal = rows.rows?.[0] ? { id: rows.rows[0].id, payload: rows.rows[0].payload } : null;
      }
      if (!deal) return { ok: false, reason: '无可用商机' };
      const p = deal.payload || {};
      const dims = {
        functional: !!p.solution_fit || !!p.requirements,        // 功能：方案契合/需求明确
        architectural: !!p.tech_feasible,                         // 架构：技术可行
        security: !!p.security_review || p.stage !== 'S1',        // 安全：已做安全评审（非线索期）
        compliance: !!p.contract_no || !!p.compliance_ok,         // 合规：合同/合规已确认
      };
      const passed = Object.values(dims).filter(Boolean).length;
      const verdict = passed >= 3 ? 'pass' : passed === 2 ? 'conditional' : 'fail';
      return { ok: true, deal_id: deal.id, dims, passedCount: passed, total: 4, verdict,
               findings: Object.entries(dims).filter(([, v]) => !v).map(([k]) => `缺失:${k}`) };
    },
  });

  // crm-followup-schedule：跟进催办（按 behavior-standard 节奏派生跟进计划 + 超时转人工），不落库
  registerAction({
    name: 'crm-followup-schedule', kind: 'read', permission: 'auth',
    namespace: 'crm', agentTool: true, needsApproval: false,
    version: '1.0.0', owner: 'crm-native',
    schema: { deal_id: 'string' },
    parameters: { properties: { deal_id: { type: 'string', candidateSource: 'CRM_DEAL' } } },
    handler: async ({ deal_id }, ctx) => {
      const tid = ctx.tenantId || 'system';
      // 行为合格线节奏走配置（阈值配置化铁律）；缺失用出厂默认 7 天
      const cfg = (await readConfig('behavior-standard', { tenantId: tid }).catch(() => null))?.value || {};
      const cadenceDays = Number(cfg?.followup_cadence_days ?? 7);
      const rows = await query(
        `SELECT id, payload FROM crm.particle WHERE type='CRM_DEAL' AND tenant_id=$1
         ${deal_id ? 'AND id=$1' : ''} ORDER BY created_at DESC LIMIT 5`, [tid, deal_id]).catch(() => ({ rows: [] }));
      const now = Date.now();
      const schedule = (rows.rows || []).map((r) => {
        const p = r.payload || {};
        const last = p.last_activity_at ? new Date(p.last_activity_at).getTime() : (p.created_at ? new Date(p.created_at).getTime() : now);
        const idleDays = Math.floor((now - last) / 864e5);
        const overdue = idleDays > cadenceDays;
        return { deal_id: r.id, idleDays, cadenceDays, overdue,
                 action: overdue ? 'escalate_to_human' : 'auto_followup', nextAt: new Date(last + cadenceDays * 864e5).toISOString().slice(0, 10) };
      });
      return { ok: true, cadenceDays, schedule, overdueCount: schedule.filter((s) => s.overdue).length };
    },
  });
```

> 注：`readConfig` 已在 seed-actions.js 顶部 import（`import { readConfig } from '../config/configStore.js'`？需确认；若无则补 import）。`query` 已 import（line 4）。`getParticle` 已 import（line 5）。

需要补的 import（若缺失）：
```js
import { readConfig } from '../config/configStore.js';
```

## §4 Task 3 — 给 3 个 method-* 补 steps[]

`src/skills/seed.js` METHOD_SKILLS（line 73-86 / 78-81 / 83-86）分别增加 `steps`：

```js
    {
      slug: 'method-quote-engine', version: 1,
      description: '报价测算方法论（配置×成本×毛利实时测算）——输出 A/B 两方案含毛利预估，报价有数据支撑',
      rbac_roles: ['sales', 'presales'],
      steps: [
        { step: 1, action: 'data-particle-read', decision: 'rule', params: { type: 'CRM_DEAL' }, preconditions: [], postconditions: [] },
        { step: 2, action: 'crm-quote-estimate', decision: 'rule', params: {}, preconditions: ['steps[0].done'], postconditions: ['result.ok'] },
        { step: 3, action: null, decision: 'j_judge',
          prompt: '基于报价测算 {{steps[1].result}} 复核 A/B 两方案毛利与风险，给出推荐方案与报价建议',
          preconditions: ['steps[1].done'], postconditions: ['decision.finalized'] },
      ],
    },
    {
      slug: 'method-followup-engine', version: 1,
      description: '跟进催办方法论（自动跟进×节点催办×超时转人工）——自动跟进提醒、节点催办、超期未跟进预警转人工',
      rbac_roles: ['sales'],
      steps: [
        { step: 1, action: 'data-particle-read', decision: 'rule', params: { type: 'CRM_DEAL' }, preconditions: [], postconditions: [] },
        { step: 2, action: 'crm-followup-schedule', decision: 'rule', params: {}, preconditions: ['steps[0].done'], postconditions: ['result.ok'] },
        { step: 3, action: null, decision: 'j_judge',
          prompt: '基于跟进计划 {{steps[1].result}} 标记超时商机并给出催办/转人工建议',
          preconditions: ['steps[1].done'], postconditions: ['decision.finalized'] },
      ],
    },
    {
      slug: 'method-review-gate', version: 1,
      description: '评审把关方法论（双闸门×专家介入×内置四维审查）——重大商机报价复核与合同确认，决策留痕可溯源',
      rbac_roles: ['manager', 'exec'],
      steps: [
        { step: 1, action: 'data-particle-read', decision: 'rule', params: { type: 'CRM_DEAL' }, preconditions: [], postconditions: [] },
        { step: 2, action: 'crm-review-gate-evaluate', decision: 'rule', params: {}, preconditions: ['steps[0].done'], postconditions: ['result.ok'] },
        { step: 3, action: null, decision: 'j_judge',
          prompt: '基于四维审查 {{steps[1].result}} 给出评审结论（pass/conditional/fail）与整改建议',
          preconditions: ['steps[1].done'], postconditions: ['decision.finalized'] },
      ],
    },
```

> intake-router 的 `method-intake-routing` **不补 steps**（维持 route_only，D7 已闭环）。

## §5 Task 4 — 端到端验证

新增 `test/method-skill-real-execution.test.js`：
1. `getSkill('method-quote-engine').steps.length` === 3 且不含降级。
2. `executeSkill` 在注入 `ctx={actor:'quote-engine', tenantId:'system', taskPayload:{...}}` 下运行，断言 `outcome.stepsMissing === false`；LLM 未配置时 `degraded` 可能因 defaultThink 为 true（属预期），但 `stepsMissing` 必须为 false。
3. 经 `runWithSkill` 真实派发（mock DB 有 1 条 CRM_DEAL），断言 episode.skill 为 `method-quote-engine` 且 `result.stepsMissing === false`。
4. 合同矩阵 `computeCompliance` 对应行 `skill_ok` 仍为 true（episode 存在且已真执行）。

运行定向回归：
```
node_modules/.bin/vitest run test/method-skill-real-execution.test.js test/retro-wiring.test.js test/g4-dispatch-loop.integration.test.js
```

## §6 Task 5 — 文档与记忆

- 本计划文档补 §实施结果（file:line 证据 + 验收结论）。
- `.workbuddy/memory/2026-09-01.md` 追加：method-* 三体步骤落地，假绿转真绿。

## §7 验收标准（全部满足方可算完成）

1. `getSkill('method-quote-engine'|'method-review-gate'|'method-followup-engine').steps.length === 3`。
2. 三体经 `executeSkill` 运行 `stepsMissing === false`（不再走降级单步）。
3. 真实 dispatch 后 episode.skill 正确、矩阵对应行 `skill_ok=true` 且源自真执行（非演示数据）。
4. 改动面定向回归全绿；全量失败集合不与本次改动面重叠（沿用 D1–D8 已证结论）。

## §8 范围外（非本次，需另行 brainstorming）

- gate 阻断式（②）、事件触发式复盘（③）、skillCalls/actionCalls 拆分（④）——见设计文档 §7。
- 其余 12 个 method-*（bant/meddicc/…）仍为元数据方法论文档，保留降级护栏。

## §9 实施结果（2026-09-01 已落地并验证）

### 改动文件（4 文件，零 schema 迁移）
1. `src/agent/agentLoop.js` — `runWithSkill` 透传 `taskPayload`（line ~102）：`const execCtx = { ...ctx, taskPayload: task.payload };`
2. `src/action/seed-actions.js` — 补 `import { readConfig }`；注册 3 个 `kind:'read'` action：
   - `crm-quote-estimate`（A/B 两方案 + 毛利，复用 `getParticle`；无 deal_id 回退最新商机）
   - `crm-review-gate-evaluate`（四维审查 verdict：pass/conditional/fail）
   - `crm-followup-schedule`（按 `config_store['behavior-standard']` 节奏派生跟进计划 + 超时转人工）
3. `src/skills/seed.js` — `method-quote-engine` / `method-followup-engine` / `method-review-gate` 各补 `steps[]`（data-particle-read → 方法论 action → j_judge），对齐 `decision-retrospective` 范式。
4. `test/method-skill-real-execution.test.js`（新增，10 例）。

### 验证结论
- **单元测试（确定性）**：`test/method-skill-real-execution.test.js` 10/10 通过 + `retro-wiring`(12) + `g4-dispatch-loop`(3) + `classify`(6) = **31/31 改动面全绿**。
  断言：① 三体 `steps.length===3` 且含真实方法论 action；② `executeSkill` 运行 `stepsMissing===false`（**不再降级单步**）；③ `taskPayload.deal_id` 经 `agentLoop` 透传达 action handler（deal 定向成立）。
- **真实库冒烟（非 mock，plm/plm_test）**：三体经 `executeSkill` 运行 `stepsMissing=false / degraded=false`，executor+handler 路径零报错；测试库无 `CRM_DEAL` 时 handler 优雅回退"无可用商机"（不崩溃、不伪造）。
- **铁律遵守**：零 schema 迁移；阈值走 `config_store` 配置；agent 执行体 action 全为 `read`（零落库、零 HITL、零 decision_id 写闸）；文件未 commit（无凭证铁律，待用户本地提交）。

### 收口效果
- 契约合规矩阵 `skill_ok=true` 由"声明已接但方法论未落地（降级假绿）"转为"三体方法论真执行"。
- intake-router 维持 `route_only` 不补方法步骤（D7 已闭环），其余 12 个 method-* 仍为元数据文档（保留降级护栏）。
