# AI 原生 CRM · 阶段 2 子系统二 · 记忆治理底座设计（ai-memory-lifecycle · 记忆三构件·底座）

- 日期：2026-08-25
- 方法论依据：`ai-memory-lifecycle`（双轨记忆 / 分层治理 / 生命周期 / 防污染 / 30 天蒸馏 / residue 铁律）
- 前置架构：`docs/2026-08-25-ai-native-crm-overall-design.md` §6.8（记忆三构件）/ §3（跨平面事件流）
- 配套实例化：`docs/2026-08-25-05-ai-memory-lifecycle.md`（10 能力实例化设计，本 spec 是其阶段 2 落地子集）
- 上一步：阶段 2 子系统一 上下文分层 L1-L4（已批准+实施完成，commit `c9f83fc`→`f52a8ea`）

> **状态：已批准（2026-08-25）+ 实施完成（T1–T8 提交 01923f3→b22bafa；纯逻辑 10 例本地绿：T2 5/5、T3 3/3、T6 2/2；DB 集成需 PG 就绪环境验收）**

## 0. 范围裁定（来自 brainstorming 首问）

本轮落地「**记忆治理底座**」（选项 A），不含跟进/评论/@提及捕获（需新建 FOLLOW_UP/COMMENT 粒子 + @提及事件 + UI，属阶段 3 业务闭环增量）。本轮产出：记忆三构件的**存储 + 生命周期治理 + 单汇点捕获**底座，并预留 capture 钩子供阶段 3 跟进记忆流接入。

## 1. 现有底座核查（file:line 锚定）

- `crm.memory_log`（`db/schema.sql:193`）：append-only，列 `id/topic/kind/payload/weight/created_at`，**无 layer/distilled/archived/ttl/actor/event_type**；索引 `idx_crm_memory_log_topic(topic, created_at)`。
- `crm.decision` + `decision_event` + `decision_precedent_rel`：决策主轴（阶段 1 已建），`decisionRepo.appendMemory`（`src/decision/decisionRepo.js:84`）直写 `memory_log`（kind='decision', topic=`decision:<id>`）。
- 9 粒子类型（`src/particles/particleModel.js:5`）：无 FOLLOW_UP / COMMENT。
- L2 事件总线（`src/events`，阶段 1 已建）：发出 task/trace/approval/particle/payment + decision 域事件。
- 上下文分层 assembler（`src/context/assembler.js`）：L2 当前读 decision + memory_log（未走统一 retrieve 服务）。

## 2. 架构与模块划分（新建 `src/memory/`，与 `src/context/`、`src/decision/` 同构：纯函数 + 薄 DB 访问）

| 模块 | 职责 | 关键导出 |
|---|---|---|
| `judge.js` | 写入门槛闸门（纯函数，无 DB） | `judgeWorthiness(payload, {explicit, valueHorizonDays})` → `{ok, code, reason}` |
| `memoryLog.js` | `memory_log` 扩展后读写 + 蒸馏 | `appendMemory` / `retrieveMemory` / `distillMemory` |
| `snapshot.js` | `memory_snapshot` 不可变快照 | `createSnapshot` / `getSnapshot(refId)` |
| `note.js` | `memory_note` L-User 常驻笔记 upsert | `upsertNote` / `getNote(layer, topic)` |
| `capture.js` | 事件总线订阅者（residue 零摩擦单汇点） | `captureMemory(event)` + 总线注册 |

**设计铁律**：记忆是事件副产物，**不为 memory 开扁平 CRUD Action 表面**；`memory_log` 不导出 update/delete，`memory_snapshot` 仅 INSERT。

## 3. 数据模型（`db/schema.sql`）

### 3.1 扩展 `memory_log`（沿用单租户、无 tenant_id 约定）

```sql
ALTER TABLE crm.memory_log
  ADD COLUMN layer      TEXT    NOT NULL DEFAULT 'L-Workspace',
  ADD COLUMN actor      TEXT,
  ADD COLUMN event_type TEXT,
  ADD COLUMN distilled  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN archived   BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN ttl_days   INTEGER NOT NULL DEFAULT 30;
CREATE INDEX idx_crm_memory_log_layer_topic ON crm.memory_log(layer, topic, created_at);
```

> 阶段 1 决策主轴直写 `memory_log` 的 `appendMemory`（`src/decision/decisionRepo.js:84`）**重构为委托 `memory.appendMemory`**，成为唯一汇点（低风险，decision 测试作回归护栏，行为等价）。

### 3.2 新增 `memory_snapshot`（审批/凭证不可变快照）

```sql
CREATE TABLE IF NOT EXISTS crm.memory_snapshot (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  topic     TEXT NOT NULL,
  ref_id    TEXT,
  snapshot  JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_memory_snapshot_ref ON crm.memory_snapshot(ref_id, created_at);
```

### 3.3 新增 `memory_note`（L-User UI 偏好 upsert）

