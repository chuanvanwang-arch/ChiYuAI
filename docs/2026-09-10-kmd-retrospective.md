# KMD 三系统关系与闭环：系统性复盘与整体解决方案

> 适用项目：CRM-ai-native｜整理时间：2026-09-10｜方法：代码级审计（grep + `file:line` 锚点）+ 探针实测（`scripts/kmd-closure-probe.mjs`，13 条 + 1 端到端哨兵）
> 本文是 KMD 关系的"总说明书"，与 `docs/2026-09-10-kmd-unified-design.md`（按优先级逐 P0 修补的设计文档）互为表里：本文讲"是什么/为什么/怎么查/怎么修"，设计文档讲"按什么顺序修"。

---

## 0. 结论先行（TL;DR）

1. **三者不是并列的三张表，而是"消费—反哺"闭环中的一个环**：
   - **K（Knowledge，知识）** = 跨实体的**可复用判定标准**（"这类情况一般该怎么判断"）—— 比如 ICP、竞品、异议、买家语言。
   - **M（Memory，记忆）** = 单实体的**时序情境**（"这个客户/这个商机具体发生了什么"）—— 事件流、决策四段式、蒸馏归档。
   - **D（Decision，决策）** = **消费 K 与 M**（组装上下文→做决策），并**反哺 K 与 M**（把决策、结果、参数回流）。
2. **闭环已经接通**，当前只读探针 **🟢6 🔴3 🟡3**：接通的边 = ①K→D、②M→D、③D→M、⑥校准触发、⑦参数生效、⑧M→K；剩余 🔴 全是**已知独立延期/治理项**（D1 真向量未接入、D4 无真实业务事件流过、D6 校准积压=HITL 治理缺口），非"接线没接上"。
3. **核心设计纪律（源自一次 62 万行噪声翻车）**：闭环用**八条边**建模；每条边都必须有**可复跑探针**证明它"真的通"，且探针**禁止假绿**（非空即通过、hash 伪向量当真向量）。

---

## 1. KMD 的关系澄清：它们如何调用、如何闭环

### 1.1 三者定位（一句话区分）

| 系统 | 本质 | 载体 | 关键问题 |
|---|---|---|---|
| **K 知识** | 跨实体的**可复用判定标准** | `crm.particles`（`type='CRM_KNOWLEDGE'`） | "这类情况**一般**怎么判断" |
| **M 记忆** | 单实体的**时序情境** | `crm.memory_log` + `crm.memory_note` | "**这个**客户/商机**具体**发生了什么" |
| **D 决策** | 消费 K+M 并反哺 | `crm.decision` + `crm.decision_outcome` | "结合标准与情境，**现在**该怎么做" |

> 一句话：**K 是"法"，M 是"事"，D 是"断"**。D 读 K 与 M 才不是空想；D 的结果回流 M（情境补全）与 K（沉淀先例），构成自我进化。

### 1.2 八条边闭环模型（调用关系全图）

```
                 ┌─────────────────────────────────────────────┐
                 │                 决策 D (Decision)             │
                 │  crm.decision / decision_outcome             │
                 └─────────┬───────────────────────┬───────────┘
           ③ D→M 写回       │ ① K→D 注入           │ ② M→D 注入
           projectDecision  │ assembler.retrieveL_  │ rrfSearch /
           Memory + append  │ Knowledge→layers.LK   │ retrieveMemory
                 │          │ →injector            │ →layers.L2
                 ▼          ▼                       ▼
        ┌────────────┐  ┌────────────┐      ┌──────────────────┐
        │ M 记忆      │  │ K 知识      │      │ M 记忆(被注入)    │
        │ memory_log │  │ particles  │      │ (请求时读取)      │
        └─────┬──────┘  └─────┬──────┘      └──────────────────┘
              │ ⑧ M→K 升格     │ ④ D→K 回写
              │ tenant_prece-  │ retro 知识
              │ dent(先例)     │ (复盘产出)
              ▼               ▼
        ┌──────────────────────────────────────────────┐
        │  K 知识(扩充)：新增先例/复盘知识               │
        └──────────────────────────────────────────────┘

   ⑤ 结果→D：业务事件(contract_sign) ──outcomeIngester──▶ writeOutcome
   ⑥ 校准触发：writeOutcome emit('decision','outcome-set') ──▶ autoSuggest
   ⑦ 参数生效：校准补丁 approve ──▶ config_store ──▶ loadEngineConf
```

### 1.3 每条边的"代码路径 + 触发时机"（证据级）

