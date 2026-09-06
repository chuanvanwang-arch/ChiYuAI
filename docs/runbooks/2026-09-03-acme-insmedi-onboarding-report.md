# 新行业上线 · 运维验证报告 — 讲师资源型渠道中介行业（acme-insmedi）

> 由 `new-industry-onboarding` SKILL 驱动执行 · 2026-09-03 · 操作人：AI（沙箱，零信任 HITL 授权后落生产）
> 关联 Runbook：`docs/runbooks/2026-09-03-new-industry-onboarding.md`

## 0. 摘要

| 项 | 值 |
|---|---|
| 行业 | 讲师资源型渠道中介 |
| 租户 ID | `acme-insmedi` |
| 初始销售员 | **`insmedi_sales01`** |
| 初始密码 | **`Insmedi@2026!`**（首次登录后须改密） |
| 角色 / token.tenantId | `sales` / `acme-insmedi` |
| 测试结论 | insmedi 专属 **12/12**；integration 总 **28/28**（含 chem/training） |
| 生产落库 | ✅ 6 用户；`config_store.tenant-profile` 含 `acme-insmedi` |
| 切换方式 | **登录即切换租户**（前端无行业切换器；租户由登录 token 决定，各页经 `scopeTenant` 自动隔离） |

## 1. 上线范围（Runbook Step 1–9 对照）

| Step | 内容 | 产物 | 证据 |
|---|---|---|---|
| 1 | 隔离迁移（tenant_id 迁移 SQL） | `db/migrations/2026-09-03-tenant-isolation.sql` | 已落地（schema 含 `crm_users.tenant_id`） |
| 2 | 声明 tenant-profile 配置画像 | `db/seed/tenant-profile-insmedi.js` | 6 原型 + 审批域 + on_write 公式 |
| 3 | 双源原型解析（profile 优先于 PARTICLE_TYPES 字面量） | `particleModel.resolvePrototype()` | 本租户认得 6 原型，crm 租户不认得 |
| 4 | 真实写通道建粒子 | `actionExecutor.dispatch('crm-import-batch')` | 经 `gateway.js:150` 路由，决策第 0 闸生效 |
| 5 | 受控谓词 | `refers` / `teaches` | 本租户认得、crm 租户不认得（隔离验证） |
| 6 | 字段可见性（meta_attr 合并 system 基线） | `listMetaAttr` | 行业属性存 payload JSONB，天然隔离 |
| 7 | AI Fill 草稿 | `proposeAiFill({prototype, rawContext})` | 仅产草稿，不直写 |
| 8 | 回归 | vitest | insmedi 12/12，integration 28/28 |
| 9 | 初始销售员 | `db/seed/tenant-users-insmedi.js` | `insmedi_sales01` / `Insmedi@2026!` |
| 10 | **最终交付物** | 凭据 | 见 §0 表 |

## 2. 配置画像明细（`db/seed/tenant-profile-insmedi.js`）

**6 个原型（全部配置化声明，零代码、零新增字面量）：**
- `INSMEDI_CLIENT` 企业客户
- `INSMEDI_CHANNEL` 渠道伙伴
- `INSMEDI_INSTRUCTOR` 讲师资源
- `INSMEDI_PROJECT` 培训项目
- `INSMEDI_CONTRACT` 合同
- `INSMEDI_SETTLEMENT` 结算

**审批域：** `quote` / `contract` / `settlement`

**on_write 公式（写时计算，L2）：**
```
channel_commission = project_revenue × channel_commission_rate
```
验证用例：`project_revenue=100000, channel_commission_rate=0.15 → channel_commission=15000`（见 §3 测试）。

**零污染声明：** 未触碰 `PARTICLE_TYPES`（`particleModel.js`）、`S_STAGES`（`stageTaxonomy.js`）、`BIZ_DOMAIN`（`seed-actions.js`）任何行业字面量——符合「行业差异化 100% 后台配置化」铁律。

## 3. 测试证据（测试库 `crm_native_test`）

