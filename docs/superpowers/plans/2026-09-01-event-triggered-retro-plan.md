# 实施计划：事件触发式复盘（决策→复盘闭环自动派发）

- 日期：2026-09-01
- 上游设计：`docs/2026-09-01-event-triggered-retro-design.md`（用户批复 **A** = 事件总线订阅方案）
- 阶段：writing-plans（含完整代码，逐 Task 落地，每 Task 一 commit）
- 铁律：零 schema 迁移；阈值配置化（`config_store`，禁硬编码）；订阅者异常绝不阻断 `confirmDecision` 主写；绝对禁止 DELETE。

## §0 目标与不做

| 项 | 内容 |
|---|---|
| 做 | `confirmDecision` 落地 → 自动派发 `decision-retro` agent（走 kanban→scheduler→agentLoop→契约 episode） |
| 做 | 触发阈值/开关/冷却窗全部走 `config_store['event-retro']`，缺省 fail-open |
| 做 | 附带修复 `pumpReadyTasks` 未转发 `tenantId`（非 system 租户任务永不被泵起） |
| 不做 | 不替换 `timers.js:77` 夜间 `runDecisionRetro`（J3 校准层批量，产物为 `decision_retro_report`，与 agent episode 互补） |
| 不做 | 不动 `configCenter.js` CONFIG_ITEMS（并行会话正在占用 id33 `edge_bindings`，避免冲突；`event-retro` 缺省可用，UI 暴露列为后续） |

## §1 已核实的代码事实（file:line）

| 事实 | 位置 | 影响 |
|---|---|---|
| `confirmDecision` 落地后 `emit('decision','confirmed',{decision_id, by_role})` | `src/decision/decisionRepo.js:281` | 唯一触发信号；payload **不含** tier/tenant，须回查 |
| bus `emit` 包装为 `{domain,type,ts,summary}`，订阅者异常隔离 | `src/events/bus.js:17-39` | handler 读 `msg.summary.decision_id`；抛错不影响主写 |
| `crm.decision` 有 `business_tier`，**无** intake 的 `level` | `db/schema.sql:168` | 筛选基于 tier（NORMAL/HIGH/CRITICAL） |
| `crm.decision.tenant_id` 由**独立迁移**补列，不在 `schema.sql` | `db/migrate-tenant.js:14` | 列可能滞后 → 查询须容错回退 `system` |
| `createTask({tenantId,chainId,step,title,actionName,payload,dependsOn,decisionId})` → `status='ready'` | `src/kanban/kanban.js:34-41` | 程序化建单入口 |
| `routeThroughIntake` 读 `payload.intent==='retro'` → `targetAgent='decision-retro'` | `src/kanban/scheduler.js:44-48` | payload 契约：必须带 `intent:'retro'` |
| `level:'L2'` → `gateAgents=[]` | `src/kanban/scheduler.js:43,49` | 复盘任务不触发 review-gate（语义正确） |
| `pumpReadyTasks({chainId})` → `listTasks({status,chainId})`，**tenantId 未转发**（缺省 `system`） | `src/kanban/scheduler.js:68-74` / `kanban.js:22` | 附带缺口，本次修复 |
| `registerFinanceAlertHook()` 挂载范式（try/catch 仅日志） | `src/http/server.js:39` | 挂载点与形态直接照抄 |
| `readConfig(key,{tenantId})` 返回 `{value}` 或 null | `src/config/configStore.js` | fail-open 缺省 |

## §2 Task 拆分（每 Task 一 commit）

### Task A — 新建 `src/decision/retroTrigger.js`

