// scripts/revoke-legacy-mcp-tokens.mjs — 存量 MCP 凭证一次性软吊销（设计 §4.5）
//
// 背景：token 格式升级为 crm_<id32>_<secret48> 后，旧格式（裸 48 hex）token 无法解析出 identity_id，
//       且库侧只存哈希、明文不可逆 —— 无法逐行甄别「哪些是旧格式」。
//       按用户选定策略 B（上线即强制重登录）：一次性软吊销全部存量行，全体接入方重新 crm_login。
//
// 纪律：绝对禁删 —— 只写 revoked_at 软标记；数据零损失，回滚即清空该列。
// 安全：默认 dry-run（只统计不写库），必须显式 --apply 才执行。
//
// 用法：
//   node scripts/revoke-legacy-mcp-tokens.mjs                 # dry-run
//   PGDATABASE=crm_native node scripts/revoke-legacy-mcp-tokens.mjs --apply   # 生产执行（需授权）

const apply = process.argv.includes('--apply');
const db = process.env.PGDATABASE || '(default)';

const { query, queryWrite } = await import('../src/db.js');

// 注意：所有 count 必须显式 ::int —— 裸 count(*) 返回 int8，node-postgres 会解析成字符串，
//      导致 `a.active === 0` 判为 false（'0' !== 0）这类静默误判。
// 注意：count(*)::int 的 cast 必须写在 FILTER 子句【之后】（count(*) FILTER (WHERE ...)::int），
//       写在 FILTER 之前会触发 Postgres 「syntax error at or near FILTER」。
const STATS_SQL = `SELECT count(*)::int AS total,
          count(*) FILTER (WHERE revoked_at IS NULL)::int AS active,
          count(*) FILTER (WHERE revoked_at IS NOT NULL)::int AS revoked
     FROM crm.mcp_identity`;

const before = await query(STATS_SQL);
const b = before.rows[0];
console.log(`db=${db}  迁移前: total=${b.total}  active=${b.active}  revoked=${b.revoked}`);

if (!apply) {
  console.log(`[dry-run] 将软吊销 ${b.active} 行（revoked_at = now()）。执行请追加 --apply`);
  process.exit(0);
}

const stamp = new Date();
// 先取本次将被吊销的行 id（revoked_at IS NULL），供精确回滚：
// 库里本就已吊销的行不属于本次操作范围，回滚时不得连带复活。
const victim = await query(`SELECT id FROM crm.mcp_identity WHERE revoked_at IS NULL`);
const ids = victim.rows.map((x) => x.id);
const r = await queryWrite(
  `UPDATE crm.mcp_identity SET revoked_at = now() WHERE revoked_at IS NULL`
);
const after = await query(STATS_SQL);
const a = after.rows[0];
console.log(`[apply] 受影响行数=${r.rowCount}  时间戳=${stamp.toISOString()}`);
console.log(`[apply] 迁移后: total=${a.total}  active=${a.active}  revoked=${a.revoked}`);

// 三元组自检：总数不变（无物理删除）且 active 归零
const ok = a.total === b.total && a.active === 0;
// 精确回滚脚本落盘：只恢复本次吊销的行（库里本就已吊销的行不复活）
const { writeFileSync, mkdirSync } = await import('node:fs');
const { join } = await import('node:path');
const dir = join(process.cwd(), 'tmp');
try { mkdirSync(dir, { recursive: true }); } catch { /* 已存在 */ }
const rbFile = join(dir, `revoke-rollback-${stamp.toISOString().replace(/[:.]/g, '-')}.sql`);
writeFileSync(rbFile,
  `-- 精确回滚：仅恢复 ${stamp.toISOString()} 本次软吊销的 ${ids.length} 行（不改库里本就已吊销的行）\n` +
  `-- 生成者：scripts/revoke-legacy-mcp-tokens.mjs --apply  (db=${db})\n` +
  (ids.length
    ? `UPDATE crm.mcp_identity SET revoked_at = NULL WHERE id IN (\n` +
      ids.map((x) => `  '${x}'`).join(',\n') + `\n);\n`
    : `-- 本次无受影响行，无需回滚\n`),
  'utf8');

console.log(ok ? 'OK: 无物理删除且 active 归零' : 'FAIL: 总数变化或仍有 active 行');
console.log(`精确回滚脚本: ${rbFile}（仅本次 ${ids.length} 行，不复活库里本就已吊销的行）`);
process.exit(ok ? 0 : 1);
