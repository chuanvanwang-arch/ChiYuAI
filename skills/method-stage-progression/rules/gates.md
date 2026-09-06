# method-stage-progression · 阶段闸规则（rules/gates.md）

## 推进前置（advance_gate）

| 推进 | 必须满足 | 证据载体 |
|---|---|---|
| S1→S2 | 客户需求描述有实质内容（needs.product/qty/spec 至少 2 项非空） | CRM_DEAL.payload.needs / visit_notes[].needs |
| S2→S3 | 方案验证拜访被质检判有价值（sales_visit_value=true） | payload.ai.sales_visit_value |
| S3→S4 | BANTCC 无硬缺口（bantcc_completeness ≥ `sales-thresholds.bantcc.pass`，出厂建议 0.6）+ 报价已出（CRM_QUOTATION 存在） | payload.ai.bantcc_completeness + CRM_QUOTATION |
| S4→S5 | review-gate 双闸门通过（报价复核 + 合同确认） | DEAL.payload.review_gate_decision='approved'（或 decisions[] 含 REVIEW_GATE 通过）+ review_gate 事件 |
| S5→S6 | 合同签署事实 | DEAL.payload.contract_no+signed_at（has_contract=true）+ crm.events 存在 contract_sign 事件 + CRM_CONTRACT 粒子 |

## 证据写入点（落地 Action，与 executor STAGE_GATES 逐条对齐）

- **S4→S5**：`crm-review-gate-approve`（写经第0闸 autoDecision）→ 写 `DEAL.payload.review_gate_decision='approved'` + 追加 `review_gate` 事件（payload.events）+ `emit('decision','review_gate_passed')`。
- **S5→S6**：`crm-contract-create`（写经第0闸 autoDecision）→ `contractService.createContract` 建 CRM_CONTRACT 粒子（has_contract 受控边）；回写 `DEAL.payload.{contract_no,signed_at,has_contract:true}` + 追加 `contract_sign` 事件 + `emit('decision','contract_sign')`。
- 既往缺口（仅方法论描述、无落地写入）已在此收口；gate 主读路径 `review_gate_decision` / `contract_no+signed_at` 现已由上述 Action 真实落库。

## 闸门语义（对齐设计 §7 第 3.5 闸 + 2026-08-30 三分类 C 类升级）

- **C 类硬闸（2026-08-30 升级）**：S4→S5 / S5→S6 已升级 `hard`（缺口可拦截）；闸内保留证据兜底——`contract_facts/signed_at/contract_no/order_date/paid_at/payment_received` **任一存在即放行**（软事实硬闸防误杀）。
- **商机三要素闸 C6（新增）**：`data-particle-create` 建 CRM_DEAL 非 lead 阶段 → 校验 `bantcc.budget/authority/timetable` 三维（与 S3→S4 同源字段；兼容 `ai.bantcc_completeness ≥ sales-thresholds.bantcc.pass` 已评估兜底）；lead/线索阶段豁免。
- **既有 S1→S4 硬闸不变**：S1→S2 需求事实 / S2→S3 方案验证 / S3→S4 BANTCC+报价。
- **输单条件对接**：S1/S2/S3/S4 输单条件触发 → 转 method-stop-loss（止损，不空耗）。

## 与既有闸门的关系（不重复建闸）

- S2→S3 = v0.3 两关之关二（方案验证）
- S3→S4 = method-bant 资质闸（BANTCC）
- S4→S5 = method-review-gate 双闸门
- stage-progression 本身是"阶段判定"，复用既有闸做推进拦截，不新增独立闸链。