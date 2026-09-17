# 企业AI销售决策平台 —— CordysCRM 借鉴清单综合实施详设

> 配套文档：
> - 上游选型：`docs/2026-08-24-ai-native-sales-crm-design.md` §4（机制范式借鉴）+ §5bis（深度借鉴清单 A/B/C + E/F/G/H 发布实证）
> - 上游映射：`docs/2026-08-24-ai-native-sales-crm-design.md` §5ter-quater（§5ter 业务域 × 10 大能力映射，D1-D12 理念差异）
> - 总体架构：`docs/2026-08-25-ai-native-crm-overall-design.md`（四平面 + §3 粒子全景 + §4 读写双通道 + §5 三阶段 + §6 决策事件主轴 + §6.13 对话式智能体包）
> - 落地文档：`docs/2026-08-25-cordyscrm-adoption-plan.md`（30 文件逐组件拆解：全部借设计、换 transport）
> - 能力实例化：`docs/2026-08-25-0X-ai-*.md`（10 大能力，X=01..10）
> - 实现基线：`src/particles/`、`src/action/`、`src/decision/`、`src/events/`、`src/ontology/`、`src/agent/`、`src/kanban/`、`src/context/`、`src/portal/`（阶段 1 已落地，标注「已有」）
>
> 状态：**设计稿（待用户批准后进入 writing-plans）**
> 范围：把用户确认的「全部借鉴点」收敛为**一份实施级综合详设**——每个借鉴点给出「实证 → 原生机制 → 粒子/Schema → Action 表面 → 状态机 → 事件/预警 → 落地阶段 → 验收判据」八段式。

---

## §0 总纲：三句话定位

1. **借鉴什么**：CordysCRM 的**业务机制**（销售业务逻辑层 §5bis B + 发布实证 E/F/G/H）与**配置界面范式**（界面设置层 §5bis A/C）——不是它的页面、不是它的技术栈、不是它的动态字段表。
2. **怎么借鉴**：每个借鉴点映射为 AI 原生的**原生内建机制**（粒子/状态机/规则闸/事件源/配置协议），而非「外挂功能」。对照 §5ter-quater 的 D1-D12：官方「外层封装」，我们「原生内建」。
3. **落在哪**：全部纳入阶段 2（认知+智能体层：审批流引擎、规则闸、待办工作台）+ 阶段 3（业务闭环增量：商机状态机、池规则、回款闭环、跟进闭环、定价链路、导入 upsert）。阶段 1 底座已实现的（粒子底座/状态机/Action 闸/SSE/预警扫描件），直接复用，不重写。

**覆盖承诺**：本文档对 §4 + §5bis A/B/C/E/F/G/H 的全部借鉴点逐条给出落地设计；每一条都回答「我们如何实现对应能力」（§5ter 吸收基线要求）。

---

## §1 借鉴点全集清单（8 组 · 30 条）

| 组 | # | 借鉴点（§5bis 出处） | 原生机制分类 | 落地阶段 |
|---|---|---|---|---|
| **A 界面设置层** | A1 | 动态表单配置抽屉（customFormConfigDrawer + memberPermissionTab） | 粒子属性元模型 UI | 阶段 2/3 |
| | A2 | 用户视图配置（sys_user_view + UserViewCondition） | 视图=检索条件物化 | 阶段 2 |
| | A3 | 数据脱敏配置（desensitizationModal） | output guard 字段级脱敏 | 阶段 2 |
| | A4 | 容量/池配置（capacitySetDrawer / addOrEditPoolDrawer） | 池=组织治理配置 | 阶段 3 |
| **B 销售业务逻辑层** | B5 | 商机阶段-赢率-回退控制（opportunity_stage_config） | 商机粒子状态机 + 赢率预测 | 阶段 3 |
| | B6 | 线索池领取/回收规则（clue_pool_pick_rule / recycle_rule） | 池事件源 + 回收 Action | 阶段 3 |
| | B7 | 商机/合同规则引擎（opportunity_rule + business-rules） | AI 写操作护栏（规则闸前置） | 阶段 2 |
| | B8 | 回款计划+记录+发票+工商抬头（contract_payment_plan / record / invoice / business_title） | L2C 财务闭环 | 阶段 3 |
| **C 补充勘察** | C9 | 审批流设计器（frontend process 组件 5 Tab + flow 变换/校验） | 审批粒子域可视化配置 | 阶段 2 |
| | C10 | 安全底座（ShiroFilter + SessionUser + FileAccessTokenUtils + ApiKeyFilter） | 文件级鉴权 + 免登录直连 | 阶段 2 |
| | C11 | 跟进域（FollowUpPlan → Record → Comment → @提及） | 跟进粒子 + 记忆流 + 协作事件 | 阶段 2/3 |
| | C12 | 产品域（Product + ProductPrice + 报价关联） | 报价粒子三级定价 | 阶段 3 |
| **E 发布实证 v1.4** | E13 | 合同独立模块 + 内置审批 | 合同粒子 + 审批生命周期 | 阶段 3 |
| | E14 | 报价单 + 金额计算规则（定价×折扣×税点） | 报价粒子 + 写时金额计算 | 阶段 3 |
| | E15 | 价格表（多定价 + 有效期 + 权限 + 变更日志） | 价格配置粒子 + 审计事件流 | 阶段 3 |
| | E16 | 标讯模块（大单网订阅/推送） | 外部事件源连接器 | 阶段 3 |
| **F 发布实证 v1.5** | F17 | 回款记录（金额/时间/凭证/关联） | 回款记录粒子（实回） | 阶段 3 |
| | F18 | 工商抬头管理 + 企查查联动 | 客户工商粒子 + 写时校验连接器 | 阶段 3 |
| | F19 | 发票全生命周期（类型/号码/金额/附件/对账） | 发票粒子 + 对账核销闭环 | 阶段 3 |
| | F20 | 表单/通知/检索工程细节 | 子表格扩展/字段联动/通知通道/搜索权限 | 阶段 3 |
| **G 发布实证 v1.7** | G21 | 审批流 = 一等公民覆盖四大模块 | **可配置审批流引擎（HITL 闸）** | 阶段 2/3 |
| | G22 | 审批流四类配置项（条件分支/审批模式/字段权限/结果动作） | 审批流规则模型 | 阶段 2 |
| | G23 | 审批节点状态×操作矩阵 + 审批记录 | 审批状态机 + 审计事件流 | 阶段 2 |
| | G24 | 「我的待办」工作台（四视角 + 批量） | 门户默认页（待办聚合） | 阶段 2 |
| | G25 | 合同/订单阶段看板 + 导出优化 + 安全修复 | 业务对象看板视图 + 批量导出 + 输入净化 | 阶段 2/3 |
| **H 发布实证 v1.8** | H26 | 移动端审批（我的待办 + 就地审批 + 加签/退回） | 移动端门户 + 审批 Action 移动适配 | 阶段 2/3 |
| | H27 | 导入 upsert 双模式（按唯一 ID） | 批量写粒子 Action（幂等） | 阶段 3 |
| | H28 | 审批流数据回滚 + 抄送通知 + 字段扩展 | 写粒子的补偿机制 | 阶段 2 |
| | H29 | 功能优化/修复（子表格/人员选择器/偏好记忆/多池/跳转） | 门户组件 + 记忆偏好 + 多池 | 阶段 3 |

