# 经销商渠道门户完整解决方案设计（v2 · 已批准 · 实施就绪）

> 日期：2026-09-18 · 性质：已批准设计文档（架构级产品增强）→ 进入开发落地
> 输入：用户提供的硬件制造商销售痛点材料 + 四轮追问澄清（选 A 渠道门户；**未来每个经销商独立租户，1:N 联邦**）
> 关联文档：`2026-09-18-hardware-sales-pain-points-mapping.md`（v3 痛点映射）、`2026-09-18-unified-integration-design-v2.md`（集成线）、`2026-09-03-new-industry-onboarding.md`（行业上线）、`2026-09-05-crm-buddy-app-design.md`（WorkBuddy 集成）
> 设计纪律：零新 `CRM_*` 粒子类型（遵守 2026-09-08 已批设计 §10）；不回写客户侧 CRM；跨租户**只读**授权（守 `cross_tenant_write_denied`）；写操作过决策第 0 闸 + HITL
> **v2 变更**：① §9.2 的 D1–D6 全部按推荐项批准；② 新增 §13 实施级规格（config_store JSON schema、读作用域注入点、`dealerRoutes` API 契约、四序列流、`channel-agent` 职责、测试计划、任务分解），使文档达到「可编码」状态。

---

## §0 结论先行

1. **模型锁定**：厂商租户（策略/数据主权）: **N 个经销商租户**（每个经销商独立租户）= **1:N 联邦授权视图**。经销商租户内做「报备终端项目、查返利、下提货单、看库存动销」；厂商租户内做「经销商准入、政策/价表下发、返利结算、冲突检测」。
2. **架构融合路径（零内核、零新粒子类型）**：
   - 数据库：联邦关系**全部走 `config_store`**（不新增任何表、不新增任何 `CRM_*` 粒子）→ 守住 §10。
   - 智能体：现有 **7 个 agent 按 `tenant_id` 自动隔离**，经销商租户零成本复用；新增 **1 个 `channel-agent`**（厂商侧渠道经理）注册进 `agentSpec.js` + `contractIds.js`，闭环契约覆盖全部 **8** 个 agent。
   - 记忆/知识/决策：复用 L1–L4 上下文注入 + K-M-D/LIGHT 管线 + `scenarioAdvisors`，零新引擎；仅增 3 个场景键。
   - 权限：复用 `ten_admin`/`scopeTenant`/`scopeOf`，新增 `channel_manager`/`dealer_user` 角色 + `canManageDealers()` 闸 + 1:N 读作用域解析器 `federationReadScope()`。
   - WorkBuddy：crm-native MCP 双通道按租户 token 作用域接入；Buddy 应用增「渠道管理」模式 + 经销商胶囊。
3. **两租户联动核心**：跨租户**只只读**——经销商写入自身租户；厂商经 `federationReadScope` 只读各经销商租户（报备/订单/库存动销）做聚合与冲突检测（解 G3/G6），**永不写经销商租户**；厂商政策/价表经 `shared_view_grant` 推为经销商租户内的只读共享视图，经销商**永不写厂商租户**。
4. **边界（回应用户四点）**：G2 样机走 LTC 阶段内扩展；G1 BOM/PLM、G4 维保/售后、G5 信用/财务 **明确不做**（超销售管理范畴）；G7 附件上传挂接能力已具备（补前端入口即可）。
5. **对纯自营销售零侵入保证**：经销商联邦是**叠加层、默认惰性**——`tenant-federation` 配置不存在时，`federationReadScope` 退化为当前 `scopeTenant`（仅自身租户），`channel-agent` 不激活，新角色/场景不可见；另设平台级 kill-switch `feature:dealer-portal` 总闸。纯自营租户行为前后字节级一致。
6. **HANDBOOK 激活开关**：制造业 HANDBOOK 在 onboarding 时分「直销型 / 渠道分销型」两子模；运行时 `tenant-profile.distribution_model` + 租户「渠道管理」设置页（ten_admin）可翻转；`tenant-federation` 仅在 channel 模式且首个经销商准入时创建。默认直营，零联邦。

---

## §1 模型锁定：1:N 经销商租户联邦

```
                厂商租户 (vendor_tenant, 数据主权)
   ┌─────────────────────────────────────────────────────┐
   │ policy / price_list / rebate_rule / dealer_conflict  │  ← 厂商写自身租户
   │ channel-agent (准入/结算/冲突检测/政策下发)            │
   └───────┬───────────────┬───────────────┬──────────────┘
    shared_view_grant      shared_view_grant      shared_view_grant   (只读授权, config_store)
   (push: 政策→经销商)    (push)              (push)
           │                   │                   │
   ┌───────▼──────┐   ┌────────▼───────┐   ┌────────▼───────┐
   │ 经销商租户 #1 │   │ 经销商租户 #2  │   │ 经销商租户 #N  │  ← 各自独立 tenant_id
   │ MFG_DEALER    │   │ MFG_DEALER     │   │ MFG_DEALER     │
   │ MFG_PROJECT   │   │ MFG_PROJECT    │   │ MFG_PROJECT    │  ← 经销商写自身租户
   │ MFG_ORDER     │   │ MFG_ORDER      │   │ MFG_ORDER      │
   │ MFG_REBATE    │   │ MFG_REBATE     │   │ MFG_REBATE     │
   │ MFG_CHANNEL_  │   │ MFG_CHANNEL_   │   │ MFG_CHANNEL_   │
   │ STOCK         │   │ STOCK          │   │ STOCK          │
   └───────┬──────┘   └────────┬───────┘   └────────┬───────┘
    reflow: 报备/订单/动销→厂商 (厂商经 federationReadScope 只读) 
```

