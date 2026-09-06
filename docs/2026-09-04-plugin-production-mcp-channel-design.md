# 生产 MCP 通道打通与两插件重打包设计

> 日期：2026-09-04
> 生产环境：腾讯云 Lighthouse `81.70.184.198`
> 状态：**包同步与重打包（T5–T7）已完成**；MCP 通道（T1–T4）由并行任务处理，尚未完成。
> 决策已锁定：① Nginx 反代 `/mcp`；② 网关层加 Nginx Basic Auth；③ SKILL 内端点参数化。
>
> **2026-09-04 09:2x 实施记录**：T5/T6/T7 已落地，两包重打并通过 `scripts/verify-plugin-zips.py` 全项校验。实施中另发现并修复两处设计阶段未识别的缺陷（见 §9）。

---

## §0 结论先行

**两个插件包都需要重打包，但上传不是当前第一优先级。** 真正的阻塞是：生产 `81.70.184.198` 上 **MCP 通道完全不存在**（进程未启动、端口未映射、Nginx 未反代），插件即使上传成功，也只能操作使用者本机库，与生产数据割裂。

**实施顺序不可颠倒**：

| 序 | 动作 | 阻塞关系 |
|---|---|---|
| 1 | 打通生产 MCP 通道（compose + Nginx + Basic Auth） | 前置，不做则 2–6 全无意义 |
| 2 | 切换本机连接器到生产并实测握手 | 验收 1 |
| 3 | 两包内容同步（端点参数化 / 止损规则 / 版本号） | 依赖 1 定稿的端点形态 |
| 4 | 重打包两个 zip + 合规校验 | 依赖 3 |
| 5 | 上传安装并跑通端到端 | 依赖 4 |

**重打包的实际收益**（修正 9-04 首轮判断）：

| 包 | 真实漂移 | 是否必须重打 |
|---|---|---|
| `plugin-platform-admin` | 1 个文件过期：`skills/industry-onboarding/SKILL.md` 少 47 行（Step 4B / Step 4.5 / 2 条验收项） | ✅ 必须（缺了刚拍板的「按租户播种主数据」主干步骤） |
| `plugin`（crm-native） | 3 项：crm-risk 少 2 条止损规则、版本号不一致、端点硬编码 | ⚠️ 建议（内容增量小，但端点硬编码会误导生产使用） |

---

## §1 现状与证据

### 1.1 生产实测（`81.70.184.198`，2026-09-04 08:56）

| 探测项 | 结果 | 判读 |
|---|---|---|
| TCP 80 | OPEN | Nginx 已在工作 |
| TCP 443 | CLOSED | 未启用 HTTPS（本设计不改） |
| TCP 3001 | CLOSED | MCP 端口未映射 |
| `GET /` | 200 | 首页正常（CRM 作战室） |
| `GET /api/particles` | 200 | 应用连通数据库 |
| `GET /mcp` | 404 | 无 MCP 反代 |
| `GET /api/health` | 404 | **附带缺陷**：`src/http/server.js` 无此路由，而 `docker-compose.yml` healthcheck 依赖它 → 容器恒为 unhealthy |

### 1.2 断链的三处根因（缺一即不可达）

1. **进程未启动**：`scripts/tencent-lighthouse-deploy/docker-compose.yml` 中 `app.command` 为
   `sh -c "node db/migrate.js && node src/http/server.js"`，**未包含** `node src/mcp/server.js --http`。
   MCP HTTP 是独立进程，监听 3001（`src/mcp/server.js:144`、`src/mcp/config.js:14`）。
2. **端口未映射**：compose 仅 `ports: - "3000:3000"`，3001 未映射。
3. **无反代**：`scripts/tencent-lighthouse-deploy/nginx-crm.conf` 只有 `location /` → 3000，无 `/mcp`。

### 1.3 本机连接器现状

`~/.workbuddy/mcp.json`：

```json
"crm-native-mcp": {
  "url": "http://localhost:3001/mcp",
  "disabled": false
}
```

→ 插件当前读写**本机 PG 库**。若不做通道改造直接把 URL 改成公网 IP，结果必然是 `ECONNREFUSED`。

