# 最终设计：共生式 CRM 接入 + 主动运行时

> **版本** v1.0（FINAL，唯一有效设计）｜ **日期** 2026-09-15 ｜ **状态**：✅ **已批准**（2026-09-16 用户批准，批准对象=共生同步线+主动运行时线两份设计之合并）  
> **性质**：实施级设计。批准后唯一入口为 `writing-plans`；**批准前不写任何实现代码（HARD-GATE）**。批准后唯一入口为 `writing-plans`（§18.1）。
>
> **本文取代以下四份文档（均已打废弃标记，仅保留过程证据，不得作为实施依据）：**
>
> - `2026-09-15-rox-benchmark-differentiation-analysis.md`（Rox 单点对标）
> - `2026-09-15-attio-lightfield-rox-three-way-comparison.md`（三家对照）
> - `2026-09-15-crm-coexistence-sync-design.md`（共生同步线设计）
> - `2026-09-15-proactive-runtime-design.md`（主动运行时线设计）
>
> **任务编号统一为 T01–T21**（原两份文档中的 `T1–T10` 请按 §13 生命契约的任务清单逐条对应；**交付分段编号亦已重排为 `S1–S7`**，旧文档中的 `S1–S5` 不可直接用于定位——见 §14.3 统一实施分段）。

---

## §0 结论先行：最重要的修改是什么

### 0.1 一条最重要的修改

> **定位反转：把我方从「一个要求客户搬家的新 CRM」，改成「挂在客户既有 CRM 之上的判断层」。**

一句话形态：

```
数据从客户系统进来  →  判断在我方发生  →  结论回客户系统去
```

**为什么它是"最重要"而非"之一"**——因为这一个改动**一次性锁死了另外五个决策**，且这五个决策此前全部是开放状态：

| # | 被锁死的决策   | 反转前（错）                    | 反转后（对）                             |
| - | -------- | ------------------------- | ---------------------------------- |
| 1 | **数据源**  | 我方自建记录系统，要客户把历史搬过来        | **客户 CRM 是主数据源**（纷享销客/销售易/自研）      |
| 2 | **写入方向** | 我方独立闭环，客户还得再登一个系统         | **结论回写客户 CRM 指定字段**（带 `Source` 标记） |
| 3 | **初始信任** | 一步到位要求接管                  | **只读观察期起步**，零风险进入                  |
| 4 | **交付顺序** | 先做能力最全的（双向同步/自动执行）        | **先读入 + 对齐，再回写，最后才谈自治**            |
| 5 | **商业叙事** | "AI 原生 CRM 平台"（与客户既有系统对撞） | "**你不在 CRM 里做的判断，我替你做，然后把结论送回去**"  |

**判定依据**：用户 2026-09-15 明确修正——**我方客户群体都有自研或套装 CRM（纷享销客、销售易等）**。此前文档的核心前提「我方客户多数没有成熟 CRM」被推翻，Rox「CRM 只是数据源、不淘汰现有系统」的策略因此从"对象不匹配"**翻转为直接适用**。

### 0.2 如果只能改一处代码，改哪里

> **修投递面断链。**

理由：这是全项目**唯一一处"指标全绿、链路全死"**&#x7684;地方，也是与 L1–L4 假绿同源的同一个错误。

| 事实                                                                                                  | 源码锚点                                  |
| --------------------------------------------------------------------------------------------------- | ------------------------------------- |
| 11 个定时器每 30 分钟在跑巡检（`crm-risk-scan` / `sales-daily-scan` / `named-visit-scan` / `lead-pool-recycle`） | `src/scheduler/timers.js`             |
| 13 类告警规则在判定                                                                                         | `src/alerts/alertRegistry.js`         |
| `trace 'sales-daily-scan' {hits:N}` 每天在刷，指标是绿的                                                      | `src/scheduler/timers.js`             |
| 🔴 但产出写进**进程内存 `new Map()`**                                                                        | `src/alerts/alertStore.js:6`          |
| 🔴 实例表 `crm.alert` **不存在**（**双重实证**：本地库 `information_schema` 仅见 `alert_rule` 规则表；全 `db/**/*.sql` 对 `crm.alert` 的建表语句零命中）         | 运行态 `information_schema` + `db/` 全域（2026-09-15 核验，见 §18.2） |
| 🔴 8 个查询端点**从未挂载**（`buildAlertHandlers` 全仓零调用，文件头自述"等挂载方统一 add"——**挂载方一直没来**）                       | `src/alerts/alertEndpoints.js:12-24`  |
| 🔴 `registerAlertHook` 未注册（`server.js:74` 只注册了 finance 版）                                           | `src/http/server.js:74`               |
| 🔴 工作台六视角**无信号视角**                                                                                  | `src/http/workbenchRouter.js:101-175` |
| 🔴 84 个页面中**无一调用** `api/alerts`                                                                     | `src/web/` grep 零命中                   |
| 🔴 IM / 短信通道 `钉钉·企业微信·wecom·dingtalk·lark·sms` 在 `src/` 下**全 0 命中**                                 | grep 零命中                              |

**结论**：感知面与判断面都已具备，**没有任何人能看到任何一条产出**。改这里不是加能力，是**把已经做好的东西接上电**——这是全案 ROI 最高、且当天可见效的一步。

### 0.3 一句话总纲

> **先让人看得见（S1 出口）→ 再让数据进得来（S2 入口）→ 判断才有据（S3）→ 结论才送得回去（S4）→ 然后才允许它自己动手（S6）。**  
> **顺序不可颠倒**：在链路断裂且无投递观测的前提下放开自动写，等于**把假绿放大成真错**。

### 0.4 ⚠ 关于"让 AI 主动干活"的起点修正（2026-09-15 追加）

> **不是"加授权"，而是"先修授权的依据"。**

平台**已经有一个在运行的常驻授权骨架**——按 `客户维(STRATEGIC/KEY/NORMAL) × 项目维(A/B/C)` 决定对象风险档 `LEAD/NORMAL/HIGH`，非 HIGH 且置信度达标即自主放行（源码实证见 §2.4）。**它不是零，不该按"从零引入"设计。**

但**它的审计链是断的**：分级配置不在 `POLICY_KEYS` 内（`policyVersion.js:29-34`），改一次分级不会产生新版本 → 回看历史决策时**无法回答"当时凭什么判 LEAD"**。在此状态下叠加新的授权凭证（T19），新凭证的溯源会挂在一条本就不通的依据上。

**因此最重要的三行改动（成本极低，价值极高，且先于 T19）**：

| # | 改动 | 位置 | 收益 | 状态 |
| - | --- | --- | --- | --- |
| **1** | 分级配置纳入 `POLICY_KEYS` | `policyVersion.js:29-34` | 分级变更 → 新版本；历史决策依据**永久可复现**（修 D3，最严重的一条） | ✅ **已实施**（2026-09-16，方案 i，含镜像机制） |
| **2** | 把 `decision_id` 写进分级行 | `businessTier.js` `upsertTier`（A1 加列 + A2 落库） | "这条分级是谁批的"**可反查**（修 D2 溯源断链） | ✅ **已实施**（2026-09-16，A1 6 列 + A2 落库） |
| **3** | `autonomous_allowed` 接入判定，或从配置面移除 | `autonomyEngine.js:274`（或 `decisionScenario.js:126`） | 消除"配了⛔人工却仍自动放行"的**假绿**（修 E1） | ✅ **已实施**（2026-09-16，方案 a） |

> **进度**：3 项 **全部落地并验证**（证据表见 §11.1.2 / §11.1.3），A 轴 D1–D4 四个断点全部闭合。

> **判据（现已可核对）**：对任一历史决策，现在能回答三个问题——**"当时的分级是什么"**（A3 版本冻结，可复现）、**"谁批准了这个分级"**（A2 `approved_by` + `decision_id`，可反查）、**"它还有效吗 / 什么时候失效的"**（A4 `revoked_at`/`expires_at`，可撤回且撤回真的生效）。
> 三者齐备之前，任何"事后审计 + 可撤回"的承诺都是**空头**。**现在这三问都答得出来，才谈得上扩大自治范围（T19）。**

### 0.5 ⚠ 交付状态与接线实况（2026-09-16 17:00 复核，**对外表述前必读**）

> **一句话**：S1–S7 的**代码模块已交付**；线 A（共生同步）**已在本地库接线并通过真库端到端实测**（两触发点 + 冒烟 5/5）；
> **但** ①本地 `crm_native` 的同步三键（`integration-providers` / `sync-mappings` / `sync-trust`）**均未配置 → 两触发点当前均为 no-op**；
> ②**云上生产（81.70.184.198）根本未发布本设计任何成果**——见下方「生产发布实况」。本节给**可复跑判据 + 实测记录**，不给一次性结论。

| 线 | 代码侧交付 | 代码侧可触发 | **云上生产已发布** | 证据 |
| -- | --------- | ------------ | ----------------- | ---- |
| **线 B（主动运行时）** | ✅ S1 / S5 / S6 / S7 已交付 | ✅ 有（timers 注册、`routes.js` 端点、菜单入口、工作台第 7 视角） | 🔴 **否**（生产 `/api/signals` → **404**，容器内**无 `/app/src/signal`**） | §10.1 / §10.2；§0.5 生产实况 |
| **线 A（共生同步）** | ✅ **已接线**（`src/sync/` 10 文件 + 挂载层 `mount.js`） | ✅ **有**：A-B6 `timers.js:478` 集成轮询增量分支；A-B5 `connectorRouter.js:53` webhook 对象变化路由 | 🔴 **否**（容器内**无 `/app/src/sync`**） | 冒烟 `scripts/smoke-line-a-mount.mjs` **5/5**；计划 §4.3/§4.5 |

#### 0.5.1 生产发布实况（**2026-09-16 20:42 已发布**｜17:00 基线留存对照）

> **✅ 更新（2026-09-16 20:42 实测）**：本设计已发布至云上生产（`deploy-remote.py release`，约 2 分钟）。
> 下表 17:00 的"零落地"记录**保留作发布前基线**，仅用于对照；**当前状态以本小节末尾「发布后验证」为准**。

> **🔴 发布前基线（2026-09-16 17:00 实测）**：当时云上生产运行的是 **≤2026-09-15 的镜像**（`crm-app` 镜像 created `2026-09-15T13:57:01Z`），
> 本设计（S1/S5/S6/S7 + 线 A + 血缘三列）**全部未发布**。此处保留原文，作为"发布前/后"对照与判据样例。

| 探测项（可复跑） | 实测 | 含义 |
| ---------------- | ---- | ---- |
| `docker exec crm-pg psql -U agent2b -d crm_native -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='crm'"` | **66** | 生产 schema 为 09-15 时点（本机已 65+ 新表） |
| 生产 `crm.signal` 是否存在 | **relation does not exist** | ⇒ **`ALTER TABLE crm.signal ...` 在生产必然失败**，"单独跑血缘迁移"物理不可行 |
| 生产是否存在 `signal_delivery` / `standing_grant` / `grant_execution` / `advice_record` / `external_ref` / `sync_cursor` | **全部不存在** | S1/S5/S6/S7/S2 表结构均未发布 |
| 容器内 `ls -d /app/src/signal`、`/app/src/sync` | **NO_SIGNAL_DIR / NO_SYNC_DIR** | 生产镜像不含本设计任何源码 |
| `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/signals` | **404** | 生产无信号端点 |
| 生产 `crm.config_store` 键数 / 是否含 `signal-schedule`、`agent-research-schedule` | **46** / 仅 `lead-pool-config`、`prospecting-rules` | S5 各扫描器的**驱动配置在生产为空** → 即便发布代码亦全为 no-op |

**发布后验证（2026-09-16 20:42，全部可复跑）**：

| 验证项 | 发布前 | 发布后 | 判据 |
| ------ | ------ | ------ | ---- |
| 生产 crm schema 表数 | 66 | **73** | 差值 **7** = §8 声明的 7 张新表（signal / signal_delivery / standing_grant / grant_execution / advice_record / external_ref / sync_cursor）**逐一落地** |
| `GET /api/signals` | 404 | **401** | 404→401 = 路由已存在、认证闸生效（S1 已发布） |
| S5 驱动配置 | 无 `signal-schedule` | **已播种** | 迁移日志 `[migrate] 时间型信号默认规则已播种（signal-schedule）` |
| S2 配置模板 | 无 | **新增 3 条** | 日志 `sync-mappings/sync-trust/integration-providers，本次新增 3 条` |
| L3 研究调度 | 无 | **已播种** | 日志 `[migrate] L3 主动研究默认调度已播种（agent-research-schedule）` |
| 容器健康 | — | **3/3 healthy** | crm-app / crm-mcp / crm-pg |
| app 日志 ERROR | — | **0 条** | `docker logs crm-app --tail=200 \| grep -ci "error\|fatal"` → 0 |
| **HTTPS（发布前修补项）** | 正常 | **正常** | `deploy.sh:192` 会用仓库模板覆盖线上 nginx；本次已把 certbot 的 443 块回填模板，故公网 `https://www.chiyuai.com` 仍 301、http→https 仍跳转 |

> **⚠ 发布后发现的生产配置缺口（非代码缺陷，需人工补）**：
> 生产 `.env` **不含 `PGCRYPTO_SYM_KEY`** → 容器内 `process.env.PGCRYPTO_SYM_KEY` 为空 →
> `src/connectors/discovery/credentialVault.js:75-78` 走 **fail-closed 分支**（错误信息「PGCRYPTO_SYM_KEY 未配置：凭据加密不可用」）。
> ⇒ **S2 的凭据保险库在生产不可写入**（保存 provider 凭据会被明确拒绝，属安全设计而非降级）。
> 影响面：`integration-providers` 模板已播种，但**供应商密钥无法落库** → 外部数据接入仍停在"框架就绪、密钥待配"。
> 处置：由人工在 `/opt/crm-ai-native/scripts/tencent-lighthouse-deploy/.env` 补 `PGCRYPTO_SYM_KEY=<强随机>` 后重启 `crm-app`。

> **🔴 另发现一项「公网可达性」阻断**（非本次发布引入，但直接决定最终用户能否使用）：
> 从本机**外网**实测（2026-09-16 20:55）：
> - `http://www.chiyuai.com/` → **302 → `dnspod.qcloud.com/static/webblock.html?d=www.chiyuai.com`**（该页 `<title>备案</title>`）
> - `https://www.chiyuai.com/` → **TLS 握手无响应**（`curl` exit 35；TCP 443 可连但无 TLS 应答）
> - 而**服务器 IP 直连一切正常**：`http://81.70.184.198/` → **200**；`https://81.70.184.198/` → **301**
> - DNS 解析正确（`www.chiyuai.com` → `81.70.184.198`）
>
> ⇒ 服务器与 nginx（含 443）**均健康**，**阻断发生在腾讯云接入层**（域名 ICP 备案未通过时的标准拦截行为）。
> ⇒ **影响**：公网用户**无法通过域名访问**，当前仅 IP 可直达。
> ⇒ **对本节结论的限定**：上表"发布后验证"全部是**服务器侧**结论（本地 `curl` / `--resolve` 绑定 IP），
> **只证明"服务已就绪"，不证明"公网可访问"**。两者须分开表述，不得合并。

> **⚠ 表述红线（2026-09-16 20:42 修订，取代此前三态版本）**：
> 原三态已**全部转绿**——① **代码侧就绪**（✅）／② **本地库端到端实测通过**（✅）／③ **云上生产已发布**（✅ 本次实测）。
>
> **但新增第四态「已产出真实运行数据」仍为 🔴**，判据（生产实测）：
> - `crm.signal` = **0 行**、`crm.standing_grant` / `grant_execution` / `advice_record` 均 **0 行** → 三张运行态表尚无业务行；
> - 生产 `.env` 缺 `PGCRYPTO_SYM_KEY` → 凭据保险库 fail-closed（见上）；
> - 故 S5 扫描器虽有驱动配置，**尚未产出任何信号**。
>
> ⇒ **允许表述**：「主动运行时与共生同步已完成开发验证并**发布至生产**，驱动配置已播种，待产出运行数据」。
> ⇒ **仍不允许**：「AI 主动值守**已上线运行**」「双向同步**已为业务产出数据**」——这类表述需要运行态表出现真实业务行。
> （沿袭 §15 / 附录 D.2 红线：**发布 ≠ 生效 ≠ 产出**，三者判据不同，不得合并表述。）
> **⚠ 另需点破一处长期口径歧义**：`src/db.js:67-79` 把默认库 `crm_native` 称作"**生产库**"，
> 但云上生产的同名库（Docker `crm-pg` 内）**与本地库内容完全不同**（本地 66 表中含 signal 系列、生产无）。
> ⇒ 该告警措辞易被误读为"本地库即生产"；**本文档口径以"本地库 / 云上生产"二分，不使用 db.js 的措辞**。


**线 A 触发性判据（可直接复跑，任一为 0 即"尚未挂载"）**：

```bash
# ① 挂载层是否已被生产触发点引用（期望 ≥1；=0 表示 mount.js 自身也是"挂载方没来"）
grep -rn "sync/mount\|runTenantSyncOnce\|handleObjectChanged" src/scheduler/timers.js src/http/connectorRouter.js
# ② 内核是否被生产引用（期望仅挂载层命中；其它 src/ 命中=越层调用）
grep -rn "createSyncEngine\|engine.runOnce" src/ | grep -v "^src/sync/"
# ③ 回写 Action 是否有生产调用者
grep -rn "sync-writeback-fields" src/ | grep -v "seed-actions\|action/"
# ④ sync 是否已有 HTTP 端点
grep -rn "sync" src/http/routes.js
```

**2026-09-16 实测记录（可复跑）**：

```bash
node scripts/smoke-line-a-mount.mjs   # 真库 crm_native；唯一租户；5/5 OK
```

| 断言 | 实测 |
| ---- | ---- |
| ① L1 只读（有效档 = min(声明 L3, global L1) = L1） | `external_ref` 0→0、`particles` 0→0，cursor 留痕 `read=2`、`decision_id=null` |
| ② L2 写入 + 第 0 闸锚点 | `created=4`、`external_ref` 0→4、两对象 `sync_cursor.decision_id` 均落锚点 |
| ③ 二次同游标幂等 | `created=0`、0 新粒子 |
| ④ 轮询侧 fail-closed（铸不出决策） | `errors=2`、零写入、emit `sync-run-failed` |
| ⑤ **A-B5 事件路由**（另一挂载点） | L1 只读不写 / L2 无决策 `decision_required` 拒写 / L2 有决策 `created=true` |

> **⚠ 接线期另发现并修复 3 处"接线才暴露"的潜伏缺口**（全部通过既有单测，仅真库接线后暴露）：
> **G1** `engine.runOnce` 调 `readIncremental` 未传 `object` → 按对象拉取的 provider 永远 0 行且 `last_status='ok'`（假绿）；
> **G2** `engine` 硬编码 `row.id`、忽略映射声明的 `identity.external_id_field` → 设计形状的行被全量 `skipped`；
> **G3** A-B5 缺省装配**未注入 `mintDecision`**，且 `handleObjectChanged` 用可选形态（`if (mintDecision)`）而非 fail-closed
> → **L2/L3 写路径可无决策落库**（呼应 §15 第 0 闸铁律）。G1/G2 见计划 §4.3；G3 为并行会话未覆盖项，见计划 §4.3 补记。
> **G3 的隐蔽性**：`test/external-integration.test.js` 三条 A-B5 用例**全部注入 `runSyncEvent` 替身** → 缺省装配路径**零覆盖**，
> 缺口对 102 例全绿的测试套件完全不可见（同族：`adoption.test.js` 用假 store 掩盖静默丢字段）。

> **⛔ 由此产生的表述红线（适用范围同 §15 / 附录 D.2）**：
> 在 ① 命中且跑出真实同步行（`crm.sync_cursor` 有 `last_status='ok'` 的行、`crm.external_ref` 有真实外部 ID）之前，
> **任何"已接入客户 CRM" / "能为客户回写 CRM" / "双向同步已上线"的表述都不成立**。
> 允许的表述是：**「同步已接入生产触发点（集成轮询 + webhook 事件路由），待租户配置描述符后生效」**。
> （**2026-09-16 15:57 更正**：原允许表述「同步内核与挂载层已就绪，**等待接入方**」已随接线完成而**过期**——
> 两触发点已于本日接线并通过真库冒烟 5/5。仍不成立的只有"已有客户数据在同步"，因 `crm_native` 三键未配置。）
>
> **⚠ 为什么本节给判据而不给结论**：本设计 §0.2 点破的病灶正是「文件头自述'等挂载方统一 add'——**挂载方一直没来**」。
> 同类缺陷的特征是**结论会随时间失效**（模块先到、接线后到），因此本节以**可复跑判据**代替一次性结论——
> 这也是 `2026-09-16-design-merge-audit.md` §11 判据 ④「**交付 ≠ 可触发**」的落地形式。
> 待闭环项登记见**附录 E**。

---

## §1 定位：反转、象限与借鉴边界

### 1.1 修正前后的判定

| 维度                       | 修正前的判定（错）     | 修正后的判定                                   |
| ------------------------ | ------------- | ---------------------------------------- |
| 客户现状                     | "多数没有成熟 CRM"  | **都有自研或套装 CRM**（纷享销客、销售易等）               |
| Rox "接现有 CRM、不淘汰"        | ❌ 对象不匹配，照搬无落点 | ✅ **直接适用**                               |
| IM / 邮件 / Excel（"事实发生地"） | P0            | **降为补充轨**——CRM 升为主数据源                    |
| 数据进来                     | 需新建 CSV 导入    | **优先 API 直连**；CSV 降为无 API 的自研 CRM / 台账兜底 |

### 1.2 定位象限（三方对照后的落位）

|                | 数据从哪来                                             | 对现有 CRM 的姿态                                                                    | 终局意图                                                                 |
| -------------- | ------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| **Attio**      | 自建记录系统（Universal Context™）                        | **要求搬迁**（官方路径 = Import2 一次性迁移；**无原生双向同步**，双向由第三方 Stacksync 提供）                 | 取代                                                                   |
| **Lightfield** | 自建记录系统（schema-less 先抓后建 + temporal context graph） | **要求搬迁，但把摩擦打到最低**（One-Hour Migration Agent：CSV → 90k 记录/时）                     | 取代（承诺数据可 API 带走）                                                     |
| **Rox**        | **借用客户系统**（warehouse-native）                      | **不要求换系统**——CRM 是 "just another data source feeding the SOR"，双向 writeback，三层同步 | **取代（已明牌）**：*"…and let's be honest: in that future, Rox is the CRM"* |
| **我方（本设计）**    | **接客户 CRM（API 直连）**                               | **不要求换系统，且不设取代终局**                                                             | **长期共生**（我方是判断层，客户 CRM 是记录层）                                         |


### 1.3 从 Rox 借什么 / 不借什么

| #  | Rox 的做法                                                                                                          | 借？         | 我方落点                                                                                          |
| -- | ---------------------------------------------------------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------- |
| 1  | **CRM 只是数据源**，不淘汰现有系统                                                                                            | ✅ 借        | 线 A 全程                                                                                        |
| 2  | **三层同步**（Mappings / Real-Time / Batch）                                                                           | ✅ 借前两层     | 线 A §5、§8                                                                                     |
| 3  | **乐观并发**（写前回拉 + 基线比对 + 不匹配中止 + 显式 force；**明确不依赖时钟**）                                                             | ✅ 借思想      | 我方已有同构（`casExpectStage`/`casExpectOwnerEmpty`，`particleRepo.js:203/232-242`）→ **扩到字段值，非新建机制** |
| 4  | **回写静态标记**（`Source='Rox'`）                                                                                       | ✅ 借        | `Source='crm-ai-native'`                                                                      |
| 5  | **"complementary, not competitive"** 的进入叙事                                                                       | ✅ 借        | §14.3 实施分段：只读观察期（S2）→ 回写（S4）→ 再谈接管（S6）；对应红线 §15.1 #1                                      |
| 6  | **商业终局"最终取代 CRM"**                                                                                               | ❌ **不借**   | 一旦对外写"最终取代"，"共生"叙事即刻自毁                                                                        |
| 7  | **主动性 90% 在投递层**（Daily Digest / Pre-Meeting Briefing / Slack / Home / To-Dos Dashboard / Notifications controls） | ✅ 借主次判断    | 线 B S1：投递优先于自动执行                                                                              |
| 8  | **常驻监控**（Stage-Aware Opportunity Risks / Agentic Deal Risk / Champion Tracking）                                  | ✅ 借        | 线 B T12 / T15 / T16                                                                           |
| 9  | **autopilot 全自动**                                                                                                | 🟡 **限档借** | 线 B T19 只开 T1 内部字段；T3 对外动作**永久不可常驻授权**                                                        |
| 10 | 治理在**读侧**（query-time access rules / field-level permissions / Access Provenance）                                 | ⚪ 不冲突      | 我方治理在**写侧**（第 0 闸 + 双阶段 token + 8 断言族）。**两者互补，非同一轴强弱**                                        |

> **Rox 官方免责声明（对手方自证）**：*"All AI-generated outputs… should be reviewed by authorized personnel before any action is taken"*、*"autopilot/autonomous… require initial configuration and ongoing oversight"* —— **最激进的厂商也承认必须人在环**。这为我方 HITL 铁律提供了外部背书。

---

## §2 现状：源码级盘点（统一口径）

> 口径：407 个 `src/*.js`（50,624 行）+ 15,297 行 HTML（84 个页面）+ `test/` 621 个文件（4,111 例）。  
> **凡"有 / 没有 X"的断言，本文一律给出 `file:line` 或"grep 零命中"两者之一。**


### 2.1 已有骨架（比预期深 —— 本设计不是从零建）

| #   | 能力                                                                                                                                                                                                                                                                  | 证据锚点                                                                          | 对本设计的意义                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------- |
| E1  | **租户级外部系统描述符** `config_store['integration-providers']`：`{ id, kind, enabled, endpoint, field_map, signal_map, credentials }`                                                                                                                                        | `src/connectors/discovery/tenantInstances.js:19-29`                           | **"接哪个外部系统"已是配置项，不是代码**                      |
| E2  | **kind → 工厂注册表**：`generic-rest` / `generic-mcp` / `generic-cli`                                                                                                                                                                                                     | `tenantInstances.js:9-13`                                                     | 加 `fxiaoke` / `neocrm` 走同一机制                 |
| E3  | **加密凭据保险库**（pgcrypto at-rest + 按租户解密 + 缺失回退同名 env + `persistSecret` fail-closed）                                                                                                                                                                                    | `credentialVault.js:34-49`、`:52+`                                             | 纷享 `appId/appSecret/permanentCode` 与销售易凭据有落点 |
| E4  | **定时拉取框架**：逐租户 → `loadAdapters` → `runWaterfall` → `monitorAccount`；间隔 `config_store['integration-poll']`（默认 6h）                                                                                                                                                    | `src/scheduler/timers.js:117-143`                                             | **对象级增量拉取可挂同一循环**（不新增定时器）                    |
| E5  | **入站 webhook 挂载点**：`POST /api/integration/webhook/:provider`（admin/sysadmin 闸）                                                                                                                                                                                      | `src/http/connectorRouter.js:11-25`、`:71`、`:80`                               | 对象变化事件订阅可复用此入口                               |
| E6  | **CAS 原子写**：`casExpectStage` + `casExpectOwnerEmpty`，命中时 WHERE 追加校验，`rowCount===0` 即拒                                                                                                                                                                               | `particleRepo.js:203`、`:232-242`                                              | **Rox"乐观并发"的我方同构** → 扩到字段值即可                 |
| E7  | **配置存储自带决策锚点**：`writeConfig(key, value, { tenantId, decisionId, updatedBy })`                                                                                                                                                                                       | `src/config/configStore.js:51`、`:64`                                          | 映射层配置**天然可审计、可挂决策**                          |
| E8  | **同步后重评闭环**：`monitorAccount` 做 rescore + appendMemory                                                                                                                                                                                                               | `monitorAccount.js:10-30`                                                     | 新数据进来后自动重评，**无需新建**                          |
| E9  | **巡检框架（11 个定时器）**：`nightly-distill` / `crm-risk-scan` / `lead-pool-recycle` / `decision-retro` / `sales-daily-scan` / `named-visit-scan` / `auditability-sla-snapshot` / **`ready-queue-pump`** / `provenance-patrol` / `integration-poll` / `calibration-sla-scan` | `src/scheduler/timers.js:163-466`、`riskScanner.js`、`salesDailyScan.js:52-109` | **感知面已在跑**；调度心跳直接复用 `ready-queue-pump`（60s）  |
| E10 | **告警判定（13 类规则）**：`approval_bottleneck` / `commit_red` / `coverage_gap` / `deal_stuck` / `forecast_breach` / `funnel_jitter` / `funnel_unhealthy` / `lead_overdue` / `lost_contact` / `named_visit_overdue` / `payment_due` / `payment_due_plan` / `payment_gap`     | `src/alerts/alertRegistry.js`、`ruleEvaluator.js`                              | **判断面 L1 已具备**，直接消费不重造                       |
| E11 | **事件触发层**：3 条规则（仅 `ontology` 域、`READ_ONLY_SKILLS` 全只读、冷却 300s + DB 去重 + 租户化），**已注册**                                                                                                                                                                                | `src/agent/eventTrigger.js`、`server.js:97`                                    | 骨架有、覆盖面窄 → **扩矩阵为三源（配置化）**                   |
| E12 | **`deferDecisionMint` 旁路**（handler 内自 mint，5 个 Action 已在用）                                                                                                                                                                                                          | `seed-actions.js:741/801/994/1055/1108`                                       | **常驻授权的现成范式**                                |
| E13 | **决策结果回写通道**（3 个 Action 已存在）                                                                                                                                                                                                                                        | `seed-actions.js:1791/1815/1870`                                              | **J2 反馈回路是"接电"不是造轮子**                        |
| E14 | **`agentTool: false` 免装配闭包范式**                                                                                                                                                                                                                                      | `connectorActions.js:132` 注释明文                                                | 同步/回写 Action 走此路，**免 agentSpec 三处同改**        |


