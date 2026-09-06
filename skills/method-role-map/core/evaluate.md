# method-role-map · 评估流程（五步）

> 唯一事实源 = `method-role-map/methodology.json`（维度/权重/门控）。本页是执行步骤。

## 步骤

1. **取上下文**：商机粒子（CRM_DEAL）的 `payload.name/stage/owner_id` + 已接触人清单（`payload.contacts`）+ 决策场景 `eval_dimensions` 条件。
2. **逐类识别与拓扑**：
   - D：谁最终拍板（`payload.economic_buyer`）？预算审批链几级？
   - I：谁影响决策（技术评审/财务/法务）？是否已接触或仅听说？
   - U：谁每天用系统（`payload.users`）？痛点谁在代言？
   - S：合规/运维/采购关切（`payload.stakeholders`）？是否已纳入沟通？
3. **标注立场**：对方案 支持/中立/反对（`payload.support_stance`：champion_strength ≥3 视为支持，出现"我们没有这个预算"类表述视为反对）。
4. **找关键路径**：必须打通的支持路径 + 必须转化的反对节点；若 D/I 有反对 → 路径受阻。
5. **产出结论**：`{ verdict, topology[], stance[], gate }`，gate ∈ `PATH_CLEAR | BLOCKED_DECISION | BLOCKED_OBJECTOR | UNKNOWN_TOPOLOGY`，优先列出最弱环节。