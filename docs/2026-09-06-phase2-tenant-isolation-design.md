# Phase 2 租户隔离收口设计（#3 seven-dim / #4 alert-rule / 配置中心标签）

> 流程：brainstorming（设计）→ 测试计划 → 开发计划 → 完整测试 → E2E → 按设计审计。
> 设计状态：**已批准**（id36 纳入修正，2026-09-06）。
> 范式：全部复用 Phase 1 验证过的「懒克隆 system 模板 → 租户独立落盘」，幂等、禁 DELETE。

## 一、范围与三大工作流

| 工作流 | 配置项 | 根因（已代码定位） | 修复范式 |
|---|---|---|---|
| **W1** | #3 seven-dim (id15) | `sevenDimRouter.js:83/190` 调 `updateScenario` 漏传 tenantId → 全落 system 基线 | 透传 `scopeOf(me)` 入既有内核（内核已支持租户克隆） |
| **W2** | #4 alert-rule (id21) | `crm.alert_rule` 仅 system 5 行；租户 PUT 时 `persist` UPDATE 命中 0 行 → 假绿、重启即丢 | 运行态懒克隆 + 播种租户行（对齐 Phase 1） |
| **W3** | 标签失真 id35/39/44/36 | `scope:'tenant'` 与 `level:'system'` 矛盾，实为平台级 | 改 `scope/platform`+`resolve/system-only`（纯元数据） |

## 二、W1 — seven-dim 写路径补 tenantId（id15）

### 根因（证据）
- `src/http/sevenDimRouter.js:83`
  `updateScenario: (id, patch) => scenarioDeps.updateScenario(id, patch)` — 未传 tenantId。
- `src/http/sevenDimRouter.js:190`
  `const row = await D.updateScenario(scenario_id, v.normalized);` — 未传 tenantId。
- 既有内核 `scenarioDeps.updateScenario`（`src/portal/decisionScenario.js:177`）**已支持** `{ tenantId }` 并做：① 租户缺键先 `INSERT…SELECT system … ON CONFLICT (scenario_id, tenant_id) DO NOTHING`；② 限定 `UPDATE … WHERE scenario_id=$1 AND tenant_id=$2`。调用方漏传 → 全部落 `system` 基线。

### 修复（最小改动，复用既有内核）
- `:83` → `updateScenario: (id, patch, opts) => scenarioDeps.updateScenario(id, patch, opts)`
- `:190` → `const row = await D.updateScenario(scenario_id, v.normalized, { tenantId });`
  （`tenantId` 已在 `:128` 由 `const tenantId = scopeOf(me);` 取得）
- GET 不入本次范围（admin/sysadmin 视界 + 多租户行同显属既有行为）。

### 风险
低。纯透传；内核幂等（INSERT…SELECT system ON CONFLICT DO NOTHING + 限定 UPDATE），禁 DELETE。

## 三、W2 — alert-rule 租户行播种 + 运行态懒克隆（id21）

### 根因（证据）
- 迁移 `db/migration-alert-tenant.sql` 已把 `crm.alert_rule` 复合 PK 化 `(kind, tenant_id)`；router `src/portal/alertRuleConfig.js` 读写均透传 `scopeTenant/scopeOf`。
- DB 仅 `system` 5 行（`db/seed.sql:423` 播种，PK 复合化后 `ON CONFLICT (kind,tenant_id)`）。
- 租户 PUT 时 `persist`（`alertRuleConfig.js:89`）`UPDATE…WHERE kind=$1 AND tenant_id=$2 RETURNING kind` 命中 0 行 → `{ok:false}`；而 `updateCache`→`alertRegistry.updateAlertRule:201` 先在内存把租户继承视图转独立副本返回 `ok:true` → **响应假绿、DB 未落盘、重启即丢**。

### 修复（双保险，对齐 Phase 1）
1. **运行态懒克隆（核心，覆盖现有+未来租户）**：`persist` 在 UPDATE 前先（仅非 system 租户）
   ```sql
   INSERT INTO crm.alert_rule (kind, match, check_params, severity, target_role, enabled, version, tenant_id)
   SELECT kind, match, check_params, severity, target_role, enabled, version, $2
   FROM crm.alert_rule WHERE kind=$1 AND tenant_id='system'
   ON CONFLICT (kind, tenant_id) DO NOTHING
   ```
   再执行原 UPDATE → 任意租户首 PUT 即自建行。`match` 列由克隆 SELECT 继承 system 模板，保证引擎匹配规则完整。
