# 租户管理操作台设计：冻结 / 延期 / 退订 / 改套餐 / 行业画像分配

- 日期：2026-09-09
- 状态：待批准（brainstorming 产出，未批准不写实现）
- 关联：`docs/2026-09-04-tenant-billing-page-design.md`（billing.html 订阅页）、`docs/2026-09-04-tenant-subscription-billing-design.md`
- 决策记录：
  - 冻结生效面 = **方案 A**（拦新登录 + 停定时任务，存量 token 自然过期）——用户 2026-09-09 批准
  - 行业画像管理纳入 = **方案 A 最小集**（只读列 + 分配/更换，不做在线编辑器）——用户 2026-09-09 批准
  - 动作集 = 冻结/解冻、延期、取消/退订、改套餐、行业画像分配（用户 2026-09-09 多选批准）

---

## §0 范围与红线

**做**：在 `admin-billing-console.html`「租户订阅」tab 增加 5 类管理动作 + 行业画像列；后端新增 6 个管理端点；TDD 先行。

**红线（不可违背）**：
1. **禁物理 DELETE**：全部写操作为 UPDATE/INSERT；退订 = 软退订（status 置位 + 时间戳）。
2. **写操作过决策第 0 闸**：每个写端点先 `produceDecision({scenario_id:'config_change', fields:[...]})` 落真实决策行（对齐 `src/http/tenantRouter.js:81-82` 建租户惯例）。
3. **system 租户保护**：对 `tenant_id='system'` 的 freeze/cancel/change-plan/assign-profile 一律 400 硬拒。
4. **权限双保险**：页面 JS guard（既有）+ API `isPrivileged`（admin/sysadmin），非特权 403。
5. **行业差异化零代码**：行业画像 = 纯 config_store 数据（`tenant-profile`），不新增粒子类型字面量、不加域。
6. **不动 resolveMe / auth 热路径**（冻结生效面 = 方案 A 的直接推论）。

---

## §1 现状事实（代码级锚点）

| 事实 | 位置 | 对本设计的影响 |
|---|---|---|
| 登录闸已拒 `suspended/retired` 租户 | `src/http/auth.js:45-50` | 冻结/退订后新登录即被拒，**无需新增切断逻辑** |
| `resolveMe` 只验 token，不查租户状态 | `src/http/auth.js:57-66` | 方案 A：存量 token 自然过期，不改 |
| 定时任务只跑 `status='active'` 租户 | `src/scheduler/timers.js:186` | 冻结后巡检/派发自动跳过 |
| Repo 已支持按 status 查询 + 三时间戳 | `src/tenant/tenantRepo.js:25` | 读侧零改动 |
| `crm.tenants` 已有 `status/suspended_at/retired_at` 列 | `db/schema.sql`（建表） | **无需改表** |
| `crm.tenant_subscription` 列：`plan_id,status,started_at,expires_at,grace_until,upgraded_from,...` | information_schema 核实（2026-09-09） | 延期/改套餐落此表 |
| 行业画像 = `crm.config_store (tenant_id,'tenant-profile')`，`value.prototypes` 为**对象映射**（type→{flow,label,attributes}），无 `industry` 字段 | 本地库实测 2026-09-09；消费点 `src/particles/particleModel.js:343,365`、`src/calc/formulaEngine.js:34` | 行业概要从 prototypes 派生；分配时补写 `value.meta` |
| 行业模板现存 7 份 seed：chemical/training/meddev/insmedi/demo/consult/consult2 | `db/seed/tenant-profile-*.js` | 需沉淀为 system 模板行（§4.6） |
| 订阅 tab 现为只读全景，10 列无操作 | `src/web/admin-billing-console.html:272-316`（loadSubs） | 加 2 列 + 操作列 |

---

## §2 后端 API 设计（`src/http/billingRoutes.js` 追加）

统一约定：全部 `router.post('/api/billing/tenant-admin/<action>')`；先 `isPrivileged`（403）；再第 0 闸 `produceDecision`；再写库；全部幂等（重复执行返回 `ok:true, noop:true`）。

