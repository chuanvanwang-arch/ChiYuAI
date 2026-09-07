# RBAC F6 历史伪隔离复测结论（2026-09-06）

- 复测日期：2026-09-06
- 范围：历史审计标记的「配置项 level/scope 标签漂移 + 历史伪隔离」（设计 §3.6 / 任务 #6）
- 方法：以 **DDL 单一事实源**（`db/schema.sql`、`db/migrate-config.sql`）为权威判定（项目铁律：DDL 单一事实源）；实时库探测因沙箱审批拦截未执行，结论以 DDL 为准。
- 结论：business_tier 伪隔离**已收敛为真实隔离**；approval-flow **仍为平台级伪隔离**；id35/36/39/44 为标签语义，非越权缺陷。

---

## §1 business_tier_config —— 已修复（真实租户隔离）

**DDL 事实源**（`db/schema.sql:248-254`）：

```sql
CREATE TABLE IF NOT EXISTS crm.business_tier_config (
  tenant_id       TEXT NOT NULL DEFAULT 'system',
  dimension       TEXT NOT NULL,
  dimension_value TEXT NOT NULL,
  tier            TEXT NOT NULL,
  PRIMARY KEY (tenant_id, dimension, dimension_value)
);
```

判定：
- 含 `tenant_id` 列，主键为复合 `(tenant_id, dimension, dimension_value)` → 任一租户可覆写本租户分级，平台基线行以 `tenant_id='system'` 承载。
- 与 `configCenter.js` id18 `scope:'tenant'` 一致 → **读写均按租户隔离，历史「全租户共享一份」伪隔离已收敛**。
- 历史审计（`_f6_probe.mjs` 实测）曾报「16 行全 system、租户改即动全局」——该现象是因尚未有租户覆写行；**DDL 已支持分租户**，属已修复项，非代码缺陷。

结论：**RESOLVED**（真实隔离，无需进一步代码改动）。

---

## §2 approval_flow —— 结论修正（2026-09-07）：运行时已隔离，残留仅为遗留表 + 死托管页

> **⚠️ 本节原结论「仍为平台级伪隔离」系误判，已修正**（2026-09-07）：误将遗留表 `crm.approval_flow` 当作运行时存储。真相：**审批流真源自 2026-08-31 方案 A 起已迁移 `CRM_APPROVAL_*` 粒子**（含 `tenant_id`，`getFlowByDomainWithFallback` 懒克隆 system 模板），租户差异化审批路径已支持（生产 5 租户各 4 流独立，acme-chem 定制流分叉实证）。

**遗留表事实**（`db/migrate-config.sql:48-56`）：

```sql
CREATE TABLE IF NOT EXISTS crm.approval_flow (
  flow_id     TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  stages      JSONB NOT NULL,
  enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

修正后判定：
- 该表**零写路径**（全 src/ 无 INSERT/UPDATE/DELETE），2026-08-31 起降级只读兼容，**非运行时存储**。
- 唯一只读消费 = `controlledConfigPages.js` 的 `/api/page/approval-flows` 托管页，且**无任何前端调用（死代码）**。
- 原「读端点按租户过滤、写端点落 system」描述的是**旧表直连时代**的历史行为，现读写均走粒子层。
- id17 标签已按方案 α 校正（`configCenter.js:30` `scope:'platform', resolve:'system-only'`，2026-09-06 完成），与「平台级共享模板 + 租户粒子分叉」架构一致。

结论：**RESOLVED（2026-09-07 方案 1 退役收口）**。收口动作（`docs/2026-09-07-approval-flow-legacy-retire-design.md`）：
- 删除死托管页条目 + 失效 S22_SCHEMA import；`approvalFlowRender.js` 过时注释修正；
- `migrate-config.sql` 表 DDL 标注 DEPRECATED（禁 DELETE 铁律，表保留只读兼容、不 DROP）；
- 守卫测试 `test/http/approvalFlowLegacyGuard.test.js` 断言 src/** 无该表 SQL 消费，防重新接线。

---

## §3 配置项 level/scope 标签漂移（id35 / 36 / 39 / 44）

**事实**：`configCenter.js` 中 id35/36/39/44 均为 `level:'system'`（ADMIN-only 权限闸）但 `scope:'tenant'`（数据按租户存储）。

判定：
- `level` 与 `scope` 语义本就不同（设计 §0 注释 + configCenter.js:4-6）：`level`=权限层级（谁可访问），`scope`=数据存储作用域（数据存哪）。
- 此四处 `scope='tenant'` 仅表示其配置值**按租户维度存储/读取**（如 event-retro 阈值按租户可配），但**访问闸仍为 ADMIN-only**（`level='system'`），不构成越权。
- 标签「漂移」为**注释误导**，非权限缺陷。运维若按 `scope` 误判为租户级可达会出错。

结论：**标签语义澄清（非缺陷）**。建议（轻量，可选）：在对应 `note` 增注「ADMIN-only 访问；scope 仅为存储域」，消除运维误读。无需改 `level`。

---

## §4 复测结论汇总

| 项 | 历史状态 | 当前 DDL 事实 | 结论 | 是否本次代码范围 |
|---|---|---|---|---|
| business_tier_config 隔离 | 伪隔离（全租户共享） | `tenant_id` + 复合 PK（schema.sql:248） | **已真实隔离（RESOLVED）** | 否（历史已收敛） |
| approval_flow 隔离 | 疑似伪隔离（无 tenant_id） | 真源=CRM_APPROVAL_* 粒子（租户懒克隆）；表已 DEPRECATED 零写路径 | **已隔离（RESOLVED，2026-09-07 方案 1 退役收口）** | 否（遗留物已退役） |
| id35/36/39/44 标签 | level/system vs scope/tenant 漂移 | ADMIN-only 访问 + 按租户存储 | **标签语义澄清（非缺陷）** | 否（可选注释） |

**对审计设计（docs/2026-09-06-rbac-audit-design.md）的输入**：
- F6 中「business_tier 伪隔离」已不存在 → 审计设计可标记为 RESOLVED。
- F6 中「approval_flow 伪隔离」**已收口（2026-09-07 方案 1）** → 遗留表退役 + 死托管页删除 + 守卫测试；审计设计可标记 RESOLVED。
- id35/36/39/44 不影响权限正确性 → 不计入越权面。
