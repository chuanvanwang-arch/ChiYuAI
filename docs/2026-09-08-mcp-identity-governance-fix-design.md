# MCP 身份签发治理缺陷修复设计（五项）

- 日期：2026-09-08
- 状态：**已批准**（用户 2026-09-08 回「同意」；两项偏离评审均认可：T5 不砍菜单 / 系统级 TAB 显占位名）→ 实施计划已产出 `docs/2026-09-08-mcp-identity-governance-fix-plan.md`
- 触发：用户报告「建立用户是 sysadmin，无法通过登录平台获取 API，管理员也无法在平台查看，变成死循环」
- 已批准前置决策：
  - 范围 = **五项**（四项既定 + 新查出的 D5）
  - sysadmin 权限口径 = **C（收紧，不放宽后端 level 闸）**
- 设计输入（既有已批准文档，本设计不得违背）：
  - `docs/2026-09-06-rbac-role-permission-fix-design.md`（§15 权限重分组；admin 禁领 token 为设计意图）
  - `docs/2026-09-05-my-api-keys-self-service-design.md`（自助白名单排除平台级角色；管理通道假定 admin 全权）
  - `docs/specs/2026-09-05-ui-authoring-rules.md`（UI 页面写作铁律）

---

## §0 摘要（结论先行）

用户遇到的「死循环」是**代码级必然**，但根因与初判完全不同。真相三句话：

1. **sysadmin 在平台 Web 侧确实全断**：菜单让它进 `/config`（这是对的，它有 14 个租户级配置面），但系统级 TAB 仅 ADMIN 可见 → 它永远看不到 #27「连接器 / MCP 配置」；直连页面也会被后端 ADMIN 闸 403。而系统**没有任何文案告诉它替代通路**。
2. **管理通道存在可复现提权链**：`PUT /api/mcp-identities/:id` 因路径多一段而逃出全局闸，且 handler 零角色校验 → 任意 `sales` 用户可把自己的 key 改成 `sysadmin`，绕过 `SELF_ROLES` 白名单拿到治理写权限。
3. **管理页的吊销按钮从来没成功过，编辑按钮会复活已吊销 token**：`put` 是「假 PATCH 实为全覆盖 UPDATE」，且该缺陷被单测 mock 完整遮蔽（L2 假绿）。

本设计修 5 项，其中 **T1/T2 为 P0 安全**，必须优先。

### §0.1 三处初判纠正（诚实记录，避免后续再被误导）

| # | 初判（错） | 实际（代码级证实） | 证据 |
|---|---|---|---|
| 1 | `list`/`create`/`put` 三者均零角色校验 | 只有 `put` 漏。`createConfigLevelGate` 用 **`req.path` 精确等值**匹配 `endpoint`，`GET/POST /api/mcp-identities` 命中 → 被 ADMIN-only 兜住；`PUT /api/mcp-identities/:id` 多一段 → 不匹配、完全不拦 | `src/http/middleware/rbac.js:86-105`；`rbac.js:78`；`src/portal/configCenter.js:15` |
| 2 | sysadmin 走管理页「✓通」，不是死循环 | 平台侧**全断**。`config.html:90` 系统级 TAB `visible: me.level==='ADMIN'`；直连 `/mcp-identities.html` 页面能开（`routes.js:2875` 裸 sendFile）但 `GET /api/mcp-identities` 被 403 | `src/web/config.html:90`；`src/http/routes.js:2875` |
| 3 | 管理 `create` 未写 tenant_id → 归属 **NULL** | 归属被**静默写成 `'system'`**（列有 `NOT NULL DEFAULT 'system'`）。这比 NULL 更危险——租户接入方的凭据被静默提升为平台级归属 | `db/migrate-tenant.js:11`；`src/portal/mcpIdentity.js:73-77` |

---

## §1 证据链（代码级锚点）

### §1.1 三通路可达性矩阵（修正后）

