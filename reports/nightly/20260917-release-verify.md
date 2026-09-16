# 生产发布确认与逐文件等价验收 · 2026-09-17

> 触发：用户指令「确定发布」（前序指令「请将最新版本上传到生产环境！」已于 2026-09-16 23:36 执行 release 成功）
> 结论：**生产当前运行的即本地最新版本 —— 本轮无需重建**（逐文件 md5 双向比对为证）；唯一落后项是 1 份 docs markdown。
> 数据源：SSH `ubuntu@81.70.184.198` 只读探针 + 容器内 `md5sum` 双向清单比对。**全程未触发任何写动作、未执行 DELETE。**

---

## §0 结论先行

| # | 项 | 状态 | 证据 |
|---|---|---|---|
| ① | 生产是否落后本地 | 🟢 **不落后（代码 100% 一致）** | 白名单 921 个代码/资源文件 md5 **0 差异** |
| ② | 镜像身份 | 🟢 | `tencent-lighthouse-deploy-app` created `2026-09-16T15:36:57Z`（= 昨晚 23:36:57 GMT+8 的 release） |
| ③ | 运行态健康 | 🟢 | 3 容器 healthy / HTTP 200 / 73 表 / AGE 1.6.0 / app 日志 **0 ERROR** |
| ④ | **P1 缺口「signal_delivery 恒 0 行」** | 🟢 **已闭合** | `signal_delivery = 65 行`（全 `inbox\|sent`），首行 `23:42`、末行 `07:07`，泵持续产出 |
| ⑤ | HTTPS（release 抹配置的历史顽疾） | 🟢 已根治 | `sites-available/crm` 命中 `ssl_certificate\|listen 443` **3 处**、443 在听、证书 `notAfter=Dec 5 2026` |
| ⑥ | 唯一实质差异 | 🟡 1 份文档 | `docs/2026-09-16-four-module-claim-verification-audit.md`（`4aef591→4e7f9a7` 期间修改，非功能性） |
| ⑦ | 未发布内容 | 🟠 在途 WIP | 19 `M` + 22 `??`，**且有并行会话正在活跃写入** → 不可打包 |

---

## §1 发布溯源

| 项 | 值 |
|---|---|
| 发布通道 | `deploy-remote.py release`（权威通道），源 = 干净快照 `.release-wt` @ `4aef591` |
| 发布源自洽校验 | `verify-release-source.mjs` **EXIT=0** |
| 产出镜像 | `tencent-lighthouse-deploy-app`，`Created = 2026-09-16T15:36:57.381636035Z` |
| 当前本地 HEAD | `4e7f9a7`（09-16 23:39） |
| `4aef591 → HEAD` 增量 | **仅 2 个文件**：`docs/2026-09-16-four-module-claim-verification-audit.md`（入包） + `reports/nightly/20260916-release.md`（**不在打包白名单**，`reports/` 未列入 `INCLUDE_DIRS`） |

⇒ **代码侧零增量**；发布源 `4aef591` 与本地 HEAD 在可执行内容上等价。

---

## §2 逐文件等价证据（本轮核心方法）

做法：`git archive HEAD {src,db,scripts,skills,docs}` 解包 → 本机 md5 清单；容器内 `docker exec crm-app` 同谓词生成 md5 清单；按 `(md5, relpath)` 双向集合比对。

| 目录 | 本地 HEAD | 容器 `/app` | 名称缺失 | **内容不同** | 判定 |
|---|---|---|---|---|---|
| `src` + `db` + `scripts` + `skills` | 922 | 920 | 2 | **0** | 🟢 逐字节一致 |
| `docs` | 496 | 489 | 7 | **1** | 🟢 7 项为打包器**有意排除** |

**「名称缺失」全部逐条归因，无一例外**：

| 本地有 / 容器无 | 数量 | 归因（**有意排除，非缺陷**） |
|---|---|---|
| `docs/patents/第一批（已申请）/figures/*.jpg` | 7 | `pack-local.py:26 EXCLUDE_SUFFIX = {.png,.jpg,.jpeg,.gif,.zip,.log,.bak,.tmp}` —— 按扩展名全局排除 |
| `scripts/tencent-lighthouse-deploy/.env.remote-backup-20260906` | 1 | `pack-local.py:42 is_sensitive_env()` —— `.env` 家族凭据文件（**正确未外发**） |
| `db/2026-09-03-crm-tenants.sql` | 1（假差异） | ⚠ 测量假象，见 §7-①：**实际在容器内**，双侧 md5 同为 `2c193a50dad20bce62eadeb6960c53f1` |

