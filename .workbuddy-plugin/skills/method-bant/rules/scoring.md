# method-bant · 评分与门控（rules/scoring.md）

## 评分标尺

| 分档 | 含义 | 证据要求 |
|---|---|---|
| 0.0–0.5 | 无证据/反证 | 无预算号、无决策人、无痛点陈述 |
| 0.6–0.79 | 口头意向 | 客户口头有预算/决策人口头授权，无书面佐证 |
| 0.8–0.94 | 书面/实测 | 预算批复单、决策链实测、POC 通过记录 |
| ≥0.95 | 多方验证 | 决策人亲述 + 书面 + 参考案例三方佐证 |

## 门控（gate）

- `ready < 0.6` 或任一 required 维度（B/A/N）< 0.6 → **BLOCKED**（禁止 `crm-deal-advance` 推进阶段）。
- `gate=ADVANCE_ALLOWED` 仅当：B/A/N 全 ≥0.6 且 T 已明确时间窗。
- 证据优先级（事实优先于话术）：书面实测 > POC/参考 > 口头意向；口头意向不得单独支撑 `ADVANCE_ALLOWED`。

## 与平台机制衔接

- 商机推进前调用 `ruleEngine.check('CRM_DEAL','advance',{...})`（只进不退 + 输单必填原因）。
- 评估结果写入 `decision` 表（scenario_id=`OPP_QUALIFY`，disposition=`ADVANCE_ALLOWED/BLOCKED`），供决策网络先例检索。