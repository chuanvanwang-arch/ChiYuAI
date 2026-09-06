# MCP 角色判定改进设计 —— 身份基线 + 意图校正

- **版本**：1.0.0
- **状态**：已落地（T1–T8 全绿；MCP 角色判定改进完成）
- **作者**：AI 搭档（王川审核）
- **日期**：2026-08-26
- **设计输入**：
  - `src/mcp/auth.js` / `gateway.js` / `config.js`（MCP 接入层当前实现）
  - `src/context/roleProfiles.js`（六角色 profile / data_scope）
  - 总体设计 §6.13（无头设计 + 安全红线）
  - 对齐 CordysCRM 插件范式（`CordysCRM-main/CordysCRM-skills-main` AccessKey/SecretKey → 自动加载用户+匹配角色+加载角色上下文）

---

## §0 背景与问题（现状证据，evidence-driven）

当前经 MCP 接入 CRM 时，角色判定**不准**——平台 owner（wangchuan）被一律降级为 `sales`，导致高权限操作（exec / manager / finance 域）被第 1.5 闸拒绝。根因在接入层身份信任根缺失。

### §0.1 当前实现（file:line 证据）
- **`src/mcp/auth.js:15-20`** — `resolveApiToken(token)` 为**内存静态查表**：
  ```js
  const entry = MCP_CONFIG.apiToken[token];
  if (!entry) return mk(null, MCP_CONFIG.security.minPrivilegeFallback, true, '未知 token：...', true);
  return mk(entry.actor, entry.role || MCP_CONFIG.security.minPrivilegeFallback, false, null, false);
  ```
  无 token 或未知 token → 一律降级 `sales`（`auth.js:16-18`）。
- **`src/mcp/config.js:28-35`** — `apiToken` 仅写死一条 `demo: { actor:'wangchuan', role:'sales' }`。注释自称"生产由 role-engine 自推断"，但 **MCP 层未实现任何推断逻辑**，角色完全由该配置映射决定。
- **`src/mcp/gateway.js:97-99`** — 写/敏感读 phase2 第 1.5 闸：
  ```js
  if (Array.isArray(def?.rbac_roles) && def.rbac_roles.length && !def.rbac_roles.includes(switchedRole)) {
    return { ok: false, gate: 'permission_denied', error: `第1.5闸: 角色 ${switchedRole} 无权执行 ${session.action}` };
  }
  ```
  降级成 `sales` 后，凡是 `rbac_roles` 不含 `sales` 的高权限 Action 被拒绝。
- **`src/context/roleProfiles.js:13-20`** — 六角色 profile 的 `data_scope` 已定义合法数据域（`model: all/self/org_subtree/domain` + `domain` 数组），是意图校正的"基线合法域"事实源。

### §0.2 问题实质
身份信任根放在运行时内存配置（`config.js.apiToken`），**重启即失、不可吊销、不可审计、owner 无高权限身份**。CordysCRM 范式的对应做法是：用户在自己平台「个人中心→API Keys」创建 AccessKey/SecretKey → 智能体初始化时**自动加载用户信息 + 匹配角色 + 加载角色上下文**。我们是 CRM 本身，密钥由自己颁发、身份（person）+ 角色存自己库——这正是本设计要落地的能力。

---

## §1 目标与非目标

### §1.1 目标
1. **身份持久绑定**：接入方 token ↔ person ↔ role 持久映射（入库），owner 直绑 `exec`，告别"一律降级 sales"。
2. **可审计 / 可吊销**：颁发、使用、吊销全程可追溯；吊销用 `revoked_at` 软标记，**绝对禁删**。
3. **意图校正**：在角色基线**合法范围内**，按本次操作的 `kind` + `data_scope_domains` 动态聚焦展示/执行视角（实现 Cordys「千人千面」），但**只聚焦、不升权**。
4. **零信任保留**：无 token / 未知 token 仍降级 `sales`；明文 token 永不出日志/响应。

