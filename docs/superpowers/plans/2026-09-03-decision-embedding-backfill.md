# 决策先例真向量持久化回填（方案 B）

> 日期：2026-09-03 | 关联：C4 先例检索四分量（T7/T8）、真 embedding 接入
> 状态：计划待批准 → 实现 + 用户本地 HITL 执行 DDL/回填

## §0 结论先行

- 用户裁决：**持久化回填（迁列）**。`crm.decision.embedding` 从 `vector(384)`（hash 基线，死列）迁移到 `vector(1024)`（BGE-large 真向量），回填历史决策真向量，并让 `searchPrecedents` 优先读存储向量、缺失回退即时重嵌。
- 收益：真 embedding 启用后，每次先例检索不再对候选池逐条调 embedding API（pool≈40 次/查询），改为读库；半回填状态兼容（缺失行回退重嵌）。
- 代价：破坏性 DDL（改列类型）+ 写库回填，需用户显式 HITL 授权在本地执行。

## §1 现状事实（evidence）

| 事实 | 证据 |
|---|---|
| `crm.decision.embedding` 是 `vector(384)`，只存 hash 基线 | `db/schema.sql:167` |
| model 路径（BGE-large）产出 **1024 维** | `src/llm/embeddingClient.js:34`（`BAAI/bge-large-zh-v1.5`，实测 dim=1024） |
| `searchPrecedents` model 路径**查询时即时重嵌**候选，不读 `c.embedding` 列 | `src/decision/decisionRepo.js:492-504`（注释："避免存储模型向量带来的 schema 维度迁移"） |
| 全仓仅 `embedding.js:40` 消费 `EMBEDDING_PROVIDER`，server 启动未设 | Grep 全仓确认 |
| 改列类型不能塞 schema.sql 的 `CREATE TABLE IF NOT EXISTS`（旧库不补列→整事务回滚），须独立 ALTER | `db/migrate.js:178-179` 铁律注释 |
| 已有 `scripts/backfill-ai.js` 是粒子 payload.ai 回填，与本次无关 | `scripts/backfill-ai.js:1` |

## §2 实施步骤（带代码）

### 3.1 `db/schema.sql` 基线改维度（新库从零建表生效）
`db/schema.sql:167`：`embedding vector(384),` → `embedding vector(1024),`
> 旧库已存在 decision 表，此改不影响旧库（CREATE IF NOT EXISTS 不执行）；旧库靠 3.2 ALTER。

### 3.2 `db/migrate.js` 新增幂等 ALTER 段（旧库迁移生效）
在文件末尾（`await pool.end()` 前）追加：
```js
// 真 embedding 持久化（2026-09-03 方案 B）：embedding 列 384→1024，丢弃无意义 hash 基线（model 路径不消费）。
// 旧值是 384 维 hash 向量，维度不匹配无法直接 cast，置空（USING NULL）后由回填脚本写真向量。
// 幂等：DO block 判断列类型，已是 vector(1024) 则跳过，避免重复重写表。
await pool.query(`
  DO $$
  BEGIN
    IF (SELECT format_type(atttypid, atttypmod)
        FROM pg_attribute
        WHERE attrelid='crm.decision'::regclass AND attname='embedding') != 'vector(1024)' THEN
      ALTER TABLE crm.decision ALTER COLUMN embedding TYPE vector(1024) USING NULL;
    END IF;
  END $$;
`).catch((e) => { console.error('[migrate] decision.embedding 列类型迁移失败:', e.message); throw e; });
// ivfflat 余弦索引：维度变更后须重建（旧索引绑定 384 维）；NULL 值不索引，半回填安全
await pool.query(`DROP INDEX IF EXISTS idx_crm_decision_embedding`).catch(() => {});
await pool.query(
  `CREATE INDEX IF NOT EXISTS idx_crm_decision_embedding
     ON crm.decision USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)`
).catch((e) => { console.error('[migrate] decision.embedding 索引重建失败:', e.message); throw e; });
console.log('[migrate] decision.embedding → vector(1024) + ivfflat 索引就绪（幂等）');
```

