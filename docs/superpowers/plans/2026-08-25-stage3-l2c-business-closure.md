# 阶段 3 实施计划：L2C 业务闭环增量（九业务粒子逐域落地）

> 状态：writing-plans（已批准详设输入：`docs/specs/2026-08-25-borrowings-comprehensive-implementation-design.md` §8 阶段3 T-3.1~T-3.12）
> 前置：阶段 1（底座 MVP 47 测试全绿）+ 阶段 2（五子系统：上下文/记忆/白名单/门户/预警反馈 + 审批流引擎）
> 执行纪律：每 Task 一 commit；TDD（先写失败测试→实现→全绿）；纯逻辑本地验证，DB 集成留 PG 环境
> 代码现状（勘察锚点）：
> - `src/particles/particleModel.js` — 9 真粒子 + 审批域六层（CRM_DEAL 状态机 lead→…→paid/lost/disqualified）
> - `src/particles/particleRepo.js` — 统一 CRUD + 受控边（createParticle/updateParticle/createEdge/queryNeighbors）
> - `src/particles/lifecycle.js` — advanceStage 只进不退 + why 载体（stage_change_reason）
> - `src/action/seed-actions.js` — Action Registry 种子（crm-deal-advance/tech-proposal/approval 三件套）
> - `src/approval/` — flow.js（六层配置）/ engine.js（起单/路由/ANY·ALL·SEQUENTIAL/兜底）/ compensation.js
> - `src/connectors/connectorActions.js` — ④外部连接器 P0（attio-enrich + zhizao-verify，F18 工商校验已部分落地）
> - `src/alerts/` — 预警规则表 + 处置状态机 + 写时触发 + per-tier 指标（payment_due 已注册但 enable=false）
> - `src/ruleEngine.js` — 规则层（只进不退 + 输单必填原因；金额阈值审批为 HITL 接入点）
> - `db/seed.sql` — org-hq 池配置占位 + 6 角色 + 10 种子商机 + 决策主轴种子

## 已批准设计核对（阶段 3 边界收敛）

| 已批准 Task | 设计内容 | 代码现状 | 本计划收敛 |
|---|---|---|---|
| T-3.1 | LEAD 粒子 + 线索池领取/回收 | CRM_LEAD 非独立粒子（01 文档line13:线索=DEAL 的 lead 阶段）；org.pool_config 已有占位 | **不新建 CRM_LEAD 粒子**；线索池=DEAL lead 阶段 + org.pool_config 池规则；crm-lead-pick/recycle Action 作用于 DEAL |
| T-3.2 | ACCOUNT 工商抬头 + 写时校验连接器 | conn-zhizao-verify-account 已落地（F18）；ACCOUNT.business_title 已有 | **连接器已存在**；补写时校验闸（信用代码格式 + 工商四要素必填） |
| T-3.3 | DEAL 阶段-赢率配置 + 回退特权 | lifecycle 只进不退已实现 | 补 stage_config 挂 DEAL payload + 赢率函数 + crm-deal-rollback 特权 Action（admin） |
| T-3.4 | PRODUCT/PRICE_LIST 四级定价 + 审计事件流 | 两粒子已有，PRICE_LIST 无 valid_from/to/permission/change_log | PRICE_LIST 扩展 + 价变审计事件 |
| T-3.5 | QUOTATION 粒子 + 写时金额计算 + 审批接线 | 无 | CRM_QUOTATION 粒子 + 金额管线（Σ unit_price×qty×(1-discount)×(1+tax)）+ crm-quote-submit 走审批 |
| T-3.6 | CONTRACT 粒子 + 二级资源边 + 审批接线 | 无 | CRM_CONTRACT 粒子 + has_payment_plan/record/invoice 边 + crm-contract-submit 走审批 |
| T-3.7 | PAYMENT_PLAN/RECORD 双粒子 + 对账回路 | 无 | 双粒子 + 应回vs实回对账 + 逾期预警（payment_due 启用） |
| T-3.8 | INVOICE 粒子 + 核销闭环 | 无 | CRM_INVOICE + reconcile 核销 + payment_due 关联启用 |
| T-3.9 | ORDER 粒子 + 状态看板 | 无 | CRM_ORDER + 订单看板（G25） |
| T-3.10 | 导入 upsert + 批量写 Action | 无 | crm-import-batch（insert/upsert 幂等批量写） |
| T-3.11 | 标讯连接器 + 外部事件源 | 无 | conn-tender-push 连接器：订阅条件 → tender_push 事件 → 生成 DEAL(lead) |
| T-3.12 | 池配置/多池 + 门户组件扩展 | org.pool_config 占位已有 | 池配置读写 + renderer 子表格/选择器扩展（门户组件层） |

## Task 清单（TDD，每 Task 一 commit）

