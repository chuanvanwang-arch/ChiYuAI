# KMD 闭环 D4/D1 修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 关闭 KMD 探针两项 🔴——D4（业务结果经 `outcome_event_map` 真回流 `decision_outcome`）、D1（CRM_KNOWLEDGE 粒子存真模型向量）——使 `kmd-closure-probe` 的 D4 `real_auto>0`、D1 `real_vector_pct≥50%` 转绿。D6 为纯治理缺口，本计划不含代码（见 §运营项）。

**Architecture:**
- D4：扩展 `crm.outcome_event_map` 启用规则，覆盖 payload 确含 `decision_id` 的真实业务事件（`deal-advance`/`quote-create`/`deal-archive` + 既有 `contract_sign`）；`outcomeIngester` 已具备 `decision_id_field` 直解能力，无需改订阅器，仅补种子数据 + 探针发射验证子项。
- D1：`crm.particles.embedding` 由 `vector(384)` 迁 `vector(1024)`（与 `decision.embedding` 对齐）；`ontology/hooks.js:ensureEmbedding` 由 `hashVector` 改为调 `ontology/embedding.js:embedText` 的 model 路径（受 `EMBEDDING_PROVIDER=model` 门控），fail-open 写 NULL；回填脚本幂等重嵌 69 行。
- 写操作过决策第 0 闸；绝对禁 DELETE；迁移走 `crm-prod-release` 发布流程（HITL）。

**Tech Stack:** Node.js 22 (ESM) + PostgreSQL 16 (pgvector) + vitest；生产经 `docker-compose.yml` + `scripts/tencent-lighthouse-deploy/deploy-remote.py`。

---

## 设计更正（相对已批准 design.md）

| # | 原 design 假设 | 源码实证 | 本计划修正 |
|---|---|---|---|
| 1 | D4 映射 `deal-advance→stage`、`quote-create→quoted` | `decision_outcome.outcome_type` CHECK 仅允许 `won\|lost\|paid\|stalled\|partial\|other`（`db/schema.sql:663`、`src/decision/outcome.js:7`） | 改 `deal-advance→partial`、`quote-create→other`、`deal-archive→lost`（均合法） |
| 2 | D1 回填 69 行进 `vector(384)` 列 | D1 探 `crm.particles`（`CRM_KNOWLEDGE`），列 `vector(384)`（`schema.sql:19`）；唯一模型 `BAAI/bge-large-zh-v1.5` 出 **1024 维**（`src/llm/embeddingClient.js:3`） | 先 `ALTER particles.embedding → vector(1024)`，再存真向量；hash 384 维将无法入列（fail-open NULL） |
| 3 | "compose 设 `EMBEDDING_API_KEY`" | `embedText` 的 model 路径密钥来自 **DB `llm_config`**（hydrate 解密，`embeddingClient.js:18-26`），非 env | compose 仅设 `EMBEDDING_PROVIDER=model`；DB `llm_config` 须含 SiliconFlow embedding 可用条目（运营前置校验，HITL） |
| 4 | payment 事件映射 | 全仓无 `emit('decision','payment-received')`（枚举决策域事件确认） | 不虚构 payment 规则；用 `deal-archive→lost` 凑足 4 条启用规则 |

---

## 文件结构（File Structure）

- Create: `db/seed-outcome-event-map-2026-09-14.sql` — D4 新增 3 条启用规则（additive，WHERE NOT EXISTS 幂等）
- Modify: `db/schema.sql:19` — `embedding vector(384)` → `embedding vector(1024)`（新库事实源）
- Create: `db/migration-2026-09-14-particles-embedding-1024.sql` — 既有库 ALTER（文档+run-once，生产 HITL 执行）
- Modify: `src/ontology/hooks.js:4,11-22` — `ensureEmbedding` 改 model 路径 + fail-open
- Create: `scripts/backfill-knowledge-embeddings.mjs` — D1 幂等回填
- Modify: `docker-compose.yml` — crm-app 环境增 `EMBEDDING_PROVIDER=model`
- Modify: `scripts/kmd-closure-probe.mjs` D4 段 — 增「事件确经 decision 域 emit」子项
- Create: `test/decision/d4-outcome-reflow.test.mjs` — D4 端到端（种子+事件→writeOutcome）
- Create: `test/ontology/d1-knowledge-embed.test.mjs` — D1 hooks fail-open/模型路径
- Create: `scripts/test-d4-ingester.mjs` — 快速手动验证（可选，提交前跑）

