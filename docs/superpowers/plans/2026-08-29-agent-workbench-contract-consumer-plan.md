# 监控台契约消费 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `/agents` 监控台真正消费 living contract——解析 `docs/**/*.md` 的 `contract-yaml`，做静态 skills/memory 校验、可选 success 探针、人工裁定缺口写回 PG `contract_feedback`，形成「设计埋点→运行校验→回写→P0 吸收」闭环。

**Architecture:** 解析内核从 `scripts/validate-contract.mjs` 抽为 `src/contract/contractParser.js`（纯函数、零副作用，原脚本改为 re-export）；`contractService.js` 负责 glob+解析+静态校验，`contractStore.js` 负责 PG 反馈 upsert/读取，`probe.js` 负责 success 探针；`contractRouter.js` 暴露 `GET /api/contracts`（公开）+ `POST /api/contracts/feedback|probe`（sysadmin 闸）；前端 `contractsPage.js` 在 `/agents` 渲染「契约监测」区。所有写操作绝对禁删，仅 upsert/状态迁移。

**Tech Stack:** Node 22 ESM · Express 4 · PostgreSQL（crm schema，复用 `src/db.js` 的 `query`）· 浏览器 ESM 渲染（零服务端 import，对齐 `sevenDimRender.js`/`agentsPage.js`）。

**设计文档：** `docs/specs/2026-08-29-agent-workbench-contract-consumer-design.md`（已批准）

---

## 文件结构（创建/修改一览）

| 文件 | 动作 | 职责 |
|------|------|------|
| `src/contract/contractParser.js` | 新建 | 解析内核纯函数（`stripQuotes`/`parseInlineList`/`parseInlineMap`/`parseValue`/`extractContractBlocks`/`parseContractYaml`/`validateContracts`/`loadRegistry`） |
| `scripts/validate-contract.mjs` | 修改 | 改为 `re-export` 自 contractParser.js；CLI `main()` 不变（测试/行为不变） |
| `db/schema.sql` | 修改 | 末尾追加 `crm.contract_feedback` 表（幂等 `CREATE TABLE IF NOT EXISTS` + `UNIQUE(doc_path,task,gap_type)`） |
| `src/contract/contractService.js` | 新建 | `defaultWalk` + `staticCheck` + `collectContracts`（glob docs、解析、静态校验；`walk`/`readFile` 可注入） |
| `src/contract/contractStore.js` | 新建 | `getFeedback` / `upsertFeedback`（PG；`ON CONFLICT` 幂等；无 DELETE） |
| `src/contract/probe.js` | 新建 | `isSameOriginApiPath` / `evaluateProbe` / `runProbe`（v1 仅 `http_get`，限同源 `/api/**`） |
| `src/http/contractRouter.js` | 新建 | `createContractRouter({ deps })` 工厂；`GET /api/contracts`、`GET /api/contracts/export`、`POST /api/contracts/feedback`、`POST /api/contracts/probe` |
| `src/http/routes.js` | 修改 | 顶部 import `createContractRouter` + `createRoutes` 内 `app.use(createContractRouter())`；新增 `/portal/contractsPage.js` 静态路由 |
| `src/portal/contractsPage.js` | 新建 | 纯渲染 `renderContracts(data)`（浏览器 ESM；skills/memory chip 着色 + 反馈列表 + 探针/记录缺口按钮） |
| `src/web/agents.html` | 修改 | 装配卡片下新增「契约监测」区容器 + module 脚本（拉取/渲染/探针/记录缺口） |
| `scripts/export-contract-feedback.mjs` | 新建 | `exportContractFeedback({ query })` 库函数 + CLI（导出 JSON 供 `aggregate-feedback.mjs` 消费） |
| `test/living-contract/parser.test.js` | 新建 | 解析内核单测 + re-export 奇偶校验（含 `probe` 内联映射） |
| `test/living-contract/service.test.js` | 新建 | `collectContracts` + `staticCheck` 注入式单测 |
| `test/living-contract/store.test.js` | 新建 | `upsertFeedback` 幂等 + `getFeedback`（真实 plm_test，beforeAll 自举建表） |
| `test/living-contract/router.test.js` | 新建 | router 工厂注入式单测（GET/POST 形态、探针写回） |
| `test/living-contract/render.test.js` | 新建 | `renderContracts` 着色/反馈列表单测 |
| `test/living-contract/export.test.js` | 新建 | 导出形状 + `aggregateFeedback` 复现≥2 出提案 |

> 命名说明：仓库已有 `test/contract-service.test.js` / `test/http/contract-detail.test.js` 是关于 **CRM 业务合同粒子（S09）** 的，与本计划的「living contract YAML」无关；本计划测试统一置于新建目录 `test/living-contract/`，避免任何文件名冲突。

---

## Task 1：抽取契约解析内核到 `src/contract/contractParser.js`

**Files:**
- Create: `src/contract/contractParser.js`
- Modify: `scripts/validate-contract.mjs`（改为 re-export，CLI 不变）
- Test: `test/living-contract/parser.test.js`

- [ ] **Step 1: 写失败测试（断言解析内核符号可由新路径导入且 probe 内联映射可解析）**

