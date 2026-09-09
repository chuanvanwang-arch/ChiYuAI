---
name: method-quote-engine
description: 报价测算方法论（B）——基于配置/成本/毛利实时测算报价，输出 A/B 两方案（含毛利预估），报价有数据支撑、可复核。
environment:
  required: []
  optional: []
security:
  requiresSecrets: false
  sensitiveEnvironment: false
  externalNetworkAccess: false
---

# method-quote-engine · 报价测算方法论（B）

> 定位：B 报价测算 agent（quote-engine）判断"该报多少价、方案怎么算"时参考的方法论。
> 机器可读维度见 `methodology.json`（唯一事实源）；测算流程见 `core/calculation.md`；成本毛利规则见 `rules/pricing.md`；报价方案释义见 `references/quote-plans.md`。

## 适用场景（调用即自然语言）

- "这个配置报价多少，毛利多少"
- "给客户出 A/B 两个报价方案各含毛利预估"

## 决策步骤

1. **配置读取**：拉取商机配置/需求明细（CRM_DEAL payload）
2. **成本测算**：按配置项×成本基准 → 总成本
3. **毛利测算**：目标毛利率 → 报价区间；A/B 两方案（标准/低毛利保单）
4. **复核留痕**：报价写 decision 事件（第 0 闸铁律），留痕可溯源

## 铁律

- 报价必须含毛利预估（无毛利支撑的报价不输出）
- A/B 方案至少一档可满足毛利率红线；触碰红线需 D 把关