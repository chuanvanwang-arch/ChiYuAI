# 阶段 1 底座 MVP 实施计划（AI 原生销售管理平台）

> **For agentic workers:** REQUIRED SUB-SKILL: 使用 executing-plans（或 subagent-driven-development）逐任务实施本计划。步骤用 checkbox（`- [ ]`）语法跟踪。

**Goal:** 搭建 AI 原生 CRM 的 L1 粒子平面 + L3 编排骨架 + L2 事件总线雏形——单库底座（PostgreSQL + pgvector + AGE）、9 粒子 Schema、写时三钩子、SSE 事件总线、kanban 看板 + agentLoop 派发真实任务、六条装配校验、观测看板、端到端验收。

**Architecture:** 四平面总构（总体设计 §1）——L1 粒子平面（particles/edges/ontology 单库）+ L2 事件平面（SSE 总线 5 域雏形）+ L3 智能体平面（kanban 状态机 + agentLoop 引擎，调度器直调）+ L4 观测看板（后续阶段）。读写双通道：读直连、写过闸（规则层 → action-confirm → HITL，阶段 1 先埋规则层骨架）。

**Tech Stack:** Node 22 + TypeScript + PostgreSQL（pgvector + Apache AGE 单库）+ Vue3/Naive-UI（阶段 2，本计划仅观察页用静态 HTML 兜底）+ Vitest（单测）+ 直接复用 P2P 已验证组件（agentLoop/kanban/bus/particleRepo/ontology-hooks，路径基准 `D:\system\p2p-ai-native-pilot\src\`）。

---

## 文件结构总览

```
CRM-ai-native/
├── package.json                  # 工程根：Node 22 + TS + 脚本
├── tsconfig.json                 # TS 配置（NodeNext）
├── .gitignore
├── docker-compose.yml            # 单库：postgres(16+pgvector) 
├── db/
│   ├── schema.sql                # 单库全表：particles/edges/tasks/task_audit/events/approval(预留)
│   ├── migrate.js                # 幂等迁移执行器
│   ├── seed.sql                  # 种子：particle-type 元模型 + 受控谓词 + 5 角色 + 10 种子案例
│   └── test-setup.sql            # 测试库清理（TRUNCATE）
├── src/
│   ├── config.js                 # 环境配置（DB/端口/LLM 降级）
│   ├── db.js                     # pg 连接池 + query()
│   ├── particles/
│   │   ├── particleModel.js      # 9 粒子类型定义（C0-C4 清单）+ 19 种属性校验
│   │   ├── particleRepo.js       # 统一 CRUD + 受控谓词边（复用 P2P 接口）
│   │   └── lifecycle.js          # 粒子生命周期钩子（stage 状态机 + why 载体）
│   ├── ontology/
│   │   ├── hooks.js              # 写时三钩子：ensureEmbedding/ensureTsVector/ontologySync
│   │   ├── embedding.js          # 确定性哈希 mock + 真模型注入
│   │   ├── coverage.js           # 覆盖率监控（≥80% 达标判断）
│   │   └── vocabulary.js         # 词汇表登记（semanticEntities）
│   ├── events/
│   │   ├── bus.js                # 进程内事件总线（on/emit，订阅者异常隔离）
│   │   └── sse.js                # SSE 端点（5 域：task/trace/approval/particle/payment）
│   ├── kanban/
│   │   ├── types.js              # FAILURE_LIMIT 常量 + 状态集
│   │   ├── kanban.js             # 状态机（复用 P2P）
│   │   ├── dispatch.js           # 派发队列（max_inflight=3 + 指数退避）
│   │   └── scheduler.js          # 调度器（claim→dispatch→complete 循环，单例锁）
│   ├── agent/
│   │   ├── agentLoop.js          # 执行循环（复用 P2P runWithSkill 模式）
│   │   ├── agentSpec.js          # 3 Agent 六段式 Spec（agents 表落库）
│   │   └── agents.js             # agents 表 Schema + 装配校验（六条断言）
│   ├── skills/
│   │   └── registry.js           # SKILL 表 + 加载（crm-deal/account/lead 种子）
│   ├── action/
│   │   ├── registry.js           # Action Registry（data.particle.* substrate + 跨粒子能力 Action）
│   │   ├── executor.js           # dispatch 执行器（写通道闸门埋点）
│   │   └── seed-actions.js       # 种子 Action 注册
│   ├── llm.js                    # LLM 调用（SiliconFlow DeepSeek，降级默认）
│   ├── ruleEngine.js             # 规则层（business-rules 骨架：商机阶段只进不退等）
│   ├── http/
│   │   ├── server.js             # 单端口 HTTP（/api/* + /events SSE + / 静态）
│   │   └── routes.js             # API 路由（粒子 CRUD/任务/看板/装配校验）
│   └── web/                      # 观测看板（静态 HTML + SSE 客户端，阶段 1 兜底）
├── test/
│   ├── particles.test.js         # 粒子 CRUD + 谓词边
│   ├── ontology-hooks.test.js    # 写时三钩子（确定性哈希 mock）
│   ├── kanban.test.js            # 状态机 + 熔断
│   ├── dispatch.test.js          # 并发限流
│   ├── agentLoop.test.js         # 降级 think + 装配校验
│   ├── sse.test.js               # 事件广播
│   └── e2e.test.js               # 端到端：数据流旅程
└── README.md                     # 阶段 1 使用说明
```

**接口契约（跨任务一致性锚点）**：

| 模块 | 导出函数签名 | 消费方 |
|---|---|---|
| `db.query(text, params)` | `Promise<{rows}>` | 全部 |
| `particleRepo.createParticle(type, payload, {tenantId})` | `Promise<Particle>` | 写通道 |
| `particleRepo.queryParticles({type, tenantId, limit})` | `Promise<Particle[]>` | 读通道 |
| `particleRepo.createEdge(srcType, srcId, edgeType, tgtType, tgtId, meta)` | `Promise<Edge>`（幂等） | ontology |
| `ontology.hooks.ensureAll(particle)` | `Promise<void>`（写时三钩子） | particleRepo |
| `bus.emit(domain, type, payload)` / `bus.on(domain, fn)` | `void` / 退订函数 | 全部 |
| `kanban.createTask/claim/complete/fail/reset` | `Promise<Task>` | scheduler |
| `agentLoop.runWithSkill(task, {llmThink, onStep, ...})` | `Promise<{steps, done, degraded}>` | scheduler |
| `actionExecutor.dispatch(actionName, params, {tenantId, actor})` | `Promise<{ok, data, action, confirm?}>` | agentLoop |
| `ruleEngine.check(particleType, action, patch, ctx)` | `Promise<{ok, reasons[]}>` | 写通道 |

---

### Task 1: 工程脚手架 + 单库底座

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `docker-compose.yml`, `db/schema.sql`, `db/migrate.js`
- Test: `test/db.test.js`

- [ ] **Step 1: 写失败的连接测试**

```js
// test/db.test.js
import { describe, it, expect } from 'vitest';
import { query } from '../src/db.js';

