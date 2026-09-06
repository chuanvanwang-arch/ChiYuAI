# 粒子属性元模型 UI 补丁（缺口1渲染隐藏 / 缺口2种子完整性）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐已实现的粒子属性元模型的两处实质缺口——①渲染层按角色隐藏/只读字段（V3 判据）②种子物化覆盖全部粒子（含 11 个 APPROVAL_*），并修正 baseline `enabled:false` 导致种子后运行时 `modelFor` 全不可见的同源 latent bug。

**Architecture:** 缺口2 在 seed 物化层扩展——对所有定义 `identity` 的粒子把主键属性注册为 baseline（`enabled:true, required:true`），与 `coreAttributes` 去重；缺口1 在组合层 `buildAttrFormSchema` 用既有 `modeFor` 预解析角色权限注入 Schema 组件，渲染器保持纯函数/同步，仅消费 `comp.hidden/comp.readonly`。

**Tech Stack:** Node 22 + ESM + Vitest 3；PostgreSQL 16（`crm.meta_attr`）；既有模块 `metaAttrModel.js` / `metaAttrRepo.js` / `fieldPermission.js` / `renderer.js` / `validator.js` / `schema.js`。

**上游基线：** `docs/2026-08-26-particle-attr-ui-patch-design.md`（已批准，2026-08-26 10:56）。

---

## File Structure

| 动作 | 文件 | 职责 |
|---|---|---|
| Modify | `src/metaAttr/metaAttrModel.js` | `recordFor` baseline `enabled` 由 `false`→`true`；新增 `identityRecordFor(particleType, attrSlug)` |
| Modify | `src/metaAttr/metaAttrRepo.js` | `seedMetaAttr` 在 coreAttributes 循环后追加 identity 兜底循环（去重 + 幂等），导入 `identityRecordFor` |
| Modify | `src/page/renderer.js` | `attr-field` 分支消费 `comp.hidden`/`comp.readonly`（hidden→锁定占位无 input；readonly→disabled input；均带 `data-perm` + 锁标记） |
| Create | `src/page/attrFormSchema.js` | 组合层 `buildAttrFormSchema(particleType, roleTag)`：用 `modeFor` 预解析权限产出受控表单 Schema |
| Test | `test/meta-attr-model.test.js` | 编辑 `recordFor` 断言 `enabled:true`；新增 `identityRecordFor` 单测（纯逻辑，无 DB） |
| Test | `test/meta-attr-repo.test.js` | 编辑种子行 `enabled` 断言为 `true`；新增「全粒子 identity 兜底」describe（DB） |
| Test | `test/meta-attr-page.test.js` | 新增「attr-field 渲染层角色权限」describe（纯逻辑，无 DB） |
| Test | `test/attr-form-schema.test.js` | 新建：`buildAttrFormSchema` + `renderPage` 端到端（DB） |

**铁律/约定：**
- 每个 Task 一 commit；TDD（先红后绿）。
- 测试命令统一用沙箱隔离的 vitest 直跑：`node node_modules/vitest/vitest.mjs run <file>`（禁 `npx`/`npm install`）。
- DB 集成测试需 PG@5433；沙箱无 PG 时该测试为环境门控（非回归），代码先落待本机验证。
- `comp.hidden/comp.readonly` 为新增可选字段，`validator.js` 的 `attr-field` 分支仅校验 `attrSlug`/`attrType` 后 `continue`，不破坏既有校验。

---

## Task 1: metaAttrModel — recordFor 基线 enabled=true + identityRecordFor

**Files:**
- Modify: `src/metaAttr/metaAttrModel.js:35-46`（改 `recordFor`）+ 新增 `identityRecordFor`
- Modify: `test/meta-attr-model.test.js:58-67`（改 `recordFor` 断言）+ 同文件新增 `identityRecordFor` describe（纯逻辑）
- Modify: `test/meta-attr-repo.test.js:18-26`（种子行 `enabled` 断言 `false`→`true`，DB 门控，仅编辑不增逻辑）

- [ ] **Step 1: 写失败测试（纯逻辑，无 DB）**

`test/meta-attr-model.test.js` 现有 `recordFor` 测试改为断言 `enabled:true`，并新增 `identityRecordFor` 测试：

