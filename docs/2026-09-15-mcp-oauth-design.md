# MCP OAuth 标准授权接入设计（crm-native-mcp）

- **日期**：2026-09-15
- **状态**：已批准（2026-09-15 用户确认方案 A + access 8h / refresh 30 天轮转）
- **设计输入**：
  - `docs/2026-09-04-plugin-production-mcp-channel-design.md`（/mcp 公网分发与会话级 StreamableHTTP）
  - `docs/2026-08-29-mcp-forced-login-design.md`（`requireAuth` 强制登录改造）
  - `docs/2026-09-01-mcp-token-lookup-design.md`（结构化 token 与 O(1) 身份查表）
  - 现场证据：生产容器内 `127.0.0.1:3001/mcp` 返回 200、经 Nginx 带 `Bearer` 返回 401
  - 客户端契约：从 WorkBuddy 客户端 asar 提取的 `.well-known/*`、`registration_endpoint`、`code_challenge`、`resource_metadata` 字符串与 `workbuddy://…/oauth/callback` 回调 scheme
- **影响面**：`src/mcp/`（新增 oauth 模块）、`src/mcp/server.js`（HTTP 层鉴权）、`src/mcp/auth.js`（颁发收口）、`db/schema.sql`（3 张新表）、Nginx 模板、`connector/` 与插件包

---

## §0 问题与根因（已实测）

**现象**：所有接入方连接生产 `81.70.184.198` 的 MCP 通道均失败，客户端停在「授权中…」，随后将 `crm-native-mcp` 标记为失败。

| 观测 | 结果 |
|---|---|
| 容器内直连 `http://127.0.0.1:3001/mcp`（绕过 Nginx） | **HTTP 200**，返回正常 initialize 响应 |
| 经 Nginx 带 `Authorization: Bearer …` 请求 `/mcp` | **HTTP 401** + `WWW-Authenticate: Basic realm="CRM MCP Gateway"` |

**根因（两条独立缺陷叠加，缺一不可）**：

1. **认证头互斥**：Nginx 的 `/mcp` location 要求 `auth_basic`（`Authorization: Basic …`，见 `scripts/tencent-lighthouse-deploy/nginx-crm.conf:32`），而连接器声明 `Authorization: Bearer ${CRM_API_TOKEN}`（`connector/mcp.json:8`）。HTTP 只有一个 `Authorization` 头，二者互斥 → 请求在网关层被 401 拦死，永远到不了应用层。
2. **缺失 OAuth 发现入口**：客户端的 MCP OAuth 客户端以「`/mcp` 返回 401 且带 `WWW-Authenticate: Bearer resource_metadata=…`」为唯一触发条件。当前 Nginx 返回的是 `Basic` 质询，客户端据此判定为非 OAuth 端点，因此既不发起标准授权，也无法用现有 token 通过 → 只能退化到「手填 token」路径，而该路径同样被 Basic 拦住。

**关键修正（相对初版口头描述的偏差）**：应用层的 `requireAuth` 并**不在 HTTP 层生效**。`MCP_CONFIG.security.requireAuth` 的判定位于 tool-call 层——`src/mcp/gateway.js:149` / `:250` / `:322`，返回的是 HTTP 200 携带 `{ ok:false, gate:'auth_required' }` 的 JSON-RPC 结果。因此：

> **`WWW-Authenticate: Bearer resource_metadata` 必须新增在 HTTP 层（`src/mcp/server.js` 的路由中间件），不能指望 gateway 产出。** 这是触发客户端 OAuth 发现链的唯一开关，若只改 gateway，客户端依然不会发起 OAuth。

---

## §1 目标与非目标

### 目标
1. 客户端**零手填凭据**：点「连接」→ 浏览器登录 → 授权完成，MCP 全链路可用。
2. 实现 RFC 9728（protected resource metadata）、RFC 8414（authorization server metadata）、RFC 7591（动态客户端注册）、OAuth 2.1 授权码 + PKCE(S256) + refresh 轮转。
3. 身份体系**复用**既有 `crm.mcp_identity` + `crm.crm_users` + pgcrypto，不引入第二套账号。
4. `/mcp` 的认证职责从 Nginx `auth_basic` 收敛到应用层 Bearer 校验，消除双层头冲突。

### 非目标（本期明确不做）
- 不做多资源服务器联合（PDM / Agent2B 复用授权服务器）——留待第二个资源服务器出现时再评估。
- 不做 scope 细分（仅 `mcp` 单一 scope），不预先拆 read/write，避免过度设计。
- 不做 OIDC 用户信息端点（`/userinfo`）、ID Token、JWT 签名——access_token 仍为不透明结构化 token。
- 不改动任何业务粒子、业务域模型、Agent 名册与 Action Registry。
- 不改动 `config_store['context-routing']`（id36，配置禁改红线）。

---

## §2 架构与职责边界

选定**方案 A**：OAuth 授权服务器与资源服务器同为 `crm-mcp`（`:3001`），发现链与端点同进程、同源，消除「metadata 说 A、端点实际在 B」的配置错位。

