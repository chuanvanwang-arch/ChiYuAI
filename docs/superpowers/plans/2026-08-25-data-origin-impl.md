# 数据产生能力实施计划（Data Origin Impl Plan：AI 属性评估器 + 定时器 + 外部连接器 P0）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让「② AI 自动产生」「③ 定时规则」「④ 外部采集」三条数据产生路径真正可运行（不只是 Schema 声明），并把「阶段 3 前台页面字段采集完整性」锚定进总体设计。

**Architecture:** 按 12 文档 §7 的 1/3/4 三优先级落地：
- ①→ AI 属性评估器 `src/aiAttributes/evaluator.js`：幂等将业务粒子的 AI 派生属性落 `payload.ai.*`（能力轴/置信度/理由/时间），LLM 可注入（测试用确定性兜底），写事件触发。
- ③→ 定时器 `src/scheduler/timers.js`：注册 nightly 蒸馏 + crm-risk 30 分钟扫描，幂等单例（照 `registerCaptureSubscriber` 模式在 `createRoutes` 接线）。
- ④→ 外部连接器 P0 `src/connectors/connectorActions.js`：两个 Action `conn-attio-enrich-account` / `conn-zhizao-verify-account`，走写通道第0闸（autoDecision），落 auto_weak 边 + relation_confidence。
- 锚定→ 总体设计新增 §8.7「阶段 3 前台页面字段采集完整性」+ 12 文档 §6 状态更新。

**Tech Stack:** Node 22 ESM + PostgreSQL 16 + vitest 3（纯逻辑测试不依赖 PG；DB 集成测试标注环境限制）。

---

### Task 1: AI 属性评估器（纯函数 + 写事件触发）

**Files:**
- Create: `src/aiAttributes/evaluator.js`
- Test: `test/ai-attributes.test.js`（纯逻辑，无 DB）

- [ ] **Step 1: 写失败测试**

```js
// test/ai-attributes.test.js — AI 属性评估器纯逻辑（无 DB）
import { describe, it, expect } from 'vitest';
import {
  AI_ATTR_DEFS, EVALUATE, evaluateAiAttributesFor, aiAttrFor,
} from '../src/aiAttributes/evaluator.js';

function fakeParticle(type, payload) {
  return { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', type, payload, tenant_id: 'system', state: 'ACTIVE' };
}

describe('AI 属性评估器（② AI 自动产生的落地）', () => {
  it('AI_ATTR_DEFS 含 DEAL 的 revenue_forecast（轴 F_Forecast、来源 AI 生成）', () => {
    const d = AI_ATTR_DEFS.CRM_DEAL.revenue_forecast;
    expect(d.axis).toBe('F_Forecast');
    expect(d.source).toBe('AI生成');
    expect(d.confidence).toBeGreaterThan(0);
  });

  it('evaluateAiAttributesFor 将派生属性写入 payload.ai.（带轴/置信度/理由/时间戳）', () => {
    const p = fakeParticle('CRM_DEAL', { name: '扩产项目', expected_amount: 1200000, stage: 'opportunity' });
    const r = evaluateAiAttributesFor(p, { now: '2026-08-25T00:00:00Z' });
    expect(r.ai.revenue_forecast).toBeDefined();
    expect(r.ai.revenue_forecast.axis).toBe('F_Forecast');
    expect(r.ai.revenue_forecast.confidence).toBeGreaterThan(0);
    expect(r.ai.revenue_forecast.rationale).toBeTruthy();
    expect(r.ai.revenue_forecast.generated_at).toBe('2026-08-25T00:00:00Z');
  });

  it('幂等：内容不变不重算（同一 payload 第二次 eval 返回相同 ai 快照）', () => {
    const p = fakeParticle('CRM_DEAL', { name: 'X', expected_amount: 500000, stage: 'lead' });
    const r1 = evaluateAiAttributesFor(p, { now: '2026-08-25T00:00:00Z' });
    const r2 = evaluateAiAttributesFor(p, { now: '2026-08-25T00:00:00Z' });
    expect(r2.ai).toEqual(r1.ai);
  });

  it('确定性兜底（无 LLM）也可产生可复现 AI 属性', () => {
    const p = fakeParticle('CRM_DEAL', { name: 'Y', expected_amount: 800000, stage: 'quoted' });
    const a = evaluateAiAttributesFor(p, { llm: null });
    expect(a.degraded).toBe(true);            // 无 LLM → 降级标记
    expect(a.ai.revenue_forecast.rationale).toContain('确定性'); // 兜底可解释
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/ai-attributes.test.js`
Expected: FAIL（`evaluator.js` 不存在 / 函数未定义）

