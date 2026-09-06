# 前端编码规范（2026-08-27 · UI 统一 + 导航收敛配套）

- 依据：docs/specs/2026-08-27-ui-nav-standards-design.md §3
- 状态：已落地（与 G1–G6 改造同步验收）

## 1. 数据读取（统一 api.js）

- 统一封装：`src/web/api.js`（`get/post/put`；自动 `Authorization` 头、JSON、401 跳登录、错误抛掷）。
- 页面只调 `api.get/post/put`；读直连不经第 0 闸（仅写经决策闸）。
- 禁散乱裸 `fetch` 手拼 Authorization（存量页面已分批收口；遗留的特例保持 401 兜底语义）。

## 2. 按钮定义

- 唯一 `.btn / .btn.primary / .btn.ghost / .btn.danger` + loading/disabled 态。
- 文案业务化（「创建商机」而非 action 名）；禁用裸 `alert()`，统一 toast。

## 3. 字段规范

- `payload.stage` 六段枚举白名单：`lead / opportunity / quoted / contracted / ordered / paid`；拒绝 `leads` 类脏值（后端 400 拦截）；未知值渲染「未分类」兜底，不静默丢弃。
- `state` = 粒子生命周期（ACTIVE 等），与业务 `stage` 严格分离；禁止把 stage 写进 state。
- 字段驼峰命名；金额 NUMBER、日期 ISO8601；统一 `esc()` 防注入（`[&<>"']`）。

## 4. 新增真实写通道

- 新增 `POST /api/particles`（经 executor 第 0 闸 `requireDecision`）+ 前端「＋新建」→ 确认 → 提交 → 刷新。
- 配置类写统一前置 `requireDecision`（无先例升级人工，审批流消费）。

## 5. 错误处理

- 统一 toast 提示条；禁裸 `alert()`；网络/HTTP 错误走统一兜底文案。

## 6. RBAC 守卫

- 系统页（配置中心/智能体中心）路由层 `requireAdminRole`（admin 独享，非 admin 403 并跳回首页）。
- `layout.js` 菜单按 `/api/auth/me` 角色过滤「系统」分组（`layoutMenu.js` `menuFor(role)`）。
- ⌘K 命令面板对非 admin 隐藏系统页条目；顶栏头像用户菜单系统项仅 admin。

## 落地记录（2026-08-28）

- G1/G2：全页内嵌 `<style>` 硬编码色收敛为 `var(--*)` token；`/web/` 误链修正为 `/portal/`。
- G3：39 页统一引 `api.js`，安全惯用法收口（`node --check` 逐页校验）。
- G4：配置中心改为 3 组 Tab（系统设置/业务规则/集成与资产），9 单页并入组内可编辑入口。
- G5：⌘K 命令面板（导航第二入口 + RBAC 过滤系统组）。
- G6：nav.js 死代码移除（路由下线 + 文件删除 + 测试更新）。