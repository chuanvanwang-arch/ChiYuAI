// scripts/export-contract-feedback.mjs
// 导出 crm.contract_feedback → JSON（供 aggregate-feedback.mjs 生成 P0 改进提案；仅提案需批准）
import { query as defaultQuery } from '../src/db.js';
import { writeFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';

export async function exportContractFeedback({ query = defaultQuery } = {}) {
  const r = await query(`SELECT doc_path, task, gap_type, agent, observed, expected, severity, status, created_at, updated_at
                         FROM crm.contract_feedback ORDER BY updated_at DESC`);
  return r.rows;
}

async function main() {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('-o');
  const out = outIdx !== -1 ? args[outIdx + 1] : 'tmp/contract-feedback-export.json';
  const rows = await exportContractFeedback();
  writeFileSync(out, JSON.stringify(rows, null, 2), 'utf8');
  console.log(`[export] ${rows.length} 条反馈 → ${out}（交给 aggregate-feedback.mjs 生成提案）`);
}

// 仅在 CLI 直接运行时执行（被 import 时不触发）。跨平台大小写归一。
const __invoked = process.argv[1]
  ? fileURLToPath(pathToFileURL(process.argv[1]).href)
  : null;
const __self = fileURLToPath(import.meta.url);
if (__invoked && __invoked.toLowerCase() === __self.toLowerCase()) {
  main().catch((e) => { console.error('[export] 失败:', e.message); process.exit(1); });
}