### 2.2 缺口（逐条锚点）

| #   | 缺口                        | 证据                                                                                                                                                                          |
| --- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | **无 CRM 类适配器**            | `纷享/fxiaoke/销售易/xiaoshouyi/neocrm` **全仓零命中**；`salesforce/hubspot/zoho` 在 `src/` 仅 1 处且是 `anysite.js:105` 注释举例                                                               |
| G2  | **无对象级增量拉取**              | `timers.js:120-143` 现循环是"逐条富化"，**无游标、无对象遍历、无增量**                                                                                                                            |
| G3  | **无字段映射层**                | `genericRest.js:11` 的 `field_map` 是**单层扁平**（只服务 `enrich()`），**无方向、无类型校验、无静态值**                                                                                              |
| G4  | **无外部引用映射表**              | 无任何表/字段记录"客户 CRM 记录 ID ↔ 我方 particle_id"——**去重、幂等、回写定位的共同前提缺失**                                                                                                             |
| G5  | **无回写通道**                 | `connectorActions.js` 共 4 个 action（`:18` attio-enrich / `:53` zhizao-verify / `:99` tender-push / `:132` signal-lead-gen），**全部 write-into-us**                              |
| G6  | **无同步信任分级**               | 现范式 `autoDecision: true` → 每条写自 mint；批量同步若逐条 mint 会产生**决策洪水**                                                                                                               |
| G7  | **无同步可观测**                | 无同步成功率 / 游标滞后 / 冲突数 / 回写成功率落点                                                                                                                                               |
| G8  | **`updateParticle` 是浅合并** | `particleRepo.js:211` `{ ...cur.payload, ...patch }`——嵌套对象会被整体替换                                                                                                            |
| G9  | 🔴 **投递面断链**              | 见 §0.2 十行表格（`alertStore.js:6` 内存 Map / `crm.alert` 表不存在 / 端点零挂载 / hook 未注册 / 无视角 / 无页面 / 无 IM 通道）                                                                           |
| G10 | 🔴 **授权面结构性压制**           | `src/mcp/gateway.js:201` `if (!params?.decision_id && !def?.deferDecisionMint)` → **无决策依据即拒写**；`eventTrigger` 注释明文"事件触发任务无 decision_id，写操作必被第 0 闸拒" → 主动派发只能派 `kind:'read'` |
| G11 | **无中国协同系统通道**             | `钉钉/飞书/企业微信/wecom/dingtalk/lark` → `src/` 下 **0 命中**                                                                                                                        |
| G12 | **无 CSV 导入**              | `parseCsv/parseCSV/csv-parse` → `src/` 下 **0 命中**（仅 `billingRoutes.js:137` 有 CSV 导出）                                                                                        |

### 2.3 一条必须点破的结构性矛盾

|                                                                               |
| ----------------------------------------------------------------------------- |
| **我方安全模型的隐含假设是「每个写动作都由人发起并 mint 决策」——这与「主动」天然冲突。**                            |
| 要真正让 AI 主动干活，需要一个**常驻授权（standing authorization）**：先授权一个范围，范围内自动执行，事后审计 + 可撤回。 |
| **这不是取消第 0 闸，而是给它增加一类合法凭证**（§11.3）。                                           |

### 2.4 ⚠ 前提修正：常驻授权**已有一半**，不是从零引入

> **本节为 2026-09-15 源码级核验结论，修正 §2.3 与上一版的表述偏差。**
> 上一版写"必须引入常驻授权"，措辞暗示该能力为零。**核验后判定该措辞错误**——平台**已存在一个可运行、可配置、已驱动自主放行的分级授权机制**。
> 正确的表述是：**骨架已在，缺的是"授权对象化"的那一半**。

**已有的一半（源码实证，非推断）**：

| 常驻授权要素 | 现状 | 源码锚点 |
| --- | --- | --- |
| ① **授权范围界定** | ✅ **已落地** | `crm.business_tier_config`：`(dimension, dimension_value) → tier`，二维 `customer × project`（`db/schema.sql:248-254`） |
| ② **范围内差异化放行** | ✅ **已落地** | `autonomyEngine.js:274` `escalated = forceException \|\| tier==='HIGH' \|\| (tier!=='HIGH' && conf < threshold)` |
| ③ **事后审计（执行留痕）** | ✅ **已落地** | 决策落库 `state='AUTONOMOUS'` / `decider_type='AUTONOMOUS_AGENT'`（`autonomyEngine.js:292-295`）+ `recordDecisionEvent('autonomous')` |
| ④ **范围可配置、可后台改** | ✅ **已落地** | `PUT /api/business-tier-config`（`businessTier.js:151`），写走第 0 闸 `requireDecision('config-change')`（`:102-110`） |
| ⑤ **租户级隔离** | ✅ **已落地** | 复合 PK `(tenant_id, dimension, dimension_value)` + `ensureTenantBusinessTiers` 懒克隆（`businessTier.js:47-60`） |

**用户实际配置的二维（`db/migrate.js:386-399` 出厂种子 + `src/web/pipeline.html:67-68` 前端入口）**：

| 维度 | 取值 | tier 映射 |
| --- | --- | --- |
| `customer` | `STRATEGIC` / `KEY` / `NORMAL` | HIGH / HIGH / NORMAL |
| `project` | **`A` / `B` / `C`** | HIGH / NORMAL / **LEAD** |

> **两维取高风险优先**（`decisionRepo.js:68` `rank = Math.max(rank, ...)`）。因此**「C 类项目」不等于「低风险」**：若客户维为 `STRATEGIC`/`KEY`，整体 tier 仍为 `HIGH` → 一律升级，C 类也不例外。

**缺的另一半（三个断点，全部为源码级实证）**：

| # | 断点 | 现状 | 证据 |
| --- | --- | --- | --- |
| **D1** | **无授权元数据** | 表仅 4 列，无 `approved_by` / `approved_at` / `expires_at` / `revoked_at` / `decision_id` | `db/schema.sql:248-254` |
| **D2** | **溯源断链** | 写分级**确实**生成了第 0 闸决策（`produceDecision`），但**决策 id 不落库**，只回显给前端 → 事后无法回答"这条分级是谁批的" | `businessTier.js:102-110` 产出 → `:143` 仅 `res.json` 回显 |
| **D3** | **分级配置不在决策冻结范围内** | `POLICY_KEYS` 9 个键**不含**分级项；改一次分级，历史决策的 `effective_policy_version` **完全不变** | `policyVersion.js:29-34` |
| **D4** | **无撤回/暂停语义** | `upsertTier` 只有 `ON CONFLICT DO UPDATE SET tier=$4`，改值即"撤回"；无"暂停该授权范围"的操作面与语义 | `businessTier.js:92-98` |

> **D3 是最严重的一条**：`policyVersion.js:4-6` 明确声明"事后改配置**不得洗掉**历史决策的判定依据"——**该承诺对分级配置不成立**。回看一条 `tier=LEAD → AUTONOMOUS` 的历史决策，无法回答"当时为什么判 LEAD"，因为判定依据（分级表）既无版本冻结、也无变更留痕。**审计链在此处断开。**

**另两个附带实证缺陷（与本设计直接相关，须一并修）**：

| # | 缺陷 | 说明 | 证据 |
| --- | --- | --- | --- |
| **E1** | `autonomous_allowed` **配置面 ≠ 执行面（假绿）** | 前端显示 `✅自主/⛔人工`、配置页映射 `auto_decision`，但 `requireDecision` 主路径**完全不读该字段** → 配了不生效 | 配置面 `decisionScenario.js:126` / `controlledConfigPages.js:84`；执行面 `autonomyEngine.js:274` 未引用。`:251` 的 `highNoAuto` 为 dead variable |
| **E2** | **`A/B/C` 术语碰撞（且方向相反）** | `advice.tier` 的 A/B/C（对话建议档：C = 证据不足**禁止处置**）与项目维取值 A/B/C（C = 低风险**可自治**）**同名而语义相反**；且跨轴投影 `business_tier` 把建议 C 档标成 `NORMAL`（可自主）= **语义反转** | `adviceStore.js:46`（旧：`'B'`→`HIGH`，其余→`NORMAL`）vs `migrate.js:398`（`'C'`→`LEAD`）。**✅ 2026-09-16 已修**（见 §11.1.1） |
| **E3** | **建议链路断链** | `buildAdviceAnchor()` 是孤儿导出（`src/` 零调用），`ADVISED` 是死状态 → **"AI 曾建议过什么"从未落库** → 无法度量建议准确率/采纳率（第 9 大能力缺一条回路） | `adviceStore.js` 全仓唯一引用 = 其测试；`advise()` 6 处生产调用（`gateway.js:213/238/343` 等）**只即时回显**。**✅ 2026-09-16 已修**——**方案修正为 (iv) 独立运行态表 `crm.advice_record`**（原推荐 (i) 落 `crm.decision` 经消费面盘点被否决：8 个统计面会被污染 + 证据不足时被 interception 拦下，见 §11.1.1） |

**结论（本设计 §11 的修正立场）**：

> **不是"引入常驻授权"，而是"把已运行的分级机制升级为可审计、可撤回的授权对象"。**
> 具体为 4 条：**(1)** 补授权元数据列；**(2)** 补 `decision_id` 落库（接上 D2 溯源）；**(3)** 把分级配置纳入 `POLICY_KEYS`（修 D3 审计断链）；**(4)** 补 `paused` / `revoked` 状态语义与操作面（修 D4）。
> 其中 **(3) 是成本最低、价值最高的一条**——单点改动即可让全部历史与后续决策的自主判定依据变得可追溯。

---

## §3 目标 / 非目标 / 硬约束

### 3.1 目标

1. 客户**不必停用/搬迁**任何既有 CRM，我方在其旁建立**上下文与判断层**；
2. 客户 CRM 的真实数据成为我方决策输入（消除"AI 无上下文 → 九尺子 8 项评分恒 0"的死结）；
3. 我方产出的富化 / 洞察 / 决策结论**写回客户 CRM 指定字段**，进入客户日常工作流；
4. 我方的主动产出**出现在人一定会看到的地方**（不止是"能查到"）；
5. 低风险动作在**受控授权**下自动执行，且**可审计、可回滚、可停**。

### 3.2 非目标（明确不做）

- 不做完整双向同步（变更来源消歧 + pending 对账 + Fivetran 级管道）；
- 不做"取代客户 CRM"的任何产品叙事或技术路线；
- 不做 schema-less 自由生长（Lightfield 路线）；
- 不做任意脚本 / 表达式映射；
- 不做"发送即送达"式的无证据投递；
- 不做 always-on 全自动。


### 3.3 硬约束（继承既有，不可偏离）

| 约束                    | 出处                                          | 遵守方式                                                                                                                             |
| --------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **不新增粒子类型 / 不改业务域模型** | 2026-09-08 已批设计 §10                         | 读入落既有 `CRM_ACCOUNT`/`CRM_CONTACT`/`CRM_DEAL`/`CRM_LEAD`/`CRM_PRODUCT`（`db/schema.sql:14`）；7 张新表**全为运行态表**（与 `crm.tasks` 同类，非粒子域；含 E3 的 `advice_record`） |
| **绝对禁 DELETE**        | 项目铁律                                        | 同步只增改；外部记录消失 → `external_deleted_at` 软标记；关闭信号 / 撤销授权 / 否决执行**全部为状态字段变更**                                                         |
| **写操作过决策第 0 闸**       | 铁律                                          | 批量入库一次 run mint 一个决策（`sync_cursor.decision_id`）；回写逐批审批；常驻授权走 `deferDecisionMint` 并带 `grant_ref`                                  |
| **租户隔离**              | `src/http/tenantScope.js:4` `scopeTenant()` | 全部新表带 `tenant_id`；配置 per-tenant；凭据按租户解密                                                                                          |
| **配置 100% 后台化**       | 项目铁律                                        | 映射 / 频率 / 方向 / 信任级别 / 节律 / 渠道路由全在 `config_store`，**零硬编码字面量**                                                                     |
| **HITL 零信任**          | 项目铁律                                        | 首次接入、映射变更、信任级别提升、启用回写 → 人工确认；**信任级别不可自动提升**                                                                                      |
| **建表单一事实源**           | 项目约定                                        | 7 张表 DDL 追加 `db/schema.sql`；`CREATE TABLE IF NOT EXISTS` + `ALTER ADD COLUMN IF NOT EXISTS` 补列                                   |
| **凭据不出口**             | 项目约定                                        | 沿用 `credentialVault` pgcrypto at-rest；token 缓存值亦加密落库，不进日志 / 前端 / memory                                                          |
| **不静默失败**             | 项目约定                                        | 投递失败写 `last_error` + `monitor_event`；巡检失败 `recordFailure`；降级/暂停发通知                                                               |

---


## §4 总体架构：三条线

```
┌──────────────────────────────────────────────────────────────────────┐
│  客户既有 CRM（纷享销客 / 销售易 / 自研）—— 记录层，我方不取代        │
└───────────────┬──────────────────────────────────┬───────────────────┘
                │ ① 读入（增量 + 游标）             │ ④ 回写（白名单字段）
                ▼                                  ▲
┌──────────────────────────────────────────────────────────────────────┐
│  线 A｜共生同步线  src/sync/                                         │
│  engine · cursor · upsert · entityResolver · CrmProvider 契约        │
│  ── crm.external_ref（外部记录 ↔ 粒子 稳定对应，去重/幂等的共同前提）│
│  ── crm.sync_cursor（游标 · 运行态留痕）                             │
└───────────────┬──────────────────────────────────────────────────────┘
                │ ② 落既有粒子（不新增粒子类型）
                ▼
┌──────────────────────────────────────────────────────────────────────┐
│  我方判断层（既有）                                                  │
│  粒子 + 七维记忆矩阵 + 决策脊柱 + K-M-D 管道 + 九尺子（8 确定性+1 LLM）│
│  + 决策第 0 闸 + 8 断言族 + 19 个 method-* SKILL + Action Registry    │
└───────────────┬──────────────────────────────────────────────────────┘
                │ ③ 判断产出（告警 / 建议 / 执行）
                ▼
┌──────────────────────────────────────────────────────────────────────┐
│  线 B｜主动运行时  src/signal/                                       │
│  感知（三源触发器）→ 判断（L1阈值/L2上下文/L3主动研究）              │
│  → 投递（inbox/email/im/webhook 四 provider）→ 授权（常驻授权 T1）   │
│  ── crm.signal（统一收口，替换内存 Map）                             │
│  ── crm.signal_delivery（投递流水，**防假绿核心**）                  │
│  ── crm.standing_grant + crm.grant_execution（自治 + 执行流水）      │
└───────────────┬──────────────────────────────────────────────────────┘
                │ ⑤ J2 反馈回写（hitl_verdict → decision.outcome）
                └──────────────► 回到判断层（闭环三条腿补齐）
```

**线间关系（关键）**：线 B 的排名 7–8 客户价值（一键采纳、自动执行）**依赖线 A**——"采纳"的落点之一就是"回写客户 CRM"。反之线 A 的 S3 之后也依赖线 B 的投递面（同步失败要让人知道）。**两线共用同一套运行态表与配置层，不重复建设。**

---

## §5 方案选型

### 5.1 线 A（共生同步）

| 维度       | 方案 A 适配器扩展式                                    | **方案 B 同步内核 + 统一契约（选定）**                             | 方案 C 借道第三方 iPaaS        |
| -------- | ---------------------------------------------- | ---------------------------------------------------- | ----------------------- |
| 做法       | 仅加 `fxiaoke`/`neocrm` 两个 kind，复用扁平 `field_map` | 新建 `src/sync/` 内核 + 厂商适配器实现统一 `CrmProvider`          | 不自建，由轻易云类平台推到我方 webhook |
| 接第二家成本   | 复制粘贴（映射能力不足）                                   | 写一个适配器，内核不动                                          | 零开发                     |
| 回写落点     | 无                                              | 契约方法 `writeBack()`                                   | 需外部平台反向开发               |
| 映射可审计性   | 低                                              | **高**（落 `config_store`，可 diff / 可回滚 / 可挂 decisionId） | 低（黑盒）                   |
| 与"可验证"定位 | 中                                              | **高**                                                | **低**                   |
| 长期成本     | **高**（每接一家重构一次）                                | 低                                                    | 中（供应商锁定）                |

**选 B 的判据**：①"接第二家"必然发生（客户名单中同时有纷享销客、销售易、自研）；②方案 A 的单层扁平 `field_map` 撑不住对象级同步与回写，届时仍要重构成 B，已完成的工作返工；③方案 C 的数据链路在黑盒中，与"可验证可审计"定位直接冲突，并引入供应商与合规风险。

### 5.2 线 B（主动运行时）

|                   | 做法                                               | 风险           | 判定                                 |
| ----------------- | ------------------------------------------------ | ------------ | ---------------------------------- |
| A · 投递补链式         | 只挂载接口 + 建表 + 进待办 + 首页卡                           | 最低           | 不够（用户已定"全四层"）                      |
| **B · 四层渐进式（选定）** | S1 出口 → S2 入口/感知 → S3 判断 → S4 回写 → S5 研究 → S6 授权 | 逐层可独立交付 / 回滚 | ✅                                  |
| C · 授权优先式         | 先做常驻授权与自主执行，投递当附属                                | **最高**       | ❌ **在"没人看得见"的状态下放开写权限，等于把假绿放大成真错** |

---

## §6 补齐清单（扩展已有骨架，零新概念）

> **补齐** = 复用既有机制，仅扩展 schema / 分支 / 语义。


### 6.1 线 A 补齐

| 优先     | #    | 补齐项                                     | 现状锚点                                                                          | 动作                                                                                                                     | 客户价值                         |
| ------ | ---- | --------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| **P0** | A-B1 | `integration-providers` 描述符扩为"同步对象契约"   | `tenantInstances.js:19-29` 现读 `id/kind/enabled/endpoint/field_map/signal_map` | 增 `objects[]`（`{name, direction, cadence_min, mapping_ref, cursor, id_field, since_field}`）、`token_mode`、`trust_level` | "接哪个系统、哪些对象、怎么同步"变成**管理员配置** |
| **P0** | A-B2 | `credentialVault` 支持结构化凭据               | `credentialVault.js:34-49` 现把整段密文当单个字符串密钥                                     | 允许 JSON 结构（纷享 `appId/appSecret/permanentCode`、销售易账号密钥）；token 缓存值与过期时间**加密落库**，不落内存全局                                   | 客户凭据不出口、不进日志、不进前端            |
| **P0** | A-B3 | `tenantInstances.KIND_FACTORY` 加两个 kind | `tenantInstances.js:9-13` 现 3 个 kind                                          | 加 `fxiaoke`、`neocrm`（自研 CRM 用 `generic-rest` 覆盖）                                                                       | 客户无论用哪家套装都能接                 |
| **P0** | A-B4 | CAS 语义从"阶段/归属"扩到"字段值"                   | `particleRepo.js:203`（签名）、`:232-242`（实现）                                      | 增 `casExpectField: {path, value}` / `casExpectExternalUpdatedAt`；不匹配即在 WHERE 层拒绝并**回传最新值**                             | **回写安全的地基**（Rox 乐观并发的我方实现）   |
| **P1** | A-B5 | `connectorRouter` 增"对象变化事件"路由分支         | `connectorRouter.js:11-25` 现 webhook 只派发 `conn-signal-lead-gen`               | 按 `event.object` 路由到同步内核 upsert；沿用 admin/sysadmin 闸                                                                    | 从"每 6h 轮询"升级为"客户 CRM 一变我就知道" |
| **P1** | A-B6 | `integration-poll` 增"对象增量拉取"分支          | `timers.js:120-143` 现仅逐条富化                                                    | 在既有租户循环内增分支：按 `objects[].cursor` 拉增量 → 内核 upsert；沿用 `recordTokens` 与 `emit('trace')`                                   | **不新增定时器、不改调度框架**，零调度层回归风险   |
| **P1** | A-B7 | `monitorAccount` 复用为"同步后重评"             | `monitorAccount.js:10-30`                                                     | upsert 落地后调用，触发 rescore + appendMemory                                                                                 | 新数据立刻影响决策，无需新建重评链路           |
| ~~P2~~ | ~~A-B8~~ | ~~`updateParticle` 增嵌套感知合并选项~~（**2026-09-16 裁决：不做**）              | `particleRepo.js:211` 浅合并                                                     | **归入 §15.2 #6 红线**（"完整双向同步不做"）——`patchMode:'deep'` 只在"我方字段与外部字段同层共存且需部分回写"时才需要，而该场景已被 §15.2 #6 排除；**保留浅合并语义**，不预留未使用的开关                | —（原拟"增量同步不误伤同层其它字段"，随 §15.2 #6 一并作废）                |

> **实施状态不在本表**：本表是"要做什么"的设计意图，**做到没做到**以 **附录 E.2** 为准（该表以**可复跑判据**逐条表述，避免快照结论在并行开发下半衰期过短）。
> **A-B7 分类更正（2026-09-16）**：原列入"补齐清单"（= 复用既有机制），实际**依赖不存在的 `ctx.rescore` / `ctx.getAccount` 实现**（全仓 `grep -rn "function rescore" src/` → 0；`monitorAccount.js:10` 要求的 ctx 四件套中两件无实现）→ 属**新建能力**而非补齐。详见附录 E.2。
> **A-B8 裁决依据**：§15.2 #6 已明示"完整双向同步不做"；A-B8 若无该场景则无消费方，保留即为"未使用的开关"（其风险大于收益）。**如需重启，须先推翻 §15.2 #6。**

### 6.2 线 B 补齐

| #        | 补齐项                                   | 现状                               | 落点                                                                   |
| -------- | ------------------------------------- | -------------------------------- | -------------------------------------------------------------------- |
| **B-B1** | 挂载 `alertEndpoints` 的 8 个端点           | 清单存在、处理器存在、**零调用**               | `src/http/routes.js`                                                 |
| **B-B2** | 注册 `registerAlertHook`                | 未注册（`server.js:74` 只有 finance 版） | `src/http/server.js`                                                 |
| **B-B3** | ~~`alertStore` 由内存 Map 迁 DB~~ **（2026-09-16 更正）** | 内存 Map、表不存在                      | **不建 `crm.alert` 表**：实现为**内存 Map + 写 `crm.signal` 统一收口**——`crm.signal` 已是全告警的统一落点，另建表会造出第二个告警事实源。**落点=信号域**（判据与证据见附录 E.3）                           |
| **B-B4** | 工作台增加信号视角（第 7 视角）                     | 六视角无信号                           | `src/http/workbenchRouter.js`（对齐 `:101-175` case 结构）                 |
| **B-B5** | 首页信号卡（对齐 Rox Home）                    | 无                                | `src/web/home.html`                                                  |
| **B-B6** | 事件触发从单域扩为三源                           | 仅 `ontology`                     | `src/agent/eventTrigger.js`（键名 `agent-event-trigger` 不变，**向后兼容扩矩阵**） |
| ~~**B-B7**~~ | ~~复用 SMTP（抽公共 mailer）~~ **（2026-09-16 落点更正）** | SMTP 仅计费域在用                      | **不抽 `src/mail/`**：实际共用的是**配置契约**而非代码——信号域 `src/signal/delivery/email.js` 直接复用计费域既有惯例（`SMTP_USER`/`SMTP_PASS` + Brevo，源自 `src/http/activation.js`）。抽中间层只会为两处调用造一个壳，且两域投递语义不同（交易通知 vs 业务提醒，模板与重试策略各异）。**重启条件（三次法则）**：出现第三处 SMTP 消费方时再抽                                              |
| **B-B8** | 复用 13 类规则 + `salesDailyScan` 作为 L1 判断 | 已实现                              | 直接消费，**不重造**                                                         |
| **B-B9** | 复用 `ready-queue-pump` 作为调度心跳          | 已实现（60s）                         | 直接复用，**不新增定时器**                                                      |

> **实施状态不在本表**：同 §6.1——本表是设计意图，**做到没做到**以 **附录 E.3** 为准（逐条可复跑判据）。
> **两项落点更正（2026-09-16）**：`B-B3` 不建 `crm.alert`（改由 `crm.signal` 统一收口）；`B-B7` 不抽 `src/mail/`（改复用 SMTP 配置契约，三次法则再抽）。**两处均为"实现先行、设计滞后"的追认**，非实现偏离。

---

## §7 新增清单（真正新建）


### 7.1 线 A 新增

| 优先     | #    | 新增项                                       | 为什么必须新建                                                               | 落地位置                                                                                                                                                                   |
| ------ | ---- | ----------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P0** | A-N1 | **厂商无关同步内核**                              | 无任何"增量拉取 / 游标推进 / upsert / 实体对齐"引擎（`integration-poll` 是逐条富化循环，不是同步引擎） | `src/sync/`（`engine.js` / `cursor.js` / `upsert.js` / `entityResolver.js`）；契约方法 `discoverObjects()` / `readIncremental(cursor)` / `writeBack(fields)` / `verifyAuth()` |
| **P0** | A-N2 | **字段映射层** `config_store['sync-mappings']` | 现 `field_map` 是适配器内扁平字典，**无方向、无类型校验、无静态值、不可独立审计**                     | 声明式结构（见 §9.1）；映射变更走 HITL + `decisionId`                                                                                                                                |
| **P0** | A-N3 | **外部引用映射表** `crm.external_ref`            | 无机制记录"客户 CRM 记录 ↔ 我方粒子"对应（G4）。**去重、幂等、回写定位的共同前提**                     | 新表（§8.1）。**不新增粒子类型**，仅映射表                                                                                                                                              |
| **P0** | A-N4 | **单向回写通道**（新 Action）                      | 4 个 connector action 全为 write-into-us（G5）                             | `sync-writeback-fields`（`kind:'write'`, `namespace:'sync'`, `agentTool:false`, `needsApproval:true`, `autoDecision:true`）；**必带静态标记** `Source='crm-ai-native'`          |
| **P0** | A-N5 | **同步信任分级** `config_store['sync-trust']`   | 现每条写自 mint → 批量同步会决策洪水；完全免检则违背写侧零信任                                   | 三档：**L1 只读** / **L2 批量入库**（一次 run mint 一个决策）/ **L3 回写**（逐批审批 + 首 N 批人工确认）。**默认 L1 起步**                                                                                 |
| **P1** | A-N6 | **同步可观测指标**                               | 无成功率/滞后/冲突/回写成功率（G7）                                                  | 复用 `src/monitor/` + `emit('trace')`；指标 `sync_lag_minutes` / `sync_success_rate` / `conflict_count` / `writeback_count`，**上墙门户页**                                       |


### 7.2 线 B 新增