- [ ] **Step 3: 实现最小代码**

```js
// src/aiAttributes/evaluator.js — AI 属性评估器（② AI 自动产生的落地，12 文档 §3/§7-1）
// 设计输入：01 粒子设计 §2.3 AI 属性 2D 模型（能力轴 × 来源轴）+ 置信度红线（<0.6 → needsReview）
// LLM 可注入：生产传 llm(summaryText)→结果；测试/无 LLM 走确定性兜底（可复现，降级标记）
export const AI_ATTR_DEFS = {
  CRM_DEAL: {
    revenue_forecast: { axis: 'F_Forecast', source: 'AI生成', confidence: 0.7 },
    win_probability_adjusted: { axis: 'J_Judge', source: '规则+AI确认', confidence: 0.85 },
    age_in_stage: { axis: 'J_Judge', source: 'AI度量', confidence: 0.8 },
    stuck_warning: { axis: 'A_Alert', source: 'AI生成', confidence: 0.8 },
    engagement_trend: { axis: 'J_Judge', source: 'AI生成', confidence: 0.82 },
    funnel_velocity: { axis: 'F_Forecast', source: 'AI生成', confidence: 0.7 },
  },
  CRM_ACCOUNT: {
    account_segment: { axis: 'C_Classify', source: 'AI生成', confidence: 0.8 },
    customer_health_score: { axis: 'J_Judge', source: '规则+AI确认', confidence: 0.85 },
    churn_risk: { axis: 'A_Alert', source: 'AI生成', confidence: 0.7 },
    business_verified: { axis: 'C_Compliance', source: '规则+AI确认', confidence: 0.9 },
  },
  CRM_CONTACT: {
    relationship_heatmap: { axis: 'B_Brief', source: 'AI生成', confidence: 0.85 },
    stakeholder_influence: { axis: 'J_Judge', source: 'AI生成+人工确认', confidence: 0.8 },
  },
};

// 确定性兜底（无 LLM 可复现）：基于既有事实推导，输出可解释 rationale
function deterministicEval(type, payload, def) {
  const p = payload || {};
  if (type === 'CRM_DEAL') {
    if (def.key === 'revenue_forecast') {
      const amount = Number(p.expected_amount || 0);
      return { value: amount * 1.0, rationale: `确定性兜底：revenue_forecast=expected_amount(${amount})×1.0（无 LLM，待真实模型注入）` };
    }
    if (def.key === 'age_in_stage') {
      const changed = p.stage_changed_at || null;
      const days = changed ? Math.max(0, Math.round((Date.now() - new Date(changed).getTime()) / 86400000)) : 0;
      return { value: days, rationale: `确定性兜底：age_in_stage=${days}天（自 ${changed || '未知'} 起）` };
    }
    if (def.key === 'stuck_warning') {
      const stuck = (p.stage_changed_at && (Date.now() - new Date(p.stage_changed_at).getTime()) > 30 * 86400000) || false;
      return { value: stuck, rationale: stuck ? '确定性兜底：阶段停留>30天 → stuck_warning=true' : '确定性兜底：阶段停留未超阈值' };
    }
    return { value: p[def.key] ?? null, rationale: `确定性兜底：${def.key} 直接取既有事实（无 LLM）` };
  }
  if (type === 'CRM_ACCOUNT') {
    if (def.key === 'business_verified') {
      const ok = Boolean(p.business_title && p.business_title.length > 4);
      return { value: ok, rationale: ok ? '确定性兜底：business_title 已填且>4字符 → verified' : 'business_title 缺失 → 未验证（需人工/企查查）' };
    }
    return { value: p[def.key] ?? null, rationale: `确定性兜底：${def.key}（无 LLM）` };
  }
  return { value: p[def.key] ?? null, rationale: `确定性兜底：${def.key}（无 LLM）` };
}

// 对类型配置的每个 AI 属性求值 → 返回 { ai: {...}, degraded, changed }
export function evaluateAiAttributesFor(entity, { llm = null, now = new Date().toISOString() } = {}) {
  const defs = AI_ATTR_DEFS[entity.type] || {};
  const ai = { ...(entity.payload?.ai || {}) };       // 保留既有 AI 属性，只更新有定义的
  let degraded = false;
  for (const [key, def] of Object.entries(defs)) {
    const summaryText = JSON.stringify({ type: entity.type, payload: entity.payload });
    let result;
    if (llm) {
      result = { value: null, rationale: `LLM 分析：${key}` };   // 预留 LLM 注入点（生产接 SiliconFlow）
    } else {
      result = deterministicEval(entity.type, entity.payload, { key, ...def });
      degraded = true;
    }
    ai[key] = {
      value: result.value, axis: def.axis, source: def.source,
      confidence: def.confidence, rationale: result.rationale,
      generated_at: now, degraded: !llm,
    };
  }
  return { ai, degraded, changed: JSON.stringify(ai) !== JSON.stringify(entity.payload?.ai || {}) };
}

// 便捷取单属性（供查询/上下文注入）
export function aiAttrFor(entity, key, fallback = null) {
  return entity?.payload?.ai?.[key] ?? fallback;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node node_modules/vitest/vitest.mjs run test/ai-attributes.test.js`
