# crm-native · 派发规则（rules/dispatch.md）

## 惰性编排规则

- 只加载目标技能；不预载九引擎（agent/particle/ontology/memory/action/approval/kanban/decision/risk 按需）。
- 一次对话可串多技能：query → method-* → write，按意图链依次加载。

## 写通道规则（无论哪条路径）

- **第0闸**：写必须带 decision_id（无决策不写）——硬规则。
- **两阶段**：写工具调用先 phase1（返回 confirm_token），再 phase2（confirm_token）确认执行。
- **绝对禁删**：无 delete/remove 工具；请求删除类意图 → 拒绝并解释（安全红线）。
- **最小权限**：未知凭证降级 sales（只读直连；写需确认）。

## 输出规则

- 回复使用业务语言（商机/客户/报价/合同/回款），不暴露内部 Action 名、agent 名、SSE 类型。
- 写操作执行后必须回显确认摘要（订单号/状态/金额），禁止假象空成功。