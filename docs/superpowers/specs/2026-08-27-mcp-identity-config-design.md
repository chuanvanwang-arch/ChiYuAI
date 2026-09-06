# 连接器 / MCP 身份配置页（item 27）设计文档

> 状态：brainstorming 已批准 → 设计文档（待评审）→ writing-plans → 内联执行
> 日期：2026-08-27
> 范式：复用 RBAC / business-tier / approval-flow / alert-rule 同构（专属表 + 专属 Router + 专属 portal 模块 + 专属 HTML 页 + 决策第0闸 + 绝对禁删）

## §0 硬约束（已勘察，不可破）

- **唯一事实源** = `crm.mcp_identity`（`db/schema.sql:354`）。字段：
  `id uuid PK DEFAULT gen_random_uuid()` / `token_hash text UNIQUE NOT NULL` / `actor text NOT NULL` /
  `person_id uuid`（可空，真实身份，不强制 FK）/ `role_tag text NOT NULL FK→role_context_profile` /
  `scopes jsonb NOT NULL DEFAULT '{}'`（`{deny_domains:[...]}` 域级收窄）/ `expires_at timestamptz` /
  `enabled boolean NOT NULL DEFAULT true` / `created_at` / `revoked_at timestamptz`。
- **token 仅存哈希**（pgcrypto `crypt(token, gen_salt('bf'))`，`pgcrypto` 已启用 `schema.sql:7`），**明文永不出 node 进程到日志/响应**（除创建时一次性返回前端弹窗）。
- **绝对禁删**：吊销 = `revoked_at=now()` + `enabled=false`（软标记）。表注释与既有 `MCP_CONFIG.absoluteNoDelete:true` 共同印证。
- **`role_tag` 下拉值集动态来自 `crm.role_context_profile`**（`SELECT role_tag ... ORDER BY role_tag`，当前 6 角色：`sales/manager/exec/finance/presales/contract_admin`），**不可自由输入**（FK 约束 + 下拉源）。
- 写经**决策第0闸**，复用 RBAC/alert-rule 的 `produceDecision` 默认实现（`src/portal/approvalFlow.js:97` 镜像）。

## §1 后端 Router — 新建 `src/portal/mcpIdentity.js`

`createMcpIdentityRouter(deps = {})`，`router.handlers = { list, create, put }` 供注入式测试（沿用 RBAC/alert-rule 契约）。默认 deps：

```js
const defaultDeps = {
  list: async () => {
    const r = await query(
      `SELECT id, actor, person_id, role_tag, scopes, expires_at, enabled, revoked_at
         FROM crm.mcp_identity ORDER BY created_at DESC`);
    const roles = await query(`SELECT role_tag FROM crm.role_context_profile ORDER BY role_tag`);
    return { rows: r.rows, roles: roles.rows.map((x) => x.role_tag) };
  },
  create: async ({ actor, person_id, role_tag, scopes, expires_at }) => {
    const tokenPlain = (deps.genToken || defaultGenToken)();   // crypto.randomBytes(24).toString('hex')
    const tokenHash = (deps.hashToken || defaultHashToken)(tokenPlain); // crypt(token, gen_salt('bf'))
    const r = await query(
      `INSERT INTO crm.mcp_identity (token_hash, actor, person_id, role_tag, scopes, expires_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6) RETURNING id, actor, role_tag, enabled, revoked_at`,
      [tokenHash, actor, person_id || null, role_tag, JSON.stringify(scopes || {}), expires_at || null]);
    return { row: r.rows[0], token_plaintext: tokenPlain };
  },
  put: async (id, patch) => {
    const r = await query(
      `UPDATE crm.mcp_identity SET actor=$2, role_tag=$3, scopes=$4::jsonb,
        enabled=$5, expires_at=$6, revoked_at=$7 WHERE id=$1
       RETURNING id, actor, role_tag, enabled, revoked_at`,
      [id, patch.actor, patch.role_tag, JSON.stringify(patch.scopes || {}),
       patch.enabled !== false, patch.expires_at || null, patch.revoked_at || null]);
    return r.rows[0];
  },
  produceDecision: async (ctx) => {
    try {
      const r = await requireDecision('config-change', ctx || {});
      return { decisionId: r.decision_id || null, ok: !!r.decision_id };
    } catch {
      await recordDecisionEvent('config_change', { trigger_context: ctx });
      return { decisionId: null, ok: true };
    }
  },
};
```

端点：

- `GET /api/mcp-identities` → `list()`，响应 `{ rows, roles }`。**`rows` 不含 `token_hash` 原文**（安全，仅状态字段）。
- `POST /api/mcp-identities` → 校验 `actor`（非空）/ `role_tag`（非空）；`create()` 生成 token + 落库；写经决策第0闸；响应 `{ id, token_plaintext }`（**明文仅此一次**）。
- `PUT /api/mcp-identities/:id` → 编辑 `actor/role_tag/scopes/enabled/expires_at`；**吊销**=`revoked_at=now()` + `enabled=false`（前端「吊销」按钮置 `revoked_at`）；写经决策第0闸。
- **无 `DELETE`**（绝对禁删）；未知 `id` → 404。