| #        | 新增项                                                                                     | 说明                                                               | 为何必须新建                     |
| -------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | -------------------------- |
| **B-N1** | `crm.signal` 表                                                                          | 信号统一收口（rule-scan / event-trigger / agent-research / external 四源） | 内存 Map 无法支撑投递、去重、审计        |
| **B-N2** | `crm.signal_delivery` 表                                                                 | 投递流水（渠道 / 收件人 / 状态 / 错误 / 重试）                                    | **防假绿**：`send 被调用` ≠ `已送达` |
| **B-N3** | `src/signal/` 模块                                                                        | `store` / `router` / `digest` 三件套                                | 统一收口，避免重蹈"清单在但挂载方没来"       |
| **B-N4** | `src/signal/delivery/` provider 契约 + 四实现                                                | `inbox` / `email` / `im` / `webhook`                             | 用户已定"全渠道可配置"               |
| **B-N5** | `config_store['signal-delivery']`                                                       | 渠道路由（severity→channel、role→recipient）、频次上限、静默时段                  | 阈值配置化铁律 + 防骚扰              |
| **B-N6** | `config_store['signal-schedule']`                                                       | 时间型节律表（T+n 未跟进、报价 T+n 未审批、阶段静默等）                                 | 让时间型触发**配置化而非硬编码**         |
| **B-N7** | L3 主动研究调度 `config_store['agent-research-schedule']`                                     | 按节律选对象 → 跑**只读 SKILL** → 产出建议卡                                   | 判断面从阈值升到"想好了"              |
| **B-N8** | `crm.standing_grant` + `crm.grant_execution` + `config_store['standing-grants-policy']` | 常驻授权凭证 + 执行流水 + 全局策略                                             | 授权面（§11.3）                 |
| **B-N9** | `src/web/signal-center.html`                                                            | 信号中心页（列表 / 筛选 / 采纳 / 否决 / 静默）                                    | 人一定会看到的地方                  |

---

## §8 数据模型（7 张新表：§8.1–§8.6 共 6 张 + §8.7 第 7 张）

> 遵循项目约定：`CREATE TABLE IF NOT EXISTS`；`tenant_id` 默认 `'system'`；**不物理 DELETE**（软态翻转）；DDL 追加 `db/schema.sql`（单一事实源）。  
> **本节 7 张表全部为运行态表，非粒子域**，与 `crm.tasks` 同类——**不触碰 §10「不新增粒子类型、不改业务域模型」**。  
> **表清单**：§8.1 `external_ref`（14 列）· §8.2 `sync_cursor`（13 列）· §8.3 `signal`（20 列）· §8.4 `signal_delivery`（12 列）· §8.5 `standing_grant`（21 列）· §8.6 `grant_execution`（13 列）· **§8.7 `advice_record`（18 列，E3 建议落库·A 轴）**。
> 凡下文称"7 张新表"者即指此 7 张。**2026-09-16 已做 DDL 三向对账**（废弃草案 / 本设计 / 实际 `db/schema.sql`），差异全部闭合，逐项处置见各小节内的「📌 2026-09-16 回填」块。


### 8.1 `crm.external_ref` —— 外部引用映射（线 A｜A-N3）

```sql
-- 用途：客户 CRM 记录 ↔ 我方粒子 的稳定对应关系。去重、幂等 upsert、回写定位的共同前提。
-- 铁律：不物理 DELETE（外部记录消失 → external_deleted_at 软标记）；tenant_id 全表隔离。
CREATE TABLE IF NOT EXISTS crm.external_ref (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             TEXT NOT NULL DEFAULT 'system',
  provider              TEXT NOT NULL,              -- fxiaoke | neocrm | generic-rest | ...
  external_object       TEXT NOT NULL,              -- 客户 CRM 侧对象 API 名（如 AccountObj / account）
  external_id           TEXT NOT NULL,              -- 客户 CRM 侧记录主键
  particle_type         TEXT NOT NULL,              -- 我方粒子类型（既有类型，禁新增）
  particle_id           UUID NOT NULL,
  external_updated_at   TIMESTAMPTZ,                -- 客户侧最后修改时间（增量游标依据）
  last_synced_at        TIMESTAMPTZ,
  last_direction        TEXT,                       -- in | out（最近一次同步方向，供冲突定位）
  last_hash             TEXT,                       -- 上次同步内容哈希（变更检测 / 冲突比对）
  external_deleted_at   TIMESTAMPTZ,                -- 软态：客户侧已删除（绝不物理删我方粒子）
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider, external_object, external_id)
);
CREATE INDEX IF NOT EXISTS idx_external_ref_particle
  ON crm.external_ref(tenant_id, particle_type, particle_id);
CREATE INDEX IF NOT EXISTS idx_external_ref_cursor
  ON crm.external_ref(tenant_id, provider, external_object, external_updated_at);
```

**`particle_type` 仅取既有值**：`CRM_ACCOUNT` / `CRM_CONTACT` / `CRM_DEAL` / `CRM_LEAD` / `CRM_PRODUCT`（来源 `db/schema.sql:14` 注释）。


### 8.2 `crm.sync_cursor` —— 同步运行留痕（线 A｜A-N3）

```sql
-- 每租户 × provider × object 一行"运行态"（禁删：upsert 更新，不新建行历史堆积）
CREATE TABLE IF NOT EXISTS crm.sync_cursor (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          TEXT NOT NULL DEFAULT 'system',
  provider           TEXT NOT NULL,
  external_object    TEXT NOT NULL,
  cursor_value       TEXT,                          -- 增量游标（last_modified 时间戳 / 自增水位）
  last_run_at        TIMESTAMPTZ,
  last_status        TEXT NOT NULL DEFAULT 'idle'   -- idle | running | ok | degraded | failed
                     CHECK (last_status IN ('idle','running','ok','degraded','failed')),
  last_error         TEXT,
  last_counts        JSONB NOT NULL DEFAULT '{}'::jsonb,  -- { read, created, updated, skipped, conflicted }
  token_cost         NUMERIC NOT NULL DEFAULT 0,
  decision_id        UUID,                          -- 本批同步所挂决策锚点（写侧第 0 闸）
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider, external_object)
);
CREATE INDEX IF NOT EXISTS idx_sync_cursor_health
  ON crm.sync_cursor(tenant_id, last_status, last_run_at);
```


### 8.3 `crm.signal` —— 信号统一收口（线 B｜B-N1，替换内存 Map）

```sql
CREATE TABLE IF NOT EXISTS crm.signal (
  signal_id     TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL DEFAULT 'system',
  source        TEXT NOT NULL,                      -- rule-scan | event-trigger | agent-research | external
  kind          TEXT NOT NULL,                      -- 13 类告警 kind + 新增 kind
  severity      TEXT NOT NULL,                      -- low | medium | high
  target_role   TEXT NOT NULL,                      -- sales | finance | exec | ops
  owner_id      TEXT NULL,                          -- 责任人（投递路由第一依据）
  l2c_stage     TEXT NULL,
  particle_id   TEXT NULL,
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
  evidence      JSONB NOT NULL DEFAULT '{}'::jsonb, -- 证据链（来源、快照、阈值、规则版本）
  suggestion    JSONB NOT NULL DEFAULT '{}'::jsonb, -- 建议卡（L3）：{headline, reasoning, evidence_refs, action_name, action_params}
  status        TEXT NOT NULL DEFAULT 'open',       -- open | acked | closed | acted
  dedup_key     TEXT NULL,                          -- 幂等去重键：kind:particle_id:bucket
  decision_id   TEXT NULL,                          -- 本信号处置所依据的决策凭证（采纳必带，第 0 闸）
  action_ref    TEXT NULL,                          -- 采纳后触发的 Action 名
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  acked_at      TIMESTAMPTZ NULL,
  closed_at     TIMESTAMPTZ NULL,
  acted_at      TIMESTAMPTZ NULL,                   -- 采纳执行完成时间戳（setStatus 'acted'）
  closed_reason TEXT NULL                           -- 关闭原因（关闭路径必填）
);
-- 去重索引：谓词必须与 src/signal/store.js 的 findOpenByDedup 查询谓词**逐字一致**
CREATE UNIQUE INDEX IF NOT EXISTS idx_signal_dedup
  ON crm.signal(tenant_id, dedup_key) WHERE dedup_key IS NOT NULL AND status IN ('open','acked');
CREATE INDEX IF NOT EXISTS idx_signal_open
  ON crm.signal(tenant_id, status, severity, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_signal_kind
  ON crm.signal(tenant_id, kind, created_at DESC);
```

**幂等写入语义**：`ON CONFLICT (signal_id) DO NOTHING` + 回查既有行（同一告警经多条落库路径只落一行且不报错）；`dedup_key` 命中**未关闭**信号时复用既有行（`findOpenByDedup`），避免同一事实每 30 分钟刷一条。`bucket` 由 `config_store['signal-schedule'].bucket` 决定（默认按日）。

> **📌 2026-09-16 回填与修正（本表与实现的差异已闭合，见 `2026-09-16-design-merge-audit.md` §6.1）**
>
> | # | 项 | 本设计原状 | 处置 |
> | - | -- | ---------- | ---- |
> | ① | `acted_at` 列 | **设计缺失** | 回填：采纳置 `acted` 时写时间戳（与 `acked_at`/`closed_at` 同族的 COALESCE 幂等写法） |
> | ② | 去重索引名与谓词 | 原为 `uq_signal_dedup`，谓词 `WHERE dedup_key IS NOT NULL`（**全状态唯一**） | **修正**：索引名对齐实现 `idx_signal_dedup`；谓词收窄为 `dedup_key IS NOT NULL AND status IN ('open','acked')`。原谓词是真实缺陷——信号 `closed` 后 `dedup_key` 仍占位，同类告警再产生时 `INSERT` 撞唯一索引抛 23505（经 persister 时静默丢失），表现为"该对象该小时永远沉默"。既有库修正迁移：`db/migration-signal-dedup-index.sql` |
> | ③ | `idx_signal_inbox` / `idx_signal_open_kind` | 设计命名与列组合 | 对齐实现为 `idx_signal_open(tenant_id,status,severity,created_at DESC)` 与 `idx_signal_kind(tenant_id,kind,created_at DESC)`（`owner_id` 未进索引：收件箱查询已由 `idx_signal_open` 覆盖） |
> | ④ | `decision_id` / `action_ref` | 设计有列、**实现无列且 `setStatus` 忽略 `extra`** | **已补实现**（2026-09-16）：`db/schema.sql` + `db/migration-signal-adoption-trail.sql` 加三列；`src/signal/store.js` `setStatus` 增列白名单落库。**缺陷实况**：`src/signal/adoption.js:11` 一直在传 `{action_ref, decision_id}`、`src/http/routes.js:390` 与 `adoption.js:23` 一直在传 `{reason}`，三处**静默丢字段**且测试不可见（`test/signal/adoption.test.js` 注入的是假 store）→ 采纳回路无法回答"哪个决策批准的 / 采纳后触发了哪个 Action" |
> | ⑤ | `closed_reason` 落库通路 | 设计有列、实现无列 | 已补。落库白名单与别名：`{reason}` → `closed_reason`；未识别键（如调用方传的 `rejected_by`）**回显 `ignored_extra` 而非静默吞掉**。`rejected_by` 不再传向本表——"谁否决的"由 `crm.decision_outcome.payload` + `decision_id` 指向的决策行承载，**同义双写会造出第二个可能漂移的事实源** |
>
> **落库白名单（`setStatus` 的 `extra` 仅接受以下键）**：`decision_id` | `action_ref` | `closed_reason`（别名 `reason`）。
> 防线：`test/signal/store.test.js` 含 ① 血缘落库断言 ②`ignored_extra` 回显断言 ③三列存在性真库守卫 ④**静态守卫**（扫描生产 `setStatus` 调用点载荷键 ⊆ 白名单∪别名，防"调用方传了、被调方没接"再次发生）。


### 8.4 `crm.signal_delivery` —— 投递流水（线 B｜B-N2，**防假绿核心表**）

```sql
CREATE TABLE IF NOT EXISTS crm.signal_delivery (
  delivery_id  TEXT PRIMARY KEY,
  signal_id    TEXT NOT NULL,
  tenant_id    TEXT NOT NULL DEFAULT 'system',
  channel      TEXT NOT NULL,                       -- inbox | email | im | webhook
  provider     TEXT NULL,                           -- smtp | dingtalk | wecom | feishu | custom
  recipient    TEXT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',     -- pending | sent | failed | skipped
  attempts     INT NOT NULL DEFAULT 0,
  last_error   TEXT NULL,
  provider_msg_id TEXT NULL,
  delivered_at TIMESTAMPTZ NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_delivery_signal ON crm.signal_delivery(signal_id);
CREATE INDEX IF NOT EXISTS idx_delivery_fail
  ON crm.signal_delivery(tenant_id, status, created_at DESC);
```

> **负向判据**：任何一次 `send` 调用都必须留下 `sent` 或 `failed` 行。**若渠道配置为启用状态而表中无对应投递行，视为假绿，验收不通过。**


### 8.5 `crm.standing_grant` —— 常驻授权凭证（线 B｜B-N8）

```sql
CREATE TABLE IF NOT EXISTS crm.standing_grant (
  grant_id        TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL DEFAULT 'system',
  title           TEXT NOT NULL,
  scope_actions   TEXT[] NOT NULL,                  -- 可自动执行的 Action 白名单
  scope_objects   TEXT[] NULL,                      -- 限定对象类型
  field_whitelist TEXT[] NULL,                      -- 允许自动写入的字段（T1 内部字段）
  risk_tier       TEXT NOT NULL DEFAULT 'T1',       -- T0 | T1 | T2 | T3（详见 §11.3）
  max_uses        INT NULL,
  used_count      INT NOT NULL DEFAULT 0,
  period          TEXT NULL,                        -- day | week
  limit_payload   JSONB NOT NULL DEFAULT '{}'::jsonb, -- 业务约束（金额上限等）
  status          TEXT NOT NULL DEFAULT 'active',   -- active | paused | revoked | expired
  approved_by     TEXT NOT NULL,
  approved_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  decision_id     TEXT NULL,                        -- 授权动作自身的决策凭证（溯源铁律）
  expires_at      TIMESTAMPTZ NULL,
  revoked_at      TIMESTAMPTZ NULL,
  revoked_reason  TEXT NULL,
  paused_at       TIMESTAMPTZ NULL,                 -- T20：信任降级 / 熔断暂停时间戳（降级事件可追溯到）
  paused_reason   TEXT NULL,                        -- T20：暂停原因（consecutive-rejects | usage-limit | ...）
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_grant_active
  ON crm.standing_grant(tenant_id, status, risk_tier);
```

> **📌 2026-09-16 回填**（原设计遗漏，见 `2026-09-16-design-merge-audit.md` §6.2）：
> `paused_at` / `paused_reason` 两列由 **T20-3「降级事件可追溯」** 引入，实现已随迁移
> `db/migration-standing-grant-paused.sql` 落地（`db/schema.sql` 同构），本设计此前未回填。
> 语义：`status='paused'` 是**状态**，`paused_at`/`paused_reason` 是**该状态的证据**——少后者则"为什么被暂停"不可追溯，
> 与 §11.4「熔断 / 降级 / 撤回全部为状态变更、零 DELETE」配套（撤回走 `revoked_at`/`revoked_reason`，暂停走 `paused_at`/`paused_reason`）。
> 另：本行 `risk_tier` 注释原写 `T1 | T2 | T3`，与 §11.3 的 **T0–T3 四档**不一致，已修正为 `T0 | T1 | T2 | T3`。

> **与既有分级表的分工（§11.0 三轴模型）**：本表是 **B/C 轴**（动作边界 + 授权凭证），承载"**这类动作能否自动做**"；
> `crm.business_tier_config` 是 **A 轴**（对象风险），承载"**这个对象值不值得人管**"。两者**不合并、不互替**——一次自动执行的放行需要两轴同时满足。
> `risk_tier`（T0–T3）**不是** `business_tier`（LEAD/NORMAL/HIGH）的重命名，两者粒度与语义均不同，**严禁相互赋值**。

### 8.6 `crm.grant_execution` —— 自主执行流水（线 B｜B-N8）

```sql
CREATE TABLE IF NOT EXISTS crm.grant_execution (
  execution_id TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL DEFAULT 'system',
  grant_id     TEXT NOT NULL,
  signal_id    TEXT NULL,                           -- 由哪条信号触发
  action_name  TEXT NOT NULL,
  target_id    TEXT NULL,
  before_state JSONB NOT NULL DEFAULT '{}'::jsonb,  -- 执行前快照（对照/回滚参照）
  after_state  JSONB NOT NULL DEFAULT '{}'::jsonb,
  decision_id  TEXT NULL,                           -- 执行决策（actor='standing-auth'）
  actor        TEXT NOT NULL DEFAULT 'standing-auth',
  hitl_verdict TEXT NULL,                           -- adopted | rejected | pending
  rejected_at  TIMESTAMPTZ NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_exec_grant ON crm.grant_execution(grant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_exec_verdict
  ON crm.grant_execution(tenant_id, hitl_verdict, created_at DESC);
```

### 8.7 `crm.advice_record` —— 建议运行态留痕（A 轴｜E3，**本设计第 7 张新表**）

> **📌 2026-09-16 回填**（原设计只在 §11.1.1 记录裁决过程、**未进 §8 数据模型**，见 `2026-09-16-design-merge-audit.md` §6.3）。
> 裁决结论：**刻意不落 `crm.decision`**——该表读取点众多（日报 / 复盘 / 校准样本 / 可审计性抽检等聚合面），
> 写入非决策行会**永久污染统计**；且 `createDecision` 的 `decided_at` 硬写 `now()` 无 NULL 免疫、
> 证据不足时会被 `sevenDimensionsCheck` 拦下——而建议恰产生于**证据不足**时。故独立成表，
> 与 `signal` / `external_ref` 同属**运行态表族**（非粒子域）。
> 实现落点：`db/schema.sql:1131`、迁移 `db/migration-advice-record.sql`；服务侧单一收敛点 `adviseService.advise()`。

```sql
CREATE TABLE IF NOT EXISTS crm.advice_record (
  advice_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          TEXT NOT NULL DEFAULT 'system',
  scenario_id        TEXT,
  stage              TEXT,
  advice_tier        TEXT,                          -- 建议档（ADVICE_MATURITY 轴，A/B/C），**非业务分级**
  disposition        TEXT,
  coverage           NUMERIC(6,4),
  card_confidence    TEXT,                          -- 建议卡置信档位（'high'/'medium'/'low'，字符串非数值）
  headline           TEXT,
  summary            TEXT,                          -- 结构化摘要（禁对话原文，≤120）
  hits               JSONB NOT NULL DEFAULT '[]'::jsonb,
  conditions         JSONB NOT NULL DEFAULT '[]'::jsonb,
  risk_flags         JSONB NOT NULL DEFAULT '[]'::jsonb,
  actor_id           TEXT,
  actor_role         TEXT,
  source             TEXT NOT NULL DEFAULT 'dialog-advisor',
  linked_decision_id TEXT,                          -- 采纳配对（后置回填）
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 轴约束（E2/E3）：建议档只能是 ADVICE_MATURITY 轴的 A/B/C。
  -- 本表**刻意不含**任何业务分级列（business_tier / LEAD|NORMAL|HIGH）——两轴枚举同名反向，
  -- 同表出现即会诱发"按字面同值搬运"的语义反转（守卫 test/advice-tier-axis.test.js）。
  CONSTRAINT ck_advice_record_tier_axis CHECK (advice_tier IS NULL OR advice_tier IN ('A','B','C'))
);
CREATE INDEX IF NOT EXISTS idx_advice_record_tenant_time
  ON crm.advice_record(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_advice_record_scenario
  ON crm.advice_record(tenant_id, scenario_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_advice_record_unlinked
  ON crm.advice_record(tenant_id, created_at DESC) WHERE linked_decision_id IS NULL;
```

> **两条不可违反的语义约束**（与 §11.1.1 同源）：
> ① `advice_tier` 的 `A/B/C` 属 **ADVICE_MATURITY 轴**（证据齐备度），与项目维取值 `A/B/C`（C → 可自治）**同名反向**，
> 保守投影仅 `A → NORMAL`，`B/C` 一律 `HIGH`；② 本表**不落对话原文**，只留结构化摘要 + 关键词（禁删，观测留痕）。

---

## §9 配置层（100% 后台化，零硬编码）

**全部 per-tenant，全部经既有 `readConfig(key,{tenantId})` / `writeConfig(key, value, {tenantId, decisionId, updatedBy})`**（`src/config/configStore.js:51/64`，自带 `decisionId` —— **写配置本身即带决策依据**）。


### 9.1 `config_store['sync-mappings']`（线 A｜A-N2，**声明式白名单**）

```jsonc
{
  "version": 1,
  "mappings": [
    {
      "object": "AccountObj",
      "particle_type": "CRM_ACCOUNT",
      "direction": "in",
      "identity": { "external_id_field": "_id", "since_field": "last_modified_time" },
      "fields": [
        { "external": "name",           "particle": "name",           "type": "string", "required": true },
        { "external": "industry",       "particle": "industry",       "type": "string" },
        { "external": "annual_revenue", "particle": "annual_revenue", "type": "number" },
        { "external": "owner_name",     "particle": "owner_name",     "type": "string" }
      ],
      "filters": { "exclude_deleted": true }
    },
    {
      "object": "AccountObj",
      "particle_type": "CRM_ACCOUNT",
      "direction": "out",
      "identity": { "external_id_field": "_id" },
      "fields": [
        { "external": "ai_fit_score",   "particle": "fit_score",   "type": "number" },
        { "external": "ai_next_action", "particle": "next_action", "type": "string" }
      ],
      "static_on_write": { "Source": "crm-ai-native" }
    }
  ]
}
```

**约束**：① 字段必须是**已声明的映射项**，未知字段一律拒绝（防越权字段写）；② `particle` 目标必须是既有粒子字段，**不支持表达式 / 脚本**（防注入）；③ 映射变更走 HITL + `decisionId` 落 `config_store`。

### 9.2 `config_store['sync-trust']`（线 A｜A-N5，信任分级）

```jsonc
{
  "version": 1,
  "default_level": "L1",
  "levels": {
    "L1": { "label": "只读观察期", "allow_read": true,  "allow_upsert": false, "allow_writeback": false },
    "L2": { "label": "批量入库",   "allow_read": true,  "allow_upsert": true,  "allow_writeback": false,
            "decision_granularity": "per_run" },
    "L3": { "label": "启用回写",   "allow_read": true,  "allow_upsert": true,  "allow_writeback": true,
            "decision_granularity": "per_run",
            "first_n_batches_require_human": 3 }
  },
  "writeback_fields_whitelist": ["ai_fit_score", "ai_next_action", "ai_risk_flags"]
}
```

### 9.3 `config_store['integration-providers']`（**扩展**，非新建）

```jsonc
{
  "id": "fxiaoke-prod",
  "kind": "fxiaoke",
  "enabled": true,
  "trust_level": "L2",
  "token_mode": "corp-access-token",   // 纷享：appId+appSecret+permanentCode → CorpAccessToken（7200s，须缓存）
  "objects": [
    { "name": "AccountObj",     "direction": "in", "cadence_min": 30, "mapping_ref": "AccountObj" },
    { "name": "ContactObj",     "direction": "in", "cadence_min": 60, "mapping_ref": "ContactObj" },
    { "name": "OpportunityObj", "direction": "in", "cadence_min": 30, "mapping_ref": "OpportunityObj" }
  ],
  "event_subscription": { "enabled": false, "objects": [] }
}
```

### 9.4 线 B 配置键

| 键                               | 语义        | 关键字段                                                                                                                                                                            |
| ------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `signal-schedule`（B-N6）         | 时间型节律表    | `rules[]: {id, kind, entity_type, condition, threshold, period, severity, target_role, enabled}`、`bucket`（去重窗口，默认 `day`）、`enabled`                                              |
| `signal-delivery`（B-N5）         | 渠道与路由     | `channels: {inbox:on, email:on, im:off, webhook:off}`、`route: {high:[im,email], medium:[email], low:[inbox]}`、`role_recipients`、`quiet_hours`、`rate_limit: {per_day, per_hour}` |
| `signal-digest`                 | 作战简报      | `enabled`、`period`（`daily`）、`at`（如 `08:30`）、`max_items`、`order`、`include_low`                                                                                                   |
| `agent-event-trigger`（B-B6 扩矩阵） | 变更型触发矩阵   | 沿用现键，行内新增 `source:'event'`，域从 `ontology` 扩到 `particle`/`approval`/`decision`；**旧行语义不变（向后兼容）**                                                                                   |
| `agent-research-schedule`（B-N7） | L3 主动研究节律 | `enabled`、`period`、`max_objects_per_run`、`daily_llm_budget`、`concurrency`、`select_rule`                                                                                         |
| `standing-grants-policy`（B-N8）  | 常驻授权全局策略  | `default_tier:'T1'`、`allow_tier_upgrade_by_ai:false`、`auto_pause_on_consecutive_rejects:3`、`max_daily_executions`、`notify_on_execution:true`                                    |

---

## §10 投递抽象（线 B｜provider 契约）

### 10.1 契约

```
provider = {
  id,                       // 'inbox' | 'email' | 'im' | 'webhook'
  verifyConfig(config),     // 配置自检（缺凭据/域名非法 → 拒绝启用，fail-closed）
  send({ signal, recipient, channelConfig }) → { ok, provider_msg_id, error }
}
```

新增实现（B-N4）：`inbox`（平台内，默认启用）、`email`（复用 §6.2 B-B7 抽出的公共 mailer）、`im`（dingtalk / wecom / feishu，**仅外发**）、`webhook`（通用）。

### 10.2 投递流程

```
signal 落库(crm.signal)
  → router 读 config_store['signal-delivery']
  → 按 severity / target_role / owner_id 计算收件人与渠道集合
  → 频次与静默时段闸（超限 → status='skipped' 并留痕，不静默丢弃）
  → 逐渠道 send
  → 每次 send 落 crm.signal_delivery（sent / failed + last_error）
  → 失败重试（attempts ≤ config），最终失败进 monitor_event（不静默）
```

> **判据**：`skipped` 必须留痕（防"静默丢弃"）；`failed` 必须带 `last_error`。

---

## §11 授权面：常驻授权（线 B）

### 11.0 三轴模型：既有分级与新增授权的关系（**本节为 §2.4 核验后的架构定调**）

常驻授权在本设计中**不是单表新建**，而是**三条正交轴的合成**。其中 A 轴已在生产运行，B/C 轴为本次新增：

| 轴 | 载体 | 取值 | 回答的问题 | 现状 |
| --- | --- | --- | --- | --- |
| **A · 对象风险轴** | `crm.business_tier_config` | `LEAD` / `NORMAL` / `HIGH`（由 `customer × project` 推出） | **这个对象值不值得人管？** | ✅ **已落地运行**（§2.4） |
| **B · 动作边界轴** | `crm.standing_grant.risk_tier` | `T0` / `T1` / `T2` / `T3` | **这类动作能不能自动做？** | ❌ 本次新增（§8.5） |
| **C · 授权凭证轴** | `crm.standing_grant.status` | `active` / `paused` / `revoked` / `expired` | **这一次自动执行凭什么被允许？** | ❌ 本次新增（§8.5） |

**放行判定 = A 轴 × B 轴 的交集**（此前只用了 A 轴）：

```
自动执行  ⟺  对象 tier ∈ {LEAD, NORMAL}   ← A 轴（已有，autonomyEngine.js:274）
          ∧  置信度 conf ≥ effectiveThreshold   ← 已有
          ∧  动作 ∈ standing_grant.scope_actions   ← B 轴（新增：此前无动作白名单）
          ∧  写入字段 ⊆ standing_grant.field_whitelist ← B 轴（新增：此前无字段白名单）
          ∧  凭证 status = 'active' 且未超限 ← C 轴（新增）
```

> **关键缺口（此前被忽略）**：现状在 A 轴放行后，**写什么字段没有任何边界**——`tier ≠ HIGH` + 置信度达标即自主，未限定 Action 与字段。**这是本设计必须补上的真实风险敞口**，也是 §11.3 首批只开 `T1` 内部字段的原因。

### 11.1 核心立场

**不取消第 0 闸，而是给它增加一类合法凭证，并同时补全既有分级轴的授权语义。** `src/mcp/gateway.js:201` 的判据语义不变；常驻授权走 `deferDecisionMint` 这条**已有旁路**（`:741/801/994/1055/1108` 五处已在用），只把 actor 从 `mcp` 换成 `standing-auth`，并强制带 `grant_ref`。

**对 A 轴的 4 项补全（§2.4 的 D1–D4，与 B/C 轴同批实施）**：

| 补全项 | 修什么 | 落地方式 | 优先级 | 状态 |
| --- | --- | --- | --- | --- |
| **A1** 授权元数据列 | D1：表仅 4 列 | `db/2026-09-16-business-tier-grant-meta.sql` **6 列**（`approved_by`/`approved_at`/`decision_id`/`expires_at`/`revoked_at`/`revoked_reason`）+ `schema.sql` 同步 + 迁移清单登记 | P0 | **✅ 已实施已验证** |
| **A2** `decision_id` 落库 | D2：决策产生了但不存 | `upsertTier` 把 `produceDecision` 的返回**写入行内**（`decision_id`），同时落 `approved_by`/`approved_at` | P0 | **✅ 已实施已验证** |
| **A3** 分级配置纳入版本冻结 | **D3：审计断链（最严重）** | `policyVersion.js:29-34` 的 `POLICY_KEYS` 增加分级项；**按该文件 :27 既定语义，增键后所有后续决策解析出新版本——此为期望行为** | **P0** | **✅ 已实施已验证** |
| **A4** 撤回 / 到期语义 | D4：改值即撤回，无操作面 | 状态**派生**（不设 `status` 列）；撤回 = 状态变更，**零 DELETE**；**必须同时接执行面消费**（见下） | P1 | **✅ 已实施已验证** |