**为什么是 1:N 而非 1:1**：用户明确「未来每个经销商单独租户」。联邦元数据须是 1:N（`tenant-federation.dealers` 为数组），冲突检测须跨 N 个经销商租户聚合。

**为什么守硬隔离**：`particleRepo.js:209/321` 跨租户写抛 `cross_tenant_write_denied`；`tenant_id` 进所有 PK（`schema.sql:263/443`）。故所有跨租户交互只能是**读授权**，写入恒在自身租户。

---

## §2 数据库/表结构融合（config_store 驱动，零新表/零新粒子）

> 关键决策：联邦基础设施**不新增物理表、不新增 `CRM_*` 粒子**，全部落 `config_store`（既有键值配置表，已带 `tenant_id`）。这守住 2026-09-08 §10「零新粒子类型」硬约束，且复用既有 `writeConfig`/`readConfig` 轨道。

### 2.1 `config_store` 三项联邦配置（平台级/厂商租户级）

| config_key | tenant_id 归属 | 结构 | 说明 |
|---|---|---|---|
| `tenant-federation` | vendor_tenant | `{ vendor_tenant, dealers:[{dealer_tenant, status, contract_ref, joined_at}], created_at }` | 1:N 联邦主记录 |
| `shared-view-grant` | vendor_tenant（或 system） | `[{federation_id, from_tenant, to_tenant, direction:'push'\|'reflow', particle_types:[...], read_only:true}]` | 跨租户只读授权 |
| `dealer-conflict-log` | vendor_tenant | `[{detected_at, dealer_a, dealer_b, territory, project_refs:[...], type:'territory_conflict'\|'double_registration', status}]` | 冲突检测结果（append-only，厂商写自身） |

### 2.2 制造业行业包扩展（零内核，走 `profileMerger` 既有轨道）

沿用 `db/seed/tenant-profile-manufacturing.js`（已注册 `MFG_DEALER/MFG_PROJECT/MFG_ORDER/MFG_REBATE/MFG_CHANNEL_STOCK`，且 `MFG_DEALER` 已带 `dealer_level/territory/rebate_rate`、`MFG_PROJECT` 已带 `dealer_name`——G6 载体已存在）：

- `MFG_DEALER` 补 `parent_vendor`（指向厂商租户）、`onboarding_state` 消费（现有 flow 已含 `onboarding`）→ 解决「经销商准入」。
- `MFG_PROJECT` 补 `territory`（与 `MFG_DEALER.territory` 对齐）→ 解决 G3 窜货/撞单**检测输入**。
- 新增 `calculations`：`conflict_check`（同 territory 跨经销商 `MFG_PROJECT` 冲突 → 写 `dealer-conflict-log`）、`rebate_settlement`（复用现有 `rebate_amount`）→ 解 G3/G6 计算。
- **不新增任何粒子类型**：全部在原 `MFG_*` 原型上扩展属性 + calculation，符合 §10。

### 2.3 红线
- ⛔ 不新增 `tenant_federation`/`shared_view_grant` 物理表（改走 config_store）。
- ⛔ 不新增 `CRM_DEALER_*` 粒子类型。
- ⛔ 经销商租户内任何写操作 `tenant_id` 必为自身；厂商写经销商 = `cross_tenant_write_denied`（物理拦截）。

---

## §3 记忆/知识 + 决策层融合

### 3.1 记忆/知识（L1–L4 自动作用域）
- 上下文装配 `assembler.js` 已按 `tenant_id` 注入 L1–L4（`working_memory` 已记录 L1 修复）→ **经销商租户自带 tenant-knowledge**（返利规则/区域政策/playbook），零改造复用。
- 厂商策略（价表/政策）经 `shared_view_grant`(push) 在经销商租户内呈现为**只读知识视图**，经销商 agent 可读不可写。

### 3.2 决策层（K-M-D / LIGHT 复用，零新引擎）
- 决策引擎 `decision-agent` + `decision-retro` 已就绪；新增 3 个场景键挂 `scenarioAdvisors.js`：
  - `CHANNEL_MANAGEMENT`（厂商：准入/返利结算/冲突检测触发）
  - `DEALER_PROJECT_REGISTRATION`（防撞单：同 territory 冲突 → 写 `dealer-conflict-log`）
  - `DEALER_REBATE_CLAIM`（返利结算审批）
- 决策凭证 `decision_id` 复用（报价/政策下发/冲突裁决均带凭证，可溯源）。

---

