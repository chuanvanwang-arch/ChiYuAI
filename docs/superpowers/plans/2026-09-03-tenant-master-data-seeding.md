# 按租户播种主数据（Plan B 落地）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现「按租户播种主数据」能力，让新租户上线即拥有本租户自有的四类主数据副本（CRM_PRODUCT / CRM_PRICE_LIST / CRM_OFFER_POLICY / CRM_DICT_ENTRY），落实「全部数据走方案 B（每租户自有）」已拍板决策。

**Architecture:** 新增通用复制引擎 `scripts/seed-tenant-master-data.mjs`，从 `system` 模板库按 `stable_key = sha256(tenant|type|slug)` 幂等复制到目标租户；可选 `tenant-profile.masterData` 配置做行级筛选（默认四类全复制）；纯 INSERT 幂等（禁 DELETE 铁律），复制后 `embedding/content_hash/fts/decision_id = NULL`（首次编辑触发写时索引）。接入 `industry-onboarding` Runbook，使新行业上线开箱即得主数据。

**Tech Stack:** Node 22 ESM、`pg` (node-postgres)、`dotenv`、PostgreSQL 16 + `pgcrypto`；测试用 vitest（默认连 `crm_native_test`）。复用的既有模块：`src/db.js`(`pool`/`query`/`queryWrite`)、`src/config/configStore.js`(`readConfig`)、`src/particles/mintId.js`(`computeParticleStableKey`)。

---

## 文件结构

| 动作 | 路径 | 职责 |
|---|---|---|
| Create | `scripts/seed-tenant-master-data.mjs` | 通用复制引擎：CLI `--tenant <id> [--dry-run]` + 可导出 `seedTenantMasterData()` / 纯函数 `planCopy()` / `passFilter()` |
| Create | `test/seed/tenant-master-data.test.mjs` | 单元测试 `planCopy`/`passFilter`/stable_key 隔离（纯函数，不触 DB） |
| Modify | `db/seed/seed-all-tenants.mjs` | 在「配置画像」之后追加「播种本租户主数据」调用（幂等可重跑） |
| Modify | `plugin-platform-admin/skills/industry-onboarding/SKILL.md` | 新增 **Step 4B — 播种本租户主数据**，并同步 §1 流程与 §7 清单 |

设计依据：`docs/2026-09-03-tenant-master-data-seeding-design.md`（已批准）。关联决策：`docs/2026-09-03-attio-lightfield-study.md` §1「全部数据走方案 B」。

---

## Task 1：复制引擎 `scripts/seed-tenant-master-data.mjs` + 单元测试

**Files:**
- Create: `scripts/seed-tenant-master-data.mjs`
- Create: `test/seed/tenant-master-data.test.mjs`

### Step 1：写失败测试（TDD）

创建 `test/seed/tenant-master-data.test.mjs`：

```js
import { describe, it, expect } from 'vitest';
import { planCopy, passFilter } from '../../scripts/seed-tenant-master-data.mjs';
import { computeParticleStableKey } from '../../src/particles/mintId.js';

const rows = [
  { slug: 'p1', title: '产品1', state: 'ACTIVE', payload: { category: '软件' }, created_at: new Date(), updated_at: new Date() },
  { slug: 'p2', title: '产品2', state: 'ACTIVE', payload: { category: '硬件' }, created_at: new Date(), updated_at: new Date() },
  { slug: 'p3', title: '产品3', state: 'ACTIVE', payload: {}, created_at: new Date(), updated_at: new Date() },
];

describe('planCopy', () => {
  it('默认全复制（filter 空）', () => {
    const out = planCopy({ sourceRows: rows, type: 'CRM_PRODUCT', tenantId: 'acme-chem', filter: {} });
    expect(out).toHaveLength(3);
    expect(out[0].tenant_id).toBe('acme-chem');
    expect(out[0].stable_key).toBe(computeParticleStableKey('CRM_PRODUCT', 'p1', 'acme-chem'));
    expect(out[0].decision_id).toBeUndefined();
  });

  it('CRM_PRODUCT 按 payload.category 白名单筛选', () => {
    const out = planCopy({ sourceRows: rows, type: 'CRM_PRODUCT', tenantId: 'acme-chem', filter: { category: ['软件'] } });
    expect(out.map((r) => r.slug)).toEqual(['p1']);
  });

  it('非 CRM_PRODUCT 忽略 filter 放行', () => {
    const out = planCopy({ sourceRows: rows, type: 'CRM_PRICE_LIST', tenantId: 'acme-chem', filter: { category: ['软件'] } });
    expect(out).toHaveLength(3);
  });
});

describe('passFilter', () => {
  it('非 CRM_PRODUCT 恒放行', () => {
    expect(passFilter('CRM_DICT_ENTRY', rows[0], { category: ['软件'] })).toBe(true);
  });
  it('CRM_PRODUCT 命中/未命中白名单', () => {
    expect(passFilter('CRM_PRODUCT', rows[0], { category: ['软件'] })).toBe(true);
    expect(passFilter('CRM_PRODUCT', rows[1], { category: ['软件'] })).toBe(false);
  });
});

describe('stable_key 租户隔离', () => {
  it('同一 slug 在不同租户 stable_key 不同 → 复制不冲突', () => {
    const a = computeParticleStableKey('CRM_PRODUCT', 'p1', 'system');
    const b = computeParticleStableKey('CRM_PRODUCT', 'p1', 'acme-chem');
    expect(a).not.toBe(b);
  });
});
```

