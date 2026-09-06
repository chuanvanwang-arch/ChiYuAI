# 静默吞错可观测化 + crm-risk 真扫描 — 设计文档

> 日期：2026-08-26 ｜ 状态：brainstorming 已批准（三节逐一确认）→ writing-plans
> 上游：代码检查结论（08-26 08:57）「主要风险三处静默吞错（先例写、蒸馏、规则层重叠）」
> 纪律：设计先行已满足；TDD；每 Task 一 commit

## 1. 背景与问题

代码检查（evidence-driven）定位三处「失败无痕迹」类风险，加一处空占位，均属同一主题：**系统自我观测缺失**。

| # | 风险 | 现状（file:line） | 影响 |
|---|---|---|---|
| R1 | 先例关系写失败静默 | `src/decision/decisionRepo.js:75` `.catch(()=>{})` | 决策网络断链（`searchPrecedents` 少先例 → 置信度漂移）无告警 |
| R1b | 决策记忆沉淀失败静默 | `src/decision/decisionRepo.js:82` `.catch(()=>{})` | 跨会话记忆丢失（L-Workspace 层）无痕迹 |
| R2 | 蒸馏失败静默 + crm-risk 扫描空占位 | `src/scheduler/timers.js:21` `.catch(()=>{})`；`:26-28` 空 setInterval | 记忆治理失效、风险扫描永不执行，均无告警 |
| R3 | 规则层 `lost_requires_reason` 恒拒绝 | `src/ruleEngine.js:14-20` `check` 恒返回 `{ok:false}` | 规则层与 `particles/lifecycle.js:19-21` 双实现职责重叠，规则层成「恒拒绝假闸」 |

## 2. 决策基线（brainstorming 逐项确认）

| 决策点 | 结论 | 理由 |
|---|---|---|
| 修复范围 | **顺带实现 crm-risk 真扫描**（占位升级） | 用户选定；与 R2 同文件同主题 |
| 扫描目标 | **全量重算 AI 属性**（DEAL/ACCOUNT/CONTACT 全量 `evaluateAiAttributesFor`） | 与 `AI_ATTR_DEFS` 定义完全对齐 |
| 触发方式 | **与现有触发点对齐**（扫描复用写时确定性兜底 `particleRepo.js:28/:71`） | 不引入双 LLM 通道；`{llm:null}` 退化走确定性 |
| 落地粒度 | **单一设计文档 + 单一实施计划** | 主题聚焦、边界清晰 |
| 可观测化 | **trace 事件 + monitor 健康计数**（不升级 alert 系统、不新增订阅域） | 复用既有 `emit('trace')` 通路（executor.js 已有 8 处先例）+ monitorStore 既有健康结构 |

## 3. 架构与组件

```
┌─ 修复 A（可观测化）─────────────────────────────┐
│ decisionRepo.js 先例/记忆写失败 → emit trace    │
│   'precedent-link-failed' / 'decision-memory-failed'│
│ timers.js 蒸馏失败 → emit trace                 │
│   'nightly-distill-failed'                      │
│ 全部失败 → monitor.recordFailure(kind, error)   │
│    （monitorStore.js 新增 failsByKind 内存结构） │
├─ 修复 B（crm-risk 真扫描，新文件）──────────────┤
│ src/scheduler/riskScanner.js                    │
│   runRiskScan():                                │
│     SELECT 全部 DEAL/ACCOUNT/CONTACT            │
│     → 逐条 evaluateAiAttributesFor({llm:null})  │
│     → 差异检测（ai JSON 变化才 updateParticle） │
│     → emit trace 'crm-risk-scan' 完成/失败      │
│ timers.js 的 crm-risk 定时器 → 调 runRiskScan() │
└──────────────────────────────────────────────────┘
```

**复用边界**：不新建 evaluator 逻辑；不改 bus/alertHook 订阅域；不加新表。观测复用既有 `emit('trace')`（executor.js:20/32/44/55/63/70/77/81 先例）+ monitorStore 既有健康结构。

## 4. 组件细节

### C1 crm-risk 扫描器（新文件 `src/scheduler/riskScanner.js`）

- **为何独立成文件**：`timers.js` 是定时器注册器（幂等单例），扫描逻辑独立保持单一职责，`timers.js` 只调 `runRiskScan()`。
- **数据流**：
  ```
  ensureTimers → setInterval(30min, crm-risk-scan)
    └─ runRiskScan()
         ├─ SELECT id,type,payload FROM particles
         │    WHERE type IN ('CRM_DEAL','CRM_ACCOUNT','CRM_CONTACT')
         ├─ 逐条 evaluateAiAttributesFor(entity, {llm:null})
         ├─ 差异检测 JSON.stringify(ai) !== prev ai → 才 updateParticle
         │    （与写时 hooks「内容未变不重算」同幂等纪律）
         ├─ emit('trace','crm-risk-scan',{scanned, changed, degraded})
         └─ 失败 → emit('trace','crm-risk-scan-failed',{error})
  ```