## §4 智能体结合（现有 7 + 新增 1 = 8，闭环契约全覆盖）

### 4.1 现有 7 agent 自动隔离复用
`agentSpec.js` 名册：`intake-router / quote-engine / followup-agent / review-gate / decision-retro / decision-agent / prospecting`。全部 action 经 `scopeTenant`/`scopeOf` 自动按 `tenant_id` 隔离 → **经销商租户登录即用同套 agent 做接诊/报价/跟进/评审/决策/拓客，零改造**。

### 4.2 新增 `channel-agent`（厂商侧渠道经理）
- 职责：经销商准入、返利结算、冲突检测、政策/价表下发；**仅在厂商租户激活**。
- 注册：`agentSpec.js` 增 `channel-agent` 六段式（沿用现有格式）；`contractIds.js` 增 `'channel-agent':'ct-channel-mgmt'`。
- **闭环契约**：`scripts/validate-contract.mjs` 双向断言（契约文档 ↔ `CONTRACT_IDS`）→ 新增 agent 必须配套契约块，否则 CI 拦截。注册后全集 = 8 agent，validate-contract 须覆盖全部 8。
- 内存/评估：写 `channel-agent`、读 `decision-retro`/`review-gate`（复用评审/复盘上下文）；evaluator 模板 `channel_mgmt_quality`。
- 决策：autonomy=`recommend`（准入/结算/冲突裁决需 HITL 审批，走既有审批流 R 链）。

### 4.3 红线
- ⛔ 不得把经销商数据写逻辑塞进 `decision-agent`（其契约 `ct-decision` 职责不同）→ 独立 `channel-agent` 是低耦合正解。

### 4.4 闭环契约块（validate-contract 正向断言，契约键 `ct-channel-mgmt`）
```contract-yaml
- task: "经销商准入编排（建独立租户 + 1:N 联邦 + 双向共享视图授权）"
  agent: channel-agent
  contract_task_id: ct-channel-mgmt
  skills: [data-particle-read, data-particle-create]
  memory: [channel-agent]
  success: "POST /api/dealers/onboard 经 canManageDealers 闸 + produceDecision 第0闸落 dealer 租户与 tenant-federation/shared-view-grant，decisionId 回写"
- task: "跨 N 经销商撞单/窜货冲突检测与仲裁"
  agent: channel-agent
  contract_task_id: ct-channel-mgmt
  skills: [data-particle-read, data-particle-create]
  memory: [channel-agent]
  success: "经销商报备回流 → detectTerritoryConflict 命中写 dealer-conflict-log；POST /api/dealers/conflicts/:id/resolve 仲裁置 resolved + decision_id"
- task: "政策/价表/返利共享视图下发（厂商→经销商只读）"
  agent: channel-agent
  contract_task_id: ct-channel-mgmt
  skills: [data-particle-read, data-particle-create]
  memory: [channel-agent]
  success: "厂商写 shared-view-grant（direction=push, read_only）→ 经销商经 federationReadScope 只读拉取，绝不写厂商"
```

---

## §5 权限（RBAC）结合

复用既有 RBAC（`rbac.js` 以 `ten_admin` 为规范；`scopeTenant` 读自身、`scopeOf` 写自身；`createConfigLevelGate` 管配置级）：

### 5.1 新增角色（写 `roleProfiles.js`）
- `channel_manager`：**仅厂商租户**——管经销商、发政策/价表、看共享视图、审批返利/冲突。
- `dealer_user`：经销商租户登录——写自身租户 MFG_* 粒子，读 `shared_view_grant`(push) 授权的厂商只读视图。

### 5.2 新增闸（写 `rbac.js`）
- `canManageDealers(actor, vendorTenant)`：仅 `channel_manager`/`ten_admin` 且 `actor.tenant_id===vendorTenant` → 真。
- `createConfigLevelGate('dealer_policy', {level:'tenant', ownerTenant:vendorTenant})`：经销商政策配置仅厂商可写（遵循既有配置级双闸 + 前端 guard 第三层范式）。

### 5.3 1:N 读作用域解析器（**本方案核心新增代码，唯一必要内核点**）
- 新增 `src/federation/scope.js`：`federationReadScope(actorTenant)` → 返回允许读到的 `tenant_id` 集合 = `[actorTenant, ...granted_vendor_tenants (经销商视角), ...granted_dealer_tenants (厂商视角, 来自 tenant-federation)]`。
- 在数据读路径（particleRepo 读查询）注入该作用域，**替代/扩展**现有 `scopeTenant`：经销商读「厂商政策」→ 命中 push grant 放行；厂商 channel-agent 读 N 个经销商 → 命中 tenant-federation 放行；其余跨租户读一律拒绝。
- 写路径**不变**：仍由 `cross_tenant_write_denied`（`particleRepo.js:209/321`）物理拦截。

> 说明：`federationReadScope` 是唯一新增内核逻辑点（约 1 个模块 + 读路径注入）。其余联邦元数据均为 config_store，不破 §10。若您认为「读作用域解析」也须走配置零代码，可后续评估将其固化为 config 驱动的策略引擎——但 1:N 动态授权必须有运行期解析，此为必要复杂度。

