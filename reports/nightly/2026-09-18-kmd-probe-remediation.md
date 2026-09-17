# KMD 闭环探针问题整改方案（2026-09-18）

> 输入证据：`artifacts/kmd-probe-2026-09-17.json`（🟢6 🔴3 🟡3 ⚪2）、`artifacts/calibration-triage-2026-09-17.json`
> 追加证据：D12 E2E 实测（2026-09-18 06:59）、生产库只读对比、源码锚点核对

## 0. 结论先行

6 项问题**分三类**，解法重心完全不同：

| 类别 | 探针 | 性质 | 一句话根因 | 解法重心 |
| --- | --- | --- | --- | --- |
| **A 假红（环境/基线漂移）** | D1、D4 | 非代码缺陷 | 本机开发库迁移/种子执行不完整 + 触发源未产生 | 本机环境对齐、口径修正 |
| **B 判据错配（探针自身缺陷）** | D11、D9 | 指标不可鉴别 | 分母混入本体登记物 / 状态型重复被当噪声 | **改探针 + 成对反向断言** |
| **C 治理（链路通、无人消费）** | D6、D10 | 运营缺口 | 审批/复盘回路从未被真实使用 | SLA + 运营启动 |

**核心判断**：经 D12 行为级 E2E 实证（🟢 `written_rows=1`），**KMD 闭环的边在代码层是通的**；本次 3 条 🔴 中 **2 条为假红**（D1/D4），**1 条为治理**（D6）。真正需要改代码的只有 D11/D9 的**探针口径与写入抑制**。

---

## 1. 决定性证据：本机开发库 vs 生产库

| 项 | 本机开发库 | 生产库 | 证据来源 |
| --- | --- | --- | --- |
| `crm.particles.embedding` 列类型 | **vector(384)** | **vector(1024)** | `pg_attribute` 查询 |
| CRM_KNOWLEDGE 向量 | 69 条，dim=384，**69/69 hash 指纹** | 19 条，dim=1024，**hash_sig=0（真向量）** | 同 D1 探针 SQL |
| `EMBEDDING_PROVIDER` | **未设置** | **model** | `.env` 对比 |
| `crm.outcome_event_map` 规则 | **1 条** | **4 条** | SQL count |
| `crm.calibration_patch` PENDING | **71** | **1** | SQL count |
| `crm.decision_outcome` | 4（全 seed-script） | **0** | SQL count |
| `crm.decision_provenance` source=retro | **0** | — | SQL count |

> **结构性发现**：本机开发库的「迁移 + 种子」执行不完整（列 384≠1024、规则 1≠4），而探针默认连本机开发库 ⇒ **每晚必然红，长期将训练出告警疲劳**。

---

## 2. 逐条根因链与解法

### D1 知识向量真伪 🔴 —— 假红（环境落差）

**根因链**：
1. `src/ontology/hooks.js:10-25`：`EMBEDDING_PROVIDER !== 'model'` 时**写 NULL**（不写 hash，因 hash 384 维存不进 vector(1024) 列）；
2. 本机库列仍是 **vector(384)**（未执行 `db/migration-2026-09-14-particles-embedding-1024.sql`），故 69 条 hash 向量以旧列形态残留；
3. 本机 `.env` 未设 `EMBEDDING_PROVIDER=model`；
4. **代码链路已就位**：`src/llm/embeddingClient.js` 已实现真实 SiliconFlow `/v1/embeddings` 调用，**生产 19/19 真向量即活证**。

**解法（本机对齐，P0）**：
1. `.env` 增 `EMBEDDING_PROVIDER=model`、`EMBEDDING_MODEL=BAAI/bge-large-zh-v1.5`（llm_config 须有 api_key）；
2. 执行 `db/migration-2026-09-14-particles-embedding-1024.sql`（384→1024，`USING NULL` **清空现有 hash 向量值**——设计意图，防假绿）；
3. 回填：将 69 条 `content_hash` 置 NULL 触发 `ensureEmbedding` 重嵌；
4. 复跑 D1 → 预期 PASS（对照生产 hash_sig=0）。

⚠ **只在开发库操作，绝不碰生产**（生产已是正确态）。

---

### D4 结果自动回流 🔴 —— 假红（触发源未产生）

**根因链（逐环核实）**：
1. 订阅器已注册：`src/http/server.js:33,92`（import + 启动调用均到位）；
2. 规则 matcher 与事件 payload **形状匹配**：`src/action/seed-actions.js:1088/1250` 的 `deal-archive`/`quote-create` 事件确实携带 `decision_id`，`contract_sign` 经 `deal_id_field` 反查；
3. **行为级证明**：D12 E2E 🟢 `picked_decision_id=5a234b9b… written_rows=1` ⇒ ⑤ 边（结果回流）+ ⑥ 边（emit `outcome-set`）**均接通**；
4. ⇒ 唯一解释：**真实业务动作（合同签署/商机归档/报价创建）在生产与开发库都未发生**（`decision_outcome` 中 source 无 `event:` 前缀行）。

