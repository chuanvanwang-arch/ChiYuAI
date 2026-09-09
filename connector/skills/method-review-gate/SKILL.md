---
name: method-review-gate
description: 评审把关方法论（D）——重大商机双闸门（报价复核/合同确认）+ 专家介入 + 内置四维审查（功能/架构/安全/合规），决策留痕可溯源。
environment:
  required: []
  optional: []
security:
  requiresSecrets: false
  sensitiveEnvironment: false
  externalNetworkAccess: false
---

# method-review-gate · 评审把关方法论（D）

> 定位：D 评审把关 agent（review-gate）判断"这单重大商机能否放行/该不该介入"时参考的方法论。
> 机器可读维度见 `methodology.json`（唯一事实源）；评审流程见 `core/evaluate.md`；四维审查基线见 `rules/dimensions.md`；双闸门详解见 `references/gates.md`。

## 适用场景（调用即自然语言）

- "这个重大商机的报价/合同需要复核把关"
- "双闸门 + 四维审查（功能/架构/安全/合规）"

## 决策步骤

1. **接收审查**：接收重大商机审查请求（报价复核 / 合同确认）
2. **加载数据**：加载商机/合同数据（crm-deal-advance / crm-account-360）
3. **四维审查**：功能/架构/安全/合规逐维审查（见 rules/dimensions.md）
4. **双闸门判定**：报价复核闸 + 合同确认闸；任一不过 → 缺陷清单，不输出"通过"
5. **专家介入**：无法自动判定时升级专家（HITL）
6. **决策留痕**：每次把关写 decision 事件（第 0 闸铁律），留痕可溯源

## 结构化 verdict 输出契约（gate 阻断前置，2026-09-01）

> 调度器 `runGateAgents` 据此判定「通过/不通过」，非仅靠异常。
> 每次评审**必须**以如下结构化结论收尾（写入 outcome 顶层字段）：

- `verdict`: `'pass'` | `'reject'` —— 四维审查全过且双闸门均放行才 `pass`；任一不通过即 `reject`
- `defects`: `string[]` —— `reject` 时列出具体缺陷（如「毛利低于阈值 18%」「合同缺少 SLA 条款」）；`pass` 时为空数组
- `summary`: `string` —— 一句评审结论

示例（reject）：
```json
{ "verdict": "reject", "defects": ["报价毛利 12% < 阈值 18%", "合同未含数据合规条款"], "summary": "双闸门未过，退回重做" }
```

> fail-safe：若未输出 `verdict` 或 `verdict!=='pass'`，调度器保守判 `reject`（主任务挂起），避免静默通过。

## 铁律

- 四维任一不通过 → 不输出「通过」，给具体缺陷清单
- 每次审查输出 decision 事件（第 0 闸铁律），留痕可溯源