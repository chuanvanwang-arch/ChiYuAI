# 实施计划：RBAC 矩阵配置（B 组第 13 项）

> 设计已批准（2026-08-27，用户回「好」）。本计划按 brainstorming→writing-plans→实现 纪律落盘。

## 1. 目标
为 B 组第 13 项「权限 / RBAC 矩阵（角色×粒子×Action，五角色七要素）」补**配置页 + 端点**，让 `crm.role_context_profile.data_scope` 可经界面读写；引擎 `enforceScope`（`src/context/scope.js:81`）零改动即消费。

## 2. 取证结论（真实数据模型）
| 事实 | 证据 |
|---|---|
| RBAC 载体 = `role_context_profile.data_scope` `{model, domain?}` | `db/schema.sql:217` |
| 判定消费点 = `enforceScope` 第1闸，比对 `profile.data_scope.domain` vs `target.type`（全名 CRM_*） | `src/context/scope.js:10,81,105` |
| 角色 = 6：`sales`(self)/`manager`(org_subtree)/`exec`(all)/`finance`(domain)/`presales`(domain)/`contract_admin`(domain) | `src/context/roleProfiles.js:14-19` |
| 业务可授权粒子（矩阵列，12 个 canonical CRM_*） | `src/particles/particleModel.js` |
| 现状：无端点、无页 | `configCenter.js` 第13卡标 pending |

**关键不一致（已取证，非静默修复）**：种子 `finance`/`contract_admin` 的 `domain` 用短名 `payment`/`contract`/`invoice`，而 `inScopeByModel('domain')` 比对全名 `CRM_*`（scope.js:14），故这两角色 domain 范围当前潜在失效。处理方式：矩阵**列用 canonical CRM_* 名**；读取时 `normalizeDomainEntry` 把已知短别名映射回 CRM_*（显示正确）；**保存（PUT）写入 canonical 名**，用户重存即修正种子不一致。不在 seed 层静改。

## 3. 架构（YAGNI）
- **新建** `src/http/rbacRouter.js`：表驱动端点，复用 `businessTierRouter` 范式（`router.handlers` 暴露 + 决策第0闸 + 无 DELETE）。
  - `GET /api/rbac` → `{profiles:[{role_tag,data_scope}], particles:[业务CRM_*类型]}`
  - `PUT /api/rbac` → body `{role_tag, model, domain?}`；UPSERT `role_context_profile`；写经第0闸 `produceDecision`。
- **新建** `src/portal/rbacMatrix.js`：纯函数 `renderRbacMatrix(profiles, particles)` + `scopeModelLabel(model)` + `cellState(profile, particle)` + `normalizeDomainEntry(s)` + `BUSINESS_PARTICLES`。浏览器/vitest 共用，可 TDD。
- **新建** `src/web/rbac.html`：矩阵表格（行=6角色，列=12业务粒子）+ 每行 model 下拉 + domain 单元格勾选 + 确认保存（PUT）。
- **改** `src/portal/configCenter.js`：第13卡 `pending→ready` + `page:'/rbac.html'`。

## 4. 矩阵三态规则（cellState）
- `model='all'` → 整行 ✓（单元格禁用勾选，灰显「全部」）。
- `model='self'`/`org_subtree'` → 整行 ⚪受限（灰显「仅自身/组织内」），不展示勾选。
- `model='domain'` → 单元格可勾选；勾选 = 该粒子在 `normalizeDomainEntry(domain)` 集合内 → ✓，否则 —。

## 5. 改动文件
| 文件 | 动作 | 内容 |
|---|---|---|
| `src/http/rbacRouter.js` | 新 | GET/PUT + handlers 暴露 + 第0闸 |
| `src/portal/rbacMatrix.js` | 新 | 矩阵渲染纯函数 + 常量 + 归一 |
| `src/web/rbac.html` | 新 | 矩阵配置页（勾选+下拉+确认） |
| `src/http/routes.js` | 改 | 挂载 rbacRouter + `/rbac.html` 别名 + `/portal/rbacMatrix.js` |
| `src/portal/configCenter.js` | 改 | 第13卡 pending→ready + page 链接 |
| `test/web/rbacMatrix.test.js` | 新 | render + 三态 + 归一 + handler |
| `docs/superpowers/plans/2026-08-27-rbac-matrix.md` | 新 | 本计划 |

## 6. 测试（TDD）
- `renderRbacMatrix`：6×12 → 含 role_tag 与三态单元格；`scopeModelLabel` 四 model 文案；`model='all'` 整行 ✓ 禁用；`normalizeDomainEntry('payment')=CRM_PAYMENT_RECORD`。
- handler：注入假 deps，GET 返 profiles+particles，PUT upsert 触发 produceDecision；缺 role_tag→400。
- RED→GREEN。

## 7. 范围边界
仅 RBAC 数据范围矩阵（data_scope）配置；不含七要素/retrieval_cfg 编辑、角色增删、exec 角色改名、Action×role 细粒度授权（当前 Action 全局 `permission:'auth'`，超出本期）。

## 8. 提交约定
每 Task 一 commit（沙箱无凭证，用户本地提交）。