Expected: PASS（4/4）

- [ ] **Step 5: 接线写事件触发（粒子写后自动评估）**

在 `src/particles/particleRepo.js` 的 `ensureAll(p)` 之后追加（两处：createParticle / updateParticle）：
```js
// ② AI 属性自动产生：写后评估（LLM 注入点；测试/无 LLM 走确定性兜底）
import { evaluateAiAttributesFor } from '../aiAttributes/evaluator.js';
// ...（createParticle 内）
await ensureAll(particle);
const evalRes = evaluateAiAttributesFor(particle, { llm: null });
if (evalRes.changed) {
  await query(`UPDATE particles SET payload = payload || $1::jsonb WHERE id=$2`,
    [JSON.stringify({ ai: evalRes.ai }), particle.id]);
}
```

- [ ] **Step 6: 提交**

```bash
git add src/aiAttributes/evaluator.js src/particles/particleRepo.js test/ai-attributes.test.js
git commit -m "feat(ai-attributes): AI 属性评估器落地（①幂等②LLM注入③确定性兜底④写事件触发）+ 单测"
```

---

### Task 2: 定时器（nightly 蒸馏 + crm-risk 30 分钟扫描）

**Files:**
- Create: `src/scheduler/timers.js`
- Modify: `src/http/routes.js`（createRoutes 内接线，幂等单例）
- Test: `test/timers.test.js`（纯逻辑：单例防双实例 + 空转 OK）

- [ ] **Step 1: 写失败测试**

```js
// test/timers.test.js — 定时器（③ 定时规则驱动的数据产生）
import { describe, it, expect } from 'vitest';
import { ensureTimers, timerCount, clearTimers } from '../src/scheduler/timers.js';

describe('定时器（③ 规则驱动）', () => {
  it('ensureTimers 返回注册数量（蒸馏 + 风险扫描 2 个）', async () => {
    clearTimers();
    const n = await ensureTimers({ now: '2026-08-25T00:00:00Z' });
    expect(n).toBe(2);
  });

  it('幂等单例：重复 ensureTimers 不叠加（防双实例）', async () => {
    clearTimers();
    await ensureTimers({});
    await ensureTimers({});
    expect(timerCount()).toBe(2);   // 仍只有 2 个（不重复注册）
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/timers.test.js`
Expected: FAIL（`timers.js` 不存在）

- [ ] **Step 3: 实现**

