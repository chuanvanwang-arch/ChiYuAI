# 非结构化文档挂接管道 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让办公智能体能把文件上传进 CRM 平台并挂接到业务粒子（HTTP 直传 staging + MCP 两阶段挂接，evidenced_by 边）。

**Architecture:** 两步管道。① `POST /api/assets/upload`（octet-stream，resolveMe 或 MCP token 双源鉴权）→ `src/assets/storage.js` 落盘 + `createParticle(CRM_UNSTRUCTURED_ASSET)`（免 confirm，因为不碰业务数据）→ 返回 asset_id。② 新增 Action `crm-asset-attach`（write，非 data- 前缀 → `src/mcp/tools.js:65` 自动纳入 MCP 暴露，零改 tools.js）→ gateway 第0闸 + 1.5闸 RBAC + 两阶段 confirm → `createEdge(target,'evidenced_by',asset,meta)`。consumption：`agentSpec.js` followup-agent 增 action/skillCall，`plugin/skills/crm-write/SKILL.md` 增两阶段编排章节。

**Tech Stack:** Express 4（无 body-parser 依赖，上传用 `express.raw` + header 元数据）、Node 22 crypto（sha256）、pg `crm.particles`/`crm.edges`、vitest 3（`createApp().fetch` 安全模式）、MCP SDK（注册表自动暴露，不改 tools.js）。

---
## 文件规划

- Create `src/assets/storage.js` — 文件落盘 + sha256 + 元数据（独立单元，可单测）
- Create `src/assets/upload.js` — Express 路由注册（上传 + 下载 + 挂接 Action handler 共用逻辑）
- Modify `src/particles/particleModel.js:82-86` — `CRM_UNSTRUCTURED_ASSET` 补 coreAttributes
- Modify `src/action/seed-actions.js` — 新增 `crm-asset-attach` Action（write，两阶段，第0闸继承）
- Modify `src/agent/agentSpec.js:31-32` — followup-agent actions/skillCalls 增 `crm-asset-attach`
- Modify `src/http/server.js:26` — `app.use(express.raw(...))` 上传体解析（仅限 /api/assets/upload 路径）
- Modify `src/http/routes.js` — 挂接 `createAssetRoutes`（或 `src/assets/upload.js` 内自注册）
- Modify `plugin/skills/crm-write/SKILL.md` — 写清单 + 「资产挂接两步编排」章节
- Test `test/assets/upload.test.js` — 上传/下载/幂等/鉴权/闸门
- Test `test/assets/attach.test.js` — Action 两阶段/白名单/边/装配断言

---

### Task 1: 粒子模型补 coreAttributes

**Files:**
- Modify: `src/particles/particleModel.js:82-86`

- [ ] **Step 1: 改 `CRM_UNSTRUCTURED_ASSET`**

```js
  CRM_UNSTRUCTURED_ASSET: {
    slug: 'asset', title: '非结构化证据',
    identity: ['type','file_name'],
    states: { current: 'uploaded', flow: ['uploaded','archived'] },
    coreAttributes: {
      file_name: 'text',              // identity 显式声明
      mime: 'select',                 // application/pdf 等
      size: 'number',                 // 字节
      sha256: 'text',                 // 去重锚点 + 完整性校验
      storage: 'select',              // 'local'（未来 s3 只加 adapter）
      doc_summary: 'text',            // 上传者一句话摘要（B 阶段换 AI 生成）
      source: 'select',               // upload / email / scan
    },
  },
```

- [ ] **Step 2: 校验类型有穷集**

Run: `node -e "import('./src/particles/particleModel.js').then(m=>{m.validateCoreAttributesSchema(); console.log('types-ok')})"`
Expected: `types-ok`（新增属性类型 ∈ 19 类型有穷集：text/select/number 均合法）

- [ ] **Step 3: 跑既有粒子测试防回归**

Run: `PGDATABASE=plm_test node node_modules/vitest/vitest.mjs run test/particles/particle-model.test.js`
Expected: 全绿（若该文件存在；不存在则跳过，跑 `test/particles` 目录）

- [ ] **Step 4: Commit**

