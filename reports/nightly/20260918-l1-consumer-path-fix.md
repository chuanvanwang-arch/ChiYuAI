# L1 消费面断裂修复 + 全类型向量回填（2026-09-18）

> 触发：用户「同意迁移」——批准执行被搁置的**全类型向量回填**（995 行）。
> 执行过程中发现并修掉一处**比回填本身更严重**的 P0：L1 实体召回在**所有模式下都是死的**，
> 而全部探针恒绿。本报告按「批准项 → 意外发现 → 修复 → 验证」顺序给出。

---

## §0 结论先行

| # | 事项 | 状态 |
|---|---|---|
| 1 | 全类型向量回填（用户批准项） | ✅ 995/995，覆盖率 6.7% → **100%** |
| 2 | **P0：L1 实体召回全断**（查询侧 384 维 × 存储列 1024 维） | ✅ 已修（本机验证通过） |
| 2b | **P0'：scoped profile 下 L1 抛 `missing FROM-clause entry for table "p"`** | ✅ 已修 |
| 3 | 新增 **D15 探针**（消费面端到端可达）+ 5 条自检反例 | ✅ 自检 23/23 |
| 4 | 既有红 **ATTIO T10 契约测试**（L1 应能定位上下文实体） | ✅ 转绿 |
| 5 | ⚠ **生产环境的 L1 召回当前仍是死的**（同一缺陷，镜像未更新） | ⛔ **待授权发布** |

**一句话**：这次不是"补了数据"，而是发现**数据补了也没人能用**——存储面 100% 真向量、
消费面一条实体都召不回，且所有探针都是绿的。修复后本机端到端可召回；生产待发布。

---

## §1 用户批准项：全类型向量回填

```
EMBEDDING_PROVIDER=model node scripts/backfill-knowledge-embeddings.mjs --types=all --limit=1000 --force-hash
→ [backfill] provider=model col=vector(1024) types=all-types force_hash=on hash_stale=0 candidate=995
→ [backfill] done ok=995 skip=0
```

**覆盖率（按类型分组，`scripts/particle-embedding-coverage.mjs`）**：

| 时点 | 总行 | 已嵌 | 缺向量 | hash 伪 | 覆盖率 |
|---|---|---|---|---|---|
| 回填前 | 1067 | 72 | 995 | 0 | 6.7% |
| 回填后 | 1067 | **1067** | **0** | **0** | **100.0%** |

- 995 行全部产出真模型向量，**零降级**（`skip=0`，无 `embedding-degraded` 留痕）。
- 范围核准：写入路径 `src/ontology/hooks.js:ensureEmbedding()` 本就**不分类型**（所有粒子落库即嵌），
  故「全类型回填」与设计口径一致；`--types` 只是把此前隐含的默认值显式化。
- 依据链：迁移 `USING NULL` 清空的是**全类型**旧向量，而上一轮回填只覆盖 `CRM_KNOWLEDGE`
  ⇒ 其他类型 L1 检索池静默塌陷（447→72）——即"破坏范围 ≫ 修复范围"（铁律 8 形态 4）。

---

## §2 意外发现的 P0：L1 实体召回全断（且所有探针全绿）

### 2.1 直接证据（不是推断）

```
# 本机
hashVector dim = 384
QUERY_FAIL: different vector dimensions 1024 and 384

# 生产容器内（只读实跑，未写任何文件）
col=vector(1024)        l1_pool=25      （部署镜像内 `grep -c 'export const DIM = 384'` = 1）
l1_dim384_query → ERROR:  different vector dimensions 1024 and 384
```

### 2.2 缺陷链（两处叠加，两种模式各死一次）

| # | 位置 | 缺陷 | 触发条件 | 后果 |
|---|---|---|---|---|
| ① | `assembler.js:73`（旧） | 查询向量固定 `hashVector(q)` = **384 维**，而列自 09-14 起为 `vector(1024)` | profile = `all`（默认） | PG 抛维度错 |
| ② | `assembler.js:78,88`（旧） | 表**无别名**，但 `scopePredicate` 以别名 `p` 引用列、占位符从 `$1` 编号；向量/名字参数又**追加在末尾** | 传入 scoped profile（非 `all`） | 抛 `missing FROM-clause entry for table "p"` |

两者的共同下游：`assembleContext` 的 `try { layers.L1 = … } catch { missing.L1 = true; }`
⇒ 异常被吞成一个降级标记，**不进任何指标/告警**，L1 静默归零。

**判定：`schema.sql:19` 的注释已明确设计意图是"列 1024 + hash 路径 fail-open NULL"，
即 09-14 那次变更**写侧改了、读侧没改**的半改形态。**

### 2.3 为什么此前所有探针都是绿的

- **D1（知识向量真伪）** 看的是 *存储的向量本身* → 真向量 100%，🟢
- **D3（L1 知识构成）** 看的是 *池子行数与类型构成* → 1067 行，🟢
- **没有任何一条探针调用过消费函数** ⇒「存了真向量但无人能查」在这一探针体系里**不可测**。

补充：测试环境之所以长期掩盖它——`NODE_ENV=test` 不启用真向量 ⇒ `embedding` 全为 NULL
⇒ `WHERE embedding IS NOT NULL` 选出空集 ⇒ **PG 从未真正比较过一对向量**，维度错不触发。

---

## §3 修复内容

### 3.1 契约对齐（单一事实源）