> 30 条中**最高优先级 3 条**（阶段 2 先落地）：**G21 审批流引擎**（HITL 闸核心）、**G22 审批流规则模型**（四类配置项）、**B7 写操作规则闸**（AI 写护栏）。三者构成阶段 2 的「写通道第二/第三闸」完整闭环。

---

## §2 A 组：界面设置层（4 条）→ 门户生成配置协议

> 定位：这 4 个「配置界面」**不是要我们做 4 个固定页面**，而是证明「**一个受控配置协议 = 人配置界面 + AI 生成界面共用**」（§5ter-quater D9）。全部并入 `ai-portal-page-generation`（阶段 2 门户能力）。

### A1 动态表单配置抽屉 → 粒子属性元模型的 UI 呈现

**实证**：配置表单字段 → 实时渲染 → 成员权限分栏（customFormConfigDrawer + memberPermissionTab）。

**原生机制**：粒子属性元模型（§6.13 已定「配置=Schema，运行时渲染」）。

| 借鉴点 | 我们实现 |
|---|---|
| 表单字段配置 | 粒子 `coreAttributes` 的类型集（19 类型，阶段 1 已实现 `ATTRIBUTE_TYPE_SET`）即字段定义的唯一事实源 |
| 实时渲染 | 门户渲染器读属性元模型 → 动态渲染表单（`src/portal/` 渲染器） |
| 成员权限分栏 | 字段级 RBAC：属性元模型上挂 `fieldPermission`（隐藏/查看/编辑，对角色）→ 写闸校验时逐字段检查 |

**实施落点**（阶段 2/3）：
- 新增 `crm-field-permission` 查询 Action / `data-particle-attr-update` 写 Action（写元模型过闸）。
- 门户「字段配置页」= 读粒子元模型 → Schema 渲染（非写死表单）。

### A2 用户视图配置 → 视图 = 检索条件物化

**实证**：sys_user_view + UserViewCondition = 用户自定义视图（资源类型 + 条件集 AND/OR + 固定视图 + 启用）。

**原生机制**：视图 = 粒子查询条件的持久化（§5ter-quater Q.14）。AI 上下文注入可直接复用「视图 = 可配置过滤器」模型。

**实施落点**（阶段 2）：
- 新增 `CRM_VIEW` 支撑粒子（type: crm-view，属性：resourceType + conditions[AND/OR] + isFixed + enabled）。
- 查询 Action 参数 `viewId` 直接引用视图粒子（阶段 1 已内置 `viewId:SELF` 概念，扩展为可配置视图）。
- 「视图配置页」= 读/写 VIEW 粒子 + Schema 渲染。

### A3 数据脱敏配置 → output guard 字段级脱敏

**实证**：desensitizationModal = 字段级脱敏配置界面。

**原生机制**：output guard 的脱敏规则（§5ter-quater Q.13：脱敏=输出管道机制，非提示词红线）。

**实施落点**（阶段 2）：
- `output-guard`（已从 P2P 迁移）的脱敏规则表扩展为「字段级脱敏规则」（如：手机号中间 4 位、合同金额部分展示）。
- **铁律：AI 输出管道强制脱敏，不靠提示词**——输出 guard 在出口统一执行。
- 「脱敏配置页」= 读写脱敏规则粒子（支撑粒子 `CRM_MASK_RULE`）+ Schema 渲染。

### A4 容量/池配置 → 池 = 组织治理配置

**实证**：capacitySetDrawer / addOrEditPoolDrawer = 线索池/公海容量配额 + 池配置界面。

**原生机制**：池不是独立表（§5ter-quater D3：池 = 粒子集合视图），容量配额是**组织治理配置**（organization 的池配置属性）。

**实施落点**（阶段 3）：
- 池配置（领取/回收/容量）挂在 `CRM_ORGANIZATION` 粒子的 `poolConfig` 属性（阶段 1 已实现 `CRM_ORGANIZATION`，`why: 'pool_rule_reason'`）。
- 「池配置页」= 读组织粒子池配置 + Schema 渲染。

---

## §3 B 组：销售业务逻辑层（4 条）→ 原生业务机制

> 定位：**价值最高的借鉴组**（§5bis B 原文「价值最高，AI 原生应原生内建」）。这 4 条的机制（状态机/规则引擎/生命周期/财务闭环）是阶段 3 业务闭环的机制输入。

### B5 商机阶段-赢率-回退控制 → 商机粒子状态机 + 赢率预测

**实证**：opportunity_stage_config 字段 = name（阶段名）+ type + rate（赢率）+ afootRollBack（进行中回退）+ endRollBack（完结回退）+ pos（顺序）——每个阶段可配赢率（预测量）、可配是否允许回退（防作弊/误操作）。「商机只能向前推进，不能回退（除非管理员）」（business-rules 实证）。

**原生机制**：状态机 = 粒子内建属性（§5ter-quater Q.3：不是旁路规则）。

**粒子 Schema**（阶段 3 新增业务粒子）：

```
CRM_DEAL 粒子（阶段 1 已有）扩展：
  payload.stage_config: [                     // 阶段配置（B5 实证）
    { stage: 'lead',          win_rate: 0.10, allow_back: false },
    { stage: 'opportunity',   win_rate: 0.40, allow_back: false },
    { stage: 'quoted',        win_rate: 0.60, allow_back: false },
    { stage: 'contracted',    win_rate: 0.85, allow_back: false },
    { stage: 'ordered',       win_rate: 0.95, allow_back: false },
    { stage: 'paid',          win_rate: 1.00, allow_back: false },
    { stage: 'lost',          win_rate: 0.00, allow_back: false },
  ]
  payload.afoot_rollback: false   // 进行中是否可回退（默认否）
  payload.end_rollback: false     // 完结是否可回退（默认否，赢单不可回退）
  payload.expected_end: date      // 预计结束（§5bis 功能实证）
  payload.actual_end: date        // 实际结束
```