| 通路 | sales 等业务角色 | sysadmin | ten_admin | admin | 锚点 |
|---|---|---|---|---|---|
| ① 我的 API Key 自助 | ✅ 通 | ❌ 403（白名单外） | ❌ 403 | ❌ 403 | `mcpIdentity.js:165` `SELF_ROLES` |
| ② 管理页 + 新增身份 | ❌ 403（全局闸） | ❌ **403 + TAB 不可见** | ❌ 403 | ✅ 通 | `rbac.js:78`；`config.html:90` |
| ③ MCP `crm_login` | ✅ 通 | ✅ 通（8h TTL） | ✅ 通 | ❌ 硬拒（设计意图） | `src/mcp/auth.js:139-142` |
| ④ 服务端 `issueToken` | ✅（运维手动） | ✅ | ✅ | ⚠️ FK 拒 | `src/mcp/issueToken.js`；`db/schema.sql:498` |

> admin 禁领 token 是**既有设计意图**（`rbac-role-permission-fix-design.md:29-31`），本设计**不改**。
> `role_context_profile` 无 `admin` 行（`src/context/roleProfiles.js:18-27`）是该意图的 FK 级落地，亦不改。

### §1.2 可复现提权链（P0）

```
① POST /api/mcp-identities/me       → sales 拿明文 token（role_tag=sales，白名单允许）
② GET  /api/mcp-identities/me       → 取到自己身份的 id
③ PUT  /api/mcp-identities/<id>     → body {role_tag:'sysadmin'}
                                       ↑ 路径 /api/mcp-identities/<id> ≠ endpoint /api/mcp-identities
                                         → createConfigLevelGate 不命中 → 零校验直改
④ 用 ① 的明文 token 走 MCP           → writeScopesForRole('sysadmin') = {write_scope:'governance'}
```

锚点：`mcpIdentity.js:204-221`（put 无任何角色判定）、`src/mcp/auth.js:120-123`（治理写授权）。
**结论**：`SELF_ROLES` 白名单被完整绕过，自助通道等于任意角色签发通道。

### §1.3 D5 假 PATCH（P0）

`defaultDeps.put`（`mcpIdentity.js:80-87`）SQL 无条件写全部 6 列；handler 只把「已传字段」放进 `patch` → 未传字段为 `undefined`，node-postgres 转 **NULL**：

| 页面动作 | 实际传入 | 后果 | 锚点 |
|---|---|---|---|
| 点「吊销」 | 仅 `{revoked_at}` | `actor`/`role_tag` 写 NULL → 撞 `NOT NULL` → 400，**吊销必失败** | `mcp-identities.html:62`；`db/schema.sql:490,492` |
| 点「编辑」 | 仅 `{actor, role_tag}` | `revoked_at` 清 NULL + `enabled` 因 `patch.enabled!==false` 回 `true` + `expires_at`/`scopes` 清空 → **已吊销 token 复活** | `mcp-identities.html:57`；`mcpIdentity.js:82-85` |

**假绿归因（L2：mock 遮蔽依赖缺陷）**：`test/web/mcpIdentity.test.js:80`「put 吊销置 revoked_at + enabled=false」长期绿，但它 stub 掉整个 `D.put`，只验 handler 的 patch 构造，**从未触碰真实 SQL**。

### §1.4 sysadmin 的合法配置面（决定 T5 落地方式的关键事实）

`CONFIG_ITEMS` 共 34 项，分布：**system 19 / tenant 14 / propagation 1**。租户级样例：
`12:用户管理 | 14:销售决策场景配置 | 15:七维设计 | 17:审批流配置 | 18:业务分级配置 | 20:池配置`

→ **sysadmin 进 `/config` 是有实质内容的**（14 个面）。因此菜单放行 sysadmin 是**正确的**，不能砍。

---

## §2 已批准决策记录

