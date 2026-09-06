# method-opportunity-matrix · 评估流程（四步）

> 唯一事实源 = `method-opportunity-matrix/methodology.json`（维度/权重/门控）。本页是执行步骤。

## 步骤

1. **取上下文**：商机粒子（CRM_DEAL）列表的 `payload.name/stage/expected_amount/owner_id` + 决策场景的 `eval_dimensions` 条件。
2. **逐维收集证据**（对每条商机，按 V1→F1→P1 顺序）：
   - V1：`payload.expected_amount`（金额量级）+ `payload.strategic_value`（战略意义）+ 可复制性（`payload.replicable`）。
   - F1：`payload.economic_buyer`（预算审批人）+ `payload.competing_solution`（产品匹配）+ 决策链（引用 BANT/MEDDICC 硬维度证据）。
   - P1：`payload.competing_solution`（竞品）+ 差异化证据（POC/参考案例）。
3. **逐维评分**（0–1）：0.0–0.5 无证据/反证；0.6–0.79 部分证据；0.8–0.94 书面/实测；≥0.95 多方验证。
4. **判象限并排序**：
   - PRIMARY（V1≥0.6 且 F1≥0.6）：主攻，优先于其他象限推进
   - NURTURE（V1≥0.6 且 F1<0.6）：培育，补可行性再评估
   - HARVEST（V1<0.6 且 F1≥0.6）：收割，低成本拿下
   - PARK（V1<0.6 且 F1<0.6）：暂缓/淘汰，不投入
5. **产出结论**：`{ verdict, quadrant, rank, gaps[], gate }`，rank 按 PRIMARY > HARVEST > NURTURE > PARK 序列。