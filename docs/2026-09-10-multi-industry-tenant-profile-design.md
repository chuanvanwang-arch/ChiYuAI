# 一租户多行业画像：设计（方案 Y 嵌套 / 合并 C 静默覆盖 / 一次大修）

- 日期：2026-09-10
- 状态：待批准（brainstorming 产出，未批准不写实现）
- 关联：`docs/2026-09-09-tenant-admin-design.md`（前序单行业版，已被本设计替代 §4 之后的章节）、`docs/2026-09-04-tenant-billing-page-design.md`

## §0 决策记录

| 决策项 | 选项 | 选择 | 时间 |
|---|---|---|---|
| 多行业存储模型 | Y 嵌套 / X 拆 key / Z 命名空间 | **Y 嵌套 value** | 2026-09-10 用户批准 |
| 同 industry 同名类型合并 | A 后分配者优先+告警 / B 拒绝 / C 静默覆盖 | **C 静默覆盖** | 2026-09-10 用户批准 |
| 本次提交节奏 | 一次大修 / 分两步 | **一次大修** | 2026-09-10 用户批准 |

**C 选项的风险登记**（向诚实直陈疏漏）：当某租户同名字段在多个 industry 间被静默覆盖时，**config_store 原始 JSON 无任何标记**，仅靠 `decision` 表可查。**登记**：
- 失败模式示例：acme-chem 先分配「化工」再分配「培训」；两个 industry 都定义了 `product.price` 公式 → 培训版静默覆盖化工版 → acme-chem 的报价策略表现为培训版，**审计不可定位**。
- 本设计不附 `industry-overlap-alert` 自动告警（呼应用户「一次大修，不增项」）。
- 后续补救路径：未来若提出告警需求，新增 `gateDecision({scenario_id:'industry-overlap-alert', ...})` 即可，本设计的 `assign-profile` 实现里预留 `merge_meta` 字段返回值让 caller 自检。

## §1 范围与红线

**做**：
1. 改造 `tenant-profile` value 结构为 `{ version:2, industries: [{ id, label, prototypes, edge_types, formulas }] }`，保留 `legacy_v1` 平滑过渡字段。
2. `assign-profile` 改语义为「追加 industry」（多行）；新增 `remove-profile` 移除某一 industry。
3. `tenant-subscriptions` 行业列改为多 chip（多行业同时展示）。
4. 5 业务租户存量数据**一次性**迁移（脚本 + 备份可回滚）。
5. 三个消费点**接口零变动**：`resolvePrototype`、`isControlledPredicateConfig`、公式引擎——它们都假设「单值对象」改为「合并后的扁平对象」，隐藏复杂度集中在新模块 `profileMerger.js` 内。

**红线（不可违背）**：
1. **禁物理 DELETE**：所有写操作为 UPDATE/INSERT；移除 industry = UPDATE `industries` 数组中 drop 元素并整体写回，**绝不只删 config_store 行**。
2. **写操作过决策第 0 闸**：assign/remove 落 `produceDecision({scenario_id:'config_change', ...})`，与前序设计中「冻结/解冻等」端点一致。
3. **system 租户保护**：对 `tenant_id='system'` 的 assign/remove 一律 400 硬拒（system 只作模板源）。
4. **权限双保险**：admin/sysadmin 双重校验。
5. **零行业专属代码**：industry 是数据，不是代码（沿用前序铁律）。
6. **同名合并 = C 静默覆盖，不告警**（用户决策）；但 `assign-profile` 返回 `merge_meta.warnings[]` 数组供 caller 知晓发生过合并，便于审计时人工对照。
7. **不动 resolveMe / auth 热路径**（沿用前序 §0 红线 6）。
8. **不破坏既有粒子类型代码基线 `PARTICLE_TYPES`**（`particles/seed.js` 内的 `registerParticleType` 永不动）。

## §2 现状事实（代码级锚点）

