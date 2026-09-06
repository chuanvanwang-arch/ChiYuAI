# method-meddicc · 评分与门控（rules/scoring.md）

## 评分标尺

| 分档 | 含义 | 证据要求 |
|---|---|---|
| 0.0–0.5 | 无证据/反证 | 无经济买家、无决策标准、无真实痛点陈述 |
| 0.6–0.79 | 口头意向 | 客户口头表示有预算决策权/流程将走 POC，无书面佐证 |
| 0.8–0.94 | 书面/实测 | 预算批复、RFP 收到、POC 排期、决策链实测确认 |
| ≥0.95 | 多方验证 | 经济买家亲述 + 书面流程节点 + 参考案例三方佐证 |

## 门控（gate）

- `ready < 0.6` 或任一 required 维度（E1/D1/D2/I1）< 0.6 → **BLOCKED**（禁止乐观推进 win 判断/报价）。
- `gate=WIN_CONFIDENT` 仅当：E1/D1/D2/I1 全 ≥0.6 且 C1（champion）已有实证。
- 证据优先级（事实优先于话术）：书面实测 > POC/参考 > 口头意向；口头意向不得单独支撑 `WIN_CONFIDENT`。

## 与平台机制衔接

- 商机推进/报价前调用 `ruleEngine.check('CRM_DEAL','advance',{...})`（只进不退 + 输单必填原因）。
- 评估结果写入 `decision` 表（scenario_id=`OPP_QUALIFY`/`WIN_ASSESS`，disposition=`WIN_CONFIDENT/BLOCKED`），供决策网络先例检索。