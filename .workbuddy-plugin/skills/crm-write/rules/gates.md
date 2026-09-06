# crm-write · 写闸规则（rules/gates.md）

## 闸序（写操作多重闸）

1. **第0闸（决策）**：`decision_id` 缺失 → 拒（reason=decision_required；无决策不写）。
2. **1.5闸（RBAC）**：Action 声明 `rbac_roles` 时，`ctx.role` 不在白名单 → 拒（reason=permission_denied）。
3. **2闸（写白名单）**：`channel='conversational'` 且非白名单写 → 拒（MCP 通道单独判定）。
4. **3闸（审批）**：`needsApproval` 写需 `approvalPassed` → 未过审拒（reason=approval_required）。

## 绝对禁删

- 平台无 delete/remove Action；任何删除意图 → 拒绝 + 解释（安全红线，零信任）。
- 「软删/回收站」也不支持（业务上使用状态机推进而非删除）。

## 两阶段纪律

- 写永不单阶段直跑：一律 phase1（取表单）→ phase2（确认执行）。
- confirm_token 一次性；过期（10min）重新 phase1。

## 输出验证

- 每次写成功必须回显业务摘要（如商机名/金额/阶段/decision_id）——禁止空 ok。
- 失败必须回显原因（业务语言，非内部 gate 名）。