### Step 2：运行测试确认失败

Run: `node node_modules/vitest/vitest.mjs run test/seed/tenant-master-data.test.mjs`
Expected: FAIL —— `Cannot find module '../../scripts/seed-tenant-master-data.mjs'`（模块尚未创建）。

### Step 3：实现复制引擎

创建 `scripts/seed-tenant-master-data.mjs`：

```js
// scripts/seed-tenant-master-data.mjs — 按租户播种主数据（Plan B 落地）
// 设计：docs/2026-09-03-tenant-master-data-seeding-design.md
// 从 system 模板库复制四类主数据到目标租户，幂等（stable_key 冲突跳过），
// 可选 tenant-profile.masterData 行级筛选（默认全复制）。
//
// 安全：仅 INSERT ... ON CONFLICT (stable_key) DO NOTHING；无 DELETE/TRUNCATE/DROP（禁 DELETE 铁律）。
// 系统运维写：decision_id 保持 NULL（与 system 历史行一致，豁免决策第0闸）。
// 复制后 embedding/content_hash/fts = NULL（首次编辑触发写时索引）。
//
// 用法：
//   生产：node scripts/seed-tenant-master-data.mjs --tenant acme-chem
//   测试：PGDATABASE=crm_native_test node scripts/seed-tenant-master-data.mjs --tenant acme-chem
//   演练：node scripts/seed-tenant-master-data.mjs --tenant acme-chem --dry-run
import { pool, query, queryWrite } from '../src/db.js';
import { computeParticleStableKey } from '../src/particles/mintId.js';
import { readConfig } from '../src/config/configStore.js';

export const TYPES = ['CRM_PRODUCT', 'CRM_PRICE_LIST', 'CRM_OFFER_POLICY', 'CRM_DICT_ENTRY'];

// 纯函数：将源行按筛选规则映射为目标租户待插入行（不触 DB，便于单测）。
export function planCopy({ sourceRows, type, tenantId, filter = {} }) {
  const out = [];
  for (const r of sourceRows) {
    if (!passFilter(type, r, filter)) continue;
    out.push({
      tenant_id: tenantId,
      type,
      slug: r.slug,
      title: r.title,
      state: r.state || 'ACTIVE',
      payload: r.payload || {},
      created_at: r.created_at || null,
      updated_at: r.updated_at || null,
      stable_key: computeParticleStableKey(type, r.slug, tenantId),
    });
  }
  return out;
}

// 行级筛选：仅 CRM_PRODUCT 支持 payload.category ∈ 白名单；其余类型默认放行。
export function passFilter(type, row, filter = {}) {
  if (type !== 'CRM_PRODUCT') return true;
  const cats = filter && filter.category;
  if (!Array.isArray(cats) || cats.length === 0) return true;
  const c = row && row.payload && row.payload.category;
  return cats.includes(c);
}

// 解析 tenant-profile.masterData 配置 → { enabled, types, filter }
function resolveMasterData(profileValue) {
  const md = (profileValue && profileValue.masterData) || {};
  if (md.enabled === false) return { enabled: false, types: [], filter: {} };
  const types = Array.isArray(md.types) && md.types.length > 0 ? md.types : TYPES;
  return { enabled: true, types, filter: md.filter || {} };
}

// 主播种函数（不 pool.end，供 main 与 seed-all-tenants.mjs 复用）。
// 返回 { tenantId, copied, skipped, types, dryRun }。
export async function seedTenantMasterData(tenantId, { dryRun = false, readConfigFn = readConfig } = {}) {
  if (!tenantId || tenantId === 'system') {
    throw new Error("tenantId 非法：必须为非空且非 'system'（禁止把模板复制回模板）");
  }
  const prof = await readConfigFn('tenant-profile', { tenantId });
  const md = resolveMasterData(prof && prof.value);
  if (!md.enabled) {
    console.log(`[seed-tenant-master-data] ${tenantId}: masterData.enabled=false → 不复制任何主数据`);
    return { tenantId, copied: 0, skipped: 0, types: {}, dryRun };
  }
  const stats = { tenantId, copied: 0, skipped: 0, types: {}, dryRun };
  for (const type of md.types) {
    const { rows } = await query(
      `SELECT id, type, slug, title, state, payload, created_at, updated_at
       FROM crm.particles WHERE tenant_id='system' AND type=$1`,
      [type]
    );
    const plan = planCopy({ sourceRows: rows, type, tenantId, filter: md.filter[type] || {} });
    let copied = 0;
    let skipped = 0;
    for (const row of plan) {
      if (dryRun) { copied += 1; continue; }
      const res = await queryWrite(
        `INSERT INTO crm.particles
           (tenant_id, type, slug, title, state, payload, created_at, updated_at, stable_key,
            embedding, content_hash, fts, decision_id)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9, NULL, NULL, NULL, NULL)
         ON CONFLICT (stable_key) DO NOTHING`,
        [row.tenant_id, row.type, row.slug, row.title, row.state,
         JSON.stringify(row.payload), row.created_at, row.updated_at, row.stable_key]
      );
      if ((res.rowCount ?? 0) > 0) copied += 1; else skipped += 1;
    }
    stats.types[type] = { source: rows.length, planned: plan.length, copied, skipped };
    stats.copied += copied;
    stats.skipped += skipped;
    console.log(`[seed-tenant-master-data] ${tenantId}/${type}: 源 ${rows.length} → 计划 ${plan.length} → 复制 ${copied} / 跳过 ${skipped}`);
  }
  return stats;
}

// CLI 入口（仅作为入口运行时执行）
async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const ti = args.indexOf('--tenant');
  const tenantId = ti >= 0 ? args[ti + 1] : undefined;
  if (!tenantId) {
    console.error('用法: node scripts/seed-tenant-master-data.mjs --tenant <id> [--dry-run]');
    process.exit(2);
  }
  const stats = await seedTenantMasterData(tenantId, { dryRun });
  console.log(JSON.stringify(stats, null, 2));
  await pool.end();
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((e) => {
    console.error('[seed-tenant-master-data] 失败:', e.message);
    process.exit(1);
  });
}
```

