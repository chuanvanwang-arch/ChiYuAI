# method-risk-tradeoff · 评分与门控（rules/scoring.md）

## 评分标尺

| 分档 | 含义 | 证据要求 |
|---|---|---|
| 0.0–0.5 | 无证据/反证 | 无信用评级、无付款记录、无风险识别 |
| 0.6–0.79 | 口头确认 | 客户口头承诺付款、无书面信用资料 |
| 0.8–0.94 | 书面/实测 | 信用报告、历史付款记录、合同条款 |
| ≥0.95 | 多方验证 | 信用报告 + 参考客户 + 第三方担保佐证 |

## 门控（gate）

- `RD`（红线）触碰（合规违规/信用评级低于底线/交付能力硬伤）→ **REDLINE_BLOCK**（一票否决，禁止推进）。
- `R` 高（≥0.8）且 `M`（缓解措施）缺失（<0.6）→ **MITIGATION_REQUIRED**（先补缓解，禁止推进）。
- `R` 高、`M` 落地但收益无法覆盖（`ratio < 1`）→ **STOP_LOSS**（触发止损视角，对齐 `method-stop-loss`）。
- 四条均过 → **GO**（可推进，但需带缓解条款入报价）。

## 与平台机制衔接

- `REDLINE_BLOCK / MITIGATION_REQUIRED` 禁止 `crm-deal-advance` 推进（第 0 闸联动）。
- 评估结果写入 `decision` 表（scenario_id=`RISK_ASSESS`，disposition=`GO/REDLINE_BLOCK/MITIGATION_REQUIRED/STOP_LOSS`），供决策网络先例检索。
- 缓解措施建议落入报价/合同条款（如预付定金、分期付款、交付里程碑）。