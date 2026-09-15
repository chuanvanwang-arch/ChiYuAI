# 多智能体可信研判与证据链溯源 · 端到端原型实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: 使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐 Task 执行本计划。步骤使用 `- [ ]` 复选框跟踪。

**Goal:** 在既有 AI 原生底座上新增「研判域」模块，交付可实测的端到端原型：多角色智能体独立研判 → 结论→证据→来源三级溯源 → 三维置信度量化 → 冲突识别与消解 → 推理树可视化 → 防篡改审计链，并通过 MCP 对外暴露。

**Architecture:** 复用既有底座五件套（`decision/conflict.js` 五策略冲突消解 + 信源可信度、`agent/glassBox.js` 可解释推理链、`decision/decisionRepo.js` 决策第 0 闸、`page/reasoningSteps.js` 状态判定表、`mcp/tools.js` Action→MCP 暴露），新增 `src/research/` 研判域。**零改动既有业务域模型、不新增 CRM 粒子类型**（遵守 2026-09-08 已批设计 §10 硬约束）。

**Tech Stack:** Node.js ESM · Express · PostgreSQL(pg) · vitest · @modelcontextprotocol/sdk · 既有 LLM 封装（`llm/client.js`）

---

## 0. 能力盘点：复用矩阵与真缺口

| 赛题要求 | 既有资产（直接复用） | 真缺口（本计划新建） |
| :-- | :-- | :-- |
| ① 多智能体协同研判（≥2 角色 + 协调/仲裁） | `src/agent/agents.js` 编排、`events/bus.js` 事件 | 角色化研判编排 + 仲裁汇总 |
| ② 证据链自动构建（结论→证据→来源，下钻段落） | `ontology/ageSync.js` 图同步、`knowledge/embed.js` 向量 | 三级链表结构 + `drillDown` |
| ③ 结论置信度量化（信源可信度/证据一致性/推理链完整性） | `decision/conflict.js:68` `source_credibility` 列、`decision/confidence.js` 纯函数范式 | 三维置信度内核 |
| ④ 冲突识别与消解（辩论/仲裁/证据加权 + 保留少数意见） | `decision/conflict.js`：`detectConflicts` / 五策略 / `keep disagreement` 不覆盖 | 结论级冲突判定 + `debate` 策略 + 少数意见落库 |
| ⑤ 推理轨迹可视化（推理树/证据图 + 人工修改后重算） | `agent/glassBox.js`（judge/trace/why）、`page/reasoningSteps.js`（四态） | 推理树组装 + 可视化页 |
| 加分：相关/因果区分与证据等级 | `decision/decisionTrace.js`（因果链 + 每跳 ×0.9 衰减）、`decision/ageGraph.js` | 因果/相关标注规则 |
| 加分：研判日志防篡改（哈希链/签名） | 无 | 哈希链审计模块 |
| 加分：AIP/MCP 接入第三方智能体 | `mcp/tools.js` `buildMcpTools`（唯一暴露咽喉） | 研判族 Action 注册 |

**结论：8 项要求中 5 项可直接复用底座，3 项为新增模块级工作。**

---

## 1. 文件结构

**新建：**

| 文件 | 职责 |
| :-- | :-- |
| `db/migration-research.sql` | 研判域 7 张表 DDL |
| `src/research/schema.js` | 幂等建表（照 `decision/conflict.js:8` `ensureAssertionsSchema` 范式） |
| `src/research/confidence.js` | 三维置信度纯函数内核（零副作用、不触 DB） |
| `src/research/evidenceChain.js` | 证据链构建 + 三级下钻 |
| `src/research/conflict.js` | 结论级冲突识别、`debate` 策略、少数意见保留 |
| `src/research/orchestrator.js` | 多角色独立研判编排 + 仲裁汇总 |
| `src/research/reasoningTree.js` | 推理树组装（复用 glassBox 语义） |
| `src/research/auditChain.js` | 防篡改哈希链 |
| `src/action/researchActions.js` | 研判族 Action 注册（→ MCP 暴露） |
| `src/portal/researchRender.js` | 研判页渲染（推理树/证据图） |
| `scripts/research-e2e.mjs` | 端到端实测（原型实测 70% 的验收物） |

**修改：** `src/mcp/tools.js:50`（seed 时注册 research 族）、门户菜单注册文件（实施时按既有 `src/portal/layoutMenu.js` 模式接线）。

**测试：** `test/research-*.test.js`（纯函数测试不触 DB；仓储层测试需 DB）。

---

### Task 1: 研判域表结构与幂等建表

**Files:**
- Create: `db/migration-research.sql`
- Create: `src/research/schema.js`
- Test: `test/research-schema.test.js`

- [ ] **Step 1: 写失败测试**

