// test/signal/signalWritePathParity.test.js — 两条写入路径必须逐字段一致（2026-09-17）
//
// 背景（真库取证 + 代码定位）：
//   crm.signal 有**两条写路径**写入同一个 signal_id（= alert_id）：
//     ① createAlertWithDb 的直写 INSERT（带 params.owner_id / params.dedup_key）
//     ② createAlert 的 persister sink → signalFromAlert → signalStore.create
//   ②是 fire-and-forget（Promise.resolve().then），实测**往往先落库**；
//   而它原先只能 `owner_id: payload?.owner_id`、`dedup_key: 有粒子锚点才派生` → 两者皆 NULL。
//   于是同一行「谁先 INSERT 谁定内容」→ 落库行有无 owner 变成**随机**：
//   线上 1013 条 visit_shortfall 全无主，但 timers 明明传了 owner_id —— 这就是"部分假绿"。
//
// 本文件的守卫直指该失效形态：**同一份入参，两条路径产出的 owner_id / dedup_key 必须相等**。
// 只改一条路径（本次修复前的形态）会让本文件立刻变红。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createAlert, createAlertWithDb, resetAlertStore, setAlertPersister } from '../../src/alerts/alertStore.js';
import { createSignalRouter } from '../../src/signal/router.js';

const router = createSignalRouter({});

// 记录 persister 路径实际传给 signalStore.create 的字段
let captured = [];
function registerCapture() {
  captured = [];
  setAlertPersister(async (alert) => {
    const s = router.signalFromAlert(alert);
    captured.push(s);
    return { ok: true, alert: s };
  });
}

// 极简 pool 替身：只需 query 能回答「查不到既有行」并吞掉 INSERT
const fakePool = {
  query: async (sql) => {
    if (/SELECT signal_id/i.test(sql)) return { rows: [] };
    return { rows: [{ signal_id: 'x' }] };
  },
};

beforeEach(() => { resetAlertStore(); registerCapture(); });
afterEach(() => setAlertPersister(null));

describe('两条写路径的一致性（owner_id / dedup_key）', () => {
  it('聚合类（无粒子锚点）：persister 路径必须带出与直写路径相同的 owner_id 与 dedup_key', async () => {
    await createAlertWithDb(fakePool, {
      kind: 'visit_shortfall', severity: 'medium', target_role: 'sales',
      tenant_id: 't1', particle_id: null, payload: { dailyVisits: 0, dailyTarget: 3, scope: 'owner' },
      owner_id: 'alice',
      dedup_key: 'visit_shortfall:owner:alice:daily',
    });
    // persister 是 fire-and-forget，让微任务队列跑完
    await new Promise(r => setTimeout(r, 0));

    expect(captured).toHaveLength(1); // 守卫自检：确认真扫到了 persister
    const s = captured[0];
    expect(s.owner_id).toBe('alice');                                    // 修复前为 null
    expect(s.dedup_key).toBe('visit_shortfall:owner:alice:daily');       // 修复前为 null
    expect(s.target_role).toBe('sales');
  });

  it('粒子级：两条路径派生出同一个 dedup_key（不得一条带键、一条无键）', async () => {
    await createAlertWithDb(fakePool, {
      kind: 'deal_stuck', severity: 'high', target_role: 'sales',
      tenant_id: 't1', particle_id: 'd-42', payload: { stuckDays: 9 },
      owner_id: 'bob',
    });
    await new Promise(r => setTimeout(r, 0));
    expect(captured[0].dedup_key).toBe('deal_stuck:d-42:hour');
    expect(captured[0].owner_id).toBe('bob');
  });

  it('团队级：owner_id 保持 NULL（无主是语义，不是漏传）', async () => {
    await createAlertWithDb(fakePool, {
      kind: 'visit_shortfall', severity: 'medium', target_role: 'manager',
      tenant_id: 't1', payload: { weeklyVisits: 0, weeklyTarget: 15, scope: 'team' },
      owner_id: null,
      dedup_key: 'visit_shortfall:team:weekly',
    });
    await new Promise(r => setTimeout(r, 0));
    expect(captured[0].owner_id).toBeNull();
    expect(captured[0].target_role).toBe('manager');
    expect(captured[0].dedup_key).toBe('visit_shortfall:team:weekly');
  });

  it('内存告警对象保留 owner_id / dedup_key（下游透传的唯一来源）', () => {
    const { alert } = createAlert({
      kind: 'visit_shortfall', severity: 'medium', target_role: 'sales', tenant_id: 't1',
      owner_id: 'alice', dedup_key: 'visit_shortfall:owner:alice:daily',
    });
    expect(alert.owner_id).toBe('alice');
    expect(alert.dedup_key).toBe('visit_shortfall:owner:alice:daily');
  });

  it('payload 回退仍兼容（历史调用点只把 owner 放在 payload 里）', () => {
    const s = router.signalFromAlert({
      alert_id: 'a1', kind: 'coverage_gap', severity: 'medium', target_role: 'sales',
      tenant_id: 't1', payload: { owner_id: 'carol', daysSinceVisit: 40 },
    });
    expect(s.owner_id).toBe('carol');
  });
});
