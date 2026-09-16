# Q5 · lead-fit 评分器实施计划（discovery 域「认知评分」的真实实现）

> **状态**：⏳ 待批准（批准后按 Task 顺序执行；未批准不写实现代码）
> **设计入口**：`docs/2026-09-10-lead-discovery-design.md` §5 数据模型 + §0.5 P1（**已批准设计**，本计划是其「从未落地」部分的补齐，非新能力立项）
> **前置依赖**：无。可独立于 Q1/Q3 并行实施。
> **日期**：2026-09-16
> **来源**：`docs/2026-09-15-final-design-coexistence-and-proactive.md` §附录 E.2.1 **处置②**「根治：实现 `ctx.rescore` 与 `ctx.getAccount`」

---

## §0 现状复跑（判据，非快照）

编制本计划前对全部相关点逐条复跑，**推翻**了「A-B7 属从零新建能力」的初始判断——机制在仓内**已存在**，缺的是 discovery 域的组装。

| # | 判据（可直接复跑） | 实测 | 结论 |
|---|---|---|---|
| ① | `grep -n "buildDiscoveryPayload" src/agent/discoveryOrchestrator.js` | `:91` → `buildDiscoveryPayload(0.5, 0.5, signals, ...)` | 🔴 **硬编码占位写库** |
| ② | `grep -rn "rules\.signals" src/ \| grep -v prospecting` | **0 命中** | 🔴 `discovery-rules.signals` 权重表**零消费** |
| ③ | `grep -rn "rules\.icp\|icp\.min_headcount" src/ \| grep -v prospecting` | 仅 `src/web/discovery-rules.html`（UI） | 🔴 ICP 规则**后端零消费** |
| ④ | `grep -rn "signal_time_fields" src/` | 仅定义处 `config/discoveryRules.js:43` | 🔴 **零消费** |
| ⑤ | `grep -n "monitorAccount" src/scheduler/timers.js` | `:181` 调用 / `:506` 只注入函数 | 🔴 **ctx 四件套零装配**（`E.2.1` 已留痕，未根治） |
| ⑥ | `grep -rn "getAccount\|rescore" src/ \| grep -v monitorAccount.js"` | 仅 `timers.js:178` 的注释 | 🔴 生产零实现 |
| ⑦ | `grep -rn "signal_age_tiers" src/` | discovery 域 0；**prospecting 域已有真实消费**（`prospectingRules.js:76` + `methodOutreachHook.js:39`） | 🟢 **复用对象已存在** |
| ⑧ | `grep -rn "mintDecision" src/scheduler/timers.js` | `:528`（A-B6 落地） | 🟢 第 0 闸铸造范式**已在位** |

> **判据纪律**：全部判据的否定形式（"零消费""零装配"）均已按 `anti-fake-green-probe` 要求做**全仓 + 排除自身定义处**的双重确认，不用单例截图下结论。

---

## §1 缺口定位：5 个症状 = 1 个缺失

```
                    ┌─────────────────────────────────────────────┐
                    │  discovery 域「认知评分器」从未实现          │
                    │  （设计 §5 要求 icp_fit_score / intent_score）│
                    └───────────────────┬─────────────────────────┘
                                        │ 表现为 5 个同族症状
        ┌───────────────┬───────────────┼───────────────┬────────────────┐
        ▼               ▼               ▼               ▼                ▼
  ①占位 0.5      ②signals 权重    ③icp 规则      ④signal_time     ⑤monitorAccount
  写进 payload     零消费           零消费          _fields 零消费     ctx 零装配
  (discovery       (配置已播种)     (配置已播种)    (配置已播种)      (结构性 TypeError)
   Orchestrator:91)                                                    → C3 闭环从未执行
```

**关键结论**：这**不是** 5 个独立缺陷，而是同一个缺失的 5 个投影。分别修会造出 5 处"看似通了"的假绿；**必须一次装配到同一条链**。

### 1.1 为什么这是「按已批准设计补齐」而非「新建能力」

`docs/2026-09-10-lead-discovery-design.md`（已批准）已逐项定义：

| 设计条文 | 原文 |
|---|---|
| §0 F4 | 「双维评分 \| 复用**同一套九标尺 + concept_refs 认知决策引擎**输出评分」→ ⚠ **见 §2 陷阱①，此处设计表述与实现落点有偏差** |
| §0.5 P1 | 「本体优先富集 + **认知评分** + 可组合编排骨架（C1）」= P1 交付范围 |
| §1 映射 | 「KMD 认知决策 → 谁值得发现 + 评分 = discovery decision_scenario，复用引擎 + **新 scenario 行**」 |
| §5 数据模型 | `icp_fit_score` / `intent_score` 各带 `judge{axis:'capability', rule_ref:'scenario:lead-fit#ruler:*'}` |
| §2 环节③ | 「对既有 `CRM_ACCOUNT` **重跑 lead-fit 评分**（复用九标尺+2D judge）」 |

⇒ 设计**已批准且明确**，缺的只是 `rescore` 这一环的代码。故走 **writing-plans → 执行**，不需重新 brainstorming。

---

## §2 三个语义陷阱（**实施前必读，踩中任一个都会产出"通了但错了"的实现**）

### 陷阱①：「九尺子」是**同名异物**——`rubricScorer` 不可用于 lead-fit

| | `src/decision/rubricScorer.js`（九尺子） | lead-fit 的 `ruler` |
|---|---|---|
| 9 个维度 | `clarity` 清晰性 / `accuracy` 准确性 / `precision` 精确性 / `relevance` 相关性 / `depth` 深度 / `breadth` 广度 / `logic` 逻辑性 / `importance` 重要性 / `fairness` 公平性 | （**非九项**）`industry` / `hiring_icp_role` / `funding_round` / `tender_match` / `leadership_change` / `tech_adopt` / `website_redesign` / `social_content` |
| 评什么 | **决策叙述的质量**（"这条推理写得清不清楚"） | **线索的匹配度与意向**（"这家公司像不像我们的客户"） |
| 取值 | 0–4（加权归一 → ratio） | 权重表直接给 0–1 |

⛔ **若把 `rubricScorer.scoreDecision` 接成 `ctx.rescore`，会把「叙述写得好」当成「客户意向高」** —— 分数看似合理、链路看似跑通，是典型"用错工具让链路显绿"。**本计划明确禁止**。

> 设计 §0 F4 写"复用同一套九标尺"，属**设计表述的精度不足**（它想表达的是"复用平台的评分范式与 glass-box 输出"，而非"复用 rubricScorer 的 9 个维度"）。本计划的实现选择**确定性权重表**，理由见陷阱②与 §1.1 的 §5 原文（`rule_ref` 指向 `ruler:industry` / `ruler:hiring`，即信号规则，非叙述维度）。

### 陷阱②：discovery 与 prospecting 的**信号键不同名** → 直接复用会恒 0

| 域 | 信号键 | 出处 |
|---|---|---|
| discovery | **全称**：`funding_round` / `hiring_icp_role` / `tender_match` / `leadership_change` / `tech_adopt` / `website_redesign` / `social_content` | `config/discoveryRules.js:32-40` |
| prospecting | **简写**：`hiring` / `funding` / `tender` / `social` | `config/prospectingRules.js:16` |

