# 按租户播种主数据（Plan B 落地）设计文档

> 整理时间：2026-09-03
> 状态：设计稿（待用户评审批准 → writing-plans → 实施）
> 关联决策：`docs/2026-09-03-attio-lightfield-study.md` §1「全部数据走方案 B（每租户自有）」已拍板
> 关联差距：`docs/2026-09-03-lightfield-attio-gap-study.md` §0「product-catalog 空目录根因」

---

## §0 背景与决策

- **决策**：全部数据（含产品目录等基础主数据）按 `tenant_id` 各自隔离，**不共享 `system` 模板**。租户用户只读本租户；admin（`scopeTenant='*'`）可见全部。
- **现状核查结论**（已闭合）：后端多租户隔离在架构层**已成立**——
  - 读：`routes.js:424` → `scopeTenant(me)` 按登录 token 收敛本租户；
  - 写：`routes.js:487` → `scopeOf(me)` 强制写自身租户（永不 `'*'`）；
  - SQL：`particleRepo.js:169` 查询带 `tenant_id` 条件；
  - 表：`crm.particles.tenant_id`（`db/schema.sql:13`，默认 `'system'`）。
- **唯一缺口**：**「按租户播种」未产品化**。新租户上线只播种 `tenant-profile`（配置画像）+ 初始销售员（`db/seed/seed-all-tenants.mjs`），**不复制主数据** → 租户用户登录后业务主数据视图为空（正是 `product-catalog.html` 空目录根因）。
- **本设计目标**：把「每租户一套自有主数据」脚本化、纳入行业上线 Runbook，使新租户开箱即得本租户主数据。

---

## §1 目标与范围

**目标**：新增幂等、可重跑、零代码的「按租户播种主数据」能力，从 `system` 模板库复制四类主数据到目标租户。

**范围（in scope）**：
1. 复制源：`system` 租户的四类主数据——`CRM_PRODUCT` / `CRM_PRICE_LIST` / `CRM_OFFER_POLICY` / `CRM_DICT_ENTRY`（来源 `db/seed-master-data.sql`，共 12+4+9+若干条）。
2. 复制引擎：`scripts/seed-tenant-master-data.mjs`，参数 `--tenant <id>`，可选 `--dry-run`。
3. 接入：纳入 `industry-onboarding` Runbook Step 4（建本租户主数据）。

**范围（out of scope）**：
- 业务数据（客户/商机/合同/报价）播种——业务数据天生由租户自身产生，不复制。
- 主数据的运行时编辑 UI——已有 `product-catalog.html` / `offer-policy` 等页面，租户复制后可独立增删改。
- 语义向量重建（复制后 `embedding=NULL`，由首次编辑触发写时索引，见 §5.5 风险）。

---

## §2 设计原则（铁律约束）

| 铁律 | 落实方式 |
|---|---|
| 绝对禁 DELETE | 脚本仅 `INSERT ... ON CONFLICT DO NOTHING`；无 TRUNCATE/DELETE/DROP（对齐 `seed-master-data.sql` 安全声明） |
| 行业差异化 100% 后台配置化 | 行业筛选（如启用）仅以 `tenant-profile.masterData` 配置声明，**零新增行业/粒子字面量、零代码** |
| 零信任 / 决策第 0 闸 | 本脚本为**运维种子工具**（系统写），`decision_id` 保持 `NULL`（与 `system` 历史行一致）；运行时业务写仍走 `actionExecutor` 五闸+HITL |
| 幂等可重跑 | 以 `stable_key = sha256(tenant|type|slug)` 唯一约束幂等定址（见 `db/schema.sql:21,29`） |
| 每 Task 一 commit | 实施拆 3 个 Task（见 §8），每 Task 独立 commit（AI 不提交，由用户本地提交） |

---

## §3 方案选型

**已确认的设计分歧（一次一问，均取推荐 A）**：

| # | 分歧 | 选择 | 含义 |
|---|---|---|---|
| 1 | 播种来源 | **A. 模板复制** | 以 `system` 现有主数据为模板，同结构复制改 `tenant_id`，复制后可独立增删改 |
| 2 | 复制范围 | **A. 四类全复制** | 产品/价格表/政策/字典全部按租户复制，开箱得完整主数据底 |
| 3 | 行业衔接 | **A. 复制后独立演进** | 复制 = 建租户自有副本；行业画像只定义元模型（对象/阶段/属性），**不裁剪主数据**；租户可软停用/删除不需要的产品 |

**实现方式选型（P3 呈现，取推荐「方案 1」）**：

- **方案 1：通用复制引擎 + 配置驱动筛选（采用）**
  - 新增 `scripts/seed-tenant-master-data.mjs`，参数 `--tenant <id>`；
  - 从 `system` 读四类主数据 → 按 `tenant-profile.masterData`（**可选**）筛选 → 复制到目标租户（幂等）；
  - 一个引擎服务所有租户，行业差异纯配置；无配置默认全复制（满足选型 A/A/A）。
  - ✅ 优点：零代码加行业、幂等可重跑、复用 `stable_key` 唯一约束、与现有 `seed-master-data.mjs` 范式一致。
  - ⚠️ 成本：需新增 `masterData` 配置语义（一次性设计，纯 config_store）。