| 决策 | 结论 | 理由 |
|---|---|---|
| 范围 | 五项（T1–T5） | 用户 2026-09-08 明确 |
| sysadmin 与 id27 权限口径 | **C：不放宽后端 level 闸**，id27 保持 `level:'system'`（ADMIN-only） | MCP 身份签发本质是**安全凭据签发**，平台最高敏感写；sysadmin 定位为「治理写、禁业务写」（`auth.js:121` `deny_business_write:true`），授予凭据签发权反而扩大攻击面。且 admin 通路本已畅通，可为任意 actor 签发含 `role_tag=sysadmin` 的身份 |
| admin 禁领 token | **不改**（设计意图） | `rbac-role-permission-fix-design.md:29-31` |
| 自助白名单排除平台级角色 | **不改**（设计意图） | `my-api-keys-self-service-design.md:30` |

### §2.1 ⚠️ 需评审确认的设计偏离（T5）

用户选择的 C 选项字面描述为「sysadmin 不再看到配置中心入口」。**取证后我认为不能字面执行**：

- `layoutMenu.js:31` 的 `ADMIN_MENU` 含「配置中心 / 智能体中心 / 报告」三项。把 sysadmin 从该判定移除，会连带剥夺它对**智能体中心**、**报告**，以及 `/config` 内 **14 个租户级配置面**的入口 → 严重过度修正，制造新的可用性故障。
- C 的**实质**是「不放宽后端权限」，这一点本设计完整保留（id27 仍 ADMIN-only）。
- 故 T5 落地方式调整为：**不动菜单权限，改为消除误导 + 补精确引导**。误导的真正来源是文案，不是菜单。

**请在评审时确认此偏离**。若你坚持字面砍菜单，我按你的决定改，但需先接受上述副作用。

---

## §3 任务详细设计

### §3.1 T1（P0 安全）— 管理通道补显式角色闸

**根因**：`handlers.list/create/put` 均无角色判定，仅靠 `createConfigLevelGate` 的**路径精确匹配**兜底；`put` 因路径多一段而逃逸（§1.2）。

**方案**：在 handler 内补**显式**闸，与全局闸构成纵深防御。不采用「只给 put 补闸」，因为路径精确匹配天生脆弱——`configCenter.js:15` 的 `endpoint` 一改，list/create 立即裸奔。

改动 `src/portal/mcpIdentity.js`：

```js
// 顶部新增（路径先例：src/portal/ontologyConfig.js:17）
import { hasRole } from '../http/middleware/rbac.js';

// createMcpIdentityRouter 内、handlers 之前新增
// 管理通道统一闸：MCP 身份签发 = 平台最高敏感写，仅 ADMIN。
// 与 createConfigLevelGate（rbac.js:86，路径精确匹配）纵深防御——
// 全局闸覆盖 /api/mcp-identities 精确路径，本闸覆盖含参数的子路径（如 PUT /:id）。
const requireAdmin = async (req, res) => {
  const me = await D.resolveMe(req);
  if (!me?.ok) { res.status(401).json({ error: me?.error || '未登录' }); return null; }
  if (!hasRole(me, 'ADMIN')) {
    res.status(403).json({ error: 'MCP 身份签发仅 ADMIN 可操作（凭据签发为平台最高敏感写）' });
    return null;
  }
  return me;
};
```

三处 handler 首行插入（示例为 `put`）：

```js
put: async (req, res) => {
  try {
    const me = await requireAdmin(req, res);
    if (!me) return;                       // 401/403 已响应
    ...原逻辑...
```

**不改** `me`/`meCreate`/`meRevoke`（自助通道，`SELF_ROLES` 白名单已守，且 T1 修好后 `put` 不再是绕过口）。

```contract-yaml
- task: "T1 管理通道 list/create/put 补显式 ADMIN 闸（堵提权链）"
  agent: decision-agent
  contract_task_id: ct-decision
  skills: [data-particle-read, data-particle-create]
  memory: [decision-agent]
  knowledge_scope: { layers: [L1, L2], max_hops: 5 }
  success: "sales 会话 PUT /api/mcp-identities/:id 改 role_tag→403；未登录→401；ADMIN→放行；§1.2 四步提权链在集成测试中被阻断于第③步"
```

---