```
WorkBuddy 客户端
  │
  ├─ ① POST /mcp（无 token） ──────────────► 401 + WWW-Authenticate: Bearer resource_metadata="…"
  │                                              （src/mcp/server.js 新增 HTTP 层闸）
  ├─ ② GET  /.well-known/oauth-protected-resource  ─┐
  ├─ ③ GET  /.well-known/oauth-authorization-server  │  crm-mcp :3001
  ├─ ④ POST /oauth/register      （DCR）             │  （新增 src/mcp/oauth.js）
  ├─ ⑤ GET/POST /oauth/authorize （登录页 + 发 code） │
  ├─ ⑥ POST /oauth/token         （换 token / 轮转）  ┘
  └─ ⑦ POST /mcp（Authorization: Bearer <access_token>）─► 既有工具链（gateway → Action）
```

**公网只有一个 origin**（当前 `http://81.70.184.198`，将来 `https://www.chiyuai.com`），`3000`/`3001` 均只监听回环。因此「同源」在此退化为「同一 origin 下不同**路径前缀**由谁反代」，Nginx 需把 4 个路径前缀指向 `3001`。

**issuer / resource 的派生规则（不硬编码）**：由请求头推导
`origin = (X-Forwarded-Proto || 'https') + '://' + (X-Forwarded-Host || Host)`
使 metadata 内容随访问入口自动一致（IP 访问写 IP、域名访问写域名）。Nginx 必须为相关 location 透传 `X-Forwarded-Proto` 与 `Host`，否则会出现「metadata 指向域名、客户端用 IP → 校验失败」。

---

## §3 端点契约

### 3.1 `GET /.well-known/oauth-protected-resource`（RFC 9728）

同时接受**路径插入式**变体（RFC 9728 §3.1 对带路径资源的规定）：
- `/.well-known/oauth-protected-resource`
- `/.well-known/oauth-protected-resource/mcp`

```json
{
  "resource": "<origin>/mcp",
  "authorization_servers": ["<origin>"],
  "scopes_supported": ["mcp"],
  "bearer_methods_supported": ["header"]
}
```

### 3.2 `GET /.well-known/oauth-authorization-server`（RFC 8414）

别名：`/.well-known/openid-configuration`（客户端 asar 中出现该字符串，作为廉价保险一并支持）。

```json
{
  "issuer": "<origin>",
  "authorization_endpoint": "<origin>/oauth/authorize",
  "token_endpoint": "<origin>/oauth/token",
  "registration_endpoint": "<origin>/oauth/register",
  "response_types_supported": ["code"],
  "grant_types_supported": ["authorization_code", "refresh_token"],
  "code_challenge_methods_supported": ["S256"],
  "token_endpoint_auth_methods_supported": ["none"],
  "scopes_supported": ["mcp"]
}
```

`token_endpoint_auth_methods_supported: ["none"]` 表明这是 public client（无 client_secret），安全边界完全由 PKCE 承担——这也决定了 `/oauth/token` **不得**接受 `client_secret` 参与鉴权。

### 3.3 `POST /oauth/register`（RFC 7591 动态客户端注册）

请求：
```json
{ "client_name": "WorkBuddy",
  "redirect_uris": ["workbuddy://workbuddy/mcp/connector:crm-native/oauth/callback"],
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "token_endpoint_auth_method": "none" }
```
响应 `201`：`{ client_id, redirect_uris, grant_types, token_endpoint_auth_method: "none" }`。

**redirect_uri 白名单（防开放重定向，fail-closed）**：

| 允许 | 规则 |
|---|---|
| 自定义 scheme | scheme === `workbuddy`，host === `workbuddy`，path 需匹配 `^/mcp/connector:[^/]+/oauth/callback$` |
| 回环 HTTP | host ∈ {`127.0.0.1`, `[::1]`, `localhost`}，允许任意端口，**必须** `http`（非 https） |
| 其他 | **一律拒绝** |

明确拒绝：`https://` 远端地址、含 `fragment`、含通配、`*`、空 host、`javascript:`/`data:` 等 scheme。
未通过白名单 → `400 { error: "invalid_redirect_uri" }`，不落库。

### 3.4 `GET /oauth/authorize`

参数：`response_type=code`、`client_id`、`redirect_uri`、`state`、`code_challenge`、`code_challenge_method=S256`、`scope`（可选）。

校验顺序（**重要**）：先校验 `client_id` 存在且未禁用、`redirect_uri` 与注册值**精确相等**、`code_challenge` 非空且 `code_challenge_method === 'S256'`。任一不过 → **渲染错误页，绝不 302**（RFC 6749 §4.1.2.1：非法 client / redirect_uri 时禁止重定向，否则成为开放重定向放大器）。
全部通过 → 渲染登录页（HTML，服务端内联，不引外部 CDN），表单以 hidden 字段携带上述参数。

### 3.5 `POST /oauth/authorize`

1. 重新完整校验参数（不信任 hidden 字段回传）。
2. 账号密码校验：复用 `crm.crm_users` + `pgcrypto crypt()`，语义与 `src/mcp/auth.js:129 mcpLogin` 一致——含 `enabled=false` 拒、`activated=false` 拒、**`role==='admin'` 拒**（admin 仅限 HTTP 后台，`src/mcp/auth.js:139`）。此条为继承既有安全策略，不得放宽。
3. 失败 → 回渲染登录页 + 错误提示（**不区分用户名不存在/密码错误**，统一文案，防用户名枚举）。
4. 成功 → **铸授权码**（仅存 SHA-256 哈希），`code` 明文只出现在重定向 URL 中。**此处不铸 access token**（见 §3.6 与文末「实施阶段校准」C1）。
5. `302` 到 `redirect_uri?code=…&state=…`（`state` 原样回传，缺省则省略）。

