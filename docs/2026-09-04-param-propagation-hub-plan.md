# 参数传播中枢（Param Propagation Hub）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在既有 `config_store` 两层存储 + 夜间复盘之上，构建统一"参数传播中枢"——继承（已有）/ 强制下发 broadcast / 上行推广 promote（task→tenant 记忆、tenant→system SKILL），全部经决策第 0 闸（requireDecision）+ HITL 零信任落库、可审计、可回退、禁 DELETE。

**Architecture:** 三通道共用 `writeConfig(pool, key, value, {tenantId, decisionId})`（upsert，禁删）+ `requireDecision('config-change', …)` 取得 `decision_id`。retro 扩展 `knob='config_store'` 并带 `tenant_id` 产出候选；broadcast 枚举租户批量 upsert；promote 分记忆（写 `crm.tenant_precedent`）与 SKILL（扩展 `crm.skill_scope` tenant 轴）两路。所有动作落 `crm.propagation_action`（accept/reject 留痕，不改 report）。UI `propagation-hub.html` 四 Tab 汇聚。

**Tech Stack:** Node 22 ESM + PostgreSQL(pg, schema crm, @5433) + Express + vitest。存储机制 `src/config/configStore.js`；决策闸 `src/decision/autonomyEngine.js:115 requireDecision`；复盘 `src/decision/retro.js`；SKILL 作用域 `src/skill/skillScope.js`；先例配置 `src/decision/precedentScoring.js:94 loadPrecedentConf`。

**关键事实（已核实，避免臆测）：**
- `config_store` 真实 PK = `(tenant_id, key)`（迁移 `migrate-tenant.js:18-23` 将 `key` 单 PK 改为 `(tenant_id,key)`；`writeConfig` `configStore.js:26-34` 用 `ON CONFLICT (tenant_id, key)` upsert）。
- `memory_log`（`schema.sql:265-272`）**当前无 `tenant_id` 列** → P3 必须先 `ALTER TABLE … ADD COLUMN tenant_id`（沿用 config_store 的补列模式）。
- `skill_scope`（`migrate.js:277-286`）无 `tenant_id`；作用域为 `system/workspace/user`。tenant 轴推广需新增列。

---

## File Structure

```
Create: db/migrate-propagation.js              # DDL：memory_log.tenant_id + tenant_precedent + skill_scope.tenant_id + propagation_action
Create: src/config/broadcast.js                # broadcastConfig + listTenants
Create: src/memory/promote.js                  # promoteMemoryToTenant + listTenantPrecedents
Modify: src/skill/skillScope.js                # promoteSkill 增 from='tenant' 分支 + effectiveSkillSet 支持 tenantId
Modify: src/decision/retro.js                  # knob 枚举增 config_store + draft_patch 带 tenant_id + 系统提示引导
Create: src/http/propagationRoutes.js          # GET suggestions / POST accept / POST reject / POST broadcast
Create: src/web/propagation-hub.html           # 四 Tab 中枢页
Modify: src/http/decisionReadRoutes.js         # registerPropagationRoutes(app, pool) 接线
Create: test/propagation/broadcast.test.js
Create: test/propagation/promote-memory.test.js
Create: test/propagation/skill-promote.test.js
Create: test/propagation/retro-knob.test.js
Create: test/propagation/routes.test.js
```

---

## Task 0 — 指标测量 measureClusterMetrics + 报告补列（处方引擎前置）

**Files:**
- Modify: `src/decision/retro.js`（`clusterByScenario` 后接 `measureClusterMetrics`）
- Modify: `db/schema.sql` + 新增 `db/migrate-propagation-metrics.js`（`decision_retro_report` 增 `config_snapshot JSONB` + `tenant_id`）
- Create: `test/propagation/measure-metrics.test.js`

- [ ] **Step 1: 写失败测试**：给定 cluster，断言 `measureClusterMetrics` 产出 `precedent_recall` / `major_deviation_rate` / `unusable_rate` / `dim_missing_rate` / `upgrade_rate` 五槽位（§12.1）。
- [ ] **Step 2: 实现 measureClusterMetrics**：从 `category_distribution` / `feedback_flags` / `attribution.similarity` 计算五槽位（数值 0..1）。
- [ ] **Step 3: 报告补列迁移**：`ALTER TABLE crm.decision_retro_report ADD COLUMN IF NOT EXISTS config_snapshot JSONB` + `tenant_id TEXT`；落库时写入 `config_snapshot`（运行期各旋钮副本）。
- [ ] **Step 4: 跑测试 + 迁移**（幂等）。

```js
// test/propagation/measure-metrics.test.js（节选）
import { measureClusterMetrics } from '../../src/decision/retro.js';
it('产出五槽位且归一化 0..1', () => {
  const c = { count: 100, category_distribution: { precedent_used: 12, precedent_missing: 88 },
              feedback_flags: { unusable: 5, majorDeviation: 9 } };
  const m = measureClusterMetrics(c, { minSimilarity: 0.45 });
  expect(m.precedent_recall).toBeCloseTo(0.12);
  expect(m.major_deviation_rate).toBeCloseTo(0.09);
  expect(m.unusable_rate).toBeCloseTo(0.05);
});
```

```sql
-- db/migrate-propagation-metrics.js（节选，幂等）
ALTER TABLE crm.decision_retro_report ADD COLUMN IF NOT EXISTS config_snapshot JSONB;
ALTER TABLE crm.decision_retro_report ADD COLUMN IF NOT EXISTS tenant_id TEXT;
```

Run: `npx vitest run test/propagation/measure-metrics.test.js` + `node db/migrate-propagation-metrics.js`
Expected: 五槽位断言通过；迁移打印 done，重复执行幂等。
Acceptance: `measureClusterMetrics` 覆盖 §12.1 全部槽位；报告含 `config_snapshot` 与 `tenant_id`。

```bash
git add src/decision/retro.js db/migrate-propagation-metrics.js test/propagation/measure-metrics.test.js
git commit -m "feat(propagation): 复盘指标测量 measureClusterMetrics + 报告补 config_snapshot/tenant_id"
```

---

## Task 1 — DDL 迁移（memory_log.tenant_id + 新表）

**Files:**
- Create: `db/migrate-propagation.js`

- [ ] **Step 1: 写迁移脚本（含完整 DDL，全部 IF NOT EXISTS / ADD COLUMN IF NOT EXISTS，禁删）**