### §3.2 T2（P0 安全 + 功能）— `put` 改真 PATCH，吊销不可逆

**根因**：§1.3。SQL 无条件全覆盖，未传字段被写 NULL。

**方案**：动态 SET 白名单（而非 `COALESCE`）。选动态 SET 的理由：`COALESCE` 无法区分「未传」与「显式传 null」，而清除 `expires_at` 是合法诉求，必须可表达。

改动 `src/portal/mcpIdentity.js:80-87`：

```js
put: async (id, patch) => {
  // 吊销不可逆（与"绝对禁删"同源纪律）：已吊销行拒绝任何再修改，
  // 否则编辑操作会清空 revoked_at 使失效凭据复活（D5 安全事故）。
  const cur = (await query(
    `SELECT id, revoked_at FROM crm.mcp_identity WHERE id=$1`, [id])).rows[0];
  if (!cur) return { notFound: true };
  if (cur.revoked_at) return { revoked: true };

  // 真 PATCH：只写「显式传入」的列（未传 → 不出现在 SET 中）
  const COLS = ['actor', 'role_tag', 'scopes', 'enabled', 'expires_at', 'revoked_at'];
  const sets = []; const vals = [id]; let n = 1;
  for (const c of COLS) {
    if (!(c in patch)) continue;
    n += 1;
    sets.push(`${c}=$${n}${c === 'scopes' ? '::jsonb' : ''}`);
    vals.push(c === 'scopes' ? JSON.stringify(patch[c] || {}) : patch[c]);
  }
  if (!sets.length) return { noop: true };
  const r = await query(
    `UPDATE crm.mcp_identity SET ${sets.join(', ')}
      WHERE id=$1 RETURNING id, actor, role_tag, enabled, revoked_at`, vals);
  return { row: r.rows[0] || null };
},
```

handler `put` 分支同步（`mcpIdentity.js:216-217`）：

```js
const updated = await D.put(id, patch);
if (updated?.notFound) return res.status(404).json({ error: '身份不存在' });
if (updated?.revoked)  return res.status(409).json({ error: '身份已吊销，不可再修改（吊销不可逆）' });
if (updated?.noop)     return res.status(400).json({ error: '无可更新字段' });
const row = updated.row;
```

**破坏性变更告知**：`D.put` 返回契约由 `row|null` 改为 `{row}|{notFound}|{revoked}|{noop}`。现有三个 stub 测试须同步（`test/web/mcpIdentity.test.js:70,80,89`）。这是必要代价——旧契约无法表达「已吊销」语义。

```contract-yaml
- task: "T2 put 改真 PATCH（动态 SET）+ 吊销不可逆 409"
  agent: decision-agent
  contract_task_id: ct-decision
  skills: [data-particle-read, data-particle-create]
  memory: [decision-agent]
  knowledge_scope: { layers: [L1, L2], max_hops: 5 }
  success: "真库集成测试：仅传 revoked_at 吊销成功且 actor/role_tag 不变；对已吊销身份再 PUT→409 且 revoked_at 未被清空；仅传 actor 时 expires_at/scopes/enabled 保持原值"
```

---

### §3.3 T3（P1，跨租户风险）— 管理 `create` 补 `tenant_id`

**根因**：`mcpIdentity.js:73-77` INSERT 不含 `tenant_id`，列默认 `'system'`（`db/migrate-tenant.js:11`）→ admin 为某租户接入方签发的凭据被**静默提升为平台级归属**，其 MCP 会话 scope 落到 `system`（模板源租户）而非目标租户。

**方案**：显式接收并落库，默认 `'system'`（平台级接入方）。**不用** `me.tenantId` —— ADMIN 的 tenantId 可能是通配 `'*'`，写入会造成脏数据。

