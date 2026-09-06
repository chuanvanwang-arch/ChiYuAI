# CRM-ai-native · 腾讯云 Lighthouse 一键部署套件

面向「自建 PostgreSQL + Node 同机」单机部署。目标机型：腾讯云轻量应用服务器（4C8G / 100G SSD / Ubuntu 24.04 + Docker）。

## 0. 架构

```
浏览器 ──80/443──> Nginx ──反代──> crm-app (Node 22, :3000) ──容器网络──> crm-pg (pgvector/pgvector:pg16)
                                        │
                                        └── 启动时先跑 `node db/migrate.js`（幂等建表）
```

- **数据库镜像用 `pgvector/pgvector:pg16`**，自带 `vector` + `pgcrypto` 扩展，避免在宿主机 apt 装包的坑。
- **PostgreSQL 只监听 `127.0.0.1:5432`**，公网不可达（安全红线）。排障用 SSH 隧道：`ssh -L 5432:127.0.0.1:5432 ubuntu@<IP>`。
- 应用启动前自动执行 `db/migrate.js`（幂等），无需手工建表。

## 1. 前置条件

| 项 | 要求 |
|---|---|
| 主机 | 腾讯云 Lighthouse / 任意 Ubuntu 22.04+ 主机，2C4G 起（推荐 4C8G） |
| 运行时 | Docker + docker compose 插件（Lighthouse 选「Docker」镜像已自带） |
| 网络 | 出网可用（拉镜像 + npm install）；控制台防火墙放通 80/443 |

## 1.5 自动化部署（推荐：Windows 本机驱动，无需手工 SSH）

`deploy-remote.py` 基于 paramiko 远程驱动主机，覆盖「探测 → 打包上传 → 生成配置 → 一键部署 → 状态核验」全流程。

```powershell
# 一次性准备：安装依赖（隔离环境，不污染系统 Python）
& "C:\Users\wangchuan08\.workbuddy\binaries\python\envs\default\Scripts\python.exe" -m pip install paramiko
# 把 SSH 密码写入文件，避免明文进入命令行历史
"你的密码" | Out-File -Encoding ascii "$env:TEMP\crm_ssh.pwd"

$PY  = "C:\Users\wangchuan08\.workbuddy\binaries\python\envs\default\Scripts\python.exe"
$DIR = "D:\system\CRM-ai-native\scripts\tencent-lighthouse-deploy"
$PW  = "$env:TEMP\crm_ssh.pwd"

& $PY "$DIR\pack-local.py" --src "D:\system\CRM-ai-native"     # ① 打包（务必用它，见 §6 坑位1）
& $PY "$DIR\deploy-remote.py" probe   --password-file $PW       # ② 环境探测
& $PY "$DIR\deploy-remote.py" upload  --password-file $PW       # ③ 上传并解压
& $PY "$DIR\deploy-remote.py" initenv --password-file $PW       # ④ 生成 .env（随机强密码 → 存本地 .env.server）
& $PY "$DIR\deploy-remote.py" deploy  --password-file $PW       # ⑤ 一键部署（耗时 5-15 分钟）
& $PY "$DIR\deploy-remote.py" status  --password-file $PW       # ⑥ 状态核验
```

其它子命令：`clean`（清空远程部署目录，重装场景）、`exec -- "<命令>"`（远程执行任意命令）。
参数：`--host` / `--user` / `--remote-root` / `--pkg`；
密码来源优先级：`--password-file` > `--password` > 环境变量 `CRM_SSH_PASSWORD`。

## 2. 手工部署步骤（等价的人工流程）

### 步骤 1：把代码放到服务器

**方式 A（本地打包上传，推荐）** —— 命令见 §5。

**方式 B（git clone）**

```bash
sudo mkdir -p /opt && sudo chown $USER /opt
git clone <你的仓库地址> /opt/crm-ai-native
cd /opt/crm-ai-native
```

### 步骤 2：装 docker compose 插件（若缺失）

```bash
docker compose version || { sudo apt-get update && sudo apt-get install -y docker-compose-plugin; }
sudo usermod -aG docker $USER && newgrp docker
```

### 步骤 3：一键部署

```bash
cd /opt/crm-ai-native/scripts/tencent-lighthouse-deploy
bash deploy.sh
```

首次运行会生成 `.env` 并退出。**把 `PGPASSWORD` 改成强密码后重跑一次**：

