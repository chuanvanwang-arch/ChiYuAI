# KMD 探针问题整改 · 执行报告（2026-09-18）

> 上游：`reports/nightly/2026-09-18-kmd-probe-remediation.md`（诊断方案，commit `91b1516`）
> 本轮：按 P0→P1 顺序**推动落地**，并同步提交 + 发布生产。
> 工作目录 `D:\system\CRM-ai-native`；HEAD `2c04235`；生产载荷 = `2c04235`。

---

## 结论先行

**7 项计划全部处理完毕**：5 项代码/判据已落地并上线，1 项（P0-1）**卡在外部付费资源**（SiliconFlow 账户余额不足，HTTP 402），1 项（P1-4）为 HITL 运营待办。

| 项 | 内容 | 状态 | 落地方式 |
| --- | --- | --- | --- |
| P0-1 | 本机 embedding 环境对齐（D1 转真绿） | 🔴 **受阻（外部）** | 根因 = 账户余额不足 402，**非环境配置问题**；代码链路早已就位 |
| P0-2 | D4 链路/回流正交拆分 | ✅ 已落地 | 探针拆双指标，`link_ready` 与 `real_auto` 分列 |
| P0-3 | 新增 D0 基线漂移闸（解告警疲劳元问题） | ✅ 已落地 | 新探针 D0，漂移项与闭环健康度分表 |
| P1-1 | D11 分母修正 + 成对反向断言 | ✅ 已落地 | 分母改契约相关行；`vocab_with_content` 反向断言 |
| P1-2 | D9 判据加绝对量门 + 记忆写入抑制 | ✅ 已落地 | 双门（占比>80% **且** 24h>5000）+ 边沿写入（根治 97.7% 噪声） |
| P1-3 | 本机补 outcome_event_map 种子（1→4） | ✅ 已落地 | `db/migrate.js` 纳入 09-14 扩展版；实测本机 1→4，与生产一致 |
| P1-4 | D6 校准积压分级审阅清单 | ✅ 清单已产出 | LOW 29 / MEDIUM 32 / HIGH 10；**须 HITL 审批，绝不自动应用** |
| 附加 | D14 外部依赖凭据活性探针 | ✅ 新增 | 补上体系性缺口（原 13 条全为内部数据面） |
| 附加 | 发布源 ④ 判据（SQL 字符串引用缺失） | ✅ 新增 | 堵住 P0 半提交 ENOENT 崩溃的同族根因 |

**探针终态**：🟢7 🔴3 🟡4 ⚪2（昨日 🟢6 🔴3 🟡3 ⚪2）——🟢 +1（D11），🟡 +1（D9 由 FAIL→双门 WARN，并暴露 D4 的正交状态）。剩余 3 条 🔴 中，**D1/D14 同源（外部账户欠费）、D6 为治理**。

---

## 一、P0-1：embedding 环境对齐 —— 卡在外部付费资源

### 决定性证据

```
EMBED_FAIL  Embedding HTTP 402：Sorry, your account balance is insufficient
```

| 维度 | 本机开发库 | 生产库 |
| --- | --- | --- |
| `particles.embedding` 列类型 | **vector(384)** | **vector(1024)** |
| `EMBEDDING_PROVIDER` | **未设置** | `model` |
| CRM_KNOWLEDGE 向量 | 69 条，**全 hash 伪向量**（`real_vector_pct=0`） | 19 条，**19/19 真向量** |
| 实测调用 | 🔴 **HTTP 402** | 🔴 **HTTP 402**（本次实测） |
| 账户 | `sk-vkzww…`（明文 51 字符） | `v1:XN4Nx…`（加密 111 字符），**同 base_url** |

### 结论与处置

1. **代码链路无缺陷**：`src/llm/embeddingClient.js` 真调用已实现，生产 `19/19` 真向量即活证。本机 `real_vector_pct=0` 的原因是**基线漂移**（列未迁移 + provider 未配置）+ **外部账户欠费**，二者叠加；单做环境对齐**不会**转绿（欠费仍在）。
2. **生产影响（P0）**：生产现有 19 条真向量是**存量快照**；账户欠费期间**新写入的知识粒子向量将全部为 NULL**（`ontology/hooks.js` 在非 model/失败路径写 NULL）。实测生产最近一次知识写入为 **09-16 07:11**，此后无新知输入 ⇒ **失效处于潜伏态、尚未显形**。
3. **本轮已修**（使失效可观测，见 §三）：拒因透传 + D14 探针。
4. **待您处置**：为 SiliconFlow 账户充值 / 更换可用的 embedding provider。**充值后本机与生产同时恢复**，无需改动代码。