### 1.4 包漂移证据

**`plugin/crm-native-plugin.zip`**（9/2 13:54，127 文件，逐文件 SHA-256 比对）：

| 差异 | 性质 |
|---|---|
| `skills/crm-risk/core/scan.md` 少 1 行 | 真实滞后：`- 止损触发：DEAL.payload.stop_loss?.status === 'triggered' → 命中 stop_loss_triggered` |
| `skills/crm-risk/rules/detect.md` 少 1 行 | 真实滞后：`\| stop_loss_triggered \| DEAL.payload.stop_loss.status==='triggered' \| medium-high \|` |
| 根 `skills/` 比 `plugin/skills/` 多 4 个目录 | ❌ **非漂移**：method-followup-engine / intake-routing / quote-engine / review-gate 均无 `registry.json`，属引擎内部能力说明；`pack-crm-plugin.py` 按 registry 过滤是正确行为，**不应补入包** |
| `openclaw.plugin.json` 1.3.0 vs `package.json` 1.1.2 | 版本号不一致（清单源为 `.workbuddy-plugin/plugin.json` 1.3.0） |
| 端点硬编码 | `plugin/skills/crm-native/SKILL.md:22`、`plugin/agents/crm-native.md:23` → `http://localhost:3001/mcp` |

**`plugin-platform-admin.zip`**（9/3 20:06，13 文件）：

| 差异 | 内容 |
|---|---|
| `skills/industry-onboarding/SKILL.md` | ZIP 174 行 vs 磁盘 221 行。缺：Step 4B（按租户播种主数据，`scripts/seed-tenant-master-data.mjs`）、Step 4.5（租户 KNOWLEDGE 种子，`crm-knowledge-upsert`）、2 条验收项、示例第 5/6 步重编号 |
| 端点硬编码 | `agents/platform-admin.md:23`（`http://localhost:3001/mcp`）、`:25`（本机启动指引） |

---

## §2 目标与非目标

### 2.1 目标

1. 生产 `http://81.70.184.198/mcp` 可用，经 80 端口反代，**不新增公网端口**。
2. 公网侧多一道 Basic Auth，与既有 `crm_login`（`src/mcp/config.js:26` `requireAuth: true`，token TTL 8h，见 `:27`）构成双层鉴权。
3. 两个插件包内容与仓库权威源一致，端点表述不绑定具体主机。
4. 全过程**零数据破坏**：不执行 DELETE、不重建数据库、不停业务（可滚动重启）。

### 2.2 非目标（本次不做）

- HTTPS / 域名 / certbot（保持 80 明文 + Basic Auth；HTTPS 留待域名备案后单独立项）。
- MCP 服务无状态化改造（会话仍在进程内存 `transports` Map，见 §4 风险 R2）。
- 插件包内容的功能性新增（仅同步，不新增 SKILL）。
- `plugin/.workbuddy-plugin` 目录改名（打包脚本已在产出时归一为 `.codebuddy-plugin`，改动源目录风险大于收益）。

---

## §3 方案设计

### 3.1 生产 MCP 通道

#### 3.1.1 compose 新增 `mcp` service

在 `scripts/tencent-lighthouse-deploy/docker-compose.yml` 的 `services:` 下新增（**复用同一 Dockerfile**，不新增镜像）：

```yaml
  mcp:
    build:
      context: ../..
      dockerfile: scripts/tencent-lighthouse-deploy/Dockerfile
    container_name: crm-mcp
    restart: unless-stopped
    depends_on:
      db:
        condition: service_healthy
    environment:
      PGHOST: db
      PGPORT: "5432"
      PGUSER: ${PGUSER:-agent2b}
      PGPASSWORD: ${PGPASSWORD}
      PGDATABASE: ${PGDATABASE:-crm_native}
      NODE_ENV: production
      EMBEDDING_PROVIDER: ${EMBEDDING_PROVIDER:-}
    ports:
      - "127.0.0.1:3001:3001"        # 仅回环可达，公网经 Nginx 反代
    command: node src/mcp/server.js --http
```

要点：

