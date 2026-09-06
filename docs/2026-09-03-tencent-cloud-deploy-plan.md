# CRM-ai-native 腾讯云部署清单

> 日期：2026-09-03
> 目标：把整个 CRM 系统（Node 22 + PostgreSQL 后端 + 同源前端 `src/web/*.html`）上线到腾讯云，对外提供 Web + API 服务。
> 结论先行：**代码零改动即可上云**，因为数据库/端口/前端都已云友好（见 §4 证据）。难点只在「开云资源 + 注入环境变量 + 守护进程/反代」。

---

## §1 需要你提供的云资源清单

| # | 资源 | 规格建议 | 用途 | 必需 |
|---|---|---|---|---|
| 1 | 腾讯云账号（已完成实名认证） | — | 所有资源归属 | ✅ |
| 2 | **云数据库 PostgreSQL（TencentDB for PostgreSQL）** | 2 核 4G 起，版本 16，与 CVM 同地域同 VPC | 替代本机不稳的 PG@5433，存 `crm` schema | ✅ |
| 3 | **云服务器 CVM**（或轻量应用服务器） | 2 核 4G 起，Ubuntu 22.04 / TencentOS | 跑 Node 服务（3000 端口） | ✅ |
| 4 | 公网 IP + 带宽 | 按量/包月，2~5 Mbps 起 | 对外访问 | ✅（公网） |
| 5 | 域名（已完成 ICP 备案） | 如 `crm.example.com` | HTTPS + 可访问地址 | ⚠️ 公网必需，内网可省 |
| 6 | SSL 证书 | 免费 DV（腾讯云可申请）或自有 | HTTPS | ⚠️ 公网推荐 |
| 7 | （可选）对象存储 COS | 标准存储 | 备份 pg_dump、静态资源 | 可选 |

### 需要你先决定的事项
- **地域**：选离你/客户最近的（如 上海/广州/北京），CVM 与云数据库**必须同地域同 VPC** 才能内网互联。
- **暴露范围**：公网访问（需备案域名）还是仅内网/VPC 访问？
- **数据库密码**：云数据库 PG 的高权限密码（建议独立、强随机）。
- **备份策略**：云数据库默认有自动备份，确认保留天数（建议 ≥7 天）。

---

## §2 架构与端口

```
[用户浏览器] --HTTPS(443)--> [Nginx 反代] --http(3000)--> [Node 服务 src/http/server.js]
                                                  │
                                                  └--> [云数据库 PostgreSQL :5432]  (crm schema)
[MCP 远程(可选)] --3001--> [src/mcp/server.js]  (仅在你要用远程 MCP 时开放)
```

- Web 页面与 API 同源（`/api/...` 相对路径），Nginx 统一反代到 Node 3000。
- 前端 `src/web/*.html` 由 `server.js` 逐页 `app.get` 渲染，**无独立静态站点**，随 Node 启动即托管。

---

## §3 部署步骤（可执行）

### 步骤 1 · 开云数据库 PostgreSQL
1. 腾讯云控制台 → 云数据库 PostgreSQL → 新建实例。
2. 选版本 **16**、规格 2C4G、与 CVM 同地域同 VPC。
3. 设置高权限账号（如 `agent2b`）和强密码。
4. 实例就绪后，记下：**内网地址、端口（默认 5432）、账号、密码**。
5. 在「数据库管理」中建库 `crm_native`（或沿用现有库名），schema `crm` 由迁移脚本创建。

### 步骤 2 · 开 CVM
1. 控制台 → 云服务器 CVM → 新建，Ubuntu 22.04，2C4G，绑定公网 IP。
2. 安全组：入站放通 **22（SSH）、80、443**；若开放 MCP 再加 **3001**。
3. 记下公网 IP 与登录密钥/密码。

### 步骤 3 · 本地准备
- 确认仓库可拉取：云上用 `git clone` 你的私有仓库（gitea/github），**或**本地打包上传。
- 准备服务器用的 `.env`（见步骤 6），**不要**把含密码的 `.env` 提交进 git。

### 步骤 4 · 上传代码（本地 PowerShell）
方案甲（推荐，需仓库可访问）：
```powershell
# 在 CVM 上执行
git clone <你的仓库地址> /home/ubuntu/crm-ai-native
cd /home/ubuntu/crm-ai-native
```
方案乙（本地打包上传）：
```powershell
# 本地 PowerShell：打包（排除 node_modules/.git）
Compress-Archive -Path D:\system\CRM-ai-native\* -DestinationPath D:\crm-deploy.zip -Force
# 上传
scp D:\crm-deploy.zip ubuntu@<公网IP>:/home/ubuntu/
# 在 CVM 上解压
# ssh ubuntu@<公网IP> "unzip -q /home/ubuntu/crm-deploy.zip -d /home/ubuntu/crm-ai-native"
```