限速：同一 `client_id` + 源 IP 的失败尝试按滑动窗口限流（内存计数即可，阈值进 `MCP_CONFIG.oauth.loginMaxAttempts`），防止在线撞库。

### 3.6 `POST /oauth/token`

**`grant_type=authorization_code`**
- 入参：`code`、`client_id`、`redirect_uri`、`code_verifier`
- 按 `sha256(code)` 查 `crm.oauth_code`；依次校验：存在、未 `consumed_at`、未过期、`client_id` 一致、`redirect_uri` 精确一致
- **PKCE**：`base64url(sha256(code_verifier)) === code_challenge`，不等 → `400 invalid_grant`
- **一次性消费用 CAS**：`UPDATE crm.oauth_code SET consumed_at = now() WHERE code_hash = $1 AND consumed_at IS NULL RETURNING *`。仅在 `RETURNING` 有行时放行——防并发/重放双发 token。**绝不 DELETE**。
  - 顺序要求：`client_id` / `redirect_uri` 的校验必须在 CAS **之前**（先只读 `getCode`，再 `consumeCode`），否则一个参数写错的请求会把授权码白白烧掉。
- **铸 access_token**：在此阶段调用 §7 的 `issueMcpIdentity({ issuedBy:'oauth', clientId, ttlMs: accessTtlMs })`（校准 C1），并铸首枚 refresh token（新 `chain_id`）
- 返回：`{ access_token, token_type:"Bearer", expires_in: 28800, refresh_token, scope:"mcp" }`

**`grant_type=refresh_token`**
- 入参：`refresh_token`、`client_id`
- 按 `sha256(refresh_token)` 查 `crm.oauth_refresh`；校验存在、`revoked_at IS NULL`、未过期、`client_id` 一致
- **重放检测**：若该行 `used_at IS NOT NULL`（即已轮转过仍被使用）→ 判定为泄露：吊销该 `chain_id` **整条链**全部 refresh（`revoked_at = now()`），返回 `400 invalid_grant`，并 `emit` 安全事件
- 正常轮转（同一事务）：旧行置 `used_at = now(), rotated_to = <新哈希>`；插入同 `chain_id` 新行（30 天）；经 `issueMcpIdentity({ issuedBy:'oauth' })` 铸新 access token
- 返回新的 `{ access_token, refresh_token, expires_in }` 对

**统一错误响应**：一律 `400 { error: "invalid_grant" | "invalid_client" | "unsupported_grant_type" }`，**不泄漏**「code 不存在」与「PKCE 不匹配」的区别。

### 3.7 `POST/GET/DELETE /mcp` —— HTTP 层鉴权（新增，触发 OAuth 的唯一开关）

在 `src/mcp/server.js` 的三个路由前新增中间件（`startMcpHttp` 内，`app.use` 挂 `/mcp`）：

| 情形 | 行为 |
|---|---|
| body 为 `initialize` 方法 | **放行**（协议握手，无凭据） |
| body 为 `tools/call` 且 `params.name === 'crm_login'` | **放行**（首次接入验证入口，必须保持无 token 可达；否则 CLI 通道死锁） |
| body 为 `notifications/*` | 放行 |
| 其余请求，`extractToken(body.params, headers)` 取到有效 token | 放行，`ctx` 经 `res.locals` 传递避免重复解析 |
| 其余请求，token 缺失 / 格式非法 / 已吊销 / 已过期 | **`401`** + `WWW-Authenticate: Bearer realm="crm-mcp", resource_metadata="<origin>/.well-known/oauth-protected-resource"` |

必须用既有的 `extractToken`（`src/mcp/auth.js:71`）取 token，因为它同时覆盖 `params.api_token` 与 `Authorization: Bearer`——**只认 Bearer 头会直接打断 crm-native-cli 的既有调用方式**（CLI 走 `api_token` 参数，见 `packages/crm-native-cli/src/commands/auth.js:38`）。

token 有效性做**完整校验**（复用 `resolveIdentity`，主键索引 O(1)）：只在 HTTP 层做格式校验会导致「token 过期」时 gateway 返回 200 + `gate:'auth_required'`，客户端不认为需要重新授权 → 静默续期链路失效。

> **实施者须知：首次 401 不会出现在 `initialize` 上。**
> 因为 `initialize` 在 allowlist 内（CLI 兼容所必需），未授权客户端会**先拿到 `initialize` 的 200 响应**，随后在 `tools/list` 或首个 `tools/call` 上收到 401 + `WWW-Authenticate`，此时才触发 OAuth 发现链。
> 这不影响正确性（客户端对任何请求的 401 都触发发现），但调试时不要据此误判「闸没生效」。验证方式见 §10 负向用例 5/6：直接用 `curl` 打 `tools/list`，而非 `initialize`。
> 另需注意：`initialize` 放行不构成信息泄漏——该响应只含 server name/version/capabilities，不含任何业务数据或身份信息。