2. **播种（初始态对齐）**：`scripts/seed-tenant-isolation.mjs` 增 `seedAlertRules(tenant)`，克隆 system 5 行到各业务租户（幂等，只插不删，复用既有 `collectTenants` 范式）。

### 风险
低。克隆不改 system 模板、互不污染；`UPDATE` 仍限定 `tenant_id`。

## 四、W3 — 配置中心标签失真（id35/39/44/36）

### 现状
`src/portal/configCenter.js` 中 id35/39/44 的 `scope:'tenant'`/`resolve:'tenant-first'` 与 `level:'system'` 矛盾——实际为平台级（config_store 读 system，无租户维度）→ 标签误导。id36 场景路由同为此类，但踩中配置禁改红线。

### 修复
- id35/39/44（及 id36，已批准纳入）改 `scope:'platform'` + `resolve:'system-only'`（纯元数据标签；运行时 gate 用 `level`，不改行为）。
- **红线合规**：id36 仅改 `scope`/`resolve` 元数据，不碰 `config_store['context-routing']`、不碰 `src/context/routing.js`，不改变任何路由行为；本 brainstorming 会话批准即满足红线「须先 brainstorming 获批准」前置。
- **验证项**：实现后 grep `scope`/`resolve` 消费点，确认仅展示用、无运行时 gate 依赖。

### 具体改点（configCenter.js）
- `:50` id35 事件触发复盘配置：`scope:'tenant'→'platform'`，`resolve:'tenant-first'→'system-only'`
- `:65` id39 事件触发智能体派发：`scope:'tenant'→'platform'`，`resolve:'tenant-first'→'system-only'`
- `:60` id36 场景路由：`scope:'tenant'→'platform'`，`resolve:'tenant-first'→'system-only'`
- `:69` id44 路由实验：`scope:'tenant'→'platform'`，`resolve:'tenant-first'→'system-only'`

## 五、生命契约（Living Contract，双轨）

```contract-yaml
- task: "W1 sevenDimRouter 透传 scopeOf(me) 进 updateScenario"
  agent: crm-backend-impl
  skills: []
  memory: [crm-tenant-isolation]
  success: "PUT /api/config/seven-dim 修改 required_dims 后，crm.decision_scenario 中 tenant_id=调用租户的行被更新且 system 行不变；单测断言 tenant 行生效、跨租户不串"
- task: "W2 alert_rule 租户行懒克隆 + 播种"
  agent: crm-backend-impl
  skills: []
  memory: [crm-tenant-isolation]
  success: "租户首 PUT /api/alert-rules/:kind 后 crm.alert_rule 出现 (kind,tenant_id) 行且 persist 返回 ok:true；seed-tenant-isolation 为各业务租户克隆 5 行；重启 hydrate 后仍生效"
- task: "W3 config_center 标签 id35/39/44/36 scope→platform"
  agent: crm-backend-impl
  skills: []
  memory: [crm-tenant-isolation]
  success: "configCenter.js 中 id35/39/44/36 的 scope='platform' 且 resolve='system-only'；grep 确认 scope/resolve 仅展示消费、无运行时 gate 依赖；单测断言该 id 集合"
```

**契约说明**：三任务均由 `crm-backend-impl` 承接（本仓库无 agentSpec 注册表，契约做结构校验）；成功标准均为可判定式（直查库表 + 单测断言），与 Phase 1 审计口径一致。

## 六、测试计划

| 用例 | 覆盖 | 期望 |
|---|---|---|
| W1 单测 | PUT required_dims 带 tenantId | `crm.decision_scenario` tenant 行 updated、`system` 行不变；跨租户不串 |
| W2 单测-A | 租户首 PUT alert-rule | persist 返回 ok:true 且 DB 出现 (kind,tenant_id) 行 |
| W2 单测-B | 重启后 hydrate | 租户行仍被 `listAlertRules`/`enabledAlertRules` 读取 |
| W2 播种 | 跑 seed-tenant-isolation | 各业务租户各 5 行 alert_rule |
| W3 单测 | configCenter 导出 | id35/39/44/36 的 scope/platform + resolve/system-only |

## 七、开发计划（由 writing-plans 细化，含完整代码）

