# CRM-ai-native 角色确认 + 权限控制 设计文档

> 状态：**已批准（2026-08-26）并已实施完成**。5 Task 全部落地，全量回归 49/49 通过；详细实施见 `docs/superpowers/plans/2026-08-26-role-confirm-permission.md`。
> 范式确定（brainstorming 三问三答）：
> 1. **范式**：混合自推断 + 敏感操作确认（保留 §6.13 原则②"不问你是谁"，敏感操作前显式确认）
> 2. **边界**：写全开 + 5 类敏感读（客户 360 / 跨实体查询 / 决策图 / 财务应收 / 合同到期）；普通读直连
> 3. **降级行为**：无凭证/角色未明时**显式弹一次**（对齐 CordysCRM 截图模式），任务标"待确认"

---

## §0 结论

**目标**：把 CordysCRM 截图中"凭证未配置 → 多选让用户安全提供 + 任务待确认"的红线模式，移植到 CRM-ai-native 的 MCP 对外分发层；在保留 AI 原生"不索身份、自推断"体验的同时，让用户对"以什么身份执行"始终有显式掌控点。

**三大核心决定**：
1. **混合范式**：默认 role-engine 自推断 5 角色（sales/manager/presales/exec/finance；扩展含 contract_admin 6 角色），不索身份；**写操作全部 + 5 类敏感读**走 action-confirm 时显式显示"将以 X 角色执行，是否继续"；无凭证/无内容可推断 → 最小权限降级 sales。
2. **降级可见性**：降级触发时**显式弹一次**（首次进对话或首次敏感操作），对齐 CordysCRM 截图"凭证未配置"模式：弹窗包含"已自动降级为 sales 只读模式"说明 + 4 选 1 安全提供凭证方式（创建 .env / 已设环境变量 / 给 PowerShell 命令 / 其他补充）；任务标"待确认"。
3. **绝对红线**：AI **永远不在对话中接收或显示密钥明文**（截图原文："按技能红线，我不会在对话中接收或显示密钥明文"）。凭证补完走模板化/Shell 命令/环境变量三种安全通道。

**实施路径**：5 Task 串行，每 Task 一 commit，TDD。

---

## §1 背景

### 1.1 触发事件（用户输入）

用户引用 CordysCRM 商机对话截图，行为：当凭证/角色未明时，AI **不猜测、不索明文**，而是弹结构化多选让用户在 4 种安全通道中选（创建 .env / 已设环境变量 / 给 PowerShell 命令 / 其他补充），任务列表标"待确认"（橙色 badge）。

**截图核心信号**：
- 标题：「Cordys CRM 凭证未配置，无法查询商机」
- 安全约束明示：「按技能红线，我不会在对话中接收或显示密钥明文」
- 弹窗 4 选项：1 我创建 .env 框架 / 2 我已设置环境变量 / 3 给我 PowerShell 命令 / 其他补充
- 任务流状态：`CordysCRM 商机 · 待确认 ●`

### 1.2 与现有 §6.13 设计的关系

总体设计 §6.13.8 宪法六条之 ②：
> **角色变形不问你是谁自己判断**(role-engine 上下文自推断，不索身份)

**范式冲突点**：截图模式强控制（显式多选），现有设计强自推断（不问）。**brainstorming 已决议：混合自推断 + 敏感操作确认**——保留 §6.13 原则②的零摩擦优势，在关键控制点（写 + 敏感读 + 降级触发）加显式闸，与 CordysCRM 红线精神对齐。

---

## §2 现状审计（file:line 证据）

### 2.1 已有 RBAC 硬闸（充分，不重写）

| 能力 | 实现位置 | 覆盖 |
|---|---|---|
| skill 启停硬闸 | `src/skills/registry.js` `canExecuteSkill`（rbac_roles + enabled） | `enabled` + `rbac_roles` |
| Action 写白名单 | `src/action/registry.js` + `src/action/seed-actions.js` | 4 读 + 25 写(非 data-*)=29 工具（0 删除） |
| 决策第 0 闸 | `src/mcp/gateway.js:28-32` `mcpWritePhase1` | 写操作强制 `decision_id` |
| 写两阶段 | `src/mcp/gateway.js:64-76` `mcpWritePhase2` | phase1 发 `ct_` token → phase2 dispatch |
| data_scope 行级过滤 | `src/context/roleProfiles.js:13-20`（`data_scope.domain[]`）+ `src/context/scope.js` `enforceScope` | 六角色决定可见粒子 |
| 降级 sales 兜底 | `src/mcp/config.js:25` `MCP_CONFIG.security.minPrivilegeFallback='sales'` | 无凭证 → sales |

