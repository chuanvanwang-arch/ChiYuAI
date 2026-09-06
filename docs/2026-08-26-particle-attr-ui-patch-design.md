# 粒子属性元模型 UI 补丁设计（缺口 1、2）

> 上游基线：`docs/2026-08-26-particle-attribute-model-ui-design.md`（08-26 设计稿，V1–V6 判据）
> 关联计划：`docs/superpowers/plans/2026-08-26-particle-attribute-model.md`（T1–T7，T7 收尾）
> 性质：**设计补丁（针对已实现 6 Task 的两处实质缺口）**。按铁律，未经批准不写实现代码；本文件已获用户批准（2026-08-26 10:56）。
> 范围边界：仅补「①渲染层角色权限（V3）」「②种子完整性（全粒子 identity 兜底）」两项，不触碰抽屉 UI 实装（归 G1/T7）与运行态路由接线。

---

## §0 结论（三句话）

1. **缺口 1（V3 渲染层隐藏）**：`renderer.js:93-97` 的 `attr-field` 分支当前无条件渲染 label+input，未消费角色权限。补丁在**组合层预解析**角色权限（`buildAttrFormSchema` 复用 `modeFor`），把 `hidden/readonly` 注入 Schema 组件，渲染器保持纯函数/同步，仅消费 `comp.hidden/comp.readonly`。
2. **缺口 2（种子完整性）**：`seedMetaAttr`（`metaAttrRepo.js:9-27`）只物化有 `coreAttributes` 的粒子，导致 CRM_DEAL/PRODUCT/PERSON/ORGANIZATION/KNOWLEDGE/ASSET 及全部 CRM_APPROVAL_* 播种 0 行。补丁对所有定义了 `identity` 的粒子（含 APPROVAL_*）注册 identity 字段为 baseline（`enabled:true, required:true`），并与 `coreAttributes` 去重。
3. **顺带修正同源 latent bug**：`recordFor`（`metaAttrModel.js:43`）当前把种子属性写成 `enabled:false`，导致即使 coreAttributes 已播种，运行时 `modelFor` 过滤后**全部不可见**；补丁将 baseline 设为 `enabled:true`（identity 额外 `required:true`），否则种子无业务意义。

---

## §1 现状取证（file:line 证据）

| 证据 | 位置 | 内容 |
|---|---|---|
| 渲染器 attr-field 分支 | `src/page/renderer.js:93-97` | 仅渲染 `<label>+<input>`，无 `comp.hidden/comp.readonly` 处理 |
| 渲染器入口 | `src/page/renderer.js:103` | `renderPage(schema, data={})` 纯函数/同步；`pageStore.js:27,76` 均 `renderPage(schema, {})` 同步调用 |
| 字段级 RBAC 判定 | `src/metaAttr/fieldPermission.js:6-8` | `modeFor(rec, roleTag)` → `rec.permission.roles[roleTag] || 'editable'`（已存在，写闸消费） |
| 种子物化 | `src/metaAttr/metaAttrRepo.js:9-27` | `seedMetaAttr` 仅遍历 `def.coreAttributes || {}` |
| 种子记录工厂 | `src/metaAttr/metaAttrModel.js:35-46` | `recordFor` 写死 `enabled:false, required:false, source:'manual'` |
| 粒子定义 | `src/particles/particleModel.js:5-188` | 各粒子 `identity:[...]` 与 `coreAttributes`；DEAL/PRODUCT/PERSON/ORGANIZATION/KNOWLEDGE/ASSET/APPROVAL_* 无 coreAttributes |
| 运行时视图 | `src/metaAttr/metaAttrModel.js:61-64` | `modelFor` 过滤 `r.enabled` —— 种子 `enabled:false` 则全不可见 |
| V3 判据 | `docs/2026-08-26-particle-attribute-model-ui-design.md:262` | 「字段级权限生效 … 渲染层隐藏」 |

---

## §2 缺口 2 设计：全粒子 identity 兜底播种

### 2.1 改动 A — `src/metaAttr/metaAttrModel.js`

- 改 `recordFor`（:35-46）：baseline `enabled` 由 `false` → **`true`**（coreAttributes 种子即生效）。`adaptiveRecordFor`（:49-58）不变（`enabled:false, source:'ai'`）。
- 新增 `identityRecordFor(particleType, attrSlug)`：
  - 返回 rec：`{ particle_type, attr_slug, title:attrSlug, attr_type: <slug 在 coreAttributes 中的类型，否则 'text'>, semantic_tag: semanticTagOf(attrSlug), required:true, unique:false, source:'manual', enabled:true, version:1, created_by:'seed' }`。
  - 类型兜底 `text`：`identity` 数组仅含 slug 无类型声明（如 `deal` 的 `name`、审批粒子的 `flow_id`/`business_type`），其本质均为文本主键；若 slug 同时出现在 `coreAttributes` 中，取其真实类型（去重时由 2.2 跳过，不会重复）。
  - 类型闸复用 `ATTRIBUTE_TYPE_SET`（`'text'` ∈ 19 集，恒通过）。

### 2.2 改动 B — `src/metaAttr/metaAttrRepo.js` `seedMetaAttr`（:9-27）

- 在既有 coreAttributes 循环后，新增 identity 循环：
  ```js
  const coreKeys = new Set(Object.keys(def.coreAttributes || {}));
  for (const slug of (def.identity || [])) {
    if (coreKeys.has(slug)) continue;            // 与 coreAttributes 去重
    const rec = identityRecordFor(ptype, slug);
    await query(/* 同 INSERT ... WHERE NOT EXISTS */, [...]);
  }
  ```