`prospectingRules.computeFitScore` 的循环是 `for (const [k, weight] of Object.entries(rules.signals))` + `if (!signals[k]) continue;`。**把 discovery 的 signals 直接喂进去 → 7 个键全部不匹配 → `num=0` → 返回 0**（fail-closed 但不正确：是**静默的错值**，不是显式错误）。

⇒ 本计划的纪律：**复用它的「纯函数」（`signalFreshness.js`），复刻它的「评分循环」，但权重表用 discovery 自己的**。跨域共用被禁止。

### 陷阱③：注释承诺 ≠ 实现（第 N 次同族）

`src/connectors/discovery/adapters/qixin.js:2` 写：

> `// 信号字段名 funding_round/hiring_icp_role/tender_match 命中 discoveryRules.signals 既有权重键 → 自动进 intent_score`

**这句话是假的**——判据②已证全仓 0 处读 `discoveryRules.signals`。`qixin.js:10` 同样措辞。⇒ 本计划 LF-1 落地后，这句话才**第一次为真**；LF-5 需补一条断言锁死它。

### 补充边界：`min_confidence` 语义**全仓无定义**

`grep -rn "min_confidence" docs/` → **0**；`grep -rn "confidence" src/connectors/discovery/waterfall.js` → **0**。该配置既无设计定义、又无消费方、且富化值形状（`{value, provider, ts}`）里**没有** `confidence` 字段。

⇒ **本批次不消费 `min_confidence`**（不猜测语义、不假填充）。登记为待定义项（见 §4）。

---

## §3 任务拆分（6 个 Task，可独立于 Q1/Q3 并行）

| Task | 内容 | 性质 | 风险 |
|---|---|---|---|
| **LF-1** | 新建 `src/connectors/discovery/leadFitScorer.js`：纯函数双维评分器 + 单测 | 新建（纯函数，零 IO） | 低 |
| **LF-2** | `discoveryOrchestrator.js:88-91` 占位 `0.5` → 真评分 | 接线 | 低（有既有测试需同步） |
| **LF-3** | 新建 `src/connectors/discovery/monitorCtx.js`：ctx 四件套装配（含第 0 闸 fail-closed） | 新建（装配层） | 中 |
| **LF-4** | `timers.js` 富化路径接线 `buildMonitorCtx`（修改 `runIntegrationPollOnce`） | 接线 | **高**（并行会话热点文件） |
| **LF-5** | 假绿反证：断言「**生产构造方存在**」而非 grep 函数定义 | 验收 | 低 |
| **LF-6** | 端到端冒烟（真库）：真评分 → 写 payload → monitorAccount 真跑通 | 验收 | 中 |

> **执行顺序硬约束**：LF-4 必须在 LF-1/LF-3 之后。**若先接 timers，接线会指向不存在的实现** → 变成"接线了但调用空函数"（本仓已登记反模式）。

---

## Task LF-1：新建 lead-fit 双维评分器（纯函数）

**产出**：`src/connectors/discovery/leadFitScorer.js` + `test/connectors/discovery/leadFitScorer.test.js`

### Step 1：写失败测试

**文件**：`test/connectors/discovery/leadFitScorer.test.js`（完整，可直接落盘）