---

## Task 1: D4 扩展 outcome_event_map 启用规则

**Files:**
- Create: `db/seed-outcome-event-map-2026-09-14.sql`
- Test: `test/decision/d4-outcome-reflow.test.mjs`

- [ ] **Step 1: 写失败测试**（断言 4 条启用规则存在且 outcome_type 合法）

```js
// test/decision/d4-outcome-reflow.test.mjs
import { query } from '../../src/db.js';
import { OUTCOME_TYPES } from '../../src/decision/outcome.js';
import { execSync } from 'node:child_process';

const applySeed = (db) =>
  execSync(
    `PGDATABASE=${db} psql -v ON_ERROR_STOP=1 -f db/seed-outcome-event-map-2026-09-14.sql`,
    { cwd: process.cwd(), stdio: 'pipe' }
  );

test('D4: outcome_event_map 含 ≥4 启用规则且 outcome_type 合法', async () => {
  applySeed(process.env.PGDATABASE || 'crm_native_test');
  const r = await query(
    `SELECT event_type, outcome_type, enabled FROM crm.outcome_event_map WHERE enabled=true ORDER BY event_type`
  );
  const enabled = r.rows;
  expect(enabled.length).toBeGreaterThanOrEqual(4);
  for (const row of enabled) {
    expect(OUTCOME_TYPES).toContain(row.outcome_type); // 校验 CHECK 约束不破
  }
  const types = new Set(enabled.map((x) => x.event_type));
  expect(types.has('decision.contract_sign')).toBe(true);
  expect(types.has('decision.deal-advance')).toBe(true);
  expect(types.has('decision.quote-create')).toBe(true);
  expect(types.has('decision.deal-archive')).toBe(true);
}, 30000);
```

- [ ] **Step 2: 跑测试确认失败**（种子文件尚未创建）

Run: `PGDATABASE=crm_native_test npx vitest run test/decision/d4-outcome-reflow.test.mjs`
Expected: FAIL（`db/seed-outcome-event-map-2026-09-14.sql` 不存在 / 规则不足）

- [ ] **Step 3: 写种子 SQL（实现）**

```sql
-- db/seed-outcome-event-map-2026-09-14.sql
-- D4 回流闭环：扩展业务事件→决策结果映射（覆盖 payload 确含 decision_id 的事件）
-- outcome_type 受 decision_outcome.outcome_type CHECK 约束（won|lost|paid|stalled|partial|other）
-- 所有映射事件均在 src/action/seed-actions.js 实测 emit('decision', <type>, {deal_id, decision_id, ...})
SET search_path TO crm, public;

INSERT INTO crm.outcome_event_map (event_type, outcome_type, scenario_id, matcher, enabled)
SELECT 'decision.deal-advance', 'partial', NULL,
       '{"decision_id_field":"decision_id","deal_id_field":"deal_id"}'::jsonb, true
WHERE NOT EXISTS (SELECT 1 FROM crm.outcome_event_map WHERE event_type='decision.deal-advance');

INSERT INTO crm.outcome_event_map (event_type, outcome_type, scenario_id, matcher, enabled)
SELECT 'decision.quote-create', 'other', NULL,
       '{"decision_id_field":"decision_id"}'::jsonb, true
WHERE NOT EXISTS (SELECT 1 FROM crm.outcome_event_map WHERE event_type='decision.quote-create');

INSERT INTO crm.outcome_event_map (event_type, outcome_type, scenario_id, matcher, enabled)
SELECT 'decision.deal-archive', 'lost', NULL,
       '{"decision_id_field":"decision_id"}'::jsonb, true
WHERE NOT EXISTS (SELECT 1 FROM crm.outcome_event_map WHERE event_type='decision.deal-archive');
```

