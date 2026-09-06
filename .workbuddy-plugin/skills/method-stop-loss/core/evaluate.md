# method-stop-loss · 评估流程（五步）

> 唯一事实源 = `method-stop-loss/methodology.json`（维度/权重/门控）。本页是执行步骤。

## 步骤

1. **取上下文**：商机粒子（CRM_DEAL）的 `payload.name/stage/expected_amount/owner_id` + 投入流水（`payload.invested_cost` 累计投入人天/金额 + `payload.investment_budget` 预设上限）+ 决策场景 `eval_dimensions` 条件。
2. **逐维收集证据**（按 NV→CB→EG 顺序）：
   - NV：累计投入（`payload.invested_cost`：人力/售前/时间）+ 赢单预期收益（`payload.expected_amount` × win_probability）。
   - CB：预设投入预算（`payload.investment_budget`）是否在商机启动时确定？上限值多少？
   - EG：预设退出信号（`payload.exit_gate`：预算超支阈值/里程碑要求/关键人风险）。
3. **逐维评分**（0–1）：0.0–0.5 无证据/反证；0.6–0.79 部分证据；0.8–0.94 书面/实测；≥0.95 多方验证。
4. **计算净值与触发检查**：
   - 净值 = `expected_amount × win_probability − invested_cost`；净值 < 0 且无法回升 → 危险。
   - 预算使用率 = `invested_cost / investment_budget`；> 100% → 超支。
   - EG 信号检查：里程碑连续未达成/关键人离职/信用恶化 → 命中。
5. **产出结论**：`{ verdict, net_value, budget_usage, exit_triggered, gate }`，gate ∈ `CONTINUE | WATCH | EXIT_REQUIRED`，触发时优先列示触发信号。