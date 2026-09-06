# C2→C3→C4 决策完整性实施计划

> **上游设计**：`docs/2026-09-03-cognitive-decision-loop-design.md`（C1–C9 统一方案）
> **上游取证**：`docs/2026-09-03-lightfield-semantica-{trigger,decision}-analysis.md`
> **取代关系**：本计划**取代** `docs/superpowers/plans/2026-09-03-p0-decision-integrity-implementation.md`（该文档 §C2 前提已被本轮核验推翻，见 §1；旧文档保留作历史，不再作为执行依据）
> **范围**：C2 决策不可变审计链 / C3 决策时刻冻结 / C4 先例加权 + 决策网络。**不含** C1（事件触发层）与 P1/P2 项。
> **用户已裁决（2026-09-03）**：①哈希白名单纳入 `entry_type`/`source`/`activity_id`/`invalidated`/`archived`；②阈值快照先落全量 dump；③C4 向量走混合降级（无真 embedding 时不返回噪声）；④C1 首批事件留二期。
> **状态**：实施中。
>
> | Task | 内容 | 状态 | 交付 |
> |---|---|---|---|
> | T1 | 哈希白名单 v2（分代兼容） | ✅ 完成 2026-09-03 | `db/migration-decision-integrity.sql`（`hash_version` 列）、`provenance.js` `shaChainEntry`+FORKED/BROKEN_HEAD、`test/provenance-hash-v2.test.js`（11 tests）。⚠ 计划代码漏传 `previous_checksum`，已修 |
> | T2 | 写时自检 + 定时巡检 + 封印比对 | ✅ 完成 2026-09-03 | `verifyTail`/`patrolChains`、`timers.js` 定时器 8→9、配置中心 **id37**（计划原写 33 已被占用）+ `/api/config/provenance-patrol`、`scripts/provenance-patrol-once.mjs`、`test/provenance-patrol.test.js`（10 tests）。生产 19 链全 OK |
> | T3 | `decision_event` 入链 | ✅ 完成 2026-09-03 | `decisionRepo.js` `recordDecisionEvent` 桥接（`decision_id` 非空准入）；`auditability.js` Q2 溯源口径收窄为证据条目（`event:*` 不计分，另以 `event_entries` 暴露）。⚠ 27 处只有 **4 类真入链**（made/autonomous/escalated/human-disposition），23 处 `decision_id` 恒 null（含 19 处 `configRouter.js:30` 第 0 闸降级路径）不入链 —— 无归属不产孤儿 |
> | T4 | C2 测试补强 | ✅ 完成 2026-09-03 | `test/provenance-integrity.test.js`（8 tests，端到端集成回归）；T4 表 7 项分别落在 hash-v2(1,2,3) / patrol(4,5,6) / integrity(7)。⚠ 期间抓出 `ensureProvenanceSchema()` 旧 DDL 缺 `archived`/`hash_version` 列（DROP 后重建即残表）|
> | T5–T6 | C3 阈值版本固化 | ✅ 完成 2026-09-03 | `src/decision/policyVersion.js`（内容哈希幂等 + 封版 + 回滚解封）、`autonomyEngine.js:136-146` 接线（**两处** `effective_policy_version`，升级路径缩进不同易漏）、`scripts/policy-version-once.mjs`、`test/policy-version.test.js`（7 tests）。生产基线取证：156 决策仅 6 条有锚点且全为 `pv-test-001` e2e 伪造 → **真实业务路径仍 0** |
> | T7–T9 | C4 先例检索换算法 | ⬜ 待做 | |

---

## §0 一句话结论

C2/C3/C4 **都不是"从零新建"，而是"建了但没通电/没接线/算法失效"**。本计划的核心动作是**通电、接线、换算法**，而不是造新东西。

---

## §1 写计划前的核验推翻了两处前序前提（必读）

> 这两处推翻直接改变任务性质与工作量，执行前必须知晓。

### 1.1 ❌ 推翻：C2「DDL 未入 schema.sql、生产 100% 失败」

| 前序判断 | 核验后真相 | 证据 |
|---|---|---|
| `ensureProvenanceSchema()` 生产 0 调用、DDL 未入 `schema.sql` → 9 处 `trackEntry` 恒抛 relation does not exist | **已修复**。`schema.sql:632` 有完整 `CREATE TABLE crm.decision_provenance`（**含 `archived` 列**），注释自陈"DDL 回归 schema.sql 单一事实源，由 migrate 统一建表" | `db/schema.sql:628-646`；归属 commit `1af3373 feat(cognitive): 恢复对象库至 550afa03 + P-1/P1 供给层修复` |
| `verifyChain` **0 处调用** = 装了报警器没通电 | **部分修正**。`verifyChain` 经 `exportAudit` 被 **4 处生产代码**调用，但**仅在"审计导出 / 可审计性评估"时触发**——无写时自检、无定期巡检 | `routes.js:2184`、`:2444`、`auditability.js:43`、`seed-actions.js:481` |
| 9 处 `trackEntry` 静默失败 | **已修**（裸 catch → emit trace + recordFailure）。但**留痕不等于根因已修**：根因（DDL）现已修，需实测确认 `provenance-track-failed` 是否已消失 | `assembleContextV2.js:211-212/219-220` |

**结论**：C2 的任务从"DDL 归位"变为 **"链校验常态化 + 哈希白名单 + 事件入链"**（§4 T1–T4）。

### 1.2 ⚠️ 修正：AGE 图**没有**中心性接口，C4 第四分量需重选

Semantica 的"图中心性增益"依赖图算法能力。核验本项目 `ageGraph.js` 导出：**无 centrality**，只有 `traceUpstream(:170)` / `traceDownstream(:195)` / `impactMap(:220)` / `ctePrecedents(:233)`。

**决策**：把第四分量从 `centrality`（图中心性）改为 **`graphDepth`（先例引用深度）**——用 `ctePrecedents(id, {maxDepth:3})` 返回结果的规模归一化。语义更贴切：*一个先例被后续决策引用得越多，它越是被反复验证过的权威先例*。
> 这是**借用 Semantica 的意图、换用我们已有的实现**，避免为一个分量引入整套图算法依赖（也符合"旁路进程"的架构克制）。

### 1.3 ✅ 维持成立的两项

- **C3/H2**：`policy_version` 表 `src/` 下**零写入**（仅 `scripts/e2e-decision-deep-test.mjs:574`、`e2e-deep-probe3.mjs:18` 两个 e2e 脚本伪造）；`effective_policy_version` 仅 `autonomyEngine.js:274/303` 取 `opts.policy_version || null`，**零生产传入 → 恒 null**。
- **C4/H3**：`hashVector` 结构性恒空（实验证据：逐字相同 cos=1.0 / 仅 id 金额不同 cos=0.1146 / 200 次微变过 0.6 闸仅 1 次且是与自身比）。**必须先换算法再灌数据**。

