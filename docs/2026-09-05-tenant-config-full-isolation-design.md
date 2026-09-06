# 租户级后台设置 · 完全隔离 + 权限控制设计

- 日期：2026-09-05
- 状态：待用户批准（P5 批准闸未过，此前为 P1 审计 + P3 方案）
- 决策人：王川（用户）
- 依据：用户 2026-09-05 明确要求"完全独立不共享""自动落出厂默认""system 只作出厂模板不再回退""存量租户立即 backfill""G3/G4/G5 一并修复""system 保留作模板源"

## 0. 背景与目标

用户在配置中心新增「租户级」分组后提出三连问：①后台设置每个租户单独保存吗？②数据互相不污染吗？③权限控制是否闭环？
并要求「完全分开与隔离＋权限控制＋各租户设置仅本租户生效」。

本设计以代码审计 + 环境实证为主线，先回答三连问，再给出彻底隔离的改造方案。

## 1. 审计结论（代码级 + 环境实证）

### 1.1 已正确隔离（现状，无需改动）

| 分层 | 机制 | 证据 |
|---|---|---|
| 存储主键 | config_store 主键 `(tenant_id, key)` | `db/migrate-tenant.js:22-23` |
| 读写分派 | 读按 `scopeTenant(me)`（admin 通配'\*'→回退 system）；写按 `scopeOf(me)`（永不通配） | `configRouter.js:67-68` |
| 决策场景消费 | `autonomyEngine.js:119` 查 `(scenario_id, tenant_id)` 租户专属→回退 system | 决策链路隔离 |
| 粒子数据 | `queryParticles` 按 tenant_id 过滤，admin 通配 '\*' | `particleRepo.js:158-173` |
| 阈值/行为标准 | `salesThresholdsRouter.js:97/123` 读 `scopeTenant(me)` 写 `scopeOf(me)` | 已按租户 |
| 本体词汇 | #22 已移租户级，tenant_id 隔离 | 前序任务完成 |
| RBAC 权限闸 | level=tenant → 三角色闸（ten_admin/sysadmin/ADMIN） | `configRouter.js:70-90` |

### 1.2 确认的缺口（需修复）

| 缺口 | 位置 | 影响 |
|---|---|---|
| G1 运行时仍回退 system | `configStore.js:10-23` | 租户未配置键→用 system 基线，租户无法真正独立 |
| G2 approval-config 消费硬编码 system | `approvalConfig.js:59` | 租户改了审批参数不生效 |
| G3 alert_rule 无 tenant_id 列 | `crm.alert_rule` 表 | id21 声明租户级但物理无隔离 |
| G4 pool-config 写死 system | `routes.js:723` | id20 声明租户级实际全局共享 |
| G5 decision-scenarios 写侧无租户 | `decisionScenario.js:166-196` | 租户改决策场景落 system |
| G6 种子基线缺租户播种 | 无 per-tenant 播种逻辑 | 新租户无默认配置 |

### 1.3 环境实证（crm_native 实测）

```
config_store 按租户：system:14 / acme-chem:3 / acme-demo:2 / acme-insmedi:3 / acme-training:3 / co-036cq4k:1
关键配置键：approval-config/context-routing/decision-retro 仅 system；sales-thresholds 已分散到 4 租户
decision_scenario：全在 system（13）
alert_rule 列：无 tenant_id（物理无隔离）
particles：system:243 / acme-chem:61 / acme-demo:69 / acme-insmedi:55 / acme-training:58
CRM_APPROVAL_FLOW 粒子：全在 system（10）
```

结论：存储已按租户，但**缺 per-tenant 播种 + 三处消费/表未闭环**。

## 2. 方案设计（3 候选）

| 方案 | 说明 | 优缺点 |
|---|---|---|
| **A：物理双写+播种对齐（推荐）** | readConfig 缺租户键自动落出厂默认；新租户 onboarding 播种；存量租户 backfill；G2-G5 一并修 | 彻底、透明、可持续；需新播种+backfill |
| B：仅改消费链路 | 只改 approvalConfig/pool 读租户值，不做自动落默认 | 改动小；隔离不彻底 |
| C：全量 per-tenant 双轨表 | 新表替代 config_store | 彻底；动核心表、风险高 |

**采用 A**。

