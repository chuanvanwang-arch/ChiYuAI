// src/signal/store.js — 信号统一收口（crm.signal 持久化，替换内存 Map）
// 设计输入：docs/2026-09-15-final-design-coexistence-and-proactive.md §8.3（信号统一收口）
// 工厂注入：对齐项目 db.js 风格（测试注入替身 pool，生产用真实 pool）
// 状态机：open ──ack──> acked ──close──> closed；open/acked ──act──> acted；closed 不再流转
import { randomUUID } from 'node:crypto';

export function createSignalStore(pool) {
  // create：必填校验 + dedup 幂等（同 dedup_key 未关闭复用既有）
  //   signal_id：可显式传入（告警链路传 alert_id 保溯源性；缺省 randomUUID）
  //   PK 幂等：ON CONFLICT (signal_id) DO NOTHING + 回查 —— 同一告警经多条落库路径
  //   （createAlert persister / createAlertWithDb）只落一行，且第二次不报错
  async function create({ signal_id: signalIdIn = null, tenant_id = 'system', source, kind, severity, target_role, owner_id = null, l2c_stage = null, particle_id = null, payload = {}, evidence = {}, suggestion = {}, dedup_key = null } = {}) {
    if (!source || !kind || !severity || !target_role) {
      return { ok: false, error: 'required_fields_missing' };
    }
    if (dedup_key) {
      const dup = await findOpenByDedup(tenant_id, dedup_key);
      if (dup) return { ok: true, alert: dup, deduped: true };
    }
    const signal_id = signalIdIn || randomUUID();
    let rows;
    try {
      ({ rows } = await pool.query(
        `INSERT INTO crm.signal
          (signal_id, tenant_id, source, kind, severity, target_role, owner_id, l2c_stage, particle_id, payload, evidence, suggestion, dedup_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (signal_id) DO NOTHING
         RETURNING *`,
        [signal_id, tenant_id, source, kind, severity, target_role, owner_id, l2c_stage, particle_id, JSON.stringify(payload), JSON.stringify(evidence), JSON.stringify(suggestion), dedup_key],
      ));
    } catch (e) {
      // 并发竞态：另一请求抢先插入了同 (tenant_id, dedup_key) 的未关闭信号 → idx_signal_dedup 唯一冲突。
      //   这不是故障，而是「去重生效」——回查既有行幂等返回，绝不把异常抛给告警主流程。
      //   注：idx_signal_dedup 的谓词与上面 findOpenByDedup 逐字一致（见 db/migration-signal-dedup-index.sql）。
      if (e?.code === '23505' && dedup_key) {
        const dup = await findOpenByDedup(tenant_id, dedup_key);
        if (dup) return { ok: true, alert: dup, deduped: true };
      }
      throw e;
    }
    if (rows[0]) return { ok: true, alert: rows[0], deduped: false };
    // 冲突（同 signal_id 已落库）→ 回查既有行，幂等复用而非报错（防假绿：不静默丢弃，返回真实行）
    const { rows: exist } = await pool.query(`SELECT * FROM crm.signal WHERE signal_id=$1`, [signal_id]);
    return { ok: true, alert: exist[0] || null, deduped: true };
  }

  // 查同 dedup_key 的**未关闭**信号（open/acked）。
  //   ⚠ 谓词必须与 idx_signal_dedup 的部分索引条件逐字一致，否则出现
  //   「查询漏过已关闭行、INSERT 撞索引」的抛异常（2026-09-16 实测缺陷，已由迁移修正索引）。
  async function findOpenByDedup(tenant_id, dedup_key) {
    const { rows } = await pool.query(
      `SELECT * FROM crm.signal WHERE tenant_id=$1 AND dedup_key=$2 AND status IN ('open','acked') LIMIT 1`,
      [tenant_id, dedup_key],
    );
    return rows[0] || null;
  }

  // list：tenant_id='*' 为平台管理员全量视界（读作用域通配，对齐 tenantScope.scopeTenant
  //   与 routes.js 既有 `$2='*'` 先例）；缺省/普通值按租户精确过滤。
  async function list({ tenant_id = 'system', status, kind, severity = null } = {}) {
    const conds = [];
    const params = [];
    let i = 1;
    if (tenant_id !== '*') { conds.push(`tenant_id=$${i++}`); params.push(tenant_id); }
    if (status) { conds.push(`status=$${i++}`); params.push(status); }
    if (kind) { conds.push(`kind=$${i++}`); params.push(kind); }
    if (severity) { conds.push(`severity=$${i++}`); params.push(severity); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const { rows } = await pool.query(
      `SELECT * FROM crm.signal ${where} ORDER BY created_at DESC`,
      params,
    );
    return rows;
  }

  // setStatus：open/acked/closed/acted 状态机（acked_at/closed_at/acted_at 时间戳 COALESCE 幂等）
  async function setStatus(tenant_id, signal_id, status, extra = {}) {
    const col = status === 'acked' ? 'acked_at' : status === 'closed' ? 'closed_at' : status === 'acted' ? 'acted_at' : null;
    const { rows } = await pool.query(
      `UPDATE crm.signal SET status=$3, ${col} = COALESCE(${col}, now()) WHERE tenant_id=$1 AND signal_id=$2 RETURNING *`,
      [tenant_id, signal_id, status],
    );
    if (rows.length === 0) return { ok: false, error: 'signal_not_found' };
    return { ok: true, alert: rows[0] };
  }

  async function stats({ tenant_id = 'system' } = {}) {
    const { rows } = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status='open') AS open_count,
         COUNT(*) FILTER (WHERE status='acked') AS acked_count,
         COUNT(*) FILTER (WHERE status='closed') AS closed_count,
         COUNT(*) FILTER (WHERE status='acted') AS acted_count,
         COUNT(DISTINCT source) AS source_count
       FROM crm.signal WHERE tenant_id=$1`,
      [tenant_id],
    );
    return rows[0];
  }

  return { create, list, setStatus, stats, findOpenByDedup };
}