```js
// test/living-contract/parser.test.js
import { describe, it, expect } from 'vitest';
import {
  stripQuotes, parseInlineList, parseInlineMap, parseValue,
  extractContractBlocks, parseContractYaml, validateContracts,
} from '../../src/contract/contractParser.js';
import * as cli from '../../scripts/validate-contract.mjs';

describe('contractParser 符号导出', () => {
  it('新路径导出全部解析函数', () => {
    expect(typeof extractContractBlocks).toBe('function');
    expect(typeof parseContractYaml).toBe('function');
    expect(typeof validateContracts).toBe('function');
    expect(typeof parseInlineMap).toBe('function');
  });
  it('原 scripts/validate-contract.mjs 仍 re-export 同名符号（既有 test/validate-contract.test.js 不破）', () => {
    expect(typeof cli.extractContractBlocks).toBe('function');
    expect(typeof cli.parseContractYaml).toBe('function');
    expect(typeof cli.validateContracts).toBe('function');
  });
});

describe('probe 可选内联映射解析', () => {
  it('解析含中文 expect_contains 的 probe 块', () => {
    const text = `- task: "t"
  agent: crm-copilot
  skills: [data-particle-read]
  memory: [crm-copilot]
  probe: { type: http_get, path: /api/page/agent-workbench, expect_status: 200, expect_contains: "装配" }
  success: "ok"`;
    const [c] = parseContractYaml(text);
    expect(c.probe).toEqual({ type: 'http_get', path: '/api/page/agent-workbench', expect_status: 200, expect_contains: '装配' });
  });
  it('probe 缺失不影响 REQUIRED 校验（可选字段）', () => {
    const text = `- task: "t"
  agent: crm-copilot
  skills: [data-particle-read]
  memory: [crm-copilot]
  success: "ok"`;
    const r = validateContracts(parseContractYaml(text));
    expect(r.valid).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试确认失败（模块尚不存在）**

Run: `cd /d/system/CRM-ai-native && node node_modules/vitest/vitest.mjs run test/living-contract/parser.test.js`
Expected: FAIL（`Cannot find module '../../src/contract/contractParser.js'`）

- [ ] **Step 3: 创建解析内核（从 validate-contract.mjs 平移，逐字节一致）**

```js
// src/contract/contractParser.js
// 契约解析内核（纯函数，零副作用）。从 scripts/validate-contract.mjs 平移，作为监控台契约消费单一事实源。
export function stripQuotes(s) {
  return s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s;
}
export function parseInlineList(v) {
  const inner = v.slice(1, v.lastIndexOf(']')).trim();
  if (!inner) return [];
  return inner
    .split(',')
    .map((s) => stripQuotes(s.trim()))
    .filter(Boolean);
}
export function parseInlineMap(v) {
  const inner = v.slice(1, v.lastIndexOf('}')).trim();
  const obj = {};
  if (!inner) return obj;
  inner.split(',').forEach((pair) => {
    const ci = pair.indexOf(':');
    if (ci === -1) return;
    const k = pair.slice(0, ci).trim();
    const val = pair.slice(ci + 1).trim();
    obj[k] =
      val.startsWith('[')
        ? parseInlineList(val)
        : val.startsWith('"') && val.endsWith('"')
          ? stripQuotes(val)
          : /^-?\d+$/.test(val)
            ? Number(val)
            : val;
  });
  return obj;
}
export function parseValue(v) {
  if (v.startsWith('[')) return parseInlineList(v);
  if (v.startsWith('{')) return parseInlineMap(v);
  return stripQuotes(v);
}
export function extractContractBlocks(md) {
  const re = /```contract-yaml\s*\n([\s\S]*?)```/g;
  const out = [];
  let m;
  while ((m = re.exec(md)) !== null) out.push(m[1]);
  return out;
}
export function parseContractYaml(text) {
  const lines = text.split(/\r?\n/);
  const contracts = [];
  let cur = null;
  for (const raw of lines) {
    if (!raw.trim()) continue;
    const listMatch = /^-\s+(.*)$/.exec(raw);
    if (listMatch) {
      cur = {};
      contracts.push(cur);
      const rest = listMatch[1];
      const idx = rest.indexOf(':');
      if (idx === -1) continue;
      cur[rest.slice(0, idx).trim()] = parseValue(rest.slice(idx + 1).trim());
      continue;
    }
    const kv = /^\s+([A-Za-z_][A-Za-z_]*):\s*(.*)$/.exec(raw);
    if (kv && cur) {
      cur[kv[1]] = parseValue(kv[2].trim());
    }
  }
  return contracts;
}
export function validateContracts(contracts, { registry } = {}) {
  const REQUIRED = ['task', 'agent', 'skills', 'memory', 'success'];
  const errors = [];
  if (!Array.isArray(contracts)) contracts = [];
  contracts.forEach((c, i) => {
    const where = c && c.task ? `task "${c.task}"` : `contract #${i + 1}`;
    if (c == null) {
      errors.push({ where, field: '(root)', message: 'contract is null' });
      return;
    }
    for (const f of REQUIRED) {
      if (c[f] === undefined || c[f] === null || c[f] === '') {
        errors.push({ where, field: f, message: `missing required field "${f}"` });
      }
    }
    if (c.skills !== undefined && !Array.isArray(c.skills))
      errors.push({ where, field: 'skills', message: 'skills must be a list' });
    if (c.memory !== undefined && !Array.isArray(c.memory))
      errors.push({ where, field: 'memory', message: 'memory must be a list' });
    if (registry && c.agent !== undefined) {
      const spec = registry[c.agent];
      if (!spec) {
        errors.push({ where, field: 'agent', message: `agent "${c.agent}" not found in registry` });
      } else {
        const skills = spec.capabilities?.skillCalls || [];
        const mem = spec.memory?.read || [];
        const layers = spec.capabilities?.knowledgeScope?.layers || [];
        (c.skills || []).forEach((s) => {
          if (!skills.includes(s))
            errors.push({ where, field: 'skills', message: `skill "${s}" not in ${c.agent}.skillCalls` });
        });
        (c.memory || []).forEach((mm) => {
          if (!mem.includes(mm))
            errors.push({ where, field: 'memory', message: `memory "${mm}" not in ${c.agent}.memory.read` });
        });
        (c.knowledge_scope?.layers || []).forEach((l) => {
          if (!layers.includes(l))
            errors.push({ where, field: 'knowledge_scope', message: `layer "${l}" not in ${c.agent}.knowledgeScope.layers` });
        });
      }
    }
  });
  return { valid: errors.length === 0, errors };
}
export async function loadRegistry(p) {
  if (!p) return null;
  const { readFileSync } = await import('node:fs');
  if (p.endsWith('.json')) return JSON.parse(readFileSync(p, 'utf8'));
  const { pathToFileURL } = await import('node:url');
  const mod = await import(pathToFileURL(p).href);
  return mod.agentSpecs || mod.default?.agentSpecs || mod.default || null;
}
```

- [ ] **Step 4: 改 `scripts/validate-contract.mjs` 为 re-export（保留 CLI）**

将 `scripts/validate-contract.mjs` 整体替换为：

```js
// scripts/validate-contract.mjs — CLI 包装；解析内核已迁至 src/contract/contractParser.js（单一事实源）
export * from '../src/contract/contractParser.js';
import {
  extractContractBlocks, parseContractYaml, validateContracts, loadRegistry,
} from '../src/contract/contractParser.js';
import { readFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';

async function main() {
  const args = process.argv.slice(2);
  const docPath = args.find((a) => !a.startsWith('--'));
  const regIdx = args.indexOf('--registry');
  const registry = regIdx !== -1 ? await loadRegistry(args[regIdx + 1]) : null;
  if (!docPath) {
    console.error('usage: node validate-contract.mjs <doc.md> [--registry path]');
    process.exit(2);
  }
  const md = readFileSync(docPath, 'utf8');
  const contracts = extractContractBlocks(md).flatMap((b) => parseContractYaml(b));
  const result = validateContracts(contracts, { registry });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.valid ? 0 : 1);
}

