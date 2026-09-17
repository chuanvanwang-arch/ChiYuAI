# 设计：内部可观测客户异动派生（替代「招聘/新战略」筛选主张）2026-09-16

> 状态：**待用户评审（P8）**｜设计输入：`docs/2026-09-16-four-module-claim-verification-audit.md` §1.2、
> `src/config/discoveryRules.js`（`leadership_change` 权重配置）、本文件 §1 数据面实测
> 承接智能体：`prospecting`（契约键 `ct-prospecting`，源 `src/agent/contractIds.js`）
> ⚠ 边界：**不新增粒子类型**（遵循 2026-09-08 已批设计 §10 硬约束）；不为无数据源字段写桩映射

---

## §0 结论先行（含对上一轮假设的修正）

用户裁决为「内部数据近似派生」。经数据面实测，该路线**只能覆盖 2 类，不能覆盖 3 类**：

| 原主张 | 内部可派生？ | 结论 |
|---|---|---|
| 人员招聘 | ⛔ 零源（本平台无 HR/招聘数据） | **改口径**：剔除该主张，不做桩字段 |
| 新战略 | ⛔ 零源（无战略情报面） | **改口径**：剔除该主张 |
| 高层变动 | ⚠ **弱代理**：`CRM_CONTACT` 台账变动 | 保留但**必须改叙事**为「客户侧联系人台账变动」，不得称"高层变动情报" |
| （新增，可真实产出） | ✅ 关系冷却（`CRM_ACCOUNT`/`CRM_DEAL` 停滞） | 新增 `relation_cooling` 派生信号 |

**另一处修正（重要）**：`decision_relation` **不可**用作「决策链/关键人变动」代理。实测其 `rel_type` 全为
`DECIDED_ON`(49) / `REFERENCED_PRECEDENT`(71) / `OVERRIDES` / `CAUSED` 等——语义是「我方某决策作用于某实体」，
**属平台内部决策网，不是客户组织人事**。若据此派生"关键人变动"，等于新造一个桩。

---

## §1 起点诊断（数据面实测，2026-09-16 · 本地库 `crm_native`）

```
### decision_relation（125 行）
  REFERENCED_PRECEDENT 71 | DECIDED_ON 49 | OVERRIDES 1 | DERIVED_FROM_EXCEPTION 1 | ESTABLISHES_FRAME 1 | INFLUENCED 1 | CAUSED 1
### particles（按类型，updated_at 最新）
  CRM_DICT_ENTRY 252 | CRM_APPROVAL_NODE 127 | CRM_PRODUCT 119 | CRM_APPROVAL_LINK 95 | CRM_OFFER_POLICY 81
  CRM_KNOWLEDGE 69 | CRM_APPROVAL_APPROVER 63 | CRM_PRICE_LIST 46 | CRM_ACCOUNT 35 | CRM_DEAL 33
  CRM_APPROVAL_FLOW 32 | CRM_CONTACT 25        ← 客户侧实体：ACCOUNT/DEAL/CONTACT 均有，最新 2026-09-15
### 近 30 天新增 decision_relation = 125
```

**现有缺口（审计 §1.2 的代码级结论）**：`leadership_change` 在全仓**仅命中 `discoveryRules.js:35` 一处权重配置**，
无任何适配器产出该字段；`hiring` / `新战略` 同族。⇒ 规则存在、数据面缺失，属「配置承诺 ≠ 实现」。

---

## §2 目标 / 非目标 / 硬约束

**目标**：把「新客户筛选」从"无源字段"改为**内部可观测、可证伪**的客户异动信号，并显式收敛口径。

**非目标**：不做外部工商/招聘/专利情报接入（属 S2 外部数据接入，未在本批）；不新增粒子类型；
不为「招聘/新战略」保留任何"看起来在跑"的桩映射。

**硬约束**：
- 派生信号**必须自带来源与置信语义**（`source='derived'`、`payload.confidence_basis='internal_inference'`），
  且**不得与外部情报同权**（权重不得等同实测情报）。
- 阈值/窗口/启停 **100% 配置化**（新键 `internal-signal-derivation`），零代码字面量。
- 派生**必须 fail-closed**：读不到配置或实体缺失 → 不产出，并 `emit` 归因（不静默、不造假数据）。
- 零 DELETE；写操作过决策第 0 闸；去重键与既有 `idx_signal_dedup` 谓词**逐字一致**。

