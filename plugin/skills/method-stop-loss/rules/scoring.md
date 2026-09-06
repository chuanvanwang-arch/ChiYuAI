# method-stop-loss · 评分与门控（rules/scoring.md）

## 评分标尺

| 分档 | 含义 | 证据要求 |
|---|---|---|
| 0.0–0.5 | 无证据/反证 | 无投入流水、无预算上限、无退出门定义 |
| 0.6–0.79 | 部分证据 | 有投入大致估计、预算上限口头约定、退出门未书面化 |
| 0.8–0.94 | 书面/实测 | 投入流水台账、预算上限批复、退出门写入商机评审纪要 |
| ≥0.95 | 多方验证 | 投入流水+预算批复+退出门评审三方佐证 |

## 门控（gate）

- 净值 < 0 且无回升路径（`win_probability` 无提升迹象）→ **EXIT_REQUIRED**（禁止继续投入）。
- 预算使用率 > 100%（`invested_cost / investment_budget > 1`）→ **EXIT_REQUIRED**（超支即撤）。
- EG 命中（关键里程碑连续未达成 / 关键决策人离职 / 客户信用恶化）→ **EXIT_REQUIRED**。
- 净值正但接近预算上限或单月投入加速 → **WATCH**（降投入节奏、设定复查点）。
- 净值健康、预算充足、无触发信号 → **CONTINUE**。

## 与平台机制衔接

- `EXIT_REQUIRED` 禁止 `crm-deal-advance` 推进与继续投入（第 0 闸联动）。
- 退出结论写入 `decision` 表（scenario_id=`STOP_LOSS_ASSESS`，disposition=`CONTINUE/WATCH/EXIT_REQUIRED`），供决策网络先例检索（"以前哪个单子该撤没撤"）。
- 退出门触发后建议动作：复盘投入浪费原因 → 沉淀为团队商机准入/投入预算规则。