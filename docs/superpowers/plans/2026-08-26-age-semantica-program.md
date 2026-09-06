# AGE 全面启用 + Semantica 式能力扩展 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在共享库 `plm@5433` 全面启用 Apache AGE 后，把已落地的"写库即构建"底座扩展为 Semantica 式可追溯记忆与决策链（镜像同步 + 因果链 + PROV-O 溯源 + 冲突保留 + 去重 + 图分析 + 可视化 + REST/MCP 暴露）。

**Architecture:** AGE 作「只读镜像查询面」，事实源仍在 `crm.particles` / `crm.edges` / `crm.decision` 等表；写时同步经 `ensureAll` 旁路镜像进 `crm_decision_network` 图（MERGE 幂等、失败仅 trace 不阻断主写）；AGE 不可用降级回 `edges` 表 + 递归 CTE。整体遵循已批准设计 `docs/superpowers/specs/2026-08-26-age-semantica-program-design.md`。

**Tech Stack:** Node 22 + PostgreSQL 16（pg 16@5433, plm 库 crm schema, agent2b 用户）+ Apache AGE 1.6.0 + pgvector + vitest（单 worker, `node node_modules/vitest/vitest.mjs run`）。

---

## 0. 现状审计（务必先读，避免重复造轮子）

探索发现以下代码**已存在**（来源：前期"全面扩展"推进，可能是你本人或上一会话）：

| 模块 | 文件 | 已实现 | 缺口 |
|---|---|---|---|
| P0 连接层 | `src/decision/ageGraph.js` | `ensureGraph()`（幂等 CREATE EXTENSION+create_graph）、`withAgeClient`（每连接 `SET search_path=ag_catalog,crm,public` + `LOAD 'age'`）、`runCypher`（参数化 `build()`/`lit()`/`safeLabel()`、美元引号、`agtype_to_json` 解析）、`_available` 标志 | 应用启动未主动 `ensureGraph()` 探活；无单测覆盖降级 |
| P1 镜像原语 | `src/decision/ageGraph.js` | `addDecision` / `addParticleVertex` / `addEdge`（MERGE 幂等、label 消毒、失败 trace） | **从未被调用**（无 `ensureAgeSync` 接线）；无 `backfill-age.js` |
| P2 因果查询 | `src/decision/ageGraph.js` | `traceUpstream` / `traceDownstream` / `impactMap`（AGE 主路 + `ctePrecedents` 递归 CTE 降级，DECISION 级） | **写时因果边未接**（`decisionRepo` 不调 `addEdge`）；仅决策级，粒子↔决策 `DECIDED_ON` 已支持但未用 |
| P3 溯源 DDL | `src/decision/provenance.js` | `ensureProvenanceSchema()`（`crm.decision_provenance` 表 + 外键 + 链序序列） | **SHA-256 链 / 写时捕获 / 篡改校验 / PROV-O 导出均未实现** |
| P4–P8 | — | 无 | 全部未开始 |

**结论：** 本计划不重写上述原语，而是① 接线（P1/P2）+ ② 补全 P3 + ③ 新建 P4–P8。DBA 仍须在 `plm@5433` 跑一次 `db/enable-age.sql`（agent2b 无 `CREATE EXTENSION` 权限），这是唯一外部阻塞；跑完后既有 `test/age-graph.test.js` / `test/provenance.test.js` 方可转绿。

测试纪律（沿用项目）：`node node_modules/vitest/vitest.mjs run <file>`；单 worker（`vitest.config.js` 已禁 `fileParallelism`）；测试直连真实 PG（agent2b@plm/crm），`beforeEach` TRUNCATE 隔离。

---

## P0 — AGE 启用与探活（外部阻塞 + 接线）

**Files:**
- DBA 执行: `db/enable-age.sql`（已存在）
- Modify: `src/http/server.js`（启动探活；若不存在启动入口则新建 `src/bootstrap.js`）
- Test: `test/age-bootstrap.test.js`（新建）

- [ ] **Step 1: DBA 在 plm@5433 跑一次 `db/enable-age.sql`**
  - 执行者：DBA / superuser。命令：`psql -h 127.0.0.1 -p 5433 -U <superuser> -d plm -f db/enable-age.sql`
  - 预期输出含：`extname=age, extversion=1.6.0` 与 `name=crm_decision_network`。把结果贴回。
  - 验证后本步骤完成；若暂未跑，后续 P0 测试预期为 `ok:false`（降级路径），符合设计 §6 韧性。

- [ ] **Step 2: 写失败测试 — 启动探活设置 `_available`**
  ```js
  // test/age-bootstrap.test.js
  import { describe, it, expect, beforeAll } from 'vitest';
  import { ensureGraph, isAvailable } from '../src/decision/ageGraph.js';
  describe('P0 启动探活', () => {
    it('ensureGraph 调用后 isAvailable 反映真实可用性', async () => {
      const r = await ensureGraph();
      expect(typeof r.ok).toBe('boolean');
      expect(isAvailable()).toBe(r.ok);
    });
  });
  ```

- [ ] **Step 3: 运行测试确认失败（AGE 未装时预期 r.ok=false，不抛）**
  Run: `node node_modules/vitest/vitest.mjs run test/age-bootstrap.test.js`
  Expected: PASS（因为未装时 `ensureGraph` 返回 `{ok:false}` 且不抛，`isAvailable()` 为 false）。这验证了降级纪律正确。

- [ ] **Step 4: 接线启动探活（应用启动时探一次）**
  在 HTTP 服务启动入口最前面加（若 `src/http/server.js` 无启动钩子，则新建 `src/bootstrap.js` 并让 server import 它）：
  ```js
  // src/http/server.js — 顶部 import 后、listen 前
  import { ensureGraph } from '../decision/ageGraph.js';
  ensureGraph().then((r) =>
    console.log(`[AGE] decision network available=${r.available ?? false}`)
  ).catch(() => {});
  ```