- **不跑 migrate**：`app` 已负责 `node db/migrate.js`；MCP 工具注册表是静态的（无启动期读表依赖），表就绪竞态可接受。
- **仅绑回环**：与现有 PG 同一安全口径（`127.0.0.1:5432:5432` 注释明确写了这条红线）。
- **不开 3001 公网**：防火墙不新增规则，符合 §2.1 目标 1。

#### 3.1.2 Nginx `location /mcp`

在 `scripts/tencent-lighthouse-deploy/nginx-crm.conf` 的 `server {}` 内、现有 `location /` 之前插入：

```nginx
    location /mcp {
        auth_basic           "CRM MCP Gateway";
        auth_basic_user_file /etc/nginx/.htpasswd-crm;

        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # StreamableHTTP 的 GET /mcp 是 SSE 长连接通道（src/mcp/server.js:130）
        # 必须关闭缓冲，否则流式响应被缓存，会话推送失效
        proxy_buffering off;
        proxy_cache off;
        chunked_transfer_encoding on;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
```

**`proxy_buffering off` 是硬要求，不是优化项**：`src/mcp/server.js:130` 的 `app.get('/mcp')` 处理 SSE 通道，Nginx 默认缓冲会把它变成一次性响应。

#### 3.1.3 Basic Auth 凭据（远端执行）

```bash
sudo apt-get install -y apache2-utils
sudo htpasswd -bc /etc/nginx/.htpasswd-crm crmagent '<强密码>'   # 24+ 位随机，勿复用任何现有口令
sudo chown root:www-data /etc/nginx/.htpasswd-crm && sudo chmod 640 /etc/nginx/.htpasswd-crm
sudo nginx -t && sudo systemctl reload nginx
```

凭据须同步写入 `scripts/tencent-lighthouse-deploy/.env.server`（该文件已受 `.gitignore:8` 保护，不会进仓库）。

#### 3.1.4 顺带修复：`/api/health` 404

`docker-compose.yml` healthcheck 探测 `http://127.0.0.1:3000/api/health`，该路由在 `src/http/server.js` 中不存在，容器恒 unhealthy（不影响功能，但会误导运维判断）。

两个可选做法：

- **A**：healthcheck 改为探测已存在的路由 `http://127.0.0.1:3000/；
- **B**：在 `src/http/server.js` 增加 `app.get('/api/health', ...)` 返回 `{ ok: true }`。

**状态更新（2026-09-04 09:0x）**：该问题已按**方案 A** 处理——compose healthcheck 探测目标已改为根路径 `/`（见 `.workbuddy/memory/2026-09-04.md` 部署段）。本设计不再重复处理，T1 仅保留「新增 mcp service」一项。

### 3.2 本机连接器切换

编辑 `~/.workbuddy/mcp.json`。**采用 `headers` 而非 URL 内嵌账密**（URL 内嵌会出现在客户端日志/错误信息中）：

```json
"crm-native-mcp": {
  "url": "http://81.70.184.198/mcp",
  "headers": {
    "Authorization": "Basic <BASE64>"
  },
  "disabled": false
}
```

`<BASE64>` 生成（PowerShell，复制结果填入）：

```powershell
[Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("crmagent:你的密码"))
```

> 保留 `localhost:3001` 条目并改名/禁用（如 `crm-native-mcp-local` → `disabled: true`），便于本地调试随时切回。**禁 DELETE 铁律同样适用于配置：不删除旧条目。**

### 3.3 插件包内容同步

#### 3.3.1 端点参数化（共 4 处）

| 文件:行 | 现文案 | 改后文案（统一模板） |
|---|---|---|
| `plugin/skills/crm-native/SKILL.md:22` | `StreamableHTTP @ http://localhost:3001/mcp` | 见下方模板 |
| `plugin/agents/crm-native.md:23` | 同上 | 见下方模板 |
| `plugin-platform-admin/agents/platform-admin.md:23` | 同上 | 见下方模板 |
| `plugin-platform-admin/agents/platform-admin.md:25` | `本机未运行 MCP 服务时，先启动 node src/mcp/server.js --http（端口 3001）再重试` | 见下方模板 |

统一模板（三处正文一致）：

