# SiliconFlow 余额恢复后的 D1 收口 · 执行报告

- 日期：2026-09-18
- 触发：用户通报「SiliconFlow 余额好了」——解开本轮唯一 P0 外部阻塞
- 提交：`310538c`（8 文件，+530/-31）
- 探针产物：`artifacts/kmd-probe-2026-09-18-preembed.json` / `-postembed.json`

---

## 一、结论摘要

| 项 | 整改前 | 整改后 |
|---|---|---|
| D14 外部依赖活性（本机） | 🟢 `ok(dim=1024)` | 🟢 不变 |
| **D14 外部依赖活性（生产容器内实测）** | 未测（402 曾同源同故障） | 🟢 **`EMBED_OK dim=1024`** |
| D0 环境基线漂移 | 🟡 `particles.embedding=vector(384)`（基线 1024） | 🟢 `drift_items=0` |
| **D1 知识向量真伪** | 🔴 `real_vector_pct=0`（69 条 hash 伪向量） | 🟢 **`real_vector_pct=100`**、`max_nonzero=1024`、72/72 真向量 |
| 全量探针汇总 | 🟢8 🔴2 🟡4 ⚪2 | **🟢10 🔴1 🟡3 ⚪2**（唯一红 = D6 校准积压，须 HITL） |

**外部阻塞已实际解除，且本机与生产两侧均以实测（非配置推断）确认。**

---

## 二、凭据活性实测（先证后做）

| 侧 | 手段 | 结果 |
|---|---|---|
| 本机 | `kmd-closure-probe --probe D14` | `embedding=ok(dim=1024)`、SMTP 齐备 → PASS |
| 生产 | 容器内直调 `src/llm/embeddingClient.js` 的 `embed()` | **`EMBED_OK dim=1024`** |
| 生产 | 镜像内拒因透传修复在位性 | `grep -c providerMessage src/llm/embeddingClient.js` = **2**（修复已随镜像发布） |
| 生产 | 近 24h 降级留痕 | `monitor_event embedding-degraded = 0` |

> 生产实测方式：`docker exec -w /app crm-app node --input-type=module -e "import('./src/llm/embeddingClient.js')…"`。
> 未向生产容器写入任何文件（容器内为已发布版本，不含本轮补丁）。

---

## 三、三项修复与证据

### 1. 迁移自愈：384→1024 从「手工一次性」改为「幂等自动」

**根因（结构缺口，非偶发）**：`crm.decision.embedding` 的 384→1024 写在 `db/migrate.js` 内联段（容器启动自动生效），
而 `crm.particles.embedding` 的同款改造**只存在于一个自述"HITL 显式执行一次"的独立 SQL**，且该 SQL 用的是
`ALTER … USING NULL`——**无条件执行 ⇒ 重复执行即清空全表向量**。后果两层：

1. **漏跑即永久分叉**：任何既有库（本机开发库、生产库）漏跑这一步就停在 `vector(384)`，而 `db/schema.sql`
   声明基线已是 `vector(1024)`（新库直建生效）→ 两侧不一致且**无人报警**（D0 由此长期挂 WARN）。
2. **重跑即数据破坏**：`USING NULL` 没有类型闸。

**处置**：
- 新增 `db/migration-2026-09-18-particles-embedding-1024.sql`：`DO $$` 内以「当前列类型」为闸，
  已是 `vector(1024)` 则 `RETURN`（幂等）；仅在需迁移时先 `DROP INDEX`（hnsw 索引依赖列类型）
  → `ALTER … USING NULL` → 重建索引；**丢弃行数以 NOTICE 留痕**（可审计）。
- 登记进 `INCREMENTAL_SQL` ⇒ 新库 / 本机旧库 / 生产库三条路径收敛到同一基线。
- 原 `migration-2026-09-14-particles-embedding-1024.sql` 降级为**空操作壳**（保留文件名以免外部 runbook 引用时报错，且不再执行 DDL）。

**证据**：`node db/migrate.js` 后 D0 由 `vector(384)/drift_items=1` → `vector(1024)/drift_items=0`。

### 2. 回填口径补全：三条"跑过了但没效果"的路径被堵

| 缺口 | 形态 | 修法 |
|---|---|---|
| 只筛 `embedding IS NULL` | 缺陷子集是**非 NULL 的 hash 伪向量** ⇒ `candidate=0` 而脚本 `exit 0`，假向量**永不自愈** | `--force-hash`（判据与探针 D1 同源，防口径分叉） |
| 不打印存量陈旧度 | 「候选 0 ≠ 存量健康」不可见 | 每次无条件打印 `hash_stale=N`，并在未开 `--force-hash` 时提示 |
| 无维度前置校验 | 384 列写 1024 维必失败 → 静默 skip | 列 ≠ `vector(1024)` 时 **exit 3 显式失败** |

