# crm-cli 端点与鉴权说明

## 三档端点

| 档位 | URL | 可达 | 说明 |
|---|---|---|---|
| prod（默认） | http://81.70.184.198/mcp | ✅ | 生产；nginx 反代 + Basic Auth（admin/union998）。**必须 http**：https 证书不匹配会丢失 Authorization 头 |
| local | http://localhost:3001/mcp | ✅ | 本机联调 StreamableHTTP 通道 |
| www | https://www.chiyuai.com/mcp | ❌ | 域名未 ICP 备案，SNI 级拦截；备案解除前不可用 |

切换：`crm-cli use <prod|local|www>`，档位持久化于 `~/.crm-cli/credentials` 的 `endpoint` 字段。

## 鉴权双层（关键）

MCP 通道同时有「网络层」与「应用层」两道鉴权，单个 `Authorization` 头装不下两者，**必须分装**：

1. **网络层 nginx Basic Auth**：走 `Authorization: Basic base64(user:pass)`。生产档 `user=admin` / `pass=union998`（公网 Basic Auth，非业务口令）。
2. **应用层业务鉴权**：`crm_login` 换取 `api_token`（TTL 8h），随后工具调用将 `api_token` 透传进 **工具 arguments**（非 JSON-RPC params）。服务端 `extractToken` 优先读 arguments 里的 `api_token`。

> 两者共存时：`Authorization` 头 = `Basic`，`api_token` = 参数。切勿把 token 塞进 Bearer（会被 Basic 覆盖）。

## 不可达诊断口径（红线）

`diagnoseUnreachable` 必须**原样转述原因，禁止静默重试或自动降级到其他档位**——降级会让用户误判通道已通。

- `www` 不可达：明确提示「疑似 SNI 级拦截 / 未 ICP 备案」，并说明该档位在备案解除前不可用，请改用 `prod` 或 `local`。**不得**出现「已切换 / 已降级」字样。
- `prod` / `local` 不可达：提示确认服务已启动、URL 与 Basic Auth 配置正确。

## 写类工具拦截

发请求前由 `guard.js` 的黑名单前置拒绝（`crm-deal-advance`、`data-particle-create`、`crm-approval-approve`、`payment-*`、`crm-login` 等）。拦截发生在任何网络往返之前，零请求。