> **A3 已裁决（2026-09-16，用户批准）→ 采用方案 i（键镜像）**。

**A1/A2/A4 的三处设计裁决（2026-09-16，实施时定，均已说明理由）**：

| 裁决 | 选择 | 理由 |
| --- | --- | --- |
| 列数 5 → **6** | 增加 `revoked_reason` | §11.4 早已声明撤回需要 `revoked_at` + `revoked_reason`；只存时间不存原因，撤回在审计上等于"有人撤了什么"但"不知道为什么"——而这恰恰是事后复盘最需要的字段 |
| **不引入 `status` 列** | 状态由 `revoked_at`/`expires_at` **派生** | `status` 与 `revoked_at` 双写必然漂移，且漂移方向恰好是"显示生效但实际失效"的**不安全侧**。单一事实源 = 物理上不可能不一致 |
| `decision_id` **不加 FK** | TEXT，无外键 | 与 `config_store.decision_id`（`migrate-config.sql:13`）同构；保持 `migration-business-tier-tenant.sql:4` 声明的「纯配置叶表」定性不被破坏 |

> **⚠ A4 是本批唯一必须"同时改执行面"的项**：A1 只加列不消费，就等于复制 E1 的错（配置面有字段、执行面不读）。撤回若不接入 `computeBusinessTier`，就是"看起来具备了撤回能力、撤销后照旧生效"——**假绿里最危险的一种**（它消耗的是对人的安全承诺）。故 A4 的验收判据不是"字段写进去了"，而是"**撤回后该取值真的回退 `scenario.default_tier`**"。

**A3 实施方案 i 的具体设计（已批准，可实施）**：

| 项 | 内容 |
| --- | --- |
| 镜像键 | `config_store['business-tier-config']`，`value = { rules: [{dimension, dimension_value, tier}, ...], mirror_count }` |
| 同步点 | `businessTier.js` 的 `upsertTier` 成功后**紧随写镜像**（复用 `writeConfig(key, value, {tenantId, decisionId})`，`decisionId` 复用同一第 0 闸凭据 → **镜像变更本身也可溯源**）。⚠ 非严格 DB 事务（项目用连接池、无事务封装），改用 **fail-closed** 补偿：镜像失败即抛错让 PUT 失败，不留"配置改了但冻结没跟上"的半态 |
| 存量回填 | 迁移脚本把 `business_tier_config` 全量镜像一次（幂等）；**回填后读回校验**条数（不是"写完即绿"），不等则抛错 |
| 纳入冻结 | `policyVersion.js:29-34` 的 `POLICY_KEYS` 追加 `'business-tier-config'` |
| 一致性守护 | **必须配一条反向探针**：`verifyMirrorConsistency` 比对镜像 `rules.length` vs 表行数，不等 → `emit trace` + `recordFailure` + 返回 `ok:false`（镜像漂移 = 冻结的是**过期依据**，比不冻结更危险） |
| **❌ 禁止项** | **镜像 value 禁放任何易变字段**（时间戳/随机值）——见下方实证发现 ① |

> **为什么方案 i 是正确的取舍**：镜像让"分级配置"进入 `config_store` 这一**既有版本冻结通道**，不改 `loadSnapshot` 内核，且天生继承 per-tenant + autoSeed + 第 0 闸三套既有语义。

#### 11.1.2 实施结果与实证发现（2026-09-16，已实施并验证）

**实施状态：A3（方案 i）+ E1（方案 a）已落地**，改动 5 个文件、验证 3 类证据。

| 证据 | 结果 |
| --- | --- |
| `test/decision.test.js` | 16/16 ✅（含**新增 E1 负向哨兵**） |
| `test/calibration/`（autonomyEngine 下游） | 316/316 ✅ |
| `test/business-tier-tenant.integration.test.js` + `test/web/businessTier.test.js` | 12/12 ✅ |
| A3 端到端闭环（临时脚本，已删） | 4/4 ✅：幂等复用 / 改分级→新版本 / 改回→复用原版本 / 镜像一致性 16==16 |
| `db/migrate.js` 存量回填（测试库实跑） | 8 个租户全部回填，读回校验一致 ✅ |
| **自证鉴别力（负向对照）** | ① 移除 `!sceneAllowsAuto` → E1 哨兵变红（`expected 'autonomous' to be 'escalated'`）② 移除 `business-tier-config` 键 → A3 闭环 ② 变红（改分级不产生新版本）✅ |

**实证发现 ①（真 bug，实施期捕获）：内容寻址快照禁放易变字段**

初版镜像写了 `mirrored_at: new Date().toISOString()`。后果：`policyVersion` 用**内容哈希**寻址（`:55-58`），时间戳每次不同 → **每次镜像都解析成"新版本"** → 版本表爆炸，并直接破坏该文件 `:9` 声明的不变量 **I6「内容相同 → 复用既有版本 id」**。
**根因**：把"元数据"混进了"内容"。**修法**：镜像 value 只留语义内容（`rules` / `mirror_count`），写入时间由 `config_store.updated_at` 列承载。
> **可迁移判据**：凡进入**内容寻址/哈希去重**机制的数据，写入前逐字段审一遍「这个字段值相同吗」——时间戳、随机 id、写入者、自增序号一律不得入内。

**实证发现 ②（需知悉，非缺陷）：新增 `POLICY_KEYS` 键会产生一次性版本跃迁**

`policyVersion.js:27` 已明示「增键即改版本语义：加一个键会让所有后续决策解析出新版本——这是**期望行为**」。因此本次上线后，**分级相关的首次解析必然产生一个新版本**，此后进入稳态。
**对历史决策无影响**：旧决策已冻结在旧版本上，新版本只影响此后产生的决策。**取基线时必须先让镜像进入稳态**，否则会误判成"幂等失效"（本次验证脚本初版即踩此坑）。

#### 11.1.3 A1/A2/A4 实施结果与实证（2026-09-16，已实施并验证）

**改动 14 个文件**（2 新建 + 8 业务/前端 + 1 发布脚本 + 3 测试）：

| 文件 | 改动 |
| --- | --- |
| `db/2026-09-16-business-tier-grant-meta.sql`（新建） | 6 列幂等 `ADD COLUMN IF NOT EXISTS` + 存量 `approved_by='system-seed'` 回填 + 部分索引 |
| `db/schema.sql` | `business_tier_config` 建表语句同步 6 列（新库直接建全；旧库靠上面迁移，**两处列集必须一致**） |
| `db/migrate.js` | 迁移清单登记；**镜像回填形状同步**（见下"陷阱 ②"） |
| `src/portal/businessTier.js` | A2 落库（`decision_id`/`approved_by`/`approved_at`）+ 复活语义 + `revokeTier` + 撤回端点 + 读侧返回元数据 + 渲染单一实现（消除与 Render 子模块的双实现漂移） |
| `src/decision/decisionRepo.js` | **判定面消费**：`ACTIVE_TIER_WHERE` 常量 + `computeBusinessTier` 过滤 |
| `src/context/assembler.js` | **L4 上下文消费**：`retrieveL4` 同一谓词过滤（防"依据分裂"，见下"陷阱 ③"） |
| `src/http/controlledConfigPages.js` + `src/pages/S23.schema.js` | **配置面**：刻意不过滤，但带出 `tier_status`/`approved_by` 列 |
| `src/portal/businessTierRender.js` + `src/web/business-tier.html` | 状态徽章 / 批准人列 / 撤回按钮（含二次确认与可选原因）+ XSS 转义 |
| `scripts/tencent-lighthouse-deploy/deploy.sh` | **修复既存缺陷**：`else` 分支原先只打印"仅建表"却不执行迁移；现执行 `node db/migrate.js`（不注入 seed 业务数据）——否则本次新列在生产永不创建 → 决策链报 `column does not exist` |
| `test/web/businessTier.test.js` | +5：状态派生 / 撤回渲染 / XSS 转义 / `expires_at` 非法 400 / 撤回 404 |
| `test/business-tier-tenant.integration.test.js` | +6：A4 负向哨兵组（生效→撤回→溯源不被洗→幂等→复活→到期对照） |
| `test/tier-predicate-parity.test.js`（新建） | 3 项静态守卫：谓词两处同步 + 配置面不得过滤 + 渲染派生与 SQL 谓词语义一致 |

**验证证据（全部实跑）**：

| 证据 | 结果 |
| --- | --- |
| 迁移实跑（`crm_native_test`） | 列集 11 列到位，54 行存量回填 `approved_by='system-seed'` ✅ |
| `test/business-tier-tenant.integration.test.js` | 14/14 ✅（含 A4 六项：生效→撤回→溯源不被洗→重复撤回幂等→复活→到期对照） |
| `test/web/businessTier.test.js` | 13/13 ✅（含状态派生、XSS 转义、撤回 404、`expires_at` 非法 400） |
| `test/tier-predicate-parity.test.js`（新增守卫） | 3/3 ✅（谓词两处同步 / 配置面不得过滤 / 渲染派生与 SQL 谓词语义一致） |
| A4 镜像闭环（临时脚本，已删） | **5/5** ✅：幂等复用 / **撤回→新版本** / 镜像一致 / 复原→复用原版本 / `expires_at` 变化→新版本 |
| **自证鉴别力（负向对照 ×3）** | ① 移除 `computeBusinessTier` 的 revoked 过滤 → 集成 ②⑤ 变红（`expected 'HIGH' to be null`，即"撤回了却照旧生效"）② 让镜像忽略 `revoked` → 闭环 ② 变红（撤回不产生新版本）③ 移除 `assembler` 谓词 → 守卫测试变红（`assembler 的 L4 分级读取缺少同一谓词`）✅ |
| 回归（context + http + decision + web 四域，2844 项） | 22 项失败**全部既存**，无一与本次改动相关。归因：`.release-wt/` 副本（不含本次改动）同样失败；失败文件零引用本次改动的模块；`nav-path` 指向 `signal-center.html`（其他会话 WIP）、`auditability-sla-history` 为库残留数据（期望空窗口得 1 行）✅ |

**实施期捕获的两个真陷阱**：

**陷阱 ①（安全侧）：撤回不得覆盖批准溯源**
`revokeTier` 最初写成 `SET revoked_at=now(), decision_id=$new`。这会用"撤回的凭据"覆盖"批准的凭据"——**用次要溯源换掉主要溯源**。修法：撤回**不写** `decision_id`（保留"谁批准的"），撤回动作自身的凭据留在 `crm.decision`（`config-change` 场景，`trigger_context` 含 `dimension`/`dimension_value`/`reason`）。已加断言 `②b` 锁死该行为。

**陷阱 ③（覆盖不全）：分级配置有 3 个读取点，只改判定函数 = 部分假绿**

首轮只改了 `computeBusinessTier`（判定面），盘点后发现分级配置还有两个读取点，各自需要**不同处理**：

| 读取点 | 性质 | 处理 | 不处理的后果 |
| --- | --- | --- | --- |
| `decisionRepo.computeBusinessTier` | **判定面** | **过滤**撤回/到期 | 撤回只是写字段，判定照旧生效（最严重） |
| `context/assembler.js` `retrieveL4` | **判定依据供给**（注入 L4 上下文给模型） | **过滤**（同一谓词） | 模型看到"该项目=LEAD 低风险"而系统按"无此规则"回退 HIGH → **依据分裂**：模型凭作废依据给理由、系统按新依据拦截 |
| `http/controlledConfigPages.js`（S23 受控页） | **配置面展示** | **刻意不过滤**，但必须带出 `tier_status`/`approved_by` | 页面把已撤回规则照旧显示成分级 = 配置面与执行面不一致（E1 类假绿）。反过来若过滤掉，撤回行从配置面消失 → "撤回"变成不可核查的操作 |

> **可迁移判据**：给一张配置表加"生效/失效"语义时，**先枚举它的全部读取点**（`grep` 表名即可），再逐个决定"过滤 / 不过滤但标注"。
> 只改"我以为的那个判定点"是最常见的部分假绿——它比完全没做更危险，因为验收时会通过（判定点确实生效了）。
> 由于三处分属 `/decision`、`/context`、`/http` 三层且语言不同（SQL 片段 / JS 派生函数），**无法共享实现**，
> 故新增 `test/tier-predicate-parity.test.js` 静态守卫：谓词必须同时在 decisionRepo 与 assembler 中出现，
> 且受控页**不得**含该谓词（防止有人"顺手"加上导致审计证据从配置面消失）。

**陷阱 ②（幂等侧）：镜像形状必须在"运行时"与"迁移回填"两处逐字一致**
A4 把镜像规则形状从 `{dimension, dimension_value, tier}` 扩为 `+{revoked, expires_at}`。若只改运行时、不改 `db/migrate.js` 的回填，则**每次跑迁移都会把镜像改回旧形状 → 解析成"另一个版本" → 版本表爆炸**（与实证发现 ① 同族的又一起事故，且这次触发者是迁移而非时间戳）。两处必须同改，已互加注释互指。

**遗留限制（诚实标注，非缺陷）**：`expires_at` 到期是**时间语义**而非配置变更，故到期本身不产生新版本。这不是断链——镜像里存了 `expires_at` 的确定值，事后可用"决策时刻 + 该值"**精确复算**当时是否已过期。已在 `decisionRepo.js` 注释中写明。

### 11.1.1 附带缺陷修法（E1 / E2）

**E1 已裁决（2026-09-16，用户批准）→ 采用方案 a（接入执行面）。**

**方案 a 的精确语义（必须与 2026-08-28 裁定共存，不可写成"TRUE 即自主"）**：

```js
// src/decision/autonomyEngine.js:274 — 改后
escalated = forceExecution               // EXCEPTION 强制 HITL（不变）
  || tier === 'HIGH'                     // 高风险一律升级（不变）
  || sc.autonomous_allowed !== true      // ★新增：场景未声明允许自主 → 一律升级
  || (tier !== 'HIGH' && conf < effectiveThreshold);  // 置信度门控（不变）
```

| 语义要点 | 说明 |
| --- | --- |
| `autonomous_allowed` 是**必要条件，不是充分条件** | `TRUE` 仍需过置信度门控（**尊重 2026-08-28 裁定**，见下） |
| `FALSE` / 未设 → **一律升级** | fail-closed，符合"HITL 零信任"铁律 |
| 用 `!== true` 而非 `!x` | `undefined` 也归入升级（保守方向正确；用 `!x` 语义相同但可读性差） |

> **与 2026-08-28 裁定的兼容性论证（必读，否则会被误判为推翻裁定）**：
> `docs/specs/2026-08-25-ai-native-crm-overall-design.md:617` 的裁定原文禁的是——「`autonomous_allowed=TRUE` **无条件自主放行**（绕过置信度门控）」。
> 本方案**只增加 FALSE 侧的收紧，完全不放松 TRUE 侧**：`TRUE` 依然要过 `conf ≥ effectiveThreshold`。**裁定禁止的那条路径在新公式下仍被禁止。**
> 佐证：`autonomyEngine.js:251` 的 `highNoAuto = tier === 'HIGH' && !sc.autonomous_allowed` 是 dead variable——**原作者的意图本就包含该字段**，只是写了一半。方案 a 是**补完原作者意图**，而非推翻 2026-08-28 裁定。

**行为影响面（已核验，须在实施后回归）**：

| 场景 | `default_tier` | `autonomous_allowed` | 接入后行为变化 |
| --- | --- | --- | --- |
| `LEAD_FOLLOW_UP` / `POST_CONTRACT` / `LOSS_REVIEW` / `LEAD_FIT` / `PARTICLE_UPDATE` | LEAD / NORMAL | `TRUE` | **无变化** |
| `OPP_QUALIFY` / `SOLUTION_VALUE` | NORMAL | `FALSE` | ⚠️ **收紧**：由"可能自主"→"一律升级" |
| `QUOTE_PRICING` / `SIGN_RISK` / `ATTR_SCHEMA_CHANGE` / `CALIBRATION_CHANGE` | HIGH | `FALSE` | 无变化（本就一律升级） |

> 测试影响核验结论：`test/decision.test.js:147-159` 的自主用例走 `LEAD_FOLLOW_UP`（`TRUE`）→ 不破；`:168-174` 的 `OPP_QUALIFY` 用例走 `disposition:'EXCEPTION'`（`forceException` 先命中）→ 不破。**仍须实跑确认。**

| 缺陷 | 修法 | 不做会怎样 |
| --- | --- | --- |
| **E1** `autonomous_allowed` 假绿 | ✅ **已裁决 = 方案 a**（见上） | 管理员配了"⛔人工"却仍被自动放行，是**安全承诺失效** |
| **E2** `A/B/C` 术语碰撞 | ✅ **已实施**（2026-09-16，见下方"E2 实施明细"）——原修法只要求"改名+注释"，实测后发现**不只是命名问题**，按"缺陷直接修"升级为**投影纠错 + 守卫** | 读代码/看配置时把两个 C 当成一回事 → **真正接线时把"禁止处置"变成"允许自治"**（安全方向反转，且无任何正向用例会变红） |

#### E2 实施明细（2026-09-16，已实施并验证）

**核验结论：两套 A/B/C 不只是"同名不同义"，而是方向完全相反**，且 `adviceStore` 的跨轴投影存在**语义反转**：

| 值 | ① 对话建议档（`adviceCard.js`，轴 `ADVICE_MATURITY`） | ② 项目维**取值**（`business_tier_config.dimension='project'`） |
| --- | --- | --- |
| A | 证据齐备 → `APPROVE`（**可放手**） | → `HIGH`（**最高风险**，一律升级） |
| B | 红线命中 / HIGH 级场景 → `ESCALATE` | → `NORMAL` |
| C | 证据不足 → 只补信息（**禁止处置**） | → `LEAD`（**最低风险**，可自治） |

> 即「建议档 A」的风险方向 ≈「项目分级 C」。**两轴字母同名而语义相反**，任何按字面同值搬运的代码都会静默反转安全方向。
> 原实现 `business_tier: advice.tier === 'B' ? 'HIGH' : 'NORMAL'` 把**建议档 C（禁止处置）投影成 `NORMAL`（可自主放行）**——恰好把最不该自主的一档标成可自主。
> 该错误**不会报错、不会破任何正向用例**，只在真正接线时把"禁止处置"变成"允许自治"。

**四项改动**：

| # | 改动 | 位置 |
| --- | --- | --- |
| 1 | **轴显式声明**：新增 `ADVICE_TIER_AXIS='ADVICE_MATURITY'` + `ADVICE_TIERS`，并在文件头给出两轴反向对照表 | `adviceCard.js` |
| 2 | **投影纠错**：`advice.tier === 'A' ? 'NORMAL' : 'HIGH'`（**仅 A 档可自主**；B 待审批 / C 禁止处置一律升级） | `adviceStore.js:46` |
| 3 | **命名区分**：配置面 `分级` → **`自主分级`**、`取值` 列注明项目维 A/B/C、下拉选项标注 `LEAD（可自主）/HIGH（一律升级）`；「术语边界」声明进两个配置面文件 | `businessTierRender.js` · `business-tier.html` · `S23.schema.js` |
| 4 | **跨轴守卫测试**（7 项） | 新建 `test/advice-tier-axis.test.js` |

**守卫测试的四层判据**（`test/advice-tier-axis.test.js`）：
① **两轴枚举不相交**（机械证明"按字面映射"必错）② **建议档 C → `disposition=null`**（禁止处置，非"可放手"）③ **投影保守单调**——仅 A 可投影 `NORMAL`，**B/C 一律 `HIGH``（关键负向哨兵）** ④ **源码级禁字面映射**（正则只匹配代码行，注释中的历史记录不误伤）。

**验证证据**：

| 证据 | 结果 |
| --- | --- |
| `test/advice-tier-axis.test.js` + 相关 6 域 | **101/101 全绿**（守卫 7 项） |
| **自证鉴别力** | 把投影改回旧写法 → ③④ **同时变红**，报错 `expected 'NORMAL' to be 'HIGH'`（语义）与源码断言（形态）✅ 归因准确；已恢复 |
| 一次批量运行的 1 项红（`decision_event` FK 违反） | **已实证为并发共享库伪失败，非本次引入**：① 本轮改动文件与 decision 链路**零 import 引用** ② 两次重跑失败的**用例不同**（`createDecision` / `reverseDecision`）→ 非确定性 ③ 随后连续 2 次 **16/16 全绿** ④ 库上存在 1 个并发连接（`crm.mcp_identity` 查询）。**判据范式同 §11.1.3 的 54 分钟超时伪失败** |

**零运行时影响声明**：`adviceStore.js` 当前**无生产调用者**（唯一引用者是 `test/decision/advice-store.test.js`），故投影纠错不改变任何线上行为——它的价值在于**接线前把方向摆正**。

#### E3 建议链路断链（**新识别 → 已裁决 → 已实施**，2026-09-16）

核验 E2 时连带查出：**「建议」这条链路从未接线**。

| 项 | 证据 |
| --- | --- |
| `buildAdviceAnchor()` 是**孤儿导出** | 全仓唯一引用者 = `test/decision/advice-store.test.js`；`src/` 内零调用 |
| `ADVISED` 是**死状态** | 全仓仅出现在 `adviceStore.js` 自身 → `crm.decision` 中**永远不会**有 `state='ADVISED'` 的行 |
| 但 `advise()` **有 6 处生产调用** | `executor.js:57` · `seed-actions.js:2216` · `routes.js:2393` · `gateway.js:213/238/343` —— 返回值**一律只做即时回显** |

**后果**：**"AI 曾经建议过什么"从未落库** → 无法度量建议的准确率与采纳率；也无法回答"这次决策是采纳了 AI 建议，还是人自己想出来的"。这正是第 9 大能力（反馈闭环）缺的那一条回路，也是 T20（观测校准）的前置数据源。

##### ⚠ 裁决过程修正：方案 (i) 的成本被严重低估

初轮三方案（(i) 落 `crm.decision`+`ADVISED` / (ii) 删除链路 / (iii) 维持现状标注）中，(i) 被推荐，且当时陈述的硬前置只有一条：「先例检索须排除 `ADVISED`」。

**实施前做消费面盘点（同 A4 教训：先 grep 表名枚举全部读取点），该前提被推翻**——`crm.decision` 有 **15 个读取点**，其中 **8 个是聚合/统计面**，写入非决策行会污染它们：

| # | 污染点 | 后果 |
| - | --- | --- |
| 1 | `decision/dailyOps.js:37` | 日报 `total` 虚增、`escalated` 误计（`decider_type='AGENT_ADVICE' ≠ 'AUTONOMOUS_AGENT'`）、`avg_confidence` 被拉低 |
| 2 | `decision/retro.js:101` | 每日复盘把建议当决策做复盘 |
| 3 | `calibration/sampleLoader.js:14` | 校准样本被污染 → P1/P2 指标失真 |
| 4 | `calibration/autoSuggest.js:78` | 调参建议基于被污染样本 |
| 5 | `calibration/paramInspector.js:91` | 巡检样本同上 |
| 6 | `decision/auditability.js:168` | 可审计性 Q1–Q4 抽检把建议纳入评分（C3 指标失真） |
| 7 | `context/assembler.js:108`（`retrieveL2`） | **建议被当成"过去决策"注入上下文** |
| 8 | `http/controlledConfigPages.js:311`（`state <> 'APPROVED'`） | 计数虚增 |

另有两条**更硬**的否决证据（非"污染"，而是"根本写不进去 / 记不住"）：

- **`decided_at` 无 NULL 免疫**：`createDecision` 的 INSERT 硬写 `decided_at = now()`（`decisionRepo.js:270`）→ 时间窗聚合**不会**因 NULL 自动排除 `ADVISED` 行；
- **证据不足时被拦下**：`createDecision` 内 `sevenDimensionsCheck` + `decideInterception` 在 required_dims 缺失时**直接抛错**（`decisionRepo.js:200-203`）——而建议**恰恰产生于证据不足时**。即：最该记录的场景，反而落不了库。

##### 最终裁决：方案 (iv) 独立运行态表 `crm.advice_record`（已实施）

**做法**：新增 `crm.advice_record`（与同日落地的 proactive `signal` / `external_ref` **同属运行态表族**，不新增粒子类型），`adviseService.advise()` 作为**唯一收敛点**在返回前落库。

**为什么这是正确取舍**：

| 维度 | 说明 |
| --- | --- |
| 零污染 | 既有 15 个决策读取点**一行不改**；未来新增查询也不会踩坑 |
| 零内核改动 | 不碰 `createDecision` / `sevenDimensionsCheck` / `searchPrecedents` |
| **硬前置结构性消解** | 「先例检索须排除 `ADVISED`」不再靠人工清单——`crm.decision` 里**永不出现** `ADVISED`，并由 `test/decision/advice-precedent-guard.test.js` **机械化锁死**（白名单断言 + 运行态零行断言 + 源码黑白名单形态断言） |
| 可写性 | 绕开 interception 拦截，证据不足的建议也能落库（这正是最有观测价值的一档） |
| 配对可行 | `linked_decision_id` 后置回填即可算采纳率——**同表并不省这一步**，故此维度两方案等价 |

**落地物**：

| 文件 | 内容 |
| --- | --- |
| `db/migration-advice-record.sql`（新）+ `db/schema.sql` 尾部 | 18 列 + 3 索引；**含轴约束** `ck_advice_record_tier_axis CHECK (advice_tier IN ('A','B','C'))` —— 把业务分级值写进建议档会被**数据库直接拒绝** |
| `src/decision/adviceRecord.js`（新） | `buildAdviceRecord`（纯）/ `recordAdvice`（fail-open）/ `linkAdviceToDecision` / `listAdvice`（租户隔离） |
| `src/decision/adviseService.js` | 单一收敛点接线（6 处调用一改全覆盖），`recordAdvice` 失败只 trace 不阻断 |
| `src/decision/adviceStore.js` | **退役** `ADVISED_STATE` / `buildAdviceAnchor`（地雷：其目的就是往 `crm.decision` 写 `ADVISED`），仅保留摘要口径单一事实源 `buildStructuredSummary` |

> **E2 的连带收益**：E2 的修法是给跨轴投影加"保守映射"（治伤）；E3 改用独立表后，建议记录里**根本没有业务分级字段**（`business_tier`），跨轴投影面**整体消失**（除根）。故 `test/advice-tier-axis.test.js` 的 ③④ 节由「投影保守单调」升级为**结构性断言**：不是把映射改对，而是让映射无处可写。

**验证**（详见 §18.2 ⑦）：`26/26` 全绿 + **自证鉴别力 ×3**（把 `ADVISED` 混入白名单 → 守卫红；移除轴约束 → DDL/拦截断言红；塞回 `business_tier` → 3 条结构断言红，含"建议档被改写成 `NORMAL`"）。


### 11.2 闭环三要素

| 要素              | 机制                                                                                                         |
| --------------- | ---------------------------------------------------------------------------------------------------------- |
| **授权凭证自己带决策依据** | 凭证经既有审批流（`CRM_APPROVAL_FLOW`）批准 → `standing_grant.decision_id` 非空。**溯源铁律不破**：任何自动执行的源头都可追到一次人工批准           |
| **执行仍 mint 决策** | 执行时 handler 内 mint，`decision` 记 `actor='standing-auth'` + `grant_ref` + `autonomy_level` → 可回答"这个动作为什么被允许" |
| **执行留前后快照**     | `grant_execution.before_state/after_state` → 可对照、可判断是否需要回填                                                 |

### 11.3 分级与首批边界（用户已定 T1）

| 档      | 内容                           | 首批                     |
| ------ | ---------------------------- | ---------------------- |
| **T0** | 只读 / 研究 / 建议产出               | ✅ 无需授权（现状）             |
| **T1** | **内部字段写**：AI 属性、评分、标签、研究结论回填 | ✅ **首批开放**             |
| T2     | 客户可见内部动作：跟进记录、任务、提醒          | ❌ 本轮不开                 |
| T3     | 对外动作：发信、阶段推进至 S7/S8          | ❌ **永久不可常驻授权**（必须前置审批） |

> **T1 判定标准**：「**客户不可见、不对外、可对照回填**」。凡写入内容会被客户看到的，一律不低于 T2。

### 11.4 熔断 / 降级 / 撤回（全部为状态变更，零 DELETE）

| 机制         | 规则                                                                                                                   |
| ---------- | -------------------------------------------------------------------------------------------------------------------- |
| 用量熔断       | `used_count` 达 `max_uses`（或 `period` 内上限）→ `status='paused'` + 通知                                                    |
| **信任降级**   | `grant_execution.hitl_verdict='rejected'` **连续 N 次**（默认 3，读 `standing-grants-policy`）→ 自动 `paused` + 通知 + `trace` 留痕 |
| **不可自动提升** | `allow_tier_upgrade_by_ai:false` 写死；档位提升必须新批一次授权（新 `grant_id`）                                                       |
| 到期         | `expires_at` 到期 → 调度扫为 `expired`（状态变更）                                                                               |
| 撤回         | `revoked_at` + `revoked_reason`；已执行动作进审计链，**不删除**                                                                    |

### 11.5 与人机反馈闭环的衔接（**同时接上 J2 缺口**）

`grant_execution.hitl_verdict` 的三态（`adopted` / `rejected` / `pending`）→ 经既有 `crm_decision_outcome_write`（`seed-actions.js:1791`）回写决策结果。

**这一步同时补上了此前判定的 P0 缺口**：`decision.outcome` 长期无输入、闭环三条腿缺一条。**常驻授权的执行流水天然就是 J2 的数据源**——无需另造入口。

---


## §12 铁律映射（统一）

| 铁律                         | 本设计的遵守点                                                                                         | 违反即失败判据                       |
| -------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------- |
| **不新增粒子类型 / 不改业务域模型（§10）** | 7 张新表全为运行态表（非粒子域）；`external_ref.particle_type` 仅取既有值；信号 `kind` 复用既有 13 类                        | 出现新粒子类型常量                     |
| **绝对禁 DELETE**             | 外部记录消失 → `external_deleted_at` 软标记；关闭信号 / 撤销授权 / 否决执行**全为状态字段变更**                               | 同步或信号路径出现任何 `DELETE FROM`     |
| **写操作过决策第 0 闸**            | 批量入库：一次 run mint 一个决策（`sync_cursor.decision_id`）；回写：逐批审批；常驻授权：`deferDecisionMint` + `grant_ref` | 产生无 `decision_id` 的粒子写入       |
| **租户隔离**                   | 7 张表均带 `tenant_id`；配置 per-tenant；凭据按租户解密；投递路由按 `tenant_id + owner_id`                           | 跨租户读到他人映射 / 凭据 / 游标 / 信号      |
| **配置 100% 后台化**            | 映射 / 频率 / 方向 / 信任级别 / 回写白名单 / 节律 / 渠道路由全部走 `config_store`                                       | 代码内出现对象名 / 字段名 / 频率字面量        |
| **HITL 零信任**               | 首次接入、映射变更、信任级别提升、启用回写 → 人工确认；L3 前 3 批逐次人工确认                                                     | 自动提升信任级别 / 自动启用回写 / 自动放宽 tier |
| **建表单一事实源**                | 7 张表 DDL 追加 `db/schema.sql`                                                                     | DDL 散落在别处                     |
| **凭据不出口**                  | 沿用 `credentialVault` pgcrypto at-rest；token 缓存值亦加密落库                                            | 凭据进日志 / 前端 / memory           |
| **不静默失败**                  | 投递失败写 `last_error` + `monitor_event`；巡检失败 `recordFailure`；降级 / 暂停发通知；`skipped` 亦留痕              | 任何一路失败无留痕                     |
| **装配闭包三处同改**               | 新 Action 走 `agentTool:false`（范式 `connectorActions.js:132`），**免 agentSpec 三处同改**                 | `assertAgentAssembly` 断言失败    |
| **决策依据须可追溯（C3 冻结）** | **分级配置（A 轴）纳入 `POLICY_KEYS`**（`policyVersion.js:29-34`）；授权元数据落 `decision_id`（§11.1 A1/A2/A3） | 改配置后历史决策判定依据不可复现；分级变更无决策凭证 |
| **配置面与执行面一致（反假绿）** | `autonomous_allowed` 要么接入放行判定、要么从配置面移除；**不得"配了不生效"**（§11.1.1 E1） | 配置显示"⛔人工"仍被自动放行 |

---

## §13 生命契约（21 任务，覆盖全部 7 个名册 agent）

> **字段语义**：见 `brainstorming` SKILL §A。`contract_task_id` **必填**，值须等于 `src/agent/contractIds.js` 的 `CONTRACT_IDS[agent]`。  
> **校验命令（P7 强制）**：
>
> ```bash
> node scripts/validate-contract.mjs docs/2026-09-15-final-design-coexistence-and-proactive.md --registry src/agent/agentSpec.js
> ```
>
> **任务编号对照**：`A-Tn` → `T0n`（线 A，n=1..9）；`A-T10` → `T10`；`B-Tn` → `T1n`（线 B，n=1..9）；`B-T10` → `T20`。


### 线 A｜共生同步线

#### T01 同步内核 + 字段映射层

```contract-yaml
- task: "T01 新建 src/sync 同步内核 + config_store['sync-mappings'] 声明式映射层"
  contract_task_id: ct-intake-route
  agent: intake-router
  skills: [method-intake-routing]
  memory: [intake-router]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "给定 mock CrmProvider 与映射配置，engine.runOnce 返回 {read,created,updated,skipped}；同批重复执行 created=0 且无重复行；未知字段被拒绝并计入 skipped"
