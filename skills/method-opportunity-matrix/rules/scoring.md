# method-opportunity-matrix · 评分与门控（rules/scoring.md）

## 评分标尺

| 分档 | 含义 | 证据要求 |
|---|---|---|
| 0.0–0.5 | 无证据/反证 | 无金额、无决策链、无可复制性 |
| 0.6–0.79 | 部分证据 | 口头预测金额、决策链未完全打通 |
| 0.8–0.94 | 书面/实测 | 预算批复、POC 通过、参考案例 |
| ≥0.95 | 多方验证 | 金额由经济买家背书 + 决策链实测 + 案例佐证 |

## 象限门控（gate）

| 象限 | 条件 | 动作 |
|---|---|---|
| PRIMARY | V1≥0.6 且 F1≥0.6 | 主攻：优先投入（推进 stage） |
| NURTURE | V1≥0.6 且 F1<0.6 | 培育：补决策链后再评估 |
| HARVEST | V1<0.6 且 F1≥0.6 | 收割：低成本快取 |
| PARK | V1<0.6 且 F1<0.6 | 暂缓：禁止继续投入资源 |

- `PARK` 象限商机禁止推进 `crm-deal-advance`（先补价值证据或明确放弃）。
- `PRIMARY` 象限商机优先于其他象限获得推进/报价资源。

## 与平台机制衔接

- 排序结果写入 `decision` 表（scenario_id=`OPPORTUNITY_PRIORITIZE`，disposition=`PRIMARY/NURTURE/HARVEST/PARK`），供决策网络先例检索。
- 资源分配建议对齐 `crm-deal-advance` 的推进闸：非 PRIMARY 象限不占用主攻资源。