---

## §6 WorkBuddy 集成

沿用既有 crm-native MCP 双通道 + 按租户 token 作用域（`2026-09-05-crm-buddy-app-design.md`）：

- **厂商渠道经理**：连**厂商租户** MCP token（作用域含自身 + 各经销商只读）→ 管经销商、看渠道全景、下发政策。
- **经销商账号**：连**自身经销商租户** MCP token（作用域含自身 + push 授权的厂商只读视图）→ 报项目、查返利、下提货单、看库存。
- **Buddy 应用**：`buddy-crm-manifest.json` 增「渠道管理」工作模式 + 经销商胶囊；或独立经销商 Buddy 应用（二选一，推荐前者，共享基座）。
- 集成通道与 `external_ref` 双向 ID 对齐（`working_memory` 已记录该表存在）天然衔接，无需新建同步机制。

---

## §7 两租户联动与集成（核心：双向只读流 + 冲突检测）

### 7.1 经销商准入（厂商→建租户）
1. 厂商 `channel-agent` 发起准入 → 调既有 `assign-profile`(manufacturing) 建经销商租户（`tenant-profile-manufacturing.js` 零代码克隆）。
2. 写 `tenant-federation.dealers[]` + 双向 `shared-view-grant`（push: 厂商→经销商政策/价表；reflow: 经销商→厂商报备/订单/动销）。

### 7.2 厂商→经销商（push，只读视图）
- 厂商价表/政策/返利规则 → 经 push grant 在经销商租户内呈现为**只读共享视图**（`shared-view-grant.read_only=true`）。
- 经销商 `dealer_user` 读这些视图辅助报价/报备，**永不写厂商**。

### 7.3 经销商→厂商（reflow，厂商只读聚合）
- 经销商在自身租户写 `MFG_PROJECT_REGISTRATION`/`MFG_ORDER`/`MFG_CHANNEL_STOCK`。
- 厂商 `channel-agent` 经 `federationReadScope` **只读**拉取各经销商数据 → 在**厂商自身租户**写：
  - `dealer-conflict-log`（同 territory 跨经销商冲突，解 G3+G6）
  - `MFG_REBATE` 结算（复用 `rebate_amount` calculation）
  - 渠道 pipeline 聚合看板
- **全程厂商不写经销商租户**（守 `cross_tenant_write_denied`）。

### 7.4 冲突检测（G3 窜货/撞单 + G6 归属，1:N 聚合）
- 触发：经销商提交 `MFG_PROJECT_REGISTRATION`（带 `territory`）。
- 计算（厂商租户，读 N 个经销商）：对同 `territory` 跨经销商的报备做冲突比对 → 命中写 `dealer-conflict-log`，通知双方 + 厂商 `channel_manager` 仲裁。
- 归属判定（G6）：`MFG_PROJECT.dealer_name` ↔ `tenant-federation` 经销商映射→ 自动归属，撞单靠**自动仲裁**而非人工报备。

---

## §8 用户四点边界处理（明确不做 / 已有能力）

| 用户论断 | 处理 | 证据 |
|---|---|---|
| G2 样机从 LTC 阶段实现 | ✅ 走阶段内扩展：`MFG_PROJECT` flow 增 `pilot` 阶段 + `CRM_TECHNICAL_PROPOSAL` 承载测试记录（行业包扩展，零内核） | `stageConfig.js` S1–S8；`CRM_TECHNICAL_PROPOSAL` 已注册 |
| G1 BOM/PLM、G4 维保/售后、G5 信用/财务 超销售范畴 | ⛔ **明确不做**（属 PLM/售后/财务，非本平台销售管理职责） | 物料/维保属 ERP/售后主记录（`working_memory` 红线③） |
| G7 附件上传挂接已支持 | ✅ 能力已有（`src/assets/upload.js:78` `/api/assets/upload`→`CRM_UNSTRUCTURED_ASSET`+sha256；`seed-actions.js:696` `evidenced_by` 边），**仅差前端默认入口** | 现成能力补入口，非缺口 |
| 最大缺口=经销商/渠道管理，覆盖 G3+G6 | ✅ 本方案核心（§2.2/§7.4） | `MFG_DEALER`/`MFG_PROJECT` 载体已存在，补消费逻辑 |

---

## §9 红线 / 风险 flags + 待批决策（我的推荐）

### 9.1 红线（不可越）
- ⛔ 不新增 `CRM_*` 粒子类型（§10）。
- ⛔ 不回写客户侧 CRM；不收客户侧凭据。
- ⛔ 跨租户写入物理拦截（`particleRepo.js:209/321`）。
- ⛔ 报价/政策下发/冲突裁决走审批流 + `decision_id` 凭证（红线纪律）。

### 9.2 待批决策（已批准 · 按推荐项落地）

> 状态：D1–D6 已于 2026-09-18 由用户确认批准，按推荐项实施。