> ⚠ 本机补做 1024 列迁移会以 `USING NULL` **清空现有 69 条 hash 向量值**（行数据不删）。因账户仍欠费、迁移后仍为 0 真向量，**本轮未执行**——建议充值后再一次性完成「迁移 + 重嵌」。

---

## 二、已落地的判据修正（4 项）

### P0-2 · D4 链路/回流正交拆分

**问题**：原判据 `auto>0 ? PASS : FAIL` 把「链路断」与「业务动作未发生」混为一种红。

**改法**：拆为两个正交指标——
- `link_ready` = 订阅器已注册（静态判据：`registerOutcomeIngester` 被 server 调用）+ 启用规则数 > 0；
- `real_auto` = 真实自动回写量（`source LIKE 'event:%'`，种子 `seed-script` 单独计数不混入）。

**当前值**：`link_ready=true, ingester_registered=true, event_rules=4, real_auto=0, seed_script=4, mapped_events_emitted_7d=0` → **WARN**（链路就绪、业务未发生），语义正确。

### P0-3 · 新增 D0 环境基线漂移闸

**元问题**：探针默认连本机开发库，而该库迁移/种子执行不完整 ⇒ **每晚必红**，长期训出告警疲劳，真红被当噪声。

**改法**：新增 `D0 环境基线漂移`，与声明基线（`schema.sql` 列类型 / 种子规则数 / `llm_config` 默认条目）比对，**漂移项单列**，不与闭环健康度同表。

**当前值**：`particles_embedding_col=vector(384)（基线 1024）, outcome_rules=4（已对齐）, llm_default_cfg=1, embedding_provider=(未设置) → drift_items=1` → WARN。

### P1-1 · D11 分母修正 + 反向断言

**问题**：分母混入 43 条本体词汇登记物（`payload` 仅 `kind/layer/term/type`，设计本就无 `content`），把真实契约 `16/16=100%` 稀释成 23%。

**改法**：分母改为**契约相关行**（`payload ? 'content'` OR `kind ∈ 四大类`）；并加**成对反向断言** `vocab_with_content`（vocabulary 一旦出现 `content` 即报警——防"把分母改到恰好通过"）。

**当前值**：`contract_scope=26, both_ok=16, match_pct=61.54, vocab_with_content=0` → **PASS**（昨日 FAIL 前的 23% 已修正为真实口径）。

### P1-2 · D9 双门 + 边沿写入（根治 97.7% 噪声）

**问题**：24h 记忆噪声 3208 行，其中 `visit_shortfall` 2111 + `info_collect_lag` 1045 = **3156 行（97.7%）**。

**根因链**：`salesDailyScan` 每次巡检都把聚合信号交给 `timers.js:110` → `emit('alert', …)`；而 `createAlertWithDb` 命中稳定 `dedup_key` 时**只刷新既有 signal 行**（`refreshed=true`，状态未变）——却仍 emit → capture（`alert` 域在白名单内）→ **每次写一行记忆**。即**状态型信号缺边沿写入**。

**改法**（通用机制，非特判）：
1. `timers.js`：emit 载荷透传 `state_refresh: !!a.refreshed`；
2. `capture.js`：`payload.state_refresh === true` → 跳过沉淀（`reason='state-refresh'`）。
3. **语义边界**：`emit` 照发 ⇒ **SSE 前端实时刷新不受影响**；仅不再写记忆。

**判据**：只有显式 `=== true` 才跳过（缺省/undefined/false 一律照常捕获，保守不误伤）。

**外加双门**：`占比>80%` **且** `24h 总量>5000` 才 FAIL。当前 `rows_24h=3208, top_pct=65.8` → **WARN**（属正常业务量级，不再误报风暴）。

### P1-3 · outcome 种子基线对齐

**根因**：`db/migrate.js` 只播种旧版 `seed-outcome-event-map.sql`（1 条），而 09-14 扩展版（4 条：`contract_sign / deal-advance / quote-create / deal-archive`）**未纳入 migrate** ⇒ 本机长期 1 条、生产 4 条 = **种子基线漂移**，使 D4 判据两侧不一致。

**改法**：改为循环播种两版（两文件均 `WHERE NOT EXISTS` 幂等，重复执行零副作用）。**实测本机 1→4，与生产一致。**

---

## 三、附加修复：三层拒因衰减（本轮排查的最大障碍）

排查 embedding 时，`HTTP 402` 的**服务端原话"account balance is insufficient"被三层依次吞掉**——这正是项目铁律「拒因不得被中间层吞掉」的违反：

