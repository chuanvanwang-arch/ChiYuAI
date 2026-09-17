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
  //
  // ownerScope（T21 个人隔离，2026-09-16，用户指令「除管理外，需要进行个人隔离！」）：
  //   传 { username, role } → 追加「我负责的 或 无主同角色广播」谓词；传 null/缺省 → 不追加（管理全量视界）。
  //   语义：owner_id = 责任人；无主（NULL）信号是「待认领/广播」，其可见面由 target_role 承担
  //   （公海 s0_stale 本就该人人可见，屏蔽反而是信息丢失）。
  //   ⚠ 服务端强制：对普通用户，调用方（HTTP / 工作台视角）必须传 ownerScope——
  //     不信任任何请求参数（`?mine=0` 之类的伪造不能放宽收窄）。
  //   判断用 `typeof username === 'string'`（类型闸）而非真值判断：username 为空串时仍追加谓词
  //   （`owner_id='' AND target_role=$role`）→ 匹配不到任何行 = **fail-closed**；若用真值判断，
  //   空串会被当成"未传"从而退化为全量视界——这正是最危险的假绿方向。
  async function list({ tenant_id = 'system', status, kind, severity = null, ownerScope = null } = {}) {
    const conds = [];
    const params = [];
    let i = 1;
    if (tenant_id !== '*') { conds.push(`tenant_id=$${i++}`); params.push(tenant_id); }
    if (status) { conds.push(`status=$${i++}`); params.push(status); }
    if (kind) { conds.push(`kind=$${i++}`); params.push(kind); }
    if (severity) { conds.push(`severity=$${i++}`); params.push(severity); }
    if (ownerScope && typeof ownerScope.username === 'string') {
      conds.push(`(owner_id=$${i++} OR (owner_id IS NULL AND target_role=$${i++}))`);
      params.push(ownerScope.username, ownerScope.role ?? null);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const { rows } = await pool.query(
      `SELECT * FROM crm.signal ${where} ORDER BY created_at DESC`,
      params,
    );
    return rows;
  }

  // setStatus：open/acked/closed/acted 状态机（acked_at/closed_at/acted_at 时间戳 COALESCE 幂等）
  //
  // 处置血缘落库（2026-09-16 补，对齐设计 §8.3）：
  //   白名单 EXTRA_COLUMNS 与 crm.signal 的列一一对应，未列入的键**有意不落库**（设计无该列），
  //   但会在返回值里以 `ignored_extra` 回显——不静默吞掉（对齐「不静默失败」铁律）。
  //   别名映射：关闭路径历来传的是 { reason }，落到 closed_reason 列。
  //   ⚠ 本函数此前完全忽略 extra 形参，导致三处生产调用点静默丢字段：
  //     adoption.js:11 {action_ref, decision_id}、adoption.js:23 {rejected_by, reason}、routes.js:390 {reason}。
  const EXTRA_COLUMNS = ['decision_id', 'action_ref', 'closed_reason'];
  const EXTRA_ALIAS = { reason: 'closed_reason' };
  async function setStatus(tenant_id, signal_id, status, extra = {}) {
    const col = status === 'acked' ? 'acked_at' : status === 'closed' ? 'closed_at' : status === 'acted' ? 'acted_at' : null;
    const sets = ['status=$3'];
    const params = [tenant_id, signal_id, status];
    // 归一化：显式列名优先，其次别名（reason → closed_reason）
    const normalized = {};
    for (const [k, v] of Object.entries(extra || {})) {
      const target = EXTRA_COLUMNS.includes(k) ? k : EXTRA_ALIAS[k];
      if (target && v !== undefined && v !== null) normalized[target] = v;
    }
    for (const k of EXTRA_COLUMNS) {
      if (normalized[k] === undefined) continue;
      params.push(normalized[k]);
      sets.push(`${k} = $${params.length}`);
    }
    if (col) sets.push(`${col} = COALESCE(${col}, now())`);
    const { rows } = await pool.query(
      `UPDATE crm.signal SET ${sets.join(', ')} WHERE tenant_id=$1 AND signal_id=$2 RETURNING *`,
      params,
    );
    if (rows.length === 0) return { ok: false, error: 'signal_not_found' };
    const ignored = Object.keys(extra || {}).filter((k) => !EXTRA_COLUMNS.includes(k) && !EXTRA_ALIAS[k]);
    return ignored.length ? { ok: true, alert: rows[0], ignored_extra: ignored } : { ok: true, alert: rows[0] };
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

  // closeStaleAggregates：关闭同 (tenant_id, kind) 下**已不再命中**的聚合类信号。
  //
  // 为什么必须存在（2026-09-17，配套 salesDailyScan 个人化改造）：
  //   聚合类信号是「当前状态」快照。改用稳定 dedup_key（不含周期戳）后，同一指标只会有一条
  //   未关闭行——这是为了消灭原实现「每 30 分钟新增一行」的堆积（实测每小时 12–24 行同义信号）。
  //   代价是：一旦达标，本轮不再产出该 hit，那条旧行会永远停在 open 并继续向责任人展示
  //   「本周拜访 0 次」——用陈旧快照冒充现状。故必须由调度侧在每轮扫描后显式收口。
  //
  // 收窄范围（刻意的）：
  //   · 仅处理 `dedup_key IS NOT NULL` 的行——历史无键行（本次个人化之前的存量广播）不在此列，
  //     交由 db/migration-signal-team-scope.sql 显式修正，避免定时器产生批量副作用；
  //   · 仅处理 open/acked（已 closed/acted 的不再触碰，保留处置留痕）；
  //   · 零 DELETE —— 只改状态 + 关闭原因，行保留可审计。
  async function closeStaleAggregates({ tenant_id = 'system', kind, keep = [], reason = null } = {}) {
    if (!kind || !Array.isArray(keep)) return { ok: false, error: 'invalid_args' };
    const { rows } = await pool.query(
      `UPDATE crm.signal
          SET status='closed', closed_at=COALESCE(closed_at, now()), closed_reason=COALESCE(closed_reason, $4)
        WHERE tenant_id=$1 AND kind=$2 AND status IN ('open','acked')
          AND dedup_key IS NOT NULL
          AND NOT (dedup_key = ANY($3::text[]))
      RETURNING signal_id, dedup_key, owner_id`,
      [tenant_id, kind, keep, reason],
    );
    return { ok: true, closed: rows };
  }

  return { create, list, setStatus, stats, findOpenByDedup, closeStaleAggregates };
}