```js
// 修改既有 describe('recordFor（coreAttributes 物化 seed 记录）') 内第一个 it：
  it('seed 记录：title=slug、source=manual、enabled=true（latent 修正：baseline 即生效）、语义桶归位', () => {
    const def = { coreAttributes: { name: 'text', domains: 'domain' } };
    const rec = recordFor('CRM_ACCOUNT', 'domains', def);
    expect(rec).toEqual({
      particle_type: 'CRM_ACCOUNT', attr_slug: 'domains', title: 'domains',
      attr_type: 'domain', semantic_tag: 'firmographic',
      required: false, unique: false, description: null, options: null, source: 'manual',
      display: {}, validation: {}, permission: {}, enabled: true, version: 1, created_by: 'seed',
    });
  });

// 新增 describe：
describe('identityRecordFor（种子完整性：identity 兜底）', () => {
  it('缺省类型兜底 text + required=true + source=manual', () => {
    // CRM_DEAL 仅 identity=['name']，无 coreAttributes → 类型兜底 text
    const r = identityRecordFor('CRM_DEAL', 'name');
    expect(r.enabled).toBe(true);
    expect(r.required).toBe(true);
    expect(r.source).toBe('manual');
    expect(r.attr_type).toBe('text');
  });

  it('slug 同现 coreAttributes 时取真实类型（去重由 repo 层负责）', () => {
    // CRM_ACCOUNT coreAttributes.name='text'
    const r = identityRecordFor('CRM_ACCOUNT', 'name');
    expect(r.attr_type).toBe('text');
    expect(r.required).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/meta-attr-model.test.js`
Expected: FAIL —— `recordFor` 仍返回 `enabled:false`；`identityRecordFor` 未定义（`ReferenceError`）。

- [ ] **Step 3: 最小实现**

`src/metaAttr/metaAttrModel.js`：
1. 改 `recordFor` 返回值 `enabled: false` → `enabled: true`（同文件 :44）。
2. 在 `recordFor` 之后新增（该文件已 `import { ... PARTICLE_TYPES } from '../particles/particleModel.js'`，无需新增 import）：

```js
// identity 兜底记录（种子完整性：所有定义 identity 的粒子注册主键属性为 baseline）
export function identityRecordFor(particleType, attrSlug) {
  const def = PARTICLE_TYPES[particleType] || {};
  const coreType = def.coreAttributes?.[attrSlug];
  const attrType = (coreType && ATTRIBUTE_TYPE_SET.has(coreType)) ? coreType : 'text';
  return {
    particle_type: particleType, attr_slug: attrSlug, title: attrSlug,
    attr_type: attrType, semantic_tag: mapSemanticTag(attrSlug),
    required: true, unique: false, description: null, options: null, source: 'manual',
    display: {}, validation: {}, permission: {}, enabled: true, version: 1, created_by: 'seed',
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run test/meta-attr-model.test.js`
Expected: PASS（含新增 2 例 + 修改后的 recordFor 断言）。

- [ ] **Step 5: 修复下游种子断言（同一基线变更的直接后果）**

编辑 `test/meta-attr-repo.test.js:18-26`，把测试名与断言翻转（DB 门控，仅编辑）：

```js
  it('CRM_ACCOUNT.coreAttributes 全部物化且 enabled=true/source=manual', async () => {
    const rows = await listMetaAttr({ particleType: 'CRM_ACCOUNT' });
    const slugs = rows.map((r) => r.attr_slug);
    expect(slugs).toContain('name');
    expect(slugs).toContain('domains');
    expect(slugs).toContain('champion_strength');
    expect(rows.every((r) => r.enabled === true)).toBe(true);
    expect(rows.every((r) => r.source === 'manual')).toBe(true);
  });
```

> 注：`meta-attr-schema.test.js:42` 断言的是 **DB 列默认值**（`INSERT` 不写 enabled 时取列默认 `false`），本补丁不改列默认，故该断言不动。`modelFor` 测试（model.test.js:49）与 `adaptiveRecordFor`（`enabled:false`）不受影响。

- [ ] **Step 6: 运行元模型单测套件（纯逻辑部分）确认绿**