| 层 | 原状 | 已修 |
| --- | --- | --- |
| ① 底层 | `throw new Error(\`Embedding HTTP ${r.status}\`)` —— **响应体被丢** | 读取 body，提取服务端原话，携 `httpStatus`/`serverMessage`/`isQuota` 抛出 |
| ② 外层 catch | `throw new Error(\`Embedding 失败: ${e.message}\`)` —— **二次吞掉 `httpStatus`**（修①后仍衰减一次，**同一根因换形态**的实时案例） | quota/鉴权类错误**原样透传**，不再被包装 |
| ③ 观测面 | 降级只 `emit('trace', …)`，而 `trace` 域在 capture 白名单之外 ⇒ 事件被挡；`recordFailure` 只写**进程内 Map**，重启即清零 | 降级留痕带 `detail`；D14 探针提供**可持久、可复现**的活性证据 |

### 新增 D14 · 外部依赖凭据活性探针

**体系性缺口**：原 13 条探针**全为内部数据面**，无一条检查外部依赖（LLM/Embedding/SMTP）的**凭据活性**——这正是欠费可潜伏两天的原因。D14 补上：

- 真调用 `embed()`（非查配置项存在性）；
- 分型：`401/402/403` → **FAIL**（凭据/额度，须人工）；`429/5xx/超时` → **WARN**（瞬态）；
- 回传服务端原话（脱敏）+ `detail`（成功也带证据，区分"连上了"与"取到了"）。

**当前**：`embedding=http-402, detail=Embedding 失败: Embedding HTTP 402：Sorry, your account balance is insufficient` → **FAIL**（正确）。

### 新增发布源 ④ 判据 · SQL 字符串引用缺失

**背景**：2026-09-18 生产首次发布崩溃（`crm-app` 崩溃循环、`/`=000），真因是 HEAD **半提交**——`db/migrate.js` 引用的 `migration-signal-contact-owner.sql` 未 `git add`。而 `verify-release-source.mjs` 只穷尽 JS import/具名导出，**扫不到字符串式 .sql 引用** ⇒ **校验 exit 0 却发布必崩**。

**改法**：新增 **④** 判据——扫描 `db/migrate(-config)?.js` 内全部 `'<name>.sql'` 字面量，断言其在发布源存在，缺失即**阻断 exit 1**。同步在 `test/migrate-consistency.test.js` 加镜像守卫。

**自证**（变异测试，本轮实测）：往种子数组塞入 `seed-mutation-probe-absent.sql` → ④ 检出 1 处、`exit=1`、打印阻断结论；移除后 `exit=0` 复绿。

---

## 四、自检与回归

| 检查 | 结果 |
| --- | --- |
| 探针判据自检 `--self-test` | **14/14 通过**（含 D4 四态、D9 双门、D11 反向断言、D14 四类状态码） |
| 发布源 ④ 判据变异自证 | 检出→阻断→复原复绿，**判据具备鉴别力** |
| 记忆/调度回归 | `memory.test / memory-writeback / discoveryCapture / salesDailyScan-personal / salesDailyScan / timers` = **98 passed / 1 failed** |
| migrate 回归 | `migrate-consistency` **6/6 通过** |
| embedding 回归 | `embeddingClient / ontology-hooks / embedding-model / decision-embed` **17/17 通过** |

### ⚠ 两处失败：均为**既有漂移，与本轮改动无关**（已定位到引入时间）

| 失败用例 | 断言指向 | 引入时间 | 判定 |
| --- | --- | --- | --- |
| `test/db/migrateConfig.test.js` 无悬空方法论 | `crm.decision_scenario.methodology_ids` 含 `REQUIREMENT`，而 `skill_registry` 未注册 | 场景行 `d4616ab`(09-11) 引入；断言自 `c88a29a`(09-07) 基线即有 | **既有漂移**。测试仅 `import db.js`，不跑 migrate，与本轮改动**无交集**（我改的是 `outcome_event_map` 播种） |
| `test/memory/discoveryCapture.test.js` assembler 冻结哈希 | `src/context/assembler.js` 的 sha256 | 文件于 `bc0f5b5`(09-16) 合法变更，**冻结常量未同步更新** | **守卫漂移**。红线守卫正常报警，需在同步更新冻结常量时注明依据 |

**建议（未执行，需批准）**：
- 悬空 `REQUIREMENT`：`db/migration-requirement-collect-scenario.sql` 引用了 `REQUIREMENT` 方法论，但无种子将其注册进 `skill_registry`。**修法会改变「决策场景配置」页的可选行为**（属行为变更），故不擅自改，列为待批。
- 冻结哈希：`bc0f5b5` 为已批准变更，同步更新冻结常量即可；但"放任红线漂移"与"用更新常量掩盖改动"风险不同，建议您裁定后执行。

