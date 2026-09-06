---
name: method-behavior-standard
description: 销售行为合格线（21 条 BH-01~07）——可观察的有/无检查项，不设评分阈值；TAORAN 六要素拜访记录规范。适用于拜访后质检、经理周会行为看板、标准化动作沉淀。
environment:
  required: []
  optional: []
security:
  requiresSecrets: false
  sensitiveEnvironment: false
  externalNetworkAccess: false
---

# method-behavior-standard · 销售行为合格线（21 条 + TAORAN）

> 定位：质检"这次拜访/这条商机行为是否合格"时参考的检查清单。
> 21 条检查项见 `core/checklist.md`；TAORAN 记录规范见 `rules/taoran.md`；标准动作库见 `references/standard-actions.md`。

## 适用场景（调用即自然语言）

- 拜访归来回写后的质检判定（sales_visit_value / sales_visit_gaps）
- 经理周会行为合格线看板（21 条逐条"证据有/无"）
- 标准动作沉淀（合格行为 → 标准动作库）

## 核心立场

- **21 条是合格线（有/无），不设评分阈值**（防过度设计，量化打分留给 calibration P2）
- **判定必须有可观察证据**（访前计划存在 / 6 问字段非空 / 有复盘），不凭主观印象

## 与 TAORAN 分层

- TAORAN 六要素 = 单次拜访记录规范（visit_notes[] 每元素六字段）
- 21 条行为合格线 = 跨拜访行为合格标准（经理看板维度）
- 两者分层：单次记录合格（TAORAN）→ 跨拜访行为合格（21 条）

## 角色视角

- sales：每次拜访归来对照 21 条自查是否合格、TAORAN 是否齐全（profiles/sales.md）
- manager：周会看行为合格率（21 条证据有/无）、标准动作执行情况（profiles/manager.md）