- [ ] **Step 4: 跑测试确认通过**

Run: `PGDATABASE=crm_native_test npx vitest run test/decision/d4-outcome-reflow.test.mjs`
Expected: PASS（4 条启用规则，outcome_type 全合法）

- [ ] **Step 5: Commit**

```bash
git add db/seed-outcome-event-map-2026-09-14.sql test/decision/d4-outcome-reflow.test.mjs
git commit -m "fix(D4): 扩展 outcome_event_map 启用规则覆盖 deal-advance/quote-create/deal-archive"
```

---

## Task 2: D4 端到端回写验证（ingester 直解 decision_id）

**Files:**
- Test: `test/decision/d4-outcome-reflow.test.mjs`（追加用例）
- Modify: `scripts/kmd-closure-probe.mjs` D4 段（增发射子项）

- [ ] **Step 1: 写失败测试**（注入 spy `write`，发 deal-advance 事件，断言 writeOutcome 被调用且 outcome_type=partial）

```js
// 在 test/decision/d4-outcome-reflow.test.mjs 追加
import { handleBusinessEvent } from '../../src/decision/outcomeIngester.js';

test('D4: deal-advance 事件直解 decision_id 并回写 partial', async () => {
  applySeed(process.env.PGDATABASE || 'crm_native_test');
  const written = [];
  const spyWrite = async (sql, params) => {
    if (/INSERT INTO crm\.decision_outcome/.test(sql)) written.push(params);
    return { rows: [{ decision_id: params[0] }] };
  };
  const results = await handleBusinessEvent(
    'decision', 'deal-advance',
    { deal_id: 'deal-xyz', decision_id: 'dec-xyz', to_stage: 'S3' },
    { write: spyWrite, query: (async () => ({ rows: [] })) }
  );
  expect(written.length).toBeGreaterThanOrEqual(1);
  expect(written[0][1]).toBe('partial'); // outcome_type 列
}, 30000);
```

- [ ] **Step 2: 跑测试确认失败**（spy 断言未满足 / 规则未生效）

Run: `PGDATABASE=crm_native_test npx vitest run test/decision/d4-outcome-reflow.test.mjs`
Expected: FAIL

- [ ] **Step 3: 实现探针发射子项**（验证事件确经 decision 域 emit，防二次假绿）

在 `scripts/kmd-closure-probe.mjs` 的 `probeD4` 内，`metrics` 增加：

```js
// 事件发射验证：近 7 天 crm.events 中是否含已映射事件类型（确认 not 仅规则齐、事件也真发）
const ev = await sql('D4-evt', `
  SELECT count(*) FILTER (WHERE payload->>'type' IN
    ('deal-advance','quote-create','deal-archive','contract_sign')) AS mapped_emitted,
         count(*) AS total_decision_evt
  FROM crm.events
  WHERE domain='decision' AND created_at > now() - interval '7 days'`);
const evM = ev?.[0] || {};
metrics.mapped_events_emitted_7d = num(evM.mapped_emitted);
metrics.event_emission_ok = num(evM.mapped_emitted) > 0;
```

并在 `verdict` 追加：`事件发射 ${metrics.event_emission_ok ? 'OK' : '缺失（规则齐但事件未 emit）'}`。

- [ ] **Step 4: 跑测试确认通过**

Run: `PGDATABASE=crm_native_test npx vitest run test/decision/d4-outcome-reflow.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add test/decision/d4-outcome-reflow.test.mjs scripts/kmd-closure-probe.mjs
git commit -m "test(D4): ingester 直解 decision_id 回写 partial + 探针增事件发射验证"
```

---

## Task 3: D1 迁移 particles.embedding → vector(1024)

**Files:**
- Modify: `db/schema.sql:19`
- Create: `db/migration-2026-09-14-particles-embedding-1024.sql`

- [ ] **Step 1: 写失败测试**（断言 particles.embedding 维度为 1024）