```

**契约说明：** 本任务由 `intake-router`（接诊 = 数据进入与路由的同源职责）承接，调用 `method-intake-routing`、读 `intake-router` 记忆（L1，≤2 跳）；成功标准为内核在 mock provider 下完成增量同步且幂等、未知字段被拒。

#### T02 纷享销客适配器

```contract-yaml
- task: "T02 实现 fxiaoke CrmProvider 适配器（discoverObjects/readIncremental/verifyAuth）并注册 kind"
  contract_task_id: ct-intake-route
  agent: intake-router
  skills: [data-particle-read]
  memory: [intake-router]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "verifyAuth 用 mock 凭据换取 CorpAccessToken 并缓存（二次调用不打网络）；discoverObjects 解析 /cgi/crm/object/list 返回预置+自定义对象清单"
```

**契约说明：** 本任务由 `intake-router` 承接，调用 `data-particle-read`、读 `intake-router` 记忆（L1）；成功标准为鉴权换取+缓存与对象元数据发现均通过 mock 验证。

#### T03 外部引用映射与实体对齐

```contract-yaml
- task: "T03 建 crm.external_ref 与 crm.sync_cursor 表并实现 entityResolver 幂等 upsert"
  contract_task_id: ct-intake-route
  agent: intake-router
  skills: [data-particle-read]
  memory: [intake-router]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "同一 external_id 二次同步命中既有 particle_id 且不新建粒子；external_deleted_at 软标记后原粒子仍存在（零 DELETE 核验）"
```

**契约说明：** 本任务由 `intake-router` 承接，调用 `data-particle-read`、读 `intake-router` 记忆（L1）；成功标准为幂等对齐与软删除语义，且全程零 DELETE。

#### T04 单向回写通道

```contract-yaml
- task: "T04 新增 sync-writeback-fields Action（write-back-out，带 Source 静态标记 + 字段级 CAS）"
  contract_task_id: ct-decision
  agent: decision-agent
  skills: [method-decision-execute]
  memory: [decision-agent]
  knowledge_scope: { layers: [L1, L2], max_hops: 3 }
  success: "回写仅作用于白名单字段；外部记录已被他人修改时 CAS 拒绝并回传最新值（不静默覆盖）；写入携带 Source='crm-ai-native'"
```

**契约说明：** 本任务由 `decision-agent`（决策执行同源职责）承接，调用 `method-decision-execute`、读 `decision-agent` 记忆（L1–L2）；成功标准为白名单约束 + CAS 拒绝 + 静态标记三项同时成立。

#### T05 同步信任分级

```contract-yaml
- task: "T05 落地 config_store['sync-trust'] 三档信任分级与决策 mint 粒度"
  contract_task_id: ct-intake-route
  agent: intake-router
  skills: [method-intake-routing]
  memory: [intake-router]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "L1 下 upsert 被拒且无任何写入；L2 下整批仅产生 1 个 decision_id；L3 提升需人工确认（无自动提升路径）"
```

**契约说明：** 本任务由 `intake-router` 承接，调用 `method-intake-routing`、读 `intake-router` 记忆（L1）；成功标准为三档行为可验证且信任级别不可自动提升。

#### T06 事件订阅接入

```contract-yaml
- task: "T06 connectorRouter 增对象变化事件路由 + 定时增量分支接入 followup 重评"
  contract_task_id: ct-followup
  agent: followup-agent
  skills: [method-followup-engine]
  memory: [followup-agent]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "对象变化事件 5 分钟内触发该账户重评，重评结果 appendMemory 且 payload.discovery 其它子键不被覆盖"
```

**契约说明：** 本任务由 `followup-agent`（跟进节奏同源职责）承接，调用 `method-followup-engine`、读 `followup-agent` 记忆（L1）；成功标准为事件触发重评的及时性与 payload 子键完整性。

#### T07 同步可观测

```contract-yaml
- task: "T07 同步指标落 monitor 并可上墙（lag/success_rate/conflict/writeback）"
  contract_task_id: ct-retro-decision
  agent: decision-retro
  skills: [decision-retrospective]
  memory: [decision-retro]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "sync_cursor 每轮更新 last_counts 与 last_status；失败轮次 emit trace 且 recordFailure 非静默；指标接口按 tenant_id 隔离返回"
```

**契约说明：** 本任务由 `decision-retro`（校准与复盘同源职责）承接，调用 `decision-retrospective`、读 `decision-retro` 记忆（L1）；成功标准为运行态留痕完整、失败不静默、租户隔离。

#### T08 产品与价格表同步（报价基线来源）

```contract-yaml
- task: "T08 扩展同步对象至产品与价格表（落既有 CRM_PRODUCT / CRM_PRICE_LIST）作为报价基线"
  contract_task_id: ct-quote-calc
  agent: quote-engine
  skills: [method-quote-engine]
  memory: [quote-engine]
  knowledge_scope: { layers: [L1], max_hops: 3 }
  success: "同步后报价引擎能命中客户侧真实产品与价格；基线缺失时明确报缺而非按默认价计算（降级纪律）"
```

**契约说明：** 本任务由 `quote-engine`（报价基线的同源职责）承接，调用 `method-quote-engine`、读 `quote-engine` 记忆（L1–L2）；成功标准为命中真实基线且缺基线时明确报缺。

#### T09 同步记录与拓客候选去重

```contract-yaml
- task: "T09 同步记录入库前与拓客候选/公海线索去重核对"
  contract_task_id: ct-prospecting
  agent: prospecting
  skills: [prospecting-select]
  memory: [intake-router]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "已存在于客户 CRM 的企业不再作为新拓客候选产出；命中既有账户时候选被标注 skip 并给出已有 account_id"
```

**契约说明：** 本任务由 `prospecting`（拓客候选的同源职责）承接，调用 `prospecting-select`、读 `intake-router` 记忆（L1）；成功标准为不与外部 CRM 已有账户重复产出候选。

#### T10 接入与映射变更评审闸门（HITL 落点）

```contract-yaml
- task: "T10 首次接入 / 映射变更 / 信任级别提升 / 启用回写 四类动作接入 review-gate 人工审批闸门"
  contract_task_id: ct-review-gate
  agent: review-gate
  skills: [method-review-gate]
  memory: [review-gate]
  knowledge_scope: { layers: [L1], max_hops: 3 }
  success: "四类动作未获人工放行时一律被拒（fail-closed）；放行记录留 decision_id 与审批人；无自动放行路径"
```

**契约说明：** 本任务由 `review-gate`（闸门与放行的同源职责）承接，调用 `method-review-gate`、读 `review-gate` 记忆（L1）；成功标准为四类动作 fail-closed 且无自动放行路径。


### 线 B｜主动运行时线

#### T11 信号统一收口

```contract-yaml
- task: "T11 新建 crm.signal 表与 signalStore，alertStore 由内存 Map 迁移为 DB 幂等 upsert"
  agent: intake-router
  contract_task_id: ct-intake-route
  skills: [method-intake-routing]
  memory: [intake-router]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "createAlert 落 crm.signal 且进程重启后仍可查；同 (tenant_id,dedup_key) 二次写入走 ON CONFLICT 更新而非新建（行数不增）；DDL 存在于 db/schema.sql 单一事实源；表内无任何 DELETE 路径"
```

**契约说明：** 本任务由 `intake-router`（数据进入与承载的同源职责）承接，调用 `method-intake-routing`、读 `intake-router` 记忆（L1，≤2 跳）；成功标准为持久化 + 幂等 + 单一事实源 + 零 DELETE 四项同时成立。

#### T12 感知三源触发器

```contract-yaml
- task: "T12 感知层扩为三源触发器（timer/event/external），eventTrigger 向后兼容扩矩阵"
  agent: intake-router
  contract_task_id: ct-intake-route
  skills: [method-intake-routing, method-dialog-router]
  memory: [intake-router, followup-agent]
  knowledge_scope: { layers: [L1, L2], max_hops: 3 }
  success: "三类 source 各有一条规则可被触发；旧矩阵 3 行语义不变且不报错；变更型新增域（particle/approval/decision）触发后落 crm.signal 且 dedup 生效；非只读 SKILL 派发仍被拒并留 trace"
```

**契约说明：** 本任务由 `intake-router` 承接，调用 `method-intake-routing` 与 `method-dialog-router`、读 `intake-router`/`followup-agent` 记忆（L1–L2，≤3 跳）；成功标准为三源可用、旧行为不回归、只读闸不放松。

#### T13 投递抽象层与四渠道 provider

```contract-yaml
- task: "T13 新建 src/signal/delivery provider 契约与 inbox/email/im/webhook 四实现，落 signal_delivery 流水"
  agent: followup-agent
  contract_task_id: ct-followup
  skills: [method-followup-engine]
  memory: [followup-agent]
  knowledge_scope: { layers: [L1, L2], max_hops: 2 }
  success: "四 provider 各实现 verifyConfig/send；send 失败落 signal_delivery 行 status=failed 且 last_error 非空；未配置凭据的渠道 verifyConfig 拒绝启用（fail-closed）；超频次或静默时段落 status=skipped 且留痕"
```

**契约说明：** 本任务由 `followup-agent`（触达与节奏的同源职责）承接，调用 `method-followup-engine`、读 `followup-agent` 记忆（L1–L2）；成功标准为四渠道可插拔 + 失败不静默 + 配置自检 fail-closed。

#### T14 信号进入工作台与首页信号卡

```contract-yaml
- task: "T14 工作台增加信号视角 + 首页信号卡 + 每日作战简报（消费 signal-digest 配置）"
  agent: followup-agent
  contract_task_id: ct-followup
  skills: [method-followup-engine, method-funnel-classification]
  memory: [followup-agent, quote-engine]
  knowledge_scope: { layers: [L1, L2], max_hops: 2 }
  success: "buildViewRows('signals') 返回本租户本角色可见信号；首页信号卡数量与同视角条数一致（不出现两套口径）；简报条目数受 max_items 与 rate_limit 约束；空态返回空数组而非抛错"
```

**契约说明：** 本任务由 `followup-agent` 承接，调用 `method-followup-engine` 与 `method-funnel-classification`、读 `followup-agent`/`quote-engine` 记忆；成功标准为视角可用、口径唯一、限额生效、空态安全。

#### T15 报价与阶段推进的时间型信号

```contract-yaml
- task: "T15 报价待审批超时/阶段静默/价格基线漂移三类时间型信号接入节律表"
  agent: quote-engine
  contract_task_id: ct-quote-calc
  skills: [method-quote-engine, method-stage-progression]
  memory: [quote-engine, followup-agent]
  knowledge_scope: { layers: [L1, L2], max_hops: 3 }
  success: "三类信号的阈值全部读 config_store（无字面量）；阈值调整后同批数据命中集合随之改变（可证配置生效）；命中落 crm.signal 且 severity/target_role 按配置分档"
```

**契约说明：** 本任务由 `quote-engine` 承接，调用 `method-quote-engine` 与 `method-stage-progression`、读 `quote-engine`/`followup-agent` 记忆（L1–L2，≤3 跳）；成功标准为阈值配置化可证、命中分档正确。

#### T16 主动拓客信号

```contract-yaml
- task: "T16 公海 S0 停滞/候选池触达窗口/线索回收前预警三类拓客信号"
  agent: prospecting
  contract_task_id: ct-prospecting
  skills: [prospecting-search, method-outreach-hook]
  memory: [intake-router]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "S0 超期未认领、S0P 回收前 T-3 天、候选池触达窗口三类各产出一条信号；与既有 lead-pool-recycle 扫描不重复产同 dedup_key；拓客信号只提醒不改动归属（写入为零）"
```

**契约说明：** 本任务由 `prospecting` 承接，调用 `prospecting-search` 与 `method-outreach-hook`、读 `intake-router` 记忆（L1）；成功标准为三类信号各产一条、去重不重复、**写入为零**。

#### T17 L3 智能体主动研究：产出建议卡

```contract-yaml
- task: "T17 主动研究调度：按节律选对象→跑只读 SKILL→产出带推理链与证据的建议卡"
  agent: decision-agent
  contract_task_id: ct-decision
  skills: [method-decision-enrich, discovery-research]
  memory: [decision-agent]
  knowledge_scope: { layers: [L1, L2], max_hops: 5 }
  success: "每轮研究对象数不超过 max_objects_per_run；LLM 调用不超过 daily_llm_budget（超预算降级不抛错）；建议卡的 reasoning 与 evidence_refs 均非空（缺证据时输出降级说明而非编造）；本任务不产生任何粒子写入"
```

**契约说明：** 本任务由 `decision-agent`（决策研究的同源职责）承接，调用 `method-decision-enrich` 与 `discovery-research`、读 `decision-agent` 记忆（L1–L2，≤5 跳）；成功标准为限额生效、证据非空（缺则降级说明）、**零粒子写入**。

#### T18 建议卡采纳回路与 J2 回写

```contract-yaml
- task: "T18 建议卡一键采纳（人 mint 决策调既有 Action）与否决回写决策结果"
  agent: decision-agent
  contract_task_id: ct-decision
  skills: [method-decision-execute, data-particle-create, data-particle-read]
  memory: [decision-agent, review-gate]
  knowledge_scope: { layers: [L1, L2], max_hops: 5 }
  success: "采纳路径必携带 decision_id（无则被第 0 闸拒）；采纳后 signal.status='acted' 且 action_ref 落库；否决后 hits crm_decision_outcome_write 且 decision.outcome 行数增加（可观测）"
```

**契约说明：** 本任务由 `decision-agent` 承接，调用 `method-decision-execute`/`data-particle-create`/`data-particle-read`、读 `decision-agent`/`review-gate` 记忆；成功标准为采纳必带决策、否决必回写可观测。

#### T19 常驻授权凭证与 T1 自动执行

```contract-yaml
- task: "T19 crm.standing_grant/crm.grant_execution 落地：审批流批准→T1 字段白名单内自动执行→前后快照留痕"
  agent: review-gate
  contract_task_id: ct-review-gate
  skills: [method-review-gate, data-particle-read]
  memory: [review-gate, quote-engine]
  knowledge_scope: { layers: [L1, L2], max_hops: 4 }
  success: "凭证必须经审批流批准（decision_id 非空）方可 active；白名单外字段写入被拒且留痕；超出 max_uses/period 自动 paused；tier 无任何自动提升路径（T2/T3 动作在无凭证时被拒）"
```

**契约说明：** 本任务由 `review-gate` 承接，调用 `method-review-gate`/`data-particle-read`、读 `review-gate`/`quote-engine` 记忆（L1–L2，≤4 跳）；成功标准为凭证必批、白名单拦截、熔断生效、tier 不可自动提升。

#### T20 链路观测与信任校准

```contract-yaml
- task: "T20 信号链路观测上墙（投递成功率/延迟/冲突/执行量）与连续否决自动降级"
  agent: decision-retro
  contract_task_id: ct-retro-decision
  skills: [decision-retrospective, data-particle-read]
  memory: [decision-retro, review-gate]
  knowledge_scope: { layers: [L1, L2], max_hops: 5 }
  success: "指标按 tenant_id 隔离返回；存在负向判据（无投递行但渠道为 on → 报警；hits>0 而新增 signal=0 → 报警）；连续 rejected 达阈值自动 paused 并 emit 告警；降级事件可在追溯链中查到"
```

**契约说明：** 本任务由 `decision-retro` 承接，调用 `decision-retrospective`/`data-particle-read`、读 `decision-retro`/`review-gate` 记忆；成功标准为租户隔离 + **含负向判据** + 自动降级可追溯。

#### T21 分级授权对象化（A 轴补全：D1–D4 + E1/E2）

> **实施优先级：本任务应先于 T19 执行。** T19 是新增 B/C 轴（动作边界 + 授权凭证）；本任务是**把已在运行的 A 轴（对象风险分级）先变成可审计、可撤回的授权对象**。先修既有轴的审计断链，再叠加新轴——否则新凭证的溯源会挂在一条本就断链的依据上。

> **实施状态（2026-09-16）：契约判据全部实跑通过**（证据见 §11.1.2 / §11.1.3 / §11.1.1 的 E2 实施明细）。实施期捕获 2 个真陷阱（撤回覆盖批准溯源、镜像形状双处不一致），均已修复并加断言锁死；另修 E2 跨轴语义反转并加守卫测试。

```contract-yaml
- task: "T21 分级授权对象化：business_tier_config 补授权元数据列（approved_by/approved_at/decision_id/expires_at/revoked_at/revoked_reason）、写入时落 decision_id、分级配置纳入 POLICY_KEYS 内容冻结、补撤回/到期语义并接入执行面消费、修 autonomous_allowed 配置面与执行面不一致、修 advice 建议档与项目分级两套 A/B/C 的跨轴投影反转（E2）"
  agent: review-gate
  contract_task_id: ct-review-gate
  skills: [method-review-gate, data-particle-read]
  memory: [review-gate, decision-retro]
  knowledge_scope: { layers: [L1, L2], max_hops: 4 }
  success: "① 表结构与 schema.sql 一致（6 个新列幂等可重跑）；② 任一次 PUT /api/business-tier-config 后，该行 decision_id 非空且可在 crm.decision 反查到（溯源不断链）；③ 改一次分级配置后 resolvePolicyVersion 解析出新的 policy_version_id，且改回旧值时能复用原版本（幂等不破）；④ 一条撤回后该分级不再参与 computeBusinessTier 判定（该取值回退 scenario.default_tier），且历史决策的 effective_policy_version 不变（历史依据不被洗掉）；⑤ autonomous_allowed=false 的场景在 tier!=HIGH 且 conf 达标时不再自主放行（配置面承诺与执行面一致，假绿消除）；⑥ 跨轴投影不反转：建议档 C（证据不足、禁止处置）经 buildAdviceAnchor 投影后不得落入可自主分级（必为 HIGH），且 test/advice-tier-axis.test.js 守卫通过（防两套同名反向的 A/B/C 再被按字面搬运）"
