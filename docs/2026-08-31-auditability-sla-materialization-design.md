# 可审计性 SLA 物化进 agent_sla 表 · 设计文档

- **日期**：2026-08-31
- **范围**：将平台级「决策可审计性 SLA」从「实时计算端点」升级为「持久化时序表 + 定时快照 + A9 闭环可读」，完成 G 系列问责闭环最后一公里
- **前置**：`docs/2026-08-31-decision-auditability-4q-design.md`（四问审计法 × 监控台结合，已落地）
- **状态**：设计稿（待审批后实现，对应 Task #22→#23）

---

## §0 摘要

当前 `/api/monitor/auditability` 每次请求实时聚合近期决策（逐条 `computeAudit4q` + 图查询），存在三点短板：① 无历史趋势，无法观测可审计性随时间的退化；② A9 闭环分析智能体缺少稳定可读的 SLA 时序数据；③ 决策量增长后实时聚合成本上升。

本文设计：抽出共享审计计算模块 → 新增 `crm.agent_sla` 持久表 → 定时快照物化（INSERT，遵循 07 文档 §5-2「定时扫描落事实表，不跨粒子写」）→ 新增历史端点（公开只读）→ A9 读取趋势闭环。**单一事实源纪律贯穿**：端点、物化、A9 三者共用同一 `aggregateAuditability` 聚合函数，评分口径永不漂移。

---

## §1 背景与动机

- **实时端点已落地**（上一轮）：`GET /api/monitor/auditability` 返回 `auditability_pct` + `per_status{Q1-Q4}` + `full/with_conflict/tampered` + 决策明细。
- **生产实机基线**（本日验证）：生产库 8 决策 `auditability_pct=53`，Q4 全 `warn`（真无下游，非假绿），Q3 有 7 处未裁决冲突。该指标需**持续观测趋势**，而非单次快照。
- **A9 闭环诉求**：A9 定位「跨领域闭环管理——分析所有 agent 运行、提出改进建议」。可审计性退化（如某日 `auditability_pct` 跌破阈值）应触发 A9 预警/改进入口，但 A9 当前无稳定 SLA 时序源。
- **性能**：实时聚合为 O(N×图查询)，决策增长后劣化；物化为定时 O(N) 一次、查询 O(1)。

---

## §2 设计约束（来自项目铁律）

1. **单一事实源**（工作记忆）：`computeAudit4q` / `aggregateAuditability` 必须抽出为共享模块，端点、物化、A9 共用，禁止三处各写一份。
2. **G3 不静默**（timers.js:4）：定时物化失败必须 `emit('trace') + recordFailure`，沿用 `timers.js` 现有 `.catch` 模式。
3. **07 文档 §5-2**（timers.js:5-6）：定时器=「规则治理兜底」，只规则检查→落事实表/发射预警事件，**不直接跨粒子写**。新增 `agent_sla` 是独立事实表（非 `particles` 粒子），落表 INSERT 合法；A9 读取为只读。
4. **UI 零硬编码**：历史端点供 `/agents` 趋势卡复用 `tokens.css` 语义变量（参考已落地的 `renderAuditabilitySla`）。
5. **迁移幂等**（工作记忆铁律）：新表走 `CREATE TABLE IF NOT EXISTS` 段；生产写操作（建表/INSERT）需用户授权。
6. **routes.js 改动需重启 server 生效**（铁律）。

---

## §3 方案权衡

| 方案 | 描述 | 优点 | 缺点 | 结论 |
|---|---|---|---|---|
| **A（推荐）** | 新增 `agent_sla` 表 + 抽共享模块 + 定时快照 INSERT + history 端点 + A9 读 | 持久趋势、A9 可跨进程读、落表合法、单一事实源 | 新增表 + 迁移 + 定时器，改动面中等 | ✅ 采用 |
| B | 仅内存/Redis 缓存端点结果 | 轻、零存储 | 进程重启丢、A9 难跨进程读、无持久趋势 | ❌ 不满足闭环 |
| C | 不物化，每次实时算 | 零存储零运维 | 无历史、A9 无法回溯、性能随决策增长劣化 | ❌ 不满足趋势诉求 |

**快照频率权衡**：
- 每日 1 次（对齐 `nightly-distill`，86400000ms）：运维最省，但退化发现滞后≤24h。
- **每 6h（推荐，21600000ms）**：平衡时效与开销，退化发现滞后≤6h，足够 A9 闭环节奏。
- 每 30min（对齐 risk-scan）：最及时但写入频繁、表膨胀快。