---

## §3 关键机制

### 3.1 新模块 `src/signal/activityDerivation.js`
纯函数 + 注入式 IO（对齐 `scheduleScanner` 既有范式）：

| 派生规则 | 内部源 | 产出 kind | 说明 |
|---|---|---|---|
| `contact_ledger_change` | `crm.particles` where `type='CRM_CONTACT'` and `updated_at ≥ now()-window` | `contact_change` | **弱代理**：客户侧联系人台账变动（**不是**"高层变动情报"） |
| `relation_cooling` | `crm.particles` where `type IN ('CRM_ACCOUNT','CRM_DEAL')` and `updated_at ≤ now()-threshold` and 无近期互动 | `relation_cooling` | 活跃度下降 |
| 阶段停滞 | 复用既有 `deal_stuck` | — | **不重复造**（既有 ruleEvaluator 已覆盖） |

### 3.2 配置（零字面量）
```jsonc
// config_store['internal-signal-derivation']（system 模板 + 逐租户可覆盖）
{
  "version": 1,
  "enabled": true,
  "rules": [
    { "id": "contact-ledger-change", "kind": "contact_change",
      "entity_type": "CRM_CONTACT", "window_days": 14,
      "severity": "low", "target_role": "sales", "enabled": true, "bucket": "day" },
    { "id": "relation-cooling", "kind": "relation_cooling",
      "entity_type": "CRM_ACCOUNT", "threshold_days": 30,
      "severity": "medium", "target_role": "sales", "enabled": true, "bucket": "week" }
  ]
}
```

### 3.3 口径收敛（本设计的**必要组成**，非附赠）
- `src/config/discoveryRules.js`：`leadership_change` / 新战略 / 招聘 三项标注
  `coverage: 'no_internal_source'`（保留字段以避免破坏既有读取点，但**显式声明无源**），并新增
  `contact_ledger_change` / `relation_cooling` 两项（`coverage: 'internal_inference'`，权重低于实测情报）。
- 审计报告与台面文案：把「可以筛选新客户，比如新战略、高层变动、人员招聘」改写为
  「可识别**内部可观测**的客户异动（联系人台账变动、关系冷却、商机停滞）；**不覆盖**外部招聘/战略情报（待 S2 外部接入）」。

---

## §4 生命契约（双轨）

```contract-yaml
- task: "T-D1 新增 src/signal/activityDerivation.js：两条内部派生规则（纯函数 + 注入 IO）"
  contract_task_id: ct-prospecting
  agent: prospecting
  skills: [prospecting-search]
  memory: [intake-router]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "给定注入的实体集与配置：窗口内 CRM_CONTACT 变动命中、超阈值停滞命中、正常实体不命中；每条信号带 source='derived' 与 confidence_basis='internal_inference'"
```
**契约说明：** T-D1 由 `prospecting` 承接（契约键 `ct-prospecting`，源 `contractIds.js`），须读 `intake-router` 记忆（L1，≤2 跳）；成功标准含**正例 + 反例**（正常实体不得命中）。

```contract-yaml
- task: "T-D2 播种 internal-signal-derivation 配置（幂等）并接线派生扫描"
  contract_task_id: ct-prospecting
  agent: prospecting
  skills: [prospecting-search]
  memory: [intake-router]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "真库直查配置键就位且复跑 0 新增；派生器在真库上产出 relation_cooling 信号（或显式 emit 归因说明为何零命中）"
```
**契约说明：** T-D2 由 `prospecting` 承接；**零命中必须给出归因**（不得静默），真库产出须直查可见。

```contract-yaml
- task: "T-D3 口径收敛：discoveryRules 三字段标注 no_internal_source + 审计/台面文案改写"
  contract_task_id: ct-prospecting
  agent: prospecting
  skills: [prospecting-search]
  memory: [intake-router]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "grep 断言：三项标注 no_internal_source 且全仓无任何适配器产出该三字段；文档与台面不再出现「可筛选招聘/新战略」表述"
```
**契约说明：** T-D3 由 `prospecting` 承接；成功标准为**否定断言的扫描方法先自证有效**（沿用「否定断言须先验证扫描方法」纪律）。