Run: `node node_modules/vitest/vitest.mjs run test/meta-attr-model.test.js`
Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add src/metaAttr/metaAttrModel.js test/meta-attr-model.test.js test/meta-attr-repo.test.js
git commit -m "fix(meta-attr): recordFor baseline enabled=true + identityRecordFor（种子完整性 + latent 修正）"
```

---

## Task 2: metaAttrRepo.seedMetaAttr — identity 兜底播种（去重 + 幂等）

**Files:**
- Modify: `src/metaAttr/metaAttrRepo.js:5`（import 增 `identityRecordFor`）+ `:9-27`（`seedMetaAttr` 追加 identity 循环）
- Test: `test/meta-attr-repo.test.js`（新增「全粒子 identity 兜底」describe，DB 门控）

- [ ] **Step 1: 写失败测试（DB 门控）**

在 `test/meta-attr-repo.test.js` 末尾新增（自带 `beforeAll` 隔离，避免与既有 adaptive/setMetaAttr 用例互相污染计数）：

```js
describe('种子完整性：全粒子 identity 兜底', () => {
  beforeAll(async () => {
    await query(`TRUNCATE particles, edges, events, decision, decision_event, meta_attr CASCADE`).catch(() => {});
    await seedMetaAttr('system');
  });

  it('CRM_DEAL 仅 identity name → 1 行且 enabled/required/source 正确', async () => {
    const r = await getMetaAttr('CRM_DEAL', 'name');
    expect(r).not.toBeNull();
    expect(r.enabled).toBe(true);
    expect(r.required).toBe(true);
    expect(r.source).toBe('manual');
    const all = await listMetaAttr({ particleType: 'CRM_DEAL', enabled: true });
    expect(all.length).toBe(1);
  });

  it('CRM_APPROVAL_FLOW 身份兜底生效（含 APPROVAL 配置粒子）', async () => {
    const r = await getMetaAttr('CRM_APPROVAL_FLOW', 'name');
    expect(r).not.toBeNull();
    expect(r.enabled).toBe(true);
  });

  it('CRM_ACCOUNT name 同现 coreAttributes+identity → 仅 1 行（去重）', async () => {
    const all = await listMetaAttr({ particleType: 'CRM_ACCOUNT' });
    const names = all.filter((x) => x.attr_slug === 'name');
    expect(names.length).toBe(1);
  });

  it('全量 enabled 行数 = Σ(各粒子 coreAttributes∪identity 去重)', async () => {
    const expected = Object.entries(PARTICLE_TYPES).reduce((acc, [, def]) => {
      const set = new Set([...Object.keys(def.coreAttributes || {}), ...(def.identity || [])]);
      return acc + set.size;
    }, 0);
    const all = await listMetaAttr({ enabled: true });
    expect(all.length).toBe(expected);
  });
});
```

需在文件顶部 import 补 `PARTICLE_TYPES`（若该文件尚未导入）：确认 `import { PARTICLE_TYPES } from '../src/particles/particleModel.js';` 存在，否则新增。

- [ ] **Step 2: 运行测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/meta-attr-repo.test.js -t "种子完整性"`
Expected: FAIL —— `CRM_DEAL` 的 `name` 行不存在（当前 seed 不物化无 coreAttributes 的粒子），`CRM_APPROVAL_FLOW` 同理。

- [ ] **Step 3: 最小实现**

