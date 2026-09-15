# MCP OAuth 端到端验证报告（2026-09-15）

> 对象：生产 MCP 全员连不上的修复（`docs/2026-09-15-mcp-oauth-design.md`，方案 A：OAuth 授权服务器与资源服务器同驻 `crm-mcp` :3001）
> 计划：`docs/superpowers/plans/2026-09-15-mcp-oauth.md`（14 Task）
> 脚本：`scripts/mcp-oauth-e2e.mjs`（20 用例）
> 本报告只记录**实测结果**；未经实测的一律标注为"待验证"，不做推断性结论。

---

## §0 结论

| 项 | 结论 |
|---|---|
| 本地端到端链路 | ✅ 通（20/20 用例 PASS，含真实工具调用 `ok=true`） |
| OAuth 单测 | ✅ 121/121（11 个 `test/mcp-oauth-*.test.js`） |
| MCP 域回归 | ✅ 255/255（25 个 mcp 相关测试文件） |
| 全量回归 | ⚠️ 4238 passed / 47 failed，**失败项 0 个落在本次改动面**（归因见 §5） |
| 契约校验 | ✅ `{"valid": true, "errors": []}` |
| 生产端到端 | ⛔ **未验证**——需先 release（见 §7） |
| 真实 WorkBuddy 客户端 | ⛔ **未验证**——需人工操作（见 §7） |

**一句话**：服务端 OAuth 链路已在本机对真实 HTTP 打通并逐条验证；但**修好了一个会让整件事白做的缺陷**（§2 F1），且生产发布与客户端验收尚未进行。

---

## §1 验证方式与边界

| 环境 | 地址 | 状态 |
|---|---|---|
| 本地（真实 HTTP，非替身） | `http://127.0.0.1:3110`（`MCP_PORT=3110`，库 `crm_native_test`） | ✅ 已跑 |
| 生产 | `http://81.70.184.198` | ⛔ 未跑（OAuth 代码与 DDL 尚未发布） |

`scripts/mcp-oauth-e2e.mjs` 的两条纪律：

1. **PKCE 独立实现**：脚本内自行计算 `code_verifier` / `code_challenge`，不复用 `src/mcp/oauthCrypto.js`——避免"测试复用被测实现"导致的同错双绿。
2. **成功路径一律断言 200**，不用 `status !== 401`——后者会把 `400 Server not initialized` 之类误判为通过（本次实测踩到，见 §2 F3）。

---

## §2 本次实测暴露的缺陷（含修复）

> 这一节是本报告的核心价值：**下列 5 项在"单测全绿"状态下全部不可见**。

### F1 ⛔ 致命 —— `extra.headers` 恒为空，OAuth 的 Bearer 从未到达工具层

| 项 | 内容 |
|---|---|
| 现象 | HTTP 层闸通过、带会话的 `tools/list` 通过（200），但真实 `tools/call` 恒返 `{"ok":false,"gate":"auth_required"}` |
| 根因 | MCP SDK 把原始 HTTP 头放在 **`extra.requestInfo.headers`**（`node_modules/@modelcontextprotocol/sdk/dist/esm/server/webStandardStreamableHttp.js:479`，`shared/protocol.js:351` 透传），而 `src/mcp/server.js` 三处处理器读的是 **`extra.headers`** → 恒 `{}` |
| 传导链 | `headers={}` → `extractToken`（`src/mcp/auth.js:71`）取不到 `Authorization: Bearer` → `buildMcpCtx` 判 `degraded` → `gateway.js:322` 返 `gate:'auth_required'` |
| 为何长期潜伏 | `crm-native-cli` 走 `params.api_token`（`extractToken` 的第一优先级），故 CLI 从未暴露该缺陷；而 **OAuth 的 `access_token` 只存在于 HTTP 头** → 不修则 OAuth 全链路打通也依然不可用 |
| 修复 | `src/mcp/server.js` 三处（读 / 写 / 敏感读）改为 `extra?.requestInfo?.headers \|\| extra?.headers \|\| {}` |
| 回归守卫 | `test/mcp-oauth-wiring.test.js` 新增断言：`server.js` 必须含 `extra?.requestInfo?.headers` **且出现 ≥3 次** |
| 实测证据 | 修复前：`{"ok":false,"gate":"auth_required","error":"首次接入请先调用 crm_login…"}`<br>修复后：`{"ok":true,"data":[],"action":"data-particle-read",…}` |