```

**契约说明：** 本任务由 `review-gate` 承接（授权面的配置闸门职责），调用 `method-review-gate`/`data-particle-read`、读 `review-gate`/`decision-retro` 记忆（L1–L2，≤4 跳）；成功标准为**元数据落库 + 溯源可反查 + 版本冻结生效（含幂等回滚）+ 撤回语义接入执行面 + 配置面与执行面一致**。
**五项验收判据中 ③④⑤ 为负向/边界判据**（改回旧值 / 撤回 / 关闭开关），**缺一即视为假绿**——正向写通不代表冻结、撤回与闸门真的生效。
> **④ 的措辞在本轮被刻意收紧**：从"pause 后不再产生 AUTONOMOUS 决策"改为"撤回后**不再参与 `computeBusinessTier` 判定**"。理由：前者可以用"改配置值"糊弄过去（看起来满足了），而后者唯一地指向"过滤真的接在判定函数里"——**A1 只加列不消费就是复制 E1 的错**。

---

## §14 客户价值排序（合并去重）与实施顺序

### 14.1 客户价值排序（客户能感知到什么）

| 排名     | 客户获得的价值                          | 支撑项                               | 线   | 感知    | 交付段    |
| ------ | -------------------------------- | --------------------------------- | --- | ----- | ------ |
| **1**  | **每天打开就知道今天该干什么**——不用自己找         | T14 待办信号视角 + 首页信号卡 + 每日作战简报       | B   | ★★★★★ | **S1** |
| **2**  | **AI 的结论出现在客户自己的 CRM 里**         | T04 回写 + A-B4 字段级 CAS             | A   | ★★★★★ | S4     |
| **3**  | **不用去查，它主动告诉我**——时间/变更/外部三类触发    | T12 三源 + T15 T16                  | B   | ★★★★★ | S5     |
| **4**  | **不再重复录入 / 两套数据不打架**             | A-N2 映射 + A-N3 对齐 + A-B1          | A   | ★★★★★ | S2     |
| **5**  | **AI 的判断基于真实客户数据，而不是猜**          | A-N1 内核 + A-B6 增量 + A-B7 重评       | A   | ★★★★  | S3     |
| **6**  | **提醒里已经带好理由和证据**，不是一句"该跟进了"      | T15/T16 上下文 + T17 建议卡（推理链 + 证据）   | B   | ★★★★  | S5     |
| **7**  | **一键采纳，改动自动落库**并回写客户 CRM         | T18 采纳回路 + T04 回写                 | B→A | ★★★★  | S5     |
| **8**  | **低风险的事 AI 自己做完**，我不用点           | T19 常驻授权 T1                       | B   | ★★★   | S6     |
| **9**  | **可以随时断开的零风险试用**                 | A-N5 信任分级（L1 只读起步）                | A   | ★★★   | S2     |
| **10** | **我知道 AI 干了什么、能撤、能让它停；同步可审计可复现** | T20 观测 + T07 同步指标 + A-N2 映射可 diff | A+B | ★★★   | S7     |

### 14.2 ⚠ 客户价值排序 ≠ 实施顺序（必须点破）

> **价值排序回答"先让客户感觉到什么"；实施顺序回答"技术上必须先做什么"。两者不重合。**
>
> **排名 2、7、8、10 的强感知价值全部在依赖链末端。** 倒序实施会造出：
>
> - **无对象的采纳按钮**（先做 T18 而不做 T17 建议卡）；
> - **写到错误记录上的回写**（先做 T04 回写而不做 T03 实体对齐）；
> - **无观测的自动写**（先做 T19 而不做 T13 投递 + T20 观测）；
> - **没人看得见的"主动"**（先做 T12 感知而不做 T11/T13/T14 出口）；
> - **挂在断链依据上的授权**（先做 T19 而不做 T21：新授权凭证的溯源会落在**本就无版本冻结、无授权元数据**的分级表上——`policyVersion.js:29-34` 的 `POLICY_KEYS` 不含分级项，届时"这条自动执行为什么被允许"仍答不出来）。**这是 §2.4 核验后新增的一条倒序风险。**

> **📌 2026-09-16 修正（用户已批准，见 `2026-09-16-full-chain-integration-design.md` §0.4）：顺序纪律的载体由「排期」升级为「运行时闸门」。**
>
> 上述五条倒序风险的共同本质是「**危险动作在观测能力就绪之前被放行**」。原表述用**排期**（先 S1、后 S4/S6）实现该约束；经用户批准，**改用运行时闸门 `src/sync/exportGate.js`（fail-closed）实现同一约束**：
>
> - 危险动作（回写 / 自治）**代码可与出口同批交付**，但**默认关闭**；
> - 放行条件为**显式判据**：出口判据①成立（`crm.signal_delivery` 窗口内存在真实 `sent` 行，且渠道集合来自 `config_store['signal-delivery']`，非硬编码默认值）；
> - 判据不成立 → 回写 Action 返回 `blocked_by_export_gate` 并 emit trace；闸门自身查询抛错时**按 blocked 处理**（fail-closed）。
>
> **等价性论证（收紧而非放宽）**：本节要防的是「无投递观测就放开自动写」。排期只是达成它的手段之一，且**在交付完成后即失效**——交付完成后不再有人检查「S1 是否真的通了」；运行时闸门在生产环境**持续生效**。故该修正**不是放宽，是收紧**。
>
> **⚠ 表述红线**：闸门未投产前，**不得**对外表述「顺序纪律已由运行时保障」（继承 §0.5 与附录 D.2）。
>
> **落点**：`docs/2026-09-16-full-chain-integration-design.md` §3.4（机制本体）、§1.4（交付与闸门的关系）、Q3-3 / Q3-4（生命契约）。

### 14.3 统一实施分段

| 段      | 主题                   | 任务                                                                                    | 依赖 | 交付后可验证的客户价值                             |
| ------ | -------------------- | ------------------------------------------------------------------------------------- | -- | --------------------------------------- |
| **S1** | **出口：让人看得见**         | **T11** 信号收口 · **T13** 投递四渠道 · **T14** 视角/首页卡/简报（含 B-B1/B-B2 挂载修复）                    | 无  | 排名 **1** 立即成立——**当天可见**（这是全案 ROI 最高的一步） |
| **S2** | **入口：数据进来**（L1 只读起步） | **T01** 内核+映射 · **T02** 纷享适配器 · **T03** external_ref/对齐 · **T05** 信任分级 · **T10** 接入闸门 | S1 | 排名 **9**（零风险试用）+ 为排名 4 铺路               |
| **S3** | **判断有据**（L2 批量入库）    | **T06** 事件订阅+重评 · **T07** 同步可观测 · **T08** 报价基线 · **T09** 拓客去重                         | S2 | 排名 **4、5**（不再重复录入；判断有据、评分不再恒 0）         |
| **S4** | **结论回去**（L3 回写）      | **T04** 回写 Action + A-B4 字段级 CAS                                                      | S3 | 排名 **2**（客户感知最强的一项）                     |
| **S5** | **不用去查**             | **T12** 三源触发器 · **T15** 报价/阶段节律 · **T16** 拓客信号 · **T17** 主动研究 · **T18** 采纳回路          | S4 | 排名 **3、6、7**                            |
| **S6** | **让它自己动手**（自治）       | **T21** 分级授权对象化（A 轴补全，**先做**；**A1–A4 + E1 全部已落地已验证**）· **T19** 常驻授权 T1（B/C 轴） | S5 | 排名 **8** |
| **S7** | **可校准**              | **T20** 链路观测 + 信任校准                                                                   | S6 | 排名 **10**                               |

> **建议合并交付**：S2+S3 可合并为一个批次（此时客户已能感知排名 4、5、9），**S4 紧随其后**交付排名 2 的强感知价值。

---

## §15 红线（明确不做，合并去重 11 条）

### 15.1 共性红线

| # | 不做项                                 | 理由                                                                                             |
| - | ----------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1 | **任何"取代客户 CRM"的技术路线或对外叙事**          | 客户既有 CRM 是十年沉淀 + 内部流程依赖；一旦对外写"最终取代"即自拆"共生"叙事（Rox 明牌 *"in that future, Rox is the CRM"* = 反面教材） |
| 2 | **schema-less 自由生长**（Lightfield 路线） | §10 硬约束 + 多租户 + 审计 + 禁 DELETE 不允许字段随同步自动生长；映射必须是**声明式白名单**                                     |
| 3 | **任意脚本 / 表达式映射**（映射中执行代码 / SQL）     | 注入风险 + 不可审计                                                                                    |
| 4 | **在客户 CRM 中创建我方自有对象 / 表**           | 越界修改客户系统的数据模型，属不可逆侵入；只读写**客户已声明的对象与字段**                                                        |
| 5 | **借道第三方 iPaaS**                     | 数据链路进黑盒，与"可验证可审计"定位冲突；引入供应商与数据出境合规风险                                                           |

### 15.2 线 A 专属红线

| # | 不做项                                                  | 理由                                                                  |
| - | ---------------------------------------------------- | ------------------------------------------------------------------- |
| 6 | **完整双向同步**（变更来源消歧 + pending write 对账 + Fivetran 级管道） | 投入大且"只读 + 单向回写"已覆盖约 80% 价值；复杂度集中在冲突治理，而我方客户多数**根本不会双写**（他们只有一套 CRM） |

### 15.3 线 B 专属红线

| # | 不做项                   | 理由                                                                                                                   |
| - | --------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 7 | **不学「投递即骚扰」**         | Rox 自己做了 `Notifications controls`（按数据源调频率），说明过量投递是真问题。我方必须有 `rate_limit` + `quiet_hours` + `include_low`，默认**低频高信噪** |
| 8 | **不学「always-on 全自动」** | 常驻授权首批只开 **T1 内部字段**，`allow_tier_upgrade_by_ai:false` 写死；**T3 对外动作永久不可常驻授权**                                         |
| 9 | **不学「发送即送达」**         | 必须有 `signal_delivery` 流水与 `last_error`；`skipped` 也要留痕。**没有投递证据的投递，等于没投递**                                            |

### 15.4 两条"元红线"（最忌讳）

> **① 不学「外部公开信号当主料」**：我方 K 层真实弱点是**内部数据不足**——实测 `crm.events` 虽有 529 行但**语义域单一**（`ontology-sync` 528 / `channel-probe` 1，**无业务事件**），`supplied_dims` 均值仅 **2.68/7** 且 Q1 达标率 **8.3%**（见 §18.2）。先把内部 + 客户 CRM 信号做透。
>
> **② 不学「把主动能力当营销词」**：**对外只能讲已通电的链路。S1 未交付前，不得对外宣称"AI 主动值守"。** 这正是本项目最忌讳的假绿（与 L1–L4 同源）。

### 15.5 回捞补录的共性红线（2026-09-16）

> **来历**：以下两条为**09-15 合并时未转录**的既有决策（`深部署` / `in-VPC` / `Tether` 在本文**均 0 命中**），属**合并丢失而非新决策**。经 2026-09-16 合并保真度审计（`docs/2026-09-16-design-merge-audit.md` §4 D2）确认后**原样回捞**，结论与 09-15 一致。

| #  | 不做项                                | 理由                                                                                                    |
| -- | ---------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 10 | **warehouse-native 单租户 in-VPC 深部署** | 与多租户 SaaS 战略**直接冲突**，会摧毁交付成本结构——我方价值在"配置驱动多租户 + 一套代码 N 个租户"，深部署等于每客户一份运维                        |
| 11 | **用 Tether 类自研协议替代 MCP**           | 我方已押注开放标准 MCP，且 MCP 是**对外连接器的战略入口**（插件分发包 4 份 byte-equal 同步）——推翻协议等于自毁生态位                         |

---

## §16 验收标准（合并 20 条，含负向判据）

### 16.1 线 A｜共生同步（10 条）

| #   | 判据                                                          | 类型     |
| --- | ----------------------------------------------------------- | ------ |
| A1  | 能从纷享销客拉取客户/联系人/商机三类对象并落为既有粒子（断言 `external_ref` 行数与客户侧记录数一致） | 正向     |
| A2  | 同批同步重复执行幂等（第二次 `created=0`）                                 | 正向     |
| A3  | 外部记录删除不导致我方粒子删除（`external_deleted_at` 非空且粒子 `id` 仍在）        | 正向     |
| A4  | 所有同步写带 `decision_id`（L1 阶段应无任何写入）                           | **负向** |
| A5  | 回写仅作用于白名单字段且带 `Source='crm-ai-native'`（越权字段被拒）              | **负向** |
| A6  | 并发修改被 CAS 拦住（回写被拒并回传最新值，不静默覆盖）                              | **负向** |
| A7  | 同步后决策评分不再恒 0（对比九尺子评分与 `supplied_dims` 覆盖率）                  | 正向     |
| A8  | 全程零新增粒子类型、零新增 `DELETE FROM`                                 | **负向** |
| A9  | 配置零硬编码（grep 不到客户侧对象名/字段名/同步频率字面量）                           | **负向** |
| A10 | 契约有效性（`validate-contract.mjs` 退出码 0）                        | 正向     |

> **A7 的负向基线（2026-09-15 实测，见 §18.2 ②）**：`supplied_dims` 当前均值 **2.68/7**、众数 **2/7（60%）**、Q1 门槛（≥5/7）达标率仅 **8.3%**（12/145 行）。**S2 交付后该达标率必须显著抬升**——若仍停留在 10% 量级，即说明"数据进得来"这一环未真正生效（防假绿判据）。

### 16.2 线 B｜主动运行时（10 条）

| #   | 判据                                                         | 类型     |
| --- | ---------------------------------------------------------- | ------ |
| B1  | 巡检命中后 `crm.signal` 有对应行，**且进程重启后仍可查**                      | 正向     |
| B2  | 同 `(tenant, dedup_key)` 重复命中**不产生新行**（幂等）                  | 正向     |
| B3  | `GET /api/alerts`（挂载后）返回本租户信号，**跨租户不可见**                   | 正向     |
| B4  | 渠道配置为 `on` 时，每次投递在 `signal_delivery` 有 `sent` 或 `failed` 行 | **负向** |
| B5  | 渠道 `on` 但 `signal_delivery` 无对应行 → 判定假绿，**验收不通过**          | **负向** |
| B6  | `trace 'sales-daily-scan' hits>0` 而当日新增 `signal` = 0 → 报警  | **负向** |
| B7  | 阈值改配置后同批数据命中集合随之改变（证明非硬编码）                                 | 正向     |
| B8  | 建议卡 `reasoning` 与 `evidence_refs` 均非空；缺证据时输出降级说明           | 正向     |
| B9  | 白名单外字段的自动写入被拒并留痕；超限额自动 `paused`                            | **负向** |
| B10 | 全链路 grep `DELETE FROM` 新增数 = **0**                         | **负向** |

---


## §17 闭环回写

> 本文档为**生命契约载体**。运行期由 agent workbench（`/agents`、`agent-workbench.html`）解析 §13 的 `contract-yaml`，逐任务核对：① 承接 agent 是否调用了声明的 `skills`？② 是否读取了声明的 `memory`/knowledge？③ `success` 是否通过？

**机读回写文件**：`docs/2026-09-15-final-design-coexistence-and-proactive.feedback.json`，按 `task+gap_type` 幂等 upsert。

```json
{ "task": "T13 投递抽象层与四渠道 provider", "agent": "followup-agent", "gap_type": "skill", "observed": "...", "expected": "...", "ts": "...", "severity": "warn" }
```

**人读回写表**

| task | 承接 agent       | 观测点                                            | 缺口类型            |
| ---- | -------------- | ---------------------------------------------- | --------------- |
| T01  | intake-router  | `engine.runOnce` 四计数 / 幂等                      | success         |
| T02  | intake-router  | 鉴权换取命中率 / 对象发现条数                               | skill           |
| T03  | intake-router  | `external_ref` 对齐率 / 软标记正确性                    | success         |
| T04  | decision-agent | 白名单拦截数 / CAS 拒绝数 / Source 标记存在率                | **success（负向）** |
| T05  | intake-router  | 三档行为差异 / mint 粒度                               | memory          |
| T06  | followup-agent | 事件→重评延迟 / payload 子键完整性                        | success         |
| T07  | decision-retro | 指标上报完整性 / 失败留痕率                                | success         |
| T08  | quote-engine   | 报价命中客户真实价格 / 缺基线报缺率                            | success         |
| T09  | prospecting    | 与外部 CRM 重复候选数（应为 0）                            | success         |
| T10  | review-gate    | 四类动作 fail-closed 命中数                           | **skill**       |
| T11  | intake-router  | `crm.signal` 行数 / 幂等命中率                        | success         |
| T12  | intake-router  | 三源触发计数 / 只读闸拒绝留痕                               | skill           |
| T13  | followup-agent | 投递成功率 / failed 明细                              | success         |
| T14  | followup-agent | 视角条数 vs 首页卡数一致性                                | success         |
| T15  | quote-engine   | 阈值变更后的命中集合差异                                   | memory          |
| T16  | prospecting    | 拓客信号产出数 / 与 lead-pool-recycle 去重率 / **写入应为 0** | success         |
| T17  | decision-agent | 研究轮次 / LLM 预算消耗 / 证据非空率 / **粒子写入应为 0**         | success         |
| T18  | decision-agent | 采纳率 / `decision.outcome` 增量                    | success         |
| T19  | review-gate    | 白名单拦截数 / 熔断触发数                                 | skill           |
| T20  | decision-retro | 负向判据报警数 / 降级次数                                 | success         |

**吸收与建议（P0）**：下次会话读 `*.feedback.json`；同一 `(task, gap_type)` 复发 ≥2 次 → 产出 SKILL 改进提案（如：为相应 agent 的 `capabilities.actions`/`skillCalls` 补 `sync-*` / `signal-*` 条目、强化 SKILL 调用指令、补记忆读取约定）。**提案需显式批准后方可修改 SKILL 或 agentSpec，绝不自动应用。**

> ⚠ **装配闭包提醒**：若后续决定让 `sync-*` / `signal-*` Action 对 agent 可见，须**三处同改**（`agentSpec.capabilities.actions` + `agentSpec.capabilities.skillCalls` + `src/action/seed-actions.js` 登记），否则 `assertAgentAssembly` 的 `permission_closure` / `action_in_registry` 断言会整册校验失败。本设计**刻意选择 `agentTool: false`**（范式 `connectorActions.js:132`）以规避此项跨模块耦合。

---

## §18 移交与前置动作

### 18.1 移交

**本设计经用户批准（P8）后，唯一入口为 `writing-plans`。** §14.3 的 S1–S7 转可执行任务清单；**每任务继承 §13 同名契约**（不新增、不弱化 `agent`/`skills`/`memory`/`knowledge_scope`/`success`/`contract_task_id`）。

#### 18.1.1 发布顺序强制项（2026-09-16 本次改动引入，**不可跳过**）

本次改动让 `computeBusinessTier`（决策热路径）与 `assembler.retrieveL4` 引用 `business_tier_config` 的两个新列（`revoked_at` / `expires_at`）。因此发布顺序是**硬约束**：

| 顺序 | 动作 | 违反后果 |
| - | - | - |
| 1 | **先跑迁移**：`node db/migrate.js`（或发布时带 `--seed`） | 旧库缺列 → 每次决策报 `column "revoked_at" does not exist` → **决策链整体停摆**（不是样式问题、也不是可降级的服务） |
| 2 | 再重建/重启 app、mcp 容器 | — |

**已在 `deploy.sh` 修复配套缺陷（既存）**：原 `else` 分支（不带 `--seed`）**只打印"仅建表"却不执行任何迁移** —— 注释与实现不一致。后果是"不带 seed 发布"这条最常用路径**从来不创建新列/新表**；此前多数改动只表现为"新功能不可用"（如新页面因缺表报错），本次则升级为**决策链停摆**。现该分支执行 `node db/migrate.js`（无 `--seed` 时只跑 schema + config + 增量迁移 + 分级出厂种子与 A3 镜像回填，**不注入 `seed.sql` 业务数据**，与文件内红线注释一致）。

**发布后自检三条（缺一不可）**：

```bash
# ① A1：授权元数据列已创建（期望 6）
docker compose --env-file scripts/tencent-lighthouse-deploy/.env exec -T db \
  psql -U agent2b -d crm_native -c "SET search_path TO crm,public;
    SELECT count(*) FROM information_schema.columns
     WHERE table_schema='crm' AND table_name='business_tier_config'
       AND column_name IN ('approved_by','approved_at','decision_id','expires_at','revoked_at','revoked_reason');"

# ② A3：镜像条数 == 表行数（不等 = 冻结的是过期依据，比不冻结更危险）
#    完整 SQL 见 §18.3 探针 ⑤ 第 ③ 段

# ③ 端到端：跑一次真实商机推进，确认决策未因缺列而报错（决策链活性）
```

### 18.2 前置动作核验结果（2026-09-15 已执行，**本节数据已实测，不再是待办**）

三项前置动作已全部执行。**取证边界（必须声明）**：生产主机 `81.70.184.198` 在本沙箱不可达（`https://www.chiyuai.com` 连接失败；`5432` 被拦，且 `docker-compose.yml:14-17` 明确"仅绑定回环地址，禁止公网直接访问"）。因此：

- **配置层证据 = 生产口径**（`.env` + compose + 代码，三者是生产实际生效路径）
- **运行态证据 = 本地库 `crm_native`**（PG 16.14，同一套 `db/schema.sql` 与迁移）
- **生产库运行态未取得**——如需，用 compose 注释给出的通道：`ssh -L 5432:127.0.0.1:5432`，再跑 §18.3 的探针

#### ① `EMBEDDING_PROVIDER` —— **原表述有误，须修正**

| 层 | 证据 | 结论 |
| - | ---- | ---- |
| 生产 env | `scripts/tencent-lighthouse-deploy/.env:14` = `EMBEDDING_PROVIDER=model`；`deploy.sh:146/149` 以 `--env-file "$SCRIPT_DIR/.env"` 启动 → 该文件即生产生效值 | ✅ 生产 = model |
| 生产 compose | `docker-compose.yml:44/97` = `${EMBEDDING_PROVIDER:-model}`（默认即 model） | ✅ 双重兜底 |
| 代码兜底 | `src/http/server.js:41-47`：`NODE_ENV!=='test'` 且未显式设置时，读 `llm_config` → 有 `apiKey` 则**自动置 `model`** | ✅ 三重兜底 |
| **运行态（本地库）** | `particles` 1008 行中 **447 行 embedding 非空（44.3%）**；近 7 天有向量写入 62 行；末次向量写入 `2026-09-11T03:08`；`llm_config` 1 行且 `api_key` 非空 | ✅ **向量列不是空的** |

> **⚠ 修正上一版表述**：此前"默认部署态下向量列为空、'语义检索'的说法要改"——**该判断错误**。真实情况是：**真向量路径已启用且确实在写**，但**覆盖率只有 44%，存在结构性空洞**。

**真实缺口是覆盖率而非可用性**（本地实测，按类型）：

| 粒子类型 | 总数 | 有向量 | 说明 |
| --- | ---: | ---: | --- |
| `CRM_DICT_ENTRY` | 252 | **0** | 字典项全无向量（最大空洞） |
| `CRM_OFFER_POLICY` | 81 | **0** | 报价政策全无向量 |
| `CRM_PRODUCT` | 119 | 16 | 13% |
| `CRM_PRICE_LIST` | 46 | 6 | 13% |
| `CRM_KNOWLEDGE` | 69 | 69 | 100% |
| `CRM_APPROVAL_FLOW` | 32 | 32 | 100% |
| `CRM_ACCOUNT` / `CRM_CONTACT` / `CRM_DEAL` | 18/15/21 | 13/12/10 | 72%/80%/48% |

**对外表述修正建议**：把"写库即构建的真向量语义检索"改为"**已启用真向量并在持续写入（实测 44% 覆盖率），字典项与报价政策类待回填**"——或先执行 `scripts/backfill-knowledge-embeddings.mjs` / `backfill-decision-embeddings.mjs` 补齐后再对外。

**附带发现（代码注释漂移）**：`src/ontology/embedding.js:10` 注释仍写"向量维度须与 schema 对齐（`vector(384)`）"，但 `db/migration-2026-09-14-particles-embedding-1024.sql` 已把列改为 `vector(1024)`，`hooks.js:19-37` 也按 1024 校验。注释未同步，**建议随 S1 一并更正**（不改行为）。

#### ② `supplied_dims` 覆盖率 —— **实测：峰值 5/7，均值 2.68，众数 2/7**

**来源**：本地库 `crm.decision_context_snapshot`，145 行 / 131 个决策，时间跨 `2026-08-31` → `2026-09-14`（近 7 天 52 行，仍在产生）。

| 指标 | 实测值 | 对照原文档口径 |
| --- | --- | --- |
| 峰值 | **5/7** | 原引"峰值 4/7" → **已过期，实际更高** |
| 均值 | **2.68 / 7** | 原文档无此数 |
| 最小值 | 1/7 | — |
| **众数** | **2/7（87/145 行 = 60%）** | 原文档无此数 —— **这才是真实基线** |

分布（`supplied_dims` → 行数）：`1/7`×4 ｜ `2/7`×87 ｜ `3/7`×17 ｜ `4/7`×25 ｜ `5/7`×12

**🔴 关键新增结论（原文档未捕捉）**：`src/decision/auditability.js:14` 定义 Q1 门槛 `Q1_MIN_SUPPLIED_DIMS = 5`（设计口径 5/7）。按实测分布，**达标仅 12/145 行 = 8.3%**。即：**"决策可审计性 Q1"这一项在当前数据上 91.7% 不达标**。

→ 影响：§14.1 客户价值排序中"判断基于真实数据（★★★☆）"这一项的**现状基线比预期更低**；S2（数据进得来）的收益因此**比原估更高**。建议把"`supplied_dims` 达标率（≥5/7）"直接纳入 §16 验收判据作为**负向基线**（当前 8.3%，S3 完成后应显著抬升）。

#### ③ `crm.alert` 表 —— **确认不存在，且是双重实证**（不需改为"未纳入单一事实源"）

| 证据 | 结果 |
| --- | --- |
| 本地库 `information_schema.tables` where `table_name LIKE '%alert%'` | **仅 `crm.alert_rule`**（规则表），**无 `crm.alert` 实例表** |
| 全 `db/**/*.sql`（含子目录，58 个 SQL 文件）匹配 `CREATE TABLE ... (alert\|alerts)(` | **零命中** |
| 对照：`alert_rule` 建表语句 | 1 处，出处 `db/migrate-config.sql:95` ✅ 说明扫描方法有效（非漏扫） |

> **结论**：`crm.alert` **在运行库与全部 DDL 中双双不存在**。原 §0.2 / G9 的表述**不需要弱化为"表未纳入单一事实源"**，反而应**加强为"双重零命中"**（上一版担心的"生产手工建表未同步"情形，不改变结论）。

**附带修正（原文档数字有误）**：原文档多处称 `db/schema.sql` 为"56 表"。
- `grep -c "CREATE TABLE IF NOT EXISTS" db/schema.sql` = **56 条建表语句**（此数正确）
- 但**运行库 `crm` schema 实为 65 张表** → **差额约 17 张表由 `db/migrate-*.sql` / `db/migration-*.sql` 等 50+ 个迁移文件创建**（如 `config_store` / `alert_rule` / `connectors` / `approval_flow` 出自 `db/migrate-config.sql`；`tenants` 出自 `db/2026-09-03-crm-tenants.sql`；`agent_sla` / `propagation_action` / `decision_rubric_score` 等在 `db/**/*.sql` 中**零命中**，属运行时动态建表）
- **反向差集**：`schema.sql` 声明的 `crm.oauth_client` / `oauth_code` / `oauth_refresh` 三表在运行库**不存在**

> **⚠ 由此得出一条与本设计直接相关的结论**：**`db/schema.sql` 不是唯一事实源**——声明 56 条、实存 65 张，且 3 条声明未落地。这**直接支持 §8 的 DDL 决策**（本次新增表**追加进 `db/schema.sql`** 是对的，但同时应登记进迁移清单，否则会重演"表存在但不在单一事实源"的老问题）。建议 S1 一并补一张 `db/` 表清单与 schema.sql 的对账脚本。

#### ④ 额外核验（顺带修正两处长期口径）

| 项 | 原口径 | 实测（本地库） | 影响 |
| --- | --- | --- | --- |
| `crm.events` 行数 | 设计文档记"**0 行**"（K 层致命弱点） | **529 行**，但 `type` 分布为 `ontology-sync`×528 + `channel-probe`×1；跨度 `2026-09-02` → `2026-09-11`，近 7 天 76 行 | 表述应改为"**事件表有数据但语义域单一**（仅本体同步事件，无业务事件）"——**这反而强化 §6/§7"感知面从 1 域扩到 3 域"的必要性**，且说明扩展有现成写入路径 |
| J2 闭环回填率 | "`decision.outcome` 实测 0/12" | `crm.decision` **261** 行，`crm.decision_outcome` **4** 行（**1.5%**），且 **4 行 `source` 全为 `seed-script`**——**无一行来自真实用户反馈或自动回填** | 坐实 J2 断链，且比"0/12"更精确：不是"样本少"，而是"**种子数据之外零回填**"。§5.2 / T19 的立论成立 |
| 九尺子是否真跑 | — | `crm.decision_rubric_score` **1044 行 / 覆盖 116 决策**（≈9 分/决策） | ✅ 确定性评分确实在执行（非死代码），支撑"8 确定性可重跑"的对外表述 |
| 决策场景实际分布 | — | `PARTICLE_CREATE`42 ｜ `LEAD_FOLLOW_UP`40 ｜ `QUOTE_PRICING`33 ｜ `OPP_QUALIFY`29 ｜ `SOLUTION_VALUE`26 ｜ `LOSS_REVIEW`23 ｜ `CLIENT_STRATEGY`22 ｜ `PARTICLE_UPDATE`20 ｜ `CALIBRATION_CHANGE`13 ｜ `PROSPECTING_CONFIRM`5 ｜ `SIGN_RISK`4 ｜ `POST_CONTRACT`3 | 实际场景面**多于** `scenarioAdvisors.js` 的 7 个（含 `PARTICLE_CREATE`/`PARTICLE_UPDATE`/`CALIBRATION_CHANGE` 等通用写场景）——供 §6/§7 判断面设计参考 |

#### ⑤ 分级授权机制核验（2026-09-15 追加，**本项推翻上一版「必须引入常驻授权」的措辞**）

用户指出"平台已有按客户 × 项目两因素决定 A/B/C 项目分级、C 类自动执行"。**源码级核验后判定：用户说法成立**，具体结论见 §2.4。核验要点：

| 待核验主张 | 核验结果 | 源码锚点 |
| --- | --- | --- |
| 存在"客户 × 项目"二维分级 | ✅ **成立** | `db/schema.sql:248-254`（表）+ `decisionRepo.js:61-70`（两维 `Math.max` 取高风险优先） |
| 维度取值为 `STRATEGIC/KEY/NORMAL` × `A/B/C` | ✅ **成立** | `db/migrate.js:388` 注释 + `:393-398` 出厂种子；`src/web/pipeline.html:67-68` 前端下拉 |
| "C 类项目直接自动执行" | ⚠️ **需加三条件限定** | `migrate.js:398` `'C' → 'LEAD'`；但 `autonomyEngine.js:274` 仍需 `conf ≥ effectiveThreshold`，且**两维取高风险优先**——战略客户 + C 类 → 整体仍 `HIGH` → 一律升级。**准确表述：`C 类项目 ∧ 客户维非 STRATEGIC/KEY ∧ 置信度达标 → 自主`** |
| 分级驱动自主边界 | ✅ **成立**（且已运行） | `autonomyEngine.js:145` 取 tier → `:274` 参与 `escalated` 判定 |
| 写分级有第 0 闸凭据 | ✅ 有产出，❌ **未落库** | `businessTier.js:102-110` 产出 `decision_id` → `:143` 仅回显前端 |
| 分级变更有版本冻结 | ❌ **不成立（审计断链）** | `policyVersion.js:29-34` `POLICY_KEYS` 9 键**不含分级项** |
| 分级可撤回 | ❌ **不成立** | `businessTier.js:92-98` 仅 `ON CONFLICT DO UPDATE SET tier=$4`，无 `paused/revoked` 语义 |
| `autonomous_allowed` 生效 | ❌ **不成立（假绿）** | 配置面 `decisionScenario.js:126`／执行面 `autonomyEngine.js:274` 未引用；`:251` `highNoAuto` 为 dead variable |

**上表为 2026-09-15 的核验快照。其中 4 项"不成立"已于 2026-09-16 全部修复并验证**：
`未落库` → ✅ A2（`upsertTier` 落 `decision_id`/`approved_by`/`approved_at`）｜`审计断链` → ✅ A3（`POLICY_KEYS` 第 10 键 `business-tier-config` + 镜像冻结）｜`不可撤回` → ✅ A4（`revoked_at`/`expires_at` 派生状态 + 撤回端点，零 DELETE）｜`autonomous_allowed 假绿` → ✅ E1 方案 a（`!sceneAllowsAuto` 接入 `escalated`）。
证据：§11.1.2 / §11.1.3 / §11.1.1（E2 明细）；契约 ⑥ 项判据见 §13 T21。

**本项产出的修正**：§2.4 新增；§11.0 三轴模型新增；§11.1 增加 A1–A4 补全项；§13 新增 **T21**；§12 增加 2 条铁律映射。

#### ⑥ 建议链路核验（2026-09-16 追加，配合 E2 顺带查出）

核验 E2（两套 A/B/C）时连带核实"建议是否落库"，结论见 §11.1.1 的 **E3**：

| 待核验主张 | 核验结果 | 源码锚点 |
| --- | --- | --- |
| 建议结果会落库为 decision | ❌ **不成立（链路未接线）** | `buildAdviceAnchor()` 全仓唯一引用 = `test/decision/advice-store.test.js`；`src/` 零调用 |
| `ADVISED` 是真实存在的决策状态 | ❌ **不成立（死状态）** | 全仓仅 `adviceStore.js:3/:8/:34`；`crm.decision` 中永无 `state='ADVISED'` 行 |
| 建议会被消费 | ⚠️ **仅即时回显，不落库** | `advise()` 8 处生产调用（`executor.js:57`、`seed-actions.js:2216`、`routes.js:2393`、`gateway.js:213/238/343`）→ 一律 `a.advice` 透传响应 |

**判定方法有效性说明**（防假红）：本次用"唯一引用者即测试文件"作为否定断言依据，已先用**已知存在样本**（`advise()` 的 8 处调用）对照同一套 grep 口径——同一口径能找出 8 处，故"零命中"可信。

