# 第 28 项：系统设置配置（S33 `/config/system`）

> 设计计划 · 2026-08-27 · 配置中心第 28 项（S33）
> 铁律：设计先行 → 批准 → TDD 实现；每 Task 一 commit；沙箱无凭证，提交由用户本地执行。
> 对齐范式：第 14/12/22 项已闭环的「configRouter 工厂 + 决策第 0 闸 + web 页 + configCenter 翻转 + nav 入口」。

---

## 1. 定位与目标

**蓝图出处**：`docs/2026-08-26-frontend-config-pages-master-blueprint.md` S33
> 定位：全局参数 / 主题 / 安全策略。
> 页面类型：`form` + `table`。
> 组件：`attr-field`(站点名/默认主题/会话超时) ｜ `select`(主题 light/dark) ｜ `table`(审计日志)。
> 数据端点：`GET/PUT /api/config/system`。权限：sysadmin。

**本设计目标**：把全局系统参数（站点名/默认主题/会话超时/安全策略开关）从「无端点无页」暴露为**可配置面**：
1. **读**：sysadmin 查看当前系统设置（config_store key=`system`）；
2. **写**：维护站点名/默认主题/会话超时/安全策略，写经决策第 0 闸（config_change）；
3. **审计**：审计日志 table = 直查 `decision_event`（event_type='config_change'），天然承载蓝图 S33「审计日志」组件，无需新表。

## 2. 范围与红线

**范围内**：
- 后端 `createConfigRouter({ key:'system', role:'sysadmin' })` 工厂（沿用 configRouter.js 范式）→ GET / PUT `/api/config/system`
- 审计日志端点：GET `/api/config/system/audit-logs`（直查 decision_event 最近 N 条 config_change）
- 前端 `src/web/system.html`（S33 form+table：attr-field 表单 + select 主题 + 审计日志 table）
- configCenter 第 28 卡 pending→ready、nav.js 入口、page schema `/config/system` 已在白名单（schema.js:57，无需改）

**红线**：
- **写经决策第 0 闸**：configRouter 工厂已内置（produceDecision → recordDecisionEvent('config_change')）
- **权限 sysadmin**：configRouter `role='sysadmin'` 已内置（非 sysadmin 写 403）
- **审计日志只读**：审计是决策事件直查，无独立写端点（防审计篡改）

## 3. 蓝图对齐与偏差确认

| # | 蓝图 S33 | 本设计落法 | 说明 |
|---|---|---|---|
| 1 | GET/PUT /api/config/system | configRouter 工厂 key='system' | 与 llm/seven-dim（configRouter 已用）完全同构 |
| 2 | 审计日志 table | GET /api/config/system/audit-logs 直查 decision_event | config_store 只存当前值无历史；审计历史天然在决策事件（第 0 闸每次写已沉淀） |
| 3 | 主题 select light/dark | 前端 select 组件，值落 config_store system.value.theme | 与蓝图组件一致 |

**不改**：`db/schema.sql`（不建表）、`db/migrate-config.sql`（config_store 已存在）、`src/page/schema.js`（/config/system 已在白名单:57）

## 4. 后端模块设计

**文件**：`src/portal/systemSettings.js`（新增，对齐 decisionScenario.js / userManagement.js 范式）

```js
// 依赖注入范式
export function createSystemSettingsRouter(deps = {}) {
  const D = { ...defaultDeps, ...deps };
  const router = Router();
  const handlers = {
    get: async (req, res) => { /* configRouter handler.get 同构 */ },
    put: async (req, res) => {
      // 1. resolveMe 权限闸（sysadmin）
      // 2. validateSystemSettingsPatch 校验（字段白名单：site_name/default_theme/session_timeout/security_policy）
      // 3. produceDecision（决策第0闸 config_change）
      // 4. writeConfig 落 config_store key=system
    },
    getAuditLogs: async (req, res) => {
      // 直查 decision_event WHERE event_type='config_change' ORDER BY created_at DESC LIMIT 20
    },
  };
  router.get('/api/config/system', handlers.get);
  router.put('/api/config/system', handlers.put);
  router.get('/api/config/system/audit-logs', handlers.getAuditLogs);
  router.handlers = handlers; // 注入式测试
  return router;
}
```