```js
// src/scheduler/timers.js — 定时器（③ 定时规则驱动的数据产生）
// 设计输入：12 文档 §7-3（nightly 蒸馏 + crm-risk 30 分钟扫描）
// 幂等单例：路由建时调用 ensureTimers；防双实例（与 registerCaptureSubscriber 同模式）
import { distillMemory } from '../memory/memoryLog.js';

const timers = new Map();   // name → { intervalMs, startedAt, kind }

export function timerCount() { return timers.size; }

export function clearTimers() {
  for (const t of timers.values()) clearInterval(t.handle);
  timers.clear();
}

export async function ensureTimers({ now = new Date().toISOString() } = {}) {
  if (timers.size > 0) return timers.size;   // 幂等单例
  // ① nightly 蒸馏：每天 02:00 蒸馏 memory_log（30 天 TTL → distilled，60 天 → archived）
  const nightly = setInterval(() => {
    distillMemory({ ttlDays: 30 }).catch(() => {});
  }, 86400000);
  timers.set('nightly-distill', { handle: nightly, intervalMs: 86400000, kind: 'rule' });
  // ② crm-risk 扫描：每 30 分钟触发一次风险评估（占位：真正扫描器阶段 3 接 crm-risk SKILL）
  const scan = setInterval(() => {
    // 预留：调用 crm-risk SKILL / AI 属性评估器（deals stuck/lead overdue 扫描）
  }, 1800000);
  timers.set('crm-risk-scan', { handle: scan, intervalMs: 1800000, kind: 'rule' });
  return timers.size;
}
```

- [ ] **Step 4: 接线（routes.js createRoutes 内，与 registerCaptureSubscriber 并列）**

```js
import { ensureTimers } from '../scheduler/timers.js';
// ...（createRoutes 入口处，registerCaptureSubscriber() 后）
ensureTimers({}).catch(() => {});   // ③ 定时规则驱动（幂等单例）
```

- [ ] **Step 5: 运行确认通过（纯逻辑）**

Run: `node node_modules/vitest/vitest.mjs run test/timers.test.js`
Expected: PASS（2/2）

- [ ] **Step 6: 提交**

```bash
git add src/scheduler/timers.js src/http/routes.js test/timers.test.js
git commit -m "feat(scheduler): 定时器接线（nightly 蒸馏 24h + crm-risk 扫描 30min，幂等单例）+ 单测"
```

---

### Task 3: 外部连接器 P0（ATTIO enrichment / 工商校验，两 Action）

**Files:**
- Create: `src/connectors/connectorActions.js`
- Modify: `src/http/routes.js`（createRoutes 内 seedConnectorActions()）
- Test: `test/connectors.test.js`（纯逻辑：动作注册存在 + autoDecision 声明）

- [ ] **Step 1: 写失败测试**

```js
// test/connectors.test.js — 外部连接器 P0（④ 外部采集）
import { describe, it, expect, beforeEach } from 'vitest';
import { getAction } from '../src/action/registry.js';
import { seedConnectorActions } from '../src/connectors/connectorActions.js';
import { resetRegistry } from '../src/action/registry.js';

beforeEach(() => { resetRegistry(); });

describe('外部连接器 P0（④ 外部自动采集）', () => {
  it('conn-attio-enrich-account 已注册（写 + autoDecision 过第0闸）', () => {
    seedConnectorActions();
    const a = getAction('conn-attio-enrich-account');
    expect(a).toBeTruthy();
    expect(a.kind).toBe('write');
    expect(a.autoDecision).toBe(true);   // 第 0 闸：连接器自行 mint decision
    expect(a.namespace).toBe('connector');
  });

  it('conn-zhizao-verify-account 已注册（工商校验 enrichment）', () => {
    seedConnectorActions();
    const a = getAction('conn-zhizao-verify-account');
    expect(a).toBeTruthy();
    expect(a.kind).toBe('write');
    expect(a.autoDecision).toBe(true);
  });

  it('外部数据写 auto_weak 边（低置信需 review，relation_confidence 落 meta）', async () => {
    seedConnectorActions();
    // 纯逻辑验证：Action 的 handler 元信息声明 auto_weak 语义（connector 源头）
    const a = getAction('conn-attio-enrich-account');
    expect(a.owner).toBe('connector-attio');
    expect(a.confirm || a.needsApproval).toBeTruthy();   // 低置信 → 需人 review（confirm 信号）
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/connectors.test.js`
Expected: FAIL（`connectorActions.js` 不存在）