```
 RUN  v3.2.7
 ✓ test/integration/insmedi-tenant-runbook-validation.test.js (8 tests)
 ✓ test/integration/insmedi-sales-user.test.js          (4 tests)
 Test Files  2 passed (2)
      Tests  12 passed (12)
```
- `insmedi-tenant-runbook-validation.test.js`（8）：逐节对照 Runbook §1–§9（原型解析 / 真实写通道 / 受控谓词隔离 / 字段可见性 / AI Fill 草稿 / on_write 公式=15000 / 决策第0闸 / 回归）。
- `insmedi-sales-user.test.js`（4）：登录成功 + 角色 `sales` + `token.tenantId=acme-insmedi` + 错误密码拒绝 + 零跨租户泄漏。
- 全量 integration 回归 **28/28**（含化工 chem / 培训 training，无回退）。

## 4. 生产落库验证（生产库 `crm_native`，经用户 HITL 授权）

`scripts/probe-prod-users.mjs` 实测：
```
TOTAL_USERS: 6
insmedi_sales01 | sales | 讲师资源型渠道中介行业初始销售员 | acme-insmedi | enabled
TENANT BREAKDOWN: system×4, acme-chem×1, acme-insmedi×1
```
`config_store` 原型配置：
```
PROFILE_ROWS: [{acme-chem, tenant-profile}, {acme-insmedi, tenant-profile}]
```
→ 生产库已具备 `acme-insmedi` 的 tenant-profile 与初始销售员，`/users.html` 可见 `insmedi_sales01` 并可用 `Insmedi@2026!` 登录。

## 5. 访问与运维

- **切换行业 = 切换登录账号**：前端无「行业切换」组件（菜单 `src/portal/layoutMenu.js` 为角色驱动；`src/portal/businessBoard.js:112`、`approvalFlow.js:85` 经 `scopeTenant(actor)` 自动按 `token.tenantId` 隔离）。用 `insmedi_sales01` 登录即进入 `acme-insmedi` 租户，与其它租户零交叉。
- **改密**：初始密码为强制定期改密策略，首次登录后须修改。
- **再跑 / 回滚**：`node db/seed/seed-all-tenants.mjs`（幂等，已存在跳过；写配置 + 用户，不 DELETE/UPDATE 既有行）。

## 6. 红线符合性

| 红线 | 符合 |
|---|---|
| 行业差异化 100% 配置化，零 `PARTICLE_TYPES`/`S_STAGES`/`BIZ_DOMAIN` 字面量污染 | ✅ |
| 绝对禁 DELETE（种子用 upsert/幂等 INSERT；软停用走 `meta.merged_into`） | ✅ |
| 写操作必经决策第 0 闸（`gateway.js` → `actionExecutor.dispatch`） | ✅ |
| 多租户隔离（`tenant_id` 贯穿 users/particles/config_store） | ✅ |
| 业务数值禁硬编码（公式/阈值走 config） | ✅ |
| 生产落库经用户显式 HITL 授权 | ✅ |

## 7. 交付清单（均新增、尚未 commit；沙箱无 git 凭证，由用户提交）

```
db/seed/tenant-profile-insmedi.js               # 行业画像（零代码、零污染）
db/seed/tenant-users-insmedi.js                 # 初始销售员种子
db/seed/seed-all-tenants.mjs                    # chem+insmedi 完整幂等播种器（配置+用户）
test/integration/insmedi-tenant-runbook-validation.test.js   # 8 测试
test/integration/insmedi-sales-user.test.js                  # 4 测试
.workbuddy/skills/new-industry-onboarding/SKILL.md          # §15 调用示范
Lanch/SKILL/new-industry-onboarding/SKILL.md                # 同步副本
docs/runbooks/2026-09-03-acme-insmedi-onboarding-report.md  # 本报告
```

**建议提交：**
```
git add db/seed/tenant-profile-insmedi.js db/seed/tenant-users-insmedi.js db/seed/seed-all-tenants.mjs \
        test/integration/insmedi-tenant-runbook-validation.test.js test/integration/insmedi-sales-user.test.js \
        .workbuddy/skills/new-industry-onboarding Lanch/SKILL/new-industry-onboarding \
        docs/runbooks/2026-09-03-acme-insmedi-onboarding-report.md
git commit -m "feat(industry): 开通讲师资源型渠道中介行业 acme-insmedi（含测试+运维验证报告）"
```
