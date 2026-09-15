# D6 校准补丁积压 · 审批流草稿（待批准）

> 项目：CRM-ai-native｜起草：2026-09-14｜性质：**治理工作流设计草稿**（非实现）
> 关联探针：`scripts/kmd-closure-probe.mjs` `probeD6()`（kmd-closure-probe.mjs:323）
> 关联复盘：`docs/2026-09-10-kmd-retrospective.md` §4.3 / §6.1 / §7（D6 明确定性为 **HITL 治理缺口，非代码缺陷**）
> 状态：**本文件为草稿，未经用户批准前不得进入 implementation（brainstorming→writing-plans→executing 铁律）**

---

## 0. 结论先行

D6（校准补丁积压，edge ⑦ 参数生效）**不是接线缺陷，是治理缺口**。代码侧"审批→生效"原语已 100% 落地，**缺的是让 70 条 PENDING 被持续、按 SLA、分级、批量消费掉的工作流**：

| 维度 | 现状 | 缺口 |
|---|---|---|
| 审批原语 | `POST /api/calibration/patches/:id/approve\|reject\|rollback` 全在（calibrationRouter.js:219/230/241），`store.approvePatch` 经第0闸 `CALIBRATION_CHANGE` 决策 + 事务原子落 `config_store`（store.js:151） | ✅ 已齐备 |
| 人工审阅工具 | `scripts/calibration-triage.mjs`（只读分级清单，绝不自动应用） | ✅ 已齐备 |
| 待办可见性 | `GET /api/admin/todos?status=PENDING`（tenant 隔离，calibrationRouter.js:255） | ✅ 已齐备 |
| **SLA 计时/策略** | 仅探针算 `ageDays`（kmd-closure-probe.mjs:332），**无强制 SLA** | ❌ 缺 |
| **超时自动升级** | 探针 `fix` 字段写明"设审批 SLA + 超时自动转人工看板"（:343），**无代码实现** | ❌ 缺 |
| **分级路由/责任到人** | `assignee` 列全默认 `ADMIN`（schema.sql:711），无按 risk 路由 | ❌ 缺 |
| **存量 70 条批量消项协议** | 仅逐条 API approve，无批审护栏 | ❌ 缺 |

**本草稿交付**：SLA 矩阵 + 分级 RACI + 升级机制 + 存量 70 清零协议 + 待你拍板项。

---

## 1. 现状证据（file:line 锚定）

### 1.1 状态机（已落地，重述）
`crm.calibration_patch.status` CHECK 约束（schema.sql:534）：
`PENDING → APPROVED → APPLIED → ROLLED_BACK`，另含 `REJECTED`。
- `approvePatch`（store.js:151）：PENDING→APPLIED，写 `resolved_at/resolved_by`，经 `produceDecision('CALIBRATION_CHANGE')` 第0闸，事务内更新 `config_store`，下次 `loadEngineConf` 生效（edge ⑦）。
- `rejectPatch` / `rollbackPatch`（store.js:142/196）：PENDING→REJECTED / APPLIED→ROLLED_BACK。
- **铁律**：系统永不自动 apply（closureLoop.js:8、retro.md:179）；所有 apply 必经第0闸 + 人工 HITL。

### 1.2 写动作（agent 面）
`crm_calibration_patch_approve/reject/rollback`（seed-actions.js:1940/1955/1969）：`decisionScenario:'CALIBRATION_CHANGE'`、`autoDecision:true`、`confirm:'normal'`、`needsApproval:false`。

### 1.3 表结构（schema.sql:524）
`patch_id, scenario_id, knob, target, from_value, to_value, evidence, expected_impact, risk(LOW|MEDIUM|HIGH), status, decision_id, created_at, resolved_at, resolved_by, assignee(默认 ADMIN), tenant_id(默认 system)`。
索引：`idx_calibration_patch_status(status, created_at DESC)`、`:todo(status, assignee, tenant_id, created_at DESC)`。

### 1.4 探针判定（kmd-closure-probe.mjs:333）
`status = pending===0 ? PASS : (pending>20 || ageDays>7) ? FAIL : WARN`；当前 `pending=70`、最老约 8.8 天 → **FAIL**。

---

## 2. 审批流设计（提议）

### 2.1 SLA 矩阵（按 risk，提议值，待你确认）
| risk | 审批 SLA | 升级触发 | 建议审批角色 |
|---|---|---|---|
| **HIGH** | 24h | 超时→`escalated` + 告警 sysadmin | sysadmin |
| **MEDIUM** | 72h（3d） | 超时→`escalated` + 入人工看板 | admin |
| **LOW** | 7d | 超时→`escalated`，不阻塞发布 | tenant_admin / admin |

> SLA 计时基于 `created_at`；`resolved_at` 非空即视为已消项。当前无 SLA 列，需新增 `sla_due_at`（`created_at + risk→interval`）或视图计算——**属待实现项，见 §5**。

### 2.2 分级路由 RACI（提议）
| 动作 | HIGH | MEDIUM | LOW |
|---|---|---|---|
| 初审（证据/预期影响/风险复核） | sysadmin | admin | tenant_admin |
| 批准 apply | sysadmin | admin | admin（双签可选） |
| 拒绝 | 同上 | 同上 | 同上 |
| 回滚（生效后异常） | sysadmin | admin | admin |