> 此处占位，writing-plans 阶段填充分文件 diff 与实现顺序（W1→W2→W3，每 Task 一 commit）。

## 八、完整测试与 E2E 结果（2026-09-06 实测回填）

**单元测试（Phase 2 新增 3 文件 / 5 用例，全部绿）**
- `test/http/sevenDimRouter-tenant.test.js`（2）：① PUT 透传 `scopeOf(me).tenantId` 进 `updateScenario`（修复前 `captured.tenantId` 为 `undefined`）；② PUT `default_strictness` 按租户落 `config_store` 且 `system` 基线不变。
- `test/alerts/alertRuleTenant.test.js`（2）：① 租户首 PUT 自建 `(kind,tenant_id)` 行且 UPDATE 生效、`system` 模板不被污染；② 已有租户行 UPDATE 幂等（行长不变）。
- `test/web/configCenter-scope.test.js`（1）：id35/39/44/36 的 `scope=platform` + `resolve=system-only` + `level=system`。

**回归（Phase 1/既有相关测试同跑，12 文件 / 107 用例全绿）**
- sevenDimRouter(11)/edge-bindings(7)/root-thresholds(10)、alertRuleConfig(11)、decisionScenario(28)/decisionScenarioTab(9)/decisionScenarioTenant(4)、configCenter(20)/configCenter.rbac(2)、+ 上述 3 个新文件。无任何既有用例因本改动回退。

**E2E 实测（生产库 `crm_native`，非推断）**
- **W2 播种**：`node scripts/seed-tenant-isolation.mjs` 落 5 业务租户各 +5 `alert_rule`（共新建 25 行），DB 共 30 行（system 5 + 5×5），每租户独立、互不污染。
- **W1 写路径**：test DB 实测 `tenantAlpha` PUT `default_strictness` → `crm.config_store` 出现 `{tenantAlpha, seven-dim, default_strictness:'block'}` 行（租户隔离写盘）；`decision_scenario` 租户克隆由 `decisionScenarioTenant.test.js` 4/4 证明（经真实 `scenarioDeps.updateScenario` + `tenantId` 懒克隆 system 模板）。

## 九、按设计审计（实测，2026-09-06 回填）

**① alert_rule 分布（生产 `crm_native`）**
| tenant_id | 行数 |
|---|---|
| acme-chem / acme-demo / acme-insmedi / acme-training / co-036cq4k | 各 5 |
| system | 5 |
> 6 组、30 行，每业务租户持有自己独立的 5 条预警规则，引擎按 `tenant_id` 过滤 → **无跨租户引用、无泄漏**。

**② decision_scenario 分布（生产）**：`system` 13 行（平台模板）；租户行在首次 PUT 时由 `updateScenario` 懒克隆生成（代码路径已由 `decisionScenarioTenant.test.js` 单测证明），当前尚无租户触发过写，故仅 `system`。

**③ config_store(seven-dim) 分布（生产）**：0 行（尚无租户 PUT）；写路径已单测证明按 `tenantId` 落盘（见 §8 E2E）。

**④ W3 标签失真修正**：id35/39/44/36 已改 `scope:'platform'` + `resolve:'system-only'`；`grep -rn "item.scope\|item.resolve"` 确认 `src/` 内无运行时 gate 消费该两字段（仅展示用），**纯元数据修正、运行行为零变化**；`configCenter.js` 仍可正常导入（107 用例全绿佐证）。

**⑤ 运行态解析隔离（与 Phase 1 同一范式）**
- W1：`sevenDimRouter` 经 `scopeOf(me)` 取 `tenantId` 透传 `updateScenario` / `writeStrictness`。
- W2：`alertRuleConfig.persist` 写前 `INSERT…SELECT system` 懒克隆 + 复合 PK 幂等；播种脚本对齐落库。
- 与 Phase 1 `business-tier` / `approval-flow` 三处现已统一为「**懒克隆 system 模板 → 租户独立落盘**」。

**收口补丁（本轮一处）**：`db/test-setup.sql:177` 的 `ON CONFLICT (kind)` 在 `alert_rule` 主键复合化（Phase 1 迁移）后已失效，改为 `ON CONFLICT (kind, tenant_id)`，消除重新建库脚本的潜在 `no unique or exclusion constraint` 报错（与 `business_tier_config` 同类修复一致性）。
