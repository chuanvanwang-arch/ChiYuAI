# crm-risk · 链断裂模式参考（references/patterns.md）

## 模式库（持续补充）

| 模式 | 判定 | 业务影响 | 处置 |
|---|---|---|---|
| no_proposal_over_30d | 商机进入 opportunity 后 30 天无技术方案 | 方案缺位 → 赢单率下降 | 生成方案（crm-write） |
| win_without_proposal | win 但无技术方案粒子 | 赢单缺方案证据 → 交付风险 | 补方案/记录原因 |
| payment_overdue | 应收日期过期无回款 | 资金链断裂 → 现金流风险 | 催收（finance）/ 缓发 |
| stage_rollback | 商机阶段倒退（违反只进不退） | 规则违规 → 流程失控 | 告警 + 需审批回退 |

## 与决策事件主轴（§6）衔接

- 每个预警的处置建议都会产生决策事件（decision_id），进入决策网络先例——「历史上 3 条缺方案商机后来怎样」可检索。
- 预警只读+emit，不写业务数据（写归 crm-write 两阶段）。