| 事实 | 位置 | 影响 |
|---|---|---|
| `readConfig('tenant-profile', { tenantId })` 返回 `{ value, decision_id }`，三处消费都从 `value.prototypes[<type>]` 读 | `formulaEngine.js:34`、`particleModel.js:343/365` | 接口不变、新增「合并 N industries」中间层 |
| `config_store` PK = `(tenant_id, key)`，当前单行 `key='tenant-profile'` | `db/schema.sql` | 不改表，**只改 value 内容** |
| 5 业务租户现存 profile 都是单行业旧格式 | `crm_native` 库 `config_store` 查询 | 迁移脚本一次性嵌套化 |
| system 行 `tenant-profile` 当前是「system 行业代码基线」单行 | `db/seed/autoSeed.js` 调用方 | 迁移后 system 行变 `industries:[{id:'__baseline', label:'代码基线', ...}]`（空壳，**实际值仍由 `PARTICLE_TYPES` 提供**），避免与业务租户「system 是模板源」语义混淆 |
| 前序设计 `assign-profile` 是「覆盖式单行业」 | `billingRoutes.js:387-410` | 本设计替换为「追加式多行业」 |
| 现有 7 个行业 seed 文件 `tenant-profile-{chem|training|medical|insmedi|consult|auto|consult2}.js` | `db/seed/` | 拆 key 模板沉淀（`tenant-profile-templates` 已落）本设计复用作 templates 清单，assign-profile 直接克隆模板覆盖入 `industries[]` |

## §3 数据模型设计

### §3.1 新 value 结构（version=2）

```json
{
  "version": 2,
  "industries": [
    {
      "id": "chem",
      "label": "化工",
      "assigned_at": "2026-09-10T12:34:56Z",
      "assigned_from_template_id": "chem",
      "assigned_decision_id": "dec_xxx",
      "prototypes": { "<type>": { ...def } },
      "edge_types": ["<edgeType>", ...],
      "formulas": { ... }   // 预留，本设计不消费
    },
    {
      "id": "training",
      "label": "培训",
      ...
    }
  ],
  "merge_meta": {           // 最近一次 assign 留下的提示，供 caller 自检
    "last_merge_at": "...",
    "conflict_keys": ["product", "order"]   // 被静默覆盖的 type 名
  }
}
```

兼容旧值：当 `value.version !== 2` 时，`readConfig` 客户端 `(tenant-profile)` 经由新合并层把旧 `value.prototypes` 提升为 `{ industries:[{id:'__legacy', label:旧meta.industry_label, prototypes:旧, ...}] }`，**但** 此层只读不写——后续任何写都会落到 `version=2`。**这意味着旧值租户第一次写时会被自动迁移**。**真正的存量迁移**由独立脚本预跑（§3.3）。

### §3.2 合并语义（C 静默覆盖）

对 `resolvePrototype(type, tenantId)`：

```
合并步骤（按 industries 数组顺序，后者覆盖前者）：
1. baseline = code PARTICLE_TYPES[type]   （持久代码基线）
2. for ind of industries:
     if ind.prototypes[type]:
       merged = deep-merge(baseline, ind.prototypes[type])   // ind 的字段静默覆盖 baseline
       baseline = merged
3. return baseline ?? null
```

`deep-merge` 行为：
- 对象：并集，后者键覆盖前者键
- 数组：后者**完全替换**前者（不是 concat）
- 标量：后者覆盖前者

对 `isControlledPredicateConfig(edgeType, tenantId)`：

```
1. baseline = CONTROLLED_PREDICATES  （持久代码基线数组）
2. for ind of industries:
     baseline = baseline ∪ ind.edge_types   // 后分配者追加 edge_type
3. return baseline.includes(edgeType)
```

对公式引擎（`formulaEngine.js`）：本设计**不消费** industry 的 formulas 字段——保留以备后续，是前向兼容占位，不破坏既有公式查找路径。

### §3.3 存量迁移脚本（`db/seed/migrate-tenant-profile-to-v2.mjs`）

幂等迁移：每行检测 `value.version`，不等于 2 则升级；等于 2 则跳过。