**状态机**：`CRM_DEAL` 阶段只进不退（阶段 1 lifecycle 已实现：DEAL 状态机只进不退 + 终态保护）。回退 = **特权 Action**（仅管理员角色白名单）——对应「除非管理员」。

**Action 表面**：
- `crm-deal-advance`（已有，阶段 1）：只进不退，规则闸校验合法迁移。
- `crm-deal-rollback`（阶段 3 新增，**特权写**）：仅 `admin` 角色可调，`confirm: 'critical'`，需带 reason。

**预警事件**（B5 联动 §5bis 功能实证 + ai-feedback-loop）：
- 阶段卡顿（某阶段停留超阈值）→ `deal_stuck` 预警（阶段 2 已有 risk-engine 规则）。
- 预期 vs 实际结束时间对比 → 预测准确率回灌（「预计结束/实际结束」对账）。

**验收判据**：① 商机只能向后续阶段迁移（非管理员回退被规则闸拒绝）；② 每阶段赢率可读（funnel 聚合可算概率加权管道）；③ 管理员回退动作带 reason 留痕（决策事件流）。

### B6 线索池领取/回收规则 → 池事件源 + 回收 Action

**实证**：PickRule（限每日领取数量 + 限前归属人领取 + 领取间隔 + 限新数据）、RecycleRule（operator + condition 可配置回收条件）——「超期未跟进自动回收」= 主动预警机制来源。

**原生机制**：池 = 粒子集合视图 + 领取/回收 = 事件驱动 Action（§5ter-quater D3/D4）。

**粒子 Schema**（阶段 3）：

```
CRM_LEAD（线索粒子，阶段 3 新增）：
  payload.owner: actor-ref        // 当前归属人
  payload.pool_id: ref           // 所属池（可指定目标池，H29 多池实证）
  payload.last_follow_up: date   // 最近跟进时间（回收判据）

池配置（挂在 CRM_ORGANIZATION.poolConfig，阶段 1 已有组织粒子）：
  poolConfig.pick_rule: { daily_limit: 10, prev_owner_only: false, pick_interval_hours: 24, new_data_only: true }
  poolConfig.recycle_rule: { operator: 'GT', condition: 'last_follow_up_age_days > 30' }
```

**Action 表面**：
- `crm-lead-pick`（阶段 3，写）：领取（校验每日限额/间隔/新数据）——受控 Action。
- `crm-lead-recycle`（阶段 3，写）：回收（超期未跟进自动触发）——**事件驱动**（scheduler 扫描 → 预警事件 → 回收 Action）。

**事件/预警**（B6 = 第一个「主动预警机制来源」）：
- `lead_overdue`：超期未跟进（>30 天）→ 事件总线 → 触发回收（§5ter-quater Q.1：预警+回收一体化，事件进审计/反馈闭环）。

**验收判据**：① 领取 Action 校验池规则（超限拒绝）；② 超期未跟进线索自动回收（scheduler 扫描事件触发）；③ 回收动作进事件总线（可审计）。

### B7 商机/合同规则引擎 → AI 写操作护栏（规则闸前置）

**实证**：OpportunityRule = scope（范围）+ operator（操作符）+ condition（条件）+ auto（自动）+ enable——「范围+条件+动作」的可配置规则引擎。business-rules 实证：「合同金额修改超 20% 需经理审批」「商机只能向前」「赢单不可回退、输单必须填原因」。

**原生机制**：规则 = 事件触发的预警/写护栏（§5ter-quater Q.3：规则不是旁路，是能力机制的一部分）。

**实施落点**（阶段 2，已有规则闸底座，扩展为可配置规则）：
- 阶段 1 已实现 `ruleEngine.js`（只进不退 + 输单必填原因）。
- 阶段 2 新增 `CRM_RULE` 支撑粒子（scope + operator + condition + action + enable）——规则可配置（非硬编码）。
- **写通道第 2 闸接线**：每次写 Action 执行前，先过规则层（§4 写通道三闸：规则层 → action-confirm → HITL 审批流）。
- 金额超阈值自动触发审批（例：合同金额修改超 20% → 自动挂 HITL 闸，对应 G22 条件分支）。

**验收判据**：① 新增规则粒子后可动态启停规则（不重启）；② 写操作过规则闸（违反规则被拒）；③ 超阈值写自动升级审批（联动 G21）。

### B8 回款计划+记录+发票+工商抬头 → L2C 财务闭环

**实证**：ContractPaymentPlan（planAmount 计划金额 + planEndTime 计划回款时间 + planStatus）、ContractStageConfig（afootRollBack/endRollBack/流通类型 NORMAL-ADVANCED）。「计划（应回）→ 记录（实回）→ 逾期判断（计划时间 vs 实际）」= 回款逾期预警判定依据。

**原生机制**：双粒子 + 本体边（§5ter-quater Q.7：对账 = 反馈闭环的核心环节）+ 财务闭环四对象。

**粒子 Schema**（阶段 3）：

```
CRM_PAYMENT_PLAN（回款计划，应回侧）：
  payload: { contract_id: ref, plan_amount: currency, plan_end: date, plan_status: 'pending|partial|done' }
CRM_PAYMENT_RECORD（回款记录，实回侧）：
  payload: { contract_id: ref, paid_amount: currency, paid_at: timestamp, voucher: attachment }
CRM_INVOICE（发票）：
  payload: { invoice_type, invoice_no, invoice_amount, invoice_date, contract_id, customer_id, attachments, reconcile_status: 'open|reconciled' }
CRM_ACCOUNT 扩展（工商抬头）：
  payload.business_title: { title, credit_code, reg_address, legal_person }
```

**对账机制**（ai-feedback-loop 第二核心落点）：
- 「应回 vs 实回」差额 = `plan_amount - Σpaid` → 逾期指标 → 预警/催收 Action（自动触发）。
- 发票对账核销：`reconcile_status`（开票 → 回款 → 核销闭环，F19）。

**事件/预警**：
- `payment_due`：回款逾期（计划时间已过且实回不足）→ 财务预警 + 催收优先级排序。