### §2.1 冻结 `freeze` `{tenantId, reason?}`
```sql
UPDATE crm.tenants SET status='suspended', suspended_at=now() WHERE tenant_id=$1 AND status='active';
```
- 已 retired → 400（终态不可冻结）；system → 400；status 已是 suspended → noop。
- 生效面：登录闸 + 定时任务自动切断（§1 事实），存量 token 自然过期（方案 A）。

### §2.2 解冻 `unfreeze` `{tenantId}`
```sql
UPDATE crm.tenants SET status='active', suspended_at=NULL WHERE tenant_id=$1 AND status='suspended';
```
- retired 不可解冻（400）；active → noop。

### §2.3 延期 `extend` `{tenantId, days}`
- `days` 整数限值 `[1, 365]`，越界 400（可选数值参数铁律：先判 `days!=null` 再 Number，禁静默置 0）。
- 取该租户最新 `tenant_subscription` 行（active/grace）：`expires_at = expires_at + days`；无订阅行 → 400（延期对象不存在，提示先订阅）。
- 落库同时 `updated_at=now()`；决策 fields 记 `tenant:<id> extend:<days>d`。

### §2.4 退订（软） `cancel` `{tenantId, reason?}`
```sql
UPDATE crm.tenants SET status='retired', retired_at=now() WHERE tenant_id=$1 AND status IN ('active','suspended');
UPDATE crm.tenant_subscription SET status='cancelled', updated_at=now()
 WHERE tenant_id=$1 AND status IN ('active','grace');
```
- system → 400；已 retired → noop。数据全保留（禁删铁律）。

### §2.5 改套餐 `change-plan` `{tenantId, planId}`
- `planId` 必须存在于 `config_store['billing-plans']` 档位（`readThreshold`/`readConfig` 校验），否则 400。
- 写序（单事务）：
  1. `UPDATE crm.tenants SET plan=$2`；
  2. 旧 active 订阅行置 `status='upgraded'`；
  3. `INSERT crm.tenant_subscription (tenant_id, plan_id, status='active', started_at=now(), expires_at=now()+interval '1 month', upgraded_from='admin-grant')`。
- `upgraded_from='admin-grant'` 作为管理员改套餐标记（免支付通道，区别于网关订阅）。

### §2.6 行业画像分配 `assign-profile` `{tenantId, templateId}`
- 模板源 = `crm.config_store (tenant_id='system', key='tenant-profile-template-<templateId>')`（§4.6 沉淀）；模板不存在 → 400。
- 写序（单事务）：
  1. 克隆模板 value，注入 `value.meta = {template_id, industry_label, assigned_at, assigned_by}`；
  2. upsert `(tenant_id=<目标>, key='tenant-profile')`（`ON CONFLICT (tenant_id,key)`，对齐复合 PK 现状）。
- 对齐铁律「system 只作模板源、租户=覆盖」；分配是整体替换（旧画像被覆盖前其内容已由模板行+决策行可追溯，决策 payload 存旧 value 摘要）。
- system 自身 → 400。

### §2.7 模板清单 `GET /api/billing/tenant-admin/profile-templates`
- 返回 `[{template_id, industry_label, prototype_count, assigned_tenants}]`（只读，特权校验同上）。
- `tenant-subscriptions` 端点响应增补每行 `profile_summary`（industry_label / 自定义、prototype 类型数），从 config_store 一次批量读出（避免 N+1）。

---

## §3 前端设计（`src/web/admin-billing-console.html`「租户订阅」tab）

1. **表头 10 列 → 12 列**：新增「行业」（profile_summary.industry_label，无画像显「—」）与「操作」列。
2. **操作列按钮组**（`crm-button` 小尺寸）：冻结/解冻（按行状态二选一显示）、延期、改套餐、退订、分配画像。retired 行只显「已退订」徽标，无按钮。
3. **交互**：
   - 冻结/解冻/退订：确认弹窗（退订为危险动作，弹窗需**勾选「我已知晓数据将保留但租户立即停用」**后确认按钮才可用）；
   - 延期：天数输入（1–365）；
   - 改套餐：档位下拉（数据源 `GET /api/billing/plans`，禁硬编码）；
   - 分配画像：模板下拉（`GET /api/billing/tenant-admin/profile-templates`）+ 红字提示「将覆盖该租户现有行业画像」。
