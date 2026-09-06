# P0 决策完整性实施计划（H1 哈希链 / H2 阈值版本固化 / H3 先例四分量加权）

> 上游设计：`docs/2026-09-03-lightfield-semantica-decision-analysis.md`（§3 借鉴方案 P0 三项）
> 生成时间：2026-09-03
> 状态：**待批准**——本轮仅产出计划，未写实现代码（HARD-GATE 设计先行）
> 证据纪律：所有结论带 `file:line`，判定块独立成节；无证据不写结论

---

## §0 取证摘要：三项缺口中两项的"已知判断"被推翻

写计划前做了代码级 + 实验级取证，结论**推翻了前序分析的两处归因**。这是本计划最需要先看的章节。

| 项 | 前序判断 | 取证后真相 | 证据 |
|---|---|---|---|
| **H1 哈希链** | "缺哈希链，需新建" | ❌ **代码已完备**（shaChain/trackEntry/verifyChain/exportTurtle 全在），但**表从未建、生产 100% 失败** | `provenance.js:37/44/61`；`assembleContextV2.js:291-292` 注释自陈 |
| **H2 阈值固化** | "缺版本固化，需新建" | ❌ **表与列都已存在**，但**生产零写入**（policy_version 0 行，effective_policy_version 恒 null） | `schema.sql:139/156`；全仓 `policy_version` 写入仅 2 处 e2e 伪造 |
| **H3 先例检索** | "S2 0 hit 是 L0 数据真空" | ❌ **结构性算法缺陷**：embedding 与 qvec 都是哈希伪向量，语义相近样本 cos≈0.115，**过 0.6 闸仅 1/200** | 实验见 §3.3（可复现） |

**因此 P0 三项都不是"从零新建"，而是"已建但从未真正生效"——即三处已存在的假绿。** 这改变了任务性质：工作量比预估小，但必须先做"接通 + 止住静默失败"，而不是重写。

---

## §1 H1：决策轨迹哈希链 —— 代码完备但生产 100% 失败

### §1.1 现状证据

**代码完备度（与 Semantica 同构，且已规避了 Semantica 的坑）：**

| 能力 | 位置 | 说明 |
|---|---|---|
| SHA-256 链式校验和 | `provenance.js:37 shaChain()` | `(prev \|\| '') + '\|' + canonical(payload)` |
| canonical 深度键排序 | `provenance.js:27-34 sortKeys/canonical` | **已规避 jsonb 键序漂移导致 verifyChain 误报 TAMPERED** |
| append-only 追加 | `provenance.js:44 trackEntry()` | 取同决策 id 最大者的 checksum 作 previous |
| 整链重算校验 | `provenance.js:61 verifyChain()` | 逐项比对，返回 `{status:'TAMPERED', broken_at}` |
| 墓碑不物理删除 | `provenance.js:19/117` | `invalidated` + `applyArchival`，对齐 Semantica never hard delete |
| PROV-O 导出 | `provenance.js:95 exportTurtle()` | W3C 三元组 |

**判定：实现质量高于预期，canonical 排序一项甚至优于 Semantica（Semantica 未处理 jsonb 键序）。**

### §1.2 三处致命缺口

**缺口 ①：表从未建立（生产 100% 失败的根因）**

```
ensureProvenanceSchema() 调用点全仓检索：
  src/decision/provenance.js:9   ← 仅定义处
  （生产代码 0 处调用）
```

`assembleContextV2.js:291-292` 的注释**自陈了这一事实**：

> 表缺失（**DDL 未入 schema.sql**，ensureProvenanceSchema 仅测试调用）而 **100% 抛 relation does not exist**

后果：`trackEntry` 的 9 处调用（`assembleContextV2.js:207/217/295/308`、`closureLoop.js:104/131/203/251`、`decisionRepo.js:300`）在生产环境**全部失败**。

**缺口 ②：失败已留痕但根因未修（半截状态）**