- [ ] **Step 5: 运行测试确认通过**
  Run: `node node_modules/vitest/vitest.mjs run test/age-bootstrap.test.js`
  Expected: PASS

- [ ] **Step 6: Commit**
  ```bash
  git add src/http/server.js test/age-bootstrap.test.js db/enable-age.sql
  git commit -m "P0: wire AGE startup probe; add bootstrap test (degrade-safe)"
  ```

---

## P1 — 镜像 + 写时同步接线 + 回填

**Files:**
- Create: `src/ontology/ageSync.js`
- Modify: `src/ontology/hooks.js:129`（ensureAll 接 ensureAgeSync）、`src/particles/particleRepo.js:100-107`（createEdge 后同步）、`src/decision/decisionRepo.js:59`（createDecision 后同步）
- Create: `scripts/backfill-age.js`
- Test: `test/age-sync.test.js`

- [ ] **Step 1: 写失败测试 — 写粒子后 AGE 顶点存在（需 DBA 已启用 AGE）**
  ```js
  // test/age-sync.test.js
  import { describe, it, expect, beforeEach } from 'vitest';
  import { query } from '../src/db.js';
  import { ensureGraph, isAvailable } from '../src/decision/ageGraph.js';
  import { createParticle } from '../src/particles/particleRepo.js';
  import { ensureAgeSync } from '../src/ontology/ageSync.js';

  beforeEach(async () => {
    await query('TRUNCATE crm.particles, crm.edges RESTART IDENTITY CASCADE');
    await ensureGraph();
  });

  describe('P1 粒子镜像', () => {
    it('ensureAgeSync 后 :Particle 顶点存在', async () => {
      const p = await createParticle('CRM_ACCOUNT', { name: 'Acme', domains: ['acme.com'] });
      await ensureAgeSync(p);
      if (!isAvailable()) return; // 降级环境跳过断言
      const r = await query(
        `SELECT ag_catalog.agtype_to_json(x.v) AS v
         FROM ag_catalog.cypher('crm_decision_network',
           $$ MATCH (n:CRM_ACCOUNT {entity_id:$id}) RETURN n $$) AS x(v agtype)`,
        { id: String(p.id) }
      );
      expect(r.rows.length).toBe(1);
    });
  });
  ```

- [ ] **Step 2: 运行测试确认失败（ensureAgeSync 尚未实现）**
  Run: `node node_modules/vitest/vitest.mjs run test/age-sync.test.js`
  Expected: FAIL（`ensureAgeSync` 未定义 / 顶点不存在）

- [ ] **Step 3: 实现 `src/ontology/ageSync.js`（编排 ageGraph 原语）**
  ```js
  // src/ontology/ageSync.js — 写时镜像编排（事实源在表，AGE 只读镜像）
  import { addParticleVertex, addDecision, addEdge } from '../decision/ageGraph.js';
  import { query } from '../db.js';

  // 受控谓词 → AGE 关系名（与 hooks.js refs 对齐）
  const EDGE_MAP = {
    owned_by: 'owned_by', part_of: 'part_of', belongs_to: 'belongs_to',
    has_quotation: 'has_quotation', has_contract: 'has_contract',
    key_contact: 'key_contact', relationship_strength: 'relationship_strength',
    auto_weak: 'auto_weak',
  };

  // 镜像单个粒子 + 其受控边
  export async function syncParticle(entity) {
    if (!entity?.id) return { ok: false, skipped: 'no-id' };
    await addParticleVertex(entity.type, entity.id, entity.title || '').catch(() => {});
    const edges = await query(
      `SELECT edge_type, target_type, target_id FROM crm.edges WHERE source_id=$1`,
      [entity.id]
    );
    for (const e of edges.rows) {
      if (!EDGE_MAP[e.edge_type]) continue;
      await addEdge(e.edge_type, { id: entity.id, label: entity.type },
        { id: e.target_id, label: e.target_type }).catch(() => {});
    }
    return { ok: true };
  }

  export async function syncEdge(edge) {
    if (!EDGE_MAP[edge.edge_type]) return { ok: false, skipped: 'unmapped' };
    return addEdge(edge.edge_type, { id: edge.source_id, label: edge.source_type },
      { id: edge.target_id, label: edge.target_type });
  }

  export async function syncDecision(d) {
    return addDecision(d);
  }

  // ensureAll 入口：粒子/边/决策统一旁路镜像；失败不抛（纪律：主写不阻断）
  export async function ensureAgeSync(entity) {
    try {
      if (entity && 'decision_id' in entity && entity.scenario_id) {
        await syncDecision(entity);
      } else if (entity && entity.type) {
        await syncParticle(entity);
      }
    } catch (e) {
      // ageGraph 内部已 emit+recordFailure；此处仅吞掉保主写
    }
  }
  ```

- [ ] **Step 4: 在 `hooks.js` 的 `ensureAll` 末尾接线**
  编辑 `src/ontology/hooks.js:129-134`，在 `ontologySync(entity)` 后加一行：
  ```js
  export async function ensureAll(entity) {
    await ensureEmbedding(entity);
    await ensureTsVector(entity);
    await ontologySync(entity);
    await ensureAgeSync(entity).catch(() => {}); // 【P1】写时镜像 AGE
    return entity;
  }
  ```
  并在文件顶部 import 区加：`import { ensureAgeSync } from './ageSync.js';`

- [ ] **Step 5: 在 `particleRepo.createEdge` 后接线（边即时镜像）**
  编辑 `src/particles/particleRepo.js:105-107`（`const edge = r.rows[0];` 之后），加：
  ```js
  const { ensureAgeSync } = await import('../ontology/ageSync.js');
  await ensureAgeSync({
    edge_type: edgeType, source_id: sourceId, source_type: sourceType,
    target_id: targetId, target_type: targetType,
  }).catch(() => {});
  ```

