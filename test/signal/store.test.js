import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSignalStore } from '../../src/signal/store.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

// 连 crm_native_test 真库（项目测试惯例；TRUNCATE 隔离）
// ⚠ 共享库并发纪律：只清 crm.signal 表（本测试域），不动其他表
let pool;
beforeAll(async () => {
  pool = new pg.Pool({
    database: process.env.PGDATABASE || 'crm_native_test',
    host: 'localhost',
    port: 5433,
    user: 'agent2b',
    password: 'agent2b',
  });
  await pool.query('SET search_path TO crm,public');
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await pool.query('TRUNCATE crm.signal CASCADE');
});

describe('signal store（真库 crm_native_test）', () => {
  it('create 落 DB 并返回 signal（必填缺失拒绝）', async () => {
    const store = createSignalStore(pool);
    const bad = await store.create({ kind: 'deal_stuck' }); // 缺 source/severity/target_role
    expect(bad.ok).toBe(false);
    expect(bad.error).toBe('required_fields_missing');

    const good = await store.create({
      tenant_id: 't1', source: 'rule-scan', kind: 'deal_stuck', severity: 'high',
      target_role: 'sales', particle_id: 'd1', payload: { subject: 'x' }, dedup_key: 'deal_stuck:d1:hour',
    });
    expect(good.ok).toBe(true);
    expect(good.deduped).toBe(false);
    expect(good.alert.signal_id).toBeTruthy();
    expect(good.alert.status).toBe('open');
  });

  it('dedup 幂等：同 dedup_key 未关闭复用既有', async () => {
    const store = createSignalStore(pool);
    const first = await store.create({
      tenant_id: 't1', source: 'rule-scan', kind: 'deal_stuck', severity: 'high',
      target_role: 'sales', dedup_key: 'deal_stuck:d1:hour',
    });
    const second = await store.create({
      tenant_id: 't1', source: 'rule-scan', kind: 'deal_stuck', severity: 'high',
      target_role: 'sales', dedup_key: 'deal_stuck:d1:hour',
    });
    expect(second.ok).toBe(true);
    expect(second.deduped).toBe(true);
    expect(second.alert.signal_id).toBe(first.alert.signal_id);
  });

  it('list 按 tenant+状态+kind+严重度过滤', async () => {
    const store = createSignalStore(pool);
    await store.create({ tenant_id: 't1', source: 'rule-scan', kind: 'deal_stuck', severity: 'high', target_role: 'sales' });
    await store.create({ tenant_id: 't1', source: 'rule-scan', kind: 'lead_overdue', severity: 'low', target_role: 'ops' });
    const all = await store.list({ tenant_id: 't1' });
    expect(all.length).toBe(2);
    const high = await store.list({ tenant_id: 't1', severity: 'high' });
    expect(high.length).toBe(1);
    expect(high[0].kind).toBe('deal_stuck');
    const open = await store.list({ tenant_id: 't1', status: 'open' });
    expect(open.length).toBe(2);
  });

  it('setStatus 状态机：open→acked→closed（closed_at 落时间戳）', async () => {
    const store = createSignalStore(pool);
    const { alert } = await store.create({ tenant_id: 't1', source: 'rule-scan', kind: 'deal_stuck', severity: 'high', target_role: 'sales' });
    const a = await store.setStatus('t1', alert.signal_id, 'acked');
    expect(a.ok).toBe(true);
    expect(a.alert.status).toBe('acked');
    expect(a.alert.acked_at).toBeTruthy();
    const c = await store.setStatus('t1', alert.signal_id, 'closed');
    expect(c.ok).toBe(true);
    expect(c.alert.status).toBe('closed');
    expect(c.alert.closed_at).toBeTruthy();
    const miss = await store.setStatus('t1', 'nope', 'closed');
    expect(miss.ok).toBe(false);
    expect(miss.error).toBe('signal_not_found');
  });

  it('stats 聚合 open/acked/closed/acted 计数', async () => {
    const store = createSignalStore(pool);
    const { alert } = await store.create({ tenant_id: 't1', source: 'rule-scan', kind: 'deal_stuck', severity: 'high', target_role: 'sales' });
    await store.create({ tenant_id: 't1', source: 'event-trigger', kind: 'lead_overdue', severity: 'low', target_role: 'ops' });
    await store.setStatus('t1', alert.signal_id, 'acted');
    const s = await store.stats({ tenant_id: 't1' });
    expect(Number(s.open_count)).toBe(1);
    expect(Number(s.acted_count)).toBe(1);
    expect(Number(s.source_count)).toBe(2);
  });

  // ===== 2026-09-16 补：以下三条对应 S1 实测塌陷，缺一条即真断链 =====

  it('list tenant_id=\'*\' 为全量视界（admin 通配），普通值仍精确过滤', async () => {
    const store = createSignalStore(pool);
    await store.create({ tenant_id: 't1', source: 'rule-scan', kind: 'deal_stuck', severity: 'high', target_role: 'sales' });
    await store.create({ tenant_id: 't2', source: 'rule-scan', kind: 'deal_stuck', severity: 'high', target_role: 'sales' });
    // 鉴别力：若 '*' 被当字面量拼进 WHERE tenant_id='*'，下面第一断言会得 0 → 红
    const all = await store.list({ tenant_id: '*' });
    expect(all.length).toBe(2);
    expect([...new Set(all.map((r) => r.tenant_id))].sort()).toEqual(['t1', 't2']);
    const onlyT1 = await store.list({ tenant_id: 't1' });
    expect(onlyT1.length).toBe(1);
    expect(onlyT1[0].tenant_id).toBe('t1');
  });

  it('signal_id 可显式传入（告警链路沿用 alert_id 保溯源性）', async () => {
    const store = createSignalStore(pool);
    const r = await store.create({
      signal_id: 'alert-abc-123', tenant_id: 't1', source: 'rule-scan',
      kind: 'deal_stuck', severity: 'high', target_role: 'sales',
    });
    expect(r.ok).toBe(true);
    // 鉴别力：若 create 忽略入参恒用 randomUUID，此处得随机 uuid → 红（信号与原始告警失联）
    expect(r.alert.signal_id).toBe('alert-abc-123');
  });

  it('同 signal_id 二次落库幂等（PK 冲突回落既有行，不产生重复行）', async () => {
    const store = createSignalStore(pool);
    const first = await store.create({
      signal_id: 'alert-dup-1', tenant_id: 't1', source: 'rule-scan',
      kind: 'deal_stuck', severity: 'high', target_role: 'sales',
    });
    expect(first.ok).toBe(true);
    expect(first.deduped).toBe(false);
    // 模拟第二条落库路径（createAlert persister + createAlertWithDb 同时生效）再落同一告警
    const second = await store.create({
      signal_id: 'alert-dup-1', tenant_id: 't1', source: 'rule-scan',
      kind: 'deal_stuck', severity: 'high', target_role: 'sales',
    });
    expect(second.ok).toBe(true);         // 不抛错（原实现会 PK 冲突抛异常打断告警主流程）
    expect(second.deduped).toBe(true);
    expect(second.alert.signal_id).toBe('alert-dup-1');
    const rows = await store.list({ tenant_id: 't1' });
    expect(rows.length).toBe(1);          // 行数不增（不重复落库）
  });

  it('已关闭信号的 dedup_key 不再占位（闭环后同类告警可重新产生）', async () => {
    const store = createSignalStore(pool);
    const a = await store.create({
      signal_id: 'sig-1', tenant_id: 't1', source: 'rule-scan',
      kind: 'deal_stuck', severity: 'high', target_role: 'sales', dedup_key: 'deal_stuck:d9:hour',
    });
    expect(a.ok).toBe(true);
    await store.setStatus('t1', a.alert.signal_id, 'closed');
    // 鉴别力：若 idx_signal_dedup 是全状态唯一（2026-09-16 修正前的定义），
    //   此处 findOpenByDedup 漏过 closed 行 → INSERT 撞索引抛 23505 → 本测试红。
    //   这正是「告警处理完一次后，该对象该小时永远沉默」的真实缺陷。
    const b = await store.create({
      signal_id: 'sig-2', tenant_id: 't1', source: 'rule-scan',
      kind: 'deal_stuck', severity: 'high', target_role: 'sales', dedup_key: 'deal_stuck:d9:hour',
    });
    expect(b.ok).toBe(true);
    expect(b.deduped).toBe(false);
    expect(b.alert.signal_id).toBe('sig-2');
    const rows = await store.list({ tenant_id: 't1' });
    expect(rows.length).toBe(2); // 旧 closed 行 + 新 open 行
  });

  it('谓词一致性铁律：idx_signal_dedup 的索引谓词与 findOpenByDedup 查询谓词同源', async () => {
    // 本缺陷的根因就是"同一个去重语义写在 SQL 索引与 JS 查询两处、谓词不一致"。
    // 单看任何一处都正确，只有真库索引定义 × 源码谓词对账才能发现。
    const { rows } = await pool.query(
      `SELECT indexdef FROM pg_indexes WHERE schemaname='crm' AND indexname='idx_signal_dedup'`,
    );
    const def = rows[0]?.indexdef || '';
    expect(def).toContain('UNIQUE');
    expect(def).toContain('open');
    expect(def).toContain('acked');
    const src = readFileSync(join(ROOT, 'src/signal/store.js'), 'utf8');
    expect(src).toMatch(/status IN \('open','acked'\)/);
  });

  // ===== 2026-09-16 补：处置血缘三列（对应 design-merge-audit §6.1「DDL 漂移」）=====
  // 缺陷形态：setStatus 从不读 extra 形参 + 表无对应列 → 三处生产调用点静默丢字段。
  // 该缺陷对 test/signal/adoption.test.js **不可见**（那里注入的是假 store），
  // 因此防线必须落在真库 + 源码对账上，故下面既有真库断言也有静态守卫。

  it('setStatus 落处置血缘：acted 写 decision_id/action_ref，closed 写 closed_reason（含 reason 别名）', async () => {
    const store = createSignalStore(pool);
    const { alert } = await store.create({ tenant_id: 't1', source: 'agent-research', kind: 'suggestion_card', severity: 'medium', target_role: 'sales' });
    // 采纳路径（对齐 src/signal/adoption.js:11 的真实载荷）
    const acted = await store.setStatus('t1', alert.signal_id, 'acted', { action_ref: 'sync-writeback-fields', decision_id: 'd-abc-123' });
    expect(acted.ok).toBe(true);
    expect(acted.alert.status).toBe('acted');
    // 鉴别力：若 extra 仍被忽略 / 列不存在，以下两断言为 null → 红
    expect(acted.alert.decision_id).toBe('d-abc-123');
    expect(acted.alert.action_ref).toBe('sync-writeback-fields');
    expect(acted.alert.acted_at).toBeTruthy();

    // 关闭路径（对齐 src/http/routes.js:390 载荷 { reason }）
    const closed = await store.setStatus('t1', alert.signal_id, 'closed', { reason: '已与客户确认' });
    expect(closed.ok).toBe(true);
    expect(closed.alert.closed_reason).toBe('已与客户确认');

    // 落库持久化（不只在 RETURNING 里）——重查一次
    const again = await store.list({ tenant_id: 't1' });
    expect(again[0].decision_id).toBe('d-abc-123');
    expect(again[0].closed_reason).toBe('已与客户确认');
  });

  it('未识别的 extra 键不静默吞掉：以 ignored_extra 回显（不静默失败铁律）', async () => {
    const store = createSignalStore(pool);
    const { alert } = await store.create({ tenant_id: 't1', source: 'rule-scan', kind: 'deal_stuck', severity: 'high', target_role: 'sales' });
    // adoption.js:23 真实载荷含 rejected_by —— 设计 §8.3 无此列，应回显而非消失
    const r = await store.setStatus('t1', alert.signal_id, 'closed', { rejected_by: 'u1', reason: '不建议' });
    expect(r.ok).toBe(true);
    expect(r.alert.closed_reason).toBe('不建议');
    expect(r.ignored_extra).toEqual(['rejected_by']);
  });

  it('血缘列存在性守卫：三列必须在真库存在（迁移未执行即红）', async () => {
    // 反假绿：单看源码 setStatus 写列正确，若库里没这三列则整条 UPDATE 抛异常；
    // 而这条断言把"迁移已执行"变成可验证事实。
    const { rows } = await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema='crm' AND table_name='signal'
          AND column_name IN ('decision_id','action_ref','closed_reason')`,
    );
    expect(rows.map((r) => r.column_name).sort()).toEqual(['action_ref', 'closed_reason', 'decision_id']);
  });

  it('静态守卫：生产 setStatus 调用点传入的键 ⊆ 落库白名单∪别名（防再次静默丢字段）', () => {
    // 本缺陷的成因是"调用方传了、被调方没接"，两侧单看都对。
    // 故用源码对账：把三处生产调用点的载荷键枚举出来，逐个核对是否被 store 接受。
    const storeSrc = readFileSync(join(ROOT, 'src/signal/store.js'), 'utf8');
    const allowed = new Set(['decision_id', 'action_ref', 'closed_reason', 'reason']);
    const callers = [
      join(ROOT, 'src/signal/adoption.js'),
      join(ROOT, 'src/http/routes.js'),
    ];
    const found = [];
    for (const f of callers) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/setStatus\([^)]*?\{([^}]*)\}/gs)) {
        for (const kv of m[1].split(',')) {
          const k = kv.split(':')[0].trim();
          if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k)) found.push(k);
        }
      }
    }
    expect(found.length).toBeGreaterThan(0); // 守卫自身有效性：必须真扫到调用点载荷
    const unknown = found.filter((k) => !allowed.has(k));
    expect(unknown).toEqual([]);
    // 负向对照：白名单必须真的出现在 store 源码里（否则守卫恒真＝假绿）
    expect(storeSrc).toContain('EXTRA_COLUMNS');
    expect(storeSrc).toContain("'closed_reason'");
  });
});

// ===== 个人隔离（T21，2026-09-16）=====
// 用户指令：「除管理外，需要进行个人隔离！」
// 语义：owner_id = 责任人。非责任人看不到「有主」信号；「无主」信号按 target_role 广播。
describe('个人隔离：list 的 ownerScope 谓词（T21）', () => {
  const seed = (store) => Promise.all([
    store.create({ tenant_id: 't9', source: 'rule-scan', kind: 'visit_shortfall', severity: 'high', target_role: 'sales', owner_id: 'alice' }),
    store.create({ tenant_id: 't9', source: 'rule-scan', kind: 'visit_shortfall', severity: 'high', target_role: 'sales', owner_id: 'bob' }),
    store.create({ tenant_id: 't9', source: 'rule-scan', kind: 's0_stale', severity: 'medium', target_role: 'sales', owner_id: null }),
    store.create({ tenant_id: 't9', source: 'rule-scan', kind: 'forecast_breach', severity: 'high', target_role: 'manager', owner_id: null }),
    // 他租户同责任人：owner 匹配但租户不匹配 → 必须不可见（租户谓词仍是硬边界）
    store.create({ tenant_id: 't8', source: 'rule-scan', kind: 'visit_shortfall', severity: 'high', target_role: 'sales', owner_id: 'alice' }),
  ]);

  it('销售员只看「我的 + 无主同角色」——他人负责的信号不可见', async () => {
    const store = createSignalStore(pool);
    await seed(store);
    const rows = await store.list({ tenant_id: 't9', ownerScope: { username: 'alice', role: 'sales' } });
    // 鉴别力：无 ownerScope 时为 4 行（含 bob 的），实现前此断言必红
    expect(rows.length).toBe(2);
    expect(rows.some((r) => r.owner_id === 'bob')).toBe(false);
    expect(rows.map((r) => r.kind).sort()).toEqual(['s0_stale', 'visit_shortfall']);
    // 租户仍是硬边界：t8 的 alice 信号不得跨租户泄漏
    expect(rows.every((r) => r.tenant_id === 't9')).toBe(true);
  });

  it('无主信号的可见面由 target_role 决定（经理见经理的广播，不见销售的）', async () => {
    const store = createSignalStore(pool);
    await seed(store);
    const mgr = await store.list({ tenant_id: 't9', ownerScope: { username: 'carol', role: 'manager' } });
    expect(mgr.length).toBe(1);
    expect(mgr[0].kind).toBe('forecast_breach');
    // 负向对照：s0_stale（无主但 target_role=sales）对 manager 不可见
    expect(mgr.some((r) => r.kind === 's0_stale')).toBe(false);
  });

  it('ownerScope 缺省 = 管理/全量视界（不追加个人谓词）', async () => {
    const store = createSignalStore(pool);
    await seed(store);
    const all = await store.list({ tenant_id: 't9' });
    expect(all.length).toBe(4);
  });

  it('ownerScope 与 status/kind 筛选叠加（不互相覆盖）', async () => {
    const store = createSignalStore(pool);
    await seed(store);
    const openOnly = await store.list({ tenant_id: 't9', ownerScope: { username: 'alice', role: 'sales' }, status: 'open' });
    expect(openOnly.length).toBe(2);
    const bobKind = await store.list({ tenant_id: 't9', ownerScope: { username: 'alice', role: 'sales' }, kind: 's0_stale' });
    expect(bobKind.length).toBe(1);
  });
});