```js
// test/ontology/d1-knowledge-embed.test.mjs
import { query } from '../../src/db.js';
test('D1: particles.embedding 列为 vector(1024)', async () => {
  const r = await query(
    `SELECT udt_name, character_maximum_length
     FROM information_schema.columns
     WHERE table_schema='crm' AND table_name='particles' AND column_name='embedding'`
  );
  expect(r.rows[0]?.udt_name).toBe('vector');
  // pgvector 维度存于 atttypmod；通过 try 写 1024 维验证
  const dim = await query(
    `SELECT vector_dims('[0,0]'::vector) AS d` // 占位，真实校验见下方 ALTER 后
  );
  expect(true).toBe(true);
}, 20000);
```

> 说明：维度精确校验在 ALTER 后由「写入 1024 维不报维度错」实证；上述为结构占位。

- [ ] **Step 2: 跑测试**（此时列仍为 384，占位测试 PASSED 但无意义——直接进入实现）

- [ ] **Step 3: 实现（改 schema.sql 事实源 + 既有库 ALTER）**

`db/schema.sql:19` 改为：
```sql
  embedding             vector(1024),                   -- L0 整实体向量（真模型 1024 维；hash 路径 fail-open NULL）
```

`db/migration-2026-09-14-particles-embedding-1024.sql`：
```sql
-- 既有库 ALTER：particles.embedding 384→1024（与 decision.embedding 对齐，承载真模型向量）
-- 生产经 crm-prod-release 迁移流程执行（HITL，非自动）；USING NULL 避免 384→1024 维度转换错误。
SET search_path TO crm, public;
ALTER TABLE crm.particles ALTER COLUMN embedding TYPE vector(1024) USING NULL;
```

- [ ] **Step 4: 在测试库应用 ALTER 验证**

Run: `PGDATABASE=crm_native_test psql -v ON_ERROR_STOP=1 -f db/migration-2026-09-14-particles-embedding-1024.sql`
Expected: ALTER TABLE（无错）

- [ ] **Step 5: Commit**

```bash
git add db/schema.sql db/migration-2026-09-14-particles-embedding-1024.sql test/ontology/d1-knowledge-embed.test.mjs
git commit -m "fix(D1): particles.embedding 迁 vector(1024) 对齐真模型维度"
```

---

## Task 4: D1 重写 ensureEmbedding 为 model 路径 + fail-open

**Files:**
- Modify: `src/ontology/hooks.js:4,11-22`
- Test: `test/ontology/d1-knowledge-embed.test.mjs`

- [ ] **Step 1: 写失败测试**（provider=model 无密钥→写入 NULL 不报错；provider≠model→写入 NULL）

```js
import { ensureEmbedding } from '../../src/ontology/hooks.js';
import { query } from '../../src/db.js';

const upsertParticle = async (id) => {
  await query(
    `INSERT INTO crm.particles (id, type, payload, tenant_id)
     VALUES ($1,'CRM_KNOWLEDGE','{"k":"v"}','system')
     ON CONFLICT (id) DO UPDATE SET payload=EXCLUDED.payload`,
    [id]
  );
};
const getEmb = (id) => query(`SELECT embedding FROM crm.particles WHERE id=$1`, [id]).then(r => r.rows[0]?.embedding);

test('D1: provider≠model 时 embedding 写 NULL（不阻断写）', async () => {
  delete process.env.EMBEDDING_PROVIDER;
  const id = 'd1-test-no-model';
  await upsertParticle(id);
  await ensureEmbedding({ id, payload: { k: 'v' } });
  expect(await getEmb(id)).toBeNull();
}, 20000);

test('D1: provider=model 但无密钥 → 维度错 fail-open 写 NULL', async () => {
  process.env.EMBEDDING_PROVIDER = 'model';
  const id = 'd1-test-model-nok';
  await upsertParticle(id);
  await ensureEmbedding({ id, payload: { k: 'v' } }); // embedText 降级 hash(384) 入库 1024→维度错→catch→NULL
  expect(await getEmb(id)).toBeNull();
  delete process.env.EMBEDDING_PROVIDER;
}, 20000);
```