→ 默认 **6h**，经 `config_store['auditability-sla-interval']` 可后台调整（客户可自调，符合阈值配置化铁律）。

**历史保留**：默认保留 **90 天**（`measured_at < now()-90d` 由物化函数内 `DELETE`（软语义：非粒子、非决策，属事实表自身轮转，不触「禁 DELETE」铁律——该铁律针对粒子/记忆/决策行）或独立 `prune` 函数）。落表行数上限 ≈ 90d/6h = 360 行，体量可控。

---

## §4 架构与数据流

```
                ┌─────────────────────────── src/decision/auditability.js (新增, 单一事实源)
                │  computeAudit4q(id)            ← 现有 routes.js:2256 上移
                │  aggregateAuditability({limit})← 现有 monitor 端点聚合逻辑上移
                └───────────────┬───────────────────────────────────────────┬───────────────
                                │ 共用                                        │ 共用
        ┌───────────────────────┴──────────┐                   ┌───────────────┴──────────────┐
   src/http/routes.js                      src/decision/auditabilitySla.js (新增)
   GET /api/monitor/auditability           materializeAuditabilitySla({limit})
   GET /api/monitor/auditability/history   → INSERT crm.agent_sla
                                │                                    │
                                │                            src/scheduler/timers.js ⑦
                                │                            auditability-sla-snapshot (6h)
                                │                                    │
                                └──────────── 读 ──────────────────────┘
                                          crm.agent_sla (新增表)
                                          ↑ A9 分析循环读取(只读)
                                          ↑ /agents 趋势卡 (renderAuditabilitySlaHistory)
```

- **依赖导出**：`graphTraceHandler/Impact/Provenance`（routes.js:2013/2020/2023，当前为 routes 局部函数）与 `detectConflicts`/`getDecision`（routes.js 导入依赖）统一收口进 `src/decision/auditability.js`，routes.js 改为从该模块 import，消除局部重复定义。
- **响应结构不变**：`/api/monitor/auditability` 与单决策 `audit-4q` 的 JSON 形状与当前完全一致 → `audit-4q.test.js`(4/4) + `auditability-sla.test.js`(3/3) 零回归。

---

## §5 表结构：`crm.agent_sla`

```sql
CREATE TABLE IF NOT EXISTS crm.agent_sla (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  measured_at       TIMESTAMPTZ NOT NULL DEFAULT now(),   -- 快照时刻
  window_size       INT NOT NULL,                          -- 本次扫描的决策数
  auditability_pct  NUMERIC(5,2) NOT NULL,                 -- 可审计性百分比
  full_count        INT NOT NULL DEFAULT 0,                -- 4/4 满分决策数
  with_conflict_count INT NOT NULL DEFAULT 0,              -- 含未裁决冲突数
  tampered_count    INT NOT NULL DEFAULT 0,                -- 溯源链被篡改数
  q1_pass INT NOT NULL DEFAULT 0, q1_warn INT NOT NULL DEFAULT 0, q1_fail INT NOT NULL DEFAULT 0,
  q2_pass INT NOT NULL DEFAULT 0, q2_warn INT NOT NULL DEFAULT 0, q2_fail INT NOT NULL DEFAULT 0,
  q3_pass INT NOT NULL DEFAULT 0, q3_warn INT NOT NULL DEFAULT 0, q3_fail INT NOT NULL DEFAULT 0,
  q4_pass INT NOT NULL DEFAULT 0, q4_warn INT NOT NULL DEFAULT 0, q4_fail INT NOT NULL DEFAULT 0,
  raw_json          JSONB NOT NULL DEFAULT '{}'::jsonb,    -- 完整聚合快照(供下钻)
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_crm_agent_sla_measured ON crm.agent_sla(measured_at DESC);
```

- **幂等落点**：`db/migrate.js` 向后兼容段（line 30 之后）追加上述 `CREATE TABLE IF NOT EXISTS` + 索引；因是建表（非 ADD COLUMN），不受「CREATE IF NOT EXISTS 不补列」陷阱影响，生产/测试库均安全幂等。
- **软轮转**：`materializeAuditabilitySla` 内 `DELETE FROM crm.agent_sla WHERE measured_at < now() - interval '90 days'`（事实表自身轮转，非粒子/决策/记忆，不触「禁 DELETE」铁律）。

---

## §6 物化函数：`materializeAuditabilitySla({ limit = 50 })`

