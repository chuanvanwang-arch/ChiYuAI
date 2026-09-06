/**
 * 等待测试库转静（无并发写入者）后再放行。
 * 背景：并行会话与我方若同时跑 vitest，共用 crm_native_test 会互 TRUNCATE 产生伪失败。
 * 判据：连续 QUIET_ROUNDS 轮采样窗口内，6 张高频表计数指纹完全不变才认定空闲
 *       （单轮会误判——两个测试文件之间的间隙也可能静默 2.5 秒）。
 * 用法：node tmp/wait-for-idle.mjs [最大等待秒数]  退出码 0=已空闲 / 2=超时
 */
process.env.PGDATABASE = 'crm_native_test';
const MAX_WAIT = Number(process.argv[2] || 900);
const QUIET_ROUNDS = 2;
const WINDOW_MS = 2500;

const { pool } = await import('../src/db.js');
const TABLES = ['particles', 'decision', 'decision_event', 'edges', 'events', 'meta_attr'];

async function snap() {
  const parts = [];
  for (const t of TABLES) {
    try {
      const r = await pool.query(`SELECT count(*)::int AS n FROM crm.${t}`);
      parts.push(`${t}=${r.rows[0].n}`);
    } catch {
      parts.push(`${t}=n/a`);
    }
  }
  return parts.join(' ');
}

const t0 = Date.now();
let quiet = 0;
let last = '';
while ((Date.now() - t0) / 1000 < MAX_WAIT) {
  const a = await snap();
  await new Promise((r) => setTimeout(r, WINDOW_MS));
  const b = await snap();
  last = b;
  if (a === b) {
    quiet++;
    const el = Math.round((Date.now() - t0) / 1000);
    console.log(`[wait-for-idle] 静默轮 ${quiet}/${QUIET_ROUNDS}（已等 ${el}s） ${b}`);
    if (quiet >= QUIET_ROUNDS) {
      console.log(`[wait-for-idle] 测试库已空闲，放行（等待 ${el}s）`);
      await pool.end();
      process.exit(0);
    }
  } else {
    if (quiet > 0) console.log('[wait-for-idle] 又检测到写入，静默计数归零');
    quiet = 0;
  }
  await new Promise((r) => setTimeout(r, 3000));
}
console.error(`[wait-for-idle] 超时 ${MAX_WAIT}s 仍未空闲；最后快照：${last}`);
await pool.end();
process.exit(2);
