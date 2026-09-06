# 单决策穿透追溯 + 字段全落库 — 测试计划

- 日期：2026-08-30
- 配套设计：`docs/2026-08-30-decision-drillthrough-design.md`（已批准）
- 配套开发计划：`docs/superpowers/plans/2026-08-30-decision-drillthrough-dev-plan.md`
- 关联：`docs/2026-08-30-semantica-decision-accountability-design.md`（C-DAI v2，三图闭环底座）、`2026-08-30-cdai-test-plan.md` / `2026-08-30-cdai-dev-plan.md`
- 状态：待执行（批准后按 TDD 实施）

---

## §1 当前状态对账（运行库 vs schema.sql vs 测试库）

> 关键结论：运行库 `plm` 落后于 `db/schema.sql`，导致三图闭包仅 40% 闭合。本计划所有"迁移"任务本质是**让运行库与 schema.sql 对齐**，并补齐 `seed-test-config.mjs` 的两步缺口。

| 项目 | 运行库 `plm`（探测 12:12） | `db/schema.sql` | 测试库 `plm_test`（预期） | 处置 |
|---|---|---|---|---|
| `decision.confidence/root_cause/feedback` | **缺失** | 已定义 `:531-538` (`ADD COLUMN IF NOT EXISTS`) | 取决于 plm_test 是否从当前 schema 建 | **T-D1** 补 `ensureDecisionColumns` 步骤 |
| `decision_relation` 表 | **不存在**（relation does not exist） | 已定义 `:490-504` | 取决于历史迁移 | **T-D2** 补 `ensureDecisionRelationTables` 步骤 |
| `decision_outcome` 表 | **不存在** | 已定义 `:507-519` | 取决于历史迁移 | **T-D3** 同上 |
| `createDecision` INSERT | 漏写 confidence/feedback/root_cause（`decisionRepo.js:68-79`） | — | — | **T-D1** 修复 INSERT |
| `attribution` 状态 | 3 态（`attribution.js:14-21`） | — | — | **T-D4** 扩 7 态 |
| `computeConfidence` | **已存在**（`confidence.js:4-14`，纯函数） | — | — | **T-D1** 直接接入，不重写 |
| `GET /api/decision/:id/closure` | 不存在 | — | — | **T-D6** 新建 |
| 前端三图闭环页签 | 无（`openDnModal` 仅决策网络） | — | — | **T-D7** 新建 |

**测试库初始化约定（证据）**：`vitest.config.js:9` 强制 `PGDATABASE=plm_test`；`package.json:12` `pretest` 跑 `scripts/seed-test-config.mjs`（幂等建表/补列，不直接跑 schema.sql 全量）。因此**新增表/列必须加进 `seed-test-config.mjs` 的步骤**，否则测试库无表→测试 RED 假象。

---

## §2 测试策略与约定

1. **TDD 红-绿**：每任务先写失败测试 → 实现 → 验证转绿 → 提交（每任务一 commit，由用户本地执行）。
2. **测试库隔离**：连 `plm_test`（`agent2b@127.0.0.1:5433`）。`beforeEach` TRUNCATE 本任务相关表（`decision`/`decision_relation`/`decision_outcome`/`attribution`/`memory_log`/`calibration_patch`），**严禁 TRUNCATE 业务库 plm**。
3. **单进程**：禁止并发两个 vitest（记忆铁律：互 TRUNCATE 同库伪失败）。
4. **鉴权**：closure 端点过 `requireMe`（`routes.js:1792`，读 `authorization` 头）。测试用 `auth.js:login({username:'alice',password:'secret123'})` 取 token，再 `app.fetch(path,{headers:{authorization:'Bearer '+token}})`。
5. **断言风格**：数据面断言优先（JSON 字段），HTML 断言仅校验受控渲染产物存在（`pg-page`/`panel`/`card`），不依赖具体文案硬编码。
6. **复跑性**：seed demo（T-D8）用固定 UUID + `ON CONFLICT DO NOTHING`，幂等可重跑。

---

## §3 两维度测试矩阵（复用 C-DAI v2 §7 框架）

### 3.1 维度一：三闭环运作（感知→应用→反馈）测试点

| 闭环 | 感知（建） | 应用（用） | 反馈（进化） |
|---|---|---|---|
| **K 知识** | T-D5 写时非空守卫（trigger_context 非空才落） | T-D1 involved_entities→particles 解析 | — |
| **M 上下文** | T-D1 confidence/root_cause/feedback 落库；T-D2 decision_relation 7 边写库 | T-D6 M 区返回 conditions_evaluated/policy_version/decision_relation | T-D4 attribution 七态 + edge_compliance |
| **J 决策** | T-D1 createDecision 写入 confidence(反算) | T-D6 J 区返回 decision+outcome+calibration | T-D3 outcome 写回；T-D8 闭环种子 |

### 3.2 维度二：跨环数据传递（D1–D5）+ 反馈溯源测试点