| 边 | 从→到 | 经过的真实函数（file:line） | 触发时机 |
|---|---|---|---|
| **① K→D** | 知识→决策上下文 | `assembler.retrieveL_Knowledge` (assembler.js:195) → `buildKnowledgeRows` (:35) → `layers.LK` (:258) → injector 消费 (injector.js:50) | **请求时**（每次组装上下文） |
| **② M→D** | 记忆→决策上下文 | 写入：`capture.js`→`appendMemory` (memoryLog.js:69) / `decisionRepo.appendMemoryLog` (:458)；读取：`rrfSearch` (memoryLog.js:126) / `retrieveMemory` (:93) → `layers.L2.memories` (injector.js:75) | 写=事件/决策发生时；读=请求时 |
| **③ D→M** | 决策→记忆 | `createDecision` (decisionRepo.js:122) → `appendMemoryLog` (:458) → `projectDecisionMemory` (:484) + `resolveEntityAnchor` (:479) → `appendMemory` 四段式 | **决策创建时**（同步） |
| **④ D→K** | 决策→知识(回写) | 复盘/先例产出 `CRM_KNOWLEDGE`（`source LIKE 'retro%'`） | 复盘提交时（当前**未自动**，见 D10） |
| **⑤ 结果→D** | 业务事件→决策结果 | 事件 `decision.contract_sign` → `outcomeIngester.handleBusinessEvent` (outcomeIngester.js:43) → `lookupDecisionByDeal` (:26) → `writeOutcome` (outcome.js:19) | **业务事件到达时** |
| **⑥ 校准触发** | 结果→实时校准 | `writeOutcome` emit `'decision','outcome-set'` (outcome.js:42) → `autoSuggest` 订阅 (D5 实测 `matched=outcome-set`) | writeOutcome 成功时 |
| **⑦ 参数生效** | 校准补丁→参数 | `store.approvePatch` (calibration/store.js:151) → `config_store` → 下次 `loadEngineConf` | **人工审批通过时**（HITL） |
| **⑧ M→K** | 记忆→先例/知识 | 记忆升格 `tenant_precedent`（`source_kind` 含 memory，D7 实测 `total=1, from_memory=1`） | 升格触发时（极少） |

> **关键洞察**：K 与 M 都是"被 D 在请求时消费"的供给层；D 是唯一的"写入发起方"与"回流汇点"。所以**任何一条边断了，最先在探针里暴露的是 D 的供给质量**（D8 记忆可用性、D11 知识投影契约、D3 L1 知识构成）。

---

## 2. 三套系统目前如何构建、何时构建

### 2.1 知识系统（K）

**当前构建方式**
- **存储**：`crm.particles`（`type='CRM_KNOWLEDGE'`），无独立表。65 条存量（prod），`payload` 含 `{kind, term, content}` 等。
- **向量化**：`embedText` (embed.js:23) —— **当前 100% 走 `hash` provider（SHA-256 32 字节指纹）**，`siliconflow` 真实语义向量**尚未实现**（embed.js:47-57 显式降级留痕）。数学指纹判定（D1）：`has_negative=0`、`nonzero≤32` → 全部是 hash 伪向量，**真向量占比 0%**。
- **kind 枚举**：补齐存量后共 6 值：`icp`/`competitors`/`objections`/`buyer_language`（LK 四类销售知识）+ `vocabulary`（词表）+ `transition`（阶段叙事）。

**何时写**
- **播种期（seed）**：DB 种子写入初始 65 条（含 12 条四类销售知识、43 条词表、10 条阶段叙事）。
- **运行时写入**：通过粒子写入动作（particleRepo）创建 `CRM_KNOWLEDGE` 粒子时（如 ④ D→K 复盘产出、后台知识管理 UI）。**写时不触发真实 embedding**（只存 hashVector）。

**何时用**
- **请求时（每次 assembleContext）**：`retrieveL_Knowledge` 按 `intent.scenario` 解析 `kind` 清单 → 查 `CRM_KNOWLEDGE` 已注册行 → `buildKnowledgeRows` 收敛为 `{kind,term,content}` → 进 `layers.LK` → injector 注入 prompt（injector.js:50，截断 TOP N）。

### 2.2 记忆系统（M）

**当前构建方式**
- **存储**：`crm.memory_log`（主）+ `crm.memory_note`（note 通道）。字段含 `topic`/`kind`/`payload`/`entity_id`/`entity_type`/`tenant_id`/`archived`/`ttl_days`。
- **两条写入路径**：
  1. **事件捕获**（主路径）：`capture.js` 按**域名白名单**订阅（`crm/approval/task/particle/payment/alert/calibration/...`，capture.js:16-19）→ `captureMemory`→`appendMemory` (memoryLog.js:69)。**硬闸** `BLOCKED_DOMAINS`（decision/trace/metering/system/memory，:7）防止噪声与自激。
  2. **决策写回**（结构化路径）：`createDecision`→`appendMemoryLog` (decisionRepo.js:458) → `projectDecisionMemory` 四段式（summary/entities/evidence/gaps）+ `resolveEntityAnchor` 锚定实体（:479）→ `appendMemory`。
