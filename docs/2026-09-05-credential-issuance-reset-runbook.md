# 凭据发放与重置操作单（新电脑 / 新用户接入生产 CRM）

日期：2026-09-05
适用：管理员为「新电脑」与「新用户」发放/重置接入生产系统 `http://81.70.184.198` 的全部凭据。
执行环境：Windows 本机 PowerShell（远程操作经 `deploy-remote.py` 通道，无需手工 SSH）。

## §0 核心结论（先看这张表）

| 凭据 | 用途 | 发放方式 | 能否“查询” | 遗忘怎么办 |
|---|---|---|---|---|
| **网关 Basic**（`crm-mcp` + 密码） | MCP 连接器网关鉴权，**全局共享一份** | 管理员从现网电脑 `mcp.json` 复制给新电脑 | 本机 Base64 可解码；生产 htpasswd 只存哈希不可逆 | 管理员 `htpasswd` 重置 + 重新生成 Base64 |
| **CRM 业务账号**（`sales` 等） | 会话内 `crm_login` 业务鉴权，**每人一份** | 管理员建号/重置后**当面告知本人**；外部用户 landing 自注册 | ❌ 库内 bcrypt 单向哈希，任何人不可反查 | 管理员 `ON CONFLICT` 覆盖重置 |

两条铁律：
1. **系统内没有任何“查询密码”的接口**——库内是 bcrypt 哈希，设计上不可逆。
2. **明文密码只活两处**：管理员建号那一刻、使用者本人（或密码管理器）。不要在聊天/邮件里明文传递，用完即清。

## §1 凭据分层全景（接入链路）

```
新电脑 WorkBuddy
   │  ① 连接器配置（mcp.json）携带 网关 Basic  ← 管理员发放（全局一份）
   ▼
生产 Nginx 网关 /mcp  ← Basic Auth 校验（/etc/nginx/.mcp_htpasswd）
   ▼
crm-mcp 容器（StreamableHTTP :3001）
   │  ② 会话内 crm_login（业务账号）← 管理员开通（每人一份）
   ▼
crm_native 生产库（bcrypt 校验；admin 角色 403）
```

- 两层凭据**互相独立**：网关密码 ≠ CRM 账号密码，勿混用。
- 生产 MCP **不接受 `admin` 角色**（403：「admin 仅限 HTTP 后台」），业务账号取 `sales` 最小权限。

---

## §2 场景 A：新电脑接入（管理员发放网关钥匙 + 配置）

### 2.1 从现网电脑取网关 Basic 凭据

```powershell
# ① 查看现有配置（含 Authorization 头，即 Base64 凭据）
Get-Content "$env:USERPROFILE\.workbuddy\mcp.json"

# ② 解码验证（期望输出：crm-mcp:<密码>）
[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("<上面的Base64>"))
```

### 2.2 写入新电脑 `C:\Users\<新用户>\.workbuddy\mcp.json`

在 `mcpServers` 中**合并**以下条目（不要覆盖文件里其他 server）：

```json
{
  "mcpServers": {
    "crm-native-mcp": {
      "url": "http://81.70.184.198/mcp",
      "headers": {
        "Authorization": "Basic <Base64网关凭据>"
      },
      "disabled": false
    }
  }
}
```

要点：
- `Authorization` 放**请求头**，严禁内嵌 URL（`http://user:pass@` 会破坏 SSE 会话头）；
- `disabled: false` 确保启用态；写入后到 WorkBuddy「连接器」管理页对该 server 点 **Trust** 才真正激活。

### 2.3 给该电脑开 CRM 业务账号（见 §3），然后验证（见 §5）

---

## §3 场景 B：新用户开通业务账号

### 3.1 内部员工（管理员 SQL 建号，PowerShell 一键）

```powershell
$PY  = "C:\Users\wangchuan08\.workbuddy\binaries\python\envs\default\Scripts\python.exe"
$DIR = "D:\system\CRM-ai-native\scripts\tencent-lighthouse-deploy"
$PW  = "$env:TEMP\crm_ssh.pwd"

# 建号/重置（占位符替换：<新用户名> <初始密码> <显示名> <租户>；tenant_id 生产至少可为 system）
& $PY "$DIR\deploy-remote.py" exec --password-file $PW -- "docker exec crm-pg psql -U agent2b -d crm_native -c ""INSERT INTO crm.crm_users (username, password_hash, role, display_name, tenant_id, enabled) VALUES ('<新用户名>', crypt('<初始密码>', gen_salt('bf')), 'sales', '<显示名>', '<租户>', true) ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, enabled = true;"""
```