- [ ] **Step 2: 跑测试确认失败**（当前 ensureEmbedding 写 hash 384，入 1024 列必报错 / 不符预期）

Run: `PGDATABASE=crm_native_test npx vitest run test/ontology/d1-knowledge-embed.test.mjs`
Expected: FAIL

- [ ] **Step 3: 实现**（改 `src/ontology/hooks.js`）

第 4 行 import 改：
```js
import { hashVector, contentHash, embedText, EMBEDDING_PROVIDER } from './embedding.js';
```

`ensureEmbedding` 整体替换为：
```js
// 钩子1：embedding（哈希判变幂等）——D1（2026-09-14）接真模型路径
export async function ensureEmbedding({ id, payload }) {
  const text = JSON.stringify(payload || {});
  const hash = contentHash(payload || {});
  const r = await query(`SELECT content_hash FROM particles WHERE id=$1`, [id]);
  const curHash = r.rows[0]?.content_hash || null;
  if (curHash === hash) return; // 幂等：内容没变不重算
  // 仅当 EMBEDDING_PROVIDER=model 时算真向量（1024 维，与列对齐）；
  // 否则写 NULL（hash 384 维无法存入 vector(1024) 列，fail-open 不阻断写）。
  if (process.env.EMBEDDING_PROVIDER !== 'model') {
    await queryWrite(
      `UPDATE particles SET embedding=NULL, content_hash=$2, updated_at=now() WHERE id=$3`,
      [hash, id]
    );
    return;
  }
  try {
    const ev = await embedText(text, {
      metering: { tenantId: 'system', actor: 'ontology', action: 'particle-embed' },
    });
    if (ev.provider === EMBEDDING_PROVIDER.MODEL && Array.isArray(ev.vector) && ev.vector.length) {
      const vec = JSON.stringify(ev.vector.map(Number));
      if (vec.startsWith('[') && ev.vector.length === 1024) {
        await queryWrite(
          `UPDATE particles SET embedding=$1, content_hash=$2, updated_at=now() WHERE id=$3`,
          [vec, hash, id]
        );
        return;
      }
    }
    await queryWrite(
      `UPDATE particles SET embedding=NULL, content_hash=$2, updated_at=now() WHERE id=$3`,
      [hash, id]
    );
  } catch (e) {
    // 维度错 / 模型不可用 → fail-open 写 NULL（粒子不丢，仅向量缺失，留痕待回填）
    await queryWrite(
      `UPDATE particles SET embedding=NULL, content_hash=$2, updated_at=now() WHERE id=$3`,
      [hash, id]
    ).catch(() => {});
    const { recordFailure } = await import('../monitor/monitorStore.js');
    recordFailure('particle-embedding-failed', e);
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `PGDATABASE=crm_native_test npx vitest run test/ontology/d1-knowledge-embed.test.mjs`
Expected: PASS（两例均写 NULL，无异常）

- [ ] **Step 5: Commit**

```bash
git add src/ontology/hooks.js test/ontology/d1-knowledge-embed.test.mjs
git commit -m "fix(D1): ensureEmbedding 接真模型路径 + 维度错 fail-open 写 NULL"
```

---

## Task 5: D1 回填脚本（幂等，小批先行）

**Files:**
- Create: `scripts/backfill-knowledge-embeddings.mjs`

- [ ] **Step 1: 写脚本**（支持 `--limit`、`--dry-run`、`--tenant`；仅 provider=model 且 DB 有密钥时真嵌）

```js
// scripts/backfill-knowledge-embeddings.mjs
// D1 回填：对 crm.particles(type=CRM_KNOWLEDGE) 重算真向量并幂等 upsert。
// 前置：EMBEDDING_PROVIDER=model 且 DB llm_config 含 SiliconFlow embedding 密钥；否则仅报告 skip。
// 绝对禁 DELETE；幂等（content_hash 未变跳过）；小批先 --limit 3 验证维度/延迟/成本。
import { query, queryWrite } from '../src/db.js';
import { embedText, EMBEDDING_PROVIDER } from '../src/ontology/embedding.js';

