# 企业AI销售决策管理专家 · 插件包（crm-platform-admin）

> **行业自适应过程全监控** —— 面向平台管理员 / `sysadmin` 的治理插件。与业务销售助手 `crm-native`（L2C 全链路）互补：本插件只管**平台底座治理**，不碰业务销售。

## 1. 定位与边界

| 维度 | crm-native（已发布） | **crm-platform-admin（本插件）** |
|---|---|---|
| 面向角色 | 销售 / 经理 / 售前 / 高管 / 财务 | **平台管理员 / `sysadmin`** |
| 能力域 | 线索→客户→商机→报价→合同→回款（L2C 业务） | **行业上线 / 用户权限 / 系统初始化（平台治理）** |
| 准入 | `crm_login` + 五角色自适应 | **`crm_login` 登录验证 + 仅 `sysadmin` 角色**（双闸，缺一不可） |
| 分发 | 独立插件包 `plugin/` | 独立插件包 `plugin-platform-admin/`（本目录） |

> 两包**独立安装、互不依赖**：业务助手走 `crm-native`，平台治理走 `crm-platform-admin`。共享同一 `crm-native-mcp` 后端与同一套红线。

## 2. 三大能力（领域 SKILL）

| SKILL | 能力 | 关键不变量 |
|---|---|---|
| `industry-onboarding` | 新增行业租户（tenant-profile 配置画像上线） | 零代码零污染（`PARTICLE_TYPES` 禁加行业字面量）；最终交付 = 该行业初始销售员账号 |
| `user-rbac-admin` | 新增用户 + 配置 RBAC 权限矩阵 | `crm.crm_users` crypt 哈希、禁删、首登改密；`crm.rbac` 角色×data_scope、禁 delete |
| `system-bootstrap` | 系统初始化（迁移 + 种子 + 配置引导 + 注册 sysadmin） | 幂等可重跑、禁 DELETE、per-tenant 隔离 |

## 3. 准入双闸（强制）

本插件**不降级执行**任何平台管理操作：

1. **登录验证闸（首闸）**：操作前必须先 `crm_login(username, password)` 验证通过（`gate != 'auth_required'`）。未登录 / 凭证失效 → 立即拒绝。
2. **sysadmin 角色闸（唯一）**：行业上线 / 用户权限 / 系统初始化**仅对 `sysadmin` 角色开放**；普通 `admin` / 其它角色 → 403。

> 若平台尚无 `sysadmin` 角色，须先经 `system-bootstrap` Step 4（或 `user-rbac-admin` 场景 C）在 `crm.rbac` 注册并赋给管理员账号。

## 4. 红线（继承平台总则）

| 红线 | 说明 |
|---|---|
| 必须登录验证 | 任何平台管理操作前 `crm_login` 通过；未验证一律拒。 |
| sysadmin 仅授权 | 平台治理操作仅 `sysadmin` 可执。 |
| 绝对禁 DELETE | 用户 / RBAC / 配置 / 主数据一律「禁用 / 软停用 / 软合并（`meta.merged_into`）」，对外不暴露 delete / remove 工具。 |
| 写必经决策第 0 闸 | 一切写操作强制带 `decision_id`（无决策不写）；对话式写还需 HITL 确认。 |
| per-tenant 隔离 | 用户按 `tenant_id` 收敛；行业差异 = 配置画像，永不进代码常量。 |
| 零信任 | 凭据隔离；客户端 token 仅映射 `actor` 与 `role`；对话中绝不索要明文密码。 |

## 5. 包结构（WorkBuddy 上传格式）

```
plugin-platform-admin/                 # 包根（上传单元）
  .codebuddy-plugin/
    plugin.json                        # 插件清单（name/category/entries/avatar）
  agents/platform-admin.md             # 对话面孔（sysadmin 治理角色 + 准入双闸）
  skills/                              # 3 个领域 SKILL
    industry-onboarding/               # 行业新增
      SKILL.md  registry.json
    user-rbac-admin/                   # 用户与权限
      SKILL.md  registry.json
    system-bootstrap/                  # 系统初始化
      SKILL.md  registry.json
  avatars/platform-admin.png
  openclaw.plugin.json                 # 技能清单（skills 路径）
  package.json                         # npm 包元数据 + openclaw 段
  index.js                             # 插件入口（skill bundle，声明式加载）
  README.md
```