```bash
sed -i "s|^PGPASSWORD=.*|PGPASSWORD=$(openssl rand -base64 24 | tr -d '/+=')|" .env
bash deploy.sh
```

脚本自动完成：生成 `.dockerignore` → 预拉基础镜像（含国内代理兜底）→ 构建 → 启动 PG 与 Node → 执行迁移 → 自测 → 配置 Nginx。

### 步骤 4：访问

浏览器打开 `http://<公网IP>`。若不通，先检查腾讯云控制台「防火墙」是否放通 80 端口。

## 3. 种子数据（务必先看红线）

`db/migrate.js` 只建表，**不写业务数据**。需要初始数据时：

```bash
bash deploy.sh --seed
# 等价命令：
docker compose -f scripts/tencent-lighthouse-deploy/docker-compose.yml --env-file scripts/tencent-lighthouse-deploy/.env \
  exec -T app node db/migrate.js --seed
```

> **红线**：执行 seed 前必须确认种子内容。本地库存在疑似 demo 的商机数据（印刷包装行业 12 条），**不可把本地 dump 直接当生产数据灌入**。生产环境建议只灌租户 / 用户 / 配置类基础数据，业务数据由界面录入。

## 4. 常见问题

**Q1：镜像拉不下来（国内网络）**
`deploy.sh` 内置公共代理兜底（`docker.m.daocloud.io` / `dockerproxy.com` / `hub.rat.dev`）。仍失败时：
1. 腾讯云控制台「容器镜像服务 → 镜像加速器」拿专属地址；
2. `sudo tee /etc/docker/daemon.json <<<'{"registry-mirrors":["https://<你的地址>"]}'`
3. `sudo systemctl restart docker`，重跑 `bash deploy.sh`。

**Q2：离线环境（完全无外网）**
在能出网的机器 `docker save pgvector/pgvector:pg16 node:22-bookworm-slim -o images.tar`，上传后 `docker load -i images.tar`；npm 依赖改为本地 `npm install` 后连同 `node_modules` 打包上传，并在 Dockerfile 注释掉 `RUN npm install`。

**Q3：app 容器反复重启**
多为数据库未就绪或迁移失败：
```bash
docker compose -f scripts/tencent-lighthouse-deploy/docker-compose.yml logs -f app
docker compose -f scripts/tencent-lighthouse-deploy/docker-compose.yml exec -T db pg_isready -U agent2b
```

**Q4：页面 500，日志提示找不到 md 文件**
`src/http/routes.js:1161` 运行时读取 `docs/specs/*.md`。打包上传时**不要排除 `docs/`**（`.dockerignore` 已保留）。

**Q5：上传附件失败**
`src/assets/storage.js` 默认写 `uploads/assets`。镜像内已 `mkdir -p /app/uploads/assets`；需持久化时在 compose 的 app 服务加 `volumes: - ./uploads:/app/uploads`。

## 5. Windows（PowerShell）上传命令

```powershell
$src = "D:\system\CRM-ai-native"
$tmp = "$env:TEMP\crm-deploy-pkg"
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
Copy-Item "$src\src"     "$tmp\src"     -Recurse -Force
Copy-Item "$src\db"      "$tmp\db"      -Recurse -Force
Copy-Item "$src\docs"    "$tmp\docs"    -Recurse -Force
Copy-Item "$src\scripts" "$tmp\scripts" -Recurse -Force
Copy-Item "$src\package.json"      "$tmp\package.json"      -Force
Copy-Item "$src\package-lock.json" "$tmp\package-lock.json" -Force
New-Item -ItemType Directory -Path "$tmp\uploads\assets" -Force | Out-Null
Compress-Archive -Path "$tmp\*" -DestinationPath "$env:TEMP\crm-deploy.zip" -Force

# 密钥登录
scp -i "$env:USERPROFILE\.ssh\id_rsa" "$env:TEMP\crm-deploy.zip" ubuntu@<公网IP>:/tmp/crm-deploy.zip
```

服务器端：

```bash
sudo mkdir -p /opt && sudo chown $USER /opt
mkdir -p /opt/crm-ai-native && cd /opt/crm-ai-native
unzip -o /tmp/crm-deploy.zip
cd scripts/tencent-lighthouse-deploy
bash deploy.sh
```