```js
// src/decision/auditabilitySla.js
import { aggregateAuditability } from './auditability.js';
import { queryWrite } from '../db.js';

export async function materializeAuditabilitySla({ limit = 50, retentionDays = 90 } = {}) {
  const agg = await aggregateAuditability({ limit });          // 单一事实源
  await queryWrite(
    `INSERT INTO crm.agent_sla
       (measured_at, window_size, auditability_pct, full_count, with_conflict_count, tampered_count,
        q1_pass,q1_warn,q1_fail, q2_pass,q2_warn,q2_fail, q3_pass,q3_warn,q3_fail, q4_pass,q4_warn,q4_fail, raw_json)
     VALUES (now(), $1,$2,$3,$4,$5, $6,$7,$8, $9,$10,$11, $12,$13,$14, $15,$16,$17, $18)`,
    [agg.scanned, agg.auditability_pct, agg.full, agg.with_conflict, agg.tampered,
     agg.per_status.Q1.pass, agg.per_status.Q1.warn, agg.per_status.Q1.fail,
     agg.per_status.Q2.pass, agg.per_status.Q2.warn, agg.per_status.Q2.fail,
     agg.per_status.Q3.pass, agg.per_status.Q3.warn, agg.per_status.Q3.fail,
     agg.per_status.Q4.pass, agg.per_status.Q4.warn, agg.per_status.Q4.fail,
     JSON.stringify(agg)]
  );
  if (retentionDays > 0) {
    await queryWrite(`DELETE FROM crm.agent_sla WHERE measured_at < now() - make_interval(days=>$1)`, [retentionDays]);
  }
  return agg;
}
```

- **单一事实源**：直接复用 `aggregateAuditability`，与实时端点同口径。
- **写入通道**：走 `queryWrite`（写池），符合「写操作经写池」；不触决策第 0 闸（agent_sla 是派生事实表，非业务写）。
- **失败不静默**：由 timers.js ⑦ 的 `.catch` 统一 `emit('trace') + recordFailure`。

---

## §7 定时接入：`timers.js` ⑦

在 `ensureTimers` 末尾（timers.js:177 之后）新增：

```js
  // ⑦ 可审计性 SLA 快照（2026-08-31）：每 6h 物化一次平台级可审计性 SLA 进 crm.agent_sla
  //    单一事实源=aggregateAuditability；落事实表(非粒子写)；失败 emit trace + recordFailure（G3）
  const slaSnap = setInterval(() => {
    import('../decision/auditabilitySla.js').then(m => m.materializeAuditabilitySla({ limit: 50 }))
      .catch((err) => {
        emit('trace', 'auditability-sla-snapshot-failed', { error: String(err?.message || err) });
        recordFailure('auditability-sla-snapshot-failed', err);
      });
  }, Number(process.env.AUDITABILITY_SLA_INTERVAL_MS || 21600000));
  timers.set('auditability-sla-snapshot', { handle: slaSnap, intervalMs: 21600000, kind: 'rule', registeredAt: now });
```

- 间隔可用 `AUDITABILITY_SLA_INTERVAL_MS` 环境变量或 `config_store['auditability-sla-interval']` 覆盖（阈值配置化铁律）。
- 幂等单例：`ensureTimers` 已有 `if (timers.size > 0) return` 守卫（timers.js:24），多实例不重复注册。

---

## §8 历史端点：`GET /api/monitor/auditability/history`

- **路径**：`src/http/routes.js` 新增（对齐 `monitor/*` 公开家族，无 `requireMe`）；`?days=30`（上限 365）。
- **响应**：`{ rows: [{ measured_at, auditability_pct, full_count, with_conflict_count, tampered_count, per_status:{Q1..Q4:{pass,warn,fail}} }], count }`（由 `crm.agent_sla` 读近期行，`ORDER BY measured_at DESC LIMIT`）。
- **消费方**：① `/agents` 趋势卡（`renderAuditabilitySlaHistory` 复用 `tokens.css`，画迷你 sparkline 或近 N 点条）；② A9 分析循环（见 §9）。

---

## §9 A9 闭环接入点

A9 分析循环（CRM 侧 `src/agent/agentLoop.js` 或等价分析入口）新增只读步骤：

```js
// A9 可审计性趋势监测（只读，不写粒子）
const hist = await fetch('/api/monitor/auditability/history?days=14').then(r => r.json());
const pts = (hist.rows || []).map(r => r.auditability_pct);
if (pts.length >= 2) {
  const drop = pts[0] - pts[pts.length - 1];           // 14 天变化
  if (drop <= -15) emit('alert', 'auditability-regression',
    { from: pts[pts.length-1], to: pts[0], drop, suggestion: '复盘未裁决冲突(Q3)与孤立决策(Q4)' });
}
```