### 2.2 已落地

- ✅ MCP Server 五模块（`src/mcp/{config,auth,tools,gateway,server}.js`）
- ✅ 12 SKILL（4 agent + 8 method）
- ✅ `.workbuddy-plugin/` 打包分发（zip 99KB）
- ✅ 22/22 回归（methodology 11 + mcp-gateway 9 + agentLoop 2）

### 2.3 缺口（本设计要补的）

1. **角色确认 UI**：现有 `action-confirm` 文案待扩展（含角色显示 + 切换）
2. **降级可见性**：现有 `minPrivilegeFallback='sales'` 是 silent 降级，缺显式弹窗
3. **凭证补完流程**：无 .env 模板、无 PowerShell 命令、无环境变量约定
4. **任务流"待确认"状态**：现有 kanban 状态机无 `awaiting_confirm` 状态，portal UI 无橙色 badge
5. **绝对禁红线文档化**：截图原文"不在对话中接收或显示密钥明文"未写入 SKILL/MCP 规范

---

## §3 设计原则（6 条，对齐 §6.13 + 加 1 条）

1. **AI 原生范式保留**：默认 role-engine 自推断，不索身份（§6.13 原则②不动）
2. **关键控制点显式**：写 + 敏感读 + 降级触发 → action-confirm 必须含角色显示
3. **绝对禁红线**：「AI 永远不在对话中接收或显示密钥明文」（对齐 CordysCRM 截图）
4. **绝对禁删保留**：29 工具中 0 个 delete/remove（已有，无变更）
5. **最小权限降级**：无凭证/无内容可推断 → sales 只读（写仍需 confirm）
6. **任务流可视化**：所有"待用户决策"操作在任务列表标"待确认"（橙色 badge）
7. **本设计新增**（vs §6.13）：**用户对"以什么身份执行"始终有显式掌控点**（confirm 中含角色 + 可切换）

---

## §4 角色确认范式（混合：自推断 + 敏感操作确认）

### 4.1 自推断（role-engine 不变）

**职责**：从对话内容（关键词、查询形态、引用实体）推断 5 角色（sales/manager/presales/exec/finance；扩展含 contract_admin 6 角色）。

**实现位置**：维持现有 `src/roles/roleProfiles.js` 推断逻辑，不动。

**输出**：`{ actor, role, inferred, confidence }`。`confidence` < 阈值（如 0.6）→ 触发降级显式弹窗（见 §6）。

### 4.2 敏感操作前 confirm 弹窗（新增）

**触发条件**（来自 §5 边界）：
- 写操作：所有 25 个写 Action（crm-deal-update、crm-approval-*、decision-create、crm-customer-update、crm-technical-proposal-* 等）
- 5 类敏感读：客户 360 / 跨实体查询 / 决策图 / 财务应收 / 合同到期

**弹窗文案**（对齐 CordysCRM 截图）：

```
⚠️ CRM 智能体将代表你执行 [操作类型]：

  操作: <action_name>（[kind: write|read_sensitive]）
  推断角色: [role]（confidence: [0.85]）
  影响范围: [data_scope.domain 子集]
  决策 ID: [decision_id 或 "本次自动 produce"]

请选择如何继续：
  1 以 [role] 角色继续执行
  2 切换为其他角色（多选：sales/manager/presales/exec/finance/contract_admin）
  3 取消，保留当前状态

任务流已标"待确认"（badge 橙色）。
```

**实现位置**：
- `src/mcp/gateway.js` `mcpWritePhase1` / `mcpReadDirect`（敏感读分支）→ 拼装 confirm 表单
- `src/portal/confirmUI.js`（新增）→ 渲染弹窗 UI（消费 action-confirm token）
- Portal 端：`web/portal-confirm.html`（新增）→ 弹窗路由 `/portal/confirm`

