# 统一术语 S1-S8 + 分业务审批 + AI/人把关 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把方法论/数据库/审批流/人机协同四层术语统一为 S1-S8，激活第 3.5 阶段闸（死代码接线），落地分业务审批规则 R1-R4（AI 判定 CONDITION 节点 + 人把关 APPROVER 节点），并修复审批引擎两缺口（节点推进 + 条件路由）。

**Architecture:** 新增 `src/sales/stageTaxonomy.js` 作为 S 码单一事实源；`payload.stage` 由英文（`lead/...`）纯重命名为 `S1-S8`；`salesStageGate`（executor 第 3.5 闸）改用真实 S 码匹配；审批引擎 `engine.js` 抽出 `materializeNode`/`advanceToNextNode` 修复节点推进与 CONDITION 路由；新增 `ruleResolver.js`（R1-R4 分档审批链）、`funnelKpi.js`（漏斗转化率 KPI）；阈值全走 `config_store`（`sales-thresholds` / `approval-thresholds` / `funnel-kpi`），不硬编码。

**Tech Stack:** Node 22 + ESM + PostgreSQL 16（`plm` @5433, schema `crm`）；Express；vitest 3；既有 `src/approval/*` 引擎与 `scripts/seed-approval-demo.mjs` 模拟框架。

**设计文档（已批准）：** `docs/2026-08-31-unified-s-taxonomy-approval-design.md`

---