---

## §4 数据模型（3 张新表，追加 `db/schema.sql`）

单一事实源：DDL 直接追加到 `db/schema.sql` 末尾（app 启动经 `db/migrate.js` 执行）。全部 `CREATE TABLE IF NOT EXISTS`，旧库/新库一致生效。

```sql
-- ============ MCP OAuth 授权服务器（2026-09-15，docs/2026-09-15-mcp-oauth-design.md T1）============
-- 三张表均为新增，不改动任何既有表结构。铁律：不物理 DELETE，一律软吊销（disabled_at / consumed_at / revoked_at）。

CREATE TABLE IF NOT EXISTS crm.oauth_client (
  client_id                  TEXT PRIMARY KEY,          -- DCR 生成（oauth_<32hex>）
  client_name                TEXT,
  redirect_uris              JSONB NOT NULL DEFAULT '[]'::jsonb,
  grant_types                JSONB NOT NULL DEFAULT '["authorization_code","refresh_token"]'::jsonb,
  token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none',
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at               TIMESTAMPTZ,
  disabled_at                TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_oauth_client_active ON crm.oauth_client(created_at DESC) WHERE disabled_at IS NULL;

CREATE TABLE IF NOT EXISTS crm.oauth_code (
  code_hash             TEXT PRIMARY KEY,               -- sha256(code) hex；明文不落库
  client_id             TEXT NOT NULL REFERENCES crm.oauth_client(client_id),
  actor                 TEXT NOT NULL,
  tenant_id             TEXT NOT NULL DEFAULT 'system',
  role_tag              TEXT NOT NULL,
  redirect_uri          TEXT NOT NULL,
  code_challenge        TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL DEFAULT 'S256' CHECK (code_challenge_method = 'S256'),
  scope                 TEXT NOT NULL DEFAULT 'mcp',
  expires_at            TIMESTAMPTZ NOT NULL,
  consumed_at           TIMESTAMPTZ,                    -- 一次性消费（CAS），绝不 DELETE
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_oauth_code_expiry ON crm.oauth_code(expires_at);

CREATE TABLE IF NOT EXISTS crm.oauth_refresh (
  token_hash   TEXT PRIMARY KEY,                        -- sha256(refresh_token) hex
  client_id    TEXT NOT NULL REFERENCES crm.oauth_client(client_id),
  actor        TEXT NOT NULL,
  tenant_id    TEXT NOT NULL DEFAULT 'system',
  role_tag     TEXT NOT NULL,
  scope        TEXT NOT NULL DEFAULT 'mcp',
  chain_id     UUID NOT NULL DEFAULT gen_random_uuid(), -- 轮转链；重放时整链吊销
  rotated_to   TEXT,                                    -- 后继 token_hash（串成审计链）
  expires_at   TIMESTAMPTZ NOT NULL,
  used_at      TIMESTAMPTZ,                             -- 已轮转标记
  revoked_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_oauth_refresh_chain ON crm.oauth_refresh(chain_id);
CREATE INDEX IF NOT EXISTS idx_oauth_refresh_active ON crm.oauth_refresh(client_id, actor)
  WHERE revoked_at IS NULL;
```

**说明**
- `oauth_client` **不绑租户**：注册发生在登录之前，此时尚无身份，无从得知租户。租户在 `oauth_code` / `oauth_refresh` 上随登录身份落定。
- `oauth_code` **不含 identity_id**（校准 C1/C2）：`mcp_identity` 在 `/oauth/token` 交换时才铸，授权阶段无从得知其 id；保留该列会成为永不写入的死列。
- `access_token` 不新建表，复用 `crm.mcp_identity`（`db/schema.sql:491`），因此 `resolveIdentity` 一行不用改。
- 不设 `mcp_identity` 的外键：身份行可能在 code 被消费前就已被吊销，硬 FK 会制造不必要的时序耦合。

---

## §5 关键流程

### 5.1 首次授权（一次性）
```
POST /mcp  initialize        → 200（allowlist 放行，CLI 兼容所需）
POST /mcp  tools/list        → 401 + WWW-Authenticate: Bearer resource_metadata="…"   ← OAuth 发现链触发点
GET  /.well-known/oauth-protected-resource → authorization_servers
GET  /.well-known/oauth-authorization-server → 端点清单
POST /oauth/register → client_id
GET  /oauth/authorize → 登录页
POST /oauth/authorize（账密）→ 302 workbuddy://…/oauth/callback?code=…&state=…
POST /oauth/token（code + code_verifier）→ access(8h) + refresh(30d)
POST /mcp（Bearer access）→ 200 ✅
```

### 5.2 静默续期（每 8h 一次，用户无感）
```
POST /mcp（Bearer 已过期）→ 401 + resource_metadata
POST /oauth/token（grant_type=refresh_token）→ 新 access + 新 refresh（旧 refresh 置 used_at/rotated_to）
POST /mcp（Bearer 新 access）→ 200 ✅
```
refresh 有效期内（30 天）全程无需用户介入。