- 幂等：沿用 `WHERE NOT EXISTS (particle_type=$1 AND attr_slug=$2)` 守卫。
- 覆盖：CRM_DEAL(`name`)、CRM_PRODUCT/PERSON/ORGANIZATION/KNOWLEDGE/UNSTRUCTURED_ASSET（各自 identity）、全部 11 个 CRM_APPROVAL_*（均定义 identity）。

### 2.3 测试（meta-attr-repo.test.js 追加）

- seed 后 `getMetaAttr('CRM_DEAL','name')` 存在且 `{enabled:true, required:true, source:'manual'}`。
- `getMetaAttr('CRM_APPROVAL_FLOW','name')` 存在（含 APPROVAL 兜底生效）。
- `CRM_ACCOUNT`（name 同现于 coreAttributes 与 identity）仅 1 行（去重验证）。
- `listMetaAttr({enabled:true})` 全量行数 = Σ(各粒子 coreAttributes∪identity 去重)。

---

## §3 缺口 1 设计：渲染层角色权限（隐藏/只读 + 权限标记）

### 3.1 改动 C — `src/page/renderer.js` attr-field 分支（:93-97）

消费 `comp.hidden` / `comp.readonly`（向后兼容：未定义则维持现状 label+input）：

- `comp.hidden === true` → 锁定占位（不可编辑、不进表单提交，但保留可见标记便于调试/权限可视化）：
  ```html
  <div class="pg-attr-field pg-perm" data-attr=".." data-perm="hidden">
    <span class="pg-lock" aria-label="权限锁定">🔒</span> 字段对当前角色隐藏
  </div>
  ```
- `comp.readonly === true` → 渲染 disabled 输入 + 标记：
  ```html
  <div class="pg-attr-field pg-perm" data-perm="readonly">
    <span class="pg-lock" aria-label="权限锁定">🔒</span>
    <label>..</label><input name=".." type=".." disabled>
  </div>
  ```
- 否则维持现状（label+input）。所有动态值仍过 `escapeHtml`（安全契约不变）。
- 锁形徽标按用户确认项：hidden/readonly 均加 `data-perm` 属性 + 锁标记，便于权限可视化与调试。

### 3.2 改动 D — 新增 `src/page/attrFormSchema.js`（组合层，单一出口）

- `buildAttrFormSchema(particleType, roleTag)`：
  - `listMetaAttr({ particleType, enabled:true })` 取启用属性；
  - 逐行 `modeFor(rec, roleTag)`（复用 `fieldPermission.js:6`，**不新写权限逻辑**）；
  - 产出组件 `{ kind:'attr-field', attrSlug, attrType, label, hidden: mode==='hidden', readonly: mode==='readonly' }`；
  - 封装为 `{ type:'form', title, layout:{columns:1}, components:[...] }` 返回。
- 抽屉（G1/T7）与未来运行态表单页统一调用此函数；`crm-field-permission` Action 的读侧矩阵与此同源。

### 3.3 测试（meta-attr-page.test.js / 新增）

- `permission={finance:'hidden'}` + `roleTag='finance'` → `buildAttrFormSchema` 该组件 `hidden:true` → `renderPage` 输出含 `data-perm="hidden"` 且**不含 `<input>`**（V3「渲染层隐藏」端到端）。
- `permission={finance:'readonly'}` → 输出含 `<input .. disabled data-perm="readonly">`。
- 未配置（默认 editable）→ 正常 `<input>`、无 `data-perm`。

---

## §4 错误处理与范围

- 渲染器纯函数契约不变（无异步、无 DB 接触）；权限解析在组合层（DB 在组合层，不在渲染器）。
- `buildAttrFormSchema` 异步（组合层允许），渲染器保持同步——符合 `renderer.js:103` 契约。
- 本补丁**只做**：①`renderer.js` attr-field 消费权限标记；②`attrFormSchema.js` 组合层 helper；③`metaAttrModel.js`/ `metaAttrRepo.js` identity 兜底播种 + baseline `enabled` 修正。
- **不在范围**：抽屉 UI 实装（G1/T7）、运行态表单页路由接线、APPROVAL 粒子的业务语义字段——仅注册 identity 主键以满足「种子覆盖全粒子」。

---

## §5 验收判据映射

| 判据 | 来源 | 本补丁覆盖 |
|---|---|---|
| V3 字段级权限生效（渲染层隐藏） | 设计稿 §8 | §3：hidden 无 input、readonly disabled + data-perm 标记 |
| 种子覆盖全粒子 | 审计缺口 2 | §2：全粒子 identity 兜底（含 APPROVAL_*） |
| 运行时不空（latent 修正） | 同源 bug | §2.1：`enabled:true` baseline 使 modelFor 可见 |

---

## §6 决策点（2026-08-26 用户批准）

> ✅ **已批准（2026-08-26 10:56）**：§A（缺口2 全粒子 identity 兜底，含 APPROVAL，顺带修正 baseline enabled）、§B（缺口1 组合层预解析 + 渲染器消费 hidden/readonly + data-perm 锁标记）均符合预期，进入 writing-plans。

1. 缺口 2 范围 = **全粒子身份兜底（含 APPROVAL）**：所有定义 identity 的粒子（含 11 个 CRM_APPROVAL_*）全部注册入表。
2. 缺口 1 行为 = **隐藏/只读均加权限标记徽标**：hidden 渲染锁定占位（非 input）、readonly 渲染 disabled input，二者均带 `data-perm` 与锁形徽标。
3. 解析位置 = **组合层预解析**（纯函数渲染器不变）：角色权限在 `buildAttrFormSchema` 用既有 `modeFor` 解析后注入 Schema 组件。