`assembleContextV2.js:294-303` 已把裸 `.catch(()=>{})` 改为 `emit('trace','provenance-track-failed')` + `recordFailure()`——符合"禁裸 catch"铁律，**留痕到位但根因（无表）未修**。当前生产处于"每条决策稳定产生 N 条 provenance-track-failed 失败记录"的状态，属于**已知但不修的持续报错**，比静默失败更该优先处理。

**缺口 ③：链建了但永不校验**

```
verifyChain() 调用点全仓检索：0 处
```

即"能防篡改"的能力存在，但**没有任何代码路径触发校验**——等价于装了烟雾报警器但没通电。

**缺口 ④（次级）：decision_event 不在链上**

`recordDecisionEvent`（`decisionRepo.js:447`）有 **20+ 处调用点**（config_change / agent_dispatch / required / autonomous / escalated / made / human-disposition 等），写入 `crm.decision_event` 表——**该表无任何哈希字段，完全在链外**。Semantica 的做法是把 6 类事件全部纳入不可变追踪。

### §1.3 哈希字段白名单（前序标注的"必须先定死的前置决策"）

`shaChain` 当前只哈希 `payload`（`provenance.js:39`），**以下列不进哈希、篡改不可检测**：

| 列 | 是否进哈希 | 风险 | 处置建议 |
|---|---|---|---|
| `payload` | ✅ 进 | — | 保持 |
| `previous_checksum` | ✅ 进（作为前缀） | — | 保持；**跨决策剪切条目会因下一条 previous 不匹配而被检出** |
| `decision_id` | ❌ 不进 | 单条 entry 被搬到另一决策下——但若只搬一条，后续链会断，**可检出** | 保持不进（进哈希会与 Semantica 一样误伤合法重命名） |
| `entry_type` | ❌ 不进 | ⚠️ **篡改 entry_type 不可检出** | **建议纳入**（值域稳定，无重命名风险） |
| `source` | ❌ 不进 | ⚠️ 篡改来源（粒子/事件/Agent）不可检出 | 建议纳入 payload 或哈希 |
| `activity_id` | ❌ 不进 | ⚠️ 篡改流程归属不可检出 | 建议纳入 payload 或哈希 |
| `invalidated` | ❌ 不进（且 verifyChain 不读） | ⚠️ **墓碑标记可任意翻转而不触发 TAMPERED** | **建议纳入哈希**（否则擦除行为本身不可审计） |
| `archived` | ❌ 不进 | 同 invalidated | 建议纳入 |
| `id` / `created_at` | ❌ 不进 | 序列/时间戳，无审计价值 | 保持不进 |

**提案（待您裁决）**：哈希输入从 `payload` 扩展为 `{entry_type, payload, invalidated, archived}`，`source`/`activity_id` 移入 payload 一并哈希。**参考 Semantica 教训：`integrity.py:45-51` 故意排除 `entity_id` 是因为版本化会重命名存档（`X`→`X:v:...`），我们这里没有该机制，故无需排除 decision_id 之外的标识列。**

### §1.4 Task 分解