### 5.3 refresh 重放（攻击或客户端状态错乱）
```
旧 refresh 第二次使用 → used_at IS NOT NULL → 吊销 chain_id 整链 → 400 invalid_grant → emit 安全事件
后续该链上任何 refresh 均失效 → 用户重新走一次授权
```
这是有意的**故障放大**：宁可让用户重登一次，也不容许一条可能已泄露的链继续续期。

---

## §6 安全策略

| 项 | 策略 | 理由 |
|---|---|---|
| PKCE | **强制 S256**，表级 `CHECK` 拒绝 `plain` | public client 无 secret，PKCE 是唯一授权码拦截防线 |
| 开放重定向 | redirect_uri 注册期白名单 + 授权期**精确匹配**；非法时渲染错误页不 302 | 防 token 被导到攻击者回调 |
| 授权码 | 5 分钟过期、CAS 一次性消费、仅存哈希 | 极限压缩截获窗口 |
| refresh | 30 天、每次轮转、重放整链吊销 | 泄露可检测、可收敛 |
| 身份 | 复用 `crm_users` + pgcrypto；**继承 admin 禁登 MCP** | 不引入第二套账号，不放松既有策略 |
| 用户名枚举 | 登录失败统一文案、统一状态码 | 防撞库侧信道 |
| 撞库 | 失败尝试滑动窗口限流（client_id + IP） | 在线爆破成本抬升 |
| 审计 | 每个端点的成功/失败均 `emit`，含 actor/client_id/tenant_id | 全链路可追溯 |
| 失败姿态 | 所有校验 **fail-closed**（异常即拒） | 无裸 `catch(()=>{})`，无静默放行 |
| 密钥 | 明文 refresh/code **永不落库、永不进日志**；日志只出哈希前缀 | 对齐 `src/mcp/auth.js:110` 绝对红线 |
| scope | 单一 `mcp` | YAGNI，不预拆 read/write |

---

## §7 与既有代码的接驳点（3 处收口，避免逻辑分叉）

### 7.1 `src/mcp/auth.js` — 颁发逻辑收口为 `issueMcpIdentity`
现状：`mcpLogin`（`:129`）内联完成「查用户 → 校验密码 → 铸 token → 软吊销该 actor 旧 token」。若 OAuth 另写一份，两份逻辑必然漂移（尤其软吊销策略）。

**改法（additive，不改既有行为）**：抽出
```js
export async function issueMcpIdentity({ username, role, tenantId, issuedBy = 'crm_login', clientId = null, ttlMs = null })
```
- INSERT `crm.mcp_identity` 时 `scopes` 合并 `{ ...writeScopesForRole(role), issued_by: issuedBy, client_id: clientId }`（复用既有 jsonb 列，**不动表结构**）
- 软吊销范围**按颁发渠道收敛**（双向隔离）：
  - `issuedBy === 'crm_login'`（默认）→ 吊销该 actor 其余全部**非 oauth 渠道**的未吊销 token。历史 token 的 `scopes` 无 `issued_by`，经 `COALESCE(scopes->>'issued_by','crm_login')` 判定为 `crm_login` → **仍被吊销，既有语义不破坏，向后兼容**。
  - `issuedBy === 'oauth'` → 只吊销该 actor 下 `scopes->>'issued_by' = 'oauth'` 且 `scopes->>'client_id'` 相同的 token。

**为什么必须双向收敛**：轮转语义下若任一侧沿用「吊销该 actor 全部旧 token」，都会造成单向踩踏——OAuth 每 8h 续期顺手吊销用户的 CLI token；反之用户跑一次 `crm-cli auth login` 又静默踢掉 OAuth 会话。两者互相踩踏会造成间歇性、难以复现的掉线（见文末校准 C3）。
代价是同一 actor 可同时持有 1 个 CLI token + 每 client 1 个 OAuth token；二者均由本人凭据换得，属可接受的最小放宽。

`mcpLogin` 改为调用该函数，返回值与状态码语义完全不变（`test/mcp-login.test.js`、`test/mcp-auth.test.js` 必须全绿）。

### 7.2 `src/mcp/server.js` — HTTP 层闸 + 挂载 OAuth 路由
- `app.use('/mcp', …)` 中间件（§3.7）
- 挂载 `src/mcp/oauth.js` 导出的 router（`/.well-known/*`、`/oauth/*`）
- 保持「每会话独立 `McpServer` 实例」的既有约束不变（`server.js:102` 注释所述 SDK 1:1 绑定限制）

### 7.3 `src/mcp/config.js` — 新增 `oauth` 配置段
```js
oauth: {
  enabled: true,
  accessTtlMs:  8 * 60 * 60 * 1000,        // 8h（复用 tokenTtlMs 语义）
  refreshTtlMs: 30 * 24 * 60 * 60 * 1000,  // 30 天
  codeTtlMs:    5 * 60 * 1000,             // 5 分钟
  scope: 'mcp',
  allowedRedirectSchemes: ['workbuddy'],
  allowLoopbackRedirect: true,
  loginMaxAttempts: 10,                    // 滑动窗口内失败上限
  loginWindowMs: 10 * 60 * 1000,
}
```
`enabled: false` 即回滚到「无 HTTP 层闸」的旧行为（§12）。

---

## §8 部署与连接器包（两处必须同改，否则下次 release 必回退）