```javascript
// test/research-schema.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import { query } from '../src/db.js';
import { ensureResearchSchema } from '../src/research/schema.js';

describe('research schema', () => {
  beforeAll(async () => { await ensureResearchSchema(); });

  it('建出 7 张研判域表', async () => {
    const r = await query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema='crm' AND table_name LIKE 'research_%' ORDER BY table_name`);
    const names = r.rows.map((x) => x.table_name);
    expect(names).toEqual([
      'research_audit_log', 'research_claim', 'research_claim_evidence',
      'research_evidence', 'research_opinion', 'research_source', 'research_topic',
    ]);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/research-schema.test.js`
Expected: FAIL — `Cannot find module '../src/research/schema.js'`

- [ ] **Step 3: 写 DDL**

```sql
-- db/migration-research.sql — 研判域表结构（开源情报专题）
CREATE TABLE IF NOT EXISTS crm.research_topic (
  id BIGSERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'system',
  title TEXT NOT NULL,
  question TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS crm.research_source (
  id BIGSERIAL PRIMARY KEY,
  topic_id BIGINT NOT NULL REFERENCES crm.research_topic(id),
  doc_title TEXT NOT NULL,
  url TEXT,
  published_at TIMESTAMPTZ,
  credibility REAL NOT NULL DEFAULT 0.5,
  excerpt TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS crm.research_evidence (
  id BIGSERIAL PRIMARY KEY,
  topic_id BIGINT NOT NULL REFERENCES crm.research_topic(id),
  source_id BIGINT NOT NULL REFERENCES crm.research_source(id),
  excerpt TEXT NOT NULL,
  anchor TEXT,
  stance TEXT NOT NULL DEFAULT 'neutral',
  weight REAL NOT NULL DEFAULT 1.0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS crm.research_claim (
  id BIGSERIAL PRIMARY KEY,
  topic_id BIGINT NOT NULL REFERENCES crm.research_topic(id),
  role TEXT NOT NULL,
  statement TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.5,
  confidence_detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'draft',
  decision_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS crm.research_claim_evidence (
  claim_id BIGINT NOT NULL REFERENCES crm.research_claim(id),
  evidence_id BIGINT NOT NULL REFERENCES crm.research_evidence(id),
  relation TEXT NOT NULL DEFAULT 'support',
  PRIMARY KEY (claim_id, evidence_id)
);

CREATE TABLE IF NOT EXISTS crm.research_opinion (
  id BIGSERIAL PRIMARY KEY,
  topic_id BIGINT NOT NULL REFERENCES crm.research_topic(id),
  claim_id BIGINT REFERENCES crm.research_claim(id),
  role TEXT NOT NULL,
  verdict TEXT NOT NULL,
  rationale TEXT NOT NULL,
  is_minority BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS crm.research_audit_log (
  id BIGSERIAL PRIMARY KEY,
  topic_id BIGINT NOT NULL REFERENCES crm.research_topic(id),
  seq INT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (topic_id, seq)
);
```

- [ ] **Step 4: 写幂等建表模块**

```javascript
// src/research/schema.js — 研判域幂等建表（照 decision/conflict.js ensureAssertionsSchema 范式）
import { queryWrite } from '../db.js';

const DDL = [
  `CREATE TABLE IF NOT EXISTS crm.research_topic (
     id BIGSERIAL PRIMARY KEY, tenant_id TEXT NOT NULL DEFAULT 'system',
     title TEXT NOT NULL, question TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'draft',
     created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS crm.research_source (
     id BIGSERIAL PRIMARY KEY,
     topic_id BIGINT NOT NULL REFERENCES crm.research_topic(id),
     doc_title TEXT NOT NULL, url TEXT, published_at TIMESTAMPTZ,
     credibility REAL NOT NULL DEFAULT 0.5, excerpt TEXT NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS crm.research_evidence (
     id BIGSERIAL PRIMARY KEY,
     topic_id BIGINT NOT NULL REFERENCES crm.research_topic(id),
     source_id BIGINT NOT NULL REFERENCES crm.research_source(id),
     excerpt TEXT NOT NULL, anchor TEXT,
     stance TEXT NOT NULL DEFAULT 'neutral', weight REAL NOT NULL DEFAULT 1.0,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS crm.research_claim (
     id BIGSERIAL PRIMARY KEY,
     topic_id BIGINT NOT NULL REFERENCES crm.research_topic(id),
     role TEXT NOT NULL, statement TEXT NOT NULL,
     confidence REAL NOT NULL DEFAULT 0.5,
     confidence_detail JSONB NOT NULL DEFAULT '{}'::jsonb,
     status TEXT NOT NULL DEFAULT 'draft', decision_id TEXT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS crm.research_claim_evidence (
     claim_id BIGINT NOT NULL REFERENCES crm.research_claim(id),
     evidence_id BIGINT NOT NULL REFERENCES crm.research_evidence(id),
     relation TEXT NOT NULL DEFAULT 'support',
     PRIMARY KEY (claim_id, evidence_id))`,
  `CREATE TABLE IF NOT EXISTS crm.research_opinion (
     id BIGSERIAL PRIMARY KEY,
     topic_id BIGINT NOT NULL REFERENCES crm.research_topic(id),
     claim_id BIGINT REFERENCES crm.research_claim(id),
     role TEXT NOT NULL, verdict TEXT NOT NULL, rationale TEXT NOT NULL,
     is_minority BOOLEAN NOT NULL DEFAULT false,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS crm.research_audit_log (
     id BIGSERIAL PRIMARY KEY,
     topic_id BIGINT NOT NULL REFERENCES crm.research_topic(id),
     seq INT NOT NULL, prev_hash TEXT NOT NULL, hash TEXT NOT NULL,
     payload JSONB NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     UNIQUE (topic_id, seq))`,
];

export async function ensureResearchSchema() {
  for (const sql of DDL) await queryWrite(sql);
}
```

- [ ] **Step 5: 运行测试并提交**

Run: `npx vitest run test/research-schema.test.js`
Expected: PASS

```bash
git add db/migration-research.sql src/research/schema.js test/research-schema.test.js
git commit -m "feat(research): 研判域 7 张表结构与幂等建表"
```

---

### Task 2: 三维置信度内核（纯函数）

**Files:**
- Create: `src/research/confidence.js`
- Test: `test/research-confidence.test.js`

- [ ] **Step 1: 写失败测试**

```javascript
// test/research-confidence.test.js
import { describe, it, expect } from 'vitest';
import { scoreClaimConfidence } from '../src/research/confidence.js';

describe('三维置信度', () => {
  it('无证据 → 置信度 0，并报缺证据（不脑补）', () => {
    const r = scoreClaimConfidence({ evidence: [], chainCompleteness: 0 });
    expect(r.confidence).toBe(0);
    expect(r.detail.evidence_count).toBe(0);
    expect(r.detail.reasons).toContain('无证据支撑');
  });

  it('高可信源 + 证据一致 + 链条完整 → 高置信度', () => {
    const r = scoreClaimConfidence({
      evidence: [
        { credibility: 0.9, stance: 'support', weight: 1 },
        { credibility: 0.85, stance: 'support', weight: 1 },
      ],
      chainCompleteness: 1,
    });
    expect(r.confidence).toBeGreaterThan(0.8);
    expect(r.detail.consistency).toBe(1);
  });

  it('证据存在分歧 → 一致性下降，置信度低于一致情形', () => {
    const consistent = scoreClaimConfidence({
      evidence: [{ credibility: 0.9, stance: 'support', weight: 1 }],
      chainCompleteness: 1,
    });
    const split = scoreClaimConfidence({
      evidence: [
        { credibility: 0.9, stance: 'support', weight: 1 },
        { credibility: 0.9, stance: 'oppose', weight: 1 },
      ],
      chainCompleteness: 1,
    });
    expect(split.detail.consistency).toBeLessThan(consistent.detail.consistency);
    expect(split.confidence).toBeLessThan(consistent.confidence);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/research-confidence.test.js`
Expected: FAIL — `Cannot find module '../src/research/confidence.js'`

- [ ] **Step 3: 写实现**

```javascript
// src/research/confidence.js — 三维置信度内核（纯函数，零副作用，不触 DB）
// 铁律（照 agent/glassBox.js 范式）：① 纯函数零副作用；② 脏数据过滤；③ 无证据不抛错、明确报缺；
//   ④ 权重可配置，禁在签名外硬编码阈值。
const W1 = 0.4; // 信源可信度
const W2 = 0.4; // 证据数量与一致性
const W3 = 0.2; // 推理链完整性

const clamp01 = (x) => Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0));

export function scoreClaimConfidence({ evidence = [], chainCompleteness = 0, weights = {} } = {}) {
  const w1 = weights.source ?? W1, w2 = weights.evidence ?? W2, w3 = weights.chain ?? W3;
  const rows = (Array.isArray(evidence) ? evidence : []).filter((e) => e && typeof e === 'object');
  const count = rows.length;
  if (count === 0) {
    return {
      confidence: 0,
      detail: { source_credibility: 0, evidence_count: 0, consistency: 0,
        chain_completeness: clamp01(chainCompleteness), reasons: ['无证据支撑'] },
    };
  }
  const totalWeight = rows.reduce((s, e) => s + (Number(e.weight) || 1), 0) || 1;
  const sourceCredibility = clamp01(
    rows.reduce((s, e) => s + clamp01(e.credibility) * (Number(e.weight) || 1), 0) / totalWeight);

  const support = rows.filter((e) => e.stance === 'support').length;
  const oppose = rows.filter((e) => e.stance === 'oppose').length;
  const decided = support + oppose;
  // 一致性：全体立场同向 → 1；正反各半 → 0；无明确立场 → 中性 0.5
  const consistency = decided === 0 ? 0.5
    : clamp01((Math.max(support, oppose) / decided) * 2 - 1);

  const chain = clamp01(chainCompleteness);
  const raw = w1 * sourceCredibility + w2 * consistency + w3 * chain;
  const confidence = Number(clamp01(raw).toFixed(4));

  const reasons = [];
  reasons.push(`信源可信度 ${sourceCredibility.toFixed(2)}（${count} 条证据）`);
  reasons.push(`证据一致性 ${consistency.toFixed(2)}（支持 ${support} / 反对 ${oppose}）`);
  reasons.push(`推理链完整性 ${chain.toFixed(2)}`);

  return {
    confidence,
    detail: { source_credibility: Number(sourceCredibility.toFixed(4)), evidence_count: count,
      consistency: Number(consistency.toFixed(4)), chain_completeness: chain, reasons },
  };
}
```

- [ ] **Step 4: 运行测试并提交**

Run: `npx vitest run test/research-confidence.test.js`
Expected: PASS（3 个用例）

```bash
git add src/research/confidence.js test/research-confidence.test.js
git commit -m "feat(research): 三维置信度内核（信源×一致性×推理链）"
```

---

### Task 3: 证据链构建与三级下钻

**Files:**
- Create: `src/research/evidenceChain.js`
- Test: `test/research-evidence-chain.test.js`

- [ ] **Step 1: 写失败测试**

```javascript
// test/research-evidence-chain.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import { query, queryWrite } from '../src/db.js';
import { ensureResearchSchema } from '../src/research/schema.js';
import { createTopic, addSource, addEvidence, addClaim,
  linkClaimEvidence, buildEvidenceChain, drillDown } from '../src/research/evidenceChain.js';

describe('证据链三级溯源', () => {
  let topicId, claimId, evidenceId;
  beforeAll(async () => {
    await ensureResearchSchema();
    topicId = await createTopic({ title: '测试专题', question: 'X 是否导致 Y？' });
    const sourceId = await addSource({ topicId, docTitle: '白皮书', url: 'https://example.com/a',
      credibility: 0.8, excerpt: '原始段落：X 与 Y 存在显著关联。' });
    evidenceId = await addEvidence({ topicId, sourceId, excerpt: 'X 与 Y 显著关联',
      anchor: '§2.1', stance: 'support' });
    claimId = await addClaim({ topicId, role: '技术视角', statement: 'X 导致 Y' });
    await linkClaimEvidence(claimId, evidenceId, 'support');
  });

  it('链可下钻到来源原始段落', async () => {
    const chain = await buildEvidenceChain(claimId);
    expect(chain.claim.id).toBe(claimId);
    expect(chain.evidence.length).toBe(1);
    expect(chain.sources[0].doc_title).toBe('白皮书');
    const drill = await drillDown(evidenceId);
    expect(drill.source.excerpt).toContain('原始段落');
    expect(drill.evidence.anchor).toBe('§2.1');
  });

  it('无证据结论不报错，返回空链', async () => {
    const orphan = await addClaim({ topicId, role: '中立视角', statement: '暂无定论' });
    const chain = await buildEvidenceChain(orphan);
    expect(chain.evidence).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/research-evidence-chain.test.js`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 写实现**

```javascript
// src/research/evidenceChain.js — 证据链：「结论 → 证据 → 来源」三级溯源，可下钻至原始段落
import { query, queryWrite } from '../db.js';

export async function createTopic({ tenantId = 'system', title, question }) {
  const r = await queryWrite(
    `INSERT INTO crm.research_topic (tenant_id, title, question) VALUES ($1,$2,$3) RETURNING id`,
    [tenantId, title, question]);
  return r.rows[0].id;
}

export async function addSource({ topicId, docTitle, url = null, publishedAt = null,
  credibility = 0.5, excerpt }) {
  const r = await queryWrite(
    `INSERT INTO crm.research_source (topic_id, doc_title, url, published_at, credibility, excerpt)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [topicId, docTitle, url, publishedAt, credibility, excerpt]);
  return r.rows[0].id;
}

export async function addEvidence({ topicId, sourceId, excerpt, anchor = null,
  stance = 'neutral', weight = 1.0 }) {
  const r = await queryWrite(
    `INSERT INTO crm.research_evidence (topic_id, source_id, excerpt, anchor, stance, weight)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [topicId, sourceId, excerpt, anchor, stance, weight]);
  return r.rows[0].id;
}

export async function addClaim({ topicId, role, statement, confidence = 0.5,
  confidenceDetail = {}, status = 'draft' }) {
  const r = await queryWrite(
    `INSERT INTO crm.research_claim (topic_id, role, statement, confidence, confidence_detail, status)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [topicId, role, statement, confidence, JSON.stringify(confidenceDetail), status]);
  return r.rows[0].id;
}

export async function linkClaimEvidence(claimId, evidenceId, relation = 'support') {
  await queryWrite(
    `INSERT INTO crm.research_claim_evidence (claim_id, evidence_id, relation)
     VALUES ($1,$2,$3) ON CONFLICT (claim_id, evidence_id) DO UPDATE SET relation = EXCLUDED.relation`,
    [claimId, evidenceId, relation]);
}

// 三级链：结论 → 证据[] → 来源[]
export async function buildEvidenceChain(claimId) {
  const claim = (await query(`SELECT * FROM crm.research_claim WHERE id=$1`, [claimId])).rows[0] || null;
  if (!claim) return { claim: null, evidence: [], sources: [] };
  const ev = (await query(
    `SELECT e.*, ce.relation FROM crm.research_claim_evidence ce
     JOIN crm.research_evidence e ON e.id = ce.evidence_id
     WHERE ce.claim_id=$1 AND ce.relation <> 'excluded' ORDER BY e.id`, [claimId])).rows;
  const sourceIds = [...new Set(ev.map((x) => x.source_id))];
  const sources = sourceIds.length
    ? (await query(`SELECT * FROM crm.research_source WHERE id = ANY($1::bigint[]) ORDER BY id`, [sourceIds])).rows
    : [];
  return { claim, evidence: ev, sources };
}

// 下钻：证据 → 其来源的原始段落
export async function drillDown(evidenceId) {
  const evidence = (await query(`SELECT * FROM crm.research_evidence WHERE id=$1`, [evidenceId])).rows[0] || null;
  if (!evidence) return { evidence: null, source: null };
  const source = (await query(`SELECT * FROM crm.research_source WHERE id=$1`, [evidence.source_id])).rows[0] || null;
  return { evidence, source };
}

// 专题全链（供推理树与前端使用）
export async function buildTopicChain(topicId) {
  const claims = (await query(
    `SELECT * FROM crm.research_claim WHERE topic_id=$1 ORDER BY id`, [topicId])).rows;
  const chains = [];
  for (const c of claims) chains.push(await buildEvidenceChain(c.id));
  return { topicId, chains };
}
```

- [ ] **Step 4: 运行测试并提交**

Run: `npx vitest run test/research-evidence-chain.test.js`
Expected: PASS（2 个用例）

```bash
git add src/research/evidenceChain.js test/research-evidence-chain.test.js
git commit -m "feat(research): 结论-证据-来源三级链与下钻"
```

---

### Task 4: 冲突识别与消解（复用五策略 + 新增辩论 + 保留少数意见）

**Files:**
- Create: `src/research/conflict.js`
- Test: `test/research-conflict.test.js`
- 参考（复用，不修改）：`src/decision/conflict.js:86` `resolveConflict`、`:41` `detectConflicts`

- [ ] **Step 1: 写失败测试**

```javascript
// test/research-conflict.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import { ensureResearchSchema } from '../src/research/schema.js';
import { createTopic, addSource, addEvidence, addClaim, linkClaimEvidence } from '../src/research/evidenceChain.js';
import { detectClaimConflicts, resolveClaimConflict, listMinorityOpinions } from '../src/research/conflict.js';

describe('结论冲突识别与消解', () => {
  let topicId, claimA, claimB, claimC;
  beforeAll(async () => {
    await ensureResearchSchema();
    topicId = await createTopic({ title: '冲突专题', question: 'X 是否导致 Y？' });
    const srcHi = await addSource({ topicId, docTitle: '权威报告', credibility: 0.9, excerpt: 'X 导致 Y' });
    const srcLo = await addSource({ topicId, docTitle: '自媒体', credibility: 0.3, excerpt: 'X 与 Y 无关' });
    const evHi = await addEvidence({ topicId, sourceId: srcHi, excerpt: 'X 导致 Y', stance: 'support' });
    const evLo = await addEvidence({ topicId, sourceId: srcLo, excerpt: 'X 与 Y 无关', stance: 'oppose' });
    claimA = await addClaim({ topicId, role: '技术视角', statement: 'X 导致 Y' });
    claimB = await addClaim({ topicId, role: '风险视角', statement: 'X 与 Y 无关' });
    claimC = await addClaim({ topicId, role: '中立视角', statement: '现有证据不足以判定' });
    await linkClaimEvidence(claimA, evHi, 'support');
    await linkClaimEvidence(claimB, evLo, 'support');
  });

  it('识别出冲突清单（含角色与矛盾结论）', async () => {
    const list = await detectClaimConflicts(topicId);
    expect(list.length).toBeGreaterThan(0);
    expect(list[0].a.role).toBeDefined();
    expect(list[0].b.role).toBeDefined();
  });

  it('证据加权消解 → 高可信源一侧胜出，且失败方作为少数意见保留', async () => {
    const r = await resolveClaimConflict(topicId, { strategy: 'credibility_weighted' });
    expect(r.winner.role).toBe('技术视角');
    const minorities = await listMinorityOpinions(topicId);
    expect(minorities.some((m) => m.role === '风险视角')).toBe(true);
  });

  it('未知策略必须抛错（不静默降级）', async () => {
    await expect(resolveClaimConflict(topicId, { strategy: 'nonsense' })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/research-conflict.test.js`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 写实现**

```javascript
// src/research/conflict.js — 结论级冲突：识别 → 消解 → 保留分歧（绝不物理删除）
// 复用 decision/conflict.js 的设计纪律：裁决仅置状态、保留全部意见（keep disagreement）。
// 策略：credibility_weighted（证据加权）/ debate（辩论仲裁）/ human_arbitration（人工，走决策第0闸）
import { query, queryWrite } from '../db.js';
import { scoreClaimConfidence } from './confidence.js';
import { buildEvidenceChain } from './evidenceChain.js';

const NEGATION = ['不', '无', '非', '未', '否认'];

// 轻量矛盾判定：陈述互否（一含否定词另一不含）或立场指向相反
function isContradictory(a, b) {
  const sa = String(a.statement || ''), sb = String(b.statement || '');
  const na = NEGATION.some((w) => sa.includes(w));
  const nb = NEGATION.some((w) => sb.includes(w));
  if (na !== nb) {
    const strip = (s) => s.replace(/[不无非未否认]/g, '');
    const core = strip(sa);
    return core.length > 2 && strip(sb).includes(core.slice(0, 4));
  }
  return false;
}

// 冲突清单：同一专题内两两比对
export async function detectClaimConflicts(topicId) {
  const claims = (await query(
    `SELECT * FROM crm.research_claim WHERE topic_id=$1 ORDER BY id`, [topicId])).rows;
  const out = [];
  for (let i = 0; i < claims.length; i++) {
    for (let j = i + 1; j < claims.length; j++) {
      if (isContradictory(claims[i], claims[j])) {
        out.push({ topic_id: Number(topicId), a: claims[i], b: claims[j], type: 'contradiction' });
      }
    }
  }
  return out;
}

// 结论置信度（复用三维内核，证据取自三级链）
async function claimScore(claim) {
  const chain = await buildEvidenceChain(claim.id);
  const evidence = chain.evidence.map((e) => {
    const src = chain.sources.find((s) => s.id === e.source_id) || {};
    return { credibility: src.credibility ?? 0.5, stance: e.stance, weight: e.weight };
  });
  const chainCompleteness = chain.evidence.length && chain.sources.length ? 1 : 0;
  return scoreClaimConfidence({ evidence, chainCompleteness });
}

async function keepMinority(topicId, claim, verdict, rationale) {
  await queryWrite(
    `INSERT INTO crm.research_opinion (topic_id, claim_id, role, verdict, rationale, is_minority)
     VALUES ($1,$2,$3,$4,$5,true)`, [topicId, claim.id, claim.role, verdict, rationale]);
}

export async function listMinorityOpinions(topicId) {
  return (await query(
    `SELECT * FROM crm.research_opinion WHERE topic_id=$1 AND is_minority=true ORDER BY id`,
    [topicId])).rows;
}

/**
 * 消解冲突。strategy: credibility_weighted | debate | human_arbitration
 * 纪律：败方不删除，写入 research_opinion(is_minority=true)。
 */
export async function resolveClaimConflict(topicId, { strategy, produceDecision = null, judge = null } = {}) {
  const conflicts = await detectClaimConflicts(topicId);
  if (conflicts.length === 0) return { strategy, resolved: [], conflicts: [] };
  const results = [];

  for (const c of conflicts) {
    const scoreA = await claimScore(c.a);
    const scoreB = await claimScore(c.b);
    let winner = null, loser = null, rationale = '';

    if (strategy === 'credibility_weighted') {
      winner = scoreA.confidence >= scoreB.confidence ? c.a : c.b;
      loser = winner === c.a ? c.b : c.a;
      rationale = `证据加权：${winner.role} ${(winner === c.a ? scoreA : scoreB).confidence} > ${loser.role} ${(loser === c.a ? scoreA : scoreB).confidence}`;
    } else if (strategy === 'debate') {
      if (typeof judge !== 'function') throw new Error('debate 策略需要注入 judge（仲裁智能体）');
      const verdict = await judge({ claim_a: c.a, claim_b: c.b, score_a: scoreA, score_b: scoreB });
      winner = verdict.winner_role === c.a.role ? c.a : c.b;
      loser = winner === c.a ? c.b : c.a;
      rationale = `辩论仲裁：${verdict.rationale || '仲裁结论'}`;
    } else if (strategy === 'human_arbitration') {
      if (typeof produceDecision !== 'function') throw new Error('human_arbitration 需要 produceDecision（决策第0闸）');
      const decision = await produceDecision({
        scenario_id: 'RESEARCH_CLAIM_CONFLICT',
        disposition: 'APPROVED',
        trigger_context: { conflict: { topic_id: Number(topicId), a: c.a.id, b: c.b.id } },
        conditions_evaluated: [{ name: 'claim_conflict', met: true }],
        involved_entities: [`research_topic:${topicId}`],
        rationale: `研判结论冲突人工裁决 topic=${topicId}`,
      });
      const picked = scoreA.confidence >= scoreB.confidence ? c.a : c.b;
      winner = picked; loser = winner === c.a ? c.b : c.a;
      rationale = `人工裁决（decision_id=${decision.decision_id}）`;
    } else {
      throw new Error(`未知冲突策略: ${strategy}`);
    }

    await queryWrite(`UPDATE crm.research_claim SET status='confirmed' WHERE id=$1`, [winner.id]);
    await queryWrite(`UPDATE crm.research_claim SET status='rejected' WHERE id=$1`, [loser.id]);
    await keepMinority(topicId, loser, 'dissent', rationale);
    results.push({ winner: { id: winner.id, role: winner.role }, loser: { id: loser.id, role: loser.role }, rationale });
  }
  return { strategy, resolved: results, conflicts };
}
```

- [ ] **Step 4: 运行测试并提交**

Run: `npx vitest run test/research-conflict.test.js`
Expected: PASS（3 个用例）

```bash
git add src/research/conflict.js test/research-conflict.test.js
git commit -m "feat(research): 结论冲突识别、证据加权/辩论/人工消解与少数意见保留"
```

---

### Task 5: 多角色独立研判编排（≥2 角色 + 仲裁汇总）

**Files:**
- Create: `src/research/orchestrator.js`
- Test: `test/research-orchestrator.test.js`
- 参考（复用）：`src/llm/client.js:110` `getLlmJson`、`src/events/bus.js:17` `emit`

- [ ] **Step 1: 写失败测试（LLM 打桩，不触真实模型）**

```javascript
// test/research-orchestrator.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import { ensureResearchSchema } from '../src/research/schema.js';
import { createTopic, addSource, buildEvidenceChain } from '../src/research/evidenceChain.js';
import { runMultiRoleResearch, arbitrate } from '../src/research/orchestrator.js';

// 打桩 llmFactory：返回可调用的 llmJson(systemPrompt, userPrompt, opts)
const stubFactory = async () => async () => ({
  statement: 'X 与 Y 存在关联',
  evidences: [{ source_index: 1, excerpt: '原始片段', stance: 'support' }],
});

describe('多角色研判编排', () => {
  let topicId, srcId;
  beforeAll(async () => {
    await ensureResearchSchema();
    topicId = await createTopic({ title: '多角色专题', question: 'X 是否导致 Y？' });
    srcId = await addSource({ topicId, docTitle: '来源A', credibility: 0.8, excerpt: '原始段落' });
  });

  it('至少 2 个角色各自产出结论，并各自挂上证据', async () => {
    const out = await runMultiRoleResearch({
      topicId, topicTitle: '多角色专题', question: 'X 是否导致 Y？',
      roles: ['技术视角', '风险视角'],
      sources: [{ id: srcId, doc_title: '来源A', credibility: 0.8, excerpt: '原始段落' }],
      llmFactory: stubFactory,
    });
    expect(out.length).toBe(2);
    const chain = await buildEvidenceChain(out[0].claimId);
    expect(chain.evidence.length).toBeGreaterThan(0);
    expect(out[0].confidence).toBeGreaterThan(0);
  });

  it('LLM 未配置时明确抛错（不静默产出假结论）', async () => {
    await expect(runMultiRoleResearch({
      topicId, topicTitle: 't', question: 'q', roles: ['技术视角'],
      sources: [], llmFactory: async () => null,
    })).rejects.toThrow(/LLM/);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/research-orchestrator.test.js`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 写实现**

```javascript
// src/research/orchestrator.js — 多角色独立研判 → 仲裁汇总
import { getLlmJson } from '../llm/client.js';
import { emit } from '../events/bus.js';
import { queryWrite } from '../db.js';
import { scoreClaimConfidence } from './confidence.js';
import { addClaim, addEvidence, linkClaimEvidence, buildEvidenceChain } from './evidenceChain.js';
import { detectClaimConflicts, resolveClaimConflict } from './conflict.js';

export const DEFAULT_ROLES = ['技术视角', '风险视角', '中立视角'];

// 单角色独立研判（llmJson 可注入打桩）
async function researchByRole({ role, topicTitle, question, sources, llmJson }) {
  const evidenceText = sources
    .map((s, i) => `[${i + 1}] ${s.doc_title}（可信度 ${s.credibility}）：${s.excerpt}`).join('\n');
  const out = await llmJson(
    '你是开源情报研判专家。请基于给定来源独立给出结论，并逐条列出支撑证据。只输出 JSON，不要解释。',
    `视角角色：${role}\n专题：${topicTitle}\n问题：${question}\n来源：\n${evidenceText}\n` +
    '输出 JSON：{"statement":"结论一句话","evidences":[{"source_index":1,"excerpt":"原文片段","stance":"support|oppose|neutral"}]}',
    { max_tokens: 800 },
  );
  return out || { statement: `（${role} 未产出结论）`, evidences: [] };
}

export async function runMultiRoleResearch({ topicId, topicTitle, question,
  roles = DEFAULT_ROLES, sources = [], llmFactory = getLlmJson }) {
  const llmJson = await llmFactory({});
  if (typeof llmJson !== 'function') throw new Error('LLM 未配置：请先在 LLM 配置页启用一条可用配置');

  const results = [];
  for (const role of roles) {
    const out = await researchByRole({ role, topicTitle, question, sources, llmJson });
    const claimId = await addClaim({ topicId, role, statement: out.statement || '' });
    for (const e of (out.evidences || [])) {
      const src = sources[(e.source_index || 1) - 1];
      if (!src) continue;
      const evId = await addEvidence({ topicId, sourceId: src.id, excerpt: e.excerpt || '',
        anchor: e.anchor || null,
        stance: ['support', 'oppose', 'neutral'].includes(e.stance) ? e.stance : 'neutral' });
      await linkClaimEvidence(claimId, evId, e.stance === 'oppose' ? 'oppose' : 'support');
    }
    const chain = await buildEvidenceChain(claimId);
    const score = scoreClaimConfidence({
      evidence: chain.evidence.map((x) => ({
        credibility: (chain.sources.find((s) => s.id === x.source_id) || {}).credibility ?? 0.5,
        stance: x.stance, weight: x.weight,
      })),
      chainCompleteness: chain.evidence.length && chain.sources.length ? 1 : 0,
    });
    await queryWrite(
      `UPDATE crm.research_claim SET confidence=$1, confidence_detail=$2 WHERE id=$3`,
      [score.confidence, JSON.stringify(score.detail), claimId]);
    results.push({ role, claimId, confidence: score.confidence, detail: score.detail });
  }
  emit('research', 'multi_role_done', { topic_id: Number(topicId), claims: results.length });
  return results;
}

// 仲裁汇总：有冲突先消解；无冲突直接返回
export async function arbitrate({ topicId, strategy = 'credibility_weighted', judge = null, produceDecision = null }) {
  const conflicts = await detectClaimConflicts(topicId);
  if (conflicts.length === 0) return { strategy, resolved: [], conflicts: [] };
  return resolveClaimConflict(topicId, { strategy, judge, produceDecision });
}
```

- [ ] **Step 4: 运行测试并提交**

Run: `npx vitest run test/research-orchestrator.test.js`
Expected: PASS（2 个用例）

```bash
git add src/research/orchestrator.js test/research-orchestrator.test.js
git commit -m "feat(research): 多角色独立研判编排与仲裁汇总"
```

---

### Task 6: 推理树组装与决策第 0 闸落库

**Files:**
- Create: `src/research/reasoningTree.js`
- Test: `test/research-reasoning-tree.test.js`
- 参考（复用）：`src/page/reasoningSteps.js`（四态语义 ok/warn/pending/idle）、`src/agent/glassBox.js`（judge/trace）、`src/decision/decisionRepo.js:127` `createDecision`

- [ ] **Step 1: 写失败测试**

```javascript
// test/research-reasoning-tree.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import { ensureResearchSchema } from '../src/research/schema.js';
import { createTopic, addSource, addEvidence, addClaim, linkClaimEvidence } from '../src/research/evidenceChain.js';
import { buildReasoningTree, nodeStatus } from '../src/research/reasoningTree.js';

describe('推理树', () => {
  it('四态判定：无结论 idle / 有结论无证据 warn / 完整 ok', () => {
    expect(nodeStatus({ hasClaim: false })).toBe('idle');
    expect(nodeStatus({ hasClaim: true, hasEvidence: false })).toBe('warn');
    expect(nodeStatus({ hasClaim: true, hasEvidence: true, chainComplete: true })).toBe('ok');
    expect(nodeStatus({ hasClaim: true, hasEvidence: true, chainComplete: false })).toBe('pending');
  });

  it('树结构含 claim → evidence → source 三层', async () => {
    await ensureResearchSchema();
    const topicId = await createTopic({ title: '树专题', question: 'q' });
    const srcId = await addSource({ topicId, docTitle: '来源X', credibility: 0.7, excerpt: '原文' });
    const evId = await addEvidence({ topicId, sourceId: srcId, excerpt: '片段', stance: 'support' });
    const claimId = await addClaim({ topicId, role: '技术视角', statement: '结论S' });
    await linkClaimEvidence(claimId, evId, 'support');
    const tree = await buildReasoningTree(topicId);
    expect(tree.nodes[0].children[0].type).toBe('evidence');
    expect(tree.nodes[0].children[0].children[0].type).toBe('source');
    expect(tree.nodes[0].status).toBe('ok');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/research-reasoning-tree.test.js`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 写实现**

```javascript
// src/research/reasoningTree.js — 推理树组装（四态语义对齐 page/reasoningSteps.js）
import { query } from '../db.js';
import { buildTopicChain } from './evidenceChain.js';

// 节点状态：idle 未启动 / warn 证据不足 / pending 链条未完整 / ok 已闭环
export function nodeStatus({ hasClaim = false, hasEvidence = false, chainComplete = false } = {}) {
  if (!hasClaim) return 'idle';
  if (!hasEvidence) return 'warn';
  if (chainComplete) return 'ok';
  return 'pending';
}

export async function buildReasoningTree(topicId) {
  const topic = (await query(`SELECT * FROM crm.research_topic WHERE id=$1`, [topicId])).rows[0] || null;
  const { chains } = await buildTopicChain(topicId);
  const nodes = chains.map((c) => {
    const hasEvidence = c.evidence.length > 0;
    const chainComplete = hasEvidence && c.sources.length > 0;
    const srcOf = (id) => c.sources.find((s) => s.id === id) || {};
    return {
      id: `claim:${c.claim.id}`, type: 'claim', role: c.claim.role,
      label: c.claim.statement, confidence: c.claim.confidence,
      confidence_detail: c.claim.confidence_detail,
      status: nodeStatus({ hasClaim: true, hasEvidence, chainComplete }),
      children: c.evidence.map((e) => ({
        id: `evidence:${e.id}`, type: 'evidence', label: e.excerpt,
        stance: e.stance, anchor: e.anchor,
        children: [{
          id: `source:${e.source_id}`, type: 'source',
          label: srcOf(e.source_id).doc_title || '', credibility: srcOf(e.source_id).credibility ?? 0.5,
          url: srcOf(e.source_id).url || null,
        }],
      })),
    };
  });
  return { topic, nodes, generated_at: new Date().toISOString() };
}
```

- [ ] **Step 4: 结论确认走决策第 0 闸（复用，不新建）**

```javascript
// 追加到 src/research/reasoningTree.js 末尾
import { createDecision } from '../decision/decisionRepo.js';

// 专题结论确认：经决策第 0 闸产出真实 decision 行，回写 claim.decision_id
export async function confirmTopicConclusion({ topicId, claimId, rationale }) {
  const decision = await createDecision({
    scenario_id: 'RESEARCH_CONCLUSION_CONFIRM',
    disposition: 'APPROVED',
    trigger_context: { topic_id: Number(topicId), claim_id: Number(claimId) },
    conditions_evaluated: [{ name: 'evidence_chain_complete', met: true }],
    involved_entities: [`research_claim:${claimId}`],
    rationale: rationale || `研判结论确认 topic=${topicId} claim=${claimId}`,
  });
  await query(`UPDATE crm.research_claim SET status='confirmed', decision_id=$1 WHERE id=$2`,
    [decision.decision_id, claimId]);
  return decision;
}
```

- [ ] **Step 5: 运行测试并提交**

Run: `npx vitest run test/research-reasoning-tree.test.js`
Expected: PASS（2 个用例）

```bash
git add src/research/reasoningTree.js test/research-reasoning-tree.test.js
git commit -m "feat(research): 推理树组装与结论确认走决策第0闸"
```

---

### Task 7: MCP/AIP 暴露（加分项：标准接口接入第三方智能体）

**Files:**
- Create: `src/action/researchActions.js`
- Modify: `src/mcp/tools.js:50`（seed 时注册 research 族）
- Test: `test/research-mcp-tools.test.js`
- 参考（复用）：`src/action/registry.js` `registerAction`、`src/mcp/tools.js` `buildMcpTools`

- [ ] **Step 1: 写失败测试**

```javascript
// test/research-mcp-tools.test.js
import { describe, it, expect } from 'vitest';
import { buildMcpTools } from '../src/mcp/tools.js';

describe('研判族 MCP 工具暴露', () => {
  it('暴露 3 个研判读工具', () => {
    const { tools } = buildMcpTools({ seed: true });
    const names = tools.map((t) => t.name).filter((n) => n.startsWith('research-'));
    expect(names).toEqual(
      expect.arrayContaining(['research-trace-read', 'research-evidence-read', 'research-minority-read']));
  });

  it('研判工具均为读类，且不暴露任何 delete 类工具', () => {
    const { tools } = buildMcpTools({ seed: true });
    const research = tools.filter((t) => t.name.startsWith('research-'));
    expect(research.every((t) => t.kind === 'read')).toBe(true);
    expect(tools.some((t) => /delete|remove/i.test(t.name))).toBe(false);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/research-mcp-tools.test.js`
Expected: FAIL — 工具面中无 `research-*`

- [ ] **Step 3: 写 Action 注册模块**

```javascript
// src/action/researchActions.js — 研判族 Action（只读，经 buildMcpTools 暴露给第三方智能体）
import { registerAction } from './registry.js';
import { buildReasoningTree } from '../research/reasoningTree.js';
import { buildEvidenceChain } from '../research/evidenceChain.js';
import { listMinorityOpinions } from '../research/conflict.js';

let seeded = false;

export function seedResearchActions() {
  if (seeded) return;
  seeded = true;
  registerAction({
    name: 'research-trace-read', kind: 'read', namespace: 'research', lifecycle: 'active',
    description: '读取研判专题推理树（结论/证据/来源三级 + 置信度 + 四态状态）',
    schema: { topic_id: 'number' },
    handler: async ({ topic_id }) => buildReasoningTree(topic_id),
  });
  registerAction({
    name: 'research-evidence-read', kind: 'read', namespace: 'research', lifecycle: 'active',
    description: '读取单条结论的完整证据链，可下钻至来源原始段落',
    schema: { claim_id: 'number' },
    handler: async ({ claim_id }) => buildEvidenceChain(claim_id),
  });
  registerAction({
    name: 'research-minority-read', kind: 'read', namespace: 'research', lifecycle: 'active',
    description: '读取专题中保留的少数意见（冲突消解后未被采纳的结论）',
    schema: { topic_id: 'number' },
    handler: async ({ topic_id }) => listMinorityOpinions(topic_id),
  });
}
```

- [ ] **Step 4: 接线到 MCP 暴露咽喉**

修改 `src/mcp/tools.js`（约第 50 行，与 `seedActions()` / `seedDiscoveryActions()` 同处）：

```javascript
// 原：if (seed) { seedActions(); seedDiscoveryActions(); }
import { seedResearchActions } from '../action/researchActions.js';
// 改为：
if (seed) { seedActions(); seedDiscoveryActions(); seedResearchActions(); }
```

- [ ] **Step 5: 运行测试并提交**

Run: `npx vitest run test/research-mcp-tools.test.js`
Expected: PASS（2 个用例）

```bash
git add src/action/researchActions.js src/mcp/tools.js test/research-mcp-tools.test.js
git commit -m "feat(research): 研判族 Action 注册并接入 MCP 暴露面"
```

---

### Task 8: 防篡改研判日志（哈希链，加分项）

**Files:**
- Create: `src/research/auditChain.js`
- Test: `test/research-audit-chain.test.js`

- [ ] **Step 1: 写失败测试**

```javascript
// test/research-audit-chain.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import { ensureResearchSchema } from '../src/research/schema.js';
import { createTopic } from '../src/research/evidenceChain.js';
import { appendAudit, verifyChain, hashEntry } from '../src/research/auditChain.js';
import { queryWrite } from '../src/db.js';

describe('研判日志哈希链', () => {
  let topicId;
  beforeAll(async () => {
    await ensureResearchSchema();
    topicId = await createTopic({ title: '审计专题', question: 'q' });
  });

  it('追加两条后链条校验通过', async () => {
    await appendAudit(topicId, { event: 'run', roles: ['技术视角'] });
    await appendAudit(topicId, { event: 'resolve', strategy: 'credibility_weighted' });
    const r = await verifyChain(topicId);
    expect(r.valid).toBe(true);
    expect(r.total).toBe(2);
  });

  it('篡改 payload 后校验必须失败并定位断点', async () => {
    await queryWrite(
      `UPDATE crm.research_audit_log SET payload=$1 WHERE topic_id=$2 AND seq=1`,
      [JSON.stringify({ event: 'TAMPERED' }), topicId]);
    const r = await verifyChain(topicId);
    expect(r.valid).toBe(false);
    expect(r.broken_at).toBe(1);
  });

  it('键顺序不同不影响哈希（稳定序列化）', () => {
    expect(hashEntry('p', { a: 1, b: 2 })).toBe(hashEntry('p', { b: 2, a: 1 }));
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/research-audit-chain.test.js`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 写实现**

```javascript
// src/research/auditChain.js — 研判日志防篡改：SHA-256 哈希链（写入即串链，篡改必被检出）
import { createHash } from 'node:crypto';
import { query, queryWrite } from '../db.js';

const GENESIS = '0'.repeat(64);

// 稳定序列化：jsonb 回读时键顺序不稳定 → 必须排序键后再哈希，否则链必然「假失败」
function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(v).sort()
    .map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

export function hashEntry(prevHash, payload) {
  return createHash('sha256').update(prevHash + stableStringify(payload)).digest('hex');
}

export async function appendAudit(topicId, payload) {
  const last = (await query(
    `SELECT seq, hash FROM crm.research_audit_log WHERE topic_id=$1 ORDER BY seq DESC LIMIT 1`,
    [topicId])).rows[0];
  const seq = last ? last.seq + 1 : 1;
  const prevHash = last ? last.hash : GENESIS;
  const hash = hashEntry(prevHash, payload);
  await queryWrite(
    `INSERT INTO crm.research_audit_log (topic_id, seq, prev_hash, hash, payload)
     VALUES ($1,$2,$3,$4,$5)`,
    [topicId, seq, prevHash, hash, JSON.stringify(payload)]);
  return { seq, hash };
}

export async function verifyChain(topicId) {
  const rows = (await query(
    `SELECT * FROM crm.research_audit_log WHERE topic_id=$1 ORDER BY seq`, [topicId])).rows;
  let prevHash = GENESIS;
  for (const r of rows) {
    if (r.prev_hash !== prevHash || r.hash !== hashEntry(prevHash, r.payload)) {
      return { valid: false, broken_at: r.seq, total: rows.length };
    }
    prevHash = r.hash;
  }
  return { valid: true, total: rows.length };
}

// 专题级审计快照（供原型实测报告引用）
export async function auditSnapshot(topicId) {
  const rows = (await query(
    `SELECT seq, hash, payload, created_at FROM crm.research_audit_log
     WHERE topic_id=$1 ORDER BY seq`, [topicId])).rows;
  return { topic_id: Number(topicId), entries: rows, verification: await verifyChain(topicId) };
}
```

- [ ] **Step 4: 运行测试并提交**

Run: `npx vitest run test/research-audit-chain.test.js`
Expected: PASS（3 个用例；篡改用例必须变红→修复前先确认它能失败）

```bash
git add src/research/auditChain.js test/research-audit-chain.test.js
git commit -m "feat(research): 研判日志 SHA-256 哈希链与篡改检出"
```

---

### Task 9: 研判页数据组装与人工修改后重算

**Files:**
- Create: `src/portal/researchPage.js`
- Test: `test/research-page.test.js`
- 纪律：**不使用 DELETE**（人工排除证据用 `relation='excluded'` 软标记，遵守项目禁删铁律）

- [ ] **Step 1: 写失败测试**

```javascript
// test/research-page.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import { ensureResearchSchema } from '../src/research/schema.js';
import { createTopic, addSource, addEvidence, addClaim, linkClaimEvidence, buildEvidenceChain } from '../src/research/evidenceChain.js';
import { buildResearchPagePayload, recomputeAfterHumanEdit } from '../src/portal/researchPage.js';
import { verifyChain } from '../src/research/auditChain.js';

describe('研判页与人工重算', () => {
  let topicId, claimId, evId;
  beforeAll(async () => {
    await ensureResearchSchema();
    topicId = await createTopic({ title: '页面专题', question: 'q' });
    const srcId = await addSource({ topicId, docTitle: '来源A', credibility: 0.9, excerpt: '原文' });
    evId = await addEvidence({ topicId, sourceId: srcId, excerpt: '片段', stance: 'support' });
    claimId = await addClaim({ topicId, role: '技术视角', statement: 'S' });
    await linkClaimEvidence(claimId, evId, 'support');
  });

  it('页面载荷含推理树与图例', async () => {
    const payload = await buildResearchPagePayload(topicId);
    expect(payload.nodes.length).toBe(1);
    expect(payload.legends.ok).toBeDefined();
  });

  it('人工排除证据后置信度重算并写入审计链', async () => {
    const r = await recomputeAfterHumanEdit({ topicId, claimId, evidenceId: evId, patch: { exclude: true } });
    expect(r.confidence).toBe(0);
    const chain = await buildEvidenceChain(claimId);
    expect(chain.evidence.length).toBe(0);
    const audit = await verifyChain(topicId);
    expect(audit.valid).toBe(true);
    expect(audit.total).toBe(1);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/research-page.test.js`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 写实现**

```javascript
// src/portal/researchPage.js — 研判页数据组装 + 人工修改证据/结论后重算（可干预、可复现）
import { queryWrite } from '../db.js';
import { buildReasoningTree } from '../research/reasoningTree.js';
import { buildEvidenceChain } from '../research/evidenceChain.js';
import { scoreClaimConfidence } from '../research/confidence.js';
import { appendAudit } from '../research/auditChain.js';

export async function buildResearchPagePayload(topicId) {
  const tree = await buildReasoningTree(topicId);
  return {
    ...tree,
    legends: { ok: '证据链完整', warn: '缺证据支撑', pending: '链条未完整', idle: '未启动' },
    actions: ['exclude_evidence', 'set_stance', 'recompute'],
  };
}

// 人工修改 → 重算置信度 → 写审计链（禁止 DELETE：排除用软标记）
export async function recomputeAfterHumanEdit({ topicId, claimId, evidenceId, patch = {}, actor = 'human' }) {
  if (patch.stance) {
    await queryWrite(`UPDATE crm.research_evidence SET stance=$1 WHERE id=$2`, [patch.stance, evidenceId]);
  }
  if (patch.exclude === true) {
    await queryWrite(
      `UPDATE crm.research_claim_evidence SET relation='excluded' WHERE claim_id=$1 AND evidence_id=$2`,
      [claimId, evidenceId]);
  }
  const chain = await buildEvidenceChain(claimId);
  const score = scoreClaimConfidence({
    evidence: chain.evidence.map((e) => ({
      credibility: (chain.sources.find((s) => s.id === e.source_id) || {}).credibility ?? 0.5,
      stance: e.stance, weight: e.weight,
    })),
    chainCompleteness: chain.evidence.length && chain.sources.length ? 1 : 0,
  });
  await queryWrite(`UPDATE crm.research_claim SET confidence=$1, confidence_detail=$2 WHERE id=$3`,
    [score.confidence, JSON.stringify(score.detail), claimId]);
  await appendAudit(topicId, {
    event: 'human_edit_recompute', claim_id: Number(claimId), evidence_id: Number(evidenceId),
    patch, actor, confidence: score.confidence,
  });
  return { claimId: Number(claimId), confidence: score.confidence, detail: score.detail };
}
```

- [ ] **Step 4: 运行测试并提交**

Run: `npx vitest run test/research-page.test.js`
Expected: PASS（2 个用例）

```bash
git add src/portal/researchPage.js test/research-page.test.js
git commit -m "feat(research): 研判页数据组装与人工修改后重算（含审计留痕）"
```

---

### Task 10: 端到端实测脚本（原型实测 70% 的验收物）

**Files:**
- Create: `scripts/research-e2e.mjs`
- Test: 由脚本自身 `--verify` 输出判定（并入 `npm test` 前的冒烟可选）

- [ ] **Step 1: 写脚本（支持 --stub 无模型跑通）**

```javascript
// scripts/research-e2e.mjs — 端到端实测：造专题 → 多角色研判 → 冲突消解 → 推理树 → 审计校验
// 用法：node scripts/research-e2e.mjs [--stub] [--verify]
import { ensureResearchSchema } from '../src/research/schema.js';
import { createTopic, addSource } from '../src/research/evidenceChain.js';
import { runMultiRoleResearch, arbitrate } from '../src/research/orchestrator.js';
import { buildReasoningTree } from '../src/research/reasoningTree.js';
import { auditSnapshot, appendAudit } from '../src/research/auditChain.js';
import { listMinorityOpinions } from '../src/research/conflict.js';

const STUB = process.argv.includes('--stub');
const VERIFY = process.argv.includes('--verify');

const STUB_FACTORY = async () => async (systemPrompt, userPrompt) => {
  const role = /风险/.test(userPrompt) ? '风险视角' : '技术视角';
  return role === '风险视角'
    ? { statement: '现有证据不足以判定 X 导致 Y', evidences: [{ source_index: 2, excerpt: '尚未证实因果关系', stance: 'oppose' }] }
    : { statement: 'X 与 Y 存在强关联', evidences: [{ source_index: 1, excerpt: 'X 与 Y 显著相关', stance: 'support' }] };
};

async function main() {
  await ensureResearchSchema();
  const topicId = await createTopic({ title: '开源情报专题：X 与 Y 的关系', question: 'X 是否导致 Y？' });
  const srcA = await addSource({ topicId, docTitle: '权威研究报告', credibility: 0.9, excerpt: 'X 与 Y 显著相关（样本 N=1200）' });
  const srcB = await addSource({ topicId, docTitle: '匿名论坛帖', credibility: 0.2, excerpt: '尚未证实因果关系' });
  const sources = [
    { id: srcA, doc_title: '权威研究报告', credibility: 0.9, excerpt: 'X 与 Y 显著相关（样本 N=1200）' },
    { id: srcB, doc_title: '匿名论坛帖', credibility: 0.2, excerpt: '尚未证实因果关系' },
  ];

  await appendAudit(topicId, { event: 'start', topic: 'X 是否导致 Y？' });
  const claims = await runMultiRoleResearch({
    topicId, topicTitle: '开源情报专题：X 与 Y 的关系', question: 'X 是否导致 Y？',
    roles: ['技术视角', '风险视角'],
    sources,
    llmFactory: STUB ? STUB_FACTORY : undefined,
  });
  const resolved = await arbitrate({ topicId, strategy: 'credibility_weighted' });
  await appendAudit(topicId, { event: 'arbitrate', strategy: resolved.strategy, resolved: resolved.resolved.length });

  const tree = await buildReasoningTree(topicId);
  const minorities = await listMinorityOpinions(topicId);
  const audit = await auditSnapshot(topicId);

  const report = {
    topic_id: Number(topicId),
    claims: claims.map((c) => ({ role: c.role, confidence: c.confidence, reasons: c.detail.reasons })),
    conflicts_resolved: resolved.resolved.length,
    minority_kept: minorities.length,
    reasoning_tree_nodes: tree.nodes.length,
    audit_verified: audit.verification.valid,
  };
  console.log(JSON.stringify(report, null, 2));

  if (VERIFY) {
    const ok = report.claims.length >= 2 && report.audit_verified === true
      && report.reasoning_tree_nodes >= 2;
    console.log(ok ? 'E2E_OK' : 'E2E_FAIL');
    process.exit(ok ? 0 : 1);
  }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: 运行验证（无模型可跑）**

Run: `node scripts/research-e2e.mjs --stub --verify`
Expected: 输出 JSON 报告 + `E2E_OK`，退出码 0

- [ ] **Step 3: 运行验证（真实模型）**

Run: `node scripts/research-e2e.mjs --verify`
Expected: `E2E_OK`（若 LLM 未配置，脚本须明确报错而非产出假结论）

- [ ] **Step 4: 提交**

```bash
git add scripts/research-e2e.mjs
git commit -m "feat(research): 端到端实测脚本（多角色研判+冲突消解+证据链+审计校验）"
```

---

## 3. 端到端验收标准（对齐赛题 5 项 + 3 加分项）

| # | 赛题要求 | 验收动作 | 通过判据 |
| :-: | :-- | :-- | :-- |
| 1 | 多智能体协同研判（≥2 角色 + 仲裁） | `node scripts/research-e2e.mjs --stub` | 报告 `claims.length ≥ 2` 且含仲裁结果 |
| 2 | 证据链三级溯源（可下钻段落） | `npx vitest run test/research-evidence-chain.test.js` | `buildEvidenceChain` 返回 claim/evidence/sources 三层；`drillDown` 可回原始段落 |
| 3 | 结论置信度量化 | `npx vitest run test/research-confidence.test.js` | 三维得分数值 + `reasons` 文字依据齐全 |
| 4 | 冲突识别与消解 + 保留少数意见 | `npx vitest run test/research-conflict.test.js` | 冲突清单非空；加权消解胜出正确；少数意见可查 |
| 5 | 推理轨迹可视化 + 人工修改后重算 | `npx vitest run test/research-page.test.js` | 树三层结构 + 四态；排除证据后置信度重算且审计留痕 |
| 6a | 加分：防篡改日志 | `npx vitest run test/research-audit-chain.test.js` | 篡改后 `valid=false` 且 `broken_at` 定位准确 |
| 6b | 加分：AIP/MCP 接入第三方 | `npx vitest run test/research-mcp-tools.test.js` | 工具面出现 `research-*` 且均为只读 |
| 6c | 加分：相关/因果区分 | 见 §4 范围外（P2，答辩讲清规划即可） | — |

**全量回归：** `npm test`（须保持既有测试全绿；新增测试文件须同批清理子表，遵守 `pretest` 隔离审计）。

---

## 4. 范围外（YAGNI，本原型明确不做）

1. **因果推断算法**（"X 导致 Y"的相关/因果区分、证据等级标注）——加分项，答辩可讲"复用 `decision/decisionTrace.js` 因果链 + 后续接入 DoWhy/econml"，本原型不实现。
2. **多专题/多租户隔离压测**——原型单专题即可，租户字段已预留。
3. **门户前端像素级页面**——本原型交付页面数据载荷 + 渲染接线点；视觉呈现按既有门户样式复用（答辩可展示 JSON→页面）。
4. **研判日志签名（非对称）**——哈希链已满足"防篡改检出"，签名留作 P2。

---

## 5. 风险与对策

| 风险 | 影响 | 对策 |
| :-- | :-- | :-- |
| LLM 未配置/超时 | 研判无法产出 | 编排层明确抛错（禁假结论）；实测脚本支持 `--stub` 保证可演示 |
| 矛盾判定过于朴素（否定词规则） | 漏检冲突 | 先规则版跑通（可测、可解释），答辩说明可升级为 LLM 判定 + 保留规则兜底 |
| jsonb 键序导致哈希链假失败 | 审计校验恒红 | 已用 `stableStringify` 排序键（Task 8 用例 3 专门守护） |
| 测试残留污染 | 全量回归假红 | 新增测试须在同一 `beforeAll` 内清理子表（`research_claim_evidence` → `research_*`），遵守项目 `test-isolation-audit` |
| 越界改动既有业务域 | 违反 §10 硬约束 | 全部新增落在 `src/research/`；唯一既有文件改动为 `src/mcp/tools.js` 一行 seed 注册 |

---

## 6. 自检结论（Self-Review）

- **Spec coverage：** 赛题 5 项必答 → Task 1/3（②）、Task 2（③）、Task 4/5（①④）、Task 6/9（⑤）；3 项加分 → Task 7（MCP）、Task 8（防篡改）、§4 明确因果区分范围外。无遗漏项。
- **Placeholder scan：** 无 TBD/TODO；每个代码步骤均给出完整可运行实现。
- **Type consistency：** `scoreClaimConfidence` / `buildEvidenceChain` / `detectClaimConflicts` / `resolveClaimConflict` / `buildReasoningTree` / `appendAudit` / `verifyChain` 在各 Task 间签名一致；`relation='excluded'` 软标记在 Task 3 查询与 Task 9 写入两端对齐。

---

## 7. 执行方式（请选一）

**1. Subagent-Driven（推荐）** — 每个 Task 派发独立子代理，Task 间双阶段审查，迭代快、上下文干净。

**2. Inline Execution** — 当前会话内按 Task 批量执行 + 检查点复核（与既有习惯一致）。

选定后我按 `superpowers:executing-plans` 逐 Task 推进，**每 Task 一次 commit，显式路径 add，不使用 `git add -A`**。