### F2 —— 计划中的 e2e 脚本在 ESM 下必崩

计划 `Task 14 Step 1` 的脚本用 `require('node:crypto')` 生成 PKCE challenge；该文件是 `.mjs`（ESM），`require` 未定义 → 运行期 `ReferenceError`，全部用例崩。已改为具名 `import { createHash } from 'node:crypto'`。

### F3 —— e2e 脚本自身的"假绿"两连

1. **未建 MCP 会话**：StreamableHTTP 要求先 `initialize` 取 `mcp-session-id`，后续调用必须带该头。计划脚本直接 POST `tools/list` → `400 Bad Request: Server not initialized`。
2. **断言过弱**：计划用 `status !== 401` 判"通过" → 上述 `400` 被误判为 PASS。

已改为：`mcpSession()` 两段式建会话 + 成功路径断言 `200`，并对 `tools/list` 额外断言 `tools` 数组非空。

### F4 —— 双时钟导致"令牌出生即过期"（校准 C4）

| 项 | 内容 |
|---|---|
| 现象 | T3 阶段 `markRefreshUsed` 返回 `null`，14 例中 1 例失败 |
| 根因 | 本机 **PostgreSQL 时钟比宿主 Node 时钟快 139.26 秒**（实测：Node `Date.now()` = `12:27:31Z`，DB `now()` = `12:29:50Z`）。`expires_at` 用 Node 时钟算（`now + 60s`），过期判定用 DB 时钟（`expires_at > now()`）→ 偏差 > TTL |
| 修复 | 授权码 / refresh 的 `expires_at` 改由 **DB 时钟计算**（SQL 内 `now() + interval`），消除双时钟依赖；`/oauth/token` 去掉 `new Date(row.expires_at).getTime() <= Date.now()` 的跨时钟预检，过期判定唯一收敛到 `consumeCode` 的 DB 侧 `expires_at > now()` |
| 回写 | 已作为校准 **C4** 回写设计文档 §校准表与计划 |

### F5 —— 计划中 T9 的审计事件既落不了库也签名错误

计划用两参数 `emit('mcp.oauth.token_issued', {...})` 调 `src/events/bus.js`。实测：`bus.emit` 签名为 `(domain, type, payload)`，且**只做进程内广播、不落库**；`crm.events` 的唯一落库收敛点是 `recordEvent()`。
现已改为 `emitAudit(domain, type, payload)`（`src/mcp/oauth.js:22`，内部走 `recordEvent`），签名与 `bus.emit` 对齐。

### 计划 vs 实现的其它差异（不影响结论，备查）

| 项 | 计划 | 实际 |
|---|---|---|
| T4 用例数 | 18 | 20 |
| T14 用例数 | "7 passed" | 20（负向 9 + 正向 5 + 续期 5 + 审计 1） |
| T13 Step 4 的 `cp` 路径 | `plugin/.workbuddy-plugin/connector/*` | **不存在**——`plugin/` 内不含 `connector/`；连接器是独立分发物 |
| T13 Step 5 的断言落点 | 写在 `check_zip` 内（用 `root` 变量） | `check_zip` 无 `root` 变量，且连接器不在 zip 内 → 改为独立 `check_connector()` 直读仓库 `connector/` |
| T7 authorize 的非 admin 路径 | — | 与既有 `mcpLogin` 一致，无差异 |

---

## §3 验收 14 项逐条结论

