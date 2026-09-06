# method-presales · 评估引擎（core/evaluate.md）

> 给定商机（CRM_DEAL）与可选已有技术方案（CRM_TECHNICAL_PROPOSAL），逐项走 `methodology.json` 维度 → 产出评分与缺口。

## 输入
- `deal`：CRM_DEAL 粒子（stage/customer_tier/project_tier/payload）
- `proposal`（可选）：已生成的 CRM_TECHNICAL_PROPOSAL 粒子

## 评估流程
1. **取维度模板**：读 `methodology.json` 的 `dimensions`。
2. **逐项评分**（0–1，自动取数优先，缺失则向用户追问）：
   - **S1 方案契合度**：从 deal.payload 取 `identified_pain`/`requirements`，比对 proposal 覆盖度。
   - **S2 技术可行性**：检查 proposal 是否引用 `technical_constraints`、有无未解决依赖；存在硬伤 → 标记 `blocker`。
   - **S3 价值量化**：检查是否含 `quantified_benefit`（ROI/节约额）；无量化 → 缺口。
   - **S4 风险与异议**：扫描 `known_objections`/`compliance` 字段；未覆盖 → 缺口。
   - **S5 差异化**：对比竞品字段；可选。
   - **S6 交付可信度**：检查 `poc_status`/`demo_done`/`reference_case`；未验证 → 缺口。
3. **加权求分**：`methodology_score = Σ(dim.score × dim.weight) / Σ(dim.weight)`（required 维度权重计入）。
4. **门控判定**：任一 required 维度 `score < 0.6` → `gate = FAIL`，输出"禁止推进至报价/合同，待补齐"。
5. **写回**：结论写入 `decision.conditions_evaluated`（经决策主轴第 0 闸）。

## 输出
```json
{
  "methodology_id": "PRESALES_SOLUTION",
  "methodology_score": 0.82,
  "gate": "PASS",
  "dimensions": [
    {"dim_key":"S1","score":0.9,"gap":null},
    {"dim_key":"S2","score":0.85,"gap":null},
    {"dim_key":"S3","score":0.7,"gap":"ROI 未量化，需补节约额测算"},
    {"dim_key":"S4","score":0.9,"gap":null},
    {"dim_key":"S5","score":0.6,"gap":null},
    {"dim_key":"S6","score":0.8,"gap":"POC 尚未执行"}
  ],
  "next_action": "建议触发 crm-proposal-write 补齐 ROI 测算与 POC 计划"
}
```