**验收判据**：① 计划 vs 记录可对账（差额/逾期指标可算）；② 逾期自动触发催收预警（事件源）；③ 发票核销闭环（开票→回款→对账可追踪）。

---

## §4 C 组：补充勘察（4 条）→ 审批域 / 安全底座 / 跟进 / 定价

### C9 审批流设计器 → 审批粒子域可视化配置（并 §3 G21 引擎）

**实证**：approval-node 五 Tab（approverSettingTab 审批人 / formPermissionTab 表单字段权限 / afterApprovalTab 审批后动作 / approvalLevelExamplePopover 多级示例 / approvalMemberSelector 成员选择）+ flow（条件描述/变换/校验）+ setConditionDrawer（条件分支配置抽屉）。与后端 ApprovalNodeApprover 一一对应（approvalType MANUAL/AUTO_PASS/AUTO_REJECT、multiApproverMode ALL/ANY/SEQUENTIAL、emptyApproverAction、sameSubmitterAction、approverType、approverDirection、ccType/ccDirection/ccList、passPostConfig/rejectPostConfig、fieldPermissions）。

**原生机制**：审批流 = 粒子域六层结构 + 可视化配置 = 粒子域的编辑形态（§5ter-quater Q.11/Q.14）。

**实施落点**（阶段 2/3）：并入 §G21 审批流引擎详设（§7 主章）。可视化设计器 = 粒子域配置的读/写 + Schema 渲染（A1 同一受控协议）。

### C10 安全底座 → 文件级鉴权 + 免登录直连

**实证**：ShiroFilter 链（静态 anon → 认证 anon → 附件预览 attachmentAuth）、FileAccessTokenUtils（F_A_TOKEN Cookie AES 加密 sessionId 生成/校验/设置/删除）、SessionUser（CSRF Token + sessionId）、ApiKeyFilter（API Key 请求免账号密码登录，请求结束即 logout）。

**原生机制**：
- 文件级鉴权（F_A_TOKEN 短令牌）→ AI 「Agent 代取附件」的文件级访问控制（output guard + 权限层）。
- ApiKeyFilter 双通道 = §6.4 免登录直连的工程化实证（短期令牌替代密码会话，请求结束即注销）→ 我们映射为 OAuth2/JWT 短期令牌 + 每请求独立鉴权。
- SessionUser CSRF Token = 写操作防伪造（action-confirm 前 CSRF 校验）。

**实施落点**（阶段 2）：① 附件访问走短期令牌（Agent 代取需授权，禁密钥暴露）；② 对外技能协议「读默认直连 + 写显式过闸」（§6.4，已批准）；③ 写 Action 前 CSRF 校验（已有决策第 0 闸，加 CSRF 前置）。

**验收判据**：① 无令牌不能取附件（文件级鉴权生效）；② 外部智能体免登录只读直连可工作；③ 写操作无 CSRF 令牌被拒。

### C11 跟进域 → 跟进粒子 + 记忆流 + 协作事件

**实证**：FollowUpPlan（customerId/opportunityId/clueId + owner + contactId + estimatedTime + method + status PREPARED/UNDERWAY/COMPLETED/CANCELLED + converted 是否转为跟进记录 + commentCount）、FollowUpPlanType（CUSTOMER/CLUE）、FollowUpPlanService.cancelPlan/updateStatus 终态保护（「已完成且已转化的计划不允许取消/不允许改状态」FollowUpPlanService:348/:391）、Comment（resourceId + parentId 顶层 + replyToUserId + content）、CommentMention（commentId + userId = @提及）。

**原生机制**：跟进粒子 + 状态机（计划→记录 = 合法迁移）+ 评论进记忆流 + @提及 = 协作提醒事件源（§5ter-quater Q.10：跟进即记忆）。

**粒子 Schema**（阶段 2/3）：

```
CRM_FOLLOW_UP（跟进计划，多对象绑定）：
  payload: { target_type: 'CRM_DEAL|CRM_ACCOUNT|CRM_LEAD', target_id: ref,
             owner: actor-ref, contact_id: ref, estimated_time: timestamp,
             method: 'PHONE|MEETING|EMAIL|ONLINE', status: 'PREPARED|UNDERWAY|COMPLETED|CANCELLED',
             converted: false }        // 是否已转为跟进记录

跟进记录（实跟侧）= CRM_FOLLOW_UP 粒子转态 + 追加记录内容（converted=true + record_content）
```

**状态机**：计划→记录合法迁移 + **终态保护**（已完成且已转化 → 不允许取消/改状态）——状态机内建（AI 写操作护栏）。

**评论/@提及**：
- 评论 = 粒子的事件/记忆流（parentId 树 → 记忆可检索/总结/AI 引用跨会话）。
- @提及 = 协作提醒事件源（事件总线 → 被提及角色上下文注入 + 通知，对应 H 抄送通知）。

**验收判据**：① 计划→记录转化是一次受控迁移（带 converted 标记）；② 已完成且已转化的计划取消被状态机拒绝；③ @提及触发协作事件（被提及人获得上下文）。

### C12 产品域 → 报价粒子三级定价（升级为四级：§E15）

**实证**：Product（name + price 单价 @DecimalMin/@DecimalMax 校验 + status + pos）、ProductPrice 价格表（name + status + pos）+ ProductPriceField 自定义属性（BaseResourceSubField）、OpportunityQuotation（name + opportunityId + untilTime 有效期 + amount 累计金额 + approvalStatus + invalid 作废 + approved 是否审批通过过）、报价单内嵌产品明细 `List<Map<String,Object>> products`。

**原生机制**：产品 → 价格表 → 报价单三级定价（§5ter-quater Q.17 升级为四级：产品 → 价格表 → 报价单 → 合同）。

**粒子 Schema**（阶段 3）：

```
CRM_PRODUCT（已有，阶段 1）：
  payload: { name, price 单价, status: 'on_sale|discontinued', pos }
CRM_PRICE_LIST（已有，阶段 1）：
  payload: { name, status: 'draft|active|expired', valid_from, valid_to, products[] }   // 多套定价
CRM_QUOTATION（报价，阶段 3）：
  payload: { deal_id: ref, name, valid_until: date, amount: currency(自动计算),
             items: [{ product_id, price_list_id, qty, unit_price, discount, tax }],
             approval_status: 'draft|submitted|approved|rejected', invalid: false }
```