```js
import { describe, it, expect } from 'vitest';
import {
  computeIntentScore, computeIcpFit, scoreLeadFit,
  LEAD_FIT_FIT_RULE, LEAD_FIT_INTENT_RULE,
} from '../../../src/connectors/discovery/leadFitScorer.js';

// 与 config/discoveryRules.js:32-40 同形的权重表（键为**全称**——陷阱②）
const RULES = {
  signals: {
    funding_round: { weight: 0.9 }, hiring_icp_role: { weight: 0.7 }, tender_match: { weight: 0.8 },
    leadership_change: { weight: 0.5 }, tech_adopt: { weight: 0.6 },
    website_redesign: { weight: 0.3 }, social_content: { weight: 0.4 },
  },
  signal_time_fields: { funding_round: 'funding_ts', hiring_icp_role: 'hiring_ts' },
  signal_age_tiers: [
    { max_days: 7, multiplier: 1.0 }, { max_days: 30, multiplier: 0.6 },
    { max_days: 90, multiplier: 0.3 }, { max_days: null, multiplier: 0.1 },
  ],
  icp: { industries: ['industrial_coatings', 'chemical'], min_headcount: 50, geo: ['CN'] },
};

describe('computeIntentScore（信号加权 × 时间衰减）', () => {
  it('① 全命中且满分 → 1.0', () => {
    const now = Date.parse('2026-09-16T00:00:00Z');
    const sigs = Object.keys(RULES.signals).map((t) => ({ type: t, ts: '2026-09-15T00:00:00Z' }));
    const r = computeIntentScore(sigs, RULES, now);
    expect(r.value).toBeCloseTo(1.0, 4);
    expect(r.denominator).toBeCloseTo(0.9 + 0.7 + 0.8 + 0.5 + 0.6 + 0.3 + 0.4, 4);
  });

  it('② 零信号 → 0（不是 0.5！占位值与真实值的区分断言）', () => {
    expect(computeIntentScore([], RULES).value).toBe(0);
  });

  it('③ 单信号命中 → weight/sum(weights)', () => {
    const now = Date.parse('2026-09-16T00:00:00Z');
    const r = computeIntentScore([{ type: 'funding_round', ts: '2026-09-15T00:00:00Z' }], RULES, now);
    expect(r.value).toBeCloseTo(0.9 / 4.2, 4); // Σ权重 = 4.2
  });

  it('④ 时间衰减生效：31 天前 → ×0.6（对应 signal_age_tiers）', () => {
    const now = Date.parse('2026-09-16T00:00:00Z');
    const r = computeIntentScore([{ type: 'funding_round', ts: '2026-08-16T00:00:00Z' }], RULES, now);
    expect(r.value).toBeCloseTo((0.9 * 0.6) / 4.2, 4);
  });

  it('⑤ 无 ts → 不衰减（向后兼容，mult=1.0）', () => {
    const r = computeIntentScore([{ type: 'funding_round' }], RULES);
    expect(r.breakdown.find((b) => b.key === 'funding_round').mult).toBe(1.0);
  });

  it('⑥ signal_time_fields 映射被消费（ts 由映射字段取到）', () => {
    const now = Date.parse('2026-09-16T00:00:00Z');
    const withTs = computeIntentScore([{ type: 'funding_round', funding_ts: '2026-09-15T00:00:00Z' }], RULES, now);
    expect(withTs.breakdown.find((b) => b.key === 'funding_round').mult).toBe(1.0);
    expect(withTs.value).toBeGreaterThan(0);
  });

  // ⚠ 假绿反证：prospecting 的简写键喂进来必须全部未命中（证明「跨域键不通用」）
  it('⑦ 反证：prospecting 简写键({funding:true}) 不命中 discovery 权重表 → 0', () => {
    const r = computeIntentScore([{ type: 'funding' }, { type: 'hiring' }], RULES);
    expect(r.value).toBe(0);
    expect(r.breakdown.every((b) => b.hit === false)).toBe(true);
  });

  it('⑧ 同类型多信号不叠加（首次命中为准）', () => {
    const a = computeIntentScore([{ type: 'funding_round', ts: '2026-09-15T00:00:00Z' }], RULES);
    const b = computeIntentScore([
      { type: 'funding_round', ts: '2026-09-15T00:00:00Z' },
      { type: 'funding_round', ts: '2026-09-15T00:00:00Z' },
    ], RULES);
    expect(b.value).toBeCloseTo(a.value, 6);
  });
});

describe('computeIcpFit（行业/规模/地域三维）', () => {
  it('① 三维全中 → 1.0', () => {
    const acct = { payload: { enrichment: {
      industry: { value: 'chemical', provider: 'gaode' },
      headcount: { value: 120, provider: 'gaode' },
      country: { value: 'CN', provider: 'gaode' },
    } } };
    const r = computeIcpFit(acct, RULES);
    expect(r.value).toBeCloseTo(1.0, 4);
    expect(r.degraded).toBe(false);
  });

  it('② 行业不匹配 → 1/3', () => {
    const acct = { payload: { enrichment: {
      industry: { value: 'retail' }, headcount: { value: 120 }, country: { value: 'CN' },
    } } };
    expect(computeIcpFit(acct, RULES).value).toBeCloseTo(1 / 3, 4);
  });

  it('③ 缺全部维 → 0 且 degraded=true（**不假填充**，不是 0.5）', () => {
    const r = computeIcpFit({ payload: {} }, RULES);
    expect(r.value).toBe(0);
    expect(r.degraded).toBe(true);
    expect(r.unjudged).toEqual(['industry', 'headcount', 'geo']);
  });

  it('④ 部分缺维：分母只计「可判定维」（不把未知算作未命中）', () => {
    const acct = { payload: { enrichment: { industry: { value: 'chemical' } } } }; // 只有行业
    const r = computeIcpFit(acct, RULES);
    expect(r.value).toBeCloseTo(1.0, 4);   // 可判定维=1，命中=1
    expect(r.degraded).toBe(true);          // 但标记降级（缺 2 维）
  });

  it('⑤ 兼容顶层字段（未经 enrichment 包装）', () => {
    const acct = { payload: { industry: 'chemical', headcount: 80, country: 'CN' } };
    expect(computeIcpFit(acct, RULES).value).toBeCloseTo(1.0, 4);
  });
});

describe('scoreLeadFit 统一入口', () => {
  it('返回设计 §5 要求的双维 + ruleRefs + 可解释 breakdown', () => {
    const out = scoreLeadFit({
      account: { payload: { enrichment: { industry: { value: 'chemical' } } } },
      signals: [{ type: 'funding_round', ts: new Date().toISOString() }],
      rules: RULES,
    });
    expect(out.ruleRefs.fit).toBe(LEAD_FIT_FIT_RULE);
    expect(out.ruleRefs.intent).toBe(LEAD_FIT_INTENT_RULE);
    expect(out.icp_fit).toBeGreaterThan(0);
    expect(out.intent).toBeGreaterThan(0);
    expect(out.breakdown.intent.length).toBe(7);       // 每个权重键一条可解释记录
    expect(typeof out.degraded.icp).toBe('boolean');
  });

  it('空 rules → 不抛错、不假填充（value 0 + degraded）', () => {
    const out = scoreLeadFit({ account: {}, signals: [], rules: {} });
    expect(out.icp_fit).toBe(0);
    expect(out.intent).toBe(0);
    expect(out.degraded.intent).toBe(true);
  });
});

describe('语义边界（陷阱①：不得复用 rubricScorer 的 9 维）', () => {
  it('本模块导出的 ruleRef 是信号规则，**不含** clarity/accuracy 等叙述维度', () => {
    for (const ref of [LEAD_FIT_FIT_RULE, LEAD_FIT_INTENT_RULE]) {
      expect(ref.startsWith('scenario:lead-fit#ruler:')).toBe(true);
      expect(['clarity', 'accuracy', 'precision', 'relevance', 'depth', 'breadth', 'logic', 'importance', 'fairness']
        .some((k) => ref.includes(k))).toBe(false);
    }
  });
});
```

### Step 2：运行，确认失败

```powershell
cd D:\system\CRM-ai-native
npx vitest run test/connectors/discovery/leadFitScorer.test.js
```
**预期**：`Failed to resolve import`（模块不存在）。**这是预期失败**，证明测试真的在测新代码。

### Step 3：实现（完整文件，可直接落盘）

**文件**：`src/connectors/discovery/leadFitScorer.js`