```sql
CREATE TABLE IF NOT EXISTS crm.memory_note (
  layer    TEXT NOT NULL DEFAULT 'L-User',
  topic    TEXT NOT NULL,
  content  JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ttl_days INTEGER NOT NULL DEFAULT 365,
  archived BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (layer, topic)
);
```

### 3.4 种子（`db/seed.sql`）

追加 1 行 `memory_note` 示例（L-User UI 偏好：导入导出字段/排序），验证 L-User 跨会话复用路径。`memory_log` 由决策主轴运行期写入，无需种子。

## 4. 关键逻辑

### 4.1 `judgeWorthiness` 四优先级（不可颠倒）

```js
judgeWorthiness(payload, { explicit = false, valueHorizonDays = 30 }) ->
  // ① 敏感凭证硬拒（即便 explicit 也拦）
  if /(api[_-]?key|token|password|secret|私钥|凭证)/i.test(serialized) return {ok:false, code:'credential'}
  // ② 显式意图优先
  if explicit return {ok:true}
  // ③ 瞬态噪声正则拒（非 explicit）
  if /(grep|rg|find|ls|cat|echo|tmp|node_modules|\.cache|Error|Exception|traceback|timeout|搜索词)/i.test(serialized) return {ok:false, code:'noise'}
  // ④ 价值视界 < 30 且非 explicit 拒
  if valueHorizonDays < 30 return {ok:false, code:'horizon'}
  return {ok:true}
```

### 4.2 `captureMemory(event)`（residue 零摩擦单汇点）

- 总线订阅 `decision_*` / `particle_write` / `approval_*` / `evidence_*` 事件。
- 构造 `{topic, kind, payload, actor, eventType, layer}` → `judgeWorthiness` 闸门（拒则 emit `trace` 不写）→ `appendMemory`。
- 决策类仍由决策主轴委托写入（避免双写）；其余事件种类由本订阅者捕获。

### 4.3 `distillMemory(ttlDays=30)`（幂等，归档非删除）

- `memory_log`：`created_at < now()-ttlDays` 且 `distilled=false` → 标 `distilled=true`（保留时间线）；超 `2×ttlDays` → `archived=true`（移出活跃召回，原始行保留）。
- `memory_note`：`updated_at < now()-ttl_days` → `archived=true`。
- 提供 `POST /api/memory/distill?dryRun=1` 端点 + 可调用函数（夜间调度留待后续阶段）。

### 4.4 `retrieveMemory(layer, topic, {channel})`（按来源选通道，不全量重读）

- `channel='log'|'note'|'snapshot'|'auto'`；`archived=true` 默认过滤。
- **接入上下文分层 L2**：`src/context/assembler.js` L2 检索改调 `memory.retrieveMemory`，使干净记忆被注入（蒸馏质量→注入质量，呼应 doc 05 §4 边界）。

## 5. 接口边界（不越权）

- **消费方**：`src/context/assembler.js` L2（记忆注入）、`src/agent/agentLoop.js`（跨会话引用）、未来 `src/portal`（记忆回显）。
- **触发源**：L2 事件总线（`src/events`，阶段 1 已建）。
- **不覆盖**：上下文层级语义（L1-L4，属 context 能力）、embedding 模型选型、检索排序算法、memory 语义向量召回（检索按 layer+topic 来源选通道，非 pgvector）。

## 6. 测试与验收（沿用上下文子系统策略）

- **纯逻辑（本沙箱无 PG 可本地绿）**：`judgeWorthiness` 四优先级全路径；`distillMemory` 幂等（内存 mock store）；`retrieveMemory` 通道选择（注入 store）；capture 闸门拒凭证/噪声。
- **DB 集成（需用户 PG 就绪环境）**：append/retrieve/distill 往返、snapshot 不可变、note upsert、`captureMemory` 总线 E2E、decision 主轴委托回归。
- 验收判据对齐 doc 05 §5：双轨 append-only、蒸馏标 `distilled` 非删除、防污染四优先级、按层/主题选通道、residue 单汇点无独立记录动作。

## 7. 不做（YAGNI）

- ❌ FOLLOW_UP/COMMENT 粒子 + @提及事件 + 跟进记忆流 UI（阶段 3 业务闭环增量）。
- ❌ L-Cloud 隐式画像推导（后续阶段）。
- ❌ memory 语义向量召回（embeddings 仅决策先例用）。
- ❌ memory 独立 CRUD Action 表面。

## 8. 实施计划入口（writing-plans）

TDD 逐 Task commit，模块顺序：`schema(+seed)` → `judge` → `memoryLog` → `snapshot` → `note` → `capture`(挂总线+决策委托重构) → `assembler` L2 接入 → `distill` 端点 → 测试(纯逻辑+DB集成) → 文档状态更新。每 Task 一 commit，纯逻辑子集本机绿，DB 集成标注「需 PG 就绪环境」。