**金额计算规则**（写时计算管线）：`amount = Σ(unit_price × qty × (1-discount) × (1+tax))`——**写时自动计算，非手填**（§5ter-quater Q.5：金额计算是粒子写管线的一部分 + 写后验证 sum=明细）。

**事件**：报价提交 → `crm-quote-submit`（写 Action）→ HITL 审批流（G21，四大审批域之一）。

**验收判据**：① 报价金额自动计算（写后验证 sum=明细）；② 价格表多套定价可配置（有效期/权限）；③ 报价提交走审批流（联动 G21）。

---

## §5 E/F 组：发布实证（业务对象层完整化）

> 定位：E13-E16（v1.4）+ F17-F20（v1.5）是**业务对象层能力实证**——把 §4 C12 从「三级定价」升级为「四级模型」，把合同域从「对象」升级为「财务闭环承载对象」。

### E13 合同独立模块 + 内置审批 → 合同粒子 + 审批生命周期

**实证**：合同与报价单或商机关联（销售信息自动同步）+ 内置简易审批流程（提交→有权限用户审批→消息通知回传）+ 合同表单可自定义配置。

**原生机制**：合同 = 独立业务对象（非商机附属）+ 关联报价/商机 + 自带审批生命周期 + 表单元模型可配置。合同是 L2C 中「审批流 + 回款计划」的**承载对象**。

**粒子 Schema**（阶段 3）：

```
CRM_CONTRACT（合同粒子）：
  payload: { deal_id: ref, quotation_id: ref, contract_no, amount: currency,
             start_date, end_date, stage: 'draft|submitted|approved|rejected|effective|expired',
             approval_status, approval_flow_id: ref }
  edges: has_payment_plan → CRM_PAYMENT_PLAN, has_payment_record → CRM_PAYMENT_RECORD,
         has_invoice → CRM_INVOICE, has_business_title → CRM_ACCOUNT, has_quotation → CRM_QUOTATION
```

**Action 表面**：`crm-contract-submit`（写 → HITL 闸）、`crm-contract-approve`（审批 Action）——对应第 0 闸（无决策不写，决策事件主轴）。

**验收判据**：① 合同独立粒子可建（不依赖商机）；② 合同提交走审批流；③ 二级资源（回款/抬头/发票）挂合同边可追踪。

### E14 报价单金额计算规则 → 报价粒子写时计算（§C12 已覆盖，此处补充）

**实证**：金额计算规则（对产品定价、折扣、税点等要素通过运算符组合实现金额计算规则调整）+ 报价单关联价格表自动填充 + 报价单关联商机/合同双向。

**补充落点**：金额计算规则 = **可配置的运算符组合**（不是硬编码公式）：规则粒子 `CRM_CALC_RULE`（field + operator + operand 组合）——报价写时按规则计算，规则可配置。报价单可关联商机与合同（双向本体边）。

### E15 价格表 → 定价级联模型（三级 → 四级） + 审计事件流

**实证**：同一产品多套定价（不同场景精准价格）、价格有效期（time-limited）、价格权限管控、价格变更日志（保留变更记录）、关联产品价格自动同步。

**原生机制**：定价 = 四级链（产品 → 价格表 N 套定价 → 报价单自动填充+金额计算 → 合同）+ **价格变更日志 = ai-capability-audit 审计输入**（价格谁改的、何时改的、改前改后）。

**实施落点**（阶段 3）：
- `CRM_PRICE_LIST` 扩展：valid_from/valid_to、permission（价格权限）、change_log（变更日志数组）。
- 价格变更 → 事件总线（audit 事件：before/after + actor + timestamp）→ 审计闭环。
- 价格自动同步：价变联动事件 → 引用处刷新（§5ter-quater Q.4）。

**验收判据**：① 价格表多套定价 + 有效期生效；② 价格变更留痕（审计事件流）；③ 报价自动取价。

### E16 标讯模块 → 外部事件源连接器

**实证**：内嵌「大单网」标讯平台：按关键词、区域搜索或订阅标讯；订阅后自动推送匹配招标信息（辅助线索挖掘/市场趋势分析/投标定价）。

**原生机制**：线索挖掘 = 「外部标讯源（订阅 + 自动推送）→ 筛选匹配 → 生成线索/预警商机」管道 = `ai-event-driven-evolution` 主动预警事件源（标讯订阅 = 定时任务事件触发器）+ `crm-lead` 线索生成 Action（§5ter-quater Q.12：外部事件源 = 连接器组件）。

**实施落点**（阶段 3）：
- 连接器组件（外部标讯源）+ 事件总线（标讯推送事件）→ `tender_push` 事件 → 自动生成 LEAD 粒子 / 预警商机。
- 「关键词/区域」订阅条件 = 组织区域维度（呼应 region 维度）。

**验收判据**：① 订阅条件可配置（关键词/区域）；② 匹配标讯自动生成线索（事件驱动）；③ 外部事件进总线（审计）。

### F17 回款记录 → 回款粒子「实回」层（§B8 已覆盖，此处补充凭证）

**实证**：录入每笔回款金额、时间、关联合同；自动关联客户、合同、订单；留存凭证、实时追踪回款进度、降低坏账风险；合同详情可查全部回款记录。

**补充落点**：回款记录粒子带 **voucher 凭证附件**（记忆三构件：凭证 = 计划/记录粒子的记忆——事件 + 附件快照，可被 AI 引用/审计追溯）+ 合同详情聚合视图（合同 → 全部回款记录）。

### F18 工商抬头 + 企查查联动 → 写时校验连接器

**实证**：录入/存储/核验客户完整工商抬头、统一社会信用代码、注册地址、法定代表人；支持与企查查、爱企查第三方平台联动，自动同步与校验企业工商信息。

**原生机制**：客户粒子承载工商抬头实体 + 第三方工商数据源（连接器）+ **写时校验**（唯一信用代码校验 + 同步，`ai-ontology-vector-build` 写时校验实证——外部数据进库前先核验，防脏数据污染本体）。

**实施落点**（阶段 3）：
- `CRM_ACCOUNT` 扩展 business_title（title/credit_code/reg_address/legal_person）。
- 连接器（企查查型工商数据源）+ 写时校验闸：写 ACCOUNT 工商字段 → 自动校验信用代码格式 + 可选第三方同步。

**验收判据**：① 工商字段写时校验（非法信用代码拒绝）；② 第三方同步后字段自动补全；③ 抬头 = 发票/合同的抬头锚点（F19 联动）。