---

## §2 现状基线（实施前快照）

| 项 | 位置 | 现状 |
|---|---|---|
| 建表 DDL | `db/schema.sql:632-646` | ✅ 已归位，含 `archived` |
| 链写入 | `provenance.js:44 trackEntry` | ✅ 9 处调用，DDL 已通 |
| 哈希算法 | `provenance.js:37 shaChain` | ⚠️ **只哈希 payload**（`entry_type`/`source`/`activity_id`/`invalidated`/`archived` 篡改不可检出） |
| 链校验 | `provenance.js:61 verifyChain` | ⚠️ 仅经 `exportAudit` 间接触发，无巡检；**并发写入可链分叉**（无锁、无 seq 约束） |
| 事件入链 | `decisionRepo.js:445 recordDecisionEvent` | ❌ **27 处调用，0 桥接** — 决策生命周期事件完全在链外 |
| 策略版本 | `schema.sql:139` 表 / `:156` 列 / `:232` 索引 | ❌ 表零写入、列恒 null |
| 先例检索 | `decisionRepo.js:429 searchPrecedents` | ❌ 伪向量排序，结构性恒空 |
| S2 阈值 | `assembleContextV2.js:89` | ❌ 硬编码 `minSimilarity: 0.6`，与伪向量叠加后恒空 |
| AGE 图 | `ageGraph.js:233 ctePrecedents` | ✅ 可作第四分量数据源 |
| 测试基线 | `test/provenance{,-chain}.test.js` | ✅ 存在，可作扩展模板 |

---

## §3 目标架构与不变量

### 3.1 不变量（任何 Task 不得违反）

- **I1 禁裸 catch**：所有 fail-safe 必须 `emit('trace', ...)` + `recordFailure(...)`（导入：`emit` from `../events/bus.js`、`recordFailure` from `../monitor/monitorStore.js`，沿用 `decisionRepo.js:14/19` 写法）。
- **I2 禁 DELETE**：provenance 为 append-only，擦除走 `invalidated` 墓碑；测试清理沿用既有 `TRUNCATE ... RESTART IDENTITY CASCADE`（`test/provenance-chain.test.js:9`）。
- **I3 DDL 单一事实源**：新表/新列必须进 `db/schema.sql`；老库补列走独立 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`，登记进 `db/migrate.js:11 INCREMENTAL_SQL`（参照同文件 `:52/:58/:67/:77` 既有写法）。
- **I4 阈值配置化**：新阈值一律走 `config_store` + `readConfig`，出厂兜底，**禁硬编码**。
- **I5 决策闸确定性**：本计划改动的是"记录/冻结/检索"，**不改 disposition 判定逻辑**；agent 不回灌 disposition。
- **I6 幂等可重跑**：`resolvePolicyVersion`、迁移 SQL、巡检任务均可重复执行且无副作用。

### 3.2 目标态

```
C2 审计链   trackEntry(写，带 hash_version=2) ─┬─> verifyTail(写时自检)
                                              └─> chain-patrol(定时全量巡检 + seal 快照比对)
             recordDecisionEvent ──桥接──> trackEntry(entry_type='event:<type>')

C3 时刻冻结 requireDecision ──> resolvePolicyVersion(全量 dump + 内容哈希复用)
                           └─> effective_policy_version = pv-...(真值，非 null)

C4 先例     粗召回(scenario+state, 候选 N) ──> 四分量精算(jaccard/category/graphDepth/vector)
                                          └─> 权重归一强校验 + 向量降级(provider=hash 时权重重分配)
```

---

## §4 任务分解（9 Task，每 Task 一 commit）

> 前置：**PG 必须可达**（当前 5433 不可达，非 Windows 服务需手动启动）。T1/T5/T7 的实证与 T9 全量回归都依赖它。

---

### T1 — 哈希白名单升级（分代兼容，零破坏）

**目标**：让 `entry_type`/`source`/`activity_id`/`invalidated`/`archived` 纳入哈希，同时**不破坏历史行的校验能力**。

**文件**：`db/migration-decision-integrity.sql`（新增）、`db/migrate.js`（登记）、`src/decision/provenance.js`

#### 1.1 新建 `db/migration-decision-integrity.sql`

```sql
-- C2/C4 决策完整性（2026-09-03）
-- 设计：docs/2026-09-03-c2c3c4-decision-integrity-implementation.md T1/T2

-- T1：哈希代次列。v1 = 历史行（仅哈希 payload）；v2 = 白名单版（哈希身份+语义+墓碑字段）。
--      verifyChain 按行分派算法 → 升级后历史行仍可被检出篡改，不因算法升级而全量失效。
ALTER TABLE crm.decision_provenance ADD COLUMN IF NOT EXISTS hash_version INT NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_crm_decision_provenance_hv ON crm.decision_provenance(hash_version);

-- T2：巡检封印快照。哈希链固有盲区 = 删除「链尾」无后继引用 → 不可检出。
--      巡检时记录 (head_checksum, entry_count)，下次比对：count 减少 或 head 倒退 → 告警。
CREATE TABLE IF NOT EXISTS crm.provenance_seal (
  decision_id    UUID PRIMARY KEY,
  head_checksum  TEXT,
  entry_count    INT NOT NULL DEFAULT 0,
  sealed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_status    TEXT
);
```

#### 1.2 `db/migrate.js` 登记

在 `INCREMENTAL_SQL`（`:11`）数组末尾追加：

```js
  'migration-decision-integrity.sql',  // C2/C4 决策完整性（provenance 哈希代次 + 巡检封印）
```

#### 1.3 `src/decision/provenance.js` 改造

**关键点**：**保留 `shaChain` 原签名原语义**（v1），**新增 `shaChainEntry`**（v2）。老调用方与老测试零破坏。

```js
// ───────────────────── 哈希白名单（T1） ─────────────────────
// 白名单设计（对齐 Semantica integrity.py:45-51 的「哪些字段不进哈希」教训）：
//   纳入 = 身份 + 语义 + 墓碑。理由：只哈希 payload 时，把某条审计记录的 entry_type 从
//          'decision' 改成 'entity'、或把 invalidated 墓碑翻转，链校验**完全无感**。
//   排除 = created_at / id。理由：id 由 BIGSERIAL 自增、created_at 由 now() 生成，
//          二者若入哈希则「读回重算」必然与原值一致（无篡改检出价值），
//          但会让「重建行」这类操作极易误判为 TAMPERED（Semantica 排除 entity_id 同理）。
export const HASH_VERSION = 2;
export const HASH_FIELDS = ['decision_id', 'entry_type', 'payload', 'source', 'activity_id', 'invalidated', 'archived'];

