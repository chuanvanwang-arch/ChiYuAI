---
name: crm-write
description: CRM 对话式写入技能——两阶段写入（取表单→确认→执行→验证）+ 决策第0闸（无 decision_id 不写）+ action-confirm（HITL）。写永远经 Action Registry 第0闸，绝不绕过直写 SQL。绝对禁删。
environment:
  required: []
  optional: []
security:
  requiresSecrets: false
  sensitiveEnvironment: false
  externalNetworkAccess: false
---

# crm-write · 对话式写入技能

> 定位：CRM 智能体包的「写」能力——把「记一条商机 / 推进阶段 / 新建报价 / 提交审批」等一句话，转成两阶段写协议（phase1 取表单 → phase2 确认执行），全程携带 decision_id（第0闸）。
> 设计输入：总体设计 §6.13（对话式写入）+ 决策事件主轴 §6（无决策不写）。

## 写操作分类

| 用户一句话 | Action（写） | 第0闸 | 审批 |
|---|---|---|---|
| 新增商机 N 万 | `data-particle-create`（type=CRM_DEAL） | decision_id 必填 | 视需 |
| 推进商机阶段 | `crm-deal-advance` | 只进不退+输单必填原因 | — |
| 新建报价 | `crm-quote-create` | decision_id 必填 | 报价审批 |
| 提交审批 | `crm-approval-start` | 需审批流定义 | 审批流 |

## 两阶段写协议（强制）

1. **phase1 取表单**：携带 `decision_id` → 返回 `{ confirm_token, form }`（action/actor/role/decision_id 摘要）。不执行写。
2. **phase2 确认执行**：携带 `confirm_token` → gateway 校验一次性 token → 经 `actionExecutor.dispatch` 执行 → 返回 `{ ok, data }`。

## 写闸（多重）

- **第0闸**：无 `decision_id` → 拒绝（无决策不写）。
- **1.5闸 RBAC**：Action 声明 rbac_roles 时校验角色（越权拒）。
- **2闸写白名单**：对话式通道（channel=conversational）未在白名单的写 → 拒（MCP 通道独立判定）。
- **3闸审批**：needsApproval 写 → 需审批流通过后 approvalPassed 放行。
- **绝对禁删**：remove/delete 请求 → 拒绝并指引。

## 输出纪律

- 写执行后必须回显确认摘要（商机名/金额/状态/decision_id），禁止空成功。
- 操作失败必须回显错误原因（业务语言）。

## 安全红线
- AI 永远不在对话中接收或显示密钥明文（凭证补完走 .env / 环境变量 / 命令 三种安全通道）。
- 写操作经 action-confirm 显式角色确认；无凭证自动降级 sales 只读并显式提示。