**系统设置字段白名单**（`validateSystemSettingsPatch` 纯函数）：
| 字段 | 类型 | 约束 |
|---|---|---|
| site_name | text | 非空、≤64 字 |
| default_theme | text | light/dark 二选一 |
| session_timeout | number | 整数、60–1440 分钟 |
| security_policy | jsonb | 对象，允许键白名单 {password_min_len, mfa_required, allow_external_login} |

未知字段拒绝；空 patch 拒绝。

## 5. 前端页设计

**文件**：`src/web/system.html`（新增，对齐 users.html 形态）

- 顶部：attr-field 表单（站点名 input / 默认主题 select light/dark / 会话超时 number input / 安全策略 checkbox 组）
- 底部：审计日志 table（时间/场景/字段/决策ID，直查 /api/config/system/audit-logs）
- 按钮：保存（PUT）+ 取消；加载 fetch GET；setInterval(15s) 刷新审计日志
- 失败降级展示错误

**复用**：`src/web/nav.js` 加 `{ href: '/system.html', label: '⚙️ 系统设置' }`（或 ⚙）；configCenter.js 第 28 卡翻转 ready；routes.js 挂载 + 静态页

## 6. 文件清单与接线

| 文件 | 动作 | 说明 |
|---|---|---|
| `src/portal/systemSettings.js` | 新增 | 后端：GET/PUT /api/config/system + GET audit-logs（决策第0闸 + sysadmin + 字段白名单） |
| `test/web/systemSettings.test.js` | 新增 | 注入式 handler + 假 deps（对齐 userManagement.test.js 范式） |
| `src/web/system.html` | 新增 | 前端页（form + select + 审计 table） |
| `src/http/routes.js` | 修改 | import + 挂载 `createSystemSettingsRouter({})` + 静态 `/system.html` + `/portal/systemSettings.js` |
| `src/portal/configCenter.js` | 修改 | 第 28 卡 pending→ready |
| `src/web/nav.js` | 修改 | 入口 |
| `docs/superpowers/plans/2026-08-27-system-settings-config.md` | 新增 | 本设计 |

**不改**：`db/schema.sql`、`db/migrate-config.sql`、`src/page/schema.js`

## 7. 测试计划（TDD）

`test/web/systemSettings.test.js`（对齐 userManagement 21 例范式）：

1. **validateSystemSettingsPatch**（纯函数）：
   - 合法：site_name+default_theme+session_timeout + security_policy → ok
   - site_name 空 → 拒绝
   - default_theme 非 light/dark → 拒绝
   - session_timeout 非整数/越界（<60 或 >1440）→ 拒绝
   - security_policy 未知键 → 拒绝
   - 未知字段 → 拒绝
2. **handler.get**：GET → 返回当前系统设置（未配置 → 404）
3. **handler.put**：PUT → 落库 + 决策第0闸（config_change 事件）+ 非 sysadmin 403
4. **handler.getAuditLogs**：GET → 最近 N 条 config_change 决策事件（只读，无写端点）

**验证**：单测全绿 + `test/web/` 全量回归 + 真实库冒烟（GET / PUT 落库 / 审计日志直查 / 非 sysadmin 403 / config_change 计数增长——待 DB 启动）

## 8. 风险与遗留（如实标注）

- **DB 未启动**（当前 127.0.0.1:5433 连接拒绝）：单测（注入式假 deps）不受影响；真实库冒烟待 DB 起后补
- **审计日志只读**：蓝图 S33 table 是审计展示，无编辑/删除——本设计对齐（审计不可篡改，决策事件为事实源）
- **security_policy 键白名单**：仅 3 个安全键（password_min_len/mfa_required/allow_external_login），防任意 JSON 注入；未来扩展需加键白名单