- **蒸馏**：`distillMemory`（memoryLog.js:274）按 TTL（`created_at < now()-60d`）置 `archived=true`。prod 当前 `archived_biz≈6062`、活跃可注入 `injectable=145`。

**何时写**
- 路径 1：**任意被白名单覆盖的业务事件 emit 时**（实时、持续）。
- 路径 2：**每次决策创建成功时**（同步、确定性）。

**何时用**
- **请求时**：`rrfSearch`/`retrieveMemory`（记忆_log 过滤 `archived=false`）→ `layers.L2.memories` → injector 注入（injector.js:75）。
- **蒸馏/复盘**：归档记忆仍可被（带归档开关的）检索消费；不在活跃供给内。

### 2.3 决策系统（D）

**当前构建方式**
- **存储**：`crm.decision` + `crm.decision_outcome` + `crm.calibration_patch` + `crm.outcome_event_map`。
- **决策创建**：`createDecision` (decisionRepo.js:122)。
- **结果回写**：`writeOutcome` (outcome.js:19)，幂等键 `(decision_id, outcome_type, source)`；成功 emit `outcome-set` 事件（:42）。
- **事件→结果映射**：`outcome_event_map`（`decision.contract_sign → won`，已播种）。

**何时写**
- **决策**：智能体/API 触发 `createDecision` 时。
- **结果**：① 人工/系统直写 `writeOutcome`；② 业务事件经 `outcomeIngester` 自动回写（⑤ 边）。

**何时用**
- **请求时**：决策作为 `layers.L2.decisions` 注入上下文（injector.js:64）。
- **下游**：触发校准（⑥）、回流记忆（③）、回流知识（④）；`decision_outcome.outcome_verified` 回写 `decision` 表单一事实源。

---

## 3. 整体现状（探针实测，2026-09-10 只读巡检）

| 探针 | 边 | 状态 | 关键实测值 |
|---|---|---|---|
| D1 知识向量真伪 | K 构建 | 🔴 FAIL | 真向量占比 **0%**（65/65 全 hash 伪向量） |
| D2 LK 消费者 | ① | 🟢 PASS | lk_consumers=4 |
| D3 L1 知识构成 | ① | 🟢 PASS | 已注册知识占 L1 池 14.71% |
| D4 outcome 真实性 | ⑤ | 🔴 FAIL | 真自动回写 **0**（4 条全 seed-script；`event_rules=1,enabled=1` 机制已就位） |
| D5 校准事件契约 | ⑥ | 🟢 PASS | 订阅∩emit `matched=outcome-set` |
| D6 校准补丁积压 | ⑦ | 🔴 FAIL | PENDING=**60**，最老 5.2 天（HITL 治理缺口） |
| D7 M→K 升格 | ⑧ | 🟢 PASS | total=1, from_memory=1 |
| D8 记忆可用性 | ② | 🟢 PASS | 活跃可注入 145、锚定 54（绝对数口径） |
| D9 噪声源排行 | M 构建 | 🟡 WARN | 24h 1567 行，`llm-metering-missing-tenant` 占 64.77%（04:42 前残留，近 60m=0） |
| D10 D→K 回写 | ④ | 🟡 WARN | retro 知识 **0** 条（回写路径存在未走通） |
| D11 知识投影契约 | K 构建 | 🟡 WARN | 匹配率 18.46%（12/65；vocabulary/transition 本就在契约外） |
| D13 噪声闸门回归 | M 构建 | 🟢 PASS | on(*) 已除、BLOCKED 硬闸生效、近 60m trace=0 |

**汇总：🟢6 🔴3 🟡3 ⚪2（D12/E2E 行为级需 `--e2e --db=test`）。**

---

## 4. 整体解决方案：三系统如何写 / 何时写 / 如何用 / 何时用

### 4.1 知识系统