| # | 验收项（设计 §10） | 结论 | 证据 |
|---|---|---|---|
| 1 | 客户端连接 → 浏览器登录页 → 连接成功 | 🟡 **服务端侧已验证**；真实客户端待人工 | e2e `P3`（POST 账密 → 302 带 code+state）；单测 `authorize`「参数合法 → 200 渲染登录页，含 hidden 协议参数」 |
| 2 | 真实工具调用返回 `ok=true` | ✅ | e2e `P8`：`data-particle-read` → `{"ok":true,…}`（**此条依赖 F1 修复**） |
| 3 | access 过期后静默续期成功 | 🟡 **服务端侧已验证**；客户端无弹窗待人工 | e2e `P5`（轮转）/`P6`（新 access 建会话）/`P7`（带会话 tools/list 200）/`P8`（新 access 实调成功）；单测 `refresh`「同一 chain 连续轮转多次均可成功」「并发双请求同一 refresh → 恰好一个成功」 |
| 4 | 审计 `actor` 为真实用户名 | ✅ | e2e `A1`：`crm.events` 中 `actor='alice'`（真实 `crm_users.username`）；另有 `mcp.oauth.refresh_replay` 事件落库 |
| 5 | `/mcp` 无 token → `401` + `WWW-Authenticate: Bearer … resource_metadata="…"`（**打 `tools/list`**） | ✅ | e2e `N1`/`N2`（实际打 `tools/list`，未用 `initialize`）；单测 `gate`「tools/list 无 token → 401 + WWW-Authenticate」 |
| 6 | 过期 token → `401`（非 HTTP 200 + `gate:'auth_required'`） | ✅ | 单测 `gate`「`tools/list` 过期 token → 401（不是 200 + gate:auth_required）」；「`initialize` 带过期 token → 401」 |
| 7 | `/oauth/register` 传 `https://evil.com/cb` → `400 invalid_redirect_uri` | ✅ | e2e `N3`；白名单另含 fragment / userinfo / 非 `workbuddy` scheme 的负向单测 |
| 8 | PKCE `code_verifier` 错误 → `400 invalid_grant` | ✅ | 单测 `token`「错误 `code_verifier` → 400 invalid_grant（PKCE 拦住）」 |
| 9 | 同一 `code` 二次使用 → `400 invalid_grant`（CAS） | ✅ | e2e `P4b`；单测 `token`「同一 `code` 二次交换 → 400」「并发同一 `code` 双请求 → 恰好一个成功」 |
| 10 | 已轮转 refresh 二次使用 → `400` 且整链吊销 | ✅ | e2e `P9`（400）；单测 `refresh`「旧 refresh 重放 → 400 且整链吊销（**连仍新鲜的叶子也失效**）」+「重放落审计事件 `mcp.oauth.refresh_replay`」 |
| 11 | `/oauth/authorize` 用 admin 账号 → 拒 | ✅ | 单测 `authorize`「admin 账号 → 拒（继承 `src/mcp/auth.js` admin 禁登 MCP）」 |
| 12 | `crm_login`（无 token）仍可调用 | ✅ | e2e `N2c`（真实 HTTP + SDK 派发，HTTP 非 401）；单测 `gate`「`tools/call[crm_login]` 无 token → 200」 |
| 13 | `npm test` 全绿 | ⚠️ **本次改动面零失败**；全量 47 例失败全部落于前序未提交改动涉及的模块（见 §5 归因） | MCP 域 255/255；全量 4238 passed / 47 failed，按模块比对无一位于改动面 |
| 14 | `validate-contract.mjs` 通过 | ✅ | `{"valid": true, "errors": []}` |

---

## §4 本地 e2e 原始输出

命令：

```
MCP_PORT=3110 PGDATABASE=crm_native_test node src/mcp/server.js --http
node scripts/mcp-oauth-e2e.mjs --base http://127.0.0.1:3110 --db
```

输出（原文）：