```contract-yaml
- task: "T-D4 守卫测试：派生信号低置信不得与实测情报同权 + 去重谓词一致"
  contract_task_id: ct-prospecting
  agent: prospecting
  skills: [prospecting-search]
  memory: [intake-router]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "断言 internal_inference 权重 < 实测来源权重；dedup_key 与 idx_signal_dedup 谓词一致的变异验证通过（改谓词必红）"
```
**契约说明：** T-D4 由 `prospecting` 承接；成功标准含**变异验证**（证明守卫有鉴别力）。

---

## §5 验收判据（可证伪）

| # | 判据 | 方式 | 通过条件 | 实测（2026-09-17 本地 crm_native） |
|---|---|---|---|---|
| 1 | 派生真实产出 | 真库 `SELECT kind,count(*) FROM crm.signal WHERE source='derived' GROUP BY 1` | `relation_cooling > 0`（本库有 35 ACCOUNT/33 DEAL，可产出） | ✅ **契约已修**（2026-09-17，见 §9）：判定源改为**列** `updated_at` 后 `relation_cooling` 结构性可达（反事实 `now+25d` → **11/11** 命中）。**当日 0 命中属正确行为**——本库最旧 ACCOUNT 仅 14.7 天，无 ≥30 天停滞者，已显式归因 `zero_hit, scanned=11`（非静默）。`contact_change`=**12**（旧实现仅 2，且那 2 条来自 payload 残留夹具键） |
| 2 | 零假信号 | 正常实体（近期有更新）不得被派生 | 反例用例通过 | ✅ `test/signal/activityDerivation.test.js` 反例用例通过（窗口外/近期更新不命中）；变异验证有鉴别力 |
| 3 | 置信语义 | 信号 payload 含 `confidence_basis` | 字段存在且为 `internal_inference` | ✅ 派生总数 **12** = 带 `internal_inference` 计数 **12**（每条都带） |
| 4 | 口径一致 | grep 复核 | 三字段标注无源 + 无适配器产出 + 文案已改 | ✅ `discoveryRules` 标注 + 页面镜像守卫 + grep 否定断言（见 §8） |
| 5 | 幂等 | 复跑派生 | 同 `dedup_key` 不新增 | ✅ 第二次 `system` 返回 `{signals:12, deduped:12}`，`source='derived'` 行数不变（12） |

**反假绿要求**：不得把"配置已播种"叙述为"筛选能力已上线"——判据 1 要求**真库有派生信号**。

---

## §6 风险与缓解

| 风险 | 缓解 |
|---|---|
| 派生信号被当成"客户情报"消费 | `source='derived'` + `confidence_basis` 显式标注；权重低于实测情报（T-D4 锁定） |
| 「弱代理」被叙述成「高层变动」 | T-D3 强制改口径 + grep 断言 |
| 窗口/阈值硬编码 | 全走 `config_store['internal-signal-derivation']` |
| 与既有 `deal_stuck` 重复造 | 明确排除，仅做两条新规则 |

---

## §7 闭环回写

| task | 期望调用 | 期望记忆 | 成功判据 | 状态 |
|---|---|---|---|---|
| T-D1 | prospecting-search | intake-router | 正例命中 + 反例不命中 | ✅ 已执行 `06ea9a7` |
| T-D2 | prospecting-search | intake-router | 配置就位 + 真库派生有产出或显式归因 | ✅ 已执行 `25f465e`/`952e31c`（产出见 §8，relation_cooling 零命中已显式归因） |
| T-D3 | prospecting-search | intake-router | 无源标注 + 文案改写（grep 断言） | ✅ 已执行 `aaa7983` |
| T-D4 | prospecting-search | intake-router | 权重下限 + 去重谓词变异验证 | ✅ 已执行（`aaa7983` 变异验证 + Task 1/2 幂等） |

> 反馈文件（若工作台产生）：`docs/2026-09-16-internal-signal-derivation-design.feedback.json`。

---

## §8 执行读数（2026-09-17 实测，本地 crm_native）