const __invoked = process.argv[1]
  ? fileURLToPath(pathToFileURL(process.argv[1]).href)
  : null;
const __self = fileURLToPath(import.meta.url);
if (__invoked && __invoked.toLowerCase() === __self.toLowerCase()) {
  main();
}
```

- [ ] **Step 5: 运行测试确认通过（新测试 + 既有 validate-contract 测试）**

Run:
```
cd /d/system/CRM-ai-native && node node_modules/vitest/vitest.mjs run test/living-contract/parser.test.js test/validate-contract.test.js
```
Expected: 两组全 PASS。

- [ ] **Step 6: 提交**

```bash
git add src/contract/contractParser.js scripts/validate-contract.mjs test/living-contract/parser.test.js
git commit -m "feat(contract): 抽取契约解析内核到 src/contract/contractParser.js（原脚本 re-export，CLI 不变）"
```

---

## Task 2：建表迁移 `crm.contract_feedback`

**Files:**
- Modify: `db/schema.sql`（末尾追加）
- Test: `test/living-contract/store.test.js`（含建表自举，见 Task 4；本任务先落地 schema 文本）

- [ ] **Step 1: 在 `db/schema.sql` 末尾追加表定义**

在文件最后（`crm.calibration_patch` 表之后）追加：

```sql
-- 契约消费反馈（living contract 运行态；绝对禁删，仅 upsert/状态迁移）
CREATE TABLE IF NOT EXISTS crm.contract_feedback (
  id          BIGSERIAL PRIMARY KEY,
  doc_path    TEXT NOT NULL,
  task        TEXT NOT NULL,
  gap_type    TEXT NOT NULL,   -- success | skill | memory | knowledge_scope | other
  observed    TEXT,
  expected    TEXT,
  severity    TEXT DEFAULT 'warn',  -- info | warn | error
  status      TEXT DEFAULT 'open',  -- open | resolved | wontfix
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE (doc_path, task, gap_type)
);
```

> 幂等：`CREATE TABLE IF NOT EXISTS` + `ON CONFLICT` 保证重跑 migrate 不报错、不重复建表。无需新增种子数据。

- [ ] **Step 2: 验证迁移（连 plm_test 应用 schema，确认表存在）**

Run:
```
cd /d/system/CRM-ai-native && PGDATABASE=plm_test node -e "import('./src/db.js').then(async m=>{await m.query('CREATE TABLE IF NOT EXISTS crm.contract_feedback (id BIGSERIAL PRIMARY KEY, doc_path TEXT NOT NULL, task TEXT NOT NULL, gap_type TEXT NOT NULL, observed TEXT, expected TEXT, severity TEXT DEFAULT \'warn\', status TEXT DEFAULT \'open\', created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now(), UNIQUE(doc_path,task,gap_type))'); const r=await m.query(\"SELECT to_regclass('crm.contract_feedback') AS t\"); console.log('table=',r.rows[0].t); await m.pool.end();})"
```
Expected: `table= crm.contract_feedback`（证明 DDL 语法正确；正式库经 `db/migrate.js` 全量应用）。

- [ ] **Step 3: 提交**

```bash
git add db/schema.sql
git commit -m "feat(db): schema.sql 追加 crm.contract_feedback 表（幂等，UNIQUE(doc_path,task,gap_type)）"
```

---

## Task 3：契约消费服务 `contractService.js`（glob + 静态校验）

**Files:**
- Create: `src/contract/contractService.js`
- Test: `test/living-contract/service.test.js`

- [ ] **Step 1: 写失败测试（注入 walk/readFile，验证解析与静态校验）**

```js
// test/living-contract/service.test.js
import { describe, it, expect } from 'vitest';
import { collectContracts, staticCheck } from '../../src/contract/contractService.js';

const REG = {
  'crm-copilot': {
    capabilities: { skillCalls: ['data-particle-read', 'data-particle-create'], knowledgeScope: { layers: ['L1'] } },
    memory: { read: ['crm-copilot'] },
  },
};
const MD = `前言
\`\`\`contract-yaml
- task: "对齐的契约"
  agent: crm-copilot
  skills: [data-particle-read]
  memory: [crm-copilot]
  success: "ok"
\`\`\`
\`\`\`contract-yaml
- task: "skill 越界的契约"
  agent: crm-copilot
  skills: [ghost-skill]
  memory: [crm-copilot]
  success: "ok"
\`\`\`
尾注`;

describe('collectContracts', () => {
  it('glob 出两块契约并附 doc_path', () => {
    const walk = () => ['docs/x.md'];
    const readFile = (p) => (p === 'docs/x.md' ? MD : '');
    const { docs } = collectContracts({ docsRoot: 'docs', registry: REG, walk, readFile });
    expect(docs).toHaveLength(1);
    expect(docs[0].doc_path).toBe('docs/x.md');
    expect(docs[0].contracts).toHaveLength(2);
  });
  it('无 contract-yaml 的文档被跳过', () => {
    const { docs } = collectContracts({ docsRoot: 'docs', registry: REG, walk: () => ['a.md'], readFile: () => 'no contract' });
    expect(docs).toHaveLength(0);
  });
});