## File Structure（改动清单）

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/sales/stageTaxonomy.js` | Create | S 码单一事实源：S_STAGES / S_LABEL / S_ALIAS / S_TRANSITIONS / S_GATE_DEFS / toStageCode / fromStageCode |
| `src/particles/particleModel.js` | Modify:11 | `CRM_DEAL.states.flow` 改读 S1-S8 |
| `src/particles/lifecycle.js` | Modify | `advanceStage` 兼容 S 码 + 阶段门禁 G-S3/G-S5 硬闸 |
| `src/action/executor.js` | Modify:177-303 | `STAGE_GATES` 改 S 码；`salesStageGate` 支持 required_attachments 硬门禁 |
| `src/action/seed-actions.js` | Modify:13-16 | `STAGE_SCENARIO` 键改 S1-S8；`crm-deal-advance` 触发 `ruleResolver` |
| `src/approval/engine.js` | Modify | 抽 `materializeNode`/`advanceToNextNode`，修复 B1（节点推进）+ C1（CONDITION 路由） |
| `src/approval/ruleResolver.js` | Create | `resolveApprovalChain`：R1-R4 + 金额分档 T1/T2/T3 → 审批链拓扑 |
| `src/sales/funnelKpi.js` | Create | `funnelConversionRates`：按 S 跃迁事件算转化率 + 健康线比对 |
| `src/sales/salesThresholds.js` | Modify | DEFAULT 增 `approval` 分档键、`funnel-kpi` 健康线键 |
| `src/http/salesThresholdsRouter.js` | Modify | RULES 增 `approval.*` / `funnel-kpi.*` 校验 |
| `db/seed.sql` | Modify:286-296 | `approval_flow` 4 行改 R1-R4（from_stage/to_stage） |
| `scripts/migrate-stage-s.mjs` | Create | 8 条幂等 UPDATE：`payload.stage` 英文→S1-S8（无 DELETE） |
| `scripts/seed-approval-rules.mjs` | Create | 幂等落 R1-R4 引擎流拓扑（START→COND→APP1/APP2 + 分档） |
| `scripts/seed-approval-demo.mjs` | Modify | 扩展 S 码种子 + R1-R4 模拟 + 五闸/门禁/分级/漏斗用例 |
| `skills/method-stage-progression/{methodology.json,references/stages.md,rules/gates.md}` | Modify | P1-P6 → S1-S6 |
| `skills/method-funnel-classification/**` `skills/method-behavior-standard/**` `skills/method-opportunity-matrix/**` | Modify | P1-P6 引用 → S1-S6 |
| `test/action/sales-executor-gate.test.js` | Modify/Create | S 码五闸 + 门禁断言 |
| `test/approval/engine-node-advance.test.js` | Create | B1/C1 修复断言 |
| `test/sales/stageTaxonomy.test.js` | Create | 单一事实源断言 |
| `test/sales/funnelKpi.test.js` | Create | 漏斗 KPI 断言 |
| `test/approval/ruleResolver.test.js` | Create | R1-R4 + 分档断言 |

---

## Task 1: 单一事实源 stageTaxonomy.js

**Files:**
- Create: `src/sales/stageTaxonomy.js`
- Modify: `src/particles/particleModel.js:11`
- Test: `test/sales/stageTaxonomy.test.js`

- [ ] **Step 1: 写失败测试**

```js
// test/sales/stageTaxonomy.test.js
import { S_STAGES, S_LABEL, S_ALIAS_FWD, S_TRANSITIONS, toStageCode, fromStageCode } from '../../src/sales/stageTaxonomy.js';
import assert from 'node:assert';

test('S_STAGES 含 S1-S8 且顺序正确', () => {
  assert.deepStrictEqual(S_STAGES, ['S1','S2','S3','S4','S5','S6','S7','S8']);
});
test('S_LABEL 提供中文名', () => {
  assert.strictEqual(S_LABEL.S1, '线索发掘');
  assert.strictEqual(S_LABEL.S6, '赢单移交');
});
test('toStageCode 映射英文旧值', () => {
  assert.strictEqual(toStageCode('lead'), 'S1');
  assert.strictEqual(toStageCode('opportunity'), 'S2');
  assert.strictEqual(toStageCode('paid'), 'S6');
  assert.strictEqual(toStageCode('S3'), 'S3'); // 已是 S 码则原样
});
test('fromStageCode 反查英文', () => {
  assert.strictEqual(fromStageCode('S3'), 'quoted');
  assert.strictEqual(fromStageCode('S2'), 'opportunity');
});
test('S_TRANSITIONS 含 S2->S3 与退出边', () => {
  assert.ok(S_TRANSITIONS.some(t => t.from === 'S2' && t.to === 'S3'));
  assert.ok(S_TRANSITIONS.some(t => t.from === 'S3' && t.to === 'S7')); // 任意阶段可输单
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/sales/stageTaxonomy.test.js`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写实现**

```js
// src/sales/stageTaxonomy.js
// S 码单一事实源（设计文档 §1）。四层（方法论/DB/审批流/人机协同）一律引用本文件。
// 旧存储值 → S 码（DB 纯重命名迁移用）；P1-P6 仅作显示别名，不进代码逻辑。

export const S_STAGES = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8'];

export const S_LABEL = {
  S1: '线索发掘', S2: '需求确认', S3: '方案匹配', S4: '报价谈判',
  S5: '合同确认', S6: '赢单移交', S7: '输单', S8: '丢单',
};

// 旧 DB 英文值 → S 码（迁移 + 兼容读历史）
export const S_ALIAS_FWD = {
  lead: 'S1', opportunity: 'S2', quoted: 'S3', contracted: 'S4',
  ordered: 'S5', paid: 'S6', lost: 'S7', disqualified: 'S8',
};
// S 码 → 旧英文（反查/降级显示）
export const S_ALIAS_REV = Object.fromEntries(
  Object.entries(S_ALIAS_FWD).map(([k, v]) => [v, k])
);

// P1-P6 仅作方法论显示别名（不进逻辑）
export const S_P_ALIAS = {
  S1: 'P1', S2: 'P2', S3: 'P3', S4: 'P4', S5: 'P5', S6: 'P6',
};

// 合法推进边（含退出边 S7/S8，任意阶段可进）
export const S_TRANSITIONS = [
  { from: 'S1', to: 'S2' }, { from: 'S2', to: 'S3' }, { from: 'S3', to: 'S4' },
  { from: 'S4', to: 'S5' }, { from: 'S5', to: 'S6' },
  // 退出边（任意阶段 → 输单/丢单）
  { from: 'S1', to: 'S7' }, { from: 'S2', to: 'S7' }, { from: 'S3', to: 'S7' },
  { from: 'S4', to: 'S7' }, { from: 'S5', to: 'S7' }, { from: 'S6', to: 'S7' },
  { from: 'S1', to: 'S8' }, { from: 'S2', to: 'S8' }, { from: 'S3', to: 'S8' },
  { from: 'S4', to: 'S8' }, { from: 'S5', to: 'S8' }, { from: 'S6', to: 'S8' },
];

// 第 3.5 闸内容定义（设计 §2.1），纯数据；执行逻辑在 executor.salesStageGate
export const S_GATE_DEFS = [
  { from: 'S1', to: 'S2', hard: true,  key: 'need_facts', attach: null },
  { from: 'S2', to: 'S3', hard: true,  key: 'visit_value', attach: 'tech_review_proof' },   // G-S3 阶段门禁
  { from: 'S3', to: 'S4', hard: true,  key: 'bantcc_quote', attach: null },
  { from: 'S4', to: 'S5', hard: true,  key: 'review_contract', attach: 'customer_approval_screenshot' }, // G-S5 阶段门禁
  { from: 'S5', to: 'S6', hard: true,  key: 'contract_paid', attach: null },
];

// 阶段门禁（强制附件，设计 §2.4）。AI 判存在性，缺则 hard 阻断。
export const S_ATTACHMENT_GATES = {
  'S2->S3': { tag: 'tech_review_proof', label: '客户技术评审通过证明' },
  'S4->S5': { tag: 'customer_approval_screenshot', label: '客户内部审批完成截图' },
};

export function toStageCode(v) {
  if (!v) return v;
  if (v.startsWith('S') && S_STAGES.includes(v)) return v; // 已是 S 码
  return S_ALIAS_FWD[v] || v;
}
export function fromStageCode(code) {
  return S_ALIAS_REV[code] || code;
}
```

- [ ] **Step 4: 改 particleModel.js:11 引用 S 码**

Modify `src/particles/particleModel.js`:
```js
// 在文件顶部 import 段增加：
import { S_STAGES } from '../sales/stageTaxonomy.js';
// 第 11 行 flow 改为：
states: { current: 'ACTIVE', flow: S_STAGES },
```

- [ ] **Step 5: 运行测试**

Run: `npx vitest run test/sales/stageTaxonomy.test.js`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/sales/stageTaxonomy.js src/particles/particleModel.js test/sales/stageTaxonomy.test.js
git commit -m "feat(sales): S1-S8 单一事实源 stageTaxonomy + particleModel flow 改读"
```

---

## Task 2: DB 纯重命名迁移（S1-S8）

**Files:**
- Create: `scripts/migrate-stage-s.mjs`
- Modify: `src/action/seed-actions.js:13-16`（`STAGE_SCENARIO`）
- Modify: `src/sales/stageConfig.js:8-17`（DEFAULT_STAGE_CONFIG 阶段键）
- Modify: `src/particles/lifecycle.js:25`（allow_back 列表）
- Test: `test/sales/stageTaxonomy.test.js`（扩展）

- [ ] **Step 1: 写迁移脚本**

```js
// scripts/migrate-stage-s.mjs — 幂等将 CRM_DEAL.payload.stage 英文→S1-S8（无 DELETE）
import { queryWrite } from '../src/db.js';

const MAP = [
  ['lead', 'S1'], ['opportunity', 'S2'], ['quoted', 'S3'], ['contracted', 'S4'],
  ['ordered', 'S5'], ['paid', 'S6'], ['lost', 'S7'], ['disqualified', 'S8'],
];
async function main() {
  for (const [old, neu] of MAP) {
    const r = await queryWrite(
      `UPDATE crm.particles SET payload = jsonb_set(payload, '{stage}', to_jsonb($2::text))
       WHERE type='CRM_DEAL' AND payload->>'stage'=$1`,
      [old, neu]
    );
    console.log(`stage ${old} -> ${neu}: ${r.rowCount} 行`);
  }
  console.log('MIGRATE_STAGE_S_DONE');
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: 改 STAGE_SCENARIO 键（seed-actions.js:13-16）**

```js
const STAGE_SCENARIO = {
  S1: 'LEAD_FOLLOW_UP', S2: 'OPP_QUALIFY', S3: 'QUOTE_PRICING',
  S4: 'SIGN_RISK', S5: 'POST_CONTRACT', S6: 'POST_CONTRACT', S7: 'LOSS_REVIEW',
};
```

- [ ] **Step 3: 改 stageConfig.js:8-17 与 lifecycle.js:25**

`stageConfig.js` DEFAULT_STAGE_CONFIG 的 `stage:` 字段 `lead/opportunity/...` → `S1/S2/...`；`checkRollback` 内 flow 数组同改。`lifecycle.js:25` 的 `['opportunity','quoted','contracted','ordered','paid']` → `['S2','S3','S4','S5','S6']`。

- [ ] **Step 4: 运行迁移（生产库 plm，仅 UPDATE）**

Run: `node scripts/migrate-stage-s.mjs`
Expected: 逐行打印各 stage 迁移行数，`MIGRATE_STAGE_S_DONE`。

- [ ] **Step 5: 验证无残留英文阶段**

Run: `node -e "import('./src/db.js').then(async m=>{const r=await m.query(\"SELECT payload->>'stage' s, count(*)::int n FROM crm.particles WHERE type='CRM_DEAL' GROUP BY 1\"); console.log(r.rows);})"`
Expected: 所有 `s` 值均为 `S1..S8`，无 `lead/opportunity/...`。

- [ ] **Step 6: 提交**

```bash
git add scripts/migrate-stage-s.mjs src/action/seed-actions.js src/sales/stageConfig.js src/particles/lifecycle.js
git commit -m "feat(sales): DB 纯重命名 payload.stage→S1-S8 + STAGE_SCENARIO/配置同步"
```

---

## Task 3: 方法论 SKILL 改 S 码

**Files:**
- Modify: `skills/method-stage-progression/methodology.json`
- Modify: `skills/method-stage-progression/references/stages.md`
- Modify: `skills/method-stage-progression/rules/gates.md`
- Modify: `skills/method-funnel-classification/SKILL.md` `references/funnel.md` `rules/rhythm.md` `methodology.json` `profiles/sales.md`
- Modify: `skills/method-behavior-standard/SKILL.md` `references/standard-actions.md`
- Modify: `skills/method-opportunity-matrix/SKILL.md` `core/evaluate.md` `methodology.json` `registry.json` `references/dimensions.md`

- [ ] **Step 1: methodology.json 改 S 码**

将 `stages[].stage_key` 从 `P1..P6` 改为 `S1..S6`，`advance_gate` 文本中 `P1→P2` 等表述改为 `S1→S2`。`gate_rule` 中 `P2→P3 复用两关闸` → `S2→S3 复用两关闸`，`P3→P4 复用 BANT 资质闸` → `S3→S4 复用 BANT 资质闸`。

- [ ] **Step 2: stages.md / gates.md 改 S 码**

`stages.md` 表格阶段列 `P1→S1`…`P6→S6`；`gates.md` 推进前置表 `P1→P2`→`S1→S2`…`P5→P6`→`S5→S6`，证据载体与语义不变；`C 类硬闸` 段 `P4→P5 / P5→P6` → `S4→S5 / S5→S6`。

- [ ] **Step 3: 其余 SKILL 文件 P1-P6 引用改 S 码**

对 `method-funnel-classification`、`method-behavior-standard`、`method-opportunity-matrix` 下所有含 `P1`..`P6` 独立阶段引用的位置，机械替换为 `S1`..`S6`（仅替换作为阶段标识的 `Pn`，不改 BANTCC/三分类等无关词）。

- [ ] **Step 4: 校验无残留 P1-P6 阶段标识**

Run: `grep -rn "P1\|P2\|P3\|P4\|P5\|P6" skills/ | grep -v "BANTCC\|P1-P6\|21 条" || echo "NO_P_STAGE_REF"`
Expected: 仅剩非阶段语义的 `P1-P6` 词组或无命中。

- [ ] **Step 5: 提交**

```bash
git add skills/method-stage-progression skills/method-funnel-classification skills/method-behavior-standard skills/method-opportunity-matrix
git commit -m "docs(skills): 方法论层 P1-P6 统一为 S1-S6"
```

---

## Task 4: 第 3.5 闸接线（五闸 + 门禁，死代码激活）

**Files:**
- Modify: `src/action/executor.js:177-303`（`STAGE_GATES` + `salesStageGate`）
- Modify: `src/sales/salesThresholds.js`（阈值键 `gate.s1_s2_min_need_facts`）
- Test: `test/action/sales-executor-gate.test.js`

- [ ] **Step 1: 写失败测试**

```js
// test/action/sales-executor-gate.test.js
import { salesStageGate } from '../../src/action/executor.js';
import assert from 'node:assert';

test('S1->S2 缺需求事实被硬拦', () => {
  const v = salesStageGate({ curStage: 'S1', toStage: 'S2', dealPayload: { needs: {} } });
  assert.strictEqual(v.ok, false);
  assert.ok(v.gaps.join(';').includes('客户需求'));
});
test('S1->S2 需求事实齐备放行', () => {
  const v = salesStageGate({ curStage: 'S1', toStage: 'S2', dealPayload: { needs: { product: 'x', qty: 1, spec: 'y' } } });
  assert.strictEqual(v.ok, true);
});
test('S2->S3 缺客户技术评审证明被硬拦（G-S3 阶段门禁）', () => {
  const v = salesStageGate({ curStage: 'S2', toStage: 'S3', dealPayload: { ai: { sales_visit_value: true }, attachments: [] } });
  assert.strictEqual(v.ok, false);
  assert.ok(v.gaps.join(';').includes('技术评审'));
});
test('S2->S3 有证明放行', () => {
  const v = salesStageGate({ curStage: 'S2', toStage: 'S3', dealPayload: { ai: { sales_visit_value: true }, attachments: [{ tag: 'tech_review_proof' }] } });
  assert.strictEqual(v.ok, true);
});
test('S3->S4 BANTCC<0.6 被硬拦', () => {
  const v = salesStageGate({ curStage: 'S3', toStage: 'S4', dealPayload: { ai: { bantcc_completeness: 0.4 } } });
  assert.strictEqual(v.ok, false);
});
test('S4->S5 缺客户审批截图被硬拦（G-S5 阶段门禁）', () => {
  const v = salesStageGate({ curStage: 'S4', toStage: 'S5', dealPayload: { attachments: [] } });
  assert.strictEqual(v.ok, false);
});
test('无关边不触发（如 S1->S3 无定义应放行）', () => {
  const v = salesStageGate({ curStage: 'S1', toStage: 'S3', dealPayload: {} });
  assert.strictEqual(v.ok, true);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/action/sales-executor-gate.test.js`
Expected: FAIL（`salesStageGate` 仍用 P1-P2，且 `attachments` 未处理）

- [ ] **Step 3: 重写 STAGE_GATES + salesStageGate（executor.js:177-303）**

替换 `const STAGE_GATES = [...]`（178-269 行）与 `salesStageGate`（271-283 行）为：

```js
import { S_ATTACHMENT_GATES } from '../sales/stageTaxonomy.js';

// S 码阶段闸（设计 §2.1），与真实 payload.stage（S1-S8）匹配
const STAGE_GATES = [
  {
    from: 'S1', to: 'S2', hard: true,
    check: (p, th) => {
      const needs = p.needs || {};
      const min = readThreshold(th, 'gate.s1_s2_min_need_facts');
      const filled = ['product', 'qty', 'spec'].filter((k) => needs[k]).length;
      return filled >= min ? null : `缺客户需求事实（needs product/qty/spec 至少${min}项）`;
    },
  },
  {
    from: 'S2', to: 'S3', hard: true,
    check: (p) => {
      const ai = p.ai || {};
      const v = ai.sales_visit_value;
      const ok = (typeof v === 'object') ? Boolean(v.value) : Boolean(v);
      return ok ? null : '方案验证拜访未被判有价值（sales_visit_value=false）';
    },
  },
  {
    from: 'S2', to: 'S3', hard: false,
    check: (p, th) => {
      const ai = p.ai || {};
      const comp = ai.swas_completeness;
      const completeness = typeof comp === 'object' ? Number(comp.value ?? 1) : Number(comp ?? 1);
      const softBelow = readThreshold(th, 'swas.soft_warn_below');
      if (completeness < softBelow) return `未做商机回顾（SWAS 齐全度 ${completeness} < ${softBelow}），建议先补 SWAS——soft 提示`;
      return null;
    },
  },
  {
    from: 'S3', to: 'S4', hard: true,
    check: (p, th) => {
      const ai = p.ai || {};
      const pass = readThreshold(th, 'bantcc.pass');
      const unknown = readThreshold(th, 'bantcc.unknown');
      const bantccVal = ai.bantcc_completeness;
      const bantcc = typeof bantccVal === 'object' ? Number(bantccVal.value ?? unknown) : Number(bantccVal ?? unknown);
      if (bantcc < pass) {
        let detail = (ai.bantcc_detail && typeof ai.bantcc_detail === 'object') ? ai.bantcc_detail.value : null;
        if (!detail || typeof detail !== 'object') {
          try { detail = deterministicEval('CRM_DEAL', p, { key: 'bantcc_detail' })?.value; } catch { detail = null; }
        }
        const missing = detail ? Object.entries(detail).filter(([, v]) => Number(v) < pass).map(([k]) => k) : [];
        return missing.length ? `BANTCC 硬维缺口（<${pass} 禁止推 S4）：缺 ${missing.join('、')}` : `BANTCC 硬维缺口（<${pass} 禁止推 S4）`;
      }
      const hasQuote = Boolean(p.quotation_refs?.length || p.has_quotation || p.quotation_id);
      return hasQuote ? null : '缺报价事实（quotation_refs/has_quotation）';
    },
  },
  {
    from: 'S4', to: 'S5', hard: true,
    check: (p) => {
      const approved = Boolean(
        p.review_gate_decision === 'approved' ||
        (p.decisions || []).some(d => d.scene === 'REVIEW_GATE' && d.disposition === 'approved')
      );
      if (approved) return null;
      const hasContractFacts = Boolean(p.contract_facts || p.signed_at || p.contract_no);
      const orderDate = p.swas?.schedule?.order_date;
      if (hasContractFacts || orderDate) return null;
      return '缺 review-gate 通过记录与合同签署事实——hard 拦截（软事实硬闸：任一证据存在即放行）';
    },
  },
  {
    from: 'S5', to: 'S6', hard: true,
    check: (p) => {
      const signed = Boolean((p.contract_no && p.signed_at) || p.delivery_accepted_at);
      const paid = Boolean(p.paid_at || p.payment_received);
      if (signed && paid) return null;
      const parts = [];
      if (!signed) parts.push('合同未签署/未验收');
      if (!paid) parts.push('未收到全款');
      return `${parts.join('、')}——hard 拦截（合同+全款事实缺一不可）`;
    },
  },
];

export function salesStageGate({ curStage, toStage, dealPayload = {}, thresholds = DEFAULT_THRESHOLDS } = {}) {
  const gaps = [];
  const warnings = [];
  // 阶段门禁（设计 §2.4，G-S3/G-S5 硬阻断）：AI 判附件存在性，缺则 hard
  const attachGate = S_ATTACHMENT_GATES[`${curStage}->${toStage}`];
  if (attachGate) {
    const has = Array.isArray(dealPayload.attachments) && dealPayload.attachments.some(a => a?.tag === attachGate.tag);
    if (!has) gaps.push(`阶段门禁：推进 ${curStage}→${toStage} 必须附「${attachGate.label}」`);
  }
  for (const g of STAGE_GATES) {
    if (g.from !== curStage || g.to !== toStage) continue;
    const msg = g.check(dealPayload, thresholds);
    if (!msg) continue;
    if (g.hard) gaps.push(msg);
    else warnings.push(msg);
  }
  const hard = gaps.length > 0;
  return hard ? { ok: false, gate: 'sales_prereq', gaps, warnings: [] } : { ok: true, gaps: [], warnings };
}
```

- [ ] **Step 4: 改阈值键 salesThresholds.js**

`DEFAULT_THRESHOLDS.gate.p1_p2_min_need_facts` → `gate.s1_s2_min_need_facts`；`salesThresholdsRouter.js` RULES 内键 `'gate.p1_p2_min_need_facts'` 同步改为 `'gate.s1_s2_min_need_facts'`。

- [ ] **Step 5: 运行测试**

Run: `npx vitest run test/action/sales-executor-gate.test.js`
Expected: PASS（7 例）

- [ ] **Step 6: 提交**

```bash
git add src/action/executor.js src/sales/salesThresholds.js src/http/salesThresholdsRouter.js test/action/sales-executor-gate.test.js
git commit -m "feat(gate): 第3.5闸 S 码接线 + G-S3/G-S5 阶段门禁硬阻断"
```

---

## Task 5: 分业务审批规则 R1-R4 + 引擎 CONDITION/APPROVER 拓扑

**Files:**
- Modify: `db/seed.sql:286-296`（`approval_flow` → R1-R4）
- Create: `src/approval/ruleResolver.js`
- Create: `scripts/seed-approval-rules.mjs`
- Test: `test/approval/ruleResolver.test.js`

- [ ] **Step 1: 写失败测试**

```js
// test/approval/ruleResolver.test.js
import { resolveApprovalChain } from '../../src/approval/ruleResolver.js';
import assert from 'node:assert';

test('R2 报价 S3->S4 金额<=100万 → 经理单签(T1)', () => {
  const c = resolveApprovalChain({ businessType: 'quote', fromStage: 'S3', toStage: 'S4', amount: 500000 });
  assert.strictEqual(c.tier, 'T1');
  assert.deepStrictEqual(c.humanNodes, ['manager']);
});
test('R2 金额 300万 → 经理+总监(T2)', () => {
  const c = resolveApprovalChain({ businessType: 'quote', fromStage: 'S3', toStage: 'S4', amount: 3000000 });
  assert.strictEqual(c.tier, 'T2');
  assert.deepStrictEqual(c.humanNodes, ['manager', 'director']);
});
test('R3 金额 800万 → 经理→总监→总裁(T3)', () => {
  const c = resolveApprovalChain({ businessType: 'contract', fromStage: 'S4', toStage: 'S5', amount: 8000000 });
  assert.strictEqual(c.tier, 'T3');
  assert.deepStrictEqual(c.humanNodes, ['manager', 'director', 'ceo']);
});
test('重大项目标记 → 强制 T3', () => {
  const c = resolveApprovalChain({ businessType: 'contract', fromStage: 'S4', toStage: 'S5', amount: 500000, isMajorProject: true });
  assert.strictEqual(c.tier, 'T3');
});
test('R1 商机 S2->S3 → 销售经理', () => {
  const c = resolveApprovalChain({ businessType: 'deal', fromStage: 'S2', toStage: 'S3' });
  assert.strictEqual(c.humanNodes[0], 'manager');
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/approval/ruleResolver.test.js`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写 ruleResolver.js**

```js
// src/approval/ruleResolver.js — 分业务审批规则 R1-R4 + 金额分档（设计 §3）
// 纯函数（零 DB），供 crm-deal-advance 与种子脚本复用。
// 阈值走 config_store['approval-thresholds']，缺省用 DEFAULT_APPROVAL。
import { DEFAULT_THRESHOLDS, readThreshold } from '../sales/salesThresholds.js';

export const DEFAULT_APPROVAL = {
  tiers: {
    T1: { max: 1000000, humanNodes: ['manager'] },                                  // ≤100万
    T2: { max: 5000000, humanNodes: ['manager', 'director'] },                      // 100-500万
    T3: { max: Infinity, humanNodes: ['manager', 'director', 'ceo'] },              // >500万或重大项目
  },
};

const RULE_BY_EDGE = {
  'deal:S2->S3':   'R1',
  'quote:S3->S4':  'R2',
  'contract:S4->S5': 'R3',
  'invoice:S5->S6': 'R4',
};
const FLOW_BY_RULE = { R1: 'deal', R2: 'quote', R3: 'contract', R4: 'invoice' };

export function resolveTier(amount, cfg = DEFAULT_THRESHOLDS, isMajorProject = false) {
  if (isMajorProject) return 'T3';
  const t1 = Number(readThreshold(cfg, 'approval.t1_max', 1000000));
  const t2 = Number(readThreshold(cfg, 'approval.t2_max', 5000000));
  if (amount <= t1) return 'T1';
  if (amount <= t2) return 'T2';
  return 'T3';
}

export function resolveApprovalChain({ businessType, fromStage, toStage, amount = 0, isMajorProject = false, cfg = DEFAULT_THRESHOLDS }) {
  const ruleId = RULE_BY_EDGE[`${businessType}:${fromStage}->${toStage}`];
  if (!ruleId) return null; // 非受控边：无审批
  const tier = resolveTier(Number(amount || 0), cfg, isMajorProject);
  const humanNodes = DEFAULT_APPROVAL.tiers[tier].humanNodes;
  return {
    ruleId, tier, businessType, fromStage, toStage,
    flowId: `approval-${ruleId.toLowerCase()}`,
    // CONDITION(AI 自动校验) → APP1/APP2(人)；AI 节点仅 FLAG 不代批
    aiCondition: true,
    humanNodes,
  };
}
export { FLOW_BY_RULE };
```

- [ ] **Step 4: 改 seed.sql approval_flow（286-296）**

```sql
-- 审批流配置种子（item 17）：R1-R4 统一 S 码触发边
INSERT INTO crm.approval_flow (flow_id, name, description, from_stage, to_stage, enabled) VALUES
  ('approval-r1', '商机推进审批(R1)', 'S2→S3 商机推进', 'S2', 'S3', TRUE),
  ('approval-r2', '报价审批(R2)',     'S3→S4 报价',     'S3', 'S4', TRUE),
  ('approval-r3', '合同审批(R3)',     'S4→S5 合同',     'S4', 'S5', TRUE),
  ('approval-r4', '回款审批(R4)',     'S5→S6 回款',     'S5', 'S6', TRUE)
ON CONFLICT (flow_id) DO UPDATE SET
  name=EXCLUDED.name, description=EXCLUDED.description, from_stage=EXCLUDED.from_stage,
  to_stage=EXCLUDED.to_stage, enabled=EXCLUDED.enabled, updated_at=now();
```

- [ ] **Step 5: 写种子脚本 seed-approval-rules.mjs（引擎拓扑 R1-R4）**

```js
// scripts/seed-approval-rules.mjs — 幂等落 R1-R4 引擎流拓扑 START→COND(AI)→APP1/APP2(人)
import { queryWrite } from '../src/db.js';
import { resolveApprovalChain } from '../src/approval/ruleResolver.js';

const TENANT = 'system';
// 固定 UUID 前缀 afr0xxx，重跑 DO NOTHING
const FLOWS = [
  { rule: 'R1', label: '商机推进', tier: 'T1' },
  { rule: 'R2', label: '报价',     tier: 'T2' },
  { rule: 'R3', label: '合同',     tier: 'T2' },
  { rule: 'R4', label: '回款',     tier: 'T2' },
];

async function upsert(type, id, title, payload) {
  await queryWrite(
    `INSERT INTO particles (id, tenant_id, type, slug, title, state, payload)
     VALUES ($1,$2,$3,$4,$5,'active',$6) ON CONFLICT (id) DO NOTHING`,
    [id, TENANT, type, 'approval-' + type.toLowerCase().replace('_','-'), title, JSON.stringify(payload)]
  );
}

async function main() {
  for (const f of FLOWS) {
    const fid = `afr00000-0000-0000-0000-0000000000${f.rule.toLowerCase()}`;
    const cond = `afr00000-0000-0000-0000-0000000000c${f.rule.toLowerCase()}`;
    const app1 = `afr00000-0000-0000-0000-0000000000a${f.rule.toLowerCase()}`;
    const app2 = `afr00000-0000-0000-0000-0000000000b${f.rule.toLowerCase()}`;
    const end  = `afr00000-0000-0000-0000-0000000000e${f.rule.toLowerCase()}`;
    const lc = `afr00000-0000-0000-0000-0000000000l${f.rule.toLowerCase()}1`; // START→COND
    const l1 = `afr00000-0000-0000-0000-0000000000l${f.rule.toLowerCase()}2`; // COND-[pass]→APP1
    const l2 = `afr00000-0000-0000-0000-0000000000l${f.rule.toLowerCase()}3`; // COND-[flag]→APP2
    const l3 = `afr00000-0000-0000-0000-0000000000l${f.rule.toLowerCase()}4`; // APP1→END
    const l4 = `afr00000-0000-0000-0000-0000000000l${f.rule.toLowerCase()}5`; // APP2→END
    await upsert('CRM_APPROVAL_FLOW', fid, `审批流-${f.label}`, { name: `审批流-${f.label}`, rule_id: f.rule, enabled: true });
    await upsert('CRM_APPROVAL_NODE', fid, '开始', { flow_id: fid, node_type: 'START', name: '开始', pos: 1 });
    await upsert('CRM_APPROVAL_NODE', cond, 'AI自动校验', { flow_id: fid, node_type: 'CONDITION', name: 'AI自动校验', pos: 2, check: 'ai_auto' });
    await upsert('CRM_APPROVAL_APPROVER', cond, 'AI校验规则', { node_id: cond, auto_check: true, empty_approver_action: 'AUTO_PASS' });
    await upsert('CRM_APPROVAL_NODE', app1, '常规审批人', { flow_id: fid, node_type: 'APPROVER', name: '常规审批人', pos: 3 });
    await upsert('CRM_APPROVAL_APPROVER', app1, '常规审批人', { node_id: app1, approver_type: 'ROLE', role: 'manager', multi_approver_mode: 'ANY', empty_approver_action: 'ASSIGN_ADMIN' });
    await upsert('CRM_APPROVAL_NODE', app2, '升级审批人', { flow_id: fid, node_type: 'APPROVER', name: '升级审批人', pos: 4 });
    await upsert('CRM_APPROVAL_APPROVER', app2, '升级审批人', { node_id: app2, approver_type: 'ROLE', role: 'director', multi_approver_mode: 'ANY', empty_approver_action: 'ASSIGN_ADMIN' });
    await upsert('CRM_APPROVAL_NODE', end, '结束', { flow_id: fid, node_type: 'END', name: '结束', pos: 5 });
    // LINK: START→COND, COND-[PASS]→APP1, COND-[FLAG]→APP2, APP1→END, APP2→END
    await upsert('CRM_APPROVAL_LINK', lc, '连线', { from_node: fid, to_node: cond });
    await upsert('CRM_APPROVAL_LINK', l1, '连线', { from_node: cond, to_node: app1, condition_ref: 'pass' });
    await upsert('CRM_APPROVAL_LINK', l2, '连线', { from_node: cond, to_node: app2, condition_ref: 'flag' });
    await upsert('CRM_APPROVAL_LINK', l3, '连线', { from_node: app1, to_node: end });
    await upsert('CRM_APPROVAL_LINK', l4, '连线', { from_node: app2, to_node: end });
  }
  console.log('SEED_APPROVAL_RULES_DONE');
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
```

> 注：`l3` 变量未定义，实际应补 `const l3 = ...l3`。计划中保留可读性，实现时按 `l1/l2/l3` 三连线补足（START→COND 为 lC，COND→APP1 为 l1，COND→APP2 为 l2，APP1→END 与 APP2→END 复用 l3 单连线或各自一条）。

- [ ] **Step 6: 运行测试 + 落种子**

Run: `npx vitest run test/approval/ruleResolver.test.js` → PASS
Run: `node scripts/seed-approval-rules.mjs` → `SEED_APPROVAL_RULES_DONE`

- [ ] **Step 7: 提交**

```bash
git add src/approval/ruleResolver.js db/seed.sql scripts/seed-approval-rules.mjs test/approval/ruleResolver.test.js
git commit -m "feat(approval): R1-R4 分业务审批 + 金额分档 T1/T2/T3 + 引擎拓扑种子"
```

---

## Task 6: B1 节点推进 + C1 条件路由（引擎缺口修复）

**Files:**
- Modify: `src/approval/engine.js`（startInstance + advanceTask）
- Test: `test/approval/engine-node-advance.test.js`

- [ ] **Step 1: 写失败测试**

```js
// test/approval/engine-node-advance.test.js
import { startInstance, advanceTask } from '../../src/approval/engine.js';
import { queryWrite } from '../../src/db.js';
import assert from 'node:assert';

const T = 'system';
const U = { flow: 'aftest-0000-0000-0000-000000000001', start: 'aftest-0000-0000-0000-0000000000s1',
  c1: 'aftest-0000-0000-0000-0000000000c1', a1: 'aftest-0000-0000-0000-0000000000a1',
  a2: 'aftest-0000-0000-0000-0000000000a2', end: 'aftest-0000-0000-0000-0000000000e1',
  l1: 'aftest-0000-0000-0000-0000000000l1', l2: 'aftest-0000-0000-0000-0000000000l2', l3: 'aftest-0000-0000-0000-0000000000l3' };

async function seedChain() {
  const rows = [
    ['CRM_APPROVAL_FLOW','approval-flow','链','enabled',U.flow,JSON.stringify({name:'链',enabled:true})],
    ['CRM_APPROVAL_NODE','approval-node','开始','active',U.start,JSON.stringify({flow_id:U.flow,node_type:'START',name:'开始',pos:1})],
    ['CRM_APPROVAL_NODE','approval-node','审批1','active',U.a1,JSON.stringify({flow_id:U.flow,node_type:'APPROVER',name:'审批1',pos:2})],
    ['CRM_APPROVAL_NODE','approval-node','审批2','active',U.a2,JSON.stringify({flow_id:U.flow,node_type:'APPROVER',name:'审批2',pos:3})],
    ['CRM_APPROVAL_NODE','approval-node','结束','active',U.end,JSON.stringify({flow_id:U.flow,node_type:'END',name:'结束',pos:4})],
    ['CRM_APPROVAL_APPROVER','approval-approver','A1','active',U.a1+'p',JSON.stringify({node_id:U.a1,approver_type:'ROLE',role:'manager',multi_approver_mode:'ANY',empty_approver_action:'ASSIGN_ADMIN'})],
    ['CRM_APPROVAL_APPROVER','approval-approver','A2','active',U.a2+'p',JSON.stringify({node_id:U.a2,approver_type:'ROLE',role:'director',multi_approver_mode:'ANY',empty_approver_action:'ASSIGN_ADMIN'})],
    ['CRM_APPROVAL_LINK','approval-link','连','active',U.l1,JSON.stringify({from_node:U.start,to_node:U.a1})],
    ['CRM_APPROVAL_LINK','approval-link','连','active',U.l2,JSON.stringify({from_node:U.a1,to_node:U.a2})],
    ['CRM_APPROVAL_LINK','approval-link','连','active',U.l3,JSON.stringify({from_node:U.a2,to_node:U.end})],
  ];
  for (const [type,slug,title,state,id,payload] of rows)
    await queryWrite(`INSERT INTO particles (id,tenant_id,type,slug,title,state,payload) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`, [id,T,type,slug,title,state,payload]);
}

test('B1 多节点串联：首节点签完推进到次节点，末节点签完才 APPROVED', async () => {
  await seedChain();
  const { queryParticles, getParticle } = await import('../../src/particles/particleRepo.js');
  const inst = await startInstance(U.flow, 'CRM_DEAL', 'biz-chain', {}, { submitter: 'alice', approvers: ['role:manager'] });
  assert.strictEqual(inst.payload.current_node, U.a1);
  // 首节点签完：应推进到 a2，仍 APPROVING
  let tasks = (await queryParticles({ type: 'CRM_APPROVAL_TASK', tenantId: T })).filter(t => t.payload.instance_id === inst.id);
  await advanceTask(inst.id, tasks[0].id, { approver: tasks[0].payload.approver, decision: 'approve' });
  const after1 = await getParticle(inst.id);
  assert.strictEqual(after1.payload.current_node, U.a2);
  assert.strictEqual(after1.payload.status, 'APPROVING');
  // 末节点签完 → APPROVED
  tasks = (await queryParticles({ type: 'CRM_APPROVAL_TASK', tenantId: T })).filter(t => t.payload.instance_id === inst.id);
  await advanceTask(inst.id, tasks[0].id, { approver: tasks[0].payload.approver, decision: 'approve' });
  const after2 = await getParticle(inst.id);
  assert.strictEqual(after2.payload.status, 'APPROVED');
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/approval/engine-node-advance.test.js`
Expected: FAIL（首节点签完即 APPROVED，不会推进到 a2）

- [ ] **Step 3: 改 engine.js —— 抽 materializeNode + advanceToNextNode**

在 `engine.js` 的 `route` 函数之后（约 50 行后）插入：

```js
// C1 条件路由 + 节点物化（递归，带 visited 环保护）：
// START/CONDITION 节点不生成任务，按 route() 求值选分支后递归进入目标节点；
// APPROVER 节点生成待签任务；END/null 终止。
async function materializeNode(node, fd, ctx, visited = new Set()) {
  if (!node || node.payload.node_type === 'END') return { end: true };
  if (visited.has(node.id)) return { end: true }; // 环保护
  visited.add(node.id);
  if (node.payload.node_type === 'CONDITION') {
    const next = route(node, fd, ctx);
    return materializeNode(next, fd, ctx, visited);
  }
  if (node.payload.node_type === 'APPROVER') {
    const approverRule = fd.approvers.find(a => a.payload.node_id === node.id);
    const resolved = approverRule ? resolveApprovers(approverRule, { submitter: ctx.submitter, approvers: ctx.approvers || [] }) : { auto_pass: true };
    if (resolved.auto_pass) { // 无审批人→继续路由（不再直接 APPROVED）
      const next = route(node, fd, ctx);
      return materializeNode(next, fd, ctx, visited);
    }
    return { approverNode: node, resolved };
  }
  // START/DEFAULT：继续路由
  const next = route(node, fd, ctx);
  return materializeNode(next, fd, ctx, visited);
}

// B1 节点推进：当前节点全部签完 → 取下一节点并物化；END/null → APPROVED
async function advanceToNextNode(inst, fd, ctx) {
  const curNode = fd.nodes.find(n => n.id === inst.payload.current_node);
  const next = route(curNode, fd, ctx);
  const mat = await materializeNode(next, fd, ctx);
  if (mat.end) { await updateInstanceStatus(inst, 'APPROVED'); return { status: 'APPROVED' }; }
  const node = mat.approverNode;
  await updateParticle(inst.id, {
    patch: { ...inst.payload, current_node: node.id, current_node_name: node.payload.name,
      node_mode: fd.approvers.find(a => a.payload.node_id === node.id)?.payload.multi_approver_mode || 'ANY', approvers: mat.resolved },
  });
  for (const [i, approver] of mat.resolved.entries()) {
    await createParticle('CRM_APPROVAL_TASK', { instance_id: inst.id, node_id: node.id, approver, status: 'TODO', seq: i + 1 }, { tenantId: TENANT });
  }
  return { status: 'APPROVING' };
}
```

- [ ] **Step 4: 改 startInstance（92-134 行）**

将 `startInstance` 内 `const node = route(start, fd, ctx);` 起的逻辑替换为调用 `materializeNode`：

```js
  const mat = await materializeNode(start, fd, ctx);
  if (mat.end) {
    return createParticle('CRM_APPROVAL_INSTANCE', { flow_id, business_type, business_id, submitter, status: 'APPROVED', current_node: null, current_node_name: null, ctx }, { tenantId: TENANT });
  }
  if (!mat.approverNode) {
    // 无 APPROVER 节点可物化（纯路由链）→ 直接通过
    return createParticle('CRM_APPROVAL_INSTANCE', { flow_id, business_type, business_id, submitter, status: 'APPROVED', current_node: null, current_node_name: null, ctx }, { tenantId: TENANT });
  }
  const node = mat.approverNode;
  const resolved = mat.resolved;
  const inst = await createParticle('CRM_APPROVAL_INSTANCE', {
    flow_id, business_type, business_id, submitter,
    status: 'APPROVING', current_node: node.id, current_node_name: node.payload.name,
    node_mode: fd.approvers.find(a => a.payload.node_id === node.id)?.payload.multi_approver_mode || 'ANY',
    approvers: resolved, ctx,
  }, { tenantId: TENANT });
  for (const [i, approver] of resolved.entries()) {
    await createParticle('CRM_APPROVAL_TASK', { instance_id: inst.id, node_id: node.id, approver, status: 'TODO', seq: i + 1 }, { tenantId: TENANT });
  }
  return inst;
```

- [ ] **Step 5: 改 advanceTask（154-168 行 approve 分支）**

`mode === 'ANY'` 与 `!remaining.length`（ALL/SEQUENTIAL 末签）两处 `updateInstanceStatus(inst, 'APPROVED')` 改为调用 `advanceToNextNode`：

```js
  if (decision === 'approve') {
    await updateParticle(task_id, { patch: { ...task.payload, status: 'APPROVED', opinion, decided_by: approver } });
    if (mode === 'ANY') {
      const r = await advanceToNextNode(inst, fd, { submitter: inst.payload.submitter, approvers: inst.payload.approvers });
      return r;
    }
    const remaining = (await queryParticles({ type: 'CRM_APPROVAL_TASK', tenantId: TENANT }))
      .filter(t => t.payload.instance_id === instance_id && t.payload.status === 'TODO');
    if (!remaining.length) {
      const r = await advanceToNextNode(inst, fd, { submitter: inst.payload.submitter, approvers: inst.payload.approvers });
      return r;
    }
    return { status: 'APPROVING' };
  }
```

> 注意：`advanceTask` 需先 `const fd = await loadFlow(inst.payload.flow_id);`（在 `getParticle(inst)` 后补一行）供 `advanceToNextNode` 使用。

- [ ] **Step 6: 运行测试**

Run: `npx vitest run test/approval/engine-node-advance.test.js`
Expected: PASS（首节点签完→a2 APPROVING，末节点签完→APPROVED）

- [ ] **Step 7: 提交**

```bash
git add src/approval/engine.js test/approval/engine-node-advance.test.js
git commit -m "fix(approval): B1 节点推进状态机 + C1 条件路由接线（多签链/AI节点生效）"
```

---

## Task 7: 阶段门禁 + 漏斗 KPI + 分级审批接线

**Files:**
- Modify: `src/action/executor.js`（crm-deal-advance 触发 ruleResolver）
- Create: `src/sales/funnelKpi.js`
- Modify: `src/sales/salesThresholds.js`（DEFAULT 增 `approval` / `funnel-kpi`）
- Modify: `src/http/salesThresholdsRouter.js`（RULES 增键）
- Test: `test/sales/funnelKpi.test.js`

- [ ] **Step 1: 写失败测试（funnelKpi）**

```js
// test/sales/funnelKpi.test.js
import { funnelConversionRates } from '../../src/sales/funnelKpi.js';
import assert from 'node:assert';

test('S1->S2 转化率计算', () => {
  const events = [
    { from: 'S1', to: 'S2' }, { from: 'S1', to: 'S2' }, { from: 'S1', to: 'S7' },
  ];
  const r = funnelConversionRates(events);
  assert.strictEqual(r['S1->S2'].rate, 2 / 3);
  assert.strictEqual(r['S1->S2'].below, true); // <0.6 健康线
});
test('空事件返回全 0 且无 NaN', () => {
  const r = funnelConversionRates([]);
  assert.strictEqual(r['S1->S2'].rate, 0);
  assert.strictEqual(Number.isNaN(r['S1->S2'].rate), false);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/sales/funnelKpi.test.js`
Expected: FAIL

- [ ] **Step 3: 写 funnelKpi.js**

```js
// src/sales/funnelKpi.js — 漏斗转化率 KPI（设计 §4，监控/辅导层，非门禁）
// 输入：阶段跃迁事件数组 [{from,to}]（复用决策第0闸 advanceStage 跃迁事件）。
// 阈值走 config_store['funnel-kpi']。
import { readThreshold, DEFAULT_THRESHOLDS } from './salesThresholds.js';

const EDGES = [
  ['S1', 'S2'], ['S2', 'S3'], ['S3', 'S4'], ['S4', 'S5'],
];
const DEFAULT_HEALTH = { 'S1->S2': 0.6, 'S2->S3': 0.5, 'S3->S4': 0.4, 'S4->S5': 0.7 };

export function funnelConversionRates(events = [], cfg = DEFAULT_THRESHOLDS) {
  const counts = {};
  for (const [f, t] of EDGES) counts[`${f}->${t}`] = { from: 0, to: 0 };
  for (const e of events) {
    const key = `${e.from}->${e.to}`;
    if (counts[key]) { counts[key].from += 1; counts[key].to += 1; }
    // 起点计数：任意边 from 匹配
    const fromKey = `${e.from}->`;
    for (const k of Object.keys(counts)) if (k.startsWith(fromKey)) counts[k].from += 1;
  }
  const out = {};
  for (const [f, t] of EDGES) {
    const c = counts[`${f}->${t}`];
    const rate = c.from > 0 ? c.to / c.from : 0;
    const health = Number(readThreshold(cfg, `funnel-kpi.${f}_${t}`, DEFAULT_HEALTH[`${f}->${t}`]));
    out[`${f}->${t}`] = { rate, health, below: rate < health };
  }
  return out;
}
```

- [ ] **Step 4: salesThresholds.js 增键**

`DEFAULT_THRESHOLDS` 增：
```js
approval: { t1_max: 1000000, t2_max: 5000000 },
'funnel-kpi': { S1_S2: 0.6, S2_S3: 0.5, S3_S4: 0.4, S4_S5: 0.7 },
```
（实际键名用 `funnel-kpi.S1_S2` 点路径，见 funnelKpi.js 读取 `funnel-kpi.${f}_${t}` → `funnel-kpi.S1_S2`）

- [ ] **Step 5: salesThresholdsRouter.js RULES 增**

```js
'approval.t1_max': { min: 0, max: 1e12, type: 'number', label: 'T1 金额上限(元)' },
'approval.t2_max': { min: 0, max: 1e12, type: 'number', label: 'T2 金额上限(元)' },
'funnel-kpi.S1_S2': { min: 0, max: 1, type: 'number', label: 'S1→S2 转化率健康线' },
'funnel-kpi.S2_S3': { min: 0, max: 1, type: 'number', label: 'S2→S3 转化率健康线' },
'funnel-kpi.S3_S4': { min: 0, max: 1, type: 'number', label: 'S3→S4 转化率健康线' },
'funnel-kpi.S4_S5': { min: 0, max: 1, type: 'number', label: 'S4→S5 转化率健康线' },
```

- [ ] **Step 6: crm-deal-advance 触发 ruleResolver（executor 第3.5闸之后）**

在 `seed-actions.js` 的 `crm-deal-advance` handler 内，`advanceStage` 调用前插入分级审批链解析（仅记录/emit，不阻断自动推进；如需强审批可后续接 needsApproval）：

```js
import { resolveApprovalChain } from '../approval/ruleResolver.js';
// ... 在 gate 校验通过后：
const approval = resolveApprovalChain({
  businessType: 'deal', fromStage: deal.payload.stage, toStage,
  amount: Number(deal.payload.amount || 0),
  isMajorProject: Boolean(deal.payload.is_major_project),
});
if (approval) emit('approval', 'chain-resolved', { deal_id, ...approval });
```

- [ ] **Step 7: 运行测试**

Run: `npx vitest run test/sales/funnelKpi.test.js`
Expected: PASS

- [ ] **Step 8: 提交**

```bash
git add src/sales/funnelKpi.js src/sales/salesThresholds.js src/http/salesThresholdsRouter.js src/action/seed-actions.js test/sales/funnelKpi.test.js
git commit -m "feat(kpi): 漏斗转化率 KPI + 分级审批链解析接线 + 阈值配置化"
```

---

## Task 8: 迁移脚本 + 全链路回归

**Files:**
- Modify: `scripts/seed-approval-demo.mjs`
- Test: 扩展既有模拟

- [ ] **Step 1: 扩展 seed-approval-demo.mjs**

在 `run()` 末尾"环节8"之后新增：

```js
  console.log('\n[环节9] 五闸 S 码接线（salesStageGate）');
  {
    const { salesStageGate } = await import('../src/action/executor.js');
    check('S1→S2 缺需求事实硬拦', !salesStageGate({ curStage:'S1', toStage:'S2', dealPayload:{ needs:{} } }).ok);
    check('S2→S3 缺技术评审证明硬拦', !salesStageGate({ curStage:'S2', toStage:'S3', dealPayload:{ ai:{sales_visit_value:true}, attachments:[] } }).ok);
    check('S2→S3 有证明放行', salesStageGate({ curStage:'S2', toStage:'S3', dealPayload:{ ai:{sales_visit_value:true}, attachments:[{tag:'tech_review_proof'}] } }).ok);
  }

  console.log('\n[环节10] 分级审批 R1-R4 分档（ruleResolver）');
  {
    const { resolveApprovalChain } = await import('../src/approval/ruleResolver.js');
    const r1 = resolveApprovalChain({ businessType:'quote', fromStage:'S3', toStage:'S4', amount:3000000 });
    check('R2 300万→T2 经理+总监', r1 && r1.tier==='T2' && r1.humanNodes.join(',')==='manager,director');
    const r2 = resolveApprovalChain({ businessType:'contract', fromStage:'S4', toStage:'S5', amount:8000000 });
    check('R3 800万→T3 经理→总监→总裁', r2 && r2.tier==='T3' && r2.humanNodes.length===3);
  }

  console.log('\n[环节11] 漏斗 KPI');
  {
    const { funnelConversionRates } = await import('../src/sales/funnelKpi.js');
    const r = funnelConversionRates([{from:'S1',to:'S2'},{from:'S1',to:'S2'},{from:'S1',to:'S7'}]);
    check('S1→S2 转化率=2/3 且低于健康线', Math.abs(r['S1->S2'].rate - 2/3) < 1e-9 && r['S1->S2'].below);
  }

  console.log('\n[环节12] 三节点串联流（B1 修复后）');
  {
    // 复用 Task6 的 seedChain 拓扑（以 afr 前缀独立 UUID 落地）
    const { startInstance, advanceTask } = await import('../src/approval/engine.js');
    const { queryParticles, getParticle } = await import('../src/particles/particleRepo.js');
    // ... 落 3 节点拓扑（START→A1→A2→END）并验证首签推进 A2、末签 APPROVED
  }
```

- [ ] **Step 2: 运行全量模拟**

Run: `node scripts/seed-approval-demo.mjs`
Expected: 全绿（原 16/16 + 新增 9-12 环节），末尾 `🎉`。

- [ ] **Step 3: 重跑受影响单测套件**

Run: `npx vitest run test/sales test/action/sales-executor-gate.test.js test/approval test/sales-named-accounts test/http/sales-thresholds-config.test.js`
Expected: 全绿（无 `lead/opportunity` 断言残留破坏）

- [ ] **Step 4: 提交**

```bash
git add scripts/seed-approval-demo.mjs
git commit -m "test(approval): 扩展全链路模拟覆盖 S码五闸/分级/漏斗/节点推进"
```

---

## 验证总览

| 验证项 | 命令 | 预期 |
|---|---|---|
| 单一事实源 | `npx vitest run test/sales/stageTaxonomy.test.js` | PASS |
| 第3.5闸 S 码 | `npx vitest run test/action/sales-executor-gate.test.js` | 7 例 PASS |
| 分档审批 | `npx vitest run test/approval/ruleResolver.test.js` | PASS |
| 节点推进/条件路由 | `npx vitest run test/approval/engine-node-advance.test.js` | PASS |
| 漏斗 KPI | `npx vitest run test/sales/funnelKpi.test.js` | PASS |
| DB 迁移 | `node scripts/migrate-stage-s.mjs` | 各 stage 行数打印 |
| 全链路模拟 | `node scripts/seed-approval-demo.mjs` | 全绿 |
| 审批规则种子 | `node scripts/seed-approval-rules.mjs` | SEED_APPROVAL_RULES_DONE |

## 风险与回滚

- **零 DELETE**：所有迁移为 `UPDATE`/`ON CONFLICT DO NOTHING`；回滚用 `S_ALIAS_REV` 反向 `jsonb_set`（`S3→quoted`）。
- **生产库先备份**：执行 `migrate-stage-s.mjs` 前 `pg_dump plm > /tmp/plm_pre_s.sql`。
- **门禁例外留痕**：G-S3/G-S5 硬阻断不可静默绕过；经理例外放行须经决策第 0 闸留痕。
- **不污染 ai-* 基线**：S 码实例化只落 `src/sales/*`、`src/approval/*`、`skills/method-*`，`grep -r "S1\|S2" ~/.workbuddy/skills/ai-*` 应为空。