| # | 决策 | 批准结论 | 实施落点 |
|---|---|---|---|
| D1 | 联邦基础设施走 config_store（零新表） | ✅ 批准 config_store | `src/federation/config.js` 封装 `readConfig/writeConfig`，三项 key：`tenant-federation` / `shared-view-grant` / `dealer-conflict-log` |
| D2 | `channel-agent` 新增独立 agent | ✅ 批准独立 agent | `src/agent/agentSpec.js` 增 `channel-agent`；`contractIds.js` 增 `ct-channel-mgmt`；`validate-contract.mjs` 覆盖 8 agent |
| D3 | 唯一内核点 `federationReadScope`（1:N 读作用域） | ✅ 批准 | `src/federation/scope.js` + 联邦感知读 `listFederatedParticles`（`tenant_id = ANY($1)`）；普通 `scopeTenant` 读路径零改动 |
| D4 | Buddy 应用增「渠道管理」模式 | ✅ 批准增模式 | `buddy-crm-manifest.json` 增模式（本文档不含 Buddy 实现，仅预留集成契约） |
| D5 | 纯自营零侵入 | ✅ 批准惰性 + kill-switch | `federationReadScope` 无联邦配置时返回 `[actorTenant]`；`feature:dealer-portal` 总闸；回归测试 `federation_inert_for_direct_tenant` |
| D6 | HANDBOOK 两级开关 | ✅ 批准两级 | onboarding 选直营/渠道 + 运行时 `distribution_model`；`tenant-federation` 惰性创建 |

### 9.3 风险 flags
- ⚠ `federationReadScope` 注入读路径若遗漏分支 → 可能越权读他租户；须配套单测（仿 `particleRepo.tenant.test.js` 的 `cross_tenant_write_denied` 断言范式做 `cross_tenant_read_denied`）。
- ⚠ 1:N 规模下 config_store JSON 查询效率；超 1000 经销商须评估物理表（D1 后续项）。
- ⚠ `validate-contract.mjs` 须在新增 `channel-agent` 后同步补契约块，否则 CI 失败。

---

## §10 落地路径（设计→批准→writing-plans）

1. **本草案批准**（当前 brainstorming 闸门）。
2. 批准后将草案细化 → `writing-plans` 产出按功能线分组的实现计划（含 `federationReadScope`、config_store 三项、manufacturing 模板扩展、`channel-agent` 注册、RBAC 角色/闸、Buddy 模式）。
3. 每 Task 一 commit（显式路径 add，禁 `-A`），写操作过决策第 0 闸 + HITL。
4. 不动 `assembler.js` 冻结哈希（除非联邦需改 L1 注入，届时单独批准同步冻结值）。

---

## §11 对纯自营销售租户的影响保证（零侵入设计）

> 前提：纯自营销售租户 = `distribution_model='direct'`，无经销商租户、无 `tenant-federation` 配置。其直营能力是**基线（baseline）**，经销商联邦是**叠加层**，二者通过「配置存在性」解耦。

### 11.1 五道零侵入保证

| # | 保证项 | 机制 | 证据/落点 |
|---|---|---|---|
| G1 | **惰性读作用域** | `federationReadScope(actorTenant)` 当无 `tenant-federation` 配置时，返回 `[actorTenant]`，**与当前 `scopeTenant` 行为完全一致** | `src/federation/scope.js` 默认分支；读路径注入点 |
| G2 | **无粒子/表变更** | 联邦不向任何 `CRM_*` 粒子加列；直营租户数据模型零改动 | §2.1 仅 config_store；§2.2 仅扩 `MFG_*` 原型（直营租户不 seed） |
| G3 | **channel-agent 不激活** | `channel-agent` 仅在存在 `tenant-federation` 的厂商租户激活；直营租户无 dealer 可管 → 不产生 episode | `agentSpec.js` 激活条件；`validate-contract` 覆盖但运行期不触发 |
| G4 | **RBAC no-op** | `channel_manager`/`dealer_user` 角色仅在 channel 模式可分配；直营租户 dealer 管理 UI 隐藏 | `roleProfiles.js` + 前端 guard 第三层 |
| G5 | **平台级 kill-switch** | `config_store['feature:dealer-portal']`(tenant=system) 全局关 → `federationReadScope` + `channel-agent` 全平台禁用；最终 blast-radius 闸 | 全局特性开关，默认 off（新租户不自动开） |

### 11.2 回归测试（强制）
- 仿 `test/particles/particleRepo.tenant.test.js` 的 `cross_tenant_write_denied` 断言范式，新增 `cross_tenant_read_denied` / `federation_inert_for_direct_tenant` 断言：证明**合并联邦代码前后，纯直营租户的读/写行为字节级一致**。
- 该测试是「零侵入」的可执行契约，CI 必过。

### 11.3 结论
直营销售路径**永不被修改**；经销商能力是「开关打开才存在的叠加层」。即便误开 `feature:dealer-portal`，只要某租户无 `tenant-federation`，其表现与今日完全相同。

---

## §12 HANDBOOK 激活开关与设置位置（用户可选择是否启用经销商版）