### F19 发票全生命周期 → 发票粒子 + 对账核销（§B8 已覆盖，此处补充）

**实证**：录入发票类型、号码、金额、开票日期、对应客户合同订单；上传电子附件；自动关联工商抬头与回款数据；对账核销、减少开票差错、降低重复开票；合同详情可查全部发票开具记录。

**补充落点**：发票粒子承载「票据信息 + 电子附件 + 客户/合同/订单关联 + 工商抬头/回款自动关联」——「开票（应核销）→ 回款（实回）→ 对账核销」闭环 = L2C 最终对账环节。发票 = 「业务→财务」数据协同的接缝层。

### F20 表单/通知/检索工程细节 → 门户组件 + 通知通道 + 搜索权限

**实证**：报价/合同表单支持多个产品表格；数据源组件字段联动 + 下拉动态选项；新增合同/报价相关通知；Bug：移动端创建商机重复产品（#813）、高级搜索按联系人权限不正确（#688）。

**补充落点**：① 产品明细多表格（子表格扩展）；② 字段联动/动态选项（表单渲染器能力）；③ 通知事件域（对应主动预警通知通道，§G24/H28 抄送通知）；④ 搜索权限边界（联系人级检索权限 = 组织 RBAC 细化，阶段 1 已实现 scope.js 数据范围）。

---

## §6 H 组：发布实证（写操作完整性 + 全端审批）

> 定位：v1.8.0 = **写操作工程化最强实证**——「upsert 幂等 + 回滚补偿 = 写粒子完整性的双保障」+ 全端审批。

### H26 移动端审批 → 移动端门户 + 审批 Action 移动适配（§G24 延伸）

**实证**：移动端我的待办 + 就地审批（看详情 → 同意/驳回/加签/退回 原地完成）+ 审批意见/附件上传。

**补充落点**：移动端门户（Vant 适配，§4.5 已锁定前端）+ 待办聚合视图移动端形态 = `ai-portal-page-generation` 的移动端门户生成。审批 Action 不区分端（同一 Action 表面，不同端适配渲染）。

### H27 导入 upsert 双模式 → 批量写粒子 Action（幂等）

**实证**：导入新建（Excel → 新数据入库）+ 导入更新（按系统唯一 ID 匹配存量 → 覆盖更新）+ 导出含唯一 ID（匹配键闭环）+ 导入导出偏好记忆。

**原生机制**：导入/导出 = 批量写/读 Action 的工程通道（§5ter-quater Q.18：不是独立功能，是写粒子管线的两个方向）。**导入更新 = 按唯一 ID 匹配的 upsert（幂等批量写）**。

**实施落点**（阶段 3）：

```
crm-import-batch（批量写 Action）：
  参数: { particle_type, rows: [{ id?, ...payload }], mode: 'insert|upsert' }
  语义: upsert = 按粒子 id 匹配（存在更新/不存在新增），幂等
  闸: 写通道三闸（规则层 → action-confirm → HITL 审批流，批量写 confirm 必过）
```

**验收判据**：① upsert 按 ID 匹配（重复导入不产生重复粒子）；② 批量写过闸（确认必需）；③ 导出默认带唯一 ID（导入更新匹配键闭环）。

### H28 审批流数据回滚 + 抄送通知 → 写粒子补偿机制

**实证**：审批结果触发的数据变更可回滚 + 审批抄送节点新增抄送人消息通知。

**原生机制**：**回滚 = 写粒子的补偿机制（compensation）**——「写前快照 + 驳回/失败回滚」= 写 Action 事务完整性（与 upsert 幂等共同构成写操作完整性双保障）。抄送通知 = 主动预警通知通道扩展。

**实施落点**（阶段 2/3）：
- 审批后动作（通过/驳回后自动更新）带上**写前快照**；驳回/失败 → 回滚补偿。
- 审批抄送 → 事件总线通知事件（ccType/ccList 实证 → 通知通道）。

**验收判据**：① 审批后动作失败可回滚（写前快照恢复）；② 抄送人收到审批动态通知（事件流）。

### H29 功能优化/修复 → 门户组件 + 偏好记忆 + 多池 + 写后一致性

**实证**：子表格更多基础字段（#2834）、人员选择器展示离职/禁用人员（#2522）、导入导出记住偏好（#2270）、客户移入公海指定池（#2879/#2693/#2682）、商机修改后更新人/时间正确（#2911）。

**补充落点**：
- 子表格扩展 = 表单渲染器明细行扩展（A1 联动）。
- 人员选择器历史可见性 = 组织 RBAC「历史归属」可见性（对应跟进/线索历史负责人追溯）。
- 导入导出偏好记忆 = ai-memory-lifecycle UI 偏好层（跨会话）。
- 多池选择 = Action 参数（目标池 ID，B6 联动）。
- 写后聚合一致性 = 写粒子后事件触发聚合视图刷新（对应写后验证）。

---

## §7 G 组主章：可配置审批流引擎（HITL 闸）完整详设

> **这是整个借鉴清单里最重的一个机制**（CordysCRM 官方 v1.7.0/v1.8.0 成品级实证），也是阶段 2「认知+智能体层」HITL 闸 + 阶段 3「四大写域审批」的**共用底座**。本组单列主章完整展开。

### 7.1 引擎定位

审批流 = **可配置的第一等公民**（覆盖报价/合同/发票/订单四大写域）+ 六层结构 + 四类配置 + 状态×操作矩阵 + 审批记录数字档案 + 数据回滚补偿。映射到 AI 原生 = **HITL 闸引擎**（`ai-multi-agent-orchestration` 的决策节点）——审批 = 编排的一个分支（§5ter-quater Q.11：官方「配置好的审批系统」，我们「审批 = 编排决策节点，可被 AI 感知/生成/审计」）。

### 7.2 审批流粒子域（六层结构，对应 §5bis C9 实证）

