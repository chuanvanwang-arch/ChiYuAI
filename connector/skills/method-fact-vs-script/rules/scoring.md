# method-fact-vs-script · 事实vs话术 评分与门控（rules/scoring.md）

## 评分标尺（证据等级 E）

| 分档 | 含义 | 证据要求 |
|---|---|---|
| 0.0–0.5 | 无证据/反证 | 口头陈述无任何佐证、前后矛盾 |
| 0.6–0.79 | 部分证据 | 口头陈述+客户内部人口径一致，但无书面/实测 |
| 0.8–0.94 | 书面/实测 | 邮件/合同/批复、POC/DEMO 实测记录 |
| ≥0.95 | 多方验证 | 书面 + 实测 + 第三方/参考案例三方佐证 |

## 门控（gate）

- 商机推进所依赖的维度（BANT B/A/N、MEDDICC E1/I1 等）**仅有话术支撑（E<0.8）** → `NEEDS_VERIFICATION`（禁止乐观推进，先验证）。
- 全部关键维度有事实支撑（E≥0.8）→ `FACT_CONFIRMED`（可按事实推进）。
- 关键维度仅有口头承诺且无任何验证计划 → `SCRIPT_ONLY`（禁止推进，先立验证动作）。
- 证据优先级（事实优先于话术）：书面实测 > POC/参考 > 口头意向；口头意向不得单独支撑推进。

## 与平台机制衔接

- 事实/话术分类结果写入商机 payload（`payload.facts[]` / `payload.scripts[]` / `payload.evidence_map`），供 BANT/MEDDICC 评估直接引用。
- 评估结论写入 `decision` 表（scenario_id=`FACT_ASSESS`，disposition=`FACT_CONFIRMED/NEEDS_VERIFICATION/SCRIPT_ONLY`），供决策网络先例检索。
- `SCRIPT_ONLY` 禁止 `crm-deal-advance` 推进（第 0 闸联动）。