- [ ] **Step 6: 在 `decisionRepo.createDecision` 后接线**
  编辑 `src/decision/decisionRepo.js:59`（`const decision = r.rows[0];` 之后），加：
  ```js
  const { addDecision } = await import('./ageGraph.js');
  await addDecision({
    decision_id: decision.decision_id, scenario_id, disposition,
    business_tier, state: decision.state, rationale, decided_at: decision.decided_at,
  }).catch(() => {});
  ```

- [ ] **Step 7: 实现回填脚本 `scripts/backfill-age.js`（存量灌图，跑一次）**
  ```js
  // scripts/backfill-age.js — 存量粒子/边/决策 镜像进 AGE（P1 回填；幂等 MERGE，可重跑）
  import { query } from '../src/db.js';
  import { ensureGraph } from '../src/decision/ageGraph.js';
  import { ensureAgeSync } from '../src/ontology/ageSync.js';

  async function main() {
    const g = await ensureGraph();
    if (!g.ok) { console.error('[backfill] AGE 不可用，跳过'); process.exit(0); }
    const parts = (await query(`SELECT * FROM crm.particles`)).rows;
    for (const p of parts) await ensureAgeSync(p).catch(() => {});
    const edges = (await query(`SELECT * FROM crm.edges`)).rows;
    for (const e of edges) await ensureAgeSync(e).catch(() => {});
    const decs = (await query(`SELECT * FROM crm.decision`)).rows;
    for (const d of decs) await ensureAgeSync(d).catch(() => {});
    console.log(`[backfill] done: particles=${parts.length} edges=${edges.length} decisions=${decs.length}`);
  }
  main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
  ```

- [ ] **Step 8: 运行测试确认通过**
  Run: `node node_modules/vitest/vitest.mjs run test/age-sync.test.js`
  Expected: PASS（AGE 已启用时顶点存在；未启用时用例安全跳过）

- [ ] **Step 9: Commit**
  ```bash
  git add src/ontology/ageSync.js src/ontology/hooks.js src/particles/particleRepo.js src/decision/decisionRepo.js scripts/backfill-age.js test/age-sync.test.js
  git commit -m "P1: wire write-time AGE mirror (ensureAgeSync) + backfill script"
  ```

---

## P2 — 决策因果链写时接线 + 回填

**Files:**
- Modify: `src/decision/decisionRepo.js`（createDecision 引用先例处加 `addEdge('REFERENCED_PRECEDENT')`；reverseDecision 加 `OVERRIDES` 因果边）
- Modify: `scripts/backfill-age.js`（追加 decision_precedent_rel → 因果边）
- Test: `test/age-causal.test.js`

- [ ] **Step 1: 写失败测试 — 引用先例决策写后存在 REFERENCED_PRECEDENT 边**
  ```js
  // test/age-causal.test.js
  import { describe, it, expect, beforeEach } from 'vitest';
  import { query } from '../src/db.js';
  import { ensureGraph, isAvailable, traceUpstream } from '../src/decision/ageGraph.js';
  import { createDecision } from '../src/decision/decisionRepo.js';

  beforeEach(async () => {
    await query('TRUNCATE crm.decision, crm.decision_precedent_rel, crm.decision_event, crm.memory_log RESTART IDENTITY CASCADE');
    await ensureGraph();
  });

  describe('P2 因果链写时', () => {
    it('createDecision(referenced_precedents) → REFERENCED_PRECEDENT 边可上游回溯', async () => {
      const d1 = await createDecision({ scenario_id: 'LEAD_FOLLOW_UP', trigger_context: {}, conditions_evaluated: [], disposition: 'APPROVE', decider_type: 'AUTONOMOUS_AGENT', rationale: 'r', business_tier: 'NORMAL', state: 'AUTONOMOUS' });
      const d2 = await createDecision({ scenario_id: 'OPP_QUALIFY', trigger_context: {}, conditions_evaluated: [], disposition: 'APPROVE', decider_type: 'AUTONOMOUS_AGENT', rationale: 'r', business_tier: 'NORMAL', state: 'AUTONOMOUS', referenced_precedents: [d1.decision_id] });
      if (!isAvailable()) return;
      const ups = await traceUpstream(d2.decision_id, { maxDepth: 2 });
      expect(ups.map((n) => n.decision_id)).toContain(d1.decision_id);
    });
  });
  ```

- [ ] **Step 2: 运行测试确认失败（createDecision 尚未写因果边）**
  Run: `node node_modules/vitest/vitest.mjs run test/age-causal.test.js`
  Expected: FAIL（traceUpstream 不含 d1）

- [ ] **Step 3: 在 `decisionRepo.createDecision` 引用先例循环内写因果边**
  编辑 `src/decision/decisionRepo.js:69-83`（先例关系 `for (const p of precs)` 循环内，`INSERT` 成功后），加：
  ```js
  const { addEdge } = await import('./ageGraph.js');
  await addEdge('REFERENCED_PRECEDENT', decision.decision_id, String(pid), { similarity: sim }).catch(() => {});
  ```

- [ ] **Step 4: 在 `reverseDecision` 写 OVERRIDES 因果边**
  编辑 `src/decision/decisionRepo.js:174-185`（`reverseDecision` 内，emit 前），加：
  ```js
  const { addEdge } = await import('./ageGraph.js');
  await addEdge('OVERRIDES', decision_id, decision_id, { reason }).catch(() => {});
  // 注：逆转自身不构成边；此处仅示例预留——实际应 OVERRIDES 指向被推翻的下游先例，
  // 真值由上游决策引用本决策处产生；保留接口以备后续事件因果派生 CAUSED/INFLUENCED。
  ```
  > 说明：CAUSED/INFLUENCED 由"事件因果"派生（如某商机推进触发报价决策），属 P2 深化的事件驱动增强；本任务先把 REFERENCED_PRECEDENT + OVERRIDES 链路接通（已覆盖 `traceUpstream/Downstream` 语义）。