### 3.3 新建 `scripts/backfill-decision-embeddings.mjs`（用户本地执行，写库）
要点：
- 脚本内显式 `process.env.EMBEDDING_PROVIDER='model'`（Windows Git Bash 不向子进程传 env）。
- 遍历 `crm.decision WHERE state IN ('CONFIRMED','AUTONOMOUS')`（先例检索候选池仅此二态，回填这些即够；`--all` 可含其余态）。
- 逐条 `embedText(stableStringify({ scenario_id, ctx: trigger_context, cond: conditions_evaluated }))`（与 `searchPrecedents` 同源文本结构），`UPDATE embedding = $1::vector`。
- 节流：每批 20 条，批间 `await sleep(200)`，避免 SiliconFlow 429（前序实测限流）。
- 幂等：`--dry` 仅统计；重跑覆盖（已 1024 维可跳过）。
- fail-safe：单条 catch 记日志不中断；禁止静默 `.catch(()=>{})`（须 emit+recordFailure 或 console.error）。

### 3.4 `src/decision/decisionRepo.js` searchPrecedents 优先读存储向量
`decisionRepo.js:496-504` 改为：
```js
let vector = null;
if (!dropVector) {
  const stored = typeof c.embedding === 'string' ? safeParse(c.embedding) : c.embedding;
  if (Array.isArray(stored) && stored.length === qvec.vector.length) {
    vector = cosine(qvec.vector, stored);              // 命中回填真向量，免 API 调用
  } else {
    const cEmbed = await embedText(stableStringify({   // 半回填/未迁移：回退即时重嵌（兼容）
      scenario_id: c.scenario_id, ctx: c.trigger_context || {}, cond: c.conditions_evaluated || [],
    }));
    if (cEmbed.vector.length === qvec.vector.length) vector = cosine(qvec.vector, cEmbed.vector);
  }
}
```
> 测试安全：测试未设 `EMBEDDING_PROVIDER` → `qvec.provider='hash'` → `dropVector=true` → 整段跳过，行为不变（test/decision.test.js 不受影响）。

### 3.5 启用默认真 embedding（server 启动自动检测）
`src/http/server.js` 启动块（import `embedText` 前）追加：
```js
// 真 embedding 默认启用：llm_config 有可用 embedding 配置即走 model，否则降级 hash（零风险）
try {
  const { isEmbeddingEnabled } = await import('../llm/embeddingClient.js');
  if (await isEmbeddingEnabled()) process.env.EMBEDDING_PROVIDER = 'model';
} catch { /* 配置不可用 → 保持默认 hash */ }
```
`src/llm/embeddingClient.js` 导出 `isEmbeddingEnabled()`（包装现有 `loadEmbedCfg`）。
> 测试不启动 server、不设 env → 默认 hash，全量测试绿。

## §3 验证（受影响子集口径，PG 不稳时勿因单次红直判回归）

1. `node db/migrate.js` → 日志含 `decision.embedding → vector(1024) ... 就绪`；`\d crm.decision` 确认列 `vector(1024)`。
2. `node scripts/backfill-decision-embeddings.mjs --dry` → 统计待回填条数；`--all` 实际回填。
3. 回填后跑一次真实 `searchPrecedents`（生产实证）：`components.vector` 命中存储向量（非 null），`similarity ≥ 0.45` 正常召回。
4. 子集测试：`test/decision.test.js`、`test/precedent-scoring.test.js`、`test/embedding-model.test.js`、`test/llm/embeddingClient.test.js` 全绿。

## §4 风险与 HITL 授权点

- **破坏性 DDL**：`ALTER COLUMN embedding TYPE vector(1024) USING NULL` 丢弃旧 hash 基线（不可逆，但旧值无意义）。须用户在本地对 `crm_native` 执行 `node db/migrate.js`（或单独跑 3.2 SQL）。
- **写库回填**：`scripts/backfill-decision-embeddings.mjs` 写 `embedding` 列，须用户本地执行（AI 沙箱无 DB 凭证 + PG 不稳，不代执行）。
- **零信任**：AI 仅写文件/脚本，DDL 与回填执行由用户显式授权运行。
- **半回填窗口**：迁移后、回填完成前，未填行 `searchPrecedents` 自动回退即时重嵌，服务不中断。

## §5 回滚

- 列类型不可轻易回 384（1024 真向量截断失真）。回滚=停用真 embedding：`server.js` 检测失败或 `EMBEDDING_PROVIDER` 不设 → 自动 hash 路径，`searchPrecedents` 走即时重嵌，存储列闲置。无需反向 DDL。
