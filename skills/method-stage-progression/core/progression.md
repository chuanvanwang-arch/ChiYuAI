# method-stage-progression · 推进流程（core/progression.md）

> 唯一事实源 = `methodology.json`（S1-S6 定义 + advance_gate）。本页是执行步骤。

## 步骤

1. **取上下文**：商机粒子（CRM_DEAL）的 `payload.stage / needs / ai.sales_visit_value / quotation / contract` + owner_id。
2. **对照客户行为判真实阶段**（不只看 stage 字段）：
   - 客户在"评估供应商关系和能力"（约见/要资料/现场交流）→ S1
   - 客户在"确定入围方案是否满足需求"（方案被实质讨论）→ S2
   - 客户在"评估商务条款"（进入价格/付款/交付谈判）→ S3
   - 客户在"合同签署内部审批"（合同文本在客户内部流转）→ S4
   - 客户在"接收产品和服务交付"（交付事实发生）→ S5
   - 客户"完成验收并支付全款" → S6
3. **检查下一阶段 advance_gate**（rules/gates.md）：
   - S1→S2：needs 有实质内容（product/qty/spec 至少 2 项非空）
   - S2→S3：方案验证拜访被质检判有价值（ai.sales_visit_value=true）
   - S3→S4：BANTCC 无硬缺口 + 报价已出（CRM_QUOTATION 存在）
   - S4→S5：review-gate 双闸门通过（REVIEW_GATE 处置=通过）
   - S5→S6：合同签署事实（events 有 contract_sign + CRM_CONTRACT 粒子）
4. **未过闸 → 输出缺口 + 下一步拜访目的**（不推进，补动作）：
   - `{gate:'gap', stage:'S1', next_visit_objective:'确认客户需求事实', missing:[...]}`
5. **过闸 → 判定可推进**（交 crm-deal-advance 决策，经第 3.5 闸）。

## 判定期限

- 商机进入 S2 之后（方案阶段）每周做一次阶段判定
- S3/S4 停留超过 `sales-thresholds.stage.stuck_days`（出厂建议 30）天 → 经理周会标注"推进卡点"（§12.3bis）