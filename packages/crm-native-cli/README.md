# crm-native-cli

CRM-ai-native 本地 CLI 连接器：以「本地进程 + 本地鉴权 + 三档端点」**只读**直连 CRM MCP 通道（StreamableHTTP），绕开 `chiyuai.com` 未备案导致的 SNI 拦截，为 Buddy 应用连接器上架打通路径。

## 安装

```powershell
npm install -g crm-native-cli
```

要求 Node ≥ 22.20.0（使用内置 `fetch`，零运行时依赖）。

## 端点（默认 prod）

| 档位 | URL |
|---|---|
| prod（默认） | http://81.70.184.198/mcp |
| local | http://localhost:3001/mcp |
| www | https://www.chiyuai.com/mcp（备案解除前不可用） |

```powershell
crm-cli use prod        # 切换档位
```

## 鉴权（零信任：口令仅终端交互录入，不回显、不落聊天）

```powershell
crm-cli auth login      # 交互录入用户名/密码，本地换取并保存 api_token
crm-cli auth status     # 探活，返回 {"status":"valid"} 方可继续
```

凭据仅存于 `~/.crm-cli/credentials`（权限 0600），绝不入仓库/日志/聊天。

## 只读命令

```powershell
crm-cli call crm-funnel-classify '{"stage":"S1"}'   # 任意只读 MCP 工具透传
crm-cli deal list --stage S1                         # 语义化：商机列表（按阶段）
crm-cli account show "XX 制造"                       # 语义化：客户 360
```

## 只读红线（铁律）

本 CLI 第一版**仅支持只读**。任何写类工具（`crm-deal-advance`、`data-particle-create`、`crm-approval-approve`、`payment-*`、`crm-login` 等）会在发请求前被 `guard.js` 前置拒绝，并提示须走 HITL + `decision_id` + `CRM_APPROVAL_FLOW`。绕过系统的写入会形成治理缺口。

## 发布

```powershell
cd packages/crm-native-cli; npm pack --dry-run   # 校验包内容
npm publish                                      # 需发布凭证（由用户在本地执行）
```