```
CRM_APPROVAL_FLOW（审批流，可配置 + 启停）
  payload: { name, enabled, version_id: ref current, owner_org: ref }

CRM_APPROVAL_VERSION（审批流版本，可配置）
  payload: { flow_id: ref, version_no, nodes: [node_refs], submitter_can_withdraw, allow_batch, allow_add_sign }

CRM_APPROVAL_NODE（审批节点）
  payload: { flow_id: ref, node_type: 'START|APPROVER|CONDITION|DEFAULT|END',
             name, pos }
  edges: link → CRM_APPROVAL_LINK

CRM_APPROVAL_APPROVER（节点审批人规则 —— 一一对应 ApprovalNodeApprover 实证字段）
  payload: {
    node_id: ref,
    approval_type: 'MANUAL|AUTO_PASS|AUTO_REJECT',        // 人工/自动通过/自动驳回
    multi_approver_mode: 'ALL|ANY|SEQUENTIAL',            // 会签/或签/顺序签
    empty_approver_action: 'AUTO_PASS|ASSIGN_SPECIFIC|ASSIGN_ADMIN',  // 审批人为空兜底
    same_submitter_action: 'ALLOW|ASSIGN_SUPERIOR',       // 提交人=审批人
    approver_type: 'MEMBER|SUPERIOR|MULTIPLE_SUPERIOR|DEPT_HEAD|MULTIPLE_DEPT_HEAD|ROLE',
    approver_direction: 'BOTTOM_UP|TOP_DOWN',
    cc_type: '...', cc_direction: '...', cc_list: [...],  // 抄送
    field_permissions: { field: 'HIDE|VIEW|EDIT' },       // 表单字段权限
    pass_post_config: {...}, reject_post_config: {...},   // 通过/驳回后动作
    auto_approve_rule: { same_approver_skip: true }       // 同一审批人仅首节点审批，后续自动同意
  }

CRM_APPROVAL_CONDITION（节点条件）
  payload: { node_id: ref, field, operator: 'GT|LT|EQ|IN|...', value }
  // 例：quotation.amount > 10 万 → 多级上级审批；否则 → 部门负责人审批（G22 条件分支实证）

CRM_APPROVAL_LINK（节点连线）
  payload: { from_node, to_node, condition_ref? }
```

### 7.3 审批实例 + 审批任务（运行态）

```
CRM_APPROVAL_INSTANCE（审批实例 —— 业务流程粒子）
  payload: { flow_version_id: ref, business_type: 'QUOTATION|CONTRACT|INVOICE|ORDER',
             business_id: ref, submitter: actor-ref,
             status: 'PENDING_SUBMIT|APPROVING|APPROVED|REJECTED|CANCELED',   // 状态×操作矩阵
             pre_write_snapshot: {...} }        // 写前快照（H28 回滚补偿）

CRM_APPROVAL_TASK（审批任务 —— 待办）
  payload: { instance_id: ref, node_id: ref, approver: actor-ref,
             status: 'TODO|APPROVED|REJECTED|TRANSFERRED',
             opinion: text, attachments: [attachment] }
```

### 7.4 状态×操作矩阵（G23 实证 → 状态机内建）

| 状态 | 可操作（审批人/提交人视角） |
|---|---|
| PENDING_SUBMIT 待提交 | 提交、编辑、撤回 |
| APPROVING 审批中 | 同意 / 驳回 / 加签 / 退回 / 转交、批量、撤回（提交人） |
| APPROVED 已通过 | 查看、下载（附件见 C10 文件级鉴权）；（业务后动作执行） |
| REJECTED 已驳回 | 查看；（驳回后动作执行，可回滚 H28） |
| CANCELED 已撤销 | 查看 |

**状态机合法流转**内建（非法操作从机制上不可能：如审批中不可直接编辑业务对象删除类操作，审批态删除 = 状态机拒绝——呼应禁删红线）。

### 7.5 四类配置项 → 规则模型（G22 实证）

| 配置项 | 我们落点 |
|---|---|
| ① 条件分支自定义（表单字段分流） | `CRM_APPROVAL_CONDITION` 粒子（field+operator+value）→ 路由决策 |
| ② 审批模式自定义（会签/或签/依次 + 自动通过兜底） | `CRM_APPROVAL_APPROVER.multi_approver_mode` + `empty_approver_action` |
| ③ 表单权限自定义（字段隐藏/查看/编辑） | `field_permissions` → 写闸字段级权限（联动 A1/A3 脱敏） |
| ④ 审批后操作自定义（结果自动更新） | `pass_post_config/reject_post_config` → 事件后动作（通过/驳回事件触发，带补偿） |

### 7.6 审批记录（数字档案）→ 审计事件流

每次提交/审批/意见 = **事件进总线 + 记忆快照**（ai-capability-audit 输入 + ai-memory-lifecycle 凭证记忆）。审批附件与审批记录绑定存档（财务核对/法务复盘直接查依据）。抄送人可查审批记录（跨角色可见性 ccType/ccList）。

### 7.7 与写通道三闸的接线

```
写 Action（crm-quote-submit / crm-contract-submit / crm-invoice-submit / crm-order-submit）
  → 第 1 闸 规则层（B7 CRM_RULE：能不能写）
  → 第 2 闸 action-confirm（要不要人确认，关键写必过）
  → 第 3 闸 HITL 审批流（CRM_APPROVAL_FLOW 引擎：提交 → 条件路由 → 审批人规则 → 通过/驳回后动作 + 回滚补偿）
  → 写粒子（事务 + 事件总线）
```

（§4 写通道三闸已有总体架构基线，本详设给出审批流的粒子化实例。）

### 7.8 验收判据

1. 可配置审批流（六层粒子化）覆盖报价/合同/发票/订单四写域；
2. 条件分支（金额阈值路由）生效（报价 >10 万走多级审批）；
3. 会签/或签/顺序签三种审批模式可切换；
4. 字段权限（隐藏/查看/编辑）在审批节点生效；
5. 通过/驳回后动作自动执行 + 失败可回滚（写前快照补偿）；
6. 审批记录 = 审计事件流（谁/何时/意见/附件全可追溯）。

---

## §8 落地路径（阶段 2 + 阶段 3 任务化）

> 每 Task 一 commit；设计审批后进入 writing-plans 拆分。以下按「阶段 → Task → 借鉴点来源 → 交付物」编排。

### 阶段 2（认知 + 智能体层）—— 审批流引擎 + 规则闸 + 待办工作台

