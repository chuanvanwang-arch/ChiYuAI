// src/sync/pendingWrite.js — P0-2（ROX 立身之本·待写队列 + 快照对账）
// 设计输入：docs/2026-09-18-integration-unified-merged.md §13 P0-2 + §5.3
//
// 问题：engine.js 回写失败曾仅 `conflicted++`，意图消失（G2/P5）。
// 解决：写失败入队 crm.sync_pending_write；drain 重试 + 快照比对（禁用 wall clock）对账。
//
// 反假绿纪律（§5.3 / §9）：
//   ① 对账判据 = applied + skipped_stale + failed + pending（剩余）== 入队总数。判「队列空」不能只数 applied。
//   ② 禁用 wall clock 判胜负：一律用 baseline_hash / 内容比对（ROX "exactly-once(ish) ... without clock synchronization"）。
//   ③ 失败不无限重试：attempts 超 max_attempts → failed（人工可见，非黑洞）。
//   ④ 待写队列不是乐观缓冲掩盖失败：pending 状态必须真实可见，不得与「已成功」混报。
import { createHash } from 'node:crypto';

export function createPendingWriteStore({ pool, query: injectedQuery } = {}) {
  // 解析查询函数：显式注入 > pool.query（生产传 pool）> 运行时回退到全局 db.js（生产兜底）。
  // 单测传 fakePool 时走 pool.query，避免误连真实 Postgres（反假绿：测试不许假绿）。
  const baseQuery = injectedQuery || (pool && typeof pool.query === 'function' ? pool.query.bind(pool) : null);
  async function q(sql, params) {
    if (baseQuery) return baseQuery(sql, params);
    const { query } = await import('../db.js');
    return query(sql, params);
  }
  function hash(o) {
    return createHash('sha256').update(JSON.stringify(o || {})).digest('hex');
  }

  // 幂等建表（DB 变更纪律：只增不删）。生产侧由 migrate.js 执行 schema.sql 自动建；此处为运行期兜底 + 单测隔离。
  async function ensureTable() {
    await q(
      `CREATE TABLE IF NOT EXISTS crm.sync_pending_write (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id       TEXT NOT NULL DEFAULT 'system',
        provider        TEXT NOT NULL,
        external_object TEXT NOT NULL,
        external_id     TEXT NOT NULL,
        particle_id     UUID,
        target          TEXT NOT NULL DEFAULT 'internal',
        args            JSONB NOT NULL,                 -- 重放 callWriteback 所需的完整参数（含 row）
        baseline_hash   TEXT,                           -- 写前快照哈希（对账基准，禁用 wall clock）
        status          TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','applied','skipped_stale','failed')),
        attempts        INT NOT NULL DEFAULT 0,
        max_attempts    INT NOT NULL DEFAULT 5,
        last_error      TEXT,
        applied_at      TIMESTAMPTZ,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
    );
  }

  // 入队一条失败写（意图不丢）。fields 用于 baseline_hash（写前快照）。
  async function enqueue({ tenantId = 'system', provider, object, externalId, particleId, target = 'internal', fields = {}, args = {} } = {}) {
    await q(
      `INSERT INTO crm.sync_pending_write (tenant_id, provider, external_object, external_id, particle_id, target, args, baseline_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [tenantId, provider, object, externalId, particleId, target, JSON.stringify(args), hash(fields)],
    );
  }

  // 对账 drain：取 pending 行，逐条重放 callWriteback。
  //   ok            → applied
  //   stale/外部已改 → skipped_stale（baseline 比对判为「当时写也会被后改覆盖」，跳过）
  //   其它失败      → attempts++；超 max → failed，否则保留 pending（下轮重试）
  async function drain({ callWriteback, emit, maxAttempts = 5 } = {}) {
    const { rows } = await q(
      `SELECT * FROM crm.sync_pending_write WHERE status='pending' ORDER BY created_at ASC LIMIT 200`,
    );
    const summary = { applied: 0, skipped_stale: 0, failed: 0, pending: 0, total: rows.length };
    for (const row of rows) {
      const args = row.args && typeof row.args === 'object' ? row.args : {};
      let res = { ok: false, error: 'no_callWriteback' };
      try {
        res = callWriteback ? await callWriteback(args) : { ok: false, error: 'no_callWriteback' };
      } catch (e) {
        res = { ok: false, error: String(e?.message || e) };
      }
      const isStale = res?.stale === true || res?.error === 'cas_conflict' || res?.error === 'external_changed';
      if (res?.ok) {
        await q(`UPDATE crm.sync_pending_write SET status='applied', applied_at=now(), updated_at=now() WHERE id=$1`, [row.id]);
        summary.applied++;
      } else if (isStale) {
        await q(`UPDATE crm.sync_pending_write SET status='skipped_stale', last_error=$2, updated_at=now() WHERE id=$1`, [row.id, res?.error || 'stale']);
        summary.skipped_stale++;
      } else {
        const attempts = (row.attempts || 0) + 1;
        const cap = row.max_attempts || maxAttempts;
        if (attempts >= cap) {
          await q(`UPDATE crm.sync_pending_write SET status='failed', attempts=$2, last_error=$3, updated_at=now() WHERE id=$1`, [row.id, attempts, res?.error || 'unknown']);
          summary.failed++;
        } else {
          await q(`UPDATE crm.sync_pending_write SET attempts=$2, last_error=$3, updated_at=now() WHERE id=$1`, [row.id, attempts, res?.error || 'unknown']);
          summary.pending++;
        }
      }
    }
    if (emit) emit('trace', 'sync-pending-drain', summary);
    return summary;
  }

  // 状态计数（对账判据：四态之和 == 入队总数）。
  async function count() {
    const { rows } = await q(`SELECT status, COUNT(*)::int AS n FROM crm.sync_pending_write GROUP BY status`);
    const out = { pending: 0, applied: 0, skipped_stale: 0, failed: 0 };
    for (const r of rows) out[r.status] = r.n;
    return out;
  }

  return { ensureTable, enqueue, drain, count };
}
