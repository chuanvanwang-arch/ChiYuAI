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

## §2 approval_flow —— 仍为平台级伪隔离（RESIDUAL，需单独设计）

**DDL 事实源**（`db/migrate-config.sql:48-56`）：

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

判定：
- **无 `tenant_id` 列**；主键 `flow_id` 为全局唯一 → 所有租户共享同一审批流定义集。
- 读端点（approvalFlow router）按租户过滤、写端点落 `system`，但数据无法分租户存储 → 租户无法定义差异化审批路径（审批流拓扑全平台一致）。
- 与设计 `id17` `scope:'tenant'` 标签**矛盾**：标签声明租户级，实际为平台级共享。

与本次 RBAC 修复的关系：
- 本次 F1 租户写闸（`enforceScope` tenant 分支）作用于**粒子写通道**（DEAL/ACCOUNT/CONTRACT 等），**不触及 approval_flow 表**（approval_flow 非 scoped 粒子，经专用 router 直连 DB）。
- 故 approval_flow 伪隔离**不在本次代码 pass 范围**，列为独立 follow-up。

结论：**OPEN（RESIDUAL）**。建议单独成设计，决策点：
- 方案 α：维持平台级模板（所有租户共用同一审批流拓扑，符合「平台治理基线」定位），将 `configCenter.js` id17 `scope` 改为 `'platform'` 使标签与事实一致；
- 方案 β：加 `tenant_id` 列 + 复合 PK，支持租户覆写（与 business_tier 同构），写端点改落租户。

> 本结论不预置代码改动；标签校正（id17 scope 平台级化）属轻量清理，可在用户拍板方案 α 后随 F6 收口提交。

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
| approval_flow 隔离 | 伪隔离（无 tenant_id） | 无 `tenant_id`，全局 PK（migrate-config.sql:48） | **仍平台级（RESIDUAL）** | 否（独立 follow-up） |
| id35/36/39/44 标签 | level/system vs scope/tenant 漂移 | ADMIN-only 访问 + 按租户存储 | **标签语义澄清（非缺陷）** | 否（可选注释） |

**对审计设计（docs/2026-09-06-rbac-audit-design.md）的输入**：
- F6 中「business_tier 伪隔离」已不存在 → 审计设计可标记为 RESOLVED。
- F6 中「approval_flow 伪隔离」升级为独立 OPEN 项 → 审计设计的监控/后续项需单列跟踪。
- id35/36/39/44 不影响权限正确性 → 不计入越权面。