另将候选谓词与陈旧度统计抽到 `scripts/lib/embedding-backfill-query.mjs`（纯函数，脚本与单测共用）。

**证据**：dry-run `col=vector(1024) force_hash=on hash_stale=0 candidate=72 ok=72 skip=0`；正式运行 `ok=72 skip=0`。
D1 随即 `🟢 real_vector_pct=100`、`has_negative=72`、`avg_nonzero=1024`。

### 3. 探针判据纠偏（本轮"顺带发现"的真缺陷）

**D1 三态混淆**：迁移后 69 行知识向量被按设计清空（待回填），探针报「**知识层空（无 CRM_KNOWLEDGE 行）**」，
而 **D3 同时报 `knowledge=69`** ——两种状态语义完全不同（"没知识" vs "有知识但检索不可用"），
错报会把处置方向引向"为什么没知识"而非"去跑回填"。

处置：抽出纯函数 `d1Classify()`，四态互不覆盖（`empty-layer` / `zero-vector` / `hash-dominated` / `real`），
自检补 4 条反例（**18/18 通过**，原 14/14）。

**DB 连接目标硬编码**：探针 `host` 写死 `localhost`，在容器内必 `ECONNREFUSED`（PG 不同容器）⇒
「生产活性」只能另写脚本，**判据分叉的风险源**。改为 `PGHOST`/`PGPORT` env 可覆盖（缺省值不变）。

---

## 四、影响面与遗留决策

### 4.1 迁移的副作用（已量化，须你决策）

`USING NULL` 会清空**全部类型**的旧向量，而回填缺省只覆盖 `CRM_KNOWLEDGE`。本机实测（`scripts/particle-embedding-coverage.mjs`）：

```
合计   1067 行 → 已嵌 72（全为知识类，真向量） / 缺向量 995 / hash伪 0
```

即 L1 检索池由 447 行降至 72 行。**评估**：
- 被清掉的 375 条均为 09-14 之前的 **hash 伪向量**（非语义，逐字相同 cos=1.0、语义近似 cos=0.11）；
- 现行写入路径 `src/ontology/hooks.js` 是「写入时惰性嵌入 + 失败写 NULL」，`schema.sql` 注释明确
  「真模型 1024 维；hash 路径 fail-open NULL」⇒ **NULL 是设计内的合法态**，非数据损失；
- 消费方仅 `src/context/assembler.js:78,88`（L1 实体召回，门为 `embedding IS NOT NULL`）。

**决策点**：是否把 995 行实体也回填真向量（恢复/增强 L1 实体召回）。
工具已就绪（一条命令），但**属行为变更且产生 995 次外部调用**，按项目约定「先报清单等确认」，本轮**未执行**：

```bash
EMBEDDING_PROVIDER=model node scripts/backfill-knowledge-embeddings.mjs --types=all --limit=1000
```

### 4.2 其他遗留（与本轮无关）

- **D6**：`calibration_patch` PENDING 71 条、最老 12.7 天，唯一 🔴；须管理员审批流 HITL，**禁自动 apply**。
- **D9/D10/D11** 三条 🟡：`visit_shortfall` 占比 65.8%（量级 3190 < 门 5000，非风暴）/ 复盘知识 0 条 / 投影契约 61.54%。
- **生产发布**：本轮改动未上生产（无持续授权）。生产列已是 `vector(1024)`，故新迁移在生产为幂等 no-op；
  真正需同步的是探针/回填脚本与 D1 判据。**push 待用户**（本地领先 origin **11**，沙箱出网阻断 github:443）。

---

## 五、复用要点（已回写 SKILL/memory）

1. **「HITL 手工执行一次」的迁移是隐性缺口**：它与 schema 声明基线分叉后无人报警。
   判据：凡 `migration-*.sql` 未登记进 `INCREMENTAL_SQL`，须能解释"为什么它不需要自动执行"。
2. **`ALTER … USING NULL` 必须带类型闸**：否则重跑 = 清空该列。幂等迁移的正确形态是
   `DO $$ … IF cur_type = 目标 THEN RETURN; END IF; … $$`。
3. **`--force-*` 类修复开关的判据必须与探针同源**（本轮回填谓词直接复用 D1 指纹），否则会出现
   "探针红、脚本绿"的口径分叉。
4. **筛选条件要覆盖缺陷的形态，而不只是"缺席"**：缺陷子集是非 NULL 的假值时代码只筛 NULL ⇒ 永不命中。
5. **探针的连接目标不得硬编码**：硬编码使探针无法跨环境复用，进而催生"另写一份"⇒ 判据分叉。
6. **同一数字在两条探针里矛盾（D1「知识层空」vs D3 `knowledge=69`）就是判据缺陷的信号**，
   不是"数据问题"。
