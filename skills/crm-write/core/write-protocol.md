# crm-write · 两阶段写协议核心（core/write-protocol.md）

## 阶段1 — 取表单（phase1）

输入：`actionName + params(含 decision_id) + actor 凭证`

- 校验第0闸：`params.decision_id` 必填，缺失 → `{ ok:false, gate:'decision_required' }`（无决策不写）。
- 校验 Action 存在且为写（`def.kind === 'write'`）。
- 生成 `confirm_token`（一次性，10 分钟 TTL），存映射 `{ action, params, actor, role, expiresAt }`。
- 返回 `{ ok:true, confirm_token, form:{ action, actor, role, decision_id } }`——**不执行任何写**。

## 阶段2 — 确认执行（phase2）

输入：`confirm_token + params`

- 校验 token 有效且未过期（过期/未知 → `{ ok:false, gate:'confirm_expired' }`）。
- 一次性消费：使用后立即删除映射（重复使用被拒）。
- 经 `actionExecutor.dispatch(action, session.params, ctx)` 执行（ctx 含 decision_id、角色、channel=mcp）。
- 返回 `{ ok, data }`（dispatch 包装）。

## 验证（执行后）

- 写成功后回显摘要：`{ action, actor, decision_id, ok:true, data 关键字段 }`。
- 写失败回显错误：`{ action, error, gate }`（业务语言翻译）。

## 与第0闸联动

- decision_id 是「决策事件主轴 §6」的强制携带物：所有写操作必须源自一个决策（人工/自主引擎 mint）。
- 若智能体侧无法提供决策 → 拒绝写并提示「需先产生决策（HITL/审批流）」。