# method-meddicc · 评估流程（五步）

> 唯一事实源 = `method-meddicc/methodology.json`（维度/权重/门控）。本页是执行步骤。

## 步骤

1. **取上下文**：商机粒子（CRM_DEAL）的 `payload.name/stage/expected_amount/owner_id` + 决策场景的 `eval_dimensions` 条件。
2. **逐维收集证据**（对每商机，按 M1→E1→D1→D2→I1→C1→C2 顺序）：
   - M1：客户可量化指标（`payload.metrics_target`）有无？（营收/成本/效率基线）
   - E1：预算审批人是否识别（`payload.economic_buyer`）？是否已触达？
   - D1：选型标准（`payload.decision_criteria`）列出几条，我方覆盖几条？
   - D2：流程节点（`payload.decision_process`）走到 RFI/RFP/POC/招标哪一步？
   - I1：痛点（`payload.pain`）可单句陈述？有无量化影响（`payload.pain_impact`）？
   - C1：支持者（`payload.champion_name/champion_strength`）是否 ≥3？
   - C2：竞品（`payload.competing_solution`）与我方差异化证据。
3. **逐维评分**（0–1）：
   - 0.0–0.5：无证据 / 反证
   - 0.6–0.79：部分证据（口头意向，无文档/POC 佐证）
   - 0.8–0.94：书面/实测证据（批复、流程节点确认、POC 通过）
   - ≥0.95：多方验证（决策人亲述 + 书面 + 参考案例）
4. **计算就绪度**：`ready = Σ(score_i × weight_i) / Σ weight_i`。
5. **产出结论**：
   - `{ verdict, ready, gaps[], gate }`
   - gate ∈ `WIN_CONFIDENT | BLOCKED_EB | BLOCKED_CRITERIA | BLOCKED_PROCESS | BLOCKED_PAIN | ...`，优先列出最弱硬维度。