```
=== MCP OAuth E2E @ http://127.0.0.1:3110 ===

[负向]
  PASS  N1 /mcp 无 token → 401
  PASS  N2 /mcp 401 带 WWW-Authenticate: Bearer resource_metadata
  PASS  N2b initialize 无 token → 200（allowlist 放行，CLI 入口不死锁）
  PASS  N2c crm_login 无 token 可达（HTTP 非 401，闸未误伤登录入口）
  PASS  N3 register 远端 https → 400 invalid_redirect_uri
  PASS  N4 register 合法回调 → 201 且返回 client_id
  PASS  N5 未知 code → 400 invalid_grant
  PASS  N6 authorize 未知 client → 400 且无 Location（不 302）
  PASS  N7 未知 refresh → 400 invalid_grant

[正向]
  PASS  P1 protected-resource metadata 200 且 resource 指向本 BASE
  PASS  P2 authorization-server metadata 200 且含 token_endpoint
  PASS  P3 authorize 账密正确 → 302 带 code 与 state
  PASS  P4 token 交换 → 200 且返回 access + refresh
  PASS  P4b 同一 code 二次交换 → 400 invalid_grant（一次性消费）

[续期]
  PASS  P5 refresh 轮转 → 200 且 refresh 已更换
  PASS  P6 持 access token initialize → 200 且取得 mcp-session-id
  PASS  P7 带会话 tools/list → 200 且返回工具清单
  PASS  P8 真实工具调用 data-particle-read → ok=true（非 auth_required）
  PASS  P9 旧 refresh 重放 → 400 invalid_grant（整链吊销生效）

[审计]
  PASS  A1 crm.events 中 actor 为真实用户名 alice

=== 结果：20 passed, 0 failed ===
```

### F1 修复前后的对照（同一脚本、同一请求）

```
# 修复前（读 extra.headers）
tools/call status: 200
{"ok":false,"gate":"auth_required",
 "error":"首次接入请先调用 crm_login(username,password) 完成用户名密码验证", ...}

# 修复后（读 extra.requestInfo.headers）
tools/call status: 200
{"ok":true,"data":[],"action":"data-particle-read","confirm":null,"advice":{...}}
```

---

## §5 单测与回归

| 范围 | 结果 |
|---|---|
| OAuth 单测（11 文件） | ✅ **121/121** |
| MCP 域回归（25 文件，含 gateway/login/identity/auth/tenant/intent） | ✅ **255/255** |
| 契约校验 | ✅ `{"valid": true, "errors": []}` |
| 全量回归（`--exclude '**/.release-wt/**'`） | ⚠️ **4238 passed / 47 failed**（1774 文件 / 4305 例 / 20 skipped / 耗时 12m21s） |

### 全量 47 例失败的归因（结论：**本次改动面零失败**）

判定方法：按文件名与所属模块逐一比对本次改动面（`src/mcp/*`、`db/schema.sql`、`connector/*`、`plugin/*`、`scripts/verify-plugin-zips.py`、`test/mcp-oauth-*`）。

| 判定 | 结果 |
|---|---|
| 失败文件中属本次改动面者 | **0 个** |
| 失败文件实际落点 | discovery 适配器（anysite/genericRest）、prospecting（confirm/draft/S1 衔接）、租户画像（chemical/insmed/training runbook）、门户布局菜单、formulaEngine、alert、edge-config、particleRepo、aiFill/ai-attributes、校准监控等——**全部来自工作树中前序会话未提交的改动** |

**关键控制证据（排除"本次改动所致"）**：`.release-wt/` 是 release 流程于 **14:25** 留下的整树快照，**早于本次会话**（本会话 20:30 起）。其中的 `test/mcp/confirm-params-merge.test.js` 与本仓同名文件**以完全相同的方式失败**：

```
FAIL  test/mcp/confirm-params-merge.test.js > … 协议位键（confirm_token/api_token/choice/force/…）不参与合并与冲突判定
FAIL  .release-wt/test/mcp/confirm-params-merge.test.js > … 同上
```

快照不含本次任何改动却同样红 → 该失败与本改动无关。该文件的被测函数 `mergePhase2Params` 位于 `src/mcp/gateway.js`，**本次未改动该文件**（`git diff --stat -- src/mcp/gateway.js` 为空）。

> ⚠️ 关于"单次红不得直判回归"：本项目历史确有 flaky 记录，故上表只做**归因**（是否落在改动面）而不下"这 47 例是确定性缺陷"的结论。这 47 例的真实性质属前序会话的责任范围，建议由对应改动方逐条复核。

