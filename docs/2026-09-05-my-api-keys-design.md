# 设计：个人「我的 API Key」页（方案 A 最小落地）

- 日期：2026-09-05
- 状态：已与用户确认方向（三选一中的方案 A），本文件为实施前设计基线
- 背景：用户提出「系统中已有用户，登录后无法查看哈希，也没有入口」。经源码 + 生产库只读核查：
  - `crm_users.password_hash` 为安全红线（明文不落库不回显），**不在本设计范围**；
  - 系统中真正对个人有意义的「哈希」是 `crm.mcp_identity.token_hash`（API Key/token），
    明文仅创建时一次性返回；当前只有 admin 能经 `/mcp-identities.html` 管理全部身份；
  - 个人头像菜单（`userMenuHtml`）无任何「个人中心 / 我的 API Key」入口；
  - 生产库 `mcp_identity.person_id` 全为 NULL → 方案 A 不动 person_id 绑定（那是方案 B），先以
    `actor = username`（现状数据即如此对齐）+ 租户过滤实现「只看我的」。

## 目标

普通用户（任意角色）登录后，可在头像菜单进入「我的 API Key」页，**只读查看自己名下的
MCP 身份**（接入方/角色/状态/有效期），并理解 token 明文一次性规则。

## 非目标（明确不做）

- 不做「个人自助创建/吊销身份」（属方案 B，需 person_id 绑定 + 写闸设计）；
- 不展示任何哈希原文（token_hash 单向不可逆，展示无意义且有安全暗示风险）；
- 不改 admin 的 `/mcp-identities.html` 与既有 `/api/mcp-identities` GET/POST/PUT 行为；
- 不触碰 `crm_users.password_hash` 任何逻辑；绝对禁删原则不变。

## 改动清单

| # | 文件 | 改动 |
|---|------|------|
| 1 | `src/portal/mcpIdentity.js` | 新增 `listMine` 依赖 + `handlers.me`（只读）+ `GET /api/mcp-identities/me` |
| 2 | `src/web/my-api-keys.html` | 新增个人只读页（登录态校验 + 复用 mcpIdentityRender 渲染） |
| 3 | `src/web/layout.js` | `userMenuHtml` 全员增加「🔑 我的 API Key」入口 |
| 4 | `src/http/routes.js` | 挂 `/my-api-keys.html` 静态路由 + `/my-api-keys` 重定向 |
| 5 | `test/web/mcpIdentity.test.js` | me 端点测试（401 / 只返回本人 / 不含 token_hash） |
| 6 | `test/web/layout.test.js` | userMenuHtml 断言补「我的 API Key」 |

## 关键设计决策

1. **过滤口径**：`WHERE actor=$1 AND (tenant_id IS NULL OR tenant_id=$2)`。
   依据：存量 35 条身份的 actor 与 crm_users.username 同名对齐（alice/manager/chem_sales01/
   training_sales01），person_id 全 NULL；tenant_id 存量多为 NULL，用 IS NULL 兜底避免老数据
   看不到。租户隔离：只透出本人租户可见行。
2. **鉴权**：`resolveMe` 通过即可（任意角色，含 sales）；无 token → 401。只读端点，不经决策第 0 闸。
3. **零信任不变**：响应永不包含 token_hash / token 明文；页面文案明确「明文仅创建时一次性返回，
   遗失须联系管理员吊销后新建」。
4. **向后兼容**：`userMenuHtml` 既有测试为 `toContain` 断言，新增菜单项不破坏；navHtml/侧栏不动。
5. **路由顺序**：`GET /api/mcp-identities/me` 与既有 `GET /api/mcp-identities`、`PUT /api/mcp-identities/:id`
   无冲突（GET 无 :id 路由）。

## 验收标准

- alice 登录 → 头像菜单出现「我的 API Key」→ 页面仅显示 actor=alice 的身份（生产库 13 条中仅 alice 的）。
- 未登录访问 → 重定向 `/home.html`；API 直调 → 401。
- `vitest run test/web/mcpIdentity.test.js test/web/layout.test.js` 全绿。