**T1 — DDL 归位 + 生产建表（根因修复）**
1. 把 `crm.decision_provenance` 完整 DDL 写入 `db/schema.sql`（**DDL 单一事实源铁律**：`ensure*()` 仅兼容补列）
2. 同步 `db/migrate.js`：新建库由 schema 建；既有库走 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` 补 `invalidated`/`archived`
3. 校验：直查生产 `information_schema.columns`（**测试全绿 ≠ 生产可用**铁律，必须 information_schema 实证）
4. 预期效果：9 处 `trackEntry` 由 100% 失败转为成功，`provenance-track-failed` 归零

**T2 — verifyChain 接线（让链真正可验）**
1. 自检卡扩 Q8：`GET /api/decision/:id/selfcheck` 增加链校验结果（现 Q1–Q7）
2. 新增 `GET /api/decision/:id/provenance` 返回 `{status, entries, broken_at}`
3. 接 `src/scheduler/timers.js`：纳入既有的 ready-queue-pump 同批定时巡检（复用已建好的 pump 骨架，不新增定时器）

**T3 — decision_event 入链（对齐 Semantica 6 类事件）**
1. `decision_event` 加 `event_index/prev_hash/event_hash` 三列（**仅增量**，历史行留 null 且校验时跳过，不做回填以免伪造链）
2. `recordDecisionEvent` 改为链式写入（单一写入点，20+ 调用方零改动）
3. 提供 `verifyEventChain({decision_id})`

> ⚠️ T3 是三项中唯一涉及新列的，若您希望 P0 只做"止血"，T3 可延后到 P1。**建议保留在 P0**——否则 config_change 这类高价值审计事件仍在链外。

**T4 — 测试**
- `test/decision/provenanceChain.test.js`：建表幂等 / trackEntry 链式串接 / 篡改 payload 检出 TAMPERED / 删中间行检出断链 / 墓碑翻转检出（T1 白名单生效后）
- **隔离**：`crm.decision_provenance` 被 `decision_id` FK 引用，清理须先删子表（对齐 `test/calibration/replayDims.test.js` 的 `purgeScenarioDecisions()` 范式）
- 跑 `npm run audit:isolation` 确认基线不劣化（基线 339 文件 / 68 DELETE / 🔴0）

---

## §2 H2：阈值版本固化 —— 表与列都在，但生产零写入

### §2.1 现状证据

**Schema 已完备：**
- `crm.policy_version`（`schema.sql:139-147`）：`policy_version_id / policy_id / version / effective_from / effective_to / snapshot JSONB`
- `crm.decision.effective_policy_version`（`schema.sql:156`）：**FK REFERENCES crm.policy_version**
- 索引已建：`idx_crm_decision_policy`（`schema.sql:232`）

**代码完全没接线：**
```
policy_version 写入点（INSERT/UPSERT/CREATE）全仓检索：0 处
  —— 仅 e2e 脚本伪造：
     scripts/e2e-decision-deep-test.mjs:574  INSERT ... 'pv-e2e-test'
     scripts/e2e-decision-deep-probe3.mjs:18 INSERT ... 'pv-test-001'

requireDecision 取值为 opts.policy_version || null（autonomyEngine.js:274/303）
  —— 生产 18 处调用方（seed-actions.js:609/699/738/785/1091、routes.js:491、
     configRouter.js:27 等）无一传该参数 → 恒 null