`src/metaAttr/metaAttrRepo.js`：
1. `:5` import 改为：
```js
import { recordFor, adaptiveRecordFor, identityRecordFor } from './metaAttrModel.js';
```
2. `seedMetaAttr`（`:9-27`）改为：
```js
export async function seedMetaAttr(actor = 'system') {
  for (const [ptype, def] of Object.entries(PARTICLE_TYPES)) {
    const coreKeys = new Set(Object.keys(def.coreAttributes || {}));
    // 既有：coreAttributes 物化
    for (const slug of coreKeys) {
      const rec = recordFor(ptype, slug, def);
      await query(
        `INSERT INTO crm.meta_attr
           (particle_type, attr_slug, title, attr_type, semantic_tag, required, "unique", description, options,
            source, display, validation, permission, enabled, version, created_by)
         SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9
         WHERE NOT EXISTS (SELECT 1 FROM crm.meta_attr WHERE particle_type=$1 AND attr_slug=$2)`,
        [rec.particle_type, rec.attr_slug, rec.title, rec.attr_type, rec.semantic_tag,
         rec.required, rec.unique, rec.description, rec.options,
         rec.source, JSON.stringify(rec.display), JSON.stringify(rec.validation),
         JSON.stringify(rec.permission), rec.enabled, rec.version, rec.created_by]
      );
    }
    // 身份兜底：所有定义 identity 的粒子注册主键属性（与 coreAttributes 去重，幂等）
    for (const slug of (def.identity || [])) {
      if (coreKeys.has(slug)) continue;
      const rec = identityRecordFor(ptype, slug);
      await query(
        `INSERT INTO crm.meta_attr
           (particle_type, attr_slug, title, attr_type, semantic_tag, required, "unique", description, options,
            source, display, validation, permission, enabled, version, created_by)
         SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16
         WHERE NOT EXISTS (SELECT 1 FROM crm.meta_attr WHERE particle_type=$1 AND attr_slug=$2)`,
        [rec.particle_type, rec.attr_slug, rec.title, rec.attr_type, rec.semantic_tag,
         rec.required, rec.unique, rec.description, rec.options,
         rec.source, JSON.stringify(rec.display), JSON.stringify(rec.validation),
         JSON.stringify(rec.permission), rec.enabled, rec.version, rec.created_by]
      );
    }
  }
  return true;
}
```

- [ ] **Step 4: 运行测试确认通过（需 PG@5433）**

Run: `node node_modules/vitest/vitest.mjs run test/meta-attr-repo.test.js`
Expected: PASS（含 Task 2 新增 4 例 + 既有用例；既有用例因 Task 1 的 `enabled` 基线变更已在 Task 1 Step5 翻转）。

- [ ] **Step 5: 提交**

```bash
git add src/metaAttr/metaAttrRepo.js test/meta-attr-repo.test.js
git commit -m "feat(meta-attr): seedMetaAttr 全粒子 identity 兜底（含 APPROVAL_*，去重幂等）"
```

---

## Task 3: renderer.js — attr-field 渲染层角色权限（V3）

**Files:**
- Modify: `src/page/renderer.js:93-97`（`attr-field` 分支消费 `hidden`/`readonly`）
- Test: `test/meta-attr-page.test.js`（新增「attr-field 渲染层角色权限」describe，纯逻辑）

- [ ] **Step 1: 写失败测试（纯逻辑，无 DB）**

在 `test/meta-attr-page.test.js` 末尾新增：

```js
describe('attr-field 渲染层角色权限（V3 渲染层隐藏）', () => {
  const base = { type: 'form', title: '权限表单', navigation: { to: '/workspace' }, layout: { columns: 1, theme: 'light' } };

  it('comp.hidden=true → 输出 data-perm="hidden" 且无 <input>', () => {
    const schema = { ...base, components: [{ kind: 'attr-field', attrSlug: 'name', attrType: 'text', label: '名称', hidden: true }] };
    const out = renderPage(schema, {});
    expect(out.html).toContain('data-perm="hidden"');
    expect(out.html).not.toContain('<input');
  });

  it('comp.readonly=true → 输出 <input disabled data-perm="readonly">', () => {
    const schema = { ...base, components: [{ kind: 'attr-field', attrSlug: 'name', attrType: 'text', label: '名称', readonly: true }] };
    const out = renderPage(schema, {});
    expect(out.html).toContain('data-perm="readonly"');
    expect(out.html).toContain('<input');
    expect(out.html).toContain('disabled');
  });

  it('默认（无 hidden/readonly）→ 正常 <input> 且无 data-perm', () => {
    const schema = { ...base, components: [{ kind: 'attr-field', attrSlug: 'name', attrType: 'text', label: '名称' }] };
    const out = renderPage(schema, {});
    expect(out.html).toContain('<input');
    expect(out.html).not.toContain('data-perm');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/meta-attr-page.test.js -t "渲染层角色权限"`
Expected: FAIL —— `hidden:true` 仍渲染出 `<input>`；`readonly:true` 输出无 `disabled`/`data-perm`。

- [ ] **Step 3: 最小实现**

`src/page/renderer.js` 把 `:93-97` 的 `case 'attr-field':` 分支整体替换为：

