---
name: method-stage-progression
description: 商机阶段推进方法论（S1–S6）——按客户行为×拜访目的×输单条件三列判定当前阶段与推进条件，对接 method-stop-loss 止损。适用于商机阶段判定、阶段推进前置检查、管线卡点识别。
environment:
  required: []
  optional: []
security:
  requiresSecrets: false
  sensitiveEnvironment: false
  externalNetworkAccess: false
---

# method-stage-progression · 商机阶段推进（S1–S6）

> 定位：销售判断"这个商机现在到哪一步、下一步做什么、何时该止损"时参考的方法论。
> 机器可读定义见 `methodology.json`（唯一事实源）；推进流程见 `core/progression.md`；SWAS 回顾见 `core/swas.md`；阶段闸见 `rules/gates.md`；释义与 溯源见 `references/stages.md`。

## 适用场景（调用即自然语言）

- "这条商机现在到哪一步？下一步该做什么？"
- "这个商机该推进还是该放弃？"
- 商机 `stage` 变更前的阶段判定（crm-deal-advance 前置）

## 阶段快查（客户行为 × 拜访目的 × 输单条件）

| 阶段 | 客户行为 | 拜访目的 | 输单条件 |
|---|---|---|---|
| S1 | 客户开始寻找供应商/评估需求 | 发掘线索、确认需求存在 | 无可跟进线索/需求不成立 → 输单 |
| S2 | 客户明确需求与痛点 | 与客户确认需求细节 | 需求不成立/无预算 → 输单 |
| S3 | 客户评估方案匹配度 | 提供匹配方案并获得认可 | 方案不匹配/被竞品替代 → 输单 |
| S4 | 客户评估商务条款与报价 | 报价并谈判达成一致 | 价格谈不拢/商务条款不认可 → 输单 |
| S5 | 客户内部审批合同 | 合同条款达成一致并签署 | 合同条款未达成一致 → 输单 |
| S6 | 客户验收付款完成、项目移交 | 确保验收付款、顺利移交 | —（终态） |

## 推进判定（rules/gates.md 摘要）

```
S1→S2：存在客户需求描述（现场 6 问 needs 有实质内容）
S2→S3：方案验证拜访被质检判有价值
S3→S4：通过 method-bant 资质闸（BANTCC 无硬缺口）+ 报价已出
S4→S5：通过 method-review-gate 双闸门（报价复核+合同确认）
S5→S6：存在合同签署事实（decision 事件+合同粒子）
```

## 关键机制

- **阶段判定看客户行为变化，不只看内部状态**（to-b 场景五标准 10-11）
- **输单条件对接 method-stop-loss**：S1/S2/S3/S4 输单条件=止损触发点，不空耗
- **SWAS 强制**：每个可推进商机须能回答 S/W/A/S 四要素（core/swas.md）

## 角色视角

- sales：我在哪一步、下一步拜访做什么（profiles/sales.md）
- manager：管线阶段分布、卡点判定（profiles/manager.md）

## 与既有机制衔接

- 输出消费：`crm-deal-advance` 阶段推进（第 3.5 闸 soft gate 读本方法论）
- 与 `method-opportunity-matrix` 互补：矩阵答"先打哪条"，本方法论答"这条到哪步"