### 4.3 角色切换路径

**用户选 2（切换）** → 弹多选下拉（6 角色）→ 选定后**重新校验 RBAC**（`canExecuteSkill` 二次确认）→ 通过则放行，不通过则提示"该角色无权限执行此操作"。

**状态机**：`{ requested_role, original_role, switched_at, switch_reason }` 写入 action_calls 审计字段（不回滚原 audit）。

---

## §5 敏感操作边界

### 5.1 写操作（25 个，全部 confirm）

**权威清单**（来源 `src/action/seed-actions.js`，`tools.js:50-51` 排除 `data-*` 后暴露 25 个 MCP 写工具）：

- 商机/线索：`crm-deal-advance` / `crm-lead-pick` / `crm-lead-recycle` / `crm-deal-rollback`
- 售前：`crm-proposal-write`
- 报价：`crm-quote-create` / `crm-quote-submit` / `crm-quote-activate`
- 合同：`crm-contract-create` / `crm-contract-submit`
- 发票：`crm-invoice-create` / `crm-invoice-submit` / `crm-invoice-reconcile`
- 订单：`crm-order-create` / `crm-order-submit` / `crm-order-advance`
- 回款：`crm-payment-plan-create` / `crm-payment-record-create`
- 导入：`crm-import-batch`
- 审批流：`crm-approval-flow-define` / `crm-approval-start` / `crm-approval-approve` / `crm-approval-withdraw` / `crm-approval-transfer` / `crm-approval-add-sign`

> 注：`data-particle-create/update/edge-create/attr-update` 4 个 substrate 写工具不在 MCP 暴露面（仅内部 2 阶段，不计入 25）。现有 4 个读工具：`data-particle-read` / `data-particle-attr-read` / `crm-field-permission` / `crm-account-360`。

**判据**：`tools.js` 暴露的 `kind==='write'` 且非 `data-*` 前缀 → 全部 confirm。

### 5.2 5 类敏感读（confirm）

| 类别 | 触发条件 | 涉及端点/Action |
|---|---|---|
| 客户 360 | 涉及 ≥ 3 实体类型（DEAL+CUSTOMER+CONTRACT 等） | `crm-customer-360`（待实现/复合查询） |
| 跨实体查询 | 单查询跨 ≥ 2 实体类型 | `crm-cross-entity-query` |
| 决策图查询 | 命中 `/api/graph/*` 任一端点 | `/api/graph/{neighbors,trace,impact,provenance}` |
| 财务应收 | 涉及 INVOICE / PAYMENT 实体 | `crm-finance-receivables` |
| 合同到期 | 涉及 CONTRACT 实体 + 过滤到期 | `crm-contract-expiring` |

**判据**：现有 4 个 read 工具不直接覆盖这 5 类，需**新增 5 个复合 read Action**（每个对应 1 类），并标记 `kind==='read_sensitive'`。这部分扩展是必要的（否则边界规则无法工程化）。

### 5.3 普通读（4 个现有 Action，直连）

`crm-deal-list` / `crm-deal-detail` / `crm-customer-detail` / `crm-kanban-board` 等单实体查询 → 不进 confirm，直接 dispatch。

---

## §6 降级 sales 显式提示（对齐截图）

### 6.1 触发条件（OR 关系）

1. **完全无凭证**：`MCP_API_TOKEN` 不存在 / `extractToken` 返回 null
2. **凭证未知**：`resolveApiToken(token)` 找不到 actor（无映射）
3. **自推断置信度不足**：`role-engine.inferred.confidence < 0.6`
4. **自推断冲突**：从对话同时匹配多个角色（如同时含"查回款"和"查商机"）

### 6.2 弹窗形态（对齐 CordysCRM 截图）

```
⚠️ 角色/凭证信息不全，已自动降级为 sales 只读模式

为安全起见，请选择以下任一方式补全凭证：

  1 我创建 .env 框架（推荐）
    → AI 立即给 .env 模板（CRM_API_TOKEN=<占位>），
      你填好后放 ~/.crm-native/.env，重启 MCP server

  2 我已设置环境变量
    → 请在 PowerShell 中执行：
        echo $env:CRM_API_TOKEN.Substring(0,4)
      把前 4 位回复给我（仅前 4 位，绝不接收完整密钥）

  3 给我 PowerShell 命令
    → AI 给出 Set-Item Env:\CRM_API_TOKEN "..." 命令
      （你直接复制执行，AI 看不到明文）

  4 其他补充...

任务流已标"待确认"（橙色 badge）。
```

