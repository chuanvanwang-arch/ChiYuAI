# method-behavior-standard · TAORAN 六要素记录规范（rules/taoran.md）

> 对齐 to-b 场景七标准 15-16：每个 `visit_notes[]` 元素须含六要素（T/A/O/R/A/N）。
> 落点：`visit-return-writeback.mjs:113-123` 字段扩展（visit_notes 每元素六字段）。

## 六要素定义

| 要素 | 字段名 | 含义 | 质检判定规则 |
|---|---|---|---|
| T Type | t_type | 客户类型（商机/目标/潜力）+ 商机阶段 | 自动同步 客户类型 |
| A Appointment | t_appointment | 是否预约 | 商机客户原则上应有预约（无预约=缺口） |
| O Objective | t_objective | 拜访目的与关键结果 | 按客户类型/商机阶段限定范围选择，写明可量化具体成果（对齐 BH-01-02 目的明确） |
| R Result | t_result | 拜访结果和过程描述 | 引用客户原话，不能只写主观判断（对齐 method-fact-vs-script） |
| A Achieved | t_achieved | 是否达标 | ≥ `sales-thresholds.taoran.achieved_ratio`（出厂建议 80%）=达到 / < `sales-thresholds.taoran.unachieved_ratio`（出厂建议 20%）=未达到 / 其他=部分达到 |
| N Next Step | t_next | 后续安排 | 商机客户=下一步具体行动；目标/潜力=按频度设定下次拜访时间（对齐 BH-01-01） |

## 质检判定

- 六字段全有 → sales_visit_value=true（合格）
- 缺 O/R/N → gap（sales_visit_gaps 列出缺项）
- t_achieved=未达到 且无下一步 → 无效拜访缺口（BH-03-03 不做无效拜访）
- 商机客户无预约（t_appointment=false）→ 预约缺口

## 与 21 条分层

- TAORAN = 单次拜访记录规范（visit_notes[] 每元素六字段）
- 21 条行为合格线 = 跨拜访行为合格标准（经理看板维度）
- 单次记录合格（TAORAN）是跨拜访行为合格（21 条）的事实基础