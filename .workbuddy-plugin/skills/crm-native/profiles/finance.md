# crm-native · 财务视角（profiles/finance.md）

> 视角：财务（finance）用 CRM 智能体包管「应收/回款/逾期预警」。

## 高频对话

- 「本月应收多少？逾期多少？」→ crm-query 回款聚合（payment/应收粒子）
- 「哪些合同没按时回款？」→ crm-risk 回款逾期预警（合同→回款链断裂）
- 「这个客户的信用怎么样？」→ crm-query 客户信用标签（credit_rating）

## 角色边界

- 财务关注资金链：合同→回款、发票→核销、逾期→催收预警。
- 写入（如登记回款）走两阶段 + 决策闸；财务不推进商机阶段（sales/presales 的边界）。