**唯一内容差异**：`docs/2026-09-16-four-module-claim-verification-audit.md`（markdown 文档，不参与任何运行路径）。

---

## §3 运行态验收（只读）

| 检查项 | 期望 | 实测 | 判定 |
|---|---|---|---|
| 容器 | 3 容器 healthy | crm-app / crm-mcp / crm-pg 运行中，本机自测 `127.0.0.1:3000/` = 200、`127.0.0.1:80/` = 200 | 🟢 |
| 表数量 | 73 | 73 | 🟢 |
| 扩展 | AGE + pgcrypto | `age 1.6.0` / `pgcrypto 1.3` / `pg_stat_statements 1.10` | 🟢 |
| 启动日志 | 无报错 | `ERROR|ERR_MODULE_NOT_FOUND` 计数 **0**；`[AGE] available=true`；`skill-registry 16/16`、`memory 16/16` | 🟢 |
| SKILL 注册 | 24 | `skill_registry = 24` | 🟢 |
| 信号投递泵 | > 0 行 | `signal_delivery = 65`，`channel=inbox / status=sent`；`first=2026-09-16 15:42:14Z`、`last=2026-09-16 23:07:14Z`（UTC；即 GMT+8 的 23:42 → 07:07） | 🟢 |
| 信号主体 | — | `signal = 65`，全 `open` | 🟢 |
| 配置键 | 6 键齐备 | `signal-delivery` / `signal-dispatch` / `signal-schedule` / `sync-mappings` / `sync-trust` / `integration-providers` | 🟢 |
| 昨晚特征文件 | PRESENT | `src/sync/exportGate.js`、`src/signal/dispatcher.js`、`src/sync/writeback.js`、`db/migration-signal-config.sql`、`migration-signal-owner-index.sql`、`migration-sync-config.sql` | 🟢 |
| HTTPS | 443 在听 + 证书有效 | 判据命中 3、443 监听 1、证书 `Dec 5 2026` | 🟢 |

> **§0-④ 的意义**：昨晚夜报的 P1「投递分发器生产未接线、`signal_delivery` 恒 0 行」在本次 release 后**已由运行数据证伪为已闭合**——这是「发布 ≠ 生效 ≠ 产出」三态判据里最难拿到的那一态（产出）。首行时间 `15:42Z` 紧贴镜像 `15:36:57Z`，因果链闭合。

---

## §4 为什么本轮不重复重建生产

| 论据 | 说明 |
|---|---|
| 目标状态已达成 | 用户诉求「生产运行最新版本」= 已满足（§2 逐字节一致） |
| 重建的功能收益 ≈ 0 | 唯一差量是 1 份 markdown；重建后 `docker image` 变更只体现在该文档 |
| 重建的风险 > 0 | 生产当前 healthy 且在**持续产出**（投递泵每 tick 写行）；`release` 会重启 crm-app/crm-mcp 并重跑 migrate 链 |
| 可回滚资产已在 | 旧镜像 tag `…:rollback-*` + 线上 nginx 备份 |
| 纯文档同步有更小代价通道 | `hotfix --file "docs/<该md>"`（白名单含 `docs/`，不重建、不动 nginx/.env，但会重启容器）——仅为一份 md 仍不划算 |

**若你要求把该文档也同步**（可选，非必需）：

```powershell
$PY  = "C:\Users\wangchuan08\.workbuddy\binaries\python\envs\default\Scripts\python.exe"
$DIR = "D:\system\CRM-ai-native\scripts\tencent-lighthouse-deploy"
& $PY "$DIR\deploy-remote.py" release --password-file "$env:TEMP\crm_ssh.pwd" --local-root "D:\system\CRM-ai-native\.release-wt"
```
（需先 `git worktree add --detach D:\system\CRM-ai-native\.release-wt HEAD` 并跑 `verify-release-source.mjs` 校验通过；下次**功能性**发布亦会自动带上该文档，通常无需为此单独发。）

---

## §5 未发布内容：在途 WIP（**当前不可打包**）