### 12.1 两级开关模型
- **L1 行业 HANDBOOK 选择（onboarding 时）**：制造业 HANDBOOK 在激活步骤即分 **「直销型制造业」/「渠道分销型制造业」** 两子模——决定 seed 哪些 `MFG_*` 原型与 calculation。
- **L2 渠道运行时开关（ten_admin 可翻转）**：`tenant-profile.distribution_model`（`'direct' | 'channel'`），在租户「渠道管理」设置页可后续开启/关闭，无需重新 onboarding。

### 12.2 设置位置（推荐落点）

| 层级 | 位置 | 内容 | 落点文件 |
|---|---|---|---|
| 激活选择 | 行业上线 Runbook | 制造业激活步骤增「分销模式」单选（直营/渠道） | `docs/runbooks/2026-09-03-new-industry-onboarding.md` |
| seed 条件 | 制造业模板 | 接收 `distributionModel` 参数，channel 才 seed `MFG_DEALER`/`MFG_REBATE`/冲突 calculation | `db/seed/tenant-profile-manufacturing.js` |
| 合并裁剪 | 画像合并 | 按 `distribution_model` 裁剪原型集 | `src/config/profileMerger.js` |
| 运行时设置 | 租户「渠道管理」面板 | ten_admin 翻转开关、管理经销商准入/政策 | 新增页面（ten_admin + `createConfigLevelGate('dealer_settings', {level:'tenant'})`） |
| 平台总闸 | 全局特性开关 | `feature:dealer-portal`(system) on/off | `config_store` |

### 12.3 默认与向后兼容
- **新建制造业租户**：默认 `distribution_model='direct'`（纯自营，零联邦）。用户激活时若选「渠道分销型」才 seed 经销商原型。
- **既有已 seed 制造业租户**：保持现状（`MFG_DEALER` 等原型已在但不建 `tenant-federation`，除非用户显式开启 channel 模式并准入首个经销商）→ 向后兼容、零副作用。
- **直营 → 渠道翻转**：写 `tenant-profile.distribution_model='channel'` + 准入首个经销商时建 `tenant-federation` + 双向 `shared-view-grant`。
- **渠道 → 直营回退**：关 `feature:dealer-portal` 或清 `tenant-federation` → 叠加层消失，直营能力不受影响（G3/G5 保证）。

### 12.4 用户体验（对外口径）
「启用制造业行业包时，系统询问：贵司是**纯直销**还是**含经销商渠道分销**？选渠道分销，平台自动开通经销商门户（独立租户、返利、报备、冲突检测）；选纯直销，则完全按现有直营 CRM 运行，无任何渠道模块干扰。」

---

## §13 实施级规格（v2 新增 · 可编码）

### 13.1 `config_store` 三项联邦配置 · JSON schema

```jsonc
// tenant-federation  (tenant_id = vendor_tenant)
{
  "vendor_tenant": "acme-mfg",
  "dealers": [
    { "dealer_tenant": "acme-mfg-dl-01", "status": "active",
      "contract_ref": "MFG_DEALER#<slug>", "joined_at": "2026-09-18T10:00:00Z" }
  ],
  "created_at": "2026-09-18T10:00:00Z"
}

// shared-view-grant  (tenant_id = vendor_tenant)
[ {
  "federation_id": "acme-mfg",
  "from_tenant": "acme-mfg", "to_tenant": "acme-mfg-dl-01",
  "direction": "push",                      // push=厂商→经销商 只读视图；reflow=经销商→厂商 只读聚合
  "particle_types": ["CRM_OFFER_POLICY","CRM_PRICE_LIST","MFG_REBATE_RULE"],
  "read_only": true
}, {
  "federation_id": "acme-mfg",
  "from_tenant": "acme-mfg-dl-01", "to_tenant": "acme-mfg",
  "direction": "reflow",
  "particle_types": ["MFG_PROJECT","MFG_ORDER","MFG_CHANNEL_STOCK"],
  "read_only": true
} ]

// dealer-conflict-log  (tenant_id = vendor_tenant, append-only)
[ {
  "detected_at": "2026-09-18T11:00:00Z",
  "dealer_a": "acme-mfg-dl-01", "dealer_b": "acme-mfg-dl-02",
  "territory": "华东-苏州",
  "project_refs": ["MFG_PROJECT#<slugA>","MFG_PROJECT#<slugB>"],
  "type": "territory_conflict",
  "status": "open",
  "decision_id": "<decision_id>"
} ]
```

### 13.2 读作用域解析器（`src/federation/scope.js` · 唯一内核点）

```js
// 返回允许读取的 tenant_id 集合（数组）。无联邦配置 → 仅 [actorTenant]（与 scopeTenant 一致，零侵入）。
export async function federationReadScope(actorTenant) {
  const fed = await resolveFederation(actorTenant);   // 查 tenant-federation（actor 为厂商或经销商均命中）
  if (!fed) return [actorTenant];
  if (fed.vendor_tenant === actorTenant)              // 厂商视角：可读 N 个经销商
    return [actorTenant, ...fed.dealers.filter(d=>d.status==='active').map(d=>d.dealer_tenant)];
  const me = fed.dealers.find(d=>d.dealer_tenant===actorTenant);
  if (me) return [actorTenant, fed.vendor_tenant];     // 经销商视角：可读自身 + 厂商 push 视图
  return [actorTenant];
}
```