```js
    case 'attr-field': { // G1 T6 元模型抽屉：属性受控输入；消费角色权限 hidden/readonly（V3 渲染层隐藏）
      const slug = comp.attrSlug;
      const label = escapeHtml(comp.label || slug);
      if (comp.hidden === true) {
        return `<div class="pg-attr-field pg-perm" data-attr="${escapeHtml(slug)}" data-perm="hidden">
          <span class="pg-lock" aria-label="权限锁定">🔒</span> 字段对当前角色隐藏
        </div>`;
      }
      if (comp.readonly === true) {
        return `<div class="pg-attr-field pg-perm" data-attr="${escapeHtml(slug)}" data-attr-type="${escapeHtml(comp.attrType || 'text')}" data-perm="readonly">
          <span class="pg-lock" aria-label="权限锁定">🔒</span>
          <label>${label}</label>
          <input name="${escapeHtml(slug)}" type="text" placeholder="${escapeHtml(comp.placeholder || '')}" disabled />
        </div>`;
      }
      // 默认（向后兼容）：label + input，无权限标记
      return `<div class="pg-attr-field" data-attr="${escapeHtml(slug)}" data-attr-type="${escapeHtml(comp.attrType || 'text')}">
        <label>${label}</label>
        <input name="${escapeHtml(slug)}" type="text" placeholder="${escapeHtml(comp.placeholder || '')}" />
      </div>`;
    }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run test/meta-attr-page.test.js`
Expected: PASS（含新增 3 例 + 既有 5 例；既有「label+input 值转义」用例仍满足，默认分支结构不变）。

- [ ] **Step 5: 提交**

```bash
git add src/page/renderer.js test/meta-attr-page.test.js
git commit -m "feat(page): renderer attr-field 消费 hidden/readonly（V3 渲染层隐藏 + 权限标记）"
```

---

## Task 4: attrFormSchema.js — 组合层 buildAttrFormSchema（预解析权限，单一出口）

**Files:**
- Create: `src/page/attrFormSchema.js`
- Test: `test/attr-form-schema.test.js`（新建，DB 门控，端到端覆盖 V3）

- [ ] **Step 1: 写失败测试（DB 门控，端到端）**

新建 `test/attr-form-schema.test.js`：

```js
// test/attr-form-schema.test.js — 组合层 buildAttrFormSchema：角色权限预解析 + renderPage 端到端（V3）
import { describe, it, expect, beforeAll } from 'vitest';
import { query } from '../src/db.js';
import { seedMetaAttr, getMetaAttr, setMetaAttr } from '../src/metaAttr/metaAttrRepo.js';
import { buildAttrFormSchema } from '../src/page/attrFormSchema.js';
import { renderPage } from '../src/page/renderer.js';

beforeAll(async () => {
  await query(`TRUNCATE particles, edges, events, decision, decision_event, meta_attr CASCADE`).catch(() => {});
  await seedMetaAttr('system');
});

describe('buildAttrFormSchema 角色权限预解析', () => {
  it('mode=hidden → 组件 hidden=true 且 renderPage 无 <input>', async () => {
    await setMetaAttr('CRM_DEAL', 'name', { permission: { roles: { finance: 'hidden' } } });
    const schema = await buildAttrFormSchema('CRM_DEAL', 'finance');
    const comp = schema.components.find((c) => c.attrSlug === 'name');
    expect(comp.hidden).toBe(true);
    const out = renderPage(schema, {});
    expect(out.html).toContain('data-perm="hidden"');
    expect(out.html).not.toContain('<input');
  });

  it('mode=readonly → 组件 readonly=true 且 renderPage 含 disabled input', async () => {
    await setMetaAttr('CRM_DEAL', 'name', { permission: { roles: { finance: 'readonly' } } });
    const schema = await buildAttrFormSchema('CRM_DEAL', 'finance');
    const comp = schema.components.find((c) => c.attrSlug === 'name');
    expect(comp.readonly).toBe(true);
    const out = renderPage(schema, {});
    expect(out.html).toContain('data-perm="readonly"');
    expect(out.html).toContain('<input');
    expect(out.html).toContain('disabled');
  });

  it('默认 editable → 无权限标记、正常 input', async () => {
    await setMetaAttr('CRM_DEAL', 'name', { permission: {} });
    const schema = await buildAttrFormSchema('CRM_DEAL', 'finance');
    const comp = schema.components.find((c) => c.attrSlug === 'name');
    expect(comp.hidden).toBe(false);
    expect(comp.readonly).toBe(false);
    const out = renderPage(schema, {});
    expect(out.html).not.toContain('data-perm');
    expect(out.html).toContain('<input');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/attr-form-schema.test.js`
