# method-risk-tradeoff · 评估流程（五步）

> 唯一事实源 = `method-risk-tradeoff/methodology.json`（维度/权重/门控）。本页是执行步骤。

## 步骤

1. **取上下文**：商机粒子（CRM_DEAL）的 `payload.name/stage/expected_amount/owner_id` + 客户粒子的信用/付款标签（`payload.credit_rating/payment_terms`）+ 决策场景 `eval_dimensions` 条件。
2. **逐维收集证据**（按 R→B→RD→M 顺序）：
   - R：客户信用评级（`payload.credit_rating`）、历史逾期记录（`payload.payment_history`）、交付复杂度（`payload.custom_scope` 定制占比）。
   - B：`payload.expected_amount`（金额）、`payload.expected_margin`（毛利）、战略价值（进入行业/标杆）。
   - RD：合规风险（`payload.compliance_flag`）、信用底线（信用评级 < 门槛）、交付能力（`payload.custom_scope` 超能力边界）。
   - M：缓解手段清单（预付定金/银行担保/分期付款/第三方交付/合同条款）。
3. **逐维评分**（0–1）：0.0–0.5 无证据/反证；0.6–0.79 部分证据；0.8–0.94 书面/实测；≥0.95 多方验证。
4. **计算风险收益比**：`ratio = B_score / max(R_score, 0.2)`（R 越高要求 B 越高），并检查 RD 是否触碰。
5. **产出结论**：`{ verdict, ratio, redline[], mitigation[], gate }`，gate ∈ `GO | REDLINE_BLOCK | MITIGATION_REQUIRED | STOP_LOSS`，优先列出红线与缺失缓解。