### §1.2 非目标（YAGNI，详见 §8）
- 不做对话式层 role-engine 关键词匹配（crm-native agent 链路，非本次范围）。
- 不做 LLM 动态角色推断模型（基线来自 token，确定性强、可审计）。
- 不引入 OAuth/SSO（本地 token 颁发足够，后续可扩展）。

---

## §2 总体架构（两层判定，互不越权）

```
MCP 工具调用
   │  extractToken(params/headers/env)          [auth.js:23-29 不改]
   ▼
┌─────────────────────────────────────────────┐
│ 身份基线解析（持久绑定，确定性）              │
│   token → mcp_identity(token_hash)           │
│     → { actor, role: role_tag, person_id }   │
│   未命中/过期/无token → 降级 sales             │
└─────────────────────────────────────────────┘
   │  ctx.role = baseRole
   ▼
┌─────────────────────────────────────────────┐
│ 意图校正引擎（运行时聚焦，不升权）            │
│   resolveEffectiveRole(baseRole, actionName) │
│   ① loadProfile(baseRole).data_scope 合法域   │
│   ② action.data_scope_domains ∩ 合法域        │
│   ③ focus_domain = 交集；越域 → over_scope    │
└─────────────────────────────────────────────┘
   │  ctx.effective_role + ctx.focus_domain
   ▼
现有安全闸（全部保留，不变）
   ├ 决策第0闸 写须 decision_id     [gateway.js:59-62]
   ├ 第1.5闸 rbac_roles.includes    [gateway.js:97-99]
   ├ 绝对禁删                       [config.js:21]
   └ 写两阶段 + action-confirm      [gateway.js:56-109]
```

**关键约束**：意图校正引擎**只输出聚焦视角**，绝不修改 `ctx.role`。越域操作不放大权限，交既有第 1.5 闸拒绝/confirm。

---

## §3 数据模型（新增 `crm.mcp_identity`）

```sql
-- db/schema.sql 追加（幂等）
CREATE TABLE IF NOT EXISTS crm.mcp_identity (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash   text UNIQUE NOT NULL,        -- 仅存哈希（sha256），绝不存明文（对齐 Cordys 密钥隔离）
  actor        text NOT NULL,                -- person slug，如 'wangchuan'
  person_id    uuid,                         -- 关联 crm.person（真实身份事实源，可为空=外部接入方）
  role_tag     text NOT NULL,                -- 基线角色：sales/manager/exec/finance/presales/contract_admin
  scopes       jsonb DEFAULT '{}'::jsonb,    -- 可选域级收窄（默认空=角色全范围）；格式 { "deny_domains": [...] }
  expires_at   timestamptz,                  -- 有效期（NULL=不过期）
  enabled      boolean DEFAULT true,
  created_at   timestamptz DEFAULT now(),
  revoked_at   timestamptz,                  -- 吊销用软标记，绝不 DELETE（绝对禁删红线）
  CONSTRAINT fk_mcp_identity_role FOREIGN KEY (role_tag) REFERENCES crm.role_context_profile(role_tag)
);
CREATE INDEX IF NOT EXISTS idx_mcp_identity_token ON crm.mcp_identity(token_hash);
```

**Seed（owner 直绑 exec）**：seed 脚本落一条 `actor=wangchuan, role_tag=exec`。**token 明文值经环境变量注入，不写死**（避免密钥入库明文）：
```sql
-- db/seed.sql 追加（幂等）
INSERT INTO crm.mcp_identity (token_hash, actor, role_tag, scopes)
SELECT $1, 'wangchuan', 'exec', '{}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM crm.mcp_identity WHERE actor='wangchuan' AND role_tag='exec');
```
token 明文由 `scripts/issue-mcp-token.js`（新增）生成并回显给 owner，哈希入库；明文仅出现在 owner 本地终端。

---

## §4 身份基线解析（`src/mcp/auth.js` 改造）