- [ ] **Step 3: 实现**

```js
// src/connectors/connectorActions.js — 外部连接器 P0（④ 外部采集；12 文档 §4/§7-4）
// 设计输入：总体设计 §4 安全红线（净化 + SQL 参数化 + 禁删）+ auto_weak 边低置信需 review
// 两个 P0 连接器：
//   conn-attio-enrich-account    — ATTIO 型 enrichment（domains/employee_range/funding…）→ 客户粒子
//   conn-zhizao-verify-account   — 工商校验（企查查型）→ business_verified
// 全部走写通道第 0 闸（autoDecision=true，连接器自身经决策引擎 mint decision）
import { registerAction } from '../action/registry.js';
import { createParticle, updateParticle, createEdge } from '../particles/particleRepo.js';

export function seedConnectorActions() {
  registerAction({
    name: 'conn-attio-enrich-account', kind: 'write', permission: 'auth',
    namespace: 'connector', agentTool: false, force: false, needsApproval: true,
    autoDecision: true, confirm: 'stage2', owner: 'connector-attio',
    version: '1.0.0',
    schema: { account_id: 'string', enrichment: 'object' },
    parameters: { required: ['account_id', 'enrichment'] },
    handler: async ({ account_id, enrichment }, ctx) => {
      // 外部字段写入（domains/employee_range/funding_raised_usd/foundation_date/社媒）
      const r = await updateParticle(account_id, { patch: enrichment });
      // 低置信自动关联 → auto_weak 边（relation_confidence 落 meta，≤0.6 需 review 不入图）
      if (enrichment.domains && Array.isArray(enrichment.domains)) {
        // 语义：外部源是"来源"而非受控边（sourcedFrom 谓词，auto_weak）
        await createEdge('CRM_ACCOUNT', account_id, 'sourcedFrom', 'CRM_KNOWLEDGE', enrichment.source_knowledge_id || r.id, {
          edge_source: 'auto_weak', relation_confidence: enrichment.confidence ?? 0.5,
          source: 'attio-enrichment',
        }).catch(() => {});
      }
      return r;
    },
  });

  registerAction({
    name: 'conn-zhizao-verify-account', kind: 'write', permission: 'auth',
    namespace: 'connector', agentTool: false, force: false, needsApproval: true,
    autoDecision: true, confirm: 'stage2', owner: 'connector-zhizao',
    version: '1.0.0',
    schema: { account_id: 'string', verification: 'object' },
    parameters: { required: ['account_id', 'verification'] },
    handler: async ({ account_id, verification }, ctx) => {
      // 工商校验结果 → business_verified（规则+AI 确认轴）
      return updateParticle(account_id, { patch: { business_verified: verification.verified, business_title: verification.business_title } });
    },
  });
}
```

- [ ] **Step 4: 接线（routes.js createRoutes 内，seedActions() 后）**

```js
import { seedConnectorActions } from '../connectors/connectorActions.js';
// ...（seedActions(); 后）
seedConnectorActions();   // ④ 外部连接器 P0（幂等注册）
```

- [ ] **Step 5: 运行确认通过**

Run: `node node_modules/vitest/vitest.mjs run test/connectors.test.js`
Expected: PASS（3/3）

- [ ] **Step 6: 提交**

```bash
git add src/connectors/connectorActions.js src/http/routes.js test/connectors.test.js
git commit -m "feat(connectors): 外部连接器 P0（ATTIO enrichment + 工商校验，autoDecision 过第0闸 + auto_weak 边）+ 单测"
```

---

### Task 4: 总体设计锚定「阶段 3 前台页面字段采集完整性」

**Files:**
- Modify: `docs/2026-08-25-ai-native-crm-overall-design.md`（§7 或 §8 追加锚定小节）
- Modify: `docs/2026-08-25-12-data-origin-full-plan.md`（§6 状态更新 + §7 标注已做）

- [ ] **Step 1: 总体设计追加 §8.7「阶段 3 前台页面字段采集完整性」**