### 步骤 5 · 服务器装 Node 22
```bash
# CVM 上（bash）
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v   # 期望 v22.x
```

### 步骤 6 · 注入环境变量
在 `/home/ubuntu/crm-ai-native/.env` 写入（dotenv 由 `src/db.js` 顶部加载，cwd 为项目根）：
```bash
PGHOST=<云数据库PG内网地址>
PGPORT=5432
PGUSER=agent2b
PGPASSWORD=<云数据库PG密码>
PGDATABASE=crm_native
NODE_ENV=production
PORT=3000
# 可选：EMBEDDING_PROVIDER=model 若已配置 llm_config
```
> ⚠️ `.env` 含密码，**务必加入 `.gitignore`**，切勿提交。

### 步骤 7 · 安装依赖 + 跑迁移
```bash
cd /home/ubuntu/crm-ai-native
npm install --production
npm run migrate      # node db/migrate.js，建表/增量迁移
# 如需种子数据（注意：本机 12 条印刷包装商机疑似 demo 数据，云上请谨慎 seed）
# npm run seed
```

### 步骤 8 · pm2 守护启动
```bash
sudo npm install -g pm2
pm2 start src/http/server.js --name crm-ai-native --env production
pm2 save
pm2 startup        # 开机自启
```

### 步骤 9 · Nginx 反代 + HTTPS
```nginx
# /etc/nginx/sites-available/crm
server {
    listen 80;
    server_name crm.example.com;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```
```bash
sudo ln -s /etc/nginx/sites-available/crm /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
# HTTPS：用 certbot 申请免费证书后监听 443 并 redirect 80
```

### 步骤 10 · 域名解析 + 备案
- 域名控制台 → 解析 → A 记录指向 CVM 公网 IP。
- 未完成 ICP 备案的域名无法在腾讯云提供公网 Web 服务，需先备案。

---

## §4 项目云友好证据（无需改代码）

| 点 | 证据 | 说明 |
|---|---|---|
| DB 连接走环境变量 | `src/db.js:13-16` 与 `:24-27`（`PGHOST/PGPORT/PGUSER/PGPASSWORD`） | 云上注入云数据库 PG 即可，**不改代码** |
| 端口可配置 | `src/http/server.js:123`（`process.env.PORT || 3000`） | 反代到 3000，零改动 |
| 前端同源 | `src/web/account-360.html:88` 等用 `/api/...` 相对路径 | Nginx 统一反代，**前端不改** |
| 启动脚本 | `package.json`：`start`=`node src/http/server.js`，`migrate`=`node db/migrate.js` | 标准可守护 |

### 需你确认/留意（非代码改动，是配置与数据）
1. **`crm.llm_config` 的 api_key**：SiliconFlow key 在云上需正确写入（迁移/手动），否则 embedding 走降级 hash。
2. **auth 账号**：`alice/secret123`、`admin/admin123` 会随 seed 进云库，上线前建议改密。
3. **MCP 端口 3001**（`src/mcp/config.js:14`）：默认不暴露；仅远程 MCP 场景才开安全组 + 反代。
4. **本机 12 条商机疑似 demo**：云上 seed 前请核实真伪（记忆已标注「零信任、核实后再用」）。
5. **`.env` 不提交**：含密码，加 `.gitignore`。

---

## §5 上线前检查清单

- [ ] 云数据库 PG 实例就绪，内网可达，账号/密码正确
- [ ] CVM 安全组放通 22/80/443（+3001 可选）
- [ ] `.env` 已写入且未提交 git
- [ ] `npm run migrate` 成功，表已建
- [ ] `pm2` 启动，`curl 127.0.0.1:3000/api/...` 自测通过
- [ ] Nginx 反代 + HTTPS 生效
- [ ] 域名解析 + 备案完成（公网）
- [ ] `crm.llm_config` api_key 正确；auth 账号已改密
- [ ] 数据 seed 已核实（非 demo 误入）

---

## §6 下一步（需要你提供）

我可以继续往下推，但需要你先给：
1. **云资源是否已开通**？还是先从零开（我给逐步控制台指引）？
2. **仓库地址**：云上 `git clone` 用哪个（gitea/github/其他）？还是本地打包上传？
3. **公网 or 内网**：决定要不要域名备案 + HTTPS。
4. **云数据库 PG 连接信息**：开通后把内网地址/账号/密码给我（或你自己填 `.env`）。

你给齐这四项，我就把部署做成可复用的脚本 + 一份「一键部署」清单，下次直接跑。