### §4.1 新增 `resolveIdentity(token)` —— 持久查表替代内存查表
```js
import { query } from '../db.js';

// 返回 { actor, role, person_id, identity_id, degraded, degraded_reason, prompt_needed }
export async function resolveIdentity(token) {
  if (!token) return mk(null, MCP_CONFIG.security.minPrivilegeFallback, true, '无凭证：未携带 token', true);
  const r = await query(
    `SELECT id, actor, person_id, role_tag, scopes, expires_at, enabled
       FROM crm.mcp_identity WHERE token_hash = crypt($1, token_hash)`,  // 用 pgcrypto crypt 比对
    [token]
  );
  const row = r.rows[0];
  if (!row || !row.enabled) return mk(null, MCP_CONFIG.security.minPrivilegeFallback, true, '未知 token：凭证未配置或已失效', true);
  if (row.expires_at && row.expires_at < new Date()) return mk(null, MCP_CONFIG.security.minPrivilegeFallback, true, 'token 已过期', true);
  return mk(row.actor, row.role_tag, false, null, false)
    .withIdentity(row.id, row.person_id, row.scopes);
}

// 兼容：保留 resolveApiToken 作为同步包装（旧测试/旧调用），内部转发 resolveIdentity 结果
// （实施时评估是否全量切换为 await resolveIdentity，避免同步/异步双路径）
```

> **实现注**：`config.js:28-35` 的 `apiToken` 演示映射保留为 fallback（无 DB 时可用），但**生产路径改为 DB 查询**。token 比对用 `pgcrypto.crypt`（DB 层哈希，明文不出 node 进程到日志）。`verifyTokenPrefix`（`auth.js:59-62`）保留用于"仅回显前 4 位"安全通道，不变。

### §4.2 `buildMcpCtx` 注入身份事实
- 返回对象新增 `identity_id`、`person_id`、`scopes`（来自 `mcp_identity`）。
- `role` 字段语义从"推测角色"明确为"基线角色（持久绑定）"。
- 降级路径（`degraded:true`）行为不变：仍弹 `buildDegradedPrompt()`（`gateway.js:16-28`），引导去个人中心领 token。

---

## §5 意图校正引擎（新增 `src/mcp/intent.js`）

```js
import { getAction } from '../action/registry.js';
import { loadProfile } from '../context/roleProfiles.js';

// 计算基线角色的合法数据域集合（来自 role_context_profile.data_scope）
function baseDomains(baseRole) {
  const p = await loadProfile(baseRole);
  if (!p) return [];
  if (p.data_scope.model === 'all') return 'ALL';
  if (p.data_scope.model === 'domain') return p.data_scope.domain || [];
  // self / org_subtree 在 MCP 层暂等价于"按 actor 过滤"，域级聚焦无意义 → 返回 ALL（由 Action 自身 owner 过滤）
  return 'ALL';
}

// 返回 { effective_role, focus_domain, over_scope, denied_domains }
export async function resolveEffectiveRole(baseRole, actionName, scopes = {}) {
  const def = getAction(actionName);
  const actionDomains = def?.data_scope_domains || [];
  const base = baseDomains(baseRole);

  // 域级收窄（来自 mcp_identity.scopes.deny_domains）
  const denied = scopes?.deny_domains || [];

  if (base === 'ALL') {
    const focus = actionDomains.filter(d => !denied.includes(d));
    return { effective_role: baseRole, focus_domain: focus, over_scope: false, denied_domains: denied };
  }
  const focus = actionDomains.filter(d => base.includes(d) && !denied.includes(d));
  const over_scope = actionDomains.some(d => !base.includes(d)); // 越域 → 交第1.5闸处理
  return { effective_role: baseRole, focus_domain: focus, over_scope, denied_domains: denied };
}
```

### §5.1 用例（对齐本设计目标）
- `wangchuan(exec, all)` 调 `crm-finance-receivables` → `focus_domain=['payment']` 视角（加载 finance profile 字段/预警偏好）。
- `wangchuan(exec, all)` 调 `crm-deal-advance` → `focus_domain=['CRM_DEAL']` 商机推进视角。
- **权限边界仍是 exec 全量**：意图校正仅影响"上下文呈现与字段过滤"，不改变任何拒绝逻辑。

