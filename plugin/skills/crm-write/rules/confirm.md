# crm-write · 确认语义（rules/confirm.md）

## confirm_token 生命周期

- phase1 签发 → 一次性有效（10 分钟 TTL）→ phase2 消费即销毁。
- 未在 TTL 内使用 → 过期拒绝（`confirm_expired`），需重新 phase1。
- 同一 token 二次使用 → 拒绝（一次性）。

## 确认内容（phase2 前回显）

- `{ action, actor, role, decision_id, params 摘要 }`——让调用方/用户看到「写什么、谁写、哪个决策」。

## HITL

- 写操作天然是 HITL 点：phase2 是「人/智能体确认执行」的闸。
- 若 Action `needsApproval:true` → phase2 仍需 approvalPassed（审批流通过）才真正执行（3闸联动）。