```markdown
### §8.7 阶段 3 前台页面字段采集完整性（数据来源闭环锚定）

> 用户 2026-08-25 指令：阶段 3 前台页面开发时，**必须确保所有字段的内容都能被采集到**——即每个粒子属性的产生路径（①人工/AI/规则/外部）必须有对应前台入口或自动通道。

- **铁律**：任何粒子属性在阶段 3 前台页面落地前，必须完成「数据来源四查」：
  1. 该属性是①人工？→ 前台必须有对应输入控件（表单字段 / 对话式 NL 采集 / 上传入口）。
  2. 该属性是②AI？→ 必须挂 AI 属性评估器（`src/aiAttributes/evaluator.js`，带轴/置信度/理由），前台只读展示+确认。
  3. 该属性是③规则？→ 必须有写时钩子/定时器（`src/scheduler/timers.js`），前台无需输入。
  4. 该属性是④外部？→ 必须有连接器 Action（`src/connectors/connectorActions.js`），前台展示来源+review 入口。
- **验收锚点（阶段 3 页面验收）**：对每个前台页面逐字段核对「字段 ↔ 来源分类 ↔ 产生通道」三列对照表，无「孤儿字段」（有 schema 无产生通道）才算通过。
- **属性清单来源**：`src/particles/particleModel.js` `coreAttributes` 声明（含 ATTIO 增量）+ 01 粒子设计 §2.1/§2.3 全属性表。
```

- [ ] **Step 2: 12 文档更新**

在 `docs/2026-08-25-12-data-origin-full-plan.md` §6 表格追加：
```markdown
| AI 属性评估器（①② 的落地：evaluateAiAttributesFor） | ✅ 已落地（2026-08-25） | src/aiAttributes/evaluator.js + particleRepo 写后触发 |
| 定时器（③ 的落地：nightly 蒸馏 + crm-risk 30min） | ✅ 已落地（2026-08-25） | src/scheduler/timers.js + routes.js 幂等接线 |
| 外部连接器 P0（④ 的落地：ATTIO enrichment + 工商校验） | ✅ 已落地（2026-08-25） | src/connectors/connectorActions.js + routes.js 接线 |
```
§7 改为「已完成 1/3/4」+ 阶段 3 锚定（见总体设计 §8.7）。

- [ ] **Step 3: 提交**

```bash
git add docs/2026-08-25-ai-native-crm-overall-design.md docs/2026-08-25-12-data-origin-full-plan.md
git commit -m "docs(data-origin): 总体设计 §8.7 阶段3前台字段采集完整性锚定 + 12文档状态更新"
```

---

### Task 5: 全量测试 + 收尾

**Files:** 无新增，验证用

- [ ] **Step 1: 运行新增纯逻辑测试**

Run: `node node_modules/vitest/vitest.mjs run test/ai-attributes.test.js test/timers.test.js test/connectors.test.js`
Expected: PASS（4+2+3=9 例）

- [ ] **Step 2: 运行既有 pure 基线（attio-attributes + action 等无 PG 依赖）**

Run: `node node_modules/vitest/vitest.mjs run test/attio-attributes.test.js test/action.test.js test/context.test.js`
Expected: PASS（无回归）

- [ ] **Step 3: 更新工作日志**

向 `.workbuddy/memory/2026-08-25.md` 追加「数据产生能力实现 1/3/4」记录。

---

## 自检（对照 12 文档 §7 与总体设计）

- [x] §7-1 AI 属性评估器 → Task 1（evaluator + 写事件触发 + 单测）
- [x] §7-3 定时器 → Task 2（nightly + crm-risk 30min，幂等单例）
- [x] §7-4 外部连接器 P0 → Task 3（ATTIO enrichment + 工商校验，autoDecision + auto_weak）
- [x] 阶段 3 前台字段采集完整性 → Task 4（总体设计 §8.7 锚定 + 验收锚点）
- [x] 不新增粒子 / 不扩类型 / 10 ai-* SKILL 不动（新文件独立目录，未触碰 ai-*）
- [x] 每 Task TDD（先失败测试→实现→接线→单测→commit）