```js
// src/connectors/discovery/leadFitScorer.js — lead-fit 双维评分器
//   （设计 docs/2026-09-10-lead-discovery-design.md §5 数据模型的落地实现）
//
// 立论：设计 §5 规定 CRM_ACCOUNT.payload.discovery 须含 icp_fit_score / intent_score
//   （各带 capability 轴 judge + rule_ref）。但截至 2026-09-16，生产写入的是**硬编码占位 0.5**
//   （discoveryOrchestrator.js:91「初值占位」）。本文件是该占位的真实实现。
//
// ⚠ 边界①（**最关键，勿混用**）：lead-fit 的 "ruler" = **线索判定规则**
//   （industry / hiring_icp_role / funding_round / tender_match …），权重表 = discovery-rules.signals。
//   而九尺子（src/decision/rubricScorer.js）的 ruler = **决策叙述质量**
//   （clarity/accuracy/precision/relevance/depth/breadth/logic/importance/fairness）。
//   二者**同名异物**：rubricScorer **不可**用于 lead-fit —— 会把「叙述写得好」当成「客户意向高」。
//
// ⚠ 边界②（第二关键）：discovery 域信号键为**全称**
//   （funding_round/hiring_icp_role/tender_match/leadership_change/tech_adopt/website_redesign/social_content），
//   prospecting 域为**简写**（hiring/funding/tender/social）。
//   ⇒ **不得**把 discovery signals 喂给 prospectingRules.computeFitScore —— 键不匹配会**全部未命中**
//      → 恒返回 0 的**静默错值**。本文件只复用其**纯函数**（signalFreshness），评分循环按 discovery 权重表自建。
//
// 铁律：
//   ① 纯函数、零 IO、零 DB、不新增粒子、禁 DELETE（本模块无写操作）
//   ② 权重/阈值 100% 来自 rules（config_store['discovery-rules']），禁硬编码
//   ③ 无证据不假填充：缺字段 → 该项计 0 + degraded 标记，绝不编造分值
//   ④ 不做时间衰减默认值兜底推理：无 ts / 空档 → 1.0（与 signalFreshness 向后兼容语义一致）
import { freshnessMultiplier, ageDaysOf } from '../../config/signalFreshness.js';

// 设计 §5 的 rule_ref 契约（禁改字符串：glass-box 与 UI 依赖它定位"为何此刻判定为目标客户"）
export const LEAD_FIT_FIT_RULE = 'scenario:lead-fit#ruler:industry';
export const LEAD_FIT_INTENT_RULE = 'scenario:lead-fit#ruler:hiring_icp_role';

// 取信号时间戳：优先信号自带 ts → 键名映射字段 → rules.signal_time_fields 配置
function tsOf(sig, key, rules) {
  if (sig && typeof sig === 'object') {
    if (sig.ts) return sig.ts;
    if (sig[`${key}_ts`]) return sig[`${key}_ts`];
    const map = (rules && rules.signal_time_fields) || {};
    if (map[key] && sig[map[key]]) return sig[map[key]];
  }
  return null;
}

// 权重归一：允许 {weight:n} 或直接 n 两种形状（出厂=对象，租户覆盖可能给数字）
function weightOf(cfg) {
  const w = typeof cfg === 'number' ? cfg : (cfg && cfg.weight);
  return typeof w === 'number' ? w : null;
}

/**
 * intent_score：Σ(命中信号 × 权重 × 时间衰减) / Σ权重
 *   - 命中判定 = signals[].type 出现在权重表中；未命中按 0 计（但**分母仍计入**，设计 §5 语义）
 *   - 同类型多次出现**不叠加**（首次命中为准）
 *   - 时间衰减：rules.signal_age_tiers（空档 → 1.0，向后兼容）
 * @returns {{value:number, numerator:number, denominator:number, breakdown:Array, degraded:boolean}}
 */
export function computeIntentScore(signals = [], rules = {}, now = Date.now()) {
  const weights = (rules && rules.signals) || {};
  const tiers = (rules && rules.signal_age_tiers) || [];
  const list = Array.isArray(signals) ? signals : [];

  // 首次命中为准
  const hit = new Map();
  for (const s of list) {
    const key = typeof s === 'string' ? s : (s && s.type);
    if (key && !hit.has(key)) hit.set(key, s);
  }

  let num = 0; let den = 0; const breakdown = [];
  for (const [key, cfg] of Object.entries(weights)) {
    const weight = weightOf(cfg);
    if (weight === null) continue;              // 非数值权重：跳过（不计入分母，避免污染归一）
    den += weight;
    if (!hit.has(key)) {
      breakdown.push({ key, weight, hit: false, mult: 0, contribution: 0 });
      continue;
    }
    const mult = tiers.length ? freshnessMultiplier(ageDaysOf(tsOf(hit.get(key), key, rules), now), tiers) : 1.0;
    const contribution = weight * mult;
    num += contribution;
    breakdown.push({ key, weight, hit: true, mult, contribution });
  }

  return {
    value: den > 0 ? Number((num / den).toFixed(4)) : 0,
    numerator: Number(num.toFixed(4)),
    denominator: Number(den.toFixed(4)),
    breakdown,
    degraded: den === 0,                        // 无权重表 ⇒ 无法评分（显式降级，不返 0.5）
  };
}

// 富化值解包：{value, provider, ts} → value；裸值原样返回
function unwrap(v) {
  if (v && typeof v === 'object' && !Array.isArray(v) && 'value' in v) return v.value;
  return v;
}

/**
 * icp_fit_score：ICP 三维匹配（行业 / 规模 / 地域），命中率 = 命中维数 / **可判定**维数
 *   - 字段来源：payload.enrichment.* （优先）→ payload.* （兼容顶层裸字段）
 *   - 缺维不计入分母，但标 degraded（**不把"未知"当"未命中"** —— 二者语义不同）
 *   - ⚠ rules.icp.min_confidence **本批次不消费**：其语义在全仓无定义（docs/src 零命中），
 *     且富化值形状无 confidence 字段。登记待定义（见计划 §4），不猜测实现。
 * @returns {{value:number, checks:Array, degraded:boolean, unjudged:string[]}}
 */
export function computeIcpFit(account = {}, rules = {}) {
  const icp = (rules && rules.icp) || {};
  const payload = (account && account.payload) || account || {};
  const enrich = (payload && payload.enrichment) || {};
  const get = (k) => unwrap(payload[k] !== undefined ? payload[k] : enrich[k]);

  const checks = [];
  const industries = Array.isArray(icp.industries) ? icp.industries : [];
  if (industries.length) {
    const actual = get('industry');
    checks.push({
      dim: 'industry', expect: industries, actual: actual ?? null,
      ok: actual == null || actual === '' ? null : industries.includes(String(actual)),
    });
  }
  const minHc = Number(icp.min_headcount);
  if (Number.isFinite(minHc)) {
    const actual = get('headcount');
    checks.push({
      dim: 'headcount', expect: `>=${minHc}`, actual: actual ?? null,
      ok: actual == null ? null : Number(actual) >= minHc,
    });
  }
  const geo = Array.isArray(icp.geo) ? icp.geo : [];
  if (geo.length) {
    const actual = get('country') ?? get('region');
    checks.push({
      dim: 'geo', expect: geo, actual: actual ?? null,
      ok: actual == null || actual === '' ? null : geo.includes(String(actual)),
    });
  }

  const judged = checks.filter((c) => c.ok !== null);
  const hitCount = judged.filter((c) => c.ok).length;
  return {
    value: judged.length ? Number((hitCount / judged.length).toFixed(4)) : 0,
    checks,
    degraded: judged.length === 0 || judged.length < checks.length,
    unjudged: checks.filter((c) => c.ok === null).map((c) => c.dim),
  };
}

/**
 * 统一入口：一次算出双维（供 discoveryOrchestrator 与 monitorCtx 共用，保证两条路径**同源**）
 * @returns {{icp_fit:number, intent:number, ruleRefs:{fit:string,intent:string},
 *            breakdown:{icp:Array,intent:Array}, degraded:{icp:boolean,intent:boolean}}}
 */
export function scoreLeadFit({ account = {}, signals = [], rules = {}, now = Date.now() } = {}) {
  const intent = computeIntentScore(signals, rules, now);
  const icp = computeIcpFit(account, rules);
  return {
    icp_fit: icp.value,
    intent: intent.value,
    ruleRefs: { fit: LEAD_FIT_FIT_RULE, intent: LEAD_FIT_INTENT_RULE },
    breakdown: { icp: icp.checks, intent: intent.breakdown },
    degraded: { icp: icp.degraded, intent: intent.degraded },
  };
}
```

### Step 4：运行，确认全绿

```powershell
npx vitest run test/connectors/discovery/leadFitScorer.test.js
```
**预期**：全部通过（约 15 例）。

### Step 5：提交

```powershell
cd D:\system\CRM-ai-native
git add src/connectors/discovery/leadFitScorer.js test/connectors/discovery/leadFitScorer.test.js
git commit -m "feat(discovery): lead-fit 双维评分器(确定性权重+时间衰减), 替占位0.5"
```

---

## Task LF-2：`runDiscovery` 占位 `0.5` → 真实评分

**产出**：`src/agent/discoveryOrchestrator.js` 的 ⑦ 段改造

### Step 1：先写「占位不再出现」的断言（防回归）

追加到 `test/agent/discoveryOrchestrator.test.js`（既有文件，**新增 describe，不改既有断言**）：