- **全量 vs 增量**：首版 **全量**（3 类粒子规模可控）；扫描变慢再加 `updated_at` 窗口增量（YAGNI，不预建）。
- **LLM 注入**：扫描器不接 LLM（`{llm:null}` → degraded 确定性兜底）——与粒子写时一致；生产 LLM 由 crm-risk SKILL/agent 注入，不引入双通道。

### C2 规则层委托（`src/ruleEngine.js`）

```js
lost_requires_reason: {
  match: (type, action, patch) => type === 'CRM_DEAL' && action === 'advance' && patch.to === 'lost',
  check: (type, action, patch) => {
    // 语义委托 lifecycle.js:19-21（唯一事实源）：同一输入字段，不再恒拒绝
    const missing = !patch.transitionedBecause && !patch.closed_reason;
    return { ok: !missing, reasons: missing ? ['lost_requires_reason'] : [] };
  },
},
```

- **行为变化**：带 reason 的 advance-to-lost 规则层放行（此前恒拒绝）；缺 reason 拒绝（与 lifecycle 一致）。
- **一致性**：与 lifecycle 同输入字段（`transitionedBecause`/`closed_reason`），不互相矛盾（规则层先拦缺失，lifecycle 兜底）。
- **安全**：不削弱门禁——缺失仍拒绝，仅从「无条件拒绝」变「按条件拒绝」。

### C3 可观测化（`src/monitor/monitorStore.js`）

- 新增 `failsByKind` 内存 Map：`recordFailure(kind, error)` / `getFailures()`。
- 三个 emit 点（先例/记忆/蒸馏）调用后 `recordFailure`。
- 不新增事件域、不改 alertHook 订阅（符合「不升级 alert」决策）。
- 与 monitorStore 既有健康结构一致（内存态，不新增表）。

## 5. 变更清单

| 文件 | 变更 |
|---|---|
| `src/decision/decisionRepo.js` | 2 处 catch 补 emit trace + recordFailure |
| `src/scheduler/timers.js` | 蒸馏 catch 补 emit；crm-risk 定时器接 `runRiskScan()` |
| `src/scheduler/riskScanner.js` | **新文件**：扫描器实现 |
| `src/ruleEngine.js` | lost 规则语义委托 |
| `src/monitor/monitorStore.js` | failsByKind 结构 + recordFailure/getFailures |
| `test/risk-scan.test.js` | **新测试**：扫描器 + 吞错可观测 + 规则委托 |

## 6. 错误处理（韧性保持）

| 场景 | 处理 |
|---|---|
| 扫描器单粒 evaluate 失败 | 该粒跳过 + 累计 failedScan 计数，不中断整批 |
| 扫描器 SELECT/整体失败 | emit `crm-risk-scan-failed` + recordFailure，下次定时器照常触发（幂等重试自然存在） |
| 先例/记忆写失败 | emit trace + recordFailure，**不阻断 createDecision 主流程**（决策本身仍落库） |
| 蒸馏失败 | emit + recordFailure；下次 24h 周期重试 |
| 规则层委托失败 | 返回 `{ok:false, reasons}` → 调用方 `seed-actions.js:98` 拦截（与现状一致） |

## 7. 测试策略（TDD）

| 测试文件 | 覆盖 |
|---|---|
| `test/risk-scan.test.js`（新） | ① 扫描全量重算：造 DEAL(停留>30天) → 扫描后 `payload.ai.stuck_warning.value=true`；② 差异检测：无变化不 update（断言 update 次数/content hash 不变）；③ 失败单粒跳过 + 计数；④ trace 'crm-risk-scan' 被 emit 捕获 |
| `test/decision.test.js`（扩展） | 先例写失败 → emit 'precedent-link-failed'（mock query 抛错）+ monitor 计数（不影响 createDecision 返回） |
| `test/timers.test.js`（扩展） | 蒸馏失败 → emit 'nightly-distill-failed'；crm-risk 定时器注册后调用扫描器 |
| `test/action.test.js`（扩展） | lost 带 reason → 规则层放行；缺 reason → 拒绝（委托语义） |

**DB 集成**：扫描器/决策测试需 PG（与既有共享真实 PG 纪律一致——beforeEach TRUNCATE 同域）。

## 8. 开放风险与决策（已收敛）

| 风险 | 决策 |
|---|---|
| 扫描全量 vs 增量 | 首版全量（量级小），后续按 updated_at 窗口增量 |
| 扫描器是否接 LLM | 否（确定性兜底与写时一致）；LLM 由 crm-risk SKILL 注入 |
| 规则层委托是否削弱门禁 | 否——缺失仍拒绝，仅按条件拒绝 |
| monitor 计数持久化 | 内存 Map（与 monitorStore 既有结构一致） |

## 9. 验收口径

- 三处吞错（先例/记忆/蒸馏）失败时均有 trace 事件 + monitor 计数可见；
- `crm-risk-scan` 定时器真实执行：全量重算 AI 属性、差异才写、degraded 标记；
- 规则层 lost 委托：带 reason 放行、缺 reason 拒绝，与 lifecycle 一致；
- 测试全绿：risk-scan 新测试 + decision/timers/action 扩展，无回归。