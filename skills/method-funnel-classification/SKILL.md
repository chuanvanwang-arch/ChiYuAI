---
name: method-funnel-classification
description: 大漏斗客户分类方法论——按客户行为×销售感知四象限判定商机/目标/潜力客户，定义接触节奏（商机按需/目标月1/潜力季1，均为出厂建议值，具体次数与窗口由配置中心 id30 与 sales-thresholds.coverage 决定）。适用于客户建档时的 account_segment/tier 赋值、接触频度规划、指名客户监测的档位来源。
environment:
  required: []
  optional: []
security:
  requiresSecrets: false
  sensitiveEnvironment: false
  externalNetworkAccess: false
---

# method-funnel-classification · 大漏斗客户分类

> 定位：销售判断"这个客户属于哪一类、该多久见一次"时参考的方法论。
> 分类流程见 `core/classify.md`；节奏规则见 `rules/rhythm.md`；释义与 溯源见 `references/funnel.md`。

## 适用场景（调用即自然语言）

- "这个客户算商机还是目标客户？该多久拜访一次？"
- 客户建档时 `account_segment` / `tier` 字段赋值前
- 指名客户监测的档位来源（§13.2 `tier_rule: by_payload`）

## 四象限分类快查

| 客户行为（要不要解决） | 销售感知（识别了吗） | 分类 | 接触节奏 |
|---|---|---|---|
| 已行动 | 已识别 | 商机客户（S1–S6） | 按商机阶段推进需要 |
| 已行动 | 未识别 | 目标客户 | 每月 ≥1 次（出厂建议；窗口= `sales-thresholds.coverage.target_month_days`，可后台调） |
| 未行动 | 已识别 | 目标客户 | 每月 ≥1 次（出厂建议；窗口同上） |
| 未行动 | 未识别 | 潜力客户 | 每季 ≥1 次（出厂建议；窗口= `sales-thresholds.coverage.potential_quarter_days`，可后台调） |

## 关键机制

- 分类输出消费方：`CRM_ACCOUNT.account_segment`（AI 属性 C_Classify）+ `tier`（目标指标配置消费）
- 与 method-followup-engine 互补：本方法论定义"该多久见一次"（规律节奏）；followup-engine 管"超期了怎么办"（异常催办）
- 与 method-role-map 互补：role-map 管客户内部角色拓扑；本方法论管客户整体分层

## 角色视角

- sales：我负责的客户分类是否正确、节奏是否达标（profiles/sales.md）
- manager：团队客户分类分布、覆盖缺口（profiles/manager.md）