**读路径注入点（最小改动）**：新增 `listFederatedParticles({ types, tenantIds, limit })`（`src/federation/read.js`），用 `WHERE tenant_id = ANY($1)`；仅供联邦感知读（channel-agent 聚合、经销商看厂商视图）调用。**既有的 `listParticles(tenantId)`（单租户）保持不变** → 直营租户永不走联邦路径。

### 13.3 `dealerRoutes` HTTP API 契约（新增 `src/http/dealerRoutes.js`）

| Method | Path | 权限 | 说明 |
|---|---|---|---|
| POST | `/api/dealer-federation/onboard` | `canManageDealers`（厂商 ten_admin/channel_manager） | 建经销商租户（`assign-profile` manufacturing + `distribution_model=channel`）+ 写 `tenant-federation` + 双向 `shared-view-grant`（带 `decision_id`） |
| GET | `/api/dealer-federation/dealers` | 同上 | 列联邦内经销商 + 状态 |
| GET | `/api/dealer-federation/conflicts` | 同上 | 列 `dealer-conflict-log` |
| POST | `/api/dealer-federation/conflicts/:id/resolve` | 同上 + HITL | 仲裁（写 `dealer-conflict-log[].status=resolved` + `decision_id`） |
| POST | `/api/dealer-federation/shared-view` | 同上 | 增/改 `shared-view-grant`（policy/price 下发） |
| GET | `/api/dealer/shared-views` | `dealer_user` | 经销商读厂商 push 只读视图（走 `federationReadScope` + `listFederatedParticles`） |

> 所有写操作经决策第 0 闸 `mintDecision()` 取得 `decision_id` 后透传 `writeConfig(..., { decisionId })`（红线纪律）。

### 13.4 四序列流（核心联动）

1. **经销商准入**：厂商 `onboard` → `assign-profile(manufacturing, {distributionModel:'channel'})` 建租户 → `createFederation(vendor, [{dealer}])` + 双向 `grantSharedView` → 经销商可登录自身租户。
2. **报备回流（reflow）**：经销商在自身租户写 `MFG_PROJECT`（带 `territory`/`dealer_tenant`）→ 厂商 `channel-agent` 经 `federationReadScope(vendor)` 只读拉取 → 触发 `detectTerritoryConflict` → 命中写 `dealer-conflict-log`。
3. **冲突检测（G3+G6）**：`detectTerritoryConflict(vendor, newProject)` 扫描 N 个经销商同 `territory` 的 `MFG_PROJECT` → 比对 `dealer_tenant` 归属 → 跨经销商命中则记冲突（自动仲裁替代人工报备）。
4. **返利结算**：厂商读各经销商 `MFG_ORDER`/`MFG_REBATE`（reflow）→ 跑 `rebate_amount` calculation → 写厂商侧 `MFG_REBATE`（状态 pending→calculated→approved，带 `decision_id`）。

### 13.5 `channel-agent` 职责与 action（厂商侧，autonomy=recommend）

- 职责：经销商准入、返利结算、冲突检测触发、政策/价表下发。
- 注册：agentSpec.js 六段式 + contractIds.js `'channel-agent':'ct-channel-mgmt'`。
- 复用：读 `decision-retro`/`review-gate`；evaluator `channel_mgmt_quality`。
- 决策：准入/结算/冲突裁决走既有审批流 R 链 + `decision_id`。

### 13.6 测试计划（强制 · 守护零侵入与越权）

| 测试文件 | 断言 |
|---|---|
| `test/federation/scope.test.js` | ① 无联邦配置 → `federationReadScope(t)` 返回 `[t]`；② 厂商返回 `[vendor, ...dealers]`；③ 经销商返回 `[dealer, vendor]`；④ `feature:dealer-portal=off` 全返回 `[t]` |
| `test/federation/config.test.js` | `createFederation`/`grantSharedView`/`addConflict` 写后可读；`decision_id` 必填校验 |
| `test/federation/conflict.test.js` | 同 territory 跨经销商 → 记冲突；异 territory → 不记 |
| `test/federation/read.test.js` | `listFederatedParticles` 仅返回 `tenantIds` 内数据；越权租户（不在集合）→ 0 行（`cross_tenant_read_denied` 语义） |
| `test/federation/inert.test.js` | **零侵入契约**：直营租户在联邦代码前后读/写行为字节级一致（`federation_inert_for_direct_tenant`） |

### 13.7 落地任务分解（writing-plans 摘要 · 每 Task 一 commit）

