# 设计：MCP / 外部智能体首次接入强制「用户名 + 密码」验证

> 日期：2026-08-29 · 关联：`src/mcp/**` · 安全红线：零信任 / 最小权限 / 绝对禁删
> 触发：用户要求「企业AI销售决策专家」首次被外部智能体接入时，必须以用户名 + 密码验证（不再免登录降级放行）。

## 0. 结论速览

当前 MCP Server（`3001 /mcp`，stdio + StreamableHTTP，`src/mcp/server.js`）对外「无需登录即可被办公智能体调用」：
无凭证请求经 `resolveIdentity`（`src/mcp/auth.js:19-34`）降级为 `minPrivilegeFallback='sales'`，
读工具 `mcpReadDirect`（`src/mcp/gateway.js:126-137`）**直接 dispatch 只读工具 → 匿名只读放行**；
写 / 敏感读虽走 confirm，但降级仅软提示不硬阻断。

**修改为**：新增 `crm_login(username, password)` MCP 工具（登录入口，无需已有 token）；
所有业务工具在无有效凭证时**硬拒绝**（`gate:'auth_required'`），不再降级 sales 放行。

## 1. 方案（推荐 A：用户名密码登录 + 网关硬拒绝）

### 1.1 新增 MCP 工具 `crm_login`（登录入口）
- 注册位置：`src/mcp/tools.js` 的 `buildMcpTools` 增加 `authTools`（不在 Action Registry，绕过 action dispatch）；
  `src/mcp/server.js` 单独注册，调用方无需携带 token 即可调用。
- 入参：`{ username, password }`。
- 逻辑（在 `src/mcp/auth.js` 新增 `mcpLogin({username,password})`）：
  1. 查 `crm.crm_users`（username / password_hash / role / display_name / enabled）；缺账号 → 拒绝。
  2. 校验 `SELECT crypt($1,$2)=$2`（复用 `src/http/auth.js:39` 同款 pgcrypto 比对）；密码错 → 拒绝。
  3. `enabled=false` → 拒绝（账号禁用软标记，`db/schema.sql:89`）。
  4. **`role='admin'` → 拒绝**，返回明确提示：
     `admin 仅限 HTTP 后台；请以业务账号（sales/manager/presales/exec/finance/contract_admin）登录 MCP`。
     原因：① `role_context_profile` 仅有 6 个业务角色（`src/context/roleProfiles.js:14-19`），无 `admin`，
     `mcp_identity.role_tag` 有外键 `fk_mcp_identity_role` 指向它（`db/schema.sql:381`），写 `admin` 必 FK 违反；
     ② 零信任 / 最小权限——MCP 是对外业务通道，admin 系统配置权限不在此暴露。
  5. 每次登录**颁发新 token**：`randomBytes(24).toString('hex')` 明文 → `pgcrypto crypt` 入库 `crm.mcp_identity`
     （actor=username, role_tag=role, scopes={}, expires_at=now+`tokenTtlMs`）；
     并软吊销该 actor 旧未吊销 token（`UPDATE ... SET revoked_at=now() WHERE actor=$1 AND revoked_at IS NULL AND id<>$2`），
     保持身份表整洁、避免明文外泄堆积。
  6. 返回 `{ ok:true, token:<明文>, role, display_name }`；**明文 token 仅本次返回**（哈希不可逆，库无明文可回读）。
- 不与 `issueToken`（`src/mcp/issueToken.js`）的幂等分支混用（幂等对已存在身份不返回明文，登录场景不适用）。

### 1.2 网关硬拒绝（4 个入口）
`src/mcp/gateway.js` 的 `mcpReadDirect` / `mcpReadSensitivePhase1` / `mcpWritePhase1` / `mcpConfirmPhase2`
在 `buildMcpCtx` 后判定：若 `MCP_CONFIG.security.requireAuth && ctx.degraded` → 返回
```js
{ ok:false, gate:'auth_required',
  error:'首次接入请先调用 crm_login(username,password) 完成用户名密码验证',
  hint:'crm_login 返回的 token 于后续工具调用携带：api_token=<token> 或 Authorization: Bearer <token>' }
```
**不 dispatch**（彻底取代「降级 sales 只读放行」）。