逻辑：
1. 备份 `config_store WHERE key='tenant-profile'` 到 `config_store_profile_legacy_snapshot` 表（一次性，迁移成功后人工 `DELETE`？——不，**保留不删**，遵守红线 1；脚本末尾提示「备份表保留供参考，清理需管理员人工 `UPDATE status='archived'` 软标记」——**本期不动它**）。
2. 对每行：
   - `value.version = 2`
   - `value.industries = [{ id: '<从旧 meta.label 推导>', label: 旧 meta.industry_label, prototypes: 旧 prototypes, edge_types: 旧 edge_types ?? [], assigned_at: 行创建时间, assigned_from_template_id: null, assigned_decision_id: null }]`
   - `value.merge_meta = { last_merge_at: now(), conflict_keys: [] }`
3. 系统行特殊处理：system 行原本是「代码基线占位」（空 prototypes），升级后 `industries=[{id:'__baseline', label:'代码基线', prototypes:{}, edge_types:CONTROLLED_PREDICATES ?? [], formulas:{}}]`——**明确 system 不承载业务行业**。业务行业模板留在 `tenant-profile-templates:<id>` 行，与前序设计一致。
4. 写回 `config_store`，走 `UPSERT` 风格以保留 `decision_id`。

### §3.4 关键不变量（待 Task 测试断言）

1. `industries` 数组内 `id` 唯一——assign-profile 检测重名则幂等跳过，不报错（与前序 idempotent 规则一致）。
2. `industries` 数组长度单调递增——assign 追加、remove 删除，长度不变只允许 remove（不允许 assign 时减少）。
3. 后端读路径 `resolvePrototype(type)` 返回值**必须等于**合并后内存对象——即旧值升级后调用结果应**字节级一致**（核心兼容性断言）。

## §4 后端变更

### §4.1 端点表

| 端点 | 方法 | 权限 | 行为 |
|---|---|---|---|
| `/api/billing/tenant-admin/profile-templates` | GET | admin/sysadmin | 列 `config_store WHERE key LIKE 'tenant-profile-template-%' AND tenant_id='system'`（前序已落） |
| `/api/billing/tenant-admin/assign-profile` | POST | admin/sysadmin | 改为**追加**：body=`{tenantId, templateIds:string[]}`；克隆每个模板到 `industries[]` 末尾；落决策行；返回 `{ ok, industries:[{id,label}], merge_meta }` |
| `/api/billing/tenant-admin/remove-profile` | POST（新增） | admin/sysadmin | body=`{tenantId, industryId}`；从 `industries[]` 中 drop；落决策行 |
| `/api/billing/tenant-subscriptions` | GET | admin/sysadmin | `profile_summary` 从「单值」改「数组 chip」：`{ industries:[{id,label}] }` |
| `/api/billing/tenant-admin/freeze\|unfreeze\|extend\|cancel\|change-plan` | POST | admin/sysadmin | **不动**（沿用前序已落地 6.1–6.5） |
| `readConfig('tenant-profile', { tenantId })` | 函数 | n/a | **接口不变**，内部委托新模块 `profileMerger.js` 返回合并后扁平对象 `{ prototypes, edge_types, version, industries }`——下游三消费点**零改动** |

### §4.2 新模块 `src/config/profileMerger.js`

导出：
- `mergeProfile(rawValue): { prototypes, edge_types, version, industries, merge_meta }`
- `resolvePrototypeInMerged(merged, type): { source, ...def, type }`（与现有 `resolvePrototype` 行为镜像）
- `isControlledPredicateInMerged(merged, edgeType): boolean`
- `assignIndustry(rawValue, { template, templateId, decisionId }): { next, merge_meta, warnings }`
- `removeIndustry(rawValue, industryId): { next, removed }`
- `migrateFromV1(rawValue, metaFallback): { value, upgraded }`

约束：纯函数，不写数据库；仅依赖 `deepMerge` 工具（自实现 ~20 行，**不引入 lodash**——本沙箱无 lodash 依赖）。