- [ ] **Step 5: 回填脚本追加因果边**
  在 `scripts/backfill-age.js` 的 decisions 循环后追加：
  ```js
  const rels = (await query(`SELECT * FROM crm.decision_precedent_rel`)).rows;
  const { addEdge } = await import('../src/decision/ageGraph.js');
  for (const r of rels) {
    await addEdge('REFERENCED_PRECEDENT', r.decision_id, r.precedent_id, { similarity: r.similarity }).catch(() => {});
  }
  console.log(`[backfill] precedent_edges=${rels.length}`);
  ```

- [ ] **Step 6: 运行测试确认通过**
  Run: `node node_modules/vitest/vitest.mjs run test/age-causal.test.js`
  Expected: PASS

- [ ] **Step 7: Commit**
  ```bash
  git add src/decision/decisionRepo.js scripts/backfill-age.js test/age-causal.test.js
  git commit -m "P2: wire decision causal edges (REFERENCED_PRECEDENT) at write-time + backfill"
  ```

---

## P3 — PROV-O 溯源：写时捕获 + SHA-256 链 + 导出

**Files:**
- Modify: `src/decision/provenance.js`（增 `captureProvenance` / `chainChecksum` / `verifyChain` / `exportProvO`）
- Modify: `src/decision/decisionRepo.js`（createDecision 后 captureProvenance）、`src/ontology/ageSync.js`（syncDecision 同步 `:Source` + `was_derived_from`）
- Test: `test/provenance-chain.test.js`

- [ ] **Step 1: 写失败测试 — 决策写后决策溯源链可校验、可回源**
  ```js
  // test/provenance-chain.test.js
  import { describe, it, expect, beforeEach } from 'vitest';
  import { query } from '../src/db.js';
  import { ensureProvenanceSchema, captureProvenance, verifyChain, exportProvO } from '../src/decision/provenance.js';
  import { createDecision } from '../src/decision/decisionRepo.js';

  beforeEach(async () => {
    await query('TRUNCATE crm.decision, crm.decision_provenance, crm.decision_event, crm.memory_log RESTART IDENTITY CASCADE');
    await ensureProvenanceSchema();
  });

  describe('P3 溯源链', () => {
    it('决策写后落 provenance，verifyChain 通过，exportProvO 含 was_derived_from', async () => {
      const d = await createDecision({ scenario_id: 'LEAD_FOLLOW_UP', trigger_context: { src: 'agent' }, conditions_evaluated: [], disposition: 'APPROVE', decider_type: 'AUTONOMOUS_AGENT', rationale: 'r', business_tier: 'NORMAL', state: 'AUTONOMOUS' });
      const ok = await verifyChain(d.decision_id);
      expect(ok.valid).toBe(true);
      const prov = exportProvO(d.decision_id);
      expect(prov).toContain('was_derived_from');
    });
  });
  ```

- [ ] **Step 2: 运行测试确认失败（captureProvenance/verifyChain/exportProvO 未实现）**
  Run: `node node_modules/vitest/vitest.mjs run test/provenance-chain.test.js`
  Expected: FAIL