```js
// src/decision/retroTrigger.js — 事件触发式复盘（决策落地 → 自动派发 decision-retro）
// 设计输入：docs/2026-09-01-event-triggered-retro-design.md（方案 A：事件总线订阅）
// 链路：confirmDecision（decisionRepo.js:281 emit('decision','confirmed')）
//   → 本订阅器回查 business_tier/tenant_id → config_store['event-retro'] 过滤（enabled/min_tier/cooldown_hours）
//   → 冷却窗去重 → createTask(intent='retro', actionName='decision-retrospective')
//   → pumpReadyTasks → routeThroughIntake → decision-retro → ct-retro-decision episode
// 与夜间 runDecisionRetro（timers.js:77，J3 校准层批量落 decision_retro_report）互补，不互斥：
//   夜间产「校准报告」，本路径产「agent 契约合规证据（episode）」。
// 铁律：订阅者抛错绝不阻断 confirmDecision 主写（bus.js 已隔离 + handler 内 try/catch 双保险）。
import { on } from '../events/bus.js';
import { query } from '../db.js';
import { readConfig } from '../config/configStore.js';
import { createTask } from '../kanban/kanban.js';

// 阈值配置化铁律：出厂默认仅作 fail-open 兜底，运营可经 config_store['event-retro'] 覆盖
export const DEFAULT_EVENT_RETRO_CFG = Object.freeze({
  enabled: true,
  min_tier: 'HIGH',      // 触发下限；配 'NORMAL' 即全流程复盘
  cooldown_hours: 24,    // 同租户冷却窗，防 floods
  auto_pump: true,       // 建单后立即泵起派发（false 则等 scheduler 巡检）
});

const TIER_RANK = Object.freeze({ NORMAL: 0, LEAD: 0, HIGH: 1, CRITICAL: 2 });
const rankOf = (t) => TIER_RANK[String(t || '').toUpperCase()] ?? 0;

export async function readEventRetroConfig() {
  try {
    const c = await readConfig('event-retro', { tenantId: 'system' });
    return { ...DEFAULT_EVENT_RETRO_CFG, ...(c?.value || {}) };
  } catch {
    return { ...DEFAULT_EVENT_RETRO_CFG }; // fail-open
  }
}

// 回查决策 tier/租户。tenant_id 由 db/migrate-tenant.js:14 独立迁移补列，
// 旧库可能滞后 → 列缺失时降级为「仅取 tier + 租户回退 system」，避免整条触发链静默失效。
export async function loadDecisionMeta(decisionId) {
  try {
    const r = await query('SELECT business_tier, tenant_id FROM decision WHERE decision_id=$1', [decisionId]);
    const d = r.rows[0];
    return d ? { tier: d.business_tier, tenantId: d.tenant_id || 'system' } : null;
  } catch {
    const r = await query('SELECT business_tier FROM decision WHERE decision_id=$1', [decisionId]);
    const d = r.rows[0];
    return d ? { tier: d.business_tier, tenantId: 'system' } : null;
  }
}

// 冷却去重：同租户窗口内已有 retro 任务（人工触发的也计入）即跳过，避免重复复盘
export async function hasRecentRetroTask(tenantId, cooldownHours) {
  const r = await query(
    `SELECT id FROM tasks
      WHERE tenant_id=$1 AND payload->>'intent'='retro'
        AND created_at >= now() - make_interval(hours => $2::int)
      LIMIT 1`,
    [tenantId, cooldownHours]
  );
  return r.rows.length > 0;
}

// 纯判定（可单测）：给定 tier 与配置，是否满足触发下限
export function tierPasses(tier, cfg) {
  return rankOf(tier) >= rankOf(cfg.min_tier);
}

// 核心：决策 confirmed → 视条件建 retro 任务。返回 {created:false, reason} 或 {created:true, task}
export async function maybeTriggerRetro(decisionId) {
  if (!decisionId) return { created: false, reason: 'no_decision_id' };
  const cfg = await readEventRetroConfig();
  if (!cfg.enabled) return { created: false, reason: 'disabled' };
  const meta = await loadDecisionMeta(decisionId);
  if (!meta) return { created: false, reason: 'decision_not_found' };
  if (!tierPasses(meta.tier, cfg)) return { created: false, reason: `tier_below_min:${meta.tier}` };
  if (await hasRecentRetroTask(meta.tenantId, cfg.cooldown_hours)) {
    return { created: false, reason: 'cooldown' };
  }
  const short = String(decisionId).slice(0, 8);
  const task = await createTask({
    tenantId: meta.tenantId,
    step: 'retro',
    // 用户看得懂的语言：标题不暴露内部 agent/slug 名
    title: `重大决策复盘（${meta.tier}）· 决策 ${short}`,
    actionName: 'decision-retrospective',
    payload: {
      intent: 'retro',          // routeThroughIntake 契约键 → decision-retro
      level: 'L2',              // 非 major → 不额外触发 review-gate
      decision_id: decisionId,
      business_tier: meta.tier,
      triggered_by: 'event',
      source: 'decision:confirmed',
    },
    decisionId,
  });
  if (cfg.auto_pump) {
    try {
      const { pumpReadyTasks } = await import('../kanban/scheduler.js');
      await pumpReadyTasks({ tenantId: meta.tenantId });
    } catch (e) {
      console.error('[retro-trigger] pump fail:', e?.message);
    }
  }
  return { created: true, task, tier: meta.tier, tenantId: meta.tenantId };
}

let unsub = null;

export function registerRetroTrigger() {
  if (unsub) return unsub;
  unsub = on('decision', (msg) => {
    if (msg?.type !== 'confirmed') return;
    const decisionId = msg?.summary?.decision_id;
    if (!decisionId) return;
    // 异步执行 + 全捕获：confirmDecision 是写关键路径，任何失败只留日志
    void (async () => {
      try {
        const r = await maybeTriggerRetro(decisionId);
        if (r.created) console.log(`[retro-trigger] retro task created for decision ${String(decisionId).slice(0, 8)} (tier=${r.tier})`);
      } catch (e) {
        console.error('[retro-trigger] error:', e?.message);
      }
    })();
  });
  return unsub;
}

export function unregisterRetroTrigger() {
  if (unsub) { unsub(); unsub = null; }
}
```

