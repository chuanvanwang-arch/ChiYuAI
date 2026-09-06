// src/db.js — 连接池（crm schema）
// 环境适配：现有 PG16@5433，agent2b 用户，plm 库内 crm schema（与 PDM 隔离）
// ⚠ 2026-09-04 修复：默认 host 改 `localhost`（PG 仅监听 IPv6 ::1，127.0.0.1 握手超时；
//   localhost 主机名解析优先 ::1，IPv6-only 环境必用）。生产 env 显式 PGHOST 不受影响。
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const SCHEMA = process.env.PGSCHEMA || 'crm';

// 读写双池（企业级容量：读 50 / 写 10，env 可调）——2026-08-28 企业级容量设计
// 读池 poolRead：只读查询主力（默认 50，2000 销售在线基线）；写池 pool：写入 + 事务（并发写有上限防击穿）
export const pool = new pg.Pool({
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || 5433),
  user: process.env.PGUSER || 'agent2b',
  password: process.env.PGPASSWORD || 'agent2b',
  database: process.env.PGDATABASE || 'crm_native',
  max: Number(process.env.PGPOOL_MAX_WRITE || 10),
  options: `-c search_path=${SCHEMA},public`,
  connectionTimeoutMillis: 5000,
});

export const poolRead = new pg.Pool({
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || 5433),
  user: process.env.PGUSER || 'agent2b',
  password: process.env.PGPASSWORD || 'agent2b',
  database: process.env.PGDATABASE || 'crm_native',
  max: Number(process.env.PGPOOL_MAX_READ || 50),
  options: `-c search_path=${SCHEMA},public`,
  connectionTimeoutMillis: 5000,
});

// ============ 防崩溃护栏（2026-09-05）============
// PG 服务端致命错误（如 57P01 admin_shutdown / 57P03 cannot connect now /
// ECONNRESET 等瞬态断连）会触发池级 'error' 事件；若不监听，node-postgres
// 会把错误冒为 unhandled 'error' 事件 → 进程直接退出（真实事故：PG 被外部
// 重启/维护时整个 Node 服务随之崩溃）。池收到致命错误会自动剔除坏连接、
// 后续请求改用新连接，进程无需退出；读路径另有瞬态重试兜底，写路径不自动
// 重试（避免客户端未收到提交确认时重复写入）。
function handlePoolError(err) {
  const code = (err && err.code) || 'NOCODE';
  const msg = (err && err.message) || String(err);
  console.error(`[db] pool error ${code}: ${msg}`);
}
pool.on('error', handlePoolError);
poolRead.on('error', handlePoolError);

// 瞬态错误码（服务端主动断连 / 网络抖动 / 池重建窗口）：读查询可安全重试一次
const POOL_RETRYABLE = new Set(['57P01', '57P03', 'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'PROTOCOL_CONNECTION_LOST_EXCEPTION']);

async function queryWithRetry(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err && POOL_RETRYABLE.has(err.code)) {
      console.warn(`[db] 瞬态错误 ${err.code}，读查询重试一次`);
      await new Promise((r) => setTimeout(r, 100));
      return await fn();
    }
    throw err;
  }
}

// 【安全护栏·默认库告警】本文件默认库 = **生产库 crm_native**（见上面两个 Pool 的 `database` 兜底）。
// 风险：任何「未显式设置 PGDATABASE」的进程（裸 `node scripts/*.mjs`、忘记配 env 的服务、
//   ESM 静态 import 导致脚本内 env 兜底失效等）都会**静默连上生产库**。
//   实例（2026-09-02 事故前兆）：测试前置脚本 seed-test-config.mjs 因此把 DELETE 执行到生产库
//   （核查 crm_native.meta_attr 为 0 行 → 实际删 0 行，零影响；已在该脚本内加动态 import + 生产库护栏）。
// 对策：此处做全局兜底告警（一次性，模块加载时触发）。测试环境由 vitest.config.js 显式指定
//   PGDATABASE=crm_native_test，不会触发本告警；生产服务未设 env 时会看到提示，可据此判断是否漏配。
if (!process.env.PGDATABASE) {
  console.warn(
    '[db.js] ⚠ 未设置 PGDATABASE —— 默认连接【生产库 crm_native】。\n' +
    '        测试/演示请显式指定 PGDATABASE=crm_native_test（vitest 已内置设置，仅裸跑脚本需注意）。'
  );
}

export async function queryWrite(text, params = []) {
  const r = await pool.query(text, params);
  return r;
}

export async function queryRead(text, params = []) {
  return queryWithRetry(() => poolRead.query(text, params));
}

// query() 保留=读池（兼容既有只读调用；写调用迁移到 queryWrite）
export async function query(text, params = []) {
  return queryWithRetry(() => poolRead.query(text, params));
}

export async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}