| Task | 内容 | 借鉴点 | 交付物 |
|---|---|---|---|
| T-2.1 | 审批流粒子域（六层 Schema + 实例/任务）落库 | G21/C9 | `CRMM_APPROVAL_*` 六类粒子 + schema.sql |
| T-2.2 | HITL 审批引擎（状态机 + 条件路由 + 三种模式 + 兜底） | G21/G22 | src/approval/ 引擎（状态机合法流转 + 路由） |
| T-2.3 | 审批后动作 + 回滚补偿（写前快照） | H28/G22④ | src/approval/ 后动作 executor + compensation |
| T-2.4 | 写操作规则闸可配置化（CRM_RULE 粒子） | B7 | src/ruleEngine/ 升级（规则粒子驱动） |
| T-2.5 | 审批 × Action 表面接线（crm-*-submit/approve，四大写域） | E13/G21 | src/action/ seed 扩展（审批 Action） |
| T-2.6 | 审批记录 → 审计事件流 + 抄送通知 | G23/H28 | 事件总线审批域事件 + 通知 |
| T-2.7 | 「我的待办」工作台（门户默认页，四视角 + 批量） | G24/H26 | 门户待办聚合视图（PC + 移动适配） |
| T-2.8 | 跟进粒子域 + 计划→记录转化 + 终态保护 | C11 | CRM_FOLLOW_UP 粒子 + 状态机 |
| T-2.9 | 评论/@提及 → 记忆流 + 协作事件 | C11 | 评论进记忆 + @提及事件 |
| T-2.10 | 安全底座（文件级鉴权 + CSRF + 对外双通道） | C10 | 附件短期令牌 + 写闸 CSRF 前置 |
| T-2.11 | 视图配置/脱敏配置 → 配置协议（门户生成） | A2/A3 | CRM_VIEW + CRM_MASK_RULE 粒子 + 配置页 |

### 阶段 3（业务闭环增量）—— 九业务粒子逐域落地

| Task | 内容 | 借鉴点 | 交付物 |
|---|---|---|---|
| T-3.1 | LEAD 粒子 + 线索池领取/回收（事件驱动） | B6/E16 | CRM_LEAD + crm-lead-pick/recycle |
| T-3.2 | ACCOUNT 粒子扩展（工商抬头 + 写时校验连接器） | F18 | 工商字段 + 校验闸 |
| T-3.3 | DEAL 阶段-赢率配置 + 回退特权 | B5 | stage_config + rollback Action |
| T-3.4 | PRODUCT/PRICE_LIST 四级定价 + 审计事件流 | C12/E15 | 价格表扩展 + 价变审计 |
| T-3.5 | QUOTATION 粒子 + 写时金额计算 + 审批接线 | E14/E16/G21 | 报价粒子 + calc 管线 |
| T-3.6 | CONTRACT 粒子 + 二级资源边 + 审批接线 | E13/F17 | 合同粒子 + 回款/抬头/发票边 |
| T-3.7 | PAYMENT_PLAN/RECORD 双粒子 + 对账回路 | B8/F17 | 应回 vs 实回报表 + 逾期预警 |
| T-3.8 | INVOICE 粒子 + 核销闭环 | F19 | 发票 + 对账核销 |
| T-3.9 | ORDER 粒子 + 状态看板 | G25 | 订单 + 看板视图 |
| T-3.10 | 导入 upsert + 批量写 Action + 偏好记忆 | H27/H29 | crm-import-batch（幂等） |
| T-3.11 | 标讯连接器 + 外部事件源 | E16 | tender_push 事件 → 生成 LEAD |
| T-3.12 | 池配置/多池 + 门户组件扩展（子表格/选择器） | A4/H29 | 池配置粒子 + 渲染器扩展 |

> 依赖顺序：T-2.1→T-2.5 必须先于阶段 3 的 T-3.5/T-3.6/T-3.8/T-3.9（四大写域审批接线）。

---

## §9 与 10 大能力对齐（借鉴清单 → 能力落点）

| 借鉴组 | 主命中能力 | 辅命中能力 | 落地阶段 |
|---|---|---|---|
| A 界面设置层（4 条） | ai-portal-page-generation | ai-context-layering | 阶段 2/3 |
| B 销售业务逻辑层（4 条） | ai-particle-system-design + ai-native-action-design | ai-event-driven-evolution + ai-feedback-loop | 阶段 2/3 |
| C 补充勘察（4 条） | ai-multi-agent-orchestration（审批/HITL） | ai-native-action-design + ai-memory-lifecycle | 阶段 2 |
| E/F 发布实证（8 条） | ai-particle-system-design | ai-native-action-design + ai-event-driven-evolution | 阶段 3 |
| G 审批流（5 条） | **ai-multi-agent-orchestration（HITL 闸）** | ai-event-driven-evolution + ai-capability-audit | 阶段 2/3 |
| H 写完整性（4 条） | ai-particle-system-design（写粒子） | ai-native-action-design + ai-memory-lifecycle | 阶段 2/3 |

**不新增 10 大能力**（基线纪律）；全部借鉴点落入既有能力实例化文档的扩展项。若某能力实例化文档（04-10）需增补借鉴点，回填到对应 `docs/2026-08-25-0X-ai-*.md` 的扩展章节。

---

## §10 不做的事（边界）

1. **不做固定业务页面复刻**（页面由门户生成按需产出，A1-A4 是配置协议不是页面）。
2. **不搬 CordysCRM 技术栈**（Java/MySQL/Redis 不涉及）。
3. **不做动态字段表模型**（粒子模型是唯一数据模型，不用 field_value 表）。
4. **不做外部 API 包装层**（cordys.sh 式 curl 不引入；平台即后端，只做连接器形态的入站数据源）。
5. **不做「人配置审批规则后系统执行」的单向模型**——审批流是 AI 可感知/生成/审计的编排节点（AI 参与判断，不复制官方「配置+执行」二元）。
6. **不复制官方禁删为「提示词红线」**——禁删从 Action 表面不存在（机制级，阶段 1 已实现）。

---

## §11 待批准项（供用户勾选）

1. **本综合详设整体批准**（覆盖 §4/§5bis 全部 8 组 30 条借鉴点）。
2. **阶段 2 优先执行 T-2.1~T-2.5**（审批流引擎：六层粒子化 + 状态机 + 四类配置 + 回滚补偿 + Action 接线）——审批流是阶段 3 四大写域审批的前置。
3. **阶段 3 按 T-3.1~T-3.12 顺序实施**（每 Task 一 commit）。
4. **界面设置层 4 条并入 ai-portal-page-generation 文档**（不新开独立配置界面文档）。
5. **能力实例化文档回填**：审批流/规则闸/跟进/定价的新增借鉴点回填到 `docs/2026-08-25-0X-ai-*.md` 对应扩展章节。
6. **本文档批准后**进入 writing-plans，把阶段 2 拆成可执行实施计划。

---

*文档结束 · 设计稿（待批准）*