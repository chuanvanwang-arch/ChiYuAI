# method-presales · 评分与门控规则（rules/scoring.md）

## methodology_score 公式
```
methodology_score = Σ(dim.score × dim.weight) / Σ(dim.weight)   # 仅计已评估维度权重
```

## 门控规则（gate_rule）
- 任一 `required: true` 维度 `score < 0.6` → `gate = FAIL`。
- `gate = FAIL` 时：禁止推进商机至 `quoted`/`contracted` 阶段（对齐 §6.5 决策场景 OPP_QUALIFY / QUOTE_PRICING 的前置门槛）。
- `priority_rule`：技术硬伤（S2 < 0.6）一票否决，无需再看其他维度。

## 阈值
- `>= 0.8`：方案就绪，可进入报价/合同支撑。
- `0.6 – 0.8`：基本可行，需补齐次要缺口（如 S3/S6）。
- `< 0.6`：方案不成熟，退回售前重做。