| 映射 | 测试断言 |
|---|---|
| **D1 K→M** | createDecision 后 `decision.involved_entities` 非空且指向 `particles` 真实 ID |
| **D2 M→J** | closure 的 `crossLoopMap.D2.exists===true`；M 区 conditions_evaluated 非空 → J 判定有情境 |
| **D3 J→K** | T-D8 demo 后 `calibration_patch` 经第0闸写回 `meta_attr`/`edge_bindings`，closure `D3.exists===true` |
| **D4 J→M** | T-D3 outcome 写入 `decision_outcome`；closure `D4.exists===true`；记忆区出现反馈沉淀 |
| **D5 K↔M** | `meta_attr.required`/`source_refresh_sla` 写时约束生效（T-D5 守卫） |
| **溯源链** | closure 返回 `provenance` 链（SHA-256，`provenance.js`）+ `decision_relation` E1–E7（含 `serves_dimension`）|

---

## §4 逐任务测试套件（失败测试骨架）

### T-D1 字段全落库 + INSERT 修复
```js
// test/decision/drillthrough-fields.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { createDecision } from '../../src/decision/decisionRepo.js';
import { query } from '../../src/db.js';

beforeEach(async () => {
  await query('TRUNCATE crm.decision, crm.decision_provenance RESTART IDENTITY CASCADE');
});

it('createDecision 物化 confidence（反算）与 root_cause/feedback/feedback_link', async () => {
  const d = await createDecision({
    scenario_id: 'OPP_QUALIFY', disposition: 'APPROVED',
    trigger_context: { a: 1 }, involved_entities: [], conditions_evaluated: [],
    rationale: 'r', outcome_verified: 'won',
    feedback: '客户确认', feedback_link: 'https://x/y', root_cause: { type: 'PRICE' },
  });
  expect(typeof d.confidence).toBe('number');
  expect(d.confidence).toBeCloseTo(0.9);           // computeConfidence: outcomeVerified='won'→0.9
  expect(d.root_cause).toMatchObject({ type: 'PRICE' });
  expect(d.feedback).toBe('客户确认');
  expect(d.feedback_link).toBe('https://x/y');
});

it('置信度缺业务信号时回退 0.6（不脑补）', async () => {
  const d = await createDecision({ scenario_id:'OPP_QUALIFY', disposition:'APPROVED',
    trigger_context:{}, involved_entities:[], conditions_evaluated:[], rationale:'r' });
  expect(d.confidence).toBeCloseTo(0.6);
});
```

### T-D2 decision_relation 表 + 7 边写库（D2 承载）
```js
// test/decision/decision-relation.test.js
it('createDecision 写 DECIDED_ON 边到 decision_relation（serves_dimension 绑定）', async () => {
  const d = await createDecision({ scenario_id:'OPP_QUALIFY', disposition:'APPROVED',
    trigger_context:{dim:'B'}, involved_entities:[{type:'CRM_DEAL',id:'deal-1'}],
    conditions_evaluated:[], rationale:'r' });
  const rows = await query('SELECT rel_type, serves_dimension FROM crm.decision_relation WHERE from_id=$1', [d.decision_id]);
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.some(r => r.rel_type==='DECIDED_ON')).toBe(true);
});
it('closure D2 标记 exists 当 decision_relation 存在', async () => { /* 调 closure 断言 crossLoopMap.D2.exists */ });
```

### T-D3 decision_outcome 表（D4 承载）
```js
// test/decision/decision-outcome.test.js
it('J2 反馈写入 decision_outcome，closure D4.exists===true', async () => {
  const d = await createDecision({ scenario_id:'OPP_QUALIFY', disposition:'APPROVED',
    trigger_context:{}, involved_entities:[], conditions_evaluated:[], rationale:'r' });
  await query(`INSERT INTO crm.decision_outcome (decision_id, outcome_type, outcome_detail)
    VALUES ($1,'business_win', '{"amount":100}')`, [d.decision_id]);
  // closure 断言
  const closure = await fetchClosure(d.decision_id, token);
  expect(closure.crossLoopMap.D4.exists).toBe(true);
  expect(closure.j.outcome).toBeDefined();
});
```

### T-D4 attribution 七态 + edge_compliance
```js
// test/monitor/attribution.test.js
it('computeAttribution 返回七态 category + E1-E7 edge_compliance', async () => {
  const a = await computeAttribution({ scenario_id:'OPP_QUALIFY', trigger_context:{dimA:1}, query });
  expect(['COMPLETE','PARTIAL','MISSING_CONTEXT','CONFLICT','WEAK','STALE','OVERRIDDEN']).toContain(a.category);
  expect(a.edge_compliance).toHaveProperty('E1');   // 应存/实存/缺 三态之一
});
```

### T-D5 写时非空守卫
```js
it('createDecision 拦截 trigger_context 为空（T-D5 守卫）', async () => {
  await expect(createDecision({ scenario_id:'OPP_QUALIFY', disposition:'APPROVED',
    trigger_context:{}, involved_entities:[], conditions_evaluated:[], rationale:'r' }))
    .rejects.toThrow(/missing|empty|context/i);
});
it('conditions_evaluated 空亦拦截', async () => { /* 同上，置 trigger_context 非空、conditions 空 */ });
```