### Step 4：运行测试确认通过

Run: `node node_modules/vitest/vitest.mjs run test/seed/tenant-master-data.test.mjs`
Expected: PASS（4 个用例全绿）。

### Step 5：禁 DELETE 自检（铁律）

Run: `grep -nE "DELETE|TRUNCATE|DROP" scripts/seed-tenant-master-data.mjs`
Expected: 无输出（脚本不含任何破坏性语句；仅有注释性说明「禁 DELETE 铁律」字样不计入语句匹配，确认无实际 `DELETE`/`TRUNCATE`/`DROP` SQL 关键字）。

### Step 6：提交（AI 不提交，由用户本地执行）

```bash
git add scripts/seed-tenant-master-data.mjs test/seed/tenant-master-data.test.mjs
git commit -m "feat: 新增按租户播种主数据复制引擎（Plan B 落地，幂等禁 DELETE）"
```

---

## Task 2：接入行业上线 Runbook

**Files:**
- Modify: `db/seed/seed-all-tenants.mjs`
- Modify: `plugin-platform-admin/skills/industry-onboarding/SKILL.md`

### Step 1：修改 `industry-onboarding/SKILL.md` 新增 Step 4B

在 `## 5. Step 4 — 经真实写通道建粒子（MCP = actionExecutor.dispatch）` 末尾句「**本步自动验证**：结算单 `commission` 被自动算为 `(100-60)*0.1 = 4`，无需任何代码。」之后、原 `## 6. Step 5 — 产出初始销售员账号（最终交付物）` 之前，插入：

