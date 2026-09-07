# 生产系统状态核查与发布建议（2026-09-07）

> 用户诉求：将计费套件「全部相关更新」建议并发布到生产系统。
> 核查结论：**生产已是最新，全部相关更新均已上线，无需再次 release。**

## 一、生产当前状态（实测证据）

| 验证项 | 命令/来源 | 结果 |
|---|---|---|
| 容器健康 | `docker ps` | crm-app / crm-mcp / crm-pg 均 `Up 2h (healthy)` |
| `/billing.html` 可用性 | `curl -sk -o /dev/null -w '%{http_code}'` | **200**（非白屏） |
| 白屏修复是否 live | `grep -c 'function fmtMoney' /billing.html` | **0**（重复定义已移除） |
| `/landing.html` 可用性 | 同上 | **200** |
| 权益目录下发 | API `entitlement_catalog` | 已下发 |
| MCP 权益闸源码 | `grep -c assertMcpAccess src/mcp/gateway.js`（生产） | **4** |
| 订阅到期调度源码 | `grep -c startSubscriptionSweeper src/http/server.js`（生产） | **2** |
| DB 套餐乱码 | API 响应 grep mojibake `EF BF BD` | **0**（编码修复已落生产库） |
| 主价字段下发 | API `seat_unit_price` | 正常 |

## 二、相关更新清单（已上线生产）

归属「计费套件」的全部改动，按四影响面：

| # | 更新项 | 文件 | 生产状态 |
|---|---|---|---|
| 1 | landing 套餐卡片全动态化（主价=seat_unit_price / 副标题=quote / 划线=original_price / 角标=tag_text / bullet=features+权益翻译） | `src/web/landing.html` | ✅ live |
| 2 | 管理台套餐表单实时预览 + 原价/角标字段 + UTF-8 | `src/web/admin-billing-console.html` | ✅ live |
| 3 | billing.html 套餐卡片与 landing 对齐 + 白屏修复（删重复 `fmtMoney`） | `src/web/billing.html` | ✅ live（HTTP 200，无残留） |
| 4 | MCP 通道 `mcp_access` 权益闸（fail-closed / system 豁免） | `src/mcp/gateway.js` | ✅ live（4 处） |
| 5 | 订阅到期停服调度（幂等单例 + unref） | `src/http/server.js` | ✅ live（2 处） |
| 6 | 三真相源统一 + 一致性护栏 | `db/seed-billing-config.sql` / `test/helpers/seedBillingPlans.js` / `src/billing/planSchema.js` | ✅ 已在基线提交 |
| 7 | 套餐编码乱码修复（LF + 中文还原） | `scripts/fix-billing-encoding.mjs` | ✅ 已对生产库执行，乱码=0 |
| 8 | billingRoutes 设档走写池 + planId 校验 + settings.billing_intro 兜底 | `src/http/billingRoutes.js` | ✅ live |
| 9 | migrate 套餐基线缺失初始化播种 + billing_intro 兜底 | `db/migrate.js` | ✅ live |

## 三、建议（结论）

1. **代码层：不建议再次 release。**
   - 本地工作树仅剩 `test/context.test.js`、`test/mcp-tenant.test.js`（属测试，发布打包本就排除 `test/`，不应上生产）与垃圾项（`Lanch/`、`*.patch`、`*.ps1`，不在打包包含列表）。
   - 生产源码经 grep 实测已含全部新逻辑，无 stale。
   - 再发一次为**零变更冗余操作**，且 release 需重走 `.env` 备份恢复 + nginx HTTPS 恢复（脆弱环节），徒增风险。

2. **DB 配置层：无需动。**
   - 生产 `config_store.billing-plans` 已无乱码、主价/权益字段正常。
   - 你此前在管理台调整的套餐（价格/权益/tag）已实时写入生产库，刷新页面即见，与本地一致。

3. **若坚持「再发一次保平安」**：可走标准 `release` 流程（需重新 `.env` 备份 + 恢复 + nginx HTTPS 恢复 + 点检），属冗余，请明确说「重发一次」即执行。

## 四、待办 / 注意

- 本地 git 仍未提交（沙箱无凭证，AI 不能 commit）。白屏修复等改动在**本地工作树**，需你从 gitea re-clone 后按功能线分组提交（禁 `git add -A`，每 Task 一 commit）。
- 不要将 `test/` 改动与垃圾项提交或上生产。
- 本地起 dev server 务必 `PGDATABASE=crm_native_test`，否则默认连**生产库** `crm_native`。