| 文件 | 变更 |
|---|---|
| `src/ontology/embedding.js` | 新增 `STORED_EMBED_DIM = 1024`（与 `schema.sql:19,182` 对齐）；注释写清 hash(384) 与真向量(1024) 不同空间、不得互为排序依据 |
| `src/llm/embeddingBootstrap.js` | **新增**：把"何时启用真 provider"的判据从 `server.js` 内联抽出为唯一实现 |
| `src/http/server.js` | 改为调用该共享函数（行为契约不变：test 跳过 / 显式值优先 / llm_config 有 apiKey → model / 异常 fail-open） |

> 抽出的理由：KMD 探针是**独立进程**，不走 server 启动段 ⇒ 若各写一份 provider 判据，
> 探针看到的世界 ≠ 运行时 = **判据分叉**，结论对运行时无效。

### 3.2 L1 召回修复（`src/context/assembler.js`）

1. **查询向量同源同维**：新增 `l1QueryVector()` —— 走与写入同一条 `embedText()`；
   仅当拿到 `provider=model` 且维度 = `STORED_EMBED_DIM` 时才参与 `<=>`；
   否则**不做向量排序**（hash 与真向量混算 = 随机排序，`decisionRepo.js:624` 同款结论），
   并 emit 降级留痕（`l1-query-vector-unavailable`）。
2. **独立超时预算**：实测查询侧 embedding **136–466ms**，而旧的层上界是 **200ms**
   ⇒ 即便 provider 修好也会"恒超时判 missing"（同一根因换形态）。
   现：`L1_TIMEOUT_SEMANTIC = 1200ms`（L1 总预算）、`L1_EMBED_TIMEOUT = 800ms`（向量化独立预算，
   超时降级为"非语义召回"而非整体 missing）；其余层沿用 200ms 不变。
3. **进程内查询向量缓存**（有界 64，只缓存真向量）：同文本确定性输出 ⇒ 同一请求多场景装配不重复付费。
4. **别名与占位符编号**：三条 SQL 统一 `crm.particles p` + `P()` 动态编号
   （`$` + `sc.params.length + n`），修掉 scoped profile 路径的 `missing FROM-clause entry`。
5. **名称归位与向量解绑**：② 兜底不再以 `embedding IS NOT NULL` 为门（名称查找与向量无关）；
   并补**子串兜底** —— 原实现按空白分词后做**整名等值**匹配，名字含空格的实体（如 `X 科技`）
   永远匹配不上（**ATTIO T10 契约测试因此长期红**）。等值结果排序在前。

---

## §4 新增 D15 探针：L1 消费面可达

- 判据：**调用真实消费函数**（`import assembleContext`），以库中真实存在的实体名查询，
  断言装配不抛错 **且 L1 命中该实体** —— 不是"函数被调用/返回 200"这类过程指标。
- 与运行时**同源**：显式调用同一个 `ensureEmbeddingProvider()`。
- 三态分级（`d15Classify` 纯函数）：`semantic` → PASS / `name-only` → WARN（语义召回静默丢失）/
  `layer-missing` 或 `entity-unreachable` → FAIL / 调用抛错 → ERROR。
  **分级的意义**：否则"名字兜底能返回一条"会把"语义召回已死"报成绿。
- 自检反例 +5（含"库中有实体却召不回不得报绿"），`--self-test` **23/23**。

---

## §5 验证结果（前 → 后）

| 项 | 修复前 | 修复后 |
|---|---|---|
| `EMBEDDING_PROVIDER=model`，query = 实体名 | `missing.L1=true`，L1 = **0 行** | `missing` 无 L1，L1 = **6 行**，命中 ✓ |
| 无 provider（hash 模式） | `missing.L1=true`，L1 = **0 行** | L1 = 1 行，命中 ✓（无维度错） |
| scoped profile（`domain` 非空谓词） | `missing.L1=true`，L1 = **0 行** | L1 = 6 行，命中 ✓，**类型过滤生效**（只回 CRM_KNOWLEDGE/CRM_ACCOUNT） |
| 向量覆盖率 | 72/1067 = 6.7% | **1067/1067 = 100%**，hash 伪 0 |
| ATTIO T10 契约测试 | 🔴（长期红） | 🟢 |
| L1 相关测试 | — | 36/36 通过（`context` / `attio-inheritance` / 新回归锁） |
| KMD 探针 | 🟢10 🔴1 🟡3 ⚪2 | 🟢11 🔴1(D6) 🟡3 ⚪2（**新增 D15**，D3 池 1067） |
| 自检 | 18/18 | **23/23** |

产物：`artifacts/kmd-probe-2026-09-18-postl1fix.json`、
`artifacts/backfill-all-types-2026-09-18.log`、`artifacts/vitest-full-2026-09-18-l1fix.log`。

---

## §6 影响面与待决

| 项 | 说明 |
|---|---|
| ⛔ **生产 L1 仍断** | 生产列已是 `vector(1024)`、镜像内仍是旧 `assembler.js` ⇒ **线上 L1 实体召回当前 100% 失效**（已被 `catch` 吞成降级标记）。修复已在本机验证，**发布即可生效**，但本轮无发布授权，未上生产。 |
| 待授权 | 生产发布（走 `crm-prod-release` 通道）；`git push`（沙箱出网阻断，本地领先 origin 13+） |
| 待人工 | D6 校准积压 71 条 / 最老 12.7 天（HITL 审批流，禁自动 apply） |
| 观察项 | 名称归位的**分词语义**仍有边界：`q` 按空白/逗号切分后匹配，跨词组合靠新加的子串兜底；若后续发现更复杂命名，可考虑改为整串 或 前缀匹配 |
| 未动 | D8 记忆注入口径（`injectable_pct_legacy=1.01`）、D10 D→K 回写（0 条）—— 属另一条边，不混入本次修复 |