### §4.3 改造 `billingRoutes.js` 中现有读路径

`tenant-subscriptions`（§4.1 第 4 行）查询改为：

```sql
SELECT tenant_id, value->'industries' AS industries,
       (SELECT count(*)::int FROM jsonb_object_keys(value->'industries')) AS ind_count,
       jsonb_array_length(coalesce(value->'industries', '[]'::jsonb)) AS total_prototypes
FROM crm.config_store
WHERE key='tenant-profile' AND tenant_id = ANY($1)
```

`merge_meta.conflict_keys` 不入库 SQL——由前端对返回的 `industries` 数组按顺序合并并探测（详见 §5.3）。

> **重要简化**：`isControlledPredicateConfig` / `resolvePrototype` 的修改从「数据库读」改成「从数据库读后客户端合并」，是因为：
> ① 三处调用点全在 Node 进程内，不在 SQL；
> ② 把合并语义聚拢到 `profileMerger.js` 一个文件，更好维护；
> ③ 性能：N industries 合并是 O(N×prototypes) ≈ 数十次对象浅合并——可接受。

## §5 前端变更

### §5.1 `admin-billing-console.html` 行业列改造

| 元素 | 旧 | 新 |
|---|---|---|
| 表格列 `<th>` | 行业（单值） | 行业（多 chip + 操作） |
| 单元格内容 | 单 label | 多 `.chip`：`<span class="chip">化工</span> <span class="chip">培训</span>`（超过 3 显示 `+N`） |
| 行展开 | 仅 sub-detail | 同前 |
| 「操作」列按钮 | 5 按钮 +「分配画像」 | 5 按钮 +「分配画像」+ 新增「移除画像」 |

### §5.2 分配画像弹窗（弹窗复用现有 `.modal`）

弹窗表头「分配行业画像：<tenant-name>」。

正文：
- 顶部列表「当前已分配（点击 ✕ 移除）」—— 每个 chip 旁一个 ✕ 按钮（点击直接调 remove-profile 二段确认）。
- 列表下方「待分配模板」（来自 `/profile-templates`），**多选 checkbox**。
- 底部「确认」按钮：把待分配 templateIds 一次性 POST；冲突字段在成功 toast 提示「已合并 N 处重叠，详见合并报告」（合并报告 = 返回 `merge_meta.conflict_keys`，前端**展示而不告警拦截**——用户选 C）。

### §5.3 合并报告 hook

assign-profile 成功响应若有 `merge_meta.conflict_keys.length > 0`，前端在订阅 tab 上方红条提示「租户 X 分配 Y 时合并冲突：product, order（共 N 处）——**静默覆盖**（无自动告警）」。这是用户决策 C 的**可观察化**，让管理员看到发生过覆盖事实，但不阻止覆盖发生。

### §5.4 api 调用统一

POST `/assign-profile` 携带 `body = { tenantId, templateIds: string[] }`；POST `/remove-profile` 携带 `body = { tenantId, industryId: string }`。
沿用 2026-09-09 已修复的 `api(..., { method, body })` 调用形式。

## §6 合并报告（caller-side conflict visibility）

**为什么改 C 后还要给前端冲突提示**：决策 C 接受「静默覆盖」，但「**用户不知情**」与「**用户知情但接受**」是两回事。本设计让合并事实**用户可见**——红条永久显示直到下次 assign 清空冲突字段。这样用户在 admin 操作台能立刻看到「我刚把培训叠到化工上、product 字段被覆盖」，追溯靠浏览器历史即可。

## §7 测试计划

### §7.1 单元（profileMerger 纯函数）

| ID | 用例 | 断言 |
|---|---|---|
| T1 | mergeProfile(v1) | 自动迁移 v1→v2，industries 长度=1，prototypes 内容字节级一致 |
| T2 | mergeProfile(v2) | 原样返回 |
| T3 | resolvePrototypeInMerged 同名合并 | 第二个 industry 的 `product` 覆盖第一个 industry 的 `product` |
| T4 | isControlledPredicateInMerged 多 edge_types 并集 | 返回 true |
| T5 | assignIndustry 幂等 | 同 templateId 重复 assign，industries 长度不变 |
| T6 | removeIndustry | 指定 industryId 移除，长度 -1；不存在的 id 抛错 |