| 判据 | 命令 | 实测 |
|---|---|---|
| 派生真实产出 | `SELECT kind,count(*) FROM crm.signal WHERE source='derived' GROUP BY 1` | （2026-09-17 修复后）`contact_change`(low)=**12**；`relation_cooling`=**0**（当日正确：无 ≥30 天停滞客户，已显式归因 `zero_hit, scanned=11`） |
| 置信语义 | `... WHERE payload->>'confidence_basis'='internal_inference'` | **12** = 派生总数 12（每条都带，无假绿） |
| 幂等 | 复跑 `deriveOnce` | 第二次 `system` 返回 `{signals:12, deduped:12}`，`source='derived'` 行数 **不增长** |
| 配置就位 | `SELECT count(*) FROM crm.config_store WHERE key='internal-signal-derivation'` | 1（system 模板，经 readConfig autoSeed 覆盖租户） |
| 生产接线 | 定时器⑱ | 已注册，`EXPECTED_TIMERS=18` |

**判据 1 曾部分证伪 → 2026-09-17 已修复（下文为**原始取证**，原样保留以留痕）**：
`relation_cooling` = 0，派生器返回归因 `missing=[{rule_id:'relation-cooling', reason:'zero_hit', scanned:11}]`（system 租户）。
根因（数据面实测）：`crm.particles` 的 `updated_at` 存于**表列** `updated_at`，**不在** `payload` 内——
`CRM_ACCOUNT` 38 行 `payload ? 'updated_at'` = **0**；`CRM_CONTACT` 25 行仅 **2** 行含该 payload 键（恰是当时命中的 2 条）。
而 `hitsRule` 读 `entity.payload.updated_at`（派生器 SQL `SELECT id, tenant_id, payload FROM crm.particles` 未取列）⇒
**`relation_cooling` 在生产数据面永不可能命中**，`contact_ledger_change` 也仅对"恰好把 updated_at 写进 payload"的少数行生效。
**结论：本条属「模块已接线但数据面契约不符」**——首次执行时未被授权改实现，故仅如实记录（遵守「偏离已批准设计须显式批准」）；
用户 2026-09-17 批准修复后已按 §9 落地。

**口径收敛结果（本设计的必要组成）**：
`hiring_icp_role` / `leadership_change` 标 `coverage:'no_internal_source'`；
新增 `contact_ledger_change`(0.25) / `relation_cooling`(0.2) 标 `coverage:'internal_inference'`，
两者权重均**严格低于**最高实测情报权重（0.9）。页面 `discovery-rules.html` 镜像逐键一致（守卫锁定）。

**边界声明**：`relation_cooling` 只用粒子 `updated_at` 停滞判定（平台无互动流水表，见代码头注 ③），
不宣称"无近期互动"；`decision_relation` 不可作客户组织人事代理（实测其全为平台内部决策网关系）。

**否定断言取证（「无适配器产出招聘/新战略字段」，扫描方法先自证）**：
扫描 `grep -rn "hiring_icp_role\|leadership_change" src/`（**10 文件 24 命中**），逐条判定角色：

| 位点 | 角色 | 是否为"产出" |
|---|---|---|
| `discoveryRules.js:38/40/50/54` | 声明（权重 / 时间字段映射） | 否 |
| `discovery-rules.html:198/199/209/210` | 展示（镜像 + 标签） | 否 |
| `discoverySchema.js:33`、`leadFitScorer.js:29`、`claygent.js:15` | 声明（九尺子 / ruler 引用常量） | 否 |
| `claygent.js:24` | LLM 提示词的**允许枚举**（非数据源） | 否 |
| `anysite.js:46` | 形状声明（默认 `false`，无赋值来源） | 否 |
| `prospectingActions.js:95` | **消费**方（读候选 `c.hiring_icp_role` → 布尔 `hiring`） | 否（读出，非产出） |
| `qixin.js:14/17/51` | 适配器字段**映射**（`d.hiring_icp_role` → 输出同名键） | ⚠ 条件映射（付费源、出厂 `enabled:false`；上游 `d.hiring_icp_role` 本平台无内部源） |
| `timers.js:720`、`activityDerivation.js:4`、`leadFitScorer.js:9/15`、`qixin.js:2/10/27` | 注释 | 否 |