### T-D6 closure 聚合端点（核心）
```js
// test/http/decision-closure.test.js
import { createApp } from '../../src/http/server.js';
import { login } from '../../src/http/auth.js';
let app, token;
beforeAll(async () => { app = createApp(); const r = await login({username:'alice',password:'secret123'}); token = r.token; });

it('GET /api/decision/:id/closure 返回 K/M/J 三区 + crossLoopMap D1-D5', async () => {
  const d = await createDecision({ scenario_id:'OPP_QUALIFY', disposition:'APPROVED',
    trigger_context:{dim:'B'}, involved_entities:[{type:'CRM_DEAL',id:'deal-1'}],
    conditions_evaluated:[{name:'x',met:true}], rationale:'r', outcome_verified:'won' });
  const res = await app.fetch(`/api/decision/${d.decision_id}/closure`,
    { headers:{ authorization:'Bearer '+token } });
  expect(res.status).toBe(200);
  const b = await res.json();
  expect(b.k).toBeDefined(); expect(b.m).toBeDefined(); expect(b.j).toBeDefined();
  expect(b.crossLoopMap).toHaveProperty('D1'); expect(b.crossLoopMap).toHaveProperty('D5');
});

it('closure 未登录返回 401（G7 鉴权）', async () => {
  const d = await createDecision({ scenario_id:'OPP_QUALIFY', disposition:'APPROVED',
    trigger_context:{dim:'B'}, involved_entities:[], conditions_evaluated:[], rationale:'r' });
  const res = await app.fetch(`/api/decision/${d.decision_id}/closure`);
  expect(res.status).toBe(401);
});

it('crossLoopMap 正确标断点（无 outcome 时 D4.exists=false）', async () => {
  const d = await createDecision({ scenario_id:'OPP_QUALIFY', disposition:'APPROVED',
    trigger_context:{dim:'B'}, involved_entities:[], conditions_evaluated:[], rationale:'r' });
  const b = await (await app.fetch(`/api/decision/${d.decision_id}/closure`,
    { headers:{ authorization:'Bearer '+token } })).json();
  expect(b.crossLoopMap.D4.exists).toBe(false);
});
```

### T-D7 前端三图闭环页签（受控渲染）
```js
// test/web/decision-drillthrough-ui.test.js
it('/sales-decision-monitor 静态页可访问且注入 tokens.css', async () => {
  const res = await app.fetch('/sales-decision-monitor.html');
  const html = await res.text();
  expect(res.status).toBe(200);
  expect(html).toContain('page.css');          // 零硬编码铁律：必须链 tokens.css
});
it('openDnModal 三图闭环页签调用 closure 且渲染 K/M/J 三区容器', async () => { /* jsdom 或端到端：断言 #tab-three-loop 存在、调 /closure、零硬编码色值 */ });
```

### T-D8 端到端闭环 demo 种子
```js
// test/decision/closed-loop-demo.test.js
it('seed 决策使 D1-D5 全部 exists===true（闭包 100%）', async () => {
  await seedClosedLoopDemo();   // scripts/seed-closed-loop-demo.mjs
  const d = await query('SELECT decision_id FROM crm.decision WHERE scenario_id=$1',['CLOSED_LOOP_DEMO']);
  const b = await fetchClosure(d.rows[0].decision_id, token);
  for (const k of ['D1','D2','D3','D4','D5']) expect(b.crossLoopMap[k].exists).toBe(true);
});
```

---

## §5 验收闸（全绿判据）

1. `npm test` 运行本计划 8 套件全绿（单进程）。
2. T-D1：confidence 反算正确（won→0.9 / 缺→0.6），root_cause/feedback/feedback_link 落库。
3. T-D2/T-D3：两表在 plm_test 经 `seed-test-config` 幂等建表；边/反馈可写可查。
4. T-D4：attribution 七态 + E1–E7 `edge_compliance` 全部返回。
5. T-D5：空 trigger_context / 空 conditions_evaluated 被拦截（报 missing_context）。
6. T-D6：closure 端点返 K/M/J + D1–D5；未登录 401。
7. T-D7：前端三图页签存在、调 closure、零硬编码。
8. T-D8：demo 决策使 D1–D5 全 `exists`（闭包 100%），且 `npm run migrate` 后生产库 `plm` 三表/列对齐 schema.sql。

---

## §6 与在途文档交叉引用

- 并入 C-DAI 开发计划 **T1/T2/T3/T11/T12**，新增 **T-D6/T-D7/T-D8**（closure 端点 / 三图页签 / 闭环种子）。
- 与 j2-j3 详细设计 **T15–T32**（J2 outcome 消费 / J3 校准写回）对齐：本项目 T-D3 提供 `decision_outcome` 落库基座，T-D8 提供首个闭环证据。
- 与全链路溯源设计 **E1–E7 × 维度**：T-D2 `decision_relation.serves_dimension` 直接承载。