### T3-1 线索池规则 + 领取/回收 Action
- **交付**：`src/sales/pool.js`（池规则服务：pick_rule 校验每日限额/间隔/新数据/前归属 + recycle_rule 判据）；`src/action/seed-actions.js` 追加 `crm-lead-pick` / `crm-lead-recycle`（作用于 CRM_DEAL lead 阶段，第 0 闸 autoDecision）；`test/pool.test.js`
- **验收**：① 领取校验池规则（超限拒绝）② 超期未跟进回收（>30 天）③ 回收动作进事件总线
- **commit**：`feat(pool): 线索池领取/回收规则 + Action（B6，stage3 T3-1）`

### T3-2 ACCOUNT 工商写时校验闸
- **交付**：`src/sales/businessTitle.js`（信用代码 18 位格式校验 + 工商四要素 title/credit_code/reg_address/legal_person 必填 + 幂等）；接线 hooks.js 写时校验（CRM_ACCOUNT 工商字段变更时）；`test/business-title.test.js`
- **验收**：① 非法信用代码拒绝 ② 四要素必填 ③ 连接器同步后字段自动补全（已有）
- **commit**：`feat(business-title): ACCOUNT 工商写时校验闸（F18，stage3 T3-2）`

### T3-3 DEAL 阶段-赢率配置 + 回退特权
- **交付**：`src/sales/stageConfig.js`（stage_config 默认表 lead 0.10→paid 1.00 + winRate() 函数 + canRollback() 判定）；`seed-actions.js` 追加 `crm-deal-rollback`（rbac_roles:['admin']，confirm:'critical'，带 reason，过 lifecycle 检查）；`test/stage-config.test.js`
- **验收**：① 每阶段赢率可读 ② 非 admin 回退被 RBAC 拒绝 ③ 管理员回退带 reason（决策事件流）④ 回退需 stage_config.allow_back 允许
- **commit**：`feat(stage-config): DEAL 阶段赢率配置 + crm-deal-rollback 特权（B5，stage3 T3-3）`

### T3-4 PRICE_LIST 四级定价 + 价变审计
- **交付**：`src/sales/priceCalc.js`（四级定价：PRODUCT.price → PRICE_LIST 多套定价 → QUOTATION 自动取价 → CONTRACT；valid_from/valid_to 有效期判定 + permission 权限 + 价变审计事件 price_change）；`particleModel.js` PRICE_LIST 追加 coreAttributes；`test/price-calc.test.js`
- **验收**：① 价格表多套定价 + 有效期生效 ② 价变留痕（audit 事件进总线）③ 报价自动取价
- **commit**：`feat(price-calc): 四级定价 + 价变审计事件（C12/E15，stage3 T3-4）`

### T3-5 QUOTATION 粒子 + 写时金额计算 + 审批接线
- **交付**：`particleModel.js` 新增 CRM_QUOTATION（identity:['name']，states draft/submitted/approved/rejected/invalid，coreAttributes: deal_id/amount/valid_until/items）；`src/sales/quoteService.js`（createQuote 自动算 amount = Σ unit_price×qty×(1-discount)×(1+tax) + 写后验证 sum=明细）；`seed-actions.js` 追加 `crm-quote-create`（autoDecision）+ `crm-quote-submit`（confirm:'critical'，走审批 startInstance）；`test/quote-service.test.js`
- **验收**：① 报价金额自动计算（写后 sum=明细）② 报价提交走审批流 ③ 取价走 PRICE_LIST
- **commit**：`feat(quote): QUOTATION 粒子 + 写时金额计算 + 审批接线（E14，stage3 T3-5）`

### T3-6 CONTRACT 粒子 + 二级资源边 + 审批接线
- **交付**：`particleModel.js` 新增 CRM_CONTRACT（states draft/submitted/approved/rejected/effective/expired，coreAttributes: deal_id/quotation_id/contract_no/amount/start_date/end_date/approval_status）；hooks refs 增 `quotation_id→has_quotation`、`deal_id→belongs_to`；`seed-actions.js` 追加 `crm-contract-create`（autoDecision）+ `crm-contract-submit`（审批）；`test/contract-service.test.js`
- **验收**：① 合同独立粒子可建（不依赖商机也行）② 合同提交走审批流 ③ 二级资源（回款/抬头/发票）挂合同边
- **commit**：`feat(contract): CONTRACT 粒子 + 审批接线 + 二级资源边（E13，stage3 T3-6）`

### T3-7 PAYMENT_PLAN/RECORD 双粒子 + 对账回路
- **交付**：`particleModel.js` 新增 CRM_PAYMENT_PLAN（plan_amount/plan_end/plan_status pending|partial|done）+ CRM_PAYMENT_RECORD（paid_amount/paid_at/voucher）；`src/sales/paymentService.js`（对账：应回 vs 实回差额 + 逾期判定 + 催收优先级）；`seed-actions.js` 追加 `crm-payment-plan-create` + `crm-payment-record-create`；`test/payment-service.test.js`
- **验收**：① 计划 vs 记录可对账（差额/逾期可算）② 逾期触发催收预警（payment_due 启用）③ 凭证附件可挂
- **commit**：`feat(payment): 回款计划/记录双粒子 + 对账回路（B8/F17，stage3 T3-7）`