## 6. HTTPS（有域名后）

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d 你的域名
```
证书自动续期；域名需已完成 ICP 备案。

## 7. 备份

```bash
mkdir -p /opt/backup
docker compose -f /opt/crm-ai-native/scripts/tencent-lighthouse-deploy/docker-compose.yml \
  --env-file /opt/crm-ai-native/scripts/tencent-lighthouse-deploy/.env \
  exec -T db pg_dump -U agent2b crm_native | gzip > /opt/backup/crm_$(date +%F).sql.gz
```
另建议在 Lighthouse 控制台开启**定时快照**（整机回滚），与 `pg_dump` 形成双重保险。

## 8. 升级

推荐走 §14 的 `release`（本机一条命令，含 AGE 防护）。等价的手工流程：

```bash
cd /opt/crm-ai-native
# ⚠ 生产已启用 AGE：必须叠加 docker-compose.age.yml，否则 db 会被重建回纯 pgvector（丢 AGE）。
#   deploy.sh 已自动处理，此处手工执行时需显式带上。
docker compose -f scripts/tencent-lighthouse-deploy/docker-compose.yml \
               -f scripts/tencent-lighthouse-deploy/docker-compose.age.yml \
               --env-file scripts/tencent-lighthouse-deploy/.env up -d --build app mcp   # 迁移随启动自动执行
```

> 代码通过 `COPY . .` 打进镜像，**必须 rebuild 才生效**；只替换 `/opt/crm-ai-native` 下的文件无效。

## 9. 部署实战坑位（2026-09-04 腾讯云 Lighthouse 实录）

以下均为首次从零部署时**真实触发**的故障，已在套件中修复或规避。

| # | 现象 | 根因 | 对策 |
|---|---|---|---|
| 1 | Docker Hub 返回 000，镜像拉不动 | 国内网络限制 | 配置 `registry-mirrors: ["https://mirror.ccs.tencentyun.com"]`（腾讯云官方，实测 200） |
| 2 | `docker info` 报权限不足 | 当前用户不在 docker 组 | `sudo usermod -aG docker $USER` 后**重连 SSH** 才生效 |
| 3 | 解压后源码找不到 | PowerShell `Compress-Archive` 用反斜杠做路径分隔符，Linux unzip 解出扁平文件名 | 用 `pack-local.py`（Python zipfile）打包；`unpack.py` 再做分隔符规范化 |
| 4 | 解压报 `PermissionError` 且目录显示 `d?????????` | zip 携带异常权限位 | `unpack.py --clean` 用 `sudo` 执行 + `normalize_perms()` 统一 755/644 |
| 5 | migrate 报 `relation "crm.decision" does not exist`，crm schema 表数=0 | **`schema.sql` 前向引用**：`crm.particles`（第 11 行）内联 `REFERENCES crm.decision(...)`，而该表在第 155 行才创建；整文件在单事务中执行 → 整体回滚 | 粒子表只建列，外键在 decision 建好后用 `DO $$` 幂等补建（`fk_crm_particles_decision`） |
| 6 | migrate 报 `column "entity_id" does not exist` | `crm.memory_log` 建表段无 `entity_id`（旧库靠 migrate.js 事后补），但下方复合索引 `idx_crm_memory_log_tenant(tenant_id, entity_id)` 先执行 | 在索引前补 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS entity_id TEXT` |

### 关于「从零建库」的通用结论

本地库因表已存在（`CREATE TABLE IF NOT EXISTS` 跳过）会**掩盖**所有前向引用与缺列问题；
只有全新库才会暴露。因此**任何 schema 变更后，务必用空库验证一次**：

```bash
# 在服务器上：清库 → 执行 schema → 断言零错误
docker compose -f scripts/tencent-lighthouse-deploy/docker-compose.yml --env-file scripts/tencent-lighthouse-deploy/.env \
  exec -T db psql -U agent2b -d crm_native -c 'DROP SCHEMA IF EXISTS crm CASCADE'
docker compose -f scripts/tencent-lighthouse-deploy/docker-compose.yml --env-file scripts/tencent-lighthouse-deploy/.env \
  exec -T db psql -U agent2b -d crm_native -f /tmp/schema.sql 2>&1 | grep -i ERROR
```

### 已知降级：Apache AGE 不可用

`pgvector/pgvector:pg16` 镜像不含 Apache AGE 扩展，启动日志会出现
`[AGE] decision network available=false`。该能力为**fail-open 降级**（`ensureGraph()` 失败仅记录日志，不阻断服务），
决策网络图相关功能不可用，其余功能正常。如需启用，需改用自行构建的 `postgres + AGE + pgvector` 镜像。

### 首次部署实录（供复现参考）