### 2.3 升级机制（探针 fix 落地，待实现）
- SLA 违约：调度任务（新增，复用 `src/scheduler/timers.js`）每日扫描 `PENDING AND sla_due_at < now()` → 置 `escalated=true`、写 `calibration_escalation_log`（追加式，禁 DELETE）、推送至人工看板（`/api/admin/todos` 增加 `?escalated=true` 过滤）。
- **绝不自动 apply**：升级只改变"可见性/责任"，不改变状态机自动推进（守 HITL 铁律）。

### 2.4 批量消项协议（针对存量 70，HITL）
逐条校验四问，再分批批准：
1. **证据充分？** `evidence` 非空且含来源（autoSuggest / manual-seven-dim / retro）。
2. **预期影响可量化？** `expected_impact` 经 `replayDims`/`replayScenario` 重放（calibrationRouter.js:139 预览端点可复核）。
3. **风险与 knob 匹配？** `risk` 与 `knob` 变更幅度一致（参考 `RequiredDimsStrategy.riskLevel` 等）。
4. **无未决冲突？** 同 `scenario_id`+`knob` 无 PENDING/APPLIED 撞车（store 幂等去重已部分覆盖）。

**建议执行顺序**：HIGH(10) → MEDIUM(32) → LOW(28)；每批 ≤10 条，批准后立即 `replay` 验证无回归，再下一批。拒绝项置 `REJECTED` 并留 `resolved_by` 理由。

---

## 3. 存量 70 清零计划（提议，HITL 执行）

| 步骤 | 操作 | 责任 | 护栏 |
|---|---|---|---|
| 1 | `node scripts/calibration-triage.mjs --json out.json` 导出分级清单 | 你/我 | 只读 |
| 2 | 核对生产真值：**远程 crm-pg 直跑**（非本地 5433），确认 prod 实际 PENDING 数（⚠ DB 归属陷阱见 §6） | 你 | 避免本地假数 |
| 3 | 按 §2.4 四问逐条评审，生成"批准/拒绝"清单 | sysadmin | 批≤10 |
| 4 | 逐条/批量 `POST /api/calibration/patches/:id/approve` 或 `reject` | sysadmin | 经第0闸 |
| 5 | 每批后 `replay` 验证，重跑 `probeD6` → 期望 PENDING 递减至 0 | 你 | `ageDays` 同步降 |
| 6 | 启用 §2.3 调度升级，防再积压 | 实现后 | 不自动 apply |

---

## 4. 待你拍板项（硬闸前必须确认）

1. **SLA 取值**：§2.1 提议值（HIGH 24h / MED 72h / LOW 7d）是否采纳？或按业务调整？
2. **责任角色**：HIGH 是否必须 sysadmin 双签？tenant_admin 是否可批 LOW？
3. **升级实现范围**：是否接受新增 `sla_due_at` + `escalated` 列 + 调度任务（需 `migrate.js` 注册迁移，单一事实源纪律）？
4. **存量 70 是否现在清**：抑或先仅建工作流、存量留待你手动逐条？（清 70 条是人工重活，AI 不代 approve）
5. **DB 归属**：70 这一数字是本地 `crm_native`(5433) 还是远程 prod？须先核真值（§6）。

---

## 5. 实现范围边界（供 writing-plans 参考，本草稿不实现）

若批准，实现仅含：
- **DB**：`ALTER calibration_patch ADD COLUMN sla_due_at TIMESTAMPTZ / escalated BOOLEAN DEFAULT false`（幂等，注册 `db/migrate.js` INCREMENTAL_SQL，单一事实源）。
- **调度**：`src/scheduler/timers.js` 新增每日 SLA 违约扫描 → 置 `escalated` + 写日志。
- **API**：`GET /api/admin/todos` 增加 `?escalated=true`；可选批量 approve 端点（带批≤10 护栏 + 第0闸）。
- **前端**：`my-todo.html` / `sales-decision-monitor.html` 增加 SLA 倒计时 + 升级高亮。
- **禁做**：任何自动 apply、任何 DELETE、`calibration_patch` 写通道之外的旁路改参。

---

## 6. ⚠ DB 归属陷阱（沿用 D1/D4 教训）

`scripts/calibration-triage.mjs`（:20-26）与 `kmd-closure-probe.mjs`（:56-60）**均硬编码 `localhost:5433` = 本地 dev 库**。本地 `crm_native` 的 70 条 PENDING 可能是本地累积，**不代表远程生产积压量**。清存量前必须：
```bash
# 远程 crm-pg 直跑，取生产真值
docker exec crm-pg psql -tAc "SELECT status,count(*) FROM crm.calibration_patch GROUP BY 1"
```
以远程结果作为清零基准，避免"本地假绿/假红"重演。

---

## 7. 一句话交付

**D6 审批原语已齐备，缺口是 SLA + 超时升级 + 分级路由 + 存量批量消项四件治理工作流；本草稿给出 SLA 矩阵、RACI、升级机制与 70 条清零协议，待你拍板 §4 五项即进入 writing-plans。清存量与任何 approve 均为人工 HITL，AI 不代执行。**
