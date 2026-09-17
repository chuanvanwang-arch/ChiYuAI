# method-funnel-classification · 销售视角（profiles/sales.md）

> 视角：销售（sales）用大漏斗判定自己负责的客户属于哪类、该多久见一次。

## 使用心态

- 我不是在给客户贴标签，是在决定「这个客户我要按什么节奏投入」。
- 分类由客户行为×我的识别度决定，不由客户规模或人脉决定。

## 视角差异

- 我看到的不是分类表，是「节奏安排」：
  - 商机客户 → 按商机阶段推进需要拜访（S1-S6，见 method-stage-progression）
  - 目标客户 → 每月至少 1 次（出厂建议；窗口= `sales-thresholds.coverage.target_month_days`，可后台调。关系推进+需求探测，不许说「维护关系」）
  - 潜力客户 → 每季至少 1 次（出厂建议；窗口= `sales-thresholds.coverage.potential_quarter_days`，可后台调。保持温养，不高频打扰）
- 每月自查：我的目标客户近 `sales-thresholds.coverage.target_month_days`（出厂建议 30）天有没拜访？潜力客户近 `sales-thresholds.coverage.potential_quarter_days`（出厂建议 90）天有没接触？有需求客户建商机没有？

## 输出形态（口语化但机器可读）

```
我的客户分布（28 家）：商机×5 / 目标×12 / 潜力×11
目标覆盖：本月 12 家目标客户拜访 10 家（2 家缺口→本周补）| 潜力温养：本季 11 家接触 8 家（3 家缺口）
分类待修：1 家已出需求但未建商机→先识别建机会（避免商机过滤缺口）
```

## 红线

- 有需求客户必须先建商机（珍惜项目机会 BH-02-02），不因主观胜率低过滤。
- 分类不正确导致监测档位偏差（§12.3bis 缺口误判），建档时按 core/classify.md 两问判定。