```js
create: async (input) => {
  const { id, tokenPlain } = newStructuredToken();
  const r = await query(
    `INSERT INTO crm.mcp_identity (id, token_hash, actor, person_id, role_tag, scopes, expires_at, tenant_id)
     VALUES ($1, crypt($2, gen_salt('bf')), $3, $4, $5, $6::jsonb, $7, $8)
     RETURNING id, actor, role_tag, enabled, revoked_at, tenant_id`,
    [id, tokenPlain, input.actor, input.person_id || null, input.role_tag,
     JSON.stringify(input.scopes || {}), input.expires_at || null,
     input.tenant_id || 'system']);   // 平台级接入方默认 system；租户接入方由管理页显式指定
  return { row: r.rows[0], token_plaintext: tokenPlain };
},
```

handler 透传（`mcpIdentity.js:197-199`）：`const { actor, person_id, role_tag, scopes, expires_at, tenant_id } = req.body || {};`

```contract-yaml
- task: "T3 管理 create 补 tenant_id 落库（默认 system，可显式指定）"
  agent: decision-agent
  contract_task_id: ct-decision
  skills: [data-particle-read, data-particle-create]
  memory: [decision-agent]
  knowledge_scope: { layers: [L1, L2], max_hops: 5 }
  success: "POST 带 tenant_id=acme-auto → 落库 tenant_id=acme-auto；不带 → 落库 system；该 token 走 MCP 后会话 scope.tenantId 与落库值一致"
```

---

### §3.4 T4（P1 可用性）— 新增身份改下拉 + 文案补全

**根因**：`mcp-identities.html:67-77` 用两次 `prompt()`，角色列表硬编码为 5 个业务角色，未列 `sysadmin`/`ten_admin` → 管理员不知道能填什么，这是「死循环」体感的直接来源。

**低成本关键事实**：页面已有 `roleOptions` 下拉渲染函数（`test/web/mcpIdentity.test.js:225` 已覆盖），且 `GET /api/mcp-identities` 已返回 `roles`（`mcpIdentity.js:67-68` 直取 `role_context_profile` 全表，天然含 sysadmin/ten_admin）→ **数据源现成，无需新增 API**。

**方案**：
1. `mcp-identities.html`：`+ 新增身份` 由 `prompt` 改为**内联表单**（actor 输入框 + role_tag 下拉复用 `roleOptions(roles)` + 可选 tenant_id 输入 + 提交/取消）。角色列表**一律由后端 `roles` 驱动，禁止前端硬编码**（避免再次漂移）。
2. `my-api-keys.html:71` 文案修正——当前文案有**双错**：漏 `sysadmin`，且把平台级角色统一指向 sysadmin 无权访问的管理页。改为按角色分流：
   - `sysadmin` / `ten_admin`：提示用 `crm-cli auth login`（或 MCP `crm_login`）自助领取 8h token，并给出命令示例。
   - `admin`：提示 admin 为治理账号、按设计不可持有 MCP 凭据，请以 admin 身份在管理页为具体接入方签发。
3. `mcp-identities.html` 加载失败（403）时给出明确文案，而非静默空表。

**实施纪律**（UI 铁律，`docs/specs/2026-09-05-ui-authoring-rules.md`）：改动前读该 spec；提交前必须 `node scripts/ui-lint.mjs` 通过，禁止加排除名单、禁止 `--no-verify`。

```contract-yaml
- task: "T4 新增身份改内联下拉表单 + my-api-keys 文案按角色分流"
  agent: decision-agent
  contract_task_id: ct-decision
  skills: [data-particle-read, data-particle-create]
  memory: [decision-agent]
  knowledge_scope: { layers: [L1, L2], max_hops: 5 }
  success: "下拉选项完全来自后端 roles（含 sysadmin/ten_admin），grep 确认页面无角色字面量硬编码；my-api-keys 对 sysadmin 显示 CLI 自领指引；ui-lint 绿"
```

---

### §3.5 T5（P1 一致性）— 消除「看得见点不进」的误导

**根因**（修正后）：不是菜单权限错，而是**跨层口径未对用户解释**。sysadmin 进 `/config` 合法（14 个租户级面），但系统级 TAB 静默消失，无任何说明 → 用户判定为「平台坏了 / 死循环」。