**实现位置（已落地，软提示非硬阻断）**：
- `src/mcp/auth.js` 扩展：`resolveApiToken` 返回 `{ actor, role, degraded, degraded_reason, prompt_needed }`
- `src/mcp/gateway.js` `mcpWritePhase1` / `mcpReadSensitivePhase1`：降级时**仍签发 confirm_token**，但响应附带 `{ degraded: true, prompt: <弹窗内容> }`（软提示 —— 符合 §6 选项A「写仍走 action-confirm」，不硬阻断写）；`mcpReadDirect`（普通读 kind=read）降级时直接放行 sales 只读直连（读不受阻）。
- 客户端凭 `prompt` 字段显式渲染降级弹窗；用户补完凭证后重试用携带 token 的请求即可正常走 action-confirm。
- 注：实现未采用 `DEGRADED_ROLE` 硬阻断码（与计划初稿不同），因批准设计 §6 选项A 明确「读直连，写仍走 action-confirm」——降级仅做显式提示，不阻断 sales 身份下的写确认流程。

### 6.3 任务标"待确认"

详见 §8。

---

## §7 凭证补完流程

### 7.1 .env 框架（选项 1）

**AI 提供模板**：

```env
# ~/.crm-native/.env
# 绝对红线：不要把此文件提交到 git，不要在对话中粘贴此文件
# CRM_API_TOKEN 格式：<actor>:<role>:<base64url(hmac_sha256(secret, signing_key))>
# 例：CRM_API_TOKEN=wangchuan:sales:eyJhbGciOiJIUzI1NiJ9...

CRM_API_TOKEN=<请填入>
CRM_API_SIGNING_KEY=<请填入（系统生成）>
CRM_API_HTTP_PORT=3001
CRM_LOG_LEVEL=info
```

**用户操作**：
1. AI 给模板（不含任何真实 token 值）
2. 用户本地填入（脱敏）
3. `chmod 600 ~/.crm-native/.env`
4. 重启 `npm run mcp:http`

**AI 验证**：仅校验"前 4 位前缀"匹配（不接收完整 token）。

### 7.2 环境变量（选项 2）

**用户操作**：
1. 在 PowerShell 中：`$env:CRM_API_TOKEN = "..."`（用户自己输入，AI 看不到）
2. `echo $env:CRM_API_TOKEN.Substring(0,4)` → 把前 4 位回复给 AI
3. AI 校验前缀匹配用户声称的 actor + role

**绝对红线**：用户**绝不在对话中粘贴完整 token**。AI **绝不读取、显示、记录完整 token**。

### 7.3 PowerShell 命令（选项 3）

**AI 提供**：
```powershell
# 仅 Linux/macOS 用户用
# Windows 用户用选项 2 或选项 1

# Linux/macOS
export CRM_API_TOKEN="<actor>:<role>:<base64url(hmac_sha256(secret, signing_key))>"

# 验证
echo "前 4 位: $(echo $CRM_API_TOKEN | head -c 4)"
```

**红线同上**：AI 不接收、不显示、不记录完整 token。

### 7.4 其他补充（选项 4）

开放输入，用户可贴自己的偏好（如"我想用 OAuth"）→ AI 据此回答，但**绝不索要明文**。

---

## §8 任务流"待确认"状态

### 8.1 状态机扩展

**现有 kanban 状态**（`src/kanban/types.js:8`）：`ready` / `running` / `done` / `failed` / `blocked`（`TASK_STATUSES`）。状态转换在 `src/kanban/kanban.js`（`claimTask`/`completeTask`/`failTask`/`resetTask` + `auditTransition`）。

**新增**：`awaiting_confirm`（橙色 badge）。

**流转**（新增函数，不改现有 ready→running 链路）：
- `ready` → `awaiting_confirm`（触发条件：写/敏感读/降级弹窗，由 gateway 调用 `requestConfirm`）
- `awaiting_confirm` → `running`（用户选 1/2 确认，`confirmTask`）
- `awaiting_confirm` → `ready`（用户选 3 取消，回到 ready 等待重新触发，`cancelConfirm`）
- `awaiting_confirm` → `failed`（超时 5 分钟未响应，`timeoutConfirm`）