Expected: FAIL —— `../src/page/attrFormSchema.js` 模块不存在（`Cannot find module`）。

- [ ] **Step 3: 最小实现**

新建 `src/page/attrFormSchema.js`：

```js
// src/page/attrFormSchema.js — 组合层：粒子属性 → 受控表单 Schema（单一出口，角色权限预解析）
// 设计输入：docs/2026-08-26-particle-attr-ui-patch-design.md §3.2（缺口1 组合层预解析）
// 权限解析在组合层（可异步接触 DB）；渲染器保持纯函数/同步，仅消费 comp.hidden/comp.readonly
import { listMetaAttr } from '../metaAttr/metaAttrRepo.js';
import { modeFor } from '../metaAttr/fieldPermission.js';

// 产出受控表单 Schema：每个启用属性用既有 modeFor 解析角色权限（hidden/readonly），不新写权限逻辑
export async function buildAttrFormSchema(particleType, roleTag) {
  const rows = await listMetaAttr({ particleType, enabled: true });
  const components = rows.map((rec) => {
    const mode = modeFor(rec, roleTag);
    return {
      kind: 'attr-field',
      attrSlug: rec.attr_slug,
      attrType: rec.attr_type,
      label: rec.title,
      hidden: mode === 'hidden',
      readonly: mode === 'readonly',
    };
  });
  return {
    type: 'form',
    title: `${particleType} 属性表单`,
    navigation: { to: '/workspace' },
    layout: { columns: 1, theme: 'light' },
    components,
  };
}
```

- [ ] **Step 4: 运行测试确认通过（需 PG@5433）**

Run: `node node_modules/vitest/vitest.mjs run test/attr-form-schema.test.js`
Expected: PASS（3 例：hidden/readonly/editable 三条端到端路径）。

- [ ] **Step 5: 提交**

```bash
git add src/page/attrFormSchema.js test/attr-form-schema.test.js
git commit -m "feat(page): attrFormSchema 组合层预解析角色权限（V3 单一渲染出口）"
```

---

## 验收映射（对照设计 §5）

| 判据 | 覆盖 Task |
|---|---|
| V3 字段级权限生效（渲染层隐藏） | Task 3（渲染器 hidden 无 input）+ Task 4（组合层预解析 → 端到端） |
| 种子覆盖全粒子（含 APPROVAL_*） | Task 2（identity 兜底 + 计数断言） |
| 运行时不空（latent 修正） | Task 1（recordFor `enabled:true`） |

## 范围边界（不在本计划）

- 抽屉 UI 实装（归 G1/T7）—— Task 3/4 仅提供渲染能力与组合层 helper，抽屉在别处调用 `buildAttrFormSchema`。
- 运行态表单页路由接线、`crm-field-permission` Action 读侧矩阵接入——可后续 Task 复用本组合层。
- APPROVAL_* 粒子的业务语义字段——仅注册 identity 主键以满足「种子覆盖全粒子」。

## Self-Review（写毕后自查）

1. **Spec 覆盖**：§2 缺口2 → Task1(recordFor+identityRecordFor) + Task2(seed loop+测试)；§3 缺口1 → Task3(renderer) + Task4(compose)。三项验收判据均有 Task 对应。✅
2. **Placeholder 扫描**：无 TBD/TODO/"similar to"/"add validation"；每个 Step 含完整代码与命令。✅
3. **类型一致性**：`identityRecordFor(particleType, attrSlug)` 在 Task1 定义、Task2 引用，签名一致；`buildAttrFormSchema(particleType, roleTag)` 在 Task4 定义并被其测试消费；`modeFor(rec, roleTag)` 来自既有 `fieldPermission.js`，未改签名。✅
4. **不变量**：`recordFor` 仍抛 19 类型集外错误（未改校验）；`adaptiveRecordFor` 保持 `enabled:false`（未动）；`validator.js` attr-field 分支仅校验 attrSlug/attrType，新增 `hidden/readonly` 不影响校验。✅
5. **DB 列默认**：`meta-attr-schema.test.js:42` 断言列默认 `false`，本计划不改 schema.sql 列默认，故该断言保留不动（已显式说明）。✅