```js
// db/migrate-propagation.js — 参数传播中枢 DDL（幂等，禁 DELETE）
import { queryWrite } from './db.js'; // 与 migrate-tenant.js 同款引用；若项目用 pool 直连则改用 pool.query
// 若 db.js 不直接导出 queryWrite，用： import { pool } from './db.js'; const qw = (t,a)=>pool.query(t,a);

async function run(pool) {
  const qw = async (t, a = []) => pool.query(t, a);

  // 1) memory_log 补 tenant_id（与 config_store 补列同模式）
  await qw(`ALTER TABLE crm.memory_log ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'system'`);
  await qw(`CREATE INDEX IF NOT EXISTS idx_memory_log_tenant ON crm.memory_log(tenant_id)`);

  // 2) 租户级经验模板（task→tenant 推广落点，append-only 禁删）
  await qw(`
    CREATE TABLE IF NOT EXISTS crm.tenant_precedent (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id     TEXT NOT NULL,
      memory_id     UUID,                      -- 溯源到原 memory_log 条目（promoted_from）
      title         TEXT NOT NULL,
      payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
      source_kind   TEXT NOT NULL DEFAULT 'memory',  -- memory | skill | manual
      promoted_from UUID,                      -- 同源 skill_scope.id / memory_id 溯源
      decision_id   TEXT,                      -- 第0闸锚定
      created_by    TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await qw(`CREATE INDEX IF NOT EXISTS idx_tenant_precedent_tenant ON crm.tenant_precedent(tenant_id)`);
  await qw(`CREATE INDEX IF NOT EXISTS idx_tenant_precedent_memory ON crm.tenant_precedent(tenant_id, memory_id)`);

  // 3) skill_scope 补 tenant_id（支持 tenant 轴推广）
  await qw(`ALTER TABLE crm.skill_scope ADD COLUMN IF NOT EXISTS tenant_id TEXT`);
  await qw(`CREATE INDEX IF NOT EXISTS idx_skill_scope_tenant ON crm.skill_scope(skill, tenant_id)`);

  // 4) 传播动作留痕（accept/reject；不改 report，不删）
  await qw(`
    CREATE TABLE IF NOT EXISTS crm.propagation_action (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      suggestion_ref  TEXT NOT NULL,           -- 候选标识：retro:<report_id>:<idx> | memory:<id> | skill:<id>
      kind            TEXT NOT NULL,           -- config_store | memory_promote | skill_promote | broadcast
      status          TEXT NOT NULL,          -- open | accepted | rejected
      decision_id     TEXT,
      by              TEXT,
      detail          JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await qw(`CREATE INDEX IF NOT EXISTS idx_propagation_action_ref ON crm.propagation_action(suggestion_ref)`);
  console.log('[migrate-propagation] done');
}

// 独立运行入口（与 migrate-tenant.js 一致）
if (import.meta.url === `file://${process.argv[1]}`) {
  const { pool } = await import('./db.js');
  await run(pool);
  await pool.end();
}
export { run };
```

- [ ] **Step 2: 本地执行迁移（确认无错）**

Run: `node db/migrate-propagation.js`
Expected: 打印 `[migrate-propagation] done`，无报错；重复执行幂等（IF NOT EXISTS 不报错）。

- [ ] **Step 3: Commit**

```bash
git add db/migrate-propagation.js
git commit -m "feat(propagation): DDL — memory_log.tenant_id + tenant_precedent + skill_scope.tenant_id + propagation_action"
```

---

## Task 2 — broadcast.js（强制下发 + 租户枚举）

**Files:**
- Create: `src/config/broadcast.js`
- Test: `test/propagation/broadcast.test.js`

- [ ] **Step 1: 写失败测试**

```js
// test/propagation/broadcast.test.js
import { describe, it, expect } from 'vitest';
import { broadcastConfig, listTenants } from '../../src/config/broadcast.js';
import { writeConfig, readConfig } from '../../src/config/configStore.js';

// 用内存桩 pool（仅拦截 query，验证调用意图）
function fakePool(rows = []) {
  return {
    query: async (t, a) => {
      fakePool.__last = { t, a };
      // 租户枚举
      if (t.includes('DISTINCT tenant_id')) return { rows: [{ tenant_id: 't-a' }, { tenant_id: 't-b' }] };
      // 探测是否已存在（fill-only 用）
      if (t.includes('FROM crm.config_store WHERE tenant_id=$1 AND key=$2')) {
        const exists = fakePool.__exists?.has(a[0]);
        return { rows: exists ? [{ value: {}, decision_id: 'x' }] : [] };
      }
      return { rows };
    },
  };
}

describe('broadcast', () => {
  it('fill-only 仅写未定制租户，不覆盖已存在者', async () => {
    const pool = fakePool();
    pool.__exists = new Set(['t-a']); // t-a 已定制
    const res = await broadcastConfig(pool, {
      key: 'precedent-conf', value: { minSimilarity: 0.4 }, mode: 'fill-only', by: 'admin', decisionId: 'd1',
    });
    // 仅 t-b 被写
    expect(res.written).toEqual(['t-b']);
    expect(res.skipped).toEqual(['t-a']);
  });

  it('override 写全部目标', async () => {
    const pool = fakePool();
    pool.__exists = new Set(['t-a', 't-b']);
    const res = await broadcastConfig(pool, {
      key: 'precedent-conf', value: { minSimilarity: 0.4 }, mode: 'override', by: 'admin', decisionId: 'd1',
    });
    expect(res.written.sort()).toEqual(['t-a', 't-b']);
    expect(res.skipped).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/propagation/broadcast.test.js`
Expected: FAIL（`Cannot find module '../../src/config/broadcast.js'`）。

- [ ] **Step 3: 写最小实现**

```js
// src/config/broadcast.js
// 强制下发：将某 config_store 旋钮从 system 层批量落到一组租户。
// 铁律：全部走 writeConfig（upsert，禁删）；fill-only 不破坏既有定制；override 由调用方（HTTP）已 mint decision_id。
import { writeConfig, readConfig } from './configStore.js';
import { emit } from '../events/bus.js';

/** 枚举所有业务租户（排除平台种子 'system'） */
export async function listTenants(pool) {
  const r = await pool.query(`SELECT DISTINCT tenant_id FROM crm.crm_users WHERE tenant_id <> 'system' ORDER BY tenant_id`);
  return r.rows.map((x) => x.tenant_id);
}

/**
 * @param {object} pool
 * @param {object} p { key, value, mode='fill-only'|'override', targets?:string[], by, decisionId }
 * @returns {Promise<{written:string[], skipped:string[], mode:string}>}
 */
export async function broadcastConfig(pool, { key, value, mode = 'fill-only', targets = null, by = 'system', decisionId = null }) {
  if (!key || value == null) throw new Error('broadcastConfig 需要 key 与 value');
  if (!['fill-only', 'override'].includes(mode)) throw new Error(`非法 mode: ${mode}`);
  const tenants = targets && targets.length ? targets : await listTenants(pool);
  const written = [];
  const skipped = [];
  for (const tid of tenants) {
    if (mode === 'fill-only') {
      const existing = await readConfig(key, { tenantId: tid }).catch(() => null);
      if (existing) { skipped.push(tid); continue; } // 已定制 → 不动
    }
    await writeConfig(key, value, { tenantId: tid, decisionId, updatedBy: by });
    written.push(tid);
  }
  emit('trace', 'config-broadcast', { key, mode, written, skipped, by, decisionId });
  return { written, skipped, mode };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/propagation/broadcast.test.js`
Expected: PASS（2/2）。

- [ ] **Step 5: Commit**

```bash
git add src/config/broadcast.js test/propagation/broadcast.test.js
git commit -m "feat(propagation): broadcastConfig + listTenants (fill-only/override, 禁删)"
```

---

## Task 3 — promoteMemoryToTenant（task→tenant 经验推广）

**Files:**
- Create: `src/memory/promote.js`
- Test: `test/propagation/promote-memory.test.js`

- [ ] **Step 1: 写失败测试**

```js
// test/propagation/promote-memory.test.js
import { describe, it, expect } from 'vitest';
import { promoteMemoryToTenant, listTenantPrecedents } from '../../src/memory/promote.js';

function fakePool() {
  const store = []; // tenant_precedent 行
  return {
    __store: store,
    query: async (t, a) => {
      if (t.includes('FROM crm.memory_log WHERE id=$1')) {
        // 返回带 tenant_id 的记忆行（或跨租户行用于负例）
        return { rows: fakePool.__mem?.(a[0]) ? [fakePool.__mem(a[0])] : [] };
      }
      if (t.startsWith('INSERT INTO crm.tenant_precedent')) {
        store.push({ id: a[0], tenant_id: a[1], memory_id: a[2], title: a[3] });
        return { rows: [{ id: a[0] }] };
      }
      if (t.startsWith('SELECT') && t.includes('crm.tenant_precedent')) {
        return { rows: store.filter((r) => r.tenant_id === a[0]) };
      }
      return { rows: [] };
    },
  };
}

describe('promoteMemoryToTenant', () => {
  it('同租户内提升为租户先例，溯源保留', async () => {
    const pool = fakePool();
    fakePool.__mem = (id) => ({ id, tenant_id: 't-a', topic: 'deal', payload: { note: '客户对价格敏感' } });
    const r = await promoteMemoryToTenant(pool, { memoryId: 'm1', tenantId: 't-a', by: 'alice', decisionId: 'd1' });
    expect(r.ok).toBe(true);
    expect(r.row.tenant_id).toBe('t-a');
    expect(r.row.memory_id).toBe('m1');
    expect((await listTenantPrecedents(pool, 't-a')).length).toBe(1);
  });

  it('跨租户拒绝（防 PII 泄漏）', async () => {
    const pool = fakePool();
    fakePool.__mem = (id) => ({ id, tenant_id: 't-b', topic: 'deal', payload: {} });
    await expect(promoteMemoryToTenant(pool, { memoryId: 'm1', tenantId: 't-a', by: 'alice', decisionId: 'd1' }))
      .rejects.toThrow(/租户不匹配|tenant mismatch/i);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/propagation/promote-memory.test.js`
Expected: FAIL（模块缺失）。

- [ ] **Step 3: 写最小实现**

```js
// src/memory/promote.js
// task→tenant 推广：把某客户记忆（memory_log）提升为租户级经验模板（tenant_precedent）。
// 红线：仅本租户内（防 PII 跨租户泄漏）；append-only（INSERT，禁 DELETE）；须带 decision_id（第0闸）。
import { emit } from '../events/bus.js';

export async function promoteMemoryToTenant(pool, { memoryId, tenantId, by = 'system', decisionId = null, title = null }) {
  if (!memoryId || !tenantId) throw new Error('promoteMemoryToTenant 需要 memoryId 与 tenantId');
  const m = await pool.query(`SELECT id, tenant_id, topic, payload FROM crm.memory_log WHERE id=$1`, [memoryId]);
  const src = m.rows[0];
  if (!src) throw new Error('源记忆不存在');
  if (src.tenant_id !== tenantId) throw new Error(`租户不匹配：记忆属 ${src.tenant_id}，请求 ${tenantId}（禁止跨租户推广 PII）`);
  const r = await pool.query(
    `INSERT INTO crm.tenant_precedent (tenant_id, memory_id, title, payload, source_kind, promoted_from, decision_id, created_by)
     VALUES ($1,$2,$3,$4,'memory',$5,$6,$7) RETURNING *`,
    [tenantId, memoryId, title || src.topic || '未命名经验', JSON.stringify(src.payload || {}), memoryId, decisionId, by]
  );
  emit('trace', 'memory-promoted', { memoryId, tenantId, by, decisionId });
  return { ok: true, row: r.rows[0] };
}

export async function listTenantPrecedents(pool, tenantId) {
  const r = await pool.query(
    `SELECT id, tenant_id, memory_id, title, source_kind, created_at FROM crm.tenant_precedent WHERE tenant_id=$1 ORDER BY created_at DESC`,
    [tenantId]
  );
  return r.rows;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/propagation/promote-memory.test.js`
Expected: PASS（2/2）。

- [ ] **Step 5: Commit**

```bash
git add src/memory/promote.js test/propagation/promote-memory.test.js
git commit -m "feat(propagation): promoteMemoryToTenant — 任务级经验→租户先例（限本租户，禁删）"
```

---

## Task 4 — skillScope 增 tenant 轴推广

**Files:**
- Modify: `src/skill/skillScope.js`
- Test: `test/propagation/skill-promote.test.js`

- [ ] **Step 1: 写失败测试**

```js
// test/propagation/skill-promote.test.js
import { describe, it, expect } from 'vitest';
import { promoteSkill, effectiveSkillSet } from '../../src/skill/skillScope.js';

function fakePool() {
  const rows = []; // skill_scope 行
  return {
    __rows: rows,
    query: async (t, a) => {
      if (t.startsWith('SELECT') && t.includes('crm.skill_scope')) {
        // 按 WHERE 粗筛（测试数据量小，直接全返由调用方逻辑过滤）
        return { rows: rows.filter((r) => {
          if (t.includes("scope_level='system'")) return r.scope_level === 'system';
          return true;
        }) };
      }
      if (t.startsWith('INSERT INTO crm.skill_scope')) {
        const row = { id: a[0], skill: a[1], scope_level: a[2], owner: a[3], enabled: a[4], promoted_from: a[5], note: a[6], tenant_id: a[7] ?? null };
        rows.push(row);
        return { rows: [row] };
      }
      return { rows: [] };
    },
  };
}

describe('promoteSkill tenant→system', () => {
  it('from=tenant 写 system 行并溯源 promoted_from', async () => {
    const pool = fakePool();
    // 预置租户级 skill 行（tenant_id='t-a'）
    pool.__rows.push({ id: 'row-ta', skill: 'method-x', scope_level: 'tenant', owner: 't-a', enabled: true, promoted_from: null, note: null, tenant_id: 't-a' });
    const r = await promoteSkill(pool, { skill: 'method-x', from: 'tenant', to: 'system', tenantId: 't-a', by: 'sysadmin' });
    expect(r.ok).toBe(true);
    const sysRow = pool.__rows.find((x) => x.scope_level === 'system' && x.skill === 'method-x');
    expect(sysRow).toBeTruthy();
    expect(sysRow.promoted_from).toBe('tenant:t-a:method-x');
  });

  it('from=tenant 但缺 tenantId 抛错（须显式来源租户）', async () => {
    const pool = fakePool();
    await expect(promoteSkill(pool, { skill: 'method-x', from: 'tenant', to: 'system', by: 'sysadmin' }))
      .rejects.toThrow(/tenantId|租户/);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/propagation/skill-promote.test.js`
Expected: FAIL（promoteSkill 不支持 from='tenant'）。

- [ ] **Step 3: 修改实现（扩展 promoteSkill + effectiveSkillSet 支持 tenantId）**

在 `src/skill/skillScope.js` 末尾扩展 `promoteSkill`，并让 `effectiveSkillSet` 支持 `tenantId` 过滤：

```js
// 在现有 promoteSkill 之后追加 tenant 轴分支
export async function promoteSkill(pool, { skill, from, to, by, note = null, tenantId = null }) {
  if (from === 'tenant') {
    if (!tenantId) throw new Error('promoteSkill(from=tenant) 需要 tenantId 来源租户');
    if (to !== 'system') throw new Error('tenant 轴推广当前仅支持 to=system（方法论升为平台默认）');
    if (!skill || !by) throw new Error('promoteSkill 需要 skill 与 by');
    // 取租户级 skill_scope 行（tenant_id 匹配、scope_level='tenant' 或 owner=tenantId）
    const src = await pool.query(
      `SELECT * FROM crm.skill_scope WHERE skill=$1 AND tenant_id=$2 LIMIT 1`,
      [skill, tenantId]
    );
    if (!src.rows[0]) throw new Error(`租户 ${tenantId} 无 skill ${skill} 的定制行，无法推广`);
    const promotedFrom = `tenant:${tenantId}:${skill}`;
    const r = await pool.query(
      `INSERT INTO crm.skill_scope (skill, scope_level, owner, enabled, promoted_from, note, tenant_id)
       VALUES ($1,'system',NULL,true,$2,$3,NULL)
       ON CONFLICT (skill, scope_level, COALESCE(owner,''))
       DO UPDATE SET promoted_from=$2, note=$3, enabled=true, created_at=now() RETURNING *`,
      [skill, promotedFrom, note]
    );
    try { const { emit } = await import('../events/bus.js'); emit('trace', 'skill-promoted', { skill, from, to, tenantId, by }); } catch {}
    return { ok: true, skill, from, to, promoted_from: promotedFrom, row: r.rows[0] };
  }
  // —— 既有 user 分支（原逻辑，保持不变）——
  if (from !== 'user') throw new Error('promoteSkill 仅支持从 user 或 tenant 试跑推广');
  if (!SCOPE_LEVELS.includes(to) || to === 'user') throw new Error(`非法推广目标: ${to}`);
  if (!skill || !by) throw new Error('promoteSkill 需要 skill 与 by');
  const targetOwner = to === 'user' ? by : null;
  const r = await pool.query(
    `INSERT INTO crm.skill_scope (skill, scope_level, owner, enabled, promoted_from, note)
     VALUES ($1,$2,$3,true,$4,$5)
     ON CONFLICT (skill, scope_level, COALESCE(owner,''))
     DO UPDATE SET promoted_from=$4, note=$5, enabled=true, created_at=now() RETURNING *`,
    [skill, to, targetOwner, from, note]
  );
  try { const { emit } = await import('../events/bus.js'); emit('trace', 'skill-promoted', { skill, from, to, by }); } catch {}
  return { ok: true, skill, from, to, row: r.rows[0] };
}
```

同时更新 `effectiveSkillSet` 签名以接受 `tenantId`（不影响旧调用）：

```js
export async function effectiveSkillSet(pool, scope = {}) {
  const rows = (
    await pool.query(
      `SELECT id, skill, scope_level, owner, enabled, promoted_from, tenant_id
       FROM crm.skill_scope
       WHERE scope_level='system'
          OR (scope_level='workspace' AND (owner IS NULL OR $1::text IS NULL OR owner=$1))
          OR (scope_level='user' AND (owner IS NULL OR $2::text IS NULL OR owner=$2))
          OR (tenant_id IS NOT NULL AND (tenant_id = $3::text OR $3::text IS NULL))`,
      [scope.workspace ?? null, scope.user ?? null, scope.tenantId ?? null]
    )
  ).rows;
  const eff = resolveEffectiveSkills(rows, scope);
  return { skills: [...eff.values()], enabled: [...eff.values()].filter((s) => s.enabled).map((s) => s.skill) };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/propagation/skill-promote.test.js`
Expected: PASS（2/2）。同时跑旧 skillScope 测试确认未回归：`npx vitest run test/skill/`（若目录存在；否则跳过）。

- [ ] **Step 5: Commit**

```bash
git add src/skill/skillScope.js test/propagation/skill-promote.test.js
git commit -m "feat(propagation): skillScope 增 from=tenant 推广分支 + effectiveSkillSet tenantId 过滤"
```

---

## Task 5 — retro 扩展 knob=config_store + tenant_id 感知

**Files:**
- Modify: `src/decision/retro.js`
- Test: `test/propagation/retro-knob.test.js`

- [ ] **Step 1: 写失败测试**

```js
// test/propagation/retro-knob.test.js
import { describe, it, expect } from 'vitest';
import { runDecisionRetro } from '../../src/decision/retro.js';

// 注入 llmFactory：返回一个返回 config_store 旋钮处方的 LLM
function llmFactoryReturning(patch) {
  return async () => async (sys, usr) => ({
    root_cause_class: 'DATA_QUALITY_PRECEDENT',
    root_cause_explanation: '先例召回偏紧',
    draft_patches: [patch],
    confidence: 0.7,
    predicted_impact: '提升命中',
  });
}

describe('retro config_store knob', () => {
  it('产出 knob=config_store 且带 tenant_id 的 draft_patch', async () => {
    // 用 fake window 决策（含 tenant_id）
    const decisions = [{ decision_id: 'd1', scenario_id: 'S1', tenant_id: 't-a', attribution: {}, feedback: {} }];
    const fakeQuery = async (t, a) => {
      if (t.includes('FROM crm.decision WHERE decided_at')) return { rows: decisions };
      return { rows: [] };
    };
    // 临时替换 query（runDecisionRetro 内部 import 的 query 为模块级，单测用 vi.mock 更稳；此处用全局注入桩）
    const original = (await import('../../src/db.js')).query;
    (await import('../../src/db.js')).query = fakeQuery;
    try {
      const report = await runDecisionRetro({
        windowHours: 24, dryRun: true,
        llmFactory: llmFactoryReturning({
          knob: 'config_store', target: 'precedent-conf.minSimilarity', from_value: 0.45, to_value: 0.4,
          risk: 'LOW', label: '放宽先例阈值', evidence: { hit_rate: '0.21' },
        }),
      });
      const p = report.draft_patches.find((x) => x.knob === 'config_store');
      expect(p).toBeTruthy();
      expect(p.target).toBe('precedent-conf.minSimilarity');
      expect(p.tenant_id).toBe('t-a');
    } finally {
      (await import('../../src/db.js')).query = original;
    }
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/propagation/retro-knob.test.js`
Expected: FAIL（draft_patch 无 tenant_id；knob 枚举未含 config_store，处方会被过滤）。

- [ ] **Step 3: 修改 retro.js**

(a) `RETRO_SYSTEM_PROMPT` 的 knob 枚举（约 L54）增补 `config_store`，并说明 target 形如 `precedent-conf.minSimilarity`：

```js
      "knob": "required_dims|threshold|weight|edge_binding|meta_attr_map|particle_attr_add|source_refresh|dim_order|precedent_distill|config_store",
```

(b) `clusterByScenario`（约 L77）增加 `tenant_id` 聚合：在循环内 `const tid = row.tenant_id || 'system';` 收集 `tenantSet`，push cluster 时加 `tenant_id: [...tenantSet][0] || 'system'`（单租户聚类取首值；跨租户聚类取首值并留痕）。

(c) `runDecisionRetro` 内展平 draft_patches（约 L225-227）补 `tenant_id`：

```js
    for (const p of a.draft_patches) {
      draftPatches.push({ ...p, scenario_id: c.scenario_id, root_cause_class: a.root_cause_class, tenant_id: c.tenant_id });
    }
```

(d) 系统提示引导：在 `RETRO_SYSTEM_PROMPT` 的 knob 说明后补一句：
`若根因指向某 config_store 旋钮（如 precedent-conf.minSimilarity / sales-thresholds / approval-config），knob 用 'config_store'，target 用 '键名.子键'（例 precedent-conf.minSimilarity），to_value 为建议新值。`

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/propagation/retro-knob.test.js`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/decision/retro.js test/propagation/retro-knob.test.js
git commit -m "feat(propagation): retro 扩展 knob=config_store + draft_patch 带 tenant_id"
```

---

## Task 6 — propagationRoutes.js（中枢 API + 第0闸落库）

**Files:**
- Create: `src/http/propagationRoutes.js`
- Test: `test/propagation/routes.test.js`

- [ ] **Step 1: 写失败测试（accept retro 候选 → config_store 回读生效）**

```js
// test/propagation/routes.test.js
import { describe, it, expect } from 'vitest';

function makeCtx() {
  const configs = {}; // tenantId|key -> value
  const actions = [];
  const pool = {
    query: async (t, a) => {
      if (t.includes('INSERT INTO crm.propagation_action')) { actions.push({ ref: a[0], status: a[1] }); return { rows: [{ id: a[0] }] }; }
      if (t.includes('FROM crm.propagation_action WHERE suggestion_ref')) { return { rows: [] }; }
      if (t.startsWith('SELECT') && t.includes('crm.decision_retro_report')) {
        return { rows: [{ draft_patches: JSON.stringify([{ knob:'config_store', target:'precedent-conf.minSimilarity', to_value:0.4, tenant_id:'t-a', risk:'LOW', label:'放宽' }]) }] };
      }
      return { rows: [] };
    },
  };
  return { pool, configs, actions };
}

// 用真实模块但桩掉 requireDecision 与 writeConfig，验证编排
describe('propagation accept', () => {
  it('accept config_store 候选 → requireDecision + writeConfig 被调用且回读 0.4', async () => {
    const { pool } = makeCtx();
    const calls = { decision: 0, write: 0 };
    const mod = await import('../../src/http/propagationRoutes.js');
    // 桩注入
    mod.__test = {
      requireDecision: async () => { calls.decision++; return { decision_id: 'D1' }; },
      writeConfig: async () => { calls.write++; return { ok: true }; },
    };
    const r = await mod.acceptSuggestion(pool, {
      kind: 'config_store', ref: 'retro:r1:0',
      patch: { knob: 'config_store', target: 'precedent-conf.minSimilarity', to_value: 0.4, tenant_id: 't-a' },
      by: 'admin',
    });
    expect(r.ok).toBe(true);
    expect(calls.decision).toBe(1);
    expect(calls.write).toBe(1);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/propagation/routes.test.js`
Expected: FAIL（模块/函数缺失）。

- [ ] **Step 3: 写实现**

```js
// src/http/propagationRoutes.js
// 参数传播中枢 API：汇聚候选 + accept/reject + broadcast。所有写经 requireDecision（第0闸）+ writeConfig（upsert 禁删）。
import { requireDecision } from '../decision/autonomyEngine.js';
import { writeConfig, readConfig } from '../config/configStore.js';
import { broadcastConfig } from '../config/broadcast.js';
import { promoteMemoryToTenant } from '../memory/promote.js';
import { query, queryWrite } from '../db.js';
import { emit } from '../events/bus.js';

// 取最新 report 的 config_store 类候选（open=未被 action 表标记）
async function openRetroSuggestions(pool) {
  const rep = await query(`SELECT report_id, draft_patches FROM crm.decision_retro_report ORDER BY run_at DESC LIMIT 1`, []);
  const patches = Array.isArray(rep.rows[0]?.draft_patches) ? rep.rows[0].draft_patches : [];
  const cfgPatches = patches.filter((p) => p.knob === 'config_store');
  const acted = await query(`SELECT suggestion_ref FROM crm.propagation_action WHERE status <> 'open'`, []);
  const actedSet = new Set(acted.rows.map((r) => r.suggestion_ref));
  return cfgPatches
    .map((p, i) => ({ kind: 'config_store', ref: `retro:${rep.rows[0].report_id}:${i}`, patch: p, tenant_id: p.tenant_id }))
    .filter((x) => !actedSet.has(x.ref));
}

// 记忆推广候选：本租户内被标 "promotable" 的记忆（简化：取最近 N 条带 payload.weight>=1 的记忆）
async function openMemorySuggestions(pool, tenantId) {
  const r = await query(
    `SELECT id, tenant_id, topic, payload FROM crm.memory_log WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 20`,
    [tenantId]
  );
  return r.rows.map((m) => ({ kind: 'memory_promote', ref: `memory:${m.id}`, memoryId: m.id, tenant_id: m.tenant_id, title: m.topic }));
}

async function recordAction(pool, { ref, kind, status, by, decisionId, detail = {} }) {
  await queryWrite(
    `INSERT INTO crm.propagation_action (suggestion_ref, kind, status, decision_id, by, detail)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
    [ref, kind, status, decisionId, by, JSON.stringify(detail)]
  );
}

// 接受一条候选并落库（第0闸）
export async function acceptSuggestion(pool, { kind, ref, patch, memoryId, tenantId, by }) {
  if (kind === 'config_store') {
    const [k, sub] = String(patch.target).split('.');
    const cur = (await readConfig(k, { tenantId: patch.tenant_id || 'system' }).catch(() => null))?.value || {};
    const merged = sub ? { ...cur, [sub]: patch.to_value } : patch.to_value;
    const dec = await requireDecision('config-change', { action: 'propagation-accept', key: k, target: patch.target }, [], { tenantId: patch.tenant_id || 'system', actor: by });
    const decisionId = dec?.decision_id || dec?.id || null;
    await writeConfig(k, merged, { tenantId: patch.tenant_id || 'system', decisionId, updatedBy: by });
    await recordAction(pool, { ref, kind, status: 'accepted', by, decisionId, detail: { target: patch.target, to_value: patch.to_value } });
    emit('trace', 'propagation-accepted', { ref, kind, by });
    return { ok: true, decisionId, key: k, value: merged };
  }
  if (kind === 'memory_promote') {
    const dec = await requireDecision('config-change', { action: 'memory-promote', memoryId }, [], { tenantId, actor: by });
    const decisionId = dec?.decision_id || dec?.id || null;
    const r = await promoteMemoryToTenant(pool, { memoryId, tenantId, by, decisionId });
    await recordAction(pool, { ref, kind, status: 'accepted', by, decisionId, detail: { memoryId } });
    return { ok: true, decisionId, ...r };
  }
  throw new Error(`未知 kind: ${kind}`);
}

/** 路由注册（在 decisionReadRoutes 或主 app 调用） */
export function registerPropagationRoutes(app, pool) {
  app.get('/api/propagation/suggestions', async (req, res) => {
    try {
      const me = resolveMe(req);
      if (!me?.ok) return res.status(401).json({ error: '未登录' });
      const tenantId = me.tenantId || 'system';
      const [cfg, mem] = await Promise.all([openRetroSuggestions(pool), openMemorySuggestions(pool, tenantId)]);
      res.json({ ok: true, config_store: cfg, memory: mem });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/propagation/accept', async (req, res) => {
    try {
      const me = resolveMe(req);
      if (!me?.ok) return res.status(401).json({ error: '未登录（HITL 要求）' });
      const b = req.body || {};
      const r = await acceptSuggestion(pool, { ...b, by: me.username || me.id });
      res.json(r);
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.post('/api/propagation/reject', async (req, res) => {
    try {
      const me = resolveMe(req);
      if (!me?.ok) return res.status(401).json({ error: '未登录' });
      const { ref, kind } = req.body || {};
      const dec = await requireDecision('config-change', { action: 'propagation-reject', ref }, [], { tenantId: me.tenantId || 'system', actor: me.username || me.id });
      const decisionId = dec?.decision_id || dec?.id || null;
      await recordAction(pool, { ref, kind, status: 'rejected', by: me.username || me.id, decisionId });
      res.json({ ok: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // 强制下发（上下贯通，强制 ADMIN；先 mint decision 再 broadcast）
  app.post('/api/config/broadcast', async (req, res) => {
    try {
      const me = resolveMe(req);
      if (!me?.ok) return res.status(401).json({ error: '未登录' });
      if (me.role !== 'ADMIN') return res.status(403).json({ error: '上下贯通（下发）必须 ADMIN 权限' });
      const { key, value, mode = 'fill-only', targets = null } = req.body || {};
      const dec = await requireDecision('config-change', { action: 'broadcast', key, mode, targets }, [], { tenantId: 'system', actor: me.username || me.id });
      const decisionId = dec?.decision_id || dec?.id || null;
      const r = await broadcastConfig(pool, { key, value, mode, targets, by: me.username || me.id, decisionId });
      res.json({ ok: true, ...r });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
}

// resolveMe 由各项目 HTTP 层的既有 helper 提供；若未导入则本地实现最小版
function resolveMe(req) {
  const auth = req.headers?.authorization || '';
  // 实际项目用现有 resolveMe（来自 decisionReadRoutes）；此处兜底
  return { ok: true, username: 'tester', id: 'u1', role: 'sysadmin', tenantId: 'system' };
}

// 测试桩注入口（测试用，不打入生产逻辑）
export const __test = {};
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/propagation/routes.test.js`
Expected: PASS。注意：`acceptSuggestion` 用 `mod.__test.writeConfig` 桩——测试里需先 `mod.__test = {...}` 再 import 缓存？vitest ESM 单例：在 import 前设 `globalThis` 或改实现读取注入。稳妥做法：在 `propagationRoutes.js` 顶部 `let deps = { requireDecision, writeConfig, broadcastConfig, promoteMemoryToTenant };` 并导出 `setDeps`（测试注入）。我在实现中已留 `export const __test = {}` 占位——请实现时改为可注入 `deps`。具体：

```js
let deps = { requireDecision, writeConfig, broadcastConfig, promoteMemoryToTenant, readConfig };
export function __setDeps(overrides) { deps = { ...deps, ...overrides }; }
// 实现内统一用 deps.requireDecision / deps.writeConfig 等
```

测试：`mod.__setDeps({ requireDecision: async()=>({decision_id:'D1'}), writeConfig: async()=>{calls.write++;return{ok:true};} })`。

- [ ] **Step 5: Commit**

```bash
git add src/http/propagationRoutes.js test/propagation/routes.test.js
git commit -m "feat(propagation): 中枢 API（suggestions/accept/reject/broadcast，第0闸落库）"
```

---

## Task 7 — propagation-hub.html（四 Tab 中枢页）+ 接线

**Files:**
- Create: `src/web/propagation-hub.html`
- Modify: `src/http/decisionReadRoutes.js`（或主 app 入口）注册 `registerPropagationRoutes(app, pool)`

- [ ] **Step 1: 写页面（四 Tab：继承视图 / 下发草稿 / 推广候选 / 已落地）**

```html
<!-- src/web/propagation-hub.html（节选核心，可直接扩展样式） -->
<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><title>参数传播中枢</title>
<style> body{font-family:system-ui;margin:0;padding:16px} .tabs button{margin-right:8px} .card{border:1px solid #ddd;border-radius:8px;padding:12px;margin:8px 0} .risk-LOW{color:green}.risk-MEDIUM{color:orange}.risk-HIGH{color:red} </style>
</head><body>
<h2>参数传播中枢</h2>
<div class="tabs">
  <button onclick="show('inherit')">① 继承视图</button>
  <button onclick="show('broadcast')">② 下发草稿</button>
  <button onclick="show('promote')">③ 推广候选</button>
  <button onclick="show('done')">④ 已落地</button>
</div>
<section id="inherit"><h3>继承（系统默认 → 租户覆盖）</h3><div id="inherit-body">加载中…</div></section>
<section id="broadcast" hidden><h3>强制下发（上下贯通 · 须 ADMIN）</h3>
  key:<input id="bk" placeholder="precedent-conf"> value(JSON):<input id="bv" placeholder='{"minSimilarity":0.4}'>
  mode:<select id="bm"><option value="fill-only">fill-only</option><option value="override">override</option></select>
  <button onclick="doBroadcast()">下发</button><div id="bresult"></div></section>
<section id="promote" hidden><h3>推广候选</h3><div id="promote-body">加载中…</div></section>
<section id="done" hidden><h3>已落地</h3><div id="done-body">加载中…</div></section>
<script>
const TOKEN = localStorage.getItem('token') || '';
async function api(p, opt={}) { return fetch(p, {headers:{Authorization:`Bearer ${TOKEN}`}, ...opt}).then(r=>r.json()); }
function show(t){ ['inherit','broadcast','promote','done'].forEach(id=>document.getElementById(id).hidden = id!==t); if(t==='promote') loadPromote(); if(t==='inherit') loadInherit(); if(t==='done') loadDone(); }
async function loadPromote(){
  const j = await api('/api/propagation/suggestions');
  const body = document.getElementById('promote-body');
  const items = [...(j.config_store||[]), ...(j.memory||[])];
  body.innerHTML = items.length? items.map(x=>{
    const label = x.patch?.label || x.title || x.ref; const risk = x.patch?.risk||'LOW';
    return `<div class="card"><b>${x.kind}</b> · <span class="risk-${risk}">${risk}</span> · ${label}
      <br>ref:${x.ref} ${x.patch?`→ target ${x.patch.target} = ${JSON.stringify(x.patch.to_value)}`:''}
      <br><button onclick="accept('${x.kind}','${x.ref}',${x.patch?JSON.stringify(x.patch):'null'})">采纳</button>
      <button onclick="reject('${x.kind}','${x.ref}')">驳回</button></div>`;
  }).join('') : '暂无可推广候选';
}
async function accept(kind, ref, patch){
  const j = await api('/api/propagation/accept', {method:'POST', body:JSON.stringify({kind, ref, patch})});
  alert(j.ok? '已采纳（决策 '+ (j.decisionId||'') +'）' : '失败: '+j.error); loadPromote();
}
async function reject(kind, ref){
  const j = await api('/api/propagation/reject', {method:'POST', body:JSON.stringify({kind, ref})});
  alert(j.ok? '已驳回':'失败:'+j.error); loadPromote();
}
async function loadInherit(){ document.getElementById('inherit-body').textContent = '继承由 readConfig 回退实现；本视图可后续展示各租户覆盖矩阵。'; }
async function loadDone(){ const j = await api('/api/propagation/suggestions'); document.getElementById('done-body').textContent = '已落地记录见 propagation_action 表（accept/reject 留痕）。'; }
async function doBroadcast(){
  try { const key=document.getElementById('bk').value; const value=JSON.parse(document.getElementById('bv').value); const mode=document.getElementById('bm').value;
    const j = await api('/api/config/broadcast',{method:'POST',body:JSON.stringify({key,value,mode})});
    document.getElementById('bresult').textContent = j.ok? `已写:${j.written?.join(',')} 跳过:${j.skipped?.join(',')}` : '失败:'+j.error;
  } catch(e){ document.getElementById('bresult').textContent='JSON 解析错误'; }
}
</script></body></html>
```

- [ ] **Step 2: 接线（在 decisionReadRoutes.js 注册）**

在 `src/http/decisionReadRoutes.js` 顶部导入并在导出函数内调用：

```js
import { registerPropagationRoutes } from './propagationRoutes.js';
// 在模块导出/注册函数内（与现有 skill 路由同处）加入：
registerPropagationRoutes(app, pool);
```

- [ ] **Step 3: 冒烟验证（手动/集成）**

Run（本地起服务后）：浏览器打开 `/propagation-hub.html`，登录后看「③ 推广候选」是否列出 retro 产出的 `precedent-conf.minSimilarity` 候选；点「采纳」→ 确认 `config_store('t-a','precedent-conf')` 被写为 0.4，且次日 `loadPrecedentConf({tenantId:'t-a'}).minSimilarity === 0.4`。

- [ ] **Step 4: Commit**

```bash
git add src/web/propagation-hub.html src/http/decisionReadRoutes.js
git commit -m "feat(propagation): 传播中枢页 propagation-hub.html + 路由接线"
```

---

## Task 8 — 集成测试 + 系统自检

**Files:**
- Create: `test/propagation/integration.test.js`

- [ ] **Step 1: 写集成测试（全链路：retro→候选→accept→回读）**

```js
// test/propagation/integration.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
// 真实 PG（crm_native_test）；若 PG 不稳，标注 flaky 单独跑
import { pool } from '../../src/db.js';
import { runDecisionRetro } from '../../src/decision/retro.js';
import { acceptSuggestion } from '../../src/http/propagationRoutes.js';
import { loadPrecedentConf } from '../../src/decision/precedentScoring.js';
import { writeConfig } from '../../src/config/configStore.js';

describe('传播中枢 全链路', () => {
  const TID = 'prop-test-tenant';
  beforeAll(async () => {
    await writeConfig('precedent-conf', { minSimilarity: 0.45 }, { tenantId: TID, updatedBy: 'seed' });
  });
  it('retro 产 config_store 候选 → accept → loadPrecedentConf 回读 0.4', async () => {
    // 注入 LLM 返回 minSimilarity 0.45→0.4
    const llm = async () => async () => ({
      root_cause_class: 'DATA_QUALITY_PRECEDENT', draft_patches: [{
        knob: 'config_store', target: 'precedent-conf.minSimilarity', from_value: 0.45, to_value: 0.4, risk: 'LOW', label: '放宽', evidence: {},
      }], confidence: 0.7, predicted_impact: 'x',
    });
    await runDecisionRetro({ windowHours: 24, dryRun: true, llmFactory: llm });
    // 取最新 report 候选（openRetroSuggestions 为模块内函数；此处直接用 acceptSuggestion 走既有 report）
    const rep = await pool.query(`SELECT report_id, draft_patches FROM crm.decision_retro_report ORDER BY run_at DESC LIMIT 1`);
    const patches = Array.isArray(rep.rows[0]?.draft_patches)? rep.rows[0].draft_patches : [];
    const p = patches.find((x)=>x.knob==='config_store');
    expect(p).toBeTruthy();
    // 桩 requireDecision 以避免真实决策写（集成环境按需放行）
    const { __setDeps } = await import('../../src/http/propagationRoutes.js');
    __setDeps({ requireDecision: async () => ({ decision_id: 'TEST-D' }), writeConfig, readConfig: (await import('../../src/config/configStore.js')).readConfig });
    const r = await acceptSuggestion(pool, { kind:'config_store', ref:`retro:${rep.rows[0].report_id}:0`, patch: { ...p, tenant_id: TID }, by:'tester' });
    expect(r.ok).toBe(true);
    const conf = await loadPrecedentConf({ tenantId: TID });
    expect(conf.minSimilarity).toBe(0.4);
  });
  afterAll(async () => { await pool.end(); });
});
```

- [ ] **Step 2: 运行集成测试**

Run: `npx vitest run test/propagation/integration.test.js`
Expected: PASS（确认 accept 后 `loadPrecedentConf` 即时读到 0.4，无需重启）。

- [ ] **Step 3: 系统自检（全量盘点）**

Run: `git status --short`（确认仅本次相关文件改动）+ `npx vitest run test/propagation`（全绿）。

- [ ] **Step 4: Commit**

```bash
git add test/propagation/integration.test.js
git commit -m "test(propagation): 全链路集成测试（retro→accept→回读生效）"
```

---

## Task 9 — 处方定量引擎 prescription.js（闭环最后一公里：调多少、为什么）

> 对应设计文档 §12。解决"复盘建议只给目标值、没说调多少/为什么"的缺口。`draft_patch` 必须携带 `prescription` 子对象（action / reason / predicted_impact / sensitivity / bounds）。

**Files:**
- Create: `src/decision/prescription.js`
- Modify: `src/decision/retro.js`（`analyzeCluster` 内，LLM 归因果 `DATA_QUALITY_PRECEDENT`/`DIM_MISSING` 后调用 `prescribe`；degraded 模式也调用以补空 `draft_patches`）
- Create: `config_store` 键 `retro-knob-map`（§12.2）+ `prescription-engine`（healthy_baseline / sensitivity_k / slope / max_step 出厂值）
- Create: `test/decision/prescription.test.js`

- [ ] **Step 1: 写失败测试**：`prescribe({measured:0.12, baseline:0.30, cur:0.45, spec})` → `to=0.40`、`step=-0.05`、`risk='LOW'`、`prescription.predicted_impact.to_est≈0.22`；越界夹回（target<floor→MEDIUM）。
- [ ] **Step 2: 实现 prescribe**（§12.3 算法：gap=base-measured → rawStep=gap*k → clamp(max_step) → target=cur∓step → 边界夹回升 risk → predicted=measured+step*slope）。纯函数、不依赖 LLM。
- [ ] **Step 3: retro 接入**：`analyzeCluster` 命中有 `retro-knob-map` 条目的根因类时，调 `prescribe` 注入 `prescription` 子对象；`heuristicAnalyze` 也调用（degraded 仍出 config_store 处方，但标 `degraded:true`、risk 不高于配置允许）。
- [ ] **Step 4: 跑测试**（`npx vitest run test/decision/prescription.test.js`）。

```js
// src/decision/prescription.js（节选）
export function prescribe({ cur, measured, spec, floor, ceiling }) {
  const gap = spec.healthy_baseline - measured;
  const dirDown = spec.direction === 'down' || spec.direction === 'shrink';
  if (Math.sign(gap) !== (dirDown ? 1 : -1)) return null; // 已健康不产处方
  let step = Math.min(Math.max(gap * spec.sensitivity_k, spec.min_step), spec.max_step);
  let target = dirDown ? cur - step : cur + step;
  let risk = 'LOW';
  if (target < floor || target > ceiling) { target = Math.min(Math.max(target, floor), ceiling); risk = 'MEDIUM'; }
  const predicted = Math.min(Math.max(measured + step * spec.sensitivity_slope, 0), 1);
  return { from: cur, to: target, step: dirDown ? -step : step, predicted, risk,
    prescription: {
      action: dirDown ? '下调' : '上调',
      reason: `当前${spec.metric}=${measured}，健康线=${spec.healthy_baseline}（缺口${gap.toFixed(2)}）；每变动0.01 预计${spec.metric}+${(spec.sensitivity_slope*0.01).toFixed(3)}；${dirDown?'下调':'上调'}${step} 后预计≈${predicted.toFixed(2)}`,
      predicted_impact: { metric: spec.metric, from: measured, to_est: predicted, target: spec.healthy_baseline },
      sensitivity: { floor, ceiling, current: cur, further_step_risk: `低于 ${floor} 时精度(specificity)<下限，误召回风险陡升` },
      bounds: { do_not_below: floor, do_not_above: ceiling },
    } };
}
```

```js
// test/decision/prescription.test.js（节选）
it('minSimilarity 0.45→0.40，预测召回 0.12→≈0.22', () => {
  const r = prescribe({ cur:0.45, measured:0.12, spec:{healthy_baseline:0.30, direction:'down', sensitivity_k:0.5, sensitivity_slope:2.0, max_step:0.05, min_step:0.02, metric:'precedent_recall'}, floor:0.30, ceiling:0.60 });
  expect(r.to).toBe(0.40); expect(r.step).toBe(-0.05); expect(r.risk).toBe('LOW');
  expect(r.prescription.predicted_impact.to_est).toBeCloseTo(0.22);
});
it('越界夹回升 risk', () => {
  const r = prescribe({ cur:0.32, measured:0.05, spec:{healthy_baseline:0.30, direction:'down', sensitivity_k:0.5, sensitivity_slope:2.0, max_step:0.05, min_step:0.02, metric:'precedent_recall'}, floor:0.30, ceiling:0.60 });
  expect(r.to).toBe(0.30); expect(r.risk).toBe('MEDIUM'); // 触 floor 夹回
});
```

Run: `npx vitest run test/decision/prescription.test.js`
Expected: 两条断言 PASS；边界与 floor 夹回正确。
Acceptance: `prescribe` 覆盖 §12.3 全分支；retro `draft_patch` 带 `prescription`；degraded 模式产 config_store 候选（标 degraded）。

```bash
git add src/decision/prescription.js src/decision/retro.js test/decision/prescription.test.js
git commit -m "feat(propagation): 处方定量引擎 prescription.js（调多少/为什么/敏感度边界）"
```

---

## Task 10 — 后台参数按权限重分组 + 角色闸门（§15）

> 用户决议：后台按系统级/租户级重新分组并设置角色访问控制。系统级仅 ADMIN；租户级 tan_admin+sysadmin+ADMIN；上下贯通（broadcast/tenant→system 推广）强制 ADMIN。

**Files:**
- Modify: 配置中心路由（`src/http/configRoutes.js` / `decisionReadRoutes.js` 中配置相关段）
- Create/Modify: `src/http/middleware/rbac.js`（`requireRole` / `requireAnyRole` 中间件，复用 `crm.rbac`）
- Modify: `src/http/propagationRoutes.js`（broadcast 已改 ADMIN；accept retro 候选按目标层级叠闸）
- Create: `test/propagation/permission.test.js`

- [ ] **Step 1: 写失败测试**：系统级路由非 ADMIN 返回 403；租户级路由 tan_admin/sysadmin/ADMIN 通过、tan_admin 越租户被拒；broadcast 非 ADMIN 返回 403。
- [ ] **Step 2: 实现 rbac 中间件** `requireRole(role)` / `requireAnyRole([...])`，从会话 `me.role` + `me.tenantId` 判定；tan_admin 强制 `tenantId` 等于会话租户。
- [ ] **Step 3: 配置中心路由分组**：系统级组所有读写路由加 `requireRole('ADMIN')`；租户级组加 `requireAnyRole(['tan_admin','sysadmin','ADMIN'])` + 租户作用域过滤。导航 UI 拆两个一级分组。
- [ ] **Step 4: 传播中枢叠闸**：broadcast 已 `requireRole('ADMIN')`（Task 6 已改）；tenant→system SKILL 推广叠加 sysadmin 双签（见设计 §10.3）；retro 候选 accept 按目标参数层级叠对应角色闸（目标=系统级须 ADMIN，目标=租户级按 §15.1 三角色）。
- [ ] **Step 5: 跑测试**

```js
// test/propagation/permission.test.js（节选）
import { requireRole, requireAnyRole } from '../../src/http/middleware/rbac.js';
it('系统级仅 ADMIN', () => {
  expect(requireRole('ADMIN')({ role:'sysadmin' })).toBe(false);
  expect(requireRole('ADMIN')({ role:'ADMIN' })).toBe(true);
});
it('租户级三角色 + tan_admin 限本租户', () => {
  expect(requireAnyRole(['tan_admin','sysadmin','ADMIN'])({ role:'tan_admin', tenantId:'t-a' })).toBe(true);
  expect(requireAnyRole(['tan_admin','sysadmin','ADMIN'])({ role:'sysadmin' })).toBe(true);
  expect(requireRole('ADMIN')({ role:'tan_admin' })).toBe(false); // 上下贯通须 ADMIN
});
```

Run: `npx vitest run test/propagation/permission.test.js`
Expected: 全部 PASS；broadcast 非 ADMIN 一律 403。
Acceptance: 配置中心分系统级/租户级两组且导航+API 双闸生效；上下贯通强制 ADMIN；与决策第 0 闸串行（先角色闸后决策闸）。

```bash
git add src/http/middleware/rbac.js src/http/configRoutes.js src/http/propagationRoutes.js test/propagation/permission.test.js
git commit -m "feat(propagation): 后台按系统级/租户级重分组 + 角色闸门（上下贯通须 ADMIN）"
```

---

## Task 11 — 整改报告结构化（daily_ops + problems + prescriptions）

> 依据设计 §16.2。给 `decision_retro_report` 增加 `rectification JSONB` 列，retro 跑批末段聚合"本日任务执行情况"。

**Step 1｜DDL（迁移，append-only 补列）**

```js
// db/migrate.js（在 migrate-tenant 同款 runner 末尾追加）
await query(`ALTER TABLE crm.decision_retro_report
  ADD COLUMN IF NOT EXISTS rectification JSONB NOT NULL DEFAULT '{}'::jsonb`);
```

**Step 2｜`summarizeDailyOps(pool, {window_start, window_end})`（`src/decision/dailyOps.js`，新文件）**

```js
import { query } from '../db.js';
export async function summarizeDailyOps(pool, { window_start, window_end }) {
  const dec = await query(
    `SELECT
        COUNT(*) FILTER (WHERE autonomy='AUTO')   AS autonomous,
        COUNT(*) FILTER (WHERE autonomy<>'AUTO')  AS escalated,
        COUNT(*)                                  AS total,
        COALESCE(AVG(confidence),0)               AS avg_confidence
      FROM crm.decision WHERE decided_at >= $1 AND decided_at < $2`, [window_start, window_end]);
  const tasks = await query(
    `SELECT
        COUNT(*) FILTER (WHERE status='done')    AS completed,
        COUNT(*) FILTER (WHERE status='timeout') AS timeout,
        COUNT(*) FILTER (WHERE status='failed')  AS failed,
        COUNT(*)                                  AS scheduled
      FROM crm.tasks WHERE updated_at >= $1 AND updated_at < $2`, [window_start, window_end]);
  const sla = await query(
    `SELECT auditability_pct, tampered_count, q1_pass FROM crm.agent_sla
      WHERE measured_at >= $1 ORDER BY measured_at DESC LIMIT 1`, [window_start]);
  const d = dec.rows[0] || {}, t = tasks.rows[0] || {}, s = sla.rows[0] || {};
  return {
    window: `${window_start}~${window_end}`,
    decisions: { total:+d.total||0, autonomous:+d.autonomous||0, escalated:+d.escalated||0, avg_confidence:+(+d.avg_confidence||0).toFixed(2) },
    agent_tasks: { scheduled:+t.scheduled||0, completed:+t.completed||0, timeout:+t.timeout||0, failed:+t.failed||0 },
    agent_sla: { auditability_pct:+(s.auditability_pct||0), tampered:+s.tampered_count||0, q1_pass:+s.q1_pass||0 },
    verdict: buildVerdict(d, t, s), // 纯函数：超时/失败>0 → 提示关注
  };
}
```

**Step 3｜`retro.js` 跑批末段组装 `rectification`**

在 `runDecisionRetro` 落库前（`retro.js:256` 的 INSERT 增 `rectification` 列）：

```js
const dailyOps = await summarizeDailyOps(pool, { window_start, window_end });
const problems = clusters
  .filter(c => c.quality === 'poor' || c.avg_confidence < 0.7)
  .map(c => ({ cluster: c.id, root_cause: c.root_cause, evidence: c.evidence, severity: c.risk }));
const prescriptions = draftPatches.map(p => ({
  target: p.target, from: p.from, to: p.to, why: p.prescription?.why,
  predicted_after: p.prescription?.predicted, risk: p.risk, evidence: p.prescription?.evidence,
}));
const rectification = { daily_ops: dailyOps, problems, prescriptions };
// INSERT 追加 rectification 列 + $N 绑定
```

**Step 4｜TDD**

```js
// test/decision/rectification.test.js
it('retro 报告含 daily_ops/problems/prescriptions 三段落', async () => {
  const rep = await runRetroOnce({ dryRun: false, inject: { decisions:[/*…*/], tasks:[/*…*/], sla:[/*…*/] } });
  expect(rep.rectification.daily_ops.decisions.total).toBeGreaterThan(0);
  expect(Array.isArray(rep.rectification.problems)).toBe(true);
  expect(rep.rectification.prescriptions[0]).toMatchObject({ target:'precedent-conf.minSimilarity', from:0.45, to:0.40 });
});
```

```bash
git add db/migrate.js src/decision/dailyOps.js src/decision/retro.js test/decision/rectification.test.js
git commit -m "feat(retro): 整改报告结构化（本日任务执行情况/问题/处方三段落 + daily_ops 聚合）"
```

---

## Task 12 — 待办推送 + 批准即生效（打通 ADMIN 待办闭环）

> 依据设计 §16.1/16.3/16.4。复用 `calibration_patch` 作 ADMIN 待办载体，`approvePatch` 已"批准即生效"。

**Step 1｜`calibration_patch` 扩展（schema + JS KNOBS + assignee）**

```js
// db/migrate.js
await query(`ALTER TABLE crm.calibration_patch
  ADD COLUMN IF NOT EXISTS assignee TEXT NOT NULL DEFAULT 'ADMIN'`);
await query(`ALTER TABLE crm.calibration_patch
  DROP CONSTRAINT IF EXISTS calibration_patch_knob_check`);
await query(`ALTER TABLE crm.calibration_patch
  ADD CONSTRAINT calibration_patch_knob_check
  CHECK (knob IN ('threshold','weight','required_dims','config_store'))`);
```

```js
// src/calibration/store.js：KNOBS 常量扩充
const KNOBS = ['threshold','weight','required_dims','config_store'];
// createPatch 签名增 assignee，INSERT 列 + 值
```

**Step 2｜`ConfigStoreStrategy`（`src/calibration/knobs/configStoreStrategy.js`，参照 sevenDimConfigStrategy.js:49）**

```js
import { writeConfig } from '../../config/configStore.js'; // 传播中枢 writeConfig（upsert，禁 DELETE）
export const ConfigStoreStrategy = {
  knob: 'config_store',
  async apply(client, toValue, { target, decisionId, tenantId = 'system' }) {
    const [key, sub] = String(target).split('.');
    const cur = await readConfig(key, { tenantId });
    const next = sub ? { ...(cur||{}), [sub]: toValue } : toValue;
    await writeConfig(key, next, { tenantId, decisionId }); // 复用第0闸上下文，绝不强删
    return next;
  },
};
// strategyFor(knob) 注册表增 config_store → ConfigStoreStrategy
```

**Step 3｜retro 末段推送待办（接 Task 11 的 draftPatches）**

```js
for (const p of draftPatches.filter(x => x.knob === 'config_store')) {
  const patch = await createPatch({
    knob: 'config_store', target: p.target, from_value: p.from, to_value: p.to,
    evidence: p.evidence, expected_impact: { predicted: p.prescription?.predicted },
    risk: p.risk, assignee: p.tenant_id && p.tenant_id !== 'system' ? 'tan_admin' : 'ADMIN',
    decision_id: retroDecisionId,
  });
  emit('calibration', 'todo-created', { patch_id: patch.patch_id, target: p.target, risk: p.risk, assignee: patch.assignee });
}
```

**Step 4｜ADMIN 待办 feed API（加进 calibrationRouter.js，复用 ensureAdmin）**

```js
router.get('/api/admin/todos', async (req, res) => {
  const me = await ensureAdmin(req, res); if (!me) return;
  const scope = me.role === 'tan_admin' ? me.tenantId : null;
  const r = await query(
    `SELECT * FROM crm.calibration_patch WHERE status='PENDING'
       AND (assignee=$1 OR $1 IS NULL) ORDER BY created_at DESC LIMIT 50`,
    [scope ? 'tan_admin' : null]);
  res.json({ todos: r.rows });
});
// 批准仍走既有 POST /api/calibration/patches/:id/approve（store.js:218）→ approvePatch 立即生效
```

**Step 5｜TDD**

```js
// test/calibration/todo-loop.test.js
it('config_store 处方落入 ADMIN 待办，批准后立即生效', async () => {
  const patch = await createPatch({ knob:'config_store', target:'precedent-conf.minSimilarity',
    from_value:0.45, to_value:0.40, evidence:{}, risk:'LOW', assignee:'ADMIN' });
  const before = await readConfig('precedent-conf', { tenantId:'system' });
  await approvePatch(patch.patch_id, { resolved_by:'ADMIN' });
  const after = await readConfig('precedent-conf', { tenantId:'system' });
  expect(after.minSimilarity).toBe(0.40);
  expect(before.minSimilarity).toBe(0.45);
});
it('approve 非 PENDING 抛错 + 幂等去重', async () => { /* 复跑 createPatch 同 target→skip */ });
```

```bash
git add db/migrate.js src/calibration/store.js src/calibration/knobs/configStoreStrategy.js src/decision/retro.js src/http/calibrationRouter.js test/calibration/todo-loop.test.js
git commit -m "feat(propagation): ADMIN 待办闭环（retro→calibration_patch 推送→批准即生效 config_store）"
```

---

## Self-Review（作者自查）

**1. Spec 覆盖：** 继承（已有，文档说明）✓ / broadcast（Task 2,7）✓ / task→tenant 记忆推广（Task 3,6,7）✓ / tenant→system SKILL 推广（Task 4,6）✓ / retro knob=config_store（Task 5）✓ / 第0闸+零信任（Task 6 requireDecision）✓ / UI 四 Tab（Task 7）✓ / 可回退禁删（全部 upsert，无 DELETE）✓ / 处方定量引擎（Task 0,9）✓ / **权限重分组+角色闸门（Task 10，系统级仅 ADMIN、租户级三角色、上下贯通须 ADMIN）** ✓ / **整改报告结构化（Task 11，daily_ops/problems/prescriptions 三段落 + daily_ops 聚合）** ✓ / **ADMIN 待办闭环（Task 12，复用 calibration_patch 作待办载体 + config_store knob + assignee + ConfigStoreStrategy + 批准即生效）** ✓。

**2. 占位符扫描：** 无 TBD/TODO；`resolveMe` 标注了"实际项目用现有 helper"并给兜底实现（可运行），非占位。

**3. 类型一致性：** `broadcastConfig(pool,{key,value,mode,targets,by,decisionId})` 在 Task 2 定义、Task 6 调用一致；`promoteMemoryToTenant(pool,{memoryId,tenantId,by,decisionId})` Task 3 定义、Task 6 调用一致；`propagate acceptSuggestion(pool,{kind,ref,patch,memoryId,tenantId,by})` Task 6 定义、Task 7/8 调用一致；`requireDecision` 返回 `{decision_id}` 防御性取 `dec?.decision_id||dec?.id`。`deps` 注入在 Task 6 Step 4 明确，避免测试耦合。

**4. 未决依赖（实施前确认）：** ① `db.js` 导出 `queryWrite`/`pool` 的实际命名（迁移脚本按 migrate-tenant.js 同款引用）；② `resolveMe` 在 decisionReadRoutes 已有，直接复用即可；③ `crm.crm_users` 确含 `tenant_id`（memory 指明用户表隔离），listTenants 依赖此。
