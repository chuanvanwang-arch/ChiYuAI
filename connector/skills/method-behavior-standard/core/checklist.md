# method-behavior-standard · 21 条检查项（core/checklist.md）

> 唯一事实源 = `methodology.json`（分类 + 标准清单）。本页是可观察检查项表格。
> 判定原则：**有 / 无（事实判定），不设评分阈值**。

## 21 条检查项（可观察证据）

| 类 | 标准 | CRM 可观察检查项 |
|---|---|---|
| BH-01 | 01-01 时间安排饱满 | 拜访计划存在且周维度有排期 |
| BH-01 | 01-02 目的明确 | 拜访目的字段非"维护关系"笼统话（有量化成果描述） |
| BH-01 | 01-03 工作计划完善 | 有访前准备记录（prepare 字段） |
| BH-02 | 02-01 拜访所有客户 | 拜访覆盖 ≥2 类客户（商机/目标/潜力） |
| BH-02 | 02-02 珍惜项目机会 | 有需求客户已建商机（商机过滤缺口=否） |
| BH-03 | 03-01 BANTCC | BANTCC 信息齐全（bantcc_completeness ≥ `sales-thresholds.bantcc.pass`，出厂建议 0.6） |
| BH-03 | 03-02 关注需求 | needs 有"为什么"（pain 字段非空） |
| BH-03 | 03-03 不做无效拜访 | 拜访有明确目的（非"路过看看"） |
| BH-03 | 03-04 访前准备 | 有访前准备记录 |
| BH-04 | 04-01 理解关系作用 | 联系人有角色标注（business_title） |
| BH-04 | 04-02 积极发展 | 有联系人拓展记录 |
| BH-04 | 04-03 主动管理 | 有主动安排下次拜访（visit_notes[].t_next） |
| BH-05 | 05-01 科学分类 | account_segment/tier 已赋值 |
| BH-05 | 05-02 接触潜力 | 潜力客户近 `sales-thresholds.coverage.potential_quarter_days`（出厂建议 90）天有接触 |
| BH-05 | 05-03 关注目标 | 目标客户近 `sales-thresholds.coverage.target_month_days`（出厂建议 30）天有接触 |
| BH-06 | 06-01 看到所有商机 | 商机全量可见（未隐藏） |
| BH-06 | 06-02 识别致胜关键 | 有 win_strategy 字段（SWAS 的 W） |
| BH-06 | 06-03 寻求团队 | 有求助/协作记录 |
| BH-06 | 06-04 正确看待输赢 | 输单有复盘记录 |
| BH-07 | 07-01 按照标准做事 | 行为与标准动作库一致（references/standard-actions.md） |
| BH-07 | 07-02 及时总结反省 | 拜访后有复盘记录（review 字段） |

## 判定输出

- 逐条"有/无"：有=✓（合标）、无=✗（缺口）
- 输出 `{pass: N/21, gaps: [缺的条目]}`——供经理周会看板使用（行为合格率 = pass/21）