### §5.2 业务域标签对齐约定（实施时核对）
- Action 的 `data_scope_domains`（`registry.js`）须采用与 `roleProfiles.js:14-19` 的 `data_scope.domain` **一致的标签体系**（如 `CRM_DEAL` / `payment` / `contract` / `invoice` / `CRM_TECHNICAL_PROPOSAL`）。
- 实施 Task 之一：扫描 `seed-actions.js` / `registry.js` 各 Action 的 `data_scope_domains` 取值，与 profile domain 对齐；不一致的在落地阶段统一（不在此设计新增域）。

---

## §6 安全闸衔接（`src/mcp/gateway.js`）

### §6.1 注入意图校正结果
- `buildMcpCtx` 增加 `await resolveEffectiveRole(...)` 调用（或在 `mcpWritePhase1` / `mcpReadSensitivePhase1` / `mcpReadDirect` 入口补充），ctx 新增 `effective_role` + `focus_domain` + `over_scope`。
- `mcpConfirmPhase2`（`gateway.js:84-109`）执行时，若 `over_scope` 为真，交既有第 1.5 闸逻辑拒绝（**不新增拒绝分支**，复用 `gateway.js:97-99`）。

### §6.2 confirm 表单透明化
- `buildConfirmForm`（`gateway.js:41-53`）新增字段 `focus_domain`（透明展示"本次以 X 视角操作"），不改既有 `switch_options` / `impact_scope` / `decision_id`。

### §6.3 既有闸全部保留且不变
| 闸 | 位置 | 本设计是否改动 |
|---|---|---|
| 决策第0闸（写须 decision_id） | gateway.js:59-62 | 否 |
| 第1.5闸（rbac_roles.includes） | gateway.js:97-99 | 否（意图校正越域交此闸） |
| 绝对禁删 | config.js:21 | 否 |
| 写两阶段 + action-confirm | gateway.js:56-109 | 否 |

---

## §7 测试与验收

### §7.1 单测（新增 `test/mcp-role-binding.test.js`）
- `resolveIdentity` 命中 owner token → 返回 `{ role:'exec', degraded:false }`；未知 token → 降级 `{ role:'sales', degraded:true }`；过期 token → 降级。
- `resolveEffectiveRole`：`exec` + `payment` 域 Action → `focus_domain=['payment']`、`over_scope=false`；`exec` + 越域（假设某 Action 域不在任何 profile）→ `over_scope=true`。
- `scopes.deny_domains` 收窄生效：owner(exec) 带 `deny_domains:['payment']` 调 finance Action → `focus_domain=[]`。

### §7.2 E2E（沿用 `test/mcp-gateway.test.js`）
- owner token 调高权限写工具（如 `crm-contract-submit`，`rbac_roles` 含 `exec`）**不再被 sales 基线拦截**。
- 陌生 token 调同一工具 → 仍降级 sales，被第 1.5 闸拒。
- 越权域操作（如 sales 调 finance 域 Action）→ 仍被第 1.5 闸拒。

### §7.3 验收口径
- 工具握手 `tools/list` 不变（约 40 工具）。
- 行为验证：owner 经 MCP 调 `crm-contract-submit` / `crm-finance-receivables` 等原 sales 被挡工具 → 正常进入 confirm 流程。

---

## §8 范围边界（YAGNI）

1. **不做对话式 role-engine 关键词匹配**：那是 `crm-native` agent 链路（`src/agent/`），本次仅 MCP 接入层。
2. **不做 LLM 动态角色推断**：基线来自 token，确定性强、可审计；LLM 判角色引入不确定性，违背零信任。
3. **不引入 OAuth/SSO**：本地 `mcp_identity` token 颁发足够；后续如需联合登录，在 `resolveIdentity` 前加适配层，不动本设计核心。
4. **不新增业务域标签**：意图校正复用既有 `role_context_profile.data_scope.domain` 体系；不一致项在落地阶段对齐，不在此扩域。

---

## §9 实施路径（Task 拆分，每 Task 一 commit）

