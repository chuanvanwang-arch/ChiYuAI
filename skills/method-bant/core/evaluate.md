# method-bant · 评估流程（五步）

> 唯一事实源 = `method-bant/methodology.json`（维度/权重/门控）。本页是执行步骤。

## 步骤

1. **取上下文**：商机粒子（CRM_DEAL）的 `payload.name/stage/expected_amount/owner_id` + 决策场景 `OPP_QUALIFY` 的 `eval_dimensions` 条件（identity_dedup/governance_approval/time_window）。
2. **逐维收集证据**（对每商机，按 B→A→N→T 顺序）：
   - B：客户已知预算号/预算区间（`payload.budget_confirmed`）？无 → 记缺口。
   - A：`payload.business_title` 是否是决策人（含 CEO/VP/采购负责人）？`payload.champion_strength` 是否 ≥3？
   - N：`payload.pain` 是否明确可陈述？有无替代方案在竞争（`payload.competing_solution`）？
   - T：`payload.expected_timeframe`（Q1/季度/月份）有无明确？无 → 记缺口。
3. **逐维评分**（0–1）：
   - 0.0–0.5：无证据 / 反证
   - 0.6–0.79：部分证据（口头意向，无 POC/文档佐证）
   - 0.8–0.94：书面/实测证据（预算批复、决策链实测、POC 通过）
   - ≥0.95：多方验证（决策人亲述 + 书面 + 参考案例）
4. **计算就绪度**：`ready = Σ(score_i × weight_i) / Σ weight_i`（required 维度缺席直接锁死）。
5. **产出结论**：
   - `{ verdict, ready, gaps[], gate }`
   - gate ∈ `ADVANCE_ALLOWED | BLOCKED_BUDGET | BLOCKED_AUTHORITY | BLOCKED_NEED | BLOCKED_TIMELINE`，优先列出最弱硬维度。