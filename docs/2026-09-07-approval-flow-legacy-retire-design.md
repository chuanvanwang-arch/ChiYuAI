# approval_flow 遗留表退役收口设计（方案 1：退役遗留）

- 日期：2026-09-07
- 状态：方案已经用户批准（AskUserQuestion 选定方案 1）
- 上游：docs/2026-09-06-rbac-pseudo-isolation-retest.md（结论修正项）；docs/2026-09-06-rbac-audit-design.md §F6

---

## §0 真相澄清（证据驱动，修正 F6 复测误判）

F6 复测曾探 `crm.approval_flow` 表得出「仍伪隔离」——**该结论把遗留物误判为运行时存储**。实际：

| 层 | 现状 | 证据 |
|---|---|---|
| 写路径 | ✅ 全部走 `CRM_APPROVAL_*` 粒子（有 `tenant_id`，`getFlowByDomainWithFallback` 懒克隆 system 模板） | `src/portal/approvalFlow.js:3`（方案 A 2026-08-31）；生产 5 租户各 4 流独立、acme-chem 分叉实证 |
| 运行态/配置页读 | ✅ `approval-flow.html` → `/api/approval-flows` → 粒子后端（租户隔离） | `approval-flow.html:57/85` |
| `crm.approval_flow` 表 | ⚠️ 零写路径；唯一只读消费 = `controlledConfigPages.js:162` 托管页 | 全 src/ grep 证实 |
| 该托管页 | ❌ 死代码：`/api/page/approval-flows` 无任何前端调用 | src/web 零命中 |
| id17 标签 | ✅ 已按方案 α 校正 `scope:'platform'` | `configCenter.js:30`（2026-09-06） |

## §1 方案（已批准：方案 1 退役遗留）

1. **删死代码**：`controlledConfigPages.js` 移除 `'approval-flows'` 条目 + 失效的 `S22_SCHEMA` import；`test/http/controlled-config-pages.test.js` CASES 同步移除该行。`pages/index.js` 的 S22 schema 注册**保留**（页面市场纯预览，不触 DB，YAGNI 不扩大手术面）。
2. **修正过时注释**：`src/portal/approvalFlowRender.js:10`「数据后端：crm.approval_flow」→ 粒子后端 + 遗留表 DEPRECATED 说明。
3. **DDL 标注**：`db/migrate-config.sql` `approval_flow` 表上方加 DEPRECATED 注释（表本体按禁 DELETE 铁律保留，只读兼容）。
4. **守卫测试**（新增 `test/http/approvalFlowLegacyGuard.test.js`）：扫描 `src/**/*.js` 断言无 `(FROM|INTO|UPDATE)\s+crm\.approval_flow` 消费——防止遗留表被重新接线。
5. **修正 F6 复测文档**：结论改为「运行时粒子层已隔离；伪隔离残留 = 遗留表 + 死托管页，已按方案 1 收口」。

## §2 影响面

- **零运行时行为变化**：删除的端点无消费者；粒子后端链路不动。
- **不破坏**：F1–F5 修复、id17 标签、approval-flow.html 配置页、运行态审批引擎。
- **收益**：消除双源误导（维护者不再把遗留表当数据后端）；守卫测试防回归接线。

## §3 回归

`test/http/approvalFlowLegacyGuard.test.js`（新）+ `test/http/controlled-config-pages.test.js`（-1 case）+ `test/web/configCenter.rbac.test.js` + F4/RBAC 套件抽测。
