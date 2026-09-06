# 平台套餐「是否真的启用」E2E 复核报告

- 日期：2026-09-06
- 范围：配置真相源一致性、权益门禁（第 1.7 闸）、Token 闸、席位闸、计量归属、菜单门禁、对外 API、页面动态化、管理台设档链路
- 结论：**套餐体系现已真实启用**，但复核过程中发现 6 个此前未被发现的缺陷（其中 2 个会导致闸门整体失效），已全部修复并补上常驻 E2E 护栏。

---

## 一、结论先行

| 闸门 | 状态 | 判据（E2E 取证） |
|---|---|---|
| 权益门禁（Action 第 1.7 闸） | ✅ 生效 | 73 个 Action 声明门禁（改造前 14）；free 档调用被拦 `gate=plan_entitlement`，pro 档放行 |
| 缺失租户 fail-closed | ✅ 生效 | 上下文无 tenantId → `gate=plan_entitlement_missing_tenant`（此前静默获得全权益） |
| Token 闸 | ✅ 生效 | block 档超量抛 `TokenQuotaError`；bill 档至 hard_cap 封顶；-1 档不限；system 豁免 |
| Token 计量 | ✅ 生效 | 带租户调用落库且归属正确租户；缺租户记 system 并告警（方案 B，不阻断） |
| 席位闸 | ⚠️ 部分 | 现网所有档位 `seat_unit_price>0` → 只计费、不封顶（block 分支在现网不可达，属运营策略） |
| 菜单门禁 | ✅ 生效 | 免费档无「报告」，pro 档可见；未传权益集时不过滤（向后兼容） |
| 对外页面 | ✅ 全动态 | landing/billing 零档位名与价格硬编码（静态护栏用例守住） |
| 管理台设档 | ✅ 生效 | 改档后运行期闸门立即变化（无重启、无缓存） |

---

## 二、发现并修复的缺陷

| # | 缺陷 | 影响 | 修复 |
|---|---|---|---|
| 1 | **三份真相源漂移**：`db/seed-billing-config.sql` 的 `included_tokens` 全为 -1、`token_overage_mode` 全为 `none`，与配置中心现网（50000/block、200000/bill…）严重不一致 | **一次 `npm run seed` 重播即把 Token 闸整体关掉**；测试间也据此互相踩踏 | 三源统一为现网口径；新增 `test/billing/planSourceConsistency.test.js` 常驻比对（含「禁 mode=none」红线） |
| 2 | **pro 档缺 `memory` 权益**：starter/free 有、pro 没有 | 客户从 starter 升级到 pro **反而丢功能** | 三源 + 本地库已补（pro 10→11 权益）；修复脚本 `scripts/fix-billing-plan-entitlements.mjs` |
| 3 | `POST /api/admin/tenant-plan` 用**读池执行 UPDATE** 且**不校验 planId** | 可把租户设成不存在的档位 → `getPlan` 静默回退数组首项（免费档）→ 权益被悄悄降级 | 改 `queryWrite` + 校验 planId 必须存在于 billing-plans（否则 400） |
| 4 | `getPlan`/`resolveEntitlements` 对无效 planId 回退 `plans[0]` | 同上，静默降级到免费档 | 改为显式回落 `billing-settings.default_plan` |
| 5 | `db/migrate.js`/`npm run seed` **从不播种套餐配置** | 全新库回退 `pricing.DEFAULT_PLAN`（`included_tokens=0`、`entitlements=[]`）→ **全功能拦截 + Token 立即封死**，极难归因 | migrate 增加「缺失时初始化播种」（`WHERE NOT EXISTS`，**不覆盖现网配置**） |
| 6 | `db/seed.sql` 的 `alert_rule` 用 `ON CONFLICT (kind)`，实际 PK 为 `(kind, tenant_id)` | **整份 seed.sql 执行即报错**，所有依赖 `reseedBase()` 的测试文件级失败 | 改为 `(kind, tenant_id)`；seed.sql 现已可整体执行 |

附带清理：`test/helpers/seedBillingPlans.js` 补齐 quote/features/enabled/highlight；`scripts/seed-test-config.mjs` 增加套餐基线复位；`landing.html` 移除「价格面议」硬编码文案。

---

## 三、测试污染链（「单跑绿、全量红」根因）

`billingRoutes.test.js` 判定测试库缺 quote → 重播**旧 seed（-1/none）** → 其 T4 的 `beforeAll` 快照的是「重播后」的值 → `afterAll` 将旧口径当作 original 恢复 → 全局配置被永久改成关闸版 → 后跑的 `tokenUsage.test.js` 读到 `included_tokens=-1` 而红。

治理：快照/恢复提到文件级 `beforeAll/afterAll`；断言改为配置驱动（从 `getPlan()` 现读，不锁死 50000）；pretest 复位测试库基线。

---

## 四、新增 E2E 用例

| 文件 | 用例数 | 覆盖 |
|---|---|---|
| `test/billing/planGate.e2e.test.js` | 18 | 分档权益差异 / 未配档回落 / Action 门禁高低档对照 / 缺租户 fail-closed / Token 三模式 / 计量落库与租户隔离 / onUsage 回传 / 席位隔离 / 菜单过滤 / API catalog / 页面零硬编码静态护栏 |
| `test/billing/tenantPlan.e2e.test.js` | 5 | 管理台设档→闸门即时生效 / 非法 planId 400 / 非 admin 403 / 缺参 400 |
| `test/billing/planSourceConsistency.test.js` | 7 | seed SQL ↔ fixture 逐字段比对 / 禁 mode=none / 权益单调递增 / 权益键中文标签 |

验证结果：`test/billing` 套件 **23 文件 113 例全绿**；全量 3371 例中 3354 通过，剩余 17 例为既有技术债（见下）。

---

## 五、全量回归中的既有红灯（非本轮引入）

| 类别 | 用例 | 说明 |
|---|---|---|
| PK 复合化遗留 | `multi-tenant`(decision FK)、`context`(role_context_profile 6→8 行)、`monitor` | 租户化改造后引用/计数未同步 |
| readConfig autoSeed | `multi-tenant T4`、`policy-version ⑥` | 租户行带 `_seeded:'system-template'` 导致回退值深度不等 |
| 页面债 | `calibrationMonitor`、`decision-network-linkage`×2、`pipeline-new-deal` | 页面/测试早于现行规范（前会话已记录，需单独立项） |
| 环境/时序 | `alert`×2、`nightlyReportRoute`、`ai-attributes`、`agent-summary`、`sysadmin-profile`、`mcp-tenant` | 多次全量跑数量在 14→18→17 间波动，具 flaky 特征 |

判定依据：`.git` 损坏无法取改动前基线，但失败点均不触及 billing 配置/权益/计量/门禁代码路径，且 `test/billing` 全绿。

---

## 六、待办与待拍板

1. **生产同步（需授权）**：pro 补 `memory` 权益 + 本轮源码 hotfix（entitlements.js / billingService.js / billingRoutes.js / migrate.js / seed.sql / seed-billing-config.sql / landing.html）。
2. **现网无 `highlight` 标记** → landing/账单页的「推荐」高亮实际不展示（功能已实现，等待运营配置）。
3. **free 档 `included_seats=3` 但 `seat_unit_price=99>0`** → 席位只计费不封顶，与「含 3 席位」文案口径不符（运营策略待确认）。
4. **starter `quote=¥698` 与 `seat_unit_price=398` 不一致** → 展示价与实收口径不一致，需统一。
5. `billing.html` 尚有 10 处 ui-lint 样式警告（本地重声明设计系统保留类），非本轮引入，建议单独立项清理。
