# 2026-09-09 夜间例行检查报告（CRM-ai-native · 6 项完整版）

- 执行时间：2026-09-09 22:01–22:4x（自动化例行任务，升级后首跑）
- 自动化任务：`a8722c99-e25b-4a32-bf0d-aa2452ce8b4c`（2026-09-09 22:10 重建，每晚 22:00，**6 项**）
- HEAD：`8a8235b feat(billing): 租户管理操作台 冻结/解冻/延期/退订/改套餐/分配画像 + 订阅行业列（第0闸+system保护+软退订）`（用户本机提交）
- 工作区：**139 项未提交**（31 M + 108 ??，含 Lanch/D/素材等不入库项），仓库健康（objects/pack 完整、HEAD 有效、无暂存）

---

## ① 设计文档落地核查

今日 docs/ 新增/修改文档 30+ 份（含 patents/ 子目录）。设计/方案/计划性质 8 份逐一核验：

| 文档 | 承诺改动 | 落地状态 | 证据（file:line） |
|---|---|---|---|
| 2026-09-09-approval-failure-and-write-side-fix-design.md | 审批判定顺序还原（ROLE 优先于 AUTO_PASS）+ approvers 透传 + 链长 fail-closed | ✅ 已落地（HEAD 0492fa5） | src/approval/engine.js:74-91 resolveApprovers 重排；:132 透传 approvers；seed-actions.js:1277 |
| 2026-09-09-mcp-particle-update-expose-design.md | data-particle-update mcpExpose opt-in + tenantId 透传 + PARTICLE_UPDATE 场景 | ✅ 已落地（HEAD 7f3bea4） | src/action/seed-actions.js:612-628；db/seed.sql:320-325；migration-particle-update-scenario.sql |
| 2026-09-09-follow-stage-filter-fix-design.md | isOpenStage 单一事实源 + workbenchRouter/routes 孪生双改 | ✅ 已落地 | src/sales/stageTaxonomy.js:30-38；src/http/workbenchRouter.js:24,188；routes.js:1617-1620 |
| 2026-09-09-quote-policy-and-requirement-grading-design.md | offerPolicyFacts/offerPolicyMath 共享层 + 折扣授权矩阵 + approval_prefill + MUST 分级 | ✅ 已落地（HEAD a516ce4/eb5f630/108222e） | src/decision/offerPolicyFacts.js、offerPolicyMath.js、requirementConditions.js；policyVersion.js:32 price-authority 入 POLICY_KEYS |
| 2026-09-09-tenant-default-free-subscription-design.md | ensureDefaultSubscription 幂等 + 开通入口接入 | ✅ 已落地（HEAD 1b042d2/94c1b20） | src/billing/subscriptionService.js:116；db/seed/tenantDefaults.js:76 |
| 2026-09-09-tenant-admin-design.md + tenant-admin-plan.md | 6 端点 tenant-admin/* + 行业画像列 + 前端操作列 + 模板沉淀脚本 | 🟡 **已实现，待用户提交**（主体已入库于 8a8235b；补交付物未入库） | src/http/billingRoutes.js:291-385；admin-billing-console.html:295-567；**templates.mjs / tenantAdmin.test.js 未入库** |
| docs/superpowers/plans/2026-09-09-quote-policy-and-requirement-grading.md | 9 任务（T1-T9） | 🟡 **T8/T9 已实现，未入库** | seed-actions.js（工作区 M：crm-followup-requirement-collect + redline_basis 守卫）；t8-t9-wiring.test.js 未入库 |
| docs/superpowers/plans/2026-09-09-tenant-default-free-subscription.md | 3 文件 | ✅ 已落地（1b042d2） | 同上 |

**未落地差距**：租户管理操作台主体已由用户提交（8a8235b），剩余补交付物（`db/seed/tenant-profile-templates.mjs`、`test/billing/tenantAdmin.test.js`、`test/action/t8-t9-wiring.test.js`、`db/migration-requirement-collect-scenario.sql` 及配套 seed.sql/test-setup.sql/seed-actions.js 改动）均**已实现待提交**，非功能缺口。

---

## ② GIT 提交检查

- HEAD `8a8235b` 有效；工作区 139 项未提交（31 M + 108 ??），无暂存改动。
- **对比首轮（135 项）**：检查期间用户本机新增提交 `8a8235b`（租户管理操作台功能线），净增 4 项为检查期间新产物。
- 未代提交（沙箱无 git 凭证），命令见末节按功能线 6 分组（显式路径 add、禁 git add -A）。

---

## ③ GitHub 推送检查（2026-09-09 新增项）

- **执行结果**：沙箱内 `git push origin HEAD:main` **挂起 2m6s 被终止**——非交互环境在等待 GitHub 凭据输入（无快速失败输出），确认沙箱无 github.com 凭证、无法代推（属预期）。
- **仓库现状**：remote origin 已配置为 `https://github.com/chuanvanwang-arch/ChiYuAI`（fetch+push）；**当前分支 `feat-multi-industry-meta-model`**（非 main），已有上游跟踪 `origin/feat-multi-industry-meta-model`，**领先 73 个提交** → 直接 `git push` 即可更新远程分支。
- **待用户执行**（PowerShell，本机；若未配置凭据会弹窗登录，Git Credential Manager 记忆一次）：
  ```powershell
  cd D:\system\CRM-ai-native
  git push
  # 推当前分支 feat-multi-industry-meta-model（已有上游跟踪，无需 -u）
  ```
- **注意**：生产直推模式（zip 打包 + SSH）**不依赖 GitHub**，push 仅作版本归档，失败不阻塞当晚发布。

---

## ④ AI-* 10 SKILL 基线检查

- 今日 `~/.workbuddy/skills/ai-*` 无文件修改；10 个方法论 SKILL 完整（无增删改编号）。
- 今日产出（审批判定顺序还原、mcpExpose 收敛、种子直跑守卫、quote-policy 断链接入、T8/T9 接线）均为**平台具体实现**，无新的跨域通用方法论增量。
- 种子直跑守卫已正确落入领域 SKILL（`plugin-platform-admin/skills/industry-onboarding` + `new-industry-onboarding`），符合 10 大 SKILL 内容边界。
- 结论：**无需更新**。

---

## ⑤ 插件包一致性检查

| 插件包 | 状态 | 差异摘要 |
|---|---|---|
| 根目录 crm-native-plugin.zip（08-31） | 🔴 落后 | 旧基线（缺 09-05 后工具），历史产物 |
| 根目录 crm-native-agent.zip（08-31） | 🔴 落后 | 同上 |
| plugin/crm-native-plugin.zip（09-09 11:31） | ✅ 一致（1.7.1） | 内 SKILL.md md5 == 根 skills/crm-native/SKILL.md；verify 全绿 |
| **plugin-platform-admin.zip（09-09 21:21）** | 🔴 **落后（重跑新发现）** | zip 内 `skills/industry-onboarding/SKILL.md` md5=`7de56906…` ≠ 源码 `0904963e…`（源码含「tenantId 必传参数化 + 真实租户 ID 警示」3 处新修订，zip 内 0 命中） |

- **修正首轮结论**：首轮（22:08）判 platform-admin 「✅ 最新」，重跑逐一 md5 比对发现**首轮判断错误**——升级 6 项后逐文件核验：首次接入引导（21:21 已打进）在，但**行业接入 tenantId 修订（22:0x 后写入源码）未重打包** → **zip 落后源码**。
- **建议**（未授权不擅自打包，仅列命令）：
  ```powershell
  cd D:\system\CRM-ai-native
  python scripts/pack-platform-admin-plugin.py
  python scripts/verify-plugin-zips.py
  ```
- 注：platform-admin 打包真相源是 `.codebuddy-plugin/plugin.json`（非 openclaw.plugin.json/package.json），版本 1.1.1 不变则 verify 无需改 expect_version。

---

## ⑥ 生产版本对比与更新建议（2026-09-09 新增项）

### 生产探针结果（只读，SSH 81.70.184.198 / deploy-remote.py exec）

| 检查项 | 本地 | 生产 | 结论 |
|---|---|---|---|
| 部署时间 | — | **2026-09-07 07:06**（src/db/docs 目录 mtime） | 落后约 2 天 |
| package.json version | `0.1.0` | `0.1.0` | 相同（版本号无参考价值） |
| crm-followup-requirement-collect（T9） | 2 处（seed-actions.js） | **0** | 🔴 未上生产 |
| tenant-admin 端点（租户管理操作台） | 7 处（billingRoutes.js） | **0** | 🔴 未上生产 |
| REQUIREMENT_COLLECT 场景 | 2 处（seed.sql） | **0** | 🔴 未上生产（注：生产库场景行已于 16:16 手工迁移插入） |
| 容器/HTTP | — | 3 容器 healthy + HTTP 200（04:00 探针复用） | ✅ 在线 |

### 结论

- **生产落后约 2 天**（本地 09-07 07:06 之后的改动全未上线，含今日全部 8 项设计落地 + T8/T9 + tenant-admin）。
- 生产方式 = **本机 zip 打包 → SSH 上传 → 服务器重建**（crm-prod-release SKILL / deploy-remote.py release），**不经 GitHub**。
- **更新**：属发布动作，需用户授权后执行 `python scripts/tencent-lighthouse-deploy/deploy-remote.py release --password-file %TEMP%\crm_ssh.pwd`（会自动打包+上传+重启）。深夜自动化**不代执行**发布（HITL 铁律），仅报告差异。

---

## 待用户执行清单（汇总）

### A. GIT 分组提交（PowerShell，显式路径 add，禁 git add -A）

**Commit 1 — T8/T9 报价政策收尾（quote-policy 功能线）**
```powershell
git add db/migration-requirement-collect-scenario.sql db/seed.sql db/test-setup.sql
git add src/action/seed-actions.js src/agent/agentSpec.js src/skills/seed.js
git add test/action/t8-t9-wiring.test.js test/particles/particleRepo.tenant.test.js
git commit -m "feat(decision): 报价政策T8红线溯源守卫+T9需求证据采集接线（REQUIREMENT_COLLECT场景）"
```

**Commit 2 — 租户管理操作台补交付物 + 种子签名改造（tenant-admin 功能线）**
```powershell
git add db/seed/tenant-profile-consult2.js db/seed/tenant-users-consult2.js
git add db/seed/tenant-profile-templates.mjs
git add db/seed/tenant-profile-chemical.js db/seed/tenant-profile-consult.js db/seed/tenant-profile-demo.js
git add db/seed/tenant-profile-insmedi.js db/seed/tenant-profile-meddev.js db/seed/tenant-profile-training.js
git add db/seed/tenant-users-consult.js db/seed/tenant-users-meddev.js
git add src/http/billingRoutes.js src/web/admin-billing-console.html
git add test/billing/tenantAdmin.test.js
git commit -m "feat(billing): 租户管理操作台6端点+行业画像分配+前端操作列+模板沉淀脚本"
```

**Commit 3 — 平台面修复（configTabs 登记 + ICP + 上线链接）**
```powershell
git add src/http/routes.js test/propagation/permission.test.js
git add src/web/landing.html doc/sales-platform-base-intro.html
git add docs/2026-09-09-icp-definition.md docs/2026-09-09-pptx-v4-simplification-notes.md
git commit -m "feat(portal): configTabs路由登记修复+landing ICP区块+上线体验链接"
```

**Commit 4 — 连接器/部署配置**
```powershell
git add connector/token-schema.json
git commit -m "chore(connector): MCP默认端点改生产地址 http://81.70.184.198/mcp"
```

**Commit 5 — 文档与计划沉淀**
```powershell
git add docs/2026-09-09-tenant-admin-design.md docs/2026-09-09-tenant-admin-plan.md
git add "docs/superpowers/plans/2026-09-09-quote-policy-and-requirement-grading.md"
git add "docs/superpowers/plans/2026-09-09-tenant-default-free-subscription.md"
git add docs/2026-09-09-mcp-particle-update-expose-design.md docs/2026-09-09-follow-stage-filter-fix-design.md
git add docs/2026-09-09-approval-failure-and-write-side-fix-design.md
git add docs/2026-09-09-tenant-default-free-subscription-design.md
git add docs/2026-09-09-jie-bang-gua-shuai-content.md
git add docs/2026-09-08-nightly-audit-report.md docs/2026-09-09-nightly-audit-report.md
git add "docs/plans/2026-09-08-dialog-driven-decision-advice.md"
git commit -m "docs: 当日设计/实施计划/调研文档沉淀"
```

**Commit 6 — 专利申报材料（独立提交）**
```powershell
git add "docs/2026-09-09-patent-A-disclosure-and-implementation.md" "docs/2026-09-09-patent-A-wechat-disclosure-comparison.md"
git add "docs/2026-09-09-patent-ARCH-assessment.md" "docs/2026-09-09-patent-F-KMD-assessment.md"
git add "docs/2026-09-09-patent-G-ontology-write-time-assessment.md" "docs/2026-09-09-patent-H-dual-view-assessment.md"
git add "docs/2026-09-09-patent-additional-recommendations.md" "docs/2026-09-09-patent-tech-disclosure-kit.md" docs/patents/
git commit -m "docs(patent): A/B专利申报材料与评估文档"
```

**不建议入库**：Lanch/、D/、.tmp_clv9.txt、fix-*.patch、phase2-commit.ps1、doc/event/bp/video/ 素材（mp3/脚本）、hero-*.png（生成素材）、reports/nightly/（报告在 docs/ 沉淀）。

### B. GitHub 推送（需用户本机执行）
```powershell
cd D:\system\CRM-ai-native
git push -u origin main
```

### C. 插件包重打包（需用户授权后执行）
```powershell
cd D:\system\CRM-ai-native
python scripts/pack-platform-admin-plugin.py
python scripts/verify-plugin-zips.py
```

### D. 生产更新（需用户授权，HITL；不做则不阻塞）
```powershell
cd D:\system\CRM-ai-native
python scripts/tencent-lighthouse-deploy/deploy-remote.py release --password-file "$env:TEMP\crm_ssh.pwd"
```

---

## 风险/待办清单

1. 🔴 **plugin-platform-admin.zip 落后源码**（industry-onboarding tenantId 修订未重打包）——今晚首次发现，建议先重打包。
2. 🟡 生产落后约 2 天（09-07 07:06 后全部改动未上线，含 8 项设计落地 + T8/T9 + tenant-admin）——需用户授权 release。
3. 🟡 工作区 139 项待提交（分 6 组命令已给出）。
4. 🟡 生产 `decision_scenario` PK 单列 vs 测试库复合约束漂移（已记录，建议补 `(scenario_id, tenant_id)` 唯一约束）。
5. ⚪ 根目录 2 个 08-31 旧 zip 落后，建议清理避免误用。
6. ⚪ connector-meta.json type=mcp 与 cli.json 并存不一致（前日记录，未处理）。