**解法（P0 定性、P1 运营）**：
1. **不再把 D4 当缺陷修代码**；将 D4 口径改为**双指标**：`E2E 链路可通（D12）` **且** `真实回流量（生产 monitor 计数）`，避免"链路通但无业务量"被误读为断链；
2. 补本机缺失的 3 条种子：`db/seed-outcome-event-map-2026-09-14.sql`（本机 1 条 vs 生产 4 条）；
3. 运营侧：推动一次**真实合同签署**（或演练环境等价动作）以产生首个 `event:decision.contract_sign` 回流样本。

---

### D6 校准补丁积压 🔴 —— 治理（无人消费）

**根因链**：技术链路**完全完备**——
- 审批端点：`src/http/calibrationRouter.js:220`（`POST /api/calibration/patches/:id/approve`）、`:231` reject、`:242` rollback；
- MCP 处方签批：`src/action/seed-actions.js:2109`（`tune-approve` / `tune-reject`，仅 sysadmin）；
- 积压本质：**产出速率 > 人工审批速率**。

**规模校正**：本机 71 条（最老 12.3 天）vs **生产仅 1 条** ⇒ 严重性在开发库被显著放大；生产风险等级低。

**解法（P1 治理，禁止自动应用）**：
1. 定 **审批 SLA**：PENDING 超 7 天升级至管理员看板（探针 D6 判据已是 `>7 天 FAIL`，需在运营侧接看板提醒）；
2. 本机 71 条按 `artifacts/calibration-triage-2026-09-17.json` 分级批量审阅（LOW 29 / MEDIUM 32 / HIGH 10；knob 分布：required_dims 16、edge_binding 15、source_refresh 15、config_store 7、meta_attr_map 6、particle_attr_add 5、threshold 5）；
3. ⚠ 本机 71 条系开发库自造实验数据，**批量批准会污染本机配置基线** —— 建议本机按实验数据处理（批量 reject 或留档），生产按 SLA 正常审。

---

### D9 噪声源排行 🟡 —— 判据量化口径偏差

**根因链**：
1. 噪声源 `visit_shortfall` 来自 `src/scheduler/salesDailyScan.js:129`（巡检直写状态信号）；
2. 每租户 × 每 owner × 每日 **daily + weekly 两条**；实测 1494 ≈ 15 租户 × 50 owner × 2 ⇒ **属业务预期量级，非风暴**；
3. 已有 `dedup_key: visit_shortfall:${tag}:daily|weekly`（signal 侧去重），但**记忆侧无抑制**；
4. 关键：`grep visit_shortfall src/memory src/context src/knowledge` **零命中** ⇒ 该类记忆**不参与推理检索**，属"表膨胀"而非"语义污染"；
5. 生产同形态：24h 158 行，`visit_shortfall` 占 66%（与开发库 65% 一致）。

**解法（P1）**：
1. **记忆写入侧抑制**：对带 `dedup_key` 的状态型信号，同 key 在窗口期内不重复写记忆（或仅写"状态变更"边沿）；
2. **探针加绝对量门**：D9 判据由"单一类型占比 >80%"改为"**占比 >80% 且 24h 总量 >5000**"双门，消除正常量级误报。

---

### D10 D→K 回写 🟡 —— 假红（回路从未被使用）

**根因链**：
1. C4 知识回写**代码存在**：`src/decision/closureLoop.js:199-212` → `createParticle('CRM_KNOWLEDGE', { source: 'retro_' + outcome_type, … })`；
2. 但 `crm.decision_provenance` 中 `source='retro'` **行数 = 0** ⇒ **`submitRetro` 从未被调用**（本机开发库从未提交过复盘）；
3. `knowledge-c4-skip` 事件也 0 行 ⇒ 连 C4 分支都未进入（`knowledge_particles` 为空时提前返回）；
4. ⇒ **D10 是"回路建好但无人使用"，非"回写路径断"**。

**附带缺陷（P2，同族于"拒因不得被中间层吞掉"）**：
`closureLoop.js:~197` 的租户解析失败分支仅 `emit('trace','knowledge-c4-skip')`，而 `trace` 域被 `src/memory/capture.js:7 BLOCKED_DOMAINS` 挡在记忆之外 ⇒ **跳过原因在生产几乎不可观测**。建议改为 `monitor.recordFailure` 或写可观测面。

**解法（P1 运营 + P2 可观测）**：
1. 提交一次真实复盘（`submitRetro`）即可验证 D10 转 🟢；
2. 若设计目标是"免人工自动落知识"，则需走 brainstorming 定调后实现（属新功能，不在本次整改范围）。

---

### D11 知识投影契约 🟡 —— 判据错配（分母污染）