**方案**（§2.1 已说明为何不砍菜单）：
1. `src/web/config.html`：非 ADMIN 时，系统级 TAB **不再静默隐藏**，改为显示为**不可点占位**并附文案「系统级配置仅 ADMIN 可访问（§15）；MCP 身份签发请联系平台管理员，或使用 crm-cli 自助领取」。
   - 仅显示分组名与说明，**不渲染 19 个系统级条目明细**（避免信息泄露）。
2. `layoutMenu.js:31` / `layout.js:33` **不改**（保留 sysadmin 的配置中心/智能体中心/报告入口）。
3. 传播中枢 TAB（`config.html:93`）同样处理，口径一致。

**待评审的取舍**：方案 1 让非 ADMIN 得知「存在一个系统级分组」。我判断这是**可接受**的——分组名本身不是敏感信息，而静默消失造成的运维误判成本远高。若你认为不可接受，退化方案：TAB 仍隐藏，仅在 `/config` 页尾加一行通用说明。

```contract-yaml
- task: "T5 config.html 系统级/传播 TAB 非 ADMIN 显示不可点占位 + 替代通路文案"
  agent: decision-agent
  contract_task_id: ct-decision
  skills: [data-particle-read, data-particle-create]
  memory: [decision-agent]
  knowledge_scope: { layers: [L1, L2], max_hops: 5 }
  success: "sysadmin 登录 /config：租户级 14 项正常可用；系统级 TAB 可见但不可点且含替代通路文案；不渲染任何系统级条目明细；layoutMenu/layout 菜单行为零变化（单测断言）"
```

---

## §4 测试计划（TDD，先红后绿）

**核心纪律**：T2 的缺陷正是被 stub 测试遮蔽的（§1.3），因此**必须补真库集成测试**。只改 stub 测试等于继续骗自己。

| # | 测试文件 | 类型 | 用例 | 打掉的假绿层 |
|---|---|---|---|---|
| 1 | `test/web/mcpIdentity.test.js`（改） | 单测 stub | 三处 handler 的 401/403/409 分支；`D.put` 新返回契约 | — |
| 2 | `test/portal/mcpIdentityAdminGate.test.js`（新） | 集成（真库） | §1.2 四步提权链：sales 自助建 key → PUT 改 role_tag → **必须 403**；ADMIN 同操作 → 200 | L2（mock 遮蔽授权） |
| 3 | `test/portal/mcpIdentityPatch.test.js`（新） | 集成（真库） | 仅传 `revoked_at` → 吊销成功且 `actor`/`role_tag` 不变；对已吊销行再 PUT → 409 且 `revoked_at` 未清；仅传 `actor` → `expires_at`/`scopes`/`enabled` 保持 | **L2（本次根因）** |
| 4 | `test/portal/mcpIdentityTenant.test.js`（新） | 集成（真库） | 带/不带 `tenant_id` 的落库值；该 token 经 MCP 后 `scope.tenantId` 一致 | L3（跨层未验） |
| 5 | `test/web/configTabVisibility.test.js`（新） | 单测（纯函数） | 非 ADMIN 时系统级 TAB `visible=false` 但 `placeholder=true`；条目明细数组为空 | — |
| 6 | `test/portal/layoutMenu*.test.js`（既有，加断言） | 单测 | sysadmin 菜单**仍含**配置中心/智能体中心/报告（防 T5 过度修正回归） | — |

**回归基线**：CRM-ai-native 约 386 例；全量约 2612 例存在 flaky，单次红不得直判回归（须 A/B 归因：备份改动 → `git checkout --` 自己的路径 → 同批复跑 → 还原）。
**并发红线**：跑测试前确认无并发 vitest 实例共享 `crm_native_test`，否则互相 TRUNCATE 造成伪失败。

---

## §5 风险与回滚