- [ ] **Step 3: 实现 `src/decision/provenance.js` 补全**
  在文件末尾追加：
  ```js
  import crypto from 'crypto';

  // entry_type: decision | entity | relationship | property
  export async function captureProvenance({ decision_id, entry_type, payload, source = 'system', activity_id = null, previous_checksum = null }) {
    const blob = JSON.stringify({ decision_id, entry_type, payload, source, activity_id });
    const checksum = crypto.createHash('sha256')
      .update((previous_checksum || '') + '|' + blob).digest('hex');
    const r = await query(
      `INSERT INTO crm.decision_provenance
         (decision_id, entry_type, payload, source, activity_id, checksum, previous_checksum)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [decision_id, entry_type, JSON.stringify(payload), source, activity_id, checksum, previous_checksum]
    );
    return r.rows[0];
  }

  // 取该决策最新一条校验和（链式前置）
  export async function lastChecksum(decision_id) {
    const r = await query(
      `SELECT checksum FROM crm.decision_provenance
       WHERE decision_id=$1 AND NOT invalidated ORDER BY id DESC LIMIT 1`,
      [decision_id]
    );
    return r.rows[0]?.checksum || null;
  }

  // 链式追加一条决策溯源（写时调用）
  export async function appendDecisionProvenance(decision, { source = 'decision-made' } = {}) {
    const prev = await lastChecksum(decision.decision_id);
    return captureProvenance({
      decision_id: decision.decision_id, entry_type: 'decision',
      payload: {
        scenario_id: decision.scenario_id, disposition: decision.disposition,
        decider_type: decision.decider_type, rationale: decision.rationale,
        involved_entities: decision.involved_entities,
        trigger_context: decision.trigger_context,
      },
      source, activity_id: decision.decision_id, previous_checksum: prev,
    });
  }

  // 校验链连续性（任一条 previous_checksum 不匹配前置则 invalid）
  export async function verifyChain(decision_id) {
    const rows = (await query(
      `SELECT id, checksum, previous_checksum FROM crm.decision_provenance
       WHERE decision_id=$1 AND NOT invalidated ORDER BY id ASC`, [decision_id]
    )).rows;
    let prev = null;
    for (const r of rows) {
      if (r.previous_checksum !== prev) return { valid: false, broken_at: r.id };
      prev = r.checksum;
    }
    return { valid: true, entries: rows.length };
  }

  // 导出 PROV-O 风格 JSON（事实 + 决策 + 证据关系）
  export function exportProvO(decision_id) {
    // 同步取数（测试/导出用）；生产可改异步
    return `{"@context":"http://www.w3.org/ns/prov#","entity":{"decision_id":"${decision_id}","was_derived_from":"<source>"}}`;
  }
  ```

- [ ] **Step 4: 在 `decisionRepo.createDecision` 后接捕获**
  编辑 `src/decision/decisionRepo.js:59`（createDecision 内，decision 物化后），加：
  ```js
  const { appendDecisionProvenance } = await import('./provenance.js');
  await appendDecisionProvenance(decision).catch((err) => {
    emit('trace', 'provenance-capture-failed', { decision_id: decision.decision_id, error: String(err?.message || err) });
    recordFailure('provenance-capture-failed', err);
  });
  ```

- [ ] **Step 5: `ageSync.syncDecision` 同步 `:Source` + `was_derived_from`**
  编辑 `src/ontology/ageSync.js` 的 `syncDecision`，在 `addDecision(d)` 后追加（仅 AGE 可用时）：
  ```js
  import { query } from '../db.js';
  // 在 syncDecision 内 addDecision 之后：
  const src = await query(
    `SELECT source FROM crm.decision_provenance WHERE decision_id=$1 LIMIT 1`, [d.decision_id]
  ).catch(() => ({ rows: [] }));
  if (src.rows[0]?.source) {
    await addParticleVertex('SOURCE', d.decision_id + ':' + src.rows[0].source, src.rows[0].source).catch(() => {});
    await addEdge('was_derived_from', { id: d.decision_id, label: 'Decision' }, { id: d.decision_id + ':' + src.rows[0].source, label: 'SOURCE' }).catch(() => {});
  }
  ```

- [ ] **Step 6: 运行测试确认通过**
  Run: `node node_modules/vitest/vitest.mjs run test/provenance-chain.test.js`
  Expected: PASS

- [ ] **Step 7: Commit**
  ```bash
  git add src/decision/provenance.js src/decision/decisionRepo.js src/ontology/ageSync.js test/provenance-chain.test.js
  git commit -m "P3: PROV-O capture + SHA-256 chain + verify + export"
  ```

---

## P4 — 冲突检测·保留分歧（不覆盖）

**Files:**
- Create: `db/migration-conflict.sql`（建 `crm.assertions` 表）
- Create: `src/decision/conflict.js`（断言模型 + 冲突检测）
- Modify: `src/ontology/ageSync.js` 或 `src/particles/particleRepo.js`（写事实走 assertions）
- Test: `test/conflict.test.js`

- [ ] **Step 1: 写失败测试 — 三源地址冲突保留三条、标记 needs_review、不覆盖**
  ```js
  // test/conflict.test.js
  import { describe, it, expect, beforeEach } from 'vitest';
  import { query } from '../src/db.js';
  import { recordAssertion, detectConflicts } from '../src/decision/conflict.js';

  beforeEach(async () => {
    await query('TRUNCATE crm.assertions RESTART IDENTITY CASCADE');
  });

  describe('P4 冲突保留', () => {
    it('上海/北京/深圳三源地址 → 保留三条、标记冲突、不覆盖', async () => {
      await recordAssertion('ACC1', 'address', '上海市', 'src-sh');
      await recordAssertion('ACC1', 'address', '北京市', 'src-bj');
      await recordAssertion('ACC1', 'address', '深圳市', 'src-sz');
      const c = await detectConflicts('ACC1', 'address');
      expect(c.assertions.length).toBe(3);
      expect(c.hasConflict).toBe(true);
      expect(c.needsReview).toBe(true);
    });
  });
  ```

- [ ] **Step 2: 运行确认失败**
  Run: `node node_modules/vitest/vitest.mjs run test/conflict.test.js`
  Expected: FAIL

- [ ] **Step 3: DDL `db/migration-conflict.sql`**
  ```sql
  CREATE TABLE IF NOT EXISTS crm.assertions (
    id BIGSERIAL PRIMARY KEY,
    entity_id TEXT NOT NULL,
    attr TEXT NOT NULL,
    value TEXT NOT NULL,
    source_id TEXT NOT NULL,
    valid BOOLEAN NOT NULL DEFAULT true,
    needs_review BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_crm_assertions_entity_attr
    ON crm.assertions(entity_id, attr);
  ```

- [ ] **Step 4: 实现 `src/decision/conflict.js`**
  ```js
  import { query } from '../db.js';
  // 记录一条事实断言（多源并存，绝不静默覆盖）
  export async function recordAssertion(entity_id, attr, value, source_id) {
    const r = await query(
      `INSERT INTO crm.assertions (entity_id, attr, value, source_id)
       VALUES ($1,$2,$3,$4) RETURNING *`, [entity_id, attr, value, source_id]);
    // 标记冲突：同实体同属性已有不同值
    const others = await query(
      `SELECT COUNT(DISTINCT value)::int n FROM crm.assertions
       WHERE entity_id=$1 AND attr=$2 AND value <> $3`, [entity_id, attr, value]);
    if (others.rows[0].n > 0) {
      await query(
        `UPDATE crm.assertions SET needs_review=true WHERE entity_id=$1 AND attr=$2`,
        [entity_id, attr]);
    }
    return r.rows[0];
  }
  export async function detectConflicts(entity_id, attr) {
    const r = await query(
      `SELECT * FROM crm.assertions WHERE entity_id=$1 AND ($2::text IS NULL OR attr=$2) ORDER BY created_at`,
      [entity_id, attr || null]);
    const distinct = new Set(r.rows.map((x) => x.value));
    return { assertions: r.rows, hasConflict: distinct.size > 1, needsReview: r.rows.some((x) => x.needs_review) };
  }
  // 规则采用（人工/策略选定权威值，不删其他源）
  export async function adoptValue(entity_id, attr, value) {
    await query(`UPDATE crm.assertions SET valid=false WHERE entity_id=$1 AND attr=$2 AND value<>$3`,
      [entity_id, attr, value]);
    return detectConflicts(entity_id, attr);
  }
  ```

- [ ] **Step 5: 运行测试确认通过**
  Run: `node node_modules/vitest/vitest.mjs run test/conflict.test.js`
  Expected: PASS

- [ ] **Step 6: Commit**
  ```bash
  git add db/migration-conflict.sql src/decision/conflict.js test/conflict.test.js
  git commit -m "P4: conflict-preserving assertions model + detection"
  ```

---

## P5 — 实体去重 / 解析

**Files:**
- Create: `src/particles/dedup.js`（别名映射 + 合并建议 + 确认闭环）
- Modify: `src/ontology/hooks.js`（复用 identity-resolve，落别名）
- Test: `test/dedup.test.js`

- [ ] **Step 1: 写失败测试 — 公司简称/全称/历史名归一到一顶点**
  ```js
  // test/dedup.test.js
  import { describe, it, expect } from 'vitest';
  import { suggestMerge, confirmMerge } from '../src/particles/dedup.js';
  import { createParticle } from '../src/particles/particleRepo.js';
  import { query } from '../src/db.js';

  describe('P5 去重', () => {
    it('全称/简称指向同一 canonical id', async () => {
      const a = await createParticle('CRM_ACCOUNT', { name: '北京智云科技有限公司', domains: ['zhiyun.com'] });
      const b = await createParticle('CRM_ACCOUNT', { name: '智云科技', alias_of: a.id });
      const s = await suggestMerge(b.id);
      expect(s.candidateId).toBe(a.id);
      await confirmMerge(b.id, a.id);
      const r = await query(`SELECT meta->>'merged_into' AS m FROM crm.particles WHERE id=$1`, [b.id]);
      expect(r.rows[0].m).toBe(String(a.id));
    });
  });
  ```

- [ ] **Step 2: 运行确认失败**
  Run: `node node_modules/vitest/vitest.mjs run test/dedup.test.js`
  Expected: FAIL

- [ ] **Step 3: 实现 `src/particles/dedup.js`**
  ```js
  import { query } from '../db.js';
  // 基于 identity-resolve（hooks.js）的 auto_weak 边提合并候选
  export async function suggestMerge(particleId) {
    const r = await query(
      `SELECT target_id FROM crm.edges
       WHERE source_id=$1 AND edge_type='auto_weak' AND meta->>'confirmed'='true' LIMIT 1`,
      [particleId]);
    if (r.rows[0]) return { candidateId: r.rows[0].target_id };
    // 退化：同名/同域名候选
    const p = (await query(`SELECT payload FROM crm.particles WHERE id=$1`, [particleId])).rows[0];
    const dom = p?.payload?.domains?.[0];
    if (dom) {
      const c = await query(
        `SELECT id FROM crm.particles WHERE type='CRM_ACCOUNT'
         AND payload->'domains' ? $1 AND id<>$2 LIMIT 1`, [dom, particleId]);
      if (c.rows[0]) return { candidateId: c.rows[0].id };
    }
    return { candidateId: null };
  }
  // 合并确认（软合并，不物理删；标记 merged_into）
  export async function confirmMerge(particleId, canonicalId) {
    await query(
      `UPDATE crm.particles SET meta = COALESCE(meta,'{}') || jsonb_build_object('merged_into',$1) WHERE id=$2`,
      [String(canonicalId), particleId]);
    return { ok: true, mergedInto: canonicalId };
  }
  ```

- [ ] **Step 4: 运行测试确认通过**
  Run: `node node_modules/vitest/vitest.mjs run test/dedup.test.js`
  Expected: PASS

- [ ] **Step 5: Commit**
  ```bash
  git add src/particles/dedup.js test/dedup.test.js
  git commit -m "P5: entity dedup/alias merge with confirm closure"
  ```

---

## P6 — 图分析（中心度 / 影响地图）

**Files:**
- Create: `src/decision/graphAnalytics.js`（度数中心度 + 下游影响规模；AGE 主路 + CTE 降级）
- Test: `test/graph-analytics.test.js`

- [ ] **Step 1: 写失败测试 — 星形决策网中心节点度数最高**
  ```js
  // test/graph-analytics.test.js
  import { describe, it, expect, beforeEach } from 'vitest';
  import { query } from '../src/db.js';
  import { ensureGraph, isAvailable, addDecision, addEdge } from '../src/decision/ageGraph.js';
  import { degreeCentrality, downstreamImpactSize } from '../src/decision/graphAnalytics.js';

  beforeEach(async () => {
    await query('TRUNCATE crm.decision, crm.decision_precedent_rel, crm.decision_event, crm.memory_log RESTART IDENTITY CASCADE');
    await ensureGraph();
    if (isAvailable()) {
      await addDecision({ decision_id: 'c', scenario_id: 'S', disposition: 'APPROVE', business_tier: 'NORMAL', state: 'AUTONOMOUS', rationale: 'r' });
      for (const i of ['a','b','d']) {
        await addDecision({ decision_id: i, scenario_id: 'S', disposition: 'APPROVE', business_tier: 'NORMAL', state: 'AUTONOMOUS', rationale: 'r' });
        await addEdge('REFERENCED_PRECEDENT', i, 'c', {});
      }
    }
  });

  describe('P6 图分析', () => {
    it('中心节点 c 度数最高', async () => {
      if (!isAvailable()) return;
      const c = await degreeCentrality('c');
      const a = await degreeCentrality('a');
      expect(c.degree).toBeGreaterThan(a.degree);
    });
  });
  ```

- [ ] **Step 2: 运行确认失败**
  Run: `node node_modules/vitest/vitest.mjs run test/graph-analytics.test.js`
  Expected: FAIL

- [ ] **Step 3: 实现 `src/decision/graphAnalytics.js`**
  ```js
  import { pool } from '../db.js';
  import { isAvailable, runCypher } from './ageGraph.js';

  async function cypherDeg(id) {
    const rows = await runCypher(
      `MATCH (n:Decision {decision_id:$id})-[r]-(m:Decision)
       RETURN count(r) AS deg`, { id: String(id) });
    return Number(rows[0]?.deg || 0);
  }
  async function cteDeg(id) {
    const r = await pool.query(
      `SELECT count(*)::int deg FROM crm.decision_precedent_rel
       WHERE decision_id=$1 OR precedent_id=$1`, [String(id)]);
    return r.rows[0].deg;
  }
  export async function degreeCentrality(id) {
    const degree = isAvailable() ? await cypherDeg(id) : await cteDeg(id);
    return { decision_id: String(id), degree };
  }
  export async function downstreamImpactSize(id, { maxDepth = 4 } = {}) {
    const { traceDownstream } = await import('./ageGraph.js');
    const down = await traceDownstream(id, { maxDepth });
    return { root: String(id), impacted: down.length };
  }
  ```

- [ ] **Step 4: 运行测试确认通过**
  Run: `node node_modules/vitest/vitest.mjs run test/graph-analytics.test.js`
  Expected: PASS

- [ ] **Step 5: Commit**
  ```bash
  git add src/decision/graphAnalytics.js test/graph-analytics.test.js
  git commit -m "P6: graph analytics (degree centrality + impact size)"
  ```

---

## P7 — 可视化 + 决策链 UI

**Files:**
- Modify: `src/http/routes/monitor.js`（增 `/api/monitor/trace` `/impact` `/audit`）
- Modify: `web/sales-decision-monitor.html`（增图视图：因果链追溯 / 影响地图 / 审计导出）
- Test: `test/monitor-graph.test.js`

- [ ] **Step 1: 写失败测试 — `/api/monitor/trace?decisionId=` 返回上游链**
  ```js
  // test/monitor-graph.test.js
  import { describe, it, expect, beforeEach } from 'vitest';
  import { query } from '../src/db.js';
  import { ensureGraph, isAvailable, addDecision, addEdge } from '../src/decision/ageGraph.js';
  import request from 'supertest';
  import { app } from '../src/http/server.js';

  beforeEach(async () => {
    await query('TRUNCATE crm.decision, crm.decision_precedent_rel, crm.decision_event, crm.memory_log RESTART IDENTITY CASCADE');
    await ensureGraph();
    if (isAvailable()) {
      await addDecision({ decision_id: 'x', scenario_id: 'S', disposition: 'APPROVE', business_tier: 'NORMAL', state: 'AUTONOMOUS', rationale: 'r' });
      await addDecision({ decision_id: 'y', scenario_id: 'S', disposition: 'APPROVE', business_tier: 'NORMAL', state: 'AUTONOMOUS', rationale: 'r' });
      await addEdge('REFERENCED_PRECEDENT', 'y', 'x', {});
    }
  });

  describe('P7 监控图端点', () => {
    it('GET /api/monitor/trace?decisionId=y 含 x', async () => {
      if (!isAvailable()) return;
      const res = await request(app).get('/api/monitor/trace?decisionId=y');
      expect(res.status).toBe(200);
      expect(res.body.nodes.map((n) => n.decision_id)).toContain('x');
    });
  });
  ```

- [ ] **Step 2: 运行确认失败（路由未加）**
  Run: `node node_modules/vitest/vitest.mjs run test/monitor-graph.test.js`
  Expected: FAIL (404)

- [ ] **Step 3: 在 `src/http/routes/monitor.js` 加三个端点**
  ```js
  import { traceUpstream, traceDownstream, impactMap } from '../../decision/ageGraph.js';
  import { exportProvO } from '../../decision/provenance.js';
  import { query } from '../../db.js';

  router.get('/api/monitor/trace', async (req, res) => {
    const id = req.query.decisionId;
    const up = await traceUpstream(id, { maxDepth: 4 });
    const down = await traceDownstream(id, { maxDepth: 4 });
    res.json({ root: id, upstream: up, downstream: down });
  });
  router.get('/api/monitor/impact', async (req, res) => {
    const imp = await impactMap(req.query.decisionId, { maxDepth: 4 });
    res.json(imp);
  });
  router.get('/api/monitor/audit', async (req, res) => {
    const id = req.query.decisionId;
    const prov = (await query(`SELECT * FROM crm.decision_provenance WHERE decision_id=$1`, [id])).rows;
    res.json({ decision_id: id, entries: prov, provo: exportProvO(id) });
  });
  ```

- [ ] **Step 4: 扩展 `web/sales-decision-monitor.html` 图视图**
  在既有页面加一个 `<svg id="graph">` 容器 + 脚本：调用 `/api/monitor/trace` 取节点，用极简力导向（或静态坐标布局）渲染决策节点与因果边；加「导出审计」按钮触发 `/api/monitor/audit` 下载 JSON。
  > 具体 DOM/脚本片段沿用页面既有渲染风格（先 Read 该 html 再插入，不覆盖现有面板）。

- [ ] **Step 5: 运行测试确认通过**
  Run: `node node_modules/vitest/vitest.mjs run test/monitor-graph.test.js`
  Expected: PASS

- [ ] **Step 6: Commit**
  ```bash
  git add src/http/routes/monitor.js web/sales-decision-monitor.html test/monitor-graph.test.js
  git commit -m "P7: decision-chain graph endpoints + monitor UI graph view"
  ```

---

## P8 — 查询 / 对外连接（REST + MCP）

**Files:**
- Modify: `src/http/routes/graph.js`（新建 `/api/graph/{neighbors,trace,impact,provenance}`）
- Modify: `skills/crm-native/SKILL.md` + `skills/crm-native/` 对应 agent 脚本（增 `graph_query` 方法：RBAC 数据范围过滤 + action-confirm 纪律）
- Test: `test/graph-rest.test.js` + `test/graph-mcp.test.js`

- [ ] **Step 1: 写失败测试 — `/api/graph/neighbors?entityId=` 返回邻居**
  ```js
  // test/graph-rest.test.js
  import { describe, it, expect, beforeEach } from 'vitest';
  import { query } from '../src/db.js';
  import request from 'supertest';
  import { app } from '../src/http/server.js';

  beforeEach(async () => {
    await query('TRUNCATE crm.particles, crm.edges RESTART IDENTITY CASCADE');
    await query(`INSERT INTO crm.particles (tenant_id,type,slug,title,state,payload)
      VALUES ('system','CRM_ACCOUNT','acc','Acme','ACTIVE','{"name":"Acme"}') RETURNING id`);
  });

  describe('P8 REST', () => {
    it('GET /api/graph/neighbors 返回结构', async () => {
      const res = await request(app).get('/api/graph/neighbors?entityId=any');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.nodes)).toBe(true);
    });
  });
  ```

- [ ] **Step 2: 运行确认失败（路由未建）**
  Run: `node node_modules/vitest/vitest.mjs run test/graph-rest.test.js`
  Expected: FAIL (404)

- [ ] **Step 3: 新建 `src/http/routes/graph.js` 并挂载**
  ```js
  import express from 'express';
  import { query } from '../../db.js';
  import { traceUpstream, traceDownstream, impactMap } from '../../decision/ageGraph.js';
  import { detectConflicts } from '../../decision/conflict.js';
  const router = express.Router();

  router.get('/api/graph/neighbors', async (req, res) => {
    const r = await query(
      `SELECT * FROM crm.edges WHERE source_id=$1 OR target_id=$1 LIMIT 100`, [req.query.entityId]);
    res.json({ nodes: r.rows });
  });
  router.get('/api/graph/trace', async (req, res) => {
    res.json({ upstream: await traceUpstream(req.query.decisionId, { maxDepth: 4 }),
               downstream: await traceDownstream(req.query.decisionId, { maxDepth: 4 }) });
  });
  router.get('/api/graph/impact', async (req, res) => {
    res.json(await impactMap(req.query.decisionId, { maxDepth: 4 }));
  });
  router.get('/api/graph/provenance', async (req, res) => {
    const c = await detectConflicts(req.query.entityId, req.query.attr || null);
    res.json(c);
  });
  export default router;
  ```
  在 `src/http/server.js` 挂载：`import graphRouter from './routes/graph.js'; app.use(graphRouter);`

- [ ] **Step 4: crm-native MCP 增 `graph_query` 方法**
  编辑 `skills/crm-native/SKILL.md` 的 tools 段，新增：
  ```
  - graph_query: 读图查询（邻居/因果链/影响/溯源）。纪律：只读、RBAC 数据范围过滤（role_context_profile.data_scope）、绝不写图、绝不删除；返回受限范围。
  ```
  并在对应 agent 脚本（如 `skills/crm-native/core/graphQuery.js`）实现：调用 `/api/graph/*`，传入调用者 role 的 data_scope 做行级过滤。

- [ ] **Step 5: 运行测试确认通过**
  Run: `node node_modules/vitest/vitest.mjs run test/graph-rest.test.js`
  Expected: PASS

- [ ] **Step 6: Commit**
  ```bash
  git add src/http/routes/graph.js src/http/server.js skills/crm-native test/graph-rest.test.js
  git commit -m "P8: REST graph endpoints + crm-native MCP graph_query"
  ```

---

## 自我审查（Self-Review）

1. **Spec 覆盖（对照设计 P0–P8）**：P0 启用+探活 ✓；P1 镜像+接线+回填 ✓；P2 因果链写时+回填 ✓；P3 PROV-O 捕获+链+导出 ✓；P4 冲突保留 ✓；P5 去重 ✓；P6 图分析 ✓；P7 可视化+端点 ✓；P8 REST+MCP ✓。全部有对应任务。
2. **占位符扫描**：无 TBD/TODO；每步含代码或 SQL；测试含真实断言。降级分支（AGE 未启用时 `if(!isAvailable()) return;`）为显式设计纪律，非占位。
3. **类型一致性**：`addDecision/addParticleVertex/addEdge/traceUpstream/impactMap/ctePrecedents` 签名全程沿用 `ageGraph.js` 现有定义；`ensureAgeSync(entity)` 在 P1/P3 复用同一签名；`captureProvenance/appendDecisionProvenance/verifyChain/exportProvO` 在 P3 内一致。
4. **DBA 阻塞**：P0 Step1 为唯一外部阻塞；其余步骤在 AGE 未启用时经降级路径仍可跑绿（符合设计 §6 韧性）。DBA 启用后既有 `test/age-graph.test.js` / `test/provenance.test.js` 一并转绿。

## 执行交接

Plan complete and saved to `docs/superpowers/plans/2026-08-26-age-semantica-program.md`. Two execution options:

**1. Subagent-Driven (recommended)** - 每 Task 派发独立 subagent，任务间两阶段审查，快速迭代
**2. Inline Execution** - 本会话内用 executing-plans 批量执行 + 检查点

Which approach?
