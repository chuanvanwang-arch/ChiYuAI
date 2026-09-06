# crm-write · 销售视角（profiles/sales.md）

> 视角：销售（sales）用 crm-write 做「一句话记商机/推阶段」的写闭环。

## 高频对话

- 「记一条：XX客户新增商机 300 万」→ phase1 取表单（确认 actor/decision_id）→ phase2 确认执行 → 回显摘要
- 「把这条商机推到报价阶段」→ crm-deal-advance（只进不退；若输单需必填原因）

## 写纪律

- 写必须带 decision_id（第0闸）——「无决策不写」是硬规则。
- 两阶段确认：phase1 返回 confirm_token 后，必须 phase2 确认才算真写。
- 绝对禁删：误删请求 → 拒绝并解释（安全红线）。