### 1.3 配置开关
`src/mcp/config.js` 的 `security` 新增 `requireAuth: true`：
- `true`（默认）：无有效凭证 → 硬拒绝（本需求）。
- `false`：回退到原降级 sales 放行（保留开关便于演示/回滚，向后兼容）。
- `minPrivilegeFallback` 保留（仅 `requireAuth=false` 时生效）。

### 1.4 文档 / 专家说明
- `crm-native-agent` 专家说明（plugin 内 `crm-native.md`）「无需登录即可被办公智能体调用」改为
  「首次接入须 `crm_login(username,password)` 用户名密码验证，之后持 token 调用」。
- 新增 MCP 接入 quickstart：① `crm_login` 取 token → ② 后续工具携带 `api_token` / `Bearer`。

## 2. 代码改动点（file:line 证据）

| 文件 | 位置 | 改动 |
|---|---|---|
| `src/mcp/auth.js` | 末尾 | 新增 `mcpLogin({username,password})`：校验 crm_users + 颁发 mcp_identity 新 token（软吊销旧） |
| `src/mcp/tools.js` | `buildMcpTools` | 增加 `authTools`（crm_login，inputSchema `{username,password}`） |
| `src/mcp/server.js` | `createMcpServer` | 注册 crm_login 工具（免 token 可调用） |
| `src/mcp/gateway.js` | `mcpReadDirect:126` / `mcpReadSensitivePhase1:78` / `mcpWritePhase1:58` / `mcpConfirmPhase2:92` | 增加 `requireAuth && ctx.degraded → auth_required` 硬拒绝分支 |
| `src/mcp/config.js` | `security` | 新增 `requireAuth: true` |
| 专家说明 `crm-native.md` | 对外接入 | 更新为「需 crm_login 验证」+ quickstart |

## 3. 测试影响与修复

- `test/mcp-gateway.test.js:73` `mcpReadDirect('data-particle-read', {}, {})` 空 headers → 改为注入有效 token 再调用；
  新增断言：无凭证 → `gate==='auth_required'`（requireAuth 默认开）。
- `test/mcp-auth.test.js`：`resolveIdentity` 降级语义（`degraded=true`）保留不变；新增「requireAuth 下 gateway 拒绝」测试。
- 新增 `test/mcp-login.test.js`：成功 / 密码错误 / 账号禁用 / admin 拒绝 / 返回 token 可续读。
- `tmp/mcp-role-e2e.mjs` 等端到端脚本：改为先 `crm_login` 拿 token 再读。

## 4. 风险与回滚

- 风险：现有未带凭证的办公智能体调用将被拒 → 需改为先 `crm_login`。这是本需求的预期行为。
- 回滚：`MCP_CONFIG.security.requireAuth=false` 即恢复降级 sales 放行（开关保留）。
- 安全：明文 token 仅 `crm_login` 返回一次；库仅存 crypt 哈希；吊销走 `revoked_at` 软标记（绝对禁删）。

## 5. 验收口径

1. 无凭证调用任意 MCP 工具 → `gate:'auth_required'` 拒绝（读/写/敏感读一致）。
2. `crm_login(正确业务账号)` → 返回 token → 持 token 可读 / 写。
3. `crm_login(admin)` → 拒绝并提示用业务账号。
4. `crm_login(错误密码)` / 禁用账号 → 拒绝。
5. `requireAuth=false` 时恢复降级放行（回滚验证）。

## 6. 默认决策（如需调整请告知）

- **D1 admin 经 MCP**：默认不允许（FK + 最小权限）；若需允许，需给 `role_context_profile` 增 `admin` 角色（data_scope=all）。
- **D2 开关**：保留 `requireAuth`，默认 `true`。
- **D3 token 生命周期**：每次登录发新 token + 软吊销旧。