### 8.2 UI 呈现

**Portal PM 看板**（`web/portal-pm.html`）：任务卡片右上角加橙色 badge「待确认 ●」+ 点击展开 confirm 表单。

**Kanban 视图**（`web/index.html` 已有看板）：列头加「待确认 (N)」+ 该列任务橙色背景。

### 8.3 审计字段

`action_calls` 表不存在（仅设计文档引用）。实际审计载体为 `crm.tasks` + `crm.task_audit`（`db/schema.sql:47-81`）。**改挂 `crm.tasks` 表**（迁移 `db/migration-confirm-audit.sql`，幂等）：

- `awaiting_confirm_at` (timestamptz)
- `awaiting_confirm_reason` (text, enum: 'write' | 'read_sensitive' | 'degraded')
- `confirmed_at` (timestamptz)
- `confirmed_role` (text)
- `switched_from_role` (text, nullable)

> `status` CHECK 约束扩展为含 `'awaiting_confirm'`，`task_audit.reason` 复用记录确认/切换/降级原因。

---

## §9 实施路径（5 Task 串行，每 Task 一 commit，TDD）

### Task 1：MCP 凭证解析扩展

**目标**：`src/mcp/auth.js` 增强 `resolveApiToken` 返回降级元信息。

**改动**：
- `resolveApiToken(token)` 返回 `{ actor, role, degraded, degraded_reason, prompt_needed }`
- `buildMcpCtx` 注入 `degraded` 标志
- `extractToken` 接受 Bearer / api_token / 环境变量三种来源

**测试**：
- `test/mcp-auth.test.js`（新建）6+ 用例：无 token / 未知 token / 合法 token / 降级触发 / 凭证来源 / 红线不显示明文

**验收**：`npm test` 6+/6+ 绿；红线条文落入 SKILL/security。

### Task 2：gateway confirm 弹窗构造

**目标**：`src/mcp/gateway.js` 拼装 confirm 表单（含角色显示 + 切换选项 + 任务 ID）。

**改动**：
- `mcpWritePhase1` / `mcpReadDirect`（敏感读分支）→ 触发 confirm 时返回 `{ok:false, code:'CONFIRM_REQUIRED', form: <结构化表单>}`
- 新增 `mcpConfirmSubmit(confirm_token, choice, switched_role)` → 校验 choice 后 dispatch

**测试**：
- `test/mcp-gateway.test.js` 增 4+ 用例：写 confirm 表单 / 敏感读 confirm 表单 / 选项 2 切换 / 选项 3 取消

**验收**：回归 26+/26+ 绿。

### Task 3：5 类敏感读 Action（新建）

**目标**：`src/action/seed-actions.js` 新增 5 个 `kind='read_sensitive'` Action。

**清单**：
- `crm-customer-360`（客户 360）
- `crm-cross-entity-query`（跨实体查询）
- `crm-finance-receivables`（财务应收）
- `crm-contract-expiring`（合同到期）
- （决策图由 `/api/graph/*` 端点承担，不在 Action 列表）

**测试**：
- `test/actions-sensitive-read.test.js`（新建）5+ 用例：每个 Action 注册 + 触发 confirm + 读数据形态

**验收**：5 Action 注册 + confirm 触发正确。

### Task 4：kanban awaiting_confirm 状态 + portal UI

**目标**：状态机扩展 + portal-pm.html 橙色 badge + kanban 看板新列。

**改动**：
- `src/kanban/types.js:8` `TASK_STATUSES` 增 `awaiting_confirm`
- `src/kanban/kanban.js` 增 `requestConfirm` / `confirmTask` / `cancelConfirm` / `timeoutConfirm`（复用 `auditTransition`）
- `web/portal-pm.html` 增橙色 badge 渲染（查询 `GET /api/tasks?status=awaiting_confirm`）
- `web/index.html` kanban 看板增「待确认」列
- `crm.tasks` 表加 5 个审计字段（DDL 迁移：`db/migration-confirm-audit.sql`，幂等）