| 维度 | 规范 |
|---|---|
| **怎么写（契约）** | `payload` 必须含 `{kind, term, content}`，`kind` 取枚举 6 值之一（LK 四类销售知识须有 `content` 正文，否则 LK 投影成空壳→D11）。写时 `embedText` 走 `hash`（**暂不接受"语义已就绪"的假绿**）。 |
| **何时写** | ① 种子/后台知识管理 UI 创建 `CRM_KNOWLEDGE` 粒子时；② ④ D→K 复盘提交时（目前人工，未来自动化）。**禁止在请求时动态写知识**（会让"法"随"事"漂移）。 |
| **怎么用** | 请求时由 `assembler.retrieveL_Knowledge` 按场景 `kind` 拉取 → `buildKnowledgeRows` → `layers.LK`。 |
| **何时用** | 每次决策/对话上下文组装时（与具体实体无关，是"通用判据"注入）。 |
| **红线** | 不新增粒子类型承载知识；真 embedding 接入前（P1-1）**不得声称"语义检索已落地"**（D1 未绿即禁）。 |

### 4.2 记忆系统

| 维度 | 规范 |
|---|---|
| **怎么写** | 两条路径：① 事件捕获（`capture.js` 白名单域 → `appendMemory`，须过 `judgeWorthiness` 与租户/实体锚定）；② 决策写回（`appendMemoryLog` → 四段式 `projectDecisionMemory` + `resolveEntityAnchor` 实体锚）。**错锚比无锚更危险**：锚点无法确定时诚实留 NULL（memoryLog.js:59）。 |
| **何时写** | 路径①：业务事件实时；路径②：决策创建同步。 |
| **怎么用** | 请求时 `rrfSearch`（dense hashVector 余弦 + sparse LIKE 双路 RRF 融合，memoryLog.js:126）或 `retrieveMemory` → `layers.L2.memories`。 |
| **何时用** | 需要"这个客户/商机具体发生过什么"时（叙事、历史决策、相关事件）。 |
| **红线** | `archived` 软删，**绝对禁 DELETE**；噪声域（trace/metering/decision/memory/system）永不被捕获（D13 三关锁死）；蒸馏按 TTL 归档而非删除。 |

### 4.3 决策系统

| 维度 | 规范 |
|---|---|
| **怎么写** | `createDecision` 建决策；`writeOutcome` 回写结果（**必须带 source**，`event:*` 为真自动、人工/`seed-script` 单列，D4 三分类）。`writeOutcome` 后必 emit `outcome-set`（⑥ 通电）。 |
| **何时写** | 智能体/API 决策时；业务事件经 `outcomeIngester` 自动回流时（⑤）。 |
| **怎么用** | 作为 `layers.L2.decisions` 注入；驱动校准（⑥）、回流记忆（③）、回流知识（④）；`outcome_verified` 单一事实源。 |
| **何时用** | 决策执行后即时写入；结果在业务事件发生即时回流（不依赖夜间批量）。 |
| **红线** | 校准补丁**必须经管理员审批流**落地（⑦，HITL）——`approvePatch` 走第 0 闸真实决策行，**系统永不自动改参数**。 |

---

## 5. 闭环如何检查（不是"跑个全绿脚本"，而是"每条边可证伪"）

### 5.1 探针体系（13 + 1，可复跑，可入 CI）

`scripts/kmd-closure-probe.mjs` 每条探针对应一条/一组边，**退出码有 FAIL/ERROR 即 1**（CI 可拦截）：

| 探针 | 证伪的是什么 |
|---|---|
| D1 | 知识向量是不是真语义向量（hash 伪向量鉴别力） |
| D2/D3 | K→D 是否通（LK 有无消费者 / L1 知识占比） |
| D4 | ⑤ 边业务结果是否真回流（seed 不混入真自动） |
| D5 | ⑥ 校准事件契约是否对得上（订阅∩emit 交集） |
| D6 | ⑦ 参数是否积压未消费 |
| D7 | ⑧ M→K 升格是否通电 |
| D8 | ② 记忆是否真可用（绝对数：活跃可注入+锚定） |
| D9 | M 构建噪声是否失控 |
| D10 | ④ D→K 回写是否走通 |
| D11 | K 写入契约是否匹配 LK 投影 |
| D13 | 噪声闸门是否复活（on(*)/BLOCKED 泄漏/实时 trace） |
| D12/E2E | ⑤+⑥ 行为级（写类，需 `--e2e --db=test` 闸门） |

### 5.2 反假绿三铁律（探针自身不可骗人）
1. **必须自证鉴别力**：每条探针配 `negativeControl`（`--self-test` 跑），注入必红/必绿反例验证不会恒绿。
2. **禁"非空即通过"**：`count>0` 就绿的判据必须配对照（如 D4 三分类、D1 数学指纹）。
3. **只读优先**：默认纯读；写操作仅 `--e2e --db=test`，绝不碰生产。

### 5.3 持续可观测
- **每晚 10 点例行自动化第⑦项**：自动跑 `probe:kmd`（`--json` 落盘），D6 报警时附带 `calibration-triage.mjs` 分级待办清单，使"报警"变"可消项"。
- **烽火台**：D1/D4/D6/D13 任一 🔴 即在 nightly 报告高亮。