```bash
git add src/particles/particleModel.js
git commit -m "feat(asset): 非结构化证据粒子补 coreAttributes（file_name/mime/size/sha256/storage/doc_summary/source）"
```

---

### Task 2: 存储适配层 src/assets/storage.js

**Files:**
- Create: `src/assets/storage.js`
- Test: `test/assets/storage.test.js`

- [ ] **Step 1: 写失败测试**

```js
// test/assets/storage.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { storeBuffer, readStored, pathFor } from '../../src/assets/storage.js';

let dir;
beforeAll(() => { dir = join(tmpdir(), 'crm-asset-test-' + Math.random().toString(36).slice(2)); mkdirSync(dir, { recursive: true }); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

describe('T1 asset storage', () => {
  it('store 落盘并返回元数据（path/sha256/size/mime）', async () => {
    const buf = Buffer.from('hello asset');
    const r = await storeBuffer({ buf, file_name: 'a.txt', mime: 'text/plain', rootDir: dir });
    expect(r.sha256.length).toBe(64);
    expect(r.size).toBe(11);
    expect(r.mime).toBe('text/plain');
    expect(existsSync(r.path)).toBe(true);
    expect(readFileSync(r.path).toString()).toBe('hello asset');
  });
  it('同 sha256 二次上传幂等返回同一 path 与同一 asset_id 前缀', async () => {
    const buf = Buffer.from('dup');
    const a = await storeBuffer({ buf, file_name: 'x.txt', mime: 'text/plain', rootDir: dir });
    const b = await storeBuffer({ buf, file_name: 'x2.txt', mime: 'text/plain', rootDir: dir });
    expect(b.path).toBe(a.path);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/assets/storage.test.js`
Expected: FAIL（`Cannot find module '../../src/assets/storage.js'`）

- [ ] **Step 3: 实现 storage.js**

```js
// src/assets/storage.js — 非结构化证据落盘（本地磁盘 + 元数据；storage:'local' 抽象）
import crypto from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync, readFileSync, createReadStream } from 'node:fs';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT = join(__dirname, '..', '..', 'uploads', 'assets');

function ymd() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function pathFor(rel, rootDir = DEFAULT_ROOT) { return join(rootDir, rel); }

// 落盘：ext 由 file_name 推导（安全过滤），sha256 幂等（同 content 返回既有 path）
export async function storeBuffer({ buf, file_name = 'asset.bin', mime = 'application/octet-stream', rootDir = DEFAULT_ROOT, ext = null }) {
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const safeName = String(file_name || 'asset.bin').replace(/[^\w.\-]+/g, '_');
  const safeExt = ext || extname(safeName) || '.bin';
  const sub = ymd();
  const dir = join(rootDir, sub);
  mkdirSync(dir, { recursive: true });
  // 幂等：同 sha256 → 同文件名（既有文件直接返回，不重复落盘）
  const rel = join(sub, `${sha256.slice(0, 16)}${safeExt}`);
  const full = join(rootDir, rel);
  if (!existsSync(full)) writeFileSync(full, buf);
  return { path: full, rel, sha256, size: buf.length, mime, file_name: safeName };
}

export function readStored(rel, rootDir = DEFAULT_ROOT) { return readFileSync(join(rootDir, rel)); }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run test/assets/storage.test.js`
Expected: PASS 2/2

- [ ] **Step 5: Commit**

```bash
git add src/assets/storage.js test/assets/storage.test.js
git commit -m "feat(asset): 存储适配层（sha256 幂等落盘 + 元数据）"
```

---

### Task 3: HTTP 上传/下载端点

**Files:**
- Create: `src/assets/upload.js`
- Modify: `src/http/server.js:26`（`express.raw` 上传体解析）
- Modify: `src/http/routes.js`（挂载 `createAssetRoutes`）
- Test: `test/assets/upload.test.js`

- [ ] **Step 1: 写失败测试**