- 方案 2：每租户一个专用脚本（`tenant-master-data-<industry>.js`）——❌ 每加行业写一脚本，违反行业差异化零代码铁律，否决。
- 方案 3：SQL 参数化模板（`:tenant` 占位符）——❌ 筛选逻辑硬编码进 SQL，无法复用 `tenant-profile` 配置，否决。

---

## §4 详细设计

### 4.1 复制引擎 `scripts/seed-tenant-master-data.mjs`

```
flow:
  argv --tenant <id> (必填), --dry-run (可选)
  ① 校验 tenantId 非空、非 'system'（禁止把模板复制回模板）
  ② 读 tenant-profile（config_store['tenant-profile'], {tenantId}）
     md = profile.masterData || {}
     typesToCopy = TYPES.filter(t => md.enabled !== false && (md.types ? md.types.includes(t) : true))
  ③ 遍历 type ∈ typesToCopy：
       SELECT id,type,slug,title,state,payload,created_at,updated_at
       FROM crm.particles WHERE tenant_id='system' AND type=$1
       对每行 r：
         if (!passFilter(type, r, md.filter)) continue   // 默认不过滤=全复制
         newId = crypto.randomUUID()
         INSERT INTO crm.particles
           (id, tenant_id, type, slug, title, state, payload, created_at, updated_at, stable_key)
         VALUES ($1..$10)
         ON CONFLICT (stable_key) DO NOTHING
  ④ 打印统计（每类型复制条数 / 跳过条数）
```

- **复用**：`readConfig` 来自 `src/config/configStore.js`（对齐 `tenant-profile-chemical.js:6`）；`stableKey` 来自 `src/particles/mintId.js`（对齐 `db/schema.sql:21`）；`pool` 来自 `src/db.js`（对齐 `scripts/seed-master-data.mjs:9`）。
- **用法**：
  - 生产：`node scripts/seed-tenant-master-data.mjs --tenant acme-chem`
  - 测试：`PGDATABASE=crm_native_test node scripts/seed-tenant-master-data.mjs --tenant acme-chem`
  - 演练：`node scripts/seed-tenant-master-data.mjs --tenant acme-chem --dry-run`

### 4.2 幂等策略（关键）

- **定址键**：`stable_key = sha256(tenant_id | type | slug)`（`db/schema.sql:21` + `uq_crm_particles_stable_key` 唯一索引 `:29`）。
- **租户副本**的 `stable_key` 与 `system` 模板不同（tenant 段不同）→ 不冲突；同租户重跑 → `ON CONFLICT (stable_key) DO NOTHING` 跳过。
- **slug 唯一**：`idx_crm_particles_slug (slug, tenant_id)`（`:28`）→ 租户内 slug 唯一，复制不改 slug（仅改 tenant）天然满足。
- **id**：每次复制生成新 UUID（`gen_random_uuid()` 同源），避免与 system 主键冲突。

### 4.3 字段映射（复制时逐列处理）

| 列 | 复制处理 | 理由 |
|---|---|---|
| `id` | 新生成 UUID | 主键不冲突 |
| `tenant_id` | → 目标租户 | Plan B 核心 |
| `type`/`slug`/`title`/`state` | 原样 | 结构不变 |
| `payload` (JSONB) | 原样 | 自由形态，零代码；行业差异由租户后续编辑体现 |
| `created_at`/`updated_at` | 原样（保留模板时间）或 `now()` | 建议保留模板时间，便于追溯来源 |
| `stable_key` | 重算（目标租户） | 幂等定址 |
| `embedding` | → NULL | 不复制向量；首次编辑触发写时索引（见 §5.5） |
| `content_hash` | → NULL | 运行时编辑时重算 |
| `decision_id` | → NULL | 系统运维写豁免第 0 闸（与 `system` 历史行一致） |
| `fts` | → NULL | 写时 `ensureTsVector` 双写重建（可选，MVP 可留 NULL 由编辑触发） |

### 4.4 行业筛选配置（可选，默认关闭）

`tenant-profile`（config_store）新增可选字段 `masterData`：

```js
// 例：化工租户只想要软件+印制服务类产品（纯配置，零代码）
writeConfig('tenant-profile', {
  tenantId: 'acme-chem',
  prototypes: { /* 现有不变 */ },
  masterData: {
    enabled: true,                 // false=不复制任何主数据（空目录，极端场景）
    types: ['CRM_PRODUCT','CRM_PRICE_LIST','CRM_OFFER_POLICY','CRM_DICT_ENTRY'], // 复制哪几类
    filter: {                      // 每类行级筛选（可选）；缺省=该类全复制
      CRM_PRODUCT: { category: ['软件','印制服务','服务'] }  // 仅匹配 payload.category ∈ 列表
    }
  }
}, { tenantId: 'acme-chem' });
```