---

## 6. 如何修补：发现 → 诊断 → 修复 → 验证（范式）

### 6.1 通用四步范式
1. **发现**：探针 🔴/🟡，或从 nightly 报告看到异常。
2. **诊断（证据级）**：先定"是代码断点还是治理缺口"——查该边经过的真实函数（见 1.3 表）+ 直查库确认（如 D6 查 `calibration_patch` 状态分布、谁在消费）。**绝不凭直觉改代码**。
3. **修复**：
   - 代码断点 → 改对应函数（如 P0-1 injector 消费 LK、P0-2 注册 outcomeIngester + 补 deal 反查、P0-3 emit outcome-set、P0-4 四段式 + 补 entity_type 列、P0-5 捕获白名单硬闸、P0-6 embed 降级留痕）。
   - **治理缺口（非代码）** → 提供审阅工具 + SLA，**绝不自动应用**（如 D6 校准积压：`calibration-triage.mjs` 分级清单 + 人工 `POST /api/calibration/patches/:id/approve`）。
4. **验证**：重跑探针（含 `--self-test`）+ 行为级 D12/E2E（测试库）+ 刷新 `artifacts/kmd-probe-*.json`。

### 6.2 已收口的 P0 修复（证据）
| 项 | 边 | 修复 | 验证 |
|---|---|---|---|
| P0-1 | ① | injector 消费 `layers.LK`（injector.js:50） | E2E 哨兵 `in_prompt=true` |
| P0-2 | ⑤ | 注册 outcomeIngester + `lookupDecisionByDeal` 补 deal 反查（outcomeIngester.js:26,82） | D12 `written_rows=1,outcome_found=1` |
| P0-3 | ⑥ | `writeOutcome` emit `outcome-set`（outcome.js:42） | D5 `matched=outcome-set` |
| P0-4 | ③ | 四段式投影 + `resolveEntityAnchor` + 补 `entity_type` 列（决策记忆写回 C1/C2） | D8 绝对数 PASS（injectable=145） |
| P0-5 | M 构建 | `capture.js` 白名单 + `BLOCKED_DOMAINS` 硬闸（禁 `on(*)`） | D13 三关全过，近 60m trace=0 |
| P0-6 | K 构建 | `embed.js` siliconflow 降级显式留痕（禁假绿标志位） | D1 如实报 0% 而非假绿 |

### 6.3 修复纪律（项目铁律）
- **迁移单一事实源**：手动改生产库后必须注册进 `db/migrate.js` 的 `INCREMENTAL_SQL`（已注册 `2026-09-10-memory-entity-type.sql` + `migrate-knowledge-kind-backfill.sql` + `seed-outcome-event-map.sql`），否则部署漂移。
- **禁 DELETE**：记忆/知识清理一律 `archived` 软删。
- **HITL**：写类/参数变更经第 0 闸 + 显式授权，AI 不代执行。
- **提交卫生**：每 Task 一 commit，显式路径 add，**禁 `git add -A`**。

---

## 7. 当前遗留与路线图

| 项 | 性质 | 处置 |
|---|---|---|
| **D1** 真向量 0% | 延期（P1-1） | 接入 siliconflow 真实语义向量，实现前**禁称语义检索已落地**；切换前跑 `compareRecall` A/B |
| **D4** 真自动回写 0 | 非缺陷 | 机制已证（D12）；待真实 `contract_sign` 业务事件流过即转绿 |
| **D6** 校准积压 60 | HITL 治理 | `calibration-triage.mjs` 审阅工具就位；人工按 risk 分级消项（LOW 21/MEDIUM 29/HIGH 10） |
| **D9** 噪声 64.77% | 自愈 | 24h 窗口仍含 04:42 前旧风暴；近 60m=0，窗口越过即转绿 |
| **D10** retro 知识 0 | 功能缺口 | 复盘结论自动落知识（免人工）排 P1 |
| **D11** 匹配率 18.46% | 诚实值 | 53 条 vocabulary/transition 本就在 LK 四类的契约外；如需全匹配需调整 LK 投影或重分类 |

---

## 8. 一句话交付

**K=法，M=事，D=断；D 在请求时消费 K 与 M，并把决策/结果/参数回流二者，形成八条边闭环。闭环已接通，剩余 🔴 均为已知延期/治理项；闭环健康度由 13+1 可证伪探针 + 每晚第⑦项观测持续守护，修复严守"迁移单一事实源、禁 DELETE、HITL、禁假绿"四铁律。**