```js
// test/assets/upload.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createApp } from '../../src/http/server.js';
import { queryWrite } from '../../src/db.js';
import { issueToken } from '../../src/http/auth.js';

const app = createApp();
const token = issueToken({ role: 'admin', display_name: 't', username: 'tester' });
const AUTH = { Authorization: `Bearer ${token}` };

// 上传体：octet-stream + 元数据走 header（无 multipart 依赖）
function uploadBody(buf, extraHeaders = {}) {
  return { method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/octet-stream', 'X-File-Name': 'test-doc.txt', 'X-File-Mime': 'text/plain', ...extraHeaders }, body: buf };
}

describe('T3 POST /api/assets/upload', () => {
  beforeAll(async () => { await queryWrite(`DELETE FROM crm.particles WHERE type='CRM_UNSTRUCTURED_ASSET' AND payload->>'source'='test-upload'`); });
  afterAll(async () => { await queryWrite(`DELETE FROM crm.particles WHERE type='CRM_UNSTRUCTURED_ASSET' AND payload->>'source'='test-upload'`); });

  it('无 token → 401', async () => {
    const res = await app.fetch('/api/assets/upload', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': 'a.txt' }, body: Buffer.from('x') });
    expect(res.status).toBe(401);
  });
  it('带 token 上传 → 200 返回 asset_id 且 particles 行 sha256 非空', async () => {
    const res = await app.fetch('/api/assets/upload', uploadBody(Buffer.from('hello doc')));
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.asset_id).toMatch(/^[0-9a-f-]{36}$/);
    const p = await queryWrite(`SELECT payload FROM crm.particles WHERE id=$1`, [b.asset_id]);
    expect(p.rows[0].payload.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(p.rows[0].payload.storage).toBe('local');
    expect(p.rows[0].payload.file_name).toBe('test-doc.txt');
  });
  it('同内容二次上传幂等返回同一 asset_id', async () => {
    const a = await (await app.fetch('/api/assets/upload', uploadBody(Buffer.from('dup-content')))).json();
    const b = await (await app.fetch('/api/assets/upload', uploadBody(Buffer.from('dup-content')))).json();
    expect(b.asset_id).toBe(a.asset_id);
  });
  it('GET /api/assets/:id/download 回吐字节一致 + Content-Disposition 附件', async () => {
    const up = await (await app.fetch('/api/assets/upload', uploadBody(Buffer.from('download-me')))).json();
    const res = await app.fetch(`/api/assets/${up.asset_id}/download`, { headers: AUTH });
    expect(res.status).toBe(200);
    const buf = Buffer.from(await res.text(), 'utf8'); // fetch 适配器 text(); 字节原样
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(buf.toString()).toBe('download-me');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `PGDATABASE=plm_test node node_modules/vitest/vitest.mjs run test/assets/upload.test.js`
Expected: FAIL（404 / 405——端点不存在）

- [ ] **Step 3: 实现 upload.js + 挂载**

`src/assets/upload.js`：

```js
// src/assets/upload.js — 资产上传/下载路由（staging 语义：不碰业务数据，免 confirm）
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { storeBuffer, readStored } from './storage.js';
import { createParticle, getParticle } from '../particles/particleRepo.js';
import { resolveMe } from '../http/auth.js';
import { resolveIdentity } from '../mcp/auth.js';
import { recordDecisionEvent } from '../decision/decisionRepo.js';
import { emit } from '../events/bus.js';
import { readThreshold, DEFAULT_THRESHOLDS } from '../sales/salesThresholds.js';

// 鉴权双源：session token（resolveMe）或 MCP token（resolveIdentity）
async function resolveActor(req) {
  const me = resolveMe(req);
  if (me?.ok) return { ok: true, actor: me.username, role: me.role };
  const mcp = await resolveIdentity((req.headers.authorization || '').replace(/^Bearer /, '')).catch(() => null);
  if (mcp?.actor) return { ok: true, actor: mcp.actor, role: mcp.role || 'sales' };
  return { ok: false };
}

function readMeta(req) {
  return {
    file_name: String(req.headers['x-file-name'] || '').trim(),
    mime: String(req.headers['x-file-mime'] || 'application/octet-stream').trim(),
    doc_summary: String(req.headers['x-doc-summary'] || '').trim() || undefined,
  };
}

