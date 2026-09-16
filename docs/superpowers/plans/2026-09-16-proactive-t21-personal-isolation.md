# T21 信号个人隔离（含管理视角例外）实施计划

> 触发：2026-09-16 用户指令「除管理外，需要进行个人隔离！」
> 上游审计：`crm.signal` 204 行跨 9 租户、`owner_id` 非空 = **0** → 同租户内所有销售员看到同一张表（无个人隔离）。
> 常量：TDD（红→实现→绿）；每任务一 commit；零 DELETE；写路径不新增（本计划只收紧读 + 补 owner 落库）。
> 硬约束：**服务端强制**——普通用户的个人收窄不可被任何请求参数绕过（不信任前端）。

## 0. 语义定义（本计划的唯一事实源）

| 概念 | 定义 |
| ---- | ---- |
| `owner_id` | 信号**责任人**（`crm_users.username`）。谁该处理这条信号。NULL = 无主（广播/待认领） |
| `target_role` | 信号目标角色（sales/manager/finance/exec/ops）。无主信号的可见面 |
| 管理 | `role ∈ {admin, sysadmin}` |

### 可见规则（最终）

| 视图者 | 租户范围 | 个人范围 |
| ------ | -------- | -------- |
| admin / sysadmin | `*`（全部；可 `?tenant=` 收窄） | 不做个人隔离（管理视角=看全部人）；可 `?mine=1` 主动收窄到自己 |
| 其他角色 | 自身租户（`?tenant=` 被忽略） | **仅 `owner_id = 我` 或无主但同角色广播** |

普通用户的 SQL 附加谓词（唯一形态）：

```sql
AND ( owner_id = $me
      OR ( owner_id IS NULL AND target_role = $myRole ) )
```

**为什么保留「无主 + 同角色」**：
1. 公海类信号（`s0_stale`）语义就是「无主待认领」——按角色广播是正确语义，把它屏蔽反而是信息丢失；
2. 团队级巡检信号（`target_role='manager'`）只应经理可见，角色谓词正好承担；
3. 历史 204 行 `owner_id` 全 NULL——若连无主都屏蔽，普通用户会看到空表（看似故障），且无法过渡；
4. **有主信号严格隔离**——这正是本次要修的核心（`visit_shortfall`/`info_collect_lag` 这类「某人的拜访量不达标」不该广播给全租户）。

## 1. 现状核验（改前实证，非推断）

| 层 | 位置 | 现状 | 缺口 |
| -- | ---- | ---- | ---- |
| 查询 | `src/signal/store.js:60-74` | `list` 只按 tenant/status/kind/severity | **无 owner 谓词** |
| HTTP 读 | `src/http/routes.js:364-376` | `applyTenantOverride` 只收窄租户 | 无个人收窄 |
| 工作台 | `src/http/workbenchRouter.js:87` | `store.list({tenant_id: scopeTenant(actor)})` | 同上 |
| 产生 | `src/signal/scheduleScanner.js:39-46` | **丢掉了 `entity.payload.owner_id`** | owner 未落库 |
| 产生 | `src/signal/prospectScanner.js:43-45` | 未传 owner | 同上 |
| 产生 | `src/signal/researchScheduler.js:33-36` | 未传 owner | 同上 |
| 产生 | `src/signal/followupEngine.js:14-19` | 未传 owner | 同上 |
| 产生 | `src/alerts/alertSignalHook.js` | 已透传 `payload?.owner_id`（`router.js:15`） | 告警侧 payload 本身多无该键（另案） |
| UI | `src/web/signal-center.html:167-210` | 无「我的/全部」概念 | 需开关 + 角色提示 |

## 2. 任务分解

### T21-1 查询层：`signalStore.list` 增加 ownerScope
- `src/signal/store.js`：`list({ tenant_id, status, kind, severity, ownerScope = null })`
  - `ownerScope = { username, role }` → 追加谓词 `(owner_id=$n OR (owner_id IS NULL AND target_role=$m))`
  - `ownerScope = null` → 不追加（admin 全量）
- `test/signal/store.test.js` 新增用例：我的（见）/ 他人的（不见）/ 无主同角色（见）/ 无主异角色（不见）/ null（全见）。

### T21-2 数据层：4 个产生点补 `owner_id`
- `scheduleScanner.js`：`owner_id: entity.payload?.owner_id || null`
- `prospectScanner.js`：`owner_id: payload.owner_id || null`（S0P 有主；S0 无主→null）
- `researchScheduler.js`：`owner_id: obj.payload?.owner_id || null`
- `followupEngine.js`：`owner_id: ref?.owner_id || null`（resolver 未给则 null，不臆造）
- 各文件同目录测试补断言（owner 落库）。

### T21-3 HTTP 层：`GET /api/signals` 服务端强制
- `src/http/routes.js`：计算 `ownerScope`
  ```js
  const isAdmin = me.role === 'admin' || me.role === 'sysadmin';
  const wantMine = req.query.mine === '1';
  const ownerScope = (isAdmin && !wantMine) ? null : { username: me.username, role: me.role };
  ```
  响应追加 `meta: { owner_scope: ownerScope ? 'self' : 'all', enforced: !isAdmin }`
- `test/http/signalIsolation.test.js`（新建，真 express + mock resolveMe）：普通用户只回自己的；admin 全量；`?mine=1` 收窄；**普通用户伪造 `?mine=0` 仍被强制收窄**（鉴别力关键用例）。

### T21-4 工作台视角：`querySignals` 同规则
- `src/http/workbenchRouter.js:82-88`：按 actor 角色决定 ownerScope（admin null / 其他 self）
- 测试：`test/http/workbench*.test.js` 或新增用例。