- 机型：腾讯云 Lighthouse **4 核 4G** / 40G SSD / Ubuntu 24.04.4 / Docker 29.6.1 / Compose v5.3.1
- 结果：38 张表、扩展 `vector 0.8.6` + `pgcrypto 1.3`、Nginx 1.24 反代、公网 `http://<IP>` 返回 200
- 内存提示：4G 机型下 PG 与 Node 同机偏紧，生产建议升到 8G

## 10. MCP 对外通道（StreamableHTTP）

MCP 服务是**独立进程**（`node src/mcp/server.js --http`，监听 3001，路径 `/mcp`，见 `src/mcp/config.js:14`），
与 HTTP 服务（3000）不共用容器。

**公网暴露策略（2026-09-04 拍板）**：不新开 3001 公网端口，由 Nginx 以 `/mcp` 路径反代，
对外统一入口 `http://<host>/mcp`。容器内 3001 仅绑定 `127.0.0.1`。

Nginx 侧要点（`nginx-crm.conf` 已内置）：

| 指令 | 原因 |
|---|---|
| `proxy_buffering off` | MCP 用 SSE 长连接，缓冲会让客户端收不到流式响应（表现为挂起） |
| `proxy_read_timeout 3600s` | 工具调用可能耗时较久，默认 60s 会断连 |
| `proxy_http_version 1.1` + `Connection ""` | 保持上游长连接 |

验证（服务器上执行，脚本 `mcp-probe.sh`）：

```bash
bash mcp-probe.sh http://127.0.0.1/mcp
# 期望：initialize 返回 200 且带 mcp-session-id；随后 tools/list 返回工具清单
```

从外部验证：

```bash
curl -s -X POST http://<公网IP>/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"1.0"}}}'
```

## 11. 初始化管理员用户

迁移只建表、不写业务数据，新库**没有任何用户**，需手工创建首个管理员。
密码以 pgcrypto `crypt(明文, gen_salt('bf'))` 存储，登录时按 `crypt($1, hash) = hash` 校验
（`src/http/auth.js:48`），**不可直接写入明文或自行 md5**。

```bash
cd /opt/crm-ai-native/scripts/tencent-lighthouse-deploy
# 将 <密码> 换成强密码；ON CONFLICT 保证可重复执行（重置密码）
docker compose -f docker-compose.yml --env-file .env exec -T db psql -U agent2b -d crm_native -c \
  "INSERT INTO crm.crm_users (username, password_hash, role, display_name, tenant_id, enabled)
   VALUES ('admin', crypt('<密码>', gen_salt('bf')), 'admin', '系统管理员', 'system', true)
   ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, enabled = true;"

# 校验
curl -s -X POST http://<公网IP>/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"<密码>"}'
# 期望返回 {"token":"...","role":"admin","display_name":"系统管理员"}
```

> 角色说明：平台管理插件（plugin-platform-admin）要求 `sysadmin` 角色，普通 `admin` 会被 403；
> 若需使用该插件，另行创建 `sysadmin` 角色用户。

### 11.1 角色上下文必须播种（否则 MCP 登录直接失败）

新库 `crm.role_context_profile` 为空，而 `crm.mcp_identity.role_tag` 有外键
`fk_mcp_identity_role` 指向它。未播种就调用 `crm_login` 会报：

```
insert or update on table "mcp_identity" violates foreign key constraint "fk_mcp_identity_role"
```

播种（`seedProfiles()` 幂等，`WHERE NOT EXISTS`，共 6 个角色）：

```bash
docker compose -f docker-compose.yml --env-file .env exec -T app \
  node --input-type=module -e "const m = await import('./src/context/roleProfiles.js'); console.log('ROLE_COUNT=' + await m.seedProfiles());"
# 期望 ROLE_COUNT=6（sales / manager / exec / finance / presales / contract_admin）
```

### 11.2 MCP 不接受 `admin` 角色

MCP 通道对角色有硬性限制，`admin` 登录会返回 403：

```
admin 仅限 HTTP 后台；请以业务账号(sales/manager/presales/exec/finance/contract_admin)登录 MCP
```

因此**必须另建业务角色账号**供 MCP 使用（最小权限取 `sales`）：

```bash
docker compose -f docker-compose.yml --env-file .env exec -T db psql -U agent2b -d crm_native -c \
  "INSERT INTO crm.crm_users (username, password_hash, role, display_name, tenant_id, enabled)
   VALUES ('sales', crypt('<密码>', gen_salt('bf')), 'sales', '销售代表', 'system', true)
   ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, enabled = true;"
```