> 本助手所有能力经 `crm-native-mcp` 连接器暴露（StreamableHTTP）。**端点地址由连接器配置决定，包内不写死主机**：本地默认 `http://localhost:3001/mcp`（`npm run mcp:http`）；生产为 `http://<生产域名或IP>/mcp`（经 Nginx 反代 + Basic Auth，凭据配在连接器的 `Authorization` 头）。连接器未 enabled 或未连通 → 停止作答，不凭空生成。

未改动项：`plugin/skills/crm-write/SKILL.md:86` 为 `http://<host>:3000/api/assets/upload`，已是占位符写法，无需改。

#### 3.3.2 内容同步

| 包 | 文件 | 动作 |
|---|---|---|
| crm-native | `skills/crm-risk/core/scan.md`、`skills/crm-risk/rules/detect.md` | 从根 `skills/` 同步 `stop_loss_triggered` 两条（各 1 行） |
| crm-native | `.workbuddy-plugin/plugin.json`、`openclaw.plugin.json`、`package.json` | 版本统一升 **1.4.0** |
| platform-admin | `skills/industry-onboarding/SKILL.md` | 从磁盘同步（+47 行） |
| platform-admin | `.codebuddy-plugin/plugin.json`、`openclaw.plugin.json`、`package.json` | 版本统一升 **1.0.1** |

#### 3.3.3 遗留适配项（本次记入，不实施）

`plugin-platform-admin/skills/{industry-onboarding,system-bootstrap}/SKILL.md` 中的运维指引为本地形态：

```
psql -h 127.0.0.1 -p 5433 -U agent2b -d crm_native -f db/migrations/....sql
```

生产库的 PG 只监听容器内 `5432` 且不对宿主机回环暴露，**此命令在生产上不可直接执行**（需 `docker compose exec -T db psql ...`）。本次仅参数化 MCP 端点，不改运维命令形态；建议在包内增补「生产环境等价命令」小节，列为后续项。

### 3.4 重打包与上传

- crm-native：复用 `scripts/pack-crm-plugin.py`（权威源 = 仓库根 `skills/`，输出 `plugin/crm-native-plugin.zip`）。注意该脚本的源清单目录是 `.workbuddy-plugin`，产出时归一为 `.codebuddy-plugin`，与 platform-admin 一致。
- platform-admin：本次为该包**新建**打包脚本 `scripts/pack-platform-admin-plugin.py`（对齐 crm-native 的合规校验：`.codebuddy-plugin/plugin.json` 为唯一元数据位、`agents/skills/avatars` 在包根、tags 恰好 3 个、quickPrompts 恰好 3 个），避免继续手工打包。
- 打包后用同一套合规校验自检，再上传安装。

---

## §4 风险与对策

| # | 风险 | 影响 | 对策 |
|---|---|---|---|
| R1 | `/mcp` 暴露公网，被扫描撞库 | 高 | 双层鉴权：网关 Basic Auth + 应用 `crm_login`（`src/mcp/config.js:26` `requireAuth: true`，token TTL 8h，见 `:27`）。若后续发现有异常探测，追加 IP 白名单。 |
| R2 | MCP 会话存于进程内存（`src/mcp/server.js:105` `transports` Map），容器重启即丢 | 中 | 单实例部署，不做多副本；重启后客户端需重新 `initialize`。如后续要多副本，须先做会话外置（Redis）——本次不做。 |
| R3 | Nginx 缓冲未关导致 SSE 失效 | 中 | `proxy_buffering off` 为硬要求，验收清单 V4 专项验证 `GET /mcp` 不被缓冲。 |
| R4 | 生产 MCP 与 Web 共用同一数据库，写操作影响生产数据 | 高 | 不新增任何写工具；现有写路径仍受决策第 0 闸 + 两阶段确认约束（`src/mcp/config.js:22` `requireDecisionOnWrite`、`:23` `writeTwoPhase`、`:21` `absoluteNoDelete`）。**首次生产验收只允许只读工具**。 |
| R5 | Basic Auth 明文走 HTTP | 中 | 凭据用 `Authorization` 头传递；HTTPS 单独立项。如判定不可接受，可退化为 SSH 隧道方案（本机 `ssh -L 3001:127.0.0.1:3001`）——需重新评审。 |
| R6 | 打包脚本改动引入合规字段回归 | 低 | 打包后跑同一套字段校验（tags/quickPrompts/元数据目录名/资源位置）。 |