**结论**：`leadership_change` / 新战略 **无任何适配器产出**（判定成立）；`hiring_icp_role` 仅 `qixin`（付费、默认关闭）做条件字段映射，无内部数据源 ⇒ 三字段的「配置承诺 ≠ 实现」判定成立。

---

## §9 数据面契约修复（2026-09-17，用户批准后执行）

**修复项**：判定源由 `entity.payload.updated_at` 改为**表列** `updated_at`（并让 SQL 真正取该列）。

**权威源取证**（先证源、再改码）：
- 列定义：`db/schema.sql:24` — `updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`。
- 列被业务写刷新：`updateParticle` → `particleRepo.js:249` `UPDATE particles SET …, updated_at=now()`；`mintId.js:62` upsert 同步刷新。
  ⇒ 该列语义＝「最近一次业务写/入库时间」，正是 `window_days` / `threshold_days` 需要的量。
- payload 内从无该键：全租户 `CRM_ACCOUNT` `payload ? 'updated_at'` = **0/38**。

**改动**（3 处，`src/signal/activityDerivation.js`）：
1. SQL：`SELECT id, tenant_id, payload` → `SELECT id, tenant_id, payload, updated_at`（漏取列＝永久零命中）。
2. `hitsRule`：`entity?.payload?.updated_at` → `entity?.updated_at`（**单一权威源，不做 payload 回退**——双源会重造"同一字段两处解释权"并把缺陷掩盖回去）。
3. `evidence.updated_at` 同步改为取自列（证据链与判定同源）。

**测试加固（关键，防复发）**：`test/signal/activityDerivation.test.js`
- 实体统一改为**生产形状**（时间戳在顶层列、payload 不含该键）；
- 测试替身改为**按 SQL 的 SELECT 列表投影返回行** —— SQL 漏取 `updated_at` 时替身即返回 `undefined`，**与生产缺陷同形**（判据⑤「替身形状掩缺陷」的三重加固：设计形状数据 + 尊重语义 + 变异验证成对）；
- 新增 `[回归]` 组 3 例：① payload 无该键、仅列有值 → 必须命中；② SQL 必须取该列；③ `payload.updated_at` 不参与判定。

**验证读数（本地 crm_native，只读 + 实跑）**：

| 项 | 读数 | 说明 |
|---|---|---|
| `relation_cooling` 列源 / 真 `now` | 0 / 11 行 | 当日无 ≥30 天停滞客户（最旧 14.7 天）→ 0 为**正确行为** |
| `relation_cooling` 列源 / 反事实 `now+25d` | **11 / 11** | 结构性死路已消除，规则可达 |
| `relation_cooling` payload 旧源 | **0** | 证明旧实现永不可能命中 |
| SQL 独立通道（`updated_at < now()-30d`） | 0；`+25d` 时 11 | **与代码判定逐数一致**（防"代码自己说自己对"） |
| `contact_change` 真库实跑 | **12**（旧实现 2） | 第 1 次 `{signals:12, deduped:2}`；第 2 次 `{deduped:12}` 行数不变（幂等） |
| 证据链 | `evidence.updated_at` 非空 **12/12** | 证据链已改为取自列 |
| 置信标注 | `confidence_basis` **12/12** | 判据 3 保持 |

**旧产出的性质（重要）**：修复前真库仅 2 条 `contact_change`，命中的是 `徐采购` / `金总（CIO）` 两行 —— 其 `payload.updated_at` 为手写的日期串 `"2026-09-09"`（**夹具残留键**）。
⇒ **旧产出是偶发假象，不是真实业务派生**；修复后才与业务事实对齐。

**边界声明（不得越界叙述）**：
- 修复后 `relation_cooling` 是**可达且数据依赖**的，但本库当日**零命中**——不得叙述为"关系冷却已产出"。
- 阈值 30 天是**业务旋钮**（`config_store['internal-signal-derivation']`），本批**刻意不调低**去制造产出（那正是本仓禁止的假绿）；如需当日即有产出，须由业务侧显式改配置值，并承担"阈值被下调"的语义后果。
- M1/M4 类环境性超时与本次修复无关。
**扫描方法自证**：探针文件含 `hiring_icp_role` → 命中 1 行（证明该否定断言非空断言）。