**本项产出的修正**：§11.1.1 新增 **E3**（含三条待裁决路径）；§2.4 缺陷表新增 E3 行。**本项不擅自实施**——方案 (i) 会触及先例检索的判定语义（决策内核），按 HARD-GATE 须先获批准。



#### 18.3 生产复核探针（供你在生产机执行）

生产不可达，以下命令在生产机（或用 `ssh -L 5432:127.0.0.1:5432` 隧道后）执行即可闭环验证，**全部只读**：

```bash
# ① 向量真实覆盖率（生产口径）
docker compose --env-file scripts/tencent-lighthouse-deploy/.env exec -T db \
  psql -U agent2b -d crm_native -c "
    SET search_path TO crm,public;
    SELECT count(*) total, count(embedding) with_vec,
           round(100.0*count(embedding)/nullif(count(*),0),1) pct
    FROM particles;"

# ② supplied_dims 分布
docker compose --env-file scripts/tencent-lighthouse-deploy/.env exec -T db \
  psql -U agent2b -d crm_native -c "
    SET search_path TO crm,public;
    SELECT supplied_dims, count(*) FROM decision_context_snapshot GROUP BY 1 ORDER BY 1;"

# ③ crm.alert 是否存在
docker compose --env-file scripts/tencent-lighthouse-deploy/.env exec -T db \
  psql -U agent2b -d crm_native -c "
    SELECT table_name FROM information_schema.tables
    WHERE table_schema='crm' AND table_name LIKE '%alert%';"

# ④ 生效环境变量
docker compose --env-file scripts/tencent-lighthouse-deploy/.env exec -T app printenv EMBEDDING_PROVIDER

# ⑥ 建议落库表（E3，2026-09-16）：应存在且有行；若表不存在 → 迁移未执行（新版 advise 会静默 trace 而不阻断）
docker compose --env-file scripts/tencent-lighthouse-deploy/.env exec -T db \
  psql -U agent2b -d crm_native -c "
    SET search_path TO crm,public;
    SELECT to_regclass('crm.advice_record') AS advice_table;
    SELECT count(*) total, count(linked_decision_id) linked,
           count(*) FILTER (WHERE created_at > now() - interval '1 day') last24h
    FROM crm.advice_record;
    -- 硬前置机械化核对：决策表里必须零 ADVISED 行（否则 AI 推测会混进人的决策先例）
    SELECT count(*) AS advised_in_decision FROM crm.decision WHERE state='ADVISED';"

# ⑤ 分级授权现状（A 轴｜§2.4 / §11.1 A1–A4）：配置 + 授权元数据 + 撤回状态 + 镜像一致性
docker compose --env-file scripts/tencent-lighthouse-deploy/.env exec -T db \
  psql -U agent2b -d crm_native -c "
    SET search_path TO crm,public;
    -- ① 行内容 + 授权溯源 + 生效状态（A2/A4：现在能答'谁批的'与'还有效吗'）
    SELECT tenant_id, dimension, dimension_value, tier,
           approved_by, decision_id,
           (revoked_at IS NOT NULL) AS revoked, expires_at
      FROM business_tier_config ORDER BY tenant_id, dimension, dimension_value;
    -- ② 授权元数据列是否已由迁移补齐。**缺列 = 迁移未跑**，则新版 computeBusinessTier
    --    会因引用 revoked_at 直接报 column does not exist → 决策链整体失败（发布顺序强制项）
    SELECT column_name FROM information_schema.columns
     WHERE table_schema='crm' AND table_name='business_tier_config'
       AND column_name IN ('approved_by','approved_at','decision_id','expires_at','revoked_at','revoked_reason')
     ORDER BY column_name;
    -- ③ A3 镜像一致性：mirror_rules 必须等于 table_rows。
    --    不等 = 冻结的是过期依据，比不冻结更危险（表面全绿：版本照常解析、决策照常落库）
    SELECT c.tenant_id,
           jsonb_array_length(c.value->'rules') AS mirror_rules,
           (SELECT count(*) FROM business_tier_config b WHERE b.tenant_id = c.tenant_id) AS table_rows
      FROM config_store c WHERE c.key='business-tier-config'
     ORDER BY c.tenant_id;"

# ⑥ 自主放行真实产出（A 轴是否真在驱动）：按 tier 统计自主 vs 升级
docker compose --env-file scripts/tencent-lighthouse-deploy/.env exec -T db \
  psql -U agent2b -d crm_native -c "
    SET search_path TO crm,public;
    SELECT business_tier, state, count(*) FROM decision
    WHERE scenario_id NOT IN ('PARTICLE_CREATE','PARTICLE_UPDATE')
    GROUP BY 1,2 ORDER BY 1,2;

    -- 负向判据：若 business_tier 全为 NULL 或 state 全为 HUMAN，
    --   则'分级驱动自主'在生产未实际发生（勿据本地库推断生产已生效）
    SELECT count(*) FILTER (WHERE business_tier IS NULL) AS tier_null,
           count(*) FILTER (WHERE state='AUTONOMOUS') AS autonomous_total,
           count(*) AS total FROM decision;"
```

---

## 附录 A：证据索引


### A.1 我方（`file:line`）

| 项                                   | 锚点                                                                                                                                                                                                             |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 租户级外部系统描述符与 kind 工厂                 | `src/connectors/discovery/tenantInstances.js:9-13`（`KIND_FACTORY`）、`:19-29`（描述符）、`:15-30`（`loadTenantAdapters`）                                                                                                |
| 通用 REST 适配器（单层扁平映射）                 | `src/connectors/discovery/adapters/genericRest.js:11`（`field_map`）、`:23-32`（字段命中循环）                                                                                                                            |
| 凭据保险库（pgcrypto + fail-closed）       | `src/connectors/discovery/credentialVault.js:34-49`（`resolveCredentials`）、`:52+`（`persistSecret`）                                                                                                              |
| 定时拉取（现状 = 逐条富化）                     | `src/scheduler/timers.js:117-143`（`runIntegrationPollOnce`）、`:163-466`（11 个定时器）                                                                                                                                |
| 巡检器                                 | `src/scheduler/riskScanner.js`、`src/scheduler/salesDailyScan.js:52-109`                                                                                                                                        |
| 入站 webhook 与手动同步端点                  | `src/http/connectorRouter.js:11-25`（`handleSignalWebhook`）、`:71`（`/integration/webhook/:provider`）、`:80`（`/tenant-source-sync`）                                                                                |
| CAS 原子写（现状 = 阶段/归属）                 | `src/particles/particleRepo.js:203`（签名）、`:232-242`（CAS 条件与拒绝）                                                                                                                                                  |
| `updateParticle` 浅合并语义              | `src/particles/particleRepo.js:211`                                                                                                                                                                            |
| 配置读写（含 decisionId）                  | `src/config/configStore.js:51`（`readConfig`）、`:64`（`writeConfig`）                                                                                                                                              |
| 同步后重评闭环                             | `src/connectors/discovery/monitorAccount.js:10-30`                                                                                                                                                             |
| 写通道第 0 闸范式                          | `src/connectors/connectorActions.js:20-33`（`requireDecision`）、`:132`（`agentTool:false` 注释明文）                                                                                                                   |
| 连接器 Action 全清单（4 个，全 write-into-us） | `src/connectors/connectorActions.js:18` / `:53` / `:99` / `:132`                                                                                                                                               |
| **投递面断链证据**                         | `src/alerts/alertStore.js:6`（内存 Map）、`src/alerts/alertEndpoints.js:12-24`（清单/处理器零挂载）、`src/http/server.js:74`（只注册 finance hook）、`src/http/workbenchRouter.js:101-175`（六视角无信号）、`crm.alert` **双重零命中**（运行库 `information_schema` 仅 `alert_rule`；全 `db/**/*.sql` 无 `crm.alert` 建表语句，见 §18.2 ③） |
| 告警判定                                | `src/alerts/alertRegistry.js`（13 类）、`src/alerts/ruleEvaluator.js`、`src/alerts/alertHook.js`                                                                                                                    |
| 事件触发                                | `src/agent/eventTrigger.js`、注册点 `src/http/server.js:97`                                                                                                                                                        |
| 授权约束                                | `src/mcp/gateway.js:201/224`、`src/action/registry.js:14`、`src/action/seed-actions.js:741/801/994/1055/1108`（`deferDecisionMint` 五处）                                                                            |
| 决策结果回写通道                            | `src/action/seed-actions.js:1791/1815/1870`                                                                                                                                                                    |
| Agent 注册表（7 个）                      | `src/agent/agentSpec.js:3-105`                                                                                                                                                                                 |
| 契约键登记表（7 键）                         | `src/agent/contractIds.js`                                                                                                                                                                                     |
| 契约解析内核                              | `src/contract/contractParser.js`（D2 双向断言在 `:129-170`）                                                                                                                                                          |
| 粒子类型既有清单                            | `db/schema.sql:14`（注释）                                                                                                                                                                                         |
| events 表与 channel 索引                | `db/schema.sql:102-114`                                                                                                                                                                                        |
| 新表 DDL 风格与软清理范式                     | `db/schema.sql:945-960`（`discovery_draft` 软清理）、`:962+`（OAuth 三表"不改既有表"声明）                                                                                                                                      |
| 向量写入条件                              | `src/ontology/hooks.js:22`（`EMBEDDING_PROVIDER=model` 才写 `vector(1024)`）                                                                                                                                       |
| 九尺子                                 | `src/decision/rubricScorer.js:17-27`（9 项，仅 `clarity` 允许 LLM 且默认 `llm:'off'`）                                                                                                                                   |
| 决策场景                                | `src/decision/scenarioAdvisors.js:132-138`（7 个）                                                                                                                                                                |
| 装配断言族（8 个）                          | `src/agent/agents.js:66`、断言体 `:76-121`                                                                                                                                                                         |
| 禁 DELETE 唯一例外                       | `src/decision/auditabilitySla.js:29`（`agent_sla` 保留期清理）                                                                                                                                                        |
| 契约校验脚本                              | `scripts/validate-contract.mjs`、`scripts/aggregate-feedback.mjs`                                                                                                                                               |


### A.2 第三方（一手 URL）

| 项                                                                                            | 锚点                                                                                                |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Rox "CRM 只是数据源" + 三层同步 + 乐观并发 + 终局明牌                                                         | `https://docs.rox.com/development/engineering/rox-enterprise-integrations/crm-integration`        |
| Rox 回写配置（字段映射、静态值、Fivetran）                                                                  | `https://launch.rox.com/docs/product/organization-level-configurations/configuring-crm-writeback` |
| Rox Manifesto（须重造 data platform / **agent harness** / UI 三层）                                 | `https://www.rox.com/manifesto`                                                                   |
| Rox 对 Agentforce 立场（"complementary, not competitive"）                                        | `https://www.rox.com/articles/rox-vs-salesforce-agentforce`                                       |
| Rox 定价（**Agent Action 计量**：$100/月=10k actions；$255/月=15k 且无限席位）                              | `https://www.rox.com/pricing`                                                                     |
| Rox Revenue Operating System 架构章                                                             | `https://docs.rox.com/development/about-rox/readme/revenue-operating-system`                      |
| Rox Release Notes 全量（2024-08 → 2026-09 每周一版）                                                 | `https://docs.rox.com/development/about-rox/release-notes`                                        |
| Attio 首页 / Universal Context™                                                                | `https://attio.com/`                                                                              |
| Lightfield（"An agent **harness** for reliable work"）                                         | 官网 + A 轮（a16z 领投）转述源                                                                              |
| 纷享销客开放平台（服务端 API、对象同步、事件订阅）                                                                  | `https://open.fxiaoke.com/`、`https://help.fxiaoke.com/9bfb/c68f/a138/468e`                        |
| 纷享销客对象清单接口 `/cgi/crm/object/list` + `appId/appSecret/permanentCode → CorpAccessToken`（7200s） | 纷享开放平台接口文档                                                                                        |
| 销售易 REST `/rest/data/v2.0/xobjects/{apiKey}` + describe 接口（返回字段类型/可编辑性）                      | `https://www.xiaoshouyi.com/?p=40906`（官方）                                                         |

### A.3 grep 零命中证据（本设计的关键负向判据）

- `纷享` / `fxiaoke` / `销售易` / `xiaoshouyi` / `neocrm` → `src/` 下 **0 命中**
- `salesforce` / `hubspot` / `zoho` → `src/` 下仅 1 处，为 `anysite.js:105` 注释中的技术栈举例
- `parseCsv` / `parseCSV` / `csv-parse` → `src/` 下 **0 命中**（仅 `billingRoutes.js:137` 有 CSV 导出）
- `钉钉` / `飞书` / `企业微信` / `wecom` / `dingtalk` / `lark` → `src/` 下 **0 命中**
- `api/alerts` → `src/web/` 下 **0 命中**（84 个页面无一消费）
- `renewal` / `续约` / `增购` / `upsell` → 仅命中 roleProfiles / routing / dialogAdvisor / thinkingTemplates（均为文案或路由），**无独立管线**

---


## 附录 B：修正记录（本设计推翻的旧判断）

| 旧判断                                  | 修正                                                                                                              | 来源                         |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------- | -------------------------- |
| "我方客户多数没有成熟 CRM"                     | 🔴 **推翻**：客户**都有**自研或套装 CRM（纷享销客、销售易等）。Rox"接现有 CRM"策略从此**直接适用**                                                 | 用户 2026-09-15 明确修正         |
| "'事实发生地'（IM/邮件/Excel）是 P0"           | 🟡 **降级为补充轨**：CRM 是主数据源                                                                                         | 同上                         |
| "'数据进来'要新建导入能力（CSV）"                 | 🟡 **修正**：CRM 已有 API 可直连，**优先做 API 同步**；CSV 降为无 API 的自研 CRM / 台账兜底                                              | 同上                         |
| "由 ROX = 体验回报（Return on Experience）" | 🔴 **推翻**：ROX 是**一家公司**（Rox AI，红杉/General Catalyst/GV 投 5000 万美元）。根因：URL 转写错字导致抓到风控页，又用搜索"补"了一篇同名主题文章——**典型假绿** | 本会话早期                      |
| "A1–A9 编排"                           | 🔴 **推翻**：CRM 是 **7 个 Agent**（A1–A9 属 PDM 项目，跨项目串味）                                                             | `src/agent/agentSpec.js`   |
| "`assertAgentAssembly` 两硬闭包"         | 🟡 **修正**：实为 **8 个断言族**；"两硬闭包"仅指 `permission_closure` + `action_in_registry`                                    | `agents.js:66/76-121`      |
| "缺外部接入器"                             | 🟡 **修正**：已有 25 个 connector 文件 / 10 个 adapter；**精确差距 = 缺 CRM 类适配器 + 缺内部互动捕获**                                   | `src/connectors/`          |
| "我方 eval 机制弱"                        | 🟡 **修正**：已有 `calibration/replay.js` + `replayDims.js`；精确表述 = 缺决策/Agent 全链路级确定性夹具重放                             | grep 命中 12 文件              |
| "我方缺少同步机制"                           | 🔴 **推翻**：同步机制（定时/鉴权/凭证/配额/审计/多租户循环）**已成体系**，缺的是**接的对象与进来的入口**——"机制是否有"与"对象是否有"必须区分                             | 本会话读码                      |
| "`landing.html:146` 的'销售易'是竞品"       | 🟡 **误读排除**：实为"**销售易手**不丢上下文"（动词短语）                                                                             | `src/web/landing.html:146` |
| "本设计需从零建同步与投递"                       | 🔴 **推翻**：已有骨架 E1–E14（约 60%），设计是**补齐 + 接线 + 少量新建**                                                              | §2.1                       |
| "Rox 三层同步（Mappings / Real-Time / Batch）中最难的是冲突消解" | 🟡 **保留**：结论仍成立，且**我方已有同构机制**（`casExpectStage` / `casExpectOwnerEmpty`，`particleRepo.js:203/232-242`）→ 只需扩到字段值，非新建 | 旧 `crm-coexistence` 附录 B（合并时漏转录，**2026-09-16 补录**） |
| "Rox 的 Agent Action 计价单元（业务动作计价表）值得抄"（旧 P0） | 🔴 **未承接（追认为待重评估，非否决）**：该 P0 借鉴项在合并时**未被任何章节承接**，仅残留一条 URL（§附录 A.2）。若要做计价 / 结算形态，须先回捞重评 | 旧 `rox-benchmark` §5（**2026-09-16 补录**） |
| "Attio / Lightfield 的路线是'取代现有系统'"    | 🟡 **保留**：判定仍成立，依据已并入 §1.2 定位象限；旧文档中该条的三方向量表述不再单独保留                          | 旧 `three-way-comparison` 附录 B（**2026-09-16 补录**） |
| "深度合并 / Batch 通道接口预留"列为交付段（旧 `S5`） | 🔴 **范围反转（关键）**：终版明确**不做** → §15.2 #6「完整双向同步…不做」。旧文档把"增量字段更新不误伤同层其它字段"当可交付项；新设计判定 80% 价值已由"只读 + 单向回写"覆盖，复杂度集中在冲突治理 | 旧 `crm-coexistence` §7.2 → §15.2 #6（**2026-09-16 补录**） |
| "顺序纪律靠排期实现"（§14.2 原文的隐含载体） | 🟡 **修正（载体升级，非放宽）**：安全初衷**不变**，改载体——由「排期」升级为「运行时闸门 `exportGate`（fail-closed）」。危险动作（回写/自治）代码可与出口**同批交付但默认关闭**，放行条件 = 出口判据①真实成立。**等价性论证：排期纪律在交付完成后即失效，闸门在生产环境持续生效 → 收紧而非放宽** | `docs/2026-09-16-full-chain-integration-design.md` §0.4（**2026-09-16 补录，用户已批准**） |

---

## 附录 C：本设计刻意规避的跨模块耦合

| 项                              | 规避方式                                                      | 理由                                                            |
| ------------------------------ | --------------------------------------------------------- | ------------------------------------------------------------- |
| `agentSpec` 三处同改（装配闭包）         | 新 Action 全部 `agentTool: false`                            | 范式见 `connectorActions.js:132`；避免 `assertAgentAssembly` 整册校验失败 |
| 新增定时器                          | 复用 `ready-queue-pump`（60s 心跳）+ `integration-poll`（既有租户循环） | 零调度层回归风险                                                      |
| 事件触发键名                         | `agent-event-trigger` **不改名**，仅扩矩阵                        | 向后兼容，旧行语义不变                                                   |
| `updateParticle` 合并语义          | 增 `patchMode:'deep'` **仅同步路径启用**，默认仍浅合并                   | 不改既有语义，零回归                                                    |
| `context-routing`（id36）等平台核心配置 | 全程不触碰                                                     | 2026-09-04 起禁止修改                                              |

---

## 附录 D：对外叙事与表述口径（可引用）

> **性质**：本附录是**对外材料（申报、参赛、客户材料、投资人材料）叙事的唯一口径来源**。
> **来历**：内容**回捞**自 `2026-09-15-attio-lightfield-rox-three-way-comparison.md`（§8 #4、§9）与 `2026-09-15-rox-benchmark-differentiation-analysis.md`（§7）——两处均为 **09-15 合并时未转录**的资产，审计证据见 `docs/2026-09-16-design-merge-audit.md` §4 D3 / D4。
> **效力**：**自本附录起，对外表述以本附录为准**；上述废弃文档仍仅作过程证据，**不得直接引用**。

### D.1 叙事三句（原标注"供对外材料"，逐字保留）

| 对象              | 原句                                                                                                                     |
| --------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **对客户**         | "你不需要先有 CRM，也不需要废弃现有的 Excel、钉钉或用友。我们先把你的客户事实接进来，跑出决策；你验证有效，再谈别的。"                                                     |
| **对行业 / 评审**    | "Attio 与 Lightfield 都要求你搬家，Rox 借你的家。我们是第三种位置：**自建记录系统 + 上下文共生层**——**用纪律换可验证，而不是用规模换概率**。"                            |
| **对投资人 / 合作方**  | "我们的迁移策略不是'把数据搬过来'，而是'**不需要搬**'。"                                                                                     |

> ⚠ **使用前必读（口径修正）**：第一句的**对象前提已于 2026-09-15 同日被推翻**——见附录 B 第 1 行（"客户**都有**自研或套装 CRM"，非"没有 CRM"）。对外使用时须按此前提微调为「**不需要搬迁 / 不需要废弃现有的 Excel、钉钉或用友**」，不要再讲"你不需要先有 CRM"。
> ⚠ 第三句"不需要搬"**不是**"数据可随意搬走"，两者方向相反——见 D.2。

### D.2 对外表述红线（禁用的说法 → 正确说法）

| ❌ 禁用表述                                    | 依据                            | ✅ 正确表述                                                                |
| ------------------------------------------ | ----------------------------- | --------------------------------------------------------------------- |
| "数据可随意搬走 / 零 egress 费"（Lightfield 的获客杠杆） | 三方向对照 §8 #4                   | **"数据不出租户边界"**——机制是 `tenant_id` 全表 + `scopeTenant()`。主数据权属要求严格的场景，"你可以带走"会**反噬** |
| "最终取代客户 CRM / 取消手动录入"                     | §15.1 #1 / §15.5 补录背景         | "**共生**：挂在客户既有 CRM 之上的判断层"                                            |
| "AI 主动值守 / 全自动"（S1 未交付前）                  | §15.4 ②                       | 只讲**已通电**的链路（当前 `signal_delivery` 尚无真实投递，不得宣称）                       |

### D.3 两条可引用的差异结论（回捞自 `rox-benchmark` §7）

| # | 结论（可直接引用）                                                                                                             | 备注                     |
| - | --------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| 1 | **对手方证词**：Rox 公开承认"**没有金标准基准可爬坡**"；我方以 4,111 例测试 + 快照回放 + 8 断言族装配校验作为**可验证性底座**                                             | 这是**对手自证**，引用风险最低       |
| 2 | **同一根轴的两端**：Rox 把 AI **放出**流程（raise the ceiling），我方把 AI **关进**流程（写侧零信任）——在中国 B2B 管理场景，后者**不是保守，是前置条件**          | 用于回应"你们是不是做得不够激进"的质疑   |

### D.4 维护约定

- 凡申报 / 参赛 / 客户 / 投资人材料**引用叙事**，须回指本附录；**不得**改用废弃文档原句。
- 表述若要突破 §15 红线（含 §15.5 #10 / #11）或本附录 D.2，**须先改设计并走 `brainstorming`**（HARD-GATE）。

## 附录 E：未闭合缺口登记表（2026-09-16 复核 · **唯一未闭合清单**）

> **本表是设计层"尚未闭合项"的单一出处**：任何一项闭合后必须回改本表对应行（禁止只改代码不改此表）。
> 数据来源：`2026-09-16-design-merge-audit.md` §8；**本次为逐条复跑复核，非转录**（复核时点：2026-09-16 15:20，同日并行会话正在推进线 A 挂载层，故本表以**判据**而非快照结论登记）。

> **📌 2026-09-16 补充（闭合路径已立项并批准）**：
> - **E.1（线 A 接线四项）** 与 **E.2 的 A-B1 / A-B2** → 由 `docs/2026-09-16-full-chain-integration-design.md`（**已批准**）**Q2「入口接线」**承接。
> - **⚠ 本表此前漏登记的第五项缺口**（本次新发现，已补入闭合设计）：**「投递编排层缺失」**——`createDeliveryRegistry` 在 `src/` 生产调用点 **= 0**（仅定义处 + 单元测试），且 S1 计划 `docs/superpowers/plans/2026-09-16-proactive-s1-delivery.md` 的 9 个 Task **无一个是编排/驱动**。这是 §0.2「挂载方一直没来」缺陷**下沉一层**的重演 → 由新设计 **Q1「出口接电」**承接。
> - 另发现**判据自身假前提**：`src/monitor/signalMetrics.js:11,73` 的 `enabledChannels` 默认 `DEFAULT_CHANNELS`（四渠道全开），而 `src/scheduler/timers.js:604` 调用时未传参 → 面板「渠道已开启」为硬编码断言而非配置读取 → 由新设计 **Q1-4** 承接。
> - 该设计 §4 含 **15 个生命契约块（覆盖全部 7 个名册 agent）**，§5 含 **两条正向判据 + 7 条防假绿负向判据**。
> - **本表相应行在 Q1/Q2 交付并跑出真实行后回改**（依本表维护约定：更新状态须同时更新复核时点）。

### E.1 🔴 线 A 接线（最高风险，对应 §0.5）

> **复核时点更新：2026-09-16 16:05**（E1-1～E1-3 于 15:20 复核的 🟡/❌ 已在本轮闭合；E1-4 仍为 🟡）

| # | 项 | 状态（16:05 复核） | 复跑判据 | 归属 |
| - | -- | ----------------- | -------- | ---- |
| E1-1 | 挂载层 `src/sync/mount.js` **已就绪且已接线**（A-B5 事件路由 + A-B6 定时增量分支体，含信任档取 min、L2/L3 每 run 铸决策、写无决策即拒、失败不静默） | ✅ **已闭合** | `grep -rn "runTenantSyncOnce\|sync/mount" src/scheduler/timers.js src/http/connectorRouter.js` → **2 命中** | 计划 `docs/superpowers/plans/2026-09-16-line-a-mount-points.md` |
| E1-2 | A-B6 `integration-poll` 增量拉取分支 | ✅ **已闭合**（`timers.js` `runIntegrationPollOnce` 租户循环内增分支，**零新增定时器**：`git diff` 中 `timers.set(` 新增 0） | `grep -n "loadSyncTargets" src/scheduler/timers.js` → 非 0 | 同上 |
| E1-3 | A-B5 对象变化事件路由 | ✅ **已闭合**（`connectorRouter.js` `handleSignalWebhook` 按 `body.event.object` 路由到 `handleObjectChanged`；两路共用 admin/sysadmin 闸；**未接线时返回 501，不静默降级为线索派发**） | `grep -n "handleObjectChanged\|runSyncEvent" src/http/connectorRouter.js` → 非 0 | 同上 |
| E1-4 | 端到端证据 | 🟡 **冒烟已过，生产实况仍为 no-op** | ✅ `node scripts/smoke-line-a-mount.mjs` → **5/5 OK**：① L1 零写入（`external_ref` 0→0）② L2 `created=4` 且 `sync_cursor.decision_id` 落锚点 ③ 二次幂等 `created=0` ④ 轮询侧无决策 fail-closed（errors=2 且零写入）⑤ **A-B5 事件路由**（L1 只读 / L2 无决策 `decision_required` 拒写 / L2 有决策写入）。❌ **`crm.config_store` 三键（`integration-providers` / `sync-mappings` / `sync-trust`）均未配置** → 无 `objects[]` 描述符 → 生产两处触发点均为 no-op | — |

> **⚠ E1-3 补记（G3 · 2026-09-16 复核发现并修复）**：E1-3 判"已闭合"仅指**路由存在**；本轮复跑发现**缺省装配路径**另有独立缺口——
> `connectorRouter` 的 `doSyncEvent` 缺省装配**未注入 `mintDecision`**，且 `handleObjectChanged` 用可选形态 `if (mintDecision)` 而非 fail-closed
> → **L2/L3 写路径可无决策落库**（第 0 闸被静默绕过，违背 §15）。已修：装配补 `mintDecision`（走 `autonomy.requireDecision`，与轮询同源）+ `emit`；内核补 fail-closed（缺注入视同"铸不出"）；`test/sync/mount.test.js` +2 例；冒烟 +⑤。
> **隐蔽性**：`test/external-integration.test.js` 三条 A-B5 用例**全部注入 `runSyncEvent` 替身** → **缺省装配路径零覆盖**，102 例全绿的测试套件对此缺口完全不可见。详见计划 §4.3 G3。
> **判据修正**：判"接线已闭合"不能只看"调用点存在"，须核**缺省装配分支是否有独立覆盖**（同族前例：`adoption.test.js` 用假 store 掩盖静默丢字段）。

> **对外表述约束（2026-09-16 16:05 修订）**：接线已闭合，但**尚无任何租户配置 `objects[]` 描述符与同步映射**，且默认信任档为 L1（只读）。
> 故「**已接入客户 CRM / 可回写 / 双向同步已上线**」**仍然禁用**（见 §0.5 红线与附录 D.2）——接线存在 ≠ 有客户在同步。
> **解禁判据（可复跑，非日期）**：出现首个真实租户的 `crm.sync_cursor.last_status='ok'` 且 `decision_id` 非空的行（即 L≥2 的首次真实入库），方可在该租户口径下改称「已接入」；**跨租户泛化表述永远禁用**（见 §18.2 探针族）。

### E.2 🟢 线 A 补齐项（§6.1 A-B*）—— 2026-09-16 17:00 复核：**6/8 闭合 · 1 项裁决不做 · 1 项分类更正**