### §7.2 端到端（HTTP）

| ID | 用例 | 断言 |
|---|---|---|
| T7 | `assign-profile` 单 industry | industries 长度 +1，response 含 merge_meta |
| T8 | `assign-profile` 多 industry 一次性 | industries 长度 +N |
| T9 | `assign-profile` 冲突覆盖 | 返回 `merge_meta.conflict_keys=['product']`，DB 中 industries[1].prototypes.product 字节级 == 模板 |
| T10 | `remove-profile` | industries 长度 -1，config_store 仍存在（不删行） |
| T11 | `/tenant-subscriptions` 行业 chip | 返回 industries 数组，UI 渲染多 chip |
| T12 | 幂等：assign-profile 同 templateIds | noop，返回 ok=true，industries 长度不变 |
| T13 | 系统租户 assign-profile | 400「system tenant protected」 |
| T14 | 权限：非 admin/sales 调 | 403 |
| T15 | 决策行：assign/remove 各自落 `decision` 表 | 至少有 1 行 `scenario_id='config_change'` + `fields` 含 industry id |
| T16 | 迁移脚本幂等性：重复跑 | 第二次跳过（version 已为 2） |

### §7.3 兼容性（关键回归）

| ID | 用例 | 断言 |
|---|---|---|
| T17 | 旧 v1 profile 调 resolvePrototype | 返回与迁移前 byte-equal（prototypes 内容） |
| T18 | 旧 v1 profile 调 isControlledPredicateConfig | 返回与迁移前 byte-equal 布尔值 |

### §7.4 性能冒烟

- 一次性分配 5 行业（acme-chem 模拟培训 + 化工 + 三个 demo 行业）：合并耗时 < 10ms（顶层基准，详测见 Task 6）。

## §8 Task 切分

| Task | 内容 | 落点 |
|---|---|---|
| T1 | 写 `src/config/profileMerger.js`（6 个导出纯函数） | 新增模块 |
| T2 | 写迁移脚本 `db/seed/migrate-tenant-profile-to-v2.mjs` | 一次性幂等 |
| T3 | `readConfig` 桥接：保持接口，`value` 字段经过 `mergeProfile` 后返回 | `src/config/configStore.js` 改造（接口不变，下游无感） |
| T4 | `billingRoutes.js`：`assign-profile` 改追加语义、新增 `remove-profile`、`tenant-subscriptions` 改 industries 数组 | 后端三端点改造 |
| T5 | 前端弹窗改多 chip + 多选 + 移除 | `admin-billing-console.html` |
| T6 | `test/config/profileMerger.test.js` 纯函数 + `test/billing/tenantAdminMultiProfile.test.js` 端到端 T7–T18 | 测试 |
| T7 | 全量回归（billing + config + ui-lint）+ 三个消费点 byte-equal 兼容性回归 | 回归收口 |

## §9 关键不变量检查清单

实施完成前对照本清单逐项过：

- [ ] `readConfig('tenant-profile', { tenantId })` 接口返回形态下游零变化
- [ ] 三个消费点（formulaEngine/particleModel ×2）合并前后**byte-equal** 兼容
- [ ] 任何写操作都过决策第 0 闸（assign/remove 各自落 decision 行）
- [ ] system 租户保护：assign/remove 一律 400
- [ ] 物理 DELETE 零调用
- [ ] 迁移脚本幂等（version 字段判断）
- [ ] 同名合并 = C 静默覆盖，返回 `merge_meta.conflict_keys` 供前端展示
- [ ] 备份表 `config_store_profile_legacy_snapshot` 保留不删
- [ ] 手动跑 `node scripts/verify-billing-gates.mjs` 全过
- [ ] `node scripts/ui-lint.mjs` 退出 0