| 位置 | 改动 | 为什么必须同改 |
|---|---|---|
| `/etc/nginx/sites-available/crm`（生产） | `/mcp` **去掉** `auth_basic` 两行；新增 4 个路径前缀 → `3001`，透传 `Host`/`X-Forwarded-Proto` | `scripts/tencent-lighthouse-deploy/deploy.sh:184` 每次 release 用本地模板**整体覆盖**该文件 |
| `scripts/tencent-lighthouse-deploy/nginx-crm.conf`（本地模板） | 与生产**同内容修改** | 不改则下次 release 把生产配置改回 Basic Auth，故障复现 |
| `/etc/nginx/conf.d/ip-default.conf`（生产） | 同上（该文件不被 release 重写，可稳定承载） | 两条入口都带 `auth_basic`，只改一处仍会 401 |
| `connector/connector-meta.json` | `"auth_mode": "token"` → `"oauth"`；`version` 1.7.0 → 1.8.0 | 客户端按 `auth_mode` 决定走 OAuth 还是手填 token；不改为 token 则**永不触发** OAuth 流程 |
| `connector/mcp.json` | **删除** `headers.Authorization` 整块，仅保留 `url` + `timeout` | OAuth 模式下 Bearer 由客户端注入；写死 Bearer 会与注入头冲突（重复头 → 服务端解析歧义） |
| `connector/token-schema.json` | 删除 `CRM_API_TOKEN` 字段，仅保留 `CRM_MCP_URL` | OAuth 模式无手填 token；留着会让用户以为要手填 |
| `plugin/` 与 `.workbuddy-plugin/` 插件包 | 同步上述 3 个文件的副本 + `agents/crm-native.md` 2 份中「首次接入须 `crm_login`」的表述补 OAuth 路径 | 分发包与仓库配置必须一致，否则用户装到的仍是旧声明 |
| `scripts/verify-plugin-zips.py` | 断言新增：连接器包内 `auth_mode === 'oauth'` 且 `mcp.json` 无私写 `Authorization` 头 | 现有校验只断言版本与文案，不足以防本次回退 |

**Nginx 新增片段（模板与生产一致）**：
```nginx
# MCP OAuth 发现与授权端点（RFC 9728 / 8414 / 7591）→ crm-mcp :3001
# 必须透传 Host / X-Forwarded-Proto：issuer 与 resource 由请求头推导，缺失会导致
# metadata 指向 http://127.0.0.1 或协议不符，客户端校验失败。
location ^~ /.well-known/oauth-protected-resource {
    proxy_pass http://127.0.0.1:3001;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Real-IP $remote_addr;
}
location ^~ /.well-known/oauth-authorization-server {
    proxy_pass http://127.0.0.1:3001;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
}
location ^~ /.well-known/openid-configuration {
    proxy_pass http://127.0.0.1:3001;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
}
location ^~ /oauth/ {
    proxy_pass http://127.0.0.1:3001;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_read_timeout 60s;
}
```
`/mcp` location 保留 SSE 相关全部指令（`proxy_buffering off` 等），**只删掉 `auth_basic` 两行**，其余不动。

---

## §9 任务分解（7 个 Task，一 Task 一 commit）

| Task | 内容 | 产出 | 关键红线 |
|---|---|---|---|
| **T1** | 3 张表 DDL 追加 `db/schema.sql`；`db/migrate.js` 跑通新旧库 | DDL + 迁移验证 | 只 `CREATE TABLE IF NOT EXISTS`，不改既有表 |
| **T2** | `src/mcp/oauth.js`：metadata（含 `resource_metadata` 变体与 openid 别名）+ `POST /oauth/register`（白名单） | 模块骨架 + 2 端点 | 注册期即拒非法 redirect_uri |
| **T3** | `GET/POST /oauth/authorize` + 登录页 HTML；`src/mcp/auth.js` 抽出 `issueMcpIdentity` | 授权端 + 颁发收口 | admin 禁登继承；失败文案统一 |
| **T4** | `POST /oauth/token`：code 换 token + refresh 轮转 + 重放整链吊销；`src/mcp/server.js` 加 HTTP 层 401 闸 | token 端 + /mcp 闸 | 只认 Bearer 头会打断 CLI（必须走 `extractToken`）；CAS 消费 |
| **T5** | Nginx 模板 + 生产两处配置修改 + release | 生产生效 | 模板与生产**同内容**，否则 release 回退 |
| **T6** | `connector/` + 插件包 4 份 SKILL.md + `verify-plugin-zips.py` 断言 | 连接器 v1.8.0 | `auth_mode: "oauth"` 与删自写头必须同时改 |
| **T7** | 端到端验证（真实客户端 + 负向用例） | 验证报告 | 见 §11 |

**契约裁剪说明（诚实标注，不填占位值）**：T1–T6 是纯服务端基础设施与部署配置，**不经过任何 agent 运行时**，为其编写 `agent/skills/memory` 契约只会制造「假绿」（契约矩阵会因这些永不运行的 episode 长期不绿）。因此仅对真正落在 agent 链路上的 **T7** 提供契约块：

