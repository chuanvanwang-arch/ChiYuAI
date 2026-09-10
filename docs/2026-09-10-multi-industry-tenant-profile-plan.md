# 一租户多行业画像：实施计划（Y 嵌套 / C 静默覆盖 / 一次大修）

- 日期：2026-09-10
- 依据：`docs/2026-09-10-multi-industry-tenant-profile-design.md`（已批准）
- 范围：把「单租户单行业画像」升级为「单租户多行业画像」，消费点零改动（合并语义聚拢到 `profileMerger.js`）。

## 关键事实（代码级锚点，已核实）
- `readConfig('tenant-profile')` 被 3 处消费：`particleModel.resolvePrototype`(L343)、`particleModel.isControlledPredicateConfig`(L365)、`calc/formulaEngine.runProfileCalculations`(L34)。
- 三处读取形态：`value.prototypes[type]`、`Object.values(value.prototypes).flatMap(p=>p.edgeTypes)`、`value.calculations`。
- **真实数据形态**：edgeTypes 挂在**每个 prototype 内部**（seed 例 `CHEM_SUPPLIER.edgeTypes`），**没有行业级 `edge_types`**。故合并从 prototype 级取，设计 §3.1 的「行业级 edge_types」按真实数据修正（更正确）。
- 测试库 `tenant-profile` 全是 v1（`value.industries` 为 null，`meta.industry_label` 部分缺失）→ 迁移脚本须对 v1 兜底。
- `gateDecision(me, fields)` 已存在并落 `produceDecision` → `crm.decision`（rationale 含 fields 文本）。

## 设计偏差修正（如实登记）
1. 取消「行业级 edge_types」字段；edgeTypes 合并自各 industry 的 `prototypes[*].edgeTypes`（与消费点一致）。
2. `mergeProfile` 对 v1 value（无 `industries` 数组）**原样返回**（其 `.prototypes` 已在顶层），保证未迁移租户零回归。
3. `formulas` 字段本设计不消费，模板无此字段 → 忽略，前向兼容占位。
4. `assignIndustry` 生成的 industry `entry` **不复制模板 `meta` 对象**；模板 `meta.template_id` 与 `meta.industry_label` 分别落到 `entry.id` 与 `entry.label`（另存 `assigned_from_template_id`）。故断言须用 `industries[0].assigned_from_template_id` 而非 `industries[0].meta.template_id`（已同步旧测试 T8）。

## Task 切分

### T1 新增模块 `src/config/profileMerger.js`（纯函数，无外部依赖）
导出：`mergeProfile / assignIndustry / removeIndustry / migrateFromV1 / resolvePrototypeInMerged / isControlledPredicateInMerged`。
- `mergeProfile(value)`：v1（无 `industries` 数组）→ 原样返回；v2 → 返回 `{...value, prototypes, calculations, approvalDomains}`（跨 industries 合并，后者覆盖前者 = C 静默覆盖）。
- `assignIndustry(rawValue, {template, templateId, decisionId})`：基于 `migrateFromV1` 起点；同 id 幂等跳过；否则追加 industry 入 `industries[]`；算 `conflict_keys`（出现于 >1 industry 的 type 名）；返回 `{next:{version:2,industries,merge_meta}, merge_meta, skipped}`。
- `removeIndustry(rawValue, industryId)`：缺失抛错；否则 drop；返回 `{next, removed}`。
- `migrateFromV1(rawValue, fallbackLabel)`：`rawValue.industries` 已是数组 → 返回原值（upgraded:false）；否则包成 `{version:2, industries:[{id,label,prototypes,approvalDomains,calculations,assigned_*}], merge_meta}`。

### T2 迁移脚本 `db/seed/migrate-tenant-profile-to-v2.mjs`（一次性幂等）
- 建备份表 `config_store_profile_legacy_snapshot`（IF NOT EXISTS），COPY 现有 `tenant-profile` 行（保留不删）。
- 逐行：若 `value.industries` 非数组 → `migrateFromV1`（label = `meta.industry_label` || tenant_id；system 用 `__baseline`/代码基线）→ upsert 回 `config_store`（保留 `decision_id`）。
- 已是 v2 → 跳过。

### T3 `configStore.readConfig` 桥接（接口不变，下游无感）
- 抽取 `rawRead(key, tenantId)`，原逻辑搬入。
- `readConfig` 末尾：key==='tenant-profile' → `{...row, value: mergeProfile(row.value)}`；否则原样。
- 仅此一处改动，三消费点零改动。

### T4 `billingRoutes.js` 三端点改造
- `tenant-subscriptions`：SQL 用 `CASE` 抽 `industries` 数组（v2 取 `industries`；v1 退化为单 legacy chip）；`profile_summary={industries:[{id,label}]}`。
- `assign-profile`：`body={tenantId, templateIds:string[]}`；逐模板克隆追加；`gateDecision` 含 templateIds；system 400；返回 `{ok, industries, merge_meta}`。
- 新增 `remove-profile`：`body={tenantId, industryId}`；`removeIndustry`；`gateDecision`；system 400；不存在返回 400。

### T5 前端 `admin-billing-console.html`
- `renderSubs`：行业列改多 chip（超过 3 显示 +N）；操作列加「移除画像」提示由弹窗内 ✕ 承载。
- `openTenantAction('profile')`：列出当前 industries（每个 chip 旁 ✕ `data-rm=id`）+ 待分配模板多选 checkbox。
- `ta-ok` 对 profile：收集勾选 templateIds → POST `assign-profile`；✕ 走独立 capture 委托 → 二次确认 → POST `remove-profile`。
- `profile` 提示文案改为「追加/移除行业（同名类型后者覆盖前者）」。
- 分配成功若 `merge_meta.conflict_keys.length>0` → 顶部红条提示静默覆盖事实（不拦截）。

### T6 测试
- `test/config/profileMerger.test.js`：T1–T6 纯函数（mergeProfile v1/v2、同名合并、幂等、remove、migrate）。
- `test/billing/tenantAdminMultiProfile.test.js`：T7–T16（单/多/冲突 assign、remove 不删行、chip、幂等、system 400、权限 403、决策行 rationale 含 id）。

### T7 全量回归
- `node --experimental-vm-modules node_modules/vitest/vitest.mjs run test/billing/ test/config/` 全绿。
- `node scripts/ui-lint.mjs` 退出 0；`node scripts/verify-billing-gates.mjs` 全过。
- 本地跑迁移脚本（测试库）核验幂等。

## 红线自检（实施完逐项过）
- [ ] readConfig 接口下游零变化；byte-equal T17/T18 通过
- [ ] 写操作全过第0闸（assign/remove 落 decision 行）
- [ ] system 租户保护：assign/remove 400
- [ ] 物理 DELETE 零调用（移除=数组 drop+整体 UPDATE）
- [ ] 迁移脚本幂等（version 判断）
- [ ] 同名合并=C 静默覆盖，返回 conflict_keys 供前端展示
- [ ] 备份表保留不删
