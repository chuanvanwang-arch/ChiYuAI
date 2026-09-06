# method-funnel-classification · 接触节奏规则（rules/rhythm.md）

## 节奏定义

| 分类 | 节奏 | 窗口 | 达标口径 |
|---|---|---|---|
| 商机客户 | 按需 | 按阶段推进需要 | 阶段推进不卡点即达标 |
| 目标客户 | ≥1 次/月 | `sales-thresholds.coverage.target_month_days`（出厂建议 30 天） | 近 30 天 visit_notes 非空 |
| 潜力客户 | ≥1 次/季 | `sales-thresholds.coverage.potential_quarter_days`（出厂建议 90 天） | 近 90 天 visit_notes 非空 |

## 对齐

- 默认节奏与 config_store['named-account-targets'] 默认三档一致（重点 1/周 · 目标 1/月 · 潜力 1/季）。
- 配置中心可改节奏 → 本规则是「方法论默认」，配置是「当前生效值」。
- 商机客户的节奏 = 按商机阶段推进需要（S1-S6，见 method-stage-progression），不套固定月/季节奏。

## 铁律

- 目标客户 `sales-thresholds.coverage.target_month_days`（出厂建议 30）天无拜访 → 覆盖率缺口（§12.3bis）
- 潜力客户 `sales-thresholds.coverage.potential_quarter_days`（出厂建议 90）天无拜访 → 温养缺口（§12.3bis）
- 有需求客户未建商机 → 商机过滤缺口（BH-02-02 珍惜项目机会）