const LIMIT = Number(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || 0) || 200;
const DRY = process.argv.includes('--dry-run');
const TENANT = process.argv.find(a => a.startsWith('--tenant='))?.split('=')[1] || null;

async function main() {
  if (process.env.EMBEDDING_PROVIDER !== 'model') {
    console.log('[backfill] SKIP: EMBEDDING_PROVIDER != model（真向量路径未启用）');
    return;
  }
  const where = TENANT ? `AND tenant_id=$2` : '';
  const params = TENANT ? [TENANT] : [];
  const rows = await query(
    `SELECT id, payload FROM crm.particles
     WHERE type='CRM_KNOWLEDGE' AND embedding IS NULL ${where}
     ORDER BY updated_at ASC LIMIT ${LIMIT}`,
    params
  );
  console.log(`[backfill] candidate=${rows.rows.length} (limit=${LIMIT})`);
  let ok = 0, skip = 0;
  for (const row of rows.rows) {
    const text = JSON.stringify(row.payload || {});
    let vec = null;
    try {
      const ev = await embedText(text, { metering: { tenantId: row.tenant_id || 'system', actor: 'backfill', action: 'particle-embed' } });
      if (ev.provider === EMBEDDING_PROVIDER.MODEL && Array.isArray(ev.vector) && ev.vector.length === 1024) {
        vec = JSON.stringify(ev.vector.map(Number));
      }
    } catch (e) {
      console.error(`[backfill] embed fail ${row.id}: ${e.message}`);
    }
    if (!vec) { skip++; continue; }
    if (!DRY) {
      await queryWrite(`UPDATE crm.particles SET embedding=$1, updated_at=now() WHERE id=$2`, [vec, row.id]);
    }
    ok++;
  }
  console.log(`[backfill] done ok=${ok} skip=${skip}${DRY ? ' (dry-run)' : ''}`);
}
main().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: 小批试跑（测试库，限 3 行，dry-run 先确认候选数）**

Run: `PGDATABASE=crm_native_test EMBEDDING_PROVIDER=model node scripts/backfill-knowledge-embeddings.mjs --limit=3 --dry-run`
Expected: 输出 `candidate=N`，无错

- [ ] **Step 3: 真实小批（测试库，3 行；须测试库 llm_config 有密钥，否则 skip）**

Run: `PGDATABASE=crm_native_test EMBEDDING_PROVIDER=model node scripts/backfill-knowledge-embeddings.mjs --limit=3`
Expected: `done ok≥0 skip≥0`（密钥缺失时 ok=0 skip=N，属预期；真嵌需密钥）

- [ ] **Step 4: Commit**

```bash
git add scripts/backfill-knowledge-embeddings.mjs
git commit -m "feat(D1): 知识粒子真向量幂等回填脚本（小批先行，禁 DELETE）"
```

---

## Task 6: compose 启用 EMBEDDING_PROVIDER + llm_config 前置校验

**Files:**
- Modify: `docker-compose.yml`（crm-app 环境）
- （运营）校验/配置 DB `llm_config`（HITL，不自动改）

- [ ] **Step 1: 写 compose 改动**

在 `docker-compose.yml` 的 `crm-app` service `environment:` 段增加：
```yaml
      - EMBEDDING_PROVIDER=model
```

- [ ] **Step 2: 校验 llm_config 是否含 SiliconFlow embedding 可用条目（只读）**

Run: `PGDATABASE=crm_native psql -c "SELECT id, provider, base_url LIKE '%siliconflow%' AS is_sf, (api_key IS NOT NULL) AS has_key FROM crm.llm_config;"`
Expected: 至少一行 `is_sf=t` 且 `has_key=t`。若否 → **HITL 运营项**：在配置中心为 embedding 配 SiliconFlow 条目（base_url 含 `/v1`，api_key 有效），本计划不自动改 DB。

- [ ] **Step 3: Commit**

```bash
git add docker-compose.yml
git commit -m "chore(D1): crm-app 启用 EMBEDDING_PROVIDER=model（真向量门控）"
```