````markdown
## 5. Step 4B — 播种本租户主数据（system 模板复制，Plan B 落地）

新租户开箱即拥有一份**本租户自有**的四类主数据副本（CRM_PRODUCT / CRM_PRICE_LIST / CRM_OFFER_POLICY / CRM_DICT_ENTRY），来源为 `system` 模板库。复制后**独立演进**，行业画像不裁剪。

```powershell
# 测试库预演（确认复制/跳过条数，不落库）
$env:PGDATABASE="crm_native_test"
node scripts/seed-tenant-master-data.mjs --tenant acme-chem --dry-run
# 正式播种（幂等 INSERT ... ON CONFLICT (stable_key) DO NOTHING）
node scripts/seed-tenant-master-data.mjs --tenant acme-chem
```

可选配置（落 `tenant-profile.masterData`，默认四类全复制）：

```jsonc
{ "masterData": {
    "enabled": true,
    "types": ["CRM_PRODUCT","CRM_PRICE_LIST","CRM_OFFER_POLICY","CRM_DICT_ENTRY"],
    "filter": { "CRM_PRODUCT": { "category": ["软件","印制服务","服务"] } }
} }
```

- `enabled=false` → 不复制任何主数据（极端空目录场景）。
- `filter` 仅作用于 `CRM_PRODUCT.payload.category`；其余类型默认全复制。
- 铁律：仅 INSERT 幂等、禁 DELETE；系统写 `decision_id=NULL`；复制后 `embedding/content_hash/fts=NULL`（首次编辑触发写时索引）。
````

同步修改 §1 流程描述：

- old：`按序执行 Step 1 → Step 6；Step 6 的**初始销售员账号（用户名+密码）即最终交付物**。`
- new：`按序执行 Step 1 → Step 4B → Step 5；Step 5 的**初始销售员账号（用户名+密码）即最终交付物**；Step 4B 确保租户开箱即得主数据（product-catalog 非空）。`

同步修改 §7 上线检查清单，在「- [ ] 经 `crm-import-batch`（MCP）建粒子成功，on_write 公式自动回写」之后追加一行：

```markdown
- [ ] 经 `scripts/seed-tenant-master-data.mjs --tenant <id>` 播种本租户主数据成功（验收：带本租户 token 访问 `/api/particles?type=CRM_PRODUCT` 非空）
```

### Step 2：修改 `db/seed/seed-all-tenants.mjs` 追加播种调用

在 import 段末尾追加一行：

```js
import { seedTenantMasterData } from '../../scripts/seed-tenant-master-data.mjs';
```

在「// ① 配置画像（tenant-profile）」块之后、「// ② 初始销售员」之前，插入：

```js
// ①B 播种本租户主数据（system 模板复制，Plan B；幂等，依赖 system 已灌主数据）
await seedTenantMasterData(CHEM_TENANT);
await seedTenantMasterData(INSMEDI_TENANT);
```

即在原文件中：

```js
// ① 配置画像（tenant-profile）
await seedChemicalProfile(CHEM_TENANT);
await seedInsMediProfile(INSMEDI_TENANT);

// ①B 播种本租户主数据（system 模板复制，Plan B；幂等，依赖 system 已灌主数据）
await seedTenantMasterData(CHEM_TENANT);
await seedTenantMasterData(INSMEDI_TENANT);

// ② 初始销售员
const chemInserted = await seedChemicalSalesUser();
const insmediInserted = await seedInsMediSalesUser();
```

### Step 3：提交（AI 不提交，由用户本地执行）

```bash
git add db/seed/seed-all-tenants.mjs plugin-platform-admin/skills/industry-onboarding/SKILL.md
git commit -m "feat: 行业上线 Runbook 接入按租户播种主数据（Step 4B）"
```

---

## Task 3：对测试库执行验证（验收标准 1–6）

> 全部在测试库 `crm_native_test` 执行，不污染生产。生产执行仅在用户确认后、显式 `PGDATABASE=crm_native` 跑。

### Step 1：确保 system 模板库已灌（Runbook 前置）

Run: `PGDATABASE=crm_native_test node scripts/seed-master-data.mjs`
Expected: 打印 `[seed-master-data] 注入完成` 及四类条数（CRM_PRODUCT 12 等），无报错。

### Step 2：对 acme-chem 正式播种