- **默认语义**：`masterData` 缺失 → 四类全复制、行级不过滤（满足选型 A/A/A「开箱全量」）。
- **筛选仅作用于 `CRM_PRODUCT` 的 `payload.category`**（字典/价格表/政策默认全复制）；其他类型 `filter` 忽略。
- **零代码加行业**：新增行业只改 `tenant-profile` 配置，不新增脚本/字面量。

### 4.5 接入行业上线 Runbook（industry-onboarding）

- `plugin-platform-admin/skills/industry-onboarding/SKILL.md` 新增 **Step 4：建本租户主数据**。
- 执行序：Step 2 写 `tenant-profile` → Step 4 调 `seed-tenant-master-data.mjs --tenant <id>` → Step 5 建初始销售员。
- `db/seed/seed-all-tenants.mjs` 现有 chem/insmedi 流程追加主数据播种调用（保持幂等可重跑）。

### 4.6 安全闸

- 脚本仅接受非 `system` 的合法 `tenantId`（拒绝 `system`/空/未配置租户）。
- 属运维工具，须经 `industry-onboarding`（sysadmin 角色，双闸：登录 + `sysadmin` 角色）触发；不暴露于运行时 API。
- 运行时业务写（租户编辑主数据）仍走 `actionExecutor` 五闸 + HITL + 决策第 0 闸，与本种子脚本互不干扰。

---

## §5 验收标准

1. **开箱可得**：新租户 X 上线后，带 X token 访问 `/api/particles?type=CRM_PRODUCT` 返回 X 自有产品（默认 12 条，或筛选后数量）；`product-catalog.html` 不再空目录。
2. **隔离生效**：X 编辑/停用/删除自身产品，**不影响 `system` 模板**（`tenant_id` 隔离，SQL 条件验证）。
3. **幂等**：连跑两次 `seed-tenant-master-data.mjs --tenant X`，第二次 0 插入（`stable_key` 冲突跳过），统计打印「跳过 N 条」。
4. **禁 DELETE 自检**：脚本全文 grep 无 `DELETE`/`TRUNCATE`/`DROP`。
5. **配置零代码**：新增一个行业租户（如 acme-edu）仅改 `tenant-profile` 配置 + 调脚本，无新脚本/字面量。
6. **回归无碍**：`system` 模板库仍可被 admin 可见（运维参考），普通租户不可见；既有 `seed-master-data.mjs`（灌 system）与 `seed-all-tenants.mjs` 行为不变。

---

## §6 风险与回滚

| 风险 | 缓解 |
|---|---|
| `system` 模板与租户副本漂移 | Plan B 本就独立演进；模板更新不自动下发租户（如需同步，另设计增量同步，不在本方案） |
| 复制后 `embedding=NULL` → 租户内该产品语义检索首跑缺失 | 由首次编辑触发写时索引；或 MVP 后追加「复制后批量重建 embedding」开关（优化项，非阻塞） |
| `system` 模板本身为空/未灌 | 先确保 `scripts/seed-master-data.mjs` 已跑（Runbook 前置）；脚本报错退出非 0 |
| 误把主数据复制到 `system` | `:4.6` 拒绝 `tenantId='system'` |
| 配置 `masterData.filter` 写错导致漏复制 | `--dry-run` 预演；统计打印每类型复制/跳过数，便于核对 |

**回滚**：纯 INSERT 幂等，无破坏性操作；如需撤销某租户主数据，走现有软停用/软合并（`meta.merged_into`，绝对禁 DELETE），不提供脚本级 DELETE。

---

## §7 自我审查（design self-check）

- 占位符：无 `{TODO}`/`<待填>`。
- 矛盾：前文摘要「B. 复制时按行业筛选」已在本文档 §1/§3 修正为 A（复制后独立演进）；引擎仅可选支持筛选，默认不过滤，与选型一致。
- 歧义：`masterData` 为可选字段，缺失即全复制，语义明确；筛选仅作用于 `CRM_PRODUCT.category`，已声明。
- 范围：仅主数据播种，不含业务数据/编辑 UI/向量重建，边界清晰。

---

## §8 实施计划拆分（每 Task 一 commit，AI 不提交，用户本地提交）

- **Task 1**：新增 `scripts/seed-tenant-master-data.mjs`（核心复制引擎 + 幂等 + `--dry-run` + 安全闸）。
- **Task 2**：`industry-onboarding` SKILL 新增 Step 4 + `db/seed/seed-all-tenants.mjs` 追加主数据播种调用；补充 `masterData` 配置说明（纯 config_store）。
- **Task 3**：对现有租户（acme-chem / acme-insmedi）执行播种验证 + 幂等验证 + 验收标准 1–6 核对；补 `docs/` 实施记录。

---

## §9 待决 / 备注

- `system` 模板库定位：保留为「种子源 + admin 运维参考」，不作为任何租户业务视图（普通租户按 `tenant_id` 不可见）。是否需要在 UI 明确标注 `system` 行的「模板」属性（防误改），留作后续 UX 增强。
- 向量重建：复制后 `embedding=NULL`，建议 MVP 后评估「复制即触发写时索引」是否必要（依赖 embedding provider 成本）。
