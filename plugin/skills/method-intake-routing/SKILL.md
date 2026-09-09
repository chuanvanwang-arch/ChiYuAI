---
name: method-intake-routing
description: 接诊分流方法论（A）——新询盘接入时识别意图类型与商机级别（一般/重大），按级派发路由（B 报价 / C 跟进 / D 把关），派发写 contract_task_id 完成契约闭环关联。
environment:
  required: []
  optional: []
security:
  requiresSecrets: false
  sensitiveEnvironment: false
  externalNetworkAccess: false
---

# method-intake-routing · 接诊分流方法论（A）

> 定位：A 接诊分流 agent（intake-router）判断"新询盘该派给谁、按什么级别派"时参考的方法论。
> 机器可读维度见 `methodology.json`（唯一事实源）；意图识别维度见 `core/evaluate.md`；分级规则见 `rules/grading.md`；商机级别释义见 `references/levels.md`。

## 适用场景（调用即自然语言）

- "新询盘来了，识别意图并按商机级别派活"
- "这条询盘是报价意向还是售后，该给 B 还是 C"

## 决策步骤

1. **意图识别**：解析询盘内容 → 意图类型（报价/售前/售后/其他）
2. **商机分级**：按客户规模×需求复杂度 → 一般/重大
3. **派发路由**：一般 → B（报价）；重大 → B + D（全程把关）
4. **写入决策事件**：派发携带 `decision_id`（第 0 闸铁律）

## 铁律

- 一切派发写 `payload.contract_task_id`（契约闭环关联键）
- 意图无法识别时回退人工分流，不静默丢弃