- **只读闭环**：A9 仅读 `agent_sla` / history 端点，产出预警/改进建议，不直写粒子；处置动作按 07 文档 §5-2 由显式写 Action 触发。
- **单一事实源**：A9 与 UI 与实时端点共用 `aggregateAuditability` 口径，退化判定一致。

---

## §10 测试契约（分进程跑，避免连接池伪失败）

| 测试文件 | 验证点 | 模式 |
|---|---|---|
| `test/http/auditability-sla-history.test.js`（新增） | history 端点公开 200 + 字段形状 + `days` 钳制 | `createApp().fetch()` 安全模式（同 audit-4q.test.js） |
| `test/decision/auditabilitySla.test.js`（新增） | `materializeAuditabilitySla` 在测试库 INSERT 一行 + `agent_sla` 表存在断言 | 测试库 `plm_test` 隔离，跑后 TRUNCATE |
| `test/scheduler/timers.test.js`（新增/扩展） | `ensureTimers` 后 `timerCount()` 含 `auditability-sla-snapshot`（计数+1），无重复注册 | 单元 |
| `test/http/migrate-table.test.js`（新增） | 跑 `db/migrate.js` 后 `information_schema` 断言 `crm.agent_sla` 存在 + 列数 | 测试库 |
| **回归** | `audit-4q.test.js`(4/4) + `auditability-sla.test.js`(3/3) | 分进程 |

- **铁律坑（已记）**：`app.fetch` 适配器 `res.headers` 为 Node 原生小写键，断言用 `res.headers['content-type']` 而非 `.get()`。
- **共享模块抽取回归安全**：`computeAudit4q`/`aggregateAuditability` 上移不改 JSON 形状 → 既有 7 测试全绿。

---

## §11 实施步骤与闸门

1. **抽共享模块**：`src/decision/auditability.js`（`computeAudit4q`+`aggregateAuditability`，收口图助手依赖）；routes.js 改为 import。
2. **物化模块**：`src/decision/auditabilitySla.js`（`materializeAuditabilitySla`）。
3. **迁移建表**：`db/migrate.js` 向后兼容段追加 `agent_sla` DDL（§5）。
4. **定时器**：`timers.js` ⑦ 注册（§7）。
5. **历史端点**：routes.js `GET /api/monitor/auditability/history`（§8）。
6. **A9 接入**：agentLoop 只读趋势监测（§9）。
7. **UI 趋势卡**（可选）：`/agents` `renderAuditabilitySlaHistory`。
8. **测试**：§10 新增 + 回归。
9. **闸门（需用户授权/操作）**：
   - `routes.js`/`timers.js` 改动 → **重启 server 生效**。
   - 生产建表：`PGDATABASE=plm node db/migrate.js`（幂等，但属**生产写操作**，需用户显式授权后由用户本地执行；沙箱无 git 凭证，AI 不代跑生产迁移）。
   - **git 提交**：用户本地提交全部改动文件 + 本设计文档。

---

## 附录 A：关键契约示例

**`aggregateAuditability({ limit })` 返回**（与现 monitor 端点一致）：
```json
{ "scanned": 8, "auditability_pct": 53.0, "full": 0, "with_conflict": 7, "tampered": 0,
  "per_status": { "Q1":{"pass":8,"warn":0,"fail":0}, "Q2":{"pass":8,"warn":0,"fail":0},
                  "Q3":{"pass":1,"warn":7,"fail":0}, "Q4":{"pass":0,"warn":8,"fail":0} },
  "decisions": [ ... ] }
```

**`agent_sla` 一行**（物化后）：`measured_at, window_size=8, auditability_pct=53.0, full=0, with_conflict=7, tampered=0, q1{8,0,0}, q2{8,0,0}, q3{1,7,0}, q4{0,8,0}, raw_json=<聚合快照>`

---

## 附录 B：与上一轮交付的关系

- 本设计是 `2026-08-31-decision-auditability-4q-design.md` §9.2 待办#3（SLA 看板）的**深化**：上次做「实时端点 + /agents 卡片」，本次做「持久时序 + 定时物化 + A9 闭环」。
- 复用：`computeAudit4q`（routes.js:2256）、`/api/monitor/auditability`、`renderAuditabilitySla`（agentsPage.js）、`tokens.css` 语义变量；不重复造轮子。