```contract-yaml
- task: "T7 OAuth 授权后端到端验证"
  contract_task_id: ct-intake-route
  agent: intake-router
  skills: [data-particle-read]
  memory: [intake-router]
  knowledge_scope: { layers: [L1], max_hops: 3 }
  success: "经 OAuth 授权的客户端调用 data-particle-read 返回 ok=true，且审计中 actor 为真实 crm_users 用户名"
```
（`skills` ⊆ `agentSpec.js:8` 的 `skillCalls`；`memory` ⊆ `agentSpec.js:12` 的 `memory.read`；`layers` ⊆ `agentSpec.js:9` 的 `knowledgeScope.layers`。仅覆盖 1 个名册 agent，不触发名册类文档的全体覆盖断言。）

---

## §10 验收标准

### 正向
1. 客户端「连接」→ 浏览器弹出登录页 → 输入 sales 账号 → 回到客户端显示连接成功（**不再卡「授权中…」**）。
2. 经授权后调用任一真实工具（如 `data-particle-read`）返回 `ok=true`。
3. access 过期后**静默续期**成功，用户无感（无二次浏览器弹窗）。
4. 审计事件中 `actor` 为真实 `crm_users.username`，非 `system`/`sales` 兜底。

### 负向（逐条必须有自动化测试）
5. `/mcp` 无 token → `401` + `WWW-Authenticate: Bearer … resource_metadata="…"`。
   **测试须打 `tools/list`（或任一未授权工具），不得用 `initialize`** —— 后者在 allowlist 内必然 200，用它断言会得到恒假绿。
6. `/mcp` 过期 token → `401`（**不是** HTTP 200 + `gate:'auth_required'`）。
   反向断言：`tools/list` 带已过期 token 必须走 HTTP 401 分支，而非落回 gateway 的 `auth_required`。
7. `/oauth/register` 传 `https://evil.com/cb` → `400 invalid_redirect_uri`。
8. `/oauth/token` PKCE `code_verifier` 错误 → `400 invalid_grant`。
9. 同一 `code` 二次使用 → `400 invalid_grant`（CAS 生效）。
10. 已轮转的 refresh 二次使用 → `400 invalid_grant` 且该 `chain_id` 全部 refresh 被吊销。
11. `/oauth/authorize` 用 admin 账号 → 拒（继承 `src/mcp/auth.js:139`）。
12. `crm_login`（MCP 工具，无 token）→ **仍可调用**（HTTP 层闸未误伤）。

### 回归
13. `npm test` 全绿；`test/mcp-login.test.js`、`test/mcp-auth.test.js`、`test/mcp-gateway.test.js` 行为不变（`issueMcpIdentity` 收口零语义漂移）。
14. `node scripts/validate-contract.mjs docs/2026-09-15-mcp-oauth-design.md` 通过。

---

## §11 风险与回滚

| 风险 | 影响 | 缓解 |
|---|---|---|
| HTTP 层闸误伤 `crm_login` | CLI 通道死锁（连登录入口都进不去） | allowlist 显式包含 `initialize` + `tools/call[name=crm_login]`；验收项 12 专项覆盖 |
| HTTP 层闸只认 Bearer 头 | `crm-native-cli`（走 `api_token` 参数）全线失败 | 强制复用 `extractToken`（`src/mcp/auth.js:71`）双源解析 |
| `/mcp` 去 Basic 后暴露面变大 | 无凭据请求打到应用 | 应用层 `requireAuth` + HTTP 层 401 双闸；`/mcp` 仍需有效 token 才可达工具链 |
| 去掉 Basic 后出现异常探测 | 撞库/扫描 | 关注 Nginx access log；必要时追加 IP 白名单（既有预案） |
| release 覆盖 Nginx | 故障复现 | 本地模板与生产同内容修改，且 T5 后跑一次 release 复验 |
| OAuth 与 CLI token 互相吊销 | 间歇性掉线，难复现 | `issueMcpIdentity` 按颁发渠道收敛吊销范围（§7.1） |
| 公网无 HTTPS | OAuth 明文传输（token/code 可被中间人截获） | **已知遗留**：当前 origin 仅 80 端口。建议授权上线后优先补 certbot。IP 直连签发证书需域名，属独立议题 |

**回滚路径（两层，均可独立生效）**
1. 仅停 OAuth 闸：`MCP_CONFIG.oauth.enabled = false` → `/mcp` 恢复旧行为（工具层仍 `requireAuth`，安全性不塌）。
2. 完全回到旧架构：恢复 `nginx-crm.conf` 中 `/mcp` 的 `auth_basic` 两行 + `connector/*` 改回 `auth_mode: "token"` + 重发插件包。
3. 数据层无需回滚：3 张新表为纯增量，保留不影响任何既有查询。

---

## §12 后续（本期不做，记录以免遗忘）

1. **HTTPS**：`www.chiyuai.com` 已具备域名，走 certbot 签证书后，OAuth 才真正满足「授权码不得走明文」的规范要求。建议作为下一个独立 Task。
2. **授权服务器复用**：若 PDM / Agent2B 也要接 WorkBuddy，方案 C（授权服务器独立于资源服务器）的投入才划算。届时评估把 `oauth_client`/`oauth_code`/`oauth_refresh` 提升为平台级服务。
3. **`/userinfo` 与 ID Token**：当前不需要（access_token 已含足够身份信息），不做。
4. **旧 token 清理**：`crm.mcp_identity` 中历史 8h token 行会随时间累积（已软吊销但保留）。属既有问题（绝对禁删），保持现状。

