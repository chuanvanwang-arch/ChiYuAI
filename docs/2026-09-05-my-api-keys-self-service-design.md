# 设计：个人自助管理 API Key（方案 B 完整形态）

- 日期：2026-09-05
- 状态：已批准并实施（用户「继续」确认）。实施备注：存量回填在实施核验时发现已被外部完成
  （person_id/tenant_id 35/35 非空，非本会话所为；本设计的 backfillPersonIds 幂等化为 no-op，保留作新环境兜底）。
- 前置：方案 A 已落地（`docs/2026-09-05-my-api-keys-design.md`，个人只读页 + GET /api/mcp-identities/me）
- 对标：Cordys CRM「个人中心 → API Keys」形态（创建时一次性展示明文、之后仅能吊销）

## 目标

普通用户在「我的 API Key」页可**自助创建**自己的接入身份（创建时一次性看到 token 明文）并**吊销**自己的身份；身份与账号正式绑定（person_id），不再依赖 actor=用户名的隐式对齐。

## 非目标

- 不做管理员代管能力的改动（mcp-identities.html 不变）；
- 不做 scopes 自助配置（自助创建 scopes 恒为 `{}` 全量，管理页保留精细配置）；
- 不触碰 crm_users.password_hash；绝对禁删不变。

## 数据层

1. **person_id 绑定**：
   - `POST /api/mcp-identities/me` 创建时写入 `person_id = 当前 user_id`、`tenant_id = me.tenantId`（补齐存量 tenant_id NULL 的缺口）；
   - **一次性幂等回填**（启动接线，seed 风格）：`UPDATE crm.mcp_identity SET person_id = u.user_id FROM crm.crm_users u WHERE mcp_identity.person_id IS NULL AND mcp_identity.actor = u.username AND u.tenant_id = mcp_identity.tenant_id`（tenant 比对不到的行仅按 username 匹配；失败仅日志不阻断启动）。回填属 UPDATE，不违反禁删。
2. **查询口径升级**：`me` 过滤从 `actor=username` 改为 `person_id=$uid OR (person_id IS NULL AND actor=$username)`（回填后自然收敛为纯 person_id）。

## 端点（写经决策第 0 闸，复用 produceDecision）

| 端点 | 语义 | 关键约束 |
|---|---|---|
| `POST /api/mcp-identities/me` | 自助创建自己的身份 | actor 强制=me.username、role_tag 强制=me.role（非白名单角色如 admin/sysadmin → 403 引导走管理页）；person_id/tenant_id 强制本账号；**每用户启用中（未吊销）身份上限 5**（超出 400）；token 明文仅本次响应返回 |
| `PUT /api/mcp-identities/mine/:id` | 吊销自己的身份 | 仅允许置 `revoked_at`（其余字段 403）；行必须属于本人（person_id/actor 校验）；吊销=软标记+停用，禁删不变 |

既有 `PUT /api/mcp-identities/:id`（admin 全权）不动；`GET /api/mcp-identities/me` 不变口径升级。

## 前端（my-api-keys.html 增量）

- 「+ 新建 API Key」按钮 → POST → 复用管理页同款 token-modal 一次性展示明文（关闭后不可再查看）；
- 每行「吊销」按钮（仅未吊销行）→ confirm 二次确认 → PUT mine/:id；
- 列表自动刷新；文案更新（自助创建/吊销）。

## 安全要点

- token 明文一次性：响应即焚，服务端只存 crypt 哈希（沿用 newStructuredToken + gen_salt('bf')）；
- 每用户 5 个启用身份上限：防滥用与凭据 sprawl；
- 决策第 0 闸留痕：create/revoke 均记 `config_change`（type: mcp_identity_self_create / mcp_identity_self_revoke）；
- 租户隔离：tenant_id 强制本租户，me 查询天然隔离。

## 测试

- `me` POST：创建成功（actor/role_tag/person_id 强制覆盖、上限 5、明文返回、决策留痕）；
- `mine/:id` PUT：仅本人可吊销 / 非 revoke 字段 403 / 他人身份 404；
- 回填函数：幂等（二次执行 0 行）、username+tenant 双匹配、失败不抛；
- layout/页面断言：新增按钮与 modal 存在。

## 验收

alice 登录 → 我的 API Key 页自助创建 → 弹窗见明文一次 → 列表新增行（状态启用，person_id=自己）→ 自助吊销 → 状态「已吊销」；超 5 个启用身份被拒；admin 管理页可见并可用既有全权编辑。