---

## 五、提交与发布

### 提交（4 个功能线，显式路径 add、禁 `-A`/`rm`）

| commit | 内容 |
| --- | --- |
| `941e263` | `fix(probe)`：KMD 探针整改（D4 正交拆分 / D9 双门 / D11 分母+反向断言 / 新增 D0+D14 / 14 条自检） |
| `c756eca` | `fix(llm)`：拒因不得被中间层吞掉（透传 HTTP 状态与服务端原话，含外层二次衰减）+ 降级留痕带 detail |
| `0206e3e` | `fix(signal)`：状态型告警边沿写入（`state_refresh` 透传 + capture 跳过刷新态）；同文件随带 `named_visit_overdue` 责任人落图及其守卫 |
| `2c04235` | `fix(db)`：outcome 种子基线对齐（1→4）+ 发布源 ④ 判据 + 测试侧镜像守卫 |

### 发布（生产 www.chiyuai.com / 81.70.184.198）

| 检查 | 结果 |
| --- | --- |
| release | ✅ **EXIT=0**（migrate 全步幂等通过） |
| 容器 | `crm-app` / `crm-mcp` / `crm-pg` 三容器 **healthy**；镜像 `2026-09-18T00:30:06Z` |
| HTTP | 本机 200 / 公网 200；`/`、`/landing.html`、`/portal/my-todo.html`、`/signal-center.html`、`/channel-adapters.html` **全 200** |
| MCP 闸 | **401**（鉴权闸正常） |
| `.env` 零回归 | **16 键不变**（PG 33 / SMTP 31 / LLM 44，含换行） |
| 特征探针 | `STATE_REFRESH_CAPTURE=1`、`STATE_REFRESH_TIMERS=2`、`PROBE_D14=2`、`PROBE_D0=2`、`VERIFY_SQL_CHECK=4`、`INPUT_ALIGN=1` ⇒ **本轮改动已全部上线** |
| 生产数据面 | `outcome_event_map=4`（与本地对齐）、`embedding` 列 `vector(1024)`、`CRM_KNOWLEDGE=19/19 有向量`、`calibration_patch PENDING=1` |
| 错误日志 | 近 4 分钟 **0 条** error/ENOENT |

---

## 六、待办

### 🔴 需您处置（按优先级）

1. **SiliconFlow 账户充值 / 换 provider**（P0，阻塞 D1+D14 两条红本机与生产同源）。充值后执行「本机 1024 列迁移 + 重嵌回填」即同时转绿。
2. **GitHub push 未完成**（沙箱无凭据，`could not read Username`，exit 128）→ 本地领先 origin **9** 个：
   ```powershell
   cd D:\system\CRM-ai-native
   git push origin feat-multi-industry-meta-model
   ```
3. **D6 校准补丁 71 条待审**（本机 71 / 生产 1）：分级 LOW 29 / MEDIUM 32 / HIGH 10，清单见 `artifacts/calibration-triage-2026-09-18.json`。⚠ **须经管理员审批流落地**（`POST /api/calibration/patches/<patch_id>/approve` 或 `/api/my-todo/tune-approve`），**绝不自动应用**。本机 71 条系实验数据，建议留档或批量 reject 以免污染本机配置基线。
4. **两处既有红待裁定**（见 §四）：悬空 `REQUIREMENT` 方法论注册；`assembler.js` 冻结哈希同步。

### 🟡 观察项

- **D10 D→K 回写**：`decision_provenance` 中 `source='retro'` **0 行** ⇒ 复盘从未被提交（非链路缺陷，提交一次真实复盘即转绿）。附带缺陷：C4 跳过仅 emit trace，而 trace 域被 capture 白名单挡住 ⇒ **跳过原因不可观测**，建议后续补持久留痕。
- **并行会话在途**：`src/web/channel-config.html`、`src/portal/layoutMenu.js`、`vitest.config.js`、`test/setup/` 等 24 项**未提交**。本轮发布以 HEAD `2c04235` 收口，**不含**这些在途改动，需下次 release 对齐。

---

## 附：产物

- 探针原始产物：`artifacts/kmd-probe-2026-09-18.json`（16 条探针全量 verdict + metrics）
- 校准分级清单：`artifacts/calibration-triage-2026-09-18.json`
- 诊断方案（上游）：`reports/nightly/2026-09-18-kmd-probe-remediation.md`
- 昨夜例行报告：`reports/nightly/20260917-audit.md`