Run: `PGDATABASE=crm_native_test node scripts/seed-tenant-master-data.mjs --tenant acme-chem`
Expected: 打印每类「源 12 → 计划 12 → 复制 12 / 跳过 0」（或筛选后对应数量），统计 `copied≥12, skipped=0`。

### Step 3：幂等验证（连跑第二次应为 0 插入）

Run: `PGDATABASE=crm_native_test node scripts/seed-tenant-master-data.mjs --tenant acme-chem`
Expected: 每类「复制 0 / 跳过 12」，`copied=0, skipped=12`（stable_key 冲突跳过）。

### Step 4：验收 1–6 核对（SQL 查询，用 node 直连避免 psql 不可用）

Run（验收 1 开箱可得 + 验收 2 隔离生效 + 验收 6 回归无碍）：

```bash
PGDATABASE=crm_native_test node -e "const {pool}=require('./src/db.js');(async()=>{const t=await pool.query(\"SELECT type,count(*)::int n FROM crm.particles WHERE tenant_id='acme-chem' GROUP BY type ORDER BY type\");console.log('acme-chem 主数据:');console.table(t.rows);const s=await pool.query(\"SELECT count(*)::int n FROM crm.particles WHERE tenant_id='system' AND type='CRM_PRODUCT'\");console.log('system 模板 CRM_PRODUCT 仍:',s.rows[0].n,'条（未被影响）');const dup=await pool.query(\"SELECT count(*)::int n FROM crm.particles WHERE stable_key IN (SELECT stable_key FROM crm.particles WHERE tenant_id='acme-chem' AND type='CRM_PRODUCT') AND tenant_id<>'acme-chem'\");console.log('与 system 冲突行:',dup.rows[0].n,'(应为0)');await pool.end();})().catch(e=>{console.error(e.message);process.exit(1)})"
```

Expected: `acme-chem` 四类条数 = system 模板条数（验收 1）；`system` 模板条数不变（验收 2/6）；冲突行 = 0（stable_key 隔离）。

### Step 5：验收 4 禁 DELETE 自检 + 验收 5 配置零代码确认

Run: `grep -rnE "DELETE|TRUNCATE|DROP" scripts/seed-tenant-master-data.mjs db/seed/seed-all-tenants.mjs`
Expected: 仅注释，无实际破坏性 SQL。

新增一个行业租户（如 acme-edu）仅需在 `db/seed/` 加 `tenant-profile-edu.js` + `tenant-users-edu.js` 并调用 `seedTenantMasterData('acme-edu')`，**无新脚本/字面量**（验收 5）；`masterData` 缺省即四类全复制。

### Step 6：写实施记录 + 提交

在实施记录 `docs/2026-09-03-tenant-master-data-seeding-impl-log.md` 写入：执行时间、测试库、acme-chem 各类复制条数、幂等结果、验收 1–6 结论。

```bash
git add docs/2026-09-03-tenant-master-data-seeding-impl-log.md
git commit -m "docs: 按租户播种主数据实施记录（测试库验收 1-6 通过）"
```

---

## 自我审查（Self-Review）

1. **Spec 覆盖**：设计文档 §4.1 引擎 / §4.2 幂等 / §4.3 字段映射 / §4.4 配置筛选 / §4.5 Runbook 接入 / §5 验收 1–6 —— 全部映射到 Task 1–3，无遗漏。
2. **占位符扫描**：无 TBD/TODO/「类似 Task N」；每个代码 step 均给完整源码；每个命令给预期输出。
3. **类型一致性**：`seedTenantMasterData(tenantId, {dryRun, readConfigFn})`、`planCopy({sourceRows,type,tenantId,filter})`、`passFilter(type,row,filter)`、`computeParticleStableKey(type,slug,tenantId)` 在 Task 1 测试与实现、Task 2/3 调用处签名一致。`TYPES` 为四处共用常量。
4. **铁律合规**：全脚本仅 INSERT 幂等（ON CONFLICT DO NOTHING），`decision_id=NULL`，拒绝 `tenantId='system'`，无 DELETE/TRUNCATE/DROP（Step 5 自检）。
5. **DB 范式一致**：复用 `pool`/`query`(读池)/`queryWrite`(写池) 来自 `src/db.js`，与 `scripts/seed-master-data.mjs` 同构；`stable_key` 重算用 `computeParticleStableKey` 与 `db/schema.sql:21,29` 唯一索引一致。