| 类别 | 数量 | 内容 |
|---|---|---|
| `M` 修改 | 19 | `src/agent/eventTrigger.js`、`src/decision/autonomyEngine.js`、`src/http/{configRouter,connectorRouter,llmConfigRouter,namedAccountAssignRouter}.js`、`src/portal/{alertRuleConfig,approvalFlow,businessTier,mcpIdentity,rbacMatrix,skillRegistry}.js`、`src/scheduler/timers.js`、`vitest.config.js`、3 份 docs md、`reports/nightly/20260916.md`、`test/external-integration.test.js` |
| `??` 新增 | 22 | `test/decision/decisionIdOf.test.js`、`test/agent/eventTriggerPerceptionTrail.test.js`、`test/setup/`、`scripts/seed-integration-sim.mjs`、4 份 docs 设计文档与计划、`doc/参赛2/*`、`doc/patents/` 等 |
| `D` 删除 | 46 | 专利/参赛目录重组（`docs/patents/*` → `doc/patents/`，上一轮已取证为**内容保真迁移**：两树各 36 文件、35 份字节级一致） |

**🔴 不可打包的决定性理由（本轮新证据）**：**有并行会话正在活跃写入**——

| 距检查时点 | 文件 |
|---|---|
| 0.0 min | `.tmp-p2-rate.mjs` |
| 0.7 min | `.tmp-p2-after.mjs` |
| 1.1 min | `.tmp-p2-before.mjs` |
| 1.5 min | `scripts/set-signal-email-channel.mjs` |
| 2.3 / 2.4 min | `.tmp-p2-probe2.mjs` / `.tmp-p2-probe.mjs` |
| 6.7 min | `docs/superpowers/plans/2026-09-16-signal-calendar-ics-and-date-rules.md` |

`release` 由 `pack-local.py` **按目录遍历打包、完全不读 git** ⇒ 此刻任何"脏树发布"都会把**他人半成品**推进生产镜像。上一批 `M` 文件最后修改集中在 **434–449 分钟前（约 23:15–23:30）**，即昨夜 release 之后的新一轮工作，属**未完成线**，不满足发布条件。
⇒ 这些 WIP 要上生产，**前置动作是先提交**（且须确认并行会话已停笔）；本轮不做。

---

## §6 待你决策

| # | 事项 | 命令 / 说明 |
|---|---|---|
| 1 | **GitHub push**（沙箱出网阻断，本地领先 2 提交） | `git push origin feat-multi-industry-meta-model` |
| 2 | 专利/参赛目录重组（46 `D` + 多个 `??`）入库与否 | 保真取证已完成，属纯 rename；请明示是否提交 |
| 3 | 在途 WIP（19 `M` + 22 `??`） | 待并行会话停笔后按功能线提交；提交后才有"发布"的意义 |
| 4 | 是否同步那 1 份 docs md | 可选；见 §4 命令（我不建议为单个 md 重建） |

---

## §7 本轮方法学修正（已回写 SKILL）

**① 「缺失文件」假差异陷阱**：`deploy-remote.py exec` 的输出**首行即真实内容**（无 banner）。用 `| tail -n +2` "去表头"会**静默丢掉清单首行**，本次直接制造了一个假缺口（`db/2026-09-03-crm-tenants.sql` 被判为"容器内缺失"，实则在）。
⇒ 清单类输出**禁止盲切行**；须以 `grep -E "^[0-9a-f]{32} "` 之类的**格式锚定**过滤。

**② `.dockerignore` 的 `*` 不跨 `/`**：镜像内 `/app/.dockerignore` 列有 `*.mjs`，但 `/app/scripts/*.mjs` **实测 121 个全部存在**；而并列的 `test` 规则生效（`/app/test` 不存在）。
⇒ 语义确认：`*.mjs` 只匹配**上下文根层**，嵌套层需 `**/*.mjs`。据此可解释为何 `test/` 被排出而深层 `.mjs` 保留——**判断"某目录/后缀是否进镜像"必须实测，不能读 .dockerignore 推断**。

**③ 「有意排除」必须先建立白名单/排除清单再断言缺口**：`pack-local.py` 的 `EXCLUDE_SUFFIX`（全局按扩展名）与 `is_sensitive_env()`（`.env` 家族）会产生**预期内的名称缺失**（本轮 7 jpg + 1 `.env` 备份）。审计时若不先加载这两张清单，会把 8 个正常排除误报为缺口。

**④ 等价性判据用双向集合比对，不用单侧计数**：`922 vs 920` 的计数差本身无信息量；`(md5, path)` 双向差集才能同时给出"缺失"与"内容漂移"两类结论，并把差异**收敛到文件级**（本轮 1 个）。

---

*生成：2026-09-17 07:10 · 只读核查 + 逐文件校验 · 未修改生产任何状态*