- **T1 联邦核心**：`src/federation/{scope,config,read,conflict}.js` + 单测（L1）
- **T2 RBAC + 角色**：`roleProfiles.js` 增 `channel_manager`/`dealer_user`；`rbac.js` 增 `canManageDealers` + `isFeatureOn`
- **T3 准入端点**：`src/http/dealerRoutes.js` + 挂载到 `http/index`；`mintDecision` 第 0 闸
- **T4 channel-agent 注册**：`agentSpec.js`/`contractIds.js` + `validate-contract` 覆盖 8
- **T5 制造业种子扩展**：`tenant-profile-manufacturing.js` 增 `parent_vendor`/`territory`/`dealer_tenant` + `conflict_check` calc + `distributionModel` 参数
- **T6 kill-switch + 回归**：`feature:dealer-portal` 默认 off + `inert.test.js`
- **T7 Buddy 集成（已落地）**：`buddy-crm-manifest.json` 增「渠道管理」workMode（id `channel`）+ 4 胶囊（经销商准入 / 共享视图 / 撞单监控 / 渠道政策），图标 assets/modes/mode-channel.svg + assets/capsules/{dealer-onboard,shared-view,conflict-monitor,channel-policy}.svg；复用真实技能 `crm-native`/`crm-query`，诚实描述联邦后端能力边界（写动作走「渠道管理」设置页）

---

## §14 实现状态（v2 → 已落地核心层）

> 2026-09-18 本轮已落地 T1–T8 全栈（核心层 40 单测全绿 + Buddy「渠道管理」模式 + 渠道管理设置页 + 端到端联调）。T7 为厂商侧渠道经理视图，与经销商侧对话入口 `dealer-sales-partner` 专家包（独立插件）分工明确。
>
> **T8 补充落地（18:55）**：`src/web/channel-admin.html`（厂商 ten_admin 面板，5 TAB：总览/经销商准入/经销商列表/共享视图/撞单监控，ui-lint 零违规）；`scripts/integration-dealer-portal.mjs`（真实 DB 端到端联调，15 断言全绿：联邦写/1:N 读作用域/惰性零侵入/撞单检测/仲裁/跨租户写拦截）；修复 `dealerRoutes.js` 经销商共享视图假绿（`federationReadScope` 返回数组，原误读对象字段→恒空），新增 `test/http/dealerRoutes.sharedView.test.js` 锁死。
>
> ⚠ API 路径说明：实现按真实路径 `/api/dealers/*`（§13.3 草案中的 `/api/dealer-federation/*` 未采用，联调/页面均按真实路径）。

| 任务 | 产物 | 状态 |
|---|---|---|
| T1 联邦核心 | `src/federation/{scope,config,read,conflict}.js` + `test/federation/*`（25 测试） | ✅ 已落地 |
| T2 RBAC + 角色 | `src/rbac.js`（`canManageDealers`/`isFeatureOn`）+ `src/context/roleProfiles.js`（`channel_manager`/`dealer_user`）+ `test/rbac.test.js` | ✅ 已落地 |
| T3 准入端点 | `src/http/dealerRoutes.js`（6 端点）+ `src/http/server.js` 挂载 + `test/http/dealerRoutes.test.js`（6 测试） | ✅ 已落地 |
| T4 channel-agent | `src/agent/agentSpec.js`（`channel-agent`）+ `src/agent/contractIds.js`（`ct-channel-mgmt`）+ 设计文档契约块 | ✅ 已落地（validate-contract 通过） |
| T5 制造业种子 | `db/seed/tenant-profile-manufacturing.js`（`distributionModel` 参数 + `parent_vendor`/`dealer_tenant` + `conflict_check`） | ✅ 已落地 |
| T6 kill-switch + 回归 | `feature:dealer-portal` 默认 off + `test/federation/inert.test.js`（字节级零侵入） | ✅ 已落地 |
| T7 Buddy 集成 | `buddy-crm-manifest.json` 增「渠道管理」workMode + 4 胶囊 + 5 图标 | ✅ 已落地 |
| T8 设置页 + 联调 | `src/web/channel-admin.html`（厂商面板 5 TAB）+ `scripts/integration-dealer-portal.mjs`（真实 DB 联调）+ `layoutMenu.js` 菜单入口（`roles:['ten_admin','channel_manager']`） | ✅ 已落地 |

**验证证据**：
- `scripts/validate-contract.mjs docs/2026-09-18-dealer-portal-design.md` → `{"valid":true,"errors":[]}`
- `vitest run test/federation test/rbac.test.js test/http/dealerRoutes.test.js test/http/dealerRoutes.sharedView.test.js` → 40 passed（T8 新增 2）
- `node scripts/integration-dealer-portal.mjs` → 15/15 断言全绿（真实 DB crm_native@localhost:5433，隔离 it_* 租户）
- `node scripts/ui-lint.mjs` → channel-admin.html 零违规（全库既有 68 处违规均属历史文件，与 T8 无关）
- `node --check` 全新增/编辑文件语法通过

**约束遵守**：零新 `CRM_*` 粒子（守 2026-09-08 §10）；联邦全落 `config_store`；跨租户只读（写仍由 `cross_tenant_write_denied` 兜底）；决策第 0 闸 `decision_id` 透传；禁 DELETE。

---

*本设计 v2 已批准，进入开发落地；实现遵守每 Task 一 commit、写操作过决策第 0 闸 + HITL、零新 `CRM_*` 粒子类型。*