describe('staticCheck', () => {
  it('skills⊆skillCalls → skills_aligned=true', () => {
    const r = staticCheck({ agent: 'crm-copilot', skills: ['data-particle-read'], memory: ['crm-copilot'] }, REG);
    expect(r.skills_aligned).toBe(true);
    expect(r.memory_aligned).toBe(true);
  });
  it('skill 不在 skillCalls → skills_aligned=false 且 issues 标注', () => {
    const r = staticCheck({ agent: 'crm-copilot', skills: ['ghost-skill'], memory: ['crm-copilot'] }, REG);
    expect(r.skills_aligned).toBe(false);
    expect(r.skills_issues[0]).toContain('ghost-skill');
  });
  it('agent 不在注册表 → agent_found=false', () => {
    const r = staticCheck({ agent: 'ghost', skills: [], memory: [] }, REG);
    expect(r.agent_found).toBe(false);
    expect(r.skills_aligned).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /d/system/CRM-ai-native && node node_modules/vitest/vitest.mjs run test/living-contract/service.test.js`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `contractService.js`**

```js
// src/contract/contractService.js — 契约收集 + 静态校验（纯逻辑，DB 无关；walk/readFile 可注入）
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { extractContractBlocks, parseContractYaml } from './contractParser.js';

// 递归收集目录下所有 .md（默认实现；测试可注入）
export function defaultWalk(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const e of entries) {
      const p = join(dir, e);
      let st; try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) stack.push(p);
      else if (e.endsWith('.md')) out.push(p);
    }
  }
  return out;
}

// 静态校验：声明的 skills/memory/knowledge_scope 是否 ⊆ 注册表
export function staticCheck(contract, registry) {
  const spec = registry?.[contract.agent];
  if (!spec) {
    return {
      agent_found: false, skills_aligned: false, memory_aligned: false, knowledge_aligned: false,
      skills_issues: [`agent "${contract.agent}" 不在注册表`],
      memory_issues: [], knowledge_issues: [],
    };
  }
  const skills = spec.capabilities?.skillCalls || [];
  const mem = spec.memory?.read || [];
  const layers = spec.capabilities?.knowledgeScope?.layers || [];
  const skills_issues = (contract.skills || [])
    .filter((s) => !skills.includes(s))
    .map((s) => `skill "${s}" 不在 ${contract.agent}.skillCalls`);
  const memory_issues = (contract.memory || [])
    .filter((m) => !mem.includes(m))
    .map((m) => `memory "${m}" 不在 ${contract.agent}.memory.read`);
  const knowledge_issues = (contract.knowledge_scope?.layers || [])
    .filter((l) => !layers.includes(l))
    .map((l) => `layer "${l}" 不在 ${contract.agent}.knowledgeScope.layers`);
  return {
    agent_found: true,
    skills_aligned: skills_issues.length === 0,
    memory_aligned: memory_issues.length === 0,
    knowledge_aligned: knowledge_issues.length === 0,
    skills_issues, memory_issues, knowledge_issues,
  };
}

export function collectContracts({ docsRoot, registry, walk = defaultWalk, readFile = readFileSync } = {}) {
  const files = walk(docsRoot);
  const docs = [];
  for (const f of files) {
    let md; try { md = readFile(f, 'utf8'); } catch { continue; }
    const blocks = extractContractBlocks(md);
    if (!blocks.length) continue;
    const contracts = blocks
      .flatMap((b) => parseContractYaml(b))
      .map((c) => ({ ...c, doc_path: f, static: staticCheck(c, registry) }));
    if (contracts.length) docs.push({ doc_path: f, contracts });
  }
  return { docs };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd /d/system/CRM-ai-native && node node_modules/vitest/vitest.mjs run test/living-contract/service.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/contract/contractService.js test/living-contract/service.test.js
git commit -m "feat(contract): 新增 contractService 收集 docs 契约并做静态 skills/memory 校验"
```

---

## Task 4：反馈持久化 `contractStore.js` + 探针 `probe.js` + 写回端点 `contractRouter.js`

**Files:**
- Create: `src/contract/contractStore.js`, `src/contract/probe.js`, `src/http/contractRouter.js`
- Modify: `src/http/routes.js`（import + mount + `/portal/contractsPage.js` 路由）
- Test: `test/living-contract/store.test.js`, `test/living-contract/router.test.js`

### 4a 持久化与探针

- [ ] **Step 1: 写 store 失败测试（真实 plm_test，beforeAll 自举建表）**

```js
// test/living-contract/store.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import { query } from '../../src/db.js';
import { upsertFeedback, getFeedback } from '../../src/contract/contractStore.js';

const DDL = `CREATE TABLE IF NOT EXISTS crm.contract_feedback (
  id BIGSERIAL PRIMARY KEY, doc_path TEXT NOT NULL, task TEXT NOT NULL, gap_type TEXT NOT NULL,
  observed TEXT, expected TEXT, severity TEXT DEFAULT 'warn', status TEXT DEFAULT 'open',
  created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (doc_path, task, gap_type))`;

beforeAll(async () => { await query(DDL); });

describe('contractStore', () => {
  it('upsert 幂等：重复同 (doc_path,task,gap_type) 不新增行', async () => {
    const base = { doc_path: 'docs/a.md', task: 'T-x', gap_type: 'success' };
    await upsertFeedback({ ...base, observed: 'first', status: 'open' });
    await upsertFeedback({ ...base, observed: 'second', status: 'resolved' });
    const rows = await getFeedback({ docPath: 'docs/a.md', task: 'T-x' });
    expect(rows).toHaveLength(1);
    expect(rows[0].observed).toBe('second');
    expect(rows[0].status).toBe('resolved');
  });
  it('getFeedback 按 doc_path 过滤', async () => {
    await upsertFeedback({ doc_path: 'docs/b.md', task: 'T-y', gap_type: 'skill', observed: 'x' });
    const all = await getFeedback({});
    const b = await getFeedback({ docPath: 'docs/b.md' });
    expect(b.length).toBeLessThanOrEqual(all.length);
    expect(b[0].doc_path).toBe('docs/b.md');
  });
  it('缺必填抛错', async () => {
    await expect(upsertFeedback({ doc_path: 'd' })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: 实现 `contractStore.js`**

```js
// src/contract/contractStore.js — contract_feedback 持久化（绝对禁删：仅 upsert/状态迁移，无 DELETE）
import { query } from '../db.js';

export async function getFeedback({ docPath, task } = {}) {
  const clauses = [];
  const params = [];
  if (docPath) { params.push(docPath); clauses.push(`doc_path=$${params.length}`); }
  if (task) { params.push(task); clauses.push(`task=$${params.length}`); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const r = await query(`SELECT * FROM crm.contract_feedback ${where} ORDER BY updated_at DESC`, params);
  return r.rows;
}

export async function upsertFeedback(row = {}) {
  const { doc_path, task, gap_type, observed = null, expected = null, severity = 'warn', status = 'open' } = row;
  if (!doc_path || !task || !gap_type) throw new Error('doc_path/task/gap_type 必填');
  const r = await query(
    `INSERT INTO crm.contract_feedback (doc_path, task, gap_type, observed, expected, severity, status, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now())
     ON CONFLICT (doc_path, task, gap_type)
     DO UPDATE SET observed=EXCLUDED.observed, expected=EXCLUDED.expected, severity=EXCLUDED.severity, status=EXCLUDED.status, updated_at=now()
     RETURNING *`,
    [doc_path, task, gap_type, observed, expected, severity, status]
  );
  return r.rows[0];
}
```

- [ ] **Step 3: 实现 `probe.js`**

```js
// src/contract/probe.js — success 探针运行器（v1 仅 http_get，限同源 /api/**）
export function isSameOriginApiPath(path) {
  return typeof path === 'string' && path.startsWith('/api/');
}
export function evaluateProbe(probe, { status, body }) {
  const expStatus = probe?.expect_status;
  const expContains = probe?.expect_contains;
  const issues = [];
  if (expStatus != null && status !== expStatus) issues.push(`status ${status} ≠ 期望 ${expStatus}`);
  if (expContains != null && !String(body).includes(expContains)) issues.push(`响应体不含 "${expContains}"`);
  return { ok: issues.length === 0, observed: issues.join('; ') || 'pass' };
}
export async function runProbe({ fetchImpl, baseUrl, contract }) {
  const probe = contract?.probe;
  if (!probe || probe.type !== 'http_get') throw new Error('无可用 probe（仅支持 http_get）');
  if (!isSameOriginApiPath(probe.path)) throw new Error('probe.path 限同源 /api/**');
  const res = await fetchImpl(baseUrl + probe.path);
  const body = await res.text();
  const ev = evaluateProbe(probe, { status: res.status, body });
  return { status: ev.ok ? 'pass' : 'fail', observed: ev.observed };
}
```

### 4b 路由器

- [ ] **Step 4: 写 router 失败测试（注入式，不连 DB）**

```js
// test/living-contract/router.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import { createContractRouter } from '../../src/http/contractRouter.js';

function mkApp(deps) {
  const app = express();
  app.use(express.json());
  app.use(createContractRouter({ deps }));
  return app;
}

describe('contractRouter（注入式）', () => {
  let server, base;
  const docs = [{ doc_path: 'docs/a.md', contracts: [
    { task: 'T1', agent: 'crm-copilot', skills: ['data-particle-read'], memory: ['crm-copilot'], success: 'ok',
      static: { skills_aligned: true, memory_aligned: true }, probe: { type: 'http_get', path: '/api/x', expect_status: 200 } },
  ] }];
  const calls = { upsert: 0 };
  const deps = {
    collectContracts: () => ({ docs }),
    getFeedback: async () => [],
    upsertFeedback: async (row) => { calls.upsert++; return { ...row, id: 1 }; },
    runProbe: async () => ({ status: 'pass', observed: 'pass' }),
    resolveMe: () => ({ ok: true, role: 'sysadmin' }),
    registry: {}, docsRoot: 'docs',
  };
  beforeAll(async () => { server = mkApp(deps).listen(0); base = `http://127.0.0.1:${server.address().port}`; });
  afterAll(() => server.close());

  it('GET /api/contracts 返回 docs 且任务含 static+feedback', async () => {
    const r = await fetch(`${base}/api/contracts`).then((x) => x.json());
    expect(r.docs).toHaveLength(1);
    expect(r.docs[0].tasks[0].task).toBe('T1');
    expect(r.docs[0].tasks[0].static.skills_aligned).toBe(true);
    expect(r.docs[0].tasks[0].feedback).toEqual([]);
  });
  it('POST /api/contracts/feedback 幂等 upsert（写闸 sysadmin 通过）', async () => {
    const r = await fetch(`${base}/api/contracts/feedback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ doc_path: 'docs/a.md', task: 'T1', gap_type: 'skill', observed: 'x' }) }).then((x) => x.json());
    expect(r.ok).toBe(true);
    expect(calls.upsert).toBe(1);
  });
  it('POST /api/contracts/probe 写 gap_type=success 反馈', async () => {
    const r = await fetch(`${base}/api/contracts/probe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ doc_path: 'docs/a.md', task: 'T1' }) }).then((x) => x.json());
    expect(r.ok).toBe(true);
    expect(r.probe.status).toBe('pass');
  });
  it('非 sysadmin 写操作 → 403', async () => {
    const noAuth = { ...deps, resolveMe: () => ({ ok: false }) };
    const s2 = mkApp(noAuth).listen(0);
    const port = s2.address().port;
    const r = await fetch(`http://127.0.0.1:${port}/api/contracts/feedback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ doc_path: 'd', task: 't', gap_type: 'other' }) });
    expect(r.status).toBe(403);
    s2.close();
  });
});
```

- [ ] **Step 5: 实现 `contractRouter.js`**

```js
// src/http/contractRouter.js — 契约消费端点
// GET /api/contracts（公开，对齐 /api/agents）｜ GET /api/contracts/export ｜
// POST /api/contracts/feedback（sysadmin）｜ POST /api/contracts/probe（sysadmin）｜ 绝对禁删
import { Router } from 'express';
import { resolveMe as realResolveMe } from './auth.js';
import { collectContracts as defaultCollect } from '../contract/contractService.js';
import { getFeedback, upsertFeedback } from '../contract/contractStore.js';
import { runProbe as defaultProbe } from '../contract/probe.js';
import { agentSpecs } from '../agent/agentSpec.js';

function roleOk(role) { return role === 'admin' || role === 'sysadmin'; }

export function createContractRouter({ deps = {} } = {}) {
  const D = {
    collectContracts: defaultCollect,
    getFeedback,
    upsertFeedback,
    runProbe: defaultProbe,
    resolveMe: realResolveMe,
    registry: agentSpecs,
    docsRoot: 'docs',
    ...deps,
  };
  const router = Router();

  const requireWrite = (req, res, next) => {
    let me; try { me = D.resolveMe(req); } catch { me = { ok: false }; }
    if (!me?.ok || !roleOk(me.role)) return res.status(403).json({ error: '需要 sysadmin 权限' });
    next();
  };

  router.get('/api/contracts', async (req, res) => {
    try {
      const { docs } = D.collectContracts({ docsRoot: D.docsRoot, registry: D.registry });
      const out = [];
      for (const doc of docs) {
        const tasks = [];
        for (const c of doc.contracts) {
          const fb = await D.getFeedback({ docPath: c.doc_path, task: c.task });
          tasks.push({ ...c, feedback: fb });
        }
        out.push({ doc_path: doc.doc_path, tasks });
      }
      res.json({ docs: out });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/api/contracts/export', async (req, res) => {
    try { res.json({ feedback: await D.getFeedback({}) }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/api/contracts/feedback', requireWrite, async (req, res) => {
    try { res.json({ ok: true, row: await D.upsertFeedback(req.body || {}) }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });

  router.post('/api/contracts/probe', requireWrite, async (req, res) => {
    try {
      const { doc_path, task } = req.body || {};
      const { docs } = D.collectContracts({ docsRoot: D.docsRoot, registry: D.registry });
      const c = docs.flatMap((d) => d.contracts).find((x) => x.doc_path === doc_path && x.task === task);
      if (!c) return res.status(404).json({ error: '契约未找到' });
      if (!c.probe) return res.status(400).json({ error: '该 task 无 probe 定义' });
      const baseUrl = `${req.protocol}://${req.get('host')}`;
      const result = await D.runProbe({ fetchImpl: fetch, baseUrl, contract: c });
      const saved = await D.upsertFeedback({
        doc_path, task, gap_type: 'success',
        observed: result.observed,
        severity: result.status === 'pass' ? 'info' : 'error',
        status: result.status === 'pass' ? 'resolved' : 'open',
      });
      res.json({ ok: true, probe: result, row: saved });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  return router;
}
```

- [ ] **Step 6: 在 `routes.js` 挂载（import + `app.use` + `/portal/contractsPage.js` 路由）**

在 `src/http/routes.js` 顶部 import 区（靠近 `import { createCalibrationRouter } from './calibrationRouter.js';`）新增：

```js
import { createContractRouter } from './contractRouter.js';
```

在 `createRoutes(app, hub)` 内、`app.use(createCalibrationRouter());`（约 line 103）之后新增：

```js
  // 监控台契约消费（living contract）：GET 公开；POST sysadmin 闸；绝对禁删
  app.use(createContractRouter());
```

在 `/portal/agentsPage.js` 静态路由（约 line 1545）附近新增：

```js
  app.get('/portal/contractsPage.js', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../portal/contractsPage.js', import.meta.url)), { headers: { 'Content-Type': 'text/javascript' } }));
```

- [ ] **Step 7: 运行 store + router 测试确认通过**

Run: `cd /d/system/CRM-ai-native && node node_modules/vitest/vitest.mjs run test/living-contract/store.test.js test/living-contract/router.test.js`
Expected: PASS（store 自举建表；router 注入式不连真实库）

- [ ] **Step 8: 提交**

```bash
git add src/contract/contractStore.js src/contract/probe.js src/http/contractRouter.js src/http/routes.js test/living-contract/store.test.js test/living-contract/router.test.js
git commit -m "feat(contract): 反馈持久化 + success 探针 + /api/contracts 消费端点（写闸 sysadmin，禁删）"
```

---

## Task 5：前端「契约监测」区（`contractsPage.js` + `agents.html`）

**Files:**
- Create: `src/portal/contractsPage.js`
- Modify: `src/web/agents.html`
- Test: `test/living-contract/render.test.js`

- [ ] **Step 1: 写失败测试（渲染着色 + 反馈列表）**

```js
// test/living-contract/render.test.js
import { describe, it, expect } from 'vitest';
import { renderContracts } from '../../src/portal/contractsPage.js';

const DATA = { docs: [{ doc_path: 'docs/a.md', tasks: [
  { task: 'T-ok', agent: 'crm-copilot', skills: ['data-particle-read'], memory: ['crm-copilot'], success: 'ok',
    static: { skills_aligned: true, memory_aligned: true, skills_issues: [], memory_issues: [] },
    feedback: [], probe: null },
  { task: 'T-bad', agent: 'crm-copilot', skills: ['ghost'], memory: ['crm-copilot'], success: 'ok',
    static: { skills_aligned: false, memory_aligned: true, skills_issues: ['skill "ghost" 不在 crm-copilot.skillCalls'], memory_issues: [] },
    feedback: [{ gap_type: 'skill', severity: 'warn', status: 'open', observed: '缺 skill' }], probe: { type: 'http_get', path: '/api/x' } },
] }] };

describe('renderContracts', () => {
  it('对齐契约 skills chip 为 ok 类', () => {
    const html = renderContracts(DATA);
    expect(html).toContain('data-task="T-ok"');
    expect(html).toContain('class="chip ok"'); // T-ok 对齐
  });
  it('越界契约 skills chip 为 fail 类 + 反馈列表渲染', () => {
    const html = renderContracts(DATA);
    expect(html).toContain('chip fail'); // T-bad skills 越界
    expect(html).toContain('缺 skill');
    expect(html).toContain('运行探针'); // 有 probe → 显示按钮
  });
  it('无文档时显示空态', () => {
    expect(renderContracts({ docs: [] })).toContain('未解析到');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /d/system/CRM-ai-native && node node_modules/vitest/vitest.mjs run test/living-contract/render.test.js`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `src/portal/contractsPage.js`（浏览器 ESM，零服务端 import）**

```js
// src/portal/contractsPage.js — /agents 契约监测区纯渲染（浏览器 ESM；零服务端 import）
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderTask(t) {
  const st = t.static || {};
  const skillsChips = (t.skills || [])
    .map((s) => `<span class="chip ${st.skills_aligned ? 'ok' : 'fail'}" title="${esc((st.skills_issues || []).join('; '))}">${esc(s)}</span>`)
    .join('');
  const memChips = (t.memory || [])
    .map((m) => `<span class="chip ${st.memory_aligned ? 'ok' : 'fail'}" title="${esc((st.memory_issues || []).join('; '))}">${esc(m)}</span>`)
    .join('');
  const fb = t.feedback || [];
  const fbRows = fb.length
    ? fb.map((f) => `<li class="fb fb-${esc(f.status)}">[${esc(f.gap_type)}] ${esc(f.severity)} · ${esc(f.status)} — ${esc(f.observed || '')}</li>`).join('')
    : '<li class="fb-empty">无记录</li>';
  const probeBtn = t.probe ? `<button class="btn probe" data-doc="${esc(t.doc_path)}" data-task="${esc(t.task)}">运行探针</button>` : '';
  return `<div class="contract-task" data-doc="${esc(t.doc_path)}" data-task="${esc(t.task)}">
    <div class="ct-head"><b>${esc(t.task)}</b> <span class="agent-tag">${esc(t.agent)}</span></div>
    <div class="ct-line">skills: <span class="chips">${skillsChips}</span></div>
    <div class="ct-line">memory: <span class="chips">${memChips}</span></div>
    ${t.success ? `<div class="ct-line success">✓ ${esc(t.success)}</div>` : ''}
    <ul class="fb-list">${fbRows}</ul>
    <div class="ct-actions">${probeBtn}<button class="btn gap" data-doc="${esc(t.doc_path)}" data-task="${esc(t.task)}">记录缺口</button></div>
  </div>`;
}

export function renderContracts(data = {}) {
  const docs = data.docs || [];
  if (!docs.length) return '<div class="empty">未解析到含 contract-yaml 的设计文档</div>';
  return docs.map((d) => {
    const tasks = (d.tasks || []).map(renderTask).join('');
    return `<section class="contract-doc"><h3 class="doc-title">${esc(d.doc_path)}</h3><div class="contract-tasks">${tasks}</div></section>`;
  }).join('');
}
```

- [ ] **Step 4: 修改 `src/web/agents.html`——新增「契约监测」区**

在 `</body>` 之前（`<script type="module"> injectLayout` 之前）插入：

```html
<section id="contracts" class="panel">
  <h2>契约监测 <span class="sub">living contract 消费 · 静态校验 + 探针 + 人工裁定</span></h2>
  <div id="contract-board">加载中…</div>
</section>
<script type="module">
  import { get, post } from '/portal/api.js';
  import * as cp from '/portal/contractsPage.js';
  const board = document.getElementById('contract-board');
  async function loadContracts() {
    try {
      const data = await get('/api/contracts');
      board.innerHTML = cp.renderContracts(data);
    } catch (e) { board.textContent = '加载失败: ' + e.message; }
  }
  document.getElementById('contracts').addEventListener('click', async (ev) => {
    const t = ev.target;
    if (t.classList.contains('probe')) {
      const r = await post('/api/contracts/probe', { doc_path: t.dataset.doc, task: t.dataset.task }).catch((e) => ({ error: e.message }));
      if (r.error) alert('探针失败: ' + r.error); else alert('探针结果: ' + (r.probe?.status || '?'));
      loadContracts();
    }
    if (t.classList.contains('gap')) {
      const gap_type = prompt('缺口类型 (skill|memory|success|knowledge_scope|other):', 'other');
      if (!gap_type) return;
      const observed = prompt('观测到的问题:', '');
      if (observed === null) return;
      const r = await post('/api/contracts/feedback', { doc_path: t.dataset.doc, task: t.dataset.task, gap_type, observed, severity: 'warn', status: 'open' }).catch((e) => ({ error: e.message }));
      if (r.error) alert('记录失败: ' + r.error); else loadContracts();
    }
  });
  loadContracts();
  setInterval(loadContracts, 15000);
</script>
```

并在 `<style>` 内补充最小样式（保证 chip/按钮可见，复用既有变量）：

```css
.panel { margin-top: 24px; border-top: 1px solid var(--line); padding-top: 12px; }
#contracts h2 { font-size: 16px; margin: 0 0 8px; }
#contracts .sub { color: var(--mut); font-size: 12px; font-weight: 400; }
.contract-doc { margin-bottom: 16px; }
.doc-title { font-size: 13px; color: var(--mut); margin: 0 0 6px; }
.contract-task { border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; margin-bottom: 8px; background: var(--panel); }
.ct-head { font-size: 14px; margin-bottom: 4px; }
.agent-tag { font-size: 11px; color: var(--mut); border: 1px solid var(--line); border-radius: 8px; padding: 0 6px; }
.ct-line { font-size: 12px; margin: 3px 0; }
.ct-line.success { color: var(--ok); }
.fb-list { margin: 6px 0; padding-left: 18px; font-size: 12px; }
.fb-empty { color: var(--mut); list-style: none; margin-left: -18px; }
.fb-open { color: var(--warn); } .fb-resolved { color: var(--ok); } .fb-wontfix { color: var(--mut); }
.ct-actions { margin-top: 6px; display: flex; gap: 8px; }
.btn { font-size: 12px; padding: 3px 10px; border-radius: 6px; border: 1px solid var(--line); background: var(--panel); cursor: pointer; }
.btn.probe { background: var(--ok); color: #fff; border-color: var(--ok); }
```

- [ ] **Step 5: 运行渲染测试确认通过**

Run: `cd /d/system/CRM-ai-native && node node_modules/vitest/vitest.mjs run test/living-contract/render.test.js`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/portal/contractsPage.js src/web/agents.html test/living-contract/render.test.js
git commit -m "feat(ui): /agents 新增契约监测区（静态着色+探针+记录缺口，零服务端 import）"
```

---

## Task 6：P0 吸收导出器 `export-contract-feedback.mjs`

**Files:**
- Create: `scripts/export-contract-feedback.mjs`
- Test: `test/living-contract/export.test.js`

- [ ] **Step 1: 写失败测试（导出形状 + aggregateFeedback 复现≥2 出提案）**

```js
// test/living-contract/export.test.js
import { describe, it, expect } from 'vitest';
import { exportContractFeedback } from '../../scripts/export-contract-feedback.mjs';
import { aggregateFeedback } from '../../scripts/aggregate-feedback.mjs';

describe('export-contract-feedback', () => {
  it('导出数组形状（供 aggregate-feedback.mjs 消费）', async () => {
    const rows = [
      { doc_path: 'd', task: 'T', gap_type: 'success', agent: 'crm-copilot', observed: 'x', expected: 'y', severity: 'info', status: 'resolved' },
      { doc_path: 'd', task: 'T', gap_type: 'success', agent: 'crm-copilot', observed: 'x', expected: 'y', severity: 'info', status: 'resolved' },
      { doc_path: 'd', task: 'X', gap_type: 'skill', agent: 'crm-copilot', observed: 'z', expected: '', severity: 'warn', status: 'open' },
    ];
    const list = await exportContractFeedback({ query: async () => ({ rows }) });
    expect(Array.isArray(list)).toBe(true);
    expect(list).toHaveLength(3);
    expect(list[0]).toHaveProperty('task');
    expect(list[0]).toHaveProperty('gap_type');
  });
  it('复现≥2 同 (task,gap_type) → aggregateFeedback 产出 requiresApproval 提案', async () => {
    const rows = [
      { task: 'T', gap_type: 'success', agent: 'crm-copilot', observed: 'x', expected: 'y' },
      { task: 'T', gap_type: 'success', agent: 'crm-copilot', observed: 'x', expected: 'y' },
    ];
    const list = await exportContractFeedback({ query: async () => ({ rows }) });
    const proposals = aggregateFeedback(list);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].requiresApproval).toBe(true);
    expect(proposals[0].occurrences).toBe(2);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /d/system/CRM-ai-native && node node_modules/vitest/vitest.mjs run test/living-contract/export.test.js`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `scripts/export-contract-feedback.mjs`**

```js
// scripts/export-contract-feedback.mjs
// 导出 crm.contract_feedback → JSON（供 aggregate-feedback.mjs 生成 P0 改进提案；仅提案需批准）
import { query as defaultQuery } from '../src/db.js';
import { writeFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';

export async function exportContractFeedback({ query = defaultQuery } = {}) {
  const r = await query(`SELECT doc_path, task, gap_type, agent, observed, expected, severity, status, created_at, updated_at
                         FROM crm.contract_feedback ORDER BY updated_at DESC`);
  return r.rows;
}

async function main() {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('-o');
  const out = outIdx !== -1 ? args[outIdx + 1] : 'tmp/contract-feedback-export.json';
  const rows = await exportContractFeedback();
  writeFileSync(out, JSON.stringify(rows, null, 2), 'utf8');
  console.log(`[export] ${rows.length} 条反馈 → ${out}（交给 aggregate-feedback.mjs 生成提案）`);
}

const __invoked = process.argv[1] ? fileURLToPath(pathToFileURL(process.argv[1]).href) : null;
const __self = fileURLToPath(import.meta.url);
if (__invoked && __invoked.toLowerCase() === __self.toLowerCase()) {
  main().catch((e) => { console.error('[export] 失败:', e.message); process.exit(1); });
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd /d/system/CRM-ai-native && node node_modules/vitest/vitest.mjs run test/living-contract/export.test.js`
Expected: PASS

- [ ] **Step 5: 端到端冒烟（CLI → aggregate）**

Run:
```
cd /d/system/CRM-ai-native && node scripts/export-contract-feedback.mjs -o tmp/contract-feedback-export.json && node scripts/aggregate-feedback.mjs tmp/contract-feedback-export.json
```
Expected: 打印 `{ "proposals": [...] }`（若库内已有复现≥2 缺口则含 `requiresApproval:true` 提案；空库则 `proposals:[]`）。

- [ ] **Step 6: 提交**

```bash
git add scripts/export-contract-feedback.mjs test/living-contract/export.test.js
git commit -m "feat(contract): 新增 export-contract-feedback.mjs 对接 aggregate-feedback P0 吸收"
```

---

## 集成验证（手动，非单测）

1. 重新迁移测试/生产库以建表：
   ```
   cd /d/system/CRM-ai-native && PGDATABASE=plm_test node db/migrate.js
   ```
2. 启动服务，验证 GET 公开可达、POST 需 sysadmin：
   ```
   curl -s localhost:3000/api/contracts | head -c 400        # 应含 docs[] 且解析出本设计文档的 7 个契约块
   curl -s -X POST localhost:3000/api/contracts/feedback -H 'Content-Type: application/json' -d '{"doc_path":"docs/specs/2026-08-29-agent-workbench-contract-consumer-design.md","task":"抽取契约解析器到 src/contract/contractParser.js","gap_type":"skill","observed":"示例缺口"}'
   ```
3. 浏览器打开 `/agents`，确认出现「契约监测」区，skills/memory chip 着色正确；点「记录缺口」→ 入库 → 即时刷新；给某 task 的契约块加 `probe:` 后点「运行探针」→ 写 `gap_type=success` 反馈。

---

## 自我评审（Spec 覆盖核对）

- §0 目标/范围 → T1–T6 全部覆盖；不在范围项（遥测/第4 agent/改 .md）明确未做。
- §1 数据流 → `/api/contracts`(T4) + 前端(T5) + 导出(T6) + PG(T2) 组成闭环。
- §2 决策 D1–D4 → D1 混合渐进(T4 probe+静态)、D2 全量 glob(T3 defaultWalk)、D3 PG 表(T2)、D4 /agents(T5)。
- §3 六任务 → 与 T1–T6 一一对应，各带 living contract（已落设计文档，自检通过）。
- §4 probe schema → T4 `probe.js` + 设计文档 §4 示例；限同源 `/api/**`。
- §5 偏离 → GET 公开（对齐 `/api/agents`），写入 sysadmin 闸（已实施并在 router 测试中覆盖 403）；`.md` 不改写（前端只读渲染）。
- §6 验收 → 集成验证清单 1–3 对应；T6 单测断言复现≥2 出提案；T1 断言原 validate-contract 测试不破。
- 类型一致性：`collectContracts`→`{docs:[{doc_path,contracts:[{...c,doc_path,static}]}]}`；router GET 包成 `{docs:[{doc_path,tasks}]}`（tasks 已含 feedback）；render 消费 `docs[].tasks[]`——前后字段名一致。`upsertFeedback(row)` 的 row 形状在 store/router/前端三处一致（`doc_path,task,gap_type,observed,expected,severity,status`）。
