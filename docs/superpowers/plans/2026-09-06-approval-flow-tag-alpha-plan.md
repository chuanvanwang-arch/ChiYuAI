# approval_flow 伪隔离 follow-up — 方案 α（标签平台级化）实施计划

> 上游：docs/2026-09-06-rbac-pseudo-isolation-retest.md §2（RESIDUAL，方案 α/β）；docs/2026-09-06-rbac-audit-design.md §6
> 用户决策：2026-09-06 22:0x「拍板方案 α/β 【A】」→ **选定方案 α**
> 方案 α 定义：**维持平台级模板（所有租户共用同一审批流拓扑），将 configCenter.js id17 `scope` 改为 `'platform'` 使标签与事实一致**；不动表结构（不加 tenant_id）。

---

## §0 结论

`crm.approval_flow`（`db/migrate-config.sql:48-56`）无 `tenant_id`、`flow_id` 全局 PK → **数据实为平台级共享**。此前 configCenter id17 标 `scope:'tenant'`（租户级）与事实矛盾，属标签误导（非权限缺陷）。

方案 α 只改元数据标签，**零行为变化**（与 Phase 2 W3 id35/39/44/36 同范式：纯元数据修正，不动运行时 gate）。

---

## §1 改动清单

| 文件 | 操作 | 内容 |
|---|---|---|
| `src/portal/configCenter.js` | Modify | `id17` `scope:'tenant'` → `'platform'`；`resolve:'tenant-first'` → `'system-only'`（对齐 id35/39/44/36 口径；note 补「平台级共享模板」说明） |
| `test/web/configCenter.test.js`（或 scope 断言） | Modify | 同步断言 id17 `scope='platform'` + `resolve='system-only'` |
| （可选，不动） | — | `db/migrate-config.sql` **不改**（方案 α 明确不加 tenant_id） |

**grep 前置确认**（实施时执行）：
1. `resolve`/`scope` 字段无运行时 gate 消费（仅展示）——与 Phase 2 W3 相同，grep 已验证过 id35/39/44/36。
2. `approvalFlow.js` router 不读 configCenter 的 scope 标签（是，按域直查粒子）——确认 id17 标签改动不影响任何代码路径。

---

## §2 实施步骤

**Task 1 — configCenter.js id17 标签**
```js
{ id: 17, name: '审批流配置', group: '业务对象与流程建模', level: 'tenant', status: 'ready',
  page: '/approval-flow.html', endpoint: '/api/approval-flows',
  scope: 'platform', resolve: 'system-only',
  note: '四域审批流定义（deal/quote/contract/invoice），平台级共享模板（全租户共用拓扑），写经决策第0闸' }
```
- `level:'tenant'` **保持不变**？——需核对：id17 `level` 当前为 `'tenant'`（tenant 级可达，ten_admin 可配置本租户流）。方案 α 仅改 `scope`（存储域）为 platform，**level（权限层级）不动**，与 id35/39/44/36 的 `level:'system'` 不同——那四者是 ADMIN-only；id17 是 tenant 级可达。故此处 `level` 保留 `'tenant'`，仅 scope/resolve 平台化。`note` 增「共享模板」说明。

**Task 2 — 测试同步**（grep 定位 id17 断言处后改）

**Task 3 — 回归**：`test/web/configCenter*.test.js`（20 例）+ 相关。

---

## §3 完成判据

1. configCenter id17 `scope='platform'`、`resolve='system-only'`。
2. `grep "item.scope\\|item.resolve" src/` 确认无运行时 gate 消费（与 id35/39/44/36 同一结论）。
3. configCenter 相关测试全绿；无行为变化。

---

## §4 附：方案 α vs β 对照（已拍板，记录决策）

| 方案 | 动作 | 效果 | 代价 |
|---|---|---|---|
| **α（选定）** | 标签平台级化 | 标签与事实一致；租户仍共用审批流拓扑（平台治理基线定位） | 租户无法定义差异化审批路径（现状如此） |
| β | 加 tenant_id + 复合 PK | 租户可覆写审批流 | 迁移 + 引擎/页面改造，需单独设计（Phase 2 同级工作量） |

> 方案 α 为轻量清理，随本 follow-up 收口；方案 β 留作未来演进路径（用户如需差异化审批流再触发独立 brainstorming）。