```js
describe('⑦ 真实评分（LF-2，2026-09-16）：占位 0.5 已被真实评分取代', () => {
  it('零信号 → intent_score 为 0（而非占位 0.5）', async () => {
    const out = await runDiscovery(
      { tenantId: 'system', decision_id: 'd1' },
      { seed: { name: 'XX 化工' } },
      { rules: { signals: { funding_round: { weight: 0.9 } }, icp: { industries: ['chemical'] } },
        adapters: [], find: async () => null,
        create: async () => ({ id: 'a1' }), update: async () => ({}), createEdge: async () => ({}) }
    );
    expect(out.payload.discovery.intent_score.value).toBe(0);   // 关键：不是 0.5
  });

  it('命中信号 → intent_score > 0 且带设计 §5 的 rule_ref', async () => {
    const out = await runDiscovery(
      { tenantId: 'system', decision_id: 'd1' },
      { seed: { name: 'XX 化工' } },
      { rules: { signals: { funding_round: { weight: 0.9 } } },
        adapters: [{ id: 'stub', coverageFields: ['funding_round'], kind: 'internal-signal',
          run: async () => ({ values: { funding_round: { value: true, provider: 'stub', ts: new Date().toISOString() } }, cost: 0 }) }],
        find: async () => null, create: async () => ({ id: 'a1' }), update: async () => ({}), createEdge: async () => ({}) }
    );
    expect(out.payload.discovery.intent_score.value).toBeGreaterThan(0);
    expect(out.payload.discovery.intent_score.judge.rule_ref).toBe('scenario:lead-fit#ruler:hiring_icp_role');
  });
});
```

> ⚠ **实施提示**：`runDiscovery` 的 deps 注入形状以**实际签名为准**（`discoveryOrchestrator.js:38` 的 `deps`），上例中的 `adapters`/`find`/`create`/`update` 键名需对照该处实现调整；若既有测试文件已构造了可复用的 deps 工厂，**优先复用**它，避免造第二套替身（"替身形状掩盖缺陷"的本仓反模式）。

### Step 2：改造 ⑦ 段

**改动点**：`src/agent/discoveryOrchestrator.js:88-91`

**原**：
```js
  // ⑦ 评分入 payload：初值占位，真实评分由 lead-fit 场景（Task 6）经 decision 回写（glass-box 见 Task 15）
  //    decisionId 取**真实**第 0 闸 mint 值（不是 'pending'）→ why_narrative 可溯源到具体决策
  const signals = Object.entries(values).map(([field, v]) => ({ type: field, provider: v?.provider, ts: v?.ts }));
  const discovery = buildDiscoveryPayload(0.5, 0.5, signals, decisionId || 'pending');
```

**新**：
```js
  // ⑦ 评分入 payload：**真实** lead-fit 双维评分（LF-2，2026-09-16）
  //   此前为硬编码占位 buildDiscoveryPayload(0.5, 0.5, ...) —— 注释承诺「由 lead-fit 场景回写」从未落地；
  //   判据（可复跑）：旧实现下 grep -n "0.5, 0.5" src/agent/discoveryOrchestrator.js 非 0。
  //   评分器与 monitorCtx.rescore **共用 scoreLeadFit** ⇒ 两条路径同源，不会出现"发现时 0.3、重评时 0.8"的分裂。
  //   铁律：不假填充 —— 零信号则 intent=0、缺 ICP 字段则 icp_fit=0 且 degraded，绝不返 0.5 冒充"中等意向"。
  const signals = Object.entries(values).map(([field, v]) => ({ type: field, provider: v?.provider, ts: v?.ts }));
  const scored = scoreLeadFit({ account: { payload: { ...seed, enrichment } }, signals, rules });
  const discovery = buildDiscoveryPayload(scored.icp_fit, scored.intent, signals, decisionId || 'pending', {
    ruleRef: scored.ruleRefs,
  });
  // 可解释性与降级必须随 payload 一同落库（否则 UI 无从判断「0 分」是"没意向"还是"没数据"）
  discovery.score_breakdown = scored.breakdown;
  discovery.score_degraded = scored.degraded;
```

**并在文件头 import 段追加**：
```js
import { scoreLeadFit } from '../connectors/discovery/leadFitScorer.js';
```

### Step 3：跑既有 + 新增

```powershell
npx vitest run test/agent/discoveryOrchestrator.test.js test/agent/discoverySchema.test.js test/agent/glassBox.test.js
```
**预期**：全部通过。若 `glassBox.test.js` 断言 `rule_ref` 具体值，需确认新值仍是 `scenario:lead-fit#ruler:*`（**是**，因为 `buildDiscoveryPayload` 的默认值未变，且 LF-1 的常量与之逐字一致）。

### Step 4：提交

```powershell
cd D:\system\CRM-ai-native
git add src/agent/discoveryOrchestrator.js test/agent/discoveryOrchestrator.test.js
git commit -m "feat(discovery): runDiscovery 用真实 lead-fit 评分替换硬编码占位0.5"
```

---

## Task LF-3：新建 `monitorCtx` 装配层（ctx 四件套 + 第 0 闸）

**产出**：`src/connectors/discovery/monitorCtx.js` + `test/connectors/discovery/monitorCtx.test.js`

### Step 1：写失败测试

**文件**：`test/connectors/discovery/monitorCtx.test.js`（完整）

```js
import { describe, it, expect, vi } from 'vitest';
import { createMonitorCtx } from '../../../src/connectors/discovery/monitorCtx.js';

const RULES = { signals: { funding_round: { weight: 0.9 } }, icp: { industries: ['chemical'] } };

describe('createMonitorCtx（ctx 四件套装配）', () => {
  it('① 四件套齐备且可调用（生产装配判据的结构面）', () => {
    const ctx = createMonitorCtx({ tenantId: 'system', deps: {} });
    for (const k of ['getAccount', 'rescore', 'appendMemory', 'updateParticle']) {
      expect(typeof ctx[k], k).toBe('function');
    }
  });

  it('② getAccount 走注入的 getParticle（不新建粒子）', async () => {
    const getParticle = vi.fn(async (id) => ({ id, payload: {} }));
    const ctx = createMonitorCtx({ tenantId: 'system', deps: { getParticle } });
    const a = await ctx.getAccount('acc1');
    expect(getParticle).toHaveBeenCalledWith('acc1', { tenantId: 'system' });
    expect(a.id).toBe('acc1');
  });

  it('③ rescore 返回 {score, ruleRef} 且与 scoreLeadFit 同源', async () => {
    const getParticle = vi.fn(async () => ({ id: 'acc1', payload: { enrichment: { industry: { value: 'chemical' } } } }));
    const ctx = createMonitorCtx({ tenantId: 'system', deps: { getParticle, loadRules: async () => RULES } });
    const r = await ctx.rescore('acc1', { signals: [{ type: 'funding_round', ts: new Date().toISOString() }] });
    expect(r.score).toBeGreaterThan(0);
    expect(r.ruleRef).toBe('scenario:lead-fit#ruler:hiring_icp_role');
  });

  // ⚠ 第 0 闸：写操作 fail-closed
  it('④ 无 decisionId → updateParticle 拒绝写入（decision_required）', async () => {
    const updateParticle = vi.fn(async () => ({}));
    const ctx = createMonitorCtx({ tenantId: 'system', deps: { updateParticle, decisionId: null } });
    await expect(ctx.updateParticle('acc1', { patch: {} })).rejects.toThrow(/decision_required/);
    expect(updateParticle).not.toHaveBeenCalled();
  });

  it('⑤ 有 decisionId → 透传 requireDecisionId（写路径可溯源）', async () => {
    const updateParticle = vi.fn(async () => ({}));
    const ctx = createMonitorCtx({ tenantId: 'system', deps: { updateParticle, decisionId: 'd-42' } });
    await ctx.updateParticle('acc1', { patch: { discovery: {} } });
    expect(updateParticle).toHaveBeenCalledWith('acc1', expect.objectContaining({
      tenantId: 'system', requireDecisionId: 'd-42',
    }));
  });

  it('⑥ appendMemory 走 memoryLog（append-only，无 delete 面）', async () => {
    const appendMemory = vi.fn(async () => ({ ok: true }));
    const ctx = createMonitorCtx({ tenantId: 'system', deps: { appendMemory } });
    await ctx.appendMemory('CRM_ACCOUNT', 'acc1', { kind: 'rescore' });
    expect(appendMemory).toHaveBeenCalledWith('CRM_ACCOUNT', 'acc1', { kind: 'rescore' }, { tenantId: 'system' });
    expect(ctx.deleteMemory).toBeUndefined();
  });
});
```

