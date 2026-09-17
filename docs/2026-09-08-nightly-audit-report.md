# CRM-ai-native 夜间例行检查报告

- 日期：2026-09-08 22:00（自动化任务）
- 执行方式：全程只读核查；git 提交由用户本机执行（沙箱无 git 凭证，输出分组命令）
- 结论先行：**今日 8 份设计/计划文档承诺全部落地**；git HEAD 有效但工作区有 86 项未提交；AI-10 SKILL 基线完整**无需更新**（今晨已补 ai-capability-audit 一条）；插件包 = 根目录 2 个 08-31 旧包落后，plugin/ 09-08 新包（1.6.0）与源一致。

---

## ① 设计文档落地核查（今日 8 份）

| 文档 | 承诺改动 | 落地状态 | 证据（file:line） |
|---|---|:---:|---|
| 2026-09-08-dialog-driven-decision-advice-design.md（07:10，已批准） | 8 场景×S1-S8 建议卡/ADVISED 态/method-dialog-router/拦截式五通道 | ✅ 已落地 | `src/decision/{dialogAdvisor,adviceCard,scenarioAdvisors,adviseService,adviceStore}.js`；`src/skills/seed.js:181`；`src/mcp/tools.js:70` protocolShape utterance；`src/mcp/gateway.js:117` 取出即删；`src/http/routes.js:2145-2150` from-nl；`src/action/executor.js:54-59`；`db/seed.sql:497-506` 配置键 |
| docs/plans/2026-09-08-dialog-driven-decision-advice.md（10:00） | T0-T9 实施（TDD 每任务一 commit） | ✅ 已落地（含 E2E 补记 §10） | commit 链 82f9981→2a3019d；`scripts/e2e-dialog-advice.mjs`（PORT=3100）；`test/decision/` 66 文件 398 例全绿 |
| 2026-09-08-crm-cli-connector-design.md（14:56，已批准） | CLI 连接器最小链路（call+2 语义命令/三档端点/写类前置拒） | ✅ 已落地 | `packages/crm-native-cli/`（9 commit）；`connector/cli.json`；`connector/skills/crm-cli/SKILL.md`；测试 5 文件 |
| docs/2026-09-08-crm-cli-implementation-plan.md（15:05） | T1-T9/45 步/8 commit | 🟡 部分落地（T9 待真凭据） | T1-T8 已交付（commit dff3eaf→e6946d6）；T9=用户真实凭据端到端联调 + npm publish（沙箱无凭证，属正常待办） |
| 2026-09-08-mcp-identity-governance-fix-design.md（21:24，已批准） | T1 角色闸/T2 真 PATCH+409/T3 tenant_id/T4 下拉/T5 占位 TAB | ✅ 已落地 | `src/portal/mcpIdentity.js:8,167,170,218,227,238`；`src/portal/configTabs.js:3`；`test/portal/{mcpIdentityAdminGate,mcpIdentityPatch,mcpIdentityTenant,configTabs}.test.js`；commit 链 677b7a7→03734df |
| docs/2026-09-08-mcp-identity-governance-fix-plan.md（21:23） | 5 Task TDD 计划 | ✅ 已落地（同上一行） | 提交链 677b7a7(T1)/5e07a14(T2)/8934438(T3)/d85d4bf(T4)/03734df(T5) |
| 2026-09-08-buddy-skill-benchmark.md（14:08） | 北森/电子签借鉴分析（非实现承诺） | ✅ 已交付（分析促生 crm-cli） | 结论落 `2026-09-08-crm-cli-connector-design.md`；脚本 `scripts/compare-skill-packs.mjs` |
| 2026-09-08-buddy-app-config-checklist.md（14:21） | 配置核对手册（非实现承诺） | ✅ 已交付 | 429 行手册；生成器 `scripts/gen-config-checklist.mjs` |

**落地状态说明**：8 份文档中 6 份为设计/计划性质，承诺改动**全部已落地**；2 份为调研/手册性质，无代码承诺。唯一部分落地 = crm-cli T9（真实凭据联调 + npm publish），属用户侧待办而非缺陷。

**关键实施锚点抽查**（Grep 复核通过）：
- 红线顺序判定：`adviceCard.js:40-45`（redline 最先行，维度空→C、HIGH→封顶 B、coverage<passLine→C）
- 场景装载：`adviseService.js:23` `loadScenarioRow()`（租户优先回退 system + fail-open）
- D2 零落库：`gateway.js` 取出 utterance 后立即 `delete params.utterance`
- ADVISED 不污染统计：`adviceStore.js:3,8,34`