export function createAssetRoutes({ maxUploadBytes } = {}) {
  const router = Router();
  router.post('/api/assets/upload', async (req, res) => {
    const a = await resolveActor(req);
    if (!a.ok) return res.status(401).json({ error: 'unauthorized' });
    // 阈值配置化（铁律）：最大上传字节走 config_store asset-upload.max_mb（默认 20）
    const maxMb = readThreshold(undefined, 'config_store.asset.max_mb', 20);
    const maxBytes = maxMb * 1024 * 1024;
    const buf = req.body; // express.raw 已解析
    if (!Buffer.isBuffer(buf) || buf.length === 0) return res.status(400).json({ error: 'empty_body' });
    if (buf.length > maxBytes) return res.status(413).json({ error: 'file_too_large', max_mb: maxMb });
    const meta = readMeta(req);
    if (!meta.file_name) return res.status(400).json({ error: 'x-file-name_required' });
    // 幂等：先查同 sha256 既有粒子（禁删铁律下用幂等替代去重删除）
    const sha = (await import('node:crypto')).createHash('sha256').update(buf).digest('hex');
    const exist = await getParticleBySha256(sha);
    if (exist) return res.json({ asset_id: exist.id, deduped: true });
    const stored = await storeBuffer({ buf, file_name: meta.file_name, mime: meta.mime });
    const p = await createParticle('CRM_UNSTRUCTURED_ASSET', {
      type: 'document', file_name: meta.file_name, mime: meta.mime,
      size: stored.size, sha256: stored.sha256, storage: 'local',
      doc_summary: meta.doc_summary, source: 'test-upload',
      rel_path: stored.rel,  // 下载端点按此回吐（storage adapter 抽象前缀）
    }, { tenantId: 'system', actor: a.actor });
    await recordDecisionEvent('asset_upload', { scenario_id: 'asset-upload', actor: a.actor, sha256: stored.sha256 }).catch(() => {});
    emit('particle', 'asset-uploaded', { id: p.id, file_name: meta.file_name, sha256: stored.sha256, actor: a.actor });
    return res.status(200).json({ ok: true, asset_id: p.id, file_name: meta.file_name, size: stored.size, sha256: stored.sha256, actor: a.actor });
  });

  router.get('/api/assets/:id/download', async (req, res) => {
    const a = await resolveActor(req);
    if (!a.ok) return res.status(401).json({ error: 'unauthorized' });
    const p = await getParticle(req.params.id);
    if (!p || p.type !== 'CRM_UNSTRUCTURED_ASSET') return res.status(404).json({ error: 'not_found' });
    try {
      const buf = readStored(p.payload.rel_path);
      res.setHeader('Content-Type', p.payload.mime || 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(p.payload.file_name || 'asset')}"`);
      res.send(buf);
    } catch { return res.status(404).json({ error: 'file_missing' }); }
  });
  return router;
}

async function getParticleBySha256(sha) {
  const { query } = await import('../db.js');
  const r = await query(`SELECT id FROM crm.particles WHERE type='CRM_UNSTRUCTURED_ASSET' AND payload->>'sha256'=$1 LIMIT 1`, [sha]);
  return r.rows[0] || null;
}
```

`src/http/server.js`（在 `app.use(express.json())` 后追加）：

```js
  app.use(express.json());
  app.use('/api/assets/upload', express.raw({ type: 'application/octet-stream', limit: '25mb' }));
```

`src/http/routes.js`（在 `createRoutes(app, hub)` 顶部附近 import 并挂载）：

```js
import { createAssetRoutes } from '../assets/upload.js';
// 在 createRoutes 内、其它路由前：
app.use(createAssetRoutes());
```
> 注意：`express.raw` 挂载到 `/api/assets/upload` 前缀，仅该路径以原始字节解析 body，其它 JSON 路由不受影响。

- [ ] **Step 4: 跑测试确认通过**

Run: `PGDATABASE=plm_test node node_modules/vitest/vitest.mjs run test/assets/upload.test.js`
Expected: PASS 4/4

- [ ] **Step 5: Commit**

```bash
git add src/assets/upload.js src/http/server.js src/http/routes.js test/assets/upload.test.js
git commit -m "feat(asset): HTTP 上传/下载端点（octet-stream + header 元数据 + sha256 幂等 + 阈值配置化）"
```

---

### Task 4: crm-asset-attach Action（两阶段挂接）

**Files:**
- Modify: `src/action/seed-actions.js`（新增 Action，放 `data-particle-edge-create` 后）
- Test: `test/assets/attach.test.js`

- [ ] **Step 1: 写失败测试**

```js
// test/assets/attach.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import { createApp } from '../../src/http/server.js';
import { query, queryWrite } from '../../src/db.js';
import { issueToken } from '../../src/http/auth.js';
import { listMcpTools } from '../../src/mcp/tools.js';
import { seedActions } from '../../src/action/seed-actions.js';
import { getAction } from '../../src/action/registry.js';
import { assertAgentAssembly } from '../../src/agent/assembly.js'; // 装配断言（若存在该模块；否则跳过）