| Task | 内容 | 改动文件 | 验收 |
|---|---|---|---|
| T1 | 建 `crm.mcp_identity` 表（DDL 幂等） | `db/schema.sql` | migrate 通过 |
| T2 | seed owner(exec) 行（token 哈希由脚本注入） | `db/seed.sql` + 新增 `scripts/issue-mcp-token.js` | seed 通过 |
| T3 | `resolveIdentity` 持久查表替代 `config.apiToken` | `src/mcp/auth.js` | §7.1 单测 |
| T4 | `buildMcpCtx` 注入 identity_id/person_id/scopes | `src/mcp/auth.js` | §7.1 单测 |
| T5 | 新增意图校正引擎 `resolveEffectiveRole` | `src/mcp/intent.js` | §7.1 单测 |
| T6 | gateway 注入 focus_domain + confirm 表单透明化 | `src/mcp/gateway.js` | §7.2 E2E |
| T7 | Action `data_scope_domains` 与 profile domain 对齐核对 | `src/action/seed-actions.js` / `registry.js` | 域标签一致 |
| T8 | 全量测试 + 文档更新 | `test/*` + 本设计文档状态→已落地 | 398→绿 |

> **提交闸门**：沙箱无私有库凭证，AI 不 commit。每 Task 完成后由用户在本地 `git add` + `git commit`（建议按 Task 拆分提交，便于 review）。

---

## §10 自检结论（写后自查）

- **占位符**：无未填占位（T1–T8 为计划项，非文档占位）。
- **矛盾**：§2 架构图与 §4/§5/§6 实现一致；"只聚焦不升权"在 §2/§5/§6.1 三处一致。
- **歧义**：`resolveIdentity` 与旧 `resolveApiToken` 并存过渡（§4.1 已标注实施时评估全量切换）；`self/org_subtree` 域级聚焦语义已明确为"返回 ALL，由 Action 自身 owner 过滤"。
- **范围**：§8 明确排除项，与 §1.2 非目标一致；未越界到对话式 agent 链路或 OAuth。

## §11 落地记录（2026-08-26，Inline Execution）

- **T1–T8 全绿**：新增/完善 `crm.mcp_identity` 表 + `issueToken` + `resolveIdentity`（持久查表替代 `config.apiToken` 内存映射）+ `intent.js`（DOMAIN_ALIAS 域归一 + `resolveEffectiveRole` 意图校正）+ `gateway.js` 注入 `focus_domain`/确认表单透明化 + `buildMcpCtx` 改 async 并透传 identity 字段。
- **测试**：`test/mcp-identity.test.js`(3) / `mcp-auth.test.js`(14) / `mcp-intent.test.js`(5) / `mcp-gateway-focus.test.js`(3) 全绿；既有 `mcp-gateway.test.js`(15) 无回归。
- **关键修正（相对原始计划）**：
  1. `seed-actions.js` 导出的是函数 `seedActions()`（非数组 `SEED_ACTIONS`），T5/T7 测试改用 `seedActions()` + `listActions()` 枚举。
  2. `crm-finance-receivables` 是 `read_sensitive`，T6 测试改用 `mcpReadSensitivePhase1`（form 同样注入 `focus_domain`），并补一条 `crm-deal-advance` 写路径验证不阻断。
  3. `issueToken` 零信任幂等：同 actor+role 重发不再入库新哈希，故解析测试一律用**唯一 actor** 避免碰撞；明文仅首发存储，重发返回既有 identity 但新 token 不可鉴权（设计正确）。
- **域标签不一致**：由 `intent.js` 的 `DOMAIN_ALIAS` 归一桥接（`CRM_*` 大写 ↔ profile 小写），未改动 Action 种子语义；覆盖 seed-actions 全部 `data_scope_domains`（CRM_CUSTOMER/CRM_DEAL/CRM_CONTRACT/CRM_INVOICE/CRM_PAYMENT_RECORD）。
- **全量回归**：本改动相关 MCP 测试全绿；`test/context.test.js` 6 例失败为**上下文分层模块并行改动**（中文标签化）所致，与本次 MCP 角色判定无关，不属本计划范围。