## ② GIT 提交核查

- **HEAD 有效**：`03734df` feat(config): T5 系统级/传播 TAB 非 ADMIN 显示不可点占位 + 替代通路文案（非 unborn，无巨型根 commit 风险）
- **工作区状态**：**86 项未提交**（10 已跟踪 Modified + 76 未跟踪），非干净
- 沙箱无 git 凭证 → **未代提交**，输出分组提交命令（见下，PowerShell 可整段粘贴）

| 组 | 文件 | 说明 |
|---|---|---|
| 1. E2E 修复 | `src/decision/adviceCard.js` `src/decision/adviseService.js` `src/mcp/gateway.js` `src/mcp/tools.js` `scripts/e2e-dialog-advice.mjs` `docs/plans/2026-09-08-dialog-driven-decision-advice.md` | 对话决策建议 E2E 两缺陷修复（场景装载+档位判定+utterance 协议透传） |
| 2. 身份治理文档 | `docs/2026-09-08-mcp-identity-governance-fix-design.md` `docs/2026-09-08-mcp-identity-governance-fix-plan.md` `reports/nightly/20260908.md` | 五项修复设计与计划（实施已提交 677b7a7→03734df） |
| 3. crm-cli 计划 | `docs/2026-09-08-crm-cli-implementation-plan.md` | 实施计划文档（设计已提交 631da9a） |
| 4. 配置归属修正 | `test/propagation/permission.test.js` | id12 用户管理 F3 移租户级断言修正 |
| 5. 连接器默认端点 | `connector/token-schema.json` | MCP 端点默认值改生产 IP（SNI 拦截期间） |
| 6. Buddy 配置链 | `scripts/{build-buddy-import-zip,gen-industry-config-variants,pack-buddy-import,gen-buddy-config-v2,gen-config-checklist,gen-hero-backgrounds,zip-store,compare-skill-packs}.mjs` `buddy-app-store-listing/hero-{day,night}-1000x910.png` `docs/2026-09-08-{buddy-app-config-checklist,buddy-skill-benchmark}.md` | 一键导入包生成链 + hero 背景 + 手册 |
| 7. 演示视频素材 | `doc/event/bp/video/`（脚本+音频+截图+v1-v5） `doc/event/`（截图×7+竞品 PDF） `doc/企业AI销售决策平台介绍_2026_v2.pdf` | CRM 路演视频素材与产物 |

建议不入库：`Lanch/` `fix-tenantScopeBar-route.patch` `phase2-commit.ps1`（探查/补丁产物，按既有惯例留未跟踪）。

```powershell
# 组1 E2E 修复
git add src/decision/adviceCard.js src/decision/adviseService.js src/mcp/gateway.js src/mcp/tools.js scripts/e2e-dialog-advice.mjs "docs/plans/2026-09-08-dialog-driven-decision-advice.md"
git commit -m "fix(decision): 对话驱动决策建议 E2E 修复（场景装载+档位判定+utterance 协议透传）"

# 组2 身份治理文档
git add "docs/2026-09-08-mcp-identity-governance-fix-design.md" "docs/2026-09-08-mcp-identity-governance-fix-plan.md" reports/nightly/20260908.md
git commit -m "docs(mcp-identity): 身份签发治理五项修复设计+实施计划（T1-T5 已落地）"

# 组3 crm-cli 实施计划
git add "docs/2026-09-08-crm-cli-implementation-plan.md"
git commit -m "docs(crm-cli): 实施计划（T1-T9/TDD，含协议事实与鉴权双层解法）"

# 组4 配置归属修正
git add test/propagation/permission.test.js
git commit -m "test(propagation): id12 用户管理由 system 移租户级（F3 2026-09-06）断言修正"

# 组5 连接器默认端点
git add connector/token-schema.json
git commit -m "fix(connector): MCP 端点默认值改生产 IP（chiyuai.com SNI 拦截期间）"

# 组6 Buddy 配置链
git add scripts/build-buddy-import-zip.mjs scripts/gen-industry-config-variants.mjs scripts/pack-buddy-import.mjs scripts/gen-buddy-config-v2.mjs scripts/gen-config-checklist.mjs scripts/gen-hero-backgrounds.mjs scripts/zip-store.mjs scripts/compare-skill-packs.mjs buddy-app-store-listing/hero-day-1000x910.png buddy-app-store-listing/hero-night-1000x910.png "docs/2026-09-08-buddy-app-config-checklist.md" "docs/2026-09-08-buddy-skill-benchmark.md"
git commit -m "feat(buddy): 一键导入包生成链（样本骨架/schema 反推/hero 背景图/配置手册/借鉴分析）"

# 组7 演示视频素材
git add doc/event/ "doc/企业AI销售决策平台介绍_2026_v2.pdf"
git commit -m "docs(event): CRM 演示视频 v1-v5 素材与产物 + 路演截图 + 竞品分析"
```