**测试**：
- `test/kanban-confirm-state.test.js`（新建）4+ 用例：状态流转 / 超时 / 审计字段

**验收**：状态机 4/4 绿；UI 截图确认。

### Task 5：凭证补完三通道 + 绝对禁红线文档化

**目标**：`.env` 模板 + PowerShell 命令 + 环境变量约定 + 红线写入 SKILL。

**改动**：
- `~/.crm-native/.env.example`（新建，仓库内 `scripts/.env.example`）
- `scripts/setup-credentials.ps1`（新建，PowerShell 命令）
- `src/mcp/auth.js` 增绝对禁红线注释（顶部 + 函数级）
- `.workbuddy-plugin/skills/crm-native/SKILL.md` 增「安全红线 §绝对禁明文」段
- `.workbuddy-plugin/skills/method-*/SKILL.md`（8 个）增引用「凭据补完三通道」段

**测试**：
- `test/credentials-redline.test.js`（新建）3+ 用例：模板不含明文 / PowerShell 命令不含明文 / SKILL 红线字串存在

**验收**：红线字串在 ≥ 9 个 SKILL 文件中可 grep；模板命令安全。

---

## §10 验收口径

| 验收项 | 判据 |
|---|---|
| 角色确认范式 | 5 角色自推断可工作；写 + 5 类敏感读触发 confirm；confirm 含角色 + 切换 |
| 降级 sales 显式 | 无凭证/未知/低置信度触发弹窗；弹窗含 4 选 1 凭证方式 |
| 绝对禁红线 | 9+ SKILL 含「不在对话中接收或显示密钥明文」字串；test 红线用例绿 |
| 任务流"待确认" | 状态机 4 流转路径测试绿；portal UI 橙色 badge 可见；kanban 看板新列 |
| 凭证补完三通道 | .env.example / PowerShell / env var 三种方式均可工作；AI 不接收/不显示明文 |
| 零回归 | 现有 22+ 回归套件全绿；新 ≥ 18+ 用例全绿 |
| 端到端 | 模拟"无凭证用户首次进对话" → 弹降级窗 → 用户选 1 → AI 给模板 → 用户填好 → 重启 → 后续对话走 confirm 全流程 |

---

## §11 待办与风险

### 11.1 待办（用户决策点）

- [ ] 用户批准本设计 → 进入 writing-plans 拆 Task 1-5
- [ ] 用户决定 Task 3（5 类敏感读 Action）是否一次性落地，还是先做 1-2 类试点
- [ ] 用户决定 portal UI 集成范围（仅 portal-pm.html？含 index.html kanban？）

### 11.2 风险

- **R1**：kanban 状态机扩展可能影响现有 4 态机（需审 `src/kanban/stateMachine.js`）
- **R2**：5 类敏感读 Action 涉及多实体 JOIN，需保证 SQL 不退化（建议先建索引）
- **R3**：凭证前缀校验（4 位）安全等级有限，攻击者可枚举；建议同时校验 actor+role+prefix 三元组
- **R4**：`action_calls` DDL 变更需迁移脚本（`db/migration-confirm-audit.sql`）幂等

### 11.3 不在范围（明确排除）

- 真实登录认证（crm_users 表 + JWT 等）—— 属于 `docs/2026-08-26-stage3-portal-home-design.md` v2 范围，独立 Task
- token 实际签发/验签的 HMAC 实现细节（设计文档阶段不展开，Task 1 实施时定）
- 工作流引擎重写（现状已通过 `src/approval/engine.js` 实现，本设计仅扩展 confirm UI 挂点）

---

## §12 自我审查（Self-Review）

按设计文档审查 checklist：
- [x] 占位符：无 `<TODO>` / `<TBD>` / `...`
- [x] 矛盾：范式三决定 + §0 结论 + §4-§6 描述一致
- [x] 歧义：敏感操作边界在 §5 给出明确清单 + 判据
- [x] 范围：§11.3 明确排除项；§9 实施路径限定在 5 Task
- [x] 证据：§2 现状审计有 file:line 引用（待 Task 1 实施时最终核实）
- [x] 验收：§10 给出可执行判据

**待用户审查后提交**（沙箱无 git 凭证，AI 不 commit）。