### T21-5 UI：signal-center 加「只看我负责的」
- `src/web/signal-center.html`：读 `meta` 渲染
  - `enforced=true` → 显示灰字「仅显示我负责的信号」（开关禁用）
  - `enforced=false` → 复选框「只看我负责的」（默认关），勾选 → `?mine=1`
- `test/web/signalCenterPage.test.js` 补守门断言（含变异对照）。

### T21-6 索引与迁移
- `db/schema.sql`：`CREATE INDEX IF NOT EXISTS idx_signal_owner ON crm.signal(tenant_id, owner_id, created_at DESC)`
- `db/migration-signal-owner-index.sql`（幂等）+ `db/migrate.js` 注册。

## 3. 红线

1. **不新增粒子类型**；不改 `crm.signal` 列（`owner_id` 已存在）。
2. **写路径不变**：`scopeOf(me)` 恒自身租户（写不跨租户）保持不动。
3. **管理员的读/写作用域不匹配**（admin 跨租户读但写自身租户 → `signal_not_found`）**不在本计划范围**，维持现状，另行决策。
4. 服务端强制：普通用户任何参数都不得放宽个人收窄。
5. 无主信号 **不**视为「无权访问」而从个人视图抹除——按角色广播保留。

## 4. 验收

- `crm.signal` 中带 `owner_id` 的信号：非责任人查询不到（真库断言）。
- 普通用户 HTTP 拉取：仅含自己 + 无主同角色。
- admin HTTP 拉取：跨租户全量；`?mine=1` 收窄。
- 页面：普通用户见「仅显示我负责的」提示；admin 见开关。
- 产生点：新产信号 `owner_id` 正确落库（以粒子 payload 为准）。

---

## 5. 实施记录（2026-09-16 完成）

### 5.1 交付清单

| 任务 | 交付物 |
| ---- | ------ |
| T21-1 | `src/signal/store.js` — `list({ ownerScope })` 谓词（`typeof username === 'string'` 类型闸 = fail-closed） |
| T21-1 | `test/signal/store.test.js` +4 用例（我的 / 他人不可见 / 无主同角色 / 缺省全量 / 叠加筛选） |
| T21-2 | `scheduleScanner.js` / `prospectScanner.js` / `researchScheduler.js` / `followupEngine.js` 四产生点补 `owner_id` |
| T21-2 | 三处测试补**入参断言**（防「传了参数但静默丢弃」——原实现正是此病） |
| T21-3 | `src/http/tenantScope.js` — 新增 `signalOwnerScope(me,{mine})` 单一事实源 |
| T21-3 | `src/http/routes.js` — `GET /api/signals` 服务端强制 + `meta{owner_scope,enforced,viewer}` |
| T21-4 | `src/http/workbenchRouter.js` — 第 7 视角 `querySignals` 同源收窄 |
| T21-3/4 | `test/http/signalOwnerScope.test.js`（新建，13 用例）：纯函数语义 + 接线静态守卫 + 真库串联 + 索引守卫 |
| T21-5 | `src/web/signal-center.html` — `filter-scope`（全租户/只看我的）+ `applyScopeUi(meta)` + 提示带视图者 |
| T21-5 | `test/web/signalCenterPage.test.js` +3 守门断言 |
| T21-6 | `db/migration-signal-owner-index.sql` + `db/schema.sql` + `db/migrate.js` 注册（`idx_signal_owner`） |

### 5.2 实施中发现的两个真问题（均已修）

**① 两处调用点身份形状不同（差点造成工作台侧静默失效）**
- HTTP 侧 `resolveMe` → `{ username, role }`（单数）
- 工作台侧 `currentActor` → `{ username, roles: [me.role] }`（复数数组）
- 若只读 `me.role`：工作台侧取到 `undefined` → `role = null` → `target_role = NULL` 永假
  → 普通销售员连「无主同角色广播」都看不到（**过度收窄**，与 HTTP 侧行为不一致，且不会有任何报错）
- 修法：`signalOwnerScope` 内归一为 `roles` 数组；`test/http/signalOwnerScope.test.js` 增「兼容工作台 actor 形态」用例锁死。

**② 类型闸 vs 真值判断（防"静默放宽成全量"）**
- `if (ownerScope.username)` 在 username 为空串时判假 → 不加谓词 → **退化为全量视界**（泄漏方向）
- 改为 `typeof ownerScope.username === 'string'`：空串仍追加谓词 → 匹配 0 行 = fail-closed。

### 5.3 验证证据

**真库端到端取证**（测试库唯一租户，跑完即清理；穿替身、穿扫描器）：

```
scanner 产出 signals = 2
落库: [{"kind":"s0_stale","owner_id":null},{"kind":"s0p_recycle_warn","owner_id":"alice"}]
alice(sales) 可见: ["s0_stale(无主)","s0p_recycle_warn(alice)"]
bob(sales)   可见: ["s0_stale(无主)"]          ← 看不到 alice 的信号 = 隔离生效
adm(admin)   可见: ["s0_stale(无主)","s0p_recycle_warn(alice)"]  ← 管理例外
```

**变异测试**（守卫鉴别力双向验证）：
- 断开 `routes.js` 的 `ownerScope` 传参 → 2 条接线守卫红；还原 → 11/11 绿。

**回归**：T21 相关 18 套件全绿；索引 `idx_signal_owner` 在测试库确认存在。

### 5.4 未纳入本计划（维持现状，需另行决策）

- 管理员的读/写作用域不匹配（跨租户读但写自身租户 → `signal_not_found`）——见上轮 A/B/C 选项。
- 告警侧 `payload.owner_id` 多数缺失（`alertSignalHook` 已透传，但告警产生点本身未带 owner）→ 行为巡检类信号（`visit_shortfall`/`info_collect_lag`）仍是无主广播。这是**下一步**的补数据工作。