**一处环境噪声（需留意，非本改动引入）**：`.release-wt/` 内含一份**过期代码副本**，会被 vitest 的路径匹配一并纳入。按目录名传参（如 `vitest run test/mcp`）时会同时跑到它，产出重复的失败项。（本报告的全量数字已用 `--exclude '**/.release-wt/**'` 排除。）**建议把 `.release-wt/` 加入 vitest `exclude`**，否则将来的红/绿判断会持续被污染。

---

## §6 审计真相源证据

`crm.events`（库 `crm_native_test`）：

| domain | type | actor | payload.grant | 说明 |
|---|---|---|---|---|
| `mcp` | `mcp.oauth.token_issued` | `alice` | `authorization_code` | 授权码交换铸 token |
| `mcp` | `mcp.oauth.token_issued` | `alice` | `refresh_token` | 静默续期铸 token |
| `mcp` | `mcp.oauth.refresh_replay` | `alice` | — | 重放检测触发整链吊销 |

`actor` 为真实 `crm_users.username`，**非** `system` / `sales` 兜底 → 验收 4 成立。

> 说明：库中另有大量 `actor` 形如 `tk_5mpkkh9q` / `rf_jksi347e` 的记录，来自单测构造的合成身份，非真实账号，不影响上述结论。

---

## §7 遗留项与待办（按优先级）

| 优先级 | 事项 | 说明 |
|---|---|---|
| **P0** | **发布到生产** | OAuth 代码、三张新表 DDL、Nginx 模板改动均**未上生产**。`crm-mcp` 不重启则线上仍无 OAuth。发布须走 `crm-prod-release` |
| **P0** | ⛔ **发布前必须清理工作树** | release 走 `pack-local.py` **遍历整树打包、不读 git** → **未提交的改动会被原样带上生产**。当前工作树混有前序会话的大量未提交改动（含 47 例测试失败的模块：discovery 适配器 / prospecting / 租户画像 等）。**直接发布会把这些未完成、且当前测试为红的改动一起推上生产**。发布前必须：① 与本轮改动无关的部分先 `git stash -u` 或由对应会话提交；② `git status --porcelain` 用于确认；③ 确认无误后再跑 release |
| **P0** | 生产 e2e | 发布后跑 `node scripts/mcp-oauth-e2e.mjs --base http://81.70.184.198 --user <业务账号> --pass <口令>`，建议用环境变量传凭据（避免落命令行历史）。期望 19/19（不带 `--db` 时审计项跳过） |
| **P0** | 真实客户端验收 | WorkBuddy 客户端删除旧连接器 → 重装 **v1.8.0 连接器包** → 填 `http://81.70.184.198/mcp` → 连接应弹浏览器 → 业务账号登录授权 → 客户端显示连接成功 → 任调一工具应返真实数据 |
| **P1** | 生产 Nginx 改动 | 两个文件需同改：`/etc/nginx/sites-available/crm`（会被 release 整体重写，故本地模板 `nginx-crm.conf` 已同改）与 `/etc/nginx/conf.d/ip-default.conf`（不被 release 重写）。**两处都必须移除 `/mcp` 的 `auth_basic`**，并新增 `/.well-known/*`、`/oauth/*` → 3001 的 location |
| **P1** | 连接器包分发 | `connector/connector-meta.json` 已 `auth_mode: oauth` + `version 1.8.0`；`mcp.json` 已删写死 Bearer 头；`token-schema.json` 已只留 MCP 地址。**须把更新后的 `connector/` 重新分发**，否则老连接器仍会发写死的 Bearer 头 |
| **P1** | 生产库建表 | 三张新表（`crm.oauth_client` / `oauth_code` / `oauth_refresh`）在 `db/schema.sql`，随 `db/migrate.js` 建。发布时须确认 migrate 已执行 |
| **P2** | HTTPS 未启用 | 生产仍为 `http://`；OAuth 授权码与 token 明文传输。授权码 5 分钟一次性 + PKCE 已缓解，但**根治需域名 + 证书**（备案是前提） |
| **P2** | 登录失败限流 | 设计 §3.5 末尾的滑动窗口限流本期未做（有意裁剪，见计划 Self-Review「已知未覆盖」） |
| **P2** | `.release-wt/` 污染测试 | 建议加入 vitest `exclude`（见 §5） |

