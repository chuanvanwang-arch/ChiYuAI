# R7 先例自锁 · 立项草稿（决策引擎语义变更）

> 立项性质：**决策引擎语义变更**，独立立项（不并入记忆回写修复）
> 关联：autonomyEngine.js 升级路径 / decisionRepo.js 先例池过滤
> 现状已核实，待 brainstorming 出方案后批准实施。

---

## 一、问题陈述（已源码核实）
- `autonomyEngine.js:324`：决策升级 HITL 时落 `state:'HUMAN'`，`decider_type:'HUMAN'`。
- `decisionRepo.js:544`：先例池查询 `WHERE scenario_id=$1 AND state IN ('CONFIRMED','AUTONOMOUS')` → **HUMAN 态决策被排除在先例池外**。
- **但** HUMAN 决策经 HITL 确认后（`decisionRepo.js:632` `UPDATE … state='CONFIRMED'`）会升 CONFIRMED 并进入先例池。
- 故「自锁」仅影响 **升人工后从未被正式确认** 的决策——这些人工真实判断样本永不进入先例池。

## 二、语义影响
- 先例池缺失「人工真实判断」样本 → 同类 scenario 后续决策的先例依据质量/覆盖下降。
- 不破坏任何链路（已确认决策仍进池）；属决策语义收敛问题，非正确性缺陷。
- 下游消费方：`searchPrecedents`(`autonomyEngine.js:209`、`assembleContextV2.js:90`) 全部经此过滤，改过滤条件影响所有推理路径。

## 三、候选方案
| 方案 | 语义 | 收益 | 风险/成本 | 评估 |
|---|---|---|---|---|
| **A. 维持现状** | 先例 = 已确认/自动决策；HUMAN 未确认不入池 | 简单、语义清晰 | 未确认人工知识丢失 | 若「升人工未确认」占比低，可接受 |
| **B. 扩展先例池收 HUMAN** | `IN ('CONFIRMED','AUTONOMOUS','HUMAN')` | 人工决策直接成先例 | HUMAN 态可能「待定/悬而未决」或被改写，污染推理 | 需加护栏：`decider_id` 非空 + 非待定 disposition |
| **C. 新增 HUMAN_CONFIRMED 中间态** | 人工处置完且有效的终态才入池 | 语义最准 | 改状态机 + 迁移 + 各消费方（monitor/disposition 等） | 成本最高，语义最干净 |
| **D. 入池判定改「终态」** | 不再白名单，终态（不再可变）即入池 | 通用、避免枚举漂移 | 需定义「终态」集合并审计所有写 HUMAN 的出口 | 需定终态清单 |

## 四、立项待决（brainstorming 阶段）
1. **先量化再决策**：用 §13 闭环脚本/探针统计「升人工后未确认」决策占比，决定是否需要改。
2. 若占比显著 → 推荐 **B + 护栏**（最小改动、语义可控），或 **C**（若需严格终态语义）。
3. 护栏硬约束（若走 B）：`decider_id IS NOT NULL` 且 `disposition NOT IN ('PENDING')`；且 HUMAN 态被改写时不反向污染已引用先例（`decision_precedent_rel` 仅增不删，见 `decisionRepo.js:679` 蒸馏降权非删）。

## 五、影响面与回归
- 改动点：`decisionRepo.js:544` 过滤条件 + 可能的状态机（`autonomyEngine.js`）。
- 必跑：全量决策引擎测试 + `searchPrecedents` 调用方（`autonomyEngine.js:209`、`assembleContextV2.js:90`）先例质量断言 + 先例覆盖度对比（改前/改后）。
- 不可破坏：`memory_log` append-only、先例关系 `decision_precedent_rel` 仅增不删、蒸馏降权逻辑。

## 六、回滚
- 过滤条件改动 → `git revert` 即复原。
- 若引入新状态（C/D）→ 需迁移回滚脚本 + 消费方 revert。

## 七、建议立项步骤
1. 量化探针（占比统计）→ 决定 A 或继续。
2. brainstorming 出 2–3 方案 + 护栏细节 → 用户批准。
3. writing-plans 出实施计划（含迁移/回归/回滚）→ 实施。