### Step 2：实现

**文件**：`src/connectors/discovery/monitorCtx.js`

```js
// src/connectors/discovery/monitorCtx.js — monitorAccount 的 ctx 四件套装配
//
// 立论：`monitorAccount(ctx, accountId, signals)` 的 DI 契约要求
//   ctx = { getAccount, rescore, appendMemory, updateParticle }（monitorAccount.js:6,10-32），
//   但截至 2026-09-16 生产**零处装配**：timers.js:181 只传 `{tenantId}` → 首行 ctx.getAccount 必抛
//   TypeError（设计 §E.2.1）。本文件是该缺口的装配实现。
//
// 范式参照：src/sync/mount.js:108 `runTenantSyncOnce` —— 同域、同第 0 闸、同「失败留痕不静默」纪律。
//
// 铁律：
//   ① **写必过第 0 闸**：updateParticle 无 decisionId → 直接 reject（fail-closed，绝不"先写后补"）
//   ② 租户隔离：每次读写透传 tenantId
//   ③ 禁 DELETE：本模块只 expose get/rescore/append/update 四个方向，**不暴露任何 delete 面**
//   ④ rescore 与 runDiscovery 共用 scoreLeadFit ⇒ 两条路径同源（不会「发现时 0.3、重评时 0.8」）
import { mergedDiscoveryRules } from '../../config/discoveryRules.js';
import { scoreLeadFit } from './leadFitScorer.js';

/**
 * @param {{tenantId?:string, decisionId?:string|null, deps?:object}} opts
 *   deps 全部可选（缺省走真实现）；单测可注入替身 → 零 IO
 *   可注入：getParticle / updateParticle / appendMemory / loadRules / now
 */
export function createMonitorCtx({ tenantId = 'system', decisionId = null, deps = {} } = {}) {
  const loadRules = deps.loadRules || ((t) => mergedDiscoveryRules({ tenantId: t }));
  const now = deps.now || (() => Date.now());

  const getAccount = deps.getParticle
    ? (id) => deps.getParticle(id, { tenantId })
    : async (id) => (await import('../../particles/particleRepo.js')).getParticle(id, { tenantId });

  // lead-fit 重评：读账户 → 取规则 → 确定性评分（零 LLM；见 leadFitScorer 边界①/②）
  const rescore = deps.rescore || (async (accountId, { signals = [] } = {}) => {
    const acct = await getAccount(accountId);
    const rules = await loadRules(tenantId);
    const scored = scoreLeadFit({ account: acct || {}, signals, rules, now: now() });
    return {
      score: scored.intent,                 // monitorAccount 读 rescored.score
      ruleRef: scored.ruleRefs.intent,
      icp_fit: scored.icp_fit,
      breakdown: scored.breakdown,
      degraded: scored.degraded,
    };
  });

  // 记忆追加（append-only；memoryLog 无删除面）
  const appendMemory = deps.appendMemory
    ? (type, id, payload) => deps.appendMemory(type, id, payload, { tenantId })
    : async (type, id, payload) => {
      const { appendMemory: real } = await import('../../memory/memoryLog.js');
      return real(type, id, payload, { tenantId });
    };

  // 写粒子：**先闸后写** —— 无决策即拒，绝不进入 repo
  const updateParticle = deps.updateParticle
    ? async (id, payload) => {
      if (!decisionId) throw new Error(`decision_required: monitorAccount 写路径无决策不落库`);
      return deps.updateParticle(id, { ...payload, tenantId, requireDecisionId: decisionId });
    }
    : async (id, payload) => {
      if (!decisionId) throw new Error(`decision_required: monitorAccount 写路径无决策不落库`);
      const { updateParticle: real } = await import('../../particles/particleRepo.js');
      return real(id, { ...payload, tenantId, requireDecisionId: decisionId });
    };

  return { getAccount, rescore, appendMemory, updateParticle };
}
```

### Step 3：跑测试

```powershell
npx vitest run test/connectors/discovery/monitorCtx.test.js test/connectors/discovery/monitorAccount.test.js
```
**预期**：全绿，且 `monitorAccount.test.js`（既有 6 例，用替身 ctx）**零回归**。

### Step 4：提交

```powershell
cd D:\system\CRM-ai-native
git add src/connectors/discovery/monitorCtx.js test/connectors/discovery/monitorCtx.test.js
git commit -m "feat(discovery): monitorCtx 装配层(getAccount/rescore/appendMemory/updateParticle+第0闸fail-closed)"
```

---

## Task LF-4：`timers.js` 富化路径接线（⚠️ 高风险：并行会话热点文件）

**产出**：`src/scheduler/timers.js` — `runIntegrationPollOnce` 签名 + 富化分支改造 + 装配点注入

> 🔴 **实施前必做**：本文件正被并行会话修改（Q1-3 曾留下 5 个 hunk）。开工前执行
> `git diff HEAD -U0 -- src/scheduler/timers.js | grep "^@@"` 核 hunk 归属；
> 提交时必须 `git add -p`，**禁止整文件 add**（会把并行会话的在途改动一起扫入）。

### Step 1：改 `runIntegrationPollOnce` 签名（`:132`）

**原**：
```js
export async function runIntegrationPollOnce({ listActiveTenants, loadAdapters, query, runWaterfall, monitorAccount, emit, recordTokens, loadSyncTargets, runSync } = {}) {
```

**新**（只加 `buildMonitorCtx` 与 `mintDecision`）：
```js
export async function runIntegrationPollOnce({ listActiveTenants, loadAdapters, query, runWaterfall, monitorAccount, buildMonitorCtx, mintDecision, emit, recordTokens, loadSyncTargets, runSync } = {}) {
```

### Step 2：改富化分支（`:177-190`）