**根因链（payload 实证）**：

| kind | 条数 | payload 键 | 是否有 content |
| --- | --- | --- | --- |
| `vocabulary` | **43** | `kind, layer, term, type` | ❌ 设计如此（本体词汇表登记物） |
| `transition` | 10 | `kind, term, content` | ✅ |
| `icp`/`competitors`/`objections`/`buyer_language` | **16** | `confidence, content, kind, source, tags, term` | ✅ **16/16 全有 content** |

`probeD11` 的 KINDS 限定为四大类（探针 `scripts/kmd-closure-probe.mjs:474`），但**分母取了全部 CRM_KNOWLEDGE**（含 43 条本体登记物）⇒ 比率上限被结构性压至 16/69 = 23.19%。

⇒ **真实业务知识契约 16/16 = 100% 合格**；D11 的 WARN 是**分母污染**，非知识内容缺失。

**解法（P1，必须成对）**：
1. **分母修正**：`WHERE type='CRM_KNOWLEDGE' AND (payload ? 'content' OR payload->>'kind' = ANY(四大类))`；
2. **⚠ 成对反向断言**（防"改分母造绿"）：
   ```sql
   -- kind='vocabulary' 且带 content 的行数必须为 0，否则报警（本体登记物不得混入知识契约）
   SELECT count(*) FROM crm.particles
    WHERE type='CRM_KNOWLEDGE' AND payload->>'kind'='vocabulary' AND payload ? 'content';
   ```
3. 备选（需设计批准，触及业务域模型）：将 vocabulary/transition 改用独立 `payload.scope='ontology'` 标记或独立粒子类型。

---

## 3. 元问题（比单条探针更重要）

### M1 探针数据源口径（P0）
探针默认连**本机开发库**，而该库迁移/种子执行不完整 ⇒ D1/D4 类判据**每晚必红**。建议二选一：
- **(a)** nightly 只读巡检默认连**生产库**，另设一条"开发库基线漂移"独立探针；
- **(b)** 保留开发库口径，但**前置一条 schema/seed 漂移检测**（对比列类型、规则数、种子行数），漂移时**降级为 INFO 而非 FAIL**。

> 依据：`crm.particles.embedding` 列类型与 `outcome_event_map` 规则数是**基线差异**，与"闭环健康度"是两个正交维度，混在同一张红绿表里会互相污染语义。

### M2 静默跳过不可观测（P2）
`closureLoop.js:~197`（C4 租户解析失败）、`outcomeIngester.js:60`（无法关联决策即 continue）均以静默/Trace 方式跳过 —— 与"拒因必须回传"铁律同族，建议统一改为可观测失败面。

---

## 4. 建议执行顺序

| 优先级 | 动作 | 性质 | 需批准 |
| --- | --- | --- | --- |
| **P0-1** | 本机 `.env` 配 `EMBEDDING_PROVIDER=model` + 执行 1024 列迁移 + 重嵌回填 | DB/环境写 | ✅ 需批准（丢失 69 条 hash 向量值） |
| **P0-2** | D4 口径改双指标（D12 链路 + 生产真实回流量） | 探针脚本 | ✅ 需批准 |
| **P0-3** | M1 探针数据源口径裁决（生产 vs 开发库 + 漂移探针） | 探针脚本 | ✅ 需批准 |
| **P1-1** | D11 分母修正 + 成对反向断言 | 探针脚本 | ✅ 需批准 |
| **P1-2** | D9 记忆写入抑制 + 判据加绝对量门 | 代码/脚本 | ✅ 需批准 |
| **P1-3** | 本机补 `seed-outcome-event-map-2026-09-14.sql`（1→4 条规则） | DB 种子 | ✅ 需批准 |
| **P1-4** | D6 审批 SLA + todo 看板 + 71 条分级审阅（HITL，绝不自动应用） | 运营 | ✅ 需人工 |
| **P2-1** | D10 可观测化（C4 skip 落 monitor） | 代码 | ✅ 需批准 |
| **P2-2** | 复盘→知识自动化（若设计确认） | 新功能 | 需 brainstorming |

**无需改动**：D2/D3/D5/D7/D8/D13（🟢）；D12 已由本次 E2E 实测确认 🟢。

---

## 5. 红线（不可做）

- ⛔ **不得为让探针变绿而调低阈值/放宽分母而不加反向断言**（"把指标做绿"是本项目头号假绿形态）；
- ⛔ **不得在生产库执行任何写操作**（本方案 P0-1 仅限开发库）；
- ⛔ **不得自动应用校准补丁**（D6 全部须经 HITL 审批流）；
- ⛔ **不得在开发库批量批准 71 条 PENDING**（会污染本机配置基线，属实验数据）；
- ⛔ 迁移 `USING NULL` 会清空既有向量值，执行前须明示确认（行数据不删除，仅向量列置空）。
