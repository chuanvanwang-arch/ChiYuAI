# 设计文档：企业AI销售决策管理专家插件（crm-platform-admin）

> 日期：2026-09-03
> 包根：`D:\system\CRM-ai-native\plugin-platform-admin\`
> 状态：已实现（独立插件包，可分发）

## 1. 背景与决策

用户要求「新增一个插件：企业AI销售决策管理专家」，覆盖**行业新增 / 用户与权限新增 / 系统初始化**。

**决策：新建独立插件包 `crm-platform-admin`，与业务包 `plugin/`(crm-native) 平级、独立安装。**

- 维度分离：业务销售（L2C，crm-native）与平台治理（行业 / 用户 / 初始化，本包）职责不同；独立包可独立授权、独立演化、独立分发，避免单一包职责膨胀。
- 范式对齐：SKILL 写法对齐 `Lanch/SKILL/` 领域 Runbook（`new-industry-onboarding` / `crm-config-center-settings`）；包格式对齐 crm-native（`.codebuddy-plugin/plugin.json` + `openclaw.plugin.json` + `agents/` + `skills/` + `avatars/`）。

## 2. 包结构与文件清单

```
plugin-platform-admin/
├── .codebuddy-plugin/plugin.json   # 插件清单：name=crm-platform-admin, 3 skills, agent=platform-admin
├── openclaw.plugin.json            # 技能清单（skills 路径）
├── package.json / index.js         # npm 元数据 + 入口（声明式 skill bundle）
├── README.md                       # 设计 + 分发说明（对外主文档）
├── agents/platform-admin.md        # 对话面孔：sysadmin 治理角色 + 准入双闸
└── skills/
    ├── industry-onboarding/        # 行业新增
    ├── user-rbac-admin/            # 用户与权限
    └── system-bootstrap/           # 系统初始化
```

## 3. 三大能力契约

| SKILL | 能力 | 关键不变量 / 端点 |
|---|---|---|
| `industry-onboarding` | 新增行业租户 | `tenant-profile` 配置画像（`PUT /api/config/tenant-profile`，自带第0闸）；零代码零污染（禁改 `PARTICLE_TYPES`/`stageTaxonomy`/`seed-actions`）；最终交付 = 该行业初始销售员账号 |
| `user-rbac-admin` | 用户与 RBAC | 用户 `crm.crm_users`（crypt 哈希、禁删、首登改密、tenant 隔离，`PUT /api/config/users`）；RBAC `crm.rbac` 角色×data_scope（禁 delete，`PUT /api/rbac`） |
| `system-bootstrap` | 系统初始化 | 幂等迁移 `db/migrate.js` + 种子 `UPSERT`（`npm run seed` / `seed-all-tenants.mjs`）+ 配置引导（LLM/system/tenant-profile 经配置中心 PUT）+ 注册 sysadmin 角色 + 校验清单 |

## 4. 准入双闸（强制，用户 2026-09-03 明确）

本包不降级执行任何平台管理操作：

1. **登录验证闸（首闸）**：操作前必须先 `crm_login(username, password)` 验证通过（`gate != 'auth_required'`）；未登录 / 凭证失效 → 立即拒绝。
2. **sysadmin 角色闸（唯一）**：行业上线 / 用户权限 / 系统初始化**仅对 `sysadmin` 角色开放**；普通 `admin` / 其它角色 → 403。

各 SKILL 的 `registry.json` 中 `rbac_roles` 统一为 `["sysadmin"]`；agent 面孔 `platform-admin.md` 含「准入闸」段与「安全红线」首项。

## 5. 红线（继承平台总则）

| 红线 | 说明 |
|---|---|
| 必须登录验证 | 任何平台管理操作前 `crm_login` 通过；未验证一律拒。 |
| sysadmin 仅授权 | 平台治理操作仅 `sysadmin` 可执。 |
| 绝对禁 DELETE | 用户 / RBAC / 配置 / 主数据一律禁用 / 软停用 / 软合并（`meta.merged_into`），对外不暴露 delete / remove 工具。 |
| 写必经决策第 0 闸 | 一切写操作强制带 `decision_id`（无决策不写）；对话式写还需 HITL 确认。 |
| per-tenant 隔离 | 用户按 `tenant_id` 收敛；行业差异 = 配置画像，永不进代码常量。 |
| 零信任 | 凭据隔离；token 仅映射 actor/role；对话中绝不索要明文密码。 |

## 6. 与 crm-native 的边界

- crm-native：业务销售助手（5 角色自适应，L2C 全链路）。
- crm-platform-admin：平台治理助手（sysadmin 单角色，行业/用户/初始化）。
- 共享同一 `crm-native-mcp` 后端与同一套红线；两包互不引用、独立安装。

## 7. 范式来源

- `industry-onboarding` ← `Lanch/SKILL/new-industry-onboarding`（tenant-profile 配置化上线）。
- `user-rbac-admin` ← `Lanch/SKILL/crm-config-center-settings` §G1 id12 用户管理 / id13 RBAC 矩阵。
- `system-bootstrap` ← 平台首次部署实践（db/migrate.js + db/seed + 配置中心 PUT）。

## 8. 分发与验收

- 分发：整体打包 zip 上传 WorkBuddy 技能市场 / ClawHub（`openclaw skills install @<you>/crm-platform-admin`）。
- 验收（已执行）：6 个 JSON 全部解析合法；`plugin.json` 技能清单路径与 `skills/` 目录一致；各 SKILL 含 SKILL.md + registry.json；skill_id 与目录名一致。

## 9. 自查（占位符 / 矛盾 / 歧义 / 范围）

- **占位符**：无遗留 `<TBD>` / `TODO`；示范中的 `<行业>` / `<ind>` 为模板变量（预期由调用时替换），非未完成项。
- **矛盾**：与 crm-native 不冲突（独立包、独立角色）；`sysadmin` 为新增专用角色，与既有 `admin` 明确区分（普通 admin → 403）。
- **歧义**：准入双闸（登录验证 + sysadmin）在 agent 面孔与三 SKILL 红线表均一致表述。
- **范围**：严格限于平台治理（行业 / 用户权限 / 系统初始化）；业务销售能力不纳入，路由回 crm-native。

## 10. 后续（待用户操作）

- 分发上传由用户在对应平台侧完成（AI 不代提交）。
- 真实落库须按 memory 铁律走决策第 0 闸 + HITL（生产写不代执行）。
- 若需把平台治理角色接入 `crm.rbac` 落库，参照 `user-rbac-admin` 场景 C / `system-bootstrap` Step 4。