| # | 补齐项 | 状态（17:00 复核） | 复跑判据 |
| - | ------ | ----------------- | -------- |
| A-B1 | `integration-providers` 描述符扩 `objects[]`/`token_mode`/`trust_level` | ✅ **已实施**（2026-09-16） | `grep -rln "providerDescriptor.js" src/` → 3（模块 + `connectors/discovery/tenantInstances.js` + `sync/mount.js` 两侧消费）；`test/connectors/discovery/providerDescriptor.test.js` 13 例 |
| A-B2 | `credentialVault` 支持结构化凭据 + token 加密落库 | ✅ **已实施**（2026-09-16） | `grep -c "parseCredentialPayload\|persistToken" src/connectors/discovery/credentialVault.js` → 5；`credentialVaultStructured.test.js` 12 例 + `credentialShapeConsumption.test.js` 6 例（**消费面**） |
| A-B3 | `KIND_FACTORY` 加 `fxiaoke`/`neocrm` | 🟡 **已实现，落点漂移** | 落在 `src/sync/factory.js` 的 `SYNC_PROVIDER_FACTORY`（`fxiaoke`/`neocrm`/`generic-rest`），与 enrich 侧 `KIND_FACTORY` **刻意分离**（两侧契约不同：`enrich` vs `readIncremental`）——**设计描述精度不足，非实现偏离** |
| A-B4 | CAS 语义从"阶段/归属"扩到"字段值" | ✅ **已实施**（S4，2026-09-16） | `grep -c "casExpectField" src/particles/particleRepo.js` → 4 |
| A-B5 | `connectorRouter` 增对象变化事件路由 | ✅ **已接线**（2026-09-16 16:05） | `grep -n "handleObjectChanged" src/http/connectorRouter.js` → 非 0；`test/external-integration.test.js` A-B5 段 5 用例 |
| A-B6 | `integration-poll` 增对象增量拉取分支 | ✅ **已接线**（2026-09-16 16:05） | `grep -n "loadSyncTargets" src/scheduler/timers.js` → 非 0；`test/external-integration.test.js` A-B6 段 6 用例 |
| A-B7 | `monitorAccount` 复用为"同步后重评" | ⚠ **分类更正：非"补齐"，属新建能力（依赖缺失）** | `grep -rn "function rescore" src/` → **0**；`monitorAccount.js:10` 要求 ctx 提供 `getAccount`/`rescore`/`appendMemory`/`updateParticle` 四件，其中 **`getAccount`/`rescore` 全仓无实现**。①"补齐"的判据是**复用既有机制**，此处无机制可复用 → 应移入 §7 新增清单 |
| A-B8 | `updateParticle` 增 `patchMode:'deep'` | ⛔ **裁决不做**（2026-09-16） | 已归入 §15.2 #6 红线（"完整双向同步不做"）；`grep -c "patchMode" src/particles/particleRepo.js` → 0（保持不变）。**重启须先推翻 §15.2 #6** |

#### E.2.1 🔴 本轮新识别：`timers.js:168` 的 `monitorAccount` 调用**结构性不可能成功**（真实缺陷，**未修**）

| 项 | 内容 |
| -- | ---- |
| 调用点 | `src/scheduler/timers.js:168` — `if (sigs.length) await monitorAccount({ tenantId: tid }, acc.id, sigs).catch(() => {});` |
| 缺陷 | `monitorAccount(ctx, accountId, signals)` 首参要求 ctx 四件套（`getAccount`/`rescore`/`appendMemory`/`updateParticle`，见 `monitorAccount.js:10-32`），而此处只传 `{ tenantId }` → 第 12 行 `ctx.getAccount(...)` 必抛 `TypeError` |
| 后果 | ① 富化路径的"C3 持续账户监控闭环"（`timers.js:121` 注释所承诺）**从未真正执行**——属"**注释承诺≠实现**"家族；② 错误被 `.catch(() => {})` **空吞**，无 trace、无账 → 与 `G3 不静默` 铁律冲突 |
| 触发条件 | 仅当某账户富化出非空 `values`（`sigs.length > 0`）时命中；因当前生产无租户配置富化 provider，**未暴露** |
| 处置（**待批准，本轮未动**） | ① 立即：把 `.catch(() => {})` 改为 `emit('trace')` + `recordFailure`（消除静默，零风险）；② 根治：实现 `ctx.rescore`（lead-fit 重评）与 `ctx.getAccount`，并按 A-B7 的**真实分类**（新建能力）立项 |

> **A-B3 更正提示**：本设计 §6.1 A-B3 原文写「`KIND_FACTORY` 加 `fxiaoke`/`neocrm`」，未指明是 **connector 侧**还是 **sync 侧**的工厂。实现选择了 sync 侧独立工厂（理由见 `src/sync/factory.js:3` 注释）。**这是设计描述的精度不足，不是实现偏离**——本节即为更正记录。
> **A-B1/A-B2 的落点纪律**：两者共用一条新纪律——**描述符的解释权只能有一处**（`providerDescriptor.js`）。此前 `tenantInstances.js` 与 `sync/mount.js` 各自解析 `objects[]`/`direction`，属"同名字段两套语义"的雏形；A-B3 的同名工厂问题即是同类风险的先例。

### E.3 🟢 线 B 补齐项（§6.2 B-B*）—— 2026-09-16 17:00 复核：**2/2 已裁决（均为"实现先行、设计滞后"的追认）**

| # | 补齐项 | 状态（17:00 复核） | 复跑判据 |
| - | ------ | ----------------- | -------- |
| B-B3 | `alertStore` 由内存 Map 迁 DB（建 `crm.alert` 表） | ⛔ **落点更正：不建 `crm.alert`**——实现为**内存 Map + 写 `crm.signal` 统一收口**。理由：`crm.signal` 已是全告警统一落点（S1 交付），另建表会造出**第二个告警事实源**。**设计 §6.2 已同步更正**（非实现偏离） | `grep -rn "CREATE TABLE IF NOT EXISTS crm.alert" db/` → 0；`information_schema` 无 `crm.alert`（**保持不变**） |
| B-B7 | 抽公共 mailer `src/mail/` | ⛔ **落点更正：不抽模块**——实际共用的是**配置契约**：`src/signal/delivery/email.js` 直接复用计费域既有惯例（`SMTP_USER`/`SMTP_PASS` + Brevo，源自 `src/http/activation.js`）。抽中间层只会为两处调用造壳，且两域投递语义不同（交易通知 vs 业务提醒）。**重启条件（三次法则）**：出现第三处 SMTP 消费方时再抽 | `ls src/mail` → 不存在；`grep -rln "nodemailer\|SMTP" src/` → `http/activation.js` / `signal/delivery/email.js` / `signal/delivery/index.js` / `memory/memoryLog.js`（**各自持配，无中间层**） |

> **线 B 补齐项的两条结论**：① **"复用"的对象可以是配置契约而非代码**——B-B7 是这一判据的首例，设计原文默认了"共用=抽模块"，实际共用点是 `SMTP_*` 环境契约；② **"统一收口"优先于"新建表"**——B-B3 若照原文建 `crm.alert`，会与 `crm.signal` 形成双事实源（与 §6.1 A-B1 的"描述符解释权只能有一处"同源）。

### E.4 🟢 旁证与工具链 —— 2026-09-16 17:00 复核

| # | 项 | 状态（17:00 复核） | 处置 |
| - | -- | ---- | ---- |
| E4-1 | `reports/nightly/20260915-audit.md` 含**失效红色断言**（把已完成的报成未完成） | ⚠️ 报告未随交付更新 | 已在报告头部加**失效横幅**（2026-09-16 加注），指向本设计与 `2026-09-16-design-merge-audit.md` |
| E4-2 | `node scripts/validate-contract.mjs` 返回 `valid:false` | ✅ **已闭合（2026-09-16 17:00）** | 已补 `review-gate.memory.read += 'decision-retro'`（`src/agent/agentSpec.js:53`，与 §13 T21 契约逐字对齐）。**复跑判据**：`node scripts/validate-contract.mjs docs/2026-09-15-final-design-coexistence-and-proactive.md --registry src/agent/agentSpec.js` → `{"valid": true, "errors": []}` |

### E.5 🔴 2026-09-16 21:10–21:25 复核：**S7 观测面两处结构性缺口**（1 项已闭合 · 2 项登记未闭合）

> 触发：E.2.1 同轮遗留的「D1 同族遗漏 P-2」从待办升级为**独立 P1**。复核范围刻意扩到**整个观测面**（不止修好那一行），
> 结果在同一层又打出两条**未闭合**缺口——即"修一处、露出两处"。以下三条互为同族，判据均以**代码事实**表述。

| # | 项 | 状态（21:25 复核） | 复跑判据 |
| - | -- | ---------------- | -------- |
| **E5-1** | **巡检候选租户集排除平台租户**（`createSignalObservabilitySweep().sweepOnce()` 的 `WHERE tenant_id <> 'system'`） | ✅ **已闭合**（2026-09-16 21:20） | `grep -n "SELECT DISTINCT tenant_id FROM crm.signal" src/monitor/signalMetrics.js` → **无 `WHERE`**；`test/monitor/signalObservabilitySystemScope.test.js` **5 例**；**变异验证**：注回 `<> 'system'` → 4 红；改 `NOT IN ('system')` → 仍 4 红 |
| **E5-2** | **判据 B 的"命中"以桥自身输出测量**（自指仪器）：`detectNegativePredicates` 的 `gen_silent` 前提取 `crm.signal.source='event-trigger'` 行数，而这些行**正是感知桥 `recordPerception` 自己写的**（`eventTrigger.js`） | 🟡 **部分闭合**：**② 静默已闭合（21:50）**；**① 换独立仪器仍待裁决** | ② 复跑：`test/agent/eventTriggerPerceptionTrail.test.js` **4 例**；**变异验证**：注回两处静默 → 2 红（M3 未注入档 / M4 写入失败档各命中一条）。① 复跑：`grep -n "source: 'event-trigger'" src/agent/eventTrigger.js` → 仍在 `recordPerception` 内 ⇒ 前提量仍是桥自身输出 |
| **E5-3** | **候选集来源即被判管道**：`sweepOnce` 从 `crm.signal` 取租户 ⇒ **零信号租户永不进扫描面**，与 E1「真实租户从未被接通」**正面冲突** | 🔴 **未闭合** | 造一个只配 `signal-delivery`、零 `crm.signal` 行的租户 → `sweepOnce()` 的 `tenants` 不含它、`fired=0`（**该场景下观测器与"一切正常"不可区分**） |

**E5-1 的判定依据（为何算缺陷而非设计选择）**
1. **同族断点已在泵侧按设计 §3.1.1 修正**：`src/signal/dispatcher.js` 的 `pumpAllTenants` 注释明写「D1：**不得排除 `system`** —— 平台级信号同样必须被泵（否则平台告警永久静默）」，且 `test/signal/dispatcher.test.js:151` 已留负向断言 ⇒ **项目自身已确立"排除 platform 租户 = 缺陷"的判据**。
2. **修的是同一族、漏的是第二处**：泵侧保证平台信号**被投递**，观测侧却把平台租户剔出扫描面 ⇒ 平台信号**被投递但永不接受负向判据**（`delivery_silent`/`gen_silent` 对平台租户恒静默）。属"上一闸修了、下一闸没修"。
3. **方向安全性**：平台租户零信号时该分支自然空转（零额外成本）；有信号而渠道已开却零投递，**正是必须报警的场景**。故不应保留任何形式的豁免。

**⚠ 同族排查结论（防重复劳动，本轮已做全仓扫描）**：全仓另有 2 处 `tenant_id <> 'system'`，**经核实语义正确、非缺陷，不得误改**：
- `src/config/broadcast.js:10` —— 广播**收件人**列表（源表 `crm.crm_users`）：平台租户无业务用户，不参与广播；
- `src/http/propagationRoutes.js:98,333` —— 配置**传播源**列表（排除 `system` 与 `*`）：模板行是"被传播物"而非"传播者"。
⇒ 二者与本处（`system` 作为**被监控租户**）语义不同。**判据：排除 `system` 是否正当，取决于该查询里 `system` 扮演"租户"还是"模板/平台身份"**——本处是前者（故为缺陷），上两处是后者（故正确）。

> **⚠ E5-2② 补记（2026-09-16 21:50 · 已闭合）**：`src/agent/eventTrigger.js` 的 `recordPerception` 原有**两处静默**，均属"违 §15 不静默"，且**正是判据 B 失明的直接成因**（"前提量缺失"与"本来就没命中"不可区分）：
> - ① `if (!signalStoreRef) return null;` → 改为 emit `agent-event-trigger-perception-skipped`（带 `reason:'signal-store-not-injected'`，**未注入 ≠ 未命中**）；
> - ② `create(...).catch(() => null)` → 改为 `recordFailure('agent-event-trigger-perception', e)` + emit `agent-event-trigger-perception-failed`。
>
> **返回契约刻意不变**（失败仍 resolve `null`，不向调用方抛）：调用方 `dispatchFromTrigger` 是裸 `await` 且无 try/catch，抛异常会打断派发主流程 —— 留痕的目的是**可观测**，不是**改变失败语义**。
> 本项只修"可观测性"这一半（**零设计风险**）；**"换独立仪器"那一半（E5-2①）是设计决策，刻意未动**（见 E.6）。
> **归一佐证**：生产侧 `setSignalStore(pool)` 确在 `timers.js:215` 调用 ⇒ 事件路径的感知落库**是接通的**，故本项不是"挂载方没来"，而是纯静默问题（避免了又一次误归因）。
> **复跑**：`test/agent/eventTriggerPerceptionTrail.test.js` 4 例（含一条"写入成功 → **不得**产生上述两种留痕"的**反向**用例，防把正常路径报成故障）；eventTrigger 全家族 **5 文件 / 28 例全绿**。

**⚠ 本轮最重要的方法论（已回写 `anti-fake-green-probe` SKILL）**：护栏自身的**替身必须尊重被测 SQL 的语义**。
本次第一版替身写成「看到 `SELECT DISTINCT tenant_id` 就固定返回 `[{tenant_id:'system'}]`」——**替身的缺省值反向定义了契约**（`mount.test.js` 假 deps 同族）。
实测代价：把缺陷注回去后**三条"行为断言"全绿**，仅负向 SQL 断言变红 ⇒ 行为断言在该缺陷下**无鉴别力、是假绿载体**。
第三版改为「候选 SQL 里出现 `'system'` 字面量即视为已过滤」并**为替身模型自身加自检条**（`test/monitor/signalObservabilitySystemScope.test.js` 的「替身模型自检」块）后，变异 M1/M2 均 4 红。
⇒ **"我加了行为断言"不等于"行为断言有鉴别力"；行为断言必须与变异验证成对出现。**

### E.6 待裁决（承 E5-2 / E5-3，均需设计决策，本轮**未动**）

| 缺口 | 建议处置 | 为何不自行实施 |
| --- | ---- | ------------ |
| E5-2① | 判据 B 的"命中"改用**匹配点独立留痕**（`dispatchFromTrigger` 命中即 emit trace / 记与 signal 无关的计数），**不得**以 `crm.signal` 的 `event-trigger` 行为前提 | 独立仪器需选型：`crm.tasks`（`step='agent-event-trigger'`）**只覆盖 `READ_ONLY_SKILLS` 的匹配**，非完备仪器；选谁属设计决策 |
| ~~E5-2②~~ | ~~移除 `recordPerception` 的两处静默~~ | ✅ **已闭合（21:50）**，见上「E5-2② 补记」 |
| E5-3 | `sweepOnce` 候选集改取**租户注册表 ∪ `crm.signal`**（`listActiveTenants`，`crm.tenants status='active'`，`timers.js:134` 已在用）；并新增「零信号租户」判据 | 仅改枚举源**不产生任何告警**（两条判据都以"有信号"为前提）⇒ 须同时**新增判据**，属设计增量 |

> **维护约定**：本表任一行的"状态"列更新，须同时更新其**复核时点**；禁止把"已实现"改成"✅"而不重跑判据。
> 本表以**判据**表述（而非快照结论），是因为同一天内线 A 就发生过"模块已建但未接线"的状态迁移——**快照结论在并行开发下半衰期极短**。

### E.7 ✅ 2026-09-17 复核：**测试同源缺陷 7 文件闭合 · 生产侧租户供给缺口已闭合（取裁决选项②）· 另清 2 条长尾既有缺陷**

| 编号 | 缺口 | 状态 | 判据 / 证据 |
| --- | --- | --- | --- |
| **E7-1** | **7 个测试文件 `import { X_TENANT }` 已被删除的常量** —— 2026-09-09「数据漂移根因修复」(`scripts/_refactor_seed_tenantid.mjs`) 删除了 `db/seed/tenant-profile-*.js` 里的 `export const X_TENANT = 'acme-<行业>'`，但 7 个测试未同步 → ESM 下拿到 `undefined` → `seedXxxProfile(undefined)` 抛 `tenantId is required`（**表现为"全 skipped + exit 1"，极易被误读成"跳过"**） | ✅ **已闭合**（2026-09-17） | 复跑：`test/agent/aiFill`、`test/calc/formulaEngine`、`test/integration/{chemical,insmedi}-tenant-runbook-validation`、`test/integration/training-tenant-e2e`、`test/meta-model/{edge-config,type-resolver}` → **7 文件 / 38 例全绿**。修法＝**测试侧**新增单一来源 `test/fixtures/testTenantIds.js`（刻意**不复用 `acme-*` slug**；补回导出等于回退 09-09 的修复，禁止）。**两层均载重**：缺 import 修复 → 整文件报错；缺下述 E7-2 铺垫 → 复合外键报错 |
| **E7-2** | 🔴 ~~**"全新租户"无法 mint 决策（复合外键违例）**~~ —— `crm.decision_scenario` 自 2026-09-05 起 PK = `(scenario_id, tenant_id)`（`db/migration-decision-scenario-tenant-pk.sql`，用户裁决「全隔离」），且 `crm.decision` 有复合外键 `decision_scenario_tenant_fkey (scenario_id, tenant_id)`；但 `db/seed-decision-scenarios.sql` **不写 `tenant_id`** ⇒ 字典**只落 `system`**。而 `requireDecision`（`src/decision/autonomyEngine.js:133-136`）在本租户无该场景时**回退 `system` 模板解析**，mint 出的行却仍写**调用方租户** ⇒ **"解析有回退、落库没有回退"** ⇒ 该租户无自身场景行时插入必违外键 | ✅ **已闭合**（2026-09-17，取裁决选项②"落库前 lazy ensure"） | 实测（测试库）：`SELECT tenant_id, count(*) FROM crm.decision_scenario GROUP BY tenant_id` → 仅 `system` 有 35 行；以测试租户走 `actionExecutor.dispatch('crm-import-batch', …, {bootstrap:true})`（该 Action 声明 `autoDecision:true, decisionScenario:'IMPORT_BATCH'`）→ `insert or update on table "decision" violates foreign key constraint "decision_scenario_tenant_fkey"`。修复后由**独立仪器**取证：`scripts/verify-tenant-scenario-provisioning.mjs`（真实入口 + **每轮全新租户** + **负向控制**）→ 4 项 PASS |
| | **①"开通时物化"尚未做（残留项）** | ⏳ **未做 · 非阻塞** | 选项② 只保证"**要被写入时**必先物化本租户场景行"，对"**零决策活动的租户**"其 `crm.decision_scenario` 仍为空（故配置页/巡检看不到这些租户的场景行）。若要让"开通即完备"（含列举/审计语义），仍应在 `seedTenantDefaults`/onboarding 追加一次幂等克隆。**当前无正确性缺口，属完备性/可观测性增量**，未自行实施 |

> **E7-2 补记（2026-09-17 · 已闭合）**：裁决取**选项②（落库前 lazy ensure）**，理由是它**同时覆盖存量租户**（选项①只覆盖今后开通者，存量仍会违外键）。
> - **物化点收敛在"唯一可违反该外键的写入处"**：`crm.decision` 由 `decisionRepo.createDecision` 唯一写入 ⇒ 在该函数内于 INSERT 前调 `ensureTenantScenarioSafely`，一处即覆盖全部铸决策通道（`mintDecision` / 标准授权 / standing-auth…）。
> - **同族排查多找到 1 个写者**：`crm.calibration_patch` 与 `crm.outcome_event_map` 共享同一复合外键族；`src/calibration/store.js:createPatch` 亦写 `tenant_id` ⇒ 一并接入同一入口（**否则只修一半，属"同族遗漏只修上一闸"的复发**）。
> - **`ensureTenantScenario` 刻意不许 DELETE**：`INSERT…SELECT … FROM crm.decision_scenario s WHERE s.tenant_id='system' ON CONFLICT (scenario_id, tenant_id) DO NOTHING`，幂等、可重入（镜像 migration 步骤 3.5 的写法）。
> - **catch 不掩盖故障**（关键）：`ensureTenantScenarioSafely` 的 try/catch **只避免"双份报错"**，不是把外键故障吞掉——物化失败后故障必然在紧随其后的 INSERT 以 `decision_scenario_tenant_fkey` **原样抛出**（`insertDecisionFailOpen` 对非维度错不降级、原样 throw；`calibration/store.js` 亦无 catch）。⚠ 该性质**依赖下游 insert 不被改成吞异常**，一旦被改，此 catch 即退化为静默容忍 ⇒ 已由 `test/decision/tenantScenarioProvisioning.test.js` 单留一条「缺行必违外键」的复现断言守住。
> - **顺带修掉读取侧的跨租户读配置**：`loadScenarioConfig` 原先**无租户谓词**（`WHERE scenario_id=$1`），而"本租户物化"落地后同名场景必然多租户并存 ⇒ `rows[0]` **任取**。实测本地主库 `PARTICLE_CREATE` 已有 2 个租户的行（当时各行内容相同故未显形；一旦某租户按后台配置校准 `default_tier`/`eval_dimensions`/`focus_rulers`——正是**行业差异化载体**——即读到**别的租户**的配置）。现改为 `WHERE scenario_id=$1 AND tenant_id=$2` + 缺行回退 `system` 模板，**口径与 `requireDecision` 对齐**（本租户优先 → system 兜底 → 都没有才 null）。
> - **变异验证（三条各自定位一层，全部先自检"已注入"）**：M1 物化入口退化为 no-op ⇒ 探针复现**原始外键违例**（接线载重）；M2 读取侧去掉租户谓词 ⇒ 读取谓词用例变红；M3 克隆清单漏列 `enabled_rulers` ⇒ **列集漂移守卫**变红。
> - **测试侧铺垫已移除**：先前为让 3 个集成测试通过而加的 `test/fixtures/tenantScenarios.js`（幂等克隆垫片）**已删**，相应调用一并撤掉 ⇒ 这 3 个用例**反过来成为生产供给链路的接线证据**（物化被删即报外键违例）。⚠ 注意其局限：本地测试库仍有历史残留行，故"这 3 个用例绿"**本身不构成**"物化已接通"的充分证据——充分证据是上面的独立探针（每轮用**全新租户**）。
> - **复跑**：7 文件同源簇 + 新增 `test/decision/tenantScenarioProvisioning.test.js`（8 例）+ 隔离护栏 **46/46 全绿**；`test/decision`+`test/calibration`+`test/setup` 全目录 **103 文件 / 629 例**（修复前后由下表两条既有缺陷占据唯一红位，见下）。

> **⚠ 同批修掉的两条既有缺陷（非本项引入，但同属"长尾红"必须一并清）**：这批回归暴露出的两条红**均已单文件复现 3 次**确认与 E7-2 改动无关（`mintId.js`/`leadFitScenario` 相关文件自 `c88a29a` 基线起**从未改动**，工作树亦无未提交改动），且**同一份报告里两条的失败值可反推出根因**：
> - `test/decision/leadFitScenario.test.js`：`leadFitRow()` 原写作 `stmt.slice(i)`（"切到语句尾"），隐含约定「**LEAD_FIT 是 VALUES 段最后一行**」——该约定被其后两次追加证伪（`PROSPECTING_CONFIRM` 09-14 追加 2 权重、`PREHEAT_MARK` 09-15 追加 1 权重）⇒ 切片吞下三行，`"weight":` 匹配到 5+2+1=**8** 个 → 报 `expected [Array(8)] to have a length of 5`。**⇒ 判据：从 SQL 文本按"位置约定"切片，等于把「后续追加」变成隐式破坏；必须按结构边界（下一个元组起始）切。** 变异 M-A（恢复"切到语句尾"）**复现出与原始完全一致的报错原文**。
> - `test/decision/mintId.test.js`：幂等复读那次的查询**缺 `ORDER BY slug`**（同一测试内前一次查询有、这一次没有）⇒ 无 ORDER BY 时返回顺序取决于物理堆序，而上一次 `backfillStableKeys()` 的 UPDATE 会重写行版本、改变堆序 ⇒ `rows2[0]` 可能取到 `slug-B`，报「expected `26e8a45a…` to be `480adce9…`」（实测二者分别正是 slug-B / slug-A 的 key ⇒ **可反推 `rows2[0]` 确实是 slug-B 行**）。独立仪器（**反序插入**构造堆序差异）复现：无 ORDER BY 取首行 = `slug-B`，有 ORDER BY = `slug-A` ⇒ 同一数据上 `rows[0]` 即可不同。**⇒ 判据：多行断言必须显式 ORDER BY，不得依赖"两次查询返回顺序一致"。**


> **E7-3 补记（2026-09-17 · 已闭合，用户裁决"按租户"）**：校准配置 `required_dims` 的读写此前**无 `tenant_id` 谓词**（生产代码 `src/calibration/knobs/requiredDims.js:16` 的 `apply` 的 `UPDATE` + `src/sevenDimensions/engine.js:13` 的 `sevenDimensionsCheck` 的 `SELECT`），复合主键 `(scenario_id, tenant_id)` 落地后「改一个场景」实际改写**该场景全部租户行**、「读配置」任取 `rows[0]` ⇒ 跨租户写/读（E7-2 同族遗漏）。用户裁决＝**按租户隔离**。
> - **写侧**（`requiredDims.apply`）：`UPDATE … WHERE scenario_id=$2 AND tenant_id=$3`，tenantId 由 `approvePatch`/`rollbackPatch` 经 `ctx.tenant_id` 透传（patch 行本就带 `tenant_id`）；`createPatch` 已先 `ensureTenantScenarioSafely` 物化本租户行 ⇒ 写点只落本租户行。
> - **读侧**（`sevenDimensionsCheck` + 三个决策级读者 `closure.js`/`attribution.js`/`traceRootCause.js`）：统一改为 `WHERE scenario_id=$1 AND (tenant_id=$2 OR tenant_id='system') ORDER BY (tenant_id=$2) DESC LIMIT 1`——**本租户优先 → system 回退**，与 `executor.js:27` / `loadScenarioConfig` 同源范式。`attribution.js` 的 `computeAttribution` 新增 `tenantId` 参数并透传给 `check` 与直读；`decisionRepo.createDecision` 落库前闸（`sevenDimensionsCheck` 调用）透传 `tenantId`；`replayDims` 透传 tenant 保证量化重放口径一致。
> - **证据**：新增 `test/calibration/requiredDimsTenantIsolation.test.js`（2 例）——① apply 只改本租户行、不污染其他租户/system；② `sevenDimensionsCheck` 读本租户行、缺则回退 system。回归：`test/calibration` **22 文件 / 160 例全绿**；`test/decision-gate` **3 轮 × 4 例全绿**（顺序依赖抖动确认消除）。
> - ⚠ **残留待办（非阻塞，非本次范围）**：`src/http/calibrationRouter.js:61`（手动发起处方读 `required_dims` 计算 from_value）仍读 system 行，而 `createPatch` 默认 `tenant_id='system'` ⇒ 该入口眼下只服务平台级校准，与"按租户"不冲突；若要支持"按租户手动发起"，需补 `scopeTenant(me)` 透传。另 `methodologyInjection.js:26` 读 `methodology_ids` 仍无 tenant 谓词（同族，未决但当前不影响 `required_dims` 校准语义）。

> **本轮方法论（已回写 `anti-fake-green-probe` / `shared-db-test-hygiene`）：修掉一层缺陷后必须重跑并审视"是否暴露出下一层"，不得以"转绿"收工。**
> 本案中 **E7-1 的崩溃掩盖了 E7-2**：`beforeAll` 抛错 → 整个 suite 报"全 skipped"→ §4 的复合外键问题从未被执行到。
> 修好 import 后，E7-2 才浮现。⇒ **"错误信息消失"≠"缺陷消失"；"转绿"只对当前这一层成立。**
> 另一条已固化的纪律：**Edit 报成功但被并行会话还原**（本轮 2 次）⇒ 多处改动须**一次原子写入 + 立刻 grep 复核**（本次即靠复核发现"import 落地、调用未落地"）。

---

**— 文档结束 —**
