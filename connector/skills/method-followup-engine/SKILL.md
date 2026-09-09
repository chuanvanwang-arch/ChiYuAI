---
name: method-followup-engine
description: 跟进催办方法论（C）——自动跟进提醒、节点催办、超期未跟进预警并转人工，保障商机推进不遗漏、回款闭环。
environment:
  required: []
  optional: []
security:
  requiresSecrets: false
  sensitiveEnvironment: false
  externalNetworkAccess: false
---

# method-followup-engine · 跟进催办方法论（C）

> 定位：C 跟进催办 agent（followup-agent）判断"该催谁、催什么、何时转人工"时参考的方法论。
> 机器可读维度见 `methodology.json`（唯一事实源）；跟进流程见 `core/followup.md`；节点催办规则见 `rules/reminder.md`；超转人工阈值见 `references/escalation.md`。

## 适用场景（调用即自然语言）

- "这个商机三天没跟进，该咋办"
- "自动跟进提醒、节点催办、超期转人工"

## 决策步骤

1. **跟进扫描**：按商机阶段扫描超期未跟进记录（自动跟进提醒）
2. **节点催办**：关键节点（报价确认/合同签署/回款）到期自动催办
3. **超时转人工**：超期未跟进 → 预警并转人工（不静默）
4. **写入决策事件**：催办动作写 decision 事件（第 0 闸铁律）

## 铁律

- 超期未跟进必须预警并转人工，不允许静默跳过
- 节点催办有节流（不轰炸）：同一节点 24h 内最多催办 1 次