## 6. 参考源（范式来源）

本插件 SKILL 写法对齐 `D:\system\CRM-ai-native\Lanch\SKILL` 下的领域 Runbook 范式：
- `industry-onboarding` ← `Lanch/SKILL/new-industry-onboarding`（tenant-profile 配置化上线）
- `user-rbac-admin` ← `Lanch/SKILL/crm-config-center-settings` §G1 id12 用户管理 / id13 RBAC 矩阵
- `system-bootstrap` ← 平台首次部署实践（db/migrate.js + db/seed + 配置中心 PUT）

共享红线（禁 DELETE / 决策第 0 闸 / per-tenant 隔离 / 零信任）与 `crm-config-center-settings`、`new-industry-onboarding` 同源。

## 7. 接入与分发

### 7.1 本地 MCP 接入（与 crm-native 同后端）

```
npm run mcp:http     # StreamableHTTP @3001 /mcp
npm run mcp:stdio    # stdio（本地 Agent 子进程）
```

办公智能体挂载 `platform-admin` 后，经 `crm-native-mcp` 调用平台治理能力；**首次接入须 `crm_login(username,password)` 验证**，之后携带 `api_token`（或 `Authorization: Bearer`）。

### 7.2 技能市场 / ClawHub 安装

1. 将整个 `plugin-platform-admin/` 包根（含 `.codebuddy-plugin/` + `agents/` + `skills/` + `avatars/` + `README.md`）整体打包为 zip 上传。
2. 在 WorkBuddy「技能市场 → 上传插件」提交该 zip（外部发布操作，由用户在对应平台侧完成）。
3. 安装后，办公智能体挂载 `platform-admin` 即获得行业上线 / 用户权限 / 系统初始化治理能力（受 sysadmin 双闸约束）。

## 8. 设计说明（为何独立包）

- **维度分离**：业务销售（L2C）与平台治理（行业 / 用户 / 初始化）职责不同，独立包可独立安装、独立授权、独立演化，避免单一包职责膨胀。
- **零污染铁律**：行业差异 = 配置画像（`tenant-profile`），新行业不碰 `PARTICLE_TYPES` / `stageTaxonomy` / `seed-actions` 任何代码常量；平台治理同样不向 ai-* 方法论基线增删改。
- **最少惊讶**：沿用 WorkBuddy 插件格式（`.codebuddy-plugin/plugin.json` + `openclaw.plugin.json` + `agents/` + `skills/` + `avatars/`），降低分发与维护成本。

## 9. 铁律声明

本插件全部 SKILL 为**领域专属**操作手册，与 10 大 ai-* 方法论能力 SKILL **无关、不交叉写入**。通用方法论以交叉引用复用，绝不向 ai-* 基线增删改任何内容。

## 10. 版本变更

| 版本 | 日期 | 变更 | 依据 |
|---|---|---|---|
| **1.3.0** | 2026-09-17 | 品牌与卡片字段对齐：`profession.zh` → **企业AI销售决策管理专家**，`displayName.zh`（卡片小标题）→ **行业自适应过程全监控**；**三条版本清单**（权威源 / `openclaw.plugin.json` / `package.json`）同步对齐，并纳入 `scripts/verify-plugin-zips.py` 的版本一致性守卫。**无工具 / 协议变更。** | 本轮 |
| 1.2.0 | 2026-09-15 | `industry-onboarding` 更新：Step 4C 线索发现数据源按租户启用（D1 三档，付费源不得默认启用）+ closed-loop 与 OAuth 声明同步。 | `6cbb011` |
| 1.1.1 | 2026-09-09 | 首次登录提醒失效修复。 | `513e9a2` |
| 1.1.0 | 2026-09-07 | 首次接入引导（注册 → 激活码 → 登录）写入 SKILL；补齐初始基线遗漏的配置与模块文件。 | `ec1e8e3` |

> **版本纪律**：三条清单必须**同步 bump**（只改权威源会造成「用户看到的仍是旧版本」）。
> 打包与校验：
> ```bash
> python scripts/pack-platform-admin-plugin.py
> python scripts/verify-plugin-zips.py     # 含版本一致性守卫
> ```