### T3-8 INVOICE 粒子 + 核销闭环
- **交付**：`particleModel.js` 新增 CRM_INVOICE（invoice_type/no/amount/date/reconcile_status open|reconciled）；`src/sales/invoiceService.js`（核销：开票→回款→reconcile 闭环；重复开票防护 invoice_no 唯一）；`seed-actions.js` 追加 `crm-invoice-create` + `crm-invoice-reconcile`；`test/invoice-service.test.js`
- **验收**：① 发票粒子可建（invoice_no 唯一）② 核销闭环（回款后 reconcile）③ 发票挂合同边
- **commit**：`feat(invoice): INVOICE 粒子 + 核销闭环（F19，stage3 T3-8）`

### T3-9 ORDER 粒子 + 状态看板
- **交付**：`particleModel.js` 新增 CRM_ORDER（states draft/confirmed/shipped/completed，coreAttributes: deal_id/contract_id/amount）；`seed-actions.js` 追加 `crm-order-create` + `crm-order-advance`；kanban 复用（订单看板视图 = kanban 四态可视化）；`test/order-service.test.js`
- **验收**：① 订单粒子可建/推进 ② 订单看板视图可看 ③ 订单挂合同边
- **commit**：`feat(order): ORDER 粒子 + 状态看板（G25，stage3 T3-9）`

### T3-10 导入 upsert + 批量写 Action
- **交付**：`src/sales/importService.js`（crm-import-batch：insert|upsert 按粒子 id 匹配，幂等，批量过闸 confirm 必需）；`seed-actions.js` 追加 `crm-import-batch`（confirm:'critical'）；`test/import-service.test.js`
- **验收**：① upsert 按 ID 匹配（重复导入不重复）② 批量写过闸（confirm 必需）③ 导出带唯一 ID（导入匹配键闭环）
- **commit**：`feat(import): 导入 upsert 批量写 Action（H27，stage3 T3-10）`

### T3-11 标讯连接器 + 外部事件源
- **交付**：`src/connectors/tenderConnector.js`（订阅条件关键词/区域 → tender_push 事件 → 自动生成 DEAL(lead) 粒子）；`connectorActions.js` 追加 `conn-tender-push`（autoDecision，匹配条件可配）；`test/tender-connector.test.js`
- **验收**：① 订阅条件可配置 ② 匹配标讯自动生成线索（事件驱动）③ 外部事件进总线
- **commit**：`feat(tender): 标讯连接器 + 外部事件源（E16，stage3 T3-11）`

### T3-12 池配置读写 + 门户组件扩展
- **交付**：`src/sales/pool.js` 扩展池配置读写（org.pool_config 领取/回收规则实体化）；renderer 子表格/选择器扩展（portal 组件层，不新开页面）；`test/pool-config.test.js`
- **验收**：① 池配置可读写（不重启生效）② 子表格/选择器渲染可用
- **commit**：`feat(pool-config): 池配置读写 + 门户组件扩展（A4/H29，stage3 T3-12）`

## 依赖顺序与边界
- 依赖：T3-4 → T3-5（报价取价依赖价格表）；T3-5 → T3-6（合同挂报价）；T3-6 → T3-7/8/9（二级资源挂合同）；T3-4 与 T3-3 无依赖可并行；T3-11 无前置依赖
- 铁律：粒子数增量需过 validateCoreAttributesSchema（19 类型集）；新 Action 全走写通道三闸（autoDecision 第 0 闸）；禁删（连接器只增改）
- 不做：不引 Semantica/图引擎；不建独立 LEAD 粒子表；不新增 10 大能力序号；不做复杂报表门户（复用看板视图）
- 每 Task 完成后跑 `node node_modules/vitest/vitest.mjs run <target>`（禁 npx/npm install——沙箱约束）

## 验收（对齐综合详设 §8 + 总体设计 §8.7 字段采集四查）
- L2C 主闭环可走通：DEAL(lead) → 报价 → 合同 → 回款计划/记录 → 发票核销 → 订单看板
- 四大写域审批接线：报价/合同/发票/订单 submit → HITL 审批流（阶段 2 引擎复用）
- 预警联动：lead_overdue（池回收）/ payment_due（对账逾期）/ deal_stuck 全启用
- 字段采集四查（§8.7）：新粒子每属性核对来源（人工/AI/规则/外部）+ 产生通道，无孤儿字段
- 全量测试基线：阶段 3 新增测试全绿（纯逻辑本地），DB 集成留 PG 验收