```

### §2.2 判定

**这是典型的"schema 有、代码没接线"假绿**：FK 约束存在（意味着写入会被强校验，不会脏），但没有任何代码路径写入 → `crm.policy_version` **恒 0 行**，所有决策的 `effective_policy_version` **恒 null**。

**业务后果**：Semantica `apply_policies:226-238` 的核心价值是"决策时锁定 `r.policy_version`，事后策略改版不影响历史判定"。我们做不到——**改一次 `config_store['sales-thresholds']` 阈值，所有历史决策的判定依据就被洗掉**，无法回答"这条决策当时是按哪个阈值判的"。

### §2.3 Task 分解

**T5 — 阈值快照冻结**
1. 新增 `capturePolicySnapshot()`（建议落 `src/decision/policySnapshot.js`）：
   - 入参：本次决策实际消费的阈值集合（从 `readConfig('sales-thresholds')` 取，**且只取本次用到的路径**，不是全量 dump）
   - 计算 `contentHash(snapshot)` → 作为 `policy_version_id`（幂等：同内容同 id，`ON CONFLICT DO NOTHING`）
   - `INSERT INTO crm.policy_version (policy_version_id, policy_id, version, effective_from, snapshot)`
2. `requireDecision` 在落库前调用，把得到的 id 填进 `opts.policy_version`（**autonomyEngine.js:274/303 两处赋值点，18 个调用方零改动**）
3. `version` 语义：按 `policy_id` 内自增（`SELECT max(version)+1`），`effective_to` 在写新版本时封口上一版

**T6 — 快照口径（关键设计决策，需您裁决）**

| 方案 | 口径 | 优点 | 缺点 |
|---|---|---|---|
| **A（推荐）** | 冻结**本次决策实际读取的阈值路径**子集 | 快照小、语义准（"影响这条决策的就是这些"） | 需在 `readThreshold` 埋点收集路径 |
| B | 冻结 `sales-thresholds` 全量 | 实现最简（一次 dump） | 快照含无关阈值，改一个不相关阈值也会产生新版本，噪声大 |
| C | 冻结全量 + 记录实际使用路径 | 信息最全 | 复杂度最高 |

**推荐 A**，但需一个埋点：让 `readThreshold`（`salesThresholds.js:85`）可选地记录被读取的路径到 `ctx`。**若您认为侵入性过高，退 B 也可接受**——B 仍能解决"历史判定依据被洗掉"的核心问题。

**T7 — 测试**
- `test/decision/policySnapshot.test.js`：同内容幂等（两次调用同 id）/ 内容变则版本自增 / 上一版 effective_to 封口 / requireDecision 落库后 `effective_policy_version` 非空
- **回归口径**：现有 281/281 决策回归必须保持绿（T5 是新增列值，不改判定逻辑）

---

## §3 H3：先例四分量加权 —— 真根因是哈希伪向量，不是数据真空

### §3.1 现状证据

`searchPrecedents`（`decisionRepo.js:429-444`）为**单分量**检索：

```sql
1 - (embedding <=> $2::vector) AS similarity
WHERE scenario_id=$1 AND state IN ('CONFIRMED','AUTONOMOUS')
```

调用点两处，阈值不同：
- `autonomyEngine.js:201`：`k=5`，**minSimilarity 默认 0**（不过滤，取最不烂的 k 条）
- `assembleContextV2.js:89`（S2 段）：`k=3`，**minSimilarity=0.6**（硬闸）

### §3.2 根因：两端向量都是哈希伪向量

```js
// autonomyEngine.js:42-48  buildQueryVector
const text = stableStringify({ scenario_id, ctx: ctxRest, cond: conditions_evaluated });
return JSON.stringify(hashVector(text));