---

## §8 回滚

任一步骤异常时，**不需要回滚代码**即可止血——设计预留了开关：

1. **停用 HTTP 层闸与 OAuth 端点**：置 `MCP_CONFIG.oauth.enabled = false`（`src/mcp/config.js:32`）。效果：回滚到"`/mcp` 无 HTTP 层闸"的旧行为，**工具层 `requireAuth` 仍在，安全性不塌**（无凭证仍得 `gate:'auth_required'`）。
2. **完全回到旧架构**：恢复 `nginx-crm.conf` 中 `/mcp` 的 `auth_basic` 两行 + `connector/*` 改回 `auth_mode: "token"` + 重发连接器包。
   ⚠ 注意：这一步会把"所有人连不上"的老故障一起带回来（根因即 `Authorization` 头互斥），仅在需要完全退回旧状态时才做。
3. 数据层无需回滚：三张新表 `CREATE TABLE IF NOT EXISTS`，不删除即可；`mcp_identity` 的列结构未改动（渠道标记落 `scopes` jsonb）。

---

## 附录：本次改动的文件清单

| 文件 | 改动 |
|---|---|
| `db/schema.sql` | 新增 3 表 + 索引（T1） |
| `src/mcp/oauthCrypto.js` | 新增：PKCE S256 / 常量时间比较 / 不透明令牌（T2） |
| `src/mcp/oauthStore.js` | 新增：客户端注册 / 用户校验 / code CAS 消费 / refresh 轮转链（T3；含 C4 双时钟修复） |
| `src/mcp/oauth.js` | 新增：metadata / DCR / authorize / token + 审计收敛 `emitAudit`（T4/T7/T8/T9） |
| `src/mcp/oauthPage.js` | 新增：登录页 / 错误页渲染（T6） |
| `src/mcp/auth.js` | 抽出 `issueMcpIdentity`，吊销范围按渠道收敛（T5 / 校准 C3） |
| `src/mcp/httpAuth.js` | 新增：HTTP 层 401 闸 + `WWW-Authenticate` Bearer 质询（T10） |
| `src/mcp/config.js` | 新增 `oauth` 配置段（T4） |
| **`src/mcp/server.js`** | 挂载 OAuth 路由与闸、`express.urlencoded`、端口可配，**并修复 `extra.requestInfo.headers`（F1）** |
| `scripts/tencent-lighthouse-deploy/nginx-crm.conf` | `/mcp` 去 `auth_basic`；新增 OAuth 前缀 location（T12） |
| `connector/{connector-meta,mcp,token-schema}.json` | `auth_mode: oauth` / 删写死 Bearer 头 / 只留 MCP 地址（T13） |
| `skills/crm-native/SKILL.md` ×4 副本 | 首次接入改双渠道（OAuth 推荐 + crm_login），4 份仍 byte-equal |
| `.workbuddy-plugin/agents/crm-native.md` ×2 副本 | 同上 |
| `plugin/README.md` | MCP 章节改双渠道 + OAuth 端点说明 |
| `buddy-app-store-listing/README.md` | `auth_mode` 表与"待解决问题 2"改为已解决 |
| `scripts/verify-plugin-zips.py` | 新增 `check_connector()` OAuth 回退守卫 + 3 条锚定规则 |
| `scripts/pack-crm-plugin.py` 产物 | 重打包 `plugin/crm-native-plugin.zip`（20 skills / 133 文件） |
| **`scripts/mcp-oauth-e2e.mjs`** | 新增：20 用例端到端验证脚本 |
| 测试新增 11 个文件 | `test/mcp-oauth-{schema,crypto,store,register,page,authorize,token,refresh,gate,issue-identity,wiring}.test.js` |