### 11.3 通道验收脚本

```bash
bash mcp-verify.sh <Basic用户> <Basic密码> <CRM用户> <CRM密码> [URL]
```

依次验证：`initialize`（取 `Mcp-Session-Id`）→ `notifications/initialized` →
`tools/list`（工具总数 + 含 `crm_login`）→ `crm_login` 握手 → 只读工具返回生产库数据。

两个易踩点已内置处理：
1. `Mcp-Session-Id` 在**响应头**，须用 `curl -D -`，否则永远取不到 session；
2. `crm_login` 返回的 token 必须在后续调用的 `arguments.api_token` 中携带，否则工具返回 `gate=auth_required`。

---

## 12. Apache AGE 决策网络图（可选增强）

### 12.1 为什么默认不含 AGE

基础镜像 `pgvector/pgvector:pg16` 只带 `vector` + `pgcrypto`，**不含 AGE**。
AGE 缺失时系统**不会报错**——`src/decision/ageGraph.js` 有递归 CTE 降级路径，
启动时 `server.js:116 → ensureGraph()` 会 emit `age-unavailable` 并 fail-open，多跳查询仍可回答。

> 判定是否降级：应用日志出现 `[AGE] decision network available=false` 即为降级态。

### 12.2 ⚠ 构造方向不可颠倒（最关键的坑）

**必须以 glibc 更高的镜像为基础。** glibc 只向前兼容：低版本编译的 `.so` 能在高版系统加载，反之不行。

| 镜像 | Debian | glibc | PostgreSQL |
|---|---|---|---|
| `apache/age:release_PG16_1.6.0` | trixie (13) | **2.41** | 16.10 |
| `pgvector/pgvector:pg16` | bookworm (12) | 2.36 | 16.15 |

| 方向 | 做法 | 结果 |
|---|---|---|
| ❌ 错误 | `FROM pgvector:pg16` + COPY AGE 的 `.so` | 加载失败：`could not load library "age.so": version 'GLIBC_2.38' not found` |
| ✅ **正确** | **`FROM apache/age:release_PG16_1.6.0` + COPY pgvector 的 `.so`** | 成功（vector.so 编译于 2.36，可在 2.41 上加载） |

其余方案：换纯 `apache/age` 镜像 ❌（不含 pgvector）；源码编译 ❌（需 github 拉源码，本服务器 `github.com` 不可达，实测 000）。

> 附带好处：`apache/age` 镜像**自带 pgcrypto 1.3**，无需额外注入。

### 12.3 启用步骤

```bash
cd /opt/crm-ai-native/scripts/tencent-lighthouse-deploy

# 1) 拉 AGE 官方镜像（仅用于抽取，2.23GB；走已配置的腾讯云加速器）
docker pull apache/age:release_PG16_1.6.0

# 2) 构建合并镜像：AGE 1.6.0 为基础 + 注入 pgvector
docker build -f Dockerfile.pg-age -t crm-pg-age:pg16 .

# 3) 用 override 文件重建 db（数据卷 pgdata 保留，不丢业务数据）
docker compose -f docker-compose.yml -f docker-compose.age.yml --env-file .env up -d --force-recreate db

# 4) ⚠ 修复 collation（换基础镜像后必做，否则文本索引可能不一致）
docker exec crm-pg psql -U agent2b -d crm_native -c 'ALTER DATABASE crm_native REFRESH COLLATION VERSION'
docker exec crm-pg psql -U agent2b -d crm_native -c 'REINDEX DATABASE crm_native'

# 5) 重启 app 触发 ensureGraph()：CREATE EXTENSION + create_graph
docker compose -f docker-compose.yml -f docker-compose.age.yml --env-file .env restart app
```

### 12.4 验证

```bash
docker exec crm-pg psql -U agent2b -d crm_native -tAc \
  "select string_agg(extname||' '||extversion,', ' order by extname) from pg_extension"
# 期望：age 1.6.0, pgcrypto 1.3, plpgsql 1.0, vector 0.8.6

docker exec crm-pg psql -U agent2b -d crm_native -tAc "select name from ag_catalog.ag_graph"
# 期望：crm_decision_network

# 端到端：应用侧 cypher 往返（决定性验证，必须做）
docker exec crm-app node --input-type=module -e "
const age = await import('/app/src/decision/ageGraph.js');
console.log('AVAILABLE=' + age.isAvailable());
const r = await age.runCypher('MATCH (n) RETURN {c: count(n)} AS v');
console.log('CYPHER=' + JSON.stringify(r));
"
# 期望：AVAILABLE=true   CYPHER=[{"c":0}]（有数据则 c>0）
```