**验收**：`registerRetroTrigger/unregisterRetroTrigger` 对称；`maybeTriggerRetro` 可独立单测。

### Task B — `pumpReadyTasks` 转发 `tenantId` + `server.js` 挂载

`src/kanban/scheduler.js:68`：

```js
// 扫描 ready 任务并全部入队派发；返回本次扫描到的 ready 数量
// tenantId 转发（2026-09-01）：原实现未透传，listTasks 恒按 'system' 过滤 →
//   非 system 租户的 ready 任务永不被泵起（事件触发式复盘按决策租户建单即命中此坑）。
export async function pumpReadyTasks({ chainId = null, tenantId = 'system' } = {}) {
  const ready = await listTasks({ status: 'ready', chainId, tenantId });
  ...
}
```

`src/http/server.js:39` 之后：

```js
// ③ 事件触发式复盘：订阅 decision 域 confirmed → 重大决策落地自动派发 decision-retro
//    （阈值走 config_store['event-retro']；注册失败仅日志，不阻断主服务）
try { registerRetroTrigger(); } catch (e) { console.log(`[retro-trigger] register fail: ${e.message}`); }
```

**验收**：签名向后兼容（既有 `pumpReadyTasks({})` 调用点行为不变）；挂载失败不阻断启动。

### Task C — `test/event-triggered-retro.test.js`

`vi.mock` 隔离 `../src/db.js` / `../src/kanban/kanban.js` / `../src/config/configStore.js` / `../src/kanban/scheduler.js`，断言 6 类语义：

1. `business_tier='HIGH'` → `createTask` 被调用，`payload.intent==='retro'`、`actionName==='decision-retrospective'`、`decisionId` 透传。
2. `business_tier='NORMAL'` → 不建单，`reason` 含 `tier_below_min`。
3. 冷却窗命中（`tasks` 查询返回行）→ 不建单，`reason==='cooldown'`。
4. `config_store['event-retro'].enabled=false` → 不建单，`reason==='disabled'`。
5. `readConfig` 抛错 → fail-open 走缺省仍能触发（不静默禁用）。
6. `emit('decision','confirmed')` 经 `registerRetroTrigger` 真实走通；`unregisterRetroTrigger` 后不再响应。