// decisionRepo.js:61-68  buildDecisionEmbedding —— 同样结构，同样 hashVector
```

`hashVector`（`embedding.js:8-17`）是 **SHA-256 的 32 字节映射到 384 个桶**的哈希签名（hashing trick），**不是语义 embedding**。性质：输入微变 → 输出随机重定向 → 余弦相似度退化为常数噪声。

### §3.3 决定性实验（可复现，无 DB 依赖）

模拟同一场景 `deal.advance` 语义高度相近的两次决策（仅 `deal_id`/`amount` 不同）：

| 对比 | 余弦相似度 | 过 0.6 闸 |
|---|---|---|
| A vs A（完全相同） | 1.0000 | ✅ |
| A vs C（逐字相同） | 1.0000 | ✅ |
| **A vs B（仅 id/金额不同，语义近乎同案）** | **0.1146** | ❌ |
| A vs D（同场景不同案） | 0.1105 | ❌ |

200 次"仅金额微变"采样：**均值 0.1157，过 0.6 闸 1/200**（该 1 次是与自身比较）。

### §3.4 判定

**S2 先例检索是结构性恒空，不是数据真空。**

- `minSimilarity=0.6` 的 S2 段：**除非两次决策的 `trigger_context` + `conditions_evaluated` 逐字完全相同，否则永不命中** → 即使库里有 1 万条先例也检索不到。
- `autonomyEngine.js:201`（minSimilarity=0）：会返回 k 条，但 `avgSimilarity` 恒 ≈0.11，是**不带区分度的常数噪声**——它参与了 `coverage`/置信度计算，实质注入噪声而非信号。

**这推翻了工作记忆中"S2 先例 0 hit 属 L0 原料数据真空"的归因**：即使 P0 灌满 L0 原料，S2 仍然恒空。**H3 因此从"锦上添花的加权"升级为"修复 S2 的唯一出路"。**

### §3.5 借鉴 Semantica 四分量（但权重必须反转）

Semantica `find_precedents_hybrid`：向量 0.7 + 结构(Jaccard) 0.3 + 类目 0/1 + node2vec 图中心性增益。

**我们不能直接抄 0.7 向量权重**——因为我们的向量分量在换真 embedding 前是**纯噪声**。方案：

| 分量 | 计算 | 我们可取性 | 建议权重 |
|---|---|---|---|
| **Jaccard 结构** | `conditions_evaluated` 的 `dim_key` 集合交集/并集 | ✅ 确定性可算，最贴近"同案" | **0.40** |
| **类目** | 同 `scenario_id` + 同 `business_tier` + 同 `disposition`（0/1 分量） | ✅ 确定性 | **0.20** |
| **图中心性** | `decision_precedent_rel` 入度（被引用多的先例更权威） | ✅ 表已存在 | **0.20** |
| **向量** | `1 - (embedding <=> qvec)` | ⚠️ 当前为噪声 | **0.20**（换真 embedding 后上调） |

权重走 `config_store['precedent-scoring']` 配置化（**阈值配置化铁律**，禁硬编码），且**归一强校验**（对齐 Semantica 权重和必须 =1）。

### §3.6 Task 分解

**T8 — 四分量打分器**
1. 新增 `src/decision/precedentScoring.js`：`scorePrecedent(candidate, query, cfg)` → 四分量 + 加权总分 + 各分量明细（**透明可解释**，对齐"多出口带出口标识"铁律）
2. 权重从 `config_store['precedent-scoring']` 读，出厂兜底 `{jaccard:0.4, category:0.2, centrality:0.2, vector:0.2}`
3. 归一强校验：权重和 ≠1 时抛错（**不静默**，对齐 Semantica）

**T9 — 接入检索**
1. `searchPrecedents` 增加 `mode` 参数：`'vector'`（旧行为，默认，保证回归不破）/ `'hybrid'`（新四分量）
2. `autonomyEngine.js:201` 切 hybrid；`assembleContextV2.js:89` S2 段切 hybrid
3. **minSimilarity 语义变更**：hybrid 模式下 0.6 闸改为对**加权总分**生效（原对向量相似度生效）。需同步 S2 的 `similarity` 输出字段为总分，并保留各分量明细供审计

**T10 — 测试**
- `test/decision/precedentScoring.test.js`：
  - **核心用例（直击根因）**：两个 `trigger_context` 仅 id/金额不同、conditions 相同的决策 → hybrid 相似度应 ≥0.6（**旧实现实测 0.1146**）
  - 权重和 ≠1 抛错
  - 分量明细齐全
  - 空候选不崩
- **判定块写法**：`expect(score, \`mode=${mode} jaccard=${c.jaccard} vector=${c.vector}\`).toBeGreaterThanOrEqual(0.6)`（多出口带标识）

> **T11（可选，P1）**：接入真 embedding provider 后，把 vector 权重上调、hashVector 降级为兜底。本计划不做。

---

## §4 执行顺序与 commit 分组

| 序 | Task | 内容 | commit 主题 |
|---|---|---|---|
| 1 | **T1** | provenance DDL 入 schema + 生产建表 | `fix(provenance): decision_provenance DDL 归位 schema.sql（止住 100% trackEntry 失败）` |
| 2 | **T2** | verifyChain 接自检卡 Q8 + API + 定时巡检 | `feat(provenance): 决策链校验接线（selfcheck Q8 + /provenance API）` |
| 3 | **T5+T6** | 阈值快照冻结 + requireDecision 接线 | `feat(policy): 决策落库冻结阈值快照（effective_policy_version 不再恒 null）` |
| 4 | **T8+T9** | 四分量打分器 + 检索接入 | `feat(precedent): 先例检索改四分量加权（修复 hashVector 导致的 S2 结构性恒空）` |
| 5 | **T3** | decision_event 入链 | `feat(provenance): decision_event 链式写入（event_index/prev_hash/event_hash）` |
| 6 | **T4+T7+T10** | 三份测试 | `test: P0 决策完整性三项测试（chain/policy/precedent）` |

**排序理由**：T1 是**唯一止血项**（生产持续报错），必须最先；T5/T8 是功能性缺口；T3 增量最大且可延后。

**AI 不代 commit**（沙箱无私有库凭证）——每组改完我给出显式路径 `git add` 命令，由您本地提交。

---

## §5 前置条件与风险

### §5.1 前置条件（阻塞项）
- ⚠️ **PostgreSQL 未运行**：本次取证时 `127.0.0.1:5433` 连接被拒，`Get-Service` 查无 postgres 服务。**实施前需您启动 PG**；T1/T5 的"生产库实证"步骤依赖它。
- 需您裁决：**§1.3 哈希白名单**（是否纳入 entry_type/invalidated/archived）、**§2.3 快照口径**（A/B/C）、**T3 是否留在 P0**。

### §5.2 风险与回滚
| 风险 | 影响 | 处置 |
|---|---|---|
| T1 建表后 9 处 trackEntry 由失败转成功，**写入量突增** | provenance 表增长 | 可接受；`applyArchival` 已有归档机制（`provenance.js:117`） |
| T9 切 hybrid 改变 `searchPrecedents` 语义 | 281 决策回归可能破 | 保留 `mode:'vector'` 默认，回归测试不指定 mode 即走旧路径；hybrid 仅在显式指定处生效 |
| T5 每次决策都可能插一条 policy_version | 版本表膨胀 | 内容哈希幂等（同内容同 id），实际版本数 ≈ 阈值变更次数 |
| T3 给 decision_event 加列 | 大表 DDL | 增量列 + 历史行留 null，不回填（避免伪造链） |

### §5.3 必守铁律
- **DDL 单一事实源** = `db/schema.sql`，`ensure*()` 仅兼容补列（禁 `CREATE TABLE IF NOT EXISTS` 补列）
- **测试全绿 ≠ 生产可用**：新增列/表后必须 `information_schema` 直查生产库
- **禁裸 `.catch(()=>{})`**：fail-safe 必须 `emit('trace')` + `recordFailure()`
- **多出口断言带出口标识**
- **阈值配置化**：权重/阈值走 `config_store` + 出厂兜底，禁硬编码
- **绝对禁 DELETE**：归档走 `invalidated`/`archived` 墓碑
- **禁并发两 vitest 共用 `crm_native_test`**：跑测前 `node scripts/seed-test-config.mjs`

---

## §6 验收标准

| Task | 验收口径（必须实证，不接受"代码写了"） |
|---|---|
| T1 | 生产库 `information_schema` 命中 `crm.decision_provenance` 全部列；`trackEntry` 调用后 `provenance-track-failed` trace 归零 |
| T2 | `GET /api/decision/:id/provenance` 返回 `{status:'OK', entries:N}`；手工篡改 payload 后返回 `TAMPERED` + `broken_at` |
| T5 | 新落库决策 `effective_policy_version IS NOT NULL`；改阈值后新决策指向新 policy_version_id，老决策不变 |
| T8/T9 | **核心**：语义相近（仅 id/金额不同）两决策 hybrid 相似度 ≥0.6（旧实现 0.1146）；权重和≠1 抛错 |
| T3 | `decision_event` 三列存在；`verifyEventChain` 对篡改返回 TAMPERED |
| 全量 | 决策回归保持 **281/281**；`npm run audit:isolation` 基线不劣化（🔴0） |

---

## §7 待您裁决的三项

1. **§1.3 哈希白名单**：是否把 `entry_type`/`invalidated`/`archived`/`source`/`activity_id` 纳入哈希输入？（推荐：是——否则墓碑翻转与来源篡改不可检出）
2. **§2.3 阈值快照口径**：A（实际使用路径子集，需埋点）/ B（全量 dump，最简）/ C（全量+使用路径）？（推荐 A，退 B）
3. **T3 是否在 P0**：`decision_event` 入链（20+ 调用点，含 config_change 高价值审计）留 P0 还是延后 P1？（推荐留 P0）

**裁决后我按 §4 顺序逐 Task 实施，每 Task 一 commit（AI 不代 commit，给显式路径命令）。**