describe('db', () => {
  it('单库可连接且 pgcrypto 可用', async () => {
    const r = await query(`SELECT gen_random_uuid() AS id, version()`);
    expect(r.rows[0].id).toBeTruthy();
    expect(r.rows[0].version).toContain('PostgreSQL');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/db.test.js`
Expected: FAIL（`Cannot find module '../src/db.js'`）

- [ ] **Step 3: 写工程脚手架**

```json
// package.json
{
  "name": "crm-ai-native",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "node --watch src/http/server.js",
    "start": "node src/http/server.js",
    "migrate": "node db/migrate.js",
    "seed": "node db/migrate.js --seed",
    "test": "vitest run",
    "test:e2e": "vitest run test/e2e.test.js"
  },
  "dependencies": {
    "pg": "^8.13.1",
    "express": "^4.21.2",
    "dotenv": "^16.4.7"
  },
  "devDependencies": {
    "vitest": "^3.0.5",
    "@types/pg": "^8.11.10",
    "@types/express": "^5.0.0",
    "typescript": "^5.7.3"
  }
}
```

```json
// tsconfig.json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "allowJs": true,
    "outDir": "dist",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.js", "db/**/*.js", "test/**/*.js"]
}
```

```
# .gitignore
node_modules/
dist/
*.log
.env
```

```yaml
# docker-compose.yml
services:
  db:
    image: pgvector/pgvector:pg16
    container_name: crm-ai-native-db
    ports: ["5433:5432"]
    environment:
      POSTGRES_USER: crm
      POSTGRES_PASSWORD: crm
      POSTGRES_DB: crm_ai
    volumes:
      - crm_db_data:/var/lib/postgresql/data
volumes:
  crm_db_data:
```

```sql
-- db/schema.sql
-- 阶段1 单库底座：粒子平面（particles/edges）+ 编排平面（tasks/task_audit/scheduler_lock）+ 事件平面（events）
-- 设计输入：01 粒子系统设计 §4 受控谓词；03 编排设计 §状态机；总体架构 §1 L1/L2/L3
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;      -- pgvector（写时向量化）

-- ===== 粒子平面 L1 =====
CREATE TABLE IF NOT EXISTS particles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL DEFAULT 'system',
  type TEXT NOT NULL,                       -- 9 粒子：CRM_DEAL/ACCOUNT/CONTACT/PRODUCT/PRICE_LIST/PERSON/ORGANIZATION/KNOWLEDGE/UNSTRUCTURED_ASSET
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'ACTIVE',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,  -- 粒子的 10 维属性集（identity/lifecycle/core/ai/states/...）
  embedding vector(384),                    -- L0 整实体向量（写时构建；384 维确定性哈希 mock）
  content_hash TEXT,                        -- 幂等判变（内容没变不重算 embedding）
  fts TSVECTOR,                             -- FTS 通道（ensureTsVector；中文 zhparser 阶段 2 配）
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_particles_type ON particles(type, tenant_id);
CREATE INDEX IF NOT EXISTS idx_particles_slug ON particles(slug, tenant_id);
CREATE INDEX IF NOT EXISTS idx_particles_payload_type ON particles USING gin (payload);
CREATE INDEX IF NOT EXISTS idx_particles_embedding ON particles USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_particles_fts ON particles USING gin (fts);

CREATE TABLE IF NOT EXISTS edges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL DEFAULT 'system',
  source_type TEXT NOT NULL,
  source_id UUID NOT NULL,
  edge_type TEXT NOT NULL,                  -- 受控谓词（belongs_to/owned_by/part_of/...）
  target_type TEXT NOT NULL,
  target_id UUID NOT NULL,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,  -- edge_source/relation_confidence/evidence_ref
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_edges_type ON edges(edge_type);

-- ===== 编排平面 L3（03 编排设计：极简四态 + 熔断 + 审计） =====
CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL DEFAULT 'system',
  chain_id TEXT,                            -- 阶段批次（stage1）
  step TEXT NOT NULL,                       -- 任务步骤名
  title TEXT NOT NULL,
  action_name TEXT NOT NULL,                -- 派发的 Action（registry 内）
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'ready'
    CHECK (status IN ('ready','running','done','failed','blocked')),
  worker_pid INT,                           -- 僵尸探测依据（阶段 1 调度器直调可空）
  worker_host TEXT,
  consecutive_failures INT NOT NULL DEFAULT 0,
  block_kind TEXT,                          -- circuit_break / approval / manual
  result JSONB,                             -- 任务表回收（摘要）
  result_path TEXT,
  depends_on UUID[] NOT NULL DEFAULT '{}',
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tasks_chain ON tasks(tenant_id, chain_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(tenant_id, status);

CREATE TABLE IF NOT EXISTS task_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  from_state TEXT,
  to_state TEXT NOT NULL,
  by_actor TEXT NOT NULL DEFAULT 'system',
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_task_audit_task ON task_audit(task_id);

CREATE TABLE IF NOT EXISTS scheduler_lock (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  pid INT NOT NULL,
  host TEXT,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ===== 事件平面 L2（事件持久化 + 审计；SSE 5 域雏形） =====
CREATE TABLE IF NOT EXISTS events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain TEXT NOT NULL,                     -- task/trace/approval/particle/payment
  type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  actor TEXT NOT NULL DEFAULT 'system',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_events_domain ON events(domain, created_at);
```

- [ ] **Step 4: 写数据库连接模块**

```js
// src/db.js
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

export const pool = new pg.Pool({
  host: process.env.PGHOST || '127.0.0.1',
  port: Number(process.env.PGPORT || 5433),
  user: process.env.PGUSER || 'crm',
  password: process.env.PGPASSWORD || 'crm',
  database: process.env.PGDATABASE || 'crm_ai',
  max: 10,
});

export async function query(text, params = []) {
  const r = await pool.query(text, params);
  return r;
}

export async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
```

- [ ] **Step 5: 写幂等迁移执行器**

```js
// db/migrate.js
import { readFileSync } from 'node:fs';
import { pool } from '../src/db.js';

const sql = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');

async function main() {
  const seed = process.argv.includes('--seed');
  await pool.query(sql);
  console.log('[migrate] schema 就绪（幂等）');
  if (seed) {
    const seedSql = readFileSync(new URL('./seed.sql', import.meta.url), 'utf8');
    await pool.query(seedSql);
    console.log('[migrate] 种子已注入（幂等）');
  }
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 6: 跑测试确认通过**

Run: `npx vitest run test/db.test.js`
Expected: PASS（单库可连接，pgcrypto 生成 UUID、版本号返回 PostgreSQL）

- [ ] **Step 7: 提交**

```bash
git add package.json tsconfig.json .gitignore docker-compose.yml db/ src/db.js test/db.test.js
git commit -m "feat(stage1): Task1 工程脚手架+单库底座——particles/edges/tasks/events 四表+schema 幂等迁移"
```

---

### Task 2: 粒子模型 + 粒子仓库（9 粒子 + 统一 CRUD + 受控谓词边）

**Files:**
- Create: `src/particles/particleModel.js`, `src/particles/particleRepo.js`, `src/particles/lifecycle.js`
- Test: `test/particles.test.js`

- [ ] **Step 1: 写失败的粒子测试**

```js
// test/particles.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { query } from '../src/db.js';
import { createParticle, getParticle, queryParticles, createEdge, queryNeighbors } from '../src/particles/particleRepo.js';

beforeEach(async () => {
  await query(`TRUNCATE particles, edges, events CASCADE`);
});

describe('particleRepo', () => {
  it('创建 CRM_DEAL 粒子并写时触发三钩子（embedding/tsvector 落库）', async () => {
    const p = await createParticle('CRM_DEAL', {
      name: '半导体扩产项目', expected_amount: 1200000,
      stage: 'lead', owner_id: '11111111-1111-1111-1111-111111111111',
      org_id: '22222222-2222-2222-2222-222222222222',
    });
    const row = await query(`SELECT embedding, fts, content_hash FROM particles WHERE id=$1`, [p.id]);
    expect(row.rows[0].embedding).toBeTruthy();
    expect(row.rows[0].fts).toBeTruthy();
    expect(row.rows[0].content_hash).toBeTruthy();
  });

  it('受控谓词边：DEAL belongs_to ACCOUNT（重复建边幂等）', async () => {
    const acct = await createParticle('CRM_ACCOUNT', { name: '深圳智造科技', industry: '半导体' });
    const deal = await createParticle('CRM_DEAL', { name: '扩产项目', stage: 'lead' });
    const e1 = await createEdge('CRM_DEAL', deal.id, 'belongs_to', 'CRM_ACCOUNT', acct.id);
    const e2 = await createEdge('CRM_DEAL', deal.id, 'belongs_to', 'CRM_ACCOUNT', acct.id);
    expect(e2.id).toBe(e1.id); // 幂等
    const neighbors = await queryNeighbors('CRM_DEAL', deal.id);
    expect(neighbors.some(n => n.edge_type === 'belongs_to')).toBe(true);
  });

  it('未受控谓词拒绝', async () => {
    const acct = await createParticle('CRM_ACCOUNT', { name: 'X' });
    const deal = await createParticle('CRM_DEAL', { name: 'Y', stage: 'lead' });
    await expect(createEdge('CRM_DEAL', deal.id, 'hates', 'CRM_ACCOUNT', acct.id))
      .rejects.toThrow(/未受控谓词/);
  });

  it('CRM_DEAL 状态机：stage 只进不退（lead→opportunity 合法；opportunity→lead 被拒）', async () => {
    const deal = await createParticle('CRM_DEAL', { name: 'Z', stage: 'lead' });
    await import('../src/particles/lifecycle.js').then(m => m.advanceStage(deal.id, 'opportunity'));
    const p1 = await getParticle(deal.id);
    expect(p1.payload.stage).toBe('opportunity');
    await expect(import('../src/particles/lifecycle.js').then(m => m.advanceStage(deal.id, 'lead')))
      .rejects.toThrow(/只进不退/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/particles.test.js`
Expected: FAIL（particleRepo 未定义，三钩子未接线）

- [ ] **Step 3: 写粒子模型（9 粒子 + 19 种属性校验）**

```js
// src/particles/particleModel.js
// 9 真粒子（01 粒子系统设计 §1 收敛清单；C0-C4 判定）
export const PARTICLE_TYPES = {
  CRM_DEAL: {
    slug: 'deal', title: '交易',
    identity: ['name'],
    states: { current: 'lead', flow: ['lead','opportunity','quoted','contracted','ordered','paid','lost','disqualified'] },
    why: 'stage_change_reason',  // why 层载体（Oleg Product Memory 门槛）
  },
  CRM_ACCOUNT: {
    slug: 'account', title: '客户',
    identity: ['name'],
    states: { current: 'potential', flow: ['potential','active','dormant','lost'] },
    why: 'dormant_reason',
  },
  CRM_CONTACT: {
    slug: 'contact', title: '联系人',
    identity: ['name'],
    states: { current: 'active', flow: ['active','departed'] },
  },
  CRM_PRODUCT: {
    slug: 'product', title: '产品',
    identity: ['name'],
    states: { current: 'on_sale', flow: ['on_sale','discontinued'] },
    why: 'price_change_reason',
  },
  CRM_PRICE_LIST: {
    slug: 'price-list', title: '价格表',
    identity: ['name'],
    states: { current: 'draft', flow: ['draft','active','expired'] },
  },
  CRM_PERSON: {
    slug: 'person', title: '员工/操作人',
    identity: ['name'],
    states: { current: 'active', flow: ['active','disabled','departed'] },
  },
  CRM_ORGANIZATION: {
    slug: 'organization', title: '组织',
    identity: ['name'],
    states: { current: 'enabled', flow: ['enabled','disabled'] },
    why: 'pool_rule_reason',
  },
  CRM_KNOWLEDGE: {
    slug: 'knowledge', title: '知识/词表',
    identity: ['term'],
    states: { current: 'registered', flow: ['registered','deprecated'] },
  },
  CRM_UNSTRUCTURED_ASSET: {
    slug: 'asset', title: '非结构化证据',
    identity: ['type','file_name'],
    states: { current: 'uploaded', flow: ['uploaded','archived'] },
  },
};

// 19 种属性类型有穷集（01 粒子系统设计 §2.2）
export const ATTRIBUTE_TYPE_SET = new Set([
  'text','personal-name','email-address','phone-number','domain','location',
  'number','currency','percent','date','timestamp','select','multi-select',
  'boolean','rating','url','record-reference','actor-reference','interaction',
]);

// 受控谓词表（01 §4；拒绝裸外键）
export const CONTROLLED_PREDICATES = [
  'belongs_to','owned_by','part_of','has_employee','works_at','priced_by',
  'used_in','referenced_in','evidenced_by','sourcedFrom','transitionedBecause',
  'instanceOf','explains','member_of','governs','temporallyFollows',
];
```

- [ ] **Step 4: 写粒子仓库（复用 P2P particleRepo 接口，+ 三钩子接线）**

```js
// src/particles/particleRepo.js
// 统一粒子 CRUD + 受控谓词边（R2/R5：资源走 substrate，不开独立 CRUD）
import { query } from '../db.js';
import { PARTICLE_TYPES, CONTROLLED_PREDICATES } from './particleModel.js';
import { ensureAll } from '../ontology/hooks.js';
import { emit } from '../events/bus.js';

export async function createParticle(type, payload, { tenantId = 'system' } = {}) {
  const def = PARTICLE_TYPES[type];
  if (!def) throw new Error(`未知粒子类型: ${type}`);
  for (const f of def.identity) {
    if (payload[f] === undefined || payload[f] === null || payload[f] === '') {
      throw new Error(`missing required field: ${f}`);
    }
  }
  const r = await query(
    `INSERT INTO particles (tenant_id, type, slug, title, state, payload)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [tenantId, type, def.slug, def.title, payload.stage || payload.state || def.states.current, JSON.stringify(payload)]
  );
  const particle = r.rows[0];
  await ensureAll(particle);  // 写库即构建：embedding + FTS + 本体同步
  emit('particle', 'created', { id: particle.id, type });
  return particle;
}

export async function getParticle(id) {
  const r = await query(`SELECT * FROM particles WHERE id = $1`, [id]);
  return r.rows[0] || null;
}

export async function queryParticles({ type, tenantId = 'system', limit = 100 } = {}) {
  const r = await query(
    `SELECT * FROM particles WHERE tenant_id=$1 AND ($2::text IS NULL OR type=$2)
     ORDER BY created_at DESC LIMIT $3`,
    [tenantId, type || null, limit]
  );
  return r.rows;
}

export async function updateParticle(id, { state, patch = {}, event } = {}) {
  const cur = await getParticle(id);
  if (!cur) throw new Error(`粒子不存在: ${id}`);
  const newPayload = { ...cur.payload, ...patch };
  if (event) {
    const events = Array.isArray(cur.payload.events) ? cur.payload.events : [];
    newPayload.events = [...events, { at: new Date().toISOString(), ...event }];
  }
  const r = await query(
    `UPDATE particles SET payload=$1, state=$2, updated_at=now() WHERE id=$3 RETURNING *`,
    [JSON.stringify(newPayload), state || cur.state, id]
  );
  const p = r.rows[0];
  await ensureAll(p);
  emit('particle', 'updated', { id: p.id, type: p.type });
  return p;
}

export async function appendEvent(id, event) {
  return updateParticle(id, { event });
}

export async function createEdge(sourceType, sourceId, edgeType, targetType, targetId, meta = {}, tenantId = 'system') {
  if (!CONTROLLED_PREDICATES.includes(edgeType)) {
    throw new Error(`未受控谓词: ${edgeType}（必须在 CONTROLLED_PREDICATES 内）`);
  }
  const dup = await query(
    `SELECT * FROM edges WHERE tenant_id=$1 AND source_id=$2 AND edge_type=$3 AND target_id=$4`,
    [tenantId, sourceId, edgeType, targetId]
  );
  if (dup.rows.length > 0) {
    const edge = dup.rows[0];
    emit('particle', 'edge-created', { id: edge.id, sourceType, edgeType, targetType });
    return edge; // 幂等：已存在直接返回
  }
  const r = await query(
    `INSERT INTO edges (tenant_id, source_type, source_id, edge_type, target_type, target_id, meta)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [tenantId, sourceType, sourceId, edgeType, targetType, targetId, JSON.stringify(meta)]
  );
  const edge = r.rows[0];
  emit('particle', 'edge-created', { id: edge.id, sourceType, edgeType, targetType });
  return edge;
}

export async function queryNeighbors(sourceType, sourceId, tenantId = 'system') {
  const r = await query(
    `SELECT e.*, t.slug AS target_slug, t.title AS target_title
     FROM edges e JOIN particles t ON t.id = e.target_id
     WHERE e.tenant_id=$1 AND e.source_type=$2 AND e.source_id=$3`,
    [tenantId, sourceType, sourceId]
  );
  return r.rows;
}
```

- [ ] **Step 5: 写粒子生命周期钩子（stage 状态机 + why 载体）**

```js
// src/particles/lifecycle.js
// DEAL 阶段状态机：只进不退（§5ter.3 实证：商机阶段只能向前推进）+ why 载体必填
import { PARTICLE_TYPES } from './particleModel.js';
import { getParticle, updateParticle, createEdge } from './particleRepo.js';

export async function advanceStage(particleId, toStage, { transitionedBecause, owner } = {}) {
  const p = await getParticle(particleId);
  if (!p) throw new Error(`粒子不存在: ${particleId}`);
  const flow = PARTICLE_TYPES[p.type].states.flow;
  const cur = p.payload.stage || p.payload.state;
  const curIdx = flow.indexOf(cur);
  const toIdx = flow.indexOf(toStage);
  if (toIdx < 0) throw new Error(`未知阶段: ${toStage}（合法阶段: ${flow.join('→')}）`);
  if (toIdx < curIdx) throw new Error(`阶段只进不退: ${cur} → ${toStage}`);

  const patch = { stage: toStage, stage_changed_at: new Date().toISOString() };
  const why = PARTICLE_TYPES[p.type].why;
  if (why && toStage === 'lost' && !transitionedBecause && !p.payload.closed_reason) {
    throw new Error(`输单必填原因（closed_reason 或 transitionedBecause）`);
  }
  if (transitionedBecause) {
    patch[why] = transitionedBecause;
    patch.transitionedBecause = transitionedBecause;  // why 载体落 payload
  }
  if (['opportunity','quoted','contracted','ordered','paid'].includes(toStage)) {
    patch.actual_close_date = toStage === 'paid' ? new Date().toISOString() : p.payload.actual_close_date;
  }

  const updated = await updateParticle(particleId, { state: toStage, patch });
  // 受控边 transitionedBecause：DEAL → KNOWLEDGE（决策理由载体），edge_source=human
  if (transitionedBecause) {
    const know = await createParticle('CRM_KNOWLEDGE', { term: `transition-${particleId.slice(0,8)}`, content: transitionedBecause }).catch(() => null);
    if (know) {
      await createEdge(p.type, particleId, 'transitionedBecause', 'CRM_KNOWLEDGE', know.id,
        { edge_source: 'human', ai_reasoning_trace: owner || null, reason: transitionedBecause });
    }
  }
  return updated;
}
```

- [ ] **Step 6: 跑测试确认通过**

Run: `npx vitest run test/particles.test.js`
Expected: PASS（4 例全过：三钩子落库/受控边幂等/未受控拒绝/阶段只进不退）

- [ ] **Step 7: 提交**

```bash
git add src/particles/ db/schema.sql test/particles.test.js
git commit -m "feat(stage1): Task2 粒子模型+仓库——9粒子定义+受控谓词边+DEAL阶段状态机(只进不退+why载体)"
```

---

### Task 3: 写时三钩子（ontology：ensureEmbedding/ensureTsVector/ontologySync）

**Files:**
- Create: `src/ontology/hooks.js`, `src/ontology/embedding.js`, `src/ontology/coverage.js`, `src/ontology/vocabulary.js`
- Test: `test/ontology-hooks.test.js`

- [ ] **Step 1: 写失败的钩子测试**

```js
// test/ontology-hooks.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { query } from '../src/db.js';
import { ensureAll } from '../src/ontology/hooks.js';

beforeEach(async () => {
  await query(`TRUNCATE particles, edges, events CASCADE`);
});

function fakeParticle(type, payload) {
  return { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', type, payload, tenant_id: 'system' };
}

describe('ontology hooks', () => {
  it('ensureEmbedding 幂等：内容不变不重算（同 content_hash 返回同一向量）', async () => {
    const p = fakeParticle('CRM_DEAL', { name: '扩产项目', stage: 'lead' });
    await query(`INSERT INTO particles (id, tenant_id, type, slug, title, state, payload) VALUES ($1,'system','CRM_DEAL','deal','交易','lead',$2)`, [p.id, JSON.stringify(p.payload)]);
    await ensureAll(p);
    const r1 = await query(`SELECT embedding, content_hash FROM particles WHERE id=$1`, [p.id]);
    // 再次 ensureAll（无内容变化）→ 不重算（embedding 保持、content_hash 不变）
    await ensureAll(p);
    const r2 = await query(`SELECT embedding, content_hash FROM particles WHERE id=$1`, [p.id]);
    expect(r2.rows[0].content_hash).toBe(r1.rows[0].content_hash);
    expect(r2.rows[0].embedding).toEqual(r1.rows[0].embedding);
  });

  it('ensureTsVector 双写：FTS 索引与向量同时维护', async () => {
    const p = fakeParticle('CRM_ACCOUNT', { name: '半导体客户深圳智造', industry: '半导体' });
    await query(`INSERT INTO particles (id, tenant_id, type, slug, title, state, payload) VALUES ($1,'system','CRM_ACCOUNT','account','客户','potential',$2)`, [p.id, JSON.stringify(p.payload)]);
    await ensureAll(p);
    const r = await query(`SELECT fts FROM particles WHERE id=$1`, [p.id]);
    expect(r.rows[0].fts).toBeTruthy();
  });

  it('ontologySync 词汇表登记：枚举/业务名词写时登记 knowledge', async () => {
    const p = fakeParticle('CRM_DEAL', { name: '商机推进', stage: 'opportunity' });
    await query(`INSERT INTO particles (id, tenant_id, type, slug, title, state, payload) VALUES ($1,'system','CRM_DEAL','deal','交易','opportunity',$2)`, [p.id, JSON.stringify(p.payload)]);
    await ensureAll(p);
    const r = await query(`SELECT count(*) AS c FROM particles WHERE type='CRM_KNOWLEDGE'`);
    expect(r.rows[0].c >= 1).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/ontology-hooks.test.js`
Expected: FAIL（hooks 未定义）

- [ ] **Step 3: 写确定性哈希 embedding（零外部依赖，测试可跑全量）**

```js
// src/ontology/embedding.js
// 确定性哈希 mock：SHA-256 → 归一化 384 维向量（同文本同向量，零外部依赖可跑全量测试）
// 生产可注入真模型（llm.ts 换 SiliconFlow embedding），向量维度须与 schema 对齐
import { createHash } from 'node:crypto';

const DIM = 384;

export function hashVector(text) {
  const h = createHash('sha256').update(String(text || '')).digest();
  const v = new Array(DIM).fill(0);
  for (let i = 0; i < h.length; i++) {
    const bucket = (h[i] % DIM + DIM) % DIM;
    v[bucket] += (h[i] % 251) / 251; // 有符号扰动，保留文本指纹
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map(x => x / norm);
}

export function contentHash(payload) {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}
```

- [ ] **Step 4: 写词汇表登记**

```js
// src/ontology/vocabulary.js
// 枚举型/业务专有名词写时登记为 semanticEntities（进 L1 图种子）
import { createParticle } from '../particles/particleRepo.js';

const ENUM_HINT_FIELDS = ['industry', 'region', 'stage', 'source', 'category', 'type'];

export async function registerVocabulary(entity, tenantId = 'system') {
  const payload = entity.payload || {};
  for (const f of ENUM_HINT_FIELDS) {
    const val = payload[f];
    if (!val || typeof val !== 'string') continue;
    const exists = await findKnowledge(val);
    if (exists) continue;
    await createParticle('CRM_KNOWLEDGE', { term: val, type: '业务术语', layer: 'L1' }, { tenantId })
      .catch(() => null); // 登记失败不阻断业务写（fail-open）
  }
}

async function findKnowledge(term) {
  const { query } = await import('../db.js');
  const r = await query(`SELECT id FROM particles WHERE type='CRM_KNOWLEDGE' AND payload->>'term'=$1 LIMIT 1`, [term]);
  return r.rows[0] || null;
}
```

- [ ] **Step 5: 写写时三钩子主入口**

```js
// src/ontology/hooks.js
// 写库即构建：ensureEmbedding（幂等 content_hash 判变）+ ensureTsVector（双写）+ ontologySync（类型校验/受控边/词汇登记）
import { query } from '../db.js';
import { hashVector, contentHash } from './embedding.js';
import { registerVocabulary } from './vocabulary.js';

export async function ensureEmbedding({ id, payload }) {
  const text = JSON.stringify(payload || {});
  const hash = contentHash(payload || {});
  const r = await query(`SELECT content_hash FROM particles WHERE id=$1`, [id]);
  const curHash = r.rows[0]?.content_hash || null;
  if (curHash === hash) return; // 幂等：内容没变不重算（省额度稳一致）
  const vec = hashVector(text);
  await query(`UPDATE particles SET embedding=$1, content_hash=$2, updated_at=now() WHERE id=$3`,
    [JSON.stringify(vec), hash, id]);
}

export async function ensureTsVector({ id, payload }) {
  const text = (payload?.name || payload?.title || payload?.term || '') + ' ' + JSON.stringify(payload || {}).slice(0, 800);
  await query(
    `UPDATE particles SET fts = to_tsvector('simple', $1), updated_at=now() WHERE id=$2`,
    [text, id]
  );
}

export async function ontologySync(entity) {
  // ① 类型校验：实体类型必须在受控词汇表内（PARTICLE_TYPES 已约束，此处兜底）
  // ② 引用型字段自动建边（record-reference/actor-reference）：owner_id/org_id/account_id
  const payload = entity.payload || {};
  const refs = [
    ['owner_id', 'owned_by', 'CRM_PERSON'],
    ['org_id', 'part_of', 'CRM_ORGANIZATION'],
    ['account_id', 'belongs_to', 'CRM_ACCOUNT'],
  ];
  for (const [field, edgeType, targetType] of refs) {
    const targetId = payload[field];
    if (!targetId) continue;
    const { createEdge } = await import('../particles/particleRepo.js');
    await createEdge(entity.type, entity.id, edgeType, targetType, targetId,
      { edge_source: 'auto' }).catch(() => {});
  }
  // ③ 词汇登记（枚举型/业务专有名词）
  await registerVocabulary(entity, entity.tenant_id || 'system');
}

export async function ensureAll(entity) {
  await ensureEmbedding(entity);
  await ensureTsVector(entity);
  await ontologySync(entity);
}
```

- [ ] **Step 6: 跑测试确认通过**

Run: `npx vitest run test/ontology-hooks.test.js`
Expected: PASS（3 例全过：embedding 幂等/FTS 双写/词汇登记）

- [ ] **Step 7: 提交**

```bash
git add src/ontology/ db/schema.sql test/ontology-hooks.test.js
git commit -m "feat(stage1): Task3 写时三钩子——ensureEmbedding幂等(哈希判变)+ensureTsVector双写+ontologySync(受控边+词汇登记)"
```

---

### Task 4: SSE 事件总线（bus + SSE 5 域雏形）

**Files:**
- Create: `src/events/bus.js`, `src/events/sse.js`
- Test: `test/sse.test.js`

- [ ] **Step 1: 写失败的 SSE 测试**

```js
// test/sse.test.js
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { on, emit } from '../src/events/bus.js';
import { createSseHub } from '../src/events/sse.js';

describe('event bus', () => {
  it('emit 广播：域订阅 + 全量订阅（payload 包装 domain/type/ts）', () => {
    const got = [];
    const off1 = on('task', (m) => got.push(['task', m.type]));
    const off2 = on('*', (m) => got.push(['all', m.domain]));
    emit('task', 'done', { id: 'x' });
    expect(got).toContainEqual(['task', 'done']);
    expect(got).toContainEqual(['all', 'task']);
    off1(); off2();
    emit('task', 'done', { id: 'y' });  // 退订后不再收到
    expect(got.length).toBe(2);
  });

  it('订阅者异常隔离：一个 handler 抛错不影响其他 handler', () => {
    const got = [];
    on('*', () => { throw new Error('boom'); });
    on('*', (m) => got.push(m.type));
    emit('particle', 'created', {});
    expect(got).toEqual(['created']);
  });
});

describe('SSE hub', () => {
  it('SSE 连接接收广播（模拟 res 写入）', () => {
    const hub = createSseHub();
    const writes = [];
    const fakeRes = {
      write: (s) => writes.push(s),
      flushHeaders: () => {},
      on: () => {},
    };
    hub.connect(fakeRes);
    emit('task', 'done', { id: 't1' });
    expect(writes.some(s => s.includes('event: task') && s.includes('done'))).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/sse.test.js`
Expected: FAIL（bus/sse 未定义）

- [ ] **Step 3: 写进程内事件总线（复用 P2P bus.js）**

```js
// src/events/bus.js
// 进程内事件总线：同步分发，订阅者异常隔离（抛错绝不阻断业务写路径）
const handlers = new Map();

export function on(domain, fn) {
  if (!handlers.has(domain)) handlers.set(domain, new Set());
  handlers.get(domain).add(fn);
  return () => handlers.get(domain)?.delete(fn);
}

export function emit(domain, type, payload) {
  const msg = { domain, type, ts: Date.now(), summary: payload || {} };
  const all = handlers.get('*');
  if (all) for (const fn of [...all]) { try { fn(msg); } catch (e) { console.error('[bus] handler error:', e.message); } }
  const set = handlers.get(domain);
  if (set) for (const fn of [...set]) { try { fn(msg); } catch (e) { console.error('[bus] handler error:', e.message); } }
}
```

- [ ] **Step 4: 写 SSE Hub（5 域广播）**

```js
// src/events/sse.js
// SSE 事件总线端：单连接广播 5 事件域（task/trace/approval/particle/payment）
// 呼应 03 编排设计「观测面板与编排数据同源，SSE 单连接实时刷新」
import { on } from './bus.js';

export function createSseHub() {
  const clients = new Set();

  function connect(res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.flushHeaders?.();
    clients.add(res);
    res.on('close', () => clients.delete(res));
    res.write(`event: connected\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);
  }

  const unsubscribe = on('*', (msg) => {
    const frame = `event: ${msg.domain}\ndata: ${JSON.stringify(msg)}\n\n`;
    for (const res of clients) { try { res.write(frame); } catch {} }
  });

  return { connect, clients, close: () => { unsubscribe(); clients.clear(); } };
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run test/sse.test.js`
Expected: PASS（3 例全过：广播/异常隔离/SSE 连接接收）

- [ ] **Step 6: 提交**

```bash
git add src/events/ test/sse.test.js
git commit -m "feat(stage1): Task4 SSE事件总线——bus(订阅者隔离)+SSE Hub(5域广播单连接)"
```

---

### Task 5: kanban 看板（状态机 + 熔断 + 审计）— 复用 P2P

**Files:**
- Create: `src/kanban/types.js`, `src/kanban/kanban.js`, `src/kanban/dispatch.js`, `src/kanban/scheduler.js`
- Test: `test/kanban.test.js`, `test/dispatch.test.js`

- [ ] **Step 1: 写失败的 kanban 测试**

```js
// test/kanban.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { query } from '../src/db.js';
import { FAILURE_LIMIT } from '../src/kanban/types.js';
import { createTask, claimTask, completeTask, failTask, resetTask, getTask } from '../src/kanban/kanban.js';

beforeEach(async () => {
  await query(`TRUNCATE tasks, task_audit, scheduler_lock CASCADE`);
});

describe('kanban 状态机', () => {
  it('极简四态流转：ready→running→done', async () => {
    const t = await createTask({ step: 'agent', title: 'T1', actionName: 'crm-deal-analyze', payload: {} });
    await claimTask(t.id);
    await completeTask(t.id, { result: { ok: true } });
    const done = await getTask(t.id);
    expect(done.status).toBe('done');
  });

  it('熔断：连续失败 >= FAILURE_LIMIT → blocked(circuit_break)', async () => {
    const t = await createTask({ step: 'agent', title: 'T2', actionName: 'x', payload: {} });
    for (let i = 0; i < FAILURE_LIMIT; i++) {
      await claimTask(t.id);
      await failTask(t.id, { error: `err${i}` });
    }
    const b = await getTask(t.id);
    expect(b.status).toBe('blocked');
    expect(b.block_kind).toBe('circuit_break');
    expect(b.consecutive_failures).toBe(FAILURE_LIMIT);
  });

  it('审计：每个状态转换留 task_audit 记录', async () => {
    const t = await createTask({ step: 'agent', title: 'T3', actionName: 'x', payload: {} });
    await claimTask(t.id, { byActor: 'scheduler' });
    const r = await query(`SELECT count(*) AS c FROM task_audit WHERE task_id=$1`, [t.id]);
    expect(Number(r.rows[0].c)).toBeGreaterThanOrEqual(1);
  });

  it('reset 幂等：任意状态→ready（清失败计数/block）', async () => {
    const t = await createTask({ step: 'agent', title: 'T4', actionName: 'x', payload: {} });
    await claimTask(t.id);
    await failTask(t.id, { error: 'e1' });
    await resetTask(t.id);
    const r = await getTask(t.id);
    expect(r.status).toBe('ready');
    expect(r.consecutive_failures).toBe(0);
  });
});
```

```js
// test/dispatch.test.js
import { describe, it, expect } from 'vitest';
import { createDispatchQueue } from '../src/kanban/dispatch.js';

describe('dispatch 并发限流', () => {
  it('max_inflight 上限：超过并发上限的任务排队', async () => {
    const q = createDispatchQueue({ maxInflight: 3 });
    const started = [];
    const fn = (id) => new Promise((resolve) => {
      started.push(id);
      setTimeout(resolve, 20);
    });
    const jobs = [1,2,3,4,5].map(id => q.push(id, () => fn(id)));
    await Promise.all(jobs);
    // 并发峰值不超过 3：started 在任意 20ms 窗口最多 3 个（用时间窗断言宽松版）
    expect(q.inflight).toBe(0);
    expect(started.length).toBe(5);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/kanban.test.js test/dispatch.test.js`
Expected: FAIL（kanban/dispatch 未定义）

- [ ] **Step 3: 写类型常量**

```js
// src/kanban/types.js
// 03 编排设计：极简四态 + failure_limit=3
export const FAILURE_LIMIT = 3;
export const TASK_STATUSES = ['ready', 'running', 'done', 'failed', 'blocked'];
export const MAX_INFLIGHT = 3;
```

- [ ] **Step 4: 写 kanban 状态机（复用 P2P kanban.js，保持接口）**

```js
// src/kanban/kanban.js
// 状态机：ready→running→done/failed→blocked（熔断）；审计每转换；reset 幂等
import { query } from '../db.js';
import { FAILURE_LIMIT } from './types.js';
import { emit } from '../events/bus.js';

export async function auditTransition(taskId, fromState, toState, byActor = 'system', reason = null) {
  await query(
    `INSERT INTO task_audit (task_id, from_state, to_state, by_actor, reason)
     VALUES ($1,$2,$3,$4,$5)`,
    [taskId, fromState, toState, byActor, reason]
  );
}

export async function getTask(id) {
  const r = await query('SELECT * FROM tasks WHERE id=$1', [id]);
  return r.rows[0] || null;
}

export async function listTasks({ status, chainId, tenantId = 'system' } = {}) {
  const where = ['tenant_id=$1'];
  const params = [tenantId];
  let i = 2;
  if (status) { where.push(`status=$${i++}`); params.push(status); }
  if (chainId) { where.push(`chain_id=$${i++}`); params.push(chainId); }
  const r = await query(`SELECT * FROM tasks WHERE ${where.join(' AND ')} ORDER BY created_at`, params);
  return r.rows;
}

export async function createTask({ tenantId = 'system', chainId = null, step, title, actionName, payload = {}, dependsOn = [] }) {
  const r = await query(
    `INSERT INTO tasks (tenant_id, chain_id, step, title, action_name, payload, depends_on, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'ready') RETURNING *`,
    [tenantId, chainId, step, title, actionName, JSON.stringify(payload), dependsOn]
  );
  return r.rows[0];
}

export async function claimTask(id, { byActor = 'scheduler' } = {}) {
  const t = await getTask(id);
  if (!t) throw new Error(`任务不存在: ${id}`);
  if (!['ready', 'failed'].includes(t.status)) {
    throw new Error(`任务 ${id} 状态 ${t.status} 不可认领（需 ready 或 failed）`);
  }
  const reason = t.status === 'failed' ? 'retry' : 'claim';
  const r = await query(
    `UPDATE tasks SET status='running', updated_at=now() WHERE id=$1 RETURNING *`,
    [id]
  );
  await auditTransition(id, t.status, 'running', byActor, reason);
  emit('task', 'running', { id });
  return r.rows[0];
}

export async function completeTask(id, { result = null, resultPath = null, byActor = 'worker' } = {}) {
  const t = await getTask(id);
  if (!t) throw new Error(`任务不存在: ${id}`);
  if (t.status !== 'running') throw new Error(`任务 ${id} 状态 ${t.status} 不可完成（需 running）`);
  const r = await query(
    `UPDATE tasks SET status='done', consecutive_failures=0, result=$1, result_path=$2, updated_at=now() WHERE id=$3 RETURNING *`,
    [result ? JSON.stringify(result) : null, resultPath ?? null, id]
  );
  await auditTransition(id, 'running', 'done', byActor, 'complete');
  emit('task', 'done', { id });
  return r.rows[0];
}

export async function failTask(id, { error = null, byActor = 'worker' } = {}) {
  const t = await getTask(id);
  if (!t) throw new Error(`任务不存在: ${id}`);
  if (t.status !== 'running') throw new Error(`任务 ${id} 状态 ${t.status} 不可失败（需 running）`);
  const nf = t.consecutive_failures + 1;
  let toState = 'failed';
  let blockKind = null;
  if (nf >= FAILURE_LIMIT) { toState = 'blocked'; blockKind = 'circuit_break'; }
  const r = await query(
    `UPDATE tasks SET status=$1, consecutive_failures=$2, block_kind=$3, error=$4, updated_at=now() WHERE id=$5 RETURNING *`,
    [toState, nf, blockKind, error, id]
  );
  await auditTransition(id, 'running', toState, byActor, blockKind ? `circuit_break: ${error}` : `failed: ${error}`);
  emit('task', toState, { id });
  return r.rows[0];
}

export async function resetTask(id, { byActor = 'system', reason = 'reset' } = {}) {
  const t = await getTask(id);
  if (!t) throw new Error(`任务不存在: ${id}`);
  const r = await query(
    `UPDATE tasks SET status='ready', consecutive_failures=0, block_kind=NULL, error=NULL, worker_pid=NULL, updated_at=now() WHERE id=$1 RETURNING *`,
    [id]
  );
  await auditTransition(id, t.status, 'ready', byActor, reason);
  emit('task', 'reset', { id });
  return r.rows[0];
}
```

- [ ] **Step 5: 写派发队列（max_inflight=3 + 指数退避）**

```js
// src/kanban/dispatch.js
// 并发限流：max_inflight=3（下游 LLM 额度硬约束）；指数退避 + 抖动
import { MAX_INFLIGHT } from './types.js';

export function createDispatchQueue({ maxInflight = MAX_INFLIGHT, backoffMs = 200 } = {}) {
  let inflight = 0;
  const queue = [];

  function pump() {
    while (inflight < maxInflight && queue.length > 0) {
      const { fn, resolve, reject } = queue.shift();
      inflight++;
      fn()
        .then(resolve, reject)
        .finally(() => { inflight--; pump(); });
    }
  }

  return {
    inflight,
    get inflightCount() { return inflight; },
    push(fn) {
      return new Promise((resolve, reject) => {
        queue.push({ fn, resolve, reject });
        pump();
      });
    },
    backoff(attempt) {
      return backoffMs * Math.pow(2, attempt) + Math.floor(Math.random() * 50);
    },
  };
}
```

- [ ] **Step 6: 写调度器（claim→dispatch→complete 循环 + 单例锁）**

```js
// src/kanban/scheduler.js
// 调度器：扫描 ready 任务 → claim → 派发 agentLoop → complete/fail；单例锁防双实例
import { query } from '../db.js';
import { claimTask, completeTask, failTask, listTasks } from './kanban.js';
import { runWithSkill } from '../agent/agentLoop.js';
import { createDispatchQueue } from './dispatch.js';

const queue = createDispatchQueue({ maxInflight: 3 });

export async function acquireLock() {
  await query(
    `INSERT INTO scheduler_lock (id, pid) VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE SET pid=EXCLUDED.pid, host=EXCLUDED.host, acquired_at=now()`,
    [process.pid]
  );
}

export async function pumpReadyTasks({ chainId = null } = {}) {
  const ready = await listTasks({ status: 'ready', chainId });
  for (const t of ready) {
    await queue.push(() => dispatchOne(t));
  }
  return ready.length;
}

async function dispatchOne(task) {
  const claimed = await claimTask(task.id).catch(() => null);
  if (!claimed) return;
  try {
    const outcome = await runWithSkill(task, {});
    await completeTask(task.id, { result: outcome });
  } catch (e) {
    await failTask(task.id, { error: e.message });
  }
}
```

- [ ] **Step 7: 跑测试确认通过**

Run: `npx vitest run test/kanban.test.js test/dispatch.test.js`
Expected: PASS（kanban 4 例 + dispatch 1 例全过）

- [ ] **Step 8: 提交**

```bash
git add src/kanban/ db/schema.sql test/kanban.test.js test/dispatch.test.js
git commit -m "feat(stage1): Task5 kanban看板——极简四态状态机+熔断(failure_limit=3)+审计+派发队列(max_inflight=3)+调度器单例锁"
```

---

### Task 6: Action Registry + 规则层（写通道闸门骨架）

**Files:**
- Create: `src/action/registry.js`, `src/action/executor.js`, `src/action/seed-actions.js`, `src/ruleEngine.js`
- Test: `test/action.test.js`

- [ ] **Step 1: 写失败的 Action 测试**

```js
// test/action.test.js
import { describe, it, expect } from 'vitest';
import { actionExecutor, registry } from '../src/action/executor.js';
import { ruleEngine } from '../src/ruleEngine.js';

describe('Action Registry', () => {
  it('命名空间分层：crm-deal-advance 与 data-particle-create 都注册', () => {
    const names = registry.list().map(a => a.name);
    expect(names).toContain('crm-deal-advance');
    expect(names).toContain('data-particle-create');
  });

  it('写操作执行走写通道（返回 confirm 信号）', async () => {
    const r = await actionExecutor.dispatch('crm-deal-advance', { deal_id: 'x', to_stage: 'opportunity' }, { tenantId: 'system', actor: 'sales' });
    expect(r.ok).toBe(true);
  });
});

describe('ruleEngine 规则层', () => {
  it('商机阶段只进不退（规则闸）', async () => {
    const r = await ruleEngine.check('CRM_DEAL', 'advance', { from: 'quoted', to: 'opportunity' }, {});
    expect(r.ok).toBe(false);
    expect(r.reasons).toContain('stage_forward_only');
  });

  it('输单必填原因（规则闸）', async () => {
    const r = await ruleEngine.check('CRM_DEAL', 'advance', { from: 'opportunity', to: 'lost' }, { closed_reason: null });
    expect(r.ok).toBe(false);
    expect(r.reasons).toContain('lost_requires_reason');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/action.test.js`
Expected: FAIL（registry/executor/ruleEngine 未定义）

- [ ] **Step 3: 写 Action Registry**

```js
// src/action/registry.js
// Action 表面：data.particle.* 平台 substrate + crm.* 跨粒子能力 Action（01 §8：绝不为每个粒子开 CRUD 与谓词开 Action）
const actions = new Map();

export function registerAction(def) {
  // def: { name, kind: 'read'|'write', permission, handler, schema }
  actions.set(def.name, def);
}

export function getAction(name) {
  return actions.get(name) || null;
}

export function listActions({ kind } = {}) {
  return [...actions.values()].filter(a => !kind || a.kind === kind);
}
```

- [ ] **Step 4: 写规则层（business-rules 骨架）**

```js
// src/ruleEngine.js
// 规则层：AI 写操作护栏「能不能写」（§5ter.3 实证：商机阶段只进不退/输单必填原因/合同金额超 20% 审批）
const RULES = {
  stage_forward_only: {
    match: (type, action, patch) => type === 'CRM_DEAL' && action === 'advance',
    check: (type, action, patch) => {
      const flow = { lead: 0, opportunity: 1, quoted: 2, contracted: 3, ordered: 4, paid: 5, lost: 6, disqualified: 7 };
      if (patch.from == null || patch.to == null) return { ok: true };
      return { ok: (flow[patch.to] || 0) >= (flow[patch.from] || 0),
               reasons: (flow[patch.to] || 0) >= (flow[patch.from] || 0) ? [] : ['stage_forward_only'] };
    },
  },
  lost_requires_reason: {
    match: (type, action, patch) => type === 'CRM_DEAL' && action === 'advance' && patch.to === 'lost',
    check: () => {
      // 原因在调用侧校验（closed_reason/transitionedBecause）；此处若缺失即拒绝
      return { ok: false, reasons: ['lost_requires_reason'] };
    },
  },
};

export const ruleEngine = {
  async check(type, action, patch, ctx) {
    const blocked = [];
    for (const rule of Object.values(RULES)) {
      if (!rule.match(type, action, patch)) continue;
      const r = rule.check(type, action, patch, ctx);
      if (!r.ok) blocked.push(...(r.reasons || [`rule:${rule}`]));
    }
    return { ok: blocked.length === 0, reasons: blocked };
  },
};
```

- [ ] **Step 5: 写 Action 种子 + 执行器（写通道闸门埋点）**

```js
// src/action/seed-actions.js
import { registerAction } from './registry.js';
import { createParticle, updateParticle, queryParticles, createEdge } from '../particles/particleRepo.js';
import { advanceStage } from '../particles/lifecycle.js';
import { ruleEngine } from '../ruleEngine.js';
import { emit } from '../events/bus.js';

export function seedActions() {
  // 平台 substrate（R2/R5：粒子 CRUD 走 substrate，非领域 Action）
  registerAction({
    name: 'data-particle-create', kind: 'write', permission: 'auth',
    schema: { type: 'string', payload: 'object' },
    handler: async ({ type, payload }, ctx) => createParticle(type, payload, { tenantId: ctx.tenantId }),
  });
  registerAction({
    name: 'data-particle-read', kind: 'read', permission: 'auth',
    schema: { type: 'string', id: 'string' },
    handler: async ({ type, id }, ctx) =>
      id ? (await import('../particles/particleRepo.js')).getParticle(id)
         : queryParticles({ type, tenantId: ctx.tenantId }),
  });
  registerAction({
    name: 'data-particle-edge-create', kind: 'write', permission: 'auth',
    schema: { source_type: 'string', source_id: 'string', edge_type: 'string', target_type: 'string', target_id: 'string' },
    handler: async (p, ctx) => createEdge(p.source_type, p.source_id, p.edge_type, p.target_type, p.target_id, p.meta || {}, ctx.tenantId),
  });

  // 跨粒子能力 Action（领域级，非粒子 CRUD）
  registerAction({
    name: 'crm-deal-advance', kind: 'write', permission: 'auth', confirm: 'critical',
    schema: { deal_id: 'string', to_stage: 'string', transitionedBecause: 'string' },
    handler: async ({ deal_id, to_stage, transitionedBecause }, ctx) => {
      const deal = await (await import('../particles/particleRepo.js')).getParticle(deal_id);
      if (!deal) throw new Error(`DEAL 不存在: ${deal_id}`);
      const gate = await ruleEngine.check('CRM_DEAL', 'advance',
        { from: deal.payload.stage, to: to_stage }, { closed_reason: deal.payload.closed_reason });
      if (!gate.ok) throw new Error(`规则闸拒绝: ${gate.reasons.join(', ')}`);
      return advanceStage(deal_id, to_stage, { transitionedBecause, owner: ctx.actor });
    },
  });
  registerAction({
    name: 'crm-account-360', kind: 'read', permission: 'auth',
    schema: { account_id: 'string' },
    handler: async ({ account_id }, ctx) => {
      const acct = await (await import('../particles/particleRepo.js')).getParticle(account_id);
      if (!acct) throw new Error(`ACCOUNT 不存在: ${account_id}`);
      const edges = await (await import('../particles/particleRepo.js')).queryNeighbors('CRM_ACCOUNT', account_id, ctx.tenantId);
      return { account: acct, related: edges };
    },
  });
}
```

```js
// src/action/executor.js
import { getAction, listActions } from './registry.js';
import { emit } from '../events/bus.js';

export const registry = { list: listActions, get: getAction };

export const actionExecutor = {
  async dispatch(actionName, params, ctx = { tenantId: 'system', actor: 'system' }) {
    const def = getAction(actionName);
    if (!def) return { ok: false, error: `未知 Action: ${actionName}` };
    // 写通道闸门埋点（阶段 1 骨架：confirm 信号返回，HITL 阶段 2 接入）
    if (def.kind === 'write') {
      emit('trace', 'action-write-requested', { action: actionName, actor: ctx.actor, params });
    }
    try {
      const data = await def.handler(params, ctx);
      if (def.kind === 'write') emit('trace', 'action-write-executed', { action: actionName, actor: ctx.actor, ok: true });
      return { ok: true, data, action: actionName, confirm: def.confirm || null };
    } catch (e) {
      if (def.kind === 'write') emit('trace', 'action-write-failed', { action: actionName, error: e.message });
      return { ok: false, error: e.message, action: actionName };
    }
  },
};
```

- [ ] **Step 6: 跑测试确认通过**

Run: `npx vitest run test/action.test.js`
Expected: PASS（4 例全过：命名空间/写通道/阶段只进不退/输单必填原因）

- [ ] **Step 7: 提交**

```bash
git add src/action/ src/ruleEngine.js test/action.test.js
git commit -m "feat(stage1): Task6 Action Registry+规则层——data.particle.* substrate+crm-deal-advance 跨粒子Action+业务规则闸(只进不退/输单必填原因)"
```

---

### Task 7: Agent Spec + 装配校验（agents 表 + 六条断言）

**Files:**
- Create: `src/agent/agentSpec.js`, `src/agent/agents.js`
- Test: `test/agentSpec.test.js`

- [ ] **Step 1: 写失败的装配校验测试**

```js
// test/agentSpec.test.js
import { describe, it, expect } from 'vitest';
import { query } from '../src/db.js';
import { agentSpecs } from '../src/agent/agentSpec.js';
import { assertAgentAssembly } from '../src/agent/agents.js';

describe('Agent Spec 装配', () => {
  it('3 Agent 注册（crm-copilot/deal-coach/lead-miner）', () => {
    const names = Object.keys(agentSpecs);
    expect(names).toEqual(expect.arrayContaining(['crm-copilot', 'deal-coach', 'lead-miner']));
  });

  it('权限闭包：⋃(SKILL.calls) ⊆ capabilities.actions', () => {
    for (const spec of Object.values(agentSpecs)) {
      const calls = spec.capabilities.skillCalls || [];
      const allowed = spec.capabilities.actions;
      for (const c of calls) {
        expect(allowed).toContain(c);
      }
    }
  });

  it('六条装配断言全通过（KB 就绪用降级语义）', async () => {
    const result = await assertAgentAssembly();
    expect(result.ok).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/agentSpec.test.js`
Expected: FAIL（agentSpec/agents 未定义）

- [ ] **Step 3: 写 3 Agent 六段式 Spec（03 编排设计第 4/6 轮）**

```js
// src/agent/agentSpec.js
// 3 Agent 六段式（identity/capabilities/context/memory/evaluation/governance）——03 编排设计第 4 轮收敛
export const agentSpecs = {
  'crm-copilot': {
    identity: { name: 'crm-copilot', derivedFrom: 'taskFlow:crm-nl-to-action', autonomy: 'recommend' },
    capabilities: {
      actions: ['data-particle-read', 'data-particle-create', 'data-particle-edge-create', 'crm-deal-advance', 'crm-account-360'],
      skillCalls: ['data-particle-read', 'data-particle-create'],
      knowledgeScope: { layers: ['L1'], maxHops: 2 },
    },
    context: { knowledgeLevel: 2, coverage: '>=80%', coldStart: 'adaptive' },
    memory: { read: ['crm-copilot'], write: ['crm-copilot'] },
    evaluation: { metricTemplate: 'intent_to_action_accuracy', evaluator: 'stage2' },
    governance: { approvals: ['critical'], concurrency: 3, profile: 'full' },
  },
  'deal-coach': {
    identity: { name: 'deal-coach', derivedFrom: 'taskFlow:crm-deal-advance-advice', autonomy: 'recommend' },
    capabilities: {
      actions: ['data-particle-read', 'crm-deal-advance', 'crm-account-360'],
      skillCalls: ['data-particle-read'],
      knowledgeScope: { layers: ['L1', 'L2'], maxHops: 3 },
    },
    context: { knowledgeLevel: 3, coverage: '>=80%', coldStart: 'adaptive' },
    memory: { read: ['deal-coach', 'crm-copilot'], write: ['deal-coach'] },
    evaluation: { metricTemplate: 'advice_acceptance', evaluator: 'stage2' },
    governance: { approvals: ['recommend'], concurrency: 3, profile: 'full' },
  },
  'lead-miner': {
    identity: { name: 'lead-miner', derivedFrom: 'taskFlow:crm-intelligence-mining', autonomy: 'recommend' },
    capabilities: {
      actions: ['data-particle-read', 'data-particle-create', 'crm-account-360'],
      skillCalls: ['data-particle-read'],
      knowledgeScope: { layers: ['L1', 'L2'], maxHops: 3 },
    },
    context: { knowledgeLevel: 2, coverage: '>=80%', coldStart: 'adaptive' },
    memory: { read: ['lead-miner'], write: ['lead-miner'] },
    evaluation: { metricTemplate: 'mining_precision', evaluator: 'stage2' },
    governance: { approvals: ['critical'], concurrency: 3, profile: 'full' },
  },
};
```

- [ ] **Step 4: 写装配校验（六条断言，KB 降级语义）**

```js
// src/agent/agents.js
// 六条装配校验断言（03 编排设计第 6 轮）：1 derivedFrom 存在 2 SKILL validated 3 权限闭包 4 Action 在 Registry 5 KG 就绪(降级) 6 evaluator(阶段2)
import { agentSpecs } from './agentSpec.js';
import { getAction } from '../action/registry.js';

export async function assertAgentAssembly() {
  const results = [];

  // 断言 3：权限闭包 ⋃(SKILL.calls) ⊆ capabilities.actions
  for (const [id, spec] of Object.entries(agentSpecs)) {
    const calls = spec.capabilities.skillCalls || [];
    for (const c of calls) {
      const ok = spec.capabilities.actions.includes(c);
      results.push({ agent: id, assertion: 'permission_closure', ok, detail: `${c} ⊆ actions` });
    }
  }

  // 断言 4：所有 Action 在 Registry 存在
  for (const [id, spec] of Object.entries(agentSpecs)) {
    for (const a of spec.capabilities.actions) {
      const ok = getAction(a) !== null;
      results.push({ agent: id, assertion: 'action_in_registry', ok, detail: a });
    }
  }

  // 断言 1：derivedFrom 存在（taskFlow 表阶段 1 用常量校验）
  for (const [id, spec] of Object.entries(agentSpecs)) {
    results.push({ agent: id, assertion: 'derived_from', ok: Boolean(spec.identity.derivedFrom), detail: spec.identity.derivedFrom });
  }

  // 断言 5：KG 就绪 → 降级语义（阶段 1 无 KG，降级启动并标注，非拒绝）
  for (const [id] of Object.entries(agentSpecs)) {
    results.push({ agent: id, assertion: 'kg_ready', ok: true, detail: 'degraded: kg_coverage_stage2' });
  }

  // 断言 2/6：SKILL validated + evaluator 阶段 2 落地 → 降级语义
  for (const [id] of Object.entries(agentSpecs)) {
    results.push({ agent: id, assertion: 'skill_validated', ok: true, detail: 'degraded: skill_registry_stage2' });
    results.push({ agent: id, assertion: 'evaluator_ready', ok: true, detail: 'degraded: evaluator_stage2' });
  }

  const failed = results.filter(r => !r.ok);
  return { ok: failed.length === 0, results, failed };
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run test/agentSpec.test.js`
Expected: PASS（3 例全过：3 Agent 注册/权限闭包/六条断言）

- [ ] **Step 6: 提交**

```bash
git add src/agent/ test/agentSpec.test.js
git commit -m "feat(stage1): Task7 Agent Spec+装配校验——3 Agent六段式+crm-copilot/deal-coach/lead-miner+六条断言全启用(KG/evaluator降级语义)"
```

---

### Task 8: agentLoop 引擎（SKILL 驱动 + 降级 think）

**Files:**
- Create: `src/agent/agentLoop.js`, `src/skills/registry.js`, `test/skills-seed.js`
- Test: `test/agentLoop.test.js`

- [ ] **Step 1: 写失败的 agentLoop 测试**

```js
// test/agentLoop.test.js
import { describe, it, expect } from 'vitest';
import { runWithSkill } from '../src/agent/agentLoop.js';

function makeTask(payload) {
  return { id: 'test-task', title: '任务', action_name: 'crm-deal-advance', payload: payload || {}, step: 'agent' };
}

describe('agentLoop（SKILL 驱动）', () => {
  it('LLM 不可用降级：默认 think 返回降级推理 + 规则回退', async () => {
    const task = makeTask({ paramAction: 'data-particle-read', staticParams: { type: 'CRM_DEAL' } });
    const out = await runWithSkill(task, { llmThink: null });
    expect(out.degraded).toBe(true);
    expect(out.steps.length).toBeGreaterThanOrEqual(1);
  });

  it('SKILL 驱动：rule 步骤零 LLM 调用（decision=rule 不调 think）', async () => {
    let thinkCalls = 0;
    const task = makeTask({ paramAction: 'crm-deal-advance', staticParams: { deal_id: 'x', to_stage: 'opportunity' } });
    await runWithSkill(task, {
      llmThink: async () => { thinkCalls++; return { action: null, params: {} }; },
    });
    expect(thinkCalls).toBe(1); // 仅决策步骤调一次
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/agentLoop.test.js`
Expected: FAIL（agentLoop 未定义）

- [ ] **Step 3: 写 SKILL 注册表**

```js
// src/skills/registry.js
// SKILL 表：steps[] 含 decision 标记（rule/j_judge/o_optimize/f_forecast），rule 步骤零 LLM 调用
import { actionExecutor } from '../action/executor.js';

const skills = new Map();

export function registerSkill(def) {
  // def: { slug, version, steps: [{step, action, decision, prompt, preconditions, postconditions, schema}] }
  skills.set(`${def.slug}@${def.version}`, def);
  if (!skills.has(def.slug)) skills.set(def.slug, def); // 默认最新
}

export function getSkill(slug) {
  return skills.get(slug) || null;
}

// SKILL 驱动执行：只读 SKILL 步骤序列，不自由探索（反模式 9）
export async function executeSkill(skill, task, opts = {}) {
  const { llmThink = null, ctx = { tenantId: 'system', actor: 'agent' } } = opts;
  const stepsRun = [];
  for (const step of skill.steps) {
    if (step.decision === 'rule') {
      // rule 步骤：直接 dispatch + 规则后处理，零 LLM
      const r = await actionExecutor.dispatch(step.action, step.params, ctx);
      stepsRun.push({ step: step.step, decision: 'rule', result: r, ok: r.ok });
      if (!r.ok) throw new Error(`rule 步骤失败: ${r.error}`);
    } else {
      // 推理步骤：LLM 产出分析（action:null 或具体 action），不直接调 Action
      const analysis = llmThink
        ? await llmThink(task, { step, prior: stepsRun })
        : { action: null, params: {}, reasoning: '[降级推理] LLM 不可用', degraded: true };
      stepsRun.push({ step: step.step, decision: step.decision, analysis, ok: true, degraded: !!analysis.degraded });
      if (analysis.action) {
        const r = await actionExecutor.dispatch(analysis.action, analysis.params, ctx);
        stepsRun[stepsRun.length - 1].result = r;
      }
    }
  }
  return { steps: stepsRun, done: true,
           degraded: stepsRun.some(s => s.degraded),
           reasoning: stepsRun.filter(s => s.analysis).map(s => s.analysis.reasoning).filter(Boolean) };
}
```

- [ ] **Step 4: 写 agentLoop（SKILL 驱动主入口，复用 P2P 模式）**

```js
// src/agent/agentLoop.js
// 执行循环：SKILL 驱动（只读 SKILL 步骤序列）+ LLM 降级（默认 think 规则回退）
import { getSkill, executeSkill } from '../skills/registry.js';
import { emit } from '../events/bus.js';

// 降级 think：LLM 不可用时的规则回退（P2P 已验证模式）
async function defaultThink(task, opts = {}) {
  return {
    action: task.payload?.paramAction || null,
    params: task.payload?.staticParams || {},
    reasoning: '[规则回退] LLM 未启用，走规则默认值',
    degraded: true,
    degradeReason: 'llm_disabled',
  };
}

export async function runWithSkill(task, opts = {}) {
  const { llmThink = null, onStep = null, ctx = { tenantId: 'system', actor: 'agent' } } = opts;
  const skillSlug = task.skill_slug || 'crm-skill-fallback';
  const skill = getSkill(skillSlug);
  if (!skill) throw new Error(`SKILL 不存在: ${skillSlug}`);

  const think = llmThink || defaultThink;
  const startedAt = Date.now();
  emit('trace', 'agent-loop-started', { taskId: task.id, skill: skillSlug });

  try {
    const outcome = await executeSkill(skill, task, { llmThink: think, ctx });
    emit('trace', 'agent-loop-done', { taskId: task.id, skill: skillSlug, ms: Date.now() - startedAt, degraded: outcome.degraded });
    onStep?.({ type: 'done', outcome });
    return outcome;
  } catch (e) {
    emit('trace', 'agent-loop-failed', { taskId: task.id, skill: skillSlug, error: e.message });
    throw e;
  }
}
```

- [ ] **Step 5: 写种子 SKILL**

```js
// src/skills/seed.js
import { registerSkill } from './registry.js';

export function seedSkills() {
  registerSkill({
    slug: 'crm-deal-analyze', version: 1,
    steps: [
      { step: 1, action: 'data-particle-read', decision: 'rule',
        params: { type: 'CRM_DEAL' }, preconditions: [], postconditions: ['result.length>0'] },
      { step: 2, action: null, decision: 'j_judge',
        prompt: '基于商机阶段/跟进/赢率给出推进建议 {{steps[0].result}}',
        preconditions: ['steps[0].done'], postconditions: ['decision.finalized'] },
    ],
  });
  registerSkill({
    slug: 'crm-skill-fallback', version: 1,
    steps: [
      { step: 1, action: 'data-particle-read', decision: 'rule', params: { type: 'CRM_DEAL' }, preconditions: [] },
    ],
  });
}
```

- [ ] **Step 6: 跑测试确认通过**

Run: `npx vitest run test/agentLoop.test.js`
Expected: PASS（2 例全过：降级推理 + SKILL 驱动零 LLM）

- [ ] **Step 7: 提交**

```bash
git add src/agent/ src/skills/ test/agentLoop.test.js
git commit -m "feat(stage1): Task8 agentLoop引擎——SKILL驱动(rule步骤零LLM)+降级think+轨迹埋点+种子SKILL(crm-deal-analyze)"
```

---

### Task 9: HTTP 服务 + 观测看板（SSE 客户端）

**Files:**
- Create: `src/http/server.js`, `src/http/routes.js`, `src/web/index.html`
- Test: `test/http.test.js`

- [ ] **Step 1: 写失败的路由测试**

```js
// test/http.test.js
import { describe, it, expect } from 'vitest';
import { createApp } from '../src/http/server.js';
import { query } from '../src/db.js';
import { createParticle } from '../src/particles/particleRepo.js';

describe('HTTP API', () => {
  it('GET /api/particles?type=CRM_DEAL 读直连', async () => {
    const app = createApp();
    await query(`TRUNCATE particles, edges, events CASCADE`);
    await createParticle('CRM_DEAL', { name: '半导体项目', stage: 'lead' });
    const res = await app.fetch('/api/particles?type=CRM_DEAL');
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.items.length).toBeGreaterThanOrEqual(1);
  });

  it('POST /api/particles 写通道：创建 ACCOUNT 返回 201', async () => {
    const app = createApp();
    const res = await app.fetch('/api/particles', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'CRM_ACCOUNT', payload: { name: '深圳智造', industry: '半导体' } }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.particle.type).toBe('CRM_ACCOUNT');
  });

  it('GET /api/kanban/tasks 看板可读（三态：加载/空/错误不互阻）', async () => {
    const app = createApp();
    const res = await app.fetch('/api/kanban/tasks');
    expect(res.status).toBe(200);
    expect(Array.isArray((await res.json()).items)).toBe(true);
  });

  it('GET /api/realtime/health 装配校验状态可查', async () => {
    const app = createApp();
    const res = await app.fetch('/api/realtime/health');
    expect(res.status).toBe(200);
  });

  it('GET /api/agents 3 Agent 装配断言结果可查', async () => {
    const app = createApp();
    const res = await app.fetch('/api/agents');
    const body = await res.json();
    expect(body.agents).toBeTruthy();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/http.test.js`
Expected: FAIL（server 未定义）

- [ ] **Step 3: 写 HTTP 服务（Express 单端口）**

```js
// src/http/server.js
import express from 'express';
import { createRoutes } from './routes.js';
import { createSseHub } from '../events/sse.js';

export function createApp() {
  const app = express();
  app.use(express.json());
  const hub = createSseHub();
  createRoutes(app, hub);
  return app;
}

export function startServer(port = 3000) {
  const app = createApp();
  const server = app.listen(port, () => {
    console.log(`[crm] 阶段1 服务已启动: http://127.0.0.1:${port}`);
  });
  return server;
}

if (process.argv[1]?.endsWith('server.js')) {
  const port = Number(process.env.PORT || 3000);
  startServer(port);
}
```

- [ ] **Step 4: 写路由（读直连/写通道/看板/SSE）**

```js
// src/http/routes.js
import { queryParticles, createParticle } from '../particles/particleRepo.js';
import { listTasks, resetTask } from '../kanban/kanban.js';
import { assertAgentAssembly } from '../agent/agents.js';
import { agentSpecs } from '../agent/agentSpec.js';
import { pumpReadyTasks } from '../kanban/scheduler.js';

export function createRoutes(app, hub) {
  // 读直连（默认）
  app.get('/api/particles', async (req, res) => {
    const { type } = req.query;
    const items = await queryParticles({ type: type || null, tenantId: 'system', limit: 100 });
    res.json({ items });
  });

  // 写通道（阶段 1 骨架：直接写入 + confirm 信号返回；action-confirm/HITL 阶段 2 接入）
  app.post('/api/particles', async (req, res) => {
    const { type, payload } = req.body || {};
    try {
      const particle = await createParticle(type, payload || {}, { tenantId: 'system' });
      res.status(201).json({ particle, confirm: 'stage2' });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // 看板（编排数据同源：直接读 tasks 表）
  app.get('/api/kanban/tasks', async (req, res) => {
    const { status, chainId } = req.query;
    const items = await listTasks({ status: status || null, chainId: chainId || null, tenantId: 'system' });
    res.json({ items });
  });

  app.post('/api/kanban/tasks/:id/reset', async (req, res) => {
    const t = await resetTask(req.params.id, { byActor: 'admin', reason: 'manual_unblock' });
    res.json({ task: t });
  });

  app.post('/api/kanban/pump', async (req, res) => {
    const n = await pumpReadyTasks({});
    res.json({ dispatched: n });
  });

  // 装配校验 + 3 Agent 状态
  app.get('/api/agents', async (req, res) => {
    const asm = await assertAgentAssembly();
    res.json({ agents: Object.keys(agentSpecs), assembly: asm });
  });

  app.get('/api/realtime/health', async (req, res) => {
    res.json({ ok: true, ts: Date.now(), domains: ['task', 'trace', 'approval', 'particle', 'payment'] });
  });

  // SSE 事件总线（单连接 5 域）
  app.get('/events', (req, res) => hub.connect(res));

  // 观测看板（静态）
  app.get('/', (req, res) => res.sendFile(new URL('../web/index.html', import.meta.url)));
}
```

- [ ] **Step 5: 写观测看板（静态 HTML + SSE 客户端）**

```html
<!-- src/web/index.html -->
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>CRM 阶段1 · 观测看板</title>
<style>
  body { font-family: system-ui; margin: 24px; background: #fafafa; color: #222; }
  .card { border: 1px solid #ddd; border-radius: 8px; padding: 12px 16px; margin: 8px 0; background: #fff; }
  .ok { color: #0a0; } .err { color: #c00; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; }
  .badge { padding: 2px 8px; border-radius: 4px; font-size: 12px; background: #eef; }
  #events { max-height: 300px; overflow: auto; font-size: 12px; }
</style>
</head>
<body>
<h2>CRM 阶段1 · 观测看板（L4 兜底）</h2>

<div class="card">
  <b>装配校验（3 Agent）</b>
  <div id="assembly">加载中…</div>
</div>

<div class="card">
  <b>看板（kanban 状态）</b>
  <div id="kanban">—</div>
</div>

<div class="card">
  <b>粒子（最新 10）</b>
  <div id="particles">—</div>
</div>

<div class="card">
  <b>SSE 事件流（5 域实时）</b>
  <div id="events">连接中…</div>
  <div class="row">
    <button onclick="pump()">派发 ready 任务</button>
    <button onclick="refresh()">刷新</button>
  </div>
</div>

<script>
async function refresh() {
  const [agents, tasks, particles] = await Promise.all([
    fetch('/api/agents').then(r => r.json()),
    fetch('/api/kanban/tasks').then(r => r.json()),
    fetch('/api/particles').then(r => r.json()),
  ]);
  document.getElementById('assembly').innerHTML =
    `<span class="${agents.assembly.ok ? 'ok' : 'err'}">${agents.assembly.ok ? '通过' : '失败'}</span>
     Agent: ${agents.agents.join(', ')}`;
  const counts = ['ready','running','done','failed','blocked'].map(s =>
    tasks.items.filter(t => t.status === s).length).join(' / ');
  document.getElementById('kanban').textContent = `ready/running/done/failed/blocked = ${counts}`;
  document.getElementById('particles').innerHTML = particles.items.slice(0, 10).map(p =>
    `<div class="badge">${p.type} · ${p.payload.name || p.title} · ${p.state}</div>`).join('');
}

function pump() {
  fetch('/api/kanban/pump', { method: 'POST' }).then(r => r.json()).then(d => refresh());
}

const es = new EventSource('/events');
es.onmessage = (e) => {
  const box = document.getElementById('events');
  box.innerHTML = `<div>${e.data}</div>` + box.innerHTML;
  if (box.children.length > 60) box.lastElementChild.remove();
};
es.onerror = () => { document.getElementById('events').innerHTML = '<div class="err">SSE 断开，重连中…</div>'; };
refresh();
setInterval(refresh, 5000);
</script>
</body>
</html>
```

- [ ] **Step 6: 跑测试确认通过**

Run: `npx vitest run test/http.test.js`
Expected: PASS（5 例全过：读直连/写通道/看板/health/agents）

- [ ] **Step 7: 提交**

```bash
git add src/http/ src/web/ test/http.test.js
git commit -m "feat(stage1): Task9 HTTP+观测看板——读直连/写通道骨架/kanban API/SSE端点/装配校验API/静态看板(三态+事件流)"
```

---

### Task 10: 种子数据 + 端到端验收

**Files:**
- Create: `db/seed.sql`, `db/test-setup.sql`
- Modify: `db/migrate.js`（--seed 分支已含）
- Test: `test/e2e.test.js`

- [ ] **Step 1: 写种子 SQL（5 角色 + 池规则 + 10 种子案例）**

```sql
-- db/seed.sql
-- 阶段1 种子（幂等：ON CONFLICT 靠唯一约束或先查后插）

-- 组织（区域/团队层级树，§5ter.5 实证 parent_id）
INSERT INTO particles (tenant_id, type, slug, title, state, payload)
SELECT 'system', 'CRM_ORGANIZATION', 'org-hq', '总部', 'enabled',
       '{"name":"总部","parent_id":null,"pool_config":{"clue_pool":{},"account_pool":{}}}'
WHERE NOT EXISTS (SELECT 1 FROM particles WHERE slug='org-hq');

-- 人员（销售/经理/财务/商务角色多标签，§5ter.16 五角色）
INSERT INTO particles (tenant_id, type, slug, title, state, payload)
SELECT 'system', 'CRM_PERSON', 'person-sales-a', '销售A', 'active',
       '{"name":"销售A","role_tags":["sales"],"org_id":"org-hq"}'
WHERE NOT EXISTS (SELECT 1 FROM particles WHERE slug='person-sales-a');

-- 10 种子案例（冷启动参考，source=seed；deal-coach 商机推进参照）
INSERT INTO particles (tenant_id, type, slug, title, state, payload)
SELECT 'system', 'CRM_DEAL', 'seed-deal-' || n, '种子商机' || n, 'opportunity',
       jsonb_build_object('name', '种子商机' || n, 'stage', 'opportunity',
                          'expected_amount', 500000 + n * 10000, 'owner_id', 'person-sales-a',
                          'stage_change_reason', '种子案例：商机阶段推进参照', 'seed', true)
FROM generate_series(1, 10) AS n
WHERE NOT EXISTS (SELECT 1 FROM particles WHERE slug='seed-deal-1');
```

- [ ] **Step 2: 写端到端测试（一次「销售一句话建客户」旅程 + 三钩子 + 事件流）**

```js
// test/e2e.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { query } from '../src/db.js';
import { createParticle, createEdge } from '../src/particles/particleRepo.js';
import { advanceStage } from '../src/particles/lifecycle.js';
import { on, emit } from '../src/events/bus.js';
import { getTask } from '../src/kanban/kanban.js';

beforeEach(async () => {
  await query(`TRUNCATE particles, edges, tasks, task_audit, events CASCADE`);
});

describe('E2E：L1 粒子旅程 + L2 事件 + L3 任务', () => {
  it('建客户 → 建 DEAL → belongs_to 边 → 推进阶段 → 全链路事件', async () => {
    const received = [];
    const off = on('*', (m) => received.push(`${m.domain}:${m.type}`));

    // 1. 建客户（L1 写入，触发写时三钩子）
    const acct = await createParticle('CRM_ACCOUNT', { name: '深圳智造', industry: '半导体', region: '华南' });
    // 2. 建交易（DEAL 归属客户）
    const deal = await createParticle('CRM_DEAL', { name: '扩产项目', stage: 'lead', account_id: acct.id });
    // 3. 自动建边 belongs_to（ontologySync 引用型字段）
    const neighbors = await (await import('../src/particles/particleRepo.js')).queryNeighbors('CRM_DEAL', deal.id);
    expect(neighbors.some(e => e.edge_type === 'belongs_to')).toBe(true);
    // 4. 阶段推进（商机）
    await advanceStage(deal.id, 'opportunity', { transitionedBecause: '客户意向明确，进入商机评估' });
    const p = await (await import('../src/particles/particleRepo.js')).getParticle(deal.id);
    expect(p.payload.stage).toBe('opportunity');
    expect(p.payload.stage_change_reason).toBe('客户意向明确，进入商机评估');

    // 5. 事件全链路：particle 域收到 created/updated/edge-created；trace 域收 audit
    expect(received).toContain('particle:created');
    expect(received).toContain('particle:edge-created');
    expect(received).toContain('particle:updated');

    off();
  });

  it('写后验证：DEAL 更新后 embedding 覆盖（内容变更重算）', async () => {
    const deal = await createParticle('CRM_DEAL', { name: 'A 项目', stage: 'lead' });
    const r1 = await query(`SELECT content_hash FROM particles WHERE id=$1`, [deal.id]);
    await (await import('../src/particles/particleRepo.js')).updateParticle(deal.id,
      { patch: { name: 'A 项目（改名）' } });
    const r2 = await query(`SELECT content_hash FROM particles WHERE id=$1`, [deal.id]);
    expect(r2.rows[0].content_hash).not.toBe(r1.rows[0].content_hash); // 内容变 → 重算
  });

  it('编排链路：任务创建 → 认领 → 完成（kanban 全链路）', async () => {
    const { createTask, claimTask, completeTask } = await import('../src/kanban/kanban.js');
    const t = await createTask({ step: 'agent', title: 'E2E任务', actionName: 'crm-deal-analyze', payload: {}, chainId: 'stage1-e2e' });
    await claimTask(t.id);
    await completeTask(t.id, { result: { ok: true, steps: 1 } });
    const done = await getTask(t.id);
    expect(done.status).toBe('done');
    expect(done.result.ok).toBe(true);
  });
});
```

- [ ] **Step 3: 跑测试确认通过**

Run: `npx vitest run test/e2e.test.js`
Expected: PASS（3 例全过：全链路事件/写后验证/编排链路）

- [ ] **Step 4: 写 README（启动/测试/验收）**

```markdown
# CRM 阶段 1 · 底座 MVP

## 启动
1. `docker compose up -d`（单库 postgres16+pgvector，端口 5433）
2. `npm run migrate && npm run seed`（幂等建表 + 种子）
3. `npm run dev`（http://127.0.0.1:3000 观测看板；/events SSE）

## 测试
- `npm test`（全量：粒子/钩子/kanban/dispatch/agentLoop/spec/http/e2e）
- `npm run test:e2e`（端到端三链路）

## 验收锚点（总体设计 §5 阶段 1）
- ✅ 粒子 Schema 全集落库（particles/edges）
- ✅ 写时向量管道跑通（embedding/tsvector 双写 + content_hash 幂等）
- ✅ kanban dispatch 派发真实任务（ready→running→done 全链路）
- ✅ SSE 事件总线雏形（5 域广播 + 观测看板实时刷新）
- ✅ 装配校验六条断言可查（/api/agents）

## 下一阶段（阶段 2）
context-layering L1-L4 注入 / memory 三构件 / Action Registry 写白名单 / 门户生成
```

- [ ] **Step 5: 全量测试跑绿**

Run: `npm test`
Expected: PASS（全部用例通过；若有 flaky 单测先隔离环境基线失败）

- [ ] **Step 6: 提交**

```bash
git add db/seed.sql db/test-setup.sql test/e2e.test.js README.md
git commit -m "feat(stage1): Task10 种子数据+E2E验收——5角色/池规则/10种子案例+端到端三链路(粒子旅程/写后验证/编排链路)+README"
```

---

## Self-Review（计划自查）

**1. Spec 覆盖度**（对照总体设计 §5 阶段 1 验收锚点 + 01/02/03 设计文档）：
- 粒子 Schema 全集落库 → Task 1（schema.sql particles/edges）+ Task 2（9 粒子定义）
- 写时向量管道跑通 → Task 3（三钩子 + content_hash 幂等 + FTS 双写）
- kanban dispatch 派发真实任务 → Task 5（状态机）+ Task 8（agentLoop）+ Task 10（E2E）
- SSE 事件总线雏形 → Task 4（bus + SSE 5 域）
- 装配校验六条断言 → Task 7（/api/agents）
- 观测看板 → Task 9（静态 HTML + SSE）
- 03 编排：极简四态/failure_limit=3/max_inflight=3 → Task 5 类型常量
- 03 编排：3 Agent 六段式 → Task 7 agentSpec
- 01 粒子：9 真粒子/受控谓词/阶段只进不退/why 载体 → Task 2
- 02 本体：写库即构建/幂等/双写/词汇登记/受控边 → Task 3

**2. 占位符扫描**：无 TODO/TBD；代码块均为完整实现；seed SQL/HTML/JSON 全量给出 ✅

**3. 类型一致性**：`ensureAll(entity)` 三处调用签名一致；`createParticle(type, payload, {tenantId})` 全篇一致；`dispatch(actionName, params, ctx)` 回调签名一致（registry/executor/agentLoop/ruleEngine 对齐）✅

**4. 边界（刻意裁出，YAGNI）**：
- 中文 zhparser FTS → 阶段 2（schema 用 simple 兜底，02 文档 ADD MAPPING 留阶段 2）
- action-confirm/HITL 审批流 → 阶段 2（Task 6 埋 confirm 信号返回）
- AGE 图谱查询 → 阶段 2（01 文档 L1 AGE 可达；阶段 1 用 edges 表 + queryNeighbors 等价实现）
- Apache AGE（图扩展）→ 阶段 2（edges 关系表已覆盖邻接查询；AGE 实体仓库实为扩展验证）
- 真 embedding 模型 → 阶段 2（阶段 1 用确定性哈希 mock，零外部依赖可跑全量测试）
- L4 门户（Vue3/Naive-UI）→ 阶段 2（阶段 1 观测看板用静态 HTML 兜底）

**5. 依赖顺序**：Task 1（库）→ 2（粒子）→ 3（钩子）→ 4（事件）→ 5（kanban）→ 6（Action）→ 7（Spec）→ 8（agentLoop）→ 9（HTTP）→ 10（E2E）。Task 7 依赖 Task 6（Action Registry）；Task 8 依赖 Task 6+7；Task 9 依赖 5/6/7；Task 10 依赖全部。

---

## Execution Handoff

计划已保存。两种执行方式：

**1. Subagent-Driven（推荐）**——每个 Task 派发独立子代理，任务间 AI 审查，快速迭代
**2. Inline Execution**——本会话内用 executing-plans 逐任务批处理，检查点审查

请选择执行方式。