> ⚠️ **只验证扩展版本是不够的**。AGE 1.5.0 时 `ensureGraph()` 也会返回成功（`available=true`），
> 但 `runCypher` 会抛 `function ag_catalog.agtype_to_json(agtype) does not exist`。
> 必须跑到 cypher 往返才算真正可用。

### 12.5 版本与依赖依据（2026-09-04 实测）

- **AGE 必须 1.6.0**：代码 `ageGraph.js:6` 明确「AGE 1.6.0 实测约定」，依赖 `ag_catalog.agtype_to_json()`。
  1.5.0 缺该函数 → `ensureGraph()` 成功但所有 cypher 查询抛错，**比「无 AGE 走递归 CTE 降级」更糟**。
- PG：AGE 镜像 16.10 / pgvector 镜像 16.15，同为 major 16 → 扩展 ABI 兼容（实测 16.10 可正常读取 16.15 初始化的数据目录）。
- 代码侧用 `LOAD 'age'` 会话级加载，无需 `shared_preload_libraries`。

### 12.6 两个必踩的坑

**坑 1：图的 schema 残留 → `schema "crm_decision_network" already exists`**

`DROP SCHEMA ag_catalog CASCADE` 不会级联清掉图 schema，导致 `ag_graph` 无记录但 schema 仍在，
此后 `create_graph` 因重名失败、`cypher` 报 `graph does not exist`（半死状态）。

```bash
docker exec crm-pg psql -U agent2b -d crm_native -c 'DROP SCHEMA IF EXISTS crm_decision_network CASCADE'
# 然后重启 app，ensureGraph() 会重建图
```

**坑 2：collation 版本漂移 → 文本索引可能返回错误结果**

从 bookworm(glibc 2.36) 切到 trixie(2.41) 后，PG 会告警
`database was created using collation version 2.36, but the operating system provides version 2.41`。
这不是可忽略的警告——排序规则变化会让既有文本索引与查询不一致。

```bash
ALTER DATABASE crm_native REFRESH COLLATION VERSION;  -- 输出：changing version from 2.36 to 2.41
REINDEX DATABASE crm_native;                          -- 重建全部索引以对齐新排序规则
```

> 升级 PG 大版本（16 → 17）时，必须重新抽取对应版本的 AGE 二进制。

---

## 13. 语义向量（embedding）

### 13.1 两条通道与维度对照

| 目标列 | 维度 | 向量来源 | 受 `EMBEDDING_PROVIDER` 影响 |
|---|---|---|---|
| `crm.particles.embedding` | `vector(384)` | `hooks.js:17` 直接调 `hashVector` | ❌ 恒定 384，不受影响 |
| `crm.decision.embedding` | `vector(1024)` | `decisionRepo.js:154` 调 `embedText` | ✅ model 时取 1024 |

索引均已建：`particles` 用 **HNSW**，`decision` 用 **IVFFlat(lists=100)**，均为 `vector_cosine_ops`。

**维度匹配是安全的**：开启 model 后仅 `decision` 路径变 1024 维，与该列定义一致；
`particles` 走 `hashVector` 恒 384 维，不会因开关改变而写入失败。

### 13.2 新库默认是降级态

新库 `crm.llm_config` 为 **0 行**，且 `.env` 未设 `EMBEDDING_PROVIDER`，
此时 `embedText` 恒返回 `{provider:'hash', dim:384}` —— 是**哈希签名而非语义向量**，
近义文本相似度区分度接近零（实测：近义 0.0509 / 远义 0.0558，几乎无差别）。

### 13.3 启用步骤

```bash
# 1) 写入 LLM/Embedding 凭据（加密落库，明文用完即删）
#    明文先放入 /tmp/llm_key.txt，脚本会 encryptSecret 后写库并 unlink 明文
docker cp seed-llm-key.js crm-app:/app/seed-llm-key.js
docker cp /tmp/llm_key.txt  crm-app:/tmp/llm_key.txt
docker exec crm-app node /app/seed-llm-key.js
# 注意：脚本必须放在 /app 下执行，放 /tmp 会因找不到 node_modules 报 ERR_MODULE_NOT_FOUND

# 2) 打开语义向量开关
echo 'EMBEDDING_PROVIDER=model' >> .env

# 3) 重启生效
docker compose -f docker-compose.yml -f docker-compose.age.yml --env-file .env up -d --force-recreate app mcp
```

