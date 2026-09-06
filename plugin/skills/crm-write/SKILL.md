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

## Action 读清单（辅助读：写前校验/写后验证）

| Action | 用途 |
|---|---|
| `data-particle-read` | 写前读目标粒子（幂等/现状校验）、写后验证 |
| `data-particle-attr-read` | 字段元模型读取（第 2.5 闸字段权限前置） |
| `crm-field-permission` | 字段级权限校验（写前 RBAC 范围判定） |
| `crm-account-360` | 客户全景（报价/合同写前背景） |

> 敏感读（crm-customer-360/crm-cross-entity-query/crm-finance-receivables/crm-contract-expiring）只作只读参考面，不参与写链路。

## Action 写清单（两阶段 + 第0闸，30 个业务写 Action）

| Action | 两阶段 | 审批 |
|---|---|---|
| `data-particle-create` / `data-particle-update` / `data-particle-edge-create` / `data-particle-attr-update` | 第0闸 | 视需 |
| `crm-deal-advance` | 只进不退+输单必填原因 | — |
| `crm-lead-pick` / `crm-lead-recycle` | 第0闸 | — |
| `crm-proposal-write` | 第0闸 | 视需 |
| `crm-quote-create` / `crm-quote-submit` / `crm-quote-activate` | 第0闸 | 报价审批 |
| `crm-contract-create` / `crm-contract-submit` | 第0闸 | 合同审批 |
| `crm-invoice-create` / `crm-invoice-submit` / `crm-invoice-reconcile` | 第0闸 | 发票审批 |
| `crm-order-create` / `crm-order-submit` / `crm-order-advance` | 第0闸 | 订单审批 |
| `crm-payment-plan-create` / `crm-payment-record-create` | 第0闸 | 视需 |
| `crm-import-batch` | 第0闸 | 高危需 force |
| `crm-deal-rollback` | 第0闸 | 高危需 force |
| `crm-approval-flow-define` / `crm-approval-start` | 第0闸 | 审批流 |
| `crm-approval-approve` / `crm-approval-withdraw` / `crm-approval-transfer` / `crm-approval-add-sign` | 第0闸 | 审批流操作 |
| `crm-asset-attach`（非结构化证据挂接，见下节两步编排） | 第0闸 | 视需 |

> 写清单 Action 名全部 ∈ `seedActions()` 注册集（防漂移）；无 delete/remove（绝对禁删）。

## 资产挂接两步编排（文件上传 → 业务挂接）

> 办公智能体把文件传进 CRM：**上传 ≠ 挂接**。
> 上传只是暂存（staging，不碰业务数据，免 confirm）；挂接才是业务写（过第0闸 + 两阶段）。
> 设计：`docs/2026-08-31-unstructured-asset-attach-design.md`

**第 1 步 · 上传（HTTP 直传，不经 MCP）**

```
POST http://<host>:3000/api/assets/upload
Content-Type: application/octet-stream
Authorization: Bearer <crm_login 返回的 token>   # 或平台 session token
X-File-Name: 合同扫描件.pdf                      # 必填（粒子 identity）
X-File-Mime: application/pdf                     # 可选，默认 application/octet-stream
X-Doc-Summary: 客户已盖章的年度框架合同            # 可选，一句话摘要
X-Asset-Source: upload                           # 可选，默认 upload（还可 email/scan）
```
请求体 = 文件原始字节。返回 `{ ok, asset_id, file_name, mime, size, sha256 }`。

- **幂等**：同内容重复上传返回**同一** asset_id（响应带 `deduped:true`）。禁删铁律下用幂等替代去重删除。
- **上限**：单文件默认 20 MB，可在后台「判定阈值」配置 `asset.max_mb` 调整。超限返回 413。
- **失败语义**：401 无凭证 / 400 缺 X-File-Name 或空体 / 413 超限。

**第 2 步 · 挂接（MCP 两阶段写）**

1. phase1：`crm-asset-attach`，参数
   `{ asset_id, target_type, target_id, evidence_ref?, decision_id }`
   → 返回 `{ confirm_token, form }`。**缺 decision_id 直接被第0闸拒绝**（`gate=decision_required`）。
2. phase2：携带 `confirm_token`（choice=1）执行 → 返回业务语言摘要，如
   「已将《合同扫描件.pdf》挂接到华东制造集团」。
3. `target_type` 白名单：`CRM_DEAL` / `CRM_ACCOUNT` / `CRM_QUOTATION` / `CRM_CONTRACT` / `CRM_INVOICE`
   （白名单外返回错误，不落边）。

**第 3 步 · 验证（读侧）**：`data-particle-read`（type=`CRM_UNSTRUCTURED_ASSET`）确认资产粒子存在；
客户/商机全景（`crm-account-360` 等）可见被挂接的证据。

**约束**：大文件一律走 HTTP 上传，MCP 只做引用挂接（不传 base64，避免消息体膨胀与 token 浪费）；
无 `decision_id` 不写；绝对禁删（平台不暴露任何 delete/remove 工具）。

## 安全红线
- AI 永远不在对话中接收或显示密钥明文（凭证补完走 .env / 环境变量 / 命令 三种安全通道）。
- 写操作经 action-confirm 显式角色确认；无凭证自动降级 sales 只读并显式提示。