---

### 实施阶段校准（2026-09-15，编写实施计划与编码时发现，已回写本文档）

本设计于 2026-09-15 获批后，在编写实施计划（`docs/superpowers/plans/2026-09-15-mcp-oauth.md`）与执行编码时共发现 4 处必须修正。四处均已回写至上文对应章节，此处集中留痕以便追溯：

| # | 原表述 | 校准后 | 落点 | 原因 |
|---|---|---|---|---|
| **C1** | `/oauth/authorize` POST 时铸 `mcp_identity` | **改在 `/oauth/token` 交换时铸** | §3.5、§3.6、§7.1 | 授权阶段铸出的 token 明文无法安全留到 token 端点返回——存明文违反「密钥永不落库」红线，不存则拿不到明文。改在 token 端点铸，还顺带消除「授权后不交换」产生的孤儿 token 行。 |
| **C2** | `oauth_code.identity_id` 列 | **删除该列** | §4 | 由 C1 派生：授权阶段不知道 `mcp_identity.id`，保留即为永不写入的死列（YAGNI）。 |
| **C3** | `crm_login` 渠道「吊销该 actor 其余**全部**未吊销 token」 | `crm_login` 渠道吊销该 actor 其余全部**非 oauth 渠道** token | §7.1 | 原文只对 oauth 侧收敛，`crm-cli auth login` 仍会静默踢掉 OAuth 会话（单向踩踏）。改后双向隔离；历史 token 经 `COALESCE` 仍被吊销，向后兼容。 |
| **C4** | `oauth_code` / `oauth_refresh` 的 `expires_at` 由应用层 `new Date(Date.now() + ttlMs)` 计算 | **改由 DB 时钟推进：`now() + ($n::bigint * interval '1 millisecond')`** | §4、§3.6 | **实测时钟偏差**：本机 PG 时钟比宿主 Node 时钟**快 139.26s**（Node `12:27:31Z` vs DB `12:29:50Z`）。写入用 Node 时钟、判定用 DB 时钟（`expires_at > now()`）时，TTL 被静默吃掉偏差量 → 60s 的 TTL「出生即过期」（T3 实测复现）。**写入与读取必须共用同一时钟（DB `now()`）**；偏差方向不可预测——DB 落后于 Node 时反会延长有效期，构成安全漂移。 |

> ⚠️ **C4 的越界说明**：`src/mcp/auth.js:145`（`mcp_identity` 的 access token TTL，Node 时钟写入）与 `auth.js:48`（`row.expires_at < new Date()`，Node 时钟判定）存在**同一类跨时钟比较**。但 8h TTL 下 139s 偏差仅占 1.5%，且改动会触碰既有回归基线。**本期不动**，作为独立发现记录，由用户决定是否单独立项。

**另有两处实施细节由计划补充，属实现层面、不改语义**（详见计划文档 §3.7 与 T10/T11）：
- `/mcp` HTTP 层闸必须复用 `extractToken` 取 token（同时覆盖 `params.api_token` 与 `Bearer` 头），只认 Bearer 头会打断 `crm-native-cli`。
- `initialize` 与 `tools/call[name=crm_login]` 必须在 HTTP 层闸的 allowlist 内（否则 CLI 无 token 连协议握手都过不去 → 登录入口死锁）。副作用：未授权客户端的首个 401 出现在 `tools/list` 而非 `initialize`，测试须据此断言，否则得恒假绿。

---

## 附录 A：证据索引

| 结论 | 证据位置 |
|---|---|
| Nginx 要求 Basic（根因 1） | `scripts/tencent-lighthouse-deploy/nginx-crm.conf:29-33` |
| 连接器强发 Bearer（根因 1） | `connector/mcp.json:8` |
| release 覆盖 Nginx 配置 | `scripts/tencent-lighthouse-deploy/deploy.sh:184-185` |
| `requireAuth` 在 tool-call 层非 HTTP 层（关键修正） | `src/mcp/gateway.js:149`、`:250`、`:322`；`src/mcp/config.js:26` |
| token 双源解析（CLI 依赖 `api_token`） | `src/mcp/auth.js:71-77`；`packages/crm-native-cli/src/commands/auth.js:38` |
| 账号体系与 admin 禁登 | `src/mcp/auth.js:129-142` |
| refresh 软吊销而非删除（agent 名册无干） | `src/mcp/auth.js:155-162` |
| `mcp_identity` 结构（access_token 复用） | `db/schema.sql:491-505` |
| 结构化 token 格式（O(1) 查表） | `src/mcp/tokenFormat.js:16-33` |
| 契约必需字段与校验规则 | `src/contract/contractParser.js:94`、`:112-131`、`:145` |
| intake-router 能力闭包 | `src/agent/agentSpec.js:8-12`；`src/agent/contractIds.js:16` |
| 客户端 OAuth 契约（发现链/DCR/PKCE/scheme） | WorkBuddy 客户端 asar 字符串 + `~/.workbuddy/connectors/*/.credentials.v3.json` 的 `mcpClientInfo` |