### 13.4 验证（关键：证明是语义而非哈希）

```bash
docker exec crm-app node --input-type=module -e "
const m = await import('/app/src/ontology/embedding.js');
console.log(JSON.stringify((await m.embedText('客户要求八折优惠')).provider));  // 期望 model
"
```

语义区分度实测（2026-09-04，生产库）：

| 指标 | hash（降级） | model（语义） |
|---|---|---|
| 近义句相似度（八折优惠 / 降价两成） | 0.0509 | **0.7574** |
| 远义句相似度（vs 明天北京天气） | 0.0558 | 0.2685 |

> 近义/远义区分度从「几乎为零」提升到 **2.8 倍**，是判断真语义向量的决定性证据。

### 13.5 凭据加密与密钥轮换

- `api_key` 在库中以 `v1:` 前缀密文存储（AES-256-GCM，`src/llm/secret.js`）
- 主密钥优先级：`CRM_LLM_SECRET` → `PORTAL_JWT_SECRET` → 开发默认 `crm-dev-secret`
- **生产必须设置 `CRM_LLM_SECRET`**：用默认密钥等于密钥公开，等同明文存储

**轮换密钥（不能先改 `.env` 再重启）**

若先改 `.env` 再重启，库里旧密文将无法用新密钥解密 → `hydrate()` 失败 → embedding 降级为 hash，
留下降级窗口。正确顺序由 `rotate-llm-secret.js` 保证：**在旧密钥仍生效时**完成密文轮换。

```bash
docker cp rotate-llm-secret.js crm-app:/app/rotate-llm-secret.js
docker exec crm-app node /app/rotate-llm-secret.js          # 解密→生成新密钥→自校验→重新加密落库

docker cp crm-app:/app/.new_secret /tmp/new_secret.txt      # 取回新密钥（脚本不打印到 stdout）
grep -q '^CRM_LLM_SECRET=' .env || printf 'CRM_LLM_SECRET=%s\n' "$(cat /tmp/new_secret.txt)" >> .env
chmod 600 .env

docker compose -f docker-compose.yml -f docker-compose.age.yml --env-file .env up -d --force-recreate app mcp
```

脚本内置三项保护：① 旧密钥解密失败即中止；② 新密文**自校验**（能还原为同一明文）后才落库；
③ 新密钥写 `/app/.new_secret`（600），不打印到日志。

> ⚠️ `CRM_LLM_SECRET` 必须在 **app 与 mcp 两个服务**上一致配置，否则 mcp 侧无法解密 `api_key`。
> ⚠️ **密钥须自行备份**：`.env` 丢失（且无快照）时，库内密文将永久无法解密，只能重新配置 API key。

- 出网依赖：`api.siliconflow.cn` 必须可达（实测返回 404 即表示域名可达、服务正常）

## 14. 日常发布：改动如何上生产（2026-09-04）

### 14.1 一句话结论

**不需要 GitHub。** 当前生产（Lighthouse `81.70.184.198`）是「本机打包 → SSH 上传 → 服务器重建镜像」的直推模式，
本机一条命令即可发布。Git 只承担版本管理职责（本地 commit），不承担发布通道职责。

### 14.2 三种通道怎么选

| 通道 | 命令 | 适用 | 耗时 | 是否权威 |
|---|---|---|---|---|
| **release（主通道）** | `deploy-remote.py release` | 改了 `src/` 源码、前端 HTML、SQL 迁移、npm 依赖、Dockerfile、compose | 3–10 分钟 | ✅ 是（镜像重建，重启后仍在） |
| **hotfix（应急）** | `deploy-remote.py hotfix --file <路径>` | 只改了 1–N 个运行期文件且**没动依赖**，需要立刻生效 | 秒级 | ❌ 否（容器重建即失效，事后必须补 release） |
| GitHub CI（可选） | 需先配 remote + Actions | 多人协作、需要发布审计与回滚标签时 | 取决于流水线 | ✅ |

> ⚠️ **代码是 `COPY . .` 打进镜像的，不是 bind mount。**
> 把文件单独 push 到 `/opt/crm-ai-native` **不会**影响运行中的容器——这是最常见的误解。

### 14.3 主通道：一条命令发布（Windows / PowerShell）