导入：
```js
import { Router } from 'express';
import { query } from '../db.js';
import { requireDecision } from '../decision/autonomyEngine.js';
import { recordDecisionEvent } from '../decision/decisionRepo.js';
import { randomBytes } from 'crypto';
```

## §2 渲染 + 页面

- `renderMcpIdentities(list, roles)` → 行（actor / role_tag 下拉 / scopes 摘要 / 状态徽标[启用/已吊销/过期] / 过期时间 / 操作[编辑/吊销]）。
- `mcpIdentitySummary(list)` → 总数 / 启用数 / 已吊销数。
- `roleOptions(roles)` → `role_tag` 下拉 `<option>`。
- `src/web/mcp-identities.html`：拉取 `/api/mcp-identities` → 渲染表格 + 行内编辑（actor / role_tag 下拉 / scopes JSON 文本框[域级收窄] / enabled / expires_at）+ 「新增身份」按钮（弹窗填 actor/role_tag/scopes/过期 → POST → 一次性展示 `token_plaintext` 并提示"请妥善保存，关闭不可恢复"）+ 行「吊销」软标记 + 保存 PUT（决策闸）。纯前端、无轮询（与 approval-flow/alert-rule 同构）。

## §3 routes.js 挂载

```js
import { createMcpIdentityRouter } from '../portal/mcpIdentity.js';
// ...
app.use(createMcpIdentityRouter({}));
app.get('/mcp-identities', (req,res)=> res.sendFile(fileURLToPath(new URL('../web/mcp-identities.html', import.meta.url))));
app.get('/mcp-identities.html', (req,res)=> res.sendFile(...'../web/mcp-identities.html'...));
app.get('/portal/mcpIdentity.js', (req,res)=> res.sendFile(...'../portal/mcpIdentity.js'..., { headers: { 'Content-Type': 'text/javascript' } }));
```

## §4 配置中心

第 27 项 `pending→ready`：
```js
{ id: 27, name: '连接器/MCP 配置', group: '集成', status: 'ready', page: '/mcp-identities.html', endpoint: '/api/mcp-identities', note: 'crm.mcp_identity 身份绑定，零信任 token 哈希' },
```

## §5 测试（TDD 红→绿）

- 渲染 ~7 例（`test/web/mcpIdentity.test.js`）：列表 / 角色下拉 / scopes 摘要 / 状态徽标[启用/已吊销/过期] / 概要 / 无 token 泄露。
- handler ~7 例（注入 deps 免 DB）：
  - `list` 返回 rows+roles、不含 token_hash；
  - `create` 生成 token + 落库 + 决策闸、返回 `token_plaintext`；
  - `create` 缺 actor → 400；
  - `put` 编辑生效 + 决策闸；
  - `put` 吊销置 revoked_at + enabled=false；
  - **无 DELETE**（router.handlers 无 delete 键）；
  - 未知 id → 404。

## §6 已知限制（写入 spec + 页面 note）

- **token 明文仅创建时返回一次，不可恢复**（安全设计，非缺陷）；遗失须吊销旧身份 + 新建。
- 初始**空列表、无 seed**（保持零信任，避免 token 哈希落脚本）。
- **绝对禁删**；吊销 = 软标记。
- `person_id` 为可选真实身份外键（CRM_PERSON / crm_users），本页不强制绑定。

## §7 验收

- `test/web/` 全绿（基线 80 + ~14 = 94）；`/mcp-identities` 可列 / 增 / 编 / 吊销；写经决策闸；无 DELETE；token 明文不外泄列表。
- `routes.js` 加载 OK。

## §8 范围边界（不做）

- 不改 MCP server 运行态（token 校验已有 `src/mcp/server.js` 消费 `mcp_identity`，本页仅配置）；
- 不实现 token 明文找回/重置（仅吊销+重建）。

## §9 交付物清单

- `src/portal/mcpIdentity.js`（新）：渲染纯函数 + `createMcpIdentityRouter` + `defaultDeps`
- `src/web/mcp-identities.html`（新）
- `src/http/routes.js`（改）：import + mount + 页路由 + 模块挂载
- `src/portal/configCenter.js`（改）：第 27 项 ready
- `test/web/mcpIdentity.test.js`（新，~14 例）
- 设计 `docs/superpowers/specs/2026-08-27-mcp-identity-config-design.md` + 计划 `docs/superpowers/plans/2026-08-27-mcp-identity-config.md`

## §10 自审

- 无占位符；§0 约束与 §1-§5 一致（绝对禁删贯穿 Router/测试/页）。
- 决策第0闸默认实现精确镜像 `approvalFlow.js:97`；`requireDecision`/`recordDecisionEvent` 导入路径沿用已验证范式。
- `role_tag` 动态来自 `role_context_profile`，规避硬编码 5/6 角色不一致。
- token 安全：create 返回明文一次、list 不返回 hash、落库仅 hash —— 三处一致。
- 类型一致：`create` 返回 `{row, token_plaintext}`，测试断言对称。
- 范围单计划可覆盖（7 Task）。