## 3. 详细设计（方案 A）

### §A-1 存储层改造（configStore.js）

```
readConfig(key, {tenantId}) → 无 (tenantId,key)：
  ① 查 system 模板（tenant_id='system' AND key）
  ② 有 → UPSERT 到该租户（落 _seeded:'system-template' 标记）+ 返回该租户值
  ③ 无 → 返回 null（调用方回退代码默认）
写：仍 writeConfig 按 (tenant_id,key)（禁删铁律不变）
```

要点：
- 只对**租户级键**启用 autoSeed；platform 级键（system-only）保持直读 system。
- autoSeed 幂等：已存在租户键不重复写入。
- 标记 `_seeded` 用于审计"该租户值来自模板"。

### §A-2 新租户播种（industry-onboarding 钩子）

- 新租户创建（POST /api/tenants）后自动播种以下租户级键（深拷贝 system 模板 + tenant_id 改写）：

```
sales-thresholds / approval-config / named-account-targets / behavior-standard /
finance-receivables / decision-retro / agent-event-trigger / context-routing（仅列表）
```

### §A-3 存量租户 backfill（一次性迁移）

`db/backfill-tenant-config.js`：
- 遍历现有租户（tenants 表 + particles 中出现的租户）
- 把 system 基线的租户级键深拷贝到各租户（只补缺，不覆盖已有定制）
- 幂等：已有 (tenant_id,key) 跳过
- 禁删：只 INSERT ON CONFLICT DO NOTHING，绝不 DELETE

### §A-4 权限闸补齐（G3/G4/G5）

| 项目 | 改造 |
|---|---|
| alert_rule 表 | `+ tenant_id TEXT NOT NULL DEFAULT 'system'` + PK(kind,tenant_id) + 索引；写经 scopeOf(me) |
| pool-config | GET/PUT 按 scopeTenant/scopeOf，去 orgId 硬编码 |
| decision-scenarios | 读按租户（有则租户、无则 system），写按 scopeOf(me) |

### §A-5 消费链路修正（G2）

- `approvalConfig.js`：`readApprovalConfig(tenantId)` 显式传租户；缺省回退代码默认（不读 system）

### §A-6 治理

- 决策第0闸保留；禁删铁律保留（backfill 只插不删）
- config_store 落库 value 附带 `_seeded:'system-template'` 标记（审计可追溯）

## 4. 契约（living contract）

```contract-yaml
- task: "租户级设置完全隔离（configStore autoSeed + 播种/backfill + G2-G5 补闸）"
  agent: decision-agent
  contract_task_id: ct-decision
  skills: [method-decision-enrich, data-particle-create]
  memory: [decision-agent]
  knowledge_scope: { layers: [L1, L2], max_hops: 3 }
  success: "租户 A 改 sales-thresholds 后，租户 B 读回原值；新租户播种后 8 个键自存在；approval-config 租户优先"
```

**契约说明**：本任务由 `decision-agent`（决策接线支持）承接，须调用 `method-decision-enrich` / `data-particle-create` SKILL、读取 `decision-agent` 记忆（L1/L2，≤3 跳）；成功标准为租户写入隔离、新租户播种完备、审批参数租户优先。

## 5. 范围与风险

- **范围**：configStore、approvalConfig、alert_rule/pool-config/decision-scenarios 三端、播种/backfill 脚本、configCenter 声明核对。
- **风险**：
  - backfill 改生产库 → 需用户显式确认（零信任 HITL），只插不删
  - alert_rule 重建 PK 会动既有行 → 迁移需幂等（ADD COLUMN + 重建 PK，不改数据）
  - decision-scenarios 写侧改租户后，存量 system 场景仍在（回退），不受影响
- **不做**：不改 context-routing 红色（红线）；不改 RBAC 角色矩阵；不物理删任何行。

## 6. 待办清单（进入 writing-plans 后）

1. configStore.js autoSeed 改造 + 单测
2. db/backfill-tenant-config.js 存量 backfill
3. industry-onboarding 新租户播种钩子
4. alert_rule 表补 tenant_id + 路由按租户
5. pool-config 按 scopeTenant/scopeOf
6. decision-scenarios 租户读写
7. approvalConfig 消费链租户化
8. e2e 验证（租户互不污染 + 播种 + backfill + 权限）