**原**：
```js
      if (sigs.length) {
        // E.2.1 处置①（2026-09-16）：原为 `.catch(() => {})` —— 空吞与「G3 不静默」铁律冲突，
        //   使「C3 闭环从未执行」这件事在生产上完全不可见（无 trace、无账）。
        //   ⚠ ctx 四件套（getAccount/rescore/appendMemory/updateParticle）**尚未装配**
        //     （A-B7 经复核属「新建能力」而非补齐，未立项）→ 本轮**只消除静默**，不伪造成功：
        //     失败逐条留痕，让缺口显式可见，而不是被静默吞掉。
        await monitorAccount({ tenantId: tid }, acc.id, sigs).catch((err) => {
          emit && emit('trace', 'integration-poll-monitor-failed', {
            tenant_id: tid, account_id: acc.id, signals: sigs.length, error: String(err?.message || err),
          });
          recordFailure('integration-poll-monitor-failed', err);
        });
      }
```

**新**：
```js
      if (sigs.length) {
        // E.2.1 处置②（2026-09-16）：根治 ctx 四件套装配缺口（此前只传 {tenantId} → 结构性 TypeError）。
        //   第 0 闸：monitorAccount 会写回 payload → 每租户本轮先铸一枚决策；**铸不出则不跑**
        //   （fail-closed：写无决策不落库，宁可 C3 闭环停摆也不产生无源写入）。
        //   铸出的决策同时供本轮 sync 分支复用（同一租户一次轮询 = 一枚决策，与 mount.js:133 同语义）。
        let pollDecisionId = null;
        if (mintDecision) {
          const d = await mintDecision('integration-poll', { tenantId: tid, account_id: acc.id }).catch(() => null);
          pollDecisionId = d?.decisionId || null;
        }
        const monitorCtx = buildMonitorCtx ? buildMonitorCtx({ tenantId: tid, decisionId: pollDecisionId }) : null;
        if (!monitorCtx || !pollDecisionId) {
          // 缺口显式可见（不伪造成功、不静默）：装配缺失 or 铸决策失败
          emit && emit('trace', 'integration-poll-monitor-skipped', {
            tenant_id: tid, account_id: acc.id, signals: sigs.length,
            reason: monitorCtx ? 'decision_mint_failed' : 'monitor_ctx_not_assembled',
          });
          recordFailure('integration-poll-monitor-skipped', new Error(monitorCtx ? 'decision_mint_failed' : 'monitor_ctx_not_assembled'));
        } else {
          await monitorAccount(monitorCtx, acc.id, sigs).catch((err) => {
            emit && emit('trace', 'integration-poll-monitor-failed', {
              tenant_id: tid, account_id: acc.id, signals: sigs.length, error: String(err?.message || err),
            });
            recordFailure('integration-poll-monitor-failed', err);
          });
        }
      }
```

> ⚠ **`mintDecision` 的作用域提示**：现有装配（`:528`）在 `runSync` 的 `deps` 内。Step 3 需把它**提升到 `runPoll` 顶层**并同时传入两处，否则富化分支拿不到。

### Step 3：改装配点（`:494-534` 的 `runIntegrationPollOnce({...})` 调用）

在 `runPoll` 内、`runIntegrationPollOnce({...})` 之前插入变量提升，并在对象字面量中补两个键：

```js
    import('../connectors/discovery/tenantInstances.js').then(async (m) => {
      // ...（既有 mount/syncFactories/vault/autonomy 加载保持不变）
      // —— LF-4：第 0 闸铸造器提升到 runPoll 顶层（富化分支与同步分支**共用**，同租户一轮一枚）——
      const mintDecision = async (scene, ctx) => {
        const r = autonomy?.requireDecision ? await autonomy.requireDecision(scene, ctx).catch(() => null) : null;
        return { decisionId: r?.decision_id || null };
      };
      const monitorCtxMod = await import('../connectors/discovery/monitorCtx.js').catch(() => null);
      await runIntegrationPollOnce({
        // ...（既有键全部保留）
        mintDecision,
        buildMonitorCtx: monitorCtxMod?.createMonitorCtx,
        // ...
      });
```

并把 Step 3 之后 `runSync` 的 `deps.mintDecision` 改为**直接引用**顶层 `mintDecision`（去掉重复的定义），保持单一事实源。

### Step 4：跑测试

```powershell
npx vitest run test/external-integration.test.js test/timers.test.js
```
**预期**：`external-integration.test.js` 全绿（含既有 A-B5/A-B6/E.2.1 段）；E.2.1 段此时应仍绿（其断言的是「失败留痕」形态，新分支保留该 trace 名）。

> ⚠ 若 E.2.1 段断言了「monitorAccount 一定被调用一次」，需按新语义更新为「装配齐备时被调用 / 缺装配时留 skipped 痕」——**更新断言时不得放宽为"不抛错即可"**（那是假绿）。

### Step 5：提交（**必须 add -p**）

```powershell
cd D:\system\CRM-ai-native
git diff HEAD -U0 -- src/scheduler/timers.js | grep "^@@"   # 先核 hunk 数
git add -p src/scheduler/timers.js                          # 只挑 LF-4 的 hunk（答 y，其余 n）
git commit -m "feat(scheduler): integration-poll 富化路径接线 monitorCtx(第0闸fail-closed)"
```
**提交后复核**：`git diff HEAD -- src/scheduler/timers.js`。若为 **0 行** → 说明已被并行会话的整文件 add 扫入，**勿补空提交**。

---

## Task LF-5：假绿反证（验收，**本计划的核心价值所在**）

**产出**：`test/connectors/discovery/wiringGuard.test.js`

> **判据来源**：本仓铁律第 1 条 —— **生产零接线 = 最大假绿源**。既有 `monitorAccount.test.js` 用替身 ctx 全绿，
> **完全不能证明生产装配存在**。本 Task 断言的是「**生产构造方存在**」，而非「grep 到函数定义」。

```js
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(__dirname, '../../../src');
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8');
// 判据纪律：剥离注释行（`//` 与 `*` 开头）——否则注释里的字样会造成**假红/假绿**（本仓已登记变体）
const stripComments = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

