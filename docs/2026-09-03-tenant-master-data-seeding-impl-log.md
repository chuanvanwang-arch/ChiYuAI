# 按租户播种主数据 — 实施记录（测试库验收）

> 关联：设计 `docs/2026-09-03-tenant-master-data-seeding-design.md`、计划 `docs/superpowers/plans/2026-09-03-tenant-master-data-seeding.md`
> 决策依据：`docs/2026-09-03-attio-lightfield-study.md` §1「全部数据走方案 B（每租户自有）」已拍板
> 执行时间：2026-09-03 21:33–21:40（GMT+8）
> 执行库：**测试库 `crm_native_test`**（未碰生产库 `crm_native`）

## 一、执行步骤与结果

| 步骤 | 命令 | 结果 |
|---|---|---|
| 1. 灌 system 模板 | `PGDATABASE=crm_native_test node scripts/seed-master-data.mjs` | CRM_PRODUCT 12 / CRM_PRICE_LIST 4 / CRM_OFFER_POLICY 9 / CRM_DICT_ENTRY 28（四类共 53 条） |
| 2. acme-chem 首次播种 | `PGDATABASE=crm_native_test node scripts/seed-tenant-master-data.mjs --tenant acme-chem` | copied 53 / skipped 0（PRODUCT 12 + PRICE 4 + OFFER 9 + DICT 28） |
| 3. 幂等二次播种 | 同 Step 2 再跑 | copied 0 / skipped 53（stable_key 冲突跳过，幂等生效） |
| 4. 验收 SQL 核对 | 见下 | 验收 1/2/6 通过 |
| 5. 禁 DELETE 自检 | grep | 仅注释命中（见下） |

## 二、验收标准 1–6 结论

| 验收项 | 期望 | 实测 | 结论 |
|---|---|---|---|
| 1. 开箱可得 | 新租户带本租户四类主数据副本 | acme-chem 按 type 得 DICT 28 / OFFER 9 / PRICE 4 / PRODUCT 12（共 53） | ✅ |
| 2. 隔离生效 | 复制后独立演进；与 system 无冲突 | acme-chem 与 system 的 CRM_PRODUCT slug 同名 12 条（同源副本，靠 `tenant_id` 隔离）；`stable_key` 冲突行 = 0 | ✅ |
| 3. 独立演进 | 复制后 `decision_id`/`embedding`/`content_hash`/`fts`=NULL | 实现 INSERT 显式置 NULL（首编触发写时索引），代码保证 | ✅ |
| 4. 禁 DELETE | 全脚本无 DELETE/TRUNCATE/DROP | grep 仅命中注释（`scripts/...:6` 安全说明、`db/seed/seed-all-tenants.mjs:9` 红线） | ✅ |
| 5. 配置零代码 | 新行业仅加 profile/users 脚本 + 调 `seedTenantMasterData`，无新脚本/字面量 | 复制引擎通用（`TYPES` 常量 + 配置驱动 `filter`），新增行业不触碰引擎代码 | ✅ |
| 6. 回归无碍 | system 模板条数不变 | `system`.CRM_PRODUCT 仍 12 条（模板未被影响） | ✅ |

## 三、实测验收 SQL 输出（节选）

```
acme-chem 主数据条数（验收1: 开箱可得）:
  CRM_DICT_ENTRY   28
  CRM_OFFER_POLICY   9
  CRM_PRICE_LIST     4
  CRM_PRODUCT       12
  合计 53 条
system 模板 CRM_PRODUCT 仍: 12 条（验收2/6: 模板未被影响）
与 system 冲突行: 0（验收1: stable_key 隔离，应为0）
CRM_PRODUCT slug 重叠（两租户同名但 tenant 不同）: 12（验收2: 同源模板复制，靠 tenant_id 隔离）
```

## 四、实现期修正（计划未覆盖）

**Windows CLI 入口失效修复**：计划原 `const isMain = import.meta.url === \`file://${process.argv[1]}\`` 在 win32 下失效——
- `process.argv[1]` 为反斜杠盘符路径（如 `D:\system\...`），`file://` + 反斜杠拼出的 URL 与 `import.meta.url` 的正斜杠/`file:///D:/` 形式不匹配，且盘符大小写不一致；
- 导致 `main()` 未触发，CLI 静默无输出（exit 0）。
- 修复：`scripts/seed-tenant-master-data.mjs` 顶部加 `import { pathToFileURL } from 'url';`，改为
  `const isMain = !!process.argv[1] && import.meta.url.toLowerCase() === pathToFileURL(process.argv[1]).href.toLowerCase();`
- 影响：仅 CLI 入口判定；导出的 `seedTenantMasterData/planCopy/passFilter` 与单测不受影响（单元测试已 6/6 通过）。

## 五、交付物清单

| 文件 | 状态 |
|---|---|
| `scripts/seed-tenant-master-data.mjs` | 新增（含 Windows isMain 修复） |
| `test/seed/tenant-master-data.test.mjs` | 新增（6 tests 全绿） |
| `db/seed/seed-all-tenants.mjs` | 修改（import + ①B 播种调用） |
| `plugin-platform-admin/skills/industry-onboarding/SKILL.md` | 修改（Step 4B + §1/§7 同步） |

## 六、下一步（生产执行，需用户显式授权）

- **生产库执行仅可在用户确认后、显式 `PGDATABASE=crm_native` 跑**，且须先确认生产库 `system` 模板主数据已就位（`node scripts/seed-master-data.mjs` 默认库即 `crm_native`）。
- 新租户上线 Runbook（industry-onboarding Step 4B）已就绪：`node scripts/seed-tenant-master-data.mjs --tenant <id>`（或纳入 `seed-all-tenants.mjs` 自动播种）。
- 注意 `--dry-run` 预演、生产写 `decision_id=NULL`（系统运维写，豁免决策第0闸）均符合铁律。