- `crypt()` + `gen_salt('bf')`：bcrypt 存储，**不可直接写明文或自造哈希**（`src/http/auth.js:48` 按 `crypt($1, hash)=hash` 校验）；
- `ON CONFLICT` 保证幂等，可重复执行；
- 角色取 `sales`（最小权限；生产 MCP 拒 `admin`）；
- 建好后**当面/安全渠道**告知本人 `<初始密码>`。

### 3.2 外部业务用户（自助注册，无需管理员）

- 打开 `http://81.70.184.198/landing.html` → `#start` → 按公司名自动开通租户 + 账号激活（密码用户自设）。
- 管理员如需控制租户，走平台管理插件 `user-rbac-admin`（仅 `sysadmin` 角色）。

---

## §4 场景 C：密码重置

### 4.1 CRM 业务账号重置（管理员）

```powershell
# 与 §3.1 完全同一条命令；把 <初始密码> 换成新密码即可覆盖（幂等）
& $PY "$DIR\deploy-remote.py" exec --password-file $PW -- "docker exec crm-pg psql -U agent2b -d crm_native -c ""INSERT INTO crm.crm_users (username, password_hash, role, display_name, tenant_id, enabled) VALUES ('<新用户名>', crypt('<新密码>', gen_salt('bf')), 'sales', '<显示名>', '<租户>', true) ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, enabled = true;"""
```

> 角色上下文已播种时（`role_context_profile` 6 角色），建号直接可用；若新库未播种先执行 `seedProfiles()`（见 README §11.1）。

### 4.2 网关 Basic 重置（管理员，密码遗忘/轮换时）

```powershell
# ① 服务器上重置 htpasswd（占位符换成新密码）
& $PY "$DIR\deploy-remote.py" exec --password-file $PW -- "sudo htpasswd -b /etc/nginx/.mcp_htpasswd crm-mcp '<新网关密码>'; sudo nginx -t; sudo systemctl reload nginx"

# ② 本机生成新 Base64（分发给所有现有电脑，逐台更新 mcp.json）
[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("crm-mcp:<新网关密码>"))
```

> ⚠️ 网关密码是**全局共享钥匙**：重置后**所有**已配置电脑的 `mcp.json` 都要同步更新，否则旧电脑连接失效。

---

## §5 验证清单（每次发放后必须执行）

```powershell
# 冒烟全流程：initialize → tools/list（含 crm_login）→ crm_login → 只读工具返回生产数据
bash scripts/tencent-lighthouse-deploy/mcp-verify.sh <BASIC_USER> <BASIC_PASS> <CRM_USER> <CRM_PASS> http://81.70.184.198/mcp
```

期望结果：

| 检查项 | 期望 |
|---|---|
| 工具总数 | ~42，且含 `crm_login` |
| `crm_login` | 返回 token（业务账号，非 403） |
| 只读工具（如 `data-particle-read`） | 返回生产库数据，**非** `gate=auth_required`（token 须在 `arguments.api_token` 携带） |
| 写操作 | 需 HITL 显式确认，绝不凭空写入 |

- 若 `initialize` 拿不到 `mcp-session-id`：session 在**响应头**，用 `curl -D -`。
- 若 `crm_login` 报 FK 错误：`role_context_profile` 未播种（README §11.1）。

---

## §6 安全纪律（管理员操作红线）

1. **不聊明文**：密码验证一律走 WorkBuddy 凭据对话框/HITL；对话中绝不向用户索要或贴出明文（专家包铁律 `agents/crm-native.md:68`）。
2. **不回传系统**：系统无明文密码表；SQL 只能写入 bcrypt 哈希。
3. **最小权限**：业务账号默认 `sales`；`admin` 仅 HTTP 后台（MCP 403）。
4. **零信任写入**：网关/账号发放只解决“能连能读”；所有业务写入（商机推进、报价、审批）都必须显式确认。
5. **密码管理器**：管理员自己的网关密码、各账号初始密码建议入密码管理器，勿散落文档/聊天记录。

---

## §7 常见问题

| 现象 | 原因 | 处置 |
|---|---|---|
| 连接器连不上/401 | 网关 Basic 填错或未 Trust | 核对 §2.2 条目 → 解码比对 → Trust |
| 工具返回 `gate=auth_required` | `crm_login` 的 token 未随 `api_token` 携带 | §5 期望表第三行 |
| `crm_login` 403 | 用了 `admin` 角色 | 改 `sales` 业务账号 |
| 密码忘了 | 系统不提供查询 | 走 §4.1 重置，不查哈希 |
| 换电脑后旧凭据失效 | 网关密码已轮换 | 全局同步 §4.2 新 Base64 |