```powershell
$PY  = "C:\Users\wangchuan08\.workbuddy\binaries\python\envs\default\Scripts\python.exe"
$DIR = "D:\system\CRM-ai-native\scripts\tencent-lighthouse-deploy"
$PW  = "$env:TEMP\crm_ssh.pwd"        # 首次："SSH密码" | Out-File -Encoding ascii "$env:TEMP\crm_ssh.pwd"

& $PY "$DIR\deploy-remote.py" release --password-file $PW
```

等价于四步：本地 `pack-local.py` 打包 → 上传解压到 `/opt/crm-ai-native` → 服务器 `deploy.sh`（rebuild app/mcp + 幂等迁移）→ 状态自检。

发布后必看：

```powershell
& $PY "$DIR\deploy-remote.py" status --password-file $PW        # 容器状态 + 表数量 + 扩展清单
& $PY "$DIR\deploy-remote.py" exec --password-file $PW -- "docker compose -f /opt/crm-ai-native/scripts/tencent-lighthouse-deploy/docker-compose.yml --env-file /opt/crm-ai-native/scripts/tencent-lighthouse-deploy/.env logs --tail=60 app"
```

### 14.4 应急通道：热修（免 rebuild）

```powershell
& $PY "$DIR\deploy-remote.py" hotfix --password-file $PW `
     --file "src\http\routes.js" --file "src\web\pipeline.html"
```

内置守卫：路径必须在项目根内，且只放行 `src/`、`db/`、`scripts/`、`docs/` 四个目录与
`package.json` / `package-lock.json`（越界直接拒绝，不上传、不复制）。

热修语义：`docker cp` 写入 **app 与 mcp 两个容器**（同镜像、同代码）→ 重启两容器。
**容器重建即丢失**，所以热修后仍要：① 把改动 commit 进 git；② 尽快跑一次 `release` 让镜像与仓库对齐。

不适用热修的场景（必须走 release）：新增/升级 npm 依赖、改 `Dockerfile`、改 compose、改服务端 nginx 配置。

### 14.5 ⚠️ P0 陷阱：不要只用 `docker-compose.yml`（已内置防护）

生产 db 运行的是自建镜像 `crm-pg-age:pg16`（AGE 1.6.0 决策网络图）。
若手工执行 `docker compose -f docker-compose.yml up -d --build`，compose 会按主文件把 db 重建回
`pgvector/pgvector:pg16` → **AGE 扩展与决策图静默丢失**。

`deploy.sh`（2026-09-04 加固）已内置两道闸：

1. **自动叠加**：检测到本机存在 `crm-pg-age:pg16` 镜像或 `.age-enabled` 标记时，自动追加 `-f docker-compose.age.yml`；
2. **反向中止**：若当前 db 容器镜像是 `crm-pg-age:pg16` 而本次未叠加 override，直接 `exit 1` 并提示。
   确需降级时显式执行 `bash deploy.sh --no-age`（会丢 AGE，生产慎用）。

同理，日常发布只 rebuild `app`/`mcp`，`db` 走 `up -d db`（仅在镜像或配置变更时重建），避免误动数据库。

### 14.6 发布检查清单

发布前：

- [ ] 本地改动已按功能线 commit（每 Task 一 commit，禁 `git add -A`）
- [ ] 涉及 `db/schema.sql` 的改动，已用**空库**验证过一次（`DROP SCHEMA crm CASCADE` → 执行 → 断言零 ERROR）
- [ ] 确认本次改动**不含**本地 demo/调试数据

发布后：

- [ ] `status` 显示三容器 healthy，`/` 返回 200
- [ ] app 日志无 `ERROR` / 无 `age-unavailable` / 无 `embedding-provider-degraded`
- [ ] 关键功能点检（登录、商机列表、MCP `/mcp` 带凭据 200）

### 14.7 若将来改用 GitHub 仓库发布

当前 `git remote -v` 为空（未配置远端）。若希望走仓库发布，标准形态是：

1. 建私有仓库并 `git remote add origin <url>`（**生产环境务必私有**）
2. 服务器改为 `git clone` 一次，之后发布 = `git pull` + `docker compose ... up -d --build app mcp`
3. 可选 GitHub Actions：push 到 `main` → SSH 到服务器 → 执行上述两条（`ssh` 私钥存 Secrets）

这与当前直推模式可并存；直推模式在单人/小团队场景下更简单，且**不把代码托管到第三方**。
