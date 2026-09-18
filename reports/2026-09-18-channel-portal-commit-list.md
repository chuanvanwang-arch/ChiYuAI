# 渠道门户归位 + 经销商联邦 —— 提交清单（2026-09-18）

> 用户裁定：「渠道管理放入后台配置，前台叫渠道门户」。E2E 冒烟已全绿，以下为按功能线分组的显式 add 提交命令（PowerShell 兼容，禁 `git add -A`）。

## E2E 冒烟结果

| 验证项 | 结果 |
|---|---|
| configCenter.test（含 #57 守卫） | 25/25 ✅ |
| layoutMenu.test（含移出+防孤岛守卫） | 13/13 ✅ |
| dealerRoutes + sharedView | 6/6 + 2/2 ✅ |
| configCenterNavSync / rbac / federation | 2/2 / 7/7 / 25/25 ✅ |
| portal 全量 | 98/98 ✅ |
| 集成联调 integration-dealer-portal.mjs（真实 DB） | **15/15** ✅ |
| ui-lint channel-admin.html | **零违规** ✅ |
| buddy-capsule-binding-check | 30/0 ✅ |
| manifest JSON / node --check | 合法 ✅ |

## 归位内容（本轮 7 文件）

1. `src/portal/configCenter.js`：#57「经销商门户开关」卡片正位（平台与访问组、id 升序、level=system、endpoint=`/api/config/feature:dealer-portal`、deep-link `/channel-admin.html#overview`）
2. `src/web/config.html`：「平台与访问」白名单补 57
3. `test/web/configCenter.test.js`：46 项断言 + #57 卡片守卫
4. `src/portal/layoutMenu.js`：「渠道管理」侧边栏项移除（FULL_MENU 回 10 项）
5. `test/portal/layoutMenu.test.js`：守卫改为「移出 + #57 deep-link 可达」
6. `buddy-crm-manifest.json`：channel workMode「渠道管理」→「渠道门户」+ 4 胶囊设置页引用同步
7. `src/web/channel-admin.html`：title/h1/页内文案「渠道管理」→「渠道门户」（前台名；后台能力域标签「【渠道管理行业规则】」保留）

---

## 提交分组（按功能线，每 Task 一 commit）

> ⚠ 整个经销商联邦功能线（T1–T8 + 本轮归位）从未提交过；`src/http/server.js` 是**混合文件**（联邦接线 + embeddingBootstrap 重构=另一功能线 L1 消费面修复），需 `git add -p` 分段或按主变更归类。

### C1 联邦核心与渠道接入面（T1–T6 内核）

```powershell
git add src/federation/config.js src/federation/conflict.js src/federation/read.js src/federation/scope.js
git add src/http/dealerRoutes.js
git add src/rbac.js src/context/roleProfiles.js src/agent/agentSpec.js src/agent/contractIds.js src/http/routes.js
git add db/seed/tenant-profile-manufacturing.js
git commit -m "feat(federation): 经销商联邦 T1-T6 内核——1:N 跨租户只读授权(federationReadScope) + 撞单检测/仲裁 + channel-agent + manufacturer 分销模型种子"
```

> 注：`src/http/server.js` 的联邦接线（import createDealerRouter + app.use）与本轮 C1 相关；但该文件同时含 embeddingBootstrap 重构。若整文件提交，C1 消息改为：「feat(federation): … + server 接线」；embedding 重构部分随后在 L1 消费面修复提交中说明（已在文件内，无丢失）。

### C2 联邦测试与集成联调

```powershell
git add test/federation/config.test.js test/federation/conflict.test.js test/federation/inert.test.js test/federation/read.test.js test/federation/scope.test.js
git add test/http/dealerRoutes.test.js test/http/dealerRoutes.sharedView.test.js test/rbac.test.js
git add scripts/integration-dealer-portal.mjs
git commit -m "test(federation): 联邦 25 测试 + dealerRoutes 8 测试 + rbac 7 测试 + 端到端联调脚本(15/15 真实 DB)"
```

### C3 Buddy 渠道门户模式（T7）

```powershell
git add buddy-crm-manifest.json
git add assets/modes/mode-channel.svg assets/capsules/dealer-onboard.svg assets/capsules/shared-view.svg assets/capsules/conflict-monitor.svg assets/capsules/channel-policy.svg
git commit -m "feat(buddy): 渠道门户 workMode（channel）+ 4 经销商胶囊 + 5 图标（改名归位：渠道管理→渠道门户）"
```

### C4 渠道门户设置页（T8 + 归位文案）

```powershell
git add src/web/channel-admin.html
git commit -m "feat(web): 渠道门户设置页（5 TAB：总览/准入/列表/共享视图/撞单监控；前台名=渠道门户，ui-lint 零违规）"
```

### C5 配置中心 #57 经销商门户开关 + 侧边栏归位

```powershell
git add src/portal/configCenter.js src/web/config.html src/portal/layoutMenu.js
git add test/web/configCenter.test.js test/portal/layoutMenu.test.js
git commit -m "feat(config): 渠道管理归位——配置中心 #57 经销商门户开关卡（平台级 kill-switch）+ 白名单同步 + 侧边栏移出 + 防孤岛守卫"
```

---

## 其它工作区未提交项（非本功能线，勿混入上列提交）

以下文件在工作区有改动，但**不属于经销商联邦功能线**，提交时按各自功能线另行处理（本次不覆盖）：

- `src/llm/embeddingBootstrap.js`（未跟踪，L1 消费面修复）
- `src/http/server.js` 的 embedding 重构段（混合，见 C1 注）
- `test/context-l1-query-vector.test.js`、`test/decision/retroPromote.js` 等（L1 修复/复盘线）
- `doc/参赛2/*`、`doc/event/*` 等文档/申报材料（独立线）
- `scripts/verify-*.mjs` 等本轮之外验证脚本（按各自归属）

> 铁律提醒：每 Task 一 commit、禁 `git add -A`、禁 `--no-verify` 反复绕过；无凭证禁 push。提交前建议先 `git status` 盘点（当前工作区有大量其它线未提交改动，务必显式路径 add）。