---

## §5 验收清单

| # | 验收项 | 期望 |
|---|---|---|
| V1 | `curl -i http://81.70.184.198/mcp` | 未带凭据 → **401** |
| V2 | `curl -u crmagent:<pwd> -X POST http://81.70.184.198/mcp -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"initialize",...}'` | 200 + 返回 `serverInfo`（`crm-native-mcp`）与 `Mcp-Session-Id` 响应头 |
| V3 | WorkBuddy 连接器切换后，插件侧 `tools/list` | 工具清单与本地一致（约 42 个，含 `crm_login`） |
| V4 | `curl -N -u ... http://81.70.184.198/mcp -H 'Mcp-Session-Id: <id>'` | SSE 通道**逐帧输出**（非一次性缓冲返回） |
| V5 | `crm_login` 握手（只读账号） | 成功返回 token |
| V6 | 任一只读工具（如 `data-particle-read` / `crm-account-360`） | 返回**生产库**数据，与本地库可区分 |
| V7 | 两个 zip 合规校验 | 元数据位 `.codebuddy-plugin/plugin.json`、tags=3、quickPrompts=3、资源在包根 |
| V8 | 安装后新开会话 | 插件按文档要求先探活 MCP，未连则明确停止而非凭空作答 |

---

## §6 回滚

| 场景 | 回滚动作 | 数据影响 |
|---|---|---|
| MCP 通道异常 | `docker compose stop mcp`；Nginx 移除 `location /mcp` 后 reload | 无（Web 不受影响） |
| 连接器切错 | `mcp.json` 中把 `crm-native-mcp` 改回 `http://localhost:3001/mcp`（旧条目保留、仅切 disabled 状态） | 无 |
| 新包异常 | 重新安装上一版 zip（`plugin/crm-native-plugin.zip` 9-02 版、`plugin-platform-admin.zip` 9-03 版，均在本地保留） | 无 |
| 最坏情况 | 完全回退到现状：两包不上传，插件继续连本机库 | 无 |

全过程不涉及 DELETE、不重建库、不迁移既有数据。

---

## §7 实施任务拆分（供 writing-plans 使用）

| Task | 内容 | 涉及文件 | 依赖 |
|---|---|---|---|
| T1 | compose 新增 `mcp` service（healthcheck 修正已完成，不再列入） | `scripts/tencent-lighthouse-deploy/docker-compose.yml` | — |
| T2 | Nginx `location /mcp` + Basic Auth 凭据生成 | `nginx-crm.conf`、远端 `/etc/nginx/.htpasswd-crm` | T1 |
| T3 | 部署到生产并做 V1/V2/V4 通道验收 | 远端 | T2 |
| T4 | 本机连接器切生产（headers 方式）+ V3/V5/V6 验收 | `~/.workbuddy/mcp.json` | T3 |
| T5 | crm-native 包同步（端点参数化 2 处 + crm-risk 2 行 + 版本 1.4.0） | `plugin/**` | — |
| T6 | platform-admin 包同步（industry-onboarding + 端点 2 处 + 版本 1.0.1） | `plugin-platform-admin/**` | — |
| T7 | 新建 `scripts/pack-platform-admin-plugin.py` 并重打两个包 + V7 校验 | `scripts/`、`*.zip` | T5、T6 |
| T8 | 上传安装 + V8 端到端验证 | 本地 WorkBuddy | T4、T7 |

T5/T6 与 T1–T4 可并行（无依赖），但**上传（T8）必须等 T4 通过**。

---

## §8 待你确认的两个开放项

1. **Basic Auth 用户名**：设计稿用 `crmagent`，是否沿用？
2. **是否现在就上生产 MCP**：若你近期只是要「包版本整洁」，可只做 T5–T7（重打包不上传），通道改造留到真正需要远程接入时。

（原第 3 项「`/api/health` 修复」已按方案 A 落地，见 §3.1.4。）