**验收**：全绿；不触真库。

### Task D — 真库端到端 + 回归

1. 冒烟脚本（`tmp/probe-retro-event.mjs`，跑后删）：`createDecision({business_tier:'HIGH', state:'REQUIRED', ...})` → `registerRetroTrigger()` → `confirmDecision()` → 轮询断言 `tasks` 出现 `payload->>'intent'='retro'`；再 `pumpReadyTasks` → 断言 `monitor_event` 出现 `contract_task_id='ct-retro-decision'` 新 episode。
2. 回归：`test/event-triggered-retro.test.js` + `retro-wiring` + `g4-dispatch-loop` + `agent/classify` + `method-skill-real-execution`。

**验收**：episode 落库 + 回归全绿。

### Task E — 文档与记忆回填

设计文档 §8 回填实施记录；契约文档 `docs/specs/2026-08-29-agent-workbench-contract-monitor-design.md` 的 decision-retro 块注释补"事件触发：重大决策 confirmed 自动派发"；追加 `.workbuddy/memory/2026-09-01.md`。

## §3 风险与回滚

| 风险 | 缓解 |
|---|---|
| 复盘任务 floods | `cooldown_hours` 默认 24h/租户；人工 retro 任务也计入冷却 |
| `decision.tenant_id` 列滞后 | `loadDecisionMeta` 双段回退（避免整链静默失效） |
| 订阅器异常拖累 `confirmDecision` | `void (async …)` 异步 + handler 内 try/catch + bus 已隔离，三重保险 |
| LLM 未配置 | `decision-retrospective` 的 j_judge 步降级（① 已验证不崩），rule 步仍产汇总 → episode 照常落库 |
| 回滚 | 删 `server.js` 挂载行 + 删 `retroTrigger.js`；`pumpReadyTasks` 改动向后兼容可保留 |

## §4 实施结果（落地后回填，2026-09-01）

### §4.1 Task 完成矩阵

| Task | 内容 | 状态 | 关键产物 |
|---|---|---|---|
| A | 新建 `src/decision/retroTrigger.js` | ✅ (#10) | 订阅器 + 分级/冷却闸 + fail-open + 旧库 tenant_id 容错 |
| B | `pumpReadyTasks` 转发 tenantId + `server.js` 挂载 | ✅ (#13) | 修复多租户泵起缺口；挂载失败仅日志 |
| C | `test/event-triggered-retro.test.js` | ✅ (#14) | 21 例单测，mock 隔离，不触真库 |
| D | 真库端到端 + 回归 | ✅ (#12) | 冒烟 HIGH→+1/cooldown→+0/NORMAL→+0；改动面 52 绿、test/web 312 绿、test/config 绿；probe 脚本已删 |
| E | 文档与记忆回填 | ✅ (#11) | 设计文档 §8 / 契约文档 §A 注释 / 计划 §4 / 记忆日志 |

### §4.2 验证汇总

- 单测 21/21 通过；真实库冒烟 PASS；回归 `test/web` 312、`test/config` 全绿、改动面 6 文件 52 绿。
- UI lint 通过（63 文件 0 错误）；CSS 变量审计 OK。

### §4.3 铁律遵守

- **阈值配置化**：`min_tier`/`cooldown_hours`/`enabled`/`auto_pump` 全部走 `config_store['event-retro']`，代码仅存 fail-open 出厂默认；Config Center id35 三处同步 + 专属受控页。
- **零 schema 迁移**：未新增列/表；`decision.tenant_id` 缺失时降级 `system`。
- **订阅者异常绝不阻断 confirmDecision 主写**：bus 隔离 + handler 内 try/catch + `void(async…)` 异步脱钩，三重保险。
- **绝对禁止 DELETE**：仅 INSERT 复盘任务，不删既有任务。

### §4.4 提交

未 commit（无凭证铁律）；涉及文件见设计文档 §8.5。