4. 操作成功后重载 `loadSubs()`；失败以行内红字展示 API error。
5. 遵守 UI 铁律：写前读 `docs/specs/2026-09-05-ui-authoring-rules.md`，提交前 `node scripts/ui-lint.mjs`（不加排除名单）。

---

## §4 数据与迁移

### §4.1 模板沉淀（唯一迁移项）
- 新脚本 `db/seed/tenant-profile-templates.mjs`：把 7 份行业画像 upsert 到 `(tenant_id='system', key='tenant-profile-template-<id>')`（id=chemical/training/meddev/insmedi/demo/consult/consult2，`ON CONFLICT (tenant_id,key)` 幂等），并在 value 注入 `meta.industry_label`（中文名取自各 seed 文件语义，已核实：chemical=化工、training=培训、meddev=医疗器械、insmedi=仪器医疗（注册资本/器械流通画像，实施时以文件头注释定名）、demo=演示、consult=企业管理咨询、consult2=咨询变体）。
- ESM 铁律：脚本先设 `PGDATABASE` 再 `await import`；密码走 pgcrypto 惯例；直连 `SET search_path TO crm,public`。

### §4.2 无表结构变更
`crm.tenants` / `crm.tenant_subscription` / `crm.config_store` 现有列均够用；`db/schema.sql` 不动。

---

## §5 测试计划（TDD，先写后红再绿）

新文件 `test/billing/tenantAdmin.test.js`，独立 HTTP 实例（`PORT=3100` 避让 3000；改 src 后必须重启实例）：

| # | 用例 | 断言 |
|---|---|---|
| T1 | 非特权用户调任一写端点 | 403 |
| T2 | freeze/extend/cancel/change-plan/assign-profile 作用于 system | 400 + 无决策行 |
| T3 | freeze 后该租户用户 login | 401（租户已停用） |
| T4 | unfreeze 后 login | 200 |
| T5 | extend days=0 / null / 400 / 'abc' | 400（含 null 不静默置 0） |
| T6 | cancel 后 | tenants.status='retired' 且订阅行 status='cancelled'，行数不减少（禁删） |
| T7 | change-plan 合法档位 | tenants.plan 更新 + 新订阅行 `upgraded_from='admin-grant'`；非法档位 400 |
| T8 | assign-profile | 目标租户 tenant-profile 出现模板 prototypes + meta.template_id；二次分配幂等；决策行 payload 含旧画像摘要 |
| T9 | 每个写动作 | `produceDecision` 落 decision 行（scenario_id='config_change'） |
| T10 | tenant-subscriptions | 响应含 profile_summary；含已冻结/已退订租户行 |

回归：既有 billing 套件全绿 + `node scripts/verify-billing-gates.mjs` + `node scripts/ui-lint.mjs`。

---

## §6 明确不做（范围外）

- prototypes 在线编辑器（行业画像内容编辑）→ 后续单独立项；
- 冻结即时踢出（resolveMe 每请求校验 / TTL 缓存，即 brainstorming 方案 B/C）→ 需求出现再升；
- 物理删除租户 / 数据（永久红线）；
- 单租户多画像叠加（现设计为单 profile 整体替换；多行业共存可在一 profile 的 prototypes 内声明，属内容层操作）；
- billing.html（租户自助页）任何改动——本设计仅管理面。

---

## §7 实施切分（批准后进 writing-plans）

| Task | 内容 | 交付 |
|---|---|---|
| T1 | 模板沉淀脚本 + `profile-templates`/`profile_summary` 只读面 | 脚本 + 2 端点 + 单测 |
| T2 | 5 写端点（第0闸+幂等+system 保护） | 端点 + 单测 T2/T5/T6/T7/T8/T9 |
| T3 | 前端 12 列 + 5 操作 + 弹窗 | HTML + ui-lint 绿 |
| T4 | 冻结链路 E2E（登录 401 验证）+ 全量回归 | E2E 脚本 + 回归报告 |
