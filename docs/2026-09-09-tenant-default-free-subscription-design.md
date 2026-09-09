# 设计文档：新租户开通默认免费档（Default Free Subscription on Provisioning）

- **状态**：✅ 已批准（2026-09-09 用户拍板）
- **作者**：crm-platform-admin（平台治理助手）
- **关联 Runbook**：`industry-onboarding`（行业上线）/ `system-bootstrap`（系统初始化）
- **对应需求**：用户裁决「所有没有定义的，按缺省 FREE；新增的租户和账号都是 free」

---

## 1. 背景与目的

本会话已手动为 6 个未定义订阅的存量租户回填 `free` 订阅（见 `2026-09-09` 工作记忆）。
为避免后续每次新租户开通都需人工补订阅，将「缺省 Free」固化为**代码级默认**：
新租户经开通入口即自动获得 `free` 订阅，零人工遗漏，且「已定义订阅不覆盖」。

套餐为**租户级**，账号（`crm_users`）无独立套餐字段 → 账号自动继承所属租户套餐，
无需账号级改动。用户口中的「账号 free」即指「账号落在 free 租户下」。

## 2. 决策摘要（已与用户确认）

| 项 | 决策 |
|---|---|
| 落点 | 统一开通入口 `provisionTenant()`（`db/seed/tenantDefaults.js`）—— 所有新租户（行业上线 / 手动建 / 系统引导）一处生效 |
| 周期 | `free` 默认 **3 个月（quarterly）**，对齐手动回填先例 + Free「前三月免费」语义 |
| 状态 | `free` 为免费档，**直接置 `active`**（免支付激活）；不复用 `createSubscription`（它建 `pending`） |
| 幂等语义 | 该租户**无任何订阅行**时插入 free；已有任意订阅（含 acme-chem 的 Starter）→ 跳过不覆盖 |
| 失败策略 | fail-open：订阅写入失败静默跳过，不阻断租户开通（对齐 `seedTenantDefaults` 现有风格） |

## 3. 改动清单（文件级）

### 3.1 `src/billing/subscriptionService.js` — 新增函数
```js
// 确保租户拥有默认订阅（缺省 free）。幂等：仅当该租户无任何订阅行时插入。
export async function ensureDefaultSubscription(tenantId, defaultPlan = 'free') {
  const has = await query(
    `SELECT 1 FROM crm.tenant_subscription WHERE tenant_id=$1 LIMIT 1`, [tenantId]
  );
  if (has.rows.length) return { ok: true, created: false, tenantId };
  const r = await queryWrite(
    `INSERT INTO crm.tenant_subscription
       (tenant_id, plan_id, status, started_at, expires_at, created_at, updated_at)
     VALUES ($1, $2, 'active', now(), now() + interval '3 months', now(), now())
     RETURNING *`,
    [tenantId, defaultPlan]
  );
  return { ok: true, created: true, tenantId, row: r.rows[0] };
}
```

### 3.2 `src/seed/tenantDefaults.js` — 接入开通入口
- 顶部 `import { ensureDefaultSubscription } from '../../src/billing/subscriptionService.js';`
- 在 `seedTenantDefaults()` 注册表登记（`crm.tenants` INSERT）**之后**、`return` 之前，调用：
  ```js
  try { await ensureDefaultSubscription(tenant); }
  catch { /* fail-open：订阅失败不阻断开通 */ }
  ```
- 落点选 `seedTenantDefaults` 而非 `provisionTenant`：因 `provisionTenant` 调它、`seed-all-tenants.mjs` 也调它，双路径覆盖。

### 3.3 `test/billing/ensureDefaultSubscription.test.js` — 新增单测
覆盖：① 无订阅租户 → 插入 free/active + expires=started+3月；② 重跑幂等无新行；③ 已有 Starter 订阅的租户重跑不插 free。

## 4. 函数契约（ensureDefaultSubscription）

| 字段 | 说明 |
|---|---|
| 输入 | `tenantId: string`，`defaultPlan: string='free'` |
| 前置 | 租户已在 `crm.tenants` 注册（开通入口已保证） |
| 行为 | `tenant_subscription` 无该租户行 → 插 free/active/+3月；否则跳过 |
| 返回 | `{ ok, created: boolean, tenantId, row? }` |
| 红线 | 经 `queryWrite`（写池）；绝不 DELETE；失败 fail-open |

## 5. 验收标准（可验证判定式）
1. 临时无订阅租户经 `provisionTenant` → `tenant_subscription` 出现 `free`/`active` 行且 `expires_at = started_at + 3 月`。
2. 重跑 `provisionTenant` → 无新订阅行（幂等）。
3. acme-chem（Starter）重跑 → 不插 free 行（已定义不覆盖）。
4. `test/billing/ensureDefaultSubscription.test.js` 全绿。

## 6. 边界声明
- 本会话已手动补的 6 租户 free 订阅：新函数幂等跳过，**不重复插行**。
- acme-chem Starter 不受影响；付费升级链路（`upgradeSubscription`）完全不受影响。
- 行业上线 Runbook（`industry-onboarding` SKILL）补「新租户经 provisionTenant 自动获 Free」一句 —— 列为独立任务，用 SkillManage 修正，**不在此代码 PR 内**。

## 7. Living Contract（生命契约 · 双轨）

```contract-yaml
- task: "新增 ensureDefaultSubscription 并接入 provisionTenant"
  agent: crm-platform-admin
  skills: [industry-onboarding, system-bootstrap]
  memory: [crm-platform-admin]
  success: "无订阅租户经 provisionTenant 后 tenant_subscription 出现 free/active 行且 expires_at=started_at+3月；重跑幂等无重复行；acme-chem(starter)重跑不插 free"
```

**契约说明：** 本任务由 `crm-platform-admin`（平台治理助手）承接，必须调用 `industry-onboarding` / `system-bootstrap` 流程知识、读取 `crm-platform-admin` 记忆；成功标准为无订阅租户经开通入口后获 free/active 订阅且周期 3 月、重跑幂等、已有 Starter 不覆盖。

> **Registry 说明**：`agentSpec.js` 为 CRM 业务智能体（copilot）roster，`crm-platform-admin` 属治理助手、独立于该 roster，故 P7 自检采用**结构检查**（不加 `--registry`），仅校验 contract-yaml 四字段完整性。

## 8. 闭环回写（待 workbench 监控）

| 任务 | 智能体 | gap 类型 | 观察 | 期望 | 严重度 | 状态 |
|---|---|---|---|---|---|---|
| （暂无） | — | — | — | — | — | — |

## 9. 下一步
移交 `writing-plans` → 生成实施计划（按文件拆 Task，每 Task 一 commit）→ 实施。