describe('LF-5 生产装配判据（只断言"生产构造方存在"，不停留在函数定义）', () => {
  it('① timers.js 真实 import monitorCtx 并把它装配进 runIntegrationPollOnce', () => {
    const code = stripComments(read('scheduler/timers.js'));
    expect(code).toMatch(/import\(['"][^'"]*discovery\/monitorCtx\.js['"]\)/);
    expect(code).toMatch(/buildMonitorCtx\s*:\s*monitorCtxMod\?\.\w+/);
  });

  it('② timers.js 真实调用 createMonitorCtx 并携带 decisionId（第 0 闸）', () => {
    const code = stripComments(read('scheduler/timers.js'));
    expect(code).toMatch(/createMonitorCtx\(\{/);
    expect(code).toMatch(/decisionId\s*:\s*pollDecisionId|decisionId\s*:\s*\w*[Dd]ecision/);
  });

  it('③ 占位 0.5 已从 discoveryOrchestrator 消失（负向判据）', () => {
    const code = stripComments(read('agent/discoveryOrchestrator.js'));
    expect(code.includes('0.5, 0.5')).toBe(false);
    expect(code).toMatch(/scoreLeadFit\(/);
  });

  it('④ qixin.js 的注释承诺此刻为真：discovery-rules.signals 有真实消费方', () => {
    const scorer = stripComments(read('connectors/discovery/leadFitScorer.js'));
    expect(scorer).toMatch(/rules\.signals/);   // 判据②此前为 0 命中，LF-1 后应 ≥1
  });

  it('⑤ 反证：rubricScorer 的 9 维**不得**出现在 lead-fit 评分路径', () => {
    const scorer = stripComments(read('connectors/discovery/leadFitScorer.js'));
    for (const k of ['clarity', 'accuracy', 'fairness']) expect(scorer.includes(k)).toBe(false);
  });
});
```

**运行**：
```powershell
npx vitest run test/connectors/discovery/wiringGuard.test.js
```

### 提交

```powershell
cd D:\system\CRM-ai-native
git add test/connectors/discovery/wiringGuard.test.js
git commit -m "test(discovery): LF-5 生产装配守卫(断言构造方存在/占位0.5消失/rubricScorer不越界)"
```

---

## Task LF-6：端到端冒烟（真库）

**产出**：`scripts/smoke-lead-fit.mjs`（真库 + 真评分 + 真 monitorAccount）

**执行内容**：
1. 造一个测试租户的 `CRM_ACCOUNT`（含 `payload.enrichment.industry/headcount`）
2. 走 `scoreLeadFit` 得双维分 → 断言「非占位 0.5」且与手算一致
3. 用 `createMonitorCtx({tenantId, decisionId: <真铸>})` 调 `monitorAccount`
4. 断言：`payload.discovery.intent_score.value` 被更新、`memory_log` 有 `kind=rescore` 新行、`decision.id = <铸的>`
5. 反证：`decisionId: null` 时 `monitorAccount` **必失败**（第 0 闸生效）

```powershell
cd D:\system\CRM-ai-native
node scripts/smoke-lead-fit.mjs
```
**预期**：4 项 PASS + 1 项反证 PASS，退出码 0。

> ⚠ 冒烟脚本必须用**相对导入**（禁 `file:///D:/...` 绝对路径——本仓已清零该反模式）。
> ⚠ 运行前确认 `crm_native_test` 库可用（勿在生产库跑写操作）。

### 提交

```powershell
cd D:\system\CRM-ai-native
git add scripts/smoke-lead-fit.mjs
git commit -m "test(discovery): LF-6 lead-fit 端到端冒烟(真库, 含第0闸反证)"
```

---

## §4 登记项（本计划**不做**，需另行裁决）

| # | 项 | 依据 | 建议 |
|---|---|---|---|
| R-1 | `icp.min_confidence` 语义未定义 | `grep min_confidence docs/` → 0；`waterfall.js` 无 `confidence` 字段 | 需先定义"什么值的置信度"再实现（**不猜测**） |
| R-2 | `discovery-rules` 的 `signal_age_tiers` 在 discovery 域仍零消费 | 判据⑦：仅 prospecting 域有消费 | LF-1 已消费 `signal_time_fields`；`age_tiers` 需在 `discovery-rules` 播种后才生效（**播种 ≠ 接通**） |
| R-3 | `rubricScorer` 九尺子与 lead-fit ruler 的**同名异物** | 陷阱① | 建议在 `rubricScorer.js` 文件头加一行边界声明（防下一位实施者接错） |
| R-4 | `P-2`：`signalMetrics.js:178` 的 `tenant_id <> 'system'` | Q3 计划 §3 已登记 | D1 同族遗漏，平台租户永不巡检；独立 P1 修 |
| R-5 | `runDiscovery` 的 `icp_fit_score` 真实数据源依赖富化覆盖 | LF-2 | 生产无租户启用富化 provider 时，`icp_fit=0 + degraded` 是**正确**结果（非缺陷） |

---

## §5 依赖与顺序

```
LF-1 (评分器·纯函数)
   │
   ├──► LF-2 (runDiscovery 取代占位 0.5)   ← 可与 LF-3 并行
   │
   └──► LF-3 (monitorCtx 装配层)
             │
             └──► LF-4 (timers.js 接线)    ← ⚠ 必须在 LF-1/LF-3 之后；文件热点，add -p
                       │
                       ├──► LF-5 (假绿反证)
                       └──► LF-6 (真库 e2e)
```

**回滚**：每 Task 独立 commit，任一 Task 可单独 `git revert`。LF-4 是唯一改动既有行为的 Task（其余为新增或替换占位）。

---

## §6 对外口径（三态，不得合并表述）

| 维度 | 本计划完成后的状态 |
|---|---|
| 代码侧就绪 | 按上述 6 个 Task 完成后 ✅（判据：LF-5 五项断言 + LF-6 真库冒烟） |
| 本地端到端 | LF-6 通过 ✅ |
| 云上生产已发布 | 🔴 **否** —— 需另行发布，且发布 ≠ 生效（生产无租户启用富化 provider → 富化路径 `sigs.length=0` → 该分支不触发） |

---

## Self-Review

**1. Design coverage**
- ✅ 设计 §5 数据模型的 `icp_fit_score`/`intent_score` 形态与 `rule_ref` → LF-1 常量逐字对齐
- ✅ 设计 §2 环节③「对既有 CRM_ACCOUNT 重跑 lead-fit 评分」→ LF-3 `rescore`
- ✅ 设计 §0.5 P1「认知评分」→ LF-1 评分器
- ✅ 设计 §附录 E.2.1 处置②「实现 `ctx.rescore` 与 `ctx.getAccount`」→ LF-3 完整覆盖（含另两件套）

**2. Placeholder scan**：以 `awk '/^## Self-Review/{exit} {print}' <file>` 剥离本节后扫描 → **0 命中**；ESM 禁用语法（本仓铁律之一）全文扫描 → **0**；代码块配平 58（偶数）。
> 本节**刻意不写出**被扫描的禁词与禁用语法的字面量——否则判据会命中本说明自身（「禁词断言未剥离注释」本仓第 4 次同族变体）。

**3. Type consistency**：`scoreLeadFit` 返回键（`icp_fit`/`intent`/`ruleRefs`/`breakdown`/`degraded`）在 LF-1 定义、LF-2 与 LF-3 消费，逐字一致；`monitorAccount` 读的是 `rescored.score`，LF-3 显式提供 `score` 别名（**不改 monitorAccount**，避免扩大改动面）。

**4. 判据可复跑性**：§0 的 8 条判据、LF-5 的 5 条断言、Self-Review 的扫描，全部给出可直接粘贴执行的命令与预期值。

**5. 反假绿自查**：
- 既有 `monitorAccount.test.js` 用替身 ctx 全绿 → **不能**作为装配证据 ⇒ LF-5 补生产构造方断言 ✅
- `qixin.js:2` 的注释承诺 → LF-5 ④ 把它变成**可测断言** ✅
- 陷阱② 的"跨域键恒 0 静默错" → LF-1 测试 ⑦ 做**反证断言**（证明复用 prospecting scorer 会出错）✅
- 占位 0.5 → LF-2 断言"零信号时 intent=0（**不是** 0.5）" ✅