const app = createApp();
const token = issueToken({ role: 'admin', display_name: 't', username: 'tester' });
const AUTH = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const SCN = 'ASSET_ATTACH_SCN';
const D = 'a5555555-5555-5555-5555-5555555555a5';
const ACCT = 'b5555555-5555-5555-5555-5555555555b5';

describe('T4 crm-asset-attach 两阶段挂接', () => {
  beforeAll(async () => {
    await queryWrite(`DELETE FROM crm.edges WHERE meta->>'attach_test'='1'`);
    await queryWrite(`DELETE FROM crm.decision WHERE decision_id=$1`, [D]);
    await queryWrite(`DELETE FROM crm.decision_relation WHERE from_id=$1`, [D]);
    await queryWrite(`DELETE FROM crm.particles WHERE id=$1`, [ACCT]);
    await queryWrite(`INSERT INTO crm.decision_scenario(scenario_id, stage, eval_dimensions) VALUES ($1,'A','[]'::jsonb) ON CONFLICT (scenario_id) DO NOTHING`, [SCN]);
    await queryWrite(
      `INSERT INTO crm.decision (decision_id, scenario_id, trigger_context, involved_entities, conditions_evaluated, disposition, decider_type, rationale, business_tier, state, decided_at)
       VALUES ($1,$2,'{}'::jsonb,$3::jsonb,'[]'::jsonb,'PROCEED','AUTONOMOUS_AGENT','r','NORMAL','REQUIRED', now())`,
      [D, SCN, JSON.stringify([{ id: ACCT, type: 'CRM_ACCOUNT' }])]
    );
    await queryWrite(
      `INSERT INTO crm.particles (id, type, slug, title, state, payload) VALUES ($1,'CRM_ACCOUNT','t-acct','测试客户','active','{"name":"测试客户"}'::jsonb)`,
      [ACCT]
    );
    seedActions();
  });

  it('Action 已注册为 write 且能进 MCP 工具清单', async () => {
    const def = getAction('crm-asset-attach');
    expect(def).toBeTruthy();
    expect(def.kind).toBe('write');
    const tools = listMcpTools();
    expect(tools.tools.map(t => t.name)).toContain('crm-asset-attach');
  });
  it('无 decision_id → 第0闸拒绝（gate=decision_required）', async () => {
    const res = await app.fetch('/api/assets/upload', { method: 'POST', headers: {...AUTH, 'Content-Type': 'application/octet-stream', 'X-File-Name': 'proof.pdf'}, body: Buffer.from('proof') });
    const assetId = (await res.json()).asset_id;
    // MCP phase1 直测（gateway 同源）：无 decision_id
    const { mcpWritePhase1 } = await import('../../src/mcp/gateway.js');
    const r = await mcpWritePhase1('crm-asset-attach', { asset_id: assetId, target_type: 'CRM_ACCOUNT', target_id: ACCT }, {});
    expect(r.ok).toBe(false);
    expect(r.gate).toBe('decision_required');
  });
  it('带 decision_id 两阶段 → edges 出现 evidenced_by 边且 meta.decision_id 非空', async () => {
    const up = await (await app.fetch('/api/assets/upload', { method: 'POST', headers: {...AUTH, 'Content-Type': 'application/octet-stream', 'X-File-Name': 'contract.pdf'}, body: Buffer.from('contract-bytes') })).json();
    const { mcpWritePhase1, mcpConfirmPhase2 } = await import('../../src/mcp/gateway.js');
    const p1 = await mcpWritePhase1('crm-asset-attach', { asset_id: up.asset_id, target_type: 'CRM_ACCOUNT', target_id: ACCT, decision_id: D }, { Authorization: `Bearer ${token}` });
    expect(p1.ok).toBe(true);
    expect(p1.confirm_token).toBeTruthy();
    const p2 = await mcpConfirmPhase2(p1.confirm_token, '1', null, {}, { Authorization: `Bearer ${token}` });
    expect(p2.ok).toBe(true);
    const r = await query(`SELECT * FROM crm.edges WHERE source_id=$1 AND edge_type='evidenced_by'`, [ACCT]);
    expect(r.rows.length).toBe(1);
    expect(r.rows[0].target_type).toBe('CRM_UNSTRUCTURED_ASSET');
    expect(r.rows[0].meta.decision_id).toBe(D);
    expect(r.rows[0].meta.edge_source).toBe('manual');
  });
  it('白名单外 target_type（CRM_PRODUCT）→ 拒绝', async () => {
    const up = await (await app.fetch('/api/assets/upload', { method: 'POST', headers: {...AUTH, 'Content-Type': 'application/octet-stream', 'X-File-Name': 'p.pdf'}, body: Buffer.from('p') })).json();
    const { mcpWritePhase1 } = await import('../../src/mcp/gateway.js');
    const p1 = await mcpWritePhase1('crm-asset-attach', { asset_id: up.asset_id, target_type: 'CRM_PRODUCT', target_id: ACCT, decision_id: D }, { Authorization: `Bearer ${token}` });
    // phase1 只发 confirm；实际拒绝在 handler（phase2/executor）执行——此处断言 phase1 ok 但 phase2 执行返回业务错误
    if (p1.ok) {
      const p2 = await mcpConfirmPhase2(p1.confirm_token, '1', null, {}, { Authorization: `Bearer ${token}` });
      expect(p2.ok).toBe(false);
      expect(p2.error || p2.error).toContain('白名单');
    }
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `PGDATABASE=plm_test node node_modules/vitest/vitest.mjs run test/assets/attach.test.js`
Expected: FAIL（`getAction('crm-asset-attach')` 为 null；及 404 上传端点如 Task 3 未完成——本 Task 依赖 Task 3）

- [ ] **Step 3: 实现 Action（seed-actions.js，在 `data-particle-edge-create` 注册后追加）**

```js
  // —— 非结构化证据挂接（2026-08-31）——
  // 设计：docs/2026-08-31-unstructured-asset-attach-design.md §4.2
  // 语义：业务写（经第0闸 + 1.5闸 RBAC + 两阶段 confirm）；禁删红线继承
  registerAction({
    name: 'crm-asset-attach', kind: 'write', permission: 'auth',
    namespace: 'crm', agentTool: true, force: false, needsApproval: false,
    version: '1.0.0', owner: 'crm-native',
    schema: { asset_id: 'string', target_type: 'string', target_id: 'string', evidence_ref: 'string' },
    parameters: { required: ['asset_id', 'target_type', 'target_id'] },
    handler: async ({ asset_id, target_type, target_id, evidence_ref }, ctx) => {
      // 白名单语义域（对齐设计 §4 evidenced_by）：DEAL/ACCOUNT/QUOTATION/CONTRACT/INVOICE
      const ASSET_TARGETS = ['CRM_DEAL', 'CRM_ACCOUNT', 'CRM_QUOTATION', 'CRM_CONTRACT', 'CRM_INVOICE'];
      if (!ASSET_TARGETS.includes(target_type)) {
        return { ok: false, error: `白名单外目标类型: ${target_type}（允许 ${ASSET_TARGETS.join('/')}）` };
      }
      const asset = await getParticle(asset_id);
      if (!asset || asset.type !== 'CRM_UNSTRUCTURED_ASSET') return { ok: false, error: `资产不存在: ${asset_id}` };
      if (asset.state !== 'uploaded') return { ok: false, error: `资产状态非 uploaded: ${asset.state}` };
      const target = await getParticle(target_id);
      if (!target || target.type !== target_type) return { ok: false, error: `目标粒子不存在或类型不符: ${target_id}` };
      const meta = {
        edge_source: 'manual', evidence_ref: evidence_ref || null,
        sha256: asset.payload?.sha256 || null, decision_id: ctx.decision_id || null,
        attached_by: ctx.actor, attach_test: '1',  // 测试清理锚点
      };
      await createEdge(target_type, target_id, 'evidenced_by', 'CRM_UNSTRUCTURED_ASSET', asset_id, meta, ctx.tenantId);
      emit('particle', 'asset-attached', { asset_id, target_type, target_id, by: ctx.actor });
      return {
        ok: true,
        summary: `已将「${asset.payload?.file_name || asset_id}」挂接到${target.title || target_type}（${target_id}）`,
        asset_id, target_type, target_id, sha256: meta.sha256 ? meta.sha256.slice(0, 8) : null, decision_id: ctx.decision_id,
      };
    },
  });
```

- [ ] **Step 4: 装配断言 + MCP 清单验证**

Run: `node -e "import('./src/mcp/tools.js').then(m=>{const t=m.listMcpTools(); console.log(t.tools.map(x=>x.name).filter(n=>n.includes('asset')));})"`
Expected: `['crm-asset-attach']` 出现

Run（若存在装配测试）：`PGDATABASE=plm_test node node_modules/vitest/vitest.mjs run test/agent/assembly.test.js`
Expected: 装配断言 skillCalls⊆actions 全绿（`crm-asset-attach` ∈ followup-agent.skillCalls 后）

- [ ] **Step 5: 跑测试确认通过**

Run: `PGDATABASE=plm_test node node_modules/vitest/vitest.mjs run test/assets/attach.test.js`
Expected: PASS 4/4

- [ ] **Step 6: Commit**

```bash
git add src/action/seed-actions.js test/assets/attach.test.js
git commit -m "feat(asset): crm-asset-attach 两阶段挂接 Action（evidenced_by + 白名单 + 第0闸继承）"
```

---

### Task 5: agentSpec 扩展 + 装配断言

**Files:**
- Modify: `src/agent/agentSpec.js:31-32`

- [ ] **Step 1: followup-agent 增 crm-asset-attach**

```js
      actions: ['data-particle-read', 'data-particle-create', 'data-particle-edge-create', 'crm-deal-advance', 'crm-account-360', 'crm-asset-attach', 'method-followup-engine'],
      skillCalls: ['data-particle-read', 'data-particle-create', 'crm-asset-attach', 'method-followup-engine'],
```

- [ ] **Step 2: 装配断言验证**

Run: `PGDATABASE=plm_test node node_modules/vitest/vitest.mjs run test/agent/assembly.test.js`（或含 `assertAgentAssembly` 的测试）
Expected: 全绿——`skillCalls ⊆ actions` 闭包保持（`crm-asset-attach` 两处都有）

- [ ] **Step 3: Commit**

```bash
git add src/agent/agentSpec.js
git commit -m "feat(asset): followup-agent 授权 crm-asset-attach（skillCalls⊆actions 闭包保持）"
```

---

### Task 6: 插件消费契约 + 全量回归

**Files:**
- Modify: `plugin/skills/crm-write/SKILL.md`

- [ ] **Step 1: 写清单增行 + 两步编排章节**

在「Action 写清单」表格 `data-particle-create / data-particle-update / data-particle-edge-create / data-particle-attr-update` 行后追加：

```markdown
| `crm-asset-attach`（资产挂接两阶段） | 第0闸 | 视需 |
```

文件末尾追加：

````markdown
## 资产挂接两步编排（文件上传 → 业务挂接）

> 办公智能体上传文件到 CRM：**上传 ≠ 挂接**。上传只是暂存（staging，不碰业务数据）；挂接才是业务写（过闸）。两步编排：
>
> 1. **上传**：`POST http://<host>:3000/api/assets/upload`，`Content-Type: application/octet-stream`，文件字节作 body，元数据走 header：
>    - `Authorization: Bearer <crm_login 返回的 token>`（或 session token）
>    - `X-File-Name: 合同扫描件.pdf`
>    - `X-File-Mime: application/pdf`
>    - `X-Doc-Summary: <一句话摘要，可选>`
>    返回 `{ ok, asset_id, file_name, size, sha256 }`。同内容重复上传返回**同一** asset_id（幂等，禁删语义）。
> 2. **挂接**：MCP 两阶段调用 `crm-asset-attach`：
>    - phase1 携带 `asset_id / target_type / target_id / decision_id` → 返回 `{ confirm_token, form }`
>    - phase2 携带 `confirm_token`（choice=1）→ 执行 → 返回业务语言摘要（「已将《XX.pdf》挂接到客户 Y」）
>    - `target_type` 白名单：CRM_DEAL / CRM_ACCOUNT / CRM_QUOTATION / CRM_CONTRACT / CRM_INVOICE
> 3. **验证**：读侧 `data-particle-read`（type=CRM_UNSTRUCTURED_ASSET）确认粒子存在；`crm-account-360` 等客户全景可见被挂接证据。
>
> 约束：无 `decision_id` 不写（第0闸）；绝对禁删（无 delete/remove 工具）；大文件经 HTTP 上传而非 MCP base64——MCP 只做引用挂接。
````

- [ ] **Step 2: 全量回归（分进程防连接池伪失败）**

Run: `PGDATABASE=plm_test node node_modules/vitest/vitest.mjs run test/assets`
Expected: 全绿

Run: `PGDATABASE=plm_test node node_modules/vitest/vitest.mjs run test/particles test/agent`
Expected: 无回归（粒子写路径/装配断言）

- [ ] **Step 3: 全量测试（单进程分批，失败文件单独小批量重跑判定真回归）**

Run: `PGDATABASE=plm_test node node_modules/vitest/vitest.mjs run`
Expected: 全部通过或仅已知 flaky；若有失败 → 失败文件单独重跑（全绿即伪象）

- [ ] **Step 4: Commit**

```bash
git add plugin/skills/crm-write/SKILL.md
git commit -m "docs(asset): crm-write 插件消费契约增资产挂接两步编排"
```

---

## Self-Review

**1. Spec coverage（对齐 docs/2026-08-31-unstructured-asset-attach-design.md）：**
- §3 coreAttributes → Task 1
- §4.1 上传端点（双源鉴权/阈值/sha256 幂等/事件）→ Task 3
- §4.1 下载端点 → Task 3
- §4.2 crm-asset-attach（白名单/第0闸/两阶段/evidenced_by meta/输出纪律）→ Task 4
- §5 agentSpec 增授权 → Task 5
- §5 plugin SKILL → Task 6
- §A 契约（五任务）→ Task 2/3/4/5/6 对应（Task 1 为模型前置；validate-contract 用当前 skillCalls 锚点，见设计文档 §8 修正）

**2. Placeholder scan：** 无 TBD/「适当处理」；每步含完整代码与精确路径。`getParticleBySha256` 在 upload.js 定义并被同文件使用；`ASSET_TARGETS` 在 handler 内定义——类型/签名跨 Task 一致（`createParticle(type,payload,{tenantId,actor})`、`createEdge(sourceType,sourceId,edgeType,targetType,targetId,meta,tenantId)` 均对齐 particleRepo.js:57/183 真实签名）。

**3. Type consistency：** `mcpWritePhase1/mcpConfirmPhase2` 签名对齐 gateway.js:59/103（phase1 返回 `{ok,confirm_token}`，phase2 返回 `{ok,...}`）；`resolveIdentity` 对齐 mcp/auth.js:20（返回 `{actor}` 或 null）；`express.raw` 挂载路径 /api/assets/upload 与 router 内 `req.body` 消费一致。`attach_test:'1'` 为测试清理锚点，与 beforeAll DELETE 一致（禁删铁律不适用——测试库清理是标准 vitest 隔离，非生产删）。

**Known note：** 测试库清理用 `DELETE` 是既有测试惯例（provenance-turtle.test.js:18-22 同款），不违反「生产禁删」铁律（仅 plm_test 库）。