function pickHashFields(entry = {}) {
  const out = {};
  for (const k of HASH_FIELDS) out[k] = k in entry ? entry[k] : null;
  return out;
}

// v2：白名单哈希（新增，供 trackEntry 使用）
export function shaChainEntry(entry, previousChecksum, { version = HASH_VERSION } = {}) {
  const h = createHash('sha256');
  h.update(`v${version}|`);
  h.update((previousChecksum || '') + '|');
  h.update(canonical(pickHashFields(entry)));
  return h.digest('hex');
}

// v1：仅 payload（保留，供历史行校验与老调用方；签名语义不变）
export function shaChain(payload, previousChecksum) {
  const h = createHash('sha256');
  h.update((previousChecksum || '') + '|' + canonical(payload));
  return h.digest('hex');
}

function hashOf(row, previousChecksum) {
  return Number(row?.hash_version || 1) >= 2
    ? shaChainEntry(row, previousChecksum, { version: Number(row.hash_version) })
    : shaChain(row.payload, previousChecksum);
}
```

**`trackEntry` 改为 v2 并写入代次**：

```js
export async function trackEntry({ decision_id, entry_type, payload, source = null, activity_id = null }) {
  const prev = (await query(
    `SELECT id, checksum FROM crm.decision_provenance WHERE decision_id=$1 ORDER BY id DESC LIMIT 1`,
    [decision_id]
  )).rows[0];
  const previous_checksum = prev ? prev.checksum : null;
  // v2：把身份/墓碑字段一并送进哈希（对象形态，字段由 pickHashFields 白名单裁剪）
  const checksum = shaChainEntry({ decision_id, entry_type, payload, source, activity_id, invalidated: false, archived: false });
  const r = await queryWrite(
    `INSERT INTO crm.decision_provenance
       (decision_id, entry_type, payload, source, activity_id, checksum, previous_checksum, hash_version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [decision_id, entry_type, JSON.stringify(payload), source, activity_id, checksum, previous_checksum, HASH_VERSION]
  );
  return r.rows[0];
}
```

**`verifyChain` 分派 + 新增分叉/断头检出**：

```js
// 重算整链校验和，逐项比对。
// 检出四类状态：TAMPERED（内容或链序不符）/ FORKED（同 previous_checksum 多条 → 并发写入分叉）
//             / BROKEN_HEAD（首条 previous_checksum 非空 → 链头被删）/ OK
export async function verifyChain({ decision_id }) {
  const rows = (await query(
    `SELECT id, decision_id, entry_type, payload, source, activity_id, invalidated, archived,
            checksum, previous_checksum, hash_version
     FROM crm.decision_provenance WHERE decision_id=$1 ORDER BY id`,
    [decision_id]
  )).rows;
  let prev = null;
  const seenPrev = new Set();
  for (const row of rows) {
    if (row.previous_checksum !== prev) {
      // 首条即非空 previous → 链头被删；否则为链序断裂
      return { status: prev === null && row.previous_checksum ? 'BROKEN_HEAD' : 'TAMPERED', broken_at: row.id };
    }
    if (row.previous_checksum && seenPrev.has(row.previous_checksum)) {
      return { status: 'FORKED', broken_at: row.id }; // 同 prev 多条 = 并发分叉（无锁写入的固有风险）
    }
    if (row.previous_checksum) seenPrev.add(row.previous_checksum);
    if (hashOf(row, prev) !== row.checksum) return { status: 'TAMPERED', broken_at: row.id };
    prev = row.checksum;
  }
  return { status: 'OK', entries: rows.length, head: prev };
}
```

**验收（T1）**
1. 新建 v2 行后改 `entry_type` → `verifyChain` 返回 `TAMPERED`（旧实现返回 OK）。
2. 手工构造 `hash_version=1` 的历史行 → `verifyChain` 仍返回 `OK`（分代兼容）。
3. `test/provenance*.test.js` 全绿（老测试调 `shaChain` 不受影响）。

---

### T2 — 写时自检 + 定时巡检（链校验常态化）

**目标**：把 `verifyChain` 从"只有人导出审计报告时才跑"变成"写入即自检 + 定时全量巡检 + 封印比对"。

**文件**：`src/decision/provenance.js`、`src/scheduler/timers.js`

#### 2.1 `provenance.js` 新增 `verifyTail` 与 `patrolChains`

```js
// 写时自检：只校验链尾（O(1)，不重算全链）。
// 价值：检出自本次写入起的链断裂（含并发分叉导致的 previous 错位），失败必须留痕（I1）。
export async function verifyTail({ decision_id }) {
  const rows = (await query(
    `SELECT id, decision_id, entry_type, payload, source, activity_id, invalidated, archived,
            checksum, previous_checksum, hash_version
     FROM crm.decision_provenance WHERE decision_id=$1 ORDER BY id DESC LIMIT 2`,
    [decision_id]
  )).rows;
  const cur = rows[0];
  if (!cur) return { status: 'EMPTY', entries: 0 };
  const prev = rows[1];
  if ((cur.previous_checksum || null) !== (prev ? prev.checksum : null)) {
    return { status: prev ? 'TAMPERED' : 'BROKEN_HEAD', broken_at: cur.id, entries: rows.length };
  }
  if (hashOf(cur, prev ? prev.checksum : null) !== cur.checksum) {
    return { status: 'TAMPERED', broken_at: cur.id, entries: rows.length };
  }
  return { status: 'OK', entries: rows.length, head: cur.checksum };
}

// 定时巡检：全量重算 + 封印比对（补哈希链「删链尾不可检出」的固有盲区）。
//   seal 比对规则：entry_count 减少 或 head_checksum 倒退变更 → 判 TAMPERED 并告警。
export async function patrolChains({ limit = 200, tenantId = 'system' } = {}) {
  const ids = (await query(
    `SELECT DISTINCT decision_id FROM crm.decision_provenance
     ORDER BY decision_id LIMIT $1`, [limit]
  )).rows.map((r) => r.decision_id);
  const results = { scanned: ids.length, ok: 0, tampered: 0, forked: 0, head_lost: 0, sealed: 0 };
  for (const decision_id of ids) {
    let v;
    try {
      v = await verifyChain({ decision_id });
    } catch (e) {
      emit('trace', 'provenance-patrol-error', { decision_id, error: String(e?.message || e) });
      recordFailure('provenance-patrol-error', e);
      continue;
    }
    const seal = (await query(`SELECT head_checksum, entry_count FROM crm.provenance_seal WHERE decision_id=$1`, [decision_id])).rows[0];
    let status = v.status;
    if (status === 'OK' && seal) {
      if (v.entries < Number(seal.entry_count)) status = 'HEAD_LOST';       // 条目变少 = 链尾被删
      else if (seal.head_checksum && v.head !== seal.head_checksum && v.entries === Number(seal.entry_count))
        status = 'TAMPERED';                                                // 条目数不变但头变了 = 就地篡改
    }
    if (status === 'OK') results.ok++;
    else if (status === 'FORKED') results.forked++;
    else if (status === 'HEAD_LOST') results.head_lost++;
    else results.tampered++;
    if (status !== 'OK') {
      emit('trace', 'provenance-chain-violation', { decision_id, status, entries: v.entries, broken_at: v.broken_at || null });
      recordFailure('provenance-chain-violation', new Error(`chain ${status} @${v.broken_at || '-'} decision=${decision_id}`));
    }
    await queryWrite(
      `INSERT INTO crm.provenance_seal (decision_id, head_checksum, entry_count, sealed_at, last_status)
       VALUES ($1,$2,$3, now(), $4)
       ON CONFLICT (decision_id) DO UPDATE SET head_checksum=$2, entry_count=$3, sealed_at=now(), last_status=$4`,
      [decision_id, v.head || null, v.entries || 0, status]
    );
    results.sealed++;
  }
  return results;
}
```

#### 2.2 `trackEntry` 末尾挂写时自检（fail-open，I1）

在 `trackEntry` 的 `return r.rows[0];` 之前插入：

```js
  // 写时自检（fail-open）：仅留痕，不阻断主写。失败/异常链会在定时巡检中再次暴露。
  verifyTail({ decision_id })
    .then((v) => { if (v.status !== 'OK') { emit('trace', 'provenance-tail-violation', { decision_id, status: v.status, broken_at: v.broken_at || null }); recordFailure('provenance-tail-violation', new Error(`tail ${v.status} decision=${decision_id}`)); } })
    .catch((e) => { emit('trace', 'provenance-tail-check-failed', { decision_id, error: String(e?.message || e) }); recordFailure('provenance-tail-check-failed', e); });
  return r.rows[0];
```

#### 2.3 `src/scheduler/timers.js` 加巡检定时器

在 `ensureTimers` 内、`ready-queue-pump`（`:231`）之前插入（**照抄 `:213` auditability-sla-snapshot 的"读配置 + setInterval + 立即预热"三段式**）：

```js
  // C2 审计链巡检（2026-09-03）：把 verifyChain 从「仅审计导出时触发」升级为「定时全量巡检 + 封印比对」
  const patrolCfg = (await readConfig('provenance-patrol', { tenantId: 'system' }).catch(() => null))?.value || {};
  const patrolIntervalMs = Number(process.env.PROVENANCE_PATROL_MS || patrolCfg.interval_ms || 3600000);
  const patrolLimit = Number(patrolCfg.limit || 200);
  const runPatrol = () => {
    if (!process.env.VITEST) {   // 测试隔离护栏：避免后台写与断言竞态（同 decision-agent 派发护栏）
      import('../decision/provenance.js').then((m) => m.patrolChains({ limit: patrolLimit }))
        .then((r) => { if (r && (r.tampered || r.forked || r.head_lost)) emit('trace', 'provenance-patrol-alert', r); })
        .catch((err) => { emit('trace', 'provenance-patrol-failed', { error: String(err?.message || err) }); recordFailure('provenance-patrol-failed', err); });
    }
  };
  const patrolTimer = setInterval(runPatrol, patrolIntervalMs);
  runPatrol();   // 启动预热（禁「重启后首屏恒空」，同既有 SLA 定时器约定）
  timers.set('provenance-patrol', { handle: patrolTimer, intervalMs: patrolIntervalMs, kind: 'rule', registeredAt: now });
```

#### 2.4 配置项登记（I4）

`src/portal/configCenter.js` CONFIG_ITEMS 新增一项（**同步三处**：configCenter.js / config.html GROUPS / configCenter.test.js）：

```js
{ id: 33, key: 'provenance-patrol', name: '审计链巡检', group: '治理',
  desc: '定期重算决策审计链并比对封印，检出篡改/分叉/删链尾',
  defaultValue: { interval_ms: 3600000, limit: 200 } },
```

**验收（T2）**
1. `ensureTimers()` 后定时器数 +1（现基线 8 → 9）。
2. 手工 `UPDATE` 篡改一条 v2 行的 `entry_type` → 巡检返回 `tampered ≥ 1`，且 `monitor_event` 有 `provenance-chain-violation`。
3. 手工删链尾行 → 巡检返回 `head_lost ≥ 1`（这是旧实现完全检不出的场景）。

---

### T3 — `decision_event` 入链

**目标**：27 处 `recordDecisionEvent` 的生命周期事件进入审计链（当前完全在链外）。

**文件**：`src/decision/decisionRepo.js`

在 `recordDecisionEvent`（`:445`）落库后、`emit` 之后插入桥接：

```js
// 决策生命周期事件写回审计链（C2）。
//   范围：仅 decision_id 非空者（'required' 等前决策事件无 id，不入链 —— 无归属不入链，避免孤儿条目）。
//   fail-open（I1）：审计写入失败不得阻断业务事件广播。
if (decision_id) {
  const { trackEntry } = await import('./provenance.js');
  await trackEntry({
    decision_id,
    entry_type: `event:${event_type}`,
    payload: { event_type, scenario_id, tenantId, ...payload },
    source: 'decision-event',
    activity_id: decision_id,
  }).catch((err) => {
    emit('trace', 'provenance-event-track-failed', { decision_id, event_type, error: String(err?.message || err) });
    recordFailure('provenance-event-track-failed', err);
  });
}
```

**注意**：`auditability.js:76-82` 的 Q2 判定区分 `provEntries`（decision 类）与 `supplyEntries`（context_supply 类）。新增 `event:*` 条目会改变计数，**必须在 T4 回归该判定**。若 Q2 语义要求不变，需把分类收窄为 `entry_type NOT LIKE 'event:%'`。

**验收（T3）**
1. `createDecision` 后 `decision_provenance` 同时含 `decision` 与 `event:made` 两类条目。
2. `verifyChain` 仍 `OK`（事件条目按 v2 入链，顺序稳定）。
3. `GET /api/decision/:id/selfcheck` 7 问无回归。

---

### T4 — C2 测试

**文件**：`test/provenance-integrity.test.js`（新增）

沿用 `test/provenance-chain.test.js:1-11` 模板（显式 import vitest、`beforeEach` TRUNCATE + `ensureProvenanceSchema`）。至少覆盖：

| # | 用例 | 断言 |
|---|---|---|
| 1 | 改 `entry_type` | `verifyChain.status === 'TAMPERED'`（**旧实现 OK → 本用例是回归锁**） |
| 2 | 翻转 `invalidated` 墓碑 | `TAMPERED` |
| 3 | 历史行 `hash_version=1` | `OK`（分代兼容） |
| 4 | 删除链尾行 | `patrolChains` 返回 `head_lost ≥ 1` |
| 5 | 正常链两次巡检 | 第二次全 `OK`，`sealed` 计数递增 |
| 6 | `verifyTail` 空决策 | `status === 'EMPTY'` |
| 7 | 事件入链 | 含 `event:made` 且 `verifyChain === 'OK'` |

**测试隔离**：`patrolChains` 会全表扫描，用例 4/5 须自行清理 `crm.provenance_seal`，避免污染其他用例。

---

### T5 — 策略版本解析器 + `requireDecision` 接线（C3）

**目标**：让 `effective_policy_version` 从恒 null 变成"决策当时生效的配置快照版本 ID"。

**文件**：`src/decision/policyVersion.js`（新增）、`src/decision/autonomyEngine.js`

#### 5.1 新建 `src/decision/policyVersion.js`

```js
// src/decision/policyVersion.js — C3 决策时刻冻结：策略版本解析（内容哈希幂等复用）
// 设计：docs/2026-09-03-c2c3c4-decision-integrity-implementation.md T5
// 语义：决策落库时冻结「当时生效的配置快照」。事后改配置不得洗掉历史决策的判定依据。
import { query, queryWrite } from '../db.js';
import { readConfig } from '../config/configStore.js';
import { emit } from '../events/bus.js';
import { recordFailure } from '../monitor/monitorStore.js';
import { createHash } from 'node:crypto';
import { stableStringify } from '../ontology/embedding.js';

// 快照范围 = 决策链路**实际消费**的配置键（逐点取证，非拍脑袋）：
//   autonomy-conf        autonomyEngine.js:33   置信度阈值与权重
//   sales-thresholds     autonomyEngine.js:179/340、methodologyExtractor.js:271
//   hindsight-deviation  closureLoop.js:24
//   context-guard        contextGuard.js:18
//   context-routing      routing.js:72
//   event-retro          retroTrigger.js:38
// 用户裁决：先落全量 dump（后续可演进到「实际使用路径子集」，需埋点支撑）。
export const POLICY_KEYS = [
  'autonomy-conf', 'sales-thresholds', 'hindsight-deviation',
  'context-guard', 'context-routing', 'event-retro',
];
const POLICY_ID = 'sales-decision-policy';

async function loadSnapshot(tenantId = 'system') {
  const out = {};
  for (const key of POLICY_KEYS) {
    // 显式 null = 未配置（走出厂兜底），与 {} 语义区分（禁假填充）
    const row = await readConfig(key, { tenantId }).catch(() => null);
    out[key] = row ? row.value ?? null : null;
  }
  return out;
}

function versionIdOf(tenantId, snapshot) {
  const digest = createHash('sha256').update(stableStringify({ tenantId, snapshot })).digest('hex').slice(0, 12);
  return `pv-${POLICY_ID}-${digest}`;
}

// 幂等解析（I6）：内容相同 → 复用既有版本；内容变化 → 递增新版本并封旧版。
//   并发安全：同 id 并发 INSERT 由 ON CONFLICT DO NOTHING 收敛（version 仅作排序参考，允许并列）。
export async function resolvePolicyVersion({ tenantId = 'system' } = {}) {
  const snapshot = await loadSnapshot(tenantId);
  const policy_version_id = versionIdOf(tenantId, snapshot);

  const exist = (await query(`SELECT policy_version_id FROM crm.policy_version WHERE policy_version_id=$1`, [policy_version_id])).rows[0];
  if (exist) return { policy_version_id, created: false, snapshot };

  const seq = (await query(`SELECT COALESCE(MAX(version),0)+1 AS v FROM crm.policy_version WHERE policy_id=$1`, [POLICY_ID])).rows[0];
  await queryWrite(
    `INSERT INTO crm.policy_version (policy_version_id, policy_id, version, effective_from, snapshot)
     VALUES ($1,$2,$3, now(), $4::jsonb)
     ON CONFLICT (policy_version_id) DO NOTHING`,
    [policy_version_id, POLICY_ID, Number(seq?.v || 1), JSON.stringify({ tenantId, keys: snapshot })]
  );
  // 封旧版：同 policy_id 下其他未封版本置 effective_to（便于回答「某时刻生效哪一版」）
  await queryWrite(
    `UPDATE crm.policy_version SET effective_to=now()
      WHERE policy_id=$1 AND policy_version_id<>$2 AND effective_to IS NULL`,
    [POLICY_ID, policy_version_id]
  ).catch((e) => { emit('trace', 'policy-version-seal-failed', { policy_version_id, error: String(e?.message || e) }); recordFailure('policy-version-seal-failed', e); });

  return { policy_version_id, created: true, snapshot };
}
```

#### 5.2 `autonomyEngine.js` 接线

在 `requireDecision` 内、`scenario` 解析之后（约 `:131` 之后）、`recordDecisionEvent('required')` 之前插入：

```js
  // ③-C3 决策时刻冻结：解析「本次决策生效的策略版本」并随决策落库。
  //   显式注入优先（保留 e2e/特殊通道），未注入则按当前配置内容哈希解析（幂等复用）。
  //   fail-open（I1）：解析失败不阻断决策，但 effective_policy_version 落 null 会被巡检发现（不留假绿）。
  let policyVersion = opts.policy_version || null;
  if (!policyVersion) {
    policyVersion = (await resolvePolicyVersion({ tenantId: tenant })
      .then((r) => r?.policy_version_id || null)
      .catch((err) => {
        emit('trace', 'policy-version-resolve-failed', { scenario_id, tenantId: tenant, error: String(err?.message || err) });
        recordFailure('policy-version-resolve-failed', err);
        return null;
      }));
  }
```

然后把 `:274` 与 `:303` 两处：

```js
      effective_policy_version: opts.policy_version || null,
```
改为
```js
      effective_policy_version: policyVersion,
```

顶部补 `import { resolvePolicyVersion } from './policyVersion.js';`（若担心循环依赖，改用 `await import('./policyVersion.js')`，与既有 `linkDecisions`/`trackEntry` 的动态 import 风格一致）。

**验收（T5）**
1. 生产路径 `requireDecision` 后，`crm.decision.effective_policy_version` **非 null**，且 `crm.policy_version` 有对应行（此前为 0 行）。
2. 连续两次决策、配置未变 → 复用同一 `policy_version_id`（幂等）。
3. 改一次 `sales-thresholds` 后再决策 → 生成**新** id，且旧决策行的 `effective_policy_version` **保持不变**（这是本 Task 的核心价值）。

---

### T6 — C3 测试

**文件**：`test/policy-version.test.js`（新增）

| # | 用例 | 断言 |
|---|---|---|
| 1 | 首次解析 | 返回 `created:true`，`crm.policy_version` +1 行 |
| 2 | 二次解析（配置未变） | 同一 id，`created:false` |
| 3 | 改配置后再解析 | 新 id；旧版本 `effective_to` 非空（已封版） |
| 4 | `requireDecision` 端到端 | `decision.effective_policy_version` 非 null 且能在 `policy_version` 查到 |
| 5 | 快照完整性 | `snapshot.keys` 含全部 6 个 POLICY_KEYS；未配置的键为 `null`（非 `{}`） |
| 6 | 租户隔离 | `tenantId='t1'` 与 `system` 生成不同 id |

**测试隔离**：`crm.policy_version` 无 FK 被引用，可安全清理；`crm.decision` 清理沿用 `purgeScenarioDecisions()` 标准写法（`test/calibration/replayDims.test.js`）。

---

### T7 — embedding 通道升级 + 四分量评分器（C4）

**目标**：消除伪向量噪声，让先例相似度建立在**可解释的结构相似性**上。

**文件**：`src/ontology/embedding.js`、`src/decision/precedentScoring.js`（新增）

#### 7.1 `embedding.js` 追加统一入口（带 provider 元数据）

```js
// provider 元数据：先例相似度据此决定「向量分量是否计入」。
// 背景（2026-09-03 实测）：hashVector 是 SHA-256 字节映射 384 桶的哈希签名，非语义向量 —— 
//   逐字相同 cos=1.0，语义近乎同案（仅 id/金额不同）cos=0.1146，200 次微变采样过 0.6 闸仅 1 次（且与自身比）。
//   把它当语义向量用 = 向置信度注入常数噪声。故必须显式标识，供下游降级。
export const EMBED_PROVIDER = { HASH: 'hash', MODEL: 'model' };

// 统一入口：返回 { vector, provider }。首期恒走 hash（接口先就绪，真模型后续接入）。
// 接入真模型时：process.env.EMBEDDING_PROVIDER='model' + src/llm/embeddingClient.js 提供 embed(text)。
export async function embedText(text) {
  if (process.env.EMBEDDING_PROVIDER === 'model') {
    try {
      const { embed } = await import('../llm/embeddingClient.js');
      const v = await embed(text);
      if (Array.isArray(v) && v.length) return { vector: v, provider: EMBED_PROVIDER.MODEL, dim: v.length };
      throw new Error('embedding 返回空向量');
    } catch (e) {
      // 降级留痕（I1 禁静默）：明确告知本次退化为哈希签名，下游须丢弃向量分量
      const { emit } = await import('../events/bus.js');
      emit('trace', 'embedding-provider-degraded', { provider: 'model', error: String(e?.message || e) });
    }
  }
  return { vector: hashVector(text), provider: EMBED_PROVIDER.HASH, dim: DIM };
}
```

#### 7.2 新建 `src/decision/precedentScoring.js`

```js
// src/decision/precedentScoring.js — C4 先例相似度：四分量加权 + 归一强校验 + 向量降级
// 设计：docs/2026-09-03-c2c3c4-decision-integrity-implementation.md T7
// 借鉴 Semantica find_precedents_hybrid 的「多分量加权 + 权重归一强校验」，
//   但**不照抄其向量 0.7 权重** —— 我们的向量是哈希签名（噪声），结构分量必须主导。
import { readConfig } from '../config/configStore.js';
import { emit } from '../events/bus.js';
import { ctePrecedents, isAvailable } from './ageGraph.js';

export const DEFAULT_WEIGHTS = { jaccard: 0.4, category: 0.2, graphDepth: 0.2, vector: 0.2 };
export const DEFAULT_CONF = { minSimilarity: 0.45, candidatePool: 40, graphMaxDepth: 3 };
const COMPONENTS = ['jaccard', 'category', 'graphDepth', 'vector'];

function asArray(x) { return Array.isArray(x) ? x : (x ? [x] : []); }

// ① 条件集合 Jaccard：conditions_evaluated = [{cond, met, weight, required}]
//    键含 met 三态（true/false/null），使「达标/未达标/未知」成为不同元素（禁假合并）
export function jaccardConditions(a = [], b = []) {
  const key = (c) => `${c?.cond}:${c?.met === true ? 1 : c?.met === false ? 0 : 'n'}`;
  const ka = new Set(asArray(a).map(key));
  const kb = new Set(asArray(b).map(key));
  if (!ka.size && !kb.size) return 0;
  let inter = 0;
  for (const k of ka) if (kb.has(k)) inter++;
  const uni = new Set([...ka, ...kb]).size;
  return uni ? inter / uni : 0;
}

// ② 类目匹配：scenario 一致（0.5）+ business_tier 一致（0.25）+ disposition 一致（0.25）
export function categoryMatch(cur = {}, cand = {}) {
  let s = 0;
  if (cur.scenario_id && cur.scenario_id === cand.scenario_id) s += 0.5;
  if (cur.business_tier && cur.business_tier === cand.business_tier) s += 0.25;
  if (cur.disposition && cur.disposition === cand.disposition) s += 0.25;
  return s;
}

// ③ 先例引用深度（替代 Semantica 的图中心性 —— ageGraph 无 centrality 接口）
//    语义：一个先例被后续决策引用得越多，它越是被反复验证过的权威先例。
//    AGE 不可用 → 返回 null（**不是 0**），由权重重分配消化（区别于「有图但深度为 0」）
export async function graphDepthOf(decision_id, { maxDepth = 3 } = {}) {
  if (!isAvailable()) return null;
  try {
    const rows = await ctePrecedents(decision_id, { maxDepth });
    const n = Array.isArray(rows) ? rows.length : 0;
    return Math.min(n / Math.max(maxDepth, 1), 1);
  } catch (e) {
    emit('trace', 'precedent-graph-depth-failed', { decision_id, error: String(e?.message || e) });
    return null;
  }
}

// 权重归一强校验：不归一（含全 0 / 负值）→ 拒绝配置并回退出厂值 + 留痕（I1、I4）
export function normalizeWeights(w = {}, { dropVector = false } = {}) {
  const base = { ...DEFAULT_WEIGHTS, ...(w || {}) };
  if (dropVector) base.vector = 0;
  const sum = COMPONENTS.reduce((s, k) => s + Math.max(0, Number(base[k] || 0)), 0);
  if (!(sum > 0)) {
    emit('trace', 'precedent-weights-invalid', { raw: w, dropVector, reason: '权重和非正' });
    return { weights: { jaccard: 0.5, category: 0.25, graphDepth: 0.25, vector: 0 }, degraded: true };
  }
  const out = {};
  for (const k of COMPONENTS) out[k] = Math.max(0, Number(base[k] || 0)) / sum;
  return { weights: out, degraded: dropVector };
}

// 合成：跳过不可用分量（null），按**实际使用权重**再归一，避免不可用分量稀释总分
export function similarityOf(parts = {}, weights = DEFAULT_WEIGHTS) {
  let total = 0, used = 0;
  for (const k of COMPONENTS) {
    const v = parts[k];
    if (v == null) continue;
    total += Number(v) * (weights[k] || 0);
    used += weights[k] || 0;
  }
  return used > 0 ? total / used : 0;
}

export async function loadPrecedentConf({ tenantId = 'system' } = {}) {
  const v = (await readConfig('precedent-conf', { tenantId }).catch(() => null))?.value || {};
  return {
    minSimilarity: Number(v.minSimilarity ?? DEFAULT_CONF.minSimilarity),
    candidatePool: Number(v.candidatePool ?? DEFAULT_CONF.candidatePool),
    graphMaxDepth: Number(v.graphMaxDepth ?? DEFAULT_CONF.graphMaxDepth),
    weights: v.weights || DEFAULT_WEIGHTS,
  };
}
```

#### 7.3 配置项登记（同 T2.4，id 34）

```js
{ id: 34, key: 'precedent-conf', name: '先例检索', group: '治理',
  desc: '先例相似度四分量权重与阈值（向量不可用自动降级）',
  defaultValue: { minSimilarity: 0.45, candidatePool: 40, graphMaxDepth: 3,
                  weights: { jaccard: 0.4, category: 0.2, graphDepth: 0.2, vector: 0.2 } } },
```

---

### T8 — `searchPrecedents` 两段式改造 + S2 阈值配置化

**文件**：`src/decision/decisionRepo.js`、`src/context/assembleContextV2.js`

#### 8.1 `decisionRepo.js:429 searchPrecedents` 重写

```js
// 先例检索（C4 两段式）：粗召回（scenario + 已确认态，按时间取候选池）→ 精算四分量 → top-k。
//   **不再用伪向量排序**：hashVector 相似度在语义相近样本上恒≈0.11（无区分度的噪声），
//   用它做召回排序等于随机取。改为结构分量主导，向量仅在 provider='model' 时计入。
export async function searchPrecedents(scenario_id, query = {}, opts = {}) {
  const { k = 5, minSimilarity = null, tenantId = 'system' } = opts || {};
  const conf = await loadPrecedentConf({ tenantId });
  const floor = minSimilarity == null ? conf.minSimilarity : Number(minSimilarity);
  const pool = Math.max(conf.candidatePool, k * 4);

  // ① 粗召回（撤回原 embedding <=> 排序）
  const cands = (await query(
    `SELECT decision_id, scenario_id, disposition, business_tier, rationale,
            conditions_evaluated, referenced_precedents, created_at
     FROM crm.decision
     WHERE scenario_id=$1 AND state IN ('CONFIRMED','AUTONOMOUS')
     ORDER BY created_at DESC LIMIT $2`,
    [scenario_id, pool]
  )).rows;
  if (!cands.length) return [];

  // ② 向量分量：provider='hash' 时丢弃（降级），权重重分配到结构分量
  const qvec = await embedText(stableStringify({ scenario_id, ctx: query?.trigger_context || {}, cond: query?.conditions_evaluated || [] }));
  const dropVector = qvec.provider !== EMBED_PROVIDER.MODEL;
  const { weights, degraded } = normalizeWeights(conf.weights, { dropVector });
  if (degraded) emit('trace', 'precedent-vector-degraded', { scenario_id, provider: qvec.provider, weights });

  const scored = [];
  for (const c of cands) {
    const cvec = JSON.parse(c.embedding || '[]');
    const vector = (!dropVector && cvec.length === qvec.vector.length) ? cosine(qvec.vector, cvec) : null;
    const parts = {
      jaccard: jaccardConditions(query?.conditions_evaluated || [], c.conditions_evaluated || []),
      category: categoryMatch({ scenario_id, business_tier: query?.business_tier, disposition: query?.disposition },
                               { scenario_id: c.scenario_id, business_tier: c.business_tier, disposition: c.disposition }),
      graphDepth: await graphDepthOf(c.decision_id, { maxDepth: conf.graphMaxDepth }),
      vector,
    };
    const similarity = similarityOf(parts, weights);
    if (similarity >= floor) scored.push({ ...c, similarity: Number(similarity.toFixed(4)), components: parts });
  }
  return scored.sort((a, b) => b.similarity - a.similarity).slice(0, k);
}
```

需新增 `cosine` 工具（放 `precedentScoring.js` 或复用既有向量工具；`decisionRepo.js` 顶部补 `stableStringify/embedText/EMBED_PROVIDER` 与 precedentScoring 的 import）。

#### 8.2 `assembleContextV2.js:89` S2 阈值配置化

```js
// 原：const ps = await searchPrecedents(ctx.scenario_id, em, { k: 3, minSimilarity: 0.6 });
// 0.6 是「伪向量时代」的阈值，与新的结构相似度不同量纲 → 改为读配置（默认 0.45）
const conf = await loadPrecedentConf({ tenantId: ctx.tenant_id });
const ps = await searchPrecedents(ctx.scenario_id, em, { k: 3, minSimilarity: conf.minSimilarity, tenantId: ctx.tenant_id });
```

> ⚠️ 实施前**必须先读 `src/context/assembleContextV2.js:66-95`**，确认 `ctx.precedents`（引擎事前传入）的复用分支：若已传入则不再检索，此时阈值过滤逻辑也需同步改用配置值，否则两处口径不一致。

**验收（T8）**
1. 构造两个**语义相近但文本不同**的决策（仅 deal_id/金额不同）→ 相似度 **≥ 0.45 且被召回**（旧实现恒≈0.11 不召回）。
2. `EMBEDDING_PROVIDER` 未设时，`components.vector === null` 且触发 `precedent-vector-degraded` trace。
3. 权重配置 `weights:{jaccard:0,category:0,graphDepth:0,vector:0}` → 回退出厂权重并留 `precedent-weights-invalid`。

---

### T9 — C4 测试 + 全量回归

**文件**：`test/precedent-scoring.test.js`（新增）

| # | 用例 | 断言 |
|---|---|---|
| 1 | **hashVector 噪声回归锁** | `hashVector('deal.advance\|ctx={amount:120000}')` vs 金额改为 120001 → `cos < 0.3`（锁死"伪向量不得充当语义相似度"） |
| 2 | jaccard 全等 | 相同 conditions → `1.0` |
| 3 | jaccard 三态 | `met:true` vs `met:null` 视为不同元素（禁假合并） |
| 4 | 权重归一 | `{jaccard:2,category:1,graphDepth:1,vector:0}` → 合计 `1.0` |
| 5 | 权重全 0 | 回退出厂 + `degraded:true` |
| 6 | 向量降级 | `provider='hash'` → `vector===null`，jaccard 权重 ≥ 0.4 |
| 7 | 端到端召回 | 语义相近先例被召回且 `similarity ≥ 0.45` |

**全量回归**（PG 恢复后）
```bash
node scripts/seed-test-config.mjs
node node_modules/vitest/vitest.mjs run           # 目标：全绿，基线 339 文件
node scripts/e2e-agent-trail-test.mjs             # 5 任务 8/8
node scripts/e2e-decision-deep-test.mjs           # 决策深度链路
node scripts/test-isolation-audit.mjs --strict    # 基线 🔴0
```

**生产实证（L4）**
```sql
SET search_path TO crm, public;
SELECT count(*) FILTER (WHERE hash_version=2) AS v2, count(*) FILTER (WHERE hash_version=1) AS v1 FROM decision_provenance;
SELECT count(*) FROM policy_version;                                     -- 预期 >0（此前 0）
SELECT count(*) FILTER (WHERE effective_policy_version IS NOT NULL) AS frozen, count(*) AS total FROM decision;
SELECT last_status, count(*) FROM provenance_seal GROUP BY 1;            -- 预期 OK 占绝大多数
```

---

## §5 验收标准（落地假绿四层）

| 层 | 判据 | 说明 |
|---|---|---|
| L1 元数据 | 表/列/索引存在 | `information_schema` 直查**生产库** |
| L2 契约 | 单测全绿 | 含 3 个回归锁（篡改检出 / 噪声锁 / 版本冻结） |
| L3 SQL | 迁移幂等重跑 2 次无错 | `node db/migrate.js` 连跑两次 |
| L4 生产数据 | `policy_version` >0 行、`effective_policy_version` 非 null、巡检 `last_status` 有值 | **缺 L4 即未完成** |

---

## §6 风险与回滚

| 风险 | 影响 | 处置 |
|---|---|---|
| T1 算法切换后历史行校验失败 | 审计链大面积 TAMPERED | 分代设计已规避：`hash_version=1` 行走原算法。**若实测异常，回滚 = 把 `HASH_VERSION` 改回 1** |
| T3 事件入链放大写入量 | 27 处调用点多一次 INSERT | 决策路径低频；若实测有压，改配置化开关（默认开） |
| T3 影响 `auditability` Q2 判定 | 自检卡分数漂移 | T4 必须回归；必要时把分类收窄为 `NOT LIKE 'event:%'` |
| T5 每次决策读 6 个配置 | 决策链路 RT 增加 | 与既有 `loadEngineConf` 一致**不做缓存**（低频，正确性优先）；若实测成为瓶颈再按 config 变更事件失效 |
| T8 先例召回行为变化 | 置信度与升级判定漂移 | T9 全量回归；`minSimilarity` 已配置化，可热调整无需改码 |
| 并发写入导致链分叉 | `verifyChain` 返回 FORKED | 已能**检出**（旧实现会误判 TAMPERED）。根因加固预案：加 `chain_seq` 列 + `(decision_id, chain_seq)` 唯一约束，本期不实现 |

---

## §7 提交分组（AI 不代 commit，沙箱无私有库凭证）

```bash
cd D:\system\CRM-ai-native

git add db/migration-decision-integrity.sql db/migrate.js
git commit -m "feat(provenance): 哈希代次列 + 巡检封印表（C2 DDL）"

git add src/decision/provenance.js
git commit -m "feat(provenance): 哈希白名单升级(v2) + 分代校验 + 分叉/断头检出"

git add src/decision/provenance.js src/scheduler/timers.js src/portal/configCenter.js src/web/config.html test/../configCenter.test.js
git commit -m "feat(provenance): 写时自检 + 定时巡检 + provenance-patrol 配置"

git add src/decision/decisionRepo.js
git commit -m "feat(provenance): decision_event 入审计链（27 处桥接，fail-open）"

git add test/provenance-integrity.test.js
git commit -m "test(provenance): C2 回归锁（篡改检出/分代兼容/删链尾）"

git add src/decision/policyVersion.js src/decision/autonomyEngine.js
git commit -m "feat(policy): 策略版本解析 + 决策时刻冻结（C3 接线）"

git add test/policy-version.test.js
git commit -m "test(policy): C3 版本幂等/封版/端到端冻结"

git add src/ontology/embedding.js src/decision/precedentScoring.js src/portal/configCenter.js src/web/config.html
git commit -m "feat(precedent): embedding provider 元数据 + 四分量评分器（C4）"

git add src/decision/decisionRepo.js src/context/assembleContextV2.js
git commit -m "feat(precedent): searchPrecedents 两段式 + S2 阈值配置化（C4）"

git add test/precedent-scoring.test.js
git commit -m "test(precedent): C4 噪声回归锁 + 权重归一 + 向量降级"
```

> 署名追加 `Co-Authored-By: WorkBuddy <workbuddy@tencent.com>`。**禁 `git add -A`**（按功能线拆分）。

---

## §8 未纳入本期（后续 Task）

- **C1 领域事件触发层**（用户裁决留二期）：deal.stage / meeting / task 三类事件 → fire-forget 派发。
- **decision_relation 真写回**：`method-decision-execute` 描述的"决策网络挂接"目前无 action 真写权威表，需先例 `to_id` 回填通道（应单独走 brainstorming）。
- **真 embedding 接入**：`EMBEDDING_PROVIDER='model'` + `src/llm/embeddingClient.js`（SiliconFlow），接入后 C4 向量分量自动启用。
- **P1/P2**：C5 记忆分层 / C6 故事化 / C7 知识记忆分离 / C8 HITL 队列 / C9 校准复利。
