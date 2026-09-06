// scripts/export-active-mcp-actors.mjs — 只读导出生产库活跃 MCP 凭证的 actor 清单（供通知用）
//
// 用途：token 格式升级为 crm_<id32>_<secret48> + 存量策略 B（上线即强制重登录）后，
//       若执行 scripts/revoke-legacy-mcp-tokens.mjs --apply，这 105 个活跃接入方将立即失效。
//       本脚本导出去重后的 actor 清单，让运维/通知团队能精准触达受影响方。
//
// 纪律：纯 SELECT，零写库、零吊销；不依赖任何写池。
// 用法：
//   PGDATABASE=crm_native node scripts/export-active-mcp-actors.mjs      # 控制台汇总
//   PGDATABASE=crm_native node scripts/export-active-mcp-actors.mjs --csv # 另存 CSV 落盘

const csv = process.argv.includes('--csv');
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const { queryRead } = await import('../src/db.js');
const db = process.env.PGDATABASE || '(default)';

// 活跃凭证：revoked_at IS NULL。按 actor 去重聚合（一个接入方可能有多条凭证行）。
const SQL = `
  SELECT actor,
         person_id,
         role_tag,
         count(*)::int                              AS token_count,
         min(created_at)::text                     AS first_issued,
         max(created_at)::text                     AS last_issued
  FROM   crm.mcp_identity
  WHERE  revoked_at IS NULL
  GROUP  BY actor, person_id, role_tag
  ORDER  BY token_count DESC, actor ASC`;

const r = await queryRead(SQL);
const rows = r.rows;

console.log(`db=${db}  活跃 actor 数=${rows.length}`);
let totalTokens = 0;
console.log('─'.repeat(96));
console.log(
  'actor'.padEnd(34) +
  'person_id'.padEnd(14) +
  'role'.padEnd(10) +
  'tokens'.padStart(7) +
  '  first_issued'.padStart(22) +
  '  last_issued'.padStart(22)
);
console.log('─'.repeat(96));
for (const x of rows) {
  totalTokens += Number(x.token_count);
  console.log(
    String(x.actor ?? '').padEnd(34) +
    String(x.person_id ?? '').padEnd(14) +
    String(x.role_tag ?? '').padEnd(10) +
    String(x.token_count).padStart(7) +
    ('  ' + (x.first_issued ?? '')).padStart(22) +
    ('  ' + (x.last_issued ?? '')).padStart(22)
  );
}
console.log('─'.repeat(96));
console.log(`合计：活跃 actor=${rows.length}  活跃凭证行=${totalTokens}`);

if (csv) {
  const dir = join(process.cwd(), 'tmp');
  try { mkdirSync(dir, { recursive: true }); } catch { /* 已存在 */ }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = join(dir, `active-mcp-actors-${stamp}.csv`);
  const header = 'actor,person_id,role_tag,token_count,first_issued,last_issued\n';
  const body = rows
    .map((x) => [x.actor ?? '', x.person_id ?? '', x.role_tag ?? '', x.token_count, x.first_issued ?? '', x.last_issued ?? ''].join(','))
    .join('\n');
  writeFileSync(file, header + body + '\n', 'utf8');
  console.log(`\nCSV 已落盘: ${file}`);
}

process.exit(0);