| 风险 | 等级 | 缓解 |
|---|---|---|
| T1 补闸后，某个既有内部调用方（脚本/E2E）以非 ADMIN 身份调管理 API → 突然 403 | 中 | 实施前 `grep -rn "api/mcp-identities" scripts/ test/ .workbuddy-plugin/ skills/` 全量盘点调用方；对确需机器调用的场景走 `issueToken.js` 服务端通路而非 HTTP |
| T2 改 `D.put` 返回契约 → 未同步的 stub 测试红 | 中 | 同一 commit 内改测试；改前先跑 `grep -rn "D.put\|deps.put" test/` 确认全部调用点 |
| T3 显式 `tenant_id` 后，存量 `'system'` 行语义不变但含义被重新解读 | 低 | **不做数据回填**（禁改存量，避免破坏现有可用 token）；仅新建行受影响，文档注明 |
| T5 暴露系统级分组名 | 低 | 仅分组名 + 文案，不渲染条目明细；§3.5 已备退化方案 |
| 全量回归 flaky 导致误判 | 中 | A/B 归因法（§4）；单次红不得直判 |

**回滚**：五项互相独立，按 commit 粒度单独 revert。T1/T2 属安全修复，回滚需用户显式授权。

---

## §6 验收标准

1. §1.2 四步提权链在真库集成测试中被阻断于第 ③ 步（403）。
2. 管理页「吊销」按钮真实可用（此前 100% 失败）；对已吊销身份编辑返回 409，`revoked_at` 永不被清空。
3. 管理页「+ 新增身份」为下拉表单，选项含 `sysadmin`/`ten_admin` 且全部来自后端 `roles`；`grep` 确认页面无角色字面量硬编码。
4. sysadmin 登录 `/config`：14 个租户级配置面正常；系统级 TAB 可见但不可点，含替代通路文案；侧边栏菜单行为零变化。
5. `my-api-keys.html` 对 sysadmin 显示可直接复制的 `crm-cli` 自领指引。
6. `node scripts/ui-lint.mjs` 绿；相关单测 + 4 个新增集成测试全绿；回归无新增确定性失败。

---

## §7 明确不做（范围边界）

- **不改** admin 禁领 token 的设计意图；**不补** `role_context_profile` 的 `admin` 行。
- **不放宽** id27 的 `level:'system'`（口径 C）；**不新增** `platform_access` level 档。
- **不改** `SELF_ROLES` 白名单构成。
- **不改** `src/context/routing.js` / `assembler.js` / `config_store['context-routing']`（红线，2026-09-04 起禁改）。
- **不做** `mcp_identity` 存量数据回填。
- **不新增** DELETE 端点（绝对禁删纪律不变）。

---

## §8 交付物清单

| 文件 | 动作 | 任务 |
|---|---|---|
| `src/portal/mcpIdentity.js` | 改（import + requireAdmin + 3 handler + create + put） | T1/T2/T3 |
| `src/web/mcp-identities.html` | 改（新增身份内联表单 + 403 文案） | T4 |
| `src/web/my-api-keys.html` | 改（文案按角色分流） | T4 |
| `src/web/config.html` | 改（TAB 占位 + 文案） | T5 |
| `test/web/mcpIdentity.test.js` | 改（新返回契约 + 闸分支） | T1/T2 |
| `test/portal/mcpIdentityAdminGate.test.js` | 新 | T1 |
| `test/portal/mcpIdentityPatch.test.js` | 新 | T2 |
| `test/portal/mcpIdentityTenant.test.js` | 新 | T3 |
| `test/web/configTabVisibility.test.js` | 新 | T5 |

**提交纪律**：每任务一 commit，显式路径 `git add`，禁 `git add -A`；提交前双检 `git log -1` + `git status --short`。AI 无 git 凭证，命令以 PowerShell 兼容形式交付由用户执行。

---

## §9 下一步

本文档待用户评审。批准后移交 `writing-plans` 产出实施计划（含完整代码与逐步验证点），再进入 `executing-plans`。

**评审需你明确表态的两处**：
1. §2.1 — T5 不砍菜单的设计偏离，是否认可？
2. §3.5 — 系统级 TAB 显示为不可点占位（暴露分组名），是否可接受？若否，走退化方案。
