// scripts/backfill-decision-embeddings.mjs — 历史决策真向量持久化回填（方案 B，2026-09-03）
// 设计：docs/superpowers/plans/2026-09-03-decision-embedding-backfill.md
// 用途：将 CONFIRMED/AUTONOMOUS 决策的真语义向量（BGE-large 1024 维）写入 crm.decision.embedding，
//   供 searchPrecedents 优先读取（免每次查询重调 embedding API）。
// 幂等可重跑：已写行也会被覆盖（模型升级无害）；半回填可重复执行补齐 NULL 行。
// 节流：每 20 条 sleep 200ms，规避 SiliconFlow 429 限流。
// 用法：
//   node scripts/backfill-decision-embeddings.mjs          # 写库回填
//   node scripts/backfill-decision-embeddings.mjs --dry    # 仅统计待回填条数，不调用 API/不写库
// 前置：须先执行 db/migrate.js（完成 embedding 列 vector(384)→vector(1024) 迁移），否则写入维度不符报错。
import { pool } from '../src/db.js';
import { embedText, stableStringify, EMBED_PROVIDER } from '../src/ontology/embedding.js';

const DRY = process.argv.includes('--dry');
const BATCH = 20;
const SLEEP = 200;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 脚本显式意图：强制走真模型（即便未设 env）。降级（缺配置/限流）由 embedText 内部留痕，
//   本脚本仍尝试，失败行计入 err 不阻断整体。
process.env.EMBEDDING_PROVIDER = 'model';

async function main() {
  const { rows } = await pool.query(
    `SELECT decision_id, scenario_id, trigger_context, conditions_evaluated
     FROM crm.decision WHERE state IN ('CONFIRMED','AUTONOMOUS')`
  );
  console.log(`[backfill] 待回填决策 ${rows.length} 条（${DRY ? 'DRY 仅统计' : '写库'}）`);
  if (DRY) { await pool.end(); return; }

  let done = 0, skip = 0, err = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    try {
      const v = await embedText(stableStringify({
        scenario_id: r.scenario_id,
        ctx: r.trigger_context || {},
        cond: r.conditions_evaluated || [],
      }));
      if (v.provider !== EMBED_PROVIDER.MODEL || !v.vector || !v.vector.length) {
        skip++;
        console.warn(`[backfill] ${r.decision_id} 跳过（provider=${v.provider}，未产出真向量）`);
        continue;
      }
      await pool.query(
        `UPDATE crm.decision SET embedding = $1::vector WHERE decision_id = $2`,
        [JSON.stringify(v.vector), r.decision_id]
      );
      done++;
    } catch (e) {
      err++;
      console.error(`[backfill] ${r.decision_id} 失败: ${e.message}`);
    }
    if ((i + 1) % BATCH === 0) {
      console.log(`[backfill] 进度 ${i + 1}/${rows.length}（done=${done} skip=${skip} err=${err}）`);
      await sleep(SLEEP);
    }
  }
  console.log(`[backfill] 完成 done=${done} skip=${skip} err=${err} / 共 ${rows.length}`);
  await pool.end();
}

main().catch((e) => { console.error('[backfill] 失败:', e.message); process.exit(1); });