## ③ AI-10 SKILL 基线核查

- **10 大基线全部存在、无缺漏、无重编号**：ai-particle-system-design / ai-ontology-vector-build / ai-context-layering / ai-memory-lifecycle / ai-native-action-design / ai-multi-agent-orchestration / ai-event-driven-evolution / ai-portal-page-generation / ai-feedback-loop / ai-capability-audit ✓
- 额外 2 个非基线目录：`ai-consultant-expert`（用户明示不在 10 大内）、`ai-bypass-process-enhancement`（既有扩展）——**未新增第 11 个基线**
- **今日通用方法论增量**：无新增。今晨 06:4x 第五次执行已给 `ai-capability-audit` 补强「遗留存储退役收口审计」三判据（今日唯一 SKILL 变更，已完成）。今晚工作中产生的洞察（MCP 协议级参数 zod strip 陷阱 / E2E 断言须验 ok===true / 空集合陷阱 / 安全判定顺序）均为工程实践教训，属 CRM 决策域实施记录，已写入项目工作记忆，**不属跨域方法论** → **无需更新**

## ④ 插件包核查

| 包 | 状态 | 差异摘要 |
|---|---|:---:|---|
| 根目录 `crm-native-plugin.zip` / `crm-native-agent.zip`（08-31 14:05） | 🔴 落后 | 内容为 08-26/08-31 版，**无 `crm-decision-advise`**（grep 0 vs 新包 3）；缺 1.6.0 决策建议能力、缺 crm-cli SKILL |
| `plugin/crm-native-plugin.zip`（09-08 10:08） | 🟢 一致 | 1.6.0，含 `crm-decision-advise`×3 处（SKILL.md 意图路由 + 读清单 + agents 映射）；与 `.workbuddy-plugin/` 源一致（verify-plugin-zips.py 已绿）；md5 差异仅 plugin.json 归一化（预期内） |
| `plugin-platform-admin/`（09-05） | 🟢 一致 | skills 4 个（industry-onboarding / platform-ops-insight / system-bootstrap / user-rbac-admin）；今日无改动，不落后 |

**建议**：无需重新打包——`plugin/crm-native-plugin.zip` 已是最新事实源（根目录 08-31 旧包为历史遗留，工作日志已记待用户处置，可忽略或删除）。注意记忆铁律：**新增对外 MCP 工具必须同步插件包**，本次已同步（1.5.0→1.6.0 + verify 脚本期望版本已更新）。

## 风险与待处置清单

| # | 事项 | 状态 |
|---|---|:---:|
| 1 | 工作区 86 项未提交（上方 7 组分批命令） | ⏳ 待用户本机执行 |
| 2 | `crm-cli` T9 端到端联调 + `npm publish`（需真实凭据） | ⏳ 用户侧待办 |
| 3 | `connector/connector-meta.json` type=mcp 与 cli.json 并存不一致（CLI 型安装时 init 不被消费） | ⚠ 待定夺 |
| 4 | `.workbuddy-plugin/agents/crm-native.md:23` 声明仅 MCP 通道，与 crm-cli SKILL 并存 → 需在 dispatch.md 定意图优先级 | ⚠ 待定夺 |
| 5 | 生产 nginx Basic Auth 凭据 admin/union998 已失效 | ⚠ 记忆待更新 |
| 6 | 根目录 08-31 旧 zip 陈旧（含 crm-native-plugin.zip / crm-native-agent.zip） | ⏳ 待用户处置 |
| 7 | 演示视频 v2 截图内容映射为默认假设，需逐张复核 | ⏳ 待复核 |

## 阻塞记录

- **无阻塞**。PG 与 git 均健康（HEAD 03734df 有效）；git 提交按既定契约由用户本机执行（沙箱无凭证，不代提交）。
