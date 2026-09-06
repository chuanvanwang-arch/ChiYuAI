# 专家「AI 原生销售管理助手」新电脑配置指南

日期：2026-09-05
适用：全新 Windows 电脑（WorkBuddy 客户端）接入生产系统 `http://81.70.184.198`

## 结论（先看这里）

1. **必须** 同时引入「专家包」和配置 MCP 连接器——两者缺一不可：
   - 专家包提供**方法论与行为铁律**（DSM 销售方法论、K-M-D 决策架构、报价走 CRM_APPROVAL_FLOW、off-system 报价红线）；
   - MCP 连接器提供**数据与执行通道**（全部真实 CRM 数据经 `crm-native-mcp` 暴露）。
   - 专家包内 `agents/crm-native.md` 第 19-25 行写死铁律：**激活后第一件事必须连上 crm-native-mcp，未连接则停止，绝不凭空作答。**
2. MCP 连生产是 **StreamableHTTP + 双重鉴权**：
   - ① Nginx 网关 **Basic Auth**（在 `Authorization` 头，不内嵌 URL）；
   - ② 会话内 **crm_login 握手**（`sales` 最小权限业务账号），返回的 token 必须在后续调用的 `arguments.api_token` 中携带。
3. **默认只读、不写入**：连接器仅提供查询能力；任何业务写入（商机推进/审批）都必须在**对话框/凭据界面**由用户显式确认（HITL），聊天中概不采集口令。

## 专家包引入（从仓库副本拷贝）

- 位置：`D:\system\CRM-ai-native\plugin\`（本体，含 `agents/`、`skills/`、`openclaw.plugin.json`）
- 平台管理插件（可选）：`D:\system\CRM-ai-native\plugin-platform-admin\`（RBAC / 行业上线 / 系统引导，**仅 sys-admin 角色**可用）
- 引入后：添加「专家」时应能识别 `openclaw.plugin.json` 中的 skills 清单（crm-native、crm-query、crm-risk、method-* 等 16 个）
- 注意：本项目 git 由用户本地提交；沙箱无凭证，AI 不执行 commit。

## MCP 连接器配置（WorkBuddy → 生产）

在 `C:\Users\wangchuan08\.workbuddy\mcp.json` 的 `mcpServers` 中添加（或确认已有）以下条目：

```json
{
  "mcpServers": {
    "crm-native-mcp": {
      "url": "http://81.70.184.198/mcp",
      "headers": {
        "Authorization": "Basic <网关Basic认证凭据>"
      }
    }
  }
}
```

要点：

| 项 | 取值 | 说明 |
|---|---|---|
| `url` | `http://81.70.184.198/mcp` | 生产公开入口，Nginx 反代到容器内 3001（StreamableHTTP / SSE） |
| `headers.Authorization` | `Basic <base64>` | 网关 Basic Auth。**不要内嵌进 URL**（`http://user:pass@` 会破坏 SSE 会话头）。 |
| `disabled` | `false`（默认） | WorkBuddy 连接器管理页启用 |

- Basic 凭据 = `base64(用户名:密码)`，用户名示例 `crm-mcp`；由生产 Nginx `htpasswd` 文件（`/etc/nginx/.mcp_htpasswd`）统一管理，本机不落明文。
- 新机器配置后，到 WorkBuddy 右侧「连接器」管理页对该 server 点 **Trust/启用**，MCP 才会激活（本配置不自动生效）。

## 双重鉴权流程（连接器工作方式，无需在聊天中输口令）

```
① 连接器携带 Basic Auth 头 → Nginx 网关校验通过
② 会话内调用 crm_login（业务账号 sales / 最小权限）→ 返回 token
③ 后续只读工具（data-particle-read 等）在 arguments.api_token 携带该 token
```

- 生产 MCP 不接受 `admin` 角色（403：「admin 仅限 HTTP 后台；请以业务账号登录 MCP」）；业务账号建议 **sales**（最小权限）。
- ⚠ 不在对话中向用户索要明文口令；需要验证时走对话框/凭据输入界面。

## 验证（新机器上执行，PowerShell 兼容）

```powershell
# 冒烟：mcp-verify.sh 存在於仓库 scripts/tencent-lighthouse-deploy/
bash scripts/tencent-lighthouse-deploy/mcp-verify.sh <BASIC_USER> <BASIC_PASS> sales <CRM密码> http://81.70.184.198/mcp
# 期望输出：工具总数~42 且含 crm_login；只读工具返回生产库数据（非 gate=auth_required）
```

或在任意终端：

```bash
curl -s -X POST http://81.70.184.198/mcp \
  -H "Authorization: Basic <网关Basic凭据>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"1.0"}}}'
# 期望：200 + mcp-session-id（响应头中）
```

验收检查单：

- [ ] 专家包已引入（助手面孔 + 16 skills）
- [ ] `crm-native-mcp` 连接器 enabled（Trust）
- [ ] `initialize` 握手 200，`tools/list` 含 `crm_login`
- [ ] `crm_login` 用业务账号成功 → 只读工具返回生产库数据
- [ ] 写入动作（商机推进/报价审批）需显式确认，绝不凭空写入

## 生产端已知约束（若遇到问题先对照）

- 生产 db 跑 `crm-pg-age:pg16`（AGE 1.6.0 决策网络图）；MCP 容器 `crm-mcp` 监听 127.0.0.1:3001，仅经 nginx `/mcp` 暴露。
- 代码是 `COPY . .` 打镜像，生产发布必须走 `deploy-remote.py release`（详见 `scripts/tencent-lighthouse-deploy/README.md` §14）；hotfix 只在容器重建前生效，事后必须补 release。
- 改动涉及 `db/schema.sql` 时，必须先空库验证（生产零信任，不灌 demo 数据）。
