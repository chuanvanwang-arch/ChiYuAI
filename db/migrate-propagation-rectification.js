// db/migrate-propagation-rectification.js — 整改报告结构化补列（rectification JSONB 三段落）
// 设计 §16.2 / 计划 Task 11 Step 1：decision_retro_report 增 rectification（daily_ops/problems/prescriptions）。
// 运行：PGDATABASE=crm_native_test node db/migrate-propagation-rectification.js
// 约定同 migrate-propagation-metrics.js：queryWrite 来自 ../src/db.js；ADD COLUMN IF NOT EXISTS（幂等、禁删）。
import { pathToFileURL } from 'node:url';
import { queryWrite } from '../src/db.js';

export async function migratePropagationRectification() {
  await queryWrite(
    `ALTER TABLE crm.decision_retro_report ADD COLUMN IF NOT EXISTS rectification JSONB NOT NULL DEFAULT '{}'::jsonb`
  );
  console.log('[migrate-propagation-rectification] done');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  migratePropagationRectification().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}