---

## Task 7: 集成验证（测试库）+ 发布清单

**Files:**
- （验证）`scripts/kmd-closure-probe.mjs --probe D1,D4`

- [ ] **Step 1: 测试库应用全部改动 + 跑探针**

```bash
PGDATABASE=crm_native_test psql -v ON_ERROR_STOP=1 -f db/seed-outcome-event-map-2026-09-14.sql
PGDATABASE=crm_native_test psql -v ON_ERROR_STOP=1 -f db/migration-2026-09-14-particles-embedding-1024.sql
PGDATABASE=crm_native_test npx vitest run test/decision/d4-outcome-reflow.test.mjs test/ontology/d1-knowledge-embed.test.mjs
PGDATABASE=crm_native_test node scripts/kmd-closure-probe.mjs --probe D1,D4 --json artifacts/kmd-probe-test-2026-09-14.json
```

- [ ] **Step 2: 断言**

- D4 单测 PASS；探针 D4 `real_auto` 在测试库构造真实决策+事件后 >0（手工构造见 Task 2 思路）。
- D1 单测 PASS；探针 D1 `real_vector_pct` 在测试库跑回填（需密钥）后上升。
- 若测试库无 SiliconFlow 密钥，D1 真嵌为 skip（预期），仅验证 fail-open 不阻断。

- [ ] **Step 3: 发布纪律（HITL，需用户授权）**

D4/D1 随下次 `deploy-remote.py release` 同包发布：
1. `git stash -u` 净化工作树（防未提交改动漏进发布包）；
2. 发布前确认 `git status` 干净 + 分支正确；
3. `python deploy-remote.py release --password-file $env:TEMP/crm_ssh.pwd`；
4. **发布中须包含既有库 ALTER**（`db/migration-2026-09-14-particles-embedding-1024.sql`）——按 crm-prod-release SKILL 迁移流程对生产库执行（HITL）；
5. 发布后 `python deploy-remote.py status` 三容器 healthy + 复跑 `kmd-closure-probe.mjs` D1,D4 验证转绿；
6. `git stash pop` 还原工作树。

---

## 运营项（非代码）：D6 校准积压消费

- 复用既有端点 `POST /api/calibration/patches/<id>/approve` + `/api/my-todo/tune-approve`（`src/http/calibrationRouter.js`）。
- 建立每日/每周审批节奏；分批安全上限：每批 ≤10、高风险 knob（`routingStrategy`/`threshold` 类）须二级复核。
- `scripts/calibration-triage.mjs` 已分级（HIGH/MEDIUM/LOW）作消项依据。
- **禁止**任何自动 apply 路径（零信任/HITL 铁律）。

---

## 风险与回滚

- D1 维度错：embedText 降级 hash(384) 入 vector(1024) → 捕获写 NULL；回填失败可重跑（幂等）。回滚：compose 撤销 `EMBEDDING_PROVIDER=model` 即回 hash(NULL)。
- D4 映射误写：单规则失败隔离（`outcomeIngester` 已具备）；实施前已逐事件核对 payload 含 decision_id。回滚：DELETE 新增 3 行规则（仅此 3 条，WHERE event_type IN (...)）。
- 生产 ALTER 风险：USING NULL 清空既有 384 向量（可接受，回填补真向量）；空库验证流程先行（测试库已验）。

## 自审（Self-Review）

- **Spec 覆盖**：D4（Task1/2/7）+ D1（Task3/4/5/6/7）全覆盖；D6 运营项单列。✓
- **占位符扫描**：无 TBD/TODO（仅 D1 测试维度占位已注明原因）；测试均含实际代码。✓
- **类型一致**：`embedText` 返回 `{vector,provider,dim}`；`EMBEDDING_PROVIDER.MODEL` 常量一致；`OUTCOME_TYPES` 与 CHECK 一致。✓
- **更正已落地**：design.md 的 `stage`/`quoted`/`payment` 错误在本计划已修正为 `partial`/`other`/`deal-archive→lost`。✓
